/**
 * Toon shading for Avatars whose materials all ignore light.
 *
 * Some VRM files declare every material `KHR_materials_unlit`. The usual
 * source is a MikuMikuDance (PMX) model converted with a tool built on three's
 * `GLTFExporter`, which cannot write MMD's toon material and so drops its
 * shading and outlines. three draws unlit materials as `MeshBasicMaterial`,
 * which no light reaches, so such an Avatar looks flat in every scene.
 *
 * Under the Automatic Materials setting, the loader gives these files MToon
 * (`VRMC_materials_mtoon`) before three-vrm builds their materials: shading,
 * rim light and a thin outline, with the base texture reused for the shaded
 * side. The face skin gets gentler shading; eyes, lashes, the mouth and other
 * face details, transparent and untextured materials stay unlit. Simple
 * leaves the file's materials as they are.
 */
import type { VRMLoaderPlugin } from "@pixiv/three-vrm";
import type {
  GLTF,
  GLTFParser,
} from "three/examples/jsm/loaders/GLTFLoader.js";

import { createLogger } from "@/lib/logger";
import { prepareAvatarFile } from "./configureAvatarGltfLoader";
import { LILTOON_MATERIALS_EXTENSION } from "./liltoon/lilToon";

const logger = createLogger("AvatarLoader");

type JsonRecord = Record<string, unknown>;
type Rgb = [number, number, number];

/** An accessor's values, as three's `BufferAttribute` reads them. */
export type AccessorValues = {
  readonly count: number;
  readonly itemSize: number;
  getComponent(index: number, component: number): number;
};

/**
 * What toon shading a material gets: the face skin's gentle look, or the
 * look for everything else (body, hair, clothes).
 */
export type UnlitToonLook = "face" | "body";

/**
 * How an Avatar's unlit materials loaded: `none` for a file with any other
 * material, `toon` when they got toon shading, `simple` when the Materials
 * setting kept them unlit.
 */
export type UnlitToonState = "none" | "toon" | "simple";

type ToonParameters = {
  shade: Rgb;
  shadingShift: number;
  shadingToony: number;
  rim: Rgb;
  outlineWidth: number;
  outlineColor: Rgb;
};

/**
 * The face stays mostly lit with a warm shade and a brown outline; the body
 * takes a cool, slightly purple shade and a near-black outline, as anime
 * toon shading does. Outline widths are fractions of the view height.
 */
const LOOKS: Record<UnlitToonLook, ToonParameters> = {
  face: {
    shade: [0.92, 0.66, 0.64],
    shadingShift: 0.55,
    shadingToony: 0.7,
    rim: [0.3, 0.22, 0.2],
    outlineWidth: 0.0014,
    outlineColor: [0.2, 0.06, 0.04],
  },
  body: {
    shade: [0.62, 0.58, 0.7],
    shadingShift: -0.05,
    shadingToony: 0.85,
    rim: [0.24, 0.22, 0.26],
    outlineWidth: 0.0016,
    outlineColor: [0.03, 0.025, 0.035],
  },
};

/**
 * The lit side's brightness relative to the texture. An unlit material shows
 * its texture at full strength; MToon multiplies it by the scene's lights,
 * which leave the lit side darker than that under the chat lights.
 */
const LIT_GAIN = 1.25;

