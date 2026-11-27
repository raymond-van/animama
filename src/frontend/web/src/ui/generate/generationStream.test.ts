import { createClient } from "@animama/runtime-contracts/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  GENERATION_RUN_FAILED,
  GenerationRunHttpError,
  parseGenerationDraft,
  parseGenerationRunEvent,
  streamGenerationRun,
  type GenerationRunEvent,
} from "./generationStream";
import {
  controlledSseResponse,
  generationDraft,
  jsonResponse,
  sseFrame,
  sseResponse,
} from "./testing/generationFixtures";

const BODY = { message: "a shy wave", model_provider_id: "model-1" };

function clientWith(fetch: (request: Request) => Promise<Response>) {
  return createClient({
    baseUrl: "http://runtime.fixture.test",
    fetch: fetch as typeof globalThis.fetch,
  });
}

async function collect(
  stream: AsyncGenerator<GenerationRunEvent>,
): Promise<GenerationRunEvent[]> {
  const events: GenerationRunEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("parseGenerationRunEvent", () => {
  it("reads each event the backend sends", () => {
    const draft = generationDraft();
    expect(parseGenerationRunEvent("run.started", { run_id: "run-1" })).toEqual(
      { type: "run.started", runId: "run-1" },
    );
    expect(
      parseGenerationRunEvent("progress", {
        phase: "checking",
        draft_id: "draft-1",
      }),
    ).toEqual({ type: "progress", phase: "checking", draftId: "draft-1" });
    expect(parseGenerationRunEvent("message.delta", { text: "Hi" })).toEqual({
      type: "message.delta",
      text: "Hi",
    });
    expect(
      parseGenerationRunEvent("questions", {
        questions: [{ question: "Which hand?", options: ["Right", "Left"] }],
      }),
    ).toEqual({
      type: "questions",
      questions: [{ question: "Which hand?", options: ["Right", "Left"] }],
    });
    expect(parseGenerationRunEvent("draft.updated", { draft })).toEqual({
      type: "draft.updated",
      draft,
    });
    expect(
      parseGenerationRunEvent("frames.requested", {
        draft_id: "draft-1",
        version: 2,
      }),
    ).toEqual({ type: "frames.requested", draftId: "draft-1", version: 2 });
    expect(
      parseGenerationRunEvent("run.failed", {
        code: "openai_rate_limit",
        category: "rate_limited",
        details: { connection_name: "OpenAI" },
      }),
    ).toEqual({
      type: "run.failed",
      code: "openai_rate_limit",
      category: "rate_limited",
      details: { connection_name: "OpenAI" },
    });
    expect(
      parseGenerationRunEvent("run.completed", {
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 800,
          output_tokens: 300,
          reasoning_tokens: 40,
          requests: 3,
        },
      }),
    ).toEqual({
      type: "run.completed",
      usage: {
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 300,
        reasoningTokens: 40,
        requests: 3,
      },
    });
  });

  it("reads a new draft's progress, which names no draft yet", () => {
    expect(parseGenerationRunEvent("progress", { phase: "thinking" })).toEqual({
      type: "progress",
      phase: "thinking",
      draftId: null,
    });
  });

  it("fills what a partial payload leaves out", () => {
    expect(parseGenerationRunEvent("run.started", {})).toEqual({
      type: "run.started",
      runId: null,
    });
    // A step this page does not know is no known phase.
    expect(parseGenerationRunEvent("progress", { phase: "polishing" })).toEqual(
      { type: "progress", phase: null, draftId: null },
    );
    expect(parseGenerationRunEvent("questions", {})).toEqual({
      type: "questions",
      questions: [],
    });
    expect(parseGenerationRunEvent("run.failed", undefined)).toEqual({
      type: "run.failed",
      code: GENERATION_RUN_FAILED,
      category: null,
      details: {},
    });
    expect(parseGenerationRunEvent("run.completed", null)).toEqual({
      type: "run.completed",
      usage: null,
    });
    expect(
      parseGenerationRunEvent("run.completed", {
        usage: { input_tokens: "many", requests: 1 },
      }),
    ).toEqual({
      type: "run.completed",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        requests: 1,
      },
    });
  });

  it("skips events it cannot use and names it does not know", () => {
    expect(parseGenerationRunEvent("message.delta", {})).toBeNull();
    expect(parseGenerationRunEvent("message.delta", { text: 7 })).toBeNull();
    expect(parseGenerationRunEvent("draft.updated", {})).toBeNull();
    expect(
      parseGenerationRunEvent("draft.updated", { draft: { id: "draft-1" } }),
    ).toBeNull();
    expect(
      parseGenerationRunEvent("frames.requested", { draft_id: "draft-1" }),
    ).toBeNull();
    expect(
      parseGenerationRunEvent("frames.requested", { version: 1 }),
    ).toBeNull();
    expect(parseGenerationRunEvent("usage.updated", { tokens: 1 })).toBeNull();
    expect(parseGenerationRunEvent(undefined, { text: "Hi" })).toBeNull();
  });
});

