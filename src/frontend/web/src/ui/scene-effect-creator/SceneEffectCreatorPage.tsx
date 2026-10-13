"use client";

import { useProductApiClient } from "@animama/product-ui";
import type { Client } from "@animama/runtime-contracts/sdk";
import { CreatorTimelineTransport } from "@/ui/content-creator/CreatorTimeline";

import { SoundUploadButton } from "@/ui/sound-upload/SoundUploadButton";

import { ContentEditorHydration } from "@/lib/content/contentEditorSource";

import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Code2Icon,
  FolderOpenIcon,
  GripVerticalIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { listCatalogItems, previewCatalogItem } from "@/lib/content/catalogApi";
import { createUniqueContentName } from "@/lib/content/uniqueContentName";
import { previewSoundForCopy } from "@/lib/content/previewSound";
import {
  findSceneEffectTemplate,
  type SceneEffectTemplateGroup,
} from "@/lib/effects/effectTemplates";
import type {
  PyContentPreview,
  PyExactContentSource,
} from "@/lib/content/catalogTypes";
import { Avatar } from "@/lib/avatar";
import { fetchContentPreviewFile } from "@/lib/content/contentPreview";
import { sha256File } from "@/lib/content/contentUploads";
import { findLogicalResourceFile } from "@/lib/content/typedLogicalResources";
import {
  applySceneEffectTemplate,
  buildSceneEffectEditorExport,
  createDefaultSceneEffectDocument,
  createSceneEffectDocumentFromDefinition,
  parseSceneEffectEditorExport,
  SCENE_EFFECT_TEMPLATE_OPTIONS,
  sceneEffectEditorReducer,
  sceneEffectImageMetadata,
  defaultSceneScatter,
  sceneEffectRecoveryStore,
  sceneEffectRuntimeEntry,
  validateSceneEffectDocument,
  type SceneEffectEditorDocument,
  type SceneEffectEditorBackground,
  type SceneEffectEditorImage,
  type SceneEffectEditorImageResource,
  type SceneEffectEditorMarqueeItem,
  type SceneEffectImageTarget,
  type SceneEffectTemplateId,
} from "@/lib/scene-vfx/editor";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { SCENE_EFFECT_LIMITS } from "@/lib/scene-vfx/limits";
import { buildSceneVFXRuntimeEntry } from "@/lib/scene-vfx/runtime-state";
import type { SceneSticker } from "@/lib/scene-vfx/stickers";
import {
  SCENE_BACKGROUND_DIRECTIONS,
  SCENE_BACKGROUND_ITEM_ROTATION_MODES,
  SCENE_BACKGROUND_PATTERN_KINDS,
  type SceneBackgroundPatternKind,
  type SceneVFXRuntimeEntry,
} from "@/lib/scene-vfx/types";
import { cn } from "@/lib/utils";
import { useSceneEffect, useSoundEffects } from "@/query/hooks/useEffects";
import { AvatarPreviewSurface } from "@/ui/avatar-preview/AvatarPreviewSurface";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import { useContentPreviewAudio } from "@/ui/content-preview/useContentPreviewAudio";
import {
  CreatorCanvasControls,
  CreatorEffectHandoffActions,
  CreatorField as Field,
  CreatorFloatingPanel as FloatingPanel,
  CreatorImportDialog,
  CreatorInlineError,
  CreatorJsonDialog,
  CreatorLeaveDialog,
  CreatorLoading,
  CreatorNumberField as NumberField,
  CREATOR_STAGE_NOTICE_CLASS,
  CreatorRecoveryNotice,
  CreatorToggleRow as ToggleRow,
  CreatorToolbar,
  CreatorUnavailableState,
  CreatorWorkspaceShell,
  creatorItemUnavailableMessage,
  isCreatorItemOpenable,
} from "@/ui/content-creator";
import { ContentHealth } from "@/ui/content-health/ContentHealth";
import type { ContentCreatorModelSource } from "@/ui/content-creator/contentCreatorModelPreview";
import { useContentCreatorAvatar } from "@/ui/content-creator/useContentCreatorAvatar";
import { useContentCreatorModelPreview } from "@/ui/content-creator/useContentCreatorModelPreview";
import { CreatorTemplateDraftDialog } from "@/ui/content-creator/CreatorTemplateDraftDialog";
import { useCreatorLeaveGuard } from "@/ui/content-creator/useCreatorLeaveGuard";
import {
  creatorTemplateRecoveryKey,
  useCreatorTemplateStart,
} from "@/ui/content-creator/useCreatorTemplateStart";
import { useCreatorDocumentHistory } from "@/ui/creator-history/useCreatorDocumentHistory";
import { Button } from "@/ui/components/button";
import { Label } from "@/ui/components/label";
import { Switch } from "@/ui/components/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/components/tabs";
import { Textarea } from "@/ui/components/textarea";
import {
  addSceneEffectImageFile,
  addSceneEffectSticker,
  createSceneEffectHistorySnapshot,
  createSceneEffectObjectUrlLease,
  equalSceneEffectHistorySnapshots,
  sceneEffectCreatorKeyboardAction,
  sceneEffectHistoryEdit,
  sceneEffectSnapshotFingerprint,
  type SceneEffectHistorySnapshot,
} from "./sceneEffectCreatorBehavior";
import {
  ColorField,
  FlashInspector,
  GradientInspector,
  humanize,
  SceneItemsEditor,
  ScatterInspector,
  ScreenInspector,
  TileInspector,
  type SceneImageControls,
} from "./sceneLayerControls";
import { useSceneEffectSave } from "./useSceneEffectSave";

type PreviewStatus = {
  state: "idle" | "loading" | "ready" | "error";
  message: string | null;
};

/** A background layer the inspector edits; scatter layers by index. */
type BackgroundLayer =
  | "solid"
  | "gradient"
  | "pattern"
  | "tile"
  | "screen"
  | "marquee"
  | "flash"
  | `scatter:${number}`;

const scatterIndex = (layer: BackgroundLayer): number | null =>
  layer.startsWith("scatter:") ? Number(layer.slice("scatter:".length)) : null;

/**
 * Product Scene Effect creator backed by ordinary editable catalog files.
 * `itemId` edits a saved item; `templateId` starts a new draft from a picker
 * template (`/scene-effects/new?template=<id>`, an Included Scene Effect's
 * folder stem).
 */
