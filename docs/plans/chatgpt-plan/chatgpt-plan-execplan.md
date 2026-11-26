# Use a ChatGPT plan instead of an API key

Source agreement: [#919](https://github.com/raymond-van/animama/issues/919),
published from the agreed [spec](chatgpt-plan-spec.md) at
2026-11-24T18:25:43Z. The owner accepted the spec on 2026-11-24 including P1
to P8, and it was revised the same day with this plan's D2, D5 and D6.
Authorized scope: the whole plan. The owner approved it, including D1 to
D14, on 2026-11-24 (G0), authorized Phase 0 the same day, and asked for the
rest to be implemented after Phase 0 ("implement the execplan"). Gates G1 to
G4 still apply where the phases name them.
Planning baseline: `origin/main` at `1c7d7295e`, which the line numbers below
refer to. Implementation base: `origin/main` at `c7b98f73a`; nothing the plan
cites changed between the two.
Workspace: worktree `chatgpt-plan`, branch `feat/chatgpt-plan`. Task stack
`animama-chatgpt-plan` at `http://animama-chatgpt-plan.localhost:9100`,
started with `./reset.sh --name chatgpt-plan --base-port 9100` when a phase
needs it and stopped afterwards; it holds only test data.

## Purpose and context

After this plan, a person using the desktop app or a self-hosted stack on
their own machine can choose **Continue with ChatGPT** in App Settings →
Models or in first-run setup, sign in at OpenAI in their browser, and pick a
model from their ChatGPT plan for an Anima's chat, the default chat model,
Utility and the Memory Manager, with no API key. Tokens rest only on that
machine. The app shows when the plan is in use, links to OpenAI's usage
settings, stops cleanly at a usage limit and never moves a request to another
connection by itself. Work the backend starts by itself uses the plan only
after the person agrees. Hosted, embeddings, speech and image generation are
out of scope. No database migration is expected.

Orientation, from read-only surveys on 2026-11-24 (paths under
`src/backend/animama` unless they start with `src/frontend`, `tests`, `docs`,
`scripts` or `contracts`; line numbers at `1c7d7295e`):

- **Admission.** `local/http/admission.py` `LocalHTTPAdmission` (L55) admits
  every HTTP and WebSocket request, including `/health` and static files.
  `Host` must equal `LocalHTTPConfig.authority` exactly or the answer is 421
  (L131). `_browser_status` (L91) then requires `Origin`, when present, to
  equal the public origin, `Sec-Fetch-Site` to be absent, `none` or
  `same-origin`, and on desktop a matching `animama_renderer_capability`
  cookie (401 otherwise). Only `/_desktop/*` takes another path, with its own
  control token. OpenAI's return to `http://127.0.0.1:<port>/auth/callback` is
  a cross-site navigation from the system browser, so today it is refused in
  every mode: 403 for the fetch metadata, 401 on desktop for the cookie, and
  421 on a stack whose origin is `http://localhost:<port>`.
- **Origins.** Desktop uses `http://127.0.0.1:<saved port>`, stable across
  launches (`src/frontend/desktop/src/main-process/runtime/supervisor.ts`
  L321-345, `runtime/state.json`). A stack uses `ANIMAMA_PUBLIC_ORIGIN`,
  default `http://localhost:8000` (`server/config.py` L69); `reset.sh` allows
  loopback hosts only. In development Vite serves that origin and proxies to a
  private FastAPI with the browser's `Host` unchanged.
- **Serving.** `local/http/composition.py` `install_local_http` (L21)
  registers the asset catch-all last (L90-95), so a router included earlier in
  `server/app.py` `create_local_app` wins. `local/http/assets.py` answers a
  navigation outside `_NO_FALLBACK_PREFIXES` (L90-103) with `index.html`, so
  `/auth/callback` would return the app shell today. The development proxy
  forwards only `/v1`, `/health` and telemetry
  (`src/frontend/web/vite-plugins/local-api-proxy.ts` L34-48).
- **Routes and capabilities.** `product_http/inventory.py` lists every route
  in mount order as `_shared`, `_local` or `_excluded(capability)`, and
  `tests/test_product_http_inventory.py` pins it.
  `server/routers/model_configuration.py` is the local-only precedent, mounted
  at `server/app.py` L100. `app/contracts/runtime_capabilities.py` (L56) and
  `server/runtime_capabilities.py` (L45) define and fill capabilities,
  `contracts/runtime-capabilities/hosted.json` holds the hosted values, and
  `src/frontend/web/src/app/hosted-runtime/hosted-composition.ts` L527-545
  refuses local-only ones.
- **Contracts.** `contracts/versions.json` has `local-http` `23.0.0`; any
  structural OpenAPI change needs a new major. `runtime-contracts` is `0.23.0`
  and `product-ui` `0.20.0`; changed declarations need a version bump, checked
  by `scripts/package-sets` `compare`. The chat image input plan (#904) also
  plans `24.0.0`; whichever merges second takes the next major.
- **Credentials today.** Keys live in the desktop vault
  (`src/frontend/desktop/src/main-process/runtime/vault.ts`), one
  `safeStorage`-encrypted blob at `secrets/vault.bin` that also holds the
  generated `postgresPassword`. Electron main sends keys to the backend in the
  spawn environment and through `PUT /_desktop/credentials`
  (`server/routers/desktop_control.py` L141) into `RuntimeCredentialStore`
  (`app/model_clients/credential_store.py`). Nothing flows from the backend to
  Electron main. `backendEnvironment()` (`supervisor.ts` L222) carries
  backend-only values such as the control token. A self-hosted backend reads
  keys from its environment at startup.
- **Private data.** `ANIMAMA_DATA_ROOT` is `<userData>/data` on desktop and
  the `data` volume in a stack; `server/local_runtime.py` L85 lays out
  `internal/…`. `adapters/content_store/mutations.py` `persist` (L225) is the
  atomic owner-only write (`utils/files.py` `open_no_follow`,
  `sync_directory`, `replace`). `scripts/backup-local.sh` L98 archives the
  whole data tree except listed paths.
- **Catalog.** Connections and models are rows in `model_connections` and
  `model_providers` (unique on `connection_id, provider_type, model, source`).
  Built-in ones come from `app/model_catalog.py` through the repeatable seed
  `src/backend/migrations/seeds/01-seed-model-providers.sql`, which runs at
  every start and deactivates any `builtin` row missing from the catalog
  (L165). Row ids are `<provider_type>:<model>`. Anthropic is the precedent
  for a built-in connection: `domain/model_connection.py` L17-20,
  `app/model_clients/credentials.py` L97-142, `app/model_connection_presets.py`,
  `app/services/model_configuration_service.py` `_provider_type` (L569) and
  `app/chat/direct_turn/provider_state.py`
  `validate_model_provider_for_direct_turn` (L90). `ModelCatalogPolicy`
  (`app/services/model_provider_catalog_service.py` L19) offers the hosted
  composition the `openai` connection only.
- **Selections.** An Anima's model is
  `anima_chat_profiles.default_model_provider_id`, a foreign key to
  `model_providers.id`. Roles are owner preferences read by
  `app/services/model_role_resolver.py`, whose `suits_role` (L149) already
  limits Embeddings to embedding models. A missing credential is found at
  request time, not at selection, and the public model list carries no
  credential state.
- **Responses adapter.** `adapters/model_clients/openai_responses/client.py`
  refuses any connection but `openai` (L159), resolves the key once per stream
  and makes a per-request view of one key-free `AsyncOpenAI` with
  `with_options(api_key=…)` (L406). `request.py` `create_response_kwargs`
  (L53) sends `store` (true unless told otherwise), `moderation` when crisis
  detection is on, `previous_response_id`, `context_management`,
  `prompt_cache_key`, `reasoning` and flat function tools (L475). Tool rounds
  inside a turn chain with `previous_response_id` even when `store` is false,
  and replay by hand only after the provider rejects the cursor
  (`app/chat/direct_turn/model_stream.py` L870). Reasoning items are never
  replayed. `adapters/model_clients/openai_errors.py` classifies errors and
  redacts `Bearer`, `sk-` and `hf_` shapes, but not a bare JWT.
- **Behavior keyed by provider type.** The client registry
  (`server/model_clients.py` L43), the chat-row cursor (`provider_state.py`
  L294, `app/services/chat_manager.py` L69), inline moderation
  (`provider_state.py` L218), native compaction
  (`app/chat/direct_turn/constants.py` L18), hosted tools
  (`app/model_provider_native_tools.py` L14) and the API standard
  (`app/chat/api_standard.py` L32) switch on `provider_type`, not on the
  connection.
- **Other model users.** Titles and compaction run through
  `app/services/direct_model_prompt_runner.py` on the Utility role. The Memory
  Manager on Responses rows uses the OpenAI Agents SDK
  (`adapters/memory_manager/openai_agents_runtime.py`): not streamed,
  `store=True`, `previous_response_id`, native `apply_patch`. A Reflection is
  owner-started. Automatic episode processing (`server/episode_processing.py`)
  is the only model work the backend starts by itself; it reports
  `needs_model` when `server/memory_manager.py`
  `local_memory_manager_model_usable` (L126) is false.
- **Desktop shell.** Any `https` link the page opens goes to the system
  browser (`src/frontend/desktop/src/main-process/security/guards.ts`
  L154-169); there is no host list. The preload exposes status-only
  credentials.
- **Settings UI.**
  `src/frontend/web/src/ui/settings/models/ModelConnectionsSettings.tsx`
  renders a `ConnectionCard` per connection with `BuiltinKey` (L679) for its
  key; `model-configuration-state.ts` holds the provider tabs (L138) and
  status text. `ModelDefaultsSettings.tsx` renders the role pickers from
  `roleCandidates`. The chat picker is `ChatInputModelSelector`
  (`src/frontend/web/src/ui/components/chat-input.tsx` L400), and
  `src/frontend/web/src/ui/main/chat/ChatInterface.tsx` L413-547 lays out the
  composer with a `role="status"` line. First-run setup is
  `src/frontend/web/src/app/local-runtime/setup/SetupAiStep.tsx`. Chat
  failures map codes to text in
  `src/frontend/packages/product-ui/src/chat/chat-failure.ts` and can carry
  an `https` link button.
- **Localization.** Five locales. Model settings strings are in
  `src/frontend/web/src/locales/<locale>/models.json`. `pnpm i18n:check`
  enforces key and placeholder parity, and codes in `userVisibleCodes.json`
  need wording in every catalog.
- **Tests.** Backend fakes are `httpx.MockTransport`, `httpx2.MockTransport`
  and `_FakeOpenAIClient` (`tests/test_model_client_registry.py` L85). Stacks
  under test run `ANIMAMA_LLM_SKIP=1`, which registers `MockModelClient` for
  every provider type. Journeys intercept routes with Playwright.
- **Dependencies.** `openai` `3.39.0` has `NamespaceToolParam`, and its
  function-call items carry `namespace`. `pyjwt` `2.15.1` and `cryptography`
  `50.0.2` are locked as transitive dependencies; no backend module imports
  them. `openai-agents` `0.24.0` has `tool_namespace`, `run_streamed` and a
  `store` setting. The desktop bundle collects every `animama` submodule
  (`src/backend/packaging/desktop/animama-runtime.spec` L45).
- **Records.** `licenses/source-review.json` lists every tracked file; each
  phase adds entries for its new files.

OpenAI facts, read from the official documentation on 2026-11-24. The route
is a preview, so Phase 0 tried them against a live account. Where the trial
differed, "Live trial" under Surprises & Discoveries says how.

| Topic | Rule |
| --- | --- |
| Registration | The first sign-in sends `client_id=dynamic_agent_client`, `agent_name_hint` (the app's own name) and a stable `ext_agent_host_id`. The return carries the issued `client_id`, which later sign-ins reuse. There is no client secret. |
| Authorization | System browser to `https://auth.openai.com/api/accounts/authorize` with PKCE `S256`, `state`, `nonce`, `resource=https://api.openai.com/v1` and scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`. |
| Return | An HTTP loopback URI on `127.0.0.1`, such as `http://127.0.0.1:<port>/auth/callback`. Only the port may vary later; `localhost` is not accepted. |
| Tokens | Code exchange and refresh at `https://auth.openai.com/api/accounts/oauth/token`. Access tokens last one hour. Refresh tokens last 30 days and are replaced on every refresh. The response carries `earliest_refresh_at`. |
| ID token | Validate the signature against OpenAI's JWKS, then issuer, audience (the issued client id), expiry and nonce. Plan use needs `chatgpt.tokens.use.direct` among the granted scopes. |
| Sign-out | Revoke the refresh token at the discovery document's `revocation_endpoint`, then clear tokens. Keep the client id and host id. |
| Models | `GET https://api.openai.com/v1/models` returns the account's `models[]` with `slug`, `display_name` and `visibility`. |
| Inference | `POST /v1/responses` only, with `store: false` and `stream: true`. A request succeeded only once `response.completed` arrives. |
| Rejected fields | `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`, `previous_response_id` over HTTP, and system-role input items. |
| Tools | Function and custom tools must be grouped in namespaces or supplied through `additional_tools` input items. Image generation, file search, Code Interpreter, computer use, hosted MCP and `tool_search` are unsupported. Web search depends on the model and account. |
| Inputs | Text, images and files where the model accepts them. No audio or video input, Files upload or transcription. |
| Errors | `subscription_sharing_usage_limit_exceeded` (429), `…_user_not_eligible` (403), `…_usage_unavailable` and `…_user_unavailable` (503), `…_unsupported_capability` (400), `…_route_not_supported` (403), `…_invalid_user` (401). Admission can fail before the stream with a bare `{"detail": …}` body. OpenAI never moves a request to another billing path. |
| Plans | The developer documentation names Plus and Pro. The end-user page names Go, Plus, Pro and Business, where a Business admin must allow the app. Free is on neither list. Usage draws on the plan's existing allowance. The Phase 0 trial confirmed sign-in and the route on a Go plan (the tier as the account holder stated it, 2026-11-24); Go's allowance was not reached. |
| Limits | The Plus five-hour limit is shared across every app. A person can cap one app's weekly share in ChatGPT's settings. |
| Interface | A one-time "You're using your ChatGPT plan" confirmation; **Continue with ChatGPT** to start; "Using ChatGPT plan" with **Manage usage** near the composer or model selector; **Manage usage** as the primary action at a limit. |
| Terms | Effective 2026-11-04: requests originate from the person's own runtime; tokens are stored locally under their control; express consent before background use; the plan serves only the connected app; no charge to use it; OpenAI may suspend access. |
| Remote hosts | A `127.0.0.1` return reaches the machine running the browser. OpenAI's guidance for a remote machine is to sign in locally and copy the credential file, which this plan does not build (spec P2). |

The namespace tool shape comes from the pinned SDK's types:

```text
{"type": "namespace", "name": …, "description": …,
 "tools": [{"type": "function", "name": …, "parameters": …}]}
```

## Threat model

Assets: the access token, the rotating refresh token, the retained ID token,
the desktop store key, the authorization code, and a pending attempt's `state`
and PKCE verifier. Boundaries: the system browser and the backend (the
sign-in return), the app page and the backend (`/v1`), the backend and
OpenAI, the backend and its disk, logs and child processes, and Electron main
and the backend.

| # | Threat | Mitigation | Negative tests |
| --- | --- | --- | --- |
| T1 | The sign-in return exemption admits requests the normal checks refuse. | The exemption covers exactly `GET /auth/callback` over HTTP, and only when the installation's origin is a loopback `http` origin. `Host` must equal `127.0.0.1:<public port>`. No `Origin` and no body. `Sec-Fetch-Mode`, when present, must be `navigate` and `Sec-Fetch-Dest` must be `document`. A request that misses any condition gets the normal checks, and every other path is unchanged. | Other methods, a WebSocket, a body, an `Origin`, `Host` `localhost:<port>`, another port or `evil.test`, subresource fetch metadata, a non-loopback public origin, `/auth/callback/x` and `/auth/other` are refused as today. On desktop `/v1` without the cookie is still 401. |
| T2 | Login CSRF or code injection: a page or local process drives the return with an attacker's code, or replays one. | One pending attempt at a time with a ten-minute life. A 256-bit `state` is compared in constant time and consumed once. The PKCE verifier and nonce never leave the backend. On reauthorization a returned client id must match the attempt. A wrong `state` neither completes nor cancels the pending attempt. | Missing, wrong, expired and reused `state`; a mismatched client id; a second return after success; an `access_denied` return. Each gets the fixed failure page and leaves the session unchanged. |
| T3 | A token, code or the store key leaks through logs, errors, URLs, API responses, diagnostics, the page or backups. | Tokens exist only in the session service and its file. Status responses carry state, email and scopes. Secret fields use `repr=False`. Provider error text passes a redactor that knows JWT shapes and the current token values. The return handler never logs or reflects its query and answers with a static page marked `no-store` and `no-referrer`. The authorize URL, which can carry an ID token hint, is never logged. Backup and restore skip the session directory. | A sentinel token and code appear in no response body, `caplog`, captured stderr, exception chain, database row, stream event or diagnostics summary, on success and on each failure path. G2 scans a packaged profile's logs. |
| T4 | A token is sent to the wrong host. | Access tokens go only to `https://api.openai.com`; refresh and ID tokens only to `https://auth.openai.com`. Both origins are constants, not settings, and ignore `OPENAI_BASE_URL`. Redirects are not followed. The plan client carries no organization, project or custom headers from the environment. | With `OPENAI_BASE_URL` set to another host the plan client still targets `api.openai.com`; a redirect response is an error; a discovery document that names another host for revocation is refused. |
| T5 | A rotated refresh token is lost or used twice. | One refresh at a time. The new token set is written atomically before any request uses it. `earliest_refresh_at` is respected. A terminal refresh error clears tokens and asks for sign-in; a transient one does not. | Concurrent requests near expiry cause one refresh; an interrupted write leaves the previous file intact; each terminal error code clears tokens; a network error keeps them. |
| T6 | Tokens at rest are readable by another user, or survive sign-out. | Directory mode 0700, file mode 0600, atomic replace, no symlink following. On desktop the file is AES-256-GCM ciphertext under a key that only the vault holds (D2). Sign-out revokes, then removes the token fields. A malformed or undecryptable file means signed out, and the file is removed. | File mode and symlink refusal; tampered ciphertext and a wrong key both mean signed out; sign-out leaves no token bytes on disk. |
| T7 | The plan is used for work the person did not agree to, or spend moves silently to another connection. | Every token request names its purpose. `background` is refused without recorded agreement and while a usage limit pauses the plan. No code path retries a plan request on another connection. | Automatic episode processing on a plan model without agreement makes no request; after a limit error a background request is refused until an interactive one succeeds; a failed plan turn sends nothing to any other connection. |
| T8 | The plan becomes a relay for other tools. | No route accepts a caller-supplied model request for the plan. Only the app's own features reach the plan client. | The inventory has no generic completion route; the status and preference routes accept fixed fields only. |

## Progress

- [x] Plan drafted on `feat/chatgpt-plan` from `origin/main` `1c7d7295e`.
- [x] G0: the owner approved this plan, including D1 to D14 (2026-11-24).
- [x] Workspace setup (2026-11-24): #919 published and read back, spec
  snapshot and plan tracked, branch fast-forwarded to `c7b98f73a`, Python
  dependencies installed. No stack started.
- [x] Phase 0: live trial of the route (2026-11-24). The probe was built and
  reviewed, and the trial ran on a live account: 24 of the 25 requests G1
  allows, then a sign-out that OpenAI confirmed. Findings are under
  Surprises & Discoveries; the choices they settle are in the Decision Log.
- [x] Phase 1: sign-in core (2026-11-24). Code Review #3 passed.
- [x] Phase 2: routes and the sign-in return (2026-11-24). Code Review #2
  passed.
- [x] Phase 3: desktop custody (2026-11-24). Code Review #2 passed.
- [x] Phase 4: settings and setup (2026-11-24). Code Review #2 passed; the
  manual check waits for G1 and G2.
- [x] Phase 5: the plan connection and its model client (2026-11-24). Code
  Review #2 passed; the manual check waits for G1.
- [x] Phase 6: chat on plan models (2026-11-24). Code Review #1's repairs
  were verified by the coordinator; the manual check waits for G1.
- [x] Phase 7: roles, agreement and limits (2026-11-24). Code Review #2
  passed; three optional points are made with Phase 8; the manual check
  waits for G1.
- [x] Phase 8: documentation and records (2026-11-24); its review is the
  final integration review's.
- [x] Final integration review (2026-11-24): Review #1 blocked on FI-R1-F1
  to F3, Review #2 on FI-R2-F1; Review #3 passed after repair round 2.
- [x] G3: the full pre-push suite (2026-11-24), recorded under "Full
  pre-push suite (G3)".
- [x] Pull request #924 opened (2026-11-24).
- [x] Merge with chat image input (#923, 2026-11-25): merged as
  `c5789c3de`; Merge Review #1 passed; the full suite ran on the combined
  candidate; the review's optional findings are made.
- [x] Phase 9: one OpenAI tab and the picker's plan notice (owner feedback,
  2026-11-25): Code Review #2 passed; merged with `main` after #921; the full
  suite ran on `fd4f13803`. The split rule and the R3.7 reading wait for the
  owner's confirmation.
- [x] G2: the packaged desktop check (2026-11-25), recorded under "Final
  state".
- [ ] G1 and G4 with the owner.

## Surprises & Discoveries

- 2026-11-24 (planning): nothing is exempt from admission today, not even
  `/health`. The sign-in return is the first browser route that needs a
  different rule, so it gets its own threat model row (T1) and tests.
- 2026-11-24 (planning): OpenAI's documentation requires function tools
  inside a namespace, and a tool call then returns with its namespace. The
  live trial found flat tools accepted all the same (see Live trial).
- 2026-11-24 (planning): most of the Responses adapter's behavior that the
  route forbids is keyed by provider type: the stored cursor, inline
  moderation, native compaction and hosted tools. A separate provider type
  avoids each of them without a connection check in every place (D3).
- 2026-11-24 (planning): tool rounds inside one turn chain with
  `previous_response_id` even for unstored requests. On the plan route every
  tool round would fail once and retry, so the plan client replays by hand
  from the first round.
- 2026-11-24 (planning): the seed deactivates every `builtin` model row that
  the static catalog lacks, at every start. Rows synced from an account would
  be switched off on restart unless the seed skips the plan connection (D4).
- 2026-11-24 (planning): the Memory Manager's Responses runtime is not
  streamed and stores its responses. The route allows neither, so Phase 7
  gives that runtime a plan mode.
- 2026-11-24 (planning): a Reflection never runs by itself. Automatic episode
  processing is the only model work the backend starts unprompted (D5).
- 2026-11-24 (planning): nothing flows from the backend to Electron main, but
  a refresh replaces the refresh token about hourly while the plan is in use.
  Writing each new token into the vault would need a new channel (D2).
- 2026-11-24 (planning): `scripts/backup-local.sh` archives the whole data
  tree, so a session file there would enter backups unless excluded.
- 2026-11-24 (planning): an earlier packaged check found `uvicorn.access`
  lines in the desktop log although the access log is off. Phase 2 confirms
  that no log line can carry the return's query string.
- 2026-11-24 (planning): the OpenAI SDK retries a 429 by default. A usage
  limit must stop, so the plan client sets no SDK retries.
- 2026-11-24 (Phase 0): the OpenAI SDK's default HTTP client follows
  redirects, and the SDK adds organization, project and custom headers from
  the shell's environment. Phase 5's plan client must pass an HTTP client
  with redirects off and omit those headers (T4), as the probe's SDK trial
  now does.
- 2026-11-24 (Phase 0): OpenAI's guide gives the issuer and the signing-key
  location through its discovery document. The probe reads both from there
  and holds them to OpenAI's sign-in host; Phase 1 should do the same, before
  any code is exchanged.
- 2026-11-24 (Phase 5): the SDK reads `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`
  and `OPENAI_CUSTOM_HEADERS` again for every per-request copy, so replacing
  a copy's default headers does not keep them off. The plan client's HTTP
  client strips them on the way out (a request hook with a header
  allowlist), and an explicit `Authorization` keeps the SDK from taking one
  from `OPENAI_CUSTOM_HEADERS`.
- 2026-11-24 (Phase 5): the evaluation tools (benchmark and gesture
  selection) read every active chat row, and build their registry without
  the app's session. They now leave plan rows out.
- 2026-11-24 (Phase 7): the Agents SDK (0.24.0) has its own tool
  namespaces (`tool_namespace`) and matches a returned call by its
  qualified name (`animama.memory_list_files`), so wrapping the tools
  outside the SDK makes it reject every call. Its unstreamed path calls
  `responses.create(stream=False)` and expects a finished `Response`, so a
  client that streams underneath serves it unchanged.
- 2026-11-24 (Phase 5): an existing test-order leak, unchanged by this plan:
  `test_seed_rerun_keeps_owner_rows_and_hidden_flags_and_retires_missing_builtins`
  leaves the seeded rows active, so
  `test_the_run_composition_reads_the_catalog_and_runs_chats_mock_client`
  fails when it runs later on the same xdist worker. The pair fails alone in
  that order. Recorded for the G3 run rather than fixed here.

### Live trial, 2026-11-24

The Phase 0 probe ran against a live account on model `gpt-6-luna`: one
sign-in, the model list, 24 route requests, one refresh and a sign-out that
OpenAI confirmed. The credentials file was deleted afterwards. Nothing below
identifies the account.

Sign-in, tokens and the model list:

| Subject | Observed |
| --- | --- |
| Registration | The first sign-in with `dynamic_agent_client` returned `client_id`, `code`, `iss`, `scope` and `state`. The discovery document matched the documented endpoints, and all six requested scopes were granted. |
| Token response | `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in` (3600), `scope` and `earliest_refresh_at`. |
| ID token | Signed with `RS256` and a key id. Claims: `iss`, `aud`, `sub`, `exp`, `iat`, `auth_time`, `nonce`, `at_hash`, `jti`, `sid`, `email`, `email_verified`, `name`, `given_name`, `family_name` and `https://api.openai.com/auth`. A refreshed ID token has no `nonce`. |
| Access and refresh tokens | The access token is a JWT of about 2,100 characters (`RS256`, type `at+jwt`), valid for one hour. The refresh token is opaque, about 200 characters, and its length varies. |
| Refresh | `earliest_refresh_at` is Unix seconds, 54 minutes after issue. A refresh sent about 50 minutes before that time was still accepted and replaced the refresh token. |
| Sign-out | The revocation endpoint answered 200. |
| Model list | `GET /v1/models` returned `models[]` with five items of 55 fields each. The useful ones: `slug`, `display_name`, `description`, `visibility` (`list` on three items, `hide` on two), `priority`, `context_window` (272,000 on every item), `max_context_window` (872,000), `input_modalities` (`text`, `image`), `supported_reasoning_levels` (`low` to `max`; one model adds `ultra`), `default_reasoning_level`, `supports_parallel_tool_calls`, `supports_search_tool`, `web_search_tool_type` and `apply_patch_tool_type` (`freeform`). |
| Model list, other content | The list is written for Codex, OpenAI's coding client. Each item carries that client's instructions and message templates (`base_instructions`, `model_messages`), tens of thousands of characters an item. `available_in_plans` names about 28 plans, `free` and `go` among them on four items. That field describes the model; the trial did not test which plans may use this route. |

Requests, each streamed and unstored:

| Request | Result |
| --- | --- |
| A plain prompt | Completed. The stream includes a `response.metadata` event that the pinned SDK does not type, and `usage` carries an `attribution` field. |
| `instructions` with a developer-role item | Accepted. |
| A system-role input item | 400 with the body `{"detail": "System messages are not allowed"}`. |
| A flat function tool | Accepted, although the documentation requires a namespace. The call has `name` and no `namespace`. |
| A function tool in a namespace | Accepted. The call keeps the tool's own `name` and carries `namespace` as a separate field. |
| An `additional_tools` developer item | Accepted. The call has no `namespace`. |
| `tool_choice: "auto"` with `parallel_tool_calls: false` | Accepted. |
| A tool round replayed by hand: the call with its `namespace`, then its output, with no cursor and no item ids | Accepted. |
| `reasoning.effort` at `low` and `high` | Accepted. |
| `include: ["reasoning.encrypted_content"]` | Accepted. No tool-calling request returned a reasoning item, at `low` or `high` effort, so no reasoning was replayed. The image request, which set neither field, returned a reasoning item with encrypted content. |
| `prompt_cache_key` | Accepted. |
| `text.format` with a strict JSON schema | Accepted and followed. |
| An image as a data URL | Accepted and read correctly. |
| `context_management` with a compaction entry | Admitted. The prompt was too short to compact, so compaction itself is untested. |
| Hosted `web_search` | A search ran: a `web_search_call` item, then a message. That response's terminal event carried no output items; they arrived only as `response.output_item.done` events. |
| Native `apply_patch` | 400 with the body `{"detail": "Unsupported tool type: apply_patch"}`. |
| `max_output_tokens` | Accepted, although the documentation lists it as rejected. Whether it is applied was not tested. |
| One request through the pinned SDK, with redirects off and no environment headers | Completed. |
| `/v1/embeddings` and `/v1/moderations` | 401 with an `error` object of type `rejected_by_access_enforcement` and code `no_matching_rule`, not the documented 403 `subscription_sharing_route_not_supported`. |

What this changes:

- `adapters/model_clients/openai_responses/final.py` reads the final items
  from the terminal event's `response.output`. On the hosted-search response
  that list was empty or absent; the probe cannot tell which. The plan
  client must fall back, in both cases, to the items it collected from
  `response.output_item.done` (Phase 5 step 5).
- The model list holds another product's prompts and is large. Model sync
  keeps a few fields of the `list` items and never logs the response (Phase 5
  step 3).
- The catalog gives `gpt-6-luna` a 1,050,000-token window, and the plan's
  list gives the same slug 272,000. A plan row uses the list's figure, so one
  model has a smaller window on the plan than on a key.
- A refused route answers 401. The trial never sent an expired or revoked
  token, so it does not show how that 401 differs. Phase 5 step 7 keeps
  its rule for every 401: one refresh and one retry.
- No request produced a `subscription_sharing_*` error, so Phase 5's
  mapping of those codes rests on the documentation.
- `earliest_refresh_at` is a number, not a date string, and a refreshed ID
  token has no `nonce` (Phase 1).
- The route accepts two things the documentation says it refuses: flat
  function tools and `max_output_tokens`. The plan client follows the
  documentation, because a preview route may start enforcing it.
- Reasoning replay is unproven. The route returns encrypted reasoning, but
  no trial request returned it beside a tool call.

## Decision Log

- 2026-11-24, owner: the spec is accepted as written, including P1 to P8. The
  sign-in has its own spec, is delivered before content generation uses it,
  uses the direct sign-in and serves local compositions only.
- 2026-11-03, owner (standing instruction, recorded during #823): phases run
  the checks their changes affect, not the full pre-push suite. The full suite
  runs once on the final candidate after the owner agrees to the run (G3).
- 2026-11-24, owner: plan approved with D1 to D14 as proposed (G0). The
  spec's R2.1, R4.1, R4.2 and one acceptance line were revised the same day
  to match D2, D5 and D6.
- 2026-11-24, owner: workspace setup and Phase 0 authorized.
- 2026-11-24, agent proposals, approved by the owner at G0. D2 and D5 changed
  the wording of an accepted requirement. The rest are implementation choices
  inside the agreed behavior.
  - **D1. The backend owns the sign-in in both runtimes.** One Python
    implementation of registration, exchange, validation, refresh and
    revocation. Electron main only opens the browser, as it does for any link.
  - **D2. Desktop custody: an encrypted file under a vault key.** The vault
    gains one generated key. The backend writes the session as AES-256-GCM
    ciphertext in its data directory. Spec R2.1 said the tokens rest "in the
    desktop app's encrypted vault"; it now says they rest in a file encrypted
    with a key held in the vault. The literal alternative was a
    control route that Electron main polls so it can copy each refreshed
    token set into the vault. It needs a new channel in a boundary that is
    one-way today, moves tokens across loopback at every refresh, and loses
    the session if the app stops between OpenAI's answer and the vault write.
  - **D3. A separate provider type for plan models**, proposed name
    `ChatGPTPlanResponsesHTTPAgent`, mapped to the existing Responses API
    standard so a chat can move between key and plan models (R3.6). Its
    client reuses the Responses request, stream and result code through a
    route profile.
  - **D4. Account-listed models are read-only built-in rows.** Sign-in and
    refresh upsert one row per listed model under the plan connection, with
    ids `<provider type>:<slug>`. Rows are active only while signed in, and
    the seed leaves this connection's rows alone.
  - **D5. Agreement gates work that starts by itself.** That is automatic
    episode processing. A Reflection the person starts is their own action
    and needs none, like a chat title. Spec R4.1 listed "the Memory Manager"
    beside automatic episode processing; it and its acceptance line now name
    automatic episode processing only.
  - **D6. A plan-selected role that may not run does not run.** Without
    agreement, or while paused, the job waits. It does not move to another
    model, and spec R4.2 now says so.
  - **D7. Agreement and the one-time confirmation live with the session**,
    not in shared owner preferences, so they stay local, follow the account
    and are asked again after a different account signs in.
  - **D8. Web search.** OpenAI's hosted search is offered on a plan model
    only if Phase 0 shows the route accepts it. Otherwise a plan model gets
    the app's own web search like any other tool-calling model, and the
    control explains when neither is available (R3.5).
  - **D9. Context window.** Use the account list's own figure when it has
    one, else the catalog's entry for the same model id, else 128,000 tokens.
    Phase 0 records what the list contains.
  - **D10. The return page speaks the installation's language**, from a small
    backend table in the five locales, because the app page is not involved.
  - **D11. The probe script is committed** as developer tooling, so the
    preview route can be checked again when OpenAI changes it.
  - **D12. One branch and one pull request.** The content generation plan can
    start from this branch once Phase 5 passes review, or from `main` after
    the merge.
  - **D13. `pyjwt[crypto]` becomes a declared dependency.** It and
    `cryptography` are already locked and installed; no new package enters
    the lock.
  - **D14. Sign-in is offered only when the installation's origin is a
    loopback `http` origin**, which is how the backend knows the return can
    reach it (spec P2). Anywhere else the app explains instead of starting.
- 2026-11-24, agent, from the Phase 0 trial (Phase 0 step 3). Each applies a
  rule the approved plan already set, and none changes agreed behavior.
  - **D8 settled: hosted web search is offered.** The route ran a hosted
    search. A plan row offers it when its list item has `supports_search_tool`
    true, and the app's own web search otherwise. Every listed item had
    it true, so the other branch is untried.
  - **D9 settled: the list's `context_window`.** Every item has one. A plan
    row uses it, not `max_context_window` and not the catalog's figure for
    the same slug. The fallbacks stay for an item without one.
  - **Compaction: the app's own.** The trial showed only that
    `context_management` is admitted, so plan rows do not send it. The plan's
    provider type stays out of the native-compaction set, and a chat fits its
    context to the row's window.
  - **Memory edits: the function form.** The route refuses native
    `apply_patch`, so no plan request declares it, in chat or in the Memory
    Manager.
  - **Reasoning replay: built, and on only once confirmed.** The route
    returns encrypted reasoning, but no trial response held a reasoning
    item beside a tool call, so its answer to a replayed one is unknown.
    The route profile gets a switch for requesting and replaying
    reasoning. It ships off, and the client then replays calls and outputs
    only, as the adapter's hand replay does today. The switch turns on in
    this plan only if Phase 5's manual check shows the route accepting a
    replayed reasoning item. It is a setting in the code, not a retry at
    run time.
  - **Tools stay in a namespace.** Flat function tools were accepted, against
    the documentation. The client still wraps them, so later enforcement
    does not break it. A tool's `name` comes back unchanged with `namespace`
    beside it, and a replayed call keeps both.
  - **Synced rows.** Only items with `visibility` `list` become rows. A row
    takes `slug`, `display_name`, `context_window`, `input_modalities`,
    `supports_search_tool` (as its hosted-search support) and the
    `supported_reasoning_levels` the app already knows. Nothing else from
    the list is stored or logged.
- 2026-11-24, agent, while building Phase 5. Implementation choices inside the
  agreed behavior.
  - **The session is checked where the token is taken.** A plan request asks
    the session for a token before anything is sent, and fails with
    `chatgpt_plan_sign_in_required` or `chatgpt_plan_use_not_granted` when it
    cannot have one. Turn setup checks only that a plan row is on the plan
    connection. A check at setup could pass and then the session end before
    the request.
  - **Model-client requests are the person's own.** Chat turns, their
    compaction and their titles are the only model-client callers, so the
    plan client asks for `interactive` tokens. The `background` purpose is
    for the Memory Manager's plan mode (Phase 7).
  - **Error categories.** A limit, an ineligible account and a required
    sign-in get new categories (`usage_limit`, `not_eligible`,
    `sign_in_required`); a temporary outage is `server_error` and an
    unsupported request `bad_request`. A refused prompt that names
    `context_length_exceeded` keeps its code, so the executor still fits
    the context. Their notices come with Phase 6.
  - **Reasoning replay is carried in the round's continuation**, keyed by the
    call each reasoning item came before, as Anthropic carries its rounds.
    The route profile's switch stays off.
  - **Plan rows stay out of the evaluation tools**, which run outside the app
    and have no session; the plan serves Animama's own features.
  - **Setup chooses a plan model** when the plan becomes usable there, as
    saving a key does: the model the system uses by default if the plan
    lists it, else the plan's first.
  - **A role assigned to an unavailable plan model waits** (from review
    P5-R1-F4). Signing out, or OpenAI no longer listing the model, retires
    its row; a role that names it, or inherits it from the chat role,
    resolves to no model instead of the operator default, so its job does
    not move to another connection (R5.2, D6). Other unavailable
    assignments still fall back as before.
  - **Bounded backoff** (from review P5-R1-F3). A temporary plan failure is
    retried twice, after 1 and 2 seconds, or after OpenAI's `Retry-After`
    when it asks for at most 10 seconds; a longer wait is reported with the
    failure.
  - **A sign-in reads as pending until its models are stored** (from review
    P5-R1-F1), so the page that sees it finish finds them.
- 2026-11-25, owner, after using the plan on the task stack (Phase 9):
  - **One OpenAI tab.** App Settings → Models and setup's AI step drop the
    separate ChatGPT plan tab; OpenAI's tab shows the plan card above a
    "Use an API key" card that says it is paid per request.
  - **Picker groups.** The chat's model picker heads OpenAI's models
    "OpenAI · ChatGPT plan" and "OpenAI · API key", side by side, and each
    row's second line says which. Model names stay as each source gives them.
  - **The plan notice moves into the picker.** "Using ChatGPT plan" with
    **Manage usage** leaves the space above the composer and becomes the last
    row of the open picker while a plan model is selected. OpenAI's interface
    guidelines ask for it near the composer or the model selector, and its own
    illustration places it in the model menu.
- 2026-11-25, agent, following the owner's entry above:
  - **OpenAI's rows split only while the picker lists plan models** (from
    review P9-R1-F1). The hosted composition serves an operator-paid model on
    the `openai` connection and never has plan models, and a local
    installation has none before signing in; in both, OpenAI's models keep
    one "OpenAI" group, as before. For the owner to confirm at the next
    visual check.
  - **R3.7 is met by the picker row.** The spec's "Using ChatGPT plan"
    requirement is read as satisfied by the row in the open picker, which
    OpenAI's guideline allows; #919's wording is unchanged.

## Phased implementation

Each phase starts from the previous phase's commit and writes its tests first.
Phase 0's findings can change later steps; a finding that changes agreed
behavior goes to the owner before the phase it affects. Phase 3 needs Phase 1.
Phase 4 needs Phase 2. Phase 5 needs Phases 0 and 1. Phase 6 needs Phase 5.
Phase 7 needs Phases 5 and 6. Phase 8 is last.

Module names below are proposals; the implementing agent may adjust them
within the repository's layering (domain, application services and ports,
adapters, server composition).

### Workspace setup

After G0, in worktree `chatgpt-plan`:

1. Merge `origin/main` if it moved. Run `uv sync --python 3.12.13 --extra
   voice --extra viz --extra realtime --extra encrypt --extra documents
   --all-packages --group dev`. Before the frontend phases run `pnpm install`
   in `src/frontend`, and run `git lfs pull` before backend content tests.
2. Publish the spec as the parent issue with the parent form's sections, read
   it back, and record the issue and its capture time in the spec file and at
   the top of this plan. Apply the type and triage labels the repository
   defines, after checking they exist.
3. Commit the spec snapshot and this plan as the plan's first commit.

### Phase 0: Live trial of the route

Review tier: standard. The probe is developer tooling, not product code, but
it handles real tokens, so the review reads its secret handling closely.

Requirements: spec checks C1 and C2. Informs D3, D4, D8 and D9.

Gate: G1 before any request.

Steps:

1. Add `scripts/chatgpt_plan_probe.py`, one file using `httpx`, `jwt` and
   `openai` from the project environment, with subcommands `sign-in`,
   `models`, `requests`, `refresh` and `sign-out`. It listens on `127.0.0.1`
   for its own `/auth/callback`. Its credential file path is a required
   argument; the probe creates it with mode 0600 and refuses a path inside a
   Git work tree. It prints field names, shapes and statuses, never token
   values.
2. Record these findings under Surprises & Discoveries, with no account
   identifiers:
   - the ID token's signing algorithm and claims;
   - the fields of a `/v1/models` item;
   - whether the route accepts a flat function tool, a namespace tool and an
     `additional_tools` item, and how a call names its tool;
   - image input, `reasoning.effort`, `prompt_cache_key`, `text.format`,
     `tool_choice` and `parallel_tool_calls`;
   - `context_management`, `web_search` and `apply_patch`;
   - `include: ["reasoning.encrypted_content"]` and replay of the returned
     reasoning item in a second request;
   - the error body for a rejected field and for a wrong route;
   - the refresh response's fields, and revocation.
3. Decide D8, D9, the compaction path, native `apply_patch` and reasoning
   replay from that evidence, and update Phases 5 to 7 where a finding
   changes them.

Checks: `uv run ruff check scripts/chatgpt_plan_probe.py`;
`python3 scripts/public-release/check_source.py`.

Completion: the findings are recorded, and no token is in the repository,
this plan or the shell history.

Recovery: `sign-out` revokes the session, the credential file can be deleted,
and the app can be disconnected in ChatGPT's settings.

Step 1 was built on 2026-11-24, starting from `4bb966a02`: the probe, and
`tests/test_chatgpt_plan_probe.py`, which runs it against a fake OpenAI. The
`requests` command has 20 named trials and sends at most 23 requests, inside
G1's bound.

To run the trial, from the worktree root, with a credentials path outside any
Git work tree:

```bash
uv run python scripts/chatgpt_plan_probe.py sign-in --credentials PATH
uv run python scripts/chatgpt_plan_probe.py models --credentials PATH
uv run python scripts/chatgpt_plan_probe.py requests --credentials PATH --model SLUG
uv run python scripts/chatgpt_plan_probe.py refresh --credentials PATH
uv run python scripts/chatgpt_plan_probe.py sign-out --credentials PATH --delete
```

Check record, from the worktree root, on working tree
`2eb7250394c5bd0e26232f27191b031fe7e6fce0`:

| Check | Result |
| --- | --- |
| `uv run pytest -q tests/test_chatgpt_plan_probe.py -p no:cacheprovider` | 35 passed |
| `uv run ruff check` | All checks passed |
| `uv run ruff format --check src/backend/animama tests` | 908 files already formatted |
| `uv run mypy tests/test_chatgpt_plan_probe.py scripts/chatgpt_plan_probe.py` | No issues in 2 files |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |
| `uv run python scripts/chatgpt_plan_probe.py requests --credentials /nonexistent/plan.json --list` | 20 trial names, exit 0 |
| Guard removal: 19 temporary mutations of the probe, restored byte-identical | Each made the test file fail |

Not run at that point: the full pre-push suite, and the live trial (G1).
Commits: `4bb966a02` (the plan) and `152db15a4` (the probe).

#### Code Review #1 Findings

Independent review, standard tier, of working tree
`432d9157b8bc4dbbea101326e53969eb16871363` against baseline `4bb966a02`. The
reviewer reused the recorded lint, format, source and guard-removal results
and reran mypy and the tests. Result: blocked by F1 to F3.

| ID | Kind | Finding |
| --- | --- | --- |
| P0-R1-F1 | Required | `requests` built its redactor before a possible token refresh, so a refreshed token echoed in provider text could print in clear. |
| P0-R1-F2 | Required | The SDK trial used the SDK's default HTTP client, which follows redirects, against T4. It also picked up organization and project headers from the shell. |
| P0-R1-F3 | Required | The `web_search` and `apply_patch` trials used a prompt that calls neither tool, so a pass showed only that the declaration was admitted. `context_management` had the same limit. |
| P0-R1-F4 | Optional | `plan_use_granted` could be wrong when the token response omits `scope`. |
| P0-R1-F5 | Optional | Items were read only from the terminal event, so items delivered only as stream events would look like "no tool call". |
| P0-R1-F6 | Optional | ID-token checks relied on an assumed key location and issuer, and ran after the code was spent, with nothing printed on failure. |
| P0-R1-F7 | Optional | The client id, the subject and raw model metadata could reach output described as safe to paste. |
| P0-R1-F8 | Optional | `sign-out` could fail with tokens still on disk without saying so, and treated two failure paths differently. |
| P0-R1-F9 | Optional | An idle connection could hold the listener past its timeout. |
| P0-R1-F10 | Optional | A busy port and a non-ASCII `state` produced tracebacks; one lost connection aborted the whole `requests` run. |
| P0-R1-F11 | Optional | `refresh` did not show whether it ran before the saved `earliest_refresh_at`. |
| P0-R1-F12 | Optional | No test covered the free-text guard, the algorithm allow-list, a token signed by another key or an interrupted write; the listener test honoured proxy variables. |

#### Code Review #1 Revisions

Every finding was verified against the code and accepted. Each fix has a test
that fails without it.

| ID | Fix |
| --- | --- |
| P0-R1-F1 | The redactor reads the record at every call and remembers earlier values. |
| P0-R1-F2 | The SDK trial passes an HTTP client with redirects off, omits the organization and project headers, and skips itself when `OPENAI_CUSTOM_HEADERS` is set. |
| P0-R1-F3 | `web_search` asks for a search and says how to read the result. `apply_patch` asks for a file and replays the call with its output. `context_management` is labelled admission only. |
| P0-R1-F4 | Scopes come from the token response, else the access token's claim, else "not reported"; a stale saved list is removed. |
| P0-R1-F5 | Items are also collected from `response.output_item.done`, and the event types and the item source are printed. |
| P0-R1-F6 | Discovery is read before the browser opens. The issuer and key location come from it and must be on OpenAI's sign-in host. A failed check revokes the new session and prints the ID token's shape. |
| P0-R1-F7 | The subject and client id are redacted, the client id prefix is not echoed without an underscore, and the docstring says to read model metadata before pasting it. |
| P0-R1-F8 | Tokens are removed only once OpenAI confirms or there is nothing to revoke. The command exits 1 and says whether tokens were kept or the file was deleted. |
| P0-R1-F9 | The listener's handler has a five-second socket timeout. |
| P0-R1-F10 | A busy port is a plain error, `state` and nonce are compared as bytes, and a lost connection no longer stops the run. |
| P0-R1-F11 | `refresh` prints when it ran and the previous `earliest_refresh_at`. |
| P0-R1-F12 | Tests added for each gap, and the listener test ignores proxy variables. |

Verified by the check record of that round on working tree
`b2158425e9941bab3af3f71133b9c218c16f3792` (34 tests, 16 guard removals).
Remaining repair budget: one round.

#### Code Review #2 Findings

Targeted recheck of working tree `b2158425e9941bab3af3f71133b9c218c16f3792`,
reusing the round's check record. The reviewer also drove every command end
to end against the test fake. Result: pass. F1 to F12 are resolved, with no
blocking regression. Two notes on the repairs, neither blocking:

| ID | Kind | Finding |
| --- | --- | --- |
| P0-R2-F1 | Optional | When a round trip's follow-up lost its connection, the first result was dropped and the request count was one short. A skipped SDK trial was counted as sent. |
| P0-R2-F2 | Optional | A refused tool request carried the note "the model made no tool call". |

#### Code Review #2 Revisions

Both accepted. A lost connection now becomes that request's own result, so
earlier results stay and the count is exact; a skipped trial is not counted;
the note is set only when the request completed. Each has a test that fails
without it. These are small repairs below the high-risk tier, verified by the
implementing agent with the check record above and not rechecked by the
reviewer. Remaining repair budget: one round, unused.

#### Trial record

Steps 2 and 3 ran on 2026-11-24, starting from `152db15a4`. The account holder
signed in in their own browser; the agent ran the commands and saw only the
probe's redacted output. In order: `sign-in`, `models`, `requests --model
gpt-6-luna` (22 requests), `requests --only reasoning_replay` (2 requests),
`refresh` and `sign-out --delete`, which OpenAI confirmed. The saved outputs
hold no JWT-shaped text, no command took a token as an argument, and the
credentials file and its directory are gone. One request of G1's 25 was left
unspent.

The first run's reasoning trial returned no reasoning item, so the probe
changed before the two-request rerun: that trial now asks for `high` effort on
a prompt with a sum to work out, and says when nothing was replayed. It still
returned none. The rerun, the refresh and the sign-out ran with that change
applied and not yet committed. Two more changes followed what the trial
showed: the `models` command prints a length in place of any text over 200
characters, since each item carries tens of thousands of characters of another
product's prompts, and the test fake gives `earliest_refresh_at` as Unix
seconds. Three tests cover the changes, and each failed before its change.

Findings are under "Live trial" in Surprises & Discoveries, and the choices
of step 3 are in the Decision Log. Phases 1, 5, 6 and 7 were updated where a
finding changed a step.

Check record, from the worktree root, on working tree
`a40da151310fe7e2206c50ae8d018f9d6fd7229a` (hashed while this line still
held a placeholder for the tree name):

| Check | Result |
| --- | --- |
| `uv run pytest -q tests/test_chatgpt_plan_probe.py -p no:cacheprovider` | 37 passed |
| `uv run ruff check` | All checks passed |
| `uv run ruff format --check src/backend/animama tests scripts/chatgpt_plan_probe.py` | 909 files already formatted |
| `uv run mypy tests/test_chatgpt_plan_probe.py scripts/chatgpt_plan_probe.py` | No issues in 2 files |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |

Not run: the full pre-push suite (G3).

#### Code Review #3 Findings

Targeted review, the last in this phase's budget, of the working tree above
against baseline `152db15a4`: the trial findings against the probe's raw
output, the decisions, the edits to later phases, the probe changes made
after the trial, and the two round-2 repairs no reviewer had rechecked. The
reviewer reused the check record and ran the tests on scratch copies with
guards removed. Result: blocked by F1 to F3, all plan wording. The probe and
test changes passed, the round-2 repairs hold, and the public record holds
no secret, identifier or personal data.

| ID | Kind | Finding |
| --- | --- | --- |
| P0-R3-F1 | Required | Phase 5 step 7 exempted a 401 of type `rejected_by_access_enforcement` from the refresh and retry. The trial saw that type only on refused routes and never sent an expired or revoked token, so the exemption could hide a required sign-in. |
| P0-R3-F2 | Required | D8 keys hosted search on `supports_search_tool`, but "Synced rows" left that field out and said nothing else is stored. |
| P0-R3-F3 | Required | The reasoning-replay confirmation could not run as written. It called an image with a tool the shape that returned a reasoning item, but the image request declared no tool, and the product cannot send an image at Phase 5. Nothing said what ships if the check confirms nothing, or whether the fallback is a retry or a setting. |
| P0-R3-F4 | Optional | No test asserted that the "none was replayed" note is absent when reasoning was replayed. |
| P0-R3-F5 | Optional | The probe's docstring still said `models` prints metadata as returned. |
| P0-R3-F6 | Optional | The Agents SDK replays output items with their ids, and reasoning items, which Phase 0 did not try. Phase 7 step 2 did not say so. |
| P0-R3-F7 | Optional | Precision: the size of the list's prompts; "empty" where the probe cannot tell empty from absent; which source the later commands ran from; that no `subscription_sharing_*` code was observed; T5 against the forced refresh. |
| P0-R3-F8 | Optional | The test fake's refresh time was the literal value from the live response. |

#### Code Review #3 Revisions

All eight accepted.

| ID | Change |
| --- | --- |
| P0-R3-F1 | The exemption is removed. Step 7 keeps one refresh and one retry for every 401, and the findings say what the trial did not observe. |
| P0-R3-F2 | "Synced rows" takes `supports_search_tool` as the row's hosted-search support. D8 notes that every listed item had it true. |
| P0-R3-F3 | Reasoning replay sits behind a route-profile switch that ships off, which leaves today's replay of calls and outputs. Phase 5's manual check runs the probe's `reasoning_replay` trial on each listed model, and the switch turns on only if the route accepts a replayed item. Step 6 says which items carry ids. |
| P0-R3-F4 | The trials test asserts the note is empty when reasoning was replayed. Dropping the condition now fails it. |
| P0-R3-F5 | The docstring describes the shortened output. |
| P0-R3-F6 | Phase 7 step 2 names the difference and points its capture test and manual check at it. |
| P0-R3-F7 | Each point is reworded in "Live trial", the trial record and Phase 1. |
| P0-R3-F8 | The fake uses a made-up time. |

F1 to F3 and F5 to F7 are wording, and F4 and F8 are one line each in the test
file. The budget holds no further review, so the implementing agent verified
them, as the review policy allows below the high-risk tier, and no reviewer
has rechecked them. After the repairs, on working tree
`ca21f873704c52e73bfbcbaa4591fb9cb9658eb6` (hashed while this line still held
a placeholder): the probe's tests, 37 passed; `uv run ruff check`, passed; the
format check, 909 files already formatted; mypy on the two files, no issues;
`check_source.py`, every tracked file covered once. With the note's condition
dropped in a scratch copy of the probe, the trials test fails. The trial
record and these repairs are the commit that carries this section.

### Phase 1: Sign-in core

Review tier: high risk (authentication, secrets at rest, concurrency, a
dependency declaration).

Requirements: R1.2, R1.4, R1.5 (sign-out), R1.6, R2.1 (self-host), R2.2,
R2.3. Threats T2 to T6.

Steps, tests first in `tests/test_chatgpt_plan_identity.py`,
`tests/test_chatgpt_plan_store.py` and `tests/test_chatgpt_plan_session.py`:

1. `pyproject.toml`: declare `pyjwt[crypto]>=2.15.1,<3` and run `uv lock`.
   The lock should change only its metadata.
2. `domain/chatgpt_plan.py`: the account, the session record and its states,
   with secret fields marked `repr=False`.
3. `adapters/chatgpt_plan/openai_identity.py`: an `httpx` client with an
   injectable transport, fixed OpenAI origins (T4) and no redirects. It
   builds the authorize URL (PKCE, `state`, `nonce`, hints for a returning
   account, `prompt=consent` when the person enables plan use later),
   exchanges a code, refreshes, revokes, and validates an ID token against a
   cached JWKS that is fetched again for an unknown key id.
4. `adapters/chatgpt_plan/session_store.py`: the record at
   `<data root>/internal/chatgpt-plan/`, written with the `persist` pattern
   (directory 0700, file 0600, no symlinks). With a key it writes
   AES-256-GCM ciphertext (`session.bin`); without one, JSON
   (`session.json`). The record holds a schema version, the host id
   (`urn:uuid:` version 4, created once and kept), and per account the issued
   client id, email, scopes, tokens, expiry, `earliest_refresh_at`, the
   retained ID token, the confirmation time and the background choice.
5. `app/services/chatgpt_plan_session.py`: status; `begin` (one pending
   attempt, ten minutes); `complete` (T2); `cancel`; `access_token(purpose)`
   with a single-flight refresh that writes before use (T5) and refreshes
   inside the last five minutes; the usage-limit pause; `sign_out`, which
   revokes, clears tokens and reports whether OpenAI confirmed. One account
   is active, and a new one replaces it only after validation (R1.6). A
   malformed or undecryptable record means signed out.
6. `scripts/backup-local.sh` and `scripts/restore-local.sh`: add
   `./internal/chatgpt-plan` to both exclude lists, so a backup never holds
   the session and a restore never extracts one. A restore replaces the data
   tree, so it leaves the installation signed out; Phase 8 documents that.

From the Phase 0 trial: `earliest_refresh_at` arrives as Unix seconds. A
refreshed ID token has no `nonce`, so the nonce is checked at sign-in only.
The ID token also carries the person's name, which the status does not
report. A refresh sent before `earliest_refresh_at` was accepted, so the
forced refresh after a 401 (Phase 5 step 7) may run early; scheduled
refreshes still wait for that time (T5).

Checks: the three test files; `uv run ruff check`; `uv lock --check`;
`bash -n scripts/backup-local.sh scripts/restore-local.sh`. Not run in this
phase: the full pre-push suite.

Completion: against a fake OpenAI, a sign-in completes, survives a restart,
refreshes once under concurrent use and signs out, and every negative test in
T2 to T6 that needs no HTTP route passes.

Recovery: the record is one directory. Removing it signs the installation
out at the next start (a running server keeps the record it read), and
nothing else refers to it.

As built (2026-11-24, from `55e4a8c94`): `domain/chatgpt_plan.py` (record,
status, purposes and error codes); `app/ports/chatgpt_plan_port.py` (the
identity and store ports); `adapters/chatgpt_plan/openai_identity.py` and
`session_store.py`; `app/services/chatgpt_plan_session.py`; and
`tests/chatgpt_plan_fakes.py`, a fake of OpenAI's sign-in service that signs
real ES256 ID tokens and plays the browser. Choices made while building:

- The authorize URL sends `login_hint` for a returning account and no ID token
  hint: the trial never tried an expired one, and a refusal would block
  sign-in.
- Only OpenAI's own OAuth refusal removes the tokens: a 400, 401 or 403 whose
  JSON `error` is `invalid_grant`, `invalid_client` or `unauthorized_client`.
  Anything else, including a proxy or bot-check page, keeps them (R2.3). On a
  refresh the last two also drop the stored client id, so the next sign-in
  registers again. A client id refused at authorization or at code exchange
  is not dropped; G1 checks how OpenAI answers then.
- After OpenAI could not be reached for a refresh, no other refresh is tried
  for 30 seconds; inside the five-minute margin the still-valid token is used
  meanwhile. A failed save never hands out a token.
- Sign-out always removes the tokens and reports whether OpenAI confirmed the
  revocation; an account whose tokens were already rejected has nothing to
  revoke.
- A sign-in by another account revokes the replaced session's refresh token
  after the new record is saved. The same account's earlier grant is left to
  expire, since revoking it might also end the new one; G1 can check that.
- If saving a refreshed token set fails, its access token is not used and the
  caller gets `temporarily_unavailable`; OpenAI has already rotated the
  refresh token, so the next refresh asks for sign-in.
- The usage-limit pause is kept in memory; a restart counts as a new try.
- The identity client honours proxy settings, as the OpenAI SDK does; the
  hosts stay fixed.
- A storage error while reading or writing the session surfaces as
  `temporarily_unavailable` and changes nothing; only a link, a non-file or
  bytes that do not decode are discarded.
- `cryptography` is declared beside `pyjwt[crypto]`, since the session store
  imports it; the lock changed only its metadata. The `encrypt` extra stays so
  existing commands resolve.
- A restore also skips `./internal/chatgpt-plan` when it extracts, in
  `scripts/local-stack-state-common.sh`, so an older archive cannot bring
  tokens back.

Check record, from the worktree root, on working tree
`5d86e7d02243300cef41b924f62b4e097efd4390` (hashed while this line still held
a placeholder):

| Check | Result |
| --- | --- |
| `uv run pytest -q tests/test_chatgpt_plan_store.py tests/test_chatgpt_plan_identity.py tests/test_chatgpt_plan_session.py tests/test_local_state_scripts.py -p no:cacheprovider` | 78 passed |
| `uv run ruff check` | All checks passed |
| `uv run ruff format --check src/backend/animama tests` | 918 files already formatted |
| `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests` | No issues in 918 files |
| `uv lock --check` | Resolved, unchanged |
| `bash -n scripts/backup-local.sh scripts/restore-local.sh scripts/local-stack-state-common.sh` | OK |
| `uv run --no-sync python scripts/repository-boundary/check-python-imports.py` | 0 forbidden edges |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |
| Extraction with `--exclude='./internal/chatgpt-plan'`, macOS bsdtar and Alpine GNU tar | The session directory is skipped |

Not run: the full pre-push suite (G3).

#### Code Review #1 Findings

Independent review, high-risk tier, of working tree
`7ff9a78a30f6a2794807ffd6e3c1ae758636c8a1` against `55e4a8c94`. The
reviewer reran the record's checks and ran guard-removal experiments on a
scratch copy. Result: blocked by F1 to F5. Layering, reuse of the file
helpers, AES-GCM use, `repr` hygiene, host pinning, state handling and the
backup and restore exclusions were found correct.

| ID | Kind | Finding |
| --- | --- | --- |
| P1-R1-F1 | Required | The first read of the record could finish after a refresh had saved new tokens and overwrite them in memory, losing the rotated refresh token; on a fresh install it could change the host id between the authorize URL and the file. |
| P1-R1-F2 | Required | Any error opening the file (too many open files, permission, I/O) deleted a valid session. |
| P1-R1-F3 | Required | Rejection was decided by status code alone, so a proxy or bot-check 403, or a 404 during a deploy, ended a valid session. |
| P1-R1-F4 | Required | A failed refresh was not shared: every waiting caller refreshed again, discarding a still-valid token and retrying a 429 at once. |
| P1-R1-F5 | Required | No test covered write-before-use: setting the record before saving passed every test. |
| P1-R1-F6 | Optional | `sign_in_pending` read false while a return was being completed. |
| P1-R1-F7 | Optional | A same-account sign-in revoked the earlier grant, which might also end the new one. |
| P1-R1-F8 | Optional | Nothing recovered from a client id OpenAI no longer accepts. |
| P1-R1-F9 | Optional | A crash during a write could leave a temporary file with plaintext tokens that was never swept. |
| P1-R1-F10 | Optional | Raw `OSError` escaped several service methods. |
| P1-R1-F11 | Optional | Untested guards: an existing directory's mode, registration without a client id, revocation when the sign-in save fails, sign-out ending a pending attempt, a refreshed ID token for another subject, 408 as temporary. |
| P1-R1-F12 | Optional | Proxy settings were ignored by the identity client. |
| P1-R1-F13 | Optional | An unexpected purpose was treated as interactive. |
| P1-R1-F14 | Optional | Recovery wording, and packaging of `jwt` and `cryptography` (G2). |

#### Code Review #1 Revisions

All accepted except F14's packaging note, which G2 covers as planned.

| ID | Change |
| --- | --- |
| P1-R1-F1 | The first read assigns the record only if none was set while it waited. |
| P1-R1-F2 | Only a link (`ELOOP`) is discarded at open; other errors propagate, the service reports `temporarily_unavailable`, and the next call reads again. |
| P1-R1-F3 | Rejection needs a 400, 401 or 403 with an OAuth `error` of `invalid_grant`, `invalid_client` or `unauthorized_client`. |
| P1-R1-F4 | A temporary failure sets a 30-second backoff checked before any refresh; a caller whose token is still valid gets it. |
| P1-R1-F5 | A test shows the unsaved set is never handed out: the next call is refused with `sign_in_required`. |
| P1-R1-F6 | The attempt is cleared in `finally`, so status stays pending until completion ends. |
| P1-R1-F7 | Only another account's grant is revoked. |
| P1-R1-F8 | `invalid_client` and `unauthorized_client` drop the stored client id. Narrowed in round 2. |
| P1-R1-F9 | Every write sweeps `.session.*.tmp` files. Narrowed in round 2. |
| P1-R1-F10 | Storage errors become `temporarily_unavailable`. |
| P1-R1-F11 | Tests added for each. |
| P1-R1-F12 | Proxy settings are honoured unless a test transport is injected. |
| P1-R1-F13 | Any purpose other than `interactive` follows the background rule. |
| P1-R1-F14 | The Recovery line says a running server keeps its record until restart. |

Each new guard was removed in turn and a test failed, except a backoff check
in the refresh-due test, which duplicated the one in the refresh itself and
was removed. After the repairs: the four test files, 98 passed; `uv run ruff
check`, passed; the format check, 918 files already formatted; mypy on the
ten Phase 1 modules and tests, no issues.

#### Code Review #2 Findings

Targeted recheck of working tree `29fa8bedc4c309c442c31571cddeef3faea7464a`.
F1 to F7 and F10 to F14 were resolved; two repairs regressed. Result:
blocked.

| ID | Kind | Finding |
| --- | --- | --- |
| P1-R2-F1 | Required | The sweep on read could remove the temporary file of a save running at the same time, so the save failed after OpenAI had rotated the refresh token. |
| P1-R2-F2 | Required | Dropping the client id when a code exchange refused it left a signed-in account that could neither refresh nor be revoked. No test covered that path. |
| P1-R2-F3 | Optional | The stale-token fallback could hand out a rejected session's token when saving its removal also failed. |
| P1-R2-F4 | Optional | One assertion in the unsaved-token test could never fail. |
| P1-R2-F5 | Optional | A client id refused at authorization or in the return is still kept: a G1 check. |

#### Code Review #2 Revisions

All accepted.

| ID | Change |
| --- | --- |
| P1-R2-F1 | Only a save sweeps; the store test now expects a read to leave a leftover and the next save to remove it. |
| P1-R2-F2 | The exchange path no longer drops the client id; only a refused refresh does, together with the tokens. |
| P1-R2-F3 | The fallback applies only while the backoff set by an unreachable OpenAI is running, with a test. |
| P1-R2-F4 | The assertion reads the session file's bytes. |
| P1-R2-F5 | Recorded in the As-built notes as a G1 check. |

Removing each round-2 guard fails a test. After the repairs: the four test
files, 99 passed; `uv run ruff check`, passed; the format check, 918 files
already formatted; mypy on the ten modules and tests, no issues.

#### Code Review #3 Findings

Final targeted recheck of working tree
`314b2cdb72791a1c4acd4d7ef8c0dc4fcb1678fd`. The reviewer reran the tests,
lint, mypy and the import-boundary check, replayed its race and failure
experiments, and removed each round-2 guard. Result: pass, with no finding.
The phase's review budget is spent.

### Phase 2: Routes and the sign-in return

Review tier: high risk (the admission boundary, the API contract, the
generated client).

Requirements: R1.1 (API), R1.4, R1.5, R1.7. Threats T1 to T3 and T8.

Steps, tests first in `tests/test_local_http_admission.py`,
`tests/test_chatgpt_plan_api.py`, `tests/test_product_http_inventory.py`,
`tests/test_runtime_capabilities.py` and
`src/frontend/web/tests/local-api-proxy.test.ts`:

1. `local/http/config.py`: `LocalHTTPConfig` gains the sign-in return path
   and derives its authority, `127.0.0.1:<port>`, only when the public origin
   is `http` on `localhost` or `127.0.0.1` (D14). `server/local_http.py` sets
   the path.
2. `local/http/admission.py`: admit the return as T1 describes, tested before
   the `Host` rule and only for the exact path. A request that misses a
   condition falls through to the existing checks. `lifecycle.admit` still
   applies.
3. `local/http/assets.py`: add `/auth` to `_NO_FALLBACK_PREFIXES`, so no
   `/auth/*` path returns the app shell.
4. `server/routers/chatgpt_plan.py`, included in `create_local_app` after the
   model configuration router. Every `/v1` route depends on
   `get_current_principal`:
   - `GET /v1/chatgpt-plan`: state, whether sign-in is available and why not,
     the account's email, whether plan use is enabled, whether the
     confirmation is due, the background choice and the pause.
   - `POST /v1/chatgpt-plan/sign-in`: starts an attempt and returns the
     authorize URL; refused with a code when sign-in is unavailable.
   - `DELETE /v1/chatgpt-plan/sign-in`: cancels the attempt.
   - `POST /v1/chatgpt-plan:sign-out`.
   - `PUT /v1/chatgpt-plan/preferences`: records the confirmation and the
     background choice.
   - `GET /auth/callback`, outside the schema: completes the attempt and
     answers with the static page (D10, T3).
5. Keep the return out of OpenTelemetry instrumentation, and add a test that
   the server writes no log line containing the return's query.
6. `product_http/inventory.py`: `_excluded("chatgpt_plan", …)` rows for the
   `/v1` routes and a `_local` row for the return, in mount order. Add the
   `chatgpt_plan` capability (false by default, true locally, `false` in
   `hosted.json` and in the test's permission list), and refuse it in
   `hosted-composition.ts` with a test.
7. `local-api-proxy.ts`: forward `/auth/callback` and fence other `/auth/*`
   paths. Confirm Vite accepts `Host: 127.0.0.1:<port>`.
8. Raise `local-http` to the next major in `contracts/versions.json`, run
   `pnpm openapi-ts`, raise the runtime-contracts version and run
   `pnpm packages:build`.
9. Correct the two sentences this phase makes wrong: "Adding A Route" in
   `docs/backend/operations/development.md` and the proxied paths in
   `docs/frontend/architecture/auth-server.md`.

Checks: the test files; `uv run ruff check`; from `src/frontend`
`pnpm openapi-ts:check`, `pnpm check` and the proxy test; the package-set
`compare` against a `main` baseline. Start a task stack with
`./reset.sh --name chatgpt-plan --base-port <free port>` and send the T1
request variants to it with `curl`, in development and built mode.

Completion: a return with a valid `state` completes a sign-in against the
fake OpenAI in development, built and desktop configurations; every T1 and T2
variant is refused; the inventory and contract checks pass.

Recovery: the exemption is one branch in admission and one config field.
Removing the path from the config closes it.

As built (2026-11-24, from `024ebd0c2`): `server/routers/chatgpt_plan.py`
with the five `/v1` routes and the return; `server/chatgpt_plan.py`, which
decides availability and creates the session service on first use;
`server/chatgpt_plan_return_page.py`, the fixed page in five languages; and
`server/schemas/chatgpt_plan.py`. Choices made while building:

- The return authority is derived for `localhost`, `127.0.0.1` and any
  `*.localhost` name, all loopback (RFC 6761), so a named worktree stack
  (`http://animama-<name>.localhost:<port>`) can sign in too; `https`,
  `[::1]` and other hosts get no return. On port 80 the authority is the bare
  `127.0.0.1`, as browsers send it.
- A desktop composition without the vault key (Phase 3) reports
  `secure_storage_unavailable` and its service reads and writes no session
  file at all.
- Every route words an unavailable session as a code: 503
  `chatgpt_plan_temporarily_unavailable` while storage or OpenAI is down,
  otherwise 409 `chatgpt_plan_<code>`.
- Accepted exception to T3, development only: if FastAPI is down or
  restarting when the return arrives, Vite's proxy logs the request URL with
  its query. The code is useless without the PKCE verifier, which never
  leaves the backend's memory, and the attempt's state grants nothing alone.
- The return page uses the language sent with the latest sign-in start.
  Outcomes: signed in (200), declined, expired (also a return with no pending
  attempt) and failed (400). A repeated query field fails.
- A return whose `iss` names another issuer is refused before any exchange
  (RFC 9207).
- The capability is `chatgpt_plan`, a permission; `contracts/hosted-web.md`
  lists it. `local-http` is 24.0.0 and `runtime-contracts` 0.24.0.
- Tracing excludes `auth/callback` and keeps the operator's own exclusions.
- The stack check found uvicorn access lines, query included, in both
  development and built logs. `configure_logging` re-enabled the
  `uvicorn.access` logger that the launcher's `access_log=False` had turned
  off. It now has no handler and does not propagate; a test pins it. This was
  also the cause of the earlier packaged-build observation.

Check record, from the worktree root, on working tree
`42cce7af29e3d9ef8cf0b9f1f7efd9acb852103d` (hashed while this line still held
a placeholder):

| Check | Result |
| --- | --- |
| `uv run pytest -q` on the four Phase 1 test files, `test_chatgpt_plan_api.py`, `test_local_http_admission.py`, `test_product_http_inventory.py`, `test_runtime_capabilities.py`, `test_local_http_composition.py`, `test_local_http_wiring.py`, `test_local_app_composition.py`, `test_local_http_transport.py`, `test_desktop_credentials_route.py`, `test_local_http_telemetry.py` and `test_local_state_scripts.py` | 434 passed |
| `uv run ruff check`; `uv run ruff format --check src/backend/animama tests` | Passed; 923 files already formatted |
| `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests` | No issues in 923 files |
| `check-python-imports.py`; `check_source.py` | 0 forbidden edges; every tracked file covered once |
| From `src/frontend`: `pnpm openapi-ts:check` | Generated SDK is current |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm check` | No issues; every catalog complete |
| From `src/frontend`: `pnpm packages:build`, then vitest on `tests/local-api-proxy.test.ts` and `src/app/hosted-runtime/hosted-composition.test.ts` | 109 passed |
| Task stack, development then built mode: the return's variants with `curl` | Valid shape reaches the route (400 for a wrong `state`, attempt kept); Origin, page Host, other port, foreign host, image fetch, POST, body, `/auth/other`, `/auth/callback/x` and cross-site `/v1` refused (403, 404 or 421); return page headers as designed; no query in container or file logs after the logging fix |

Not run: the package-set `compare`, deferred to the final candidate so one
comparison covers this phase's `runtime-contracts` bump and Phase 6's
`product-ui` one; the full pre-push suite (G3).

#### Code Review #1 Findings

Independent review, high-risk tier, of working tree
`41a9ecdee4bb5da28619c55644025e3cea0307bf` against `024ebd0c2`; the
reviewer reran 691 tests across the affected files, lint, the boundary and
licence checks, the frontend checks, and removed guards one at a time on a
scratch copy. Result: blocked by F1 and F2, both test gaps. The exemption
was found exactly as narrow as T1, and the return page, logging fix,
inventory and hosted refusal sound.

| ID | Kind | Finding |
| --- | --- | --- |
| P2-R1-F1 | Required | The T1 tests did not pin the path, method, `Transfer-Encoding`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest` guards: removing any one still passed, because the tests accepted the router's 404 or 405 or changed two headers at once. A WebSocket and desktop `/v1` without the cookie at the return authority were untested. |
| P2-R1-F2 | Required | The real wiring was untested: the return path in `local_http.py`, the keyless desktop store, the `/auth` asset fence and the schemas' fixed fields. |
| P2-R1-F3 | Optional | On port 80 the authority read `127.0.0.1:80`, which no browser sends. |
| P2-R1-F4 | Optional | Vite's proxy error log prints the request URL if FastAPI is down when the return arrives. |
| P2-R1-F5 | Optional | A session storage failure was a bare 500 on every route but preferences. |
| P2-R1-F6 | Optional | Wording: the hosted contract said the capability withholds the return; a stale logging comment; the tracing exclusion's wiring untested. |

#### Code Review #1 Revisions

All accepted; F4 as a recorded exception.

| ID | Change |
| --- | --- |
| P2-R1-F1 | The tests assert the exact refusal (421 self-hosted; 401 or 403 desktop) for other paths, methods and each fetch-metadata header alone, plus a chunked body, a WebSocket and desktop `/v1` without the cookie. The separate WebSocket check was removed: a WebSocket scope has no method, so the `GET` check excludes it. |
| P2-R1-F2 | Tests on `create_local_app` for a loopback self-hosted origin and a keyless desktop that ignores a planted plain session file, a built-asset test for `/auth` paths, and 422 tests for extra fields. |
| P2-R1-F3 | Port 80 gives `127.0.0.1`. |
| P2-R1-F4 | Recorded in the As-built notes as an accepted development-only exception. |
| P2-R1-F5 | All routes map the error: 503 while temporary, 409 otherwise. |
| P2-R1-F6 | Wording fixed; a test checks the instrumentor receives the exclusions. |

Each of the nineteen guards and wirings above was removed in turn and a test
failed. After the repairs, on working tree
`74454a5046409c2e70fac83c48e405e2d91d4dca`: the affected backend tests, 653
passed (the API file alone 81); lint and format passed; full mypy, no issues
in 923 files.

#### Code Review #2 Findings

Targeted recheck of working tree `74454a5046409c2e70fac83c48e405e2d91d4dca`.
The reviewer reran 718 tests across the affected files, lint, mypy on the
changed files, the boundary, licence and generated-client checks, and swept
20 guard removals. Result: pass. F1 to F6 are resolved.

| ID | Kind | Finding |
| --- | --- | --- |
| P2-R2-F1 | Optional | The WebSocket test sent `Sec-Fetch-Mode: websocket`, so the mode check refused it and the method check was not isolated. |
| P2-R2-F2 | Optional | The round-1 check line named no Git tree. |

#### Code Review #2 Revisions

Both accepted and verified by the implementing agent, as the policy allows for
a one-line test change: the WebSocket test's scope carries no fetch metadata,
and weakening the method check to `scope.get("method", "GET")` now fails both
of its cases; the check line names its tree. No further review was needed.

### Phase 3: Desktop custody

Review tier: high risk (secrets, Electron main, the packaged runtime).

Requirements: R2.1 (desktop). Threats T3 and T6. Follows D2.

Steps, tests first in `src/frontend/desktop/tests/runtime-state.test.ts`,
`src/frontend/desktop/tests/runtime-supervisor.test.ts`,
`tests/test_chatgpt_plan_store.py` and `tests/test_local_app_composition.py`:

1. `vault.ts`: an optional generated store key (32 random bytes), created on
   first need and saved with the vault's existing atomic encrypted write. It
   is part of `secrets()` for log redaction and never part of `list()` or
   `childEnvironment()`.
2. `supervisor.ts` `backendEnvironment()`: pass the key to the FastAPI child
   only, as `ANIMAMA_CHATGPT_PLAN_STORE_KEY`.
3. `server/config.py`: read and validate the key with `repr=False`, remove it
   from the process environment in the desktop composition, and give it to
   the session store. A desktop composition without the key reports sign-in
   as unavailable; it never falls back to an unencrypted file.

Checks: `pnpm desktop:test` from `src/frontend`; the backend test files;
`uv run ruff check`.

Completion: on desktop the session file is ciphertext, the key appears in no
log, child environment or status, and a profile without the vault is signed
out.

Recovery: deleting the session file signs out. Losing the vault makes the
file unreadable, which also means signed out.

As built (2026-11-24, from `70158c225`): `CredentialVault` gains an optional
`chatgptPlanStoreKey` (32 bytes, hex) created by `chatgptPlanStoreKey()` on
first use and saved with the vault's encrypted write; a malformed stored key
makes the vault unreadable. It is part of `secrets()` and never of `list()`
or `childEnvironment()`. The supervisor reads it after opening the vault and
passes it as `ANIMAMA_CHATGPT_PLAN_STORE_KEY` to the FastAPI child only; if
the vault cannot create it, main logs the error code and the backend reports
sign-in unavailable. In the backend, `_ProcessStoreKey` in
`server/chatgpt_plan.py` takes the key out of the process environment the
first time an app is built and keeps it for every later app in the process,
because the desktop `serve` command builds its app after importing the module
that builds another. The key is not a `Settings` field, so no settings
printout can carry it. Only 64 lower-case hex characters are accepted; a
malformed value is logged without its value and ignored. The tests sit beside
Phase 2's in `tests/test_chatgpt_plan_api.py`, including one that runs the
`serve` command in a fresh interpreter, and in the desktop's
`runtime-state.test.ts` and `runtime-supervisor.test.ts`.

Check record, from the worktree root, on working tree
`54c1a6eef48e51aa25569e4c46e4fbb58c07ab77` (hashed while this line still held
a placeholder):

| Check | Result |
| --- | --- |
| `uv run pytest -q` on `test_chatgpt_plan_api.py`, `test_chatgpt_plan_session.py`, `test_chatgpt_plan_store.py`, `test_local_app_composition.py`, `test_desktop_credentials_route.py`, `test_desktop_runtime_packaging.py`, `test_local_http_composition.py`, `test_local_http_wiring.py` and `test_runtime_capabilities.py` | 298 passed |
| `uv run ruff check`; format check; full mypy (heavy slot); import boundary | Passed; 923 formatted; no issues in 923 files; 0 forbidden edges |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm desktop:test` | 668 passed, 14 skipped |
| From `src/frontend`: `pnpm --filter animama-desktop check` | No type errors |
| Desktop prettier check on the four changed files | Formatted |
| Removing the key's delivery to the FastAPI child, or the stored key's validation | The supervisor and vault tests fail |

Not run: the full pre-push suite (G3); a packaged build, which is G2.

#### Code Review #1 Findings

Independent review, high-risk tier, against `70158c225`. The reviewer reran
the recorded backend tests, the two desktop test files, lint, mypy and `tsc`
on the changed files, and reproduced the desktop `serve` path in a fresh
interpreter. Result: blocked by F1 and F2. The key was found never to reach
the page, status, provider environments or other children, and the vault
format to stay compatible in both directions.

| ID | Kind | Finding |
| --- | --- | --- |
| P3-R1-F1 | Required | The desktop backend never got the key: `animama-runtime serve` imports the module that builds the default app, which removed the key from the environment, and then builds the app it serves from a fresh `Settings()` without it. Every packaged desktop would report sign-in unavailable. In-process tests could not see it. |
| P3-R1-F2 | Required | No test covered a failed key creation: removing the supervisor's catch would stop the whole runtime on a Keychain or DPAPI write failure. |
| P3-R1-F3 | Optional | Concurrent first use of the key was untested. |
| P3-R1-F4 | Optional | Main logged nothing when key creation failed. |
| P3-R1-F5 | Optional | The malformed-key log said sign-in was unavailable, which is untrue on a self-hosted installation. |

#### Code Review #1 Revisions

All accepted.

| ID | Change |
| --- | --- |
| P3-R1-F1 | The backend takes the key once per process into `_ProcessStoreKey` and gives it to every app the process builds; the `Settings` field is gone. A test runs `serve` in a fresh interpreter with the launcher stubbed and checks the served app has the key and the environment does not. |
| P3-R1-F2 | A supervisor test opens an older vault without a key while encryption fails: the runtime is ready, the FastAPI child gets no key and the vault is unchanged; a later start delivers the key. Removing the catch fails it. |
| P3-R1-F3 | The vault test asks for the key twice at once and gets one. |
| P3-R1-F4 | Main logs `chatgpt_plan_store_key_unavailable` with the error code. |
| P3-R1-F5 | The log says the key is ignored. |

After the repairs, on working tree
`0631065137ab2e84d41c592a1b55ae5d0abc48d9`: the backend tests above plus
`test_runtime_entry_policy.py`, all passed (299 in the recorded set); lint,
format and full mypy passed; the import boundary held; `pnpm desktop:test`,
669 passed and 14 skipped; `tsc` and prettier on the desktop files passed.

#### Code Review #2 Findings

Targeted recheck of working tree `0631065137ab2e84d41c592a1b55ae5d0abc48d9`.
The reviewer reran 300 backend tests, the two desktop test files, `tsc`,
lint and mypy on the changed files, and its fresh-interpreter reproduction,
which now shows the served app holding the key and the environment clear.
Result: pass.

| ID | Kind | Finding |
| --- | --- | --- |
| P3-R2-F1 | Optional | A malformed key is logged once per app built, so twice on desktop. |
| P3-R2-F2 | Optional | The round-1 check line named no tree. |

#### Code Review #2 Revisions

F2 accepted: the check line above names its tree. F1 not changed: the
duplicate line carries no value and costs nothing, while logging once would
add state for a case only a broken launcher produces.

### Phase 4: Settings and setup

Review tier: standard.

Requirements: R1.1, R1.3, R1.4, R1.5, R1.6, R1.7 and the question in R4.1.

Steps, tests first in Vitest specs beside the sources:

1. Query hooks and mutations for the Phase 2 routes, beside the model
   configuration ones. The status query polls each second while an attempt
   is pending.
2. `model-configuration-state.ts`: a "ChatGPT plan" entry in the Cloud tab
   beside OpenAI, with "Signed in" and "Not signed in" status text.
3. A plan card in `src/frontend/web/src/ui/settings/models/` with these
   states: signed out (**Continue with ChatGPT**); waiting for the browser
   (cancel, open again); signed in (email, plan use, **Manage usage**, the
   background switch, sign out); plan use declined or not eligible (R1.4,
   with a way to enable it later); unavailable (R1.7 or missing secure
   storage). The card opens the authorize URL in a new browser context and
   never logs it.
4. The one-time confirmation (R1.3): "You're using your ChatGPT plan", what
   uses it, where to manage usage, and an unchecked choice for automatic
   memory updates. Confirming writes the preferences.
5. `SetupAiStep.tsx`: the same card as a setup choice (spec P8).
6. Text when sign-out could not be confirmed at OpenAI (R1.5).
7. Strings in all five locales, then `pnpm i18n:extract`.

Checks: the touched Vitest specs; from `src/frontend` `pnpm check`. Not run:
`pnpm verify`, the browser tests.

Manual check (G1, and G2 for desktop): a real sign-in in a task stack opened
on the same machine, in built and development mode, and in the desktop app.
This completes spec check C1's return test.

Completion: each card state renders from a mocked status, and a real account
signs in, stays signed in across a restart and signs out.

Recovery: the card is additive. Hiding it leaves the Models section as it is
today.

As built (2026-11-24, from `bc5f28fab`): `useChatGPTPlan` (the status
query, polling each second while a sign-in is pending) and its mutations;
`ChatGPTPlanCard`, used on a "ChatGPT plan" provider tab after Anthropic in
both App Settings → Models and setup's AI step, offered only where the
runtime reports `chatgpt_plan`; and the one-time confirmation inside the
card. The query key sits under `modelConfiguration`, so `product-ui` goes to
0.21.0. Wording follows OpenAI's interface guidelines (checked 2026-11-24):
"Use your ChatGPT plan", **Continue with ChatGPT**, "You're using your
ChatGPT plan" with **Got it**, and **Manage usage** opening
`https://chatgpt.com/settings/usage`. Choices made while building:

- The button is text only, in the theme's foreground colour. Whether to use
  the ChatGPT logo is G4.
- The authorization URL stays in memory only, in the card while the sign-in
  waits; the begin mutation keeps no result. It opens with
  `window.open(…, "noopener,noreferrer")`, which desktop hands to the system
  browser; the waiting state offers "Open the sign-in page again" for a
  blocked popup.
- The confirmation's choice for automatic memory updates starts unchecked;
  the card keeps the same choice as a switch.
- The card shows a declined or failed sign-in, plan use that is off (with
  **Enable plan use**, which asks OpenAI for consent again), a session
  OpenAI ended, the usage-limit pause and an unconfirmed sign-out. Where a
  sign-in cannot start here, it says why in place of the action; a signed-in
  account keeps its controls whatever the availability.
- Choosing a plan model in setup arrives with the plan's models in Phase 5.

Check record, from the worktree root unless noted, on working tree
`1ec049fcc0aee88c48a174bea4181f98c3f17c13` (hashed while this line still held
a placeholder):

| Check | Result |
| --- | --- |
| From `src/frontend`: vitest on `src/ui/settings/models` and `src/app/local-runtime/setup` | 123 passed |
| From `src/frontend`: `pnpm --filter animama-web lint` | Passed |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm check` | Exit 0; no type errors; every catalog complete |
| Prettier `--check` on the changed web, locale and `product-ui` files | Formatted |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |
| Task stack in development mode, setup's AI step in the browser pane | The tab, card and waiting state render as designed; Cancel returns to **Continue with ChatGPT**; no authorize URL or state in container or file logs |

Not run: `pnpm verify` and the browser tests. Manual check (G1, and G2 for
desktop): pending the owner's sign-in, batched with the later phases'.

#### Code Review #1 Findings

Independent review, standard tier, of working tree
`da4cb249e8d2f2c98ce34f339ff11308fc1eab34` against `bc5f28fab`, reusing the
check record (only the plan changed since its tree) and rerunning the card
and state tests. Result: blocked by F1 and F2. The authorization URL's
handling, the translations' terms and the guideline wording were found
sound.

| ID | Kind | Finding |
| --- | --- | --- |
| P4-R1-F1 | Required | Where sign-in is unavailable (for example a self-hosted stack later moved behind an https origin), a signed-in account lost its sign-out, usage link and background switch, because the unavailable branch came first. |
| P4-R1-F2 | Required | Tests did not cover the pause notice, the secure-storage wording, failures other than a decline, a begin failure or the polling. |
| P4-R1-F3 | Optional | Sign-out did not wait for its refetch, so its notice briefly sat under the signed-in state. |
| P4-R1-F4 | Optional | The begin mutation's result (the URL) stayed in the mutation cache; a spent URL could be reopened. |
| P4-R1-F5 | Optional | Wording: "Settings → Models", ブラウザ, and "chat notes" against the catalogs' terms. |
| P4-R1-F6 | Optional | A failed **Enable plan use** showed no failure, and the decline text did not mention another connection (R1.4). |
| P4-R1-F7 | Optional | Accessibility: focus after a state change, the dialog's first focus on the external link, the switch's description, the heading level in setup. |
| P4-R1-F8 | Optional | A failed poll replaced the card with "Couldn't load…". |
| P4-R1-F9 | Optional | Small code points: an inline capability check, a positional `undefined`, a stale doc comment. |
| P4-R1-F10 | Optional | R1.1 asks for the action wherever the app asks for a model and none is configured; the chat picker's empty state does not offer it. |
| P4-R1-F11 | Optional | The Cloud provider strip may need checking at desktop width in `ja` and `ko`. |

#### Code Review #1 Revisions

| ID | Disposition |
| --- | --- |
| P4-R1-F1 | Accepted: the signed-in branches come first; the reason replaces only a sign-in action. A test covers it. |
| P4-R1-F2 | Accepted: tests for each state, a begin failure worded from its reason, and polling from pending into the confirmation, with the URL absent from the page throughout. |
| P4-R1-F3 | Accepted: sign-out's invalidations are awaited. |
| P4-R1-F4 | Accepted: `gcTime: 0` on the begin mutation, and the card drops the URL once the sign-in stops pending. |
| P4-R1-F5 | Accepted in all five locales, using each catalog's term for episode notes. |
| P4-R1-F6 | Accepted: failures show in every sign-in state; the decline text offers another model connection. |
| P4-R1-F7 | Accepted except focus after a state change: **Got it** takes first focus, the switch is described, setup uses a level-3 heading. Moving focus on each state change would steal it from someone reading. |
| P4-R1-F8 | Accepted: the card renders from cached data. |
| P4-R1-F9 | Accepted: the shared hook, and the parameter documented; the positional `undefined` stays, since it keeps the build's flag. |
| P4-R1-F10 | Deferred to Phase 6, which already changes the chat picker; the final integration review checks it. |
| P4-R1-F11 | Deferred to the G1 manual check; Phase 8 updates the provider count in the docs. |

Removing the polling, the pause notice, the secure-storage wording, the
signed-in precedence or the failure distinction each fails a test. After the
repairs, on working tree `678bde070cb65581b07a72165a9bff11540a6248`: the
settings and setup tests, 128 passed; lint, the frontend check (heavy slot)
and prettier on the changed files passed.

#### Code Review #2 Findings

Targeted recheck of working tree `678bde070cb65581b07a72165a9bff11540a6248`,
reusing the record for that exact tree. Result: pass; F1 to F11 resolved or
acceptably dispositioned.

| ID | Kind | Finding |
| --- | --- | --- |
| P4-R2-F1 | Optional | `gcTime: 0` applies only once the mutation has no observer, so the begin mutation's result (the URL) stays while the card is mounted. |
| P4-R2-F2 | Optional | The round-1 check line named no tree. |

#### Code Review #2 Revisions

Both accepted and verified by the implementing agent as one-line changes:
the card calls `begin.reset()` once it has taken the URL, and the check line
names its tree. The card's tests, 12, still pass.

### Phase 5: The plan connection and its model client

Review tier: high risk (catalog persistence and the seed, the API contract,
concurrency, outbound credentials).

Requirements: R3.1, R3.2 (catalog), R5.2, R5.3. Threats T4, T7 and T8.

Steps, tests first in `tests/test_chatgpt_plan_client.py`,
`tests/test_chatgpt_plan_models.py`, `tests/test_model_provider_catalog.py`,
`tests/test_model_error_categories.py` and
`tests/test_model_key_destinations.py`:

1. Connection: a `chatgpt_plan` id in `BUILTIN_CONNECTION_IDS`, a preset the
   owner cannot select, a built-in connection with no credential variable,
   the provider type (D3) and its entry in `app/chat/api_standard.py`. The
   hosted catalog policy stays as it is, which excludes the connection.
2. Seed: add the connection row, and make the deactivation statement skip
   this connection. Update the renderer and the parity test.
3. Model sync (D4, D9): at sign-in and on `POST
   /v1/chatgpt-plan/models:refresh`, list the account's models, upsert rows
   for the items whose `visibility` is `list` from the fields the Decision
   Log names, deactivate rows no longer listed, and deactivate all of them
   when the session ends. The list response is never logged. Rows accept
   only the `hidden` change. The model connection list reports the plan
   connection's credential state from the session. Add the refresh route to
   the inventory and regenerate the client with `pnpm openapi-ts`.
4. Validation: a plan row must be on the plan connection and needs a
   signed-in session, with a code the page can explain. Owner model routes
   refuse the plan connection.
5. Client: registered in `build_model_client_registry` (the mock under
   `ANIMAMA_LLM_SKIP`). The route profile sets `store` false; never sends a
   cursor, `moderation`, limits or metadata; wraps function tools in one
   namespace and maps returned names back; sends system text only as
   `instructions`; never sends `context_management` or `apply_patch`; and
   declares hosted `web_search` only for a row that supports it. Final
   items come from the terminal event when it has them and otherwise from
   the `response.output_item.done` events, and stream events the SDK does
   not type are ignored. The SDK client is key-free, has a fixed base URL,
   takes no headers from the environment and does no SDK retries. Each
   stream gets a view keyed with the session's access token.
6. Tool rounds replay by hand from the first round: each call and its
   output, without item ids. Requesting encrypted reasoning, and replaying
   each returned reasoning item with the id the SDK requires, sits behind
   a route-profile switch that is off until confirmed (Decision Log,
   2026-11-24). Tests cover both settings.
7. Errors: map the plan error codes and the bare `detail` bodies to new
   codes and categories for a limit, an ineligible account, a temporary
   outage, an unsupported request and a required sign-in. A 401 forces one
   refresh and one retry before any output. A limit sets the pause. Extend
   `sanitize_provider_error_message` for JWT shapes and the current token
   values (T3).
8. Prove the Utility path: `DirectModelPromptRunner` completes a prompt on a
   plan row.

Checks: the test files, including the acceptance test that inspects the
request built for a plan model; `tests/test_model_client_registry.py`;
`uv run ruff check`; from `src/frontend` `pnpm openapi-ts:check` and the
package-set `compare`. Not run: the full pre-push suite.

Manual check (G1): refresh lists the account's models, and one direct prompt
with a tool call succeeds on a real plan model. The probe's
`reasoning_replay` trial (D11) then runs once on each listed model, two
requests each. If a response holds a reasoning item beside the tool call
and the route accepts the follow-up, the reasoning switch turns on. If
none does, the switch stays off and Outcomes records reasoning replay as
unconfirmed.

Completion: a feature that picks its own model can use a plan model. This is
the point the content generation plan needs (D12).

Recovery: plan rows are derived data. Signing out deactivates them, and a
later sign-in restores them. The seed change is repeatable.

As built (2026-11-24, from `0ca53db71`):

- Connection and seed: `chatgpt_plan` joins the built-in connections with a
  preset the owner cannot select and no credential variable, the provider
  type `ChatGPTPlanResponsesHTTPAgent` maps to the Responses standard, and
  the seed's retirement statement skips the plan connection. The model
  connection list reports the connection's state from the session.
- Model sync: `ChatGPTPlanModelCatalog` lists the account's models
  (`OpenAIChatGPTPlanModels`, keeping only the Decision Log's fields),
  upserts `list` items as read-only rows that keep their hidden flag,
  retires the rest, renews a refused token once, and retires every row at
  sign-out. The sign-in return and `POST /v1/chatgpt-plan/models:refresh`
  run it. Owner model routes (add, list available, probe) refuse the plan
  connection; a plan row accepts only **Show in model lists**.
- Requests: a `ResponsesRoute` profile says what an endpoint accepts. The
  plan's route turns off the stored cursor, inline moderation, output
  limits, `context_management` and `apply_patch`; sends later system text
  as developer items; wraps function tools in the `animama` namespace and
  names it on replayed calls; and offers hosted search only where the row
  supports it. `ChatGPTPlanResponsesModelClient` reuses the Responses
  client through four hooks (credential, renewal, error wording, success)
  with one key-free SDK client at `https://api.openai.com/v1`, no SDK
  retries, no redirects and only allowlisted headers. Final items come from
  the done events when the terminal event lists none. Reasoning replay is
  built behind the profile's switch, which is off.
- Errors: plan codes and bare `detail` bodies become
  `chatgpt_plan_usage_limit` (which sets the pause), `_not_eligible`,
  `_unavailable` (retried with bounded backoff), `_unsupported_request`
  (with the route's detail) and `_sign_in_required` (after one renewal and
  retry). Provider messages lose JWTs and the request's own token.
- Registry: the local composition registers the plan client with its
  session; hosted registers none, and `ANIMAMA_LLM_SKIP` maps the type to
  the mock. A Utility prompt completes on a plan row.
- Settings and setup: the plan tab lists the plan's models under the
  account card with the hidden-models toggle and **Refresh list** (no
  adding or removing); the catalog is read again when the plan becomes
  usable; setup chooses a plan model then. The client is regenerated for
  the refresh route.

Check record, from the worktree root unless noted, on working tree
`a15249d784473c6d8bdda19dc783aef169c92799` (hashed while this line still held a placeholder):

| Check | Result |
| --- | --- |
| `uv run pytest -q tests/test_chatgpt_plan_client.py` | 23 passed (the acceptance test of the plan request, errors, renewal, redirects, headers, reasoning switch both ways, Utility path, registry) |
| Mutation checks on the plan client: header hook removed, explicit `Authorization` removed, redirects on, SDK retries on | Each fails a test |
| `python3 scripts/heavy-slot.py -- uv run pytest -q -n 2` on the 76 test files that import the changed modules (model clients, errors, categories, plan code, `api_standard`, provider state, native tools, prompt runner, model configuration, evaluation tools) | 2005 passed, 1 failed: the existing order leak under Surprises & Discoveries |
| `uv run ruff check`, `uv run ruff format --check` | Passed; 1050 files formatted |
| `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests scripts/evals/core/catalog.py` | No issues in 931 files |
| From `src/frontend`: `pnpm openapi-ts:check` | Generated SDK current |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm check` | Exit 0; catalogs complete |
| From `src/frontend`: `pnpm web:lint` | Passed |
| From `src/frontend/web`: vitest on `src/ui/settings`, `src/lib/chat`, `src/query`, `src/app/local-runtime`, `src/routes/-setup.test.ts` | Passed (502 and 264 tests) |
| Mutation checks on the plan tab's list and the sign-in refetch | Each fails its test |
| Prettier `--check` on the changed web and locale files | Formatted |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |

Not run: the full pre-push suite (G3), the package-set `compare` (on the
final candidate), browser tests. Manual check (G1): pending the owner's
sign-in, with the probe's `reasoning_replay` trial.

#### Code Review #1 Findings

Independent review, high-risk tier, of working tree
`83ec15724762b7b4bb89742d42a809e52ec4efd7` against `0ca53db71` (the check
record's tree plus its own hash line). A separate checks agent reran every
affected check on that tree: all passed except the known order leak, which
involves no plan rows. Result: blocked by F1 to F4. The request shape,
credential handling, renewal under concurrency, the API-key path through the
refactor, the seed, the hosted policy and the reasoning switch were found
sound.

| ID | Kind | Finding |
| --- | --- | --- |
| P5-R1-F1 | Required | The return cleared the pending attempt before storing the models, so a status poll in between refetched the catalog too early; polling then stopped, and the plan tab showed no models until **Refresh list**. |
| P5-R1-F2 | Required | Setup's choice raced its two queries: when the connection list arrived before the catalog, the plan became ready with no model and nothing was chosen afterwards. |
| P5-R1-F3 | Required | R5.3: a temporary failure was retried once at once, or not at all when `Retry-After` exceeded 2 seconds; with SDK retries off the plan had no backoff. |
| P5-R1-F4 | Required | R5.2: a role assigned to a retired plan row (signed out, or no longer listed) fell back to the operator default, moving titles and compaction to the OpenAI key. |
| P5-R1-F5 | Optional | Refresh and withdrawal were not serialized: a sign-out during a refresh could leave rows active, and two first refreshes could insert the same rows. |
| P5-R1-F6 | Optional | The refresh route words most listing failures as temporarily unavailable, the toast is generic, and the route's and the client's codes for plan use that is off differ. |
| P5-R1-F7 | Optional | An unreadable session made the whole model connection list fail. |
| P5-R1-F8 | Optional | `ResponsesRoute.connection_id` was unused, and two constants held the plan's API address. |
| P5-R1-F9 | Optional | The hosted-search test bypassed the real gate, and no client failure path was checked for tokens in logs. |

#### Code Review #1 Revisions

| ID | Disposition |
| --- | --- |
| P5-R1-F1 | Accepted: `complete()` takes an `after_sign_in` step that runs after the account is saved and outside the session lock; the sign-in reads as pending until it finishes, and the return passes the model refresh. The hook treats a pending sign-in as not yet usable. Tests: the session reports pending during the step and finished after it, also when it fails; a refused return runs none; the card test refetches only after pending clears (and fails without the change). |
| P5-R1-F2 | Accepted: `useChooseWhenReady` remembers a provider that became ready and chooses its model as soon as one is known, once. Tests cover the late model, a provider ready before setup acted and one that stopped being ready. |
| P5-R1-F3 | Accepted: the client's retry decision is a hook; the plan retries a temporary failure twice after 1 and 2 seconds, or after a `Retry-After` of at most 10 seconds, and reports a longer wait. Tests record the waits. The API-key path keeps its behaviour. |
| P5-R1-F4 | Accepted: an unusable assignment on the plan connection resolves to no model with the choice reported unavailable, for each role and for roles inheriting the chat role. Settings word it as waiting rather than "the default is used". Recorded in the Decision Log. |
| P5-R1-F5 | Accepted: one app-wide lock serializes refresh and withdrawal. A test with two database sessions shows a withdrawal during a gated refresh leaves no plan row active, and fails without the shared lock. |
| P5-R1-F6 | Partly accepted: a refresh rereads the plan status, so a session OpenAI ended shows on the card (the catalog key already covered the status key; the explicit status invalidation only states it). The listing's answers for an ineligible account are undocumented and unobserved, so they keep the generic code. The route reports the session's own state (`chatgpt_plan_plan_use_not_granted`) for settings, while the client reports what a chat needs (`chatgpt_plan_use_not_granted`); the two vocabularies stay apart. |
| P5-R1-F7 | Accepted: the connection list reads an unreadable session as `missing`; a test covers it. |
| P5-R1-F8 | Accepted: the field is removed and the plan client uses the sign-in adapter's `API_BASE`. |
| P5-R1-F9 | Accepted: the hosted-search test runs the turn's real gate for a row with and without search, and a test drives the renewal, detail, outage and limit failures and finds neither token in the logs or the error. |

Repair check record, on working tree `75bf1287b6a8a6206a7b0da34042954fd8cca48e` (hashed while
this line still held a placeholder):

| Check | Result |
| --- | --- |
| `python3 scripts/heavy-slot.py -- uv run pytest -q -n 2` on the 82 test files importing the changed modules (now including model roles) | 2139 passed |
| Mutation checks: no shared lock; the hook ignoring a pending sign-in | Each fails its test |
| `uv run ruff check`, `uv run ruff format --check`; `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests scripts/evals/core/catalog.py` | Passed; no issues in 931 files |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm check`, `pnpm web:lint` | Exit 0; lint clean; catalogs complete |
| From `src/frontend/web`: vitest on `src/ui/settings`, `src/lib/chat`, `src/query`, `src/app/local-runtime`, `src/routes/-setup.test.ts` | 70 files, 533 tests passed |
| Prettier `--check` on the changed web and locale files; `python3 scripts/public-release/check_source.py` | Formatted; every tracked file covered once |

#### Code Review #2 Findings

Targeted recheck, high-risk tier, of working tree
`75bf1287b6a8a6206a7b0da34042954fd8cca48e` against the tree of Review #1.
A separate checks agent reran every affected check on it: all passed (2139
backend tests in the 82 files, 533 web tests, lint, types, catalogs, the
generated client, formatting, source review), and the order leak did not
occur. Result: pass. P5-R1-F1 to F5 and F7 to F9 are resolved; F6's
reasons hold. The lock order between the session and the models lock,
replays and cancels during the sign-in step, the API-key retry path and
key saving in setup were found unchanged or sound.

| ID | Kind | Finding |
| --- | --- | --- |
| P5-R2-F1 | Optional | A role that inherits a waiting plan chat model reads as `off` with its choice available, so settings say no model can do the job instead of that it waits. |
| P5-R2-F2 | Optional | The status invalidation added for F6 was already covered by the catalog key; the revision overstated the change. |
| P5-R2-F3 | Optional | `docs/backend/architecture/data-model.md` and `http-api.md` still say every unusable role assignment falls back. |

#### Code Review #2 Revisions

| ID | Disposition |
| --- | --- |
| P5-R2-F1 | Deferred to Phase 7 step 3, which gives the roles their reasons for the settings line. |
| P5-R2-F2 | Accepted as a record correction: the F6 row now says the status read was already there. No code change. |
| P5-R2-F3 | Accepted: both documents are on Phase 8's list. |

Commit: `feat(models)[p5]: …` (this commit).

### Phase 6: Chat on plan models

Review tier: standard.

Requirements: R3.2 (chat), R3.3 to R3.7, and R5.1 as chat shows it.

Steps, tests first in `tests/test_direct_chat_turn_executor.py`,
`tests/test_chat_manager.py`, `tests/test_companion_safety_chat.py` and the
Vitest specs for the composer and the failure notice:

1. Executor: a plan turn carries no moderation option and reads no cursor.
   After it, the chat row holds no cursor, so the next key-model turn
   replays history, and the reverse also works (R3.6, spec check C3). Native
   compaction is off for plan rows, so context fitting uses the row's
   window.
2. Web search per D8: hosted search where the row supports it, reported
   through the model's requestable tools so the picker's control explains
   itself (R3.5).
3. The composer shows "Using ChatGPT plan" with **Manage usage** when the
   selected model belongs to the plan connection, in chat and Quick Chat
   (R3.7).
4. Failure notices for the Phase 5 codes in `chat-failure.ts` and the
   product-ui catalogs: a limit and an ineligible account carry a **Manage
   usage** link, and a required sign-in names App Settings → Models. Add the
   codes to `userVisibleCodes.json`.
5. The chat picker groups plan models under "ChatGPT plan".

When chat image input (#904) lands, plan rows send image parts through the
shared request builder; this phase adds nothing for it.

Checks: the test files; from `src/frontend` `pnpm check`; the package-set
`compare` if a product-ui declaration changed.

Manual check (G1): on a real plan model an Anima replies with streaming, uses
a memory tool and gets a title; one turn uses hosted search and a memory
tool together; a chat started on a key reasoning model, whose history holds
a phased reply, a native memory edit and a tool call, continues on the plan
and back.

Completion: spec acceptance lines for chat, the indicator and chat
continuity are met in tests, and the manual check passes.

Recovery: an Anima on a plan model can be moved to any other model, and its
chat continues there.

As built (2026-11-24, from `6d1fc8f73`):

- Executor and continuity: Phase 5 already keyed every forbidden piece to
  the OpenAI Responses provider type, so a plan turn carries no moderation
  option, runs no operator check, reads no stored cursor (even one a key
  model left), and its reply stores no OpenAI metadata, so the chat row's
  cursor is cleared and the next key-model turn replays history. Plan and
  key Responses models share the Responses standard, so a chat moves either
  way. The plan client asks for no server compaction, so the executor fits
  the prompt to the row's window. Tests pin each of these. A key model's
  native memory edits are left out of a plan request's replayed history,
  because the route refuses `apply_patch` (from review P6-R1-F1); the edits
  are applied and the replies stay. Assistant phases from earlier key-model
  replies are replayed as on a key; the G1 check of a chat moving from a key
  model exercises both on the route.
- Web search (R3.5): the catalog reports hosted search for a plan row only
  when its listing supports it, so the picker's existing control shows
  hosted search, the app's search or the reason neither is available.
- The composer shows "Using ChatGPT plan" with **Manage usage** above the
  input whenever the chat's model is a plan model, in chat and Quick Chat
  (`ChatGPTPlanUsageNote`, reusing the card's link).
- Failure notices in `product-ui` for the six plan codes in five locales: a
  limit and an ineligible plan link to the usage page
  (`CHATGPT_MANAGE_USAGE_URL` now lives in `product-ui`, and web re-exports
  it); a required sign-in and plan use that is off name App Settings →
  Models; an outage keeps OpenAI's wait; an unsupported request quotes the
  route's own reason, the only notice that shows provider text (R5.3).
- The chat picker groups plan models under "ChatGPT plan", named in the UI
  Locale as App Settings names it.
- `docs/frontend/runtime/chat.md` states the two exceptions the plan adds to
  what a notice may show: the route's quoted reason and the usage link.
- P4-R1-F10 (the chat picker's empty state): no change. The picker lists
  every visible built-in model whether or not its key is set, so locally it
  never shows an empty state; the app asks for a model in setup's AI step
  and App Settings → Models, which both offer **Continue with ChatGPT**.
- `userVisibleCodes.json` lists codes worded in the web `errors` catalog; the
  plan's chat codes are worded in `product-ui`'s catalog, whose
  completeness check covers them, so the list is unchanged.

Check record, from the worktree root unless noted, on working tree
`5c094ac3cc82be79a079fd571e72a19e6daed297` (hashed while this line still held a placeholder):

| Check | Result |
| --- | --- |
| `python3 scripts/heavy-slot.py -- uv run pytest -q -n 2` on the executor, chat manager, companion safety, chat route, catalog and plan client and model tests | 347 passed |
| `uv run ruff check`, `uv run ruff format --check`; `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests` | Passed; no issues in 930 files |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm check`; `pnpm web:lint` | Exit 0; catalogs complete; lint clean |
| From `src/frontend/packages/product-ui`: `pnpm check`, `pnpm test` | Exit 0; 50 passed |
| From `src/frontend/web`: vitest on `src/ui/main/chat`, `src/lib`, `src/ui/settings`, `src/query`, `src/app/local-runtime`, `src/routes/-setup.test.ts`, `src/ui/components` | 387 files, 3981 passed, 2 skipped |
| Prettier `--check` on the changed web, `product-ui` and locale files; `python3 scripts/public-release/check_source.py` | Formatted; every tracked file covered once |

Not run: the full pre-push suite (G3), the package-set `compare` (on the
final candidate; `product-ui` stays at the branch's 0.21.0), browser tests.
Manual check (G1): pending the owner's sign-in.

#### Code Review #1 Findings

Independent review, standard tier, of working tree
`5c094ac3cc82be79a079fd571e72a19e6daed297` against `6d1fc8f73`, reusing the
check record (no covered file changed after its tree) and running one
read-only reproduction. Result: blocked by F1 and F2. R3.4, the cursor
rules, context fitting, R3.5, the indicator in both surfaces, the six
notices, the link and detail safety, the `userVisibleCodes.json` reasoning
and the product-ui version were found sound.

| ID | Kind | Finding |
| --- | --- | --- |
| P6-R1-F1 | Required | R3.6: a key-model chat whose Anima saved a memory with native `apply_patch` replays `apply_patch_call` items to the plan route, which refuses that tool, so every later plan turn in the chat could fail. |
| P6-R1-F2 | Required | `docs/frontend/runtime/chat.md` says no notice shows provider text and that the only link is the trial download; both are now false, and Phase 8 did not list the file. |
| P6-R1-F3 | Optional | The picker names the plan's connection in English in every locale, while settings localize it. |
| P6-R1-F4 | Optional | ja and zh notices leave the settings path unquoted, unlike the catalogs; ja says 利用 where the setting says 使用, and uses an ASCII colon. |
| P6-R1-F5 | Optional | The English limit guidance says plan requests resume at reset, but chat is never paused; the person sends again. |
| P6-R1-F6 | Optional | The plan cursor case does not check that history was replayed; the context test checks only the client flag. |
| P6-R1-F7 | Optional | G1's continuity check should require a phased reasoning reply, a native memory edit and a tool call before the move. |
| P6-R1-F8 | Optional | The P4-R1-F10 reasoning holds; no change. |

#### Code Review #1 Revisions

| ID | Disposition |
| --- | --- |
| P6-R1-F1 | Accepted: a route without `apply_patch` among its hosted tools drops replayed `apply_patch_call` items and their outputs; the API route keeps them. A request-shape test fails without the change. |
| P6-R1-F2 | Accepted: the paragraph now states both exceptions. |
| P6-R1-F3 | Accepted: `modelConnectionLabel` names a plan row's connection in the UI Locale; a test switches to ja. |
| P6-R1-F4 | Accepted in ja, zh-Hans and zh-Hant. |
| P6-R1-F5 | Accepted in all five locales: send again after the reset, or choose another model. |
| P6-R1-F6 | Partly accepted: a test checks that a plan turn replays the key model's reply and sends no cursor. The executor's budgeting for clients without native compaction is covered by its existing tests, so the context test stays at the flag. |
| P6-R1-F7 | Accepted: the manual check names all three. |
| P6-R1-F8 | No change. |

Repairs verified by the coordinator, as the review policy allows below the
high-risk tier: each is a small, local change whose test was run, and the
affected checks were rerun on working tree `bd87caa4838406b03f7742c509941c367afce031` (hashed
while this line still held a placeholder): backend pytest on the eight
affected files (399 passed), ruff and mypy (clean, 930 files),
`pnpm packages:build`, `product-ui` check and tests (50 passed),
`pnpm check` and `pnpm web:lint` (exit 0), vitest on the same directories
(3982 passed, 2 skipped) and Prettier on the changed files.

Commit: `feat(chat)[p6]: …` (this commit).

### Phase 7: Roles, agreement and limits

Review tier: high risk (a background worker, the consent boundary,
concurrency).

Requirements: R3.2 (Utility, Memory Manager, Embeddings), R4.1, R4.2, R5.1.
Threat T7. Follows D5 and D6.

Steps, tests first in `tests/test_model_roles.py`,
`tests/test_memory_manager.py`, `tests/test_automatic_episode_processing.py`
and a new `tests/test_chatgpt_plan_background.py`:

1. Role pickers offer plan models for the default chat model, Utility and
   the Memory Manager, and never for Embeddings.
2. Memory Manager on a plan row: a plan mode of the Agents SDK runtime that
   streams, does not store, sends no cursor, puts its tools in a namespace,
   uses the function form of memory edits because the route refuses native
   `apply_patch`, turns tracing off, and builds its client from the
   session's token with no SDK retries. A request-capture test asserts that
   none of the rejected fields is sent. The Agents SDK replays output items
   with their ids, and reasoning items too, which Phase 0 did not try: the
   capture test records what it sends, and the manual check shows whether
   the route accepts it. If the SDK cannot meet the route's rules, stop and
   bring the options to the owner, because removing the Memory Manager from
   R3.2 changes the spec.
3. Agreement (D5, D6): `local_memory_manager_model_usable` is false for a
   plan row without agreement or while paused, with a reason the settings
   line can show. The same reason reaches Utility and the Memory Manager
   when they inherit a chat role that waits on an unavailable plan model
   (P5-R2-F1). The token service enforces the same rule for the
   `background` purpose, so the check cannot be bypassed.
4. The pause (R5.1): set by a limit error, cleared when an interactive plan
   request succeeds, and shown in the status and on the card.
5. A Reflection on a plan model runs as the person's own request.

Checks: the test files; `uv run ruff check`; the touched Vitest specs. Not
run: the full pre-push suite.

Manual check (G1): with agreement, automatic episode processing runs on the
plan; without it, it does not and says why; a Reflection runs either way.

Completion: every T7 negative test passes, and the manual check matches.

Recovery: withdrawing agreement or choosing another Memory Manager model
takes effect on the next run.

As built (2026-11-24, from `64b6bb810`):

- Roles (R3.2): role pickers and the backend's role rule offer a plan model
  for the default chat model, Utility and the Memory Manager, never for
  Embeddings. Utility and the Memory Manager that inherit a chat role
  waiting on an unavailable plan model report it as waiting (P5-R2-F1).
- Memory Manager plan mode: the OpenAI Agents runtime runs a plan row
  through `ChatGPTPlanAgentsClient`, which stands in for the SDK's OpenAI
  client. Every `responses.create` goes out streamed and unstored, without
  the fields the route refuses (output limits included), with replayed
  items stripped of ids and without reasoning or item references, and the
  stream is assembled into the `Response` the SDK expects (items from the
  done events when the terminal event lists none). The runtime declares its
  tools, memory edits in their function form included, with the SDK's own
  `tool_namespace`, turns tracing off (the plan is not the built-in OpenAI
  connection), builds its SDK client with no retries, no redirects and the
  plan's header allowlist, and records no response cursor, as for Chat
  Completions rows. A refused token is renewed once per request, a
  temporary failure gets the plan's bounded backoff, a usage limit sets the
  pause, and an interactive success clears it. Approvals stop for the
  person as on other rows.
- Purpose (D5): a run that started by itself (`origin: automatic`) asks for
  `background` tokens, which the session refuses without agreement or while
  paused; every other run, including a Reflection, is the person's own and
  asks for `interactive` ones. Failures say why in the run's error.
- Agreement and the pause in the worker (D6): the model check now reports
  readiness. A plan row is ready only with a usable sign-in, agreement and
  no pause; otherwise automatic processing waits with the new states
  `needs_plan_agreement`, `needs_plan_sign_in` or `plan_paused`, which App
  Settings words in five locales. It never moves to another model.
- From review: each plan request asks the session for its token again, so
  a pause or withdrawn agreement stops a run between rounds; a step on a
  provider that stores no conversation (a plan or Chat Completions row) now
  drops the run's stored cursor, so a later key step replays the run; an
  approval is refused before it applies when the plan cannot serve the run;
  and a run's error names the plan's reason, quoting the route for an
  unsupported request.

Check record, from the worktree root unless noted, on working tree
`1330191de601f5af2bac15fb1b846ede8011c29a` (hashed while this line still held a placeholder):

| Check | Result |
| --- | --- |
| `uv run pytest -q tests/test_chatgpt_plan_background.py` | 9 passed: the request capture (streamed, unstored, no refused field, tools in one namespace with the function form of edits, items without ids or reasoning, token, purpose), background purpose with output limits stripped, refusals without a request, the usage-limit pause, renewal, approvals, tracing off |
| Mutation checks: refused fields kept, ids kept, reasoning kept, purpose always interactive, agreement ignored in the model check | Each fails a test |
| `python3 scripts/heavy-slot.py -- uv run pytest -q -n 2` on the 88 test files importing the changed modules (model clients, plan code, Memory Manager, episode processing, roles, provider state, evaluation tools, memory automation) | 2218 passed |
| `uv run ruff check`, `uv run ruff format --check`; `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests` | Passed; no issues in 932 files |
| From `src/frontend`: `pnpm openapi-ts:check`; `python3 ../../scripts/heavy-slot.py -- pnpm check`; `pnpm web:lint` | Current; exit 0; lint clean |
| From `src/frontend/web`: vitest on `src/ui`, `src/lib`, `src/query`, `src/app`, `src/routes` | 602 files, 5600 passed, 2 skipped |
| Prettier `--check` on the changed web and locale files; `python3 scripts/public-release/check_source.py` | Formatted; every tracked file covered once |

Not run: the full pre-push suite (G3), browser tests. Manual check (G1):
pending the owner's sign-in; it should also approve one memory edit
proposed on the plan.

#### Code Review #1 Findings

Independent review, high-risk tier, of working tree
`1330191de601f5af2bac15fb1b846ede8011c29a` against `64b6bb810`, with four
read-only probes over mock transports. A separate checks agent reran every
affected check: all passed except the known order leak, and one
episode-processing timeout under load that passed in a quiet rerun and
alone. Result: blocked by F1 to F3. The purpose of each run kind, the
absence of any fallback, every request path the SDK takes (including an
approval resume from serialized state), credentials, the assembled
`Response`, the renewal bound, readiness for key rows and the hosted
composition were found sound. Step 2's open question is answered at the
request level; the G1 check must still show the replay shapes, the
namespace echo, multi-round quality without reasoning, a live approval
resume and a real limit body.

| ID | Kind | Finding |
| --- | --- | --- |
| P7-R1-F1 | Required | T7: a background run took its token once, so a pause or withdrawn agreement that began mid-step did not stop its later rounds. |
| P7-R1-F2 | Required | A plan step kept the run's older key-model cursor, so a later key step would skip the plan step's exchange (the gap exists for Chat Completions steps too). |
| P7-R1-F3 | Required | `docs/backend/features/memory-manager-and-episodic-memory.md` and the state list in `http-api.md` become misleading and were not on Phase 8's list. |
| P7-R1-F4 | Optional | No test for the approval resume on the plan. |
| P7-R1-F5 | Optional | Any surviving 429 read as a usage limit without setting the pause; other plan refusals read as a generic failure, without the route's detail. |
| P7-R1-F6 | Optional | The client always drops reasoning whatever the route's switch says, repeats the temporary codes, and would answer a streamed caller with a finished response. |
| P7-R1-F7 | Optional | A plan row needing a new sign-in or plan use read as "needs a model". |
| P7-R1-F8 | Optional | A test ran a background request on a paused fake session that did not enforce the pause. |
| P7-R1-F9 | Optional | The resolver comment named only the plan case of an inherited wait. |
| P7-R1-F10 | Optional | An approval on a plan row could apply before the session was checked, then fail. |

#### Code Review #1 Revisions

| ID | Disposition |
| --- | --- |
| P7-R1-F1 | Accepted: every request asks the session for a token with its purpose. A test pauses the session during a run's first round and sees no second request; it fails without the change. |
| P7-R1-F2 | Accepted: a runtime result says whether its step kept conversation state; the OpenAI Agents runtime says no for plan and Chat Completions steps, and the service then drops the run's cursor. A key → plan → key test sees the third step replay the plan step; it fails without the change. |
| P7-R1-F3 | Accepted: both documents are on Phase 8's list. |
| P7-R1-F4 | Accepted: a capture test rejects a proposed edit and checks the resumed request. |
| P7-R1-F5 | Accepted: the run's error is worded from the plan's code; a 400 quotes the route's sanitized reason, a bare 429 says requests are limited, and only a limit code sets the pause. An in-stream temporary code is not retried, as in chat. |
| P7-R1-F6 | Accepted: the client names the switch it ignores, shares the plan client's list of temporary codes and refuses a streamed call. |
| P7-R1-F7 | Accepted: a new state, `needs_plan_sign_in`, in the contract and in five locales. |
| P7-R1-F8 | Accepted: the background test runs unpaused and checks that its success clears nothing; the mid-run test uses a session that enforces the rule. |
| P7-R1-F9 | Accepted: the comment states the general case. |
| P7-R1-F10 | Accepted: `for_run` asks the session for the run's token on a plan row, so an approval is refused before it applies; a test covers it. |

Repair check record, on working tree `74bf4bd2b624571e4b15833d864755b799b20d9d` (hashed while
this line still held a placeholder):

| Check | Result |
| --- | --- |
| `uv run pytest -q tests/test_chatgpt_plan_background.py` | 16 passed |
| Mutation checks: token asked once per run, cursor always kept, no early refusal | Each fails a test |
| `python3 scripts/heavy-slot.py -- uv run pytest -q -n 2` on the 88 affected test files | 2225 passed |
| `uv run ruff check`, `uv run ruff format --check`, `python3 scripts/heavy-slot.py -- uv run mypy src/backend/animama tests` | Passed; no issues in 932 files |
| From `src/frontend`: `pnpm openapi-ts:check`, `python3 ../../scripts/heavy-slot.py -- pnpm check`, `pnpm web:lint` | Current; exit 0; clean |
| From `src/frontend/web`: vitest on `src/ui/settings`, `src/lib`, `src/query`, `src/app`, `src/routes` | 4058 passed, 2 skipped |
| Prettier `--check` on the changed web and locale files; `python3 scripts/public-release/check_source.py` | Formatted; every tracked file covered once |

#### Code Review #2 Findings

Targeted recheck, high-risk tier, of working tree
`74bf4bd2b624571e4b15833d864755b799b20d9d` against the tree of Review #1,
with a read-only probe of the run errors. A separate checks agent reran
every affected check on it: all passed (2224 of 2225 in the wider set, the
one failure being the known order leak, which passed alone; 4058 web
tests). Result: pass. P7-R1-F1 to F10 are resolved (F3 by Phase 8's list).
Token requests per call add no lock contention; Cloud's hosted subclass,
the deterministic runtime and runs that stay on Chat Completions behave as
before; only a 400 quotes provider text, and it is sanitized.

| ID | Kind | Finding |
| --- | --- | --- |
| P7-R2-F1 | Optional | An approval refused because the plan cannot serve the run says the model is no longer available and to restore it in App Settings, instead of the plan's reason (for example the usage-limit pause). |
| P7-R2-F2 | Optional | Existing gap: Anthropic steps keep an older OpenAI cursor too, so the field's contract ("a provider that stores no conversation") does not hold for them; inverting its default would close it. |
| P7-R2-F3 | Optional | The plan client's `token` argument is no longer used. |

#### Code Review #2 Revisions

| ID | Disposition |
| --- | --- |
| P7-R2-F1 | Accepted, made with Phase 8 before the final integration review, which covers it. |
| P7-R2-F2 | Accepted the same way, by inverting the default so only stored-Responses steps keep the cursor. |
| P7-R2-F3 | Accepted the same way. |

Commit: `feat(memory)[p7]: …` (this commit).

### Phase 8: Documentation and records

Review tier: light; the final integration review covers it.

1. A new ADR for sign-in credentials and the plan connection: D1 to D7, the
   sign-in return's admission rule, and the alternatives considered.
2. `GLOSSARY.md`: the Model connection entry now also covers a connection
   whose credential is a sign-in; new entries for the ChatGPT plan connection
   and account-listed models.
3. `docs/backend/model-catalog.md`,
   `docs/backend/runtime/model-client-providers.md` (the route profile and
   its errors), `docs/backend/runtime/chat.md` (crisis detection on plan
   turns, R3.4), and the role fallback in
   `docs/backend/architecture/data-model.md` and `http-api.md`: a role on an
   unavailable plan model waits (P5-R2-F3).
4. `docs/backend/architecture/http-api.md` (with the automatic-processing
   states `needs_plan_agreement`, `needs_plan_sign_in` and `plan_paused`),
   `contracts/hosted-web.md` and the version prose in
   `docs/frontend/desktop/releases.md`.
4a. `docs/backend/features/memory-manager-and-episodic-memory.md`: the plan
   mode of the OpenAI Agents runtime (streamed and unstored, tools in a
   namespace, the function form of edits, no cursor, purposes), the new
   readiness states, a run that keeps no cursor after a step on a provider
   that stores none, and an approval refused before it applies when the plan
   cannot serve (P7-R1-F3).
5. `docs/backend/operations/local-http-components.md` and
   `docs/frontend/architecture/auth-server.md`: the return's admission rule.
6. `docs/backend/operations/development.md` (the session file and what
   backups skip), `docs/backend/operations/desktop-runtime.md` and
   `docs/frontend/desktop/overview.md` (the store key and the file).
7. `docs/frontend/features/model-settings.md`: signing in, the indicator,
   limits and the background choice.
8. Source-review entries for every new file.

Check: the documentation links resolve;
`python3 scripts/public-release/check_source.py`.

As built (2026-11-24, from `a4c169151`): ADR 0038 and its index row; the
glossary's Model connection entry and new ChatGPT plan connection and
Account-listed models entries; and every document on the list except
`docs/frontend/desktop/releases.md` and
`docs/frontend/architecture/auth-server.md`, which were already accurate.
`docs/frontend/runtime/chat.md` changed in Phase 6. Documents the list did
not name but the feature left misleading were corrected too: the crisis
protocol in all five languages (models used through a ChatGPT plan get no
moderation check), `docs/frontend/features/anima-memory.md`,
`docs/backend/features/memory.md`, `docs/backend/runtime/prompt-caching.md`,
`docs/backend/runtime/adding-ai-models.md`,
`docs/frontend/architecture/data-layer.md` and
`docs/frontend/desktop/installation.md`. The README's "AI Models (BYOK)"
section named only keys; it is product copy, left for the owner, who chose
its new layout on 2026-11-25 (one Chat table with a "Connect with" column,
OpenAI's Help Center article on plan use linked, a note that the current
installers predate the sign-in, and the same in the ja, ko and zh-Hans
READMEs). Before this phase, `a4c169151` made Code Review #2's three optional
Phase 7 points.

Check record: every relative link added in the documentation diff resolves to
an existing file and heading (a script over `git diff HEAD`);
`python3 scripts/public-release/check_source.py` covers every tracked file
once. No code changed in this phase. Both were rerun by the final review on
`daf1ead67` (tree `15746e0af0e6`), with the same results. Review: covered by
the final integration review.

### Phase 9: One OpenAI tab and the picker's plan notice

Review tier: standard (presentation only; no request, credential or contract
change). Authority: the owner's 2026-11-25 decisions in the Decision Log.

As built (2026-11-25, from `06cfb7d1b`):

- `model-configuration-state.ts`: the ChatGPT plan's entry is gone; OpenAI's
  entry lists the plan preset in `alsoPresetIds`, so the plan connection
  joins OpenAI's group (and its connected dot) only where the runtime offers
  the plan. `modelProviderPurpose(entry, chatgptPlanAvailable)` names both
  ways on OpenAI's tab.
- `ModelConnectionsSettings.tsx`: OpenAI's panel shows the plan card and its
  models, then the key card, which takes an optional `title` and
  `description` ("Use an API key", "Pay OpenAI per request with your own API
  key."). `SetupAiStep.tsx` does the same with its key section.
- `lib/chat/model-catalog.ts`: `openaiModelAccess`, `modelPickerGroupLabel`
  and `pickerModelGroups` (OpenAI's two groups side by side, plan first; made
  conditional on listed plan models by P9-R1-F1);
  `modelOptionDetail` says "ChatGPT plan" or "API key" for OpenAI's rows.
  Other labels, including the tooltip's "Connection: Model", are unchanged.
- The plan notice moved to `ui/components/chatgpt-plan-usage-note.tsx` and
  renders as the last row of the picker's main and model-list views;
  `ChatInterface.tsx` no longer shows it above the composer.
- Strings in `models.json` for all five locales; the unused
  `providers.purpose.chatgptPlan` is removed. `model-settings.md` describes
  the tab, the picker headings and the notice.

Check record (2026-11-25, working tree on `06cfb7d1b`):

| Command | Result |
| --- | --- |
| From `src/frontend/web`: `pnpm exec vitest run` on `src/ui/settings/models`, `src/app/local-runtime/setup`, `src/lib/chat/model-catalog.test.ts`, `src/ui/components` and `src/ui/main/chat` | 33 files, 280 passed (before the grouping moved into `model-catalog.ts`); then 19 files, 222 passed on the touched folders |
| From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm check`; `pnpm web:lint`; `pnpm -s i18n:check` | Passed; every translated catalog complete |
| Prettier `--check` on the changed TypeScript files | Formatted |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once (the moved note's two entries renamed) |
| The task stack rebuilt from the working tree (built mode), in the built-in browser at 1440x900 and 900x900 | Settings: one OpenAI tab, plan card and models, then "Use an API key" with Recommended; picker: "OpenAI · ChatGPT plan" and "OpenAI · API key" groups, the plan row at the bottom of the main and list views, nothing above the composer |
| A disposable fresh stack (`chatgpt-plan-e2e`, port 9300, stopped afterwards), setup's AI step | One OpenAI tab: plan card with Continue with ChatGPT, then "Use an API key" naming the server variable |

Not checked: the dark theme (the app keeps its own theme setting, which was
left alone; the new pieces use the same tokens as their neighbours).

#### Code Review #1 Findings

An independent read-only review at the standard tier, which reran six test
files (146 passed). Result: blocked.

- **P9-R1-F1 (Required).** The picker called every row on the `openai`
  connection "API key", with no runtime condition. The hosted composition's
  operator-paid model sits on that connection, so hosted owners would see
  "OpenAI · API key" for a key they do not have.
- **P9-R1-F2 (Optional).** The memoised groups kept their headings in the old
  language after a UI Locale switch.
- **P9-R1-F3 (Optional).** No test failed if the notice left the picker or
  showed in Chat features, if the plan connection rendered as a key card, if
  the key card took the new title without the plan, for OpenAI's dot from a
  signed-in plan, or for setup's OpenAI tab with the plan offered.
- **P9-R1-F4 (Optional).** Two sentences in `model-settings.md`: which tab the
  plan's dot lights, and that Chat features has no notice.
- Owner notes: the Recommended tag beside "Use an API key"; whether to split
  before a sign-in; R3.7's wording; the key description's size in setup; the
  repeated "API key".

#### Code Review #1 Revisions

- **P9-R1-F1: accepted.** `listsChatGPTPlanModels` decides the split;
  `modelPickerGroupLabel` and `modelOptionDetail` take it, and
  `pickerModelGroups` keeps one "OpenAI" group without plan models (Decision
  Log, 2026-11-25). Tests cover both cases in `model-catalog.test.ts`,
  `model-configuration-state.test.ts` and the picker.
- **P9-R1-F2: accepted.** The groups' memo also depends on `i18n.language`.
- **P9-R1-F3: accepted.** New assertions: the picker shows the notice in its
  main and list views and not in Chat features, with the split headings
  (inverting the views fails it); one "Use an API key" card, and none where
  the plan is not offered; OpenAI's dot from a signed-in plan only where it
  is offered; setup's OpenAI tab with and without the plan
  (`routes/-setup.test.ts`, with the plan card mocked).
- **P9-R1-F4: accepted.** Both sentences are corrected.
- Owner notes: the Recommended tag stays, as in the layout the owner picked;
  the split now waits for plan models; R3.7 is recorded in the Decision Log;
  setup's key description now matches the plan card's size; the repeated
  "API key" follows the owner's choice.

Repair check record (working tree on `06cfb7d1b`, tree `df6ebc2925f4` as the
reviewer computed it): from `src/frontend/web`, `pnpm exec vitest run` on
`src/routes/-setup.test.ts`, `src/ui/settings/models`,
`src/app/local-runtime/setup`, `src/lib/chat`, `src/ui/components` and
`src/ui/main/chat` → 48 files, 446 passed; from `src/frontend`, `pnpm check`,
`pnpm web:lint` and `pnpm prettier:check` passed; `check_source.py` passed.

#### Code Review #2 Findings

Targeted recheck by the same reviewer on tree `df6ebc2925f4`, which reran the
six touched test files (150 passed). Result: pass. All four repairs hold
(F1 for the hosted composition and for a local installation before a
sign-in), with no regressions. Non-blocking: the R3.7 sentence had been
added to the owner's Decision Log entry; it is the agent's reading and moves
to the agent entry.

#### Code Review #2 Revisions

- The R3.7 reading and the split rule are recorded as agent decisions for the
  owner to confirm; the As built note on `model-catalog.ts` points to
  P9-R1-F1.

Correction (2026-11-25): the repair record's `pnpm check` did not pass. Its
catalog sync would have removed `picker.apiKey` and `providers.chatgptPlan`,
because the F1 repair called them as `getFixedT(...)("key")`, which the
extractor does not see; a filtered log hid the failure. Both now go through a
`t` variable, and every check below is judged by its exit code.

Merge with `main` after #921 (first-run usability fixes, `db603bcfe`), as
`edad21ce0`: the setup step's imports and two new setup tests conflicted, and
both sides were kept (the plan's model choice beside #921's readiness check,
which counts a signed-in plan model as able to reply). The old key-saved
hook's type import went with the hook this branch replaced. Versions stay
`local-http` 25.0.0, `runtime-contracts` 0.25.0 and `product-ui` 0.22.0, one
step above `main`.

Check record after the merge and the extractor fix (from `src/frontend`, exit
codes): `pnpm check` 0; `pnpm web:lint` 0; from `web`, `pnpm prettier:check`
0 and `pnpm exec vitest run` on `src/routes/-setup.test.ts`,
`src/app/local-runtime/setup`, `src/ui/settings/models`, `src/lib/chat`,
`src/ui/components` and `src/ui/main/chat` 0 (49 files, 468 passed);
`check_source.py` 0.

Full pre-push suite on `fd4f13803` (tree `99c86dd964cc`), through the heavy
slot:

| Command | Result |
| --- | --- |
| `make check-test` | 6024 passed, 30 skipped |
| From `src/frontend`: `pnpm verify`, `pnpm prettier:check`, `pnpm desktop:test` | Passed |
| `pnpm web:test:browser` in the worktree | 141 of 141 |
| `pnpm e2e:test:fast` on a disposable built stack (`./reset.sh --purge --name chatgpt-plan-e2e --base-port 9300`, deterministic models, stopped afterwards) | 39 passed, 1 failed: the imported-playback journey's Library "new Reaction" hand-off did not navigate within 10 s; rerun alone on the same stack, it passed |
| `build.py build` of `db603bcfe` (new `main`, temporary detached worktree) and of `fd4f13803`, then `build.py compare` | "Compatibility policy passed" |

## Final integration review

One review of the combined change against the spec's acceptance criteria,
covering Phase 8 and reusing phase evidence. After its repairs and the
owner's agreement (G3), the full pre-push suite runs once on the final
candidate through the heavy slot: `python3 scripts/heavy-slot.py -- make
check-test`; from `src/frontend`, `python3 ../../scripts/heavy-slot.py --
pnpm verify`, `pnpm web:test:browser`, `pnpm prettier:check` and
`pnpm desktop:test`; `pnpm e2e:test:fast` against a disposable built
stack; and the package-set `compare` deferred by Phases 2, 5 and 6
(`scripts/package-sets/build.py build` of the merge base and of the
candidate, then `build.py compare` of the two), which `pnpm verify` does not
run. Results go in the pull request.

### Final Integration Review #1 Findings

Reviewed `daf1ead67` (tree `15746e0af0e6`) against `c7b98f73a` at the high
risk tier, by an independent read-only reviewer. Result: blocked on three
Required findings. Every acceptance criterion was met in code and tests or
waits only for G1, G2 or G3, except criterion 2 (FI-R1-F2). Sign-in through
chat, roles and the Memory Manager, sign-out, a different account, moving
between key and plan models, a usage limit and its clearing, and the hosted
composition were traced end to end without other defects; T1 to T8 hold.

- **FI-R1-F1 (Required).** The Plans facts row names the trial account's
  ChatGPT tier, in a record meant to become public.
- **FI-R1-F2 (Required).** No test shows acceptance criterion 2 for database
  rows or the stream of a successful plan turn: nothing scans the catalog,
  chat or Memory Manager rows (the paused agent state included) or a plan
  turn's events for the token. Reading the code found no leak path.
- **FI-R1-F3 (Required).** The package-set `compare` that Phases 2, 5 and 6
  deferred to the final candidate is missing from the suite above, and
  `pnpm verify` does not run it.
- **FI-R1-F4 (Optional).** ADR 0038's Context and the docstrings of
  `routes.py` and `chatgpt_plan_agents.py` credit the Phase 0 trial with
  refusals it did not show: it found output limits accepted and compaction
  admitted, and did not try `previous_response_id` or moderation.
- **FI-R1-F5 (Optional).** `development.md` says a session file that cannot
  be read is removed; a file the server cannot open is kept and reported
  temporarily unavailable.
- **FI-R1-F6 (Optional).** The glossary and ADR decision 5 say plan rows are
  active only while signed in; they stay active when OpenAI ends the session
  or a new sign-in has no plan use, and only sign-out retires them.
- **FI-R1-F7 (Optional).** Rejecting a change while the plan cannot serve
  still ends the review with "the model is no longer available", and the
  failed run counts toward automatic processing's failure pause.
- **FI-R1-F8 (Optional).** No check record covers `a4c169151`, and Phase 8's
  names no tree. The reviewer reran the plan background and Memory Manager
  tests (127 passed), `check_source.py` and the link check on
  `15746e0af0e6`.
- **FI-R1-F9 (Optional).** `ChatGPTPlanAgentsClient` keeps a leftover
  `self._token` that only `_create` uses.

### Final Integration Review #1 Revisions

- **FI-R1-F1: rejected.** The owner asked for this line on 2026-11-24 and
  approved its wording, which gives the tier as the account holder stated it
  and names no person. No other record names an account's tier.
- **FI-R1-F2: accepted.** New tests: a plan turn through `chat:sse` with the
  real plan client, on success and on a refusal whose `detail` carries the
  token, reaches the route with the token while the stream and the logs
  carry none (`test_chatgpt_plan_client.py`); after a sign-in, a refresh and
  the catalog's half of sign-out (`withdraw`), no access, refresh or ID token
  is in a model or connection row (`test_chatgpt_plan_models.py`); a plan run
  paused on an approval leaves no token in its run (the serialized agent
  state included), message or approval rows
  (`test_chatgpt_plan_background.py`). The chat-row part was added in repair
  round 2 (FI-R2-F1). Diagnostics and browser storage are out of reach
  by construction: no response schema has a token field, and
  `lib/diagnostics/summary.ts` reads no model state.
- **FI-R1-F3: accepted.** The `compare` is in the final suite above.
- **FI-R1-F4: accepted.** The ADR and both docstrings say the route's
  refusals are documented by OpenAI and that the trial confirmed system-role
  items, `apply_patch`, embeddings and moderations.
- **FI-R1-F5: accepted.** `development.md` says which files are removed and
  that an unopenable one is kept while the plan reports itself temporarily
  unavailable.
- **FI-R1-F6: accepted** as a wording fix: the rows are retired at sign-out;
  while a new sign-in is needed or plan use is off they stay listed and
  requests on them fail with that reason. Retiring them on those paths would
  hide an Anima's chosen model while the person can still recover it.
- **FI-R1-F7: accepted.** `_apply_decision` returns the error the plan
  raised instead of discarding it, and the rejected review's result carries
  its reason ("The review ended after your rejection: Sign in with ChatGPT
  again…"). The run still ends failed, as it does for any provider that
  cannot resume; the new background test asserts the reason.
- **FI-R1-F8: accepted.** The reviewer's reruns are recorded above and on
  Phase 8; the repair check record below covers `a4c169151`'s files again.
- **FI-R1-F9: accepted.** The token is a local of `_create`; no instance
  field holds it.

Repair check record (2026-11-24, working tree on `daf1ead67`, tree
`db0e94eb5a0e` before this record was added; all from the worktree root):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff check` and `ruff format --check` on `src/backend` and the three changed test files | Passed; 610 files formatted |
| `uv run --no-sync mypy` on `memory_manager_service.py`, `adapters/memory_manager` and `adapters/model_clients/openai_responses` | No issues in 21 files |
| `timeout 900 python3 scripts/heavy-slot.py -- uv run --no-sync pytest -q -p no:cacheprovider` on `test_chatgpt_plan_background.py`, `test_chatgpt_plan_client.py`, `test_chatgpt_plan_models.py`, `test_memory_manager.py`, `test_anthropic_memory_manager.py` and `test_anima_chat_sse.py` | 289 passed |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |
| Every relative link and anchor added to Markdown since `c7b98f73a`, working tree included | All resolve |

Not run: the full pre-push suite and the package-set `compare` (G3).

### Final Integration Review #2 Findings

Targeted recheck of the repairs on working tree `c33f05fa4f67` (on
`daf1ead67`) at the high risk tier, by an independent read-only reviewer
who reran the affected tests (289 passed), mypy on the touched modules and
the three changed test files, ruff and `check_source.py`, and probed the new
tests. FI-R1-F1's rejection is recorded with its reason; FI-R1-F3 and F5 to
F9 are resolved without regressions, including both callers of
`_apply_decision` and the 401 renewal with a local token. Result: blocked on
one Required finding.

- **FI-R2-F1 (Required).** The Revisions claimed the stream test covers chat
  rows, but the persisted assistant message carries the provider metadata
  the stream never shows, and no test inspects the recorded turn.
- **FI-R2-F2 (Optional).** The ADR, `routes.py` and the Agents client still
  credit OpenAI's documentation with refusing server compaction; the
  documented list omits it, the trial found it admitted, and leaving it out
  is the app's own choice. `prompt_cache_options` is not on the documented
  list either.
- **FI-R2-F3 (Optional).** Two Revisions overstated: the models test runs
  the catalog's `withdraw`, not a whole sign-out, and the Agents client's
  constructor never took a token.
- Non-blocking notes: a directory in the session file's place is not removed;
  the stream test's `"event:"` would pass on a failed success case; the
  refusal's JWT-shaped token is also caught by the generic sanitizer; no
  test pins which branch of the rejected-review message ran.

### Final Integration Review #2 Revisions

- **FI-R2-F1: accepted.** The plan turn test passes a recording chat manager
  and asserts that the success case records one turn and that no recorded
  turn, on success or refusal, carries a token. It now also requires
  `user.response` on success and an `error` event on the refusal.
- **FI-R2-F2: accepted.** The ADR, `routes.py` and the Agents client's
  docstring separate what OpenAI documents from what the trial found, and
  say compaction stays off the route because it was admitted but not shown
  to work; `prompt_cache_options` is described as kept off with the
  documented-refused cache retention.
- **FI-R2-F3: accepted.** Both Revisions are corrected above.
- Non-blocking: `development.md` now says the file or link is removed. The
  other notes are left: the generic sanitizer and `_without_token` both
  redact, and the outcome is what acceptance asks for.

Repair round 2 check record (2026-11-24, from the worktree root, working
tree `0143c8225ec2` before this record was added):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff check` and `ruff format --check` on `src/backend` and the three changed test files | Passed; 610 files formatted |
| `uv run --no-sync mypy` on the touched modules and the three changed test files | No issues in 24 files |
| The same pytest command as round 1, through the heavy slot | 289 passed |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |
| Every relative link and anchor added to Markdown since `c7b98f73a` | All resolve |

Not run: the full pre-push suite and the package-set `compare` (G3).

### Final Integration Review #3 Findings

Final targeted recheck of repair round 2 on working tree `cf5a45134b54`, by
the same independent reviewer, who reran the affected tests (289 passed),
mypy on 24 files and ruff, and confirmed with a mutation probe that a token
in a recorded turn now fails the plan turn test while the stream-only
version passed. FI-R2-F1 to F3 and the `development.md` note are resolved
with no regressions, and the added text meets the public-record constraints.
Result: pass.

- **FI-R3-F1 (Optional).** The Agents client's docstring said
  `context_management` stays off because the app compacts plan runs itself;
  nothing compacts Memory Manager runs.

### Final Integration Review #3 Revisions

- **FI-R3-F1: accepted.** The docstring gives only the trial's reason. A
  wording change in a docstring, verified by the coordinator with
  `ruff check` and `ruff format --check` on the file.

### Full pre-push suite (G3)

The owner agreed to the run on 2026-11-24. Heavy jobs ran through the heavy
slot from the worktree; the venv was synced first with the pinned Python and
extras.

First run, on `ef38cd701` (tree `0aa8ebdc224d`):

| Command | Result |
| --- | --- |
| `make check-test` | 5875 passed, 30 skipped, 2 failed: both repository boundary tests (below) |
| From `src/frontend`: `pnpm verify` | Passed |
| `pnpm web:test:browser` | 139 of 140; the animation combination page measured 1.166× real time against a 1.15 limit |
| `pnpm prettier:check`, `pnpm desktop:test` | Passed |
| `ANIMAMA_LLM_SKIP=1 ANIMAMA_WEB_BUILD_MODE=production ./reset.sh --purge --name chatgpt-plan --base-port 9100`, then `pnpm e2e:test:fast` | 38 passed, 2 failed: "avatar creator discard new draft before Library Edit" (the Library Edit stall) and "vfx guides preserve authored JSON with replacement artwork and animation" (no playback observation within 10 s) |
| `scripts/package-sets/build.py build` of `c7b98f73a` (from the primary checkout, which was on it) and of `ef38cd701`, then `build.py compare` | "Compatibility policy passed" |

The boundary tests caught what no phase's targeted runs covered: three
browser comments called OpenAI's page the "authorization URL", and the plan's
model and Memory Manager tests assert the bearer token each request to OpenAI
carries. `0f90c6d9b` rewords the comments and adds the three test files to
the guard's exemption for upstream credential tests, with its reason. The
coordinator checked each of the ten flagged test lines: every one asserts a
request to OpenAI's mocked route or an error body from it, and none calls a
local route.

Rerun, on `0f90c6d9b` (tree `1945d6b20d1e`):

| Command | Result |
| --- | --- |
| `make check-test` | 5877 passed, 30 skipped |
| `pnpm verify`, `pnpm prettier:check`, `pnpm desktop:test` | Passed |
| The two failed journeys alone (`pnpm e2e:test -- --project chromium --grep …`) on the same built stack | 4 passed. The stack was built from `ef38cd701`; `0f90c6d9b` changes only comments in web code and a backend test |
| `pnpm web:test:browser` in the worktree, twice | 139 of 140 each time: the same combination check, 1.157× and 1.166× |
| `pnpm web:test:browser` on a `git archive` export of `0f90c6d9b` with the worktree's `node_modules` linked | 140 of 140 |
| The same on an export of `c7b98f73a` | 140 of 140 |

The combination page check is not this change: the branch touches none of
the page's code, the test passed every time alone in the worktree (directly,
through `pnpm`, after a fresh package build and as a background job), both
exports passed it in a run of that file alone, and the exact candidate
passed the whole browser suite once exported. It fails only in this
worktree's full run, which points at local state in the checkout. The
package-set compare stands for `0f90c6d9b`, which changes no package source.
The task stack was stopped afterwards with its volumes kept; they hold only
test data.

### Merge with chat image input (#923)

Chat image input (#923) merged to `main` as `b62662036` on 2026-11-25, and the
owner asked for it to be combined into this pull request. `main` was merged
into the branch (an ordinary merge commit).

- **Conflicts.** The ADR index, `licenses/source-review.json`, the chat
  failure codes, the chat screen's imports and two generated client files.
  Each kept both sides; the licence file is the union of both entry sets in
  its own order and format, and the client was regenerated with
  `pnpm openapi-ts` from the merged backend rather than merged by hand.
- **ADR number.** #923 recorded ADR 0038 first, so this plan's ADR is now
  0039 (`docs/adr/0039-chatgpt-plan-sign-in-and-connection.md`); every link
  and its licence entry moved with it. Earlier records in this plan that say
  "ADR 0038" mean that ADR.
- **Versions.** Both changes had raised `local-http` to 24.0.0,
  `runtime-contracts` to 0.24.0 and `product-ui` to 0.21.0, which `main` now
  ships with #923's content. As the Contracts note planned, the second to
  merge takes the next: 25.0.0, 0.25.0 and 0.22.0, with the prose in
  `contracts/hosted-web.md`, `http-api.md` and `releases.md`.
- **Code that merged cleanly but meets.** #923's image parts pass through the
  plan route's request adjustments unchanged, and explicit cache breakpoints
  still go only to the key connection. #923's classification of errors inside
  a stream runs before the plan client's hook, which still recognises plan
  codes by their `subscription_sharing_` prefix. Plan rows already take
  `accepts` from the listed `input_modalities`, so a plan model takes images
  where OpenAI lists them.
- **New test.** `test_a_plan_request_carries_chat_images_as_the_route_takes_them`:
  a real plan request with an image in an earlier turn and one in the current
  turn sends both as `input_image` data URLs, replays the history with no
  cursor, and carries no `prompt_cache_breakpoint`.
  `model-client-providers.md` says plan requests replay the kept images.

Targeted check record (2026-11-25, from the worktree root, on the resolved
merge before this record and one documentation sentence were added; the
merge commit `c5789c3de` has tree `7602e2c3a`):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff check`, `ruff format --check src/backend/animama tests` | Passed |
| `uv run --no-sync mypy src/backend/animama tests` | No issues |
| `pytest -n 2` on the plan client, background, models and API tests, `test_model_client_image_requests.py`, `test_anima_chat_sse.py`, `test_direct_chat_turn_executor.py`, the repository boundary tests, `test_model_call_boundary.py`, `test_model_client_registry.py`, `test_companion_safety_chat.py` and `test_turn_instruction_layout.py` | 566 passed |
| From `src/frontend`: `pnpm openapi-ts:check`, `pnpm check` | Passed |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |

Full pre-push suite on the combined candidate `c5789c3de` (tree `7602e2c3a`),
through the heavy slot:

| Command | Result |
| --- | --- |
| `make check-test` | 6020 passed, 30 skipped, 1 failed: `test_model_call_boundary.py::test_bounded_sdk_calls_do_not_retry_http_errors[responses]` saw no request |
| The same tests again (`pytest -n 2`, with a scratch plugin that only records that test's exception) | 6021 passed, 30 skipped |
| From `src/frontend`: `pnpm verify`, `pnpm prettier:check`, `pnpm desktop:test` | Passed |
| `pnpm web:test:browser` in the worktree | 140 of 140 |
| `pnpm e2e:test:fast` on a disposable built stack (`ANIMAMA_LLM_SKIP=1 ANIMAMA_WEB_BUILD_MODE=production ./reset.sh --name chatgpt-plan-e2e --base-port 9300`, stopped afterwards) | 40 passed |
| `build.py build` of `b62662036` (new `main`, from a temporary detached worktree, removed afterwards) and of `c5789c3de`, then `build.py compare` | "Compatibility policy passed" |

The one backend failure did not come back: the test passed alone, with its
file, after each plan and image test file, and in the full rerun, where the
recorder caught only the expected 429 after one request. It never failed
before the merge. It is recorded as an intermittent failure whose cause was
not found.

#### Merge Review #1 Findings

An independent read-only review of the merge at the high risk tier
(resolutions, integration points, versions, the ADR move, the new test, the
added prose) passed with no Required findings. It checked the licence union,
locale key parity and the generated name sets with scripts, drove plan
errors inside a stream through the real client, and mutated the new test
four ways (each failed). Optional findings:

- **MR-R1-F1.** No test pins a plan usage limit reported inside the stream,
  where #923's classification and the plan hook meet.
- **MR-R1-F2.** The trial sent no `detail` and never replayed images; add an
  image turn and a replay to the owner's live check.
- **MR-R1-F3.** The check record lacked its tree; the combined candidate
  needs a compare against `b62662036` and `pnpm web:test`.
- **MR-R1-F4.** `model-client-providers.md` says an in-stream error is never
  retried; the plan client retries a temporary plan code before any output.
- **MR-R1-F5.** The merge record and the caching evidence sat above "Gates"
  with no heading of their own, so the gates read as part of the merge.

#### Merge Review #1 Revisions

- **MR-R1-F1: accepted.**
  `test_a_usage_limit_inside_the_stream_pauses_background_use` covers a
  `response.failed` before and after text and an `error` event: each becomes
  `chatgpt_plan_usage_limit`, pauses background use, sends one request and
  keeps the token out. With the plan hook made a no-op, all three fail.
- **MR-R1-F2: accepted.** G1 lists an image turn on a plan model and a
  follow-up turn that replays it.
- **MR-R1-F3: accepted.** The trees are recorded above; the compare ran
  against `b62662036`, and `pnpm verify` runs `pnpm web:test`.
- **MR-R1-F4: accepted.** The sentence names the plan client's exception.
- **MR-R1-F5: accepted.** The caching evidence and the gates have their own
  headings.

Follow-up check record: see "Final state" under Outcomes & Retrospective.

### Prompt caching on the plan route

Evidence from 2026-11-25. The owner's
first chat turns on the restarted task stack logged each request's usage: a
key turn on `gpt-6-luna` read 15,217 input tokens with none cached, and the
next turn, on a plan model, read 14,809 with 4,096 cached. The plan route
therefore applies OpenAI's prefix caching to `store: false` requests that
replay their history; plan requests rely on its implicit writes and send
`prompt_cache_key`. How cached tokens count against a plan's allowance is not
documented. OpenAI's conversation-state guide says a key chain's earlier input
is billed as input even with `previous_response_id`, so replaying it is not
extra model work.

### Gates

- **G0.** Owner review of this plan, including D1 to D14.
- **G1.** A live account. Phase 0 and the manual checks in Phases 4 to 7 need
  an eligible ChatGPT plan and the account holder signing in themself in
  their own browser. The agent never handles the password. Plan usage is
  bounded: at most 25 small requests in Phase 0 and 10 turns in each later
  phase. Since chat image input merged, it includes one turn with an image on
  a plan model and a follow-up turn that replays it (MR-R1-F2).
- **G2.** Desktop check on a packaged development build with a fresh profile:
  sign in, restart, chat on a plan model, sign out, then scan the profile's
  logs and files for token and code values. The agent drives the app only
  after the owner's go-ahead; otherwise the owner performs it. This is also
  where a missing module in the frozen runtime would show.
- **G3.** Owner agreement to the full pre-push run.
- **G4.** Owner checks: the button's branding (the logo asset and its terms
  under OpenAI's guidelines, or a text-only button), and whether the app's
  privacy notice covers plan use (spec check C4).

Hosted validation stays off unless the owner starts a run; the pull request
states which evidence is local.

Outside this repository: at its next repin, Animama Cloud admits the new
`local-http` major and keeps `chatgpt_plan` false. No Cloud work is part of
this plan.

## Validation and acceptance

Each spec acceptance criterion and the evidence planned for it:

| Criterion | Evidence |
| --- | --- |
| Sign-in on desktop and a same-machine stack; stays signed in; sign-out | Phase 1 and 2 tests; Phase 4 manual check; G2 |
| Tokens in no row, log, event, diagnostics, browser storage or URL | T3 tests in Phases 1, 2 and 5; G2 scan |
| The request built for a plan model | Phase 5 request test; Phase 7 capture test |
| A real plan model: streaming, a memory tool, a title; background work only after agreement | Phase 6 and 7 manual checks (G1) |
| The indicator shows on plan models only | Phase 6 composer test |
| Declined or ineligible sign-in, a limit, and no automatic switch | Phase 1, 5 and 7 tests with simulated errors |
| No plan model for Embeddings; speech unchanged | Phase 7 role tests |
| A chat continues across key and plan models | Phase 6 tests and manual check |
| Hosted exposes neither routes nor interface | Phase 2 inventory, capability and hosted-composition tests |
| Suites and documentation | Final suite (G3); Phase 8 |

## Idempotence and recovery

- No schema migration is planned. If a phase finds one is needed, it is a new
  Alembic revision with the ORM change (ADR 0035), and the owner is told.
- The seed change is repeatable, and account-listed rows are derived: a
  sign-in rebuilds them.
- The session is one directory under the data root. Deleting it signs out;
  signing in again reuses nothing that must survive.
- A sign-in attempt can be cancelled or left to expire. A failed or
  interrupted refresh keeps the previous token set.
- Every phase is a commit on the task branch and can be reverted alone in
  reverse order. Reverting Phase 5 or later after Animas chose plan models
  leaves those rows in the database; they become inactive, and each Anima
  needs another model.
- The task stack holds only test chats and can be removed with its volumes.
  The probe's credential file is removed after `sign-out`.

## Outcomes & Retrospective

### Final state

Pull request #924 delivers Phases 0 to 8 combined with chat image input
(#923). Code was last changed in `7c715bd9a` (tree `daca88769`); later commits
change only this plan's records. Its check record, from the worktree root
through the heavy slot:

| Command | Result |
| --- | --- |
| `make check-test` | 6024 passed, 30 skipped |
| The new in-stream test with the plan hook made a no-op (scratch plugin) | 3 failed, as intended |
| Every relative link and anchor added to Markdown since `c7b98f73a` | All resolve |

`7c715bd9a` changes only a backend test, one documentation sentence and these
records after `c5789c3de`, so that commit's frontend, browser, journey and
package-set results above stand for it.

#924 merged as `8fda2eed2` (2026-11-25). Owner checks without a record here:
G1 (with the image turn) and G4.

#### G2: packaged desktop check

Passed on 2026-11-25, with the owner signing in in their own browser. The
package was built from `8fda2eed2` with `pnpm desktop:mac:build` through the
heavy slot (stage, audit, package; runtime inventory OK). It ran as the
release smoke's kind of copy, with Node's inspect fuse on and an ad-hoc
signature, so that `ANIMAMA_DESKTOP_DEV_USER_DATA` could select a new profile.
Run the copy's executable with that variable in its environment: launched
through `open --env`, the copy did not receive it and opened the default
profile, and was quit before it reached the database, vault or logs.

| Step | Result |
| --- | --- |
| Start | No import error in the startup log, and the FastAPI child received the store key. The frozen archive holds `jwt` (with `jwt.jwks_client` and `jwt.api_jwt`) and `cryptography`'s AEAD module. |
| Sign-in with plan use on | Completed. `session.bin` was 4,037 bytes, mode 0600 in a 0700 directory: version byte `0x01`, then ciphertext with no JWT, token name or JSON text. |
| Quit and restart | The session decrypted at start, and the chat after it used the plan. |
| Chat on a plan model | One turn on `ChatGPTPlanResponsesHTTPAgent`, which wrote its episode log. The model called no tool. |
| Sign-out | The app reported "Signed out of ChatGPT", so OpenAI confirmed the revoke. `session.bin` fell to 169 bytes (140 of plaintext), room for the registration only. Roles left on plan models waited. |
| Scan | No match. |

The scan read every file in the profile (2,081 files, 374 MB: the logs,
vault, session file, PostgreSQL data and WAL, and Chromium's Local Storage,
Session Storage, HTTP cache, Code Cache, cookies and GPU caches), the app's
standard output, a `pg_dump` of each database, and the two things the copy
wrote outside the profile: its preferences file and a Metal shader cache. It
searched raw bytes, UTF-16 text, reassembled LevelDB logs and gzip members
for JWTs and `eyJ` fragments; the names `access_token`, `refresh_token`,
`id_token`, `id_token_hint`, `code_verifier` and `code_challenge`; `code=`
and `state=` query values; `/auth/callback` and authorize URLs with a query;
`Bearer` values; and the store key's variable name. No IndexedDB store or
crash report was created.

The HTTP cache keeps the latest `GET /v1/chatgpt-plan` response, because that
route sends no `Cache-Control: no-store`. While signed in, that response
carries the account's email, never a token. After sign-out the cached copy
has no email.

### Retrospective

- Targeted per-phase test runs never reached the repository boundary tests;
  the first full suite found two violations. A plan that adds browser code or
  credential tests should run `tests/test_accountless_repository_boundaries.py`
  with each phase.
- Two plans in flight at once both took ADR 0038 and the same contract and
  package versions. The Contracts note anticipated the versions; ADR numbers
  need the same rule: whichever merges second renumbers.
