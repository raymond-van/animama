import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { builtInTextureCollisions } from "./effect-check.mjs";

/**
 * `pnpm -s effects save <items.json>`: save reviewed effect sources as Local
 * Avatar, Particle or Scene Effects through that kind's creator, in a
 * headless browser, exactly as a person would: import the creator document,
 * choose its images (an Avatar Effect's art, a Particle Effect's textures, a
 * Scene Effect's private images), Save, then read the saved item back,
 * compare it with the source and reopen it.
 *
 * `items.json` lists `{ source, name?, description? }`. `source` is an effect
 * folder or descriptor (relative to the items file); its descriptor's
 * `content_type` picks the creator. `name` and `description` default to the
 * descriptor's. A Local effect of the same kind with the same name is
 * revised (its item is opened and the document imported into it); otherwise
 * a new one is saved. It never equips anything.
 */

/**
 * How each kind's creator is driven: its routes and API, the Local folder it
 * saves to, and the accessible names of its name box, Import dialog and
 * confirmation, and the toast its Save shows.
 */
export const SAVE_CREATORS = {
  avatar: {
    route: "/avatar-effects",
    api: "/v1/avatar-effects",
    folder: "vfx/avatar",
    noun: "Avatar Effect",
    nameBox: "Avatar FX name",
    dialog: "Import Avatar Effect JSON",
    importButton: "Import document",
  },
  particle: {
    route: "/particle-effects",
    api: "/v1/particle-effects",
    folder: "vfx/particle",
    noun: "Particle Effect",
    nameBox: "Particle FX name",
    dialog: "Import Particle VFX JSON",
    importButton: "Import effect",
  },
  scene: {
    route: "/scene-effects",
    api: "/v1/scene-effects",
    folder: "vfx/scene",
    noun: "Scene Effect",
    nameBox: "Scene FX name",
    dialog: "Import Scene Effect JSON",
    importButton: "Import document",
  },
};

export class EffectSaveError extends Error {}

/**
 * The names Local content accepts, as the backend's `readable_entry_name`
 * (`content_save_service.py`): letters, digits, spaces, ".", "_" and "-",
 * starting with a letter or digit, at most 120 characters.
 */
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;

/**
 * The Local folder a name saves to (the backend's `readable_entry_name`), or
 * a thrown `EffectSaveError` naming the rule.
 */
