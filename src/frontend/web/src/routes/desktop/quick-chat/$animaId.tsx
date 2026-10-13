"use client";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { CompanionSafetyView } from "@/ui/safety/CompanionSafetyView";

import {
  useDesktopQuickChatConsumer,
  useDesktopQuickChatInteractiveRegions,
} from "@/hooks/useDesktopQuickChatRuntime";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { ChatInterfaceView } from "@/ui/main/chat/ChatInterface";
import { SettingsProvider } from "@/ui/settings/SettingsProvider";
import { toast } from "sonner";

function isDesktopQuickChatWindow(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.animamaDesktop;
  return Boolean(
    bridge?.isDesktop && bridge.windowRole === "quick-chat" && bridge.quickChat,
  );
}

export const Route = createFileRoute("/desktop/quick-chat/$animaId")({
  beforeLoad: () => {
    if (!isDesktopQuickChatWindow()) throw redirect({ to: "/" });
  },
  component: DesktopQuickChatRoute,
});

function useTransparentQuickChatDocument() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const appRoot = document.getElementById("root");
    root.setAttribute("data-animama-quick-chat", "true");
    body.setAttribute("data-animama-quick-chat", "true");
    appRoot?.setAttribute("data-animama-quick-chat", "true");

    return () => {
      root.removeAttribute("data-animama-quick-chat");
      body.removeAttribute("data-animama-quick-chat");
      appRoot?.removeAttribute("data-animama-quick-chat");
    };
  }, []);
}

function focusQuickChatInput() {
  let timeoutId: number | null = null;
  const frameId = window.requestAnimationFrame(() => {
    timeoutId = window.setTimeout(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        "[data-quick-chat-input]",
      );
      if (!textarea || textarea.disabled) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
  });

  return () => {
    window.cancelAnimationFrame(frameId);
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}

function DesktopQuickChatRoute() {
  const { animaId } = Route.useParams();
  const platform = useRuntimePlatform();
  const isQuickChatWindow =
    platform.kind === "desktop" &&
    platform.desktopBridge.windowRole === "quick-chat";
  const { close, focusInputSignal, sendCommand, snapshot } =
    useDesktopQuickChatConsumer(animaId);
  const [draftInput, setDraftInput] = useState("");
  const snapshotAnimaId = snapshot?.animaId ?? null;
  useTransparentQuickChatDocument();
  useDesktopQuickChatInteractiveRegions(isQuickChatWindow && Boolean(snapshot));

  useLayoutEffect(() => {
    if (!snapshot) return;
    setDraftInput(snapshot.input);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshotAnimaId) return;
    return focusQuickChatInput();
  }, [focusInputSignal, snapshotAnimaId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextInput = event.target.value;
      setDraftInput(nextInput);
      sendCommand({ type: "set-input", input: nextInput });
    },
    [sendCommand],
  );

  const handlePromptSuggestionSelect = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setDraftInput("");
      sendCommand({ type: "submit-text", text });
    },
    [sendCommand],
  );

  const handleSubmit = useCallback(() => {
    const text = draftInput;
    if (!text.trim()) return;
    setDraftInput("");
    sendCommand({ type: "submit-text", text });
  }, [draftInput, sendCommand]);

  if (!snapshot) {
    return (
      <SettingsProvider animaId={animaId}>
        <main className="h-screen w-screen overflow-hidden bg-transparent" />
      </SettingsProvider>
    );
  }

  return (
    <SettingsProvider animaId={animaId}>
      <main className="h-screen w-screen overflow-hidden bg-transparent">
        <ChatInterfaceView
          activeChat={snapshot.activeChat}
          activeMode={snapshot.voice.activeMode}
          animaName={snapshot.animaName ?? null}
          autoFocusInput
          canChat={snapshot.canChat}
          chatMarkdownEnabled={snapshot.chatMarkdownEnabled ?? true}
          className="bg-transparent"
          displayMessages={snapshot.displayMessages}
          input={draftInput}
          inputPlaceholder={snapshot.inputPlaceholder}
          isAwaitingStreamingAnimationFinalization={
            snapshot.isAwaitingStreamingAnimationFinalization
          }
          isDictationPreparing={snapshot.voice.isDictationPreparing}
          isMicCaptureActive={snapshot.voice.isMicCaptureActive}
          isStreaming={snapshot.isStreaming}
          isUserSpeaking={snapshot.voice.isUserSpeaking}
          isVoiceMicMuted={snapshot.voice.isVoiceMicMuted}
          layout="chat-only"
          micWaveformMode="synthetic"
          onDictationStart={() => sendCommand({ type: "start-dictation" })}
          onIncompatibleModelSelect={() => {
            toast.error(
              "That model keeps conversations differently. Open the main chat to continue in a new chat.",
            );
          }}
          onInputChange={handleInputChange}
          onMicSessionStop={() => sendCommand({ type: "stop-mic-session" })}
          onModelChange={() => sendCommand({ type: "refresh-model-state" })}
          onOpenMemoryEntry={(entryId) =>
            // The main process hides Quick Chat and brings the main window forward.
            sendCommand({ type: "open-memory-entry", entryId })
          }
          onPromptSuggestionSelect={handlePromptSuggestionSelect}
          onStop={() => sendCommand({ type: "stop" })}
          onStreamingAnimationComplete={() => {}}
          onSubmit={handleSubmit}
          onVoiceMicToggle={() => sendCommand({ type: "toggle-voice-mute" })}
          onVoiceModeStart={() => sendCommand({ type: "start-voice-mode" })}
          animaId={animaId}
          promptSuggestions={snapshot.promptSuggestions}
          quickChatSurface
          showPromptSuggestions={false}
          safetySlot={
            snapshot.safety ? (
              <CompanionSafetyView
                notice={snapshot.safety.notice}
                noticeVisible={snapshot.safety.noticeVisible}
                crisis={null}
                onDismissCrisis={() => {}}
              />
            ) : null
          }
          crisisSlot={
            snapshot.safety?.crisis ? (
              <CompanionSafetyView
                notice={null}
                noticeVisible={false}
                crisis={snapshot.safety.crisis}
                onDismissCrisis={() =>
                  sendCommand({ type: "dismiss-crisis-card" })
                }
              />
            ) : null
          }
        />
      </main>
    </SettingsProvider>
  );
}
