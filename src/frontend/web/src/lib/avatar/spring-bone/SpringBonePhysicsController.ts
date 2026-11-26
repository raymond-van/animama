import * as THREE from "three";
import {
  VRMSpringBoneColliderHelper,
  VRMSpringBoneJointHelper,
  type VRM,
  type VRMSpringBoneJoint,
} from "@pixiv/three-vrm";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  addAvatarIssue,
  mergeAvatarIssues,
  type AvatarIssue,
} from "../diagnostics/issues";
import { ANIMAMA_CONVERSION_EXTENSION } from "../avatarConversionMarker";
import type { AvatarAnimationState, EmotionLabel } from "../types";
import {
  buildSpringBoneSemanticAssignments,
  type SpringBoneSemanticAssignment,
  type SpringBoneSemanticClassification,
  type SpringBoneSemanticJointCounts,
} from "./SpringBoneSemanticClassifier";
import {
  DEFAULT_SPRING_BONE_SEMANTIC_PROFILES,
  SPRING_BONE_SEMANTICS,
  UNPROFILED_SPRING_BONE_INTENSITY_SCALE,
  type SpringBoneSemantic,
  type SpringBoneSemanticProfileOverride,
} from "./SpringBoneSemanticProfile";

const MAX_PHYSICS_DELTA_SEC = 0.1;
const DEG_TO_RAD = Math.PI / 180;
const ZERO_GRAVITY_BASELINE = 0.5;
const MIN_FORCE_LENGTH = 0.000001;
const MAX_WARNINGS = 5;
const SPRING_BONE_HELPER_RENDER_ORDER = 10_000;
const SPRING_BONE_COLLIDER_HELPER_COLOR = 0xd946ef;
const UNPROFILED_SPRING_BONE_HELPER_COLOR = 0x94a3b8;
const UNMAPPED_SPRING_BONE_HELPER_COLOR = 0xef4444;
const FOOT_BONE_NAMES = ["leftFoot", "rightFoot"] as const;
const SPRING_BONE_SEMANTIC_HELPER_COLORS = {
  hair: 0xfacc15,
  cloth: 0x38bdf8,
  accessory: 0xf472b6,
  tail: 0x4ade80,
  ear: 0x22d3ee,
  chest: 0xfb923c,
} satisfies Record<SpringBoneSemantic, number>;

export type SpringBonePhysicsParams = {
  enabled: boolean;
  gravityMultiplier: number;
  dragMultiplier: number;
  windStrength: number;
  windDirectionDeg: number;
  updraftStrength: number;
  updraftRadius: number;
  fluctuation: number;
  gusts: boolean;
  helpersVisible: boolean;
};

type ResolvedSpringBoneSemanticProfile = {
  intensityScale: number;
  params?: Partial<SpringBonePhysicsParams>;
};

export const DEFAULT_SPRING_BONE_PHYSICS_PARAMS: SpringBonePhysicsParams = {
  enabled: true,
  gravityMultiplier: 1,
  dragMultiplier: 2,
  windStrength: 0,
  windDirectionDeg: 0,
  updraftStrength: 0.95,
  updraftRadius: 1,
  fluctuation: 0,
  gusts: true,
  helpersVisible: false,
};

export type SpringBonePhysicsRuntimeContext = {
  avatarState: AvatarAnimationState;
  emotionLabel: EmotionLabel;
};

export type SpringBoneSemanticAssignmentSnapshot = {
  id: string;
  semantic: SpringBoneSemanticAssignment["semantic"];
  intensityScale: number;
  confidence: number;
  source: SpringBoneSemanticAssignment["source"];
  springName: string | null;
  comment: string | null;
  runtimeBoneName: string | null;
  runtimeNodeIndex: number | null;
  rootNodeNames: string[];
  jointNodeNames: string[];
};

export type SpringBoneSemanticProfileSnapshot = {
  semantic: SpringBoneSemantic;
  defaultIntensityScale: number;
  intensityScale: number;
  intensityOverridden: boolean;
  params: SpringBonePhysicsParams;
  overriddenParamKeys: Array<keyof SpringBonePhysicsParams>;
};

