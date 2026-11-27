import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Avatar } from "../Avatar";
import { appendTriangle } from "../testing/appendTriangle";
import { addBlinkStrand, blinkTargets } from "../testing/blinkStrand";
import { loadedTestAvatar } from "../testing/loadedTestAvatar";
import { markAnimamaConversion } from "../testing/markConversion";
import { removeEyeBones } from "../testing/removeEyeBones";
import { buildRuntimePrimitiveBindings } from "../vrmEditorInspection";
import type { RuntimePrimitiveBindingEntry } from "./avatarPrimitiveUtils";
import { PrimitiveRegionHider } from "./primitiveRegionHiding";

const unique = <T>(values: readonly T[]) => Array.from(new Set(values));

/**
 * Face parts on models built unlike VRoid exports, made from the Included
 * Avatars with synthetic additions: lashes and lines inside the face mesh, a
 * face skinned partly to the neck, no eye bones.
 */

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function headOf(avatar: Avatar): THREE.Object3D {
  return avatar.vrm!.humanoid.getNormalizedBoneNode("head")!;
}

function entryOf(avatar: Avatar, key: string): RuntimePrimitiveBindingEntry {
  return buildRuntimePrimitiveBindings(avatar).entries.find(
    (entry) => entry.bindingKey === key,
  )!;
}

function eyeCenters(avatar: Avatar): THREE.Vector3[] {
  const { left, right } = avatar.getFaceLandmarksSnapshot()!.eyes;
  return [left!, right!].map((eye) =>
    new THREE.Vector3().copy(eye.centerLocal),
  );
}

/** How far blink moves a face primitive's farthest vertex: its lids' travel. */
function lidTravel(avatar: Avatar, face: RuntimePrimitiveBindingEntry): number {
  const targets = face.object.geometry.morphAttributes.position!;
  const delta = new THREE.Vector3();
  let farthest = 0;
  for (const index of blinkTargets(avatar, face.object)) {
    const target = targets[index]!;
    for (let vertex = 0; vertex < target.count; vertex += 1) {
      farthest = Math.max(
        farthest,
        delta.fromBufferAttribute(target, vertex).length(),
      );
    }
  }
  return farthest;
}

/** The vertices a primitive's triangles use. */
function primitiveVertices(entry: RuntimePrimitiveBindingEntry): number[] {
  const index = entry.object.geometry.getIndex()!;
  return unique(Array.from(index.array));
}

/**
 * Skin `share` of each of a primitive's vertices to the head bone and the
 * rest to the joint it used, as an eye mesh whose whites and lids follow the
 * head while its irises follow the eye bones. The weights are copied first:
 * a mesh's primitives may share them.
 */
function skinPartlyToHead(
  avatar: Avatar,
  entry: RuntimePrimitiveBindingEntry,
  share: number,
): void {
  const mesh = entry.object as THREE.SkinnedMesh;
  const head = mesh.skeleton.bones.indexOf(
    avatar.vrm!.humanoid.getRawBoneNode("head") as THREE.Bone,
  );
  const geometry = mesh.geometry;
  const joints = geometry.getAttribute("skinIndex").clone();
  const weights = geometry.getAttribute("skinWeight").clone();
  geometry.setAttribute("skinIndex", joints);
  geometry.setAttribute("skinWeight", weights);
  for (const vertex of primitiveVertices(entry)) {
    joints.setXYZW(vertex, joints.getX(vertex), head, 0, 0);
    weights.setXYZW(vertex, 1 - share, share, 0, 0);
  }
}

/**
 * Push a primitive `depth` m into the head, behind the face, along the head's
 * front axis (+z on the VRM 1 test Avatar). Positions are copied first.
 */
