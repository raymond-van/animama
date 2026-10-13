# Shorter full validation and promotion from one full run

Source agreement: [shorten-full-validation-spec.md](shorten-full-validation-spec.md),
a snapshot of #442 published 2026-10-12T23:34:52Z.
Authorized scope: Phases 1–7. Phase 6 runs only if Phase 1 chooses a Q1
option. On 2026-10-12 the owner approved the plan, requested implementation and
approved hosted runs H1–H3. The owner left Q1, Q2, the `selective` mode and the
timing of H2 to the agent's judgement. No other hosted run is authorized.

Workspace: worktree `worktrees/shorten-full-validation` (sibling of the main
checkout), on branch `ci/shorten-full-validation`, from base `95a2db39`. No
Compose stack is used. Phase issues: #482 (P1), #483 (P2), #484 (P3), #485
(P4), #486 (P5) and #487 (P7).

## Purpose and context

The single `Validation` job in `.github/workflows/validate-public.yml` grew from
21 to 64–75 minutes, and promotion needs a second full run on `main`. This plan
makes several changes, all without reducing what a promotion candidate proves:

- Selects the expensive suites by changed inputs.
- Runs browser test files concurrently.
- Reuses the baseline's retained package set.
- Lets a `reused` `main` receipt name the PR run's set.

**Orientation (paths relative to the repository root):**

- **Selection policy:** `scripts/ci/validation_policy.py`.
  - `PROFILES`, `classify` and `choose_plan` are pure functions.
  - `evaluate` is the step gate.
  - Tests are in `scripts/ci/test_validation_policy.py`.
- **Plan, gate and summary:** `scripts/ci/validation.py`.
  - `plan` writes `selection.json` and the step outputs `mode`, `baseline` and
    `retention`.
  - `gate` checks the steps and command receipts, then writes the job summary.
  - Tests are in `scripts/ci/test_validation.py`.
- **Hosted reuse:** `scripts/ci/hosted_evidence.py` (`hosted_for_main`,
  `bound_evidence`) and `scripts/ci/github_evidence.py`. Tests are in their
  `test_*.py` files.
- **Timed checks:** `scripts/ci/check.py` writes `<id>.json`, with its duration,
  and `<id>.log`.
- **Browser files:** `src/frontend/web/scripts/*.browser.test.mjs` (12 files).
  - They run from the web package's `test:source` script with
    `node --test --test-concurrency=1`.
  - The effect renderer's shared Vite cache is set in
    `src/frontend/web/scripts/effect-render.mjs:145`.
- **Package sets:** `scripts/package-sets/build.py` (`build`, `validate`,
  `compare`, `models`) and its README, which covers the manifest and the
  validation receipt.
- **Local Linux runner:** `scripts/ci/local_validate.py`. It builds the pinned
  `animama-local-validation:<commit>` image.

**Baseline timings** (minutes, from receipts and the jobs API):

| Run | Kind | Wall | Consumers | Web tests | Backend | Package build | Compare |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 35243622806 | PR, four parallel jobs (September) | 13 | 0.4 | 4.1 (all frontend) | 5.9 | 1.1 | 0.9 |
| 37514705913 | PR (2026-10-06) | 21.3 | 0.4 | 3.7 | 7.3 | 1.6 | 1.4 |
| 38082652779 | PR (2026-10-10) | 67.2 | 21.7 | 19.5 | 9.4 | 4.3 | 4.3 |
| 38255530168 | `main` dispatch for promotion | 64.1 | 18.0 | 19.3 | 9.8 | 4.7 | 4.5 |
| 38256804300 | PR (2026-10-12) | 75.1 | 21.5 | 25.0 | 10.8 | 4.5 | 4.4 |

The 14.1 browser-file minutes in run 38082652779 split into four groups:

- **A. Tooling renders, 5.3:** animation-preview 3.6, effect-check 1.0,
  effect-render 0.5, plus animation-render and effect-thumbnails.
- **B. Hosted screens, 6.0:** hosted-workflows 2.7, hosted-composition 2.6 and
  retained-screens 0.7.
- **C. Downloads and voice, 1.4:** setup-downloads, model-download-coordination
  and voice-clone-library.
- **D. Other, about 1.4:** initial-navigation-diagnostics and unattributed
  tests.

A read-only audit (2026-10-12) found the following about running the files
concurrently:

- Every file uses port 0 and `mkdtemp` directories.
- One conflict: effect-check, effect-render and effect-thumbnails share a Vite
  cache directory.
- Two files are timing-sensitive: initial-navigation-diagnostics (9.5–14.5 s
  window) and model-download-coordination (2–2.5 s waits).
- None needs `web/dist` or models. Several need `pnpm packages:build` outputs.

**Boundaries.** This repository's changes only. The hosted consumer's
acceptance of the receipt contract happens in the consumer's own repository,
and this plan does not edit it.

## Progress