export type SpringBonePhysicsSnapshot = {
  ready: boolean;
  disposed: boolean;
  hasManager: boolean;
  /** False for Avatars whose springs ignore wind and the updraft. */
  ambientForces: boolean;
  /** The owner's wind strength, as a multiple of the default (1). */
  ambientStrength: number;
  jointCount: number;
  colliderCount: number;
  cachedJointCount: number;
  overridingSettings: boolean;
  params: SpringBonePhysicsParams;
  gustStrengthOffset: number;
  gustDirectionOffsetDeg: number;
  nextGustChangeInSec: number | null;
  helpersAvailable: boolean;
  helpersVisible: boolean;
  helperCount: number;
  helperHostAttached: boolean;
  footBonesResolved: string[];
  footBonesMissing: string[];
  warnings: string[];
  /** This controller's and the classifier's warnings as stable codes. */
  issues: AvatarIssue[];
  semanticProfileReady: boolean;
  semanticJointCounts: SpringBoneSemanticJointCounts;
  semanticAssignmentCount: number;
  semanticWarnings: string[];
  semanticProfiles: SpringBoneSemanticProfileSnapshot[];
  semanticAssignments: SpringBoneSemanticAssignmentSnapshot[];
};

export type SpringBonePhysicsControllerOptions = {
  sourceGltf?: GLTF | null;
  parserJson?: unknown | null;
  associations?: GLTF["parser"]["associations"] | null;
  /**
   * Whether wind, the updraft and the zero-gravity baseline apply (default
   * true). See `springsTunedWithoutAmbientForces`.
   */
  ambientForces?: boolean;
  /** The owner's wind strength, as a multiple of the default (default 1). */
  ambientStrength?: number;
};

/**
 * Share of an Avatar's hair spring joints that the updraft may lift past their
 * rest before Automatic drops ambient forces ({@link
 * SpringBonePhysicsController.updraftLiftsHair}): more than half.
 */
const HAIR_LIFTED_SHARE = 0.5;

/**
 * glTF extensions that mark a converted Avatar whose springs were tuned
 * without ambient forces: Mochiya Avatar Tools writes the first into every
 * Avatar it converts, including VRChat Avatars (see
 * docs/frontend/runtime/vrchat-avatar-conversion.md); Animama Avatar
 * Converter writes the second into MikuMikuDance (PMX) conversions (see
 * docs/frontend/runtime/mmd-model-conversion.md).
 */
const CONVERSION_EXTENSIONS = [
  "MOCHIYA_avatar_composition",
  ANIMAMA_CONVERSION_EXTENSION,
];

/**
 * Whether an Avatar's springs were tuned without ambient forces, so wind and
 * the updraft must not be added. VRChat PhysBones hold their shape with low
 * pull and little gravity, and VRChat adds no ambient forces; MMD physics is
 * a rigid-body simulation without wind either. Converted to VRM springs, both
 * are far softer than VRM-authored hair: the updraft lifts a hanging ponytail
 * straight up and balloons a skirt. Detected from the converters' extensions,
 * so it holds only while a re-export keeps them.
 */
export function springsTunedWithoutAmbientForces(parserJson: unknown): boolean {
  const used = (parserJson as { extensionsUsed?: unknown } | null)
    ?.extensionsUsed;
  return (
    Array.isArray(used) &&
    CONVERSION_EXTENSIONS.some((name) => used.includes(name))
  );
}

/** An owner's wind strength multiple: finite and at least 0, else 1. */
function sanitizeAmbientStrength(strength: number | undefined): number {
  return typeof strength === "number" && Number.isFinite(strength)
    ? Math.max(0, strength)
    : 1;
}

/**
 * How much of the updraft reaches a joint at `position` (squared radial
 * falloff around the fan between the feet, wider higher up) and its
 * horizontal distance from the fan.
 */
function updraftFalloff(
  position: THREE.Vector3,
  fanOrigin: THREE.Vector3,
  updraftRadius: number,
): { falloff: number; horizontalDistance: number } {
  const dx = position.x - fanOrigin.x;
  const dz = position.z - fanOrigin.z;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
  const heightAboveFan = Math.max(0, position.y - fanOrigin.y);
  const effectiveRadius = Math.max(0.05, updraftRadius + heightAboveFan * 0.15);
  const radiusFalloff = Math.max(0, 1 - horizontalDistance / effectiveRadius);
  return { falloff: radiusFalloff * radiusFalloff, horizontalDistance };
}

type OriginalSpringJointSettings = {
  stiffness: number;
  gravityPower: number;
  gravityDir: THREE.Vector3;
  dragForce: number;
};

type SpringBoneHelper = THREE.Group & {
  dispose?: () => void;
};

