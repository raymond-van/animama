"use client";

import { ChatConversation } from "@animama/product-ui/components";

import {
  ChatTranscript,
  ChatTranscriptContent,
  ChatTranscriptScrollButton,
} from "@/ui/components/chat-transcript";
import { Message, type MessageLayout } from "@/ui/components/message";
import {
  ChatInput,
  ChatInputDictation,
  ChatInputFileUploadButton,
  ChatInputFileUploadUnavailable,
  ChatInputModelSelector,
  ChatInputSubmit,
  ChatInputTextArea,
} from "@/ui/components/chat-input";
import { ChatInputFileTray } from "@/ui/components/chat-input-file-tray";
import { useAnima } from "@/query/hooks/useAnima";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { cn } from "@/lib/utils";
import {
  useUserFileUpload,
  type UserFileUploadUppy,
} from "@/hooks/useUserFileUpload";
import { ChatFileDropOverlay } from "./ChatFileDropOverlay";
import { useChatSession, type ChatMessage } from "./useChatSession";
import { useCrisisCardCornerBottom } from "./crisisCardCorner";
import { PromptSuggestion } from "./PromptSuggestion";
import { MemoryCue } from "./MemoryCue";
import { useFirstChatSuggestions } from "./useFirstChatSuggestions";
import { useDictation } from "@/hooks/use-dictation";
import { useQueryClient } from "@tanstack/react-query";
import { useDesktopVoiceShortcuts } from "@/hooks/use-desktop-voice-shortcuts";
import {
  useDesktopQuickChatOwner,
  type DesktopQuickChatPromptSuggestion,
  type DesktopQuickChatSnapshot,
} from "@/hooks/useDesktopQuickChatRuntime";
import { resolveDesktopShortcuts } from "@/lib/settings/desktop-shortcuts";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  mergeChatAttachedFileIds,
  selectableChatUserFiles,
} from "@/lib/user-files/chat-attachments";
import { queryKeys } from "@/query/keys";
import { useUserFiles } from "@/query/hooks/useUserFiles";
import { useOperatorManagedModelAssets } from "@/query/hooks/useModelAssets";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import {
  useRuntimeFeatureEnabled,
  useRuntimeFeatureUnavailableReason,
} from "@/ui/app/RuntimeFeatureGate";
import { OfflineSpeechDownloads } from "@/ui/settings/OfflineSpeechDownloads";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { isWebSpeechSupported } from "@/lib/speech/stt-provider";
import { useSettings } from "@/ui/settings/SettingsProvider";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { useMountedAnimaRuntimeContent } from "@/ui/app/AnimaRouteProviders";
import { useCompanionSafety } from "@/ui/safety/CompanionSafetyProvider";
import { CompanionSafetySlot } from "@/ui/safety/CompanionSafetySlot";
import { quickChatSafetySnapshot } from "@/lib/safety/safetyState";
import type {
  PyChatResponse,
  PyModelProviderCatalogItem,
  PyUserFileResponse,
} from "@/lib/content/catalogTypes";

type ChatInterfaceProps = {
  className?: string;
  layout?: MessageLayout;
  animaId: string;
  chatId?: string | null;
  openDraftChatRoute: () => void | Promise<void>;
  replaceChatRoute: (chatId: string) => void | Promise<void>;
  /** Opens a memory entry in the Memory workspace, for Quick Chat's memory cue. */
  openMemoryEntry: (entryId: string) => void | Promise<void>;
};

