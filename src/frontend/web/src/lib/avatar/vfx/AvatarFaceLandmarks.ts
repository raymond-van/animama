import * as THREE from "three";

import type { Avatar } from "../Avatar";
import { isAnimamaConversion } from "../avatarConversionMarker";
import { addAvatarIssue, type AvatarIssue } from "../diagnostics/issues";
import type {
  AvatarFaceBoxCoordinate,
  AvatarFaceEyeLandmarkSnapshot,
  AvatarFaceLandmarkBounds,
  AvatarFaceLandmarksSnapshot,
  AvatarFaceLandmarkVector,
  AvatarFaceTextureRect,
} from "./landmark-types";
import {
  createFaceVertexFilter,
  findFaceSkinRegion,
  resolveAvatarFacePartEntries,
  type AvatarEyeEstimate,
  type AvatarEyeEstimateGeometry,
  measureClosedEyeCovers,
  type ClosedEyeCover,
} from "./faceParts";
import {
  collectPrimitiveData,
  readVertexPosition,
  resolvePrimitiveVertexRange,
  UnionFind,
  type RuntimePrimitiveBindingEntry,
} from "./avatarPrimitiveUtils";
import { baseTextureOf, TextureUvMapping } from "./textureUvMapping";
import { buildRuntimePrimitiveBindings } from "../vrmEditorInspection";
import { createLogger } from "@/lib/logger";

const logger = createLogger("AvatarFaceLandmarks");
const EPSILON = 1e-6;
const HAIR_SEARCH_X_PADDING_RATIO = 0.15;
const HAIR_SEARCH_Y_PADDING_RATIO = 0.35;
const HAIR_CLEARANCE_MARGIN_MIN = 0.003;
const HAIR_CLEARANCE_MARGIN_DEPTH_RATIO = 0.04;
const HAIR_COARSE_SAMPLE_LIMIT = 256;
const MAX_RETAINED_HAIR_BINDINGS = 12;

type FrontAxisSign = -1 | 1;

type InternalEyeLandmark = {
  bindingKey: string;
  materialName: string | null;
  vertexCount: number;
  bounds: THREE.Box3;
  center: THREE.Vector3;
  projectedFront: THREE.Vector3;
  normalizedBoxCoord: AvatarFaceBoxCoordinate;
  projectedBoxCoord: AvatarFaceBoxCoordinate;
  textureRect: AvatarFaceTextureRect | null;
  textureMirrored: boolean;
  /** Set for an eye without geometry of its own; see the snapshot field. */
  estimate?: AvatarEyeEstimate;
  /** An estimated eye's surface front; see the snapshot field. */
  surfaceFrontZ?: number;
  /** A converted MMD model's closed cover; see the snapshot field. */
  closedCover?: ClosedEyeCover;
};

type PrimitiveIsland = {
  bindingKey: string;
  materialName: string | null;
  vertexCount: number;
  bounds: THREE.Box3;
  center: THREE.Vector3;
  textureRect: AvatarFaceTextureRect | null;
  /** Whether its art runs mirrored against VRoid's; see `measureTextureLayout`. */
  textureMirrored: boolean;
};

/**
 * Below this correlation between an island's image x and its position along
 * the Avatar's left, its UVs have no clear direction (a dome, a point).
 */
const TEXTURE_DIRECTION_MIN_CORRELATION = 0.3;

type HairFrontSearchWindow = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type HairFrontSample = {
  maxSignedFront: number;
  pointCount: number;
};

function toVectorSnapshot(value: THREE.Vector3): AvatarFaceLandmarkVector {
  return {
    x: value.x,
    y: value.y,
    z: value.z,
  };
}

function toBoundsSnapshot(box: THREE.Box3): AvatarFaceLandmarkBounds {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    min: toVectorSnapshot(box.min),
    max: toVectorSnapshot(box.max),
    size: toVectorSnapshot(size),
    center: toVectorSnapshot(center),
  };
}

function clampBoxCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function normalizePointWithinBounds(
  point: THREE.Vector3,
  bounds: THREE.Box3,
): AvatarFaceBoxCoordinate {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  return {
    u:
      Math.abs(size.x) <= EPSILON
        ? 0.5
        : clampBoxCoordinate((point.x - bounds.min.x) / size.x),
    v:
      Math.abs(size.y) <= EPSILON
        ? 0.5
        : clampBoxCoordinate((point.y - bounds.min.y) / size.y),
    w:
      Math.abs(size.z) <= EPSILON
        ? 0.5
        : clampBoxCoordinate((point.z - bounds.min.z) / size.z),
  };
}

function computeCentroid(points: readonly THREE.Vector3[]): THREE.Vector3 {
  const centroid = new THREE.Vector3();
  if (points.length === 0) return centroid;
  points.forEach((point) => {
    centroid.add(point);
  });
  return centroid.multiplyScalar(1 / points.length);
}

function createBoxFromPoints(
  points: readonly THREE.Vector3[],
): THREE.Box3 | null {
  if (points.length === 0) return null;
  const box = new THREE.Box3();
  let hasPoint = false;
  points.forEach((point) => {
    if (!hasPoint) {
      box.min.copy(point);
      box.max.copy(point);
      hasPoint = true;
    } else {
      box.expandByPoint(point);
    }
  });
  return hasPoint ? box : null;
}

