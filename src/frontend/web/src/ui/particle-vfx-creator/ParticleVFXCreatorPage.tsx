"use client";

import { useProductApiClient } from "@animama/product-ui";
import { particleVFXValidationMessages } from "./particleVFXValidationMessages";

import { ContentEditorHydration } from "@/lib/content/contentEditorSource";
import {
  createParticleVFXEffectContainer,
  createParticleVFXEmitterAnchorBindings,
  updateParticleVFXEmitterAnchors,
  type ParticleVFXEmitterAnchorBindings,
} from "@/lib/avatar/particle-vfx/emitterAnchors";

import { useFrame } from "@react-three/fiber";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ClipboardIcon,
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import * as THREE from "three";

import { particleVFXRecoveryStore } from "@/lib/content/particleVFXRecovery";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { Avatar } from "@/lib/avatar";
import { AvatarPreviewSurface } from "@/ui/avatar-preview/AvatarPreviewSurface";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import {
  PARTICLE_VFX_EDITOR_BLENDINGS,
  PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS,
  PARTICLE_VFX_EDITOR_EMITTER_TEMPLATES,
  PARTICLE_VFX_EDITOR_RENDER_MODES,
  PARTICLE_VFX_EDITOR_SHAPES,
  PARTICLE_VFX_EDITOR_TEXTURE_ROLE_LABELS,
  PARTICLE_VFX_EDITOR_TEXTURE_ROLE_ORDER,
  PARTICLE_VFX_EDITOR_TEXTURES,
  PARTICLE_VFX_ANCHORS,
  PARTICLE_VFX_PRELOAD_TIERS,
  addParticleVFXEditorEmitter,
  applyParticleVFXRectangleShapeAutoFit,
  applyParticleVFXEmitterPatch,
  buildParticleVFXEditorExport,
  createDefaultParticleVFXTransform,
  createParticleVFXBatchedRenderer,
  createParticleVFXEditorDraftFromBlank,
  createParticleVFXEditorDraftFromImport,
  duplicateParticleVFXEditorEmitter,
  estimateParticleVFXParticles,
  extractEmbeddedParticleVFXTextures,
  importParticleVFXTextureFile,
  missingParticleVFXTextureReferences,
  parseParticleVFXEditorExportJsonForViewer,
  readParticleVFXCreatorDocument,
  parseParticleVFXEditorJson,
  readParticleVFXTextureFile,
  removeParticleVFXEditorEmitter,
  resolveParticleVFXCreatorPreviewPlacement,
  resolveParticleVFXEditorPreviewJson,
  supplyParticleVFXTextureFile,
  updateParticleVFXEditorCatalogDraft,
  validateParticleVFXContentReadiness,
  type ParticleVFXEditorBlending,
  type ParticleVFXEditorCatalogDraft,
  type ParticleVFXEditorColor,
  type ParticleVFXEditorColorOverLifeDraft,
  type ParticleVFXEditorColorStop,
  type ParticleVFXEditorEmitterTemplateId,
  type ParticleVFXEditorDraft,
  type ParticleVFXEditorEmitterMode,
  type ParticleVFXEditorExport,
  type ParticleVFXEditorExportJsonViewerPayload,
  type ParticleVFXEditorLimitSpeedOverLifeDraft,
  type ParticleVFXEditorNoiseDraft,
  type ParticleVFXEditorOrbitOverLifeDraft,
  type ParticleVFXEditorRenderMode,
  type ParticleVFXEditorRotation3DOverLifeDraft,
  type ParticleVFXEditorShapeType,
  type ParticleVFXEditorStartColorDraft,
  type ParticleVFXEditorTextureFile,
  type ParticleVFXTextureResult,
  type ParticleVFXEditorTurbulenceFieldDraft,
  type ParticleVFXEditorValueBehaviorDraft,
  type ParticleVFXEditorValueGeneratorDraft,
  type ParticleVFXEditorValueRange,
  type ParticleVFXEmitterDraft,
  type ParticleVFXEmitterPatch,
  type ParticleVFXAnchor,
  type ParticleVFXPreloadTier,
  type ParticleVFXShapeAutoFit,
  type ParticleVFXTransform,
  type ParticleVFXTransformAxisTriple,
} from "@/lib/avatar/particle-vfx";
import { PARTICLE_TEXTURE_LIMITS } from "@/lib/effects/effectArtLimits";
import { findParticleEffectTemplate } from "@/lib/effects/effectTemplates";
import { cn } from "@/lib/utils";
import { useParticleEffect } from "@/query/hooks/useEffects";
import {
  CreatorCanvasControls,
  CreatorEffectHandoffActions,
  CreatorField,
  CreatorFloatingPanel,
  CreatorImportDialog,
  CreatorInlineError,
  CreatorJsonDialog,
  CreatorLeaveDialog,
  CreatorLoading,
  CreatorNumberField as NumberField,
  CreatorPreviewBar,
  CreatorDiscardRecoveryButton,
  CreatorSaveNotice,
  creatorRecoveredMessage,
  CreatorToolbar,
  CreatorUnavailableState,
  CreatorWorkspaceShell,
  creatorItemUnavailableMessage,
  isCreatorItemOpenable,
} from "@/ui/content-creator";
import {
  CreatorTimelineLane,
  CreatorTimelinePlayhead,
  CreatorTimelineRuler,
  CreatorTimelineToolbar,
  CreatorTimelineTransport,
} from "@/ui/content-creator/CreatorTimeline";
import {
  LANE_HEIGHT_PX,
  RULER_HEIGHT_PX,
  TRACK_LABEL_RAIL_PX,
  TRACK_RIGHT_INSET_PX,
} from "@/ui/content-creator/creatorTimelineGeometry";
import { ContentHealth } from "@/ui/content-health/ContentHealth";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Switch } from "@/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/components/tabs";
import { Textarea } from "@/ui/components/textarea";
import {
  buildSceneCameraPreset,
  type SceneCameraSettings,
} from "@/ui/main/canvas/sceneCameraPresets";
import {
  JsonTreeNode,
  type JsonExpandMode,
} from "@/ui/debug/vrm-editor/json-tree";
import { CreatorTemplateDraftDialog } from "@/ui/content-creator/CreatorTemplateDraftDialog";
import { useCreatorLeaveGuard } from "@/ui/content-creator/useCreatorLeaveGuard";
import {
  creatorTemplateRecoveryKey,
  useCreatorTemplateStart,
} from "@/ui/content-creator/useCreatorTemplateStart";
import { useCreatorDocumentHistory } from "@/ui/creator-history/useCreatorDocumentHistory";
import {
  equalParticleVFXDrafts,
  particleVFXDocumentFingerprint,
} from "./particleVFXDocument";
import {
  loadParticleEffectTemplate,
  loadParticleVFXCatalogDraft,
} from "./particleVFXCatalogDraft";
import { useParticleVFXSave } from "./useParticleVFXSave";
import { EmitterCarriedTextures } from "./EmitterCarriedTextures";
import { type ContentCreatorModelSource } from "@/ui/content-creator/contentCreatorModelPreview";
import { useContentCreatorAvatar } from "@/ui/content-creator/useContentCreatorAvatar";
import { useContentCreatorModelPreview } from "@/ui/content-creator/useContentCreatorModelPreview";

type PreviewStatus = {
  state: "idle" | "loading" | "ready" | "error";
  message: string | null;
};

type ThreeQuarksModule = typeof import("three.quarks");
type PreviewBatchRenderer = InstanceType<
  ThreeQuarksModule["BatchedRenderer"]
> & {
  dispose?: () => void;
};
type PreviewEmitter = THREE.Object3D & {
  system?: {
    stop?: () => void;
    dispose?: () => void;
  };
};

const PARTICLE_VFX_CREATOR_AVATAR_CAMERA_SETTINGS =
  buildSceneCameraPreset("full-body").settings;
const PARTICLE_VFX_CREATOR_EMITTER_CAMERA_SETTINGS: SceneCameraSettings = {
  // Standalone emitters sit at the origin. Keep the avatar view's angle and
  // distance while centering that origin instead of looking above it.
  position: { x: 0, y: 0.2, z: 3.2 },
  fov: PARTICLE_VFX_CREATOR_AVATAR_CAMERA_SETTINGS.fov,
  orbitTarget: { x: 0, y: 0, z: 0 },
};
const BUILT_IN_TEXTURE_REFERENCES = new Set(
  PARTICLE_VFX_EDITOR_TEXTURES.map(({ relativeUrl }) => relativeUrl),
);
const PARTICLE_VFX_TEXTURE_GROUPS = PARTICLE_VFX_EDITOR_TEXTURE_ROLE_ORDER.map(
  (role) => ({
    role,
    label: PARTICLE_VFX_EDITOR_TEXTURE_ROLE_LABELS[role],
    textures: PARTICLE_VFX_EDITOR_TEXTURES.filter(
      (texture) => texture.role === role,
    ),
  }),
).filter((group) => group.textures.length > 0);

function saveStageLabel(stage: ReturnType<typeof useParticleVFXSave>["stage"]) {
  if (stage === "preparing") return "Preparing";
  if (stage === "hashing") return "Hashing";
  if (stage === "uploading") return "Uploading";
  if (stage === "validating") return "Validating";
  return "Save";
}

/**
 * Particle Effect creator. `itemId` edits a saved item (an Included item is
 * saved as a Local copy); `templateId` starts a new draft from an Included
 * template (`/particle-effects/new?template=<id>`); with neither it starts
 * blank. The template ID stays page state for the template's label; it is
 * not saved with the effect.
 */
