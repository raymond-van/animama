# Animama Agent Guide

This is the repository-level entrypoint for AI coding agents. Read this first, then read the nearest scoped guide before editing inside a subsystem:

- Backend/FastAPI: `src/backend/AGENTS.md`
- Frontend and Electron shell: `src/frontend/AGENTS.md`

[How Animama is built](docs/agents/README.md) gives human readers an overview
of the lifecycle these guides implement.

The nested guides are authoritative for their areas. Keep this file focused on
repo-wide workflow, ownership boundaries, and local development conventions.

## Product Shape

Animama is an AI Avatar Desktop Companion app. The normal product loop is the
local installation owner chatting with one Anima and its selected Avatar through `/v1/chats` and
`POST /v1/animas/{anima_id}/chat:sse`, with streamed assistant text,
avatar emotion/gesture updates, memory side effects, voice/TTS integration, and
chat history persisted in `chats` and `chat_messages`.

## Repository Shape

- `src/backend`: FastAPI backend, direct chat runtime, domain/services,
  SQLAlchemy ORM, Alembic integration, workers, and Python package
  source.
- `src/frontend`: Vite React web app,
  Electron desktop shell, generated API client, and public
  runtime assets.
- `docker-compose.yml`: local service graph for Postgres, the backend, the web
  development override and the optional `dev-tools` profile (pgAdmin and Dozzle).
- `reset.sh`: preferred local stack reset/start script. Agents may run it to start
  or restart their own task's stack. The main stack is usually already running;
  other tasks' stacks are not theirs to restart.
- `tests`: backend and integration tests. Frontend manual testing is currently
  important for audio, avatar animation, voice, and desktop behavior.

## Planning and change records