type ChatInterfaceViewProps = {
  activeChat: PyChatResponse | null;
  /** AI notice above the input; the bottom-anchored composer stays stationary. */
  safetySlot?: ReactNode;
  /** Crisis card in the panel corner, or below the input in Quick Chat (spec R4). */
  crisisSlot?: ReactNode;
  activeMode?: "dictation" | "voice" | null;
  /** Names the Anima in memory cue details. */
  animaName?: string | null;
  autoFocusInput?: boolean;
  canChat: boolean;
  preparingPlayback?: boolean;
  contentWarning?: {
    message: string;
    details?: string;
  } | null;
  className?: string;
  chatMarkdownEnabled?: boolean;
  dictationInterimText?: string;
  dictationStream?: MediaStream | null;
  displayMessages: ReturnType<typeof useChatSession>["displayMessages"];
  existingAttachmentFiles?: readonly PyUserFileResponse[];
  existingFilesError?: boolean;
  existingFilesLoading?: boolean;
  fileUploadUppy?: UserFileUploadUppy;
  input: string;
  inputPlaceholder: string;
  isAwaitingStreamingAnimationFinalization: boolean;
  isDictationPreparing?: boolean;
  isMicCaptureActive?: boolean;
  isStreaming: boolean;
  isUserSpeaking?: boolean;
  isVoiceMicMuted?: boolean;
  layout?: MessageLayout;
  modelSelectorCloseSignal?: number;
  onDictationStart?: () => void;
  onRemoveExistingFile?: (fileId: string) => void;
  onToggleExistingFile?: (file: PyUserFileResponse) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onMicSessionStop?: () => void;
  onIncompatibleModelSelect: (item: PyModelProviderCatalogItem) => void;
  onModelChange?: () => void;
  /**
   * Opens a memory cue's `MEMORIES.md` entry by command. Without it the cue
   * links within this window; Quick Chat supplies it to reach the main window.
   */
  onOpenMemoryEntry?: (entryId: string) => void;
  onPromptSuggestionSelect: (text: string) => void;
  onStop: () => void;
  onRestoreMessage?: (text: string) => void;
  onStreamingAnimationComplete: () => void;
  onSubmit: () => void;
  onVoiceMicToggle?: () => void;
  onVoiceModeStart?: () => void;
  animaId: string;
  promptSuggestions: DesktopQuickChatPromptSuggestion[];
  quickChatSurface?: boolean;
  micWaveformMode?: "live" | "synthetic" | "none";
  showMicWaveform?: boolean;
  showPromptSuggestions: boolean;
  selectableExistingFiles?: readonly PyUserFileResponse[];
};

const USER_TYPING_INACTIVITY_TIMEOUT_MS = 3000;

function combineDictationText(committed: string, interim: string): string {
  const committedText = committed.trim();
  const interimText = interim.trim();
  if (committedText && interimText) {
    return `${committedText} ${interimText}`;
  }
  return committedText || interimText;
}

