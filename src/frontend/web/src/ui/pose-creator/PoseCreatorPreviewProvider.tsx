import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useReducer,
  type ReactNode,
} from "react";

import type { PyAnimaListItem } from "@/lib/content/catalogTypes";
import { useStrictModeSafeDestroy } from "@/hooks/useStrictModeSafeDestroy";
import { useOptionalSoundController } from "@/hooks/useSoundController";
import { AnimaRuntimeCatalog } from "@/lib/runtime-content/AnimaRuntimeCatalog";
import {
  withActionComponentSandbox,
  withActionRuntimeOverlay,
} from "@/lib/content-preview/actionComponentSandbox";
import type {
  AnimaRuntimeCatalogSnapshot,
  RuntimeCatalogEntry,
} from "@/lib/runtime-content/types";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { useContentCreatorModelPreview } from "@/ui/content-creator/useContentCreatorModelPreview";
import type {
  PoseCreatorModelSource,
  PoseCreatorPreviewAnimaStatus,
} from "./poseCreatorPreview";
import {
  createPoseCreatorEventCatalog,
  type PoseCreatorEventCatalog,
} from "./poseCreatorEventCatalog";

type PoseCreatorPreviewContextValue = {
  previewAnima: PyAnimaListItem | null;
  previewAnimaStatus: PoseCreatorPreviewAnimaStatus;
  runtime: AnimaRuntimeCatalogSnapshot | null;
  catalog: AnimaRuntimeCatalog | null;
  eventCatalog: PoseCreatorEventCatalog;
  modelOptions: PoseCreatorModelSource[];
  selectedModel: PoseCreatorModelSource | null;
  modelEntry: RuntimeCatalogEntry | null;
  modelEntryKey: string | null;
  isAnimaPending: boolean;
  isRuntimePending: boolean;
  isModelCatalogPending: boolean;
  hasMoreModels: boolean;
  isLoadingMoreModels: boolean;
  modelCatalogError: string | null;
  animaError: string | null;
  runtimeError: string | null;
  modelError: string | null;
  selectModel: (source: PoseCreatorModelSource) => void;
  retryAnima: () => Promise<void>;
  retryRuntime: () => Promise<void>;
  retryModels: () => Promise<void>;
  loadMoreModels: () => Promise<void>;
  retrySelectedModel: () => Promise<void>;
};

const PoseCreatorPreviewContext =
  createContext<PoseCreatorPreviewContextValue | null>(null);
const EMPTY_SANDBOX_ENTRIES: readonly RuntimeCatalogEntry[] = [];

export function usePoseCreatorPreview(): PoseCreatorPreviewContextValue {
  const value = useContext(PoseCreatorPreviewContext);
  if (!value) {
    throw new Error(
      "usePoseCreatorPreview must be used inside PoseCreatorPreviewProvider",
    );
  }
  return value;
}

/**
 * Own exactly one immutable Anima catalog and exact preview-model source.
 * Catalog replacement disposes private fetches/Blob URLs and never mutates the
 * selected Anima loadout; Zustand retains only the user's preview choice.
 */
