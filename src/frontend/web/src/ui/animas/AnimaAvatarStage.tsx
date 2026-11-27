import { useFrame, useThree } from "@react-three/fiber";
import { Camera } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Object3D } from "three";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";

import type {
  AnimaRuntimeCatalogSnapshot,
  RuntimeCatalogEntry,
} from "@/lib/runtime-content/types";
import { Avatar } from "@/lib/avatar";
import {
  contentPreviewEffectCommand,
  ContentPreviewApplySoundPlayer,
  attachContentPreviewClipEventBridge,
  clearContentPreviewEffects,
  createContentPreviewClipEventBridge,
  playContentPreviewEffect,
} from "@/lib/content-preview/effects";
import {
  selectAnimaStageAvatarEntry,
  type PreparedAnimaStagePreview,
} from "@/lib/content-preview/managementPreview";
import {
  contentPreviewPlaybackCommand,
  playContentPreviewMotion,
} from "@/lib/content-preview/playback";
import { PreviewRuntimeCatalogSession } from "@/lib/content-preview/PreviewRuntimeCatalogSession";
import {
  acquireContentPreviewResource,
  logContentPreviewLifecycle,
} from "@/lib/content-preview/lifecycle";
import { resolvePlaybackObservationStatus } from "@/lib/content-preview/playbackObservation";
import type {
  ContentPreviewLoadStatus,
  ContentPreviewTarget,
} from "@/lib/content-preview/types";
import { apiErrorLine, uncodedErrorText } from "@/lib/errors/apiError";
import { createLogger } from "@/lib/logger";
import { AnimaRuntimeCatalog } from "@/lib/runtime-content/AnimaRuntimeCatalog";
import { runtimeContentEntryUrl } from "@/lib/runtime-content/animaRuntimeSnapshot";
import {
  runtimeContentDownloadUrl,
  type RuntimeContentUrlLease,
} from "@/lib/runtime-content/runtimeContentDelivery";
import {
  resolveRuntimeAvatarFaceParts,
  runtimeAvatarItemId,
  runtimeAvatarItemRevision,
} from "@/lib/runtime-content/runtimeAvatarFaceParts";
import type { SceneVFXRuntimeEntry } from "@/lib/scene-vfx/types";
import { cn } from "@/lib/utils";
import { useAvatarLoadSettings } from "@/query/hooks/useAvatarSettings";
import { useAvatarContents } from "@/query/hooks/useAnimaCreation";
import { portraitRetakeTarget } from "@/lib/avatar/portrait/retakeTarget";
import { AvatarPreviewSurface } from "@/ui/avatar-preview/AvatarPreviewSurface";
import { useStagePortraitRetake } from "@/ui/avatar-preview/useStagePortraitRetake";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import { Button } from "@/ui/components/button";
import {
  DEFAULT_SCENE_CAMERA,
  DEFAULT_SCENE_ORBIT_TARGET,
  type SceneCameraSettings,
} from "@/ui/main/canvas/sceneCameraPresets";
import { useSceneFrameDemand } from "@/ui/main/canvas/sceneFramePacing";

type StageStatus = "idle" | "loading" | "ready" | "error";

type StageSource =
  | { kind: "file"; file: File }
  | {
      kind: "url";
      url: string;
      runtimeContentEntry?: RuntimeCatalogEntry | null;
    };

type StageActorProps = {
  source: StageSource;
  runtimeContent?: AnimaAvatarStageProps["runtimeContent"];
  contentPreview?: PreparedAnimaStagePreview | null;
  contentPreviewLoop: boolean;
  contentPreviewPlayRequest: number;
  onContentPreviewStatusChange?: AnimaAvatarStageProps["onContentPreviewStatusChange"];
  onAvatarChange: (avatar: Avatar | null) => void;
  onSceneVFXChange: (entry: SceneVFXRuntimeEntry | null) => void;
  previewModelFailed: boolean;
  temporaryPreviewModel: boolean;
  onTemporaryPreviewModelError: () => void;
  setStatus: Dispatch<SetStateAction<StageStatus>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
};

