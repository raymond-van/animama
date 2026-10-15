import * as THREE from "three";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AnimationManager } from "./AnimationManager";
import { releaseModelScene } from "./releaseModelScene";
import type { AvatarFaceDebugBox } from "./vfx/AvatarFaceDebugBox";
import { DEBUG_ENABLED } from "@/platform/env";
import { AvatarFaceLandmarks } from "./vfx/AvatarFaceLandmarks";
import { AvatarFaceTextureAnchors } from "./vfx/AvatarFaceTextureAnchors";
import {
  detectAvatarFaceParts,
  type AvatarFacePartCorrections,
  type AvatarFacePartMap,
} from "./vfx/faceParts";
import type { AvatarVFXParsedEntry } from "./vfx/types";
import { AvatarVFXController } from "./vfx/AvatarVFXController";
import { ParticleVFXController } from "./particle-vfx/ParticleVFXController";
import { ExpressionController } from "./ExpressionController";
import {
  ReactionClipPlayer,
  type ReactionClipPlayerSnapshot,
} from "./reaction/ReactionClipPlayer";
import {
  DEFAULT_GESTURE_DURATION_SEC,
  DEFAULT_IDLE_STINT_QUIET_INTERVAL_SEC,
  type AvatarPlannerEnterPolicy,
  type AvatarPlannerExitPolicy,
  type AvatarPlannerDebugSnapshot,
  type AvatarPlannerEmotionPostureConfig,
  type AvatarPlannerPoseClip,
  type AvatarPlannerVrma,
} from "./planner";
import {
  AvatarPlanner,
  createInitialAvatarPlannerState,
  type AvatarPlannerAction,
  type AvatarPlannerEvent,
  type AvatarPlannerGestureEvent,
  type AvatarPlannerOutput,
  type AvatarPlannerState,
} from "./planner";
import {
  ProceduralAnimationController,
  type CursorLookAtInputProvider,
  type ProceduralAnimationLayerId,
  type ProceduralAnimationLayerParamsById,
  type ProceduralAnimationLayerSnapshot,
  type ProceduralAnimationSnapshot,
  type ProceduralSpeechTimingContext,
  type TalkingHandsPlayGroupRequest,
} from "./ProceduralAnimationController";
import {
  PoseController,
  type AnimaPoseClipEventSink,
  type AnimaPoseClipEventContext,
  type PoseControllerApplyOptions,
  type FinitePoseClipPlayback,
} from "./poses/PoseController";
import { RELAXED_REST_POSE_ID } from "./poses/catalog";
import { preparedModelUrlResolver } from "./preparedModelResources";
import {
  BUILT_IN_AVATAR_MOTION_CATALOG,
  type AvatarMotionCatalog,
  type AvatarMotionClipDescriptor,
  type AvatarVrmaResource,
  type ReactionPools,
} from "./motion/AvatarMotionCatalog";
import type { ManifestAnimation } from "./animationManifest";
import {
  applyAnimaPoseToVrm,
  cloneAnimaPose,
  cloneVRMPose,
  type AnimaPose,
  type AnimaPoseApplyResult,
} from "./poses/animaPose";
import {
  isVrm0,
  retargetClipSampleForVrm0,
  retargetPoseForVrm0,
} from "./poses/poseRetargeting";
import { canonicalizeCustomPresetExpressions } from "./vrmExpressionPresets";
import { applyAvatarShader } from "./toon-shader/applyAvatarShader";
import { registerAvatarShaderGltfPatch } from "./toon-shader/gltfPatch";
import {
  countAnimaPoseClipEventsByKind,
  DEFAULT_ANIMA_POSE_CLIP_TRANSITION,
  getAnimaPoseClipTimelineDuration,
  animaPoseClipHasPose,
  parseAnimaPoseClip,
  type AnimaPoseClipV2,
  type AnimaPoseClipSample,
} from "./poses/animaPoseClip";
import {
  easeProgress,
  interpolateSamples,
} from "./poses/animaPoseClip/interpolation";
import type { AvatarPoseClipSnapshot, AvatarPoseSnapshot } from "./poses/types";
import {
  SpringBonePhysicsController,
  type SpringBonePhysicsParams,
  type SpringBonePhysicsSnapshot,
} from "./spring-bone/SpringBonePhysicsController";
import type {
  SpringBoneSemantic,
  SpringBoneSemanticProfileOverride,
} from "./spring-bone/SpringBoneSemanticProfile";
import { createLogger } from "@/lib/logger";
import { inspectBrowserResourceLoad, redactUrlForLogging } from "@/lib/utils";
import type {
  AvatarLoadSpec,
  AvatarProgressCallback,
  AnimationOptions,
  SegmentMeta,
  FramePayload,
  EmotionalState,
  EmotionLabel,
  VRMExpressionPresetName,
  AnimationLoopType,
  ActiveAnimationInfo,
  AnimationBlendMode,
  AvatarAnimationState,
  AvatarStateSnapshot,
} from "./types";
import {
  buildEmotionRuntimeState,
  createEmptyEmotionStateMap,
} from "@/lib/emotion";
import {
  resolveAvatarFaceFocusTarget,
  type SceneFocusResolvedTarget,
  type ScenePointPx,
  type SceneViewportSize,
} from "@/lib/scene-vfx/focus-lines";
import { applyAvatarVFXEffectById } from "./vfx/runtime";
import {
  EMPTY_RUNTIME_MEDIA_PROVIDER,
  type AnimaRuntimeMediaProvider,
} from "@/lib/runtime-content/AnimaRuntimeMediaCatalog";
import {
  DEFAULT_SCENE_FOCUS_LINES_FACE_PADDING_X_PX,
  DEFAULT_SCENE_FOCUS_LINES_FACE_PADDING_Y_PX,
} from "@/lib/scene-vfx/types";
import type { AvatarFaceLandmarksSnapshot } from "./vfx/landmark-types";
import type { AvatarFaceTextureAnchorsSnapshot } from "./vfx/texture-anchor-types";

export type AvatarOptions = {
  cursorLookAtInputProvider?: CursorLookAtInputProvider | null;
  /** Exact motion catalog; standalone authoring may use code-only motion tools. */
  motionCatalog?: AvatarMotionCatalog;
  /** Exact typed effect/audio inventory; omitted means no executable media. */
  mediaCatalog?: AnimaRuntimeMediaProvider;
};

export type AvatarUpdateOptions = {
  speechTiming?: ProceduralSpeechTimingContext | null;
};

export type AvatarStateUpdateContext = {
  nowMs?: number;
  animaId?: string | null;
  activeRunId?: string | null;
  activeVrmaActions?: readonly ActiveAnimationInfo[];
  activePlannerPoseClip?: AvatarPlannerPoseClip | null;
  manualPoseClipActive?: boolean;
  activePlannerProceduralLayerIds?: readonly ProceduralAnimationLayerId[];
  manualProceduralLayerIds?: readonly ProceduralAnimationLayerId[];
  eligiblePlannerProceduralLayerIds?: readonly ProceduralAnimationLayerId[];
  pendingEvents?: readonly AvatarPlannerEvent[];
  randomRolls?: readonly number[];
  idleStintQuietIntervalSec?: number;
};

export type PoseBaseReplacementOptions = {
  preserveProceduralOffsets?: boolean;
};

export type PoseClipPlayOptions = PoseBaseReplacementOptions & {
  /** Called once after natural clip completion; stopping or replacing cancels it. */
  onFinished?: () => void;
  finitePlayback?: FinitePoseClipPlayback;
  /** Playback-clock speed; fades retain their wall-clock duration. */
  timeScale?: number;
  transition?: AvatarPlannerEnterPolicy;
};

export type PoseClipStopOptions = PoseBaseReplacementOptions & {
  transition?: AvatarPlannerExitPolicy;
};

export type AvatarPoseApplyOptions = PoseControllerApplyOptions &
  PoseBaseReplacementOptions;

type VrmaRestPoseTransition = {
  elapsedSec: number;
  durationSec: number;
  fromSample: AnimaPoseClipSample;
  toSample: AnimaPoseClipSample;
};

/**
 * Avatar is the main runtime class for a VRM avatar.
 *
 * It consolidates:
 * - VRM loading and lifecycle
 * - AnimationManager (skeletal animation)
 * - ExpressionController (facial expressions, lip-sync, auto-blink)
 * - Emotional state (placeholder for future)
 *
 * Usage:
 * ```ts
 * const avatar = new Avatar(camera);
 * await avatar.load({ filePath: '/vrm/model.vrm' });
 *
 * // In render loop:
 * avatar.update(delta);
 * ```
 */

const logger = createLogger("Avatar");
const DEFAULT_AUTOMATIC_VRMA_RESUME_FADE_SEC = 0.35;
const DEFAULT_VRMA_REST_FADE_SEC = 0.35;

function getDebugReactionClipOwnerId(clipId: string): string {
  return `debug:reactionClip:${clipId}`;
}

function isLikelyGitLfsPointerParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("git-lfs.github.com/spec/v1") ||
    message.includes('"version ht"') ||
    (message.includes("Unexpected token 'v'") &&
      message.includes("not valid JSON"))
  );
}

function createGitLfsAssetError(kind: string, url: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${kind} asset at ${url} looks like a Git LFS pointer instead of the real runtime file. ` +
      `Install Git LFS and run \`git lfs pull --include="src/frontend/web/public/**"\` from the repo root, then restart Vite. ` +
      `Original loader error: ${message}`,
  );
}

function normalizeTransitionDurationSec(
  durationSec: number | null | undefined,
): number | null {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) {
    return null;
  }
  return Math.max(0, durationSec);
}

function getAvatarPlannerEnterPolicyDuration(
  transition: AvatarPlannerEnterPolicy | null | undefined,
): number | null {
  return normalizeTransitionDurationSec(transition?.durationSec);
}

function getAvatarPlannerExitPolicyDuration(
  transition: AvatarPlannerExitPolicy | null | undefined,
): number | null {
  return normalizeTransitionDurationSec(transition?.durationSec);
}

function cloneAvatarPlannerDebugSnapshot(
  snapshot: AvatarPlannerDebugSnapshot,
): AvatarPlannerDebugSnapshot {
  return {
    ...snapshot,
    activeBaseVrma: snapshot.activeBaseVrma
      ? { ...snapshot.activeBaseVrma }
      : null,
    activeGestureVrma: snapshot.activeGestureVrma
      ? { ...snapshot.activeGestureVrma }
      : null,
    idleStint: {
      ...snapshot.idleStint,
      selectedCandidate: snapshot.idleStint.selectedCandidate
        ? { ...snapshot.idleStint.selectedCandidate }
        : null,
      candidates: snapshot.idleStint.candidates.map((candidate) => ({
        ...candidate,
      })),
    },
    talkingMotionArbitration: { ...snapshot.talkingMotionArbitration },
    activePoseClip: snapshot.activePoseClip
      ? {
          ...snapshot.activePoseClip,
          enterPolicy: { ...snapshot.activePoseClip.enterPolicy },
          exitPolicy: { ...snapshot.activePoseClip.exitPolicy },
        }
      : null,
    resolvedGesture: snapshot.resolvedGesture
      ? { ...snapshot.resolvedGesture }
      : null,
    activeReactionClip: snapshot.activeReactionClip
      ? { ...snapshot.activeReactionClip }
      : null,
    pendingEvents: snapshot.pendingEvents.map((event) => ({ ...event })),
    pendingReactionClipEvents: snapshot.pendingReactionClipEvents.map(
      (event) => ({ ...event }),
    ),
    activeVrmaActionNames: [...snapshot.activeVrmaActionNames],
    activePlannerProceduralLayerIds: [
      ...snapshot.activePlannerProceduralLayerIds,
    ],
    manualProceduralLayerIds: [...snapshot.manualProceduralLayerIds],
    proceduralStints: snapshot.proceduralStints.map((stint) => ({
      ...stint,
    })),
    actionTypes: [...snapshot.actionTypes],
    consumedPlannerEventIds: [...snapshot.consumedPlannerEventIds],
    ignoredEventReasons: [...snapshot.ignoredEventReasons],
  };
}

function resolveEmotionPosturePlannerConfig(
  snapshot: ProceduralAnimationSnapshot | null,
): AvatarPlannerEmotionPostureConfig | undefined {
  const layer = snapshot?.layers.find(isEmotionPostureLayer);
  if (!layer) return undefined;

  return {
    plannerEnabled: layer.params.plannerEnabled,
    presetEnabledByGroup: Object.fromEntries(
      Object.entries(layer.params.presets).map(([group, preset]) => [
        group,
        preset.enabled,
      ]),
    ) as AvatarPlannerEmotionPostureConfig["presetEnabledByGroup"],
  };
}

function isEmotionPostureLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"emotionPosture"> {
  return layer.id === "emotionPosture";
}

export class Avatar {
  public vrm: VRM | null = null;
  public sourceGltf: GLTF | null = null;
  public sourceUrl: string | null = null;
  public sourceKey: string | null = null;
  /** Detected (or corrected) face and eye parts; read by landmarks and VFX. */
  public facePartMap: AvatarFacePartMap | null = null;
  public faceLandmarks: AvatarFaceLandmarks | null = null;
  public faceTextureAnchors: AvatarFaceTextureAnchors | null = null;
  public faceDebugBox: AvatarFaceDebugBox | null = null;
  private _faceDebugVisible = false;
  public vfxController: AvatarVFXController | null = null;
  public particleVFXController: ParticleVFXController | null = null;
  public expressionController: ExpressionController | null = null;
  public reactionClipPlayer: ReactionClipPlayer | null = null;
  public animationManager: AnimationManager | null = null;
  public proceduralAnimationController: ProceduralAnimationController | null =
    null;
  public poseController: PoseController | null = null;
  public springBonePhysicsController: SpringBonePhysicsController | null = null;
  public emotional_state: EmotionalState = buildEmotionRuntimeState(
    createEmptyEmotionStateMap(),
  );
  public emotion_label: EmotionLabel = "neutral";
  public state: AvatarAnimationState = "idle";