export function localEntryName(name) {
  const trimmed = name.trim();
  const folder = ENTRY_NAME.test(trimmed)
    ? trimmed
        .replace(/[ _]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .toLowerCase()
    : "";
  if (!folder || folder === "." || folder === "..")
    throw new EffectSaveError(
      `"${name}" is not a valid Local name: use letters, digits, spaces, ".", "_" and "-", starting with a letter or digit (at most 120 characters).`,
    );
  return folder;
}

/** Parse and validate `items.json`; paths resolve from the items file. */
export function parseEffectSaveItems(value, itemsFile) {
  if (!Array.isArray(value) || value.length === 0)
    throw new EffectSaveError(
      `${itemsFile}: expected a non-empty array of items.`,
    );
  const names = new Set();
  return value.map((item, index) => {
    const where = `${itemsFile} item ${index + 1}`;
    if (typeof item?.source !== "string" || !item.source.trim())
      throw new EffectSaveError(
        `${where}: "source" must be a non-empty string.`,
      );
    for (const field of ["name", "description"])
      if (
        item[field] !== undefined &&
        (typeof item[field] !== "string" || !item[field].trim())
      )
        throw new EffectSaveError(
          `${where}: "${field}" must be a non-empty string.`,
        );
    const name = item.name?.trim();
    if (name && names.has(name))
      throw new EffectSaveError(`${where}: name "${name}" repeats.`);
    if (name) names.add(name);
    return {
      source: path.resolve(path.dirname(itemsFile), item.source),
      name,
      description: item.description?.trim(),
    };
  });
}

/** The SHA-256 of a file, as the creators and the API record it. */
async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/**
 * The creator's record of one image file. The Scene creator also takes SVG
 * (`{ svg: true }`).
 */
export async function editorImage(file, { svg = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  const contentType = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ...(svg ? { ".svg": "image/svg+xml" } : {}),
  }[ext];
  if (!contentType)
    throw new EffectSaveError(
      `${file}: the creator accepts PNG, JPEG${svg ? ", WebP or SVG" : " or WebP"} images.`,
    );
  return {
    logicalName: path.basename(file),
    originalName: path.basename(file),
    contentType,
    sizeBytes: (await stat(file)).size,
    sha256: await sha256(file),
  };
}

/**
 * Build the creator import document for an effect source and what the saved
 * item must hold. `editors` holds each creator's own document functions,
 * loaded through Vite so they are exactly what the creators run:
 *
 * - `avatar`: `createAvatarEffectDocumentFromDefinition`,
 *   `buildAvatarEffectEditorExport` and `avatarEffectDefinition`;
 * - `particle`: `createParticleVFXEditorDraftFromImport`,
 *   `buildParticleVFXCreatorDocument`, `missingParticleVFXTextureReferences`,
 *   `PARTICLE_VFX_EDITOR_TEXTURES` and `parseParticleVFXRuntimeConfig`;
 * - `scene`: `createSceneEffectDocumentFromDefinition`,
 *   `buildSceneEffectEditorExport`, `sceneEffectDefinition` and
 *   `canonicalSceneEffectImageName`.
 *
 * Returns `{ exportDocument, name, expected, chosen? }`:
 * `expected.definition` (an Avatar or Scene definition) or
 * `expected.settings` and `expected.quarks` (a Particle Effect), and
 * `expected.files`, each saved image or texture's logical path and digest.
 * For a Particle Effect, `chosen` lists the texture files the creator will
 * ask for after the import, as `{ fileName, file }`.
 */
export async function importDocumentFor(effect, item, editors) {
  const kind = effect.kind ?? "avatar";
  const name = item.name ?? effect.name;
  const description = item.description ?? effect.description;
  if (kind === "particle") {
    const { particle } = editors;
    const draft = particle.createParticleVFXEditorDraftFromImport(
      JSON.parse(await readFile(effect.manifestPath, "utf8")),
      {
        ...particle.parseParticleVFXRuntimeConfig(effect.defaults),
        label: name,
        description,
      },
    );
    const document = particle.buildParticleVFXCreatorDocument(draft);
    const carried = new Map(
      effect.texturePaths.map((file) => [
        path.relative(effect.folder, file).split(path.sep).join("/"),
        file,
      ]),
    );
    const collisions = await builtInTextureCollisions(
      effect,
      new Set(
        particle.PARTICLE_VFX_EDITOR_TEXTURES.map(
          (texture) => texture.relativeUrl,
        ),
      ),
    );
    if (collisions.length)
      throw new EffectSaveError(
        `${effect.descriptorPath}: ${collisions.join(", ")} ${collisions.length === 1 ? "is" : "are"} named like the creator's built-in textures, which it would save instead; rename ${collisions.length === 1 ? "it" : "them"} (and the image URLs).`,
      );
    // The creator saves only the textures the effect's images use, so a
    // listed texture nothing uses would be missing from the saved item.
    const used = new Set(
      (draft.quarksJson.images ?? []).map((image) => image?.url),
    );
    const unused = [...carried.keys()].filter(
      (reference) => !used.has(reference),
    );
    if (unused.length)
      throw new EffectSaveError(
        `${effect.descriptorPath}: lists ${unused.join(", ")}, which no image of the effect uses; remove it from the folder's files.`,
      );
    // The creator asks, by file name, for each texture that is not one of
    // its built-in textures; it draws built-in ones from its own copies.
    const chosen = [];
    for (const reference of particle.missingParticleVFXTextureReferences(
      draft,
    )) {
      if (!carried.has(reference))
        throw new EffectSaveError(
          `${effect.descriptorPath}: the effect draws ${reference}, which the folder does not list as a texture.`,
        );
      const fileName = path.posix.basename(reference);
      if (chosen.some((choice) => choice.fileName === fileName))
        throw new EffectSaveError(
          `${effect.descriptorPath}: two textures are named ${fileName}; the creator asks for each by file name.`,
        );
      chosen.push({ fileName, file: carried.get(reference) });
    }
    const files = {};
    for (const [reference, file] of carried)
      files[reference] = await sha256(file);
    return {
      exportDocument: document,
      name,
      chosen,
      expected: {
        settings: document.settings,
        quarks: document.quarks,
        files,
      },
    };
  }
  if (effect.definition.soundAlias)
    throw new EffectSaveError(
      `${effect.descriptorPath}: effects with a sound are saved by hand (choose the sound in the creator).`,
    );
  if (kind === "scene") {
    const { scene } = editors;
    const images = new Map();
    const files = {};
    for (const [logicalName, file] of Object.entries(effect.imagePaths)) {
      const image = await editorImage(file, { svg: true });
      // The creator names a chosen file after the file and its bytes; only a
      // file named as the definition names it fills that image.
      if (
        scene.canonicalSceneEffectImageName(logicalName, image.contentType) !==
        logicalName
      )
        throw new EffectSaveError(
          `${effect.descriptorPath}: rename the image ${logicalName} to ${scene.canonicalSceneEffectImageName(logicalName, image.contentType)} (in the definition too), as the creator names it.`,
        );
      images.set(logicalName, { ...image, logicalName });
      files[logicalName] = image.sha256;
    }
    const document = scene.createSceneEffectDocumentFromDefinition({
      name,
      description,
      definition: effect.definition,
      images,
      sound: null,
    });
    return {
      exportDocument: scene.buildSceneEffectEditorExport(document),
      name,
      expected: {
        definition: scene.sceneEffectDefinition(document),
        files,
      },
    };
  }
  const { avatar } = editors;
  const document = avatar.createAvatarEffectDocumentFromDefinition({
    name,
    description,
    definition: effect.definition,
    image: await editorImage(effect.imagePath),
    otherEyeImage: effect.otherImagePath
      ? await editorImage(effect.otherImagePath)
      : null,
    sound: null,
  });
  return {
    exportDocument: avatar.buildAvatarEffectEditorExport(document),
    name,
    expected: { definition: avatar.avatarEffectDefinition(document) },
  };
}

/** Drop `null` members recursively; the API projects unset fields as null. */
function withoutNulls(value) {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== null)
        .map(([key, child]) => [key, withoutNulls(child)]),
    );
  return value;
}

