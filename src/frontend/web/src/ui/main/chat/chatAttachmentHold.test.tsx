// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  textOnlyChatEffects,
  useProductChatSession,
  type ChatAttachmentHold,
} from "@animama/product-ui/chat";
import { ChatInputTextArea } from "@animama/product-ui/components";
import { queryKeys } from "@animama/product-ui/query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeOwnerProvider } from "@/app/runtime/RuntimeOwnerContext";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: toastError }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionKey = "session";
const QUESTION = "What does the report say about costs?";

/** Let queued state updates and promise continuations run. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

type Session = ReturnType<typeof useProductChatSession>;
type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
  respond: (response: Response) => void;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hold: ChatAttachmentHold = "none";
let attached: string[] = [];
let submitted: string[][] = [];
let recorded: RecordedRequest[] = [];
let view: { session: Session | null } = { session: null };

/** `METHOD /path` of each request so far. */
const requests = () => recorded.map(({ method, path }) => `${method} ${path}`);

/** The mounted session, as of its latest render. */
function session(): Session {
  if (!view.session) throw new Error("The composer did not render.");
  return view.session;
}

/** Mount a composer text area wired to the session, as the chat panel is. */
function mount() {
  const mounted: { session: Session | null } = { session: null };
  function Composer() {
    const chat = useProductChatSession({
      animaId: "anima-1",
      runtime: {
        runtimeRevision: "revision",
        canChat: true,
        remountLatest: async () => {},
      },
      effects: textOnlyChatEffects,
      getAttachedFileIds: () => attached,
      getAttachmentHold: () => hold,
      onAttachmentsSubmitted: (fileIds) => submitted.push(fileIds),
      describeAttachedImages: (fileIds) =>
        fileIds
          .filter((fileId) => fileId.startsWith("image"))
          .map((fileId) => ({ fileId, name: `${fileId}.png` })),
      openDraftChatRoute: () => {},
      replaceChatRoute: () => {},
    });
    mounted.session = chat;
    return (
      <ChatInputTextArea
        value={chat.input}
        onChange={(event) => chat.setInput(event.target.value)}
        onSubmit={() => {
          void chat.handleSubmit();
        }}
      />
    );
  }
  const transport = {
    baseUrl: "https://chat-fixture.invalid",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.text();
      // A request waits until a test responds; a sent turn only has to start.
      return new Promise<Response>((respond) => {
        recorded.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: body ? JSON.parse(body) : null,
          respond,
        });
      });
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.animas.detail(sessionKey, "anima-1"), {
    id: "anima-1",
    name: "Annie",
    chat_profile: { default_model_provider_id: "model-a" },
  });
  queryClient.setQueryData(queryKeys.modelProviders.all(sessionKey), [
    {
      id: "model-a",
      model: "model-a",
      model_kind: "chat",
      model_client: "OpenAIResponsesHTTPAgent",
      api_standard: "openai-responses",
      settings: {},
    },
  ]);
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={queryClient}>
        <RuntimeOwnerProvider
          ownerId="owner"
          sessionKey={sessionKey}
          transport={transport}
        >
          <Composer />
        </RuntimeOwnerProvider>
      </QueryClientProvider>,
    );
  });
  return mounted;
}

function textarea(): HTMLTextAreaElement {
  const element = container?.querySelector("textarea:not([aria-hidden])");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("The composer text area did not render.");
  }
  return element;
}

/** Settle until `find` returns a value, for steps that take several turns. */
async function settleUntil<T>(find: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = find();
    if (found !== undefined) return found;
    await settle();
  }
  throw new Error("The expected state never arrived.");
}

