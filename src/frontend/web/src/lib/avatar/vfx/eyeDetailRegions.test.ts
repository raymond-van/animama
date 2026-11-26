import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Avatar } from "../Avatar";
import { ANIMAMA_CONVERSION_EXTENSION } from "../avatarConversionMarker";
import { addBlinkStrand } from "../testing/blinkStrand";
import { loadedTestAvatar } from "../testing/loadedTestAvatar";
import { buildRuntimePrimitiveBindings } from "../vrmEditorInspection";
import { AvatarVFXController } from "./AvatarVFXController";
import type { RuntimePrimitiveBindingEntry } from "./avatarPrimitiveUtils";
import { parseAvatarEffectDefinition } from "./definition";
import { loadEffectImage } from "./effect-image";
import { applyAvatarVFXEffectById } from "./runtime";
import { baseTextureOf } from "./textureUvMapping";

vi.mock("./effect-image", () => ({ loadEffectImage: vi.fn() }));

/**
 * Eye effects hide eye lines and lashes found as regions of a mesh that holds
 * no face part of its own: a converted MikuMikuDance model's lash mesh, which
 * blink alone morphs and which may also hold the brows or the eyes. On such a
 * model they also cover each closed eye with a skin patch.
 */

/** A canvas whose 2D context accepts every call. */
class StubCanvas {
  width = 256;
  height = 256;
  getContext() {
    const state: Record<string | symbol, unknown> = {
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillStyle: "",
      getImageData: (
        _x: number,
        _y: number,
        width: number,
        height: number,
      ) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(200),
      }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(state, {
      get: (target, key) => (key in target ? target[key] : () => {}),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    });
  }
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("HTMLCanvasElement", StubCanvas);
  vi.stubGlobal(
    "Path2D",
    class {
      moveTo() {}
      lineTo() {}
      closePath() {}
    },
  );
  vi.stubGlobal("document", { createElement: () => new StubCanvas() });
  vi.mocked(loadEffectImage).mockImplementation(
    async () => new StubCanvas() as unknown as HTMLCanvasElement,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HEART_EYES = parseAvatarEffectDefinition(
  {
    schema: "animama/avatar-effect/2",
    region: "eyes",
    attachment: {
      kind: "face_landmark",
      landmark: "eyes",
      mirror: true,
      side: "right",
    },
    art: { image: "heart-eyes.png" },
  },
  {
    id: "heart-eyes",
    label: "heart-eyes",
    description: "",
    assetPath: "blob:heart-eyes",
  },
);

/** Whether a primitive still draws `triangle` (hidden ones are degenerate). */
function drawn(entry: RuntimePrimitiveBindingEntry, triangle: number): boolean {
  const index = entry.object.geometry.getIndex()!;
  const at = triangle * 3;
  return !(
    index.getX(at) === index.getX(at + 1) &&
    index.getX(at) === index.getX(at + 2)
  );
}

/** Annie with a lash strand over each eye in her brow mesh, which aa no longer morphs. */
async function annieWithLashesInBrows(): Promise<{
  avatar: Avatar;
  brow: RuntimePrimitiveBindingEntry;
  strands: number[];
}> {
  const avatar = await loadedTestAvatar("Annie");
  const brow = buildRuntimePrimitiveBindings(avatar).entries.find((entry) =>
    [entry.object.material].flat()[0]?.name.includes("FaceBrow"),
  )!;
  for (const bind of avatar.vrm!.expressionManager!.getExpression("aa")!
    .binds as unknown as { primitives?: THREE.Object3D[] }[]) {
    bind.primitives = bind.primitives?.filter(
      (primitive) => primitive !== brow.object,
    );
  }
  const firstNew = brow.object.geometry.getIndex()!.count / 3;
  const { left, right } = avatar.getFaceLandmarksSnapshot()!.eyes;
  for (const eye of [left!, right!])
    addBlinkStrand(
      avatar,
      brow,
      new THREE.Vector3().copy(eye.centerLocal),
      0.01,
    );
  await avatar.setFacePartCorrections(null);
  const face = buildRuntimePrimitiveBindings(avatar).entries.find(
    (entry) =>
      entry.bindingKey === avatar.facePartMap!.parts.face_skin.bindings[0],
  )!;
  baseTextureOf(face.object)!.image = new StubCanvas();
  return { avatar, brow, strands: [firstNew, firstNew + 1] };
}

describe("eye effects on lashes inside a mesh holding no face part", () => {
  it("hide the lash regions and keep the brows, until the effect ends", async () => {
    const { avatar, brow, strands } = await annieWithLashesInBrows();
    expect(avatar.facePartMap!.parts.eyelash.regions).toEqual([
      { bindingKey: brow.bindingKey, triangles: strands },
    ]);
    const browTriangles = Array.from(
      { length: strands[0]! },
      (_, index) => index,
    );

    const controller = new AvatarVFXController(avatar);
    avatar.vfxController = controller;
    expect(
      await applyAvatarVFXEffectById({
        avatar,
        effectId: HEART_EYES.id,
        effectEntry: HEART_EYES,
      }),
    ).toBe(true);
    expect(controller.getSnapshot().warnings).toEqual([]);
    expect(strands.some((triangle) => drawn(brow, triangle))).toBe(false);
    expect(brow.object.visible).toBe(true);
    expect(browTriangles.every((triangle) => drawn(brow, triangle))).toBe(true);

    controller.clearAllEffects();
    expect(strands.every((triangle) => drawn(brow, triangle))).toBe(true);
  });
});

/** Mark the Avatar as converted by Animama Avatar Converter, then find its face again. */
async function markConverted(avatar: Avatar): Promise<void> {
  const json = avatar.sourceGltf!.parser.json as { extensionsUsed?: string[] };
  json.extensionsUsed = [
    ...(json.extensionsUsed ?? []),
    ANIMAMA_CONVERSION_EXTENSION,
  ];
  await avatar.setFacePartCorrections(null);
}

/** Where `object` is in the face landmarks' anchor (head) space. */
function inAnchorSpace(avatar: Avatar, object: THREE.Object3D): THREE.Vector3 {
  avatar.vrm!.scene.updateMatrixWorld(true);
  const anchor = avatar.faceLandmarks!.getAnchorObject()!;
  return anchor.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
}

/** The scene objects whose name ends with `suffix`. */
function named(avatar: Avatar, suffix: string): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  avatar.vrm!.scene.traverse((object) => {
    if (object.name.endsWith(suffix)) found.push(object);
  });
  return found;
}

async function applyHeartEyes(
  avatar: Avatar,
  entry: typeof HEART_EYES = HEART_EYES,
): Promise<AvatarVFXController> {
  const controller = new AvatarVFXController(avatar);
  avatar.vfxController = controller;
  expect(
    await applyAvatarVFXEffectById({
      avatar,
      effectId: entry.id,
      effectEntry: entry,
    }),
  ).toBe(true);
  expect(controller.getSnapshot().warnings).toEqual([]);
  return controller;
}

describe("closed-eye skin patches on a converted MikuMikuDance model", () => {
  it("measure each eye's cover, open and closed, only on a converted model", async () => {
    const { avatar } = await annieWithLashesInBrows();
    expect(
      avatar.getFaceLandmarksSnapshot()!.eyes.left!.closedCover,
    ).toBeUndefined();
    await markConverted(avatar);

    const { left, right } = avatar.getFaceLandmarksSnapshot()!.eyes;
    for (const eye of [left!, right!]) {
      const cover = eye.closedCover!.boundsLocal;
      // The iris, and the lash strand both where it rests above the eye and
      // where blink lowers it (2 cm, below the eye's centre).
      expect(cover.min.x).toBeLessThanOrEqual(eye.boundsLocal.min.x + 1e-6);
      expect(cover.max.x).toBeGreaterThanOrEqual(eye.boundsLocal.max.x - 1e-6);
      expect(cover.max.y).toBeGreaterThanOrEqual(eye.centerLocal.y + 0.012);
      expect(cover.min.y).toBeLessThanOrEqual(eye.centerLocal.y - 0.008 + 1e-6);
      expect(eye.closedCover!.frontZLocal).toBeCloseTo(cover.max.z, 6);
    }
  });

  it("puts a skin patch over each closed eye, under the art in front of it", async () => {
    const { avatar } = await annieWithLashesInBrows();
    await markConverted(avatar);
    const { left, right } = avatar.getFaceLandmarksSnapshot()!.eyes;
    const controller = await applyHeartEyes(avatar);

    const patches = named(avatar, ":closed-eye-patch");
    expect(patches.map((patch) => patch.name).sort()).toEqual([
      `${HEART_EYES.id}:left:closed-eye-patch`,
      `${HEART_EYES.id}:right:closed-eye-patch`,
    ]);
    for (const [label, eye] of [
      ["left", left!],
      ["right", right!],
    ] as const) {
      const cover = eye.closedCover!;
      const patch = inAnchorSpace(
        avatar,
        patches.find((object) => object.name.includes(`:${label}:`))!,
      );
      const art = inAnchorSpace(
        avatar,
        named(avatar, `${HEART_EYES.id}:${label}`)[0]!,
      );
      expect(patch.x).toBeCloseTo(cover.boundsLocal.center.x, 4);
      expect(patch.y).toBeCloseTo(cover.boundsLocal.center.y, 4);
      // Just in front of the closed lids and lashes, the art further still.
      expect(patch.z).toBeGreaterThan(cover.frontZLocal);
      expect(art.z).toBeGreaterThan(patch.z);
    }

    controller.clearAllEffects();
    expect(named(avatar, ":closed-eye-patch")).toEqual([]);
  });

  it("adds none on other models or when the effect turns its backdrop off", async () => {
    const unconverted = await annieWithLashesInBrows();
    await applyHeartEyes(unconverted.avatar);
    expect(named(unconverted.avatar, ":closed-eye-patch")).toEqual([]);

    const converted = await annieWithLashesInBrows();
    await markConverted(converted.avatar);
    const withoutBackdrop = parseAvatarEffectDefinition(
      {
        schema: "animama/avatar-effect/2",
        region: "eyes",
        attachment: {
          kind: "face_landmark",
          landmark: "eyes",
          mirror: true,
          side: "right",
        },
        faceOptions: { skinBackdrop: false },
        art: { image: "heart-eyes.png" },
      },
      {
        id: "heart-eyes-bare",
        label: "heart-eyes-bare",
        description: "",
        assetPath: "blob:heart-eyes-bare",
      },
    );
    await applyHeartEyes(converted.avatar, withoutBackdrop);
    expect(named(converted.avatar, ":closed-eye-patch")).toEqual([]);
  });
});
