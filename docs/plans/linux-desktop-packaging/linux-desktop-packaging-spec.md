# Self-contained Linux desktop app, built from source

Status: Agreed
Owner decision: Accepted 2026-11-24. D1–D13 are the owner's decisions of that
date; P1, P3, P6 and P7 were accepted with the text.
Authoritative source: https://github.com/raymond-van/animama/issues/920,
published 2026-11-24T18:42:42Z and last read back 2026-11-24T20:02:31Z, after
its ExecPlan and Delivery links sections were filled in. This file is a
snapshot of that issue.

## Problem and intended users

On Linux, Animama runs only as a web server under Docker Compose, optionally
with the Electron shell pointed at that server (`pnpm desktop:dev`). That
launch has no embedded services and no in-app provider-key controls. There is
no self-contained Linux app:

- Runtime staging accepts `darwin-arm64` and `win32-x64` only, and refuses to
  cross-build (`desktop/scripts/runtime/common.mjs`).
- The packaging gate rejects every other target
  (`desktop/scripts/before-build.mjs`). The `linux` AppImage entry in
  `desktop/electron-builder.yml` is left over from an earlier shell-only
  build.
- PostgreSQL and pgvector are built for macOS and Windows only
  (`desktop/scripts/runtime/native.mjs`).
- Press to talk's global input hook has macOS and Windows implementations
  only. Launch at login reports itself unavailable on Linux, and PiP and Quick
  Chat click-through are switched off there.

Users:

- People on Linux desktops who asked for the desktop app.
- People who build Animama from source.

## Goals, scope and non-goals

Goal: on a Linux x64 desktop, a documented source build produces one AppImage
that runs Animama with its own embedded services, needing no Docker, Python,
Node or PostgreSQL at run time.

In scope:

- A `linux-x64` embedded runtime target: the frozen server, private
  PostgreSQL with pgvector, the embedded web build and the browser speech
  engines, staged and audited like the other targets.
- AppImage packaging (D2).
- Linux behavior for data location, process ownership, credential storage,
  the sandbox, windows, PiP, Quick Chat and shortcuts.
- An attempt at three features Linux lacks today: Press to talk with a held
  key, click-through, and Launch at login (D5).
- A setting that adds an application-menu entry (D13).
- Build and troubleshooting documentation.

Non-goals:

- Published downloads, signing, an update feed, in-app updates, and release
  smoke or publication tooling for Linux (D1, D4).
- Linux on arm64 (P1).
- `.deb`, `.rpm`, Flatpak, Snap or distribution-repository packages.
- Any distribution other than the reference system as a claimed target (P7).
- Wayland as a claimed or tested session (D11).
- Verifying feature packs on Linux. They behave as in any source build (R12).
- Cross-building from macOS or Windows, and container builds (D10).
- Performance targets.
- Animama Cloud changes.

## Terms

- **Reference system**: the owner's x64 desktop running EndeavourOS, an
  Arch-based distribution (D3).
- **Reference session**: the i3 window manager on X11, with a secret store
  running. i3 is a tiling window manager and runs on X11 only.
- **Session type**: X11 or Wayland.
- **Source build**: an unsigned app built on the machine that will run it.
- **Secret store**: an operating-system credential service: one that offers
  the Secret Service interface, such as GNOME Keyring or KeePassXC, or
  KWallet.

## Required behavior

### R1 Build from source

On the reference system, the documented commands stage and audit a complete
`linux-x64` runtime and package one AppImage under `desktop/release`.

- The build runs directly on the machine (D10). Its prerequisites are the
  distribution's compiler packages plus Node, pnpm, uv and Git LFS. It needs
  no container and no system AppImage tooling.
- Like the other targets, it downloads pinned, digest-checked inputs: the
  PostgreSQL and pgvector sources, the build interpreter and electron-builder's
  AppImage tools.
- A missing prerequisite, an incomplete stage or a failed audit stops the
  build with a message naming the cause. As on other targets, no shell-only
  wrapper is ever produced.
- Building on Linux arm64 or any other architecture is refused (P1).

### R2 Self-contained run

With no Docker, Node, Python or PostgreSQL running, the AppImage starts on the
reference system and completes the fresh-profile journey used for macOS and
Windows:

