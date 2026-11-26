# Voice Guide (`src/frontend/web`)

Voice input uses browser recognition or offline recognition (Parakeet for
English, SenseVoice-Small for Japanese, Korean, Chinese and English) with
acoustic and semantic VAD. Output uses browser speech, PocketTTS, ElevenLabs or Gemini. See
[Avatar lip-sync](avatar-lipsync.md) for synchronization and
[Pocket catalogs](../features/emotional-voice-catalog.md) for voice embeddings.

## Runtime Summary

### Input modes

| Mode        | How user starts it                          | STT provider path                         | Acoustic VAD            | Semantic VAD (smart-turn) | Submit behavior    |
| ----------- | ------------------------------------------- | ----------------------------------------- | ----------------------- | ------------------------- | ------------------ |
| `typed`     | text input                                  | none                                      | n/a                     | n/a                       | manual             |
| `dictation` | mic button                                  | resolved provider (`parakeet` or browser) | yes for offline/browser | no                        | manual             |
| `voice`     | voice button or voice-mode switch from chat | resolved provider (`parakeet` or browser) | yes                     | yes                       | auto on `end_turn` |

### STT provider matrix

| Provider           | Source                                       | Where used        | Notes                                                            |
| ------------------ | -------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `browser_external` | Web Speech API                               | dictation + voice | default browser path                                             |
| `browser_local`    | Web Speech API with `processLocally`         | dictation + voice | no longer offered; a saved choice still works and shows as Browser |
| `parakeet`         | offline ONNX worker of the language's engine | dictation + voice | MicVAD windows transcribed locally; live previews on WebGPU only |

In the Animama Electron desktop shell, browser Web Speech providers are treated
as unavailable even if Chromium exposes `SpeechRecognition` or
`webkitSpeechRecognition`. Electron can surface the API but fail recognition
with a `network` error, so desktop dictation and voice mode use offline
recognition only when the routed engine's runtime capability is available.

### Offline engine choice

The stored `parakeet` provider means offline recognition, whichever engine
runs. The owner may choose the engine (`speech.stt_offline_engine`,
`"parakeet"` or `"sensevoice"`); without a choice it follows the conversation
language, which is the UI Locale
([ADR 0024](../../adr/0024-ui-locale-is-the-conversation-language.md),
[ADR 0029](../../adr/0029-sensevoice-offline-speech-recognition.md),
[ADR 0031](../../adr/0031-offline-speech-engine-is-the-owners-choice.md)).
When dictation or Voice Mode starts, `routeOfflineSpeech(locale, engine)`
(`lib/speech/offline-stt/routing.ts`) returns the engine and its prompt:

| Engine (chosen, or the UI Locale's default)                 | UI Locale                  | Language prompt and output                                                                 |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| Parakeet TDT 0.6B v2 (default for `en`, unset, unsupported) | any                        | none (English only)                                                                        |
| SenseVoice-Small (default for `ja`, `ko`, `zh-Hans`)        | `ja`, `ko`, `zh-Hans`      | `lang_ja`, `lang_ko`, `lang_zh` (Simplified)                                               |
| SenseVoice-Small (default for `zh-Hant`)                    | `zh-Hant`                  | `lang_auto`, so Mandarin and Cantonese both work; converted to Taiwan-standard Traditional |
| SenseVoice-Small (chosen)                                   | `en`, unset or unsupported | `lang_auto` (route language `auto`): detects the spoken language; no conversion            |

- The route is read once per start, and unmuting Voice Mode keeps it, so a
  locale or engine change applies from the next start.
- `offlineSttEnginePreference()` (`lib/settings/preferences.ts`) reads the
  engine; any other stored value follows the UI Locale.
  `speech.stt_parakeet_webgpu` is the GPU preference for both engines; no
  stored value is renamed.
- `resolveRoutedSttProvider` (`lib/speech/stt-provider.ts`) resolves the
  provider for dictation and for Settings. A saved offline choice whose
  engine's set is missing stops (`languageMissing`) instead of falling back
  to a browser recognizer, which may send audio to a cloud service: with
  "Install offline speech recognition for this language"
  (`languageSpeechMissing`) for SenseVoice under a non-English locale, or
  `offlineSpeechMissing` for a chosen Parakeet under another locale and for
  SenseVoice chosen under English. Only Parakeet under English falls back
  to an available browser recognizer (`route.browserFallback`,
  `resolvePreferredSttProvider`).
- Segments name their engine (`SttSegmentSource` is `"parakeet"` or
  `"sensevoice"`), while the active provider stays `"parakeet"`, so Smart
  Turn, mute and stored preferences treat both engines alike. Smart Turn's
  forced short replies are one table for every language, so `auto` needs no
  entries of its own.

### Optional offline speech models

The embedded core does not contain offline speech weights. On packaged desktop
and built self-host, each offline engine has two downloadable sets:

| Engine           | Languages                          | CPU model        | GPU acceleration add-on |
| ---------------- | ---------------------------------- | ---------------- | ----------------------- |
| Parakeet         | English                            | `parakeet-stt`   | `parakeet-stt-webgpu`   |
| SenseVoice-Small | Japanese, Korean, Chinese, English | `sensevoice-stt` | `sensevoice-stt-webgpu` |

Each set installs in place through the backend
[model assets](../../backend/architecture/http-api.md#model-assets) with size,
progress, cancel, retry and removal. When the model-asset list reports
`downloads_offered: false`, as every local composition will after the final
release, a set that is not installed shows no download or size, the
panel says that downloads have ended and what still works
(`modelDownloadsEndedNote`), installed sets keep their removal, and dictation
says a missing model can no longer be downloaded. The rest of this section
describes a runtime that offers downloads. The add-on is always shown; when it cannot
be installed (CPU model missing, no WebGPU adapter, or not in this build) its
action is disabled with the reason. A loaded asset list without an engine's
sets shows them as not available, for example on a runtime whose operator does
not provide SenseVoice.

Setup and App Settings choose Speech-to-Text with the same two tab levels as
the AI step's models (`SttChoiceTabs`, choices from `lib/speech/stt-choices`):
a top row of engines (Browser on the web, then the UI Locale's offline engine
and the other one) with the recommended one tagged, and under an offline
engine its **CPU | GPU** versions. The web recommends and defaults to the
browser's recognizer (one Browser choice, saved as `browser_external`; a saved
`browser_local` shows as Browser); desktop, which has no browser recognizer,
recommends the UI Locale's offline engine on the CPU. Either offline engine's
choice stores the offline provider, the GPU preference and its engine
(`sttChoicePatch`), which then runs under any UI Locale; the Browser choice
keeps the saved GPU preference and engine. Each version says which languages
its engine recognizes. Selecting a tab selects the choice: App Settings saves
it at once (an offline choice even before its set is installed), and Setup
saves it at Finish, even untouched, but saves the engine only when the owner
picked it, so an untouched default keeps following the UI Locale. In Setup an offline version carries its
set's download as "CPU (size)" or "GPU (size)" (`SetupSpeechChoice`), the GPU
version a WebGPU ✓/✗ check; asking for the GPU set first says to download the
CPU version. App Settings shows the same per-version panels
(`OfflineSetPanel`, shared with Setup) and adds removal (the CPU set only once
the GPU add-on is gone), the WebGPU fallback note and operator-provided sets
without actions. The engine that runs carries a "Selected" tag, and Browser is
labelled "Browser (built-in)", described as the Web Speech API with a link to
its documentation. Model attribution is in the packaged notices and each
installed set's `ATTRIBUTION.md`, not in the UI. The composer offers no
downloads: without a usable engine its dictation and Voice Mode controls are
disabled and Settings is the place to install one.
Every download can be skipped. Downloads
continue in the backend after leaving Setup or Settings: the chat status lines
show their size and progress, and `ModelDownloadToasts` (mounted in the app
layout) shows one short toast when a speech-to-text set (Parakeet or
SenseVoice) or the Voice Clone encoder finishes or fails. Vite development
serves the operator's host sets and shows each engine's acquire commands
instead of downloads.

`GET /v1/runtime-capabilities` reports each engine's availability and nullable
CPU and GPU set versions: `offline_speech_enabled`,
`offline_speech_asset_version` and `offline_speech_gpu_asset_version` for
Parakeet, and `offline_multilingual_speech_enabled`,
`offline_multilingual_speech_asset_version` and
`offline_multilingual_speech_gpu_asset_version` for SenseVoice. They are derived
from the installed sets on each request; the renderer refetches them when an
install or removal settles. Unknown
or disabled availability is not treated as support; dictation checks fresh
metadata before starting and the worker loader checks it again. Saved provider
preferences are not rewritten just because a capability request failed.

Without the routed engine's CPU model, desktop offline dictation and Voice Mode
cannot start. Text chat, avatar animation, microphone permission, and PocketTTS
are independent. The main chat/settings surface offers installation; companion
windows direct the user to main-window Settings. Browser Web Speech fallback
remains available only where the ordinary web platform supports it; a saved
offline choice whose set is missing falls back to it only for Parakeet under
English.

`SpeechLanguageNotice` sits beside the speech provider choices and takes the
saved engine. With an offline choice that runs SenseVoice and no available
SenseVoice set, it asks for the download (for the language, or for SenseVoice
under English); where the operator manages models, or the runtime reports an
installed SenseVoice version that is turned off, it says the server does not
provide it. With Parakeet running under a non-English locale it warns that
Parakeet recognizes English only. It shows nothing for Parakeet under English
or once SenseVoice's set is available. Pocket TTS keeps its English-only
notice.

Installed model requests stay on the protected local origin at
`/onnx/models/<model-id>/` and `/onnx/models/<model-id>-webgpu/`
(`parakeet-tdt-0.6b-v2`, `sensevoice-small`) with `?v=<manifest digest>` from
the matching capability version. FastAPI checks inventory and containment,
supports single byte ranges, and rejects stale versions. While a worker has a
set loaded, the client holds a use lease (`POST /v1/model-assets/{id}:lease`,
renewed every 10 s, released when the worker is disposed); the backend refuses
to remove a leased set (`model_asset_in_use`) and refuses to remove a CPU
model while its GPU acceleration is installed (`model_asset_required_by`).
Removing a set from the settings first disposes this page's idle worker for
that engine. Lease failures are logged and never stop dictation.

### TTS provider matrix

| Provider     | Source                       | Primary path           | Notes                                                                                                                                |
| ------------ | ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `browser`    | `speechSynthesis`            | fallback/simple speech | queue of utterances                                                                                                                  |
| `pocket_tts` | local worker/worklet runtime | primary voice UX       | detailed below; preferred for avatar sync                                                                                            |
| `elevenlabs` | ElevenLabs WS                | streamed speech output | realtime Eleven v4 Turbo streams text chunks over the Text to Dialogue socket                                                        |
| `gemini`     | Gemini via `chat:sse`        | streamed speech output | offered only with the `gemini_tts` capability; plays backend-pushed sentence audio                                                   |

## Core Concepts and IDs

### `runId` vs `turnId` vs `jobId`

- `runId`: chat request run identifier. Created when we actually submit user text to backend (`useChatSession.ts`).
- `turnId`: local user speaking turn identifier. Created at voice/dictation start and rotated after smart-turn auto-submit.
- `jobId`: smart-turn inference job identifier for one semantic check.

### Shared voice types

Runtime voice types live in:

- `src/frontend/web/src/lib/types/voice-types.ts`

Important types:

- `AvatarInteractionPhase`
- `SttSegment` + `SttSegmentSource`
- `AcousticVadEvent`
- `SmartTurnJob`
- `SemanticVadDecision`
- `VoiceTurnState` (type-level scaffold)

Note:

- `activeVoiceTurn` exists in `avatar-runtime-store` shape but is not fully populated by current dictation runtime yet.

### Runtime session state

`useDictation()` distinguishes session mode from live capture state.

Important exposed state:

- `activeMode: "dictation" | "voice" | null`
- `isMicCaptureActive`
- `isVoiceMicMuted`

Why this matters:

- a voice session can remain active while mic capture is paused
- `activeMode` distinguishes dictation from voice mode
- avatar listening UI follows active capture, not merely "some voice session exists"

## Developer and self-host model inputs

The offline speech-to-text sets and the ten reviewed Pocket TTS/Smart Turn core
inputs are acquired from exact pinned revisions into a verified shared store
outside Git worktrees.
`models/browser-runtime/manifest.json` also binds nine ORT 1.24.2 files from the
exact dependency alias and two VAD 0.0.30 files from its pinned package. Other
bundled ORT imports keep their existing locked versions.

Use the [model setup guide](../../backend/operations/model-assets.md) before
starting Vite or Compose, or building the web application. It documents
`ANIMAMA_MODEL_ROOT`, the native Windows `%LOCALAPPDATA%\Animama\models` default,
and the Linux default used by WSL. Development verifies and serves engine inputs
at the existing same-origin URLs; built self-host and desktop outputs contain
independent verified copies of the 21 browser assets. The speech-to-text sets
remain outside the web build: development serves the host store, while packaged
desktop and built self-host download them in the app (see
[Optional offline speech models](#optional-offline-speech-models)).

Startup and builds do not acquire models implicitly. Browsers do not receive
upstream acquisition URLs or credentials. The existing Pocket input license
conditions and notices remain in force; changing storage does not change usage
rights or inference behavior.

## STT Pipeline (Dictation + Voice Mode)

Implementation paths are listed in the [file map](#implementation-file-map).

### Start behavior

Entrypoint:

- `startDictation(mode?: "dictation" | "voice")`
- `switchMode(nextMode: "dictation" | "voice")`

Rules:

- both modes read fresh runtime capabilities, route the offline engine
  (`routeOfflineSpeech()` with the saved engine) and resolve the provider with
  `resolveRoutedSttProvider(...)`:
  - offline recognition is used when available and selected, or as an
    available fallback when browser STT is unavailable
  - browser STT remains the normal web default when available
  - when offline recognition is resolved but the routed set is unavailable
    (for example on desktop, which has no browser fallback), the start stops
    with `offlineSpeechMissing` (Parakeet, or SenseVoice under English) or
    `languageSpeechMissing` (SenseVoice under another locale); a saved offline choice whose set is missing always stops,
    except Parakeet under English
  - offline startup/transcription errors surface instead of silently switching
    providers
- desktop shell detection disables Web Speech availability; without the routed
  engine's installed capability, desktop dictation and Voice Mode cannot start.
  Where the owner installs this installation's models, the composer's Dictate
  and Voice Mode controls then say that speech recognition needs a model and
  open App Settings at Speech-to-Text, where the downloads are. They stay
  disabled in Quick Chat, which has no App Settings, and where the operator
  provides the models
- `switchMode("voice")` is used by `ChatInterface` to hand off from active plain dictation into voice mode

Provider helpers:

- `src/frontend/web/src/lib/speech/stt-provider.ts`

### Microphone input and sensitivity

App Settings → Voice → Microphone chooses the input device, voice-detection
sensitivity and offers an opt-in level meter
(`web/src/lib/voice/microphone-preferences.ts`, `web/src/ui/settings/MicrophoneSettings.tsx`).

- The device ID is stored per machine in local storage and requested with an
  `ideal` constraint, so an unplugged device falls back to the system default.
  Offline dictation and Voice Mode pass it to MicVAD through `getStream` and
  to the visualizer. Browser speech recognition cannot target a device, so the
  browser path keeps its visualizer and MicVAD on the system default to match
  the recognizer.
- `speech.mic_sensitivity` (`low`/`normal`/`high`) selects MicVAD positive and
  negative speech thresholds and minimum speech length at session start;
  `normal` is 0.3 / 0.25 / 180 ms.
- The level meter (a segmented −60 to 0 dBFS bar) opens its own stream only
  while testing and releases it on stop, device change or unmount.

### Voice mode provider flows

Voice mode has two STT provider implementations. Both share the same MicVAD,
smart-turn, auto-submit, avatar phase, mute/unmute, silence-reset, and chat
input integration. They differ in where transcript text comes from and when
smart-turn is run.

#### Browser STT voice mode

Browser voice mode is recognition-event driven:

1. `startDictation("voice")` resolves to `browser_external` or
   `browser_local` when browser STT is selected and supported.
2. `startBrowserDictation(provider, "voice")` creates:
   - a browser `SpeechRecognition` instance
   - MicVAD acoustic gate state
   - per-turn text buffers (`finalText` and `interimText`)
   - the smart-turn worker
   - a separate visualizer stream for the waveform
3. Browser recognition runs continuously with interim results enabled.
4. Result events are parsed by `processBrowserRecognitionResult(...)`.
5. Transcript text is routed through the current MicVAD gate:
   - outside a window: ignored
   - inside a non-real speech window: tentative
   - inside a real speech window: committed
   - just after an accepted real window: can be committed during the late-final
     grace window
6. Final browser text emits through `onSegment(...)` and final/interim buffers
   publish `onTranscriptPreview(...)`.
7. Accepted MicVAD audio is appended to `smartTurnAudioRef` at speech end.
8. Smart-turn runs on the rolling accepted audio. If it returns `end_turn`, the
   end-turn coordinator submits committed text immediately or waits briefly for
   browser transcript updates/fallback buffers.

Browser voice mode can show live interim text because the browser recognition
API exposes interim transcript events.

#### Offline STT voice mode

MicVAD supplies accepted mono 16 kHz windows to the routed engine's worker
(`offline_stt/transcribe`, with the route's language). The engine commits final
text before smart-turn runs on the accepted audio, so the end-turn coordinator
normally has text ready immediately. On the WebGPU backend, display-only
previews show interim text while a window is open; see
[Live previews](#live-previews).

#### Shared voice-mode behavior

- `muteVoiceMic()` pauses capture while preserving the current voice session.
- In Animama Desktop, Press to talk is a hold shortcut for the same Voice Mode
  session. It does not start a new mode: when Voice Mode is active and muted,
  holding the configured keyboard shortcut or mouse button calls
  `unmuteVoiceMic()`, and release calls `muteVoiceMic()` only if Press to talk
  was what changed the mic state. Press to talk release flushes any active
  MicVAD speech window before pausing capture, so releasing the shortcut marks
  the end of the utterance instead of discarding buffered speech. Smart-turn
  still runs for that flushed speech window, but with a lower `0.05` threshold
  so Press to talk release strongly biases the turn toward `end_turn`.
- Browser mute stops browser recognition, MicVAD, and the visualizer.
- Offline mute stops MicVAD and the visualizer while preserving the warmed
  engine worker, smart-turn worker, turn id, and text/audio buffers.
- `unmuteVoiceMic()` resumes capture for the same voice turn and reuses the
  smart-turn worker when possible.
- `stopDictation()` fully tears down the active voice session and discards an
  unfinished voice turn. Stopping dictation instead keeps the phrase being
  spoken: it flushes the open MicVAD window and, for offline engines, waits up
  to `OFFLINE_STOP_TRANSCRIPTION_WAIT_MS` (5 s) for windows still being
  transcribed; for browser recognition it calls `stop()` rather than `abort()`,
  accepts that phrase's final result until recognition ends (up to 1.5 s), and
  keeps any words that never finalized. A switch between dictation and Voice
  Mode, and unmount, stop without this flush: the input already holds the
  visible words.
- The silence reset timer is provider-agnostic: if stale transcript or
  smart-turn audio remains after the timeout, it rotates to a new `turnId` and
  removes that spoken turn from the chat input. Text typed before Voice Mode or
  held from an unsent turn stays.

### Offline STT details

Offline STT is local client-side STT, with one worker per engine:

- **Parakeet** (`workers/client-parakeet-worker.ts`) runs `parakeet.js` on the
  CPU set's INT8 encoder and decoder, or with the GPU set's FP16 encoder on
  WebGPU while the INT8 decoder stays on WASM.
- **SenseVoice-Small** (`workers/client-sensevoice-worker.ts`,
  `lib/speech/client-sensevoice/model.ts`) computes an 80-bin Kaldi fbank with
  7×6 frame stacking and CMVN in JavaScript, runs one pass of the CPU set's
  INT8 graph or, on WebGPU, the GPU set's FP32 graph, and decodes greedy CTC
  with inverse text normalization, so numbers come out as digits. It removes
  the model's `<|…|>` tags, joins Chinese and Japanese text without the spaces
  its word marks leave (Korean keeps its spacing), and returns no text for a
  window that decodes to punctuation alone. Prompted with a language, the model
  writes one word for silence or noise (こ, 그, 我), so a final window whose
  word tokens average below 0.4 softmax probability (`MIN_WORD_CONFIDENCE`)
  also returns no text; previews skip that check. Under `zh-Hant` it converts
  the text with OpenCC's Taiwan standard (`opencc-js/cn2t`), whose tables load
  on the first `zh-Hant` window.
- Both workers share `workers/offline-stt-worker-runtime.ts`: the app's bundled
  `onnxruntime-web` (one thread, SIMD), the WebGPU initialization check and one
  serial request queue.
- MicVAD owns speech-window segmentation and stop/start decisions
- accepted MicVAD windows are sent to the worker for final-window transcription
- on the WebGPU backend, open windows are re-decoded for display-only previews
  (see [Live previews](#live-previews))
- the model stays warm for the current app session; mic/VAD/audio resources are
  stopped on every stop

#### Offline startup

`startOfflineDictation(mode)` takes the route chosen at start, sets the active
provider to `parakeet`, enters `dictation` or `voice` mode, and exposes the
preparation/loading state used by the chat mic/voice controls. It then tears
down or reuses VAD/smart-turn state as appropriate before creating or reusing a
local `runId`, `turnId`, and acoustic gate.

Each engine's page-side client is a `createOfflineSttClient` configuration
(`lib/speech/offline-stt/worker-client.ts`; `parakeetSttClient` and
`senseVoiceSttClient`, looked up through `offlineSttClients`). The client loads
its worker with:

- `client.load(apiClient, { preferWebgpu, sampleRateHz: 16000 })`. Here
  `preferWebgpu` is the `speech.stt_parakeet_webgpu` preference, read at each
  start.
- the CPU set's file URLs (`CLIENT_PARAKEET_MODEL_ASSET_PATHS`,
  `CLIENT_SENSEVOICE_MODEL_PATHS`), pinned with the set's capability version
- ORT WASM URLs bundled through Vite `?url` imports: the plain build for WASM,
  and the JSEP build for WebGPU

#### Experimental WebGPU backend

An offline engine's **CPU** and **GPU** tabs in App Settings → **Voice** →
**Speech-to-Text** (labelled "<model> (CPU)" and "<model> (WebGPU ·
Experimental)" in provider lists) both store the `parakeet` provider; the
WebGPU choice enables `speech.stt_parakeet_webgpu`, while the CPU choice
disables it. The flag is off by default and applies to either engine.

When WebGPU is selected, the client probes (`getWebgpuStatus`,
`probeWebgpuModel` in `lib/speech/offline-stt/webgpu.ts`) for two things:

- a WebGPU adapter;
- a `HEAD` response for the GPU set's model file (Parakeet's
  `encoder-model.fp16.onnx`, SenseVoice's FP32 `model.onnx`).

`resolveSpeechBackend` then picks one of these backends:

| Result          | Backend                                                                         | Status line                    |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `available`     | `webgpu`: the GPU set's graph on WebGPU (Parakeet's INT8 decoder stays on WASM) | Available; Active once loaded  |
| `unsupported`   | `wasm`                                                                          | WebGPU not available           |
| `model_missing` | `wasm`                                                                          | GPU speech model not installed |

The GPU add-on in `OfflineSetPanel` installs `parakeet-stt-webgpu` or
`sensevoice-stt-webgpu` independently of provider selection; it never chains a
CPU download or changes the selected provider. No reload is needed: the probe
refreshes when the set settles, and the next dictation or Voice Mode start loads
the GPU graph.

Loading behavior:

- **Switching backend.** ORT keeps one WASM build per worker, so switching
  backend terminates and recreates the worker.
- **Load failure.** The worker checks that ORT actually initialized a WebGPU
  device, because ORT otherwise drops the WebGPU provider silently and runs on
  WASM. If the check fails, or the load throws, the client falls back to WASM
  and the settings panel says WebGPU failed to load and the CPU was used. For
  the rest of the page it uses WASM directly (`load_failed`), until the
  settings panel refreshes the status.
- **Warm-up.** Both workers warm WebGPU with one second of silence during
  load, so shader compilation does not make the first preview look over
  budget.

The build defines `__CLIENT_PARAKEET_MODELS__` and
`__CLIENT_SENSEVOICE_MODELS__` set where each engine's sets are served, and
the Parakeet define's source decides whether downloads are offered
(`OFFLINE_SPEECH_DOWNLOADS_OFFERED`):

| Build                             | Source        | Base URL / GPU base URL                                           |
| --------------------------------- | ------------- | ----------------------------------------------------------------- |
| Packaged desktop, built self-host | `asset-store` | `/onnx/models/<model-id>/`, `/onnx/models/<model-id>-webgpu/`     |
| Vite development                  | `operator`    | `/__client-<engine>-models/`, `/__client-<engine>-webgpu-models/` |

The model IDs are `parakeet-tdt-0.6b-v2` and `sensevoice-small`; the engines
are `parakeet` and `sensevoice`. A `HEAD` probe of the GPU set's model file
decides availability: each source answers 404 until the set is installed. The
GPU file carries the GPU set's own `?v=` version, never the base set's. See
[model setup](../../backend/operations/model-assets.md#optional-parakeet-webgpu-encoder)
and [SenseVoice sets](../../backend/operations/model-assets.md#sensevoice-multilingual-sets).

The worker serializes all requests through a promise queue so load,
transcription, and dispose operations cannot use the model concurrently. If the
same model URLs/backend/sample rate are already loaded, the worker returns
`reused: true` and keeps the warmed model.

After the worker is ready, the offline path starts MicVAD with:

- model `v5`
- `processorType: "AudioWorklet"`
- positive threshold `0.3`
- negative threshold `0.25`
- redemption window `1400ms`
- pre-speech padding `200ms`
- minimum speech `180ms`

Those thresholds live in `useDictation.ts`. They apply to the MicVAD speech
window, not to decoding.

#### MicVAD window lifecycle for offline STT

Offline STT uses the same acoustic gate callbacks as browser STT, but it does
not route Web Speech transcript text through the gate. MicVAD is the source of
truth for when the engine should transcribe.

Window events:

1. `onSpeechStart`
   - opens an acoustic gate window with `openSpeechWindow(...)`
   - publishes a debug `speech_start` event
   - calls `onSpeechWindowStarted(...)` with `turnId` and `windowId`
2. `onSpeechRealStart`
   - marks the active gate window as real speech
   - publishes a debug `speech_real_start` event
   - moves avatar phase to `user_speaking`
3. `onVADMisfire`
   - discards the active gate window
   - calls `onSpeechWindowInvalidated({ reason: "vad_misfire" })`
4. `onSpeechEnd(audio)`
   - closes the gate window with `finishSpeechWindow(...)`
   - if rejected, calls
     `onSpeechWindowInvalidated({ reason: "speech_end_rejected" })`
   - if accepted, calls `onAcceptedSpeechEnd(...)` with the MicVAD audio,
     `turnId`, `windowId`, sample count, and close time

Only accepted windows are transcribed. Rejected windows and VAD misfires are
discarded and do not emit chat input text.

#### Final-window offline path

Offline STT uses final-window transcription:

1. `startOfflineDictation()` loads/reuses the routed engine's worker.
2. It starts MicVAD and a separate visualizer `getUserMedia` stream for the chat
   mic waveform.
3. MicVAD records each speech window and passes the accepted mono `Float32Array`
   to `onAcceptedSpeechEnd(...)`.
4. `onAcceptedSpeechEnd(...)` calls `transcribeOfflineSpeechWindow(...)`.
5. `transcribeOfflineSpeechWindow(...)` sends one `offline_stt/transcribe`
   worker request (`kind: "final"`) containing the complete accepted window and
   the route's language.
6. The worker decodes the window once and returns final text plus timing/metric
   data.
7. `useDictation` ignores stale results by session id, provider, run id, turn
   id, and current dictation state.
8. Non-empty final text is emitted through `onSegment(...)` with the engine as
   `source` (`"parakeet"` or `"sensevoice"`) and `isFinal: true`, which lets
   `ChatInterface` insert it into the chat input. `joinSpeechText`
   (`lib/speech/speech-text.ts`) joins transcript pieces with one space
   between words and none beside Chinese or Japanese text.

In voice mode, the engine commits that final text to the current voice turn
before running smart-turn for the accepted window. This keeps the existing
browser voice-mode auto-submit timeout unchanged: when smart-turn returns
`end_turn`, the committed transcript is already available to the end-turn
coordinator.

This final decode is the only source of committed offline text and of Voice
Mode auto-submission. As with browser interim text, a manual send includes
whatever preview is visible in the input.

#### Live previews

Previews run only when the loaded backend is WebGPU
(`shouldEnableSpeechPreviews`), which the experimental setting enables. The
default single-thread WASM backend is final-only, because a preview there
covered only about 2 s of a window before the decode budget stopped it.

While a MicVAD window is open on WebGPU, `createSpeechPreviewController(...)`
(`lib/speech/offline-stt/preview-controller.ts`) re-decodes the growing window
buffer and shows the result as interim text. Both engines decode the whole
window at once, so previews re-run the whole buffer instead of stitching
chunks.

- MicVAD frames reach the controller through `onVadFrame`. The window buffer
  starts with the same 200 ms pre-speech pad MicVAD prepends.
- The first preview is sent after 600 ms of window audio. Later previews wait
  `max(600 ms, 1.5 × last preview decode)`, and at most one is in flight. The
  controller sends them to the same worker with `kind: "preview"`. Parakeet
  previews are not profiled, which keeps `parakeet.js` console output down.
- A preview in flight delays the final decode that follows it. The controller
  therefore predicts each decode from the measured rate. It stops previewing a
  window once the prediction exceeds 800 ms, and it decodes and keeps at most
  the last 20 s of audio. A window's first preview is not predicted when it is
  sent on time (within about 1.4 s of window audio), which re-measures the rate
  after a slow spell such as a cold first decode. A first preview held back
  while an assistant run is active is predicted like any other. If no rate has
  been measured yet in that capture session, that window gets no previews.
  - Measured on Apple Silicon (Metal) in Electron, Parakeet on WebGPU keeps
    previews within budget for about 15–18 s of window audio (up to the 20 s
    cap in Chrome), and SenseVoice re-decodes a 15 s window in about 0.1 s.
  - `maxPreviewDecodeMs: 0` in `DEFAULT_SPEECH_PREVIEW_CONFIG` disables
    previews. It is an internal constant, not a user setting.
- Previews are display-only. They are published through
  `publishTranscriptPreview(...)` as `interimText` but never written to gate
  state, speech buffers, Smart Turn audio or `onSegment(...)`. Voice Mode
  cannot submit preview text.
- Previews are skipped, and late results dropped, when the window ends or when
  the session, mode, run or turn changes. In Voice Mode they are also skipped
  while an assistant run or its speech is active.
- Muting Voice Mode resets the controller.
  - A plain mute discards the open window, so its preview is cleared.
  - A push-to-talk flush keeps the preview until that window's final replaces
    it.
- A window's preview stays visible until its final result replaces it, or until
  the window is rejected or fails. Preview failures only stop previews for that
  window.
- Worker preview logs use `debug`. Budget stops and preview failures are logged
  at `info` under `OfflineSTT` for either engine.

### Browser recognition details

Recognition configuration:

- `continuous = true`
- `interimResults = true`
- local mode sets `recognition.processLocally = true` when supported

Result collection model:

- Browser result parsing runs in `collectBrowserSpeechSegments(...)`.
- Changed tail is scanned from `event.resultIndex` through `event.results.length - 1`.
- Final and interim segments are separated per event.
- Final text is appended to a per-turn `finalText` buffer.
- Interim text is replaced as a per-turn `interimText` preview buffer (not append-only).

Locale fallback:

- local mode catches `language-not-supported`
- retries once with `en-US`

Session resilience behavior:

- `no-speech` is treated as transient for browser STT:
  - it does not stop dictation/voice mode
  - recognition is restarted on `onend`
- unexpected browser `onend` (when user did not request stop) auto-restarts recognition to keep capture active
- explicit user stop still tears down recognition/VAD/smart-turn as before
- voice mode also supports a temporary pause path (`Mute Mic`):
  - browser recognition, acoustic VAD, and the visualizer stream are paused
  - voice mode remains active
  - current turn/session state is preserved instead of being treated as a full stop
  - interim preview is cleared on mute
  - unmute resumes browser capture for the same voice-mode session
- fatal browser errors (`not-allowed`, `service-not-allowed`, `audio-capture`, unrecoverable language support issues) suppress auto-restart and surface as errors

Voice-mode silence reset behavior:

- Voice mode adds a one-shot silence timeout (`VOICE_SILENCE_RESET_MS`, currently `6000ms`) that applies only when stale buffers exist.
- On timeout, the runtime clears transcript/smart-turn buffers by rotating to a new `turnId` (`silence_timeout_6s`).
- Reset is deferred while a smart-turn inference job is active, then retried after a short delay.
- Reset is also deferred while an end-turn auto-submit is pending.
- The timeout is cancelled on resumed speech (`onSpeechStart` / `onSpeechRealStart`) and does not continually churn during long idle periods.
- `ChatInterface` removes the reset turn's dictated text from the input when this timeout reset fires, keeping UI text aligned with internal buffer resets.

### Acoustic VAD gating

Gate state machine:

- `src/frontend/web/src/lib/voice/acoustic-vad-gate.ts`

VAD runtime:

- `MicVAD.new(...)` from `@ricky0123/vad-web`
- forced `processorType: "AudioWorklet"`
- model `v5`
- assets:
  - base model path `/onnx/models/vad/`
  - ORT wasm base `/onnx/ort/1.24.2/`

Important browser commit rule:

- Browser transcript text is committed only when routed through a real-speech window.
- Text outside active windows or in non-real-speech windows is dropped/tentative.

Late-final transcript grace:

- Web Speech final transcript delivery can lag behind VAD `speech_end`.
- To avoid dropping valid trailing text as `no_active_window`, dictation keeps the most recent accepted real-speech window alive for a short grace period (`LATE_FINAL_TRANSCRIPT_GRACE_MS`, currently `1000ms` in `useDictation.ts`).
- During this grace window, final transcript segments are committed against the just-closed window instead of being ignored.

Window lifecycle:

1. `onSpeechStart`: open window (tentative)
2. `onSpeechRealStart`: mark real speech, promote tentative text
3. `onVADMisfire`: discard window tentative text
4. `onSpeechEnd(audio)`: accept/reject window audio + finalize window

Transcript routing:

- handled by `routeTranscriptSegment(...)`
- decision outcomes:
  - `committed`
  - `tentative`
  - `ignored`

### Interim vs final transcript buffers

Per turn, voice STT keeps:

- `finalText`: authoritative committed text, appended only from final results
- `interimText`: live preview text, replaced on each browser recognition update

Display model:

- Chat input preview is rendered as `finalText + interimText`.
- Interim text is shown as a lighter overlay in `ChatInputTextArea`.
- Offline previews use the same `interimText` display channel but are kept
  outside the per-turn buffers, so fallback submission never uses them.

Interim clearing rules:

- cleared when an update contributes final text and no interim tail remains for that update
- cleared when no VAD window is active for current turn (`no_active_vad_window`)
- cleared when assistant run/TTS is active (`activeRunId` or `activeSpeechRunId`) to avoid self-transcription echo
- cleared on VAD misfire/rejected speech window invalidation and on turn rotation/stop teardown

### Audio stream model

Browser STT has parallel input channels:

- Web Speech internal audio path for transcription
- VAD mic stream managed by `vad-web` for acoustic boundary detection
- optional visualizer `getUserMedia` stream for UI waveform

In muted voice mode:

- browser recognition is paused
- VAD capture is suspended
- the visualizer stream is stopped
- the voice-mode session remains active in UI/runtime state

This is intentional because Web Speech does not expose raw transcript audio for custom processing.

Offline STT uses MicVAD's accepted audio window for transcription and a
separate visualizer stream for the waveform. In muted offline voice mode, MicVAD
and the visualizer are stopped while the active turn, transcript buffer,
smart-turn worker, and warmed engine worker are preserved.

## Voice Mode Semantic VAD (Smart-Turn)

Voice mode extends browser or offline STT with semantic end-of-turn
classification.

Main files:

- `src/frontend/web/src/lib/voice/smart-turn-worker-client.ts`
- `src/frontend/web/src/lib/voice/smart-turn-worker-protocol.ts`
- `src/frontend/web/src/workers/smart-turn-worker.ts`
- `src/frontend/web/src/hooks/useDictation.ts` (job orchestration + decision handling)
- `src/frontend/web/src/hooks/voice/useVoiceEndTurnCoordinator.ts` (pending submit + timeout)
- `src/frontend/web/src/lib/voice/smart-turn-short-utterance-overrides.ts` (short utterance forced `end_turn` phrases)

### Model/runtime contract

Load-time config:

- model: `/onnx/models/smart-turn/smart-turn-v3.2-cpu.onnx`
- ORT wasm base: `/onnx/ort/1.24.2/` (resolved to absolute URL before worker load)

Worker preprocessing:

- requires mono 16kHz audio
- target length: 8s (`128000` samples)
- behavior:
  - truncate from front when longer
  - left-pad zeros when shorter
- applies waveform normalization (mean/std) before feature extraction
- uses the local Whisper-compatible feature extractor implementation in `src/frontend/web/src/lib/voice/smart-turn/local-whisper-feature-extractor.mjs`
- asserts feature shape `[1, 80, 800]`

Inference result:

- probability score
- decision by threshold (`0.2`):
  - `> 0.2` => `end_turn`
  - else => `continue`

Failures: the worker client fails every pending request when the worker
reports `error` or `messageerror`, and bounds each request
(`SMART_TURN_LOAD_TIMEOUT_MS`, 30 s, which also replaces the worker;
`SMART_TURN_PREDICT_TIMEOUT_MS`, 4 s; `SMART_TURN_DISPOSE_TIMEOUT_MS`, 2 s,
after which the worker is terminated). A failed load fails Voice Mode start. A
failed or timed-out prediction ends the turn on the acoustic end of speech
(`source: "acoustic_fallback"`, submitted as `silence_timeout`) so the words are
sent rather than left for the silence reset.

### Rolling audio and supersession behavior

In `useDictation.ts`:

- accepted VAD speech segments append to `smartTurnAudioRef` (rolling turn audio buffer)
- browser STT appends accepted audio immediately at speech end
- offline voice mode transcribes the accepted window first, commits final text,
  then appends the same accepted audio
- semantic check runs once per accepted speech window after that provider has
  updated its turn transcript/audio state
- if a new speech segment arrives before prior result settles:
  - previous job is superseded
  - newest job/result wins by `(jobId, sequence)` guard

Current retention policy:

- keep accumulating voiced audio for the current turn
- worker always truncates/pads to last 8s at inference time
- reset buffer only at turn boundary/reset events (for example after semantic auto-submit turn rotation)

### Auto-submit behavior

When semantic result is `end_turn`:

1. Queue a pending end-turn submit request (`queuePendingVoiceEndTurn`).
2. Immediately try to submit using committed transcript (`submitPendingVoiceEndTurn("smart_turn_decision")`).
3. Hold the submit while the turn is not over or its text is incomplete:
   - real speech in a new window means the owner kept talking: the pending
     submit is dropped, and the next speech end checks the whole turn again
   - a window not yet confirmed as speech holds the submit until MicVAD
     confirms or discards it (`"speech_window_update"`)
   - Web Speech interim text for the turn means the latest phrase's final has
     not arrived; the submit waits for it (`"transcript_update"`, checked after
     each recognition result is stored)
4. If still held at timeout (`SMART_TURN_END_TURN_WAIT_MS`, currently `1000ms`),
   submit the committed transcript (or buffered `finalText` when nothing was
   committed) followed by any unfinalized interim text.
5. If transcript and callback are present, invoke `onVoiceAutoSubmit(...)`.
6. `ChatInterface` sends the input's typed or held text followed by the spoken
   text through `handleSubmitText(...)` with:
   - `inputMode: "voice"`
   - `submitReason: "semantic_end_turn"`, or `"silence_timeout"` for an
     acoustic fallback
   - `turnId`, `smartTurnJobId`, `smartTurnScore`, `smartTurnLatencyMs`

   `handleSubmitText` resolves `false` when the message is not accepted (a
   reply is still streaming, the chat cannot send yet, or attachments the
   Anima cannot read yet hold it, with a notice); the text then stays in the
   input and joins the next voice turn or a manual send.
7. rotate to a new `turnId` and reset per-turn smart-turn state

If no transcript/callback exists:

- logs + debug event `auto_submit_skipped`
- returns to listening phase without dispatch

Provider timing:

- Browser STT may run smart-turn before final browser text has arrived, so the
  pending submit usually waits for the final or uses the timeout fallback.
- Offline STT commits final text before running smart-turn for the accepted
  window, so `smart_turn_decision` usually submits immediately when the
  semantic decision is `end_turn`.
- If the offline engine returns empty text (silence, noise or punctuation
  alone), smart-turn can still produce `end_turn`, but
  the coordinator skips auto-submit after the normal timeout rather than
  submitting an empty message.

### Short utterance override behavior

To reduce false `continue` decisions on short utterances:

- if smart-turn model returns `continue`
- and voiced turn audio is short (`< 2000ms`)
- and current turn text (normalized) matches `SMART_TURN_FORCE_END_TURN_SHORT_UTTERANCE_SET`

then effective decision is forced to `end_turn`.

The list holds English, Japanese, Korean and Chinese (Simplified, Traditional
and Cantonese) replies, such as はい, 네, 好的 and 唔該; it also holds 系, the
character SenseVoice writes for Cantonese 係. `normalizeSmartTurnOverrideText`
normalizes both sides once: NFKC, lowercase, punctuation and symbols other than
apostrophes removed in any script, whitespace collapsed. Words that also open a longer turn while the
speaker thinks are left out (嗯, 어, ええ, そうだね, そうですね, 아니).

Matching source priority:

1. current turn buffered `finalText`
2. current turn buffered `interimText`

For browser STT, the match can come from final or interim recognition text. For
offline STT, the match comes from final text only, because previews are
display-only and never enter the per-turn buffers.

## Chat and Avatar Runtime Integration

### Chat input integration

`src/frontend/web/src/ui/main/chat/ChatInterface.tsx`:

- tracks three dictation buffers:
  - `dictationBaseRef` (user-typed base text)
  - `dictationCommittedRef` (final dictation text)
  - `dictationInterimRef` (live interim dictation preview)
- merges display text as `base + (committed + interim)`
- updates interim preview from `onTranscriptPreview` (browser STT buffer updates
  and offline previews)
- starts:
  - `startDictation("dictation")`
  - `startDictation("voice")`
- switches from active dictation into voice mode with `switchMode("voice")`
- toggles voice capture pause/resume with:
  - `muteVoiceMic()`
  - `unmuteVoiceMic()`
- handles smart-turn auto-submit callback
- clears input + dictation buffers on voice silence reset callback
- drives avatar listening capture from `isMicCaptureActive`, so muted voice mode does not count as active listening

`src/frontend/web/src/ui/components/chat-input.tsx`:

- `ChatInputTextArea` accepts `interimSuffix`
- when suffix is present, textarea text is rendered via overlay spans:
  - committed/base portion in normal foreground
  - interim suffix in lighter muted color
- underlying textarea text is made transparent with normal caret to keep typing/editing behavior intact
- composer button state is mode-specific:
  - idle:
    - mic button starts dictation
    - voice button starts voice mode
  - dictation active:
    - mic button becomes `Stop dictation`
    - voice button keeps voice-mode affordance and switches to voice mode when clicked
  - voice active:
    - voice button becomes `Stop voice mode`
    - mic-side button becomes `Mute Mic` / `Unmute Mic`

`src/frontend/web/src/ui/main/chat/useChatSession.ts`:

- `submitMessage(...)` accepts voice metadata args
- metadata currently used for logging/telemetry; chat request payload remains standard text payload

### Avatar interaction phases

Canonical runtime phase:

- `interactionPhase` in `src/frontend/web/src/stores/avatar-runtime-store.ts`

Voice-related phases:

- `listening`
- `user_speaking`
- `semantic_check`
- `submitting`

Run/TTS phases:

- `thinking`
- `talking`
- `idle`
- `user_typing` is text-input driven, not voice driven, but shares the same
  runtime phase field.

Animation state mapping:

- in `src/frontend/web/src/lib/avatar/planner/AvatarPlanner.ts`
- mapping summary:
  - `talking` -> talking animation loop
  - `thinking`/`submitting` -> thinking loop
  - `listening`/`user_speaking`/`semantic_check` -> listening loop
  - `user_typing` -> idle animation loop with listening-style procedural policy
  - default -> idle

## Debug Surface and Logging

### Voice debug store

Store:

- `src/frontend/web/src/stores/voice-vad-debug-store.ts`

Tracks:

- acoustic VAD session status/errors/provider/turn/window
- transcript char counters (committed/tentative)
- rolling accepted audio samples + latest frame probs
- VAD event history
- gate decision history
- smart-turn enablement, worker/job status, buffered samples, superseded count
- smart-turn decision/event history

### AnimaDebugPanel

UI section:

- `Voice / Acoustic VAD` in `src/frontend/web/src/ui/debug/AnimaDebugPanel.tsx`

Shows:

- VAD status + context
- smart-turn status + errors + active job + buffer + latest decision
- recent VAD events, gate decisions, and smart-turn events

### Logger categories

Common categories you will see:

- STT/voice: `Dictation`, `BrowserSTT`, `OfflineSTT`, `VADInit`, `VADLifecycle`, `VADEvent`, `VADGate`
- offline workers: `ClientParakeetWorker`, `ClientSenseVoiceWorker` (each final window's `wordConfidence` for SenseVoice)
- smart-turn: `SmartTurnWorker`, `SmartTurnWorkerClient`, `SmartTurnJob`, `SmartTurnDecision`, `SmartTurnSubmit`, `SmartTurnAudio`
- chat integration: `ChatInterface` (`Submit`, `Dispatch`, `TTS`, etc.)
- pocket runtime: `PocketTTSRuntime`, `TTSPlayback`

## TTS Runtime (Focus: Pocket TTS)

Primary orchestration:

- `src/frontend/web/src/hooks/useTtsPlayback.ts`

Pocket runtime bridge:

- `src/frontend/web/src/hooks/usePocketTtsRuntime.ts`

Pocket core:

- `src/frontend/web/src/lib/speech/pocket/createPocketTTS.ts`
- `src/frontend/web/src/lib/speech/pocket/core/PocketTTSCore.js`

### Provider selection

Source of truth:

- merged settings from `SettingsProvider`
- provider parsing/capability checks in `src/frontend/web/src/lib/speech/tts-provider.ts`

Provider ids:

- `browser`
- `pocket_tts`
- `elevenlabs`
- `gemini` (only when runtime capabilities report `gemini_tts`; never chosen
  automatically)

### TTS run lifecycle

`useChatSession.ts` drives:

1. `startRun(runId)` at dispatch start
2. `appendToken(runId, token)` on SSE token
3. `completeRun(runId)` on SSE complete
4. `cancelAll()` on stop/error/route cleanup

### Chunking behavior

Chunk helpers:

- `src/frontend/web/src/lib/speech/tts-chunker.ts`

Behavior:

- A chunk ends at `.`, `!`, `?`, `;` or a newline, or at Japanese and Chinese
  `。！？`, with any following marks (`?!`, `！？`, `...`) and closing quotes or
  brackets, once at least 24 characters are buffered. A mark directly followed
  by a letter or digit ("$5.99", "animama.ai") ends nothing. Longer text splits near
  140 characters, and 700 ms without new text flushes at least 36 characters.
  No split lands inside an audio tag: a split backs off to before the tag, and
  an idle flush waits for a tag that is still being written.
- Only ElevenLabs streams chunks while tokens arrive.
- Browser and Pocket TTS are non-streaming at token phase
  (`shouldStreamChunksForProvider` returns `false` for them), then emit final
  chunks on completion.
- Gemini is forced non-streaming in the frontend token pipeline because
  backend-pushed `tts.audio` frames carry the finalized audio for structured
  speech batches

### Browser TTS

Mechanics:

- `SpeechSynthesisUtterance` queue
- speaks the reply without emoji or audio tags (`stripAudioTags`), which it
  would read aloud
- emits `onAudioStarted` on utterance start
- emits `onAudioEnded` only after run complete + queue drained
- robust cancellation via `speechSynthesis.cancel()`

### ElevenLabs TTS

Realtime Eleven v4 Turbo receives an SSE-provided single-use token and opens a
direct Text to Dialogue WebSocket ([protocol](elevenlabs-tts.md#realtime-model)).
Setup waits at most 1500 ms for the session event, counted from the response's
first event rather than from send, so a turn the server holds before its stream
starts keeps its voice. Failures stop audio for that run while chat continues.

A hosted server can decline a run's ElevenLabs speech with
`speech_allowance_exhausted` (an exhausted voice allowance). Where Pocket TTS is
supported, `fallBackToPocketTts` then speaks that run as a Pocket run, with the
same voice resolution and no notice, and later runs return to ElevenLabs. See the
[hosted contract](../../../contracts/hosted-web.md#realtime-speech-session-descriptor).

See [ElevenLabs TTS](elevenlabs-tts.md) for session setup, the socket protocol,
settings and playback timing. The [chat contract](chat.md#main-structured-response-mode)
separates speakable `speech` from visible-only `display`; raw JSON and hidden
emotion metadata are never spoken. [Lip-sync](avatar-lipsync.md) plans the
mouth from the played audio and the spoken text.

### Gemini TTS

Gemini audio always arrives as backend-pushed `tts.audio` frames, one Gemini
request per sentence, and plays through the finalized server-audio runtime.
A `tts.error` ends that reply's speech with the "Text-to-speech unavailable"
notice; there is no Pocket fallback. See [Gemini TTS](gemini-tts.md) for
availability, the key, settings, error codes and Google's terms.

### Pocket TTS (detailed)

Runtime setup:

- `createPocketTTS()` uses:
  - `assetBaseUrl: "/tts"`
  - `playbackStrategy: "adaptive"`
  - `enableVoiceCloning: true`

Core initialization loads:

- audio worklet + playback pipeline
- worker runtime
- Pocket model assets (`/onnx/models/pocket-tts/*`)
- ORT runtime (`/onnx/ort/1.24.2/*`)

Generation path:

- `generateAndWait(text, { preservePlayback, endStream, voice, animaId, animaVoiceKey, signal })`
- queued sequentially in `useTtsPlayback` with abort support
- the text Pocket speaks is `pocketSpeechText(text)`
  (`src/lib/speech/pocket-speech-text.ts`): English numbers, symbols and
  abbreviations spelled out ("$5.99" as "five dollars ninety-nine cents"), and
  vocal tags and emoji left out, since Pocket cannot perform them. A chunk with
  nothing left to say is dropped before it is queued, so the stream ends on the
  last chunk Pocket speaks.

End-of-stream handling:

- explicit stream-end flags are tracked (`pocketStreamOpenRef`, `pocketStreamNeedsExplicitEndRef`)
- if needed, `endPocketStream()` is called to force deterministic playback completion

Playback event bridge:

- `playback_started` => avatar speech start and the lip-sync audio clock
- `generation_finished` => audio duration, which also ends the run's lip-sync
  audio
- `playback_ended` => playback end signal and eventual audio-ended completion

Voice resolution:

- helper: `src/frontend/web/src/lib/speech/pocket/voice-preferences.ts`
- anima/emotion helper: `src/frontend/web/src/lib/speech/pocket/anima-voice-selection.ts`
- selection happens once at `completeRun(runId)`, using the latest dominant avatar emotion from `avatar-runtime-store`
- anima voice keys normalize to:
  - `neutral`
  - `{emotion}_{1|2|3}` for non-neutral emotions
- anima catalog path:
  - `/onnx/models/pocket-tts/animas/{animaId}_voices.bin`
- anima catalog format:
  - multiple named embeddings in one binary file
  - each embedding is stored as `[1, numFrames, 1024]`
  - embeddings must come from the current (`english_2026-04`) encoder; the worker
    prepends the checkpoint's BOS row before conditioning, as for cloned voices
- fallback order:
  1. exact anima emotion key
  2. same emotion with lower intensity, descending
  3. anima `neutral`
  4. legacy Pocket voice preference path
  5. the app's fallback voice: the saved voice when it is built in, otherwise
     the default (`DEFAULT_POCKET_VOICE`, `eve`)
- legacy Pocket voice preference path still uses:
  1. anima override `tts_pocket_anima_voice`
  2. user default `tts_pocket_voice`
- custom voice token `custom` is still supported in the legacy path when a custom voice embedding exists
- a saved voice that is not built in (for example a removed voice) falls back to
  the default voice; the "Pocket voice unavailable" notice shows once per app
  session (`resolvePocketFallbackVoice` in `voice-preferences.ts`)
- custom/cloned voices remain in-memory only; cloning does not create a anima `{animaId}_voices.bin`

## Assets and Configuration Checklist

### STT/VAD/smart-turn assets

The runtime inventory is `models/browser-runtime/manifest.json`; the following
are application URLs, not tracked model files under `web/public`:

- VAD model: `/onnx/models/vad/silero_vad_v5.onnx`
- VAD worklet: `/onnx/models/vad/vad.worklet.bundle.min.js`
- Pocket's ORT modules and all sidecars: `/onnx/ort/1.24.2/*`
- Smart Turn: `/onnx/models/smart-turn/smart-turn-v3.2-cpu.onnx`

These files ship with the app; nothing downloads them from the internet. Their
URLs are unversioned, so every load revalidates them by their manifest SHA-256
`ETag` and an unchanged file returns `304` (see
[Frontend overview](../architecture/overview.md)).

VAD and Smart Turn workers also retain their Vite-bundled ORT imports. Resolving
the public ORT 1.24.2 inventory does not replace those dependency versions.

### Pocket TTS assets

- Small worker/worklet/vendor code stays in `src/frontend/web/public/tts/*`.
- The nine reviewed Pocket core files are served at `/onnx/models/pocket-tts/*` from
  the verified sources:
  - the four generation ONNX graphs;
  - `tokenizer.model`, `bundle.json` and `bos_before_voice.npy`;
  - Eve, Azelma and Michael's core voice states at `voices/<id>.safetensors`.
- `src/frontend/web/src/lib/speech/pocket/voice-catalog.ts` lists all 38
  voices, with `eve` as default. Each has an ID, display name, gender, accent,
  recommended flag and delivery: `core`, or `download` with its asset ID and
  size. `scripts/voices/voices.py release` generates it, and tests keep it
  equal to the core manifest and the packaged asset catalog. The 36
  downloadable voices install through `/v1/model-assets`.
- `createPocketTTS` sends the catalog's IDs and default to the worker. The
  worker initializes model state from the `bundle.json` state manifests.
  - Built-in voices are precomputed flow LM states, so selecting one skips
    voice conditioning.
  - Only the default state loads at startup. Others load on first use, and at
    most four more compact states stay cached.
  - It generates with temperature 0.3.
- Anima Behavior → Voices shows the selected provider's controls, including while
  speech is disabled. Its TTS Provider selector saves
  `speech.tts_provider` for that Anima without changing the application enable
  flag or either voice. Animas without an override inherit the application provider,
  shown with an `(app)` suffix; inherited Browser TTS remains visible until the
  user selects PocketTTS, ElevenLabs or, where offered, Gemini. Loadout is
  outside the chat route, so the saved provider applies when returning to
  chat. Switching providers preserves the hidden provider's configuration.
  Provider credentials and model
  configuration remain in application settings. The Pocket list supports name/accent
  search, Any/Female/Male filtering and Recommended only. Choosing a voice saves
  an explicit Anima value; legacy missing values keep their existing fallback.
- Each catalog voice has a pinned upstream source recording. Play buttons beside
  the selected voice and inside the list share one player. Each button
  fetches that recording only on click, without credentials or referrer, and
  never installs or selects a voice. Samples require internet and can differ
  from generated speech. Opening or closing the list, changing the selected voice,
  replacing a sample, or leaving Voices stops audio.
  The separate download button installs a voice without changing the selection.
- Voice Cloning saves multiple named voices in the shared Local Voice library.
  A WAV, MP3 or Ogg recording (up to 25 MiB) is retained with its encoded Pocket
  catalog. The browser encoder uses the first ten seconds; encoding runs locally.
  Clone voice adds the clone to the library without selecting it. An optional
  name defaults to the recording filename without its extension. Clones appear
  in the Pocket voice picker with original-recording preview and delete controls.
  Clones imported with an Anima contain only the encoded voice; they remain
  selectable for speech, while original-recording Play is disabled and labeled
  unavailable. Deletion is blocked while any Anima uses the clone.
  Existing session-only `custom` selections cannot be recovered automatically:
  upload the original again and save a named clone to make it durable.
- The 39,768,446-byte Mimi cloning encoder is optional. The first cloning action
  offers an explicit download with progress and retry (its attribution ships
  in the installed set's `ATTRIBUTION.md`, not in the UI). The
  selected File stays in memory while waiting, then the same sample is encoded
  once verified. Closing the dialog detaches its waiter and prevents a later save;
  it does not cancel a download another caller may need. Explicit Cancel stops
  the shared download. All encoding entry points recheck
  `/v1/model-assets/pocket-tts-voice-cloning-encoder/content`; removing the asset
  requires another download before encoding. Playback of presets and saved clones
  never needs the encoder.
- Clone selection uses the Anima's voice loadout binding. Chat prepares and
  verifies the selected catalog bytes during runtime mount and supplies the
  mount-owned resource to PocketTTS. Original samples stay in the library and
  are fetched only for preview or editing. Selecting a preset removes the clone
  binding; changing the TTS provider preserves it. A missing or invalid equipped
  clone reports an error instead of silently using another voice.
- Downloadable voices install through `/v1/model-assets`
  (`usePocketVoiceDownloads`, `voice-downloads.ts`) on desktop and self-host.
  - Picking one saves the preference and starts the install; the worker loads
    the state from `/v1/model-assets/pocket-voice-<id>/content` once
    installed.
  - Until then, replies use the default voice. A saved voice that is not
    installed starts its install on the next reply.
  - A failed download shows one notice per session, and the next reply or pick
    retries it.
  - Once downloads have ended (`downloadsEnded` from the model-asset list), a
    voice that is not installed shows as not available and cannot be picked;
    a reply that would have installed it speaks with the default voice and
    shows one notice per session. Without an installed encoder, cloning says
    it can no longer be downloaded instead of offering the encoder.
- Anima voice selection keeps a compact picker with search, All/Female/Male tabs,
  Recommended only and Custom filters, previews and inline download/retry/cancel
  actions. Custom shows saved clones and uploaded voices; preset filters pause
  until it is unchecked because custom voices have no gender/recommendation
  metadata. Checkmarks in the download slot identify included or downloaded
  presets, separately from the selected voice. Downloading alone changes neither
  selection nor provider. Setup and App Settings do not contain a preset browser.
  App Settings → Voice → Text-to-Speech uses provider tabs ("PocketTTS
  (built-in)", ElevenLabs, Gemini and the browser where offered); selecting one
  switches the provider, the provider in use is tagged "Selected", and its tab
  holds that provider's settings: the PocketTTS tab reuses the Anima cloning
  form with the encoder's state under a "Voice Clone" heading and lists the
  saved clones (`SavedVoiceClones`), each with **Use for** the Anima the
  settings were opened from when that Anima speaks with PocketTTS (the choice
  applies from the next chat mount, like any loadout change); the ElevenLabs
  tab holds its key, the Gemini tab its key and model. There is no chunk-streaming
  switch: ElevenLabs always streams. Setup offers
  Speech-to-Text and Text-to-Speech choices but no voice cloning.
- Anima voice catalogs are separate user/catalog inputs; their persisted URLs
  and legacy `/onnx/models/pocket-tts/animas/{animaId}_voices.bin` reference format
  are not members of the 22-file engine inventory.

Optional operator voice catalogs are separate from the engine inventory; see
[Content and workers](../architecture/content-and-workers.md#vite-application-resources).

From `src/frontend`, run `pnpm verify:tts-assets` for source inputs or
`pnpm verify:tts-assets -- --built-root web/dist` for a built application. Both
verify the complete engine inventory and required small TTS runtime files.

## Known Constraints and Troubleshooting

1. Smart-turn worker load fails with invalid ORT wasm URL:

- Ensure worker receives absolute URLs for model and ORT base.
- This is handled in:
  - `src/frontend/web/src/hooks/useDictation.ts` (voice start path)
  - `src/frontend/web/src/lib/voice/smart-turn-worker-client.ts` (normalization + trailing slash)

2. STT starts but VAD fails immediately:

- AudioWorklet support is required for acoustic VAD in browser and offline
  STT paths.

3. Browser local STT fails on locale:

- Local mode retries once with `en-US` after `language-not-supported`.

4. Pocket TTS unsupported:

- Requires secure context (`https` or localhost), Worker, and AudioWorklet support.

5. ElevenLabs TTS unsupported:

- Requires secure context (`https` or localhost), `WebSocket`, `AudioContext`, and `AudioWorklet`.
- If the active anima lacks a usable ElevenLabs voice profile, the realtime
  session setup fails with a `tts.session.error` frame carrying
  `status_code: 409`, and only audio is skipped.
- If ElevenLabs is not configured server-side, the frame carries
  `status_code: 503`.

6. No auto-submit in voice mode:

- Check smart-turn status/events in debug panel.
- If decision is `continue`, this is expected.
- If decision is `end_turn`, check `SmartTurnSubmit` logs for:
  - immediate attempt trigger (`smart_turn_decision`)
  - transcript-update trigger (`transcript_update`)
  - timeout trigger (`timeout`)
- `auto_submit_skipped` after timeout means committed/final/interim text was unavailable or callback was missing.

7. Frequent `no_active_window` gate decisions while tuning VAD:

- Usually indicates VAD windows are closing faster than browser STT emits final transcript.
- Mitigations:
  - increase `redemptionMs` and/or `minSpeechMs`
  - use less aggressive thresholds
  - rely on late-final transcript grace to bridge modest timing mismatch

8. Voice-mode transcript/audio clears after 6s silence:

- This is expected when stale voice buffers exist and no new speech arrives.
- Behavior is voice-mode-only and implemented as a one-shot reset/turn rotation, not repeated stop/start churn.

9. TTS output appears in browser interim transcript preview:

- Browser STT result processing ignores transcript updates while assistant run/TTS is active (`activeRunId` or `activeSpeechRunId`).
- In that state, interim preview is explicitly cleared to avoid self-transcription echo.

10. Offline dictation says "Install offline speech recognition for this language":

- The UI Locale routes to SenseVoice, and its CPU set is not available: not
  installed, or turned off with `ANIMAMA_SENSEVOICE_STT_ENABLED=false`.
- In a build that offers downloads, install it in App Settings → Voice. Once
  downloads have ended the message says the model can no longer be downloaded
  instead. On a Vite development stack, acquire it on the host and rerun
  `reset.sh`. The app never substitutes a browser recognizer for that
  language.

## Implementation File Map

### STT + voice mode

- Provider helpers: `src/frontend/web/src/lib/speech/stt-provider.ts`
- Dictation/voice orchestrator: `src/frontend/web/src/hooks/useDictation.ts`
- Browser STT runtime helpers: `src/frontend/web/src/hooks/voice/browser-recognition-runtime.ts`
- MicVAD runtime helpers: `src/frontend/web/src/hooks/voice/mic-vad-runtime.ts`
- Offline engine routing: `src/frontend/web/src/lib/speech/offline-stt/routing.ts`
- Offline STT client, protocol, leases, WebGPU selection and previews:
  `src/frontend/web/src/lib/speech/offline-stt/` (`worker-client.ts`,
  `worker-protocol.ts`, `clients.ts`, `asset-ids.ts`, `lease.ts`, `webgpu.ts`,
  `preview-controller.ts`)
- Engine configurations: `src/frontend/web/src/lib/speech/client-parakeet/`,
  `src/frontend/web/src/lib/speech/client-sensevoice/` (`model.ts`,
  `kaldi-fbank.ts`, `script.ts`)
- Offline STT workers: `src/frontend/web/src/workers/client-parakeet-worker.ts`,
  `src/frontend/web/src/workers/client-sensevoice-worker.ts` and their shared
  `src/frontend/web/src/workers/offline-stt-worker-runtime.ts`
- Transcript joining: `src/frontend/web/src/lib/speech/speech-text.ts`
- Speech downloads and language notice:
  `src/frontend/web/src/ui/settings/OfflineSpeechDownloads.tsx`,
  `src/frontend/web/src/app/local-runtime/setup/SetupSpeechDownloads.tsx`,
  `src/frontend/web/src/ui/settings/SpeechLanguageNotice.tsx`
- Voice end-turn coordinator: `src/frontend/web/src/hooks/voice/useVoiceEndTurnCoordinator.ts`
- Acoustic gate state machine: `src/frontend/web/src/lib/voice/acoustic-vad-gate.ts`
- Smart-turn protocol/client: `src/frontend/web/src/lib/voice/smart-turn-worker-protocol.ts`, `src/frontend/web/src/lib/voice/smart-turn-worker-client.ts`
- Smart-turn worker: `src/frontend/web/src/workers/smart-turn-worker.ts`
- Smart-turn short utterance overrides: `src/frontend/web/src/lib/voice/smart-turn-short-utterance-overrides.ts`
- Voice runtime types: `src/frontend/web/src/lib/types/voice-types.ts`

### Chat integration

- Chat input UI integration: `src/frontend/web/src/ui/main/chat/ChatInterface.tsx`
- Chat input interim overlay rendering: `src/frontend/web/src/ui/components/chat-input.tsx`
- Chat SSE + TTS bridge: `src/frontend/web/src/ui/main/chat/useChatSession.ts`
- Avatar runtime phase store: `src/frontend/web/src/stores/avatar-runtime-store.ts`
- Animation phase policy: `src/frontend/web/src/lib/avatar/planner/AvatarPlanner.ts`;
  `src/frontend/web/src/lib/avatar/Avatar.ts` executes its actions. See
  [Avatar Planner](avatar-planner.md).

### TTS

- TTS orchestrator: `src/frontend/web/src/hooks/useTtsPlayback.ts`
- ElevenLabs runtime hook: `src/frontend/web/src/hooks/useElevenLabsTtsRuntime.ts`
- Finalized server-audio runtime (Gemini): `src/frontend/web/src/hooks/useFinalizedTtsRuntime.ts`
- Chat TTS options for every voice: `src/frontend/web/src/lib/chat/chat-tts-dispatch.ts`
- Gemini dispatch options: `src/frontend/web/src/lib/chat/gemini-chat-tts-dispatch.ts`
- Pocket runtime hook: `src/frontend/web/src/hooks/usePocketTtsRuntime.ts`
- TTS provider helpers: `src/frontend/web/src/lib/speech/tts-provider.ts`
- Shared speech PCM player: `src/frontend/web/src/lib/speech/audio/PCMPlayerWorklet.js`
- Pocket core factory: `src/frontend/web/src/lib/speech/pocket/createPocketTTS.ts`
- Pocket core engine: `src/frontend/web/src/lib/speech/pocket/core/PocketTTSCore.js`
- Pocket voice preference logic: `src/frontend/web/src/lib/speech/pocket/voice-preferences.ts`
- Pocket anima/emotion voice selection: `src/frontend/web/src/lib/speech/pocket/anima-voice-selection.ts`

### Debug surfaces

- Voice debug store: `src/frontend/web/src/stores/voice-vad-debug-store.ts`
- Anima debug panel: `src/frontend/web/src/ui/debug/AnimaDebugPanel.tsx`
