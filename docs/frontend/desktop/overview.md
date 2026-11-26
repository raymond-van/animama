# Desktop App Overview

Animama Desktop runs the React app and its local services under Electron. The
desktop package owns native windows, service supervision, protected credentials,
preload IPC, permissions, and packaging. React still owns the product UI,
runtime-owner context, data fetching, avatar runtime, and settings. No local
account or hosted Animama account is needed to open the app.

The runtime includes optional packs, guarded application updates, upgrade
snapshot retention and signing tools. Release acceptance remains pending for
fresh matching artifacts, complete starter inputs, minimum-OS and native tests,
and explicit publication approval. Pack and update downloads come only from the
public distribution selected at build time. Start with [Installation](installation.md),
[Feature packs](feature-packs.md) and [Troubleshooting](troubleshooting.md).
Maintainers use the [manual release process](release-process.md) and
[Runtime staging](runtime-staging.md).

## Runtime Shape

The desktop package lives in `src/frontend/desktop`.

The packaged-resource format is `animama-desktop-runtime/2`, with
`local_http_schema_version: 1`. The reader rejects unsupported or mixed runtime
artifacts before native execution. `runtime/state.json` stores
`{version: 1, gatewayPort}`: `gatewayPort` is the saved application port, including
when FastAPI owns the listener. The vault, installation owner and
`persist:animama` browser partition persist across launches. Acceptance requires
a matching stage, audit, package and isolated native test of the exact source.

Packaged builds always select embedded mode. At startup, `desktop/src/main.ts`:

1. Sets the Animama name and user-data directory, moving an existing
   `Anima` tree only into an absent destination, and acquires the single-instance
   lock before sessions, logs, vault access, or services.
2. Opens an Electron-owned startup/recovery page and validates the staged
   manifest, required resource hashes, platform, and versions. Reconciles saved
   pack pointers against the exact embedded catalog and verified file inventories.
3. Unlocks the encrypted vault and preflights the saved loopback application
   port, choosing and persisting one on first launch. Recovery remains in its
   independent Electron window while no application listener is available.
4. Initializes or starts owned PostgreSQL 16 with pgvector, verifies the exact
   PGDATA, backs up an existing schema before upgrading, and runs the frozen
   bootstrap CLI. Migrations own installation-principal generation.
5. Starts upload cleanup and FastAPI on the saved application port; FastAPI
   processes uploaded files itself. Private
   readiness must match the exact child PID/start token, runtime/build, local HTTP
   schema, Alembic head and owner after Included-source reconciliation succeeds.
6. Installs the fresh HttpOnly renderer capability and loads the packaged React
   app and same-origin product APIs directly from the verified FastAPI listener.

The browser-facing origin is a persisted `http://127.0.0.1:<port>`. PostgreSQL
uses a separate private loopback port. An occupied saved application port
shows recovery; it does not silently switch origins or create another owner.
Quitting drains requests and stops retained child handles. The app never kills
a process merely because it occupies a port or appears in an old PID record.

On Windows every owned process, including short commands such as `pg_isready`,
starts through `runtime/bin/animama-process-guard.exe`. The guard puts the
service in a kill-on-close Job Object before it runs, reports the service PID
on its first output line, and holds a stdin pipe from Electron as its lifeline.
Stopping a service, or Electron exiting for any reason, closes that pipe: the
guard sends Ctrl+Break, which PostgreSQL and Python handle as a clean shutdown,
then ends the job after 15 seconds, the backend's own graceful-shutdown limit.
Each stop logs its duration and exit code. Killing the guard ends the job at
once, so no service or descendant outlives the app. `processes.json` records both the
guard and service PIDs; the readiness and `postmaster.pid` checks use the
service PID. PostgreSQL refuses an elevated token, so a launch with Run as
administrator stops with `administrator_launch_unsupported` while validating,
before it creates any data; PostgreSQL's own refusal maps to the same code.

Unpackaged `pnpm desktop:dev` remains the external-stack workflow. It loads
`ANIMAMA_DESKTOP_WEB_URL` or `http://localhost:8000` and does not start services.
An explicit unpackaged `ANIMAMA_DESKTOP_DEV_RUNTIME_ROOT` selects embedded
testing against a complete staged runtime. Packaged builds reject web-URL,
development runtime/data, and sandbox overrides. See [Platform builds](platforms.md).

