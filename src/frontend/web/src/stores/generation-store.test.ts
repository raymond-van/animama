import { afterEach, describe, expect, it } from "vitest";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { generationDraft } from "@/ui/generate/testing/generationFixtures";
import {
  IDLE_GENERATION_RUN,
  applyGenerationRunEvent,
  beginGenerationRun,
  clearGenerationFramesRequest,
  clearGenerationPendingTurn,
  dismissGenerationFailure,
  endGenerationRun,
  forgetGenerationRun,
  forgetGenerationRunDraft,
  generationRunDraftIds,
  generationRunWorkingDraftIds,
  generationRunState,
  reduceGenerationRunEvent,
  useGenerationStore,
  type GenerationRunFailure,
  type GenerationRunRequest,
  type GenerationRunState,
} from "./generation-store";

const REQUEST: GenerationRunRequest = {
  message: "a shy wave",
  draftId: null,
  answers: null,
};
const FAILURE: GenerationRunFailure = {
  code: "generation_request_failed",
  category: "request",
  reason: null,
  details: {},
  status: null,
  network: true,
  request: REQUEST,
};

afterEach(() => useGenerationStore.setState({ runs: {} }));

describe("a conversation's run state", () => {
  it("is idle until a run starts", () => {
    expect(generationRunState("conversation-1")).toBe(IDLE_GENERATION_RUN);
  });

  it("starts one run at a time and shows the person's turn at once", () => {
    expect(beginGenerationRun("conversation-1", REQUEST)).toBe(true);
    expect(generationRunState("conversation-1")).toMatchObject({
      running: true,
      phase: "starting",
      pendingTurn: { message: "a shy wave", draftId: null, text: "" },
    });
    expect(
      beginGenerationRun("conversation-1", { ...REQUEST, message: "a bow" }),
    ).toBe(false);
    expect(generationRunState("conversation-1").pendingTurn?.message).toBe(
      "a shy wave",
    );
    // Another conversation runs independently.
    expect(beginGenerationRun("conversation-2", REQUEST)).toBe(true);
  });

  it("clears what the last run left when the next one starts", () => {
    beginGenerationRun("conversation-1", REQUEST);
    applyGenerationRunEvent(
      "conversation-1",
      {
        type: "questions",
        questions: [{ question: "Which hand?", options: ["Right", "Left"] }],
      },
      REQUEST,
    );
    applyGenerationRunEvent(
      "conversation-1",
      {
        type: "run.completed",
        usage: {
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          requests: 1,
        },
      },
      REQUEST,
    );
    endGenerationRun("conversation-1", { failure: FAILURE });
    expect(generationRunState("conversation-1")).toMatchObject({
      running: false,
      failure: FAILURE,
      questions: { request: { message: "a shy wave", draftId: null } },
    });

    beginGenerationRun("conversation-1", REQUEST);
    expect(generationRunState("conversation-1")).toMatchObject({
      running: true,
      failure: null,
      questions: null,
      stopped: false,
      // The last run's token use is not shown as this run's.
      usage: null,
    });
  });

  it("ends a run, keeping a failure its stream reported", () => {
    beginGenerationRun("conversation-1", REQUEST);
    applyGenerationRunEvent(
      "conversation-1",
      {
        type: "run.failed",
        code: "openai_rate_limit",
        category: "rate_limited",
        details: { connection_name: "OpenAI" },
      },
      REQUEST,
    );
    applyGenerationRunEvent(
      "conversation-1",
      { type: "frames.requested", draftId: "draft-1", version: 2 },
      REQUEST,
    );
    endGenerationRun("conversation-1");
    expect(generationRunState("conversation-1")).toMatchObject({
      running: false,
      phase: null,
      framesRequests: [],
      stopped: false,
      failure: { code: "openai_rate_limit", request: REQUEST },
    });

    dismissGenerationFailure("conversation-1");
    expect(generationRunState("conversation-1").failure).toBeNull();
  });

  it("marks a stopped run and drops its turn once the conversation is read", () => {
    beginGenerationRun("conversation-1", REQUEST);
    // The turn of a run in flight is never dropped.
    clearGenerationPendingTurn("conversation-1");
    expect(generationRunState("conversation-1").pendingTurn).not.toBeNull();

    endGenerationRun("conversation-1", { stopped: true });
    expect(generationRunState("conversation-1")).toMatchObject({
      stopped: true,
      failure: null,
    });
    clearGenerationPendingTurn("conversation-1");
    expect(generationRunState("conversation-1").pendingTurn).toBeNull();
  });

  it("forgets only the request for sheets that was answered", () => {
    beginGenerationRun("conversation-1", REQUEST);
    applyGenerationRunEvent(
      "conversation-1",
      { type: "frames.requested", draftId: "draft-1", version: 2 },
      REQUEST,
    );
    clearGenerationFramesRequest("conversation-1", {
      draftId: "draft-1",
      version: 1,
    });
    expect(generationRunState("conversation-1").framesRequests).toEqual([
      { draftId: "draft-1", version: 2 },
    ]);
    clearGenerationFramesRequest("conversation-1", {
      draftId: "draft-1",
      version: 2,
    });
    expect(generationRunState("conversation-1").framesRequests).toEqual([]);
  });

  it("is forgotten with its conversation and with the session", () => {
    beginGenerationRun("conversation-1", REQUEST);
    beginGenerationRun("conversation-2", REQUEST);
    forgetGenerationRun("conversation-1");
    expect(Object.keys(useGenerationStore.getState().runs)).toEqual([
      "conversation-2",
    ]);
    for (const reset of privateStateResets()) reset();
    expect(useGenerationStore.getState().runs).toEqual({});
  });
});

