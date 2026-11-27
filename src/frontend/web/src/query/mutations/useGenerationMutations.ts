import { useProductApiClient } from "@animama/product-ui";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  createGenerationConversationV1GenerationConversationsPost,
  deleteGenerationConversationV1GenerationConversationsConversationIdDelete,
  deleteGenerationDraftV1GenerationDraftsDraftIdDelete,
  markGenerationDraftSavedV1GenerationDraftsDraftIdMarkSavedPost,
  restoreGenerationDraftV1GenerationDraftsDraftIdRestorePost,
} from "@animama/runtime-contracts/sdk";
import type {
  PyGenerationConversation,
  PyGenerationConversationCreate,
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  removeGenerationDraft,
  writeGenerationDraft,
} from "@/query/hooks/useGeneration";
import { queryKeys } from "@/query/keys";
import { forgetGenerationRun } from "@/stores/generation-store";

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
        { conversation, messages: [], drafts: [] },
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

/** Discard a draft. A run that was working on it ends. */
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
    onSuccess: (_result, draft) =>
      removeGenerationDraft(
        queryClient,
        ownerKey,
        draft.conversation_id,
        draft.id,
      ),
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
