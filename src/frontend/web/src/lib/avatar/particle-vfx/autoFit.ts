import * as THREE from "three";

import type { Avatar } from "../Avatar";
import { worldToParticleVFXAvatarFrame } from "./runtime";
import type {
  ParticleVFXShapeAutoFit,
  ParticleVFXTransform,
  ParticleVFXTransformAxisTriple,
} from "./types";

export const PARTICLE_VFX_ROOT_OBJECT_NAME = "AnimamaParticleVFXRoot";

const DEFAULT_RECTANGLE_MIN_SIZE = 0.1;
const MIN_SCALE_DENOMINATOR = 0.0001;

type RenderableObject3D = THREE.Object3D & {
  geometry?: THREE.BufferGeometry;
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
};

type RectangleEmitterShapeLike = {
  type?: unknown;
  width?: number;
  height?: number;
};

type ParticleEmitterObjectLike = THREE.Object3D & {
  system?: {
    emitterShape?: unknown;
    shape?: unknown;
  };
};

export type ParticleVFXAvatarBoundsLocal = {
  min: ParticleVFXTransformAxisTriple;
  max: ParticleVFXTransformAxisTriple;
  center: ParticleVFXTransformAxisTriple;
  size: ParticleVFXTransformAxisTriple;
};

export type ParticleVFXAvatarBoundsRectangleFit = {
  position: ParticleVFXTransformAxisTriple;
  width: number;
  height: number;
  bounds: ParticleVFXAvatarBoundsLocal;
};

export type ParticleVFXAvatarBoundsRectangleFitResult = {
  fit: ParticleVFXAvatarBoundsRectangleFit | null;
  warning: string | null;
};

export function cloneParticleVFXShapeAutoFit(
  shapeAutoFit: ParticleVFXShapeAutoFit | null | undefined,
): ParticleVFXShapeAutoFit | undefined {
  const normalized = normalizeParticleVFXShapeAutoFit(shapeAutoFit);
  if (!normalized) return undefined;
  return {
    kind: normalized.kind,
    padding: normalized.padding ? { ...normalized.padding } : undefined,
    minSize: normalized.minSize ? { ...normalized.minSize } : undefined,
    maxSize: normalized.maxSize ? { ...normalized.maxSize } : undefined,
    emitterNames: normalized.emitterNames
      ? [...normalized.emitterNames]
      : undefined,
  };
}

export function normalizeParticleVFXShapeAutoFit(
  shapeAutoFit: ParticleVFXShapeAutoFit | null | undefined,
): ParticleVFXShapeAutoFit | undefined {
  if (shapeAutoFit?.kind !== "avatarBoundsRectangle") return undefined;

  const emitterNames = shapeAutoFit.emitterNames
    ?.map((name) => name.trim())
    .filter(Boolean);

  const maxWidth = readOptionalPositiveFinite(shapeAutoFit.maxSize?.width);
  const maxHeight = readOptionalPositiveFinite(shapeAutoFit.maxSize?.height);
  return {
    kind: "avatarBoundsRectangle",
    padding: {
      width: readNonNegativeFinite(shapeAutoFit.padding?.width, 0),
      height: readNonNegativeFinite(shapeAutoFit.padding?.height, 0),
    },
    minSize: {
      width: readNonNegativeFinite(
        shapeAutoFit.minSize?.width,
        DEFAULT_RECTANGLE_MIN_SIZE,
      ),
      height: readNonNegativeFinite(
        shapeAutoFit.minSize?.height,
        DEFAULT_RECTANGLE_MIN_SIZE,
      ),
    },
    maxSize:
      maxWidth !== undefined || maxHeight !== undefined
        ? { width: maxWidth, height: maxHeight }
        : undefined,
    emitterNames:
      emitterNames && emitterNames.length > 0 ? emitterNames : undefined,
  };
}

export function resolveParticleVFXAvatarBoundsRectangleFit(args: {
  avatar: Avatar;
  transform: ParticleVFXTransform;
  shapeAutoFit: ParticleVFXShapeAutoFit | null | undefined;
}): ParticleVFXAvatarBoundsRectangleFitResult {
  const shapeAutoFit = normalizeParticleVFXShapeAutoFit(args.shapeAutoFit);
  if (!shapeAutoFit) return { fit: null, warning: null };

  const bounds = resolveParticleVFXAvatarRenderableBoundsLocal(args.avatar);
  if (!bounds) {
    return {
      fit: null,
      warning:
        "Particle VFX avatar-bounds rectangle auto-fit could not resolve visible avatar mesh bounds; using anchor placement.",
    };
  }

  const width = fitDimensionToScale(
    bounds.size.x + (shapeAutoFit.padding?.width ?? 0),
    shapeAutoFit.minSize?.width ?? DEFAULT_RECTANGLE_MIN_SIZE,
    shapeAutoFit.maxSize?.width,
    args.transform.scale.x,
  );
  const height = fitDimensionToScale(
    bounds.size.y + (shapeAutoFit.padding?.height ?? 0),
    shapeAutoFit.minSize?.height ?? DEFAULT_RECTANGLE_MIN_SIZE,
    shapeAutoFit.maxSize?.height,
    args.transform.scale.y,
  );
  const combinedOffset = getCombinedOffset(args.transform);

  return {
    fit: {
      position: {
        x: bounds.center.x + combinedOffset.x,
        y: bounds.center.y + combinedOffset.y,
        z: bounds.center.z + combinedOffset.z,
      },
      width,
      height,
      bounds,
    },
    warning: null,
  };
}