describe("parseGenerationDraft", () => {
  it("keeps a whole draft as sent, with fields this page does not know", () => {
    const draft = { ...generationDraft(), review_note: "kept" };
    expect(parseGenerationDraft(draft)).toEqual(draft);
  });

  it("gives missing fields their empty values", () => {
    expect(
      parseGenerationDraft({
        id: "draft-1",
        conversation_id: "conversation-1",
        version: 3,
        status: "ready",
      }),
    ).toEqual({
      id: "draft-1",
      conversation_id: "conversation-1",
      version: 3,
      status: "ready",
      intent: "gesture",
      position: 0,
      project: null,
      has_previous_version: false,
      check_report: null,
      checked_version: null,
      repair_count: 0,
      failure_reason: null,
      saved_item_id: null,
      created_at: "",
      updated_at: "",
    });
  });

  it("refuses a draft it cannot place", () => {
    for (const value of [
      null,
      "draft-1",
      { id: "draft-1", version: 1, status: "ready" },
      { id: "draft-1", conversation_id: "c", version: "1", status: "ready" },
      { id: "", conversation_id: "c", version: 1, status: "ready" },
      { id: "draft-1", conversation_id: "c", version: 1 },
    ])
      expect(parseGenerationDraft(value)).toBeNull();
  });
});

describe("streamGenerationRun", () => {
  it("posts the request and yields the run's events in order", async () => {
    const draft = generationDraft();
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return sseResponse([
        sseFrame("run.started", { run_id: "run-1" }),
        sseFrame("progress", { phase: "thinking" }),
        ": heartbeat\n\n",
        sseFrame("message.delta", { text: "A shy" }),
        sseFrame("message.delta", { text: " wave." }),
        // An event from a newer backend, and one this page cannot use.
        sseFrame("usage.updated", { tokens: 12 }),
        sseFrame("draft.updated", { draft: { id: "draft-1" } }),
        sseFrame("draft.updated", { draft }),
        sseFrame("run.completed", { usage: { requests: 1 } }),
      ]);
    });

    const events = await collect(
      streamGenerationRun(clientWith(fetch), {
        conversationId: "conversation 1",
        body: BODY,
        signal: new AbortController().signal,
      }),
    );

    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "progress",
      "message.delta",
      "message.delta",
      "draft.updated",
      "run.completed",
    ]);
    expect(events[4]).toEqual({ type: "draft.updated", draft });
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "http://runtime.fixture.test/v1/generation/conversations/conversation%201/runs:sse",
    );
    expect(await request.json()).toEqual(BODY);
    // One request: a POST stream is never retried by the reader.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops quietly when aborted, closing the request", async () => {
    const controller = new AbortController();
    const stream = controlledSseResponse();
    const fetch = vi.fn(async () => stream.response);
    const events = streamGenerationRun(clientWith(fetch), {
      conversationId: "conversation-1",
      body: BODY,
      signal: controller.signal,
    });

    const first = events.next();
    stream.send(sseFrame("run.started", { run_id: "run-1" }));
    expect((await first).value).toEqual({
      type: "run.started",
      runId: "run-1",
    });

    const next = events.next();
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(stream.cancelled()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops frames already read when the run is stopped", async () => {
    const controller = new AbortController();
    const fetch = async () =>
      sseResponse([
        sseFrame("run.started", { run_id: "run-1" }),
        sseFrame("message.delta", { text: "late" }),
        sseFrame("run.completed", {}),
      ]);
    const events = streamGenerationRun(clientWith(fetch), {
      conversationId: "conversation-1",
      body: BODY,
      signal: controller.signal,
    });

    expect((await events.next()).value).toEqual({
      type: "run.started",
      runId: "run-1",
    });
    controller.abort();
    expect((await events.next()).done).toBe(true);
  });

  it("throws a refusal with its code and reason, without retrying", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          detail: {
            code: "generation_model_unusable",
            reason: "tools_unsupported",
          },
        },
        422,
      ),
    );
    const events = streamGenerationRun(clientWith(fetch), {
      conversationId: "conversation-1",
      body: BODY,
      signal: new AbortController().signal,
    });

    const refusal = await collect(events).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GenerationRunHttpError);
    expect(refusal).toMatchObject({
      status: 422,
      code: "generation_model_unusable",
      reason: "tools_unsupported",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a refusal whose body is not the documented shape", async () => {
    const fetch = async () => new Response("Bad Gateway", { status: 502 });
    const refusal = await collect(
      streamGenerationRun(clientWith(fetch), {
        conversationId: "conversation-1",
        body: BODY,
        signal: new AbortController().signal,
      }),
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 502, code: null, reason: null });
  });

  it("throws the transport's error when the connection fails", async () => {
    const fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(
      collect(
        streamGenerationRun(clientWith(fetch), {
          conversationId: "conversation-1",
          body: BODY,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
