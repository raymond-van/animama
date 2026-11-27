import { describe, expect, it } from "vitest";

import {
  IDLE_GENERATION_RUN,
  type GenerationRunState,
} from "@/stores/generation-store";
import { draftBatchInfo, generationBatchProgress } from "./generationBatch";
import {
  generationDraft,
  generationMessage,
} from "./testing/generationFixtures";

const planned = (id: string, position: number) =>
  generationDraft({ id, position, status: "writing", project: null });
const ITEMS = [
  { draftId: "draft-1", intent: "gesture", brief: "A shy wave", error: null },
  { draftId: "draft-2", intent: "gesture", brief: "A deep bow", error: null },
  { draftId: "draft-3", intent: "reaction", brief: "A grin", error: null },
] as const;
const run = (overrides: Partial<GenerationRunState> = {}) => ({
  ...IDLE_GENERATION_RUN,
  ...overrides,
});
/** A stored assistant turn of a batch, as the backend writes it. */
const batchTurn = (id: string, batch: unknown) =>
  generationMessage({
    id,
    role: "assistant",
    text: "Three drafts.",
    data: { outcome: "draft", draft_id: "draft-1", batch },
  });
const STORED = [
  { draft_id: "draft-1", intent: "gesture", brief: "A shy wave" },
  {
    draft_id: "draft-2",
    intent: "gesture",
    brief: "A deep bow",
    error: { code: "openai_rate_limit", category: "rate_limited" },
  },
  // Its draft was removed by a stop: no card can show it.
  { draft_id: "draft-9", intent: "gesture", brief: "A spin" },
];

describe("draftBatchInfo", () => {
  it("is empty for a conversation without a batch", () => {
    expect(
      draftBatchInfo({
        drafts: [generationDraft()],
        messages: [generationMessage()],
        run: run({ running: true }),
      }).size,
    ).toBe(0);
  });

  it("gives each planned item its brief, and its own step while the run works", () => {
    const info = draftBatchInfo({
      drafts: [
        generationDraft({ id: "draft-1", status: "checking" }),
        planned("draft-2", 1),
        planned("draft-3", 2),
        // A draft of an earlier request is no part of the batch.
        generationDraft({ id: "draft-0", position: 3, status: "ready" }),
      ],
      messages: [],
      run: run({
        running: true,
        batch: ITEMS,
        draftPhases: { "draft-1": "checking", "draft-2": "thinking" },
      }),
    });
    expect([...info]).toEqual([
      ["draft-1", { brief: "A shy wave", step: "checking", failure: null }],
      ["draft-2", { brief: "A deep bow", step: "thinking", failure: null }],
      // Planned, and not started yet.
      ["draft-3", { brief: "A grin", step: "waiting", failure: null }],
    ]);
  });

  it("says an item is neither waiting nor at a step once it settled or failed", () => {
    const failure = {
      code: "openai_rate_limit",
      category: "rate_limited",
      details: { connection_name: "OpenAI" },
    };
    const info = draftBatchInfo({
      drafts: [
        generationDraft({ id: "draft-1", status: "ready" }),
        { ...planned("draft-2", 1), status: "failed" },
        // Its failure arrived before its draft was settled.
        planned("draft-3", 2),
      ],
      messages: [],
      run: run({
        running: true,
        batch: ITEMS,
        itemFailures: { "draft-2": failure, "draft-3": failure },
      }),
    });
    expect(info.get("draft-1")).toEqual({
      brief: "A shy wave",
      step: null,
      failure: null,
    });
    expect(info.get("draft-2")).toEqual({
      brief: "A deep bow",
      step: null,
      failure,
    });
    expect(info.get("draft-3")?.step).toBeNull();
  });

  it("keeps the briefs and the failures once the run has ended, without steps", () => {
    const info = draftBatchInfo({
      drafts: [generationDraft({ id: "draft-1", status: "ready" })],
      messages: [],
      run: run({
        running: false,
        batch: ITEMS,
        itemFailures: {
          "draft-1": { code: "boom", category: null, details: {} },
        },
      }),
    });
    expect([...info]).toEqual([
      [
        "draft-1",
        {
          brief: "A shy wave",
          step: null,
          failure: { code: "boom", category: null, details: {} },
        },
      ],
    ]);
  });

  it("reads the briefs and failures of drafts that still exist from the stored turn after a reload", () => {
    const info = draftBatchInfo({
      drafts: [
        generationDraft({ id: "draft-1", status: "ready" }),
        { ...planned("draft-2", 1), status: "failed" },
      ],
      messages: [
        generationMessage({ text: "three greetings" }),
        batchTurn("message-2", STORED),
      ],
      run: run(),
    });
    expect([...info]).toEqual([
      ["draft-1", { brief: "A shy wave", step: null, failure: null }],
      [
        "draft-2",
        {
          brief: "A deep bow",
          step: null,
          failure: {
            code: "openai_rate_limit",
            category: "rate_limited",
            details: {},
          },
        },
      ],
    ]);
  });

  it("keeps a stored brief, but not a stored failure, once a later run has worked on the conversation", () => {
    const drafts = [
      generationDraft({ id: "draft-2", status: "ready", version: 2 }),
    ];
    const earlier = [
      generationMessage({ text: "three greetings" }),
      batchTurn("message-2", STORED),
    ];
    // A later turn revised the draft: the failure describes it no more.
    const revised = draftBatchInfo({
      drafts,
      messages: [
        ...earlier,
        generationMessage({ id: "message-3", text: "deeper" }),
        generationMessage({
          id: "message-4",
          role: "assistant",
          text: "Deeper now.",
          data: { outcome: "draft", draft_id: "draft-2" },
        }),
      ],
      run: run(),
    });
    expect(revised.get("draft-2")).toEqual({
      brief: "A deep bow",
      step: null,
      failure: null,
    });
    // Nor while a run is in flight, whose turn is not stored yet.
    expect(
      draftBatchInfo({
        drafts,
        messages: earlier,
        run: run({ running: true }),
      }).get("draft-2")?.failure,
    ).toBeNull();
  });

  it("tolerates a stored batch it cannot read", () => {
    for (const batch of [null, "draft-1", [{ brief: "No draft" }], {}])
      expect(
        draftBatchInfo({
          drafts: [generationDraft()],
          messages: [batchTurn("message-2", batch)],
          run: run(),
        }).size,
      ).toBe(0);
  });
});

