"use client";

import { useProductApiClient } from "@animama/product-ui";
import type { Client } from "@animama/runtime-contracts/sdk";
import type { AvatarFacePartCorrection } from "@animama/runtime-contracts/api-types";
import type { ThreeEvent } from "@react-three/fiber";
import { useFrame } from "@react-three/fiber";
import { useNavigate } from "@tanstack/react-router";
import { Code2Icon, FolderOpenIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Object3D } from "three";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { registerPrivateStateReset } from "@/app/runtime/private-module-state";
import { Avatar } from "@/lib/avatar";
import {
  avatarEffectRecoveryStore,
  avatarEffectRuntimeEntry,
  avatarEffectUsesOtherEyeImage,
  buildAvatarEffectEditorExport,
  cloneAvatarEffectDocument,
  createAvatarEffectDocumentFromDefinition,
  createDefaultAvatarEffectDocument,
  distinctAvatarEffectImageName,
  otherEyeAvatarEffectImageName,
  parseAvatarEffectEditorExport,
  validateAvatarEffectDocument,
  type AvatarEffectEditorAction,
  type AvatarEffectEditorAttachmentPatch,
  type AvatarEffectEditorDocument,
  type AvatarEffectEditorImageResources,
  type AvatarEffectEditorImageSlot,
} from "@/lib/avatar/vfx/editor";
import {
  assertAvatarEffectImageWithinLimits,
  MAX_AVATAR_EFFECT_IMAGE_DIMENSION,
} from "@/lib/avatar/vfx/effect-image-limits";
import {
  AVATAR_FACE_PART_LABELS,
  type AvatarFacePartRole,
} from "@/lib/avatar/vfx/faceParts";
import {
  isAttachmentVFXEntry,
  type AvatarVFXParsedEntry,
  type AvatarVFXSnapshot,
} from "@/lib/avatar/vfx/types";
import { buildRuntimePrimitiveBindings } from "@/lib/avatar/vrmEditorInspection";
import { previewCatalogItem } from "@/lib/content/catalogApi";
import type { PyContentPreview } from "@/lib/content/catalogTypes";
import { ContentEditorHydration } from "@/lib/content/contentEditorSource";
import {
  contentPreviewPrimaryFile,
  fetchContentPreviewFile,
} from "@/lib/content/contentPreview";
import { preflightContentFile, sha256File } from "@/lib/content/contentUploads";
import { findIncludedTemplateItem } from "@/lib/content/includedTemplateItem";
import { previewSoundForCopy } from "@/lib/content/previewSound";
import { avatarEffectTemplate } from "@/lib/effects/effectTemplates";
import { useAvatarFaceParts } from "@/query/hooks/useAvatarFaceParts";
import { useAvatarEffect, useSoundEffects } from "@/query/hooks/useEffects";
import { AvatarPreviewSurface } from "@/ui/avatar-preview/AvatarPreviewSurface";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import { Button } from "@/ui/components/button";
import { Textarea } from "@/ui/components/textarea";
import {
  CreatorCanvasControls,
  CreatorEffectHandoffActions,
  CreatorFloatingPanel as FloatingPanel,
  CreatorImportDialog,
  CreatorInlineError,
  CreatorJsonDialog,
  CreatorLeaveDialog,
  CreatorLoading,
  CREATOR_STAGE_NOTICE_CLASS,
  CreatorRecoveryNotice,
  CreatorToolbar,
  CreatorUnavailableState,
  CreatorWorkspaceShell,
  creatorItemUnavailableMessage,
  isCreatorItemOpenable,
} from "@/ui/content-creator";
import {
  contentCreatorModelCatalogItemId,
  type ContentCreatorModelSource,
} from "@/ui/content-creator/contentCreatorModelPreview";
import { CreatorTemplateDraftDialog } from "@/ui/content-creator/CreatorTemplateDraftDialog";
import { CreatorTimelineTransport } from "@/ui/content-creator/CreatorTimeline";
import { useContentCreatorAvatar } from "@/ui/content-creator/useContentCreatorAvatar";
import { useContentCreatorModelPreview } from "@/ui/content-creator/useContentCreatorModelPreview";
import { useCreatorLeaveGuard } from "@/ui/content-creator/useCreatorLeaveGuard";
import {
  creatorTemplateRecoveryKey,
  useCreatorTemplateStart,
} from "@/ui/content-creator/useCreatorTemplateStart";
import { ContentHealth } from "@/ui/content-health/ContentHealth";
import { useCreatorDocumentHistory } from "@/ui/creator-history/useCreatorDocumentHistory";
import { useContentPreviewAudio } from "@/ui/content-preview/useContentPreviewAudio";
import type { AvatarPreviewCameraProfile } from "@/ui/avatar-preview/AvatarPreviewSurface";

import {
  avatarEffectCreatorKeyboardAction,
  avatarEffectHistoryEdit,
  avatarEffectInitialView,
  avatarEffectPreviewApplyKey,
  avatarEffectPreviewChange,
  avatarEffectPreviewCompatibility,
  avatarEffectSnapshotFingerprint,
  createAvatarEffectHistorySnapshot,
  createAvatarEffectObjectUrlLease,
  equalAvatarEffectHistorySnapshots,
  NO_AVATAR_EFFECT_IMAGES,
  type AvatarEffectHistorySnapshot,
} from "./avatarEffectCreatorBehavior";
import { AvatarEffectFacePartsPanel } from "./AvatarEffectFacePartsPanel";
import { AvatarEffectGuideRenderer } from "./AvatarEffectGuideRenderer";
import { AvatarEffectInspector } from "./AvatarEffectInspector";
import {
  AvatarEffectHandleRenderer,
  createAvatarEffectManipulationState,
  useAvatarEffectManipulation,
} from "./AvatarEffectManipulator";
import { AvatarEffectSetupFields } from "./AvatarEffectSetupFields";
import { AvatarEffectUvPreview } from "./AvatarEffectUvPreview";
import { useAvatarEffectSave } from "./useAvatarEffectSave";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** The applied ID of the creator's own preview effect. */
const PREVIEW_EFFECT_ID = "avatar-effect-editor-preview";

