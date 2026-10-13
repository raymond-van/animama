# Eleven v4 and v4 Turbo voices, with provider timing for lip-sync

Status: Agreed (owner, 2026-10-12). Phases 1–2 of the ExecPlan were authorized
on 2026-10-12, and Phases 3–5 on 2026-10-13, with #498 and #499 folded into the
same PR. Amended on 2026-10-12 by D13: finalized Eleven v4 is removed, and ElevenLabs
speaks only with Eleven v4 Turbo.

Owner decisions, 2026-10-12, in D1–D13 below:

- D1–D4 are agreed, D5 is waived and D6 is approved.
- D8 is confirmed in narrowed form, and D9 is pulled into this change.
- The v4 Turbo streamed path is the priority, delivered in one PR (D10).
- There is no English lip-sync change before #468 (D11).
- Audio tags in the chat model's `speech` are new scope. They are covered by
  linked issue [#479](https://github.com/raymond-van/animama/issues/479) after
  intent discovery (D12).
- After Phase 2 passed review, finalized Eleven v4 was removed (D13).

Authoritative source: parent issue
[#471](https://github.com/raymond-van/animama/issues/471), published on
2026-10-12 (updated 23:23 UTC) from this file at `5e0c6797`, and amended with D13
on 2026-10-13 at 02:45 UTC (R4 and R6 wording at 03:31 UTC; phase
authorization at 05:04 UTC). This file is that snapshot. Refresh it from the
issue before resuming.
Research: [eleven-v4-research.md](eleven-v4-research.md) (spike of 2026-10-12).

## Problem and intended users

Animama speaks ElevenLabs replies with three older models:

- **Realtime path:** `eleven_flash_v2_5` (the default) and `eleven_multilingual_v2`.
  The browser streams the reply's sentences to ElevenLabs' Text to Speech
  WebSocket while the reply is written.
- **Finalized path:** `eleven_v3`. The backend speaks each finished sentence or
  paragraph and pushes PCM over `chat:sse`.

ElevenLabs now offers Eleven v4 and v4 Turbo. They have better voice accuracy and
more languages (94), follow richer audio tags, and cost the same per character as
the models they replace. Neither runs on the Text to Speech WebSocket.

The avatar's lip-sync estimates phoneme durations from gruut and stretches the
whole plan to the clip length. Pauses, laughs and leading silence therefore pull
the mouth away from the voice: in the spike the estimated word starts were up to
0.6 s off on a sentence with a comma pause, and 0.9 s off after a laugh. v4 can
return per-character timing of the audio actually spoken. #468 is building a new
lip-sync planner that will use that timing as evidence.

The same gruut step decides which sentences reach the finalized providers. A
Japanese, Korean or Chinese sentence yields no phonemes, so finalized ElevenLabs
and Gemini never speak it, although v4 speaks 94 languages.

This change serves the local installation owner, on desktop and self-hosted web,
who chats with an Anima that speaks with an ElevenLabs voice. Hosted Animama Cloud
users benefit once Cloud adopts the updated contract.

## Goals, scope and non-goals

Include:

- `eleven_v4_turbo` on the realtime path, over the Text to Dialogue WebSocket.
- ~~`eleven_v4` on the finalized path~~: withdrawn by D13. ElevenLabs speaks
  only with `eleven_v4_turbo`.
- Removal of `eleven_flash_v2_5`, `eleven_multilingual_v2` and `eleven_v3`, with
  automatic migration of saved preferences (D1).
- Speech in every language, without the gruut gate (D9): Gemini's finalized
  speech and realtime v4 Turbo.
- ElevenLabs character timing carried to the browser, a provider-neutral timing
  evidence module, and a side-by-side view whose plans can come from any source.
  These are the parts #468's planner reuses (D8).
- The hosted contract for the `transport: "server"` socket, and a prepared Cloud
  issue.
- Docs, contract versions and the regenerated client.

Exclude:

- Rendering lip-sync from the timing, and mouth shapes for vocal tags or for
  languages gruut cannot phonemize.
  [#468](https://github.com/raymond-van/animama/issues/468) owns these. Today's
  gruut planner is not extended (D8, D11).
- Multi-speaker dialogue; each connection uses one voice.
- Gemini TTS behaviour. It shares the finalized pipeline and must not regress.
- Voice-cloning UI, beyond keeping clones working.
- Animama Cloud code. A Cloud issue is prepared but not implemented.
- Allowing the chat model to write audio tags in `speech`:
  [#479](https://github.com/raymond-van/animama/issues/479) (D12). The prompt's
  ban stays until then.

## Required behavior

### R1 — Realtime speech with v4 Turbo

- When the owner's ElevenLabs model is v4 Turbo, the reply's speech streams over
  ElevenLabs' Text to Dialogue WebSocket while the reply is written. This holds on
  local web and desktop.
- The browser connects directly with a single-use dialogue token minted by the
  backend for that reply. The ElevenLabs key never reaches the browser.
- Speech starts promptly after the reply's first sentence. Acceptance: median
  first audio within 300 ms of the first speech segment being sent on an open
  socket, measured live and recorded against Flash v2.5 (spike baseline 862 ms;
  v4 Turbo 106–149 ms).
- A short first sentence is not held back by the provider's 40-character /
  8-word buffer.
- The connection survives pauses in the reply longer than the provider's 20 s
  inactivity timeout, and closes as soon as the reply's speech ends, the reply
  is cancelled, or the run is superseded.
- If the token, socket or provider fails, that reply's speech stops with the
  existing "Text-to-speech unavailable" notice. The text reply is intact, and the
  next reply tries again.

### R2 — Finalized speech (Gemini only, D13)

Amended by D13: ElevenLabs has no finalized model.

- A reply whose saved or requested ElevenLabs model is `eleven_v3` speaks in
  realtime with `eleven_v4_turbo` (R1).
- Gemini finalized speech behaves as before, except that it now speaks every
  language (R7). A failed batch ends that reply's speech with the existing error
  frame; the text is intact.
- The utility synthesis route speaks `eleven_v4_turbo` through Text to Dialogue,
  with requests of at most 2,000 characters.

### R3 — Model choice, defaults and migration

- App Settings → Voice offers no ElevenLabs model choice (D13): ElevenLabs
  speaks with Eleven v4 Turbo, and the provider's description says so. The
  finalized grouping setting is removed.
- **Defaults (D3, superseded by D13):** v4 Turbo is the only ElevenLabs model,
  for new settings and the server.
- Saved preferences migrate without owner action:
  - `eleven_flash_v2_5`, `eleven_multilingual_v2` and `eleven_v3` become
    `eleven_v4_turbo`;
  - the old ids are never sent to the backend again.
- A chat request that still carries an old id, for example from a browser tab
  open across an upgrade, is answered with the mapped replacement rather than
  rejected. Its text reply is never lost to an old id.
- The old ids are removed from contracts, settings, the server's default-model
  setting, the utility synthesis route and docs. Only the one-way migration map
  keeps them.

### R4 — Provider timing evidence and the side-by-side view (D8)

- ElevenLabs v4 Turbo replies always request character timing. It reaches
  the browser for every reply, on every path:
  - **realtime socket:** alignment frames carry times relative to each frame. The
    browser keeps a cursor per turn and resynchronises it at
    `is_final_audio_for_turn`.
  - ~~finalized `tts.audio`~~: withdrawn with finalized v4 (D13).
  - **hosted server socket:** the same absolute `alignment` field is accepted.
- A provider-neutral timing evidence module turns timing into:
  - **spoken words** with start and end times. Japanese, Korean and Chinese
    characters keep one window each; they are not merged into words.
  - **punctuation** with its times, as a possible pause. ElevenLabs often
    reports no gap at a pause, because the previous word's end overruns it.
  - **bracketed spans**, keeping the raw tag text and a classification:
    - a non-verbal sound (laughs, sighs, gasps, clears throat, crying, …) is a
      non-speech interval;
    - a sound effect (applause, door creaks, …), which #479 allows on
      ElevenLabs, is a separate non-speech interval. The avatar makes no
      sound there, so the mouth rests.
    - delivery (whispers, shouts, softly, …) or emotion (excited, cheerfully,
      …) is a zero-width marker that applies to the following words;
    - pacing (`[pause]`, `[long pause]`) is a silent interval;
    - a tag is free-form and may combine terms, such as `[whispering, playful]`.
      An unknown tag counts as a delivery or emotion marker, never as a word.
  - Provider spans are hints, not truth. Word ends before a pause overrun by
    0.1–0.35 s, and a mid-sentence `[laughs]` can get 48 ms while the word before
    it absorbs the laugh (#468 measurements). The module reports what the
    provider said; deciding word ends and tag placement is the planner's job.
- Lip-sync rendering stays on today's estimated path in this change, for every
  provider (D11).
- **Side-by-side view:**
  - a debug-only view, available where the Anima debug panel is enabled, shows
    a reply's audio timeline;
  - it overlays the timing evidence (words or characters, punctuation, tag
    intervals and markers) and one mouth curve per lip-sync plan;
  - it can replay the reply on the avatar with any listed plan;
  - it is agnostic about where a plan came from, so #468 can add its planner
    as another curve;
  - it is not part of the normal product UI.
- Timing never delays speech. Missing or partial timing changes nothing the
  owner hears or sees outside the debug view.

### R5 — Hosted server transport

- The hosted contract describes how a `transport: "server"` session proxies v4
  Turbo speech, including optional timing frames and their time base.
- The browser keeps sending the frame shape the hosted socket already validates,
  so a Cloud that has not yet adopted v4 is not broken by this release.
- The browser accepts both the existing and the new end-of-stream markers from
  the server socket. Timing frames are optional there.
- The `speech_allowance_exhausted` → Pocket TTS fallback is unchanged. It applies
  to `tts.session.error` for realtime v4 Turbo, before or after the reply text.
- A multi-user hosted app keeps the server transport: a direct `ttd_websocket`
  token binds no text, voice or model on the operator's account (D13).
- A Cloud issue in the Cloud repository describes the required Cloud changes.
  This task does not change Cloud code. The issue covers:
  - the v4 model ids;
  - timing frames;
  - the dialogue-session concurrency pool: hold a session only while a reply
    speaks, cap and queue sessions per operator, and treat a pool refusal as a
    speech refusal that keeps the text;
  - measuring the operator plan's limit before launch.

### R6 — Voice compatibility and settings

- Existing premade and shared-library voices, including Animama's default voice,
  speak on v4 Turbo.
- Instant Voice Clones made through Animama are expected to keep working on v4
  Turbo. The owner waived live verification (D5).
- v4 accepts only Stability and Similarity. The utility synthesis route's voice
  settings drop Style, Speed and Speaker Boost. The route speaks with v4 Turbo
  over Text to Dialogue HTTP.

### R7 — Every language reaches the provider (D9)

- A speech sentence reaches the selected provider whatever its language: Gemini
  (finalized) and ElevenLabs v4 Turbo (realtime), for Japanese, Korean, Chinese,
  Spanish and English.
- gruut no longer gates TTS segments. Its phonemes stay an optional English
  lip-sync input.
- The `gruut_text_with_ws` text basis is revisited:
  - English keeps today's prepared text unless that blocks the change;
  - other languages send the visible speech text.
- The realtime path already speaks those languages, by falling back to the
  visible speech text. This is verified end to end.
- Lip-sync for those languages still does not move the mouth until #468.

## Constraints

- **Security:**
  - The ElevenLabs key stays on the backend.
  - The browser receives only a short-lived single-use token, of type
    `ttd_websocket`, for one connection.
  - Tokens and keys are never logged; existing URL redaction is kept.
- **v4-only integration (owner, 2026-10-12).** With the older models removed,
  every ElevenLabs speech path uses the v4 APIs and their features:
  - realtime: the Text to Dialogue WebSocket with `ttd_websocket` tokens and
    timing always on;
  - utility: Text to Dialogue HTTP (finalized speech and stitching were
    withdrawn by D13).

  No code path keeps a branch for an older model, except the one-way migration
  map.
- **Provider facts (spike):**
  - The Text to Speech WebSocket rejects v4.
  - The dialogue socket requires a `ttd_websocket` token. The `tts_websocket`
    token is refused.
  - Each open dialogue connection holds a session from a separate concurrency
    pool for its whole life, and closes after 20 s without a message.
  - Socket timing frames restart at zero per frame; HTTP timing is cumulative per
    request.
- **Compatibility:**
  - Contract versions follow `scripts/package-sets/README.md`. Changing the model
    enum is a `local-http` major.
  - The generated client is regenerated offline with `pnpm openapi-ts`.
  - The exported realtime model set that Cloud imports keeps its name.
- **Reliability:** a speech failure never removes or delays the text reply. Late
  audio, late timing or a late session for a cancelled or superseded run is
  ignored.
- **Cost:** v4 Turbo and v4 cost the same per character as the models they
  replace (issue #471). Requesting timing adds no charge. Live verification
  during implementation needs an owner-approved paid budget.
- **Performance:** timing collection must not add to time to first audio.
  Removing the gruut gate must not slow English segments.

## Acceptance criteria

- [ ] **Realtime on local web and desktop:** a realtime v4 Turbo reply speaks
  over the dialogue socket. Median first audio after the first segment is within
  300 ms, recorded against Flash v2.5. Evidence: a live browser check on local web
  and on desktop, with the measurements in the ExecPlan.
- [ ] **Realtime connection handling:** a reply that pauses for more than 20 s
  keeps speaking afterwards. Cancelling a reply closes its socket. Evidence:
  automated tests, plus one live check.
- [ ] **One ElevenLabs model (D13):** ElevenLabs speaks only with
  `eleven_v4_turbo`; `eleven_v3` settings and requests speak in realtime, and no
  finalized ElevenLabs path remains. Evidence: backend and frontend tests, and a
  repository search.
- [ ] **Every language:** Japanese, Korean, Chinese and Spanish sentences
  produce finalized segments for Gemini, and are spoken live. The realtime
  path speaks them end to end. Evidence: backend tests per language and provider,
  and live checks.
- [ ] **Migration:** saved `eleven_flash_v2_5`, `eleven_multilingual_v2` and
  `eleven_v3` preferences use `eleven_v4_turbo` with no owner action,
  and an old id in a chat request still yields a text reply. The old ids appear
  nowhere else in settings, contracts or docs. Evidence: frontend and backend
  tests, and a repository search.
- [ ] **Timing evidence:** every v4 Turbo reply's timing reaches the browser on
  the realtime socket and on the server socket, in the right time base.
  Evidence: tests for per-frame cursors and turn resync, and the server field.
- [ ] **Timing module:** on recorded fixtures (text, characters and times; no
  audio) it yields:
  - Latin words with windows, and CJK characters kept per character;
  - punctuation with times;
  - classified tag intervals and markers, including combined and unknown tags,
    never as words.

  Evidence: unit tests.
- [ ] **Side-by-side view:** for a v4 reply it shows the audio timeline, the
  evidence and today's estimated curve, and replays the reply on the avatar.
  Adding another plan source needs no change to the view. Evidence: tests, and
  the owner's review (owner gate).
- [ ] **Failures:** speech failures (token refused, socket error, provider error,
  timeout) leave the text reply intact with the existing notice. The hosted
  `speech_allowance_exhausted` → Pocket fallback still works. Evidence: existing
  and updated frontend and product-ui tests.
- [ ] **Hosted:**
  - `contracts/hosted-web.md` describes the v4 server transport and timing frames;
  - browser tests show that a server socket without timing still plays;
  - a Cloud issue is filed or ready to file.
- [ ] **Docs and contracts:**
  - the docs listed in the issue are updated;
  - contract versions are bumped;
  - the client is regenerated;
  - the package-set compare against a `main` baseline passes.
- [ ] **Checks:** `make check-test`; `pnpm check`, `pnpm web:lint`,
  `pnpm web:test`, `pnpm build` and `pnpm desktop:test`; and
  `pnpm e2e:test:fast` on a disposable built stack.
- [ ] **Owner gate** (before merge):
  - the owner listens to v4 Turbo with the voices in use;
  - the owner reviews the side-by-side view on a v4 reply.

  Instant Voice Clone verification is waived (D5).

## Open questions and decisions

- **D1 — Remove rather than keep Legacy (agreed by the owner, 2026-10-12).**
  - Remove all three old models; offer no Legacy option.
  - Reasons from the spike:
    - v4 Turbo is about 6× faster to first audio than Flash as Animama uses it
      today;
    - v4 accepts continuity context and the same tone tags;
    - every voice type that could be tested speaks on both v4 models;
    - list prices are equal.
  - Contingency: if the owner's listening gate rejects v4 for a voice in use,
    the owner can choose a Legacy entry before merge, as a bounded change.
- **D2 — Provider timing for lip-sync (owner, 2026-10-12; narrowed by D8).**
  - Use the timing, keeping the estimated path for other providers.
  - Show the plans side by side.
  - Tag mouth shapes and other providers stay with #468.
- **D3 — Defaults (agreed by the owner, 2026-10-12).** v4 Turbo on the realtime
  path is the default; v4 on the finalized path is the optional higher-quality
  mode. **Superseded by D13:** v4 Turbo is the only ElevenLabs model.
- **D4 — v4-only integration (owner, 2026-10-12).**
  - Optimise for the v4 models alone:
    - realtime: Text to Dialogue WebSocket and `ttd_websocket` tokens;
    - utility synthesis: Text to Dialogue HTTP (finalized synthesis and
      stitching withdrawn by D13);
    - hosted: dialogue-pool concurrency handling, in the Cloud issue.
  - The spike found that the plain Text to Speech HTTP API also accepts v4,
    which ElevenLabs does not document. Animama does not depend on that; Cloud's
    existing adapter may use it while it migrates.
- **D5 — Instant Voice Clones (waived by the owner, 2026-10-12).** The owner's
  plan refuses clones on every model, so clone compatibility rests on ElevenLabs'
  documentation.
- **D6 — Live verification budget (approved by the owner, 2026-10-12).**
  - US$1 for the implementation's live checks.
  - Spent so far: about US$0.02 on the follow-up probes; the spike's own
    US$0.33 came from its separate US$1 budget.
- **D7 — Hosted rollout (dependency).**
  - Hosted web shares this frontend.
  - Cloud must accept `eleven_v4_turbo` (and map `eleven_v3` to it) before, or
    together with, adopting this release. Otherwise a migrated hosted preference gets no speech;
    its text is intact.
  - The Cloud issue records this ordering.
- **D8 — Share with #468, narrowly (owner, 2026-10-12).**
  - Build only what #468's planner reuses: the timing plumbing, the timing
    evidence module with recorded fixtures, and a source-agnostic side-by-side
    view (R4).
  - Do not extend `buildGruutVisemeKeyframes` with word windows.
  - Basis: #468 scored v4 timing on 14 clips against forced alignment:
    - timing rendered directly holds the mouth open in 21% (English) and 13%
      (tag lines) of silent gaps;
    - it falls back to the estimate for Japanese, Korean and Chinese;
    - timing used as evidence in #468's planner reaches 66% vowel match and 5%
      / 4% open in silence, and places 6 of 7 tags.
- **D9 — Remove the gruut gate here (owner, 2026-10-12).** Gemini and realtime
  v4 Turbo speak every language (R7; finalized v4 was withdrawn by D13). This reverses the earlier proposal to leave
  it to #468.
- **D10 — Priority and delivery (owner, 2026-10-12).**
  - The v4 Turbo streamed path is the priority. Phase 1 delivers it first, with
    `eleven_v3` untouched; Phase 2 does the finalized migration and D9.
  - One PR carries the whole plan. The owner declined a separate realtime PR.
- **D11 — No English lip-sync change before #468 (owner, 2026-10-12).**
  - The minimal option was a time warp of today's English plan into timed word
    windows.
  - It was declined. The mouth would stay open into pauses, mid-sentence tags
    could land in the wrong place, Japanese, Korean and Chinese would get
    nothing, and #468 replaces it.
- **D12 — Audio tags in the chat model's `speech` (owner, 2026-10-12).**
  - Intent discovery ran on 2026-10-12. The outcome is linked issue
    [#479](https://github.com/raymond-van/animama/issues/479):
    - a neutral vocabulary, plus ElevenLabs extras: inline emotion and delivery,
      more non-verbal sounds and sound effects, but no accents;
    - a sparing, capped frequency;
    - tags hidden in chat but kept in history;
    - unsupported tags dropped.
  - It depends on this change's Phases 2–3. Its lip-sync reactions belong to
    #468.
  - This change's only part is the sound-effect class in the timing evidence
    module (R4).
- **D13 — Eleven v4 Turbo only (owner, 2026-10-12, after Phase 2 passed review).**
  - Finalized Eleven v4 is removed. ElevenLabs speaks only with Eleven v4 Turbo,
    in realtime, and `eleven_v3` maps to `eleven_v4_turbo`.
  - Reason: a multi-user hosted app must not hand out direct `ttd_websocket`
    tokens, which bind no text, voice or model on the operator's account. Hosted
    therefore keeps Cloud's server socket, which can speak `eleven_v4_turbo`
    server-side, so a finalized model adds nothing there.
  - Consequences:
    - R2's ElevenLabs part and the finalized acceptance criterion are withdrawn;
    - R3 has one ElevenLabs model;
    - R4's timing comes from the realtime and server sockets only;
    - ElevenLabs speech no longer carries the reply's tone tag, so audio tags in
      speech are left to #479.

## Spec

[Issue #471](https://github.com/raymond-van/animama/issues/471), published from
this file on 2026-10-12.

## ExecPlan

[eleven-v4-execplan.md](eleven-v4-execplan.md). Phases 1–2 authorized on
2026-10-12; Phases 3–5 and the folded follow-ups #498 and #499 on 2026-10-13.

## Delivery links

- Phase 1: [#480](https://github.com/raymond-van/animama/issues/480) (realtime
  v4 Turbo).
- Phase 2: [#481](https://github.com/raymond-van/animama/issues/481) (model
  cleanup and every language; finalized v4 was built, then withdrawn by D13).
- Phase 3: [#500](https://github.com/raymond-van/animama/issues/500) (Eleven
  v4 Turbo timing as lip-sync evidence).
- Phase 4: [#501](https://github.com/raymond-van/animama/issues/501)
  (side-by-side lip-sync view).
- Phase 5: [#502](https://github.com/raymond-van/animama/issues/502) (hosted
  contract, Cloud issue, docs and full validation).
- Folded into the PR (owner, 2026-10-13):
  [#498](https://github.com/raymond-van/animama/issues/498) and
  [#499](https://github.com/raymond-van/animama/issues/499).
- Linked: [#479](https://github.com/raymond-van/animama/issues/479) (audio tags).
- Branch: `feat/eleven-v4`, delivered in one PR.
