import type { VRMHumanBoneName } from "@pixiv/three-vrm";
import type * as THREE from "three";

import type { Avatar } from "./Avatar";

/**
 * Body points that effects attach to: the avatar root plus humanoid bones.
 * Particle Effect emitters and body-attached Avatar Effects share this set.
 */
export const HUMANOID_ANCHORS = [
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftHand",
  "rightHand",
  "leftFoot",
  "rightFoot",
] as const;

export type HumanoidAnchor = (typeof HUMANOID_ANCHORS)[number];

/** Each body point's name in the creators ("Plays at", "Body point"). */
export const HUMANOID_ANCHOR_LABELS: Readonly<Record<HumanoidAnchor, string>> =
  {
    root: "Feet (whole avatar)",
    hips: "Hips",
    spine: "Waist",
    chest: "Chest",
    neck: "Neck",
    head: "Head",
    leftHand: "Left hand",
    rightHand: "Right hand",
    leftFoot: "Left foot",
    rightFoot: "Right foot",
  };

/**
 * Normalized bones tried for each anchor, in order. Optional VRM bones (for
 * example `upperChest`) may be absent, so each anchor falls back to the
 * nearest bone that every humanoid has.
 */
export const HUMANOID_ANCHOR_BONE_CANDIDATES = {
  root: [],
  hips: ["hips"],
  spine: ["spine", "chest", "hips"],
  chest: ["chest", "upperChest", "spine", "hips"],
  neck: ["neck", "head", "chest", "upperChest", "spine"],
  head: ["head", "neck", "chest", "upperChest", "spine"],
  leftHand: ["leftHand", "leftLowerArm", "leftUpperArm", "chest"],
  rightHand: ["rightHand", "rightLowerArm", "rightUpperArm", "chest"],
  leftFoot: ["leftFoot", "leftLowerLeg", "leftUpperLeg", "hips"],
  rightFoot: ["rightFoot", "rightLowerLeg", "rightUpperLeg", "hips"],
} as const satisfies Record<HumanoidAnchor, readonly VRMHumanBoneName[]>;

/** The object an anchor resolved to; `boneName` is null for the avatar root. */
export type ResolvedHumanoidAnchorObject = {
  requestedAnchor: HumanoidAnchor;
  /** The requested anchor, or `"root"` when no candidate bone exists. */
  resolvedAnchor: HumanoidAnchor;
  boneName: VRMHumanBoneName | null;
  /** The normalized bone node, or the avatar scene for the root. */
  object: THREE.Object3D;
  /** True when a fallback bone (or the root) stands in for the anchor. */
  fellBack: boolean;
};

/**
 * Resolve an anchor to the normalized humanoid bone that follows it, walking
 * the fallback chain, or to the avatar scene for `root` or when no candidate
 * exists. Returns null before an avatar is loaded. Normalized bones carry the
 * animated pose, and children parented to them follow it without updates.
 */
export function resolveHumanoidAnchorObject(
  avatar: Pick<Avatar, "scene" | "vrm">,
  anchor: HumanoidAnchor,
): ResolvedHumanoidAnchorObject | null {
  const scene = avatar.scene;
  if (!scene) return null;
  const candidates: readonly VRMHumanBoneName[] =
    HUMANOID_ANCHOR_BONE_CANDIDATES[anchor];
  for (const boneName of candidates) {
    const object = avatar.vrm?.humanoid.getNormalizedBoneNode(boneName);
    if (!object) continue;
    return {
      requestedAnchor: anchor,
      resolvedAnchor: anchor,
      boneName,
      object,
      fellBack: boneName !== candidates[0],
    };
  }
  return {
    requestedAnchor: anchor,
    resolvedAnchor: "root",
    boneName: null,
    object: scene,
    fellBack: anchor !== "root",
  };
}
