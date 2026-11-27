import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PyGenerationConversation } from "@animama/runtime-contracts/api-types";

import { useGenerationConversations } from "@/query/hooks/useGeneration";
import {
  useCreateGenerationConversation,
  useDeleteGenerationConversation,
} from "@/query/mutations/useGenerationMutations";

export type GenerationConversationChoice = {
  /** The Generate page's own conversations, the most recently written to first. */
  conversations: PyGenerationConversation[];
  /** The conversation on screen; `null` until one is opened or started. */
  conversationId: string | null;
  /** The conversations could not be read, or a new one could not be started. */
  isError: boolean;
  /** Read the conversations again, or try starting one again. */
  retry: () => void;
  open: (conversationId: string) => void;
  /** Start an empty conversation and open it; rejects when it cannot be started. */
  startNew: () => Promise<void>;
  isStarting: boolean;
  /**
   * Delete a conversation with its messages and drafts. After the one on
   * screen is deleted the most recent other one opens, or a new one starts.
   * Rejects with the backend's refusal.
   */
  discard: (conversationId: string) => Promise<void>;
  isDiscarding: boolean;
};

/** The id of the conversation on screen, as state its owner holds. */
export type OpenGenerationConversation = [
  string | null,
  Dispatch<SetStateAction<string | null>>,
];

/**
 * Which assistant conversation the Generate page shows (R6.4). The page opens
 * on the conversation written to most recently, so a reload returns to it,
 * and starts the first one itself. Conversations started in a creator are
 * that creator's, and are not listed here.
 *
 * The page holds the open conversation's id (`opened`), so the choice outlives
 * this hook: Model setup takes the workspace away, and the page comes back to
 * the conversation the person had open.
 */
export function useGenerationConversationChoice(
  opened: OpenGenerationConversation,
): GenerationConversationChoice {
  const list = useGenerationConversations();
  const create = useCreateGenerationConversation();
  const remove = useDeleteGenerationConversation();
  const [conversationId, setConversationId] = opened;
  const [startFailed, setStartFailed] = useState(false);
  const starting = useRef(false);
  const conversations = useMemo(
    () => (list.data ?? []).filter(({ scope }) => scope.kind === "page"),
    [list.data],
  );

  const { mutateAsync: createConversation } = create;
  const startNew = useCallback(async () => {
    // One at a time: development replays the effect that starts the first.
    if (starting.current) return;
    starting.current = true;
    setStartFailed(false);
    try {
      setConversationId((await createConversation()).id);
    } finally {
      starting.current = false;
    }
  }, [createConversation, setConversationId]);

  const latestId = conversations[0]?.id ?? null;
  useEffect(() => {
    if (conversationId || !list.isSuccess || startFailed) return;
    if (latestId) setConversationId(latestId);
    else void startNew().catch(() => setStartFailed(true));
  }, [
    conversationId,
    latestId,
    list.isSuccess,
    setConversationId,
    startFailed,
    startNew,
  ]);

  const { mutateAsync: deleteConversation } = remove;
  const discard = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      // Straight to the most recent one left, so the page's workspace stays
      // mounted; with none left, the effect above starts a new one.
      const next = conversations.find((other) => other.id !== id)?.id ?? null;
      setConversationId((current) => (current === id ? next : current));
    },
    [conversations, deleteConversation, setConversationId],
  );

  const { isError: listFailed, refetch } = list;
  const retry = useCallback(() => {
    if (listFailed) void refetch();
    setStartFailed(false);
  }, [listFailed, refetch]);

  return {
    conversations,
    conversationId,
    isError: listFailed || startFailed,
    retry,
    open: setConversationId,
    startNew,
    isStarting: create.isPending,
    discard,
    isDiscarding: remove.isPending,
  };
}
