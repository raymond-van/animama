import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { VRMHumanoid, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { loadTestAvatarWithGltf } from "../../motion-authoring/testing/includedAvatars";
import { prepareLoadedVrm } from "../../prepareLoadedVrm";
import { CanonicalSkeleton, SkeletonPose } from "./arms";
import { handShapeRotations } from "./handPresets";
import { applyCanonicalPose } from "../../motion-authoring/kinematics";
import { AVATAR_POSE_CATALOG, RELAXED_REST_POSE_ID } from "../catalog";
import {
  ARM_REST_TOLERANCE,
  HAND_REST_TOLERANCE,
  installRestNormalization,
} from "./restNormalization";

/**
 * VRoid's left hand in VRM 1.0 axes: each child's offset from its parent
 * (the hand's from the lower arm), as `restNormalization.ts` measures it on Annie.
 */
const VROID_LEFT: Record<string, { parent: string; offset: number[] }> = {
  leftHand: { parent: "leftLowerArm", offset: [0.2, 0, 0] },
  leftIndexProximal: { parent: "leftHand", offset: [0.09, 0.01, 0.025] },
  leftIndexIntermediate: {
    parent: "leftIndexProximal",
    offset: [0.03, 0, -0.0006],
  },
  leftIndexDistal: {
    parent: "leftIndexIntermediate",
    offset: [0.02, -0.0006, -0.0008],
  },
  leftMiddleProximal: { parent: "leftHand", offset: [0.09, 0.01, 0.003] },
  leftMiddleIntermediate: {
    parent: "leftMiddleProximal",
    offset: [0.035, 0, 0],
  },
  leftMiddleDistal: { parent: "leftMiddleIntermediate", offset: [0.024, 0, 0] },
  leftLittleProximal: { parent: "leftHand", offset: [0.08, 0.008, -0.03] },
  leftLittleIntermediate: {
    parent: "leftLittleProximal",
    offset: [0.022, 0, 0],
  },
  leftLittleDistal: { parent: "leftLittleIntermediate", offset: [0.016, 0, 0] },
  leftThumbMetacarpal: { parent: "leftHand", offset: [0.02, -0.01, 0.02] },
  leftThumbProximal: {
    parent: "leftThumbMetacarpal",
    offset: [0.757 * 0.03, -0.044 * 0.03, 0.652 * 0.03],
  },
  leftThumbDistal: {
    parent: "leftThumbProximal",
    offset: [0.785 * 0.025, -0.034 * 0.025, 0.618 * 0.025],
  },
};

/**
 * A minimal VRM 1.0 humanoid (hips to the left hand's digits) whose hand and
 * fingers rest turned by `rest` about the wrist, as a converted model's might.
 */
function rotatedHandRig(
  rest: THREE.Quaternion,
  unmapped: readonly string[] = [],
  /** Turns the forearm and everything below it at the shoulder (an A-pose). */
  armRest: THREE.Quaternion = new THREE.Quaternion(),
): VRM {
  const scene = new THREE.Group();
  const nodes: Record<string, THREE.Object3D> = {};
  const add = (name: string, parent: THREE.Object3D, offset: number[]) => {
    const node = new THREE.Object3D();
    node.name = name;
    node.position.fromArray(offset);
    parent.add(node);
    nodes[name] = node;
  };
  add("hips", scene, [0, 1, 0]);
  add("leftUpperArm", nodes.hips!, [0.2, 0.4, 0]);
  add(
    "leftLowerArm",
    nodes.leftUpperArm!,
    new THREE.Vector3(0.25, 0, 0).applyQuaternion(armRest).toArray(),
  );
  for (const [name, { parent, offset }] of Object.entries(VROID_LEFT)) {
    // The shoulder turns the arm; the wrist turns the hand below it.
    const turn =
      parent === "leftLowerArm" ? armRest : armRest.clone().multiply(rest);
    add(
      name,
      nodes[parent]!,
      new THREE.Vector3().fromArray(offset).applyQuaternion(turn).toArray(),
    );
  }
  scene.updateMatrixWorld(true);
  // An unmapped bone stays in the skeleton but is not a humanoid bone.
  const humanBones = Object.fromEntries(
    Object.entries(nodes)
      .filter(([name]) => !unmapped.includes(name))
      .map(([name, node]) => [name, { node }]),
  ) as unknown as ConstructorParameters<typeof VRMHumanoid>[0];
  const humanoid = new VRMHumanoid(humanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  return { scene, humanoid, meta: { metaVersion: "1" } } as unknown as VRM;
}

/** The drawn direction between two skeleton nodes, mapped or not. */
const rawDirection = (vrm: VRM, from: string, to: string) => {
  vrm.scene.updateMatrixWorld(true);
  const position = (name: string) =>
    vrm.scene.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
  return position(to).sub(position(from)).normalize();
};

/** A unit rotation from rounded components, for test poses. */
const unit = (x: number, y: number, z: number, w: number) =>
  new THREE.Quaternion(x, y, z, w).normalize().toArray();

/** Turned about the forward axis at the shoulder: the arm hangs this far down. */
const armDown = (degrees: number) =>
  new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    (-degrees * Math.PI) / 180,
  );

/**
 * The largest distance between a hand or finger bone's normalized joint and
 * its drawn joint, after the rig's current pose is transferred.
 */
function jointGap(vrm: VRM): number {
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
  let gap = 0;
  for (const bone of ["leftLowerArm", ...Object.keys(VROID_LEFT)]) {
    const normalized = vrm.humanoid.getNormalizedBoneNode(
      bone as VRMHumanBoneName,
    );
    const raw = vrm.humanoid.getRawBoneNode(bone as VRMHumanBoneName);
    if (!normalized || !raw) continue;
    gap = Math.max(
      gap,
      normalized
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(raw.getWorldPosition(new THREE.Vector3())),
    );
  }
  return gap;
}

/** Bent 30° down and rolled 20°: a converted VRChat-style hand rest. */
const TILTED = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-30 * Math.PI) / 180)
  .multiply(
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      (20 * Math.PI) / 180,
    ),
  );

