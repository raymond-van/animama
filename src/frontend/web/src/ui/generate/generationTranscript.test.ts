import { describe, expect, it } from "vitest";

import {
  failedRunStoredDraft,
  generationTranscript,
} from "./generationTranscript";
import {
  generationDraft,
  generationMessage,
  generationSnapshot,
} from "./testing/generationFixtures";

const IDLE = { running: false, pendingTurn: null };

describe("generationTranscript", () => {
  it("shows the stored turns with what each carried", () => {
    const transcript = generationTranscript(
      generationSnapshot({
        messages: [
          generationMessage({ id: "m1", text: "a shy wave" }),
          generationMessage({
            id: "m2",
            role: "assistant",
            text: "",
            data: {
              run_id: "run-1",
              outcome: "questions",
              questions: [
                { question: "Which hand?", options: ["Right", "Left"] },
              ],
            },
          }),
          generationMessage({
            id: "m3",
            text: "a shy wave",
            data: {
              answers: {
                answers: [{ question: "Which hand?", answer: "Left" }],
              },
            },
          }),
          generationMessage({
            id: "m4",
            role: "assistant",
            text: "A small left-handed wave.",
            data: { outcome: "draft", draft_id: "draft-1" },
          }),
          generationMessage({
            id: "m5",
            text: "slower",
            data: { draft_id: "draft-1", answers: { skipped: true } },
          }),
          generationMessage({
            id: "m6",
            role: "assistant",
            text: "Let me",
            data: {
              outcome: "failed",
              draft_id: "draft-1",
              error: { code: "openai_rate_limit", category: "rate_limited" },
            },
          }),
        ],
      }),
      IDLE,
    );

    expect(
      transcript.map(({ id, role, pending }) => [id, role, pending]),
    ).toEqual([
      ["m1", "user", false],
      ["m2", "assistant", false],
      ["m3", "user", false],
      ["m4", "assistant", false],
      ["m5", "user", false],
      ["m6", "assistant", false],
    ]);
    expect(transcript[1]).toMatchObject({
      outcome: "questions",
      questions: [{ question: "Which hand?", options: ["Right", "Left"] }],
      runId: "run-1",
    });
    // Only an assistant turn names a run.
    expect(transcript[0]!.runId).toBeNull();
    expect(transcript[2]!.answers).toEqual({
      skipped: false,
      answers: [{ question: "Which hand?", answer: "Left" }],
    });
    expect(transcript[3]).toMatchObject({
      outcome: "draft",
      draftId: "draft-1",
    });
    expect(transcript[4]).toMatchObject({
      draftId: "draft-1",
      answers: { skipped: true, answers: [] },
    });
    expect(transcript[5]).toMatchObject({
      outcome: "failed",
      errorCode: "openai_rate_limit",
      text: "Let me",
    });
  });

  it("reads a turn whose data it does not know without failing", () => {
    const [entry] = generationTranscript(
      generationSnapshot({
        messages: [
          generationMessage({
            role: "assistant",
            data: {
              outcome: "paused",
              draft_id: 7,
              questions: "none",
              error: "boom",
              answers: [],
            },
          }),
        ],
      }),
      IDLE,
    );
    expect(entry).toMatchObject({
      outcome: null,
      draftId: null,
      questions: [],
      answers: null,
      errorCode: null,
    });
  });

  it("adds the run in flight's request and the assistant's text so far", () => {
    const stored = generationMessage({ id: "m1", text: "an earlier wave" });
    const transcript = generationTranscript(
      generationSnapshot({ messages: [stored] }),
      {
        running: true,
        pendingTurn: {
          message: "make it slower",
          draftId: "draft-1",
          text: "Slowing",
        },
      },
    );
    expect(transcript.slice(1)).toEqual([
      {
        id: "pending:user",
        role: "user",
        text: "make it slower",
        pending: true,
        draftId: "draft-1",
        outcome: null,
        questions: [],
        answers: null,
        errorCode: null,
        runId: null,
        batchDraftIds: [],
        references: null,
        imagesSent: true,
      },
      {
        id: "pending:assistant",
        role: "assistant",
        text: "Slowing",
        pending: true,
        draftId: null,
        outcome: null,
        questions: [],
        answers: null,
        errorCode: null,
        runId: null,
        batchDraftIds: [],
        references: null,
        imagesSent: true,
      },
    ]);
  });

  it("shows the references a turn carried, stored or still in flight", () => {
    const references = {
      startingPoint: { itemId: "wave", name: "Wave Hello" },
      examples: [{ itemId: "bow", name: "Deep Bow" }],
      images: [
        {
          fileId: "file-1",
          name: "pose.png",
          kind: "image" as const,
          width: 640,
          height: 480,
        },
      ],
    };
    const transcript = generationTranscript(
      generationSnapshot({
        messages: [
          generationMessage({
            id: "m1",
            text: "a wave like this",
            data: {
              references: {
                starting_point: { item_id: "wave", name: "Wave Hello" },
                examples: [{ item_id: "bow", name: "Deep Bow" }],
              },
              images: [
                {
                  file_id: "file-1",
                  name: "pose.png",
                  width: 640,
                  height: 480,
                  kind: "image",
                },
              ],
              images_sent: false,
            },
          }),
          generationMessage({ id: "m2", role: "assistant", text: "A wave." }),
        ],
      }),
      {
        running: true,
        pendingTurn: {
          message: "and a bow",
          draftId: null,
          text: "",
          references: { ...references, startingPoint: null, images: [] },
        },
      },
    );
    expect(transcript[0]).toMatchObject({ references, imagesSent: false });
    // An assistant's turn carries none.
    expect(transcript[1]).toMatchObject({ references: null, imagesSent: true });
    expect(transcript[2]).toMatchObject({
      id: "pending:user",
      references: {
        startingPoint: null,
        examples: [{ itemId: "bow", name: "Deep Bow" }],
        images: [],
      },
      imagesSent: true,
    });
    expect(transcript[3]!.references).toBeNull();
  });

  it("does not show the request twice when a read during the run already holds it", () => {
    const transcript = generationTranscript(
      generationSnapshot({
        messages: [generationMessage({ id: "m1", text: "a wave" })],
      }),
      {
        running: true,
        pendingTurn: { message: "a wave", draftId: null, text: "" },
      },
    );
    expect(transcript.map(({ id }) => id)).toEqual(["m1", "pending:assistant"]);
  });

  it("drops the pending turn once the stored conversation holds both turns", () => {
    const messages = [
      generationMessage({ id: "m1", text: "a wave" }),
      generationMessage({ id: "m2", role: "assistant", text: "A wave." }),
    ];
    const pendingTurn = { message: "a wave", draftId: null, text: "A wave." };
    expect(
      generationTranscript(generationSnapshot({ messages }), {
        running: false,
        pendingTurn,
      }).map(({ id }) => id),
    ).toEqual(["m1", "m2"]);
    // The same words asked again are a new turn while that run is in flight.
    expect(
      generationTranscript(generationSnapshot({ messages }), {
        running: true,
        pendingTurn,
      }).map(({ id }) => id),
    ).toEqual(["m1", "m2", "pending:user", "pending:assistant"]);
  });

  it("shows only the pending turn before the conversation is read", () => {
    expect(
      generationTranscript(undefined, {
        running: true,
        pendingTurn: { message: "a wave", draftId: null, text: "" },
      }).map(({ id }) => id),
    ).toEqual(["pending:user", "pending:assistant"]);
    expect(generationTranscript(undefined, IDLE)).toEqual([]);
  });
});

