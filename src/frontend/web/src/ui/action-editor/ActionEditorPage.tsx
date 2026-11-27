import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getI18n, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";

import { isNonPortable, nonPortableReason } from "@/lib/content/portability";
import type {
  PyCatalogViewItem,
  PyGesture,
  PyReaction,
} from "@/lib/content/catalogTypes";
import { failureLine, WordedError } from "@/lib/errors/apiError";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { useContentSaveFailure } from "@/hooks/useContentSaveFailure";
import {
  clearActionRecovery,
  clearActionRecoveryForNewDocument,
  loadActionRecoveryForEditorRoute,
  actionDocumentDigest,
  saveActionRecovery,
} from "@/lib/content/actionRecovery";
import {
  creatorActionPreviewRuntime,
  actionPreviewTarget,
} from "@/lib/content-preview/actionPreviewTarget";
import { actionComponentSandboxEntries } from "@/lib/content-preview/actionComponentSandbox";
import type { AnimaRuntimeCatalogSnapshot } from "@/lib/runtime-content/types";
import {
  useAvatarEffectsPage,
  useParticleEffects,
  useActionComponent,
  useSceneEffectsPage,
  useSoundEffects,
  type ActionComponentType,
} from "@/query/hooks/useEffects";
import { useAction } from "@/query/hooks/useActions";
import { useActionComponentPreviews } from "@/query/hooks/useActionComponentPreviews";
import {
  useContentGenerationWithheld,
  useGenerationConversation,
} from "@/query/hooks/useGeneration";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { ContentPreviewExclusiveCanvasGate } from "@/ui/content-preview/ContentPreviewDockProvider";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { useCreatorHistory } from "@/ui/creator-history/CreatorHistory";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import { createReactionDocument } from "@/ui/reaction-editor/reactionDocument";
import {
  addActionComponentEvent,
  mapActionDependency,
  removeActionDependency,
} from "./actionDependencies";
import {
  captureActionDocumentForSave,
  canonicalizeActionComponentInsertion,
} from "./actionPersistence";
import { pendingActionEditorPoseEdit } from "./actionEditorSavedPose";
import {
  commitAssistantResult,
  prepareCreatorForAssistantRun,
} from "./assistantRun";
import { ActionEditorPreviewProvider } from "./ActionEditorPreviewProvider";
import { ActionEditorWorkspace } from "./ActionEditorWorkspace";
import {
  ActionEditorWorkspaceProvider,
  type ActionDependencySection,
} from "./ActionEditorWorkspaceContext";
import {
  applyActionAuthoringSnapshot,
  normalizeActionDocument,
  actionAuthoringSnapshot,
  actionAuthoringSnapshotsEqual,
  hasHumanoidTracks,
  renameActionDocument,
  referencedAliases,
  validateActionDocument,
  type ActionDocument,
  type ActionIntent,
} from "./actionDocument";
import {
  actionEditorCapabilities,
  loadedActionEditorMode,
  newActionEditorMode,
} from "./actionEditorCapabilities";
import { loadCreatorPreviewFile } from "@/lib/content/contentEditorSource";
import {
  isCustomizableStarterAction,
  actionDocumentFromPreview,
  removedActionEffects,
} from "./actionDocumentLoader";
import type { ActionImport } from "./actionProject";
import {
  importedProjectDocument,
  parseActionImport,
  unresolvedActionReferences,
} from "./actionProject";
import {
  ActionDocumentIncompleteError,
  useSaveActionDocument,
} from "./useSaveActionDocument";
import {
  ActionManageDialog,
  type ManageActionTarget,
} from "@/ui/action-manage/ActionManageDialog";

function componentRows(value: unknown): PyCatalogViewItem[] {
  if (!value || typeof value !== "object") return [];
  const pages = (value as { pages?: Array<{ items: PyCatalogViewItem[] }> })
    .pages;
  return pages?.flatMap((page) => page.items) ?? [];
}

/** A catalog failure as one line; English without wording follows the uncoded-error rule. */
function queryErrorMessage(
  t: TFunction<"actionEditor">,
  error: unknown,
): string | null {
  if (!error) return null;
  return failureLine(error, t("page.catalogUnavailable"));
}

/**
 * The assistant draft a location opens in the creator (`?draft=`), or `null`.
 * The new-item editor is keyed by it, so a move to another draft, or to none,
 * on the same route replaces the document like a move to another page.
 */
