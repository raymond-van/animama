import { useMemo, useRef } from "react";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { actionComponentSandboxEntries } from "@/lib/content-preview/actionComponentSandbox";
import type { PyContentDependency } from "@/lib/content/catalogTypes";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { useActionComponentPreviews } from "@/query/hooks/useActionComponentPreviews";
import {
  draftEffects,
  draftEffectsInfo,
  goneEffectRootKeys,
  listedEffectDependencies,
  type DraftEffectsInfo,
} from "./draftEffects";

/** One list for every render without effects, so its readers stay still. */
const NO_DEPENDENCIES: readonly PyContentDependency[] = [];
const NO_ENTRIES: readonly RuntimeCatalogEntry[] = [];

export type DraftEffectsView = {
  /**
   * The selected draft's effects as the creator's sandbox entries, for the
   * preview provider. The list keeps its identity while the selected draft's
   * effects and their resolved previews stay as they are: the provider
   * rebuilds its runtime catalog, and so reloads the Avatar, when it changes.
   */
  sandboxEntries: readonly RuntimeCatalogEntry[];
  /** What each draft that plays effects shows of them, by draft id. */
  byDraft: ReadonlyMap<string, DraftEffectsInfo>;
};

/**
 * Keep one array while the dependencies it holds stay the same, whichever
 * draft object or version they were read from, as the creator does for its
 * document's dependencies.
 */
function useSameDependencies(
  next: readonly PyContentDependency[],
): readonly PyContentDependency[] {
  const kept = useRef({ digest: "[]", value: NO_DEPENDENCIES });
  const digest = next.length === 0 ? "[]" : JSON.stringify(next);
  if (kept.current.digest !== digest)
    kept.current = {
      digest,
      value: next.length === 0 ? NO_DEPENDENCIES : next,
    };
  return kept.current.value;
}

/**
 * The effects of a conversation's drafts, resolved against the Library
 * through the creator's component previews (R5.3):
 *
 * - The selected draft's dependencies become the creator's sandbox entries,
 *   which the preview mounts under the aliases the draft's events name.
 * - Every listed draft's dependencies are resolved together in one more
 *   request, so each card can say when an effect it plays is no longer in the
 *   Library. While the selection holds every effect the list plays, the two
 *   are one request. Only a source the answer reports as gone counts: one
 *   that is still being resolved, or could not be, holds no draft back.
 */
export function useDraftEffects(
  drafts: readonly PyGenerationDraft[],
  selectedDraft: PyGenerationDraft | null,
): DraftEffectsView {
  const selectedDependencies = useSameDependencies(
    selectedDraft ? draftEffects(selectedDraft).dependencies : NO_DEPENDENCIES,
  );
  const listedDependencies = useSameDependencies(
    useMemo(() => listedEffectDependencies(drafts.map(draftEffects)), [drafts]),
  );
  const selected = useActionComponentPreviews(selectedDependencies);
  // Asked again whenever the page opens: an effect may have been deleted in
  // the Library since, and an answer still cached would not say so.
  const listed = useActionComponentPreviews(listedDependencies, {
    refetchOnMount: "always",
  });

  const sandboxEntries = useMemo(
    () =>
      selected.previews.length === 0
        ? NO_ENTRIES
        : selected.previews.flatMap(({ dependency, preview }) =>
            actionComponentSandboxEntries(preview, dependency),
          ),
    [selected.previews],
  );
  const byDraft = useMemo(() => {
    const gone = goneEffectRootKeys([
      ...listed.diagnostics,
      ...selected.diagnostics,
    ]);
    const info = new Map<string, DraftEffectsInfo>();
    for (const draft of drafts) {
      const shown = draftEffectsInfo(draftEffects(draft), gone);
      if (shown) info.set(draft.id, shown);
    }
    return info;
  }, [drafts, listed.diagnostics, selected.diagnostics]);

  return { sandboxEntries, byDraft };
}