- The required name, a provider key, chat with both starter Animas and
  cancellation work.
- Pocket TTS, Avatar animation, fullscreen, PiP, Quick Chat and one-shot
  shortcuts work.
- After quit and reopen, the origin, installation owner, content and chat
  history are unchanged, and the app opens the last visited Anima.

### R3 Data location and persistence (D9)

All of the installation owner's data lives in one per-user directory outside
the AppImage: `Animama` under `$XDG_DATA_HOME`, or under `~/.local/share` when
that variable is unset or is not an absolute path. Electron's own profile
files live in the same directory, as they do on macOS and Windows.

- Replacing, moving or deleting the AppImage never changes the data.
- A newer build opened on existing data upgrades it in place, under
  [ADR 0035](../../adr/0035-released-schema-changes-use-forward-migrations.md).
- An older build opened on newer data shows the existing recovery screen and
  changes nothing.
- A profile that an earlier Linux development run left under
  `~/.config/Animama` is not moved. It holds no installation data.

The location is costly to change once people have data in it, so it is
settled before the build is documented.

### R4 Process ownership

Every process Animama starts exits when the app quits. When Electron is killed
outright at any startup stage, no owned process remains 30 seconds later, and
the next launch on the same data reaches ready with the same origin.

macOS has no such guarantee today and Windows needed a guard process (F5), so
Linux gets its own mechanism.

### R5 Credential storage

Provider keys and the database password live in the vault file, which
Electron encrypts with a key held by a secret store. With a secret store in
use, behavior matches macOS and Windows.

Electron chooses the Linux secret store from the desktop's name, not by
looking for one (F2). On a desktop it does not recognise, such as i3, Sway or
Hyprland, it uses a fixed built-in key even when a secret store is running,
and still reports encryption as available. Its documentation calls that
storage unprotected. So on Linux:

- The app uses a running secret store on any desktop, including the ones
  Electron does not recognise. The reference session is one of them.
- The app itself determines whether the vault is protected by a secret store.
  It never treats the built-in key as protection.

On macOS and Windows, unavailable encryption shows a recovery screen and
preserves data. The database password lives in the same vault on every
platform, so the app cannot start its services without writing one. On Linux,
when no secret store is available, the app warns and then continues (D8):

- Before the vault or the database is created, a screen says that keys will
  be saved without system protection, readable by any program running under
  this account, and names how to add a secret store. It offers Continue and
  Quit.
- Quit creates neither. Continue is remembered for that data directory, so
  the question is asked once.
- While the built-in key is in use, the place where provider keys are entered
  says so.
- The vault file stays readable by the owner's account only, as today.

Two transitions follow (P3):

- If a secret store becomes available later, the next launch moves the vault
  under its protection without asking.
- If a vault protected by a secret store cannot be opened because that store
  is missing or locked, the app shows the existing secure-storage recovery,
  with Linux wording, and preserves the data. It never falls back silently.

This applies to Linux only. macOS and Windows keep their current behavior.

### R6 The Chromium sandbox stays on (D12)

The packaged app never runs with the Chromium sandbox disabled, however that
was requested: by the user, by a desktop entry, or by the AppImage launcher,
which adds `--no-sandbox` by itself on a system that blocks the sandbox (F3).

- Started that way, the app shows a message that names the cause and the
  remedy, then quits. It starts no services and does not continue
  unsandboxed.
- Entries the app writes (R10, R14) never disable the sandbox.
- `ANIMAMA_DESKTOP_DISABLE_CHROMIUM_SANDBOX` remains accepted only in
  unpackaged development.

### R7 Windows and shortcuts on the reference session

- The main window, fullscreen and title bar behave as Linux development runs
  do today.
- PiP floats above other windows on every workspace. It is transparent where
  a compositor provides transparency. Without one it is opaque, which the
  documentation states.
- Quick Chat opens from its global shortcut.
- One-shot global shortcuts work.

Wayland is attempted without being claimed (D11). Each feasibility note under
R8–R10 also covers Wayland, and what costs little is built. Nothing is tested
on Wayland, and the documentation says so. Known limits there (C6) are
documented, not fixed.

### R8–R10 Three features to attempt (D5)

- **R8 Press to talk.** A held key or mouse button unmutes Voice Mode from
  any application on the reference session.
