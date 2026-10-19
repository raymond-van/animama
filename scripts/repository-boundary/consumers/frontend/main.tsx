import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductRuntimeProvider } from "@animama/product-ui";
import { resolveLocale, type HostedLocaleInput } from "@animama/runtime-contracts/locale";
import { useAnimas } from "@animama/product-ui/query";
import { useProductChatSession, textOnlyChatEffects } from "@animama/product-ui/chat";
import { AnimaSelection, ChatConversation, ChatInput, ChatInputTextArea, ChatInputSubmit } from "@animama/product-ui/components";
import "@animama/product-ui/styles.css";
import { evidence, fixtureTransport, type Scope } from "./fixtures";

declare global {
  interface Window { consumerEvidence: typeof evidence; consumerLocales: typeof consumerLocales }
}
window.consumerEvidence = evidence;

// Both the declaration and runtime export must work from the installed tarball.
const hostedLocale: HostedLocaleInput = { preference: null, visitor: "ja" };
const consumerLocales = {
  visitor: resolveLocale({ saved: hostedLocale.preference, visitor: hostedLocale.visitor, preferred: ["ko-KR"] }),
  savedEnglish: resolveLocale({ saved: "en", visitor: hostedLocale.visitor, preferred: ["ko-KR"] }),
  systemDefault: resolveLocale({ saved: null, visitor: null, preferred: ["fr-FR", "zh-TW"] }),
  invalidHints: resolveLocale({ saved: "en-US", visitor: "ja-JP", preferred: ["zh-Hans-HK"] }),
  fallback: resolveLocale({ preferred: ["fr-FR"] }),
};
window.consumerLocales = consumerLocales;

/** The consumer owns routing and the issued fence; it contains no session implementation. */
function Conversation({ scope, onStreaming }: { scope: Scope; onStreaming: (value: boolean) => void }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const runtime = useMemo(() => ({
    runtimeRevision: `fixture-revision-${scope}`,
    canChat: true,
    remountLatest: async () => undefined,
  }), [scope]);
  const effects = useMemo(() => ({
    ...textOnlyChatEffects,
    requestAvatarGesture: (request: { gesture?: string | null }) => {
      if (request.gesture) evidence.acceptedGestures.push(request.gesture);
    },
  }), []);
  const session = useProductChatSession({
    animaId: `${scope}-anima`, routeChatId: chatId, runtime, effects,
    openDraftChatRoute: () => setChatId(null), replaceChatRoute: setChatId,
  });
  useEffect(() => {
    onStreaming(session.isStreaming || session.isAwaitingStreamingAnimationFinalization);
  }, [session.isStreaming, session.isAwaitingStreamingAnimationFinalization, onStreaming]);
  return <>
    <ChatConversation
      messages={session.displayMessages}
      isStreaming={session.isStreaming}
      completionPending={session.isAwaitingStreamingAnimationFinalization}
      onQueueComplete={session.handleStreamingAnimationComplete}
      markdownEnabled={scope === "hosted"}
      layout="chat-only"
    />
    <ChatInput value={session.input} onChange={(event) => session.setInput(event.target.value)}
      onSubmit={session.handleSubmit} loading={session.isStreaming}
      onStop={session.handleStop} disabled={!session.canChat}
      voiceAvailable={false} actions={<ChatInputSubmit />}>
      <ChatInputTextArea aria-label="Message" />
    </ChatInput>
  </>;
}

function ProductPane({ scope }: { scope: Scope }) {
  const { data: animas = [] } = useAnimas();
  const [selected, setSelected] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  return <section data-testid={scope} data-streaming={streaming}
    style={{ border: "1px solid #cbd5e1", borderRadius: 12, padding: 24, minWidth: 0 }}>
    <h1>{scope === "local" ? "Local fake owner" : "Hosted fake owner"}</h1>
    <AnimaSelection animas={animas} selectedAnimaId={selected} onSelect={setSelected} />
    {selected ? <Conversation key={selected} scope={scope} onStreaming={setStreaming} /> : <p>Select an Anima.</p>}
  </section>;
}

const providers = (["local", "hosted"] as const).map((scope) => ({
  scope,
  owner: { id: scope === "local" ? "11111111-1111-4111-8111-111111111111" : "hosted-user-fixture" },
  queryClient: new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
  transport: fixtureTransport(scope),
}));
createRoot(document.getElementById("root")!).render(
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, padding: 24 }}>
    {providers.map(({ scope, owner, queryClient, transport }) =>
      <QueryClientProvider key={scope} client={queryClient}>
        <ProductRuntimeProvider owner={owner} capabilities={{ chat: true }} transport={transport}>
          <ProductPane scope={scope} />
        </ProductRuntimeProvider>
      </QueryClientProvider>) }
  </div>,
);