/**
 * Attachment fields the API fills with these defaults when the creator leaves
 * them out (`app/contracts/avatar_effect.py`); the creator's round trip
 * already drops default offsets, scales, rotations, mirror and mode.
 */
const API_ATTACHMENT_DEFAULTS = {
  body: { size: 0.2, facing: "camera" },
  sticker: { around: "head", size: 0.25 },
  silhouette: { fill: "pattern", patternScale: 1, scroll: { x: 0, y: 0 } },
};
const API_FLIPBOOK_DEFAULTS = { loop: "loop" };

/** The objects in a definition the API fills defaults into, with those defaults. */
function defaultedObjects(definition) {
  return [
    [
      definition.attachment,
      API_ATTACHMENT_DEFAULTS[definition.attachment?.kind] ?? {},
    ],
    [definition.art?.flipbook, API_FLIPBOOK_DEFAULTS],
  ];
}

/**
 * Remove from `side` each field that holds the API's default while `other`
 * leaves it out: the API filled it, so it is not a change. Both are prepared
 * copies, so they are changed in place.
 */
function dropFilledDefaults(side, other) {
  const others = defaultedObjects(other);
  defaultedObjects(side).forEach(([object, defaults], index) => {
    const [otherObject] = others[index];
    if (!object) return;
    for (const [key, value] of Object.entries(defaults))
      if (
        JSON.stringify(object[key]) === JSON.stringify(value) &&
        !(otherObject && key in otherObject)
      )
        delete object[key];
  });
}

/**
 * The first JSON path where a saved definition differs from the expected
 * one, or null when they match. Nulls are dropped (the API projects unset
 * fields as null), then both go through `normalize`, which should round-trip
 * a definition through the creator so defaults compare equal; a default the
 * API fills for a field the other side leaves out is not a difference. Image
 * names are left out (the creator may rename a file to keep the two images
 * distinct), but an other-eye image must be present on both sides or neither.
 */
