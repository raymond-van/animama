# Generate content in the app: Gestures and Reactions first

Source agreement: [#942](https://github.com/raymond-van/animama/issues/942),
published from the agreed [spec](in-app-generation-spec.md) and captured at
2026-11-26T19:02:50Z. The owner accepted the spec on 2026-11-24, including P1
and P3 to P12. It was revised on 2026-11-26 where delivered work changed a
fact (the ChatGPT plan connection, #919, and chat image input, #904), and the
owner added R3.7 the same day.
Authorized scope: Phases 0 to 3. The owner approved this plan on 2026-11-26
(G0), including D1 to D17, and authorized Phases 0 to 3 the same day. D18 to
D20 were added after G0 to meet R3.7. Gates G1 to G8 still apply where the
phases name them.
Planning baseline: `origin/main` at `4ba6db1c5`, which the line numbers below
refer to. Implementation base: `origin/main` at `be048d5b3`, merged as
`c2f9fa3b5`; the two commits between them change only lifecycle and licensing
documents.
Workspace: worktree `in-app-generation`, branch `feat/in-app-generation`; the
spec snapshot is commit `4e53de1aa`. Task stack `animama-generate` at
`http://animama-generate.localhost:9300` (development mode), started with
`./reset.sh --name generate --base-port 9300` when a phase needs it and
stopped afterwards; it holds only test data.

## Purpose and context

After this plan, a person running Animama locally opens a **Generate** page,
asks for a Gesture or Reaction in words, and watches drafts play on an Avatar.
An AI assistant with no persona writes each draft as an `animaPoseClip/2.0`
clip, with its face keyed from the named blendshapes the chosen Avatar
offers. The app validates it, runs the motion checks the `animama-animation`
skill uses, has the assistant repair what fails, and lists what is left as
warnings. The person revises by chat, then saves the draft as Local content
through the creator's own save path. The same assistant opens from a floating
control in the Gesture and Reaction creators. It works on a ChatGPT plan model
first, then on any Model connection whose model calls tools. Later phases add
batches, effects on the timeline, references and presets, and a connector for
a person's own Claude client. Nothing here exists in the hosted composition.

The spec's first usable phase (one new Gesture end to end on a ChatGPT plan
model) is Phases 0 to 3 of this plan. Phases 4 to 8 follow the order the
owner accepted as P12.

Orientation, from read-only surveys on 2026-11-26. Backend paths are under
`src/backend/animama` and web paths under `src/frontend/web/src` unless they
start with `src/`, `tests`, `docs`, `scripts`, `contracts` or `.agents`.

- **The skill's loop.** `.agents/skills/animama-animation/` holds `SKILL.md`
  and eight reference files (72 KB). Its steps are: a short interview, plan
  the beats, write the clip, `animation validate`, `animation check`, look at
  the live preview and `animation:render` sheets, then `animation:save`
  through the Gesture creator in a headless browser. A batch is at most ten.
  It names no repair limit.
- **Motion checks.** `lib/avatar/motion-authoring/checks.ts` `checkMotion(clip,
  avatars, options)` (L222) returns `MotionCheckReport` (L83) with findings in
  ten categories (L44-54): pose, range, smoothness, oscillation, intersection,
  fingers, contact, feet, loop seam and parity. It needs the clip and loaded
  three-vrm `VRM` objects, and no renderer, canvas or DOM. Today it runs in
  Node through Vite (`src/frontend/web/scripts/animation.mjs` L10-32) on VRMs
  loaded by `headlessVrm.ts` `loadHeadlessVrm` (L63), which replaces textures
  with placeholders. The earlier authoring plan measured about 15 ms to load
  each VRM and about 0.5 s to check a short clip on both Included Avatars. The
  app imports nothing from `motion-authoring/` today.
- **The validate step.** `motion-authoring/cli.ts` `compactClipFile` (L151)
  joins `validateAnimaPoseClipV2` (`poses/animaPoseClip/schemaV2.ts` L247),
  the anatomical hard limits (`anatomicalLimitIssues`, L181) and the 2 MiB
  size cap. `cli.ts` imports Node modules, so the app cannot import it. The
  creator and the backend apply no hard-limit check.
- **Backend clip validation.** `app/services/idle_clip_validation.py`
  `validate_clip_v2_timeline` (L439) mirrors the frontend's structural
  validator. Shared fixtures keep the two aligned
  (`tests/test_pose_clip_v2.py`). `content_save_service.py` caps a clip at
  2 MiB (L70).
- **Review frames.** `src/frontend/web/scripts/animation-render/render.ts`
  draws the skill's contact sheets: front, three-quarter, side and face views
  (L61-79) per Avatar and time, on its own `WebGLRenderer`. It is a script
  page outside the app's TypeScript project, built from app modules. The
  earlier authoring plan measured about 6 s a sheet on the software renderer
  that script uses.
- **Creators.** Gestures and Reactions share `ui/action-editor/
  ActionEditorPage.tsx` (L139). The document is an `ActionDocument`
  (`actionDocument.ts` L14-27) in React state; the live timeline is the
  Zustand `usePoseCreatorStore`; undo is `useCreatorHistory`, which snapshots
  the sequence and dependencies. An Included item is customised into a new
  Local item at its first Save (L346-426), and a non-portable item is refused
  (L356).
- **Reactions carry no body motion.** `sanitizeReactionSequence`
  (`actionDocument.ts` L165-176) removes joints, hands, contacts and
  `plantFeet`. A Reaction is face expressions and effect events, placed by
  `suggestedEmotion` and `suggestedIntensity` (1 to 4).
- **Faces.** A clip's `expressions` tracks take any expression name
  (`poses/animaPoseClip/schemaV2.ts` L592-607). At load every morph-target
  name becomes an expression of the same name, and ARKit shapes are also
  registered under their canonical names
  (`docs/frontend/runtime/avatar-animation.md`, "ARKit face shapes"). VRM
  mood presets and VRoid's `Fcl_*` parts play on every Avatar: each brow, eye
  and mouth region uses the Avatar's own VRoid part, else its standard MMD
  morph, else an ARKit mix, else the preset
  (`docs/frontend/runtime/avatar-emotion.md`, "Faces on non-VRoid Avatars").
  `Avatar.getAvailableExpressions()` lists what an Avatar offers
  (`lib/avatar/expressionUtils.ts` L22), and `pnpm -s vrm:inspect` reports it
  for a file. Included Gestures key whole-face presets (`happy` in 111 of
  152), and Included Reactions key the per-region parts, which keep the mouth
  mostly closed under lip-sync. The skill's face guidance names VRM presets
  only.
- **Project file.** `animamaActionProject/1.0` (`actionProject.ts` L25-39)
  carries the intent, name, AI description, Selector ID, emotion and
  intensity, the sequence and typed dependencies. The creator's Import accepts
  it (`parseActionImport`, L158).
- **Save path.** `saveAction` (`ActionEditorPage.tsx` L636-740) validates the
  document and calls `useActionEditorActions` (`query/mutations/
  useActionEditorActions.ts` L157), which sends `PUT /v1/gestures/{entry_name}`
  or the Reaction equivalent (`product_http/routes/typed_content.py` L416) to
  `ContentSaveService.save_descriptor_streams` (L464-591). A Gesture needs a
  name, an AI description and a Selector ID. A new item whose folder exists
  fails with `content_path_exists`.
- **Preview.** Creators play the store's clip through
  `PoseCreatorPreviewProvider` (L79-196) and `ActionEditorScene` (L18-149),
  with transport actions in the store (L1501-1556). The Avatar comes from
  `useContentCreatorModelPreview`: the last active Anima's model, plus the
  Included Avatars when `includedAvatars` is set, which only the Avatar Effect
  creator does. `ContentPreviewExclusiveCanvasGate`
  (`ui/content-preview/ContentPreviewDockProvider.tsx` L167-197) keeps one
  Avatar canvas mounted. Effects on a timeline preview through sandbox entries
  built from the document's dependencies.
- **Entry points.** The Create page lists creators in `ACTION_CREATORS`
  (`ui/create/CreateHubPage.tsx` L73-82) and the sidebar in
  `PRIMARY_CREATE_LINKS` (`ui/sidebar/SidebarCreateMenu.tsx` L52-68);
  `ui/create/CreatorEntryPoints.test.ts` pins both. Capability gates are
  `ui/app/RuntimeFeatureGate.tsx` (L8) and `app/runtime/route-admission.ts`
  (L70).
- **Creator layout.** The Gesture and Reaction creator draws panels over a
  full-bleed scene, with the timeline anchored at the bottom
  (`ActionEditorWorkspace.tsx` L707-714). Nothing floats above its panels
  today. `ui/content-creator/CreatorFloatingPanel.tsx` exists for the effect
  creators.
- **Chat components.** `ChatConversation`, the `ChatInput` primitives and the
  Markdown `Response` (with the image and HTML policy) are in
  `src/frontend/packages/product-ui` and take plain props.
  `ChatGPTPlanUsageNote` (`ui/components/chatgpt-plan-usage-note.tsx` L15)
  also takes plain props. The chat's model picker,
  `ChatInputModelSelector` (`ui/components/chat-input.tsx` L418), needs an
  Anima and writes its chat profile.
- **Model clients.** `ModelClient.stream(ModelClientRequest)`
  (`app/model_clients/types.py` L331) is provider neutral: a `DirectChatPrompt`
  with function tools goes in, and the final carries `tool_calls`, `usage` and
  a `continuation`. `server/model_clients.py` (L46-114) registers the Chat
  Completions, Responses, Anthropic and ChatGPT plan clients, or one mock for
  all under `ANIMAMA_LLM_SKIP`. Tool results return to the model as messages
  shaped per provider family; the helpers that build them are private to the
  chat turn (`app/chat/direct_turn/model_stream.py` L989 and L1120,
  `provider_state.py` L361). That turn's loop is bound to Anima chat: four
  rounds, memory tools and a chat. The plan client always asks for an
  `interactive` token (`adapters/model_clients/openai_responses/
  chatgpt_plan_client.py` L192). The Memory Manager's Agents SDK client on the
  plan route (`adapters/memory_manager/chatgpt_plan_agents.py`) serves only
  unstreamed calls.
- **Images.** A request carries `ModelClientImage` bytes keyed by id
  (`types.py` L320), named from the prompt by `model_client_image` parts
  (`app/model_clients/image_parts.py`), at most 20 a request. Every adapter
  reads images only in user messages, and a tool result is text. A chat image
  is a user file with `metadata.kind` `image`: the server keeps one canonical
  copy (long edge at most 2,000 px), and the Library lists it.
- **Catalog flags.** A model row has `supports_tools` and `accepts`
  (`domain/model_provider.py` L16-35), both in the public
  `PyModelProviderCatalogItem`. Two built-in rows carry prices, and
  `estimate_model_token_cost` (`app/util/model_pricing.py` L162) has no
  production caller. Plan rows have no price. No screen shows token use today.
- **Preferences.** Model roles are keys in `user_settings.preferences`, a
  free-form JSON object; the settings route validates only the role keys
  (`product_http/routes/settings.py` L28-39).
- **Streaming and stop.** Chat frames come from `format_sse`
  (`product_http/chat/sse_events.py` L105). A chat stops when the page closes
  the request; there is no stop route. Only chat streams a run.
  `GET /v1/events:sse` sends heartbeats only, so pages learn of changes by
  polling.
- **Routes and capabilities.** `product_http/inventory.py` lists every route
  as `_shared`, `_local` or `_excluded(capability)`. `chatgpt_plan` is the
  precedent for a local-only capability: `app/contracts/
  runtime_capabilities.py` L84, `server/runtime_capabilities.py` L93,
  `contracts/runtime-capabilities/hosted.json`, `contracts/hosted-web.md`,
  `app/hosted-runtime/hosted-composition.ts` L537 and their tests.
- **Contracts.** `contracts/versions.json` has `local-http` `25.0.0`.
  `runtime-contracts` is `0.25.0` and `product-ui` `0.22.0`. Any structural
  OpenAPI change needs a new major, and changed declarations need a package
  bump (`scripts/package-sets` `compare`).
- **Persistence.** The Alembic head is `reasoning_effort_20261112`
  (`0002_reasoning_effort.py`). No revision creates a table yet. Newer
  per-owner tables name their owner column `owner_user_id` and use `JSONB`.
- **Chats are a different store.** `chats.anima_id` is required, and the chat
  list, chat search, Reflections and episode notes all read `chats` and
  `chat_messages` by owner.
- **Admission.** `local/http/admission.py` admits browser requests by Host,
  Origin, fetch metadata and a CSRF header. On desktop it also needs the
  renderer's per-launch cookie, so no outside process is admitted. A
  self-hosted stack admits any local caller that sends the right headers.
  Nothing pairs an outside client today.
- **Journeys.** Stacks under test run `ANIMAMA_LLM_SKIP=1`. The mock model
  client replies with fixed text, and the Memory Manager swaps in a
  deterministic runtime (`adapters/memory_manager/fake_runtime.py`).
- **Language.** The page sends its locale as `ui_locale`;
  `app/chat/conversation_language.py` (L55-66) turns it into a reply-language
  instruction.
- **Records.** Every tracked file needs an entry in
  `licenses/source-review.json`. The next free ADR number is 0041.

### How a run works

This is the design the phases build (D1 to D8). Names are proposals.

1. The page posts the person's message to
   `POST /v1/generation/conversations/{id}/runs:sse` with the chosen model,
   the selected draft, the UI locale and the names of the chosen Avatar's
   expressions (D19). The backend owns the instructions, the tools and the
   stored conversation; the page supplies none of them.
2. **Write pass.** The backend sends one model request: the shared authoring
   guidance, the recent conversation text, the selected draft (for a revision)
   and the message. The model may ask questions once, then writes the clip
   through function tools. Each write is checked on the server for size and
   structure, and the tool result lists any problems by JSON path, so the
   model fixes structure inside the pass.
3. The backend stores the draft version and tells the page. The page runs the
   full validation (with the anatomical limits) and, when the clip loads,
   plays it in the preview and runs the motion checks on both Included
   Avatars. It sends the report back with `PUT …/check-report`.
4. **Repair passes.** While the report has failed checks, the backend sends a
   fresh request with the guidance, the current clip and the findings, and the
   model edits the clip. At most three repair passes run for a draft version.
5. **Frame review.** With a model that accepts images, the page renders one
   contact sheet per Included Avatar and uploads them. The backend sends one
   request with the sheets in a user message. The model accepts the draft or
   makes one edit, which the page checks once more.
6. The draft ends `ready`, or `warnings` with what remains in plain words, or
   `failed` with a reason when no version loads. The run's last frame carries
   its token use. Save and Open in creator are the person's actions on the
   page.

Each pass is a new request built from stored state, not one growing tool
transcript. A run therefore makes at most five model passes for a draft
version: one write, three repairs and one frame review.

## Threat model

Assets: the person's plan allowance and provider keys, their Local content and
reference images, their own Avatar's appearance, and the integrity of what the
app loads and saves. Boundaries: the model and the backend (untrusted output),
the page and the backend (`/v1/generation`), the backend and the model
provider, and, in Phase 8, an outside client and the backend.

| # | Threat | Mitigation | Tests |
| --- | --- | --- | --- |
| T1 | Model output makes the app load or save something harmful. | A clip is parsed as JSON, capped at 2 MiB and validated on the server at every write, and validated again by the page before it reaches the player. Save goes through the typed save path with its own checks. Text renders under the existing Markdown policy. | An unloadable output reaches neither the preview nor Save; oversized and malformed tool arguments are refused; raw HTML and outside images in assistant text do not render. |
| T2 | The assistant becomes a way to run commands or read files. | Tools are a fixed authoring set with typed arguments: no shell, path, URL or command. A name the model invents is refused. | The tool list is pinned; an unknown tool and a path-like argument are refused. |
| T3 | The feature becomes a relay that spends the plan for other tools. | The backend builds every request from fixed instructions and tools; a caller supplies only the person's message and the page's reports. No route takes instructions, a tool list or model output from its caller. The connector never starts a model request. | No generation route accepts instructions or tools; a connector call makes no model request. |
| T4 | Content leaves the machine that should not: non-portable content, or the person's own Avatar. | Reference and example lookups refuse non-portable items in the service, not only in the picker. Review frames are rendered only on the Included Avatars, by a renderer that takes no other Avatar. Of the person's own Avatar, only the names of its expressions and blendshapes are sent (R3.7). Requests go only to the provider of the chosen model. | A non-portable item cannot be read by a tool or chosen as a reference; the frame renderer accepts only Included Avatar ids; a run request carries names and no other Avatar data. |
| T5 | Assistant conversations leak into chat features. | Conversations and drafts have their own tables, with no Anima and no row in `chats` or `chat_messages`. | After a run, the chat list, chat search, Reflection input and memory files do not contain it. |
| T6 | The page's check report or frames are forged or oversized. | The report is schema-checked and bounded. Frames are decoded by the bounded image opener chat images use, capped in count and size, and kept only for the request. A report changes only the warnings a draft shows; loading and Save never depend on it. | Oversized reports and frames are refused; a frame is in no table or file after the run. |
| T7 | A run spends without limit. | Passes per draft version, tool rounds per pass, drafts per request and frames per review are fixed limits in the service. One run at a time per conversation. | Each limit ends the run with the draft kept; a second run on a conversation is refused. |
| T8 | The hosted composition exposes the feature. | A `content_generation` capability is false in the hosted contract, the routes are withheld by it, and the hosted page refuses a runtime that reports it. | Inventory, capability and hosted-composition tests. |
| T9 | An outside process drives the assistant's tools without the person's consent (Phase 8). | A connector is admitted only with a token created by pairing from the Generate page, on its own path, with the authoring tools only. Revoking removes it. The rule gets its own review at G6. | Unpaired and revoked clients are refused; the connector reaches no other route. |
| T10 | Blendshape names from an Avatar file steer the model. A file from elsewhere can name a morph target anything. | Names are capped in number and length, lose control characters and reach the model as a list of data. The tools can only author a draft, so the worst result is a poor draft. | An over-long name and one with control characters are dropped; the cap holds; a name worded as an instruction changes no tool behavior. |

## Progress

- [x] Spec published as #942, read back, and committed as a snapshot
  (`4e53de1aa`, 2026-11-26).
- [x] Plan drafted on `feat/in-app-generation` from `origin/main`
  `4ba6db1c5` (2026-11-26).
- [x] G0: the owner approved this plan, including D1 to D17 (2026-11-26).
- [x] R3.7 added by the owner (2026-11-26): #942 updated and read back, the
  snapshot refreshed, D18 to D20 added.
- [x] Workspace setup (2026-11-26): `origin/main` merged, Phases 0 to 3
  recorded, the branch pushed, the plan linked in #942 at `efbb04497`, the
  issue moved to `triage:ready-for-agent`, dependencies installed with
  Python 3.12.13. No stack started.
- [x] Phase 0: feasibility trial (2026-11-26). The page trial answers C2.
  The authoring trial ran on a live plan model (G1, 13 of 15 requests) and
  confirms D4, D8, D18 and D19. Code Review #2 passed.
- [ ] Phase 1: checks, validation, frames and guidance in app source.
- [ ] Phase 2: the assistant's backend.
- [ ] Phase 3: the Generate page. Ends the spec's first usable phase.
- [ ] Phase 4: other Model connections, usage and cost.
- [ ] Phase 5: the creator control, revising and Reactions.
- [ ] Phase 6: batches and effects on the timeline.
- [ ] Phase 7: references and presets (C3).
- [ ] Phase 8: the connector (C4).
- [ ] Phase 9: acceptance and closing records.

## Surprises & Discoveries

All from planning, 2026-11-26.

- The motion checks need no browser. They run in Node today, on skeletons
  with placeholder textures, so the page can run them without a second Avatar
  canvas. Only the review frames need WebGL.
- The validate step and the sheet renderer are script-only files. Both must
  move into app source before the app can share them with the skill.
- Anatomical hard limits are enforced only by the skill's `validate` command.
  Neither the creator nor the backend applies them, so a draft that passes the
  backend's structural validation can still fail the page's validation.
- A Reaction has no body motion: it is face expressions and effect events.
  Most motion checks therefore have nothing to measure on a Reaction, and a
  Reaction made before Phase 6 has expressions only.
- The skill is for Gestures. No shared guidance for authoring Reactions
  exists, so Phase 5 has to write it.
- Included Gesture clips have a median size of 24 KB and a ninetieth
  percentile of 45 KB (152 clips). Rewriting a whole clip at every repair
  would cost several thousand output tokens each time, which is why D4
  proposes an edit tool.
- Every model adapter reads images only in user messages, and tool results
  are text. Review frames therefore go in a user message of their own
  request, which D2's separate passes do anyway.
- A survey read the Anthropic adapter as treating the last plain user message
  as the turn, so a user message added after tool rounds could detach signed
  thinking blocks from their round. It was inferred from the code and not
  run. Separate passes avoid the case.
- The chat turn's tool loop is bound to Anima chat. Its provider-neutral
  helpers are private to that module, so Phase 2 moves them to a shared
  module instead of copying them.
- The Memory Manager's Agents SDK client on the plan route does not stream,
  and the Memory Manager has a second, hand-written loop for Anthropic. A
  loop on the model-client contract covers every provider with one
  implementation and streams.
- No screen shows token use, and prices exist for two built-in rows only.
  R6.3's estimate therefore appears for those models and for no other until a
  row carries a price.
- The backend cannot push to a page. Pages poll, and `GET /v1/events:sse` is
  a heartbeat. Phase 8's "drafts appear as they are made" will poll.
- On desktop no outside process can be admitted; a self-hosted stack admits
  any local caller with the right headers. A connector needs a new admission
  rule in both, and a way for an outside client to reach a desktop backend.
- The Gesture and Reaction creator's preview offers no Included Avatar today,
  and the chat's model picker needs an Anima. The Generate page needs both
  without one.
- `/gestures/new` never restores a stored draft, so Open in creator needs its
  own way in.
- The skill's reference files mix guidance any author needs (the clip format,
  movement, hands, what a check means) with command-line procedure. Only the
  first kind can be shared with the app.
