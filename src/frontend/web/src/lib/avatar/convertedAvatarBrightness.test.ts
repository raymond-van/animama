import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createAvatarGltfLoader } from "./avatarGltfLoader";
import {
  ANIMAMA_CONVERSION_EXTENSION,
  isAnimamaConversion,
} from "./avatarConversionMarker";
import { raiseConvertedAvatarBrightness } from "./convertedAvatarBrightness";
import { PlaceholderTexturePlugin } from "./motion-authoring/headlessVrm";
import { readTestAvatarBytes } from "./motion-authoring/testing/includedAvatars";
import { encodeGlb } from "./testing/glb";
import { LIT_GAIN } from "./unlitToonShading";

type Json = Record<string, unknown>;

/** A converted file's JSON with the given materials (marker on by default). */
function convertedJson(materials: Json[], marked = true): Json {
  return {
    asset: { version: "2.0" },
    extensionsUsed: [
      "VRMC_vrm",
      "VRMC_materials_mtoon",
      ...(marked ? [ANIMAMA_CONVERSION_EXTENSION] : []),
    ],
    extensions: marked
      ? {
          [ANIMAMA_CONVERSION_EXTENSION]: { source: "pmx", converter: "0.2.0" },
        }
      : {},
    materials,
  };
}

function mtoonMaterial(base: unknown[] | undefined, mtoon: Json = {}): Json {
  return {
    pbrMetallicRoughness: base ? { baseColorFactor: base } : {},
    extensions: {
      VRMC_materials_mtoon: { specVersion: "1.0", ...mtoon },
    },
  };
}

const closeTo = (values: unknown, expected: number[]) => {
  expect(values).toHaveLength(expected.length);
  expected.forEach((value, index) =>
    expect((values as number[])[index]).toBeCloseTo(value, 6),
  );
};

describe("raiseConvertedAvatarBrightness", () => {
  it("raises each MToon material's lit and shade colours, keeping alpha and the rest", () => {
    const json = convertedJson([
      mtoonMaterial([0.8, 0.6, 0.4, 0.5], {
        shadeColorFactor: [0.4, 0.2, 0.1],
        outlineColorFactor: [0.1, 0.1, 0.1],
        matcapFactor: [1, 1, 1],
        parametricRimColorFactor: [0, 0, 0],
      }),
      // glTF's default white and MToon's default black shade.
      mtoonMaterial(undefined),
      // Not MToon: left alone.
      { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } },
    ]);
    expect(raiseConvertedAvatarBrightness(json)).toBe(2);
    const [first, second, third] = json.materials as Json[];
    const pbr = (material: Json | undefined) =>
      material!.pbrMetallicRoughness as Json;
    const mtoon = (material: Json | undefined) =>
      (material!.extensions as Json).VRMC_materials_mtoon as Json;
    closeTo(pbr(first).baseColorFactor, [1, 0.75, 0.5, 0.5]);
    closeTo(mtoon(first).shadeColorFactor, [0.5, 0.25, 0.125]);
    expect(mtoon(first).outlineColorFactor).toEqual([0.1, 0.1, 0.1]);
    expect(mtoon(first).matcapFactor).toEqual([1, 1, 1]);
    expect(mtoon(first).parametricRimColorFactor).toEqual([0, 0, 0]);
    closeTo(pbr(second).baseColorFactor, [LIT_GAIN, LIT_GAIN, LIT_GAIN, 1]);
    closeTo(mtoon(second).shadeColorFactor, [0, 0, 0]);
    expect(pbr(third).baseColorFactor).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it("leaves a file without the converter's marker as authored", () => {
    const json = convertedJson(
      [
        mtoonMaterial([0.8, 0.6, 0.4, 1], {
          shadeColorFactor: [0.4, 0.2, 0.1],
        }),
      ],
      false,
    );
    const before = structuredClone(json);
    expect(isAnimamaConversion(json)).toBe(false);
    expect(raiseConvertedAvatarBrightness(json)).toBe(0);
    expect(json).toEqual(before);
  });

  it("reads a non-array factor as glTF's default and leaves a malformed array as authored", () => {
    const json = convertedJson([
      // Not an array: three's loaders read glTF's default white.
      {
        ...mtoonMaterial(undefined),
        pbrMetallicRoughness: { baseColorFactor: "red" },
      },
      // A string channel and a short array: left alone.
      mtoonMaterial(["0.5", 1, 1, 1], { shadeColorFactor: [0.4, 0.2, 0.1] }),
      mtoonMaterial([0.5, 1, 1, 1], { shadeColorFactor: [0.4] }),
    ]);
    expect(raiseConvertedAvatarBrightness(json)).toBe(1);
    const [defaulted, stringChannel, shortShade] = json.materials as Json[];
    closeTo((defaulted!.pbrMetallicRoughness as Json).baseColorFactor, [
      LIT_GAIN,
      LIT_GAIN,
      LIT_GAIN,
      1,
    ]);
    expect(stringChannel).toEqual(
      mtoonMaterial(["0.5", 1, 1, 1], { shadeColorFactor: [0.4, 0.2, 0.1] }),
    );
    expect(shortShade).toEqual(
      mtoonMaterial([0.5, 1, 1, 1], { shadeColorFactor: [0.4] }),
    );
  });
});

/**
 * The Included Avatar Annie with Animama Avatar Converter's marker added, as
 * if the converter had written her (her MToon materials are unchanged).
 */
async function markedAnnie(): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(await readTestAvatarBytes("Annie"));
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  ) as Json & { extensionsUsed: string[]; extensions: Json };
  const binLength = view.getUint32(20 + jsonLength, true);
  const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  json.extensionsUsed = [...json.extensionsUsed, ANIMAMA_CONVERSION_EXTENSION];
  json.extensions = {
    ...json.extensions,
    [ANIMAMA_CONVERSION_EXTENSION]: { source: "pmx", converter: "0.2.0" },
  };
  // `encodeGlb` returns a fresh array that fills its own buffer.
  return encodeGlb(json, bin).buffer as ArrayBuffer;
}

