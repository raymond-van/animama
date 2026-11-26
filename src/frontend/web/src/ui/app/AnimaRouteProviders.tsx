import { useProductApiClient } from "@animama/product-ui";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { getI18n } from "react-i18next";

import type { PyAnimaRuntime } from "@/lib/content/catalogTypes";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { claimCreationRuntime } from "@/lib/runtime-content/creationRuntimeHandoff";
import { AnimaRuntimeCatalog } from "@/lib/runtime-content/AnimaRuntimeCatalog";
import {
  RuntimeMountPreparer,
  type PreparedRuntimeMount,
  type RuntimeContentMountDiagnostic,
  type RuntimePlaybackStatus,
  type RuntimePreparationProgress,
  type RuntimePreparationSession,
} from "@/lib/runtime-content/RuntimeMountPreparer";
import { adaptRuntimeSnapshot } from "@/lib/runtime-content/runtimeSnapshotAdapter";
import { createRuntimePreparationTimings } from "@/lib/runtime-content/runtimePreparationTimings";
import { resolveMountedPocketVoice } from "@/lib/runtime-content/mountedPocketVoice";
import type { MountedPocketVoice } from "@/lib/speech/pocket/anima-voice-selection";
import type { AnimaRuntimeCatalogSnapshot } from "@/lib/runtime-content/types";
import {
  renewAnimaRuntimeCatalog,
  useAnimaRuntimeCatalog,
} from "@/query/hooks/useAnimaRuntimeCatalog";
import { useOptionalSoundContext } from "@/ui/sound/SoundProvider";

type AnimaRouteProvidersProps = {
  children: ReactNode;
};

type MountedPlaybackStatus = RuntimePlaybackStatus | "idle";
type AvatarVisualStatus = "loading" | "visible" | "unavailable";
const ignoreVisualStatus = () => undefined;

/** Diagnostics this provider adds itself, worded in the active UI Locale when they occur. */
function preparationDiagnostic(
  code: "avatar_pose_unavailable" | "runtime_preparation_failed",
): string {
  const t = getI18n().getFixedT(null, "app");
  switch (code) {
    case "avatar_pose_unavailable":
      return t("runtime.avatarPoseUnavailable");
    case "runtime_preparation_failed":
      return t("runtime.preparationFailed");
  }
}

type MountedRuntimeContent = {
  /** The Anima this route mounted, so a change to another Anima leaves it. */
  animaId: string | null;
  data: AnimaRuntimeCatalogSnapshot | null;
  catalog: AnimaRuntimeCatalog | null;
  pocketVoice: MountedPocketVoice | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  runtimeRevision: string | null;
  canChat: boolean;
  playbackStatus: MountedPlaybackStatus;
  avatarVisualStatus: AvatarVisualStatus;
  finishAvatarPreparation: (
    status: Exclude<AvatarVisualStatus, "loading">,
  ) => void;
  preparationProgress: RuntimePreparationProgress | null;
  diagnostics: readonly RuntimeContentMountDiagnostic[];
  remountLatest: () => Promise<AnimaRuntimeCatalogSnapshot | null>;
};

type MountRequest = {
  owner: string;
  animaId: string;
  typed: PyAnimaRuntime;
  nonce: number;
};

type PreparedState = {
  owner: string | null;
  animaId: string | null;
  typed: PyAnimaRuntime | null;
  mount: PreparedRuntimeMount | null;
  data: AnimaRuntimeCatalogSnapshot | null;
  catalog: AnimaRuntimeCatalog | null;
  playbackStatus: MountedPlaybackStatus;
  avatarVisualStatus: AvatarVisualStatus;
  finishAvatarPreparation: (
    status: Exclude<AvatarVisualStatus, "loading">,
  ) => void;
  progress: RuntimePreparationProgress | null;
  diagnostics: readonly RuntimeContentMountDiagnostic[];
  preparationError: unknown;
};

const EMPTY_STATE: PreparedState = {
  owner: null,
  animaId: null,
  typed: null,
  mount: null,
  data: null,
  catalog: null,
  playbackStatus: "idle",
  avatarVisualStatus: "loading",
  finishAvatarPreparation: ignoreVisualStatus,
  progress: null,
  diagnostics: [],
  preparationError: null,
};

const MountedRuntimeContentContext =
  createContext<MountedRuntimeContent | null>(null);

