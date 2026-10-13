"use client";

import { useCallback, useEffect, useRef } from "react";

import { createLogger } from "@/lib/logger";
import { PCMPlayerWorklet } from "@/lib/speech/audio/PCMPlayerWorklet.js";
import { mapNormalizedVolumeToPocketGain } from "@/lib/speech/pocket/audio/volume.js";
import {
  createSpeechTimingCollector,
  type SpeechTimingCollector,
  type TimedChar,
} from "@/lib/speech/provider-speech-timing";
import { speechPcmTap } from "@/lib/speech/speech-debug-tap";
import { redactUrlForLogging } from "@/lib/utils";
import { publicResourceUrl } from "@/lib/resource-urls";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";

const ELEVENLABS_SAMPLE_RATE = 24000;
const ELEVENLABS_DEFAULT_WS_BASE = "wss://api.elevenlabs.io";
const ELEVENLABS_SESSION_WAIT_TIMEOUT_MS = 1500;
/**
 * The Text to Dialogue socket closes after 20 s without a client message; a
 * reply can pause longer than that while the model writes other fields.
 */
const ELEVENLABS_DIALOGUE_KEEP_ALIVE_MS = 10_000;

type RealtimeSpeechContext = {
  animaId: string | null;
  emotionLabel?: string | null;
  emotionIntensity?: number | null;
  languageCode?: string | null;
  modelId?: string | null;
};

type AudioEndedReason = "natural" | "error";

export type ElevenLabsSessionResponse = {
  voice_id: string;
  model_id: string;
  output_format: string;
  sync_alignment: boolean;
  language_code?: string | null;
  token?: string | null;
  websocket_base_url?: string | null;
  transport?: "direct" | "server";
  websocket_url?: string | null;
};

export type ElevenLabsSessionError = {
  error?: string | null;
  code?: string | null;
  status_code?: number | null;
  details?: unknown;
};

type SessionStatus = "pending" | "provided" | "failed" | "timeout";

type UseElevenLabsTtsRuntimeOptions = {
  onAudioStarted?: (event: {
    runId: string;
    provider: "elevenlabs";
    audioStartSec?: number | null;
    audioContext?: AudioContext | null;
  }) => void;
  onAudioDurationResolved?: (event: {
    runId: string;
    provider: "elevenlabs";
    audioDurationSec: number;
  }) => void;
  onPlaybackEndedSignal?: (event: {
    runId: string;
    provider: "elevenlabs";
  }) => void;
  onAudioEnded?: (event: {
    runId: string;
    provider: "elevenlabs";
    reason: AudioEndedReason;
  }) => void;
  onWarning?: (runId: string, reason: string, message: string) => void;
  /**
   * Characters the provider timed for the run, on the run clock (seconds from
   * its first audio sample), as each frame arrives.
   */
  onSpeechTiming?: (event: {
    runId: string;
    provider: "elevenlabs";
    chars: TimedChar[];
  }) => void;
};

type ActiveRuntime = {
  runId: string;
  context: RealtimeSpeechContext;
  socket: WebSocket | null;
  /** The speech protocol of the open socket; `null` until a session opens one. */
  protocol: RealtimeSpeechProtocol | null;
  /** The voice registered on the open socket, which every dialogue input names. */
  voiceId: string;
  ready: boolean;
  queuedFrames: Array<{ type: "text"; text: string } | { type: "end" }>;
  /** Whether the provider has been asked to start speaking without its 40-character buffer. */
  flushedFirstChunk: boolean;
  keepAliveTimer: number | null;
  audioContext: AudioContext | null;
  player: PCMPlayerWorklet | null;
  totalSamples: number;
  /** Places the provider's character timing on the run clock. */
  timing: SpeechTimingCollector;
  sentTextChars: number;
  durationResolved: boolean;
  closed: boolean;
  ended: boolean;
  sawAudio: boolean;
  sawPlaybackStart: boolean;
  sawStreamFinished: boolean;
  requestedStreamEnd: boolean;
  stopReason: AudioEndedReason | null;
  startPromise: Promise<void> | null;
  providedSession: ElevenLabsSessionResponse | null;
  sessionError: Error | null;
  sessionPromise: Promise<ElevenLabsSessionResponse> | null;
  resolveSession: ((session: ElevenLabsSessionResponse) => void) | null;
  rejectSession: ((error: Error) => void) | null;
  sessionFallbackTimer: number | null;
  sessionStatus: SessionStatus | null;
};