function cloneWorldPoint(
  anchorObject: THREE.Object3D | null,
  localPoint: THREE.Vector3,
): AvatarFaceLandmarkVector | null {
  if (!anchorObject) return null;
  anchorObject.updateWorldMatrix(true, false);
  const point = localPoint.clone();
  anchorObject.localToWorld(point);
  return toVectorSnapshot(point);
}

function createEmptySnapshot(
  warnings: string[] = [],
  issues: AvatarIssue[] = [],
): AvatarFaceLandmarksSnapshot {
  return {
    status: "unavailable",
    warnings,
    issues,
    anchorName: null,
    anchorType: null,
    faceBindingKey: null,
    faceMaterialName: null,
    faceBoundsLocal: null,
    frontZLocal: null,
    boxHoverClearanceLocal: null,
    boxHoverFrontZLocal: null,
    eyes: {
      left: null,
      right: null,
    },
  };
}

export class AvatarFaceLandmarks {
  private readonly _avatar: Avatar;
  private _anchorObject: THREE.Object3D | null = null;
  private _faceBounds: THREE.Box3 | null = null;
  private _faceBindingKey: string | null = null;
  private _faceMaterialName: string | null = null;
  private _frontZLocal: number | null = null;
  private _boxHoverClearanceLocal: number | null = null;
  private _boxHoverFrontZLocal: number | null = null;
  private _eyes: {
    left: InternalEyeLandmark | null;
    right: InternalEyeLandmark | null;
  } = {
    left: null,
    right: null,
  };
  private _warnings: string[] = [];
  private _issues: AvatarIssue[] = [];
  private _snapshot: AvatarFaceLandmarksSnapshot = createEmptySnapshot();
  private _isDisposed = false;

  constructor(avatar: Avatar) {
    this._avatar = avatar;
    this._build();
  }

  getAnchorObject(): THREE.Object3D | null {
    return this._anchorObject;
  }

  getFaceBoundsBox(): THREE.Box3 | null {
    return this._faceBounds?.clone() ?? null;
  }

  getSnapshot(): AvatarFaceLandmarksSnapshot {
    if (!this._faceBounds) {
      return this._snapshot;
    }

    return {
      status: "ready",
      warnings: [...this._warnings],
      issues: [...this._issues],
      anchorName: this._anchorObject?.name?.trim() || null,
      anchorType: this._anchorObject?.type ?? null,
      faceBindingKey: this._faceBindingKey,
      faceMaterialName: this._faceMaterialName,
      faceBoundsLocal: toBoundsSnapshot(this._faceBounds),
      frontZLocal: this._frontZLocal,
      boxHoverClearanceLocal: this._boxHoverClearanceLocal ?? 0,
      boxHoverFrontZLocal: this._boxHoverFrontZLocal ?? this._frontZLocal,
      eyes: {
        left: this._serializeEyeLandmark(this._eyes.left),
        right: this._serializeEyeLandmark(this._eyes.right),
      },
    };
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._anchorObject = null;
    this._faceBounds = null;
    this._faceBindingKey = null;
    this._faceMaterialName = null;
    this._frontZLocal = null;
    this._boxHoverClearanceLocal = null;
    this._boxHoverFrontZLocal = null;
    this._eyes = { left: null, right: null };
    this._warnings = [];
    this._issues = [];
    this._snapshot = createEmptySnapshot();
  }

  /** Record a finding as dev-panel text and as a stable code. */
  private _warn(issue: AvatarIssue, message: string): void {
    this._warnings.push(message);
    addAvatarIssue(this._issues, issue);
  }

  private _serializeEyeLandmark(
    eye: InternalEyeLandmark | null,
  ): AvatarFaceEyeLandmarkSnapshot | null {
    if (!eye) return null;
    return {
      bindingKey: eye.bindingKey,
      materialName: eye.materialName,
      vertexCount: eye.vertexCount,
      boundsLocal: toBoundsSnapshot(eye.bounds),
      centerLocal: toVectorSnapshot(eye.center),
      centerWorld: cloneWorldPoint(this._anchorObject, eye.center),
      projectedFrontLocal: toVectorSnapshot(eye.projectedFront),
      projectedFrontWorld: cloneWorldPoint(
        this._anchorObject,
        eye.projectedFront,
      ),
      normalizedBoxCoord: eye.normalizedBoxCoord,
      projectedBoxCoord: eye.projectedBoxCoord,
      textureRect: eye.textureRect,
      // Only a mirrored eye carries the flag; VRoid's eyes read as before.
      ...(eye.textureMirrored ? { textureMirrored: true } : {}),
      ...(eye.estimate ? { estimate: eye.estimate } : {}),
      ...(eye.surfaceFrontZ !== undefined
        ? { surfaceFrontZLocal: eye.surfaceFrontZ }
        : {}),
      ...(eye.closedCover
        ? {
            closedCover: {
              boundsLocal: toBoundsSnapshot(eye.closedCover.bounds),
              frontZLocal: eye.closedCover.front,
            },
          }
        : {}),
    };
  }

