# Local HTTP components

The components in `animama.local.http` provide the desktop and self-host HTTP
boundary. `create_local_app` installs them once around the existing product
routers. FastAPI serves built React files in desktop and built Compose;
development Vite proxies a closed set of application routes to private FastAPI.
The same components can be composed around isolated acceptance fixtures.

## Composition and ownership

`install_local_http(application, config, lifecycle=..., assets=...,
telemetry=...)` installs middleware and a principal resolver on a supplied
FastAPI application after its product routers have been registered. It does
not construct a second product runtime, read environment variables, bootstrap
a database or discover an owner. Construct it once, before ASGI startup.

The owner of installation bootstrap calls `lifecycle.mark_ready(principal_id)`
only after initialization succeeds. Until then, product requests receive 503.
Admission places an object-identity marker in server-owned ASGI state; the
resolver supplies the existing `RequestPrincipal` only for marked requests.
Browser headers, cookies and old gateway assertions never choose the owner.
Existing shared router dependencies and owner filters remain unchanged.

| Component | Responsibility |
| --- | --- |
| `config.py` | Immutable public origin, optional distinct desktop credentials, finite input limits, the optional sign-in return path and its derived authority. |
| `admission.py` | Host/Origin/Fetch Metadata checks, capability and CSRF validation, the sign-in return rule, HTTP receive limits, request accounting, receive-idle WebSocket cleanup. |
| `lifecycle.py` | One completed bootstrap identity, admitted principal resolution, active-work drain without in-process resume. |
| `assets.py` | Audited build files and speech-to-text mounts (Parakeet and SenseVoice) resolved per request from installed model-asset sets; no private catalog lookup. |
| `telemetry.py` | Optional fixed-destination OTLP forwarding with bounded input, output and deadlines. |
| `protocol.py` | A narrow Uvicorn h11 hook adding the incomplete-header deadline. |
| `composition.py` | Wiring, hidden infrastructure routes, preserved application lifespan and telemetry cleanup. |
| `server.py` | Shared native, frozen and container Uvicorn launch configuration. |

For an acceptance fixture, construct `FastAPI()`, register its test/product
routers, then install `LocalHTTPConfig(public_origin="http://127.0.0.1:PORT")`
with the actual bound port. Supply a `LocalHTTPLifecycle` and mark it ready
from fixture bootstrap. Real transport tests explicitly use:

```python
uvicorn.Config(
    application,
    http=LocalH11Protocol,
    ws="websockets",
    proxy_headers=False,
    timeout_keep_alive=5,
    timeout_graceful_shutdown=15,
)
```

Acceptance servers bind their own ephemeral loopback sockets. Product launchers
use `local.http.server.serve` with this same transport configuration. The native
entrypoint binds loopback (default port 8000); the Compose entrypoint binds
container port 8000. The frozen `serve --port` command uses the supervisor's
saved loopback application port. Public network exposure belongs to the
selected Compose graph or an operator-owned TLS/authentication boundary.

`server/local_http.py` translates trusted settings into these immutable inputs.
`ANIMAMA_PUBLIC_ORIGIN` is the exact browser origin, including a non-default
port. `ANIMAMA_WEB_ROOT` supplies the absolute React build root; unset or blank
means Vite owns frontend assets. Desktop requires both
`ANIMAMA_DESKTOP_RENDERER_CAPABILITY` and `ANIMAMA_DESKTOP_CONTROL_TOKEN`.
The frozen launcher also requires the web root and owned process start token,
and checks that the public origin matches its actual loopback listener.
`ANIMAMA_PARAKEET_SOURCE` selects where both speech-to-text engines' sets come
from: `asset-store` (the default) serves sets installed in the application's
model-asset store, resolved on each request; `operator` (development Compose)
serves none, because Vite serves the host sets.

## Request admission

Only the configured Host (including its non-default port) is admitted.
Forwarding headers cannot replace it. A present Origin must equal the exact
configured browser origin; null/foreign origins are rejected. Fetch Metadata
may be absent, `same-origin` or `none`; an explicit composition option permits
`same-site` without relaxing Origin. Duplicate authority/security headers fail
closed. This is single-owner local admission, not remote-user authentication.

Mutating `/v1` requests require `X-Animama-CSRF: 1` and matching Origin plus
`Sec-Fetch-Site: same-origin`. The explicitly allowed same-site case also
requires matching Origin. An Origin-less operator mutation is accepted only
outside desktop composition with `Sec-Fetch-Site: none` and the CSRF marker.

Supervised desktop additionally requires the launch-specific
`animama_renderer_capability` cookie. Missing, stale, wrong and duplicate
capabilities fail. An Origin-less safe desktop request must carry `none` or
`same-origin` Fetch Metadata; desktop mutations always require Origin. Cookies
are host-scoped, not port-scoped. This validator does not install cookies or
expose either desktop secret to a renderer.