  private static _gltfLoader: GLTFLoader | null = null;
  private static _vrmaCache = new Map<string, Promise<VRMAnimation | null>>();

  private _camera: THREE.Object3D;
  private _cursorLookAtInputProvider: CursorLookAtInputProvider | null;
  private _viewportElement: HTMLElement | null;
  private _isDisposed: boolean = false;
  private readonly _motionCatalog: AvatarMotionCatalog;
  private _avatarPlanner: AvatarPlanner;
  private _avatarPlannerState: AvatarPlannerState =
    createInitialAvatarPlannerState();
  private _lastAvatarPlannerDebugSnapshot: AvatarPlannerDebugSnapshot | null =
    null;
  private _idleStintQuietIntervalSec = DEFAULT_IDLE_STINT_QUIET_INTERVAL_SEC;
  private _lastPlanKey: string | null = null;
  private _lastEmotionLabel: EmotionLabel = "neutral";
  private _lastEmotionIntensity: number = 0;
  private _pendingAutomaticPlaybackResumeFadeSec: number | null = null;
  private _automaticAnimationPlaybackEnabled: boolean = true;
  private _vrmaRootedPlaybackEnabled: boolean = false;
  private readonly _mediaCatalog: AnimaRuntimeMediaProvider;
  private _lastAnimationPromise: Promise<THREE.AnimationAction> | null = null;
  private _focusLinesProjectionScratch = new THREE.Vector3();
  private _poseClipAutomaticPlaybackWasEnabled: boolean | null = null;
  private _poseClipPreserveProceduralOffsets: boolean = false;
  private _poseClipCompletionReapplyDefaultPose: boolean = true;
  private _poseClipOnFinished: (() => void) | null = null;
  private _pendingPlannerPoseClipOwnerId: string | null = null;
  private _poseClipExternalEventSink: AnimaPoseClipEventSink | null = null;
  private _reactionClipExternalEventSink: AnimaPoseClipEventSink | null = null;
  private _clipVFXEnabled: boolean = true;
  private _clipOwnedAvatarVFXIds = new Set<string>();
  private _clipOwnedParticleVFXIds = new Set<string>();
  private _vrmaRestPoseTransition: VrmaRestPoseTransition | null = null;
  private _isVrm0: boolean = false;
  private _vrmSha256: string | null = null;
  private _facePartCorrections: AvatarFacePartCorrections | null = null;

  /** sha256 of the loaded VRM bytes, when the load supplied it. */
  get vrmSha256(): string | null {
    return this._vrmSha256;
  }

  /** The face part correction last given at load or by `setFacePartCorrections`. */
  get facePartCorrections(): AvatarFacePartCorrections | null {
    return this._facePartCorrections;
  }