function pushIntoHead(
  avatar: Avatar,
  entry: RuntimePrimitiveBindingEntry,
  depth: number,
): void {
  const mesh = entry.object;
  const anchor = headOf(avatar);
  mesh.updateWorldMatrix(true, false);
  anchor.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute("position").clone();
  mesh.geometry.setAttribute("position", position);
  const point = new THREE.Vector3();
  for (const vertex of primitiveVertices(entry)) {
    point.fromBufferAttribute(position, vertex);
    anchor.worldToLocal(mesh.localToWorld(point));
    point.z -= depth;
    mesh.worldToLocal(anchor.localToWorld(point));
    position.setXYZ(vertex, point.x, point.y, point.z);
  }
}

describe("eye details inside the face mesh", () => {
  it("finds lash strands blink moves as regions of the face skin", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    const face = entryOf(avatar, before.face_skin.bindings[0]!);
    const firstNew = face.object.geometry.getIndex()!.count / 3;
    for (const eye of eyeCenters(avatar))
      addBlinkStrand(avatar, face, eye, 0.01);
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    expect(parts.eyelash).toMatchObject({
      source: "signals",
      bindings: [],
      regions: [
        { bindingKey: face.bindingKey, triangles: [firstNew, firstNew + 1] },
      ],
    });
    // The eye line keeps its own mesh; nothing else changes.
    expect(parts.eyeline.bindings).toEqual(before.eyeline.bindings);
    expect(parts.eyeline.regions).toBeUndefined();
    expect(parts.face_skin.bindings).toEqual(before.face_skin.bindings);
  });

  it("finds the regions again while an effect has them hidden", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const face = entryOf(
      avatar,
      avatar.facePartMap!.parts.face_skin.bindings[0]!,
    );
    for (const eye of eyeCenters(avatar))
      addBlinkStrand(avatar, face, eye, 0.01);
    await avatar.setFacePartCorrections(null);
    const regions = avatar.facePartMap!.parts.eyelash.regions!;

    // An eye effect is hiding the strands when a correction is saved.
    const hider = new PrimitiveRegionHider();
    hider.hide("effect", face.object.geometry, regions[0]!.triangles);
    avatar.vfxController = {
      restoreHiddenRegions: () => hider.restoreAll(),
      refreshFaceParts: async () => {},
    } as unknown as Avatar["vfxController"];
    await avatar.setFacePartCorrections(null);

    expect(avatar.facePartMap!.parts.eyelash.regions).toEqual(regions);
  });

  it("finds regions in an unindexed face mesh", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const face = entryOf(
      avatar,
      avatar.facePartMap!.parts.face_skin.bindings[0]!,
    );
    for (const eye of eyeCenters(avatar))
      addBlinkStrand(avatar, face, eye, 0.01);
    face.object.geometry = face.object.geometry.toNonIndexed();
    await avatar.setFacePartCorrections(null);

    const triangles = face.object.geometry.getAttribute("position").count / 3;
    expect(avatar.facePartMap!.parts.eyelash.regions).toEqual([
      {
        bindingKey: face.bindingKey,
        triangles: [triangles - 2, triangles - 1],
      },
    ]);
  });

  it("takes each eye's largest region as its line when no line mesh exists", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    const face = entryOf(avatar, before.face_skin.bindings[0]!);
    // Detach the eye-line mesh from blink, as if the model had none.
    const line = entryOf(avatar, before.eyeline.bindings[0]!).object;
    for (const bind of avatar.vrm!.expressionManager!.getExpression("blink")!
      .binds as unknown as { primitives?: THREE.Object3D[] }[]) {
      bind.primitives = bind.primitives?.filter((mesh) => mesh !== line);
    }
    const travel = lidTravel(avatar, face);
    const firstNew = face.object.geometry.getIndex()!.count / 3;
    for (const eye of eyeCenters(avatar)) {
      addBlinkStrand(avatar, face, eye, 0.02); // the line
      addBlinkStrand(avatar, face, eye, 0.006, { above: 0.016 }); // a lash above it
      // A wider lower lash that follows the lid part way is never the line.
      addBlinkStrand(avatar, face, eye, 0.03, {
        above: -0.008,
        drop: travel * 0.15,
      });
    }
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    expect(parts.eyeline.regions).toEqual([
      { bindingKey: face.bindingKey, triangles: [firstNew, firstNew + 3] },
    ]);
    expect(parts.eyelash.regions).toEqual([
      {
        bindingKey: face.bindingKey,
        triangles: [firstNew + 1, firstNew + 2, firstNew + 4, firstNew + 5],
      },
    ]);
  });

  it("finds lashes that follow the lid only part of the way", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const face = entryOf(
      avatar,
      avatar.facePartMap!.parts.face_skin.bindings[0]!,
    );
    const travel = lidTravel(avatar, face);
    const firstNew = face.object.geometry.getIndex()!.count / 3;
    for (const eye of eyeCenters(avatar)) {
      // A lower lash under the eye, which blink barely moves...
      addBlinkStrand(avatar, face, eye, 0.006, {
        above: -0.008,
        drop: travel * 0.15,
      });
      // ...and an eyeliner wing past the outer corner, moved under half as far.
      const corner = eye.clone().setX(eye.x + Math.sign(eye.x) * 0.016);
      addBlinkStrand(avatar, face, corner, 0.006, {
        above: 0.004,
        drop: travel * 0.4,
      });
    }
    await avatar.setFacePartCorrections(null);

    expect(avatar.facePartMap!.parts.eyelash.regions).toEqual([
      {
        bindingKey: face.bindingKey,
        triangles: [firstNew, firstNew + 1, firstNew + 2, firstNew + 3],
      },
    ]);
  });

  // The middle of each Avatar's own brow (its FaceBrow primitive) above the
  // eye centre: Annie's tall lids reach past the brow's lower edge.
  it.each([
    ["Annie", 0.029],
    ["Andrew", 0.025],
  ] as const)(
    "leaves out a brow at %s's brow height that blink drags part way",
    async (id, browHeight) => {
      const avatar = await loadedTestAvatar(id);
      const face = entryOf(
        avatar,
        avatar.facePartMap!.parts.face_skin.bindings[0]!,
      );
      const travel = lidTravel(avatar, face);
      const firstNew = face.object.geometry.getIndex()!.count / 3;
      for (const eye of eyeCenters(avatar)) {
        addBlinkStrand(avatar, face, eye, 0.01); // a lash, found as before
        addBlinkStrand(avatar, face, eye, 0.03, {
          above: browHeight,
          drop: travel * 0.3,
        });
      }
      await avatar.setFacePartCorrections(null);

      expect(avatar.facePartMap!.parts.eyelash.regions).toEqual([
        { bindingKey: face.bindingKey, triangles: [firstNew, firstNew + 2] },
      ]);
    },
  );
});

