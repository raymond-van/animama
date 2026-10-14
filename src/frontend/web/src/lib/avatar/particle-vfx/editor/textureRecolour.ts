/**
 * Decode, recolour and encode one Particle texture for the colour theme. The
 * texture worker runs these, and the main thread does when a worker cannot
 * (`particleTextureCodec.ts`); they import only the pixel math, the PNG codec
 * and the texture limits, so the worker bundle stays small.
 *
 * PNG textures (all of the creator's) are decoded and encoded in JavaScript
 * (`pngCodec.ts`), so every pixel keeps its straight colour, including the
 * edge colour bled into fully transparent pixels. Anything else (JPEG or WebP
 * from a saved effect, interlaced or 16-bit PNG) is decoded on a canvas,
 * which keeps no colour in transparent pixels and quantizes faint ones: the
 * edge colour is bled back in after recolouring, as `effects:assets fix`
 * does, but faint pixels stay quantized. Copies are always 8-bit RGBA PNG.
 */
import { PARTICLE_TEXTURE_LIMITS } from "@/lib/effects/effectArtLimits";
import {
  bleedParticleVFXEdges,
  recolourParticleVFXPixels,
  sampleParticleVFXPixels,
  type ParticleVFXColourTransform,
  type ParticleVFXTextureSample,
} from "./colourPixels";
import {
  decodeParticleVFXPng,
  encodeParticleVFXPng,
  ParticleVFXCorruptPng,
  type ParticleVFXRgbaImage,
} from "./pngCodec";

/** The longer side of a colour sample, in pixels. */
export const PARTICLE_VFX_TEXTURE_SAMPLE_SIDE = 128;

/** This environment cannot draw into a canvas (so the worker cannot help). */
export class ParticleVFXTextureSurfaceUnavailable extends Error {
  constructor() {
    super("Textures cannot be drawn here.");
    this.name = "ParticleVFXTextureSurfaceUnavailable";
  }
}

/** A decoded texture; `bleed` is set when a canvas lost transparent colour. */
type DecodedTexture = ParticleVFXRgbaImage & {
  colourChunks: readonly Uint8Array[];
  bleed: boolean;
};

/**
 * Decode a texture to straight RGBA: PNG in JavaScript, else on a canvas. A
 * PNG this decoder finds inconsistent (for example trailing image data) also
 * goes to the canvas, which browsers read leniently; an oversized one stays
 * refused.
 */
async function decodeTexture(blob: Blob): Promise<DecodedTexture> {
  let png: Awaited<ReturnType<typeof decodeParticleVFXPng>> = null;
  try {
    png = await decodeParticleVFXPng(new Uint8Array(await blob.arrayBuffer()), {
      maxPixels: PARTICLE_TEXTURE_LIMITS.pixels,
    });
  } catch (error) {
    if (!(error instanceof ParticleVFXCorruptPng)) throw error;
  }
  if (png) return { ...png, bleed: false };
  return { ...(await decodeOnCanvas(blob)), colourChunks: [], bleed: true };
}

/**
 * Decode an image a canvas can read, without colour management. Rejects
 * with `ParticleVFXTextureSurfaceUnavailable` where there is no canvas.
 */
async function decodeOnCanvas(blob: Blob): Promise<ParticleVFXRgbaImage> {
  if (typeof createImageBitmap === "undefined")
    throw new ParticleVFXTextureSurfaceUnavailable();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
  } catch {
    throw new Error("The image could not be decoded.");
  }
  try {
    const { width, height } = bitmap;
    const context = createContext(width, height);
    context.drawImage(bitmap, 0, 0);
    return {
      width,
      height,
      data: context.getImageData(0, 0, width, height).data,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * A 2D context to draw into and read back: an `OffscreenCanvas` where there
 * is one (always in a worker that can help), otherwise a DOM canvas.
 */
function createContext(
  width: number,
  height: number,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  let context:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null = null;
  if (typeof OffscreenCanvas !== "undefined")
    context = new OffscreenCanvas(width, height).getContext("2d", {
      willReadFrequently: true,
    });
  else if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!context) throw new ParticleVFXTextureSurfaceUnavailable();
  return context;
}

/**
 * The texture scaled to at most `PARTICLE_VFX_TEXTURE_SAMPLE_SIDE` pixels
 * on its longer side, as RGBA: enough to measure its colour.
 */
export async function sampleParticleVFXTexture(
  blob: Blob,
): Promise<ParticleVFXTextureSample> {
  const image = await decodeTexture(blob);
  return sampleParticleVFXPixels(image, PARTICLE_VFX_TEXTURE_SAMPLE_SIDE);
}

/**
 * The texture with every pixel recoloured by `transform`, transparent ones
 * included, as an 8-bit RGBA PNG of the same size with the source's
 * colour-space chunks. Alpha is kept exactly.
 */
export async function recolourParticleVFXTexture(
  blob: Blob,
  transform: ParticleVFXColourTransform,
): Promise<Blob> {
  const image = await decodeTexture(blob);
  recolourParticleVFXPixels(image.data, transform);
  if (image.bleed) bleedParticleVFXEdges(image);
  const png = await encodeParticleVFXPng(image, image.colourChunks);
  return new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" });
}
