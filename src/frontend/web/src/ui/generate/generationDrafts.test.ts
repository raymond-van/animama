import { describe, expect, it } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import {
  draftAwaitsCheck,
  draftCanBeRevised,
  draftLeftUnchecked,
  draftName,
  draftSequence,
  parseGenerationQuestions,
  pendingGenerationQuestions,
} from "./generationDrafts";
import {
  generationDraft,
  generationMessage,
  generationSnapshot,
} from "./testing/generationFixtures";

describe("parseGenerationQuestions", () => {
  it("reads questions with their options", () => {
    expect(
      parseGenerationQuestions([
        { question: " Which hand? ", options: ["Right", "Left"] },
        { question: "How big?" },
      ]),
    ).toEqual([
      { question: "Which hand?", options: ["Right", "Left"] },
      { question: "How big?", options: [] },
    ]);
  });

  it("drops what is not a question", () => {
    expect(
      parseGenerationQuestions([
        null,
        "Which hand?",
        { question: "  " },
        { options: ["Right"] },
        { question: "Mood?", options: ["Shy", 3, "", null] },
      ]),
    ).toEqual([{ question: "Mood?", options: ["Shy"] }]);
    expect(parseGenerationQuestions(undefined)).toEqual([]);
    expect(parseGenerationQuestions({ question: "Mood?" })).toEqual([]);
  });
});

describe("pendingGenerationQuestions", () => {
  const asked = [{ question: "Which hand?", options: ["Right", "Left"] }];
  const question = generationMessage({
    id: "message-2",
    role: "assistant",
    text: "",
    data: { outcome: "questions", questions: asked },
  });

  it("finds questions the conversation's last turn asks, with their request", () => {
    expect(
      pendingGenerationQuestions(
        generationSnapshot({
          messages: [
            generationMessage({ id: "message-0", text: "an earlier wave" }),
            generationMessage({
              text: "make it shy",
              data: { draft_id: "draft-1" },
            }),
            question,
          ],
        }),
      ),
    ).toEqual({
      questions: asked,
      request: { message: "make it shy", draftId: "draft-1" },
    });
  });

  const request = generationMessage({
    text: "make it shy",
    data: { draft_id: "draft-1" },
  });
  const outstanding = {
    questions: asked,
    request: { message: "make it shy", draftId: "draft-1" },
  };
  /** One run that carried the person's answers and ended as `outcome`. */
  const answeringRun = (attempt: number, outcome: string) => [
    generationMessage({
      id: `answer-${attempt}`,
      text: "make it shy",
      data: {
        draft_id: "draft-1",
        answers: { answers: [{ question: "Which hand?", answer: "Left" }] },
      },
    }),
    generationMessage({
      id: `ended-${attempt}`,
      role: "assistant",
      text: "",
      data: { outcome, error: { code: "provider_error" } },
    }),
  ];

  it.each([
    ["failed", [...answeringRun(1, "failed")]],
    ["was stopped", [...answeringRun(1, "stopped")]],
    [
      "failed and then was stopped",
      [...answeringRun(1, "failed"), ...answeringRun(2, "stopped")],
    ],
  ])(
    "keeps the questions outstanding after an answering run that %s",
    (_label, attempts) => {
      expect(
        pendingGenerationQuestions(
          generationSnapshot({ messages: [request, question, ...attempts] }),
        ),
        // The original request, not the failed attempt's own turn.
      ).toEqual(outstanding);
    },
  );

  it("keeps them outstanding while an answering turn has no assistant turn yet", () => {
    // A run that died before the server stored how it ended.
    expect(
      pendingGenerationQuestions(
        generationSnapshot({
          messages: [request, question, answeringRun(1, "failed")[0]!],
        }),
      ),
    ).toEqual(outstanding);
  });

  it.each(["draft", "reply"])(
    "finds none once an answering run ended with a %s",
    (outcome) => {
      expect(
        pendingGenerationQuestions(
          generationSnapshot({
            messages: [request, question, ...answeringRun(1, outcome)],
          }),
        ),
      ).toBeNull();
      // A failed run after that answer does not bring the questions back.
      expect(
        pendingGenerationQuestions(
          generationSnapshot({
            messages: [
              request,
              question,
              ...answeringRun(1, outcome),
              ...answeringRun(2, "failed"),
            ],
          }),
        ),
      ).toBeNull();
    },
  );

  it.each(["failed", "stopped"])(
    "finds none after a run that stored its draft and then %s",
    (outcome) => {
      const [answer, ended] = answeringRun(1, outcome);
      // The turn names the draft it wrote: the run did work, so the person's
      // next message is an ordinary request.
      const wrote = generationMessage({
        ...ended,
        data: { ...ended!.data, draft_id: "draft-1" },
      });
      expect(
        pendingGenerationQuestions(
          generationSnapshot({ messages: [request, question, answer!, wrote] }),
        ),
      ).toBeNull();
      // Later attempts that did no work do not look past it.
      expect(
        pendingGenerationQuestions(
          generationSnapshot({
            messages: [
              request,
              question,
              answer!,
              wrote,
              ...answeringRun(2, "failed"),
            ],
          }),
        ),
      ).toBeNull();
    },
  );

  it.each(["stopped", "failed"])(
    "reads the questions of a turn that asked them and %s",
    (outcome) => {
      // The questions are read before the outcome.
      const asking = generationMessage({
        id: "message-2",
        role: "assistant",
        text: "",
        data: { outcome, questions: asked },
      });
      expect(
        pendingGenerationQuestions(
          generationSnapshot({ messages: [request, asking] }),
        ),
      ).toEqual(outstanding);
      // Also behind a later attempt that did no work.
      expect(
        pendingGenerationQuestions(
          generationSnapshot({
            messages: [request, asking, ...answeringRun(1, "failed")],
          }),
        ),
      ).toEqual(outstanding);
    },
  );

  it("takes the request from the person's turn before the asking turn", () => {
    const again = [{ question: "How big?", options: ["Small", "Large"] }];
    const second = generationMessage({
      id: "message-4",
      role: "assistant",
      text: "",
      data: { outcome: "questions", questions: again },
    });
    expect(
      pendingGenerationQuestions(
        generationSnapshot({
          messages: [
            request,
            question,
            generationMessage({ id: "message-3", text: "a bigger wave" }),
            second,
            ...answeringRun(1, "stopped"),
          ],
        }),
      ),
    ).toEqual({
      questions: again,
      request: { message: "a bigger wave", draftId: null },
    });
  });

  it("finds none when none were asked or their request is missing", () => {
    expect(
      pendingGenerationQuestions(
        generationSnapshot({
          messages: [
            generationMessage({ text: "a wave" }),
            generationMessage({ id: "message-2", role: "assistant" }),
          ],
        }),
      ),
    ).toBeNull();
    // A failed or stopped run with nothing asked before it.
    expect(
      pendingGenerationQuestions(
        generationSnapshot({ messages: answeringRun(1, "failed") }),
      ),
    ).toBeNull();
    expect(pendingGenerationQuestions(generationSnapshot())).toBeNull();
    expect(pendingGenerationQuestions(undefined)).toBeNull();
    // Questions without the request they were about cannot be answered.
    expect(
      pendingGenerationQuestions(generationSnapshot({ messages: [question] })),
    ).toBeNull();
  });
});