export class SpringBonePhysicsController {
  private _vrm: VRM | null;
  private _params: SpringBonePhysicsParams = {
    ...DEFAULT_SPRING_BONE_PHYSICS_PARAMS,
  };
  private _originalSettings = new Map<
    VRMSpringBoneJoint,
    OriginalSpringJointSettings
  >();
  private _isDisposed: boolean = false;
  private _ambientForces: boolean;
  private _ambientStrength: number;
  private _overridingSettings: boolean = false;
  private _elapsedSec: number = 0;
  private _nextGustChangeAtSec: number = 0;
  private _gustStrengthOffset: number = 0;
  private _targetGustStrengthOffset: number = 0;
  private _gustDirectionOffsetDeg: number = 0;
  private _targetGustDirectionOffsetDeg: number = 0;
  private _helperHost: THREE.Object3D | null = null;
  private _helperRoot: THREE.Group | null = null;
  private _helpers: SpringBoneHelper[] = [];
  private _warnings: string[] = [];
  private _issues: AvatarIssue[] = [];
  private _semanticClassification: SpringBoneSemanticClassification;
  private _semanticProfileOverrides: Partial<
    Record<SpringBoneSemantic, SpringBoneSemanticProfileOverride>
  > = {};

  private _force = new THREE.Vector3();
  private _originalGravityDir = new THREE.Vector3();
  private _jointWorldPosition = new THREE.Vector3();
  private _fanOrigin = new THREE.Vector3();
  private _leftFootPosition = new THREE.Vector3();
  private _rightFootPosition = new THREE.Vector3();

  constructor(vrm: VRM, options: SpringBonePhysicsControllerOptions = {}) {
    this._vrm = vrm;
    this._ambientForces = options.ambientForces ?? true;
    this._ambientStrength = sanitizeAmbientStrength(options.ambientStrength);
    this._semanticClassification = buildSpringBoneSemanticAssignments({
      vrm,
      sourceGltf: options.sourceGltf,
      parserJson: options.parserJson,
      associations: options.associations,
    });
    this._cacheOriginalSettings();
  }

  update(deltaSec: number, _context?: SpringBonePhysicsRuntimeContext): void {
    void _context;
    if (this._isDisposed || !this._vrm) return;

    this._syncHelpers();

    if (!this._params.enabled) {
      if (this._overridingSettings) {
        this._restoreOriginalSettings();
      }
      return;
    }

    const manager = this._vrm.springBoneManager;
    if (!manager) return;

    this._cacheOriginalSettings();

    const clampedDeltaSec = this._clampDelta(deltaSec);
    this._elapsedSec += clampedDeltaSec;
    this._updateGustOffsets(clampedDeltaSec, this._params);
    let fanOriginResolved = false;
    let fanOrigin: THREE.Vector3 | null = null;

    for (const joint of manager.joints) {
      const original = this._originalSettings.get(joint);
      if (!original) continue;

      const profile = this._resolveJointSemanticProfile(joint);
      const intensityScale = sanitizeIntensityScale(
        profile.intensityScale,
        UNPROFILED_SPRING_BONE_INTENSITY_SCALE,
      );
      const resolvedParams = this._resolveProfileParams(profile);
      const wind = this._resolveWindAndUpdraft(resolvedParams);
      const ambientScale = this._ambientForces
        ? intensityScale * this._ambientStrength
        : 0;
      const windStrength = wind.windStrength * ambientScale;
      const updraftStrength = wind.updraftStrength * ambientScale;
      const gravityMultiplier = scaleSpringBoneMultiplier(
        resolvedParams.gravityMultiplier,
        intensityScale,
      );
      const dragMultiplier = scaleSpringBoneMultiplier(
        resolvedParams.dragMultiplier,
        intensityScale,
      );
      const settings = joint.settings;
      const forceControlsActive =
        gravityMultiplier !== 1 || windStrength > 0 || updraftStrength > 0;
      const baseGravityPower =
        original.gravityPower === 0 && forceControlsActive
          ? ZERO_GRAVITY_BASELINE * intensityScale
          : original.gravityPower;
      const baseGravity = baseGravityPower * gravityMultiplier;

      // three-vrm's inertia is 1 − drag; above 1 it turns negative. Included
      // Avatars stay at or below it; converted PhysBones can author 0.86.
      settings.dragForce = Math.min(1, original.dragForce * dragMultiplier);

      this._originalGravityDir.copy(original.gravityDir);
      if (this._originalGravityDir.lengthSq() < MIN_FORCE_LENGTH) {
        this._originalGravityDir.set(0, -1, 0);
      }
      this._originalGravityDir.normalize();
      this._force.copy(this._originalGravityDir).multiplyScalar(baseGravity);

      if (windStrength > 0) {
        const windRad = wind.windDirectionDeg * DEG_TO_RAD;
        this._force.x += Math.sin(windRad) * windStrength;
        this._force.z += -Math.cos(windRad) * windStrength;
      }

      if (updraftStrength > 0 && !fanOriginResolved) {
        fanOrigin = this._getFootFanOrigin();
        fanOriginResolved = true;
      }

      if (fanOrigin && updraftStrength > 0) {
        // The falloff is soft, so the joint's world matrix from the latest
        // full update (this frame's look-at pass or the last render) is close
        // enough. Updating each joint's parent chain here recomputed the
        // shared hair chains for every joint, twice, every frame.
        this._jointWorldPosition.setFromMatrixPosition(joint.bone.matrixWorld);

        const { falloff, horizontalDistance } = updraftFalloff(
          this._jointWorldPosition,
          fanOrigin,
          resolvedParams.updraftRadius,
        );
        const verticalFlutter = resolvedParams.gusts
          ? 1 + Math.sin(this._elapsedSec * 2.7 + horizontalDistance * 5) * 0.04
          : 1;
        this._force.y += updraftStrength * falloff * verticalFlutter;
      }

      const forceLength = this._force.length();
      if (forceLength > MIN_FORCE_LENGTH) {
        settings.gravityDir.copy(this._force).divideScalar(forceLength);
        settings.gravityPower = forceLength;
      } else {
        settings.gravityDir.copy(original.gravityDir);
        settings.gravityPower = 0;
      }
    }

    this._overridingSettings = true;
  }

