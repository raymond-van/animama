// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { GeneratePage } from "./GeneratePage";
import {
  controlledSseResponse,
  generationConversation,
  generationDraft,
  generationMessage,
  generationSnapshot,
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
  GeneratePreviewProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
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
      },
    ]);
  if (pathname === "/v1/users/me/settings")
    return jsonResponse({
      preferences: { generation: { model_provider_id: "model-1" } },
    });
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
  fixture.player = [];
  fixture.workerInput = null;
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
