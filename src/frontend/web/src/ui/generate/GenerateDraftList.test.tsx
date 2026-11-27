// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { WordedError } from "@/lib/errors/apiError";
import { ActionDocumentIncompleteError } from "@/ui/action-editor/useSaveActionDocument";
import { GenerateDraftList } from "./GenerateDraftList";
import type { DraftEffectsInfo } from "./draftEffects";
import type { DraftBatchInfo } from "./generationBatch";
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
    workingDraftIds?: ReadonlySet<string>;
    batchInfo?: ReadonlyMap<string, DraftBatchInfo>;
    effects?: ReadonlyMap<string, DraftEffectsInfo>;
  } = {},
) {
  const node = (
    <GenerateDraftList
      drafts={drafts}
      isLoading={props.isLoading}
      loadFailed={props.loadFailed}
      worker={props.worker ?? worker(drafts)}
      selectedDraftId={props.selectedDraftId ?? null}
      onSelect={onSelect}
      running={props.running ?? false}
      runDraftIds={props.runDraftIds}
      workingDraftIds={props.workingDraftIds}
      batchInfo={props.batchInfo}
      effects={props.effects}
    />
  );
  // A second call shows the same list with what changed meanwhile.
  if (mounted) mounted.rerender(node);
  else mounted = mountInDocument(node);
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
    mounted = null;
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
      mounted = null;
      list([], { isLoading: true });
      expect(unmarkedText(document.body)).toEqual([]);
      mounted!.unmount();
      mounted = null;
      list([], { loadFailed: true });
      expect(unmarkedText(document.body)).toEqual([]);
    } finally {
      await leave();
    }
  });

  describe("saving several drafts (R7.4)", () => {
    const third = generationDraft({
      id: "draft-3",
      position: 2,
      status: "warnings",
      project: {
        ...(first.project as Record<string, unknown>),
        name: "Big Cheer",
      },
    });
    /** A failed write: it never had a clip, so it cannot be saved. */
    const empty = generationDraft({
      id: "draft-4",
      position: 3,
      status: "failed",
      project: null,
      failure_reason: "generation_no_valid_draft",
    });
    const find = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const button = (testId: string) => find(testId) as HTMLButtonElement;
    const savedIds = () =>
      fixture.save.mock.calls.map(([draft]) => (draft as PyGenerationDraft).id);
    const summary = () => {
      const shown = find("generate-drafts-save-summary");
      return shown
        ? [...shown.querySelectorAll("span")].map((line) => line.textContent)
        : null;
    };

    it("is offered once the conversation has more than one draft", () => {
      list([first]);
      expect(find("generate-drafts-save-many")).toBeNull();
      expect(within(0, "generate-draft-mark")).toBeNull();
      // The card's own Save is there as before.
      expect(within(0, "generate-draft-save")).not.toBeNull();

      list([first, second]);
      expect(button("generate-drafts-save-all").textContent).toBe("Save all");
      expect(button("generate-drafts-save-selected").textContent).toBe(
        "Save selected (0)",
      );
      expect(button("generate-drafts-save-selected").disabled).toBe(true);
      expect(within(1, "generate-draft-mark")!.getAttribute("aria-label")).toBe(
        "Mark “Deep Bow” for saving",
      );
    });

    it("saves the marked drafts one after another, each through the card's own save", async () => {
      // Each save is held until released, to see that they do not overlap.
      const releases: (() => void)[] = [];
      fixture.save.mockImplementation(
        () =>
          new Promise<PyGenerationDraft>((resolve) => {
            releases.push(() => resolve(first));
          }),
      );
      const page = worker([first, second, third]);
      list([first, second, third], { worker: page });
      await click(within(0, "generate-draft-mark"));
      await click(within(2, "generate-draft-mark"));
      expect(button("generate-drafts-save-selected").textContent).toBe(
        "Save selected (2)",
      );

      await click(button("generate-drafts-save-selected"));
      expect(savedIds()).toEqual(["draft-1"]);
      expect(fixture.save).toHaveBeenLastCalledWith(
        first,
        page.validations["draft-1"],
      );
      expect(find("generate-drafts-save-progress")!.textContent).toBe(
        "Saving draft 1 of 2…",
      );
      // Nothing else is started on any draft while the sequence runs.
      expect(button("generate-drafts-save-all").disabled).toBe(true);
      expect(
        (within(1, "generate-draft-save") as HTMLButtonElement).disabled,
      ).toBe(true);

      await act(async () => releases[0]!());
      expect(savedIds()).toEqual(["draft-1", "draft-3"]);
      await act(async () => releases[1]!());

      expect(summary()).toEqual(["Saved 2 drafts to your Library."]);
      // The unmarked draft was never saved, and the marks are spent.
      expect(savedIds()).not.toContain("draft-2");
      expect(button("generate-drafts-save-selected").textContent).toBe(
        "Save selected (0)",
      );
      // One summary, not a toast for each draft.
      expect(fixture.toastSuccess).not.toHaveBeenCalled();
    });

    it("saves all drafts that can be saved and skips the ones that cannot", async () => {
      list([first, second, empty]);
      expect(within(2, "generate-draft-mark")).toBeNull();
      await click(button("generate-drafts-save-all"));
      expect(savedIds()).toEqual(["draft-1", "draft-2"]);
      expect(summary()).toEqual([
        "Saved 2 drafts to your Library.",
        "Skipped 1 draft that cannot be saved as it stands.",
      ]);
    });

    it("reports a failed save on its own card and saves the rest all the same", async () => {
      fixture.save
        .mockRejectedValueOnce(new WordedError("The name is already in use."))
        .mockResolvedValueOnce(second)
        .mockRejectedValueOnce(null);
      list([first, second, third]);
      await click(button("generate-drafts-save-all"));

      expect(savedIds()).toEqual(["draft-1", "draft-2", "draft-3"]);
      expect(within(0, "generate-draft-save-failed")!.textContent).toBe(
        "The name is already in use.",
      );
      expect(within(1, "generate-draft-save-failed")).toBeNull();
      // A failure that says nothing a person can read gets the general line.
      expect(within(2, "generate-draft-save-failed")!.textContent).toBe(
        "The draft could not be saved.",
      );
      expect(summary()).toEqual([
        "Saved 1 draft to your Library.",
        "2 drafts could not be saved. Their cards say why.",
      ]);
      const shown = find("generate-drafts-save-summary")!;
      expect(shown.getAttribute("role")).toBe("status");
      expect(shown.dataset).toMatchObject({
        saved: "1",
        failed: "2",
        skipped: "0",
      });

      // Saving the failed draft again from its card clears what its card said.
      await click(within(0, "generate-draft-save"));
      expect(within(0, "generate-draft-save-failed")).toBeNull();
      expect(within(2, "generate-draft-save-failed")).not.toBeNull();
    });

    it("skips a draft that stopped being saveable before its turn", async () => {
      const releases: (() => void)[] = [];
      fixture.save.mockImplementation(
        () =>
          new Promise<PyGenerationDraft>((resolve) => {
            releases.push(() => resolve(first));
          }),
      );
      const drafts = [first, second, third];
      list(drafts);
      await click(button("generate-drafts-save-all"));
      expect(savedIds()).toEqual(["draft-1"]);

      // Meanwhile a run starts revising the second draft, and the third gets
      // a version the page has not validated.
      const moved = { ...third, version: 2 };
      list([first, second, moved], {
        worker: worker(drafts),
        running: true,
        workingDraftIds: new Set(["draft-2"]),
      });
      await act(async () => releases[0]!());

      expect(savedIds()).toEqual(["draft-1"]);
      expect(summary()).toEqual([
        "Saved 1 draft to your Library.",
        "Skipped 2 drafts that cannot be saved as they stand.",
      ]);
    });

    it("stops when another conversation is opened, and says nothing of it there", async () => {
      const releases: (() => void)[] = [];
      fixture.save.mockImplementation(
        () =>
          new Promise<PyGenerationDraft>((resolve) => {
            releases.push(() => resolve(first));
          }),
      );
      list([first, second]);
      await click(within(0, "generate-draft-mark"));
      await click(button("generate-drafts-save-all"));
      expect(savedIds()).toEqual(["draft-1"]);

      const elsewhere = [first, second].map((draft, index) => ({
        ...draft,
        id: `other-${index + 1}`,
        conversation_id: "conversation-2",
      }));
      list(elsewhere);
      await act(async () => releases[0]!());

      // The second draft of the conversation left behind is not saved.
      expect(savedIds()).toEqual(["draft-1"]);
      expect(find("generate-drafts-save-summary")).toBeNull();
      expect(find("generate-drafts-save-progress")).toBeNull();
      // Marks do not follow into another conversation either.
      expect(button("generate-drafts-save-selected").textContent).toBe(
        "Save selected (0)",
      );
      expect(button("generate-drafts-save-all").disabled).toBe(false);
    });

    it("skips a draft whose effect is gone from the Library, and says so on its card", async () => {
      const gone = new Map<string, DraftEffectsInfo>([
        ["draft-2", { aliases: ["sparkle"], missing: ["sparkle"] }],
        // Its effect is still there: saved like any other draft.
        ["draft-3", { aliases: ["rain"], missing: [] }],
      ]);
      list([first, second, third], { effects: gone });
      expect(
        within(1, "generate-draft-missing-effects")!.textContent,
      ).toContain("sparkle");
      expect(
        (within(1, "generate-draft-save") as HTMLButtonElement).disabled,
      ).toBe(true);
      // It is not offered for "Save selected".
      expect(within(1, "generate-draft-mark")).toBeNull();
      expect(within(2, "generate-draft-mark")).not.toBeNull();

      await click(button("generate-drafts-save-all"));
      expect(savedIds()).toEqual(["draft-1", "draft-3"]);
      expect(summary()).toEqual([
        "Saved 2 drafts to your Library.",
        "Skipped 1 draft that cannot be saved as it stands.",
      ]);
      expect(find("generate-drafts-save-summary")!.dataset).toMatchObject({
        saved: "2",
        failed: "0",
        skipped: "1",
      });
    });

    it("skips a draft whose effect is found gone before its turn", async () => {
      let release!: () => void;
      fixture.save.mockImplementationOnce(
        () =>
          new Promise<PyGenerationDraft>((resolve) => {
            release = () => resolve(first);
          }),
      );
      list([first, second]);
      await click(button("generate-drafts-save-all"));
      expect(savedIds()).toEqual(["draft-1"]);
      // The Library's answer arrives while the first draft is being saved.
      list([first, second], {
        effects: new Map([
          ["draft-2", { aliases: ["sparkle"], missing: ["sparkle"] }],
        ]),
      });
      await act(async () => release());
      expect(savedIds()).toEqual(["draft-1"]);
      expect(summary()).toEqual([
        "Saved 1 draft to your Library.",
        "Skipped 1 draft that cannot be saved as it stands.",
      ]);
    });

    it("offers nothing to save when the only saveable draft plays a missing effect", () => {
      list([second, empty], {
        effects: new Map([
          ["draft-2", { aliases: ["sparkle"], missing: ["sparkle"] }],
        ]),
      });
      expect(button("generate-drafts-save-all").disabled).toBe(true);
    });

    it("waits for a run in flight, as a card's Save does", async () => {
      list([first, second], { running: true });
      // A draft can be marked meanwhile, for when the run has finished.
      await click(within(0, "generate-draft-mark"));
      for (const id of [
        "generate-drafts-save-selected",
        "generate-drafts-save-all",
      ]) {
        expect(button(id).disabled).toBe(true);
        expect(button(id).title).toBe(
          "Available when the assistant has finished.",
        );
      }
      list([first, second], { running: false });
      expect(button("generate-drafts-save-selected").disabled).toBe(false);
      expect(button("generate-drafts-save-selected").textContent).toBe(
        "Save selected (1)",
      );
      // Nothing was saved by itself when the run ended.
      expect(fixture.save).not.toHaveBeenCalled();
    });

    it("takes every word of saving several from the catalog", async () => {
      fixture.save.mockRejectedValueOnce(null).mockResolvedValueOnce(second);
      list([first, second, empty]);
      await click(button("generate-drafts-save-all"));
      const leave = await enterPseudoLocale();
      try {
        expect(unmarkedText(find("generate-drafts-save-many")!, [])).toEqual(
          [],
        );
      } finally {
        await leave();
      }
    });
  });

  describe("a batch's drafts", () => {
    const planned = (id: string, position: number) =>
      generationDraft({ id, position, status: "writing", project: null });
    const info = (
      entries: Record<string, Partial<DraftBatchInfo>>,
    ): ReadonlyMap<string, DraftBatchInfo> =>
      new Map(
        Object.entries(entries).map(([id, entry]) => [
          id,
          { brief: "", step: null, failure: null, ...entry },
        ]),
      );

    it("lists every planned item at once, each with its brief and its own step", () => {
      const drafts = [
        generationDraft({ id: "draft-1", status: "checking" }),
        planned("draft-2", 1),
        planned("draft-3", 2),
      ];
      list(drafts, {
        running: true,
        workingDraftIds: new Set(["draft-1", "draft-2"]),
        batchInfo: info({
          "draft-1": { brief: "A shy wave", step: "checking" },
          "draft-2": { brief: "A deep bow", step: "writing" },
          "draft-3": { brief: "A big cheer", step: "waiting" },
        }),
      });
      expect(
        cards().map((card) => [
          card.querySelector('[data-testid="generate-draft-brief"]')!
            .textContent,
          card.querySelector('[data-testid="generate-draft-status"]')!
            .textContent,
        ]),
      ).toEqual([
        ["A shy wave", "Checking…"],
        ["A deep bow", "Writing…"],
        ["A big cheer", "Waiting for its turn…"],
      ]);
    });

    it("lets one item be discarded during the run without touching the others", async () => {
      const drafts = [
        generationDraft({ id: "draft-1", status: "checking" }),
        planned("draft-2", 1),
        planned("draft-3", 2),
      ];
      const batchInfo = info({
        "draft-1": { brief: "A shy wave", step: "checking" },
        "draft-2": { brief: "A deep bow", step: "writing" },
        "draft-3": { brief: "A big cheer", step: "waiting" },
      });
      // No batch item's Discard waits for the run: the backend ends only it.
      list(drafts, { running: true, batchInfo });
      for (const index of [0, 1, 2])
        expect(
          (within(index, "generate-draft-discard") as HTMLButtonElement)
            .disabled,
        ).toBe(false);

      await click(within(1, "generate-draft-discard"));
      await click(
        document.querySelector(
          '[data-testid="generate-draft-discard-confirm"]',
        ),
      );
      expect(fixture.discard).toHaveBeenCalledWith({
        id: "draft-2",
        conversation_id: drafts[1]!.conversation_id,
      });

      // The list without it shows the other two exactly as before.
      list([drafts[0]!, drafts[2]!], { running: true, batchInfo });
      expect(
        cards().map((card) => [
          card.dataset.draftId,
          card.querySelector('[data-testid="generate-draft-status"]')!
            .textContent,
        ]),
      ).toEqual([
        ["draft-1", "Checking…"],
        ["draft-3", "Waiting for its turn…"],
      ]);
      expect(fixture.toastError).not.toHaveBeenCalled();
    });

    it("stays a list of ten cards, each with its own actions", () => {
      const drafts = Array.from({ length: 10 }, (_, index) =>
        generationDraft({
          id: `draft-${index + 1}`,
          position: index,
          status: "ready",
        }),
      );
      list(drafts);
      expect(cards()).toHaveLength(10);
      expect(
        document.querySelectorAll('[data-testid="generate-draft-mark"]'),
      ).toHaveLength(10);
      expect(
        document.querySelectorAll('[data-testid="generate-draft-save"]'),
      ).toHaveLength(10);
    });
  });
});