export function definitionDifference(
  saved,
  expected,
  normalize = (value) => value,
) {
  const prepare = (definition) => {
    const normalized = withoutNulls(normalize(withoutNulls(definition)));
    const {
      image: _image,
      otherEyeImage: _other,
      ...art
    } = normalized.art ?? {};
    // Names may differ, but an other-eye image must not appear or vanish.
    return canonical({
      ...normalized,
      art: { ...art, otherEyeImage: Boolean(_other) },
    });
  };
  const [a, b] = [prepare(saved), prepare(expected)];
  dropFilledDefaults(a, b);
  dropFilledDefaults(b, a);
  return firstDifference(a, b, "definition");
}

/**
 * The first JSON path, below `at`, where `saved` differs from `expected`, or
 * null when they match.
 */
function firstDifference(saved, expected, at) {
  if (JSON.stringify(saved) === JSON.stringify(expected)) return null;
  if (
    saved &&
    expected &&
    typeof saved === "object" &&
    typeof expected === "object" &&
    !Array.isArray(saved)
  )
    for (const key of new Set([
      ...Object.keys(saved),
      ...Object.keys(expected),
    ])) {
      const found = firstDifference(saved[key], expected[key], `${at}.${key}`);
      if (found) return found;
    }
  return `${at} (saved ${JSON.stringify(saved)}, expected ${JSON.stringify(expected)})`;
}

/**
 * Where a saved value differs from the expected one, as `definitionDifference`
 * does without its Avatar Effect rules: nulls are dropped and both sides go
 * through `normalize` (the creator's own round trip) before comparing.
 */
export function savedDifference(saved, expected, normalize, at) {
  const prepare = (value) =>
    canonical(withoutNulls(normalize(withoutNulls(value))));
  return firstDifference(prepare(saved), prepare(expected), at);
}

/**
 * Where a saved item's files differ from the source's: `saved` is the API's
 * file list, `expected` each logical path and its digest, `role` the files'
 * role. Null when the same files hold the same bytes.
 */
export function savedFilesDifference(saved, expected, role) {
  const digests = new Map(
    (saved ?? [])
      .filter((file) => file.role === role)
      .map((file) => [file.logical_path, file.sha256]),
  );
  for (const [logicalPath, digest] of Object.entries(expected)) {
    if (!digests.has(logicalPath)) return `${role} ${logicalPath} is missing`;
    if (digests.get(logicalPath) !== digest)
      return `${role} ${logicalPath} holds other bytes than the source`;
  }
  const extra = [...digests.keys()].find(
    (logicalPath) => !(logicalPath in expected),
  );
  return extra ? `${role} ${extra} is not in the source` : null;
}

/** The Local item a save revises, or null for a new item. */
export function planEffectSave(name, libraryItems, noun = "Avatar Effect") {
  const local = libraryItems.filter(
    (entry) => entry.source === "local" && entry.name === name,
  );
  if (local.length > 1)
    throw new EffectSaveError(
      `several Local ${noun}s are named "${name}"; rename one in the Library first.`,
    );
  return local[0] ? { itemId: local[0].item_id } : null;
}

/** Key-sorted JSON, so saved and source definitions compare by content. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/**
 * Choose the source's images in the open creator after its document was
 * imported: an Avatar Effect's art inputs; each Particle texture the
 * creator reports missing (`job.chosen`; it asks per emitter, by file name,
 * in its Advanced mode);
 * each Scene image through the Tile layer's input, which fills a missing
 * image of the same name wherever the Scene shows it.
 */
