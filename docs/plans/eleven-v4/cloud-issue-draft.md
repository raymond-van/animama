# Cloud issue draft: speak hosted replies with Eleven v4 Turbo

Status: draft for the Cloud repository. File it there only with the owner's
go-ahead (plan Phase 5); otherwise hand it over as written.

Source: Animama issue raymond-van/animama#471, delivered in pull request
raymond-van/animama#497. The hosted contract is
[`contracts/hosted-web.md`](../../../contracts/hosted-web.md) in Animama.

---

**Title:** feat: speak hosted replies with Eleven v4 Turbo and forward character timing

### Problem

Animama now speaks every ElevenLabs reply with Eleven v4 Turbo
(`eleven_v4_turbo`) and has retired Eleven v2, v2.5 and v3.

- Animama's shared chat route maps requests that name `eleven_flash_v2_5`,
  `eleven_multilingual_v2` or `eleven_v3` to `eleven_v4_turbo`
  (`PyAnimaTtsRunOptions`), and refuses `eleven_v4`.
- Cloud's own `chat:sse` route passes `dispatch_options` to
  `merge_chat_request_options` as a plain object. That function keeps only
  supported ids, so after adoption a retired id becomes no model at all unless
  Cloud maps it first.
- ElevenLabs has no finalized chat speech any more; Gemini is the only provider
  whose audio the chat route pushes.

Cloud still accepts and prices only the old ids, and keeps a finalized
`eleven_v3` path. Once Cloud adopts the new Animama packages, hosted speech
would name a model Cloud rejects or cannot price, or no model at all. Every
hosted reply would lose its voice; the reply text would stay.

### Scope

Include:

- Speak hosted realtime replies with `eleven_v4_turbo`.
- Price it.
- Retire the finalized `eleven_v3` path.
- Optionally forward ElevenLabs character timing on the server socket.

Exclude:

- Direct provider sockets for hosted browsers.
- Lip-sync rendering. Animama #468 owns that.

### Required behavior

1. **Models.**
   - The speech adapter's model set becomes `eleven_v4_turbo` only. It comes
     from `SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS` in the adopted Animama
     backend.
   - **Map retired ids at Cloud's own route.** Apply
     `replace_retired_elevenlabs_tts_model_id` (from
     `animama.app.contracts.elevenlabs`) to `dispatch_options.tts.model_id`, or
     validate `tts` with `PyAnimaTtsRunOptions`, before merging the options.
     - Without this, a tab opened before the deploy sends `eleven_flash_v2_5`,
       and the turn gets no model.
     - `tts.session` then carries `model_id: null`, the browser refuses the
       session, and the reply's speech ends with its notice.
   - Remove the `eleven_v3` handling in the speech turn:
     - the `tts.error` kind;
     - the per-part request split and finalized chunking;
     - the skipped `tts.session`;
     - the no-session `tts.audio` and `tts.done` delivery.

     With the mapping in place, that path is unreachable after adoption.
   - `ProductSpeech` no longer extends `FinalizedSpeechPort`, so a
     `ProductSpeech` implementation no longer needs `prepare_finalized` or
     `stream_finalized`.
2. **Pricing.**
   - Add `hosted:eleven_v4_turbo` at the current gross pay-as-you-go API price.
     Check elevenlabs.io/pricing/api at implementation. `GET /v1/models`
     reported a character cost multiplier of 0.5 for v4 Turbo and 1.0 for v4 on
     2026-10-12.
   - Keep the retired keys only while stored usage needs them.
   - The currently pinned backend's option normalizer drops
     `eleven_v4_turbo`. Before adoption, Cloud can only add the price and its
     own literal; acceptance takes effect with the new backend (step 2 below).
