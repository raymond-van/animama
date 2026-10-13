import type {
  PyContentDependency,
  PyExactContentSource,
} from "@/lib/content/catalogTypes";
import {
  SCENE_IMAGE_LIMITS,
  inspectEffectArt,
} from "@/lib/effects/effectArtLimits";
import { sceneDefinitionLimitIssues } from "@/lib/scene-vfx/limits";
import { sceneEntryFromDefinition } from "@/lib/scene-vfx/sceneDefinition";
import type { SceneVFXEntry } from "@/lib/scene-vfx/types";
import {
  createDefaultSceneEffectDocument,
  defaultSceneOptionalLayers,
} from "./defaults";
import {
  SCENE_EFFECT_EDITOR_SCHEMA,
  type SceneEffectEditorAction,
  type SceneEffectEditorDocument,
  type SceneEffectEditorExport,
  type SceneEffectEditorImage,
  type SceneEffectEditorImageResource,
  type SceneEffectEditorMarqueeItem,
  type SceneEffectEditorSound,
  type SceneEffectValidationIssue,
} from "./types";

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const SCENE_EFFECT_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);
const MIB = 1024 * 1024;

export function sceneEffectEditorReducer(
  state: SceneEffectEditorDocument,
  action: SceneEffectEditorAction,
): SceneEffectEditorDocument {
  if (action.type === "replace")
    return cloneSceneEffectDocument(action.document);
  if (action.type === "set-kind") {
    return {
      ...state,
      kind: action.kind,
      dismissOnInput: action.kind === "background_layers",
    };
  }
  if (action.type === "patch") return { ...state, ...action.patch };
  if (action.type === "patch-background")
    return { ...state, background: { ...state.background, ...action.patch } };
  if (action.type === "patch-solid")
    return {
      ...state,
      background: {
        ...state.background,
        solid: { ...state.background.solid, ...action.patch },
      },
    };
  if (action.type === "patch-pattern")
    return {
      ...state,
      background: {
        ...state.background,
        pattern: { ...state.background.pattern, ...action.patch },
      },
    };
  if (action.type === "patch-marquee")
    return {
      ...state,
      background: {
        ...state.background,
        marquee: { ...state.background.marquee, ...action.patch },
      },
    };
  if (action.type === "set-marquee-items")
    return {
      ...state,
      background: {
        ...state.background,
        marquee: { ...state.background.marquee, items: action.items },
      },
    };
  if (action.type === "patch-focus")
    return { ...state, focus: { ...state.focus, ...action.patch } };
  if (action.type === "set-focus-target")
    return { ...state, focus: { ...state.focus, target: action.target } };
  return {
    ...state,
    focus: {
      ...state.focus,
      animation: { ...state.focus.animation, ...action.patch },
    },
  };
}

export function cloneSceneEffectDocument(
  document: SceneEffectEditorDocument,
): SceneEffectEditorDocument {
  return structuredClone(document);
}

/**
 * A document from before the optional layers (C1–C6), from browser recovery
 * or an editor export, gains them switched off. Layers it has keep their
 * place, so a current document's JSON is unchanged (restored recovery is
 * compared with the export text).
 */
export function normalizeSceneEffectDocument(
  document: SceneEffectEditorDocument,
): SceneEffectEditorDocument {
  const optional = defaultSceneOptionalLayers();
  const background = document.background;
  return {
    ...document,
    background: {
      ...background,
      gradient: background.gradient ?? optional.gradient,
      tile: background.tile ?? optional.tile,
      screen: background.screen ?? optional.screen,
      scatters: background.scatters ?? optional.scatters,
      flash: background.flash ?? optional.flash,
    },
  };
}

/**
 * Start a document over from a template (an Included effect opened as a
 * document): the template's kind, timing, behaviour, layers and focus lines
 * replace the document's, which keeps its own name, description and sound.
 * The template's images are the caller's to carry with the result.
 */
export function applySceneEffectTemplate(
  document: SceneEffectEditorDocument,
  template: SceneEffectEditorDocument,
): SceneEffectEditorDocument {
  return cloneSceneEffectDocument({
    ...template,
    name: document.name,
    description: document.description,
    sound: document.sound,
  });
}

