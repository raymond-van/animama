// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import {
  GenerateDraftCard,
  type GenerateDraftCardProps,
} from "./GenerateDraftCard";
import {
  effectGestureProject,
  generationDraft,
  reactionProject,
} from "./testing/generationFixtures";
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

  it("says a draft's kind, and where a Reaction suggests it fits", () => {
    const gesture = card(generationDraft({ status: "ready" }));
    const kind = find(gesture, "generate-draft-kind")!;
    expect([kind.textContent, kind.dataset.intent]).toEqual([
      "Gesture",
      "gesture",
    ]);
    mounted?.unmount();

    const reaction = generationDraft({
      status: "ready",
      intent: "reaction",
      project: reactionProject(),
    });
    const root = card(reaction);
    expect(find(root, "generate-draft-kind")!.textContent).toBe(
      "Reaction · Joy · Moderate",
    );
    // A Reaction opens in the Reaction creator, and saves like any draft.
    const open = find(root, "generate-draft-open")!;
    expect(open.getAttribute("href")).toBe("/reactions/new");
    expect(JSON.parse(open.dataset.search!)).toEqual({
      draft: reaction.id,
      conversation: reaction.conversation_id,
    });
    expect(find(root, "generate-draft-save")!.textContent).toBe("Save");
    mounted?.unmount();

    const unplaced = card(
      generationDraft({
        status: "ready",
        intent: "reaction",
        project: reactionProject({ suggestedEmotion: "" }),
      }),
    );
    expect(find(unplaced, "generate-draft-kind")!.textContent).toBe("Reaction");
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

  describe("of a batch item", () => {
    const planned = () => generationDraft({ status: "writing", project: null });
    const item = (
      overrides: Partial<NonNullable<GenerateDraftCardProps["batch"]>> = {},
    ) => ({
      brief: "A shy little wave",
      step: null,
      failure: null,
      ...overrides,
    });

    it("shows what was planned as soon as it is planned, waiting for its turn", () => {
      const root = card(planned(), {
        running: true,
        batch: item({ step: "waiting" }),
      });
      expect(find(root, "generate-draft-brief")!.textContent).toBe(
        "A shy little wave",
      );
      expect(find(root, "generate-draft-kind")!.textContent).toBe("Gesture");
      const status = find(root, "generate-draft-status")!;
      expect(status.textContent).toBe("Waiting for its turn…");
      expect(status.dataset.step).toBe("waiting");
      // The stored status is unchanged, and nothing spins for a waiting item.
      expect(status.dataset.status).toBe("writing");
      expect(status.querySelector(".animate-spin")).toBeNull();
    });

    it.each([
      ["thinking", "Thinking…"],
      ["writing", "Writing…"],
      ["checking", "Checking…"],
      ["repairing", "Repairing…"],
      ["reviewing_frames", "Reviewing frames…"],
    ] as const)("says its own step while the run is %s it", (step, text) => {
      const root = card(planned(), { running: true, batch: item({ step }) });
      const status = find(root, "generate-draft-status")!;
      expect(status.textContent).toBe(text);
      expect(status.dataset.step).toBe(step);
      expect(status.querySelector(".animate-spin")).not.toBeNull();
    });

    it("reads as any other draft once the run has finished with it, keeping its brief", () => {
      const root = card(generationDraft({ status: "ready" }), {
        batch: item(),
      });
      const status = find(root, "generate-draft-status")!;
      expect(status.textContent).toBe("Ready");
      expect(status.dataset.step).toBeUndefined();
      expect(find(root, "generate-draft-brief")!.textContent).toBe(
        "A shy little wave",
      );
    });

    it("shows no brief for a draft that no batch planned, or a plan without one", () => {
      expect(find(card(generationDraft()), "generate-draft-brief")).toBeNull();
      mounted!.unmount();
      expect(
        find(
          card(generationDraft(), { batch: item({ brief: "" }) }),
          "generate-draft-brief",
        ),
      ).toBeNull();
    });

    it("says why its item failed, once, in the words a failed run uses", () => {
      const root = card(
        generationDraft({
          status: "failed",
          project: null,
          failure_reason: "openai_connection_error",
        }),
        {
          batch: item({
            failure: {
              code: "openai_connection_error",
              category: "connection",
              details: { connection_name: "My Ollama" },
            },
          }),
        },
      );
      // The run's failure names the connection; the stored code alone cannot.
      expect(find(root, "generate-draft-failure")!.textContent).toBe(
        "Animama couldn't reach My Ollama.",
      );
      expect(find(root, "generate-draft-item-failed")).toBeNull();
      expect(root.textContent).not.toContain("openai_connection_error");
    });

    it("words a failed item after a reload, from the stored code alone", () => {
      const root = card(
        generationDraft({
          status: "failed",
          project: null,
          failure_reason: "chatgpt_plan_usage_limit",
        }),
        {
          batch: item({
            failure: {
              code: "chatgpt_plan_usage_limit",
              category: "rate_limited",
              details: {},
            },
          }),
        },
      );
      expect(find(root, "generate-draft-failure")!.textContent).toBe(
        "You've reached your ChatGPT plan's usage limit.",
      );
      expect(root.textContent).not.toContain("chatgpt_plan_usage_limit");
    });

    it("says that an item with a version that loads was not finished, and why", () => {
      const root = card(checked({}, { status: "warnings" }), {
        batch: item({
          failure: {
            code: "chatgpt_plan_usage_limit",
            category: "rate_limited",
            details: {},
          },
        }),
      });
      expect(find(root, "generate-draft-item-failed")!.textContent).toBe(
        "The assistant could not finish this draft.You've reached your ChatGPT plan's usage limit.",
      );
      // The version it has can still be saved.
      expect(find(root, "generate-draft-save")).not.toBeNull();
      expect(find(root, "generate-draft-failure")).toBeNull();
    });
  });

  it("never shows a model error's code for a failed draft", () => {
    const root = card(
      generationDraft({
        status: "failed",
        project: null,
        failure_reason: "provider_melted",
      }),
    );
    expect(find(root, "generate-draft-failure")!.textContent).toBe(
      "The assistant ran into an unexpected problem. Try again.",
    );
    expect(root.textContent).not.toContain("provider_melted");
  });

  describe("marked for saving with others", () => {
    it("offers a named mark on a draft that loads, where the list asks for one", async () => {
      const onMarkedChange = vi.fn();
      const root = card(generationDraft({ status: "ready" }), {
        onMarkedChange,
      });
      const mark = find(root, "generate-draft-mark")!;
      expect(mark.getAttribute("role")).toBe("checkbox");
      expect(mark.getAttribute("aria-label")).toBe(
        "Mark “Shy Wave” for saving",
      );
      expect(mark.getAttribute("aria-checked")).toBe("false");
      await click(mark);
      expect(onMarkedChange).toHaveBeenCalledWith(true);

      mounted!.unmount();
      const marked = card(generationDraft({ status: "ready" }), {
        onMarkedChange,
        marked: true,
      });
      expect(
        find(marked, "generate-draft-mark")!.getAttribute("aria-checked"),
      ).toBe("true");
      await click(find(marked, "generate-draft-mark"));
      expect(onMarkedChange).toHaveBeenLastCalledWith(false);
    });

    it("offers none without the list's choice, or on a draft that cannot be saved", () => {
      expect(
        find(card(generationDraft({ status: "ready" })), "generate-draft-mark"),
      ).toBeNull();
      mounted!.unmount();
      expect(
        find(
          card(generationDraft({ status: "failed", project: null }), {
            onMarkedChange: vi.fn(),
          }),
          "generate-draft-mark",
        ),
      ).toBeNull();
    });

    it("says on the card why its save failed", () => {
      const root = card(generationDraft({ status: "ready" }), {
        saveFailure: "The name is already in use.",
      });
      const failed = find(root, "generate-draft-save-failed")!;
      expect(failed.getAttribute("role")).toBe("alert");
      expect(failed.textContent).toBe("The name is already in use.");
      // Save stays where it was, to try again.
      expect(find(root, "generate-draft-save")).not.toBeNull();
    });
  });

  it("takes every word of a batch item from the catalog", async () => {
    const leave = await enterPseudoLocale();
    try {
      card(checked({}, { status: "warnings" }), {
        running: true,
        onMarkedChange: vi.fn(),
        batch: {
          brief: "A shy little wave",
          step: "waiting",
          failure: {
            code: "generation_run_failed",
            category: "internal",
            details: {},
          },
        },
      });
      expect(
        unmarkedText(document.body, ["Shy Wave", "A shy little wave"]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });

  describe("with effects on its timeline (R7.3)", () => {
    const sparkling = generationDraft({
      status: "ready",
      project: effectGestureProject(),
    });

    it("shows nothing of effects for a draft that plays none", () => {
      const root = card(generationDraft({ status: "ready" }));
      expect(find(root, "generate-draft-effects")).toBeNull();
      expect(find(root, "generate-draft-missing-effects")).toBeNull();
    });

    it("says which effects the draft plays, by their aliases", () => {
      const root = card(sparkling, {
        effects: { aliases: ["sparkle"], missing: [] },
      });
      const effects = find(root, "generate-draft-effects")!;
      expect(effects.textContent).toBe("Plays 1 effect: sparkle");
      expect(effects.dataset.count).toBe("1");
      expect(find(root, "generate-draft-missing-effects")).toBeNull();
      // Nothing stands in the way of Save.
      const save = find(root, "generate-draft-save") as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      expect(save.hasAttribute("aria-describedby")).toBe(false);
      mounted!.unmount();

      const several = card(sparkling, {
        effects: { aliases: ["backdrop", "rain", "sparkle"], missing: [] },
      });
      expect(find(several, "generate-draft-effects")!.textContent).toBe(
        "Plays 3 effects: backdrop, rain, and sparkle",
      );
    });

    it("names an effect that is gone from the Library, and holds Save with the reason", async () => {
      const root = card(sparkling, {
        effects: { aliases: ["rain", "sparkle"], missing: ["sparkle"] },
        onMarkedChange: vi.fn(),
      });
      const missing = find(root, "generate-draft-missing-effects")!;
      expect(missing.textContent).toBe(
        "This draft plays an effect that is no longer in your Library: sparkle. Ask the assistant to revise the draft before you save it.",
      );
      const save = find(root, "generate-draft-save") as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      expect(save.title).toBe(
        "This draft cannot be saved until it is revised: an effect it plays is no longer in your Library.",
      );
      // The sentence on the card is the button's description.
      expect(save.getAttribute("aria-describedby")).toBe(missing.id);
      await click(save);
      expect(actions.onSave).not.toHaveBeenCalled();
      // It cannot be marked for saving with others either.
      expect(find(root, "generate-draft-mark")).toBeNull();
      // The creator can still open it, where the effect can be replaced by hand.
      expect(find(root, "generate-draft-open")).not.toBeNull();
      // What the draft plays is still said.
      expect(find(root, "generate-draft-effects")!.textContent).toBe(
        "Plays 2 effects: rain and sparkle",
      );
      mounted!.unmount();

      const both = card(sparkling, {
        effects: {
          aliases: ["rain", "sparkle"],
          missing: ["rain", "sparkle"],
        },
      });
      expect(find(both, "generate-draft-missing-effects")!.textContent).toBe(
        "This draft plays effects that are no longer in your Library: rain and sparkle. Ask the assistant to revise the draft before you save it.",
      );
    });

    it("says that the assistant has to finish first while a run is in flight", () => {
      const root = card(sparkling, {
        running: true,
        effects: { aliases: ["sparkle"], missing: ["sparkle"] },
      });
      expect(find(root, "generate-draft-save")!.title).toBe(
        "Available when the assistant has finished.",
      );
    });

    it("takes every word about effects from the catalog", async () => {
      const leave = await enterPseudoLocale();
      try {
        const root = card(sparkling, {
          effects: { aliases: ["rain", "sparkle"], missing: ["sparkle"] },
        });
        // An alias is the draft's own data, shown as written.
        expect(unmarkedText(root, ["Shy Wave", "rain", "sparkle"])).toEqual([]);
        expect(find(root, "generate-draft-save")!.title).toMatch(/^⟦.*⟧$/);
      } finally {
        await leave();
      }
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