/** A morph target moves a vertex when it displaces it further than this (m). */
const MOVED_EPSILON = 1e-4;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asIndex(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

/** Whether a material can take toon shading: textured and not blended. */
function takesToon(material: unknown): boolean {
  const record = asRecord(material);
  return (
    record?.alphaMode !== "BLEND" &&
    asIndex(
      asRecord(asRecord(record?.pbrMetallicRoughness)?.baseColorTexture)?.index,
    ) !== null
  );
}

/**
 * Whether a glTF gets toon shading for unlit materials: a VRM 1.0 file whose
 * materials all ignore light (each `KHR_materials_unlit` without MToon or
 * lilToon), at least one of them textured and not blended, so toon shading
 * changes something. VRM 0.x files are out of scope: three-vrm draws their
 * `VRM/Unlit*` shaders as MToon whose shade equals the lit colour (lit, but
 * still flat and without outlines) and their glTF unlit materials as unlit.
 */
export function takesUnlitToonShading(json: unknown): boolean {
  const root = asRecord(json);
  if (!asRecord(root?.extensions)?.VRMC_vrm) return false;
  const materials = asArray(root?.materials);
  return (
    materials.some(takesToon) &&
    materials.every((material) => {
      const extensions = asRecord(asRecord(material)?.extensions);
      return (
        extensions?.KHR_materials_unlit !== undefined &&
        !extensions.VRMC_materials_mtoon &&
        !extensions[LILTOON_MATERIALS_EXTENSION]
      );
    })
  );
}

type Primitive = {
  mesh: number;
  material: number | null;
  position: number | null;
  indices: number | null;
  targets: (number | null)[];
};

function primitivesOf(json: JsonRecord): Primitive[] {
  return asArray(json.meshes).flatMap((mesh, meshIndex) =>
    asArray(asRecord(mesh)?.primitives).map((value) => {
      const primitive = asRecord(value);
      return {
        mesh: meshIndex,
        material: asIndex(primitive?.material),
        position: asIndex(asRecord(primitive?.attributes)?.POSITION),
        indices: asIndex(primitive?.indices),
        targets: asArray(primitive?.targets).map((target) =>
          asIndex(asRecord(target)?.POSITION),
        ),
      };
    }),
  );
}

/**
 * The meshes that hold the face: those the file's VRM expressions bind
 * (blink, visemes, moods), or, in a file whose expressions bind none, every
 * mesh with morph targets. Other meshes' shape keys (clothing fits, say)
 * never mark a face part.
 */
function faceMeshes(
  json: JsonRecord,
  primitives: readonly Primitive[],
): Set<number> {
  const nodes = asArray(json.nodes);
  const expressions = asRecord(
    asRecord(asRecord(json.extensions)?.VRMC_vrm)?.expressions,
  );
  const meshes = new Set<number>();
  for (const group of [expressions?.preset, expressions?.custom]) {
    for (const expression of Object.values(asRecord(group) ?? {})) {
      for (const bind of asArray(asRecord(expression)?.morphTargetBinds)) {
        const node = asIndex(asRecord(bind)?.node);
        const mesh =
          node === null ? null : asIndex(asRecord(nodes[node])?.mesh);
        if (mesh !== null) meshes.add(mesh);
      }
    }
  }
  if (meshes.size > 0) return meshes;
  for (const primitive of primitives)
    if (primitive.targets.length > 0) meshes.add(primitive.mesh);
  return meshes;
}

/** The face meshes' primitives, each with its target accessors. */
function facePrimitives(
  json: JsonRecord,
  primitives: readonly Primitive[],
): Primitive[] {
  const meshes = faceMeshes(json, primitives);
  return primitives.filter(
    (primitive) => meshes.has(primitive.mesh) && primitive.targets.length > 0,
  );
}

/** The accessors `planUnlitToonShading` reads: the face meshes' targets and their primitives' vertices. */
export function unlitToonAccessorIndices(json: unknown): number[] {
  const root = asRecord(json);
  if (!root) return [];
  const accessors = new Set<number>();
  for (const primitive of facePrimitives(root, primitivesOf(root))) {
    for (const accessor of primitive.targets)
      if (accessor !== null) accessors.add(accessor);
    if (primitive.indices !== null) accessors.add(primitive.indices);
    else if (primitive.position !== null) accessors.add(primitive.position);
  }
  return [...accessors];
}

/** The vertices a POSITION morph target accessor moves. */
function movedVertices(values: AccessorValues): Uint8Array {
  const moved = new Uint8Array(values.count);
  for (let vertex = 0; vertex < values.count; vertex += 1) {
    for (let component = 0; component < values.itemSize; component += 1) {
      if (Math.abs(values.getComponent(vertex, component)) > MOVED_EPSILON) {
        moved[vertex] = 1;
        break;
      }
    }
  }
  return moved;
}

/**
 * Which materials of an unlit-only file get toon shading, and which look.
 *
 * Face parts are the primitives of the face meshes (`faceMeshes`) whose
 * drawn vertices one of their morph targets moves: the face skin, eyes,
 * lashes, the mouth. A converted MMD model is usually one mesh, so all of its
 * shapes count, including pupil shapes no expression binds. The largest
 * of them with a texture is the face skin; the others stay unlit, since
 * shading and outlines would darken and ring them. Every other textured,
 * non-blended material gets the body look. A material drawn by both the face
 * skin and other parts takes the face look. `read` returns an accessor's
 * values, or null when it cannot be read (that primitive then counts as not
 * moved). Returns an empty plan for a file that does not take toon shading
 * (`takesUnlitToonShading`).
 */
export function planUnlitToonShading(
  json: unknown,
  read: (accessor: number) => AccessorValues | null,
): Map<number, UnlitToonLook> {
  const plan = new Map<number, UnlitToonLook>();
  const root = asRecord(json);
  if (!root || !takesUnlitToonShading(root)) return plan;
  const materials = asArray(root.materials);
  const primitives = primitivesOf(root);
  const faces = new Set(facePrimitives(root, primitives));
  // Primitives of one converted mesh usually share their target accessors,
  // so each set's moved vertices are found once.
  const movedByTargets = new Map<string, Uint8Array | null>();
  const movedBy = (targets: readonly (number | null)[]): Uint8Array | null => {
    const key = targets.join(",");
    if (!movedByTargets.has(key)) {
      const masks = targets.flatMap((accessor) => {
        const values = accessor === null ? null : read(accessor);
        return values ? [movedVertices(values)] : [];
      });
      let union: Uint8Array | null = null;
      if (masks.length > 0) {
        union = new Uint8Array(Math.max(...masks.map((mask) => mask.length)));
        for (const mask of masks)
          for (let vertex = 0; vertex < mask.length; vertex += 1)
            if (mask[vertex]) union[vertex] = 1;
      }
      movedByTargets.set(key, union);
    }
    return movedByTargets.get(key)!;
  };

  /**
   * How many vertices a face mesh's primitive draws (its size) when one of
   * its morph targets moves any of them, else -1.
   */
  const faceSize = (primitive: Primitive): number => {
    if (!faces.has(primitive)) return -1;
    const moved = movedBy(primitive.targets);
    if (!moved) return -1;
    const indices = primitive.indices === null ? null : read(primitive.indices);
    if (indices) {
      for (let index = 0; index < indices.count; index += 1)
        if (moved[indices.getComponent(index, 0)]) return indices.count;
      return -1;
    }
    const count =
      primitive.position === null ? 0 : (read(primitive.position)?.count ?? 0);
    for (let vertex = 0; vertex < count; vertex += 1)
      if (moved[vertex]) return count;
    return -1;
  };

  const sizes = primitives.map(faceSize);
  let faceSkin = -1;
  primitives.forEach((primitive, index) => {
    if (sizes[index]! < 0 || primitive.material === null) return;
    if (!takesToon(materials[primitive.material])) return;
    if (faceSkin < 0 || sizes[index]! > sizes[faceSkin]!) faceSkin = index;
  });

  primitives.forEach((primitive, index) => {
    const material = primitive.material;
    if (material === null || !takesToon(materials[material])) return;
    if (index === faceSkin) plan.set(material, "face");
    else if (sizes[index]! < 0 && !plan.has(material))
      plan.set(material, "body");
  });
  return plan;
}

/**
 * Write MToon into each planned material of `json` (three-vrm then drops its
 * `KHR_materials_unlit`). The lit colour is the base colour raised by
 * `LIT_GAIN`; the shaded side multiplies the same texture by the look's tint.
 */
export function applyUnlitToonShading(
  json: unknown,
  plan: ReadonlyMap<number, UnlitToonLook>,
): void {
  const materials = asArray(asRecord(json)?.materials);
  for (const [index, look] of plan) {
    const material = asRecord(materials[index]);
    const pbr = asRecord(material?.pbrMetallicRoughness);
    const texture = asRecord(pbr?.baseColorTexture);
    if (!material || !pbr || !texture) continue;
    const parameters = LOOKS[look];
    const base = asArray(pbr.baseColorFactor);
    const [red, green, blue, alpha] = [0, 1, 2, 3].map((channel) =>
      typeof base[channel] === "number" ? (base[channel] as number) : 1,
    ) as [number, number, number, number];
    pbr.baseColorFactor = [
      red * LIT_GAIN,
      green * LIT_GAIN,
      blue * LIT_GAIN,
      alpha,
    ];
    material.extensions = {
      ...asRecord(material.extensions),
      VRMC_materials_mtoon: {
        specVersion: "1.0",
        // MToon lights both sides alike, so the shade takes the gain too.
        shadeColorFactor: parameters.shade.map(
          (value, channel) => value * [red, green, blue][channel]! * LIT_GAIN,
        ),
        shadeMultiplyTexture: { ...texture },
        shadingShiftFactor: parameters.shadingShift,
        shadingToonyFactor: parameters.shadingToony,
        giEqualizationFactor: 0.9,
        parametricRimColorFactor: parameters.rim,
        parametricRimFresnelPowerFactor: 4,
        parametricRimLiftFactor: 0,
        rimLightingMixFactor: 0.5,
        outlineWidthMode: "screenCoordinates",
        outlineWidthFactor: parameters.outlineWidth,
        outlineColorFactor: parameters.outlineColor,
        outlineLightingMixFactor: 0.6,
      },
    };
  }
}

const loadedStates = new WeakMap<GLTFParser, UnlitToonState>();

/** How a loaded file's unlit materials rendered (`withUnlitToonShading`). */
export function unlitToonStateOf(gltf: GLTF): UnlitToonState {
  return loadedStates.get(gltf.parser) ?? "none";
}

/**
 * Give a file that `takesUnlitToonShading` toon shading in `plugin`'s glTF
 * when `apply` (the Materials setting is not Simple), before three-vrm builds
 * any material. It runs after the VRM 0.x compat step and after any patch
 * `plugin` already carries there (the app's loader wraps the enhanced
 * retune). Reading the face's morph targets waits for the file's decoders; a
 * file whose accessors cannot be read keeps its unlit materials.
 */
export function withUnlitToonShading(
  plugin: VRMLoaderPlugin,
  apply: boolean,
): VRMLoaderPlugin {
  const v0Compat = plugin.materialsV0CompatPlugin;
  const convertV0Materials = v0Compat.beforeRoot.bind(v0Compat);
  v0Compat.beforeRoot = async () => {
    await convertV0Materials();
    const parser = plugin.parser;
    const json: unknown = parser.json;
    if (!takesUnlitToonShading(json)) return;
    if (!apply) {
      loadedStates.set(parser, "simple");
      return;
    }
    try {
      await prepareAvatarFile(parser);
      const accessors = new Map<number, AccessorValues>();
      await Promise.all(
        unlitToonAccessorIndices(json).map(async (index) => {
          accessors.set(index, await parser.getDependency("accessor", index));
        }),
      );
      const plan = planUnlitToonShading(
        json,
        (index) => accessors.get(index) ?? null,
      );
      applyUnlitToonShading(json, plan);
      loadedStates.set(parser, "toon");
      logger.info("Load", "Unlit materials got toon shading", {
        reason: "avatar_unlit_toon_shaded",
        face: [...plan.values()].filter((look) => look === "face").length,
        body: [...plan.values()].filter((look) => look === "body").length,
        materials: asArray(asRecord(json)?.materials).length,
      });
    } catch (error) {
      // The file's own load reports a file it cannot read.
      logger.debug("Load", "Unlit materials kept: accessors unreadable", {
        reason: "avatar_unlit_toon_unchecked",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return plugin;
}
