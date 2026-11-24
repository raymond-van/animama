# Self-contained Linux desktop app, built from source

Source agreement: [#920](https://github.com/raymond-van/animama/issues/920), published
2026-11-24T18:42:42Z and accepted by the owner that day;
[linux-desktop-packaging-spec.md](linux-desktop-packaging-spec.md) is its snapshot.
Authorized scope: Phases 1–6 (owner, 2026-11-24). Gates G1–G4 are the owner's
on the reference system, and Phase 7 waits for G1.

## Purpose and context

On a Linux x64 desktop, a documented source build should produce one AppImage
that runs Animama with its own embedded services. The spec's requirements
R1–R14, constraints C1–C11 and acceptance A1–A12 are authoritative; this plan
does not restate them.

Task branch `build/linux-desktop-packaging`, base `f612be08d`. One branch and
one pull request. The change is in `src/frontend/desktop`, with small web
settings changes, documentation and one decision record. The backend's
behavior, the API, generated clients and the database are untouched.

### Two hosts

- **macOS host**: where the code is written. It runs the desktop and web unit
  tests, type checks and builds.
- **Reference system**: the owner's EndeavourOS machine with i3 on X11 (spec
  D3). Runtime staging refuses to cross-build, so only this machine can
  stage, audit, package or run the Linux app.

Phases 1–6 are written and tested on the macOS host. Everything that needs
the reference system is an owner and hardware gate (G1–G4). A step that needs
the reference system is never marked passed from macOS: a macOS check
establishes platform-independent logic only.

### How this branch picks up Windows 10 support

