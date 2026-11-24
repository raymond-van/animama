# Desktop runtime staging

Staging produces the audited resources consumed by Electron's embedded service
supervisor. Packaged builds require these resources. `desktop:dev` uses the local
application stack unless the development runtime-root override is set. See
[Overview](overview.md) for lifecycle, credentials and recovery.

For user installation and recovery use [Installation](installation.md) and
[Troubleshooting](troubleshooting.md). For initial manual publication after
signing/acceptance, use [Release process](release-process.md). This staging guide
describes build inputs and development evidence, not an available release.

## Native macOS build

Use an Apple Silicon Mac with Xcode command-line tools, `uv`, Node, and the
repository's pnpm installation. Dependency downloads require network access.
No Homebrew PostgreSQL, Docker reset, local account, or provider credential is
required. Before staging, acquire the pinned browser speech inputs from the
repository root:

```sh
python3 scripts/models/browser_speech.py acquire
```

Speech-to-text sets are not staging inputs (see
[release model inputs](#release-model-inputs)). Then run from `src/frontend`:

```sh
pnpm desktop:runtime:stage -- --platform darwin --arch arm64
pnpm desktop:runtime:audit -- --platform darwin --arch arm64
pnpm desktop:test -- runtime-packaging
```

Staging first checks that `src/frontend/node_modules` matches `pnpm-lock.yaml`
and stops before any build step if it does not, for example after pulling a
main that changed packages. Run `pnpm install --frozen-lockfile` in
`src/frontend`, then stage again. When a later step fails, its full output is in
that step's log under `desktop/.desktop-runtime/<target>/`.

Staging installs its pinned Python interpreter under
`/Users/Shared/animama-build/uv-python`, not in your home directory, because
the frozen backend records the interpreter's install paths. The native
PostgreSQL build likewise uses the neutral prefix `/opt/animama`. Neither
location needs to exist on the user's Mac. Staging refuses to run if
`/Users/Shared/animama-build` or its `uv-python` directory is owned by another
account or writable by others; remove or fix that directory rather than
bypassing the check.

Downloaded Python packages are cached in `~/Library/Caches/Animama/uv-cache`;
set `UV_CACHE_DIR` to use another directory. Avoid `/private/tmp`: macOS deletes
files from old entries there, and uv then fails with a missing `dist-info` file.

The strict target parser rejects cross-builds and unsupported combinations before
deleting outputs or downloading dependencies. For Windows, see
[Native Windows build](#native-windows-build). `desktop:dist:mac` and `desktop:smoke:mac` use the
[signed-release gates](releases.md), including explicit Apple, inventory and
intended repository configuration. The repository may remain private for local
signed candidates; anonymous public access is checked only at publication.
Private pack/update URLs do not become usable in the app. `desktop:dist:windows` and `desktop:smoke:windows` run only on a Windows x64 host; the installer and app require Windows 10 version 1903 or later, and support Windows 10 22H2 and Windows 11. No command treats a shell-only package as a release.

After a successful stage and audit, `pnpm desktop:mac` copies the runtime into
`Animama.app/Contents/Resources/runtime`, outside ASAR. Its prebuild gate requires
the exact audited manifest/build ID and current main/preload closure, with no
stage-failure marker. Restage and reaudit after backend, supervisor, preload, or
web or migration changes. Bootstrap upgrades a profile through the bundled
Alembic revisions after a pre-migration snapshot. Profiles or backups whose revision is
absent from the packaged migration graph require a matching app/checkout or a reviewed recovery
procedure. Use an explicitly disposable fresh profile for incompatible test data.
The stage probe uses disposable data; it does not reset an existing installation.
Artifacts use `animama-desktop-runtime/2` and `local_http_schema_version: 1`.
Stage and audit require the frozen backend to advertise the same local HTTP
schema. The JS audit rejects Hono and frontend-server dependencies.
The saved application-port key is `gatewayPort`; it does not imply a gateway process.
The development packager disables ad-hoc signing as well as certificate signing,
and rechecks every copied runtime file after electron-builder finishes. See
[Platform builds](platforms.md) for the unsigned output and report. Production
signing uses its separate nested-sign, inventory, and outer-seal sequence.
The FastAPI static responder must serve ONNX `.mjs` modules as JavaScript with `nosniff`;
having the file in the inventory is insufficient if Chromium rejects its MIME
type.

Each staging pass clears only `desktop/.desktop-runtime/darwin-arm64`, then:

1. Resolves starter specifications, the full recommended typed dependency
   closure, authoring Poses and the explicit `CORE_LIBRARY_ROOTS` in
   `animama/runtime/starter_content.py`. These Library roots and their
   dependencies ship in core without entering the starter loadout's Gestures and
   Reactions or per-starter receipts (its Idle seed names the idle Gestures among
   them). With the starter closure and Poses they cover every valid tracked
   Included item, so desktop core matches self-host and the expanded input is
   empty; add each new Included item that no starter selects to these roots
   (a new non-idle Gesture joins the starter loadout instead). Only tracked distribution
   inputs may enter the stage; missing or excluded required roots fail staging.
   Effect art is staged as WebP derivatives of its PNG masters
   (`src/backend/packaging/desktop/README.md`), so staged files and revisions
   differ from self-host's even though the items match.
   Optional portraits use the same presentation contract as installation
   bootstrap.
2. Builds pinned PostgreSQL 16.15 and pgvector 0.8.6 sources with portable arm64
   flags. The runtime retains required language, encoding, and text-search
   modules, but no headers, static archives, or development tools. Symbols stay
   in a separate output directory.
3. Freezes Python 3.12.13 and the locked server dependencies, with the
   `documents` extra's upload parsers, using PyInstaller 6.22.2. The build
   environment is separate from the repository's `.venv`. The frozen runtime
   also serves as each upload's parse child (`parse-upload`), so the parsers'
   native libraries (lxml and PDFium) ship, and are signed, with the core.
4. Builds Vite in `embedded-desktop` mode, without duplicate Included aliases.
   App stage scenes from `public/background` ship unchanged; the audit rejects
   any other file under an Included compatibility route such as `background/`.
   The stage filter and independent audit reject unapproved portrait copies
   listed in `desktop/scripts/runtime/desktop-web.mjs`.
   The browser-runtime manifest verifies all 21 PocketTTS, VAD, Smart Turn and
   ORT assets from the shared model store and exact dependency versions. Vite
   copies every reviewed variant into the runtime; the independent audit checks
   the built inventory and hashes without relying on a developer cache. These
   distribution copies and their existing notices remain required. Ordinary
   `pnpm web:build` also retains the Included compatibility copies.
   This is a production build: application debug imports stay excluded even
   with `VITE_ENABLE_DEBUG_PANEL=true`. Retain `.vite/manifest.json` and
   `.vite/browser-runtime.json` alongside the coherent SPA output; packaged
   FastAPI uses them to identify fingerprinted JS/CSS eligible for immutable
   caching and to revalidate speech runtime files by digest, and serves
   neither record. The audit fails, naming the file, when any staged web file
   contains the build user's home directory. A build step recorded an absolute
   path, such as a Vite plugin emitting an asset with an absolute
   `originalFileName` (manifest keys must stay relative to the web root); fix
   that step rather than the staged copy.
   HTML validators hash the actual contents, so normalized file dates and an
   unchanged HTML length cannot keep a previous build's script fingerprints.
5. Bundles Electron main/preload with esbuild and copies only the native input
   hook's runtime closure. No other JavaScript package may resolve from a
   developer's `node_modules` at runtime.
6. Bootstraps a disposable database in a temporary directory with the staged
   PostgreSQL and frozen backend, then records its normalized schema digest as
   the manifest's `database_schema_sha256`. The directory is removed afterwards.
7. Produces normalized file inventories, license notices, pack inputs, app-matched
   catalog entries for approved inputs, a non-secret `update-policy.json`, and exact
   byte reports. It also copies the tracked manifest of every model set named by
   the frozen backend asset catalog into `runtime/model-manifests/` (metadata
   only; no model bytes). The compressed feasibility archive is **not** a signed DMG or
   update ZIP. Their overhead is measured by the signed-release producer.

## Native Windows build

The Windows x64 target uses the same stage and audit commands on a native
Windows x64 host; [platform builds](platforms.md#unsigned-windows-package) packages the
result. Prepare the host:

- Check out a Windows clone with `core.autocrlf=false`; builds hash committed
  bytes and refuse a checkout whose LF files were converted to CRLF.
- Install Visual Studio 2022 with the MSVC v143 14.44 toolset, Windows SDK
  10.0.26100, Node, pnpm and `uv`, then run `pnpm install` in `src/frontend`.
- Acquire the browser speech inputs:
  `py -3 scripts/models/browser_speech.py acquire`. On a machine that also runs
  Animama, first set `ANIMAMA_MODEL_ROOT` to a folder outside both
  `%LOCALAPPDATA%\Animama` (the app's data) and `C:\animama-build`, such as
  `$env:USERPROFILE\animama-models` in PowerShell.

From `src/frontend`:

```powershell
pnpm desktop:runtime:stage -- --platform win32 --arch x64
pnpm desktop:runtime:audit -- --platform win32 --arch x64
```

The build uses `C:\animama-build` as its neutral root: the pinned interpreter,
build tools and the PostgreSQL work tree live there, because MSVC embeds source
paths in the binaries. The first run creates the folder with an explicit ACL
for the current user, SYSTEM and Administrators. A later run refuses the folder,
or any build folder inside it, if it is a link or junction, or if another account
can modify it. The folder holds only rebuildable inputs, so delete it and rerun
the build to recreate it privately. Strawberry Perl, meson, ninja,
win_flex_bison and busybox (`sed`, `gzip`) download once from the URLs and
SHA-256 digests in `desktop/runtime/native-components.win32-x64.lock.json`,
which also pins the compiler, redistributable and SDK versions the build must
find. node-gyp downloads the matching Node headers when it builds the input
addon.

Windows has no POSIX modes, so the inventory marks PE files (`.exe`, `.dll`,
`.pyd`, `.node`) as `0755` and does not compare file modes. The audit reads
every PE import with `dumpbin` and records where it resolves: an API set, a
staged file in the importer's folder or a folder its process searches
(PostgreSQL's `bin`, the frozen backend's `_internal`, `pywin32_system32` and
wheel `*.libs` folders), the host process for the addon's `node.exe`, or a
Windows DLL named in the lock's reviewed `system_dlls` list. Anything else fails.
The VC++ runtime DLLs PostgreSQL imports are copied from the pinned
redistributable; a copy in the build machine's System32 never satisfies the
audit. The PostgreSQL executables carry a UTF-8 active code page manifest;
without it, `initdb` cannot use a data directory whose path contains characters
outside the system's ANSI code page. The probe always uses such a path.

The stage also compiles the first-party process guard,
`desktop/native/process-guard/process_guard.cpp`, into
`runtime/bin/animama-process-guard.exe` with the pinned toolset, the static CRT,
Control Flow Guard, high-entropy ASLR and CET compatibility. It imports only
`KERNEL32.dll`, and the runtime manifest must include it.

`native-dependencies.json` and `native-build.json` describe the PostgreSQL
component; `audit-report.json` holds the whole stage's dependency report. To
build and check PostgreSQL on its own:

```powershell
node desktop/scripts/runtime/native-build.mjs --platform win32 --arch x64
```

```powershell
desktop\.desktop-runtime\build-venv\win32-x64\Scripts\python.exe ..\backend\packaging\desktop\probe_postgres.py --runtime desktop\.desktop-runtime\win32-x64\runtime --postgres-only
```

## Evidence and gates

The target directory contains `runtime/manifest.json`,
`runtime/licenses/inventory.json`, `runtime/licenses/THIRD_PARTY_NOTICES.txt`,
`starter-content-inventory.json`, `size-report.json`, `size-report.md`, and
`audit-report.json` after a successful full stage. `pack-inputs/` is not a public
pack catalog. No download URL is invented for an unpublished pack.
A successful stage also rewrites the ignored local
`desktop/release/review/redistribution-review.md` from those exact artifacts;
it does not reuse narrative from an older build.

Read the exact stage reports for measured bytes and audit results. Feasibility
sizes are not signed DMG/ZIP sizes. A generated license inventory requires human review.
See [redistribution review](redistribution-review.md) for source and notice
mappings and the pending artifact review.

## Verified browser engine inputs

`models/browser-speech/manifest.json` pins the 11 core Pocket TTS/Smart Turn
files. `models/browser-runtime/manifest.json` binds those plus nine ORT 1.24.2
files from `onnxruntime-web-assets` and two VAD 0.0.30 files from its pinned
package. Package installation supplies dependency files; staging only verifies
and copies already acquired model inputs. It never silently downloads them or
substitutes an installed ORT version.

The complete 22-file browser engine set occupies 287,825,103 bytes before distribution
compression. It is included in `runtime/web/onnx` as independent regular files,
so clearing a developer model cache cannot break an installed application's
Pocket TTS, VAD or Smart Turn engine. Eve, Azelma and Michael are included; the other 35
voice states and the cloning encoder download separately. Ordinary web builds
and runtime staging do not require those optional inputs. The model-store workflow does not replace signing, redistribution or native
acceptance gates.

Use the [model-store workflow](../../backend/operations/model-assets.md) for
`ANIMAMA_MODEL_ROOT`, Windows `%LOCALAPPDATA%\Animama\models` and WSL/Linux
defaults.

## Release model inputs

The packaged app downloads the speech-to-text sets (Parakeet and SenseVoice),
the optional Pocket voices and the cloning encoder at runtime as backend model
assets until the final release; none is a staging input or pack.
`desktop:dist:mac` copies each set named by the frozen backend catalog from the
verified model store into publication candidates, so a signed release needs those
sets acquired first (for example `python3 scripts/models/parakeet.py acquire`,
`python3 scripts/models/parakeet_webgpu.py acquire`,
`python3 scripts/models/sensevoice.py acquire` and
`python3 scripts/models/sensevoice_webgpu.py acquire`, or an import through the
[model-store workflow](../../backend/operations/model-assets.md)). Set the
absolute `ANIMAMA_MODEL_ROOT` only when selecting a different store. Each set is
checked against its tracked manifest; nothing queries Hugging Face or infers
weights from the tracked-file list. See [Model objects](releases.md#model-objects).

For a cold release store before new objects exist, use the explicit
[release bootstrap](../../../scripts/models/README.md#release-only-bootstrap)
from the repository root. It uses pinned upstream inputs and verifies regenerated
voice hashes without accepting changes. An ordinary web build or stage does not
need these inputs.

This developer/producer cache is not an installed app model directory. The
installed app keeps downloaded models under its data directory
(`<userData>/data/internal/model-assets/`), so clearing a developer cache never
affects it.

## Optional Pack Producer

`desktop/scripts/runtime/feature-pack-build.ts` is shared by staging and:

```sh
pnpm desktop:runtime:packs -- --platform darwin --arch arm64
```

It consumes expanded Included content outside the core closure; every pack is
data only. `desktop/runtime/feature-pack-releases.json` fixes the release URL,
versions, license references, explicit `active`/`deferred` release status, and
approved inventory digest for each supported ID. Expanded Included content is
`deferred` for the first release: its development inputs remain but it
produces no archive/catalog entry or release size gate and requires no
initial-release approval. An active pack ships only when bound to its
owner-approved exact digest; a null or changed digest produces a review report,
not an installable catalog entry. Do not fill in approval hashes
without reviewing redistribution
rights and required notices. No files are uploaded by this command.

Pack inputs permit an explicit compatible `app_versions` list and original
`release_tag` per pack. Keeping the exact approved manifest across those tested
versions preserves its installed pointer through an application update. Omitted
fields still target only the current app/version tag. Keep reused archive URLs
immutable and available; changed payloads need a new pack version and review.

Archive packs retain `.tar.zst` outputs under `feature-packs/`. The Python writer
emits only regular USTAR members with normalized modes/timestamps; the real
installer re-extracts and verifies each candidate. PAX, GNU long names, sparse
files, links and special entries are unsupported. Their disk requirement includes
two expanded payloads, archive bytes and a 64 MiB reserve. Existing installed
versions are never assumed reclaimable. No mutable latest-pack feed exists.

The current release input contains the Apple publisher and no active pack, so a
matching stage emits an empty installable catalog; the deferred pack remains
absent. Existing development content files are not approval.

Browser production-preview checks and an `embedded-desktop` Vite build prove
web policy only. They do not replace a fresh stage/audit, renderer capability
tests, or signed/native acceptance. Restage the entire matching web/backend
output after a cache-policy or frontend change; do not copy individual chunks
into an audited runtime.

## Native verification

Unpackaged supervised tests can supply an absolute fixture catalog through
`ANIMAMA_DESKTOP_DEV_PACK_CATALOG_PATH`; only that mode permits loopback HTTP
fixture archives. Packaged builds reject the override and use their embedded
catalog. This is not permission to mount unreviewed release content.

The native database listens only on authenticated loopback TCP. Unused Unix
sockets are disabled so a long application-data path does not exceed macOS's
socket-path limit. Ownership checks protect the database files; connections
require SCRAM authentication.

During a pack transition, Electron remembers the validated main-app route,
destroys every product window to dispose browser workers, and shows its
independent recovery page. The session blocks product requests while unavailable,
revokes the transient renderer cookie and closes remaining connections. Private
quiescence precedes pointer changes; a busy result restarts the unchanged prior
configuration. After exact owned readiness, Electron installs the capability
and recreates the main app at its remembered route. API/model/content failures
remain bounded errors.

Native pack acceptance requires real download, cancellation, connection loss,
quit/resume, installation, restart, removal and reinstallation. Verify
catalog/ETag-bound resume and bounded `pack_download_failed` and
`pack_cancelled` results. Offline speech acceptance, in a build that offers
downloads, repeats download, cancellation, interrupted resume, removal and
offline dictation through Voice settings (the final release checks removal and
dictation after upgrading the previous release with offline speech installed) and
confirms that the backend PID and open windows are unchanged. Expanded-content tests must check Anima references and
live preview leases; closing a preview does not immediately revoke its lease.
Retain the owner and chat across transitions. Fixture downloads and generated
speech do not establish production transport or physical microphone acceptance.
Keep results with the exact signed candidate and its
[release gates](release-process.md#release-gates-in-order).

The audit detects changed, missing, extra, or non-portable files; checks the
bundled Electron zstd API; executes the frozen resource/content audits; and
creates one **temporary native** PostgreSQL cluster on an unused loopback port.
That cluster verifies pgvector, migrations, stable principal ownership across
repeated bootstrap, and a real custom-format dump restored into a separate fresh
database. The restored principal, Alembic head, pgvector extension, and exact
owner-scoped marker rows must match the snapshot. It is stopped and removed in
`finally`; it does not create or alter any Compose stack.

On macOS the audit also inspects each shipped arm64 Mach-O deployment minimum
before runtime probes or signing, including those of prebuilt wheels such as
lxml and PDFium. It compares deployment versions, not SDK versions; an
absent or foreign target, or a requirement above the advertised minimum,
fails. A failed audit invalidates its success receipt. Build flags, app
metadata, runtime admission and update feeds target macOS 15. Rebuild rather
than relabel artifacts, and retain the macOS 15 runtime-acceptance gate.

Hard caps are 750 MiB compressed core and 1.5 GiB installed core. Five-percent
component regressions are compared with the last **released** baseline,
currently macOS 0.1.5; Windows has none yet. Exceptions require explicit owner approval, a
dated/version-bounded record in `runtime/size-exceptions.json`, and a
matching explicit approval in `runtime/size-approvals.json`. See
[size exception decisions](size-decisions.md). License inventory records and `NOASSERTION` values
are review evidence, not permission to redistribute. Release commands remain
closed while provenance, required notices, or owner approvals are missing.

## Current content gate

The core starter models are Annie (`Annie.vrm`) and Andrew
(`Andrew.vrm`), with renderer-captured portraits. Their provenance and
distinct permission terms are recorded in `content/included/licenses/inventory.json`
and [source notices](../../../licenses/third-party/art-NOTICES.md). Annie is a
VRoid preset; Andrew is the owner's edit of a VRoid preset. Existing
starter receipts and adoption identifiers remain valid compatibility data; they
do not authorize restoring excluded bytes or silently changing an Anima.

The source checkout excludes Mixamo-derived `.vrma` files from tracking and
Docker contexts. The [optional Local installer](../runtime/mixamo-acquisition.md)
adds manually converted motions to the Local library, outside staged content.
`stage.mjs` stages the non-portable [Mixamo-motion pack](../../backend/operations/mixamo-motion-pack.md)
as `runtime/content/mixamo-motion` only when `build-inputs/mixamo-motion/`
exactly matches the tracked manifest with complete private provenance. Without
the input the stage proceeds without the pack; set
`ANIMAMA_REQUIRE_MIXAMO_MOTION=1` for release candidates so a missing pack
fails. The [comedy sound pack](../../backend/operations/comedy-sound-pack.md)
stages the same way as `runtime/content/wow-comedy-sfx` from
`build-inputs/wow-comedy-sfx/`, required by `ANIMAMA_REQUIRE_WOW_COMEDY_SFX=1`;
without it, built-in effects play silently. The supervisor mounts each staged
pack as its own Included source.
The starter closure contains all 140 non-idle authored gestures and all 168
reactions. The 12 idle gestures are not starters; they ship in core as Library
content and seed each new Anima's Idle pool. The
tracked-only staging gate still fails on an unavailable selected dependency, even
if an ignored local copy exists. Full native stage and packaged acceptance remain
separate checks; do not infer them from a passing content test.

Content with `distribution: excluded` or `distribution: non-portable` is
omitted from core and expanded inputs (reasons `redistribution_excluded` and
`non_portable`). An omitted required dependency fails closure resolution.
Non-portable content ships only as its own private Included source. Local Appearance,
voice content and Sound Effects remain supported. Speech-engine models and
built-in voices are separate from imported example recordings. Music and
standalone catalog Clips are outside the active content closure; preserved
legacy files are not staging inputs.

An existing profile referencing unavailable Included content needs explicit
replacement/repair before accepting a new core. Preserve its Anima and stored
receipts; a fresh-profile test does not establish upgrade compatibility.

Build output and caches are disposable. Correct a failed input and rerun staging,
which starts from an empty target. Database backups and installed user state must
never enter a build. Review the exact dependencies, notices and artifacts before
public distribution; [release acceptance](release-process.md#release-gates-in-order)
is separate from source preparation.
