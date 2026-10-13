/**
 * Stable speech error code (contracts/hosted-web.md): the owner's voice
 * allowance cannot cover this reply's provider speech, and no provider audio
 * was produced for it. ElevenLabs speech is realtime, so its decline arrives on
 * a `tts.session.error` frame; a finalized provider's arrives on `tts.error`.
 */
export const SPEECH_ALLOWANCE_EXHAUSTED = "speech_allowance_exhausted";

/**
 * Whether a speech error frame reports an exhausted voice allowance. That reply
 * is spoken with the browser's built-in voice instead when it can be; every
 * other code (or a frame without one) ends the reply's speech as before.
 */
export function isSpeechAllowanceExhausted(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as Record<string, unknown>).code === SPEECH_ALLOWANCE_EXHAUSTED
  );
}
