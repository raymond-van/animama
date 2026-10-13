# Browser Journeys

The supported local journey is accountless and begins at the application
origin. FastAPI owns production serving and admission; development Vite proxies
application routes while preserving browser metadata. Tests never invent an
owner header or bypass the boundary to reach a separate backend origin.

## Development memory and profiling

The Vite app releases React's `Components ⚛` and `Scheduler ⚛` User Timing
measures after observer delivery, so ordinary editing does not retain an
unbounded development profile. App-owned measures and marks are preserved;
if an app measure shares a React measure's name, both remain because the browser
can clear only by name. Built web and desktop applications do not load this cleanup.

For an intentional React Performance recording, add `?reactProfile=1` to the
development URL and reload before recording (use `&reactProfile=1` if it already
has a query). This choice lasts for the loaded page, including hot updates and
route changes. Remove the parameter and reload to restore cleanup. Profiling
retains timing data, so exclude that opt-in tab when comparing ordinary memory
usage across repeated interactions.

## Reproducible accountless smoke

After installing locked backend/frontend dependencies, Chromium (`pnpm e2e:install`)
and building the web application (`pnpm build`), run from the repository root:

```bash
uv run --frozen --no-sync python src/frontend/scripts/e2e/run-accountless-smoke.py \
  --evidence /tmp/animama-browser-smoke
```

The evidence directory must not already exist. This runner owns one disposable
`pgvector/pgvector:pg16` container per serving mode, bound to a random loopback
port. `--pg-bin /path/to/bin` instead uses installed PostgreSQL binaries with
pgvector. It starts fresh FastAPI built and Vite development applications,
runs the same installation setup and original Library smoke test, and stops its owned processes
and removes temporary databases/content even on failure. Logs, Playwright reports,
and screenshot attachments remain in the evidence directory.

The fixture generates original structural VRM/VRMA content through the shared
backend test helper and runs production bootstrap without bypassing admission.
This proves bounded first-run and Library rendering with same-origin, bearer-free
API requests. It does not prove real starter animation, avatar rendering, audio,
content acquisition, cache/workspace concurrency, or packaged desktop behavior.
No maintainer `.env` or provider credentials are passed to the owned processes.
The runner filters out the real-avatar pose journey in the same spec.

## Current Automation Status

Hosted composition fixtures run through `pnpm web:test`; they require neither
an installation bootstrap nor a Cloud checkout. To run the retained workflow
HTTP fixture alone, first build the public packages, then run from `src/frontend`:

```bash
pnpm packages:build
node --test web/scripts/hosted-workflows.browser.test.mjs
```

This fixture starts an independent loopback HTTP authority and headless Chromium.
Synthetic HttpOnly sessions and CSRF/Origin checks admit the existing shared
router, hooks and generated clients. Unknown routes fail. It covers settings
inheritance, typed saves and quota recovery, verified private preview bytes,
loadout revision/replay contracts, chat history and quota retry, logical memory
and manager approvals, package receipt reentry/export, and owner/session cleanup.
Its service responses are contract fixtures; they do not establish Cloud
business logic, provider output or physical audio/microphone acceptance.

The separate hosted composition fixture tests admission, exact exclusions and
durable private recovery cleanup. Browser utility tests use the actual fullscreen
DOM and a real popup; they simulate only the Document PiP window-creation API.
Speech fixtures create real Web Audio contexts: failure closes its context and
keeps text fallback, while success loads the checked-in worklet and opens a
cookie-authorized loopback WebSocket before sign-out closes both. Microphone
settings also exercise a real denied Chromium permission. These cases make no
provider connection and establish no heard output or physical capture. Keep
package builds and browser tests sequential so emitted-package changes cannot
invalidate a running browser's module graph.

The active Playwright projects use installation setup and same-origin requests,
without accounts, stored login state, owner headers or browser bearer tokens.
The explicit allowlist selects `accountless-library`, `accountless-journeys`,
`accountless-vfx-layout`, `accountless-pose-content`,
`accountless-content-sharing`, `accountless-imported-playback`,
`accountless-numeric-input`, `accountless-creator-discard(-local)`,
`accountless-effect-template-picker`,
`accountless-avatar-effect-direct-manipulation`,
`accountless-creator-generated-gesture`,
`accountless-particle-texture-import` and `accountless-scene-layers` specs.
They cover Library, companion
selection, chat Stop/recovery, creator JSON import/preview, Save/reload revision
integrity, package sharing, the Effects template picker and template drafts,
Avatar Effect direct manipulation and face-part correction, Particle texture
import through recovery, Save, reopen and packages, the optional Scene layers
through the creator, Save, reopen, the preview dock and packages, responsive
access to
review and recovery controls, and `animaPoseClip/2.0` creator round trips (a
generated Gesture retimed, posed, saved and reopened with its detail; 1.0
Gestures and Reactions saved as 2.0).
Older creator journeys remain unselected until individually reviewed; listing
them is not passing evidence.
The separate `local:verify:accountless` API journey covers bootstrap, settings,
starter/custom Animas, private uploads, typed bytes, chat receipts and persistence.