Electron uses the same owner-scoped catalog and byte APIs as browser web.
It does not enumerate the host content library or expose arbitrary filesystem
IPC. See [Local content runtime](../architecture/local-content-runtime.md) for
source scanning and mounted-content behavior, and
[Platform builds](platforms.md) for external-stack development.

The renderer starts through `main.local.tsx`. On a fresh database it shows the
required private display-name setup; after completion it opens Annie's chat.
Later launches use the last visited owned Anima, or the first remaining Anima.
There is no desktop-local signup, sign-in, session, bearer token, or logout.
Electron's HttpOnly renderer capability authenticates the renderer process to
the local FastAPI boundary and is separate from the stable, non-secret installation owner ID.

Once React opens an Anima, it shares the browser's progressive runtime: verify
the model, draw canonical relaxed-rest, then prepare optional animations/effects
in the background. No IPC byte path or second desktop loader is involved.
Service readiness and the first avatar frame are separate milestones; see
[Mounted runtime preparation](../architecture/local-content-runtime.md#mounted-runtime-preparation).

## Main Process

The Electron main process owns capabilities outside the browser boundary:

- the local runtime graph, readiness, owned shutdown, and recovery
- main window creation and stable-origin loading
- the encrypted credential vault and live key delivery to FastAPI
- catalog-bound pack installation, cancellation, removal, and worker verification
- stable-channel update checks, explicit download/restart consent, and pack preflight
- navigation and permission guards
- native fullscreen
- native desktop PiP
- desktop voice keyboard shortcuts
- main-process logging
- packaging entrypoints

Important files:

```text
desktop/src/main.ts
desktop/src/main-process/config.ts
desktop/src/main-process/window/create-window.ts
desktop/src/main-process/security/guards.ts
desktop/src/main-process/security/renderer-capability.ts
desktop/src/main-process/runtime/supervisor.ts
desktop/src/main-process/runtime/paths.ts
desktop/src/main-process/runtime/vault.ts
desktop/src/main-process/runtime/ipc.ts
desktop/src/main-process/feature-packs/
desktop/src/main-process/updates/
desktop/src/main-process/runtime/product-windows.ts
src/backend/animama/local/http/assets.py
desktop/src/main-process/fullscreen/fullscreen-ipc.ts
desktop/src/main-process/pip/pip-window-manager.ts
desktop/src/main-process/shortcuts/shortcuts-ipc.ts
```

The main process validates the configured web URL and restricts renderer
navigation to the configured origin. External HTTP(S) links open through the OS shell.

## Preload Bridge

Renderer access to Electron goes through `window.animamaDesktop`, exposed by the
sandboxed preload at `desktop/src/preload.cts`.

API version 2 identifies the platform and window role and groups runtime,
credential, feature-pack, update, login item, menu, fullscreen, title bar, PiP,
Quick Chat, shortcut and locale methods.
See `desktop/src/preload.cts` for the complete surface.

The preload source uses `.cts` and is bundled to `dist/preload.cjs` after
TypeScript compilation. Keep new bridge APIs narrow, serializable, and explicit.
Do not expose Node or arbitrary Electron APIs directly to the renderer.

Shared serializable runtime contracts live in `shared/desktop-runtime.ts`.
Credential results contain only the provider name or connection key variable,
configured/update status, whether recovery is required, and bounded failure codes;
there is no read-key API. Main accepts these operations only from a registered,
live main window's top-level frame at the exact application origin. The
recovery window has access only to runtime actions. PiP, quick chat, unknown
windows, and subframes cannot access credentials or mutate packs. Pack requests
accept only the three fixed catalog IDs, never renderer-supplied URLs, paths,
versions, hashes, or commands. Progress subscriptions return cleanup functions;
destroyed windows stop receiving events. Update controls also require the main
window and accept zero arguments; recovery can open only the fixed backup folder.
The login item accepts only a boolean from the main window.

The application menu adds two items of its own to Electron's defaults
(`application-menu.ts`): **Check for Updates…**, under About on macOS and in
Help elsewhere, offered only once the build's updater exists, and **Import
Anima…** in File. The Windows main window hides its title bar and so shows no
menu bar; there the sidebar user menu's **Check for updates…**, which every
build with an updater offers (`SidebarUserMenu`), App Settings → About and the
Library's Import are the way in. Main keeps the chosen command (one of two
fixed values, for 20 seconds), shows the main window, reopening it as the Dock
does when it was closed, and announces that a command waits without naming
it. The main window's app takes it through `menu:take` then, and once when it
starts, so a closed or loading window still receives it; no other window is
admitted. The web app (`useDesktopMenuCommands`) opens App Settings at the
update panel, where the check main started reports its result, or the Library's
Import dialog.