- **R9 Click-through.** Clicks on the non-interactive part of PiP and Quick
  Chat reach the window beneath, while close, drag and resize stay reliable.
- **R10 Launch at login.** The setting starts the AppImage with the desktop
  session from its current path. If the file has moved, the setting shows that
  it will not take effect. Turning it off removes the entry. It relies on the
  session processing autostart entries; where a session does not, as i3 does
  only through a helper program, the documentation says so.

All three have equal priority. Each gets a short feasibility note before
implementation: the approach, its cost and its limits on X11 and Wayland. The
owner then decides to implement or defer that feature. A deferred feature
shows as unavailable on Linux with a reason, as it does today, and the
documentation says so.

### R11 No in-app updates (D4)

On Linux the app never requests an update feed and never shows an update
prompt or an update error. The place that shows the version says that this
build is updated by pulling the source and rebuilding.

### R12 Optional features

Optional features behave as in a source-built macOS or Windows app. The
built-in voices and turn detection are bundled from the acquired model inputs.
Optional offline speech installs through Voice settings wherever that build
offers it.

### R13 Messages and documentation

- The `unsupported_runtime_platform` text names Linux x64, in all five
  locales.
- The README's Self-host > Desktop section gains Linux build steps.
- The platform builds, runtime staging and installation documents, and the
  agent guides, describe the target: built from source, tested on the
  reference system, other distributions and Wayland best effort.
- Troubleshooting covers the secret store, compositors and transparency, the
  sandbox on restricted systems (C4), the AppImage launcher's requirements
  (C5) and running a build on a system older than the one that built it (C3).
- The PiP and keyboard-shortcut documents reflect whichever of R8–R10 are
  implemented.
- The README's statement that keys stay encrypted on the computer is
  qualified for a Linux build without a secret store (R5).

### R14 Application-menu entry (D13)

The AppImage is one file that the user runs directly; nothing installs it. A
setting beside Launch at login adds an application-menu entry and icon for
the AppImage at its current path, for this user only.

- Nothing is added until the setting is turned on. Turning it off removes the
  entry and the icon.
- The entry starts the same app on the same data.
- If the file has moved, the setting shows that the entry no longer works and
  offers to point it at the running file.
- The setting is unavailable when the app is not running from an AppImage.

## Constraints

- **C1 Existing runtime contracts.** The accountless local runtime, loopback
  only services, runtime manifest, PostgreSQL major 16, fuse wire and
  packaged debugging guard apply to `linux-x64` unchanged. A complete fresh
  stage and a successful audit are mandatory.
- **C2 Licences.** The stage produces the licence inventory and third-party
  notices for every component the Linux build adds. Nothing is published, so
  no redistribution review receipt is required (P6). The macOS and Windows
  development packages already work this way: only their release gates ask
  for a receipt.
- **C3 Portability.** A Linux binary runs only on systems whose C library is
  at least as new as the one it was built against. A source build is
  therefore for the builder's own system (F6). The stage measures the C
  library version its binaries need and records it as the build's minimum
  system. On an older system the app shows the unsupported-platform message
  instead of failing obscurely. Building on an older base to widen the range
  is not documented.
- **C4 Restricted user namespaces.** Ubuntu 23.10 and later restrict
  unprivileged user namespaces through AppArmor, and Chromium documents that
  its primary sandbox does not work there for a binary without a profile. Its
  other sandbox cannot work from inside an AppImage (F3). Animama therefore
  does not run on such a system until the user adds a profile or lifts the
  restriction (R6). Ubuntu is not claimed.
- **C5 AppImage launcher.** An AppImage mounts itself through FUSE. The
  pinned electron-builder's default launcher also needs the FUSE 2 library on
  the user's system; its newer launcher needs only the `fusermount` helper
  (F4). The plan chooses between them. Without FUSE, the file can still be
  run with the launcher's extract-and-run option, which unpacks it on every
  start.
- **C6 Wayland.** By Electron's documentation, an app there cannot place its
  own windows or keep them above others, and cannot learn where a window is.
  Global shortcuts go through the desktop's portal, which only some desktops
  provide, and Electron reports the press but not the release. Outside that
  portal an app has no listen-only access to keys pressed in other
  applications. See D11.