/**
 * The preview's Model and View, kept across the remount from `/new` to the
 * saved item's edit route so Save does not reset them.
 */
let previewAfterSave: {
  itemId: string;
  model: ContentCreatorModelSource | null;
  view: AvatarPreviewCameraProfile;
} | null = null;
// The kept preview (which may name a private model) ends with its session.
registerPrivateStateReset(() => {
  previewAfterSave = null;
});

type PreviewStatus = {
  state: "idle" | "loading" | "ready" | "error";
  message: string | null;
};

type HydrationState = PreviewStatus;

const VIEW_OPTIONS: ReadonlyArray<{
  value: AvatarPreviewCameraProfile;
  label: string;
}> = [
  { value: "portrait-close", label: "Face" },
  { value: "portrait-three-quarter", label: "Three-quarter" },
  { value: "portrait", label: "Portrait" },
  { value: "full-body", label: "Full body" },
];

/**
 * Avatar Effect creator. `itemId` edits a saved item (an Included item is
 * saved as a Local copy); `templateId` starts a new draft from an Included
 * template (`/avatar-effects/new?template=<id>`); with neither it starts blank.
 */
export function AvatarEffectCreatorPage({
  itemId,
  templateId,
}: {
  itemId?: string;
  templateId?: string;
}) {
  const navigate = useNavigate();
  const userId = useRuntimeCacheKey();
  const apiClient = useProductApiClient();
  const existingQuery = useAvatarEffect(itemId ?? null);
  const {
    present: snapshot,
    history,
    update,
    reset,
  } = useCreatorDocumentHistory({
    initialValue: createAvatarEffectHistorySnapshot,
    equals: equalAvatarEffectHistorySnapshots,
  });
  const { document, imageResources } = snapshot;
  const dispatch = useCallback(
    (
      action: AvatarEffectEditorAction,
      nextImages?: Partial<AvatarEffectEditorImageResources>,
    ) => update(avatarEffectHistoryEdit(action, nextImages)),
    [update],
  );
  const resetDocument = useCallback(
    (
      nextDocument: AvatarEffectEditorDocument,
      nextImages: AvatarEffectEditorImageResources,
    ) =>
      reset({
        document: cloneAvatarEffectDocument(nextDocument),
        imageResources: nextImages,
      }),
    [reset],
  );
  // Read once: a preview kept by the Save that opened this edit route.
  const [keptPreview] = useState(() =>
    itemId && previewAfterSave?.itemId === itemId ? previewAfterSave : null,
  );
  useEffect(() => {
    previewAfterSave = null;
  }, []);
  const [selectedModel, setSelectedModel] =
    useState<ContentCreatorModelSource | null>(keptPreview?.model ?? null);
  const [previewAvatar, setPreviewAvatar] = useState<Avatar | null>(null);
  const [avatarStatus, setAvatarStatus] = useState<PreviewStatus>({
    state: "idle",
    message: null,
  });
  const [vfxSnapshot, setVfxSnapshot] = useState<AvatarVFXSnapshot | null>(
    null,
  );
  const [modelCompatible, setModelCompatible] = useState<boolean | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const guideCanvasRef = useRef<HTMLCanvasElement>(null);
  const handleCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const manipulationRef = useRef(createAvatarEffectManipulationState());
  const [cameraProfile, setCameraProfile] =
    useState<AvatarPreviewCameraProfile>(keptPreview?.view ?? "portrait-close");
  const previewSettingsRef = useRef({
    model: selectedModel,
    view: cameraProfile,
  });
  useEffect(() => {
    previewSettingsRef.current = { model: selectedModel, view: cameraProfile };
  }, [cameraProfile, selectedModel]);
  /** The document whose workspace has shown; see the loading screen below. */
  const [shownDocument, setShownDocument] = useState<string | null>(null);
  const [hydration, setHydration] = useState<HydrationState>({
    state: itemId || templateId ? "loading" : "ready",
    message: null,
  });
  /** A template route's recovered draft, held until the user chooses. */
  const [templateDraft, setTemplateDraft] =
    useState<AvatarEffectHistorySnapshot | null>(null);
  const [imageBusy, setImageBusy] =
    useState<AvatarEffectEditorImageSlot | null>(null);
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [imageError, setImageError] = useState<{
    slot: AvatarEffectEditorImageSlot;
    message: string;
  } | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<{
    image: string | null;
    otherEyeImage: string | null;
  }>({ image: null, otherEyeImage: null });
  /** Bumped when the preview Avatar's face part map is rebuilt. */
  const [facePartsVersion, setFacePartsVersion] = useState(0);
  const [pickingRole, setPickingRole] = useState<AvatarFacePartRole | null>(
    null,
  );
  const [pickedKey, setPickedKey] = useState<{
    key: string;
    sequence: number;
  } | null>(null);
  const usesOtherEyeImage = avatarEffectUsesOtherEyeImage(document);
  // Snapshot updates must not recreate the definition and restart playback.
  const previewEffect = useMemo(
    () =>
      imageUrls.image
        ? safeRuntimeEntry(document, {
            image: imageUrls.image,
            otherEyeImage: usesOtherEyeImage ? imageUrls.otherEyeImage : null,
          })
        : null,
    [document, imageUrls, usesOtherEyeImage],
  );
  // Reference guides are available before upload; this entry is never applied.
  const guideEffect = useMemo(() => {
    const entry =
      previewEffect ??
      safeRuntimeEntry(document, {
        image: "effect.webp",
        otherEyeImage: "effect-other.webp",
      });
    return entry && !isAttachmentVFXEntry(entry) ? entry : null;
  }, [document, previewEffect]);
  const [soundPreview, setSoundPreview] = useState<PyContentPreview | null>(
    null,
  );
  const hydratedItemRef = useRef(new ContentEditorHydration());
  const initialFingerprintRef = useRef(
    avatarEffectSnapshotFingerprint(snapshot),
  );

  const onRestore = useCallback(
    (recovered: AvatarEffectHistorySnapshot) => {
      if (templateId) {
        setTemplateDraft(recovered);
        return;
      }
      setHasAttemptedSave(false);
      resetDocument(recovered.document, recovered.imageResources);
      if (!keptPreview)
        setCameraProfile(avatarEffectInitialView(recovered.document));
      setHydration({ state: "ready", message: "Recovered local draft" });
      setPreviewRevision((value) => value + 1);
    },
    [keptPreview, resetDocument, templateId],
  );
  const onSaved = useCallback(
    (saved: AvatarEffectHistorySnapshot, savedItemId: string) => {
      // Only a first Save remounts the creator on the new edit route.
      if (savedItemId !== itemId) {
        previewAfterSave = {
          itemId: savedItemId,
          ...previewSettingsRef.current,
        };
      }
      dispatch({ type: "patch", patch: { name: saved.document.name } });
      hydratedItemRef.current.preserve(savedItemId);
      initialFingerprintRef.current = avatarEffectSnapshotFingerprint(saved);
    },
    [dispatch, itemId],
  );

  const validation = useMemo(
    () =>
      validateAvatarEffectDocument(document, {
        imageBytesAvailable: Boolean(imageResources.image),
        otherEyeImageBytesAvailable: Boolean(imageResources.otherEyeImage),
        modelCompatible,
      }),
    [document, imageResources, modelCompatible],
  );
  const hasBlockingIssues = validation.some(
    (issue) => issue.severity === "error",
  );
  const isDirty =
    avatarEffectSnapshotFingerprint(snapshot) !== initialFingerprintRef.current;
  const contentSave = useAvatarEffectSave({
    itemId,
    recoveryKey: templateId
      ? creatorTemplateRecoveryKey(templateId)
      : undefined,
    snapshot,
    dirty: isDirty,
    initialized: hydration.state === "ready",
    ready:
      !hasBlockingIssues &&
      !imageBusy &&
      hydration.state === "ready" &&
      Boolean(imageResources.image),
    onRestore,
    onSaved,
  });
  const unavailableMessage = creatorItemUnavailableMessage({
    itemId,
    label: "Avatar Effect",
    item: existingQuery.data,
    readFailed: existingQuery.isError,
    loadError:
      hydration.state === "error"
        ? (hydration.message ?? "The Avatar Effect could not be opened.")
        : null,
  });
  // The unavailable state has no leave dialog, so it must never block navigation.
  const guardLeave = !unavailableMessage;
  const leaveGuard = useCreatorLeaveGuard({
    dirty: guardLeave && isDirty,
    busy: guardLeave && contentSave.isBusy,
    discard: contentSave.discardChanges,
  });
  // A copy of a built-in effect never carries its licensed sound; say so.
  const [licensedSoundOmitted, setLicensedSoundOmitted] = useState(false);
  const installTemplateStart = useCallback(
    (next: AvatarEffectHistorySnapshot) => {
      setHasAttemptedSave(false);
      resetDocument(next.document, next.imageResources);
      setCameraProfile(avatarEffectInitialView(next.document));
      setPreviewRevision((value) => value + 1);
    },
    [resetDocument],
  );
  // The template loader must stay stable, or each render restarts the load.
  const loadTemplateSeed = useCallback(
    async (id: string, signal: AbortSignal) => {
      const { licensedSoundOmitted: omitted, ...seed } =
        await loadAvatarEffectTemplate(apiClient, id, signal);
      setLicensedSoundOmitted(omitted);
      return seed;
    },
    [apiClient],
  );
  const templateStart = useCreatorTemplateStart({
    templateId,
    loadSeed: loadTemplateSeed,
    fingerprint: avatarEffectSnapshotFingerprint,
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
      contentLabel="Avatar Effect"
      templateName={avatarEffectTemplate(templateId)?.name ?? "a template"}
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

  const modelPreview = useContentCreatorModelPreview({
    ownerKey: `avatar-effect-creator:${itemId ?? "new"}`,
    selectedModel,
    onSelectModel: setSelectedModel,
    includedAvatars: true,
  });
  const facePartsItemId = contentCreatorModelCatalogItemId(selectedModel);
  const facePartsQuery = useAvatarFaceParts(facePartsItemId);

  const soundQuery = useSoundEffects({ limit: 100, sort: "name" });
  const soundOptions = useMemo(
    () => soundQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [soundQuery.data?.pages],
  );
  const soundAudio = useContentPreviewAudio(soundPreview);

  const imageFile = imageResources.image?.file ?? null;
  const otherEyeFile = imageResources.otherEyeImage?.file ?? null;
  useEffect(() => {
    const leases = {
      image: imageFile ? createAvatarEffectObjectUrlLease(imageFile) : null,
      otherEyeImage: otherEyeFile
        ? createAvatarEffectObjectUrlLease(otherEyeFile)
        : null,
    };
    setImageUrls({
      image: leases.image?.url ?? null,
      otherEyeImage: leases.otherEyeImage?.url ?? null,
    });
    return () => {
      leases.image?.dispose();
      leases.otherEyeImage?.dispose();
    };
  }, [imageFile, otherEyeFile]);

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
    void hydrateAvatarEffect(apiClient, {
      itemId: item.item_id,
      name: item.name,
      description: item.description ?? "",
      signal: controller.signal,
    })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        load.complete();
        setHasAttemptedSave(false);
        setLicensedSoundOmitted(loaded.licensedSoundOmitted);
        resetDocument(loaded.document, loaded.imageResources);
        if (!keptPreview)
          setCameraProfile(avatarEffectInitialView(loaded.document));
        initialFingerprintRef.current =
          item.origin === "builtin"
            ? "__included_copy__"
            : avatarEffectSnapshotFingerprint(loaded);
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
              : "The Avatar Effect could not be opened.",
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
    keptPreview,
    resetDocument,
  ]);

  // Allow an incomplete document to be submitted for validation, without saving it.
  const canAttemptSave = Boolean(
    userId &&
    contentSave.recoveryReady &&
    !contentSave.isBusy &&
    !imageBusy &&
    hydration.state === "ready" &&
    (!itemId || existingQuery.data),
  );
  const saveDocument = contentSave.save;
  const attemptSave = useCallback(async () => {
    if (!canAttemptSave) return;
    setHasAttemptedSave(true);
    if (!hasBlockingIssues) await saveDocument();
  }, [canAttemptSave, hasBlockingIssues, saveDocument]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const action = avatarEffectCreatorKeyboardAction({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        editing: Boolean(editing),
      });
      if (action === "save") {
        event.preventDefault();
        if (canAttemptSave) void attemptSave();
        return;
      }
      if (action === "toggle-preview") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canAttemptSave, attemptSave]);

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

  const chooseImage = useCallback(
    async (slot: AvatarEffectEditorImageSlot, source: File) => {
      setImageError(null);
      contentSave.clearSaveErrorField("files");
      const fail = (message: string) => setImageError({ slot, message });
      if (!IMAGE_TYPES.has(source.type)) {
        fail("Choose one PNG, JPEG, or WebP image.");
        return;
      }
      if (source.size > MAX_IMAGE_BYTES) {
        fail("The effect image must be 16 MiB or smaller.");
        return;
      }
      setImageBusy(slot);
      try {
        // Size and dimensions come from the header, before the browser decodes it.
        try {
          await assertAvatarEffectImageWithinLimits(source);
        } catch {
          throw new Error(
            `The effect image must be at most ${MAX_AVATAR_EFFECT_IMAGE_DIMENSION} px on each side.`,
          );
        }
        const preflight = await preflightContentFile("image", source);
        if (preflight.error) throw new Error(preflight.error);
        // The two images are registered side by side, so their names differ.
        const logicalName =
          slot === "image"
            ? distinctAvatarEffectImageName(
                source.name,
                document.art.otherEyeImage?.logicalName ?? null,
                "main",
              )
            : otherEyeAvatarEffectImageName(
                source.name,
                document.art.image?.logicalName ?? null,
              );
        const file = new File([source], logicalName, {
          type: source.type,
          lastModified: source.lastModified,
        });
        const sha256 = await sha256File(file);
        dispatch(
          {
            type: "patch-art",
            patch: {
              [slot]: {
                logicalName,
                originalName: source.name,
                contentType: source.type,
                sizeBytes: source.size,
                sha256,
              },
            },
          },
          { [slot]: { file, sha256 } },
        );
        restartPreview();
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : "The image could not be read.",
        );
      } finally {
        setImageBusy(null);
      }
    },
    [
      contentSave,
      dispatch,
      document.art.image,
      document.art.otherEyeImage,
      restartPreview,
    ],
  );

  const importDocument = useCallback(() => {
    try {
      const parsed = parseAvatarEffectEditorExport(JSON.parse(importText));
      if (isDirty && !window.confirm("Replace the current unsaved document?"))
        return;
      dispatch({ type: "replace", document: parsed }, NO_AVATAR_EFFECT_IMAGES);
      setLicensedSoundOmitted(false);
      setImportError(null);
      setImportOpen(false);
      restartPreview();
      if (parsed.art.image) {
        toast.info("Reselect the imported document's images before saving.");
      }
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "The JSON could not be imported.",
      );
    }
  }, [dispatch, importText, isDirty, restartPreview]);

  /** Replace the document with a blank one on the plain `/new` route. */
  const resetToBlank = useCallback(async () => {
    const next = {
      document: createDefaultAvatarEffectDocument(),
      imageResources: NO_AVATAR_EFFECT_IMAGES,
    };
    if (!(await contentSave.resetSession(next))) return;
    setHasAttemptedSave(false);
    resetDocument(next.document, next.imageResources);
    setImageError(null);
    setImageBusy(null);
    setVfxSnapshot(null);
    setModelCompatible(null);
    setPlaying(true);
    setJsonOpen(false);
    setImportOpen(false);
    setImportText("");
    setImportError(null);
    initialFingerprintRef.current = avatarEffectSnapshotFingerprint(next);
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
        "Discard the current changes and start a new Avatar Effect?",
      )
    )
      return;

    try {
      // A saved item or a template draft starts over on the plain `/new` route.
      if (itemId || templateId) {
        if (userId)
          await avatarEffectRecoveryStore.clear(userId, "new", {
            strict: true,
          });
        if (!(await discardCurrentDraft())) return;
        await navigate({
          to: "/avatar-effects/new",
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

  const exportText = useMemo(
    () => JSON.stringify(buildAvatarEffectEditorExport(document), null, 2),
    [document],
  );

  // Direct manipulation: each drag is one undo group of attachment patches.
  const manipulationTarget = useMemo(
    () => ({
      beginGroup: history.beginGroup,
      endGroup: history.endGroup,
      apply: (patch: AvatarEffectEditorAttachmentPatch) =>
        dispatch({ type: "patch-attachment", patch }),
    }),
    [dispatch, history.beginGroup, history.endGroup],
  );
  const manipulationEnabled =
    Boolean(previewEffect) &&
    playing &&
    !pickingRole &&
    document.attachment.kind !== "silhouette" &&
    hydration.state === "ready";
  const manipulation = useAvatarEffectManipulation({
    containerRef: stageRef,
    stateRef: manipulationRef,
    enabled: manipulationEnabled,
    attachment: document.attachment,
    target: manipulationTarget,
  });

  // The selected Avatar lacks a face part the effect needs.
  const missingPart = useMemo(() => {
    void facePartsVersion;
    return previewEffect && previewAvatar?.vfxController
      ? previewAvatar.vfxController.findUnavailableFacePart(previewEffect)
      : null;
  }, [facePartsVersion, previewAvatar, previewEffect]);
  const missingPartMessage = missingPart
    ? `This Avatar has no detected ${AVATAR_FACE_PART_LABELS[missingPart]}, so the effect is not shown on it. Correct the part under Face parts, or preview another Avatar.`
    : null;

  /** Rebuild the preview Avatar's parts with a correction, then re-apply the effect. */
  const applyFacePartCorrection = useCallback(
    async (correction: AvatarFacePartCorrection | null) => {
      if (!previewAvatar) return;
      await previewAvatar.setFacePartCorrections(correction);
      setFacePartsVersion((value) => value + 1);
      // An effect skipped for a missing part is applied again with the new parts.
      setPreviewRevision((value) => value + 1);
    },
    [previewAvatar],
  );
  // Apply the saved correction when the loaded Avatar does not have it yet
  // (Included previews load without it).
  const savedCorrection = facePartsQuery.data?.face_parts ?? null;
  useEffect(() => {
    if (!previewAvatar || !facePartsQuery.isSuccess) return;
    if (
      JSON.stringify(previewAvatar.facePartCorrections ?? null) ===
      JSON.stringify(savedCorrection)
    )
      return;
    void applyFacePartCorrection(savedCorrection);
  }, [
    applyFacePartCorrection,
    facePartsQuery.isSuccess,
    previewAvatar,
    savedCorrection,
  ]);
  const handleAvatarChange = useCallback((avatar: Avatar | null) => {
    setPreviewAvatar(avatar);
    setFacePartsVersion((value) => value + 1);
  }, []);
  const handlePick = useCallback((key: string) => {
    setPickedKey((current) => ({
      key,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }, []);

  const saveErrorField = contentSave.errorField;
  const firstIssueField = hasAttemptedSave
    ? (validation.find((issue) => issue.severity === "error")?.field ?? null)
    : null;
  // A failed Save names its setting by definition path; validation by document
  // path. Both highlight (or open) the matching control.
  const invalidField =
    (saveErrorField ?? firstIssueField)?.replace(/^definition\.?/, "") || null;

  // Once this document has shown, a reload (Discard recovery on a saved item)
  // keeps the workspace and its preview Canvas mounted.
  const documentKey = itemId ?? templateId ?? "new";
  if (hydration.state === "ready" && shownDocument !== documentKey)
    setShownDocument(documentKey);
  if (unavailableMessage)
    return (
      <CreatorUnavailableState
        label="Avatar Effect"
        message={unavailableMessage}
      />
    );
  if (
    hydration.state === "loading" &&
    (itemId || templateId) &&
    shownDocument !== documentKey
  ) {
    return (
      <>
        <CreatorLoading
          message={
            hydration.message ??
            (templateId ? "Loading template…" : "Loading Avatar Effect…")
          }
        />
        {templateDraftDialog}
      </>
    );
  }

  const stageBadge = !document.art.image
    ? "Choose an image in Setup to preview the effect."
    : (missingPartMessage ??
      (pickingRole
        ? "Click a part of the avatar to add it to or remove it from the selected face part."
        : null));

  return (
    <CreatorWorkspaceShell
      canvas={
        <div
          ref={stageRef}
          className="relative size-full outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-inset"
          data-playback-surface="creator-stage"
          tabIndex={0}
          role="group"
          aria-label="Effect preview. Drag the art to move it, its corners to resize and its round handle to turn it. Arrow keys nudge it; Shift moves further."
          onKeyDown={manipulation.onKeyDown}
        >
          <AvatarPreviewSurface
            activeAvatar={previewAvatar}
            cameraProfile={cameraProfile}
            canvasTestId="avatar-effect-creator-canvas"
            lifecycleOwner="creator"
            minDistance={0.45}
            maxDistance={5}
            showSceneVFX={false}
            overlay={
              <>
                <div className="pointer-events-none absolute inset-0 z-20 bg-[radial-gradient(circle_at_center,transparent_20%,hsl(var(--background)/0.18)_72%,hsl(var(--background)/0.5)_100%)]" />
                {showGuides ? (
                  <canvas
                    ref={guideCanvasRef}
                    className="pointer-events-none absolute inset-0 z-30 size-full"
                    role="img"
                    aria-label="Placement guides"
                    data-testid="avatar-effect-placement-guides"
                  />
                ) : null}
                <canvas
                  ref={handleCanvasRef}
                  className="pointer-events-none absolute inset-0 z-30 size-full"
                  aria-hidden="true"
                  data-testid="avatar-effect-handles"
                />
                {stageBadge ? (
                  // Centred on the stage between the desktop panels, so a
                  // long message wraps instead of running under them.
                  <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--creator-header-height,3.5rem)+0.75rem)] z-40 flex justify-center px-4 lg:right-[calc(var(--creator-inset)+min(var(--creator-right-panel-width),27vw)+0.75rem)] lg:left-[calc(var(--app-shell-sidebar-inset)+var(--creator-inset)+min(var(--creator-left-panel-width),26vw)+0.75rem)] lg:px-0">
                    <p
                      role="status"
                      className="bg-background/90 text-foreground max-w-[28rem] rounded-md px-3 py-1.5 text-center text-xs shadow-sm"
                    >
                      {stageBadge}
                    </p>
                  </div>
                ) : null}
              </>
            }
          >
            {modelPreview.modelEntry && modelPreview.modelEntryKey ? (
              <AvatarEffectPreviewActor
                entry={modelPreview.modelEntry}
                entryKey={modelPreview.modelEntryKey}
                effect={previewEffect}
                skip={Boolean(missingPart)}
                playing={playing}
                revision={previewRevision}
                picking={Boolean(pickingRole)}
                onPick={handlePick}
                onAvatarChange={handleAvatarChange}
                onStatusChange={setAvatarStatus}
                onSnapshot={setVfxSnapshot}
                onCompatibilityChange={setModelCompatible}
              />
            ) : null}
            {showGuides ? (
              <AvatarEffectGuideRenderer
                avatar={previewAvatar}
                effect={guideEffect}
                appliedId={PREVIEW_EFFECT_ID}
                canvasRef={guideCanvasRef}
              />
            ) : null}
            <AvatarEffectHandleRenderer
              avatar={previewAvatar}
              appliedId={previewEffect ? PREVIEW_EFFECT_ID : null}
              enabled={manipulationEnabled}
              canvasRef={handleCanvasRef}
              stateRef={manipulationRef}
            />
          </AvatarPreviewSurface>
          <PlaybackObservationOutput
            active
            avatar={previewAvatar}
            sceneVFX={null}
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
                    : playing &&
                        imageUrls.image &&
                        ((vfxSnapshot?.activeEffects.length ?? 0) > 0 ||
                          (vfxSnapshot?.attachmentEffects.length ?? 0) > 0)
                      ? "playing"
                      : "stopped"
            }
            surface="creator-stage"
            target={{
              kind: "avatar_vfx",
              runtimeId: document.name.trim() || "new-avatar-effect",
            }}
          />
        </div>
      }
      toolbar={
        <CreatorToolbar
          contentHealth={<ContentHealth compact />}
          validationMessages={[
            ...(hasAttemptedSave
              ? validation.map((issue) => issue.message)
              : []),
            ...(missingPartMessage ? [missingPartMessage] : []),
            ...(vfxSnapshot?.warnings ?? []),
            ...[
              modelPreview.animaError,
              modelPreview.runtimeError,
              modelPreview.modelError,
              modelPreview.modelCatalogError,
            ].filter((message): message is string => Boolean(message)),
            ...(avatarStatus.state === "error"
              ? [avatarStatus.message ?? "Unable to load the preview Avatar."]
              : []),
            ...(hydration.state === "error"
              ? [hydration.message ?? "Unable to open effect."]
              : []),
          ]}
          history={history}
          historyDisabled={
            contentSave.isBusy ||
            Boolean(imageBusy) ||
            hydration.state !== "ready" ||
            !contentSave.recoveryReady
          }
          typeLabel="Avatar FX"
          contentType="avatar_effect"
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
          newDisabled={contentSave.isBusy || Boolean(imageBusy)}
          importDisabled={contentSave.isBusy || Boolean(imageBusy)}
          libraryDisabled={contentSave.isBusy || Boolean(imageBusy)}
          onNew={() => void startNewDocument()}
          onImport={() => {
            setImportText(exportText);
            setImportOpen(true);
          }}
          onJson={() => setJsonOpen(true)}
          onSave={() => void attemptSave()}
          saveDisabled={!canAttemptSave}
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
              componentType="avatar_effect"
            />
          }
        />
      }
      leftPanelLabel="Setup"
      rightPanelLabel="Inspector"
      leftPanel={
        <FloatingPanel title="Effect Setup" bodyClassName="overflow-y-auto">
          <AvatarEffectSetupFields
            document={document}
            imageResources={imageResources}
            imageBusy={imageBusy}
            imageError={imageError}
            invalidField={invalidField}
            soundOptions={soundOptions}
            soundPending={soundQuery.isPending}
            licensedSoundOmitted={licensedSoundOmitted && !document.sound}
            onDispatch={(action) => {
              if (action.type === "patch" && action.patch.sound !== undefined)
                contentSave.clearSaveErrorField("sound");
              dispatch(action);
            }}
            onChooseImage={(slot, file) => void chooseImage(slot, file)}
            onClearOtherEyeImage={() =>
              dispatch(
                { type: "patch-art", patch: { otherEyeImage: null } },
                { otherEyeImage: null },
              )
            }
          />
        </FloatingPanel>
      }
      rightPanel={
        <FloatingPanel
          title="Inspector"
          summary={attachmentSummary(document)}
          bodyClassName="overflow-y-auto"
        >
          <AvatarEffectInspector
            document={document}
            invalidField={invalidField}
            onDispatch={dispatch}
          />
        </FloatingPanel>
      }
      canvasControls={
        <CreatorCanvasControls
          model={{
            label: "Model",
            value: selectedModel?.key ?? "",
            placeholder: modelPreview.isModelCatalogPending
              ? "Loading…"
              : "Avatar",
            options: modelPreview.modelOptions.map((source) => ({
              value: source.key,
              label: source.displayName,
            })),
            onValueChange: (key) => {
              const source = modelPreview.modelOptions.find(
                (item) => item.key === key,
              );
              if (source) {
                setPickingRole(null);
                modelPreview.selectModel(source);
              }
            },
            triggerClassName: "w-[170px]",
          }}
          view={{
            label: "View",
            value: cameraProfile,
            options: VIEW_OPTIONS,
            onValueChange: (value) =>
              setCameraProfile(value as AvatarPreviewCameraProfile),
            triggerClassName: "w-[120px]",
          }}
          guides={showGuides}
          onGuidesChange={setShowGuides}
          domainControl={
            <>
              <AvatarEffectUvPreview
                avatar={previewAvatar}
                effect={guideEffect}
                appliedId={PREVIEW_EFFECT_ID}
              />
              <AvatarEffectFacePartsPanel
                avatar={previewAvatar}
                itemId={facePartsItemId}
                modelName={
                  modelPreview.modelOptions.find(
                    (option) => option.key === selectedModel?.key,
                  )?.displayName ??
                  selectedModel?.displayName ??
                  "this Avatar"
                }
                version={facePartsVersion}
                pickingRole={pickingRole}
                pickedKey={pickedKey}
                onPickingRoleChange={setPickingRole}
                onApplied={applyFacePartCorrection}
              />
            </>
          }
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
            busy={contentSave.isBusy || Boolean(imageBusy)}
            contentLabel="Avatar Effect"
            onDiscardServerDraft={() => void contentSave.discardRecovery()}
            onDiscardRecovery={() => void discardRecoveredDraft()}
          />

          <CreatorJsonDialog
            open={jsonOpen}
            onOpenChange={setJsonOpen}
            title="Portable Avatar Effect JSON"
            description="This document contains authoring values and exact dependency sources, but never local Blob URLs or capabilities."
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
            title="Import Avatar Effect JSON"
            description="Paste an Animama Avatar Effect editor document. Image bytes must be reselected."
            text={importText}
            error={importError}
            onTextChange={setImportText}
            onImport={importDocument}
          />
          <CreatorLeaveDialog guard={leaveGuard} contentLabel="Avatar Effect" />
          {templateDraftDialog}
        </>
      }
    />
  );
}

/** A short plain description of where the art goes, for the Inspector header. */
function attachmentSummary(document: AvatarEffectEditorDocument): string {
  const attachment = document.attachment;
  switch (attachment.kind) {
    case "face_landmark":
      return "Floating on the face";
    case "face_surface":
      return "Painted on the face";
    case "body":
      return "On the body";
    case "sticker":
      return "Sticker";
    case "silhouette":
      return "Silhouette fill";
  }
}

/** Apply one parsed preview entry with the controller method for its kind. */
function applyPreviewEffect(
  controller: NonNullable<Avatar["vfxController"]>,
  effect: AvatarVFXParsedEntry,
): Promise<void> {
  if (isAttachmentVFXEntry(effect))
    return controller.applyAttachmentVFX({
      effectId: effect.id,
      effectEntry: effect,
    });
  if (effect.kind === "hover")
    return controller.applyHoverVFX({
      effectId: effect.id,
      effectEntry: effect,
    });
  if (effect.kind === "face_anchored")
    return controller.applyFaceAnchoredVFX({
      effectId: effect.id,
      effectEntry: effect,
    });
  return controller.applyTextureVFX({
    effectId: effect.id,
    effectEntry: effect,
    applyMode: effect.applyMode,
  });
}

function AvatarEffectPreviewActor({
  entry,
  entryKey,
  effect,
  skip,
  playing,
  revision,
  picking,
  onPick,
  onAvatarChange,
  onStatusChange,
  onSnapshot,
  onCompatibilityChange,
}: {
  entry: Parameters<typeof useContentCreatorAvatar>[0]["entry"];
  entryKey: string;
  effect: AvatarVFXParsedEntry | null;
  /** The Avatar lacks a face part the effect needs; it is not applied. */
  skip: boolean;
  playing: boolean;
  revision: number;
  /** Clicks on the avatar pick face parts. */
  picking: boolean;
  onPick: (bindingKey: string) => void;
  onAvatarChange: (avatar: Avatar | null) => void;
  onStatusChange: (status: PreviewStatus) => void;
  onSnapshot: (snapshot: AvatarVFXSnapshot | null) => void;
  onCompatibilityChange: (compatible: boolean | null) => void;
}) {
  const { avatar, sceneObject } = useContentCreatorAvatar({
    entry,
    entryKey,
    onAvatarChange,
    onStatusChange,
  });

  useFrame((_, delta) => {
    if (playing) avatar?.vfxController?.update(delta);
  });

  // The Avatar exists before its async model load creates the VFX controller.
  const controller = avatar?.vfxController;
  // Placement edits update the applied effect in place; anything else re-applies.
  const applyKey = effect ? avatarEffectPreviewApplyKey(effect) : null;
  const effectRef = useRef(effect);
  const appliedRef = useRef<AvatarVFXParsedEntry | null>(null);
  effectRef.current = effect;
  useEffect(() => {
    const current = effectRef.current;
    appliedRef.current = null;
    if (!controller || !current || !playing || skip) {
      controller?.clearAllEffects();
      onSnapshot(controller?.getSnapshot() ?? null);
      onCompatibilityChange(null);
      return;
    }
    let cancelled = false;
    let applySettled = false;
    const update = () => {
      const snapshot = controller.getSnapshot();
      onSnapshot(snapshot);
      onCompatibilityChange(
        avatarEffectPreviewCompatibility({
          playing,
          hasController: true,
          hasEffect: true,
          applySettled,
          activeEffectCount:
            snapshot.activeEffects.length + snapshot.attachmentEffects.length,
        }),
      );
    };
    controller.clearAllEffects();
    onSnapshot(controller.getSnapshot());
    onCompatibilityChange(null);
    const unsubscribe = controller.subscribe(update);
    appliedRef.current = current;
    void applyPreviewEffect(controller, current).finally(() => {
      applySettled = true;
      if (cancelled) return;
      // Catch up with placement edits made while the art was loading.
      const latest = effectRef.current;
      const change = avatarEffectPreviewChange(appliedRef.current, latest);
      if (change.kind === "transform") {
        controller.updateEffectTransform(current.id, change.transform);
        appliedRef.current = latest;
      }
      update();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      controller.removeEffect(current.id);
      appliedRef.current = null;
    };
    // `effect` is read through the ref: only `applyKey` changes re-apply.
  }, [
    applyKey,
    controller,
    onCompatibilityChange,
    onSnapshot,
    playing,
    revision,
    skip,
  ]);

  useEffect(() => {
    const applied = appliedRef.current;
    if (!controller || !applied || !effect) return;
    const change = avatarEffectPreviewChange(applied, effect);
    if (change.kind !== "transform") return;
    if (controller.updateEffectTransform(effect.id, change.transform))
      appliedRef.current = effect;
  }, [controller, effect]);

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      if (!avatar) return;
      const entries = buildRuntimePrimitiveBindings(avatar).entries;
      // The nearest hit that is part of the avatar, not an effect plane.
      for (const intersection of event.intersections) {
        const hit = entries.find(
          (candidate) => candidate.object === (intersection.object as Object3D),
        );
        if (hit) {
          event.stopPropagation();
          onPick(hit.bindingKey);
          return;
        }
      }
    },
    [avatar, onPick],
  );

  if (!sceneObject) return null;
  return (
    <primitive
      object={sceneObject}
      dispose={null}
      onClick={picking ? handleClick : undefined}
    />
  );
}