describe("failedRunStoredDraft", () => {
  const failedTurn = (data: Record<string, unknown>) =>
    generationTranscript(
      generationSnapshot({
        messages: [
          generationMessage(),
          generationMessage({
            id: "message-2",
            role: "assistant",
            text: "",
            data: { run_id: "run-1", outcome: "failed", ...data },
          }),
        ],
      }),
      { running: false, pendingTurn: null },
    );
  const run = (draftStored: boolean, runId: string | null = "run-1") => ({
    draftStored,
    runId,
  });

  it("is true once a draft arrived in the run, whatever the transcript says", () => {
    expect(failedRunStoredDraft(run(true), [])).toBe(true);
    expect(failedRunStoredDraft(run(true), failedTurn({}))).toBe(true);
    expect(failedRunStoredDraft(run(true, null), [])).toBe(true);
  });

  it("is true when the turn the failed run stored names a draft", () => {
    expect(
      failedRunStoredDraft(run(false), failedTurn({ draft_id: "draft-1" })),
    ).toBe(true);
  });

  it("is false for a run that failed before it stored one", () => {
    expect(failedRunStoredDraft(run(false), failedTurn({}))).toBe(false);
    expect(failedRunStoredDraft(run(false), [])).toBe(false);
    // An earlier run's draft does not count: only the last turn is the failed run's.
    expect(
      failedRunStoredDraft(
        run(false),
        generationTranscript(
          generationSnapshot({
            messages: [
              generationMessage(),
              generationMessage({
                id: "message-2",
                role: "assistant",
                data: {
                  run_id: "run-1",
                  outcome: "draft",
                  draft_id: "draft-1",
                },
              }),
              generationMessage({ id: "message-3", text: "make it shy" }),
            ],
          }),
          { running: false, pendingTurn: null },
        ),
      ),
    ).toBe(false);
  });

  it("does not take the run before's failed turn for this run's", () => {
    // The run before failed after storing its draft, and stored that turn.
    const before = failedTurn({ run_id: "run-0", draft_id: "draft-1" });
    // This request never reached the backend: no stream event, so no run id.
    expect(failedRunStoredDraft(run(false, null), before)).toBe(false);
    // Nor when this run did start and stored no turn the page has read yet.
    expect(failedRunStoredDraft(run(false, "run-1"), before)).toBe(false);
    // A stored turn that names no run is nobody's.
    expect(
      failedRunStoredDraft(
        run(false),
        failedTurn({ run_id: undefined, draft_id: "draft-1" }),
      ),
    ).toBe(false);
  });

  it("is false when the drafts the failed run's turn names hold nothing", () => {
    // A batch ended by a failure every item would meet: the one item it kept failed with nothing written.
    const turn = failedTurn({
      draft_id: "draft-1",
      batch: [
        { draft_id: "draft-1", intent: "gesture", brief: "a wave" },
        { draft_id: "draft-2", intent: "gesture", brief: "a bow" },
      ],
    });
    const empty = generationDraft({ status: "failed", project: null });
    expect(failedRunStoredDraft(run(false), turn, [empty])).toBe(false);
    // The named draft is gone altogether.
    expect(failedRunStoredDraft(run(false), turn, [])).toBe(false);
  });

  it("is true when any draft of the failed run's batch holds a project", () => {
    const turn = failedTurn({
      draft_id: "draft-1",
      batch: [
        { draft_id: "draft-1", intent: "gesture", brief: "a wave" },
        { draft_id: "draft-2", intent: "gesture", brief: "a bow" },
      ],
    });
    expect(
      failedRunStoredDraft(run(false), turn, [
        generationDraft({ status: "failed", project: null }),
        generationDraft({ id: "draft-2" }),
      ]),
    ).toBe(true);
    // Another run's draft does not count.
    expect(
      failedRunStoredDraft(run(false), turn, [
        generationDraft({ id: "draft-9" }),
      ]),
    ).toBe(false);
  });
});
