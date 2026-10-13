import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProductRuntimeProvider, useRuntimeOwnerId } from "@animama/product-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useProductChatSession,
  describeChatFailure,
  textOnlyChatEffects,
} from "@animama/product-ui/chat";
import { ChatConversation } from "@animama/product-ui/components";
import { queryKeys, useChatSse } from "@animama/product-ui/query";

// A separately bundled consumer: only package exports and browser primitives.
// The transport deliberately permits late responses to exercise cancellation races.
const requests = [];
const events = [];
const settled = [];
const histories = {};
let stopOnToken = false;
let run = 0;
let api;
let speechEnabled = false;
let speechModel = "eleven_v4_turbo";
let speechProvider = "elevenlabs";
let pocketFallback = true;
const speechSessions = [];
const speechFailures = [];
const speechFallbacks = [];
const ttsTokens = [];
const ttsCompletions = [];
const finalizedAudio = [];
const finalizedCompletions = [];
const transport = {
  baseUrl: "https://chat-fixture.invalid",
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.endsWith("/chat:sse")) {
      const model = {
        id: "fixture-model",
        model: "fixture-model",
        model_client: "OpenAIResponsesHTTPAgent",
        api_standard: "openai-responses",
        settings: {},
      };
      let data;
      if (path === "/v1/model-providers") data = [model];
      else if (path === "/v1/animas/anima-fixture")
        data = {
          id: "anima-fixture",
          name: "Annie",
          chat_profile: { default_model_provider_id: model.id },
        };
      else if (path.endsWith("/messages"))
        data = { messages: histories[path.split("/").at(-2)] ?? [] };
      else if (path.startsWith("/v1/chats/"))
        data = { id: path.split("/").at(-1), anima_id: "anima-fixture" };
      else
        throw new Error(
          `Unexpected fixture request: ${request.method} ${path}`,
        );
      return Response.json(data);
    }
    const body = await request.clone().json();
    return new Promise((resolve) => {
      const entry = { request, body, resolve, cancelled: false };
      entry.stream = new ReadableStream({
        start(controller) {
          entry.controller = controller;
        },
        cancel() {
          entry.cancelled = true;
        },
      });
      requests.push(entry);
    });
  },
};