  private _build(): void {
    const runtimeResult = buildRuntimePrimitiveBindings(this._avatar);
    this._warnings = [...runtimeResult.warnings];

    const parts = resolveAvatarFacePartEntries(
      this._avatar,
      runtimeResult.entries,
    );
    const faceBinding = parts.face;
    const eyeBindings = Array.from(
      new Set([...parts.leftEyes, ...parts.rightEyes]),
    );

    const anchorObject = this._resolveAnchorObject(
      faceBinding?.object ?? eyeBindings[0]?.object ?? null,
    );
    this._anchorObject = anchorObject;

    if (!faceBinding || !anchorObject) {
      if (!faceBinding) {
        this._warn(
          { code: "landmarks_face_skin_missing" },
          "No face skin part was detected on this avatar.",
        );
      }
      if (!anchorObject) {
        this._warn(
          { code: "landmarks_anchor_missing" },
          "No anchor object was available for face landmarks.",
        );
      }
      this._snapshot = createEmptySnapshot(
        [...this._warnings],
        [...this._issues],
      );
      return;
    }

    // Bounds span every face skin primitive, from its head-weighted vertices.
    const faceBounds = parts.faces.reduce<THREE.Box3 | null>((union, face) => {
      const bounds = computePrimitiveBoundsInAnchorSpace({
        avatar: this._avatar,
        binding: face,
        anchorObject,
      });
      if (!bounds) return union;
      return union ? union.union(bounds) : bounds;
    }, null);
    if (!faceBounds) {
      this._warn(
        {
          code: "landmarks_face_bounds_failed",
          params: { binding: faceBinding.bindingKey },
        },
        `Unable to compute face bounds for ${faceBinding.bindingKey}.`,
      );
      this._snapshot = createEmptySnapshot(
        [...this._warnings],
        [...this._issues],
      );
      return;
    }

    this._faceBounds = faceBounds;
    this._faceBindingKey = faceBinding.bindingKey;
    this._faceMaterialName = faceBinding.materialName;
    const frontZLocal = resolveFaceFrontZ({
      avatar: this._avatar,
      faceBounds,
    });
    this._frontZLocal = frontZLocal;
    this._boxHoverClearanceLocal = 0;
    this._boxHoverFrontZLocal = this._frontZLocal;

    // One primitive may hold both eyes, so islands are extracted once per
    // binding and offered to the side(s) whose part lists that binding.
    const leftSign = resolveVRMSpecVersion(this._avatar) === "0" ? -1 : 1;
    const islandsByBinding = new Map(
      eyeBindings.map((binding) => [
        binding.bindingKey,
        extractPrimitiveIslandsInAnchorSpace({
          avatar: this._avatar,
          binding,
          anchorObject,
          leftSign,
        }),
      ]),
    );
    const eyeIslands = Array.from(islandsByBinding.values()).flat();
    const leftKeys = new Set(parts.leftEyes.map((entry) => entry.bindingKey));
    const rightKeys = new Set(parts.rightEyes.map((entry) => entry.bindingKey));

    if (eyeIslands.length > 0) {
      this._eyes = this._assignEyes({
        anchorObject,
        faceBounds,
        frontZLocal: this._frontZLocal,
        islands: eyeIslands,
        isLeft: (island) => leftKeys.has(island.bindingKey),
        isRight: (island) => rightKeys.has(island.bindingKey),
      });
    }
    // Eyes without geometry of their own, placed where detection estimated.
    const estimate = (side: "left" | "right") =>
      this._eyes[side] ??
      this._estimateEye({
        side,
        entries: runtimeResult.entries,
        faceBounds,
        frontZLocal,
        leftSign,
      });
    this._eyes = { left: estimate("left"), right: estimate("right") };
    if (eyeIslands.length === 0 && !this._eyes.left && !this._eyes.right) {
      this._warn(
        { code: "landmarks_eyes_missing" },
        "No eye iris landmark islands were derived from the current bindings.",
      );
    }

    // A converted MikuMikuDance model's eyes also carry their closed cover,
    // which eye art that closes the eyes covers with a skin patch.
    const map = this._avatar.facePartMap;
    if (
      map &&
      this._avatar.vrm &&
      isAnimamaConversion(this._avatar.sourceGltf?.parser.json)
    ) {
      const covers = measureClosedEyeCovers(
        this._avatar.vrm,
        map,
        runtimeResult.entries,
        anchorObject,
      );
      for (const side of ["left", "right"] as const) {
        const eye = this._eyes[side];
        const cover = covers[side];
        if (eye && cover) eye.closedCover = cover;
      }
    }

    const boxHoverFront = resolveBoxHoverFrontClearance({
      avatar: this._avatar,
      anchorObject,
      hairBindings: parts.hair,
      faceBounds,
      frontZLocal: this._frontZLocal,
      eyes: this._eyes,
    });
    this._boxHoverClearanceLocal = boxHoverFront.offsetLocal;
    this._boxHoverFrontZLocal = boxHoverFront.frontZLocal;

    this._snapshot = this.getSnapshot();
    logger.info("Init", "Resolved face landmarks", {
      faceBindingKey: this._faceBindingKey,
      faceMaterialName: this._faceMaterialName,
      eyeIslandCount: eyeIslands.length,
      hasLeftEye: Boolean(this._eyes.left),
      hasRightEye: Boolean(this._eyes.right),
      boxHoverClearanceLocal: this._boxHoverClearanceLocal,
      boxHoverFrontZLocal: this._boxHoverFrontZLocal,
    });
  }

