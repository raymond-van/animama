import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  PACK_SOUND_MANIFEST,
  includedActionDependencies,
  includedContentTypes,
  listIncludedMetas,
  packSoundRefs,
} from "./included-dependencies.mjs";

/**
 * Promote owner-approved animaPoseClip/2.0 Gestures to Included content.
 *
 *   pnpm -s animation promote <items.json> [--dry-run]
 *
 * Run only with the owner's explicit approval of each item and of its licence
 * entries, on a task branch that goes through a PR (see the animama-animation
 * skill's "Promote to Included" step). `items.json` reuses `animation:save`'s
 * items (`clip`, `name`, `aiDescription`, `selectorId`). `clip` is a file path (relative to the items file) or a
 * Library source such as `library:local/<selector>`, resolved like
 * `animation:preview` sources, so the saved Local item the owner reviewed is
 * what ships. Each item adds:
 *
 * - `mode`: `"add"` for a new Included Gesture, or `"replace"` to give an
 *   existing one new bytes. A replacement keeps the original's folder,
 *   content ID, Selector ID and dependencies, and by default its name and
 *   loop/one-shot kind;
 * - `slug` (optional): the Included folder and content ID suffix; defaults to
 *   the clip file name without `.clip.json` (a Library item's folder name);
 * - `dependencies` (optional, add only): the Included content the clip's
 *   events play, as Included metas store it (`{ ref, alias, content_type,
 *   config? }`). Every effect, scene and sound event must name a declared
 *   alias of its type, and every `ref` must already be Included (promote a
 *   new effect with `pnpm -s effects promote` first);
 * - `rename: true` (optional, replace only): the owner approved changing the
 *   display name to `name`; refused when the name does not change;
 * - `loopChange: true` (optional, replace only): the owner approved turning a
 *   loop into a one-shot or the reverse; refused when the kind does not
 *   change;
 * - `licence`: the `licenses/inventory.json` rule fields (`creator`,
 *   `provenance`, `license_id`, `redistribution_review`) for the item's files;
 * - `sourceReview`: the `licenses/source-review.json` record fields
 *   (`candidate_license`, `basis`, `copyright`, `review`).
 *
 * For each item it writes `content/included/gestures/<slug>/<slug>.json` and
 * `<slug>.meta.json` (the frontend's built-in catalog bundles these files
 * directly), a licence rule ahead of the generic `gestures/**\/*.json` rule,
 * and source-review records. `--dry-run` lists every file it would write,
 * with each name, kind and dependency change, and writes nothing. New files
 * must be `git add`ed before the backend Included-content tests, which read
 * tracked files only.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SELECTOR_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** The `licenses/inventory.json` rule fields an item's licence entry gives. */
export const LICENCE_FIELDS = [
  "creator",
  "provenance",
  "license_id",
  "redistribution_review",
];
/** The `licenses/source-review.json` record fields an item's entry gives. */
export const SOURCE_REVIEW_FIELDS = [
  "candidate_license",
  "basis",
  "copyright",
  "review",
];
const GENERIC_GESTURE_RULE = "gestures/**/*.json";
const ITEM_FIELDS = [
  "clip",
  "mode",
  "name",
  "aiDescription",
  "selectorId",
  "slug",
  "dependencies",
  "rename",
  "loopChange",
  "licence",
  "sourceReview",
];
/** Replace-only permissions, each naming the change the owner approved. */
const REPLACE_PERMISSIONS = ["rename", "loopChange"];

/** Repository paths the tool writes, relative to the repository root. */
export const PROMOTE_PATHS = {
  included: "content/included",
  inventory: "content/included/licenses/inventory.json",
  sourceReview: "licenses/source-review.json",
};

function requireText(value, where) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${where} must be a non-empty string.`);
  return value.trim();
}

function requireFields(value, fields, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where} must be an object with ${fields.join(", ")}.`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length)
    throw new Error(`${where} has unknown field(s): ${unknown.join(", ")}.`);
  return Object.fromEntries(
    fields.map((field) => [
      field,
      requireText(value[field], `${where}.${field}`),
    ]),
  );
}