function Consumer() {
  const { startChat, stop, isStreaming } = useChatSse();
  const owner = useRuntimeOwnerId();
  const [transcript, setTranscript] = useState("");
  api = { startChat, stop };
  function start() {
    const run_id = `run-${++run}`;
    void startChat({
      animaId: "anima-fixture",
      body: { message: "hello", run_id, runtime_revision: "revision-fixture" },
      onOpen: () => events.push(["open", run_id]),
      onToken: (text) => {
        events.push(["token", text]);
        setTranscript((old) => old + text);
        if (stopOnToken) stop();
      },
      onComplete: (data) => events.push(["complete", data.run_id]),
      onError: (error) => events.push(["error", error.message ?? error.error]),
      onEmotionUpdate: () => events.push(["emotion"]),
      onChatTitleUpdated: () => events.push(["title"]),
      onAvatarGestureRequested: () => events.push(["gesture"]),
      onMemoryUpdated: (cue, data) =>
        events.push([
          "memory",
          data.run_id,
          cue.episode?.text ?? null,
          cue.memories?.entry_id ?? null,
        ]),
    }).finally(() => settled.push(run_id));
  }
  return (
    <main>
      <span id="owner">{owner}</span>
      <button id="start" onClick={start}>
        Start
      </button>
      <button id="stop" disabled={!isStreaming} onClick={stop}>
        Stop
      </button>
      <output id="streaming">{String(isStreaming)}</output>
      <output id="transcript">{transcript}</output>
    </main>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const runtime = {
  runtimeRevision: "revision-fixture",
  canChat: true,
  remountLatest: () => {},
};
function SessionConsumer() {
  const owner = useRuntimeOwnerId();
  const [chatId, setChatId] = useState("chat-fixture");
  const session = useProductChatSession({
    animaId: "anima-fixture",
    routeChatId: chatId,
    runtime,
    speech: speechEnabled
      ? {
          enabled: true,
          provider: speechProvider,
          elevenLabsModelId:
            speechProvider === "elevenlabs" ? speechModel : null,
          finalizedServerAudio: speechProvider === "gemini",
        }
      : undefined,
    effects: {
      ...textOnlyChatEffects,
      acceptElevenLabsSession: (runId, value) =>
        speechSessions.push({ runId, value }),
      markElevenLabsSessionFailed: (runId, error) =>
        speechFailures.push({ runId, error }),
      markFinalizedAudioFailed: (runId, error) =>
        speechFailures.push({ runId, error }),
      acceptFinalizedAudio: (runId, payload) =>
        finalizedAudio.push({ runId, provider: payload.provider }),
      completeFinalizedAudio: (runId) => finalizedCompletions.push(runId),
      // The playback adapter speaks a declined run with Pocket TTS if it can.
      fallBackToPocketTts: (runId) => {
        speechFallbacks.push(runId);
        return pocketFallback;
      },
      appendTtsToken: (runId, token) => ttsTokens.push({ runId, token }),
      completeTtsRun: (runId) => ttsCompletions.push(runId),
    },
    openDraftChatRoute: () => {},
    replaceChatRoute: () => {},
  });
  api = {
    ...session,
    stop: session.handleStop,
    switchChat: () => setChatId("chat-other"),
  };
  return (
    <main>
      <span id="owner">{owner}</span>
      <textarea
        id="draft"
        value={session.input}
        onChange={(event) => session.setInput(event.target.value)}
      />
      <button
        id="submit"
        disabled={!session.canChat || session.isStreaming}
        onClick={() => session.handleSubmit()}
      >
        Send
      </button>
      <button
        id="stop"
        disabled={!session.isStreaming}
        onClick={session.handleStop}
      >
        Stop
      </button>
      <output id="streaming">{String(session.isStreaming)}</output>
      <output id="finalizing">
        {String(session.isAwaitingStreamingAnimationFinalization)}
      </output>
      <ChatConversation
        messages={session.displayMessages}
        markdownEnabled
        isStreaming={session.isStreaming}
        completionPending={session.isAwaitingStreamingAnimationFinalization}
        onQueueComplete={session.handleStreamingAnimationComplete}
        onRestoreMessage={session.restoreFailedMessage}
        restoreDisabled={Boolean(session.input.trim())}
        renderAssistantAccessory={(message) =>
          message.memoryCue ? (
            <span data-memory-cue={message.id}>
              {message.memoryCue.memories?.entry_id ??
                message.memoryCue.episode?.text}
            </span>
          ) : null
        }
      />
    </main>
  );
}

const root = createRoot(document.getElementById("root"));
function mount(owner = "owner-fixture", session = false, sessionKey = owner) {
  root.render(
    <ProductRuntimeProvider
      owner={{ id: owner }}
      sessionKey={sessionKey}
      capabilities={{ chat: true }}
      transport={transport}
    >
      <QueryClientProvider client={queryClient}>
        {session ? <SessionConsumer /> : <Consumer />}
      </QueryClientProvider>
    </ProductRuntimeProvider>,
  );
}
window.fixture = {
  mount,
  enableSpeech: ({
    model = "eleven_v4_turbo",
    provider = "elevenlabs",
    fallback = true,
  } = {}) => {
    speechEnabled = true;
    speechModel = model;
    speechProvider = provider;
    pocketFallback = fallback;
    mount("owner-fixture", true);
  },
  speechSessions: () => speechSessions,
  speechFailures: () => speechFailures,
  speechFallbacks: () => speechFallbacks,
  ttsTokens: () => ttsTokens,
  ttsCompletions: () => ttsCompletions,
  finalizedAudio: () => finalizedAudio,
  finalizedCompletions: () => finalizedCompletions,
  mountSession: (sessionKey = "owner-fixture") =>
    mount("owner-fixture", true, sessionKey),
  seedSessionCaches: (key) => {
    queryClient.setQueryData(queryKeys.chats.list(key), [
      { id: "chat-fixture", title: "Before" },
    ]);
    queryClient.setQueryData(
      [...queryKeys.animas.all(key), "fixture"],
      [{ id: "anima-fixture", emotional_state: { joy: 0 } }],
    );
    queryClient.setQueryData(queryKeys.memoryEntries.all(key), []);
    queryClient.setQueryData(queryKeys.memoryEpisodes.all(key), []);
    queryClient.setQueryData(
      queryKeys.animaLoadouts.runtime(key, "anima-fixture"),
      { revision: "before" },
    );
  },
  sessionCaches: (key) => ({
    messages: queryClient.getQueryData(
      queryKeys.chats.messages(key, "chat-fixture"),
    ),
    title: queryClient.getQueryData(queryKeys.chats.list(key))?.[0]?.title,
    joy: queryClient.getQueryData([
      ...queryKeys.animas.all(key),
      "fixture",
    ])?.[0]?.emotional_state?.joy,
    invalidated: [
      queryKeys.memoryEntries.all(key),
      queryKeys.memoryEpisodes.all(key),
      queryKeys.animaLoadouts.runtime(key, "anima-fixture"),
      queryKeys.chats.list(key),
    ].map((queryKey) => queryClient.getQueryState(queryKey)?.isInvalidated),
  }),
  switchChat: () => api.switchChat(),
  setHistory: (chatId, messages) => {
    histories[chatId] = messages;
  },
  // Memory workspace caches a chat turn's memory writes should mark stale.
  seedMemoryCaches: () => {
    queryClient.setQueryData(
      queryKeys.memoryEntries.detail("owner-fixture", "mem-annie"),
      { id: "mem-annie", version: 1 },
    );
    queryClient.setQueryData(queryKeys.memoryEpisodes.all("owner-fixture"), {
      items: [],
    });
  },
  memoryCachesInvalidated: () =>
    [
      queryKeys.memoryEntries.detail("owner-fixture", "mem-annie"),
      queryKeys.memoryEpisodes.all("owner-fixture"),
    ].map((key) => queryClient.getQueryState(key)?.isInvalidated ?? null),
  describeFailure: describeChatFailure,
  unmount: () => root.unmount(),
  stop: () => api.stop(),
  requests: () =>
    requests.map(({ request, body, cancelled }) => ({
      url: request.url,
      method: request.method,
      body,
      aborted: request.signal.aborted,
      cancelled,
      authorization: request.headers.get("authorization"),
    })),
  events: () => events,
  settled: () => settled,
  stopOnToken: () => {
    stopOnToken = true;
  },
  respond: (index, status = 200, body = { detail: "fixture error" }) =>
    requests[index].resolve(
      new Response(
        status === 200 ? requests[index].stream : JSON.stringify(body),
        {
          status,
          headers: {
            "Content-Type":
              status === 200 ? "text/event-stream" : "application/json",
          },
        },
      ),
    ),
  send: (index, data) =>
    requests[index].controller.enqueue(
      new TextEncoder().encode(
        data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      ),
    ),
  close: (index) => requests[index].controller.close(),
  fail: (index) =>
    requests[index].controller.error(new Error("fixture transport failed")),
};
mount();
