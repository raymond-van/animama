import * as THREE from "three";

import type { Avatar } from "../Avatar";
import { resolveHumanoidAnchorObject } from "../humanoidAnchors";
import { isVrm0 } from "../poses/poseRetargeting";
import {
  PARTICLE_VFX_ANCHORS,
  type ParticleVFXAnchor,
  type ParticleVFXResolvedAnchor,
  type ParticleVFXTransform,
  type ParticleVFXTransformAxisTriple,
  type ParticleVFXTransformInput,
} from "./types";

/** The identity transform: no offset or rotation, unit scale. */
export function createDefaultParticleVFXTransform(): ParticleVFXTransform {
  return {
    offset: { x: 0, y: 0, z: 0 },
    depthOffset: 0,
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

export function isParticleVFXAnchor(
  value: unknown,
): value is ParticleVFXAnchor {
  return (
    typeof value === "string" &&
    (PARTICLE_VFX_ANCHORS as readonly string[]).includes(value)
  );
}

export function cloneParticleVFXTransform(
  transform: ParticleVFXTransform,
): ParticleVFXTransform {
  return {
    offset: { ...transform.offset },
    depthOffset: transform.depthOffset,
    rotation: { ...transform.rotation },
    scale: { ...transform.scale },
  };
}

export function normalizeParticleVFXTransform(
  value: ParticleVFXTransformInput | null | undefined,
): ParticleVFXTransform {
  return mergeParticleVFXTransform(createDefaultParticleVFXTransform(), value);
}

export function mergeParticleVFXTransform(
  base: ParticleVFXTransform,
  override: ParticleVFXTransformInput | null | undefined,
): ParticleVFXTransform {
  const next = cloneParticleVFXTransform(base);
  if (!override) return next;

  next.offset = mergeAxisTriple(next.offset, override.offset);
  next.rotation = mergeAxisTriple(next.rotation, override.rotation);
  next.scale = mergeAxisTriple(next.scale, override.scale);
  if (
    typeof override.depthOffset === "number" &&
    Number.isFinite(override.depthOffset)
  ) {
    next.depthOffset = override.depthOffset;
  }
  return next;
}

export function getParticleVFXCombinedOffset(
  transform: ParticleVFXTransform,
): ParticleVFXTransformAxisTriple {
  return {
    x: transform.offset.x,
    y: transform.offset.y,
    z: transform.offset.z + transform.depthOffset,
  };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Particle Effects are placed in the Avatar frame: Avatar scene-local
 * coordinates turned so +Z is the Avatar's forward for every VRM, as in the
 * VRM 1 scenes effects are authored on. three-vrm turns a VRM 0 scene half
 * about Y to face +Z (`VRMUtils.rotateVRM0`), so its scene-local forward is
 * -Z; the Avatar frame undoes that turn.
 */
function particleVFXAvatarFrameTurn(avatar: Pick<Avatar, "vrm">): number {
  return isVrm0(avatar.vrm) ? Math.PI : 0;
}

/** Turn a root under `avatar.scene` so its local space is the Avatar frame. */
export function alignParticleVFXRootToAvatar(
  root: THREE.Object3D,
  avatar: Pick<Avatar, "vrm">,
): void {
  root.rotation.set(0, particleVFXAvatarFrameTurn(avatar), 0);
  root.updateMatrixWorld(true);
}

/** Convert a world point into the Avatar frame, in place. */
export function worldToParticleVFXAvatarFrame(
  avatar: Pick<Avatar, "scene" | "vrm">,
  point: THREE.Vector3,
): THREE.Vector3 {
  const scene = avatar.scene;
  if (!scene) return point;
  scene.worldToLocal(point);
  return point.applyAxisAngle(Y_AXIS, -particleVFXAvatarFrameTurn(avatar));
}

/**
 * Resolve an anchor bone plus the transform's offset in the Avatar frame
 * (see `alignParticleVFXRootToAvatar`).
 */
export function resolveParticleVFXAnchorLocalPosition(args: {
  avatar: Avatar;
  anchor: ParticleVFXAnchor;
  transform?: ParticleVFXTransform;
}): ParticleVFXResolvedAnchor | null {
  const scene = args.avatar.scene;
  if (!scene) return null;

  scene.updateMatrixWorld(true);
  const combinedOffset = getParticleVFXCombinedOffset(
    args.transform ?? normalizeParticleVFXTransform(null),
  );

  if (args.anchor === "root") {
    return {
      requestedAnchor: args.anchor,
      resolvedAnchor: "root",
      boneName: null,
      position: combinedOffset,
      warning: null,
    };
  }

  const resolved = resolveHumanoidAnchorObject(args.avatar, args.anchor);
  if (resolved?.boneName) {
    const boneNode = resolved.object;
    boneNode.updateMatrixWorld(true);
    const localPosition = worldToParticleVFXAvatarFrame(
      args.avatar,
      boneNode.getWorldPosition(new THREE.Vector3()),
    );
    localPosition.add(
      new THREE.Vector3(combinedOffset.x, combinedOffset.y, combinedOffset.z),
    );

    return {
      requestedAnchor: args.anchor,
      resolvedAnchor: args.anchor,
      boneName: resolved.boneName,
      position: vectorToAxisTriple(localPosition),
      warning: resolved.fellBack
        ? `Particle VFX anchor "${args.anchor}" fell back to VRM bone "${resolved.boneName}".`
        : null,
    };
  }

  return {
    requestedAnchor: args.anchor,
    resolvedAnchor: "root",
    boneName: null,
    position: combinedOffset,
    warning: `Particle VFX anchor "${args.anchor}" could not resolve a VRM bone and fell back to root.`,
  };
}

function mergeAxisTriple(
  base: ParticleVFXTransformAxisTriple,
  override: Partial<ParticleVFXTransformAxisTriple> | null | undefined,
): ParticleVFXTransformAxisTriple {
  return {
    x: readFiniteNumber(override?.x, base.x),
    y: readFiniteNumber(override?.y, base.y),
    z: readFiniteNumber(override?.z, base.z),
  };
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vectorToAxisTriple(
  vector: THREE.Vector3,
): ParticleVFXTransformAxisTriple {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}
