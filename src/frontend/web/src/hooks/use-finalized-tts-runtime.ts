"use client";

import { useCallback, useEffect, useRef } from "react";

import { createLogger } from "@/lib/logger";

const FINALIZED_SAMPLE_RATE = 24000;
const FIRST_BUFFER_START_LEAD_SEC = 0.08;
const NEXT_BUFFER_START_LEAD_SEC = 0.02;

type AudioEndedReason = "natural" | "error";

// Plays the PCM a finalized provider (Gemini) pushes over the chat stream; the
// caller attaches the run's provider to these events.
type UseFinalizedTtsRuntimeOptions = {
  onAudioStarted?: (event: {
    runId: string;
    audioStartSec?: number | null;
    audioContext?: AudioContext | null;
  }) => void;
  onAudioDurationResolved?: (event: {
    runId: string;
    audioDurationSec: number;
  }) => void;
  onPlaybackEndedSignal?: (event: { runId: string }) => void;
  onAudioEnded?: (event: { runId: string; reason: AudioEndedReason }) => void;
  onWarning?: (runId: string, reason: string, message: string) => void;
};

type ActiveFinalizedRuntime = {
  runId: string;
  audioContext: AudioContext | null;
  gainNode: GainNode | null;
  sources: Set<AudioBufferSourceNode>;
  totalSamples: number;
  durationResolved: boolean;
  closed: boolean;
  ended: boolean;
  sawAudio: boolean;
  sawPlaybackStart: boolean;
  stopReason: AudioEndedReason | null;
  startPromise: Promise<void> | null;
  pendingPcm: Int16Array[];
  pendingFinish: boolean;
  nextStartTime: number;
};

export type FinalizedTtsAudioPayload = {
  run_id?: string | null;
  model_id?: string | null;
  output_format?: string | null;
  audio_base64?: string | null;
};

export type FinalizedTtsErrorPayload = {
  run_id?: string | null;
  error?: string | null;
  code?: string | null;
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

export function decodeBase64Pcm16(audioBase64: string): Int16Array {
  const binary = atob(audioBase64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(buffer);
}

export function convertPcm16ToFloat32(
  pcm: Int16Array,
): Float32Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(pcm.length * Float32Array.BYTES_PER_ELEMENT);
  const samples = new Float32Array(buffer);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index] / 32768;
    samples[index] = Math.max(-1, Math.min(1, sample));
  }
  return samples;
}

