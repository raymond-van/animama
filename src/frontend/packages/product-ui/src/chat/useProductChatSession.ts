import { describeChatFailure } from "./chat-failure";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAnima } from "../query/hooks/useAnima";
import { useChat } from "../query/hooks/useChat";
import { useChatMessages } from "../query/hooks/useChatMessages";
import { useModelProviders } from "../query/hooks/useModelProviders";
import { useCreateChat } from "../query/mutations/useCreateChat";
import { useChatSse } from "../query/mutations/useChatSse";
import { useUpdateAnimaChatProfile } from "../query/mutations/useUpdateAnimaChatProfile";
import type {
  PyChatMessage,
  PyChatResponse,
  PyAnimaResponse,
  PyModelProviderCatalogItem,
  PyAnimaDispatchOptions,
  WebSearchCapability,
} from "@animama/runtime-contracts/api-types";
import { queryKeys } from "../query/keys";
import {
  chatModelSendGate,
  findRestorableChatModel,
} from "../lib/chat/model-provider-compatibility";
import { buildChatSseRequestBody } from "../lib/chat/chat-sse-request";
import { selectableNativeTools } from "../lib/chat/model-provider-native-tools";
import {
  currentChatClientContext,
  type ChatAiNotice,
  type ChatCrisisSupport,
} from "../lib/chat/companion-safety";
import { isRuntimeRemountRequired } from "../lib/runtime-errors";
import { runtimeRemountRecovery } from "../lib/chat/runtimeRemountRecovery";
import {
  chatRunMessageId,
  mapServerMessagesForDisplay,
  sortDisplayMessagesByCreatedAt,
  type ChatDisplayMessage,
} from "../lib/chat/display-message-mapping";
import type { ChatMemoryCue } from "../lib/chat/memory-cue";
import type { ChatRunStatusKind } from "../lib/chat/run-status";
import { isSpeechAllowanceExhausted } from "../lib/chat/speech-allowance";
import {
  appendStructuredSpeechVisemeInputs,
  createStructuredResponseStreamState,
  getStructuredAssistantTexts,
  reduceStructuredResponseStream,
  selectStructuredSpeechVisemePayload,
  selectStructuredSpeechTtsPayload,
  type AccumulatedStructuredSpeechVisemeInputs,
  type StructuredSpeechTtsPayload,
} from "../lib/chat/structured-response-stream";
import {
  emotionStateFromValues,
  type EmotionStateMap,
  type EmotionValue,
} from "../lib/emotion";
import { getAnimaDisplayName } from "../lib/anima-profile";
import {
  useRuntimeCacheKey,
  useProductRuntime,
} from "../runtime/ProductRuntimeProvider";
import {
  useProductDiagnostics,
  useProductLogger,
} from "../runtime/diagnostics";
import {
  textOnlyChatEffects,
  textOnlySpeechPolicy,
  type ChatSessionEffects,
  type ChatSpeechPolicy,
  type ChatRuntimeFence,
  type InputMode,
  type VoiceSubmitReason,
} from "./session-bindings";
export type ChatMessage = ChatDisplayMessage;

export type UseProductChatSessionResult = {
  activeChat: PyChatResponse | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  animaName: string | null;
  inputPlaceholder: string;
  canChat: boolean;
  isStreaming: boolean;
  isAwaitingStreamingAnimationFinalization: boolean;
  displayMessages: ChatMessage[];
  handleSubmit: () => Promise<void>;
  handleSubmitText: (args: {
    text: string;
    inputMode?: InputMode;
    submitReason?: VoiceSubmitReason | "manual";
    turnId?: string | null;
    smartTurnJobId?: string | null;
    smartTurnScore?: number | null;
    smartTurnLatencyMs?: number | null;
    clearInput?: boolean;
  }) => Promise<void>;
  handleStop: () => void;
  restoreFailedMessage: (text: string) => void;
  handleSkipTts: () => void;
  isTtsAudioActive: boolean;
  handleStreamingAnimationComplete: () => void;
  pendingModelSwitch: PendingModelSwitch | null;
  requestModelSwitchToNewChat: (item: PyModelProviderCatalogItem) => void;
  cancelPendingModelSwitch: () => void;
  confirmPendingModelSwitch: () => Promise<void>;
  isConfirmingModelSwitch: boolean;
};

export type UseProductChatSessionArgs = {
  runtime: ChatRuntimeFence;
  effects?: ChatSessionEffects;
  speech?: ChatSpeechPolicy;
  dispatchOptions?: PyAnimaDispatchOptions | null;
  /**
   * The installation's application web search state; with a configured
   * backend, tool-capable models may request `web_search`.
   */
  webSearch?: WebSearchCapability | null;
  animaId: string;
  routeChatId?: string | null;
  getAttachedFileIds?: () => string[];
  openDraftChatRoute: () => void | Promise<void>;
  replaceChatRoute: (chatId: string) => void | Promise<void>;
  safety?: ChatSafetyEffects;
};

/** Receives the app-rendered AI notice and crisis card for each turn (spec R2, R4). */
export type ChatSafetyEffects = {
  onAiNotice?: (notice: ChatAiNotice) => void;
  onCrisisSupport?: (card: ChatCrisisSupport) => void;
};

export type PendingModelSwitch = {
  item: PyModelProviderCatalogItem;
};

type PendingStreamFinalization = {
  chatId: string;
  messagesKey: ReturnType<typeof queryKeys.chats.messages>;
  nextMessages: PyChatMessage[];
  runId: string;
  requestNonTtsAvatarCompletion: boolean;
  refreshChatListsOnComplete: boolean;
};

/** Text chat depends on the issued runtime fence, not visual preparation. */
export function chatSessionCanChat(args: {
  animaId: string | null;
  loadedAnimaId: string | null;
  runtimeRevision: string | null;
  runtimeCanChat: boolean;
}): boolean {
  return Boolean(
    args.animaId &&
    args.loadedAnimaId === args.animaId &&
    args.runtimeRevision &&
    args.runtimeCanChat,
  );
}

