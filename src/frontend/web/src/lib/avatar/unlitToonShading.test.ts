import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createAvatarGltfLoader } from "./avatarGltfLoader";
import { PlaceholderTexturePlugin } from "./motion-authoring/headlessVrm";
import { readTestAvatarBytes } from "./motion-authoring/testing/includedAvatars";
import { encodeGlb } from "./testing/glb";
import {
  applyUnlitToonShading,
  takesUnlitToonShading,
  planUnlitToonShading,
  unlitToonAccessorIndices,
  unlitToonStateOf,
  type AccessorValues,
} from "./unlitToonShading";

type Json = Record<string, unknown>;

const UNLIT = { KHR_materials_unlit: {} };

function unlitMaterial(options: { texture?: number; blend?: boolean } = {}) {
  return {
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      ...(options.texture === undefined
        ? {}
        : { baseColorTexture: { index: options.texture } }),
    },
    ...(options.blend ? { alphaMode: "BLEND" } : {}),
    extensions: { ...UNLIT },
  };
}

/**
 * A converted MMD model's shape: one mesh whose primitives share one vertex
 * buffer (accessor 0, 12 vertices) and its morph targets.
 *
 * - primitive 0, material 0: face skin, vertices 0–3 (blink moves 2–3);
 * - primitive 1, material 1: iris, vertices 4–5 (a pupil shape no expression binds moves them);
 * - primitive 2, material 2: clothes, vertices 6–9 (never moved);
 * - primitive 3, material 3: blush overlay, blended, vertices 0–1;
 * - primitive 4, material 4: untextured, vertices 10–11.
 */
function mmdModel(): { json: Json; accessors: Map<number, AccessorValues> } {
  const accessors = new Map<number, AccessorValues>();
  const positions = new THREE.BufferAttribute(new Float32Array(36), 3);
  accessors.set(0, positions);
  const displacement = (moved: number[]) => {
    const values = new Float32Array(36);
    for (const vertex of moved) values[vertex * 3 + 1] = 0.002;
    return new THREE.BufferAttribute(values, 3);
  };
  accessors.set(1, displacement([2, 3])); // blink
  accessors.set(2, displacement([4, 5])); // pupil
  const parts = [
    [0, 1, 2, 3, 0, 2],
    [4, 5, 4],
    [6, 7, 8, 9, 6, 8, 7, 9, 6],
    [0, 1, 0],
    [10, 11, 10],
  ];
  parts.forEach((indices, part) =>
    accessors.set(
      10 + part,
      new THREE.BufferAttribute(new Uint16Array(indices), 1),
    ),
  );
  const json: Json = {
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: parts.map((_, part) => ({
          attributes: { POSITION: 0 },
          indices: 10 + part,
          material: part,
          targets: [{ POSITION: 1 }, { POSITION: 2 }],
        })),
      },
    ],
    materials: [
      unlitMaterial({ texture: 0 }),
      unlitMaterial({ texture: 1 }),
      unlitMaterial({ texture: 2 }),
      unlitMaterial({ texture: 3, blend: true }),
      unlitMaterial(),
    ],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        expressions: {
          preset: {
            blink: { morphTargetBinds: [{ node: 0, index: 0, weight: 1 }] },
          },
        },
      },
    },
  };
  return { json, accessors };
}

function plan(json: Json, accessors: Map<number, AccessorValues>) {
  return Object.fromEntries(
    planUnlitToonShading(json, (index) => accessors.get(index) ?? null),
  );
}

