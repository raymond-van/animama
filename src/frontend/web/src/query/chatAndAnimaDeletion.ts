import type { QueryClient } from "@tanstack/react-query";

import type {
  PyAnimaListItem,
  PyChatResponse,
} from "@/lib/content/catalogTypes";
import { readApiError } from "@/lib/errors/apiError";
import { queryKeys } from "@/query/keys";
import { sdkResultError, type SdkResult } from "@/query/sdkResultError";

/** A chat or Anima delete the server refused, with its status and code. */
export class DeleteRequestError extends Error {
  readonly status: number;
  /** The refusal's code, such as `chat_turn_stopping` (409, retryable). */
  readonly code: string | null;

  constructor(status: number, body: unknown) {
    const info = readApiError(body);
    super(info.message ?? `Delete failed (${status}).`);
    this.name = "DeleteRequestError";
    this.status = status;
    this.code = info.code;
  }
}

/**
 * Settle a delete response. A 404 means the item is already gone (deleted in
 * another window), which is the outcome the person asked for.
 */
export function assertDeleted(result: SdkResult): void {
  if (result.response?.status === 404) return;
  if (result.error !== undefined || !result.response?.ok)
    throw sdkResultError(
      result,
      (status, error) => new DeleteRequestError(status, error),
    );
}

/** Whether a delete failed only because a reply is still stopping. */
export function isReplyStillStopping(error: unknown): boolean {
  return (
    error instanceof DeleteRequestError && error.code === "chat_turn_stopping"
  );
}

/** Every cached chat list (with and without last-message times). */
const chatListsKey = (userKey: string) =>
  [...queryKeys.chats.all(userKey), "list"] as const;

/** The IDs of cached chats that match `predicate`. */
export function cachedChatIds(
  queryClient: QueryClient,
  userKey: string,
  predicate: (chat: PyChatResponse) => boolean,
): string[] {
  const ids = new Set<string>();
  for (const [, rows] of queryClient.getQueriesData<PyChatResponse[]>({
    queryKey: chatListsKey(userKey),
  }))
    for (const chat of rows ?? []) if (predicate(chat)) ids.add(chat.id);
  return [...ids];
}

/**
 * Take deleted chats out of every cached chat list at once, so the sidebar
 * drops them before the refetch and a route resolved from the cache cannot
 * reopen one.
 */
function pruneChatLists(
  queryClient: QueryClient,
  userKey: string,
  deleted: (chat: PyChatResponse) => boolean,
): void {
  queryClient.setQueriesData<PyChatResponse[]>(
    { queryKey: chatListsKey(userKey) },
    (rows) => rows?.filter((chat) => !deleted(chat)),
  );
}

/** Forget a deleted chat's own queries; call once nothing shows it. */
function removeChatQueries(
  queryClient: QueryClient,
  userKey: string,
  chatId: string,
): void {
  queryClient.removeQueries({
    queryKey: queryKeys.chats.detail(userKey, chatId),
  });
  queryClient.removeQueries({
    queryKey: queryKeys.chats.messages(userKey, chatId),
  });
}

/**
 * What a chat delete changes besides the chat: its pending episodes (and any
 * episode run holding them), the episode log, and its chat-only images.
 */
function invalidateChatDeleteEffects(
  queryClient: QueryClient,
  userKey: string,
): Promise<unknown> {
  return Promise.all(
    [
      queryKeys.chats.all(userKey),
      queryKeys.memoryEntries.all(userKey),
      queryKeys.memoryEpisodes.all(userKey),
      queryKeys.memoryManager.all(userKey),
      queryKeys.userFiles.all(userKey),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

/** Drop a deleted chat from the sidebar before the page moves away from it. */
export function pruneDeletedChat(
  queryClient: QueryClient,
  userKey: string,
  chatId: string,
): void {
  pruneChatLists(queryClient, userKey, (chat) => chat.id === chatId);
}

/**
 * Finish a chat delete once the page no longer shows the chat: forget its
 * queries and refresh what the delete changed. Refreshing earlier would
 * refetch the open chat and fail.
 */
export function settleDeletedChat(
  queryClient: QueryClient,
  userKey: string,
  chatId: string,
): Promise<unknown> {
  removeChatQueries(queryClient, userKey, chatId);
  return invalidateChatDeleteEffects(queryClient, userKey);
}

/** Drop a deleted Anima and its chats from the sidebar and rail. */
export function pruneDeletedAnima(
  queryClient: QueryClient,
  userKey: string,
  animaId: string,
): void {
  queryClient.setQueryData<PyAnimaListItem[]>(
    queryKeys.animas.list(userKey),
    (rows) => rows?.filter((anima) => anima.id !== animaId),
  );
  pruneChatLists(queryClient, userKey, (chat) => chat.anima_id === animaId);
}

/**
 * Finish an Anima delete once the page no longer shows it: forget its queries
 * and its chats' queries, then refresh the roster, loadouts, settings (its
 * last-active pointer is cleared) and what its chats' delete changed.
 */
export function settleDeletedAnima(
  queryClient: QueryClient,
  userKey: string,
  animaId: string,
  chatIds: readonly string[],
): Promise<unknown> {
  for (const queryKey of [
    queryKeys.animas.detail(userKey, animaId),
    queryKeys.settings.anima(userKey, animaId),
    queryKeys.animaLoadouts.detail(userKey, animaId),
    queryKeys.animaLoadouts.runtime(userKey, animaId),
  ])
    queryClient.removeQueries({ queryKey });
  for (const chatId of chatIds) removeChatQueries(queryClient, userKey, chatId);
  return Promise.all([
    invalidateChatDeleteEffects(queryClient, userKey),
    ...[
      queryKeys.animas.all(userKey),
      queryKeys.settings.all(userKey),
      queryKeys.animaLoadouts.details(userKey),
      queryKeys.animaLoadouts.runtimes(userKey),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ]);
}
