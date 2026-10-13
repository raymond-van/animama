# Gemini TTS Guide

This document describes Gemini text-to-speech in `src/frontend/web`: a cloud
voice whose audio the backend pushes over `chat:sse`, beside ElevenLabs and the
on-device voices. The backend side is in
[Voice and speech](../../backend/integrations/voice-and-speech.md#gemini-tts).

## Availability

Gemini is offered only when runtime capabilities report `gemini_tts`, which
only the local composition (self-hosted web and desktop) does; the hosted
adapter refuses a runtime that reports it. The capability carries the model
ids, the prebuilt voices and their defaults, so the settings and the backend
share one list. Gemini is never chosen automatically:
`resolvePreferredTtsProvider` keeps a saved `gemini` choice only while the
capability is present, and otherwise falls back as for an unsupported
provider. Playback needs only Web Audio.

The backend needs the owner's Gemini API key from Google AI Studio:

- **Desktop:** App Settings → API Keys, or Voice → "Gemini API key". Main
  stores it in the encrypted vault and applies it without a restart (see
  [desktop runtime](../../backend/operations/desktop-runtime.md#roots-secrets-and-private-bytes)).
- **Self-hosted web:** `GEMINI_API_KEY` in the server environment; restart the
  server after changing it (see
  [environment variables](../../backend/operations/development.md#common-environment-variables)).

The browser never receives the key.

## Runtime Model

The main runtime files are:

- `src/frontend/web/src/lib/speech/tts-provider.ts`
- `src/frontend/web/src/lib/chat/gemini-chat-tts-dispatch.ts`
- `src/frontend/web/src/ui/main/chat/useChatSession.ts`
- `src/frontend/web/src/hooks/use-tts-playback.ts`
- `src/frontend/web/src/hooks/use-finalized-tts-runtime.ts`
- `src/frontend/web/src/stores/avatar-lipsync-bridge-store.ts`

For each TTS-enabled turn, `useChatSession.ts` sends `dispatch_options.tts`
with `{enabled: true, provider: "gemini", transport: "auto", model_id,
finalized_chunking: "sentence"}`. The backend speaks each prepared sentence as
one Gemini request and pushes its audio as `tts.audio` frames (`pcm_24000`,
`provider: "gemini"`), then one `tts.done`.

`ChatSpeechPolicy.finalizedServerAudio` is true only for Gemini, the one
provider whose audio the server pushes, so the shared session routes
`tts.audio`, `tts.done` and `tts.error` to playback. `useTtsPlayback` prepares
the finalized runtime (`use-finalized-tts-runtime.ts`) when the run starts
instead of streaming text, prewarming the local `AudioContext` and gain node
before the first frame. Its audio signals report the run's own provider.

Each `pcm_24000` frame is decoded into `Int16Array` samples, converted to
normalized `Float32Array` audio, wrapped in a 24 kHz `AudioBuffer` and
scheduled with `AudioBufferSourceNode` through a normal `GainNode`. This path
bypasses the PCM worklet used by realtime streaming and lets the browser's Web
Audio engine resample to the output device rate. The backend coalesces
upstream PCM into frames of at least 0.2 s, so the browser schedules fewer,
larger buffers.

## Speaking Style

The backend turns the reply's hidden emotional tone and the Anima's emotional
level into one speaking style, such as "Speak in a very happy tone.", and sends
it with every request in the reply; neutral or unrecognized tones speak in a
friendly tone. The visible speech, `tts_text` and lip-sync inputs carry no
style.

## Avatar Timing

Lip-sync works as for the other providers: gruut phonemes from
`tts_phonemized_text` plus the played audio's start and duration callbacks.
Gemini returns no timing data. `useChatSession` and the lip-sync bridge accept
`gemini` as a viseme provider; see [Avatar lip-sync](avatar-lipsync.md).

## Settings

- App Settings → Voice → "Default Text-to-Speech provider" lists Gemini where
  it is offered. With Gemini selected, "Gemini model" chooses Flash-Lite TTS
  (`gemini-3.8-flash-lite-tts`, the default, for lower latency and cost) or
  Flash TTS (`gemini-3.8-flash-tts`), saved as the speech preference
  `tts_gemini_model_id`.
- "Stream chunked Text-to-Speech" is off and disabled with Gemini, because the
  server pushes finalized audio. The saved preference is kept for other
  providers.
- Loadout → Voices offers Gemini as the Anima's TTS provider where it is
  offered. With Gemini chosen, `GeminiVoicePicker` lists the prebuilt voices in
  the PocketTTS picker's layout:
  - search, and All/Female/Male tabs;
  - Google's one-word description under each name;
  - a play button on every voice and beside the selection.

  Choosing a voice saves `speech.gemini.voice`. An unknown saved name shows,
  and speaks, the default `Kore`. Genders and descriptions come from
  `GEMINI_VOICE_DETAILS` in `lib/speech/gemini-voices.ts`; a voice it lacks
  lists only under All.
- A sample plays the backend's
  [kept sample](../../backend/integrations/voice-and-speech.md#gemini-voice-samples)
  for the selected Gemini model. The first play of each voice uses the Gemini
  key, and the picker says so. A failure shows the server's message, for
  example the missing-key text.
- Setup and Anima creation offer neither Gemini nor its key.
- Exporting a Gemini-voiced Anima, like an ElevenLabs-voiced one, includes no
  voice binding or provider name.

## Errors

A Gemini failure arrives as one `tts.error` with a `code`; the reply text and
`run.completed` still arrive. The browser shows the "Text-to-speech
unavailable" notice with the frame's `error` text and ends speech for that
reply. No other provider takes over: the Pocket TTS fallback applies only to a
hosted ElevenLabs `speech_allowance_exhausted` decline.

| `code`                           | Meaning                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `gemini_tts_missing_credential`  | No `GEMINI_API_KEY`; the notice reads "Gemini text-to-speech needs a Gemini API key." |
| `gemini_tts_stream_setup_failed` | Preparing a speech segment failed; the notice gives no detail.                        |
| `gemini_tts_stream_failed`       | The request or stream failed, or ended early; the text names at most the HTTP status. |

A 429 from Google reads "Gemini's rate limit or daily quota was reached (HTTP
429). Try again later, or raise your Gemini API tier." Free-tier keys have
small per-minute and daily limits for each model; see Google's
[rate limits](https://ai.google.dev/gemini-api/docs/rate-limits). Each spoken
sentence is one request, and so is each new voice sample.

A browser without Web Audio shows "Gemini TTS needs the Web Audio API, which
this browser lacks." instead of speaking.

## Terms, privacy and billing

- Each spoken reply's text goes to Google's Gemini API with
  `store: false`, so Google keeps no stored interaction for it; Google still
  logs requests for abuse monitoring.
- Google bills Gemini speech to the owner's key. Flash TTS costs more than
  Flash-Lite TTS.
- Google's Gemini API terms say the API is for developers, for professional or
  business use, not consumer use; users must be 18 or older; prompts and
  responses on the free tier may be used to improve Google's products and read
  by human reviewers; and only paid services may be offered in the EEA, the UK
  and Switzerland.
- All Gemini audio carries a SynthID watermark.