describe("takesUnlitToonShading", () => {
  it("rejects an unlit file with nothing toon shading would change", () => {
    const { json } = mmdModel();
    json.materials = [
      unlitMaterial({ texture: 0, blend: true }),
      unlitMaterial(),
    ];
    expect(takesUnlitToonShading(json)).toBe(false);
  });

  it("accepts a VRM 1.0 file whose materials are all unlit", () => {
    expect(takesUnlitToonShading(mmdModel().json)).toBe(true);
  });

  it("rejects a file with any lit material, no material or no VRM 1.0", () => {
    const withMToon = mmdModel().json;
    (withMToon.materials as Json[])[2]!.extensions = {
      ...UNLIT,
      VRMC_materials_mtoon: { specVersion: "1.0" },
    };
    expect(takesUnlitToonShading(withMToon)).toBe(false);

    const withPbr = mmdModel().json;
    (withPbr.materials as Json[])[2]!.extensions = {};
    expect(takesUnlitToonShading(withPbr)).toBe(false);

    expect(takesUnlitToonShading({ ...mmdModel().json, materials: [] })).toBe(
      false,
    );
    expect(
      takesUnlitToonShading({ ...mmdModel().json, extensions: { VRM: {} } }),
    ).toBe(false);
  });
});

describe("planUnlitToonShading", () => {
  it("shades the face skin gently and the body fully; face details, overlays and untextured parts stay unlit", () => {
    const { json, accessors } = mmdModel();
    expect(plan(json, accessors)).toEqual({ 0: "face", 2: "body" });
  });

  it("reads only the face meshes' targets and their parts' indices", () => {
    expect(
      unlitToonAccessorIndices(mmdModel().json).sort((a, b) => a - b),
    ).toEqual([1, 2, 10, 11, 12, 13, 14]);
  });

  it("ignores shape keys on meshes no expression binds", () => {
    const { json, accessors } = mmdModel();
    // The clothes move to their own mesh, with a fit shape that moves them.
    const meshes = json.meshes as { primitives: Json[] }[];
    const clothes = meshes[0]!.primitives.splice(2, 1)[0]!;
    meshes.push({ primitives: [{ ...clothes, targets: [{ POSITION: 3 }] }] });
    (json.nodes as Json[]).push({ mesh: 1 });
    const fit = new Float32Array(36).fill(0.01);
    accessors.set(3, new THREE.BufferAttribute(fit, 3));
    expect(plan(json, accessors)).toEqual({ 0: "face", 2: "body" });
  });

  it("uses every mesh with shapes when no expression binds one", () => {
    const { json, accessors } = mmdModel();
    (json.extensions as { VRMC_vrm: Json }).VRMC_vrm.expressions = {};
    expect(plan(json, accessors)).toEqual({ 0: "face", 2: "body" });
  });

  it("gives a material shared by the face skin and the body the face look", () => {
    const { json, accessors } = mmdModel();
    const primitives = (json.meshes as { primitives: Json[] }[])[0]!.primitives;
    primitives[2]!.material = 0;
    expect(plan(json, accessors)).toEqual({ 0: "face" });
  });

  it("plans nothing for a file that is not unlit-only", () => {
    const { json, accessors } = mmdModel();
    (json.materials as Json[])[2]!.extensions = {};
    expect(plan(json, accessors)).toEqual({});
  });

  it("treats a part whose targets cannot be read as not moved", () => {
    const { json, accessors } = mmdModel();
    accessors.delete(1);
    accessors.delete(2);
    // Nothing reads as moved, so no face skin is found: all textured,
    // non-blended parts take the body look.
    expect(plan(json, accessors)).toEqual({ 0: "body", 1: "body", 2: "body" });
  });
});

describe("applyUnlitToonShading", () => {
  it("writes MToon that reuses the base texture for the shaded side", () => {
    const { json } = mmdModel();
    const material = (json.materials as Json[])[2] as {
      pbrMetallicRoughness: { baseColorFactor: number[] };
      extensions: Json;
    };
    material.pbrMetallicRoughness.baseColorFactor = [0.5, 1, 1, 0.8];
    applyUnlitToonShading(json, new Map([[2, "body"]]));
    const mtoon = material.extensions.VRMC_materials_mtoon as Json;
    expect(mtoon).toMatchObject({
      specVersion: "1.0",
      shadeMultiplyTexture: { index: 2 },
      outlineWidthMode: "screenCoordinates",
    });
    // The lit side is raised; alpha is kept.
    const [red, green, , alpha] = material.pbrMetallicRoughness.baseColorFactor;
    expect(red! / green!).toBeCloseTo(0.5);
    expect(green).toBeGreaterThan(1);
    expect(alpha).toBe(0.8);
    // The shade carries the base colour's tint, darker than the lit side.
    const shade = mtoon.shadeColorFactor as number[];
    expect(shade[0]! / shade[2]!).toBeLessThan(1);
    expect(shade[1]!).toBeLessThan(green!);
    // Untouched materials keep their unlit extension only.
    expect((json.materials as Json[])[0]!.extensions).toEqual(UNLIT);
  });
});