export function ParticleVFXCreatorPage({
  itemId,
  templateId,
}: {
  itemId?: string;
  templateId?: string;
}) {
  const navigate = useNavigate();
  const userId = useRuntimeCacheKey();
  const apiClient = useProductApiClient();
  const existingQuery = useParticleEffect(itemId ?? null);
  const existing = existingQuery.data;
  const loadedItemRef = useRef(new ContentEditorHydration());
  const [blankDraft] = useState(createParticleVFXEditorDraftFromBlank);
  const {
    present: draft,
    history,
    update: updateDraft,
    reset: resetDraft,
  } = useCreatorDocumentHistory({
    initialValue: blankDraft,
    equals: equalParticleVFXDrafts,
  });
  const { commit, replacePresent } = history;
  const [activeEmitterPath, setActiveEmitterPath] = useState<string | null>(
    null,
  );
  const [emitterQuery, setEmitterQuery] = useState("");
  const [loadState, setLoadState] = useState<{
    state: "loading" | "ready" | "error";
    message: string | null;
  }>({ state: itemId || templateId ? "loading" : "ready", message: null });
  /** A template route's recovered draft, held until the user chooses. */
  const [templateDraft, setTemplateDraft] =
    useState<ParticleVFXEditorDraft | null>(null);
  const [importText, setImportText] = useState(
    () => `${JSON.stringify(blankDraft.quarksJson, null, 2)}\n`,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>({
    state: "idle",
    message: null,
  });
  const [showAvatar, setShowAvatar] = useState(true);
  const [showEmitterOutline, setShowEmitterOutline] = useState(true);
  const [selectedModel, setSelectedModel] =
    useState<ContentCreatorModelSource | null>(null);
  const [previewAvatar, setPreviewAvatar] = useState<Avatar | null>(null);
  const [avatarPreviewStatus, setAvatarPreviewStatus] = useState<PreviewStatus>(
    {
      state: "idle",
      message: null,
    },
  );
  const [jsonViewerOpen, setJsonViewerOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [jsonExpandMode, setJsonExpandMode] = useState<JsonExpandMode>("smart");
  const [jsonResetToken, setJsonResetToken] = useState(0);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  const [textureUrlLease, setTextureUrlLease] = useState<{
    files: ParticleVFXEditorDraft["textureFiles"];
    urls: ReadonlyMap<string, string>;
  } | null>(null);
  const [textureError, setTextureError] = useState<string | null>(null);
  const [textureBusy, setTextureBusy] = useState(false);
  const saveStatusRef = useRef<HTMLElement | null>(null);

  // Object URLs for the textures the effect carries, for preview and
  // thumbnails. URLs of an earlier table are revoked when it changes, so they
  // are used only while the lease matches the current table.
  useEffect(() => {
    const urls = new Map(
      Object.entries(draft.textureFiles).map(([reference, file]) => [
        reference,
        URL.createObjectURL(file.blob),
      ]),
    );
    setTextureUrlLease({ files: draft.textureFiles, urls });
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [draft.textureFiles]);
  const textureUrls = useMemo<ReadonlyMap<string, string>>(
    () =>
      textureUrlLease?.files === draft.textureFiles
        ? textureUrlLease.urls
        : new Map(),
    [draft.textureFiles, textureUrlLease],
  );
  const missingTextureReferences = useMemo(
    () => missingParticleVFXTextureReferences(draft),
    [draft],
  );

  const restartPreview = useCallback(() => {
    setPreviewPlaying(true);
    setPreviewRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    setActiveEmitterPath((path) =>
      draft.emitters.some((emitter) => emitter.path === path)
        ? path
        : (draft.emitters[0]?.path ?? null),
    );
    restartPreview();
  }, [draft, restartPreview]);

  const hydrateDraft = useCallback(
    (nextDraft: ParticleVFXEditorDraft) => {
      resetDraft(nextDraft);
      setActiveEmitterPath(nextDraft.emitters[0]?.path ?? null);
      setImportText(`${JSON.stringify(nextDraft.quarksJson, null, 2)}\n`);
      setImportError(null);
      setLoadState({ state: "ready", message: null });
    },
    [resetDraft],
  );
  const modelPreview = useContentCreatorModelPreview({
    ownerKey: "particle-vfx-creator",
    selectedModel,
    onSelectModel: setSelectedModel,
  });
  const [blankFingerprint] = useState(() =>
    particleVFXDocumentFingerprint(blankDraft),
  );
  /**
   * The clean document's fingerprint: the blank draft, an owned item as
   * loaded or last saved, or the template baseline that no draft equals.
   */
  const initialFingerprintRef = useRef(blankFingerprint);
  const markSavedDraft = useCallback(
    (savedDraft: ParticleVFXEditorDraft, savedItemId: string) => {
      loadedItemRef.current.preserve(savedItemId);
      initialFingerprintRef.current =
        particleVFXDocumentFingerprint(savedDraft);
      replacePresent(savedDraft);
    },
    [replacePresent],
  );
  const onRestore = useCallback(
    (recovered: ParticleVFXEditorDraft) => {
      if (templateId) {
        setTemplateDraft(recovered);
        return;
      }
      hydrateDraft(recovered);
    },
    [hydrateDraft, templateId],
  );
  const currentFingerprint = useMemo(
    () => particleVFXDocumentFingerprint(draft),
    [draft],
  );
  const isDirty = currentFingerprint !== initialFingerprintRef.current;
  const contentSave = useParticleVFXSave({
    itemId,
    recoveryKey: templateId
      ? creatorTemplateRecoveryKey(templateId)
      : undefined,
    snapshot: draft,
    dirty: isDirty,
    initialized: loadState.state === "ready",
    ready: loadState.state === "ready",
    onRestore,
    onSaved: markSavedDraft,
  });
  // The template loader must stay stable, or each render restarts the load.
  const loadTemplateSeed = useCallback(
    (id: string, signal: AbortSignal) =>
      loadParticleEffectTemplate(apiClient, id, signal),
    [apiClient],
  );
  const templateStart = useCreatorTemplateStart({
    templateId,
    loadSeed: loadTemplateSeed,
    fingerprint: particleVFXDocumentFingerprint,
    recoveryReady: contentSave.recoveryReady,
    recoveredDraft: templateDraft,
    resetSession: contentSave.resetSession,
    install: hydrateDraft,
    baselineRef: initialFingerprintRef,
    setHydration: setLoadState,
  });
  const templateDraftDialog = (
    <CreatorTemplateDraftDialog
      start={templateStart}
      contentLabel="Particle Effect"
      templateName={
        findParticleEffectTemplate(templateId)?.name ?? "a template"
      }
    />
  );
  const unavailableMessage = creatorItemUnavailableMessage({
    itemId,
    label: "Particle Effect",
    item: existing,
    readFailed: existingQuery.isError,
    loadError:
      loadState.state === "error"
        ? (loadState.message ?? "The Particle Effect could not be loaded.")
        : null,
  });
  // The unavailable state has no leave dialog, so it must never block navigation.
  const guardLeave = !unavailableMessage;
  const leaveGuard = useCreatorLeaveGuard({
    dirty: guardLeave && isDirty,
    busy: guardLeave && contentSave.isBusy,
    discard: contentSave.discardChanges,
  });
  // Leaving and starting over both disable editing until storage settles.
  const discardPending = discarding || leaveGuard.discarding;
  const documentNameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (contentSave.errorField === "name")
      documentNameInputRef.current?.focus();
  }, [contentSave.errorField]);

  useEffect(() => {
    const source = existing?.source;
    if (
      !itemId ||
      !source ||
      source.type !== "catalog" ||
      !source.catalog_item_id ||
      !isCreatorItemOpenable(existing) ||
      !contentSave.recoveryReady ||
      contentSave.recovered
    ) {
      return;
    }
    const load = loadedItemRef.current.begin(itemId);
    if (!load) return;
    const controller = new AbortController();
    setLoadState({ state: "loading", message: "Loading Particle Effect…" });
    void loadParticleVFXCatalogDraft(apiClient, {
      itemId: source.catalog_item_id,
      name: existing.name,
      description: existing.description ?? "",
      signal: controller.signal,
    }).then(
      (loadedDraft) => {
        if (controller.signal.aborted) return;
        load.complete();
        // An Included item stays dirty against the blank baseline, so it
        // saves as a Local copy.
        if (existing.origin === "owned")
          initialFingerprintRef.current =
            particleVFXDocumentFingerprint(loadedDraft);
        hydrateDraft(loadedDraft);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "The Particle Effect could not be loaded.",
        });
      },
    );
    return () => {
      controller.abort();
      load.cancel();
    };
  }, [
    apiClient,
    contentSave.recovered,
    contentSave.recoveryReady,
    existing,
    hydrateDraft,
    itemId,
  ]);

  useEffect(() => {
    if (contentSave.error) saveStatusRef.current?.focus();
  }, [contentSave.error]);

  useEffect(() => {
    if (!draft) return;
    if (
      activeEmitterPath &&
      draft.emitters.some((emitter) => emitter.path === activeEmitterPath)
    ) {
      return;
    }
    setActiveEmitterPath(draft.emitters[0]?.path ?? null);
  }, [activeEmitterPath, draft]);

  useEffect(() => {
    if (showAvatar) return;
    setPreviewAvatar(null);
    setAvatarPreviewStatus({ state: "idle", message: null });
  }, [showAvatar]);

  useEffect(() => {
    if (!showAvatar) return;
    const error =
      modelPreview.modelError ??
      modelPreview.runtimeError ??
      modelPreview.animaError ??
      modelPreview.modelCatalogError;
    if (error) {
      setAvatarPreviewStatus((current) =>
        current.state === "error" && current.message === error
          ? current
          : { state: "error", message: error },
      );
      return;
    }
    if (
      modelPreview.isAnimaPending ||
      modelPreview.isRuntimePending ||
      modelPreview.isModelCatalogPending ||
      !modelPreview.modelEntry
    ) {
      const message = selectedModel?.displayName ?? "Selecting Avatar Model…";
      setAvatarPreviewStatus((current) =>
        current.state === "loading" && current.message === message
          ? current
          : { state: "loading", message },
      );
    }
  }, [
    modelPreview.animaError,
    modelPreview.isAnimaPending,
    modelPreview.isModelCatalogPending,
    modelPreview.isRuntimePending,
    modelPreview.modelCatalogError,
    modelPreview.modelEntry,
    modelPreview.modelError,
    modelPreview.runtimeError,
    selectedModel?.displayName,
    showAvatar,
  ]);

  const issues = useMemo(() => {
    if (!draft) return [];
    const resolvable = new Set([
      ...BUILT_IN_TEXTURE_REFERENCES,
      ...Object.keys(draft.textureFiles),
    ]);
    return validateParticleVFXContentReadiness(draft, {
      resolvableTextureReferences: resolvable,
    }).issues;
  }, [draft]);
  const exportBundle = useMemo(
    () => (draft ? buildParticleVFXEditorExport(draft) : null),
    [draft],
  );
  const jsonViewerPayload = useMemo(
    () => parseParticleVFXEditorExportJsonForViewer(exportBundle?.quarksJson),
    [exportBundle?.quarksJson],
  );
  const previewResolution = useMemo(() => {
    if (!draft) return { json: null, error: null };
    try {
      // Any image that is neither carried (with a URL yet) nor built in
      // previews as the default texture; readiness reports why.
      const fallback = PARTICLE_VFX_EDITOR_TEXTURES[0]!.publicUrl;
      return {
        json: resolveParticleVFXEditorPreviewJson(
          draft,
          (reference) =>
            textureUrls.get(reference) ??
            (BUILT_IN_TEXTURE_REFERENCES.has(reference) ? undefined : fallback),
        ),
        error: null,
      };
    } catch (error) {
      return {
        json: null,
        error:
          error instanceof Error
            ? error.message
            : "Particle VFX preview resources are unavailable.",
      };
    }
  }, [draft, textureUrls]);
  const activeEmitter = useMemo(
    () =>
      draft?.emitters.find((emitter) => emitter.path === activeEmitterPath) ??
      null,
    [activeEmitterPath, draft],
  );
  const filteredEmitters = useMemo(() => {
    const query = emitterQuery.trim().toLowerCase();
    if (!query) return draft?.emitters ?? [];
    return (draft?.emitters ?? []).filter((emitter) =>
      emitter.name.toLowerCase().includes(query),
    );
  }, [draft?.emitters, emitterQuery]);
  // The estimate of particles alive at once that Save enforces.
  const estimatedParticles = draft
    ? estimateParticleVFXParticles(draft.quarksJson)
    : 0;
  const previewDurationSec = Math.max(
    0.05,
    draft?.catalog.defaultDurationSec ?? 1.2,
  );

  const togglePreviewPlayback = useCallback(
    () => setPreviewPlaying((current) => !current),
    [],
  );

  const stopPreview = useCallback(() => {
    setPreviewPlaying(false);
    setPreviewRevision((value) => value + 1);
  }, []);
  /** Keep the draft visible and retryable if its browser recovery cannot be deleted. */
  const runDiscard = useCallback(
    async (discard: () => Promise<void | boolean>) => {
      if (discarding) return false;
      setDiscarding(true);
      try {
        return (await discard()) !== false;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The draft could not be discarded.",
        );
        return false;
      } finally {
        setDiscarding(false);
      }
    },
    [discarding],
  );

  /**
   * A new effect's recovered draft is replaced with a blank one. On an edit
   * route the recovered draft and its preserved Save operation are dropped and
   * the saved item reloads, as in the Avatar and Scene creators, so a blank
   * draft is never stored under the item.
   */
  const discardRecoveredDraft = useCallback(async () => {
    if (itemId) {
      await contentSave.discardRecovery();
      return;
    }
    const blank = createParticleVFXEditorDraftFromBlank();
    if (!(await contentSave.resetSession(blank))) return false;
    hydrateDraft(blank);
  }, [contentSave, hydrateDraft, itemId]);

  const patchCatalog = useCallback(
    (patch: Parameters<typeof updateParticleVFXEditorCatalogDraft>[1]) => {
      updateDraft((current) =>
        updateParticleVFXEditorCatalogDraft(current, patch),
      );
    },
    [updateDraft],
  );

  const patchEmitter = useCallback(
    (emitterPath: string, patch: ParticleVFXEmitterPatch) => {
      updateDraft((current) =>
        applyParticleVFXEmitterPatch(current, emitterPath, patch),
      );
    },
    [updateDraft],
  );

  /**
   * Check a chosen PNG before anything decodes it, then apply one texture
   * edit to the latest draft. A refusal leaves the draft unchanged.
   */
  const applyTextureFile = useCallback(
    async (
      file: File,
      apply: (
        current: ParticleVFXEditorDraft,
        texture: ParticleVFXEditorTextureFile,
      ) => ParticleVFXTextureResult,
    ) => {
      setTextureBusy(true);
      try {
        const read = await readParticleVFXTextureFile(file);
        if (!read.ok) {
          setTextureError(read.message);
          return;
        }
        let refusal: string | null = null;
        updateDraft((current) => {
          const result = apply(current, read.file);
          if (result.ok) return result.draft;
          refusal = result.message;
          return current;
        });
        setTextureError(refusal);
      } finally {
        setTextureBusy(false);
      }
    },
    [updateDraft],
  );
  const importTexture = useCallback(
    (emitterPath: string, file: File) =>
      void applyTextureFile(file, (current, texture) =>
        importParticleVFXTextureFile(current, emitterPath, file.name, texture),
      ),
    [applyTextureFile],
  );
  const supplyTexture = useCallback(
    (reference: string, file: File) =>
      void applyTextureFile(file, (current, texture) =>
        supplyParticleVFXTextureFile(current, reference, texture),
      ),
    [applyTextureFile],
  );

  const addEmitter = useCallback(() => {
    if (!draft) return;
    const nextDraft = addParticleVFXEditorEmitter(draft);
    commit(nextDraft);
    setActiveEmitterPath(nextDraft.emitters.at(-1)?.path ?? null);
  }, [draft, commit]);

  const duplicateEmitter = useCallback(() => {
    if (!draft || !activeEmitterPath) return;
    const nextDraft = duplicateParticleVFXEditorEmitter(
      draft,
      activeEmitterPath,
    );
    commit(nextDraft);
    setActiveEmitterPath(nextDraft.emitters.at(-1)?.path ?? null);
  }, [activeEmitterPath, draft, commit]);

  const removeEmitter = useCallback(() => {
    if (!draft || !activeEmitterPath) return;
    const nextDraft = removeParticleVFXEditorEmitter(draft, activeEmitterPath);
    commit(nextDraft);
    setActiveEmitterPath(nextDraft.emitters[0]?.path ?? null);
  }, [activeEmitterPath, draft, commit]);

  const handleImportJson = async () => {
    const parsed = parseParticleVFXEditorJson(importText);
    if (
      "severity" in parsed &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      setImportError(parsed.message);
      return;
    }
    const creatorDocument = readParticleVFXCreatorDocument(parsed);
    if (creatorDocument && "severity" in creatorDocument) {
      setImportError(creatorDocument.message);
      return;
    }
    if (
      isDirty &&
      !window.confirm(
        "Discard the current Particle VFX changes and load this JSON?",
      )
    ) {
      return;
    }
    // Embedded PNG data becomes texture files. Plain Quarks JSON keeps the
    // current name and settings, and references to textures this draft
    // already carries keep resolving; a creator document is a whole effect,
    // so it sets both and its other textures are chosen afresh.
    const carried = creatorDocument ? {} : (draft?.textureFiles ?? {});
    const embedded = await extractEmbeddedParticleVFXTextures(
      creatorDocument?.quarksJson ?? parsed,
      Object.keys(carried),
    );
    const nextId = draft?.catalog.id ?? "custom-particle-vfx";
    const nextDraft = createParticleVFXEditorDraftFromImport(
      embedded.json,
      {
        id: nextId,
        assetPath:
          draft?.catalog.assetPath ?? `/effects/vfx/quark/${nextId}.json`,
        ...(creatorDocument?.catalog ?? {
          label: draft?.catalog.label ?? "Custom Particle VFX",
          description:
            draft?.catalog.description ?? "Imported particle effect.",
          defaultAnchor: draft?.catalog.defaultAnchor ?? "head",
          defaultFollowAnchor: draft?.catalog.defaultFollowAnchor ?? true,
          defaultDurationSec: draft?.catalog.defaultDurationSec ?? 2,
          defaultTransform:
            draft?.catalog.defaultTransform ??
            createDefaultParticleVFXTransform(),
          preloadTier: draft?.catalog.preloadTier ?? "none",
          performanceBudget: draft?.catalog.performanceBudget,
          shapeAutoFit: draft?.catalog.shapeAutoFit,
        }),
      },
      { ...carried, ...embedded.textureFiles },
    );
    commit(nextDraft);
    setActiveEmitterPath(nextDraft.emitters[0]?.path ?? null);
    setImportError(null);
    setTextureError(
      embedded.refused.length
        ? `An embedded texture was not imported: ${embedded.refused[0]}`
        : null,
    );
    setLoadState({ state: "ready", message: null });
    setImportDialogOpen(false);
  };

  const handleNewDocument = useCallback(async () => {
    if (contentSave.isBusy || discarding) return;
    if (
      isDirty &&
      !window.confirm(
        "Discard the current Particle Effect changes and start a new effect?",
      )
    ) {
      return;
    }

    await runDiscard(async () => {
      // A saved item or a template draft starts over on the plain `/new` route.
      if (itemId || templateId) {
        if (!(await contentSave.discardChanges())) return false;
        if (userId)
          await particleVFXRecoveryStore.clear(userId, "new", {
            strict: true,
          });
        await navigate({
          to: "/particle-effects/new",
          replace: true,
          ignoreBlocker: true,
        });
        return;
      }

      const nextDraft = createParticleVFXEditorDraftFromBlank();
      if (!(await contentSave.resetSession(nextDraft))) return false;
      initialFingerprintRef.current = particleVFXDocumentFingerprint(nextDraft);
      hydrateDraft(nextDraft);
      setEmitterQuery("");
      setPreviewPlaying(true);
      setJsonViewerOpen(false);
      setImportDialogOpen(false);
      setJsonExpandMode("smart");
      setJsonResetToken((value) => value + 1);
      setCopiedTarget(null);
    });
  }, [
    contentSave,
    discarding,
    hydrateDraft,
    isDirty,
    itemId,
    navigate,
    runDiscard,
    templateId,
    userId,
  ]);

  const copyText = async (target: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedTarget(target);
    window.setTimeout(() => {
      setCopiedTarget((current) => (current === target ? null : current));
    }, 1400);
  };

  const downloadJson = (bundle: ParticleVFXEditorExport) => {
    const blob = new Blob([bundle.quarksJson], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = bundle.assetFileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const resetJsonTree = useCallback((nextMode: JsonExpandMode) => {
    setJsonExpandMode(nextMode);
    setJsonResetToken((value) => value + 1);
  }, []);

  if (unavailableMessage)
    return (
      <CreatorUnavailableState
        label="Particle Effect"
        message={unavailableMessage}
      />
    );
  // Never show the blank starter document in place of the saved item or
  // the template.
  if ((itemId || templateId) && loadState.state === "loading")
    return (
      <>
        <CreatorLoading
          message={
            loadState.message ??
            (templateId ? "Loading template…" : "Loading Particle Effect…")
          }
        />
        {templateDraftDialog}
      </>
    );

  return (
    <CreatorWorkspaceShell
      busy={contentSave.isBusy || discardPending}
      leftPanelLabel="Emitters"
      rightPanelLabel="Inspector"
      leftPanelWidth={340}
      rightPanelWidth={392}
      bottomChromeHeight={152}
      toolbar={
        <CreatorToolbar
          history={history}
          historyDisabled={
            contentSave.isBusy ||
            discardPending ||
            !contentSave.recoveryReady ||
            loadState.state === "loading"
          }
          contentHealth={<ContentHealth compact />}
          validationMessages={Array.from(
            new Set(
              particleVFXValidationMessages(issues, draft?.emitters ?? []),
            ),
          )}
          typeLabel="Particle FX"
          contentType="particle_effect"
          typeIcon={<SparklesIcon />}
          documentName={draft?.catalog.label ?? ""}
          documentNameInputRef={documentNameInputRef}
          documentNameInvalid={contentSave.errorField === "name"}
          documentNameDisabled={!draft || contentSave.isBusy || discardPending}
          onDocumentNameChange={(label) => {
            contentSave.clearSaveErrorField("name");
            patchCatalog({ label });
          }}
          status={
            contentSave.error
              ? {
                  label: "Save failed",
                  tone: "error",
                  tooltip: contentSave.error,
                }
              : {
                  label: itemId && !isDirty ? "Saved" : "Unsaved",
                  tone: itemId && !isDirty ? "saved" : "dirty",
                }
          }
          onNew={() => void handleNewDocument()}
          onImport={() => setImportDialogOpen(true)}
          onJson={() => setJsonViewerOpen(true)}
          onSave={() => void contentSave.save()}
          newDisabled={contentSave.isBusy || discardPending}
          importDisabled={contentSave.isBusy || discardPending}
          jsonDisabled={!exportBundle}
          saveDisabled={!contentSave.canSave || discardPending}
          saveBusy={contentSave.isBusy}
          saveLabel={
            contentSave.isBusy
              ? saveStageLabel(contentSave.stage)
              : contentSave.stage === "error" && contentSave.recovered
                ? "Retry Save"
                : "Save"
          }
          domainActions={
            <CreatorEffectHandoffActions
              itemId={
                existing?.origin === "owned" && existing.source
                  ? existing.item_id
                  : null
              }
              componentType="particle_effect"
            />
          }
        />
      }
      leftPanel={
        <CreatorFloatingPanel
          title="Emitters"
          summary={`${draft?.emitters.length ?? 0} emitter${(draft?.emitters.length ?? 0) === 1 ? "" : "s"}`}
          bodyClassName="p-0"
        >
          <section className="border-border border-b p-3">
            <div className="relative">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                value={emitterQuery}
                onChange={(event) => setEmitterQuery(event.target.value)}
                placeholder="Search emitters"
                aria-label="Search emitters"
                className="pl-9"
              />
            </div>
            <div className="mt-3 space-y-2">
              {filteredEmitters.map((emitter) => (
                <button
                  key={emitter.path}
                  type="button"
                  className={cn(
                    "border-border/70 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    emitter.path === activeEmitterPath
                      ? "border-primary/30 bg-primary/10"
                      : "bg-background/70 hover:bg-muted/70",
                  )}
                  onClick={() => setActiveEmitterPath(emitter.path)}
                >
                  <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <SparklesIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {emitter.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {emitterSummary(emitter)}
                    </span>
                  </span>
                </button>
              ))}
              {filteredEmitters.length === 0 ? (
                <p className="text-muted-foreground py-3 text-center text-xs">
                  No emitters match this search.
                </p>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addEmitter}
                disabled={!draft}
              >
                <PlusIcon /> Add
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={duplicateEmitter}
                disabled={!activeEmitter}
                aria-label="Duplicate selected emitter"
              >
                <CopyIcon /> Duplicate
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                onClick={removeEmitter}
                disabled={!activeEmitter || (draft?.emitters.length ?? 0) <= 1}
                aria-label="Remove selected emitter"
                title="Remove selected emitter"
              >
                <Trash2Icon />
              </Button>
            </div>
          </section>

          <section className="border-border border-b p-3">
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {Number.isFinite(estimatedParticles)
                ? `Estimated at once: up to ${estimatedParticles} particles`
                : "Estimated at once: cannot be estimated (an emission, lifetime, burst or duration value is unsupported)"}
            </p>
            <div className="mt-3 space-y-3">
              <SelectField
                label="Default anchor"
                value={draft?.catalog.defaultAnchor ?? "head"}
                values={PARTICLE_VFX_ANCHORS}
                onChange={(value) => patchCatalog({ defaultAnchor: value })}
                disabled={!draft}
              />
              <NumberField
                label="Effect playback duration (s)"
                value={draft?.catalog.defaultDurationSec ?? 0}
                min={0.05}
                step={0.05}
                onChange={(value) =>
                  patchCatalog({ defaultDurationSec: value })
                }
                disabled={!draft}
              />
              <CatalogShapeAutoFitControls
                shapeAutoFit={draft?.catalog.shapeAutoFit}
                rectangleEmitters={
                  draft?.emitters.filter(
                    (emitter) => emitter.shape.type === "rectangle",
                  ) ?? []
                }
                disabled={!draft}
                onChange={(shapeAutoFit) => patchCatalog({ shapeAutoFit })}
              />
            </div>
          </section>

          <section className="border-border border-b p-3">
            <h2 className="text-xs font-semibold tracking-wide uppercase">
              Transform
            </h2>
            <TransformControls
              transform={
                draft?.catalog.defaultTransform ??
                createDefaultParticleVFXTransform()
              }
              disabled={!draft}
              onChange={(transform) =>
                patchCatalog({ defaultTransform: transform })
              }
            />
          </section>

          <details className="border-border border-b p-3">
            <summary className="cursor-pointer text-sm font-semibold">
              Advanced settings
            </summary>
            <div className="mt-3 space-y-3">
              <SelectField
                label="Preload"
                value={draft?.catalog.preloadTier ?? "none"}
                values={PARTICLE_VFX_PRELOAD_TIERS}
                onChange={(value) =>
                  patchCatalog({ preloadTier: value as ParticleVFXPreloadTier })
                }
                disabled={!draft}
              />
              <p className="text-muted-foreground text-xs">
                Performance limits apply to the whole effect. Enabling looping
                here permits individual emitters to repeat their cycles.
              </p>
              <NumberField
                label="Maximum playback duration (s)"
                value={draft?.catalog.performanceBudget.maxDurationSec ?? 0}
                min={0.05}
                step={0.05}
                onChange={(value) =>
                  draft &&
                  patchCatalog({
                    performanceBudget: {
                      ...draft.catalog.performanceBudget,
                      maxDurationSec: value,
                    },
                  })
                }
                disabled={!draft}
              />
              <NumberField
                label="Maximum total particles"
                value={draft?.catalog.performanceBudget.maxParticles ?? 0}
                min={1}
                step={1}
                onChange={(value) =>
                  draft &&
                  patchCatalog({
                    performanceBudget: {
                      ...draft.catalog.performanceBudget,
                      maxParticles: Math.round(value),
                    },
                  })
                }
                disabled={!draft}
              />
              <CheckboxField
                label="Allow emitter looping"
                checked={
                  draft?.catalog.performanceBudget.loopingAllowed ?? false
                }
                onChange={(value) =>
                  draft &&
                  patchCatalog({
                    performanceBudget: {
                      ...draft.catalog.performanceBudget,
                      loopingAllowed: value,
                    },
                  })
                }
                disabled={!draft}
              />
              <CheckboxField
                label="Allow simultaneous effects"
                checked={draft?.catalog.performanceBudget.canCoexist ?? true}
                onChange={(value) =>
                  draft &&
                  patchCatalog({
                    performanceBudget: {
                      ...draft.catalog.performanceBudget,
                      canCoexist: value,
                    },
                  })
                }
                disabled={!draft}
              />
            </div>
          </details>
        </CreatorFloatingPanel>
      }
      canvas={
        <div
          className="bg-background relative h-full min-h-0"
          data-playback-surface="creator-stage"
        >
          <ParticleVFXCreatorPreview
            json={previewResolution.json}
            catalog={draft?.catalog ?? null}
            revision={previewRevision}
            playing={previewPlaying}
            showAvatar={showAvatar}
            showEmitterOutline={showEmitterOutline}
            activeEmitter={activeEmitter}
            previewAvatar={previewAvatar}
            modelEntry={modelPreview.modelEntry}
            modelEntryKey={modelPreview.modelEntryKey}
            onAvatarChange={setPreviewAvatar}
            onAvatarStatusChange={setAvatarPreviewStatus}
            onStatusChange={setPreviewStatus}
          />
          <PlaybackObservationOutput
            active
            avatar={previewAvatar}
            sceneVFX={null}
            status={
              previewResolution.error ||
              previewStatus.state === "error" ||
              avatarPreviewStatus.state === "error"
                ? "error"
                : previewStatus.state === "loading" ||
                    avatarPreviewStatus.state === "loading" ||
                    modelPreview.isAnimaPending ||
                    modelPreview.isRuntimePending
                  ? "loading"
                  : previewStatus.state === "ready" && previewPlaying
                    ? "playing"
                    : previewStatus.state === "ready"
                      ? "stopped"
                      : "unavailable"
            }
            surface="creator-stage"
            target={{
              kind: "particle_vfx",
              runtimeId: draft?.catalog.id ?? "new-particle-vfx",
            }}
          />
          {previewStatus.state === "error" ||
          previewResolution.error ||
          avatarPreviewStatus.state === "error" ? (
            <div
              className="bg-background pointer-events-none absolute top-3 left-1/2 z-30 w-[min(340px,calc(100%-1.5rem))] -translate-x-1/2 rounded-xl border px-3 py-2 text-xs shadow-sm lg:top-[84px]"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <div className="font-medium">
                {previewStatus.state === "ready"
                  ? "Preview ready"
                  : previewStatus.state === "loading"
                    ? "Loading preview"
                    : previewStatus.state === "error"
                      ? "Preview error"
                      : "Preview idle"}
              </div>
              {previewStatus.message ? (
                <div className="text-muted-foreground mt-1 max-w-[340px]">
                  {previewStatus.message}
                </div>
              ) : null}
              {previewResolution.error ? (
                <div className="text-destructive mt-1 max-w-[340px]">
                  {previewResolution.error}
                </div>
              ) : null}
              {showAvatar ? (
                <div className="border-border text-muted-foreground mt-2 border-t pt-2">
                  <span className="text-foreground font-medium">
                    {avatarPreviewStatus.state === "ready"
                      ? "Avatar ready"
                      : avatarPreviewStatus.state === "loading"
                        ? "Avatar loading"
                        : avatarPreviewStatus.state === "error"
                          ? "Avatar error"
                          : "Avatar idle"}
                  </span>
                  {avatarPreviewStatus.message ? (
                    <span className="ml-1">{avatarPreviewStatus.message}</span>
                  ) : null}
                  {selectedModel ? (
                    <div className="mt-1">
                      {selectedModel.sourceLabel}: {selectedModel.displayName}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!showAvatar && draft?.catalog.shapeAutoFit ? (
                <div className="border-border text-muted-foreground mt-2 border-t pt-2">
                  Rectangle fitting uses avatar bounds when an avatar is
                  available.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      }
      rightPanel={
        <EmitterAuthoringTabs
          draft={draft}
          activeEmitter={activeEmitter}
          activeEmitterPath={activeEmitterPath}
          onSelectEmitter={setActiveEmitterPath}
          onPatch={(patch) =>
            activeEmitter && patchEmitter(activeEmitter.path, patch)
          }
          textures={{
            files: draft.textureFiles,
            urls: textureUrls,
            missing: missingTextureReferences,
            error: textureError,
            busy: textureBusy,
            onImport: (file) =>
              activeEmitter && importTexture(activeEmitter.path, file),
            onSupply: supplyTexture,
          }}
        />
      }
      canvasControls={
        <CreatorCanvasControls
          className="w-full justify-center"
          model={
            showAvatar
              ? {
                  label: "Model",
                  value: selectedModel?.key ?? "",
                  placeholder: modelPreview.isModelCatalogPending
                    ? "Loading models…"
                    : "Select preview model",
                  options: [
                    ...(selectedModel &&
                    !modelPreview.modelOptions.some(
                      (option) => option.key === selectedModel.key,
                    )
                      ? [
                          {
                            value: selectedModel.key,
                            label: selectedModel.displayName,
                          },
                        ]
                      : []),
                    ...modelPreview.modelOptions.map((source) => ({
                      value: source.key,
                      label: source.displayName,
                    })),
                  ],
                  onValueChange: (key) => {
                    const source = modelPreview.modelOptions.find(
                      (option) => option.key === key,
                    );
                    if (source) modelPreview.selectModel(source);
                  },
                  triggerClassName: "w-[min(220px,50vw)]",
                  disabled:
                    modelPreview.isModelCatalogPending &&
                    modelPreview.modelOptions.length === 0,
                }
              : undefined
          }
          guides={showAvatar}
          guidesLabel="Avatar"
          guidesAriaLabel="Show Avatar"
          guidesDisabled={!draft}
          onGuidesChange={setShowAvatar}
          domainControl={
            <>
              {showAvatar && modelPreview.hasMoreModels ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={modelPreview.isLoadingMoreModels}
                  onClick={() => void modelPreview.loadMoreModels()}
                  aria-label="Load more Avatars"
                >
                  <PlusIcon />
                </Button>
              ) : null}
              {showAvatar &&
              (modelPreview.modelError ||
                modelPreview.runtimeError ||
                modelPreview.animaError ||
                modelPreview.modelCatalogError) ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() =>
                    void Promise.all([
                      modelPreview.retryAnima(),
                      modelPreview.retryRuntime(),
                      modelPreview.retryModels(),
                      modelPreview.retrySelectedModel(),
                    ])
                  }
                  aria-label="Retry preview Avatar Model"
                >
                  <RefreshCwIcon />
                </Button>
              ) : null}
              <span className="text-muted-foreground ml-1 shrink-0 text-xs font-medium">
                Outline
              </span>
              <Switch
                aria-label="Show emitter shape outline"
                checked={showEmitterOutline}
                onCheckedChange={setShowEmitterOutline}
                disabled={!activeEmitter}
              />
            </>
          }
        />
      }
      previewBar={
        <CreatorPreviewBar className="p-0">
          <ParticleVFXPreviewTimeline
            emitters={draft?.emitters ?? []}
            activeEmitterPath={activeEmitterPath}
            durationSec={previewDurationSec}
            revision={previewRevision}
            playing={previewPlaying}
            ready={previewStatus.state === "ready"}
            onSelectEmitter={setActiveEmitterPath}
            onTogglePlayback={togglePreviewPlayback}
            onStop={stopPreview}
            onRestart={restartPreview}
            onPlaybackEnded={() => setPreviewPlaying(false)}
          />
        </CreatorPreviewBar>
      }
      overlays={
        <>
          {loadState.state === "error" ? (
            <CreatorInlineError
              message={
                loadState.message ?? "The Particle Effect could not be loaded."
              }
            />
          ) : null}
          {contentSave.error ||
          contentSave.recoveryWarning ||
          // A template route asks about its draft in a dialog instead.
          (contentSave.recovered && !templateId) ||
          contentSave.notices.length > 0 ||
          contentSave.isBusy ? (
            <CreatorSaveNotice
              noticeRef={saveStatusRef}
              className="absolute top-[calc(var(--creator-header-height)+0.5rem)] right-4 left-4 z-50 transition-[left] duration-150 sm:left-16 lg:left-[calc(var(--app-shell-sidebar-inset)+1rem)] xl:left-[calc(var(--app-shell-sidebar-inset)+2rem)]"
              tone={contentSave.error ? "error" : "warning"}
              busy={contentSave.isBusy}
              focusOnError
              message={
                contentSave.error ??
                contentSave.recoveryWarning ??
                (contentSave.notices[0]
                  ? `${contentSave.notices[0]}${
                      contentSave.noticeConfirmationRequired
                        ? " Review the adjustment, then Save again."
                        : ""
                    }`
                  : null) ??
                (contentSave.isBusy
                  ? `${saveStageLabel(contentSave.stage)} private content…`
                  : creatorRecoveredMessage("Particle VFX"))
              }
              actions={
                contentSave.recovered && !contentSave.isBusy ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {contentSave.error ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={discardPending}
                        onClick={() => void contentSave.save()}
                      >
                        Retry Save
                      </Button>
                    ) : null}
                    {templateId ? null : (
                      <CreatorDiscardRecoveryButton
                        disabled={discardPending}
                        onDiscard={() => void runDiscard(discardRecoveredDraft)}
                      />
                    )}
                  </div>
                ) : null
              }
            />
          ) : null}
          <CreatorImportDialog
            open={importDialogOpen}
            onOpenChange={setImportDialogOpen}
            title="Import Particle VFX JSON"
            description="Paste a three.quarks effect, or a creator document from Export, which also sets the name and settings. Valid JSON replaces the current document after the unsaved-change confirmation. Embedded PNG textures are kept. Other textures that are not built in show as missing until you choose their files; plain Quarks JSON keeps using textures this effect already carries."
            text={importText}
            error={importError}
            busy={contentSave.isBusy}
            ariaLabel="Particle VFX JSON"
            importLabel="Import effect"
            onTextChange={setImportText}
            onImport={() => void handleImportJson()}
          />
          <ParticleVFXExportJsonDialog
            open={jsonViewerOpen}
            onOpenChange={setJsonViewerOpen}
            assetPath={exportBundle?.assetPath ?? null}
            payload={jsonViewerPayload}
            expandMode={jsonExpandMode}
            resetToken={jsonResetToken}
            onReset={resetJsonTree}
            bundle={exportBundle}
            copiedTarget={copiedTarget}
            onCopy={(target, value) => void copyText(target, value)}
            onDownload={() => exportBundle && downloadJson(exportBundle)}
          />
          <CreatorLeaveDialog
            guard={leaveGuard}
            contentLabel="Particle Effect"
          />
          {templateDraftDialog}
        </>
      }
    />
  );
}

/** Local-only transport and duration lane for the route-owned VFX preview. */
function ParticleVFXPreviewTimeline({
  emitters,
  activeEmitterPath,
  durationSec,
  revision,
  playing,
  ready,
  onSelectEmitter,
  onTogglePlayback,
  onStop,
  onRestart,
  onPlaybackEnded,
}: {
  emitters: readonly ParticleVFXEmitterDraft[];
  activeEmitterPath: string | null;
  durationSec: number;
  revision: number;
  playing: boolean;
  ready: boolean;
  onSelectEmitter: (path: string) => void;
  onTogglePlayback: () => void;
  onStop: () => void;
  onRestart: () => void;
  onPlaybackEnded: () => void;
}) {
  const [timeSec, setTimeSec] = useState(0);
  const timeRef = useRef(0);

  useEffect(() => {
    timeRef.current = 0;
    setTimeSec(0);
  }, [revision]);
  useEffect(() => {
    if (!playing || !ready) return;
    let previousTick = performance.now();
    const interval = window.setInterval(() => {
      const nextTick = performance.now();
      const elapsedSec = (nextTick - previousTick) / 1000;
      previousTick = nextTick;
      const nextTime = Math.min(durationSec, timeRef.current + elapsedSec);
      timeRef.current = nextTime;
      setTimeSec(nextTime);
      if (nextTime >= durationSec) onPlaybackEnded();
    }, 50);
    return () => window.clearInterval(interval);
  }, [durationSec, onPlaybackEnded, playing, ready]);

  const handleTogglePlayback = () => {
    if (!playing && timeSec >= durationSec) {
      onRestart();
      return;
    }
    onTogglePlayback();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-border/60 border-b px-3 py-2">
        <CreatorTimelineToolbar
          leading={
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Preview Timeline</h2>
              <p className="text-muted-foreground text-2xs">
                {emitters.length} emitter{emitters.length === 1 ? "" : "s"}
              </p>
            </div>
          }
          transport={
            <CreatorTimelineTransport
              playing={playing && ready}
              onTogglePlayback={handleTogglePlayback}
              onStop={onStop}
              onRestart={onRestart}
              playDisabled={!ready}
              label="effect preview"
            />
          }
          trailing={
            <div className="flex items-center gap-3">
              <output
                className="text-sm font-medium tabular-nums"
                aria-label="Effect preview time"
              >
                {timeSec.toFixed(2)}s
              </output>
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    playing && ready ? "bg-primary" : "bg-muted-foreground/50",
                  )}
                />
                {!ready ? "Loading" : playing ? "Playing" : "Paused"}
              </span>
            </div>
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="relative"
          style={{
            minHeight:
              RULER_HEIGHT_PX +
              Math.max(1, emitters.length) * LANE_HEIGHT_PX +
              12,
          }}
        >
          <CreatorTimelineRuler durationSec={durationSec} />
          {emitters.map((emitter, index) => (
            <CreatorTimelineLane
              key={emitter.path}
              index={index}
              label={emitter.name}
              selected={emitter.path === activeEmitterPath}
              onSelect={() => onSelectEmitter(emitter.path)}
            >
              <button
                type="button"
                aria-label={`Select emitter ${emitter.name}`}
                aria-pressed={emitter.path === activeEmitterPath}
                onClick={() => onSelectEmitter(emitter.path)}
                className="bg-primary/20 border-primary/25 pointer-events-auto absolute inset-y-1 rounded border"
                style={{
                  left: TRACK_LABEL_RAIL_PX,
                  right: TRACK_RIGHT_INSET_PX,
                }}
              />
            </CreatorTimelineLane>
          ))}
          <CreatorTimelinePlayhead
            timeSec={timeSec}
            durationSec={durationSec}
          />
        </div>
      </div>
    </div>
  );
}

function ParticleVFXExportJsonDialog({
  open,
  onOpenChange,
  assetPath,
  payload,
  expandMode,
  resetToken,
  onReset,
  bundle,
  copiedTarget,
  onCopy,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetPath: string | null;
  payload: ParticleVFXEditorExportJsonViewerPayload;
  expandMode: JsonExpandMode;
  resetToken: number;
  onReset: (mode: JsonExpandMode) => void;
  bundle: ParticleVFXEditorExport | null;
  copiedTarget: string | null;
  onCopy: (target: string, value: string) => void;
  onDownload: () => void;
}) {
  return (
    <CreatorJsonDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Particle VFX export"
      description={assetPath ?? "Current export payload"}
      contentClassName="max-h-[86vh] max-w-[calc(100vw-2rem)] sm:max-w-[980px]"
      bodyClassName="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" size="sm" onClick={onDownload} disabled={!bundle}>
          <DownloadIcon /> Download JSON
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onReset("smart")}
        >
          Reset view
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onReset("all")}
        >
          Expand all
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onReset("collapsed")}
        >
          Collapse all
        </Button>
      </div>

      {bundle ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Creator document, catalog settings and clip event
          </summary>
          <div className="mt-3 space-y-4">
            <ExportBlock
              title="Creator document (Import keeps the name and settings)"
              value={bundle.creatorDocument}
              copied={copiedTarget === "document"}
              onCopy={() => onCopy("document", bundle.creatorDocument)}
            />
            <ExportBlock
              title="Catalog settings"
              value={bundle.catalogEntrySnippet}
              copied={copiedTarget === "catalog"}
              onCopy={() => onCopy("catalog", bundle.catalogEntrySnippet)}
            />
            <ExportBlock
              title="Clip event"
              value={bundle.clipEventSnippet}
              copied={copiedTarget === "clip"}
              onCopy={() => onCopy("clip", bundle.clipEventSnippet)}
            />
          </div>
        </details>
      ) : null}
      {payload.error ? (
        <div className="border-destructive/30 text-destructive bg-destructive/10 rounded-md border p-3 text-sm">
          {payload.error}
        </div>
      ) : payload.value ? (
        <div className="border-border/60 bg-background/80 rounded-md border p-3">
          <div className="text-muted-foreground mb-3 font-mono text-xs">
            Exact export JSON
          </div>
          <div className="max-h-[60vh] overflow-auto pr-2">
            <JsonTreeNode
              key={`particle-vfx-export:${expandMode}:${resetToken}`}
              label={null}
              value={payload.value}
              depth={0}
              expandMode={expandMode}
            />
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground rounded-md border p-3 text-sm">
          No export JSON is available.
        </div>
      )}
    </CreatorJsonDialog>
  );
}

