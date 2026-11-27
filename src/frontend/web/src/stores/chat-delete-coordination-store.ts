import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * Coordination between this window's chat and a chat or Anima delete (issue
 * #950). The chat panel registers the reply it is streaming so a delete can
 * stop it first, as Stop does; the server then waits for that turn before
 * deleting. While a delete runs, the chat panel holds new sends to what is
 * being deleted, since a turn admitted then could race the delete. The modal
 * confirm already blocks typing; the hold also covers Voice Mode and Quick
 * Chat, which send without the composer.
 */

/** A reply streaming in this window. A new chat has no ID until it is saved. */
type StreamingReply = {
  animaId: string;
  chatId: string | null;
  stop: () => void;
};

/** What a running delete removes: one chat, or an Anima with all its chats. */
export type ChatDeleteTarget = { chatId: string } | { animaId: string };

type ChatDeleteCoordinationState = {
  replies: StreamingReply[];
  holds: ChatDeleteTarget[];
};

export const useChatDeleteCoordinationStore =
  create<ChatDeleteCoordinationState>(() => ({ replies: [], holds: [] }));

function covers(
  target: ChatDeleteTarget,
  chat: { animaId: string; chatId: string | null },
): boolean {
  return "chatId" in target
    ? chat.chatId !== null && target.chatId === chat.chatId
    : target.animaId === chat.animaId;
}

/** Record a streaming reply; returns the call that withdraws it. */
export function registerStreamingReply(reply: StreamingReply): () => void {
  const entry = { ...reply };
  useChatDeleteCoordinationStore.setState((state) => ({
    replies: [...state.replies, entry],
  }));
  return () =>
    useChatDeleteCoordinationStore.setState((state) => ({
      replies: state.replies.filter((candidate) => candidate !== entry),
    }));
}

/** Stop every streaming reply in what `target` deletes; returns how many. */
export function stopStreamingReplies(target: ChatDeleteTarget): number {
  const replies = useChatDeleteCoordinationStore
    .getState()
    .replies.filter((reply) => covers(target, reply));
  for (const reply of replies) reply.stop();
  return replies.length;
}

/** Hold sends to what `target` deletes; returns the call that releases it. */
export function holdChatSends(target: ChatDeleteTarget): () => void {
  const entry = { ...target };
  useChatDeleteCoordinationStore.setState((state) => ({
    holds: [...state.holds, entry],
  }));
  return () =>
    useChatDeleteCoordinationStore.setState((state) => ({
      holds: state.holds.filter((candidate) => candidate !== entry),
    }));
}

/** Whether a running delete holds sends to this chat (null: a new chat). */
export function isChatSendHeld(chat: {
  animaId: string;
  chatId: string | null;
}): boolean {
  return useChatDeleteCoordinationStore
    .getState()
    .holds.some((target) => covers(target, chat));
}

/**
 * Register the chat panel's reply while it streams, so a delete in this window
 * can stop it first. `stop` is read when called, so it may change identity.
 */
export function useStreamingReplyRegistration({
  animaId,
  chatId,
  isStreaming,
  stop,
}: {
  animaId: string;
  chatId: string | null;
  isStreaming: boolean;
  stop: () => void;
}): void {
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(() => {
    if (!isStreaming) return;
    return registerStreamingReply({
      animaId,
      chatId,
      stop: () => stopRef.current(),
    });
  }, [animaId, chatId, isStreaming]);
}