- Included Gestures and Reactions key faces differently: Gestures use the
  whole-face presets and Reactions the brow, eye and mouth parts. The skill's
  guidance covers presets only, so R3.7's one guidance for both kinds is new
  text.
- A name only the chosen Avatar has (an ARKit shape, an MMD morph, an
  author's own blendshape) plays on no Avatar without it. VRM presets and
  VRoid parts play everywhere through the runtime's fallbacks. The review
  frames, drawn on the Included Avatars, cannot show a face keyed with names
  those Avatars lack.
- A survey inferred that the headless check path does not measure the face,
  which the renderer does, so size-aware contacts could differ on a
  big-headed Avatar. It was not tested. D7 keeps checks on the Included
  Avatars, where the skill's results already hold.

### Page trial, 2026-11-26

`pnpm -s generation:trial` ran in headless Chromium on the software renderer
(SwiftShader) and on the machine's GPU (an Apple M5 through Metal), with five
Included Gestures from 2 KB to 56 KB and 1 s to 9.5 s long.

| Subject | Observed |
| --- | --- |
| Loading an Avatar for checks | 9 to 25 ms each in the page (5 MB files, placeholder textures); 30 ms for both in a worker. |
| Checking a clip on both Avatars | 28 ms for a 1 s clip, 82 to 164 ms for clips of 4 to 9.5 s, and 314 to 346 ms for the slowest (8.25 s). The same on both renderers, because checks draw nothing. |
| The main thread | A check on the main thread blocks it for its whole length. In a worker the check took the same time and the page's timer never slipped more than 6 ms. |
| Findings | Identical between the command line, the page and the worker for all five clips, compared as formatted reports. |
| Loading an Avatar for frames | 142 to 234 ms each, with its materials. |
| A sheet pair on a second renderer | 0.9 s (GPU) and 2.6 s (software) the first time, about 25 ms afterwards. |
| A sheet pair through a render target on a renderer the page already has | 1.1 s (GPU) and 2.5 s (software) the first time, then 0.18 s (GPU) and 1.0 s (software). |
| Render-target pixels | Linear as read back: a mean difference of 14.6 in 255 from the second renderer's sheet. Encoded to sRGB after reading, the difference is 0.4. |
| Sheet size | 944 × 2008 px for six rows of four 220 × 330 tiles: about 0.8 MB as PNG and 0.17 to 0.19 MB as JPEG at quality 0.85. |

What this settles for C2:

- The motion checks and the frame rendering both run in the app. A Gesture
  of ordinary length checks on both Included Avatars in well under half a
  second, and a review's frames take about a second the first time.
- Checks run in a worker. On the main thread a check would freeze the page
  for up to a third of a second per draft version.
- Frames are drawn through a render target on the preview's own renderer and
  encoded to sRGB after reading, so no second WebGL context is needed. The
  shared sheet code takes the tile-drawing step as a parameter, which lets
  `animation:render` keep its own renderer and its present output.
- Frames are uploaded as JPEG, about a fifth of the PNG's size.

Left for later phases:

- The pose catalog that the checks import bundles every Included Gesture and
  Reaction clip (`poses/catalog.ts`, an eager glob). A worker gets its own
  copy of what it imports, so Phase 1 measures the built worker's size and
  passes the base pose in if the catalog makes it large.
- A hidden or covered window was not tried: a headless page always counts as
  visible. Neither path waits for an animation frame, so neither should
  depend on visibility; Phase 3's manual check confirms it.
- GPU memory with the Included Avatars loaded beside the previewed Avatar
  was not measured. Phase 1 releases them after each review unless that
  proves too slow.
- Providers scale large images down before a model sees them. Whether a
  sheet of 220 × 330 tiles stays readable is a question for the authoring
  trial, which also tries a squarer sheet.
- One Included Gesture, `meme-dab`, reports two FAIL findings on today's
  checks. A draft that ends with warnings is therefore not unusual.

### Authoring trial, 2026-11-26

`scripts/generation_probe.py` ran in the signed-in task stack's server
container on `gpt-6-luna` through the plan connection, 13 requests in all. Each pass is one fresh
request with the skill's five reference files and the joint list as
instructions (about 16,000 tokens) and the pass's tools. No effort was named
unless the row says so. Clips were checked with `pnpm -s animation check`.
Nothing below identifies the account.

| Pass | Result |
| --- | --- |
| Write "a shy little wave with a small smile" | One request, 20 s, 16,284 input and 1,036 output tokens. A valid clip (3 KB saved) with six beats, a hand shape, a face and muted layers. Every motion check passed on both Avatars. |
| Write "thinking with a hand on the chin, held while the Anima thinks" | One request, 22 s, 16,290 input and 1,162 output tokens. Valid, with a solved head contact. Checks: 3 FAIL (the hand through the head and neck on its way up, the forearm in the torso) and 6 WARN. |
| Write "a hearty laugh" | Two requests: it read an example first (2 s), then submitted (33 s, 18,840 input and 1,801 output tokens). Valid, and every check passed. |
| Repair the thinking clip by rewriting it | One request, 22 s, 17,744 input and 1,152 output tokens. Valid; 4 FAIL and 8 WARN remained. |
| Repair it through `edit_draft` | One request, 8 s, 17,795 input and 356 output tokens: 13 `set` operations by JSON Pointer, all applied. Valid; 4 FAIL and 7 WARN remained. |
| Repair it through `edit_draft`, naming medium and then high effort | One request each, 7 s, 290 and 321 output tokens and no reasoning tokens reported. 3 and 4 FAIL remained: naming an effort changed neither the time nor the result. |
| Three `edit_draft` repair passes in a row, each on the last one's findings | 3 FAIL, then 2, then 2. The hand stopped passing through the head. The forearm still overlapped the torso by about 3 cm against a limit of 1.5 cm. |
| Review frames of the wave with two faults seeded (an angry face, an arm that stays low); two 944 × 2008 sheets | One request, 4 s, 21,827 input and 119 output tokens. It replaced the angry face with a smile and judged the low arm an acceptable small wave. |
| The same review with 330 × 495 tiles (two 1384 × 2008 sheets) | One request, 4 s, 23,943 input tokens. The same edit and the same judgement. |
| Write "a cheeky wink with the tongue poking out, then a small grin" with 111 expression names of an Avatar with ARKit and MMD shapes | One request, 17 s, 17,007 input and 854 output tokens. It keyed `happy`, `relaxed`, `blinkRight` and three `Fcl_*_Fun` parts, then `tongueOut`, `mouthSmileLeft` and `mouthSmileRight` from the list, and no MMD name. |

The expression names came from the runtime's own ARKit and MMD tables with a
few invented author shapes, not from `vrm:inspect` on a private Avatar file.

What it shows:

- The plan route accepts function tools whose arguments are free-form
  objects, inside the namespace, and a whole clip arrives in one tool call.
- A write is usually one request of about 20 seconds. Two of three requests
  passed every check at once.
- `edit_draft` works: the model addressed keys by JSON Pointer correctly, at
  a third of the output and under half the time of a rewrite.
- Repair is partial on a hard pose. One pass did not clear a hand-to-chin
  contact with either tool, and three passes in a row reduced three failures
  to two. Such drafts end with warnings, as R4.3 allows.
- Naming a reasoning effort made no measurable difference on this route: the
  usage reported no reasoning tokens with or without one. The assistant
  therefore names none and leaves the model at its default.
- A pass sends 16,000 to 24,000 tokens. With room for a large clip and its
  findings, a model needs a context of about 64,000 tokens (Phase 4's
  eligibility rule).
- The frame review reads a face on the default sheet. Larger tiles changed
  nothing, so the sheet stays six rows of 220 × 330 tiles.
- Given an Avatar's names, the model follows D18: a portable mood first,
  then the Avatar's own shapes on top. It also stacked a preset with parts of
  the same mood, which the faces guidance must warn against.
- No request reported cached input, although each repeated the same 16,000
  tokens under one cache key. Chat on this route did report cached tokens
  (the ChatGPT plan's record). Phase 2 looks at what differs.

## Decision Log

- 2026-11-24, owner: the spec is accepted as written, including P1 and P3 to
  P12. Users are people running Animama locally; the hosted composition is
  out of scope.
- 2026-11-03, owner (standing instruction, recorded during #823): phases run
  the checks their changes affect, not the full pre-push suite. The full
  suite runs on a final candidate after the owner agrees to the run (G3).
- 2026-11-26, owner (task instruction): continue from the agreed spec; revise
  it only for delivered facts; extend the existing creator interface and
  components without redesigning them; make no Animama Cloud change; effect
  art stays a later slice on an image model reached with an API key; stop for
  review of this plan before implementing.
- 2026-11-26, agent: the spec was revised for delivered facts only. C1 is
  resolved; R4.4, R8.2 and R8.3 name the delivered image input; R2.4 and R6.3
  name the delivered plan failures and plan notice. No agreed decision
  changed.
- 2026-11-26, owner: this plan is approved at G0, including D1 to D17.
  Phases 0 to 3 are authorized.
- 2026-11-26, owner: Gesture and Reaction generation share one facial
  expression guidance, which keys named blendshapes (VRoid presets, MMD
  morphs with their Japanese labels, ARKit shapes and custom-authored
  blendshapes) according to what is available. Recorded in #942 as R3.7 with
  an acceptance line. The spec's privacy constraint now says that only the
  names of the chosen Avatar's expressions and blendshapes are sent.
- 2026-11-26, agent proposals, approved by the owner at G0. D7 and D15
  answer questions the spec left to the plan. D14 departs from the default of
  one pull request per plan. The rest are implementation choices inside the
  agreed behavior.
  - **D1. The backend owns the conversation, the instructions and the tools;
    the page runs the checks and renders the frames.** The check code and
    WebGL are in the page, and the credentials and the plan session are in
    the backend. A page-driven loop would need a route that takes a prompt
    from its caller (T3).
  - **D2. A run is a few bounded passes, each a fresh request built from
    stored state.** One write pass, at most three repair passes and one frame
    review for a draft version. The alternative, one long tool transcript,
    resends every earlier clip version on every round and ties a
    conversation to one provider's message format.
  - **D3. One tool loop on the model-client contract, for every provider.**
    It streams, carries images and already has the ChatGPT plan, Responses,
    Chat Completions and Anthropic clients. The Agents SDK client that the
    Memory Manager uses on the plan route does not stream and would need a
    second loop for Anthropic.
  - **D4. The model writes through a small fixed tool set**: `write_clip`,
    `edit_clip` (set or remove values by JSON path), `set_details` (name, AI
    description, Selector ID, and for a Reaction its emotion and intensity),
    `ask_questions` and `read_example` (one of the Included Gestures the
    guidance names). Edits keep repairs small. Phase 0 tries the edit tool
    on a live model before Phase 2 builds on it.
  - **D5. A draft is stored as an `animamaActionProject/1.0` project.** Save
    and Open in creator then reuse the creator's own import and save code,
    and a draft carries its dependencies when Phase 6 adds effects.
  - **D6. Three tables**: `generation_conversations`, `generation_messages`
    and `generation_drafts`, owned by `owner_user_id`. A draft keeps its
    current project and the one before its last revision, which is what P5
    restores.
  - **D7. Motion checks run on the two Included Avatars only.** The
    person's own Avatar is for the preview. This answers C2's last question.
    The checks' thresholds are calibrated on those two rigs, and an unusual
    rig would add findings the assistant cannot fix by changing the clip.
    The owner may choose otherwise.
  - **D8. Review frames are temporary.** One sheet per Included Avatar, rows
    at the clip's beats (at most six), four views a row. They are held in
    memory for the review request and never stored as user files, so they do
    not appear in the Library.
  - **D9. The assistant's model is a preference key, not a model role.**
    `generation.model_provider_id` in the owner's preferences, sent with each
    run and checked there. A fifth role would enter the shared roles
    contract, which the hosted composition also serves. With no usable
    choice the assistant shows setup; it never falls back to another model.
  - **D10. A run stops when the page closes its request, as chat does.** No
    stop route. One run at a time per conversation, guarded in the server
    process. A run does not continue after the app closes, and nothing
    restarts one, so every plan request is the person's own.
  - **D11. Shared authoring guidance lives in the backend package**
    (`resources/authoring/`), and the skill reads it from there. The skill
    keeps its command-line procedure. The joint table the skill prints with
    `animation joints` becomes a generated file with a drift check. Skills
    are optional tools, so product source cannot depend on a skill folder.
  - **D12. Names.** Capability `content_generation`; routes under
    `/v1/generation`; the page at `/generate`; interface text in a `generate`
    catalog.
  - **D13. A deterministic author under `ANIMAMA_LLM_SKIP`.** It returns a
    packaged example clip and makes a fixed change on a revision, so journeys
    run without a provider.
  - **D14. Four pull requests from this plan**, each with its own
    integration review and full pre-push run: Phases 0 to 3, Phases 4 and 5,
    Phases 6 and 7, then Phases 8 and 9. Each is usable alone. The first
    three use `Refs #942` and the last closes it. The default is one pull
    request for the whole plan; four keep reviews readable and limit
    contract-version collisions with other work.
  - **D15. Acceptance requests and model.** Three requests: "a shy little
    wave with a small smile"; "thinking with a hand on the chin, held while
    the Anima thinks"; "a hearty laugh". They cover a one-shot arm action, a
    held loop with a solved head contact, and whole-body pulses. The model is
    `gpt-6-luna` on the ChatGPT plan connection at its default reasoning
    level, or another listed model the owner names.
  - **D16. Between runs the model sees text turns and the selected draft.**
    Earlier clip versions and tool exchanges are not replayed. This lets the
    person change model in the middle of a conversation.
  - **D17. Failed checks are repaired; warnings are shown.** A repair pass
    runs only for validation problems and FAIL findings, as the skill fixes
    every FAIL. WARN findings are given to the model in that pass and listed
    on the draft.

- 2026-11-26, agent, from the page trial (Phase 0 step 3). Each applies a
  rule the approved plan already set, and none changes agreed behavior.
  - **Checks run in a Web Worker**, which keeps the page responsive (the
    spec's responsiveness constraint).
  - **Frames use a render target on the preview's renderer**, encoded to sRGB
    after reading, and go to the backend as JPEG. This keeps one WebGL
    context, as the preview's one-canvas rule intends.
  - **D7 stands.** Nothing measured argues for checking the person's own
    Avatar: cost is not the obstacle, and the reasons in D7 are unchanged.
- 2026-11-26, agent, from the authoring trial (Phase 0 step 3). Each refines
  an approved decision inside its intent.
  - **D4's tool set, as tried.** `submit_draft` (the whole clip with its
    name, AI description and Selector ID, so a write is one request),
    `edit_draft` (set and remove by JSON Pointer), `accept_draft` in the
    review pass, `read_example`, and `ask_questions`. A valid submission or
    edit ends its pass.
  - **D8's sheet stays** six rows of four 220 × 330 tiles for each Included
    Avatar.
  - **No reasoning effort is named.** The run uses the model's default.
  - **Phase 1 starts on the page trial's answers.** The authoring trial's
    results bear on Phase 2 and on the faces guidance only.
- 2026-11-26, agent, to meet R3.7. Implementation choices; the guidance text
  itself is reviewed at G7.
  - **D18. One faces guidance for both kinds.** A shared file describes the
    name families (VRM presets, VRoid parts, MMD morphs, ARKit shapes and an
    author's own blendshapes), how the runtime plays each across Avatars,
    faces by brow, eye and mouth, and blinks and mouth shapes under lip-sync.
    Its rule for choosing: build the mood from presets and VRoid parts, which
    the runtime plays through the Avatar's own VRoid, MMD or ARKit shapes,
    then add the Avatar's other named shapes for what those cannot express.
    The Gesture and Reaction guidance both include it; Reactions add their
    own rules (emotion and intensity, a mostly closed mouth). The alternative,
    keying an Avatar's own names for the whole face, would leave the item
    blank on every other Avatar.
  - **D19. The page sends the chosen Avatar's expression names with each
    run**, grouped by family, names only, capped at 400 names of at most 64
    characters. The backend puts them in the request as data (T10).
  - **D20. A draft warns about names that will not show.** The page compares
    a draft's keyed names with the chosen Avatar and lists the missing ones
    as warnings, which the repair pass also receives. A name the Avatar has
    but most Avatars lack is noted as playing on such Avatars only. The frame
    review is told which keyed names the Included Avatars cannot show.

## Phased implementation

Each phase starts from the previous phase's commit and writes its tests
first. Phase 1 needs Phase 0's answers. Phase 2 needs Phases 0 and 1. Phase 3
needs Phase 2. Phases 4 to 8 each need Phase 3, and run in the order given.
A finding that would change agreed behavior goes to the owner before the
phase it affects.

Module and route names are proposals; the implementing agent may adjust them
within the repository's layering. Each phase updates the documentation its
change makes incomplete, adds `licenses/source-review.json` entries for its
new files and runs `python3 scripts/public-release/check_source.py`. No phase
runs the full pre-push suite (Decision Log, 2026-11-03).

### Workspace setup

After G0, in worktree `in-app-generation`:

1. Merge `origin/main` if it moved. Prepare dependencies as the
   [workspace guide](../../backend/operations/development.md#preparing-a-task-workspace)
   describes; run `git lfs pull` before backend content tests.
2. Record G0 in this plan, link the plan at its reviewed revision in #942's
   ExecPlan section, and move the issue to `triage:ready-for-agent`.
3. Commit this plan, then push the branch.

### Phase 0: Feasibility trial

Review tier: standard. It adds developer tooling that sends model requests,
and no product code.

Requirements: check C2; evidence for C5; settles D4, D7 and D8.

Gate: G1 before any plan request.

Steps:

1. Page trial, no provider. Add a browser test beside the existing
   `src/frontend/web/scripts/*.browser.test.mjs` files that imports
   `checkMotion` and `loadHeadlessVrm` into a page and measures, for four
   Included clips of different sizes on both Included Avatars: the time to
   load each VRM, the time to check on the main thread and in a worker, and
   the longest main-thread block. It then renders one contact sheet two ways,
   through a second renderer and through a render target on an existing
   renderer, and records the time, pixel size and bytes of each. Run it on
   the machine's GPU and on the software renderer.
2. Authoring trial, live model. Add `scripts/generation_probe.py`, which runs
   in a signed-in task stack's server container and builds its model client
   from the app's own composition, so it holds no token code. It sends
   authoring requests built
   from the skill's guidance and the D4 tools for the three D15 requests,
   then a repair request with real check findings, once as a whole rewrite
   and once through `edit_clip`, and one frame-review request on a clip with
   a seeded visible fault. One request carries the expression names of an
   Avatar with ARKit and standard MMD shapes, taken with `vrm:inspect`, to
   see how the model uses them (D18, D19). It prints token use, time, and
   whether each clip validates. Check the clips with
   `pnpm -s animation check`.
3. Record the findings under Surprises & Discoveries, without account
   details. Decide: worker or main thread for checks; which frame renderer;
   the sheet layout the model can read; whether `edit_clip` stays; the
   context a model needs (for Phase 4's eligibility rule).

Checks: the browser test; `uv run ruff check scripts/generation_probe.py`;
the source check.

Completion: C2 is answered with numbers, and D4, D7 and D8 are confirmed or
revised. If the evidence argues against D7, the owner decides before Phase 1.

Bound: at most 15 plan requests (G1).

Recovery: the probe writes clips to a scratch directory and no database row.
It is a second process over the stack's session file: if it renews the token,
the running server's copy goes stale, so restart the server after a probe
session or sign in again.

As built (2026-11-26, from `c2f9fa3b5`):

- Page trial: `src/frontend/web/scripts/generation-trial.mjs`
  (`pnpm -s generation:trial`), its page and worker under
  `scripts/generation-trial/`, and `generation-trial.browser.test.mjs`. The
  test asserts that the command line, a page and a worker report the same
  findings for a clean clip and for one with a seeded fault, and that
  render-target sheets match a second renderer's once encoded to sRGB.
- Probe: `scripts/generation_probe.py` with `tests/test_generation_probe.py`.
  It composes the delivered session and plan client and holds no token code.
  A pass offers a tool set narrower than D4 named: `submit_draft` carries the
  whole clip with its name, AI description and Selector ID, so a write is one
  request; `edit_draft` takes `set` and `remove` operations by JSON Pointer;
  `accept_draft` exists only in the review pass; `read_example` returns one
  of three Included Gestures. `ask_questions` was not tried: it needs no
  model capability the others lack. Phase 2 builds on this set.
- The request bound counts HTTP requests to the plan's route, at most 15
  across invocations in one shared count file.
- The probe and its tests stay as developer tooling, for trying the guidance
  on another model. Phase 1 turns the page trial's test into the lasting
  parity test.

Check record, from the worktree root unless noted, on working tree
`a5c2706e55deb183b0472b3fa770e0c48b7f4426`:

| Check | Result |
| --- | --- |
| `uv run --no-sync pytest -q tests/test_generation_probe.py -p no:cacheprovider` | 64 passed |
| `uv run --no-sync ruff check` and `ruff format --check` on the probe and its tests | Clean |
| `uv run --no-sync mypy scripts/generation_probe.py tests/test_generation_probe.py` | No issues in 2 files |
| `python3 scripts/public-release/check_source.py` | Every tracked file covered once |
| `node --test --test-concurrency=1 scripts/generation-trial.browser.test.mjs` (from `src/frontend/web`) | 3 passed |
| `pnpm exec eslint` on the trial scripts and `pnpm exec tsc -p tsconfig.scripts.json --noEmit` (from `src/frontend/web`) | Clean |
| `pnpm -s generation:trial --gl swiftshader` and `--gl gpu` | Exit 0; results under "Page trial" |
| The probe's `list` inside the task stack's server container | Exit 0 |

Not run: the full pre-push suite and the wider backend and frontend suites.

Live trial (G1): the account holder signed in on the task stack on
2026-11-26. The probe's passes are under "Authoring trial". The first nine
were sent before repair round 1, when a call's retries were not counted; all
nine succeeded on their first answer, so no retry is expected to have gone
out.

#### Code Review #1 Findings

Independent review, standard tier, of working tree
`62eb3ee84dcaad0807a8ddd4af0fc59841fd5faa` against baseline `c2f9fa3b5`. The
reviewer reused the recorded checks and reran the trial's browser test (2
passed). Result: blocked by F1.

| ID | Kind | Finding |
| --- | --- | --- |
| P0-R1-F1 | Required | The request bound counted calls to the model client, but one call could send up to four requests: the client resends once after a refused token and twice on a temporary failure. Measured with a mock transport. |
| P0-R1-F2 | Optional | With Git present the out-directory guard accepted an untracked, un-ignored folder inside the repository, which `git add -A` would stage. |
| P0-R1-F3 | Optional | The trial named sheet files after a clip's `id` unsanitised, so an `id` with path separators wrote outside `--out`. |
| P0-R1-F4 | Optional | Odd tool arguments (a list as `op`, a 4,300-digit index) raised uncaught errors after the request was counted, losing the pass's record. |
| P0-R1-F5 | Optional | Fifteen was a default, not a ceiling: `--max-requests` took any value and another `--out` started a new count. |
| P0-R1-F6 | Optional | The docstring said tool arguments reach only `--out`, but printed problems can quote short names the model wrote. |
| P0-R1-F7 | Optional | The plan did not record that the probe's tool set differs from D4, that a token renewal rewrites the session file, or what happens to the tooling afterwards. |

#### Code Review #1 Revisions

Every finding was verified and accepted. Each code fix has a test that fails
without it.

| ID | Fix |
| --- | --- |
| P0-R1-F1 | Every request carries call limits, so the client does not retry, and a session wrapper counts a resend after a refused token before it is sent and stops it when the count is used up. Four tests drive the real plan client over a mock transport. |
| P0-R1-F2 | The guard no longer asks Git: inside the repository only a folder under `.animama-drafts/` is accepted. |
| P0-R1-F3 | Sheet files are named through `sheetFileStem`, which keeps plain characters only. |
| P0-R1-F4 | `op` and `path` must be strings, a long index is a pointer error, and any unexpected failure in a tool becomes a refused call with fixed text. |
| P0-R1-F5 | `--max-requests` is 0 to 15 and the count file is shared by every out directory. |
| P0-R1-F6 | Docstring corrected. |
| P0-R1-F7 | Recorded above ("As built") and under Recovery. |

Also added in this round: an optional `--effort` on the model passes, and a
refused request's sanitised reason saved with the pass's details.

#### Code Review #2 Findings

Targeted recheck of working tree `a5c2706e55deb183b0472b3fa770e0c48b7f4426`.
The reviewer reused the recorded checks and measured the request bound
through the real plan client over a mock transport: requests sent never
exceeded requests counted in 15 named cases and 400 random passes. Result:
pass. F1 to F6 are resolved; F7 is a record edit outside the reviewer's
scope.

| ID | Kind | Finding |
| --- | --- | --- |
| P0-R2-F1 | Optional | Without the Git query, the out-directory rule knows only its own checkout, so a tracked folder in another checkout is accepted. |

#### Code Review #2 Revisions

P0-R2-F1 is not acted on. It needs an unusual path on the host, and inside
the server container, where the probe is meant to run, `/app` is the only
checkout. The repair budget for this phase has one round left unused.

Phase commit: this commit (`test(generate)[p0]`).

### Phase 1: Checks, validation, frames and guidance in app source

Review tier: standard. It changes shared authoring code under
`lib/avatar/**` without changing behavior.

Requirements: R3.7, R4.1, R4.2 and R4.4 (the page's part); the constraints
"One source of truth" and "Responsiveness".

Steps, tests first:

1. Move `compactClipFile` and the anatomical-limit check out of `cli.ts` into
   a browser-safe `motion-authoring/validateClip.ts` that returns its issues
   as a list of path and message. `cli.ts` calls it, and `animation validate`
   prints what it printed before.
2. Add `motion-authoring/draftChecks.ts`: it loads the two Included Avatars
   once per session with `loadHeadlessVrm`, runs `checkMotion`, and returns a
   plain report (validation issues, findings with category, severity, Avatar,
   time range and message). It runs where Phase 0 decided.
3. Move the sheet renderer from `scripts/animation-render/render.ts` into
   `motion-authoring/reviewSheet.ts`. The script page imports it, and
   `animation:render` writes the same sheets. The app entry point renders one
   sheet per Included Avatar and accepts no other Avatar (T4).
4. Guidance (D11). Move what any author needs from the skill's references
   into `src/backend/animama/resources/authoring/gesture/`: the clip format,
   motion principles, human movement, hands and face, the check categories
   with their fixes, and the interview topics. The skill's files keep their
   commands and link to the moved text. Generate the joint table from the
   frontend's anatomy definitions into a tracked file, copy it into the
   package through `src/backend/packaging/shared_catalogs.py`, and extend
   that script's drift check. Confirm the wheel and the frozen desktop
   runtime contain the new files.
5. Faces (R3.7). Write the shared faces guidance (D18) from the runtime
   guides and the Included Gestures and Reactions, and have the Gesture
   guidance include it in place of the skill's presets-only section. Add
   `motion-authoring/expressionInventory.ts`: it groups an Avatar's available
   expressions by family with the runtime's own tables (`arkit.ts`,
   `mmdFaceExpressions.ts`, `vroidMoodParts.ts`), applies D19's caps, and
   lists a clip's keyed names that an Avatar lacks (D20).
6. Parity. A test runs the same clips, one with a seeded fault, through the
   command-line path and the page path and compares the findings.

Checks: the touched Vitest files; `pnpm check`; `pnpm web:lint`;
`pnpm web:test:browser` for the renderer; `pnpm -s animation validate`,
`check` and `animation:render` on an Included clip, compared with their
output before the move; `uv run --no-sync python
src/backend/packaging/shared_catalogs.py`; `uv run pytest -q
tests/test_pose_clip_v2.py`; the source check.

Completion: the app can validate, check and render a clip with the code the
skill uses, and the parity test passes.

Gates: the owner reads the faces guidance before it ships (G7). A real skill
run follows the guidance move; G4's comparison runs the skill on the D15
requests, which serves as that run.

Recovery: the phase moves code and text. Reverting its commit restores the
script-only versions.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 2: The assistant's backend

Review tier: high risk (schema, the API contract, a new capability, and the
privacy boundary in T4, T5 and T10).

Requirements: R1.5, R2.1, R2.2, R2.4, R3.1 to R3.4, R3.7, R4.1, R4.3, R4.4,
R6.1, R6.2, R6.4 and R6.5 (the backend's part); the constraints on local
compositions, untrusted output, privacy, cost bounds, schema and API, and
language. Threats T1 to T8 and T10.

Steps, tests first in `tests/test_generation_*.py`:

1. Capability. Add `content_generation` to the capability contract (true in
   the local composition, false in `contracts/runtime-capabilities/
   hosted.json`), a row in `contracts/hosted-web.md`, the name in the
   inventory test's permission list, and the hosted page's refusal with its
   test.
2. Schema. Add revision `0003_content_generation.py` with the ORM models
   (D6). A conversation has an owner, a title, a scope (the page, or a
   creator item), a style preset and timestamps. A message has a role, text
   and a `data` object (questions, answers, token use). A draft has its
   conversation, intent, position, status, version, project, previous
   project, check report, repair count, failure reason and saved item id.
   Check the revision's CHECK constraints by hand against the ORM.
3. Layers. Domain types, a repository port and its SQLAlchemy adapter, and an
   application package `app/generation/` holding the service (conversations,
   drafts, restore, discard), the prompt builder (the packaged guidance with
   the shared faces guidance for both intents, the joint table, the chosen
   Avatar's expression names from the run request under D19's caps, and the
   reply-language rule), the tools and the run pipeline.
4. Tool rounds. Move the provider-neutral helpers that build a tool exchange
   and advance the continuation out of `app/chat/direct_turn/model_stream.py`
   into a shared module under `app/model_clients/`, with the chat turn using
   them from there. Existing chat tests cover the move.
5. Tools (D4). Each takes typed arguments and returns text. `write_clip` and
   `edit_clip` parse the result as JSON, cap it at 2 MiB, require
   `animaPoseClip/2.0` and run `validate_clip_v2_timeline`; a refusal lists
   each problem by path. `set_details` checks the Selector ID's pattern and
   that no existing Gesture uses it. `ask_questions` takes up to four
   questions with options, ends the pass and may be called once for a
   request (P4). `read_example` returns a named portable Included
   Gesture. At most eight tool rounds a pass.
6. Pipeline (D2, D17). Write pass, then wait for the page's check report for
   that version (at most 120 s; without one the draft ends with a "checks did
   not run" warning). Repair passes while FAIL findings remain, at most
   three. Frame review once when the model accepts images and the page sent
   sheets. Statuses: writing, checking, repairing, reviewing, ready, warnings
   and failed. A stopped run keeps finished drafts and the last version of an
   unfinished draft that validated.
7. Routes, in a router only the local composition mounts, each
   `_excluded("content_generation", …)` in the inventory:

   ```text
   GET    /v1/generation/conversations
   POST   /v1/generation/conversations
   GET    /v1/generation/conversations/{conversation_id}
   DELETE /v1/generation/conversations/{conversation_id}
   POST   /v1/generation/conversations/{conversation_id}/runs:sse
   PUT    /v1/generation/drafts/{draft_id}/check-report
   PUT    /v1/generation/drafts/{draft_id}/review-frames
   POST   /v1/generation/drafts/{draft_id}:restore
   POST   /v1/generation/drafts/{draft_id}:mark-saved
   DELETE /v1/generation/drafts/{draft_id}
   ```

   The run stream sends `run.started`, `message.delta`, `progress` (thinking,
   writing, checking, repairing, reviewing frames), `questions`,
   `draft.updated`, `run.failed` and `run.completed` with token use. Logs
   carry ids, counts and sizes, never message or clip text.
8. Model choice and failures. A run names its model (D9). The row must be a
   chat model with `supports_tools`, usable on its connection. A model error
   ends the run with the code, category and connection details chat sends, so
   the plan's limit, sign-in and eligibility states read the same (R2.4). The
   conversation and drafts stay.
9. One run per conversation (D10): a second gets 409
   `generation_run_in_progress`.
10. The deterministic author (D13), registered when `ANIMAMA_LLM_SKIP` is set.
11. Contract. Regenerate the client with `pnpm openapi-ts`; `local-http`
    becomes `26.0.0` and `runtime-contracts` `0.26.0`, with the version
    sentence in `contracts/hosted-web.md`. If another change takes those
    numbers first, this one takes the next.

Tests: the request built for each pass on a plan row and on a key row (tools
in the plan's namespace, no stored cursor, images only in the frame review's
user message); the Avatar's expression names reach the request within their
caps, and a Gesture and a Reaction request carry the same faces guidance
(R3.7, T10); a seeded motion fault is repaired, or the draft ends with a
warning after three passes; an unloadable output never becomes a draft
version; each limit in T7; stop keeps finished drafts; restore and discard;
the chat list, chat search and Reflection input do not contain a conversation
(T5); the inventory, capability and hosted tests (T8); an upgrade of a
database at the previous head.

Checks: the new test files; `tests/test_product_http_inventory.py`,
`tests/test_runtime_capabilities.py`, `tests/test_alembic_fresh_install.py`
and `tests/test_accountless_repository_boundaries.py`; the chat turn tests
the helper move touches; `uv run ruff check`; `uv run --no-sync python
scripts/repository-boundary/check-python-imports.py`; from `src/frontend`
`pnpm openapi-ts:check`, the hosted-composition test and the package-set
`compare`. Not run: the full pre-push suite.

Completion: with the mock author, a scripted client drives a conversation
from a message to a `ready` draft through the routes, and every test above
passes.

Recovery: the revision only adds tables. Reverting the phase leaves them
unused; a later revision may drop them. No existing row changes.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 3: The Generate page

Review tier: standard. Interface work on the contract Phase 2 fixed.

Requirements: R1.1, R1.3, R1.4, R2.1 (plan models), R3.2 to R3.7, R4 (the
page's part), R5.1, R6.1 to R6.4 and the plan notice in R6.3; the constraints
on responsiveness, language and accessibility, and records.

Steps, tests first:

1. Route and entry points. A `/generate` file route, gated by the capability
   in `RuntimeFeatureGate.tsx` and `route-admission.ts`; an entry in
   `ACTION_CREATORS` and in `PRIMARY_CREATE_LINKS`, with
   `CreatorEntryPoints.test.ts` updated (R1.3).
2. The page, from existing parts: the conversation with `ChatConversation`
   and the `ChatInput` primitives; the preview with
   `PoseCreatorPreviewProvider` and the creator's scene and transport, under
   its own `ContentPreviewExclusiveCanvasGate` claim; a draft list; a menu of
   earlier conversations. The Avatar picker passes `includedAvatars` and adds
   the person's own Avatars; it defaults to the last active Anima's Avatar
   (R5.1).
3. Query hooks and the run stream, in `web` (the feature is local-only): a
   fetch with an `AbortController`, as chat's stream does. Stop aborts it.
4. The page's worker. It sends the chosen Avatar's expression names with
   each run (D19). On a new draft version it validates, loads the clip
   into the preview only when valid, runs the checks, adds the keyed names
   the chosen Avatar lacks (D20) and sends the report.
   When a review is due it renders the sheets and uploads them. It also picks
   up a draft whose checks never ran, so a reload resumes them.
5. Setup (R1.4). With no usable model the page shows setup: Continue with
   ChatGPT through the delivered sign-in, where the plan connection offers
   it; a model list; and the note that a Claude API key works through Model
   connections. The model control lists eligible models and ends with
   `ChatGPTPlanUsageNote` while a plan model is chosen (R6.3). This phase
   offers plan models; Phase 4 widens the list.
6. Drafts. Status and plain-word warnings from the report's categories;
   restore the previous version; discard; Save through the creator's save
   code, moved from `ActionEditorPage` into a hook both call, then
   `:mark-saved`; a saved draft links to its item in the creator. Open in
   creator loads the draft's project through the creator's import path as an
   unsaved document, by a `draft` search parameter on the new-item route.
7. Questions as option cards with Skip (R3.2). Progress in words (R6.1).
   Failures worded from their codes, reusing chat's wording for model and
   plan codes and a new `generation` area in `userVisibleCodes.json`.
8. Text in a `generate` catalog in five locales, with "assistant" and "draft"
   added to `src/frontend/i18n/terms.json` first.
9. Records and documentation: ADR 0041 for the assistant (D1 to D3 and D10),
   glossary entries for the assistant and a draft, a feature page under
   `docs/frontend/features/`, and the route, capability and table additions
   in the backend architecture pages.
10. Journey `accountless-generate-gesture.spec.ts`: a request, the draft
    playing on the chosen Avatar and on each Included Avatar, a revision by
    chat, Save, and the item open in the Gesture creator with editable beats
    after a reload; then stop, restart and discard.

Checks: the touched Vitest files; `pnpm check`; `pnpm web:lint`;
`pnpm i18n:check`; the new journey alone against a disposable built stack,
through the heavy slot. Not run: the full pre-push suite and the other
journeys.

Manual check (G1): one real request on a plan model on the task stack,
revised once and saved, at most ten runs.

Completion: the spec's first usable phase. The first pull request follows
(D14).

Recovery: the page adds no stored state beyond Phase 2's. Local content it
saved is ordinary content and stays.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 4: Other Model connections, usage and cost

Review tier: standard.

Requirements: R2.1 to R2.4, R6.3; check C5.

Steps:

1. Eligibility. The model list offers every usable chat model with
   `supports_tools` and enough context for the guidance and a clip (the
   figure comes from Phase 0), on any connection. A model that cannot be
   chosen is listed with the reason (R2.2).
2. Images. With a model whose `accepts` lacks `image`, the pipeline skips
   frame review and the page says why; validation and checks still run
   (R2.3).
3. Usage. Store token use per run and per conversation and show both. Show
   an estimate from `estimate_model_token_cost` beside them when the row has
   a price. A plan model shows the plan notice instead (R6.3).
4. Failures on key-based connections: the same wording chat uses, with retry
   and "choose another model" (R2.4).
5. C5. From Phase 0 and this phase's manual check, record which models
   produced loadable drafts and how many repairs they needed. Add a short
   note in setup and beside the model control on what to expect from smaller
   models. The owner decides whether any model is hidden.
6. Update the model settings page in `docs/frontend/features/`.

Tests: the request built for each provider family (Responses, Chat
Completions, Anthropic) with the existing fakes; a model without tools cannot
start a run; a text-only model skips frame review; token totals and the
estimate.

Manual check (G2): one request on one key-based model, within the spend the
owner approves.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 5: The creator control, revising and Reactions

Review tier: standard. It changes the Gesture and Reaction creator.

Requirements: R1.2, R5.2, R7.1, R7.2; the accessibility constraint.

Steps:

1. A Generate control at the bottom right of `ActionEditorWorkspace`, above
   the timeline. It opens the Phase 3 conversation in a panel that floats
   over the other panels and takes no part in their sizing. It is reachable
   and dismissible by keyboard and does not trap focus.
2. Scope. The conversation belongs to the open item. Each run starts from
   the creator's current document, so hand edits are included. The
   assistant's result is applied as one undoable change, grouped with its
   repairs, and plays in the creator's own preview (R5.2). The creator's Save
   keeps the item's identity; an Included item becomes a new Local item as
   today (R7.1).
3. Reactions on both surfaces (R7.2). A Reaction draft carries its emotion
   and intensity suggestion and is refused body tracks on the server, as the
   creator strips them. Write the Reaction guidance (new text; see
   Surprises) from the runtime guide and the Included Reactions: Phase 1's
   shared faces guidance plus the rules only Reactions have (R3.7, D18).
   Frame review for a Reaction sends face views.
4. Journey additions: revise a Local Gesture from the creator and save it
   with its identity; the same for a Reaction.
5. Describe the control in the creator guide
   (`docs/frontend/runtime/avatar-animation.md`).

Gate: the owner reads the Reaction guidance before it ships (G7).

Manual check (G1): one revision in each creator, at most ten runs. The second
pull request follows.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 6: Batches and effects on the timeline

Review tier: high risk. A batch runs several model streams in one request.

Requirements: R5.3, R7.3, R7.4.

Steps:

1. Batches. A planning tool lets the write pass name up to ten items, each
   with a brief. Each item then gets its own write, repair and review passes
   and its own draft and status, two at a time. A failed item does not stop
   the others. Stop ends all of them and keeps finished drafts. The page
   saves the selected drafts or all, one after another, and reports each
   failure by item (R7.4).
2. Effects. Tools to list and read portable Avatar, Particle and Scene
   Effects from the Library. The model adds timeline events with per-use
   overrides, and the draft's project gains the dependencies. Overrides are
   checked with the validator Save uses
   (`content_save_service.py` L593-636). The preview shows them through the
   creator's sandbox entries (R5.3), and Save records the dependencies
   (R7.3). The shared guidance gains the skill's rules for effects in a
   Gesture.
3. Journey additions: a batch with one failing item saves the others; a
   draft with an effect saves with its dependency.

Manual check (G1): one batch of three, at most ten runs.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 7: References and presets

Review tier: high risk (file deletion and licensing).

Requirements: R8.1 to R8.6; check C3.

Steps:

1. Library Gestures as references (R8.1), with the existing Library picker.
   A chosen Gesture is a starting point (its clip becomes the draft's first
   version) or an example of the feel. Non-portable items are absent from the
   picker and refused by the service (T4).
2. Reference images (R8.2) through chat image input's upload and stored copy,
   with its limits. A table links a conversation to its image files.
   Discarding a conversation deletes the images only it uses, and deleting a
   chat spares an image a conversation still uses. Both rules are repository
   queries; the shared port keeps its signature.
3. C3, then R8.3. Sample frames from a short video in the page and send them
   as one strip through the same path. A bounded live trial (G1) shows
   whether a model reads the motion. The owner then keeps R8.3 or defers it
   by a recorded decision (G5).
4. Prompt starters (R8.4) and named style presets (R8.5): localised lists in
   the page. A preset is stored on the conversation and added to the
   instructions.
5. Inspirations (R8.6): images and short loops rendered from Included
   content, the person's own image files, and curated outside images. Every
   shipped item has a licence entry that permits redistribution, checked by a
   test. Where shipped inspirations live, and which inventory holds their
   entries, is decided here with the owner (G7).

Tests: the deletion rules in both directions; a non-portable reference is
refused; an image reaches the request only for a model that accepts images;
a starter fills the field; a preset stays selected; the inspirations licence
check.

The third pull request follows.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 8: The connector

Review tier: high risk (request admission, and a boundary to an outside
process).

Requirements: R9.1 to R9.3; check C4. Threats T3 and T9.

This phase is planned in outline. Its design is fixed only after a spike and
the owner's review (G6), because it changes ADR 0002's admission.

1. Spike (C4), against the clients' current documentation and a real
   install: how Claude Desktop and Claude Code reach a local connector today;
   whether a tool's image result is shown to the model; how an outside
   client reaches the backend in the desktop app and in a self-hosted stack.
2. Candidate design, to confirm or replace: a connector that offers the
   authoring tools (create and revise a draft, read it, run checks, get
   frames, read an example) over the Model Context Protocol. It is admitted
   only on its own path with a token created by pairing from the Generate
   page and stored hashed, and it is revocable. The open Generate page runs
   the checks and frames for its drafts and lists them by polling. The
   connector never starts a model request.
3. After G6: the admission rule with its negative tests, the pairing
   interface, the tools on Phase 2's service, the instructions shown to the
   person, and an ADR or an amendment to ADR 0002.

Records: no checks run, commits or reviews yet. Code Review #1 Findings and
Revisions go here.

### Phase 9: Acceptance and closing records

Review tier: light. Its review is the last integration review's.

1. G4: the owner runs the D15 requests in the app and the skill on the same
   requests, and judges the saved Gestures.
2. G8: the packaged desktop check.
3. Bring the feature, model settings and creator documentation, the ADR and
   the glossary up to the delivered behavior. Mark the spec Delivered in #942
   and refresh the snapshot.

## Integration reviews

One per pull request (D14): combined acceptance for its phases, any light
phase folded in, and still-valid phase evidence. Then, with the owner's
agreement (G3), the full pre-push suite once on that candidate; its results
go in the pull request. Each pull request states which evidence is local and
which checks did not run. None yet.

### Gates

- **G0.** Owner review of this plan, including D1 to D17. Passed on
  2026-11-26.
- **G1.** A live ChatGPT plan account for Phase 0 and the manual checks. The
  account holder signs in themself in their own browser. Usage is bounded: at
  most 15 requests in Phase 0 and 10 runs in each later manual check.
- **G2.** Spend on a key-based provider for Phase 4's manual check, within an
  amount the owner approves first.
- **G3.** Owner agreement to each full pre-push run.
- **G4.** Owner acceptance: the D15 comparison with the skill's output, a
  visual check of the Generate page and the creator control, and a Gesture
  and a Reaction made for an Avatar with ARKit or MMD shapes (R3.7).
- **G5.** The owner's decision on video references after C3.
- **G6.** Owner review of the connector's design after C4, before any
  connector code.
- **G7.** Owner approval of new shipped material: the faces guidance, the
  Reaction guidance, and each curated inspiration with its licence entry.
- **G8.** A packaged desktop build with a fresh profile: the Generate page
  opens, a run completes and a draft saves. The agent drives the app only
  after the owner's go-ahead.

Outside this repository: at its next repin, Animama Cloud admits each new
`local-http` major and keeps `content_generation` false. No Cloud work is
part of this plan.

## Validation and acceptance

Each spec acceptance criterion and the evidence planned for it:

| Criterion | Evidence |
| --- | --- |
| Two or three requests on a named plan model, judged against the skill | G4, with D15's requests and model |
| Journey: request, playback on the chosen and Included Avatars, revision, Save, editable after reload | Phase 3 journey |
| A plan run on desktop and a self-hosted stack with the plan notice; a key run with token use | Phase 3 manual check, G8; Phase 4 tests and manual check |
| Setup with no model; no model without tool calling; text-only models explained | Phase 3 and 4 tests |
| A seeded fault is repaired or warned; unloadable output reaches neither preview nor Save; app and skill agree | Phase 1 parity test; Phase 2 pipeline tests; Phase 3 page tests |
| Stop keeps finished drafts; restart restores; discard removes | Phase 2 tests; Phase 3 journey |
| A cost estimate when the price is known | Phase 4 tests |
| Hosted exposes neither routes nor interface | Phase 2 inventory, capability and hosted-composition tests |
| A revised Local Gesture and Reaction keep their identity; effects save with dependencies; a batch survives one failure | Phase 5 and 6 journeys |
| Non-portable references refused; images and video reach an image model; starters and presets; inspirations licence check | Phase 7 tests |
| Conversations appear in no chat list, memory file or chat search | Phase 2 tests (T5) |
| The assistant is given the chosen Avatar's names; Gestures and Reactions share the faces guidance; an Avatar with ARKit or MMD shapes gets names it has | Phase 1 and 2 tests; G4 |
| A paired client creates a draft; unpaired and revoked clients are refused; authoring tools only | Phase 8 tests (T9) |
| Suites and documentation | Each pull request's full suite (G3); Phases 3 to 9 |

## Idempotence and recovery

- The schema change adds three tables in one revision. An existing profile
  upgrades in place, and nothing reads the tables but this feature.
- Conversations and drafts are the person's working data. Discarding one
  removes its rows; saved Local items do not depend on them.
- A run can be stopped or lost at any point. Stored drafts are whole
  versions, and the page re-runs checks that never reported.
- Guidance and the joint table are packaged files with a drift check; running
  the generator again is safe.
- Each phase is a commit on the task branch and reverts alone in reverse
  order. Reverting Phase 2 after use leaves the tables in place, unused.
- The task stack holds only test data and can be removed with its volumes.

## Outcomes & Retrospective

Nothing delivered yet.