  /**
   * Pick one iris island per side. `isLeft`/`isRight` restrict each side to
   * islands of that side's part; when one primitive holds both eyes, both
   * sides share the candidates and the eye bones decide.
   *
   * With both eye bones, an island wider than the distance between them
   * cannot be one eye (some VRChat eye meshes carry such a dome around each
   * eyeball) and is skipped, unless that leaves no island. Such meshes also
   * draw an eye in stacked layers (the iris art, a gloss, an alternative eye);
   * the landmark's `textureRect` and `textureMirrored` are those of the iris
   * art (see `irisArtIsland`).
   */
  private _assignEyes(args: {
    anchorObject: THREE.Object3D;
    faceBounds: THREE.Box3;
    frontZLocal: number;
    islands: PrimitiveIsland[];
    isLeft: (island: PrimitiveIsland) => boolean;
    isRight: (island: PrimitiveIsland) => boolean;
  }): {
    left: InternalEyeLandmark | null;
    right: InternalEyeLandmark | null;
  } {
    const leftEyeNode =
      this._avatar.vrm?.humanoid?.getNormalizedBoneNode("leftEye") ?? null;
    const rightEyeNode =
      this._avatar.vrm?.humanoid?.getNormalizedBoneNode("rightEye") ?? null;
    const leftEyePoint = leftEyeNode
      ? getObjectPositionInAnchorSpace(leftEyeNode, args.anchorObject)
      : null;
    const rightEyePoint = rightEyeNode
      ? getObjectPositionInAnchorSpace(rightEyeNode, args.anchorObject)
      : null;
    const eyeSpacing =
      leftEyePoint && rightEyePoint
        ? Math.abs(leftEyePoint.x - rightEyePoint.x)
        : Infinity;

    const narrow = args.islands.filter(
      (island) => island.bounds.max.x - island.bounds.min.x < eyeSpacing,
    );
    const plausible = narrow.length > 0 ? narrow : args.islands;
    const candidates = [...plausible]
      .sort((a, b) => b.vertexCount - a.vertexCount)
      .slice(0, Math.max(2, Math.min(6, plausible.length)));
    const leftCandidates = candidates.filter(args.isLeft);
    const rightCandidates = candidates.filter(args.isRight);

    let leftIsland: PrimitiveIsland | null = null;
    let rightIsland: PrimitiveIsland | null = null;

    if (candidates.length === 1) {
      const loneIsland = candidates[0];
      const canBeLeft = args.isLeft(loneIsland);
      const canBeRight = args.isRight(loneIsland);
      if (canBeLeft !== canBeRight) {
        leftIsland = canBeLeft ? loneIsland : null;
        rightIsland = canBeRight ? loneIsland : null;
      } else if (leftEyePoint && rightEyePoint) {
        const leftDistance = loneIsland.center.distanceToSquared(leftEyePoint);
        const rightDistance =
          loneIsland.center.distanceToSquared(rightEyePoint);
        if (leftDistance <= rightDistance) {
          leftIsland = loneIsland;
        } else {
          rightIsland = loneIsland;
        }
      } else {
        leftIsland = loneIsland;
      }
    } else if (leftEyePoint && rightEyePoint) {
      let bestPair: {
        left: PrimitiveIsland;
        right: PrimitiveIsland;
        score: number;
      } | null = null;
      for (const leftCandidate of leftCandidates) {
        for (const rightCandidate of rightCandidates) {
          if (leftCandidate === rightCandidate) continue;
          const score =
            leftCandidate.center.distanceToSquared(leftEyePoint) +
            rightCandidate.center.distanceToSquared(rightEyePoint);
          if (!bestPair || score < bestPair.score) {
            bestPair = {
              left: leftCandidate,
              right: rightCandidate,
              score,
            };
          }
        }
      }
      leftIsland = bestPair?.left ?? null;
      rightIsland = bestPair?.right ?? null;
    } else {
      const byX = (a: PrimitiveIsland, b: PrimitiveIsland) =>
        a.center.x - b.center.x;
      leftIsland = [...leftCandidates].sort(byX)[0] ?? null;
      rightIsland =
        [...rightCandidates]
          .sort(byX)
          .reverse()
          .find((island) => island !== leftIsland) ?? null;
    }

    const landmarkOf = (island: PrimitiveIsland | null) => {
      if (!island) return null;
      const art = irisArtIsland(island, plausible);
      return createEyeLandmarkFromIsland(
        {
          ...island,
          textureRect: art.textureRect,
          textureMirrored: art.textureMirrored,
        },
        args.faceBounds,
        args.frontZLocal,
      );
    };
    return { left: landmarkOf(leftIsland), right: landmarkOf(rightIsland) };
  }

  /**
   * The landmark of an eye the part map estimates (it has no eye mesh part),
   * or null: an iris-sized box at the place detection measured
   * (`eyeEstimates`). A `blink` eye's `textureRect` bounds its blink region's
   * UVs on the face texture; an `eye_bone` eye has none.
   */
  private _estimateEye(args: {
    side: "left" | "right";
    entries: readonly RuntimePrimitiveBindingEntry[];
    faceBounds: THREE.Box3;
    frontZLocal: number;
    leftSign: 1 | -1;
  }): InternalEyeLandmark | null {
    const map = this._avatar.facePartMap;
    const part = map?.parts[`eye_${args.side}`];
    const estimate = map?.eyeEstimates?.[args.side];
    if (part?.source !== "estimated" || !part.estimate || !estimate) {
      return null;
    }
    const face = args.entries.find(
      (entry) => entry.bindingKey === estimate.bindingKey,
    );
    if (!face) return null;
    const island: PrimitiveIsland = {
      bindingKey: face.bindingKey,
      materialName: face.materialName,
      vertexCount: estimate.region?.vertices.length ?? 0,
      // A flat box on the face: depth is not read.
      bounds: new THREE.Box3().setFromCenterAndSize(
        estimate.center,
        new THREE.Vector3(estimate.width, estimate.height, 0),
      ),
      center: estimate.center.clone(),
      ...estimatedTextureLayout(face, estimate, args.leftSign),
    };
    return {
      ...createEyeLandmarkFromIsland(island, args.faceBounds, args.frontZLocal),
      estimate: part.estimate,
      ...(estimate.surfaceFront !== undefined
        ? { surfaceFrontZ: estimate.surfaceFront }
        : {}),
    };
  }

