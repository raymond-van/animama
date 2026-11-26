import type { ReactNode } from "react";
import { renderToStaticMarkup } from "@/test/runtime-markup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachmentHold } from "@animama/product-ui/chat";

import { hostedExclusionReasons } from "@/app/runtime/route-admission";
import type { UserFileUploadUppy } from "@/hooks/useUserFileUpload";
import { ChatInterfaceView } from "@/ui/main/chat/ChatInterface";

const fixture = vi.hoisted(() => ({
  capabilities: undefined as Record<string, unknown> | undefined,
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
vi.mock("@/lib/speech/stt-provider", () => ({
  isWebSpeechSupported: () => true,
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
// The real withheld attach control renders; the uploader and composer are fixtures.
vi.mock("@/ui/components/chat-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/components/chat-input")>()),
  ChatInput: ({
    leadingActions,
    actions,
    children,
  }: {
    leadingActions?: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
  }) => (
    <>
      {leadingActions}
      {children}
      {actions}
    </>
  ),
  ChatInputDictation: () => null,
  ChatInputFileUploadButton: () => <button>Attach files</button>,
  ChatInputModelSelector: () => null,
  ChatInputSubmit: ({ attachmentHold }: { attachmentHold?: string }) => (
    <output>Send hold: {attachmentHold ?? "none"}</output>
  ),
  ChatInputTextArea: () => null,
}));
vi.mock("@/ui/components/chat-input-file-tray", () => ({
  ChatInputFileTray: () => <div>Upload tray</div>,
}));
vi.mock("./ChatFileDropOverlay", () => ({
  ChatFileDropOverlay: ({ enabled }: { enabled: boolean }) =>
    enabled ? <div>Drop files</div> : null,
}));

function render(attachmentHold?: ChatAttachmentHold) {
  return renderToStaticMarkup(
    <ChatInterfaceView
      attachmentHold={attachmentHold}
      animaId="annie"
      animaName="Annie"
      activeChat={null}
      activeMode={null}
      canChat
      displayMessages={[]}
      fileUploadUppy={{} as UserFileUploadUppy}
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

describe("chat file upload entry points", () => {
  beforeEach(() => {
    fixture.capabilities = undefined;
  });

  it.each([["reported", { chat_file_uploads: true }]])(
    "are offered when uploads are %s",
    (_label, capabilities) => {
      fixture.capabilities = capabilities;
      const html = render();
      expect(html).toContain("Attach files");
      expect(html).toContain("Upload tray");
      expect(html).toContain("Drop files");
      expect(html).not.toContain(hostedExclusionReasons.chat_file_uploads);
    },
  );

  it("are hidden while capabilities are unreadable", () => {
    const html = render();
    expect(html).not.toContain("Attach files");
    expect(html).not.toContain("Add files");
    expect(html).not.toContain("Upload tray");
    expect(html).not.toContain("Drop files");
  });

  it("keep a disabled attach button with the shared reason when uploads are withheld", () => {
    fixture.capabilities = { chat_file_uploads: false };
    const html = render();
    // No uploader: no live picker, tray or page-wide drop target.
    expect(html).not.toContain("Attach files");
    expect(html).not.toContain("Upload tray");
    expect(html).not.toContain("Drop files");
    const attach = html.match(
      /<button[^>]*>(?:(?!<\/button>).)*Add files/s,
    )?.[0];
    expect(attach).toContain('aria-disabled="true"');
    expect(attach).toContain('type="button"');
    const reasonId = attach?.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(html).toContain(
      `id="${reasonId}" class="sr-only">${hostedExclusionReasons.chat_file_uploads}<`,
    );
  });

  it("give the send control the attachments' hold", () => {
    fixture.capabilities = { chat_file_uploads: true };
    expect(render()).toContain("Send hold: none");
    expect(render("waiting")).toContain("Send hold: waiting");
    expect(render("blocked")).toContain("Send hold: blocked");
  });
});
