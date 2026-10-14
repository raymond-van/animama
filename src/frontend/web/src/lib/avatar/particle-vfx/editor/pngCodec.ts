/**
 * A small PNG decoder and encoder for the colour theme's texture copies.
 *
 * Particle art keeps its edge colour in fully transparent pixels ("bled"
 * edges, see `scripts/effect-assets.mjs`), so mipmapped filtering at the
 * art's edge shows no dark fringe. A canvas stores colour premultiplied, which
 * zeroes that colour and quantizes faint pixels, so PNGs are decoded and
 * encoded here instead, as straight RGBA. It needs only the Compression
 * Streams API (`deflate` is the zlib stream PNG uses), which browsers,
 * workers and Node 18+ provide. Imports nothing, so the texture worker can
 * use it.
 *
 * The decoder reads 8-bit, non-interlaced grey, RGB, palette, grey-alpha and
 * RGBA images, which is what the creator's textures are; it returns null for
 * any other PNG and for files that are not PNG, which the caller decodes on
 * a canvas. The encoder writes 8-bit RGBA.
 */

/** Straight (unpremultiplied) 8-bit RGBA pixels, row by row. */
export type ParticleVFXRgbaImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/**
 * A decoded PNG, with its colour-space chunks (`gAMA`, `cHRM`, `sRGB`,
 * `iCCP`, each as whole chunk bytes) so a recoloured copy displays the same.
 */
