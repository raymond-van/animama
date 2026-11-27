import { AvatarTransformControls as TransformControls } from "@/ui/avatar-preview/AvatarTransformControls";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getI18n } from "react-i18next";
import { type Group, type Object3D } from "three";

import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import type { Avatar } from "@/lib/avatar";
import { Avatar as AvatarRuntime } from "@/lib/avatar";
import type { PreviewRuntimeCatalogSession } from "@/lib/content-preview/PreviewRuntimeCatalogSession";
import { WordedError } from "@/lib/errors/apiError";
import {
  acquireContentPreviewResource,
  logContentPreviewLifecycle,
} from "@/lib/content-preview/lifecycle";
import {
  contentPreviewEffectCommand,
  ContentPreviewApplySoundPlayer,
  attachContentPreviewClipEventBridge,
  clearContentPreviewEffects,
  createContentPreviewClipEventBridge,
  playContentPreviewEffect,
} from "@/lib/content-preview/effects";
import {
  boundedContentPreviewFrameDelta,
  playContentPreviewMotion,
  type ContentPreviewMissingDependency,
} from "@/lib/content-preview/playback";
import type {
  ContentPreviewLoadStatus,
  ContentPreviewTarget,
} from "@/lib/content-preview/types";
import { runtimeContentEntryUrl } from "@/lib/runtime-content/animaRuntimeSnapshot";
import {
  runtimeContentDownloadUrl,
  type RuntimeContentUrlLease,
} from "@/lib/runtime-content/runtimeContentDelivery";
import { useAvatarLoadSettings } from "@/query/hooks/useAvatarSettings";
import {
  registerPreviewDockAvatar,
  unregisterPreviewDockAvatar,
} from "@/stores/preview-dock-avatar-store";
import {
  resolveRuntimeAvatarFaceParts,
  runtimeAvatarItemId,
} from "@/lib/runtime-content/runtimeAvatarFaceParts";
import type { SceneVFXRuntimeEntry } from "@/lib/scene-vfx/types";
import {
  applyAvatarTransformToObject,
  avatarTransformFromObject,
  type AvatarTransform,
} from "@/ui/main/canvas/transform-state";
import { AvatarPreviewSurface } from "@/ui/avatar-preview/AvatarPreviewSurface";
import type { SceneCameraSettings } from "@/ui/main/canvas/sceneCameraPresets";
import { useSceneFrameDemand } from "@/ui/main/canvas/sceneFramePacing";
import { failureLine } from "@/lib/errors/apiError";
import { useStagePortraitRetake } from "@/ui/avatar-preview/useStagePortraitRetake";

const PARTICLE_PREVIEW_CAMERA: SceneCameraSettings = {
  position: { x: 0, y: 1.2, z: 2.75 },
  fov: 35,
  orbitTarget: { x: 0, y: 1, z: 0 },
};

type PreviewActorProps = {
  active: boolean;
  avatarTransform: AvatarTransform;
  avatarEntry: RuntimeCatalogEntry;
  catalog: PreviewRuntimeCatalogSession;
  loop: boolean;
  playRequest: number;
  /** Increments whenever the host commits a newly prepared preview. */
  preparationRequest: number;
  resetCameraRequest: number;
  stopRequest: number;
  target: ContentPreviewTarget;
  moveAvatar: boolean;
  onAvatarChange: (avatar: Avatar | null) => void;
  onAvatarTransformChange: (transform: AvatarTransform) => void;
  onCameraChanged: (changed: boolean) => void;
  onMissingDependencies: (
    dependencies: ContentPreviewMissingDependency[],
  ) => void;
  onDependenciesLoadingChange: (loading: boolean) => void;
  onSceneVFXChange?: (entry: SceneVFXRuntimeEntry | null) => void;
  onStatusChange: (status: ContentPreviewLoadStatus, message?: string) => void;
};

type PreviewActorRuntimeProps = PreviewActorProps & {
  onSceneVFXChange: (entry: SceneVFXRuntimeEntry | null) => void;
};

// The preview canvas renders outside the i18next React context, so its text
// comes from the active locale when it is produced.
function errorMessage(error: unknown): string {
  const t = getI18n().getFixedT(null, "actionEditor");
  return failureLine(error, t("preview.errors.playFailed"));
}