export type AnimaAvatarStageProps = {
  animaId?: string | null;
  animaName: string;
  avatarUrl?: string | null;
  avatarRuntimeContentEntry?: RuntimeCatalogEntry | null;
  avatarFile?: File | null;
  camera?: {
    position: [number, number, number];
    fov: number;
  };
  orbitTarget?: [number, number, number];
  className?: string;
  backdrop?: ReactNode;
  overlay?: ReactNode;
  runtimeContent?: AnimaRuntimeCatalogSnapshot | null;
  contentPreview?: PreparedAnimaStagePreview | null;
  contentPreviewTarget?: ContentPreviewTarget | null;
  contentPreviewStatus?: ContentPreviewLoadStatus;
  contentPreviewLoop?: boolean;
  contentPreviewPlayRequest?: number;
  onContentPreviewStatusChange?: (
    status: ContentPreviewLoadStatus,
    message?: string,
  ) => void;
  transparent?: boolean;
  showMetadata?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
};

function StageAvatarActor({
  source,
  runtimeContent,
  contentPreview,
  contentPreviewLoop,
  contentPreviewPlayRequest,
  onContentPreviewStatusChange,
  onAvatarChange,
  onSceneVFXChange,
  previewModelFailed,
  temporaryPreviewModel,
  onTemporaryPreviewModelError,
  setStatus,
  setErrorMessage,
}: StageActorProps) {
  const logger = useMemo(() => createLogger("AnimaAvatarStage"), []);
  const { t } = useTranslation("animas");
  // Effects read the latest wording through a ref, so a locale switch never
  // reloads the VRM or interrupts playback.
  const errorText = {
    modelRestored: t("stage.errors.modelRestored"),
    render: t("stage.errors.render"),
    contentPreview: t("stage.errors.contentPreview"),
  };
  const errorTextRef = useRef(errorText);
  useEffect(() => {
    errorTextRef.current = errorText;
  });
  const { camera, gl } = useThree();
  const avatarRef = useRef<Avatar | null>(null);
  const {
    springMode,
    springModeRef,
    windStrength,
    windStrengthRef,
    materialMode,
  } = useAvatarLoadSettings(
    source.kind === "url"
      ? runtimeAvatarItemId(source.runtimeContentEntry)
      : null,
  );
  // An idle Avatar with no preview playing lets the stage render at 30 fps.
  const frameDemand = useSceneFrameDemand();
  const catalogSession = useMemo(() => new PreviewRuntimeCatalogSession(), []);
  const applySoundPlayer = useMemo(
    () => new ContentPreviewApplySoundPlayer(),
    [],
  );
  const clipEventBridge = useMemo(
    () =>
      createContentPreviewClipEventBridge({
        catalog: catalogSession,
        onSceneVFXChange,
        playSfx: (runtimeId, signal) =>
          applySoundPlayer.play(catalogSession, runtimeId, signal),
      }),
    [applySoundPlayer, catalogSession, onSceneVFXChange],
  );
  const playbackGenerationRef = useRef(0);
  const handledPlayRequestRef = useRef(0);
  const temporaryModelErrorRef = useRef(onTemporaryPreviewModelError);
  const completionWatchRef = useRef<{
    generation: number;
    type: "pose_clip" | "reaction_clip";
    runtimeId: string;
  } | null>(null);
  const [sceneObject, setSceneObject] = useState<Object3D | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  // The Anima's own Avatar, at rest, retakes a missing or stale Local
  // portrait (after an upload or Replace VRM), as the Create Anima stage does.
  const shownAvatar =
    source.kind === "url"
      ? runtimeAvatarItemRevision(source.runtimeContentEntry)
      : null;
  const avatarContents = useAvatarContents(Boolean(shownAvatar));
  useStagePortraitRetake({
    avatarRef,
    ready: avatarReady && !contentPreview && !temporaryPreviewModel,
    shown: shownAvatar,
    retake: portraitRetakeTarget(shownAvatar, avatarContents.data ?? []),
  });
  useEffect(() => {
    temporaryModelErrorRef.current = onTemporaryPreviewModelError;
  }, [onTemporaryPreviewModelError]);

  useEffect(() => {
    const runtime = contentPreview?.runtime ?? runtimeContent;
    catalogSession.replace(runtime ? new AnimaRuntimeCatalog(runtime) : null);
  }, [contentPreview?.runtime, catalogSession, runtimeContent]);

  useEffect(() => () => catalogSession.dispose(), [catalogSession]);
  useEffect(() => () => applySoundPlayer.stop(), [applySoundPlayer]);

  useEffect(() => {
    const avatar = avatarRef.current;
    if (!avatar || !avatarReady) return;
    return attachContentPreviewClipEventBridge(avatar, clipEventBridge);
  }, [avatarReady, clipEventBridge]);

  useEffect(() => {
    avatarRef.current?.setSpringMode(springMode);
    avatarRef.current?.setWindStrength(windStrength);
  }, [springMode, windStrength]);

  useEffect(() => {
    // Materials are built at load; wait for the Avatar's setting.
    if (!materialMode) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const releaseAvatar = acquireContentPreviewResource("management", "avatar");
    const loadPath =
      source.kind === "file" ? URL.createObjectURL(source.file) : source.url;
    const avatar = new Avatar(camera, gl.domElement, {
      motionCatalog: catalogSession,
      mediaCatalog: catalogSession,
    });
    avatarRef.current = avatar;
    onAvatarChange(avatar);
    setSceneObject(null);
    setAvatarReady(false);
    setStatus("loading");

    const loadAvatar = async () => {
      let download: RuntimeContentUrlLease | null = null;
      try {
        download =
          source.kind === "url" && source.runtimeContentEntry
            ? await runtimeContentDownloadUrl(
                source.runtimeContentEntry,
                loadPath,
                { signal: controller.signal },
              )
            : null;
        const resolvedLoadPath = download?.url ?? loadPath;
        if (!resolvedLoadPath) {
          throw new Error("avatar_model_download_unavailable");
        }
        controller.signal.throwIfAborted();
        await avatar.load({
          filePath: resolvedLoadPath,
          sourceUrl: loadPath,
          // The saved face part correction, so parts match the chat's.
          ...(source.kind === "url"
            ? resolveRuntimeAvatarFaceParts(source.runtimeContentEntry ?? null)
            : { vrmSha256: null }),
          springMode: springModeRef.current,
          windStrength: windStrengthRef.current,
          materialMode,
        });
        if (cancelled || avatar.isDisposed || !avatar.scene) return;
        setSceneObject(avatar.scene);
        setAvatarReady(true);
        logContentPreviewLifecycle("avatar_load", "management");
        setErrorMessage(null);
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        logger.error("Preview", "Failed to load avatar preview", {
          sourceKind: source.kind,
          error,
        });
        if (temporaryPreviewModel) {
          temporaryModelErrorRef.current();
          onContentPreviewStatusChange?.(
            "error",
            errorTextRef.current.modelRestored,
          );
          return;
        }
        setStatus("error");
        setErrorMessage(errorTextRef.current.render);
      } finally {
        download?.release();
      }
    };

    void loadAvatar();

    return () => {
      cancelled = true;
      controller.abort();
      clearContentPreviewEffects({
        avatar,
        onSceneVFXChange,
        stopApplySound: applySoundPlayer.stop,
      });
      avatar.dispose();
      releaseAvatar();
      avatarRef.current = null;
      onAvatarChange(null);
      setAvatarReady(false);
      if (source.kind === "file") {
        URL.revokeObjectURL(loadPath);
      }
    };
  }, [
    camera,
    applySoundPlayer,
    catalogSession,
    gl,
    logger,
    materialMode,
    onContentPreviewStatusChange,
    onAvatarChange,
    onSceneVFXChange,
    setErrorMessage,
    setStatus,
    source,
    springModeRef,
    windStrengthRef,
    temporaryPreviewModel,
  ]);

  useEffect(() => {
    const avatar = avatarRef.current;
    if (!avatar) return;
    playbackGenerationRef.current += 1;
    completionWatchRef.current = null;
    clipEventBridge.reset();
    avatar.resetAnimations();
    clearContentPreviewEffects({
      avatar,
      onSceneVFXChange,
      stopApplySound: applySoundPlayer.stop,
    });
    avatar.setAutomaticAnimationPlaybackEnabled(!contentPreview);
    if (!contentPreview && avatar.vrm) avatar.vrm.update(0);
  }, [applySoundPlayer, clipEventBridge, contentPreview, onSceneVFXChange]);

  useEffect(() => {
    if (
      contentPreview &&
      avatarRef.current?.isReady &&
      !temporaryPreviewModel
    ) {
      logContentPreviewLifecycle("avatar_reuse", "management");
    }
  }, [contentPreview, temporaryPreviewModel]);

  useEffect(() => {
    const avatar = avatarRef.current;
    if (
      !contentPreview ||
      !avatar ||
      !avatarReady ||
      previewModelFailed ||
      contentPreviewPlayRequest < 1 ||
      handledPlayRequestRef.current === contentPreviewPlayRequest
    ) {
      return;
    }
    handledPlayRequestRef.current = contentPreviewPlayRequest;
    const generation = ++playbackGenerationRef.current;
    const command = contentPreviewPlaybackCommand(contentPreview.target);
    const effectCommand = contentPreviewEffectCommand(contentPreview.target);
    completionWatchRef.current = null;
    clipEventBridge.reset();
    avatar.resetAnimations();
    avatar.setAutomaticAnimationPlaybackEnabled(false);
    onContentPreviewStatusChange?.("playing");
    void (async () => {
      if (effectCommand) {
        await playContentPreviewEffect({
          avatar,
          catalog: catalogSession,
          command: effectCommand,
          onSceneVFXChange,
          isCurrent: () => generation === playbackGenerationRef.current,
          playApplySound: (runtimeId) =>
            applySoundPlayer.play(catalogSession, runtimeId),
          stopApplySound: applySoundPlayer.stop,
        });
        return;
      }
      if (contentPreview.target.kind === "avatar_model") {
        onContentPreviewStatusChange?.("ready");
        return;
      }
      await playContentPreviewMotion({
        avatar,
        catalog: catalogSession,
        target: contentPreview.target,
        loop: contentPreviewLoop,
        isCurrent: () => generation === playbackGenerationRef.current,
        onFinished: () => {
          if (generation !== playbackGenerationRef.current) return;
          avatar.resetAnimations();
          onContentPreviewStatusChange?.("ready");
        },
      });
      if (
        generation === playbackGenerationRef.current &&
        command &&
        (command.type === "pose_clip" || command.type === "reaction_clip")
      ) {
        completionWatchRef.current = {
          generation,
          type: command.type,
          runtimeId: command.runtimeId,
        };
      }
    })().catch((error: unknown) => {
      if (generation !== playbackGenerationRef.current) return;
      // Preview runtime failures are English: primary in English, detail elsewhere.
      onContentPreviewStatusChange?.(
        "error",
        apiErrorLine(
          uncodedErrorText(
            error instanceof Error ? error.message.trim() || null : null,
            errorTextRef.current.contentPreview,
          ),
        ),
      );
    });
    return () => {
      if (generation === playbackGenerationRef.current) {
        playbackGenerationRef.current += 1;
        completionWatchRef.current = null;
      }
    };
  }, [
    applySoundPlayer,
    contentPreview,
    contentPreviewLoop,
    contentPreviewPlayRequest,
    avatarReady,
    catalogSession,
    clipEventBridge,
    onSceneVFXChange,
    onContentPreviewStatusChange,
    previewModelFailed,
  ]);

  useFrame((_, delta) => {
    const avatar = avatarRef.current;
    avatar?.update(delta);
    const watch = completionWatchRef.current;
    if (frameDemand) {
      frameDemand.avatarIdle = Boolean(
        avatar?.isReady && !watch && !avatar.isMotionActive(),
      );
    }
    if (!avatar || !watch) return;
    const active =
      watch.type === "reaction_clip"
        ? avatar.getReactionClipSnapshot().active
        : avatar.getClipSnapshot(watch.runtimeId).playing;
    if (active || watch.generation !== playbackGenerationRef.current) return;
    completionWatchRef.current = null;
    avatar.resetAnimations();
    onContentPreviewStatusChange?.("ready");
  });

  if (!sceneObject) return null;
  return (
    <>
      {/* Preserve Avatar.load()'s VRM0 orientation on the child model. */}
      <group>
        <primitive object={sceneObject} dispose={null} />
      </group>
    </>
  );
}

