// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import socketJa from "@/lib/speech/fixtures/v4-turbo-socket-ja.json";
import type { TimedChar } from "@/lib/speech/provider-speech-timing";
import { setSpeechPcmTap } from "@/lib/speech/speech-debug-tap";
import {
  useElevenLabsTtsRuntime,
  type ElevenLabsSessionResponse,
} from "./use-elevenlabs-tts-runtime";

const fixture = vi.hoisted(() => ({
  providerCredentials: true,
  players: [] as Array<{
    played: Int16Array[];
    streamEnded: number;
    resets: number;
  }>,
}));

vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({
    data: { provider_credentials: fixture.providerCredentials },
  }),
}));

vi.mock("@/lib/speech/audio/PCMPlayerWorklet.js", () => ({
  PCMPlayerWorklet: class {
    initPromise = Promise.resolve();
    volume = 1;
    private readonly record = {
      played: [] as Int16Array[],
      streamEnded: 0,
      resets: 0,
    };

    constructor() {
      fixture.players.push(this.record);
    }

    addEventListener() {}

    playAudio(pcm: Int16Array) {
      this.record.played.push(pcm);
    }

    notifyStreamEnded() {
      this.record.streamEnded += 1;
    }

    reset() {
      this.record.resets += 1;
    }
  },
}));

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  async resume() {}
  async close() {}
}

/** Records what the runtime sends; tests drive the socket's open, messages and close. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  binaryType = "blob";
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.closeCalls += 1;
  }

  open() {
    this.onopen?.();
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

type Runtime = ReturnType<typeof useElevenLabsTtsRuntime>;

const RUN_ID = "run-1";
const CONTEXT = { animaId: "anima-1" };
const VOICE_ID = "voice-fixture";
const directSession: ElevenLabsSessionResponse = {
  voice_id: VOICE_ID,
  model_id: "eleven_v4_turbo",
  output_format: "pcm_24000",
  sync_alignment: true,
  token: "provider-token",
  websocket_base_url: "wss://api.elevenlabs.io",
  transport: "direct",
};
const serverSession: ElevenLabsSessionResponse = {
  voice_id: VOICE_ID,
  model_id: "eleven_v4_turbo",
  output_format: "pcm_24000",
  sync_alignment: false,
  transport: "server",
  websocket_url: "/v1/speech/sessions/fixture",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** The hook's latest API, captured by the harness on each render. */
const latest: { current: Runtime | null } = { current: null };
const events = {
  warnings: [] as Array<{ runId: string; reason: string; message: string }>,
  ended: [] as Array<{ runId: string; reason: string }>,
  durations: [] as number[],
  timing: [] as Array<{ runId: string; provider: string; chars: TimedChar[] }>,
};

/** Base64 PCM of `samples` silent 16-bit samples. */
function silentPcmBase64(samples: number): string {
  const bytes = samples * 2;
  return "AAAA".repeat(Math.floor(bytes / 3)) + ["", "AA==", "AAA="][bytes % 3];
}

function timedText(): string {
  return events.timing
    .flatMap((event) => event.chars.map((entry) => entry.char))
    .join("");
}

function Harness() {
  latest.current = useElevenLabsTtsRuntime({
    onWarning: (runId, reason, message) =>
      events.warnings.push({ runId, reason, message }),
    onAudioEnded: ({ runId, reason }) => events.ended.push({ runId, reason }),
    onAudioDurationResolved: ({ audioDurationSec }) =>
      events.durations.push(audioDurationSec),
    onSpeechTiming: (event) => events.timing.push(event),
  });
  return null;
}