  private _resolveAnchorObject(
    preferredObject: THREE.Object3D | null,
  ): THREE.Object3D | null {
    return (
      this._avatar.vrm?.humanoid?.getNormalizedBoneNode("head") ??
      preferredObject ??
      this._avatar.scene
    );
  }
}

function createEyeLandmarkFromIsland(
  island: PrimitiveIsland,
  faceBounds: THREE.Box3,
  frontZLocal: number,
): InternalEyeLandmark {
  const projectedFront = island.center.clone();
  projectedFront.z = frontZLocal;

  return {
    bindingKey: island.bindingKey,
    materialName: island.materialName,
    vertexCount: island.vertexCount,
    bounds: island.bounds.clone(),
    center: island.center.clone(),
    projectedFront,
    normalizedBoxCoord: normalizePointWithinBounds(island.center, faceBounds),
    projectedBoxCoord: normalizePointWithinBounds(projectedFront, faceBounds),
    textureRect: island.textureRect,
    textureMirrored: island.textureMirrored,
  };
}

/**
 * Where an estimated eye's blink region lies on its face texture, and which
 * way its art runs ({@link measureTextureLayout}); none for an eye without a
 * region or a face without UVs.
 */
function estimatedTextureLayout(
  face: RuntimePrimitiveBindingEntry,
  estimate: AvatarEyeEstimateGeometry,
  leftSign: 1 | -1,
): { textureRect: AvatarFaceTextureRect | null; textureMirrored: boolean } {
  const uv = face.object.geometry.getAttribute("uv");
  const region = estimate.region;
  if (!region || !(uv instanceof THREE.BufferAttribute)) {
    return { textureRect: null, textureMirrored: false };
  }
  return measureTextureLayout({
    uv,
    mapping: TextureUvMapping.of(baseTextureOf(face.object)),
    vertexIndices: region.vertices,
    pointsByIndex: new Map(
      region.vertices.map((vertex, at) => [vertex, region.points[at]!]),
    ),
    leftSign,
  });
}

function resolveFaceFrontZ(args: {
  avatar: Avatar;
  faceBounds: THREE.Box3;
}): number {
  const specVersion = resolveVRMSpecVersion(args.avatar);
  if (specVersion === "0") {
    return args.faceBounds.min.z;
  }
  return args.faceBounds.max.z;
}

function resolveVRMSpecVersion(avatar: Avatar): "0" | "1" | "unknown" {
  const runtimeMetaVersion = avatar.vrm?.meta?.metaVersion;
  if (runtimeMetaVersion === "0" || runtimeMetaVersion === "1") {
    return runtimeMetaVersion;
  }

  const extensions = avatar.sourceGltf?.parser.json.extensions;
  if (extensions && typeof extensions === "object") {
    const extensionRecord = extensions as Record<string, unknown>;
    if (extensionRecord.VRMC_vrm) return "1";
    if (extensionRecord.VRM) return "0";
  }

  return "unknown";
}

function getObjectPositionInAnchorSpace(
  object: THREE.Object3D,
  anchorObject: THREE.Object3D,
): THREE.Vector3 {
  object.updateWorldMatrix(true, false);
  anchorObject.updateWorldMatrix(true, false);
  const point = new THREE.Vector3();
  object.getWorldPosition(point);
  anchorObject.worldToLocal(point);
  return point;
}

/**
 * Which way the face looks along the head anchor's z axis: −1 when `frontZLocal`
 * is the bounds' minimum z (VRM 0 heads face −Z), +1 otherwise.
 */
export function resolveFrontAxisSign(args: {
  faceBounds: THREE.Box3;
  frontZLocal: number;
}): FrontAxisSign {
  const { faceBounds, frontZLocal } = args;
  const distanceToMin = Math.abs(frontZLocal - faceBounds.min.z);
  const distanceToMax = Math.abs(frontZLocal - faceBounds.max.z);
  return distanceToMin <= distanceToMax ? -1 : 1;
}

