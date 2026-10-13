/**
 * A debug-only tap on the PCM a speech runtime plays. It stays empty unless a
 * debug view installs a listener, so ordinary speech pays one null check per
 * audio frame and nothing is captured.
 */

export type SpeechPcmTapEvent = {
  runId: string;
  provider: "elevenlabs";
  sampleRate: number;
  /** The frame's samples; a listener copies what it keeps. */
  pcm: Int16Array;
};

type SpeechPcmTap = (event: SpeechPcmTapEvent) => void;

let tap: SpeechPcmTap | null = null;

/** Install (or with `null`, remove) the debug listener. */
export function setSpeechPcmTap(listener: SpeechPcmTap | null): void {
  tap = listener;
}

/** The installed listener, if a debug view is capturing. */
export function speechPcmTap(): SpeechPcmTap | null {
  return tap;
}