function PreviewActor({
  active,
  avatarTransform,
  avatarEntry,
  catalog,
  loop,
  playRequest,
  preparationRequest,
  stopRequest,
  target,
  moveAvatar,
  onAvatarChange,
  onAvatarTransformChange,
  onMissingDependencies,
  onDependenciesLoadingChange,
  onSceneVFXChange,
  onStatusChange,
}: PreviewActorRuntimeProps) {
  const { camera, gl } = useThree();
  // ContentPreviewScene keys this actor by model revision. Later preparations
  // with that revision reuse its Avatar; only a failed load is started again,
  // so one Avatar never runs two loads at once.
  const avatarEntryRef = useRef(avatarEntry);
  const avatarLoadRef = useRef<"loading" | "ready" | "failed">("loading");
  const [avatarLoadAttempt, setAvatarLoadAttempt] = useState(0);
  const avatarRef = useRef<Avatar | null>(null);
  // Between previews an idle Avatar lets the dock render at 30 fps.
  const frameDemand = useSceneFrameDemand();
  // The current instance as state, so loading follows a re-created Avatar
  // (any change to the creation effect's inputs) instead of leaving it
  // unloaded.
  const [avatarInstance, setAvatarInstance] = useState<Avatar | null>(null);
  const loadGenerationRef = useRef(0);
  const handledPlayRequestRef = useRef(0);
  // Stop and deactivation end the current play: a preparation still in flight
  // then neither starts playback nor reports its failure over the host's
  // "ready".
  const playTokenRef = useRef(0);
  const firstMotionFrameRef = useRef(false);
  const [sceneObject, setSceneObject] = useState<Object3D | null>(null);
  const [avatarRoot, setAvatarRoot] = useState<Group | null>(null);
  const [avatarReadyKey, setAvatarReadyKey] = useState<string | null>(null);
  const applySoundPlayer = useMemo(
    () => new ContentPreviewApplySoundPlayer(),
    [],
  );
  const clipEventBridge = useMemo(
    () =>
      createContentPreviewClipEventBridge({
        catalog,
        onSceneVFXChange,
        playSfx: (runtimeId, signal) =>
          applySoundPlayer.play(catalog, runtimeId, signal),
      }),
    [applySoundPlayer, catalog, onSceneVFXChange],
  );
  const avatarSourceKey = avatarEntry.content_revision;
  const avatarItemId = runtimeAvatarItemId(avatarEntry);
  const { springMode, springModeRef, materialMode } =
    useAvatarLoadSettings(avatarItemId);
  useStagePortraitRetake({
    avatarRef,
    // At rest: the Avatar preview itself, never an Action playing on it.
    ready:
      active &&
      target.kind === "avatar_model" &&
      avatarReadyKey === avatarSourceKey,
    shown: avatarItemId
      ? { item_id: avatarItemId, revision_sha256: avatarSourceKey }
      : null,
    retake:
      target.kind === "avatar_model" ? (target.portraitRetake ?? null) : null,
  });

  useEffect(() => {
    const releaseAvatar = acquireContentPreviewResource("dock", "avatar");
    const avatar = new AvatarRuntime(camera, gl.domElement, {
      motionCatalog: catalog,
      mediaCatalog: catalog,
    });
    avatar.setAutomaticAnimationPlaybackEnabled(false);
    avatarRef.current = avatar;
    setAvatarInstance(avatar);
    onAvatarChange(avatar);
    return () => {
      avatarRef.current = null;
      setAvatarInstance(null);
      onAvatarChange(null);
      unregisterPreviewDockAvatar(avatar);
      avatar.dispose();
      releaseAvatar();
    };
  }, [camera, catalog, gl.domElement, onAvatarChange]);

  useEffect(() => {
    if (!avatarInstance) return;
    return attachContentPreviewClipEventBridge(avatarInstance, clipEventBridge);
  }, [avatarInstance, clipEventBridge]);

  useEffect(() => {
    avatarEntryRef.current = avatarEntry;
  }, [avatarEntry]);

  useEffect(() => {
    avatarInstance?.setSpringMode(springMode);
  }, [avatarInstance, springMode]);

  useEffect(() => {
    const t = getI18n().getFixedT(null, "actionEditor");
    const avatar = avatarInstance;
    // Materials are built at load; wait for the Avatar's setting.
    if (!avatar || !materialMode) return;
    const entry = avatarEntryRef.current;
    const logicalUrl = runtimeContentEntryUrl(entry);
    if (!logicalUrl) {
      avatarLoadRef.current = "failed";
      onStatusChange("error", t("preview.errors.avatarNoFile"));
      return;
    }
    const generation = ++loadGenerationRef.current;
    const controller = new AbortController();
    avatarLoadRef.current = "loading";
    // Diagnostics reads the dock's Avatar only once this load has finished.
    unregisterPreviewDockAvatar(avatar);
    setSceneObject(null);
    setAvatarReadyKey(null);
    onStatusChange("loading", t("preview.loadingAvatar"));
    void (async () => {
      let download: RuntimeContentUrlLease | null = null;
      try {
        download = await runtimeContentDownloadUrl(entry, logicalUrl, {
          signal: controller.signal,
        });
        if (!download)
          throw new WordedError(t("preview.errors.avatarUnauthorized"));
        controller.signal.throwIfAborted();
        await avatar.load({
          filePath: download.url,
          sourceUrl: logicalUrl,
          sourceKey: avatarSourceKey,
          // The saved face part correction, so parts match the chat's.
          ...resolveRuntimeAvatarFaceParts(entry),
          springMode: springModeRef.current,
          materialMode,
        });
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          avatar.isDisposed ||
          !avatar.scene
        ) {
          return;
        }
        avatar.setAutomaticAnimationPlaybackEnabled(false);
        registerPreviewDockAvatar(avatar, runtimeAvatarItemId(entry));
        avatarLoadRef.current = "ready";
        setSceneObject(avatar.scene);
        setAvatarReadyKey(avatarSourceKey);
        logContentPreviewLifecycle("avatar_load", "dock");
        onStatusChange("ready");
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        )
          return;
        avatarLoadRef.current = "failed";
        onStatusChange("error", errorMessage(error));
      } finally {
        download?.release();
      }
    })();
    return () => controller.abort();
  }, [
    avatarInstance,
    avatarLoadAttempt,
    avatarSourceKey,
    materialMode,
    onStatusChange,
    springModeRef,
  ]);

  useEffect(() => {
    // Each new preparation, including Retry, either reuses the loaded model or
    // retries a failed load. Reporting ready clears the host's loading state
    // even when no autoplay request follows.
    if (avatarLoadRef.current === "failed") {
      setAvatarLoadAttempt((current) => current + 1);
    } else if (avatarLoadRef.current === "ready") {
      logContentPreviewLifecycle("avatar_reuse", "dock");
      onStatusChange("ready");
    }
  }, [onStatusChange, preparationRequest]);

  useEffect(() => {
    if (avatarRoot) applyAvatarTransformToObject(avatarRoot, avatarTransform);
  }, [avatarRoot, avatarTransform]);

  useEffect(() => {
    const avatar = avatarRef.current;
    playTokenRef.current += 1;
    clipEventBridge.reset();
    avatar?.resetAnimations();
    clearContentPreviewEffects({
      avatar,
      onSceneVFXChange,
      stopApplySound: applySoundPlayer.stop,
    });
    if (avatar?.vrm) avatar.vrm.update(0);
  }, [applySoundPlayer, clipEventBridge, onSceneVFXChange, stopRequest]);

  useEffect(() => {
    if (active) return;
    playTokenRef.current += 1;
    const avatar = avatarRef.current;
    clipEventBridge.reset();
    avatar?.resetAnimations();
    clearContentPreviewEffects({
      avatar,
      onSceneVFXChange,
      stopApplySound: applySoundPlayer.stop,
    });
  }, [active, applySoundPlayer, clipEventBridge, onSceneVFXChange]);

  useEffect(() => () => applySoundPlayer.stop(), [applySoundPlayer]);

  useEffect(() => {
    const t = getI18n().getFixedT(null, "actionEditor");
    const avatar = avatarRef.current;
    if (
      !active ||
      !avatar ||
      !avatar.isReady ||
      avatarReadyKey !== avatarSourceKey ||
      playRequest < 1 ||
      handledPlayRequestRef.current === playRequest
    ) {
      return;
    }
    const effectCommand = contentPreviewEffectCommand(target);
    if (
      !effectCommand &&
      target.kind !== "avatar_model" &&
      target.kind !== "animation" &&
      target.kind !== "anima_pose_clip"
    )
      return;
    handledPlayRequestRef.current = playRequest;
    let cancelled = false;
    const token = ++playTokenRef.current;
    const isCurrent = () => !cancelled && playTokenRef.current === token;
    clipEventBridge.reset();
    avatar.resetAnimations();
    clearContentPreviewEffects({
      avatar,
      onSceneVFXChange,
      stopApplySound: applySoundPlayer.stop,
    });
    void (async () => {
      try {
        if (effectCommand) {
          onStatusChange("playing");
          await playContentPreviewEffect({
            avatar,
            catalog,
            command: effectCommand,
            onSceneVFXChange,
            isCurrent,
            playApplySound: (runtimeId) =>
              applySoundPlayer.play(catalog, runtimeId),
            stopApplySound: applySoundPlayer.stop,
          });
          return;
        }
        if (target.kind === "avatar_model") {
          onStatusChange("ready");
          return;
        }
        onStatusChange("loading", t("preview.preparingPlayback"));
        const didPlay = await playContentPreviewMotion({
          avatar,
          catalog,
          target,
          loop,
          isCurrent,
          onFinished: () => onStatusChange("ready"),
          onMissingDependencies,
          onDependenciesLoadingChange,
        });
        if (isCurrent() && didPlay) {
          // Flush the zero-time expression overlay before the immediate
          // Playing render exposes its observation snapshot.
          avatar.update(0);
          // R3F's next delta began before asynchronous preparation finished.
          // Render the opening pose once before charging playback any time.
          firstMotionFrameRef.current = true;
          onStatusChange("playing");
        }
      } catch (error) {
        if (isCurrent()) onStatusChange("error", errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
      onDependenciesLoadingChange(false);
    };
  }, [
    active,
    applySoundPlayer,
    avatarReadyKey,
    avatarSourceKey,
    catalog,
    clipEventBridge,
    loop,
    onDependenciesLoadingChange,
    onMissingDependencies,
    onSceneVFXChange,
    onStatusChange,
    playRequest,
    target,
  ]);

  useFrame((_state, delta) => {
    if (active) {
      const playbackDelta = boundedContentPreviewFrameDelta(
        delta,
        firstMotionFrameRef.current,
      );
      firstMotionFrameRef.current = false;
      avatarRef.current?.update(playbackDelta);
    }
    if (frameDemand) {
      const avatar = avatarRef.current;
      frameDemand.avatarIdle = Boolean(
        avatar?.isReady && !avatar.isMotionActive(),
      );
    }
  });

  return sceneObject ? (
    <>
      {/* Preserve Avatar.load()'s VRM0 orientation on the child model. */}
      <group ref={setAvatarRoot}>
        <primitive object={sceneObject} dispose={null} />
      </group>
      {moveAvatar && avatarRoot ? (
        <TransformControls
          enabled
          mode="translate"
          object={avatarRoot}
          onObjectChange={() =>
            onAvatarTransformChange(avatarTransformFromObject(avatarRoot))
          }
          showX
          showY
          showZ
          size={0.75}
          space="world"
        />
      ) : null}
    </>
  ) : null;
}

export function ContentPreviewScene(props: PreviewActorProps) {
  const { onAvatarChange, onSceneVFXChange } = props;
  const [activeAvatar, setActiveAvatar] = useState<Avatar | null>(null);
  const [sceneVFX, setSceneVFX] = useState<SceneVFXRuntimeEntry | null>(null);
  const handleAvatarChange = useCallback(
    (avatar: Avatar | null) => {
      setActiveAvatar(avatar);
      onAvatarChange(avatar);
    },
    [onAvatarChange],
  );
  const handleSceneVFXChange = useCallback(
    (entry: SceneVFXRuntimeEntry | null) => {
      setSceneVFX(entry);
      onSceneVFXChange?.(entry);
    },
    [onSceneVFXChange],
  );

  useEffect(() => {
    if (!sceneVFX?.expiresAtMs) return;
    const delayMs = Math.max(0, sceneVFX.expiresAtMs - Date.now());
    const timeoutId = window.setTimeout(
      () => handleSceneVFXChange(null),
      delayMs,
    );
    return () => window.clearTimeout(timeoutId);
  }, [handleSceneVFXChange, sceneVFX]);

  return (
    <AvatarPreviewSurface
      active={props.active}
      activeAvatar={activeAvatar}
      cameraProfile={
        props.target.kind === "particle_vfx" ? "custom" : "full-body"
      }
      cameraSettings={
        props.target.kind === "particle_vfx"
          ? PARTICLE_PREVIEW_CAMERA
          : undefined
      }
      canvasTestId="content-preview-canvas"
      lifecycleOwner="dock"
      minDistance={1.2}
      maxDistance={5}
      onCameraChanged={props.onCameraChanged}
      resetCameraRequest={props.resetCameraRequest}
      sceneVFX={sceneVFX}
    >
      {/* A different model mounts a fresh Avatar; the Canvas stays. */}
      <PreviewActor
        key={props.avatarEntry.content_revision}
        {...props}
        onAvatarChange={handleAvatarChange}
        onSceneVFXChange={handleSceneVFXChange}
      />
    </AvatarPreviewSurface>
  );
}