// -----------------------------------------------------------------------------
// Small chat-specific utilities.
// -----------------------------------------------------------------------------
function genRunId(): string {
  return `ui-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function isAnimaResponse(value: unknown): value is PyAnimaResponse {
  return value !== null && typeof value === "object" && "id" in value;
}

function patchAnimaEmotionSnapshot(
  current: unknown,
  animaId: string,
  emotionalState: EmotionStateMap,
): unknown {
  if (Array.isArray(current)) {
    return current.map((item) => {
      if (!isAnimaResponse(item) || item.id !== animaId) {
        return item;
      }
      return {
        ...item,
        emotional_state: emotionalState,
      };
    });
  }

  if (!isAnimaResponse(current) || current.id !== animaId) {
    return current;
  }

  return {
    ...current,
    emotional_state: emotionalState,
  };
}

/**
 * Orchestrates the chat runtime used by ChatInterface:
 * - route/anima resolution
 * - chat create/update
 * - chat SSE lifecycle
 * - optimistic/streaming message rendering
 * - avatar and TTS synchronization
 */
export function useProductChatSession({
  runtime: mountedRuntimeContent,
  effects = textOnlyChatEffects,
  speech = textOnlySpeechPolicy,
  dispatchOptions: chatRequestOptions,
  webSearch = null,
  animaId,
  getAttachedFileIds,
  openDraftChatRoute,
  routeChatId = null,
  replaceChatRoute,
  safety,
}: UseProductChatSessionArgs): UseProductChatSessionResult {
  // Safety handlers change identity per render; read the latest through a ref so
  // the submit callback need not be rebuilt.
  const safetyRef = useRef(safety);
  safetyRef.current = safety;
  // ---------------------------------------------------------------------------
  // Route + shared runtime dependencies.
  // ---------------------------------------------------------------------------
  const logger = useProductLogger("ChatInterface");
  const { recordUiInteraction, recordUiInteractionDuration } =
    useProductDiagnostics();
  const { capabilities } = useProductRuntime();
  const queryClient = useQueryClient();
  // Completion and stream side effects use the same lifetime partition as the query hooks.
  const userKey = useRuntimeCacheKey() ?? "__anon__";

  useEffect(() => {
    logger.info("Route", "Params updated", {
      animaId,
      chatId: routeChatId,
    });
  }, [animaId, routeChatId, logger]);

  // ---------------------------------------------------------------------------
  // Local UI + stream state.
  // ---------------------------------------------------------------------------
  const [input, setInput] = useState("");
  const [draftChatId, setDraftChatId] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null);
  const [pendingModelSwitch, setPendingModelSwitch] =
    useState<PendingModelSwitch | null>(null);
  const [streamingSegments, setStreamingSegments] = useState<string[]>([]);
  const [streamingDisplayText, setStreamingDisplayText] = useState("");
  const [streamingStatus, setStreamingStatus] =
    useState<ChatRunStatusKind | null>(null);
  // The active run's `memory.updated` cue. The ref keeps it readable when
  // completion arrives in the same network chunk, before React re-renders.
  const [streamingMemoryCue, setStreamingMemoryCue] =
    useState<ChatMemoryCue | null>(null);
  const streamingMemoryCueRef = useRef<ChatMemoryCue | null>(null);
  const [
    isAwaitingStreamingAnimationFinalization,
    setIsAwaitingStreamingAnimationFinalization,
  ] = useState(false);
  const streamingSegmentsRef = useRef<string[]>([]);
  const streamingDisplayTextRef = useRef("");
  // Structured speech/display parts carry their own accumulation semantics.
  // Keep that state separate from ordinary token streaming so fallback text
  // streams can continue using streamingSegments as a simple append-only list.
  const structuredResponseStateRef = useRef(
    createStructuredResponseStreamState(),
  );
  const pendingStreamFinalizationRef = useRef<PendingStreamFinalization | null>(
    null,
  );
  const restoredModelChatIdRef = useRef<string | null>(null);
  const skippedTtsRunIdsRef = useRef<Set<string>>(new Set());
  const activeChatId = routeChatId ?? draftChatId;
  const previousChatIdRef = useRef<string | null>(null);
  const suppressFetchChatRef = useRef<string | null>(null);
  const streamingText = useMemo(
    () => streamingSegments.join(""),
    [streamingSegments],
  );

  // ---------------------------------------------------------------------------
  // Server data dependencies.
  // ---------------------------------------------------------------------------
  const { data: anima } = useAnima(animaId);
  const {
    data: activeChat = null,
    isError: isActiveChatError,
    isLoading: isActiveChatLoading,
  } = useChat(activeChatId, { enabled: Boolean(activeChatId) });
  const { data: modelProviders = [], isLoading: isModelProvidersLoading } =
    useModelProviders();
  const updateAnimaChatProfile = useUpdateAnimaChatProfile();
  const activeModelProviderId =
    anima?.chat_profile?.default_model_provider_id ?? null;
  const activeModelProvider = useMemo(
    () =>
      activeModelProviderId
        ? (modelProviders.find((item) => item.id === activeModelProviderId) ??
          null)
        : null,
    [activeModelProviderId, modelProviders],
  );

  useEffect(() => {
    logger.info("UseAnima", "Anima Data", {
      anima,
      id: animaId,
    });
  }, [anima, animaId, logger]);

  const animaName = anima ? getAnimaDisplayName(anima) : null;
  const canChat = chatSessionCanChat({
    animaId,
    loadedAnimaId: anima?.id ?? null,
    runtimeRevision: mountedRuntimeContent.runtimeRevision,
    runtimeCanChat: mountedRuntimeContent.canChat && capabilities.chat,
  });
  const inputPlaceholder = !animaId
    ? "Loading anima..."
    : !canChat
      ? "Loading anima runtime..."
      : "What's on your mind?";

  const emptyServerMessages = useMemo(() => [] as PyChatMessage[], []);
  const shouldFetchMessages =
    Boolean(routeChatId) && routeChatId !== suppressFetchChatRef.current;
  const { data: serverMessagesData } = useChatMessages(activeChatId, {
    enabled: shouldFetchMessages,
  });
  const serverMessages = serverMessagesData ?? emptyServerMessages;
  const createChat = useCreateChat();
  const { startChat, stop, isStreaming } = useChatSse();

  const {
    resetAvatarRuntime,
    setAnimaEmotionSnapshot,
    startAvatarRun,
    markNonTtsResponseStarted,
    requestNonTtsResponseCompletion,
    markAvatarSpeechEnded,
    finishAvatarRun,
    abortAvatarRun,
    applyAvatarEmotionUpdate,
    requestAvatarGesture,
    queueAvatarVisemeInputsForRun,
    clearAvatarVisemeBridgeRun,
    clearAvatarVisemeBridgeAll,
    startTtsRun,
    appendTtsToken,
    completeTtsRun,
    acceptElevenLabsSession,
    markElevenLabsSessionFailed,
    acceptFinalizedAudio,
    completeFinalizedAudio,
    markFinalizedAudioFailed,
    fallBackToPocketTts,
    cancelTts,
    isTtsAudioActive,
  } = effects;

  // Shared helper to keep streaming UI state cleanup consistent across stop,
  // route changes, completion, and error paths.
  const clearStreamingState = useCallback(() => {
    setStreamingRunId(null);
    setStreamingSegments([]);
    setStreamingDisplayText("");
    setStreamingStatus(null);
    setStreamingMemoryCue(null);
    setIsAwaitingStreamingAnimationFinalization(false);
    streamingSegmentsRef.current = [];
    streamingDisplayTextRef.current = "";
    streamingMemoryCueRef.current = null;
    structuredResponseStateRef.current = createStructuredResponseStreamState();
    pendingStreamFinalizationRef.current = null;
  }, []);
  const teardownActionsRef = useRef({
    stop,
    cancelTts,
    abortAvatarRun,
    clearAvatarVisemeBridgeAll,
  });

  useEffect(() => {
    teardownActionsRef.current = {
      stop,
      cancelTts,
      abortAvatarRun,
      clearAvatarVisemeBridgeAll,
    };
  }, [abortAvatarRun, cancelTts, clearAvatarVisemeBridgeAll, stop]);

  const selectProfileModel = useCallback(
    async (item: PyModelProviderCatalogItem) => {
      if (activeModelProviderId === item.id) return;
      await updateAnimaChatProfile.mutateAsync({
        animaId,
        body: {
          default_model_provider_id: item.id,
        },
      });
    },
    [activeModelProviderId, animaId, updateAnimaChatProfile],
  );

  const restoreActiveChatModel = useCallback(async () => {
    const restorable = findRestorableChatModel(activeChat, modelProviders);
    if (!restorable) return;
    try {
      await selectProfileModel(restorable);
    } catch (error) {
      logger.error("Model", "Failed to restore chat model", error);
      toast.error("Failed to restore this chat's model.");
    }
  }, [activeChat, logger, modelProviders, selectProfileModel]);

  const requestModelSwitchToNewChat = useCallback(
    (item: PyModelProviderCatalogItem) => {
      setPendingModelSwitch({ item });
    },
    [],
  );

  const cancelPendingModelSwitch = useCallback(() => {
    setPendingModelSwitch(null);
    void restoreActiveChatModel();
  }, [restoreActiveChatModel]);

  const confirmPendingModelSwitch = useCallback(async () => {
    const pending = pendingModelSwitch;
    if (!pending) return;
    try {
      await selectProfileModel(pending.item);
      setPendingModelSwitch(null);
      setDraftChatId(null);
      suppressFetchChatRef.current = null;
      await openDraftChatRoute();
    } catch (error) {
      logger.error("Model", "Failed to start new chat with selected model", {
        error,
        modelProviderId: pending.item.id,
      });
      toast.error("Failed to start a new chat with that model.");
    }
  }, [logger, openDraftChatRoute, pendingModelSwitch, selectProfileModel]);

  const patchAnimaEmotionCaches = useCallback(
    (emotionValues: EmotionValue[] | null | undefined) => {
      if (
        !animaId ||
        !Array.isArray(emotionValues) ||
        emotionValues.length === 0
      ) {
        return;
      }

      const emotionalState = emotionStateFromValues(emotionValues);
      queryClient.setQueriesData(
        { queryKey: queryKeys.animas.all(userKey) },
        (current) =>
          patchAnimaEmotionSnapshot(current, animaId, emotionalState),
      );
    },
    [animaId, queryClient, userKey],
  );

  const patchChatTitleCaches = useCallback(
    (chatId: string, title: string, chatForInsert?: PyChatResponse | null) => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle) return;
      const patchRows = (rows: PyChatResponse[] | undefined) => {
        if (!Array.isArray(rows)) return rows;
        if (rows.some((chat) => chat.id === chatId)) {
          return rows.map((chat) =>
            chat.id === chatId ? { ...chat, title: trimmedTitle } : chat,
          );
        }
        if (!chatForInsert || chatForInsert.id !== chatId) return rows;
        return [{ ...chatForInsert, title: trimmedTitle }, ...rows];
      };
      queryClient.setQueryData<PyChatResponse[]>(
        queryKeys.chats.list(userKey, {
          includeLastMessageAt: true,
        }),
        patchRows,
      );
      queryClient.setQueryData<PyChatResponse[]>(
        queryKeys.chats.list(userKey, {
          includeLastMessageAt: false,
        }),
        patchRows,
      );
    },
    [queryClient, userKey],
  );

  const finalizeCompletedStream = useCallback(
    (pending: PendingStreamFinalization) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.detail(userKey, pending.chatId),
      });
      queryClient.setQueryData<PyChatMessage[]>(pending.messagesKey, (prev) => {
        const rows = Array.isArray(prev) ? prev : [];
        if (rows.some((msg) => msg.run_id === pending.runId)) return rows;
        return rows.concat(pending.nextMessages);
      });
      logger.info("Chat", "Refreshing messages cache with next messages", {
        nextMessages: pending.nextMessages,
        messagesKey: pending.messagesKey,
      });
      clearStreamingState();
      setLocalMessages((prev) =>
        prev.filter(
          (msg) => msg.id !== chatRunMessageId(pending.runId, "user"),
        ),
      );
      if (pending.refreshChatListsOnComplete) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.chats.list(userKey, {
            includeLastMessageAt: true,
          }),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.chats.list(userKey, {
            includeLastMessageAt: false,
          }),
        });
      }
    },
    [clearStreamingState, logger, queryClient, userKey],
  );

  const handleStreamingAnimationComplete = useCallback(() => {
    const pending = pendingStreamFinalizationRef.current;
    if (!pending) return;
    pendingStreamFinalizationRef.current = null;
    if (pending.requestNonTtsAvatarCompletion) {
      requestNonTtsResponseCompletion(pending.runId);
    }
    finalizeCompletedStream(pending);
  }, [finalizeCompletedStream, requestNonTtsResponseCompletion]);

  // ---------------------------------------------------------------------------
  // Effects: anima and route synchronization.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    resetAvatarRuntime(animaId);
  }, [animaId, resetAvatarRuntime]);

  useEffect(() => {
    clearAvatarVisemeBridgeAll({ clearAvatarLipSync: true });
  }, [clearAvatarVisemeBridgeAll, animaId]);

  useEffect(() => {
    if (!animaId || anima?.id !== animaId) return;
    setAnimaEmotionSnapshot(anima?.emotional_state ?? null);
  }, [anima?.emotional_state, anima?.id, animaId, setAnimaEmotionSnapshot]);

  useEffect(() => {
    if (routeChatId && draftChatId === routeChatId) {
      setDraftChatId(null);
    }
  }, [routeChatId, draftChatId]);

  useEffect(() => {
    const chatId = routeChatId ?? null;
    if (!chatId) {
      restoredModelChatIdRef.current = null;
      return;
    }
    if (restoredModelChatIdRef.current === chatId) return;
    if (isActiveChatLoading || isModelProvidersLoading) return;
    if (!activeChat || activeChat.id !== chatId) return;
    restoredModelChatIdRef.current = chatId;

    const restorable = findRestorableChatModel(activeChat, modelProviders);
    if (!restorable || restorable.id === activeModelProviderId) return;
    void selectProfileModel(restorable).catch((error: unknown) => {
      logger.error("Model", "Failed to restore historical chat model", {
        error,
        chatId,
        modelProviderId: restorable.id,
      });
      toast.error("Failed to restore this chat's model.");
    });
  }, [
    activeChat,
    activeModelProviderId,
    isActiveChatLoading,
    isModelProvidersLoading,
    logger,
    modelProviders,
    routeChatId,
    selectProfileModel,
  ]);

  useEffect(() => {
    const previousId = previousChatIdRef.current;
    const nextId = activeChatId ?? null;
    if ((previousId && previousId !== nextId) || (!nextId && previousId)) {
      cancelTts();
      abortAvatarRun(streamingRunId);
      clearAvatarVisemeBridgeRun(streamingRunId, { clearAvatarLipSync: true });
      skippedTtsRunIdsRef.current.clear();
      setLocalMessages([]);
      clearStreamingState();
    }
    previousChatIdRef.current = nextId;
  }, [
    abortAvatarRun,
    cancelTts,
    clearAvatarVisemeBridgeRun,
    clearStreamingState,
    activeChatId,
    streamingRunId,
  ]);

  useEffect(() => {
    return () => {
      const actions = teardownActionsRef.current;
      actions.stop();
      actions.cancelTts();
      actions.abortAvatarRun();
      actions.clearAvatarVisemeBridgeAll({ clearAvatarLipSync: true });
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Derived message list rendered by ChatInterface.
  // ---------------------------------------------------------------------------
  const displayMessages = useMemo(() => {
    const base = mapServerMessagesForDisplay(serverMessages);
    // Keep failed local turns beside their original place after later successful
    // turns enter the server cache. Persisted rows win if a refetch confirms them.
    const persistedIds = new Set(base.map((message) => message.id));
    const combined = base.concat(
      localMessages.filter((message) => !persistedIds.has(message.id)),
    );
    sortDisplayMessagesByCreatedAt(combined);
    if (streamingRunId) {
      const streamed: ChatMessage[] = [
        {
          id: chatRunMessageId(streamingRunId, "assistant"),
          role: "assistant",
          text: streamingText,
          isPending: !streamingText,
          pendingStatus: streamingStatus ?? undefined,
          animateOnEnter: true,
          animateTextEffect: Boolean(streamingText),
          streamingSegments,
        },
      ];
      const displayText = streamingDisplayText.trim();
      if (displayText && displayText !== streamingText.trim()) {
        streamed.push({
          id: chatRunMessageId(streamingRunId, "assistant", 1),
          role: "assistant",
          text: displayText,
          animateOnEnter: true,
          animateTextEffect: true,
        });
      }
      // Like a persisted reply, the cue sits on the run's last bubble.
      const last = streamed[streamed.length - 1];
      if (streamingMemoryCue && !last.isPending) {
        streamed[streamed.length - 1] = {
          ...last,
          memoryCue: streamingMemoryCue,
        };
      }
      combined.push(...streamed);
    }
    return combined;
  }, [
    serverMessages,
    localMessages,
    streamingRunId,
    streamingDisplayText,
    streamingMemoryCue,
    streamingSegments,
    streamingStatus,
    streamingText,
  ]);

  useEffect(() => {
    logger.debug("Chat Messages", "Preparing display messages", {
      serverMessages,
      localMessages,
      streamingRunId,
    });
  }, [serverMessages, localMessages, streamingRunId, logger]);

  // Stop button handler: cancel transport + audio/avatar side-effects and clear
  // pending streaming UI payload.
  const handleStop = useCallback(() => {
    const activeRunId = streamingRunId;
    stop();
    cancelTts();
    skippedTtsRunIdsRef.current.clear();
    abortAvatarRun(activeRunId);
    clearAvatarVisemeBridgeRun(activeRunId, { clearAvatarLipSync: true });
    clearStreamingState();
  }, [
    abortAvatarRun,
    cancelTts,
    clearAvatarVisemeBridgeRun,
    clearStreamingState,
    stop,
    streamingRunId,
  ]);

  const handleSkipTts = useCallback(() => {
    if (!isTtsAudioActive) return;
    const activeRunId =
      streamingRunId ?? pendingStreamFinalizationRef.current?.runId ?? null;
    cancelTts();
    if (activeRunId) {
      skippedTtsRunIdsRef.current.add(activeRunId);
    }
    if (activeRunId) {
      markAvatarSpeechEnded(activeRunId);
      finishAvatarRun(activeRunId);
      clearAvatarVisemeBridgeRun(activeRunId, { clearAvatarLipSync: true });
      return;
    }
    clearAvatarVisemeBridgeAll({ clearAvatarLipSync: true });
  }, [
    cancelTts,
    clearAvatarVisemeBridgeAll,
    clearAvatarVisemeBridgeRun,
    finishAvatarRun,
    isTtsAudioActive,
    markAvatarSpeechEnded,
    streamingRunId,
  ]);

  const submitMessage = useCallback(
    async (args: {
      text: string;
      clearInput?: boolean;
      inputMode?: InputMode;
      submitReason?: VoiceSubmitReason | "manual";
      turnId?: string | null;
      smartTurnJobId?: string | null;
      smartTurnScore?: number | null;
      smartTurnLatencyMs?: number | null;
    }) => {
      const {
        text,
        clearInput = true,
        inputMode = "typed",
        submitReason = "manual",
        turnId = null,
        smartTurnJobId = null,
        smartTurnScore = null,
        smartTurnLatencyMs = null,
      } = args;
      logger.info("Submit", "Submitting message", {
        inputLength: text.length,
        inputMode,
        submitReason,
        turnId,
        smartTurnJobId,
        smartTurnScore,
        smartTurnLatencyMs,
      });
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      const startTime = performance.now();
      let interactionStatus: "ok" | "error" | "invalid" = "ok";
      const runId = genRunId();
      const submittedAt = new Date().toISOString();
      // Snapshot partial output before clearing streaming refs. Failure notices
      // are session-local evidence, never optimistic claims of persisted history.
      const showFailure = (error: unknown) => {
        const speechText = streamingSegmentsRef.current.join("");
        const displayText = streamingDisplayTextRef.current;
        const partialText = [
          speechText,
          displayText === speechText ? "" : displayText,
        ]
          .filter(Boolean)
          .join("\n\n");
        const failure = describeChatFailure(error, trimmed, partialText);
        setLocalMessages((messages) => {
          const id = chatRunMessageId(runId, "user");
          const original = messages.find((message) => message.id === id);
          if (original?.failure) return messages;
          return original
            ? messages.map((message) =>
                message.id === id ? { ...message, failure } : message,
              )
            : messages.concat({
                id,
                role: "user",
                text: trimmed,
                createdAt: submittedAt,
                failure,
              });
        });
      };

      recordUiInteraction({
        action: "chat.submit",
        input_mode: inputMode,
        submit_reason: submitReason,
      });

      try {
        // 1) Validate chat preconditions tied to the active route/anima.
        if (!animaId) {
          interactionStatus = "invalid";
          logger.warn("Submit", "Missing anima id", { animaId });
          toast.error("Missing anima.");
          return;
        }
        if (!anima || anima.id !== animaId) {
          interactionStatus = "invalid";
          logger.warn("Submit", "Anima not loaded", {
            animaId,
            loadedAnimaId: anima?.id ?? null,
          });
          toast.error("Anima is still loading.");
          return;
        }
        if (
          !capabilities.chat ||
          !mountedRuntimeContent.canChat ||
          !mountedRuntimeContent.runtimeRevision
        ) {
          interactionStatus = "invalid";
          toast.error("Anima runtime is still loading.");
          return;
        }
        if (routeChatId && isActiveChatLoading) {
          interactionStatus = "invalid";
          toast.error("Chat is still loading.");
          return;
        }
        if (routeChatId && (isActiveChatError || !activeChat)) {
          interactionStatus = "invalid";
          toast.error("Chat could not be loaded.");
          return;
        }
        if (isModelProvidersLoading) {
          interactionStatus = "invalid";
          toast.error("Models are still loading.");
          return;
        }

        const modelGate = chatModelSendGate(activeChat, activeModelProvider);
        if (!modelGate.ok) {
          interactionStatus = "invalid";
          if (
            modelGate.reason === "api_standard_mismatch" &&
            activeModelProvider
          ) {
            requestModelSwitchToNewChat(activeModelProvider);
          } else if (modelGate.reason === "unsupported_model") {
            toast.error("This model is not available for direct chat yet.");
          } else {
            toast.error("Select a model before chatting.");
          }
          return;
        }

        // 2) Clear input eagerly once the submission is accepted locally.
        if (clearInput) {
          setInput("");
        }

        let workingChatId = activeChatId;
        let isNewChat = false;
        let createdChatForTitle: PyChatResponse | null = null;

        // 3) Ensure chat id exists before starting chat run events.
        if (!workingChatId) {
          const created = await createChat.mutateAsync({
            body: {
              anima_id: animaId,
              title: null,
            },
          });
          const createdChatId = created.id;
          workingChatId = createdChatId;
          createdChatForTitle = created;
          setDraftChatId(createdChatId);
          suppressFetchChatRef.current = createdChatId;
          isNewChat = true;
          logger.info("Chat", "Created chat", {
            animaId,
            chatId: createdChatId,
          });
        }

        if (!workingChatId) {
          throw new Error("Chat not created.");
        }

        const resolvedChatId = workingChatId;
        const ttsEnabled = speech.enabled;
        const useMainStructuredResponse = ttsEnabled;
        const ttsProvider = speech.provider;
        const elevenLabsModelId = speech.elevenLabsModelId;
        const visemeProvider =
          ttsProvider === "pocket_tts" ||
          ttsProvider === "elevenlabs" ||
          ttsProvider === "gemini"
            ? ttsProvider
            : undefined;
        const shouldQueueViseme = ttsEnabled && visemeProvider !== undefined;
        const isFinalizedServerAudio = speech.finalizedServerAudio;

        // 4) Start local run state before opening SSE:
        // - optimistic user message
        // - streaming placeholder
        // - TTS and avatar run start markers
        skippedTtsRunIdsRef.current.delete(runId);
        setLocalMessages((prev) =>
          prev.concat({
            id: chatRunMessageId(runId, "user"),
            role: "user",
            text: trimmed,
            createdAt: submittedAt,
            animateOnEnter: true,
          }),
        );
        setStreamingRunId(runId);
        setStreamingSegments([]);
        setStreamingDisplayText("");
        setStreamingStatus(null);
        setStreamingMemoryCue(null);
        streamingSegmentsRef.current = [];
        streamingDisplayTextRef.current = "";
        streamingMemoryCueRef.current = null;
        structuredResponseStateRef.current =
          createStructuredResponseStreamState();
        if (ttsEnabled) {
          startTtsRun(runId);
        }
        startAvatarRun(runId, { inputText: trimmed });
        logger.info("ChatSse", "Starting chat SSE", {
          animaId,
          chatId: resolvedChatId,
          runId,
          inputMode,
          submitReason,
          turnId,
          smartTurnJobId,
          smartTurnScore,
          smartTurnLatencyMs,
          ttsEnabled,
          useMainStructuredResponse,
          ttsProvider,
          elevenLabsModelId,
          shouldQueueViseme,
        });

        let replacedRoute = false;
        let receivedChatTitle = false;
        let voiceStructuredResponseSeen = false;
        let voiceTtsCompleted = false;
        let structuredTtsAppended = false;
        let nonTtsResponseStarted = false;
        let visemeInputsQueued = false;
        let structuredVisemeInputs: AccumulatedStructuredSpeechVisemeInputs | null =
          null;
        const ttsSkippedForRun = (id: string) =>
          skippedTtsRunIdsRef.current.has(id);
        /**
         * Mirrors the pure structured reducer state into the existing React
         * state/refs consumed by displayMessages and completion reconciliation.
         */
        const syncStructuredResponseState = (
          nextState: ReturnType<typeof createStructuredResponseStreamState>,
        ) => {
          structuredResponseStateRef.current = nextState;
          streamingSegmentsRef.current = nextState.speechSegments;
          streamingDisplayTextRef.current = nextState.displayText;
          setStreamingSegments(nextState.speechSegments);
          setStreamingDisplayText(nextState.displayText);
        };
        /**
         * TTS-disabled runs still need the avatar to leave "thinking" once
         * visible assistant output appears. Structured display-only output also
         * counts because it is the user's visible response.
         */
        const maybeMarkNonTtsResponseStarted = (value: string) => {
          if (ttsEnabled || nonTtsResponseStarted || !value.trim()) {
            return;
          }
          markNonTtsResponseStarted(runId);
          nonTtsResponseStarted = true;
        };
        /**
         * Structured speech streams into TTS as each speech delta arrives.
         * Complete non-delta fallback speech can still append once when no
         * structured TTS text has already been sent.
         */
        const appendStructuredSpeechTts = (
          completedRunId: string,
          payload: StructuredSpeechTtsPayload | null,
        ) => {
          if (
            !payload ||
            !ttsEnabled ||
            voiceTtsCompleted ||
            ttsSkippedForRun(completedRunId)
          ) {
            return;
          }
          appendTtsToken(
            completedRunId,
            payload.text,
            payload.textBasis === "gruut_text_with_ws"
              ? { textBasis: "gruut_text_with_ws" }
              : undefined,
          );
          structuredTtsAppended = true;
        };
        const queueStructuredSpeechVisemeInputs = (
          completedRunId: string,
          payload: StructuredSpeechTtsPayload | null,
          data: {
            tts_phonemized_text?: string[][] | null;
            phonemized_text?: string[][] | null;
            tokenized_text?: string | null;
          },
          fallbackTokenizedText: string,
        ) => {
          if (
            !shouldQueueViseme ||
            !payload ||
            ttsSkippedForRun(completedRunId)
          ) {
            return;
          }

          const visemePayload = selectStructuredSpeechVisemePayload({
            ttsPayload: payload,
            ttsPhonemizedText: data.tts_phonemized_text,
            phonemizedText: data.phonemized_text,
            tokenizedText: data.tokenized_text,
            fallbackTokenizedText,
          });
          if (!visemePayload) return;

          structuredVisemeInputs = appendStructuredSpeechVisemeInputs(
            structuredVisemeInputs,
            visemePayload,
          );
          queueAvatarVisemeInputsForRun({
            runId: completedRunId,
            phonemizedText: structuredVisemeInputs.phonemizedText,
            tokenizedText: structuredVisemeInputs.tokenizedText,
            provider: visemeProvider,
          });
          visemeInputsQueued = true;
        };
        /**
         * Final markers only close the TTS run. They must not re-append the
         * accumulated structured speech, because deltas were already queued.
         */
        const completeStructuredSpeechTts = (completedRunId: string) => {
          if (
            !ttsEnabled ||
            voiceTtsCompleted ||
            ttsSkippedForRun(completedRunId)
          ) {
            return;
          }
          completeTtsRun(completedRunId);
          voiceTtsCompleted = true;
        };
        let speechFellBackToPocket = false;
        /**
         * An exhausted voice allowance declines this run's ElevenLabs speech,
         * before or after its reply text. When the playback adapter can speak
         * the run with Pocket TTS instead, the run stays a TTS run (its text
         * and completion keep flowing) and later ElevenLabs frames for it are
         * ignored. Otherwise, and for every other code, its speech ends.
         */
        const fallBackFromDeclinedSpeech = (
          declinedRunId: string,
          frame: { code?: string | null },
        ): boolean => {
          if (
            !isSpeechAllowanceExhausted(frame) ||
            !ttsEnabled ||
            ttsProvider !== "elevenlabs" ||
            ttsSkippedForRun(declinedRunId) ||
            !fallBackToPocketTts?.(declinedRunId)
          ) {
            return false;
          }
          speechFellBackToPocket = true;
          logger.info("TTS", "Speaking with Pocket TTS for this run", {
            runId: declinedRunId,
            code: frame.code,
          });
          return true;
        };
        const maybeReplaceRoute = () => {
          if (!isNewChat || replacedRoute) return;
          void Promise.resolve(replaceChatRoute(resolvedChatId))
            .then(() => {
              logger.info("Routing", "Replaced route after SSE complete", {
                animaId,
                chatId: resolvedChatId,
              });
            })
            .catch((error: unknown) => {
              logger.error(
                "Routing",
                "Failed to replace route after SSE complete",
                error,
              );
            });
          replacedRoute = true;
        };

        // 5) Open chat SSE and reconcile each streamed event type.
        const attachedFileIds = getAttachedFileIds?.() ?? [];
        const resolvedChatRequestOptions = {
          ...(chatRequestOptions ?? {}),
          ...(useMainStructuredResponse
            ? { main_structured_response: true }
            : {}),
          ...(speech.dispatchOptions ?? {}),
        };
        await startChat({
          animaId,
          body: buildChatSseRequestBody({
            message: trimmed,
            runId,
            chatId: resolvedChatId,
            modelProviderId: activeModelProvider?.id,
            runtimeRevision: mountedRuntimeContent.runtimeRevision!,
            attachedFileIds,
            dispatchOptions: resolvedChatRequestOptions,
            requestableNativeTools: activeModelProvider
              ? selectableNativeTools(activeModelProvider, webSearch)
              : undefined,
            clientContext: currentChatClientContext(),
          }),
          onAiNotice: (notice) => safetyRef.current?.onAiNotice?.(notice),
          onCrisisSupport: (card) => safetyRef.current?.onCrisisSupport?.(card),
          onRunStatus: (status) => {
            setStreamingStatus((current) =>
              status.phase === "started"
                ? status.status
                : current === status.status
                  ? null
                  : current,
            );
          },
          onToken: (token, data) => {
            logger.info("Chat", "SSE received token", { token });
            // is_delta controls how this event's text mutates the current part:
            // append for deltas, replace for complete/correction events.
            // part_final is independent; it only means this part is finished,
            // and may arrive on an empty final marker.
            const structuredUpdate = reduceStructuredResponseStream(
              structuredResponseStateRef.current,
              {
                response_part: data.response_part,
                text: token,
                is_delta: data.is_delta,
                part_index: data.part_index,
                part_final: data.part_final,
              },
            );
            if (structuredUpdate.handled) {
              voiceStructuredResponseSeen = true;
              syncStructuredResponseState(structuredUpdate.state);

              // Display is visible-only. It can start the non-TTS avatar
              // response phase, but it must never be submitted to TTS.
              if (structuredUpdate.part === "display") {
                maybeMarkNonTtsResponseStarted(token);
                return;
              }

              const speech = structuredUpdate.state.speechText.trim();
              maybeMarkNonTtsResponseStarted(speech);

              const isDeltaSpeech = data.is_delta === true;
              const ttsPayload = selectStructuredSpeechTtsPayload({
                visibleText: token,
                ttsText: data.tts_text,
                ttsTextBasis: data.tts_text_basis,
                isDelta: isDeltaSpeech,
                structuredTtsAppended,
              });
              queueStructuredSpeechVisemeInputs(
                data.run_id ?? runId,
                ttsPayload,
                {
                  tts_phonemized_text: data.tts_phonemized_text,
                  phonemized_text: data.phonemized_text,
                  tokenized_text: data.tokenized_text,
                },
                token,
              );
              appendStructuredSpeechTts(data.run_id ?? runId, ttsPayload);
              // A final marker can be an empty delta, so completion depends on
              // partFinal rather than token truthiness.
              if (structuredUpdate.partFinal || !isDeltaSpeech) {
                completeStructuredSpeechTts(data.run_id ?? runId);
              }
              return;
            }
            // Error/completion can follow a token in the same network chunk,
            // before React processes state updaters. Keep the snapshot current.
            const next = streamingSegmentsRef.current.concat(token);
            streamingSegmentsRef.current = next;
            setStreamingSegments(next);
            maybeMarkNonTtsResponseStarted(token);
            if (ttsEnabled && !ttsSkippedForRun(runId)) {
              appendTtsToken(runId, token);
            }
          },
          onTtsSession: (data) => {
            const sessionRunId = data.run_id ?? runId;
            if (
              !ttsEnabled ||
              ttsProvider !== "elevenlabs" ||
              speechFellBackToPocket ||
              ttsSkippedForRun(sessionRunId)
            ) {
              return;
            }
            if (
              typeof data.voice_id !== "string" ||
              typeof data.model_id !== "string" ||
              typeof data.output_format !== "string" ||
              typeof data.sync_alignment !== "boolean" ||
              (data.transport === "server"
                ? typeof data.websocket_url !== "string" ||
                  !data.websocket_url.trim()
                : (data.transport != null && data.transport !== "direct") ||
                  typeof data.token !== "string" ||
                  !data.token)
            ) {
              skippedTtsRunIdsRef.current.add(sessionRunId);
              markElevenLabsSessionFailed(
                sessionRunId,
                "ElevenLabs realtime TTS session data was incomplete.",
              );
              return;
            }
            acceptElevenLabsSession(sessionRunId, {
              voice_id: data.voice_id,
              model_id: data.model_id,
              output_format: data.output_format,
              sync_alignment: data.sync_alignment,
              language_code: data.language_code ?? null,
              transport: data.transport === "server" ? "server" : "direct",
              websocket_url:
                data.transport === "server" ? data.websocket_url : null,
              token: data.transport === "server" ? null : (data.token ?? null),
              websocket_base_url:
                data.transport === "server"
                  ? null
                  : (data.websocket_base_url ?? null),
            });
          },
          onTtsSessionError: (data) => {
            const sessionRunId = data.run_id ?? runId;
            // A run speaking with Pocket has no ElevenLabs speech left to end.
            if (speechFellBackToPocket) return;
            if (fallBackFromDeclinedSpeech(sessionRunId, data)) return;
            skippedTtsRunIdsRef.current.add(sessionRunId);
            markElevenLabsSessionFailed(sessionRunId, data);
          },
          onTtsAudio: (data) => {
            const audioRunId = data.run_id ?? runId;
            if (
              !ttsEnabled ||
              !isFinalizedServerAudio ||
              speechFellBackToPocket ||
              ttsSkippedForRun(audioRunId)
            ) {
              return;
            }
            acceptFinalizedAudio(audioRunId, data);
          },
          onTtsDone: (data) => {
            const audioRunId = data.run_id ?? runId;
            if (
              !ttsEnabled ||
              !isFinalizedServerAudio ||
              speechFellBackToPocket ||
              ttsSkippedForRun(audioRunId)
            ) {
              return;
            }
            completeFinalizedAudio(audioRunId);
          },
          onTtsError: (data) => {
            const audioRunId = data.run_id ?? runId;
            if (
              !ttsEnabled ||
              !isFinalizedServerAudio ||
              speechFellBackToPocket
            ) {
              return;
            }
            // Finalized speech (Gemini) has no Pocket fallback: a decline ends it.
            skippedTtsRunIdsRef.current.add(audioRunId);
            markFinalizedAudioFailed(audioRunId, data);
          },
          onEmotionUpdate: (data) => {
            // Full-state emotion updates drive both the live avatar runtime
            // and the persisted anima cache snapshots used elsewhere in the UI.
            applyAvatarEmotionUpdate({
              eventId: data.event_id ?? null,
              runId: data.run_id ?? runId,
              emotions: data.emotions ?? null,
              emotionalTone: data.emotional_tone ?? null,
              emotionalIntensity: data.emotional_intensity ?? null,
            });
            patchAnimaEmotionCaches(data.emotions ?? null);
          },
          onAvatarGestureRequested: (data) => {
            requestAvatarGesture({
              eventId: data.event_id ?? null,
              runId: data.run_id ?? runId,
              gesture: data.gesture ?? null,
            });
          },
          onRuntimeContentRevisionMismatch: () => {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.animaLoadouts.runtime(userKey, animaId),
            });
          },
          onMemoryUpdated: (memoryCue) => {
            streamingMemoryCueRef.current = memoryCue;
            setStreamingMemoryCue(memoryCue);
            // The turn wrote memory the Memory workspace may hold cached, and
            // the cue links there, so mark the written family stale.
            if (memoryCue.memories) {
              void queryClient.invalidateQueries({
                queryKey: queryKeys.memoryEntries.all(userKey),
              });
            }
            if (memoryCue.episode) {
              void queryClient.invalidateQueries({
                queryKey: queryKeys.memoryEpisodes.all(userKey),
              });
            }
          },
          onChatTitleUpdated: (data) => {
            const title = data.title?.trim() ?? "";
            const eventChatId = data.chat_id ?? resolvedChatId;
            if (!title || eventChatId !== resolvedChatId) return;
            receivedChatTitle = true;
            patchChatTitleCaches(eventChatId, title, createdChatForTitle);
          },
          onComplete: (data) => {
            // Completion finalizes run side-effects and caches both local user
            // text and fully streamed assistant text into query state.
            const completedRunId = data.run_id ?? runId;
            logger.info("Chat", "SSE run completed", {
              animaId,
              chatId: data.chat_id ?? resolvedChatId,
              runId: completedRunId,
            });
            let assistantTexts = [streamingSegmentsRef.current.join("").trim()]
              .map((value) => value.trim())
              .filter(Boolean);
            if (voiceStructuredResponseSeen) {
              // Structured completion writes speech plus an optional distinct
              // display message. Equal display text is suppressed by the helper.
              assistantTexts = getStructuredAssistantTexts(
                structuredResponseStateRef.current,
              );
            }
            if (
              shouldQueueViseme &&
              !visemeInputsQueued &&
              !ttsSkippedForRun(completedRunId) &&
              Array.isArray(data.phonemized_text) &&
              data.phonemized_text.length
            ) {
              queueAvatarVisemeInputsForRun({
                runId: completedRunId,
                phonemizedText: data.phonemized_text ?? null,
                tokenizedText: data.tokenized_text ?? null,
                provider: visemeProvider,
              });
              visemeInputsQueued = true;
            } else {
              logger.info("Chat", "No viseme inputs queued for completed run", {
                runId: completedRunId,
                shouldQueueViseme,
                ttsEnabled,
                ttsProvider,
                hasPhonemizedText: Array.isArray(data.phonemized_text),
                visemeInputsQueued,
              });
            }
            if (ttsEnabled && !ttsSkippedForRun(completedRunId)) {
              if (voiceStructuredResponseSeen) {
                if (!voiceTtsCompleted) {
                  completeStructuredSpeechTts(completedRunId);
                }
              } else {
                completeTtsRun(completedRunId);
              }
            } else {
              logger.info(
                "Chat",
                "Deferring non-TTS avatar run finish until planner drains",
                {
                  runId: completedRunId,
                },
              );
            }
            skippedTtsRunIdsRef.current.delete(completedRunId);
            maybeReplaceRoute();
            const now = Date.now();
            const userCreatedAt = new Date(now).toISOString();
            const messagesKey = queryKeys.chats.messages(
              userKey,
              resolvedChatId,
            );
            const nextMessages: PyChatMessage[] = [
              {
                chat_id: resolvedChatId,
                run_id: runId,
                role: "user",
                content: trimmed,
                created_at: userCreatedAt,
              },
            ];
            if (assistantTexts.length) {
              // These rows stand in for server history without a refetch (new
              // chats never refetch), so they carry the streamed cue on the
              // last reply row, as the history API would.
              const memoryCue = streamingMemoryCueRef.current;
              assistantTexts.forEach((assistantText, index) => {
                const isLast = index === assistantTexts.length - 1;
                nextMessages.push({
                  chat_id: resolvedChatId,
                  run_id: runId,
                  role: "assistant",
                  content: assistantText,
                  created_at: new Date(now + index + 1).toISOString(),
                  ...(isLast && memoryCue ? { memory_cue: memoryCue } : {}),
                });
              });
            } else {
              logger.warn(
                "Chat",
                "No new assistant text to update messages cache with",
              );
            }
            const pendingFinalization = {
              chatId: resolvedChatId,
              messagesKey,
              nextMessages,
              runId: completedRunId,
              requestNonTtsAvatarCompletion: !ttsEnabled,
              refreshChatListsOnComplete: !isNewChat || receivedChatTitle,
            };
            if (assistantTexts.length) {
              setIsAwaitingStreamingAnimationFinalization(true);
              pendingStreamFinalizationRef.current = pendingFinalization;
            } else {
              if (!ttsEnabled) {
                requestNonTtsResponseCompletion(completedRunId);
              }
              finalizeCompletedStream(pendingFinalization);
            }
          },
          onError: (error) => {
            if (error instanceof Error && error.name === "AbortError") {
              abortAvatarRun(runId);
              clearAvatarVisemeBridgeRun(runId, { clearAvatarLipSync: true });
              return;
            }
            if (isRuntimeRemountRequired(error)) {
              const recovery = runtimeRemountRecovery(trimmed);
              interactionStatus = "error";
              cancelTts();
              abortAvatarRun(runId);
              clearAvatarVisemeBridgeRun(runId, {
                clearAvatarLipSync: true,
              });
              clearStreamingState();
              setLocalMessages((messages) =>
                messages.filter(
                  (message) => message.id !== chatRunMessageId(runId, "user"),
                ),
              );
              if (clearInput) setInput(recovery.preserveText);
              toast.error(
                "This Avatar session expired. Reload it, then send your message again.",
                {
                  action: {
                    label: "Reload Avatar Session",
                    onClick: () => {
                      void queryClient
                        .invalidateQueries({
                          queryKey: queryKeys.animaLoadouts.runtime(
                            userKey,
                            animaId,
                          ),
                          refetchType: "none",
                        })
                        .then(() => mountedRuntimeContent.remountLatest());
                    },
                  },
                },
              );
              return;
            }
            // Non-abort errors are surfaced and we tear down all active run
            // side-effects to prevent stale speaking/streaming state.
            interactionStatus = "error";
            logger.error("Chat", "SSE stream error", error);
            cancelTts();
            abortAvatarRun(runId);
            clearAvatarVisemeBridgeRun(runId, { clearAvatarLipSync: true });
            showFailure(error);
            clearStreamingState();
          },
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          abortAvatarRun();
          clearAvatarVisemeBridgeAll({ clearAvatarLipSync: true });
          return;
        }
        interactionStatus = "error";
        logger.error("Chat", "Failed to send message", error);
        cancelTts();
        abortAvatarRun();
        clearAvatarVisemeBridgeAll({ clearAvatarLipSync: true });
        showFailure(error);
        clearStreamingState();
      } finally {
        const durationMs = performance.now() - startTime;
        recordUiInteractionDuration(durationMs, {
          action: "chat.submit",
          status: interactionStatus,
          input_mode: inputMode,
          submit_reason: submitReason,
        });
      }
    },
    [
      isStreaming,
      animaId,
      acceptFinalizedAudio,
      acceptElevenLabsSession,
      appendTtsToken,
      applyAvatarEmotionUpdate,
      abortAvatarRun,
      cancelTts,
      clearAvatarVisemeBridgeAll,
      clearAvatarVisemeBridgeRun,
      completeFinalizedAudio,
      completeTtsRun,
      fallBackToPocketTts,
      markNonTtsResponseStarted,
      anima,
      activeChat,
      activeChatId,
      activeModelProvider,
      createChat,
      chatRequestOptions,
      webSearch,
      speech,
      capabilities.chat,
      recordUiInteraction,
      recordUiInteractionDuration,
      markFinalizedAudioFailed,
      markElevenLabsSessionFailed,
      replaceChatRoute,
      routeChatId,
      queueAvatarVisemeInputsForRun,
      requestModelSwitchToNewChat,
      startChat,
      startAvatarRun,
      startTtsRun,
      userKey,
      clearStreamingState,
      finalizeCompletedStream,
      getAttachedFileIds,
      logger,
      patchChatTitleCaches,
      patchAnimaEmotionCaches,
      requestAvatarGesture,
      requestNonTtsResponseCompletion,
      isActiveChatError,
      isActiveChatLoading,
      isModelProvidersLoading,
      mountedRuntimeContent,
      queryClient,
    ],
  );

  // Main submit flow: validates anima context, ensures chat state,
  // starts run-level side effects (avatar/TTS), then streams SSE callbacks.
  const handleSubmit = useCallback(async () => {
    await submitMessage({
      text: input,
      clearInput: true,
      inputMode: "typed",
      submitReason: "manual",
    });
  }, [input, submitMessage]);

  const handleSubmitText = useCallback(
    async (args: {
      text: string;
      inputMode?: InputMode;
      submitReason?: VoiceSubmitReason | "manual";
      turnId?: string | null;
      smartTurnJobId?: string | null;
      smartTurnScore?: number | null;
      smartTurnLatencyMs?: number | null;
      clearInput?: boolean;
    }) => {
      await submitMessage({
        text: args.text,
        clearInput: args.clearInput ?? true,
        inputMode: args.inputMode ?? "typed",
        submitReason: args.submitReason ?? "manual",
        turnId: args.turnId ?? null,
        smartTurnJobId: args.smartTurnJobId ?? null,
        smartTurnScore: args.smartTurnScore ?? null,
        smartTurnLatencyMs: args.smartTurnLatencyMs ?? null,
      });
    },
    [submitMessage],
  );
  const restoreFailedMessage = useCallback(
    (text: string) => {
      // Restoring is never a send and must not clobber a new draft.
      if (!isStreaming)
        setInput((current) => (current.trim() ? current : text));
    },
    [isStreaming],
  );

  return {
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
    isConfirmingModelSwitch: updateAnimaChatProfile.isPending,
  };
}
