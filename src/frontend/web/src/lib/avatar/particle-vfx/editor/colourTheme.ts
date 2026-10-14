/**
 * The Particle colour theme (decision P-COLOUR): Simple mode's swatches
 * recolour the whole effect, its texture art and its emitter colours
 * together, by one hue step, so their relationships are kept.
 *
 * The step moves the effect's dominant hue onto the swatch's target hue.
 * The dominant hue is what the effect shows: each layer's texture pixels
 * tinted by that layer's mean colour (start colour times Color Over Life),
 * weighted by chroma and alpha, so a coloured flame texture under a white
 * tint and a grey heart under a red tint both count. Tinting is a product,
 * so the hue the themed effect shows can miss the target by a few degrees
 * (up to 11° on the Included effects); the step is corrected by measuring
 * the themed result. White desaturates instead. Original is the reference
 * itself.
 *
 * This module is pure. `setParticleVFXColourTheme` (in `simpleControls.ts`)
 * decodes and recolours the textures through a codec.
 */
import {
  particleVFXHue,
  particleVFXPixelChroma,
  recolourParticleVFXPixels,
  transformParticleVFXColour,
  type ParticleVFXColourTransform,
  type ParticleVFXTextureSample,
} from "./colourPixels";
import { cloneJsonObject, readJsonArrayObjects, readJsonObject } from "./json";
import { readFiniteNumber } from "./numbers";
import {
  isBuiltInParticleVFXTextureReference,
  particleVFXTextureStem,
} from "./textureFiles";
import { readEmitterTexture } from "./textures";
import type {
  JsonObject,
  ParticleVFXColourThemeId,
  ParticleVFXEditorColor,
  ParticleVFXSimpleTheme,
} from "./types";

export type {
  ParticleVFXColourTransform,
  ParticleVFXTextureSample,
} from "./colourPixels";

/**
 * The swatches, in the order Simple shows them, with each colour theme's
 * target hue (HSL degrees): Rose a pink red, Gold a warm yellow, Mint a cool
 * green, Sky a light blue and Violet a blue purple. Original and White have
 * no target hue.
 */
export const PARTICLE_VFX_COLOUR_THEMES: readonly {
  id: ParticleVFXColourThemeId;
  label: string;
  hue: number | null;
}[] = [
  { id: "original", label: "Original", hue: null },
  { id: "rose", label: "Rose", hue: 340 },
  { id: "gold", label: "Gold", hue: 45 },
  { id: "mint", label: "Mint", hue: 150 },
  { id: "sky", label: "Sky", hue: 200 },
  { id: "violet", label: "Violet", hue: 275 },
  { id: "white", label: "White", hue: null },
];

const THEME_IDS = new Set(PARTICLE_VFX_COLOUR_THEMES.map(({ id }) => id));

/** Whether `value` names a colour theme. */
export function isParticleVFXColourThemeId(
  value: unknown,
): value is ParticleVFXColourThemeId {
  return THEME_IDS.has(value as ParticleVFXColourThemeId);
}

/**
 * A texture is recoloured only when the mean chroma of its visible pixels
 * is at least this; nearer grey, it shows the emitter colours that tint it,
 * which the theme changes anyway. (The Included textures are either below
 * 2 % or above 8 %.)
 */
export const PARTICLE_VFX_THEME_GREY_CHROMA = 0.05;

/**
 * Below this total weight (the layers' mean chroma times alpha, summed) an
 * effect shows no colour a hue step could move.
 */
const MIN_COLOUR_WEIGHT = 0.002;

/** How far around the dominant hue's peak the weights are gathered. */
const PEAK_HALF_WIDTH = 15;
const REFINE_HALF_WIDTH = 30;

/** One layer's colour: the texture it draws and the mean colour tinting it. */
type ParticleVFXColourSource = {
  textureUrl: string | null;
  tint: ParticleVFXEditorColor;
};

/** Every emitter's texture and mean tint, the root included, in tree order. */
function particleVFXColourSources(
  quarksJson: JsonObject,
): ParticleVFXColourSource[] {
  const sources: ParticleVFXColourSource[] = [];
  const visit = (node: JsonObject) => {
    const ps = readJsonObject(node.ps);
    if (node.type === "ParticleEmitter" && ps) {
      const start = meanGeneratorColour(ps.startColor);
      const overLife = meanGeneratorColour(
        readJsonArrayObjects(ps.behaviors).find(
          (behavior) => behavior.type === "ColorOverLife",
        )?.color,
      );
      sources.push({
        textureUrl: readEmitterTexture(quarksJson, ps)?.url ?? null,
        tint: {
          r: start.r * overLife.r,
          g: start.g * overLife.g,
          b: start.b * overLife.b,
          a: start.a * overLife.a,
        },
      });
    }
    readJsonArrayObjects(node.children).forEach(visit);
  };
  const root = readJsonObject(quarksJson.object);
  if (root) visit(root);
  return sources;
}