function resolveHairSearchWindow(args: {
  faceBounds: THREE.Box3;
  eyes: {
    left: InternalEyeLandmark | null;
    right: InternalEyeLandmark | null;
  };
}): HairFrontSearchWindow {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  args.faceBounds.getSize(size);
  args.faceBounds.getCenter(center);

  const eyeYValues = [
    args.eyes.left?.projectedFront.y,
    args.eyes.right?.projectedFront.y,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  const eyeLineY =
    eyeYValues.length > 0
      ? eyeYValues.reduce((sum, value) => sum + value, 0) / eyeYValues.length
      : center.y;

  return {
    minX: args.faceBounds.min.x - size.x * HAIR_SEARCH_X_PADDING_RATIO,
    maxX: args.faceBounds.max.x + size.x * HAIR_SEARCH_X_PADDING_RATIO,
    minY: eyeLineY,
    maxY: args.faceBounds.max.y + size.y * HAIR_SEARCH_Y_PADDING_RATIO,
  };
}

function isPointWithinHairSearchWindow(
  point: THREE.Vector3,
  searchWindow: HairFrontSearchWindow,
): boolean {
  return (
    point.x >= searchWindow.minX &&
    point.x <= searchWindow.maxX &&
    point.y >= searchWindow.minY &&
    point.y <= searchWindow.maxY
  );
}

function preparePrimitiveVertexScan(args: {
  avatar: Avatar;
  binding: RuntimePrimitiveBindingEntry;
  anchorObject: THREE.Object3D;
}): {
  anchorObject: THREE.Object3D;
  meshObject: THREE.Mesh;
  position: THREE.BufferAttribute;
  index: THREE.BufferAttribute | null;
  start: number;
  count: number;
} | null {
  const geometry = args.binding.object.geometry;
  if (!(geometry instanceof THREE.BufferGeometry)) {
    return null;
  }

  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.itemSize < 3) {
    return null;
  }

  const index = geometry.getIndex();
  const range = resolvePrimitiveVertexRange(args.avatar, args.binding);
  const start = Math.max(0, range?.start ?? 0);
  const totalCount = index ? index.count : position.count;
  const maxCount = totalCount - start;
  const count =
    range?.count === null || range?.count === undefined
      ? maxCount
      : Math.max(0, Math.min(range.count, maxCount));
  if (count <= 0) {
    return null;
  }

  const meshObject = args.binding.object;
  meshObject.updateWorldMatrix(true, false);
  args.anchorObject.updateWorldMatrix(true, false);

  return {
    anchorObject: args.anchorObject,
    meshObject,
    position,
    index,
    start,
    count,
  };
}

function readVertexPositionInAnchorSpace(args: {
  anchorObject: THREE.Object3D;
  meshObject: THREE.Mesh;
  position: THREE.BufferAttribute;
  vertexIndex: number;
  target: THREE.Vector3;
}): THREE.Vector3 {
  readVertexPosition(
    args.meshObject,
    args.position,
    args.vertexIndex,
    args.target,
  );
  args.meshObject.localToWorld(args.target);
  args.anchorObject.worldToLocal(args.target);
  return args.target;
}

function samplePrimitiveFrontInWindow(args: {
  avatar: Avatar;
  binding: RuntimePrimitiveBindingEntry;
  anchorObject: THREE.Object3D;
  searchWindow: HairFrontSearchWindow;
  frontSign: FrontAxisSign;
  sampleLimit: number;
}): HairFrontSample | null {
  const prepared = preparePrimitiveVertexScan(args);
  if (!prepared) {
    return null;
  }

  const sampleCount = Math.min(args.sampleLimit, prepared.count);
  if (sampleCount <= 0) {
    return null;
  }

  const point = new THREE.Vector3();
  let pointCount = 0;
  let maxSignedFront = -Infinity;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const offset = Math.min(
      prepared.count - 1,
      Math.floor((sampleIndex * prepared.count) / sampleCount),
    );
    const sourceIndex = prepared.start + offset;
    const vertexIndex = prepared.index
      ? prepared.index.getX(sourceIndex)
      : sourceIndex;
    readVertexPositionInAnchorSpace({
      anchorObject: prepared.anchorObject,
      meshObject: prepared.meshObject,
      position: prepared.position,
      vertexIndex,
      target: point,
    });
    if (!isPointWithinHairSearchWindow(point, args.searchWindow)) {
      continue;
    }

    pointCount += 1;
    maxSignedFront = Math.max(maxSignedFront, point.z * args.frontSign);
  }

  return pointCount > 0
    ? {
        maxSignedFront,
        pointCount,
      }
    : null;
}

function computePrimitiveMaxFrontInWindow(args: {
  avatar: Avatar;
  binding: RuntimePrimitiveBindingEntry;
  anchorObject: THREE.Object3D;
  searchWindow: HairFrontSearchWindow;
  frontSign: FrontAxisSign;
}): number | null {
  const prepared = preparePrimitiveVertexScan(args);
  if (!prepared) {
    return null;
  }

  const seenVertexIndices = prepared.index ? new Set<number>() : null;
  const point = new THREE.Vector3();
  let hasPoint = false;
  let maxSignedFront = -Infinity;

  for (let offset = 0; offset < prepared.count; offset += 1) {
    const sourceIndex = prepared.start + offset;
    const vertexIndex = prepared.index
      ? prepared.index.getX(sourceIndex)
      : sourceIndex;
    if (seenVertexIndices) {
      if (seenVertexIndices.has(vertexIndex)) {
        continue;
      }
      seenVertexIndices.add(vertexIndex);
    }

    readVertexPositionInAnchorSpace({
      anchorObject: prepared.anchorObject,
      meshObject: prepared.meshObject,
      position: prepared.position,
      vertexIndex,
      target: point,
    });
    if (!isPointWithinHairSearchWindow(point, args.searchWindow)) {
      continue;
    }

    hasPoint = true;
    maxSignedFront = Math.max(maxSignedFront, point.z * args.frontSign);
  }

  return hasPoint ? maxSignedFront : null;
}