async function chooseImages(page, { effect, chosen = [] }) {
  const kind = effect.kind ?? "avatar";
  if (kind === "avatar") {
    await page
      .getByLabel("Image", { exact: true })
      .setInputFiles(effect.imagePath);
    if (effect.otherImagePath)
      await page
        .getByLabel("Other side image (optional)", { exact: true })
        .setInputFiles(effect.otherImagePath);
    return;
  }
  if (kind === "particle") {
    // The creator opens in Simple; the texture inputs are in Advanced.
    await page
      .getByRole("tablist", { name: "Creator mode", exact: true })
      .getByRole("tab", { name: "Advanced", exact: true })
      .click();
    await page.getByRole("region", { name: "Emitters", exact: true }).waitFor();
    const files = new Map(chosen.map(({ fileName, file }) => [fileName, file]));
    const supplied = new Set();
    const emitters = page.getByRole("button", { name: /^Select emitter / });
    const missing = page.getByLabel(/^Choose file for /);
    for (let index = 0; index < (await emitters.count()); index += 1) {
      await emitters.nth(index).click();
      while (await missing.count()) {
        const label = await missing.first().getAttribute("aria-label");
        const fileName = label.slice("Choose file for ".length);
        if (!files.has(fileName))
          throw new Error(
            `the creator asks for texture ${fileName}, which the source does not carry`,
          );
        await missing.first().setInputFiles(files.get(fileName));
        supplied.add(fileName);
        await page
          .getByLabel(label, { exact: true })
          .waitFor({ state: "detached" });
      }
    }
    const unasked = [...files.keys()].filter((name) => !supplied.has(name));
    if (unasked.length)
      throw new Error(`the creator never asked for ${unasked.join(", ")}`);
    return;
  }
  const images = Object.values(effect.imagePaths);
  if (!images.length) return;
  await page
    .getByRole("button", { name: /^Tile / })
    .first()
    .click();
  const input = page.getByLabel(/^(Choose|Replace) tile image$/);
  for (const file of images) {
    await input.setInputFiles(file);
    // The creator disables Import while it checks and places an image.
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Import"]')?.disabled,
      null,
      { timeout: 60_000 },
    );
  }
}

/**
 * Read a saved item back through the API and compare it with the source:
 * the definition (Avatar, Scene) or the settings and Quarks effect
 * (Particle, its manifest fetched through a content preview as the creator
 * loads it), and the bytes of every image or texture. Returns the first
 * difference, or null.
 */
async function savedItemDifference(page, kind, itemId, expected, normalize) {
  const { api } = SAVE_CREATORS[kind];
  const saved = await page.evaluate(
    async ({ api, id, particle }) => {
      const item = await fetch(`${api}/${encodeURIComponent(id)}`);
      if (!item.ok) return null;
      const value = await item.json();
      if (!particle) return { value };
      const preview = await fetch(`${api}/${encodeURIComponent(id)}:preview`, {
        method: "POST",
      });
      if (!preview.ok) return { value, manifest: null };
      const {
        preview_id: previewId,
        revision_sha256: revision,
        files,
      } = await preview.json();
      const manifest = files.find((file) => file.role === "manifest");
      const file = manifest
        ? await fetch(
            `/v1/content/previews/${encodeURIComponent(previewId)}/revisions/${encodeURIComponent(revision)}/files/${encodeURIComponent(manifest.file_ref)}`,
          )
        : null;
      return { value, manifest: file?.ok ? await file.json() : null };
    },
    { api, id: itemId, particle: kind === "particle" },
  );
  if (!saved) return "the saved item could not be read";
  const { value } = saved;
  if (kind === "particle") {
    if (!saved.manifest) return "the saved Quarks manifest could not be read";
    return (
      savedDifference(
        value.runtime_defaults?.slots?.particle_vfx,
        expected.settings,
        normalize.particleSettings,
        "settings",
      ) ??
      savedDifference(
        saved.manifest,
        expected.quarks,
        normalize.particleQuarks,
        "quarks",
      ) ??
      savedFilesDifference(value.files, expected.files, "texture")
    );
  }
  if (!value.definition) return "the saved item has no readable definition";
  if (kind === "scene")
    return (
      savedDifference(
        value.definition,
        expected.definition,
        normalize.scene,
        "definition",
      ) ?? savedFilesDifference(value.files, expected.files, "image")
    );
  return definitionDifference(
    value.definition,
    expected.definition,
    normalize.avatar,
  );
}