## Provider Settings And Local State

Settings → API Keys shows optional OpenAI, Anthropic, ElevenLabs and Gemini
key controls, and embedded setup the first three; main delivers the Anthropic
key as `ANTHROPIC_API_KEY` and the Gemini key, used only by
[Gemini voices](../runtime/gemini-tts.md), as `GEMINI_API_KEY`. Keys for other
model servers belong to their model connection (Settings → Models): main
stores each under the connection's
managed variable `ANIMAMA_CONNECTION_<ID>_API_KEY`, at most 32 of them. Keys are never read back
or saved to browser storage. A save applies one change or a batch
(`credentials.apply`, validated as at most eight changes and one per provider
or connection). A connection key is saved with the origin of its connection's
address (`origin`, only beside a value), and main delivers it as
`ANIMAMA_CONNECTION_<ID>_ORIGIN`; the backend sends the key nowhere else. Main encrypts the vault through Electron `safeStorage`, then
sends the whole saved set to the running FastAPI, which replaces its in-memory
keys ([desktop runtime](../../backend/operations/desktop-runtime.md)). No window
or backend restarts. The panel then refreshes model
and connection queries. If delivery fails twice, main restarts local
services from the vault. PostgreSQL, the stable origin and local ownership never
change. Unavailable secure storage fails closed; it never falls back to
plaintext storage. Browser and external-stack development do not show these
desktop credential controls.

