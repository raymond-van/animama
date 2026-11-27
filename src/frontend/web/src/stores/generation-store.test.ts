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
  generationRunDraftIds,
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
      framesRequest: null,
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
    expect(generationRunState("conversation-1").framesRequest).toEqual({
      draftId: "draft-1",
      version: 2,
    });
    clearGenerationFramesRequest("conversation-1", {
      draftId: "draft-1",
      version: 2,
    });
    expect(generationRunState("conversation-1").framesRequest).toBeNull();
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
      ).framesRequest;

    // Another draft, or the same version still waiting, changes nothing.
    expect(update({ id: "draft-2", version: 2, status: "ready" })).not.toBe(
      null,
    );
    expect(update({ version: 2, status: "checking" })).not.toBeNull();
    expect(update({ version: 2, status: "reviewing" })).toBeNull();
    expect(update({ version: 2, status: "warnings" })).toBeNull();
    expect(update({ version: 3, status: "checking" })).toBeNull();
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