/**
 * Save each `{ item, effect, exportDocument, name, expected, chosen? }`
 * (`importDocumentFor`'s result with its item and source) in order
 * through its kind's creator at `origin`. `normalize` holds each creator's
 * round trip (`avatar`, `particleSettings`, `particleQuarks`, `scene`), so
 * defaults compare equal. `onSaved({ name, url, revised })` runs after each
 * save is reopened, so a later failure does not hide earlier saves.
 */
export async function saveEffects(
  jobs,
  origin,
  { normalize, onSaved = () => {} },
) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(240_000);
    // "Replace the current unsaved document?" when importing over a draft.
    page.on("dialog", (dialog) => void dialog.accept());
    const libraries = new Map();
    try {
      await page.goto("/");
      for (const kind of new Set(
        jobs.map(({ effect }) => effect.kind ?? "avatar"),
      ))
        libraries.set(
          kind,
          await page.evaluate(async (api) => {
            const response = await fetch(api);
            if (!response.ok)
              throw new Error(`Library request ${response.status}`);
            return (await response.json()).items ?? [];
          }, SAVE_CREATORS[kind].api),
        );
    } catch (error) {
      throw new EffectSaveError(
        `could not reach the app at ${origin} (${error.message.split("\n")[0]}); start the stack and source its record.`,
      );
    }
    for (const job of jobs) {
      const { item, effect, exportDocument, name, expected } = job;
      const kind = effect.kind ?? "avatar";
      const creator = SAVE_CREATORS[kind];
      const nameBox = page.getByRole("textbox", {
        name: creator.nameBox,
        exact: true,
      });
      const nameIs = (expectedName) =>
        page.waitForFunction(
          ({ label, value }) =>
            document.querySelector(`[aria-label="${label}"]`)?.value === value,
          { label: creator.nameBox, value: expectedName },
          { timeout: 60_000 },
        );
      let step = "plan the save";
      try {
        const target = planEffectSave(name, libraries.get(kind), creator.noun);
        step = "open the creator";
        await page.goto(
          target
            ? `${creator.route}/${encodeURIComponent(target.itemId)}/edit`
            : `${creator.route}/new`,
        );
        await nameBox.waitFor();
        if (target) {
          step = "load the saved item";
          await nameIs(name);
        }
        step = "import the document";
        await page
          .getByRole("button", { name: "Import", exact: true })
          .first()
          .click();
        const dialog = page.getByRole("dialog", { name: creator.dialog });
        await dialog.getByRole("textbox").fill(JSON.stringify(exportDocument));
        await dialog
          .getByRole("button", { name: creator.importButton, exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
        await nameIs(name);
        step = "choose the images";
        await chooseImages(page, job);
        const save = page.getByRole("button", { name: "Save", exact: true });
        await save.waitFor();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Save"]')?.disabled,
          null,
          { timeout: 60_000 },
        );
        step = "save";
        const response = page.waitForResponse(
          (candidate) =>
            ["PUT", "POST", "PATCH"].includes(candidate.request().method()) &&
            candidate.url().includes(creator.api) &&
            !candidate.url().includes(":preview"),
          { timeout: 120_000 },
        );
        response.catch(() => {});
        await save.click();
        const result = await response;
        if (!result.ok())
          throw new Error(
            `the app refused the save (${result.status()}): ${(await result.text()).slice(0, 300)}`,
          );
        await page
          .getByText(`${creator.noun} saved.`, { exact: true })
          .first()
          .waitFor({ timeout: 60_000 });
        if (!target)
          await page.waitForURL(new RegExp(`${creator.route}/[^/]+/edit`), {
            timeout: 60_000,
          });
        step = "read the saved item back";
        const itemId =
          target?.itemId ??
          decodeURIComponent(
            new URL(page.url()).pathname.split("/").at(-2) ?? "",
          );
        const difference = await savedItemDifference(
          page,
          kind,
          itemId,
          expected,
          normalize,
        );
        if (difference)
          throw new Error(`the saved item differs at ${difference}`);
        step = "reopen the saved item";
        const url = page.url();
        await page.reload();
        await nameIs(name);
        onSaved({ name, url, revised: Boolean(target) });
      } catch (error) {
        throw new EffectSaveError(
          `${item.name ?? effect.stem}: could not ${step}: ${error.message.split("\n")[0]}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
