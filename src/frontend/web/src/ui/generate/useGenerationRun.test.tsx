// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationConversationSnapshot } from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { queryKeys } from "@/query/keys";
import {
  forgetGenerationRunDraft,
  generationRunState,
} from "@/stores/generation-store";
import {
  controlledSseResponse,
  generationDraft,
  generationMessage,
  generationSnapshot,
  jsonResponse,
  sseFrame,
} from "./testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "./testing/generationHarness";
import type { GenerationRunReferences } from "./references/generationReferences";
import {
  GENERATION_REQUEST_FAILED,
  GENERATION_STREAM_INTERRUPTED,
  generationAnswers,
  generationRunBody,
  useGenerationRun,
  type GenerationRunController,
} from "./useGenerationRun";

const CONVERSATION = "conversation-1";
type Stream = ReturnType<typeof controlledSseResponse>;
type HookProps = Parameters<typeof useGenerationRun>[0];

/** The assistant's backend, as far as a run touches it. */
const server = {
  snapshot: generationSnapshot() as PyGenerationConversationSnapshot,
  /** The streams of the runs started, in order. */
  streams: [] as Stream[],
  /** The JSON bodies of the run requests, in order. */
  runs: [] as Record<string, unknown>[],
  /** The abort signals of the run requests, in order. */
  signals: [] as AbortSignal[],
  /** Answers the next run request with a refusal instead of a stream. */
  refuseNextRun: null as Response | null,
  /** Fails the next run request as a lost connection does. */
  dropNextRun: false,
  snapshotReads: 0,
};

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname.endsWith("/runs:sse")) {
    server.runs.push((await request.json()) as Record<string, unknown>);
    server.signals.push(request.signal);
    if (server.dropNextRun) {
      server.dropNextRun = false;
      throw new TypeError("Failed to fetch");
    }
    if (server.refuseNextRun) {
      const refusal = server.refuseNextRun;
      server.refuseNextRun = null;
      return refusal;
    }
    const stream = controlledSseResponse();
    server.streams.push(stream);
    return stream.response;
  }
  if (request.method === "GET" && pathname.endsWith(`/${CONVERSATION}`)) {
    server.snapshotReads += 1;
    return jsonResponse(server.snapshot);
  }
  if (request.method === "GET" && pathname.endsWith("/conversations"))
    return jsonResponse({ conversations: [server.snapshot.conversation] });
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

let mounted: MountedHook<HookProps, GenerationRunController>;

async function mount(props: Partial<HookProps> = {}) {
  mounted = mountGenerationHook(useGenerationRun, {
    props: {
      conversationId: CONVERSATION,
      modelProviderId: "model-1",
      ...props,
    },
    fetch,
  });
  await settle();
  return mounted;
}

/** Feed frames to the run in flight and let the page react. */
async function emit(...frames: string[]) {
  const stream = server.streams.at(-1)!;
  for (const frame of frames) stream.send(frame);
  await settle();
}

const cachedSnapshot = () =>
  mounted.queryClient.getQueryData<PyGenerationConversationSnapshot>(
    queryKeys.generation.conversation("session", CONVERSATION),
  );

beforeEach(() => {
  server.snapshot = generationSnapshot();
  server.streams = [];
  server.runs = [];
  server.signals = [];
  server.refuseNextRun = null;
  server.dropNextRun = false;
  server.snapshotReads = 0;
});

afterEach(() => {
  mounted?.unmount();
  for (const reset of privateStateResets()) reset();
  vi.useRealTimers();
});

const REFERENCES: GenerationRunReferences = {
  startingPoint: { itemId: "wave", name: "Wave Hello" },
  examples: [
    { itemId: "bow", name: "Deep Bow" },
    { itemId: "nod", name: "Nod" },
  ],
  images: [],
};
/** `REFERENCES` as the run route takes them. */
const REFERENCES_BODY = { starting_point: "wave", examples: ["bow", "nod"] };