type MToonLike = THREE.Material & {
  isMToonMaterial?: boolean;
  color: THREE.Color;
  shadeColorFactor: THREE.Color;
};

/** Each MToon material by name, as the app's Avatar loader builds it. */
async function loadedMToon(
  bytes: ArrayBuffer,
  options: Parameters<typeof createAvatarGltfLoader>[0],
): Promise<Map<string, MToonLike>> {
  const loader = createAvatarGltfLoader(options);
  loader.register((parser) => new PlaceholderTexturePlugin(parser));
  const gltf = await loader.parseAsync(bytes, "");
  const materials = new Map<string, MToonLike>();
  gltf.scene.traverse((object) => {
    for (const material of [(object as THREE.Mesh).material ?? []].flat()) {
      const mtoon = material as MToonLike;
      if (
        mtoon.isMToonMaterial &&
        !(material as { isOutline?: boolean }).isOutline
      )
        materials.set(material.name, mtoon);
    }
  });
  return materials;
}

/** Annie's own MToon lit and shade factors by material name. */
async function annieFactors(): Promise<
  Map<string, { lit: number[]; shade: number[] }>
> {
  const bytes = new Uint8Array(await readTestAvatarBytes("Annie"));
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
    12,
    true,
  );
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  ) as { materials: Json[] };
  const factors = new Map<string, { lit: number[]; shade: number[] }>();
  for (const material of json.materials) {
    const mtoon = (material.extensions as Json | undefined)
      ?.VRMC_materials_mtoon as Json | undefined;
    if (!mtoon) continue;
    factors.set(material.name as string, {
      lit: ((material.pbrMetallicRoughness as Json | undefined)
        ?.baseColorFactor as number[] | undefined) ?? [1, 1, 1, 1],
      shade: (mtoon.shadeColorFactor as number[] | undefined) ?? [0, 0, 0],
    });
  }
  return factors;
}

describe("withConvertedAvatarBrightness", () => {
  // Annie is a VRoid export, so this also checks that the enhanced retune
  // (on by default) leaves a converted file's shade as the file has it.
  for (const options of [{}, { lilToon: false, unlitToon: false }]) {
    it(`draws a converted Avatar's own MToon lit and shade colours raised by the gain (${JSON.stringify(options)})`, async () => {
      const own = await annieFactors();
      const converted = await loadedMToon(await markedAnnie(), options);
      expect(own.size).toBeGreaterThan(0);
      expect(converted.size).toBe(own.size);
      for (const [name, { lit, shade }] of own) {
        const raised = converted.get(name)!;
        expect(raised, name).toBeDefined();
        (["r", "g", "b"] as const).forEach((channel, index) => {
          expect(raised.color[channel]).toBeCloseTo(lit[index]! * LIT_GAIN, 5);
          expect(raised.shadeColorFactor[channel]).toBeCloseTo(
            shade[index]! * LIT_GAIN,
            5,
          );
        });
      }
    }, 30_000);
  }

  it("leaves an Avatar without the marker at the file's colours", async () => {
    const own = await annieFactors();
    const authored = await loadedMToon(await readTestAvatarBytes("Annie"), {});
    for (const [name, { lit }] of own)
      (["r", "g", "b"] as const).forEach((channel, index) =>
        expect(authored.get(name)!.color[channel]).toBeCloseTo(lit[index]!, 5),
      );
  }, 30_000);
});