/** The Avatar's renderable bounds in the Avatar frame. */
export function resolveParticleVFXAvatarRenderableBoundsLocal(
  avatar: Pick<Avatar, "scene" | "vrm">,
): ParticleVFXAvatarBoundsLocal | null {
  const scene = avatar.scene;
  if (!scene) return null;

  scene.updateMatrixWorld(true);
  const worldBox = new THREE.Box3();
  const meshBox = new THREE.Box3();
  let hasBounds = false;

  scene.traverse((object) => {
    const renderable = object as RenderableObject3D;
    if (
      !renderable.geometry ||
      (!renderable.isMesh && !renderable.isSkinnedMesh)
    ) {
      return;
    }
    if (
      isInsideParticleVFXRoot(object) ||
      !isVisibleInHierarchy(object, scene)
    ) {
      return;
    }

    meshBox.setFromObject(object);
    if (meshBox.isEmpty()) return;
    worldBox.union(meshBox);
    hasBounds = true;
  });

  if (!hasBounds || worldBox.isEmpty()) return null;

  const localBox = new THREE.Box3();
  for (const corner of getBoxCorners(worldBox)) {
    localBox.expandByPoint(worldToParticleVFXAvatarFrame(avatar, corner));
  }
  if (localBox.isEmpty()) return null;

  const center = localBox.getCenter(new THREE.Vector3());
  const size = localBox.getSize(new THREE.Vector3());

  return {
    min: vectorToAxisTriple(localBox.min),
    max: vectorToAxisTriple(localBox.max),
    center: vectorToAxisTriple(center),
    size: vectorToAxisTriple(size),
  };
}

export function applyParticleVFXRectangleShapeAutoFit(args: {
  object: THREE.Object3D;
  shapeAutoFit: ParticleVFXShapeAutoFit | null | undefined;
  width: number;
  height: number;
}): number {
  const shapeAutoFit = normalizeParticleVFXShapeAutoFit(args.shapeAutoFit);
  if (!shapeAutoFit) return 0;

  const emitterNameFilter = new Set(shapeAutoFit.emitterNames ?? []);
  let patchedCount = 0;

  args.object.traverse((child) => {
    if (child.type !== "ParticleEmitter") return;
    if (emitterNameFilter.size > 0 && !emitterNameFilter.has(child.name)) {
      return;
    }

    const emitter = child as ParticleEmitterObjectLike;
    const shapes = [emitter.system?.emitterShape, emitter.system?.shape].filter(
      isRectangleEmitterShape,
    );
    if (shapes.length === 0) return;

    for (const shape of new Set(shapes)) {
      shape.width = args.width;
      shape.height = args.height;
    }
    patchedCount += 1;
  });

  return patchedCount;
}

function getCombinedOffset(
  transform: ParticleVFXTransform,
): ParticleVFXTransformAxisTriple {
  return {
    x: transform.offset.x,
    y: transform.offset.y,
    z: transform.offset.z + transform.depthOffset,
  };
}

function fitDimensionToScale(
  value: number,
  minSize: number,
  maxSize: number | undefined,
  scale: number,
): number {
  const clamped = clampDimension(value, minSize, maxSize);
  const denominator = Math.max(Math.abs(scale), MIN_SCALE_DENOMINATOR);
  return clamped / denominator;
}

function clampDimension(
  value: number,
  minSize: number,
  maxSize: number | undefined,
): number {
  const finiteValue = Number.isFinite(value) ? value : minSize;
  const lowerBound = Math.max(0, minSize);
  const upperBound =
    typeof maxSize === "number" && Number.isFinite(maxSize)
      ? Math.max(lowerBound, maxSize)
      : Number.POSITIVE_INFINITY;
  return Math.min(upperBound, Math.max(lowerBound, finiteValue));
}

function isRectangleEmitterShape(
  value: unknown,
): value is RectangleEmitterShapeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RectangleEmitterShapeLike).type === "rectangle"
  );
}

function readNonNegativeFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function readOptionalPositiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function isInsideParticleVFXRoot(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (
      current.name === PARTICLE_VFX_ROOT_OBJECT_NAME ||
      current.userData.animamaParticleVFXRoot === true
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isVisibleInHierarchy(
  object: THREE.Object3D,
  root: THREE.Object3D,
): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return true;
}

function getBoxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
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
