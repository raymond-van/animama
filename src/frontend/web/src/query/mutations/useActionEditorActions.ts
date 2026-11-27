import { contentSlug } from "@/lib/content/nameIdentifiers";
import { useProductApiClient } from "@animama/product-ui";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formattersForLanguage } from "@animama/product-ui/i18n";
import { getI18n } from "react-i18next";

import {
  type Client,
  previewGesture,
  previewReaction,
} from "@animama/runtime-contracts/sdk";
import type {
  PyActionPreview,
  PyContentFile,
  PyExactContentSource,
  PyGesture,
  PyReaction,
} from "@/lib/content/catalogTypes";
import {
  MAX_ANIMA_POSE_CLIP_BYTES,
  serializeAnimaPoseClipFile,
} from "@/lib/avatar/poses/animaPoseClip";
import { catalogViewItem } from "@/lib/content/catalogTypes";
import { typedActionPreview } from "@/lib/content/typedPreviewAdapters";
import {
  getTypedActionCatalogItem,
  listCatalogItems,
  saveCatalogItem,
} from "@/lib/content/catalogApi";
import { contentSaveFieldError } from "@/lib/content/contentSaveErrors";
import { WordedError } from "@/lib/errors/apiError";
import { createUniqueContentName } from "@/lib/content/uniqueContentName";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { registerPrivateStateReset } from "@/app/runtime/private-module-state";
import { queryKeys } from "@/query/keys";
import type {
  ActionDocument,
  ActionIntent,
} from "@/ui/action-editor/actionDocument";

/** The editor's in-memory session is gone, for example after a sign-out. */
function sessionExpiredError(): WordedError {
  const t = getI18n().getFixedT(null, "actionEditor");
  return new WordedError(t("page.save.sessionExpired"));
}

type EditSessionIdentity = {
  itemId: string;
  itemRevision: string | null;
  sessionId: string;
  sessionRevision: number;
};

type PendingAction = {
  document: ActionDocument;
  file?: File;
  itemId?: string;
  expectedRevision?: string | null;
  savedItemId?: string;
  savedRevision?: string | null;
};

const pendingActions = new Map<string, PendingAction>();
// Staged VRMA files and pending saves belong to the session that made them.
registerPrivateStateReset(() => pendingActions.clear());

function dependencyReference(source: PyExactContentSource): string {
  if (source.type === "builtin") return source.content_id;
  return source.logical_key || source.catalog_item_id;
}

/** Build the readable sidecar, omitting optional placement until chosen. */
export function actionDescriptorFor(
  document: ActionDocument,
  logicalKey: string,
) {
  const companionName =
    document.implementation === "vrma"
      ? `${contentSlug(document.name)}.vrma`
      : `${contentSlug(document.name)}.json`;
  return {
    companionName,
    descriptor: {
      schema_version: 1,
      content_type: document.intent,
      id: logicalKey,
      name: document.name.trim(),
      // The AI selection description is the Action's one text; a separate
      // `description` would only keep a stale copy of an earlier save.
      ai_description: document.aiDescription.trim() || undefined,
      notes: document.notes.trim() || undefined,
      ...(document.intent === "gesture"
        ? { semantic_key: document.semanticKey.trim() }
        : document.suggestedEmotion.trim()
          ? {
              placement_hint: {
                emotion: document.suggestedEmotion.trim(),
                intensity: document.suggestedIntensity,
              },
            }
          : {}),
      implementation: {
        kind: document.implementation,
        file_role:
          document.implementation === "vrma" ? "animation" : "sequence",
      },
      files: [
        {
          path: companionName,
          role: document.implementation === "vrma" ? "animation" : "sequence",
        },
      ],
      dependencies: document.dependencies.map((dependency) => ({
        ref: dependencyReference(dependency.source),
        alias: dependency.alias,
        content_type: dependency.content_type,
        source: dependency.source,
        config: dependency.config ?? {},
      })),
    },
  };
}

/** Read the resolved preview of the Gesture or Reaction behind a catalog source. */
async function previewActionSource(
  apiClient: Client,
  intent: ActionIntent,
  source: PyExactContentSource,
): Promise<PyActionPreview> {
  let itemId: string | null = null;
  if (source.type === "catalog") itemId = source.catalog_item_id;
  else {
    const items = await listCatalogItems(apiClient, intent);
    itemId =
      items.find((item) => item.logical_key === source.content_id)?.item_id ??
      null;
  }
  if (!itemId) {
    const t = getI18n().getFixedT(null, "errors");
    throw new WordedError(t("creation.source_unavailable"));
  }
  const options = {
    client: apiClient,
    path: { item_id: itemId },
    responseValidator: undefined,
    throwOnError: true as const,
  };
  return typedActionPreview(
    intent === "gesture"
      ? (await previewGesture(options)).data
      : (await previewReaction(options)).data,
  );
}