/** Take `mesh` out of `expression`'s binds, so that expression no longer morphs it. */
function unbind(
  avatar: Avatar,
  expression: string,
  mesh: THREE.Object3D,
): void {
  for (const bind of avatar.vrm!.expressionManager!.getExpression(expression)!
    .binds as unknown as { primitives?: THREE.Object3D[] }[]) {
    bind.primitives = bind.primitives?.filter(
      (primitive) => primitive !== mesh,
    );
  }
}

// A MikuMikuDance model converted by Animama Avatar Converter keeps each
// material in a mesh of its own, so blink morphs its lash mesh while aa, which
// moves only the mouth, does not.
describe("eye details in meshes blink alone morphs", () => {
  it("finds an eye-line mesh aa does not morph island by island", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    const line = entryOf(avatar, before.eyeline.bindings[0]!);
    unbind(avatar, "aa", line.object);
    markAnimamaConversion(avatar);
    await avatar.setFacePartCorrections(null);

    // Never the whole mesh, which could also hold brows or eyes; every
    // triangle of it that blink lowers with the lid is a line or lash region.
    const parts = avatar.facePartMap!.parts;
    expect(parts.eyeline.bindings).toEqual([]);
    const hidden = [parts.eyeline, parts.eyelash]
      .flatMap((part) => part.regions ?? [])
      .filter((region) => region.bindingKey === line.bindingKey)
      .flatMap((region) => region.triangles)
      .sort((a, b) => a - b);
    const count = line.object.geometry.getIndex()!.count / 3;
    expect(hidden).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(parts.face_skin.bindings).toEqual(before.face_skin.bindings);
  });

  it("finds lash strands in a mesh shared with the brows and leaves the brows", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    const brow = buildRuntimePrimitiveBindings(avatar).entries.find((entry) =>
      [entry.object.material].flat()[0]?.name.includes("FaceBrow"),
    )!;
    unbind(avatar, "aa", brow.object);
    const firstNew = brow.object.geometry.getIndex()!.count / 3;
    for (const eye of eyeCenters(avatar))
      addBlinkStrand(avatar, brow, eye, 0.01);
    markAnimamaConversion(avatar);
    await avatar.setFacePartCorrections(null);

    // The brow itself, which blink drags part way, stays.
    const parts = avatar.facePartMap!.parts;
    expect(parts.eyeline.bindings).toEqual(before.eyeline.bindings);
    expect(parts.eyelash.bindings).toEqual(before.eyelash.bindings);
    expect(parts.eyelash.regions).toEqual([
      { bindingKey: brow.bindingKey, triangles: [firstNew, firstNew + 1] },
    ]);
    expect(parts.face_skin.bindings).toEqual(before.face_skin.bindings);
  });

  it("searches no such mesh on an Avatar the converter did not write", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const brow = buildRuntimePrimitiveBindings(avatar).entries.find((entry) =>
      [entry.object.material].flat()[0]?.name.includes("FaceBrow"),
    )!;
    unbind(avatar, "aa", brow.object);
    for (const eye of eyeCenters(avatar))
      addBlinkStrand(avatar, brow, eye, 0.01);
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    expect(
      [parts.eyeline, parts.eyelash].flatMap((part) => part.regions ?? []),
    ).toEqual([]);
  });
});