describe("generationRunBody", () => {
  const request = { message: "a shy wave", draftId: null, answers: null };

  it("sends only the names of the chosen Avatar's expressions, by family", () => {
    const body = generationRunBody({
      request,
      modelProviderId: "model-1",
      uiLocale: "ja",
      avatarExpressionNames: ["happy", "Fcl_BRW_Joy", "jawOpen", "Cheek_Blush"],
    });
    expect(body).toEqual({
      message: "a shy wave",
      model_provider_id: "model-1",
      intent: "gesture",
      ui_locale: "ja",
      avatar_expressions: {
        vrmPresets: ["happy"],
        vroidParts: ["Fcl_BRW_Joy"],
        arkit: ["jawOpen"],
        custom: ["Cheek_Blush"],
      },
    });
  });

  it("names the draft to revise and carries the answers", () => {
    expect(
      generationRunBody({
        request: {
          message: "slower",
          draftId: "draft-1",
          answers: { skipped: true },
        },
        modelProviderId: "model-1",
        uiLocale: null,
        avatarExpressionNames: null,
      }),
    ).toEqual({
      message: "slower",
      model_provider_id: "model-1",
      draft_id: "draft-1",
      intent: "gesture",
      answers: { skipped: true },
    });
  });

  it("names the reasoning effort chosen for the model, and none without one", () => {
    expect(
      generationRunBody({
        request,
        modelProviderId: "model-1",
        reasoningEffort: "high",
      }),
    ).toEqual({
      message: "a shy wave",
      model_provider_id: "model-1",
      reasoning_effort: "high",
      intent: "gesture",
    });
    for (const reasoningEffort of [null, undefined, ""])
      expect(
        generationRunBody({
          request,
          modelProviderId: "model-1",
          reasoningEffort,
        }),
      ).not.toHaveProperty("reasoning_effort");
  });

  it("asks for the kind of a new draft, and sends a creator's document", () => {
    expect(
      generationRunBody({
        request: { ...request, intent: "reaction" },
        modelProviderId: "model-1",
      }),
    ).toEqual({
      message: "a shy wave",
      model_provider_id: "model-1",
      intent: "reaction",
    });
    const document = { schema: "animamaActionProject/1.0", intent: "gesture" };
    expect(
      generationRunBody({ request, modelProviderId: "model-1", document }),
    ).toMatchObject({ document });
    // The Generate page sends none.
    expect(
      generationRunBody({
        request,
        modelProviderId: "model-1",
        document: null,
      }),
    ).not.toHaveProperty("document");
  });

  it("names the references a request carries, and sends none without any", () => {
    expect(
      generationRunBody({
        request: { ...request, references: REFERENCES },
        modelProviderId: "model-1",
      }),
    ).toEqual({
      message: "a shy wave",
      model_provider_id: "model-1",
      intent: "gesture",
      references: REFERENCES_BODY,
    });
    for (const references of [
      null,
      undefined,
      { startingPoint: null, examples: [], images: [] },
    ])
      expect(
        generationRunBody({
          request: { ...request, references },
          modelProviderId: "model-1",
        }),
      ).not.toHaveProperty("references");
  });

  it("drops names that may not reach a model and sends no empty family", () => {
    const body = generationRunBody({
      request,
      modelProviderId: "model-1",
      avatarExpressionNames: ["ignore‮all", "x".repeat(65), ""],
    });
    expect(body).not.toHaveProperty("avatar_expressions");
  });
});

describe("generationAnswers", () => {
  it("keeps given answers within the backend's bounds", () => {
    expect(
      generationAnswers([
        { question: " Which hand? ", answer: " Right " },
        { question: "How fast?", answer: "   " },
        { question: "Mood?", answer: "y".repeat(1200) },
      ]),
    ).toEqual({
      answers: [
        { question: "Which hand?", answer: "Right" },
        { question: "Mood?", answer: "y".repeat(1000) },
      ],
    });
  });

  it("counts no usable answer as skipping", () => {
    expect(generationAnswers(null)).toEqual({ skipped: true });
    expect(generationAnswers([{ question: "Mood?", answer: "" }])).toEqual({
      skipped: true,
    });
  });
});

