/**
 * Textures a Particle Effect carries itself, beside the built-in set.
 *
 * Emitters refer to a texture by the package-relative path its Quarks image
 * uses (`textures/<file>`). A built-in texture resolves from the app; any other
 * reference needs bytes in `draft.textureFiles`, whether the user imported the
 * PNG or the texture came with a saved effect, template or package. Imported
 * files are untrusted: their size, format and header dimensions are checked
 * against the shared limits before anything decodes them.
 */
import {
  PARTICLE_TEXTURE_LIMITS,
  inspectEffectArt,
  type EffectArtFormat,
  type EffectArtRefusal,
} from "@/lib/effects/effectArtLimits";
import { PARTICLE_VFX_EDITOR_TEXTURES } from "./constants";
import { applyParticleVFXEmitterPatch } from "./draft";
import { cloneJsonObject, readJsonArrayObjects } from "./json";
import { classifyParticleVFXTextureUrl } from "./textures";
import type {
  JsonObject,
  ParticleVFXEditorDraft,
  ParticleVFXEditorTextureFile,
} from "./types";

export type ParticleVFXTextureResult =
  | { ok: true; draft: ParticleVFXEditorDraft; reference: string }
  | { ok: false; message: string };

const BUILT_IN_REFERENCES = new Set(
  PARTICLE_VFX_EDITOR_TEXTURES.map((texture) => texture.relativeUrl),
);

/** Whether a package-relative path names a built-in creator texture. */
export function isBuiltInParticleVFXTextureReference(
  reference: string,
): boolean {
  return BUILT_IN_REFERENCES.has(reference);
}
const MIB = 1024 * 1024;

/** Every distinct image path the effect's Quarks JSON uses, in order. */
export function particleVFXTextureReferences(quarksJson: JsonObject): string[] {
  const references: string[] = [];
  for (const image of readJsonArrayObjects(quarksJson.images)) {
    if (typeof image.url === "string" && !references.includes(image.url))
      references.push(image.url);
  }
  return references;
}

/** Texture files the effect's JSON still uses; Save packages exactly these. */
export function referencedParticleVFXTextureFiles(
  draft: ParticleVFXEditorDraft,
): Record<string, ParticleVFXEditorTextureFile> {
  return pickTextureFiles(
    draft,
    particleVFXTextureReferences(draft.quarksJson),
  );
}

/**
 * Texture files the effect or Simple mode's reference uses. Browser recovery
 * keeps these, so a colour theme's Original still has the reference's own
 * textures after a reload.
 */
export function retainedParticleVFXTextureFiles(
  draft: ParticleVFXEditorDraft,
): Record<string, ParticleVFXEditorTextureFile> {
  return pickTextureFiles(draft, [
    ...particleVFXTextureReferences(draft.quarksJson),
    ...(draft.simple
      ? particleVFXTextureReferences(draft.simple.reference.quarksJson)
      : []),
  ]);
}

function pickTextureFiles(
  draft: ParticleVFXEditorDraft,
  references: readonly string[],
): Record<string, ParticleVFXEditorTextureFile> {
  return Object.fromEntries(
    references.flatMap((reference) => {
      const file = draft.textureFiles[reference];
      return file ? [[reference, file]] : [];
    }),
  );
}

/** Package-relative references with neither bytes nor a built-in texture. */
export function missingParticleVFXTextureReferences(
  draft: ParticleVFXEditorDraft,
): string[] {
  return particleVFXTextureReferences(draft.quarksJson).filter(
    (reference) =>
      classifyParticleVFXTextureUrl(reference) === "relative" &&
      !BUILT_IN_REFERENCES.has(reference) &&
      !draft.textureFiles[reference],
  );
}

function refusalMessage({ reason }: EffectArtRefusal): string {
  if (reason === "bytes")
    return `Texture files must be at most ${PARTICLE_TEXTURE_LIMITS.bytes / MIB} MiB.`;
  if (reason === "dimension" || reason === "pixels")
    return `Textures must be at most ${PARTICLE_TEXTURE_LIMITS.dimension} px on each side.`;
  return "Texture files must be PNG images.";
}

/**
 * Download every texture file a saved Particle Effect carries, keyed by the
 * path its manifest uses. A file over the limits fails the load.
 */
export async function loadParticleVFXTextureFiles(
  files: readonly { logicalPath: string; download: () => Promise<Blob> }[],
): Promise<Record<string, ParticleVFXEditorTextureFile>> {
  const textureFiles: Record<string, ParticleVFXEditorTextureFile> = {};
  for (const { logicalPath, download } of files) {
    const read = await readParticleVFXTextureFile(await download(), {
      formats: ["png", "jpeg", "webp"],
    });
    if (!read.ok) throw new Error(`Texture ${logicalPath}: ${read.message}`);
    textureFiles[logicalPath] = read.file;
  }
  return textureFiles;
}

/** Hex SHA-256 of a Blob's bytes (textures are at most a few MiB). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Check one untrusted texture file without decoding it and describe it.
 * Imports accept PNG only; a saved effect's files may also be JPEG or WebP.
 * The refusal message names the limit it broke.
 */
export async function readParticleVFXTextureFile(
  blob: Blob,
  { formats = ["png"] }: { formats?: readonly EffectArtFormat[] } = {},
): Promise<
  | { ok: true; file: ParticleVFXEditorTextureFile }
  | { ok: false; message: string; reason: EffectArtRefusal["reason"] }
