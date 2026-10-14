import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { AVATAR_PARTICLE_VFX_CATALOG } from "../catalog";
import {
  particleVFXHue,
  particleVFXPixelChroma,
  transformParticleVFXColour,
  type ParticleVFXColourTransform,
  type ParticleVFXTextureSample,
} from "./colourPixels";
import {
  PARTICLE_VFX_COLOUR_THEMES,
  PARTICLE_VFX_THEME_GREY_CHROMA,
  particleVFXDominantHue,
  particleVFXEffectHue,
  particleVFXThemeTransform,
  particleVFXThemedTextureReference,
  recolourParticleVFXEffectColours,
} from "./colourTheme";
import { validateParticleVFXContentReadiness } from "./contentReadiness";
import { PARTICLE_VFX_EDITOR_TEXTURES } from "./constants";
import {
  applyParticleVFXEmitterPatch,
  createParticleVFXEditorDraftFromBlank,
  createParticleVFXEditorDraftFromCatalog,
} from "./draft";
import { cloneJsonObject } from "./json";
import { createParticleVFXTextureCodec } from "./particleTextureCodec";
import {
  particleVFXColourThemeId,
  setParticleVFXColourTheme,
  setParticleVFXSimpleControl,
  type ParticleVFXTextureCodec,
} from "./simpleControls";
import {
  particleVFXTextureReferences,
  readParticleVFXTextureFile,
} from "./textureFiles";
import type {
  JsonObject,
  ParticleVFXColourThemeId,
  ParticleVFXEditorDraft,
  ParticleVFXEditorTextureFile,
} from "./types";
import { PARTICLE_TEXTURE_LIMITS } from "@/lib/effects/effectArtLimits";

const CONTENT = new URL(
  "../../../../../../../../content/included/vfx/particle/",
  import.meta.url,
);

function contentBytes(path: string): Buffer {
  return readFileSync(fileURLToPath(new URL(path, CONTENT)));
}

function includedJson(id: string): JsonObject {
  return JSON.parse(
    contentBytes(`quark/${id}/particle.json`).toString("utf8"),
  ) as JsonObject;
}

/** An Included effect as a template draft opens it: its textures are its own. */
async function includedDraft(id: string): Promise<ParticleVFXEditorDraft> {
  const quarksJson = includedJson(id);
  const textureFiles: Record<string, ParticleVFXEditorTextureFile> = {};
  for (const reference of particleVFXTextureReferences(quarksJson)) {
    const read = await readParticleVFXTextureFile(
      new Blob([new Uint8Array(contentBytes(`quark/${id}/${reference}`))], {
        type: "image/png",
      }),
    );
    if (!read.ok) throw new Error(read.message);
    textureFiles[reference] = read.file;
  }
  return {
    ...createParticleVFXEditorDraftFromCatalog(id, quarksJson),
    textureFiles,
  };
}

async function blobBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