Windows 10 support ([#913](https://github.com/raymond-van/animama/issues/913),
[pull request 918](https://github.com/raymond-van/animama/pull/918), branch
`build/windows-10-support`) is not merged and edits files
this plan also edits: `manifest.ts` (`runtimePlatform`,
`supportsRuntimePlatform`), the `unsupported_runtime_platform` text in the
five shell locales, `tests/runtime-state.test.ts`, `source-manifest.json`,
the desktop documents and the README. This plan is written against the state
after that work merges.

Before Phase 1's first edit, the branch merges `origin/main` once `main`
contains that merge. If the owner authorizes work before then (PD1), the
branch instead merges `origin/build/windows-10-support` at its current head,
merges it again whenever it changes, and merges `origin/main` after it lands.
Ordinary merges only; the other branch and its worktree are never edited.

The draft pull request opens with the first phase commit and closes #920 when
it merges. It stays a draft until `main` contains Windows 10 support.

### Where Linux is refused or missing today

Paths are under `src/frontend/desktop` unless stated.

| Place | Today |
| --- | --- |
| `scripts/runtime/common.mjs` | `parseTarget` accepts two targets; `nativeLockFile` gives every non-Windows target the macOS lock; `buildRoot` and the uv cache are macOS paths off Windows |
| `scripts/runtime/release-policy.mjs` | `stagedUpdatePolicy` throws for any target outside `RELEASE_TARGETS`, and always requires a macOS publisher |
| `scripts/runtime/native.mjs`, `process-guard.mjs` | PostgreSQL built for macOS and Windows; the guard for Windows |
| `scripts/runtime/audit.mjs` | Chooses the Windows or macOS platform audit; hardcodes the Electron binary path |
| `scripts/before-build.mjs`, `scripts/runtime/package-development.mjs` | Package macOS and Windows only |
| `electron-builder.yml`, `package.json` (`dist:linux`) | A leftover shell-only AppImage entry that the packaging gate rejects |
| `runtime/desktop-runtime.schema.json`, `runtime/source-manifest.json` | Enumerate `darwin` and `win32` |
| `src/main-process/runtime/manifest.ts` | `supportsRuntimePlatform` is false for Linux |
| `src/main-process/runtime/paths.ts` | Data root is Electron's `appData`, which is `~/.config` on Linux |
| `src/main-process/runtime/processes.ts` | Non-Windows services are spawned directly; any live recorded process blocks the next launch |
| `src/main-process/runtime/vault.ts`, `recovery.ts` | No notion of an unprotected store; recovery text for macOS and Windows only |
| `src/main-process/login-item/login-item.ts` | Unavailable on Linux |
| `src/main-process/pip/pip-window-manager.ts`, `quick-chat/quick-chat-window-manager.ts` | `clickThroughSupported` is false on Linux |
| `native/global-input-hook` | `hook_unsupported.cc` on Linux |

### Approach in brief

- **Target (R1, C1).** `linux-x64` joins the staging, audit and packaging
  tables. It is never a release target: no publisher, no redistribution
  review, no feed.
- **Minimum system (C3, PD6).** The stage measures the highest C library
  version its binaries require and writes it to the manifest as
  `minimum_os: "glibc-<major>.<minor>"`. Startup compares it with the
  running C library and reports `unsupported_runtime_platform` when older.
- **Data root (R3).** `$XDG_DATA_HOME/Animama`, else `~/.local/share/Animama`.
- **Process ownership (R4, PD2).** A first-party Linux process guard with the
  same lifeline contract as the Windows guard, so the existing guarded launch
  path in `processes.ts` serves both.
- **Credentials (R5, PD3).** The app selects the Secret Service on desktops
  Electron does not recognise, decides from the ciphertext whether the vault
  is protected, and asks for consent on the startup page before creating an
  unprotected vault.
- **Sandbox (R6, PD4).** A packaged Linux app started with the sandbox
  disabled shows a native message and exits before any service starts.
- **Launcher (C5, PD5).** electron-builder's static AppImage launcher, with
  the legacy one as the fallback if the reference system rejects it.
- **Features (R8–R10, R14).** See the feasibility notes. Launch at login and
  the menu entry share one desktop-entry module.

## Feasibility notes for R8–R10

The spec asks for a note on each feature and the owner's decision to
implement or defer (D5). Sources are Electron 45.3.1's documentation and
source, the X Input 2 protocol, and the XDG autostart and portal
specifications.

### R8 Press to talk

- **X11.** XInput 2 raw key and button events on the root window reach a
  listening client whichever application has focus, and are listen-only. A
  new `hook_linux.cc` implements the existing five-function hook interface on
  its own thread and display connection. It links `libX11` and `libXi`, which
  Electron's own dependencies already bring. Mouse buttons work the same way.
  Cost: one native source of a few hundred lines, a key-code table and a
  portable matcher test. Build prerequisite: the X11 and XInput headers.
- **Wayland.** There is no listen-only access to input. The desktop portal
  offers press and release, but only on KDE Plasma 5.27 and later, GNOME 48
  and later and Hyprland, for keys only, with the desktop choosing the
  trigger. Using it needs a D-Bus client and a second settings flow. Under
  XWayland the hook would see keys only while an X11 window has focus.
- **Recommendation.** Implement on X11. On Wayland report the feature
  unavailable with that reason; a portal version is a later issue.

### R9 Click-through

- **X11.** The managers already decide interactivity in the main process
  from the cursor position, which Electron reports for the whole screen on
  X11, and `setIgnoreMouseEvents(true)` is supported on Linux. Its `forward`
  option is not, but the code relies on it only for mouse moves in the page;
  hover and Avatar look-at come from the poll. Cost: lift the Linux gate for
  X11 sessions and add tests. Risk: how i3 treats the windows, checked at G4.
- **Wayland.** An app cannot read the cursor position outside its own
  windows, and `setShape` does nothing there, so a window that ignored the
  mouse could not become interactive again.
- **Recommendation.** Implement on X11. Keep it off on Wayland, documented.

### R10 Launch at login

- **Approach.** An XDG autostart entry in `$XDG_CONFIG_HOME/autostart` whose
  `Exec` is the AppImage's path, which the launcher provides as `APPIMAGE`.
  Status compares that path with the running file. The same module writes the
  R14 menu entry.
- **Limits.** KDE Plasma, GNOME, XFCE and systemd's generator process
  autostart entries on either session type. i3 does so only through a helper
  such as `dex`, which its default configuration runs; Sway and Hyprland do
  not by default. The app cannot detect this, so the documentation states it.
- **Recommendation.** Implement.

## Progress

- [x] Phase 1: Linux admitted as a runtime target. Implemented from
      `b7c69ecca`. Phase checks pass; review #1 found one required and four
      optional items, all dispositioned; recheck #2 passed. The full pre-push
      suite has not been run.
- [x] Phase 2: process ownership. Implemented from `af1994f91`; phase checks
      pass; review #1 found five required and five optional items, all
      dispositioned; recheck #2 passed. The full pre-push suite has not been
      run.
- [x] Phase 3: credential storage and the sandbox. Implemented from
      `c42246a40`; phase checks pass; review #1 found two required and five
      optional items; recheck #2 found one of them unresolved; recheck #3
      passed after the second and last repair round. The full pre-push suite
      has not been run.
- 2026-11-24, whole desktop suite in a one-off Linux container at
  `4f8a9f8c1` (`node:24-bookworm`, aarch64, gcc 12.2, glibc 2.36; not the
  reference system): 46 files passed, 2 skipped; 748 tests passed, 29
  skipped.
- [x] Phase 4: desktop integration (R9, R10, R11 wording, R14). Implemented
      from `9a3bc9171`; phase checks pass; review #1 passed with six optional
      items, four of them applied. The owner accepted PD10 with the plan. The
      full pre-push suite has not been run.
- [ ] Phase 5: stage, audit and package tooling. Implemented from
      `3eed0188d`; phase checks pass; review pending. Unit-tested on macOS;
      the PostgreSQL build, the guard build and the ELF audit also ran in a
      Linux container. No stage, audit or package has run.
- [ ] Phase 6: Press to talk on X11. Implemented from `13f63b958`; phase
      checks pass; review pending. The owner accepted PD10 with the plan. The
      hook also ran against a virtual X server in a Linux container.
- [ ] Gates G1–G4 on the reference system. Owner and hardware.
- [ ] Phase 7: documentation and decision record. Not started; after G1.
- [ ] Final integration review and the single full pre-push run.

## Surprises & Discoveries

- 2026-11-24, planning. electron-builder 26.18.0's generated `AppRun` runs
  `unshare -Ur true` and appends `--no-sandbox` when it fails, on both
  AppImage toolsets, with no switch to turn it off. Its default desktop entry
  also carries `--no-sandbox`. Evidence: `appImageUtil.js` and
  `AppImageTarget.js` in the installed `app-builder-lib@26.18.0`. R6 therefore
  needs a check in the app, not only build configuration.
- 2026-11-24, planning. Electron selects the Linux secret store from the
  desktop's name. On i3 it selects `basic_text`, and the asynchronous
  `safeStorage` calls then encrypt with the built-in key while reporting
  encryption as available. Ciphertext begins `v10` under the built-in key and
  `v11` under a secret store. Evidence: Electron 45.3.1's `safeStorage`
  documentation and source. The reference session is such a desktop.
- 2026-11-24, planning. The default AppImage toolset embeds a launcher that
  needs `libfuse.so.2`. `toolsets.appimage` `1.0.2` and `1.0.3`, labelled
  beta, embed a static launcher that needs only `fusermount`.
- 2026-11-24, planning. Nothing stops the services on macOS when Electron
  dies. ADR 0013 says Windows lacks "macOS's parent-death handling", which
  the code does not have. Phase 7 corrects that sentence only if the owner
  wants an accepted ADR touched; otherwise the new ADR states the fact.
- 2026-11-24, planning. `stagedUpdatePolicy` throws for a target outside
  `RELEASE_TARGETS`, and `stage.mjs` always calls it.
- 2026-11-24, planning. `package.json` still has `dist:linux`, which runs
  electron-builder outside the staged flow and is refused by the packaging
  gate.

## Decision Log

- 2026-11-24, owner. Accepted the spec, decisions D1–D13 and proposals P1, P3,
  P6 and P7.
- 2026-11-03, owner standing instruction. The full pre-push suite runs once,
  on the final candidate and with the owner's go-ahead, rather than before
  each phase review. Phases run the checks their changes affect.

- 2026-11-24, owner. Agreed this plan as written, including PD1–PD10 below,
  and authorized Phases 1–6.
- 2026-11-24, agent, revising PD3 within the accepted outcome. Consent is
  not written to a separate `secrets/unprotected-storage.json`. Continue is
  held in memory for that launch and the vault it creates is the lasting
  record: an existing vault under the built-in key means the question was
  answered. One file fewer to keep consistent, and the spec's "asked once per
  data directory" still holds.
- 2026-11-24, agent, from review finding P1-F3. systemd ages out files in
  `/var/tmp` that go unused for about 30 days, so PD7's build root can lose
  parts of the build interpreter between builds. The root stays; a stage that
  fails on its interpreter recovers by deleting `/var/tmp/animama-build`.
  Phase 7 documents that. Raised for the owner in case another root is
  preferred.

Agent proposals, accepted by the owner with the plan on 2026-11-24:

- **PD1, starting before Windows 10 merges.** Stack on
  `origin/build/windows-10-support` as described above, so the macOS-side
  phases need not wait for that work's Windows gate. Alternative: wait for
  the merge.
- **PD2, Linux process guard.** A small C program,
  `native/process-guard/process_guard_linux.c`, with the Windows guard's
  contract: first output line `animama-process-guard pid=<pid>`, standard
  input as the lifeline, a graceful stop, then a kill after 15 seconds. It
  runs the service in its own process group, sends `SIGINT` on lifeline
  close (PostgreSQL's fast shutdown; a graceful stop for the server), and
  kills the group at the deadline or once the service exits. The kernel kills
  the service if the guard itself is killed. Alternative rejected: a wrapper
  that only arms a parent-death signal and execs the service. It is smaller,
  but nothing would escalate when a service ignores the signal, and the
  guarded launch path, handshake and process record would differ per
  platform. Known limit: unlike a Windows job, a killed guard does not take
  the service's own children with it; PostgreSQL's children exit when the
  postmaster dies, and A4 checks the rest.
- **PD3, credential protection.**
  - On Linux the app appends `--password-store=gnome-libsecret` before
    `ready`, unless the user passed that switch or the desktop is KDE, where
    Electron's own KWallet choice stands.
  - Protection is read from a probe encryption: `v11` means a secret store,
    anything else means unprotected. The format is Chromium's, not a
    documented API, so the check is commented for review on every Electron
    upgrade, as the existing "temporarily unavailable" match is.
  - Consent is a startup-page state: error code
    `unprotected_storage_consent_required`, with Continue and Quit. Continue
    records `secrets/unprotected-storage.json` in the data directory and
    retries. The record is removed when the vault moves under a secret store.
  - A `v11` vault opened while the probe is unprotected stops with
    `secure_storage_unavailable` before any decrypt or write.
- **PD4, sandbox refusal.** On a packaged Linux app, the switches
  `no-sandbox`, `disable-gpu-sandbox` and `disable-seccomp-filter-sandbox`
  are refused at `ready`, before the supervisor starts or a window opens: a
  native message box in the shell locale, then exit code 1. Other platforms
  are unchanged (C7).
- **PD5, launcher.** `toolsets.appimage: "1.0.3"` and `executableArgs: []`
  for the Linux target. If the static launcher fails at G1, fall back to the
  legacy launcher and document the FUSE 2 package.
- **PD6, minimum system.** As described under the approach. The Linux lock
  and source manifest carry the literal `glibc` where other targets carry a
  version, and the audit re-measures.
- **PD7, build root.** `/var/tmp/animama-build` on Linux, private to the
  builder and checked as today, so no home path is compiled in. The uv cache
  goes under `$XDG_CACHE_HOME`.
- **PD8, update policy.** A Linux stage seals an update policy with updates
  ended and no publisher. `RELEASE_TARGETS`, redistribution reviews and
  publication stay macOS and Windows only.
- **PD9, running the gates.** Preferably an agent session on the reference
  system, in a clone at the pull request's head, so failures are repaired
  where they occur. Otherwise the owner runs the listed commands and returns
  the receipts.
- **PD10, feasibility.** Implement R8 and R9 on X11 and R10 as described;
  Wayland reports R8 and R9 unavailable with a reason.

## Phased implementation

Preparation for every phase, from `src/frontend`:
`pnpm install --frozen-lockfile`. The worktree was created with Git LFS
smudging skipped; run `git lfs pull` before any runtime stage or full suite.
No Compose stack is needed. Real Electron windows are not driven from the
macOS host without asking the owner.

Every phase ends with `python3 scripts/public-release/check_source.py` from
the repository root after staging new files, because every new tracked file
needs an entry in `licenses/source-review.json`.

### Phase 1: Linux admitted as a runtime target

Review tier: high risk. It changes build and packaging tables and the startup
contract that decides whether the app runs.

Requirements: R1 (the refusals), R3, R11 (no feed), C1, C3 (startup half),
C7, the message item of R13. Acceptance: A9's test, A11, and the path rule of
A3. Starting source: the merge described under PD1.

Steps, tests first:

1. **Target parsing.** In `tests/runtime-packaging.test.mjs`, require
   `parseTarget` to accept `linux-x64` on a Linux x64 host and to refuse
   `linux-arm64` and any cross-build. Give `parseTarget` an injectable host
   so the test runs on macOS. Update `common.mjs`: the target list and its
   messages; `nativeLockFile` as an explicit per-target map that throws for
   an unknown target; the Linux build root and uv cache (PD7).
2. **Tables.** Add `linux-x64` to `source-manifest.json` and to
   `desktop-runtime.schema.json` (platform `linux`, pinned to `x64`), with
   tests that a Linux manifest validates and `linux` on `arm64` does not.
3. **Packaging gate.** In `tests/windows-native.test.mjs`, change the
   packaging-gate test: `linux-x64` is accepted, `linux-arm64` refused.
   Update `PACKAGED_TARGETS` and its message in `before-build.mjs`.
4. **Update policy (PD8).** Test that `stagedUpdatePolicy("linux-x64")`
   returns a policy with updates ended and no publisher, that the macOS and
   Windows results are unchanged, and that a `linux-x64` redistribution
   review is still refused. Implement in `release-policy.mjs`.
5. **Startup check (PD6).** In `tests/runtime-state.test.ts`: Linux x64 is a
   supported platform and Linux arm64 is not; a manifest minimum of
   `glibc-2.38` is met by a running `2.42` and by `2.38`, not by `2.37`, and
   not when the running C library is unknown; a malformed minimum is an
   invalid manifest. Implement in `manifest.ts`, reading the running version
   through an injectable function: Node's process report, with
   `getconf GNU_LIBC_VERSION` as the fallback. macOS and Windows comparisons
   keep their exact behavior.
6. **Data root.** New `tests/linux-storage.test.ts`: an absolute
   `XDG_DATA_HOME` is used; a relative or empty one is ignored; unset falls
   back to `~/.local/share`; the development override still wins; macOS and
   Windows roots are unchanged. Implement in `prepareDesktopIdentity`. Linux
   skips adoption of the pre-rename profile, which no packaged Linux build
   ever wrote.
7. **No feed.** Replace the inline platform choice in `main.ts`'s
   `initializeUpdates` with one tested function that returns no update
   platform for Linux, and test that nothing is opened without one.
8. **Message.** Update `unsupported_runtime_platform` in the five locale
   files to name Linux x64 and the older-system case.

Checks, from `src/frontend`: `pnpm desktop:test`, `pnpm check`,
`pnpm desktop:build`, `pnpm prettier:check`.

Not run in this phase: the full pre-push suite (Decision Log); any stage,
which needs the reference system.

Recovery: source-only; reverts with the commit.

Completion: the checks pass on a committed tree, the review finds no open
blocker, and the macOS and Windows expectations in the touched tests are
unchanged except where Linux was listed as refused.

Starting source: `b7c69ecca`, the merge of `origin/build/windows-10-support`
(`9d3cb6491`) into this branch under PD1.

Results:

- `parseTarget` takes an injectable host; `RUNTIME_TARGETS` in `common.mjs`
  is the one list the staging and packaging gates read.
- `manifest.ts` gained `validMinimumOs`, `meetsCLibrary` and
  `runningCLibrary`. `runtimePlatform("linux").minimumOs` is the marker
  `glibc`; a staged Linux manifest carries `glibc-<major>.<minor>`.
- `desktopDataRoot` in `paths.ts` holds the per-platform rule;
  `prepareDesktopIdentity` takes the platform as a parameter for tests.
- `hostUpdatePlatform` in `updates/policy.ts` replaces the inline choice in
  `main.ts`.
- `stagedUpdatePolicy("linux-x64")` returns `sourceBuildUpdatePolicy(...)`.

Test order: steps 2–8 were written test first and seen failing. Step 1's
`common.mjs` change was written before its tests, which were added
immediately after.

Check record (2026-11-24, macOS arm64 host, working directory `src/frontend`,
staged uncommitted work; trees are index hashes):

| Command | Result | Tree |
| --- | --- | --- |
| `pnpm desktop:test` | Pass: 41 files passed, 2 skipped; 692 tests passed, 14 skipped | `475c4c1a5eca` |
| `pnpm desktop:check` | Pass | `475c4c1a5eca` |
| `pnpm --filter animama-desktop prettier:check` | Pass | `475c4c1a5eca` |
| `python3 scripts/public-release/check_source.py` (repository root) | Pass | `475c4c1a5eca` |
| `pnpm check` | Pass | before a formatting-only change to `common.mjs` |
| `pnpm desktop:build` | Pass | same earlier tree |
| `pnpm exec vitest run tests/linux-storage.test.ts tests/linux-target.test.mjs tests/runtime-state.test.ts` (from `desktop`) | Pass: 3 files; 92 tests passed, 4 skipped | repair, see below |

The 14 skipped tests are suites that need a Windows host or a staged Windows
runtime (`process-guard.test.ts`, `windows-storage.test.ts`, three cases in
`runtime-state.test.ts`).

The repair check ran in the working tree while it also held Phase 2's
unstaged edits; the two repaired test files were identical in the index and
the working tree. The repaired Phase 1 index is tree `828f28bb3624`. Phase 2's
full run covers the combined tree.

Not run: the full pre-push suite (`make check-test`, `pnpm verify`,
`pnpm web:test:browser`), by the owner's standing instruction; any stage,
which needs the reference system.

#### Code Review #1 Findings

Reviewed source: staged tree `475c4c1a5eca` against `b7c69ecca`. High-risk
tier: one analysis reviewer and one checks reviewer.

Checks reviewer: confirmed the tree and reran `pnpm desktop:test`,
`pnpm desktop:check`, `pnpm check`, `pnpm desktop:build` and
`check_source.py`. All passed with the recorded counts.

Analysis reviewer:

- **P1-F1 (required).** `tests/linux-storage.test.ts` and
  `tests/linux-target.test.mjs` asserted POSIX path literals, while
  `desktopDataRoot` and `uvCacheDir` join with the host's separator. The two
  tests would fail on a Windows host, against C7 and A11.
- **P1-F2 (optional).** No test shows `verifyRuntime` raising
  `unsupported_runtime_platform` for an older C library; removing the Linux
  clause would leave every test green.
- **P1-F3 (optional, for the owner).** systemd ages `/var/tmp` at 30 days, so
  the build interpreter under PD7's root can be partly deleted.
- **P1-F4 (note).** `source-manifest.json`'s hash enters every target's
  licence inventory, so macOS and Windows inventories change by one hash. The
  Windows 10 work already changed that file.
- **P1-F5 (optional).** The schema test asserts the schema's JSON text, not a
  validation. The reviewer validated it separately: Linux x64 passes the rule
  and Linux arm64 fails it.

Checked without finding: macOS and Windows parity of the startup check, data
roots and uv cache; R3's four `XDG_DATA_HOME` cases; the single update gate;
the sealed Linux policy and its one reader; the refusals of R1; the
translations.

#### Code Review #1 Revisions

- **P1-F1: accepted.** The Linux expectations are built with `path.join`.
  Verified by the repair check above.
- **P1-F2: accepted.** A Linux-host-only case with a minimum of `glibc-999.0`
  was added to the manifest custody suite. It is skipped on macOS and Windows
  and first runs at G1.
- **P1-F3: partly accepted.** The comment in `common.mjs` states the limit and
  the recovery, and the Decision Log raises it for the owner. The root is
  unchanged.
- **P1-F4: recorded.** No change. No macOS or Windows stage output is claimed
  byte-identical; C7 concerns behavior.
- **P1-F5: rejected.** The desktop package has no JSON Schema validator, and
  adding a dependency for one test is not warranted. The reviewer's
  validation is the evidence.

Repair budget: one of two rounds used.

#### Code Review #2 Findings

Targeted recheck of the repair, staged tree `828f28bb3624` against
`475c4c1a5eca`. Result: pass, no regression.

- P1-F1 resolved: every expectation in both files matches under Windows path
  rules; the reviewer mirrored the two functions with `path.win32` and
  compared all 14 cases.
- P1-F2 resolved: `glibc-999.0` passes the manifest's validity block and
  reaches the C library comparison. The comparison against a real C library
  first runs on the reference system.
- P1-F3 resolved as dispositioned: the change is a comment.

The reviewer reran the three repaired test files on an export of the exact
tree: 3 files passed; 91 tests passed, 4 skipped. The implementer's count of
92 included one Phase 2 test in the working tree.

#### Code Review #2 Revisions

None needed.

### Phase 2: process ownership

Review tier: high risk. It adds a native helper and changes how services are
started, stopped and recognised after a crash.

Requirements: R4. Acceptance: the logic behind A4; A4 itself is gate G2.
Depends on Phase 1.

Steps, tests first:

1. **Guard behavior.** New `tests/process-guard-posix.test.ts` compiles
   `process_guard_linux.c` with the host's C compiler into a temporary folder
   and requires: the handshake line first; a graceful child stopped by
   closing the lifeline, with its exit status passed on; a child that ignores
   the signal killed at the deadline, together with a grandchild in its
   group; the same when the guard receives `SIGTERM`; the service's
   environment passed through unchanged; a usage error without `--`. The test
   build shortens the grace period with a compile-time definition. The suite
   runs on Linux and macOS and is skipped, with a logged reason, where no C
   compiler exists.
2. **Guard source (PD2).** Write `native/process-guard/process_guard_linux.c`
   in portable C. The Linux-only calls (child subreaper, parent-death signal)
   sit behind `#ifdef __linux__`, so macOS exercises everything else.
3. **Guarded launch.** In `tests/process-guard.test.ts` and
   `tests/runtime-supervisor.test.ts`, require that Linux launches go through
   the guard with the lifeline, that `runCommand` drops the handshake line,
   and that a missing guard is `process_guard_unavailable`. Generalise
   `spawnService`, `PROCESS_GUARD_PATH` and the supervisor's `useProcessGuard`
   call from "Windows" to "guarded platform". Windows behavior and paths are
   unchanged. `scripts/runtime/schema-fingerprint.ts` uses the guard on Linux
   too.
4. **Process record.** Test that on Linux a live recorded process blocks the
   next launch only while `/proc/<pid>/exe` is the recorded guard or service
   image, and that a process whose image cannot be read does not block.
   Implement beside the Windows image lookup, with an injectable reader.

Checks, from `src/frontend`: `pnpm desktop:test`, `pnpm desktop:check`,
`pnpm desktop:build`, `pnpm prettier:check`.

Limits to record: on macOS the test proves the portable logic. The
parent-death signal, the subreaper and the `/proc` lookup first run at G2.

Recovery: source-only.

Completion: the checks pass, the review finds no open blocker, and macOS and
Windows launches are shown unchanged by their existing tests.

Starting source: `af1994f91` (Phase 1).

Results:

- `native/process-guard/process_guard_linux.c` is the guard. It checks that
  the executable can be run before forking, so a missing service exits 3 with
  no handshake, and it holds the service behind a pipe until the handshake
  line is written, so that line is always first.
- `processes.ts` uses the guard whenever one is selected and requires one on
  Windows and Linux (`guardedPlatform`). macOS selects none and launches
  directly, as before. The process record compares images through an
  `ImageLookup`: Windows as before, Linux from `/proc/<pid>/exe`.
- `processGuardPath(platform)` in `manifest.ts` names the staged guard; the
  manifest check requires it on both guarded platforms and treats `bin/` as
  critical.
- The test fixture compiles the guard for the host on demand
  (`posixProcessGuard`), with a 1.5 second grace period. Generic launch tests
  use `hostProcessGuard`: the staged guard on Windows, the compiled one on
  Linux, none on macOS.

Test order: the guard's C source was drafted and exercised by hand before its
test file existed, while Phase 1's tree was frozen for review; the suite was
written next and passed on first run. The `processes.ts` and `manifest.ts`
changes were made against failing or newly added tests.

Check record (2026-11-24, macOS arm64 host; run on an export of the staged
tree, `git archive 05f00ef7fd13`, with the worktree's `node_modules` linked
in; working directory `src/frontend` of that export):

| Command | Result | Tree |
| --- | --- | --- |
| `pnpm desktop:test` | Pass: 43 files passed, 2 skipped; 706 tests passed, 16 skipped | `05f00ef7fd13` |
| `pnpm desktop:check` | Pass | `05f00ef7fd13` |
| `pnpm desktop:build` | Pass | `05f00ef7fd13` |
| `pnpm --filter animama-desktop prettier:check` | Pass | `05f00ef7fd13` |
| `python3 scripts/public-release/check_source.py` (repository root, worktree index) | Pass | `05f00ef7fd13` |

The two skips beyond Phase 1's fourteen are Linux-host-only: the guard being
killed outright, and Phase 1's older-C-library case.

Not run: the full pre-push suite, by the owner's standing instruction;
`pnpm check`, because no web, package or locale file changed; anything on
Linux. The parent-death signal, the child subreaper and the `/proc` lookup
have not run anywhere yet.

#### Code Review #1 Findings

Reviewed source: commit `c42246a40` against `af1994f91`. High-risk tier: one
analysis reviewer and one checks reviewer.

Checks reviewer, on an export of the commit: `pnpm desktop:test` (43 files
passed, 2 skipped; 706 passed, 16 skipped), `pnpm desktop:check` and
`pnpm desktop:build` pass and match the record; the two guard suites passed
three times in a row; the guard compiles without diagnostics under
`-std=c11 -O2 -Wall -Wextra -Werror`. It noted that the test fixture left a
temporary folder behind on every run.

Analysis reviewer, who also compiled and ran the guard in a Linux container
(gcc 12.2, glibc 2.36):

- **P2-F1 (required).** `tests/runtime-state.test.ts`, "reports PostgreSQL's
  refusal of an elevated token", starts a service with no guard selected, so
  it fails on a Linux host, where a guard is now required.
- **P2-F2 (required).** The Linux image comparison used the host's
  `path.resolve`, so the new process-record test fails on a Windows host.
- **P2-F3 (required).** The guard forked with its handlers installed and its
  signals unblocked. A stop arriving before the service reset them ran the
  guard's handler inside the service and was lost, so the service was killed
  at the deadline instead of stopping at once. Measured in the container:
  with the lifeline already closed, 15 of 30 runs.
- **P2-F4 (required).** The Linux-only test that kills the guard left the
  service's grandchild running, and no test cleaned up services or
  grandchildren after a failure.
- **P2-F5 (required).** A comment in `processes.ts` and in its test said an
  unmounted image reads as "(deleted)". It does not: only an unlinked file
  does; a lazily detached mount gives a mount-relative path.
- **P2-F6 (optional).** `terminate` waited 15 seconds, the guard's own grace,
  so Electron could kill the guard just as the guard was about to kill the
  service's group.
- **P2-F7 (optional).** Adopted orphans are waited for, never signalled.
- **P2-F8 (optional).** A `poll` failure returned without killing the
  service's group.
- **P2-F9 (optional).** A file that passes the run check but cannot be
  executed still gets a handshake before exit 127.
- **P2-F10 (optional).** A 1.5 second test grace could turn an expected
  graceful exit into a kill on a loaded host.

Confirmed sound: the handler is async-signal-safe; the handshake is always
the first line; the look, kill, reap sequence is safe against process ID
reuse; SIGINT to the service alone is right for the postmaster and for the
server; every former Windows branch in `processes.ts` is equivalent and
macOS never selects a guard; existing manifests are unaffected.

#### Code Review #1 Revisions

- **P2-F1: accepted.** The test selects `hostProcessGuard` and is skipped
  where no guard can be built.
- **P2-F2: accepted.** `path.posix.resolve`.
- **P2-F3: accepted.** The guard blocks its four signals across `fork`. The
  service restores default actions and then unblocks, so a pending stop ends
  it at once; the guard unblocks rather than restores its mask. New test:
  with no lifeline, 20 starts in a row must each end with 130 in under half
  the grace period. The old guard managed 1 of 20 on macOS; the repaired one
  20 of 20, and 30 of 30 twice in a Linux container.
- **P2-F4: accepted.** The suite records every service and grandchild it
  starts and kills them after each test.
- **P2-F5: accepted.** Both comments corrected. The consequence is a G2
  check: whether a lazily detached AppImage mount lets a second launch start
  while an earlier launch's services are still stopping.
- **P2-F6: accepted.** `stopTimeout()` gives a stop 22 seconds under the
  Linux guard and 15 elsewhere.
- **P2-F7: recorded.** PD2 states this limit. G2's termination harness is
  the check, including the server's parser child, which starts its own
  session.
- **P2-F8: accepted.** The group is killed before that return.
- **P2-F9: recorded.** No change: the main process sees the service exit
  127 at once.
- **P2-F10: accepted.** The test grace is 3 seconds.
- **Fixture leak (checks reviewer): accepted.** The compiled test guard is
  kept in the ignored build cache under a name made from its source, not in
  a new temporary folder per run.

Linux container run of the repaired guard (2026-11-24, `node:22-bookworm`,
aarch64, gcc 12.2, glibc 2.36, 1.5 second grace; not the reference system):
closed lifeline 30 of 30 and pipe closed after spawn 30 of 30 ended with 130;
a graceful service exited 7 after the handshake; a service ignoring the
signal was killed with its group after 1.8 seconds; killing the guard took
the service with it; an orphan in its own session was waited for.

Repair check (macOS arm64, export of staged tree `5ccde6a34b95`, working
directory `src/frontend`): `pnpm desktop:test` passes with 45 files passed,
2 skipped; 735 tests passed, 16 skipped. `pnpm desktop:check` and the desktop
`prettier:check` pass.

Repair budget: one of two rounds used.

#### Code Review #2 Findings

Targeted recheck of repair commit `9a3bc9171`. Result: pass, no regression.

- P2-F1 to P2-F6, P2-F8, P2-F10 and the fixture leak: resolved. P2-F7 and
  P2-F9: recorded, defensible.
- P2-F3 measured on Linux (`node:22-bookworm`, aarch64, 1.5 second grace):
  closed lifeline 60 of 60 ended with 130; a stop signal 0 to 3 milliseconds
  after spawn 178 of 180, the other two before the guard had installed its
  handlers and none slow; a service that exits at once 300 of 300 with no
  hang; an inherited blocked mask 80 of 80.
- The reviewer reran `pnpm desktop:test` on a macOS export (45 files passed,
  2 skipped; 735 passed, 16 skipped) and, in the Linux container, the guard,
  process-record and runtime-state suites, which passed.
- Three optional notes: the fixture's cache name should include the host; the
  deadline test should carry its own timeout; `runtime-state.test.ts` should
  reset the guard selection after each test.
- Outside Phase 2: at this commit 52 of 63 tests in
  `tests/runtime-supervisor.test.ts` fail on a Linux host, because Phase 3's
  gate sees that suite's fake encryption as unprotected.

#### Code Review #2 Revisions

The three optional notes are applied. The Linux-host failure belongs to
Phase 3 and is repaired there.

### Phase 3: credential storage and the sandbox

Review tier: high risk. It changes how keys are protected and adds a refusal
that guards the security boundary.

Requirements: R5, R6, C10, C11. Acceptance: the logic behind A5 and A6; both
are gates. Depends on Phase 1.

Steps, tests first:

1. **Store selection.** New `tests/linux-secret-store.test.ts`: no switch on
   macOS or Windows; `gnome-libsecret` on Linux for an unrecognised, GNOME or
   empty desktop name; nothing when the desktop is KDE or the user passed
   `--password-store`. Implement a pure function and call it in `main.ts`
   before `ready`.
2. **Protection and transitions.** In `tests/runtime-state.test.ts`, with a
   fake encryptor that emits `v10` or `v11` ciphertext, require every case of
   PD3: a new vault under a store; consent required with no store and no
   record; creation after consent; no second question on the next launch; a
   `v10` vault rewritten as `v11` when a store appears, and the record
   removed; a `v11` vault with no store stopping with
   `secure_storage_unavailable` and the file untouched; Quit leaving neither
   vault nor database; macOS and Windows unchanged. Implement in `vault.ts`
   and the supervisor's vault stage.
3. **Startup page.** In the recovery tests, require the consent state to
   show its text, Continue and Quit, no Retry, and Linux wording for
   `secure_storage_unavailable` and the fresh-profile advice. Add the
   `acceptUnprotectedStorage` action to the runtime preload and IPC, accepted
   only while that state is current. Add the shell strings in five locales.
4. **Notice beside the keys.** Add `credentials.storage()` to the bridge and
   shared types, returning whether the vault is protected. Web tests require
   the notice in `DesktopCredentialsPanel` and the first-run key step when
   unprotected, and its absence otherwise. Add the strings in five locales.
5. **Sandbox refusal (PD4).** New `tests/sandbox-guard.test.ts`: refused for
   each listed switch on a packaged Linux app; allowed unpackaged, on other
   platforms and without a switch; the refusal runs before the supervisor
   starts. Implement the check and its localized message box in `main.ts`.
6. **Vault harness.** Extend `scripts/native/vault-encryption-harness.ts` to
   report, on Linux, the selected store and whether the written vault is
   protected, and to fail when a store was expected and the vault is not.

Checks, from `src/frontend`: `pnpm desktop:test`, `pnpm web:test` for the
touched components, `pnpm check`, `pnpm desktop:build`, `pnpm prettier:check`.

Limits to record: whether Electron uses the Secret Service on i3 once the
switch is set is unverified until G3. If it does not, the reference session
runs the consent path, and the owner decides whether that is acceptable or a
different mechanism is needed.

Recovery: source-only. Consent leaves no file of its own (see the Decision
Log).

Completion: the checks pass and the review finds no open blocker.

Starting source: `c42246a40` (Phase 2).

Results:

- `vault.ts`: `linuxPasswordStore`, `currentProtection`, `storedProtection`,
  `linuxVaultGate` and `CredentialVault.protect()`.
- The supervisor's vault stage runs the gate on Linux, moves a vault under a
  secret store that has appeared, and exposes `acceptUnprotectedStorage()`
  and `credentialStorage()`.
- The startup page has a consent state for
  `unprotected_storage_consent_required`: its own title, Continue and Quit,
  no Retry, Logs or error code. `secure_storage_unavailable` and the
  fresh-profile advice have Linux wording.
- New IPC channels `animama:runtime:accept-unprotected-storage` (recovery
  and main callers, no arguments) and `animama:credentials:storage` (main
  window only, status only).
- `DesktopCredentialsPanel`, which the first-run key step also uses, shows
  the notice and withholds its "encrypted with secure storage" sentence when
  the vault is unprotected. Its query key is built from
  `queryKeys.desktopCredentials.all`, so `product-ui` is unchanged.
- `security/sandbox-guard.ts`; `main.ts` refuses first thing after `ready`
  with a native message box.
- The vault harness reports the selected store and the vault's protection on
  Linux; `ANIMAMA_VAULT_HARNESS_EXPECT=system|unprotected` makes it fail on
  any other outcome. It skips the legacy phases on Linux, which has no
  earlier release.

Test order: steps 1–3 and 5 were written test first and seen failing. The web
notice test (step 4) was written with the component change. The harness
(step 6) has no test: it runs only inside Electron on the gate host.

Check record (2026-11-24, macOS arm64 host; run on an export of the staged
tree, `git archive fff3afd02866`, with the worktree's `node_modules` linked
in; working directory `src/frontend` of that export):

| Command | Result | Tree |
| --- | --- | --- |
| `pnpm desktop:test` | Pass: 45 files passed, 2 skipped; 733 tests passed, 16 skipped | `fff3afd02866` |
| `pnpm check` | Pass | `fff3afd02866` |
| `pnpm desktop:build` | Pass | `fff3afd02866` |
| `pnpm prettier:check` | Pass | `fff3afd02866` |
| `pnpm exec vitest run src/ui/settings` (from `web`) | Pass: 18 files, 208 tests | `fff3afd02866` |
| `python3 scripts/public-release/check_source.py` (repository root, worktree index) | Pass | `fff3afd02866` |

Not run: the full pre-push suite, including the rest of `pnpm web:test`, by
the owner's standing instruction; anything on Linux. No real secret store,
`--password-store` switch or message box has been exercised.

#### Code Review #1 Findings

Reviewed source: commit `6765c0e37` against `c42246a40`. High-risk tier: one
analysis reviewer and one checks reviewer.

Checks reviewer, on an export of the commit: `pnpm desktop:test` (45 files
passed, 2 skipped; 733 passed, 16 skipped), `pnpm check`,
`pnpm desktop:build`, the settings web tests (18 files, 208 tests), the four
Phase 3 desktop test files (110 tests) and the i18n type check all pass and
match the record.

Analysis reviewer:

- **P3-F1 (required).** The model-connection dialog has its own key field,
  which showed no notice and still said "Encrypted on this computer" when the
  vault is unprotected. Panels given their own description kept the same
  sentence above the notice.
- **P3-F2 (required).** `secure_storage_unavailable` on Linux offered Retry
  and said "then retry", but Electron settles where its key comes from when
  it starts, so Retry in the same process would loop.
- **P3-F3 (optional).** If showing the sandbox message threw, the exit was
  skipped and the unsandboxed app went on to open its recovery window.
- **P3-F4 (optional).** The `--password-store` check missed Chromium's
  single-dash spelling, and KDE was recognised from `XDG_CURRENT_DESKTOP`
  only, where Chromium also reads `DESKTOP_SESSION` and `KDE_FULL_SESSION`.
- **P3-F5 (optional).** A comment claimed one invalidation refreshes both
  the key statuses and the protection status; it does not.
- **P3-F6 (optional, owner's call).** `--single-process` and
  `--in-process-gpu` also run content outside the sandbox and were not
  refused.
- **P3-F7 (optional).** This plan's recovery section still listed a consent
  record file.

Reviewed without finding: every combination of store, vault, database and
consent in the gate; the switch timing; the IPC caller and arity checks; the
startup page's state changes; the guard's placement; the translations; C7.
The reviewer found `ELECTRON_DISABLE_SANDBOX` in the Electron binary and
expects it to appear as the `no-sandbox` switch.

#### Code Review #1 Revisions

- **P3-F1: accepted.** `DesktopKeyStorageNote` shows the host's sentence, or
  the warning in its place when the vault is unprotected. The panel uses it
  for the default and for any host description, and the connection dialog
  uses it under its key field. That covers every "encrypted" sentence in the
  web catalogs.
- **P3-F2: accepted.** On Linux the code has no Retry, and its text in five
  locales says to quit and reopen.
- **P3-F3: accepted.** The exit is in a `finally`.
- **P3-F4: accepted.** `linuxPasswordStore` asks Chromium's own switch parser
  and recognises KDE from all three variables.
- **P3-F5: accepted.** Comment corrected.
- **P3-F6: accepted.** Both switches are refused. The message still names
  `--no-sandbox`, the case the launcher produces.
- **P3-F7: accepted.** Recovery section corrected.
- G2 step 4 now also starts the AppImage with `ELECTRON_DISABLE_SANDBOX=1`.
- **Linux-host failure (from Phase 2's recheck): accepted.** The supervisor
  suite's fake encryption now writes the `v11` prefix a secret store gives,
  so a Linux host runs those tests as a protected system. The one test that
  counts encryption calls on macOS and Windows is skipped on Linux.

Repair check (macOS arm64, working directory `src/frontend`, in the worktree
with the repairs staged): `pnpm desktop:test` passes with 46 files passed, 2
skipped; 761 tests passed, 16 skipped; `pnpm check` and `pnpm prettier:check`
pass; `pnpm exec vitest run src/ui/settings` from `web` passes with 20 files,
213 tests. Each repair's test was seen failing first.

Repair budget: one of two rounds used.

#### Code Review #2 Findings

Targeted recheck of repair commits `5738192d2` and `4f8a9f8c1`. Result: one
blocking finding remains.

- **P3-F1: not resolved.** The web search settings have a third key field
  (`web-search/WebSearchSettings.tsx`, the Brave key) that still printed
  `keys.encrypted` directly. The other four "encrypted" sentences reach the
  screen only through the panel's description, as claimed.
- P3-F2 to P3-F7 and the Linux-host fix: resolved. The reviewer forced
  `process.platform` to `linux` in an export: the supervisor suite passed
  (62 passed, 1 skipped) and its pre-repair version failed 52 tests, so the
  simulation reproduces the original failure.
- Optional: after a failed sandbox message the rethrown error reaches the
  ready handler's `catch`, which would construct a recovery window in the
  exiting process, because only `allowQuit` was set.
- The reviewer reran, on an export of `4f8a9f8c1`: `pnpm desktop:test` (46
  files passed, 2 skipped; 761 passed, 16 skipped), `pnpm check`, and the
  panel and model settings web tests (6 files, 126 tests).

#### Code Review #2 Revisions

- **P3-F1: accepted.** The Brave key field uses `DesktopKeyStorageNote`. A
  new test reads every component source and fails if `keys.encrypted` is
  rendered outside that note; it failed on the web search file before the
  fix.
- **Optional: accepted.** The refusal's exit also sets `quitting`, which
  `showRecovery` checks first.

Repair check (macOS arm64, working directory `src/frontend`, in the worktree,
which also held unstaged Phase 5 files that no test below reads):
`pnpm desktop:test` passes with 46 files passed, 2 skipped; 763 tests passed,
16 skipped; `pnpm check` passes; `pnpm exec vitest run src/ui/settings` from
`web` passes with 20 files, 214 tests.

Repair budget: two of two rounds used.

#### Code Review #3 Findings

Final targeted recheck of commit `3eed0188d`. Result: pass.

- P3-F1 resolved. The reviewer listed every key field in the web app: the
  credentials panel (alone and hosted with a description in five places),
  the connection dialog and the web search settings. Each shows the warning
  and no "encrypted" sentence when the vault is unprotected. `product-ui`
  has no key field.
- The guard test fails when the fix is reverted and names the file. It
  misses an aliased translator or a namespaced key, and it covers only
  `keys.encrypted`.
- With `quitting` set, a failed message cannot reach the recovery window.
- Reran on an export of the commit: the panel, model and web search web
  tests (7 files, 135 tests), `pnpm desktop:test` (46 files passed, 2
  skipped; 763 passed, 16 skipped) and `pnpm check`.
- Noted, outside this round: while the protection status is loading, or if
  that call fails, the note shows the usual sentence.

#### Code Review #3 Revisions

None. The loading-state note is left as a known limit: protection is read
once per window, the sentence shows for one render, and a failed call cannot
tell which sentence is true.

### Phase 4: desktop integration

Review tier: standard. New settings and window behavior with no change to a
security or persistence boundary. The reviewer checks the `Exec` quoting,
because the entries name a path that the session will execute.

Requirements: R9, R10, R14, the wording of R11, C10. Acceptance: A9's
wording, the logic behind A8 and A12. Depends on Phase 1 and on PD10.

Steps, tests first:

1. **Session type.** A pure function returning `x11` or `wayland` from the
   environment and Electron's platform switch, with tests.
2. **Click-through (R9).** In `tests/pip-window-manager.test.ts` and a Quick
   Chat counterpart, require mouse events to be ignored over the pass-through
   zone on Linux X11, never on Linux Wayland, and unchanged elsewhere. Replace
   the two `clickThroughSupported` constants.
3. **Desktop entries.** New `tests/linux-desktop-entry.test.ts` for a pure
   module: entry text with `Exec` quoted by the Desktop Entry rules,
   including paths with spaces, quotes, `$`, backslashes and `%`; no sandbox
   switch; reading an entry back; and a status of absent, current, or stale
   when the path differs or the file is gone.
4. **Launch at login (R10).** In `tests/login-item.test.ts`, replace the
   Linux-unavailable case: unavailable unless packaged and running from an
   AppImage; enabled when the autostart entry exists; flagged when stale;
   turning it on writes the entry and turning it off removes it. The web
   setting gains the Linux hint, in five locales.
5. **Menu entry (R14).** The same module writes the entry under
   `$XDG_DATA_HOME/applications` and the icon under the hicolor theme, from
   an icon shipped in the app's resources. Add status, enable, disable and
   repoint through a new bridge, IPC handlers and shared types, each with
   tests. Add `ApplicationMenuEntrySetting` beside Launch at login, shown
   only where the bridge reports it available, with web tests and strings in
   five locales.
6. **Version wording (R11).** A web test requires About to show the rebuild
   line in a Linux desktop build and nowhere else. Add it in five locales.

Checks, from `src/frontend`: `pnpm desktop:test`, `pnpm web:test`,
`pnpm check`, `pnpm desktop:build`, `pnpm prettier:check`. The new settings
are checked in the running app at G4, not from macOS.

Recovery: source-only. The entries are plain files the setting removes.

Completion: the checks pass and the review finds no open blocker.

Starting source: `9a3bc9171` (Phase 2 repair, on top of Phase 3).

Results:

- `window/floating-window.ts`: `linuxSessionType` and
  `clickThroughSupported`; both managers read the latter in place of their
  Linux constant.
- `login-item/linux-desktop-entry.ts`: `desktopEntry`, `entryTarget`,
  `entryState`, `xdgFolder` and `LinuxDesktopEntries`, which serves both
  Launch at login and the menu entry for a packaged app whose launcher set
  `APPIMAGE`. Both entries are named `com.animama.desktop.desktop`.
- `main.ts` uses `LinuxDesktopEntries` for the login-item operations on
  Linux. The `LoginItem` class stays macOS and Windows only, so its existing
  test is unchanged; this differs from step 4's wording, not its outcome.
- New IPC channels `animama:menu-entry:status` and `animama:menu-entry:set`
  (main window, one boolean); `menuEntry` on the preload bridge.
- Web: `useDesktopMenuEntry`, `ApplicationMenuEntrySetting` beside Launch at
  login, the Linux "moved" hint for Launch at login, and the rebuild line in
  About for a Linux desktop build.
- Repointing a stale menu entry is the same call as turning it on, so there
  is no separate repoint operation.

Deviation from step 2: the click-through tests cover the gate function for
each platform and session type, not the two window managers, whose
constructors need a live Electron.

Test order: steps 1, 3, 4 and 5 (desktop side and IPC) were written test
first and seen failing. The web tests for steps 4–6 were written with their
components.

Check record (2026-11-24, macOS arm64 host; run on an export of the staged
tree, `git archive f93e49da80ff`, unless noted; working directory
`src/frontend`):

| Command | Result | Tree |
| --- | --- | --- |
| `pnpm desktop:test` | Pass: 46 files passed, 2 skipped; 757 tests passed, 16 skipped | `f93e49da80ff` |
| `pnpm check` | Pass | `f93e49da80ff` |
| `pnpm desktop:build` | Pass | `f93e49da80ff` |
| `pnpm prettier:check` | Pass | `f93e49da80ff` |
| `pnpm exec vitest run src/ui/settings src/hooks` (from `web`, in the worktree, whose tracked files equal the staged tree) | Pass: 38 files, 355 tests | `f93e49da80ff` |

The web hook tests cannot run in an export: Vite refuses the ONNX runtime
file reached through the linked `node_modules`, so six `useDictation` tests
fail there for that reason only. They pass in the worktree.

Not run: the full pre-push suite, including the rest of `pnpm web:test`, by
the owner's standing instruction; anything on Linux. No desktop entry has
been read by a real session, and no window has been driven.

#### Code Review #1 Findings

Reviewed source: commit `314114dec` against `9a3bc9171`. Standard tier: one
analysis reviewer, reusing the check record. Result: pass, no blocking
finding.

- **P4-F1 (optional).** Availability trusted `APPIMAGE` alone, which child
  processes inherit. An unpacked build started from a terminal that is
  itself an AppImage would write an entry for that other file.
- **P4-F2 (optional).** Status reads only `Exec`, so an autostart file that a
  desktop's own tool disabled in place still shows as on.
- **P4-F3 (optional).** The icon went under `hicolor/512x512`, but
  `build/icon.png` is 1024 pixels square.
- **P4-F4 (optional).** The PiP and Quick Chat documents still say Linux has
  no click-through, and give i3's sticky windows as the reason. Phase 7 owns
  the documents; G4 should check the toolbar after a workspace switch and
  Quick Chat typing under focus-follows-mouse.
- **P4-F5 (optional).** `useDesktopMenuEntry` duplicated
  `useDesktopLoginItem`.
- **P4-F6 (optional).** The repoint button unmounts while focused, so
  keyboard focus leaves the row.

Confirmed sound: the `Exec` quoting, simulated in both parse orders on 17
hostile paths, each giving exactly one argument equal to the path; the entry
files' modes and atomic replace; the IPC argument checks; that nothing in
either window manager depends on forwarded mouse moves; C7.

#### Code Review #1 Revisions

- **P4-F1: accepted.** Entries are available only when this process's
  executable lies inside `APPDIR`, with a test for an inherited variable.
- **P4-F2: not changed.** R10 asks for the moved-file state only. G4 records
  what the reference session's own tools do to the file.
- **P4-F3: accepted.** The icon is copied to
  `$XDG_DATA_HOME/icons/com.animama.desktop.png` and the entry names it by
  path, so no theme size folder has to match. An icon path with a control
  character is refused like an `Exec` path.
- **P4-F4: accepted for G4**, which now names both checks.
- **P4-F5: accepted.** Both hooks use `useDesktopSwitchSetting`.
- **P4-F6: accepted.** Focus moves to the switch after a repoint.

Repair check (macOS arm64, working directory `src/frontend`, worktree with
the repairs staged): `pnpm desktop:test` passes with 46 files passed, 2
skipped; 763 tests passed, 16 skipped; `pnpm check` and `pnpm prettier:check`
pass; `pnpm exec vitest run src/ui/settings src/hooks` from `web` passes with
38 files, 355 tests. The repairs are small and tested; no reviewer recheck
was run, as the standard tier allows for a fix whose test is rerun. The
final integration review covers them.

### Phase 5: stage, audit and package tooling

Review tier: high risk. Build, packaging and audit code.

Requirements: R1, C1, C2, C3 (measurement), C5. Acceptance: the tooling
behind A1 and A4. Depends on Phases 1 and 2.

Nothing in this phase can run against a Linux toolchain on the macOS host.
Its parsers and decisions are unit-tested from recorded tool output; its
first real run is G1.

Steps, tests first:

1. **Native lock.** Add `runtime/native-components.linux-x64.lock.json` with
   the same PostgreSQL and pgvector pins, GCC flags, a relative run path, and
   the allowed system libraries for the files this build compiles. Test its
   shape and that its pins equal the macOS lock's.
2. **ELF inspection.** New `scripts/runtime/linux-platform.mjs` with tests
   from recorded `readelf` output: detect ELF files; read required C library
   versions and take the highest; read needed libraries and run paths.
3. **Stage audit.** `auditLinuxStage` requires, for the files this build
   compiles (PostgreSQL, pgvector, the guard, the input hook), needed
   libraries from the lock's list or the stage itself, and no build-root or
   home path inside them. For every staged ELF file it refuses a run path
   that leaves the stage and records the needed libraries. It returns the
   measured minimum (PD6). Wire the Linux branch and the Electron binary path
   into `audit.mjs`.
4. **PostgreSQL build.** `scripts/runtime/native-linux.mjs`: build with the
   lock's inputs under the neutral prefix, stage the same closure as macOS as
   `.so` files, strip, and write `native-build.json` with the compiler and C
   library versions.
5. **Guard build.** A Linux branch in `process-guard.mjs` compiles the guard
   into `runtime/bin/` with hardening flags and checks it like any compiled
   file.
6. **Stage.** `stage.mjs` builds the guard on Linux and writes the measured
   minimum into the manifest. Confirm by reading that `licenses.mjs`,
   `measure.mjs`, `size.mjs` and the PyInstaller spec need no change, and
   record what was found.
7. **Package.** `electron-builder.yml`: the Linux runtime resources, the
   shipped icon, `executableArgs: []` and the launcher toolset (PD5).
   `package-development.mjs`: a tested function chooses the electron-builder
   targets and paths per target; the Linux path verifies the unpacked
   runtime inventory and fuse wire, requires the AppImage file, and checks
   that its embedded desktop entry carries no sandbox switch. Replace
   `dist:linux` with `pack:linux` and `build:linux`, and add
   `desktop:linux:build` to the workspace scripts.
8. **Termination harness.** Add `test-runtime-termination-linux.mjs`, which
   finds runtime processes through `/proc`, and make `desktop:test:termination`
   choose the harness by platform. The Windows harness file is not edited.

Checks, from `src/frontend`: `pnpm desktop:test`, `pnpm desktop:check`,
`pnpm desktop:build`, `pnpm prettier:check`.

Recovery: source-only. A stage only ever removes its own derived output
directory.

Completion: the checks pass, the review finds no open blocker, and the phase
record lists each step as "unit-tested, not yet run on Linux".

Starting source: `3eed0188d`.

Results, by step:

1. `runtime/native-components.linux-x64.lock.json`. Its `ldflags` use
   `$$ORIGIN`, which make turns into `$ORIGIN`.
2. `scripts/runtime/linux-platform.mjs`: `isElf`, `regularFiles`,
   `requiredGlibc`, `dynamicEntries`, `measureMinimumOs`.
3. `auditLinuxStage` and `compiledOnLinux` in the same module; `audit.mjs`
   has the Linux branch, the Electron binary path and the minimum check.
   Changed from the plan: a run path outside the stage is refused for the
   files this build compiles and for any file when it points at a
   build-machine folder; a system run path on a library copied from the
   system is recorded, not refused, because the frozen backend may carry
   such libraries.
4. `scripts/runtime/native-linux.mjs`: `buildPostgresLinux` and
   `linuxPostgresClosure`.
5. `process-guard.mjs` builds the Linux guard with hardening flags.
6. `stage.mjs` builds the guard on Windows and Linux and writes the measured
   minimum. Read, no change needed: `licenses.mjs` (the Linux guard falls
   under the first-party default), `measure.mjs` and `size.mjs` (a target
   without a baseline is held to the hard caps), and the PyInstaller spec
   (no macOS-only setting applies off macOS).
7. `electron-builder.yml` (`toolsets.appimage`, `executableName`,
   `executableArgs: []`, the runtime and icon resources);
   `package-development.mjs` is now `developmentPackage()` plus a `main()`
   that runs only as a script, and checks the AppImage's own desktop entry;
   `pack:linux`, `build:linux`, `desktop:linux:build`. `dist:linux` is gone.
8. `test-runtime-termination-linux.mjs` and a dispatcher. Unlike the Windows
   harness it does not require the worker's exit code to be zero, which a
   SIGINT stop may not give; G2 records what it is.

Test order: the tests for steps 1–5 and 7 were written with the code, not
before it. Steps 6 and 8 have no unit test: they are wiring and a host-only
harness.

Check record (2026-11-24, macOS arm64 host; export of the staged tree,
`git archive e672fb867b34`; working directory `src/frontend`):

| Command | Result | Tree |
| --- | --- | --- |
| `pnpm desktop:test` | Pass: 47 files passed, 2 skipped; 780 tests passed, 16 skipped | `e672fb867b34` |
| `pnpm desktop:check` | Pass | `e672fb867b34` |
| `pnpm desktop:build` | Pass | `e672fb867b34` |
| `pnpm prettier:check` | Pass | `e672fb867b34` |
| `python3 scripts/public-release/check_source.py` (repository root, worktree index) | Pass | `e672fb867b34` |

Linux container run (2026-11-24, `node:24-bookworm`, aarch64, gcc 12.2,
glibc 2.36; not the target architecture and not the reference system). A
scratch driver called the new code directly, because `parseTarget` rightly
refuses that host:

- `buildPostgresLinux` configured, built and staged PostgreSQL 16.15 and
  pgvector 0.8.6. The staged closure is the six programs, `libpq.so.5`, the
  two extensions, PL/pgSQL, the snowball dictionary and the encoding
  conversions.
- Every program carries the run path `$ORIGIN/../lib` and needs only libc,
  libm and the staged libpq.
- `buildProcessGuard` compiled the guard with its hardening flags.
- `auditLinuxStage` passed on the 36 ELF files and measured `glibc-2.34`,
  the same value `measureMinimumOs` gave.
- `initdb` created a cluster; `pg_isready` run through the guard printed the
  handshake and then its answer; `pg_dump` connected with the password; in
  single-user mode `CREATE EXTENSION vector` and `pg_trgm` succeeded and
  reported 0.8.6 and 1.6.

Not run: the full pre-push suite, by the owner's standing instruction;
`runtime:stage`, `runtime:audit` and `pack:linux` anywhere; the frozen
backend build, the web build, electron-builder and its AppImage toolset on
Linux; the termination harness. Those are G1 and G2.

### Phase 6: Press to talk on X11

Review tier: high risk. Native code that listens to input from other
applications.

Requirements: R8. Acceptance: the logic behind A8. Depends on Phase 5 and on
PD10.

Steps, tests first:

1. **Key table and matcher.** `hook_linux_keys.h` maps the binding's key
   codes to X11 key codes and decides down and up transitions with
   modifiers. `tests/hook_linux_test.cc` covers it and compiles on any host.
   `test-global-input-hook.mjs` gains a Linux branch, and its macOS branch
   also builds and runs this portable test.
2. **Hook.** `hook_linux.cc` implements the interface with XInput 2 raw
   events. It emits only the matched binding's transitions and forwards no
   other input. It reports unsupported when no X display opens, when XInput
   is older than 2.1, or when the session is Wayland. `binding.gyp` gains the
   Linux source and libraries.
3. **Status.** `shortcuts-ipc.ts` reports why Press to talk is unavailable on
   a Wayland session, with a test. The audit's compiled-file list gains the
   hook's X11 libraries.

Checks, from `src/frontend`: `pnpm desktop:test`, `pnpm desktop:check`,
`pnpm desktop:build`, `pnpm prettier:check`, and
`pnpm desktop:test:native-input` for the matcher test.

Limits to record: the hook itself does not compile on macOS. Its first build
and run are G1 and G4.

Recovery: source-only.

Completion: the checks pass and the review finds no open blocker.

Starting source: `13f63b958` (Phase 5).

Results:

- `src/hook_linux_keys.h`: the key table (X key code is the evdev scan code
  plus 8), the button mapping, the modifier mask, the session check and
  `HoldMatcher`, which turns raw presses and releases into at most one down
  and one up. No X11 header.
- `src/hook_linux.cc`: its own thread and display connection; XInput 2.1 raw
  key or button events on the root window for all master devices; modifier
  state from `XkbGetState`, asked only when the bound key goes down; a pipe
  to stop the thread. A lost X connection or a stop releases a held binding.
  It installs an Xlib error handler that ignores protocol errors, because
  Xlib's default ends the process.
- `binding.gyp` builds it on Linux against `libX11` and `libXi`.
  `hook_unsupported.cc` now serves other systems only.
- `pressToTalkUnsupportedReason()` gives the renderer the Linux reason.
- `test-global-input-hook.mjs` builds and runs `tests/hook_linux_test.cc` on
  Linux x64, and on macOS beside the macOS test.

The audit's library list for the hook was already in Phase 5's lock.

Test order: the matcher test and the header were written together; the
TypeScript reason was written test first. `hook_linux.cc` itself has no test
in the repository: it needs an X server.

Check record (2026-11-24, macOS arm64 host, working directory
`src/frontend`, in the worktree with exactly this phase's changes on top of
`13f63b958`):

| Command | Result |
| --- | --- |
| `pnpm desktop:test` | Pass: 47 files passed, 2 skipped; 781 tests passed, 16 skipped |
| `pnpm desktop:check` | Pass |
| `pnpm desktop:build` | Pass |
| `pnpm prettier:check` | Pass |
| `pnpm desktop:test:native-input` | Pass: 1046 macOS matcher assertions, then 554 Linux matcher assertions |
| `python3 scripts/public-release/check_source.py` (repository root) | Pass |

Linux container run (2026-11-24, `node:24-bookworm`, aarch64, g++ 12.2,
Xvfb; not the reference system). A scratch driver, not in the repository,
compiled `hook_linux.cc` with `-Wall -Wextra -Werror`, started the real hook
and injected input with `xdotool`:

| Case | Downs, ups |
| --- | --- |
| Tap the bound key | 1, 1 |
| Another key | 0, 0 |
| Bound key with Shift held, binding without Shift | 0, 0 |
| Bound key held 1.5 seconds, through the server's auto-repeat | 1, 1 |
| Ctrl+key binding with Ctrl held | 1, 1 |
| Ctrl+key binding without Ctrl | 0, 0 |
| Ctrl+key binding, Ctrl released before the key | 1, 1 |
| Left mouse button binding | 1, 1 |
| Right button against a left-button binding | 0, 0 |
| Hook stopped while the key is held | 1, 1 |
| A key the table does not know | refused |

Not run: the full pre-push suite, by the owner's standing instruction; the
addon build through `node-gyp` on Linux; the hook inside Electron; a real
keyboard, i3 or another focused application. Those are G1 and G4.

### Owner and hardware gates

Each gate runs on the reference system at a recorded commit of this branch.
A failure is repaired on the branch, reviewed at the tier of the code it
touches, and the affected steps are run again. Receipts name the commit, the
distribution, kernel, session and desktop, and give each command with its
result. They carry no personal data, host names or home paths.

**G1, build (A1).** After Phases 1–5; Phase 6 if authorized.

1. Install the prerequisites and record the package names: the C toolchain,
   Git LFS, Node 24, pnpm, uv, the X11 and XInput headers, and FUSE.
2. Fresh clone, `git lfs pull`,
   `python3 scripts/models/browser_speech.py acquire`, then from
   `src/frontend`: `pnpm install --frozen-lockfile`,
   `pnpm desktop:runtime:stage -- --platform linux --arch x64`,
   `pnpm desktop:runtime:audit -- --platform linux --arch x64`,
   `pnpm desktop:linux`.
3. Record the stage and audit reports, the measured minimum, the compiler
   and C library versions, the launcher toolset used, and the AppImage's
   name and size.
4. Run `pnpm desktop:test` on the reference system, including the guard
   suite against the natively built guard.

**G2, run, data and processes (A2, A3, A4, A6, A7).**

1. With no development server running, start the AppImage on a fresh data
   directory and complete the fresh-profile journey, recording each step.
2. Quit and reopen. Delete and replace the AppImage. Open the data with a
   build from a later commit that adds a migration. If the branch has no
   later migration by then, the second build adds a throwaway no-op revision
   that is never committed, and the receipt says so.
3. `pnpm desktop:test:termination`. Also check review finding P2-F5: with
   the AppImage killed outright, start it again at once and record whether
   the second launch waits for the first launch's services. A lazily
   detached AppImage mount makes their images read differently from the
   record.
4. Confirm the renderers run sandboxed. Start the AppImage with
   `--no-sandbox`, and again with `ELECTRON_DISABLE_SANDBOX=1`, and record
   the message, the exit and that no service started.
5. On i3: PiP floating, workspaces and transparency with and without a
   compositor; Quick Chat from its shortcut; one-shot global shortcuts.

**G3, credentials (A5).**

1. `pnpm desktop:test:vault` with the secret store running; record the
   selected store and that the vault is protected.
2. Stop the secret store and run the consent checks of A5 on a fresh data
   directory. Start the store again and record the vault moving under it.
3. Open a protected vault with the store stopped and record the recovery.

**G4, features (A8, A12).** For each of R8–R10 that was implemented, and for
R14.

1. Press to talk held from another application, with a key and with a mouse
   button.
2. Click-through on PiP and Quick Chat, with close, drag and resize. Repeat
   the toolbar checks after switching workspace, and type in Quick Chat with
   the pointer moved off the input onto the pass-through area (i3 focuses
   the window under the pointer).
3. Launch at login: on, log out and in, moved file, off. Record whether the
   session's i3 configuration runs an autostart helper, and what the
   desktop's own autostart tool, if any, does to the entry file.
4. Menu entry: on, launch from the desktop's launcher, moved file and
   repoint, off.

### Phase 7: documentation and decision record

Review tier: light. Documentation and agent guides; the final integration
review covers it.

Requirements: R13. Acceptance: A10. After G1, because the README steps must
be the ones G1 followed.

- README: Linux steps under Self-host > Desktop, and the qualification of the
  encrypted-keys sentence.
- `docs/frontend/desktop`: `platforms.md` (Linux build, the gates table),
  `runtime-staging.md`, `installation.md`, `overview.md` (data root, process
  guard, credentials), `troubleshooting.md` (secret store, compositor,
  sandbox, FUSE, older systems), `picture-in-picture.md`, `quick-chat.md`
  and `keyboard-shortcuts.md` for whichever of R8–R10 were implemented.
- `AGENTS.md` and `src/frontend/AGENTS.md`: the supported targets and the
  Linux commands.
- A new ADR, numbered when written, recording the choices that are costly to
  reverse: source build only, the data root, guard ownership on Linux, the
  credential fallback and the sandbox refusal.
- Every statement about Wayland says it is untested (D11).

Checks: links resolve; `pnpm prettier:check` for any touched non-Markdown
file; `python3 scripts/public-release/check_source.py`.

## Final integration review

After the authorized phases and gates: one independent review of combined
acceptance, the folded Phase 7, and the interaction between the guard, the
vault stage and the startup page. It reuses passing phase evidence and runs
no checks of its own. Then, with the owner's go-ahead, the full pre-push
suite once on the final candidate: root `make check-test`, and from
`src/frontend` `pnpm verify`, `pnpm web:test:browser` and
`pnpm prettier:check`, each through `scripts/heavy-slot.py`. Results go in
the pull request.

Before any push or `gh pr create`, check `gh workflow list --all`: the hosted
Validation workflow stays disabled unless the owner enables it.

## Validation and acceptance

| Criterion | Established by | Evidence |
| --- | --- | --- |
| A1 | G1 | Build receipt from the reference system |
| A2 | G2 step 1 | Recorded journey |
| A3 | Phase 1 tests for the path rule; G2 step 2 | Tests; recorded checks |
| A4 | Phase 2 tests for the guard logic; G2 step 3 | Tests; harness output |
| A5 | Phase 3 tests for the transitions; G3 | Tests; recorded checks |
| A6 | Phase 3 tests for the refusal; G2 step 4 | Tests; recorded check |
| A7 | G2 step 5 | Recorded manual checks |
| A8 | Feasibility notes and PD10; Phases 4 and 6; G4 | Decision; tests; recorded checks |
| A9 | Phases 1 and 4 | Tests |
| A10 | Phase 7 | Reviewed documents |
| A11 | Every phase's `pnpm desktop:test` | Check records |
| A12 | Phase 4 tests; G4 step 4 | Tests; recorded checks |

A criterion with a gate is open until that gate's receipt exists, whatever
the tests say. Suites that need a staged macOS or Windows runtime are skipped
where that runtime is absent; each check record gives the skipped count, and
no Windows behavior is claimed from the macOS host.

## Idempotence and recovery

- Phases 1–6 change source only and revert with their commits.
- A stage removes and rebuilds only `.desktop-runtime/linux-x64`. The build
  root holds caches that are safe to delete.
- The app's data directory is never touched by a build. Gate checks use
  fresh data directories, and the receipts say which.
- The autostart entry, the menu entry and its icon are single files that the
  app removes through its own settings and that are safe to delete by hand.
  Consent to unprotected storage leaves no file of its own.
- Nothing is published, signed or uploaded by any step in this plan.

## Outcomes & Retrospective

Not yet delivered.
