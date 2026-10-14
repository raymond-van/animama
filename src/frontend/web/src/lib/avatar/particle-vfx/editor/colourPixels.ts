/**
 * Colour math for the Particle colour theme (decision P-COLOUR), shared by
 * the editor and the texture worker, so it imports nothing.
 *
 * A theme changes colours in HSL space: rotating the hue keeps each colour's
 * lightness and saturation, and White desaturates to the same lightness.
 * Rotating an HSL hue never changes a colour's largest and smallest channel,
 * only which channel holds them and the middle one, so 8-bit pixels keep
 * their lightness and chroma exactly and alpha is never touched. It also
 * samples textures for colour measurement and restores bled edges.
 */

/** How a colour theme changes one colour. */
export type ParticleVFXColourTransform =
  | {
      /** Rotate the hue by `degrees` (positive is red towards yellow). */
      kind: "rotate";
      degrees: number;
    }
  | {
      /** Remove the hue, keeping lightness (the White theme). */
      kind: "desaturate";
    };

/** A texture's RGBA pixels, row by row, 8 bits a channel. */
export type ParticleVFXTextureSample = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/**
 * The hue (degrees, 0 ≤ hue < 360) and chroma (largest minus smallest
 * channel) of a colour with channels in 0–1. A grey colour has no hue.
 */
export function particleVFXHue(
  r: number,
  g: number,
  b: number,
): { hue: number | null; chroma: number } {
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma <= 0) return { hue: null, chroma: 0 };
  return { hue: sextant(r, g, b, max, chroma) * 60, chroma };
}

/**
 * Recolour one colour with channels in 0–1. Alpha and any other field are
 * kept; channels are rounded to the editor's four decimals.
 */
export function transformParticleVFXColour<
  T extends { r: number; g: number; b: number },
>(colour: T, transform: ParticleVFXColourTransform): T {
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const [r, g, b] = transformChannels(
    colour.r,
    colour.g,
    colour.b,
    transform,
    (value) => value,
  ).map(round) as [number, number, number];
  return { ...colour, r, g, b };
}

/**
 * Recolour 8-bit RGBA pixels in place, keeping alpha. Fully transparent
 * pixels are recoloured too: art keeps its edge colour there ("bled"
 * edges), and filtering blends it in at the art's edge.
 */
export function recolourParticleVFXPixels(
  data: Uint8ClampedArray | Uint8Array,
  transform: ParticleVFXColourTransform,
): void {
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = transformChannels(
      data[index]!,
      data[index + 1]!,
      data[index + 2]!,
      transform,
      Math.round,
    );
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
  }
}

/**
 * The image scaled down to at most `maxSide` pixels on its longer side, each
 * pixel the average of the block it covers in premultiplied alpha (so a
 * transparent pixel adds coverage but no colour). An image that already fits
 * is returned as it is.
 */
export function sampleParticleVFXPixels(
  image: ParticleVFXTextureSample,
  maxSide: number,
): ParticleVFXTextureSample {
  const { width, height, data } = image;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (scale === 1) return image;
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  // Per sample pixel: premultiplied red, green, blue, alpha and a count.
  const sums = new Float64Array(sampleWidth * sampleHeight * 5);
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor((y * sampleHeight) / height) * sampleWidth;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = (row + Math.floor((x * sampleWidth) / width)) * 5;
      const alpha = data[source + 3]!;
      sums[target] += data[source]! * alpha;
      sums[target + 1] += data[source + 1]! * alpha;
      sums[target + 2] += data[source + 2]! * alpha;
      sums[target + 3] += alpha;
      sums[target + 4] += 1;
    }
  }
  const sample = new Uint8ClampedArray(sampleWidth * sampleHeight * 4);
  for (let pixel = 0; pixel < sampleWidth * sampleHeight; pixel += 1) {
    const alpha = sums[pixel * 5 + 3]!;
    const count = sums[pixel * 5 + 4]!;
    for (let channel = 0; channel < 3; channel += 1)
      sample[pixel * 4 + channel] = alpha
        ? Math.round(sums[pixel * 5 + channel]! / alpha)
        : 0;
    sample[pixel * 4 + 3] = count ? Math.round(alpha / count) : 0;
  }
  return { width: sampleWidth, height: sampleHeight, data: sample };
}