type PCMPlaybackStartEvent = {
  detail?: {
    startTime?: unknown;
  };
};

type SpeechAudioWindow = Window &
  typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };

function asSpeechAudioWindow(): SpeechAudioWindow | null {
  if (typeof window === "undefined") return null;
  return window as SpeechAudioWindow;
}

function createInitialRuntime(
  runId: string,
  context: RealtimeSpeechContext,
): ActiveRuntime {
  return {
    runId,
    context,
    socket: null,
    protocol: null,
    voiceId: "",
    ready: false,
    queuedFrames: [],
    flushedFirstChunk: false,
    keepAliveTimer: null,
    audioContext: null,
    player: null,
    totalSamples: 0,
    timing: createSpeechTimingCollector(ELEVENLABS_SAMPLE_RATE),
    sentTextChars: 0,
    durationResolved: false,
    closed: false,
    ended: false,
    sawAudio: false,
    sawPlaybackStart: false,
    sawStreamFinished: false,
    requestedStreamEnd: false,
    stopReason: null,
    startPromise: null,
    providedSession: null,
    sessionError: null,
    sessionPromise: null,
    resolveSession: null,
    rejectSession: null,
    sessionFallbackTimer: null,
    sessionStatus: null,
  };
}

function createRunCancelledError(): Error {
  const error = new Error("ElevenLabs realtime TTS run cancelled.");
  error.name = "AbortError";
  return error;
}

function createSessionError(error: ElevenLabsSessionError | string): Error {
  if (typeof error === "string") {
    return new Error(
      error.trim() || "Failed to initialize ElevenLabs realtime TTS.",
    );
  }
  const message =
    typeof error.error === "string" && error.error.trim()
      ? error.error.trim()
      : "Failed to initialize ElevenLabs realtime TTS.";
  const sessionError = new Error(message);
  sessionError.name = "ElevenLabsSessionError";
  return sessionError;
}

function decodeBase64Pcm(audioBase64: string): Int16Array {
  const binary = atob(audioBase64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(buffer);
}

function decodeBinaryPcm(data: Blob | ArrayBuffer): Promise<Int16Array> {
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(new Int16Array(data));
  }
  return data.arrayBuffer().then((buffer) => new Int16Array(buffer));
}

async function createAudioResources(): Promise<{
  audioContext: AudioContext;
  player: PCMPlayerWorklet;
}> {
  const speechWindow = asSpeechAudioWindow();
  const AudioContextCtor =
    speechWindow?.AudioContext ?? speechWindow?.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const audioContext = new AudioContextCtor({
    sampleRate: ELEVENLABS_SAMPLE_RATE,
    latencyHint: "interactive",
  });
  try {
    const player = new PCMPlayerWorklet(audioContext, {
      workletModuleUrl: publicResourceUrl("tts/audio/pcm-processor.worklet.js"),
      minBufferBeforePlaybackMs: 180,
      bufferSizeSamples: ELEVENLABS_SAMPLE_RATE * 60,
    });
    await player.initPromise;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return { audioContext, player };
  } catch (error) {
    // Initialization can fail before the run owns these resources (missing
    // worklet, unsupported device or interrupted session). Close that context.
    await audioContext.close().catch(() => {});
    throw error;
  }
}

/**
 * How the runtime talks to the socket it opened.
 *
 * - `dialogue`: ElevenLabs' Text to Dialogue socket, the only one that speaks
 *   Eleven v4 Turbo. The first message registers the voice; text arrives as
 *   `inputs`; `close_socket` ends the stream.
 * - `server`: a hosted consumer's same-origin socket, which validates plain
 *   `{text}` frames and speaks the reply itself.
 */
type RealtimeSpeechProtocol = "dialogue" | "server";

