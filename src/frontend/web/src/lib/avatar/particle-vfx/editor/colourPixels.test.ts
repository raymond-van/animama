import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  bleedParticleVFXEdges,
  particleVFXHue,
  particleVFXPixelChroma,
  recolourParticleVFXPixels,
  sampleParticleVFXPixels,
  transformParticleVFXColour,
} from "./colourPixels";

/** HSL lightness of an 8-bit pixel, in 0–255 units. */
function lightness(r: number, g: number, b: number): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

/** Shortest signed distance from hue `from` to hue `to`, in degrees. */
function hueDistance(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * A small PNG fixture: one row of saturated and pastel pixels at several
 * hues and alphas, a grey pixel and a fully transparent one.
 */
const FIXTURE: readonly [number, number, number, number][] = [
  [230, 40, 60, 255],
  [255, 120, 0, 200],
  [40, 200, 90, 128],
  [30, 90, 220, 64],
  [250, 200, 220, 255],
  [120, 30, 160, 10],
  [128, 128, 128, 255],
  [255, 0, 0, 0],
];

async function fixturePng(): Promise<Buffer> {
  return sharp(Buffer.from(FIXTURE.flat()), {
    raw: { width: FIXTURE.length, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Decode a PNG to its RGBA bytes, as the browser codec would. */
async function decode(png: Buffer): Promise<Uint8ClampedArray> {
  const { data } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8ClampedArray(data);
}

/** Recolour a PNG's pixels and encode them again, as a theme does. */
async function recolourPng(
  png: Buffer,
  transform: Parameters<typeof recolourParticleVFXPixels>[1],
): Promise<Uint8ClampedArray> {
  const pixels = await decode(png);
  recolourParticleVFXPixels(pixels, transform);
  const encoded = await sharp(Buffer.from(pixels), {
    raw: { width: FIXTURE.length, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
  return decode(encoded);
}

describe("colour theme pixel math", () => {
  it("moves every coloured pixel's hue by the step and keeps its alpha and lightness", async () => {
    const before = await decode(await fixturePng());
    const after = await recolourPng(await fixturePng(), {
      kind: "rotate",
      degrees: 140,
    });

    for (let index = 0; index < FIXTURE.length; index += 1) {
      const offset = index * 4;
      const [r, g, b, a] = before.slice(offset, offset + 4);
      const [r2, g2, b2, a2] = after.slice(offset, offset + 4);
      expect(a2).toBe(a);
      expect(Math.abs(lightness(r2!, g2!, b2!) - lightness(r!, g!, b!))).toBe(
        0,
      );
      const original = particleVFXHue(r! / 255, g! / 255, b! / 255);
      const moved = particleVFXHue(r2! / 255, g2! / 255, b2! / 255);
      if (original.hue === null || a === 0) continue;
      // Chroma is kept exactly; the hue within the 8-bit rounding.
      expect(moved.chroma).toBeCloseTo(original.chroma, 6);
      expect(
        Math.abs(hueDistance(original.hue + 140, moved.hue!)),
      ).toBeLessThan(2);
    }
    // Grey stays grey.
    expect([...after.slice(24, 28)]).toEqual([128, 128, 128, 255]);
  });

  it("desaturates for White, keeping lightness and alpha", async () => {
    const before = await decode(await fixturePng());
    const after = await recolourPng(await fixturePng(), {
      kind: "desaturate",
    });

    for (let index = 0; index < FIXTURE.length; index += 1) {
      const offset = index * 4;
      const [r, g, b, a] = before.slice(offset, offset + 4);
      const [r2, g2, b2, a2] = after.slice(offset, offset + 4);
      expect(a2).toBe(a);
      if (a === 0) continue;
      expect(r2).toBe(g2);
      expect(g2).toBe(b2);
      expect(Math.abs(r2! - lightness(r!, g!, b!))).toBeLessThanOrEqual(0.5);
    }
  });

  it("recolours transparent pixels too, so bled edge colour follows the art", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 255]);
    recolourParticleVFXPixels(pixels, { kind: "rotate", degrees: 120 });
    expect([...pixels]).toEqual([0, 255, 0, 0, 0, 255, 0, 255]);
    recolourParticleVFXPixels(pixels, { kind: "desaturate" });
    expect([...pixels]).toEqual([128, 128, 128, 0, 128, 128, 128, 255]);
  });

  it("rotates and desaturates an editor colour, keeping its alpha", () => {
    expect(
      transformParticleVFXColour(
        { r: 1, g: 0, b: 0, a: 0.5 },
        { kind: "rotate", degrees: 120 },
      ),
    ).toEqual({ r: 0, g: 1, b: 0, a: 0.5 });
    expect(
      transformParticleVFXColour(
        { r: 1, g: 0.5, b: 0.25 },
        { kind: "rotate", degrees: -360 },
      ),
    ).toEqual({ r: 1, g: 0.5, b: 0.25 });
    expect(
      transformParticleVFXColour(
        { r: 0.9, g: 0.3, b: 0.5, a: 1 },
        { kind: "desaturate" },
      ),
    ).toEqual({ r: 0.6, g: 0.6, b: 0.6, a: 1 });
    // A grey colour has no hue to move.
    expect(
      transformParticleVFXColour(
        { r: 0.4, g: 0.4, b: 0.4 },
        { kind: "rotate", degrees: 90 },
      ),
    ).toEqual({ r: 0.4, g: 0.4, b: 0.4 });
  });

  it("keeps editor colours at four decimals, with no float noise", () => {
    for (let step = -170; step <= 180; step += 10)
      for (const colour of [
        { r: 0.1, g: 0.8, b: 0.5 },
        { r: 0.7088, g: 0.727, b: 0.7579 },
        { r: 1, g: 0.55, b: 0.8 },
      ]) {
        const turned = transformParticleVFXColour(colour, {
          kind: "rotate",
          degrees: step,
        });
        for (const channel of [turned.r, turned.g, turned.b])
          expect(Number(channel.toFixed(4))).toBe(channel);
      }
  });

  it("samples a texture down by averaging in premultiplied alpha", () => {
    // 4×2: a red opaque pixel beside a transparent blue one in each cell.
    const image = {
      width: 4,
      height: 2,
      data: new Uint8ClampedArray(
        Array.from({ length: 8 }, (_, index) =>
          index % 2 ? [0, 0, 255, 0] : [255, 0, 0, 255],
        ).flat(),
      ),
    };
    const sample = sampleParticleVFXPixels(image, 2);
    expect(sample).toMatchObject({ width: 2, height: 1 });
    // The transparent blue adds no colour, only coverage.
    expect([...sample.data]).toEqual([255, 0, 0, 128, 255, 0, 0, 128]);
    expect(sampleParticleVFXPixels(image, 8).data).toEqual(image.data);
  });

  it("bleeds edge colour into transparent pixels a few pixels deep, keeping alpha", () => {
    // A 12×1 row: one opaque red pixel, then transparent black.
    const data = new Uint8ClampedArray(12 * 4);
    data.set([200, 40, 60, 255], 0);
    bleedParticleVFXEdges({ width: 12, height: 1, data });
    for (let x = 1; x <= 8; x += 1)
      expect([...data.slice(x * 4, x * 4 + 4)]).toEqual([200, 40, 60, 0]);
    // Beyond eight passes the colour is left at zero.
    expect([...data.slice(9 * 4, 9 * 4 + 4)]).toEqual([0, 0, 0, 0]);
  });

  it("measures how coloured a texture's visible pixels are", () => {
    // Half the alpha weight is fully saturated red, half is grey.
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 128, 128, 128, 255, 0, 255, 0, 0,
    ]);
    expect(particleVFXPixelChroma(pixels)).toBeCloseTo(0.5, 6);
    expect(particleVFXPixelChroma(new Uint8ClampedArray([9, 9, 9, 0]))).toBe(0);
  });

  it("reads hue and chroma, and no hue for grey", () => {
    expect(particleVFXHue(1, 0, 0)).toEqual({ hue: 0, chroma: 1 });
    expect(particleVFXHue(0, 0.5, 1).hue).toBeCloseTo(210, 6);
    expect(particleVFXHue(0.3, 0.3, 0.3)).toEqual({ hue: null, chroma: 0 });
  });
});