function runtime(): Runtime {
  if (!latest.current) throw new Error("The harness has not rendered.");
  return latest.current;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

/** Start a run, deliver its session and open the socket the runtime creates. */
async function openRun(session: ElevenLabsSessionResponse) {
  await act(async () => {
    void runtime().startRun(RUN_ID, CONTEXT);
    runtime().acceptSession(RUN_ID, session);
  });
  await settle();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("The runtime did not open a socket.");
  act(() => socket.open());
  return socket;
}

beforeEach(async () => {
  vi.useFakeTimers();
  fixture.providerCredentials = true;
  fixture.players.length = 0;
  FakeWebSocket.instances = [];
  events.warnings.length = 0;
  events.ended.length = 0;
  events.durations.length = 0;
  events.timing.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ElevenLabs v4 Turbo dialogue socket", () => {
  it("connects to the Text to Dialogue socket and registers the voice first", async () => {
    const socket = await openRun(directSession);

    const url = new URL(socket.url);
    expect(url.origin).toBe("wss://api.elevenlabs.io");
    expect(url.pathname).toBe("/v1/text-to-dialogue/stream-input");
    expect(url.searchParams.get("model_id")).toBe("eleven_v4_turbo");
    expect(url.searchParams.get("sync_alignment")).toBe("true");
    expect(url.searchParams.get("single_use_token")).toBe("provider-token");
    expect(socket.sent[0]).toEqual({ voices: [VOICE_ID] });
  });

  it("sends chunks with their separating space and flushes only after the first", async () => {
    act(() => runtime().appendText(RUN_ID, "Hello there.", CONTEXT));
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "The kettle is on.", CONTEXT));

    expect(socket.sent).toEqual([
      { voices: [VOICE_ID] },
      { inputs: [{ text: "Hello there. ", voice_id: VOICE_ID }] },
      { flush: true },
      { inputs: [{ text: "The kettle is on. ", voice_id: VOICE_ID }] },
    ]);
  });

  it("keeps the socket alive through long pauses and closes it when the reply ends", async () => {
    const socket = await openRun(directSession);
    act(() =>
      runtime().appendText(RUN_ID, "Let me think about that.", CONTEXT),
    );

    act(() => vi.advanceTimersByTime(25_000));
    expect(
      socket.sent.filter((frame) => frame.keep_alive === true),
    ).toHaveLength(2);

    act(() => runtime().completeRun(RUN_ID, CONTEXT));
    expect(socket.sent.at(-1)).toEqual({ close_socket: true });

    act(() => vi.advanceTimersByTime(30_000));
    expect(socket.sent.at(-1)).toEqual({ close_socket: true });
  });

  it("plays the audio and ends the run on the provider's final message", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "Hi!", CONTEXT));
    act(() => runtime().completeRun(RUN_ID, CONTEXT));

    // Two samples of PCM, with the timing the session asked for.
    act(() =>
      socket.receive({
        audio: "AQACAA==",
        alignment: {
          chars: ["H"],
          char_start_times_ms: [0],
          char_durations_ms: [40],
        },
      }),
    );
    // The first flush ends a prosody turn mid-reply; the stream continues.
    act(() => socket.receive({ is_final_audio_for_turn: true }));
    const player = fixture.players.at(-1);
    expect(player?.streamEnded).toBe(0);

    act(() => socket.receive({ audio: "AwAEAA==" }));
    act(() => socket.receive({ is_final_audio_for_turn: true }));
    act(() => socket.receive({ is_final: true }));

    expect(player?.played.map((pcm) => Array.from(pcm))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(player?.streamEnded).toBe(1);
    expect(events.durations).toEqual([4 / 24000]);
    expect(events.warnings).toEqual([]);
  });

  it("plays the last audio when it arrives with the final message", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "Bye!", CONTEXT));
    act(() => runtime().completeRun(RUN_ID, CONTEXT));

    act(() => socket.receive({ audio: "AQACAA==", is_final: true }));

    const player = fixture.players.at(-1);
    expect(player?.played.map((pcm) => Array.from(pcm))).toEqual([[1, 2]]);
    expect(player?.streamEnded).toBe(1);
  });

  it("ends the reply's speech with a warning when the provider reports an error", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "Hello there.", CONTEXT));

    act(() =>
      socket.receive({
        message: "No message received within 20s.",
        error: "input_timeout_exceeded",
        code: 1008,
      }),
    );

    expect(events.warnings).toEqual([
      {
        runId: RUN_ID,
        reason: "elevenlabs_realtime_error",
        message: "No message received within 20s.",
      },
    ]);
    expect(events.ended).toEqual([{ runId: RUN_ID, reason: "error" }]);
    expect(socket.closeCalls).toBe(1);
  });

  it("refuses a direct session without a voice before opening a socket", async () => {
    await act(async () => {
      void runtime().startRun(RUN_ID, CONTEXT);
      runtime().acceptSession(RUN_ID, { ...directSession, voice_id: " " });
    });
    await settle();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(events.warnings).toEqual([
      {
        runId: RUN_ID,
        reason: "elevenlabs_start_failed",
        message: "The ElevenLabs realtime TTS session has no voice.",
      },
    ]);
  });

  it("times the reply's characters on one clock across prosody turns", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "おはようございます。", CONTEXT));

    for (const message of socketJa.messages) {
      act(() =>
        socket.receive({
          ...("samples" in message && message.samples
            ? { audio: silentPcmBase64(message.samples) }
            : {}),
          ...("alignment" in message ? { alignment: message.alignment } : {}),
          ...("is_final_audio_for_turn" in message
            ? { is_final_audio_for_turn: true }
            : {}),
          ...("is_final" in message ? { is_final: true } : {}),
        }),
      );
    }

    expect(timedText()).toBe(socketJa.text);
    expect(events.timing.every((event) => event.runId === RUN_ID)).toBe(true);
    expect(
      events.timing.every((event) => event.provider === "elevenlabs"),
    ).toBe(true);
    // The second turn starts at the first turn's 1.12 s of audio.
    const second = events.timing
      .flatMap((event) => event.chars)
      .find((entry) => entry.char === "今");
    expect(second?.startSec).toBeCloseTo(1.12, 6);
  });

  it("hands each audio frame to an installed debug tap only", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "Hi!", CONTEXT));
    act(() => socket.receive({ audio: "AQACAA==" }));

    const tapped: Array<{ runId: string; samples: number[] }> = [];
    setSpeechPcmTap((event) =>
      tapped.push({ runId: event.runId, samples: Array.from(event.pcm) }),
    );
    try {
      act(() => socket.receive({ audio: "AwAEAA==" }));
    } finally {
      setSpeechPcmTap(null);
    }
    act(() => socket.receive({ audio: "BQAGAA==" }));

    expect(tapped).toEqual([{ runId: RUN_ID, samples: [3, 4] }]);
    expect(
      fixture.players.at(-1)?.played.map((pcm) => Array.from(pcm)),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("drops timing that arrives after the run is cancelled", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "Hello there.", CONTEXT));

    act(() => runtime().stop());
    act(() =>
      socket.receive({
        audio: "AQACAA==",
        alignment: {
          chars: ["H"],
          char_start_times_ms: [0],
          char_durations_ms: [40],
        },
      }),
    );

    expect(events.timing).toEqual([]);
  });

  it("closes the dialogue socket at once when the reply is cancelled", async () => {
    const socket = await openRun(directSession);
    act(() => runtime().appendText(RUN_ID, "Hello there.", CONTEXT));

    act(() => runtime().stop());

    expect(socket.closeCalls).toBe(1);
    act(() => vi.advanceTimersByTime(30_000));
    expect(socket.sent.some((frame) => frame.keep_alive === true)).toBe(false);
  });
});

