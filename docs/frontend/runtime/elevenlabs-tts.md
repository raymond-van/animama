# ElevenLabs TTS Guide

This document describes the browser-side ElevenLabs TTS runtime in
`src/frontend/web`: admitted realtime websocket speech with Eleven v4 Turbo,
the only ElevenLabs model.

## Runtime Model

ElevenLabs is one of the supported TTS providers alongside browser speech
synthesis and PocketTTS. The main runtime files are:

- `src/frontend/web/src/hooks/use-tts-playback.ts`
- `src/frontend/web/src/hooks/use-elevenlabs-tts-runtime.ts`
- `src/frontend/web/src/ui/main/chat/useChatSession.ts`
- `src/frontend/web/src/stores/avatar-lipsync-bridge-store.ts`

Provider selection is stored as `"browser" | "pocket_tts" | "elevenlabs" | "gemini"`
([Gemini TTS](gemini-tts.md)).
The ElevenLabs model is stored as `tts_elevenlabs_model_id`, always
`eleven_v4_turbo`. Saved retired ids (Flash v2.5, Multilingual v2 and
`eleven_v3`) read as `eleven_v4_turbo`. The former finalized grouping
preference, `tts_elevenlabs_v3_finalized_chunking`, is no longer read.

## Realtime Model

The realtime model is `eleven_v4_turbo`, the frontend and server default. It
speaks only on ElevenLabs' Text to Dialogue WebSocket
(`/v1/text-to-dialogue/stream-input`); the Text to Speech socket rejects v4.
Saved `eleven_flash_v2_5`, `eleven_multilingual_v2` and `eleven_v3`
preferences read as `eleven_v4_turbo` (`toElevenLabsTtsModelId`), and the chat
request contract maps the same retired ids, so a tab opened before an upgrade
still gets its reply, now spoken in realtime.

For realtime chat turns, `useChatSession.ts` sends explicit TTS intent in
`dispatch_options.tts`. `chat:sse` resolves the ElevenLabs realtime session and
emits `tts.session`. The local composition opens a direct ElevenLabs websocket
using the short-lived token from that SSE event when provider connection authority
is available. A hosted consumer instead sends `transport: "server"` and
`websocket_url`, a path under `/v1/` on the admitted application origin. The browser
uses its session cookie, accepts no URL credentials, query or fragment, and never
falls back to a provider socket. The consumer must bind the stream to its admitted
run, validate the current session and Origin, reserve bounded speech work and
settle usage/cancellation. Frontend fixture success does not establish that server
boundary or real speech delivery.