/** The extension a Scene image keeps: its own, so name and bytes agree. */
const SCENE_IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": ".png",
  ".jpg": ".jpg",
  ".jpeg": ".jpg",
  ".webp": ".webp",
  ".svg": ".svg",
};

/** The extension each accepted Scene image type is saved with. */
const SCENE_IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

/**
 * A safe logical name for a chosen image. The extension follows `contentType`
 * when given (the type its bytes were read as), else the file's own, so a
 * saved image's name and bytes agree.
 */
export function canonicalSceneEffectImageName(
  filename: string,
  contentType?: string,
): string {
  const basename =
    filename.replaceAll("\\", "/").split("/").at(-1) ?? "scene-item";
  const stem =
    basename
      .replace(/\.[^.]+$/, "")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scene-item";
  const extension =
    (contentType && SCENE_IMAGE_TYPE_EXTENSIONS[contentType]) ??
    SCENE_IMAGE_EXTENSIONS[
      basename.match(/\.[^.]+$/)?.[0].toLowerCase() ?? ""
    ] ??
    ".png";
  return `${stem}${extension}`;
}

/**
 * Check a chosen Scene image before it is decoded, against the shared limits
 * the backend applies at Save: its type, bytes, and for a raster image its
 * format and size from the file header. Returns the content type its bytes
 * are (whatever the file claims), or why it is refused.
 */
export async function inspectSceneEffectImage(
  file: Blob,
): Promise<{ ok: true; contentType: string } | { ok: false; message: string }> {
  if (!SCENE_EFFECT_IMAGE_TYPES.has(file.type))
    return {
      ok: false,
      message: "Choose a PNG, JPEG, WebP, or static SVG image.",
    };
  const tooLarge = `Scene images must be at most ${SCENE_IMAGE_LIMITS.bytes / MIB} MiB.`;
  if (file.type === "image/svg+xml")
    return file.size > SCENE_IMAGE_LIMITS.bytes
      ? { ok: false, message: tooLarge }
      : { ok: true, contentType: file.type };
  const inspection = await inspectEffectArt(file, SCENE_IMAGE_LIMITS);
  if (inspection.ok)
    return { ok: true, contentType: `image/${inspection.format}` };
  return {
    ok: false,
    message:
      inspection.reason === "bytes"
        ? tooLarge
        : inspection.reason === "format"
          ? "The image is not a readable PNG, JPEG or WebP file."
          : `Scene images must be at most ${SCENE_IMAGE_LIMITS.dimension} px on each side.`,
  };
}

/** Where a chosen image goes: a marquee or scatter item, or the tile. */
export type SceneEffectImageTarget =
  | { kind: "marquee" }
  | { kind: "scatter"; index: number }
  | { kind: "tile" };