async function pressEnter() {
  act(() => {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}

/** Send the typed turn into a new chat and return its pending `chat:sse` request. */
async function openTurn(): Promise<RecordedRequest> {
  await pressEnter();
  await act(async () => {
    recorded[0].respond(
      Response.json({ id: "chat-new", anima_id: "anima-1", title: null }),
    );
  });
  return settleUntil(() =>
    recorded.find(({ path }) => path.endsWith("/chat:sse")),
  );
}

beforeEach(() => {
  hold = "none";
  attached = [];
  submitted = [];
  recorded = [];
  view = mount();
  act(() => session().setInput(QUESTION));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("a send held by its attachments", () => {
  it("keeps the typed message and sends nothing while files are not ready", async () => {
    hold = "waiting";
    await pressEnter();

    expect(textarea().value).toBe(QUESTION);
    expect(session().input).toBe(QUESTION);
    expect(requests()).toEqual([]);
    expect(toastError).toHaveBeenCalledWith(
      "Attached files are not ready yet.",
    );
  });

  it("asks for unreadable files to be removed and keeps the message", async () => {
    hold = "blocked";
    await pressEnter();

    expect(textarea().value).toBe(QUESTION);
    expect(requests()).toEqual([]);
    expect(toastError).toHaveBeenCalledWith(
      "Remove unreadable files before sending.",
    );
  });

  it("reports a held Voice Mode turn as not accepted", async () => {
    hold = "waiting";
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await session().handleSubmitText({
        text: "Read me the summary",
        inputMode: "voice",
        submitReason: "semantic_end_turn",
      });
    });

    expect(accepted).toBe(false);
    expect(session().input).toBe(QUESTION);
    expect(requests()).toEqual([]);
    expect(toastError).toHaveBeenCalledWith(
      "Attached files are not ready yet.",
    );
  });

  it("sends once the attachments are readable", async () => {
    hold = "waiting";
    await pressEnter();
    expect(requests()).toEqual([]);

    hold = "none";
    await pressEnter();

    expect(session().input).toBe("");
    expect(requests()).toEqual(["POST /v1/chats"]);
  });

  it("sends only the attachments that were readable when the turn was accepted", async () => {
    attached = ["file-ready"];
    await pressEnter();
    expect(requests()).toEqual(["POST /v1/chats"]);

    // A file added while the chat is being created is not readable yet.
    attached = ["file-ready", "file-new"];
    hold = "waiting";
    await act(async () => {
      recorded[0].respond(
        Response.json({ id: "chat-new", anima_id: "anima-1", title: null }),
      );
    });
    const turn = await settleUntil(() =>
      recorded.find(({ path }) => path.endsWith("/chat:sse")),
    );

    expect(turn.body).toMatchObject({ attached_file_ids: ["file-ready"] });
  });

  it("tells the host which attachments a turn carried once the turn completes", async () => {
    attached = ["image-1", "file-doc"];
    const turn = await openTurn();
    expect(session().input).toBe("");
    const runId = (turn.body as { run_id: string }).run_id;
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const send = (data: unknown) =>
      writer.write(
        new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`),
      );
    await act(async () => {
      turn.respond(
        new Response(stream.readable, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      await send({ text: "A red square.", run_id: runId });
    });
    await settleUntil(() =>
      session().displayMessages.some((message) => message.role === "assistant")
        ? true
        : undefined,
    );
    // The reply has started, but the turn is not saved yet.
    expect(submitted).toEqual([]);

    await act(async () => {
      await send({ chat_id: "chat-new", run_id: runId });
      await writer.close();
    });
    await settleUntil(() => (submitted.length > 0 ? true : undefined));

    expect(submitted).toEqual([["image-1", "file-doc"]]);
  });

  it("keeps the attachments of a turn that fails after its reply starts", async () => {
    attached = ["image-1"];
    const turn = await openTurn();
    const runId = (turn.body as { run_id: string }).run_id;

    await act(async () => {
      turn.respond(
        new Response(
          [
            `data: ${JSON.stringify({ text: "A red", run_id: runId })}`,
            `data: ${JSON.stringify({ error: "upstream failed", code: "provider_error", run_id: runId })}`,
            "",
            "",
          ].join("\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    });
    await settleUntil(() =>
      session().displayMessages.some((message) => message.failure)
        ? true
        : undefined,
    );

    expect(submitted).toEqual([]);
  });

  it("keeps the attachments of a turn the server refuses", async () => {
    attached = ["image-1"];
    const turn = await openTurn();

    await act(async () => {
      turn.respond(
        Response.json(
          {
            detail: {
              code: "model_does_not_accept_images",
              message: "This model does not accept images.",
            },
          },
          { status: 400 },
        ),
      );
    });
    await settleUntil(() =>
      session().displayMessages.some((message) => message.failure)
        ? true
        : undefined,
    );

    expect(submitted).toEqual([]);
  });

  it("tells the host nothing for a held turn", async () => {
    attached = ["image-1"];
    hold = "waiting";
    await pressEnter();

    expect(session().input).toBe(QUESTION);
    expect(submitted).toEqual([]);
  });
});

describe("images sent with a turn", () => {
  const sentMessage = () =>
    session().displayMessages.find(
      (message) => message.role === "user" && message.text === QUESTION,
    );

  it("shows the turn's images with its message before and after history confirms it", async () => {
    attached = ["image-1", "file-doc"];
    const turn = await openTurn();
    expect(sentMessage()?.images).toEqual([
      { fileId: "image-1", name: "image-1.png" },
    ]);

    const runId = (turn.body as { run_id: string }).run_id;
    await act(async () => {
      turn.respond(
        new Response(
          [
            `data: ${JSON.stringify({ text: "A red square.", run_id: runId })}`,
            `data: ${JSON.stringify({ chat_id: "chat-new", run_id: runId })}`,
            "",
            "",
          ].join("\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    });
    await settleUntil(() => (session().isStreaming ? undefined : true));
    act(() => session().handleStreamingAnimationComplete());
    await settle();

    expect(sentMessage()?.images).toEqual([
      { fileId: "image-1", name: "image-1.png" },
    ]);
  });

  it("shows no image list for a turn with documents only", async () => {
    attached = ["file-doc"];
    await openTurn();

    expect(sentMessage()).toBeDefined();
    expect(sentMessage()?.images).toBeUndefined();
  });
});