const WHITE_PIXEL = new Uint8ClampedArray([255, 255, 255, 255]);

/**
 * The hue (degrees) the effect mostly shows, or null when it shows almost no
 * colour. Each layer adds its texture pixels times its tint to a hue
 * histogram, weighted by chroma and alpha and averaged over the texture, so
 * a layer counts by how much colour one of its particles shows. The peak of
 * the histogram, smoothed over ±15°, is refined to the weighted mean hue
 * within ±30° of it. A layer without texture pixels counts as its tint.
 */
export function particleVFXDominantHue(
  layers: readonly {
    sample: ParticleVFXTextureSample | null;
    tint: ParticleVFXEditorColor;
  }[],
): number | null {
  const bins = new Float64Array(360);
  let total = 0;
  for (const { sample, tint } of layers) {
    const data = sample?.data ?? WHITE_PIXEL;
    const pixels = data.length / 4;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = (data[index + 3]! / 255) * tint.a;
      if (alpha <= 0) continue;
      const { hue, chroma } = particleVFXHue(
        (data[index]! / 255) * tint.r,
        (data[index + 1]! / 255) * tint.g,
        (data[index + 2]! / 255) * tint.b,
      );
      if (hue === null) continue;
      const weight = (chroma * alpha) / pixels;
      bins[Math.floor(hue) % 360] += weight;
      total += weight;
    }
  }
  if (total < MIN_COLOUR_WEIGHT) return null;

  const bin = (hue: number) => bins[((hue % 360) + 360) % 360]!;
  let peak = 0;
  let best = -1;
  for (let hue = 0; hue < 360; hue += 1) {
    let sum = 0;
    for (let offset = -PEAK_HALF_WIDTH; offset <= PEAK_HALF_WIDTH; offset += 1)
      sum += bin(hue + offset);
    if (sum > best) {
      best = sum;
      peak = hue;
    }
  }
  let x = 0;
  let y = 0;
  for (
    let offset = -REFINE_HALF_WIDTH;
    offset <= REFINE_HALF_WIDTH;
    offset += 1
  ) {
    const angle = ((peak + offset + 0.5) * Math.PI) / 180;
    x += bin(peak + offset) * Math.cos(angle);
    y += bin(peak + offset) * Math.sin(angle);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Whether a texture sample is coloured enough for a theme to recolour. */
export function isParticleVFXThemeColouredTexture(
  sample: ParticleVFXTextureSample,
): boolean {
  return particleVFXPixelChroma(sample.data) >= PARTICLE_VFX_THEME_GREY_CHROMA;
}

/**
 * The dominant hue of an effect as `transform` would theme it (as it is when
 * omitted): its emitter colours transformed, and each texture sample (by
 * image path) transformed unless near grey, as the theme leaves those. A
 * texture without a sample counts as its layer's tint.
 */
export function particleVFXEffectHue(
  quarksJson: JsonObject,
  samples: ReadonlyMap<string, ParticleVFXTextureSample>,
  transform?: ParticleVFXColourTransform,
): number | null {
  let json = quarksJson;
  let shown = samples;
  if (transform && !isIdentityParticleVFXColourTransform(transform)) {
    json = cloneJsonObject(quarksJson);
    recolourParticleVFXEffectColours(json, transform);
    shown = new Map(
      [...samples].map(([path, sample]) => {
        if (!isParticleVFXThemeColouredTexture(sample)) return [path, sample];
        const data = sample.data.slice();
        recolourParticleVFXPixels(data, transform);
        return [path, { ...sample, data }];
      }),
    );
  }
  return particleVFXDominantHue(
    particleVFXColourSources(json).map((layer) => ({
      sample: (layer.textureUrl && shown.get(layer.textureUrl)) || null,
      tint: layer.tint,
    })),
  );
}

/** The signed step (−180 ≤ step < 180) from hue `from` to hue `to`. */
function hueStep(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Correction passes after the first step; each costs one measurement. */
const STEP_CORRECTIONS = 2;
/** Whole degrees tried either side of the corrected step. */
const STEP_SEARCH = 3;

/**
 * What a theme does to every colour of an effect: White desaturates; a
 * colour theme rotates every hue by the whole-degree step (−180 to 179) that
 * moves the effect's dominant hue (`particleVFXEffectHue`, from its Quarks
 * JSON and texture samples by image path) onto the target. The first step
 * is target minus dominant hue; two corrections measure the themed effect
 * and add what it still misses by. The measure is not linear in the step
 * (tints multiply, and the histogram's peak moves in jumps), so the whole
 * degrees within ±3° of the result are measured too and the closest kept.
 * Null when a colour theme finds no dominant hue to move, and for Original,
 * which changes nothing.
 */
export function particleVFXThemeTransform(
  themeId: ParticleVFXColourThemeId,
  quarksJson: JsonObject,
  samples: ReadonlyMap<string, ParticleVFXTextureSample>,
): ParticleVFXColourTransform | null {
  if (themeId === "white") return { kind: "desaturate" };
  const target = PARTICLE_VFX_COLOUR_THEMES.find(
    ({ id }) => id === themeId,
  )?.hue;
  const dominant = particleVFXEffectHue(quarksJson, samples);
  if (target === null || target === undefined || dominant === null) return null;
  /** How far the effect themed by `degrees` shows from the target. */
  const miss = (degrees: number) => {
    const shown = particleVFXEffectHue(quarksJson, samples, {
      kind: "rotate",
      degrees,
    });
    return shown === null ? 0 : hueStep(shown, target);
  };
  let degrees = hueStep(dominant, target);
  for (let pass = 0; pass < STEP_CORRECTIONS; pass += 1) {
    const residual = miss(degrees);
    if (Math.abs(residual) < 0.5) break;
    degrees += residual;
  }
  let best = Math.round(degrees);
  let bestMiss = Math.abs(miss(best));
  for (let offset = -STEP_SEARCH; offset <= STEP_SEARCH; offset += 1) {
    const candidate = Math.round(degrees) + offset;
    const candidateMiss = Math.abs(miss(candidate));
    if (candidateMiss < bestMiss) {
      best = candidate;
      bestMiss = candidateMiss;
    }
  }
  return { kind: "rotate", degrees: hueStep(0, best) };
}

/** Whether a transform leaves every colour as it is. */
export function isIdentityParticleVFXColourTransform(
  transform: ParticleVFXColourTransform,
): boolean {
  return transform.kind === "rotate" && transform.degrees % 360 === 0;
}

/**
 * Recolour every emitter colour of an effect in place: start colours and the
 * colour keys of Color Over Life and Color By Speed (`ConstantColor`,
 * `ColorRange`, `RandomColor`, `Gradient` and `RandomColorBetweenGradient`).
 * Alpha keys are kept.
 */
export function recolourParticleVFXEffectColours(
  quarksJson: JsonObject,
  transform: ParticleVFXColourTransform,
): void {
  // A step of 0 keeps every value exactly, including its last decimal.
  if (isIdentityParticleVFXColourTransform(transform)) return;
  const visit = (node: JsonObject) => {
    const ps = readJsonObject(node.ps);
    if (node.type === "ParticleEmitter" && ps) {
      transformColourGenerator(ps.startColor, transform);
      for (const behavior of readJsonArrayObjects(ps.behaviors))
        if (
          behavior.type === "ColorOverLife" ||
          behavior.type === "ColorBySpeed"
        )
          transformColourGenerator(behavior.color, transform);
    }
    readJsonArrayObjects(node.children).forEach(visit);
  };
  const root = readJsonObject(quarksJson.object);
  if (root) visit(root);
}

/**
 * Apply a theme to an effect's Quarks JSON in place: recolour its emitter
 * colours and point each recoloured texture's image at its copy. A null
 * theme (Original) changes nothing.
 */
export function applyParticleVFXSimpleTheme(
  quarksJson: JsonObject,
  theme: ParticleVFXSimpleTheme | null,
): void {
  if (!theme) return;
  recolourParticleVFXEffectColours(quarksJson, theme.transform);
  for (const image of readJsonArrayObjects(quarksJson.images)) {
    const copy =
      typeof image.url === "string" ? theme.textures[image.url] : undefined;
    if (copy) image.url = copy;
  }
}

const THEME_SUFFIX = new RegExp(
  `-(?:${PARTICLE_VFX_COLOUR_THEMES.map(({ id }) => id).join("|")})(?:-\\d+)?$`,
);

/**
 * The deterministic name of a texture's recoloured copy:
 * `textures/<stem>-<theme>.png`, where the stem drops an earlier theme's
 * suffix (so a reopened Sky effect themed Gold gives `heart-gold.png`, not
 * `heart-sky-gold.png`). A name in `taken` or of a built-in texture gets a
 * number, so no name ever stands for two different images in one draft.
 */
export function particleVFXThemedTextureReference(
  reference: string,
  themeId: ParticleVFXColourThemeId,
  taken: ReadonlySet<string>,
): string {
  const stem =
    particleVFXTextureStem(reference).replace(THEME_SUFFIX, "") || "texture";
  for (let index = 1; ; index += 1) {
    const candidate = `textures/${stem}-${themeId}${index > 1 ? `-${index}` : ""}.png`;
    if (
      !taken.has(candidate) &&
      !isBuiltInParticleVFXTextureReference(candidate)
    )
      return candidate;
  }
}

/** Recolour each colour object a colour generator holds, in place. */
function transformColourGenerator(
  value: unknown,
  transform: ParticleVFXColourTransform,
): void {
  const generator = readJsonObject(value);
  if (!generator) return;
  switch (generator.type) {
    case "ConstantColor":
      transformColourObject(generator.color, transform);
      return;
    case "ColorRange":
    case "RandomColor":
      transformColourObject(generator.a, transform);
      transformColourObject(generator.b, transform);
      return;
    case "Gradient":
      for (const key of readJsonArrayObjects(
        readJsonObject(generator.color)?.keys,
      ))
        transformColourObject(key.value, transform);
      return;
    case "RandomColorBetweenGradient":
      transformColourGenerator(generator.gradient1, transform);
      transformColourGenerator(generator.gradient2, transform);
      return;
  }
}

/** Recolour one `{ r, g, b }` object in place; anything else is left. */
function transformColourObject(
  value: unknown,
  transform: ParticleVFXColourTransform,
): void {
  const colour = readJsonObject(value);
  const r = readFiniteNumber(colour?.r);
  const g = readFiniteNumber(colour?.g);
  const b = readFiniteNumber(colour?.b);
  if (!colour || r === null || g === null || b === null) return;
  Object.assign(colour, transformParticleVFXColour({ r, g, b }, transform));
}

/**
 * A colour generator's mean colour: a constant's colour, a range's midpoint,
 * a gradient's mean colour and alpha keys. Anything else is white.
 */
function meanGeneratorColour(value: unknown): ParticleVFXEditorColor {
  const generator = readJsonObject(value);
  switch (generator?.type) {
    case "ConstantColor":
      return readColour(generator.color);
    case "ColorRange":
    case "RandomColor":
      return mix([readColour(generator.a), readColour(generator.b)]);
    case "Gradient": {
      const colours = readJsonArrayObjects(
        readJsonObject(generator.color)?.keys,
      ).map((key) => readColour(key.value));
      const alphas = readJsonArrayObjects(
        readJsonObject(generator.alpha)?.keys,
      ).flatMap((key) => {
        const alpha = readFiniteNumber(key.value);
        return alpha === null ? [] : [alpha];
      });
      const colour = colours.length ? mix(colours) : WHITE;
      return {
        ...colour,
        a: alphas.length
          ? alphas.reduce((sum, alpha) => sum + alpha, 0) / alphas.length
          : 1,
      };
    }
    case "RandomColorBetweenGradient":
      return mix([
        meanGeneratorColour(generator.gradient1),
        meanGeneratorColour(generator.gradient2),
      ]);
    default:
      return WHITE;
  }
}

const WHITE: ParticleVFXEditorColor = { r: 1, g: 1, b: 1, a: 1 };

function readColour(value: unknown): ParticleVFXEditorColor {
  const colour = readJsonObject(value);
  const channel = (key: string) =>
    Math.min(1, Math.max(0, readFiniteNumber(colour?.[key]) ?? 1));
  return {
    r: channel("r"),
    g: channel("g"),
    b: channel("b"),
    a: channel("a"),
  };
}

function mix(
  colours: readonly ParticleVFXEditorColor[],
): ParticleVFXEditorColor {
  const sum = (key: keyof ParticleVFXEditorColor) =>
    colours.reduce((total, colour) => total + colour[key], 0) / colours.length;
  return { r: sum("r"), g: sum("g"), b: sum("b"), a: sum("a") };
}
