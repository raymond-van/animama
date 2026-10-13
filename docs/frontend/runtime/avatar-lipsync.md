# Avatar Lip-Sync Pipeline (`src/frontend/web`)

The lip-sync pipeline turns SSE phonemes into audio-clocked VRM vowel expressions.
It shares timing with [Voice](voice.md) and the [Avatar runtime](avatar-animation.md).

## 1) High-level architecture

Lip-sync is implemented as a layered pipeline:

1. **SSE speech payload ingestion**
   - `src/frontend/web/src/query/mutations/useChatSse.ts`
   - consumes `tokenized_text`/`phonemized_text` from `run.completed` for
     normal TTS-capable runs, and `tts_text`/`tts_phonemized_text` from
     main-structured `speech` parts for ElevenLabs and Gemini runs

2. **Phoneme -> viseme planner**
   - `src/frontend/web/src/lib/speech/gruut-viseme-keyframes.ts`
   - converts gruut phonemes into 60 FPS `A/E/I/O/U` keyframes

3. **Chat/TTS integration**
   - `src/frontend/web/src/ui/main/chat/useChatSession.ts`
   - coordinates SSE completion, TTS playback callbacks, and avatar bridge state

4. **Avatar lip-sync bridge (timing + gating)**
   - `src/frontend/web/src/stores/avatar-lipsync-bridge-store.ts`
   - queues segments, waits for speech playback start + avatar talking state, handles actual-duration recompute

5. **Avatar lip-sync segment conversion**
   - `src/frontend/web/src/lib/avatar/vowelVisemeSegment.ts`
   - converts viseme plan keyframes into avatar runtime `vowel5` segment/frame payloads

6. **Avatar runtime playback**
   - `src/frontend/web/src/lib/avatar/ExpressionController.ts`
   - samples lip-sync frames by `AudioContext.currentTime` and applies VRM expressions

## 2) SSE payload -> viseme plan

### Source data from SSE

`useChatSse` receives the final assistant payload and may include:

- `tokenized_text` (normalized spoken text)
- `phonemized_text` (gruut phonemes, `string[][]`)

For main-structured TTS speech parts, the backend can also emit:

- `tts_text` (gruut `text_with_ws`, used as the exact synthesis text for English)
- `tts_phonemized_text` (gruut phonemes for that same `tts_text`)
- `tts_text_basis: "gruut_text_with_ws"`

Speech with letters outside ASCII (other languages, or English with an accented
loanword), or any speech when gruut is unavailable, carries no `tts_*` fields:
the provider speaks the visible text, and lip-sync falls back to the visible
text's `phonemized_text`. That is empty for Japanese, Korean and Chinese,
so the mouth does not move for them yet.

Non-TTS chat streams may still include `tokenized_text` and `phonemized_text`
on structured `speech` events, but they do not emit `tts_*` speech fields and
`useChatSession` does not queue the lip-sync bridge when TTS is disabled.

File:

- `src/frontend/web/src/query/mutations/useChatSse.ts`

When phonemes are present, `useChatSession` queues raw viseme inputs into the
bridge. For structured speech streaming, every speech segment that is actually
sent to TTS also appends its matching gruut phonemes into the run-level raw
viseme input. The worker builds or rebuilds the actual viseme plan:

- `buildGruutVisemeKeyframes({ tokenizedText, phonemizedText })`

For ElevenLabs (Eleven v4 Turbo) and Gemini speech, `useChatSession` prefers
`tts_text` and `tts_phonemized_text` so the TTS request and gruut phonemes share
the same gruut `text_with_ws` basis. Empty final markers and complete
corrections that were not re-sent to TTS do not append duplicate viseme input.

## 3) Phoneme -> vowel viseme keyframe generation

File:

- `src/frontend/web/src/lib/speech/gruut-viseme-keyframes.ts`

### Output

The planner returns `GruutVisemeKeyframePlan`:

- `fps` (currently 60)
- `durationSec`, `durationMs`
- `frameCount`
- `keyframes[]` of:
  - `frameIndex`
  - `timeSec`
  - `A`, `E`, `I`, `O`, `U` in `[0,1]`
