# Supply hosted locale preferences through public composition contracts

Status: **Implementation, validation and final integration review complete; owner acceptance pending.**
Source agreement: [#576](https://github.com/raymond-van/animama/issues/576), accepted
revision `hosted-locale-contract-2026-10-15-r1`; [spec snapshot](hosted-locale-contract-spec.md)
captured 2026-10-15T19:23:50Z. The issue remains authoritative.
Authorized scope: both phases, approved 2026-10-15, starting with this public
prerequisite. The owner explicitly prohibited merge and deployment. Billed
validation and artifact publication retain their separate gates.
Branch: `feat/hosted-locale-contract`; starting source:
`dca4af86da2ce21386b21ebed6d8175c674d58be`. Use one branch and PR for both phases.

## Purpose and context

Honor saved account/visitor language before admission and refresh without replacing
the session. Preserve settings write intent before materialization, proven by public fixtures.

Follow [SDLC](../../../SDLC.md), [PLANS](../../../PLANS.md), scoped agent guides,
[hosted contracts](../../../contracts/hosted-web.md), [i18n architecture](../../frontend/architecture/i18n.md)
and [package-set policy](../../../scripts/package-sets/README.md).
Account storage, cookies, email, consumer migration and publication are outside this plan.

## Progress

- [x] Accepted scope published; public task branch and phase issues prepared.
- [x] Inspect startup, locale synchronization, settings writes and artifact contracts.
- [x] 2026-10-15: owner approved both ExecPlans for implementation; no merge/deploy.
- [x] Phase 1: [#577](https://github.com/raymond-van/animama/issues/577), completed from planning commit `d630533df9d2ec7cf3db27a764b67a651bf5d4d9`; contracts and app behavior, checks and bounded review passed.
- [x] Phase 2: [#578](https://github.com/raymond-van/animama/issues/578), immutable artifacts and independent consumers passed at `059b5e343dd4b2bbce70051d931f4054b789fadc`; depends on #577.
- [x] Final integration review passed for H1–H6 at `059b5e34`, with zero repairs.
- [ ] Owner acceptance and exact-candidate merge approval; merge remains prohibited.

The recorded task worktree/branch was reused and clean at implementation start.
Frozen host dependencies and tracked LFS assets are ready; both optional speech
sets verify from the existing shared store. The isolated built stack
`animama-hosted-locale-e2e` serves `http://animama-hosted-locale-e2e.localhost:8640`
from Phase 1 product source with fixture-only Phase 2 edits. Deterministic model
clients are enabled; no optional profiles. Only the app publishes a loopback port;
PostgreSQL is private. Bootstrap is ready, 479 catalog entries are indexed and
creation options have no diagnostics. Fast browser journeys passed all 38 cases
in eight minutes; the owned content ledger has no unresolved operations. Evidence
is retained under `.animama-e2e/runs/run-1015164439/` in the task checkout.

## Surprises & Discoveries

- `web/src/main.hosted.tsx` initializes i18n through `initialLocale()`, which trusts
  an origin-local last-applied cache. That cache does not establish explicit choice.
- `LocaleSync` currently mounts inside ready admission and uses settings plus browser
  languages. `queryClientOptions.ts` disables focus refetch, so focus resolution needs
  an explicit composition refresh rather than an assumption about query defaults.
- `SettingsService.patch_user_settings` preserves omitted/null internally but passes
  a materialized object to repository `upsert`. `user_settings_changed` is synchronous,
  receives no field intent and follows a requested commit; it is not a remote-save hook.
- This base already contains stage-5 chat/server speech. Preserve the applied `ui_locale`
  from `currentChatClientContext()` and the separate browser-region safety value.
- The `locale.ts` introduction still says UI locale cannot choose conversation language.
  Correct that stale comment to match [ADR 0024](../../adr/0024-ui-locale-is-the-conversation-language.md).

## Decision Log

- 2026-10-15, owner: accepted the public prerequisite; requested setup and planning.
- 2026-10-15, owner: approved both execution plans and instructed implementation
  to start with this prerequisite; no merge or deployment is authorized.
- 2026-10-15, implementation: the new required Python composition hook advances
  `animama-backend` to 0.4.0; the additive locale declarations advance
  `runtime-contracts` to 0.10.0. Keep local-http 9.0.0 and runtime-owner 1.0.0 if
  offline schema comparison confirms unchanged wire schemas. Product-ui needs
  no bump unless its emitted declarations change. A partial settings reset that
  omits locale remains unrelated; full reset refers to the DELETE operation.
- 2026-10-15, plan proposal: retain local persistence; consumers own remote authority,
  cookie effects and reconciliation. Interface spelling is proposed within H1–H6;
  record engineering changes here; accepted behavior changes need owner agreement.

## Intended interfaces and behavior

### Display inputs, refresh and settings acknowledgement

Extend `@animama/runtime-contracts/locale` resolution additively with `visitor`:
`resolveLocale({ saved, visitor, preferred })`. Both stored inputs accept only canonical
supported tags; matching browser languages continues to use the existing ordered rules.
Define an exported `HostedLocaleInput` with `preference: UiLocale | null` and
`visitor: UiLocale | null`. Document optional `locale: HostedLocaleInput` on the
existing hosted runtime-context response; it does not confer product admission.

The hosted entrypoint reads through the original same-origin transport before i18n
and first meaningful screen, reusing the response for admission initialization.
Add no second authority, injected script or cookie-domain knowledge. A backend lacking
the optional field retains its existing fallback. When the field is supplied, ignore
invalid individual hints and never promote the applied-language cache into preference.
An unavailable initial read falls back to browser languages and the existing retry
flow; it must not expose a previous account's remembered choice as current authority.

Keep composition locale state alongside admission/account affordances in the runtime
snapshot, with separate `preference`, `visitor` and resolved active locale. It is display
state, outside `RuntimeAdmission` owner/capability authorization. Locale synchronization
must run before ready admission as well as within it. Refreshes apply text, formatting,
document `lang`/`dir` and admission wording without changing `session.key`, remounting
the router or replacing its query client. Preserve local `initialLocale`, local
`LocaleSync` behavior and desktop shell propagation when this extension is absent.

The picker reads the nullable saved value; its System default label resolves browser
languages without the visitor value because selecting it clears both explicit choices.
Successful explicit locale writes update confirmed display state immediately, including
visitor selection/clear, then reconcile through context/settings refresh. An unrelated
settings write never changes visitor state. Do not let a stale materialized settings
response replace newer composition authority. Focus reads use the existing composition
refresh path; sign-out/account replacement clears account-derived locale state.
Fence every asynchronous read/save acknowledgement by session and request generation;
late results cannot apply to another owner or supersede a later language selection.

### Prevalidated settings intent and partial outcomes

Add a small immutable `UserSettingsMutation` value in `product_http/ports.py` with
`operation: Literal["create", "patch", "reset"]` and `patch`, a copy of the exact
validated supplied fields (`{}` for reset). Add the awaitable port:

```python
async def prepare_user_settings_change(
    self, session: AsyncSession, principal: RequestPrincipal,
    mutation: UserSettingsMutation,
) -> None: ...
```

Shared user-settings routes invoke it on their composition-owned write session after
principal admission, request validation, model-role validation and create-conflict
checks, but before materialization/write. A consumer must also run its own
deterministic field/ownership validation before any remote effect; a later
repository check must not be the first rejection of an invalid mixed request.
`"locale" in mutation.patch` distinguishes
omission from explicit `None`; reset explicitly clears locale. Local ports implement
a no-op. Keep `user_settings_changed` and its current deferred-commit semantics.
Inject the existing write session; create no session/transaction inside the hook.

Use existing `ProductRefusal`/`detail.code` handling, with documented codes such as
`locale_conflict` (409), `locale_authority_unavailable` (503),
`locale_save_outcome_unknown` (503), and `locale_saved_settings_failed` (409).
The last code confirms remote locale save but incomplete remaining settings. Consumers
retain request-scoped outcomes to map deferred-commit failures; never invent remote rollback.
Verify code/status compatibility in Phase 1 before freezing.

Map codes through existing error readers/catalogs. Unknown outcomes require readback before retry;
confirmed partial saves must say language saved and other settings need reconciliation.
Readback reconciles display state; it cannot prove a particular mutation committed
when concurrent writes make the history ambiguous. Keep that result unknown and
do not update visitor persistence as though success were confirmed. Explicit retry
uses fresh authority and current intent.
An unavailable authority that performed no write is retryable without claiming success.
Do not automatically replay the original stale settings object. Failed refresh retains
only the last confirmed same-account value and an explicit retry state. No distributed
transaction coordinator, durable shared outbox or compensating preference write is added.

## Phased implementation

### Phase 1: Preserve language authority and write intent

Issue: [#577](https://github.com/raymond-van/animama/issues/577). Requirements: H1–H6.
Start: `dca4af86da2ce21386b21ebed6d8175c674d58be`; dependency: owner approval of this plan.

1. Add focused failing tests for resolver precedence and the hosted context contract;
   include English versus unset, Chinese script/region mappings, absent/invalid input,
   signed-out/denied screens and a stale applied cache. Implement the typed extension.
2. Integrate startup/context refresh in `main.hosted.tsx`, hosted composition, runtime
   snapshot, providers and `i18n/LocaleSync.tsx`. Test request cancellation, same-session
   refresh, focus, sign-out and owner replacement before connecting picker writes.
3. Integrate `ui/settings/LanguageSetting.tsx` and `useUpdateUserSettings.ts`; test null,
   unrelated saves, successful acknowledgement, error reconciliation and stale responses.
   Keep existing local startup tests and `lib/safety/clientLocale.test.ts` passing.
4. Add the settings intent port/routes/local no-op and fake consumers. Prove exact
   fields, explicit reset, no effects on rejected requests, and deferred-commit outcomes.
   Test a confirmed remote write followed by local failure and an unknown remote result;
   neither may issue a compensating write or unsafe automatic retry.
5. Update hosted/i18n guidance, translated error catalogs and compatibility records.
   Review Python port/package and TypeScript declaration changes against current versions;
   regenerate SDK offline only if schemas change. Never hand-edit generated output.

Run from repository root after the test database fixture is ready:

```sh
uv run pytest -q tests/test_product_http_settings.py tests/test_settings_service.py tests/test_user_settings_api.py tests/test_ui_locale_independence.py
uv run ruff check
make check-test
uv run --no-sync python scripts/check-repository-dependencies.py
uv run --no-sync python scripts/repository-boundary/check-python-imports.py
```

Run from `src/frontend` (include the new focused sync/picker tests when authored):

```sh
pnpm packages:build
pnpm packages:check
pnpm packages:test
pnpm --dir web exec vitest run src/i18n/locale-preference.test.ts src/app/hosted-runtime/hosted-composition.test.ts src/app/runtime/runtime-controller.test.ts src/lib/safety/clientLocale.test.ts
pnpm check
pnpm web:lint
pnpm web:test
pnpm prettier:check
pnpm build
pnpm --filter animama-web build:hosted
```

Expected: unchanged local behavior, nullable selection, stable sessions, correct `ui_locale`,
translated errors and isolated owner effects. Completion needs passing checks and review.
Record revision, checks, limitations and `feat(locale)[p1]` commit here.

#### Code Review #1 Findings

Independent analysis reviewed the frozen working tree against planning commit
`d630533df9d2ec7cf3db27a764b67a651bf5d4d9`, including new files, against H1–H6.
Result: blocked on two actionable findings; no additional backend, ownership,
partial-outcome or version-contract findings.

- R1 (P2, H3): with no saved preference and an active visitor choice, the picker
  already selects System default. Radix suppresses unchanged values, so choosing
  it again cannot send the explicit clear. Test actual pointer/keyboard activation.
- R2 (P2, H2): a tab that signed out locally returns before reading locale hints
  on focus. Preserve its admission latch while refreshing visitor display input
  and keeping account preference cleared.

Independent checks found three additional failures: generated English catalog
ordering, an unused test argument, and the entrypoint import guard not admitting
the new pure startup helper. The full backend gate passed (4,670 passed,
29 skipped; formatting, Ruff and mypy passed). Frontend package build/check/tests
passed; package browser tests needed an unrestricted local Chromium launch after
the sandbox rejected startup. The first web suite reached 5,096 passed, one skipped
and the entrypoint guard failure; subsequent browser fixtures were not reached.

#### Code Review #1 Revisions

R1 and R2 accepted and repaired. Four real Radix interaction cases first failed
with zero writes, then passed for mouse/Enter/Space clearing and saved-language
reselection. An ordinary change saves once; Space typeahead does not save. The
signed-out focus regression first retained the stale visitor, then passed for
changed/cleared visitors, read failure and abort while preserving the admission
latch. Existing other-tab admission still passes. The shared Select is unchanged.
The three check failures were corrected; extraction dry-run and the first repeated
`pnpm check` and `pnpm web:lint` passed. Focused repair coverage passed 97 tests.

#### Code Review #2 Findings and Revisions

Independent targeted analysis passed R1/R2. The coordinator then reproduced a
new repair regression, R3 (P2): the selected-option handler ignored an already
prevented pointer release, bypassing Radix's opening-click cancellation and
saving when the person only opened the picker. A capture-cancelled pointer test
failed with one unintended clear. Repair round 2 adds `defaultPrevented` guards;
all seven picker tests and targeted formatting pass. No findings were waived.
Repair rounds used: 2 of 2; no further automatic repair round is available.

#### Code Review #3 Findings and Revisions

Independent R3-only analysis passed: prevented pointer/click/key events cannot
save, and Space selection still waits for Radix's typeahead handling. R1/R2 remain
resolved with no new repair regression found. All three findings are resolved;
the frozen web suite passed 5,106 Vitest cases (one skipped), all 535 test files,
and 115 browser-script cases with zero failures/skips. Final `pnpm check`,
`pnpm web:lint`, `pnpm prettier:check`, `pnpm build` and
`pnpm --filter animama-web build:hosted` all passed. Package build/check and 56
package tests passed on unchanged package source. Build warnings concern large
chunks only. Reviewers ran no duplicate suites. Phase 1 is complete.

### Phase 2: Prove the immutable emitted application

Issue: [#578](https://github.com/raymond-van/animama/issues/578). Requirements: H1–H6 artifact acceptance.
Start: completed Phase 1 commit `854c6853fc526561534cea75037f59da8fd8b3a0`. Depends on #577.
The independent fixture changes and the emitted-integration toast repair are
complete. Checkpoints `c173bc28` and `059b5e34` preserved clean producer inputs;
the latter passed the full immutable artifact run and targeted review.

1. Extend independent Python/npm and emitted-app fixtures under
   `scripts/repository-boundary/consumers/`. Serve locale inputs from the public fixture;
   test pre-admission rendering, precedence, switching/default, focus and account replacement.
   Verify draft/editor/navigation/audio continuity and the next chat's resolved `ui_locale`.
2. Capture desktop-first and narrow rendered checks, including all supported languages
   and failure messages. Run `pnpm e2e:test:fast` from `src/frontend` against a disposable
   named built stack following the browser-journey/local-stack guides. Record its source
   and URL. Full journeys are required if implementation changes content/loadout behavior.
3. Review actual version changes: baseline Python 0.3.0, runtime-contracts 0.9.0,
   product-ui 0.14.0, local-http 9.0.0 and runtime-owner 1.0.0. Changed declarations
   need package bumps; structural OpenAPI/JSON Schema changes require the conservative
   major-contract rule. An internal hook alone does not require a schema change.
4. Build a clean exact-source set and validate independent installed consumers; compare
   the selected compatible baseline. Record source, manifest digest, consumer receipts
   and unresolved compatibility. Do not downgrade the existing stage-5/speech contracts.

From repository root; artifact output/work directories must be new external paths:

```sh
uv run --no-sync python -m unittest discover -s scripts/package-sets -p 'test_*.py'
uv run --no-sync python scripts/package-sets/build.py build --source <checkout> --commit <full-sha> --output <new-set-dir>
uv run --no-sync python scripts/package-sets/build.py validate <new-set-dir> --work-dir <new-consumer-dir> --previous-app-set <verified-baseline-set>
uv run --no-sync python scripts/package-sets/build.py compare <verified-baseline-set> <new-set-dir>
```

Expected: installed wheel/packages and emitted assets serve the behavior independently.
Report missing build inputs; do not silently download. Controlled variants are not exact-source rollback.
Completion requires acceptance evidence and review; record `test(locale)[p2]` commit,
actual local/browser results and actual hosted Validation scope separately.

#### Code Review #1 Findings

Initial independent source review passed against `854c6853` plus the frozen
Python, npm and emitted-app fixture changes, including all new files. No required
findings. Review covered installed exports, opt-in authority, captured delayed
responses, distinct partial/unknown outcomes and retained upgrade/rollback/Pocket
checks. Independent syntax and whitespace checks passed. Installed-artifact
execution and rendered inspection remain pending; this source review permits
the clean producer checkpoint but does not complete the phase.

#### Code Review #1 Revisions

No revisions required; repair rounds used: 0 of 2. Eight focused Node cases
passed, including fixture red-to-green coverage. The Python source smoke mounted
144 shared routes, exercised seven intent events and imported zero forbidden
local modules; Ruff and formatting passed. All 27 package producer unit tests
passed. These checks do not substitute for the pending installed consumer run.
The added npm type/resolution probe will compile and run in that isolated install.

#### Artifact run and repair round 1

Clean checkpoint `c173bc281670c44211532cfc06b0a342c230e5de` built successfully
and passed package compatibility comparison against the verified `dca4af86`
predecessor. Its isolated npm install, types, build and browser checks passed.
The whole-application run reached real Avatar/Pocket PCM/worklet acceptance,
then stopped at the locale focus step: switching headless tabs did not deliver
a focus event. No full validation receipt was emitted for this incomplete run.

The fixture repair delivers a standard focus event to the real app listener and
labels that delivery explicitly. It also uses the current Korean unavailable
copy, excludes the composer's readonly measurement mirror, waits for the sign-out
response before refreshing, uses the valid empty-roster creator fixture, and
disables finite screenshot animations. Product source is unchanged. Controlled
execution of the existing immutable app passed 23 locale checks with 17 renders,
no page errors and no external requests. Eight focused Node cases and all 25
workflow browser regressions passed. Independent targeted source review passed;
repair rounds used: 1 of 2. These controlled checks do not replace the pending
new exact-source build and full audio/upgrade/rollback validation.

The controlled receipt SHA-256 is
`9fceb7bc2a9c4fdca5c2346c72dba3c73a375df24781b53f19225eefaf5225e5`.
Desktop/narrow admission renders for all five languages and the retained creator
draft were visually inspected.

#### Code Review #2 Findings and Revisions

The fixture repair passed its targeted recheck. Rendered inspection then exposed
P2-LOC-R2 (P2, H2/H5): a partial/unknown-save toast can remain English after the
page switches to Japanese. The save handler translates a plain string before
asynchronous catalog loading finishes; the emitted assertion's English-or-Japanese
alternative masked this race. Independent targeted analysis confirmed the defect.
This is a new Phase 2 emitted-integration finding, not a reopening of the resolved
Phase 1 findings. Repair round 2 of 2 retains the stable error in reactive toast
content and requires the resolved language in emitted assertions. Four real
Sonner regressions first failed with stale English, then all 15 focused picker
and error-helper cases passed. The retained App Settings browser regression,
web type check, scoped ESLint/Prettier, script syntax and diff checks passed.
Picker event guards are unchanged.

#### Code Review #3 Findings and Revisions

Independent P2-LOC-R2-only review passed: the toast retains structured error
information and updates its wording without changing save behavior or outcome
semantics. Strict emitted assertions no longer accept the stale language. The
reviewer verified red/green and browser evidence and found no caused regression.
Phase 2 has used both repair rounds. The subsequent fresh exact-source run passed
all installed Python/npm, contract, seed and emitted-browser checks. Strict
Japanese outcome wording passed and its resulting screenshot was visually checked.

#### Exact-source acceptance

Source: `059b5e343dd4b2bbce70051d931f4054b789fadc`, clean tree. Build and compare
passed. The independent consumer run used fresh dependency resolution without
source checkout access and passed every phase, including the whole-app browser
in 123 seconds. It exercised 23 locale checks and retained 17 renders; real Pocket
PCM preceded the locale switch, with the same two workers, audio context and
worklet afterward. Exact clean upgrade/rollback against `dca4af86` passed,
including edited normal and effect-only clips. No provider calls occurred.

The retained local set is `hosted-locale-public-20261015-build2/packages`; consumer
evidence is `hosted-locale-public-20261015-consumer2`. Package-set manifest SHA-256:
`1ce4c43d9bf040552ff4e6093b61bca523ea383496ae1a72e031094149495246`.
The passing `validation.json` SHA-256 is
`997f971cd147e3e53c32472208306fab9a4f80a8071cdf2e718b29c515bae9fa`;
consumer summary SHA-256 is
`fc3816cec57e0f971264272b8c720112678654914f3008416b6564be966d5400`.
Its predecessor manifest is
`fa91b4db4469badee5caf4768a68537e5f570972b54a625dbdaf50e300dd0901`.
Final `pnpm i18n:check` passed using the task-local SWC binding cache. The earlier
default-cache attempt failed its isolated lint fixture under the sandbox; no
source change was needed. The 38 built local journeys predate only the reactive
toast repair; focused and final emitted checks cover that subsequent change.

## Final integration review

### Code Review #1 Findings

Independent final integration review passed H1–H6 at clean `059b5e34` against
`dca4af86`, reusing phase evidence. No unresolved findings. The reviewer checked
source/tree identity, all seven artifact hashes, validation recipes, copied
consumer fixtures, linked receipts and all 17 screenshot hashes. It confirmed
strict Japanese outcome wording, Python/npm contract acceptance, audio-resource
continuity and exact predecessor/edited-data rollback. The 38 fast journeys remain
valid for unchanged product behavior; focused and emitted checks cover the toast repair.

### Code Review #1 Revisions

No revisions required; final integration repair rounds used: 0 of 2. Both phase
budgets remain exhausted. Synthetic headless focus delivery, physical audio/native
acceptance and absent hosted CI success remain explicit limits. The final commit
only records this evidence. The PR links #576 and this plan and grants no merge,
artifact publication or deployment authority.

## Validation and acceptance

Planning verification covers document links/whitespace and independent interface
review. That review clarified consumer validation before remote effects and
ambiguous readback behavior; it does not constitute a phase implementation review.
Phase 1 source tests, source browser fixtures, emitted artifacts and the disposable
built-stack checks are recorded above. The final plan-record-only commit does not
change the tested product or fixture bytes. Finish local checks before
pushing; disabled/pending/reduced Validation is not full CI. Exact merge needs owner approval.
Provider calls, physical microphone/heard audio, native release acceptance and publication
are neither established by these public fixtures nor authorized here.

## Idempotence and recovery

Keep the assigned checkout and unrelated work intact. Repeat read-only context refresh
freely; fence results by account/request generation. Unknown writes require authoritative
readback before retry; confirmed remote saves are never undone to mimic local rollback.
Reset is explicit intent, not omission. Revert candidate code only with task-scoped Git
changes; no database reset is required by this public contract. Use new artifact paths,
retain baseline receipts, and clean only verified task-owned stack resources. A consumer
that lacks the optional locale input retains fallback behavior; artifact rollback still
needs the measured compatibility evidence, not a version-number assumption.

## Outcomes & Retrospective

Phase 1 is complete. The backend hook and partial-outcome mapping pass 46
focused settings/ports/model-catalog tests and the full offline gate (4,670 passed,
29 skipped), plus formatting, Ruff and mypy.
The first exact-intent test failed before implementation and passed afterwards.
The current offline OpenAPI export equals the verified baseline, so local-http
remains 9.0.0. Repository boundary checks report zero private dependencies and
zero forbidden Python edges. Final frontend validation passed 5,106 Vitest cases
(one skipped), 115 source browser cases and all static/build gates. Package tests
passed 56 cases. Independent review resolved R1–R3 within two repair rounds.
Ignored logs and exact frontend command receipts live under this plan's `phase1/`.
Phase 2 delivered installed consumer and emitted-artifact acceptance, 23 locale
checks, 17 renders, live audio-resource continuity and exact clean upgrade/rollback.
The disposable built stack passed 38 fast browser journeys and remains available
at its recorded URL. Both phase review budgets were used without waiving findings.
GitHub's Portable product validation workflow was read back as manually disabled;
no hosted run, workflow dispatch, promotion or deployment is claimed.