  updateHelpers(): void {
    if (
      this._isDisposed ||
      !this._helperRoot ||
      !this._helperRoot.visible ||
      this._helpers.length === 0
    ) {
      return;
    }

    for (const helper of this._helpers) {
      helper.updateMatrixWorld(true);
    }
  }

  setHelperHost(host: THREE.Object3D | null): void {
    if (this._helperHost === host) return;
    this._disposeHelpers();
    this._helperHost = host;
    this._syncHelpers();
  }

  getSnapshot(): SpringBonePhysicsSnapshot {
    const manager = this._vrm?.springBoneManager;
    const footBones = this._getFootBoneSnapshot();
    const semanticProfileReady = Boolean(
      this._vrm && !this._isDisposed && this._semanticClassification.ready,
    );
    return {
      ready: Boolean(this._vrm && !this._isDisposed),
      disposed: this._isDisposed,
      hasManager: Boolean(manager),
      ambientForces: this._ambientForces,
      ambientStrength: this._ambientStrength,
      jointCount: manager?.joints.size ?? 0,
      colliderCount: manager?.colliders.length ?? 0,
      cachedJointCount: this._originalSettings.size,
      overridingSettings: this._overridingSettings,
      params: { ...this._params },
      gustStrengthOffset: this._gustStrengthOffset,
      gustDirectionOffsetDeg: this._gustDirectionOffsetDeg,
      nextGustChangeInSec:
        this._nextGustChangeAtSec > this._elapsedSec
          ? this._nextGustChangeAtSec - this._elapsedSec
          : null,
      helpersAvailable: Boolean(this._helperHost && manager),
      helpersVisible: Boolean(this._helperRoot?.visible),
      helperCount: this._helpers.length,
      helperHostAttached: Boolean(this._helperHost),
      footBonesResolved: footBones.resolved,
      footBonesMissing: footBones.missing,
      warnings: [...this._warnings],
      issues: mergeAvatarIssues(
        this._issues,
        semanticProfileReady ? this._semanticClassification.issues : null,
      ),
      semanticProfileReady,
      semanticJointCounts: semanticProfileReady
        ? { ...this._semanticClassification.counts }
        : {
            total: 0,
            hair: 0,
            cloth: 0,
            accessory: 0,
            tail: 0,
            ear: 0,
            chest: 0,
            unprofiled: 0,
            unmapped: 0,
            lowConfidence: 0,
          },
      semanticAssignmentCount: semanticProfileReady
        ? this._semanticClassification.assignmentCount
        : 0,
      semanticWarnings: semanticProfileReady
        ? [...this._semanticClassification.warnings]
        : [],
      semanticProfiles: this._getSemanticProfileSnapshots(),
      semanticAssignments: semanticProfileReady
        ? this._getSemanticAssignmentSnapshots()
        : [],
    };
  }

  setEnabled(enabled: boolean): void {
    this.setParams({ enabled });
  }

  /**
   * Apply or drop wind and updraft (the Avatar's wind setting). Without them
   * joints keep their authored gravity and drag.
   */
  setAmbientForces(enabled: boolean): void {
    this._ambientForces = enabled;
  }

  /**
   * Scale wind and the updraft (the Avatar's wind strength): 1 is the
   * default, 0 adds none.
   */
  setAmbientStrength(strength: number): void {
    this._ambientStrength = sanitizeAmbientStrength(strength);
  }

