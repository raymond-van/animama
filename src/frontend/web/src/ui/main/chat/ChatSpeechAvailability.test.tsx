import type { ReactNode } from "react";
import { getI18n } from "react-i18next";
import { renderToStaticMarkup } from "@/test/runtime-markup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInterfaceView } from "@/ui/main/chat/ChatInterface";

const fixture = vi.hoisted(() => ({
  capabilities: {} as Record<string, unknown>,
  /** This window hosts App Settings (the main window does; Quick Chat does not). */
  settingsHost: false,
}));

// Static rendering reads a store's initial state, so the opener is supplied.
vi.mock("@/stores/app-settings-request-store", () => ({
  useAppSettingsOpener: () => (fixture.settingsHost ? () => undefined : null),
}));

vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: fixture.capabilities }),
}));
vi.mock("@/query/hooks/useAnima", () => ({ useAnima: () => ({}) }));
vi.mock("@/query/hooks/useModelProviders", () => ({
  useModelProviders: () => ({}),
}));
// Whether the Anima's model has a key is covered by its own tests.
vi.mock("./useAnimaModelKeyState", () => ({
  useAnimaModelKeyState: () => null,
}));
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => ({}),
}));
// Neither offline speech nor browser speech recognition is available.
vi.mock("@/lib/speech/stt-provider", () => ({
  isWebSpeechSupported: () => false,
}));
vi.mock("@/lib/speech/composer-speech-engines", () => ({
  composerSpeechEngines: () => ({ dictation: null, voiceMode: null }),
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({ effectivePreferences: {} }),
}));
vi.mock("@animama/product-ui/components", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@animama/product-ui/components")>()),
  ChatConversation: () => null,
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
  ChatInput: ({
    actions,
    children,
    voiceAvailable,
    voiceModeDetails,
  }: {
    actions?: ReactNode;
    children?: ReactNode;
    voiceAvailable?: boolean;
    voiceModeDetails?: readonly string[] | null;
  }) => (
    <>
      <div>
        {voiceAvailable ? "Voice Mode enabled" : "Voice Mode disabled"}
        {voiceModeDetails?.join(" ")}
      </div>
      {actions}
      {children}
    </>
  ),
  ChatInputDictation: ({
    disabled,
    onSetUp,
  }: {
    disabled?: boolean;
    onSetUp?: (() => void) | null;
  }) => (
    <div>
      {disabled
        ? "Dictation disabled"
        : onSetUp
          ? "Dictation set-up"
          : "Dictation enabled"}
    </div>
  ),
  ChatInputFileUploadButton: () => null,
  ChatInputFileUploadUnavailable: () => null,
  ChatInputModelSelector: () => null,
  ChatInputSubmit: () => null,
  ChatInputTextArea: () => null,
}));

function render(quickChatSurface = false) {
  return renderToStaticMarkup(
    <ChatInterfaceView
      quickChatSurface={quickChatSurface}
      animaId="annie"
      animaName="Annie"
      activeChat={null}
      activeMode={null}
      canChat
      displayMessages={[]}
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
    />,
  );
}

describe("speech recognition availability in the composer", () => {
  beforeEach(() => {
    fixture.capabilities = {};
    fixture.settingsHost = false;
  });
  afterEach(async () => {
    await getI18n().changeLanguage("en");
  });

  it("disables dictation without an install prompt when speech is unavailable", () => {
    fixture.capabilities = {
      offline_speech_enabled: false,
      local_filesystem_administration: true,
    };
    const html = render();
    expect(html).toContain("Dictation disabled");
    expect(html).not.toMatch(/offline speech recognition/i);
  });

  it("leads to Speech-to-Text settings where the owner can install a model", () => {
    fixture.capabilities = {
      offline_speech_enabled: false,
      local_filesystem_administration: true,
    };
    fixture.settingsHost = true;
    const html = render();
    expect(html).toContain("Dictation set-up");
    expect(html).toContain("Voice Mode enabled");
    expect(html).toContain(
      "Speech recognition needs a model. Select to open App Settings → Voice.",
    );
    // Quick Chat has no App Settings to open, so its controls stay disabled.
    const quickChat = render(true);
    expect(quickChat).toContain("Dictation disabled");
    expect(quickChat).toContain("Voice Mode disabled");
  });

  it("stays disabled where the operator provides the speech models", () => {
    fixture.capabilities = { offline_speech_enabled: false };
    fixture.settingsHost = true;
    const html = render();
    expect(html).toContain("Dictation disabled");
    expect(html).toContain("Voice Mode disabled");
  });

  it("starts speech as before once a model is installed", () => {
    fixture.capabilities = {
      offline_speech_enabled: true,
      local_filesystem_administration: true,
    };
    fixture.settingsHost = true;
    const html = render();
    expect(html).toContain("Dictation enabled");
    expect(html).not.toContain("Speech recognition needs a model");
  });

  it("follows the UI Locale's offline engine", async () => {
    fixture.capabilities = {
      offline_speech_enabled: true,
      offline_multilingual_speech_enabled: false,
      local_filesystem_administration: true,
    };
    expect(render()).toContain("Dictation enabled");
    await getI18n().changeLanguage("ja");
    expect(render()).toContain("Dictation disabled");
    fixture.capabilities.offline_multilingual_speech_enabled = true;
    expect(render()).toContain("Dictation enabled");
  });
});