describe("a face skinned partly to the neck", () => {
  it("is still the face skin, with bounds from its head vertices", async () => {
    const avatar = await loadedTestAvatar("Andrew");
    const before = avatar.facePartMap!.parts.face_skin;
    const bounds = avatar.getFaceLandmarksSnapshot()!.faceBoundsLocal!;
    const face = entryOf(avatar, before.bindings[0]!);
    const mesh = face.object as THREE.SkinnedMesh;
    const neck = mesh.skeleton.bones.indexOf(
      avatar.vrm!.humanoid.getRawBoneNode("neck")! as THREE.Bone,
    );
    expect(neck).toBeGreaterThanOrEqual(0);

    // A neck below the chin in the same primitive...
    const chin = bounds.min.y;
    appendTriangle({
      avatar,
      binding: face,
      anchor: headOf(avatar),
      corners: [
        new THREE.Vector3(-0.06, chin - 0.12, 0),
        new THREE.Vector3(0.06, chin - 0.12, 0),
        new THREE.Vector3(0, chin - 0.01, 0),
      ],
      uv: [
        [0.2, 0.9],
        [0.3, 0.9],
        [0.25, 0.8],
      ],
      joint: neck,
    });
    // ...and enough neck-weighted vertices that under 90% of the weight is
    // on the head: the old rule found no face here.
    const skinIndex = mesh.geometry.getAttribute("skinIndex");
    const skinWeight = mesh.geometry.getAttribute("skinWeight");
    const reweighted = Math.ceil(skinIndex.count * 0.2);
    for (let vertex = 0; vertex < reweighted; vertex += 1) {
      skinIndex.setXYZW(vertex, neck, 0, 0, 0);
      skinWeight.setXYZW(vertex, 1, 0, 0, 0);
    }
    await avatar.setFacePartCorrections(null);

    expect(avatar.facePartMap!.parts.face_skin).toMatchObject({
      source: "signals",
      bindings: before.bindings,
    });
    const after = avatar.getFaceLandmarksSnapshot()!;
    expect(after.status).toBe("ready");
    // The neck triangle does not stretch the face down.
    expect(after.faceBoundsLocal!.min.y).toBeGreaterThan(chin - 0.005);
    expect(after.faceBoundsLocal!.max.y).toBeCloseTo(bounds.max.y, 4);
  });
});