export function AnimaRouteProviders({ children }: AnimaRouteProvidersProps) {
  const apiClient = useProductApiClient();

  const owner = useRuntimeCacheKey();
  const params = useParams({ strict: false });
  const animaId = typeof params?.animaId === "string" ? params.animaId : null;
  const {
    data: queryData,
    error: queryError,
    isError: queryIsError,
    isPending: queryIsPending,
    refetch,
  } = useAnimaRuntimeCatalog(animaId);
  const sound = useOptionalSoundContext();
  const mountRuntimeAudioCatalog = sound?.mountRuntimeAudioCatalog;
  const nextNonce = useRef(1);
  const [request, setRequest] = useState<MountRequest | null>(null);
  const [prepared, setPrepared] = useState<PreparedState>(EMPTY_STATE);

  // A background query refresh must never hot-swap a mounted conversation.
  // Only seed a request for a newly entered route; remountLatest replaces it
  // explicitly with a fresh nonce.
  useEffect(() => {
    if (!owner || !animaId) {
      setRequest(null);
      return;
    }
    if (!queryData) return;
    setRequest((current) =>
      current?.owner === owner && current.animaId === animaId
        ? current
        : { owner, animaId, typed: queryData, nonce: nextNonce.current++ },
    );
  }, [owner, animaId, queryData]);

  useEffect(() => {
    if (!request || request.owner !== owner || request.animaId !== animaId)
      return;
    const controller = new AbortController();
    let active = true;
    let ownedMount: PreparedRuntimeMount | null = null;
    let ownedCatalog: AnimaRuntimeCatalog | null = null;
    let session: RuntimePreparationSession | null = null;
    let unsubscribe: (() => void) | undefined;
    const timings = createRuntimePreparationTimings();
    timings.mark("manifest-ready");
    const handoff = owner
      ? claimCreationRuntime(
          owner,
          request.animaId,
          request.typed.effective_revision,
        )
      : null;
    setPrepared({
      owner: request.owner,
      animaId: request.animaId,
      typed: request.typed,
      mount: null,
      data: null,
      catalog: null,
      playbackStatus: "preparing",
      avatarVisualStatus: "loading",
      finishAvatarPreparation: ignoreVisualStatus,
      progress: null,
      diagnostics: [],
      preparationError: null,
    });

    const preparation = Promise.resolve().then(() => {
      if (!active)
        throw new DOMException("Runtime preparation cancelled.", "AbortError");
      if (handoff) return handoff.mount;
      session = new RuntimeMountPreparer().start(request.typed, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!active || ownedCatalog) return;
          setPrepared((current) =>
            current.owner === request.owner &&
            current.animaId === request.animaId &&
            current.typed?.effective_revision ===
              request.typed.effective_revision
              ? { ...current, progress }
              : current,
          );
        },
      });
      void session.idleReady.then(
        () => {
          if (active) timings.milestone("idle-ready");
        },
        () => undefined,
      );
      void session.settled.then(
        () => {
          if (!active) return;
          timings.mark("optional-settled");
          timings.milestone("settled");
        },
        () => undefined,
      );
      return session.essentialReady;
    });
    void preparation
      .then((mount) => {
        if (!active) {
          if (!handoff) mount.dispose();
          return;
        }
        timings.mark("essential-bytes-ready");
        if (handoff) {
          // A handed-off mount is already fully prepared.
          timings.mark("optional-settled");
          timings.milestone("idle-ready");
          timings.milestone("settled");
        }
        let data = adaptRuntimeSnapshot(mount.data);
        let projected = mount.data;
        const catalog = new AnimaRuntimeCatalog(
          data,
          session
            ? {
                preparation: {
                  issued: adaptRuntimeSnapshot(request.typed),
                  getRootReadiness: session.getRootReadiness,
                  isPreparing: () => mount.playbackStatus === "preparing",
                },
              }
            : {},
        );
        if (!handoff) ownedMount = mount;
        ownedCatalog = catalog;
        let visualStatus: AvatarVisualStatus = data.avatar_model
          ? "loading"
          : "unavailable";
        const finishAvatarPreparation = (
          status: Exclude<AvatarVisualStatus, "loading">,
        ) => {
          if (!active || visualStatus !== "loading") return;
          visualStatus = status;
          if (status === "visible") {
            timings.mark("first-posed-frame");
            timings.milestone("first-frame");
          }
          session?.startOptional();
          update();
        };
        const update = () => {
          if (!active) return;
          if (projected !== mount.data) {
            projected = mount.data;
            data = adaptRuntimeSnapshot(projected, data);
          }
          catalog.admitPrepared(data);
          const visualFailure =
            visualStatus === "unavailable" && mount.data.avatar != null;
          setPrepared({
            owner: request.owner,
            animaId: request.animaId,
            typed: request.typed,
            mount,
            data,
            catalog,
            playbackStatus: visualFailure ? "degraded" : mount.playbackStatus,
            avatarVisualStatus: visualStatus,
            finishAvatarPreparation,
            progress: mount.progress,
            diagnostics: visualFailure
              ? [
                  ...mount.diagnostics,
                  {
                    code: "avatar_pose_unavailable",
                    message: preparationDiagnostic("avatar_pose_unavailable"),
                  },
                ]
              : mount.diagnostics,
            preparationError: null,
          });
        };
        unsubscribe = session?.subscribe(update);
        update();
        if (!data.avatar_model) session?.startOptional();
      })
      .catch((error: unknown) => {
        if (
          !active ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setPrepared({
          owner: request.owner,
          animaId: request.animaId,
          typed: request.typed,
          mount: null,
          data: null,
          catalog: null,
          playbackStatus: "degraded",
          avatarVisualStatus: "unavailable",
          finishAvatarPreparation: ignoreVisualStatus,
          progress: null,
          diagnostics: [
            {
              code: "runtime_preparation_failed",
              message:
                error instanceof Error
                  ? error.message
                  : preparationDiagnostic("runtime_preparation_failed"),
            },
          ],
          preparationError: error,
        });
      });

    return () => {
      active = false;
      unsubscribe?.();
      controller.abort();
      ownedCatalog?.dispose();
      if (session) void session.dispose();
      else ownedMount?.dispose();
      handoff?.release();
      timings.dispose();
    };
  }, [owner, animaId, request]);

  const visible =
    prepared.owner === owner && prepared.animaId === animaId
      ? prepared
      : EMPTY_STATE;
  useEffect(() => {
    if (!animaId || !visible.catalog || !mountRuntimeAudioCatalog) return;
    return mountRuntimeAudioCatalog(animaId, visible.catalog);
  }, [animaId, mountRuntimeAudioCatalog, visible.catalog]);
  useEffect(() => {
    const revision = visible.typed?.effective_revision;
    if (!animaId || !revision) return;
    const interval = window.setInterval(
      () => {
        void renewAnimaRuntimeCatalog(apiClient, animaId, revision);
      },
      15 * 60 * 1000,
    );
    return () => window.clearInterval(interval);
  }, [apiClient, animaId, visible.typed?.effective_revision]);

  const remountLatest = useCallback(async () => {
    if (!owner || !animaId) return null;
    const result = await refetch();
    if (!result.data) return null;
    setRequest({
      owner,
      animaId,
      typed: result.data,
      nonce: nextNonce.current++,
    });
    // Preparation is intentionally asynchronous and observable through
    // playbackStatus; callers never receive an unverified catalog.
    return null;
  }, [owner, animaId, refetch]);

  const typed = visible.typed;
  const value = useMemo<MountedRuntimeContent>(
    () => ({
      animaId: animaId ?? null,
      data: visible.data,
      catalog: visible.catalog,
      pocketVoice: resolveMountedPocketVoice(typed, visible.mount),
      isPending: !typed && queryIsPending,
      isError: !typed && queryIsError,
      error: !typed ? queryError : visible.preparationError,
      runtimeRevision: typed?.effective_revision ?? null,
      canChat: Boolean(animaId && typed && typed.can_chat !== false),
      playbackStatus: visible.playbackStatus,
      avatarVisualStatus: visible.avatarVisualStatus,
      finishAvatarPreparation: visible.finishAvatarPreparation,
      preparationProgress: visible.progress,
      diagnostics: visible.diagnostics,
      remountLatest,
    }),
    [
      animaId,
      queryError,
      queryIsError,
      queryIsPending,
      remountLatest,
      typed,
      visible.catalog,
      visible.mount,
      visible.data,
      visible.diagnostics,
      visible.playbackStatus,
      visible.avatarVisualStatus,
      visible.finishAvatarPreparation,
      visible.preparationError,
      visible.progress,
    ],
  );
  return (
    <MountedRuntimeContentContext.Provider value={value}>
      {children}
    </MountedRuntimeContentContext.Provider>
  );
}

/** Return the immutable runtime revision mounted for the active chat route. */
export function useMountedAnimaRuntimeContent(): MountedRuntimeContent {
  const value = useContext(MountedRuntimeContentContext);
  if (!value) {
    throw new Error(
      "useMountedAnimaRuntimeContent must be used inside AnimaRouteProviders",
    );
  }
  return value;
}

/** Return the mounted runtime revision when rendered within an Anima route. */
export function useOptionalMountedAnimaRuntimeContent(): MountedRuntimeContent | null {
  return useContext(MountedRuntimeContentContext);
}
