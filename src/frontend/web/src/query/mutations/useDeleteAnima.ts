import { useProductApiClient } from "@animama/product-ui";
import { useMutation } from "@tanstack/react-query";
import { deleteAnimaV1AnimasAnimaIdDelete } from "@animama/runtime-contracts/sdk";

import { assertDeleted } from "@/query/chatAndAnimaDeletion";

export type DeleteAnimaArgs = { animaId: string };

/**
 * Delete an Anima with its chats, messages, Anima memory files, pending
 * episodes and the images only its chats use. The server first stops its
 * chats' replies and refuses with a retryable 409 `chat_turn_stopping` when it
 * cannot within 10 s. The caller settles caches once the page has left the
 * Anima (`settleDeletedAnima`).
 */
export function useDeleteAnima() {
  const apiClient = useProductApiClient();
  return useMutation<void, Error, DeleteAnimaArgs>({
    mutationFn: async ({ animaId }) => {
      assertDeleted(
        await deleteAnimaV1AnimasAnimaIdDelete({
          client: apiClient,
          path: { anima_id: animaId },
          responseValidator: undefined,
          throwOnError: false,
        }),
      );
    },
  });
}
