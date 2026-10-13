# Shorter full validation and promotion from one full run

Status: Agreed
Owner decision: 2026-10-12. The owner directed this spec and an ExecPlan for
#442. The owner decided that a full PR run may skip the whole-application
browser check only when no packaging input changed. Unknown paths count as
packaging inputs, and a run that skipped the check cannot serve promotion.
After review, the owner approved the proposed hosted runs, requested
implementation and left the remaining open choices to the agent's judgement.
Those choices are recorded under
[Open questions and decisions](#open-questions-and-decisions).
Authoritative source: https://github.com/raymond-van/animama/issues/442.
This snapshot was refreshed at 2026-10-13T00:43:47Z, after the selection decision made during Phase 3. Refresh it
from the issue before resuming.
Baseline revision: `95a2db39` (`main`, 2026-10-12).

## Problem and intended users

`Portable product validation` (`.github/workflows/validate-public.yml`, check
`Validation`) runs as one job on a two-core `ubuntu-24.04` runner, and every
run is billed. Full runs took 13–16 minutes in September and 21 minutes on
2026-10-06 ([run 37514705913]). They now take 64–75 minutes:
[run 38082652779] took 66 minutes, a `main` dispatch on 2026-10-12 took 64,
and a PR run the same day took 75.

Where the 66 minutes of [run 38082652779] go, from its check receipts:

| Work | Minutes |
| --- | ---: |
| Whole-application check: installed consumers plus the emitted hosted app in Chromium (`package-consumers`) | 21.7 |
| Browser test files, run one at a time | 14.1 |
| Backend suite | 9.4 |
| Vitest and Node tooling tests in the web-tests step | 5.4 |
| Hosted package build (`package-build`) | 4.3 |
| Baseline rebuild and compatibility comparison (`package-compat`) | 4.3 |
| Setup, lint, types, SDK freshness, web build, accountless smoke and the rest | 7.1 |

The browser files break down as follows:

- Tooling previews: 5.3 minutes (animation-preview 3.6, effect-check 1.0,
  effect-render 0.5, animation-render and effect-thumbnails).
- Hosted screens: 6.0 minutes (hosted-workflows 2.7, hosted-composition 2.6,
  retained-screens 0.7).
- Downloads and voice: 1.4 minutes (setup-downloads, model-download-coordination
  and voice-clone-library).
- Small or unattributed tests: 1.4 minutes.

A change that reaches the hosted app pays for full validation twice. The hosted
consumer accepts only a package set uploaded by a full run on `main` (a `push`
or `workflow_dispatch`). A merge that reuses a verified full PR run (the
`reused` profile) uploads no set. Promotion therefore needs a second full run on
`main`, as on 2026-10-12, when a 64-minute dispatch produced the set that was
promoted.

The owner pays for every run. The owner and contributors wait on every PR.

## Goals, scope and non-goals

Goals:

- A typical full PR run takes about 20 minutes again.
- Expensive suites run when their inputs change, or for a promotion candidate.
- A change validated in full on its PR can be promoted without a second full
  run.

In scope:

- Selecting expensive suites by changed inputs.
- Running independent browser test files concurrently.
- Reusing the baseline's validated package set.
- Letting a verified full PR run's package set serve promotion.
- Per-step timing in the run summary.
- Policy, tests and documentation.

Non-goals:

- Reducing what a promotion candidate proves.
- Changing the hosted consumer's promotion tooling. That belongs to the
  consumer's repository; this spec states the contract it needs.
- Enabling hosted validation outside owner-approved runs, and changing billing,
  branch protection or runner types.
- Changing the docs, backend and web reduced profiles, owner-reviewed local
  receipts or the weekly checkpoint.
- Larger runners. They are not pursued unless the measurements show the target
  cannot be met on the standard runner, which would be a separate owner decision.

## Terms

- **Promotion candidate:** a `main` push validated in full (not `reused` or
  `docs`), a manual dispatch, a release caller (`workflow_call`), a PR labelled
  `ci:full`, or a scheduled full checkpoint.
- **Packaging inputs:** every tracked path that can change the package set's
  bytes or how it is validated. This includes the backend package, the web app,
  the product packages, contracts, Included content, the lockfiles, the model
  manifests, the packaging and consumer scripts, and the build configuration.
  The exact list lives in the selector. A path the selector does not recognize
  is a packaging input.
- **Promotion suites:** the hosted package build, the installed and
  whole-application consumers, the baseline comparison and the package-set
  upload.
- **Promotion-complete run:** a successful run that executed every promotion
  suite and every check a promotion candidate runs today.

## Required behavior

### Selection

- **R1. Promotion candidates keep full coverage.** A promotion candidate runs
  every check that runs today, with the same receipts, artifacts and gate
  strictness. Its duration is recorded.
- **R2. Whole-application and package selection.** A full PR run that is not a
  promotion candidate skips the promotion suites unless a packaging input
  changed. Any packaging input change selects every suite, so that run is
  promotion-complete. A run that skips anything records the skipped suites and
  why in its selection receipt and job summary, and is not promotion-complete.
- **R3. Browser group selection.** Without a packaging change, the hosted-screen
  files (hosted-composition, hosted-workflows, retained-screens) run only when
  their fixtures or tests changed. The tooling-preview files (animation-preview,
  animation-render, effect-check, effect-render, effect-thumbnails) run only
  when that tooling, its `.mjs` sources or its tests changed. The exact path
  tables live in the selector, and unknown paths select every suite.
- **R4. Cheap checks always run.** Every full run keeps the structural checks:
  lint, types, SDK freshness, repository imports and dependencies, LFS,
  Compose, CI and tooling suites, harness and package unit tests, Vitest, the
  web build and the accountless smoke. It also keeps the browser files that
  R2 and R3 do not select out.
- **R5. Selection fails closed.** Any of the following selects every suite: a
  change to the workflow, the CI scripts, the browser test setup, the root or
  web `package.json`, the lockfiles, `vite.config.ts` or `vite-plugins/`; a
  path the selector cannot classify; or incomplete change discovery. The gate
  rejects a run whose executed steps do not match its recorded selection.

### Browser suite

- **R6. Concurrent files.** Independent browser test files run concurrently, at
  a level chosen by measurement in a two-CPU Linux environment.
  - Files that share a Vite cache directory are not run at the same time unless
    each is given its own directory. Today effect-check, effect-render and
    effect-thumbnails share `node_modules/.vite-effect-render`.
  - Timing-sensitive files do not run alongside CPU-heavy rendering files. These
    are initial-navigation-diagnostics (a 9.5–14.5 s window) and
    model-download-coordination (2–2.5 s waits).
  - A failure still fails the step, and the summary attributes it to its file.
  - The tests' timeouts and assertions do not become looser.

### Baseline

- **R7. Baseline set reuse.** The baseline comparison uses the baseline commit's
  retained validated package set instead of rebuilding it, when such a set can
  be found and verified:
  - It was uploaded by a successful promotion-complete run of this repository's
    workflow for that baseline commit. A `reused` receipt counts when it names a
    set whose source tree equals the baseline's tree.
  - The artifact's digest matches, the manifest's source commit or tree matches
    the baseline, the set has not expired, and its producer recipe is
    compatible.

  Otherwise the run rebuilds the baseline as it does today. The receipt records
  which path was taken and the set's identity. The comparison's verdict does
  not depend on which path was taken.

### Promotion from one full run

- **R8. A reused receipt names the PR set.** When a `main` push is `reused`, its
  receipt names the PR run's package set, provided all of the following hold:
  - The push qualifies under today's rules: the same tree, the base equals the
    previous `main`, it is within seven days, it is a same-repository ordinary
    merge, and there is no `ci:full`.
  - The PR run was promotion-complete.
  - Its set artifact still exists.

  The receipt records the fields in [Receipt contract](#receipt-contract), and
  the gate re-verifies them. If the PR run was not promotion-complete, or its
  set is unavailable, the push gets full validation as today. Nothing labels a
  run that skipped a promotion suite as promotion-complete.
- **R9. Set retention.** Every promotion-complete run, on a PR or on `main`,
  retains its set for at least 14 days. A PR set then outlives the seven-day
  reuse window, and a `main` set stays available as a later PR's baseline
  (R7). Compact receipts keep their current 14-day retention.

### Visibility and documentation

- **R10. Run summary.** The job summary shows:
  - the duration of every step, including action steps that have no command
    receipt;
  - the total wall-clock time;
  - each selected or skipped suite with its reason;
  - the duration and result of each browser test file.
- **R11. Documentation.** [Local-first hosted validation] and the related
  sections describe the following:
  - when each suite runs;
  - what "promotion-complete" means;
  - baseline set reuse;
  - the reused receipt's package-set fields;
  - the new cost tradeoff: a regression from a misclassified packaging input
    surfaces on the `main` run, after merge.

## Receipt contract

A `reused` `main` run's `selection.json` `hosted_evidence` keeps its current
fields: `source_commit` (the `main` commit), `source_tree`, `baseline`,
`tested_commit`, `pull_request`, `run_id`, `run_attempt`, `workflow`,
`run_url`, the receipt artifact's `artifact_id`/`artifact_digest` and
`verified_at`. When R8 applies, it adds a `package_set` object:

| Field | Meaning |
| --- | --- |
| `artifact_id`, `artifact_name` | The PR run's `animama-set-<tested_commit>-<run_attempt>` artifact |
| `artifact_digest` | The SHA-256 digest of the artifact ZIP, as GitHub reports it and as verified |
| `expires_at` | The artifact's expiry |
| `manifest_sha256` | The digest of the set's canonical `manifest.json` |
| `source` | The manifest's `source` record: `commit` (equals `tested_commit`), `tree` (equals the `main` tree) and the remaining fields |
| `tested_commit_parents` | `[baseline, PR head]` |
| `consumer_receipt_sha256` | The digest of the set's own `validation.json`, which records the whole-application result |
| `promotion_suites` | The promotion-suite step IDs and their successful outcomes in the PR run |

The PR set records the test-merge commit, not the `main` commit. Its manifest
digest, source date and identity (`sets/v2/<commit>/<digest>/`) derive from
that commit, so it cannot be relabelled as the `main` commit. A consumer that
accepts such a receipt must:

1. Read the `main` run. Check that it is a successful `push` to `main` of
   `validate-public.yml` in this repository, that its plan mode is `reused`,
   and that its receipt has `success: true`.
2. Check that the `main` commit's tree equals `package_set.source.tree`, and
   that its parents equal `tested_commit_parents`.
3. Download the PR artifact by `artifact_id`. Check that the artifact belongs to
   `run_id`, that its name and digest match, that `manifest_sha256` matches,
   and that `manifest.source.commit` equals `tested_commit`.
4. Validate the set's own consumer receipt as it does today, including its
   whole-application block.
5. Decide how it pins the result. The set's identity carries `tested_commit`,
   while the merged source is the `main` commit, and both are recorded.

Accepting this receipt is the consumer's change, tracked in its own
repository. Until it lands, promotion continues to require a full `main` run.

## Constraints

- **Billing.** Hosted validation stays disabled outside owner-approved runs.
  This work needs a small, named set of approved runs, proposed in the
  ExecPlan. Measure locally first. Do not add parallel jobs or steps that raise
  billed minutes for the same coverage. Record wall-clock and billed minutes
  for each approved run.
- **Storage.** Longer set retention (R9, about 174 MB per promotion-complete
  run) adds artifact storage. Record the expected storage before relying on it.
- **Security.** Keep the existing read-only token, the provenance checks and
  the same-repository merge-commit rule. Add no credentials. Fork PRs and
  squash or rebase merges never qualify.
- **Compatibility.** Selection receipts change in a backward-compatible way: a
  new profile or fields with a schema version bump that the gate checks. The
  evidence verifier must keep rejecting older or malformed receipts as it does
  today. Release callers are unaffected.
- **Detection delay.** For a PR that skips the whole-application check, a
  regression from a misclassified input, or from fresh-resolution consumer
  dependency drift, surfaces on the next promotion-candidate run: the `main`
  push, a dispatch or the weekly checkpoint. The owner accepted this on
  2026-10-12.

## Acceptance criteria

- [ ] **Policy tests.** `python3 -m unittest discover -s scripts/ci -p 'test_*.py'`
  passes, extending `scripts/ci/test_validation_policy.py` and the relevant
  evidence tests. The tests cover:
  - packaging, tooling and fail-closed selection, including unknown paths, CI
    changes and lockfiles;
  - unchanged promotion candidates;
  - the gate rejecting a mismatch between executed steps and the selection;
  - promotion-completeness;
  - reuse refusing a run that is not promotion-complete, or a missing or expired
    set;
  - the package-set fields being recorded and re-verified;
  - baseline set acceptance and fallback.
- [ ] **Local browser timing.** The browser suite is timed in a two-CPU Linux
  environment at each concurrency level tried. The chosen level passes three
  consecutive complete runs, and per-file durations are recorded in the plan.
- [ ] **Short PR run.** An owner-approved hosted PR run with no packaging,
  hosted-composition or tooling changes finishes in 20 minutes or less of
  wall-clock time. It skips the promotion suites and names them in its summary.
- [ ] **Promotion-candidate run.** An owner-approved promotion-candidate run
  keeps every current check. Its wall-clock duration and per-step summary are
  recorded and compared with runs 38082652779 and 38255530168.
- [ ] **Reused receipt.** After merge, a `reused` `main` push records and
  re-verifies the `package_set` fields for a promotion-complete PR run. The
  consumer's acceptance is tracked separately.
- [ ] **Documentation.** The validation docs describe when each suite runs and
  the receipt contract.

## Open questions and decisions

- 2026-10-12, owner: skip the whole-application check on a PR only when no
  packaging input changed. Unknown paths count as packaging inputs. A run that
  skipped it cannot serve promotion.
- **Q1, delegated to the agent on 2026-10-12: a lever for the 20-minute
  target.** The agent chooses after the Phase 1 measurements and records the
  choice and its evidence in the ExecPlan. The
  issue's levers are estimated to leave a non-packaging full PR run at about 23
  to 25 minutes, using [run 38082652779]'s timings. Removing the promotion
  suites, the hosted-screen files and the tooling files leaves:
  - about 8 minutes of setup, lint and types;
  - 9.4 minutes of backend suite;
  - about 8 minutes of web tests.

  Proposal: the plan's first phase measures two options locally, and the owner
  picks one if the target needs it.
  - (a) Running the backend suite concurrently with the frontend tests inside
    the single job, with no new dependency.
  - (b) Splitting the backend suite across workers. `pytest-xdist` is a new
    development dependency, and today's tests have not been checked for
    parallel safety.

  Selecting the backend suite by inputs is not proposed. Several backend tests
  guard non-backend inputs, such as Compose, desktop packaging and Included
  content.
- **Q2, decided 2026-10-12 (delegated): CI and workflow changes select every
  suite.** This PR's own hosted run therefore exercises the full promotion path.
  It doubles as the promotion-candidate measurement.
- **Selective mode, decided 2026-10-12 (delegated).** A full PR run that skips
  any suite records the new `selective` mode. `full` keeps meaning every check,
  so a run is promotion-complete exactly when its mode is `full`.
- **Packaging selects everything, decided 2026-10-12 (delegated, during
  Phase 3).** An earlier draft ran only the promotion suite for a backend-only
  change and skipped the browser groups. That run would be `selective`, so
  promotion would need a second full `main` run, defeating the third goal. Any
  packaging input now selects every suite. A backend-only PR therefore runs
  about 7 more minutes of browser files, but its merge needs no full `main`
  run.
- **H2 timing, decided 2026-10-12 (delegated).** The 20-minute criterion is
  proved before merge, on a throwaway PR stacked on this branch and closed
  unmerged.
- Larger runners are not pursued (see Non-goals).

## Spec

This document before publication; https://github.com/raymond-van/animama/issues/442
after publication.

## ExecPlan

[docs/plans/shorten-full-validation/shorten-full-validation-execplan.md](shorten-full-validation-execplan.md)
on branch `ci/shorten-full-validation` (reviewed 2026-10-12).

## Delivery links

Phase issues: #482 (P1), #483 (P2), #484 (P3), #485 (P4), #486 (P5), and
#487 (P7). P6 gets an issue only if it is chosen.

[run 37514705913]: https://github.com/raymond-van/animama/actions/runs/37514705913
[run 38082652779]: https://github.com/raymond-van/animama/actions/runs/38082652779
[Local-first hosted validation]: ../../backend/operations/development.md#local-first-hosted-validation