/** Direct editable-catalog operations used by the Gesture and Reaction studio. */
export function useActionEditorActions(intent: ActionIntent) {
  const apiClient = useProductApiClient();

  const queryClient = useQueryClient();
  const userId = useRuntimeCacheKey() ?? "__anon__";
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey:
          intent === "gesture"
            ? queryKeys.gestures.all(userId)
            : queryKeys.reactions.all(userId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.content.catalog(userId),
      }),
    ]);
  };

  async function persist(
    identity: EditSessionIdentity,
    document: ActionDocument,
  ) {
    const pending = pendingActions.get(identity.sessionId) ?? { document };
    pending.document = document;
    const candidateId = pending.itemId ?? identity.itemId;
    const existingId = candidateId.startsWith("new:") ? undefined : candidateId;
    const existing = existingId
      ? await getTypedActionCatalogItem(apiClient, intent, existingId)
      : null;
    const logicalKey =
      existing?.logical_key ?? `local:${intent}:${contentSlug(document.name)}`;
    const { companionName, descriptor } = actionDescriptorFor(
      document,
      logicalKey,
    );
    const sequenceText =
      document.implementation === "vrma"
        ? null
        : serializeAnimaPoseClipFile(document.sequence);
    const t = getI18n().getFixedT(null, "actionEditor");
    if (
      sequenceText &&
      new Blob([sequenceText]).size > MAX_ANIMA_POSE_CLIP_BYTES
    ) {
      throw contentSaveFieldError(
        t("page.save.clipTooLarge", {
          size: formattersForLanguage(getI18n().resolvedLanguage).fileSize(
            MAX_ANIMA_POSE_CLIP_BYTES,
          ),
        }),
        "files",
      );
    }
    const file =
      sequenceText === null
        ? pending.file
        : new File([sequenceText], companionName, { type: "application/json" });
    if (!file) throw contentSaveFieldError(t("page.save.chooseVrma"), "files");
    const saved = await saveCatalogItem(apiClient, {
      kind: intent,
      entryName: document.name,
      files: [file],
      companionPaths: [companionName],
      descriptor,
      catalogItemId: existing?.item_id,
      expectedRevision:
        existing?.revision_sha256 ?? pending.expectedRevision ?? undefined,
    });
    pending.itemId = saved.item_id;
    pending.expectedRevision = saved.revision_sha256;
    pending.savedItemId = saved.item_id;
    pending.savedRevision = saved.revision_sha256;
    pendingActions.set(identity.sessionId, pending);
    await invalidate();
    return saved;
  }

  const beginSession = useMutation<
    EditSessionIdentity,
    Error,
    { document: ActionDocument; operationId: string; itemId?: string }
  >({
    mutationFn: async ({ document, operationId, itemId }) => {
      const existing = itemId
        ? await getTypedActionCatalogItem(apiClient, intent, itemId)
        : null;
      const identity = {
        itemId: itemId ?? `new:${operationId}`,
        itemRevision: existing?.revision_sha256 ?? null,
        sessionId: operationId,
        sessionRevision: 1,
      };
      pendingActions.set(operationId, {
        document,
        itemId,
        expectedRevision: existing?.revision_sha256,
      });
      return identity;
    },
  });

  const updateSession = useMutation<
    EditSessionIdentity,
    Error,
    { identity: EditSessionIdentity; document: ActionDocument }
  >({
    mutationFn: async ({ identity, document }) => {
      const pending = pendingActions.get(identity.sessionId) ?? {
        document,
        itemId: identity.itemId,
        expectedRevision: identity.itemRevision,
      };
      pending.document = document;
      pending.savedItemId = undefined;
      pending.savedRevision = undefined;
      pendingActions.set(identity.sessionId, pending);
      return { ...identity, sessionRevision: identity.sessionRevision + 1 };
    },
  });

  // Count preview loads in component state instead of a mutation observer. The
  // creator loads its first preview from a mount effect; development
  // StrictMode replays that effect, and the replay detaches a mutation observer
  // from the running mutation, so it would keep reporting the finished load as
  // pending and leave the creator busy.
  const [pendingPreviews, setPendingPreviews] = useState(0);
  const loadActionPreview = useCallback(
    async (source: PyExactContentSource): Promise<PyActionPreview> => {
      setPendingPreviews((count) => count + 1);
      try {
        return await previewActionSource(apiClient, intent, source);
      } finally {
        setPendingPreviews((count) => count - 1);
      }
    },
    [apiClient, intent],
  );

  const stageFile = useMutation<
    PyContentFile,
    Error,
    {
      sessionId: string;
      file: File;
      role: "sequence" | "animation";
      sha256: string;
    }
  >({
    mutationFn: async ({ sessionId, file, role, sha256 }) => {
      const pending = pendingActions.get(sessionId);
      if (!pending) throw sessionExpiredError();
      pending.file = file;
      pending.savedItemId = undefined;
      pending.savedRevision = undefined;
      pendingActions.set(sessionId, pending);
      return {
        file_ref: `pending:${sessionId}`,
        relative_path: file.name,
        role,
        ordinal: 1,
        filename: file.name,
        media_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        sha256,
      };
    },
  });

  const save = useMutation<
    PyGesture | PyReaction,
    Error,
    { identity: EditSessionIdentity }
  >({
    mutationFn: async ({ identity }) => {
      const pending = pendingActions.get(identity.sessionId);
      if (!pending) throw sessionExpiredError();
      const saved =
        pending.savedItemId && pending.savedRevision
          ? await getTypedActionCatalogItem(
              apiClient,
              intent,
              pending.savedItemId,
            )
          : await persist(identity, pending.document);
      return catalogViewItem(saved) as PyGesture | PyReaction;
    },
    onSuccess: invalidate,
  });

  return {
    /** Read the full current catalog so default names also avoid unloaded items. */
    allocateDefaultName: async (baseName: string) => {
      const items = await listCatalogItems(apiClient, intent);
      return createUniqueContentName(
        baseName,
        items.map((item) => item.name),
      );
    },
    beginSession,
    updateSession,
    /** Load the resolved preview behind a Gesture or Reaction catalog source. */
    actionPreview: { isPending: pendingPreviews > 0, load: loadActionPreview },
    stageFile,
    save,
  };
}

export type { EditSessionIdentity };
