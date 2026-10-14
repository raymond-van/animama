import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { particleVFXHue } from "./colourPixels";
import {
  ParticleVFXTextureSurfaceUnavailable,
  recolourParticleVFXTexture,
  sampleParticleVFXTexture,
} from "./textureRecolour";

function texture(path: string): Blob {
  return new Blob(
    [
      new Uint8Array(
        readFileSync(
          fileURLToPath(
            new URL(
              `../../../../../../../../content/included/vfx/particle/${path}`,
              import.meta.url,
            ),
          ),
        ),
      ),
    ],
    { type: "image/png" },
  );
}

/** Straight RGBA as libvips decodes it, independently of the codec. */
async function pixels(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(Buffer.from(await blob.arrayBuffer()))
      .ensureAlpha()
      .raw()
      .toBuffer(),
  );
}

function hueDistance(from: number, to: number): number {
  return Math.abs(((to - from + 540) % 360) - 180);
}

describe("recolouring a Particle texture", { timeout: 30_000 }, () => {
  const heart = texture("quark/heart-burst/textures/glossy-heart.png");

  it("is lossless when the hue does not move, transparent colour included", async () => {
    const copy = await recolourParticleVFXTexture(heart, {
      kind: "rotate",
      degrees: 360,
    });
    expect(
      Buffer.from(await pixels(copy)).equals(Buffer.from(await pixels(heart))),
    ).toBe(true);
  });

  it("recolours the edge colour bled into transparent pixels and keeps every alpha", async () => {
    const before = await pixels(heart);
    const after = await pixels(
      await recolourParticleVFXTexture(heart, {
        kind: "rotate",
        degrees: -140,
      }),
    );
    let transparentColoured = 0;
    for (let index = 0; index < before.length; index += 4) {
      expect(after[index + 3]).toBe(before[index + 3]);
      if (before[index + 3] !== 0) continue;
      const original = particleVFXHue(
        before[index]! / 255,
        before[index + 1]! / 255,
        before[index + 2]! / 255,
      );
      if (original.chroma < 0.2) continue;
      transparentColoured += 1;
      const moved = particleVFXHue(
        after[index]! / 255,
        after[index + 1]! / 255,
        after[index + 2]! / 255,
      );
      // The colour is still there, with its hue moved like the art's.
      expect(moved.chroma).toBeCloseTo(original.chroma, 2);
      expect(hueDistance(original.hue! - 140, moved.hue!)).toBeLessThan(2);
    }
    expect(transparentColoured).toBeGreaterThan(10_000);
  });

  it("samples without a canvas, at most 128 px on the longer side", async () => {
    const sheet = await sampleParticleVFXTexture(
      texture("quark/fume-puffs/textures/ear-jet-sheet.png"),
    );
    expect([sheet.width, sheet.height]).toEqual([128, 64]);
    const small = await sampleParticleVFXTexture(
      texture("quark/rage-aura/textures/ember-spark.png"),
    );
    expect([small.width, small.height]).toEqual([128, 62]);
  });

  it("keeps a palette PNG's gamma and decodes other formats on a canvas", async () => {
    const palette = texture("particle-vfx/textures/heart-v2.png");
    const { width, height } = await sharp(
      Buffer.from(await palette.arrayBuffer()),
    ).metadata();
    const copy = await recolourParticleVFXTexture(palette, {
      kind: "desaturate",
    });
    expect(Buffer.from(await copy.arrayBuffer()).includes("gAMA")).toBe(true);
    expect(
      await sharp(Buffer.from(await copy.arrayBuffer())).metadata(),
    ).toMatchObject({
      width,
      height,
      hasAlpha: true,
    });

    const jpeg = new Blob(
      [
        new Uint8Array(
          await sharp({
            create: { width: 4, height: 4, channels: 3, background: "#f00" },
          })
            .jpeg()
            .toBuffer(),
        ),
      ],
      { type: "image/jpeg" },
    );
    // Node has no canvas; the browser decodes these on one.
    await expect(
      recolourParticleVFXTexture(jpeg, { kind: "desaturate" }),
    ).rejects.toBeInstanceOf(ParticleVFXTextureSurfaceUnavailable);
  });

  it("hands a PNG the strict decoder rejects to the canvas, which browsers read", async () => {
    const png = new Uint8Array(
      await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    // Append junk to the image data: browsers ignore it, this decoder refuses.
    const idat = Buffer.from(png).indexOf("IDAT") - 4;
    const length = new DataView(png.buffer).getUint32(idat);
    const junk = new Uint8Array([1, 2, 3, 4]);
    const tampered = new Uint8Array(png.length + junk.length);
    tampered.set(png.subarray(0, idat + 8 + length));
    tampered.set(junk, idat + 8 + length);
    tampered.set(
      png.subarray(idat + 8 + length),
      idat + 8 + length + junk.length,
    );
    new DataView(tampered.buffer).setUint32(idat, length + junk.length);

    await expect(
      recolourParticleVFXTexture(new Blob([tampered], { type: "image/png" }), {
        kind: "desaturate",
      }),
    ).rejects.toBeInstanceOf(ParticleVFXTextureSurfaceUnavailable);
  });
});