/**
 * The Included Avatar Annie as a converter that writes only unlit materials
 * would: every MToon material replaced by `KHR_materials_unlit`.
 */
async function unlitAnnie(): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(await readTestAvatarBytes("Annie"));
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  ) as Json & { materials: { extensions?: Json }[]; extensionsUsed: string[] };
  const binLength = view.getUint32(20 + jsonLength, true);
  const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  for (const material of json.materials)
    material.extensions = { KHR_materials_unlit: {} };
  json.extensionsUsed = [
    ...json.extensionsUsed.filter((name) => name !== "VRMC_materials_mtoon"),
    "KHR_materials_unlit",
  ];
  // `encodeGlb` returns a fresh array that fills its own buffer.
  return encodeGlb(json, bin).buffer as ArrayBuffer;
}

/**
 * Each material by name, as the app's Avatar loader draws it (enhanced
 * rendering on, its default), with placeholder textures.
 */
async function loadedMaterials(bytes: ArrayBuffer, apply: boolean) {
  const loader = createAvatarGltfLoader({ unlitToon: apply });
  loader.register((parser) => new PlaceholderTexturePlugin(parser));
  const gltf = await loader.parseAsync(bytes, "");
  const materials = new Map<string, THREE.Material>();
  let outlines = 0;
  gltf.scene.traverse((object) => {
    for (const material of [(object as THREE.Mesh).material ?? []].flat()) {
      if ((material as { isOutline?: boolean }).isOutline) outlines += 1;
      else materials.set(material.name, material);
    }
  });
  return { state: unlitToonStateOf(gltf), materials, outlines };
}

const kindOf = (material: THREE.Material | undefined) =>
  (material as { isMToonMaterial?: boolean } | undefined)?.isMToonMaterial
    ? `toon ${(material as unknown as { shadingShiftFactor: number }).shadingShiftFactor}`
    : material?.type;

describe("withUnlitToonShading", () => {
  it("toon-shades an unlit-only Avatar and keeps its face details unlit", async () => {
    const { state, materials, outlines } = await loadedMaterials(
      await unlitAnnie(),
      true,
    );
    expect(state).toBe("toon");
    const named = (part: string) =>
      kindOf([...materials].find(([name]) => name.includes(part))?.[1]);
    expect(named("Face_00_SKIN")).toBe("toon 0.55");
    expect(named("Body_00_SKIN")).toBe("toon -0.05");
    expect(named("HAIR")).toBe("toon -0.05");
    for (const detail of ["EyeIris", "EyeHighlight", "FaceEyeline"])
      expect(named(detail)).toBe("MeshBasicMaterial");
    expect(outlines).toBeGreaterThan(0);
  }, 30_000);

  it("keeps the file's unlit materials under Simple", async () => {
    const { state, materials, outlines } = await loadedMaterials(
      await unlitAnnie(),
      false,
    );
    expect(state).toBe("simple");
    expect(new Set([...materials.values()].map(kindOf))).toEqual(
      new Set(["MeshBasicMaterial"]),
    );
    expect(outlines).toBe(0);
  }, 30_000);

  it("leaves an Avatar with toon materials as authored", async () => {
    const { state } = await loadedMaterials(
      await readTestAvatarBytes("Annie"),
      true,
    );
    expect(state).toBe("none");
  }, 30_000);
});