export function ChatInterfaceView({
  activeChat,
  activeMode = null,
  animaName = null,
  autoFocusInput = false,
  canChat,
  preparingPlayback = false,
  contentWarning = null,
  chatMarkdownEnabled = true,
  className,
  dictationInterimText = "",
  dictationStream = null,
  displayMessages,
  existingAttachmentFiles = [],
  existingFilesError = false,
  existingFilesLoading = false,
  fileUploadUppy: suppliedFileUploadUppy,
  input,
  inputPlaceholder,
  isAwaitingStreamingAnimationFinalization,
  isDictationPreparing = false,
  isMicCaptureActive = false,
  isStreaming,
  isUserSpeaking = false,
  isVoiceMicMuted = false,
  layout = "scene-overlay",
  modelSelectorCloseSignal = 0,
  onDictationStart,
  onRemoveExistingFile,
  onToggleExistingFile,
  onInputChange,
  onIncompatibleModelSelect,
  onMicSessionStop,
  onModelChange,
  onOpenMemoryEntry,
  onPromptSuggestionSelect,
  onStop,
  onRestoreMessage,
  onStreamingAnimationComplete,
  onSubmit,
  onVoiceMicToggle,
  onVoiceModeStart,
  animaId,
  promptSuggestions,
  quickChatSurface = false,
  micWaveformMode,
  showMicWaveform = true,
  showPromptSuggestions,
  selectableExistingFiles = [],
  safetySlot = null,
  crisisSlot = null,
}: ChatInterfaceViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRegionRef = useRef<HTMLDivElement>(null);
  const crisisCardRef = useRef<HTMLDivElement>(null);
  const crisisCardBottom = useCrisisCardCornerBottom(
    panelRef,
    inputRegionRef,
    crisisCardRef,
    crisisSlot !== null && !quickChatSurface,
  );
  const capabilities = useRuntimeCapabilities();
  // Withholding the uploader removes the live attach button, drop overlay and
  // tray; a runtime that reports uploads withheld keeps a disabled attach
  // button with the shared reason instead.
  const fileUploadUppy = useRuntimeFeatureEnabled("chat_file_uploads")
    ? suppliedFileUploadUppy
    : undefined;
  const attachUnavailableReason =
    useRuntimeFeatureUnavailableReason("chat_file_uploads");
  const platform = useRuntimePlatform();
  const speechAvailable =
    capabilities.data?.offline_speech_enabled === true ||
    isWebSpeechSupported(platform);
  // Operator-provided speech models cannot be installed from the composer.
  const operatorManagedModels = useOperatorManagedModelAssets();
  const { data: anima } = useAnima(animaId);
  const { data: modelCatalog } = useModelProviders();
  const activeModel = modelCatalog?.find(
    (item) => item.id === anima?.chat_profile?.default_model_provider_id,
  );
  // Attached files are searched through tool calls; unknown models get no note.
  const activeModelSearchesFiles = activeModel?.supports_tools !== false;
  const isChatOnlyLayout = layout === "chat-only";
  const fileDropEnabled = Boolean(fileUploadUppy) && !quickChatSurface;
  const fileDropAccepting = fileDropEnabled && canChat && !isStreaming;
  const renderAssistantAccessory = useCallback(
    (message: ChatMessage) =>
      message.memoryCue ? (
        <MemoryCue
          cue={message.memoryCue}
          animaName={animaName}
          onOpenMemoryEntry={onOpenMemoryEntry}
        />
      ) : null,
    [animaName, onOpenMemoryEntry],
  );

  return (
    <div
      ref={panelRef}
      className={cn(
        "pointer-events-auto relative flex h-full w-full flex-col",
        className,
      )}
    >
      <ChatFileDropOverlay
        accepting={fileDropAccepting}
        enabled={fileDropEnabled}
        uppy={fileUploadUppy}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            quickChatSurface &&
              "grid grid-rows-[minmax(0,1fr)_auto_var(--anima-quick-chat-bottom-spacer,330px)]",
          )}
        >
          <ChatTranscript
            className={cn(
              quickChatSurface &&
                "row-start-1 mx-auto h-full w-full max-w-[800px] flex-none self-stretch",
            )}
            data-quick-chat-interactive={quickChatSurface ? "" : undefined}
          >
            <ChatTranscriptContent
              className={cn(
                isChatOnlyLayout &&
                  !quickChatSurface &&
                  "mx-auto w-full max-w-[800px] px-4 py-4",
                isChatOnlyLayout &&
                  quickChatSurface &&
                  "flex min-h-full w-full flex-col px-4 py-4",
              )}
            >
              <>
                <div
                  className={cn(quickChatSurface && "mt-auto w-full")}
                  data-quick-chat-message-stack={
                    quickChatSurface ? "" : undefined
                  }
                >
                  <ChatConversation
                    onRestoreMessage={onRestoreMessage}
                    restoreDisabled={Boolean(input.trim())}
                    messages={displayMessages}
                    isStreaming={isStreaming}
                    completionPending={isAwaitingStreamingAnimationFinalization}
                    onQueueComplete={onStreamingAnimationComplete}
                    markdownEnabled={chatMarkdownEnabled}
                    layout={layout}
                    messageComponent={Message}
                    renderAssistantAccessory={renderAssistantAccessory}
                  />
                </div>
              </>
            </ChatTranscriptContent>
            <ChatTranscriptScrollButton />
          </ChatTranscript>
          <div
            ref={inputRegionRef}
            className={cn(
              "mx-auto w-full max-w-[800px] shrink-0 px-4 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))]",
              quickChatSurface && "row-start-2 pt-3 pb-3",
            )}
            data-quick-chat-input-region={quickChatSurface ? "" : undefined}
            data-quick-chat-interactive={quickChatSurface ? "" : undefined}
          >
            {safetySlot ? (
              <div className="mb-2 empty:hidden">{safetySlot}</div>
            ) : null}
            {contentWarning ? (
              <p
                className="text-muted-foreground mb-2 flex items-center gap-1.5 px-1 text-xs"
                role="status"
                title={contentWarning.details}
              >
                <span
                  aria-hidden="true"
                  className="bg-warning/80 size-1.5 shrink-0 rounded-full"
                />
                {contentWarning.message}
              </p>
            ) : preparingPlayback ? (
              <p
                className="text-muted-foreground mb-2 px-1 text-xs"
                role="status"
              >
                Preparing animations and effects…
                {canChat ? " You can chat now." : ""}
              </p>
            ) : null}
            {showPromptSuggestions ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {promptSuggestions.map((suggestion) => (
                  <PromptSuggestion
                    key={suggestion.label}
                    onClick={() => {
                      onPromptSuggestionSelect(suggestion.text);
                    }}
                  >
                    {suggestion.label}
                  </PromptSuggestion>
                ))}
              </div>
            ) : null}
            <ChatInput
              variant="default"
              value={input}
              onChange={onInputChange}
              onSubmit={onSubmit}
              onVoice={onVoiceModeStart}
              voiceAvailable={speechAvailable}
              loading={isStreaming}
              onStop={onStop}
              activeMicMode={activeMode}
              isMicCaptureActive={isMicCaptureActive}
              isDictationPreparing={isDictationPreparing}
              isUserSpeaking={isUserSpeaking}
              isVoiceMicMuted={isVoiceMicMuted}
              onDictationStart={onDictationStart}
              onMicSessionStop={onMicSessionStop}
              onVoiceMicToggle={onVoiceMicToggle}
              dictationStream={dictationStream}
              disabled={!canChat}
              micWaveformMode={micWaveformMode}
              showMicWaveform={showMicWaveform}
              className={cn(
                "border-border/70 backdrop-blur-xs",
                quickChatSurface ? "bg-background/90" : "bg-background/70",
              )}
              leadingActions={
                fileUploadUppy ? (
                  <ChatInputFileUploadButton
                    uppy={fileUploadUppy}
                    existingFiles={selectableExistingFiles}
                    existingFilesError={existingFilesError}
                    existingFilesLoading={existingFilesLoading}
                    selectedExistingFileIds={existingAttachmentFiles.map(
                      (file) => file.file_id,
                    )}
                    onToggleExistingFile={(file) =>
                      onToggleExistingFile?.(file)
                    }
                    disabled={!canChat || isStreaming}
                  />
                ) : attachUnavailableReason ? (
                  <ChatInputFileUploadUnavailable
                    reason={attachUnavailableReason}
                  />
                ) : null
              }
              actions={
                <>
                  <ChatInputModelSelector
                    activeChat={activeChat}
                    animaId={animaId}
                    closeSignal={modelSelectorCloseSignal}
                    disabled={isStreaming}
                    onIncompatibleModelSelect={onIncompatibleModelSelect}
                    onModelChange={onModelChange}
                  />
                  <ChatInputDictation
                    disabled={!activeMode && (!canChat || !speechAvailable)}
                  />
                  <ChatInputSubmit />
                </>
              }
            >
              <div className="flex w-full min-w-0 flex-1 flex-col gap-2">
                {fileUploadUppy ? (
                  <ChatInputFileTray
                    uppy={fileUploadUppy}
                    note={
                      activeModelSearchesFiles
                        ? null
                        : "This model can't call tools, so it can't search attached files. Pick a model with tool calling to use them."
                    }
                    existingFiles={existingAttachmentFiles}
                    onRemoveExistingFile={onRemoveExistingFile}
                  />
                ) : null}
                <ChatInputTextArea
                  autoFocus={autoFocusInput}
                  className="bg-transparent"
                  data-quick-chat-input={quickChatSurface ? "" : undefined}
                  placeholder={inputPlaceholder}
                  interimSuffix={dictationInterimText}
                />
              </div>
            </ChatInput>
            {!speechAvailable ? (
              <details className="text-muted-foreground mt-2 text-xs">
                <summary>
                  {operatorManagedModels
                    ? "Offline speech recognition for dictation and Voice Mode is not available here"
                    : "Install offline speech recognition to use dictation and Voice Mode"}
                </summary>
                {quickChatSurface ? (
                  <p>
                    Open App Settings → Voice in the main Animama window to
                    download it.
                  </p>
                ) : (
                  <div className="mt-2">
                    <OfflineSpeechDownloads heading={false} />
                  </div>
                )}
              </details>
            ) : null}
            {quickChatSurface && crisisSlot ? (
              <div className="mt-2">{crisisSlot}</div>
            ) : null}
          </div>
        </div>
      </div>
      {!quickChatSurface && crisisSlot ? (
        <div
          ref={crisisCardRef}
          className="absolute right-4 z-20 w-[min(24rem,calc(100%-2rem))]"
          style={{ bottom: crisisCardBottom }}
        >
          {crisisSlot}
        </div>
      ) : null}
    </div>
  );
}

