// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import {
  GenerateDraftCard,
  type GenerateDraftCardProps,
} from "./GenerateDraftCard";
import { generationDraft } from "./testing/generationFixtures";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import { validateDraft } from "./useDraftWorker";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={to}
      data-params={JSON.stringify(params ?? {})}
      data-search={JSON.stringify(search ?? {})}
      {...rest}
    >
      {children}
    </a>
  ),
}));

let mounted: MountedInDocument | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const actions = {
  onSelect: vi.fn(),
  onSave: vi.fn(),
  onRestore: vi.fn(),
  onDiscard: vi.fn(),
  onRetryCheck: vi.fn(),
};

function card(
  draft: PyGenerationDraft,
  props: Partial<GenerateDraftCardProps> = {},
) {
  mounted = mountInDocument(
    <GenerateDraftCard
      draft={draft}
      // As the page does: validate the draft's own clip.
      validation={draft.project ? validateDraft(draft) : undefined}
      selected={false}
      running={false}
      {...actions}
      {...props}
    />,
  );
  return mounted.container;
}

const find = (root: ParentNode, testId: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** A report for the draft's current version. */
const checked = (
  report: Record<string, unknown>,
  overrides: Partial<PyGenerationDraft> = {},
) =>
  generationDraft({
    status: "warnings",
    checked_version: 1,
    check_report: { loadable: true, issues: [], findings: [], ...report },
    ...overrides,
  });

const finding = (overrides: Record<string, unknown> = {}) => ({
  category: "intersection",
  severity: "fail",
  avatar: "Andrew",
  subject: "rightHand/head",
  from: 0.8,
  to: 0.93,
  ...overrides,
});

describe("a draft card", () => {
  it.each([
    ["writing", "Writing…"],
    ["checking", "Checking…"],
    ["repairing", "Repairing…"],
    ["reviewing", "Reviewing frames…"],
    ["ready", "Ready"],
    ["warnings", "Ready, with warnings"],
    ["failed", "Failed"],
  ] as const)("says a %s draft is “%s”", (status, text) => {
    const root = card(generationDraft({ status }));
    const shown = find(root, "generate-draft-status")!;
    expect(shown.dataset.status).toBe(status);
    expect(shown.textContent).toBe(text);
    expect(find(root, "generate-draft-select")!.textContent).toContain(
      "Shy Wave",
    );
  });

  it("words each warning, with the Avatar and time range it was measured on", async () => {
    const root = card(
      checked({
        findings: [
          finding(),
          finding({
            category: "smoothness",
            severity: "warn",
            avatar: null,
            from: 1.2,
            to: 1.2,
          }),
          finding({ category: "balance", severity: "warn", from: null }),
        ],
        expression_names: { missing: ["Fcl_ALL_Joy", "cheekPuff"] },
      }),
    );
    await click(find(root, "generate-draft-remarks-toggle"));
    const remarks = [
      ...find(root, "generate-draft-remarks")!.querySelectorAll("li"),
    ].map((item) => item.textContent);
    // Failed checks first, then warnings as the clip plays.
    expect(remarks).toEqual([
      "Body parts pass through each other.On Andrew · 0.80–0.93 s",
      // A category this page does not know, measured on an Avatar.
      "A motion check raised a warning.On Andrew",
      "A movement is a little abrupt.At 1.20 s",
      "The chosen Avatar cannot show these expressions: Fcl_ALL_Joy and cheekPuff.",
    ]);
    expect([...root.querySelectorAll('li[data-tone="warning"]')].length).toBe(
      4,
    );
  });

  it("shows expression names only some Avatars have as a note, not a warning", () => {
    const root = card(
      checked(
        { expression_names: { avatar_only: ["Cheek_Blush"] } },
        { status: "ready" },
      ),
    );
    const note = root.querySelector("li")!;
    expect(note.dataset.tone).toBe("note");
    expect(note.textContent).toBe(
      "Plays only on Avatars that have these expressions: Cheek_Blush.",
    );
    expect(root.querySelector('li[data-tone="warning"]')).toBeNull();
    expect(find(root, "generate-draft-status")!.textContent).toBe("Ready");
  });

  it("folds a long list of warnings until asked for all of them", async () => {
    const root = card(
      checked({
        findings: [0.1, 0.2, 0.3, 0.4, 0.5].map((from) =>
          finding({ from, to: from }),
        ),
      }),
    );
    const toggle = find(root, "generate-draft-remarks-toggle")!;
    expect(root.querySelectorAll("li")).toHaveLength(3);
    expect(toggle.textContent).toBe("Show all 5");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await click(toggle);
    expect(root.querySelectorAll("li")).toHaveLength(5);
    expect(toggle.textContent).toBe("Show fewer");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows nothing from a report of an earlier version", () => {
    const root = card(
      generationDraft({
        version: 2,
        checked_version: 1,
        check_report: { loadable: true, findings: [finding()] },
      }),
    );
    expect(find(root, "generate-draft-remarks")).toBeNull();
  });

  it("offers Save and Open in creator for a draft that loads", () => {
    const draft = generationDraft({ status: "ready" });
    const root = card(draft);
    expect(find(root, "generate-draft-save")!.textContent).toBe("Save");
    const open = find(root, "generate-draft-open")!;
    expect(open.textContent).toBe("Open in creator");
    expect(open.getAttribute("href")).toBe("/gestures/new");
    expect(JSON.parse(open.dataset.search!)).toEqual({
      draft: draft.id,
      conversation: draft.conversation_id,
    });
  });

  it("offers neither Save nor Open in creator for a draft that does not load", () => {
    const broken = generationDraft({
      status: "failed",
      failure_reason: "generation_no_valid_draft",
      project: { name: "Broken", sequence: { schema: "nonsense" } },
    });
    const root = card(broken);
    expect(find(root, "generate-draft-save")).toBeNull();
    expect(find(root, "generate-draft-open")).toBeNull();
    expect(find(root, "generate-draft-unplayable")!.textContent).toBe(
      "This draft cannot be played or saved.",
    );
    // Why it failed, from its reason code.
    expect(root.textContent).toContain(
      "The assistant did not produce a draft that works.",
    );
    // It can still be discarded.
    expect(find(root, "generate-draft-discard")).not.toBeNull();
    mounted!.unmount();

    // A draft that failed before it had a project.
    const empty = card(generationDraft({ status: "failed", project: null }));
    expect(find(empty, "generate-draft-save")).toBeNull();
    expect(find(empty, "generate-draft-select")!.textContent).toContain(
      "Untitled draft",
    );
  });

  it("offers Restore only when there is a previous version", async () => {
    expect(find(card(generationDraft()), "generate-draft-restore")).toBeNull();
    mounted!.unmount();

    const root = card(generationDraft({ has_previous_version: true }));
    const restore = find(root, "generate-draft-restore")!;
    expect(restore.textContent).toBe("Restore previous version");
    await click(restore);
    expect(actions.onRestore).toHaveBeenCalledTimes(1);
  });

  it("holds Save and Restore while the assistant works, and says why", () => {
    const root = card(
      generationDraft({ status: "ready", has_previous_version: true }),
      { running: true },
    );
    for (const id of ["generate-draft-save", "generate-draft-restore"]) {
      const button = find(root, id) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Available when the assistant has finished.");
    }
    // The run works on another draft: this one can still be discarded.
    const discard = find(root, "generate-draft-discard") as HTMLButtonElement;
    expect(discard.disabled).toBe(false);
    expect(discard.title).toBe("");
  });

  it("holds Discard on the draft the run in flight is working on", async () => {
    const root = card(generationDraft({ status: "repairing" }), {
      running: true,
      inRun: true,
    });
    // Discarding it would end the run as a failure.
    const discard = find(root, "generate-draft-discard") as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    expect(discard.title).toBe("Available when the assistant has finished.");
    await click(discard);
    expect(find(document, "generate-draft-discard-dialog")).toBeNull();
    expect(actions.onDiscard).not.toHaveBeenCalled();
  });

  it("shows a saved draft as saved, with a link to its item in the creator", () => {
    const root = card(
      generationDraft({ status: "ready", saved_item_id: "item-9" }),
    );
    expect(find(root, "generate-draft-saved")!.textContent).toContain(
      "Saved to your Library",
    );
    const link = find(root, "generate-draft-saved-link")!;
    expect(link.getAttribute("href")).toBe("/gestures/$gestureId/edit");
    expect(JSON.parse(link.dataset.params!)).toEqual({ gestureId: "item-9" });
    expect(find(root, "generate-draft-save")!.textContent).toBe("Save again");
  });

  it("selects the draft from its name, and saves on Save", async () => {
    const root = card(generationDraft({ status: "ready" }));
    const select = find(root, "generate-draft-select")!;
    expect(select.getAttribute("aria-pressed")).toBe("false");
    expect(select.getAttribute("aria-label")).toBe("Select draft Shy Wave");
    await click(select);
    expect(actions.onSelect).toHaveBeenCalledTimes(1);
    await click(find(root, "generate-draft-save"));
    expect(actions.onSave).toHaveBeenCalledTimes(1);
    mounted!.unmount();

    const selected = card(generationDraft(), { selected: true });
    expect(
      find(selected, "generate-draft-select")!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(find(selected, "generate-draft-card")!.dataset.selected).toBe(
      "true",
    );
  });

  it("discards only after the person confirms", async () => {
    const root = card(generationDraft({ status: "ready" }));
    await click(find(root, "generate-draft-discard"));
    const dialog = find(document, "generate-draft-discard-dialog")!;
    expect(dialog.textContent).toContain("Discard “Shy Wave”?");
    expect(actions.onDiscard).not.toHaveBeenCalled();

    // Cancel keeps the draft.
    await click(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      ),
    );
    expect(find(document, "generate-draft-discard-dialog")).toBeNull();
    expect(actions.onDiscard).not.toHaveBeenCalled();

    await click(find(root, "generate-draft-discard"));
    await click(find(document, "generate-draft-discard-confirm"));
    expect(actions.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("says when its checks could not run, and offers to run them again", async () => {
    const root = card(generationDraft(), {
      checkFailure: { version: 1, kind: "checks_unavailable", code: null },
    });
    expect(find(root, "generate-draft-status")!.textContent).toBe(
      "Checks could not run",
    );
    await click(find(root, "generate-draft-retry-check"));
    expect(actions.onRetryCheck).toHaveBeenCalledTimes(1);
  });

  describe("for a version a run stopped waiting for", () => {
    const leftUnchecked = () =>
      generationDraft({
        status: "warnings",
        version: 2,
        checked_version: 2,
        check_report: { unchecked: true },
      });

    it("says it was not checked and offers to check it", async () => {
      const root = card(leftUnchecked());
      expect(root.querySelector("li")!.textContent).toBe(
        "This version was not checked.",
      );
      const again = find(root, "generate-draft-retry-check")!;
      expect(again.textContent).toBe("Check again");
      await click(again);
      expect(actions.onRetryCheck).toHaveBeenCalledTimes(1);
      // Not being checked never blocks Save.
      expect(find(root, "generate-draft-save")).not.toBeNull();
    });

    it("says so while the page checks it, without offering it again", () => {
      const root = card(leftUnchecked(), { checking: true });
      const status = find(root, "generate-draft-status")!;
      expect(status.textContent).toBe("Checking…");
      // The stored status is still what the journey and the page read.
      expect(status.dataset.status).toBe("warnings");
      expect(find(root, "generate-draft-retry-check")).toBeNull();
    });

    it("waits for a run in flight, whose checks these are", () => {
      const root = card(leftUnchecked(), { running: true });
      expect(find(root, "generate-draft-retry-check")).toBeNull();
    });
  });

  it("takes every word it shows from the catalog", async () => {
    const leave = await enterPseudoLocale();
    try {
      const root = card(
        checked(
          {
            issues: [{ path: "beats[0]", message: "is not a beat" }],
            findings: [finding(), finding({ avatar: null, to: 0.8 })],
            expression_names: {
              missing: ["cheekPuff"],
              avatar_only: ["Cheek_Blush"],
            },
          },
          { has_previous_version: true, saved_item_id: "item-9" },
        ),
        { selected: true },
      );
      await click(find(root, "generate-draft-remarks-toggle"));
      await click(find(root, "generate-draft-discard"));
      expect(
        unmarkedText(document.body, [
          "Shy Wave",
          "Andrew",
          "cheekPuff",
          "Cheek_Blush",
          // The validator's own text is shown as detail.
          "beats[0]",
          "is not a beat",
        ]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });
});