/** How many pixels deep `bleedParticleVFXEdges` reaches, as `effects:assets fix` does. */
const BLEED_PASSES = 8;

/**
 * Give fully transparent pixels the average colour of their visible
 * neighbours, up to eight pixels deep, in place; their alpha stays 0. This
 * restores the bled edges of art decoded on a canvas, which keeps no colour
 * in transparent pixels (the same rule as `effects:assets fix`).
 */
export function bleedParticleVFXEdges(image: ParticleVFXTextureSample): void {
  const { width, height, data } = image;
  const filled = new Uint8Array(width * height);
  for (let index = 0; index < filled.length; index += 1)
    filled[index] = data[index * 4 + 3]! > 0 ? 1 : 0;
  for (let pass = 0; pass < BLEED_PASSES; pass += 1) {
    const updates: [number, number, number, number][] = [];
    for (let index = 0; index < filled.length; index += 1) {
      if (filled[index]) continue;
      const x = index % width;
      const y = (index - x) / width;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!filled[next]) continue;
          r += data[next * 4]!;
          g += data[next * 4 + 1]!;
          b += data[next * 4 + 2]!;
          count += 1;
        }
      if (count)
        updates.push([
          index,
          Math.round(r / count),
          Math.round(g / count),
          Math.round(b / count),
        ]);
    }
    if (!updates.length) break;
    for (const [index, r, g, b] of updates) {
      data[index * 4] = r;
      data[index * 4 + 1] = g;
      data[index * 4 + 2] = b;
      filled[index] = 1;
    }
  }
  for (let index = 0; index < filled.length; index += 1)
    if (!filled[index]) data.fill(0, index * 4, index * 4 + 3);
}

/**
 * How coloured an image is: the mean chroma (0–1) of its pixels, weighted by
 * alpha. A fully transparent image measures 0.
 */
export function particleVFXPixelChroma(
  data: Uint8ClampedArray | Uint8Array,
): number {
  let weight = 0;
  let chroma = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]!;
    if (alpha === 0) continue;
    const r = data[index]!;
    const g = data[index + 1]!;
    const b = data[index + 2]!;
    weight += alpha;
    chroma += alpha * (Math.max(r, g, b) - Math.min(r, g, b));
  }
  return weight ? chroma / weight / 255 : 0;
}

/**
 * Apply `transform` to three channels on any scale (0–1 or 0–255); `round`
 * snaps the changed middle channel (and White's grey) to that scale's grid.
 */
function transformChannels(
  r: number,
  g: number,
  b: number,
  transform: ParticleVFXColourTransform,
  round: (value: number) => number,
): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma <= 0) return [r, g, b];
  if (transform.kind === "desaturate") {
    const grey = round((max + min) / 2);
    return [grey, grey, grey];
  }
  // The hue in sixths of a turn, rotated and wrapped into [0, 6).
  const turned =
    (((sextant(r, g, b, max, chroma) + transform.degrees / 60) % 6) + 6) % 6;
  // The middle channel's distance above the smallest one.
  const middle = min + round(chroma * (1 - Math.abs((turned % 2) - 1)));
  switch (Math.floor(turned)) {
    case 0:
      return [max, middle, min];
    case 1:
      return [middle, max, min];
    case 2:
      return [min, max, middle];
    case 3:
      return [min, middle, max];
    case 4:
      return [middle, min, max];
    default:
      return [max, min, middle];
  }
}

/** A colour's hue in sixths of a turn, 0 ≤ hue < 6; `chroma` must be > 0. */
function sextant(
  r: number,
  g: number,
  b: number,
  max: number,
  chroma: number,
): number {
  if (max === r) return ((((g - b) / chroma) % 6) + 6) % 6;
  if (max === g) return (b - r) / chroma + 2;
  return (r - g) / chroma + 4;
}
