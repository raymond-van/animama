# Windows 10 support for the desktop app

Source agreement: [#913](https://github.com/raymond-van/animama/issues/913), published
2026-11-24T17:33:35Z and accepted by the owner that day;
[windows-10-support-spec.md](windows-10-support-spec.md) is its snapshot.
Authorized scope: Phase 1 (owner, 2026-11-24); Phase 3, written ahead of G1 by
the owner's decision that day; Phase 2, the owner's gate G1, run on 2026-11-25
at the owner's request.

## Purpose and context

The desktop app's x64 installer and app should install, start and run on
Windows 10 22H2, while Windows 11 installs see no change. The spec's
requirements R1–R8, constraints C1–C7 and acceptance A1–A8 are authoritative;
this plan does not restate them.

Task branch `build/windows-10-support`, base `f612be08d`. One branch and one
PR. Only `src/frontend/desktop`, documentation and `licenses/source-review.json`
change, apart from one comment in the frozen server's PyInstaller spec; the
desktop release skill needed no change (Phase 3), and the backend's behavior,
the web app, contracts and the database are untouched.

### Where the floor lives today

All paths are under `src/frontend/desktop` unless stated.

| Place | Today | Role |
| --- | --- | --- |
| `build/installer.nsh` | `$0 < 22000` | Installer refusal, exit 1150 when silent |
| `src/main-process/runtime/manifest.ts` | `runtimePlatform`, `supportsRuntimePlatform` | Startup check; also compares the staged manifest's `minimum_os` |
| `runtime/native-components.win32-x64.lock.json` | `minimum_os` | Source of the staged manifest's `minimum_os` (`scripts/runtime/stage.mjs`) |
| `runtime/source-manifest.json` | `targets.win32-x64.minimum_os` | Compared with the manifest by `scripts/runtime/audit.mjs` |
| `scripts/runtime/release-artifacts.mjs` | `minimumOs`, `minimumSystemVersion`, `label` | Feed generation; refuses a manifest with another `minimum_os` |
| `src/main-process/updates/policy.ts` | `PLATFORMS.win32.minimumSystemVersion` | Feed validation in the installed app |
| `src/locales/{en,ja,ko,zh-Hans,zh-Hant}.json` | `unsupported_runtime_platform` | Startup recovery text |

The audit, the startup check and the feed generator already cross-check the
manifest value, so those constants must move together. The installer's number
is checked by nothing.

### The update constraint (spec C1)

- Installed 0.1.6 apps run `validateUpdateCandidate`, which rejects a feed
  unless `minimumSystemVersion === "10.0.22000"`. It reads only named fields
  of the feed's `animama` block and ignores others. The `updates/` folder is
  unchanged between the 0.1.6 release merge (`e8ccd2df5`) and this plan's
  base, so the base revision's code is what 0.1.6 runs.
- electron-updater 6.8.11 separately reports no update when `os.release()` is
  below the feed's `minimumSystemVersion`. It exposes this check as the
  replaceable `isUpdateSupported` function. Animama does not replace it today.

So the Windows feed's top-level `minimumSystemVersion` cannot change, and a
Windows 10 install cannot rely on electron-updater's default check.

## Progress

- [x] Phase 1: floor and update compatibility. Implemented from `20243a225`.
      Phase checks pass; review #1 found two required and four optional
      items, all repaired; recheck #2 passed. The full pre-push suite has not
      been run.
- [x] Phase 2: native evidence on Windows 11 and Windows 10 (gate G1). Run
      2026-11-25 on the Windows build host and a Windows 10 22H2 Hyper-V VM
      from `9d3cb6491`; receipt below. Most rows pass. Not shown: keeping
      data on an owner-started Windows 11 uninstall, reinstall onto that
      data, Pocket TTS audio, Quick Chat's window and the held Press to talk
      key; Quick Chat's invisible window remains an open question.
      The source build on Windows 10 (R8) stopped at the speech model
      download, so the Phase 3 build-host rows stay as they are; follow-up
      [#928](https://github.com/raymond-van/animama/issues/928). No repair
      was made. The owner accepted G1 as recorded (Decision Log,
      2026-11-25).
- [x] Phase 3: documentation and decision record. Written ahead of G1 by the
      owner's decision of 2026-11-24 and revisited after it: the floor and the
      claimed versions stand, and the build-host lines keep Windows 11
      because step 5 failed. With G1 accepted, the Windows 10 claims stand.
- [ ] Final integration review and the single full pre-push run. Review #1
      on `cbfbee6e`: no code finding; record and wording findings repaired in
      round 1 (below). `main` at `8fda2eed2` was merged afterwards and this
      branch's ADR renumbered to 0040 (see Surprises). The full pre-push
      suite is owed on that merged candidate.

## Surprises & Discoveries

- 2026-11-24, planning. The feed minimum is validated for exact equality by
  installed apps (see above). Lowering it in the feed would end updates for
  every existing Windows install. Evidence: `policy.ts` at the base revision,
  `validateUpdateCandidate`.
- 2026-11-24, planning. The README download table and the installation
  document describe the published 0.1.6 installer, which refuses Windows 10.
  Changing that text before a release contains this change would be false.
  Recorded as spec P4, accepted by the owner with this plan.
- 2026-11-24, Phase 1. `scripts/runtime/publish-release.mjs` holds the release
  note text for Windows previews and stable releases, which said "Windows 11
  x64". It is a user-facing requirement statement (spec R7) that the plan's
  table missed; it now says "Windows x64 (Windows 10 22H2 or later)".
- 2026-11-24, Phase 1. The repository has no release tags, so the 0.1.6
  oracle was generated from `policy.ts` at the release merge `e8ccd2df5`, with
  its two imports inlined as they were at that revision.
- 2026-11-24, Phase 1. Self-review found that the support check coerced the
  feed's floor to a string, so a non-string value that printed as a floor
  would have withheld an update instead of reaching validation. Fixed with a
  failing test first.
- 2026-11-24, Phase 3. `main` gained ADR 0037 while this work was in
  progress, so the frozen-feed record is ADR 0038. `origin/main` at
  `c7b98f73a` was merged into the branch before the documents were written;
  it merged without conflict and touched none of this plan's source files
  except the licence review file.
- 2026-11-24, planning. No Windows 11 dependency was found by reading:
  Electron 45.3.1 states "Windows 10 and up"; the guard and input hook use
  APIs older than Windows 10; PostgreSQL's UTF-8 code page manifest needs
  version 1903. Nothing has been run on Windows 10.
- 2026-11-25, Phase 2. Step 1's commands do not set
  `ANIMAMA_REQUIRE_MIXAMO_MOTION` or `ANIMAMA_REQUIRE_WOW_COMEDY_SFX`, and the
  private packs' ignored inputs (`build-inputs/`) belong to each checkout, so
  the first build in a fresh worktree staged without both packs. Upgrading a
  published 0.1.6 profile to that build stopped at startup with
  `included_source_in_use` ("could not reconcile its content library"), as
  designed, because the starter Animas use those packs. The receipt's build
  was restaged with the verified inputs and both variables set; its starter
  content then equalled the 0.1.6 baseline. An installer meant for upgrade
  testing over a release profile needs the packs, as release candidates do.
  Not a defect of this change.
- 2026-11-25, Phase 2. The Windows stage fails at once when started from
  PowerShell 7: it runs Windows PowerShell (`powershell.exe`) for `Get-Acl`,
  which cannot load `Microsoft.PowerShell.Security` with the PowerShell 7
  `PSModulePath` it inherits. Starting it from Windows PowerShell, cmd or Git
  Bash works. This predates this change and is left out of this PR; a
  separate fix was proposed to the owner, and no issue is open yet.
- 2026-11-25, Phase 2. The Windows 10 VM has no GPU (Microsoft Hyper-V Video)
  and was viewed through Hyper-V Enhanced Session, whose display followed the
  host monitor at first (3840×2160). During one long streamed reply at that
  size, Windows marked the main window "not responding" for about a minute
  while the GPU process rendered in software; it then recovered with the
  reply complete, and the Stop clicks made during the freeze were lost. The
  remaining steps ran at 1922×1080 without a freeze. This is the
  older-graphics risk of C6 and D3, not a measured defect.
- 2026-11-25, Phase 2, open question. On the Windows 10 VM, `Alt+/` opened
  Quick Chat: its window existed at an on-screen position, took keyboard
  focus and sent typed text into the current chat. The window itself never
  appeared on screen, while PiP's transparent window did. Whether this comes
  from the VM's software rendering over a remote session or from Windows 10
  is not known; it needs a check on real Windows 10 hardware or the owner's
  decision.
- 2026-11-25, Phase 2. On a fresh Windows 10 install, Python cannot verify
  huggingface.co: a new install holds only part of the trusted root
  certificates, Windows adds the others when a Windows component first needs
  them, and Python's TLS check reads the store without triggering that. The
  model scripts report this as a connectivity failure
  (`scripts/models/parakeet.py`), so the source build stopped before staging.
  The long-used build host did not show it.
- 2026-11-25, merge of `main` at `8fda2eed2`. `main` recorded ADR 0038 (chat
  images) and ADR 0039 (ChatGPT plan sign-in) first, so this plan's ADR is
  now 0040 (`docs/adr/0040-windows-update-feed-minimum-is-frozen.md`); its
  title, link, index row and licence entry moved with it. The merge
  conflicted only in `docs/adr/README.md` and `licenses/source-review.json`,
  and each kept both sides. Earlier records in this plan that say
  "ADR 0038" mean that ADR.

## Decision Log

- 2026-11-24, owner. Accepted the spec as written, including the floor of
  build 18362 (P1), by requesting this plan.
- 2026-11-24, owner. Agreed this plan as written, including PD1–PD4 below and
  spec P4, and authorized Phase 1.
- 2026-11-24, agent proposal, accepted.
  **PD1, update mechanism.** The Windows feed keeps
  `minimumSystemVersion: "10.0.22000"` as a frozen compatibility value and
  gains `animama.minimum_os` holding the release's real floor. The app
  validates both and replaces electron-updater's support check on Windows
  with one that reads `animama.minimum_os`. Rationale: one feed serves both
  0.1.6 installs and Windows 10 installs, with no bridge release and no
  stranded install. Alternatives rejected: lowering the feed minimum (breaks
  0.1.6, C1); a second feed file (two files to publish and promote in step);
  a bridge release (strands installs that skip it).
- 2026-11-24, agent proposal, accepted. **PD2, evidence before claims.** Gate G1 runs
  before the documentation phase and before merge, so no document claims
  Windows 10 ahead of a real install. The owner may waive it.
- 2026-11-24, agent proposal, accepted. **PD3, compatibility oracle.** A test fixture
  holds `validateUpdateCandidate` exactly as 0.1.6 ships it, and the
  generated feed must pass it. Duplication is intended: the copy is the
  contract with installed apps and must not follow later edits.
- 2026-11-24, agent proposal, accepted. **PD4, decision record.** A new ADR records
  that the Windows feed minimum is frozen and where the real floor lives,
  because a future edit to that one string would silently end updates.
- 2026-11-24, owner. Phase 3 is written before G1 so that work can continue
  on macOS. This replaces PD2's ordering only: the pull request still does not
  merge before G1, so `main` never claims Windows 10 ahead of a real install.
  If G1 changes the floor or the outcome, the documents and the ADR are
  revised before merge.
- 2026-11-03, owner standing instruction. The full pre-push suite runs once,
  on the final candidate and with the owner's go-ahead, rather than before
  each phase review. Phases run the checks their changes affect.
- 2026-11-25, owner. Accepted gate G1 as recorded in the Phase 2 receipt,
  with A1, A2 and A6 partly met. Not shown: Pocket TTS audio, Quick Chat's
  window, the held Press to talk key, the native tests on Windows 10, an
  owner-started Windows 11 uninstall that keeps data, and a reinstall onto
  it. Quick Chat's window question stays open. The floor stays 18362, the
  documents' Windows 10 claims stand, and R8 continues in #928.

## Phased implementation

### Phase 1: floor and update compatibility

Review tier: high risk. It changes packaging, installer behavior and update
metadata that installed apps read.

Requirements: R2, R3, R4, R5, R6 (automated part), the message items of R7;
acceptance A3, the automated halves of A4 and A5. Starting source: base
`f612be08d`. No dependency on other phases.

Preparation, from `src/frontend`: `pnpm install --frozen-lockfile`. The
worktree was created with Git LFS smudging skipped; run `git lfs pull` before
any runtime stage or full suite.

Steps, tests first:

1. **Floor boundary tests.** In `tests/runtime-state.test.ts`, change the
   Windows case to accept `10.0.18362`, `10.0.19045` and `10.0.26100`, and
   refuse `10.0.18361`, `6.3.9600`, `10.0` and the empty string. Update the
   `minimumOs` expectation.
2. **0.1.6 oracle (PD3).** Add `tests/fixtures/update-policy-0.1.6.ts`,
   containing `validateUpdateCandidate` and the constants it needs, copied
   from `policy.ts` at the base revision with only its imports adjusted. Head
   it with a comment naming the release merge `e8ccd2df5` and forbidding
   edits. In `tests/windows-release.test.mjs`, build a Windows feed with
   `updateFeed` and require the oracle to accept it for a current version of
   `0.1.6`, on both the `r2` and `github` distributions.
3. **Feed tests.** In `tests/desktop-updates.test.ts`, give `windowsFeed()`
   an `animama.minimum_os`. Require: acceptance of the well-formed feed;
   rejection when the top-level value is anything but `10.0.22000`;
   rejection when `animama.minimum_os` is missing or not `10.0.<build>`. Keep
   every existing rejection case.
4. **Support check tests.** In `tests/desktop-updater-adapter.test.ts`,
   cover the Windows adapter's `isUpdateSupported`: supported on
   `10.0.19045` when `animama.minimum_os` is `10.0.18362`; unsupported when
   it is `10.0.19046`; supported when the field is malformed, so validation
   reports the bad feed; and the macOS adapter leaves electron-updater's
   default in place.
5. **Constants.** Set `10.0.18362` in the Windows lock, the source manifest,
   `runtimePlatform` and `supportsRuntimePlatform` in `manifest.ts`, and
   `minimumOs` in `release-artifacts.mjs`. Change that target's `label` to
   name Windows without a version. Update the comments that say Windows 11.
6. **Feed generation.** In `updateFeed`, add `animama.minimum_os` for the
   Windows target only. Leave `minimumSystemVersion: "10.0.22000"` and
   comment it as frozen for 0.1.6. The macOS feed is byte-for-byte unchanged
   in shape.
7. **Feed validation.** In `policy.ts`, keep the exact top-level comparison,
   comment it as frozen, and validate `animama.minimum_os` for `win32`. Do
   not add a field to `UpdateCandidate`: that type crosses IPC, and this
   change must not move a contract version.
8. **Support check.** In `electron-adapter.ts`, set the Windows updater's
   `isUpdateSupported` to compare the running build with
   `animama.minimum_os`. It returns false only for a well-formed minimum
   above the running build.
9. **Installer and text.** In `build/installer.nsh`, refuse below 18362 with
   "Animama requires Windows 10 version 1903 or later." Update
   `unsupported_runtime_platform` in the five locale files.
10. **Consistency test.** In `tests/windows-native.test.mjs`, read the build
    number from `installer.nsh` and require it to equal the lock's
    `minimum_os` build. Update the pinned lock value and the remaining pins
    in `tests/windows-release.test.mjs`.

Checks, from `src/frontend`:

- `pnpm desktop:test`: all desktop suites pass, including the new cases.
- `pnpm check`: types and the i18n check pass.
- `pnpm desktop:build`: main and preload build.
- `pnpm prettier:check`: no formatting difference.

Not run in this phase: the full pre-push suite (see the Decision Log).

Known behavior to record, not fix: if a later release raises the floor, an
install below it is told it is up to date, with no explanation. The floor
does not rise in this plan.

Recovery: every change is source-only and reverts with the commit. Nothing
is published, staged or signed in this phase.

Completion: the four checks pass on a committed tree, the review finds no
open blocker, and the oracle test fails when `minimumSystemVersion` in
`release-artifacts.mjs` is changed by hand (demonstrate once, then restore).

Phase commit: `be41f4f9d`,
`build(desktop)[p1]: accept Windows 10 and keep 0.1.6 updates`. Phase 2 builds
from this commit.

Check record (2026-11-24, macOS arm64 host, working directory
`src/frontend`, uncommitted work; trees are working-tree hashes):

| Command | Result | Tree |
| --- | --- | --- |
| `pnpm desktop:test` | Pass: 39 files passed, 2 skipped; 673 tests passed, 14 skipped | `0f255ca4413e` |
| `pnpm desktop:check` | Pass | `0f255ca4413e` |
| `pnpm desktop:build` | Pass | `0f255ca4413e` |
| `pnpm --filter animama-desktop prettier:check` | Pass | `0f255ca4413e` |
| `pnpm check` | Pass | `a297543c8eee` |
| `pnpm prettier:check` | Pass | `a297543c8eee` |

Between `a297543c8eee` and `0f255ca4413e` only
`desktop/src/main-process/updates/policy.ts` and
`desktop/tests/desktop-updates.test.ts` changed, so the web and i18n parts of
`pnpm check` and the workspace part of `pnpm prettier:check` remain valid; the
desktop parts were rerun.

Observed red, then green, per slice:

- Floor: the Windows boundary and `runtimePlatform` tests failed on `10.0.22000`.
- Feed generation and oracle: `updateFeed` refused the `10.0.18362` manifest.
- Feed validation: a missing or malformed `animama.minimum_os` was accepted.
- Support check: the Windows updater had no `isUpdateSupported` override.
- Consistency: the lock, source manifest and installer still named 22000.
- Non-string floor: the support check withheld the update.

Completion demonstration: with `minimumSystemVersion` for Windows changed by
hand to `10.0.18362` in `release-artifacts.mjs`, "writes a Windows feed that
installed 0.1.6 apps still accept" failed with `update_metadata_invalid`; the
file was restored.

Not run: the full pre-push suite (`make check-test`, `pnpm verify`,
`pnpm web:test:browser`), by the owner's standing instruction; and any native
Windows stage, package or installer run, which is Phase 2.

#### Code Review #1 Findings

Initial review, high-risk tier, 2026-11-24. Reviewed source: uncommitted
working tree `7a798848e3ce` on baseline `20243a225`, which differs from the
check record's `0f255ca4413e` only in this plan file. Two independent
reviewers: analysis and checks.

Checks reviewer, all rerun from `src/frontend` on tree `7a798848e3ce`:

| Command | Result |
| --- | --- |
| `pnpm desktop:test` | Pass: 39 files passed, 2 skipped; 673 tests passed, 14 skipped |
| `pnpm desktop:check` | Pass |
| `pnpm desktop:build` | Pass |
| `pnpm check` | Pass, including the i18n check |

It also confirmed the completion demonstration by substituting the feed
minimum at module load rather than editing the file: the 0.1.6 test passed
unmodified and failed with `update_metadata_invalid` when the value was
`10.0.18362`. It found the fixture textually identical to `policy.ts` at
`e8ccd2df5` apart from the header and the inlined imports. It did not run
formatting checks or the full pre-push suite.

Analysis reviewer. It read the diff and the 0.1.6 and electron-updater
sources, and ran a probe that generated a Windows feed, parsed it with
electron-updater's own YAML reader and passed it to the real 0.1.6 validator,
the fixture and the current validator. Its result: R4 and R5 hold; the
fixture is faithful; no contract or IPC type changed.

- **P1-F1, required.** `tests/windows-release.test.mjs`: no test passed the
  generated Windows feed through the current app, so spec A5's automated half
  was shown only with hand-written feeds. A later change to what the
  generator writes in `animama.minimum_os` would pass every test and publish
  a feed the new app rejects.
- **P1-F2, required.** `tests/fixtures/update-policy-0.1.6.ts` and the two
  plan files had no entry in `licenses/source-review.json`, so
  `python3 scripts/public-release/check_source.py` failed. No phase check
  runs it.
- **P1-F3, optional.** `src/backend/packaging/desktop/animama-runtime.spec`
  justified stripping Universal CRT copies by naming Windows 11. Also, for
  G1: the Windows audit accepts every API-set import unchecked on a Windows
  11 host, so a passing audit says nothing about loading on Windows 10.
- **P1-F4, optional.** `updateFeed`'s refusal of a stale manifest, now
  "requires the Windows runtime manifest", does not say which floor it wants.
- **P1-F5, optional.** `manifest.ts` said only Windows 10 22H2 and Windows 11
  "are tested", which is not true before G1.
- **P1-F6, optional, for the PD4 ADR.** New apps also require the exact
  top-level value, so the freeze continues past 0.1.6. And 0.1.6 ignores
  `animama.minimum_os`: if the floor ever rose above an installed 0.1.6
  system, that install would download the update and meet the installer's
  refusal.

#### Code Review #1 Revisions

Repair round 1 of 2. Every finding was verified against the source before
changing anything.

- **P1-F1, accepted.** The feed tests now share one generator helper. A new
  test, "writes a Windows feed that this app accepts and offers on Windows
  10", passes each generated feed to the current `validateUpdateCandidate`
  and requires `windowsUpdateSupported` to be true on `10.0.19045` and false
  on `10.0.18361`. Demonstrated: with the generator writing
  `<minimum_os>.0`, the new test failed with `update_metadata_invalid` while
  the 0.1.6 test still passed; the file was restored byte-identical.
- **P1-F2, accepted.** Added the three entries, using the original-work entry
  of the neighbouring fixtures. The check now reports that every tracked file
  is covered once.
- **P1-F3, accepted.** The comment now says Windows 10 and later. This is the
  plan's only edit under `src/backend`, and it changes no behavior. The audit
  limit is added to Phase 2 below.
- **P1-F4, accepted.** The refusal now ends with the expected `minimum_os`.
- **P1-F5, accepted.** The comment now states what the documentation claims
  rather than what has been tested.
- **P1-F6, accepted as input to Phase 3.** Both consequences are listed under
  the ADR step.

Checks after the repairs, from `src/frontend` unless stated, tree
`9a6086c526f3`:

| Command | Result |
| --- | --- |
| `pnpm desktop:test` | Pass: 39 files passed, 2 skipped; 674 tests passed, 14 skipped |
| `pnpm desktop:check` | Pass |
| `pnpm desktop:build` | Pass |
| `pnpm --filter animama-desktop prettier:check` | Pass |
| `python3 scripts/public-release/check_source.py` (repository root) | Pass |

Remaining repair budget: one round.

#### Code Review #2 Findings

Targeted recheck of repair round 1, high-risk tier, 2026-11-24. Reviewed
source: working tree `f76d5b5fba73`, which differs from the post-repair check
record's `9a6086c526f3` only in this plan file. Result: pass.

- P1-F1 to P1-F6: all resolved. For P1-F1 the reviewer's own probe showed
  that each drift in `animama.minimum_os` the 0.1.6 oracle cannot see
  (malformed, omitted, raised, lowered) now fails the new test, and that
  lowering the frozen top-level value still fails the 0.1.6 test.
- **P1-R2-F1, optional.** `tests/windows-release.test.mjs` imports the same
  `policy` module twice, once with a `.ts` and once with a `.js` specifier.

Checks rerun by the reviewer on tree `f76d5b5fba73`:

| Command | Working directory | Result |
| --- | --- | --- |
| `pnpm desktop:test` | `src/frontend` | Pass: 39 files passed, 2 skipped; 674 tests passed, 14 skipped |
| `pnpm desktop:check` | `src/frontend` | Pass |
| `pnpm desktop:build` | `src/frontend` | Pass |
| `python3 scripts/public-release/check_source.py` | repository root | Pass |

#### Code Review #2 Revisions

- **P1-R2-F1, deferred.** Cosmetic: both specifiers resolve to one module and
  the tests pass. Merging the imports is left for the next edit to that file,
  because at this tier a further repair needs its own recheck and would use
  the last repair round on a style point.

No repair was made in this round. Repair budget used: one of two rounds.

### Phase 2: native evidence on Windows 11 and Windows 10 (gate G1)

Review tier: none; this phase changes no source. Its evidence feeds the
final integration review.

Requirements: R1, R6, R8; acceptance A1, A2, A6, A8, and spec questions Q1
and Q2. Depends on the Phase 1 commit being available on the Windows build
host: push the task branch, or transfer the commit as the owner prefers.

**Gate G1 (owner, hardware, provider).** This phase runs on the Windows 11
x64 build host and a Windows 10 22H2 x64 virtual machine, by the owner or a
session on that host. It needs a provider key for the chat steps. The agent
working from macOS cannot perform it and must not mark it passed.

Steps:

1. **Build.** On the build host, in a clone with `core.autocrlf=false` at
   the Phase 1 commit, set a higher patch version in
   `src/frontend/desktop/package.json` locally and do not commit it; the
   published 0.1.6 must not be confused with this build, and step 2 needs an
   upgrade. Then, from `src/frontend`:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm desktop:runtime:stage -- --platform win32 --arch x64
   pnpm desktop:runtime:audit -- --platform win32 --arch x64
   pnpm desktop:win:installer
   ```

   Record the commit, the installer's SHA-256 and the audit result. The
   installer is unsigned, so SmartScreen will warn; that is expected.
2. **Windows 11 regression (A6).** In a separate Windows account or a
   Windows 11 VM, never over a profile that matters: install the published
   0.1.6, create a chat, run the new installer over it, and confirm the app
   opens with the same data. Uninstall and confirm the data folder remains.
   Reinstall and confirm the data is used again.
3. **Windows 10 journey (A1).** In a clean Windows 10 22H2 x64 VM, record
   `winver`'s build number, the hypervisor and the graphics adapter. Run the
   installer and complete each step of spec R1, recording each result.
4. **Windows 10 process, vault and input checks (A2).** Force-close Animama
   from Task Manager and confirm that no `Animama.exe`,
   `animama-runtime.exe`, `postgres.exe` or `animama-process-guard.exe`
   remains after 30 seconds. Reopen and confirm the provider key is still
   set. Hold the Press to talk key with Voice Mode muted and confirm one
   unmute and one re-mute.
5. **Source build on Windows 10 (A8, best effort, once).** In the VM,
   prepare the host as
   [runtime staging](../../frontend/desktop/runtime-staging.md#native-windows-build)
   describes and repeat step 1's commands. If it succeeds, also run
   `pnpm desktop:test:termination`, `pnpm desktop:test:vault` and
   `pnpm desktop:test:native-input` there; they replace the manual checks of
   step 4. If it fails, record the failing step and its message, and stop.
6. **Restore.** Discard the local version change on the build host.

Outcomes:

- All pass: continue to Phase 3.
- A component fails on Windows 10 22H2 because it needs a newer build:
  stop. The spec's outcome is not achievable as agreed; return to the owner.
- A defect that is not a version requirement: fix it under Phase 1's tier as
  a repair commit, then repeat the affected steps on a fresh build.

Limit of the build-host audit: it accepts every API-set import unchecked and
runs on Windows 11, so a passing audit does not show that the binaries load
on Windows 10. Steps 3 and 4 are that proof (spec Q2).

Evidence: a public-safe summary in this section (commit, Windows builds,
installer hash, each step's result, limits such as VM graphics). Raw
receipts, screenshots and logs stay in owner-local storage.

Build from the branch head at the time of the run, not from an older
commit, and record that commit: the head includes later merges of `main`.

Receipt (public-safe summary), 2026-11-25. The agent on the build host ran
the build and, at the owner's request, drove the Windows 10 VM through its
console; the owner entered the provider key and decided the uninstall,
reinstall and audio questions.

- Commit built: `9d3cb6491`, the branch head, which contains `main` at
  `c7b98f73a`. Desktop version set to 0.1.7 locally, never committed.
- Build host: Windows 11 25H2 x64, build 26200.7171; Visual Studio 2022
  17.14.23 with MSVC tools 14.44.35207 and redistributable 14.44.35112;
  Windows SDK 10.0.26100.0; Node 24.15.0; pnpm 10.33.0; uv 0.12.21;
  Python 3.13.5.
- Stage and audit result: staged with `ANIMAMA_REQUIRE_MIXAMO_MOTION=1` and
  `ANIMAMA_REQUIRE_WOW_COMEDY_SFX=1` (Mixamo-motion 71 files, comedy sound
  150 files). `runtime audit: OK`: 5,132 manifest files, none missing or
  unexpected; staged `minimum_os` `10.0.18362`; starter content 42,469,328
  bytes, equal to the 0.1.6 baseline; release gate closed with 608 pending
  licence records, as expected for an unsigned build.
- Installer SHA-256:
  `2dd940b30a89f0adff6f2dc4cf61b3a7af591e64384729518cb350d9557ac4eb`
  (375,611,236 bytes, unsigned).
- Windows 11 test system: the build host itself (build 26200.7171), in the
  owner's account, with its data folders and installed app set aside first
  and restored afterwards, by the owner's choice.
- Windows 10 test system: Windows 10 Pro 22H2 x64, `winver` build
  19045.2965, installed unattended from Microsoft's current 22H2 ISO (its
  SHA-256 matched Microsoft's list) into a Hyper-V Generation 2 VM on the
  build host (6 vCPUs, 8 GB, not activated). Graphics: Microsoft Hyper-V
  Video, no GPU, viewed through Enhanced Session (Microsoft Remote Display
  Adapter) at 3840×2160, then 1922×1080. No microphone; audio was forwarded
  to the host with its speakers off.
- Installer refusal below build 18362 (A3): reviewed in Phase 1 and pinned by
  `tests/windows-native.test.mjs`; not exercised, because no machine below
  the floor was available.

| Step | Result | Notes |
| --- | --- | --- |
| 2. Windows 11: published 0.1.6 installed, new installer run over it, data kept | Pass | Published 0.1.6 (matching the live feed's SHA-512) installed onto a fresh profile; the owner set it up and chatted; the 0.1.7 installer upgraded it (exit 0) and opened 0.1.7 with the same owner and chat. A first build without the private packs failed this by design; see Surprises. |
| 2. Windows 11: uninstall keeps the data folder; reinstall uses it | Partial | The owner's uninstall from Settings offered to delete the data folder and the owner chose to delete it, so keeping was not shown there. A silent uninstall (`/S`, as upgrades run it) kept the folder. Reinstall onto existing data: not run, by the owner's decision. |
| 3. Windows 10: installs for the current account without elevation | Pass | Run as the standard user; no UAC prompt; exit 0; registered per user as Animama 0.1.7. |
| 3. Windows 10: starts with no Docker, Node, Python or PostgreSQL present | Pass | None installed (only the Store `python.exe` alias); the runtime started and showed the required-name step. |
| 3. Windows 10: required name, provider key, chat with both starters, cancellation | Pass | Name set; the owner entered the provider key; chats with Annie and Andrew; Stop ended a streaming reply and discarded it. One freeze at 3840×2160 is described under Surprises. |
| 3. Windows 10: Pocket TTS, Avatar animation, fullscreen, PiP, Quick Chat, shortcuts | Partial | The Avatar blinked, waved and changed expression; fullscreen entered and left; `Alt+,` opened and closed PiP. Pocket TTS played (its skip control appeared and cleared) but was not heard. `Alt+/` opened Quick Chat, which took focus and sent a message, but its window was never seen on screen (open question under Surprises). Voice shortcuts not tried: no microphone. |
| 3. Windows 10: quit and reopen keeps owner, content and history | Pass | Closing the window quit; no owned process remained; reopening went to the last Anima with the same owner, both Animas and both chats. |
| 4. Windows 10: no owned process 30 seconds after a force close | Pass | Task Manager End task; 41 seconds later none of `Animama.exe`, `animama-runtime.exe`, `postgres.exe` or `animama-process-guard.exe` remained. |
| 4. Windows 10: provider key survives a restart | Pass | After the force close and a reopen, a chat reply arrived without entering the key again. |
| 4. Windows 10: held Press to talk key unmutes once and re-mutes once | Not run | No microphone in the VM session, so Voice Mode could not start. The app's log shows the native input hook loaded and started at all three launches, with no hook or shortcut registration failure; the held key itself was not shown. |
| 5. Windows 10: source build (stage, audit, package), then the three native tests | Fail; stopped | The documented prerequisites installed in the VM: Visual Studio 2022 Build Tools 17.14.23 (MSVC 14.44.35207, SDK 10.0.26100.0), Node 24.15.0, pnpm 10.33.0, Python 3.13.5, uv 0.12.21, Git 2.56.1 with Git LFS 3.8.1. The clone was clean at `9d3cb6491` with `core.autocrlf=false`. `py -3 scripts/models/browser_speech.py acquire` then failed at once: "Model download failed; check connectivity and retry explicit acquisition". One diagnostic showed the cause: Python reached python.org but could not verify huggingface.co (`CERTIFICATE_VERIFY_FAILED`, "unable to get local issuer certificate"). Stage, audit, package and the native tests were not run. #928 also considers a documented preparation step; under the single attempt this step allows, that route was not tried here. Follow-up: [#928](https://github.com/raymond-van/animama/issues/928). |
| 6. Build host: local version change discarded | Pass | `git checkout -- src/frontend/desktop/package.json` after each build; the tree was clean. |

Spec questions:

- **Q1.** The Windows 10 test install runs in a Hyper-V Generation 2 VM on
  the Windows 11 x64 build host. It did not build from source there: step 5
  stopped at the speech model download (row 5), so the README keeps
  Windows 11 as the build host until
  [#928](https://github.com/raymond-van/animama/issues/928) is resolved and
  R8 is rerun.
- **Q2.** On Windows 10 22H2 (build 19045), nothing that ran needed a newer
  build: the installer, Electron, the frozen backend, PostgreSQL, the process
  guard, the DPAPI vault, Pocket TTS synthesis and the native input hook,
  which loaded and started at every launch. Not shown there: the held Press
  to talk key, offline speech recognition (no microphone) and Quick Chat's
  window, whose cause is open (see Surprises). Builds from 18362 to 19044
  remain untested, as R3 allows. The floor stays 18362 unless the Quick Chat
  question turns out to be a Windows 10 requirement.

### Phase 3: documentation and decision record

Review tier: light; documentation only. Folded into the final integration
review.

Requirements: the document items of R7, R8's README outcome, spec P2 and P4;
acceptance A7. Planned after G1; written before it by the owner's decision of
2026-11-24 (see the Decision Log). The text states the agreed requirement, and
is revised before merge if G1 shows otherwise.

Steps:

1. Classify every "Windows 11" and "22000" occurrence found by
   `git grep -n -E "Windows 11|22000" -- README.md docs src/frontend/AGENTS.md .claude/skills/animama-desktop-release`
   as one of:
   - a requirement of current source: change it to the new requirement;
   - a statement about the published 0.1.6 installer: keep it, and where the
     same passage also describes current source, say both (spec P4);
   - a build-host statement: change it only if step 5 of Phase 2 succeeded;
   - history (ADRs, plans under `docs/plans`, release records): keep it.
2. Apply the changes in `docs/frontend/desktop/` (`platforms.md`,
   `installation.md`, `releases.md`, `release-process.md`, `overview.md`,
   `runtime-staging.md`), `docs/backend/operations/desktop-runtime.md`,
   `README.md`, `src/frontend/AGENTS.md` and the release skill's `SKILL.md`
   and `references/commands.md`.
3. In `installation.md`, add the end-of-support sentence (P2) and the
   best-effort performance sentence (D3). In `platforms.md`, state the
   claimed version (Windows 10 22H2 and Windows 11), that builds from 1903
   are not blocked and are untested, and update the status table.
4. In `release-process.md`, state that Windows minimum-OS acceptance is run
   on Windows 10 22H2, the claimed version, not on the floor build.
5. In `releases.md`, describe the Windows feed: the frozen
   `minimumSystemVersion`, `animama.minimum_os`, and that the first release
   containing this change updates the README download row and the
   installation document's current-release text.
6. Add an ADR for the frozen feed minimum (PD4) under the next free number,
   0038, and list it in `docs/adr/README.md`. Record two consequences found in review: apps from this change
   onward also require the exact top-level value, so the freeze outlives
   0.1.6; and 0.1.6 ignores `animama.minimum_os`, so a future floor above an
   installed 0.1.6 system would let it download an update the installer then
   refuses.

Checks: every changed relative link resolves; the classification table is
recorded here; no Markdown formatter is run, as the repository leaves
Markdown unformatted.

Phase commit: `docs(desktop)[p3]: describe Windows 10 support`.

Classification record (2026-11-24), from
`git grep -n -E "Windows 11|22000" -- README.md docs src/frontend/AGENTS.md .agents/skills src/backend`,
leaving out `docs/plans` and earlier ADRs, which are history:

| Where | Kind | Outcome |
| --- | --- | --- |
| `README.md`, download table row | Published 0.1.6 | Kept (P4) |
| `README.md`, Windows build prerequisites | Build host | Kept, because Phase 2 step 5 failed (#928); added that the built installer installs on Windows 10 22H2 and Windows 11 |
| `README.ja.md`, `README.ko.md`, `README.zh-Hans.md`, download table row | Published 0.1.6 | Kept (P4); RG1 updates them with `README.md` |
| `README.ja.md`, `README.ko.md`, `README.zh-Hans.md`, Windows build prerequisites | Build host | Kept; the same added sentence as `README.md` |
| `docs/adr/0040-windows-update-feed-minimum-is-frozen.md` | Decision record | 22000 is the frozen feed value; kept |
| `docs/backend/operations/desktop-runtime.md`, opening | Current source | Now "Windows x64" |
| `installation.md`, supported-target row | Both | States the 0.1.6 requirement and the new one; end-of-support and performance sentences added below the table |
| `overview.md`, development package targets | Current source | Now Windows 10 22H2 or later |
| `platforms.md`, installer refusal | Current source | Now build 18362; new paragraph on the shared floor and the claimed versions |
| `platforms.md`, status table row | Both | Names both versions and that 0.1.6 requires Windows 11 |
| `platforms.md`, "On a Windows 11 x64 host" | Build host | Kept |
| `release-process.md`, declared minimums | Current source | Now build 18362, with minimum-OS acceptance on Windows 10 22H2 |
| `release-process.md`, build host | Build host | Kept |
| `releases.md`, tooling sentence and update bullet | Current source | Updated; new section "The Windows feed" |
| `releases.md`, clean test machine | Current source | Now names Windows 10 22H2 for minimum-OS acceptance |
| `releases.md`, build host | Build host | Kept |
| `runtime-staging.md`, requirement and target sentences | Current source | Updated |
| `src/frontend/AGENTS.md`, stage command host | Build host | Kept |
| Release skill, `SKILL.md` and `references/commands.md` (three places) | Build host | Kept |

The release skill is tracked under `.agents/skills`; `.claude/skills` is a
link to it. Its three statements describe the build host, so spec R7's "release
skill's references" item needed no change. The translated READMEs and ADR
0038 fall outside the search command's paths; final integration review #1
added their rows. After G1 (2026-11-25) the table stands: step 5 failed, so
no build-host row changes.

Checks: `python3 scripts/public-release/check_source.py` passes with the new
ADR's entry; every relative link added in this phase resolves. No Markdown
formatter was run.

## Final integration review

Scope: Phases 1–3 together against A1–A8, including the light Phase 3 and
Phase 2's receipt. One full review, at most two repair rounds.

After the review and its repairs, and with the owner's go-ahead, run the
full pre-push suite once on the final candidate through the heavy-job slots:

- From the repository root: `python3 scripts/heavy-slot.py -- make check-test`.
- From `src/frontend`: `python3 ../../scripts/heavy-slot.py -- pnpm verify`,
  then `pnpm web:test:browser`, `pnpm desktop:test` and
  `pnpm prettier:check`.

Results go in the PR, not in a later plan commit.

#### Final Integration Review #1 Findings

Initial review, 2026-11-25. Reviewed source: `cbfbee6e` (tree
`8f5efd20f7ac`), baseline `c7b98f73a`, scope `git diff c7b98f73a...cbfbee6e`
(33 files). Two independent read-only reviewers in final integration mode:
A, code and cross-phase acceptance; B, the Phase 3 documents (light tier,
first review), ADR 0038 and the Phase 2 records. As the mode requires, they
ran no checks and reused the check records above.

Reviewer A found no code defect. It confirmed:
- One floor, 18362, in the installer, the lock, the source manifest,
  `manifest.ts` and `release-artifacts.mjs`, pinned by
  `tests/windows-native.test.mjs`.
- The frozen-feed design end to end: the generator; the 0.1.6 fixture,
  identical to `policy.ts` at `e8ccd2df5` apart from imports; current
  validation; the Windows `isUpdateSupported` override; the macOS feed
  unchanged.
- ADR 0038, `releases.md` and `platforms.md` match the code, and the Phase 2
  receipt is consistent with it.
- On Windows 11 the installer and uninstaller run the same code as 0.1.6:
  only `customInit`'s threshold and message changed.
- None of the Phase 2 surprises involves this change's code.

- **FI-A1, required (record).** The plan did not record that the installer's
  refusal below 18362 was not exercised, as spec A3 asks.

Reviewer B confirmed that the documents match the code, P4, P2 and D3 hold,
all 15 added link targets resolve, the classification rerun matches the
table, every new file has a licence entry and nothing cites the end of
prebuilt downloads.

- **FI-B1, required.** The Q2 answer claimed more than ran: offline speech
  recognition, the input hook and Quick Chat's window were not shown.
  Optional, same cause: `platforms.md` said "needs" where R3 says "is known
  to need".
- **FI-B2, required.** `releases.md` and RG1 named only `README.md` for the
  first-release update, but `README.ja.md`, `README.ko.md` and
  `README.zh-Hans.md` carry the same 0.1.6 row. Optional: mirror the new
  English build sentence in the translations, and reword "built from this
  source".
- **FI-B3, optional.** `installation.md` did not say which installer accepts
  Windows 10.
- **FI-B4, optional.** `runtime-staging.md` suggested any Windows x64 host
  can build.
- **FI-B5, optional.** Plan status text was stale after Phase 2 (authorized
  scope, scope statement, Phase 3 progress, one classification row), the G1
  revisit of the documents was unrecorded, and the classification table left
  out the translated READMEs and ADR 0038.
- **FI-B6, optional.** The PowerShell 7 stage failure had no owner decision
  or issue.
- **FI-B7, optional.** R8 keeps Windows 11 as the build host when
  documentation cannot fix the failure; the record did not say the
  documentation route was left untried.

Acceptance, after the repairs below:
- A3 met: automated tests, and the refusal reviewed and recorded as not
  exercised.
- A4 and A5: the automated halves are met; the real updates remain release
  gates RG1 and RG2.
- A7 and A8 met; A8's failure is recorded and #928 linked.
- A1, A2 and A6 partly met. Not shown: Pocket TTS audio, Quick Chat's
  window, the held Press to talk key, the native tests, an owner-started
  Windows 11 uninstall that keeps data, and a reinstall onto it. These need
  the remaining native steps or the owner's acceptance under G1; they are
  not code repairs.

#### Final Integration Review #1 Revisions

Repair round 1 of 2. Each finding was verified against the source first. All
repairs are wording in documentation and plan records, at the light tier, so
they were verified here without a reviewer recheck, as SDLC allows.

- **FI-A1, accepted.** The receipt records the refusal as reviewed, pinned by
  the consistency test and not exercised.
- **FI-B1, accepted.** Q2 now lists what ran and what was not shown. New
  evidence from one read of the VM's app log: across its three launches the
  input hook loaded and started, with no hook or shortcut registration
  failure (`shortcuts-ipc.ts` creates the hook after each shortcut
  registration and logs any failure). `platforms.md` now says "is known to
  need".
- **FI-B2, accepted.** `releases.md` and RG1 name all four READMEs, and
  "built from this source" became "after 0.1.6". The translated READMEs
  gained the English sentence that the built installer installs on Windows
  10 22H2 and Windows 11.
- **FI-B3, accepted.** `installation.md` names the installer and app built
  from current source, and releases after 0.1.6.
- **FI-B4, accepted.** `runtime-staging.md` names the Windows 11 x64 build
  host.
- **FI-B5, accepted.** The authorized scope, scope statement, Progress and
  classification record are updated, including the G1 revisit and the rows
  for the translated READMEs and ADR 0038.
- **FI-B6, accepted in part.** The plan records that the fix is left out of
  this PR and was proposed to the owner as separate work. No issue was
  opened; that is the owner's call.
- **FI-B7, accepted.** Row 5 says the documentation route offered in #928
  was not tried within step 5's single attempt.

Changed files: `README.ja.md`, `README.ko.md`, `README.zh-Hans.md`,
`docs/frontend/desktop/installation.md`, `platforms.md`, `releases.md`,
`runtime-staging.md` and this plan. Verification: no relative link was added
or changed; `py -3 scripts/public-release/check_source.py` passes from the
repository root on the Windows build host; no Markdown formatter was run.

Documentation outside the plan changed, so the full pre-push suite is owed
again on the final candidate. That candidate also needs the next merge of
`main`, whose own ADR 0038 (chat images) means this branch's ADR is
renumbered then. Remaining repair budget: one round. The owner then
accepted G1 with A1, A2 and A6 partly met (Decision Log, 2026-11-25); the
Quick Chat window question stays open.

## Validation and acceptance

| Criterion | Evidence | Where |
| --- | --- | --- |
| A1 | Windows 10 22H2 journey receipt | Phase 2, step 3 |
| A2 | Native tests on Windows 10, or the recorded manual checks | Phase 2, steps 4–5 |
| A3 | Floor tests; installer refusal reviewed, exercised only if a machine below 18362 is available | Phase 1, steps 1, 3, 10 |
| A4 | Oracle test | Phase 1, step 2 |
| A4 | Real in-app update from installed 0.1.6 | Release gate RG1 |
| A5 | Support check and feed tests | Phase 1, steps 3–4 |
| A5 | Real in-app update on Windows 10 | Release gate RG2 |
| A6 | Windows 11 install, upgrade, uninstall journey | Phase 2, step 2 |
| A7 | Classification record and changed documents | Phase 3 |
| A8 | Source build result on Windows 10 | Phase 2, step 5 |

Release gates, outside this plan's PR and recorded in it as outstanding
owner checks:

- **RG1.** On the first Windows release that contains this change: a real
  in-app update from installed 0.1.6 on Windows 11; minimum-OS acceptance on
  Windows 10 22H2; then the Windows download row in `README.md`,
  `README.ja.md`, `README.ko.md` and `README.zh-Hans.md` and the installation
  document's current-release text (P4), and a follow-up for the Animama
  Cloud landing and documentation sites (P3).
- **RG2.** On the next Windows release after that: a real in-app update on
  a Windows 10 install (spec Q3).

## Idempotence and recovery

- Phase 1 and Phase 3 are source and documentation edits; rerunning a step
  is safe and a revert restores the previous behavior.
- Phase 2 writes only to disposable places: a test account or VM profile,
  and `desktop/release` and `.desktop-runtime` on the build host. Rebuilding
  replaces them. Never run it over a profile that holds real data.
- The local version change in Phase 2 is never committed. If it is left in
  place, the next stage records the wrong version and the app refuses the
  runtime; restore the file, then stage and audit again.
- Nothing in this plan publishes, signs or promotes a release. If a later
  release shows that 0.1.6 installs reject the new feed, do not promote the
  feed; the published 0.1.6 feed keeps serving, and reverting Phase 1
  restores the previous generator.

## Outcomes & Retrospective

Not yet delivered.
