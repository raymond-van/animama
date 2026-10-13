# Eleven v4 and v4 Turbo execution plan

Status: Phases 1–2 authorized by the owner on 2026-10-12, and Phases 3–5 on
2026-10-13. Issues #498 and #499 are folded into the same PR (owner,
2026-10-13).

Source agreement: [spec](eleven-v4-spec.md), agreed by the owner on 2026-10-12
(decisions D1–D13; D13 removed finalized Eleven v4 after Phase 2), for
[issue #471](https://github.com/raymond-van/animama/issues/471). Research:
[eleven-v4-research.md](eleven-v4-research.md).

Authorized scope: Phases 1–5 (owner: 1–2 on 2026-10-12, 3–5 on 2026-10-13),
plus the folded issues #498 and #499.
- Phase 1 delivers the v4 Turbo streamed path first, by the owner's priority
  (spec D10).
- One PR carries the whole plan (owner, 2026-10-12).

Explicit gates:

- **G1 — Paid live checks.** Live ElevenLabs checks during implementation stay
  within the owner-approved budget (spec D6: US$1, of which about US$0.21 is
  spent).
- **G2 — Owner gate before merge.**
  - The owner listens to v4 Turbo with the voices in use.
  - The owner reviews the side-by-side view on a v4 Turbo reply.
  - Instant Voice Clone verification was waived on 2026-10-12 (spec D5).
- **G3 — Hosted (Cloud).** Cloud must adopt the v4 model ids before or together
  with hosted adoption of this release (spec D7). It is tracked by a Cloud issue,
  not by this PR.

## Purpose and context

Replace ElevenLabs `eleven_flash_v2_5` and `eleven_multilingual_v2` (realtime)
and `eleven_v3` (finalized) with `eleven_v4_turbo`, spoken in realtime (D13
removed the finalized `eleven_v4` after Phase 2), and let speech reach providers
in every language. Carry ElevenLabs character
timing to the browser as evidence for #468's lip-sync planner, and add a
side-by-side view. The spike established the protocol facts this plan depends on:

- The Text to Speech socket rejects v4.
- The Text to Dialogue socket needs a `ttd_websocket` single-use token and works
  browser-direct.
- v4 Turbo with a flush after the first segment reaches first audio in
  106–149 ms, against 862 ms for Flash as used today.
- Timing frames on the socket restart at zero in every frame and tile each turn.
  HTTP timing is cumulative per request.
- `previous_text` works with v4.

Orientation (paths relative to the repository root):

- **Backend models and provider calls:**
  - `src/backend/animama/app/contracts/elevenlabs.py` (model literals, schemas);
  - `src/backend/animama/app/contracts/dispatch.py` (`PyAnimaTtsRunOptions`);
  - `src/backend/animama/app/chat/options.py`;
  - `src/backend/animama/server/elevenlabs_service.py` (token, session,
    utility route);
  - `src/backend/animama/app/voice_emotional_tone.py` (tone vocabulary,
    Gemini's speaking style).
- **Backend chat speech:**
  - `src/backend/animama/product_http/chat/tts.py` (realtime session bootstrap;
    the Gemini-only finalized batcher and bootstrap);
  - `src/backend/animama/product_http/chat/sse_events.py` (`tts.session`,
    `tts.audio`, `tts.done`, `tts.error`);
  - `src/backend/animama/product_http/ports.py` (`ProductSpeech`,
    `FinalizedSpeechPort`).
- **Browser realtime:**
  - `src/frontend/web/src/hooks/use-elevenlabs-tts-runtime.ts` (URL, socket
    lifecycle, frames);
  - `src/frontend/web/src/hooks/use-tts-playback.ts` (orchestration, chunker
    feed, Pocket fallback);
  - `src/frontend/web/src/lib/speech/tts-chunker.ts`.
- **Browser finalized (Gemini only):** `src/frontend/web/src/hooks/use-finalized-tts-runtime.ts`
  (renamed from `use-elevenlabs-finalized-tts-runtime.ts` for #499).
- **Shared chat client (product-ui):**
  - `src/frontend/packages/product-ui/src/query/mutations/useChatSse.ts` (SSE
    types);
  - `src/frontend/packages/product-ui/src/chat/useProductChatSession.ts`
    (session validation, viseme inputs, allowance fallback);
  - `src/frontend/packages/product-ui/src/chat/session-bindings.ts`.
- **Settings:**
  - `src/frontend/web/src/lib/settings/preferences.ts` (the one ElevenLabs
    model and the retired-id normalizer);
  - `src/frontend/web/src/ui/sidebar/ApplicationSettingsModal.tsx` (Voice rows);
  - `src/frontend/web/src/lib/chat/elevenlabs-chat-tts-dispatch.ts`;
  - `src/frontend/web/src/ui/main/chat/useChatSession.ts`.
- **Lip-sync:**
  - `src/frontend/web/src/lib/speech/gruut-viseme-keyframes.ts` (planner,
    `buildGruutVisemeKeyframes`, global `timelineScale`);
  - `src/frontend/web/src/stores/avatar-lipsync-bridge-store.ts`
    (`queueVisemeInputsForRun`, in-flight rebuilds, `markSpeechAudioDurationResolved`);
  - `src/frontend/web/src/workers/viseme-worker.ts`;
  - `src/frontend/web/src/lib/avatar/viseme-worker-protocol.ts`;
  - `src/frontend/web/src/lib/avatar/vowelVisemeSegment.ts`;
  - `src/frontend/web/src/lib/avatar/ExpressionController.ts`.
- **Debug panel:**
  - `src/frontend/web/src/ui/debug/AnimaDebugPanel.tsx`;
  - `src/frontend/web/src/ui/debug/animaDebugPanelConfig.ts`.
- **Contracts:**
  - `contracts/hosted-web.md` (realtime session descriptor, speech refusals,
    versions);
  - `contracts/versions.json` (`local-http` 5.0.0, now 6.0.0);
  - `src/frontend/packages/runtime-contracts/package.json` (0.5.0, now 0.6.0);
  - `src/frontend/packages/product-ui/package.json` (0.9.0, now 0.10.0);
  - `docs/backend/architecture/http-api.md` (version mirror).
- **Docs:**
  - `docs/frontend/runtime/elevenlabs-tts.md`, `voice.md` and `avatar-lipsync.md`;
  - `docs/backend/integrations/voice-and-speech.md`;
  - `docs/backend/architecture/http-api.md`;
  - `docs/backend/runtime/chat.md`.

Ownership and boundaries:

- Backend code stays under `src/backend`, frontend code under `src/frontend`.
- Generated clients are regenerated with `pnpm openapi-ts`, never hand-edited.
- No Alembic revisions are needed: preferences are opaque JSON, and nothing in
  the schema changes.
- Cloud is read-only here. Its `services/hosted-api` imports
  `SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS` and hard-codes `eleven_v3`
  (`app/speech.py`, `server/speech_turn.py`), so the exported name is kept and
  the Cloud issue describes the rest.
- Gemini is the only user of `tts.audio` and the finalized runtime, and shares
  the lip-sync bridge. Its frames gain no timing, and it keeps the estimated
  path. It gains every-language segments (D9).
- Today's gruut planner is not extended (spec D8). #468 owns lip-sync rendering
  from timing.

## Progress

- [x] Spike (2026-10-12), about US$0.33 of US$1:
  [research brief](eleven-v4-research.md).
- [x] Spec drafted (2026-10-12): [eleven-v4-spec.md](eleven-v4-spec.md).
- [x] ExecPlan drafted (2026-10-12).
- [x] Owner review, 2026-10-12: D1–D4 agreed, D5 waived, D6 approved.
- [x] Follow-up probes, 2026-10-12, about US$0.02 of the D6 budget: v4 accepts
  request stitching, and 8 dialogue sessions generated at once
  ([research §7](eleven-v4-research.md#7-follow-up-probes-2026-10-12-after-owner-review)).
- [x] Owner decisions, 2026-10-12:
  - realtime first;
  - D8 narrowed;
  - D9 pulled in;
  - audio tags as new scope behind intent discovery.

  Phases 1–2 authorized.
- [x] Spec published to #471 at `5e0c6797` and read back (2026-10-12). Phase
  issues #480 and #481 were created as native sub-issues of #471.
- [x] Phase 1 (#480): realtime v4 Turbo over the dialogue socket. All checks
  pass, Code Review #1–#3 passed, and the live web and desktop checks show a
  median first audio of 155 ms. Pending G2 (owner listening).
- [x] Phase 2 (#481): finalized v4, model cleanup and every language. All checks
  pass, and Code Review #1–#3 passed (`c6b87dd2`).
- [x] Phase 2 amendment (owner, 2026-10-12): finalized v4 removed; ElevenLabs
  speaks only with Eleven v4 Turbo. Checks pass, and Amendment Code Review #1–#2
  passed. Pending G2 (owner listening to v4 Turbo).
- [x] Folded follow-ups: #498 (Japanese and Chinese sentence splitting) and #499
  (provider-neutral names for the Gemini finalized path). Checks and live checks
  pass, and Code Review #1–#3 passed.
- [x] Phase 3 (#500): timing plumbing and the timing evidence module. Checks
  pass, live English and Japanese timelines were collected, and Code Review #1–#2
  passed (`9a4e9be3`).
- [x] Phase 4 (#501): side-by-side view with pluggable plan sources. Checks
  pass; live capture, replay and both layouts were checked; Code Review #1–#2
  passed.
- [x] Phase 5 (#502): hosted contract, Cloud issue, docs and full validation.
  Code Review #1 found three Cloud-draft corrections. They were fixed and
  verified by the final integration review.
  - The native full validation passed. The Docker-backed backend tests and
    `e2e:test:fast` passed after OrbStack recovered.
- [x] Intent discovery for audio tags in `speech` (D12), 2026-10-12: linked
  issue [#479](https://github.com/raymond-van/animama/issues/479).
- [x] Phases 1–2 scope review (2026-10-13): passed after a one-line doc fix.
  Every language was then spoken live on the current paths.
- [x] Final integration review (2026-10-13): #1–#3 passed, with no blocking
  finding and two repair rounds.
- [x] Docker-backed checks (2026-10-13, `47105607`): `make check-test` 4,159
  passed, 0 failed; `pnpm e2e:test:fast` 38 of 38.
- [ ] G2 owner gate.

## Surprises & Discoveries

From the spike, 2026-10-12 (details and numbers in the research brief):

- **Token type.** The existing `tts_websocket` token is refused on the dialogue
  socket with `invalid_token_type`. `ttd_websocket` works, though it is
  undocumented and absent from the installed SDK's `SingleUseTokenType`.
- **v4 on plain TTS HTTP.** ElevenLabs documents v4 only for Text to Dialogue,
  but the plain Text to Speech HTTP API (`convert`, `stream`,
  `stream/with-timestamps`) accepts it. Cloud's existing HTTP adapter therefore
  needs only model-id changes.
- **Socket timing.** Times are relative per frame. Frames tile the turn's audio,
  but not one-to-one with audio frames, and some audio frames have
  `alignment: null`.
- **Flush and turns.** `flush` ends a prosody turn (`is_final_audio_for_turn`).
  Flushing only the first segment gives the latency win without fragmenting the
  prosody of the rest of the reply.
- **IVC untestable.** The owner's plan refuses IVC on every model, so clone
  checks need a different plan (spec D5).
- **Today's socket usage** (code reading):
  - the realtime runtime sends trimmed `{text}` frames without trailing spaces;
  - it never sends `flush` or `keep_alive`;
  - its Flash first audio waits for ElevenLabs' default buffering (862 ms median).
- **Settings default mismatch.** The frontend default grouping is
  `DEFAULT_ELEVENLABS_V3_FINALIZED_CHUNKING = "paragraph"`, while the backend and
  docs say `"sentence"`. This is pre-existing. Phase 1 keeps the behavior and
  corrects the docs, unless the owner prefers the other default (now Phase 2).
- **SDK gap.** The installed `elevenlabs` SDK 2.39.0 has no Text to Dialogue
  socket client, and its dialogue `stream_with_timestamps` has no `previous_text`
  parameter. The latest release is 2.71.0.
- **#468 brief** (`docs/lipsync-investigation` at `ccda1f26`, PR #473):
  - It scored v4 timing on 14 clips against forced alignment.
  - Timing rendered directly holds the mouth open in 21% (English) and 13% (tag
    lines) of silent gaps, because word ends overrun pauses by 0.1–0.35 s.
  - A mid-sentence `[laughs]` got 48 ms, with the laugh credited to the word
    before it.
  - Timing as evidence in #468's planner reached 66% vowel match, 5% / 4% open in
    silence, and 6 of 7 tags.
  - Hence spec D8: Phase 3 builds evidence, not rendering. The brief also found
    the gruut gate on finalized TTS (spec D9).
- **No comparison tooling.** No debug tooling shows two lip-sync plans; the
  bridge keeps one plan per run.
- **Follow-up probes.**
  - v4 accepts `previous_request_ids` on Text to Dialogue HTTP, and every
    response carries a `request-id` header.
  - 8 v4 Turbo sockets generated at once with no refusal, at 408–436 ms first
    audio.

From Phase 4, 2026-10-13:

- **No lip-sync for Japanese, Chinese or Korean.** gruut's English model finds no
  phonemes in that text, so today's planner makes no plan and the avatar's mouth
  stays still. A live Japanese reply's vowel weights stayed at 0 throughout.
  - This was already true on `main`. Accented Latin text keeps gruut's
    English-reading phonemes.
  - Provider timing is these replies' only lip-sync evidence (#468).
- **The debug panel closes on any outside click**, including typing a message.
  Capture therefore runs while the panel is enabled rather than only while it
  is open.

## Decision Log

- **2026-10-12 — owner (task instruction):**
  - Legacy models are allowed if replacing them proves too much work or too
    risky; full removal is preferred.
  - Use provider timing for lip-sync if feasible, with the estimated path as the
    fallback, and show the two side by side.
  - Tag mouth shapes and other providers stay in #468.
  - Proposed defaults: v4 Turbo realtime, v4 finalized as the optional mode.
- **2026-10-12 — owner, after review:**
  - D1: remove the old models.
  - D3: v4 Turbo is the realtime default, and v4 the finalized option.
  - D4: optimise the integration for v4 alone. That means:
    - Text to Dialogue WebSocket and `ttd_websocket` tokens;
    - Text to Dialogue HTTP for finalized and utility synthesis;
    - stitching;
    - hosted concurrency handling, in the Cloud issue.
  - D5: IVC verification is waived.
  - D6: US$1 is approved for live checks.
- **2026-10-12 — agent proposal: continuity.** Finalized requests send
  `previous_request_ids` with up to the last three request ids of the run. The
  ids come from each response's `request-id` header. They fall back to a
  100-character `previous_text` when no id is known, for example after a failed
  request. Whether stitching sounds better than `previous_text` is judged at G2.
- **2026-10-12 — owner: priority, D8, D9, D12.**
  - **Priority:** the v4 Turbo streamed path comes first, so Phases 1–2 are
    reordered realtime-first.
  - **D8 narrowed:**
    - timing plumbing;
    - an evidence module with per-character CJK windows, punctuation as
      possible pauses, and classified tags (non-verbal, delivery or emotion,
      pacing; unknown tags count as markers);
    - a side-by-side view agnostic about where a plan came from;
    - no extension of `buildGruutVisemeKeyframes`.
  - **D9:** remove the gruut gate in this change (Phase 2).
  - **D12:** audio tags in `speech` go to intent discovery and a linked issue.
- **2026-10-12 — owner:**
  - D10: one PR for the whole plan (the realtime-first PR split was declined);
  - D11: no English lip-sync change before #468;
  - D12: intent discovery done, with the outcome in
    [#479](https://github.com/raymond-van/animama/issues/479). Its sound effects
    add a class to the Phase 3 evidence module.
- **2026-10-12 — agent proposal: realtime flush policy.**
  - Flush once after the first speech segment, then let the server buffer.
  - Send `keep_alive` after 10 s without a message.
  - End with `close_socket`.
  - Basis: research §1.
- **2026-10-12 — agent proposal: one timing shape and time base.**
  - Every timing payload uses the dialogue socket's field names: `chars`,
    `char_start_times_ms` and `char_durations_ms`.
  - Direct sockets are relative per frame, and the browser accumulates them.
  - `tts.audio` and the hosted server socket carry times relative to the run's
    first audio sample; producers apply the offsets, since they know the sample
    counts.
- **2026-10-13 — agent proposal (Phase 3 review P3-F3): timing shape on the
  hosted server socket (supersedes the field names above).**
  - Server-socket `alignment` uses the shape ElevenLabs' `stream/with-timestamps`
    returns: `characters`, `character_start_times_seconds` and
    `character_end_times_seconds`.
  - The time base is unchanged: the run's first audio sample.
  - Reason: Cloud forwards that output with an offset instead of reshaping it.
  - `tts.audio` carries no timing since finalized v4 was removed (D13). Only the
    direct dialogue socket uses `chars` and relative milliseconds.
- **2026-10-13 — agent proposal (Phase 5 review P5-F1): where retired ids are
  mapped.**
  - The shared option normalizer (`merge_chat_request_options`) keeps dropping
    unsupported ids.
  - The shared route maps retired ids through `PyAnimaTtsRunOptions`. Cloud's
    own route must apply `replace_retired_elevenlabs_tts_model_id`, as the
    Cloud draft and the contract say.
  - Reason: mapping in the normalizer is a shared behaviour change that needs
    its own tests, and Cloud changes this area before adoption anyway.
- **2026-10-12 — agent proposal: old ids in requests.**
  - A `mode="before"` validator maps legacy ids to their replacements in
    `PyAnimaTtsRunOptions`.
  - The OpenAPI enum lists only the v4 ids, and a stale tab still gets its reply.
- **2026-10-12 — owner, after Phase 2 passed review: remove finalized Eleven v4;
  ElevenLabs speaks only with Eleven v4 Turbo.**
  - Context: direct `ttd_websocket` tokens are unsuitable for the multi-user
    hosted app, because the browser chooses the text, voice and model on the
    operator's account. Hosted therefore keeps Cloud's server socket, which can
    speak `eleven_v4_turbo` server-side, so hosted gains nothing from a
    finalized model.
  - Effect:
    - D1–D3's optional finalized mode is withdrawn;
    - `eleven_v3` now maps to `eleven_v4_turbo`;
    - the ElevenLabs model and grouping settings go;
    - ElevenLabs no longer implements finalized speech (Gemini remains the
      finalized provider);
    - the utility route speaks `eleven_v4_turbo`.
  - D9 and R7 stand for Gemini and realtime. Phase 3 loses the backend
    `tts.audio` timing for ElevenLabs.
  - The Phase 2 work stays in history as reviewed. The removal is a Phase 2
    amendment with its own bounded review.
- **2026-10-13 — owner:**
  - Fold #498 (split Japanese and Chinese speech at `。！？`) and #499
    (provider-neutral names for the Gemini finalized path) into this PR.
  - Authorize Phases 3–5 and keep Phases 3–4 in this PR (declining the
    proposal to move them to #468).
  - Phase issues: #500, #501 and #502, native sub-issues of #471.

## Setup and execution rules

- **Workspace:**
  - Worktree `worktrees/animama/frosty-hawking-42dddf`, branch `feat/eleven-v4`
    from `95a2db39` (`origin/main` at setup).
  - Keep the primary checkout on `main`.
  - Use Python 3.12: `uv sync --python 3.12.13` (a new worktree venv may pick
    3.14 and break `openapi-ts`).
- **Credentials:**
  - Read the key from the owner-only `~/.config/animama/dev-secrets.env`:
    - scripts: `uv run --env-file "$HOME/.config/animama/dev-secrets.env" ...`;
    - stacks:
      `COMPOSE_ENV_FILES="$HOME/.config/animama/dev-secrets.env" ./reset.sh --name ev4 --base-port 8460`.
  - Never print key or token values.
  - Desktop live checks use the desktop app's own key storage, under the owner's
    control.
- **Stacks:**
  - One named task stack (`animama-ev4`), started only for live checks and torn
    down right after its last use.
  - `pnpm e2e:test:fast` uses a separate disposable built stack
    (`ANIMAMA_LLM_SKIP=1 ANIMAMA_WEB_BUILD_MODE=production ./reset.sh --name ev4-e2e --base-port 8600`).
  - Never touch other tasks' stacks.
- **Paid checks (G1):**
  - Record characters and estimated cost per live check in this plan.
  - Stop and ask the owner before exceeding the approved budget.
- **Phase completion:** each phase ends with:
  - its focused tests;
  - the affected scoped checks;
  - one `sdlc-reviewer` full review, plus at most two repair rounds;
  - a phase commit `<type>(<scope>)[p#]: <summary>`, with no attribution lines.
- **CI:** hosted Portable product validation stays disabled. Local checks are the
  evidence.

## Phased implementation

Phases follow the owner's priority (D10). Phase 1 delivers the v4 Turbo streamed
path on its own and leaves `eleven_v3` untouched. Phase 2 migrates the finalized
path and removes the gruut gate (D9). Phases 3–5 are agreed in scope but not yet
authorized.

### Phase 1: realtime v4 Turbo over the dialogue socket

Issue: #480. Requirements: R1, R3 (realtime models), R5 (browser frame
compatibility). Starting source: `5e0c6797` on `feat/eleven-v4` (base
`95a2db39`).

Outcome:

- Realtime replies speak with `eleven_v4_turbo`, browser-direct, over the Text to
  Dialogue socket on local web and desktop.
- The latency target is met, and the connection survives long pauses.
- Saved Flash v2.5 and Multilingual v2 preferences become v4 Turbo.
- `eleven_v3` (finalized) is untouched until Phase 2.
- The server transport keeps working against an unchanged Cloud.
- Timing is requested (`sync_alignment=true`) but not yet consumed (Phase 3).

Changes:

1. **Backend models** (`app/contracts/elevenlabs.py`):
   - Realtime `Literal["eleven_v4_turbo"]`; the chat union becomes
     `eleven_v4_turbo | eleven_v3`. The `SUPPORTED_*` names that Cloud imports are
     kept.
   - Add `RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS` with
     `eleven_flash_v2_5` and `eleven_multilingual_v2` → `eleven_v4_turbo`.
     Phase 2 adds `eleven_v3` → `eleven_v4`.
2. **Dispatch** (`dispatch.py`, `options.py`): a `mode="before"` validator on
   `PyAnimaTtsRunOptions.model_id` maps legacy ids, so a stale tab's request
   still gets its reply. The provider/model validator is unchanged.
3. **Config:**
   - Remove `elevenlabs_realtime_tts_default_model_id` and the
     `ANIMAMA_ELEVENLABS_REALTIME_TTS_DEFAULT_MODEL_ID` variable; there is one
     realtime model.
   - `resolve_realtime_tts_model_id` returns v4 Turbo and maps legacy explicit
     values.
4. **Token and session** (`elevenlabs_service.py`):
   - Mint `ttd_websocket` single-use tokens. The SDK's `SingleUseTokenType` lacks
     it, so call `POST /v1/single-use-token/ttd_websocket` through the SDK with a
     typed cast, or directly with the shared `httpx` client. Never log the token.
   - The session sets `sync_alignment=True`.
   - Rename `mint_tts_websocket_single_use_token` accordingly.
5. **Browser runtime** (`use-elevenlabs-tts-runtime.ts`):
   - **Direct URL:** `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`
     with `model_id`, `output_format`, `sync_alignment`, `single_use_token` and
     an optional `language_code`. URL redaction is kept in logs.
   - **Direct protocol:**
     - On open, send `{"voices": [voice_id]}`.
     - Send each chunk as `{"inputs": [{"text": chunk + " ", "voice_id"}]}`.
     - Send `{"flush": true}` once, after the run's first chunk.
     - Send `{"keep_alive": true}` after 10 s without a sent message, until the
       run ends.
     - End with `{"close_socket": true}`.
     - End on `is_final`, and also accept `isFinal`.
     - Treat `{message, error, code}` messages and abnormal closes as failures,
       with the existing notice and the text intact.
   - **Server transport:**
     - Keep `{"text": chunk}` frames and the `{"text": ""}` end, the shape
       Cloud validates.
     - Accept `is_final` or `isFinal`.
     - Ignore an `alignment` field until Phase 3.
   - **Teardown:** cancel, supersede and stop close the socket at once,
     releasing the dialogue session. Late frames for an old run are ignored, as
     today.
6. **Settings** (`preferences.ts`, `ApplicationSettingsModal.tsx`,
   `elevenlabs-chat-tts-dispatch.ts`, `useChatSession.ts`):
   - The options are "Eleven v4 Turbo" (realtime, fastest, default) and the
     existing "Eleven v3" (finalized) until Phase 2.
   - `DEFAULT_ELEVENLABS_TTS_MODEL_ID = "eleven_v4_turbo"`.
   - `toElevenLabsTtsModelId` maps the retired realtime ids at every read
     (chat dispatch and settings), so old ids are never sent. The stored value
     is replaced the next time App Settings writes the ElevenLabs model: the
     Text-to-Speech switch, the provider or the model selector. See the Phase 1
     implementation notes for why this replaced the earlier write-on-load idea.
7. **Contracts and client:**
   - `local-http` 6.0.0 in `contracts/versions.json`, mirrored in
     `hosted-web.md` and `http-api.md`.
   - Bump `runtime-contracts`, and bump `product-ui` if its types change.
   - Run `pnpm openapi-ts` offline.
   - Re-record `tts-realtime.sse` with `CHAT_SSE_GOLDEN_RECORD=1`.
8. **Docs:**
   - The realtime sections of `docs/frontend/runtime/elevenlabs-tts.md` and
     `docs/backend/integrations/voice-and-speech.md`: models, the dialogue
     socket, the token type, flush, keep-alive, migration and the removed
     variable.
   - The realtime-descriptor model id in `contracts/hosted-web.md`.

Tests (TDD where behavior changes):

- **Backend:**
  - legacy realtime ids map in `PyAnimaTtsRunOptions` and still yield a reply;
  - the session descriptor carries v4 Turbo, a `ttd_websocket` token and
    `sync_alignment: true`;
  - the minted token type;
  - the realtime golden fixture;
  - `eleven_v3` finalized tests unchanged.
- **Runtime** (`use-elevenlabs-tts-runtime.test.ts`,
  `tests/speech/elevenlabsTtsRuntime.test.ts`), with a fake `WebSocket` and fake
  timers:
  - URL and query, and the first message;
  - input frames with trailing spaces, and the single flush;
  - `keep_alive` after 10 s idle, and `close_socket` at completion;
  - the `is_final` end;
  - an error message ending the run with the notice;
  - server-transport frames unchanged, ending on either marker;
  - cancel closing the socket.
- **Preferences and dispatch:** `preferences.test.ts` migrates both realtime
  ids and the default; the dispatch test covers v4 Turbo.
- **Regressions:**
  - `use-tts-playback.test.tsx` Pocket-fallback cases;
  - `chat-lifecycle.test.mjs`;
  - `hosted-workflows.browser.test.mjs` server-socket cases.

Checks:

- `uv run pytest -q` (focused, then full), `uv run ruff check` and
  `make check-test`;
- `uv run --no-sync python scripts/repository-boundary/check-python-imports.py`;
- from `src/frontend`: `pnpm openapi-ts`, `pnpm check`, `pnpm web:lint`,
  `pnpm web:test` and `pnpm desktop:test`.

Live (G1), on the task stack and desktop dev against it:

- 5 replies each on web and desktop: first audio after the first segment,
  median recorded against the spike's Flash baseline (862 ms);
- a reply after a pause longer than 20 s, using a debug delay or a scripted
  runtime check;
- cancelling mid-reply stops audio and closes the socket;
- Japanese, Korean and Chinese replies are spoken (streamed path, D9
  verification).

Completion:

- Median first audio is at most 300 ms on both surfaces.
- Checks and review pass.
- Commit `feat(voice)[p1]: stream realtime replies with Eleven v4 Turbo`.

#### Phase 1 implementation notes

- **Migration happens at read time.** The plan first proposed that the
  settings modal write the replacement id when it loads a retired value. That
  would save settings without any owner action, merely because the modal was
  opened. Instead, every read goes through `toElevenLabsTtsModelId`, so no
  retired id reaches the backend. The backend's `PyAnimaTtsRunOptions`
  validator maps the same ids for tabs opened before the upgrade.
- **Protocol helpers.** The runtime keeps a protocol per socket: `dialogue`
  for the direct session, `server` for the hosted transport. It pairs that with
  the voice id registered on the socket, so each frame matches the session that
  opened it.
- **No `product-ui` bump.** Its declarations do not change: its types use
  `string`, and its built output has no `eleven_*` literals (confirmed in
  review). `local-http` 6.0.0 and `runtime-contracts` 0.6.0 carry the enum
  change.
- **Worktree setup.** The new worktree's Git LFS files were pointers. `git lfs
  pull` was needed before `pnpm web:lint` and the stack's speech worklet would
  work.

#### Phase 1 results

Results are on the initial Phase 1 source (`git diff b8ef2dcf`, snapshot
`26be5c5a818567da`) unless marked otherwise. The final source after both review
rounds was re-verified: see the end of the Code Review #2 Revisions.

- **Backend:**
  - `make check-test`: typed-content audit, `ruff format --check` (832 files),
    `ruff check` and mypy (832 files) clean; pytest 4,123 passed and 29
    skipped, in 8 min 12 s.
  - Golden fixture `tts-realtime.sse` re-recorded: `model_id` is now
    `eleven_v4_turbo` and `sync_alignment` is `true`.
- **Frontend:**
  - `pnpm check`, `pnpm web:lint` and `pnpm prettier:check` pass.
  - `pnpm web:test`: Vitest 470 files (4,201 passed, 1 skipped), plus every
    node and browser suite, including both hosted server-socket browser tests.
  - `pnpm packages:test`: product-ui 30 of 30. `pnpm desktop:test`: 506
    passed and 14 skipped.
  - `pnpm openapi-ts` regenerated the client; the reviewer's
    `openapi-ts:check` confirmed it is current.
- **Live web check (G1)** on the task stack `animama-ev4`
  (`http://animama-ev4.localhost:8460`, development mode). Setup: Annie with the
  default voice, OpenAI chat. The page WebSocket was instrumented, with the
  token redacted.
  - **First audio after the first input frame:** 265, 141, 157, 143 and 155 ms
    over 5 replies. The median is **155 ms**, against 862 ms for Flash v2.5 in
    the spike.
  - Every reply used `/v1/text-to-dialogue/stream-input` with
    `sync_alignment=true` and alignment frames. Each ended on `is_final` with
    close 1000 and no errors. The frames were `voices`, `inputs`, `flush`, any
    further `inputs`, then `close_socket`.
  - **Long pause:** the reply's speech events were held in the page for 25 s,
    simulating a slow model. The socket sent `keep_alive` at 10.1 s and
    20.1 s. The speech arrived at 27.6 s and spoke, with first audio 158 ms
    later and close 1000.
  - **Cancel:** with a reply's speech held, Stop closed its open dialogue
    socket 46 ms after the click (close 1005), after two keep-alives.
  - **Japanese (D9, streamed path):** the input frame carried
    「おはようございます！今日はどんな感じですか？」. It spoke 2.2 s of audio,
    with first audio in 181 ms and close 1000.
  - **App Settings → Voice** shows "Eleven v4 Turbo", with "Realtime speech
    that starts while the reply is written".
- **Live desktop check (G1):** the unpackaged Electron shell ran against the
  same stack with an isolated profile (`ANIMAMA_DESKTOP_DEV_USER_DATA` in the
  scratch area), driven over a local CDP port. First audio was 177, 155, 131,
  184 and 154 ms, a median of **155 ms**. All 5 replies were final, with close
  1000 and no errors.
- **Provider probe:** a reply with no speech registers the voice, then sends
  `close_socket` with no text. ElevenLabs answers `{"is_final": true}` and
  closes cleanly, so the runtime ends quietly with no notice.
- **Spend (G1):** about 2,100 characters of v4 Turbo across the live checks,
  roughly US$0.08. Total spent from the US$1 budget is about US$0.10.
- **Limits:** the 25 s pause was simulated by holding the chat stream in the
  page, not produced by a slow model. Audio was confirmed as received bytes and
  timing, not by ear; listening is G2.

#### Code Review #1 Findings

Reviewer: independent `sdlc-reviewer`. Reviewed source: the uncommitted tree
against `b8ef2dcf`, with diff snapshot `26be5c5a818567da` unchanged before and
after review.

The reviewer's checks:

- `ruff check` and `ruff format --check` clean;
- mypy on the changed files clean;
- repository import boundary clean (0 forbidden edges);
- 166 focused backend tests passed;
- `pnpm openapi-ts:check` current;
- 55 focused Vitest tests passed;
- prettier and eslint on the changed web files clean;
- the protocol checked against ElevenLabs' AsyncAPI for the dialogue socket.

Result: one blocking finding; the code is otherwise correct.

- **P1-R1-F1 (blocking).** `docs/frontend/runtime/voice.md:79` still said
  realtime Flash and Multilingual models stream from text chunks. The Phase 2
  id search would not catch this prose.
- **P1-R1-F2 (optional, test gap).** The final-message test would still pass
  if the runtime ended on `is_final_audio_for_turn`. That regression would cut
  every reply off after its flushed first chunk. Audio arriving together with
  `is_final` was also untested.
- **P1-R1-F3 (optional, docs).** "Later chunks are not flushed, so the reply
  keeps one prosody turn" is inaccurate. The first flush makes a second turn.
- **P1-R1-F4 (optional, comments).** The service and test comments claimed the
  browser keeps timing as lip-sync evidence. In Phase 1 it does not.
- **P1-R1-F5 (optional, plan accuracy).** The plan referred to missing
  implementation notes. It overstated when the stored value is replaced, and
  named the map `LEGACY_...` instead of `RETIRED_...`.
- **P1-R1-F6 (optional, consistency).**
  `replace_retired_elevenlabs_tts_model_id` stripped only for the lookup, so a
  padded retired id was accepted while a padded current id was refused.
- **P1-R1-F7 (optional, robustness).** Input frames took `voice_id` from
  `providedSession`, while the `voices` registration used the session captured
  when the socket opened. An empty fallback would silently send an invalid id.
- **P1-R1-F8 (optional, docs).** A missing paragraph break in
  `elevenlabs-tts.md`.
- **Note:** a reply with no speech sends `voices`, then `close_socket`; the
  provider's response was unmeasured.

#### Code Review #1 Revisions

- **F1, accepted:** the provider table now says realtime Eleven v4 Turbo
  streams text chunks over the Text to Dialogue socket. The ElevenLabs section
  links the protocol.
- **F2, accepted:**
  - The test now asserts the stream continues after a mid-reply
    `is_final_audio_for_turn`, plays more audio, and ends only on `is_final`.
  - A new test covers audio together with `is_final`.
  - Mutation check: ending on the turn marker fails the test; restored, 9 of 9
    pass.
- **F3, accepted:** the docs now say "so the rest of the reply stays in one
  prosody turn".
- **F4, accepted:** the comments now say only that timing is requested.
- **F5, accepted:** implementation notes added. The replacement trigger is now
  stated as App Settings' TTS switch, provider and model writes. The map name
  is corrected.
- **F6, accepted:** the map is now an exact lookup. `resolve_realtime_tts_model_id`
  still strips its input first.
- **F7, accepted:** the runtime stores `voiceId` with the socket's protocol
  when the socket is created. Frames use it and are not sent without it.
- **F8, accepted:** paragraph break added.
- **Note, verified:** see the provider probe under Phase 1 results.

Post-revision source: `git diff b8ef2dcf` snapshot `67257293ded4ab68`. Eight
files changed in the revisions:

- `docs/frontend/runtime/elevenlabs-tts.md`, `docs/frontend/runtime/voice.md`
  and the plan;
- `src/backend/animama/app/contracts/elevenlabs.py` and
  `src/backend/animama/server/elevenlabs_service.py`;
- the realtime runtime and its socket test;
- `tests/test_elevenlabs_realtime_router.py`.

Checks after the revisions:

- `ruff check` (src/backend, tests) clean;
- `ruff format --check` and mypy on the changed Python files clean;
- pytest 166 passed (ElevenLabs service and router, chat SSE, golden, chat
  turns);
- `pnpm check`, `pnpm web:lint` and `pnpm prettier:check` pass;
- Vitest `src/hooks`, `src/lib/settings`, `src/lib/chat` and `tests/speech`:
  29 files, 256 passed.

Repair budget: round 1 of 2 used.

#### Code Review #2 Findings

Targeted recheck by the same reviewer of snapshot `67257293ded4ab68`, using an
interdiff rebuilt from the Round 1 snapshot. Result: **pass**. All eight fixes
were verified, and each new test fails under the regression it targets.

The reviewer's checks:

- ruff, ruff format, and mypy on the changed files;
- pytest 166 passed, plus the docs-mode tests (20 passed);
- Vitest 6 files, 56 passed;
- prettier and eslint on the runtime and test;
- `check:source`.

- **P1-R2-F1 (optional, latent; caused by the F7 revision).** The new
  `!voiceId` guard gated both protocols. A session with an empty `voice_id`
  would then hold its frames:
  - on the server protocol, it would also depart from the documented
    `{text}` sequence;
  - on the dialogue socket, frames would be held silently until the provider
    rejected the session.

  There is no current impact: Cloud issues only allowlisted voices, and the
  local backend refuses blank voices with 409.
- **P1-R2-F2 (optional, bookkeeping).** The revision record should name the
  revised snapshot, the changed files and the post-revision checks. The
  results lead-in implied that older suites cover the revised runtime.
- **Cosmetic:** the edited `voice.md` table row is wider than the aligned
  header. It renders fine, and `docs/` is not Prettier-enforced.

#### Code Review #2 Revisions

- **F1, accepted:**
  - `startRun` now refuses a direct (dialogue) session whose `voice_id` is
    blank before opening a socket. The failure surfaces as the existing
    `elevenlabs_start_failed` notice.
  - `flushQueuedFrames` no longer checks the voice, so server sessions keep
    their frames.
  - A new test covers the refusal: no socket is opened and the warning is
    shown.
- **F2, accepted:** the results lead-in now names the source it covers. This
  record lists the revised snapshot, the changed files and the checks.
- **Cosmetic, not changed:** the table renders correctly, and realigning it
  would reformat an unrelated part of a file that was not Prettier-clean
  before.

Final Phase 1 source: verified after the round-2 revisions.

- `pnpm check`, `pnpm web:lint` and `pnpm prettier:check` pass.
- Vitest runtime, socket, `elevenlabsTtsRuntime` and use-tts-playback tests:
  39 passed.
- `pnpm web:test` full run (snapshot `723a423371d732e6`, which was the
  committed Phase 1 source):
  - Vitest 470 files: 4,203 passed and 1 skipped.
  - Node and browser suites: 220 of 220 passed, including both hosted
    server-socket browser tests.
  - An earlier full run on the same source had one failure in the untouched
    `src/app/hosted-runtime/hosted-composition.test.ts`: the "eof" admission
    case counted 3 reads instead of 2 under fake timers. That file passed 5 of
    5 isolated reruns and the complete rerun. It is timing-sensitive under
    load, and this change does not touch its code paths.
- **Live web reply on the stack (hot-reloaded source):** first audio 144 ms,
  6.2 s spoken, `is_final`, close 1000, no errors.

Repair budget: rounds 1 and 2 of 2 used.

#### Code Review #3 Findings

Final targeted recheck of snapshot `723a423371d732e6`, using an interdiff of
three files: the runtime, its socket test and the plan.

Result: **pass**. Both round-2 fixes were verified with no regression:

- server frames no longer depend on the voice;
- a blank direct voice fails before any socket, URL or audio resource is
  created, and only while its run is active;
- the new test fails without the guard.

The reviewer's checks:

- Vitest on the 4 runtime test files, 39 passed;
- prettier and eslint on the changed files clean;
- `check:source` passed;
- the hosted-composition test passed 5 of 5 isolated reruns;
- an import-graph trace showed that test does not reach the changed runtime.

The only open item was recording the full `web:test` result, which is now done
above.

Phase 1 review: **passed**, using one full review and two repair rounds.

### Phase 2: finalized v4, model cleanup and every language

Issue: #481. Requirements: R2, R3 (finalized and cleanup), R6 and R7. Depends on
Phase 1.

Outcome:

- Finalized replies speak with `eleven_v4` over Text to Dialogue HTTP with
  timestamps, with stitching and the tone tag.
- `eleven_v3` is gone and migrates to `eleven_v4`.
- The utility route speaks v4.
- Finalized v4 and Gemini speak Japanese, Korean, Chinese and Spanish sentences.
- Timing is parsed in the backend but not yet emitted (Phase 3). As built, the
  stream requests timing but leaves parsing to Phase 3 (see the implementation
  notes).

Changes:

1. **Models and migration:**
   - The finalized literal becomes `Literal["eleven_v4"]`, and the chat union
     `eleven_v4_turbo | eleven_v4`.
   - Add `eleven_v3` → `eleven_v4` to `RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS`.
   - Frontend: the "Eleven v4" option (finalized, highest quality, speaks each
     sentence once written) replaces "Eleven v3", and
     `isElevenLabsFinalizedTtsModelId` is true for `eleven_v4`.
   - Relabel the grouping row and the "Unavailable with Eleven v3" text. Keep the
     stored key `tts_elevenlabs_v3_finalized_chunking` and the current
     `"paragraph"` default; correct the docs that say `"sentence"`.
2. **Finalized provider call** (`elevenlabs_service.py`):
   - Use Text to Dialogue `stream/with-timestamps` with `inputs=[{text, voice_id}]`,
     `model_id`, `language_code`, `apply_text_normalization="off"` and
     `pcm_24000`.
   - Continuity: `previous_request_ids` (the run's last ≤3 ids, from each
     response's `request-id` header), else `previous_text` (≤100 characters).
   - The installed SDK's dialogue stream lacks both parameters and the header,
     so prefer a direct streamed request through the shared `httpx` client.
     Record the choice.
   - Parse the NDJSON `audio_base64` and `alignment`, and keep the PCM framing
     (`pop_pcm_audio_frame`).
   - Keep the alignment in ms on the yielded internal `audio` events.
   - Remove the v3 `previous_text` omission.
   - `FinalizedTtsStreamBootstrap` keeps the run's last three request ids.
3. **Tone:** rename `elevenlabs_v3_text_with_emotional_prefix` to a model-neutral
   name and apply it for `eleven_v4`. Bound the ElevenLabs `previous_text` to
   100 characters; Gemini's bound is unchanged.
4. **Chat speech** (`tts.py`, `sse_events.py`):
   - Replace the `"eleven_v3"` literals with the finalized model set.
   - `_uses_previous_text` is true for ElevenLabs.
5. **Utility route:**
   - Text to Dialogue `convert` with v4 by default.
   - `PyElevenLabsVoiceSettings` keeps `stability` and `similarity_boost`
     (mapped to `similarity`); drop `style`, `use_speaker_boost` and `speed`.
   - Delete the unused `PyElevenLabsRealtimeTtsSessionRequest` and
     `PyElevenLabsFinalizedTtsStreamRequest` after confirming they have no users.
   - Nothing calls `text_to_speech.*` for speech any more.
6. **Remove the gruut gate (D9):**
   - `_attach_tts_speech_payload` prepares a segment from the speech text
     whatever gruut returns.
   - When gruut yields English phonemes, the segment keeps `tts_text`,
     `tts_phonemized_text` and the `gruut_text_with_ws` basis, so English
     lip-sync is unchanged.
   - Otherwise the segment speaks the visible text (`visible_text` basis) with
     no phonemes.
   - Revisit `server/finalized_speech.py` and the frontend selector so both
     bases work.
   - If gruut's cost on non-English text matters (the #468 brief measured
     294–549 ms on Korean), skip gruut for text with no Latin letters. Record
     the measurement and the choice.
7. **Contracts, client and docs:**
   - Fold into the same `local-http` 6.0.0 bump (one PR).
   - Bump `runtime-contracts`; run `pnpm openapi-ts`.
   - Re-record `tts-finalized.sse`.
   - Update the finalized and language sections of the docs.

Tests:

- **Backend:**
  - finalized v4 sends the tone tag and frames PCM in sentence and paragraph
    modes;
  - it stitches request ids from the second request on, and falls back to
    `previous_text` after a failed or id-less request;
  - a failed batch emits `tts.error` without `tts.done`;
  - legacy `eleven_v3` maps;
  - utility-route default and settings mapping;
  - ja, ko, zh and es sentences produce segments and are spoken, for both v4
    and Gemini (fake providers);
  - English segments keep their gruut payload;
  - golden fixtures.
- **Frontend:**
  - `preferences.test.ts` migrates `eleven_v3`;
  - the dispatch test covers v4 finalized;
  - `chat-lifecycle.test.mjs` and `use-tts-playback.test.tsx` fixtures move to
    `eleven_v4`;
  - the TTS payload selector handles both text bases.

Checks: as in Phase 1, plus `pnpm build`.

Live (G1):

- One finalized v4 reply (two sentences, then paragraph mode), with first-audio
  time and characters.
- One stitched and one `previous_text` rendering of the same two sentences, for
  G2.
- One Japanese and one Korean finalized v4 reply, and one Gemini Japanese reply.

Completion:

- Checks and review pass.
- `git grep -E "eleven_v3|eleven_flash_v2_5|eleven_multilingual_v2"` finds only
  the migration map, its tests and history in `docs/plans/`.
- Commit `feat(voice)[p2]: speak finalized replies with Eleven v4 in every language`.

#### Phase 2 implementation notes

- **SDK, not a direct request.** Step 2 preferred a direct `httpx` request
  because the SDK's dialogue stream names neither continuity field nor exposes
  the `request-id` header. `client.text_to_dialogue.with_raw_response.stream_with_timestamps`
  exposes the headers, and `request_options={"additional_body_parameters": ...}`
  sends `previous_request_ids` or `previous_text`. The SDK path keeps its error
  types and the shared connection pool, so no parallel client was added.
  The SDK builds typed error bodies (such as a 422) without validation;
  `_api_error_body` dumps them as found.
- **Alignment waits for its consumer.** The stream already requests timestamps,
  but Phase 2 does not parse or keep `alignment` (step 2's "keep the alignment
  in ms"). Nothing would read it before Phase 3, which adds the timing frames,
  so the parsing lands there with its tests. Phase 3 needs no provider change.
- **Normalization follows gruut's preparation.** `finalized_tts_text` reports
  whether gruut prepared the text, and the prepared request carries
  `apply_text_normalization`: `"off"` for text gruut prepared, `"auto"` for text
  sent as written, so the provider verbalizes numbers in other languages.
- **The gruut rule (step 6, D9).** gruut prepares text whose letters are all
  ASCII (`gruut_prepares_text`); typographic punctuation, symbols and emoji do not
  count. Every other sentence is spoken as written, with the `visible_text` basis
  and no tts fields on its SSE frame. The spike measured gruut's cost per
  sentence at 167 ms (Korean), 122 ms (Spanish), 24 ms (Japanese and Chinese) and
  6 ms (English), and found that it verbalizes digits in English inside Spanish.
  Two known limits remain until the reply carries its speech language:
  - letters-only ASCII text in another language, such as unaccented Spanish,
    still goes through gruut's English normalization, as before this change;
  - an English sentence with an accented loanword ("café") is spoken as
    written.
- **Request limit.** Text to Dialogue documents 2,000 characters across a
  request's inputs; longer streamed requests can end early. A longer segment is
  spoken as consecutive requests (`dialogue_request_texts`), each stitched to
  the one before, and the utility route's `text` is bounded at 2,000.
- **Continuity.** A request with no earlier request ids sends `previous_text`
  instead, bounded to its last 100 characters (the dialogue API's limit; Gemini
  does not use it). Each response's `request-id` joins a per-run deque of three,
  so a failed or id-less request leaves the earlier ids in place.
- **Grouping.** The default stays `"paragraph"`; the docs now say so. The
  `V3FinalizedChunking` identifiers became `FinalizedChunking`, but the stored
  key `tts_elevenlabs_v3_finalized_chunking` is unchanged so saved preferences
  keep working.
- **Utility route.** Text to Dialogue `convert` with `eleven_v4` by default.
  `PyElevenLabsVoiceSettings` keeps `stability` and `similarity_boost`, which is
  sent as `similarity`. The unused session and stream request schemas are gone.
- **Development stack.** The `web` service builds the workspace packages once
  at start, into tmpfs. After `pnpm openapi-ts`, the request validator kept the
  Phase 1 enum and refused `eleven_v4` until the task stack's `web` service was
  restarted. The development docs now say so.

#### Phase 2 results

- **Backend:** `make check-test` passed on the Phase 2 source: pytest 4,148
  passed and 29 skipped (5 min 52 s), with format, lint, mypy and the
  typed-content audit clean. After the `_api_error_body` change, the ElevenLabs
  service and router tests (48) passed with `UserWarning` as an error, and
  ruff, ruff format and mypy on the file were clean.
- **Golden fixture:** `tts-finalized.sse` re-recorded; only `model_id` changed.
- **Live web check (G1)** on `animama-ev4` (Annie, OpenAI chat, App Settings
  default provider; summaries in `evidence/phase2/web-live.json`). First audio
  is measured from the first `user.response` frame to the first `tts.audio`
  frame:

  | Reply                                  | Grouping  | First audio | Audio  | Errors |
  | -------------------------------------- | --------- | ----------- | ------ | ------ |
  | English, 4 sentences, `eleven_v4`      | paragraph | 1,319 ms    | 18.0 s | none   |
  | English, 4 sentences, `eleven_v4`      | sentence  | 606 ms      | 20.7 s | none   |
  | Japanese, 3 sentences, `eleven_v4`     | sentence  | 695 ms      | 7.1 s  | none   |
  | Korean, 2 sentences, `eleven_v4`       | sentence  | 744 ms      | 3.4 s  | none   |
  | Japanese, 2 sentences, Gemini Flash-Lite | sentence | 1,551 ms   | 6.4 s  | none   |

  The Japanese and Korean replies have no tts fields on their frames, so both
  were spoken as written. The sentence segmenter splits only at ASCII `.!?`
  followed by a space, so a Japanese or Chinese reply's speech is one segment
  that arrives when the speech ends. The Japanese rows are therefore one request
  each, and their first-audio figures are not comparable with the English ones
  (Code Review #1, F4). App Settings → Voice shows "Eleven v4 Turbo" and
  "Eleven v4", the grouping row, and "Unavailable with Eleven v4." for chunked
  streaming.
- **Stitching (G2 samples):** `evidence/phase2_stitching.py` speaks the same
  four sentences through `prepare_finalized_tts_stream_from_text` and
  `stream_finalized_tts_chunks`, once with request ids and once with
  `previous_text` only. All 8 requests returned audio and a `request-id`. The
  provider accepted 1, 2 and 3 previous ids. First audio per request was
  366–646 ms. The two renderings are `evidence/phase2/stitched.wav` and
  `evidence/phase2/previous_text.wav`, for the owner to compare by ear (G2).
- **Spend (G1):** about 1,100 characters of v4, roughly US$0.05. Total spent
  from the US$1 budget is about US$0.15.
- **Limits:** audio was confirmed as received bytes and timing, not by ear;
  listening is G2. The stitching effect has not been judged.

#### Code Review #1 Findings

Reviewer: independent `sdlc-reviewer`. Reviewed source: the uncommitted tree
against `51f4bee1`, with diff snapshot `3cb814918864373a` unchanged before and
after review.

The reviewer's checks:

- `ruff check`, `ruff format --check` (19 files) and mypy (11 files) clean;
- import boundary clean (0 forbidden edges);
- focused pytest 438 passed (ElevenLabs service and router, chat SSE, golden,
  Gemini, chat turns, structured response, SSE events, gruut and related);
- `pnpm openapi-ts:check` current;
- Vitest on 6 changed web test files, 63 passed;
- product-ui `chat-lifecycle` 30 of 30, including both allowance → Pocket TTS
  cases;
- prettier and eslint on the 9 changed web files clean;
- probes with real gruut, the SDK's chunk decoding and convert body, the
  segmenter, and the built declarations.

Not run by the reviewer: the full gates, the package-set build and compare, and
live calls.

Result: two blocking findings.

- **P2-R1-F1 (blocking).** The ASCII gate dropped gruut preparation for common
  English sentences. A curly apostrophe, an em dash, an ellipsis or an emoji made
  `text.isascii()` false, so such a sentence lost its `tts_*` fields and was
  spoken as written. That breaks R7 ("English keeps today's prepared text"),
  R2 (Gemini "as before") and step 6. With real gruut, `"That’s great! See you
  at 3:30."` went to the provider with its digits and normalization `"auto"`.
- **P2-R1-F2 (blocking).** The JSDoc on product-ui's exported
  `ChatSpeechPolicy.finalizedServerAudio` changed, which changes its emitted
  declarations, but product-ui stayed 0.9.0. The package-set compare requires a
  version bump for any declaration change.
- **P2-R1-F3 (optional).** `apply_text_normalization` followed whether the
  provider text was ASCII, not whether gruut prepared it, and the rule was
  computed in three places on three strings.
- **P2-R1-F4 (optional, pre-existing).** The segmenter splits only at ASCII
  `.!?` followed by whitespace. Japanese and Chinese speech is one segment, so
  it is spoken only after the whole speech is written, as one request.
- **P2-R1-F5 (optional, pre-existing).** The input-basis gruut call still runs
  on every speech value, including Korean (167 ms a sentence).
- **P2-R1-F6 (optional).** R2's 2,000-character request bound was neither
  enforced nor tested. Sentence mode sends a segment of any length, and with F4
  a whole Japanese reply is one request.
- **Verified with no finding:** failure paths (`tts.error` without
  `tts.done`), request-id bookkeeping, the SDK raw path and cancellation, the
  `eleven_v3` migration, retired ids, Gemini, the security and ownership
  constraints, contract versions and the development-docs claim.

#### Code Review #1 Revisions

- **F1, accepted.** `gruut_prepares_text` now considers letters only: text
  whose letters are all ASCII is English, whatever its punctuation, symbols or
  emoji. Accented, CJK and Hangul letters still send the text as written, so D9
  is unchanged. The remaining limit, an English sentence with an accented
  loanword, is recorded in the notes and the docs.
  - Tests: gruut rule cases for `’`, `—`, `…`, an emoji and digits, and for
    Japanese, Korean, Chinese, accented Spanish and the loanword; a chat test
    in which English speech with typography keeps the `gruut_text_with_ws`
    basis on its frame and its request.
  - Mutation check: with the old ASCII rule, 6 of the new cases fail.
  - Live: the English reply "I’d make a cozy chicken-and-veggie stir-fry
    tonight — ready around 7:30." kept the gruut basis and was spoken as
    "…ready around seven thirty." with `eleven_v4`, with no errors.
  - Docs aligned: `voice-and-speech.md`, `elevenlabs-tts.md`,
    `avatar-lipsync.md` and `docs/backend/runtime/chat.md`.
- **F2, accepted.** product-ui is 0.9.1 (a comment-only declaration change),
  mirrored in `contracts/hosted-web.md`.
- **F3, accepted.** `finalized_tts_text` returns the text and whether gruut
  prepared it. `prepare_finalized_tts_stream_from_text` records
  `apply_text_normalization` on the request, and the stream sends it, so the
  rule is decided once. Tests cover gruut text (`"off"`), gruut returning
  nothing (`"auto"`) and Japanese (`"auto"`, gruut not called).
- **F4, deferred.** The segmenter predates Phase 2, also shapes visible text
  streaming, and R7's acceptance is met. The limit is recorded in the results.
  A follow-up to split CJK speech at `。！？` is proposed to the owner.
- **F5, rejected for this phase.** That call feeds lip-sync's `phonemized_text`
  for every language. What non-English lip-sync receives belongs to #468
  (D11, R7), and Phase 2 already removed the second gruut call.
- **F6, accepted.** ElevenLabs documents 2,000 characters across a Text to
  Dialogue request's inputs; longer streamed requests can end early (API
  reference and 2026-04-20 changelog).
  - `stream_finalized_tts_chunks` now speaks a longer segment as consecutive
    requests. `dialogue_request_texts` cuts after the last sentence end in the
    second half of the window, else a clause break, else a space, else at the
    limit. Each request is stitched to the one before; the tone tag stays on
    the first, and `done` carries the last request id.
  - The utility route's `text` is bounded at 2,000 (was 5,000, the v3 limit),
    and the client was regenerated. No frontend code calls that route.
  - Tests: splitter cases (short, sentence, CJK, clause, space, no break) and a
    stream test in which a 3,000-character segment becomes two requests within
    the limit, the second stitched to the first's id.

Post-revision checks, on the revised source:

- `make check-test`: pytest 4,171 passed and 29 skipped (7 min 6 s), with
  `ruff format --check` (832 files), `ruff check`, mypy and the typed-content
  audit clean. The Pydantic serializer warning from the refusal test is gone.
- The ElevenLabs router and gruut tests (46) pass with `UserWarning` as an
  error.
- `pnpm openapi-ts:check` (current), `packages:build`, `packages:test`
  (product-ui 30 of 30), `pnpm check`, `pnpm web:lint`, `pnpm prettier:check`
  and `pnpm build` pass.
- Vitest on the speech, chat, settings and runtime tests: 22 files, 213 passed.
- The full `pnpm web:test` (Vitest 470 files: 4,204 passed and 1 skipped; node
  and browser suites 220 of 220) and `pnpm desktop:test` (506 passed and 14
  skipped) passed on the source before these revisions. The revisions change
  the backend, the generated client's utility-route bound, one product-ui
  version and docs, which the checks above cover.

Repair budget: round 1 of 2 used.

#### Code Review #2 Findings

Targeted recheck by the same reviewer of snapshot `26c1f2357de0fb91`, unchanged
before and after. Result: **pass**, with no blocking findings.

- **Verified fixes:**
  - F1: with real gruut, typographic English keeps `gruut_text_with_ws` and
    `"off"`;
  - F2: product-ui 0.9.1 satisfies the compare rule, and nothing else pins the
    version;
  - F3: normalization is decided once;
  - F6: each split request closes before the next opens; cancellation and
    errors release the semaphore; the PCM buffer carries across requests; the
    tone tag stays first.
- **Dispositions:** the F4 deferral is sound; the splitter also bounds a long
  one-segment Japanese reply, which a 2,420-character probe cut after `。`. The
  F5 rejection is acceptable as a scope call. Its rationale needs a correction:
  for Japanese, Korean and Chinese, the input-basis call yields no phoneme
  words.

The reviewer's checks:

- ruff, ruff format and mypy on the changed files;
- import boundary clean;
- pytest 295 passed on the affected files;
- the router, gruut and service tests, 70 passed with `UserWarning` as an
  error;
- `openapi-ts:check` current;
- probes of the real segmenter, gruut and the splitter.

Optional findings:

- **P2-R2-F1.** An emoji after the last sentence became its own segment (`"
  😊"`), which was spoken alone as `"😊"` with normalization `"auto"`. This
  happens in every sentence-mode reply that ends with an emoji, Gemini
  included. The provider's response is unverified and could be an error notice
  after a fully spoken reply. The baseline's gate dropped such a segment. The
  new chat test's fake gruut returned text for an emoji, which hid it.
- **P2-R2-F2.** An ASCII `.` counted as a sentence end with no space after it,
  so a long segment could be cut inside a number: a 2,007-character probe was
  cut at `"cuesta 3."` / `"5 euros"`.
- **P2-R2-F3.** `done` reported only the last request id of a split segment,
  so the reply's three-id history skipped the earlier ones.

#### Code Review #2 Revisions

- **R2-F1, accepted.** `_attach_tts_speech_payload` speaks only segments with a
  letter or digit. Whitespace, punctuation or emoji alone stays visible text
  and is not spoken, as at the baseline. The chat test's fake gruut now returns
  nothing for such text, as gruut does. A new test, for ElevenLabs and Gemini,
  checks that `"See you tomorrow! 😊👋"` prepares only `"See you tomorrow!"`,
  keeps the emoji visible, and ends with `tts.done` and no `tts.error`.
- **R2-F2, accepted.** An ASCII `.!?` ends a sentence only before a space or
  the end of the text; `。！？` end one anywhere. The scan reaches one character
  past the limit so that the lookahead sees the real next character, and only
  breaks that end within the limit count. A new test keeps "3.5" whole and cuts
  at commas.
- **R2-F3, accepted.** `done` carries `request_ids`, every request id of the
  segment in order, and the bootstrap extends its three-id history with them.
  This payload is new in this PR, and the port docstrings say so. The chat
  stitching test now has a segment answered by two requests, and the stream
  test expects both ids.
- **F5 rationale, corrected.** For Japanese, Korean and Chinese the
  input-basis call feeds lip-sync nothing. For accented Latin text it yields
  English phonemes that do move the mouth, so skipping it would change
  non-English lip-sync, which is #468's to decide. The rejection stands.
- **Mutation check:** without each repair, its test fails: both closing-emoji
  cases, the "3.5" case and the chat stitching test.
- **Docs:** `voice-and-speech.md` covers unspoken symbol-only segments and
  `request_ids`.

Post-revision checks: `make check-test` passed: pytest 4,174 passed and 29
skipped (5 min 26 s), with format (832 files), lint, mypy and the typed-content
audit clean. The affected router, gruut and chat SSE tests (171) pass with
`UserWarning` as an error. This round changed no frontend file.

Repair budget: rounds 1 and 2 of 2 used.

#### Code Review #3 Findings

Final targeted recheck of snapshot `dcfef25c2e1099b2`, unchanged before and
after. Result: **pass**. All three round-2 repairs hold, with no regression.

- **R2-F1**, probed with real gruut:
  - a closing emoji still closes the speech stream and adds no segment;
  - digits alone (`"42"`) are spoken as "forty two";
  - corrections, the empty final marker and whitespace behave as before;
  - speech that is only an emoji ends with `missing_tts_text`, as at the
    baseline.
- **R2-F2:** the window edge is handled, every cut makes progress, and the
  probes kept "3.5" whole and a closing quote attached.
- **R2-F3:** no consumer of the singular `request_id` remains, and the deque
  semantics match the test.

The reviewer's checks:

- ruff, ruff format and mypy on the changed files;
- import boundary clean;
- pytest 281 passed;
- 171 passed with `UserWarning` as an error;
- `openapi-ts:check` current.

Optional findings:

- **P2-R3-F1.** ASCII commas and colons could still split a number in a
  segment over 2,000 characters (`"1,"` / `"000"`, `"3:"` / `"30"`). This
  predates round 2.
- **P2-R3-F2.** "Is not spoken" holds for the finalized providers only;
  realtime still receives the visible text, as at the baseline.

Dispositions, applied after the final round and covered by the Phases 1–2
scope review:

- **R3-F1, accepted.** ASCII `,;:` count as breaks only before a space or the
  end; CJK marks count anywhere. The number test adds `1,000` and `3:30`
  cases; both fail without the fix. The router tests (37) pass with
  `UserWarning` as an error, and ruff, ruff format and mypy are clean.
- **R3-F2, accepted.** The docs now say "not spoken by the finalized
  providers".

Phase 2 review: **passed**, using one full review and two repair rounds.
Committed as `c6b87dd2`, before the amendment below.

#### Phase 2 amendment: Eleven v4 Turbo only (owner, 2026-10-12)

After Phase 2 passed review, the owner removed finalized Eleven v4. ElevenLabs
now speaks only with Eleven v4 Turbo, in realtime (see the Decision Log). Hosted
keeps Cloud's server socket, which can speak `eleven_v4_turbo` server-side, so a
finalized model adds nothing there.

Removed:

- the finalized ElevenLabs path:
  - `ElevenLabsFinalizedTtsStream`, `prepare_finalized_tts_stream_from_text`,
    `stream_finalized_tts_chunks` and the request splitter;
  - the stitching (`previous_request_ids`, `previous_text`);
  - the `apply_text_normalization` flag;
  - the tone-tag prefix and `LocalSpeech`'s finalized methods;
- the `eleven_v4` id, the model selector and the audio grouping setting.

Kept from Phase 2:

- D9 for Gemini and realtime: every language is spoken;
- the gruut letters rule, and symbol-only segments that stay unspoken (Gemini);
- the utility route on Text to Dialogue `convert`, now `eleven_v4_turbo`, with
  `text` bounded at 2,000;
- the retired-id map, now with `eleven_v3` → `eleven_v4_turbo`;
- product-ui 0.9.1 and the regenerated client.

Changes:

- **Backend:**
  - `app/contracts/elevenlabs.py` keeps only the realtime model names;
  - `PyAnimaTtsRunOptions.model_id` is `eleven_v4_turbo` or a Gemini id;
  - `FinalizedTtsStreamBootstrap` is Gemini-only;
  - `ProductSpeech` no longer extends `FinalizedSpeechPort`;
  - `FinalizedSpeechPort.prepare_finalized` takes only what Gemini uses;
  - the SSE frame formatters require the provider;
  - `voice_emotional_tone.py` drops the ElevenLabs prefix and continuity
    helpers.
- **Frontend:**
  - `preferences.ts` keeps one ElevenLabs model;
  - App Settings → Voice drops the model and grouping rows, and the
    ElevenLabs provider description names Eleven v4 Turbo;
  - the dispatch builder sends no grouping;
  - `useTtsPlayback` and `useChatSession` treat only Gemini as server-pushed
    audio;
  - product-ui's comment and tests follow.
- **Client** regenerated: the enums now carry `eleven_v4_turbo` only.
- **Backend tests**, converted in a delegated pass and verified:
  - Shared finalized behaviour now runs on Gemini: paragraph batching and
    pauses, segment failure, audio before `run.completed`, early-close
    cancellation, the neutral tone, `tts_text` frames and English typography.
  - ElevenLabs-finalized-only tests are deleted: stitching, "no session for
    v4" and "accepts v4".
  - New tests: `eleven_v4` is refused with a 422; `eleven_v3` speaks in
    realtime with `eleven_v4_turbo`; the utility text is bounded at 2,000;
    Gemini's `finalized_tts_text` follows the gruut rule.
  - The product-http refusal tests use a narrowed `FakeGeminiSpeech`.
  - The golden `tts-finalized.sse` was re-recorded for Gemini; only the
    `provider` and `model_id` fields changed.
  - The delegated run: targeted suites 254 passed; the whole suite (without
    `tests/live`) 4,147 passed and 9 skipped; ruff, ruff format and mypy clean.
    Throwaway runtime patches confirmed that the new assertions catch their
    regressions.
- **Docs and contract:** `voice-and-speech.md` (a generic Finalized TTS
  section, now Gemini), `http-api.md`, `docs/backend/runtime/chat.md`,
  `elevenlabs-tts.md`, `gemini-tts.md` (finalized playback moved there),
  `voice.md`, `avatar-lipsync.md`, `docs/frontend/runtime/chat.md` and
  `contracts/hosted-web.md` (realtime-only declines; why hosted keeps the server
  transport).

Evidence so far:

- Live, Text to Dialogue `convert` with `eleven_v4_turbo`, with and without
  voice settings, returned audio: 43,511 bytes of mp3, about 25 characters
  (`evidence/probe_utility_turbo.py`).
- Live on `animama-ev4`, after restarting its `web` service for the rebuilt
  packages:
  - **ElevenLabs:** with the stored preference still `eleven_v4`, a reply got a
    `tts.session` for `eleven_v4_turbo` (direct, `sync_alignment: true`) and
    spoke 2.2 s over the dialogue socket (final, close 1000), with no
    finalized frames.
  - **Settings:** App Settings → Voice shows neither the model nor the grouping
    row, and ElevenLabs is described as "Realtime ElevenLabs speech with Eleven
    v4 Turbo."
  - **Gemini:** a Japanese reply came as 13 `tts.audio` frames from
    `gemini-3.8-flash-lite-tts` and `tts.done`, with no errors.
- **Frontend gate:**
  - `openapi-ts:check`, `packages:build`, `pnpm check`, `web:lint`,
    `prettier:check` and `build` pass;
  - `packages:test`: product-ui 30 of 30, including the realtime
    allowance-after-text case;
  - `web:test`: Vitest 470 files (4,200 passed, 1 skipped), plus node and
    browser suites 220 of 220;
  - `desktop:test`: 506 passed and 14 skipped.
- **Spend (G1):** about 120 characters (the realtime reply and two short
  `convert` calls), under US$0.01. The total spent from the US$1 budget is about
  US$0.16.
- The Phase 2 finalized v4 live results and the stitching samples remain as
  history. G2 no longer needs the stitching comparison.
- **Backend:** `make check-test` passed: pytest 4,147 passed and 29 skipped
  (6 min 29 s), with format (832 files), lint, mypy and the typed-content audit
  clean.

##### Amendment Code Review #1 Findings

Reviewer: independent `sdlc-reviewer`. Reviewed source: the uncommitted tree on
`c6b87dd2`, snapshot `c587f36dd96e2810`; the only later change was the plan's
own results edit.

The reviewer's checks:

- ruff, ruff format and mypy (21 files) clean;
- import boundary clean;
- pytest 255 passed;
- `openapi-ts:check` current;
- Vitest (36 tests) and product-ui 30 of 30;
- eslint clean;
- the #471 body matching the spec snapshot;
- `git grep` sweeps;
- a counting probe on the finalized error frames.

Result: three blocking findings, each small.

- **P2A-R1-F1 (blocking).** The finalized "no prepared speech" path
  (`missing_tts_text`) lost its only test with the deleted v4 test. A probe
  found 0 such frames across the suites, so mislabelling or dropping the frame
  would pass.
- **P2A-R1-F2 (blocking).** Two docs still described finalized ElevenLabs:
  - `voice.md` said the "finalized stream route returns 409";
  - `docs/frontend/README.md` called `elevenlabs-tts.md` "realtime and
    finalized".
- **P2A-R1-F3 (blocking).** The plan's current guidance contradicted D13:
  - G2 still listed v4 listening;
  - the acceptance mapping kept "Finalized v4";
  - the Legacy restoration step and the purpose and orientation text were
    stale.
- **Optional:**
  - product-ui's `tts.error` allowance fallback is unreachable for ElevenLabs,
    and its JSDoc still named `tts.error`;
  - a vestigial `finalizedProviderRef` default;
  - Gemini's `style: str | None` and a few small simplifications (ports,
    inactive marking, a one-value dispatch parameter);
  - a Prettier drift in `chat-consumer.jsx` and an overlong line in
    `docs/frontend/runtime/chat.md`;
  - a duplicated realtime-model test;
  - naming debt: the finalized runtime and product-ui callbacks named for
    ElevenLabs now serve Gemini;
  - the amendment's spend record;
  - spec R4 and R6 still named "both models".
- **Verified with no finding:**
  - every ElevenLabs request starts a realtime session; `eleven_v3` maps;
    `eleven_v4` is refused;
  - Gemini behaviour is unchanged apart from always being styled;
  - the allowance fallback works before and after the text;
  - the port narrowing breaks no Cloud usage;
  - versions and the client are current;
  - no stray old ids remain.

##### Amendment Code Review #1 Revisions

- **F1, accepted.** New `test_chat_sse_finalized_speech_without_speakable_text_reports_missing_tts_text`:
  Gemini speech of only "😊" ends with exactly one `tts.error`
  (`gemini`, `missing_tts_text`), with no prepare call, no `tts.audio` or
  `tts.done`, and one `run.completed`; the emoji stays visible. It fails when
  the code is mutated.
- **F2, accepted.** `voice.md` now describes the realtime `tts.session.error`
  carrying `status_code` 409 or 503, and the README entry says "ElevenLabs
  realtime TTS with Eleven v4 Turbo".
- **F3, accepted.** The plan now has:
  - D1–D13 in the source line;
  - G1 spend of about US$0.15;
  - G2 as "listens to v4 Turbo" and "a v4 Turbo reply";
  - updated purpose and orientation (no finalized stream, tone prefix,
    `previous_text` bound or finalized model helper);
  - a "One ElevenLabs model (D13)" acceptance row with updated Every language
    and Migration rows;
  - the recovery text pointing at `c6b87dd2` for any finalized restoration.
- **Optional, taken:**
  - the `speech-allowance.ts` JSDoc now says the code arrives on
    `tts.session.error`;
  - `chat-consumer.jsx` is Prettier-formatted and `docs/frontend/runtime/chat.md`
    is rewrapped;
  - the duplicated router test is removed, and the removed `eleven_v4` joins
    the service test's unknown-id cases;
  - the amendment's spend is recorded;
  - spec R4 and R6 now say v4 Turbo, in the snapshot and in #471 (updated
    03:31 UTC).
- **Optional, deferred:**
  - the unreachable product-ui `tts.error` allowance path and the
    ElevenLabs-named finalized runtime and callbacks. Renaming the product-ui
    callbacks changes its public API, so both belong in one follow-up, which is
    proposed to the owner. The path is harmless meanwhile.
  - Gemini's optional style, `finalizedProviderRef`, and the small port and
    bootstrap simplifications: harmless and outside the removal's scope.
- **Checks after the revisions:**
  - pytest on the chat SSE, router, service, Gemini, chat-turn and golden
    suites: 202 passed, with `UserWarning` as an error;
  - `ruff check`, `ruff format --check` (844 files) and mypy (832 files) clean;
  - `packages:build`, `packages:test` (30 of 30), `pnpm check` and
    `pnpm prettier:check` pass.

Repair budget: round 1 of 2 used.

##### Amendment Code Review #2 Findings

Targeted recheck by the same reviewer of snapshot `ba5f1ec16f89eea8`, unchanged
before and after. Result: **pass**.

- **F1:** the new test exercises the real `isalnum` guard. A counting probe
  records its one `missing_tts_text` frame, and both a mislabelled provider
  and a dropped frame fail it.
- **F2:** the `409` and `503` statuses in `voice.md` match the code.
- **F3:** the plan's guidance agrees with D13.
- The optional repairs caused no regressions: service tests cover the removed
  router duplicates, product-ui passes 30 of 30, and the rebuilt `dist` carries
  the JSDoc.

The reviewer's checks:

- ruff, ruff format and mypy (21 files);
- pytest 235 passed with `UserWarning` as an error and the probe;
- the mutation runs;
- Prettier on product-ui;
- product-ui lifecycle 30 of 30;
- Vitest (31 tests);
- the #471 body against the snapshot;
- `git grep` sweeps.

Optional notes, all taken:

- G1 is aligned with the running total (about US$0.16);
- two orientation lines no longer name the removed `config.py` setting or say
  Gemini "shares" `tts.audio`;
- a stray blank line in the results is removed;
- the allowance JSDoc now also notes that a finalized provider's decline
  arrives on `tts.error`.

Amendment review: **passed**, using one full review and one repair round.

### Folded follow-ups: #498 and #499 (owner, 2026-10-13)

Both were found while delivering Phase 2. They are folded into this PR before
Phase 3.

- **#498:** `domain/text_segmenter.py` ends a sentence only at ASCII `.!?`
  followed by whitespace, so Japanese or Chinese speech is one segment. Change:
  - also end a sentence after `。！？` (with runs and closing brackets or quotes),
    with no following whitespace needed;
  - keep the ASCII heuristics.

  Acceptance:
  - three Japanese sentences become three segments as they complete;
  - English, Korean and Spanish segmentation and the golden fixtures are
    unchanged;
  - live, realtime v4 Turbo starts after the first Japanese sentence, and Gemini
    sends one request per sentence.
- **#499:** rename the finalized runtime, playback functions and product-ui
  effects to provider-neutral names, and make the decode-failure text neutral.
  - Remove product-ui's unreachable `tts.error` allowance fallback. Gemini
    declines still end that reply's speech, and the realtime ElevenLabs fallback
    is unchanged.
  - Bump product-ui for the effect renames, and mirror the bump.

  Acceptance:
  - no ElevenLabs naming remains in the Gemini finalized path;
  - behaviour is unchanged;
  - the web, product-ui and desktop tests pass.

Commits:

- `perf(chat): speak Japanese and Chinese replies sentence by sentence`;
- `refactor(voice): drop ElevenLabs names from the Gemini finalized speech path`.

Review: one bounded review covers both (one full review, at most two repair
rounds).

#### Folded follow-ups implementation notes

Starting revision: `561c1d27`.

- **#498, backend.** `UserResponseSegmenter` matches one pattern with two
  alternatives:
  - ASCII `.!?` runs (with ASCII closers) followed by whitespace, still checked
    by the digit, initial and abbreviation heuristics;
  - a full-width `。！？` followed by any further marks (full-width or ASCII)
    and closers (full-width, curly or ASCII quotes). It ends at the next
    character that is not a mark or closer, so a run streamed one mark per
    delta stays with its sentence.
- **#498, browser chunker.** `tts-chunker.ts` also ends sentences at `。！？`
  and keeps full-width closers with their sentence. A run of marks (`！？`,
  `?!`, `...`) now stays in one chunk in every language. The existing
  24-character minimum per chunk applies to every language, so two short
  sentences can share a chunk.
- **#499.**
  - The runtime is now `use-finalized-tts-runtime.ts`
    (`useFinalizedTtsRuntime`). The playback functions, product-ui effects and
    warning reasons lose their ElevenLabs names, and the decode failure reads
    "Failed to decode the reply's audio."
  - The runtime no longer stamps `provider: "elevenlabs"`; `useTtsPlayback`
    attaches the provider of the run it prepared.
  - product-ui's `onTtsError` no longer tries the Pocket fallback, so a Gemini
    decline ends that reply's speech. `tts.session.error` keeps the realtime
    fallback.
  - product-ui is 0.10.0 (effects renamed), mirrored in
    `contracts/hosted-web.md`.
  - `cancelAll` stops the finalized runtime directly; the Pocket fallback stops
    only the ElevenLabs runtime.
  - The finalized helper tests moved to `tests/speech/finalizedTtsRuntime.test.ts`.

#### Folded follow-ups results

Checks (2026-10-13):

- `make format-check`, `uv run ruff check` and mypy on the changed files pass.
- pytest (segmenter, structured response, chat SSE and golden suites): 191
  passed after the review repair. The 17 segmenter tests cover:
  - Japanese and Chinese;
  - a mark at the end of a delta, and a run split across deltas;
  - runs and closers, and a quoted full-width sentence;
  - mixed Japanese and English;
  - unchanged English, Korean and Spanish.

  ASCII segmentation matched HEAD on 20,000 random inputs.
- `pnpm check`, `pnpm packages:build`, `pnpm web:lint`, `pnpm desktop:check` and
  Prettier on the changed files pass.
- `pnpm packages:test`: 30 passed. Vitest across `src/hooks`, `tests/speech`,
  `src/ui/main/chat`, `src/lib/chat`, `src/lib/speech`, `src/stores` and
  `src/lib/avatar`: 110 files, 1,466 passed and 1 skipped. After the review
  repair, the chunker, playback and speech suites pass (9 files, 68 tests).
- `pnpm desktop:test`: 506 passed, 14 skipped.

Live on `animama-ev4` (times from send):

- **Realtime v4 Turbo, Japanese (five sentences).** Segments arrived at 3.24,
  3.32, 3.54, 3.70 and 3.82 s. The chunker sent three socket inputs (3.32, 3.70
  and 3.82 s), and the first audio arrived at 3.47 s, before the reply finished
  at 4.17 s. 10.1 s of audio played to `is_final`. Before #498 the whole reply
  was one segment, sent only when the reply finished.
- **Gemini, Japanese (four sentences).** Four segments (2.74 s, then three at
  3.27 s) became four requests in the default sentence chunking. 54 `tts.audio`
  frames from `gemini-3.8-flash-lite-tts` played with no errors.

#### Folded follow-ups Code Review #1 Findings

An independent reviewer (`sdlc-reviewer`) reviewed the uncommitted tree on
`561c1d27`. Result: **blocked**, on two required fixes.

- **FF1-F1 (required), `domain/text_segmenter.py`.** A run of full-width marks
  splits when it ends a delta. The lookahead excluded closers but not marks, so
  `"本当！"`, `"？"` gave `本当！` and `？` as separate segments, and a closer after
  a split run left its sentence. Gemini drops a segment without letters, so
  "えっ、本当！？" was spoken as "えっ、本当！".
- **FF1-F2 (required), `use-tts-playback.ts`.** `cancelElevenLabsPlayback` was the
  only place that stopped the Gemini finalized runtime, which kept an ElevenLabs
  name in that path.
- **FF1-F3 (optional).** ASCII quotes are not closers after a full-width mark, so
  `You say "ありがとう！" to thank a friend.` orphaned the closing quote.
- **FF1-F4 (optional).** Two comments above `finalizedProviderRef` said the same
  thing.
- **FF1-F5 (optional), `tts-chunker.ts`.** A chunk stops at the first mark of a
  run, so a realtime input could start with `？` (as ASCII `?!` already could).
- **FF1-F6 (optional).** `isExclamationTtsChunk` recognises only ASCII `!`; this
  predates the change.
- **FF1-F7 (optional), plan record.** The results lacked the rerun numbers. The
  Cloud issue list did not mention the product-ui 0.10.0 effect renames, and the
  implementation note about deltas was inaccurate until FF1-F1 was fixed.

Verified with no defect:

- ASCII segmentation is unchanged;
- removing the `onTtsError` fallback changes nothing;
- no old identifiers remain;
- the hard constraints hold.

#### Folded follow-ups Code Review #1 Revisions

- **FF1-F1: accepted.**
  - Reproduced with the reviewer's three delta sequences.
  - The full-width alternative now ends at the next character that is not a
    mark or closer, and also absorbs ASCII marks after a full-width mark.
  - New tests cover a run split across deltas (with its closer) and `！?`.
  - `chat.md`, the code comment and the implementation note were corrected.
  - 191 backend tests pass, and ASCII segmentation still matches HEAD on 20,000
    random inputs.
- **FF1-F2: accepted.** The wrapper is removed. `cancelAll` calls
  `stopElevenLabsRuntime()` and `stopFinalizedRuntime()`, and the Pocket fallback
  (ElevenLabs runs only) calls `stopElevenLabsRuntime()`. The playback tests pass.
- **FF1-F3: accepted.** ASCII `"` and `'` are closers after a full-width mark,
  with a test for the quoted sentence. The quote now stays, and the sentence
  splits after it, as `He said "Wow!" and left.` already does in ASCII.
- **FF1-F4: accepted.** One comment remains.
- **FF1-F5: accepted.** The chunker keeps a run of marks in one chunk in every
  language, with a test for `！？`, `?!` and `...`.
- **FF1-F6: deferred.** Treating `！` as an exclamation would change talking-hands
  gestures for Japanese and Chinese, which is outside #498 and #499. It is noted
  for a follow-up.
- **FF1-F7: accepted.**
  - The results record the rerun numbers.
  - The Phase 5 Cloud issue mentions the product-ui 0.10.0 renames. This is
    informational: Cloud pins 0.8.0 and does not implement `ChatSessionEffects`.
  - The note is corrected.
  - The `licenses/source-review.json` paths are refreshed at release preparation,
    as before.

#### Folded follow-ups Code Review #2 Findings

Targeted recheck of the repairs. Result: **pass**. All six repairs were verified:

- the three delta cases stay whole;
- streaming and whole-text segmentation agree on 30,000 random mixed texts;
- ASCII still matches HEAD.

Optional findings caused by the repairs:

- **FF2-F1 (recommended), `tts-chunker.ts`.** The continuation loop also took
  marks after the space, so `… years. .NET is …` lost the leading dot of `.NET`
  to the previous chunk.
- **FF2-F2, `isExclamationTtsChunk`.** With runs kept whole, `…that!?` was no
  longer an exclamation, and `…that?!` became one.
- **FF2-F3 (no action).** An opening ASCII quote straight after a full-width
  mark stays with the previous sentence. Quotes are not spoken, and the visible
  text is intact.
- **FF2-F4 (docs).** `voice.md` did not say that following marks stay with a
  chunk.

#### Folded follow-ups Code Review #2 Revisions

- **FF2-F1: accepted.** Marks are absorbed only before the first space, with a
  `.NET` test.
- **FF2-F2: accepted.** A chunk is an exclamation when its closing run of marks
  includes `!` (`Wow!`, `Really?!`, `No!?`). A test covers it; `！` stays with
  the deferred FF1-F6.
- **FF2-F3: accepted as is**, as the reviewer recommends.
- **FF2-F4: accepted.** `voice.md` "Chunking behavior" names the following
  marks.

Verification: Vitest (`src/lib/speech`, the playback test and `tests/speech`)
passes 25 files and 224 tests; ESLint and Prettier on the chunker files are
clean.

#### Folded follow-ups Code Review #3 Findings

Final targeted recheck. Result: **pass**. FF2-F1, F2 and F4 are verified:

- the `.NET` and ellipsis cases match HEAD;
- 120,000 random texts differ from the round 1 chunker only by the intended run
  rule.

Optional findings:

- **FF3-F1, `tts-chunker.ts`.** A line break as the boundary counted no space,
  so a mark that starts the next line (`.NET`) still moved back.
- **FF3-F2, `use-tts-playback.ts`.** The single whole-reply chunk for Browser and
  Pocket TTS kept an inline copy of the old exclamation and word-count patterns.

#### Folded follow-ups Code Review #3 Revisions

The review budget is used. Both optional fixes are one line each and are left to
the final integration review:

- **FF3-F1: accepted.** A whitespace boundary counts as the space, with a
  newline `.NET` test.
- **FF3-F2: accepted.** That chunk now calls `isExclamationTtsChunk` and
  `countTtsChunkWords`.

Vitest across `src/lib/speech`, `src/hooks`, `tests/speech` and
`src/ui/main/chat` passes 40 files and 307 tests; ESLint and Prettier are clean.

Folded follow-ups review: **passed** (one full review and two repair rounds).

### Phase 3: timing plumbing and the timing evidence module

Issue: #500. Requirements: R4 (timing and module), R5 (timing frames). Depends
on Phases 1–2. Authorized on 2026-10-13.

Outcome:

- Every v4 Turbo reply's character timing (direct socket, or the hosted server
  socket) reaches the browser in one time base. After the 2026-10-12 removal of
  finalized v4, no backend `tts.audio` carries ElevenLabs timing.
- A provider-neutral module turns it into evidence that #468's planner and the
  Phase 4 view consume.
- Lip-sync rendering is unchanged (D8).

Changes:

1. **Backend `tts.audio`:** withdrawn with finalized v4 (owner, 2026-10-12).
   Gemini frames carry no timing.
2. **Product-ui:** no SSE type change is needed.
3. **Browser collection** (`src/frontend/web/src/lib/speech/provider-speech-timing.ts`):
   - **Realtime socket:** per-frame relative times, with a cursor per turn that
     advances by each frame's length and resynchronises to the played samples
     at `is_final_audio_for_turn`. It tolerates `alignment: null`.
   - **Absolute payloads** (the hosted server socket) are appended as they
     are.
   - The result is a run timeline of `{char, startSec, endSec}`, kept by run id
     in a small store. It is cleared with the run, and late frames are ignored.
4. **Evidence module** (`src/frontend/web/src/lib/speech/speech-timing-evidence.ts`),
   a pure function from a timeline to evidence:
   - Spoken words: runs of Latin, Cyrillic and similar letters, digits and
     apostrophes. Han, kana and Hangul characters each keep their own window.
   - Punctuation entries with times, marked as possible pauses.
   - Bracketed spans with the raw tag text and a class:
     - non-verbal sound → a non-speech interval;
     - sound effect (allowed on ElevenLabs by #479) → a separate non-speech
       interval, mouth at rest;
     - delivery or emotion → a zero-width marker at the span's start that applies
       to the following words;
     - pacing → a silent interval.
   - Classification uses a small keyword table. It handles combined tags
     (`[whispering, playful]`); unknown tags become delivery or emotion markers,
     never words.
   - It reports provider times unchanged. Overrun word ends and short tag spans
     are documented as hints for the planner.
5. **Fixtures:**
   - Recorded from the spike (text, characters and times; no audio) under
     `src/frontend/web/src/lib/speech/__fixtures__/`.
   - English with pauses, tags (`[laughs]`, `[sighs]`) and numbers; a v4 Turbo
     socket run with per-frame times and turns.
   - New small captures for ja, ko, zh and es, and for `[gasps]`, `[whispers]`,
     `[pause]` and a combined tag, within G1.
6. **Server socket:** accept the absolute `alignment` field on server transport
   audio frames.

Tests:

- **Collection:**
  - cursor accumulation and turn resync;
  - `alignment: null` frames;
  - absolute append;
  - late or old-run frames ignored.
- **Evidence:** on fixtures, Latin words, per-character CJK windows,
  punctuation, each tag class, and combined and unknown tags.

Checks: as in Phase 2.

Live (G1): two realtime v4 Turbo replies, one English and one Japanese. Inspect
the collected timeline in development tools against the audio.

Completion:

- Checks and review pass.
- Commit `feat(avatar)[p3]: collect ElevenLabs timing as lip-sync evidence`.

#### Phase 3 implementation notes

Starting revision: `79a39300`.

- **Collection** (`lib/speech/provider-speech-timing.ts`):
  - `createSpeechTimingCollector` keeps one run's clock. It counts audio
    samples, places each dialogue frame after the turn's previous frames, and
    restarts the turn at the received audio on `is_final_audio_for_turn`.
  - It appends server-socket `alignment` (`characters`,
    `character_start_times_seconds`, `character_end_times_seconds`) as it is.
  - It ignores malformed frames without moving the cursor.
- **Runtime.** `use-elevenlabs-tts-runtime.ts` creates a collector per run and
  reports new characters through `onSpeechTiming`. Frames after the run stops
  are dropped with its socket.
- **Wiring.** `useTtsPlayback` forwards `onSpeechTiming`, and `useChatSession`
  appends it to the lip-sync bridge's `providerSpeechTimingByRun`.
  - The timing lives in the bridge store, not a separate store, so every
    existing run and session clear (`clearRun`, `clearAll` and
    private-session reset) also removes it.
  - The estimated planner does not read it (D8).
- **Evidence** (`lib/speech/speech-timing-evidence.ts`):
  - `buildSpeechTimingEvidence` returns words (`word` or per-`character`),
    punctuation runs and tags, each with its timeline indexes.
  - `classifyAudioTag` uses small keyword tables, and a combined tag takes its
    strongest class.
  - While a run is being collected, an unclosed tag at the end of the timeline
    is pending; with `complete`, or without a short closing tag, a bracket is
    punctuation.
- **Fixtures.** The fixtures live in `lib/speech/fixtures/`, following the
  repository's `fixtures/` convention rather than `__fixtures__/`:
  - the spike's English socket run with tags and turns;
  - new app-like captures for ja, ko, zh and es, and one for `[gasps]`,
    `[whispers]`, `[pause]` and `[whispering, playful]` (242 characters, about
    US$0.01);
  - three run-relative HTTP timing lines as the server-socket shape.

  They hold text, characters, times and sample counts, but no audio. The
  converter and capture scripts are kept in the ignored evidence folder.
- **Contract.** `contracts/hosted-web.md` already documents the optional
  server-socket `alignment` here, because this phase implements it. Phase 5
  keeps the rest of the contract work.

#### Phase 3 results

Discoveries from the captures:

- A turn's timing can overrun its audio by 80 ms (ja, ko and zh; the HTTP
  lines by 80 ms too). A turn's last characters can therefore start after the
  next turn's first; tests bound the overlap at 0.1 s.
- Tag spans are short: `[whispers]` covers 80 ms, and `[pause]` 60 ms, while
  the pause falls on the punctuation and space before it.

Checks (2026-10-13):

- Vitest: timing collector 14, evidence 25, bridge store 6 (3 new), socket
  runtime 13 (3 new) and playback 15 (1 new) pass after the review repair.
- `pnpm check`, `pnpm web:lint`, `pnpm web:test` (Vitest and the 114 Node
  journey tests) and `pnpm prettier:check` pass.
- After the review repair, on the phase's own snapshot (Phase 4 files set
  aside):
  - `pnpm check`, `pnpm web:lint`, `pnpm web:test`, `pnpm prettier:check` and
    `pnpm build` pass;
  - `pnpm desktop:test`: 506 passed, 14 skipped.
- Not run for this frontend-only phase: the backend checks and `pnpm openapi-ts`
  (no backend or schema change).

G1 spend: the captures sent 242 characters and the two live replies 161, about
US$0.02 together at v4 Turbo's rate; about US$0.19 of US$1 is spent.

Live on `animama-ev4` (realtime v4 Turbo):

- **English.** Two sentences, 102 characters, in order. The last character ends
  at 5.68 s, exactly the played audio's length. The evidence lists 20 words and
  three punctuation pauses (`,` 1.04–1.16 s; `.` 3.44–3.60 s; the final `.`
  5.52–5.68 s).
- **Japanese.** Three sentences, 59 characters, with 54 kana and kanji windows
  and three `。`. The timing ends at 6.40 s against 6.32 s of audio, the 80 ms
  overrun, with one 40 ms overlap at a turn boundary.

#### Code Review #1 Findings

An independent reviewer (`sdlc-reviewer`) reviewed the uncommitted tree on
`79a39300`. Result: **blocked**, on four required findings.

The reviewer noted that Phase 4 files appeared mid-review. They were excluded,
and the Phase 3 commit is staged path by path and checked on its own snapshot.

- **P3-F1 (required).** `crying` was classified as delivery, but spec R4 lists
  crying as a non-verbal sound.
- **P3-F2 (required).** In a finished reply, an unclosed `[` within 64
  characters of the end dropped every later word. The builder could not tell a
  finished timeline from one still being collected.
- **P3-F3 (required).** The Decision Log still named the dialogue socket's
  fields for the server socket, contradicting the contract Phase 3 documents.
- **P3-F4 (required).** The results omitted the checks not run, the live checks'
  spend and the running G1 total.
- **P3-F5 (optional).** Adding `audioStartSec` maps timing onto playback only
  until playback starves; that was not stated.
- **P3-F6 (optional).** `[whispers]` was the wrong example of a short tag span,
  since it is a delivery marker.
- **P3-F7 (optional).** The evidence is in timeline order, not strictly time
  order.
- **P3-F8 (optional).** Two backend docs still say the timing is unused.
- **P3-F9 (optional).** The lip-sync guide's callback list omitted
  `onSpeechTiming` and `onChunksQueued`.
- **P3-F10 (optional).** A plan line counted three pauses but listed two.
- **P3-F11 (optional).** Each timing append scheduled a desktop PiP snapshot,
  although the PiP mirror never copies timing.

Verified with no defect:

- the cursor and resync;
- `alignment: null` frames;
- the fence on late frames;
- clearing on session replacement;
- no added latency to first audio;
- fixtures without audio or identifiers.

#### Code Review #1 Revisions

- **P3-F1: accepted.** `cry`, `cries` and `crying` are non-verbal, and the test
  now expects that.
- **P3-F2: accepted.** `buildSpeechTimingEvidence(timeline, { complete: true })`
  reads an unclosed bracket as punctuation; without it, the tail waits as
  before. A test covers both. The Phase 4 view passes `complete` for finished
  runs.
- **P3-F3: accepted.** A dated Decision Log entry supersedes the field names.
- **P3-F4: accepted.** The results record the checks not run (with reasons) and
  the spend, and the G1 total is now about US$0.19. `pnpm build` and
  `pnpm desktop:test` pass on the phase's own snapshot.
- **P3-F5: accepted.** One sentence each in `elevenlabs-tts.md`, the module and
  the store type.
- **P3-F6 and P3-F7: accepted.** The example is now `[pause]`, and the wording
  says timeline order.
- **P3-F8: deferred to Phase 5**, which already lists both docs.
- **P3-F9: accepted.** The callback list names both.
- **P3-F10: accepted.**
- **P3-F11: accepted.** `isProviderTimingOnlyChange` lets the PiP sync skip
  timing-only updates, with a store test.

Repair budget: round 1 of 2 used.

#### Code Review #2 Findings

Targeted recheck of commit `9a4e9be3`. Result: **pass**.

- All required repairs are resolved, and P3-F8 is deferred to Phase 5.
- The reviewer extracted the commit and ran tsc, ESLint, Prettier and the five
  Phase 3 suites on it (73 tests).
- **P3R2-F1 to P3R2-F3 (optional, plan record):**
  - the new Decision Log entry named no actor;
  - no repair-budget line was recorded;
  - two lines described the pre-repair state.

#### Code Review #2 Revisions

- **P3R2-F1 to P3R2-F3: accepted.** The entry is labelled an agent proposal, the
  budget line is added, and the notes and counts are current. The Phase 4
  review checks that the view passes `complete`.

Phase 3 review: **passed** (one full review and one repair round).

### Phase 4: side-by-side view with pluggable plan sources

Issue: #501. Requirements: R4 (side-by-side view). Depends on Phase 3.
Authorized on 2026-10-13.

Outcome: where the Anima debug panel is enabled, the owner can inspect a v4
reply's audio, its timing evidence and every registered lip-sync plan, and
replay the reply on the avatar with any of them.

Changes:

1. **Plan-source registry:** a small interface,
   `{id, label, build(inputs) → vowel keyframe plan | null}`.
   - Register "Estimated (today)", wrapping today's planner unchanged.
   - #468 registers its planner later.
2. **Capture (debug only):**
   - While the panel is enabled, the ElevenLabs runtimes tee the latest run's PCM
     into a debug store, capped at 90 s and keeping only the last run.
   - The store also keeps that run's evidence and planner inputs.
   - Nothing is captured when the panel is disabled.
3. **Panel section "Lip-sync":**
   - a canvas timeline: audio envelope; evidence overlay (words or characters,
     punctuation, tag intervals and markers); one mouth-openness curve per plan
     source;
   - a playhead;
   - "Replay with <plan>" for each source, playing the stored PCM through its own
     `AudioContext` and applying that plan through the bridge's segment path
     under a synthetic run id;
   - stop.
4. **Layout:** desktop sizes first, then narrow layouts without breakage.

Tests:

- **Registry:** adding a source needs no view change; a test source appears as a
  curve.
- **Debug store:** capture only while enabled, the cap, and last-run replacement.
- **Replay:** it applies the chosen plan through the segment API (mocked
  controller).

Checks: `pnpm check`, `pnpm web:lint`, `pnpm web:test` and `pnpm build`, plus a
browser check at desktop and narrow sizes.

Live (G1): capture two realtime v4 Turbo replies, replay them, and save a
timeline screenshot for the PR.

Completion:

- Checks and review pass.
- Commit `feat(avatar)[p4]: compare lip-sync plans against ElevenLabs timing in the debug panel`.

#### Phase 4 implementation notes

Starting revision: `5bd75135` (Phase 3, reviewed as `9a4e9be3` before a
record-only amend).

- **Registry** (`lib/speech/lipsync-plan-sources.ts`):
  - A `LipSyncPlanSource` is `{id, label, build(inputs)}`. `build` returns a
    promise of a vowel viseme segment, or `null`.
  - "Estimated (today)" runs today's planner (`buildVisemeAssetsFromRaw`,
    `actual_prestart`) at the played length.
  - `registerLipSyncPlanSource` adds or replaces a source by id.
  - `mouthOpennessCurve` turns a segment into a display-only opening curve.
- **Capture:**
  - `lib/speech/speech-debug-tap.ts` is empty unless a capture installs a
    listener, so ordinary speech pays one null check per frame.
  - `stores/lipsync-debug-store.ts` keeps the latest run only, capped at 90 s.
    It copies the run's planner inputs, timing and length from the bridge
    before the run is cleared, and registers a private-state reset.
  - `SceneDebugPanel` starts the capture while the panel is enabled, because
    the panel closes on any outside click.
- **View:**
  - `ui/debug/LipSyncDebugSection.tsx` is the "Lip-sync" section, with a
    `lipSync` key and a `lipSyncCapture` producer.
  - `lipsync-debug-timeline.ts` draws three canvas lanes (envelope, evidence,
    curves) at 120 px/s. The timeline scrolls inside the 20rem panel and
    follows the replay's playhead.
  - Evidence for a finished run uses `complete: true`.
- **Replay** (`lipsync-debug-replay.ts`):
  - It plays the stored PCM through its own `AudioContext`.
  - It applies the chosen segment under a fresh replay run id through the
    bridge's new `playReplaySegment`, which uses the same segment path as live
    runs but skips the chat-run gate.
  - Stop clears it with `stopReplaySegment`.

#### Phase 4 results

Checks (2026-10-13), Vitest:

- registry 6, capture store 6, replay 3, timeline 3 and section 7;
- bridge store 8 (2 new), socket runtime 14 (1 new).

These are the counts after the review repairs: 47 tests across the seven Phase 4
suites.

`tsc` and ESLint are clean.

- `pnpm check`, `pnpm web:lint`, `pnpm web:test`, `pnpm prettier:check` and
  `pnpm build` pass.
- `pnpm desktop:test`: 506 passed, 14 skipped.
- Not run: the backend checks and `pnpm openapi-ts` (no backend or schema change).

Live on `animama-ev4` (realtime v4 Turbo, `VITE_ENABLE_DEBUG_PANEL=true`):

- **English.** A 4.88 s reply was captured with the panel closed and shown when
  it opened: 20 words, 2 pauses and a 293-frame estimated plan.
  - Replay with "Estimated (today)" moved the playhead and drove the avatar's
    vowel weights from 0.2 s to 4.8 s (peak 0.995).
  - The button reset when the audio ended.
- **Japanese.** A 5.68 s reply was captured with 43 character windows and 4
  pauses. "Estimated (today)" showed "no plan", which led to the discovery
  above.
- **Layout.** The view holds at 1440×900 and at 390×844, where the timeline
  scrolls horizontally. Screenshots are in the ignored
  `evidence/phase4/lipsync-view-desktop.jpg` and `lipsync-view-narrow.jpg`.
- **G1 spend.** About 155 characters, or US$0.01; about US$0.20 of US$1 is
  spent.

#### Code Review #1 Findings

An independent reviewer (`sdlc-reviewer`) reviewed commit `8908194a` against
`5bd75135`. Result: **blocked**, on two required findings.

- **P4-F1 (required).** A capture capped at 90 s spread its kept audio across
  the uncapped played length. The envelope misaligned with words, curves and the
  playhead (20 s off at 60 s of a 120 s reply), and the canvas grew without a
  bound.
- **P4-F2 (required).** Replay was enabled as soon as the stream ended, while
  buffered audio still played. A replay then took over the live reply's
  lip-sync, and the live end stopped the replay's mouth.
- **P4-F3 (optional).** Three comments said capture runs while the panel is
  open; it runs while the panel is enabled.
- **P4-F4 (optional).** The section test never checked a curve: happy-dom has no
  2D canvas.
- **P4-F5 (optional).** Every replay frame resized the canvas and recomputed
  each curve.
- **P4-F6 (optional).** A failed replay start left the previous replay showing
  as active.

Verified with no defect:

- production exclusion (only the inert tap ships);
- the `complete` evidence follow-up from Phase 3;
- the capture lifecycle and session reset;
- unchanged chat lip-sync (D8);
- the replay mechanics and the registry;
- the repository boundaries.

#### Code Review #1 Revisions

- **P4-F1: accepted.** The view draws on `min(played length, kept samples ÷
  rate)`. Width, axis, playhead and scrolling share it, which also bounds the
  canvas. A test covers a capped 120 s reply.
- **P4-F2: accepted.**
  - The capture records `playbackEnded` when the bridge clears its run, which
    happens when the audio stops.
  - Plans, Replay and complete evidence wait for it, with store and section
    tests.
  - Live, a reply's 6.2 s of audio had arrived by 3 s while it still played;
    Replay stayed off until playback ended at about 7.3 s.
- **P4-F3: accepted.** The comments say "enabled".
- **P4-F4: accepted.** The test stubs the canvas context and checks the curve ids
  the view draws.
- **P4-F5: accepted.** The canvas resizes only when its size changes, and the
  curves are memoised.
- **P4-F6: accepted.** A new replay clears the previous one before starting,
  with a test.

Vitest across `src/ui/debug`, `src/stores`, `src/lib/speech` and `src/hooks`
passes; `tsc` and ESLint are clean.

Repair budget: round 1 of 2 used.

#### Code Review #2 Findings

Targeted recheck of commit `d40fec7e`. Result: **pass**.

- All six findings are resolved, with no regression.
- The reviewer traced every path that clears the bridge's run and ran the seven
  Phase 4 suites, tsc, ESLint and Prettier.
- **P4R2-F1 (optional).** The gate covered only the captured reply. Replay
  during another provider's reply could take over its lip-sync.
- **P4R2-F2 (optional).** The results kept pre-repair test counts.

#### Code Review #2 Revisions

The two optional fixes are left to the final integration review:

- **P4R2-F1: accepted.** Replay is also disabled while any run is speaking (the
  bridge's `speechAudioStartsByRun` is not empty), with a note in the view and
  a test. The JSDoc and the guide are qualified.
- **P4R2-F2: accepted.** The counts are current.

Phase 4 review: **passed** (one full review and one repair round).

### Phase 5: hosted contract, Cloud issue, docs and full validation

Issue: #502. Requirements: R5, docs and contract acceptance. Depends on Phases
1–4. Authorized on 2026-10-13.

Changes:

1. **`contracts/hosted-web.md`:**
   - server socket frames:
     - browser `{text}` frames are unchanged;
     - server audio frames are `{audio, alignment?}`, with times relative to the
       run's first audio sample;
     - the end marker is `{is_final: true}`, with `isFinal` accepted;
   - allowance refusals for ElevenLabs come only as `tts.session.error`, and
     hosted keeps the server transport (done with the finalized v4 removal);
   - versions.
2. **Docs:** finish what the phases have not covered:
   - `docs/frontend/runtime/elevenlabs-tts.md`, `voice.md` and
     `avatar-lipsync.md` (timing evidence, the debug view, and the unchanged
     planner);
   - `docs/backend/integrations/voice-and-speech.md`;
   - `docs/backend/architecture/http-api.md`;
   - `docs/backend/runtime/chat.md`;
   - `src/backend/animama/server/reference.md`, if it lists models.
3. **Cloud issue.** Prepare `docs/plans/eleven-v4/cloud-issue-draft.md` with:
   - the model ids: `eleven_v4_turbo` only. Retire the finalized `eleven_v3`
     path (`MODELS` and the `eleven_v3` branches in `speech_turn.py`), map
     `eleven_v3` requests to `eleven_v4_turbo`, and drop the finalized methods
     from Cloud's `ProductSpeech`, which no longer extends `FinalizedSpeechPort`;
   - the server socket's model change (TTS HTTP accepts v4 Turbo, undocumented;
     Text to Dialogue is the documented API);
   - optional timing via `stream/with-timestamps`, forwarded on the server
     socket as `alignment` with run-relative times;
   - never issuing direct `ttd_websocket` tokens to multi-user browsers;
   - the product-ui 0.10.0 effect renames (`acceptFinalizedAudio`,
     `completeFinalizedAudio` and `markFinalizedAudioFailed`), which are
     informational while Cloud pins 0.8.0 and implements no `ChatSessionEffects`;
   - the end marker;
   - pricing keys;
   - rollout ordering (G3);
   - dialogue-pool concurrency, if Cloud moves realtime to a server-side socket:
     - open a session only while a reply speaks, and close it at the end or on
       cancel;
     - cap and queue per operator;
     - treat refusals as speech refusals that keep the text;
     - measure the operator plan's limit before launch (the owner's plan showed
       none at 8 generating or 16 idle sessions).

   File it in the Cloud repository only with the owner's go-ahead; otherwise
   hand it over.
4. **Full validation:**
   - `make check-test`;
   - `pnpm check`, `pnpm web:lint`, `pnpm web:test`, `pnpm build` and
     `pnpm desktop:test`;
   - `pnpm e2e:test:fast` on a disposable built stack;
   - the package-set build and compare against a `main` baseline.
5. **Owner gate pack (G2):** a checklist covering the voices in use, v4 Turbo
   listening, and the side-by-side steps.

Completion:

- All checks pass and docs are current.
- The Cloud issue is ready.
- Review passes.
- Commit `docs(voice)[p5]: document Eleven v4 speech, timing evidence and the hosted contract`.

#### Phase 5 implementation notes

Starting revision: `3c6b7d98`, merged with `main` at `00442ec9` in `10812ec4`
(no conflicts).

- **Contract.**
  - Phase 3 already documented the optional server-socket `alignment` and its
    time base.
  - The end marker and the allowance refusal on `tts.session.error` were already
    current.
  - The package versions in `contracts/hosted-web.md` match the packages:
    `local-http` 6.0.0, `runtime-contracts` 0.6.0 and `product-ui` 0.10.0. The
    web-only Phases 3–4 needed no bump.
- **Docs.**
  - `voice-and-speech.md` and `http-api.md` no longer call the realtime timing
    unused (P3-F8).
  - The frontend guides were updated in their phases. `chat.md` and the server
    reference needed no change.
- **Cloud issue.**
  - [`cloud-issue-draft.md`](cloud-issue-draft.md) is a behaviour-level handoff.
  - It covers models, pricing, the provider endpoint, optional run-relative
    timing, no direct tokens, the end marker, allowance refusals, concurrency
    and the G3 rollout order: Cloud accepts and prices `eleven_v4_turbo` before
    adopting the new packages.
  - It is not filed.
- **G2 pack.** The checklist is below.

#### Phase 5 results

Validated revision: `7b50f27c`, the merged branch. Baseline: `00442ec9`
(`main`).

- `75de884c` has the same code. Later commits change only docs, the plan and
  the debug view's replay stop, which are checked separately below.
- The containerised `scripts/ci/local_validate.py --profile full` run of
  `75de884c` stalled in its frozen Python install for 50 minutes, with
  OrbStack at about 700% CPU and Docker no longer answering. It was stopped and
  left no receipt.
- The checks then ran natively on the same clean source:

| Check | Result |
| --- | --- |
| `make check-test` | Typed-content audit, Ruff format (833 files), Ruff and mypy (833 files) pass. pytest: 3,164 passed, 29 skipped, 0 failed, and 995 errors. Every error is `DockerException: Error while fetching server API version` from the Postgres test containers. |
| `pnpm openapi-ts:check` | Current |
| `pnpm check`, `pnpm web:lint`, `pnpm prettier:check`, `pnpm build` | Pass |
| `pnpm web:test` | Vitest, 484 files: 4,301 passed, 1 skipped. Node and browser suites: 220 of 220 (unit suites of 89, 4 and 13, and 114 browser tests, including both hosted server-socket tests). |
| `pnpm packages:test` | product-ui 30 of 30, runtime-contracts 3 of 3; discover-client passes |
| `pnpm desktop:test` | 509 passed, 14 skipped |
| Package sets | `build.py build` for `7b50f27c`, and for `main` at `00442ec9` (current tooling, with the primary checkout as source). `compare`: "Compatibility policy passed". |

Not run:

- **Outside this phase's list:** `build.py validate` (installed consumers in
  Chromium) and a receipt-bound local profile. Both are part of the
  containerised full profile.
- **Never run by agents here:**
  - hosted Validation (disabled by owner policy);
  - real hosted speech (G3);
  - Instant Voice Clones (D5);
  - packaged desktop builds.

Docker-backed checks at the final head `47105607`, after OrbStack was restarted
(clean tree, same toolchain):

| Check | Result |
| --- | --- |
| `make check-test` | Audit, Ruff format, Ruff and mypy pass. pytest: 4,159 passed, 29 skipped, 0 failed (6 min 13 s). The 995 earlier Docker errors now pass. |
| `pnpm e2e:test:fast` | Disposable built stack `animama-ev4-e2e` (`ANIMAMA_LLM_SKIP=1`, production build, no provider keys): 38 of 38 passed in 6.0 min. The stack was taken down afterwards. |

G1 spend:

- Some small checks had no spend line: Phase 1's round-2 live reply, the #498
  realtime Japanese reply and the P4-F2 live reply. Each was under US$0.01.
  Gemini replies are not ElevenLabs spend.
- The total is about US$0.21 of US$1.

#### G2 owner gate pack

The owner's checks before merge. Each English reply costs about US$0.004 of
v4 Turbo characters.

If the stack is not running, start it from this worktree's root with the debug
panel on, then open http://animama-ev4.localhost:8460:
`COMPOSE_ENV_FILES="$HOME/.config/animama/dev-secrets.env" VITE_ENABLE_DEBUG_PANEL=true ./reset.sh --name ev4 --base-port 8460`.

1. **Listen to v4 Turbo with the voices in use.**
   - Choose ElevenLabs in App Settings → Voice.
   - For each voice in use (the default voice and every Anima's own), send one
     English and one Japanese reply.
   - Judge the voice's identity, pronunciation, the prosody across a reply (one
     flush after the first sentence) and how quickly speech starts.
   - The spike's samples for v3, v4 and v4 Turbo are in the ignored
     `evidence/voices/`.
2. **Hear every language.** Korean, Chinese and Spanish replies speak with v4
   Turbo. Japanese and Chinese replies start speaking before the reply finishes
   (#498).
3. **Review the side-by-side view.**
   - If the stack started without the panel, restart only its web service with
     the panel on, from this worktree's root: `source .animama-stack.env`, then
     `HOST_UID=$(id -u) HOST_GID=$(id -g) VITE_ENABLE_DEBUG_PANEL=true docker compose -p animama-ev4 up -d --no-deps web`.
   - Send a reply. Open the Anima debug panel (bug icon) and expand Lip-sync.
   - Check that the envelope, words and pauses line up, then press Replay and
     watch the mouth against the audio.
   - Japanese, Chinese and Korean replies show their timing but "no plan": the
     avatar's mouth stays still for them today, as on `main`. Accept that until
     #468, or say otherwise.
4. **Gemini speaks sentence by sentence.** With Gemini selected, a Japanese
   reply makes one request per sentence (#498); otherwise Gemini is unchanged.
5. **Hosted.** Read `cloud-issue-draft.md` and decide whether to file it in the
   Cloud repository.
6. **Finalized ElevenLabs.** Confirm that no finalized ElevenLabs model returns
   (D13). Reviving one from `c6b87dd2` would be a separate follow-up.
7. **An emoji at the end.** On ElevenLabs, send a reply that ends in an emoji
   (for example 😊). It should speak fully, without a notice. This was never
   verified for v4 Turbo.

#### Code Review #1 Findings

An independent reviewer (`sdlc-reviewer`) reviewed commit `75de884c` (parent
`10812ec4`) and checked the merge for semantic conflicts, finding none. Result:
**blocked**, on three required findings in the Cloud draft.

- **P5-F1 (required).** The draft said Animama maps retired ids before they
  reach a composition. Only the shared route's `PyAnimaTtsRunOptions` maps
  them.
  - Cloud's own route passes a plain `dispatch_options` object to
    `merge_chat_request_options`, which drops unsupported ids.
  - A tab opened before the deploy would therefore send a retired id, get no
    model, and lose the reply's voice.
  - A probe confirmed it: raw `eleven_v3` gives no model, while the request
    model gives `eleven_v4_turbo`.
- **P5-F2 (required).** The draft omitted that `ProductSpeech` no longer needs
  finalized methods.
- **P5-F3 (required).** One acceptance criterion, the debug view on a hosted
  reply, cannot be met. The debug panel exists only on the local development
  server, and the hosted app is only ever built.
- **P5-F4 (optional).** The G2 pack did not say how to start the stack, had no
  step for the D13 decision, and called Gemini unchanged despite #498.
- **P5-F5 (optional).** Draft clarity:
  - the `similarity_boost` name;
  - the receipt check on `/with-timestamps` and v4 Turbo's multiplier;
  - the pinned backend dropping v4 Turbo before adoption;
  - naming the backend by source commit, and admitting `local-http` 6.0.0;
  - the no-session `eleven_v3` delivery;
  - `sync_alignment: false` on the server transport.
- **P5-F6 (optional).** The backend timing sentence sat in the Gemini section,
  without a link.
- **P5-F7 (optional).** The contract could say the browser ignores an ElevenLabs
  `tts.error`.

Verified with no defect:

- contract frames and versions;
- every frontend and backend guide;
- the draft's facts about current Cloud and the research;
- repository dependencies (no private ones);
- links.

#### Code Review #1 Revisions

- **P5-F1: accepted.**
  - The draft now says the shared route maps retired ids. It requires Cloud's
    own route to apply `replace_retired_elevenlabs_tts_model_id`, or validate
    with `PyAnimaTtsRunOptions`, and explains the failure without it.
  - G3 step 1 adds that mapping.
  - The contract says the shared route maps them and that a consumer
    validating its own requests applies the same mapping.
  - Making the shared normalizer map them as well was considered and left out.
    It is a shared behaviour change with its own tests, and Cloud already has
    to change this area before adoption.
- **P5-F2: accepted.** An informational line about `ProductSpeech`.
- **P5-F3: accepted.** The criterion is now Cloud's server-socket tests on
  run-relative `alignment`, including a later request's offset, with optional
  inspection in developer tools.
- **P5-F4: accepted.**
  - The pack opens with the reset command (debug panel on) and the URL.
  - It adds a D13 confirmation step and renames the Gemini step.
  - The setup's base port is corrected to 8460, the one the stack uses.
- **P5-F5: accepted.** Every point is in the draft.
- **P5-F6: accepted.** The sentence moved beside `sync_alignment: true`, with a
  link.
- **P5-F7: accepted.**

These corrections touch only docs and the plan, so the validation of
`75de884c` still applies to the code.

### Linked: audio tags in the chat model's `speech` (D12)

Not part of these phases. Intent discovery ran on 2026-10-12, and the outcome is
[#479](https://github.com/raymond-van/animama/issues/479). It depends on Phases
2–3. Its spec and plan placement are decided when `to-spec` completes it.

## Final integration review

After Phase 5, one `sdlc-reviewer` integration review covers:

- combined acceptance against the spec criteria;
- the cross-phase boundaries: backend frames, product-ui types, runtime and
  bridge;
- security: tokens, logging, the server transport;
- leftovers of the old ids;
- docs accuracy.

It may use at most two repair rounds. Still-valid phase evidence is reused.

### Final Integration Review #1 Findings

An independent reviewer (`sdlc-reviewer`) reviewed `7b50f27c` against
`00442ec9` across all phases, the folded follow-ups and the merge. Result:
**pass**, with no blocking code, contract or security finding.

The reviewer verified the following:

- realtime protocols and timing;
- #498's feed into the socket;
- the renamed Gemini path;
- the Pocket fallback;
- retired ids and the `eleven_v4` refusal;
- the utility route;
- D8;
- production exclusion and session replacement;
- contracts and versions;
- security;
- the merge;
- the fixes left to this review (FF3-F1, FF3-F2, P4R2-F1 and P4R2-F2).

Findings:

- **FI-F1 (required, plan record).** The plan did not yet close Phase 5's
  review. The reviewer verified that P5-F1 to P5-F3 hold in the draft and the
  contract.
- **FI-F2 (optional).** Stopping a replay cleared the avatar's lip-sync, so a
  reply that started speaking during a replay could lose its mouth. The guide
  overstated the guarantee.
- **FI-F3 (optional).** The contract's retired-id sentence should name the risky
  case: a route that does not validate its `dispatch_options`.
- **FI-F4 (optional).** A few small live checks had no spend line.
- **FI-F5 (optional).** An emoji-ending reply on v4 Turbo is unverified.
- **Nits:**
  - "Production Loading" could list the lip-sync capture;
  - the plan's orientation showed only the old versions;
  - the spec snapshot's authorization line was out of date;
  - the P5-F1 choice belongs in the Decision Log.

### Final Integration Review #1 Revisions

- **FI-F1: accepted.**
  - Progress marks Phase 5 and this review.
  - This record states that the review verified P5-F1 to P5-F3.
  - Phase 5 records its validation.
- **FI-F2: accepted.**
  - `stopReplaySegment` leaves the avatar's lip-sync when a reply has started
    speaking.
  - The view ends a replay as soon as a reply starts speaking.
  - Both have tests, and the guide says exactly that.
- **FI-F3: accepted** with the reviewer's wording.
- **FI-F4: accepted.** The Phase 5 results add the missing checks; the total is
  about US$0.21.
- **FI-F5: accepted.** It is G2 item 7.
- **Nits: accepted.**

After the repairs, `tsc` and ESLint are clean, and Vitest across `src/ui/debug`
and `src/stores` passes 9 files and 110 tests.

Repair budget: round 1 of 2 used.

### Final Integration Review #2 Findings

Targeted recheck of `bc6e491a`. Result: **pass**. FI-F1 to FI-F5 and the nits
are verified, and the record matches the validation logs.

- **FI2-F1 (optional, recommended).** The FI-F2 guard skipped the clear whenever
  any reply was speaking.
  - A reply without its own plan (Japanese, Chinese or Korean, or an English
    reply whose plan is still building) kept the replay's segment on a
    stopped clock.
  - Its mouth froze in the replay's last pose.
- **FI2-F2 (optional, record).** The `web:test` and `packages:test` rows did not
  break down their suites.

### Final Integration Review #2 Revisions

- **FI2-F1: accepted.** `stopReplaySegment` skips the clear only when a speaking
  run has applied its own plan (`startedRuns`), with a store test for each
  case. The guide says so.
- **FI2-F2: accepted.** The rows list the 220 Node and browser tests, including
  both hosted server-socket tests, and runtime-contracts' 3 tests.

Repair budget: round 2 of 2 used. A final targeted recheck closes this review.

### Final Integration Review #3 Findings

Last targeted recheck, of `b1900883`. Result: **pass**, with no findings and no
regressions.

- FI2-F1 and FI2-F2 are verified.
- The reviewer reran tsc, ESLint, Prettier and Vitest across `src/ui/debug` and
  `src/stores` (111 tests), and checked the links.

Final integration review: **passed** (one full review and two repair rounds).

### Phases 1–2 scope review (2026-10-13)

Before the PR, a fresh `sdlc-reviewer` reviewed the authorized subset on
`37a661ff` against base `95a2db39` and the amended spec (#471, read back at
03:31 UTC). This is not the plan's final integration review, which follows
Phase 5.

**Result:** the code meets the authorized acceptance, with one blocking doc
line.

- **Cross-phase behaviour:**
  - realtime v4 Turbo is the only ElevenLabs path, and Gemini the only
    finalized provider, with no Gemini regression;
  - migration agrees across the backend validators, frontend reads and
    settings;
  - frames agree across the backend, product-ui and runtime;
  - the hosted server transport and the allowance → Pocket fallback are intact.
- **Versions:** `local-http` 6.0.0, `runtime-contracts` 0.6.0 and `product-ui`
  0.9.1 cover the cumulative changes, and the mirrors match.
- **Leftovers:** old ids appear only in the maps, their tests, refusal tests and
  mapping docs.
- **Security:** no token or key in any log, and the web runtime redacts the
  socket query.
- **Phases 3–5:** nothing blocks them. Alignment-only and null-alignment frames
  are tolerated, `sync_alignment` is on, and Cloud imports only the kept name.
- **The reviewer's checks:**
  - import boundary clean;
  - `openapi-ts:check` current;
  - pytest 247 passed with `UserWarning` as an error;
  - Vitest (7 files, 68 passed);
  - product-ui lifecycle 30 of 30;
  - the leftover, prose and security greps;
  - doc anchors resolve.

Findings and dispositions:

- **S12-F1 (blocking), accepted.** `avatar-lipsync.md` said "ElevenLabs (v4
  and v4 Turbo)". It now says "ElevenLabs (Eleven v4 Turbo)".
- **S12-F2 (optional), accepted.** `elevenlabs-tts.md` now says the "Stream
  chunked TTS" switch applies only to ElevenLabs, as `shouldStreamChunksForProvider`
  does.
- **S12-F3 (optional), accepted.** R7's live evidence on the current paths
  covered only Japanese, so the other languages were run live on 2026-10-13:
  - **Realtime v4 Turbo:** Korean 4.3 s, Chinese 4.2 s and Spanish 4.7 s of
    audio, each final with close 1000. A first Spanish turn lost its speech:
    its OpenAI stream took 37 s to open while the session token was minted at
    the same moment, which points to a transient network stall. The browser's
    existing 1.5 s session wait then ended that run's speech with its notice,
    and the text was intact. The retry spoke.
  - **Gemini:** Korean, Chinese and Spanish replies came as 19, 33 and 34
    `tts.audio` frames and `tts.done`, with no errors.
  - Japanese was spoken live on both paths earlier (Phase 1 realtime; the
    amendment's Gemini check).
  - Spend: about 250 characters of v4 Turbo, under US$0.01.
- **S12-F4 (optional), deferred.** A Gemini decode failure shows "Failed to
  decode ElevenLabs finalized audio." The text predates this change and joins
  the ElevenLabs-naming follow-up, which should cover user-visible strings.

Scope review: **passed** after the S12-F1 fix (one round).

## Validation and acceptance

Spec acceptance mapping:

| Criterion | Evidence |
| --- | --- |
| Realtime on local web and desktop, latency | Phase 1 live numbers (median of 5 per surface) and runtime tests |
| Connection handling | Phase 1 tests (keep-alive, cancel) and the live pause check |
| One ElevenLabs model (D13) | Phase 2 amendment tests (`eleven_v4` refused, `eleven_v3` realtime), the settings check and the repository search |
| Every language | Phase 2 per-language tests (Gemini) and live replies; Phase 1 streamed check |
| Migration | Phase 1 (realtime ids) and the Phase 2 amendment (`eleven_v3` → `eleven_v4_turbo`) tests, and the repository search |
| Timing evidence and module | Phase 3 tests on recorded fixtures |
| Side-by-side view | Phase 4 tests, screenshot, G2 |
| Failures and allowance fallback | Phase 1 runtime and product-ui tests; existing fallback suites |
| Hosted | Phase 1 server-socket compatibility tests; Phase 5 contract and Cloud issue |
| Docs and contracts | Phases 1–2 contract bumps, `openapi-ts`; Phase 5 docs and package-set compare |
| Checks | Phase 5 full run |
| Owner gate | G2 |

Not run by agents: real IVC playback (spec D5), real hosted Cloud speech (G3),
and packaged desktop release builds.

## Idempotence and recovery

- **Preferences:** migration is a pure normalisation; a migrated value written
  back is idempotent. Reverting the release leaves `eleven_v4_turbo` stored. An
  older build normalises unknown ids to its default, so it still speaks with
  Flash; that is acceptable and needs no data repair.
- **Code:** no database or schema changes. Phase commits can be reverted
  independently in reverse order. Phase 1 stands alone. Reverting it alone
  restores Flash and the Text to Speech socket.
- **Live checks:** re-running them costs characters (G1). The spike scripts are
  rerunnable and print no secrets.
- **Stacks:** `./reset.sh --name ev4 ...` is idempotent. Tear down with
  `docker compose -p animama-ev4 down` after the last use; keep the volumes
  unless the owner asks for a purge.
- **Restoring a finalized ElevenLabs model (contingency for D1 and D13):** the
  finalized ElevenLabs path was removed in the Phase 2 amendment. Restoring
  `eleven_v4` or a Legacy `eleven_v3` would mean reviving the reviewed Phase 2
  implementation from `c6b87dd2`. That is a bounded follow-up, decided at G2.

## Outcomes & Retrospective

Delivered in raymond-van/animama#497:

- ElevenLabs speaks only with Eleven v4 Turbo, in realtime over the Text to
  Dialogue socket. Median first audio is 155 ms on web and desktop, against
  862 ms for Flash v2.5 as Animama sent it.
- Retired ids map to v4 Turbo, and finalized ElevenLabs is gone (D13).
- Every language is spoken. Japanese and Chinese start before the reply ends
  (#498), and Gemini's finalized path carries neutral names (#499).
- ElevenLabs character timing is collected on one clock per run and turned
  into lip-sync evidence. A development-only view compares lip-sync plans
  against it and replays them on the avatar.
- The hosted contract documents optional server-socket timing. A Cloud draft
  states the changes and their order.

Still open:

- the G2 owner gate;
- the G3 Cloud rollout.

Lessons:

- Provider timing is close to the audio but not exact. A turn's timing can run
  80 ms past its audio, and tag spans can be shorter than their sound. Planners
  should resynchronise at turn ends and treat these as hints.
- The debug panel closes on outside clicks, so tools that must watch a reply
  should run while the panel is enabled, not only while it is open.
- Japanese, Chinese and Korean replies have never had lip-sync (no gruut
  phonemes). Provider timing is the first evidence for them (#468).
- The containerised local validation stalled on macOS while installing into a
  bind mount. Native runs gave the same coverage except for Docker-backed
  tests.
