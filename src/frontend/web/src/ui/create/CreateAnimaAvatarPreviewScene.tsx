"use client";

import { Camera, ChevronDown, ChevronRight, Shuffle, X } from "lucide-react";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { toast } from "sonner";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Object3D, PerspectiveCamera, Scene, WebGLRenderer } from "three";

import { Avatar } from "@/lib/avatar";
import { BUILT_IN_AVATAR_MOTION_CATALOG } from "@/lib/avatar/motion/AvatarMotionCatalog";
import { EMPTY_RUNTIME_MEDIA_PROVIDER } from "@/lib/runtime-content/AnimaRuntimeMediaCatalog";
import {
  getManifestAnimationInventory,
  normalizeLoopType,
  resolveAnimationUrl,
  type ManifestAnimationInventoryItem,
} from "@/lib/avatar/animationManifest";
import {
  buildAvatarExpressionDraftKey,
  clampAvatarExpressionValue,
  formatAvatarExpressionValue,
  readAvailableAvatarExpressions,
  readAvatarExpressionOverrideValue,
  readAvatarExpressionValue,
} from "@/lib/avatar/expressionUtils";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import { CONTINUOUS_CANVAS_RESIZE } from "@/ui/main/canvas/canvasResizeOptions";
import {
  DEFAULT_SCENE_CAMERA,
  DEFAULT_SCENE_LIGHTS,
  DEFAULT_SCENE_ORBIT_TARGET,
} from "@/ui/main/canvas/sceneCameraPresets";
import { useFormatters } from "@animama/product-ui/i18n";
import { AvatarShaderRendering } from "@/lib/avatar/toon-shader/AvatarShaderRendering";

type PreviewStatus = "idle" | "loading" | "ready" | "error";

type PreviewAvatarActorProps = {
  file: File;
  setStatus: Dispatch<SetStateAction<PreviewStatus>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setAvatarRuntime: Dispatch<SetStateAction<Avatar | null>>;
  setPortraitCaptureContext: Dispatch<
    SetStateAction<PortraitCaptureContext | null>
  >;
};

type PortraitCaptureContext = {
  avatar: Avatar;
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  scene: Scene;
};

const PREVIEW_MANIFEST_ANIMATIONS = getManifestAnimationInventory().filter(
  (entry) => !entry.disabled && entry.type === "vrma",
);

function toAnimationBlendMode(
  value: string | null | undefined,
): "normal" | "additive" {
  return value === "additive" ? "additive" : "normal";
}

function pickRandomManifestAnimation(
  entries: ManifestAnimationInventoryItem[],
  previous: ManifestAnimationInventoryItem | null,
): ManifestAnimationInventoryItem | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0] ?? null;

  const previousKey = previous ? `${previous.file}::${previous.name}` : null;
  const candidates = previousKey
    ? entries.filter((entry) => `${entry.file}::${entry.name}` !== previousKey)
    : entries;
  const pool = candidates.length > 0 ? candidates : entries;
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex] ?? null;
}

function PreviewAvatarActor({
  file,
  setStatus,
  setErrorMessage,
  setAvatarRuntime,
  setPortraitCaptureContext,
}: PreviewAvatarActorProps) {
  const logger = useMemo(() => createLogger("CreateAnimaAvatarPreview"), []);
  const { camera, gl, scene } = useThree();
  const avatarRef = useRef<Avatar | null>(null);
  const [sceneObject, setSceneObject] = useState<Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;
    const objectUrl = URL.createObjectURL(file);
    const avatar = new Avatar(camera, gl.domElement, {
      motionCatalog: BUILT_IN_AVATAR_MOTION_CATALOG,
      mediaCatalog: EMPTY_RUNTIME_MEDIA_PROVIDER,
    });
    avatarRef.current = avatar;

    const loadAvatar = async () => {
      try {
        await avatar.load({ filePath: objectUrl });
        if (cancelled || avatar.isDisposed || !avatar.scene) return;
        setSceneObject(avatar.scene);
        setAvatarRuntime(avatar);
        if ("isPerspectiveCamera" in camera && camera.isPerspectiveCamera) {
          setPortraitCaptureContext({
            avatar,
            renderer: gl,
            camera: camera as PerspectiveCamera,
            scene,
          });
        }
        setErrorMessage(null);
        setStatus("ready");
      } catch (error) {
        logger.error("Preview", "Failed to load local VRM preview", {
          fileName: file.name,
          error,
        });
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(
          "The selected file could not be rendered as a VRM avatar.",
        );
      }
    };

    void loadAvatar();

    return () => {
      cancelled = true;
      avatar.dispose();
      avatarRef.current = null;
      setPortraitCaptureContext(null);
      URL.revokeObjectURL(objectUrl);
    };
  }, [
    camera,
    file,
    gl,
    logger,
    scene,
    setAvatarRuntime,
    setErrorMessage,
    setPortraitCaptureContext,
    setStatus,
  ]);

  useFrame((_, delta) => {
    avatarRef.current?.update(delta);
  });

  if (!sceneObject) return null;
  return <primitive object={sceneObject} dispose={null} />;
}

