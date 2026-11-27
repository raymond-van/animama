import { describe, expect, it } from "vitest";

import {
  failedRunStoredDraft,
  generationTranscript,
} from "./generationTranscript";
import {
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
    });
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
      },
    ]);
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
            data: { outcome: "failed", ...data },
          }),
        ],
      }),
      { running: false, pendingTurn: null },
    );

  it("is true once a draft arrived in the run, whatever the transcript says", () => {
    expect(failedRunStoredDraft({ draftStored: true }, [])).toBe(true);
    expect(failedRunStoredDraft({ draftStored: true }, failedTurn({}))).toBe(
      true,
    );
  });

  it("is true when the turn the failed run stored names a draft", () => {
    expect(
      failedRunStoredDraft(
        { draftStored: false },
        failedTurn({ draft_id: "draft-1" }),
      ),
    ).toBe(true);
  });

  it("is false for a run that failed before it stored one", () => {
    expect(failedRunStoredDraft({ draftStored: false }, failedTurn({}))).toBe(
      false,
    );
    expect(failedRunStoredDraft({ draftStored: false }, [])).toBe(false);
    // An earlier run's draft does not count: only the last turn is the failed run's.
    expect(
      failedRunStoredDraft(
        { draftStored: false },
        generationTranscript(
          generationSnapshot({
            messages: [
              generationMessage(),
              generationMessage({
                id: "message-2",
                role: "assistant",
                data: { outcome: "draft", draft_id: "draft-1" },
              }),
              generationMessage({ id: "message-3", text: "make it shy" }),
            ],
          }),
          { running: false, pendingTurn: null },
        ),
      ),
    ).toBe(false);
  });
});