One request is admitted without these browser checks: the system browser's
return from OpenAI's ChatGPT sign-in
([ADR 0039](../../adr/0039-chatgpt-plan-sign-in-and-connection.md)), a
cross-site navigation that carries neither the page's Host on a `localhost`
stack nor the desktop cookie. `server/local_http.py` sets
`LocalHTTPConfig.sign_in_return_path` to `/auth/callback`, and the config
derives the return's authority, `127.0.0.1:<port>` (bare `127.0.0.1` on port
80), only when the public origin is `http` on `localhost`, `127.0.0.1` or a
`*.localhost` name; any other origin has no return, and the app does not offer
sign-in there. A request is the return only when all of these hold:

- it is an HTTP `GET` of exactly that path (a WebSocket has no method);
- its `Host` equals the return authority;
- it has no `Origin`, no `Transfer-Encoding` and no body;
- a `Sec-Fetch-Mode` header, when present, is `navigate`, and a
  `Sec-Fetch-Dest` header, when present, is `document`.

Such a request skips the Host, Origin, Fetch Metadata and capability checks;
readiness still applies, and the route completes a sign-in only for the
pending attempt's `state`. A request that misses any
condition gets the normal checks. `/auth` paths never fall back to the SPA, and
the development Vite proxy forwards only `/auth/callback` under `/auth`.

The only admitted product WebSocket path is `/v1/logs`, with exact Origin and
the same capability policy. A bounded receive pump observes disconnect even
when the existing server-push log handler is waiting for its next log item.
It cancels that WebSocket handler and awaits its cleanup. Excess unread client
messages close the connection with policy code 1008; there is no general
WebSocket proxy or HMR endpoint here.

All `/_desktop` requests need the distinct `X-Animama-Desktop-Control` secret.
They remain usable before product readiness and during quiescence, but a
renderer capability alone never grants control access. A control request that
carries `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Dest` came from a browser
context and gets the same 404 as a wrong token. Electron main's Node `fetch`
sends none of them; it sends `Sec-Fetch-Mode: cors`, which is allowed. No
control response grants CORS. Self-host composition
denies this entire prefix and mounts no quiesce control. HTTP documentation,
OpenAPI and account-authentication paths are hidden; offline `application.openapi()` is
preserved. New infrastructure routes are excluded from the public schema.

## Input bounds and drain behavior

The transport ceiling is 128 MiB, including streamed requests without
Content-Length. Declared oversize is rejected before dispatch. The receive
wrapper rejects an over-limit chunk before multipart/application parsing sees
it, and enforces a 120-second total body-receipt deadline while receiving input.
A recorded transport failure cannot be translated into a successful response
by downstream exception handling. Limit failures close the connection;
request bodies are not buffered wholesale. Existing narrower package/parser
limits remain in their owning routes. Limit/timeout failures use Starlette's
multipart error protocol so partially opened upload spools are closed. An
incomplete multipart peer disconnect follows the same cleanup path, with the
bounded `request_disconnected` code if a response can still be sent.

`LocalH11Protocol` closes incomplete headers after an absolute 15 seconds;
trickled bytes do not restart the timer. It delegates parsing to Uvicorn and
observes parser state instead of copying the parser. Initial and pipelined
headers, transfer to WebSocket, disconnect and shutdown have transport tests.
The reviewed dependency is Uvicorn 0.38.0, recorded by a test tripwire. Revalidate
the hook against a dependency update. It does not add a connection-count cap.
Transport tests retain Uvicorn's bounded `websockets` implementation; switching
to another WebSocket transport requires its own resource-limit verification.
Five-second keepalive and 15-second graceful shutdown remain distinct from the
body/header deadlines; streamed SSE output has no such response deadline.

`POST /_desktop/runtime:quiesce` closes new product admission before waiting
up to 15 seconds for active work. Controls are excluded from that count.
Repeated calls are idempotent: 200 returns
`{"schema_version":1,"state":"quiesced"}`; a timeout returns 409 with
`{"detail":{"code":"runtime_busy"}}`. A timeout or cancelled control request
does not reopen admission or cancel active product work. Successful resumption
requires a fresh runtime with the unchanged configuration.

