# Eleven v4 and v4 Turbo research brief (as of 2026-10-12)

Spike for [issue #471](https://github.com/raymond-van/animama/issues/471): replace
`eleven_flash_v2_5`, `eleven_multilingual_v2` and `eleven_v3` with `eleven_v4_turbo`
(realtime) and `eleven_v4` (finalized), and use provider character timing for
lip-sync. Everything below was measured on 2026-10-12 against the live ElevenLabs
API from the owner's Mac with the owner's pay-as-you-go key, unless it is marked
**docs** (vendor documentation) or **inferred**.

Source revision: `95a2db39` (`main`). Spend: about 6,500 characters, roughly
US$0.33 at the list prices quoted in the issue (budget US$1).

## Source keys

- **docs-ttd-ws**: [Text to Dialogue WebSocket reference](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket)
- **docs-ttd-vs-tts**: [TTS vs Text to Dialogue WebSockets](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets)
- **docs-v4**: [Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)
- **docs-ttd-ts**: [Stream dialogue with timestamps](https://elevenlabs.io/docs/api-reference/text-to-dialogue/stream-with-timestamps)
- **docs-token**: [Create single-use token](https://elevenlabs.io/docs/api-reference/tokens/create)

The spike scripts, raw JSON results and WAV samples are kept in the ignored
`docs/plans/eleven-v4/evidence/` folder of the task worktree; they are not
tracked. The scripts read `ELEVENLABS_API_KEY` from the environment and never
print it or any token.

## Summary

| Question | Answer |
| --- | --- |
| Does the realtime TTS WebSocket accept v4? | **No.** `/v1/text-to-speech/{voice}/stream-input` rejects both v4 ids before the upgrade: HTTP 400 `unsupported_model`, "Use the text-to-dialogue websocket endpoint instead." |
| Does the existing single-use token work on the dialogue socket? | **No.** A `tts_websocket` token connects, then the first message is answered with `invalid_token_type`: "Token type mismatch: expected 'ttd_websocket', got 'tts_websocket'", close code 1008. A **`ttd_websocket`** token (`POST /v1/single-use-token/ttd_websocket`, not yet listed in **docs-token** or the installed SDK 2.39.0) works. |
| Browser-direct dialogue socket? | **Works.** A page on `http://127.0.0.1` opened `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input` with a backend-minted `ttd_websocket` token in the query: open in 306 ms, first audio 176 ms after the first text, alignment frames received, clean close 1000. |
| v4 Turbo time to first audio vs today's Flash v2.5 | **About 6× faster.** Median 111–149 ms after the first text segment (flush after it) vs 862 ms for Flash as Animama drives it today (table below). |
| `pcm_24000` | Works on the dialogue socket and both HTTP APIs. |
| Is `eleven_v4` accepted by the plain Text to Speech HTTP API? | **Yes, undocumented.** `POST /v1/text-to-speech/{voice}`, `/stream` and `/stream/with-timestamps` return 200 for `eleven_v4` and `eleven_v4_turbo`. **docs-v4** and **docs-ttd-vs-tts** document only Text to Dialogue. |
| v4 over Text to Dialogue HTTP per sentence with a tone tag | Works; first byte 497–752 ms per sentence vs 399–490 ms for v3 over TTS HTTP. |
| `previous_text` with v4 | **Accepted** on TTS HTTP and Text to Dialogue HTTP (the v3 rejection no longer applies). |
| Character timing | Available on all three v4 paths; it arrives in the same message as its audio, so it is never late for playback. Details below. |
| Audio tags in timing | Tags appear as their literal characters. A leading delivery tag takes about 60–70 ms; an action tag spans the sound: `[laughs]` 0.28–0.32 s, `[sighs]` 0.44–0.68 s. |
| Voices | Premade and shared-library ("professional") voices, including Animama's default voice, speak on v3, v4 and v4 Turbo. **Instant Voice Clones could not be tested**: the owner's plan rejects IVC on every model (`ivc_not_permitted`). |
| Voice settings | v4 accepted `stability` + `similarity` on the dialogue socket and dialogue HTTP, and the full v2 setting set (`style`, `speed`, `use_speaker_boost`) on TTS HTTP without an error (**inferred**: the extra fields are ignored, per **docs-v4**). |
| Dialogue-session concurrency | 16 idle dialogue sessions were held open at once with no refusal, and 8 generated at once without slowing (§7). Idle sessions close after 20 s without a message (`input_timeout_exceeded`, 1008). |
| Request stitching | v4 accepts `previous_request_ids` on Text to Dialogue HTTP (§7). |

## 1. Realtime: `eleven_v4_turbo` over the Text to Dialogue WebSocket

### Protocol as observed

- URL: `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000&sync_alignment=true|false&single_use_token=<ttd_websocket token>` (`language_code` optional, **docs-ttd-ws**).
- First message: `{"voices": [voice_id]}`, optionally with `voice_settings` (`stability`, `similarity` both accepted). v4 Turbo allows one voice per connection (**docs-ttd-vs-tts**).
- Text: `{"inputs": [{"text": "...", "voice_id": voice_id}]}`. `{"flush": true}` forces generation; `{"close_socket": true}` flushes, sends the remaining audio, `{"is_final_audio_for_turn": true}`, then `{"is_final": true}` and closes with 1000.
- Each `flush` ends a prosody turn: the server sends `is_final_audio_for_turn` after that audio.
- Server audio frames: `{"audio": "<base64 PCM>", "alignment": {...} | null, "normalized_alignment": {...} | null}`. All field names are snake_case (the TTS socket uses `isFinal` and camelCase alignment).
- Errors arrive as JSON `{"message", "error", "code"}` followed by a close with that code (1008 for token and timeout errors), not as a failed upgrade.

### Time to first audio

Simulation: the reply below is released to the socket one sentence segment at a
time, as Animama's chunker (24 characters minimum, sentence boundaries) would
send it while the model writes at 200 characters per second. The socket is opened
before the reply starts, as it is in the app. Voice: Jessica (premade). Times are
from sending the first segment (23 characters, 4 words) to the first audio frame;
3 runs each, median shown with the range.

> Oh, that sounds lovely! I think a walk by the river would be perfect today. Do
> you want me to remind you to bring a jacket? It might get chilly after sunset.

| Variant | Median (ms) | Range (ms) |
| --- | ---: | ---: |
| Flash v2.5, TTS socket, as Animama sends today (`{"text"}` frames, no flush, default buffering) | **862** | 849–912 |
| Flash v2.5, TTS socket, flush after the first segment | 258 | 219–302 |
| v4 Turbo, dialogue socket, no flush | 375 | 373–506 |
| v4 Turbo, dialogue socket, flush after the first segment | **111–149** | 106–233 |
| v4 Turbo, flush after every segment | 234 | 107–236 |
| v4 Turbo, flush after every segment, `sync_alignment=true` | 106 | 103–209 |

At a slower 60 characters per second (2 runs): Flash as today 2,382–2,515 ms; v4
Turbo without flush 999–1,069 ms (it waits for the second sentence to pass the
40-character / 8-word buffer); v4 Turbo with a first-segment flush 108–201 ms.

Connecting (TLS and upgrade) took 83–237 ms on both sockets, median about 90 ms.
Leading silence in the first audio was 7–83 ms. Requesting alignment did not
measurably delay audio.

**Finding:** the 40-character buffer costs 250–900 ms when the reply opens with a
short sentence. A `flush` after the first segment removes it. Flushing every
segment adds no latency benefit after the first and ends a prosody turn each time;
flushing only the first segment and letting the server buffer the rest keeps
prosody continuous.

One run streamed with a flush on every sentence showed a 2.7 s server stall
mid-reply; more than 4 s of audio was already queued, so playback did not starve.

### Alignment on the dialogue socket

- Shape: `{"chars": [...], "char_start_times_ms": [...], "char_durations_ms": [...]}`.
- Times **restart at 0 in every alignment frame**. Consecutive alignment frames
  tile the audio of a turn: within each turn the sum of frame lengths (last
  start plus duration) equalled that turn's audio length exactly in 5 of 6 turns
  and was 80 ms long in the other.
- Alignment frames do not line up one-to-one with audio frames: some audio frames
  carry `alignment: null`, and an alignment frame can cover slightly more or less
  than the audio in its message.
- **Inferred** client rule: keep a cursor per turn that advances by each frame's
  length, and resynchronise it to the cumulative played samples at every
  `is_final_audio_for_turn`.
- `chars` reproduce the sent text exactly, including audio tags and the spaces
  sent with each input. `normalized_alignment` echoed the same text.

## 2. Finalized: `eleven_v4` over HTTP streaming

Three sentences, each spoken as one request with an emotional-tone tag, `previous_text` from the second
sentence on, `apply_text_normalization=off`, `pcm_24000`. Voice: Jessica.

| Sentence | v3, TTS stream | v4, TTS stream | v4, TTS stream with timestamps | v4, dialogue stream with timestamps |
| --- | --- | --- | --- | --- |
| `[cheerfully] Good morning! I made a little plan for us today.` | 399 / 984 | 556 / 1,047 | 579 / 1,047 | 528 / 1,022 |
| `[softly] First, we take it slow and have some tea together.` | 490 / 1,076 | 487 / 992 | 617 / 1,171 | 497 / 1,144 |
| `[excited] Then, if the weather holds, we go see the cherry blossoms by the river!` | 429 / 1,420 | 633 / 1,501 | 575 / 1,344 | 752 / 1,591 |

Cells are first byte / complete, in ms. v4 is about 100–200 ms slower to first
byte than v3 per sentence and similar to complete. Audio lengths were within
0.5 s of v3. All v4 requests with `previous_text` returned 200.

- The timestamp streams are newline-delimited JSON objects: `audio_base64`,
  `alignment`, `normalized_alignment`, and `voice_segments` (dialogue) or
  `quality_check` (TTS).
- Alignment uses `{characters, character_start_times_seconds, character_end_times_seconds}`.
  Times are **cumulative from the start of the request**, unlike the socket.
- Characters are quantised to roughly 40 ms; characters within a word are spread
  evenly across the word.
- Pauses appear as long punctuation or space characters: `!` 0.8–1.0 s, the
  following space 1.0–1.2 s.
- `alignment` reproduced the request text exactly, including numbers such as
  `$25` and `3:30 PM` when normalization was left on. `normalized_alignment` was
  identical, so the alignment indexes map one-to-one to the text Animama sends.

## 3. Audio tags in timing

| Text | Tag span |
| --- | --- |
| `[cheerfully] Good morning! …` (leading delivery tag) | `[cheerfully]` 0–0.069 s, then speech from 0.08 s |
| `[laughs] Oh wow, that's amazing! …` | `[laughs]` 0–0.32 s (v4), 0–0.28 s (v4 Turbo), audible laugh; "Oh" starts 0.48 s |
| `Hmm... [sighs] I suppose …` | `[sighs]` 1.08–1.76 s (v4), 1.00–1.44 s (v4 Turbo), audible sigh |

Tags never produce word timings of their own, so a lip-sync mapper can skip
bracketed spans and treat them as non-speech intervals. Their mouth shapes belong
to #468.

## 4. Lip-sync value of provider timing

Animama's current planner (`buildGruutVisemeKeyframes`) estimates per-phoneme
durations from gruut and rescales the whole plan to the clip length. For four
v4 clips whose gruut word count matched the provider's, its word timings were
compared with the provider's:

| Clip | Mean start error | Max start error |
| --- | ---: | ---: |
| `Good morning! I made a little plan for us today.` | 80 ms | 173 ms |
| `First, we take it slow and have some tea together.` | 394 ms | 597 ms |
| `Then, if the weather holds, we go see the cherry blossoms by the river!` | 149 ms | 279 ms |
| `[laughs] Oh wow, that's amazing! I can't believe you did it.` | 570 ms | 940 ms |

The estimate starts speaking at 0 s and spreads every pause evenly, so a pause
after a comma, a laugh or leading silence pushes the mouth ahead of the voice by
up to about a second. Provider timing gives each word's real window.

Mapping notes:

- In production the finalized and realtime paths send gruut's normalised
  `tts_text`, so gruut's word list and the provider's spoken words come from the
  same string.
- The two remaining clips differed only because the spike sent raw numbers (`$25`,
  `3:30 PM`) that gruut verbalises.
- The emotional-tone prefix tag is not in the gruut text, so the mapper must skip
  it.

## 5. Voices and settings

Listening samples for the owner, all with the line `[warmly] Hi! It's so nice to hear from you
again. How was your day? Tell me everything.`, are in `evidence/voices/` for v3, v4 and v4 Turbo with three voices:

- Ava, Animama's default voice (`gJx1vCzNCD1EQHT212Ls`, a shared-library voice);
- Jessica (premade);
- Hallie (shared library).

| Voice | v3 first byte | v4 first byte | v4 Turbo first byte |
| --- | ---: | ---: | ---: |
| Ava (default) | 527 ms | 614 ms | 343 ms |
| Jessica | 420 ms | 581 ms | 307 ms |
| Hallie | 324 ms | 596 ms | 166 ms |

Instant Voice Clones were not testable. The owner's plan returns 401
`ivc_not_permitted` ("Instantly cloned voices are not available on your current
plan") for v3, v4 and v4 Turbo alike, so IVC compatibility needs a plan that
allows IVC.

`GET /v1/models` reports, for both v4 ids:

- 94 languages and a 10,000-character request limit;
- `can_use_style: false`, `can_use_speaker_boost: false`, `serves_pro_voices: false`;
- concurrency group `standard_eleven_v4`;
- a character cost multiplier of 1.0 for v4 and 0.5 for v4 Turbo.

The shared-library voices still worked.

## 6. Concurrency and timeouts

- 6 and then 16 dialogue sockets opened at once with `ttd_websocket` tokens all
  stayed open for the 6–8 s hold without text; none was refused. The plan's
  dialogue-session limit was not reached. Hosted limits remain unknown.
- An idle socket with no message for 20 s receives `input_timeout_exceeded`
  ("No message received within 20s."), code 1008. **docs-ttd-ws**: `keep_alive`
  resets the timer.
- **docs-ttd-vs-tts**: each open dialogue socket holds a session from a separate
  pool for its whole life, so sockets must close promptly after the reply or on
  cancel.

## 7. Follow-up probes (2026-10-12, after owner review)

Charged to the implementation budget: about 430 characters, roughly US$0.02.

- **Request stitching on v4.** Two consecutive Text to Dialogue HTTP streams
  (`eleven_v4`, default voice) both returned 200 and a `request-id` header. The
  second sent `previous_request_ids: [<first id>]`. First byte was 845 ms, then
  526 ms. v4 therefore accepts stitching; the audible effect was not judged.
- **Concurrent generation.** 8 v4 Turbo dialogue sockets each spoke a 41-character
  line at the same moment. All 8 completed, with first audio at 408–436 ms from
  connect, no refusal and no queueing visible. The owner's plan has not shown a
  dialogue-pool limit at 8 generating or 16 idle sessions. Hosted operator limits
  remain unmeasured.

## 8. Implications for Animama

1. **Realtime:**
   - Mint `ttd_websocket` tokens.
   - Connect the browser to the dialogue socket and send `{"voices"}` first, then `inputs`.
   - Flush after the first segment, send `keep_alive` while idle, and close with
     `close_socket`.
   - Parse `is_final` and the snake_case alignment.
2. **Finalized:** `eleven_v4` works on the existing TTS HTTP call. Text to Dialogue
   HTTP is the documented home of v4; both return the same timing.
   - `previous_text` can be sent to v4, so the v3 omission can be dropped.
   - A tone tag remains a valid leading audio tag.
3. **Lip-sync:** provider timing is available, timely and maps to the gruut words
   Animama already has. Anchoring each word's phonemes to its provider window
   removes 0.1–0.9 s of drift on these clips.
4. **Hosted:** Cloud synthesises realtime speech after the reply over
   `/v1/text-to-speech/{voice}/stream`, which already accepts v4 and v4 Turbo.
   - Cloud's server socket accepts only `{"text"}` browser frames, so the browser
     must keep that frame shape on the server transport.
   - Alignment over the server socket needs a contract change and Cloud work.
5. **Owner gates:**
   - Listen to the samples and the voices in use.
   - Check an IVC on a plan that allows it.