- **C7 Other targets.** `darwin-arm64` and `win32-x64` stages, manifests,
  installers and update behavior do not change. The work builds on
  [Windows 10 support](https://github.com/raymond-van/animama/issues/913),
  which edits the same platform tables and messages.
- **C8 Repository boundaries.** No Cloud checkout, private source or private
  pack is needed to build.
- **C9 Performance.** No bound.
- **C10 Accessibility and localization.** The new surfaces are the R5 warning
  and notice, the R6 message, the R11 wording, the R14 setting and the
  moved-file states of R10 and R14. They are keyboard-operable and readable
  by a screen reader. New and changed text is translated in all five locales.
- **C11 Credential fallback.** D8 trades protection for reach. On a desktop
  without a secret store, saved keys are protected by file permissions only,
  and the warning says so plainly.

## Acceptance criteria

Evidence for A1–A8 and A12 comes from the reference system. A check run on
another operating system establishes platform-independent logic only and
never marks one of these passed.

- [ ] **A1 (R1).** From a clean clone at a recorded commit on the reference
      system, the documented commands produce the AppImage. The receipt names
      the distribution, kernel, C library and toolchain versions, the
      measured minimum C library (C3), the FUSE package the launcher used
      (C5), and the stage and audit reports.
- [ ] **A2 (R2).** The fresh-profile journey passes with development servers
      stopped, each step recorded.
- [ ] **A3 (R3).** The data is in the R3 directory and survives deleting and
      replacing the AppImage. A second build from a later commit
      with a newer migration opens the first build's data and upgrades it.
- [ ] **A4 (R4).** An automated termination test, the Linux counterpart of
      `desktop:test:termination`, kills Electron at every startup stage, finds
      no owned process after 30 seconds, and reaches ready again on the same
      data.
- [ ] **A5 (R5).** On the reference session, `desktop:test:vault` passes
      against the secret store and the vault is protected by it. With the
      secret store stopped, a test or a recorded manual check shows the
      warning before the vault and database exist, Quit creating neither,
      Continue remembered on the next launch, and the notice beside the
      provider keys. With the store running again, the next launch moves that
      vault under its protection. A vault created under the secret store
      shows recovery, not the fallback, when the store is absent.
- [ ] **A6 (R6).** The packed app's fuse wire is verified, and its renderer
      processes run sandboxed. Started with `--no-sandbox`, the AppImage
      shows the message, starts no services and exits.
- [ ] **A7 (R7).** Manual checks on the reference session are recorded: PiP
      floating, workspaces and transparency, Quick Chat, and one-shot global
      shortcuts.
- [ ] **A8 (R8–R10).** Each feature has a feasibility note covering X11 and
      Wayland, and a recorded owner decision. An implemented feature has a
      test, automated where input can be injected and manual otherwise. A
      deferred feature shows as unavailable with a reason. Wayland behavior
      is recorded as untested.
- [ ] **A9 (R11).** A test shows that no update feed is requested on Linux,
      and the version display carries the rebuild wording.
- [ ] **A10 (R13).** The listed documents are updated, and the README steps
      are the ones A1 followed.
- [ ] **A11 (C7).** `pnpm desktop:test` passes, and the macOS and Windows
      stage, package and update tests are unchanged in outcome.
- [ ] **A12 (R14).** Turning the setting on adds the entry and icon; the
      desktop's launcher starts the app from it on the same data, sandboxed.
      After the AppImage is moved, the setting shows the entry as broken and
      repoints it. Turning it off removes both files.

## Open questions and decisions

Decisions (owner, 2026-11-24):

- **D1.** Linux is delivered as a source build. Nothing is published.
- **D2.** The package format is AppImage, chosen because one format runs
  across distributions such as Arch and Ubuntu. C3–C5 are the known limits.
- **D3.** The reference system is the owner's Arch-based desktop: EndeavourOS
  with i3 on X11 and a secret store running.
- **D4.** No in-app updates on Linux.
- **D5.** Press to talk, click-through and Launch at login are attempted with
  equal priority. One may be left out only if it proves too costly, by the
  owner's decision.
- **D6.** Linux is its own issue and follows Windows 10 support.
- **D7.** The source-build experience should stay simple.
- **D8.** Without a secret store the app warns and continues after explicit
  consent, rather than refusing to start. Desktops without one are common
  among the intended users.
- **D9.** Data lives under `$XDG_DATA_HOME/Animama` (R3), the XDG place for
  application data, not under the configuration directory that Electron
  defaults to.
- **D10.** The documented build is a native build with distribution packages.
  No container.
- **D11.** X11 and Wayland should both work where that is practical. X11 is
  the accepted session. Wayland is attempted and never claimed: no Wayland
  testing is planned, and the documentation says it is untested.
- **D12.** Where the system blocks the sandbox, the app refuses to start with
  a message. It does not warn and continue.
- **D13.** A setting adds or removes an application-menu entry (R14).

Accepted with the text (owner, 2026-11-24):

- **P1.** x64 only. The reference system is x64, staging cannot cross-build,
  and no arm64 machine is available to verify on.
- **P3.** The R5 details beyond D8: consent asked once per data directory, the
  notice beside the provider keys, the automatic move to a secret store when
  one appears, and recovery instead of a silent fallback for a protected
  vault.
- **P6.** No redistribution review receipt, because nothing is published
  (C2).
- **P7.** Other distributions are best effort and unclaimed until tested.

P2, P4 and P5 of the first draft became D9, D10 and D13.

Findings (2026-11-24) from the repository and from public documentation at
the pinned versions, Electron 45.3.1 and electron-builder 26.18.0. They
answer the first draft's questions Q2–Q6:

- **F2 (Q2).** `safeStorage.getSelectedStorageBackend()` reports the store
  Electron selected, and `basic_text` means the built-in key. The choice
  follows the desktop's name or the `--password-store` switch.
  `isAsyncEncryptionAvailable()` resolves true even with only the built-in
  key, and the asynchronous calls encrypt with it without opting in.
  Decryption reports `shouldReEncrypt` when a key of a different security
  level has become available, which the vault already acts on.
- **F3 (Q3).** Not without a manual step. The launcher that electron-builder
  generates runs `unshare -Ur true` and adds `--no-sandbox` when that fails,
  and its default desktop entry adds the switch too. Chromium's setuid
  sandbox helper cannot work from an AppImage, whose FUSE mount ignores
  setuid bits; that last point is inferred from the kernel's FUSE
  documentation, not stated by Electron.
- **F4 (Q4).** Yes by default. `toolsets.appimage` unset selects the legacy
  launcher, which needs `libfuse.so.2`. Versions `1.0.2` and `1.0.3`, which
  electron-builder labels beta, select a static launcher that needs no FUSE
  library but still needs a `fusermount` helper.
- **F5 (Q5).** Nothing. On macOS the services are spawned directly
  (`desktop/src/main-process/runtime/processes.ts`), and a launch that finds
  a recorded process still alive stops with `previous_runtime_running`. Linux
  can have the kernel signal a child when its parent dies.
- **F6 (Q6).** Electron states no C library minimum. The floor is set by what
  the build compiles locally: PostgreSQL, pgvector, the input hook and any
  process helper. It is measured at A1, not predicted. An older build base
  is not worth documenting under D7 and D10.

Unverified until the Linux gates:

- Whether Electron's asynchronous storage uses the secret store on i3 once
  the app selects one (R5).
- Whether the static launcher runs on the reference system (C5).
- How i3 treats the PiP and Quick Chat windows: floating, stacking,
  workspaces and transparency (R7).

Open question, not blocking:

- **Q7.** Will any of the people who asked test on their own systems?
  Acceptance does not depend on it (P7).

## Spec

https://github.com/raymond-van/animama/issues/920

## ExecPlan

[linux-desktop-packaging-execplan.md](linux-desktop-packaging-execplan.md).
Required because this adds a native runtime target and new platform behavior,
with hardware gates on the reference system.

## Delivery links

- Pull request: https://github.com/raymond-van/animama/pull/922 (draft),
  branch `build/linux-desktop-packaging`. One pull request for the plan.
- Follows [Windows 10 support](https://github.com/raymond-van/animama/issues/913)
  (D6): the branch is stacked on that work and stays a draft until it reaches
  `main`.
- Phases 1–6 are implemented on macOS; Phase 7 (documentation) follows the
  first Linux build.
- Owner and hardware gates G1–G4 on the reference system are recorded in the
  plan and the pull request.