`PUT /_desktop/credentials` replaces the backend's
[runtime credentials](../runtime/model-client-providers.md#connections-and-credentials)
with Electron main's vault contents. The body must be `application/json`, at
most 512 KiB, exactly
`{"schema_version":1,"generation":N,"credentials":{name:value}}`, with no
duplicate keys. Names are limited to `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`ELEVENLABS_API_KEY`, `GEMINI_API_KEY` and `ANIMAMA_CONNECTION_<ID>_API_KEY` (at most 32), and values follow the vault
rules. Each connection key may arrive with `ANIMAMA_CONNECTION_<ID>_ORIGIN`, a
bare ASCII `scheme://host[:port]` (at most 32); one that matches no
connection's address leaves only its own key unused. Absent names are removed. Values never reach `os.environ`. A generation
at or below the current one is refused, so a delayed older push cannot
overwrite a newer one. Success returns `{"schema_version":1,"generation":N}`.
Refusals return only `{"detail":{"code":…}}`: `credentials_media_type` (415),
`credentials_too_large` (413), `credentials_invalid` (400) or
`credentials_generation_stale` (409). Admission refusals before the route
(404, 400, 421, and 413 for a declared oversize length) use `{"error":…}`. A
stalled body gets 408 `{"detail":{"code":"request_body_timeout"}}`. Clients
should classify refusals by status.
Validation is manual, not a Pydantic model, so no error echoes input, and the
route logs nothing about the body.

HTTP work remains counted until its handler, stream and cleanup finish, even
when a peer disconnects. Socket closure does not promise rollback of a durable
`LocalContentMutations` commit. Before a pack transition, Electron destroys
product windows, shows independent recovery, requests this drain, and refuses
pointer changes on `runtime_busy`. It resumes by restarting the owned runtime
and checking its private readiness before recreating product windows.

Admission failures use the compatibility code `gateway_request_rejected`
(400/401/403/421). Readiness/drain failures use `local_runtime_unavailable` or
`runtime_quiescing` (503); transport failures use `request_body_too_large` (413)
or `request_body_timeout` (408). Errors contain no credential, principal or path
detail and use `no-store`. Existing product errors are unchanged.

## Files and telemetry

`LocalAssets` accepts one build root and an optional `ModelMountSource` that
resolves the current `ModelMount` of `ModelFile` records on each request; with
`asset-store` it reads the backend's installed model-asset sets, which were
digest-verified before activation. Requests use directory-relative, no-follow
regular-file opens and stream the checked descriptor. Windows has no directory
descriptors, so there every folder is checked for a reparse point (symbolic link
or junction) before it is entered, the leaf is opened as itself rather than
through a link, and the opened file's resolved path must equal the requested
path. That last check also refuses a folder swapped after its check and an 8.3
short-name alias of a hidden folder. Model size/link checks do not replace that
digest verification. A different build requires a new
responder instance; installing or removing a set does not.

Missing API, script, model, private and reserved paths never become HTML. SPA
fallback requires navigation metadata or an HTML Accept header on an eligible
extensionless route. Hidden path segments, including `.vite`, are denied.
Only fingerprinted JS/CSS files explicitly named by the hidden Vite manifest
receive immutable application caching. HTML uses a byte-derived ETag;
unversioned assets require revalidation. MIME, HEAD and conditional responses
are preserved. Ordinary static files retain the full-200 response to Range.

Installed speech-to-text files are served only beneath
`/onnx/models/parakeet-tdt-0.6b-v2/`, `/onnx/models/parakeet-tdt-0.6b-v2-webgpu/`,
`/onnx/models/sensevoice-small/` and `/onnx/models/sensevoice-small-webgpu/`,
from the exact installed inventory. An optional `v` parameter must occur once
and match the installed set's manifest digest. Model
delivery preserves digest ETags, HEAD, single byte ranges, If-Range and 416;
versioned models retain their private immutable cache policy. Authorization
runs before any static/model conditional 304. Registered Local/Included bytes
remain in the existing owner-protected product handlers.

`TelemetryForwarder` is disabled by default, and always disabled on desktop.
The self-host settings adapter preserves the existing telemetry opt-out
environment variables and fixed OTLP collector destinations. Valid disabled
signals return 204 without reading a body or creating a collector client.
Enabled forwarding accepts only POST traces/metrics/logs, fixed composition
destinations, JSON/protobuf and identity/gzip metadata. It strips credentials,
rejects query-selected targets and redirects, and never passes collector error
bodies through. Defaults are 1 MiB raw request, 64 KiB raw collector response,
10 seconds total body receipt and 10 seconds total upstream send/drain.
Compressed bytes remain compressed. Application shutdown or failed startup
closes the client, including when the caller supplies a custom lifespan.

## Verification

From the repository root with installed frozen dependencies:

```bash
uv run --no-sync pytest -q tests/test_local_http_*.py
uv run --no-sync ruff check src/backend/animama/local/http tests/test_local_http_*.py
uv run --no-sync mypy --follow-imports=silent src/backend/animama/local/http
uv run --no-sync python scripts/repository-boundary/check-python-imports.py
```

The transport suite owns ephemeral loopback listeners and requires permission
to bind them. It uses no database or provider credentials. Other component
tests use temporary files and controlled collectors. The schema regression
test compares fresh offline schemas without bootstrapping the real app.
These checks do not establish packaged-desktop, Vite/Compose, native upgrade or
release acceptance. Those require their own built artifacts, selected stack
and owned-runtime evidence in addition to these component and wiring tests.