export function CreateAnimaAvatarPreviewScene({ file }: { file: File }) {
  const { fileSize } = useFormatters();
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [avatarRuntime, setAvatarRuntime] = useState<Avatar | null>(null);
  const [portraitCaptureContext, setPortraitCaptureContext] =
    useState<PortraitCaptureContext | null>(null);
  const [portraitPreviewUrl, setPortraitPreviewUrl] = useState<string | null>(
    null,
  );
  const [capturingPortrait, setCapturingPortrait] = useState(false);
  const portraitAbortControllerRef = useRef<AbortController | null>(null);
  const [expressionsOpen, setExpressionsOpen] = useState(false);
  const [expressionDraftValues, setExpressionDraftValues] = useState<
    Record<string, number>
  >({});
  const [applyingAnimation, setApplyingAnimation] = useState(false);
  const [lastAnimationEntry, setLastAnimationEntry] =
    useState<ManifestAnimationInventoryItem | null>(null);

  const expressionScope = avatarRuntime?.scene?.uuid ?? "__preview__";
  const expressionNames = readAvailableAvatarExpressions(avatarRuntime);
  const isAvatarReady = status === "ready" && Boolean(avatarRuntime);

  useEffect(
    () => () => {
      portraitAbortControllerRef.current?.abort();
      if (portraitPreviewUrl) URL.revokeObjectURL(portraitPreviewUrl);
    },
    [portraitPreviewUrl],
  );

  const closePortraitPreview = () => {
    setPortraitPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const handleCapturePortrait = async () => {
    if (!portraitCaptureContext || capturingPortrait) return;
    portraitAbortControllerRef.current?.abort();
    const controller = new AbortController();
    portraitAbortControllerRef.current = controller;
    setCapturingPortrait(true);
    try {
      const { captureAvatarPortrait } = await import("@/lib/avatar/portrait");
      const blob = await captureAvatarPortrait({
        avatar: portraitCaptureContext.avatar,
        renderer: portraitCaptureContext.renderer,
        camera: portraitCaptureContext.camera,
        scene: portraitCaptureContext.scene,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const nextUrl = URL.createObjectURL(blob);
      setPortraitPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const description =
        error instanceof Error ? error.message : String(error);
      toast.error("Failed to capture portrait", { description });
    } finally {
      if (portraitAbortControllerRef.current === controller) {
        portraitAbortControllerRef.current = null;
        setCapturingPortrait(false);
      }
    }
  };

  const getExpressionSliderValue = (expressionName: string): number => {
    const draftKey = buildAvatarExpressionDraftKey(
      expressionScope,
      expressionName,
    );
    const draftValue = expressionDraftValues[draftKey];
    if (typeof draftValue === "number" && Number.isFinite(draftValue)) {
      return clampAvatarExpressionValue(draftValue);
    }
    return readAvatarExpressionValue(avatarRuntime, expressionName);
  };

  const clearExpressionDraft = (expressionName: string) => {
    const draftKey = buildAvatarExpressionDraftKey(
      expressionScope,
      expressionName,
    );
    setExpressionDraftValues((prev) => {
      if (!(draftKey in prev)) return prev;
      const next = { ...prev };
      delete next[draftKey];
      return next;
    });
  };

  const handleExpressionSliderChange = (
    expressionName: string,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!avatarRuntime) return;
    const nextValue = clampAvatarExpressionValue(Number(event.target.value));
    const draftKey = buildAvatarExpressionDraftKey(
      expressionScope,
      expressionName,
    );
    setExpressionDraftValues((prev) => ({
      ...prev,
      [draftKey]: nextValue,
    }));
    avatarRuntime.setExpression(expressionName, nextValue);
  };

  const handleExpressionSliderCommit = (expressionName: string) => {
    clearExpressionDraft(expressionName);
  };

  const handleClearExpressionOverride = (expressionName: string) => {
    if (!avatarRuntime) return;
    avatarRuntime.clearExpressionOverride(expressionName);
    clearExpressionDraft(expressionName);
  };

  const handleClearAllExpressionOverrides = () => {
    if (!avatarRuntime) return;
    avatarRuntime.clearAllExpressionOverrides();
    setExpressionDraftValues((prev) => {
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!key.startsWith(`${expressionScope}::`)) {
          next[key] = value;
        }
      }
      return next;
    });
  };

  const handlePlayRandomAnimation = async () => {
    if (!avatarRuntime || PREVIEW_MANIFEST_ANIMATIONS.length === 0) return;
    const entry = pickRandomManifestAnimation(
      PREVIEW_MANIFEST_ANIMATIONS,
      lastAnimationEntry,
    );
    if (!entry) return;

    const loopType = normalizeLoopType(entry.loop_type);
    const loopCount =
      typeof entry.loop_count === "number" && Number.isFinite(entry.loop_count)
        ? entry.loop_count
        : undefined;
    const timeScale =
      typeof entry.time_scale === "number" && entry.time_scale > 0
        ? entry.time_scale
        : undefined;
    const weight =
      typeof entry.weight === "number" && Number.isFinite(entry.weight)
        ? entry.weight
        : undefined;
    const blendMode = toAnimationBlendMode(entry.blend_mode);

    setApplyingAnimation(true);
    try {
      await avatarRuntime.playAnimationWithName(
        resolveAnimationUrl(entry.file),
        entry.name,
        {
          loopType,
          loopCount,
          timeScale,
          weight,
          blendMode,
          keepExisting: false,
          fadeDuration: 0.25,
        },
      );
      setLastAnimationEntry(entry);
    } catch (error) {
      const description =
        error instanceof Error ? error.message : String(error);
      toast.error("Failed to play preview animation", {
        description,
      });
    } finally {
      setApplyingAnimation(false);
    }
  };

  return (
    <>
      <Canvas
        className="h-full w-full"
        camera={DEFAULT_SCENE_CAMERA}
        gl={{ antialias: true, alpha: true }}
        resize={CONTINUOUS_CANVAS_RESIZE}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
        <ambientLight intensity={DEFAULT_SCENE_LIGHTS.ambientIntensity} />
        {DEFAULT_SCENE_LIGHTS.directional.map((light, index) => (
          <directionalLight
            key={index}
            position={light.position}
            intensity={light.intensity}
          />
        ))}
        <AvatarShaderRendering />
        <Suspense fallback={null}>
          <PreviewAvatarActor
            file={file}
            setStatus={setStatus}
            setErrorMessage={setErrorMessage}
            setAvatarRuntime={setAvatarRuntime}
            setPortraitCaptureContext={setPortraitCaptureContext}
          />
        </Suspense>
        <OrbitControls
          makeDefault
          enablePan={false}
          enableZoom
          minDistance={1.75}
          maxDistance={6}
          target={DEFAULT_SCENE_ORBIT_TARGET}
          enableDamping
          dampingFactor={0.08}
        />
      </Canvas>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 via-black/5 to-transparent px-4 py-3">
        <p className="text-sm font-medium text-white">{file.name}</p>
        <p className="text-xs text-white/80">
          {fileSize(file.size)} • Local preview only
        </p>
      </div>

      <div className="absolute top-3 left-3 z-10 w-[15.5rem] max-w-[calc(100%-7rem)]">
        <div className="border-border/80 bg-background/88 rounded-2xl border p-3 shadow-lg backdrop-blur-sm">
          <div className="space-y-2.5">
            <Button
              type="button"
              size="sm"
              onClick={() => void handlePlayRandomAnimation()}
              disabled={!isAvatarReady || applyingAnimation}
              className={cn("w-full", applyingAnimation && "cursor-progress")}
            >
              <Shuffle className="size-4" />
              {applyingAnimation ? "Testing..." : "Test Animation"}
            </Button>

            {import.meta.env.DEV ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handleCapturePortrait()}
                disabled={!portraitCaptureContext || capturingPortrait}
                className={cn("w-full", capturingPortrait && "cursor-progress")}
              >
                <Camera className="size-4" />
                {capturingPortrait ? "Capturing..." : "Capture portrait"}
              </Button>
            ) : null}

            <div className="border-border/60 bg-background/70 rounded-xl border">
              <button
                type="button"
                onClick={() => setExpressionsOpen((prev) => !prev)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                aria-expanded={expressionsOpen}
              >
                <span className="text-foreground min-w-0 truncate text-sm font-medium">
                  Expressions
                  {expressionNames.length > 0
                    ? ` (${expressionNames.length})`
                    : ""}
                </span>
                {expressionsOpen ? (
                  <ChevronDown className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                )}
              </button>

              {expressionsOpen ? (
                <div className="border-border/60 border-t px-3 py-3">
                  {!avatarRuntime ? (
                    <p className="text-muted-foreground text-xs">
                      No avatar loaded.
                    </p>
                  ) : expressionNames.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      No expressions detected.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={handleClearAllExpressionOverrides}
                          disabled={!isAvatarReady}
                          className="text-2xs h-6 px-1.5"
                        >
                          Clear all
                        </Button>
                      </div>

                      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                        {expressionNames.map((expressionName) => {
                          const currentValue =
                            getExpressionSliderValue(expressionName);
                          const overrideValue =
                            readAvatarExpressionOverrideValue(
                              avatarRuntime,
                              expressionName,
                            );
                          const hasOverride = overrideValue !== null;

                          return (
                            <div
                              key={expressionName}
                              className={cn(
                                "rounded-lg border px-2.5 py-2",
                                hasOverride
                                  ? "border-sky-500/40 bg-sky-500/5"
                                  : "border-border/60 bg-background/50",
                              )}
                            >
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <span
                                  className="text-2xs min-w-0 truncate font-mono"
                                  title={expressionName}
                                >
                                  {expressionName}
                                </span>
                                <div className="flex items-center gap-2">
                                  <span className="text-muted-foreground text-2xs font-mono">
                                    {formatAvatarExpressionValue(currentValue)}
                                  </span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      handleClearExpressionOverride(
                                        expressionName,
                                      )
                                    }
                                    disabled={!hasOverride}
                                    className="text-2xs h-6 px-1.5"
                                  >
                                    Clear
                                  </Button>
                                </div>
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={currentValue}
                                onChange={(event) =>
                                  handleExpressionSliderChange(
                                    expressionName,
                                    event,
                                  )
                                }
                                onPointerUp={() =>
                                  handleExpressionSliderCommit(expressionName)
                                }
                                onBlur={() =>
                                  handleExpressionSliderCommit(expressionName)
                                }
                                className="accent-primary h-3 w-full cursor-pointer"
                                aria-label={`Expression ${expressionName}`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {import.meta.env.DEV && portraitPreviewUrl ? (
        <div className="bg-background/95 absolute inset-4 z-30 flex items-center justify-center rounded-2xl border p-4 shadow-2xl backdrop-blur-sm">
          <div className="relative flex max-h-full max-w-full flex-col items-center gap-2">
            <button
              type="button"
              onClick={closePortraitPreview}
              className="bg-background/90 text-foreground absolute top-2 right-2 z-10 rounded-full border p-1.5 shadow-sm"
              aria-label="Close portrait preview"
            >
              <X className="size-4" />
            </button>
            <img
              src={portraitPreviewUrl}
              alt="Generated Avatar Model portrait preview"
              className="aspect-square max-h-[min(512px,calc(100vh-12rem))] max-w-full rounded-xl object-contain"
            />
            <p className="text-muted-foreground text-xs">
              Development preview · 512 × 512
            </p>
          </div>
        </div>
      ) : null}

      {status === "loading" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[1px]">
          <div className="rounded-full border border-white/20 bg-black/45 px-4 py-2 text-xs font-medium tracking-[0.18em] text-white uppercase">
            Loading Preview
          </div>
        </div>
      ) : null}
      {status === "error" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 px-6 text-center">
          <p className="max-w-xs text-sm font-medium text-white">
            {errorMessage}
          </p>
        </div>
      ) : null}
    </>
  );
}
