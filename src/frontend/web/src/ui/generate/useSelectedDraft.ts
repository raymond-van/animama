import { useEffect, useRef, useState } from "react";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { draftCanBeRevised } from "./generationDrafts";

/**
 * Which draft is selected: the one the preview plays and the next message
 * revises. Opening a conversation selects its latest draft, a draft the
 * assistant has just written is selected as it appears, and a selection whose
 * draft was discarded is dropped. `null` means the next message writes a new
 * draft.
 *
 * A draft without a project (a failed write) is never selected by the page
 * itself, since no message can revise it; the person can still pick it to see
 * why it failed.
 */
export function useSelectedDraft(
  conversationId: string | null,
  snapshot: PyGenerationConversationSnapshot | undefined,
): [PyGenerationDraft | null, (draftId: string | null) => void] {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const known = useRef<{ conversationId: string; ids: Set<string> } | null>(
    null,
  );
  const drafts = snapshot?.drafts;
  useEffect(() => {
    if (!conversationId || !drafts) return;
    const ids = drafts.map(({ id }) => id);
    const revisable = drafts.filter(draftCanBeRevised).map(({ id }) => id);
    const before = known.current;
    known.current = { conversationId, ids: new Set(ids) };
    if (before?.conversationId !== conversationId) {
      setSelectedId(revisable.at(-1) ?? null);
      return;
    }
    const added = revisable.filter((id) => !before.ids.has(id));
    if (added.length > 0) setSelectedId(added.at(-1)!);
    else
      setSelectedId((current) =>
        current && !ids.includes(current) ? null : current,
      );
  }, [conversationId, drafts]);
  const selected =
    (selectedId && drafts?.find(({ id }) => id === selectedId)) || null;
  return [selected, setSelectedId];
}
