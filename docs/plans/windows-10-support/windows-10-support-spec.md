# Windows 10 support for the desktop app

Status: Agreed
Owner decision: 2026-11-24. Decisions D1–D5 are the owner's intent-discovery
answers. The owner accepted this text, including proposals P1–P3, by
requesting the ExecPlan, and P4 by agreeing the plan the same day. Questions
Q1–Q3 stay open until the plan's gates answer them.
Authoritative source: https://github.com/raymond-van/animama/issues/913, published and read
back 2026-11-24T17:33:35Z. This file is a snapshot of that publication.

## Problem and intended users

The self-contained desktop app runs on Windows 11 x64 only. Windows 10 was a
non-goal of the Windows port
([#245](https://github.com/raymond-van/animama/issues/245)), and three
independent checks refuse it:

- The installer stops with "Animama requires Windows 11 or later." below build
  22000 (`desktop/build/installer.nsh`).
- The app's startup check reports `unsupported_runtime_platform` below build
  22000 (`desktop/src/main-process/runtime/manifest.ts`).
- The update feed and the staged runtime manifest declare `10.0.22000` as the
  minimum (`updates/policy.ts`, `runtime/source-manifest.json`,
  `runtime/native-components.win32-x64.lock.json`,
  `scripts/runtime/release-artifacts.mjs`).

No Windows 11 dependency is recorded. Electron 45.3.1 states "Windows 10 and
up". The process guard uses Job Objects and the input hook uses low-level
keyboard and mouse hooks, both older than Windows 10. The one version-bound
component found is PostgreSQL's UTF-8 active code page manifest, which needs
Windows 10 version 1903. Whether the frozen server, PostgreSQL and the speech
engines actually run on Windows 10 has not been tested.

Users:

- People with Windows 10 x64 PCs who asked for Animama and cannot install it.
- People building the desktop app from source on Windows.
- Existing Windows 11 owners, for whom nothing may change or break.

## Goals, scope and non-goals

Goal: the existing x64 installer and app install, start and run on Windows 10
22H2, whether the installer was published or built from source.

In scope:

- One lower Windows floor in the installer, the startup check, the staged
  runtime manifest and the update metadata.
- Updates that keep working for installed Windows 11 apps and work for
  Windows 10 installs.
- Every user-facing statement of the Windows requirement.
- One attempt to build from source on a Windows 10 22H2 host (D5).

Non-goals:

- Windows on ARM, 32-bit Windows, and Windows 8.1 or earlier.
- A performance target on older hardware (D3).
- Testing Windows 10 versions older than 22H2, or the LTSC editions (D2).
- Windows feature packs, which are not built for any Windows version yet.
- Any change to the signing identity, installer type, install location or
  process guard decided in
  [ADR 0013](../../adr/0013-native-windows-desktop-packaging.md).
- Requirement text on the Animama Cloud landing and documentation sites (P3).

## Terms

- **Floor**: the lowest Windows build the installer and the app accept.
- **Claimed version**: what the documentation says is supported and tested:
  Windows 10 22H2 (build 19045) and Windows 11.

## Required behavior

### R1 Install and run on Windows 10 22H2

On a clean Windows 10 22H2 x64 machine the installer installs for the current
account without elevation, as ADR 0013 describes, and the app completes the
fresh-profile journey used for Windows 11:

- Animama starts with no Docker, Node, Python or PostgreSQL present.
- The required name, a provider key, chat with both starter Animas and
  cancellation work.
- Pocket TTS, Avatar animation, fullscreen, PiP, Quick Chat and shortcuts work,
  including Press to talk with a held key.
- After quit and reopen, the installation owner, content and chat history are
  unchanged.
- Every process Animama started exits on quit and after a force close.

### R2 One floor, enforced the same way everywhere

The installer, the startup check, the staged runtime manifest and the update
metadata agree on one floor. No machine is accepted by the installer and then
refused by the app.

Below the floor the existing refusals remain:

- The installer shows a message naming the requirement, and a silent run exits
  with status 1150.
- The app's recovery screen names the requirement and says the data has not
  changed.

### R3 Floor value (P1)

The floor is Windows 10 version 1903 (build 18362), the oldest build a shipped
component is known to need. If testing under R1 shows that a component needs a
newer build, the floor rises to that build and this spec records it.

The documentation claims Windows 10 22H2 and later. Builds between the floor
and 22H2 are not blocked and are described as untested.

### R4 Updates for existing Windows 11 installs

A published Windows 0.1.6 install, preview or stable, is offered the first
release that contains this change, installs it and keeps its data. The same
holds for later releases.

### R5 Updates for Windows 10 installs

A Windows 10 install of a release that contains this change is offered later
releases and installs them, with the same publisher and hash verification as
on Windows 11.

### R6 Windows 11 is unchanged

Install, upgrade over an existing install, uninstall that keeps data, and
reinstall behave on Windows 11 exactly as they do in 0.1.6.

### R7 Messages and documentation

Every user-facing statement names the new requirement:

- The installer message.
- The `unsupported_runtime_platform` text in `en`, `ja`, `ko`, `zh-Hans` and
  `zh-Hant`.
- The README download table and Windows build prerequisites.
- The desktop documents that state the requirement: installation, platform
  builds, releases, release process, overview and runtime staging, and the
  backend desktop-runtime document.
- The desktop release skill's references.

The installation document also says that Microsoft ended support for
Windows 10 on 14 October 2025 (P2), and that performance on older graphics
hardware is best effort (D3).

Historical records keep their wording: ADRs, earlier plans and release notes.

Statements tied to a published installer change with the first release that
contains this change, not before (P4). The README download table and the
installation document's current-release text describe 0.1.6, which still
refuses Windows 10.

### R8 Source build on Windows 10 (best effort)

Stage, audit and package once on Windows 10 22H2 with the documented
prerequisites.

- If it succeeds, the README names Windows 10 22H2 or Windows 11 as the build
  host.
- If it fails for a reason documentation cannot fix, the README keeps
  Windows 11 as the build host and the failure becomes a follow-up issue. This
  does not block R1–R7.

## Constraints

- **C1 Update compatibility.** Installed 0.1.6 apps accept a feed only when its
  `minimumSystemVersion` is exactly `10.0.22000`; any other value is rejected
  as invalid metadata (`validateUpdateCandidate`). Separately, electron-updater
  6.8.11 withholds an update whose feed minimum is above the running system.
  R4 and R5 must both hold. How is the plan's choice.
- **C2 ADR 0013.** Signing identity, per-user install, shared distribution with
  per-platform files and guard ownership do not change. Signatures use account
  quota, so only intentional candidates are signed.
- **C3 Data.** No database, profile or `%LOCALAPPDATA%\Animama` layout change.
- **C4 Security.** Windows 10 no longer receives free security updates from
  Microsoft. Animama's own protections stay as they are on Windows 11:
  loopback-only services, the DPAPI-protected credential vault, the fuse wire
  and the Chromium sandbox. Nothing is weakened to make Windows 10 work.
- **C5 Existing tests.** Several suites pin 22000. They move to the new floor
  and keep their boundary cases; they are not deleted.
- **C6 Performance.** No bound (D3). PCs limited to Windows 10 tend to have
  older integrated graphics; slow Avatar rendering there is a known risk, not a
  defect of this change.
- **C7 Accessibility and localization.** No new surface. Changed text is
  translated in all five locales.

## Acceptance criteria

- [ ] **A1 (R1).** A receipt from a clean Windows 10 22H2 x64 install (build
      19045) names the commit, the Windows build number and the installer
      hash, and records each step of the R1 journey. A virtual machine is
      acceptable; the receipt names the graphics adapter, because VM graphics
      do not represent real hardware.
- [ ] **A2 (R1).** Process cleanup, credential storage and Press to talk are
      shown on Windows 10. Either `desktop:test:termination`,
      `desktop:test:vault` and `desktop:test:native-input` pass there, or the
      manual equivalents are recorded: no Animama process remains 30 seconds
      after a force close, the provider key survives a restart, and a held key
      unmutes and re-mutes Voice Mode.
- [ ] **A3 (R2, R3).** Automated tests cover the floor for the startup check
      and the update metadata: accepted at the floor, refused one build below
      it and refused for a non-`10.0` release. The installer's refusal is
      exercised on a machine below the floor if one is available; otherwise it
      is reviewed and recorded as not exercised.
- [ ] **A4 (R4).** An automated test holds the feed fields that installed 0.1.6
      validates and fails if the generated Windows feed changes them. The
      existing release gate then shows a real in-app update from installed
      0.1.6 on Windows 11.
- [ ] **A5 (R5).** An automated test shows that the app, on a Windows 10
      release string, accepts a candidate from the generated feed. A real
      in-app update on Windows 10 needs two signed versions that both accept
      Windows 10; it is recorded as an open gate on the second such release
      (Q3).
- [ ] **A6 (R6).** The Windows 11 install, upgrade and uninstall-keeps-data
      journey passes on the candidate.
- [ ] **A7 (R7).** The installer message, the five locale strings and the
      listed documents state the new requirement. A search for "Windows 11"
      finds requirement statements only in historical records and in text
      tied to the published 0.1.6 installer (P4).
- [ ] **A8 (R8).** The result of the Windows 10 source build is recorded, with
      the README updated or the follow-up issue linked.

## Open questions and decisions

Decisions (owner, 2026-11-24):

- **D1.** Windows 10 uses the same installer as Windows 11. Published Windows
  releases and their update feed accept it; there is no separate artifact.
- **D2.** Windows 10 22H2 is the tested and claimed version. Wider
  compatibility is welcome where it works but is not the focus.
- **D3.** "Supported" means the app installs, starts and completes the normal
  journey. There is no performance bar for older hardware.
- **D4.** Windows 10 is its own issue and comes before Linux desktop
  packaging.
- **D5.** Building from source on Windows 10 is worth having if it stays
  simple.

Proposals, all accepted by the owner on 2026-11-24:

- **P4.** Requirement text tied to the published 0.1.6 installer changes with
  the first release that contains this change, so the documentation never
  claims Windows 10 for an installer that refuses it.
- **P1.** The enforced floor is build 18362 (version 1903) rather than 19045,
  following D2's "wider where it works". The alternative is 19045, which
  blocks every version that is not tested.
- **P2.** The installation document states Windows 10's end of support in one
  sentence.
- **P3.** The Animama Cloud landing and documentation sites state "Windows 11"
  in their download and self-host text. They change in a Cloud follow-up once
  a release contains this change, not here.

Open questions:

- **Q1.** Which machine hosts the Windows 10 test install, and can it also
  build (R8)? Windows 10 x64 needs an x64 host.
- **Q2.** Does any shipped component need a build newer than the floor? A1
  answers this.
- **Q3.** When is the real Windows 10 in-app update (A5) run: on the second
  release that accepts Windows 10, or earlier with two signed candidates?

## Spec

https://github.com/raymond-van/animama/issues/913

## ExecPlan

[windows-10-support-execplan.md](windows-10-support-execplan.md). Required
because the change alters update metadata that installed apps read (C1) and
depends on native Windows 10 evidence.

## Delivery links

None yet.