export function SceneEffectCreatorPage({
  itemId,
  templateId,
}: {
  itemId?: string;
  templateId?: string;
}) {
  const navigate = useNavigate();
  const userId = useRuntimeCacheKey();
  const apiClient = useProductApiClient();
  const existingQuery = useSceneEffect(itemId ?? null);
  const {
    present: snapshot,
    history,
    update,
    reset,
    getSnapshot,
  } = useCreatorDocumentHistory({
    initialValue: createSceneEffectHistorySnapshot,
    equals: equalSceneEffectHistorySnapshots,
  });
  const { document, imageResources } = snapshot;
  const dispatch = useCallback(
    (
      action: Parameters<typeof sceneEffectEditorReducer>[1],
      nextImages?: SceneEffectEditorImageResource[],
    ) => update(sceneEffectHistoryEdit(action, nextImages)),
    [update],
  );
  const resetDocument = useCallback(
    (
      nextDocument: SceneEffectEditorDocument,
      nextImages: SceneEffectEditorImageResource[],
    ) => reset({ document: nextDocument, imageResources: nextImages }),
    [reset],
  );
  const [imageUrls, setImageUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  /** The template this draft started from, shown in Setup; null for Custom. */
  const [startingTemplate, setStartingTemplate] =
    useState<SceneEffectTemplateId | null>(() =>
      templateId ? interimStartingTemplate(templateId) : null,
    );
  const [selectedLayer, setSelectedLayer] =
    useState<BackgroundLayer>("marquee");
  const [selectedModel, setSelectedModel] =
    useState<ContentCreatorModelSource | null>(null);
  const [previewAvatar, setPreviewAvatar] = useState<Avatar | null>(null);
  const [avatarStatus, setAvatarStatus] = useState<PreviewStatus>({
    state: "idle",
    message: null,
  });
  const [playing, setPlaying] = useState(true);
  const [cameraProfile, setCameraProfile] = useState<"full-body" | "portrait">(
    "full-body",
  );
  const [previewRevision, setPreviewRevision] = useState(0);
  /** The document whose workspace has shown; see the loading screen below. */
  const [shownDocument, setShownDocument] = useState<string | null>(null);
  const [hydration, setHydration] = useState<PreviewStatus>({
    state: itemId || templateId ? "loading" : "ready",
    message: null,
  });
  /** A template route's recovered draft, held until the user chooses. */
  const [templateDraft, setTemplateDraft] =
    useState<SceneEffectHistorySnapshot | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [soundPreview, setSoundPreview] = useState<PyContentPreview | null>(
    null,
  );
  const hydratedItemRef = useRef(new ContentEditorHydration());
  const initialFingerprintRef = useRef(
    sceneEffectSnapshotFingerprint(snapshot),
  );

  const modelPreview = useContentCreatorModelPreview({
    ownerKey: `scene-effect-creator:${itemId ?? "new"}`,
    selectedModel,
    onSelectModel: setSelectedModel,
  });
  const soundQuery = useSoundEffects({ limit: 100, sort: "name" });
  const soundOptions = useMemo(
    () => soundQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [soundQuery.data?.pages],
  );
  const soundAudio = useContentPreviewAudio(soundPreview);

  useEffect(() => {
    const lease = createSceneEffectObjectUrlLease(imageResources);
    setImageUrls(lease.urls);
    return lease.dispose;
  }, [imageResources]);

  useEffect(() => {
    if (!document.sound) {
      setSoundPreview(null);
      return;
    }
    let cancelled = false;
    if (document.sound.source.type !== "catalog") {
      setSoundPreview(null);
      return;
    }
    void previewCatalogItem(
      apiClient,
      document.sound.source.catalog_item_id,
      undefined,
      "sound_effect",
    )
      .then((preview) => {
        if (!cancelled) setSoundPreview(preview);
      })
      .catch(() => {
        if (!cancelled) setSoundPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, document.sound]);

  const validation = useMemo(
    () => validateSceneEffectDocument(document, imageResources),
    [document, imageResources],
  );
  const hasBlockingIssues = validation.some(
    (issue) => issue.severity === "error",
  );
  const onRestore = useCallback(
    (recovered: SceneEffectHistorySnapshot) => {
      if (templateId) {
        setTemplateDraft(recovered);
        return;
      }
      resetDocument(recovered.document, recovered.imageResources);
      setHydration({ state: "ready", message: "Recovered local draft" });
      setPreviewRevision((value) => value + 1);
    },
    [resetDocument, templateId],
  );
  const onSaved = useCallback(
    (saved: SceneEffectHistorySnapshot, savedItemId: string) => {
      dispatch({ type: "patch", patch: { name: saved.document.name } });
      hydratedItemRef.current.preserve(savedItemId);
      initialFingerprintRef.current = sceneEffectSnapshotFingerprint(saved);
    },
    [dispatch],
  );
  const isDirty =
    sceneEffectSnapshotFingerprint(snapshot) !== initialFingerprintRef.current;
  const contentSave = useSceneEffectSave({
    itemId,
    recoveryKey: templateId
      ? creatorTemplateRecoveryKey(templateId)
      : undefined,
    snapshot,
    dirty: isDirty,
    initialized: hydration.state === "ready",
    ready: !hasBlockingIssues && !imageBusy && hydration.state === "ready",
    onRestore,
    onSaved,
  });
  useEffect(() => {
    if (
      contentSave.errorField === "files" &&
      document.kind === "background_layers"
    )
      setSelectedLayer("marquee");
  }, [contentSave.errorField, document.kind]);
  const unavailableMessage = creatorItemUnavailableMessage({
    itemId,
    label: "Scene Effect",
    item: existingQuery.data,
    readFailed: existingQuery.isError,
    loadError:
      hydration.state === "error"
        ? (hydration.message ?? "The Scene Effect could not be opened.")
        : null,
  });
  // The unavailable state has no leave dialog, so it must never block navigation.
  const guardLeave = !unavailableMessage;
  const leaveGuard = useCreatorLeaveGuard({
    dirty: guardLeave && isDirty,
    busy: guardLeave && contentSave.isBusy,
    discard: contentSave.discardChanges,
  });
  const installTemplateStart = useCallback(
    (next: SceneEffectHistorySnapshot) => {
      resetDocument(next.document, next.imageResources);
      setPreviewRevision((value) => value + 1);
    },
    [resetDocument],
  );
  // The template loader must stay stable, or each render restarts the load.
  const loadTemplateSeed = useCallback(
    (id: string, signal: AbortSignal) =>
      loadSceneEffectTemplate(apiClient, id, signal),
    [apiClient],
  );
  const templateStart = useCreatorTemplateStart({
    templateId,
    loadSeed: loadTemplateSeed,
    fingerprint: sceneEffectSnapshotFingerprint,
    recoveryReady: contentSave.recoveryReady,
    recoveredDraft: templateDraft,
    resetSession: contentSave.resetSession,
    install: installTemplateStart,
    baselineRef: initialFingerprintRef,
    setHydration,
  });
  const templateDraftDialog = (
    <CreatorTemplateDraftDialog
      start={templateStart}
      contentLabel="Scene Effect"
      templateName={findSceneEffectTemplate(templateId)?.name ?? "a template"}
    />
  );

  const discardCurrentDraft = useCallback(async () => {
    try {
      return await contentSave.discardChanges();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The draft could not be discarded.",
      );
      return false;
    }
  }, [contentSave]);

  useEffect(() => {
    if (
      !itemId ||
      !contentSave.recoveryReady ||
      contentSave.recovered ||
      !existingQuery.data
    )
      return;
    const item = existingQuery.data;
    // creatorItemUnavailableMessage reports an unreadable or locked item.
    if (!isCreatorItemOpenable(item)) return;
    const load = hydratedItemRef.current.begin(itemId);
    if (!load) return;
    const controller = new AbortController();
    setHydration({ state: "loading", message: "Loading saved content…" });
    void hydrateSceneEffect(apiClient, {
      itemId: item.item_id,
      name: item.name,
      description: item.description ?? "",
      signal: controller.signal,
    })
      .then(({ document: loadedDocument, images }) => {
        if (controller.signal.aborted) return;
        load.complete();
        resetDocument(loadedDocument, images);
        initialFingerprintRef.current =
          item.origin === "builtin"
            ? "__included_copy__"
            : sceneEffectSnapshotFingerprint({
                document: loadedDocument,
                imageResources: images,
              });
        setHydration({ state: "ready", message: null });
        setPreviewRevision((value) => value + 1);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setHydration({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "The Scene Effect could not be opened.",
        });
      });
    return () => {
      controller.abort();
      load.cancel();
    };
  }, [
    apiClient,
    contentSave.recovered,
    contentSave.recoveryReady,
    existingQuery.data,
    itemId,
    resetDocument,
  ]);

  const restartPreview = useCallback(() => {
    setPlaying(true);
    setPreviewRevision((value) => value + 1);
  }, []);
  const restartPreviewWithSound = useCallback(() => {
    restartPreview();
    soundAudio.stop();
    void soundAudio.play();
  }, [restartPreview, soundAudio]);
  const setPreviewPlaying = useCallback(
    (next: boolean) => {
      setPlaying(next);
      soundAudio.stop();
      if (next) void soundAudio.play();
    },
    [soundAudio],
  );
  const { canSave, save } = contentSave;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = sceneEffectCreatorKeyboardAction({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        editing:
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          Boolean(target?.isContentEditable),
      });
      if (action === "save") {
        event.preventDefault();
        if (canSave) void save();
      } else if (action === "toggle-preview") {
        event.preventDefault();
        setPreviewPlaying(!playing);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canSave, playing, save, setPreviewPlaying]);

  /** Apply a document change, keeping only the image bytes it still uses. */
  const replaceDocument = useCallback(
    (nextDocument: SceneEffectEditorDocument) => {
      const referenced = new Set(
        sceneEffectImageMetadata(nextDocument).map(
          (image) => image.logicalName,
        ),
      );
      dispatch(
        { type: "replace", document: nextDocument },
        getSnapshot().imageResources.filter((resource) =>
          referenced.has(resource.logicalName),
        ),
      );
      restartPreview();
    },
    [dispatch, getSnapshot, restartPreview],
  );

  /** Replace the items of the marquee or of one scatter layer. */
  const onItemsChange = useCallback(
    (
      target: Exclude<SceneEffectImageTarget, { kind: "tile" }>,
      items: SceneEffectEditorMarqueeItem[],
    ) => {
      const current = getSnapshot().document;
      replaceDocument(
        target.kind === "marquee"
          ? sceneEffectEditorReducer(current, {
              type: "set-marquee-items",
              items,
            })
          : sceneEffectEditorReducer(current, {
              type: "patch-background",
              patch: {
                scatters: current.background.scatters.map((layer, index) =>
                  index === target.index ? { ...layer, items } : layer,
                ),
              },
            }),
      );
    },
    [getSnapshot, replaceDocument],
  );

  /**
   * Add an image to `target` (see `addSceneEffectImageFile`), holding the
   * image-busy state so no other image or Save starts meanwhile, and showing
   * why an image was refused.
   */
  const addImage = useCallback(
    async (
      add: () => Promise<SceneEffectHistorySnapshot>,
      fallback: string,
    ) => {
      setImageError(null);
      setImageBusy(true);
      try {
        const next = await add();
        dispatch(
          { type: "replace", document: next.document },
          next.imageResources,
        );
        restartPreview();
      } catch (error) {
        setImageError(error instanceof Error ? error.message : fallback);
      } finally {
        setImageBusy(false);
      }
    },
    [dispatch, restartPreview],
  );

  /** Add a chosen private image file to `target`. */
  const choosePrivateImage = useCallback(
    (source: File, target: SceneEffectImageTarget) =>
      addImage(
        () => addSceneEffectImageFile(getSnapshot, source, target),
        "The image could not be read.",
      ),
    [addImage, getSnapshot],
  );

  /** Add a built-in sticker to `target` as the effect's own image. */
  const chooseSticker = useCallback(
    (sticker: SceneSticker, target: SceneEffectImageTarget) =>
      addImage(
        () => addSceneEffectSticker(getSnapshot, sticker, target),
        "The sticker could not be loaded.",
      ),
    [addImage, getSnapshot],
  );

  const importDocument = useCallback(() => {
    try {
      const parsed = parseSceneEffectEditorExport(JSON.parse(importText));
      if (isDirty && !window.confirm("Replace the current unsaved document?"))
        return;
      dispatch({ type: "replace", document: parsed }, []);
      setImportError(null);
      setImportOpen(false);
      restartPreview();
      if (sceneEffectImageMetadata(parsed).length)
        toast.info(
          "Reselect the imported document's private images before saving.",
        );
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "The JSON could not be imported.",
      );
    }
  }, [dispatch, importText, isDirty, restartPreview]);

  const exportText = useMemo(
    () => JSON.stringify(buildSceneEffectEditorExport(document), null, 2),
    [document],
  );

  /** Replace the document with a blank one on the plain `/new` route. */
  const resetToBlank = useCallback(async () => {
    const next = {
      document: createDefaultSceneEffectDocument(),
      imageResources: [],
    };
    if (!(await contentSave.resetSession(next))) return;
    resetDocument(next.document, next.imageResources);
    setStartingTemplate(null);
    setSelectedLayer("marquee");
    setImageBusy(false);
    setImageError(null);
    setPlaying(true);
    setJsonOpen(false);
    setImportOpen(false);
    setImportText("");
    setImportError(null);
    setSoundPreview(null);
    initialFingerprintRef.current = sceneEffectSnapshotFingerprint(next);
    setHydration({ state: "ready", message: null });
    setPreviewRevision((value) => value + 1);
  }, [contentSave, resetDocument]);

  /**
   * Discard a restored draft, as the Particle creator does: a saved item
   * drops the draft and reloads its saved version, a new one starts blank.
   */
  const discardRecoveredDraft = useCallback(async () => {
    if (contentSave.isBusy || imageBusy) return;
    try {
      if (itemId) await contentSave.discardRecovery();
      else await resetToBlank();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The draft could not be discarded.",
      );
    }
  }, [contentSave, imageBusy, itemId, resetToBlank]);

  const startNewDocument = useCallback(async () => {
    if (contentSave.isBusy || imageBusy) return;
    if (
      isDirty &&
      !window.confirm(
        "Discard the current changes and start a new Scene Effect?",
      )
    )
      return;

    try {
      // A saved item or a template draft starts over on the plain `/new` route.
      if (itemId || templateId) {
        if (userId)
          await sceneEffectRecoveryStore.clear(userId, "new", {
            strict: true,
          });
        if (!(await discardCurrentDraft())) return;
        await navigate({
          to: "/scene-effects/new",
          replace: true,
          ignoreBlocker: true,
        });
        return;
      }

      await resetToBlank();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The draft could not be discarded.",
      );
    }
  }, [
    contentSave,
    discardCurrentDraft,
    imageBusy,
    isDirty,
    itemId,
    navigate,
    resetToBlank,
    templateId,
    userId,
  ]);
  const sceneVFX = useMemo<SceneVFXRuntimeEntry | null>(() => {
    if (!playing) return null;
    try {
      const entry = sceneEffectRuntimeEntry(document, imageUrls);
      entry.id = `scene-effect-editor-preview-${previewRevision}`;
      return buildSceneVFXRuntimeEntry(entry, previewRevision + 1);
    } catch {
      return null;
    }
  }, [document, imageUrls, playing, previewRevision]);

  // Once this document has shown, a reload (Discard recovery on a saved item)
  // keeps the workspace and its preview Canvas mounted.
  const documentKey = itemId ?? templateId ?? "new";
  if (hydration.state === "ready" && shownDocument !== documentKey)
    setShownDocument(documentKey);
  if (unavailableMessage)
    return (
      <CreatorUnavailableState
        label="Scene Effect"
        message={unavailableMessage}
      />
    );
  if (
    hydration.state === "loading" &&
    (itemId || templateId) &&
    shownDocument !== documentKey
  )
    return (
      <>
        <CreatorLoading
          message={
            hydration.message ??
            (templateId ? "Loading template…" : "Loading Scene Effect…")
          }
        />
        {templateDraftDialog}
      </>
    );

  return (
    <CreatorWorkspaceShell
      leftPanelWidth={330}
      rightPanelWidth={370}
      busy={contentSave.isBusy}
      canvas={
        <div
          className="relative size-full"
          data-playback-surface="creator-stage"
        >
          <AvatarPreviewSurface
            activeAvatar={previewAvatar}
            cameraProfile={cameraProfile}
            canvasTestId="scene-effect-creator-canvas"
            lifecycleOwner="creator"
            minDistance={0.6}
            maxDistance={6}
            sceneVFX={sceneVFX}
            sceneBackgroundScope="viewport"
            showSceneVFX
          >
            {modelPreview.modelEntry && modelPreview.modelEntryKey ? (
              <ScenePreviewActor
                entry={modelPreview.modelEntry}
                entryKey={modelPreview.modelEntryKey}
                onAvatarChange={setPreviewAvatar}
                onStatusChange={setAvatarStatus}
              />
            ) : null}
          </AvatarPreviewSurface>
          <PlaybackObservationOutput
            active
            avatar={previewAvatar}
            sceneVFX={sceneVFX}
            status={
              hydration.state === "error" || avatarStatus.state === "error"
                ? "error"
                : hydration.state === "loading" ||
                    avatarStatus.state === "loading" ||
                    modelPreview.isAnimaPending ||
                    modelPreview.isRuntimePending
                  ? "loading"
                  : !previewAvatar
                    ? "unavailable"
                    : sceneVFX
                      ? "playing"
                      : "stopped"
            }
            surface="creator-stage"
            target={{
              kind: "scene_vfx",
              runtimeId: document.name.trim() || "new-scene-effect",
            }}
          />
        </div>
      }
      toolbar={
        <CreatorToolbar
          contentHealth={<ContentHealth compact />}
          history={history}
          historyDisabled={
            contentSave.isBusy ||
            imageBusy ||
            hydration.state !== "ready" ||
            !contentSave.recoveryReady
          }
          typeLabel="Scene FX"
          contentType="scene_effect"
          typeIcon={<SparklesIcon />}
          documentName={document.name}
          documentNameInvalid={contentSave.errorField === "name"}
          documentNameDisabled={contentSave.isBusy}
          onDocumentNameChange={(name) => {
            contentSave.clearSaveErrorField("name");
            dispatch({ type: "patch", patch: { name } });
          }}
          status={
            contentSave.error
              ? {
                  label: "Save failed",
                  tone: "error",
                  tooltip: contentSave.error,
                }
              : {
                  label: isDirty ? "Unsaved" : "Saved",
                  tone: isDirty ? "dirty" : "saved",
                }
          }
          newDisabled={contentSave.isBusy || imageBusy}
          importDisabled={contentSave.isBusy || imageBusy}
          libraryDisabled={contentSave.isBusy || imageBusy}
          onNew={() => void startNewDocument()}
          onImport={() => {
            setImportText(exportText);
            setImportOpen(true);
          }}
          onJson={() => setJsonOpen(true)}
          onSave={() => void contentSave.save()}
          saveDisabled={!contentSave.canSave}
          saveBusy={contentSave.isBusy}
          saveLabel={
            contentSave.stage === "uploading"
              ? `Uploading ${contentSave.uploadProgress}%`
              : contentSave.stage === "validating"
                ? "Validating"
                : "Save"
          }
          domainActions={
            <CreatorEffectHandoffActions
              itemId={
                existingQuery.data?.origin === "owned" &&
                existingQuery.data.source
                  ? existingQuery.data.item_id
                  : null
              }
              componentType="scene_effect"
            />
          }
        />
      }
      leftPanelLabel="Setup"
      rightPanelLabel="Inspector"
      leftPanel={
        <SceneSetupPanel
          document={document}
          selectedLayer={selectedLayer}
          soundOptions={soundOptions}
          soundPending={soundQuery.isPending}
          startingTemplate={startingTemplate}
          onStartingTemplate={setStartingTemplate}
          onSelectedLayer={setSelectedLayer}
          onDispatch={(action) => {
            dispatch(action);
            restartPreview();
          }}
          onBackground={(patch) =>
            replaceDocument(
              sceneEffectEditorReducer(document, {
                type: "patch-background",
                patch,
              }),
            )
          }
        />
      }
      rightPanel={
        <SceneInspectorPanel
          document={document}
          selectedLayer={selectedLayer}
          validation={validation}
          avatarStatus={avatarStatus}
          imageBusy={imageBusy}
          imageError={imageError}
          imageUrls={imageUrls}
          saveErrorField={contentSave.errorField}
          onDispatch={(action) => {
            dispatch(action);
            restartPreview();
          }}
          onItemsChange={onItemsChange}
          onChooseImage={choosePrivateImage}
          onChooseSticker={chooseSticker}
          onBackground={(patch) =>
            replaceDocument(
              sceneEffectEditorReducer(document, {
                type: "patch-background",
                patch,
              }),
            )
          }
          onSelectedLayer={setSelectedLayer}
          onClearSaveErrorField={contentSave.clearSaveErrorField}
        />
      }
      canvasControls={
        <CreatorCanvasControls
          model={{
            label: "Model",
            value: selectedModel?.key ?? "",
            placeholder: "Avatar",
            options: modelPreview.modelOptions.map((source) => ({
              value: source.key,
              label: source.displayName,
            })),
            onValueChange: (key) => {
              const source = modelPreview.modelOptions.find(
                (item) => item.key === key,
              );
              if (source) modelPreview.selectModel(source);
            },
            triggerClassName: "w-[150px]",
          }}
          view={{
            label: "View",
            value: cameraProfile,
            options: [
              { value: "full-body", label: "Full scene" },
              { value: "portrait", label: "Portrait" },
            ],
            onValueChange: (value) =>
              setCameraProfile(value as typeof cameraProfile),
            triggerClassName: "w-[110px]",
          }}
          playbackControl={
            <CreatorTimelineTransport
              label="preview"
              playing={playing}
              onTogglePlayback={() => setPreviewPlaying(!playing)}
              onStop={() => setPreviewPlaying(false)}
              onRestart={restartPreviewWithSound}
            />
          }
        />
      }
      overlays={
        <>
          {hydration.state === "error" ? (
            <CreatorInlineError
              message={hydration.message ?? "Unable to open effect."}
            />
          ) : null}
          <CreatorRecoveryNotice
            className={CREATOR_STAGE_NOTICE_CLASS}
            error={contentSave.error}
            recoveryWarning={contentSave.recoveryWarning}
            // A template route asks about its draft in a dialog instead.
            recovered={contentSave.recovered && !templateId}
            busy={contentSave.isBusy || imageBusy}
            contentLabel="Scene Effect"
            onDiscardServerDraft={() => void contentSave.discardRecovery()}
            onDiscardRecovery={() => void discardRecoveredDraft()}
          />
          <CreatorJsonDialog
            open={jsonOpen}
            onOpenChange={setJsonOpen}
            title="Portable Scene Effect JSON"
            description="The authoring document contains local logical image names and exact dependency sources, never Blob URLs or storage capabilities."
            actions={
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setJsonOpen(false);
                    setImportText(exportText);
                    setImportOpen(true);
                  }}
                >
                  <FolderOpenIcon /> Import
                </Button>
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(exportText);
                    toast.success("JSON copied.");
                  }}
                >
                  <Code2Icon /> Copy JSON
                </Button>
              </>
            }
          >
            <Textarea
              className="max-h-[55vh] min-h-80 font-mono text-xs"
              readOnly
              value={exportText}
            />
          </CreatorJsonDialog>
          <CreatorImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            title="Import Scene Effect JSON"
            description="Paste an Animama Scene Effect editor document. Private image bytes must be reselected."
            text={importText}
            error={importError}
            onTextChange={setImportText}
            onImport={importDocument}
          />
          <CreatorLeaveDialog guard={leaveGuard} contentLabel="Scene Effect" />
          {templateDraftDialog}
        </>
      }
    />
  );
}

