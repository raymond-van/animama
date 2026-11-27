import { useProductApiClient } from "@animama/product-ui";
import { useMutation } from "@tanstack/react-query";
import { deleteChatV1ChatsChatIdDelete } from "@animama/runtime-contracts/sdk";

import { assertDeleted } from "@/query/chatAndAnimaDeletion";

export type DeleteChatArgs = { chatId: string };

/**
 * Delete a chat with its messages, chat-only images and pending episodes. The
 * server first stops the chat's reply, if one is running, and refuses with a
 * retryable 409 `chat_turn_stopping` when it cannot within 10 s. The caller
 * settles caches once the page has left the chat (`settleDeletedChat`).
 */
export function useDeleteChat() {
  const apiClient = useProductApiClient();
  return useMutation<void, Error, DeleteChatArgs>({
    mutationFn: async ({ chatId }) => {
      assertDeleted(
        await deleteChatV1ChatsChatIdDelete({
          client: apiClient,
          path: { chat_id: chatId },
          responseValidator: undefined,
          throwOnError: false,
        }),
      );
    },
  });
}
