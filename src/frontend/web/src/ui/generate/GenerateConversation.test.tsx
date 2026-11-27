// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import {
  IDLE_GENERATION_RUN,
  type GenerationRunFailure,
  type GenerationRunState,
} from "@/stores/generation-store";
import { GenerateConversation } from "./GenerateConversation";
import {
  generationDraft,
  generationMessage,
  generationSnapshot,
} from "./testing/generationFixtures";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import type { GenerationRunController } from "./useGenerationRun";

let mounted: MountedInDocument | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const findAll = (testId: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

function controller(
  overrides: Partial<Omit<GenerationRunController, "run">> & {
    run?: Partial<GenerationRunState>;
  } = {},
): GenerationRunController {
  const { run, ...rest } = overrides;
  return {
    run: { ...IDLE_GENERATION_RUN, ...run },
    questions: null,
    send: vi.fn(async () => true),
    answer: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    stop: vi.fn(),
    dismissFailure: vi.fn(),
    ...rest,
  };
}

function conversation(
  control: GenerationRunController,
  options: {
    snapshot?: PyGenerationConversationSnapshot;
    selectedDraft?: PyGenerationDraft | null;
    onStartNewDraft?: () => void;
    onChooseModel?: () => void;
    framesStatus?: "idle" | "rendering" | "unavailable" | "failed";
    newDraftKind?: Parameters<typeof GenerateConversation>[0]["newDraftKind"];
    composerNote?: Parameters<typeof GenerateConversation>[0]["composerNote"];
  } = {},
) {
  const node = (
    <GenerateConversation
      snapshot={options.snapshot ?? generationSnapshot()}
      controller={control}
      selectedDraft={options.selectedDraft ?? null}
      onStartNewDraft={options.onStartNewDraft ?? (() => {})}
      onChooseModel={options.onChooseModel}
      framesStatus={options.framesStatus}
      newDraftKind={options.newDraftKind}
      composerNote={options.composerNote}
    />
  );
  if (mounted) mounted.rerender(node);
  else mounted = mountInDocument(node);
  return mounted.container;
}

/** Type into the request field as a person does. */
function type(text: string) {
  const field = find("generate-request") as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setValue.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field;
}

const failure = (
  overrides: Partial<GenerationRunFailure> = {},
): GenerationRunFailure => ({
  code: "generation_no_valid_draft",
  category: "generation",
  reason: null,
  details: {},
  status: null,
  network: false,
  request: { message: "a shy little wave", draftId: null, answers: null },
  ...overrides,
});

const asked = [
  { question: "Which hand?", options: ["Right", "Left"] },
  { question: "How big?", options: ["Small", "Large"] },
];
const questions = {
  questions: asked,
  request: { message: "a shy little wave", draftId: null },
};
const askedSnapshot = generationSnapshot({
  messages: [
    generationMessage(),
    generationMessage({
      id: "message-2",
      role: "assistant",
      text: "",
      data: { outcome: "questions", questions: asked },
    }),
  ],
});

describe("the conversation with the assistant", () => {
  it("invites a first request while the conversation is empty", () => {
    const root = conversation(controller());
    expect(root.textContent).toContain("Describe a Gesture");
    const field = find("generate-request") as HTMLTextAreaElement;
    expect(field.getAttribute("aria-label")).toBe("Request to the assistant");
    expect(field.placeholder).toBe("Describe a Gesture…");
    // Nothing to send yet.
    const send = find("generate-send") as HTMLButtonElement;
    expect(send.getAttribute("aria-label")).toBe("Send request");
    expect(send.disabled).toBe(true);
    expect(find("generate-stop")).toBeNull();
    expect(find("generate-progress")).toBeNull();
  });

  it("shows the stored turns, the assistant's as Markdown", () => {
    const root = conversation(controller(), {
      snapshot: generationSnapshot({
        messages: [
          generationMessage(),
          generationMessage({
            id: "message-2",
            role: "assistant",
            text: "Here is a **shy** wave.",
            data: { outcome: "draft", draft_id: "draft-1" },
          }),
        ],
      }),
    });
    expect(root.textContent).toContain("a shy little wave");
    expect(root.querySelector("strong, [data-streamdown='strong']")).not.toBe(
      null,
    );
    expect(root.textContent).not.toContain("**");
  });

  it("sends the request for the selected draft and empties the field", async () => {
    const control = controller();
    const draft = generationDraft({ status: "ready" });
    conversation(control, {
      snapshot: generationSnapshot({ drafts: [draft] }),
      selectedDraft: draft,
    });
    expect(find("generate-revision-target")!.textContent).toContain(
      "Your next message revises “Shy Wave”.",
    );
    const field = type("  make it friendlier ");
    await click(find("generate-send"));
    expect(control.send).toHaveBeenCalledWith("make it friendlier", {
      draftId: draft.id,
    });
    expect(field.value).toBe("");
  });

  it("writes a new draft once the person asks for one instead", async () => {
    const control = controller();
    const onStartNewDraft = vi.fn();
    const draft = generationDraft({ status: "ready" });
    const snapshot = generationSnapshot({ drafts: [draft] });
    conversation(control, { snapshot, selectedDraft: draft, onStartNewDraft });
    await click(find("generate-new-draft"));
    expect(onStartNewDraft).toHaveBeenCalledTimes(1);

    conversation(control, { snapshot, selectedDraft: null });
    expect(find("generate-revision-target")!.textContent).toBe(
      "Your next message writes a new draft.",
    );
    type("a bow");
    await click(find("generate-send"));
    expect(control.send).toHaveBeenCalledWith("a bow", { draftId: null });
  });

  it("offers a Gesture or a Reaction for a new draft, and sends the kind chosen", async () => {
    const control = controller();
    const onChange = vi.fn();
    conversation(control, { newDraftKind: { value: "gesture", onChange } });
    // No draft yet: the choice is there, the line about revising is not.
    expect(find("generate-revision-target")).toBeNull();
    const kind = find("generate-draft-kind")!;
    expect(kind.getAttribute("role")).toBe("group");
    expect(kind.getAttribute("aria-label")).toBe("Kind of new draft");
    expect(find("generate-kind-gesture")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(find("generate-kind-reaction")!.textContent).toBe("Reaction");
    await click(find("generate-kind-reaction"));
    expect(onChange).toHaveBeenCalledWith("reaction");

    conversation(control, { newDraftKind: { value: "reaction", onChange } });
    expect(find("generate-request")!.getAttribute("placeholder")).toBe(
      "Describe a Reaction…",
    );
    type("a soft smile");
    await click(find("generate-send"));
    expect(control.send).toHaveBeenCalledWith("a soft smile", {
      draftId: null,
      intent: "reaction",
    });
  });

  it("offers no kind while the next message revises a draft, which keeps its own", async () => {
    const control = controller();
    const draft = generationDraft({ status: "ready" });
    conversation(control, {
      snapshot: generationSnapshot({ drafts: [draft] }),
      selectedDraft: draft,
      newDraftKind: { value: "reaction", onChange: vi.fn() },
    });
    expect(find("generate-draft-kind")).toBeNull();
    type("friendlier");
    await click(find("generate-send"));
    expect(control.send).toHaveBeenCalledWith("friendlier", {
      draftId: draft.id,
    });
  });

  it("shows a creator's note in place of the line about drafts", () => {
    const draft = generationDraft({ status: "ready" });
    conversation(controller(), {
      snapshot: generationSnapshot({ drafts: [draft] }),
      composerNote: <p data-testid="creator-note">Changes the open item.</p>,
    });
    expect(find("creator-note")!.textContent).toBe("Changes the open item.");
    expect(find("generate-revision-target")).toBeNull();
    expect(find("generate-draft-kind")).toBeNull();
    expect(find("generate-request")!.getAttribute("placeholder")).toBe(
      "Say what to change…",
    );
  });

  it("never revises a draft that has no project, though it is selected", async () => {
    const control = controller();
    const failed = generationDraft({
      id: "draft-2",
      status: "failed",
      project: null,
      failure_reason: "generation_no_valid_draft",
    });
    conversation(control, {
      snapshot: generationSnapshot({ drafts: [failed] }),
      // The person picked its card to see why it failed.
      selectedDraft: failed,
    });
    expect(find("generate-revision-target")!.textContent).toBe(
      "Your next message writes a new draft.",
    );
    expect(find("generate-new-draft")).toBeNull();
    expect((find("generate-request") as HTMLTextAreaElement).placeholder).toBe(
      "Describe a Gesture…",
    );
    type("a shy little wave");
    await click(find("generate-send"));
    // The backend would refuse a revision of it (`generation_draft_empty`).
    expect(control.send).toHaveBeenCalledWith("a shy little wave", {
      draftId: null,
    });
  });

  it("puts a request the run did not take back into the field", async () => {
    const control = controller({ send: vi.fn(async () => false) });
    conversation(control);
    const field = type("a wave");
    await click(find("generate-send"));
    expect(field.value).toBe("a wave");
  });

  it("refuses a request longer than the assistant takes, and says so", () => {
    const control = controller();
    const root = conversation(control);
    type("x".repeat(4001));
    expect((find("generate-send") as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain(
      "Shorten your request to 4000 characters or fewer.",
    );
  });

  it.each([
    ["starting", "Starting…"],
    ["thinking", "Thinking…"],
    ["writing", "Writing the draft…"],
    ["checking", "Checking the draft…"],
    ["repairing", "Repairing what the checks found…"],
    ["reviewing_frames", "Looking at rendered frames…"],
  ] as const)("says in words that the run is %s", (phase, text) => {
    conversation(
      controller({
        run: {
          running: true,
          phase,
          pendingTurn: { message: "a wave", draftId: null, text: "" },
        },
      }),
    );
    const progress = find("generate-progress")!;
    expect(progress.getAttribute("role")).toBe("status");
    expect(progress.dataset.phase).toBe(phase);
    expect(progress.textContent).toBe(text);
  });

  it("offers Stop only while a run is in flight", async () => {
    const idle = controller();
    conversation(idle);
    type("a wave");
    expect(find("generate-stop")).toBeNull();
    expect(find("generate-send")).not.toBeNull();

    const running = controller({
      run: {
        running: true,
        phase: "writing",
        pendingTurn: { message: "a wave", draftId: null, text: "Working" },
      },
    });
    const root = conversation(running);
    expect(find("generate-send")).toBeNull();
    const stop = find("generate-stop") as HTMLButtonElement;
    expect(stop.getAttribute("aria-label")).toBe("Stop the assistant");
    expect(stop.disabled).toBe(false);
    // The run's own turn shows while it streams.
    expect(root.textContent).toContain("a wave");
    expect(root.textContent).toContain("Working");
    await click(stop);
    expect(running.stop).toHaveBeenCalledTimes(1);
    expect(running.send).not.toHaveBeenCalled();
  });

  it("says when the run goes on without review frames", () => {
    const root = conversation(
      controller({ run: { running: true, phase: "reviewing_frames" } }),
      { framesStatus: "unavailable" },
    );
    expect(root.textContent).toContain(
      "Frames could not be drawn, so the assistant continues without looking at them.",
    );
  });

  it("shows the assistant's questions as cards and sends the chosen answers", async () => {
    const control = controller({ questions });
    conversation(control, { snapshot: askedSnapshot });
    const options = findAll("generate-question-option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Right",
      "Left",
      "Small",
      "Large",
    ]);
    const submit = find("generate-questions-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await click(options[1]);
    expect(options[1]!.getAttribute("aria-pressed")).toBe("true");
    // Another option of the same question replaces the first choice.
    await click(options[0]);
    expect(options[1]!.getAttribute("aria-pressed")).toBe("false");
    await click(submit);
    // The unanswered question is left to the assistant.
    expect(control.answer).toHaveBeenCalledWith([
      { question: "Which hand?", answer: "Right" },
    ]);
  });

  it("skips the questions on Skip", async () => {
    const control = controller({ questions });
    conversation(control, { snapshot: askedSnapshot });
    await click(findAll("generate-question-option")[0]);
    await click(find("generate-questions-skip"));
    expect(control.answer).toHaveBeenCalledWith(null);
  });

  it("takes a typed answer where a question offers no options", async () => {
    const control = controller({
      questions: {
        ...questions,
        questions: [{ question: "What mood?", options: [] }],
      },
    });
    conversation(control);
    const field = find("generate-question-answer") as HTMLInputElement;
    expect(field.getAttribute("aria-label")).toBe("Answer to: What mood?");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setValue.call(field, " shy ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(find("generate-questions-submit"));
    expect(control.answer).toHaveBeenCalledWith([
      { question: "What mood?", answer: "shy" },
    ]);
  });

  it("words the assistant's own failure and offers a retry", async () => {
    const control = controller({ run: { failure: failure() } });
    const root = conversation(control, {
      snapshot: generationSnapshot({ messages: [generationMessage()] }),
    });
    const notice = find("generate-failure")!;
    expect(notice.dataset.code).toBe("generation_no_valid_draft");
    expect(notice.querySelector('[role="alert"]')!.textContent).toContain(
      "The assistant did not produce a draft that works. Try again, or describe it differently.",
    );
    // The conversation stays.
    expect(root.textContent).toContain("a shy little wave");
    expect(notice.textContent).toContain(
      "Your conversation and drafts are kept.",
    );
    await click(find("generate-retry"));
    expect(control.retry).toHaveBeenCalledTimes(1);
    await click(find("generate-failure-dismiss"));
    expect(control.dismissFailure).toHaveBeenCalledTimes(1);
  });

  describe("after a failed run that had already stored its draft", () => {
    const providerFailure = failure({
      code: "generation_run_failed",
      category: "internal",
      request: { message: "make it shy", draftId: "draft-1", answers: null },
    });
    const request = generationMessage({
      text: "make it shy",
      data: { draft_id: "draft-1" },
    });

    it("offers no Try again when a draft arrived in that run, only Dismiss", async () => {
      const control = controller({
        run: { failure: providerFailure, draftStored: true },
      });
      conversation(control, {
        snapshot: generationSnapshot({ messages: [request] }),
      });
      // The failure is still said in words.
      expect(find("generate-failure")!.textContent).toContain(
        "The assistant ran into an unexpected problem.",
      );
      // A second pass would overwrite what a restore returns to.
      expect(find("generate-retry")).toBeNull();
      await click(find("generate-failure-dismiss"));
      expect(control.dismissFailure).toHaveBeenCalledTimes(1);
    });

    const storedFailedTurn = generationMessage({
      id: "message-2",
      role: "assistant",
      text: "",
      data: {
        run_id: "run-1",
        outcome: "failed",
        draft_id: "draft-1",
        error: { code: "generation_run_failed" },
      },
    });

    it("offers no Try again when the failed turn that run stored names the draft", () => {
      // The stream was lost before the page saw the draft arrive.
      conversation(
        controller({ run: { failure: providerFailure, runId: "run-1" } }),
        {
          snapshot: generationSnapshot({
            messages: [request, storedFailedTurn],
          }),
        },
      );
      expect(find("generate-failure")).not.toBeNull();
      expect(find("generate-retry")).toBeNull();
      expect(find("generate-failure-dismiss")).not.toBeNull();
    });

    it("offers Try again for a request that never reached the backend, whatever the run before stored", () => {
      // The run before failed after storing its draft. This request then got
      // no answer at all: no stream event, so the last turn is not its own.
      const unreached = failure({
        code: "generation_request_failed",
        category: "request",
        network: true,
        request: { message: "now slower", draftId: "draft-1", answers: null },
      });
      conversation(controller({ run: { failure: unreached, runId: null } }), {
        snapshot: generationSnapshot({ messages: [request, storedFailedTurn] }),
      });
      expect(find("generate-failure")!.dataset.code).toBe(
        "generation_request_failed",
      );
      expect(find("generate-retry")).not.toBeNull();
    });

    it("still offers Try again when the run failed before storing a draft", () => {
      conversation(controller({ run: { failure: providerFailure } }), {
        snapshot: generationSnapshot({
          messages: [
            request,
            generationMessage({
              id: "message-2",
              role: "assistant",
              text: "",
              // The turn of a revision that stored nothing names no draft.
              data: {
                outcome: "failed",
                error: { code: "generation_run_failed" },
              },
            }),
          ],
        }),
      });
      expect(find("generate-retry")).not.toBeNull();
    });
  });

  describe("Choose another model, beside Try again", () => {
    const withFailure = (overrides: Partial<GenerationRunFailure>) => {
      const onChooseModel = vi.fn();
      conversation(controller({ run: { failure: failure(overrides) } }), {
        snapshot: generationSnapshot({ messages: [generationMessage()] }),
        onChooseModel,
      });
      return onChooseModel;
    };

    it("opens the model control after a model, plan or connection failure", async () => {
      const onChooseModel = withFailure({
        code: "openai_rate_limit",
        category: "rate_limited",
        details: { connection_name: "OpenAI" },
      });
      expect(find("generate-retry")).not.toBeNull();
      expect(find("generate-choose-model")!.textContent).toBe(
        "Choose another model",
      );
      await click(find("generate-choose-model"));
      expect(onChooseModel).toHaveBeenCalledTimes(1);
    });

    it("is offered when the model or its effort was refused, or it wrote no draft that works", () => {
      for (const overrides of [
        {
          code: "generation_model_unusable",
          category: "request",
          reason: "context_too_small",
          status: 422,
        },
        {
          code: "generation_reasoning_effort_unsupported",
          category: "request",
          status: 422,
        },
        { code: "generation_no_valid_draft" },
      ]) {
        withFailure(overrides);
        expect(find("generate-choose-model")).not.toBeNull();
        mounted!.unmount();
        mounted = null;
      }
    });

    it("is not offered for a failure another model would meet too", () => {
      for (const overrides of [
        { code: "generation_request_failed", category: "request" },
        { code: "generation_stream_interrupted", category: "request" },
        { code: "generation_run_in_progress", category: "request" },
        { code: "generation_run_failed", category: "internal" },
      ]) {
        withFailure(overrides);
        expect(find("generate-failure")).not.toBeNull();
        expect(find("generate-choose-model")).toBeNull();
        mounted!.unmount();
        mounted = null;
      }
    });

    it("words a refused effort and the new refusals of a model", () => {
      const worded = (overrides: Partial<GenerationRunFailure>) => {
        withFailure(overrides);
        const text =
          find("generate-failure")!.querySelector(
            '[role="alert"]',
          )!.textContent;
        mounted!.unmount();
        mounted = null;
        return text;
      };
      expect(
        worded({
          code: "generation_reasoning_effort_unsupported",
          category: "request",
          status: 422,
        }),
      ).toContain(
        "The chosen model cannot run the assistant at this reasoning effort. Choose another level or another model.",
      );
      const refused = (reason: string) =>
        worded({
          code: "generation_model_unusable",
          category: "request",
          reason,
          status: 422,
        });
      expect(refused("context_too_small")).toContain(
        "The chosen model's context window is too small for the assistant.",
      );
      expect(refused("context_window_missing")).toContain(
        "The chosen model has no context window set.",
      );
      expect(refused("streaming_unsupported")).toContain(
        "The chosen model cannot stream its replies, which the assistant needs.",
      );
    });
  });

  it("words a model failure as chat does, beside the request that failed", () => {
    const control = controller({
      run: {
        failure: failure({
          code: "chatgpt_plan_usage_limit",
          category: "rate_limited",
          details: { connection_name: "ChatGPT plan" },
        }),
      },
    });
    const root = conversation(control, {
      snapshot: generationSnapshot({
        messages: [
          generationMessage(),
          generationMessage({
            id: "message-2",
            role: "assistant",
            text: "",
            data: {
              outcome: "failed",
              error: { code: "chatgpt_plan_usage_limit" },
            },
          }),
        ],
      }),
    });
    // Static text escapes nothing here, so the apostrophes match.
    expect(root.textContent).toContain(
      "You've reached your ChatGPT plan's usage limit.",
    );
    const link = root.querySelector(
      'a[href="https://chatgpt.com/settings/usage"]',
    );
    expect(link?.textContent).toBe("Manage usage");
    // Chat's notice is the alert; the page adds only its actions.
    expect(
      find("generate-failure")!.querySelector('[role="alert"]'),
    ).toBeNull();
    expect(find("generate-retry")).not.toBeNull();
    // The stored failed turn does not say so a second time.
    expect(root.textContent).not.toContain(
      "The assistant could not finish this request.",
    );
  });

  it("falls back to its own notice when the failed request is not in the transcript", () => {
    conversation(
      controller({
        run: {
          failure: failure({
            code: "chatgpt_plan_usage_limit",
            category: "rate_limited",
            details: {},
          }),
        },
      }),
    );
    expect(
      find("generate-failure")!.querySelector('[role="alert"]')!.textContent,
    ).toBe("The assistant could not finish this request.");
  });

  it("after a failed answering run shows the failure and the question cards again", async () => {
    const answers = {
      answers: [{ question: "Which hand?", answer: "Left" }],
    };
    const control = controller({
      questions,
      run: {
        failure: failure({
          code: "generation_run_failed",
          category: "internal",
          request: { ...questions.request, answers },
        }),
      },
    });
    const root = conversation(control, {
      snapshot: generationSnapshot({
        messages: [
          ...askedSnapshot.messages,
          generationMessage({ id: "message-3", data: { answers } }),
          generationMessage({
            id: "message-4",
            role: "assistant",
            text: "",
            data: {
              outcome: "failed",
              error: { code: "generation_run_failed" },
            },
          }),
        ],
      }),
    });
    expect(find("generate-failure")!.textContent).toContain(
      "The assistant ran into an unexpected problem. Try again.",
    );
    // The answering turn reads as its answers, not as the request again.
    expect(root.textContent).toContain("Which hand? — Left");
    // Answering the cards is the retry, with new answers.
    expect(findAll("generate-question-option")).toHaveLength(4);
    await click(findAll("generate-question-option")[0]);
    await click(find("generate-questions-submit"));
    expect(control.answer).toHaveBeenCalledWith([
      { question: "Which hand?", answer: "Right" },
    ]);
    // The failure's own button sends the same answers again.
    await click(find("generate-retry"));
    expect(control.retry).toHaveBeenCalledTimes(1);
  });

  it("keeps how earlier runs ended in the transcript after a reload", () => {
    const root = conversation(controller(), {
      snapshot: generationSnapshot({
        messages: [
          generationMessage(),
          generationMessage({
            id: "message-2",
            role: "assistant",
            text: "",
            data: { outcome: "questions", questions: asked },
          }),
          generationMessage({
            id: "message-3",
            data: { answers: { skipped: true } },
          }),
          generationMessage({
            id: "message-4",
            role: "assistant",
            text: "",
            data: { outcome: "stopped", draft_id: "draft-1" },
          }),
          generationMessage({ id: "message-5", text: "try again" }),
          generationMessage({
            id: "message-6",
            role: "assistant",
            text: "",
            data: {
              outcome: "failed",
              error: { code: "generation_no_valid_draft" },
              draft_id: "draft-1",
            },
          }),
        ],
      }),
    });
    const text = root.textContent!;
    // Answered questions stay readable; nothing waits, so no cards.
    expect(text).toContain("Which hand?");
    expect(find("generate-questions")).toBeNull();
    expect(text).toContain("Skipped the questions.");
    expect(text).toContain("Stopped. Drafts finished so far are kept.");
    expect(text).toContain("The assistant did not produce a draft that works.");
    // No failure notice: that belongs to a run of this session.
    expect(find("generate-failure")).toBeNull();
  });

  it("does not repeat the request while a run answers the questions", () => {
    const root = conversation(
      controller({
        run: {
          running: true,
          phase: "thinking",
          pendingTurn: {
            message: "a shy little wave",
            draftId: null,
            text: "",
          },
        },
      }),
      { snapshot: askedSnapshot },
    );
    expect(root.textContent!.split("a shy little wave")).toHaveLength(2);
    // The questions it answers stay readable, without their cards.
    expect(root.textContent).toContain("Which hand?");
    expect(find("generate-questions")).toBeNull();
  });

  it("shows a new message sent instead of answering as itself", () => {
    const root = conversation(controller(), {
      snapshot: generationSnapshot({
        messages: [
          ...askedSnapshot.messages,
          // Sent from the request field: the questions count as skipped.
          generationMessage({
            id: "message-3",
            text: "never mind, a bow instead",
            data: { answers: { skipped: true } },
          }),
          generationMessage({
            id: "message-4",
            role: "assistant",
            text: "Here is a bow.",
            data: { outcome: "draft", draft_id: "draft-1" },
          }),
        ],
      }),
    });
    expect(root.textContent).toContain("never mind, a bow instead");
    expect(root.textContent).not.toContain("Skipped the questions.");
  });

  it("says the last run was stopped until its turn is stored", () => {
    conversation(controller({ run: { stopped: true } }), {
      snapshot: generationSnapshot({ messages: [generationMessage()] }),
    });
    expect(find("generate-stopped")!.textContent).toBe(
      "Stopped. Drafts finished so far are kept.",
    );
  });

  it("says when the conversation is loading or could not be read", async () => {
    const onReload = vi.fn();
    mounted = mountInDocument(
      <GenerateConversation
        snapshot={undefined}
        isLoading
        controller={controller()}
        selectedDraft={null}
        onStartNewDraft={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain(
      "Loading the conversation…",
    );
    // Nothing can be sent into a conversation that is not open.
    type("a wave");
    expect((find("generate-send") as HTMLButtonElement).disabled).toBe(true);

    mounted.rerender(
      <GenerateConversation
        snapshot={undefined}
        loadFailed
        onReload={onReload}
        controller={controller()}
        selectedDraft={null}
        onStartNewDraft={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain(
      "This conversation could not be loaded.",
    );
    await click(
      [...mounted.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Try again",
      ),
    );
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("takes every word it shows from the catalogs", async () => {
    const leave = await enterPseudoLocale();
    const data = [
      "a shy little wave",
      "Shy Wave",
      "Which hand?",
      "How big?",
      "Right",
      "Left",
      "Small",
      "Large",
      "Working on it",
    ];
    try {
      const draft = generationDraft({ status: "ready" });
      // A run in flight, with a draft selected.
      conversation(
        controller({
          run: {
            running: true,
            phase: "checking",
            pendingTurn: {
              message: "a shy little wave",
              draftId: draft.id,
              text: "Working on it",
            },
          },
        }),
        {
          snapshot: generationSnapshot({ drafts: [draft] }),
          selectedDraft: draft,
          framesStatus: "failed",
        },
      );
      expect(unmarkedText(document.body, data)).toEqual([]);

      // Questions waiting, after a failed and a stopped run.
      conversation(
        controller({
          questions,
          run: { failure: failure(), stopped: true },
        }),
        {
          snapshot: generationSnapshot({
            drafts: [draft],
            messages: [
              ...askedSnapshot.messages,
              generationMessage({
                id: "message-3",
                data: { answers: { skipped: true } },
              }),
              generationMessage({
                id: "message-4",
                role: "assistant",
                text: "",
                data: { outcome: "stopped" },
              }),
            ],
          }),
        },
      );
      expect(unmarkedText(document.body, data)).toEqual([]);
      mounted!.unmount();
      mounted = null;

      // The empty conversation.
      conversation(controller());
      expect(unmarkedText(document.body, data)).toEqual([]);
    } finally {
      await leave();
    }
  });
});