  constructor(
    camera: THREE.Object3D,
    viewportElement?: HTMLElement | null,
    options: AvatarOptions = {},
  ) {
    this._camera = camera;
    this._cursorLookAtInputProvider = options.cursorLookAtInputProvider ?? null;
    this._viewportElement = viewportElement ?? null;
    this._motionCatalog =
      options.motionCatalog ?? BUILT_IN_AVATAR_MOTION_CATALOG;
    this._mediaCatalog = options.mediaCatalog ?? EMPTY_RUNTIME_MEDIA_PROVIDER;
    this._avatarPlanner = new AvatarPlanner(this._motionCatalog);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load a VRM model and initialize all controllers.
   */
  async load(
    spec: AvatarLoadSpec,
    onProgress?: AvatarProgressCallback,
  ): Promise<void> {
    // Unload any existing VRM first
    this.unload();

    onProgress?.({ phase: "setup", message: "Setting up..." });

    // Load VRM model
    onProgress?.({ phase: "vrm", message: "Loading model..." });
    const { gltf, vrm } = await Avatar._loadVrm(
      spec.filePath,
      (loaded, total) => {
        onProgress?.({
          phase: "vrm",
          ratio: total > 0 ? loaded / total : 0,
          loaded,
          total,
          message: "Loading model...",
        });
      },
      spec.resourceUrls,
    );
    if (this._isDisposed) {
      releaseModelScene(vrm.scene);
      throw new DOMException("Avatar load cancelled.", "AbortError");
    }
    this.sourceGltf = gltf;
    this.sourceUrl = spec.sourceUrl?.trim() || spec.filePath;
    this.sourceKey = spec.sourceKey?.trim() || spec.filePath;

    this.vrm = vrm;
    this._isVrm0 = isVrm0(vrm);
    this.poseController = new PoseController(vrm, {
      isVrm0: this._isVrm0,
      motionCatalog: this._motionCatalog,
    });
    this.poseController.applyDefaultPoses();

    // Initialize controllers
    this.animationManager = new AnimationManager(vrm, {
      loadVrma: async (url) => {
        const resource = this._motionCatalog.resolveVrma(url);
        if (!resource) {
          throw new Error(
            `VRMA source is not in the active motion catalog: ${url}`,
          );
        }
        return Avatar._loadVrmaCached(resource);
      },
    });
    this.animationManager.setRootedPlaybackEnabled(
      this._vrmaRootedPlaybackEnabled,
    );
    this.proceduralAnimationController = new ProceduralAnimationController(
      vrm,
      {
        camera: this._camera,
        cursorLookAtInputProvider: this._cursorLookAtInputProvider,
        isVrm0: this._isVrm0,
        viewportElement: this._viewportElement,
      },
    );
    this.springBonePhysicsController = new SpringBonePhysicsController(vrm, {
      sourceGltf: gltf,
    });
    this.expressionController = new ExpressionController(vrm);
    this.reactionClipPlayer = new ReactionClipPlayer(
      this.expressionController,
      {
        resolvePoseRef: this._resolveReactionClipPoseRef,
      },
    );

    // Disable frustum culling on VRM scene (common VRM practice)
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    this._vrmSha256 = spec.vrmSha256?.trim().toLowerCase() || null;
    this._detectFaceParts(spec.facePartCorrections ?? null);
    this.faceLandmarks = new AvatarFaceLandmarks(this);
    this.faceTextureAnchors = new AvatarFaceTextureAnchors(this);
    this.vfxController = new AvatarVFXController(this, this._mediaCatalog);
    this.particleVFXController = new ParticleVFXController(
      this,
      this._mediaCatalog,
    );
    this._syncPoseClipEventSink();
    this._syncReactionClipEventSink();

    onProgress?.({ phase: "animation", ratio: 1, message: "Ready" });
  }

  /**
   * Unload the current VRM and dispose resources.
   */
  unload(): void {
    // Detach before any controller cleanup so no frame can draw a half-released model.
    this.vrm?.scene.removeFromParent();
    this._poseClipOnFinished = null;
    this.springBonePhysicsController?.dispose();
    this.springBonePhysicsController = null;

    this.proceduralAnimationController?.dispose();
    this.proceduralAnimationController = null;

    this.poseController?.dispose();
    this.poseController = null;

    if (this.vrm) {
      this.faceDebugBox?.dispose();
      this.faceDebugBox = null;
      this.faceTextureAnchors?.dispose();
      this.faceTextureAnchors = null;
      this.faceLandmarks?.dispose();
      this.faceLandmarks = null;
      this.vfxController?.dispose();
      this.vfxController = null;
      this.particleVFXController?.dispose();
      this.particleVFXController = null;
      this.animationManager?.dispose();
      this.reactionClipPlayer?.clear(null, { immediate: true });
      this.reactionClipPlayer = null;
      this.expressionController?.dispose();
      releaseModelScene(this.vrm.scene);
      this.vrm = null;
      this.sourceGltf = null;
      this.sourceUrl = null;
      this.sourceKey = null;
      this.facePartMap = null;
      this._vrmSha256 = null;
      this._facePartCorrections = null;
      this.animationManager = null;
      this.expressionController = null;
    }
    this._isVrm0 = false;
    this.state = "idle";
    this._lastPlanKey = null;
    this._lastEmotionLabel = "neutral";
    this._lastEmotionIntensity = 0;
    this._pendingAutomaticPlaybackResumeFadeSec = null;
    this._automaticAnimationPlaybackEnabled = true;
    this._vrmaRootedPlaybackEnabled = false;
    this._poseClipAutomaticPlaybackWasEnabled = null;
    this._lastAnimationPromise = null;
    this._avatarPlannerState = createInitialAvatarPlannerState();
    this._pendingPlannerPoseClipOwnerId = null;
    this._lastAvatarPlannerDebugSnapshot = null;
    this._idleStintQuietIntervalSec = DEFAULT_IDLE_STINT_QUIET_INTERVAL_SEC;
    this._poseClipCompletionReapplyDefaultPose = true;
    this._vrmaRestPoseTransition = null;
    this._clipOwnedAvatarVFXIds.clear();
    this._clipOwnedParticleVFXIds.clear();
  }

  /**
   * Fully dispose the avatar instance.
   */
  dispose(): void {
    this.unload();
    this._isDisposed = true;
    // Callers' closures can outlive a disposed Avatar; holding their sinks,
    // providers or canvas would keep their previous model state alive.
    this._poseClipExternalEventSink = null;
    this._reactionClipExternalEventSink = null;
    this._cursorLookAtInputProvider = null;
    this._viewportElement = null;
  }

  /**
   * Check if the avatar is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Check if the avatar is ready (VRM loaded).
   */
  get isReady(): boolean {
    return this.vrm !== null && !this._isDisposed;
  }

  /** Validate canonical rest and update the normalized rig before any visible draw. */
  prepareFirstFrame(): void {
    const rest = this.poseController?.getPoseSnapshot(RELAXED_REST_POSE_ID);
    if (
      !this.isReady ||
      !this.vrm ||
      !rest?.applied ||
      !this.isPoseActive(RELAXED_REST_POSE_ID) ||
      !rest.resolvedBones.includes("leftUpperArm") ||
      !rest.resolvedBones.includes("rightUpperArm")
    ) {
      throw new Error(
        "The avatar's relaxed-rest base pose could not be applied.",
      );
    }
    // VRM 0 retargeting was applied by PoseController. Propagate normalized
    // bones/constraints before attachment; the planner cannot run until drawn.
    this.vrm.update(0);
    this.vrm.scene.updateWorldMatrix(true, true);
  }

  /**
   * Get the VRM scene for rendering.
   */
  get scene(): THREE.Group | null {
    return this.vrm?.scene ?? null;
  }

  /**
   * Get the current animation state.
   */
  getState(): AvatarAnimationState {
    return this.state;
  }

  setFaceDebugBoxVisible(visible: boolean): void {
    if (!__ANIMAMA_DEV_BUILD__ || !DEBUG_ENABLED) return;
    this._faceDebugVisible = visible;
    this.faceDebugBox?.setVisible(this._faceDebugVisible);
    if (!this._faceDebugVisible || this.faceDebugBox || !this.vrm) return;
    const vrm = this.vrm;
    void import("./vfx/AvatarFaceDebugBox")
      .then(({ AvatarFaceDebugBox }) => {
        if (this.vrm !== vrm || !this._faceDebugVisible) return;
        this.faceDebugBox ??= new AvatarFaceDebugBox(this);
        this.faceDebugBox.setVisible(true);
      })
      .catch(() => logger.warn("Debug", "Unable to load face diagnostics"));
  }

  /**
   * Apply a face part correction (or clear it with null). Rebuilds the part
   * map, landmarks and texture anchors, then the VFX bindings, and re-applies
   * active effects. A correction for different VRM bytes is ignored with a
   * diagnostic, as at load.
   */
  async setFacePartCorrections(
    corrections: AvatarFacePartCorrections | null,
  ): Promise<void> {
    if (!this.isReady) return;
    this._detectFaceParts(corrections);
    this.faceDebugBox?.dispose();
    this.faceDebugBox = null;
    this.faceTextureAnchors?.dispose();
    this.faceLandmarks?.dispose();
    this.faceLandmarks = new AvatarFaceLandmarks(this);
    this.faceTextureAnchors = new AvatarFaceTextureAnchors(this);
    this.setFaceDebugBoxVisible(this._faceDebugVisible);
    await this.vfxController?.refreshFaceParts();
  }

  private _detectFaceParts(
    corrections: AvatarFacePartCorrections | null,
  ): void {
    this._facePartCorrections = corrections;
    if (!this.vrm || !this.sourceGltf) {
      this.facePartMap = null;
      return;
    }
    let map: AvatarFacePartMap;
    try {
      map = detectAvatarFaceParts(this.vrm, this.sourceGltf, {
        corrections,
        vrmSha256: this._vrmSha256,
        sourceKey: this.sourceKey,
        sourceUrl: this.sourceUrl,
      });
    } catch (error) {
      // An unusual model must not fail the load: without a part map,
      // landmarks and VFX bindings use material names as before.
      this.facePartMap = null;
      logger.warn("FaceParts", "Face part detection failed; using names", {
        reason: "avatar_face_parts_detection_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.facePartMap = map;
    logger.info("FaceParts", "Resolved face parts", {
      parts: Object.fromEntries(
        Object.values(map.parts).map((part) => [
          part.role,
          { source: part.source, bindings: part.bindings.length },
        ]),
      ),
    });
    if (map.diagnostics.length > 0) {
      logger.warn("FaceParts", "Face part diagnostics", {
        diagnostics: map.diagnostics,
      });
    }
  }

  getFaceLandmarksSnapshot(): AvatarFaceLandmarksSnapshot | null {
    return this.faceLandmarks?.getSnapshot() ?? null;
  }

  getFaceTextureAnchorsSnapshot(): AvatarFaceTextureAnchorsSnapshot | null {
    return this.faceTextureAnchors?.getSnapshot() ?? null;
  }

  /**
   * Wait for the most recently requested animation to load and start.
   */
  async waitForCurrentAnimation(): Promise<void> {
    const pending = this._lastAnimationPromise;
    if (!pending) return;
    try {
      await pending;
    } catch (error) {
      logger.warn("Animation", "Failed to start animation", { error });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Update Loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update the avatar. Call this from useFrame.
   */
  update(delta: number, options: AvatarUpdateOptions = {}): void {
    if (this._isDisposed || !this.vrm) return;

    // 1. Remove last frame's procedural offsets before the mixer writes a pose.
    this.proceduralAnimationController?.clearActiveOffsets();

    // 2. Update animation mixer (skeletal animation)
    this.animationManager?.update(delta);

    // 3. Blend automatic VRMA idle exits back to the default base pose.
    this._updateVrmaRestPoseTransition(delta);

    // 4. Apply sampled PoseController clips on top of the mixer pose.
    const poseClipWasActive = this.poseController?.isClipActive() ?? false;
    this.poseController?.update(delta);
    let poseClipFinished: (() => void) | null = null;
    if (poseClipWasActive && !this.poseController?.isClipActive()) {
      poseClipFinished = this._poseClipOnFinished;
      this._poseClipOnFinished = null;
      this._completePoseClipPlaybackReplacingBase({
        reapplyDefaultPose: this._poseClipCompletionReapplyDefaultPose,
      });
    }

    // A playing clip may mute live layers and own its keyed expressions; both
    // follow its fade weight and release as soon as it ends or is stopped.
    const clipPresence = this.poseController?.getClipPresence() ?? null;
    this.proceduralAnimationController?.setClipLayerMutes(
      clipPresence?.mutedLayers ?? [],
      clipPresence?.weight ?? 0,
    );
    this.expressionController?.setClipExpressionPrecedence(clipPresence);

    // 5. Add procedural animation offsets on top of the mixer/clip pose.
    this.proceduralAnimationController?.update(delta, {
      avatarState: this.state,
      emotionLabel: this.emotion_label,
      emotionalState: this.emotional_state,
      globalRestPoseActive: this.isPoseActive(RELAXED_REST_POSE_ID),
      speechTiming: options.speechTiming ?? null,
    });

    // 6. Sample composable reaction clips before expression composition.
    this.reactionClipPlayer?.update(delta);

    // 7. Update expression controller (lip-sync, auto-blink)
    this.expressionController?.update(delta);

    // 8. Update runtime VFX before VRM materials upload their texture transforms.
    this.vfxController?.update(delta);

    // 9. Update spring-bone settings before three-vrm runs spring physics.
    this.springBonePhysicsController?.update(delta, {
      avatarState: this.state,
      emotionLabel: this.emotion_label,
    });

    // 10. Update VRM internals (IK, constraints, spring bones)
    this.vrm.update(delta);

    // 11. Update particle VFX after VRM constraints/spring bones settle anchors.
    this.particleVFXController?.update(delta);

    // 12. Update optional debug helpers after spring-bone simulation.
    if (__ANIMAMA_DEV_BUILD__ && DEBUG_ENABLED)
      this.springBonePhysicsController?.updateHelpers();
    // Notify after the final rendered pose and occurrence effects have settled.
    poseClipFinished?.();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Animation API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Play a VRMA animation by filename or URL.
   */
  async playAnimation(
    filenameOrUrl: string,
    options?: AnimationOptions,
  ): Promise<void> {
    const url = this._resolveVrmaInput(filenameOrUrl);
    logger.info("Animation", "Playing animation", {
      url: url,
      options: options,
    });
    await this.animationManager?.playAnimation(
      url,
      this._withVrmaRestFadeOnFinished({
        ...options,
        clipName: filenameOrUrl,
      }),
    );
  }

  /**
   * Play a VRMA animation with a custom clip name.
   */
  async playAnimationWithName(
    filenameOrUrl: string,
    clipName: string,
    options?: AnimationOptions & { startTimeSec?: number },
  ): Promise<THREE.AnimationAction | null> {
    const url = this._resolveVrmaInput(filenameOrUrl);
    const action = await this.animationManager?.playAnimationWithName(
      url,
      clipName,
      this._withVrmaRestFadeOnFinished(options),
    );
    logger.info("Animation", "Playing custom animation", {
      url: url,
      actionName: action?.getClip().name ?? null,
      options: options,
    });
    return action ?? null;
  }

  /**
   * Load a VRMA animation clip without playing it.
   */
  async loadAnimationClip(
    filenameOrUrl: string,
    options?: { clipName?: string; additiveReference?: string | null },
  ): Promise<THREE.AnimationClip | null> {
    const url = this._resolveVrmaInput(filenameOrUrl);
    const clip = await this.animationManager?.loadClip(url, {
      clipName: options?.clipName ?? filenameOrUrl,
      additiveReference: options?.additiveReference ?? null,
    });
    return clip ?? null;
  }

  /**
   * Get duration (seconds) for a VRMA animation clip.
   */
  async getAnimationClipDuration(
    filenameOrUrl: string,
    options?: { clipName?: string; additiveReference?: string | null },
  ): Promise<number> {
    const url = this._resolveVrmaInput(filenameOrUrl);
    return (
      (await this.animationManager?.getClipDuration(url, {
        clipName: options?.clipName ?? filenameOrUrl,
        additiveReference: options?.additiveReference ?? null,
      })) ?? 0
    );
  }

  /**
   * Play the default (idle) animation.
   */
  playDefaultAnimation(): void {
    this.animationManager?.playDefaultAnimation();
  }

  /**
   * Get active animation clip info.
   */
  getActiveAnimations(): ActiveAnimationInfo[] {
    return this.animationManager?.getActiveActionInfo() ?? [];
  }

  /**
   * Get names of active animation clips.
   */
  getActiveAnimationNames(): string[] {
    return this.animationManager?.getActiveActionNames() ?? [];
  }

  /** Preserve mounted catalog keys and absolute URLs before legacy expansion. */
  private _resolveVrmaInput(filenameOrUrl: string): string {
    const input = filenameOrUrl.trim();
    if (
      this._motionCatalog.resolveVrma(input) ||
      input.startsWith("/") ||
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)
    ) {
      return input;
    }
    return `/vrm/animations/${input}`;
  }

  /**
   * Stop an active animation by name.
   */
  stopAnimation(name: string): boolean {
    const stopped = this.animationManager?.stopAction(name) ?? false;
    if (stopped) {
      this._beginVrmaRestPoseTransition(DEFAULT_VRMA_REST_FADE_SEC);
    }
    return stopped;
  }

  /**
   * Reset all animations and restore the avatar pose.
   */
  resetAnimations(): void {
    this.reactionClipPlayer?.clear(null, { immediate: true });
    this.expressionController?.clearExpressionOverlay();
    this._vrmaRestPoseTransition = null;
    this._stopCoordinatedPoseClip({
      reapplyDefaultPose: false,
      preserveProceduralOffsets: false,
    });
    this._pendingAutomaticPlaybackResumeFadeSec = null;
    this.resetProceduralAnimationLayer();
    this.animationManager?.resetAll();
    this.poseController?.forgetDefaultPoseOffsets();
    this.poseController?.applyDefaultPoses();
  }

  isAutomaticAnimationPlaybackEnabled(): boolean {
    return this._automaticAnimationPlaybackEnabled;
  }

  getIdleStintQuietIntervalSec(): number {
    return this._idleStintQuietIntervalSec;
  }

  setIdleStintQuietIntervalSec(value: number): void {
    if (!Number.isFinite(value)) {
      this._idleStintQuietIntervalSec = DEFAULT_IDLE_STINT_QUIET_INTERVAL_SEC;
      return;
    }
    this._idleStintQuietIntervalSec = Math.max(0, value);
  }

  setAutomaticAnimationPlaybackEnabled(enabled: boolean): void {
    if (this._automaticAnimationPlaybackEnabled === enabled) return;
    this._automaticAnimationPlaybackEnabled = enabled;
    this._lastPlanKey = null;
    if (!enabled) {
      this._vrmaRestPoseTransition = null;
      this._pendingAutomaticPlaybackResumeFadeSec = null;
      this.proceduralAnimationController?.clearActiveOffsets();
      this.animationManager?.resetAll();
      this.poseController?.forgetDefaultPoseOffsets();
      this.poseController?.applyDefaultPoses();
    }
  }

  isVrmaRootedPlaybackEnabled(): boolean {
    return this._vrmaRootedPlaybackEnabled;
  }

  setVrmaRootedPlaybackEnabled(enabled: boolean): void {
    if (this._vrmaRootedPlaybackEnabled === enabled) return;

    this._vrmaRootedPlaybackEnabled = enabled;
    this.animationManager?.setRootedPlaybackEnabled(enabled);
    this._lastPlanKey = null;
    this._lastAnimationPromise = null;

    if ((this.animationManager?.getActiveActionNames().length ?? 0) === 0) {
      return;
    }

    this._vrmaRestPoseTransition = null;
    this.animationManager?.resetAll();
    this.poseController?.forgetDefaultPoseOffsets();
    this.poseController?.applyDefaultPoses();
  }

  isPoseActive(poseId: string): boolean {
    return this.poseController?.isPoseActive(poseId) ?? false;
  }

  getPoseSnapshot(poseId: string): AvatarPoseSnapshot<AnimaPose> {
    return (
      this.poseController?.getPoseSnapshot(poseId) ??
      this._getUnavailablePoseSnapshot(poseId)
    );
  }

  setPoseEnabled(poseId: string, enabled: boolean): boolean {
    const poseController = this.poseController;
    if (!poseController) return false;

    const changed = poseController.setPoseEnabled(poseId, enabled);
    if (!changed) return false;

    if (!enabled) {
      if (this._automaticAnimationPlaybackEnabled) {
        poseController.forgetPose(poseId);
      } else {
        poseController.clearPose(poseId);
      }
      return true;
    }
    if (!this._automaticAnimationPlaybackEnabled) {
      poseController.applyPose(poseId);
    }
    return true;
  }

  setPoseParams(poseId: string, params: Partial<AnimaPose>): void {
    const poseController = this.poseController;
    if (!poseController) return;

    poseController.setPoseParams(poseId, params);
    if (!this._automaticAnimationPlaybackEnabled) {
      poseController.applyPose(poseId);
    }
  }

  resetPoseDefaults(poseId: string): void {
    const poseController = this.poseController;
    if (!poseController) return;

    poseController.resetPoseDefaults(poseId);
    if (this._automaticAnimationPlaybackEnabled) {
      poseController.forgetPose(poseId);
      return;
    }
    poseController.applyPose(poseId);
  }

  reapplyPose(poseId: string): AvatarPoseSnapshot<AnimaPose> {
    if (this._automaticAnimationPlaybackEnabled) {
      return this.getPoseSnapshot(poseId);
    }
    return this.applyPose(poseId);
  }

  applyPose(
    poseId: string,
    options?: AvatarPoseApplyOptions,
  ): AvatarPoseSnapshot<AnimaPose> {
    this._vrmaRestPoseTransition = null;
    return this._replacePoseBase(options, () => {
      this._stopCoordinatedPoseClip({
        reapplyDefaultPose: false,
        preserveProceduralOffsets: false,
      });
      return (
        this.poseController?.applyPose(poseId, options) ??
        this._getUnavailablePoseSnapshot(poseId)
      );
    });
  }

  playClip(
    clipId: string,
    options?: PoseClipPlayOptions,
  ): AvatarPoseClipSnapshot {
    const clip = this._motionCatalog.getPoseClip(clipId);
    if (!clip) {
      throw new Error(`Runtime pose clip "${clipId}" is not loaded`);
    }
    return this.playAnimaPoseClip(clip, options);
  }

  /** Lazily resolve and play an effective runtime pose clip by runtime ID. */
  async loadAndPlayClip(
    clipId: string,
    options?: PoseClipPlayOptions,
  ): Promise<AvatarPoseClipSnapshot> {
    const clip = await this._motionCatalog.loadPoseClip(clipId);
    if (!clip) {
      throw new Error(`Unknown runtime pose clip id "${clipId}"`);
    }
    return this.playAnimaPoseClip(clip, options);
  }

  getMotionPoseClips(): readonly AvatarMotionClipDescriptor[] {
    return this._motionCatalog.listPoseClips();
  }

  /** Return every active idle or gesture entry in this Avatar's catalog. */
  getMotionAnimations(): readonly ManifestAnimation[] {
    return this._motionCatalog.listAnimations();
  }

  getLoadedMotionPoseClip(clipId: string): AnimaPoseClipV2 | null {
    return this._motionCatalog.getPoseClip(clipId);
  }

  getMotionReactionClips(): readonly AvatarMotionClipDescriptor[] {
    return this._motionCatalog.listReactionClips();
  }

  /** The mounted catalog's Reaction pools, for debug inspection. */
  getMotionReactionPools(): ReactionPools {
    return this._motionCatalog.listReactionPools();
  }

  getLoadedMotionReactionClip(clipId: string): AnimaPoseClipV2 | null {
    return this._motionCatalog.getReactionClip(clipId);
  }

  playAnimaPoseClip(
    clip: AnimaPoseClipV2,
    options?: PoseClipPlayOptions,
  ): AvatarPoseClipSnapshot {
    const parsedClip = parseAnimaPoseClip(clip);
    // Effect-only clips share the event clock without replacing the pose base.
    if (!animaPoseClipHasPose(parsedClip)) {
      return this._playAnimaPoseClip(parsedClip, options);
    }
    return this._replacePoseBase(options, () =>
      this._playAnimaPoseClip(parsedClip, options),
    );
  }

  private _playAnimaPoseClip(
    clip: AnimaPoseClipV2,
    options?: PoseClipPlayOptions,
  ): AvatarPoseClipSnapshot {
    const poseController = this.poseController;
    if (!poseController) {
      return this._getUnavailableClipSnapshot(clip.id);
    }

    this._poseClipOnFinished = null;
    const replacesPose = animaPoseClipHasPose(clip);
    if (!replacesPose && this._poseClipAutomaticPlaybackWasEnabled !== null) {
      // Finish a previous body clip's ownership before starting an effect-only
      // replacement, so its suspended automatic animation can resume now.
      poseController.stopClip({ immediate: true });
      this._completePoseClipPlaybackReplacingBase({ reapplyDefaultPose: true });
    }
    if (replacesPose) this._vrmaRestPoseTransition = null;
    this._poseClipPreserveProceduralOffsets =
      replacesPose && options?.preserveProceduralOffsets === true;
    this._poseClipCompletionReapplyDefaultPose = replacesPose;
    if (replacesPose) this._beginPoseClipPlayback();
    let snapshot: AvatarPoseClipSnapshot;
    try {
      snapshot = poseController.playAnimaPoseClip(clip, {
        finitePlayback: options?.finitePlayback,
        timeScale: options?.timeScale,
        fadeInDurationSec: getAvatarPlannerEnterPolicyDuration(
          options?.transition,
        ),
      });
    } catch (error) {
      this._completePoseClipPlayback({ reapplyDefaultPose: true });
      throw error;
    }
    if (!snapshot.playing) {
      this._completePoseClipPlayback({ reapplyDefaultPose: true });
    } else {
      this._poseClipOnFinished = options?.onFinished ?? null;
    }
    return snapshot;
  }

  stopClip(options?: PoseClipStopOptions): void {
    this._stopCoordinatedPoseClip({
      reapplyDefaultPose: true,
      preserveProceduralOffsets:
        options?.preserveProceduralOffsets ??
        this._poseClipPreserveProceduralOffsets,
      transition: options?.transition,
    });
  }

  /**
   * Move the playing pose clip to `timeSec` and show that frame with its
   * fades, layer mutes and expression precedence, without advancing time
   * (see `PoseController.seekClip`). Review tools use it to scrub. Returns
   * false when no clip is playing.
   */
  seekPoseClip(timeSec: number): boolean {
    const poseController = this.poseController;
    if (this._isDisposed || !poseController) return false;
    // Seek against the clip pose alone; update(0) then re-adds live layers.
    this.proceduralAnimationController?.clearActiveOffsets();
    const sought = poseController.seekClip(timeSec);
    this.update(0);
    return sought;
  }

  isClipActive(clipId?: string): boolean {
    return this.poseController?.isClipActive(clipId) ?? false;
  }

  getClipSnapshot(clipId?: string): AvatarPoseClipSnapshot {
    return (
      this.poseController?.getClipSnapshot(clipId) ??
      this._getUnavailableClipSnapshot(clipId)
    );
  }

  /**
   * Installs React-owned scene VFX and SFX callbacks while keeping avatar VFX
   * application owned by this Avatar instance.
   */
  setPoseClipExternalEventSink(sink: AnimaPoseClipEventSink | null): void {
    this._poseClipExternalEventSink = sink;
    this._syncPoseClipEventSink();
  }

  /**
   * Installs React-owned scene VFX and SFX callbacks for composable reaction
   * clips. Avatar-bound VFX remains owned by this Avatar instance.
   */
  setReactionClipExternalEventSink(sink: AnimaPoseClipEventSink | null): void {
    this._reactionClipExternalEventSink = sink;
    this._syncReactionClipEventSink();
  }

  /**
   * Enables or disables pose/reaction clip-owned avatar and particle VFX.
   * Manual/debug runtime VFX and SFX use separate paths and are unaffected.
   */
  setClipVFXEnabled(enabled: boolean): void {
    const nextEnabled = enabled === true;
    this._clipVFXEnabled = nextEnabled;
    if (!nextEnabled) {
      this._clearTrackedClipVFX();
    }
  }

  applyAnimaPose(pose: AnimaPose): AnimaPoseApplyResult | null {
    if (!this.vrm) return null;
    return applyAnimaPoseToVrm(
      this.vrm,
      this._isVrm0 ? retargetPoseForVrm0(pose) : pose,
    );
  }

  clearPose(poseId: string): void {
    this.poseController?.clearPose(poseId);
  }

  forgetPose(poseId: string): void {
    this.poseController?.forgetPose(poseId);
  }

  getProceduralAnimationSnapshot(): ProceduralAnimationSnapshot | null {
    return this.proceduralAnimationController?.getSnapshot() ?? null;
  }

  /**
   * Return the most recent planner diagnostic snapshot for debug UI polling.
   */
  getAvatarPlannerDebugSnapshot(): AvatarPlannerDebugSnapshot | null {
    return this._lastAvatarPlannerDebugSnapshot
      ? cloneAvatarPlannerDebugSnapshot(this._lastAvatarPlannerDebugSnapshot)
      : null;
  }

  getReactionClipSnapshot(): ReactionClipPlayerSnapshot {
    return (
      this.reactionClipPlayer?.getSnapshot() ??
      this._getUnavailableReactionClipSnapshot()
    );
  }

  async playDebugReactionClip(clipId: string): Promise<boolean> {
    const clip = await this._motionCatalog.loadReactionClip(clipId);
    if (!clip || this._isDisposed) return false;
    this._clearPlannerReactionClipForDebugOverride();
    return (
      this.reactionClipPlayer?.play({
        ownerId: getDebugReactionClipOwnerId(clipId),
        runId: "debug",
        sourceEventId: getDebugReactionClipOwnerId(clipId),
        emotionEventId: null,
        clip,
      }) ?? false
    );
  }

  async restartDebugReactionClip(clipId: string): Promise<boolean> {
    this.reactionClipPlayer?.clear(null, { immediate: true });
    return this.playDebugReactionClip(clipId);
  }

  clearDebugReactionClip(): boolean {
    this._clearPlannerReactionClipForDebugOverride();
    return this.reactionClipPlayer?.clear(null) ?? false;
  }

  setProceduralAnimationLayerEnabled(
    id: ProceduralAnimationLayerId,
    enabled: boolean,
  ): boolean {
    return (
      this.proceduralAnimationController?.setLayerEnabled(id, enabled) ?? false
    );
  }

  setProceduralAnimationLayerWeight(
    id: ProceduralAnimationLayerId,
    weight: number,
  ): boolean {
    return (
      this.proceduralAnimationController?.setLayerWeight(id, weight) ?? false
    );
  }

  setProceduralAnimationLayerParams<TId extends ProceduralAnimationLayerId>(
    id: TId,
    params: Partial<ProceduralAnimationLayerParamsById[TId]>,
  ): boolean {
    return (
      this.proceduralAnimationController?.setLayerParams(id, params) ?? false
    );
  }

  playTalkingHandsGroup(request: TalkingHandsPlayGroupRequest): boolean {
    return (
      this.proceduralAnimationController?.playTalkingHandsGroup(request) ??
      false
    );
  }

  resetProceduralAnimationLayer(id?: ProceduralAnimationLayerId): boolean {
    return this.proceduralAnimationController?.reset(id) ?? false;
  }

  clearProceduralAnimationOffsets(): void {
    this.proceduralAnimationController?.clearActiveOffsets();
  }

  getSpringBonePhysicsSnapshot(): SpringBonePhysicsSnapshot | null {
    return this.springBonePhysicsController?.getSnapshot() ?? null;
  }

  setSpringBonePhysicsEnabled(enabled: boolean): boolean {
    const controller = this.springBonePhysicsController;
    if (!controller) return false;
    controller.setEnabled(enabled);
    return true;
  }

  setSpringBonePhysicsParams(
    params: Partial<SpringBonePhysicsParams>,
  ): boolean {
    const controller = this.springBonePhysicsController;
    if (!controller) return false;
    controller.setParams(params);
    return true;
  }

  resetSpringBonePhysics(): boolean {
    const controller = this.springBonePhysicsController;
    if (!controller) return false;
    controller.reset();
    return true;
  }

  setSpringBoneSemanticProfileOverride(
    semantic: SpringBoneSemantic,
    override: SpringBoneSemanticProfileOverride,
  ): boolean {
    const controller = this.springBonePhysicsController;
    if (!controller) return false;
    controller.setSemanticProfileOverride(semantic, override);
    return true;
  }

  resetSpringBoneSemanticProfileOverrides(
    semantic?: SpringBoneSemantic,
  ): boolean {
    const controller = this.springBonePhysicsController;
    if (!controller) return false;
    controller.resetSemanticProfileOverrides(semantic);
    return true;
  }

  setSpringBonePhysicsHelperHost(host: THREE.Object3D | null): void {
    if (__ANIMAMA_DEV_BUILD__ && DEBUG_ENABLED)
      this.springBonePhysicsController?.setHelperHost(host);
  }

  /**
   * Fade out an active animation by name.
   */
  fadeOutAnimation(name: string, durationSec: number): boolean {
    const duration =
      normalizeTransitionDurationSec(durationSec) ?? DEFAULT_VRMA_REST_FADE_SEC;
    const stopped =
      this.animationManager?.fadeOutAction(name, duration) ?? false;
    if (stopped) {
      this._beginVrmaRestPoseTransition(duration);
    }
    return stopped;
  }

  /**
   * Fade out all tracked VRMA actions and blend the base pose back to rest.
   */
  fadeOutAllAnimations(
    durationSec: number = DEFAULT_VRMA_REST_FADE_SEC,
  ): boolean {
    const duration =
      normalizeTransitionDurationSec(durationSec) ?? DEFAULT_VRMA_REST_FADE_SEC;
    const animationManager = this.animationManager;
    if (!animationManager) return false;

    let stopped = false;
    for (const name of animationManager.getActiveActionNames()) {
      stopped = animationManager.fadeOutAction(name, duration) || stopped;
    }
    if (stopped) {
      this._beginVrmaRestPoseTransition(duration);
    }
    return stopped;
  }

  /**
   * Update loop type for an active animation.
   */
  setAnimationLoopType(name: string, loopType: AnimationLoopType): boolean {
    return this.animationManager?.setActionLoopType(name, loopType) ?? false;
  }

  /**
   * Update weight for an active animation.
   */
  setAnimationWeight(name: string, weight: number): boolean {
    return this.animationManager?.setActionWeight(name, weight) ?? false;
  }

  /**
   * Update blend mode for an active animation.
   */
  setAnimationBlendMode(name: string, blendMode: AnimationBlendMode): boolean {
    return this.animationManager?.setActionBlendMode(name, blendMode) ?? false;
  }

  /**
   * Update time scale for an active animation.
   */
  setAnimationTimeScale(name: string, timeScale: number): boolean {
    return this.animationManager?.setActionTimeScale(name, timeScale) ?? false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Expression API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set an expression value (for UI sliders).
   */
  setExpression(name: string, value: number): void {
    this.expressionController?.setValue(name, value);
  }

  /**
   * Clear a single manual expression override.
   */
  clearExpressionOverride(name: string): void {
    this.expressionController?.clearValue(name);
  }

  /**
   * Clear all manual expression overrides.
   */
  clearAllExpressionOverrides(): void {
    this.expressionController?.clearAllValues();
  }

  /**
   * Check whether a manual expression override exists.
   */
  hasExpressionOverride(name: string): boolean {
    return this.expressionController?.hasManualValue(name) ?? false;
  }

  /**
   * Read the manual override value for an expression (if any).
   */
  getExpressionOverrideValue(name: string): number | null {
    return this.expressionController?.getManualValue(name) ?? null;
  }

  /**
   * Get the value of an expression.
   */
  getExpressionValue(name: string): number {
    return this.expressionController?.getValue(name) ?? 0;
  }

  /**
   * Get list of available expressions on this VRM.
   */
  getAvailableExpressions(): string[] {
    return this.expressionController?.getAvailableExpressions() ?? [];
  }

  /**
   * Render synchronously from the current frozen humanoid pose with isolated
   * expression values, then restore facial state before the next frame.
   *
   * The callback cannot yield, so animation and lip-sync clocks cannot advance
   * while WebGL reads this capture frame. Keeping the already-rendered pose also
   * avoids VRM 0.x raw/normalized rest-axis differences.
   *
   * `keepLiveExpressions` renders the current expression state unchanged;
   * `expressionName` is then ignored, so callers pass null.
   */
  runWithPortraitCaptureState<T>(
    expressionName: string | null,
    callback: () => T,
    options: { keepLiveExpressions?: boolean } = {},
  ): T {
    if (!this.vrm) {
      throw new Error("avatar_portrait_model_not_ready");
    }

    const values = expressionName ? { [expressionName]: 1 } : {};
    const run = () => {
      this.vrm?.scene.updateMatrixWorld(true);
      return callback();
    };

    return this.expressionController && !options.keepLiveExpressions
      ? this.expressionController.runWithTemporaryValues(values, run)
      : run();
  }

  /**
   * Play an emotion preset (happy, sad, angry, etc.)
   */
  playEmotion(preset: VRMExpressionPresetName): void {
    const label = mapPresetToEmotionLabel(preset);
    this.expressionController?.playEmotion(label, 1);
    this.emotion_label = label;
  }

  /**
   * Apply an emotion preset using the label + intensity debug mapping.
   */
  applyEmotionPreset(label: EmotionLabel, intensity: number = 1): void {
    this.expressionController?.applyEmotionPreset(label, intensity);
    this.emotion_label = label;
  }

  /**
   * Set the avatar emotional state and optional label.
   */
  setEmotionalState(state: EmotionalState, label?: EmotionLabel): void {
    this.emotional_state = state;
    if (label) {
      this.emotion_label = label;
    }
  }

  /**
   * Update planner-owned avatar state and execute planner actions.
   */
  updateState(
    snapshot: AvatarStateSnapshot,
    context: AvatarStateUpdateContext = {},
  ): AvatarPlannerOutput | null {
    if (!this.animationManager || !this.expressionController) return null;

    this.emotional_state = snapshot.emotionalState;
    const dominantGroupSummary = snapshot.emotionalState.dominantGroupSummary;
    const dominantLabel: EmotionLabel = snapshot.emotionalState.dominantGroup;
    const dominantIntensity = dominantGroupSummary?.intensity ?? 0;
    const activePlannerPoseClip =
      context.activePlannerPoseClip === undefined
        ? this._avatarPlannerState.activePlannerPoseClip
        : context.activePlannerPoseClip;
    const poseControllerClipActive =
      this.poseController?.isClipActive() ?? false;
    const plannerPoseClipRuntimeActive =
      !!activePlannerPoseClip &&
      (this._pendingPlannerPoseClipOwnerId === activePlannerPoseClip.ownerId ||
        (activePlannerPoseClip.status === "active" &&
          this.poseController?.isClipActive(activePlannerPoseClip.clipId) ===
            true));
    const manualPoseClipActive =
      context.manualPoseClipActive ??
      (poseControllerClipActive && !plannerPoseClipRuntimeActive);
    const proceduralPolicySnapshot =
      this.proceduralAnimationController?.getPlannerPolicySnapshot() ?? null;
    const proceduralSnapshot =
      this.proceduralAnimationController?.getSnapshot() ?? null;
    const previousPlannerPoseClip =
      this._avatarPlannerState.activePlannerPoseClip;

    const output = this._avatarPlanner.plan(this._avatarPlannerState, {
      nowMs: context.nowMs ?? Date.now(),
      animaId: context.animaId ?? this.sourceKey ?? null,
      activeRunId: context.activeRunId ?? null,
      interactionPhase: snapshot.signals.interactionPhase,
      avatarState: this.state,
      emotionalState: snapshot.emotionalState,
      activeVrmaActions:
        context.activeVrmaActions ?? this.getActiveAnimations(),
      activePlannerPoseClip,
      manualPoseClipActive,
      idlePlaybackBlocked:
        !this._automaticAnimationPlaybackEnabled &&
        this._poseClipAutomaticPlaybackWasEnabled === null,
      plannerPoseClipRuntimeActive,
      activePlannerProceduralLayerIds:
        context.activePlannerProceduralLayerIds ??
        proceduralPolicySnapshot?.activePlannerProceduralLayerIds ??
        [],
      manualProceduralLayerIds:
        context.manualProceduralLayerIds ??
        proceduralPolicySnapshot?.manualProceduralLayerIds ??
        [],
      eligiblePlannerProceduralLayerIds:
        context.eligiblePlannerProceduralLayerIds ??
        proceduralPolicySnapshot?.eligiblePlannerProceduralLayerIds ??
        [],
      pendingEvents: context.pendingEvents ?? [],
      // Without injected rolls the planner draws live randomness as needed.
      randomRolls: context.randomRolls,
      idleStintQuietIntervalSec:
        context.idleStintQuietIntervalSec ?? this._idleStintQuietIntervalSec,
      emotionPostureConfig:
        resolveEmotionPosturePlannerConfig(proceduralSnapshot),
    });
    this._avatarPlannerState = output.state;
    this._lastAvatarPlannerDebugSnapshot = cloneAvatarPlannerDebugSnapshot(
      output.debug,
    );
    for (const reason of output.debug.ignoredEventReasons) {
      if (
        !reason.startsWith("gestureRequested:") ||
        !reason.endsWith(":noAnimationClip")
      ) {
        continue;
      }
      const requestId = reason.split(":")[1] ?? null;
      const event = context.pendingEvents?.find(
        (candidate): candidate is AvatarPlannerGestureEvent =>
          candidate.type === "gestureRequested" &&
          candidate.requestId === requestId,
      );
      logger.warn("AvatarPlanner", "Rejected gesture request", {
        status: "rejected",
        requestId,
        runId: event?.runId ?? context.activeRunId ?? null,
        gestureId: event?.animationHint ?? null,
        reason: "noAnimationClip",
      });
    }
    if (
      previousPlannerPoseClip?.source === "gesture" &&
      output.state.activePlannerPoseClip?.ownerId !==
        previousPlannerPoseClip.ownerId
    ) {
      logger.info("AvatarPlanner", "Gesture pose clip completed", {
        status: "completed",
        clipId: previousPlannerPoseClip.clipId,
        ownerId: previousPlannerPoseClip.ownerId,
        runId: previousPlannerPoseClip.runId,
        reason: output.state.lastCancellationReason ?? "completed",
      });
    }

    const nextState = output.debug.baseState;
    if (nextState !== this.state) {
      logger.info("State", "State update", {
        from: this.state,
        to: nextState,
      });
    }
    this.state = nextState;

    if (
      dominantLabel !== this._lastEmotionLabel ||
      dominantIntensity !== this._lastEmotionIntensity
    ) {
      logger.info("State", "Emotion update", {
        fromLabel: this._lastEmotionLabel,
        toLabel: dominantLabel,
        fromIntensity: this._lastEmotionIntensity,
        toIntensity: dominantIntensity,
      });
      this.expressionController.applyEmotionPreset(
        dominantLabel,
        dominantIntensity,
      );
      this._lastEmotionLabel = dominantLabel;
      this._lastEmotionIntensity = dominantIntensity;
    }
    if (dominantLabel !== this.emotion_label) {
      this.emotion_label = dominantLabel;
    }

    this._executePlannerReactionClipActions(output.actions);
    this._executePlannerPoseActions(output.actions);
    this._executePlannerProceduralActions(output.actions);

    if (this._automaticAnimationPlaybackEnabled) {
      this._executePlannerVrmaActions(output.actions);
      const activePlan =
        output.state.activeGestureVrma ?? output.state.activeBaseVrma;
      if (activePlan) {
        this._executePlannerVrmaPlan(activePlan);
      }
    }

    return output;
  }

  private _executePlannerReactionClipActions(
    actions: AvatarPlannerAction[],
  ): void {
    for (const action of actions) {
      if (action.type === "playReactionClip") {
        void this._loadAndPlayPlannerReactionClip(action);
        continue;
      }

      if (action.type === "clearReactionClip") {
        this.reactionClipPlayer?.clear(action.ownerId);
        logger.info("AvatarPlanner", "Cleared reaction clip", {
          ownerId: action.ownerId,
          runId: action.runId,
          reason: action.reason,
        });
      }
    }
  }

  private async _loadAndPlayPlannerReactionClip(
    action: Extract<AvatarPlannerAction, { type: "playReactionClip" }>,
  ): Promise<void> {
    try {
      const clip = await this._motionCatalog.loadReactionClip(action.clipId);
      const current = this._avatarPlannerState.activeReactionClip;
      if (
        this._isDisposed ||
        !clip ||
        !current ||
        current.ownerId !== action.ownerId ||
        current.runId !== action.runId
      ) {
        if (!clip) {
          this._clearPlannerReactionClipIfCurrent(
            action.ownerId,
            "reactionClipMissing",
          );
        }
        return;
      }
      const didPlay =
        this.reactionClipPlayer?.play({
          ownerId: action.ownerId,
          runId: action.runId,
          sourceEventId: action.sourceEventId,
          emotionEventId: action.emotionEventId,
          clip,
        }) ?? false;
      logger.info("AvatarPlanner", "Playing reaction clip", {
        clipId: action.clipId,
        ownerId: action.ownerId,
        runId: action.runId,
        playing: didPlay,
      });
      if (!didPlay) {
        this._clearPlannerReactionClipIfCurrent(
          action.ownerId,
          "reactionClipNotPlaying",
        );
      }
    } catch (error) {
      this._clearPlannerReactionClipIfCurrent(
        action.ownerId,
        "reactionClipPlayFailed",
      );
      logger.warn("AvatarPlanner", "Failed to play reaction clip", {
        clipId: action.clipId,
        ownerId: action.ownerId,
        runId: action.runId,
        error,
      });
    }
  }

  private _clearPlannerReactionClipIfCurrent(
    ownerId: string,
    reason: string,
  ): void {
    const activeReactionClip = this._avatarPlannerState.activeReactionClip;
    if (!activeReactionClip || activeReactionClip.ownerId !== ownerId) {
      return;
    }
    this._avatarPlannerState = {
      ...this._avatarPlannerState,
      activeReactionClip: null,
      lastCancellationReason: reason,
    };
  }

  private _executePlannerPoseActions(actions: AvatarPlannerAction[]): void {
    for (const action of actions) {
      if (action.type === "playPoseClip") {
        this._pendingPlannerPoseClipOwnerId = action.ownerId;
        logger.info("AvatarPlanner", "Accepted pose clip request", {
          status: "accepted",
          clipId: action.clipId,
          ownerId: action.ownerId,
          runId: action.runId,
        });
        void this._loadAndPlayPlannerPoseClip(action);
        continue;
      }

      if (action.type === "stopPoseClip") {
        if (this._pendingPlannerPoseClipOwnerId === action.ownerId) {
          this._pendingPlannerPoseClipOwnerId = null;
        }
        if (!this.poseController?.isClipActive(action.clipId)) {
          continue;
        }
        this.stopClip({
          preserveProceduralOffsets: true,
          transition: action.transition,
        });
        logger.info("AvatarPlanner", "Stopped pose clip", {
          clipId: action.clipId,
          ownerId: action.ownerId,
          reason: action.reason,
          transition: action.transition.mode,
        });
      }
    }
  }

  private async _loadAndPlayPlannerPoseClip(
    action: Extract<AvatarPlannerAction, { type: "playPoseClip" }>,
  ): Promise<void> {
    try {
      logger.info("AvatarPlanner", "Loading pose clip", {
        status: "loading",
        clipId: action.clipId,
        ownerId: action.ownerId,
        runId: action.runId,
      });
      const clip = await this._motionCatalog.loadPoseClip(action.clipId);
      const current = this._avatarPlannerState.activePlannerPoseClip;
      if (
        this._isDisposed ||
        !clip ||
        !current ||
        current.ownerId !== action.ownerId ||
        current.runId !== action.runId
      ) {
        if (!clip) {
          this._clearPlannerPoseClipIfCurrent(
            action.ownerId,
            "poseClipMissing",
          );
          logger.warn("AvatarPlanner", "Rejected pose clip request", {
            status: "rejected",
            clipId: action.clipId,
            ownerId: action.ownerId,
            runId: action.runId,
            reason: "poseClipMissing",
          });
        }
        return;
      }
      const gesture =
        current.source === "gesture"
          ? this._motionCatalog.getGesture(current.manifestGestureId)
          : null;
      const gestureTimeScale = gesture?.timeScale ?? 1;
      const snapshot = this.playAnimaPoseClip(clip, {
        preserveProceduralOffsets: true,
        transition: action.transition,
        finitePlayback: current.finitePlayback,
        timeScale: gestureTimeScale,
      });
      if (
        snapshot.playing &&
        (current.source === "idle" || current.source === "gesture")
      ) {
        const nowMs = Date.now();
        // Start from the delivered clip, never a cold-cache fallback, so
        // loading time does not consume the Gesture's playback. A one-shot
        // clip ends with its timeline. A looping clip never finishes on its
        // own, so it keeps its configured length with the planner minimum.
        const timelineSec = getAnimaPoseClipTimelineDuration(clip);
        const durationSec =
          current.source === "idle"
            ? current.finitePlayback!.durationSec
            : clip.loop === true
              ? Math.max(
                  DEFAULT_GESTURE_DURATION_SEC,
                  (gesture?.duration ?? timelineSec) / gestureTimeScale,
                )
              : timelineSec / gestureTimeScale;
        this._avatarPlannerState.activePlannerPoseClip = {
          ...current,
          status: "active",
          startedAtMs: nowMs,
          expiresAtMs: nowMs + durationSec * 1000,
        };
        if (current.source === "idle") {
          this._avatarPlannerState.idleStint = {
            ...this._avatarPlannerState.idleStint,
            activeStartedAtMs: nowMs,
            nextDueAtMs: nowMs + durationSec * 1000,
          };
        }
      }
      logger.info("AvatarPlanner", "Playing pose clip", {
        status: "playing",
        clipId: action.clipId,
        ownerId: action.ownerId,
        runId: action.runId,
        playing: snapshot.playing,
      });
      if (!snapshot.playing) {
        this._clearPlannerPoseClipIfCurrent(
          action.ownerId,
          "poseClipNotPlaying",
        );
        logger.warn("AvatarPlanner", "Rejected pose clip request", {
          status: "rejected",
          clipId: action.clipId,
          ownerId: action.ownerId,
          runId: action.runId,
          reason: "poseClipNotPlaying",
        });
      }
    } catch (error) {
      this._clearPlannerPoseClipIfCurrent(action.ownerId, "poseClipPlayFailed");
      logger.warn("AvatarPlanner", "Rejected pose clip request", {
        status: "rejected",
        clipId: action.clipId,
        ownerId: action.ownerId,
        runId: action.runId,
        reason: "poseClipPlayFailed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      if (this._pendingPlannerPoseClipOwnerId === action.ownerId) {
        this._pendingPlannerPoseClipOwnerId = null;
      }
    }
  }

  private _clearPlannerPoseClipIfCurrent(
    ownerId: string,
    reason: string,
  ): void {
    const activeClip = this._avatarPlannerState.activePlannerPoseClip;
    if (!activeClip || activeClip.ownerId !== ownerId) {
      return;
    }
    this._avatarPlannerState = {
      ...this._avatarPlannerState,
      activePlannerPoseClip: null,
      lastCancellationReason: reason,
    };
  }

  private _executePlannerProceduralActions(
    actions: AvatarPlannerAction[],
  ): void {
    for (const action of actions) {
      if (action.type !== "setProceduralPolicy") {
        continue;
      }

      const didApply =
        this.proceduralAnimationController?.applyPlannerPolicyAction({
          ownerId: action.ownerId,
          layerId: action.layerId,
          enabled: action.enabled,
        }) ?? false;
      if (!didApply && action.enabled) {
        this._clearPlannerProceduralStintIfCurrent(
          action.ownerId,
          action.layerId,
          "proceduralPolicyApplyFailed",
        );
      }
      logger.info("AvatarPlanner", "Applied procedural policy", {
        ownerId: action.ownerId,
        layerId: action.layerId,
        enabled: action.enabled,
        applied: didApply,
      });
    }
  }

  private _clearPlannerProceduralStintIfCurrent(
    ownerId: string,
    layerId: ProceduralAnimationLayerId,
    reason: string,
  ): void {
    const proceduralStints = this._avatarPlannerState.proceduralStints.filter(
      (stint) => stint.ownerId !== ownerId || stint.layerId !== layerId,
    );
    if (
      proceduralStints.length ===
      this._avatarPlannerState.proceduralStints.length
    ) {
      return;
    }
    this._avatarPlannerState = {
      ...this._avatarPlannerState,
      proceduralStints,
      lastCancellationReason: reason,
    };
  }

  private _executePlannerVrmaActions(actions: AvatarPlannerAction[]): void {
    for (const action of actions) {
      if (action.type === "playVrmaLoop" || action.type === "playVrmaGesture") {
        this._executePlannerVrmaPlan(action.plan, action.transition);
        continue;
      }

      if (action.type === "stopVrmaLoop") {
        this._executePlannerVrmaStop(action.clipName, action.transition);
      }
    }
  }

  private _executePlannerVrmaStop(
    clipName: string,
    transition: AvatarPlannerExitPolicy,
  ): void {
    if (!this.animationManager) return;
    const fadeDuration = getAvatarPlannerExitPolicyDuration(transition) ?? 0;
    const stopped =
      fadeDuration > 0
        ? this.animationManager.fadeOutAction(clipName, fadeDuration)
        : this.animationManager.stopAction(clipName);
    if (stopped || !this._vrmaRestPoseTransition) {
      this._beginVrmaRestPoseTransition(fadeDuration);
    }
    if (!stopped) {
      logger.info("AvatarPlanner", "VRMA loop stop had no active action", {
        clipName,
      });
    }
    this._lastPlanKey = null;
  }

  private _executePlannerVrmaPlan(
    plan: AvatarPlannerVrma,
    transition?: AvatarPlannerEnterPolicy,
  ): void {
    if (
      !this.animationManager ||
      plan.key === this._lastPlanKey ||
      !plan.clipUrl ||
      !plan.clipName
    ) {
      return;
    }

    this._vrmaRestPoseTransition = null;
    const fadeDuration =
      this._pendingAutomaticPlaybackResumeFadeSec ??
      getAvatarPlannerEnterPolicyDuration(transition) ??
      plan.crossFadeSec;
    this._pendingAutomaticPlaybackResumeFadeSec = null;
    const playbackOptions = this._withVrmaRestFadeOnFinished(
      {
        isCurrent: () =>
          !this._isDisposed &&
          this._automaticAnimationPlaybackEnabled &&
          (
            this._avatarPlannerState.activeGestureVrma ??
            this._avatarPlannerState.activeBaseVrma
          )?.key === plan.key,
        loopType: plan.loopType,
        loopCount: plan.loopCount,
        timeScale: plan.timeScale,
        fadeDuration,
        warp: false,
      },
      fadeDuration,
    );
    const playPromise = plan.isGesture
      ? this.animationManager.playGesture(
          plan.clipUrl,
          plan.clipName,
          playbackOptions,
        )
      : this.animationManager.playLoop(
          plan.clipUrl,
          plan.clipName,
          playbackOptions,
        );

    if (plan.isGesture) {
      logger.info("AvatarPlanner", "Playing gesture animation", {
        clipUrl: plan.clipUrl,
        clipName: plan.clipName,
      });
    } else {
      logger.info("AvatarPlanner", "Playing loop", {
        clipUrl: plan.clipUrl,
        clipName: plan.clipName,
      });
    }
    this._lastAnimationPromise = playPromise;
    void playPromise
      .then(() => {
        const current = this._avatarPlannerState.activeBaseVrma;
        if (
          plan.clip?.idle_playback &&
          current?.key === plan.key &&
          !this._isDisposed
        ) {
          const nowMs = Date.now();
          const expiresAtMs = nowMs + (plan.effectiveDurationSec ?? 0) * 1000;
          this._avatarPlannerState.activeBaseVrma = {
            ...current,
            startedAtMs: nowMs,
            expiresAtMs,
          };
          this._avatarPlannerState.idleStint = {
            ...this._avatarPlannerState.idleStint,
            activeStartedAtMs: nowMs,
            nextDueAtMs: expiresAtMs,
          };
        }
      })
      .catch((error) => {
        if (
          plan.clip?.idle_playback &&
          this._avatarPlannerState.activeBaseVrma?.key === plan.key
        ) {
          this._avatarPlannerState.activeBaseVrma = null;
        }
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        logger.warn("Animation", "Animation playback failed", {
          clipUrl: plan.clipUrl,
          clipName: plan.clipName,
          error,
        });
      });
    this._lastPlanKey = plan.key;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lip-Sync API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set the audio context for lip-sync timing.
   */
  setAudioContext(ctx: AudioContext | null): void {
    this.expressionController?.setAudioContext(ctx);
  }

  /**
   * Get the audio context used for lip-sync.
   */
  getAudioContext(): AudioContext | null {
    return this.expressionController?.getAudioContext() ?? null;
  }

  /**
   * Set callback for when segment audio starts.
   */
  setSegmentAudioStartedCallback(
    cb: ((segmentId: string, audioStartSec: number) => void) | null,
  ): void {
    this.expressionController?.setSegmentAudioStartedCallback(cb);
  }

  /**
   * Notify that a segment's audio has started playing.
   */
  onSegmentAudioStarted(segmentId: string, audioStartSec: number): void {
    this.expressionController?.onSegmentAudioStarted(segmentId, audioStartSec);
  }

  /**
   * Initialize a lip-sync segment.
   */
  initLipSyncSegment(meta: SegmentMeta): void {
    this.expressionController?.initLipSyncSegment(meta);
  }

  /**
   * Register a lip-sync frame.
   */
  registerLipSyncFrame(payload: FramePayload): void {
    this.expressionController?.registerLipSyncFrame(payload);
  }

  /**
   * Replace a live lip-sync segment's frames from `fromTimeSec` on, and set its
   * duration; earlier frames keep playing as they were.
   */
  replaceLipSyncFrames(
    segmentId: string,
    fromTimeSec: number,
    frames: readonly FramePayload[],
    durationSec: number,
  ): void {
    this.expressionController?.replaceLipSyncFrames(
      segmentId,
      fromTimeSec,
      frames,
      durationSec,
    );
  }

  /**
   * Clear all lip-sync data.
   */
  clearLipSync(): void {
    this.expressionController?.clearLipSync();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the head bone position (for camera targeting).
   */
  getHeadPosition(): THREE.Vector3 | null {
    if (!this.vrm) return null;
    const headNode = this.vrm.humanoid.getNormalizedBoneNode("head");
    if (!headNode) return null;
    return headNode.getWorldPosition(new THREE.Vector3());
  }

  getCameraAnchorY(anchor: "hips" | "chest" | "head"): number | null {
    if (!this.vrm) return null;

    const candidates =
      anchor === "chest"
        ? (["chest", "upperChest", "spine"] as const)
        : [anchor];

    for (const candidate of candidates) {
      const boneNode = this.vrm.humanoid.getNormalizedBoneNode(
        candidate as never,
      );
      if (!boneNode) continue;
      return boneNode.getWorldPosition(new THREE.Vector3()).y;
    }

    return null;
  }

  projectWorldPointToViewport(
    worldPoint: THREE.Vector3,
    viewport: SceneViewportSize,
  ): (ScenePointPx & { visible: boolean }) | null {
    if (
      !(this._camera instanceof THREE.Camera) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return null;
    }

    this._camera.updateMatrixWorld(true);

    const projectedPoint = worldPoint.clone().project(this._camera);
    const x = ((projectedPoint.x + 1) / 2) * viewport.width;
    const y = ((1 - projectedPoint.y) / 2) * viewport.height;

    return {
      x,
      y,
      visible:
        projectedPoint.z >= -1 &&
        projectedPoint.z <= 1 &&
        projectedPoint.x >= -1 &&
        projectedPoint.x <= 1 &&
        projectedPoint.y >= -1 &&
        projectedPoint.y <= 1,
    };
  }

  resolveFocusLinesFaceTarget(
    viewport: SceneViewportSize,
    options?: {
      paddingXPx?: number;
      paddingYPx?: number;
    },
  ): SceneFocusResolvedTarget | null {
    const camera = this._camera instanceof THREE.Camera ? this._camera : null;
    if (!camera || viewport.width <= 0 || viewport.height <= 0) {
      return null;
    }

    const faceLandmarks = this.faceLandmarks?.getSnapshot() ?? null;
    const faceTextureAnchors = this.faceTextureAnchors?.getSnapshot() ?? null;
    const paddingXPx =
      options?.paddingXPx ?? DEFAULT_SCENE_FOCUS_LINES_FACE_PADDING_X_PX;
    const paddingYPx =
      options?.paddingYPx ?? DEFAULT_SCENE_FOCUS_LINES_FACE_PADDING_Y_PX;
    const projectionScratch = this._focusLinesProjectionScratch;

    camera.updateMatrixWorld(true);

    const projectVisiblePoint = (
      worldPoint:
        | {
            x: number;
            y: number;
            z: number;
          }
        | null
        | undefined,
    ): ScenePointPx | null => {
      if (!worldPoint) {
        return null;
      }

      projectionScratch.set(worldPoint.x, worldPoint.y, worldPoint.z);
      projectionScratch.project(camera);

      if (
        projectionScratch.z < -1 ||
        projectionScratch.z > 1 ||
        projectionScratch.x < -1 ||
        projectionScratch.x > 1 ||
        projectionScratch.y < -1 ||
        projectionScratch.y > 1
      ) {
        return null;
      }

      return {
        x: ((projectionScratch.x + 1) / 2) * viewport.width,
        y: ((1 - projectionScratch.y) / 2) * viewport.height,
      };
    };

    const leftEye =
      faceLandmarks?.status === "ready"
        ? projectVisiblePoint(faceLandmarks.eyes.left?.projectedFrontWorld)
        : null;
    const rightEye =
      faceLandmarks?.status === "ready"
        ? projectVisiblePoint(faceLandmarks.eyes.right?.projectedFrontWorld)
        : null;
    const mouth =
      faceTextureAnchors?.status === "ready"
        ? projectVisiblePoint(
            faceTextureAnchors.anchors.mouth.center?.worldPoint,
          )
        : null;

    return resolveAvatarFaceFocusTarget({
      leftEye,
      rightEye,
      mouth,
      paddingXPx,
      paddingYPx,
      viewport,
    });
  }

  private _getUnavailablePoseSnapshot(
    poseId: string,
  ): AvatarPoseSnapshot<AnimaPose> {
    return {
      ready: false,
      enabled: true,
      applied: false,
      params: cloneAnimaPose(this._motionCatalog.getPose(poseId)),
      resolvedBones: [],
      missingBones: [],
      resolvedExpressions: [],
      missingExpressions: [],
    };
  }

  private _syncPoseClipEventSink(): void {
    if (!this.poseController) return;
    const externalSink = this._poseClipExternalEventSink;
    this.poseController.setClipEventSink({
      applyAvatarVFX: this._applyPoseClipAvatarVFX,
      clearAvatarVFX: this._clearPoseClipAvatarVFX,
      setAvatarVFXIntensity: this._setClipAvatarVFXIntensity,
      applyParticleVFX: this._applyPoseClipParticleVFX,
      clearParticleVFX: this._clearPoseClipParticleVFX,
      ...(externalSink?.applySceneVFX
        ? { applySceneVFX: externalSink.applySceneVFX }
        : {}),
      ...(externalSink?.clearSceneVFX
        ? { clearSceneVFX: externalSink.clearSceneVFX }
        : {}),
      ...(externalSink?.playSfx ? { playSfx: externalSink.playSfx } : {}),
    });
  }

  private _syncReactionClipEventSink(): void {
    if (!this.reactionClipPlayer) return;
    const externalSink = this._reactionClipExternalEventSink;
    this.reactionClipPlayer.setEventSink({
      applyAvatarVFX: this._applyReactionClipAvatarVFX,
      clearAvatarVFX: this._clearReactionClipAvatarVFX,
      setAvatarVFXIntensity: this._setClipAvatarVFXIntensity,
      applyParticleVFX: this._applyReactionClipParticleVFX,
      clearParticleVFX: this._clearReactionClipParticleVFX,
      ...(externalSink?.applySceneVFX
        ? { applySceneVFX: externalSink.applySceneVFX }
        : {}),
      ...(externalSink?.clearSceneVFX
        ? { clearSceneVFX: externalSink.clearSceneVFX }
        : {}),
      ...(externalSink?.playSfx ? { playSfx: externalSink.playSfx } : {}),
    });
  }

  /** Forward a clip event's fade to the effect it owns (held while it loads). */
  private _setClipAvatarVFXIntensity = (
    _event: Parameters<
      NonNullable<AnimaPoseClipEventSink["setAvatarVFXIntensity"]>
    >[0],
    context: AnimaPoseClipEventContext,
    intensity: number,
  ): void => {
    if (!this._clipOwnedAvatarVFXIds.has(context.appliedId)) return;
    this.vfxController?.setEffectIntensity(context.appliedId, intensity);
  };

  private _applyPoseClipAvatarVFX = async (
    event: Parameters<NonNullable<AnimaPoseClipEventSink["applyAvatarVFX"]>>[0],
    context: AnimaPoseClipEventContext,
  ): Promise<void> => {
    await this._applyClipOwnedAvatarVFX(
      event,
      context,
      this._poseClipExternalEventSink,
    );
  };

  private _clearPoseClipAvatarVFX = (
    _event: Parameters<
      NonNullable<AnimaPoseClipEventSink["clearAvatarVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
  ): void => {
    this._clearClipOwnedAvatarVFX(context);
  };

  private _applyPoseClipParticleVFX = async (
    event: Parameters<
      NonNullable<AnimaPoseClipEventSink["applyParticleVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
  ): Promise<void> => {
    await this._applyParticleVFXEvent(event, context, "pose clip");
  };

  private _clearPoseClipParticleVFX = (
    _event: Parameters<
      NonNullable<AnimaPoseClipEventSink["clearParticleVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
  ): void => {
    this._clearClipOwnedParticleVFX(context);
  };

  private _applyReactionClipAvatarVFX = async (
    event: Parameters<NonNullable<AnimaPoseClipEventSink["applyAvatarVFX"]>>[0],
    context: AnimaPoseClipEventContext,
  ): Promise<void> => {
    await this._applyClipOwnedAvatarVFX(
      event,
      context,
      this._reactionClipExternalEventSink,
    );
  };

  private _clearReactionClipAvatarVFX = (
    _event: Parameters<
      NonNullable<AnimaPoseClipEventSink["clearAvatarVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
  ): void => {
    this._clearClipOwnedAvatarVFX(context);
  };

  private _applyReactionClipParticleVFX = async (
    event: Parameters<
      NonNullable<AnimaPoseClipEventSink["applyParticleVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
  ): Promise<void> => {
    await this._applyParticleVFXEvent(event, context, "reaction clip");
  };

  private _clearReactionClipParticleVFX = (
    _event: Parameters<
      NonNullable<AnimaPoseClipEventSink["clearParticleVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
  ): void => {
    this._clearClipOwnedParticleVFX(context);
  };

  private async _applyClipOwnedAvatarVFX(
    event: Parameters<NonNullable<AnimaPoseClipEventSink["applyAvatarVFX"]>>[0],
    context: AnimaPoseClipEventContext,
    soundSink: AnimaPoseClipEventSink | null,
  ): Promise<void> {
    if (!this._clipVFXEnabled || context.signal?.aborted) return;
    if (!this.isReady || !this.vfxController) {
      throw new Error("Avatar VFX controller is unavailable.");
    }

    this.vfxController.removeEffect(context.appliedId);
    this._clipOwnedAvatarVFXIds.add(context.appliedId);

    let didApply = false;
    let soundCueId: string | undefined;
    let effect: AvatarVFXParsedEntry | null = null;
    try {
      effect = await this._mediaCatalog.loadAvatarVFX(
        event.effectId,
        event.override,
      );
      if (
        context.signal?.aborted ||
        this._wasClipOwnedAvatarVFXCancelled(context.appliedId)
      ) {
        this._clipOwnedAvatarVFXIds.delete(context.appliedId);
        return;
      }
      soundCueId = effect?.sound?.onApply;
      didApply = await applyAvatarVFXEffectById({
        avatar: this,
        effectId: event.effectId,
        appliedEffectId: context.appliedId,
        effectEntry: effect,
      });
    } catch (error) {
      const wasCancelled = this._wasClipOwnedAvatarVFXCancelled(
        context.appliedId,
      );
      this._clipOwnedAvatarVFXIds.delete(context.appliedId);
      if (wasCancelled) return;
      throw error;
    }

    if (!didApply) {
      const wasCancelled = this._wasClipOwnedAvatarVFXCancelled(
        context.appliedId,
      );
      this._clipOwnedAvatarVFXIds.delete(context.appliedId);
      if (wasCancelled) return;
      // A missing face part is an expected model limit, already logged once
      // by the controller; the clip continues without the effect.
      if (effect && this.vfxController?.findUnavailableFacePart(effect)) return;
      throw new Error(`Avatar VFX "${event.effectId}" could not be applied.`);
    }

    if (
      context.signal?.aborted ||
      this._wasClipOwnedAvatarVFXCancelled(context.appliedId)
    ) {
      this.vfxController?.removeEffect(context.appliedId);
      this._clipOwnedAvatarVFXIds.delete(context.appliedId);
      return;
    }

    // Audio belongs to this occurrence, never to the shared effect definition.
    if (event.playAccompanyingSound !== false && soundCueId) {
      await soundSink?.playSfx?.(
        { id: event.id, time: event.time, kind: "sfx", cueId: soundCueId },
        context,
      );
    }
  }

  private _clearClipOwnedAvatarVFX(context: AnimaPoseClipEventContext): void {
    this._clipOwnedAvatarVFXIds.delete(context.appliedId);
    this.vfxController?.removeEffect(context.appliedId);
  }

  private async _applyParticleVFXEvent(
    event: Parameters<
      NonNullable<AnimaPoseClipEventSink["applyParticleVFX"]>
    >[0],
    context: AnimaPoseClipEventContext,
    source: string,
  ): Promise<void> {
    if (!this._clipVFXEnabled || context.signal?.aborted) return;
    if (!this.isReady || !this.particleVFXController) {
      throw new Error("Particle VFX controller is unavailable.");
    }

    this.particleVFXController.clearEffect(context.appliedId);
    this._clipOwnedParticleVFXIds.add(context.appliedId);

    let didApply = false;
    try {
      didApply = await this.particleVFXController.playEffect({
        effectId: event.effectId,
        signal: context.signal,
        appliedId: context.appliedId,
        ownerId: source,
        ...(event.anchor ? { anchor: event.anchor } : {}),
        ...(event.duration !== undefined
          ? { durationSec: event.duration }
          : {}),
        ...(event.transform ? { transform: event.transform } : {}),
        ...(event.followAnchor !== undefined
          ? { followAnchor: event.followAnchor }
          : {}),
      });
    } catch (error) {
      const wasCancelled =
        context.signal?.aborted ||
        this._wasClipOwnedParticleVFXCancelled(context.appliedId);
      this._clipOwnedParticleVFXIds.delete(context.appliedId);
      if (wasCancelled) return;
      throw error;
    }

    if (!didApply) {
      const wasCancelled =
        context.signal?.aborted ||
        this._wasClipOwnedParticleVFXCancelled(context.appliedId);
      this._clipOwnedParticleVFXIds.delete(context.appliedId);
      if (wasCancelled) return;
      throw new Error(`Particle VFX "${event.effectId}" could not be applied.`);
    }

    if (
      context.signal?.aborted ||
      this._wasClipOwnedParticleVFXCancelled(context.appliedId)
    ) {
      this.particleVFXController?.clearEffect(context.appliedId);
      this._clipOwnedParticleVFXIds.delete(context.appliedId);
    }
  }

  private _clearClipOwnedParticleVFX(context: AnimaPoseClipEventContext): void {
    this._clipOwnedParticleVFXIds.delete(context.appliedId);
    this.particleVFXController?.clearEffect(context.appliedId);
  }

  private _clearTrackedClipVFX(): void {
    for (const appliedId of this._clipOwnedAvatarVFXIds) {
      this.vfxController?.removeEffect(appliedId);
    }
    this._clipOwnedAvatarVFXIds.clear();

    for (const appliedId of this._clipOwnedParticleVFXIds) {
      this.particleVFXController?.clearEffect(appliedId);
    }
    this._clipOwnedParticleVFXIds.clear();
  }

  private _wasClipOwnedAvatarVFXCancelled(appliedId: string): boolean {
    return !this._clipVFXEnabled || !this._clipOwnedAvatarVFXIds.has(appliedId);
  }

  private _wasClipOwnedParticleVFXCancelled(appliedId: string): boolean {
    return (
      !this._clipVFXEnabled || !this._clipOwnedParticleVFXIds.has(appliedId)
    );
  }

  private _resolveReactionClipPoseRef = (poseId: string) => {
    try {
      return this._motionCatalog.getResolvedPose(poseId);
    } catch {
      return null;
    }
  };

  private _beginPoseClipPlayback(): void {
    if (this._poseClipAutomaticPlaybackWasEnabled !== null) return;

    const wasAutomaticPlaybackEnabled = this._automaticAnimationPlaybackEnabled;
    this._poseClipAutomaticPlaybackWasEnabled = wasAutomaticPlaybackEnabled;
    if (wasAutomaticPlaybackEnabled) {
      this.setAutomaticAnimationPlaybackEnabled(false);
    }
  }

  private _stopCoordinatedPoseClip({
    reapplyDefaultPose,
    preserveProceduralOffsets,
    transition,
  }: {
    reapplyDefaultPose: boolean;
    preserveProceduralOffsets: boolean;
    transition?: AvatarPlannerExitPolicy;
  }): void {
    // A requested stop (including a fade) is cancellation, not natural finish.
    this._poseClipOnFinished = null;
    const poseController = this.poseController;
    const hasCoordinatedClip =
      this._poseClipAutomaticPlaybackWasEnabled !== null ||
      Boolean(poseController?.isClipActive());
    if (!hasCoordinatedClip) return;

    const stopClip = () => {
      const stoppedImmediately = poseController?.stopClip({
        immediate: !preserveProceduralOffsets && !reapplyDefaultPose,
        fadeOutDurationSec: getAvatarPlannerExitPolicyDuration(transition),
      });
      if (stoppedImmediately === false) {
        this._poseClipCompletionReapplyDefaultPose = reapplyDefaultPose;
        return;
      }
      this._completePoseClipPlayback({ reapplyDefaultPose });
    };

    if (
      preserveProceduralOffsets &&
      this._poseClipAutomaticPlaybackWasEnabled !== null
    ) {
      this._replacePoseBasePreservingProcedural(stopClip);
      return;
    }

    stopClip();
  }

  private _completePoseClipPlaybackReplacingBase({
    reapplyDefaultPose,
    preserveProceduralOffsets = this._poseClipPreserveProceduralOffsets,
  }: {
    reapplyDefaultPose: boolean;
    preserveProceduralOffsets?: boolean;
  }): void {
    const completePlayback = () => {
      this._completePoseClipPlayback({ reapplyDefaultPose });
    };

    if (
      preserveProceduralOffsets &&
      this._poseClipAutomaticPlaybackWasEnabled !== null
    ) {
      this._replacePoseBasePreservingProcedural(completePlayback);
      return;
    }

    completePlayback();
  }

  private _completePoseClipPlayback({
    reapplyDefaultPose,
  }: {
    reapplyDefaultPose: boolean;
  }): void {
    const shouldRestoreAutomaticPlayback =
      this._poseClipAutomaticPlaybackWasEnabled;
    this._poseClipAutomaticPlaybackWasEnabled = null;
    this._poseClipPreserveProceduralOffsets = false;
    this._poseClipCompletionReapplyDefaultPose = true;

    if (reapplyDefaultPose && shouldRestoreAutomaticPlayback !== null) {
      this.poseController?.forgetDefaultPoseOffsets();
      this.poseController?.applyDefaultPoses();
    }

    if (
      shouldRestoreAutomaticPlayback === true &&
      !this._automaticAnimationPlaybackEnabled
    ) {
      this._pendingAutomaticPlaybackResumeFadeSec =
        DEFAULT_AUTOMATIC_VRMA_RESUME_FADE_SEC;
      this.setAutomaticAnimationPlaybackEnabled(true);
    }
  }

  private _withVrmaRestFadeOnFinished<T extends AnimationOptions>(
    options: T | undefined,
    restFadeDurationSec?: number | null,
  ): T & { onFinished: () => void } {
    const playbackOptions = (options ?? {}) as T;
    const originalOnFinished = playbackOptions.onFinished;
    const restFadeDuration =
      normalizeTransitionDurationSec(restFadeDurationSec) ??
      normalizeTransitionDurationSec(playbackOptions.fadeDuration) ??
      DEFAULT_VRMA_REST_FADE_SEC;

    return {
      ...playbackOptions,
      onFinished: () => {
        this._beginVrmaRestPoseTransition(restFadeDuration);
        originalOnFinished?.();
      },
    };
  }

  private _clearPlannerReactionClipForDebugOverride(): void {
    if (!this._avatarPlannerState.activeReactionClip) return;
    this._avatarPlannerState = {
      ...this._avatarPlannerState,
      activeReactionClip: null,
      lastCancellationReason: "debugReactionOverride",
    };
    this._lastAvatarPlannerDebugSnapshot = this._lastAvatarPlannerDebugSnapshot
      ? {
          ...this._lastAvatarPlannerDebugSnapshot,
          activeReactionClip: null,
          lastCancellationReason: "debugReactionOverride",
        }
      : null;
  }

  private _beginVrmaRestPoseTransition(durationSec: number): void {
    const duration = Number.isFinite(durationSec)
      ? Math.max(0, durationSec)
      : 0;

    this._replacePoseBasePreservingProcedural(() => {
      if (duration <= 0) {
        this._vrmaRestPoseTransition = null;
        this._applyDefaultPoseBase();
        return;
      }

      const fromSample = this._captureCurrentHumanoidSample();
      const toSample = this._createRelaxedRestPoseSample();
      if (!fromSample || !toSample) {
        this._vrmaRestPoseTransition = null;
        this._applyDefaultPoseBase();
        return;
      }

      this._vrmaRestPoseTransition = {
        elapsedSec: 0,
        durationSec: duration,
        fromSample,
        toSample,
      };
      this._applyVrmaRestPoseTransitionSample(0);
    });
  }

  private _updateVrmaRestPoseTransition(deltaSec: number): void {
    const transition = this._vrmaRestPoseTransition;
    if (!transition || !this.vrm) return;
    const clipActive = this.poseController?.isClipActive() ?? false;
    if (clipActive && this._poseClipAutomaticPlaybackWasEnabled !== null) {
      this._vrmaRestPoseTransition = null;
      return;
    }

    const delta = Number.isFinite(deltaSec) ? Math.max(0, deltaSec) : 0;
    transition.elapsedSec += delta;
    const progress =
      transition.durationSec > 0
        ? THREE.MathUtils.clamp(
            transition.elapsedSec / transition.durationSec,
            0,
            1,
          )
        : 1;

    if (progress >= 1) {
      // Finish the rest sample without replacing an event-only clip's clock.
      // Applying a catalog pose through PoseController would clear its effects.
      if (clipActive) this._applyVrmaRestPoseTransitionSample(1);
      this._vrmaRestPoseTransition = null;
      if (!clipActive) this._applyDefaultPoseBase();
      return;
    }

    this._applyVrmaRestPoseTransitionSample(progress);
  }

  private _applyVrmaRestPoseTransitionSample(progress: number): void {
    const transition = this._vrmaRestPoseTransition;
    if (!transition || !this.vrm) return;

    const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
    const sample = interpolateSamples(
      transition.fromSample,
      transition.toSample,
      clampedProgress,
      easeProgress(clampedProgress, DEFAULT_ANIMA_POSE_CLIP_TRANSITION.easing),
      DEFAULT_ANIMA_POSE_CLIP_TRANSITION,
    );

    this._applyPoseSampleAsBase(sample, {
      id: "__vrma-rest-transition",
      name: "VRMA Rest Transition",
    });
  }

  private _captureCurrentHumanoidSample(): AnimaPoseClipSample | null {
    if (!this.vrm) return null;
    return {
      humanoid: cloneVRMPose(this.vrm.humanoid.getNormalizedPose()),
    };
  }

  private _createRelaxedRestPoseSample(): AnimaPoseClipSample | null {
    try {
      const pose = this._motionCatalog.getResolvedPose(RELAXED_REST_POSE_ID);
      const sample: AnimaPoseClipSample = {
        ...(pose.humanoid ? { humanoid: cloneVRMPose(pose.humanoid) } : {}),
        ...(pose.expressions ? { expressions: { ...pose.expressions } } : {}),
      };
      return this._isVrm0 ? retargetClipSampleForVrm0(sample) : sample;
    } catch (error) {
      logger.warn("Animation", "Failed to resolve relaxed rest pose", {
        error,
      });
      return null;
    }
  }

  private _applyPoseSampleAsBase(
    sample: AnimaPoseClipSample,
    metadata: { id: string; name: string },
  ): void {
    if (!this.vrm) return;
    if (!sample.humanoid && !sample.expressions) return;

    applyAnimaPoseToVrm(this.vrm, {
      schema: "animaPose/1.0",
      id: metadata.id,
      name: metadata.name,
      ...(sample.humanoid ? { humanoid: cloneVRMPose(sample.humanoid) } : {}),
      ...(sample.expressions ? { expressions: { ...sample.expressions } } : {}),
    });
  }

  private _applyDefaultPoseBase(): void {
    this.poseController?.forgetDefaultPoseOffsets();
    this.poseController?.applyDefaultPoses();
  }

  private _replacePoseBase<T>(
    options: PoseBaseReplacementOptions | undefined,
    applyBase: () => T,
  ): T {
    if (options?.preserveProceduralOffsets !== true) {
      return applyBase();
    }
    return this._replacePoseBasePreservingProcedural(applyBase);
  }

  private _replacePoseBasePreservingProcedural<T>(applyBase: () => T): T {
    this.proceduralAnimationController?.clearActiveOffsets();
    try {
      return applyBase();
    } finally {
      this._reapplyProceduralOffsetsWithoutAdvancing();
    }
  }

  private _reapplyProceduralOffsetsWithoutAdvancing(): void {
    if (this._isDisposed || !this.vrm || !this.proceduralAnimationController) {
      return;
    }

    this.proceduralAnimationController.update(0, {
      avatarState: this.state,
      emotionLabel: this.emotion_label,
      emotionalState: this.emotional_state,
      globalRestPoseActive: this.isPoseActive(RELAXED_REST_POSE_ID),
    });
  }

  private _getUnavailableClipSnapshot(clipId?: string): AvatarPoseClipSnapshot {
    const clip = clipId ? this._motionCatalog.getPoseClip(clipId) : null;
    return {
      ready: false,
      applied: false,
      playing: false,
      clipId: clip?.id ?? clipId ?? null,
      elapsedSec: 0,
      durationSec: clip ? getAnimaPoseClipTimelineDuration(clip) : 0,
      loop: clip?.loop === true,
      resolvedBones: [],
      missingBones: [],
      resolvedExpressions: [],
      missingExpressions: [],
      missingPoseRefs: [],
      eventCount: clip?.events?.length ?? 0,
      eventKindCounts: countAnimaPoseClipEventsByKind(clip),
      firedEventCount: 0,
      firedEventIds: [],
      activeEventCount: 0,
      eventDispatchAvailable: false,
      skippedEventCount: 0,
      eventErrorCount: 0,
      lastEventError: null,
    };
  }

  private _getUnavailableReactionClipSnapshot(): ReactionClipPlayerSnapshot {
    return {
      ready: false,
      active: false,
      clipId: null,
      ownerId: null,
      runId: null,
      sourceEventId: null,
      emotionEventId: null,
      elapsedSec: 0,
      timelineDurationSec: 0,
      phase: null,
      fadeElapsedSec: 0,
      fadeInDurationSec: 0,
      fadeOutDurationSec: 0,
      eventCount: 0,
      eventKindCounts: countAnimaPoseClipEventsByKind(null),
      firedEventCount: 0,
      firedEventIds: [],
      activeEventCount: 0,
      eventDispatchAvailable: false,
      expressionKeys: [],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Shared GLTF loader (VRM + VRMA)
  // ─────────────────────────────────────────────────────────────────────────

  private static _getGLTFLoader(): GLTFLoader {
    if (Avatar._gltfLoader) return Avatar._gltfLoader;

    const loader = Avatar._createGLTFLoader();
    Avatar._gltfLoader = loader;
    return loader;
  }

  private static _createGLTFLoader(manager?: THREE.LoadingManager): GLTFLoader {
    const loader = new GLTFLoader(manager);
    registerAvatarShaderGltfPatch(loader);
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    return loader;
  }

  private static async _loadVrm(
    url: string,
    onProgress?: (loaded: number, total: number) => void,
    resourceUrls?: Readonly<Record<string, string>>,
  ): Promise<{ gltf: GLTF; vrm: VRM }> {
    const loader = resourceUrls
      ? Avatar._createGLTFLoader(
          new THREE.LoadingManager().setURLModifier(
            preparedModelUrlResolver(url, resourceUrls),
          ),
        )
      : Avatar._getGLTFLoader();

    let gltf: GLTF;
    try {
      gltf = await loader.loadAsync(url, (evt) => {
        if (onProgress && evt.lengthComputable)
          onProgress(evt.loaded, evt.total);
      });
    } catch (error) {
      if (isLikelyGitLfsPointerParseError(error)) {
        throw createGitLfsAssetError("VRM", url, error);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Avatar._loadVrm failed: ${message}`);
    }

    try {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      const vrm = (gltf as unknown as GLTF & { userData: { vrm?: VRM } })
        .userData?.vrm;
      if (!vrm) throw new Error("VRM metadata missing on loaded GLTF");
      VRMUtils.rotateVRM0(vrm);
      await applyAvatarShader(vrm);
      const canonicalizedExpressions = canonicalizeCustomPresetExpressions(vrm);
      if (Object.keys(canonicalizedExpressions).length > 0) {
        logger.info("Load", "Canonicalized custom preset expressions", {
          renamed: canonicalizedExpressions,
        });
      }
      vrm.scene.name = "VRMRoot";
      const loadInsight = inspectBrowserResourceLoad(url);
      logger.info("Load", "VRM resource load insight", {
        ...loadInsight,
        url: redactUrlForLogging(loadInsight.url) ?? loadInsight.url,
      });
      return { gltf, vrm };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Avatar._loadVrm post-process failed: ${message}`);
    }
  }

  private static async _loadVrmaCached(
    source: AvatarVrmaResource | string,
  ): Promise<VRMAnimation | null> {
    const resource =
      typeof source === "string"
        ? BUILT_IN_AVATAR_MOTION_CATALOG.resolveVrma(source)
        : source;
    if (!resource?.url) return null;

    const cache = resource.cache ?? Avatar._vrmaCache;
    let entry = cache.get(resource.cacheKey);
    if (!entry) {
      entry = (async () => {
        const download = await resource.getDownloadUrl?.();
        const downloadUrl = download?.url ?? resource.url;
        let gltf: GLTF & { userData: { vrmAnimations?: VRMAnimation[] } };
        try {
          const loader = resource.resourceUrls
            ? Avatar._createGLTFLoader(
                new THREE.LoadingManager().setURLModifier(
                  preparedModelUrlResolver(downloadUrl, resource.resourceUrls),
                ),
              )
            : Avatar._getGLTFLoader();
          gltf = (await loader.loadAsync(downloadUrl)) as GLTF & {
            userData: { vrmAnimations?: VRMAnimation[] };
          };
        } catch (error) {
          if (isLikelyGitLfsPointerParseError(error)) {
            throw createGitLfsAssetError("VRMA animation", downloadUrl, error);
          }
          throw error;
        } finally {
          download?.release();
        }
        const vrmAnimations = gltf.userData?.vrmAnimations ?? [];
        return vrmAnimations[0] ?? null;
      })();
      cache.set(resource.cacheKey, entry);
    }

    try {
      return await entry;
    } catch (error) {
      if (cache.get(resource.cacheKey) === entry) {
        cache.delete(resource.cacheKey);
      }
      throw error;
    }
  }

  static async preloadVrma(source: AvatarVrmaResource | string): Promise<void> {
    await Avatar._loadVrmaCached(source);
  }

  /** Exercise the production VRM loader without retaining a mounted avatar. */
  static async preloadVrm(url: string): Promise<void> {
    const { vrm } = await Avatar._loadVrm(url);
    releaseModelScene(vrm.scene);
  }

  static clearVrmaCache(): void {
    Avatar._vrmaCache.clear();
  }
}

function mapPresetToEmotionLabel(
  preset: VRMExpressionPresetName,
): EmotionLabel {
  switch (preset) {
    case "happy":
      return "delight";
    case "sad":
      return "gloom";
    case "angry":
      return "rejection";
    case "surprised":
      return "alarm";
    case "relaxed":
      return "affection";
    case "neutral":
    default:
      return "neutral";
  }
}