function ParticleVFXCreatorPreview({
  json,
  catalog,
  revision,
  playing,
  showAvatar,
  showEmitterOutline,
  activeEmitter,
  previewAvatar,
  modelEntry,
  modelEntryKey,
  onAvatarChange,
  onAvatarStatusChange,
  onStatusChange,
}: {
  json: Record<string, unknown> | null;
  catalog: ParticleVFXEditorCatalogDraft | null;
  revision: number;
  playing: boolean;
  showAvatar: boolean;
  showEmitterOutline: boolean;
  activeEmitter: ParticleVFXEmitterDraft | null;
  previewAvatar: Avatar | null;
  modelEntry: RuntimeCatalogEntry | null;
  modelEntryKey: string | null;
  onAvatarChange: (avatar: Avatar | null) => void;
  onAvatarStatusChange: (status: PreviewStatus) => void;
  onStatusChange: (status: PreviewStatus) => void;
}) {
  const [previewObject, setPreviewObject] = useState<THREE.Object3D | null>(
    null,
  );
  const selectedPreviewEmitter = useMemo(() => {
    let object: THREE.Object3D | undefined = previewObject ?? undefined;
    const indices = activeEmitter?.path.match(/children\/(\d+)/g) ?? [];
    for (const segment of indices)
      object = object?.children[Number(segment.split("/")[1])];
    return object?.type === "ParticleEmitter" ? object : null;
  }, [activeEmitter?.path, previewObject]);
  const cameraSettings = showAvatar
    ? PARTICLE_VFX_CREATOR_AVATAR_CAMERA_SETTINGS
    : PARTICLE_VFX_CREATOR_EMITTER_CAMERA_SETTINGS;

  return (
    <AvatarPreviewSurface
      activeAvatar={previewAvatar}
      cameraProfile="custom"
      cameraSettings={cameraSettings}
      canvasTestId="particle-vfx-creator-canvas"
      lifecycleOwner="creator"
      minDistance={0.1}
      maxDistance={15}
      showSceneVFX={false}
    >
      <gridHelper
        args={[3, 12, "#3f3f46", "#27272a"]}
        position={[0, -0.55, 0]}
      />
      {showAvatar && modelEntry && modelEntryKey ? (
        <ParticleVFXCreatorPreviewAvatar
          entry={modelEntry}
          entryKey={modelEntryKey}
          onAvatarChange={onAvatarChange}
          onStatusChange={onAvatarStatusChange}
        />
      ) : null}
      {json ? (
        <QuarksPreviewObject
          json={json}
          catalog={catalog}
          revision={revision}
          playing={playing}
          useAvatarPlacement={showAvatar}
          avatar={showAvatar ? previewAvatar : null}
          onStatusChange={onStatusChange}
          onObjectChange={setPreviewObject}
        />
      ) : null}
      {showEmitterOutline && activeEmitter ? (
        <ParticleVFXCreatorEmitterShapeOutline
          emitter={activeEmitter}
          runtimeEmitter={selectedPreviewEmitter}
        />
      ) : null}
    </AvatarPreviewSurface>
  );
}