describe("generationBatchProgress", () => {
  it("is none without a batch in flight", () => {
    expect(generationBatchProgress(run({ running: true }), [])).toBeNull();
    expect(
      generationBatchProgress(run({ running: false, batch: ITEMS }), []),
    ).toBeNull();
  });

  it("counts nothing as finished right after planning, before the drafts are listed", () => {
    const state = run({ running: true, batch: ITEMS });
    expect(generationBatchProgress(state, [])).toEqual({ total: 3, done: 0 });
    expect(generationBatchProgress(state, [planned("draft-1", 0)])).toEqual({
      total: 3,
      done: 0,
    });
  });

  it("counts the items whose draft is listed and settled, or whose item failed", () => {
    const state = run({
      running: true,
      batch: ITEMS,
      draftPhases: { "draft-2": "writing" },
    });
    expect(
      generationBatchProgress(state, [
        generationDraft({ id: "draft-1", status: "checking" }),
        planned("draft-2", 1),
        planned("draft-3", 2),
      ]),
    ).toEqual({ total: 3, done: 0 });
    expect(
      generationBatchProgress(
        {
          ...state,
          itemFailures: {
            "draft-2": { code: "boom", category: null, details: {} },
          },
        },
        [
          generationDraft({ id: "draft-1", status: "warnings" }),
          planned("draft-2", 1),
          planned("draft-3", 2),
        ],
      ),
    ).toEqual({ total: 3, done: 2 });
  });

  it("leaves an item the person discarded out of the count", () => {
    const state = run({
      running: true,
      batch: ITEMS,
      discardedDraftIds: ["draft-3"],
    });
    expect(
      generationBatchProgress(state, [
        generationDraft({ id: "draft-1", status: "ready" }),
        planned("draft-2", 1),
      ]),
    ).toEqual({ total: 2, done: 1 });
  });
});
