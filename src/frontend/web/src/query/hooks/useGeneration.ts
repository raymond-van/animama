import { useProductApiClient } from "@animama/product-ui";

import { useQuery, type QueryClient } from "@tanstack/react-query";

import {
  getGenerationConversationV1GenerationConversationsConversationIdGet,
  listGenerationConversationsV1GenerationConversationsGet,
} from "@animama/runtime-contracts/sdk";
import type {
  PyGenerationConversation,
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { queryKeys } from "@/query/keys";

/**
 * The content assistant's server state: its conversations, and one
 * conversation with its messages and drafts (the snapshot). The assistant is
 * local-only, so every query waits for the runtime to report it.
 */

/** Whether this runtime offers the content assistant (the local composition). */
export function useContentGenerationAvailable(): boolean {
  return useRuntimeCapabilities().data?.content_generation === true;
}

/**
 * Whether this runtime has said that it does not offer the content
 * assistant. False while the runtime has not answered, so a reader can wait
 * for the answer instead of taking silence for "no".
 */
export function useContentGenerationWithheld(): boolean {
  const { data } = useRuntimeCapabilities();
  return data !== undefined && data.content_generation !== true;
}

/** The owner's assistant conversations, the most recently written to first. */
export function useGenerationConversations() {
  const apiClient = useProductApiClient();
  const ownerId = useRuntimeCacheKey();
  const available = useContentGenerationAvailable();
  return useQuery<PyGenerationConversation[]>({
    queryKey: queryKeys.generation.conversations(ownerId ?? "__anon__"),
    enabled: available && Boolean(ownerId),
    queryFn: async ({ signal }) => {
      const { data } =
        await listGenerationConversationsV1GenerationConversationsGet({
          client: apiClient,
          signal,
          responseValidator: undefined,
          throwOnError: true,
        });
      return data.conversations;
    },
  });
}

/**
 * One conversation with its messages and drafts.
 *
 * A run's stream and the page's own actions write drafts into this cache
 * (`writeGenerationDraft`), so it is never refetched behind their back: a
 * refetch that started before a `draft.updated` event could land after it and
 * put the older draft back. It is read fresh on every mount, which also lets
 * the server settle a draft a dead run left mid-step, and whenever a run ends
 * or an action invalidates it.
 */
export function useGenerationConversation(conversationId: string | null) {
  const apiClient = useProductApiClient();
  const ownerId = useRuntimeCacheKey();
  const available = useContentGenerationAvailable();
  return useQuery<PyGenerationConversationSnapshot>({
    queryKey: queryKeys.generation.conversation(
      ownerId ?? "__anon__",
      conversationId ?? "__none__",
    ),
    enabled: available && Boolean(ownerId && conversationId),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const { data } =
        await getGenerationConversationV1GenerationConversationsConversationIdGet(
          {
            client: apiClient,
            path: { conversation_id: conversationId! },
            signal,
            responseValidator: undefined,
            throwOnError: true,
          },
        );
      return data;
    },
  });
}

/** Whether `incoming` describes an earlier state of the draft than `current`. */
function isOlderDraft(
  incoming: PyGenerationDraft,
  current: PyGenerationDraft,
): boolean {
  if (incoming.version !== current.version)
    return incoming.version < current.version;
  const [incomingAt, currentAt] = [
    Date.parse(incoming.updated_at),
    Date.parse(current.updated_at),
  ];
  // One version passes through several statuses; the later write is current.
  return (
    Number.isFinite(incomingAt) &&
    Number.isFinite(currentAt) &&
    incomingAt < currentAt
  );
}

/**
 * Put a draft the server returned (a stream event, a check report's answer, a
 * restore) into its conversation's cached snapshot. A draft the cache already
 * holds in a later state is kept, so answers that arrive out of order cannot
 * move a draft backwards. Returns `false`, writing nothing, while the
 * snapshot is not cached: the caller then reads the conversation instead.
 */
export function writeGenerationDraft(
  queryClient: QueryClient,
  ownerKey: string,
  draft: PyGenerationDraft,
): boolean {
  const key = queryKeys.generation.conversation(
    ownerKey,
    draft.conversation_id,
  );
  if (!queryClient.getQueryData(key)) return false;
  queryClient.setQueryData<PyGenerationConversationSnapshot>(
    key,
    (snapshot) => {
      if (!snapshot) return snapshot;
      const index = snapshot.drafts.findIndex(({ id }) => id === draft.id);
      if (index < 0)
        return {
          ...snapshot,
          drafts: [...snapshot.drafts, draft].sort(
            (left, right) => left.position - right.position,
          ),
        };
      if (isOlderDraft(draft, snapshot.drafts[index]!)) return snapshot;
      const drafts = snapshot.drafts.slice();
      drafts[index] = draft;
      return { ...snapshot, drafts };
    },
  );
  return true;
}

/** Take a discarded draft out of its conversation's cached snapshot. */
export function removeGenerationDraft(
  queryClient: QueryClient,
  ownerKey: string,
  conversationId: string,
  draftId: string,
): void {
  queryClient.setQueryData<PyGenerationConversationSnapshot>(
    queryKeys.generation.conversation(ownerKey, conversationId),
    (snapshot) =>
      snapshot && {
        ...snapshot,
        drafts: snapshot.drafts.filter(({ id }) => id !== draftId),
      },
  );
}

/**
 * Read a conversation again, and the list that orders conversations by their
 * last write. Called when a run ends: its messages are stored by the server.
 */
export async function refreshGenerationConversation(
  queryClient: QueryClient,
  ownerKey: string,
  conversationId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.generation.conversation(ownerKey, conversationId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.generation.conversations(ownerKey),
    }),
  ]);
}