function ParticleVFXCreatorPreviewAvatar({
  entry,
  entryKey,
  onAvatarChange,
  onStatusChange,
}: {
  entry: RuntimeCatalogEntry;
  entryKey: string;
  onAvatarChange: (avatar: Avatar | null) => void;
  onStatusChange: (status: PreviewStatus) => void;
}) {
  const { sceneObject } = useContentCreatorAvatar({
    entry,
    entryKey,
    onAvatarChange,
    onStatusChange,
  });

  if (!sceneObject) return null;
  return <primitive object={sceneObject} dispose={null} />;
}

function QuarksPreviewObject({
  json,
  catalog,
  revision,
  playing,
  useAvatarPlacement,
  avatar,
  onStatusChange,
  onObjectChange,
}: {
  json: Record<string, unknown>;
  catalog: ParticleVFXEditorCatalogDraft | null;
  revision: number;
  playing: boolean;
  useAvatarPlacement: boolean;
  avatar: Avatar | null;
  onStatusChange: (status: PreviewStatus) => void;
  onObjectChange: (object: THREE.Object3D | null) => void;
}) {
  const groupRef = useState(() => new THREE.Group())[0];
  const bindingsRef = useRef<ParticleVFXEmitterAnchorBindings | null>(null);
  const followRef = useRef(false);
  const [batchRenderer, setBatchRenderer] =
    useState<PreviewBatchRenderer | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeObject: THREE.Object3D | null = null;
    let activeBatch: PreviewBatchRenderer | null = null;
    let quarks: ThreeQuarksModule | null = null;
    groupRef.clear();
    bindingsRef.current = null;
    setBatchRenderer(null);
    onStatusChange({ state: "loading", message: null });

    import("three.quarks")
      .then((module) => {
        if (disposed) return;
        quarks = module;
        const loader = new module.QuarksLoader();
        const batch = createParticleVFXBatchedRenderer(
          module,
        ) as PreviewBatchRenderer;
        batch.name = "ParticleVFXCreatorPreviewBatch";
        const previewJson = JSON.parse(JSON.stringify(json)) as unknown;
        loader.parse(previewJson, (parsedObject) => {
          const object = createParticleVFXEffectContainer(parsedObject);
          if (disposed) {
            disposePreviewObject(module, object, batch);
            return;
          }
          object.name = object.name || "ParticleVFXCreatorPreviewObject";
          const bindings = createParticleVFXEmitterAnchorBindings(object);
          if (useAvatarPlacement && catalog) {
            applyCreatorPreviewPlacement(object, catalog, avatar);
          }
          let usesWorldSpace = false;
          object.traverse((child) => {
            if (
              (child as THREE.Object3D & { system?: { worldSpace?: boolean } })
                .system?.worldSpace
            )
              usesWorldSpace = true;
          });
          followRef.current = !!catalog?.defaultFollowAnchor && !usesWorldSpace;
          module.QuarksUtil.addToBatchRenderer(object, batch);
          module.QuarksUtil.setAutoDestroy(object, false);
          module.QuarksUtil.play(object);
          activeObject = object;
          activeBatch = batch;
          groupRef.add(batch);
          groupRef.add(object);
          bindingsRef.current = bindings;
          if (useAvatarPlacement && catalog) {
            updateParticleVFXEmitterAnchors({
              bindings,
              avatar,
              defaultAnchor: catalog.defaultAnchor,
            });
          }
          onObjectChange(parsedObject);
          setBatchRenderer(batch);
          onStatusChange({ state: "ready", message: object.name });
        });
      })
      .catch((error) => {
        if (disposed) return;
        onStatusChange({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "Preview could not load three.quarks.",
        });
      });

    return () => {
      disposed = true;
      bindingsRef.current = null;
      onObjectChange(null);
      setBatchRenderer(null);
      if (quarks && (activeObject || activeBatch)) {
        disposePreviewObject(quarks, activeObject, activeBatch);
      }
      groupRef.clear();
    };
  }, [
    avatar,
    catalog,
    groupRef,
    json,
    onStatusChange,
    onObjectChange,
    revision,
    useAvatarPlacement,
  ]);

  useFrame((_, delta) => {
    if (!playing) return;
    const bindings = bindingsRef.current;
    if (bindings && useAvatarPlacement && catalog && followRef.current) {
      const placement = resolveParticleVFXCreatorPreviewPlacement({
        avatar,
        anchor: catalog.defaultAnchor,
        transform: catalog.defaultTransform,
      });
      bindings.object.position.set(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      );
      bindings.object.updateMatrixWorld(true);
      updateParticleVFXEmitterAnchors({
        bindings,
        avatar,
        defaultAnchor: catalog.defaultAnchor,
      });
    }
    batchRenderer?.update(delta);
  });

  return <primitive object={groupRef} />;
}

function applyCreatorPreviewPlacement(
  object: THREE.Object3D,
  catalog: ParticleVFXEditorCatalogDraft,
  avatar: Avatar | null,
) {
  const placement = resolveParticleVFXCreatorPreviewPlacement({
    avatar,
    anchor: catalog.defaultAnchor,
    transform: catalog.defaultTransform,
    shapeAutoFit: catalog.shapeAutoFit,
  });
  if (placement.autoFit) {
    applyParticleVFXRectangleShapeAutoFit({
      object,
      shapeAutoFit: catalog.shapeAutoFit,
      width: placement.autoFit.width,
      height: placement.autoFit.height,
    });
  }

  object.position.set(
    placement.position.x,
    placement.position.y,
    placement.position.z,
  );
  object.rotation.set(
    object.rotation.x + placement.rotation.x,
    object.rotation.y + placement.rotation.y,
    object.rotation.z + placement.rotation.z,
  );
  object.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
  object.updateMatrixWorld(true);
}