function locationDraft(location: { search: unknown }): string | null {
  const { search } = location;
  const draft =
    search && typeof search === "object"
      ? (search as { draft?: unknown }).draft
      : null;
  return typeof draft === "string" && draft ? draft : null;
}

function exactSourceKey(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const value = source as Record<string, unknown>;
  if (value.type === "catalog" && typeof value.catalog_item_id === "string")
    return `catalog:${value.catalog_item_id}`;
  if (
    value.type === "builtin" &&
    typeof value.content_id === "string" &&
    typeof value.version === "number"
  )
    return `builtin:${value.content_id}@${value.version}`;
  return null;
}

/** Typed draft orchestration; all visual authoring lives in the workspace. */
export function ActionEditorPage({
  intent,
  itemId,
  initialComponent,
  initialComponentType,
  initialDraft,
}: {
  intent: ActionIntent;
  itemId?: string;
  initialComponent?: string;
  initialComponentType?: ActionComponentType;
  /**
   * A content assistant draft to open in a new document ("Open in creator").
   * Its project is loaded through the import path, so it arrives unsaved.
   */
  initialDraft?: { conversationId: string; draftId: string };
}) {
  const { t } = useTranslation("actionEditor");
  const createDocument = useCallback(
    () =>
      intent === "gesture" ? createGestureDocument() : createReactionDocument(),
    [intent],
  );
  const [document, setDocument] = useState<ActionDocument>(createDocument);
  const cleanDigest = useRef(actionDocumentDigest(document));
  const documentRef = useRef(document);
  documentRef.current = document;
  const [activeItemId, setActiveItemId] = useState<string | null>(
    itemId ?? null,
  );
  const [vrma, setVrma] = useState<File | null>(null);
  const [dependencyQuery, setDependencyQuery] = useState("");
  const [activeDependencyType, setActiveDependencyType] =
    useState<ActionComponentType>("particle_effect");
  const [timelineSession, setTimelineSession] = useState(0);
  const {
    capture: captureSaveFailure,
    clear: clearSaveFailure,
    clearField: clearSaveErrorField,
    error,
    errorField,
    setMessage: setFailureMessage,
  } = useContentSaveFailure();
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [manageTarget, setManageTarget] = useState<ManageActionTarget | null>(
    null,
  );
  const [previewRuntime, setPreviewRuntime] =
    useState<AnimaRuntimeCatalogSnapshot | null>(null);
  const [rootPreviewDependencyDigest, setRootPreviewDependencyDigest] =
    useState<string | null>(null);
  const capabilities = actionEditorCapabilities(intent);
  const [mode, setMode] = useState(
    itemId
      ? loadedActionEditorMode(intent, document.implementation)
      : newActionEditorMode(intent, initialComponent),
  );
  const hydrated = useRef(false);
  const hydrating = useRef(false);
  const [hydrationReady, setHydrationReady] = useState(false);
  const finalized = useRef(false);
  const recoveryDiscarded = useRef(false);
  const recoveryGeneration = useRef(0);
  const internalNavigation = useRef(false);
  const initialComponentApplied = useRef(false);
  // The save itself, with the edit session it keeps between attempts.
  const saver = useSaveActionDocument(intent);
  const {
    actions,
    identity,
    stage: saveStage,
    setStage: setSaveStage,
    resetSession: resetSaveSession,
    restoreSession: restoreSaveSession,
  } = saver;
  // Stable across renders, unlike the `actionPreview` object around it.
  const loadActionPreview = actions.actionPreview.load;
  const userId = useRuntimeCacheKey();
  const navigate = useNavigate();
  const existing = useAction(intent, itemId ?? null);
  const previewDependenciesRef = useRef({
    digest: JSON.stringify(document.dependencies),
    value: document.dependencies,
  });
  const dependencyDigest = JSON.stringify(document.dependencies);
  if (previewDependenciesRef.current.digest !== dependencyDigest) {
    previewDependenciesRef.current = {
      digest: dependencyDigest,
      value: document.dependencies,
    };
  }
  const componentPreviews = useActionComponentPreviews(
    previewDependenciesRef.current.value,
    { enabled: rootPreviewDependencyDigest !== dependencyDigest },
  );
  const sandboxEntries = useMemo(
    () =>
      componentPreviews.previews.flatMap(({ dependency, preview }) =>
        actionComponentSandboxEntries(preview, dependency),
      ),
    [componentPreviews.previews],
  );

  const applyHistorySnapshot = useCallback(
    (snapshot: ReturnType<typeof actionAuthoringSnapshot>) =>
      setDocument((current) => applyActionAuthoringSnapshot(current, snapshot)),
    [],
  );
  const history = useCreatorHistory({
    initialValue: actionAuthoringSnapshot(document),
    onApply: applyHistorySnapshot,
    equals: actionAuthoringSnapshotsEqual,
  });
  const historyRef = useRef(history);
  historyRef.current = history;

  const replaceLoadedDocument = useCallback(
    (next: ActionDocument, clean = false) => {
      const normalized = normalizeActionDocument(next);
      setValidationAttempted(false);
      setDocument(normalized);
      setTimelineSession((value) => value + 1);
      historyRef.current.reset(actionAuthoringSnapshot(normalized));
      if (clean) cleanDigest.current = actionDocumentDigest(normalized);
    },
    [],
  );

  // `t` changes with the UI Locale, so the issues are worded again.
  const issues = useMemo(
    () => validateActionDocument(document, t),
    [document, t],
  );
  const busy =
    actions.beginSession.isPending ||
    actions.updateSession.isPending ||
    actions.actionPreview.isPending ||
    actions.stageFile.isPending ||
    actions.save.isPending ||
    saveStage !== "idle";
  const dirty = actionDocumentDigest(document) !== cleanDigest.current;
  useEffect(() => {
    // A successful save only suppresses recovery/navigation guards until
    // the creator makes the next authoring change in this mounted editor.
    if (dirty) finalized.current = false;
  }, [dirty]);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !internalNavigation.current &&
      !finalized.current &&
      (dirty || busy) &&
      (current.pathname !== next.pathname ||
        locationDraft(current) !== locationDraft(next)),
    enableBeforeUnload: () => !finalized.current && (dirty || busy),
    withResolver: true,
  });

  const unresolvedDependencyTypes = useMemo(() => {
    try {
      return new Set(
        unresolvedActionReferences(
          document.sequence,
          document.dependencies,
        ).map((reference) => reference.contentType),
      );
    } catch {
      return new Set<ActionComponentType>();
    }
  }, [document.dependencies, document.sequence]);
  const catalogInput = {
    origin: "all" as const,
    query: dependencyQuery,
    sort: dependencyQuery ? ("relevance" as const) : ("name" as const),
    limit: 12,
  };
  const catalogEnabled = (contentType: ActionComponentType) =>
    contentType === activeDependencyType ||
    unresolvedDependencyTypes.has(contentType);
  const particles = useParticleEffects({
    ...catalogInput,
    enabled: catalogEnabled("particle_effect"),
  });
  const sounds = useSoundEffects({
    ...catalogInput,
    enabled: catalogEnabled("sound_effect"),
  });
  const avatars = useAvatarEffectsPage({
    ...catalogInput,
    enabled: catalogEnabled("avatar_effect"),
  });
  const scenes = useSceneEffectsPage({
    ...catalogInput,
    enabled: catalogEnabled("scene_effect"),
  });
  const initialComponentItem = useActionComponent(
    initialComponentType ?? null,
    initialComponent ?? null,
  );
  const particleRows = useMemo(
    () => componentRows(particles.data),
    [particles.data],
  );
  const soundRows = useMemo(() => componentRows(sounds.data), [sounds.data]);
  const avatarRows = useMemo(() => componentRows(avatars.data), [avatars.data]);
  const sceneRows = useMemo(() => componentRows(scenes.data), [scenes.data]);

  const loadGeneration = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Reopen Local content or initialize an immutable Included source as a Local copy. */
  const hydrateCatalogAction = useCallback(
    async (item: PyGesture | PyReaction, discardCurrentRecovery: boolean) => {
      const generation = ++loadGeneration.current;
      clearSaveFailure();
      try {
        if (item.state !== "ready") {
          throw new WordedError(t("page.load.unavailable"));
        }
        if (!item.source) throw new WordedError(t("page.load.noSource"));
        // Non-portable motion never loads into a draft that could be saved.
        if (isNonPortable(item)) throw new WordedError(nonPortableReason());
        const preview = await loadActionPreview(item.source);
        const next = await actionDocumentFromPreview({
          intent,
          item,
          preview,
          base: createDocument(),
          customizeStarter: item.origin === "builtin",
        });
        const target = actionPreviewTarget(preview, next.name);
        if (target.sourceType !== "resolved_action") {
          throw new WordedError(t("page.load.incompletePreview"));
        }
        const animation =
          next.implementation === "vrma"
            ? await loadCreatorPreviewFile(preview, "animation")
            : null;
        if (!mounted.current || generation !== loadGeneration.current)
          return false;
        finalized.current = false;
        setActiveItemId(item.origin === "owned" ? item.item_id : null);
        resetSaveSession();
        setVrma(animation);
        setPreviewRuntime(creatorActionPreviewRuntime(target.runtime));
        setRootPreviewDependencyDigest(JSON.stringify(next.dependencies));
        if (item.origin === "builtin")
          cleanDigest.current = "__included_copy__";
        replaceLoadedDocument(next, item.origin === "owned");
        setMode(loadedActionEditorMode(intent, next.implementation));
        const removed = removedActionEffects(preview);
        if (removed.length) {
          const t = getI18n().getFixedT(null, "actionEditor");
          // Aliases and refs are stored identifiers, shown as they are.
          const effects = removed.map(({ alias, ref }) => `${alias}: ${ref}`);
          toast.warning(t("loader.effectsRemoved.title"), {
            description:
              intent === "gesture"
                ? t("loader.effectsRemoved.gesture", { effects })
                : t("loader.effectsRemoved.reaction", { effects }),
          });
        }
        if (discardCurrentRecovery && userId) {
          recoveryGeneration.current += 1;
          clearActionRecovery(
            window.localStorage,
            userId,
            intent,
            itemId ?? null,
          );
        }
        return true;
      } catch (cause) {
        if (!mounted.current || generation !== loadGeneration.current)
          return false;
        setFailureMessage(failureLine(cause, t("page.load.failed")));
        throw cause;
      }
    },
    [
      clearSaveFailure,
      createDocument,
      intent,
      itemId,
      loadActionPreview,
      replaceLoadedDocument,
      resetSaveSession,
      setFailureMessage,
      t,
      userId,
    ],
  );
  const loadOwned = useCallback(
    async (item: PyGesture | PyReaction) => {
      if (!(await hydrateCatalogAction(item, true))) return;
      // The Load dialog already reviewed discarding the previous document.
      // Keep the generic dirty-route blocker from canceling this canonical URL
      // synchronization before React commits the newly hydrated clean digest.
      internalNavigation.current = true;
      try {
        await navigate({
          to:
            intent === "gesture"
              ? "/gestures/$gestureId/edit"
              : "/reactions/$reactionId/edit",
          params:
            intent === "gesture"
              ? { gestureId: item.item_id }
              : { reactionId: item.item_id },
          replace: true,
        });
      } finally {
        internalNavigation.current = false;
      }
    },
    [hydrateCatalogAction, intent, navigate],
  );

  useEffect(() => {
    if (!userId || hydrated.current || hydrating.current) return;
    const routeItemId = itemId ?? null;
    let recovery: ReturnType<typeof loadActionRecoveryForEditorRoute> = null;
    try {
      recovery = loadActionRecoveryForEditorRoute(
        window.localStorage,
        userId,
        intent,
        routeItemId,
      );
    } catch (cause) {
      // An unsupported recovery (such as a retired 1.0 clip) is discarded;
      // the saved item opens instead. Worded here so a UI Locale change does
      // not rerun this effect and show the toast again.
      const t = getI18n().getFixedT(null, "actionEditor");
      toast.error(failureLine(cause, t("page.recovery.restoreFailed")));
    }
    if (!recovery) {
      // `/new` is already initialized from createDocument(). Mark it hydrated
      // so no later recovery/query effect can replace that blank document.
      if (routeItemId === null) {
        hydrated.current = true;
        setHydrationReady(true);
      }
      return;
    }
    hydrating.current = true;
    setRootPreviewDependencyDigest(null);
    setPreviewRuntime(null);
    replaceLoadedDocument(recovery.document);
    setMode(loadedActionEditorMode(intent, recovery.document.implementation));
    if (recovery.itemId !== itemId) setActiveItemId(null);
    if (
      recovery.itemId &&
      recovery.sessionId &&
      recovery.sessionRevision !== null
    ) {
      restoreSaveSession({
        itemId: recovery.itemId,
        itemRevision: recovery.itemRevision,
        sessionId: recovery.sessionId,
        sessionRevision: recovery.sessionRevision,
      });
    }
    hydrated.current = true;
    hydrating.current = false;
    setHydrationReady(true);
  }, [intent, itemId, replaceLoadedDocument, restoreSaveSession, userId]);

  // The catalog item whose automatic hydration failed. The loader callback is
  // recreated when its inputs change (such as the UI Locale), so without this
  // guard a failed load would retry. A changed item gets one fresh attempt.
  const failedHydrationItem = useRef<PyGesture | PyReaction | null>(null);
  useEffect(() => {
    if (hydrated.current || hydrating.current) return;
    const item = existing.data;
    if (!item || item.state !== "ready") return;
    if (failedHydrationItem.current === item) return;
    hydrating.current = true;
    void hydrateCatalogAction(item, false)
      .then((loaded) => {
        if (!loaded) return;
        hydrated.current = true;
        setHydrationReady(true);
      })
      .catch(() => {
        failedHydrationItem.current = item;
      })
      .finally(() => {
        hydrating.current = false;
      });
  }, [existing.data, hydrateCatalogAction]);

  /** The Load dialog uses the same copy-safe hydration as the Library route. */
  const loadStarter = useCallback(
    async (item: PyGesture | PyReaction) => {
      if (!isCustomizableStarterAction(item, intent) || !item.source) {
        throw new WordedError(t("page.load.starterOnly"));
      }
      await hydrateCatalogAction(item, true);
    },
    [hydrateCatalogAction, intent, t],
  );

  useEffect(() => {
    // Recovery belongs to exact edit routes. `/new` intentionally stays blank
    // across navigation and refresh instead of reviving a prior action.
    if (
      !userId ||
      finalized.current ||
      recoveryDiscarded.current ||
      itemId === undefined ||
      !hydrationReady
    )
      return;
    if (!dirty) {
      clearActionRecovery(window.localStorage, userId, intent, itemId);
      return;
    }
    const generation = recoveryGeneration.current;
    const timer = window.setTimeout(() => {
      if (
        recoveryDiscarded.current ||
        generation !== recoveryGeneration.current
      )
        return;
      saveActionRecovery(
        window.localStorage,
        {
          userId,
          itemId: identity?.itemId ?? activeItemId,
          itemRevision:
            identity?.itemRevision ??
            (activeItemId === itemId ? existing.data?.revision_sha256 : null) ??
            null,
          sessionId: identity?.sessionId ?? null,
          sessionRevision: identity?.sessionRevision ?? null,
          document,
          rootDigest: actionDocumentDigest(document),
        },
        itemId ?? null,
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    activeItemId,
    document,
    dirty,
    existing.data?.revision_sha256,
    hydrationReady,
    identity,
    intent,
    itemId,
    userId,
  ]);

  useEffect(() => {
    if (document.implementation === "vrma") setMode("vrma");
    else if (mode === "vrma")
      setMode(loadedActionEditorMode(intent, document.implementation));
  }, [intent, document.implementation, mode]);

  /** Capture the live timeline before any preview or catalog Save. */
  const capturePersistenceDocument = async () => {
    const next = await captureActionDocumentForSave(
      () => documentRef.current,
      () => usePoseCreatorStore.getState().clipDraft,
      // New owner content takes its default name in the UI Locale; the name
      // field's placeholder shows the same name.
      () => {
        const t = getI18n().getFixedT(null, "actionEditor");
        return actions.allocateDefaultName(
          t("header.namePlaceholder.reaction"),
        );
      },
    );
    documentRef.current = next;
    setDocument(next);
    historyRef.current.commit(actionAuthoringSnapshot(next));
    return next;
  };

  /** Save once and return the exact typed target used by Save & Equip. */
  const saveAction = async (): Promise<ManageActionTarget> => {
    setValidationAttempted(true);
    clearSaveFailure();
    let currentDocument: ActionDocument;
    try {
      setSaveStage("preparing");
      currentDocument = await capturePersistenceDocument();
    } catch (cause) {
      // Serialization can fail before live document validation runs.
      setSaveStage("idle");
      throw captureSaveFailure(cause);
    }
    try {
      return await saver.saveDocument({
        document: currentDocument,
        itemId: activeItemId,
        vrma,
        onSaved: () => {
          finalized.current = true;
          cleanDigest.current = actionDocumentDigest(currentDocument);
          if (userId)
            clearActionRecovery(
              window.localStorage,
              userId,
              intent,
              itemId ?? null,
            );
        },
      });
    } catch (cause) {
      // A toast already named the missing details.
      if (cause instanceof ActionDocumentIncompleteError) throw cause;
      throw captureSaveFailure(cause);
    }
  };

  const navigateToAction = async (targetItemId: string) => {
    await navigate({
      to:
        intent === "gesture"
          ? "/gestures/$gestureId/edit"
          : "/reactions/$reactionId/edit",
      params:
        intent === "gesture"
          ? { gestureId: targetItemId }
          : { reactionId: targetItemId },
      replace: true,
    });
  };

  const save = async () => {
    try {
      const target = await saveAction();
      await navigateToAction(target.itemId);
    } catch {
      // saveAction owns the visible recoverable error.
    }
  };

  const saveAndEquip = async () => {
    try {
      setManageTarget(await saveAction());
    } catch {
      // saveAction owns the visible recoverable error.
    }
  };

  const commitAuthoring = useCallback((next: ActionDocument) => {
    historyRef.current.commit(
      actionAuthoringSnapshot(normalizeActionDocument(next)),
    );
  }, []);
  const addComponent = useCallback(
    (
      item: PyCatalogViewItem,
      contentType: ActionComponentType,
      options?: { timeSec?: number },
    ) => {
      if (!item.source) return;
      const next = addActionComponentEvent(documentRef.current, {
        name: item.name,
        contentType,
        source: item.source,
        time:
          options?.timeSec ??
          usePoseCreatorStore.getState().clipDraft.currentTimeSec,
      });
      commitAuthoring(canonicalizeActionComponentInsertion(next));
      // Read the appended ID before canonicalization sorts events by time.
      // The caller can select the exact dropped event after timeline hydration.
      const event = Array.isArray(next.sequence.events)
        ? next.sequence.events.at(-1)
        : undefined;
      return event && typeof event.id === "string" ? event.id : undefined;
    },
    [commitAuthoring],
  );
  const removeDependency = useCallback(
    (alias: string) =>
      commitAuthoring(removeActionDependency(documentRef.current, alias)),
    [commitAuthoring],
  );
  const mapDependency = useCallback(
    (
      alias: string,
      item: PyCatalogViewItem,
      contentType: ActionComponentType,
    ) => {
      if (!item.source) return;
      commitAuthoring(
        mapActionDependency(documentRef.current, {
          alias,
          contentType,
          source: item.source,
        }),
      );
    },
    [commitAuthoring],
  );
  const applyImport = useCallback(
    (value: ActionImport) => {
      const current = documentRef.current;
      const next: ActionDocument =
        value.kind === "project"
          ? importedProjectDocument(current, value.project)
          : normalizeActionDocument({
              ...renameActionDocument(
                current,
                current.name.trim() || value.sequence.name.trim(),
                !identity,
              ),
              implementation: "anima_clip",
              sequence: value.sequence as unknown as Record<string, unknown>,
              dependencies: current.dependencies.filter((dependency) =>
                new Set(
                  referencedAliases(
                    value.sequence as unknown as Record<string, unknown>,
                  ),
                ).has(dependency.alias),
              ),
            });
      if (intent === "reaction" && hasHumanoidTracks(next.sequence)) {
        throw new WordedError(t("importDialog.reactionHumanoid"));
      }
      setVrma(null);
      setValidationAttempted(false);
      setMode(loadedActionEditorMode(intent, next.implementation));
      setDocument((documentState) => ({
        ...documentState,
        name: next.name,
        aiDescription: next.aiDescription,
        semanticKey: next.semanticKey,
        implementation: next.implementation,
        suggestedEmotion: next.suggestedEmotion,
        suggestedIntensity: next.suggestedIntensity,
        notes: next.notes,
      }));
      historyRef.current.commit(actionAuthoringSnapshot(next));
      setTimelineSession((value) => value + 1);
    },
    [identity, intent, t],
  );
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const prepareAssistantRun = useCallback(() => {
    const prepared = prepareCreatorForAssistantRun({
      document: documentRef.current,
      mode: modeRef.current,
      history: historyRef.current,
    });
    if (prepared.blocked) return null;
    if (prepared.leftPoseMode) {
      setMode("clip");
      documentRef.current = prepared.document;
    }
    return prepared.document;
  }, []);
  const applyAssistantResult = useCallback(
    (project: unknown, options?: { replace?: boolean }) => {
      const applied = commitAssistantResult({
        document: documentRef.current,
        project,
        identityExists: Boolean(identity),
        history: historyRef.current,
        replace: options?.replace,
      });
      const next = applied.document;
      // Details the item lacked are filled in; they are no authoring change.
      setDocument((documentState) => ({
        ...documentState,
        name: next.name,
        aiDescription: next.aiDescription,
        semanticKey: next.semanticKey,
        suggestedEmotion: next.suggestedEmotion,
        suggestedIntensity: next.suggestedIntensity,
      }));
      documentRef.current = next;
      setTimelineSession((value) => value + 1);
      return applied;
    },
    [identity],
  );
  const startNew = useCallback(async () => {
    recoveryGeneration.current += 1;
    const next = createDocument();
    finalized.current = false;
    setActiveItemId(null);
    resetSaveSession();
    setVrma(null);
    clearSaveFailure();
    setPreviewRuntime(null);
    setRootPreviewDependencyDigest(null);
    replaceLoadedDocument(next, true);
    setMode(capabilities.defaultMode);
    if (userId) {
      clearActionRecoveryForNewDocument(
        window.localStorage,
        userId,
        intent,
        itemId ?? null,
      );
    }
    // New is an explicit, already-reviewed workspace transition. Keep stale
    // dirty state from blocking the route update before React commits reset.
    internalNavigation.current = true;
    try {
      await navigate({
        to: intent === "gesture" ? "/gestures/new" : "/reactions/new",
        search: {},
      });
    } finally {
      internalNavigation.current = false;
    }
  }, [
    capabilities.defaultMode,
    clearSaveFailure,
    createDocument,
    intent,
    itemId,
    navigate,
    replaceLoadedDocument,
    resetSaveSession,
    userId,
  ]);

  // "Open in creator": load an assistant draft's project once, as an import.
  const draftSnapshot = useGenerationConversation(
    initialDraft?.conversationId ?? null,
  );
  // A runtime without the assistant never reads the conversation.
  const assistantWithheld = useContentGenerationWithheld();
  const initialDraftApplied = useRef(false);
  useEffect(() => {
    if (!initialDraft || initialDraftApplied.current || !hydrationReady) return;
    if (!draftSnapshot.data && !draftSnapshot.isError && !assistantWithheld)
      return;
    initialDraftApplied.current = true;
    const project = draftSnapshot.data?.drafts.find(
      (draft) => draft.id === initialDraft.draftId,
    )?.project;
    if (!project) {
      // The draft was discarded, never held a project, or could not be read
      // (also where this runtime has no assistant to read it from).
      setFailureMessage(t("page.load.failed"));
      return;
    }
    try {
      applyImport(parseActionImport(project, intent));
    } catch (cause) {
      setFailureMessage(failureLine(cause, t("page.load.failed")));
    }
  }, [
    applyImport,
    assistantWithheld,
    draftSnapshot.data,
    draftSnapshot.isError,
    hydrationReady,
    initialDraft,
    intent,
    setFailureMessage,
    t,
  ]);

  useEffect(() => {
    if (!initialComponent || initialComponentApplied.current) return;
    if (initialComponentItem.data && initialComponentType) {
      initialComponentApplied.current = true;
      const sourceKey = exactSourceKey(initialComponentItem.data.source);
      const exists = documentRef.current.dependencies.some(
        (dependency) =>
          dependency.content_type === initialComponentType &&
          exactSourceKey(dependency.source) === sourceKey,
      );
      // Non-portable components (such as licensed sounds) are never added.
      if (!exists && !isNonPortable(initialComponentItem.data))
        addComponent(initialComponentItem.data, initialComponentType);
      return;
    }
    if (initialComponentType && initialComponentItem.isPending) return;
    const rows = [
      ...particleRows.map((item) => [item, "particle_effect"] as const),
      ...soundRows.map((item) => [item, "sound_effect"] as const),
      ...avatarRows.map((item) => [item, "avatar_effect"] as const),
      ...sceneRows.map((item) => [item, "scene_effect"] as const),
    ];
    const found = rows.find(([item]) => item.item_id === initialComponent);
    if (!found) return;
    initialComponentApplied.current = true;
    addComponent(found[0], found[1]);
  }, [
    addComponent,
    avatarRows,
    initialComponent,
    initialComponentItem.data,
    initialComponentItem.isPending,
    initialComponentType,
    particleRows,
    sceneRows,
    soundRows,
  ]);

  const dependencySections = useMemo<ActionDependencySection[]>(
    () => [
      {
        label: t("components.particleEffects"),
        contentType: "particle_effect",
        items: particleRows,
        isPending: particles.isPending,
        errorMessage: queryErrorMessage(t, particles.error),
        hasNextPage: Boolean(particles.hasNextPage),
        isFetchingNextPage: particles.isFetchingNextPage,
        fetchNextPage: particles.fetchNextPage,
        retry: particles.refetch,
      },
      {
        label: t("components.soundEffects"),
        contentType: "sound_effect",
        items: soundRows,
        isPending: sounds.isPending,
        errorMessage: queryErrorMessage(t, sounds.error),
        hasNextPage: Boolean(sounds.hasNextPage),
        isFetchingNextPage: sounds.isFetchingNextPage,
        fetchNextPage: sounds.fetchNextPage,
        retry: sounds.refetch,
      },
      {
        label: t("components.avatarEffects"),
        contentType: "avatar_effect",
        items: avatarRows,
        isPending: avatars.isPending,
        errorMessage: queryErrorMessage(t, avatars.error),
        hasNextPage: Boolean(avatars.hasNextPage),
        isFetchingNextPage: avatars.isFetchingNextPage,
        fetchNextPage: avatars.fetchNextPage,
        retry: avatars.refetch,
      },
      {
        label: t("components.sceneEffects"),
        contentType: "scene_effect",
        items: sceneRows,
        isPending: scenes.isPending,
        errorMessage: queryErrorMessage(t, scenes.error),
        hasNextPage: Boolean(scenes.hasNextPage),
        isFetchingNextPage: scenes.isFetchingNextPage,
        fetchNextPage: scenes.fetchNextPage,
        retry: scenes.refetch,
      },
    ],
    [
      avatarRows,
      avatars.fetchNextPage,
      avatars.hasNextPage,
      avatars.isFetchingNextPage,
      avatars.isPending,
      avatars.error,
      avatars.refetch,
      particleRows,
      particles.fetchNextPage,
      particles.hasNextPage,
      particles.isFetchingNextPage,
      particles.isPending,
      particles.error,
      particles.refetch,
      sceneRows,
      scenes.fetchNextPage,
      scenes.hasNextPage,
      scenes.isFetchingNextPage,
      scenes.isPending,
      scenes.error,
      scenes.refetch,
      soundRows,
      sounds.fetchNextPage,
      sounds.hasNextPage,
      sounds.isFetchingNextPage,
      sounds.isPending,
      sounds.error,
      sounds.refetch,
      t,
    ],
  );

  const workspaceValue = {
    document,
    setDocument,
    history,
    mode,
    setMode,
    busy,
    dirty,
    saveStage,
    issues,
    validationAttempted,
    error,
    errorField,
    clearSaveErrorField,
    itemId: activeItemId ?? undefined,
    identityExists: Boolean(identity),
    timelineSession,
    dependencyQuery,
    setDependencyQuery,
    activeDependencyType,
    setActiveDependencyType,
    dependencySections,
    addComponent,
    removeDependency,
    mapDependency,
    loadStarter,
    loadOwned,
    applyImport,
    prepareAssistantRun,
    pendingPoseEdit: pendingActionEditorPoseEdit,
    applyAssistantResult,
    startNew,
    vrma,
    setVrma,
    localPreviewPending: componentPreviews.pending,
    save,
    saveAndEquip,
  };

  return (
    <>
      <ContentPreviewExclusiveCanvasGate ownerId={`action-editor:${intent}`}>
        <ActionEditorPreviewProvider
          runtimeOverlay={previewRuntime}
          sandboxEntries={sandboxEntries}
        >
          <ActionEditorWorkspaceProvider value={workspaceValue}>
            <ActionEditorWorkspace />
          </ActionEditorWorkspaceProvider>
        </ActionEditorPreviewProvider>
      </ContentPreviewExclusiveCanvasGate>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => !open && blocker.reset?.()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {busy ? t("page.leave.busyTitle") : t("page.leave.dirtyTitle")}
            </DialogTitle>
            <DialogDescription>
              {busy
                ? t("page.leave.busyDescription")
                : t("page.leave.dirtyDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => blocker.reset?.()}>
              {t("page.leave.stay")}
            </Button>
            <Button
              onClick={() => {
                if (!busy && userId) {
                  // Fence pending autosave callbacks before removing this route's recovery.
                  recoveryDiscarded.current = true;
                  recoveryGeneration.current += 1;
                  try {
                    clearActionRecovery(
                      window.localStorage,
                      userId,
                      intent,
                      itemId ?? null,
                    );
                  } catch {
                    recoveryDiscarded.current = false;
                    toast.error(t("page.recovery.discardFailed"));
                    return;
                  }
                }
                blocker.proceed?.();
              }}
            >
              {busy ? t("page.leave.leaveKeep") : t("page.leave.discard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ActionManageDialog
        open={Boolean(manageTarget)}
        onOpenChange={(open) => {
          if (open || !manageTarget) return;
          const targetItemId = manageTarget.itemId;
          setManageTarget(null);
          void navigateToAction(targetItemId);
        }}
        target={manageTarget}
      />
    </>
  );
}