/**
 * A promotion item as the tool uses it, or a thrown error naming the problem.
 * `resolveClip(spec, directory)` returns a clip source's absolute path; by
 * default a plain path relative to the items file.
 */
export async function parsePromoteItems(
  value,
  itemsFile,
  resolveClip = async (spec, directory) => path.resolve(directory, spec),
) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${itemsFile}: expected a non-empty array of items.`);
  const slugs = new Set();
  const selectorIds = new Set();
  const items = [];
  for (const [index, item] of value.entries()) {
    const where = `${itemsFile} item ${index + 1}`;
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error(`${where} must be an object.`);
    const unknown = Object.keys(item).filter(
      (key) => !ITEM_FIELDS.includes(key),
    );
    if (unknown.length)
      throw new Error(`${where} has unknown field(s): ${unknown.join(", ")}.`);
    const spec = requireText(item.clip, `${where}: "clip"`);
    let clip;
    try {
      clip = await resolveClip(spec, path.dirname(itemsFile));
    } catch (error) {
      throw new Error(`${where}: ${error.message}`);
    }
    if (item.mode !== "add" && item.mode !== "replace")
      throw new Error(`${where}: "mode" must be "add" or "replace".`);
    for (const permission of REPLACE_PERMISSIONS) {
      if (item[permission] === undefined) continue;
      if (typeof item[permission] !== "boolean")
        throw new Error(`${where}: "${permission}" must be true or false.`);
      if (item.mode !== "replace")
        throw new Error(
          `${where}: "${permission}" applies to a replace; an add sets its own name and kind.`,
        );
    }
    if (item.dependencies !== undefined) {
      if (item.mode !== "add")
        throw new Error(
          `${where}: a replace keeps the Included Gesture's dependencies; change them with \`pnpm -s effects promote\` (a "gesture" item).`,
        );
      if (!Array.isArray(item.dependencies))
        throw new Error(`${where}: "dependencies" must be an array.`);
    }
    const slug =
      item.slug === undefined
        ? path.basename(clip).replace(/\.clip\.json$|\.json$/, "")
        : requireText(item.slug, `${where}: "slug"`);
    if (!SLUG.test(slug))
      throw new Error(`${where}: slug "${slug}" must be lowercase kebab-case.`);
    const selectorId = requireText(item.selectorId, `${where}: "selectorId"`);
    if (!SELECTOR_ID.test(selectorId))
      throw new Error(`${where}: Selector ID "${selectorId}" is not valid.`);
    if (slugs.has(slug)) throw new Error(`${where}: slug "${slug}" repeats.`);
    if (selectorIds.has(selectorId))
      throw new Error(`${where}: Selector ID "${selectorId}" repeats.`);
    slugs.add(slug);
    selectorIds.add(selectorId);
    items.push({
      clip,
      slug,
      mode: item.mode,
      name: requireText(item.name, `${where}: "name"`),
      aiDescription: requireText(
        item.aiDescription,
        `${where}: "aiDescription"`,
      ),
      selectorId,
      dependencies: item.dependencies ?? [],
      rename: item.rename === true,
      loopChange: item.loopChange === true,
      licence: requireFields(
        item.licence,
        LICENCE_FIELDS,
        `${where}: "licence"`,
      ),
      sourceReview: requireFields(
        item.sourceReview,
        SOURCE_REVIEW_FIELDS,
        `${where}: "sourceReview"`,
      ),
    });
  }
  return items;
}