describe("draftAwaitsCheck", () => {
  it("is true for a version nobody checked that waits in checking", () => {
    expect(draftAwaitsCheck(generationDraft())).toBe(true);
    expect(
      draftAwaitsCheck(generationDraft({ version: 3, checked_version: 2 })),
    ).toBe(true);
  });

  it("is false once checked, in another step, or without a project", () => {
    expect(draftAwaitsCheck(generationDraft({ checked_version: 1 }))).toBe(
      false,
    );
    for (const status of ["writing", "repairing", "ready", "failed"] as const)
      expect(draftAwaitsCheck(generationDraft({ status }))).toBe(false);
    expect(draftAwaitsCheck(generationDraft({ project: null }))).toBe(false);
  });
});

describe("draftLeftUnchecked", () => {
  const left = generationDraft({
    status: "warnings",
    version: 2,
    checked_version: 2,
    check_report: { unchecked: true },
  });

  it("is true for a version whose stored report says only that it was not checked", () => {
    expect(draftLeftUnchecked(left)).toBe(true);
    // Whatever status the run left it in.
    const ready: PyGenerationDraft = { ...left, status: "ready" };
    expect(draftLeftUnchecked(ready)).toBe(true);
  });

  it("is false with a real report, a report of an earlier version, or no project", () => {
    expect(
      draftLeftUnchecked({ ...left, check_report: { loadable: true } }),
    ).toBe(false);
    expect(draftLeftUnchecked({ ...left, check_report: null })).toBe(false);
    expect(draftLeftUnchecked({ ...left, version: 3 })).toBe(false);
    expect(draftLeftUnchecked({ ...left, project: null })).toBe(false);
    // A version nobody reported on waits in `checking` instead.
    expect(draftLeftUnchecked(generationDraft())).toBe(false);
  });
});

describe("draftCanBeRevised", () => {
  it("is true only for a draft that has a project", () => {
    expect(draftCanBeRevised(generationDraft())).toBe(true);
    expect(
      draftCanBeRevised(generationDraft({ status: "failed", project: null })),
    ).toBe(false);
  });
});

describe("a draft's project", () => {
  it("gives its clip and name, or nothing when it has none", () => {
    const draft = generationDraft();
    expect(draftSequence(draft)).toBe(
      (draft.project as { sequence: unknown }).sequence,
    );
    expect(draftName(draft)).toBe("Shy Wave");

    expect(draftSequence(generationDraft({ project: null }))).toBeNull();
    expect(draftName(generationDraft({ project: null }))).toBe("");
    expect(draftSequence(generationDraft({ project: { name: 3 } }))).toBeNull();
    expect(draftName(generationDraft({ project: { name: 3 } }))).toBe("");
  });
});