  /**
   * Whether the updraft, at `strength` times its default, would lift most of
   * the Avatar's hair past its rest pose, so Automatic leaves ambient forces
   * off. Each hair joint (every joint when none is classified as hair) is
   * read at rest: its net upward pull, the updraft as `update` applies it at
   * the joint less its authored gravity (or the zero-gravity baseline that
   * replaces none), beats its stiffness when that pull exceeds it, and a
   * hanging strand then turns up. VRM-authored hair is stiff enough; springs
   * tuned for a world without ambient forces, as many chibi and converted
   * Avatars' are, are not.
   */
  updraftLiftsHair(strength = 1): boolean {
    const manager = this._vrm?.springBoneManager;
    if (!manager || strength <= 0) return false;
    this._vrm!.scene.updateMatrixWorld(true);
    const fanOrigin = this._getFootFanOrigin();
    if (!fanOrigin) return false;
    const joints = [...manager.joints];
    const hair = joints.filter(
      (joint) =>
        this._semanticClassification.assignments.get(joint)?.semantic ===
        "hair",
    );
    const considered = hair.length > 0 ? hair : joints;
    let counted = 0;
    let lifted = 0;
    for (const joint of considered) {
      const original = this._originalSettings.get(joint);
      if (!original) continue;
      const profile = this._resolveJointSemanticProfile(joint);
      const intensityScale = sanitizeIntensityScale(
        profile.intensityScale,
        UNPROFILED_SPRING_BONE_INTENSITY_SCALE,
      );
      const params = this._resolveProfileParams(profile);
      this._jointWorldPosition.setFromMatrixPosition(joint.bone.matrixWorld);
      const updraft =
        params.updraftStrength *
        intensityScale *
        strength *
        updraftFalloff(
          this._jointWorldPosition,
          fanOrigin,
          params.updraftRadius,
        ).falloff;
      const gravityPower =
        original.gravityPower === 0
          ? ZERO_GRAVITY_BASELINE * intensityScale
          : original.gravityPower;
      const down =
        original.gravityDir.lengthSq() < MIN_FORCE_LENGTH
          ? 1
          : -original.gravityDir.clone().normalize().y;
      counted += 1;
      if (updraft - gravityPower * down > original.stiffness) lifted += 1;
    }
    return counted > 0 && lifted / counted > HAIR_LIFTED_SHARE;
  }

  setParams(params: Partial<SpringBonePhysicsParams>): void {
    const wasEnabled = this._params.enabled;
    this._params = sanitizeSpringBonePhysicsParams({
      ...this._params,
      ...params,
    });

    if (wasEnabled && !this._params.enabled) {
      this._restoreOriginalSettings();
      this._resetGustState();
    }

    if ("helpersVisible" in params) {
      this._syncHelpers();
    }
  }

  reset(): void {
    this._restoreOriginalSettings();
    this._params = { ...DEFAULT_SPRING_BONE_PHYSICS_PARAMS };
    this._semanticProfileOverrides = {};
    this._resetGustState();
    this._syncHelpers();
  }

  setSemanticProfileOverride(
    semantic: SpringBoneSemantic,
    override: SpringBoneSemanticProfileOverride,
  ): void {
    const current = this._semanticProfileOverrides[semantic] ?? {};
    const next: SpringBoneSemanticProfileOverride = { ...current };

    if (Object.prototype.hasOwnProperty.call(override, "intensityScale")) {
      next.intensityScale = sanitizeIntensityScale(
        override.intensityScale ?? Number.NaN,
        DEFAULT_SPRING_BONE_SEMANTIC_PROFILES[semantic].intensityScale,
      );
    }

    if (override.params) {
      next.params = {
        ...current.params,
        ...sanitizeSpringBonePhysicsParamPatch(override.params),
      };
    }

    this._semanticProfileOverrides = {
      ...this._semanticProfileOverrides,
      [semantic]: next,
    };
  }

  resetSemanticProfileOverrides(semantic?: SpringBoneSemantic): void {
    if (!semantic) {
      this._semanticProfileOverrides = {};
      return;
    }

    const { [semantic]: _removed, ...rest } = this._semanticProfileOverrides;
    void _removed;
    this._semanticProfileOverrides = rest;
  }

  dispose(): void {
    if (this._isDisposed) return;

    this._restoreOriginalSettings();
    this._disposeHelpers();
    this._originalSettings.clear();
    this._semanticClassification.assignments.clear();
    this._semanticProfileOverrides = {};
    this._vrm = null;
    this._helperHost = null;
    this._isDisposed = true;
  }

  private _resolveSemanticProfile(
    semantic: SpringBoneSemantic,
  ): ResolvedSpringBoneSemanticProfile {
    const defaultProfile = DEFAULT_SPRING_BONE_SEMANTIC_PROFILES[semantic];
    const override = this._semanticProfileOverrides[semantic];

    return {
      intensityScale: sanitizeIntensityScale(
        override?.intensityScale ?? defaultProfile.intensityScale,
        defaultProfile.intensityScale,
      ),
      params: {
        ...defaultProfile.params,
        ...override?.params,
      },
    };
  }