describe("hand rest normalization", () => {
  it("leaves VRoid-like hands, the Included Avatars among them, alone", async () => {
    expect(
      installRestNormalization(rotatedHandRig(new THREE.Quaternion()))
        .normalization,
    ).toBeNull();
    for (const id of ["Annie", "Andrew", "AvatarSample_Y_0"] as const) {
      const { vrm } = await loadTestAvatarWithGltf(id);
      const update = vrm.humanoid.update;
      expect(
        prepareLoadedVrm(vrm, { vrmSha256: null }).restPose.normalization,
      ).toBeNull();
      expect(vrm.humanoid.update, `${id} keeps three-vrm's update`).toBe(
        update,
      );
    }
  });

  it("straightens a turned hand to VRoid's rest", () => {
    const vrm = rotatedHandRig(TILTED);
    const normalization = installRestNormalization(vrm).normalization!;
    expect(normalization.maxDegrees).toBeGreaterThan(
      (HAND_REST_TOLERANCE * 180) / Math.PI,
    );
    expect(installRestNormalization(vrm).normalization, "once per model").toBe(
      normalization,
    );
    vrm.humanoid.update();
    const reference = rotatedHandRig(new THREE.Quaternion());
    reference.humanoid.update();
    for (const [from, to] of [
      ["leftHand", "leftMiddleProximal"],
      ["leftIndexProximal", "leftIndexIntermediate"],
      ["leftThumbProximal", "leftThumbDistal"],
    ]) {
      expect(
        rawDirection(vrm, from!, to!).angleTo(
          rawDirection(reference, from!, to!),
        ),
        `${from} rests as VRoid's`,
      ).toBeLessThan(0.02);
    }
  });

  it("bends fingers and thumbs in VRoid's planes", () => {
    const vrm = rotatedHandRig(TILTED);
    installRestNormalization(vrm);
    const reference = rotatedHandRig(new THREE.Quaternion());
    // A curl and a thumb raise, as hand shapes write them.
    const pose = {
      leftIndexProximal: { rotation: [0, 0, 0.5, 0.866] },
      leftIndexIntermediate: { rotation: [0, 0, 0.6, 0.8] },
      leftThumbProximal: { rotation: [0.3, 0.2, 0, 0.933] },
    } as const;
    for (const rig of [vrm, reference]) {
      rig.humanoid.setNormalizedPose(pose as never);
      rig.humanoid.update();
    }
    for (const [from, to] of [
      ["leftIndexIntermediate", "leftIndexDistal"],
      ["leftThumbProximal", "leftThumbDistal"],
    ]) {
      expect(
        rawDirection(vrm, from!, to!).angleTo(
          rawDirection(reference, from!, to!),
        ),
        `${from} bends as on VRoid`,
      ).toBeLessThan(0.02);
    }
    // The authored rotations stay as written.
    expect(
      vrm.humanoid
        .getNormalizedBoneNode("leftIndexProximal")!
        .quaternion.toArray()
        .map((v) => Number(v.toFixed(3))),
    ).toEqual([0, 0, 0.5, 0.866]);
  });

  it.each(["thumbs-up", "fist", "point"] as const)(
    "shapes a %s on the turned hand as on VRoid's",
    (preset) => {
      const vrm = rotatedHandRig(TILTED);
      installRestNormalization(vrm);
      const reference = rotatedHandRig(new THREE.Quaternion());
      for (const rig of [vrm, reference]) {
        const rotations = handShapeRotations(
          rig,
          "left",
          { preset },
          undefined,
        );
        rig.humanoid.setNormalizedPose(
          Object.fromEntries(
            [...rotations].map(([bone, rotation]) => [
              bone,
              { rotation: rotation.toArray() },
            ]),
          ) as never,
        );
        rig.humanoid.update();
      }
      for (const [from, to] of [
        ["leftThumbProximal", "leftThumbDistal"],
        ["leftIndexIntermediate", "leftIndexDistal"],
        ["leftLittleIntermediate", "leftLittleDistal"],
      ]) {
        expect(
          rawDirection(vrm, from!, to!).angleTo(
            rawDirection(reference, from!, to!),
          ),
          `${preset}: ${from}`,
        ).toBeLessThan(0.03);
      }
    },
  );

  it("bends the idle catalog pose's fingers as on VRoid's", () => {
    const vrm = rotatedHandRig(TILTED);
    installRestNormalization(vrm);
    const reference = rotatedHandRig(new THREE.Quaternion());
    const relaxedRest = AVATAR_POSE_CATALOG[RELAXED_REST_POSE_ID]!.humanoid!;
    for (const rig of [vrm, reference]) applyCanonicalPose(rig, relaxedRest);
    for (const [from, to] of [
      ["leftThumbProximal", "leftThumbDistal"],
      ["leftIndexIntermediate", "leftIndexDistal"],
      ["leftLittleIntermediate", "leftLittleDistal"],
    ]) {
      expect(
        rawDirection(vrm, from!, to!).angleTo(
          rawDirection(reference, from!, to!),
        ),
        `relaxedRest: ${from}`,
      ).toBeLessThan(0.03);
    }
    expect(jointGap(vrm)).toBeLessThan(1e-6);
  });

  it.each([
    ["an intermediate", ["leftIndexIntermediate"]],
    ["a metacarpal", ["leftThumbMetacarpal"]],
  ])(
    "keeps the drawn hand on the normalized one without %s bone",
    (_, unmapped) => {
      const vrm = rotatedHandRig(TILTED, unmapped);
      expect(installRestNormalization(vrm).normalization).not.toBeNull();
      const reference = rotatedHandRig(new THREE.Quaternion(), unmapped);
      const pose = {
        leftIndexProximal: { rotation: [0, 0, 0.5, 0.866] },
        leftThumbProximal: { rotation: [0.3, 0.2, 0, 0.933] },
      } as const;
      for (const rig of [vrm, reference]) {
        rig.humanoid.setNormalizedPose(pose as never);
        rig.humanoid.update();
      }
      expect(jointGap(vrm)).toBeLessThan(1e-6);
      for (const [from, to] of [
        ["leftIndexProximal", "leftIndexDistal"],
        ["leftThumbProximal", "leftThumbDistal"],
      ]) {
        expect(
          rawDirection(vrm, from!, to!).angleTo(
            rawDirection(reference, from!, to!),
          ),
          `${unmapped[0]} missing: ${from}`,
        ).toBeLessThan(0.03);
      }
    },
  );

  it("moves an A-posed arm through Gestures as a T-posed one", () => {
    const vrm = rotatedHandRig(new THREE.Quaternion(), [], armDown(40));
    const check = installRestNormalization(vrm);
    expect(check.armDegrees).toBeGreaterThan(
      (ARM_REST_TOLERANCE * 180) / Math.PI,
    );
    expect(check.armsNormalized).toBe(true);
    // The hand rests as VRoid's on its forearm: carried, not corrected.
    expect(check.handsNormalized).toBe(false);
    const reference = rotatedHandRig(new THREE.Quaternion());
    expect(installRestNormalization(reference).armsNormalized).toBe(false);
    // An arm raised forward and bent, with a curled finger.
    const pose = {
      leftUpperArm: {
        rotation: unit(0, 0.38, 0.2, 0.9),
      },
      leftLowerArm: { rotation: unit(0, 0.5, 0, 0.866) },
      leftHand: { rotation: unit(0, 0.259, 0, 0.966) },
      leftIndexProximal: { rotation: unit(0, 0, 0.5, 0.866) },
    } as const;
    for (const rig of [vrm, reference]) {
      rig.humanoid.setNormalizedPose(pose as never);
      rig.humanoid.update();
    }
    for (const [from, to] of [
      ["leftUpperArm", "leftLowerArm"],
      ["leftLowerArm", "leftHand"],
      ["leftHand", "leftMiddleProximal"],
      ["leftIndexIntermediate", "leftIndexDistal"],
    ]) {
      expect(
        rawDirection(vrm, from!, to!).angleTo(
          rawDirection(reference, from!, to!),
        ),
        `A-pose: ${from}`,
      ).toBeLessThan(1e-5);
    }
    expect(jointGap(vrm)).toBeLessThan(1e-6);
  });

  it.each([
    [
      "without a little finger",
      ["leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal"],
    ],
    [
      "without finger bones",
      Object.keys(VROID_LEFT).filter((bone) => bone !== "leftHand"),
    ],
  ])(
    "carries a hand it cannot measure on a corrected forearm (%s)",
    (_label, unmapped) => {
      const vrm = rotatedHandRig(new THREE.Quaternion(), unmapped, armDown(40));
      const check = installRestNormalization(vrm);
      expect(check.armsNormalized).toBe(true);
      expect(check.normalization!.bones.has("leftHand")).toBe(true);
      const reference = rotatedHandRig(new THREE.Quaternion(), unmapped);
      // A wrist flex on a raised arm.
      const pose = {
        leftUpperArm: { rotation: unit(0, 0, 0.259, 0.966) },
        leftHand: { rotation: unit(0, 0.259, 0, 0.966) },
      } as const;
      for (const rig of [vrm, reference]) {
        rig.humanoid.setNormalizedPose(pose as never);
        rig.humanoid.update();
      }
      expect(
        rawDirection(vrm, "leftHand", "leftMiddleProximal").angleTo(
          rawDirection(reference, "leftHand", "leftMiddleProximal"),
        ),
      ).toBeLessThan(1e-5);
      expect(jointGap(vrm)).toBeLessThan(1e-6);
    },
  );

  it("measures a hand against its own forearm within the arm tolerance", () => {
    // Arms 8° down, the hand straight along the forearm: nothing to correct.
    const check = installRestNormalization(
      rotatedHandRig(new THREE.Quaternion(), [], armDown(8)),
    );
    expect(check.armsNormalized).toBe(false);
    expect(check.armDegrees).toBeCloseTo(8, 1);
    expect(check.handsNormalized).toBe(false);
    const level = installRestNormalization(
      rotatedHandRig(new THREE.Quaternion()),
    );
    expect(check.handDegrees).toBeCloseTo(level.handDegrees, 3);
    expect(check.normalization).toBeNull();
  });

  it("gives readers of the normalized rig the hand as drawn", () => {
    const vrm = rotatedHandRig(TILTED);
    installRestNormalization(vrm);
    const pose = {
      leftIndexProximal: { rotation: [0, 0, 0.5, 0.866] },
      leftIndexIntermediate: { rotation: [0, 0, 0.6, 0.8] },
    } as const;
    vrm.humanoid.setNormalizedPose(pose as never);
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    // The contact solver's fingertip lands where the drawn finger is.
    const skeleton = new CanonicalSkeleton(vrm);
    const evaluated = new SkeletonPose(skeleton).setPose(pose as never);
    const tip = evaluated.contactPoint(
      "leftIndexIntermediate",
      "tip",
      new THREE.Vector3(),
    )!;
    const drawn = vrm.humanoid
      .getRawBoneNode("leftIndexDistal")!
      .getWorldPosition(new THREE.Vector3());
    const hips = vrm.humanoid
      .getRawBoneNode("hips")!
      .getWorldPosition(new THREE.Vector3());
    expect(
      tip.distanceTo(drawn.sub(hips).add(skeleton.restPosition("hips")!)),
    ).toBeLessThan(1e-4);
    // A reset keeps the normalized hand's shape.
    vrm.humanoid.resetNormalizedPose();
    expect(
      vrm.humanoid
        .getNormalizedBoneNode("leftIndexIntermediate")!
        .position.clone()
        .normalize()
        .angleTo(new THREE.Vector3(1, 0, -0.02).normalize()),
    ).toBeLessThan(0.02);
  });

  it("is installed by the shared load step that animation:render uses", async () => {
    const vrm = rotatedHandRig(TILTED);
    expect(
      prepareLoadedVrm(vrm, { vrmSha256: null }).restPose.normalization,
    ).not.toBeNull();
    const source = (path: string) =>
      readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    // The sheet drawing that the script and the app share loads the Avatar.
    expect(await source("../../motion-authoring/reviewSheet.ts")).toMatch(
      /prepareLoadedVrm\(vrm,/,
    );
    expect(
      await source("../../../../../scripts/animation-render/render.ts"),
    ).toMatch(/drawReviewSheet\(/);
  });
});
