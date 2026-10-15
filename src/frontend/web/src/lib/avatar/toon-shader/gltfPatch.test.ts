import { afterEach, describe, expect, it } from "vitest";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import type { GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";

import { useAvatarShaderStore, type AvatarShaderId } from "./avatarShader";
import { withAvatarShaderPatch } from "./gltfPatch";

type Json = {
  materials: { name: string; extensions?: Record<string, unknown> }[];
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
};
type Mtoon = Record<string, unknown>;

const NAMES = [
  "N00_000_00_Face_00_SKIN (Instance)",
  "N00_000_00_Tops_01_CLOTH (Instance)",
  "N00_000_00_EyeIris_00_EYE (Instance)",
];

/** A VRM 1.0 glTF: materials already carry `VRMC_materials_mtoon`. */
function vrm1Json(): Json {
  return {
    materials: NAMES.map((name) => ({
      name,
      extensions: {
        VRMC_materials_mtoon: {
          shadeColorFactor: [1, 1, 1],
          shadingShiftFactor: 1,
          outlineWidthMode: "worldCoordinates",
        },
      },
    })),
  };
}

/** A VRM 0.x glTF: MToon lives in `extensions.VRM.materialProperties`. */
function vrm0Json(): Json {
  return {
    materials: NAMES.map((name) => ({ name })),
    extensions: {
      VRM: {
        materialProperties: NAMES.map((name) => ({
          name,
          shader: "VRM/MToon",
          floatProperties: { _OutlineWidthMode: 1, _OutlineWidth: 0.1 },
          vectorProperties: {},
          textureProperties: {},
          keywordMap: {},
          tagMap: {},
        })),
      },
    },
  };
}

/** Run three-vrm's material pre-pass with the patch, as a load would. */
async function patch(shader: AvatarShaderId, json: Json): Promise<Mtoon[]> {
  useAvatarShaderStore.setState({ shader });
  const plugin = withAvatarShaderPatch(
    new VRMLoaderPlugin({ json } as unknown as GLTFParser),
  );
  await plugin.materialsV0CompatPlugin.beforeRoot();
  return json.materials.map(
    (material) => material.extensions?.VRMC_materials_mtoon as Mtoon,
  );
}

describe("withAvatarShaderPatch", () => {
  afterEach(() => useAvatarShaderStore.setState({ shader: "mtoon" }));

  it("leaves MToon parameters untouched for the default shader", async () => {
    const json = vrm1Json();
    await patch("mtoon", json);
    expect(json.materials).toEqual(vrm1Json().materials);
  });

  it("retunes VRoid skin and cloth and leaves eyes flat for tuned MToon", async () => {
    const [face, cloth, iris] = await patch("mtoon-tuned", vrm1Json());
    expect(face).toMatchObject({
      shadingShiftFactor: 0.6,
      outlineWidthMode: "screenCoordinates",
    });
    expect(face!.shadeColorFactor).not.toEqual([1, 1, 1]);
    expect(cloth).toMatchObject({
      shadingShiftFactor: -0.1,
      outlineWidthMode: "screenCoordinates",
    });
    expect(iris).toEqual(
      vrm1Json().materials[2]!.extensions!.VRMC_materials_mtoon,
    );
  });

  it("drops MToon outline geometry for lilToon, which draws its own", async () => {
    for (const mtoon of await patch("liltoon", vrm1Json())) {
      expect(mtoon.outlineWidthMode).toBe("none");
    }
  });

  it("patches VRM 0.x materials after three-vrm converts them", async () => {
    const tuned = await patch("mtoon-tuned", vrm0Json());
    expect(tuned[0]).toMatchObject({
      shadingShiftFactor: 0.6,
      outlineWidthMode: "screenCoordinates",
    });
    for (const mtoon of await patch("liltoon", vrm0Json())) {
      expect(mtoon.outlineWidthMode).toBe("none");
    }
    const stock = await patch("mtoon", vrm0Json());
    expect(stock[0]!.outlineWidthMode).toBe("worldCoordinates");
  });
});
