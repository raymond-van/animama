import { describe, expect, it } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import {
  draftAwaitsCheck,
  draftCanBeRevised,
  draftLeftUnchecked,
  draftName,
  draftReactionPlacement,
  draftSequence,
  parseGenerationBatch,
  parseGenerationQuestions,
  pendingGenerationQuestions,
} from "./generationDrafts";
import {
  generationDraft,
  generationMessage,
  generationSnapshot,
  reactionProject,
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

describe("parseGenerationBatch", () => {
  it("reads a stored batch with each item's failure", () => {
    expect(
      parseGenerationBatch([
        { draft_id: "draft-1", intent: "gesture", brief: "A shy wave" },
        {
          draft_id: "draft-2",
          intent: "reaction",
          brief: "A soft smile",
          error: { code: "openai_rate_limit", category: "rate_limited" },
        },
        // A failure without a category, and one that names no code.
        { draft_id: "draft-3", brief: "A bow", error: { code: "boom" } },
        { draft_id: "draft-4", brief: "A nod", error: { category: "x" } },
      ]),
    ).toEqual([
      {
        draftId: "draft-1",
        intent: "gesture",
        brief: "A shy wave",
        error: null,
      },
      {
        draftId: "draft-2",
        intent: "reaction",
        brief: "A soft smile",
        error: { code: "openai_rate_limit", category: "rate_limited" },
      },
      {
        draftId: "draft-3",
        intent: "gesture",
        brief: "A bow",
        error: { code: "boom", category: null },
      },
      { draftId: "draft-4", intent: "gesture", brief: "A nod", error: null },
    ]);
  });

  it("drops what names no draft, and reads anything else as no batch", () => {
    expect(
      parseGenerationBatch([null, 3, { brief: "A wave" }, { draft_id: 9 }]),
    ).toEqual([]);
    for (const value of [undefined, null, "draft-1", { draft_id: "draft-1" }])
      expect(parseGenerationBatch(value)).toEqual([]);
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

  it("keeps the references the asking request carried", () => {
    expect(
      pendingGenerationQuestions(
        generationSnapshot({
          messages: [
            generationMessage({
              text: "a wave like this",
              data: {
                references: {
                  examples: [{ item_id: "bow", name: "Deep Bow" }],
                },
                images: [{ file_id: "file-1", name: "pose.png" }],
              },
            }),
            question,
          ],
        }),
      )?.request,
    ).toEqual({
      message: "a wave like this",
      draftId: null,
      references: {
        startingPoint: null,
        examples: [{ itemId: "bow", name: "Deep Bow" }],
        images: [{ fileId: "file-1", name: "pose.png", kind: "image" }],
      },
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

describe("a Reaction draft", () => {
  it("answers questions about a new Reaction as a Reaction", () => {
    const pending = pendingGenerationQuestions({
      messages: [
        generationMessage({ data: { intent: "reaction" } }),
        generationMessage({
          id: "message-2",
          role: "assistant",
          text: "",
          data: {
            outcome: "questions",
            questions: [{ question: "How strong?", options: ["Mild"] }],
          },
        }),
      ],
    });
    expect(pending?.request).toEqual({
      message: generationMessage().text,
      draftId: null,
      intent: "reaction",
    });
  });

  it("says where it suggests it fits, when its project names both", () => {
    const reaction = (project: Record<string, unknown> | null) =>
      draftReactionPlacement({ intent: "reaction", project });
    expect(reaction(reactionProject())).toEqual({
      emotion: "joy",
      intensity: 2,
    });
    expect(reaction(reactionProject({ suggestedEmotion: "" }))).toBeNull();
    expect(reaction(reactionProject({ suggestedEmotion: "alarm" }))).toBeNull();
    expect(reaction(reactionProject({ suggestedIntensity: 5 }))).toBeNull();
    expect(reaction(null)).toBeNull();
    expect(
      draftReactionPlacement({ intent: "gesture", project: reactionProject() }),
    ).toBeNull();
  });
});
