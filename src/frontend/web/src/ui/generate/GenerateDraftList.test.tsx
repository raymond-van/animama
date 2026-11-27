// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { WordedError } from "@/lib/errors/apiError";
import { ActionDocumentIncompleteError } from "@/ui/action-editor/useSaveActionDocument";
import { GenerateDraftList } from "./GenerateDraftList";
import { generationDraft } from "./testing/generationFixtures";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import {
  validateDraft,
  type DraftValidation,
  type DraftWorker,
} from "./useDraftWorker";

const fixture = vi.hoisted(() => ({
  save: vi.fn(),
  savingDraftId: null as string | null,
  restore: vi.fn(),
  discard: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("./useSaveGenerationDraft", () => ({
  useSaveGenerationDraft: () => ({
    save: fixture.save,
    savingDraftId: fixture.savingDraftId,
    stage: "idle",
  }),
}));
vi.mock("@/query/mutations/useGenerationMutations", () => ({
  useRestoreGenerationDraft: () => ({ mutateAsync: fixture.restore }),
  useDiscardGenerationDraft: () => ({ mutateAsync: fixture.discard }),
}));
vi.mock("sonner", () => ({
  toast: { error: fixture.toastError, success: fixture.toastSuccess },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const first = generationDraft({
  id: "draft-1",
  status: "ready",
  has_previous_version: true,
});
const second = generationDraft({
  id: "draft-2",
  position: 1,
  status: "ready",
  project: {
    ...(first.project as Record<string, unknown>),
    name: "Deep Bow",
  },
});

function worker(
  drafts: readonly PyGenerationDraft[],
  overrides: Partial<DraftWorker> = {},
): DraftWorker {
  const validations: Record<string, DraftValidation> = {};
  for (const draft of drafts)
    if (draft.project) validations[draft.id] = validateDraft(draft);
  return {
    validations,
    checkingDraftId: null,
    failures: {},
    retryCheck: vi.fn(),
    frames: { status: "idle", draftId: null },
    ...overrides,
  };
}

let mounted: MountedInDocument | null = null;
const onSelect = vi.fn();

function list(
  drafts: readonly PyGenerationDraft[],
  props: {
    selectedDraftId?: string | null;
    running?: boolean;
    isLoading?: boolean;
    loadFailed?: boolean;
    worker?: DraftWorker;
    runDraftIds?: ReadonlySet<string>;
  } = {},
) {
  mounted = mountInDocument(
    <GenerateDraftList
      drafts={drafts}
      isLoading={props.isLoading}
      loadFailed={props.loadFailed}
      worker={props.worker ?? worker(drafts)}
      selectedDraftId={props.selectedDraftId ?? null}
      onSelect={onSelect}
      running={props.running ?? false}
      runDraftIds={props.runDraftIds}
    />,
  );
  return mounted.container;
}

const cards = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-testid="generate-draft-card"]',
  ),
];
const within = (cardIndex: number, testId: string) =>
  cards()[cardIndex]!.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeEach(() => {
  fixture.save.mockReset().mockResolvedValue(first);
  fixture.savingDraftId = null;
  fixture.restore.mockReset().mockResolvedValue(first);
  fixture.discard.mockReset().mockResolvedValue(undefined);
  fixture.toastError.mockClear();
  fixture.toastSuccess.mockClear();
  onSelect.mockClear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the conversation's drafts", () => {
  it("invites a first request while there are none", () => {
    const root = list([]);
    expect(root.textContent).toContain("No drafts yet");
    expect(root.textContent).toContain("Ask the assistant for a Gesture.");
    expect(cards()).toHaveLength(0);
  });

  it("says when the drafts are still loading, or could not be loaded", () => {
    expect(list([], { isLoading: true }).textContent).toBe("Loading drafts…");
    mounted!.unmount();
    // Not "no drafts yet": the conversation itself could not be read.
    expect(list([], { loadFailed: true }).textContent).toBe(
      "The drafts could not be loaded.",
    );
  });

  it("shows one card per draft and marks the selected one", async () => {
    list([first, second], { selectedDraftId: "draft-2" });
    expect(cards().map((card) => card.dataset.draftId)).toEqual([
      "draft-1",
      "draft-2",
    ]);
    expect(cards().map((card) => card.dataset.selected)).toEqual([
      "false",
      "true",
    ]);
    await click(within(0, "generate-draft-select"));
    expect(onSelect).toHaveBeenCalledWith("draft-1");
  });

  it("saves a draft with the page's own validation and says it is saved", async () => {
    const page = worker([first, second]);
    list([first, second], { worker: page });
    await click(within(1, "generate-draft-save"));
    expect(fixture.save).toHaveBeenCalledWith(
      second,
      page.validations["draft-2"],
    );
    expect(fixture.toastSuccess).toHaveBeenCalledWith(
      "Saved “Deep Bow” to your Library.",
    );
  });

  it("says why a save failed, unless the creator's save already did", async () => {
    fixture.save.mockRejectedValueOnce(
      new WordedError("The name is already in use."),
    );
    list([first]);
    await click(within(0, "generate-draft-save"));
    expect(fixture.toastError).toHaveBeenCalledWith(
      "The name is already in use.",
    );
    expect(fixture.toastSuccess).not.toHaveBeenCalled();

    // A failure that says nothing a person can read gets the general line.
    fixture.toastError.mockClear();
    fixture.save.mockRejectedValueOnce(null);
    await click(within(0, "generate-draft-save"));
    expect(fixture.toastError).toHaveBeenCalledWith(
      "The draft could not be saved.",
    );

    fixture.toastError.mockClear();
    fixture.save.mockRejectedValueOnce(
      new ActionDocumentIncompleteError("Name the Gesture first."),
    );
    await click(within(0, "generate-draft-save"));
    expect(fixture.toastError).not.toHaveBeenCalled();
  });

  it("shows which draft is being saved and holds the other actions meanwhile", () => {
    fixture.savingDraftId = "draft-1";
    list([first, second]);
    expect(within(0, "generate-draft-save")!.textContent).toBe("Saving…");
    for (const id of ["generate-draft-save", "generate-draft-discard"])
      expect((within(1, id) as HTMLButtonElement).disabled).toBe(true);
  });

  it("restores the previous version", async () => {
    list([first]);
    await click(within(0, "generate-draft-restore"));
    expect(fixture.restore).toHaveBeenCalledWith("draft-1");
    expect(fixture.toastError).not.toHaveBeenCalled();
  });

  it("discards a draft once confirmed", async () => {
    list([first]);
    await click(within(0, "generate-draft-discard"));
    await click(
      document.querySelector('[data-testid="generate-draft-discard-confirm"]'),
    );
    expect(fixture.discard).toHaveBeenCalledWith({
      id: "draft-1",
      conversation_id: first.conversation_id,
    });
  });

  it("holds Discard only on the drafts the run in flight is working on", () => {
    list([first, second], {
      running: true,
      runDraftIds: new Set(["draft-2"]),
    });
    const discard = (index: number) =>
      within(index, "generate-draft-discard") as HTMLButtonElement;
    expect(discard(0).disabled).toBe(false);
    expect(discard(1).disabled).toBe(true);
    expect(discard(1).title).toBe("Available when the assistant has finished.");
  });

  it("words a refused action from the backend's code", async () => {
    fixture.restore.mockRejectedValueOnce({
      detail: { code: "generation_nothing_to_restore" },
    });
    list([first]);
    await click(within(0, "generate-draft-restore"));
    expect(fixture.toastError).toHaveBeenCalledWith(
      "This draft has no earlier version to restore.",
    );
    // The draft stays, and can be acted on again.
    expect(
      (within(0, "generate-draft-restore") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("runs a draft's checks again when asked", async () => {
    const stuck = generationDraft({ id: "draft-3" });
    const page = worker([stuck], {
      failures: {
        "draft-3": { version: 1, kind: "report_failed", code: null },
      },
    });
    list([stuck], { worker: page });
    await click(within(0, "generate-draft-retry-check"));
    expect(page.retryCheck).toHaveBeenCalledWith("draft-3");
  });

  it("takes every word of its empty and loading states from the catalog", async () => {
    const leave = await enterPseudoLocale();
    try {
      list([]);
      expect(unmarkedText(document.body)).toEqual([]);
      mounted!.unmount();
      list([], { isLoading: true });
      expect(unmarkedText(document.body)).toEqual([]);
      mounted!.unmount();
      list([], { loadFailed: true });
      expect(unmarkedText(document.body)).toEqual([]);
    } finally {
      await leave();
    }
  });
});