function SceneSetupPanel({
  document,
  selectedLayer,
  soundOptions,
  soundPending,
  startingTemplate,
  onStartingTemplate,
  onSelectedLayer,
  onDispatch,
  onBackground,
}: {
  document: SceneEffectEditorDocument;
  selectedLayer: BackgroundLayer;
  onBackground: (patch: Partial<SceneEffectEditorBackground>) => void;
  startingTemplate: SceneEffectTemplateId | null;
  onStartingTemplate: (templateId: SceneEffectTemplateId) => void;
  soundOptions: Array<{
    item_id: string;
    name: string;
    source: PyExactContentSource | null;
  }>;
  soundPending: boolean;
  onSelectedLayer: (layer: BackgroundLayer) => void;
  onDispatch: React.Dispatch<Parameters<typeof sceneEffectEditorReducer>[1]>;
}) {
  return (
    <FloatingPanel title="Scene Setup" bodyClassName="overflow-y-auto">
      <Tabs
        value={document.kind}
        onValueChange={(kind) =>
          onDispatch({
            type: "set-kind",
            kind: kind as SceneEffectEditorDocument["kind"],
          })
        }
      >
        <TabsList className="grid h-9 w-full grid-cols-2">
          <TabsTrigger
            value="background_layers"
            className="min-w-0 px-1 text-xs"
          >
            Background
          </TabsTrigger>
          <TabsTrigger value="focus_lines" className="min-w-0 px-1 text-xs">
            Focus Lines
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="mt-3 space-y-3">
        <Field label="Starting template">
          <Select
            // The template shows while the document is still of its kind.
            value={
              SCENE_EFFECT_TEMPLATE_OPTIONS.some(
                (template) =>
                  template.id === startingTemplate &&
                  template.kind === document.kind,
              )
                ? (startingTemplate ?? "")
                : ""
            }
            onValueChange={(value) => {
              onStartingTemplate(value as SceneEffectTemplateId);
              onDispatch({
                type: "replace",
                document: applySceneEffectTemplate(
                  document,
                  value as SceneEffectTemplateId,
                ),
              });
            }}
          >
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue placeholder="Custom" />
            </SelectTrigger>
            <SelectContent>
              {SCENE_EFFECT_TEMPLATE_OPTIONS.filter(
                (template) => template.kind === document.kind,
              ).map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {document.kind === "background_layers" ? (
          <div className="space-y-2">
            <Label className="text-xs">Layers (front to back)</Label>
            <LayerCard
              selected={selectedLayer === "flash"}
              title="Entry flash"
              subtitle={`${document.background.flash.color} · ${document.background.flash.durationMs} ms`}
              enabled={document.background.flash.enabled}
              onSelect={() => onSelectedLayer("flash")}
              onEnabled={(enabled) =>
                onBackground({
                  flash: { ...document.background.flash, enabled },
                })
              }
            />
            {document.background.scatters
              .map((layer, index) => ({ layer, index }))
              .reverse()
              .map(({ layer, index }) => (
                <LayerCard
                  key={index}
                  selected={selectedLayer === `scatter:${index}`}
                  title={`Scatter ${index + 1}`}
                  subtitle={`${layer.items.length} items · ${layer.count} shown · ${humanize(layer.pulse)}`}
                  enabled={layer.enabled}
                  onSelect={() => onSelectedLayer(`scatter:${index}`)}
                  onEnabled={(enabled) =>
                    onBackground({
                      scatters: document.background.scatters.map((other, at) =>
                        at === index ? { ...other, enabled } : other,
                      ),
                    })
                  }
                />
              ))}
            {document.background.scatters.length <
            SCENE_EFFECT_LIMITS.scatter.layers ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  const index = document.background.scatters.length;
                  onBackground({
                    scatters: [
                      ...document.background.scatters,
                      defaultSceneScatter(index + 1),
                    ],
                  });
                  onSelectedLayer(`scatter:${index}`);
                }}
              >
                <PlusIcon /> Add scatter layer
              </Button>
            ) : null}
            <LayerCard
              selected={selectedLayer === "marquee"}
              title="Marquee"
              subtitle={`${document.background.marquee.items.length} items · ${humanize(document.background.marquee.direction)}`}
              enabled={document.background.marquee.enabled}
              onSelect={() => onSelectedLayer("marquee")}
              onEnabled={(enabled) =>
                onDispatch({ type: "patch-marquee", patch: { enabled } })
              }
            />
            <LayerCard
              selected={selectedLayer === "screen"}
              title="Screen"
              subtitle={`${humanize(document.background.screen.kind)} · ${document.background.screen.count}`}
              enabled={document.background.screen.enabled}
              onSelect={() => onSelectedLayer("screen")}
              onEnabled={(enabled) =>
                onBackground({
                  screen: { ...document.background.screen, enabled },
                })
              }
            />
            <LayerCard
              selected={selectedLayer === "tile"}
              title="Tile"
              subtitle={
                document.background.tile.image?.logicalName ?? "No image"
              }
              enabled={document.background.tile.enabled}
              onSelect={() => onSelectedLayer("tile")}
              onEnabled={(enabled) =>
                onBackground({
                  tile: { ...document.background.tile, enabled },
                })
              }
            />
            <LayerCard
              selected={selectedLayer === "pattern"}
              title="Pattern"
              subtitle={`${humanize(document.background.pattern.pattern)} · ${document.background.pattern.size}px`}
              enabled={document.background.pattern.enabled}
              onSelect={() => onSelectedLayer("pattern")}
              onEnabled={(enabled) =>
                onDispatch({ type: "patch-pattern", patch: { enabled } })
              }
            />
            <LayerCard
              selected={selectedLayer === "gradient"}
              title="Gradient"
              subtitle={`${humanize(document.background.gradient.type)} · ${document.background.gradient.stops.length} stops`}
              enabled={document.background.gradient.enabled}
              onSelect={() => onSelectedLayer("gradient")}
              onEnabled={(enabled) =>
                onBackground({
                  gradient: { ...document.background.gradient, enabled },
                })
              }
            />
            <LayerCard
              selected={selectedLayer === "solid"}
              title="Solid"
              subtitle={document.background.solid.color}
              enabled={document.background.solid.enabled}
              onSelect={() => onSelectedLayer("solid")}
              onEnabled={(enabled) =>
                onDispatch({ type: "patch-solid", patch: { enabled } })
              }
            />
          </div>
        ) : (
          <div className="border-border/70 bg-background/55 rounded-lg border p-3">
            <div className="text-xs font-medium">Focus Lines</div>
            <p className="text-muted-foreground text-xs">
              Emphasize the Avatar’s face or a selected area.
            </p>
          </div>
        )}

        <div className="border-border/70 space-y-3 border-t pt-3">
          <Label>Effect behavior</Label>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Duration (s)"
              value={
                document.durationMs === null ? 5 : document.durationMs / 1000
              }
              min={0.1}
              max={30}
              step={0.1}
              disabled={document.durationMs === null}
              onChange={(seconds) =>
                onDispatch({
                  type: "patch",
                  patch: { durationMs: Math.round(seconds * 1000) },
                })
              }
            />
            <ToggleRow
              label="Sticky"
              checked={document.durationMs === null}
              onChecked={(sticky) =>
                onDispatch({
                  type: "patch",
                  patch: { durationMs: sticky ? null : 5000 },
                })
              }
            />
          </div>
          <ToggleRow
            label="Cover UI overlays"
            description="Preview the effect over app chrome when supported."
            checked={document.coverUiOverlays}
            onChecked={(coverUiOverlays) =>
              onDispatch({ type: "patch", patch: { coverUiOverlays } })
            }
          />
          <ToggleRow
            label="Dismiss on input"
            checked={document.dismissOnInput}
            onChecked={(dismissOnInput) =>
              onDispatch({ type: "patch", patch: { dismissOnInput } })
            }
          />
          <Field label="Sound when applied">
            <SoundUploadButton />
            <Select
              value={soundSourceKey(document.sound?.source ?? null)}
              onValueChange={(value) => {
                if (value === "none") {
                  onDispatch({ type: "patch", patch: { sound: null } });
                  return;
                }
                const option = soundOptions.find(
                  (item) => soundSourceKey(item.source) === value,
                );
                if (!option?.source) return;
                onDispatch({
                  type: "patch",
                  patch: {
                    sound: {
                      alias: "on-apply",
                      label: option.name,
                      source: option.source,
                    },
                  },
                });
              }}
            >
              <SelectTrigger size="sm" className="w-full text-xs">
                <SelectValue
                  placeholder={soundPending ? "Loading sounds…" : "No sound"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No sound</SelectItem>
                {document.sound &&
                !soundOptions.some(
                  (item) =>
                    soundSourceKey(item.source) ===
                    soundSourceKey(document.sound?.source ?? null),
                ) ? (
                  <SelectItem value={soundSourceKey(document.sound.source)}>
                    {document.sound.label} · exact content
                  </SelectItem>
                ) : null}
                {soundOptions.flatMap((item) =>
                  item.source ? (
                    <SelectItem
                      key={item.item_id}
                      value={soundSourceKey(item.source)}
                    >
                      {item.name}
                    </SelectItem>
                  ) : (
                    []
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Description">
            <Textarea
              className="min-h-16 text-xs"
              rows={2}
              value={document.description}
              maxLength={2000}
              onChange={(event) =>
                onDispatch({
                  type: "patch",
                  patch: { description: event.target.value },
                })
              }
            />
          </Field>
        </div>
      </div>
    </FloatingPanel>
  );
}

function LayerCard({
  selected,
  title,
  subtitle,
  enabled,
  onSelect,
  onEnabled,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  enabled: boolean;
  onSelect: () => void;
  onEnabled: (enabled: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "border-border/70 bg-background/55 flex items-center gap-2 rounded-lg border p-2",
        selected && "border-sky-300 bg-sky-50/75 dark:bg-sky-950/35",
      )}
    >
      <GripVerticalIcon className="text-muted-foreground size-4" />
      <button
        type="button"
        className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <div className="text-sm font-medium">{title}</div>
        <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
      </button>
      <Switch
        checked={enabled}
        onCheckedChange={onEnabled}
        aria-label={`${title} enabled`}
      />
    </div>
  );
}

function SceneInspectorPanel({
  document,
  selectedLayer,
  validation,
  avatarStatus,
  imageBusy,
  imageError,
  imageUrls,
  saveErrorField,
  onDispatch,
  onItemsChange,
  onChooseImage,
  onChooseSticker,
  onBackground,
  onSelectedLayer,
  onClearSaveErrorField,
}: {
  document: SceneEffectEditorDocument;
  selectedLayer: BackgroundLayer;
  validation: ReturnType<typeof validateSceneEffectDocument>;
  avatarStatus: PreviewStatus;
  imageBusy: boolean;
  imageError: string | null;
  imageUrls: ReadonlyMap<string, string>;
  saveErrorField: string | null;
  onDispatch: React.Dispatch<Parameters<typeof sceneEffectEditorReducer>[1]>;
  onItemsChange: (
    target: Exclude<SceneEffectImageTarget, { kind: "tile" }>,
    items: SceneEffectEditorMarqueeItem[],
  ) => void;
  onChooseImage: (file: File, target: SceneEffectImageTarget) => void;
  onChooseSticker: (
    sticker: SceneSticker,
    target: SceneEffectImageTarget,
  ) => void;
  onBackground: (patch: Partial<SceneEffectEditorBackground>) => void;
  onSelectedLayer: (layer: BackgroundLayer) => void;
  onClearSaveErrorField: (field: string) => void;
}) {
  /** Image controls whose chosen file goes to `target`. */
  const imagesFor = (target: SceneEffectImageTarget): SceneImageControls => ({
    imageBusy,
    imageError,
    imageUrls,
    filesInvalid: saveErrorField === "files",
    onChooseImage: (file) => {
      onClearSaveErrorField("files");
      void onChooseImage(file, target);
    },
    onChooseSticker: (sticker) => {
      onClearSaveErrorField("files");
      void onChooseSticker(sticker, target);
    },
  });
  const background = document.background;
  // A scatter layer that no longer exists (undo, reopen) shows the marquee.
  const selected =
    scatterIndex(selectedLayer) !== null &&
    !background.scatters[scatterIndex(selectedLayer)!]
      ? "marquee"
      : selectedLayer;
  const scatter = scatterIndex(selected);
  return (
    <FloatingPanel
      title="Inspector"
      summary={
        document.kind === "background_layers"
          ? scatter !== null
            ? `Scatter ${scatter + 1} layer`
            : `${humanize(selected)} layer`
          : "Focus Lines"
      }
      bodyClassName="overflow-y-auto"
    >
      {document.kind === "background_layers" ? (
        selected === "marquee" ? (
          <MarqueeInspector
            document={document}
            images={imagesFor({ kind: "marquee" })}
            onDispatch={onDispatch}
            onItemsChange={(items) => onItemsChange({ kind: "marquee" }, items)}
          />
        ) : scatter !== null && background.scatters[scatter] ? (
          <ScatterInspector
            key={scatter}
            layer={background.scatters[scatter]}
            index={scatter}
            images={imagesFor({ kind: "scatter", index: scatter })}
            onLayer={(layer) =>
              onBackground({
                scatters: background.scatters.map((other, index) =>
                  index === scatter ? layer : other,
                ),
              })
            }
            onItemsChange={(items) =>
              onItemsChange({ kind: "scatter", index: scatter }, items)
            }
            onRemove={() => {
              onBackground({
                scatters: background.scatters.filter(
                  (_, index) => index !== scatter,
                ),
              });
              onSelectedLayer("marquee");
            }}
          />
        ) : selected === "gradient" ? (
          <GradientInspector
            background={background}
            onBackground={onBackground}
          />
        ) : selected === "tile" ? (
          <TileInspector
            background={background}
            onBackground={onBackground}
            images={imagesFor({ kind: "tile" })}
          />
        ) : selected === "screen" ? (
          <ScreenInspector
            background={background}
            onBackground={onBackground}
          />
        ) : selected === "flash" ? (
          <FlashInspector background={background} onBackground={onBackground} />
        ) : selected === "pattern" ? (
          <PatternInspector document={document} onDispatch={onDispatch} />
        ) : (
          <SolidInspector document={document} onDispatch={onDispatch} />
        )
      ) : (
        <FocusInspector document={document} onDispatch={onDispatch} />
      )}
      <details
        className="border-border/70 mt-3 border-t pt-3"
        open={
          validation.some((issue) => issue.severity === "error") || undefined
        }
      >
        <summary className="cursor-pointer text-xs font-medium">Checks</summary>
        <div className="mt-3 space-y-3">
          {validation.length ? (
            validation.map((issue, index) => (
              <StatusRow
                key={`${issue.field}:${index}`}
                good={issue.severity !== "error"}
                label={humanize(issue.field)}
                detail={issue.message}
              />
            ))
          ) : (
            <StatusRow
              good
              label="Ready to save"
              detail="Scene settings are ready."
            />
          )}
          <StatusRow
            good={avatarStatus.state === "ready"}
            label="Preview Avatar"
            detail={avatarStatus.message ?? humanize(avatarStatus.state)}
          />
        </div>
      </details>
    </FloatingPanel>
  );
}

function MarqueeInspector({
  document,
  images,
  onDispatch,
  onItemsChange,
}: {
  document: SceneEffectEditorDocument;
  images: SceneImageControls;
  onDispatch: React.Dispatch<Parameters<typeof sceneEffectEditorReducer>[1]>;
  onItemsChange: (items: SceneEffectEditorMarqueeItem[]) => void;
}) {
  const marquee = document.background.marquee;
  return (
    <Tabs defaultValue="content">
      <TabsList className="grid h-9 w-full grid-cols-3">
        <TabsTrigger value="content" className="min-w-0 px-1 text-xs">
          Content
        </TabsTrigger>
        <TabsTrigger value="motion" className="min-w-0 px-1 text-xs">
          Motion
        </TabsTrigger>
        <TabsTrigger value="appearance" className="min-w-0 px-1 text-xs">
          Appearance
        </TabsTrigger>
      </TabsList>
      <TabsContent value="content" className="mt-3 space-y-3">
        <SceneItemsEditor
          items={marquee.items}
          maxItems={SCENE_EFFECT_LIMITS.marquee.items}
          images={images}
          onItemsChange={onItemsChange}
        />
      </TabsContent>
      <TabsContent value="motion" className="mt-3 space-y-3">
        <Field label="Direction">
          <Select
            value={marquee.direction}
            onValueChange={(direction) =>
              onDispatch({
                type: "patch-marquee",
                patch: { direction: direction as typeof marquee.direction },
              })
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCENE_BACKGROUND_DIRECTIONS.map((direction) => (
                <SelectItem key={direction} value={direction}>
                  {humanize(direction)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          label="Speed (px/s)"
          value={marquee.speedPxPerSec}
          min={0}
          max={2000}
          step={10}
          onChange={(speedPxPerSec) =>
            onDispatch({ type: "patch-marquee", patch: { speedPxPerSec } })
          }
        />
        <Field label="Rotation">
          <Select
            value={marquee.itemRotationMode}
            onValueChange={(itemRotationMode) =>
              onDispatch({
                type: "patch-marquee",
                patch: {
                  itemRotationMode:
                    itemRotationMode as typeof marquee.itemRotationMode,
                },
              })
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCENE_BACKGROUND_ITEM_ROTATION_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {humanize(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          label="Rotation offset (deg)"
          value={marquee.itemRotationOffsetDeg}
          min={-360}
          max={360}
          step={1}
          onChange={(itemRotationOffsetDeg) =>
            onDispatch({
              type: "patch-marquee",
              patch: { itemRotationOffsetDeg },
            })
          }
        />
      </TabsContent>
      <TabsContent value="appearance" className="mt-3 grid grid-cols-2 gap-3">
        <NumberField
          label="Item size"
          value={marquee.itemSize}
          min={1}
          max={1024}
          step={1}
          onChange={(itemSize) =>
            onDispatch({ type: "patch-marquee", patch: { itemSize } })
          }
        />
        <NumberField
          label="Gap"
          value={marquee.gap}
          min={0}
          max={2048}
          step={1}
          onChange={(gap) =>
            onDispatch({ type: "patch-marquee", patch: { gap } })
          }
        />
        <NumberField
          label="Row gap"
          value={marquee.rowGap}
          min={0}
          max={2048}
          step={1}
          onChange={(rowGap) =>
            onDispatch({ type: "patch-marquee", patch: { rowGap } })
          }
        />
        <NumberField
          label="Opacity"
          value={marquee.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) =>
            onDispatch({ type: "patch-marquee", patch: { opacity } })
          }
        />
      </TabsContent>
    </Tabs>
  );
}

function PatternInspector({ document, onDispatch }: InspectorFieldsProps) {
  const pattern = document.background.pattern;
  return (
    <div className="space-y-3">
      <ToggleRow
        label="Pattern enabled"
        checked={pattern.enabled}
        onChecked={(enabled) =>
          onDispatch({ type: "patch-pattern", patch: { enabled } })
        }
      />
      <Field label="Pattern kind">
        <Select
          value={pattern.pattern}
          onValueChange={(value) =>
            onDispatch({
              type: "patch-pattern",
              patch: { pattern: value as SceneBackgroundPatternKind },
            })
          }
        >
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCENE_BACKGROUND_PATTERN_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {humanize(kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <ColorField
        label="Color"
        value={pattern.color}
        onChange={(color) =>
          onDispatch({ type: "patch-pattern", patch: { color } })
        }
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Size"
          value={pattern.size}
          min={1}
          max={512}
          step={1}
          onChange={(size) =>
            onDispatch({ type: "patch-pattern", patch: { size } })
          }
        />
        <NumberField
          label="Spacing"
          value={pattern.spacing}
          min={0}
          max={1024}
          step={1}
          onChange={(spacing) =>
            onDispatch({ type: "patch-pattern", patch: { spacing } })
          }
        />
        <NumberField
          label="Opacity"
          value={pattern.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) =>
            onDispatch({ type: "patch-pattern", patch: { opacity } })
          }
        />
      </div>
    </div>
  );
}

function SolidInspector({ document, onDispatch }: InspectorFieldsProps) {
  return (
    <div className="space-y-3">
      <ToggleRow
        label="Solid enabled"
        checked={document.background.solid.enabled}
        onChecked={(enabled) =>
          onDispatch({ type: "patch-solid", patch: { enabled } })
        }
      />
      <ColorField
        label="Solid color"
        value={document.background.solid.color}
        onChange={(color) =>
          onDispatch({ type: "patch-solid", patch: { color } })
        }
      />
    </div>
  );
}

function FocusInspector({ document, onDispatch }: InspectorFieldsProps) {
  const focus = document.focus;
  return (
    <Tabs defaultValue="target">
      <TabsList className="grid h-9 w-full grid-cols-4">
        <TabsTrigger value="target" className="min-w-0 px-1 text-xs">
          Target
        </TabsTrigger>
        <TabsTrigger value="geometry" className="min-w-0 px-1 text-xs">
          Lines
        </TabsTrigger>
        <TabsTrigger value="animation" className="min-w-0 px-1 text-xs">
          Motion
        </TabsTrigger>
        <TabsTrigger value="appearance" className="min-w-0 px-1 text-xs">
          Style
        </TabsTrigger>
      </TabsList>
      <TabsContent value="target" className="mt-3 space-y-3">
        <Field label="Render placement">
          <Select
            value={focus.renderPlacement}
            onValueChange={(renderPlacement) =>
              onDispatch({
                type: "patch-focus",
                patch: {
                  renderPlacement:
                    renderPlacement as typeof focus.renderPlacement,
                },
              })
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="behind_avatar">Behind Avatar</SelectItem>
              <SelectItem value="front_of_avatar">Front of Avatar</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Target">
          <Select
            value={focus.target.kind}
            onValueChange={(kind) =>
              onDispatch({
                type: "set-focus-target",
                target:
                  kind === "manual_box"
                    ? {
                        kind: "manual_box",
                        rect: { x: 0.33, y: 0.18, width: 0.34, height: 0.42 },
                      }
                    : { kind: "avatar_face", paddingXPx: 48, paddingYPx: 96 },
              })
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="avatar_face">Avatar face</SelectItem>
              <SelectItem value="manual_box">Manual box</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {focus.target.kind === "avatar_face" ? (
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Padding X"
              value={focus.target.paddingXPx}
              min={0}
              max={2048}
              step={1}
              onChange={(paddingXPx) =>
                onDispatch({
                  type: "set-focus-target",
                  target: {
                    kind: "avatar_face",
                    paddingXPx,
                    paddingYPx:
                      focus.target.kind === "avatar_face"
                        ? focus.target.paddingYPx
                        : 96,
                  },
                })
              }
            />
            <NumberField
              label="Padding Y"
              value={focus.target.paddingYPx}
              min={0}
              max={2048}
              step={1}
              onChange={(paddingYPx) =>
                onDispatch({
                  type: "set-focus-target",
                  target: {
                    kind: "avatar_face",
                    paddingXPx:
                      focus.target.kind === "avatar_face"
                        ? focus.target.paddingXPx
                        : 48,
                    paddingYPx,
                  },
                })
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {(["x", "y", "width", "height"] as const).map((field) => (
              <NumberField
                key={field}
                label={humanize(field)}
                value={
                  focus.target.kind === "manual_box"
                    ? focus.target.rect[field]
                    : 0
                }
                min={0}
                max={1}
                step={0.01}
                onChange={(value) =>
                  focus.target.kind === "manual_box" &&
                  onDispatch({
                    type: "set-focus-target",
                    target: {
                      ...focus.target,
                      rect: { ...focus.target.rect, [field]: value },
                    },
                  })
                }
              />
            ))}
          </div>
        )}
      </TabsContent>
      <TabsContent value="geometry" className="mt-3 grid grid-cols-2 gap-3">
        <NumberField
          label="Line count"
          value={focus.lineCount}
          min={1}
          max={256}
          step={1}
          onChange={(lineCount) =>
            onDispatch({ type: "patch-focus", patch: { lineCount } })
          }
        />
        <NumberField
          label="Base thickness"
          value={focus.baseThicknessPx}
          min={0.1}
          max={128}
          step={0.1}
          onChange={(baseThicknessPx) =>
            onDispatch({ type: "patch-focus", patch: { baseThicknessPx } })
          }
        />
        <NumberField
          label="Thickness variation"
          value={focus.thicknessVariationPx}
          min={0}
          max={128}
          step={0.1}
          onChange={(thicknessVariationPx) =>
            onDispatch({ type: "patch-focus", patch: { thicknessVariationPx } })
          }
        />
        <NumberField
          label="Length variation"
          value={focus.lengthVariation}
          min={0}
          max={1}
          step={0.01}
          onChange={(lengthVariation) =>
            onDispatch({ type: "patch-focus", patch: { lengthVariation } })
          }
        />
        <NumberField
          label="Overscan"
          value={focus.overscanPx}
          min={0}
          max={4096}
          step={1}
          onChange={(overscanPx) =>
            onDispatch({ type: "patch-focus", patch: { overscanPx } })
          }
        />
        <NumberField
          label="Seed"
          value={focus.seed ?? 0}
          min={0}
          max={2147483647}
          step={1}
          onChange={(seed) =>
            onDispatch({ type: "patch-focus", patch: { seed } })
          }
        />
      </TabsContent>
      <TabsContent value="animation" className="mt-3 grid grid-cols-2 gap-3">
        {(
          [
            "minVisibleMs",
            "maxVisibleMs",
            "minHiddenMs",
            "maxHiddenMs",
          ] as const
        ).map((field) => (
          <NumberField
            key={field}
            label={humanize(field)}
            value={focus.animation[field]}
            min={0}
            max={10000}
            step={10}
            onChange={(value) =>
              onDispatch({
                type: "patch-focus-animation",
                patch: { [field]: value },
              })
            }
          />
        ))}
        <NumberField
          label="Opacity jitter"
          value={focus.animation.opacityJitter}
          min={0}
          max={1}
          step={0.01}
          onChange={(opacityJitter) =>
            onDispatch({
              type: "patch-focus-animation",
              patch: { opacityJitter },
            })
          }
        />
      </TabsContent>
      <TabsContent value="appearance" className="mt-3 space-y-3">
        <ColorField
          label="Line color"
          value={focus.color}
          onChange={(color) =>
            onDispatch({ type: "patch-focus", patch: { color } })
          }
        />
        <NumberField
          label="Opacity"
          value={focus.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) =>
            onDispatch({ type: "patch-focus", patch: { opacity } })
          }
        />
      </TabsContent>
    </Tabs>
  );
}

type InspectorFieldsProps = {
  document: SceneEffectEditorDocument;
  onDispatch: React.Dispatch<Parameters<typeof sceneEffectEditorReducer>[1]>;
};

function StatusRow({
  good,
  label,
  detail,
}: {
  good: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex gap-2 text-xs">
      {good ? (
        <CheckCircle2Icon className="text-success mt-0.5 size-4 shrink-0" />
      ) : (
        <AlertTriangleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
      )}
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function ScenePreviewActor({
  entry,
  entryKey,
  onAvatarChange,
  onStatusChange,
}: {
  entry: Parameters<typeof useContentCreatorAvatar>[0]["entry"];
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
  return sceneObject ? <primitive object={sceneObject} dispose={null} /> : null;
}

async function hydrateSceneEffect(
  apiClient: Client,
  args: {
    itemId: string;
    name: string;
    description: string;
    signal: AbortSignal;
  },
): Promise<{
  document: SceneEffectEditorDocument;
  images: SceneEffectEditorImageResource[];
}> {
  const preview = await previewCatalogItem(
    apiClient,
    args.itemId,
    args.signal,
    "scene_effect",
  );
  const metadata = object(preview.metadata);
  const definition = metadata?.definition ?? object(metadata?.spec)?.definition;
  const logicalFiles = object(metadata?.logical_resource_files) ?? {};
  const imageMetadata = new Map<string, SceneEffectEditorImage>();
  const resources: SceneEffectEditorImageResource[] = [];
  for (const [logicalName, rawIdentity] of Object.entries(logicalFiles)) {
    const identity = object(rawIdentity);
    const file =
      preview.files.find((candidate) => candidate.filename === logicalName) ??
      findLogicalResourceFile(preview.files, identity ?? {});
    if (!file)
      throw new Error(`The content image ${logicalName} is unavailable.`);
    const response = await fetchContentPreviewFile(preview, file, {
      signal: args.signal,
    });
    if (!response.ok)
      throw new Error(
        `The content image ${logicalName} could not be downloaded.`,
      );
    const blob = await response.blob();
    const imageFile = new File([blob], file.filename, {
      type: file.media_type,
    });
    const sha256 =
      file.sha256 || (await sha256File(imageFile, { signal: args.signal }));
    imageMetadata.set(logicalName, {
      logicalName,
      originalName: file.filename,
      contentType: file.media_type,
      sizeBytes: file.size_bytes,
      sha256,
    });
    resources.push({ logicalName, file: imageFile, sha256 });
  }
  return {
    document: createSceneEffectDocumentFromDefinition({
      name: args.name,
      description: args.description,
      definition,
      images: imageMetadata,
      sound: previewSoundForCopy(preview).sound,
    }),
    images: resources,
  };
}

function soundSourceKey(source: PyExactContentSource | null): string {
  if (!source) return "none";
  return source.type === "builtin"
    ? `builtin:${source.content_id ?? ""}:${source.version ?? ""}`
    : `catalog:${source.catalog_item_id}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Interim (Plan 3 P1, until the creator loads the Included item with its
 * art): the code-drawn starting template a picker template opens with. A
 * background opens its family's template, a focus preset the bundled preset
 * of the same ID.
 */
const INTERIM_FAMILY_TEMPLATES: Record<
  Exclude<SceneEffectTemplateGroup, "focus-lines">,
  SceneEffectTemplateId
> = {
  affection: "shoujo-bloom",
  esteem: "radiance",
  delight: "festive-pop",
  drive: "anticipation",
  alarm: "shock",
  rejection: "rage",
  revulsion: "queasy",
  gloom: "gloom",
};

/** Interim: the starting template for a picker template ID, or null. */
function interimStartingTemplate(
  templateId: string,
): SceneEffectTemplateId | null {
  const template = findSceneEffectTemplate(templateId);
  if (!template) return null;
  const id =
    template.group === "focus-lines"
      ? template.id
      : INTERIM_FAMILY_TEMPLATES[template.group];
  return (
    SCENE_EFFECT_TEMPLATE_OPTIONS.find((option) => option.id === id)?.id ?? null
  );
}

/**
 * A new, unsaved Local draft from a picker template, named after it with a
 * name no catalog item uses. For now its layers come from the interim
 * starting template (see `interimStartingTemplate`), without the Included
 * effect's images.
 */
async function loadSceneEffectTemplate(
  apiClient: Client,
  templateId: string,
  signal: AbortSignal,
): Promise<SceneEffectHistorySnapshot> {
  const template = findSceneEffectTemplate(templateId);
  const startingTemplate = interimStartingTemplate(templateId);
  if (!template || !startingTemplate)
    throw new Error("This Scene Effect template is unavailable.");
  const items = await listCatalogItems(apiClient, "scene_effect", signal);
  return {
    document: {
      ...applySceneEffectTemplate(
        createDefaultSceneEffectDocument(),
        startingTemplate,
      ),
      name: createUniqueContentName(
        template.name,
        items.map((item) => item.name),
      ),
    },
    imageResources: [],
  };
}