function ParticleVFXCreatorEmitterShapeOutline({
  emitter,
  runtimeEmitter,
}: {
  emitter: ParticleVFXEmitterDraft;
  runtimeEmitter: THREE.Object3D | null;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const outlineShape = useMemo(() => {
    const system = (
      runtimeEmitter as
        | (THREE.Object3D & {
            system?: {
              emitterShape?: { type?: string; width?: number; height?: number };
            };
          })
        | null
    )?.system;
    const shape = system?.emitterShape;
    return emitter.shape.type === "rectangle" && shape?.type === "rectangle"
      ? {
          ...emitter.shape,
          width: shape.width ?? emitter.shape.width,
          height: shape.height ?? emitter.shape.height,
        }
      : emitter.shape;
  }, [emitter.shape, runtimeEmitter]);
  const shapeGeometry = useMemo(
    () => createEmitterShapeOutlineGeometry(outlineShape),
    [outlineShape],
  );
  const directionGeometry = useMemo(
    () => createEmitterDirectionGuideGeometry(emitter.shape),
    [emitter.shape],
  );
  useEffect(() => () => shapeGeometry.dispose(), [shapeGeometry]);
  useEffect(() => () => directionGeometry?.dispose(), [directionGeometry]);

  // Read the actual emitter transform so pause, world-space safeguards, imported
  // hierarchies and independent anchors cannot diverge from the visible outline.
  useFrame(() => {
    const group = groupRef.current;
    if (!group || !runtimeEmitter) return;
    runtimeEmitter.updateWorldMatrix(true, false);
    group.parent?.updateWorldMatrix(true, false);
    group.matrix
      .copy(group.parent?.matrixWorld ?? new THREE.Matrix4())
      .invert()
      .multiply(runtimeEmitter.matrixWorld);
    group.matrixWorldNeedsUpdate = true;
  });

  return (
    <group ref={groupRef} visible={!!runtimeEmitter} matrixAutoUpdate={false}>
      <lineSegments geometry={shapeGeometry} renderOrder={1000}>
        <lineBasicMaterial
          color="#f59e0b"
          transparent
          opacity={0.95}
          depthTest={false}
        />
      </lineSegments>
      {directionGeometry ? (
        <lineSegments geometry={directionGeometry} renderOrder={1001}>
          <lineBasicMaterial
            color="#38bdf8"
            transparent
            opacity={0.7}
            depthTest={false}
          />
        </lineSegments>
      ) : null}
    </group>
  );
}

function createEmitterShapeOutlineGeometry(
  shape: ParticleVFXEmitterDraft["shape"],
): THREE.BufferGeometry {
  const radius = Math.max(0.001, shape.radius);
  const arc = normalizeShapeArc(shape.arc);
  const innerRadius = Math.max(0, radius * (1 - clampUnit(shape.thickness)));
  const points: THREE.Vector3[] = [];

  if (shape.type === "point") {
    addLine(points, [-0.08, 0, 0], [0.08, 0, 0]);
    addLine(points, [0, -0.08, 0], [0, 0.08, 0]);
    addLine(points, [0, 0, -0.08], [0, 0, 0.08]);
  } else if (shape.type === "rectangle") {
    addRectangleSegments(points, shape.width, shape.height);
    const innerScale = Math.max(0, 1 - clampUnit(shape.thickness));
    if (innerScale > 0.001 && innerScale < 0.999) {
      addRectangleSegments(
        points,
        shape.width * innerScale,
        shape.height * innerScale,
      );
    }
  } else if (shape.type === "cone") {
    addArcSegments(points, radius, arc, "xy", 0);
    if (innerRadius > 0.001) {
      addArcSegments(points, innerRadius, arc, "xy", 0);
    }
    if (!isFullArc(arc)) {
      addLine(points, [innerRadius, 0, 0], [radius, 0, 0]);
      addLine(
        points,
        [innerRadius * Math.cos(arc), innerRadius * Math.sin(arc), 0],
        [radius * Math.cos(arc), radius * Math.sin(arc), 0],
      );
    } else {
      addLine(points, [-radius, 0, 0], [radius, 0, 0]);
      addLine(points, [0, -radius, 0], [0, radius, 0]);
    }
  } else {
    addSphereOutlineSegments(points, radius, arc);
    if (innerRadius > 0.001) {
      addSphereOutlineSegments(points, innerRadius, arc);
    }
  }

  return pointsToLineSegmentsGeometry(points);
}

function addRectangleSegments(
  points: THREE.Vector3[],
  width: number,
  height: number,
): void {
  const halfWidth = Math.max(0.001, width) / 2;
  const halfHeight = Math.max(0.001, height) / 2;
  const corners: Array<[number, number, number]> = [
    [-halfWidth, -halfHeight, 0],
    [halfWidth, -halfHeight, 0],
    [halfWidth, halfHeight, 0],
    [-halfWidth, halfHeight, 0],
  ];
  for (let index = 0; index < corners.length; index += 1) {
    addLine(points, corners[index], corners[(index + 1) % corners.length]);
  }
}

function createEmitterDirectionGuideGeometry(
  shape: ParticleVFXEmitterDraft["shape"],
): THREE.BufferGeometry | null {
  if (shape.type !== "cone") return null;
  const radius = Math.max(0.001, shape.radius);
  const arc = normalizeShapeArc(shape.arc);
  const guideLength = Math.max(0.18, radius);
  const guideRadius = Math.tan(Math.max(0, shape.angle)) * guideLength;
  const points: THREE.Vector3[] = [];
  const samples = isFullArc(arc)
    ? [0, Math.PI / 2, Math.PI, Math.PI * 1.5]
    : [0, arc];

  for (const theta of samples) {
    addLine(
      points,
      [0, 0, 0],
      [
        guideRadius * Math.cos(theta),
        guideRadius * Math.sin(theta),
        guideLength,
      ],
    );
  }
  addArcSegments(points, guideRadius, arc, "xy", guideLength);
  return pointsToLineSegmentsGeometry(points);
}

function addSphereOutlineSegments(
  points: THREE.Vector3[],
  radius: number,
  arc: number,
): void {
  if (isFullArc(arc)) {
    addArcSegments(points, radius, Math.PI * 2, "xy", 0);
    addArcSegments(points, radius, Math.PI * 2, "xz", 0);
    addArcSegments(points, radius, Math.PI * 2, "yz", 0);
    return;
  }

  addArcSegments(points, radius, arc, "xy", 0);
  addVerticalSphereArc(points, radius, 0);
  addVerticalSphereArc(points, radius, arc);
}

function addVerticalSphereArc(
  points: THREE.Vector3[],
  radius: number,
  theta: number,
): void {
  const segments = 48;
  for (let index = 0; index < segments; index += 1) {
    const phiA = (index / segments) * Math.PI;
    const phiB = ((index + 1) / segments) * Math.PI;
    addLine(
      points,
      [
        radius * Math.sin(phiA) * Math.cos(theta),
        radius * Math.sin(phiA) * Math.sin(theta),
        radius * Math.cos(phiA),
      ],
      [
        radius * Math.sin(phiB) * Math.cos(theta),
        radius * Math.sin(phiB) * Math.sin(theta),
        radius * Math.cos(phiB),
      ],
    );
  }
}

function addArcSegments(
  points: THREE.Vector3[],
  radius: number,
  arc: number,
  plane: "xy" | "xz" | "yz",
  offset: number,
): void {
  const segments = Math.max(12, Math.ceil((arc / (Math.PI * 2)) * 96));
  for (let index = 0; index < segments; index += 1) {
    const thetaA = (index / segments) * arc;
    const thetaB = ((index + 1) / segments) * arc;
    addLine(
      points,
      pointOnArc(radius, thetaA, plane, offset),
      pointOnArc(radius, thetaB, plane, offset),
    );
  }
}

function pointOnArc(
  radius: number,
  theta: number,
  plane: "xy" | "xz" | "yz",
  offset: number,
): [number, number, number] {
  if (plane === "xz") {
    return [radius * Math.cos(theta), offset, radius * Math.sin(theta)];
  }
  if (plane === "yz") {
    return [offset, radius * Math.cos(theta), radius * Math.sin(theta)];
  }
  return [radius * Math.cos(theta), radius * Math.sin(theta), offset];
}

function addLine(
  points: THREE.Vector3[],
  a: [number, number, number],
  b: [number, number, number],
): void {
  points.push(new THREE.Vector3(...a), new THREE.Vector3(...b));
}

function pointsToLineSegmentsGeometry(
  points: THREE.Vector3[],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setFromPoints(points);
  return geometry;
}

function normalizeShapeArc(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Math.PI * 2;
  return Math.min(value, Math.PI * 2);
}

function isFullArc(arc: number): boolean {
  return arc >= Math.PI * 2 - 0.001;
}

function disposePreviewObject(
  quarks: ThreeQuarksModule,
  object: THREE.Object3D | null,
  batch: PreviewBatchRenderer | null,
) {
  if (object) {
    try {
      quarks.QuarksUtil.stop(object);
      quarks.QuarksUtil.runOnAllParticleEmitters(
        object,
        (emitter: PreviewEmitter) => {
          emitter.system?.stop?.();
          emitter.system?.dispose?.();
        },
      );
    } catch {
      // Preview cleanup should not mask route unmounts or JSON load retries.
    }
  }
  object?.parent?.remove(object);
  batch?.parent?.remove(batch);
  batch?.dispose?.();
}

/** Summarize the selected emitter's own emission, without repeating the effect budget. */
function emitterSummary(emitter: ParticleVFXEmitterDraft): string {
  const range = (value: ParticleVFXEditorValueRange | null) =>
    value
      ? value.min === value.max
        ? `${value.min}`
        : `${value.min}–${value.max}`
      : "custom";
  const shape =
    emitter.shape.type[0].toUpperCase() + emitter.shape.type.slice(1);
  return `${shape} · ${range(emitter.emissionOverTime)}/s${emitter.burstCount && emitter.burstCount.max > 0 ? ` · burst ${range(emitter.burstCount)}` : ""}`;
}

type EmitterTextureControls = {
  files: ParticleVFXEditorDraft["textureFiles"];
  urls: ReadonlyMap<string, string>;
  missing: readonly string[];
  error: string | null;
  busy: boolean;
  onImport: (file: File) => void;
  onSupply: (reference: string, file: File) => void;
};

function EmitterAuthoringTabs({
  draft,
  activeEmitter,
  activeEmitterPath,
  onSelectEmitter,
  onPatch,
  textures,
}: {
  draft: ParticleVFXEditorDraft | null;
  activeEmitter: ParticleVFXEmitterDraft | null;
  activeEmitterPath: string | null;
  onSelectEmitter: (path: string) => void;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
  textures: EmitterTextureControls;
}) {
  return (
    <CreatorFloatingPanel
      title="Inspector"
      headerActions={
        <Input
          aria-label="Emitter name"
          value={activeEmitter?.name ?? ""}
          placeholder="Select an emitter"
          disabled={!activeEmitter}
          onChange={(event) => onPatch({ name: event.target.value })}
          className="h-8 min-w-0 flex-1 text-sm"
        />
      }
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="border-border border-b p-3">
        <Select
          onValueChange={(value) =>
            onPatch({
              emitterTemplateId: value as ParticleVFXEditorEmitterTemplateId,
            })
          }
          disabled={!activeEmitter}
        >
          <SelectTrigger
            className="w-full"
            size="sm"
            aria-label="Apply emitter preset"
          >
            <SelectValue placeholder="Apply emitter preset" />
          </SelectTrigger>
          <SelectContent>
            {PARTICLE_VFX_EDITOR_EMITTER_TEMPLATES.map((template) => (
              <SelectItem key={template.id} value={template.id}>
                {template.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground mt-2 text-xs">
          Replaces settings on the selected emitter.
        </p>
      </div>
      <div className="border-border border-b p-3 lg:hidden">
        <Select
          value={activeEmitterPath ?? undefined}
          onValueChange={onSelectEmitter}
          disabled={!draft || draft.emitters.length === 0}
        >
          <SelectTrigger className="w-[220px] lg:hidden" size="sm">
            <SelectValue placeholder="Select emitter" />
          </SelectTrigger>
          <SelectContent>
            {draft?.emitters.map((emitter) => (
              <SelectItem key={emitter.path} value={emitter.path}>
                {emitter.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!activeEmitter ? (
        <div className="text-muted-foreground flex min-h-[240px] flex-1 items-center justify-center p-6 text-sm">
          Select or add an emitter.
        </div>
      ) : (
        <Tabs
          defaultValue="appearance"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-border overflow-x-auto border-b px-3 py-2">
            <TabsList className="grid h-8 w-full grid-cols-5 p-0.5">
              <TabsTrigger className="text-2xs h-7 px-1" value="appearance">
                Appearance
              </TabsTrigger>
              <TabsTrigger className="text-2xs h-7 px-1" value="position">
                Position
              </TabsTrigger>
              <TabsTrigger className="text-2xs h-7 px-1" value="emission">
                Emission
              </TabsTrigger>
              <TabsTrigger className="text-2xs h-7 px-1" value="shape">
                Shape
              </TabsTrigger>
              <TabsTrigger className="text-2xs h-7 px-1" value="behavior">
                Behavior
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <TabsContent value="position" className="mt-0">
              <EmitterSystemPanel emitter={activeEmitter} onPatch={onPatch} />
            </TabsContent>
            <TabsContent value="emission" className="mt-0">
              <EmitterEmissionPanel emitter={activeEmitter} onPatch={onPatch} />
            </TabsContent>
            <TabsContent value="shape" className="mt-0">
              <EmitterShapePanel emitter={activeEmitter} onPatch={onPatch} />
            </TabsContent>
            <TabsContent value="behavior" className="mt-0">
              <EmitterBehaviorPanel emitter={activeEmitter} onPatch={onPatch} />
            </TabsContent>
            <TabsContent value="appearance" className="mt-0 space-y-6">
              <section>
                <h3 className="mb-3 text-xs font-semibold tracking-wide uppercase">
                  Texture
                </h3>
                <EmitterTexturePanel
                  emitter={activeEmitter}
                  onPatch={onPatch}
                  textures={textures}
                />
              </section>
              <section className="border-border border-t pt-5">
                <h3 className="mb-3 text-xs font-semibold tracking-wide uppercase">
                  Color
                </h3>
                <EmitterColorPanel emitter={activeEmitter} onPatch={onPatch} />
              </section>
              <section className="border-border border-t pt-5">
                <h3 className="mb-3 text-xs font-semibold tracking-wide uppercase">
                  Renderer
                </h3>
                <EmitterRendererPanel
                  emitter={activeEmitter}
                  onPatch={onPatch}
                />
              </section>
            </TabsContent>
          </div>
        </Tabs>
      )}
    </CreatorFloatingPanel>
  );
}

function EmitterSystemPanel({
  emitter,
  onPatch,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
}) {
  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-semibold">Cycle</legend>
        <NumberField
          label="Emitter cycle duration (s)"
          value={emitter.durationSec ?? 0}
          min={0.01}
          step={0.01}
          onChange={(value) => onPatch({ durationSec: value })}
        />
        <CheckboxField
          label="Loop this emitter"
          checked={emitter.looping}
          onChange={(value) => onPatch({ looping: value })}
        />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-semibold">
          Anchor and position
        </legend>
        <SelectField
          label="Anchor override"
          value={emitter.anchor ?? "inherit"}
          values={["inherit", ...PARTICLE_VFX_ANCHORS]}
          labels={{ inherit: "Inherit default anchor" }}
          onChange={(value) =>
            onPatch({
              anchor: value === "inherit" ? null : (value as ParticleVFXAnchor),
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          Offsets are relative to this emitter’s resolved anchor.
        </p>
        {(["x", "y", "z"] as const).map((axis) => (
          <NumberField
            key={axis}
            label={`Position ${axis.toUpperCase()} (m)`}
            value={emitter.localPosition[axis]}
            step={0.05}
            onChange={(value) => onPatch({ localPosition: { [axis]: value } })}
          />
        ))}
        <CheckboxField
          label="Keep emitted particles in world space"
          checked={emitter.worldSpace}
          onChange={(value) => onPatch({ worldSpace: value })}
        />
      </fieldset>
    </div>
  );
}

function EmitterTexturePanel({
  emitter,
  onPatch,
  textures,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
  textures: EmitterTextureControls;
}) {
  const selectedTexture = PARTICLE_VFX_EDITOR_TEXTURES.find(
    (texture) => texture.id === emitter.textureId,
  );
  const tileCapacity =
    emitter.renderer.uTileCount * emitter.renderer.vTileCount;
  const frameOverLifeEnabled = emitter.frameOverLife.mode !== "off";
  const frameStart = Math.max(0, Math.round(emitter.frameOverLife.startFrame));
  const frameEnd = Math.max(0, Math.round(emitter.frameOverLife.endFrame));
  const patchFrameOverLife = (patch: {
    startFrame?: number;
    endFrame?: number;
  }) =>
    onPatch({
      frameOverLifeDraft: {
        mode: "linear",
        startFrame: patch.startFrame ?? frameStart,
        endFrame: patch.endFrame ?? frameEnd,
      },
    });
  const setFrameOverLifeEnabled = (enabled: boolean) => {
    if (!enabled) {
      onPatch({
        frameOverLifeDraft: {
          mode: "off",
          startFrame: frameStart,
          endFrame: frameEnd,
        },
      });
      return;
    }
    const recommended = selectedTexture?.atlas?.frameOverLife;
    onPatch({
      frameOverLifeDraft: {
        mode: "linear",
        startFrame: recommended?.startFrame ?? frameStart,
        endFrame: recommended?.endFrame ?? Math.max(0, tileCapacity - 1),
      },
    });
  };

  return (
    <div className="grid gap-3">
      <EmitterCarriedTextures
        emitter={emitter}
        textureFiles={textures.files}
        textureUrls={textures.urls}
        missingReferences={textures.missing}
        error={textures.error}
        busy={textures.busy}
        onSelect={(reference) => onPatch({ textureReference: reference })}
        onImport={textures.onImport}
        onSupply={textures.onSupply}
      />
      <div className="grid gap-4">
        {PARTICLE_VFX_TEXTURE_GROUPS.map((group) => (
          <section key={group.role} className="grid gap-2">
            <div className="text-muted-foreground text-xs font-semibold uppercase">
              {group.label}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {group.textures.map((texture) => (
                <button
                  key={texture.id}
                  type="button"
                  className={cn(
                    "border-border hover:bg-muted/60 flex items-center gap-3 rounded-md border p-2 text-left text-sm transition-colors",
                    texture.id === emitter.textureId &&
                      "border-primary bg-primary/10",
                  )}
                  onClick={() => onPatch({ textureId: texture.id })}
                >
                  <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded border">
                    <img
                      src={texture.publicUrl}
                      alt=""
                      className="max-h-8 max-w-8 object-contain"
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {texture.label}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {texture.fileName}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="grid content-start gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
          <ImageIcon className="text-primary size-4" />
          Atlas
        </div>
        <NumberField
          label="U tiles"
          value={emitter.renderer.uTileCount}
          min={1}
          max={PARTICLE_TEXTURE_LIMITS.grid}
          step={1}
          onChange={(value) =>
            onPatch({ renderer: { uTileCount: Math.round(value) } })
          }
        />
        <NumberField
          label="V tiles"
          value={emitter.renderer.vTileCount}
          min={1}
          max={PARTICLE_TEXTURE_LIMITS.grid}
          step={1}
          onChange={(value) =>
            onPatch({ renderer: { vTileCount: Math.round(value) } })
          }
        />
        <CheckboxField
          label="Blend tiles"
          checked={emitter.renderer.blendTiles}
          onChange={(value) => onPatch({ renderer: { blendTiles: value } })}
        />
        <CheckboxField
          label="Animate frames"
          checked={frameOverLifeEnabled}
          onChange={setFrameOverLifeEnabled}
        />
        <NumberField
          label="Frame start"
          value={frameStart}
          min={0}
          step={1}
          disabled={!frameOverLifeEnabled}
          onChange={(value) =>
            patchFrameOverLife({ startFrame: Math.round(value) })
          }
        />
        <NumberField
          label="Frame end"
          value={frameEnd}
          min={0}
          step={1}
          disabled={!frameOverLifeEnabled}
          onChange={(value) =>
            patchFrameOverLife({ endFrame: Math.round(value) })
          }
        />
      </div>
    </div>
  );
}

function EmitterEmissionPanel({
  emitter,
  onPatch,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ValueRangeField
        label="Particle lifetime (s)"
        value={emitter.startLife}
        min={0}
        step={0.01}
        onChange={(value) => onPatch({ startLife: value })}
      />
      <ValueRangeField
        label="Initial speed (m/s)"
        value={emitter.startSpeed}
        min={0}
        step={0.01}
        onChange={(value) => onPatch({ startSpeed: value })}
      />
      <ValueRangeField
        label="Initial size (m)"
        value={emitter.startSize}
        min={0}
        step={0.01}
        onChange={(value) => onPatch({ startSize: value })}
      />
      <ValueRangeField
        label="Initial rotation (rad)"
        value={emitter.startRotation}
        step={0.01}
        onChange={(value) => onPatch({ startRotation: value })}
      />
      <ValueRangeField
        label="Particles per second"
        value={emitter.emissionOverTime}
        min={0}
        step={0.1}
        onChange={(value) => onPatch({ emissionOverTime: value })}
      />
      <ValueRangeField
        label="Particles per meter"
        value={emitter.emissionOverDistance}
        min={0}
        step={0.1}
        onChange={(value) => onPatch({ emissionOverDistance: value })}
      />
      <fieldset className="border-border space-y-3 border-t pt-3 sm:col-span-2">
        <legend className="text-xs font-semibold">Burst emission</legend>
        <ValueRangeField
          label="Burst count"
          value={emitter.burstCount}
          min={0}
          step={1}
          onChange={(value) => onPatch({ burstCount: value })}
        />
        {(emitter.burstCount?.max ?? 0) > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label="Burst time (s)"
              value={emitter.burst?.time ?? 0}
              min={0}
              step={0.01}
              onChange={(value) => onPatch({ burst: { time: value } })}
            />
            <NumberField
              label="Burst repetitions"
              value={emitter.burst?.cycle ?? 1}
              min={1}
              step={1}
              onChange={(value) => onPatch({ burst: { cycle: value } })}
            />
            {(emitter.burst?.cycle ?? 1) > 1 ? (
              <>
                <NumberField
                  label="Repeat interval (s)"
                  value={emitter.burst?.interval ?? 0.01}
                  min={0}
                  step={0.01}
                  onChange={(value) => onPatch({ burst: { interval: value } })}
                />
              </>
            ) : null}
            <NumberField
              label="Burst probability (0–1)"
              value={emitter.burst?.probability ?? 1}
              min={0}
              step={0.05}
              onChange={(value) => onPatch({ burst: { probability: value } })}
            />{" "}
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

function EmitterShapePanel({
  emitter,
  onPatch,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField
        label="Shape"
        value={
          emitter.shape.type === "unsupported" ? "sphere" : emitter.shape.type
        }
        values={PARTICLE_VFX_EDITOR_SHAPES}
        onChange={(value) =>
          onPatch({ shape: { type: value as ParticleVFXEditorShapeType } })
        }
      />
      {emitter.shape.type !== "point" ? (
        <>
          {emitter.shape.type === "rectangle" ? (
            <>
              <NumberField
                label="Width (m)"
                value={emitter.shape.width}
                min={0}
                step={0.01}
                onChange={(value) => onPatch({ shape: { width: value } })}
              />
              <NumberField
                label="Height (m)"
                value={emitter.shape.height}
                min={0}
                step={0.01}
                onChange={(value) => onPatch({ shape: { height: value } })}
              />
            </>
          ) : (
            <>
              <NumberField
                label="Radius (m)"
                value={emitter.shape.radius}
                min={0}
                step={0.01}
                onChange={(value) => onPatch({ shape: { radius: value } })}
              />
              <NumberField
                label="Arc (rad)"
                value={emitter.shape.arc}
                min={0}
                step={0.01}
                onChange={(value) => onPatch({ shape: { arc: value } })}
              />
            </>
          )}
          <NumberField
            label="Thickness"
            value={emitter.shape.thickness}
            min={0}
            step={0.01}
            onChange={(value) => onPatch({ shape: { thickness: value } })}
          />
          <NumberField
            label="Spread"
            value={emitter.shape.spread}
            step={0.01}
            onChange={(value) => onPatch({ shape: { spread: value } })}
          />
          <EmitterModeField
            value={emitter.shape.mode}
            onChange={(value) => onPatch({ shape: { mode: value } })}
          />
          <ValueRangeField
            label="Shape speed"
            value={emitter.shape.speed}
            min={0}
            step={0.01}
            onChange={(value) => onPatch({ shape: { speed: value } })}
          />
        </>
      ) : null}
      {emitter.shape.type === "cone" ? (
        <NumberField
          label="Angle (rad)"
          value={emitter.shape.angle}
          min={0}
          step={0.01}
          onChange={(value) => onPatch({ shape: { angle: value } })}
        />
      ) : null}
    </div>
  );
}

function EmitterModeField({
  value,
  onChange,
}: {
  value: ParticleVFXEditorEmitterMode;
  onChange: (value: ParticleVFXEditorEmitterMode) => void;
}) {
  return (
    <div>
      <Label className="text-xs">Mode</Label>
      <Select
        value={`${value}`}
        onValueChange={(nextValue) =>
          onChange(Number(nextValue) as ParticleVFXEditorEmitterMode)
        }
      >
        <SelectTrigger className="mt-1 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="0">Random</SelectItem>
          <SelectItem value="1">Loop</SelectItem>
          <SelectItem value="2">PingPong</SelectItem>
          <SelectItem value="3">Burst</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function EmitterBehaviorPanel({
  emitter,
  onPatch,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
}) {
  const advanced = emitter.advancedBehaviors;
  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        <CheckboxField
          label="Force over life"
          checked={!!emitter.forceOverLife}
          onChange={(value) => onPatch({ forceOverLifeEnabled: value })}
        />
        <CheckboxField
          label="Size over life"
          checked={emitter.hasSizeOverLife}
          onChange={(value) => onPatch({ sizeOverLife: value })}
        />
        <CheckboxField
          label="Color fade over life"
          checked={emitter.hasColorOverLife}
          onChange={(value) => onPatch({ colorOverLife: value })}
        />
      </div>
      {emitter.forceOverLife ? (
        <div className="grid gap-3">
          {(["x", "y", "z"] as const).map((axis) => (
            <ValueRangeField
              key={axis}
              label={`Force ${axis.toUpperCase()}`}
              value={emitter.forceOverLife?.[axis] ?? null}
              step={0.01}
              onChange={(value) =>
                onPatch({ forceOverLife: { [axis]: value } })
              }
              disabled={!emitter.forceOverLife}
            />
          ))}
        </div>
      ) : null}
      <div className="grid gap-3">
        <ValueBehaviorControls
          title="Speed over life"
          draft={advanced.speedOverLife}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { speedOverLife: value } })
          }
        />
        <ValueBehaviorControls
          title="Rotation over life"
          draft={advanced.rotationOverLife}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { rotationOverLife: value } })
          }
        />
        <LimitSpeedControls
          draft={advanced.limitSpeedOverLife}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { limitSpeedOverLife: value } })
          }
        />
        <ValueBehaviorControls
          title="Width over length"
          draft={advanced.widthOverLength}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { widthOverLength: value } })
          }
        />
        <OrbitControlsPanel
          draft={advanced.orbitOverLife}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { orbitOverLife: value } })
          }
        />
        <Rotation3DControlsPanel
          draft={advanced.rotation3DOverLife}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { rotation3DOverLife: value } })
          }
        />
        <NoiseControlsPanel
          draft={advanced.noise}
          onChange={(value) => onPatch({ advancedBehaviors: { noise: value } })}
        />
        <TurbulenceControlsPanel
          draft={advanced.turbulenceField}
          onChange={(value) =>
            onPatch({ advancedBehaviors: { turbulenceField: value } })
          }
        />
      </div>
    </div>
  );
}

function ValueBehaviorControls({
  title,
  draft,
  onChange,
}: {
  title: string;
  draft: ParticleVFXEditorValueBehaviorDraft;
  onChange: (draft: ParticleVFXEditorValueBehaviorDraft) => void;
}) {
  const enabled = draft.mode !== "off";
  const value = draft.value;
  const setEnabled = (nextEnabled: boolean) => {
    onChange({
      mode: nextEnabled ? "enabled" : "off",
      value: normalizeValueGeneratorDraft(value),
    });
  };
  return (
    <div className="grid content-start gap-3 rounded-md border p-3">
      <CheckboxField label={title} checked={enabled} onChange={setEnabled} />
      {draft.mode === "unsupported" ? (
        <UnsupportedBehaviorNotice
          label={draft.label}
          onConvert={() =>
            onChange({
              mode: "enabled",
              value: normalizeValueGeneratorDraft(value),
            })
          }
        />
      ) : null}
      <ValueGeneratorField
        label="Value"
        value={value}
        disabled={!enabled}
        onChange={(nextValue) =>
          onChange({
            mode: enabled ? "enabled" : "off",
            value: nextValue,
          })
        }
      />
    </div>
  );
}

function LimitSpeedControls({
  draft,
  onChange,
}: {
  draft: ParticleVFXEditorLimitSpeedOverLifeDraft;
  onChange: (draft: ParticleVFXEditorLimitSpeedOverLifeDraft) => void;
}) {
  const enabled = draft.mode !== "off";
  const setEnabled = (nextEnabled: boolean) => {
    onChange({
      mode: nextEnabled ? "enabled" : "off",
      speed: normalizeValueGeneratorDraft(draft.speed),
      dampen: draft.dampen,
    });
  };
  return (
    <div className="grid content-start gap-3 rounded-md border p-3">
      <CheckboxField
        label="Limit speed over life"
        checked={enabled}
        onChange={setEnabled}
      />
      {draft.mode === "unsupported" ? (
        <UnsupportedBehaviorNotice
          label={draft.label}
          onConvert={() =>
            onChange({
              mode: "enabled",
              speed: normalizeValueGeneratorDraft(draft.speed),
              dampen: draft.dampen,
            })
          }
        />
      ) : null}
      <ValueGeneratorField
        label="Speed"
        value={draft.speed}
        disabled={!enabled}
        onChange={(speed) =>
          onChange({
            mode: enabled ? "enabled" : "off",
            speed,
            dampen: draft.dampen,
          })
        }
      />
      <NumberField
        label="Dampen"
        value={draft.dampen}
        min={0}
        step={0.05}
        disabled={!enabled}
        onChange={(dampen) =>
          onChange({
            mode: enabled ? "enabled" : "off",
            speed: draft.speed,
            dampen,
          })
        }
      />
    </div>
  );
}

function OrbitControlsPanel({
  draft,
  onChange,
}: {
  draft: ParticleVFXEditorOrbitOverLifeDraft;
  onChange: (draft: ParticleVFXEditorOrbitOverLifeDraft) => void;
}) {
  const enabled = draft.mode !== "off";
  const setEnabled = (nextEnabled: boolean) => {
    onChange({
      mode: nextEnabled ? "enabled" : "off",
      orbitSpeed: normalizeValueGeneratorDraft(draft.orbitSpeed),
      axis: draft.axis,
    });
  };
  return (
    <div className="grid content-start gap-3 rounded-md border p-3">
      <CheckboxField
        label="Orbit over life"
        checked={enabled}
        onChange={setEnabled}
      />
      {draft.mode === "unsupported" ? (
        <UnsupportedBehaviorNotice
          label={draft.label}
          onConvert={() =>
            onChange({
              mode: "enabled",
              orbitSpeed: normalizeValueGeneratorDraft(draft.orbitSpeed),
              axis: draft.axis,
            })
          }
        />
      ) : null}
      <ValueGeneratorField
        label="Orbit speed"
        value={draft.orbitSpeed}
        disabled={!enabled}
        onChange={(orbitSpeed) =>
          onChange({
            mode: enabled ? "enabled" : "off",
            orbitSpeed,
            axis: draft.axis,
          })
        }
      />
      <AxisTripleFields
        label="Axis"
        value={draft.axis}
        disabled={!enabled}
        onChange={(axis) =>
          onChange({
            mode: enabled ? "enabled" : "off",
            orbitSpeed: draft.orbitSpeed,
            axis,
          })
        }
      />
    </div>
  );
}

function Rotation3DControlsPanel({
  draft,
  onChange,
}: {
  draft: ParticleVFXEditorRotation3DOverLifeDraft;
  onChange: (draft: ParticleVFXEditorRotation3DOverLifeDraft) => void;
}) {
  const mode = draft.mode === "unsupported" ? "off" : draft.mode;
  const setMode = (nextMode: string) => {
    if (nextMode === "off") onChange({ mode: "off" });
    if (nextMode === "random") onChange({ mode: "random" });
    if (nextMode === "axis-angle") {
      onChange({
        mode: "axis-angle",
        axis: draft.mode === "axis-angle" ? draft.axis : { x: 0, y: 1, z: 0 },
        angle:
          draft.mode === "axis-angle"
            ? normalizeValueGeneratorDraft(draft.angle)
            : { mode: "constant", value: 0 },
      });
    }
    if (nextMode === "euler") {
      onChange({
        mode: "euler",
        angleX:
          draft.mode === "euler"
            ? normalizeValueGeneratorDraft(draft.angleX)
            : { mode: "constant", value: 0 },
        angleY:
          draft.mode === "euler"
            ? normalizeValueGeneratorDraft(draft.angleY)
            : { mode: "constant", value: 0 },
        angleZ:
          draft.mode === "euler"
            ? normalizeValueGeneratorDraft(draft.angleZ)
            : { mode: "constant", value: 0 },
        eulerOrder: draft.mode === "euler" ? draft.eulerOrder : "XYZ",
      });
    }
  };
  return (
    <div className="grid content-start gap-3 rounded-md border p-3">
      <SelectField
        label="Rotation 3D"
        value={mode}
        values={["off", "axis-angle", "euler", "random"] as const}
        onChange={setMode}
      />
      {draft.mode === "unsupported" ? (
        <UnsupportedBehaviorNotice
          label={draft.label}
          onConvert={() => setMode("axis-angle")}
        />
      ) : null}
      {draft.mode === "axis-angle" ? (
        <>
          <AxisTripleFields
            label="Axis"
            value={draft.axis}
            onChange={(axis) => onChange({ ...draft, axis })}
          />
          <ValueGeneratorField
            label="Angle (rad)"
            value={draft.angle}
            onChange={(angle) => onChange({ ...draft, angle })}
          />
        </>
      ) : null}
      {draft.mode === "euler" ? (
        <>
          <SelectField
            label="Euler order"
            value={draft.eulerOrder}
            values={["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"] as const}
            onChange={(eulerOrder) => onChange({ ...draft, eulerOrder })}
          />
          <ValueGeneratorField
            label="Angle X"
            value={draft.angleX}
            onChange={(angleX) => onChange({ ...draft, angleX })}
          />
          <ValueGeneratorField
            label="Angle Y"
            value={draft.angleY}
            onChange={(angleY) => onChange({ ...draft, angleY })}
          />
          <ValueGeneratorField
            label="Angle Z"
            value={draft.angleZ}
            onChange={(angleZ) => onChange({ ...draft, angleZ })}
          />
        </>
      ) : null}
    </div>
  );
}

function NoiseControlsPanel({
  draft,
  onChange,
}: {
  draft: ParticleVFXEditorNoiseDraft;
  onChange: (draft: ParticleVFXEditorNoiseDraft) => void;
}) {
  const enabled = draft.mode !== "off";
  const setEnabled = (nextEnabled: boolean) => {
    onChange({
      mode: nextEnabled ? "enabled" : "off",
      frequency: normalizeValueGeneratorDraft(draft.frequency),
      power: normalizeValueGeneratorDraft(draft.power),
      positionAmount: normalizeValueGeneratorDraft(draft.positionAmount),
      rotationAmount: normalizeValueGeneratorDraft(draft.rotationAmount),
    });
  };
  const patch =
    (field: "frequency" | "power" | "positionAmount" | "rotationAmount") =>
    (value: ParticleVFXEditorValueGeneratorDraft) => {
      onChange({
        mode: enabled ? "enabled" : "off",
        frequency: draft.frequency,
        power: draft.power,
        positionAmount: draft.positionAmount,
        rotationAmount: draft.rotationAmount,
        [field]: value,
      });
    };
  return (
    <div className="grid content-start gap-3 rounded-md border p-3">
      <CheckboxField label="Noise" checked={enabled} onChange={setEnabled} />
      {draft.mode === "unsupported" ? (
        <UnsupportedBehaviorNotice
          label={draft.label}
          onConvert={() => setEnabled(true)}
        />
      ) : null}
      <ValueGeneratorField
        label="Frequency"
        value={draft.frequency}
        disabled={!enabled}
        onChange={patch("frequency")}
      />
      <ValueGeneratorField
        label="Power"
        value={draft.power}
        disabled={!enabled}
        onChange={patch("power")}
      />
      <ValueGeneratorField
        label="Position amount"
        value={draft.positionAmount}
        disabled={!enabled}
        onChange={patch("positionAmount")}
      />
      <ValueGeneratorField
        label="Rotation amount"
        value={draft.rotationAmount}
        disabled={!enabled}
        onChange={patch("rotationAmount")}
      />
    </div>
  );
}

function TurbulenceControlsPanel({
  draft,
  onChange,
}: {
  draft: ParticleVFXEditorTurbulenceFieldDraft;
  onChange: (draft: ParticleVFXEditorTurbulenceFieldDraft) => void;
}) {
  const enabled = draft.mode !== "off";
  const setEnabled = (nextEnabled: boolean) => {
    onChange({
      mode: nextEnabled ? "enabled" : "off",
      scale: draft.scale,
      octaves: draft.octaves,
      velocityMultiplier: draft.velocityMultiplier,
      timeScale: draft.timeScale,
    });
  };
  return (
    <div className="grid content-start gap-3 rounded-md border p-3">
      <CheckboxField
        label="Turbulence"
        checked={enabled}
        onChange={setEnabled}
      />
      {draft.mode === "unsupported" ? (
        <UnsupportedBehaviorNotice
          label={draft.label}
          onConvert={() => setEnabled(true)}
        />
      ) : null}
      <AxisTripleFields
        label="Scale"
        value={draft.scale}
        disabled={!enabled}
        onChange={(scale) =>
          onChange({ ...draft, mode: enabled ? "enabled" : "off", scale })
        }
      />
      <NumberField
        label="Octaves"
        value={draft.octaves}
        min={1}
        step={1}
        disabled={!enabled}
        onChange={(octaves) =>
          onChange({
            ...draft,
            mode: enabled ? "enabled" : "off",
            octaves: Math.round(octaves),
          })
        }
      />
      <AxisTripleFields
        label="Velocity"
        value={draft.velocityMultiplier}
        disabled={!enabled}
        onChange={(velocityMultiplier) =>
          onChange({
            ...draft,
            mode: enabled ? "enabled" : "off",
            velocityMultiplier,
          })
        }
      />
      <AxisTripleFields
        label="Time scale"
        value={draft.timeScale}
        disabled={!enabled}
        onChange={(timeScale) =>
          onChange({
            ...draft,
            mode: enabled ? "enabled" : "off",
            timeScale,
          })
        }
      />
    </div>
  );
}

function EmitterColorPanel({
  emitter,
  onPatch,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
}) {
  const startColor = emitter.startColorGenerator;
  const colorOverLife = emitter.colorOverLife;
  const selectedThemeId =
    startColor.mode === "theme"
      ? startColor.presetId
      : PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS[0].id;
  const selectedTheme =
    getColorThemePreset(selectedThemeId) ??
    PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS[0];

  const setStartColorMode = (mode: EditableStartColorMode) => {
    const current = getStartColorPreviewColor(startColor);
    if (mode === "fixed") {
      onPatch({ startColorGenerator: { mode, color: current } });
      return;
    }
    if (mode === "range") {
      const range = startColor.mode === "range" ? startColor : null;
      onPatch({
        startColorGenerator: {
          mode,
          from: range?.from ?? current,
          to: range?.to ?? tintColor(current, 0.22),
        },
      });
      return;
    }
    onPatch({
      startColorGenerator: {
        mode,
        presetId: selectedTheme.id,
        from: selectedTheme.from,
        to: selectedTheme.to,
      },
    });
  };

  const setColorOverLifeMode = (mode: EditableColorOverLifeMode) => {
    if (mode === "off") {
      onPatch({ colorOverLifeDraft: { mode: "off" } });
      return;
    }
    if (mode === "fade") {
      onPatch({ colorOverLifeDraft: createFadeOutColorDraft() });
      return;
    }
    if (mode === "gradient") {
      onPatch({
        colorOverLifeDraft: {
          mode,
          stops:
            colorOverLife.mode === "gradient" || colorOverLife.mode === "fade"
              ? colorOverLife.stops
              : selectedTheme.gradientStops,
        },
      });
      return;
    }
    onPatch({
      colorOverLifeDraft: {
        mode,
        gradientA:
          colorOverLife.mode === "random-gradient"
            ? colorOverLife.gradientA
            : selectedTheme.randomGradientA,
        gradientB:
          colorOverLife.mode === "random-gradient"
            ? colorOverLife.gradientB
            : selectedTheme.randomGradientB,
      },
    });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Start Color</h3>
            <p className="text-muted-foreground text-xs">
              Initial particle color sampled when each particle spawns.
            </p>
          </div>
          <ColorPreviewStrip
            stops={getStartColorPreviewStops(startColor)}
            className="h-7 w-36"
          />
        </div>
        {startColor.mode === "unsupported" ? (
          <UnsupportedColorNotice
            label={startColor.label}
            onConvert={() =>
              onPatch({
                startColorGenerator: {
                  mode: "fixed",
                  color: startColor.fallbackColor,
                },
              })
            }
          />
        ) : null}
        <div className="grid gap-3">
          <SelectField
            label="Mode"
            value={
              startColor.mode === "unsupported" ? "fixed" : startColor.mode
            }
            values={START_COLOR_MODE_VALUES}
            onChange={setStartColorMode}
          />
          {startColor.mode === "theme" ? (
            <SelectField
              label="Theme"
              value={startColor.presetId}
              values={COLOR_THEME_PRESET_IDS}
              onChange={(presetId) => {
                const preset = getColorThemePreset(presetId) ?? selectedTheme;
                onPatch({
                  startColorGenerator: {
                    mode: "theme",
                    presetId: preset.id,
                    from: preset.from,
                    to: preset.to,
                  },
                });
              }}
            />
          ) : null}
        </div>
        {startColor.mode === "fixed" ? (
          <ColorRgbaFields
            label="Fixed"
            color={startColor.color}
            onChange={(color) =>
              onPatch({ startColorGenerator: { mode: "fixed", color } })
            }
          />
        ) : null}
        {startColor.mode === "range" || startColor.mode === "theme" ? (
          <div className="grid gap-3">
            <ColorRgbaFields
              label="Range start"
              color={startColor.from}
              onChange={(color) =>
                onPatch({
                  startColorGenerator:
                    startColor.mode === "theme"
                      ? { ...startColor, from: color }
                      : { mode: "range", from: color, to: startColor.to },
                })
              }
            />
            <ColorRgbaFields
              label="Range end"
              color={startColor.to}
              onChange={(color) =>
                onPatch({
                  startColorGenerator:
                    startColor.mode === "theme"
                      ? { ...startColor, to: color }
                      : { mode: "range", from: startColor.from, to: color },
                })
              }
            />
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="hover:bg-muted/70 rounded-md border p-2 text-left transition"
              onClick={() =>
                onPatch({
                  startColorGenerator: {
                    mode: "theme",
                    presetId: preset.id,
                    from: preset.from,
                    to: preset.to,
                  },
                })
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{preset.label}</span>
                <ColorPreviewStrip
                  stops={[
                    { position: 0, color: preset.from },
                    { position: 1, color: preset.to },
                  ]}
                  className="h-4 w-16"
                />
              </div>
              <p className="text-muted-foreground text-2xs mt-1 line-clamp-2">
                {preset.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="border-t pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Color Over Life</h3>
            <p className="text-muted-foreground text-xs">
              Multiplies particle color as particles age.
            </p>
          </div>
          {colorOverLife.mode === "gradient" ||
          colorOverLife.mode === "fade" ? (
            <ColorPreviewStrip
              stops={colorOverLife.stops}
              className="h-7 w-36"
            />
          ) : colorOverLife.mode === "random-gradient" ? (
            <div className="space-y-1">
              <ColorPreviewStrip
                stops={colorOverLife.gradientA}
                className="h-3 w-36"
              />
              <ColorPreviewStrip
                stops={colorOverLife.gradientB}
                className="h-3 w-36"
              />
            </div>
          ) : null}
        </div>
        {colorOverLife.mode === "unsupported" ? (
          <UnsupportedColorNotice
            label={colorOverLife.label}
            onConvert={() =>
              onPatch({
                colorOverLifeDraft: {
                  mode: "gradient",
                  stops: selectedTheme.gradientStops,
                },
              })
            }
          />
        ) : null}
        <div className="mt-3 grid gap-3">
          <SelectField
            label="Mode"
            value={
              colorOverLife.mode === "unsupported"
                ? "gradient"
                : colorOverLife.mode
            }
            values={COLOR_OVER_LIFE_MODE_VALUES}
            onChange={setColorOverLifeMode}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="hover:bg-muted/70 rounded-md border p-2 text-left transition"
              onClick={() =>
                onPatch({
                  colorOverLifeDraft:
                    colorOverLife.mode === "random-gradient"
                      ? {
                          mode: "random-gradient",
                          gradientA: preset.randomGradientA,
                          gradientB: preset.randomGradientB,
                        }
                      : {
                          mode: "gradient",
                          stops: preset.gradientStops,
                        },
                })
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{preset.label}</span>
                <ColorPreviewStrip
                  stops={preset.gradientStops}
                  className="h-4 w-16"
                />
              </div>
              <p className="text-muted-foreground text-2xs mt-1">
                Apply theme gradient
              </p>
            </button>
          ))}
        </div>
        {colorOverLife.mode === "fade" || colorOverLife.mode === "gradient" ? (
          <GradientStopEditor
            title={
              colorOverLife.mode === "fade" ? "Fade Stops" : "Gradient Stops"
            }
            stops={colorOverLife.stops}
            onChange={(stops) =>
              onPatch({
                colorOverLifeDraft: {
                  mode: colorOverLife.mode,
                  stops,
                },
              })
            }
          />
        ) : null}
        {colorOverLife.mode === "random-gradient" ? (
          <div className="mt-4 grid gap-4">
            <GradientStopEditor
              title="Random Gradient A"
              stops={colorOverLife.gradientA}
              onChange={(gradientA) =>
                onPatch({
                  colorOverLifeDraft: {
                    mode: "random-gradient",
                    gradientA,
                    gradientB: colorOverLife.gradientB,
                  },
                })
              }
            />
            <GradientStopEditor
              title="Random Gradient B"
              stops={colorOverLife.gradientB}
              onChange={(gradientB) =>
                onPatch({
                  colorOverLifeDraft: {
                    mode: "random-gradient",
                    gradientA: colorOverLife.gradientA,
                    gradientB,
                  },
                })
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const START_COLOR_MODE_VALUES = [
  "fixed",
  "range",
  "theme",
] as const satisfies readonly EditableStartColorMode[];

const COLOR_OVER_LIFE_MODE_VALUES = [
  "off",
  "fade",
  "gradient",
  "random-gradient",
] as const satisfies readonly EditableColorOverLifeMode[];

const COLOR_THEME_PRESET_IDS = PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS.map(
  (preset) => preset.id,
);

type EditableStartColorMode = Exclude<
  ParticleVFXEditorStartColorDraft["mode"],
  "unsupported"
>;

type EditableColorOverLifeMode = Exclude<
  ParticleVFXEditorColorOverLifeDraft["mode"],
  "unsupported"
>;

type ColorStopPatch = {
  position?: number;
  color?: Partial<ParticleVFXEditorColor>;
};

function ColorRgbaFields({
  label,
  color,
  onChange,
}: {
  label: string;
  color: ParticleVFXEditorColor;
  onChange: (color: ParticleVFXEditorColor) => void;
}) {
  const patchColor = (patch: Partial<ParticleVFXEditorColor>) =>
    onChange(clampEditorColor({ ...color, ...patch }));
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        <ColorPreviewStrip
          stops={[{ position: 0, color }]}
          className="h-5 w-16"
        />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[80px_1fr_1fr_1fr_1fr]">
        <Input
          type="color"
          value={colorToHex(color)}
          className="h-10 p-1"
          onChange={(event) => patchColor(hexToColorPatch(event.target.value))}
        />
        <NumberField
          label="R"
          value={color.r}
          min={0}
          step={0.01}
          compact
          onChange={(value) => patchColor({ r: value })}
        />
        <NumberField
          label="G"
          value={color.g}
          min={0}
          step={0.01}
          compact
          onChange={(value) => patchColor({ g: value })}
        />
        <NumberField
          label="B"
          value={color.b}
          min={0}
          step={0.01}
          compact
          onChange={(value) => patchColor({ b: value })}
        />
        <NumberField
          label="A"
          value={color.a}
          min={0}
          step={0.05}
          compact
          onChange={(value) => patchColor({ a: value })}
        />
      </div>
    </div>
  );
}

function GradientStopEditor({
  title,
  stops,
  onChange,
}: {
  title: string;
  stops: ParticleVFXEditorColorStop[];
  onChange: (stops: ParticleVFXEditorColorStop[]) => void;
}) {
  const sortedStops = sortColorStops(stops);
  const patchStop = (index: number, patch: ColorStopPatch) => {
    onChange(
      sortColorStops(
        sortedStops.map((stop, stopIndex) =>
          stopIndex === index
            ? {
                position:
                  typeof patch.position === "number"
                    ? clampUnit(patch.position)
                    : stop.position,
                color: clampEditorColor({
                  ...stop.color,
                  ...(patch.color ?? {}),
                }),
              }
            : stop,
        ),
      ),
    );
  };
  return (
    <div className="mt-4 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label className="text-xs">{title}</Label>
          <ColorPreviewStrip stops={sortedStops} className="mt-2 h-5 w-40" />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange(
              sortColorStops([
                ...sortedStops,
                {
                  position: 0.5,
                  color:
                    sortedStops[Math.floor(sortedStops.length / 2)]?.color ??
                    DEFAULT_EDITOR_COLOR,
                },
              ]),
            )
          }
        >
          <PlusIcon />
          Stop
        </Button>
      </div>
      <div className="mt-3 space-y-2">
        {sortedStops.map((stop, index) => (
          <div
            key={`${index}:${stop.position}`}
            className="bg-muted/30 grid gap-2 rounded-md p-2 sm:grid-cols-[80px_1fr_1fr_auto]"
          >
            <Input
              type="color"
              value={colorToHex(stop.color)}
              className="h-10 p-1"
              onChange={(event) =>
                patchStop(index, { color: hexToColorPatch(event.target.value) })
              }
            />
            <NumberField
              label="Position"
              value={stop.position}
              min={0}
              step={0.01}
              compact
              onChange={(value) => patchStop(index, { position: value })}
            />
            <NumberField
              label="Alpha"
              value={stop.color.a}
              min={0}
              step={0.05}
              compact
              onChange={(value) => patchStop(index, { color: { a: value } })}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="self-end"
              disabled={sortedStops.length <= 2}
              onClick={() =>
                onChange(
                  sortedStops.filter((_, stopIndex) => stopIndex !== index),
                )
              }
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ValueGeneratorField({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: ParticleVFXEditorValueGeneratorDraft;
  disabled?: boolean;
  onChange: (value: ParticleVFXEditorValueGeneratorDraft) => void;
}) {
  if (value.mode === "unsupported") {
    return (
      <div className={cn(disabled && "opacity-60")}>
        <Label className="text-xs">{label}</Label>
        <div className="border-warning/40 text-warning mt-1 flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
          <span>Unsupported generator ({value.label})</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange({ mode: "constant", value: value.fallbackValue })
            }
          >
            Convert
          </Button>
        </div>
      </div>
    );
  }

  const setMode = (nextMode: "constant" | "range" | "linear") => {
    const fallback = valueGeneratorPrimaryValue(value);
    if (nextMode === "constant") {
      onChange({ mode: "constant", value: fallback });
    } else if (nextMode === "range") {
      onChange({ mode: "range", min: fallback, max: fallback });
    } else {
      onChange({ mode: "linear", start: fallback, end: fallback });
    }
  };
  return (
    <div className={cn(disabled && "opacity-60")}>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1 grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)]">
        <Select
          value={value.mode}
          onValueChange={(nextMode) =>
            setMode(nextMode as "constant" | "range" | "linear")
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="constant">Constant</SelectItem>
            <SelectItem value="range">Range</SelectItem>
            <SelectItem value="linear">Linear</SelectItem>
          </SelectContent>
        </Select>
        {value.mode === "constant" ? (
          <NumberField
            label="Value"
            value={value.value}
            step={0.05}
            disabled={disabled}
            compact
            onChange={(nextValue) =>
              onChange({ mode: "constant", value: nextValue })
            }
          />
        ) : null}
        {value.mode === "range" ? (
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Min"
              value={value.min}
              step={0.05}
              disabled={disabled}
              compact
              onChange={(min) =>
                onChange({
                  mode: "range",
                  min,
                  max: Math.max(min, value.max),
                })
              }
            />
            <NumberField
              label="Max"
              value={value.max}
              step={0.05}
              disabled={disabled}
              compact
              onChange={(max) =>
                onChange({
                  mode: "range",
                  min: Math.min(value.min, max),
                  max,
                })
              }
            />
          </div>
        ) : null}
        {value.mode === "linear" ? (
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Start"
              value={value.start}
              step={0.05}
              disabled={disabled}
              compact
              onChange={(start) =>
                onChange({ mode: "linear", start, end: value.end })
              }
            />
            <NumberField
              label="End"
              value={value.end}
              step={0.05}
              disabled={disabled}
              compact
              onChange={(end) =>
                onChange({ mode: "linear", start: value.start, end })
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AxisTripleFields({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: ParticleVFXTransformAxisTriple;
  disabled?: boolean;
  onChange: (value: ParticleVFXTransformAxisTriple) => void;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {(["x", "y", "z"] as const).map((axis) => (
          <NumberField
            key={axis}
            label={axis.toUpperCase()}
            value={value[axis]}
            step={0.05}
            disabled={disabled}
            compact
            onChange={(nextValue) => onChange({ ...value, [axis]: nextValue })}
          />
        ))}
      </div>
    </div>
  );
}

function UnsupportedBehaviorNotice({
  label,
  onConvert,
}: {
  label: string;
  onConvert: () => void;
}) {
  return (
    <div className="border-warning/40 text-warning flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
      <span>Unsupported behavior ({label}) is preserved until edited.</span>
      <Button type="button" size="sm" variant="outline" onClick={onConvert}>
        Convert
      </Button>
    </div>
  );
}

function normalizeValueGeneratorDraft(
  value: ParticleVFXEditorValueGeneratorDraft,
): ParticleVFXEditorValueGeneratorDraft {
  if (value.mode !== "unsupported") return value;
  return { mode: "constant", value: value.fallbackValue };
}

function valueGeneratorPrimaryValue(
  value: ParticleVFXEditorValueGeneratorDraft,
): number {
  if (value.mode === "constant") return value.value;
  if (value.mode === "range") return value.min;
  if (value.mode === "linear") return value.start;
  return value.fallbackValue;
}

function UnsupportedColorNotice({
  label,
  onConvert,
}: {
  label: string;
  onConvert: () => void;
}) {
  return (
    <div className="border-warning/40 text-warning mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-xs">
      <span>Unsupported generator ({label}) is preserved until edited.</span>
      <Button type="button" size="sm" variant="outline" onClick={onConvert}>
        Convert
      </Button>
    </div>
  );
}

function ColorPreviewStrip({
  stops,
  className,
}: {
  stops: readonly ParticleVFXEditorColorStop[];
  className?: string;
}) {
  return (
    <span
      className={cn("inline-block rounded-sm border", className)}
      style={{ background: colorStopsToCss(stops) }}
    />
  );
}

function EmitterRendererPanel({
  emitter,
  onPatch,
}: {
  emitter: ParticleVFXEmitterDraft;
  onPatch: (patch: ParticleVFXEmitterPatch) => void;
}) {
  const isStretched = emitter.renderer.renderMode === 1;
  const isTrail = emitter.renderer.renderMode === 3;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField
        label="Render mode"
        value={`${emitter.renderer.renderMode}`}
        values={PARTICLE_VFX_EDITOR_RENDER_MODES.map((mode) => `${mode.value}`)}
        labels={Object.fromEntries(
          PARTICLE_VFX_EDITOR_RENDER_MODES.map((mode) => [
            `${mode.value}`,
            mode.label,
          ]),
        )}
        onChange={(value) =>
          onPatch({
            renderer: {
              renderMode: Number(value) as ParticleVFXEditorRenderMode,
            },
          })
        }
      />
      <SelectField
        label="Blending"
        value={emitter.renderer.blending}
        values={PARTICLE_VFX_EDITOR_BLENDINGS}
        onChange={(value) =>
          onPatch({
            renderer: { blending: value as ParticleVFXEditorBlending },
          })
        }
      />
      <NumberField
        label="Opacity"
        value={emitter.renderer.opacity}
        min={0}
        step={0.05}
        onChange={(value) => onPatch({ renderer: { opacity: value } })}
      />
      <details className="sm:col-span-2">
        <summary className="cursor-pointer text-xs font-semibold">
          Advanced rendering
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Render order"
            value={emitter.renderer.renderOrder}
            step={1}
            onChange={(value) =>
              onPatch({ renderer: { renderOrder: Math.round(value) } })
            }
          />
          <NumberField
            label="Alpha test"
            value={emitter.renderer.alphaTest}
            min={0}
            step={0.01}
            onChange={(value) => onPatch({ renderer: { alphaTest: value } })}
          />
          <CheckboxField
            label="Depth write"
            checked={emitter.renderer.depthWrite}
            onChange={(value) => onPatch({ renderer: { depthWrite: value } })}
          />
          <CheckboxField
            label="Depth test"
            checked={emitter.renderer.depthTest}
            onChange={(value) => onPatch({ renderer: { depthTest: value } })}
          />
          <CheckboxField
            label="Soft particles"
            checked={emitter.renderer.softParticles}
            onChange={(value) =>
              onPatch({ renderer: { softParticles: value } })
            }
          />
          {emitter.renderer.softParticles ? (
            <>
              <NumberField
                label="Near fade distance (m)"
                value={emitter.renderer.softNearFade}
                min={0}
                step={0.05}
                onChange={(value) =>
                  onPatch({ renderer: { softNearFade: value } })
                }
              />
              <NumberField
                label="Far fade distance (m)"
                value={emitter.renderer.softFarFade}
                min={0}
                step={0.05}
                onChange={(value) =>
                  onPatch({ renderer: { softFarFade: value } })
                }
              />
            </>
          ) : null}
        </div>
      </details>
      {isStretched ? (
        <>
          <NumberField
            label="Speed factor"
            value={emitter.renderer.speedFactor}
            min={0}
            step={0.01}
            onChange={(value) => onPatch({ renderer: { speedFactor: value } })}
          />
          <NumberField
            label="Length factor"
            value={emitter.renderer.lengthFactor}
            min={0}
            step={0.1}
            onChange={(value) => onPatch({ renderer: { lengthFactor: value } })}
          />
        </>
      ) : null}
      {isTrail ? (
        <>
          <CheckboxField
            label="Follow local origin"
            checked={emitter.renderer.trailFollowLocalOrigin}
            onChange={(value) =>
              onPatch({ renderer: { trailFollowLocalOrigin: value } })
            }
          />
          <div className="md:col-span-2">
            <ValueGeneratorField
              label="Trail start length"
              value={emitter.renderer.trailStartLength}
              onChange={(value) =>
                onPatch({ renderer: { trailStartLength: value } })
              }
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function ExportBlock({
  title,
  value,
  copied,
  onCopy,
}: {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label>{title}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCopy}
          disabled={!value}
        >
          {copied ? <CheckIcon /> : <ClipboardIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Textarea
        value={value}
        readOnly
        className="min-h-28 font-mono text-xs"
        spellCheck={false}
      />
    </div>
  );
}

function TransformControls({
  transform,
  disabled = false,
  onChange,
}: {
  transform: ParticleVFXTransform;
  disabled?: boolean;
  onChange: (transform: ParticleVFXTransform) => void;
}) {
  const patchAxis = (
    field: keyof Pick<ParticleVFXTransform, "offset" | "rotation" | "scale">,
    axis: keyof ParticleVFXTransformAxisTriple,
    value: number,
  ) => {
    onChange({
      ...transform,
      [field]: {
        ...transform[field],
        [axis]: value,
      },
    });
  };
  return (
    <div className="mt-3 space-y-3">
      {(["offset", "rotation", "scale"] as const).map((field) => (
        <div key={field}>
          <Label className="text-muted-foreground text-xs capitalize">
            {field === "offset"
              ? "Offset (m)"
              : field === "rotation"
                ? "Rotation (rad)"
                : "Scale (multiplier)"}
          </Label>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(["x", "y", "z"] as const).map((axis) => (
              <NumberField
                key={axis}
                label={axis.toUpperCase()}
                value={transform[field][axis]}
                step={field === "scale" ? 0.01 : 0.05}
                min={field === "scale" ? 0.01 : undefined}
                onChange={(value) => patchAxis(field, axis, value)}
                disabled={disabled}
                compact
              />
            ))}
          </div>
        </div>
      ))}
      <NumberField
        label="Depth offset (m)"
        value={transform.depthOffset}
        step={0.05}
        onChange={(value) => onChange({ ...transform, depthOffset: value })}
        disabled={disabled}
      />
    </div>
  );
}

function CatalogShapeAutoFitControls({
  shapeAutoFit,
  rectangleEmitters,
  disabled = false,
  onChange,
}: {
  shapeAutoFit: ParticleVFXShapeAutoFit | undefined;
  rectangleEmitters: readonly ParticleVFXEmitterDraft[];
  disabled?: boolean;
  onChange: (shapeAutoFit: ParticleVFXShapeAutoFit | undefined) => void;
}) {
  if (rectangleEmitters.length === 0) return null;
  const enabled = shapeAutoFit?.kind === "avatarBoundsRectangle";
  const setEnabled = (nextEnabled: boolean) => {
    onChange(
      nextEnabled
        ? {
            kind: "avatarBoundsRectangle",
            padding: { width: 0, height: 0 },
            minSize: { width: 0.1, height: 0.1 },
          }
        : undefined,
    );
  };
  const patchAutoFit = (
    patch: Partial<Omit<ParticleVFXShapeAutoFit, "kind">>,
  ) => {
    onChange({
      kind: "avatarBoundsRectangle",
      padding: {
        width: shapeAutoFit?.padding?.width ?? 0,
        height: shapeAutoFit?.padding?.height ?? 0,
        ...patch.padding,
      },
      minSize: {
        width: shapeAutoFit?.minSize?.width ?? 0.1,
        height: shapeAutoFit?.minSize?.height ?? 0.1,
        ...patch.minSize,
      },
      maxSize: Object.prototype.hasOwnProperty.call(patch, "maxSize")
        ? patch.maxSize
        : shapeAutoFit?.maxSize,
      emitterNames:
        patch.emitterNames !== undefined
          ? patch.emitterNames
          : shapeAutoFit?.emitterNames,
    });
  };
  const patchMaxSize = (axis: "width" | "height", value: number) => {
    const nextMaxSize = {
      width: shapeAutoFit?.maxSize?.width,
      height: shapeAutoFit?.maxSize?.height,
      [axis]: value > 0 ? value : undefined,
    };
    patchAutoFit({
      maxSize:
        nextMaxSize.width || nextMaxSize.height ? nextMaxSize : undefined,
    });
  };
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label
          htmlFor="particle-vfx-creator-auto-fit"
          className="text-xs font-medium"
        >
          Fit rectangle to avatar
        </Label>
        <Switch
          id="particle-vfx-creator-auto-fit"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={setEnabled}
        />
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Fits emission width and height to avatar bounds, not the camera or
        canvas. Emitter positions stay relative to their anchors.
      </p>
      {enabled ? (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Width padding (m)"
              value={shapeAutoFit?.padding?.width ?? 0}
              min={0}
              step={0.01}
              disabled={disabled}
              compact
              onChange={(value) =>
                patchAutoFit({
                  padding: {
                    width: value,
                    height: shapeAutoFit?.padding?.height ?? 0,
                  },
                })
              }
            />
            <NumberField
              label="Height padding (m)"
              value={shapeAutoFit?.padding?.height ?? 0}
              min={0}
              step={0.01}
              disabled={disabled}
              compact
              onChange={(value) =>
                patchAutoFit({
                  padding: {
                    width: shapeAutoFit?.padding?.width ?? 0,
                    height: value,
                  },
                })
              }
            />
            <NumberField
              label="Minimum width (m)"
              value={shapeAutoFit?.minSize?.width ?? 0.1}
              min={0.01}
              step={0.01}
              disabled={disabled}
              compact
              onChange={(value) =>
                patchAutoFit({
                  minSize: {
                    width: value,
                    height: shapeAutoFit?.minSize?.height ?? 0.1,
                  },
                })
              }
            />
            <NumberField
              label="Minimum height (m)"
              value={shapeAutoFit?.minSize?.height ?? 0.1}
              min={0.01}
              step={0.01}
              disabled={disabled}
              compact
              onChange={(value) =>
                patchAutoFit({
                  minSize: {
                    width: shapeAutoFit?.minSize?.width ?? 0.1,
                    height: value,
                  },
                })
              }
            />
            <NumberField
              label="Maximum width (m)"
              value={shapeAutoFit?.maxSize?.width ?? 0}
              min={0}
              step={0.01}
              disabled={disabled}
              compact
              onChange={(value) => patchMaxSize("width", value)}
            />
            <NumberField
              label="Maximum height (m)"
              value={shapeAutoFit?.maxSize?.height ?? 0}
              min={0}
              step={0.01}
              disabled={disabled}
              compact
              onChange={(value) => patchMaxSize("height", value)}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Maximum size: 0 means no limit.
          </p>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-semibold">
              Rectangle emitters to fit
            </legend>
            {rectangleEmitters.map((emitter) => (
              <CheckboxField
                key={emitter.path}
                label={emitter.name}
                checked={
                  !shapeAutoFit?.emitterNames?.length ||
                  shapeAutoFit.emitterNames.includes(emitter.name)
                }
                disabled={disabled}
                onChange={(checked) => {
                  const selected = new Set(
                    shapeAutoFit?.emitterNames?.length
                      ? shapeAutoFit.emitterNames
                      : rectangleEmitters.map((item) => item.name),
                  );
                  if (checked) selected.add(emitter.name);
                  else selected.delete(emitter.name);
                  if (selected.size === 0) setEnabled(false);
                  else patchAutoFit({ emitterNames: [...selected] });
                }}
              />
            ))}
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

function SelectField<T extends string>({
  label,
  value,
  values,
  labels,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T;
  values: readonly T[];
  labels?: Partial<Record<T, string>>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <CreatorField label={label} htmlFor={id}>
      <Select
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as T)}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {labels?.[item] ?? item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </CreatorField>
  );
}

function CheckboxField({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  );
}

function ValueRangeField({
  label,
  value,
  min,
  step = 0.01,
  disabled = false,
  onChange,
}: {
  label: string;
  value: ParticleVFXEditorValueRange | null;
  min?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: ParticleVFXEditorValueRange) => void;
}) {
  return (
    <div className={cn(disabled && "opacity-60")}>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <Input
          type="number"
          value={value?.min ?? 0}
          min={min}
          step={step}
          disabled={disabled || !value}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (!value || !Number.isFinite(next)) return;
            onChange({ min: next, max: Math.max(next, value.max) });
          }}
        />
        <Input
          type="number"
          value={value?.max ?? 0}
          min={min}
          step={step}
          disabled={disabled || !value}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (!value || !Number.isFinite(next)) return;
            onChange({ min: Math.min(value.min, next), max: next });
          }}
        />
      </div>
    </div>
  );
}

const DEFAULT_EDITOR_COLOR: ParticleVFXEditorColor = {
  r: 1,
  g: 1,
  b: 1,
  a: 1,
};

function getColorThemePreset(id: string) {
  return (
    PARTICLE_VFX_EDITOR_COLOR_THEME_PRESETS.find(
      (preset) => preset.id === id,
    ) ?? null
  );
}

function getStartColorPreviewColor(
  draft: ParticleVFXEditorStartColorDraft,
): ParticleVFXEditorColor {
  if (draft.mode === "fixed") return draft.color;
  if (draft.mode === "unsupported") return draft.fallbackColor;
  return draft.from;
}

function getStartColorPreviewStops(
  draft: ParticleVFXEditorStartColorDraft,
): ParticleVFXEditorColorStop[] {
  if (draft.mode === "fixed") {
    return [{ position: 0, color: draft.color }];
  }
  if (draft.mode === "unsupported") {
    return [{ position: 0, color: draft.fallbackColor }];
  }
  return [
    { position: 0, color: draft.from },
    { position: 1, color: draft.to },
  ];
}

function createFadeOutColorDraft(): ParticleVFXEditorColorOverLifeDraft {
  return {
    mode: "fade",
    stops: [
      { position: 0, color: { ...DEFAULT_EDITOR_COLOR } },
      { position: 0.75, color: { ...DEFAULT_EDITOR_COLOR } },
      { position: 1, color: { ...DEFAULT_EDITOR_COLOR, a: 0 } },
    ],
  };
}

function tintColor(
  color: ParticleVFXEditorColor,
  amount: number,
): ParticleVFXEditorColor {
  return clampEditorColor({
    r: color.r + (1 - color.r) * amount,
    g: color.g + (1 - color.g) * amount,
    b: color.b + (1 - color.b) * amount,
    a: color.a,
  });
}

function sortColorStops(
  stops: readonly ParticleVFXEditorColorStop[],
): ParticleVFXEditorColorStop[] {
  const next = stops.map((stop) => ({
    position: clampUnit(stop.position),
    color: clampEditorColor(stop.color),
  }));
  if (next.length === 0) {
    return [
      { position: 0, color: { ...DEFAULT_EDITOR_COLOR } },
      { position: 1, color: { ...DEFAULT_EDITOR_COLOR, a: 0 } },
    ];
  }
  if (next.length === 1) {
    return [
      { position: 0, color: next[0].color },
      { position: 1, color: { ...next[0].color } },
    ];
  }
  return next.sort((a, b) => a.position - b.position);
}

function colorStopsToCss(stops: readonly ParticleVFXEditorColorStop[]): string {
  const sortedStops = sortColorStops(stops);
  if (sortedStops.length === 1) return colorToCss(sortedStops[0].color);
  return `linear-gradient(90deg, ${sortedStops
    .map(
      (stop) =>
        `${colorToCss(stop.color)} ${Math.round(clampUnit(stop.position) * 100)}%`,
    )
    .join(", ")})`;
}

function colorToCss(color: ParticleVFXEditorColor): string {
  const next = clampEditorColor(color);
  return `rgba(${Math.round(next.r * 255)}, ${Math.round(next.g * 255)}, ${Math.round(next.b * 255)}, ${next.a})`;
}

function clampEditorColor(
  color: ParticleVFXEditorColor,
): ParticleVFXEditorColor {
  return {
    r: clampUnit(color.r),
    g: clampUnit(color.g),
    b: clampUnit(color.b),
    a: clampUnit(color.a),
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function colorToHex(color: { r: number; g: number; b: number }): string {
  const channels = [color.r, color.g, color.b].map((value) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${channels.join("")}`;
}

function hexToColorPatch(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return {
    r: Number.isFinite(red) ? red / 255 : 1,
    g: Number.isFinite(green) ? green / 255 : 1,
    b: Number.isFinite(blue) ? blue / 255 : 1,
  };
}