const jsonFile = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Plan every file write for the items without touching the disk.
 *
 * `repo` reads the current repository: `read(relativePath)` returns the text
 * or `null`, `gestureSlugs()` lists the Included Gesture folders and
 * `includedMetas()` every Included descriptor as `{ path, value }` (the
 * content a dependency may name).
 * `compactClip(value)` validates a clip and returns `{ ok, clip, saved }` or
 * `{ ok: false, message }` (the motion CLI's `compactClipFile`).
 * `formatJson(value)` formats the clip files (prettier's JSON style).
 * `maxClipBytes` is the largest clip file the app loads
 * (`MAX_ANIMA_POSE_CLIP_BYTES`).
 * Returns `[{ path, action: "create" | "update", content, notes? }]` in
 * write order; a meta's `notes` name its name, kind and dependency changes.
 */
export async function planPromotion(
  items,
  { repo, compactClip, formatJson, maxClipBytes },
) {
  const writes = new Map();
  const current = (relative) =>
    writes.has(relative) ? writes.get(relative) : repo.read(relative);
  const put = (relative, content) => writes.set(relative, content);
  const readJson = (relative) => {
    const text = current(relative);
    if (text === null) throw new Error(`${relative} is missing.`);
    return JSON.parse(text);
  };

  const includedTypes = includedContentTypes(await repo.includedMetas());
  const packManifest = current(PACK_SOUND_MANIFEST);
  const packSounds = packSoundRefs(
    packManifest === null ? null : JSON.parse(packManifest),
  );
  const includedMetas = new Map();
  for (const slug of await repo.gestureSlugs()) {
    const text = repo.read(
      `${PROMOTE_PATHS.included}/gestures/${slug}/${slug}.meta.json`,
    );
    if (text !== null) includedMetas.set(slug, JSON.parse(text));
  }

  // Chat descriptors and `library:<name>` sources name Gestures by display
  // name, so no two Included Gestures share one (case-insensitively) once
  // every item is applied; renames in one run may swap names.
  const finalNames = new Map(
    [...includedMetas].map(([slug, meta]) => [slug, meta.name]),
  );
  for (const item of items) finalNames.set(item.slug, item.name);
  const slugsByName = new Map();
  for (const [slug, name] of finalNames) {
    if (typeof name !== "string") continue;
    const key = name.toLowerCase();
    slugsByName.set(key, [...(slugsByName.get(key) ?? []), slug]);
  }

  const inventory = readJson(PROMOTE_PATHS.inventory);
  const sourceReview = readJson(PROMOTE_PATHS.sourceReview);
  // What the dry run shows beside a file: name, kind and dependency changes.
  const notes = new Map();
  const note = (relative, text) =>
    notes.set(relative, [...(notes.get(relative) ?? []), text]);
  const loopKind = (loop) => (loop ? "a loop" : "a one-shot");

  for (const item of items) {
    const folder = `${PROMOTE_PATHS.included}/gestures/${item.slug}`;
    const clipPath = `${folder}/${item.slug}.json`;
    const metaPath = `${folder}/${item.slug}.meta.json`;
    const original = includedMetas.get(item.slug);
    const holder = [...includedMetas].find(
      ([slug, meta]) =>
        meta.semantic_key === item.selectorId && slug !== item.slug,
    );
    if (holder)
      throw new Error(
        `${item.slug}: Selector ID "${item.selectorId}" belongs to Included Gesture "${holder[0]}".`,
      );
    const namesakes = slugsByName
      .get(item.name.toLowerCase())
      .filter((slug) => slug !== item.slug);
    if (namesakes.length)
      throw new Error(
        `${item.slug}: after this run the name "${item.name}" would also belong to Included Gesture "${namesakes.join('", "')}".`,
      );

    let source;
    try {
      source = JSON.parse(await readFile(item.clip, "utf8"));
    } catch (error) {
      throw new Error(`${item.clip}: ${error.message}`);
    }
    const compacted = compactClip({
      ...source,
      id: item.slug,
      name: item.name,
    });
    if (!compacted.ok) throw new Error(`${item.slug}: ${compacted.message}`);
    // Prettier's JSON style, as for the other Included clips; the size limit
    // applies to the file as written.
    const clipBytes = await formatJson(JSON.parse(compacted.saved));
    const size = Buffer.byteLength(clipBytes);
    if (size > maxClipBytes)
      throw new Error(
        `${item.slug}: the Included file would be ${size} bytes, over the ${maxClipBytes} the app loads.`,
      );

    let meta;
    if (item.mode === "replace") {
      if (!original)
        throw new Error(`${item.slug}: no Included Gesture to replace.`);
      if (original.semantic_key !== item.selectorId)
        throw new Error(
          `${item.slug}: the Included Gesture's Selector ID is "${original.semantic_key}"; a replacement keeps it.`,
        );
      if (original.name !== item.name) {
        if (!item.rename)
          throw new Error(
            `${item.slug}: the Included Gesture is named "${original.name}"; a replacement keeps its name unless the item sets "rename": true for a rename the owner approved.`,
          );
        note(metaPath, `name "${original.name}" → "${item.name}"`);
      } else if (item.rename)
        throw new Error(
          `${item.slug}: "rename": true, but the Included Gesture is already named "${item.name}"; remove "rename" or set the approved new name.`,
        );
      if (original.implementation?.kind !== "anima_clip")
        throw new Error(
          `${item.slug}: only anima_clip Gestures can be replaced.`,
        );
      const previous = readJson(clipPath);
      const wasLoop = Boolean(previous.loop);
      if (wasLoop !== Boolean(compacted.clip.loop)) {
        if (!item.loopChange)
          throw new Error(
            `${item.slug}: the replacement must stay ${loopKind(wasLoop)} unless the item sets "loopChange": true for a change the owner approved.`,
          );
        note(
          clipPath,
          `${loopKind(wasLoop)} → ${loopKind(compacted.clip.loop)}`,
        );
      } else if (item.loopChange)
        throw new Error(
          `${item.slug}: "loopChange": true, but the replacement stays ${loopKind(wasLoop)}; remove "loopChange" or promote the clip with the approved kind.`,
        );
      // The kept dependencies must still cover the new clip's events.
      checkDependencies(item.slug, original.dependencies, compacted.clip, {
        includedTypes,
        packSounds,
        missing:
          "re-point the Gesture's dependencies with `pnpm -s effects promote` first",
      });
      // The AI description is a Gesture's one text, so a replacement also
      // drops any legacy `description` copy of the old one.
      const { description: _legacyDescription, ...kept } = original;
      meta = { ...kept, name: item.name, ai_description: item.aiDescription };
    } else {
      if (original || current(clipPath) !== null)
        throw new Error(
          `${item.slug}: an Included Gesture already uses this slug; use mode "replace".`,
        );
      const dependencies = checkDependencies(
        item.slug,
        item.dependencies,
        compacted.clip,
        {
          includedTypes,
          packSounds,
          missing:
            "promote it first with `pnpm -s effects promote`, then this Gesture",
        },
      );
      for (const { alias, ref } of dependencies)
        note(metaPath, `depends on "${alias}" (${ref})`);
      meta = {
        schema_version: 1,
        content_type: "gesture",
        content_id: `builtin:gesture:${item.slug}`,
        version: 1,
        semantic_key: item.selectorId,
        name: item.name,
        ai_description: item.aiDescription,
        implementation: { kind: "anima_clip", file_role: "sequence" },
        dependencies,
        files: [{ path: `${item.slug}.json`, role: "sequence" }],
      };
    }
    put(clipPath, clipBytes);
    put(metaPath, jsonFile(meta));

    // A specific rule ahead of the generic rule, which records the owner's
    // authorship attestation and does not cover agent-made clips.
    const glob = `gestures/${item.slug}/*.json`;
    const rule = { glob, ...item.licence };
    inventory.rules = inventory.rules.filter((entry) => entry.glob !== glob);
    const generic = inventory.rules.findIndex(
      (entry) => entry.glob === GENERIC_GESTURE_RULE,
    );
    if (generic < 0)
      throw new Error(
        `${PROMOTE_PATHS.inventory}: no "${GENERIC_GESTURE_RULE}" rule.`,
      );
    inventory.rules.splice(generic, 0, rule);

    for (const file of [clipPath, metaPath]) {
      sourceReview.files = sourceReview.files.filter(
        (entry) => entry.path !== file,
      );
      sourceReview.files.push({ path: file, ...item.sourceReview });
    }
  }

  sourceReview.files.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  put(PROMOTE_PATHS.inventory, jsonFile(inventory));
  put(PROMOTE_PATHS.sourceReview, jsonFile(sourceReview));

  return [...writes]
    .filter(([relative, content]) => repo.read(relative) !== content)
    .map(([relative, content]) => ({
      path: relative,
      action: repo.read(relative) === null ? "create" : "update",
      content,
      ...(notes.has(relative) ? { notes: notes.get(relative) } : {}),
    }));
}

/**
 * The item's dependencies as its meta stores them, after checking each names
 * Included content of its type and every event of `clip` that plays content
 * names one of them (the same rule as `effects promote`). `missing` says how
 * to fix a ref that is not Included.
 */
function checkDependencies(slug, dependencies, clip, options) {
  try {
    return includedActionDependencies(dependencies, clip.events, options);
  } catch (error) {
    throw new Error(`${slug}: ${error.message}`);
  }
}

/** A repository reader over the working tree, through the given `fs`. */
export function workingTreeRepo(root, { readFileSync, readdirSync }) {
  return {
    // The same Included descriptors `effects promote` resolves refs against.
    includedMetas: () => listIncludedMetas(root, { readFileSync, readdirSync }),
    read(relative) {
      try {
        return readFileSync(path.join(root, relative), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    gestureSlugs() {
      return readdirSync(path.join(root, PROMOTE_PATHS.included, "gestures"), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },
  };
}

const USAGE = `Usage: pnpm -s animation promote <items.json> [--dry-run]

Promote owner-approved 2.0 Gestures to Included content. Run only with the
owner's explicit approval of each item and its licence entries, on a task
branch and PR. "clip" is a file or a Library source (library:local/<selector>;
Local items come from the sourced stack's ANIMAMA_LOCAL_CONTENT_HOST_PATH).
Each item: { "clip", "name", "aiDescription", "selectorId",
"mode": "add" | "replace", "slug"?, "licence": { creator, provenance,
license_id, redistribution_review }, "sourceReview": { candidate_license,
basis, copyright, review } }.
An add may list "dependencies": [{ "ref": "builtin:…", "alias", "content_type",
"config"? }] for the content its events play (promote new effects first with
pnpm -s effects promote). A replace keeps the folder, content ID, Selector ID
and dependencies; it changes the display name only with "rename": true and
the loop/one-shot kind only with "loopChange": true, and refuses either when
the item makes no such change. No two Included Gestures share a name after
the run.
--dry-run lists the files it would write and each name, kind and dependency
change.`;

/**
 * Run the promotion. `compactClip`, `maxClipBytes` and `resolveClip` come from
 * the motion CLI's modules, loaded by `animation.mjs` through Vite. Returns the
 * process exit code.
 */
export async function runPromote(
  argv,
  { repoRoot, cwd, compactClip, maxClipBytes, resolveClip, out },
) {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((value) => value !== "--dry-run");
  if (argv.includes("--help") || positional.length !== 1) {
    out(USAGE);
    return argv.includes("--help") ? 0 : 2;
  }
  const itemsFile = path.resolve(cwd, positional[0]);
  const fs = await import("node:fs");
  const webRequire = createRequire(
    path.join(repoRoot, "src/frontend/web/package.json"),
  );
  const { default: prettier } = await import(
    pathToFileURL(webRequire.resolve("prettier")).href
  );
  let writes;
  try {
    const items = await parsePromoteItems(
      JSON.parse(await readFile(itemsFile, "utf8")),
      itemsFile,
      resolveClip,
    );
    writes = await planPromotion(items, {
      repo: workingTreeRepo(repoRoot, fs),
      compactClip,
      maxClipBytes,
      formatJson: (value) =>
        prettier.format(JSON.stringify(value, null, 2), { parser: "json" }),
    });
  } catch (error) {
    out(`Promotion refused: ${error.message}`);
    return 1;
  }
  for (const { path: relative, action, notes = [] } of writes) {
    out(`${dryRun ? "Would " : ""}${action} ${relative}`);
    for (const note of notes) out(`  ${note}`);
  }
  if (dryRun) {
    out(`Dry run: ${writes.length} file(s) unchanged on disk.`);
    return 0;
  }
  for (const { path: relative, content } of writes) {
    const target = path.join(repoRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  out(
    `Wrote ${writes.length} file(s). git add them before running the backend Included-content tests, and update the pinned Gesture counts deliberately.`,
  );
  return 0;
}