export function PoseCreatorPreviewProvider({
  children,
  runtimeOverlay = null,
  sandboxEntries = EMPTY_SANDBOX_ENTRIES,
  includedAvatars = false,
  ownAvatars = false,
}: {
  children: ReactNode;
  /** Exact unsaved closure mounted only for the active creator preview. */
  runtimeOverlay?: AnimaRuntimeCatalogSnapshot | null;
  /** Exact components resolved as the document changes, not when Play is pressed. */
  sandboxEntries?: readonly RuntimeCatalogEntry[];
  /** Also offer every Included Avatar as a preview model. */
  includedAvatars?: boolean;
  /** Also offer the person's own Avatars as preview models. */
  ownAvatars?: boolean;
}) {
  const selectedModel = usePoseCreatorStore((state) => state.selectedSource);
  const setModelSource = usePoseCreatorStore((state) => state.setModelSource);
  const modelPreview = useContentCreatorModelPreview({
    ownerKey: "pose-creator",
    selectedModel,
    onSelectModel: setModelSource,
    includedAvatars,
    ownAvatars,
  });
  const runtime = useMemo(
    () =>
      withActionComponentSandbox(
        withActionRuntimeOverlay(modelPreview.runtime, runtimeOverlay),
        sandboxEntries,
      ),
    [modelPreview.runtime, runtimeOverlay, sandboxEntries],
  );
  const previewAnimaId = modelPreview.previewAnima?.id ?? null;
  const catalog = useMemo(
    () => (runtime ? new AnimaRuntimeCatalog(runtime) : null),
    [runtime],
  );
  useStrictModeSafeDestroy(catalog, (mountedCatalog) =>
    mountedCatalog?.dispose(),
  );
  const [sandboxCatalogRevision, markSandboxCatalogLoaded] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  const eventCatalog = useMemo(() => {
    // Private Avatar/Scene VFX become listable only after their authorized
    // definition/resources have loaded. Re-project the choices once preload
    // settles so diagnostics and local playback see the same mounted catalog.
    void sandboxCatalogRevision;
    return createPoseCreatorEventCatalog(catalog);
  }, [catalog, sandboxCatalogRevision]);
  const soundController = useOptionalSoundController();
  const mountRuntimeAudioCatalog = soundController?.mountRuntimeAudioCatalog;
  useEffect(() => {
    if (!catalog || !previewAnimaId || !mountRuntimeAudioCatalog) return;
    return mountRuntimeAudioCatalog(`pose-creator:${previewAnimaId}`, catalog);
  }, [catalog, mountRuntimeAudioCatalog, previewAnimaId]);

  useEffect(() => {
    if (!catalog || sandboxEntries.length === 0) return;
    let active = true;
    // Private fetching and parsing happen when dependencies enter the sandbox so
    // timeline transport can remain an immediate, entirely local operation.
    for (const entry of sandboxEntries) {
      const preload = (() => {
        if (entry.slot === "particle_vfx")
          return catalog.resolveParticleVFX(entry.runtime_id);
        if (entry.slot === "avatar_vfx")
          return catalog.loadAvatarVFX(entry.runtime_id);
        if (entry.slot === "scene_background_vfx")
          return catalog.loadSceneVFX("background_layers", entry.runtime_id);
        if (entry.slot === "scene_focus_vfx")
          return catalog.loadSceneVFX("focus_lines", entry.runtime_id);
        if (entry.slot === "sfx")
          return catalog.resolveAudio("sfx", entry.runtime_id);
        return Promise.resolve(null);
      })();
      void preload.then(
        () => {
          if (active) markSandboxCatalogLoaded();
        },
        () => {
          if (active) markSandboxCatalogLoaded();
        },
      );
    }
    return () => {
      active = false;
    };
  }, [catalog, sandboxEntries]);

  const value: PoseCreatorPreviewContextValue = {
    previewAnima: modelPreview.previewAnima,
    previewAnimaStatus: modelPreview.previewAnimaStatus,
    runtime,
    catalog,
    eventCatalog,
    modelOptions: modelPreview.modelOptions,
    selectedModel,
    modelEntry: modelPreview.modelEntry,
    modelEntryKey: modelPreview.modelEntryKey,
    isAnimaPending: modelPreview.isAnimaPending,
    isRuntimePending: modelPreview.isRuntimePending,
    isModelCatalogPending: modelPreview.isModelCatalogPending,
    hasMoreModels: modelPreview.hasMoreModels,
    isLoadingMoreModels: modelPreview.isLoadingMoreModels,
    modelCatalogError: modelPreview.modelCatalogError,
    animaError: modelPreview.animaError,
    runtimeError: modelPreview.runtimeError,
    modelError: modelPreview.modelError,
    selectModel: modelPreview.selectModel,
    retryAnima: modelPreview.retryAnima,
    retryRuntime: modelPreview.retryRuntime,
    retryModels: modelPreview.retryModels,
    loadMoreModels: modelPreview.loadMoreModels,
    retrySelectedModel: modelPreview.retrySelectedModel,
  };

  return (
    <PoseCreatorPreviewContext.Provider value={value}>
      {children}
    </PoseCreatorPreviewContext.Provider>
  );
}