/**
 * A new, unsaved Local draft copied from an Included template. It gets a name
 * no catalog item uses, so its first Save creates a separate Local item.
 */
async function loadAvatarEffectTemplate(
  apiClient: Client,
  templateId: string,
  signal: AbortSignal,
): Promise<AvatarEffectHydration> {
  const template = avatarEffectTemplate(templateId);
  if (!template) throw new Error("This Avatar Effect template is unavailable.");
  const { item, draftName } = await findIncludedTemplateItem(
    apiClient,
    "avatar_effect",
    template,
    signal,
  );
  return hydrateAvatarEffect(apiClient, {
    itemId: item.item_id,
    name: draftName,
    description: item.description ?? "",
    signal,
  });
}

/** Download one of the item's registered images as an editable File. */
async function previewImageResource(
  preview: PyContentPreview,
  logicalName: string | null,
  signal: AbortSignal,
) {
  const file =
    (logicalName
      ? preview.files.find(
          (candidate) =>
            candidate.role === "image" && candidate.filename === logicalName,
        )
      : null) ??
    (logicalName ? null : contentPreviewPrimaryFile(preview, "image"));
  if (!file) throw new Error("The content item has no editable image file.");
  const response = await fetchContentPreviewFile(preview, file, { signal });
  if (!response.ok)
    throw new Error("The content image could not be downloaded.");
  const blob = await response.blob();
  const imageFile = new File([blob], file.filename, { type: file.media_type });
  const sha256 = file.sha256 || (await sha256File(imageFile, { signal }));
  return {
    image: {
      logicalName: file.filename,
      originalName: file.filename,
      contentType: file.media_type,
      sizeBytes: file.size_bytes,
      sha256,
    },
    resource: { file: imageFile, sha256 },
  };
}

