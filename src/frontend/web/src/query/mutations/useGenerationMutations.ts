import { useProductApiClient } from "@animama/product-ui";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  createGenerationConversationV1GenerationConversationsPost,
  deleteGenerationConversationV1GenerationConversationsConversationIdDelete,
  deleteGenerationDraftV1GenerationDraftsDraftIdDelete,
  markGenerationDraftSavedV1GenerationDraftsDraftIdMarkSavedPost,
  restoreGenerationDraftV1GenerationDraftsDraftIdRestorePost,
  setGenerationStylePresetV1GenerationConversationsConversationIdStylePresetPut,
} from "@animama/runtime-contracts/sdk";
import type {
  PyGenerationConversation,
  PyGenerationConversationCreate,
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  NO_GENERATION_USAGE,
  removeGenerationDraft,
  writeGenerationDraft,
} from "@/query/hooks/useGeneration";
import { queryKeys } from "@/query/keys";
import {
  forgetGenerationRun,
  forgetGenerationRunDraft,
} from "@/stores/generation-store";

/**
 * The person's own actions on assistant conversations and drafts. Each
 * updates the cached snapshot from the server's answer; failures reach the
 * caller with the backend's code (`describeGenerationFailure` words them).
 */

/** Start an empty conversation; on the Generate page unless `scope` says otherwise. */
export function useCreateGenerationConversation() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  return useMutation<
    PyGenerationConversation,
    unknown,
    PyGenerationConversationCreate["scope"] | void
  >({
    mutationFn: async (scope) => {
      const { data } =
        await createGenerationConversationV1GenerationConversationsPost({
          client: apiClient,
          body: { scope: scope ?? { kind: "page" } },
          responseValidator: undefined,
          throwOnError: true,
        });
      return data;
    },
    onSuccess: (conversation) => {
      // A new conversation is empty, so its snapshot is known without a read.
      queryClient.setQueryData<PyGenerationConversationSnapshot>(
        queryKeys.generation.conversation(ownerKey, conversation.id),
        { conversation, messages: [], drafts: [], usage: NO_GENERATION_USAGE },
      );
      queryClient.setQueryData<PyGenerationConversation[]>(
        queryKeys.generation.conversations(ownerKey),
        (list) =>
          list && [
            conversation,
            ...list.filter(({ id }) => id !== conversation.id),
          ],
      );
    },
  });
}

/**
 * Delete a conversation with its messages and drafts. The server refuses
 * while a run works on it (`generation_run_in_progress`): stop the run first.
 */
export function useDeleteGenerationConversation() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  return useMutation<void, unknown, string>({
    mutationFn: async (conversationId) => {
      await deleteGenerationConversationV1GenerationConversationsConversationIdDelete(
        {
          client: apiClient,
          path: { conversation_id: conversationId },
          responseValidator: undefined,
          throwOnError: true,
        },
      );
    },
    onSuccess: (_result, conversationId) => {
      queryClient.removeQueries({
        queryKey: queryKeys.generation.conversation(ownerKey, conversationId),
      });
      queryClient.setQueryData<PyGenerationConversation[]>(
        queryKeys.generation.conversations(ownerKey),
        (list) => list?.filter(({ id }) => id !== conversationId),
      );
      forgetGenerationRun(conversationId);
      // The discard deletes the reference images only this conversation
      // used, as a chat delete does its own: the person's files are read
      // again wherever they are shown.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.userFiles.all(ownerKey),
      });
    },
  });
}

/**
 * Store a conversation's style preset by id, or clear it with `null` (R8.5).
 * Only the id is sent: the sentence a model reads is the backend's own. The
 * server refuses an id it does not list (`generation_style_preset_unknown`).
 * The answer is the conversation, which replaces the cached one in its
 * snapshot and in the list, so the choice survives the next read of either.
 */
export function useSetGenerationStylePreset() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  return useMutation<
    PyGenerationConversation,
    unknown,
    { conversationId: string; stylePreset: string | null }
  >({
    mutationFn: async ({ conversationId, stylePreset }) => {
      const { data } =
        await setGenerationStylePresetV1GenerationConversationsConversationIdStylePresetPut(
          {
            client: apiClient,
            path: { conversation_id: conversationId },
            body: { style_preset: stylePreset },
            responseValidator: undefined,
            throwOnError: true,
          },
        );
      return data;
    },
    onSuccess: (conversation) => {
      queryClient.setQueryData<PyGenerationConversationSnapshot>(
        queryKeys.generation.conversation(ownerKey, conversation.id),
        (snapshot) => snapshot && { ...snapshot, conversation },
      );
      queryClient.setQueryData<PyGenerationConversation[]>(
        queryKeys.generation.conversations(ownerKey),
        (list) =>
          list?.map((listed) =>
            listed.id === conversation.id ? conversation : listed,
          ),
      );
    },
  });
}

/**
 * Put back a draft's project from before the person's last revising message.
 * The answer is a new version left `checking`, which the page then checks.
 * Refused while a run works on the conversation, and with
 * `generation_nothing_to_restore` when there is no earlier version.
 */
export function useRestoreGenerationDraft() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  return useMutation<PyGenerationDraft, unknown, string>({
    mutationFn: async (draftId) => {
      const { data } =
        await restoreGenerationDraftV1GenerationDraftsDraftIdRestorePost({
          client: apiClient,
          path: { draft_id: draftId },
          responseValidator: undefined,
          throwOnError: true,
        });
      return data;
    },
    onSuccess: (draft) => {
      writeGenerationDraft(queryClient, ownerKey, draft);
    },
  });
}

/**
 * Discard a draft. A run that was writing or revising it ends; a batch ends
 * only that item and goes on with the others. What the run in flight holds
 * about the draft is forgotten with it, so nothing the run still says of it
 * brings it back.
 */
export function useDiscardGenerationDraft() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  return useMutation<
    void,
    unknown,
    Pick<PyGenerationDraft, "id" | "conversation_id">
  >({
    mutationFn: async ({ id }) => {
      await deleteGenerationDraftV1GenerationDraftsDraftIdDelete({
        client: apiClient,
        path: { draft_id: id },
        responseValidator: undefined,
        throwOnError: true,
      });
    },
    onSuccess: (_result, draft) => {
      // Before the draft leaves the list, so no late event can put it back.
      forgetGenerationRunDraft(draft.conversation_id, draft.id);
      removeGenerationDraft(
        queryClient,
        ownerKey,
        draft.conversation_id,
        draft.id,
      );
    },
  });
}

/** Record the Library item a draft was saved as; saving itself is the creator's save. */
export function useMarkGenerationDraftSaved() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  return useMutation<
    PyGenerationDraft,
    unknown,
    { draftId: string; itemId: string }
  >({
    mutationFn: async ({ draftId, itemId }) => {
      const { data } =
        await markGenerationDraftSavedV1GenerationDraftsDraftIdMarkSavedPost({
          client: apiClient,
          path: { draft_id: draftId },
          body: { item_id: itemId },
          responseValidator: undefined,
          throwOnError: true,
        });
      return data;
    },
    onSuccess: (draft) => {
      writeGenerationDraft(queryClient, ownerKey, draft);
    },
  });
}