  private _resolveJointSemanticProfile(
    joint: VRMSpringBoneJoint,
  ): ResolvedSpringBoneSemanticProfile {
    const semantic =
      this._semanticClassification.assignments.get(joint)?.semantic;

    if (semantic) {
      return this._resolveSemanticProfile(semantic);
    }

    return {
      intensityScale: UNPROFILED_SPRING_BONE_INTENSITY_SCALE,
      params: {},
    };
  }

  private _resolveProfileParams(
    profile: ResolvedSpringBoneSemanticProfile,
  ): SpringBonePhysicsParams {
    return sanitizeSpringBonePhysicsParams({
      ...this._params,
      ...profile.params,
    });
  }

  private _updateGustOffsets(
    deltaSec: number,
    params: SpringBonePhysicsParams,
  ): void {
    if (
      params.gusts &&
      params.fluctuation > 0 &&
      (params.windStrength > 0 || params.updraftStrength > 0)
    ) {
      if (this._elapsedSec >= this._nextGustChangeAtSec) {
        this._targetGustStrengthOffset =
          (-0.5 + Math.random() * 1.3) * params.fluctuation;
        this._targetGustDirectionOffsetDeg =
          (-20 + Math.random() * 40) * params.fluctuation;
        this._nextGustChangeAtSec =
          this._elapsedSec + 0.7 + Math.random() * 1.6;
      }

      const smooth = 1 - Math.exp(deltaSec * -1.8);
      this._gustStrengthOffset +=
        (this._targetGustStrengthOffset - this._gustStrengthOffset) * smooth;
      this._gustDirectionOffsetDeg +=
        (this._targetGustDirectionOffsetDeg - this._gustDirectionOffsetDeg) *
        smooth;
      return;
    }

    this._targetGustStrengthOffset = 0;
    this._targetGustDirectionOffsetDeg = 0;
    const smooth = 1 - Math.exp(deltaSec * -1.8);
    this._gustStrengthOffset += (0 - this._gustStrengthOffset) * smooth;
    this._gustDirectionOffsetDeg += (0 - this._gustDirectionOffsetDeg) * smooth;
  }

  private _resolveWindAndUpdraft(params: SpringBonePhysicsParams): {
    windStrength: number;
    windDirectionDeg: number;
    updraftStrength: number;
  } {
    let windStrength = params.windStrength;
    let windDirectionDeg = params.windDirectionDeg;
    let updraftStrength = params.updraftStrength;

    if (
      params.gusts &&
      params.fluctuation > 0 &&
      (windStrength > 0 || updraftStrength > 0)
    ) {
      const strengthFactor = THREE.MathUtils.clamp(
        1 + this._gustStrengthOffset,
        1 - 0.8 * params.fluctuation,
        1 + 1.1 * params.fluctuation,
      );
      windStrength *= strengthFactor;
      updraftStrength *= strengthFactor;
      windDirectionDeg += this._gustDirectionOffsetDeg;
    }

    return {
      windStrength,
      windDirectionDeg,
      updraftStrength,
    };
  }

  private _getFootFanOrigin(): THREE.Vector3 | null {
    const humanoid = this._vrm?.humanoid;
    const leftFoot = humanoid?.getNormalizedBoneNode("leftFoot");
    const rightFoot = humanoid?.getNormalizedBoneNode("rightFoot");
    if (!leftFoot || !rightFoot) return null;

    // `getWorldPosition` would update each chain a second time.
    leftFoot.updateWorldMatrix(true, false);
    rightFoot.updateWorldMatrix(true, false);
    this._leftFootPosition.setFromMatrixPosition(leftFoot.matrixWorld);
    this._rightFootPosition.setFromMatrixPosition(rightFoot.matrixWorld);

    this._fanOrigin
      .copy(this._leftFootPosition)
      .add(this._rightFootPosition)
      .multiplyScalar(0.5);
    return this._fanOrigin;
  }