Follow [SDLC.md](SDLC.md) for the change lifecycle and [SPECS.md](SPECS.md) for
specification authoring. Most changes use an issue, task branch, PR, checks and
owner-approved merge. Tiny incidental corrections may omit the issue. Require an
ExecPlan for substantial, uncertain or risky work; routine changes need an issue
with acceptance and a brief approach. File count or duration alone is not a trigger.
Keep the record current so another contributor can resume it. Read the
[repository setup contract](SDLC.md#repository-setup) before using a lifecycle
skill. This established setup is the workflow authority; repair missing or
inconsistent prerequisites before dependent work instead of choosing a fallback.
Preserve every explicit verification gate in an existing plan; installing or
editing a skill does not show that it works in real tasks.
Use this guide, the scoped guides and checked-in architecture, contract and
operational documentation as the implementation references.

Keep new specs and ExecPlans tracked in the repository whose implementation they
cover. Follow [PLANS.md](PLANS.md); Animama artifacts live under `docs/plans/`,
while Cloud owns its own plans. Write Animama plans for public review, without
secrets, personal data, raw transcripts or private-checkout dependencies. Existing
plans keep their locations and explicit gates unless deliberately migrated with
owner approval; do not bulk-copy historical private plans. See
[Repository boundaries](docs/architecture/repository-boundaries.md).

Use the [domain documentation guide](docs/agents/domain.md) to distinguish
current terminology, implemented behavior and architectural decision history.
Read relevant [glossary entries](GLOSSARY.md) and
[ADRs](docs/adr/README.md); surface conflicts
before changing an established meaning or decision. Intent discovery is an
invocable interview for unresolved intent, not a required interview for every task.

## Branches and pull requests

Name branches, PRs and commits as [names and labels](SDLC.md#names-and-labels)
defines: `<type>/<short-kebab-case-task>` branches, `<type>: <summary>` PR
titles, `<type>(<scope>): <summary>` commits and `<type>(<scope>)[p#]: <summary>`
phase commits, with one primary type per change (`fix` for bugs; cleanup is
`chore` or `refactor` according to intent). Do not add an agent-name prefix or
rename an existing shared branch just to match this convention. When a tool
starts a task on a generated branch such as `claude/<name>`, rename it to
`<type>/<short-kebab-case-task>` before pushing, choosing the type from the
task. This naming policy grants no additional push, merge or
remote-configuration authority. See [worktree cleanup](docs/backend/operations/development.md#cleaning-up-worktree-stacks)
for the data-preserving handoff workflow.

Use the default [pull request template](.github/pull_request_template.md).
Its Spec section links the authoritative issue. Its ExecPlan section links the
tracked plan at the reviewed revision, or explains why no plan is required.
For an existing private plan, state that it is retained without exposing its
private path; keep the public issue and PR independently understandable.
Describe the problem and resulting behavior, then separate local verification
from actual CI and browser evidence. Use the template's single compact revision
reference; include exact commands/results, material environment limits and
unperformed checks.
Default to an ordinary merge commit after owner approval of the exact candidate.
Squash or rebase needs an explicit exception; a default method grants no merge
authority. Follow [review and merge evidence](SDLC.md#ci-and-merge-evidence).

## Code Quality

Keep code changes clean, organized, and easy to maintain. Follow established
best practices and core coding principles:

- DRY (Don't Repeat Yourself): reuse existing helpers, abstractions, and
  patterns instead of duplicating logic.
- KISS (Keep It Simple): prefer the simplest design that solves the current
  problem clearly.
- Readable over clever: write code another maintainer can quickly understand;
  avoid obscure shortcuts, surprising control flow, and unnecessary indirection.
- Fail clearly: surface errors with useful context, avoid silent failures, and
  make invalid states explicit.
- Performance awareness: avoid obvious inefficiencies in hot paths and shared
  code, but do not add premature complexity without evidence.
- Secure by default: validate inputs, respect auth and ownership boundaries,
  handle secrets carefully, and treat external data as untrusted.
- Comments and docstrings: add them frequently for public APIs, domain concepts,
  non-obvious decisions, and complex logic; keep them accurate as code changes.
- Documentation: follow the reader-value standard under [Documentation](#documentation).

Prefer clear ownership boundaries, focused changes, readable structure, and
solutions that fit the surrounding patterns.

## First Steps

1. Check `git status --short` before editing. Do not revert unrelated dirty or
   untracked files.
2. Identify the touched subsystem and read its scoped `AGENTS.md`.
3. Read the relevant docs entrypoints:

- Backend docs: `docs/backend/README.md`
- Frontend docs: `docs/frontend/README.md`

4. Prefer existing patterns, helpers, commands, and architecture boundaries over
   introducing parallel paths.

## Accountless local runtime

The local composition uses a generated installation owner, FastAPI request boundary,
credential-free React startup, and loopback-only desktop/self-host services.
Its durable contracts are documented in
[backend operations](docs/backend/operations/development.md) and
[local HTTP architecture](docs/frontend/architecture/auth-server.md).
FastAPI serves the production React build and authorizes API/byte traffic.
Development publishes Vite with a closed same-origin proxy to private FastAPI.
Only the selected application service publishes the loopback application port. React starts from `main.local.tsx`, reads backend-owned
installation readiness (requesting bootstrap only for reported repair), and
then supplies the principal through a neutral runtime-owner context. Do not
restore local accounts, account seeding, browser bearer tokens, direct FastAPI
browser configuration, or security-changing
local/hosted mode flags. The native FastAPI launcher binds only to loopback. Both Compose selections
publish the application at `127.0.0.1`. The opt-in
`dev-tools` profile adds only loopback pgAdmin and Dozzle; all other services
stay private. Remote self-host access requires an operator-owned TLS
and authentication boundary, and every admitted request is still the same
installation owner.

## Workspace selection

Keep the primary checkout on `main`. Use task branches in separate worktrees for
changes, including small fixes and documentation. Do not switch the primary
checkout to a task branch. Do not make changes and commit to `main` unless directly
told to. An issue exception for a tiny correction does not waive these workspace
rules or the PR workflow.

Reuse the worktree assigned to the task across implementation, validation, review
and follow-ups. Before editing, verify its Git root, branch or detached HEAD,
source revision and dirty state. Preserve an existing task branch; if detached,
create the task branch at the verified current HEAD. Create a worktree only when
the task does not already have a suitable one. Investigate mismatches before
switching directories or changing the selected revision; never stash another
task's work or silently switch an occupied checkout.

A worktree may not require a separate Compose stack. Use the existing development
stack when it serves the required source revision and testing will not disrupt
another task. Start a task stack when needed to run the changed source or isolate
services/data. Test chats and content alone do not require a separate stack.
Never stop another task's services or purge data as a setup ritual.

Record the checkout, branch, starting revision and any stack URL in the task
handoff. Use ordinary Git commands and the existing
[preparation and cleanup procedures](docs/backend/operations/development.md#preparing-a-task-workspace);
no mandatory helper or policy engine is required.

## Local Stacks

Speech models are optional for local stacks. Acquire Parakeet (English)
speech-to-text with `python3 scripts/models/parakeet.py acquire`, SenseVoice
(Japanese, Korean and Chinese) with
`python3 scripts/models/sensevoice.py acquire`, and Pocket TTS/Smart Turn with
`python3 scripts/models/browser_speech.py acquire` (or import verified existing copies).
`reset.sh` verifies each acquired set in `ANIMAMA_MODEL_ROOT` offline and records its
resolved immutable directory. A missing set only disables its own feature; a set
that fails verification stops the reset. It never downloads models. See
[model setup](docs/backend/operations/model-assets.md).

Follow the [workspace preparation workflow](docs/backend/operations/development.md#preparing-a-task-workspace)
for ordinary Git worktrees, dependencies and credentials. Keep reusable secrets
in an owner-only external file and worktree `.env` files nonsecret; select them
with `COMPOSE_ENV_FILES` (secrets first, worktree configuration second). Never
copy a main checkout's `.env` or log credential values/digests. Inherited shell
values override file settings, so use a clean environment for configuration
changes and the generated stack record for resuming the same stack.

For the main checkout, preserve the default local application URL:

```bash
./reset.sh
```

Default application URL:

```text
http://localhost:8000  Application (Vite in development; FastAPI in built mode)
```

PostgreSQL stays private. In development FastAPI is private; in built mode
there is no frontend Node service. `ANIMAMA_WEB_BUILD_MODE=production ./reset.sh`
selects the built application; the default `development` selection retains HMR.

For browser administration on a trusted development machine:

```bash
./reset.sh --profile dev-tools
```

This enables pgAdmin at `http://localhost:5050` and Dozzle at
`http://localhost:9999`, both bound to `127.0.0.1`. `PGADMIN_PORT` and
`DOZZLE_PORT` override the defaults; `--base-port B` takes precedence and uses
B+4/B+20. Reset reports the resolved URLs. Disable with
`COMPOSE_PROFILES= ./reset.sh`, or preserve other profiles while removing only
`dev-tools`. Neither operation needs `--purge`. Do not forward these privileged
tools publicly, add them to the application, or package them with Electron/Animama Cloud.

For git worktrees or parallel branch testing, use a named stack and base port:

```bash
./reset.sh --name abc --base-port 8200
source .animama-stack.env
```

The stack record includes the selected `COMPOSE_FILE` graph and normalized
`COMPOSE_ENV_FILES` paths; source the trusted record from the correct checkout
before project-scoped follow-up, backup and restore commands. It records no
credential values.

That creates an isolated Compose project such as `animama-abc`, writes derived
URLs and ports to `.animama-stack.env`, and sets `ANIMAMA_DESKTOP_WEB_URL` for
Electron commands. From `src/frontend`, source it as:

```bash
source ../../.animama-stack.env
```

Never use bare `docker compose down` or target container names directly for
worktree stacks. `reset.sh` prefixes container names for named stacks, but
agent commands should still use project-scoped Compose service commands, for
example:

```bash
docker compose -p animama-abc ps
docker compose -p animama-abc logs -f animama-server web
```

If the `animama-local-stacks` skill is installed, use it for local stack
startup, debugging, and reporting.

## Ownership Boundaries

- This repository must build, test and run without a Cloud checkout or private
  source. Do not add Cloud imports, sibling path dependencies, symlinks or build
  inputs. Documented hosted HTTP contracts are allowed; private service databases
  are not a local integration surface. Shared reusable code belongs here;
  Cloud consumes reviewed, immutable public artifacts.
- In a workspace containing multiple repositories, read the target repository's
  root and scoped agent guides before editing there; secondary-folder guidance
  may not load automatically. Run commands with an explicit repository working
  directory and keep Git status, commits and pull requests separate. A worktree
  for this repository does not isolate edits in an attached sibling repository.
- Backend API, persistence, runtime and workers belong under `src/backend`;
  backend documentation belongs under `docs/backend`.
- Browser UI, generated clients and Electron belong under `src/frontend`;
  frontend documentation belongs under `docs/frontend`.
- Do not hand-edit generated API clients under
  `src/frontend/packages/runtime-contracts/src/generated` or generated TanStack
  Router output. Regenerate the SDK offline through `pnpm openapi-ts`.
- Backend schema/API changes should update backend docs and coordinate frontend
  client regeneration through the frontend guide.
- Change the schema with a new Alembic revision, together with the ORM change,
  so installed desktop profiles upgrade in place. Never edit
  `src/backend/migrations/versions/0001_baseline.sql`, which is frozen at the
  schema released in desktop 0.1.2, or any merged revision
  ([ADR 0035](docs/adr/0035-released-schema-changes-use-forward-migrations.md)).
- Local ownership uses the generated installation principal. Shared FastAPI
  routes receive a `RequestPrincipal` from the resolver installed by the local
  composition; tests override that dependency explicitly. Better Auth is
  reserved for the future hosted Animama Cloud composition.

## Documentation

Update docs when a change would leave useful guidance missing or misleading.
Each sentence should help a reader use, operate, debug or extend the system.
An obvious UI adjustment or internal refactor may need no documentation change.
Remove repetition and obsolete guidance instead of appending change narration.
Describe current behavior; put significant decision history in ADRs and delivery
evidence in issues, PRs or plans. Preserve actionable constraints and recovery
instructions. See the [domain guide](docs/agents/domain.md) for placement.

Use the `docs-sync` skill when asked to audit documentation coverage or propose doc
updates. Before changing OpenAI platform integrations, verify models, request
fields, streaming behavior, tools, auth assumptions and rate limits against
current official OpenAI documentation. Agent skills are optional local
tools, not contributor or build prerequisites.

## Verification

Animama is primarily a desktop app: test UI changes at desktop viewport sizes first, then check narrower layouts for regressions.

Choose the smallest meaningful verification for the change and state what was
not run.

Run applicable local static checks, tests and builds before pushing a candidate
for review. Fix local failures first and batch intermediate work where
practical. After changes, rerun affected checks; do not repeat unchanged passing
checks without a reason. Use read-only checks such as `make format-check` to
verify formatting, rather than commands that rewrite files.

Hosted validation runs on the owner's own PR only when it carries the `ci:run`
label (the ordinary selected checks) or `ci:full` (every suite), and merges to
`main` start no run. When the machine is under heavy load, for example when
`python3 scripts/heavy-slot.py --status` shows every slot held, add `ci:run`
instead of running the expensive local checks, not in addition, and record the
hosted run as that evidence. Outside contributors' PRs always run it, after the
owner approves each run.

Run expensive checks locally before pushing, through the machine-wide
[heavy-job slots](SDLC.md#repository-setup) so parallel sessions queue instead of
competing for cores. For explicitly allowlisted routine
changes, a fresh exact-source Linux receipt reviewed by the repository owner can
replace selected hosted work under the local-first validation policy. This is an
owner-reviewed local assertion, not independent CI evidence. Receipts are not part
of the default flow: agents prepare one only when the owner plans a reduced hosted
run for that PR, and never impersonate the owner's review. Documentation-only changes
need no receipt; a hosted run of a high-risk or uncertain change, persistent
`ci:full`, manual runs and release callers validate in full.

Record local evidence and the actual hosted `Validation` scope separately, with
pending/failed/unperformed checks. Source, baseline, environment and freshness
requirements are in the [local-before-push workflow](docs/backend/operations/development.md#local-validation-before-pushing).
A deferred draft is not acceptance, and reduced validation does not establish
real avatar/audio fidelity, native release acceptance or publication approval.

Backend commands from the repo root:

```bash
uv run pytest -q
uv run ruff check
make check-test
```

`make test` and `make check-test` run pytest with `PYTEST_WORKERS` xdist workers
(default 2; 0 runs in-process). The workers share one PostgreSQL container, each
with its own database.

Frontend commands from `src/frontend`:

```bash
pnpm verify
pnpm web:test:browser
```

`pnpm verify` covers `pnpm check`, `pnpm web:lint`, `pnpm web:test` and
`pnpm build` with one package build and one `tsc -b`. The full pre-push suite
runs both commands; while iterating, run the slower `pnpm web:test:browser` only
for the changes listed in the [frontend guide](src/frontend/AGENTS.md#validation-checklist).

Root/local-stack checks:

```bash
bash -n reset.sh
export ANIMAMA_PARAKEET_MODEL_DIR="$(python3 scripts/models/parakeet.py path)"
export ANIMAMA_BROWSER_MODEL_DIR="$(python3 scripts/models/browser_speech.py path)"
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.development.yml config --quiet
```

For user-facing web, avatar, audio, voice, and desktop changes, manual testing
may be required because automated UI coverage is not yet mature.

Browser journeys run only when requested or chosen; CI does not run them. For
user-facing web changes, run `pnpm e2e:test:fast` from `src/frontend` against a
disposable built stack (about 5 minutes). Run the full `pnpm e2e:test` (about
35 minutes; the `@complete-anima` journeys import starter Animas of about 500
entries) for changes to content packages, import/export, content cleanup,
Animas or loadouts, and before merging them. See
[Browser Journeys](docs/frontend/testing/browser-journeys.md#current-automation-status)
for stack setup.

## Reporting Work

When finishing, summarize the behavior change, list important files touched,
and report validation. Include local stack URLs when you start or modify a
testing stack.
