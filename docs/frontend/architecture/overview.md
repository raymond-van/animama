# Frontend Architecture Overview

This document is the entry point for the current `src/frontend` workspace.
The frontend contains the browser app in `web/`, reusable packages and the
Electron shell in `desktop/`. FastAPI serves the production React build.

## Runtime Shape

Core packages:

- `web/`: Vite + React + TanStack Router browser frontend.
- `desktop/`: Electron windows, the embedded macOS service supervisor, encrypted
  credential vault, and guarded preload bridge. `desktop:dev` may still use the
  external local stack; packaged builds require an audited embedded runtime.
- `shared/`: serializable desktop runtime/credential contracts without Electron
  imports. See [Desktop overview](../desktop/overview.md) for lifecycle and the
  current packaged-validation gate.

The local React composition is accountless. FastAPI prepares the installation
at process startup; React reads its bounded runtime context at the application origin and
requests bootstrap only if the backend reports a repair is needed. It then
supplies the generated principal to shared features through a neutral owner
context. The generated client and protected-byte loaders use the application origin
without browser bearer tokens.

## Web Source Map

Main browser code lives under `src/frontend/web/src`:

- `routes/`: TanStack Router file routes and route guards.
- `app/`: shared router/providers, local and hosted admission adapters, explicit
  owner/transport contexts and session-owned query clients.
- `ui/`: feature UI, shell layout, sidebar, chat, canvas, settings and debug surfaces.
- `query/`: TanStack Query keys, options, read hooks, and mutations.
- Generated OpenAPI methods and types live in the sibling
  `packages/runtime-contracts` package, not in the web source tree.
- `hooks/`: orchestration hooks for dictation, TTS, user-file uploads,
  websocket, fullscreen, PiP, sound, and VRM editor sessions.
- `stores/`: Zustand runtime state for avatar, scene VFX, voice debug, and
  related browser state.
- `lib/`: browser runtime modules for API client wiring, avatar engine, speech,
  voice, sound, settings, telemetry, and shared utilities.
- `workers/`: browser workers for smart-turn, viseme processing, and
  incremental content hashing.
- `platform/`: Vite/browser platform adapters such as env and image rendering.

Browser-engine assets use the verified inputs described in
[Content and workers](content-and-workers.md). Typed product content lives under
`content/included` and `content/local` and is delivered through FastAPI.

## Route And Provider Flow

Global startup:

- `src/frontend/web/src/main.local.tsx` mounts the local React composition.
- `src/frontend/web/src/main.hosted.tsx` installs hosted cookie/CSRF transport
  and mounts the same application. `pnpm web:build:hosted` emits `web/dist-hosted`;
  `pnpm build` retains the local build. Neither uses a runtime product-mode flag.
- `src/frontend/web/src/app/providers/AppProviders.tsx` wraps theme, admission,
  session-owned TanStack Query, explicit product runtime and toaster providers.
- `src/frontend/web/src/app/local-runtime/local-composition.ts` reads installation
  readiness through the local API adapter and repairs only reported bootstrap.
  `RuntimeController` supplies common admission states; `RuntimeOwnerContext`
  exposes the admitted principal and explicit client to shared features.
- `src/frontend/web/src/app/router.tsx` creates a composition-owned TanStack
  Router and gates private routes on admitted readiness.
- `src/frontend/web/src/routes/__root.tsx` owns root document head, scroll
  restoration, scripts, and not-found rendering.

Theme mode (System, Light or Dark) and per-mode colour overrides are chosen in
App Settings → Appearance. `web/src/ui/theme/theme-provider.tsx` applies a
`light`/`dark` root class through next-themes and defaults to light.
`SettingsProvider` synchronizes the mode with `user_settings.theme`
(`system|light|dark`; retired `custom`/`anima` values read as light) and applies
colour overrides from `preferences.appearance.{light,dark}` as a generated
stylesheet. `APPEARANCE_COLOR_TOKENS` in `web/src/lib/theme/appearance-overrides.ts`
lists each overridable token (Primary, Secondary, Accent, Background,
Foreground, plus Advanced surfaces, lines, status, sidebar and chart colours),
the variables it sets and its derived text colours. Style
new surfaces with theme tokens rather than fixed colours so both modes and
overrides stay legible.

See [Routing](routing.md) for route ownership and navigation rules, and
[Local profile](../features/user-profiles.md) for setup and launch selection.
App Settings opens over the active route without remounting the chat runtime.

## Data And Runtime Flow

- Generated SDK methods come from `@animama/runtime-contracts/sdk`; their
  generated source lives under `src/frontend/packages/runtime-contracts/src/generated`.
- Browser flags come from `src/frontend/web/src/platform/env.ts`.
- API requests use the admitted session's client from `useProductApiClient()`,
  built on the entrypoint's same-origin transport; there is no global default
  client. The local request interceptor adds only the CSRF marker to mutating
  `/v1` requests.
- TanStack Query state uses `src/frontend/web/src/query/keys.ts` and the hooks
  under `query/hooks` and `query/mutations`.
- Runtime-local state that is not server state lives in Zustand stores under
  `src/frontend/web/src/stores`.