describe("hair merged into the face mesh", () => {
  it("never becomes the face skin", async () => {
    for (const id of ["Andrew", "Annie"] as const) {
      const avatar = await loadedTestAvatar(id);
      const before = avatar.facePartMap!.parts;
      // A merged mesh binds blink and aa to every primitive, hair included.
      const hair = before.hair.bindings.map(
        (key) => entryOf(avatar, key).object,
      );
      for (const name of ["blink", "aa"]) {
        for (const bind of avatar.vrm!.expressionManager!.getExpression(name)!
          .binds as unknown as { primitives?: THREE.Object3D[] }[]) {
          bind.primitives?.push(...hair);
        }
      }
      await avatar.setFacePartCorrections(null);
      expect(avatar.facePartMap!.parts.face_skin.bindings).toEqual(
        before.face_skin.bindings,
      );
    }
  });
});

describe("a model without eye bones", () => {
  it("finds the eyes when blink moves only the upper lids", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    const eyeY = eyeCenters(avatar)[0]!.y;
    removeEyeBones(avatar);
    // Blink leaves everything below the eyes still: the upper lid closes
    // onto a lower lid that does not move.
    const face = entryOf(avatar, before.face_skin.bindings[0]!);
    const mesh = face.object;
    const position = mesh.geometry.getAttribute("position");
    const anchor = headOf(avatar);
    mesh.updateWorldMatrix(true, false);
    anchor.updateWorldMatrix(true, false);
    const point = new THREE.Vector3();
    for (const index of blinkTargets(avatar, mesh)) {
      const target = mesh.geometry.morphAttributes.position![index]!;
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        point.fromBufferAttribute(position, vertex);
        anchor.worldToLocal(mesh.localToWorld(point));
        if (point.y < eyeY) target.setXYZ(vertex, 0, 0, 0);
      }
    }
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    for (const role of ["eye_left", "eye_right", "eye_highlight"] as const) {
      expect(parts[role].bindings).toEqual(before[role].bindings);
    }
  });

  it("finds each eye from where blink moves the face", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    removeEyeBones(avatar);
    expect(avatar.vrm!.humanoid.getRawBoneNode("leftEye")).toBeNull();
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    for (const role of ["eye_left", "eye_right", "eye_highlight"] as const) {
      expect(parts[role]).toMatchObject({
        source: "signals",
        bindings: before[role].bindings,
      });
    }
    expect(parts.face_skin.bindings).toEqual(before.face_skin.bindings);
    expect(avatar.getFaceLandmarksSnapshot()?.eyes.left).not.toBeNull();
  });
});

describe("lashes painted into the face texture", () => {
  it("widens eye cleanup to the eyelids blink moves", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.getFaceTextureAnchorsSnapshot()!.flatten.eyes.left!;
    // With the eye-line mesh out of blink and its material unnamed, the model
    // has no line or lash geometry, as one whose lashes are painted on the face.
    const parts = avatar.facePartMap!.parts;
    const line = entryOf(avatar, parts.eyeline.bindings[0]!).object;
    for (const material of [line.material].flat()) material.name = "Material";
    for (const bind of avatar.vrm!.expressionManager!.getExpression("blink")!
      .binds as unknown as { primitives?: THREE.Object3D[] }[]) {
      bind.primitives = bind.primitives?.filter((mesh) => mesh !== line);
    }
    await avatar.setFacePartCorrections(null);
    expect(avatar.facePartMap!.parts.eyeline.source).toBe("missing");

    const after = avatar.getFaceTextureAnchorsSnapshot()!.flatten.eyes.left!;
    expect(after.referenceSizeLocal.width).toBeGreaterThan(
      before.referenceSizeLocal.width,
    );
    expect(after.referenceSizeLocal.height).toBeGreaterThan(
      before.referenceSizeLocal.height,
    );
  });
});