export type ParticleVFXDecodedPng = ParticleVFXRgbaImage & {
  colourChunks: readonly Uint8Array[];
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOUR_CHUNKS = new Set(["gAMA", "cHRM", "sRGB", "iCCP"]);
/** Samples per pixel for each supported colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG this decoder could not read: corrupt or inconsistent data that a
 * browser's more tolerant decoder may still accept.
 */
export class ParticleVFXCorruptPng extends Error {
  constructor() {
    super("The image could not be decoded.");
  }
}

/**
 * Decode a PNG to straight RGBA, keeping the colour of transparent pixels.
 * Null when the file is not a PNG this decoder reads (interlaced, not 8-bit,
 * or not PNG at all). Rejects a corrupt PNG, one over `maxPixels`, and image
 * data that inflates past the size its header declares.
 */
export async function decodeParticleVFXPng(
  bytes: Uint8Array,
  { maxPixels }: { maxPixels: number },
): Promise<ParticleVFXDecodedPng | null> {
  if (
    bytes.length < SIGNATURE.length ||
    SIGNATURE.some((value, index) => bytes[index] !== value)
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: {
    width: number;
    height: number;
    bitDepth: number;
    colourType: number;
    interlace: number;
  } | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  const colourChunks: Uint8Array[] = [];
  let ended = false;
  for (let offset = SIGNATURE.length; !ended; ) {
    if (offset + 12 > bytes.length) throw new ParticleVFXCorruptPng();
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new ParticleVFXCorruptPng();
    const body = bytes.subarray(start, end);
    if (type === "IHDR") {
      if (length !== 13) throw new ParticleVFXCorruptPng();
      header = {
        width: view.getUint32(start),
        height: view.getUint32(start + 4),
        bitDepth: body[8]!,
        colourType: body[9]!,
        interlace: body[12]!,
      };
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") ended = true;
    else if (COLOUR_CHUNKS.has(type))
      colourChunks.push(bytes.slice(offset, end + 4));
    offset = end + 4;
  }
  if (!header || header.width < 1 || header.height < 1)
    throw new ParticleVFXCorruptPng();
  const { width, height, bitDepth, colourType, interlace } = header;
  const channels = CHANNELS[colourType];
  if (bitDepth !== 8 || interlace !== 0 || !channels) return null;
  if (width * height > maxPixels)
    throw new Error("The image is too large to recolour.");
  const stride = width * channels;
  const filtered = await inflate(concat(idat), height * (stride + 1));
  const samples = unfilter(filtered, width, height, channels);
  return {
    width,
    height,
    data: toRgba(samples, width * height, colourType, palette, transparency),
    colourChunks,
  };
}

/**
 * Encode straight RGBA as an 8-bit RGBA PNG, choosing each row's filter by
 * the smallest sum of filtered bytes (the usual heuristic), and writing
 * `colourChunks` (whole chunks from `decodeParticleVFXPng`) before the data.
 */
export async function encodeParticleVFXPng(
  image: ParticleVFXRgbaImage,
  colourChunks: readonly Uint8Array[] = [],
): Promise<Uint8Array> {
  const { width, height, data } = image;
  const stride = width * 4;
  const filtered = new Uint8Array(height * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const empty = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const above = y ? data.subarray((y - 1) * stride, y * stride) : empty;
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      const out = candidates[filter]!;
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 4 ? row[x - 4]! : 0;
        const up = above[x]!;
        const value =
          (row[x]! -
            (filter === 0
              ? 0
              : filter === 1
                ? left
                : filter === 2
                  ? up
                  : filter === 3
                    ? (left + up) >> 1
                    : paeth(left, up, x >= 4 ? above[x - 4]! : 0))) &
          0xff;
        out[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    filtered[y * (stride + 1)] = best;
    filtered.set(candidates[best]!, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return concat([
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    ...colourChunks,
    chunk("IDAT", await deflate(filtered)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Inflate zlib data that must come to exactly `expected` bytes. */
async function inflate(
  data: Uint8Array,
  expected: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(expected);
  let length = 0;
  try {
    const reader = new Blob([data as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // More data than the header declares: stop rather than grow.
      if (length + value.length > expected) {
        await reader.cancel();
        throw new ParticleVFXCorruptPng();
      }
      out.set(value, length);
      length += value.length;
    }
  } catch {
    throw new ParticleVFXCorruptPng();
  }
  if (length !== expected) throw new ParticleVFXCorruptPng();
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Blob([data as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
}

/** Reverse each row's PNG filter; `channels` bytes make one pixel. */
function unfilter(
  filtered: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)];
    const line = filtered.subarray(
      y * (stride + 1) + 1,
      (y + 1) * (stride + 1),
    );
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[row + x - channels]! : 0;
      const up = y ? out[above + x]! : 0;
      const upLeft = y && x >= channels ? out[above + x - channels]! : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4:
          predictor = paeth(left, up, upLeft);
          break;
        default:
          throw new ParticleVFXCorruptPng();
      }
      out[row + x] = (line[x]! + predictor) & 0xff;
    }
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Expand unfiltered samples of one colour type to RGBA. */
function toRgba(
  samples: Uint8Array,
  pixels: number,
  colourType: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): Uint8ClampedArray {
  if (colourType === 6) return new Uint8ClampedArray(samples);
  const rgba = new Uint8ClampedArray(pixels * 4);
  // A grey or RGB image's tRNS names one 16-bit colour as transparent.
  const key = (index: number) =>
    transparency && transparency.length >= index * 2 + 2
      ? transparency[index * 2 + 1]!
      : -1;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colourType === 0) {
      r = g = b = samples[pixel]!;
      if (r === key(0)) a = 0;
    } else if (colourType === 4) {
      r = g = b = samples[pixel * 2]!;
      a = samples[pixel * 2 + 1]!;
    } else if (colourType === 2) {
      r = samples[pixel * 3]!;
      g = samples[pixel * 3 + 1]!;
      b = samples[pixel * 3 + 2]!;
      if (r === key(0) && g === key(1) && b === key(2)) a = 0;
    } else {
      const index = samples[pixel]!;
      if (!palette || index * 3 + 2 >= palette.length)
        throw new ParticleVFXCorruptPng();
      r = palette[index * 3]!;
      g = palette[index * 3 + 1]!;
      b = palette[index * 3 + 2]!;
      a =
        transparency && index < transparency.length
          ? transparency[index]!
          : 255;
    }
    rgba[pixel * 4] = r;
    rgba[pixel * 4 + 1] = g;
    rgba[pixel * 4 + 2] = b;
    rgba[pixel * 4 + 3] = a;
  }
  return rgba;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One PNG chunk: length, type, body and the CRC-32 of type and body. */
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1)
    out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