async function hydrateAvatarEffect(
  apiClient: Client,
  args: {
    itemId: string;
    name: string;
    description: string;
    signal: AbortSignal;
  },
): Promise<AvatarEffectHydration> {
  const preview = await previewCatalogItem(
    apiClient,
    args.itemId,
    args.signal,
    "avatar_effect",
  );
  const definition =
    preview.metadata.definition ?? object(preview.metadata.spec)?.definition;
  const art = object(object(definition)?.art);
  const imageName = typeof art?.image === "string" ? art.image : null;
  const otherEyeName =
    typeof art?.otherEyeImage === "string" ? art.otherEyeImage : null;
  const main = await previewImageResource(preview, imageName, args.signal);
  const otherEye = otherEyeName
    ? await previewImageResource(preview, otherEyeName, args.signal)
    : null;
  const { sound, licensedOmitted } = previewSoundForCopy(preview);
  return {
    document: createAvatarEffectDocumentFromDefinition({
      name: args.name,
      description: args.description,
      definition,
      image: main.image,
      otherEyeImage: otherEye?.image ?? null,
      sound,
    }),
    imageResources: {
      image: main.resource,
      otherEyeImage: otherEye?.resource ?? null,
    },
    licensedSoundOmitted: licensedOmitted,
  };
}

/** A loaded draft, and whether its built-in effect's licensed sound stayed behind. */
type AvatarEffectHydration = AvatarEffectHistorySnapshot & {
  licensedSoundOmitted: boolean;
};

function safeRuntimeEntry(
  document: AvatarEffectEditorDocument,
  urls: { image: string; otherEyeImage?: string | null },
): AvatarVFXParsedEntry | null {
  try {
    return avatarEffectRuntimeEntry(document, urls);
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