Chat flow:

1. `ChatInterface` owns text input, dictation integration, and submit/stop UI.
2. `@animama/product-ui/chat` owns the existing `useProductChatSession` state,
   optimistic messages, `chat:sse`, revision fences, and cache reconciliation.
   Local `useChatSession` supplies settings, mounted-content readiness, TTS and
   avatar effects through typed adapters.
3. The package owns `useChatSse`, shared Anima selection, `ChatConversation`, and
   composer primitives. Local route links, file/model/microphone controls, and
   desktop shell placement compose those same shared views.
4. Avatar, lip-sync, emotion, and voice updates flow through stores and runtime
   hooks before reaching `AvatarCanvasActor`.

User-file upload flow:

1. Chat composer and Library's Chat Uploads management panel create a scoped
   Uppy instance through `useUserFileUpload`.
2. Uppy calls generated API mutations to initialize an admitted local
   upload, PUTs bytes through FastAPI, finalizes the atomically promoted file,
   and usually enqueues processing.
3. `useUserFiles` lists current-user files and polls while uploads or processing
   jobs are active.
4. Library's Chat Uploads management remains available in production; keyword,
   semantic, and hybrid retrieval inspectors load only with development debug
   opt-in. Chat attachments send only backend-owned file IDs to `chat:sse`;
   original bytes stay beneath the private `data/user-files` root.

## Production Loading

`platform/env.ts` exposes one effective `DEBUG_ENABLED` flag. It requires an
actual Vite development server and explicit `VITE_ENABLE_DEBUG_PANEL=true`
(or `1`). All builds, including `embedded-desktop`, exclude the inspector
imports even when that input is inherited as true. The literal
`__ANIMAMA_DEV_BUILD__` guard at dynamic-import sites lets the bundler remove
unreachable debug chunks; a cross-module flag alone is insufficient. Production
registers no avatar inspector targets, face/spring-bone helpers, animation
snapshot polling, lip-sync audio capture, or voice diagnostic recording. Development debug dialogs
load when opened, and inspector state does not remount the avatar. Health,
bounded errors, recovery, browser DevTools, and the operator `dev-tools` profile
are unaffected.

Vite emits `.vite/manifest.json` as a server-side build inventory. FastAPI
uses it to grant one-year immutable caching only to successful fingerprinted
JS/CSS. HTML revalidates and missing chunks remain 404. A failed route offers
an explicit **Reload page** action, with an unsaved-changes warning and no
automatic reload. The app handles Vite preload errors before the router's
built-in refresh attempt. See [Local HTTP boundary](auth-server.md).

An ordinary new tab may show cached HAR rows while transferring no app JS/CSS.
DevTools **Disable cache** and hard reload are different experiments. Private
content still revalidates ownership; the runtime manifest uses scoped gzip
while issuing a fresh lease. Do not compare total row counts as if each row
were a download. Evaluate startup changes using transferred bytes and first-frame timings
with the same cache conditions, content and optional packs.

## HTTP Serving

FastAPI's local boundary lives in `src/backend/animama/local/http`, composed by
`src/backend/animama/server/local_http.py`. It owns admission, installation
principal resolution, static/model responses, telemetry and desktop quiescence.
Vite owns development serving and a closed proxy to the private backend;
production has no frontend Node service. Browser modules import neither backend
configuration nor Electron internals.

The browser retains metric calls and API trace propagation but registers no
telemetry exporter. The FastAPI forwarder is disabled by default in Compose
and always disabled in embedded desktop. See [Local HTTP boundary](auth-server.md).

## Commands

Run from `src/frontend`:

- `pnpm web:dev`
- `pnpm web:check`
- `pnpm check`
- `pnpm web:lint`
- `pnpm web:test`
- `pnpm web:build`
- `pnpm verify:tts-assets`
- `pnpm openapi-ts`

`pnpm openapi-ts` exports the local FastAPI schema offline to a temporary file,
generates the client, and removes the temporary schema. Client generation never
requires a running stack or exposes FastAPI documentation over HTTP.

### Local Docker Dependency Cache

The Compose `web` service keeps its Linux `node_modules` trees and pnpm store
in stack-scoped named volumes. Normal `./reset.sh` preserves both these caches
and application data, and the startup `pnpm install` reconciles
them with the current lockfile. Normal source edits and dependency updates do
not require rebuilding the Node image; remove the frontend dependency volumes
only when intentionally troubleshooting a corrupted or platform-incompatible
install.

## Where To Edit

- Add or change routes in `src/frontend/web/src/routes`.
- Add route-independent feature UI in `src/frontend/web/src/ui`.
- Add API reads/mutations in `src/frontend/web/src/query`.
- Change generated API contract only by updating backend OpenAPI output and
  rerunning `pnpm openapi-ts`.
- Change memory-entry and user-file upload UI through
  `src/frontend/web/src/ui/memory`, `src/frontend/web/src/hooks/useUserFileUpload.ts`,
  and the chat-input upload button.
- Change avatar/speech/chat runtime carefully; see the runtime docs in
  `docs/frontend/runtime`.