describe("eye layers found without eye bones", () => {
  it("never takes a primitive reaching past the eyes as one", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    removeEyeBones(avatar);
    // No eye layers to find (eyes painted on the face), and the mouth
    // primitive gains a wide triangle across both eyes, as glasses or a
    // fringe drawn in another primitive would reach over them.
    for (const key of unique([
      ...before.eye_left.bindings,
      ...before.eye_highlight.bindings,
      ...avatar.facePartMap!.eyeWhite,
    ])) {
      entryOf(avatar, key).object.removeFromParent();
    }
    const target = buildRuntimePrimitiveBindings(avatar).entries.find((entry) =>
      entry.materialName?.includes("FaceMouth"),
    )!;
    const [left, right] = eyeCenters(avatar);
    appendTriangle({
      avatar,
      binding: target,
      anchor: headOf(avatar),
      corners: [
        new THREE.Vector3(left!.x + 0.03, left!.y - 0.01, left!.z + 0.01),
        new THREE.Vector3(right!.x - 0.03, right!.y - 0.01, right!.z + 0.01),
        new THREE.Vector3(0, left!.y + 0.02, left!.z + 0.01),
      ],
      uv: [
        [0.5, 0.5],
        [0.6, 0.5],
        [0.55, 0.6],
      ],
    });
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    for (const role of ["eye_left", "eye_right", "eye_highlight"] as const) {
      expect(parts[role].bindings).not.toContain(target.bindingKey);
    }
    expect(avatar.facePartMap!.eyeWhite).not.toContain(target.bindingKey);
  });

  it("never takes a part deep inside the head behind the lids as one", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    removeEyeBones(avatar);
    // Eyes painted on the face, and a layer 3 cm inside the head behind
    // them, as a converted Avatar keeps a spare pupil or an inner mouth there,
    // or as ears beside the head reach into the eyes' outline. The layer is
    // the eye white, unnamed so that no name marks it.
    for (const key of unique([
      ...before.eye_left.bindings,
      ...before.eye_highlight.bindings,
    ])) {
      entryOf(avatar, key).object.removeFromParent();
    }
    const hidden = buildRuntimePrimitiveBindings(avatar).entries.find((entry) =>
      entry.materialName?.includes("EyeWhite"),
    )!;
    for (const material of [hidden.object.material].flat()) {
      material.name = "Material";
    }
    pushIntoHead(avatar, hidden, 0.03);
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    for (const role of ["eye_left", "eye_right", "eye_highlight"] as const) {
      expect(parts[role].bindings).not.toContain(hidden.bindingKey);
    }
    // The eyes are estimated where blink moves the face instead.
    expect(parts.eye_left.source).toBe("estimated");
  });
});

describe("eye meshes skinned partly to the eye bones", () => {
  it("are found as the eyes where blink moves the face", async () => {
    const avatar = await loadedTestAvatar("Annie");
    const before = avatar.facePartMap!.parts;
    // A VRChat Avatar's eye mesh skins its whites, lids and brows to the head
    // and only its irises to the eye bones: under half of each eye
    // primitive's weight is on an eye bone, and none of it all on the head.
    for (const key of unique([
      ...before.eye_left.bindings,
      ...before.eye_right.bindings,
      ...before.eye_highlight.bindings,
      ...avatar.facePartMap!.eyeWhite,
    ])) {
      skinPartlyToHead(avatar, entryOf(avatar, key), 0.6);
    }
    await avatar.setFacePartCorrections(null);

    const parts = avatar.facePartMap!.parts;
    for (const role of ["eye_left", "eye_right", "eye_highlight"] as const) {
      expect(parts[role]).toMatchObject({
        source: "signals",
        bindings: before[role].bindings,
      });
    }
  });
});