- [x] Phase 1: local measurement and the Q1 decision (#482). See Phase 1 results.
- [x] Phase 2: suite selection, the `selective` profile and the gate. Review passed after one repair round (#483).
- [x] Phase 3: concurrent browser groups and the run summary. Review passed with no repair round (#484).
- [x] Phase 4: baseline set reuse. Review passed after one repair round (#485).
- [x] Phase 5: the reused receipt names the PR set. Review passed after one repair round (#486).
- [x] Phase 6: two pytest-xdist workers for the hosted backend suite (#494). Review passed.
- [x] Phase 7: documentation and final integration review (#487). Passed after one repair round.
- [ ] Hosted runs H1–H3 (each needs separate owner approval).

## Surprises & Discoveries

- 2026-10-12: the issue's packaging-input list leaves out the backend wheel. A
  set includes the wheel built from `pyproject.toml` and `src/backend`, so
  backend source counts as a packaging input. Applying the full input set to
  the last 40 merged PRs, 34 touched packaging inputs. Skipping therefore helps
  about 15% of PRs, which are docs, tests, CI, desktop shell and tooling
  changes.
- 2026-10-12: the issue's levers alone are estimated to leave a non-packaging
  full PR run at 23–25 minutes, which leads to spec Q1. On run 38082652779, the
  remainder is about 8 minutes of setup, lint and types, 9.4 of backend, and
  about 8 of web tests.
- 2026-10-12: the job summary already contains a check table with seconds per
  command receipt (`validation.py` `gate`). It leaves out action steps, the
  total, the selection reasons and per-file browser results.
- 2026-10-12: the PR set records the test-merge commit (`build.py build
  --commit "$GITHUB_SHA"`). Its manifest digest and source date derive from
  that commit, so it cannot be relabelled as the `main` commit. The consumer
  must bind it through the tree and parents (see the spec's receipt contract).
- 2026-10-12, Phase 4 evidence: `build.py compare` reads only the manifests,
  the contract files and the declaration digests. Against the retained set of
  `f7eb367c` (from run 38255530168, artifact 11752469653), the candidate set
  from PR run 38256804300 (`2344b007`) gets the same verdict, "Compatibility
  policy passed", that the hosted run got against its rebuild of `f7eb367c`.
  The two producer recipes differ only in `contracts/versions.json`, which the
  candidate legitimately bumped. The reuse rule therefore ignores contract
  entries in the recipe.
- 2026-10-12, Phase 1: the local container runs on arm64 (OrbStack, Apple
  silicon) limited to 2 CPUs and 7 GB, while the hosted runner is x86_64. Read
  the absolute times only alongside the concurrency-1 calibration. For example,
  animation-preview took 327 s locally against 216 s hosted.
- 2026-10-12: sets from ordinary runs, including `main` pushes, are retained
  for 3 days (`validation.py`, `retention`). That is shorter than the seven-day
  reuse window, and it makes baseline sets usually unavailable.

## Decision Log

- 2026-10-12, owner: a full PR run may skip the whole-application check only
  when no packaging input changed. Unknown paths count as packaging inputs. A
  run that skipped the check cannot serve promotion.
- 2026-10-12, owner: approved the plan and hosted runs H1–H3, and left Q1, Q2,
  the `selective` mode and the timing of H2 to the agent. The agent's
  decisions:
  - Q2: CI and workflow changes select every suite.
  - The `selective` mode is adopted as proposed below.
  - H2 runs before merge, on a throwaway stacked PR.
  - Q1 is decided after Phase 1.
- 2026-10-12, agent (delegated), during Phase 3: any packaging input selects
  every suite. Before this, a backend-only PR recorded `selective` and could not
  serve reuse, which forced a second full `main` run. The spec's R2 and R3 and
  issue #442 were updated to match.
- 2026-10-12, agent proposal (adopted): represent a PR run with skipped suites
  as a new
  `selective` mode, and keep `full` meaning "everything".
  - The existing reuse check (`_receipt` requires `plan.mode == "full"`) and the
    consumer's `mode == "full"` check for `main` runs then stay correct without
    a separate promotion-complete flag.
  - The plan records `skipped` suites with their reasons, and the plan schema
    goes to version 3.
- 2026-10-12, agent proposal: the PR run records its set's manifest digest,
  source record and consumer-receipt digest in its own receipt. The `reused`
  `main` run then reads them from the digest-verified PR receipt and does not
  download the 174 MB set.

## Phased implementation

Working directory: the worktree for `ci/shorten-full-validation`. Every long
command is wrapped in `timeout`. Local evidence goes to an external scratch
directory, and the plan records only summaries.

**Common checks** (each phase, where affected):

```bash
timeout 600 python3 -m unittest discover -s scripts/ci -p 'test_*.py'
timeout 600 uv run --no-sync ruff check scripts/ci
timeout 600 uv run --no-sync ruff format --check scripts/ci
uv run --no-sync python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/validate-public.yml'))"
```

`actionlint` is not installed. Install it only with owner approval, otherwise
record that it was not run.

### Phase 1: Measure locally and recommend the Q1 lever

Requirements: R6, Q1 evidence. Issue: created at setup. No product code
changes. Measurement scripts stay in scratch, unless one becomes the Phase 3
runner.

1. Build the pinned image with `scripts/ci/local_validate.py`, using the `web`
   profile at the base commit, or reuse an existing image for that commit. In
   a container with `--cpus=2 --memory=7g`, which approximates the private-repo
   runner, install, build packages and install Chromium as the workflow does.
2. Time the browser files:
   - At concurrency 1 (12 files, one at a time), for comparison with the
     hosted 14.1 minutes.
   - In two lanes: A run one file at a time, and B+C+D at concurrency 2, with
     the timing-sensitive files first.
   - In three lanes, if two lanes leave CPU headroom.
   - Record the duration and result of each file.
3. Time the backend suite (`uv run --no-sync pytest`, which needs Docker for
   testcontainers):
   - alone;
   - run concurrently with the Vitest/Node tests and browser groups C+D, to
     test Q1 option (a);
   - with `uv run --with pytest-xdist pytest -n 2`, as a temporary, uncommitted
     trial of Q1 option (b), recording any failures that suggest parallel
     unsafety.
4. Estimate the non-packaging PR run's wall-clock time for each option. Use the
   step times of run 38082652779 for the parts not measured.

**Completion:** a timing table in this plan, a chosen concurrency level, and a
Q1 recommendation.

**Gate:** the owner chooses a Q1 option, or none. Phases 2–5 do not depend on
this choice and may proceed.

#### Phase 1 results (2026-10-12)

**Environment.** The pinned local-validation image ran on arm64 (OrbStack),
limited with `--cpus=2 --memory=7g`, at base `95a2db39`.

- The first two-lane attempt used Docker's default 64 MB `/dev/shm` and
  crashed a concurrent Chromium launch. Later runs use `--shm-size=2g`, as
  hosted runners have ample `/dev/shm`.
- The browser layouts were timed with a scratch lane runner. Its layout logic
  became `scripts/ci/browser_tests.py`.

**Browser files.** Wall-clock seconds:

| Layout | Wall | Notes |
| --- | ---: | --- |
| One at a time (12 files) | 983 | Hosted: 846 (14.1 min). Locally, tooling is about 2× hosted and hosted screens about 0.75× |
| Prelude + two lanes (tooling ‖ hosted+core) | 721 | −27% |
| Prelude + three lanes | 791 | Slower than two lanes: the two CPUs are saturated |
| Core group only (selective run) | 66 | |

The local per-group sums, one at a time, were 641 s for tooling, 267 s for the
hosted screens and 76 s for core.

**Backend suite.**

| Option | Seconds | Result |
| --- | ---: | --- |
| Alone, one process | 410 | 4117 passed |
| `pytest -n 2` (pytest-xdist 3.8.0, temporary) | 219 | 4117 passed (−47%) |
| Backend + web unit (141 s) + core browser (61 s), one after another | 612 | Baseline for Q1 |
| The same, with the backend concurrent with the frontend part (option a) | 483 | −21%; the backend alone slowed to 477 s |
| The same, with the backend run as `pytest -n 2` (option b) | 421 | −31% |
| `pytest -n 2`, three confirmation runs | 260, 219, 203 | 4117 passed each time |

**Browser confirmation runs.** These used the real
`scripts/ci/browser_tests.py`, all groups and two lanes:

- arm64: 653 s, 674 s and 540 s.
- amd64 under Rosetta (slow, but the hosted architecture): 1074 s and 1058 s.

**Flakiness under concurrency.** On arm64, a Chromium launch crashed with
SIGSEGV in 3 of 5 concurrent runs:

- `animation-preview` twice, once with the 64 MB `/dev/shm`;
- `effect-check` once.

Each crash failed its file, and since Phase 3 the step fails without hanging.
No sequential run crashed, both amd64 runs were clean, and the hosted logs
from sequential runs show none. The crash appears specific to arm64.

**Decisions:**

- Two lanes (Phase 3). H1 confirms on the real runner. If a launch crash
  appears there, `LANES` falls back to one lane.
- Q1 option (b): pytest-xdist with two workers (Phase 6, #494). It beat
  option (a) and is a smaller change.

### Phase 2: Suite selection, the `selective` profile and the gate

> Revised in `c1cdae0d` (see the Decision Log): any packaging input selects
> every suite, so the planned per-prefix `promotion` selection and the
> `steps.select.outputs.package` output were replaced. A run is `full` or
> `selective`, and `promotion` runs only in `full`.

Requirements: R1–R5, R9. Changes:

- `validation_policy.py`:
  - Add the input classifiers `packaging_inputs`, `tooling_inputs` and
    `select_everything` (CI, workflow, browser setup, manifests, lockfiles, Vite
    configuration and `vite-plugins/`). Each is a prefix or glob table, and
    unknown paths default to packaging.
  - Add `choose_suites(changes, promotion_candidate)`. It returns `full`, or
    `selective` with `skipped: [{suite, reason}]`.
  - The suites are `promotion` (package-build, package-consumers,
    workspace-reclaim, baseline-checkout, package-compat, package-artifacts),
    `browser-hosted` (group B) and `browser-tooling` (group A).
  - `PLAN_KEYS` and schema version 3 add `skipped`. `required` is derived from
    the mode minus the skipped suites, and `evaluate` rejects a mismatch.
- `validation.py plan`:
  - Compute whether the run is a promotion candidate from the event, `ci:full`,
    `reusable` and schedule.
  - Output `promotion=true|false`, `browser-hosted` and `browser-tooling` step
    outputs, and `retention=14` for every promotion-complete run (R9).
  - Keep `mode=full` for promotion candidates and when nothing is skipped.
- Workflow:
  - Steps that run in `full` today run in `full` and `selective`.
  - The promotion steps are also conditioned on `promotion == 'true'` or on
    packaging inputs having changed. In the plan this becomes
    `steps.select.outputs.package == 'true'`.
  - The model inputs needed by the remaining checks are unchanged.
- `hosted_evidence._receipt` keeps requiring `mode == "full"`. Add a test
  showing that a `selective` PR run is refused for reuse.

**Tests (TDD), in `test_validation_policy.py` and `test_validation.py`:**

- Every promotion-candidate event yields `full` with today's exact `required`
  set.
- Each packaging prefix forces the `promotion` suite.
- Unknown, added, renamed or deleted paths are fail-closed.
- Tooling-only changes select group A but not `promotion`.
- Desktop-only and test-only changes skip both.
- CI, workflow and lockfile changes select everything.
- Malformed `skipped` lists and steps that do not match the plan fail the gate.
- Docs, backend, web, reused and deferred profiles behave as before.
- Retention is 14 for `main` full runs.

**Completion:** the common checks pass. The policy tests show R1–R5 and R9.
The workflow parses.

#### Phase 2 implementation notes

- The browser runner (`scripts/ci/browser_tests.py`) landed in Phase 2 with a
  single sequential lane, because the workflow needs a group-aware browser
  step. Phase 3 changes only its lane table, cache directories and summary.
- `test:source` still runs every browser file locally. The workflow runs
  `test:source:unit` and then the `browser-tests` step.
- Changed imports in an allowlisted file count only toward the reduced
  profiles. Suite selection uses only the special-file exclusions: links,
  executables and LFS inputs.

#### Code Review #1 Findings

Reviewed source: the uncommitted tree on `95a2db39` (Phase 2 scope; `docs/plans`
excluded). The reviewer's checks: unittest 109 OK, with the in-progress
Phase 4 files excluded; ruff check and format clean; the workflow YAML parses.

- **P2-F1 (blocking):** `web/scripts/fixtures/` selected only the browser
  groups. `check-packed-artifacts.py:236` copies
  `fixtures/hosted-workflows-http.mjs` into the whole-application consumer.
- **P2-F2 (blocking):** every desktop path except `package.json` mapped to no
  suite. The hosted build imports `desktop/scripts/runtime/licenses.mjs` and
  copies `desktop/runtime/notices/`.
- **P2-F3 (blocking):** root `README.md` mapped to no suite, but it is the
  wheel's `readme`.
- **P2-F4 (blocking):** `desktop/package.json`, `scripts/models/` and `models/`
  selected only promotion. `web/vite.config.ts` and its plugins read them, so
  the browser groups load them too.
- **P2-F5 (blocking):** no tests covered the `promotion`, `browser-groups` and
  `retention` outputs.
- **Non-blocking:**
  - Retention should be 14 only for mode `full`.
  - The gate should reject skipped-suite steps that ran.
  - The baseline guard should key on promotion.
  - The summary text for the selective mode is misleading.
  - The `.mjs.map` special case is unexplained.

#### Code Review #1 Revisions

- **P2-F1, accepted:** `fixtures/` selects every suite. The test was updated.
- **P2-F2, accepted:** the desktop subtree is now fail-closed. Electron-only
  paths (`src/`, `tests/`, `native/`, `scripts/native/`, `build/`, builder,
  README and tsconfig files) map to no suite. `runtime/notices/` and
  `scripts/runtime/` map to promotion, and other paths select every suite.
- **P2-F3, accepted:** `README.md` maps to promotion.
- **P2-F4, accepted:** `models/`, `scripts/models/` and `desktop/package.json`
  now fall through to every suite. `licenses/` stays promotion-only: only the
  hosted build copies it.
- **P2-F5, accepted:** `test_step_outputs_follow_the_selected_suites` covers
  three PR runs (selective without promotion, selective with promotion, full)
  and a full `main` run.
- **Non-blocking, accepted:**
  - Retention is 14 only for mode `full`, matching R9's promotion-complete
    wording.
  - `evaluate` rejects any skipped-suite step whose outcome is not `skipped`.
    This is the last sentence of R5, and the test was reversed accordingly.
  - The baseline guard keys on `promotion`.
  - The `.mjs.map` case was removed.
- **Non-blocking, deferred to Phase 3:** the summary text for the selective
  mode, and the check of browser groups against `results.json`.
- Checks after the revisions: unittest across every Phase 2 suite, 110 tests
  OK; ruff check and format clean. Repair round 1 of 2 used.

#### Code Review #2 Findings

This was a targeted recheck (repair round 1). P2-F1 through P2-F5 are
resolved, the accepted non-blocking revisions were verified, and no
regressions were found. One optional note: `vite.hosted.config.ts` and
`vitest.config.ts` select every suite only through the fail-closed default.
The checks were 110 unittests, ruff and the YAML parse, all passing.
Result: pass.

#### Code Review #2 Revisions

None required. The optional note stays as is, because the default already
selects every suite. Phase 2 review is complete after one repair round.

### Phase 3: Concurrent browser groups and the run summary

Requirements: R6, R10. Changes:

- Give the effect renderer a per-caller Vite cache directory: a `cacheDir`
  parameter on `withRendererPage`, defaulting to today's path. The effect files
  can then share a lane safely, or run in different lanes.
- Add a runner, for example `scripts/ci/browser_tests.py` invoked through
  `check.py`, or a small Node runner beside the tests:
  - It takes the selected groups and the lane layout chosen in Phase 1.
  - It runs `node --test` per lane and writes a receipt per file (file, lane,
    duration, result).
  - It fails when any file fails or a selected group has no files.
  - The local `test:source` script keeps running every file, so developer
    coverage is unchanged.
- Workflow: split the web-tests step into `web-tests` (Node tooling tests and
  Vitest) and `browser-tests` (the runner). Group selection comes from the plan
  outputs.
- `gate` summary:
  - every step's duration from `CI_STEPS` plus the jobs API timings that are
    already readable with `actions: read`, or the per-step `started_at` that
    the runner records;
  - the total wall-clock time;
  - the selection with its skipped suites and reasons;
  - a table of browser files.
- Python runner logic is tested with unittest. Lane and grouping rules are
  pure functions.

**Local evidence:**

- Run the chosen layout three times in the two-CPU container. All runs must
  pass, with per-file durations recorded.
- Run `timeout 1800 pnpm --filter animama-web test:source` once, unchanged.
- Run `pnpm web:lint` for the changed `.mjs` files.

**Completion:** three consecutive green runs at the chosen level. The summary
renders from a recorded fixture of `CI_STEPS` and receipts.

#### Phase 3 implementation notes

- The layout uses two lanes. A serial prelude runs initial-navigation-diagnostics
  and model-download-coordination. Lane 1 holds the tooling renders. Lane 2
  holds the hosted screens, then the remaining core files.
- The per-caller Vite cache change is not needed. The three effect files that
  share `node_modules/.vite-effect-render` always run one after another in one
  lane, and a test guards that.
- Each file runs in its own process group with a 20-minute bound. SIGTERM goes
  first, then SIGKILL.
- `scripts/ci/run_summary.py` renders the job summary. It reads step timings
  from the jobs API, falling back to command receipts. The gate now holds the
  read-only token, used only for this summary.
- The gate rejects browser results that don't match the plan's groups.

#### Code Review #1 Findings

The reviewed source was the uncommitted tree on `2f050ee8`. Checks: unittest
125 OK, ruff clean, YAML parses. No blocking findings. Optional findings:

- **P3-F1:** Chromium has its own process group, so `killpg` misses it, and
  SIGKILL skips Playwright's cleanup.
- **P3-F2:** the timeout test does not assert that the grandchild was killed.
- **P3-F3:** no test guards that the effect files stay in one lane.
- **P3-F4:** the name of a release-caller job does not match `Validation`.
- **P3-F5:** an error while rendering the summary could change the exit code.

The reviewer confirmed that failures, timeouts and missing rows fail the step,
that the gate fails closed, and that the token is used only for the summary.

#### Code Review #1 Revisions

- **P3-F1, accepted:** SIGTERM goes to the group first, with SIGKILL after 10
  seconds, and the docstring is corrected.
- **P3-F3, accepted:** the effect files are asserted to share one lane, and the
  `core,hosted` layout is tested.
- **P3-F4, accepted:** a job named `<caller> / Validation` matches.
- **P3-F5, accepted:** a rendering error writes a minimal summary. Acceptance is
  decided before rendering, and `package_set` is no longer rebound.
- **P3-F2, deferred:** the test checks the status and the log line. Process
  cleanup on an ephemeral runner is not acceptance-relevant.
- Checks after the revisions: unittest 125 OK, ruff clean. Phase 3 review
  passed at round 1, with no repair round needed.

### Phase 4: Baseline set reuse

Requirements: R7, R9. Changes:

- A `baseline_set(repository, baseline_commit, baseline_tree)` lookup in
  `github_evidence.py` or a new `baseline_evidence.py`:
  - It finds a successful run of this workflow whose head is the baseline
    commit, with `mode == "full"`. Alternatively, it finds a `reused` receipt
    whose `package_set.source.tree` equals the baseline tree.
  - It verifies the run and artifact provenance and the ZIP digest, as
    `hosted_evidence` does for receipts.
- A workflow step downloads and verifies the set, checks the manifest's
  source and producer recipe against the candidate's recipe, and then runs
  `build.py compare <baseline-set> <candidate-set>`.
- On any miss or mismatch, it falls back to today's checkout, `models` and
  rebuild path.
- The receipt records the path taken: `retained` with run, artifact, digest and
  manifest, or `rebuilt` with the reason.
- The candidate's own packaging-script changes always force a rebuild, so the
  comparison never mixes producer recipes.

**Tests:**

- Lookup acceptance and refusal using recorded API fixtures: wrong event,
  `selective` mode, expired artifact, digest mismatch, tree mismatch and recipe
  mismatch.
- `compare` gives the same verdict for a retained set and a rebuilt set on one
  local pair, built locally with `build.py build` at two recent `main` commits.

**Completion:** the tests pass, and the local equivalence check passes.

#### Phase 4 implementation notes

- `scripts/ci/baseline_set.py` runs inside the existing `package-compat` step,
  with the read-only token. The baseline checkout still runs, because the
  fallback needs it.
- The retained set is used only when its producer recipe matches the
  candidate's, ignoring `contracts/*`.
- Until a `main` run records a schema-3 receipt (the first is H3, after merge),
  no baseline can qualify. Older receipts use schema 2 and are refused, so runs
  before then rebuild as today.

#### Code Review #1 Findings (Phases 4 and 5, one review)

The reviewed source was the uncommitted tree on `5f7e5593`. Checks: unittest
123 OK, ruff clean, YAML parses. The reviewer also confirmed by reading
upload-artifact `ea165f8d` that `artifact-digest` is 64 hex characters with no
prefix.

- **P5-F1 (blocking):** `promotion_suites` was a constant. The contract
  promises the PR run's outcomes.
- **Optional:**
  - **P5-F2:** add a test for an old-schema `validation.json`.
  - **P5-F3:** validate the artifact ID before fetching it.
  - **P5-F4:** fail cleanly on a malformed baseline record.
  - **P4-F1:** delete the ZIP on failure, and bound its expanded size.
  - **P4-F2:** write the record before a rebuild.
  - **P4-F3:** move on to the next candidate run after a transport error.
  - **P4-F4:** toolchain fields remain a difference from today's rebuild, but
    `compare` does not read them.
  - **P4-F5:** the step name is stale.
- **Verified as correct:** equivalence with today's rebuild, refusal of
  selective and old-schema runs, the binding fields, token handling, ZIP
  safety and job mechanics.

#### Code Review #1 Revisions

- **P5-F1, accepted:** the gate records `promotion_suites` as a map from step
  to outcome. Reuse requires every step to be `success`, both in that map and
  in the PR receipt's `steps`, and `bound_evidence` re-checks the map. Tests
  were added.
- **Accepted:**
  - P5-F2: the `old_schema` case now sets the receipt's schema to 2.
  - P5-F3: the artifact ID is checked before the fetch.
  - P5-F4: a malformed record fails the gate, and the receipt is still
    written. Tested.
  - P4-F1: the ZIP is deleted in `finally`, with an expanded-size bound.
  - P4-F2: the record is written before the rebuild.
  - P4-F3: any exception moves on to the next candidate run.
  - P4-F5: the step is renamed.
- **P4-F4, rejected:** no change. `compare` does not read the toolchain fields.
- Checks after the revisions: unittest 123 OK, ruff clean. Repair round 1 of 2
  used.

#### Code Review #2 Findings (Phases 4 and 5)

This was a targeted recheck (repair round 1). All eight revisions are
resolved, with no regressions, and the spec row matches. Unittest 123 OK,
ruff clean. Optional notes:

- There are no direct tests for the ZIP deletion, the size bound or the
  next-run fallback.
- A record that parses but is not a JSON object is dropped without failing the
  gate.
- `git rev-parse` runs before the record exists.

Result: pass.

#### Code Review #2 Revisions

None required. The optional notes are low risk: our own script writes the
record, and every case falls back to a rebuild or full validation. The Phase 4
and 5 reviews are complete after one repair round.

### Phase 5: The reused receipt names the PR set

Requirements: R8, the receipt contract. Changes:

- PR full run: after `package-artifacts`, the gate (or a small step) records
  `package_set` in `validation.json`. This holds the upload step's
  `artifact-id` and `artifact-digest` outputs, `manifest_sha256`, the manifest
  `source`, and `consumer_receipt_sha256`, all read from
  `$RUNNER_TEMP/public-artifacts`.
- `hosted_for_main`:
  - Require `package_set` in the verified PR receipt.
  - Look up the set artifact by ID: it belongs to the run, its name is
    `animama-set-<tested>-<attempt>`, its digest equals the recorded one, and it
    has not expired.
  - Check that `source.commit == tested_commit` and `source.tree` equals the
    `main` tree.
  - Record the spec's `package_set` fields, including `tested_commit_parents`
    and `promotion_suites`.
- If the PR run has no `package_set`, for example an older run or an artifact
  that has expired, the push keeps full validation.
- `bound_evidence` re-verifies the fields.
- The gate summary links the PR set.

**Tests:** acceptance; refusal for a missing, expired, mismatched or renamed
artifact, or a source tree mismatch; a `selective` PR run; and an old-schema PR
receipt.

**Completion:** the tests pass. A recorded example `selection.json` in the test
fixtures shows the contract.

### Phase 6 (conditional): Backend-suite lever

This phase runs only if the owner chooses a Q1 option after Phase 1.

- **Option (a):** start the backend suite as a background process in the
  backend-tests step's place, and wait for it in a later step that writes the
  same `backend-tests` receipt. Selection and the gate are unchanged.
- **Option (b):** add `pytest-xdist` to the development dependency group, fix
  any tests that are unsafe in parallel, and use `-n 2`.

**Evidence:** the complete suite passes three times locally in the two-CPU
container, and the timing is recorded.

#### Phase 6 results

- `pytest-xdist` (3.8.0, with execnet 2.1.2) is in the `dev` group. The hosted
  `backend-tests` step runs `pytest -n 2`, while `make check-test` and the
  local receipt still run one process.
- Evidence: four clean runs with `-n 2` on two CPUs (219, 260, 219 and 203 s,
  each with 4117 passed). `uv lock --check` and the dependency guard pass.

#### Code Review #1 Findings

The reviewed source was `c1cdae0d` plus the dependency and workflow changes.
Checks: unittest 125 OK, `uv lock --check`, the dependency guard and the YAML
parse. No blocking findings. Parallel safety was verified:

- Each worker gets its own Postgres container and data root.
- No fixed ports or paths, and no order dependence.
- Only the controller writes the JUnit XML.

Optional findings:

- **P6-F1:** the local evidence ran Postgres as sibling containers outside the
  2-CPU limit, so the transport tests with 1–3 s deadlines could see more
  contention on the hosted runner.
- **P6-F2:** the position of the new entry in the dependency list.

#### Code Review #1 Revisions

- **P6-F1, noted as an H1 watch item:** if the hosted run times out in
  `tests/test_local_http_transport.py` or `tests/test_anima_chat_sse_transport.py`,
  check contention first.
- **P6-F2, rejected:** the list is unsorted, so the position is cosmetic.
- Phase 6 review passed with no repair round needed.

### Phase 7: Documentation and final integration review

Requirements: R11. Update the following:

- `docs/backend/operations/development.md`: Local-first hosted validation,
  reuse after merge, and full checks and retained evidence.
- `scripts/package-sets/README.md`: retention, and baseline reuse.
- `docs/frontend/testing/browser-journeys.md`, if it describes the browser-file
  command.

Then run the final independent review of the combined acceptance.

### Hosted runs (each needs explicit owner approval)

The workflow stays disabled. Pushes are batched, so the branch is pushed only
once Phases 2–7 pass locally.

| Run | Trigger | Purpose | Expected |
| --- | --- | --- | --- |
| H1 | This PR, when the owner opens a run window (CI changes select everything) | Promotion-candidate coverage, the browser lanes on the real runner, R10 summary | About 50–60 min. No baseline set exists for the current `main`, so the baseline is rebuilt |
| H2 | A throwaway PR stacked on this branch, changing one root `tests/test_*.py` file, closed unmerged. Alternatively, the first natural non-packaging PR after merge | ≤ 20-minute acceptance for a `selective` run | Under 20 min with Q1, about 23 without |
| H3 | The `main` push after an approved merge of this PR | A `reused` receipt with `package_set` naming H1's set | About 2 min |

The total is about 75–85 billed minutes, plus reruns if a run fails. A failure
is fixed locally before asking for another run. Other merges are held during a
run window. The consumer's adoption of H3's receipt is tracked in its own
repository.

## Hosted runs

**H1, first attempt: [run 38335080833](https://github.com/raymond-van/animama/actions/runs/38335080833)**
(`full`, 2026-10-13, failed after 39.6 min).

- The backend suite with `-n 2` took 8.2 min (9.4–10.8 before) and the web
  unit step 6.2 min.
- The browser step failed. With two lanes, every file ran about twice as long
  as one at a time, for example:
  - animation-preview 786 s against 216 s;
  - hosted-composition 321 s against 156 s.

  One preview test hit a `TimeoutError`, and the step took 19.3 min against
  14.1 min one at a time.
- The local arm64 container under-predicted contention on the two-vCPU runner.
  **Decision (agent, delegated):** browser files run in one lane (`LANES`
  holds a single lane). Runner support for lanes stays for a larger runner.
- The promotion steps did not run, because they depend on the failed step.
  H1 is re-run.

**H2, first attempt: [run 38335086137](https://github.com/raymond-van/animama/actions/runs/38335086137)**
failed in `backend-format`. The cause was the probe's own appended comment, not
this branch.

**H2 re-run: [run 38335941086](https://github.com/raymond-van/animama/actions/runs/38335941086)**
(`selective`, passed in 23.2 min against 66).

- All three suites were skipped.
- Main steps: backend 451 s, web unit 327 s, browser core group 127 s, web
  build 51 s, accountless smoke 71 s.
- This misses the 20-minute target by about 3 min.

**Follow-up lever.** Vitest's default in run mode is `availableParallelism − 1`,
which is one worker on the runner. With `VITEST_MAX_WORKERS=2` in the two-CPU
container, Vitest took 117 s and 113 s against 158 s and 152 s with one worker
(−26%; 4189 passed each time). The workflow now sets it on the web-unit step.
H1 and H2 are re-run with the single lane and this setting.

## Final integration review

#### Final Review #1 Findings

Scope: `95a2db39..9b041f1d`. Checks: unittest 125 OK, ruff check and format,
`uv lock --check`, the YAML parse, and a baseline-against-HEAD comparison of
the policy modules. The cross-phase contracts were traced with no mismatches:

- plan → workflow conditions → browser runner → gate;
- `package_set` → `hosted_for_main` → `bound_evidence` → `baseline_set.find`.

The revision in `c1cdae0d` was verified. For R1, the only change to the full
step set is the added `browser-tests` step.

- **FI-F1 (required):** the Compatibility policy section of the package-set
  README still described an always-independent rebuild.
- **FI-F2 (required):** the reuse docs did not say that the consumer's
  acceptance is still pending, so promotion still needs a full `main` run.
- **Optional:**
  - **FI-F3:** the summary listed only the skipped suites, while R10 asks for
    selected and skipped suites.
  - **FI-F4:** the toolchain fields were not part of the recipe check.
  - **FI-F5:** the Phase 2 body predates `c1cdae0d`.
  - **FI-F6:** the baseline checkout still hydrates LFS when the retained path
    is used.

#### Final Review #1 Revisions

- **FI-F1, accepted:** the README now describes the retained-or-rebuilt path,
  the `baseline_set` record and the absence of a comparison in selective runs.
- **FI-F2, accepted:** the docs state that promoting a reused merge needs a full
  `main` run until the consumer's acceptance lands.
- **FI-F3, accepted:** the summary has a table of every suite: whether it ran,
  and why.
- **FI-F4, accepted:** `recipe_compatible` also requires equal `python`, `uv`,
  `node` and `pnpm` versions. Tested.
- **FI-F5, accepted:** a revision note was added to Phase 2.
- **FI-F6, rejected:** the checkout supplies the tree identity and the fallback
  rebuild. The cost is small.
- Checks after the revisions: unittest 125 OK, ruff clean. Repair round 1 of 2
  used.

#### Final Review #2 Findings

This was a targeted recheck at `0cc3c835`. FI-F1 through FI-F5 are resolved,
there are no regressions and no import cycle, and unittest 125 OK. One
optional note: suites that ran get a fixed reason in the summary. Result: pass.

#### Final Review #2 Revisions

None required. The fixed reason is accurate for every PR run that executes a
suite. Final integration review passed after one repair round.

## Validation and acceptance

The spec's acceptance criteria apply. Evidence is recorded here as it is
produced:

- local unittest results;
- the two-CPU timing tables;
- the H1–H3 run URLs with wall-clock and billed minutes;
- storage estimate for 14-day set retention: about 174 MB per
  promotion-complete run.

## Idempotence and recovery

- The selector fails closed. Reverting the workflow and `scripts/ci` restores
  today's behavior, because receipts are only consumed by the same tooling.
- Schema version 3 receipts are not accepted as version 2. A PR run validated
  under the old schema simply doesn't qualify for reuse, and its `main` push
  runs in full.
- A failed baseline-set download falls back to a rebuild, with no state left
  behind.
- If concurrency produces flakes on the hosted runner, lower the lane count with
  a one-line change. The runner keeps the layout in a single table.

## Outcomes & Retrospective

Pending.
