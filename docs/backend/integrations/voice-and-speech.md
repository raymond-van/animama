# Voice And Speech

The backend contains integrations for ElevenLabs TTS/voice operations and
Gemini text-to-speech. Current frontend and desktop speech flows primarily use
client-side STT/VAD/turn detection plus `chat:sse` TTS/session events.

## ElevenLabs

The shared `product_http/routes/elevenlabs.py` exposes voice cloning,
text-to-speech synthesis and sound effects through the composition's speech
port; the local port (`LocalSpeech` in `server/elevenlabs_service.py`) keeps the
key, retries, concurrency limit and owner labels. Audio isolation stays a local
route in `server/routers/elevenlabs.py`.

Anima-specific ElevenLabs configuration contains one voice only:
`speech.elevenlabs.primary_voice`. Legacy persisted `variants` maps are accepted
as ignored input for compatibility and are not serialized back on profile saves.
When a new anima saves an `elevenlabs_voice_profile`, the backend validates the
selected voice against the configured ElevenLabs API key before persisting it.
That fresh save-time check also primes a small process-local runtime cache.

Configuration lives in `server/config.py`, including the API key. The realtime
model is `eleven_v4_turbo`; the former
`ANIMAMA_ELEVENLABS_REALTIME_TTS_DEFAULT_MODEL_ID` setting was removed and is
ignored. Do not return backend API keys to clients. For realtime chat, return
short-lived direct websocket credentials in `chat:sse` `tts.session` events.

## Realtime TTS

For normal chat turns, `POST /v1/animas/{anima_id}/chat:sse` is the
preferred ElevenLabs realtime bootstrap path. The frontend sends explicit TTS
intent in `dispatch_options.tts` when TTS is enabled and the resolved provider
is ElevenLabs:

- `enabled: true`
- `provider: "elevenlabs"`
- `transport: "auto" | "direct"` as request intent
- optional `language_code`
- optional `model_id`: `eleven_v4_turbo`, the only ElevenLabs model. The
  retired ids `eleven_flash_v2_5`, `eleven_multilingual_v2` and `eleven_v3` are
  accepted and mapped to it (`RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS`), so
  every ElevenLabs reply speaks in realtime.