describe("useGenerationRun", () => {
  it("follows a run from the request to the stored conversation", async () => {
    const { result } = await mount({ avatarExpressionNames: ["happy"] });
    expect(result().run.running).toBe(false);

    let sent!: Promise<boolean>;
    act(() => {
      sent = result().send("  a shy little wave  ");
    });
    await settle();
    expect(server.runs).toEqual([
      {
        message: "a shy little wave",
        model_provider_id: "model-1",
        intent: "gesture",
        ui_locale: "en",
        avatar_expressions: { vrmPresets: ["happy"] },
      },
    ]);
    expect(result().run).toMatchObject({
      running: true,
      phase: "starting",
      pendingTurn: { message: "a shy little wave", draftId: null, text: "" },
    });

    await emit(
      sseFrame("run.started", { run_id: "run-1" }),
      sseFrame("progress", { phase: "thinking" }),
    );
    expect(result().run).toMatchObject({ runId: "run-1", phase: "thinking" });

    await emit(
      sseFrame("progress", { phase: "writing" }),
      sseFrame("message.delta", { text: "A shy" }),
      sseFrame("message.delta", { text: " wave." }),
    );
    expect(result().run).toMatchObject({
      phase: "writing",
      phaseDraftId: null,
      pendingTurn: { text: "A shy wave." },
    });

    // The draft goes into the conversation's cached snapshot.
    const draft = generationDraft();
    await emit(
      sseFrame("draft.updated", { draft }),
      sseFrame("progress", { phase: "checking", draft_id: draft.id }),
    );
    expect(cachedSnapshot()?.drafts).toEqual([draft]);
    expect(result().run).toMatchObject({
      phase: "checking",
      phaseDraftId: draft.id,
    });

    await emit(
      sseFrame("frames.requested", { draft_id: draft.id, version: 1 }),
    );
    expect(result().run.framesRequests).toEqual([
      { draftId: draft.id, version: 1 },
    ]);
    // The run moving on answers the request for sheets.
    const reviewing = { ...draft, status: "reviewing", checked_version: 1 };
    await emit(sseFrame("draft.updated", { draft: reviewing }));
    expect(result().run.framesRequests).toEqual([]);
    expect(cachedSnapshot()?.drafts).toEqual([reviewing]);

    // The server stored both turns; the run's last frame reads them.
    const ready = { ...reviewing, status: "ready" } as const;
    server.snapshot = generationSnapshot({
      messages: [
        generationMessage({ text: "a shy little wave" }),
        generationMessage({
          id: "message-2",
          role: "assistant",
          text: "A shy wave.",
          data: { run_id: "run-1", outcome: "draft" },
        }),
      ],
      drafts: [ready],
    });
    await emit(
      sseFrame("draft.updated", { draft: ready }),
      sseFrame("run.completed", {
        usage: { input_tokens: 900, output_tokens: 120, requests: 2 },
      }),
    );
    expect(await sent).toBe(true);
    await settle();

    expect(result().run).toMatchObject({
      running: false,
      phase: null,
      pendingTurn: null,
      failure: null,
      stopped: false,
      usage: { inputTokens: 900, outputTokens: 120, requests: 2 },
    });
    expect(cachedSnapshot()).toEqual(server.snapshot);
    // The request was released once its last frame arrived.
    expect(server.signals[0]!.aborted).toBe(true);
  });

  it("follows a batch item by item, as one run with one reply", async () => {
    const { result } = await mount();
    act(() => {
      void result().send("three greetings");
    });
    await settle();
    const item = (id: string, position: number) =>
      generationDraft({ id, position, status: "writing", project: null });
    await emit(
      sseFrame("run.started", { run_id: "run-1" }),
      sseFrame("progress", { phase: "thinking" }),
      sseFrame("batch.planned", {
        items: [
          { draft_id: "draft-1", intent: "gesture", brief: "A shy wave" },
          { draft_id: "draft-2", intent: "gesture", brief: "A deep bow" },
          { draft_id: "draft-3", intent: "reaction", brief: "A grin" },
        ],
      }),
      sseFrame("draft.updated", { draft: item("draft-1", 0) }),
      sseFrame("draft.updated", { draft: item("draft-2", 1) }),
      sseFrame("draft.updated", { draft: item("draft-3", 2) }),
    );
    // Every planned item is a draft in the list at once, before it is written.
    expect(cachedSnapshot()?.drafts.map(({ id }) => id)).toEqual([
      "draft-1",
      "draft-2",
      "draft-3",
    ]);
    expect(result().run.batch?.map(({ brief }) => brief)).toEqual([
      "A shy wave",
      "A deep bow",
      "A grin",
    ]);
    expect(result().run.draftPhases).toEqual({});

    await emit(
      sseFrame("progress", { phase: "writing", draft_id: "draft-1" }),
      sseFrame("progress", { phase: "writing", draft_id: "draft-2" }),
      sseFrame("message.delta", { text: "A wave. ", draft_id: "draft-1" }),
      sseFrame("progress", { phase: "checking", draft_id: "draft-1" }),
      sseFrame("message.delta", { text: "A bow.", draft_id: "draft-2" }),
      sseFrame("frames.requested", { draft_id: "draft-1", version: 1 }),
      sseFrame("frames.requested", { draft_id: "draft-2", version: 1 }),
    );
    expect(result().run).toMatchObject({
      running: true,
      draftPhases: { "draft-1": "checking", "draft-2": "writing" },
      pendingTurn: { text: "A wave. A bow." },
      framesRequests: [
        { draftId: "draft-1", version: 1 },
        { draftId: "draft-2", version: 1 },
      ],
    });

    // One item fails; the run and the other items go on.
    await emit(
      sseFrame("item.failed", {
        draft_id: "draft-2",
        code: "openai_rate_limit",
        category: "rate_limited",
        details: { connection_name: "OpenAI" },
      }),
      sseFrame("draft.updated", {
        draft: {
          ...item("draft-2", 1),
          status: "failed",
          failure_reason: "openai_rate_limit",
        },
      }),
      sseFrame("progress", { phase: "writing", draft_id: "draft-3" }),
    );
    expect(result().run).toMatchObject({
      running: true,
      failure: null,
      itemFailures: { "draft-2": { code: "openai_rate_limit" } },
      draftPhases: { "draft-1": "checking", "draft-3": "writing" },
      framesRequests: [{ draftId: "draft-1", version: 1 }],
    });
    expect(cachedSnapshot()?.drafts[1]).toMatchObject({
      status: "failed",
      failure_reason: "openai_rate_limit",
    });
  });

  it("keeps a batch item the person discarded out of the list, and the others in", async () => {
    const { result, queryClient } = await mount();
    act(() => {
      void result().send("two greetings");
    });
    await settle();
    const first = generationDraft({ id: "draft-1", status: "checking" });
    const second = generationDraft({
      id: "draft-2",
      position: 1,
      status: "writing",
      project: null,
    });
    await emit(
      sseFrame("batch.planned", {
        items: [
          { draft_id: "draft-1", brief: "A shy wave" },
          { draft_id: "draft-2", brief: "A deep bow" },
        ],
      }),
      sseFrame("draft.updated", { draft: first }),
      sseFrame("draft.updated", { draft: second }),
      sseFrame("progress", { phase: "checking", draft_id: "draft-1" }),
      sseFrame("progress", { phase: "writing", draft_id: "draft-2" }),
    );

    // As the discard does once the server has removed the draft.
    act(() => {
      forgetGenerationRunDraft(CONVERSATION, "draft-2");
      queryClient.setQueryData<PyGenerationConversationSnapshot>(
        queryKeys.generation.conversation("session", CONVERSATION),
        (snapshot) =>
          snapshot && {
            ...snapshot,
            drafts: snapshot.drafts.filter(({ id }) => id !== "draft-2"),
          },
      );
    });
    // What the run still sends about it does not bring it back.
    await emit(
      sseFrame("draft.updated", { draft: { ...second, status: "failed" } }),
      sseFrame("item.failed", {
        draft_id: "draft-2",
        code: "generation_not_found",
      }),
      sseFrame("draft.updated", { draft: { ...first, status: "ready" } }),
    );
    expect(cachedSnapshot()?.drafts).toEqual([{ ...first, status: "ready" }]);
    expect(result().run).toMatchObject({
      running: true,
      failure: null,
      itemFailures: {},
      draftPhases: {},
    });
  });

  it("tolerates partial events and events it does not know", async () => {
    const { result } = await mount();
    act(() => void result().send("a wave"));
    await settle();

    await emit(
      sseFrame("run.started", {}),
      sseFrame("progress", { phase: "polishing" }),
      sseFrame("message.delta", {}),
      sseFrame("draft.updated", { draft: { id: "draft-9" } }),
      sseFrame("frames.requested", { draft_id: "draft-9" }),
      sseFrame("usage.updated", { tokens: 3 }),
      "data: not json at all\n\n",
      sseFrame("message.delta", { text: "Still here." }),
    );

    expect(result().run).toMatchObject({
      running: true,
      runId: null,
      // An unknown step keeps the last known one.
      phase: "starting",
      framesRequests: [],
      failure: null,
      pendingTurn: { text: "Still here." },
    });
    expect(cachedSnapshot()?.drafts).toEqual([]);

    await emit(sseFrame("run.completed", {}));
    expect(result().run).toMatchObject({ running: false, usage: null });
  });

  it("refuses a second request while one runs", async () => {
    const { result } = await mount();
    act(() => void result().send("a wave"));
    await settle();

    let second!: boolean;
    await act(async () => {
      second = await result().send("a bow");
    });
    expect(second).toBe(false);
    expect(server.runs).toHaveLength(1);
    expect(result().run.pendingTurn?.message).toBe("a wave");
  });

  it("does not start without a model, a conversation or a usable message", async () => {
    const { result, rerender } = await mount({ modelProviderId: null });
    const refused = async (message: string) => {
      let started!: boolean;
      await act(async () => {
        started = await result().send(message);
      });
      return started;
    };
    expect(await refused("a wave")).toBe(false);

    rerender({ conversationId: null, modelProviderId: "model-1" });
    expect(await refused("a wave")).toBe(false);

    rerender({ conversationId: CONVERSATION, modelProviderId: "model-1" });
    expect(await refused("   ")).toBe(false);
    expect(await refused("x".repeat(4001))).toBe(false);
    expect(server.runs).toEqual([]);
    expect(result().run.running).toBe(false);
  });

  it("writes a new draft of the kind asked for", async () => {
    const { result } = await mount();
    act(() => {
      void result().send("a soft smile", { intent: "reaction" });
    });
    await settle();
    expect(server.runs[0]).toMatchObject({
      message: "a soft smile",
      intent: "reaction",
    });
  });

  it("starts a creator's run from the item as it stands when the run starts", async () => {
    type Source = {
      document: Record<string, unknown> | null;
      draftId: string | null;
    };
    const creatorSource = vi.fn(
      (): Source => ({
        document: { name: "as first edited" },
        draftId: "draft-7",
      }),
    );
    const { result } = await mount({ creatorSource });
    act(() => {
      void result().send("hold the end");
    });
    await settle();
    expect(server.runs[0]).toMatchObject({
      message: "hold the end",
      draft_id: "draft-7",
      document: { name: "as first edited" },
    });
    expect(result().run.pendingTurn).toMatchObject({ draftId: "draft-7" });
    await emit(sseFrame("run.completed", { usage: {} }));

    // An empty item is written anew: no document, and no draft to revise.
    creatorSource.mockImplementation(() => ({ document: null, draftId: null }));
    act(() => {
      void result().send("write it");
    });
    await settle();
    expect(server.runs[1]).not.toHaveProperty("document");
    expect(server.runs[1]).not.toHaveProperty("draft_id");
    expect(creatorSource).toHaveBeenCalledTimes(2);
  });

  it("does not start a run its creator refuses", async () => {
    const { result } = await mount({ creatorSource: () => false });
    let started!: boolean;
    await act(async () => {
      started = await result().send("a wave");
    });
    expect(started).toBe(false);
    expect(server.runs).toEqual([]);
  });

  it("stops a run by closing its request, keeping what it stored", async () => {
    const { result } = await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => void result().send("a wave"));
    await vi.advanceTimersByTimeAsync(0);
    const draft = generationDraft();
    server.streams[0]!.send(sseFrame("draft.updated", { draft }));
    await vi.advanceTimersByTimeAsync(0);
    const readsBefore = server.snapshotReads;

    // The server settles the stopped run a moment after the stream closes.
    server.snapshot = generationSnapshot({
      messages: [generationMessage({ text: "a wave" })],
      drafts: [draft],
    });
    act(() => result().stop());
    await vi.advanceTimersByTimeAsync(0);

    expect(server.streams[0]!.cancelled()).toBe(true);
    expect(result().run).toMatchObject({
      running: false,
      stopped: true,
      failure: null,
      pendingTurn: null,
    });
    expect(cachedSnapshot()?.drafts).toEqual([draft]);
    expect(server.snapshotReads).toBe(readsBefore + 1);

    // It reads the conversation again for the turn the server stores late.
    const stopped = generationMessage({
      id: "message-2",
      role: "assistant",
      text: "",
      data: { outcome: "stopped" },
    });
    server.snapshot = {
      ...server.snapshot,
      messages: [...server.snapshot.messages, stopped],
    };
    await vi.advanceTimersByTimeAsync(1_500);
    expect(cachedSnapshot()?.messages.at(-1)).toEqual(stopped);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(server.snapshotReads).toBe(readsBefore + 3);
  });

  it("keeps the conversation and offers a retry when a run fails", async () => {
    const draft = generationDraft({ status: "ready", checked_version: 1 });
    server.snapshot = generationSnapshot({ drafts: [draft] });
    const { result } = await mount();
    act(() => void result().send("make it slower", { draftId: draft.id }));
    await settle();
    expect(server.runs[0]).toMatchObject({ draft_id: draft.id });

    await emit(
      sseFrame("run.started", { run_id: "run-1" }),
      sseFrame("message.delta", { text: "Let me" }),
      sseFrame("run.failed", {
        code: "chatgpt_plan_usage_limit",
        category: "rate_limited",
        details: { connection_name: "ChatGPT plan" },
      }),
      sseFrame("run.completed", { usage: { requests: 1 } }),
    );

    expect(result().run).toMatchObject({
      running: false,
      stopped: false,
      failure: {
        code: "chatgpt_plan_usage_limit",
        category: "rate_limited",
        details: { connection_name: "ChatGPT plan" },
        status: null,
        network: false,
        request: { message: "make it slower", draftId: draft.id },
      },
    });
    // The draft and the conversation are as they were.
    expect(cachedSnapshot()?.drafts).toEqual([draft]);

    act(() => void result().retry());
    await settle();
    expect(server.runs).toHaveLength(2);
    expect(server.runs[1]).toMatchObject({
      message: "make it slower",
      draft_id: draft.id,
    });
    // A new run clears the last one's failure.
    expect(result().run).toMatchObject({ running: true, failure: null });

    act(() => result().dismissFailure());
    expect(result().run.failure).toBeNull();
  });

  it("sends the chosen effort with every run: a request, its retry and an answer", async () => {
    const { result, rerender } = await mount({ reasoningEffort: "high" });
    act(() => void result().send("a shy little wave"));
    await settle();
    await emit(
      sseFrame("run.started", { run_id: "run-1" }),
      sseFrame("run.failed", {
        code: "openai_rate_limit",
        category: "rate_limited",
        details: {},
      }),
      sseFrame("run.completed", { usage: { requests: 1 } }),
    );

    act(() => void result().retry());
    await settle();
    await emit(
      sseFrame("run.started", { run_id: "run-2" }),
      sseFrame("questions", {
        questions: [{ question: "Which hand?", options: ["Right", "Left"] }],
      }),
      sseFrame("run.completed", { usage: { requests: 1 } }),
    );

    act(
      () => void result().answer([{ question: "Which hand?", answer: "Left" }]),
    );
    await settle();
    expect(server.runs.map((run) => run.reasoning_effort)).toEqual([
      "high",
      "high",
      "high",
    ]);
    expect(server.runs[2]).toMatchObject({
      message: "a shy little wave",
      answers: { answers: [{ question: "Which hand?", answer: "Left" }] },
    });
    await emit(sseFrame("run.completed", { usage: { requests: 1 } }));

    // The level is read when a run starts: back at the model's default, none is named.
    rerender({
      conversationId: CONVERSATION,
      modelProviderId: "model-1",
      reasoningEffort: null,
    });
    act(() => void result().send("another wave"));
    await settle();
    expect(server.runs[3]).not.toHaveProperty("reasoning_effort");
  });

  it("sends a request's references again with its retry and with an answer", async () => {
    const { result } = await mount();
    act(
      () => void result().send("a shy little wave", { references: REFERENCES }),
    );
    await settle();
    // The turn shows what it carries while the run works.
    expect(result().run.pendingTurn?.references).toEqual(REFERENCES);
    await emit(
      sseFrame("run.started", { run_id: "run-1" }),
      sseFrame("run.failed", {
        code: "openai_rate_limit",
        category: "rate_limited",
        details: {},
      }),
      sseFrame("run.completed", { usage: { requests: 1 } }),
    );

    act(() => void result().retry());
    await settle();
    await emit(
      sseFrame("run.started", { run_id: "run-2" }),
      sseFrame("questions", {
        questions: [{ question: "Which hand?", options: ["Right", "Left"] }],
      }),
      sseFrame("run.completed", { usage: { requests: 1 } }),
    );

    act(
      () => void result().answer([{ question: "Which hand?", answer: "Left" }]),
    );
    await settle();
    expect(server.runs.map((run) => run.references)).toEqual([
      REFERENCES_BODY,
      REFERENCES_BODY,
      REFERENCES_BODY,
    ]);
    expect(server.runs[2]).toMatchObject({
      message: "a shy little wave",
      answers: { answers: [{ question: "Which hand?", answer: "Left" }] },
    });
    await emit(sseFrame("run.completed", { usage: { requests: 1 } }));

    // The next request carries only what it is given.
    act(() => void result().send("another wave"));
    await settle();
    expect(server.runs[3]).not.toHaveProperty("references");
  });

  it("answers questions asked in this session as the kind the request asked for", async () => {
    const { result } = await mount();
    act(() => void result().send("wide-eyed surprise", { intent: "reaction" }));
    await settle();
    await emit(
      sseFrame("run.started", { run_id: "run-1" }),
      sseFrame("questions", {
        questions: [{ question: "How strong?", options: ["Mild", "Strong"] }],
      }),
      sseFrame("run.completed", { usage: { requests: 1 } }),
    );

    act(
      () =>
        void result().answer([{ question: "How strong?", answer: "Strong" }]),
    );
    await settle();

    // Without a reload in between, the answer still writes a Reaction.
    expect(server.runs.map((run) => run.intent)).toEqual([
      "reaction",
      "reaction",
    ]);
  });

  it("answers stored questions with the references their request carried", async () => {
    const asked = [{ question: "How big?", options: ["Small", "Large"] }];
    server.snapshot = generationSnapshot({
      messages: [
        generationMessage({
          text: "a wave",
          data: {
            references: {
              starting_point: { item_id: "wave", name: "Wave Hello" },
              examples: [
                { item_id: "bow", name: "Deep Bow" },
                { item_id: "nod", name: "Nod" },
              ],
            },
          },
        }),
        generationMessage({
          id: "message-2",
          role: "assistant",
          data: { outcome: "questions", questions: asked },
        }),
      ],
    });
    const { result } = await mount();
    expect(result().questions?.request).toEqual({
      message: "a wave",
      draftId: null,
      references: REFERENCES,
    });

    act(() => void result().answer(null));
    await settle();
    expect(server.runs[0]).toMatchObject({
      message: "a wave",
      answers: { skipped: true },
      references: REFERENCES_BODY,
    });
  });

  it("reports a request the server refuses, with its code and reason", async () => {
    server.refuseNextRun = jsonResponse(
      {
        detail: {
          code: "generation_model_unusable",
          reason: "tools_unsupported",
        },
      },
      422,
    );
    const { result } = await mount();
    await act(async () => {
      expect(await result().send("a wave")).toBe(true);
    });
    await settle();

    expect(result().run).toMatchObject({
      running: false,
      // Nothing was stored, so nothing stays pending.
      pendingTurn: null,
      failure: {
        code: "generation_model_unusable",
        reason: "tools_unsupported",
        status: 422,
        network: false,
        request: { message: "a wave", draftId: null, answers: null },
      },
    });
  });

  it("reports the server's own refusal of a second run", async () => {
    server.refuseNextRun = jsonResponse(
      { detail: { code: "generation_run_in_progress" } },
      409,
    );
    const { result } = await mount();
    await act(async () => void (await result().send("a wave")));
    await settle();
    expect(result().run.failure).toMatchObject({
      code: "generation_run_in_progress",
      status: 409,
    });
  });

  it("reports a lost connection and a stream that ends early", async () => {
    server.dropNextRun = true;
    const { result } = await mount();
    await act(async () => void (await result().send("a wave")));
    await settle();
    expect(result().run.failure).toMatchObject({
      code: GENERATION_REQUEST_FAILED,
      network: true,
      status: null,
    });

    act(() => void result().send("a wave"));
    await settle();
    await emit(sseFrame("run.started", { run_id: "run-2" }));
    act(() => server.streams.at(-1)!.close());
    await settle();
    expect(result().run).toMatchObject({
      running: false,
      stopped: false,
      failure: { code: GENERATION_STREAM_INTERRUPTED, network: false },
    });
  });

  it("says the connection was lost, not that the request never arrived, once the stream had begun", async () => {
    const { result } = await mount();
    act(() => void result().send("a wave"));
    await settle();
    await emit(sseFrame("run.started", { run_id: "run-1" }));
    // The connection breaks while the assistant works.
    act(() => server.streams[0]!.drop());
    await settle();
    expect(result().run).toMatchObject({
      running: false,
      stopped: false,
      failure: {
        code: GENERATION_STREAM_INTERRUPTED,
        network: true,
        request: { message: "a wave" },
      },
    });
  });

  it("keeps the failure a run reported when the connection then breaks", async () => {
    const { result } = await mount();
    act(() => void result().send("a wave"));
    await settle();
    await emit(
      sseFrame("run.failed", { code: "provider_error", category: "provider" }),
    );
    act(() => server.streams[0]!.drop());
    await settle();
    expect(result().run.failure).toMatchObject({
      code: "provider_error",
      category: "provider",
      network: false,
    });
  });

  it("keeps the general wording for a refusal that names no code", async () => {
    server.refuseNextRun = jsonResponse({ detail: "Bad Gateway" }, 502);
    const { result } = await mount();
    await act(async () => void (await result().send("a wave")));
    await settle();
    expect(result().run.failure).toMatchObject({
      code: GENERATION_REQUEST_FAILED,
      status: 502,
      network: false,
    });
  });

  it("drops the late reads of a stopped run when the next run begins", async () => {
    const { result } = await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => void result().send("a wave"));
    await vi.advanceTimersByTimeAsync(0);
    act(() => result().stop());
    await vi.advanceTimersByTimeAsync(0);
    expect(result().run.stopped).toBe(true);

    // The next run starts before the stopped run's late reads are due: a
    // read landing during it could put an older draft back.
    act(() => void result().send("a bow"));
    await vi.advanceTimersByTimeAsync(0);
    const readsDuringRun = server.snapshotReads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result().run.running).toBe(true);
    expect(server.snapshotReads).toBe(readsDuringRun);
  });

  it("drops the late reads of a stopped run when the page leaves", async () => {
    const { result, unmount } = await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => void result().send("a wave"));
    await vi.advanceTimersByTimeAsync(0);
    act(() => result().stop());
    await vi.advanceTimersByTimeAsync(0);
    const reads = server.snapshotReads;
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.snapshotReads).toBe(reads);
  });

  it("keeps the failure a stream reported when it then ends early", async () => {
    const { result } = await mount();
    act(() => void result().send("a wave"));
    await settle();
    await emit(sseFrame("run.failed", { code: "generation_no_valid_draft" }));
    act(() => server.streams[0]!.close());
    await settle();
    expect(result().run.failure).toMatchObject({
      code: "generation_no_valid_draft",
    });
  });

  it("shows the questions a run ends on and sends the answers with the request again", async () => {
    const draft = generationDraft({ status: "ready", checked_version: 1 });
    server.snapshot = generationSnapshot({ drafts: [draft] });
    const { result } = await mount();
    act(() => void result().send("make it friendlier", { draftId: draft.id }));
    await settle();
    const asked = [{ question: "Which hand?", options: ["Right", "Left"] }];
    await emit(sseFrame("questions", { questions: asked }));
    // Not offered while the run is still in flight.
    expect(result().questions).toBeNull();

    server.snapshot = generationSnapshot({
      messages: [
        generationMessage({
          text: "make it friendlier",
          data: { draft_id: draft.id },
        }),
        generationMessage({
          id: "message-2",
          role: "assistant",
          text: "",
          data: { outcome: "questions", questions: asked },
        }),
      ],
      drafts: [draft],
    });
    await emit(sseFrame("run.completed", {}));
    expect(result().questions).toEqual({
      questions: asked,
      request: { message: "make it friendlier", draftId: draft.id },
    });

    act(
      () => void result().answer([{ question: "Which hand?", answer: "Left" }]),
    );
    await settle();
    expect(server.runs[1]).toEqual({
      message: "make it friendlier",
      model_provider_id: "model-1",
      draft_id: draft.id,
      intent: "gesture",
      ui_locale: "en",
      answers: { answers: [{ question: "Which hand?", answer: "Left" }] },
    });
    // The stored conversation still ends on the questions this run answers.
    expect(result().questions).toBeNull();

    server.snapshot = {
      ...server.snapshot,
      messages: [
        ...server.snapshot.messages,
        generationMessage({ id: "message-3", text: "make it friendlier" }),
        generationMessage({
          id: "message-4",
          role: "assistant",
          text: "Done.",
        }),
      ],
    };
    await emit(sseFrame("run.completed", {}));
    expect(result().questions).toBeNull();
  });

  it("finds unanswered questions in the stored conversation after a reload", async () => {
    const asked = [{ question: "How big?", options: ["Small", "Large"] }];
    server.snapshot = generationSnapshot({
      messages: [
        generationMessage({ text: "a wave" }),
        generationMessage({
          id: "message-2",
          role: "assistant",
          data: { outcome: "questions", questions: asked },
        }),
      ],
    });
    const { result } = await mount();
    expect(result().questions).toEqual({
      questions: asked,
      request: { message: "a wave", draftId: null },
    });

    act(() => void result().answer(null));
    await settle();
    expect(server.runs[0]).toMatchObject({
      message: "a wave",
      answers: { skipped: true },
    });
  });

  it("offers the questions again after an answering run failed, and both ways on send the answers", async () => {
    const asked = [{ question: "How big?", options: ["Small", "Large"] }];
    const stored = [
      generationMessage({ text: "a wave" }),
      generationMessage({
        id: "message-2",
        role: "assistant",
        data: { outcome: "questions", questions: asked },
      }),
    ];
    server.snapshot = generationSnapshot({ messages: stored });
    const { result } = await mount();
    const answers = [{ question: "How big?", answer: "Small" }];
    act(() => void result().answer(answers));
    await settle();

    // The server stored the answering turn and how its run ended.
    server.snapshot = generationSnapshot({
      messages: [
        ...stored,
        generationMessage({
          id: "message-3",
          text: "a wave",
          data: { answers: { answers } },
        }),
        generationMessage({
          id: "message-4",
          role: "assistant",
          text: "",
          data: { outcome: "failed", error: { code: "provider_error" } },
        }),
      ],
    });
    await emit(
      sseFrame("run.failed", { code: "provider_error", category: "provider" }),
      sseFrame("run.completed", {}),
    );
    expect(result().run.failure).toMatchObject({ code: "provider_error" });
    // Still outstanding, about the original request.
    expect(result().questions).toEqual({
      questions: asked,
      request: { message: "a wave", draftId: null },
    });

    // The failure's own retry sends the same answers again.
    act(() => void result().retry());
    await settle();
    expect(server.runs[1]).toMatchObject({
      message: "a wave",
      answers: { answers },
    });
    await emit(
      sseFrame("run.failed", { code: "provider_error", category: "provider" }),
      sseFrame("run.completed", {}),
    );

    // Answering the cards again is a retry with the new answers.
    act(
      () => void result().answer([{ question: "How big?", answer: "Large" }]),
    );
    await settle();
    expect(server.runs[2]).toMatchObject({
      message: "a wave",
      answers: { answers: [{ question: "How big?", answer: "Large" }] },
    });
  });

  it("has nothing to answer or retry when nothing is pending", async () => {
    const { result } = await mount();
    await act(async () => {
      expect(await result().answer(null)).toBe(false);
      expect(await result().retry()).toBe(false);
    });
    expect(server.runs).toEqual([]);
  });

  it("stops the run when the page leaves or opens another conversation", async () => {
    const first = await mount();
    act(() => void first.result().send("a wave"));
    await settle();
    first.unmount();
    await settle();
    expect(server.streams[0]!.cancelled()).toBe(true);
    expect(generationRunState(CONVERSATION)).toMatchObject({
      running: false,
      pendingTurn: null,
    });

    const second = await mount();
    act(() => void second.result().send("a bow"));
    await settle();
    second.rerender({ conversationId: null, modelProviderId: "model-1" });
    await settle();
    expect(server.streams[1]!.cancelled()).toBe(true);
    expect(generationRunState(CONVERSATION).running).toBe(false);
  });
});