function resolveBoxHoverFrontClearance(args: {
  avatar: Avatar;
  anchorObject: THREE.Object3D;
  /** The hair part: box hovers clear the hair in front of the forehead. */
  hairBindings: RuntimePrimitiveBindingEntry[];
  faceBounds: THREE.Box3;
  frontZLocal: number;
  eyes: {
    left: InternalEyeLandmark | null;
    right: InternalEyeLandmark | null;
  };
}): {
  offsetLocal: number;
  frontZLocal: number;
} {
  const frontSign = resolveFrontAxisSign({
    faceBounds: args.faceBounds,
    frontZLocal: args.frontZLocal,
  });
  const faceFrontSigned = args.frontZLocal * frontSign;
  const searchWindow = resolveHairSearchWindow({
    faceBounds: args.faceBounds,
    eyes: args.eyes,
  });
  const hairBindings = args.hairBindings;
  if (hairBindings.length === 0) {
    return {
      offsetLocal: 0,
      frontZLocal: args.frontZLocal,
    };
  }

  const retainedBindings = hairBindings
    .map((binding) => {
      const sample = samplePrimitiveFrontInWindow({
        avatar: args.avatar,
        binding,
        anchorObject: args.anchorObject,
        searchWindow,
        frontSign,
        sampleLimit: HAIR_COARSE_SAMPLE_LIMIT,
      });
      if (!sample) {
        return null;
      }
      return {
        binding,
        maxSignedFront: sample.maxSignedFront,
      };
    })
    .filter(
      (
        value,
      ): value is {
        binding: RuntimePrimitiveBindingEntry;
        maxSignedFront: number;
      } => value !== null,
    )
    .sort((a, b) => b.maxSignedFront - a.maxSignedFront)
    .slice(0, MAX_RETAINED_HAIR_BINDINGS);

  if (retainedBindings.length === 0) {
    return {
      offsetLocal: 0,
      frontZLocal: args.frontZLocal,
    };
  }

  let hairFrontSigned = faceFrontSigned;
  let foundHairFront = false;

  retainedBindings.forEach(({ binding }) => {
    const maxSignedFront = computePrimitiveMaxFrontInWindow({
      avatar: args.avatar,
      binding,
      anchorObject: args.anchorObject,
      searchWindow,
      frontSign,
    });
    if (maxSignedFront === null) {
      return;
    }
    hairFrontSigned = Math.max(hairFrontSigned, maxSignedFront);
    foundHairFront = true;
  });

  if (!foundHairFront) {
    return {
      offsetLocal: 0,
      frontZLocal: args.frontZLocal,
    };
  }

  const clearance = Math.max(0, hairFrontSigned - faceFrontSigned);
  if (clearance <= EPSILON) {
    return {
      offsetLocal: 0,
      frontZLocal: args.frontZLocal,
    };
  }

  const faceDepth = Math.max(
    EPSILON,
    args.faceBounds.max.z - args.faceBounds.min.z,
  );
  const margin = Math.max(
    HAIR_CLEARANCE_MARGIN_MIN,
    faceDepth * HAIR_CLEARANCE_MARGIN_DEPTH_RATIO,
  );
  const offsetLocal = clearance + margin;
  return {
    offsetLocal,
    frontZLocal: args.frontZLocal + frontSign * offsetLocal,
  };
}

/**
 * A primitive's islands (connected triangles), largest first, with where each
 * lies on its texture. `leftSign` turns anchor-space x toward the Avatar's
 * left (VRM 0 heads face −Z, so their left is −x).
 */
function extractPrimitiveIslandsInAnchorSpace(args: {
  avatar: Avatar;
  binding: RuntimePrimitiveBindingEntry;
  anchorObject: THREE.Object3D;
  leftSign: 1 | -1;
}): PrimitiveIsland[] {
  const primitiveData = collectPrimitiveData({
    avatar: args.avatar,
    binding: args.binding,
    anchorObject: args.anchorObject,
  });
  if (!primitiveData) return [];

  const uv = args.binding.object.geometry.getAttribute("uv");
  const mapping = TextureUvMapping.of(baseTextureOf(args.binding.object));
  const textureLayoutOf = (vertexIndices: readonly number[]) =>
    uv instanceof THREE.BufferAttribute
      ? measureTextureLayout({
          uv,
          mapping,
          vertexIndices,
          pointsByIndex: primitiveData.pointsByIndex,
          leftSign: args.leftSign,
        })
      : { textureRect: null, textureMirrored: false };

  if (!primitiveData.indexed) {
    const points = primitiveData.orderedPoints;
    const bounds = createBoxFromPoints(points);
    if (!bounds) return [];
    return [
      {
        bindingKey: args.binding.bindingKey,
        materialName: args.binding.materialName,
        vertexCount: points.length,
        bounds,
        center: computeCentroid(points),
        ...textureLayoutOf(primitiveData.uniqueVertexIndices),
      },
    ];
  }

  const unionFind = new UnionFind();
  primitiveData.uniqueVertexIndices.forEach((vertexIndex) => {
    unionFind.add(vertexIndex);
  });

  for (
    let offset = 0;
    offset + 2 < primitiveData.orderedVertexIndices.length;
  ) {
    const a = primitiveData.orderedVertexIndices[offset];
    const b = primitiveData.orderedVertexIndices[offset + 1];
    const c = primitiveData.orderedVertexIndices[offset + 2];
    unionFind.union(a, b);
    unionFind.union(b, c);
    unionFind.union(a, c);
    offset += 3;
  }

  const components = new Map<number, number[]>();
  primitiveData.uniqueVertexIndices.forEach((vertexIndex) => {
    const root = unionFind.find(vertexIndex);
    const members = components.get(root) ?? [];
    members.push(vertexIndex);
    components.set(root, members);
  });

  const islands = Array.from(components.values())
    .map((componentVertexIndices) => {
      const points = componentVertexIndices
        .map(
          (vertexIndex) => primitiveData.pointsByIndex.get(vertexIndex) ?? null,
        )
        .filter((value): value is THREE.Vector3 => value !== null);
      const bounds = createBoxFromPoints(points);
      if (!bounds) return null;
      return {
        bindingKey: args.binding.bindingKey,
        materialName: args.binding.materialName,
        vertexCount: points.length,
        bounds,
        center: computeCentroid(points),
        ...textureLayoutOf(componentVertexIndices),
      } satisfies PrimitiveIsland;
    })
    .filter((value): value is PrimitiveIsland => value !== null);

  return islands.sort((a, b) => b.vertexCount - a.vertexCount);
}

