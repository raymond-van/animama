import { useEffect, useRef, useState } from "react";

import { useGenerationConversations } from "@/query/hooks/useGeneration";
import {
  useCreateGenerationConversation,
  useDeleteGenerationConversation,
} from "@/query/mutations/useGenerationMutations";

/**
 * The unsaved-item conversations this tab started, kept for the tab's
 * session, and the ones a mounted creator is using now. A creator may delete
 * only a conversation this tab started and no creator still uses: another
 * tab's unsaved item has a conversation of its own, which this tab must not
 * touch. What a tab leaves behind (a closed tab, a cleared session) the
 * backend removes after seven days.
 */
const STARTED_KEY = "animama.generation.unsaved-creator-conversations";
const inUse = new Set<string>();

function startedHere(): string[] {
  try {
    const stored: unknown = JSON.parse(
      window.sessionStorage.getItem(STARTED_KEY) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberStarted(ids: readonly string[]): void {
  try {
    window.sessionStorage.setItem(STARTED_KEY, JSON.stringify(ids));
  } catch {
    // Without session storage nothing is remembered, and nothing is deleted.
  }
}

/**
 * The assistant conversation that belongs to the item open in a creator.
 *
 * A saved item has one conversation, scoped to its kind and catalog id, found
 * again whenever the item is reopened and started the first time the panel
 * opens for it. An unsaved item has no id to find one by: it gets a
 * conversation of its own for as long as the creator stays open. Starting it
 * removes the conversations this tab's earlier unsaved items left behind,
 * which nothing can reach any more; another tab's are never touched.
 */
export function useCreatorGenerationConversation(input: {
  intent: "gesture" | "reaction";
  /** The open item's catalog id, or `null` while it is not saved. */
  itemId: string | null;
  /** The panel was opened: only then is a conversation started. */
  enabled: boolean;
}): {
  conversationId: string | null;
  /** The conversations could not be read, or one could not be started. */
  isError: boolean;
  retry: () => void;
} {
  const { intent, itemId, enabled } = input;
  const list = useGenerationConversations();
  const { mutateAsync: create } = useCreateGenerationConversation();
  const { mutateAsync: remove } = useDeleteGenerationConversation();
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const starting = useRef(false);

  const ofItem = (list.data ?? []).filter(
    ({ scope }) =>
      scope.kind === "creator" &&
      scope.intent === intent &&
      (scope.catalog_item_id ?? null) === itemId,
  );
  const conversationId = itemId
    ? (ofItem[0]?.id ?? null)
    : (ofItem.find(({ id }) => id === unsaved)?.id ?? null);
  const listedRef = useRef(ofItem);
  listedRef.current = ofItem;

  // While this creator is mounted its unsaved conversation is in use.
  useEffect(() => {
    if (!unsaved) return;
    inUse.add(unsaved);
    return () => {
      inUse.delete(unsaved);
    };
  }, [unsaved]);

  useEffect(() => {
    if (!enabled || !list.isSuccess || conversationId || startFailed) return;
    // One at a time: development replays this effect.
    if (starting.current) return;
    starting.current = true;
    void (async () => {
      let started = startedHere();
      if (!itemId) {
        // This tab's earlier unsaved items of this kind can no longer be
        // opened; one a mounted creator still uses is left alone.
        const listed = new Set(listedRef.current.map(({ id }) => id));
        for (const id of started)
          if (listed.has(id) && !inUse.has(id)) {
            await remove(id).catch(() => undefined);
            started = started.filter((other) => other !== id);
          }
      }
      const conversation = await create({
        kind: "creator",
        intent,
        catalog_item_id: itemId,
      });
      if (!itemId) {
        // Claimed before the next render, so no other creator removes it.
        inUse.add(conversation.id);
        rememberStarted([...started, conversation.id]);
        setUnsaved(conversation.id);
      }
    })()
      .catch(() => setStartFailed(true))
      .finally(() => {
        starting.current = false;
      });
  }, [
    conversationId,
    create,
    enabled,
    intent,
    itemId,
    list.isSuccess,
    remove,
    startFailed,
  ]);

  const { isError: listFailed, refetch } = list;
  return {
    conversationId,
    isError: listFailed || startFailed,
    retry: () => {
      if (listFailed) void refetch();
      setStartFailed(false);
    },
  };
}