- diagnostics/features (alignment status, punctuation counts, neutral frame ratio, etc.)

### Timing model (estimated path)

The planner estimates duration from:

- phoneme classes (vowels, consonants, diphthongs, etc.)
- stress/length markers
- punctuation pauses from `tokenized_text`

Then it builds coarticulated phoneme events and samples them at 60 FPS.

### Actual-duration recompute support

The planner also supports a duration override:

- `targetDurationSec`

When provided, it recomputes the full viseme timeline from raw phoneme/text inputs and applies a **global timing scale** ("scale all") so the resulting plan duration matches the actual Pocket TTS duration.

This means actual-duration correction is not a simple frame stretch at the end of the pipeline; the planner is rerun from phoneme timing inputs.

### Finalized server audio path (Gemini)

Gemini uses finalized-text `chat:sse` audio events instead of a realtime
websocket. When main-structured SSE speech includes `tts_text` with
`tts_text_basis: "gruut_text_with_ws"`, the backend sends that prepared text to
the provider and the frontend uses the matching `tts_phonemized_text` for
avatar planning.

ElevenLabs returns character timing on the realtime socket. The bridge keeps it
per run as evidence (`providerSpeechTimingByRun`; see
[ElevenLabs TTS](elevenlabs-tts.md#provider-character-timing)), but the planner
does not read it yet. It still estimates phoneme timing from gruut and can
recompute the whole segment against the actual played audio duration when that
duration is known.

`lib/speech/speech-timing-evidence.ts` turns a run's timing into evidence for a
planner that uses it (#468):

- **Words:** runs of letters, digits and inner apostrophes. Han, kana and Hangul
  characters each keep their own window.
- **Punctuation:** runs of punctuation or symbols, each a possible pause.
- **Audio tags:** bracketed spans, never words, with each comma-separated
  direction classified by a small keyword table:
  - `nonverbal` (a laugh, sigh or gasp): a non-speech interval;
  - `sound_effect`: an interval with the mouth at rest;
  - `pacing` (a pause): a silent interval;
  - `delivery` (emotion, delivery and unknown directions): a zero-width marker at
    the span's start for the words after it.

The evidence reports provider times unchanged. Treat word ends that run into the
following pause, and tag spans shorter than their effect (`[pause]` covers about
60 ms; the pause falls on the punctuation before it), as hints. Pass
`complete: true` once a run's audio has ended, so an unclosed bracket reads as
punctuation instead of waiting for its tag to close.

## 4) `useChatSession` integration

File:

- `src/frontend/web/src/ui/main/chat/useChatSession.ts`

`useChatSession` is the integration point between:

- SSE completion (`useChatSse`)
- TTS playback lifecycle (`useTtsPlayback`)
- avatar runtime state (`useAvatarRuntimeStore`)
- lip-sync bridge (`useAvatarLipSyncBridgeStore`)

### On SSE `run_completed`

If `artifacts.visemePlan` exists, `useChatSession` queues it into the bridge and also passes the raw viseme inputs:

- `phonemizedText: data.phonemized_text`
- `tokenizedText: data.tokenized_text`

### TTS callbacks used for lip-sync

`useChatSession` registers these callbacks with `useTtsPlayback`:

- `onAudioStarted` -> marks avatar speech start and forwards the speech audio anchor (`audioStartSec`, `audioContext`)
- `onAudioDurationResolved` -> forwards resolved speech duration for viseme recompute
- `onPlaybackEndedSignal` -> hard-stops avatar lip-sync immediately on raw speech playback end
- `onAudioEnded` -> normal chat/avatar cleanup (also clears lip-sync)
- `onChunksQueued` -> records the chunks sent to speech (`speechChunksByRun`)
- `onSpeechTiming` -> appends ElevenLabs character timing
  (`providerSpeechTimingByRun`), evidence the planner does not read yet

The same audio start and duration entries are also used by the avatar frame
loop to build a provider-agnostic procedural speech timing context for speech
layers such as talking hands. The viseme worker also derives a speech gesture
timeline from the same phoneme units: primary `ˈ` stress markers attach to the
next vowel/diphthong nucleus and become the talking-hands beat timeline. The
same timeline includes word timing ranges so talking hands can map live TTS
sentence chunks onto run-level beat times without provider-specific chunk audio
timestamps. The avatar bridge can expose this provisional timeline before
actual audio duration is resolved, then replaces it with actual-duration timing
when the provider reports the final duration. Secondary stress and unstressed
content-vowel fallback beats are ignored for talking-hands gestures.

## 5) Pocket TTS timing signals used by lip-sync

### 5.1 Start anchor: `playback_started` (Pocket core)

Files:

- `src/frontend/web/src/lib/speech/pocket/audio/PCMPlayerWorklet.js`
- `src/frontend/web/src/lib/speech/pocket/core/PocketTTSCore.js`
- `src/frontend/web/src/hooks/use-tts-playback.ts`

The frontend anchors `playback_started` to the worklet's **real playback begin** signal:

- `PCMPlayerWorklet` emits `firstPlayback` when the AudioWorklet begins playback after startup buffering
- `PocketTTSCore` forwards this as `playback_started`
- `useTtsPlayback` emits `onAudioStarted` with:
  - `audioStartSec`
  - `audioContext`
  - `generationId`

### 5.2 Actual duration: `generation_finished.metrics.audioDuration`

Files:

- `src/frontend/web/public/tts/workers/inference-worker.js`
- `src/frontend/web/src/lib/speech/pocket/core/PocketTTSCore.js`
- `src/frontend/web/src/hooks/use-tts-playback.ts`

When the Pocket worker finishes generation, it emits `generation_finished` with metrics.

The frontend consumes:

- `metrics.audioDuration`

Current behavior:

- `audioDuration` includes the worker's inserted inter-chunk silence (`CHUNK_GAP_SEC`) in addition to generated audio
- extra metrics are also emitted for debugging:
  - `generatedAudioDuration`
  - `insertedGapDuration`

### 5.3 Immediate stop: raw `playback_ended`

`useTtsPlayback` exposes a raw Pocket playback-end callback:

- `onPlaybackEndedSignal`

This fires when Pocket playback actually ends, even if SSE/run completion bookkeeping has not finished yet.

`useChatSession` uses this to hard-stop avatar lip-sync immediately so the face does not continue animating after audio is over.

## 6) Avatar lip-sync bridge (`useAvatarLipSyncBridgeStore`)

File:

- `src/frontend/web/src/stores/avatar-lipsync-bridge-store.ts`

This store coordinates three independent timelines:

1. SSE completion (viseme plan + raw phoneme inputs available)
2. TTS playback start (real `audioStartSec` + `audioContext`)
3. Avatar state (`talking`) from the runtime render loop

### Stored state (per run)

The bridge tracks:

- estimated/actual viseme plan (`sourcePlansByRun`)
- raw viseme inputs (`rawVisemeInputsByRun`)
  - `phonemizedText`
  - `tokenizedText`
  - `fps`
- queued/active segment (`segmentsByRun`)
- speech playback start timing (`speechAudioStartsByRun`) for Pocket TTS,
  ElevenLabs and Gemini
- speech actual duration (`speechAudioDurationsByRun`) for Pocket TTS,
  ElevenLabs and Gemini
- provider character timing (`providerSpeechTimingByRun`) for ElevenLabs,
  evidence that the current planner does not read
- speech gesture timelines (`speechGestureTimelinesByRun`) generated by the
  viseme worker and scaled to actual audio duration when known
- started flags (`startedRuns`)
- speech timing context derived per frame from
  `audioContext.currentTime - audioStartSec`, plus resolved duration when
  available. When a speech gesture timeline matches the resolved duration, it
  is included in the context. `AvatarCanvasActor` passes this context into
  `Avatar.update(delta, { speechTiming })` so procedural layers can align to
  audible TTS windows without duplicating provider-specific timing code.

### Gate condition for starting expression playback

The bridge starts lip-sync only when:

- a live avatar instance is registered
- a viseme segment exists for the run
- speech playback start timing is available
- avatar state is `talking`
- the run has not already started lip-sync playback

This gate is evaluated from the render loop (`tickGate`) in `AvatarCanvasActor`.

## 7) Provisional estimated playback (overprovisioned)

Before actual Pocket duration is known, the bridge uses the estimated viseme plan but **overprovisions** the provisional segment duration so the avatar is less likely to stop animating early.

Current margin policy (estimated path only):

- minimum margin: `1.25s`
- ratio margin: `20%` of estimated duration
- maximum margin: `4.0s`

The bridge logs this as:

- `Queue / Overprovisioning provisional viseme duration`

This is a UX safeguard and does not replace the actual-duration recompute path.
For streamed structured TTS, especially backend-pushed Gemini audio, later
speech segments can arrive after audible playback has already
started. When that happens, the bridge rebuilds and immediately replaces the
in-flight provisional
segment using the same audio start anchor, so the avatar does not finish the
early short provisional segment while audio continues.

## 8) Actual-duration recompute and in-flight replacement

When actual speech audio duration arrives (`onAudioDurationResolved`):

1. `useChatSession` forwards it to the bridge (`markSpeechAudioDurationResolved`)
2. The bridge recomputes a **new viseme plan from raw phoneme/text inputs** via:
   - `buildGruutVisemeKeyframes(..., targetDurationSec)`
3. The bridge converts that plan into a new `vowel5` segment
4. If playback has already started, the bridge performs an in-flight replacement with a continuity anchor

### In-flight continuity anchor

To avoid a mouth-shape pop during replacement:

- the bridge computes `elapsedSec = audioContext.currentTime - audioStartSec`
- samples the current segment at `elapsedSec`
- builds the replacement segment with an anchor:
  - `elapsedSec`
  - `currentDurationSec`
  - `currentValues`
- reapplies the segment with the **same `audioStartSec`**

This preserves:

- audio clock alignment
- visual continuity at the replacement instant

### Failure policy

If actual duration arrives but raw viseme inputs are missing:

- the bridge stores the duration and logs a warning
- if raw inputs arrive later, the queued raw-input path rebuilds with that known
  actual duration
- if raw inputs never arrive, lip-sync is skipped for that run without throwing
  through the TTS callback

This protects chat/TTS playback from provider timing races while still avoiding
hidden frame-stretch fallback behavior.

## 9) `vowel5` segment format and playback

Files:

- `src/frontend/web/src/lib/avatar/vowelVisemeSegment.ts`
- `src/frontend/web/src/lib/avatar/types.ts`
- `src/frontend/web/src/lib/avatar/ExpressionController.ts`

### Segment format

The avatar runtime supports a native lip-sync frame format:

- `format: "vowel5"`

Frame values are ordered as:

- `[A, E, I, O, U]`

`vowelVisemeSegment.ts` converts the viseme plan into:

- `SegmentMeta`
- `FramePayload[]`

with time-based keyframes (`time_sec`) and optional continuity anchor support.

### Runtime sampling model (important)

The avatar lip-sync runtime samples by **audio time**, not render frame count:

- `ExpressionController` reads `AudioContext.currentTime`
- computes `t = now - audioStartSec`
- interpolates between registered keyframes

This means:

- running Three.js at >60 FPS does **not** consume keyframes too fast
- higher render FPS only increases visual sampling smoothness

## 10) VRM vowel expression detection and mapping

File:

- `src/frontend/web/src/lib/avatar/ExpressionController.ts`

On avatar load, the expression controller inspects the loaded VRM expression list and logs:

- full available expressions
- vowel-related expressions
- resolved vowel expression map
- missing channels

Supported naming styles (mixed/case-insensitive):

- `A/E/I/O/U`
- `aa/ee/ih/oh/ou` (common VRM style)
- fallbacks like `ii`, `oo`, `uu`

`vowel5` runtime frames are then applied against the resolved mapping each update.

## 11) Start and end semantics (what the logs mean)

### Start

Key logs:

- `TTSPlayback / Playback / Audio started`
- `Avatar / State / State update ... to: talking`
- `AvatarVisemeSync / Playback / Expression blendshape started`

Meaning:

- speech playback has begun (anchored to the provider's audio start signal)
- avatar entered talking state
- bridge registered and started the `vowel5` segment

### End

Three relevant end logs can differ:

1. **Avatar viseme segment completed**
   - `Avatar LipSync / LipSync / Vowel keyframe playback completed`
   - emitted when the lip-sync timeline runs past the segment's scheduled end

2. **Pocket playback ended signal**
   - `TTS / Playback ended signal received`
   - raw Pocket playback end (used to hard-stop lip-sync immediately)

3. **TTS audio ended**
   - `TTS / Audio ended`
   - higher-level callback that may be delayed by run-completion gating in `useTtsPlayback`

For lip-sync stop timing, the raw Pocket playback-ended signal is the authoritative stop hook.

## 12) Debugging checklist

Inspect these stages in order:

1. Confirm spoken text has matching phonemes and a generated viseme plan.
2. Check `audioStartSec` and the bridge's `talking` gate.
3. Check the provisional target duration and overprovisioning log.
4. Check when actual duration arrived and whether replacement was prestart or
   in-flight. Large duration corrections can affect perceived synchronization.
5. Confirm raw playback-ended cleared lip-sync; the higher-level Audio ended
   callback may wait for run completion.

### Comparing plans in the debug panel

In a development build with `VITE_ENABLE_DEBUG_PANEL=true`, the Anima debug
panel's **Lip-sync** section shows the latest realtime ElevenLabs reply:

- its audio envelope;
- its timing evidence: words, punctuation and tags;
- one mouth-openness curve per plan source.

**Replay** plays the captured audio through its own `AudioContext` and drives
the avatar with that plan (`playReplaySegment`, under a replay run id), so plans
can be compared by eye and ear.

- Plans are built, and Replay is enabled, only once the captured reply has
  finished playing: when the bridge clears its run. The stream ends earlier,
  while buffered audio still plays.
- Replay cannot start while any reply is speaking, whatever its provider. A
  reply that starts speaking during a replay ends it. A reply whose own plan
  has started keeps it; otherwise the mouth returns to rest.
- A capped capture is drawn and replayed on the 90 s it kept.

- **Capture.** `SceneDebugPanel` starts the capture while the panel is enabled,
  whether or not it is open, because the panel closes on any outside click
  such as typing a message.
  - The ElevenLabs runtime hands each audio frame to the debug tap
    (`lib/speech/speech-debug-tap.ts`). Without a capture the tap is empty and
    nothing is copied.
  - `stores/lipsync-debug-store.ts` keeps only the latest run, capped at 90 s.
  - It copies the run's planner inputs, timing and length from the bridge
    before the run is cleared, and clears with the session.
- **Plan sources.** `lib/speech/lipsync-plan-sources.ts` lists "Estimated
  (today)" (today's planner at the played length) first. A planner registers
  itself with `registerLipSyncPlanSource({id, label, build})`; the view needs
  no change.
- **No estimated plan.** gruut's English model finds no phonemes in Japanese,
  Chinese or Korean speech. "Estimated (today)" therefore has no plan for it,
  and the avatar's mouth stays still while it plays, as before Eleven v4. Its
  provider timing is still shown. Accented Latin text keeps gruut's
  English-reading phonemes.

## 13) Known limitations / caveats

1. **Single-chunk Pocket runs do not get inter-chunk gap silence**
   - `CHUNK_GAP_SEC` only applies between chunks
   - `insertedGapDuration` will be `0` for one-chunk runs

2. **Leading/trailing silence inside generated audio can still affect perceived phoneme alignment**
   - even with good start anchoring and total-duration correction

3. **Actual duration can arrive late**
   - if the provisional segment already completed, the recompute may be less visually useful
   - this is why overprovisioning + hard-stop on Pocket playback end is used

4. **`TTS / Audio ended` is not the same as raw Pocket playback-ended**
   - `useTtsPlayback` gates `onAudioEnded` on run completion
   - use the raw playback-ended signal logs for end-of-audio alignment debugging
