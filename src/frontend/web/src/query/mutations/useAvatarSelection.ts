import { useProductApiClient } from "@animama/product-ui";
import type {
  PyAvatarContent,
  PyLoadoutCommitResult,
  PySingleSelectionIntent,
} from "@animama/runtime-contracts/api-types";
import {
  commitAvatar,
  planAvatar as planAvatarSelection,
  type Client,
} from "@animama/runtime-contracts/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { invalidateAnimaLoadoutAndRuntime } from "@/query/animaLoadoutInvalidation";
import { queryKeys } from "@/query/keys";

export type AvatarSelectionInput = {
  avatar: Pick<PyAvatarContent, "item_id" | "logical_key" | "source">;
  /** The Loadout revision the owner chose against; a newer one refuses it. */
  expectedRevision: number;
};

/**
 * Select one Avatar for an Anima: plan the change, then commit exactly that
 * plan. The Anima keeps its identity, memories, chats and every other Loadout
 * selection; only the `avatar` slot changes.
 */
export async function selectAvatar(
  apiClient: Client,
  animaId: string,
  input: AvatarSelectionInput,
): Promise<PyLoadoutCommitResult> {
  const intent: PySingleSelectionIntent = {
    operation: "set",
    source: {
      type: "catalog",
      catalog_item_id: input.avatar.item_id,
      logical_key: input.avatar.logical_key ?? null,
      source: input.avatar.source,
    },
    config: {},
  };
  const options = {
    path: { anima_id: animaId },
    responseValidator: undefined,
    throwOnError: true as const,
  };
  const { data: plan } = await planAvatarSelection({
    client: apiClient,
    ...options,
    body: { expected_revision: input.expectedRevision, intent },
  });
  return (
    await commitAvatar({
      client: apiClient,
      ...options,
      body: {
        expected_revision: input.expectedRevision,
        intent,
        plan_digest: plan.plan_digest,
        idempotency_key: crypto.randomUUID(),
      },
    })
  ).data;
}

/**
 * Change an Anima's Avatar from its settings. Management views read the
 * invalidated Loadout and runtime; a mounted chat remounts separately.
 */
export function useAvatarSelection(animaId: string | null) {
  const apiClient = useProductApiClient();
  const owner = useRuntimeCacheKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AvatarSelectionInput) => {
      if (!animaId || !owner)
        throw new Error("Choose an Anima before changing its Avatar.");
      return selectAvatar(apiClient, animaId, input);
    },
    onSettled: async () => {
      // A refused change (a stale revision) also refreshes, so the picker
      // shows the Loadout the owner would change next.
      if (!owner || !animaId) return;
      await Promise.all([
        invalidateAnimaLoadoutAndRuntime(queryClient, owner, animaId),
        // Profile fallbacks and lists name the Anima's Avatar.
        queryClient.invalidateQueries({
          queryKey: queryKeys.animas.all(owner),
        }),
      ]);
    },
    retry: false,
  });
}