export const ChatInterface = ({
  className,
  layout = "scene-overlay",
  animaId,
  chatId = null,
  openDraftChatRoute,
  replaceChatRoute,
  openMemoryEntry,
}: ChatInterfaceProps) => {
  const companionSafety = useCompanionSafety();
  const fileUploadUppy = useUserFileUpload({
    id: `chat-user-files-${animaId}`,
  });
  // Existing files are only attachable while the runtime offers uploads.
  const chatFileUploads = useRuntimeFeatureEnabled("chat_file_uploads");
  const userFilesQuery = useUserFiles({
    pollActive: true,
    enabled: chatFileUploads,
  });
  const [selectedExistingFileIds, setSelectedExistingFileIds] = useState<
    string[]
  >([]);
  const selectableExistingFiles = useMemo(
    () => selectableChatUserFiles(userFilesQuery.data ?? []),
    [userFilesQuery.data],
  );
  const selectableExistingFilesById = useMemo(
    () => new Map(selectableExistingFiles.map((file) => [file.file_id, file])),
    [selectableExistingFiles],
  );
  const existingAttachmentFiles = useMemo(
    () =>
      selectedExistingFileIds
        .map((fileId) => selectableExistingFilesById.get(fileId))
        .filter((file): file is PyUserFileResponse => Boolean(file)),
    [selectableExistingFilesById, selectedExistingFileIds],
  );
  const toggleExistingFile = useCallback((file: PyUserFileResponse) => {
    setSelectedExistingFileIds((current) =>
      current.includes(file.file_id)
        ? current.filter((fileId) => fileId !== file.file_id)
        : [...current, file.file_id],
    );
  }, []);
  const removeExistingFile = useCallback((fileId: string) => {
    setSelectedExistingFileIds((current) =>
      current.filter((candidate) => candidate !== fileId),
    );
  }, []);

  useEffect(() => {
    setSelectedExistingFileIds([]);
  }, [animaId]);

  useEffect(() => {
    if (!userFilesQuery.isSuccess) return;
    const availableIds = new Set(
      selectableExistingFiles.map((file) => file.file_id),
    );
    setSelectedExistingFileIds((current) => {
      const next = current.filter((fileId) => availableIds.has(fileId));
      return next.length === current.length ? current : next;
    });
  }, [selectableExistingFiles, userFilesQuery.isSuccess]);

  const getAttachedFileIds = useCallback(() => {
    const uploadedIds = Object.values(fileUploadUppy.getState().files).map(
      (file) => file.meta.file_id,
    );
    return mergeChatAttachedFileIds(uploadedIds, selectedExistingFileIds);
  }, [fileUploadUppy, selectedExistingFileIds]);

  const {
    activeChat,
    input,
    setInput,
    animaName,
    inputPlaceholder,
    canChat,
    isStreaming,
    isAwaitingStreamingAnimationFinalization,
    displayMessages,
    handleSubmit,
    handleSubmitText,
    handleStop,
    restoreFailedMessage,
    handleSkipTts,
    isTtsAudioActive,
    handleStreamingAnimationComplete,
    pendingModelSwitch,
    requestModelSwitchToNewChat,
    cancelPendingModelSwitch,
    confirmPendingModelSwitch,
    isConfirmingModelSwitch,
  } = useChatSession({
    animaId,
    getAttachedFileIds,
    openDraftChatRoute,
    routeChatId: chatId,
    replaceChatRoute,
    safety: companionSafety?.sessionEffects,
  });
  const reportSafetyStreaming = companionSafety?.reportStreaming;
  useEffect(() => {
    reportSafetyStreaming?.(isStreaming);
  }, [isStreaming, reportSafetyStreaming]);
  // Unmounting the chat panel (Avatar-only mode, leaving the Anima) aborts the
  // turn silently, so settle the AI notice here too.
  useEffect(
    () => () => reportSafetyStreaming?.(false),
    [reportSafetyStreaming],
  );
  const mountedRuntimeContent = useMountedAnimaRuntimeContent();
  const contentWarning = useMemo(() => {
    if (mountedRuntimeContent.playbackStatus !== "degraded") return null;
    return {
      message: "Some avatar content is unavailable. Text chat still works.",
      details: mountedRuntimeContent.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n"),
    };
  }, [mountedRuntimeContent.diagnostics, mountedRuntimeContent.playbackStatus]);
  const { chatMarkdownEnabled, userPreferences } = useSettings();
  const queryClient = useQueryClient();
  const userId = useRuntimeCacheKey();
  const userKey = userId ?? "__anon__";

  const dictationBaseRef = useRef("");
  const dictationCommittedRef = useRef("");
  const dictationInterimRef = useRef("");
  const [dictationInterimText, setDictationInterimText] = useState("");
  const [modelSelectorCloseSignal, setModelSelectorCloseSignal] = useState(0);
  const beginAvatarListeningCapture = useAvatarRuntimeStore(
    (state) => state.beginListeningCapture,
  );
  const endAvatarListeningCapture = useAvatarRuntimeStore(
    (state) => state.endListeningCapture,
  );
  const beginAvatarTypingActivity = useAvatarRuntimeStore(
    (state) => state.beginTypingActivity,
  );
  const endAvatarTypingActivity = useAvatarRuntimeStore(
    (state) => state.endTypingActivity,
  );
  const isUserSpeaking = useAvatarRuntimeStore(
    (state) => state.interactionPhase === "user_speaking",
  );
  const typingInactivityTimerRef = useRef<number | null>(null);

  const clearDictationBuffers = useCallback(() => {
    dictationCommittedRef.current = "";
    dictationInterimRef.current = "";
    setDictationInterimText("");
  }, []);

  const clearTypingActivityTimer = useCallback(() => {
    if (typingInactivityTimerRef.current === null) return;
    window.clearTimeout(typingInactivityTimerRef.current);
    typingInactivityTimerRef.current = null;
  }, []);

  const endTypingActivityNow = useCallback(() => {
    clearTypingActivityTimer();
    endAvatarTypingActivity();
  }, [clearTypingActivityTimer, endAvatarTypingActivity]);

  const applyDictationText = useCallback(
    (committed: string, interim: string) => {
      dictationCommittedRef.current = committed;
      dictationInterimRef.current = interim;
      setDictationInterimText(interim);

      const dictated = combineDictationText(committed, interim);
      const base = dictationBaseRef.current ?? "";
      if (!dictated) {
        setInput(base);
        return;
      }
      const spacer = base && !base.endsWith(" ") ? " " : "";
      setInput(`${base}${spacer}${dictated}`);
    },
    [setInput],
  );

  const {
    activeMode,
    isMicCaptureActive,
    isDictationPreparing,
    isVoiceMicMuted,
    startDictation,
    stopDictation,
    muteVoiceMic,
    unmuteVoiceMic,
    switchMode,
    stream,
  } = useDictation({
    onSegment: (segment) => {
      const text = segment.text.trim();
      if (!text) return;
      const next =
        dictationCommittedRef.current.length > 0
          ? `${dictationCommittedRef.current} ${text}`
          : text;
      applyDictationText(next, dictationInterimRef.current);
    },
    onTranscriptPreview: (preview) => {
      const nextInterim = preview.interimText.trim();
      if (nextInterim === dictationInterimRef.current) return;
      applyDictationText(dictationCommittedRef.current, nextInterim);
    },
    onError: (error) => {
      toast.error("Dictation failed", {
        description: error.message,
      });
    },
    onVoiceAutoSubmit: async (payload) => {
      const text = payload.text.trim();
      if (!text) return;
      dictationBaseRef.current = "";
      applyDictationText("", "");
      await handleSubmitText({
        text,
        inputMode: "voice",
        submitReason: "semantic_end_turn",
        turnId: payload.turnId,
        smartTurnJobId: payload.jobId,
        smartTurnScore: payload.probability,
        smartTurnLatencyMs: payload.latencyMs,
        clearInput: true,
      });
    },
    onVoiceSilenceReset: () => {
      dictationBaseRef.current = "";
      clearDictationBuffers();
      setInput("");
    },
  });

  const markManualTypingActivity = useCallback(
    (nextInput: string) => {
      clearTypingActivityTimer();

      if (activeMode || isStreaming || !nextInput.trim()) {
        endAvatarTypingActivity();
        return;
      }

      beginAvatarTypingActivity();
      typingInactivityTimerRef.current = window.setTimeout(() => {
        typingInactivityTimerRef.current = null;
        endAvatarTypingActivity();
      }, USER_TYPING_INACTIVITY_TIMEOUT_MS);
    },
    [
      activeMode,
      beginAvatarTypingActivity,
      clearTypingActivityTimer,
      endAvatarTypingActivity,
      isStreaming,
    ],
  );

  const desktopShortcuts = useMemo(
    () => resolveDesktopShortcuts(userPreferences?.speech?.desktop_shortcuts),
    [userPreferences?.speech?.desktop_shortcuts],
  );

  useEffect(() => {
    if (isMicCaptureActive) {
      beginAvatarListeningCapture();
      return;
    }
    endAvatarListeningCapture();
  }, [
    beginAvatarListeningCapture,
    endAvatarListeningCapture,
    isMicCaptureActive,
  ]);

  useEffect(
    () => () => {
      endAvatarListeningCapture();
      endTypingActivityNow();
    },
    [endAvatarListeningCapture, endTypingActivityNow],
  );

  useEffect(() => {
    if (!activeMode && !isStreaming) return;
    endTypingActivityNow();
  }, [activeMode, endTypingActivityNow, isStreaming]);

  const handleDictationStart = useCallback(async () => {
    endTypingActivityNow();
    dictationBaseRef.current = input;
    clearDictationBuffers();
    await startDictation("dictation");
  }, [clearDictationBuffers, endTypingActivityNow, input, startDictation]);

  const startVoiceModeCapture = useCallback(async () => {
    endTypingActivityNow();
    dictationBaseRef.current = input;
    clearDictationBuffers();
    if (activeMode === "dictation") {
      await switchMode("voice");
      return;
    }
    await startDictation("voice");
  }, [
    activeMode,
    clearDictationBuffers,
    endTypingActivityNow,
    input,
    startDictation,
    switchMode,
  ]);

  const handleVoiceModeStart = useCallback(async () => {
    await startVoiceModeCapture();
  }, [startVoiceModeCapture]);

  const handleVoiceModeToggle = useCallback(() => {
    if (!canChat) return;
    if (activeMode === "voice") {
      void stopDictation();
      return;
    }
    void handleVoiceModeStart();
  }, [activeMode, canChat, handleVoiceModeStart, stopDictation]);

  const handleMicSessionStop = useCallback(() => {
    void stopDictation();
  }, [stopDictation]);

  const handleVoiceMicToggle = useCallback(() => {
    if (activeMode !== "voice") {
      return;
    }
    if (isVoiceMicMuted) {
      void unmuteVoiceMic();
      return;
    }
    void muteVoiceMic();
  }, [activeMode, isVoiceMicMuted, muteVoiceMic, unmuteVoiceMic]);

  const handleModelStateRefresh = useCallback(() => {
    if (!userId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.animas.detail(userKey, animaId),
    });
  }, [animaId, queryClient, userId, userKey]);

  const handleSubmitWithDictation = useCallback(() => {
    endTypingActivityNow();
    handleSubmit();
    dictationBaseRef.current = "";
    clearDictationBuffers();
  }, [clearDictationBuffers, endTypingActivityNow, handleSubmit]);

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      const dictated = combineDictationText(
        dictationCommittedRef.current,
        dictationInterimRef.current,
      );
      if (activeMode || dictated) {
        if (dictated && next.endsWith(dictated)) {
          dictationBaseRef.current = next.slice(
            0,
            next.length - dictated.length,
          );
        } else {
          dictationBaseRef.current = next;
          if (dictated) {
            clearDictationBuffers();
          }
        }
      }
      setInput(next);
      markManualTypingActivity(next);
    },
    [activeMode, clearDictationBuffers, markManualTypingActivity, setInput],
  );

  const promptSuggestions = useMemo(() => {
    if (!animaName) {
      return [
        {
          label: "Simple greeting",
          text: `Hi! How's it going?`,
        },
        {
          label: "Tell me a joke",
          text: `Hey, tell me a joke!`,
        },
      ];
    }

    return [
      {
        label: "Simple greeting",
        text: `Hi ${animaName}! How's it going?`,
      },
      {
        label: "Tell me a joke",
        text: `Hey ${animaName}, tell me a joke!`,
      },
    ];
  }, [animaName]);

  const isFirstChat = useFirstChatSuggestions(displayMessages);
  const showPromptSuggestions =
    isFirstChat &&
    Boolean(animaName) &&
    canChat &&
    !isStreaming &&
    !activeMode &&
    displayMessages.length === 0;

  const handlePromptSuggestionSelect = useCallback(
    async (text: string) => {
      if (!text.trim()) {
        return;
      }

      endTypingActivityNow();
      dictationBaseRef.current = "";
      clearDictationBuffers();

      await handleSubmitText({
        text,
        inputMode: "typed",
        submitReason: "manual",
        clearInput: true,
      });
    },
    [clearDictationBuffers, endTypingActivityNow, handleSubmitText],
  );

  const quickChatSnapshot = useMemo<DesktopQuickChatSnapshot>(
    () => ({
      activeChat,
      animaId,
      animaName,
      chatId,
      input,
      inputPlaceholder,
      canChat,
      chatMarkdownEnabled,
      isStreaming,
      isAwaitingStreamingAnimationFinalization,
      displayMessages,
      promptSuggestions,
      showPromptSuggestions,
      voice: {
        activeMode,
        isMicCaptureActive,
        isDictationPreparing,
        isUserSpeaking,
        isVoiceMicMuted,
      },
      safety: companionSafety ? quickChatSafetySnapshot(companionSafety) : null,
    }),
    [
      companionSafety,
      activeChat,
      activeMode,
      animaName,
      canChat,
      chatMarkdownEnabled,
      chatId,
      displayMessages,
      input,
      inputPlaceholder,
      isAwaitingStreamingAnimationFinalization,
      isDictationPreparing,
      isMicCaptureActive,
      isStreaming,
      isUserSpeaking,
      isVoiceMicMuted,
      animaId,
      promptSuggestions,
      showPromptSuggestions,
    ],
  );

  const quickChatHandlers = useMemo(
    () => ({
      setInput,
      submit: handleSubmitWithDictation,
      submitText: (text: string) => {
        void handlePromptSuggestionSelect(text);
      },
      stop: handleStop,
      startDictation: () => {
        void handleDictationStart();
      },
      startVoiceMode: () => {
        void handleVoiceModeStart();
      },
      stopMicSession: handleMicSessionStop,
      toggleVoiceMute: handleVoiceMicToggle,
      refreshModelState: handleModelStateRefresh,
      dismissCrisisCard: () => companionSafety?.dismissCrisis(),
      openMemoryEntry: (entryId: string) => {
        void openMemoryEntry(entryId);
      },
    }),
    [
      companionSafety,
      handleDictationStart,
      handleModelStateRefresh,
      handleMicSessionStop,
      handlePromptSuggestionSelect,
      handleStop,
      handleSubmitWithDictation,
      handleVoiceMicToggle,
      handleVoiceModeStart,
      openMemoryEntry,
      setInput,
    ],
  );

  const { quickChatAvailable, toggleQuickChat } = useDesktopQuickChatOwner({
    chatId,
    enabled: Boolean(animaId),
    handlers: quickChatHandlers,
    animaId,
    snapshot: quickChatSnapshot,
  });

  useDesktopVoiceShortcuts({
    shortcuts: desktopShortcuts,
    quickChatAvailable,
    voiceModeAvailable: canChat,
    voiceModeActive: activeMode === "voice",
    isVoiceMicMuted,
    ttsAudioActive: isTtsAudioActive,
    onQuickChat: toggleQuickChat,
    onToggleVoiceMode: handleVoiceModeToggle,
    onToggleVoiceMute: handleVoiceMicToggle,
    onMuteVoiceMic: muteVoiceMic,
    onUnmuteVoiceMic: unmuteVoiceMic,
    onSkipTts: handleSkipTts,
  });

  const pendingModelLabel =
    pendingModelSwitch?.item.model_label ??
    pendingModelSwitch?.item.model ??
    "This model";

  return (
    <>
      <ChatInterfaceView
        safetySlot={<CompanionSafetySlot part="notice" />}
        crisisSlot={<CompanionSafetySlot part="crisis" />}
        activeChat={activeChat}
        activeMode={activeMode}
        animaName={animaName}
        canChat={canChat}
        preparingPlayback={
          mountedRuntimeContent.avatarVisualStatus === "visible" &&
          mountedRuntimeContent.playbackStatus === "preparing"
        }
        contentWarning={contentWarning}
        chatMarkdownEnabled={chatMarkdownEnabled}
        className={className}
        dictationInterimText={dictationInterimText}
        dictationStream={stream}
        displayMessages={displayMessages}
        existingAttachmentFiles={existingAttachmentFiles}
        existingFilesError={userFilesQuery.isError}
        existingFilesLoading={userFilesQuery.isLoading}
        fileUploadUppy={fileUploadUppy}
        input={input}
        inputPlaceholder={inputPlaceholder}
        isAwaitingStreamingAnimationFinalization={
          isAwaitingStreamingAnimationFinalization
        }
        isDictationPreparing={isDictationPreparing}
        isMicCaptureActive={isMicCaptureActive}
        isStreaming={isStreaming}
        isUserSpeaking={isUserSpeaking}
        isVoiceMicMuted={isVoiceMicMuted}
        layout={layout}
        modelSelectorCloseSignal={modelSelectorCloseSignal}
        onDictationStart={() => {
          void handleDictationStart();
        }}
        onRemoveExistingFile={removeExistingFile}
        onToggleExistingFile={toggleExistingFile}
        onInputChange={handleInputChange}
        onIncompatibleModelSelect={requestModelSwitchToNewChat}
        onMicSessionStop={handleMicSessionStop}
        onPromptSuggestionSelect={(text) => {
          void handlePromptSuggestionSelect(text);
        }}
        onStop={handleStop}
        onRestoreMessage={restoreFailedMessage}
        onStreamingAnimationComplete={handleStreamingAnimationComplete}
        onSubmit={handleSubmitWithDictation}
        onVoiceMicToggle={handleVoiceMicToggle}
        onVoiceModeStart={() => {
          void handleVoiceModeStart();
        }}
        animaId={animaId}
        promptSuggestions={promptSuggestions}
        selectableExistingFiles={selectableExistingFiles}
        showPromptSuggestions={showPromptSuggestions}
      />
      <Dialog
        open={Boolean(pendingModelSwitch)}
        onOpenChange={(open) => {
          if (!open) cancelPendingModelSwitch();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a new chat?</DialogTitle>
            <DialogDescription>
              {pendingModelLabel} keeps conversations differently, so this chat
              continues in a new chat.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isConfirmingModelSwitch}
              onClick={cancelPendingModelSwitch}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isConfirmingModelSwitch}
              onClick={() => {
                setModelSelectorCloseSignal((current) => current + 1);
                void confirmPendingModelSwitch();
              }}
            >
              Start new chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