function realtimeSpeechProtocol(
  session: ElevenLabsSessionResponse,
): RealtimeSpeechProtocol {
  return session.transport === "server" ? "server" : "dialogue";
}

/** The first message each protocol expects once the socket opens. */
function openingFrame(
  protocol: RealtimeSpeechProtocol,
  voiceId: string,
): Record<string, unknown> {
  return protocol === "dialogue" ? { voices: [voiceId] } : { text: " " };
}

/** Frames for one chunk of reply text. */
function textFrames(
  protocol: RealtimeSpeechProtocol,
  voiceId: string,
  text: string,
  flushFirstChunk: boolean,
): Array<Record<string, unknown>> {
  if (protocol === "server") return [{ text }];
  // Chunks arrive trimmed; the trailing space keeps words apart across inputs.
  const frames: Array<Record<string, unknown>> = [
    { inputs: [{ text: `${text} `, voice_id: voiceId }] },
  ];
  // The provider otherwise holds a short first sentence until it has about 40
  // characters and 8 words. One flush starts speech; later chunks keep one
  // prosody turn.
  if (flushFirstChunk) frames.push({ flush: true });
  return frames;
}

/** The frame that ends the reply's text. */
function endFrame(protocol: RealtimeSpeechProtocol): Record<string, unknown> {
  return protocol === "dialogue" ? { close_socket: true } : { text: "" };
}

/**
 * Resolve an admitted speech session. Server sockets use cookies and never inherit
 * provider tokens; the existing local direct path requires connection authority.
 * The historical export name remains compatible with local consumers.
 */