The `tts.session` event includes the selected voice, model, output format,
transport, and `sync_alignment`. Local sessions set `sync_alignment: true`, so
ElevenLabs returns character timing with the audio. The runtime places it on the
run clock (see [Provider character timing](#provider-character-timing)).

The direct socket protocol (`use-elevenlabs-tts-runtime.ts`):

- The URL carries `model_id`, `output_format`, `sync_alignment`, an optional
  `language_code` and the single-use token. The voice is not in the path.
- The first message registers the voice: `{"voices": [voice_id]}`.
- Each text chunk is sent as `{"inputs": [{"text": "<chunk> ", "voice_id": ...}]}`.
  The runtime restores the separating space that the chunker trims.
- After the run's first chunk the runtime sends one `{"flush": true}`. A short
  first sentence then starts speaking without waiting for the provider's
  buffer of about 40 characters and 8 words. Later chunks are not flushed, so
  the rest of the reply stays in one prosody turn.
- ElevenLabs closes a socket after 20 s without a client message. The runtime
  sends `{"keep_alive": true}` after 10 s without one, until the reply's text
  ends.
- Completion sends `{"close_socket": true}`, and the run ends on
  `{"is_final": true}`. A `{message, error, code}` message ends that reply's
  speech with the usual notice.
- Each open socket holds an ElevenLabs dialogue session, so cancel, a
  superseding run and stop close it at once.

The hosted server transport keeps the frames its consumer validates:
`{"text": " "}` on open, `{"text": chunk}` per chunk, and `{"text": ""}` at the
end, with no flush or keep-alive frames. It ends on `isFinal` or `is_final`.

Loadout → Voices saves the Anima voice ID without contacting ElevenLabs, even
when another provider is selected. The backend checks voice accessibility when
starting ElevenLabs playback and keeps a short process-local runtime cache. Realtime chat still
resolves the selected voice and mints a single-use `ttd_websocket` token per run
(the dialogue socket refuses `tts_websocket` tokens), but
it does not perform a fresh ElevenLabs `voices.get` call when the cache says the
voice was recently valid.

If session setup fails, `chat:sse` emits `tts.session.error` and continues
streaming assistant text. The frontend marks TTS skipped for that run, except
that a hosted `speech_allowance_exhausted` decline on this frame, before or
after the reply text, moves the run to [Pocket TTS](voice.md#elevenlabs-tts)
where it is supported.

## Speech Text

For main-structured TTS speech, `user.response` can include additive TTS
fields:

- `tts_text`
- `tts_phonemized_text`
- `tts_text_basis: "gruut_text_with_ws"`

gruut prepares speech whose letters are all ASCII, which is treated as English,
whatever its punctuation, symbols or emoji: `tts_text` is its normalized text,
with numbers spelled out, and `tts_phonemized_text` is its phonemes. Speech with
other letters carries no TTS fields and is spoken as written, in any language.
This includes Japanese, Korean, Chinese and accented Spanish, and English with an
accented loanword. Realtime ElevenLabs speech sends `tts_text` to the admitted
websocket when `tts_text_basis` is `gruut_text_with_ws`, and the visible speech
text otherwise.

For structured speech streaming, `useChatSession.ts` sends each speech delta
into the existing TTS pipeline as it arrives. Realtime ElevenLabs speech keeps
one browser websocket per chat run; ordered input frames provide continuity,
and completion ends the stream as described under the realtime model.

Voice-structured responses also contain internal `emotional_tone` and
`emotional_intensity` fields before `speech`. The backend filters those fields
out of frontend `user.response` events. Normal `chat:sse` uses them to compute
and persist the full-state `emotion.update`; the frontend still uses that
event's `emotions` array as the avatar source of truth. ElevenLabs speech text
carries no tone tag. Missing, blank, or unrecognized tone metadata is handled in
the backend with a warning and does not create a frontend-visible error.

## Avatar Timing

ElevenLabs audio uses the same avatar timing callbacks as the other TTS
providers:

- `onAudioStarted`
- `onAudioDurationResolved`
- `onPlaybackEndedSignal`
- `onAudioEnded`

The avatar lip-sync bridge uses gruut phonemes from SSE and the actual played
audio duration to build or recompute vowel viseme timing. For structured speech
streaming, `useChatSession` accumulates the `tts_phonemized_text` from every
speech segment that is sent to TTS, so the final run-level duration correction
uses the same text basis as the spoken audio. Lip-sync timing comes from those
phonemes and playback callbacks, not ElevenLabs alignment metadata.

### Provider character timing

The runtime also reports the provider's character timing through
`onSpeechTiming`. `useChatSession` appends it to the lip-sync bridge's
`providerSpeechTimingByRun`, which is cleared with the run. It is evidence for
lip-sync planners; the current planner does not read it.

`lib/speech/provider-speech-timing.ts` puts every character on the run clock:
seconds from the run's first audio sample. Add the run's `audioStartSec` to map a
character onto the playback clock. That holds while playback has not starved: the
player plays silence when its buffer runs dry, and its clock keeps running, so
every later character is early by the gap (as for
`audioContext.currentTime - audioStartSec` elsewhere).

- **Dialogue socket.** Each frame's `alignment` (`chars`,
  `char_start_times_ms`, `char_durations_ms`) restarts at 0. Within a prosody
  turn the frames tile the turn's audio, but some audio frames carry
  `alignment: null`. A cursor advances by each frame's length and restarts at the
  audio received when the provider sends `is_final_audio_for_turn`, because a
  turn's timing can overrun its audio (80 ms in captured Japanese, Korean and
  Chinese turns).
- **Server socket.** A hosted consumer may add `alignment` (`characters`,
  `character_start_times_seconds`, `character_end_times_seconds`) to its audio
  frames, already timed from the run's first audio sample; it is appended as it
  is.

Malformed timing is ignored, and frames that arrive after the run stops are
dropped with its socket. The captured text is the text as sent, including audio
tags and the space restored after each chunk.

## Settings

ElevenLabs has no model selector: it always speaks with Eleven v4 Turbo, which
the provider description names. Selecting ElevenLabs writes
`tts_elevenlabs_model_id: "eleven_v4_turbo"`, which also replaces a saved
retired id. The "Stream chunked TTS" switch applies only to ElevenLabs; the
other providers never stream text chunks.

Anima voice selection is resolved from
`speech.elevenlabs.primary_voice`. Legacy saved
`speech.elevenlabs.variants` maps are ignored.