> {
  const inspection = await inspectEffectArt(blob, PARTICLE_TEXTURE_LIMITS, {
    formats,
  });
  if (!inspection.ok)
    return {
      ok: false,
      message: refusalMessage(inspection),
      reason: inspection.reason,
    };
  // Name the detected type so packaging matches the bytes, not the file name.
  const contentType = `image/${inspection.format}`;
  const typed =
    blob.type === contentType ? blob : blob.slice(0, blob.size, contentType);
  return {
    ok: true,
    file: {
      blob: typed,
      sha256: await sha256Hex(typed),
      width: inspection.width,
      height: inspection.height,
    },
  };
}

/** Why the effect's textures exceed the per-effect limits, if they do. */
export function particleVFXTextureLimitMessage(
  draft: ParticleVFXEditorDraft,
): string | null {
  const references = particleVFXTextureReferences(draft.quarksJson);
  if (references.length > PARTICLE_TEXTURE_LIMITS.count)
    return `A Particle Effect can use at most ${PARTICLE_TEXTURE_LIMITS.count} textures.`;
  const total = Object.values(referencedParticleVFXTextureFiles(draft)).reduce(
    (sum, file) => sum + file.blob.size,
    0,
  );
  if (total > PARTICLE_TEXTURE_LIMITS.totalBytes)
    return `Textures in one Particle Effect must total at most ${PARTICLE_TEXTURE_LIMITS.totalBytes / MIB} MiB.`;
  return null;
}

function withTextureFile(
  draft: ParticleVFXEditorDraft,
  reference: string,
  file: ParticleVFXEditorTextureFile,
): ParticleVFXEditorDraft {
  return {
    ...draft,
    textureFiles: { ...draft.textureFiles, [reference]: file },
  };
}

/**
 * A file name's stem as texture paths use it: lowercase letters, digits and
 * hyphens, at most 60 characters, `texture` when nothing is left.
 */
export function particleVFXTextureStem(fileName: string): string {
  return (
    (fileName.split(/[\\/]/).at(-1) ?? "")
      .replace(/\.[^.]*$/, "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "texture"
  );
}

/**
 * A reference that no built-in texture or `used` reference has. The number is
 * always present so new art never shadows a built-in name.
 */
function nextTextureReference(stem: string, used: Set<string>): string {
  for (let index = 1; ; index += 1) {
    const reference = `textures/${stem}-${index}.png`;
    if (
      !used.has(reference) &&
      !isBuiltInParticleVFXTextureReference(reference)
    ) {
      used.add(reference);
      return reference;
    }
  }
}

/** A reference no JSON image or carried file of the draft uses yet. */
function uniqueTextureReference(
  draft: ParticleVFXEditorDraft,
  stem: string,
): string {
  return nextTextureReference(
    stem,
    new Set([
      ...particleVFXTextureReferences(draft.quarksJson),
      ...Object.keys(draft.textureFiles),
    ]),
  );
}

/** Add a checked file under a new reference and give it to one emitter. */
export function importParticleVFXTextureFile(
  draft: ParticleVFXEditorDraft,
  emitterPath: string,
  fileName: string,
  file: ParticleVFXEditorTextureFile,
): ParticleVFXTextureResult {
  const reference = uniqueTextureReference(
    draft,
    particleVFXTextureStem(fileName),
  );
  const next = applyParticleVFXEmitterPatch(
    withTextureFile(draft, reference, file),
    emitterPath,
    { textureReference: reference },
  );
  const message = particleVFXTextureLimitMessage(next);
  return message
    ? { ok: false, message }
    : { ok: true, draft: next, reference };
}

/** Provide the bytes for a texture the effect already refers to. */
export function supplyParticleVFXTextureFile(
  draft: ParticleVFXEditorDraft,
  reference: string,
  file: ParticleVFXEditorTextureFile,
): ParticleVFXTextureResult {
  const next = withTextureFile(draft, reference, file);
  const message = particleVFXTextureLimitMessage(next);
  return message
    ? { ok: false, message }
    : { ok: true, draft: next, reference };
}

function decodeDataUrl(url: string): Blob | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!match) return null;
  try {
    const binary = atob(match[1]!.replace(/\s+/g, ""));
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], {
      type: "image/png",
    });
  } catch {
    return null;
  }
}

/**
 * Move PNG image data embedded in imported Quarks JSON (as three.quarks
 * exports it) into texture files with new package-relative references that
 * neither the JSON nor `reserved` (the draft's carried files) use. Data that
 * is not an acceptable PNG stays in place, and readiness reports it.
 */
export async function extractEmbeddedParticleVFXTextures(
  quarksJson: JsonObject,
  reserved: Iterable<string> = [],
): Promise<{
  json: JsonObject;
  textureFiles: Record<string, ParticleVFXEditorTextureFile>;
  refused: string[];
}> {
  const json = cloneJsonObject(quarksJson);
  const textureFiles: Record<string, ParticleVFXEditorTextureFile> = {};
  const refused: string[] = [];
  const used = new Set([...particleVFXTextureReferences(json), ...reserved]);
  for (const image of readJsonArrayObjects(json.images)) {
    if (
      typeof image.url !== "string" ||
      classifyParticleVFXTextureUrl(image.url) !== "embedded"
    )
      continue;
    const blob = decodeDataUrl(image.url);
    const read = blob
      ? await readParticleVFXTextureFile(blob)
      : { ok: false as const, message: "Texture files must be PNG images." };
    if (!read.ok) {
      refused.push(read.message);
      continue;
    }
    const reference = nextTextureReference("embedded", used);
    textureFiles[reference] = read.file;
    image.url = reference;
  }
  return { json, textureFiles, refused };
}
