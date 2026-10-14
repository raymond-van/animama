import {
  createParticleVFXEditorDraftFromBlank,
  importParticleVFXTextureFile,
  readParticleVFXTextureFile,
  setParticleVFXColourTheme,
  type ParticleVFXColourThemeId,
  type ParticleVFXEditorDraft,
  type ParticleVFXTextureCodec,
} from "@/lib/avatar/particle-vfx";

/** A PNG signature and a 1×1 IHDR, then `tag`: passes the header checks. */
export function fakeParticlePng(tag: number): Blob {
  return new Blob(
    [
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        13,
        0x49,
        0x48,
        0x44,
        0x52,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        8,
        6,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        tag,
      ]),
    ],
    { type: "image/png" },
  );
}

/**
 * A codec without a canvas: every texture samples as one red pixel, and a
 * recoloured copy is a distinct fake PNG per transform.
 */
export const fakeParticleTextureCodec: ParticleVFXTextureCodec = {
  sample: async () => ({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255]),
  }),
  recolour: async (_blob, transform) =>
    fakeParticlePng(
      transform.kind === "desaturate" ? 255 : (transform.degrees + 360) % 251,
    ),
};

/**
 * The blank effect wearing an imported red texture (`textures/glyph-1.png`),
 * and the same draft with `theme` applied through the fake codec.
 */
export async function themedParticleDraft(
  theme: ParticleVFXColourThemeId = "sky",
): Promise<{ draft: ParticleVFXEditorDraft; themed: ParticleVFXEditorDraft }> {
  const blank = createParticleVFXEditorDraftFromBlank();
  const read = await readParticleVFXTextureFile(fakeParticlePng(1));
  if (!read.ok) throw new Error(read.message);
  const imported = importParticleVFXTextureFile(
    blank,
    blank.emitters[0]!.path,
    "glyph.png",
    read.file,
  );
  if (!imported.ok) throw new Error(imported.message);
  const result = await setParticleVFXColourTheme(imported.draft, theme, {
    codec: fakeParticleTextureCodec,
    loadTexture: async () => null,
  });
  if (!result.ok) throw new Error(result.message);
  return { draft: imported.draft, themed: result.draft };
}
