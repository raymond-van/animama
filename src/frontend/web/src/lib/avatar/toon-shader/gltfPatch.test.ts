import { afterEach, describe, expect, it } from "vitest";
import type {
  GLTFLoader,
  GLTFLoaderPlugin,
  GLTFParser,
} from "three/examples/jsm/loaders/GLTFLoader.js";

import { useAvatarShaderStore, type AvatarShaderId } from "./avatarShader";
import { registerAvatarShaderGltfPatch } from "./gltfPatch";

type Mtoon = Record<string, unknown>;

function vroidJson() {
  const mtoon = (): Mtoon => ({
    shadeColorFactor: [1, 1, 1],
    shadingShiftFactor: 1,
    outlineWidthMode: "worldCoordinates",
  });
  return {
    materials: [
      {
        name: "N00_000_00_Face_00_SKIN (Instance)",
        extensions: { VRMC_materials_mtoon: mtoon() },
      },
      {
        name: "N00_000_00_Tops_01_CLOTH (Instance)",
        extensions: { VRMC_materials_mtoon: mtoon() },
      },
      {
        name: "N00_000_00_EyeIris_00_EYE (Instance)",
        extensions: { VRMC_materials_mtoon: mtoon() },
      },
      { name: "plain" },
    ],
  };
}

/** Run the patch plugin against `json` as GLTFLoader would per parse. */
function parseWith(shader: AvatarShaderId, json: ReturnType<typeof vroidJson>) {
  useAvatarShaderStore.setState({ shader });
  let plugin: ((parser: GLTFParser) => GLTFLoaderPlugin) | null = null;
  registerAvatarShaderGltfPatch({
    register: (callback: (parser: GLTFParser) => GLTFLoaderPlugin) => {
      plugin = callback;
    },
  } as unknown as GLTFLoader);
  plugin!({ json } as unknown as GLTFParser);
  return json.materials.map(
    (material) => material.extensions?.VRMC_materials_mtoon,
  );
}

describe("registerAvatarShaderGltfPatch", () => {
  afterEach(() => useAvatarShaderStore.setState({ shader: "mtoon" }));

  it("leaves MToon parameters untouched for the default shader", () => {
    const json = vroidJson();
    parseWith("mtoon", json);
    expect(json).toEqual(vroidJson());
  });

  it("retunes VRoid skin and cloth and leaves eyes flat for tuned MToon", () => {
    const [face, cloth, iris] = parseWith("mtoon-tuned", vroidJson());
    expect(face).toMatchObject({
      shadingShiftFactor: 0.6,
      outlineWidthMode: "screenCoordinates",
    });
    expect(face!.shadeColorFactor).not.toEqual([1, 1, 1]);
    expect(cloth).toMatchObject({
      shadingShiftFactor: -0.1,
      outlineWidthMode: "screenCoordinates",
    });
    expect(iris).toEqual({
      shadeColorFactor: [1, 1, 1],
      shadingShiftFactor: 1,
      outlineWidthMode: "worldCoordinates",
    });
  });

  it("drops MToon outline geometry for lilToon, which draws its own", () => {
    const patched = parseWith("liltoon", vroidJson());
    for (const mtoon of patched.slice(0, 3)) {
      expect(mtoon!.outlineWidthMode).toBe("none");
    }
  });
});
