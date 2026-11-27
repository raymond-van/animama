# Maintainer release process

The manual release process builds and reviews exact artifacts from `main`, then
uses separate preview and stable publication commands. `raymond-van` is the
configured maintainer. CI publication is not configured as the release path.

Signed macOS previews 0.1.0 to 0.1.4 and stable releases 0.1.4, 0.1.5 and 0.1.7
are published; the macOS update feed (`latest-mac.yml`) serves 0.1.7. Windows 0.1.6
is published as a preview and as the first Windows stable release; the Windows
update feed (`latest.yml`) serves 0.1.6.
Before distribution ends, a final release turns update checks and model
downloads off; [Ending distribution](releases.md#ending-distribution) covers it
and the cut-off. A local signed candidate can be built before the
selected distribution serves anything: its builder does not contact the
destination or upload release assets. Signing, notarization, complete
starter inputs and exact inventory review are still required. Public preview and
stable publication require distinct approval and anonymous download availability.
The commands below are a runbook; they do not authorize publication or visibility
changes. Core native acceptance, minimum-OS tests and a real forward upgrade
remain pending for the exact current candidate.

The optional [desktop release skill](../../../.agents/skills/animama-desktop-release/SKILL.md)
lets an agent run this runbook on the build host. It stops at every owner
decision below.

## Release gates, in order

| Gate                          | What must be true before continuing                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs                        | Apple Team ID, Developer ID identity and local notarization Keychain profile are configured; content/dependency terms and notices are reviewed. Keep credentials out of source and chat.                                                                                                                                                                                        |
| Candidate coordinates         | Select the app distribution with `ANIMAMA_RELEASE_DISTRIBUTION` (default `r2`) and keep it identical for stage, audit and `desktop:dist:mac`. Archive-pack and update URLs derive from it; model objects always use `downloads.animama.ai/models/`. No token, visibility check or upload is needed to build.                                                                    |
| Reviewed packs                | No pack is active: expanded content is deferred, and a policy that ends updates (the final release) forbids activating one. The required model objects, including both Parakeet and both SenseVoice sets, are scanned with the candidate.                                       |
| Dependency audit              | On each build host, `pnpm audit --prod`, the full audit's `desktop>electron` entries and `pip-audit` of the frozen backend's locked packages report no advisory, except ones accepted as unreachable and listed in `desktop/release/dependency-audit/`. Electron is on the latest release of a supported stable major.                                                          |
| Candidate                     | From reviewed release inputs on `main`, stage, audit and build the local signed DMG/ZIP. Check sizes, hashes, signatures, notarization and notices. A build never uploads to GitHub; notarization sends the binaries to Apple.                                                                                                                                                  |
| Automated acceptance          | Run the required-name setup smoke on a fresh macOS account, local VM clone or runner. It rejects blank input before named completion. Explicit provider-key approval is needed for real chat calls. Never reset the maintainer's normal desktop profile.                                                                                                                        |
| Distribution / public preview | Currently not authorized. The publisher requires the selected destination to serve anonymously (a public GitHub repository or the R2 custom domain), a passing release scan and separate approval of the exact candidate/packs. A private destination cannot serve installed-app downloads; a different private testing transport would require a separate design and approval. |
| Native acceptance             | Check physical microphone/audio, windows/shortcuts, in-place offline speech install/removal and offline dictation (for the final release, removal and dictation after upgrading the previous release with offline speech installed), packs when a pack is active, failures/recovery and a real forward signed upgrade. Record supported OS and compatible app/pack versions actually exercised. |
| Stable promotion              | `raymond-van` reviews the exact DMG-bound manual receipt, required-name smoke/network reports and a rerun dependency audit, then runs the final publisher command.                                                                                                                                                                                                              |

Windows x64 passes the same gates with its own commands; see
[Windows candidates](#windows-candidates). macOS 15 and Windows 10 version 1903
(build 18362) are the enforced minimums. Windows minimum-OS acceptance runs on
Windows 10 22H2, the oldest supported version, not on the floor build. Actual
minimum-OS, clean-machine and signed acceptance require separate evidence. Run native audits against matching current inputs
and preserve their receipts.

Use a separate macOS test account, or a disposable clone of the golden smoke VM
([local VM smoke](releases.md#fresh-account-smoke-in-a-local-vm)), whose user
is logged in normally, and verify that no Animama or `Anima` profile or test app
exists before running smoke. Do not fake HOME, reset another profile or copy
signing private keys into the test account. A locally transferred DMG can test
fresh-profile installation without a public URL; this does not prove a clean
physical machine or minimum-OS compatibility.

## Commands and inputs

Build details, token scope and first-release upgrade QA are in
[Release tooling](releases.md). Set the release version only in
`desktop/package.json`: it versions the packaged app, and the web build reports
it in About. First prepare complete release model inputs from the repository root:

```sh
python3 scripts/models/release_inputs.py \
  --root /absolute/release-model-store \
  --work-dir /absolute/voice-producer-work
export ANIMAMA_MODEL_ROOT=/absolute/release-model-store
```

This explicit producer command can bootstrap unpublished objects from pinned
upstream inputs. It checks existing encoded voice hashes and rejects generated
inventory drift; it never changes approvals or publishes. To reuse a verified
complete voice inventory, add `--import-voices /absolute/import-voice-set`.
See [model tooling](../../../scripts/models/README.md#release-only-bootstrap).
Ordinary web builds do not need optional voices or the cloning encoder.

Before staging, audit the dependencies on each build host, in the checkout you
stage from. These commands run from the repository root in both shells and keep
their reports in `src/frontend/desktop/release/dependency-audit/`, which
staging and `desktop:dist:*` leave in place:

```sh
uv export --frozen --no-default-groups --group desktop-build --all-extras --no-hashes --no-emit-project --format requirements-txt -o src/frontend/desktop/release/dependency-audit/runtime-requirements.txt
uvx pip-audit@2.10.1 --no-deps --disable-pip -r src/frontend/desktop/release/dependency-audit/runtime-requirements.txt -o src/frontend/desktop/release/dependency-audit/pip-audit.txt
pnpm -C src/frontend audit --prod > src/frontend/desktop/release/dependency-audit/pnpm-audit-prod.txt
pnpm -C src/frontend audit > src/frontend/desktop/release/dependency-audit/pnpm-audit.txt
```

The export is the package set the frozen backend is built from, including
PyInstaller, plus optional extras the app does not ship. `pip-audit` evaluates
platform markers for the machine it runs on, so Windows-only packages are
audited only on the Windows host. `--prod` covers the web and desktop production
dependencies but omits the desktop devDependencies that still ship: Electron
and electron-builder's installer templates. Treat full-audit entries whose path
starts with `desktop>electron` like production entries; the full audit's other
entries are build and test tools to review without blocking. Both tools exit
non-zero whenever they report an advisory.

Upgrade a package with a blocking advisory on a task branch before building. A
candidate may proceed with one only when the affected code is unreachable in
the app, for example an advisory limited to building packages from source;
list each accepted advisory and its reason in `accepted-advisories.txt` in the
same folder. Electron must also be on the latest release of one of its three
supported stable majors ([release timeline](https://releases.electronjs.org/)),
because only those receive security fixes. Keep the folder with the candidate's
other receipts, and rerun the audit before stable promotion.

From `src/frontend`, the candidate sequence is:

```sh
pnpm desktop:mixamo-motion fetch
pnpm desktop:private-pack --pack wow-comedy-sfx fetch
ANIMAMA_REQUIRE_MIXAMO_MOTION=1 ANIMAMA_REQUIRE_WOW_COMEDY_SFX=1 \
  pnpm desktop:runtime:stage -- --platform darwin --arch arm64
pnpm desktop:runtime:audit -- --platform darwin --arch arm64
pnpm desktop:dist:mac
```

`fetch` needs the read-only [Mixamo-motion pack](../../backend/operations/mixamo-motion-pack.md)
credentials in the environment; the release workflow reads
`ANIMAMA_R2_ACCOUNT_ID` and the `ANIMAMA_MIXAMO_R2_*` read secrets from the
`desktop-macos-signing` environment. The
[comedy sound pack](../../backend/operations/comedy-sound-pack.md) uses the same
bucket and read-only token under its own prefix. `ANIMAMA_REQUIRE_MIXAMO_MOTION=1`
and `ANIMAMA_REQUIRE_WOW_COMEDY_SFX=1` make the stage fail without the verified
packs, so a candidate cannot silently ship without them.

The reviewed pack and core inputs must already be configured.
Public visibility and release-repository API availability are not candidate build
preconditions; dependency downloads and Apple notarization still need network access.
The embedded update and pack URLs remain pinned and anonymous:
until the selected destination serves them publicly, those network features cannot succeed. Core
startup and local functionality must still work. Do not embed tokens, add runtime
feed/catalog overrides, or call a manually copied pack a verified download.
Do not rebuild while an exact candidate is under acceptance: a signature or
input change invalidates its old hashes and receipts. Preserve
`desktop/release/publish` outside disposable build outputs before starting
another candidate; `desktop:dist:mac` replaces its derived
candidate directory, not user data.

Smoke the exact candidate DMG in a disposable clone of the golden smoke VM,
from the candidate's `src/frontend`:

```sh
python3 ../../scripts/heavy-slot.py -- pnpm desktop:smoke:mac:vm -- --artifact desktop/release/publish/Animama-<version>-arm64.dmg
```

It writes `desktop/release/smoke-name` beside the candidate and deletes the
clone. Without the golden VM, run the same smoke in a fresh test account:

```sh
pnpm desktop:smoke:mac -- --artifact desktop/release/publish/Animama-<version>-arm64.dmg --setup name
```

Then collect the resulting `desktop/release/smoke-name` directory alongside
the unchanged candidate on the publishing Mac. Reports must agree on the DMG
hash and runtime build ID. `<version>` is a placeholder, not a literal filename.
The smoke removes its temporary OpenAI credential and verifies that removal
survives restart. If its sanitized report asks for manual cleanup, remove that
test-account copy before continuing (a VM clone's copy is deleted with the clone); do not clear the maintainer's normal vault
or change the original provider key.

Scan the exact candidate for secrets and private text before any upload. Use
the Gitleaks binary pinned in `scripts/repository-boundary/scanner-pins.json`,
verified against its archive digest; the command never downloads a scanner:

```sh
ANIMAMA_GITLEAKS=<verified-gitleaks> pnpm desktop:release:scan
```

Run it on the staged build machine: expanding the frozen backend uses the build
interpreter from `desktop:runtime:stage`. The scan mounts the DMG and expands the
update ZIP and archive feature packs, or opens the Windows installer's app
payload with electron-builder's pinned 7-Zip, then every nested archive named
`.zip`, `.whl`, `.jar`, `.7z`, `.tar.gz`, `.tgz`, `.tar.zst` or `.asar`, and any
PyInstaller executable (Mach-O or PE). The installer's own NSIS code and the
uninstaller it carries are not expanded; both are signed electron-builder
template output.
Other compressed formats are scanned only as raw strings. Gitleaks must first
detect a generated canary token. It then scans every expanded file under a
neutral numbered name and header line, so its built-in path and file-type
exclusions (such as `node_modules/`, `*.dist-info` and SQLite or PDF headers) do
not apply; binaries are scanned as their printable strings. ONNX model weights
are excluded from Gitleaks because quantized tensors produce chance token
matches; the receipt counts them. Every expanded file, including ONNX, is also
byte-searched for this machine's home directory, the Git author email and any
extra values in `ANIMAMA_SCAN_PRIVATE_TEXT` (one per line; keep them out of
source and shell history). On Windows the home directory is searched as
`\Users\<name>\` with either separator, JSON-escaped and in UTF-16LE. A symlink fails the scan when its target is absolute
or escapes its artifact, except an installer's `/Applications` link.

`release-scan.json` records the scanned file hashes, coverage counts, rule IDs
and locations, never matched values. Errors print only fixed messages; set
`ANIMAMA_SCAN_DEBUG=1` to see the underlying error locally. Do not publish a
candidate whose scan fails. Review each finding; add an accepted false positive
to `desktop/runtime/release-scan.gitleaks.toml` only as an exact placeholder
value or a known non-secret field. The receipt records that file's hash. The
home-directory search only catches the scanning machine's paths: scan on the
machine that built the candidate. The same command verifies candidate bindings
and scans every required `models/<modelId>/` directory as well as the app,
writing a receipt in each directory. Preserve all receipts with the candidate.
The release workflow does not install a verified scanner automatically, so its
publication steps remain fail-closed without these valid receipts.

After distinct preview approval, run:

```sh
node desktop/scripts/runtime/publish-macos.mjs --confirm-preview-publication
```

After actual native acceptance and the maintainer's final approval:

```sh
node desktop/scripts/runtime/publish-macos.mjs --confirm-publication
```

Both commands run from `src/frontend` with the same `ANIMAMA_RELEASE_DISTRIBUTION`
used to build the candidate. Both app distributions require the narrowly scoped
model credentials `ANIMAMA_R2_ACCOUNT_ID`, `ANIMAMA_R2_ACCESS_KEY_ID` and
`ANIMAMA_R2_SECRET_ACCESS_KEY`. A GitHub app distribution also requires
`ANIMAMA_RELEASE_TOKEN`
([operator setup](releases.md#r2-operator-setup)). Stable publication also
needs `ANIMAMA_MACOS_ACCEPTANCE` containing the reviewed JSON itself, not a path.
Load these privately for the command; do not commit them, print them, place literal
secrets in shell history or bundle a GitHub token into the app. Clear the release
credential from the shell when finished. The example acceptance JSON is an
unapproved template and must never be filled automatically from test success.

## Windows candidates

On the Windows 11 x64 build host, from `src/frontend` in a clone checked out at
the exact commit, with the same `ANIMAMA_RELEASE_DISTRIBUTION` throughout:

```powershell
pnpm desktop:mixamo-motion fetch
pnpm desktop:private-pack --pack wow-comedy-sfx fetch
$env:ANIMAMA_REQUIRE_MIXAMO_MOTION = "1"
$env:ANIMAMA_REQUIRE_WOW_COMEDY_SFX = "1"
pnpm desktop:runtime:stage -- --platform win32 --arch x64
pnpm desktop:runtime:audit -- --platform win32 --arch x64
pnpm desktop:dist:windows
```

The build needs the `win32-x64` redistribution receipt for that exact stage, the
Artifact Signing sign-in and the acquired model sets
([Build a signed Windows candidate](releases.md#build-a-signed-windows-candidate)).

Each signed build spends about 140 Artifact Signing signatures (one per PE file)
from a monthly quota, so sign once, at the end. Iterate on unsigned installers
from `pnpm desktop:win:installer`, and run `desktop:dist:windows` only after
reviews pass, for the exact commit you intend to ship. A
`--signing-rehearsal` costs the same and produces nothing publishable; run it
only when the signing code changes. Unsigned builds skip the publisher checks,
so the signed candidate still gets the full smoke below.

Then, in a separate standard Windows account that has never run Animama, using
the same checkout (the smoke writes `desktop/release/smoke-name/` there for the
publisher):

```sh
pnpm desktop:smoke:windows -- --artifact desktop/release/publish/Animama-<version>-x64-setup.exe --setup name
```

Back on the build account, scan with the pinned Gitleaks Windows build
(`windows_x64` in `scanner-pins.json`); the target defaults to the host's:

```sh
ANIMAMA_GITLEAKS=<verified-gitleaks.exe> pnpm desktop:release:scan
```

Preview and stable publication use `publish-windows.mjs` with the options
above; stable promotion needs `ANIMAMA_WINDOWS_ACCEPTANCE`. Windows evidence in
the shared version folder carries a `-win32-x64` suffix (for example
`signing-report-win32-x64.json`, `manual-acceptance-win32-x64.json`), and its
feed is `latest.yml`.

Under the currently implemented transport, installed pack testing and first-release
upgrade QA still require preview/QA feeds in
[Release tooling](releases.md#installed-artifact-smoke-and-manual-acceptance).
Real network acceptance and public-distribution approval remain pending. Core
candidate tests can proceed privately; production
download/upgrade acceptance stays open unless the owner later approves a feed
or separately scopes a secure private testing transport.
Manual publication does not bypass those feeds, native checks, licensing,
signatures or the older-signed-version requirement.

## Evidence and actual artifact names

The canonical candidate/publisher directory is `desktop/release/publish`.
The publisher uploads a fixed list of flat assets (GitHub Release assets, or
objects in the R2 version folder plus the root `latest-mac.yml` at stable
promotion), not a source commit or an arbitrary directory. These files are produced only after their
corresponding gates; their names here are not evidence that a release exists.
The private `models/<modelId>/` subdirectories contain separate raw model
candidates and their scans. Keep the complete candidate tree for handoff; model
directories are not flattened into the app artifact index. The publisher checks
all model bindings, inventories and scan receipts before credentials or writes,
then publishes and anonymously verifies required model objects before app
artifacts. Stable feed promotion remains last.

| Evidence                                                 | Actual output                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Installer and update archive                             | `Animama-<version>-arm64.dmg`, `Animama-<version>-arm64.zip`                                              |
| Exact resource/pack identities                           | `runtime-manifest.json`, `pack-catalog.json`                                                              |
| Frozen backend model catalog                             | `backend-model-assets.json`                                                                               |
| Required model candidates and scans                      | `models/<modelId>/` with raw files, manifest, integrity index and `release-scan.json`                     |
| Component and pack sizes, including pack peak free space | `size-report.json`, `pack-build-report.json`                                                              |
| Dependencies, source review and notices                  | `sbom.cdx.json`, `THIRD_PARTY_NOTICES.txt`, `REDISTRIBUTION_REVIEW.json`, `redistribution-inventory.json` |
| Publisher/signature verification                         | `signing-report.json`                                                                                     |
| Local setup evidence before promotion                    | `desktop/release/smoke-name/{smoke,network}-report.json`                                                  |
| Stable acceptance assets                                 | `smoke-name-report.json`, `network-name-report.json`, `manual-acceptance.json`                            |
| Stable feed and integrity index                          | `latest-mac.yml`, `release-artifacts.json`, `SHA256SUMS.txt`                                              |
| Archive feature packs                                    | Exact archive filenames in `pack-catalog.json` (none while every pack is deferred)                        |

Preview omits
the stable feed and final acceptance assets. Network reports cover renderer
events after harness attachment, not every native process; the separate human
native-network check remains required.

After actual release, verify remote asset hashes against the local index and
retain the exact reviewed artifacts and test notes, including the tested OS and
app/pack version matrix. Only then update `desktop/runtime/size-baseline.json`
from the released size report and record any approved exception. Do not turn
unsigned staging sizes or synthetic recovery tests into a release baseline or
completed acceptance report.

## Failure and handoff

The publisher can resume byte-identical uploads for the same GitHub draft or
testing prerelease, or the same R2 version folder. If publication times out, inspect remote state before retrying; do
not replace conflicting assets or an already stable release. Rebuilding creates
a new candidate that requires fresh review, not permission to reuse old receipts.
For a notarization timeout, preserve the exact Apple submission ID and signed
app, then query that same request after restoring any missing Keychain profile.
Do not create duplicate submissions merely because a bounded wait expired. Once
that request is accepted, resume the preserved app from `src/frontend` with:

```sh
ANIMAMA_MACOS_NOTARY_PROFILE=<profile> pnpm desktop:dist:mac -- --resume-app-notarization <submission-id>
```

The resume command verifies the current staged review and preserved app seal,
waits on only that UUID, staples and rechecks the app, then gives Electron
Builder the app through its prepackaged input. It does not invoke the app signing
hook or upload another app copy. The DMG and update ZIP still receive their own
required notarization submissions. Notary waits are bounded at 60 minutes; an
unresolved Apple request remains pending rather than being treated as accepted.

For installed-app failures use [Troubleshooting](troubleshooting.md), especially
its backup, principal/vault, saved-port and migration warnings. Preserve data and
bounded evidence before proposing a repair. Normal Retry is not a reset, and
rollback of app files is not permission to downgrade a migrated database.

To resume, review the [open release gates](#release-gates-in-order),
apply the verified signing metadata and review the exact inputs, then prepare the
private candidate. Keep the acceptance receipt with the exact
candidate hashes, app/pack versions, operating system, tested journeys, remaining
limits and the maintainer's decision. Public-distribution approval is separate. Do not dispatch CI, change visibility
or publish as part of candidate preparation.