describe("hosted server speech socket", () => {
  it("keeps the frames the hosted socket validates and ends on either final marker", async () => {
    fixture.providerCredentials = false;
    await act(async () => root?.render(<Harness />));
    const socket = await openRun(serverSession);
    act(() => runtime().appendText(RUN_ID, "Hello there.", CONTEXT));
    act(() => vi.advanceTimersByTime(25_000));
    act(() => runtime().completeRun(RUN_ID, CONTEXT));

    expect(new URL(socket.url).pathname).toBe("/v1/speech/sessions/fixture");
    expect(socket.sent).toEqual([
      { text: " " },
      { text: "Hello there." },
      { text: "" },
    ]);

    act(() => socket.receive({ audio: "AQACAA==", isFinal: false }));
    act(() => socket.receive({ isFinal: true }));
    expect(fixture.players.at(-1)?.streamEnded).toBe(1);
  });

  it("accepts the dialogue protocol's final marker from the server socket", async () => {
    fixture.providerCredentials = false;
    await act(async () => root?.render(<Harness />));
    const socket = await openRun(serverSession);
    act(() => runtime().appendText(RUN_ID, "Hello there.", CONTEXT));
    act(() => runtime().completeRun(RUN_ID, CONTEXT));

    act(() =>
      socket.receive({
        audio: "AQACAA==",
        alignment: {
          chars: ["H"],
          char_start_times_ms: [0],
          char_durations_ms: [40],
        },
      }),
    );
    act(() => socket.receive({ is_final: true }));

    expect(fixture.players.at(-1)?.streamEnded).toBe(1);
    expect(events.warnings).toEqual([]);
  });

  it("appends the server socket's run-relative timing as it is", async () => {
    fixture.providerCredentials = false;
    await act(async () => root?.render(<Harness />));
    const socket = await openRun(serverSession);
    act(() => runtime().appendText(RUN_ID, "Hi there.", CONTEXT));

    act(() =>
      socket.receive({
        audio: "AQACAA==",
        alignment: {
          characters: ["H", "i"],
          character_start_times_seconds: [0.05, 0.12],
          character_end_times_seconds: [0.12, 0.2],
        },
      }),
    );
    // A dialogue-shaped frame is not the server socket's timing.
    act(() =>
      socket.receive({
        audio: "AQACAA==",
        alignment: {
          chars: [" "],
          char_start_times_ms: [0],
          char_durations_ms: [40],
        },
      }),
    );

    expect(events.timing).toEqual([
      {
        runId: RUN_ID,
        provider: "elevenlabs",
        chars: [
          { char: "H", startSec: 0.05, endSec: 0.12 },
          { char: "i", startSec: 0.12, endSec: 0.2 },
        ],
      },
    ]);
  });
});