  private _getFootBoneSnapshot(): { resolved: string[]; missing: string[] } {
    const humanoid = this._vrm?.humanoid;
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const boneName of FOOT_BONE_NAMES) {
      if (humanoid?.getNormalizedBoneNode(boneName)) {
        resolved.push(boneName);
      } else {
        missing.push(boneName);
      }
    }
    return { resolved, missing };
  }

  private _getSemanticAssignmentSnapshots(): SpringBoneSemanticAssignmentSnapshot[] {
    return Array.from(this._semanticClassification.assignments.entries()).map(
      ([joint, assignment], index) => ({
        id: `${assignment.runtimeNodeIndex ?? "runtime"}:${index}`,
        semantic: assignment.semantic,
        intensityScale: assignment.intensityScale,
        confidence: assignment.confidence,
        source: assignment.source,
        springName: assignment.springName ?? null,
        comment: assignment.comment ?? null,
        runtimeBoneName: joint.bone.name.trim() || null,
        runtimeNodeIndex: assignment.runtimeNodeIndex,
        rootNodeNames: [...assignment.rootNodeNames],
        jointNodeNames: [...assignment.jointNodeNames],
      }),
    );
  }

  private _getSemanticProfileSnapshots(): SpringBoneSemanticProfileSnapshot[] {
    return SPRING_BONE_SEMANTICS.map((semantic) => {
      const defaultProfile = DEFAULT_SPRING_BONE_SEMANTIC_PROFILES[semantic];
      const override = this._semanticProfileOverrides[semantic];
      const profile = this._resolveSemanticProfile(semantic);

      return {
        semantic,
        defaultIntensityScale: defaultProfile.intensityScale,
        intensityScale: profile.intensityScale,
        intensityOverridden: typeof override?.intensityScale === "number",
        params: this._resolveProfileParams(profile),
        overriddenParamKeys: Object.keys(override?.params ?? {}) as Array<
          keyof SpringBonePhysicsParams
        >,
      };
    });
  }

  private _cacheOriginalSettings(): void {
    const manager = this._vrm?.springBoneManager;
    if (!manager) return;

    for (const joint of manager.joints) {
      if (this._originalSettings.has(joint)) continue;
      this._originalSettings.set(joint, {
        stiffness: joint.settings.stiffness,
        gravityPower: joint.settings.gravityPower,
        gravityDir: joint.settings.gravityDir.clone(),
        dragForce: joint.settings.dragForce,
      });
    }
  }

  private _restoreOriginalSettings(): void {
    const manager = this._vrm?.springBoneManager;
    if (!manager) {
      this._overridingSettings = false;
      return;
    }

    for (const joint of manager.joints) {
      const original = this._originalSettings.get(joint);
      if (!original) continue;
      joint.settings.stiffness = original.stiffness;
      joint.settings.gravityPower = original.gravityPower;
      joint.settings.gravityDir.copy(original.gravityDir);
      joint.settings.dragForce = original.dragForce;
    }

    manager.reset();
    this._overridingSettings = false;
  }

  private _syncHelpers(): void {
    if (this._isDisposed) return;

    if (!this._params.helpersVisible) {
      if (this._helperRoot) {
        this._helperRoot.visible = false;
      }
      return;
    }

    if (!this._helperHost || !this._vrm?.springBoneManager) return;

    if (!this._helperRoot) {
      this._buildHelpers();
    }

    if (this._helperRoot) {
      this._helperRoot.visible = true;
    }
  }

  private _buildHelpers(): void {
    const manager = this._vrm?.springBoneManager;
    if (!manager || !this._helperHost) return;

    this._disposeHelpers();

    const helperRoot = new THREE.Group();
    helperRoot.name = "AnimaSpringBonePhysicsHelpers";
    helperRoot.visible = this._params.helpersVisible;
    this._helperRoot = helperRoot;
    this._helperHost.add(helperRoot);

    for (const collider of manager.colliders) {
      this._addHelper(
        () => new VRMSpringBoneColliderHelper(collider),
        SPRING_BONE_COLLIDER_HELPER_COLOR,
      );
    }

    for (const joint of manager.joints) {
      this._addHelper(
        () => new VRMSpringBoneJointHelper(joint),
        this._resolveJointHelperColor(joint),
      );
    }
  }

  private _addHelper(
    createHelper: () => SpringBoneHelper,
    color: number,
  ): void {
    if (!this._helperRoot) return;

    try {
      const helper = createHelper();
      this._styleHelperLines(helper, color);
      this._helpers.push(helper);
      this._helperRoot.add(helper);
    } catch (error) {
      this._pushWarning(
        { code: "springs_helper_failed" },
        error instanceof Error
          ? error.message
          : "Unable to create spring-bone helper.",
      );
    }
  }

  private _resolveJointHelperColor(joint: VRMSpringBoneJoint): number {
    const assignment = this._semanticClassification.assignments.get(joint);
    if (assignment?.semantic) {
      return SPRING_BONE_SEMANTIC_HELPER_COLORS[assignment.semantic];
    }
    if (assignment?.source === "fallback") {
      return UNMAPPED_SPRING_BONE_HELPER_COLOR;
    }
    return UNPROFILED_SPRING_BONE_HELPER_COLOR;
  }

  private _styleHelperLines(root: THREE.Object3D, color: number): void {
    root.traverse((child) => {
      child.renderOrder = SPRING_BONE_HELPER_RENDER_ORDER;
      const material = (
        child as { material?: THREE.Material | THREE.Material[] }
      ).material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          styleSpringBoneHelperMaterial(entry, color);
        }
      } else if (material) {
        styleSpringBoneHelperMaterial(material, color);
      }
    });
  }

  private _disposeHelpers(): void {
    if (this._helperRoot) {
      this._helperRoot.parent?.remove(this._helperRoot);
    }

    for (const helper of this._helpers) {
      this._disposeHelperMaterials(helper);
      helper.dispose?.();
    }

    this._helpers = [];
    this._helperRoot?.clear();
    this._helperRoot = null;
  }

  private _disposeHelperMaterials(root: THREE.Object3D): void {
    root.traverse((child) => {
      const material = (
        child as { material?: THREE.Material | THREE.Material[] }
      ).material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          entry.dispose();
        }
      } else {
        material?.dispose();
      }
    });
  }

  private _resetGustState(): void {
    this._nextGustChangeAtSec = this._elapsedSec;
    this._gustStrengthOffset = 0;
    this._targetGustStrengthOffset = 0;
    this._gustDirectionOffsetDeg = 0;
    this._targetGustDirectionOffsetDeg = 0;
  }

  private _pushWarning(issue: AvatarIssue, warning: string): void {
    addAvatarIssue(this._issues, issue);
    if (this._warnings.includes(warning)) return;
    this._warnings = [...this._warnings, warning].slice(-MAX_WARNINGS);
  }

  private _clampDelta(deltaSec: number): number {
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) return 0;
    return Math.min(deltaSec, MAX_PHYSICS_DELTA_SEC);
  }
}