describe("the drafts a run is working on", () => {
  const working = (run: Partial<GenerationRunState>) => [
    ...generationRunDraftIds({ ...IDLE_GENERATION_RUN, ...run }),
  ];

  it("is the draft the request revises, from the moment the run starts", () => {
    beginGenerationRun("conversation-1", { ...REQUEST, draftId: "draft-1" });
    expect([
      ...generationRunDraftIds(generationRunState("conversation-1")),
    ]).toEqual(["draft-1"]);
  });

  it("adds the draft the run's current step names", () => {
    // A new draft, named once it is written.
    expect(
      working({
        running: true,
        phaseDraftId: "draft-2",
        pendingTurn: { message: "a bow", draftId: null, text: "" },
      }),
    ).toEqual(["draft-2"]);
    expect(
      working({
        running: true,
        phaseDraftId: "draft-2",
        pendingTurn: { message: "a bow", draftId: "draft-1", text: "" },
      }).sort(),
    ).toEqual(["draft-1", "draft-2"]);
  });

  it("is none before a run names a draft, and none once it has ended", () => {
    expect(
      working({
        running: true,
        pendingTurn: { message: "a bow", draftId: null, text: "" },
      }),
    ).toEqual([]);
    // What the last run left does not hold a draft.
    expect(
      working({
        running: false,
        phaseDraftId: "draft-2",
        pendingTurn: { message: "a bow", draftId: "draft-1", text: "" },
      }),
    ).toEqual([]);
    expect(working({})).toEqual([]);
  });
});

describe("reduceGenerationRunEvent", () => {
  const running = {
    ...IDLE_GENERATION_RUN,
    running: true,
    pendingTurn: { message: "a shy wave", draftId: null, text: "" },
  };

  it("keeps the last known step when a step is not known", () => {
    const checking = reduceGenerationRunEvent(
      running,
      { type: "progress", phase: "checking", draftId: "draft-1" },
      REQUEST,
    );
    expect(checking).toMatchObject({
      phase: "checking",
      phaseDraftId: "draft-1",
    });
    expect(
      reduceGenerationRunEvent(
        checking,
        { type: "progress", phase: null, draftId: null },
        REQUEST,
      ),
    ).toBe(checking);
  });

  it("adds the assistant's text in order", () => {
    const text = ["A shy", " wave", "."].reduce<GenerationRunState>(
      (run, piece) =>
        reduceGenerationRunEvent(
          run,
          { type: "message.delta", text: piece },
          REQUEST,
        ),
      running,
    );
    expect(text.pendingTurn?.text).toBe("A shy wave.");
  });

  it("ignores an empty set of questions", () => {
    expect(
      reduceGenerationRunEvent(
        running,
        { type: "questions", questions: [] },
        REQUEST,
      ),
    ).toBe(running);
  });

  it("keeps a request for sheets until its draft moves on", () => {
    const waiting = reduceGenerationRunEvent(
      running,
      { type: "frames.requested", draftId: "draft-1", version: 2 },
      REQUEST,
    );
    const update = (overrides: Parameters<typeof generationDraft>[0]) =>
      reduceGenerationRunEvent(
        waiting,
        { type: "draft.updated", draft: generationDraft(overrides) },
        REQUEST,
      ).framesRequests;
    const asked = [{ draftId: "draft-1", version: 2 }];

    // Another draft, or the same version still waiting, changes nothing.
    expect(update({ id: "draft-2", version: 2, status: "ready" })).toEqual(
      asked,
    );
    expect(update({ version: 2, status: "checking" })).toEqual(asked);
    expect(update({ version: 2, status: "reviewing" })).toEqual([]);
    expect(update({ version: 2, status: "warnings" })).toEqual([]);
    expect(update({ version: 3, status: "checking" })).toEqual([]);
  });

  it("remembers that the run stored a draft, until the next run starts", () => {
    expect(running.draftStored).toBe(false);
    const stored = reduceGenerationRunEvent(
      running,
      { type: "draft.updated", draft: generationDraft() },
      REQUEST,
    );
    expect(stored.draftStored).toBe(true);
    // A failure after that does not forget it: a retry would write it twice.
    const failed = reduceGenerationRunEvent(
      stored,
      {
        type: "run.failed",
        code: "provider_error",
        category: null,
        details: {},
      },
      REQUEST,
    );
    expect(failed).toMatchObject({
      draftStored: true,
      failure: { code: "provider_error" },
    });

    useGenerationStore.setState({ runs: { "conversation-1": failed } });
    endGenerationRun("conversation-1");
    expect(generationRunState("conversation-1").draftStored).toBe(true);
    beginGenerationRun("conversation-1", REQUEST);
    expect(generationRunState("conversation-1").draftStored).toBe(false);
  });

  it("records the run's token use, or none when the final frame names none", () => {
    const usage = {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      requests: 1,
    };
    expect(
      reduceGenerationRunEvent(
        running,
        { type: "run.completed", usage },
        REQUEST,
      ).usage,
    ).toBe(usage);
    expect(
      reduceGenerationRunEvent(
        running,
        { type: "run.completed", usage: null },
        REQUEST,
      ).usage,
    ).toBeNull();
  });
});