A batch that would exceed 32 connection keys, or a failed vault write, is refused
before anything is sent. A failed batch records the same failure for each key in
it. Main retains
one bounded failure status per provider or connection key across product-window
recreation, so reopening Settings explains why the change did not finish. A new
accepted attempt clears that key's previous failure. Vaults from earlier releases
open normally; the DeepSeek, Hugging Face and Gemini provider keys they stored
are retired and dropped on load. Enter DeepSeek and Hugging Face keys on a model
connection, and a Gemini key again for Gemini voices; it is stored apart from
the retired entry (see the
[vault notes](../../backend/operations/desktop-runtime.md#roots-secrets-and-private-bytes)).
If a fallback restart fails after the vault was updated, the saved value
remains; recovery Retry starts
services with that value and clears the failure after verified readiness. These failure records stay
in main-process memory only and contain no credential values.

Signing in with a ChatGPT plan (Settings → Models) involves no key the owner
enters. The backend keeps that session itself, encrypted in
`data/internal/chatgpt-plan/session.bin` under a key the vault generates on
first need. Main passes that key only to FastAPI, as
`ANIMAMA_CHATGPT_PLAN_STORE_KEY` in its environment, and redacts it from logs;
the renderer never sees it. Without the key, sign-in reports
`secure_storage_unavailable` ([desktop runtime](../../backend/operations/desktop-runtime.md#roots-secrets-and-private-bytes)).

On macOS the user-data root is `~/Library/Application Support/Animama`:

| Relative path            | Purpose                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `runtime/state.json`     | Saved application port (`gatewayPort` remains the version-1 serialized field) |
| `runtime/processes.json` | Child ownership evidence, not permission to kill stale PIDs                   |
| `runtime/logs/main.log`  | Redacted supervisor and child logs                                            |
| `secrets/vault.bin`      | Encrypted database password, optional provider and connection keys, and the ChatGPT plan session key |
| `postgres/16/data`       | Private PostgreSQL cluster                                                    |
| `content/local`          | Writable typed Local library                                                  |
| `data`                   | Private uploads, downloaded model assets and their staging, and the encrypted ChatGPT plan session |
| `backups/pre-migration`  | Verified custom-format upgrade dumps and migration journal                    |
| `packs/<id>/versions`    | Immutable optional pack versions and retained prior bytes                     |
| `packs/active.json`      | Atomic active pointers, reverified before use                                 |
| `ui-locale.json`         | Last UI Locale the app applied, for the shell's own text                      |
| `pip-placement.json`     | Where the PiP window was last left on this machine's displays                 |
| `downloads`              | Bounded partial archives and strong-ETag resume metadata                      |

Packaged `resources/runtime/content/included-core` is immutable and separate
from that writable tree. The backend records `source-id@version` provenance
and resolves protected bytes beneath the exact mounted source. React receives
neither source paths nor arbitrary filesystem access. Only Local is watched.

## Optional Feature Packs

The only optional pack is expanded Included content, deferred from the first
release. Offline speech recognition (the Parakeet and SenseVoice-Small sets)
uses backend model assets that install without a restart, not packs, and
uploaded files are processed by FastAPI itself.
[Feature packs](feature-packs.md) describes availability, setup and removal
behavior.

The owner-protected `GET /v1/runtime-capabilities` is the renderer's capability
authority. Its `user_file_processing` entry is always enabled on desktop, and
`worker_state` reports FastAPI's upload processor. See backend
[User files](../../backend/features/user-files.md#in-server-processing).

Electron downloads only app-matched catalog archives, checks real free space,
size and SHA-256, strictly extracts regular USTAR members, and verifies the full
inventory before an atomic pointer switch. Interrupted extraction has no mount
authority. Failed installation retains the prior version; verified ETag/range
metadata permits download resume. Packs carry data only. See
[Runtime staging](runtime-staging.md) for producer and approval gates.

Activation/removal preserves the saved origin. It checks private backend
removal blockers, remembers a validated main-app route, destroys all product
windows/workers and shows independent recovery. Private quiescence stops new
admission and waits up to 15 seconds for admitted work. The supervisor repeats
removal checks, stops FastAPI, then switches the pointer and
restarts. A busy quiesce preserves the old pointer/configuration and restarts
that configuration; no resume endpoint reopens admission.
Save unfinished edits first. Anima references, unexpired preview/runtime leases
and active import/reconciliation work prevent removal; affected labels appear
in Settings. Expanded entries are never auto-equipped.

Installed speech-to-text sets are served from the backend model-asset store at
the protected same-origin `/onnx/models/parakeet-tdt-0.6b-v2[-webgpu]/` and
`/onnx/models/sensevoice-small[-webgpu]/` paths. FastAPI resolves the
installed set on each request, so an install or removal needs no restart. Exact
`?v=<manifest-digest>` requests support immutable private caching, ETags, HEAD,
and single byte ranges. Stale versions and unlisted files return 404. No store
or pack path enters React.

## Startup Recovery

The independent startup and recovery page works even when the application
listener cannot bind. While services start it shows the logo, the current stage
and a progress bar (Open Logs and Quit appear if startup stalls); on failure it
shows the advice and a safe error code with Retry, Open Logs, Open Backups, and
Quit. It is a self-contained data URL, so it embeds DM Sans, the logo and a copy
of the theme tokens (`STARTUP_THEME` in `recovery.ts`, kept in sync with
`theme.css` by a desktop test) and follows the system light or dark setting. It
renders in the [shell locale](../architecture/i18n.md#desktop-shell). Retry does
not reset data; Open Backups appears only for a relevant snapshot. See
[Troubleshooting](troubleshooting.md) before changing files. A damaged runtime
requires a complete build to be reinstalled. A missing
vault beside a database requires recovery of the matching vault and data;
restoring a vault on another machine may also require its original OS keychain.
On Windows the vault's key is Chromium's DPAPI-protected `Local State` file in
the same profile folder, readable only by the same Windows account; keep it with
the vault. A new vault waits until Chromium has written that key (about 10
seconds after the first launch starts), so a crash cannot leave a vault whose
key was never saved.
Missing installation ownership fails closed, rather than generating a new owner
over existing data.

Backups must preserve the database, vault, Local content and private data together
with the app closed. Premigration dumps are incomplete backups and never trigger
automatic restore or downgrade. See [Backup and recovery](troubleshooting.md#backups-and-recovery)
for retained snapshots, keychain requirements and stale-process recovery.

Pack state is reconstructed, not trusted from the UI. A corrupt version is
unmounted and can be reinstalled; a replacement is verified before damaged
bytes are moved aside. Incompatible old versions remain on disk and report
`update_available`, but are not mounted or executed. Application update preflight
blocks a candidate that would strand referenced expanded content; clear its
references or arrange a compatible pack before retrying. Do not manually replace
an app to bypass this check: source withdrawal deliberately fails closed. Never erase pack files
manually to bypass references or leases.

## Application Updates

A signed, configured macOS or Windows app checks its release feed after startup
and on demand from App Settings → About, the sidebar user menu or, on macOS, the
Animama menu. The final release will seal `"updates": "ended"`
and never check; see [Desktop releases](releases.md#what-people-see). Checks never download. Download and confirmed
Restart are separate actions; normal Quit does not install. Offline checks do
not prevent startup. Unpackaged and unconfigured builds hide these controls.

Before downloading or stopping services, the supervisor verifies disk capacity,
pack compatibility and in-use references. Native replacement verification begins
only after every owned service stops. Explicit native failure can resume the old
app; a timeout keeps services stopped for safe recovery. A replacement verifies
its own runtime manifest before database work. No hosted account or GitHub token
is stored in the app. See [Releases](releases.md) for policy and acceptance gates.

## Launch At Login

Settings → General → **Launch at login** reads and changes the OS login item
through `desktop/src/main-process/login-item/login-item.ts`; the OS keeps the
setting, and the app stores nothing. macOS registers the app with
`SMAppService` and may need the user to allow it in System Settings → General →
Login Items & Extensions. Windows writes the per-user Run entry, named after
the app ID, which the user can still turn off in Settings → Apps → Startup; the
uninstaller (`build/installer.nsh`) removes it, except when an install runs it
with `--updated`. In both cases the setting says where to allow it, and while
Settings is open it reads the state again when the window regains focus.
The setting is hidden in the browser, unpackaged runs (which would register the
bare Electron binary) and on Linux, which would need an XDG autostart file.

## Runtime Platform Provider

The web app reads the preload bridge once through
`web/src/platform/RuntimePlatformProvider.tsx`.

This produces a stable runtime platform object:

- `kind: "web" | "desktop"`
- `isDesktop`
- `desktopBridgeVersion`
- `os`
- `capabilities.nativeFullscreen`
- `capabilities.nativePiP`
- `desktopBridge`, only in desktop mode

React code should depend on `useRuntimePlatform()` rather than probing
`window.animamaDesktop` directly. Product surfaces such as `MainShell` stay
platform-agnostic by calling hooks like `useFullscreen()` and
`usePictureInPicture()`.

## Native Fullscreen

Desktop fullscreen uses Electron `BrowserWindow` fullscreen APIs instead of DOM
element fullscreen.

Flow:

```text
Canvas control
  -> useFullscreen()
  -> useDesktopFullscreen()
  -> window.animamaDesktop.fullscreen
  -> ipcMain handler
  -> BrowserWindow.setFullScreen(...)
```

The main process emits fullscreen state changes on native
`enter-full-screen`/`leave-full-screen` events. Escape is handled in the main
process so the React button state stays aligned with the native window state.

Browser web still falls back to DOM fullscreen.

## Title Bar

On macOS and Windows the main window has no native title bar
([`title-bar.ts`](../../../src/frontend/desktop/src/main-process/window/title-bar.ts)).
Its window buttons sit in a strip across the top of the page: the macOS
traffic lights, or the Windows minimize, maximize and close buttons at 32px,
which Windows draws on a box in the app background color. On an Anima chat the
Scene fills the strip; other pages show the app background there. Linux keeps
the native frame.

Electron reports the strip to the page as the window-controls overlay, so the
web app reads its height from `env(titlebar-area-height)` into
`--app-titlebar-height`; it is 0px in fullscreen, in PiP and Quick Chat, on
Linux and in the browser. The `.app-titlebar` element in `web/index.html` moves
the window by it, and buttons, links and form controls opt out of dragging.

Layouts reserve the strip themselves. Never pad the body for it: Radix's modal
scroll lock replaces the body's padding, which would shift the app up while a
dialog is open. The app shell spans the window and pads its pages below the
strip; the Anima scene shell extends into that padding while its header and
chat stay below it. Screens outside the app shell, such as setup, start below
the strip with a top margin. Layouts below the strip use the `h-app` and
`min-h-app` utilities instead of the viewport height, and fixed panels such as
the sidebar start below the strip.

Windows draws its buttons in fixed colors, so the main window samples the body
background and text colors on theme and Appearance changes and sends them as
`#rrggbb` through `window.animamaDesktop.titleBar.setColors(...)`. The
desktop-shell load-error page has its own drag strip.

## Desktop Picture-In-Picture

Desktop PiP is a second frameless Electron `BrowserWindow`, not Chromium
Document Picture-in-Picture.

The main window owns audio and runtime state. The PiP window renders a
scene-only route and receives visual state over Electron IPC. On supported
platforms, the PiP body is click-through while close, resize, the hover drag
handle, and the size slider remain interactive. Browser web still uses Document
PiP when available.

See [Picture-in-picture](picture-in-picture.md) for implementation details.

## Desktop Keyboard Shortcuts

Desktop voice shortcuts are owned by the Electron main process. One-shot keys
use Electron, while global hold-to-talk uses Animama's first-party macOS/Windows
native addon and exposes only matched down/up transitions to JavaScript. The web
app stores and displays the application preferences, but shortcut capture only
applies inside the desktop app. The default shortcuts toggle Voice Mode, toggle
Voice Mode mute, and skip active TTS playback.

See [Keyboard shortcuts](keyboard-shortcuts.md) for implementation details.

## Security Model

Desktop windows use:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- a bundled preload bridge with explicit IPC surfaces
- the dedicated `persist:animama` session partition
- a fresh per-launch, host-only, HttpOnly renderer-capability cookie

The session permission guard currently allows only media permissions from the
configured web origin. Navigation guards block or externalize URLs outside the
configured origin. Besides external HTTP(S) URLs, only crisis-card `tel:` and
`sms:` links whose target is digits with an optional leading `+` are handed to
the operating system.

IPC handlers resolve target windows from `event.sender`. Renderers do not choose
window ids, target webContents ids, or arbitrary URLs.

## Speech And Audio Behavior

Electron can expose browser Web Speech APIs while still failing recognition in
practice. Desktop mode hides browser STT/TTS options from the app UI.

Desktop speech behavior:

- STT uses the client-side offline engine for the UI Locale (Parakeet for
  English, SenseVoice-Small for Japanese, Korean and Chinese) only when runtime
  capabilities report it available. Embedded mode requires that engine's
  installed CPU model asset (`parakeet-stt` or `sensevoice-stt`);
  external-stack development retains its configured same-origin model source.
- TTS uses PocketTTS, ElevenLabs or Gemini.
- Browser TTS/STT providers are not offered in desktop settings.
- Desktop PiP is visual-only; the main renderer remains the audio owner.

## Logging And Diagnostics

Main-process logs are written to:

```text
~/Library/Application Support/Animama/runtime/logs/main.log
```

At 10 MiB the file rotates; `main.log.1` (newest) through `main.log.3` keep
older lines.

Useful checks from `src/frontend`:

```sh
pnpm desktop:check
pnpm desktop:build
pnpm web:check
```

In unpackaged development, renderer DevTools are available with
`Ctrl+Shift+I`, and `pnpm desktop:dev_inspect` debugs the Electron main process
on port `9229`. Packaged builds offer neither
([packaged hardening](platforms.md#packaged-hardening)).

## Packaging

See [Platform builds](platforms.md) for packaging commands.

The unsigned development package targets macOS 15+ arm64 and Windows x64
(Windows 10 22H2 or later), and requires a fresh, complete audited stage. Windows has the same signed
candidate, update, smoke and publication tooling as macOS (no Windows feature
packs yet), and Linux self-contained packaging is deferred; external-stack
`desktop:dev` is available on Linux. Signed releases
require separate signing, notarization, minimum-OS and native acceptance.
Initial publication uses the manual process from reviewed `main` inputs. The
optional executable worker requires Developer ID signing, notarization and
pinned-publisher verification even with an unsigned core.