function clampAudioBufferGain(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

async function createAudioResources(): Promise<{
  audioContext: AudioContext;
  gainNode: GainNode;
}> {
  const speechWindow = asSpeechAudioWindow();
  const AudioContextCtor =
    speechWindow?.AudioContext ?? speechWindow?.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const audioContext = new AudioContextCtor({
    latencyHint: "interactive",
  });
  const gainNode = audioContext.createGain();
  gainNode.connect(audioContext.destination);
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  return { audioContext, gainNode };
}

function createRuntime(runId: string): ActiveFinalizedRuntime {
  return {
    runId,
    audioContext: null,
    gainNode: null,
    sources: new Set(),
    totalSamples: 0,
    durationResolved: false,
    closed: false,
    ended: false,
    sawAudio: false,
    sawPlaybackStart: false,
    stopReason: null,
    startPromise: null,
    pendingPcm: [],
    pendingFinish: false,
    nextStartTime: 0,
  };
}

export function useFinalizedTtsRuntime(options: UseFinalizedTtsRuntimeOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const loggerRef = useRef(createLogger("FinalizedTTSRuntime"));
  const activeRuntimeRef = useRef<ActiveFinalizedRuntime | null>(null);
  const volumeRef = useRef(clampAudioBufferGain(1));

  const emitDurationResolved = useCallback(
    (runtime: ActiveFinalizedRuntime) => {
      if (runtime.durationResolved) return;
      if (runtime.totalSamples <= 0) return;
      runtime.durationResolved = true;
      optionsRef.current.onAudioDurationResolved?.({
        runId: runtime.runId,
        audioDurationSec: runtime.totalSamples / FINALIZED_SAMPLE_RATE,
      });
    },
    [],
  );

  const closeRuntime = useCallback(async (runtime: ActiveFinalizedRuntime) => {
    if (runtime.closed) return;
    runtime.closed = true;
    runtime.pendingPcm = [];

    for (const source of runtime.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // noop
      }
      try {
        source.disconnect();
      } catch {
        // noop
      }
    }
    runtime.sources.clear();

    if (runtime.gainNode) {
      try {
        runtime.gainNode.disconnect();
      } catch {
        // noop
      }
      runtime.gainNode = null;
    }

    if (runtime.audioContext) {
      try {
        await runtime.audioContext.close();
      } catch {
        // noop
      }
      runtime.audioContext = null;
    }
  }, []);

  const emitPlaybackEnded = useCallback(
    (runtime: ActiveFinalizedRuntime, reason: AudioEndedReason) => {
      if (runtime.ended) return;
      runtime.ended = true;
      optionsRef.current.onPlaybackEndedSignal?.({
        runId: runtime.runId,
      });
      optionsRef.current.onAudioEnded?.({
        runId: runtime.runId,
        reason,
      });
    },
    [],
  );

  const completePlaybackIfDrained = useCallback(
    (runtime: ActiveFinalizedRuntime) => {
      if (runtime.closed) return;
      if (!runtime.pendingFinish) return;
      if (runtime.pendingPcm.length > 0) return;
      if (runtime.sources.size > 0) return;
      emitPlaybackEnded(runtime, runtime.stopReason ?? "natural");
      void closeRuntime(runtime);
    },
    [closeRuntime, emitPlaybackEnded],
  );

  const handleRuntimeFailure = useCallback(
    (runtime: ActiveFinalizedRuntime, reason: string, message: string) => {
      if (runtime.closed) return;
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

  const scheduleAudioChunk = useCallback(
    (runtime: ActiveFinalizedRuntime, pcm: Int16Array): boolean => {
      const audioContext = runtime.audioContext;
      const gainNode = runtime.gainNode;
      if (
        activeRuntimeRef.current !== runtime ||
        !audioContext ||
        !gainNode ||
        runtime.closed
      ) {
        return false;
      }
      if (pcm.length <= 0) return true;

      const hadAudio = runtime.sawAudio;
      runtime.sawAudio = true;
      runtime.totalSamples += pcm.length;
      if (!hadAudio) {
        loggerRef.current.info(
          "Audio",
          "Received first finalized audio chunk",
          {
            runId: runtime.runId,
            samples: pcm.length,
          },
        );
      }

      try {
        const samples = convertPcm16ToFloat32(pcm);
        const audioBuffer = audioContext.createBuffer(
          1,
          samples.length,
          FINALIZED_SAMPLE_RATE,
        );
        audioBuffer.copyToChannel(samples, 0);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode);

        const isFirstPlayback = !runtime.sawPlaybackStart;
        const startLeadSec = isFirstPlayback
          ? FIRST_BUFFER_START_LEAD_SEC
          : NEXT_BUFFER_START_LEAD_SEC;
        const startTime = Math.max(
          runtime.nextStartTime,
          audioContext.currentTime + startLeadSec,
        );
        runtime.nextStartTime = startTime + audioBuffer.duration;

        runtime.sources.add(source);
        source.onended = () => {
          runtime.sources.delete(source);
          try {
            source.disconnect();
          } catch {
            // noop
          }
          completePlaybackIfDrained(runtime);
        };
        source.start(startTime);

        if (isFirstPlayback) {
          runtime.sawPlaybackStart = true;
          optionsRef.current.onAudioStarted?.({
            runId: runtime.runId,
            audioStartSec: startTime,
            audioContext,
          });
        }
      } catch (error) {
        handleRuntimeFailure(
          runtime,
          "finalized_audio_schedule_failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      return true;
    },
    [completePlaybackIfDrained, handleRuntimeFailure],
  );

  const flushPendingAudio = useCallback(
    (runtime: ActiveFinalizedRuntime) => {
      while (runtime.pendingPcm.length > 0 && !runtime.closed) {
        const pcm = runtime.pendingPcm[0];
        if (!pcm) {
          runtime.pendingPcm.shift();
          continue;
        }
        if (!scheduleAudioChunk(runtime, pcm)) {
          return;
        }
        runtime.pendingPcm.shift();
      }
    },
    [scheduleAudioChunk],
  );

  const finishStream = useCallback(
    (runtime: ActiveFinalizedRuntime) => {
      if (runtime.closed) return;
      runtime.pendingFinish = true;
      flushPendingAudio(runtime);
      emitDurationResolved(runtime);
      completePlaybackIfDrained(runtime);
    },
    [completePlaybackIfDrained, emitDurationResolved, flushPendingAudio],
  );

  const ensureRuntime = useCallback(
    (runId: string): ActiveFinalizedRuntime | null => {
      if (!runId) return null;
      const current = activeRuntimeRef.current;
      if (current?.runId === runId && !current.closed) {
        return current;
      }
      if (current) {
        void closeRuntime(current);
      }
      const runtime = createRuntime(runId);
      activeRuntimeRef.current = runtime;
      return runtime;
    },
    [closeRuntime],
  );

  const startAudioResources = useCallback(
    (runtime: ActiveFinalizedRuntime): Promise<void> => {
      if (runtime.startPromise) return runtime.startPromise;
      runtime.startPromise = (async () => {
        const { audioContext, gainNode } = await createAudioResources();
        if (activeRuntimeRef.current !== runtime || runtime.closed) {
          try {
            gainNode.disconnect();
          } catch {
            // noop
          }
          try {
            await audioContext.close();
          } catch {
            // noop
          }
          return;
        }

        runtime.audioContext = audioContext;
        runtime.gainNode = gainNode;
        runtime.gainNode.gain.value = volumeRef.current;
        runtime.nextStartTime = Math.max(
          runtime.nextStartTime,
          audioContext.currentTime,
        );

        loggerRef.current.info("Audio", "Prepared finalized audio resources", {
          runId: runtime.runId,
          sampleRate: audioContext.sampleRate,
        });

        flushPendingAudio(runtime);
        if (runtime.pendingFinish) {
          finishStream(runtime);
        }
      })().catch((error: unknown) => {
        if (activeRuntimeRef.current !== runtime || runtime.closed) return;
        handleRuntimeFailure(
          runtime,
          "finalized_audio_start_failed",
          error instanceof Error ? error.message : String(error),
        );
      });
      return runtime.startPromise;
    },
    [finishStream, flushPendingAudio, handleRuntimeFailure],
  );

  const prepareRun = useCallback(
    (runId: string) => {
      const runtime = ensureRuntime(runId);
      if (!runtime || runtime.closed) return;
      void startAudioResources(runtime);
    },
    [ensureRuntime, startAudioResources],
  );

  const acceptAudioChunk = useCallback(
    (runId: string, payload: FinalizedTtsAudioPayload) => {
      const audioBase64 =
        typeof payload.audio_base64 === "string" ? payload.audio_base64 : "";
      if (!runId || !audioBase64) return;
      const runtime = ensureRuntime(runId);
      if (!runtime || runtime.closed) return;

      try {
        runtime.pendingPcm.push(decodeBase64Pcm16(audioBase64));
      } catch {
        handleRuntimeFailure(
          runtime,
          "finalized_audio_decode_failed",
          "Failed to decode the reply's audio.",
        );
        return;
      }

      if (runtime.audioContext && runtime.gainNode) {
        flushPendingAudio(runtime);
        return;
      }
      void startAudioResources(runtime);
    },
    [
      ensureRuntime,
      flushPendingAudio,
      handleRuntimeFailure,
      startAudioResources,
    ],
  );

  const finishPushedStream = useCallback(
    (runId: string) => {
      const runtime = ensureRuntime(runId);
      if (!runtime || runtime.closed) return;
      runtime.pendingFinish = true;
      if (
        runtime.pendingPcm.length > 0 &&
        (!runtime.audioContext || !runtime.gainNode)
      ) {
        void startAudioResources(runtime);
        return;
      }
      finishStream(runtime);
    },
    [ensureRuntime, finishStream, startAudioResources],
  );

  const failPushedStream = useCallback(
    (runId: string, payload: FinalizedTtsErrorPayload | string) => {
      const runtime = ensureRuntime(runId);
      if (!runtime || runtime.closed) return;
      const message =
        typeof payload === "string"
          ? payload
          : typeof payload.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "Text-to-speech failed for this response.";
      handleRuntimeFailure(runtime, "finalized_error", message);
    },
    [ensureRuntime, handleRuntimeFailure],
  );

  const stop = useCallback(() => {
    const runtime = activeRuntimeRef.current;
    activeRuntimeRef.current = null;
    if (!runtime) return;
    runtime.stopReason = runtime.stopReason ?? "natural";
    void closeRuntime(runtime);
  }, [closeRuntime]);

  const setVolume = useCallback((volume: number) => {
    volumeRef.current = clampAudioBufferGain(volume);
    const runtime = activeRuntimeRef.current;
    if (runtime?.gainNode) {
      runtime.gainNode.gain.value = volumeRef.current;
    }
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    prepareRun,
    acceptAudioChunk,
    finishPushedStream,
    failPushedStream,
    stop,
    setVolume,
  };
}