/**
 * The island holding an eye's iris art: of the islands layered over `eye`
 * (same primitive, centre inside its outline, at least half its width and
 * height), the one with the largest texture area, else `eye` itself. A small
 * patch mapped to a large texture area (a gloss gradient) is thus not taken
 * for the iris.
 */
function irisArtIsland(
  eye: PrimitiveIsland,
  islands: readonly PrimitiveIsland[],
): PrimitiveIsland {
  let best = eye;
  for (const island of islands) {
    const rect = island.textureRect;
    const size = island.bounds.getSize(new THREE.Vector3());
    const eyeSize = eye.bounds.getSize(new THREE.Vector3());
    if (
      !rect ||
      island.bindingKey !== eye.bindingKey ||
      island.center.x < eye.bounds.min.x ||
      island.center.x > eye.bounds.max.x ||
      island.center.y < eye.bounds.min.y ||
      island.center.y > eye.bounds.max.y ||
      size.x < eyeSize.x * 0.5 ||
      size.y < eyeSize.y * 0.5
    ) {
      continue;
    }
    const bestRect = best.textureRect;
    if (
      !bestRect ||
      rect.width * rect.height > bestRect.width * bestRect.height
    ) {
      best = island;
    }
  }
  return best;
}

/**
 * Where some vertices lie on their texture's image, and which way their art
 * runs. The rectangle bounds their UVs through `mapping`, wrapped together by
 * the tile of their UV bounds' centre. The art is mirrored when the image's x
 * falls toward the Avatar's left: on VRoid irises it grows that way on both
 * eyes, which iris art assumes. A trend weaker than
 * {@link TEXTURE_DIRECTION_MIN_CORRELATION} counts as not mirrored.
 */
function measureTextureLayout(args: {
  uv: THREE.BufferAttribute;
  mapping: TextureUvMapping;
  vertexIndices: readonly number[];
  pointsByIndex: ReadonlyMap<number, THREE.Vector3>;
  leftSign: 1 | -1;
}): { textureRect: AvatarFaceTextureRect | null; textureMirrored: boolean } {
  const { uv, mapping, vertexIndices } = args;
  if (vertexIndices.length === 0) {
    return { textureRect: null, textureMirrored: false };
  }
  const raw = new THREE.Box2();
  for (const vertexIndex of vertexIndices) {
    raw.expandByPoint(
      new THREE.Vector2(uv.getX(vertexIndex), uv.getY(vertexIndex)),
    );
  }
  const reference = raw.getCenter(new THREE.Vector2());
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  // Sums for the correlation of image x with position along the left.
  let count = 0;
  let sumX = 0;
  let sumL = 0;
  let sumXX = 0;
  let sumLL = 0;
  let sumXL = 0;
  for (const vertexIndex of vertexIndices) {
    const { x: u, y: v } = mapping.toImage(
      { x: uv.getX(vertexIndex), y: uv.getY(vertexIndex) },
      reference,
    );
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
    const point = args.pointsByIndex.get(vertexIndex);
    if (!point) continue;
    const left = point.x * args.leftSign;
    count += 1;
    sumX += u;
    sumL += left;
    sumXX += u * u;
    sumLL += left * left;
    sumXL += u * left;
  }
  const covariance = sumXL / count - (sumX / count) * (sumL / count);
  const spread = Math.sqrt(
    Math.max(0, sumXX / count - (sumX / count) ** 2) *
      Math.max(0, sumLL / count - (sumL / count) ** 2),
  );
  return {
    textureRect: { x: minU, y: minV, width: maxU - minU, height: maxV - minV },
    textureMirrored:
      count > 2 &&
      spread > 0 &&
      covariance / spread < -TEXTURE_DIRECTION_MIN_CORRELATION,
  };
}

/**
 * A primitive's bounds in anchor space. A face primitive that also holds the
 * neck or body counts only its head-weighted vertices, or its head region's
 * when it holds the whole body (`createFaceVertexFilter`).
 */
function computePrimitiveBoundsInAnchorSpace(args: {
  avatar: Avatar;
  binding: RuntimePrimitiveBindingEntry;
  anchorObject: THREE.Object3D;
}): THREE.Box3 | null {
  const primitiveData = collectPrimitiveData(args);
  if (!primitiveData) return null;
  const keep = args.avatar.vrm
    ? createFaceVertexFilter(
        args.avatar.vrm,
        args.binding.object,
        findFaceSkinRegion(args.avatar.facePartMap, args.binding.bindingKey),
      )
    : null;
  if (!keep) return createBoxFromPoints(primitiveData.orderedPoints);
  const points = primitiveData.uniqueVertexIndices
    .filter(keep)
    .map((vertex) => primitiveData.pointsByIndex.get(vertex))
    .filter((point): point is THREE.Vector3 => point !== undefined);
  // A corrected face with no head-weighted vertices still has bounds.
  return createBoxFromPoints(
    points.length > 0 ? points : primitiveData.orderedPoints,
  );
}