Run these automated Playwright journeys only against a disposable named stack
with deterministic model clients and its own Local content. These runner guards
do not require a separate stack for ordinary manual testing: test chats and
content may use an existing development stack when they will not disrupt another
active task. Follow the [workspace selection rules](../../../AGENTS.md#workspace-selection).
For the automated runner, start a built stack from the repository root:

```bash
ANIMAMA_LLM_SKIP=1 ANIMAMA_WEB_BUILD_MODE=production ./reset.sh --name browser-a --base-port 8600
source .animama-stack.env
export ANIMAMA_E2E_ALLOW_MUTATIONS=1
cd src/frontend
pnpm e2e:test        # Full suite, about 11 minutes.
pnpm e2e:test:fast   # Skips the two @complete-anima package journeys, about 5 minutes.
```

Durations were measured on an Apple M5 Mac with OrbStack and one other idle
stack. Run the fast subset routinely after frontend changes. Run the full
suite before merging changes to content packages, imports, cleanup or Animas.

Prefer a built stack for journeys and for agent live checks that do not need
source edits to appear immediately. It has no reload watcher or Vite, so it
starts warm and uses less memory and CPU per stack, which matters when several
agents run stacks in parallel. The full suite takes about 25 minutes on a
development stack. Use a development stack when you are editing and checking UI
changes interactively. A built stack serves the image baked at reset, so rerun
`./reset.sh` after source changes. When several stacks run at once, raising
OrbStack's VM memory limit adds a safety margin. It does not replace built
stacks and narrow watchers.

On macOS, headless journeys render WebGL on the GPU through ANGLE Metal. Other
hosts, such as Linux validation containers, use CPU-based SwiftShader, which is
much slower for Avatar canvases. Set `ANIMAMA_E2E_WEBGL=swiftshader` or `metal`
to override the choice.

The runner requires an explicit loopback application origin, a named
`animama-*` project and a non-default Local root from the selected stack record.
`ANIMAMA_E2E_WEB_URL`, `ANIMAMA_E2E_COMPOSE_PROJECT` and
`ANIMAMA_E2E_LOCAL_CONTENT_ROOT` can explicitly describe an equivalent disposable
fixture. They are assertions of ownership, not automatic isolation: never point
them at a personal installation. Setup, companion selection and chats persist in
that fixture. Retain the named stack's database and storage by default for review
or continued work; disposable data does not mean automatic deletion after a run.
Follow [task-scoped cleanup](../../backend/operations/development.md#cleaning-up-worktree-stacks)
to inspect ownership, stop only task-owned services and preserve retained data
before removing a worktree. Purge or storage removal needs a concrete need and
the applicable authorization. The separate reproducible smoke runner above
still removes the temporary databases/content it creates and owns. Do not reuse
account credentials or old auth-state settings; the runner rejects them.

```bash
pnpm e2e:list       # Offline discovery; no application or browser required.
pnpm e2e:check      # Type-check all browser test sources, including inactive ones.
node --test scripts/e2e/*.test.mjs
```

Unexpected browser `pageerror` events fail active tests and remain in the evidence.
The runner records per-project locking, source identity, traces, request failures,
and an exact content ownership ledger under ignored `.animama-e2e/runs/`.
Created catalog items must still be cleaned up using their recorded ID, revision,
logical key and verified files; retaining stack data does not waive this exact
content-ledger cleanup. Failed cleanup remains a failed result; recovery cleanup
must target the same recorded origin/project and owned Local root. Use
`pnpm e2e:cleanup -- RUN_ID` to inspect unresolved items, then
`pnpm e2e:cleanup -- RUN_ID --confirm RUN_ID` with the exact generated ID to
perform recovery. The same isolated-stack environment and consent are required.
Package imports record their operation and review before commit. After a lost
reply, cleanup binds only the matching completed receipt's original item IDs and
revisions. Whole-package cleanup records every installed dependency and any new
Anima/private Avatar; saved-definition checks protect later Anima edits. Pending
outcomes or changed items retain the ledger and block deletion. Names never grant
cleanup authority.

The backend admits two open package stages per owner. A committed import or an
undownloaded export review counts until the sharing dialog releases it or it
expires after 30 minutes. After each journey, a fixture discards the stages the
browser opened and left open, attaching `package-stages-released-after-journey`
evidence. A stage that stays held, or a stage reply it cannot read, fails that
journey. Helpers that open stages through `page.request`, such as the Pose round
trip, must release their own. Stages from an interrupted run still count until
they expire, so a following run can fail with `package_stage_limit`.

Creator coverage uses the editor JSON import UI. The Pose round trip uses the
reviewed package API with `.zip` files and the `/3` manifest; the separate sharing
journey below uses the real Library package dialogs. Chat cancellation
uses a controlled pending browser request, followed by actual deterministic backend
chat. Real provider cancellation is tested separately over Uvicorn. Neither is
live provider, audio, physical keyboard or packaged desktop acceptance.

For a separately approved live-provider rehearsal, record the actual Stop click,
text increments before it, browser transport closure and backend cleanup as
separate observations. A closed SSE connection or a restored composer does not
prove that the upstream provider stopped generating or billing. Preserve failed
and interrupted attempts in both the evidence and the request budget; verify saved
messages before claiming a completed turn survived reload.

The active Library pose journey previews the tracked Have an Idea Gesture
(`have-an-idea`) on a real sample avatar. It checks a visible canvas, advancing
pose time, resolved skeleton bones, the `idea-bulb` event and its
`idea_bulb_fingertip` Avatar Effect image, plus protected resource responses.
The bulb event starts 2.6 s into the clip, so the check waits past it.
Screenshot and observation attachments retain the rendering evidence; the known
single unresolved sample-avatar bone is allowed. `playback-library.spec.ts` is
outside the active `chromium` project and is only type-checked: its
`library-gesture-have-an-idea` repeats the Gesture Avatar Effect proof, and
`library-reaction-curiosity-3` would check Scene Effect playback on Curiosity
Reaction 3, because no Included Gesture plays a Scene Effect. Active Scene
Effect coverage comes from the imported Gesture and Reaction in
`accountless-imported-playback.spec.ts`. The focused pose test permits only
reads and gesture-preview preparation requests; it does not select an Anima
through saved settings, chat, upload or play audio. Optional Local Mixamo VRMA
playback and imported animation acceptance remain separate. Run this focused check on an already initialized
named stack with the tracked avatar inputs:

```bash
pnpm e2e:test -- --project chromium --no-deps --grep "accountless built-in pose playback"
```

This focused pose check is not part of the generated structural-avatar fixture's
acceptance claim; it requires the real tracked avatar and built-in pose content.

The active `pose content` group covers standalone Included/Local Poses: Library
discovery, real-Avatar static preview, customization, editing, failed-save retry,
browser-storage independence, and portable Pose packages. It uses named-stack
mutation opt-in and the exact content ownership ledger described below. Run it with
mutation opt-in on a disposable task stack; verify selection before execution:

```bash
pnpm e2e:list -- --project chromium --grep "pose content"
pnpm e2e:test -- --project chromium --grep "pose content"
```

The active `local content sharing` group exercises real Library selection,
review, browser download, file upload and whole-package commit for single/multiple
content roots and a complete Anima. It checks automatic collision suffixes,
persistence after reload, missing-export-cache Back navigation, and recovery of
a completed import whose HTTP response was lost. The recovery check retains the
same operation and verifies that the UI does not create or commit another import.
Normal downloads rely on product cache cleanup rather than test-only deletion.
Desktop and narrow screenshots cover entry, content selection, Anima selection
and import review after dialog bounds settle.

These tests create disposable fixture content and imported companions; existing
starter Animas are read only. They use the same exact receipt-based cleanup as
other content journeys. Run against each serving mode required by the task and
retain separate results; browser coverage is not native-picker or packaged
desktop acceptance.

```bash
pnpm e2e:list -- --project chromium --grep "local content sharing"
pnpm e2e:test -- --project chromium --grep "local content sharing"
```

The `imported playback` group follows ZIP imports through Library previews,
applicable creator routes, and separate FX/Sound handoffs into new Gestures and
Reactions. Assertions bind playback to the exact imported item and revision;
they check advancing clocks, active effects, expressions and decoded audio rather
than treating a successful import as playback evidence. Its complete-Anima test
also checks imported Avatar/Appearance provenance and loadout playback. The
starter closure is large, so its revision-guarded cleanup has a thirty-minute
test budget. This is browser playback evidence, not speaker-listening acceptance.

Use the signals owned by each creator. Particle authoring renders directly through
Quarks, so its proof isolates moving canvas pixels instead of reading the Avatar's
particle controller. Scene authoring owns Play/Stop independently of runtime
expiry; its proof checks loaded image layers, marquee motion and removal on Stop.
Library, Action and Anima playback retain their runtime controller assertions.

```bash
pnpm e2e:list -- --project chromium --grep "imported playback"
pnpm e2e:test -- --project chromium --grep "imported playback"
```

The bounded application smoke test accepts only the configured origin:

```bash
source ../../.animama-stack.env
pnpm local:smoke:accountless -- --origin "$ANIMAMA_PUBLIC_ORIGIN"
```

It never reads or prints the installation principal or desktop-control credentials.

For a new isolated stack started with deterministic local model clients, run
the complete setup journey:

```bash
ANIMAMA_LLM_SKIP=1 ./reset.sh --name browser-a --base-port 8600
source .animama-stack.env
cd src/frontend
pnpm local:verify:accountless -- \
  --origin "$ANIMAMA_PUBLIC_ORIGIN" \
  --setup name \
  --display-name "Browser Test" \
  --profile-name "Browser Test Updated"
```

After restarting the same named stack with its saved environment, use `--setup existing` and
the same `--profile-name`. That mode requires the custom Anima, chat history,
private file, completed first run, and personalization to have survived. Fresh
named setup first verifies that missing, null, and blank names are rejected;
`--setup` accepts only `name` or `existing`. No additional stack is
needed to verify name validation. Root launch should open the last visited
owned Anima, or Annie on a fresh installation.
Output contains only bounded pass/fail booleans and counts, never principal or
credential values.

## Main-Stack Journey

From the primary checkout on `main`, start or restart the main local stack only
when it is safe to share with active tasks:

```bash
./reset.sh
```

Open `http://localhost:8000`. An installation whose first run is incomplete
shows `/setup`; its Welcome step requires a nonblank private display name,
while the AI and Voice steps offer "Skip for now". Finish opens a blocking 18+
modal at the first Anima; only explicit confirmation completes onboarding.
After completion, `/` resolves to the last visited owned Anima's chat, or Annie
on a fresh installation. A normal restart must retain
the completed state, local display name, Animas, chats, content, and files.

Use `./reset.sh --purge` only when a fresh installation is required. Purge
deletes the selected local database and writable roots, creates a new
installation principal, and returns to first-run setup. It is not an account
recovery operation.

When testing the task revision requires a separate stack, run from its worktree
with an isolated name and application port. Follow the
[workspace policy](../../../AGENTS.md#workspace-selection):

```bash
./reset.sh --name browser-a --base-port 8600
source .animama-stack.env
```

Open the generated `ANIMAMA_PUBLIC_ORIGIN`. Do not use the main stack's URL,
data roots, or bare Compose commands for a named stack.

## Required Observations

For a fresh accountless check:

1. Confirm the page loads from the application origin and never redirects to a credential screen.
2. Confirm blank names cannot continue, then complete setup with a non-sensitive
   test display name and confirm Annie opens at `/$animaId`.
3. Create an Anima and open its chat surface.
4. Load an Avatar portrait or another private byte through a same-origin `/v1`
   URL without an Authorization header.
5. Open App Settings → General, edit Display Name, and confirm the response
   contains only the private display name and that it cannot be cleared.
6. Restart with `./reset.sh`, reopen the same origin, and confirm setup does not
   return, local state remains, and root launch opens the last visited Anima.
7. Confirm the user menu has no account-management or logout control.

Boundary-negative behavior is covered by the FastAPI admission and real Uvicorn
transport tests. Hostile Host/Origin, cross-site Fetch Metadata, missing mutation
CSRF and missing Electron renderer capability fail safely. Forged owner headers
never change ownership. Ordinary renderer requests cannot use desktop controls.

## Evidence Safety

Screenshots, traces, videos, logs, and attachments must not contain API keys,
cookies, desktop-control credentials, private headers, storage locators, or
principal values. Prefer bounded booleans, counts, response status, and hashes
when proving persistence or token rotation. Do not record private file bodies or
semantic memory contents unless the fixture was created expressly for the run.

Every stateful journey must identify its selected stack and resources it created
before cleanup; automated journeys require the exact named fixture described
above. A display name or guessed ID never grants deletion
authority. If ownership evidence is incomplete, stop and leave the resource for
manual review.

## Troubleshooting

- Use the selected application origin, normally `localhost:8000`; Vite's
  internal container port is not an additional public endpoint.
- In development FastAPI stays private. In built mode FastAPI is the application
  listener and Vite is absent. PostgreSQL stays private in both selections.
- Source the correct stack record before project-scoped inspection or restart;
  it includes the development/production Compose graph.
- If the installation singleton is missing while owner data exists, the stack
  must stay failed closed until a coordinated backup is restored.
