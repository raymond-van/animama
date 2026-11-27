import { useProductApiClient } from "@animama/product-ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  patchAnimaV1AnimasAnimaIdPatch,
  updateChatV1ChatsChatIdPatch,
} from "@animama/runtime-contracts/sdk";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import type {
  PyAnimaListItem,
  PyAnimaResponse,
  PyChatResponse,
} from "@/lib/content/catalogTypes";
import { queryKeys } from "@/query/keys";

export type SetSidebarPinArgs = { id: string; pinned: boolean };

/**
 * Pin or unpin a chat in the sidebar (a "sidebar pin", stored as the chat's
 * `pinned_at`). The list order from the server is unchanged; the sidebar
 * sorts pinned chats first.
 */
export function useSetChatPin() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const userId = useRuntimeCacheKey();
  const userKey = userId ?? "__anon__";

  return useMutation<PyChatResponse, Error, SetSidebarPinArgs>({
    mutationFn: async ({ id, pinned }) => {
      const { data } = await updateChatV1ChatsChatIdPatch({
        client: apiClient,
        path: { chat_id: id },
        body: { pinned },
        // Generated datetime validation rejects the server's naive timestamps.
        responseValidator: undefined,
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (updated) => {
      if (!userId) return;
      // Reorder at once with the server's pin time; the refetch confirms it.
      queryClient.setQueriesData<PyChatResponse[]>(
        { queryKey: [...queryKeys.chats.all(userKey), "list"] },
        (rows) =>
          rows?.map((chat) =>
            chat.id === updated.id
              ? { ...chat, pinned_at: updated.pinned_at ?? null }
              : chat,
          ),
      );
    },
    onSettled: () => {
      if (!userId) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chats.all(userKey),
      });
    },
  });
}

/**
 * Pin or unpin an Anima in the sidebar and rail. A pin is runtime state, so it
 * needs no aggregate revision and does not advance it.
 */
export function useSetAnimaPin() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const userId = useRuntimeCacheKey();
  const userKey = userId ?? "__anon__";

  return useMutation<PyAnimaResponse, Error, SetSidebarPinArgs>({
    mutationFn: async ({ id, pinned }) => {
      const { data } = await patchAnimaV1AnimasAnimaIdPatch({
        client: apiClient,
        path: { anima_id: id },
        body: { pinned },
        responseValidator: undefined,
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (updated) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.animas.detail(userKey, updated.id),
        updated,
      );
      queryClient.setQueryData<PyAnimaListItem[]>(
        queryKeys.animas.list(userKey),
        (rows) =>
          rows?.map((anima) =>
            anima.id === updated.id
              ? { ...anima, pinned_at: updated.pinned_at ?? null }
              : anima,
          ),
      );
    },
    onSettled: () => {
      if (!userId) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.animas.all(userKey),
      });
    },
  });
}