function AnimaAvatarStageInner({
  animaName,
  avatarUrl = null,
  avatarRuntimeContentEntry = null,
  avatarFile = null,
  camera = DEFAULT_SCENE_CAMERA,
  orbitTarget = DEFAULT_SCENE_ORBIT_TARGET,
  className,
  backdrop,
  overlay,
  runtimeContent = null,
  contentPreview = null,
  contentPreviewTarget = null,
  contentPreviewStatus = "idle",
  contentPreviewLoop = false,
  contentPreviewPlayRequest = 0,
  onContentPreviewStatusChange,
  transparent = false,
  showMetadata = true,
  emptyTitle,
  emptyDescription,
}: AnimaAvatarStageProps) {
  const { t } = useTranslation("animas");
  const noRuntimeFileText = t("stage.errors.noRuntimeFile");
  const noRuntimeFileRef = useRef(noRuntimeFileText);
  useEffect(() => {
    noRuntimeFileRef.current = noRuntimeFileText;
  }, [noRuntimeFileText]);
  const formatters = useFormatters();
  const [activeAvatar, setActiveAvatar] = useState<Avatar | null>(null);
  const [sceneVFX, setSceneVFX] = useState<SceneVFXRuntimeEntry | null>(null);
  const [cameraChanged, setCameraChanged] = useState(false);
  const [resetCameraRequest, setResetCameraRequest] = useState(0);
  const observationTarget = contentPreviewTarget ?? contentPreview?.target;
  const previewModelEntry =
    contentPreview?.target.kind === "avatar_model"
      ? contentPreview.entry
      : null;
  const previewModelKey = previewModelEntry?.content_revision ?? null;
  const [failedPreviewModel, setFailedPreviewModel] = useState<{
    key: string;
    playRequest: number;
  } | null>(null);
  const avatarSelection = selectAnimaStageAvatarEntry({
    saved: avatarRuntimeContentEntry,
    prepared: contentPreview,
    failed: failedPreviewModel,
    playRequest: contentPreviewPlayRequest,
  });
  const temporaryPreviewModel = avatarSelection.temporary;
  const activeRuntimeEntry = avatarSelection.entry;
  const temporaryPreviewModelUrl =
    temporaryPreviewModel && activeRuntimeEntry
      ? runtimeContentEntryUrl(activeRuntimeEntry)
      : null;
  const source = useMemo<StageSource | null>(() => {
    if (
      temporaryPreviewModel &&
      activeRuntimeEntry &&
      temporaryPreviewModelUrl
    ) {
      return {
        kind: "url",
        url: temporaryPreviewModelUrl,
        runtimeContentEntry: activeRuntimeEntry,
      };
    }
    if (avatarFile) {
      return { kind: "file", file: avatarFile };
    }
    if (avatarUrl) {
      return {
        kind: "url",
        url: avatarUrl,
        runtimeContentEntry: avatarRuntimeContentEntry,
      };
    }
    return null;
  }, [
    activeRuntimeEntry,
    avatarFile,
    avatarRuntimeContentEntry,
    avatarUrl,
    temporaryPreviewModel,
    temporaryPreviewModelUrl,
  ]);
  const [status, setStatus] = useState<StageStatus>(
    source ? "loading" : "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const previewLabel =
    source?.kind === "file"
      ? source.file.name
      : t("stage.avatarLabel", { name: animaName });
  const previewMeta =
    source?.kind === "file"
      ? t("stage.localReplacement", {
          size: formatters.fileSize(source.file.size),
        })
      : source
        ? t("stage.savedAvatar")
        : t("stage.noAvatar");
  const cameraSettings = useMemo<SceneCameraSettings>(
    () => ({
      position: {
        x: camera.position[0],
        y: camera.position[1],
        z: camera.position[2],
      },
      orbitTarget: { x: orbitTarget[0], y: orbitTarget[1], z: orbitTarget[2] },
      fov: camera.fov,
    }),
    [camera.fov, camera.position, orbitTarget],
  );

  useEffect(() => {
    setFailedPreviewModel(null);
    setResetCameraRequest((current) => current + 1);
  }, [contentPreview?.entryKey]);

  useEffect(() => {
    if (!contentPreview) setSceneVFX(null);
  }, [contentPreview]);

  useEffect(() => {
    if (!contentPreview) return;
    return acquireContentPreviewResource("management", "catalog");
  }, [contentPreview]);

  const handleTemporaryPreviewModelError = useCallback(() => {
    if (!previewModelKey) return;
    setFailedPreviewModel({
      key: previewModelKey,
      playRequest: contentPreviewPlayRequest,
    });
  }, [contentPreviewPlayRequest, previewModelKey]);

  useEffect(() => {
    if (!temporaryPreviewModel || temporaryPreviewModelUrl) return;
    handleTemporaryPreviewModelError();
    onContentPreviewStatusChange?.("error", noRuntimeFileRef.current);
  }, [
    handleTemporaryPreviewModelError,
    onContentPreviewStatusChange,
    temporaryPreviewModel,
    temporaryPreviewModelUrl,
  ]);

  useEffect(() => {
    if (!sceneVFX?.expiresAtMs) return;
    const timeoutId = window.setTimeout(
      () => setSceneVFX((current) => (current === sceneVFX ? null : current)),
      Math.max(0, sceneVFX.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timeoutId);
  }, [sceneVFX]);

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        transparent ? "bg-transparent" : "bg-background",
        className,
      )}
      aria-label={t("stage.label", { name: animaName })}
      data-playback-surface={
        observationTarget ? "anima-loadout-stage" : undefined
      }
    >
      {observationTarget ? (
        <PlaybackObservationOutput
          active
          avatar={activeAvatar}
          sceneVFX={sceneVFX}
          status={resolvePlaybackObservationStatus({
            active: true,
            status: contentPreviewStatus,
          })}
          surface="anima-loadout-stage"
          target={observationTarget}
        />
      ) : null}
      {backdrop ? (
        <div className="pointer-events-none absolute inset-0 z-0">
          {backdrop}
        </div>
      ) : null}

      {source ? (
        <>
          <AvatarPreviewSurface
            activeAvatar={activeAvatar}
            cameraProfile="custom"
            cameraSettings={cameraSettings}
            canvasTestId="anima-management-canvas"
            className="absolute inset-0 z-10"
            lifecycleOwner="management"
            minDistance={1.75}
            maxDistance={6}
            resetCameraRequest={resetCameraRequest}
            onCameraChanged={setCameraChanged}
            sceneVFX={sceneVFX}
            sceneBackgroundScope="viewport"
          >
            <Suspense fallback={null}>
              <StageAvatarActor
                source={source}
                runtimeContent={runtimeContent}
                contentPreview={contentPreview}
                contentPreviewLoop={contentPreviewLoop}
                contentPreviewPlayRequest={contentPreviewPlayRequest}
                onContentPreviewStatusChange={onContentPreviewStatusChange}
                onAvatarChange={setActiveAvatar}
                onSceneVFXChange={setSceneVFX}
                previewModelFailed={
                  failedPreviewModel?.key === previewModelKey &&
                  failedPreviewModel.playRequest === contentPreviewPlayRequest
                }
                temporaryPreviewModel={temporaryPreviewModel}
                onTemporaryPreviewModelError={handleTemporaryPreviewModelError}
                setStatus={setStatus}
                setErrorMessage={setErrorMessage}
              />
            </Suspense>
          </AvatarPreviewSurface>

          {/* Sits below the page's top-right Stop button for the preview. */}
          {contentPreview && cameraChanged ? (
            <div className="pointer-events-auto absolute top-[4.25rem] right-5 z-40 flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="bg-background/85 min-h-10 gap-1 px-2.5 text-xs shadow-sm backdrop-blur-sm"
                aria-label={t("stage.resetCamera")}
                onClick={() => setResetCameraRequest((current) => current + 1)}
              >
                {t("actions.reset")} <Camera className="size-3.5" />
              </Button>
            </div>
          ) : null}

          {showMetadata ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/60 via-black/5 to-transparent px-4 py-3">
              <p className="text-sm font-medium text-white">{previewLabel}</p>
              <p className="text-xs text-white/80">{previewMeta}</p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="relative z-10 flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.18),transparent_42%),linear-gradient(160deg,rgba(15,23,42,0.15),transparent_58%)] px-6 text-center">
          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium">
              {emptyTitle ?? t("stage.emptyTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {emptyDescription ?? t("stage.emptyDescription")}
            </p>
          </div>
        </div>
      )}

      {source && status === "loading" ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-full border border-white/20 bg-black/45 px-4 py-2 text-xs font-medium text-white">
            {t("stage.loading")}
          </div>
        </div>
      ) : null}

      {source && status === "error" ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/45 px-6 text-center"
          role="alert"
        >
          <p className="max-w-xs text-sm font-medium text-white">
            {errorMessage}
          </p>
        </div>
      ) : null}

      {overlay ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          {overlay}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Owns exactly one interactive VRM lifecycle. A source-key remount ensures the
 * previous Avatar and any local object URL are disposed before replacement.
 */
export function AnimaAvatarStage(props: AnimaAvatarStageProps) {
  const sourceKey = props.avatarFile
    ? `${props.avatarFile.name}:${props.avatarFile.size}:${props.avatarFile.lastModified}`
    : props.avatarUrl || "empty";

  return <AnimaAvatarStageInner key={sourceKey} {...props} />;
}