async function decode(blob: Blob): Promise<ParticleVFXTextureSample> {
  const { data, info } = await sharp(await blobBuffer(blob))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

/** One codec, as the browser uses it (in Node it works on the main thread). */
const sharedCodec = createParticleVFXTextureCodec();

/** The app's codec, counting the textures it recolours. */
function testCodec(): ParticleVFXTextureCodec & { recoloured: number } {
  const codec = {
    recoloured: 0,
    sample: sharedCodec.sample,
    recolour: (blob: Blob, transform: ParticleVFXColourTransform) => {
      codec.recoloured += 1;
      return sharedCodec.recolour(blob, transform);
    },
  };
  return codec;
}

const BUILT_IN = new Map(
  PARTICLE_VFX_EDITOR_TEXTURES.map((texture) => [
    texture.relativeUrl,
    texture.fileName,
  ]),
);

const builtIns = new Map<string, Blob>();

/**
 * Built-in textures from the Included folder the app serves them from, one
 * Blob per path as the app keeps them.
 */
async function loadBuiltIn(reference: string): Promise<Blob | null> {
  const fileName = BUILT_IN.get(reference);
  if (!fileName) return null;
  if (!builtIns.has(reference))
    builtIns.set(
      reference,
      new Blob(
        [new Uint8Array(contentBytes(`particle-vfx/textures/${fileName}`))],
        { type: "image/png" },
      ),
    );
  return builtIns.get(reference)!;
}

function theme(
  draft: ParticleVFXEditorDraft,
  id: ParticleVFXColourThemeId,
  codec: ParticleVFXTextureCodec = testCodec(),
) {
  return setParticleVFXColourTheme(draft, id, {
    codec,
    loadTexture: loadBuiltIn,
  });
}

async function themed(
  draft: ParticleVFXEditorDraft,
  id: ParticleVFXColourThemeId,
): Promise<ParticleVFXEditorDraft> {
  const result = await theme(draft, id);
  if (!result.ok) throw new Error(result.message);
  return result.draft;
}

/** The dominant hue of a draft's effect, from its own texture bytes. */
async function dominantHue(
  draft: ParticleVFXEditorDraft,
): Promise<number | null> {
  const codec = testCodec();
  const samples = new Map<string, ParticleVFXTextureSample>();
  for (const reference of particleVFXTextureReferences(draft.quarksJson)) {
    const blob =
      draft.textureFiles[reference]?.blob ?? (await loadBuiltIn(reference));
    if (blob) samples.set(reference, await codec.sample(blob));
  }
  return particleVFXEffectHue(draft.quarksJson, samples);
}

function hueDistance(from: number, to: number): number {
  return Math.abs(((to - from + 540) % 360) - 180);
}

/** Every `{ r, g, b }` colour object under a JSON value, with its path. */
function colours(
  value: unknown,
  at = "",
): { path: string; colour: { r: number; g: number; b: number } }[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (
    typeof object.r === "number" &&
    typeof object.g === "number" &&
    typeof object.b === "number"
  )
    return [
      { path: at, colour: object as { r: number; g: number; b: number } },
    ];
  return Object.entries(object).flatMap(([key, child]) =>
    colours(child, `${at}.${key}`),
  );
}

/** The sha256 of each texture an effect uses, by its path. */
function usedTextureHashes(draft: ParticleVFXEditorDraft) {
  return Object.fromEntries(
    particleVFXTextureReferences(draft.quarksJson).map((reference) => [
      reference,
      draft.textureFiles[reference]?.sha256 ?? "built-in",
    ]),
  );
}

describe("colour theme swatches and steps", () => {
  it("offers Original, five hues and White, in order", () => {
    expect(PARTICLE_VFX_COLOUR_THEMES.map(({ id, hue }) => [id, hue])).toEqual([
      ["original", null],
      ["rose", 340],
      ["gold", 45],
      ["mint", 150],
      ["sky", 200],
      ["violet", 275],
      ["white", null],
    ]);
  });

  it("steps the dominant hue the short way onto the target, and White desaturates", () => {
    const blank = createParticleVFXEditorDraftFromBlank();
    /** The blank effect tinted one colour; its texture is near grey. */
    const tinted = (hue: number) =>
      applyParticleVFXEmitterPatch(blank, blank.emitters[0]!.path, {
        startColor: transformParticleVFXColour(
          { r: 1, g: 0, b: 0, a: 1 },
          { kind: "rotate", degrees: hue },
        ),
      }).quarksJson;
    const none = new Map<string, ParticleVFXTextureSample>();

    expect(particleVFXThemeTransform("sky", tinted(340), none)).toEqual({
      kind: "rotate",
      degrees: -140,
    });
    expect(particleVFXThemeTransform("gold", tinted(340), none)).toEqual({
      kind: "rotate",
      degrees: 65,
    });
    expect(particleVFXThemeTransform("rose", tinted(340), none)).toEqual({
      kind: "rotate",
      degrees: 0,
    });
    // Half a turn either way is −180.
    expect(particleVFXThemeTransform("mint", tinted(330), none)).toEqual({
      kind: "rotate",
      degrees: -180,
    });
    expect(particleVFXThemeTransform("white", blank.quarksJson, none)).toEqual({
      kind: "desaturate",
    });
    // The blank effect is white: there is no hue to move.
    expect(
      particleVFXThemeTransform("mint", blank.quarksJson, none),
    ).toBeNull();
    expect(particleVFXThemeTransform("original", tinted(10), none)).toBeNull();
  });
});

describe("the effect's dominant hue", { timeout: 30_000 }, () => {
  const solid = (
    rgba: [number, number, number, number],
    count = 16,
  ): ParticleVFXTextureSample => ({
    width: count,
    height: 1,
    data: new Uint8ClampedArray(
      Array.from({ length: count }, () => rgba).flat(),
    ),
  });
  const white = { r: 1, g: 1, b: 1, a: 1 };

  it("reads a grey texture through its layer's tint", () => {
    const hue = particleVFXDominantHue([
      {
        sample: solid([200, 200, 200, 255]),
        tint: { r: 0.9137, g: 0.2667, b: 0.3647, a: 1 },
      },
    ]);
    expect(
      hueDistance(hue!, particleVFXHue(0.9137, 0.2667, 0.3647).hue!),
    ).toBeLessThan(1);
  });

  it("follows the colour most of the effect shows, not the average", () => {
    const hue = particleVFXDominantHue([
      { sample: solid([230, 30, 60, 255]), tint: white },
      { sample: solid([230, 30, 60, 255]), tint: white },
      // A smaller yellow layer and a large but transparent blue one.
      { sample: solid([250, 220, 30, 255], 4), tint: { ...white, a: 0.5 } },
      { sample: solid([20, 60, 250, 0]), tint: white },
    ]);
    expect(hueDistance(hue!, particleVFXHue(230, 30, 60).hue!)).toBeLessThan(1);
  });

  it("finds no hue in an effect without colour", () => {
    expect(
      particleVFXDominantHue([
        { sample: solid([255, 255, 255, 255]), tint: white },
        { sample: null, tint: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
      ]),
    ).toBeNull();
  });

  it("reads the Included effects as the colour they show", async () => {
    const pink = await dominantHue(await includedDraft("heart-burst"));
    const fire = await dominantHue(await includedDraft("rage-aura"));
    const rain = await dominantHue(await includedDraft("rain-cloud"));
    expect(hueDistance(pink!, 335)).toBeLessThan(20);
    expect(hueDistance(fire!, 15)).toBeLessThan(20);
    expect(hueDistance(rain!, 215)).toBeLessThan(25);
  });
});

describe("recolouring an effect's emitter colours", () => {
  it("transforms every start, Color Over Life and Color By Speed key, and nothing else", () => {
    const json = includedJson("fireworks-show");
    const emitter = (json.object as JsonObject).children as JsonObject[];
    // Add the other colour generators the editor can meet.
    const ps = emitter[0]!.ps as JsonObject;
    ps.startColor = {
      type: "ColorRange",
      a: { r: 1, g: 0, b: 0, a: 1 },
      b: { r: 0, g: 0, b: 1, a: 0.5 },
    };
    (ps.behaviors as JsonObject[]).push({
      type: "ColorBySpeed",
      color: {
        type: "RandomColorBetweenGradient",
        gradient1: {
          type: "Gradient",
          color: { keys: [{ value: { r: 1, g: 0.5, b: 0 }, pos: 0 }] },
          alpha: { keys: [{ value: 0.25, pos: 0 }] },
        },
        gradient2: {
          type: "Gradient",
          color: { keys: [{ value: { r: 0.2, g: 0.9, b: 0.4 }, pos: 0 }] },
        },
      },
      speedRange: { type: "ConstantValue", value: 1 },
    });
    const transform: ParticleVFXColourTransform = {
      kind: "rotate",
      degrees: 120,
    };
    const recoloured = cloneJsonObject(json);
    recolourParticleVFXEffectColours(recoloured, transform);

    const before = colours(json.object);
    const after = colours(recoloured.object);
    expect(after.map(({ path }) => path)).toEqual(
      before.map(({ path }) => path),
    );
    expect(before.length).toBeGreaterThan(40);
    after.forEach(({ colour }, index) =>
      expect(colour).toEqual(
        transformParticleVFXColour(before[index]!.colour, transform),
      ),
    );
    // Only colour channels changed: alphas, positions and every other field
    // are as they were.
    const strip = (value: JsonObject) =>
      JSON.parse(
        JSON.stringify(value, (key, child) =>
          ["r", "g", "b"].includes(key) ? 0 : child,
        ),
      );
    expect(strip(recoloured)).toEqual(strip(json));
    expect(ps.startColor).toMatchObject({ a: { a: 1 }, b: { a: 0.5 } });

    const white = cloneJsonObject(json);
    recolourParticleVFXEffectColours(white, { kind: "desaturate" });
    for (const { colour } of colours(white.object)) {
      expect(colour.r).toBe(colour.g);
      expect(colour.g).toBe(colour.b);
    }
  });
});

describe("recoloured texture names", () => {
  it("names a copy after its texture and theme, never reusing a name", () => {
    const none = new Set<string>();
    expect(
      particleVFXThemedTextureReference(
        "textures/glossy-heart.png",
        "sky",
        none,
      ),
    ).toBe("textures/glossy-heart-sky.png");
    // A reopened themed effect's texture drops its earlier theme.
    expect(
      particleVFXThemedTextureReference(
        "textures/glossy-heart-sky-2.png",
        "gold",
        none,
      ),
    ).toBe("textures/glossy-heart-gold.png");
    expect(
      particleVFXThemedTextureReference(
        "textures/glossy-heart-sky.png",
        "sky",
        new Set(["textures/glossy-heart-sky.png"]),
      ),
    ).toBe("textures/glossy-heart-sky-2.png");
    expect(
      particleVFXThemedTextureReference("textures/Soft Dot.webp", "mint", none),
    ).toBe("textures/soft-dot-mint.png");
  });
});

describe("choosing a colour theme", { timeout: 30_000 }, () => {
  it("recolours Heart Burst's art and colours onto Sky as the effect's own textures", async () => {
    const draft = await includedDraft("heart-burst");
    const codec = testCodec();
    const result = await theme(draft, "sky", codec);
    if (!result.ok) throw new Error(result.message);
    const sky = result.draft;

    expect(particleVFXColourThemeId(sky)).toBe("sky");
    expect(particleVFXTextureReferences(sky.quarksJson).sort()).toEqual([
      "textures/glint-star-sky.png",
      "textures/glossy-heart-sky.png",
      "textures/heart-glow-sky.png",
      "textures/heart-ring-sky.png",
    ]);
    // The reference keeps the original textures for Original.
    for (const reference of particleVFXTextureReferences(draft.quarksJson))
      expect(sky.textureFiles[reference]).toBe(draft.textureFiles[reference]);
    expect(codec.recoloured).toBe(4);
    // The art moved: each copy's hue is the original's plus the step.
    const step = (sky.simple!.theme!.transform as { degrees: number }).degrees;
    const heart = await decode(
      sky.textureFiles["textures/glossy-heart-sky.png"]!.blob,
    );
    const original = await decode(
      draft.textureFiles["textures/glossy-heart.png"]!.blob,
    );
    expect(heart.data.length).toBe(original.data.length);
    const centre = (heart.width * (heart.height / 2) + heart.width / 2) * 4;
    const hueAt = (data: Uint8ClampedArray) =>
      particleVFXHue(
        data[centre]! / 255,
        data[centre + 1]! / 255,
        data[centre + 2]! / 255,
      ).hue!;
    expect(
      hueDistance(hueAt(original.data) + step, hueAt(heart.data)),
    ).toBeLessThan(2);
    // The edge colour kept in transparent pixels moved with the art.
    let transparentColoured = 0;
    for (let index = 0; index < original.data.length; index += 4) {
      if (original.data[index + 3] !== 0) continue;
      const before = particleVFXHue(
        original.data[index]! / 255,
        original.data[index + 1]! / 255,
        original.data[index + 2]! / 255,
      );
      if (before.chroma < 0.2) continue;
      transparentColoured += 1;
      const after = particleVFXHue(
        heart.data[index]! / 255,
        heart.data[index + 1]! / 255,
        heart.data[index + 2]! / 255,
      );
      expect(hueDistance(before.hue! + step, after.hue!)).toBeLessThan(2);
    }
    expect(transparentColoured).toBeGreaterThan(10_000);
    // So did the emitter colours, by the same step.
    const before = colours(draft.quarksJson.object);
    colours(sky.quarksJson.object).forEach(({ colour }, index) =>
      expect(colour).toEqual(
        transformParticleVFXColour(before[index]!.colour, {
          kind: "rotate",
          degrees: step,
        }),
      ),
    );
    // And the effect now shows Sky.
    expect(hueDistance((await dominantHue(sky))!, 200)).toBeLessThan(2);
  });

  it("restores the reference exactly with Original and drops the copies", async () => {
    const draft = await includedDraft("heart-burst");
    const sky = await themed(draft, "sky");
    const original = await themed(sky, "original");

    expect(particleVFXColourThemeId(original)).toBe("original");
    expect(original.quarksJson).toEqual(draft.quarksJson);
    expect(original.catalog).toEqual(draft.catalog);
    expect(original.textureFiles).toEqual(draft.textureFiles);
    for (const [reference, file] of Object.entries(draft.textureFiles))
      expect(original.textureFiles[reference]).toBe(file);
  });

  it("keeps the Simple positions, and a later move keeps the theme", async () => {
    const draft = setParticleVFXSimpleControl(
      await includedDraft("heart-burst"),
      "amount",
      200,
    );
    const sky = await themed(draft, "sky");
    expect(sky.simple?.factors.amount).toBe(200);
    expect(sky.simple?.reference).toBe(draft.simple?.reference);

    const faster = setParticleVFXSimpleControl(sky, "speed", 150);
    expect(particleVFXColourThemeId(faster)).toBe("sky");
    expect(usedTextureHashes(faster)).toEqual(usedTextureHashes(sky));
    expect(faster.catalog.defaultDurationSec).toBeLessThan(
      sky.catalog.defaultDurationSec,
    );

    const original = await themed(faster, "original");
    expect(original.quarksJson).toEqual(
      setParticleVFXSimpleControl(draft, "speed", 150).quarksJson,
    );
  });

  it("replaces one theme's copies with another's, deterministically", async () => {
    const draft = await includedDraft("rage-aura");
    const sky = await themed(draft, "sky");
    const gold = await themed(sky, "gold");
    expect(
      Object.keys(gold.textureFiles).filter((path) => path.includes("-sky")),
    ).toEqual([]);
    expect(
      particleVFXTextureReferences(gold.quarksJson).every((path) =>
        path.endsWith("-gold.png"),
      ),
    ).toBe(true);
    const skyAgain = await themed(gold, "sky");
    expect(usedTextureHashes(skyAgain)).toEqual(usedTextureHashes(sky));
    expect(skyAgain.quarksJson).toEqual(sky.quarksJson);
  });

  it("desaturates art and colours for White", async () => {
    const white = await themed(await includedDraft("rain-cloud"), "white");
    for (const reference of particleVFXTextureReferences(white.quarksJson)) {
      const { data } = await decode(white.textureFiles[reference]!.blob);
      expect(particleVFXPixelChroma(data)).toBe(0);
    }
    for (const { colour } of colours(white.quarksJson.object))
      expect(colour.r === colour.g && colour.g === colour.b).toBe(true);
  });

  it("leaves near-grey art alone and moves the colour that tints it", async () => {
    const draft = await includedDraft("hearts-v1");
    const mint = await themed(draft, "mint");
    expect(particleVFXTextureReferences(mint.quarksJson)).toEqual([
      "textures/heart.png",
    ]);
    expect(mint.textureFiles).toEqual(draft.textureFiles);
    const start = (
      ((mint.quarksJson.object as JsonObject).children as JsonObject[])[0]!
        .ps as JsonObject
    ).startColor as { color: { r: number; g: number; b: number } };
    expect(
      hueDistance(
        particleVFXHue(start.color.r, start.color.g, start.color.b).hue!,
        150,
      ),
    ).toBeLessThan(1);
  });

  it("recolours a built-in texture into the effect's own file", async () => {
    const blank = createParticleVFXEditorDraftFromBlank();
    const red = applyParticleVFXEmitterPatch(blank, blank.emitters[0]!.path, {
      textureId: "fire-8x8",
    });
    const sky = await themed(red, "sky");
    expect(particleVFXTextureReferences(sky.quarksJson)).toEqual([
      "textures/fire-8x8-sky.png",
    ]);
    expect(Object.keys(sky.textureFiles)).toEqual([
      "textures/fire-8x8-sky.png",
    ]);
    expect((await themed(sky, "original")).quarksJson.images).toEqual(
      red.quarksJson.images,
    );
  });

  it("refuses an effect without colour and leaves the draft as it was", async () => {
    const blank = createParticleVFXEditorDraftFromBlank();
    const before = structuredClone(blank);
    const result = await theme(blank, "rose");
    expect(result).toEqual({
      ok: false,
      message: "This effect shows no colour for a theme to change.",
    });
    expect(blank).toEqual(before);
  });

  it("names the texture a failed decode, encode or limit stopped, changing nothing", async () => {
    const draft = await includedDraft("heart-burst");
    const before = structuredClone(draft);
    const failing = testCodec();
    failing.recolour = vi.fn(async () => {
      throw new Error("The image could not be encoded.");
    });
    expect(await theme(draft, "gold", failing)).toEqual({
      ok: false,
      message:
        "glossy-heart.png could not be recoloured: The image could not be encoded.",
    });

    const oversized = testCodec();
    oversized.recolour = async () =>
      new Blob(
        [
          new Uint8Array(
            await sharp({
              create: {
                width: PARTICLE_TEXTURE_LIMITS.dimension + 1,
                height: 4,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 },
              },
            })
              .png()
              .toBuffer(),
          ),
        ],
        { type: "image/png" },
      );
    expect(await theme(draft, "gold", oversized)).toEqual({
      ok: false,
      message: `glossy-heart.png could not be recoloured: Textures must be at most ${PARTICLE_TEXTURE_LIMITS.dimension} px on each side.`,
    });

    const unreadable = testCodec();
    unreadable.sample = async () => {
      throw new Error("The image could not be decoded.");
    };
    expect(await theme(draft, "gold", unreadable)).toMatchObject({
      ok: false,
      message:
        "glossy-heart.png could not be read: The image could not be decoded.",
    });
    expect(draft).toEqual(before);
  });

  it("stops when its signal aborts", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Superseded", "AbortError"));
    await expect(
      setParticleVFXColourTheme(await includedDraft("heart-burst"), "sky", {
        codec: testCodec(),
        loadTexture: loadBuiltIn,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Superseded");
  });

  it(
    "themes every Included effect in every swatch within the texture limits, onto its target hue",
    { timeout: 300_000 },
    async () => {
      let largestCopy = 0;
      for (const { id } of AVATAR_PARTICLE_VFX_CATALOG) {
        const draft = await includedDraft(id);
        for (const { id: themeId, hue } of PARTICLE_VFX_COLOUR_THEMES) {
          if (themeId === "original") continue;
          const next = await themed(draft, themeId);
          const theme = next.simple!.theme!;
          const copies = Object.values(theme.textures);
          for (const copy of copies) {
            const file = next.textureFiles[copy]!;
            largestCopy = Math.max(largestCopy, file.blob.size);
            expect(file.blob.size).toBeLessThanOrEqual(
              PARTICLE_TEXTURE_LIMITS.bytes,
            );
            expect(Math.max(file.width, file.height)).toBeLessThanOrEqual(
              PARTICLE_TEXTURE_LIMITS.dimension,
            );
          }
          const used = particleVFXTextureReferences(next.quarksJson);
          expect(used.length).toBeLessThanOrEqual(
            PARTICLE_TEXTURE_LIMITS.count,
          );
          expect(
            used.reduce(
              (total, path) =>
                total + (next.textureFiles[path]?.blob.size ?? 0),
              0,
            ),
          ).toBeLessThanOrEqual(PARTICLE_TEXTURE_LIMITS.totalBytes);
          expect(
            validateParticleVFXContentReadiness(next, {
              resolvableTextureReferences: new Set(
                Object.keys(next.textureFiles),
              ),
            }).ready,
          ).toBe(true);
          if (hue !== null)
            expect(
              hueDistance((await dominantHue(next))!, hue),
              `${id} ${themeId}`,
            ).toBeLessThan(2);
          // Near-grey textures keep their path; the rest point at copies
          // (none when the effect already shows the swatch's hue).
          const moved =
            theme.transform.kind === "desaturate" ||
            theme.transform.degrees !== 0;
          for (const path of particleVFXTextureReferences(draft.quarksJson)) {
            const { data } = await testCodec().sample(
              draft.textureFiles[path]!.blob,
            );
            expect(path in theme.textures, `${id} ${themeId} ${path}`).toBe(
              moved &&
                particleVFXPixelChroma(data) >= PARTICLE_VFX_THEME_GREY_CHROMA,
            );
          }
        }
      }
      expect(largestCopy).toBeGreaterThan(0);
    },
  );
});