function sanitizeSpringBonePhysicsParams(
  params: SpringBonePhysicsParams,
): SpringBonePhysicsParams {
  return {
    enabled: Boolean(params.enabled),
    gravityMultiplier: clampFinite(params.gravityMultiplier, 0, 3, 1),
    dragMultiplier: clampFinite(params.dragMultiplier, 0, 3, 2),
    windStrength: clampFinite(params.windStrength, 0, 3, 0),
    windDirectionDeg: normalizeDegrees(params.windDirectionDeg),
    updraftStrength: clampFinite(params.updraftStrength, 0, 3, 0.95),
    updraftRadius: clampFinite(params.updraftRadius, 0.1, 2, 1),
    fluctuation: clampFinite(params.fluctuation, 0, 1, 0),
    gusts: Boolean(params.gusts),
    helpersVisible: Boolean(params.helpersVisible),
  };
}

function styleSpringBoneHelperMaterial(
  material: THREE.Material,
  color: number,
): void {
  const lineMaterial = material as THREE.Material & {
    color?: THREE.Color;
    opacity?: number;
    transparent?: boolean;
    depthTest?: boolean;
    depthWrite?: boolean;
    toneMapped?: boolean;
  };

  lineMaterial.color?.setHex(color);
  lineMaterial.opacity = 0.95;
  lineMaterial.transparent = true;
  lineMaterial.depthTest = false;
  lineMaterial.depthWrite = false;
  lineMaterial.toneMapped = false;
  lineMaterial.needsUpdate = true;
}

function sanitizeSpringBonePhysicsParamPatch(
  params: Partial<SpringBonePhysicsParams>,
): Partial<SpringBonePhysicsParams> {
  const sanitized = sanitizeSpringBonePhysicsParams({
    ...DEFAULT_SPRING_BONE_PHYSICS_PARAMS,
    ...params,
  });

  return {
    ...(Object.prototype.hasOwnProperty.call(params, "enabled")
      ? { enabled: sanitized.enabled }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "gravityMultiplier")
      ? { gravityMultiplier: sanitized.gravityMultiplier }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "dragMultiplier")
      ? { dragMultiplier: sanitized.dragMultiplier }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "windStrength")
      ? { windStrength: sanitized.windStrength }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "windDirectionDeg")
      ? { windDirectionDeg: sanitized.windDirectionDeg }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "updraftStrength")
      ? { updraftStrength: sanitized.updraftStrength }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "updraftRadius")
      ? { updraftRadius: sanitized.updraftRadius }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "fluctuation")
      ? { fluctuation: sanitized.fluctuation }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "gusts")
      ? { gusts: sanitized.gusts }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "helpersVisible")
      ? { helpersVisible: sanitized.helpersVisible }
      : {}),
  };
}

function clampFinite(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return THREE.MathUtils.clamp(value, min, max);
}

function sanitizeIntensityScale(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function scaleSpringBoneMultiplier(
  multiplier: number,
  intensityScale: number,
): number {
  return 1 + (multiplier - 1) * intensityScale;
}

function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}
