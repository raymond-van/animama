"use client";

import {
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronUp,
  Expand,
  LoaderCircle,
  Minimize2,
  Move3D,
  Pause,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { Avatar } from "@/lib/avatar";
import { getAnimaDisplayName } from "@/lib/anima-profile";
import type { ContentPreviewMissingDependency } from "@/lib/content-preview/playback";
import { resolvePlaybackObservationStatus } from "@/lib/content-preview/playbackObservation";
import type { PreparedContentPreview } from "@/lib/content-preview/preparation";
import {
  acquireContentPreviewResource,
  logContentPreviewLifecycle,
} from "@/lib/content-preview/lifecycle";
import { PreviewRuntimeCatalogSession } from "@/lib/content-preview/PreviewRuntimeCatalogSession";
import {
  clampContentPreviewPosition,
  type ContentPreviewPosition,
} from "@/lib/content-preview/state";
import {
  contentPreviewRequiresAnimaContext,
  contentPreviewSupportsLoop,
  type ContentPreviewLoadStatus,
} from "@/lib/content-preview/types";
import { shouldAutoplayContentPreview } from "@/lib/content-preview/playback";
import {
  resolveLibraryPreviewAnimaContextState,
  selectLibraryPreviewAnima,
  withLibraryPreviewAnimaContext,
} from "@/lib/content-preview/targets";
import { AnimaRuntimeCatalog } from "@/lib/runtime-content/AnimaRuntimeCatalog";
import { adaptRuntimeSnapshot } from "@/lib/runtime-content/runtimeSnapshotAdapter";
import type { SceneVFXRuntimeEntry } from "@/lib/scene-vfx/types";
import { cn } from "@/lib/utils";
import { useOptionalAppShell } from "@/ui/app/AppShell";
import { resolveAppShellSidebarLayout } from "@/ui/app/appShellSidebarLayout";
import { RuntimeFeatureGate } from "@/ui/app/RuntimeFeatureGate";
import { useAnimaRuntimeCatalog } from "@/query/hooks/useAnimaRuntimeCatalog";
import { useAnimas } from "@/query/hooks/useAnimas";
import { Button } from "@/ui/components/button";
import { DIALOG_BACKDROP_CLASS_NAME } from "@/ui/components/dialog";
import { Switch } from "@/ui/components/switch";
import { UnavailableAction } from "@/ui/components/unavailable-action";
import { TransformPanel } from "@/ui/main/canvas/TransformPanel";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import {
  areAvatarTransformsEqual,
  cloneAvatarTransform,
  DEFAULT_AVATAR_TRANSFORM,
  type AvatarTransform,
  type TransformAxis,
} from "@/ui/main/canvas/transform-state";
import { ContentPreviewScene } from "./ContentPreviewScene";
import { useContentPreviewDock } from "./ContentPreviewDockProvider";
import { usePreparedContentPreview } from "./usePreparedContentPreview";
import { useSettings } from "@/ui/settings/SettingsProvider";

function statusLabel(status: ContentPreviewLoadStatus): string {
  switch (status) {
    case "loading":
      return "Loading preview";
    case "playing":
      return "Playing";
    case "error":
      return "Preview unavailable";
    case "ready":
      return "Ready";
    default:
      return "Preview";
  }
}

/**
 * Recovery for a preview that needs an Anima: open the creator, or, when the
 * runtime withholds Anima creation, keep the action disabled with its reason.
 */
export function PreviewCreateAnimaAction() {
  return (
    <RuntimeFeatureGate
      capability="anima_creation"
      unavailable={(reason) => (
        <UnavailableAction reason={reason}>
          <Button type="button" size="sm" variant="outline">
            Create Anima
          </Button>
        </UnavailableAction>
      )}
    >
      <Button asChild type="button" size="sm" variant="outline">
        <Link to="/animas/new">Create Anima</Link>
      </Button>
    </RuntimeFeatureGate>
  );
}

type PreviewDragSession = {
  pointerId: number;
  clientX: number;
  clientY: number;
  panelX: number;
  panelY: number;
  offset: ContentPreviewPosition;
};

const PREVIEW_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** One force-mounted visual host; visibility changes never replace its canvas. */
export function ContentPreviewHost() {
  const appShell = useOptionalAppShell();
  const sidebarInset = resolveAppShellSidebarLayout({
    behavior: "inset",
    isDesktop: appShell?.isDesktop === true,
    sidebarOpen: appShell?.sidebarOpen === true,
  })["--app-shell-sidebar-inset"];
  const {
    target,
    view,
    minimize,
    restore,
    toggleExpanded,
    expireSession,
    returnFocusToInvoker,
  } = useContentPreviewDock();
  const active = view === "docked" || view === "expanded";
  const { userSettings, isLoading: settingsLoading } = useSettings();
  const needsAnimaContext = Boolean(
    active &&
    target &&
    !target.animaContext &&
    contentPreviewRequiresAnimaContext(target),
  );
  const animasQuery = useAnimas({ enabled: needsAnimaContext });
  const previewAnima = useMemo(
    () =>
      needsAnimaContext
        ? selectLibraryPreviewAnima(
            animasQuery.data ?? [],
            userSettings?.last_active_anima_id,
          )
        : null,
    [animasQuery.data, needsAnimaContext, userSettings?.last_active_anima_id],
  );
  const runtimeSnapshotQuery = useAnimaRuntimeCatalog(
    needsAnimaContext ? previewAnima?.id : null,
  );
  const runtimeData = useMemo(
    () =>
      runtimeSnapshotQuery.data
        ? adaptRuntimeSnapshot(runtimeSnapshotQuery.data)
        : undefined,
    [runtimeSnapshotQuery.data],
  );
  const runtimeQuery = { ...runtimeSnapshotQuery, data: runtimeData };
  const animaContextState = resolveLibraryPreviewAnimaContextState({
    target,
    active,
    settingsLoading,
    animasPending: animasQuery.isPending,
    animasError: animasQuery.isError,
    previewAnima,
    runtimePending: runtimeQuery.isPending,
    runtimeError: runtimeQuery.isError,
    runtimeAvailable: Boolean(runtimeQuery.data),
  });
  const previewTarget = useMemo(() => {
    if (!target) return null;
    if (animaContextState === "not_required") return target;
    if (animaContextState !== "ready") return null;
    const runtime = runtimeQuery.data;
    if (!previewAnima || !runtime) return null;
    return withLibraryPreviewAnimaContext(target, previewAnima.id, runtime);
  }, [animaContextState, previewAnima, runtimeQuery.data, target]);
  const preparation = usePreparedContentPreview(previewTarget, {
    enabled: active,
    owner: "dock",
  });
  const catalogSession = useMemo(() => new PreviewRuntimeCatalogSession(), []);
  const previewPanelRef = useRef<HTMLElement | null>(null);
  const previousTargetKeyRef = useRef<string | null>(null);
  const activeAvatarRef = useRef<Avatar | null>(null);
  const [activeAvatar, setActiveAvatar] = useState<Avatar | null>(null);
  const [observedSceneVFX, setObservedSceneVFX] =
    useState<SceneVFXRuntimeEntry | null>(null);
  const [status, setStatus] = useState<ContentPreviewLoadStatus>("idle");
  const [observationStopped, setObservationStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playRequest, setPlayRequest] = useState(0);
  const [preparationRequest, setPreparationRequest] = useState(0);
  const [cameraChanged, setCameraChanged] = useState(false);
  const [resetCameraRequest, setResetCameraRequest] = useState(0);
  const [moveAvatar, setMoveAvatar] = useState(false);
  const [avatarTransform, setAvatarTransform] = useState<AvatarTransform>(() =>
    cloneAvatarTransform(DEFAULT_AVATAR_TRANSFORM),
  );
  const [stopRequest, setStopRequest] = useState(0);
  const [loop, setLoop] = useState(false);
  const [missingDependencies, setMissingDependencies] = useState<
    ContentPreviewMissingDependency[]
  >([]);
  const [dependenciesLoading, setDependenciesLoading] = useState(false);
  const [preparedPreview, setPreparedPreview] =
    useState<PreparedContentPreview | null>(null);
  const dragSessionRef = useRef<PreviewDragSession | null>(null);
  const [dockOffset, setDockOffset] = useState<ContentPreviewPosition>({
    x: 0,
    y: 0,
  });
  const [dragging, setDragging] = useState(false);

  const handleStatusChange = useCallback(
    (next: ContentPreviewLoadStatus, message?: string) => {
      setObservationStopped(false);
      setStatus(next);
      setError(next === "error" ? (message ?? "Preview unavailable.") : null);
      if (next === "playing") {
        logContentPreviewLifecycle("first_playable_frame", "dock");
      }
    },
    [],
  );
  const handleAvatarChange = useCallback((avatar: Avatar | null) => {
    activeAvatarRef.current = avatar;
    setActiveAvatar(avatar);
  }, []);
  const handleMissingDependencies = useCallback(
    (dependencies: ContentPreviewMissingDependency[]) => {
      // A failed Anima runtime query cannot distinguish unavailable from
      // unequipped dependencies, so do not mislabel those references.
      setMissingDependencies(runtimeQuery.isError ? [] : dependencies);
    },
    [runtimeQuery.isError],
  );
  const handleAvatarTransformChange = useCallback(
    (nextTransform: AvatarTransform) => {
      setAvatarTransform((current) =>
        areAvatarTransformsEqual(current, nextTransform)
          ? current
          : cloneAvatarTransform(nextTransform),
      );
    },
    [],
  );
  const handlePositionChange = useCallback(
    (axis: TransformAxis, value: number) => {
      setAvatarTransform((current) => {
        const nextTransform = cloneAvatarTransform(current);
        nextTransform.position[axis] = value;
        return areAvatarTransformsEqual(current, nextTransform)
          ? current
          : nextTransform;
      });
    },
    [],
  );

  useEffect(() => {
    if (target) {
      logContentPreviewLifecycle(
        previousTargetKeyRef.current &&
          previousTargetKeyRef.current !== target.key
          ? "target_replacement"
          : "preview_open",
        "dock",
        {
          kind: target.kind,
          slot: target.slot,
          sourceType: target.sourceType,
        },
      );
      previousTargetKeyRef.current = target.key;
    }
    activeAvatarRef.current?.resetAnimations();
    setStopRequest((current) => current + 1);
    setResetCameraRequest((current) => current + 1);
    setLoop(false);
    setMoveAvatar(false);
    setMissingDependencies([]);
    setDependenciesLoading(false);
    setObservedSceneVFX(null);
    setAvatarTransform(cloneAvatarTransform(DEFAULT_AVATAR_TRANSFORM));
    setObservationStopped(false);
    setError(null);
    setStatus(target ? "loading" : "idle");
  }, [target]);

  useEffect(() => {
    if (!active) {
      logContentPreviewLifecycle("hidden_warm", "dock");
      activeAvatarRef.current?.resetAnimations();
      setStopRequest((current) => current + 1);
      if (target) setStatus("ready");
    }
  }, [active, target]);

  useEffect(() => {
    if (view !== "expanded" && view !== "docked") return;

    const handlePointerDown = (event: PointerEvent) => {
      const panel = previewPanelRef.current;
      const elementTarget =
        event.target instanceof Element ? event.target : null;
      if (
        !(event.target instanceof Node) ||
        panel?.contains(event.target) ||
        elementTarget?.closest("[data-content-preview-trigger]")
      ) {
        return;
      }
      if (view === "expanded") {
        toggleExpanded();
      } else {
        minimize();
      }
    };

    // Capture the pointer before higher-stacking app chrome can consume it.
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [minimize, toggleExpanded, view]);

  useEffect(() => {
    const prepared = preparation.prepared;
    if (!prepared) return;
    activeAvatarRef.current?.resetAnimations();
    catalogSession.replace(
      new AnimaRuntimeCatalog(prepared.runtime, {
        // Library clip previews keep pose motion playable while separately
        // reporting exact event dependencies missing from the preview Anima.
        allowMissingClipEventReferences:
          prepared.target.kind === "anima_pose_clip",
      }),
    );
    setMissingDependencies([]);
    setDependenciesLoading(false);
    setPreparedPreview(prepared);
    setPreparationRequest((current) => current + 1);
    setStatus("loading");
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (shouldAutoplayContentPreview(prefersReducedMotion)) {
      setPlayRequest((current) => current + 1);
    }
  }, [catalogSession, preparation.prepared]);

  useEffect(() => {
    if (!preparedPreview) return;
    return acquireContentPreviewResource("dock", "catalog");
  }, [preparedPreview]);

  useEffect(() => {
    logContentPreviewLifecycle("session_create", "dock");
    return () => {
      activeAvatarRef.current?.resetAnimations();
      catalogSession.dispose();
      logContentPreviewLifecycle("final_disposal", "dock", {
        reason: "unmount",
      });
    };
  }, [catalogSession]);

  const previewAnimaName = previewAnima
    ? getAnimaDisplayName(previewAnima)
    : null;
  const animaContextError =
    animaContextState === "animas_unavailable"
      ? "Your Animas could not be loaded for this preview."
      : animaContextState === "anima_required"
        ? "Create an Anima before previewing this content."
        : animaContextState === "runtime_unavailable"
          ? `Could not load ${previewAnimaName ?? "the selected Anima"}'s preview catalog.`
          : null;
  const visibleError = animaContextError ?? preparation.error ?? error;
  const waitingForPrivateEntry =
    animaContextState === "loading" || preparation.isPending;
  const renderablePrepared =
    preparedPreview?.target.key === previewTarget?.key ? preparedPreview : null;
  const canPlay = Boolean(renderablePrepared?.entryKey && !visibleError);
  const minimized = view === "minimized";
  const hidden = view === "hidden";

  const retryPreview = () => {
    if (animasQuery.isError) {
      void animasQuery.refetch();
      return;
    }
    if (runtimeQuery.isError) {
      void runtimeQuery.refetch();
      return;
    }
    void preparation.retry();
  };

  const replay = () => {
    if (!canPlay) return;
    setError(null);
    setMissingDependencies([]);
    setDependenciesLoading(false);
    setObservationStopped(false);
    setPlayRequest((current) => current + 1);
  };
  const stop = () => {
    activeAvatarRef.current?.resetAnimations();
    setStopRequest((current) => current + 1);
    setObservationStopped(true);
    setStatus("ready");
  };

  const keepPanelInViewport = useCallback((deltaX = 0, deltaY = 0) => {
    const panel = previewPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const clamped = clampContentPreviewPosition(
      { x: rect.left + deltaX, y: rect.top + deltaY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    const correctionX = clamped.x - rect.left;
    const correctionY = clamped.y - rect.top;
    if (Math.abs(correctionX) < 0.5 && Math.abs(correctionY) < 0.5) return;
    setDockOffset((current) => ({
      x: current.x + correctionX,
      y: current.y + correctionY,
    }));
  }, []);

  useLayoutEffect(() => {
    if (view === "expanded" || view === "hidden") return;
    keepPanelInViewport();
  }, [keepPanelInViewport, view]);

  useLayoutEffect(() => {
    if (view !== "expanded") return;
    const firstControl = previewPanelRef.current?.querySelector<HTMLElement>(
      PREVIEW_FOCUSABLE_SELECTOR,
    );
    firstControl?.focus();
  }, [view]);

  useLayoutEffect(
    () => () => {
      const panel = previewPanelRef.current;
      const activeElement = document.activeElement;
      if (
        panel &&
        activeElement instanceof HTMLElement &&
        panel.contains(activeElement)
      ) {
        activeElement.blur();
      }
    },
    [],
  );

  useEffect(() => {
    const handleResize = () => {
      if (view !== "expanded" && view !== "hidden") keepPanelInViewport();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [keepPanelInViewport, view]);

  const startDragging = (event: ReactPointerEvent<HTMLElement>) => {
    const interactiveTarget =
      event.target instanceof Element
        ? event.target.closest(
            "button, a, input, select, textarea, [role='button']",
          )
        : null;
    const panel = previewPanelRef.current;
    if (
      view === "expanded" ||
      event.button !== 0 ||
      interactiveTarget ||
      !panel
    ) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    dragSessionRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panelX: rect.left,
      panelY: rect.top,
      offset: dockOffset,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  };

  const dragPreview = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragSessionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const clamped = clampContentPreviewPosition(
      {
        x: drag.panelX + event.clientX - drag.clientX,
        y: drag.panelY + event.clientY - drag.clientY,
      },
      {
        width: previewPanelRef.current?.offsetWidth ?? 0,
        height: previewPanelRef.current?.offsetHeight ?? 0,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setDockOffset({
      x: drag.offset.x + clamped.x - drag.panelX,
      y: drag.offset.y + clamped.y - drag.panelY,
    });
  };

  const stopDragging = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragSessionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragSessionRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const movePreviewWithKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (view === "expanded") return;
    const step = event.shiftKey ? 48 : 16;
    const movement = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    keepPanelInViewport(movement[0], movement[1]);
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (view !== "expanded") return;
    if (event.key === "Escape") {
      event.preventDefault();
      toggleExpanded();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      previewPanelRef.current?.querySelectorAll<HTMLElement>(
        PREVIEW_FOCUSABLE_SELECTOR,
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);
    if (!controls.length) {
      event.preventDefault();
      previewPanelRef.current?.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const destroyPreview = () => {
    expireSession();
    returnFocusToInvoker();
  };

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-[80]",
        hidden && "invisible",
      )}
      aria-hidden={hidden || undefined}
    >
      <div
        className={cn(
          "absolute inset-0 transition-opacity motion-reduce:transition-none",
          DIALOG_BACKDROP_CLASS_NAME,
          view === "expanded"
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
        aria-hidden="true"
      />
      <section
        ref={previewPanelRef}
        role={view === "expanded" ? "dialog" : "complementary"}
        aria-modal={view === "expanded" || undefined}
        aria-labelledby="content-preview-title"
        tabIndex={view === "expanded" ? -1 : undefined}
        onKeyDown={handlePanelKeyDown}
        data-playback-surface={target ? "library-dock" : undefined}
        className={cn(
          "bg-background border-border pointer-events-auto absolute overflow-hidden border shadow-2xl transition-[inset,width,height,border-radius] motion-reduce:transition-none",
          view === "expanded"
            ? "inset-2 rounded-2xl sm:inset-6 md:inset-10 lg:inset-16"
            : minimized
              ? "right-2 bottom-2 h-14 w-[min(24rem,calc(100vw-1rem))] rounded-xl sm:right-4 sm:bottom-4 sm:w-[min(24rem,calc(100vw-2rem))]"
              : "right-2 bottom-2 h-[min(32rem,calc(100dvh-1rem))] w-[min(25rem,calc(100vw-1rem))] rounded-2xl sm:right-4 sm:bottom-4 sm:h-[min(32rem,calc(100dvh-2rem))] sm:w-[min(25rem,calc(100vw-2rem))]",
        )}
        style={
          view === "expanded"
            ? { marginLeft: sidebarInset }
            : {
                transform: `translate3d(${dockOffset.x}px, ${dockOffset.y}px, 0)`,
              }
        }
      >
        {target ? (
          <PlaybackObservationOutput
            active={active}
            avatar={activeAvatar}
            sceneVFX={observedSceneVFX}
            status={resolvePlaybackObservationStatus({
              active,
              status,
              stopped: observationStopped,
              unavailable: Boolean(visibleError && status !== "error"),
            })}
            surface="library-dock"
            target={target}
          />
        ) : null}
        <header
          className={cn(
            "border-border flex h-14 touch-none items-center gap-3 border-b px-3",
            view !== "expanded" &&
              (dragging ? "cursor-grabbing select-none" : "cursor-grab"),
          )}
          tabIndex={view === "expanded" ? -1 : 0}
          aria-label={view === "expanded" ? undefined : "Move content preview"}
          onPointerDown={startDragging}
          onPointerMove={dragPreview}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onKeyDown={movePreviewWithKeyboard}
        >
          <div className="min-w-0 flex-1 text-left">
            <span
              id="content-preview-title"
              className="block truncate text-sm font-semibold"
            >
              {target?.displayName ?? "Content Preview"}
            </span>
          </div>
          {minimized ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-10"
                onClick={restore}
              >
                <ChevronUp className="size-4" />
                <span className="sr-only">Restore preview</span>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-10"
                onClick={destroyPreview}
              >
                <X className="size-4" />
                <span className="sr-only">Destroy preview</span>
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-10"
                onClick={toggleExpanded}
              >
                {view === "expanded" ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Expand className="size-4" />
                )}
                <span className="sr-only">
                  {view === "expanded" ? "Restore dock size" : "Expand preview"}
                </span>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-10"
                onClick={minimize}
              >
                <ChevronDown className="size-4" />
                <span className="sr-only">Minimize preview</span>
              </Button>
            </>
          )}
        </header>

        <div
          className={cn(
            "flex h-[calc(100%-3.5rem)] flex-col",
            minimized && "invisible",
          )}
        >
          <p
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {target
              ? `${target.displayName} preview: ${statusLabel(status)}.`
              : "Content preview closed."}
          </p>
          <div className="bg-muted/30 relative min-h-0 flex-1 overflow-hidden">
            {/* Keep the last prepared scene, its Canvas and its Avatar while a
                replacement prepares or the Dock is minimized; only controls
                wait for the current target. Warm-idle eviction unmounts it. */}
            {preparedPreview ? (
              <ContentPreviewScene
                active={active}
                avatarTransform={avatarTransform}
                avatarEntry={preparedPreview.runtime.avatar_model!}
                catalog={catalogSession}
                loop={loop}
                playRequest={playRequest}
                preparationRequest={preparationRequest}
                resetCameraRequest={resetCameraRequest}
                stopRequest={stopRequest}
                target={preparedPreview.target}
                moveAvatar={moveAvatar}
                onAvatarChange={handleAvatarChange}
                onAvatarTransformChange={handleAvatarTransformChange}
                onCameraChanged={setCameraChanged}
                onMissingDependencies={handleMissingDependencies}
                onDependenciesLoadingChange={setDependenciesLoading}
                onSceneVFXChange={setObservedSceneVFX}
                onStatusChange={handleStatusChange}
              />
            ) : null}
            {renderablePrepared ? (
              <div className="absolute top-2.5 right-2.5 z-30 flex items-center gap-1.5">
                {cameraChanged ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="bg-background/85 min-h-10 gap-1 px-2.5 text-xs shadow-sm backdrop-blur-sm"
                    aria-label="Reset preview camera"
                    onClick={() =>
                      setResetCameraRequest((current) => current + 1)
                    }
                    title="Reset camera"
                  >
                    Reset <Camera className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={moveAvatar ? "default" : "secondary"}
                  className={cn(
                    "min-h-10 gap-1 px-2.5 text-xs shadow-sm backdrop-blur-sm",
                    !moveAvatar && "bg-background/85",
                  )}
                  aria-expanded={moveAvatar}
                  aria-label="Move preview avatar"
                  onClick={() => setMoveAvatar((current) => !current)}
                  title="Move avatar"
                >
                  Move <Move3D className="size-3.5" />
                </Button>
              </div>
            ) : null}
            {renderablePrepared && moveAvatar ? (
              <TransformPanel
                className="top-12 right-2.5 z-30 w-48"
                compact
                mode="translate"
                transform={avatarTransform}
                uniformScaleLocked
                onPositionChange={handlePositionChange}
                onRotationChangeDegrees={() => undefined}
                onScaleChange={() => undefined}
                onUniformScaleLockedChange={() => undefined}
                showShortcut={false}
              />
            ) : null}
            {waitingForPrivateEntry ||
            dependenciesLoading ||
            (status === "loading" && !visibleError) ? (
              <div className="bg-background/70 absolute inset-0 flex items-center justify-center backdrop-blur-[1px]">
                <p
                  className="text-muted-foreground flex items-center gap-2 text-sm"
                  role="status"
                >
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                  {dependenciesLoading
                    ? "Loading included resources…"
                    : "Loading preview…"}
                </p>
              </div>
            ) : null}
            {visibleError ? (
              <div
                className="bg-background/90 absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
                role="alert"
              >
                <p className="text-sm font-medium">Preview unavailable</p>
                <p className="text-muted-foreground max-w-sm text-xs">
                  {visibleError}
                </p>
                {animaContextState === "anima_required" ? (
                  <PreviewCreateAnimaAction />
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={retryPreview}
                  >
                    <RefreshCw className="size-4" /> Retry
                  </Button>
                )}
              </div>
            ) : null}
          </div>

          {missingDependencies.length > 0 ? (
            <aside
              className="border-warning/35 bg-warning/10 flex max-h-40 shrink-0 gap-2 overflow-y-auto border-t p-3 text-xs"
              aria-label="Content preview dependency warning"
            >
              <AlertTriangle
                className="text-warning mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="space-y-1.5" role="status" aria-live="polite">
                  <p className="font-medium">
                    Some included resources could not be loaded
                    {previewAnimaName ? ` for ${previewAnimaName}` : ""}.
                  </p>
                  <ul className="space-y-1">
                    {missingDependencies.map((dependency) => (
                      <li key={`${dependency.kind}:${dependency.runtimeId}`}>
                        {dependency.label}:{" "}
                        <code className="bg-background/70 rounded px-1 py-0.5 break-all">
                          {dependency.runtimeId}
                        </code>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    The clip motion continues without these events. Retry the
                    preview; if this continues, the release may reference an
                    unavailable resource.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-1 min-h-9"
                  onClick={replay}
                >
                  <RefreshCw className="size-4" /> Retry preview
                </Button>
                {previewAnima && target?.sourceType !== "resolved_action" ? (
                  <Button
                    asChild
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-1 ml-2 min-h-9"
                  >
                    <Link
                      to="/animas/$animaId"
                      params={{ animaId: previewAnima.id }}
                      search={{ tab: "loadout" }}
                    >
                      Open {previewAnimaName ?? "Anima"} Loadout
                    </Link>
                  </Button>
                ) : null}
              </div>
            </aside>
          ) : null}

          <footer className="border-border flex min-h-16 flex-wrap items-center gap-2 border-t p-3">
            <Button
              type="button"
              size="sm"
              className="min-h-10"
              onClick={replay}
              disabled={!canPlay}
            >
              <RotateCcw className="size-4" /> Replay
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-10"
              onClick={stop}
              disabled={!canPlay}
            >
              <Pause className="size-4" /> Stop
            </Button>
            {target && contentPreviewSupportsLoop(target) ? (
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Switch
                  checked={loop}
                  onCheckedChange={(checked) => {
                    setLoop(checked);
                    if (canPlay) setPlayRequest((current) => current + 1);
                  }}
                  aria-label="Loop preview"
                />
                Loop
              </label>
            ) : null}
          </footer>
        </div>
      </section>
    </div>
  );
}
