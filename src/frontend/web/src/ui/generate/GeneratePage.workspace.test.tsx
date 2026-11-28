// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { GeneratePage } from "./GeneratePage";
import { createEffectLibraryServer } from "./testing/effectLibraryServer";
import {
  controlledSseResponse,
  effectGestureProject,
  generationConversation,
  generationDraft,
  generationMessage,
  generationSnapshot,
  generationUsage,
  gestureProject,
  jsonResponse,
  sseFrame,
} from "./testing/generationFixtures";
import {
  click,
  renderInRuntime,
  settle,
  type MountedNode,
} from "./testing/generationHarness";
import type { DraftWorker } from "./useDraftWorker";

/**
 * The page's areas wired together over a fake backend. The stage (a WebGL
 * canvas) and the checks worker have their own tests; here the preview
 * reports a loaded Avatar and the worker only validates.
 */
const fixture = vi.hoisted(() => ({
  player: [] as { draftId: string | null; version: number | null }[],
  workerInput: null as {
    conversationId: string | null;
    avatarExpressionNames: unknown;
  } | null,
  /** The sandbox entries the preview provider was given, render by render. */
  sandbox: [] as (readonly Record<string, unknown>[] | undefined)[],
}));

vi.mock("@/ui/app/AppShellPage", () => ({
  AppShellPage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("./GeneratePreview", () => ({
  GeneratePreviewProvider: ({
    children,
    sandboxEntries,
  }: {
    children: ReactNode;
    sandboxEntries?: readonly Record<string, unknown>[];
  }) => {
    fixture.sandbox.push(sandboxEntries);
    return <div data-testid="preview-provider">{children}</div>;
  },
  GeneratePreviewStage: ({ draft }: { draft: PyGenerationDraft | null }) => (
    <div data-testid="stage" data-draft-id={draft?.id} />
  ),
  GeneratePreviewControls: ({ playable }: { playable: boolean }) => (
    <div data-testid="controls" data-playable={playable} />
  ),
  useGeneratePreviewAvatarExpressions: () => PREVIEW_EXPRESSIONS,
  useGeneratePreviewPlayer: (
    draft: PyGenerationDraft | null,
    validation: { sequence: unknown; version: number } | undefined,
  ) => {
    fixture.player.push({
      draftId: draft?.id ?? null,
      version: validation?.version ?? null,
    });
    return { playable: Boolean(validation?.sequence), failed: false };
  },
}));
vi.mock("./useDraftWorker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useDraftWorker")>();
  const { useMemo } = await import("react");
  return {
    ...actual,
    useDraftWorker: (input: {
      conversationId: string | null;
      drafts: readonly PyGenerationDraft[];
      avatarExpressionNames: unknown;
    }): DraftWorker => {
      fixture.workerInput = input;
      const validations = useMemo(
        () =>
          Object.fromEntries(
            input.drafts
              .filter((draft) => draft.project)
              .map((draft) => [draft.id, actual.validateDraft(draft)]),
          ),
        [input.drafts],
      );
      return {
        validations,
        checkingDraftId: null,
        failures: {},
        retryCheck: () => {},
        frames: { status: "idle", draftId: null },
      };
    },
  };
});

const PREVIEW_EXPRESSIONS = {
  names: ["happy", "Cheek_Blush"],
  arkitNames: undefined,
};

const first = generationDraft({ id: "draft-1", status: "ready" });
const second = generationDraft({
  id: "draft-2",
  position: 1,
  status: "ready",
  project: gestureProject({ name: "Deep Bow" }),
});

const server = {
  snapshot: generationSnapshot() as PyGenerationConversationSnapshot,
  /** An earlier conversation, listed after the latest. */
  earlier: null as PyGenerationConversationSnapshot | null,
  runs: [] as Record<string, unknown>[],
  streams: [] as ReturnType<typeof controlledSseResponse>[],
  /** What the chosen model's catalog row adds, such as its effort levels. */
  model: {} as Record<string, unknown>,
  /** The owner's saved choices for the assistant. */
  generation: { model_provider_id: "model-1" } as Record<string, unknown>,
  /** The Library's preview route, which resolves a draft's effects. */
  effects: createEffectLibraryServer(),
};

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/model-providers")
    return jsonResponse([
      {
        id: "model-1",
        model: "gpt-key",
        model_label: "GPT Key",
        model_kind: "chat",
        model_provider: "OpenAIResponsesHTTPAgent",
        api_standard: "responses",
        source: "builtin",
        connection_name: "OpenAI",
        logo_provider: "openai",
        hidden: false,
        supports_tools: true,
        supports_streaming: true,
        accepts: ["text", "image"],
        ...server.model,
      },
    ]);
  if (pathname === "/v1/users/me/settings")
    return jsonResponse({ preferences: { generation: server.generation } });
  if (request.method === "POST" && pathname.endsWith("/runs:sse")) {
    server.runs.push((await request.json()) as Record<string, unknown>);
    const stream = controlledSseResponse();
    server.streams.push(stream);
    return stream.response;
  }
  if (pathname.endsWith("/conversations"))
    return jsonResponse({
      conversations: [
        server.snapshot.conversation,
        ...(server.earlier ? [server.earlier.conversation] : []),
      ],
    });
  for (const snapshot of [server.snapshot, server.earlier])
    if (
      snapshot &&
      pathname.endsWith(`/conversations/${snapshot.conversation.id}`)
    )
      return jsonResponse(snapshot);
  // The Library Gestures the composer's reference pickers offer.
  if (request.method === "GET" && pathname === "/v1/gestures")
    return jsonResponse({ items: [] });
  const effects = await server.effects.handle(request);
  if (effects) return effects;
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

let mounted: MountedNode | null = null;
async function open() {
  mounted = renderInRuntime(<GeneratePage />, { fetch });
  document.body.append(mounted.container);
  await settle();
  return mounted.container;
}

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
/** A draft card's Discard, by the draft's id. */
const discardOf = (draftId: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-testid="generate-draft-card"][data-draft-id="${draftId}"] [data-testid="generate-draft-discard"]`,
  )!;
const findAll = (testId: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

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
}

beforeEach(() => {
  server.snapshot = generationSnapshot({
    conversation: generationConversation({ title: "a shy little wave" }),
    messages: [
      generationMessage(),
      generationMessage({
        id: "message-2",
        role: "assistant",
        text: "Here is a shy wave.",
        data: { outcome: "draft", draft_id: "draft-1" },
      }),
    ],
    drafts: [first, second],
  });
  server.earlier = null;
  server.runs = [];
  server.streams = [];
  server.model = {};
  server.generation = { model_provider_id: "model-1" };
  server.effects = createEffectLibraryServer();
  fixture.player = [];
  fixture.workerInput = null;
  fixture.sandbox = [];
});
afterEach(() => {
  mounted?.unmount();
  mounted?.container.remove();
  mounted = null;
  for (const reset of privateStateResets()) reset();
});

describe("the Generate page's workspace", () => {
  it("shows the conversation, the preview and the drafts of the latest conversation", async () => {
    const root = await open();
    expect(root.querySelector("h1")!.textContent).toBe("Generate");
    expect(find("generate-model-control")!.textContent).toContain("GPT Key");
    // The conversation.
    expect(find("generate-conversation")!.textContent).toContain(
      "Here is a shy wave.",
    );
    expect(root.textContent).toContain("a shy little wave");
    // Its drafts, the latest selected and playing.
    expect(
      findAll("generate-draft-card").map((c) => c.dataset.draftId),
    ).toEqual(["draft-1", "draft-2"]);
    expect(findAll("generate-draft-card")[1]!.dataset.selected).toBe("true");
    expect(find("stage")!.dataset.draftId).toBe("draft-2");
    expect(find("controls")!.dataset.playable).toBe("true");
    expect(fixture.player.at(-1)).toEqual({ draftId: "draft-2", version: 1 });
    expect(root.textContent).toContain("2 drafts");
    // The worker reads the preview Avatar's names for its checks.
    expect(fixture.workerInput).toMatchObject({
      conversationId: "conversation-1",
      avatarExpressionNames: PREVIEW_EXPRESSIONS.names,
    });
  });

  it("offers references in its composer: a starting point only for a new Gesture draft", async () => {
    await open();
    const startButton = () =>
      find("generate-reference-start")?.querySelector("button") ?? null;
    // The latest draft is selected, so the next message revises it.
    expect(find("generate-references")).not.toBeNull();
    expect(find("generate-reference-examples")).not.toBeNull();
    expect(startButton()).toBeNull();

    await click(find("generate-new-draft"));
    expect(startButton()!.getAttribute("aria-label")).toBe(
      "Start from a Gesture in your Library",
    );
    await click(find("generate-kind-reaction"));
    expect(startButton()).toBeNull();
  });

  it("revises the selected draft, with the model and the Avatar's expression names", async () => {
    await open();
    await click(
      findAll("generate-draft-card")[0]!.querySelector(
        '[data-testid="generate-draft-select"]',
      ),
    );
    expect(find("stage")!.dataset.draftId).toBe("draft-1");
    expect(find("generate-revision-target")!.textContent).toContain(
      "Your next message revises “Shy Wave”.",
    );

    type("make it friendlier");
    await click(find("generate-send"));
    await settle();
    expect(server.runs).toEqual([
      {
        message: "make it friendlier",
        model_provider_id: "model-1",
        draft_id: "draft-1",
        intent: "gesture",
        ui_locale: "en",
        avatar_expressions: { vrmPresets: ["happy"], custom: ["Cheek_Blush"] },
      },
    ]);
    // The run shows as in flight everywhere it matters.
    expect(find("generate-progress")).not.toBeNull();
    expect(find("generate-stop")).not.toBeNull();
    expect((find("generate-model-control") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (find("generate-new-conversation") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        findAll("generate-draft-card")[0]!.querySelector(
          '[data-testid="generate-draft-save"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    // The draft the run revises cannot be discarded under it; another can.
    expect(discardOf("draft-1").disabled).toBe(true);
    expect(discardOf("draft-1").title).toBe(
      "Available when the assistant has finished.",
    );
    expect(discardOf("draft-2").disabled).toBe(false);

    await click(find("generate-stop"));
    await settle();
    expect(server.streams[0]!.cancelled()).toBe(true);
    expect(find("generate-progress")).toBeNull();
    expect(find("generate-send")).not.toBeNull();
    expect(discardOf("draft-1").disabled).toBe(false);
  });

  it("writes a new draft when asked, and selects it as it arrives", async () => {
    await open();
    await click(find("generate-new-draft"));
    expect(find("stage")!.dataset.draftId).toBeUndefined();
    expect(
      findAll("generate-draft-card").map((card) => card.dataset.selected),
    ).toEqual(["false", "false"]);

    type("a salute");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]).not.toHaveProperty("draft_id");

    const written = generationDraft({
      id: "draft-3",
      position: 2,
      status: "checking",
      project: gestureProject({ name: "Salute" }),
    });
    await act(async () => {
      server.streams[0]!.send(sseFrame("draft.updated", { draft: written }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    const cards = findAll("generate-draft-card");
    expect(cards.map((card) => card.dataset.draftId)).toEqual([
      "draft-1",
      "draft-2",
      "draft-3",
    ]);
    expect(cards[2]!.dataset.selected).toBe("true");
    expect(find("stage")!.dataset.draftId).toBe("draft-3");

    // Once the run says it is working on the new draft, that draft is held.
    await act(async () => {
      server.streams[0]!.send(
        sseFrame("progress", { phase: "checking", draft_id: "draft-3" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(discardOf("draft-3").disabled).toBe(true);
    expect(discardOf("draft-1").disabled).toBe(false);
    expect(discardOf("draft-2").disabled).toBe(false);
  });

  it("shows a batch item by item, goes on past a failed item, and keeps the plan after a reload", async () => {
    await open();
    await click(find("generate-new-draft"));
    type("three greetings");
    await click(find("generate-send"));
    await settle();
    const emit = async (...frames: string[]) => {
      await act(async () => {
        for (const frame of frames) server.streams[0]!.send(frame);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
    };
    const planned = (id: string, position: number) =>
      generationDraft({ id, position, status: "writing", project: null });
    const card = (draftId: string) =>
      document.querySelector<HTMLElement>(
        `[data-testid="generate-draft-card"][data-draft-id="${draftId}"]`,
      )!;
    const shown = (draftId: string, testId: string) =>
      card(draftId).querySelector<HTMLElement>(`[data-testid="${testId}"]`);

    await emit(
      sseFrame("run.started", { run_id: "run-2" }),
      sseFrame("batch.planned", {
        items: [
          { draft_id: "draft-3", intent: "gesture", brief: "A salute" },
          { draft_id: "draft-4", intent: "gesture", brief: "A curtsy" },
          { draft_id: "draft-5", intent: "gesture", brief: "A high five" },
        ],
      }),
      sseFrame("draft.updated", { draft: planned("draft-3", 2) }),
      sseFrame("draft.updated", { draft: planned("draft-4", 3) }),
      sseFrame("draft.updated", { draft: planned("draft-5", 4) }),
      sseFrame("progress", { phase: "writing", draft_id: "draft-3" }),
      sseFrame("progress", { phase: "thinking", draft_id: "draft-4" }),
    );
    // Every planned item is listed with its brief and its own step.
    expect(
      ["draft-3", "draft-4", "draft-5"].map((id) => [
        shown(id, "generate-draft-brief")!.textContent,
        shown(id, "generate-draft-status")!.textContent,
      ]),
    ).toEqual([
      ["A salute", "Writing…"],
      ["A curtsy", "Thinking…"],
      ["A high five", "Waiting for its turn…"],
    ]);
    expect(find("generate-progress")!.textContent).toBe(
      "Working on 3 drafts. 0 finished so far…",
    );
    // An item's Discard does not wait for the run; an earlier draft's never did.
    expect(discardOf("draft-3").disabled).toBe(false);
    expect(discardOf("draft-5").disabled).toBe(false);

    // The first item is written and settles; the second fails.
    const salute = generationDraft({
      id: "draft-3",
      position: 2,
      status: "ready",
      checked_version: 1,
      project: gestureProject({ name: "Salute" }),
    });
    await emit(
      sseFrame("draft.updated", { draft: salute }),
      sseFrame("item.failed", {
        draft_id: "draft-4",
        code: "openai_connection_error",
        category: "connection",
        details: { connection_name: "My Ollama" },
      }),
      sseFrame("draft.updated", {
        draft: {
          ...planned("draft-4", 3),
          status: "failed",
          failure_reason: "openai_connection_error",
        },
      }),
      sseFrame("progress", { phase: "writing", draft_id: "draft-5" }),
    );
    expect(shown("draft-3", "generate-draft-status")!.textContent).toBe(
      "Ready",
    );
    // The first item written is what the preview plays.
    expect(find("stage")!.dataset.draftId).toBe("draft-3");
    expect(shown("draft-4", "generate-draft-failure")!.textContent).toBe(
      "Animama couldn't reach My Ollama.",
    );
    expect(shown("draft-5", "generate-draft-status")!.textContent).toBe(
      "Writing…",
    );
    expect(find("generate-progress")!.textContent).toBe(
      "Working on 3 drafts. 2 finished so far…",
    );
    // The run itself has not failed.
    expect(find("generate-failure")).toBeNull();
    // Saving waits for the run, for one draft and for several.
    expect(
      (find("generate-drafts-save-all") as HTMLButtonElement).disabled,
    ).toBe(true);

    // The run ends; the stored turn keeps the plan for a reload.
    server.snapshot = generationSnapshot({
      conversation: server.snapshot.conversation,
      messages: [
        ...server.snapshot.messages,
        generationMessage({ id: "message-3", text: "three greetings" }),
        generationMessage({
          id: "message-4",
          role: "assistant",
          text: "Three greetings.",
          data: {
            outcome: "draft",
            draft_id: "draft-3",
            run_id: "run-2",
            batch: [
              { draft_id: "draft-3", intent: "gesture", brief: "A salute" },
              {
                draft_id: "draft-4",
                intent: "gesture",
                brief: "A curtsy",
                error: {
                  code: "openai_connection_error",
                  category: "connection",
                },
              },
              { draft_id: "draft-5", intent: "gesture", brief: "A high five" },
            ],
          },
        }),
      ],
      drafts: [
        first,
        second,
        salute,
        {
          ...planned("draft-4", 3),
          status: "failed",
          failure_reason: "openai_connection_error",
        },
      ],
    });
    await emit(sseFrame("run.completed", {}));
    expect(find("generate-progress")).toBeNull();
    expect(
      (find("generate-drafts-save-all") as HTMLButtonElement).disabled,
    ).toBe(false);

    // After a reload the briefs and the failed item's reason are still there.
    mounted!.unmount();
    mounted!.container.remove();
    for (const reset of privateStateResets()) reset();
    await open();
    expect(
      findAll("generate-draft-card").map((element) => [
        element.dataset.draftId,
        element.querySelector('[data-testid="generate-draft-brief"]')
          ?.textContent ?? null,
      ]),
    ).toEqual([
      ["draft-1", null],
      ["draft-2", null],
      ["draft-3", "A salute"],
      ["draft-4", "A curtsy"],
    ]);
    const reason = shown("draft-4", "generate-draft-failure")!.textContent;
    expect(reason).toContain("couldn't reach");
    expect(reason).not.toContain("openai_connection_error");
  });

  it("plays the selected draft's effects through the creator's sandbox entries", async () => {
    const sparkling = generationDraft({
      id: "draft-3",
      position: 2,
      status: "ready",
      project: effectGestureProject({ name: "Sparkling Wave" }),
    });
    server.snapshot = {
      ...server.snapshot,
      drafts: [first, second, sparkling],
    };
    await open();

    // The preview provider wraps the stage, and holds the effects of the
    // draft the stage plays, under the alias its event names.
    expect(find("preview-provider")!.contains(find("stage"))).toBe(true);
    expect(find("stage")!.dataset.draftId).toBe("draft-3");
    const mountedEffects = fixture.sandbox.at(-1)!;
    expect(mountedEffects).toMatchObject([
      { slot: "avatar_vfx", runtime_id: "sparkle" },
    ]);
    expect(server.effects.requests).toEqual([["effect-item-1"]]);
    // The card says what the draft plays.
    const card = findAll("generate-draft-card")[2]!;
    expect(
      card.querySelector('[data-testid="generate-draft-effects"]')!.textContent,
    ).toBe("Plays 1 effect: sparkle");
    expect(
      card.querySelector('[data-testid="generate-draft-missing-effects"]'),
    ).toBeNull();

    // A draft without effects mounts none; moving on to another such draft
    // leaves the preview's catalog, and so its Avatar, as it is.
    await click(
      findAll("generate-draft-card")[0]!.querySelector(
        '[data-testid="generate-draft-select"]',
      ),
    );
    await settle();
    const none = fixture.sandbox.at(-1)!;
    expect(none).toEqual([]);
    await click(
      findAll("generate-draft-card")[1]!.querySelector(
        '[data-testid="generate-draft-select"]',
      ),
    );
    await settle();
    expect(find("stage")!.dataset.draftId).toBe("draft-2");
    expect(fixture.sandbox.at(-1)).toBe(none);
    expect(server.effects.requests).toHaveLength(1);
  });

  it("says on its card that a draft's effect is gone from the Library, and holds its Save", async () => {
    const sparkling = generationDraft({
      id: "draft-3",
      position: 2,
      status: "ready",
      project: effectGestureProject({ name: "Sparkling Wave" }),
    });
    server.snapshot = {
      ...server.snapshot,
      drafts: [first, sparkling, second],
    };
    server.effects.gone.add("effect-item-1");
    await open();

    // Not the selected draft: the list resolves every draft's effects.
    expect(find("stage")!.dataset.draftId).toBe("draft-2");
    const card = findAll("generate-draft-card")[1]!;
    const missing = card.querySelector<HTMLElement>(
      '[data-testid="generate-draft-missing-effects"]',
    )!;
    expect(missing.textContent).toBe(
      "This draft plays an effect that is no longer in your Library: sparkle. Ask the assistant to revise the draft before you save it.",
    );
    const save = card.querySelector<HTMLButtonElement>(
      '[data-testid="generate-draft-save"]',
    )!;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("aria-describedby")).toBe(missing.id);
    // The other drafts save as before.
    expect(
      findAll("generate-draft-card")[0]!.querySelector<HTMLButtonElement>(
        '[data-testid="generate-draft-save"]',
      )!.disabled,
    ).toBe(false);
  });

  it("returns from Model setup to the conversation that was open", async () => {
    server.earlier = generationSnapshot({
      conversation: generationConversation({
        id: "conversation-0",
        title: "an earlier bow",
      }),
      messages: [
        generationMessage({ id: "message-0", text: "an earlier bow" }),
        generationMessage({
          id: "message-00",
          role: "assistant",
          text: "Here is a deep bow.",
          data: { outcome: "draft" },
        }),
      ],
    });
    await open();
    expect(find("generate-conversation")!.textContent).toContain(
      "Here is a shy wave.",
    );

    // Reopen the earlier conversation from the menu.
    const menu = find("generate-conversations-menu")!;
    await act(async () => {
      menu.focus();
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await click(
      document.querySelector(
        '[data-testid="generate-conversation-item"][data-conversation-id="conversation-0"]',
      ),
    );
    await settle();
    expect(find("generate-conversation")!.textContent).toContain(
      "Here is a deep bow.",
    );

    // Through setup and back: the same conversation, not the latest one.
    await click(find("generate-model-control"));
    await click(find("generate-model-setup"));
    expect(find("generate-conversation")).toBeNull();
    await click(find("generate-setup-done"));
    await settle();
    const conversation = find("generate-conversation")!.textContent;
    expect(conversation).toContain("Here is a deep bow.");
    expect(conversation).not.toContain("Here is a shy wave.");
  });

  it("runs at the effort saved for the model, and opens the model control from a failed run", async () => {
    server.model = { supported_reasoning_efforts: ["low", "medium", "high"] };
    server.generation = {
      model_provider_id: "model-1",
      reasoning_efforts: { "model-1": "high", "another-model": "low" },
    };
    server.snapshot = {
      ...server.snapshot,
      usage: generationUsage({
        input_tokens: 99_955,
        output_tokens: 2_260,
        requests: 5,
        runs: 1,
        last_run: {
          run_id: "run-0",
          model_provider_id: "model-1",
          plan: false,
          input_tokens: 99_955,
          cached_input_tokens: 0,
          output_tokens: 2_260,
          reasoning_tokens: 0,
          requests: 5,
          cost: null,
        },
      }),
    };
    await open();
    type("a hearty laugh");
    await click(find("generate-new-draft"));
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]).toMatchObject({
      message: "a hearty laugh",
      model_provider_id: "model-1",
      reasoning_effort: "high",
    });

    const stream = server.streams[0]!;
    stream.send(sseFrame("run.started", { run_id: "run-1" }));
    stream.send(
      sseFrame("run.failed", {
        code: "openai_rate_limit",
        category: "rate_limited",
        details: { connection_name: "OpenAI" },
      }),
    );
    stream.send(sseFrame("run.completed", { usage: { requests: 1 } }));
    stream.close();
    await settle();

    // Beside Try again, the failure offers the assistant's model control.
    expect(find("generate-retry")).not.toBeNull();
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    await click(find("generate-choose-model"));
    const control = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    )!;
    expect(control.textContent).toContain("Assistant model");
    // It shows the level in use and what the conversation has used so far.
    expect(find("generate-effort")!.dataset.effort).toBe("high");
    expect(find("generate-usage-last-run")!.textContent).toBe(
      "Last run: 99,955 input and 2,260 output tokens.",
    );
    expect(find("generate-usage-conversation")!.textContent).toBe(
      "This conversation: 99,955 input and 2,260 output tokens.",
    );

    // A run started with the control open closes it, and it stays closed
    // when that run ends.
    await click(find("generate-retry"));
    await settle();
    expect(server.runs).toHaveLength(2);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    await click(find("generate-stop"));
    await settle();
    expect(find("generate-send")).not.toBeNull();
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("reopens setup from the model control and returns to the workspace", async () => {
    await open();
    await click(find("generate-model-control"));
    await click(find("generate-model-setup"));
    expect(find("generate-setup")).not.toBeNull();
    expect(find("generate-conversation")).toBeNull();

    await click(find("generate-setup-done"));
    await settle();
    expect(find("generate-setup")).toBeNull();
    expect(find("generate-conversation")).not.toBeNull();
  });
});