/** The label an image item takes by default: its file name without extension. */
export function sceneEffectImageItemLabel(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

/**
 * Add a chosen image to `target`, switching that layer on. The new item is
 * labelled `label` (a sticker's label), by default the file's name.
 */
export function addSceneEffectImage(
  document: SceneEffectEditorDocument,
  image: SceneEffectEditorImage,
  target: SceneEffectImageTarget,
  label?: string,
): SceneEffectEditorDocument {
  const background = document.background;
  const item: SceneEffectEditorMarqueeItem = {
    id: `private-${crypto.randomUUID().slice(0, 8)}`,
    kind: "image",
    label: label ?? sceneEffectImageItemLabel(image.originalName),
    image,
  };
  if (target.kind === "tile")
    return {
      ...document,
      background: {
        ...background,
        tile: { ...background.tile, enabled: true, image },
      },
    };
  if (target.kind === "scatter")
    return {
      ...document,
      background: {
        ...background,
        scatters: background.scatters.map((layer, index) =>
          index === target.index
            ? { ...layer, enabled: true, items: [...layer.items, item] }
            : layer,
        ),
      },
    };
  return {
    ...document,
    background: {
      ...background,
      marquee: {
        ...background.marquee,
        enabled: true,
        items: [...background.marquee.items, item],
      },
    },
  };
}

/** Give every use of an image (by logical name) newly chosen bytes. */
export function replaceSceneEffectImage(
  document: SceneEffectEditorDocument,
  image: SceneEffectEditorImage,
): SceneEffectEditorDocument {
  const items = (list: SceneEffectEditorMarqueeItem[]) =>
    list.map((item) =>
      item.kind === "image" && item.image.logicalName === image.logicalName
        ? { ...item, image }
        : item,
    );
  const background = document.background;
  return {
    ...document,
    background: {
      ...background,
      marquee: {
        ...background.marquee,
        items: items(background.marquee.items),
      },
      scatters: background.scatters.map((layer) => ({
        ...layer,
        items: items(layer.items),
      })),
      tile:
        background.tile.image?.logicalName === image.logicalName
          ? { ...background.tile, image }
          : background.tile,
    },
  };
}

export function uniqueSceneEffectImageName(
  filename: string,
  existingNames: Iterable<string>,
): string {
  const canonical = canonicalSceneEffectImageName(filename);
  const existing = new Set(existingNames);
  if (!existing.has(canonical)) return canonical;
  const extension = canonical.match(/\.[^.]+$/)?.[0] ?? ".png";
  const stem = canonical.slice(0, -extension.length);
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}

export function sceneEffectDefinition(
  document: SceneEffectEditorDocument,
): Record<string, unknown> {
  const common = {
    schema: "animama/scene-effect/1",
    kind: document.kind,
    durationMs: document.durationMs,
    coverUiOverlays: document.coverUiOverlays,
    dismissOnInput: document.dismissOnInput,
    ...(document.sound ? { soundAlias: document.sound.alias } : {}),
  };
  if (document.kind === "background_layers") {
    const { solid, pattern, marquee, gradient, tile, screen, scatters, flash } =
      document.background;
    const { image: tileImage, ...tileSettings } = tile;
    return {
      ...common,
      solid: { ...solid },
      pattern: { ...pattern },
      marquee: { ...marquee, items: marquee.items.map(definitionItem) },
      gradient: structuredClone(gradient),
      // A tile names its image; without one there is no tile to save.
      ...(tileImage
        ? { tile: { ...tileSettings, image: tileImage.logicalName } }
        : {}),
      screen: { ...screen },
      scatters: scatters.map((layer) => ({
        ...layer,
        items: layer.items.map(definitionItem),
      })),
      flash: { ...flash },
    };
  }
  return {
    ...common,
    renderPlacement: document.focus.renderPlacement,
    lineCount: document.focus.lineCount,
    color: document.focus.color,
    opacity: document.focus.opacity,
    baseThicknessPx: document.focus.baseThicknessPx,
    thicknessVariationPx: document.focus.thicknessVariationPx,
    lengthVariation: document.focus.lengthVariation,
    overscanPx: document.focus.overscanPx,
    target: structuredClone(document.focus.target),
    animation: { ...document.focus.animation },
    seed: document.focus.seed,
  };
}

/** The runtime entry the preview draws, with each image at its URL. */
export function sceneEffectRuntimeEntry(
  document: SceneEffectEditorDocument,
  imageUrls: ReadonlyMap<string, string>,
): SceneVFXEntry {
  for (const image of sceneEffectImageMetadata(document))
    if (!imageUrls.get(image.logicalName))
      throw new Error(`Reselect ${image.originalName} for preview.`);
  return sceneEntryFromDefinition(
    sceneEffectDefinition(document),
    {
      id: "scene-effect-editor-preview",
      label: document.name || "Scene Effect preview",
    },
    (logicalName) => imageUrls.get(logicalName),
    document.sound ? { sound: { onApply: document.sound.alias } } : {},
  ).entry;
}

export function sceneEffectDependencies(
  document: SceneEffectEditorDocument,
): PyContentDependency[] {
  return document.sound
    ? [
        {
          alias: document.sound.alias,
          content_type: "sound_effect",
          source: document.sound.source,
          config: {},
        },
      ]
    : [];
}

/** The private images a background shows: marquee and scatter items, the tile. */
export function sceneEffectImageMetadata(
  document: SceneEffectEditorDocument,
): SceneEffectEditorImage[] {
  if (document.kind !== "background_layers") return [];
  const byName = new Map<string, SceneEffectEditorImage>();
  const { marquee, scatters, tile } = document.background;
  for (const item of [
    ...marquee.items,
    ...scatters.flatMap((layer) => layer.items),
  ]) {
    if (item.kind === "image") byName.set(item.image.logicalName, item.image);
  }
  if (tile.image) byName.set(tile.image.logicalName, tile.image);
  return [...byName.values()];
}

export function validateSceneEffectDocument(
  document: SceneEffectEditorDocument,
  resources: readonly SceneEffectEditorImageResource[],
): SceneEffectValidationIssue[] {
  const issues: SceneEffectValidationIssue[] = [];
  if (document.name.trim().length > 120)
    issue(issues, "name", "Keep the Scene Effect name within 120 characters.");
  if (document.description.length > 2000)
    issue(
      issues,
      "description",
      "Description must be 2,000 characters or shorter.",
    );
  if (
    document.durationMs !== null &&
    (!Number.isInteger(document.durationMs) ||
      document.durationMs < 100 ||
      document.durationMs > 30_000)
  )
    issue(
      issues,
      "duration",
      "Duration must be sticky or between 0.1 and 30 seconds.",
    );
  if (document.sound && !isExactContentSource(document.sound.source))
    issue(
      issues,
      "sound",
      "Reselect the Sound Effect so exact catalog content can be saved.",
    );

  // Ranges, counts and legacy Twemoji items, as the backend checks them at
  // Save (the duration is reported above in the creator's own terms).
  for (const limit of sceneDefinitionLimitIssues(
    sceneEffectDefinition(document),
  ))
    if (limit.field !== "durationMs") issue(issues, limit.field, limit.message);
  if (document.kind === "background_layers") {
    validateBackground(document, resources, issues);
  } else {
    validateFocus(document, issues);
    if (resources.length > 0)
      issues.push({
        field: "images",
        severity: "warning",
        message:
          "Unused background image bytes will not be saved with Focus Lines.",
      });
  }
  try {
    const urls = new Map(
      sceneEffectImageMetadata(document).map((image) => [
        image.logicalName,
        `blob:scene-editor-${image.logicalName}`,
      ]),
    );
    sceneEffectRuntimeEntry(document, urls);
  } catch (error) {
    issue(
      issues,
      "definition",
      error instanceof Error
        ? error.message
        : "The Scene Effect definition is invalid.",
    );
  }
  return issues;
}

function validateBackground(
  document: SceneEffectEditorDocument,
  resources: readonly SceneEffectEditorImageResource[],
  issues: SceneEffectValidationIssue[],
) {
  const { solid, pattern, marquee, gradient, tile, screen, scatters, flash } =
    document.background;
  const color = (field: string, value: string, noun: string) => {
    if (!COLOR_PATTERN.test(value))
      issue(issues, field, `Choose a six-digit hex ${noun} color.`);
  };
  color("solid.color", solid.color, "solid");
  color("pattern.color", pattern.color, "pattern");
  gradient.stops.forEach((stop, index) =>
    color(`gradient.stops.${index}`, stop.color, "gradient stop"),
  );
  color("screen.color", screen.color, "screen");
  color("flash.color", flash.color, "flash");
  for (const [field, items] of [
    ["marquee.items", marquee.items],
    ...scatters.map(
      (layer, index) => [`scatters.${index}.items`, layer.items] as const,
    ),
  ] as const)
    if (new Set(items.map((item) => item.id)).size !== items.length)
      issue(issues, field, "Every item needs a unique id.");
  if (tile.enabled && !tile.image)
    issue(issues, "tile.image", "Choose an image to tile.");
  const metadata = sceneEffectImageMetadata(document);
  if (metadata.length > SCENE_IMAGE_LIMITS.count)
    issue(
      issues,
      "images",
      `A Scene Effect can contain at most ${SCENE_IMAGE_LIMITS.count} private images.`,
    );
  const resourcesByName = new Map(
    resources.map((resource) => [resource.logicalName, resource]),
  );
  for (const image of metadata) {
    if (!SCENE_EFFECT_IMAGE_TYPES.has(image.contentType))
      issue(
        issues,
        "images",
        `${image.originalName} is not PNG, JPEG, WebP, or SVG.`,
      );
    if (!resourcesByName.has(image.logicalName))
      issue(
        issues,
        "images",
        `Reselect ${image.originalName} so its bytes can be saved.`,
      );
  }
  const totalBytes = metadata.reduce((sum, image) => sum + image.sizeBytes, 0);
  if (totalBytes > SCENE_IMAGE_LIMITS.totalBytes)
    issue(
      issues,
      "images",
      `Private Scene images must total ${SCENE_IMAGE_LIMITS.totalBytes / MIB} MiB or less.`,
    );
}

function validateFocus(
  document: SceneEffectEditorDocument,
  issues: SceneEffectValidationIssue[],
) {
  const focus = document.focus;
  if (!COLOR_PATTERN.test(focus.color))
    issue(issues, "focus.color", "Choose a six-digit hex line color.");
  if (focus.target.kind === "manual_box") {
    const { x, y, width, height } = focus.target.rect;
    if (
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1 ||
      y + height > 1
    )
      issue(
        issues,
        "focus.target",
        "The manual target must stay within the normalized viewport.",
      );
  }
  const animation = focus.animation;
  if (
    animation.minVisibleMs > animation.maxVisibleMs ||
    animation.minHiddenMs > animation.maxHiddenMs
  )
    issue(
      issues,
      "focus.animation",
      "Minimum flicker times cannot exceed their maximums.",
    );
}

export function sceneEffectDocumentFingerprint(
  document: SceneEffectEditorDocument,
): string {
  return JSON.stringify(canonicalJson(document));
}

export function buildSceneEffectEditorExport(
  document: SceneEffectEditorDocument,
): SceneEffectEditorExport {
  return {
    schema: SCENE_EFFECT_EDITOR_SCHEMA,
    document: cloneSceneEffectDocument(document),
  };
}

export function parseSceneEffectEditorExport(
  value: unknown,
): SceneEffectEditorDocument {
  const record = object(value);
  const raw = object(record?.document);
  if (record?.schema !== SCENE_EFFECT_EDITOR_SCHEMA || !raw)
    throw new Error("This is not an Animama Scene Effect editor document.");
  const document = raw as unknown as SceneEffectEditorDocument;
  if (document.schema !== SCENE_EFFECT_EDITOR_SCHEMA)
    throw new Error("The Scene Effect editor schema is unsupported.");
  const clone = normalizeSceneEffectDocument(
    cloneSceneEffectDocument(document),
  );
  const images = sceneEffectImageMetadata(clone);
  sceneEffectRuntimeEntry(
    clone,
    new Map(
      images.map((image) => [
        image.logicalName,
        `blob:import-${image.logicalName}`,
      ]),
    ),
  );
  return clone;
}

export function createSceneEffectDocumentFromDefinition(args: {
  name: string;
  description: string;
  definition: unknown;
  images: ReadonlyMap<string, SceneEffectEditorImage>;
  sound: SceneEffectEditorSound | null;
}): SceneEffectEditorDocument {
  const raw = object(args.definition);
  if (!raw) throw new Error("The Scene Effect definition is unavailable.");
  const defaults = createDefaultSceneEffectDocument();
  const kind = raw.kind;
  if (kind !== "background_layers" && kind !== "focus_lines")
    throw new Error("The Scene Effect kind is unsupported.");
  const durationMs =
    raw.durationMs === null
      ? null
      : Number(raw.durationMs ?? defaults.durationMs);
  const document: SceneEffectEditorDocument = {
    ...defaults,
    name: args.name,
    description: args.description,
    kind,
    durationMs,
    coverUiOverlays: Boolean(raw.coverUiOverlays),
    dismissOnInput:
      raw.dismissOnInput === undefined
        ? kind === "background_layers"
        : Boolean(raw.dismissOnInput),
    sound: args.sound,
  };
  if (kind === "background_layers") {
    const solid = object(raw.solid);
    const pattern = object(raw.pattern);
    const marquee = object(raw.marquee);
    if (!solid || !pattern || !marquee || !Array.isArray(marquee.items))
      throw new Error("The background layer definition is incomplete.");
    const items = marquee.items.map((value, index) =>
      hydrateMarqueeItem(value, index, args.images),
    );
    type Background = SceneEffectEditorDocument["background"];
    const optional = defaultSceneOptionalLayers();
    const tile = object(raw.tile);
    const tileImage =
      tile && typeof tile.image === "string"
        ? args.images.get(tile.image)
        : null;
    if (tile && !tileImage)
      throw new Error(
        `The release image ${String(tile.image)} is unavailable.`,
      );
    document.background = {
      solid: solid as unknown as Background["solid"],
      pattern: pattern as unknown as Background["pattern"],
      marquee: {
        ...(marquee as unknown as Omit<Background["marquee"], "items">),
        items,
      },
      // The optional layers (C1–C6); an absent one is off.
      gradient:
        (object(raw.gradient) as unknown as Background["gradient"] | null) ??
        optional.gradient,
      tile:
        tile && tileImage
          ? {
              ...(tile as unknown as Omit<Background["tile"], "image">),
              image: tileImage,
            }
          : optional.tile,
      screen:
        (object(raw.screen) as unknown as Background["screen"] | null) ??
        optional.screen,
      scatters: Array.isArray(raw.scatters)
        ? raw.scatters.map((value, index) => {
            const layer = object(value);
            if (!layer || !Array.isArray(layer.items))
              throw new Error(`Scatter layer ${index + 1} is invalid.`);
            return {
              ...(layer as unknown as Background["scatters"][number]),
              items: layer.items.map((item, itemIndex) =>
                hydrateMarqueeItem(item, itemIndex, args.images),
              ),
            };
          })
        : optional.scatters,
      flash:
        (object(raw.flash) as unknown as Background["flash"] | null) ??
        optional.flash,
    };
  } else {
    const target = object(raw.target);
    const animation = object(raw.animation);
    if (!target || !animation)
      throw new Error("The focus-line definition is incomplete.");
    document.focus = {
      renderPlacement:
        raw.renderPlacement as SceneEffectEditorDocument["focus"]["renderPlacement"],
      lineCount: Number(raw.lineCount),
      color: String(raw.color),
      opacity: Number(raw.opacity),
      baseThicknessPx: Number(raw.baseThicknessPx),
      thicknessVariationPx: Number(raw.thicknessVariationPx),
      lengthVariation: Number(raw.lengthVariation),
      overscanPx: Number(raw.overscanPx),
      target: target as unknown as SceneEffectEditorDocument["focus"]["target"],
      animation:
        animation as unknown as SceneEffectEditorDocument["focus"]["animation"],
      seed:
        raw.seed === null || raw.seed === undefined ? null : Number(raw.seed),
    };
  }
  sceneEffectRuntimeEntry(
    document,
    new Map([...args.images].map(([name]) => [name, `blob:hydrate-${name}`])),
  );
  return document;
}

function hydrateMarqueeItem(
  value: unknown,
  index: number,
  images: ReadonlyMap<string, SceneEffectEditorImage>,
): SceneEffectEditorMarqueeItem {
  const item = object(value);
  if (!item) throw new Error(`Marquee item ${index + 1} is invalid.`);
  if (item.kind === "image") {
    const logicalName = String(item.image ?? "");
    const image = images.get(logicalName);
    if (!image)
      throw new Error(
        `The release image ${logicalName || index + 1} is unavailable.`,
      );
    return {
      id: String(item.id),
      kind: "image",
      label: String(item.label),
      image,
    };
  }
  if (item.kind !== "emoji")
    throw new Error(`Marquee item ${index + 1} is unsupported.`);
  // A Twemoji item, kept so the creator can show it as missing.
  return {
    id: String(item.id),
    kind: "emoji",
    label: String(item.label),
    emoji: String(item.emoji),
  };
}

function definitionItem(
  item: SceneEffectEditorMarqueeItem,
): Record<string, unknown> {
  if (item.kind === "image")
    return {
      id: item.id,
      kind: "image",
      label: item.label,
      image: item.image.logicalName,
    };
  // A legacy Twemoji item stays in the definition (the runtime skips it) and
  // blocks Save until it is replaced; any other kind is a forged document.
  if (item.kind === "emoji")
    return { id: item.id, kind: "emoji", label: item.label, emoji: item.emoji };
  throw new Error("The Scene item kind is unsupported.");
}

function issue(
  issues: SceneEffectValidationIssue[],
  field: string,
  message: string,
) {
  issues.push({ field, severity: "error", message });
}

function isExactContentSource(value: unknown): value is PyExactContentSource {
  const source = object(value);
  return source?.type === "catalog"
    ? typeof source.catalog_item_id === "string" &&
        source.catalog_item_id.length > 0
    : source?.type === "builtin" &&
        typeof source.content_id === "string" &&
        source.content_id.length > 0 &&
        Number.isInteger(source.version) &&
        Number(source.version) > 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  return value;
}
