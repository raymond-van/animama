import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { decodeParticleVFXPng, encodeParticleVFXPng } from "./pngCodec";

const PARTICLE_CONTENT = fileURLToPath(
  new URL(
    "../../../../../../../../content/included/vfx/particle/",
    import.meta.url,
  ),
);
const LIMIT = { maxPixels: 2048 * 2048 };

/** Every PNG under the Included Particle content: effects and built-ins. */
function includedPngs(): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) visit(`${dir}/${entry.name}`);
      else if (entry.name.endsWith(".png")) found.push(`${dir}/${entry.name}`);
  };
  visit(PARTICLE_CONTENT);
  return found;
}

/** Straight RGBA as sharp (libvips) decodes it: the independent reference. */
async function sharpRgba(png: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer(),
  );
}

async function raw(
  data: number[],
  width: number,
  channels: 1 | 2 | 3 | 4,
  options: sharp.PngOptions = {},
): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(Buffer.from(data), {
      raw: { width, height: data.length / width / channels, channels },
    })
      .png(options)
      .toBuffer(),
  );
}

/** A coloured RGBA image whose transparent pixels keep colour, as bled art does. */
function bledImage() {
  const width = 37;
  const height = 23;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1)
    data.set(
      [
        (index * 7) % 256,
        (index * 13) % 256,
        (index * 29) % 256,
        index % 3 === 0 ? 0 : (index * 11) % 256,
      ],
      index * 4,
    );
  return { width, height, data };
}

describe("Particle texture PNG codec", () => {
  it(
    "decodes every Included Particle texture exactly as libvips does, transparent colour included",
    { timeout: 60_000 },
    async () => {
      const files = includedPngs();
      expect(files.length).toBeGreaterThan(80);
      let colouredTransparent = 0;
      for (const file of files) {
        const bytes = new Uint8Array(readFileSync(file));
        const decoded = await decodeParticleVFXPng(bytes, LIMIT);
        expect(decoded, file).not.toBeNull();
        expect(
          Buffer.from(decoded!.data).equals(
            Buffer.from(await sharpRgba(bytes)),
          ),
          file,
        ).toBe(true);
        for (let index = 0; index < decoded!.data.length; index += 4)
          if (
            decoded!.data[index + 3] === 0 &&
            (decoded!.data[index] ||
              decoded!.data[index + 1] ||
              decoded!.data[index + 2])
          )
            colouredTransparent += 1;
      }
      // The art keeps edge colour in its transparent pixels.
      expect(colouredTransparent).toBeGreaterThan(10_000);
    },
  );

  it("round-trips straight RGBA losslessly, keeping the colour of transparent pixels", async () => {
    const image = bledImage();
    const png = await encodeParticleVFXPng(image);
    const decoded = await decodeParticleVFXPng(png, LIMIT);
    expect(decoded).toMatchObject({ width: image.width, height: image.height });
    expect(decoded!.data).toEqual(image.data);
    // libvips reads the encoder's output the same way.
    expect(new Uint8ClampedArray(await sharpRgba(png))).toEqual(image.data);
  });

  it("keeps the source's colour-space chunks", async () => {
    const source = includedPngs()
      .map((file) => new Uint8Array(readFileSync(file)))
      .find((bytes) => Buffer.from(bytes).includes("gAMA"))!;
    const decoded = (await decodeParticleVFXPng(source, LIMIT))!;
    expect(
      decoded.colourChunks.map((chunk) =>
        Buffer.from(chunk.subarray(4, 8)).toString(),
      ),
    ).toEqual(["gAMA"]);
    const png = await encodeParticleVFXPng(decoded, decoded.colourChunks);
    expect(Buffer.from(png).includes("gAMA")).toBe(true);
    expect((await decodeParticleVFXPng(png, LIMIT))!.data).toEqual(
      decoded.data,
    );
  });

  it("expands grey, grey-alpha, RGB and palette pixels to RGBA", async () => {
    const grey = await decodeParticleVFXPng(
      await raw([0, 128, 255, 7], 2, 1),
      LIMIT,
    );
    expect([...grey!.data]).toEqual([
      0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 7, 7, 7, 255,
    ]);
    const greyAlpha = await decodeParticleVFXPng(
      await raw([9, 0, 200, 77], 2, 2),
      LIMIT,
    );
    expect([...greyAlpha!.data]).toEqual([9, 9, 9, 0, 200, 200, 200, 77]);
    const rgb = await decodeParticleVFXPng(
      await raw([1, 2, 3, 250, 251, 252], 2, 3),
      LIMIT,
    );
    expect([...rgb!.data]).toEqual([1, 2, 3, 255, 250, 251, 252, 255]);
    const palettePng = await raw([255, 0, 0, 255, 0, 0, 255, 128], 2, 4, {
      palette: true,
    });
    expect([...(await decodeParticleVFXPng(palettePng, LIMIT))!.data]).toEqual([
      ...(await sharpRgba(palettePng)),
    ]);
  });

  it("leaves interlaced, 16-bit and non-PNG files to the canvas", async () => {
    const interlaced = await raw([1, 2, 3, 4, 5, 6, 7, 8], 2, 4, {
      progressive: true,
    });
    expect(await decodeParticleVFXPng(interlaced, LIMIT)).toBeNull();
    const sixteen = new Uint8Array(
      await sharp(Buffer.from([1, 2, 3, 4, 5, 6]), {
        raw: { width: 2, height: 1, channels: 3 },
      })
        .toColourspace("rgb16")
        .png()
        .toBuffer(),
    );
    expect(await decodeParticleVFXPng(sixteen, LIMIT)).toBeNull();
    const jpeg = new Uint8Array(
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#f00" },
      })
        .jpeg()
        .toBuffer(),
    );
    expect(await decodeParticleVFXPng(jpeg, LIMIT)).toBeNull();
  });

  it("refuses a PNG over the pixel limit, or whose data inflates past its size", async () => {
    const image = bledImage();
    const png = await encodeParticleVFXPng(image);
    await expect(
      decodeParticleVFXPng(png, { maxPixels: image.width * image.height - 1 }),
    ).rejects.toThrow("too large");

    // Declare a 1×1 image but keep the whole image's data.
    const lying = png.slice();
    new DataView(lying.buffer).setUint32(16, 1);
    new DataView(lying.buffer).setUint32(20, 1);
    await expect(decodeParticleVFXPng(lying, LIMIT)).rejects.toThrow(
      "could not be decoded",
    );
    await expect(
      decodeParticleVFXPng(png.slice(0, png.length - 30), LIMIT),
    ).rejects.toThrow("could not be decoded");
  });
});