Session setup starts concurrently with the primary direct model turn, so model
invocation does not wait for direct-mode token minting. Runtime voice
accessibility validation uses the process-local cache populated at save time or
by recent chat runs; if the cache misses, the setup task validates once and
caches the result instead of checking repeatedly.
When session setup succeeds, `chat:sse` emits `tts.session`; the event may
arrive before or after the final `user.response`. The event includes a
single-use `ttd_websocket` token, which admits one browser connection to
ElevenLabs' Text to Dialogue socket. That socket refuses `tts_websocket`
tokens. The event also sets `sync_alignment: true`, so ElevenLabs returns
character timing with the audio. The browser keeps it as lip-sync evidence
([provider character timing](../../frontend/runtime/elevenlabs-tts.md#provider-character-timing));
the lip-sync planner does not use it yet. If setup fails, `chat:sse` emits
`tts.session.error` and continues the assistant response.

An omitted `model_id` selects `eleven_v4_turbo`. The backend returns the
selected model in `tts.session.model_id`, and the browser uses it in the
upstream ElevenLabs websocket URL. An unknown explicit realtime id is refused
with 422. Each open dialogue socket holds an ElevenLabs dialogue session from a
pool separate from ordinary request concurrency, so the browser closes it as
soon as the reply ends.

Ordinary non-TTS chat streams do not run gruut for ElevenLabs and do not emit
`tts_text` fields. Gruut speech payloads are limited to main-structured
`speech` parts used by active TTS runs.

Every speech sentence is spoken, whatever its language
(`_attach_tts_speech_payload` in `product_http/chat/sse_events.py`):

- `gruut_prepares_text` (`app/gruut_text.py`) treats text whose letters are
  all ASCII as English, the only language gruut's model verbalizes.
  Typographic punctuation, symbols and emoji do not count; accented, CJK or
  Hangul letters do, so an English sentence with an accented loanword is also
  spoken as written.
- English sentences carry gruut's `tts_text` and phonemes
  (`tts_text_basis: "gruut_text_with_ws"`).
- Other sentences, and any sentence when gruut is unavailable, are spoken as
  written (`visible_text` basis) with no TTS fields and no phonemes. Their
  lip-sync falls back to the visible-text estimate.
- A segment with no letters or digits, such as an emoji after the last
  sentence, stays visible text and is not spoken by finalized speech (Gemini).

Realtime TTS uses a direct browser-to-provider connection after `tts.session`.

## Finalized TTS

Finalized speech is pushed by the backend over `chat:sse` instead of a realtime
session. Gemini is the only finalized provider (see [Gemini TTS](#gemini-tts));
ElevenLabs always speaks in realtime. `FinalizedTtsStreamBootstrap` in
`product_http/chat/tts.py` starts once the main-structured speech stream has
prepared speech, synthesizes it in order, and pushes `tts.audio`, one final
`tts.done`, or `tts.error` over the same stream.

What is sent:

- **Sentence mode**, the default `finalized_chunking="sentence"`, sends one
  request per prepared sentence, using its prepared text.
- **Paragraph mode**, `finalized_chunking="paragraph"`, keeps the public
  sentence-level `user.response` events but joins the visible sentence text of
  each paragraph into one request. A batch flushes when a new paragraph starts,
  at four sentence segments, at about 600 visible characters, or when the
  speech stream closes. `server/finalized_speech.py` re-prepares English
  batches with gruut and leaves other text as written.

Response handling:

- `chat:sse` audio chunks include `type: "tts.audio"`, `run_id`, `provider`,
  `model_id`, `output_format` and `audio_base64`. The backend coalesces
  upstream PCM bytes into frames of at least 0.2 s, to avoid many tiny browser
  playback buffers.
- In paragraph mode, a generated 400 ms silence frame is inserted before each
  later paragraph batch, using the same `tts.audio` shape.
- The stream ends with one `type: "tts.done"` after the last batch.
- If batch setup or upstream streaming fails, the backend emits one
  `type: "tts.error"`, skips `tts.done` and still completes the chat run.

Voice-structured responses are prompted and schematized to include
`emotional_tone`, `emotional_intensity`, `gesture`, then `speech`. The tone and intensity
fields are backend-internal metadata: they are not emitted as visible chat text
and are not stored as assistant messages. Normal `chat:sse` uses them to compute
and persist a full-state `emotion.update`; the frontend still treats the
resulting `emotions` array, not raw tone metadata, as canonical avatar emotion
state. Gemini speech also takes its speaking style from the tone (see
[Gemini TTS](#gemini-tts)). The `tts_text`, `tts_phonemized_text`, persisted
speech, avatar lip-sync inputs, realtime ElevenLabs websocket text, PocketTTS
text, and browser TTS text carry no tone tag. If the model sends `neutral`,
omits `emotional_tone`, sends it blank, or returns a value outside the
allowlist, the backend logs a warning for malformed metadata when applicable,
emits a no-op emotion update with `emotional_intensity=0`, and speaks in the
friendly default tone instead of failing the chat turn.

The frontend finalized runtime decodes and plays PCM audio from SSE events.
Avatar lip-sync continues to use gruut phonemes from SSE plus provider
audio-start and actual-duration callbacks. Anima preserves the additive
`tts_text` fields on `user.response` as provider handoff data.

## Gemini TTS

Gemini text-to-speech is a cloud voice offered only by the local composition
(self-hosted web and desktop). That composition supplies
`ChatTurnServices.gemini_speech` (`LocalGeminiSpeech` in
`server/gemini_tts_service.py`) and reports the
`gemini_tts` runtime capability defined in `app/contracts/gemini.py`: the
models `gemini-3.8-flash-lite-tts` (default) and `gemini-3.8-flash-tts`,
Google's 30 prebuilt voices, and the default voice `Kore`. Where
`gemini_speech` is `None`, as in a hosted composition, a Gemini request gets no
speech frames. Browser playback, settings and Google's terms are in
[Gemini TTS](../../frontend/runtime/gemini-tts.md).

The key is `GEMINI_API_KEY`: loaded from the process environment at startup
(Compose forwards it to `animama-server`) or delivered from the desktop vault,
and read per request from the runtime credential store. It is not in
`KNOWN_PROVIDER_CREDENTIAL_ENVS`, so no owner model connection can name it, and
`GOOGLE_API_KEY` is never read. Build SDK clients only with
`adapters/voice/gemini_client.py`. It passes the key explicitly, pins
`https://generativelanguage.googleapis.com/` on `v1beta` (Interactions audio
output exists only there), overrides the SDK's environment fallbacks for the
key, base URL, Vertex mode, replays and default headers, and turns off the
Interactions sub-client's own retries and header debug logging, so a failed
request is not retried. The service imports `google-genai` on the first Gemini
request and keeps one client per key.

A chat request selects Gemini with `dispatch_options.tts`
`{enabled: true, provider: "gemini", model_id, finalized_chunking}`; a
`model_id` that belongs to another provider is rejected. Gemini always uses the
[finalized flow](#finalized-tts) (`FinalizedTtsStreamBootstrap` in
`product_http/chat/tts.py`), with its sentence or paragraph batching,
paragraph pause and frame order. Each batch is one streamed Interactions
request with `store: false`, `audio/l16` at 24 kHz and
`speech_config: [{voice}]`, where the voice is the Anima's
`speech.gemini.voice`, resolved once per run; a missing or unknown name speaks
`Kore`. Gemini receives no continuity text or language code. Its stream is
16-bit little-endian PCM (measured), which `server/finalized_speech.py`
re-frames into `pcm_24000` `tts.audio` frames of at least 0.2 s each, except
the last of each request. Frames carry `provider: "gemini"` and the Gemini `model_id`. At most
three Gemini requests run at once per process.

Every request in a reply carries the same speaking style as a
`speech_metadata` annotation. `gemini_speaking_style` in
`app/voice_emotional_tone.py` builds it from the reply's tone and its level in
the Anima's emotional state: for example `Speak in a slightly happy tone.`, `Speak in a happy tone.`
or `Speak in a very happy tone.`, and `Speak in a friendly tone.` for neutral,
missing or unrecognized tones. Without a backend-visible emotional state the
style has no intensity word.

A Gemini failure emits one `tts.error` and no `tts.done`; the reply text and
`run.completed` still arrive. The Gemini-specific codes are
`gemini_tts_missing_credential` (no key), `gemini_tts_stream_setup_failed` (segment setup) and
`gemini_tts_stream_failed` (a request error, an `error` event, or a stream that
ends without completing). The `error` text asks for the key when it is missing
and otherwise names at most the HTTP status (a 429 says the rate limit or daily
quota was reached), never request text or the key. The opt-in
[live test](../../../tests/live/README.md) re-measures format, byte order and
latency against the real API.

### Gemini voice samples

Google publishes no sample audio for its prebuilt voices, so the voice picker
asks the local route `GET /v1/gemini/voices/{voice}/sample`
([HTTP API](../architecture/http-api.md#gemini-voice-samples)).

- **Generation.** On the first play, `server/gemini_voice_samples.py` speaks
  "Hi there! This is how I sound when we talk." in the friendly default style
  through `stream_gemini_finalized_speech`. It therefore shares the key check,
  the client, the three-request limit and the status-only errors. The audio is
  cut at 10 s.
- **Storage.** Each sample is stored as a 24 kHz mono WAV at
  `<data root>/internal/derivatives/gemini-voice-samples/<model>/<voice>.<digest>.wav`.
  The digest covers `SAMPLE_VERSION`, the line and the style. Changing any of
  them, or bumping the version after Google changes a voice, replaces the old
  files on their next play.
- **Writes and concurrency.** Writes are atomic, and a damaged file is spoken
  again. Plays of the same file share one request, which a stopped play does
  not cancel, so a sample is billed once.

## Client-side speech recognition

The frontend and desktop use client-side Parakeet STT, MicVAD, and smart-turn
turn detection. Check frontend speech ownership before adding backend audio
processing; the local API has no STT or LiveKit session routes.

## Voice Session State

Normal chat resolves any request-local TTS session state inside the
`chat:sse` request. Durable voice configuration belongs in anima settings,
voice catalog metadata, or provider-side resources.

## Voice Catalog Storage

Named Pocket clones are caller-owned Local `voice` content shared across that
owner's Animas. `GET`/`PUT /v1/voice-content` use the existing typed content
library and revision-checked Save contract. Each `pocket-tts-catalog-v1`
descriptor retains one `pocket_voice_catalog` (`.bin`) containing a neutral
embedding and may retain one `source_sample` (the unchanged WAV, MP3 or Ogg
recording). Locally authored clones retain the recording; clones imported with
a complete Anima contain only the encoded catalog.
Each file is limited to 25 MiB. Save, scan and package admission reject malformed
audio, non-finite embeddings, invalid dimensions and mismatched file membership.
Format and encoder provenance may be retained in the descriptor's `provenance`.

The existing Anima `voice:plan`/`voice:commit` commands equip a clone by catalog
identity. A runtime mount projects only its encoded catalog into `voice.files`;
an original recording, when present, remains available through the owner-authorized
registered file endpoint. Anima ZIP export excludes that recording and carries
only the active PocketTTS clone, as described in the
[package boundary](../features/typed-content-and-marketplace.md#local-package-boundary). Rename updates the same catalog item under its expected revision.
Deletion uses the normal content Delete endpoint and refuses voices still bound
to any Anima. Selecting a built-in voice removes the clone binding.

Legacy Animas may reference a Pocket voice catalog uploaded through the dedicated
`/v1/animas/voice-catalogs/uploads` lifecycle (shared routes over
`VoiceCatalogUploadService`). The authenticated PUT is bounded and spooled under
the composition's staging directory (`data/staging/uploads` locally) into its
private storage; finalization validates the catalog and publishes
a normal standalone file plus metadata sidecar under
`content/local/voices`. This voice-specific upload path is separate from
private chat attachments; see
[custom Animas and typed content](../features/custom-animas-and-content.md).

## Adding Voice Features

When adding or changing voice behavior:

1. confirm whether the frontend already performs the function client-side
2. keep provider secrets server-side
3. prefer short-lived credentials or proxied backend calls for browser access
4. document the supported transport and its compatibility constraints
5. add tests around auth, provider error mapping, and binary/audio responses


## Shared bounded speech ports

`app/ports/voice.py` retains the local STT/TTS provider protocols and adds
composition-owned `SpeechCall`, `SpeechLimits` and `SpeechCallBoundary`.
`app/services/bounded_speech.py` admits one server-proxied call, caps text and
PCM16 input before forwarding it, caps output bytes, enforces a deadline and
closes streams on disconnect. Disposal and receipt persistence have separate
finite cleanup deadlines. It returns no browser provider token. The
composition must select a provider that does not retry internally; every paid
retry needs a fresh admission.

Each provider pull uses the same absolute deadline. Consumer work between
yielded chunks runs outside its cancellation scope; the next pull fails if
the deadline expired while the consumer was busy. Closing still disposes the
provider and input streams and records one cancellation outcome.

`SpeechCallOutcome` separates observed transport units from optional measured
provider units. Legacy speech providers expose no billing receipt, so the shared
adapter leaves `provider_usage` unknown, including on successful completion.
This does not settle an uncertain call as zero. Paid compositions must reconcile
provider usage in their boundary rather than infer charges from delivered bytes.

`OwnerVoiceCatalog` makes list, clone and delete ownership explicit. Clone
samples are bytes with names/content types, never local paths. Implementations
validate and bound sample count, bytes and duration before provider dispatch,
authorize the selected voice, and meter clone operations. Browser-local voice
engines may keep clones as owned content. Existing local ElevenLabs routes and
browser-local model execution continue using their current adapters; these ports
do not themselves activate hosted speech or change those local workflows.