export function buildDirectElevenLabsRealtimeWsUrl(
  session: ElevenLabsSessionResponse,
  policy: { origin: string; allowDirect: boolean } = {
    origin:
      typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin,
    allowDirect: true,
  },
): string {
  if (session.transport === "server") {
    if (!session.websocket_url)
      throw new Error("Server speech stream is unavailable.");
    const origin = new URL(policy.origin);
    const expected = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}`;
    // Resolve only relative paths against a websocket origin; an HTTP URL is not a socket.
    const url = new URL(session.websocket_url, expected);
    if (
      url.origin !== expected ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/v1/")
    )
      throw new Error(
        "Server speech stream must use the admitted application origin.",
      );
    return url.href;
  }
  if (
    !policy.allowDirect ||
    !session.token ||
    (session.transport && session.transport !== "direct")
  )
    throw new Error("Direct speech provider access is unavailable.");
  const query = new URLSearchParams({
    model_id: session.model_id,
    output_format: session.output_format,
    sync_alignment: session.sync_alignment ? "true" : "false",
    single_use_token: session.token ?? "",
  });
  if (session.language_code) {
    query.set("language_code", session.language_code);
  }
  const wsBase = session.websocket_base_url || ELEVENLABS_DEFAULT_WS_BASE;
  // Eleven v4 Turbo speaks only on the Text to Dialogue socket; the voice is
  // registered by the first message rather than the path.
  return `${wsBase}/v1/text-to-dialogue/stream-input?${query.toString()}`;
}

export function useElevenLabsTtsRuntime(
  options: UseElevenLabsTtsRuntimeOptions,
) {
  const { data: capabilities } = useRuntimeCapabilities();
  const socketPolicy = useRef({
    origin: window.location.origin,
    allowDirect: false,
  });
  socketPolicy.current = {
    origin: window.location.origin,
    allowDirect: capabilities?.provider_credentials === true,
  };
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const loggerRef = useRef(createLogger("ElevenLabsTTSRuntime"));
  const activeRuntimeRef = useRef<ActiveRuntime | null>(null);
  const volumeRef = useRef(mapNormalizedVolumeToPocketGain(1));

  const clearSessionFallbackTimer = useCallback((runtime: ActiveRuntime) => {
    if (runtime.sessionFallbackTimer === null) return;
    window.clearTimeout(runtime.sessionFallbackTimer);
    runtime.sessionFallbackTimer = null;
  }, []);

  const clearKeepAlive = useCallback((runtime: ActiveRuntime) => {
    if (runtime.keepAliveTimer === null) return;
    window.clearTimeout(runtime.keepAliveTimer);
    runtime.keepAliveTimer = null;
  }, []);

  /**
   * Restart the dialogue socket's idle countdown after each message, until the
   * reply's text has ended. Hosted server sockets accept only text frames.
   */
  const scheduleKeepAlive = useCallback(
    (runtime: ActiveRuntime) => {
      clearKeepAlive(runtime);
      if (
        runtime.protocol !== "dialogue" ||
        runtime.closed ||
        runtime.requestedStreamEnd
      )
        return;
      runtime.keepAliveTimer = window.setTimeout(() => {
        runtime.keepAliveTimer = null;
        if (!runtime.socket || runtime.closed || runtime.requestedStreamEnd)
          return;
        runtime.socket.send(JSON.stringify({ keep_alive: true }));
        scheduleKeepAlive(runtime);
      }, ELEVENLABS_DIALOGUE_KEEP_ALIVE_MS);
    },
    [clearKeepAlive],
  );

  const emitDurationResolved = useCallback((runtime: ActiveRuntime) => {
    if (runtime.durationResolved) return;
    if (runtime.totalSamples <= 0) return;
    runtime.durationResolved = true;
    optionsRef.current.onAudioDurationResolved?.({
      runId: runtime.runId,
      provider: "elevenlabs",
      audioDurationSec: runtime.totalSamples / ELEVENLABS_SAMPLE_RATE,
    });
  }, []);

  const emitPlaybackEnded = useCallback(
    (runtime: ActiveRuntime, reason: AudioEndedReason) => {
      if (runtime.ended) return;
      runtime.ended = true;
      optionsRef.current.onPlaybackEndedSignal?.({
        runId: runtime.runId,
        provider: "elevenlabs",
      });
      optionsRef.current.onAudioEnded?.({
        runId: runtime.runId,
        provider: "elevenlabs",
        reason,
      });
    },
    [],
  );

  const closeRuntime = useCallback(
    async (runtime: ActiveRuntime | null) => {
      if (!runtime || runtime.closed) return;
      runtime.closed = true;
      runtime.ready = false;
      runtime.queuedFrames = [];
      clearSessionFallbackTimer(runtime);
      clearKeepAlive(runtime);
      if (runtime.rejectSession) {
        runtime.rejectSession(createRunCancelledError());
        runtime.resolveSession = null;
        runtime.rejectSession = null;
      }
      if (runtime.socket) {
        try {
          runtime.socket.close();
        } catch {
          // noop
        }
        runtime.socket = null;
      }
      if (runtime.player) {
        try {
          runtime.player.reset();
        } catch {
          // noop
        }
        runtime.player = null;
      }
      if (runtime.audioContext) {
        try {
          await runtime.audioContext.close();
        } catch {
          // noop
        }
        runtime.audioContext = null;
      }
    },
    [clearKeepAlive, clearSessionFallbackTimer],
  );

  const flushQueuedFrames = useCallback(
    (runtime: ActiveRuntime) => {
      const { socket, protocol, voiceId } = runtime;
      if (!runtime.ready || runtime.closed || !socket || !protocol) return;
      while (runtime.queuedFrames.length > 0) {
        const next = runtime.queuedFrames.shift();
        if (!next) continue;
        if (next.type === "text") {
          const frames = textFrames(
            protocol,
            voiceId,
            next.text,
            !runtime.flushedFirstChunk,
          );
          runtime.flushedFirstChunk = true;
          for (const frame of frames) socket.send(JSON.stringify(frame));
          runtime.sentTextChars += next.text.length;
        } else {
          runtime.requestedStreamEnd = true;
          socket.send(JSON.stringify(endFrame(protocol)));
        }
      }
      scheduleKeepAlive(runtime);
    },
    [scheduleKeepAlive],
  );

  const markStreamFinished = useCallback(
    (runtime: ActiveRuntime) => {
      if (runtime.sawStreamFinished) return;
      runtime.sawStreamFinished = true;
      runtime.ready = false;
      runtime.socket = null;
      clearKeepAlive(runtime);
      emitDurationResolved(runtime);
      if (runtime.sawAudio && runtime.player) {
        try {
          runtime.player.notifyStreamEnded();
          return;
        } catch {
          // Fall back to immediate shutdown below.
        }
      }
      if (!runtime.sawAudio || !runtime.player) {
        emitPlaybackEnded(runtime, runtime.stopReason ?? "natural");
        void closeRuntime(runtime);
      }
    },
    [clearKeepAlive, closeRuntime, emitDurationResolved, emitPlaybackEnded],
  );

  const handleRuntimeFailure = useCallback(
    (runtime: ActiveRuntime, reason: string, message: string) => {
      loggerRef.current.warn("Runtime", message, {
        runId: runtime.runId,
        reason,
      });
      runtime.stopReason = "error";
      optionsRef.current.onWarning?.(runtime.runId, reason, message);
      emitPlaybackEnded(runtime, "error");
      void closeRuntime(runtime);
    },
    [closeRuntime, emitPlaybackEnded],
  );

  const handleAudioChunk = useCallback(
    (runtime: ActiveRuntime, pcm: Int16Array, source: "binary" | "base64") => {
      const player = runtime.player;
      if (activeRuntimeRef.current !== runtime || !player) return;
      const hadAudio = runtime.sawAudio;
      runtime.sawAudio = runtime.sawAudio || pcm.length > 0;
      runtime.totalSamples += pcm.length;
      runtime.timing.acceptAudio(pcm.length);
      if (!hadAudio && pcm.length > 0) {
        loggerRef.current.info(
          "Audio",
          "Received first ElevenLabs audio chunk",
          {
            runId: runtime.runId,
            source,
            samples: pcm.length,
          },
        );
      }
      // The debug panel's Lip-sync view copies the run's audio while it is enabled.
      speechPcmTap()?.({
        runId: runtime.runId,
        provider: "elevenlabs",
        sampleRate: ELEVENLABS_SAMPLE_RATE,
        pcm,
      });
      player.playAudio(pcm);
    },
    [],
  );

  /**
   * Collect a frame's character timing. The dialogue socket times each frame
   * from 0 within a prosody turn; a server socket sends run-relative times.
   */
  const acceptTiming = useCallback(
    (runtime: ActiveRuntime, payload: Record<string, unknown>) => {
      if (activeRuntimeRef.current !== runtime) return;
      let chars: TimedChar[] = [];
      if (runtime.protocol === "dialogue") {
        if (payload.alignment)
          chars = runtime.timing.acceptDialogueAlignment(payload.alignment);
        // A flush ends a prosody turn; the next turn's frames restart at 0.
        if (payload.is_final_audio_for_turn === true) runtime.timing.endTurn();
      } else if (payload.alignment) {
        chars = runtime.timing.acceptRunAlignment(payload.alignment);
      }
      if (chars.length === 0) return;
      optionsRef.current.onSpeechTiming?.({
        runId: runtime.runId,
        provider: "elevenlabs",
        chars,
      });
    },
    [],
  );

  const resolveSessionForRun = useCallback(
    (runtime: ActiveRuntime): Promise<ElevenLabsSessionResponse> => {
      if (runtime.providedSession) {
        runtime.sessionStatus = "provided";
        return Promise.resolve(runtime.providedSession);
      }
      if (runtime.sessionError) {
        runtime.sessionStatus = "failed";
        return Promise.reject(runtime.sessionError);
      }
      if (runtime.sessionPromise) {
        return runtime.sessionPromise;
      }

      runtime.sessionStatus = "pending";
      runtime.sessionPromise = new Promise<ElevenLabsSessionResponse>(
        (resolve, reject) => {
          runtime.resolveSession = (session) => {
            clearSessionFallbackTimer(runtime);
            runtime.providedSession = session;
            runtime.sessionStatus = "provided";
            runtime.resolveSession = null;
            runtime.rejectSession = null;
            resolve(session);
          };
          runtime.rejectSession = (error) => {
            clearSessionFallbackTimer(runtime);
            runtime.sessionError = error;
            runtime.sessionStatus = "failed";
            runtime.resolveSession = null;
            runtime.rejectSession = null;
            reject(error);
          };
        },
      );

      runtime.sessionFallbackTimer = window.setTimeout(() => {
        if (activeRuntimeRef.current !== runtime) return;
        if (runtime.closed || runtime.sessionStatus !== "pending") return;
        runtime.sessionStatus = "timeout";
        loggerRef.current.warn(
          "Bootstrap",
          "Timed out waiting for ElevenLabs chat SSE session",
          {
            runId: runtime.runId,
            waitMs: ELEVENLABS_SESSION_WAIT_TIMEOUT_MS,
          },
        );
        runtime.rejectSession?.(
          new Error("Timed out waiting for ElevenLabs realtime TTS session."),
        );
      }, ELEVENLABS_SESSION_WAIT_TIMEOUT_MS);

      return runtime.sessionPromise;
    },
    [clearSessionFallbackTimer],
  );

  const startRun = useCallback(
    async (runtime: ActiveRuntime) => {
      const { runId, context } = runtime;
      if (!context.animaId) {
        throw new Error("ElevenLabs realtime TTS requires a anima id.");
      }

      activeRuntimeRef.current = runtime;

      const session = await resolveSessionForRun(runtime);
      // The dialogue socket names its voice in every frame; a session without
      // one would only fail later, at the provider.
      if (
        realtimeSpeechProtocol(session) === "dialogue" &&
        !session.voice_id.trim()
      )
        throw new Error("The ElevenLabs realtime TTS session has no voice.");
      const wsUrl = buildDirectElevenLabsRealtimeWsUrl(
        session,
        socketPolicy.current,
      );
      if (activeRuntimeRef.current !== runtime || runtime.closed)
        throw createRunCancelledError();
      const { audioContext, player } = await createAudioResources();
      if (activeRuntimeRef.current !== runtime || runtime.closed) {
        player.reset();
        await audioContext.close();
        throw createRunCancelledError();
      }
      runtime.audioContext = audioContext;
      runtime.player = player;

      loggerRef.current.info(
        "Bootstrap",
        "Initialized ElevenLabs realtime session",
        {
          runId,
          animaId: context.animaId,
          voiceId: session.voice_id,
          modelId: session.model_id,
          outputFormat: session.output_format,
          websocketBaseUrl: redactUrlForLogging(
            session.websocket_base_url ?? null,
          ),
          sessionStatus: runtime.sessionStatus,
        },
      );

      if (activeRuntimeRef.current !== runtime) {
        await closeRuntime(runtime);
        throw createRunCancelledError();
      }

      runtime.player.volume = volumeRef.current;

      player.addEventListener(
        "firstPlayback",
        (event: PCMPlaybackStartEvent) => {
          if (activeRuntimeRef.current !== runtime || runtime.sawPlaybackStart)
            return;
          runtime.sawPlaybackStart = true;
          const detail = (event?.detail ?? {}) as { startTime?: unknown };
          optionsRef.current.onAudioStarted?.({
            runId,
            provider: "elevenlabs",
            audioStartSec:
              typeof detail.startTime === "number" ? detail.startTime : null,
            audioContext,
          });
        },
      );

      player.addEventListener("audioEnded", () => {
        if (activeRuntimeRef.current !== runtime) return;
        emitPlaybackEnded(runtime, runtime.stopReason ?? "natural");
        void closeRuntime(runtime);
      });

      loggerRef.current.info(
        "Socket",
        "Opening ElevenLabs realtime websocket",
        {
          runId,
          transport: session.transport ?? "direct",
          wsUrl: redactUrlForLogging(wsUrl),
        },
      );
      const socket = new WebSocket(wsUrl);
      const protocol = realtimeSpeechProtocol(session);
      runtime.socket = socket;
      runtime.protocol = protocol;
      runtime.voiceId = session.voice_id;
      runtime.ready = false;

      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        if (activeRuntimeRef.current !== runtime) return;
        loggerRef.current.info(
          "Socket",
          "ElevenLabs realtime websocket opened",
          {
            runId,
            transport: session.transport ?? "direct",
          },
        );
        socket.send(JSON.stringify(openingFrame(protocol, session.voice_id)));
        runtime.ready = true;
        flushQueuedFrames(runtime);
      };

      socket.onerror = () => {
        if (activeRuntimeRef.current !== runtime) return;
        loggerRef.current.warn(
          "Socket",
          "ElevenLabs realtime websocket error",
          {
            runId,
            transport: session.transport ?? "direct",
          },
        );
        handleRuntimeFailure(
          runtime,
          "elevenlabs_ws_error",
          "ElevenLabs realtime TTS connection failed for this response.",
        );
      };

      socket.onclose = (event) => {
        if (activeRuntimeRef.current !== runtime) return;
        loggerRef.current.info(
          "Socket",
          "ElevenLabs realtime websocket closed",
          {
            runId,
            transport: session.transport ?? "direct",
            sawStreamFinished: runtime.sawStreamFinished,
            closed: runtime.closed,
            requestedStreamEnd: runtime.requestedStreamEnd,
            sawAudio: runtime.sawAudio,
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          },
        );
        if (!runtime.sawStreamFinished && !runtime.closed) {
          if (
            runtime.requestedStreamEnd &&
            (runtime.sawAudio || runtime.sentTextChars === 0)
          ) {
            markStreamFinished(runtime);
            return;
          }
          handleRuntimeFailure(
            runtime,
            "elevenlabs_ws_closed",
            "ElevenLabs realtime TTS closed before playback completed.",
          );
        }
      };

      socket.onmessage = (event) => {
        if (activeRuntimeRef.current !== runtime) return;
        const data = event.data;
        if (data instanceof Blob || data instanceof ArrayBuffer) {
          void decodeBinaryPcm(data)
            .then((pcm) => {
              handleAudioChunk(runtime, pcm, "binary");
            })
            .catch(() => {
              handleRuntimeFailure(
                runtime,
                "elevenlabs_audio_decode_failed",
                "Failed to decode ElevenLabs realtime audio.",
              );
            });
          return;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (typeof payload.audio === "string" && payload.audio) {
          try {
            const pcm = decodeBase64Pcm(payload.audio);
            handleAudioChunk(runtime, pcm, "base64");
          } catch {
            handleRuntimeFailure(
              runtime,
              "elevenlabs_audio_decode_failed",
              "Failed to decode ElevenLabs realtime audio.",
            );
            return;
          }
        }

        acceptTiming(runtime, payload);

        if (payload.type === "ready") {
          runtime.ready = true;
          flushQueuedFrames(runtime);
          return;
        }

        // The dialogue socket reports failures as `{message, error, code}`
        // before closing; older streams used `{type: "error"}`.
        if (payload.type === "error" || typeof payload.error === "string") {
          const message =
            typeof payload.message === "string" && payload.message.trim()
              ? payload.message.trim()
              : "ElevenLabs realtime TTS failed for this response.";
          handleRuntimeFailure(runtime, "elevenlabs_realtime_error", message);
          return;
        }

        // `is_final` ends the dialogue stream (a turn's end is only
        // `is_final_audio_for_turn`); hosted sockets may still send `isFinal`.
        if (
          payload.is_final === true ||
          payload.isFinal === true ||
          payload.final === true
        ) {
          markStreamFinished(runtime);
        }
      };
    },
    [
      acceptTiming,
      closeRuntime,
      emitPlaybackEnded,
      flushQueuedFrames,
      handleAudioChunk,
      handleRuntimeFailure,
      markStreamFinished,
      resolveSessionForRun,
    ],
  );

  const ensureStarted = useCallback(
    (runId: string, context: RealtimeSpeechContext) => {
      const current = activeRuntimeRef.current;
      if (current && current.runId === runId) {
        return current.startPromise ?? Promise.resolve();
      }

      if (current) {
        void closeRuntime(current);
      }

      const runtime = createInitialRuntime(runId, context);
      activeRuntimeRef.current = runtime;
      const startPromise = startRun(runtime).catch((error) => {
        if (
          error instanceof Error &&
          error.name === "AbortError" &&
          (activeRuntimeRef.current !== runtime || runtime.closed)
        ) {
          loggerRef.current.info(
            "Run",
            "ElevenLabs realtime run cancelled before start completed",
            {
              runId,
            },
          );
          return;
        }
        const active = activeRuntimeRef.current;
        if (active && active.runId === runId) {
          handleRuntimeFailure(
            active,
            "elevenlabs_start_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      runtime.startPromise = startPromise;
      activeRuntimeRef.current = runtime;
      return startPromise;
    },
    [closeRuntime, handleRuntimeFailure, startRun],
  );

  const acceptSession = useCallback(
    (runId: string, session: ElevenLabsSessionResponse) => {
      const runtime = activeRuntimeRef.current;
      if (!runtime || runtime.runId !== runId || runtime.closed) {
        loggerRef.current.info(
          "Bootstrap",
          "Ignored ElevenLabs SSE session for inactive run",
          { runId },
        );
        return;
      }
      if (runtime.sessionStatus === "timeout" || runtime.socket) {
        loggerRef.current.info(
          "Bootstrap",
          "Ignored late ElevenLabs SSE session",
          {
            runId,
            sessionStatus: runtime.sessionStatus,
            hasSocket: Boolean(runtime.socket),
          },
        );
        return;
      }
      if (runtime.resolveSession) {
        runtime.resolveSession(session);
        return;
      }
      clearSessionFallbackTimer(runtime);
      runtime.providedSession = session;
      runtime.sessionError = null;
      runtime.sessionStatus = "provided";
    },
    [clearSessionFallbackTimer],
  );

  const markSessionFailed = useCallback(
    (runId: string, error: ElevenLabsSessionError | string) => {
      const runtime = activeRuntimeRef.current;
      if (!runtime || runtime.runId !== runId || runtime.closed) {
        return;
      }
      const sessionError = createSessionError(error);
      if (runtime.rejectSession) {
        runtime.rejectSession(sessionError);
        return;
      }
      clearSessionFallbackTimer(runtime);
      runtime.sessionError = sessionError;
      runtime.sessionStatus = "failed";
      if (runtime.socket || runtime.ready) {
        handleRuntimeFailure(
          runtime,
          "elevenlabs_session_failed",
          sessionError.message,
        );
      }
    },
    [clearSessionFallbackTimer, handleRuntimeFailure],
  );

  const enqueueText = useCallback(
    (runId: string, text: string, context: RealtimeSpeechContext) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void ensureStarted(runId, context);
      const runtime = activeRuntimeRef.current;
      if (!runtime || runtime.runId !== runId) return;
      runtime.queuedFrames.push({ type: "text", text: trimmed });
      flushQueuedFrames(runtime);
    },
    [ensureStarted, flushQueuedFrames],
  );

  const flush = useCallback(
    (runId: string, context: RealtimeSpeechContext) => {
      void ensureStarted(runId, context);
      const runtime = activeRuntimeRef.current;
      if (!runtime || runtime.runId !== runId) return;
      runtime.queuedFrames.push({ type: "end" });
      flushQueuedFrames(runtime);
    },
    [ensureStarted, flushQueuedFrames],
  );

  const completeRun = useCallback(
    (runId: string, context: RealtimeSpeechContext) => {
      flush(runId, context);
    },
    [flush],
  );

  const stop = useCallback(() => {
    const runtime = activeRuntimeRef.current;
    activeRuntimeRef.current = null;
    if (!runtime) return;
    runtime.stopReason = runtime.stopReason ?? "natural";
    void closeRuntime(runtime);
  }, [closeRuntime]);

  const setVolume = useCallback((volume: number) => {
    volumeRef.current = mapNormalizedVolumeToPocketGain(volume);
    const runtime = activeRuntimeRef.current;
    if (runtime?.player) {
      runtime.player.volume = volumeRef.current;
    }
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    startRun: ensureStarted,
    acceptSession,
    markSessionFailed,
    appendText: enqueueText,
    flush,
    completeRun,
    stop,
    setVolume,
  };
}
