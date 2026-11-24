# 0038: The Windows update feed's minimum system version is frozen

- Status: accepted (owner, 2026-11-24)
- Recorded: 2026-11-24
- Retrospective: no
- Original decision date: 2026-11-24 (owner agreement of the Windows 10
  support plan, decision PD1, tracked in
  [#913](https://github.com/raymond-van/animama/issues/913))
- Decision basis: Explicit owner decision

## Context

Windows 0.1.6 was published for Windows 11 only. Its update check rejects a
feed unless the feed's `minimumSystemVersion` is exactly `10.0.22000`.
Separately, electron-updater reports no update when the running system is
below that value.

Supporting Windows 10 lowered the app's floor to build 18362. Both groups of
installs then had to keep updating from the one `latest.yml` that
[ADR 0013](0013-native-windows-desktop-packaging.md) gives Windows: existing
0.1.6 installs on Windows 11, and new installs on Windows 10.

## Decision

1. The Windows feed's top-level `minimumSystemVersion` is `10.0.22000` in
   every release. It is a compatibility value and no longer the floor.
2. A release names its real Windows floor in `animama.minimum_os`, taken from
   the staged runtime manifest.
3. Apps from this change onward require a well-formed `animama.minimum_os` and
   still require the frozen top-level value. On Windows they replace
   electron-updater's own support check with a comparison between the running
   build and `animama.minimum_os`.
4. The macOS feed and its checks are unchanged.

## Rationale and consequences

- One feed serves both groups, with no bridge release and no stranded
  install. The rejected alternatives were lowering the top-level value, which
  ends updates for every 0.1.6 install; a second feed file, which doubles what
  each release publishes and promotes; and a bridge release, which strands
  installs that skip it.
- The freeze outlives 0.1.6. Newer apps also require the exact top-level
  value, so changing it later would strand them too. Lifting it takes a
  release that relaxes the check, then time for installs to take that release.
- 0.1.6 ignores `animama.minimum_os`. If the floor ever rose above the build
  of a system still running 0.1.6, that install would download the update and
  meet the installer's refusal.
- If a later release raises the floor, a newer app below it is told it is up
  to date, with no explanation.
- A malformed `animama.minimum_os` is not treated as a floor. The support
  check lets the feed through and validation rejects it as invalid metadata.
- The field name `minimumSystemVersion` now misleads a reader of the feed, so
  the generator, the validator and the release documentation each say that it
  is frozen.

## Evidence

- `src/frontend/desktop/src/main-process/updates/policy.ts`:
  `PLATFORMS.win32`, `validateUpdateCandidate` and `windowsUpdateSupported`.
- `src/frontend/desktop/src/main-process/updates/electron-adapter.ts`:
  `createWindowsUpdateAdapter` sets `isUpdateSupported`.
- `src/frontend/desktop/scripts/runtime/release-artifacts.mjs`:
  `RELEASE_TARGETS` and `updateFeed` write both values.
- `src/frontend/desktop/tests/fixtures/update-policy-0.1.6.ts`: 0.1.6's
  validation, kept unchanged, which every generated Windows feed must pass in
  `tests/windows-release.test.mjs`.
- [Releases and updates](../frontend/desktop/releases.md#the-windows-feed):
  the feed as release tooling writes it.
- The [Windows 10 support plan](../plans/windows-10-support/windows-10-support-execplan.md#decision-log):
  the decision and the alternatives considered.
