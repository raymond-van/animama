import type { ReactNode } from "react";
import { renderToStaticMarkup } from "@/test/runtime-markup";
import { describe, expect, it, vi } from "vitest";

import { ChatInterfaceView } from "@/ui/main/chat/ChatInterface";

vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: {} }),
}));
vi.mock("@/query/hooks/useAnima", () => ({ useAnima: () => ({}) }));
vi.mock("@/query/hooks/useModelProviders", () => ({
  useModelProviders: () => ({}),
}));
// Whether the Anima's model has a key is covered by its own tests.
vi.mock("./useAnimaModelKeyState", () => ({
  useAnimaModelKeyState: () => null,
}));
// The desktop app has global shortcuts, so tooltips name them.
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => ({ isDesktop: true, os: "darwin" }),
}));
vi.mock("@/lib/speech/stt-provider", () => ({
  isWebSpeechSupported: () => true,
}));
vi.mock("@/lib/speech/composer-speech-engines", () => ({
  composerSpeechEngines: () => ({ dictation: null, voiceMode: null }),
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({ effectivePreferences: {} }),
}));
vi.mock("@/ui/components/chat-transcript", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ChatTranscript: Pass,
    ChatTranscriptContent: Pass,
    ChatTranscriptScrollButton: () => null,
  };
});
vi.mock("@/ui/components/chat-input", () => ({
  ChatInput: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ChatInputDictation: () => null,
  ChatInputFileUploadButton: () => null,
  ChatInputFileUploadUnavailable: () => null,
  ChatInputModelSelector: () => null,
  ChatInputSubmit: () => null,
  ChatInputTextArea: () => null,
}));

const messages = [
  { id: "a1", role: "assistant" as const, text: "Earlier reply" },
  { id: "u1", role: "user" as const, text: "Hello" },
  { id: "a2", role: "assistant" as const, text: "Latest reply" },
];

function render(props: { ttsAudioActive: boolean; onSkipTts?: () => void }) {
  return renderToStaticMarkup(
    <ChatInterfaceView
      animaId="annie"
      animaName="Annie"
      activeChat={null}
      activeMode={null}
      canChat
      displayMessages={messages}
      input=""
      inputPlaceholder="Message"
      isAwaitingStreamingAnimationFinalization={false}
      isStreaming={false}
      onIncompatibleModelSelect={vi.fn()}
      onInputChange={vi.fn()}
      onPromptSuggestionSelect={vi.fn()}
      onStop={vi.fn()}
      onStreamingAnimationComplete={vi.fn()}
      onSubmit={vi.fn()}
      promptSuggestions={[]}
      showPromptSuggestions={false}
      layout="chat-only"
      {...props}
    />,
  );
}

describe("skipping a spoken reply from its bubble", () => {
  it("offers the skip only below the latest reply while it is spoken", () => {
    const html = render({ ttsAudioActive: true, onSkipTts: vi.fn() });
    expect(html.match(/aria-label="Skip speech"/gu)).toHaveLength(1);
    expect(html.indexOf('aria-label="Skip speech"')).toBeGreaterThan(
      html.indexOf("Latest reply"),
    );
  });

  it("is absent when nothing is spoken or the host cannot skip", () => {
    expect(render({ ttsAudioActive: false, onSkipTts: vi.fn() })).not.toContain(
      "Skip speech",
    );
    expect(render({ ttsAudioActive: true })).not.toContain("Skip speech");
  });
});