3. **Provider endpoint.**
   - The plain Text to Speech HTTP stream (`/v1/text-to-speech/{voice}/stream`)
     accepted `eleven_v4_turbo` in Animama's spike. ElevenLabs documents v4 only
     for Text to Dialogue (`/v1/text-to-dialogue/stream`).
   - Pick one. On it, and on its `/with-timestamps` variant, confirm that the
     `character-cost` receipt still equals the text's length, as the adapter
     requires. With v4 Turbo's 0.5 multiplier it may not, and every call would
     then settle as unmeasured.
   - v4 accepts only the stability and similarity voice settings. Text to
     Speech HTTP names the latter `similarity_boost`.
4. **Optional character timing.**
   - Request the endpoint's `/with-timestamps` variant. Its newline-delimited
     JSON carries `audio_base64` and `alignment` (`characters`,
     `character_start_times_seconds`, `character_end_times_seconds`), timed
     from the start of each request.
   - Forward each chunk's `alignment` beside its audio on the server socket, as
     `{"audio": ..., "alignment": {...}}`.
   - Offset the times by the audio already sent for the run in earlier
     requests: samples ÷ 24,000 at `pcm_24000`. The browser expects seconds from
     the run's first audio sample.
   - Omit `alignment` when it is absent; the browser ignores malformed timing.
     Keep the rule that only these documented fields cross custody.
   - Cloud's `tts.session` sends `sync_alignment: false`. The browser ignores
     that field on the server transport, so timing is opt-in by sending
     `alignment`.
5. **No direct tokens.** Never issue `ttd_websocket` single-use tokens to
   multi-user browsers. A token binds no text, voice or model, so a browser
   holding one could speak anything on the operator's account, beyond any
   reservation.
6. **End marker.** `{"isFinal": true}` is unchanged; the browser also accepts
   `{"is_final": true}`.
7. **Allowance.** A `speech_allowance_exhausted` refusal for ElevenLabs arrives
   only as `tts.session.error`, never `tts.error`, so the browser's Pocket TTS
   fallback still applies.
8. **Concurrency, only if Cloud moves realtime to a server-side dialogue
   socket.**
   - Open a session only while a reply speaks, and close it at the end or on
     cancel.
   - Cap and queue sessions per operator.
   - Treat a refusal as a speech refusal that keeps the text.
   - Measure the operator plan's limit before launch. The owner's plan showed
     none at 8 generating or 16 idle sessions.

### Rollout ordering (Animama gate G3)

1. **Cloud first.** Price `eleven_v4_turbo` and add the route's retired-id
   mapping alongside the current ids. The pinned Animama backend does not list
   v4 Turbo, so Cloud names it itself during the transition.
2. **Adopt the new Animama packages and the hosted web app together:**
   - the backend from this change's package set: the backend wheel keeps
     version 0.3.0, so identify it by its source commit;
   - `runtime-contracts` 0.6.0;
   - `product-ui` 0.10.0.

   Cloud pins `runtime-contracts` 0.4.0 and `product-ui` 0.8.0 today. Adoption
   must also admit `local-http` 6.0.0; Cloud's lock admits only 4.x.
3. **Remove the retired ids, pricing and `eleven_v3` branches** once no stored
   preference or usage row needs them.

`product-ui` 0.10.0 renames the finalized-audio effects to
`acceptFinalizedAudio`, `completeFinalizedAudio` and `markFinalizedAudioFailed`.
This is informational while Cloud implements no `ChatSessionEffects`.

### Acceptance criteria

- A hosted reply speaks with `eleven_v4_turbo`. A saved `eleven_v3`, Flash or
  Multilingual preference speaks the same way.
- The allowance refusal still falls back to Pocket TTS in the browser, and the
  text is never lost on a speech failure.
- Billing settles from the provider's receipt for v4 Turbo at the new price.
- With timing enabled, Cloud's server-socket tests show audio frames carrying
  run-relative `alignment`, including the offset on a later request of the
  same run. The frames can also be inspected in the browser's developer tools on
  the hosted build. Animama's runtime tests cover the browser side.
- Cloud's tests and local pre-PR gate pass.