describe("a batch's run state", () => {
  const ITEMS = [
    { draftId: "draft-1", intent: "gesture", brief: "A shy wave", error: null },
    { draftId: "draft-2", intent: "gesture", brief: "A deep bow", error: null },
    { draftId: "draft-3", intent: "reaction", brief: "A grin", error: null },
  ] as const;
  const event = (next: Parameters<typeof reduceGenerationRunEvent>[1]) =>
    applyGenerationRunEvent("conversation-1", next, REQUEST);
  const run = () => generationRunState("conversation-1");
  const planned = () => {
    beginGenerationRun("conversation-1", REQUEST);
    event({ type: "batch.planned", items: [...ITEMS] });
  };

  it("has no batch and no per-draft step for a run that writes one draft", () => {
    beginGenerationRun("conversation-1", REQUEST);
    expect(run()).toMatchObject({
      batch: null,
      draftPhases: {},
      itemFailures: {},
      framesRequests: [],
    });
    // A single draft's step is the run's one step, as before.
    event({ type: "progress", phase: "checking", draftId: "draft-1" });
    expect(run()).toMatchObject({
      batch: null,
      phase: "checking",
      phaseDraftId: "draft-1",
      draftPhases: { "draft-1": "checking" },
    });
  });

  it("keeps the planned items in order, each waiting until its own step arrives", () => {
    planned();
    expect(run().batch).toEqual(ITEMS);
    expect(run().draftPhases).toEqual({});

    event({ type: "progress", phase: "writing", draftId: "draft-1" });
    event({ type: "progress", phase: "thinking", draftId: "draft-2" });
    event({ type: "progress", phase: "checking", draftId: "draft-1" });
    // Two items are in flight, each at its own step; the third still waits.
    expect(run().draftPhases).toEqual({
      "draft-1": "checking",
      "draft-2": "thinking",
    });
  });

  it("ends an item's step when its draft settles, leaving the others", () => {
    planned();
    event({ type: "progress", phase: "checking", draftId: "draft-1" });
    event({ type: "progress", phase: "writing", draftId: "draft-2" });
    event({
      type: "draft.updated",
      draft: generationDraft({ id: "draft-1", status: "checking" }),
    });
    expect(Object.keys(run().draftPhases)).toEqual(["draft-1", "draft-2"]);
    event({
      type: "draft.updated",
      draft: generationDraft({ id: "draft-1", status: "warnings" }),
    });
    expect(run().draftPhases).toEqual({ "draft-2": "writing" });
  });

  it("records one item's failure and goes on with the others", () => {
    planned();
    event({ type: "progress", phase: "writing", draftId: "draft-1" });
    event({ type: "progress", phase: "repairing", draftId: "draft-2" });
    event({ type: "frames.requested", draftId: "draft-2", version: 1 });
    event({
      type: "item.failed",
      draftId: "draft-2",
      code: "openai_rate_limit",
      category: "rate_limited",
      details: { connection_name: "OpenAI" },
    });
    expect(run()).toMatchObject({
      running: true,
      // The run itself did not fail.
      failure: null,
      itemFailures: {
        "draft-2": {
          code: "openai_rate_limit",
          category: "rate_limited",
          details: { connection_name: "OpenAI" },
        },
      },
      draftPhases: { "draft-1": "writing" },
      // Nothing is drawn for an item that failed.
      framesRequests: [],
    });
  });

  it("adds every item's note to the run's one reply, in arrival order", () => {
    planned();
    event({ type: "message.delta", text: "Three drafts. " });
    event({ type: "message.delta", text: "A wave. ", draftId: "draft-1" });
    event({ type: "message.delta", text: "A bow.", draftId: "draft-2" });
    expect(run().pendingTurn?.text).toBe("Three drafts. A wave. A bow.");
  });

  it("holds a request for sheets per draft, two at once, and answers each alone", () => {
    planned();
    event({ type: "frames.requested", draftId: "draft-1", version: 1 });
    event({ type: "frames.requested", draftId: "draft-2", version: 3 });
    expect(run().framesRequests).toEqual([
      { draftId: "draft-1", version: 1 },
      { draftId: "draft-2", version: 3 },
    ]);
    // One draft moving on leaves the other's request standing.
    event({
      type: "draft.updated",
      draft: generationDraft({ id: "draft-1", status: "reviewing" }),
    });
    expect(run().framesRequests).toEqual([{ draftId: "draft-2", version: 3 }]);
    // A draft has one request outstanding: a newer one takes its place.
    event({ type: "frames.requested", draftId: "draft-2", version: 4 });
    expect(run().framesRequests).toEqual([{ draftId: "draft-2", version: 4 }]);
    clearGenerationFramesRequest("conversation-1", {
      draftId: "draft-2",
      version: 4,
    });
    expect(run().framesRequests).toEqual([]);
  });

  it("keeps the plan and the failures for the person once the run ends, not the steps", () => {
    planned();
    event({ type: "progress", phase: "writing", draftId: "draft-1" });
    event({
      type: "item.failed",
      draftId: "draft-3",
      code: "generation_run_failed",
      category: "internal",
      details: {},
    });
    endGenerationRun("conversation-1", { stopped: true });
    expect(run()).toMatchObject({
      running: false,
      batch: ITEMS,
      draftPhases: {},
      itemFailures: { "draft-3": { code: "generation_run_failed" } },
    });
    // The next run starts without them.
    beginGenerationRun("conversation-1", REQUEST);
    expect(run()).toMatchObject({ batch: null, itemFailures: {} });
  });

  it("never holds a batch item's Discard, and says which drafts are being worked on", () => {
    planned();
    event({ type: "progress", phase: "writing", draftId: "draft-1" });
    event({ type: "progress", phase: "checking", draftId: "draft-2" });
    // The backend ends only a discarded item, so no item's Discard waits.
    expect([...generationRunDraftIds(run())]).toEqual([]);
    expect([...generationRunWorkingDraftIds(run())].sort()).toEqual([
      "draft-1",
      "draft-2",
    ]);
    endGenerationRun("conversation-1");
    expect([...generationRunWorkingDraftIds(run())]).toEqual([]);
  });

  it("forgets one discarded item and ignores what the run still says of it", () => {
    planned();
    event({ type: "progress", phase: "writing", draftId: "draft-1" });
    event({ type: "progress", phase: "checking", draftId: "draft-2" });
    event({ type: "frames.requested", draftId: "draft-1", version: 1 });
    event({ type: "frames.requested", draftId: "draft-2", version: 1 });
    event({
      type: "item.failed",
      draftId: "draft-3",
      code: "generation_run_failed",
      category: null,
      details: {},
    });

    forgetGenerationRunDraft("conversation-1", "draft-2");
    // The other items stand exactly as they did.
    expect(run()).toMatchObject({
      running: true,
      batch: ITEMS,
      draftPhases: { "draft-1": "writing" },
      framesRequests: [{ draftId: "draft-1", version: 1 }],
      itemFailures: { "draft-3": { code: "generation_run_failed" } },
    });

    // Late events about the discarded draft change nothing.
    const before = run();
    event({ type: "progress", phase: "repairing", draftId: "draft-2" });
    event({ type: "frames.requested", draftId: "draft-2", version: 2 });
    event({
      type: "item.failed",
      draftId: "draft-2",
      code: "generation_not_found",
      category: "generation",
      details: {},
    });
    event({
      type: "draft.updated",
      draft: generationDraft({ id: "draft-2", status: "failed" }),
    });
    expect(run()).toBe(before);
    expect(run().discardedDraftIds).toEqual(["draft-2"]);

    // A conversation no run has touched keeps no state for a discard.
    forgetGenerationRunDraft("conversation-9", "draft-1");
    expect(
      useGenerationStore.getState().runs["conversation-9"],
    ).toBeUndefined();
  });
});
