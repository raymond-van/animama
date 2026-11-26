# Generate content in the app: Gestures and Reactions first

Status: Agreed
Owner decision: accepted as written by the owner on 2026-11-24, including the
choices this draft proposed (P1 and P3 to P12; P2 was withdrawn). Revised on
2026-11-26 only where work delivered since then changed a fact: the ChatGPT
plan connection (#919) and chat image input (#904). No agreed decision changed.
On 2026-11-26 the owner added R3.7 (decision 12).
Authority: [#942](https://github.com/raymond-van/animama/issues/942). This file
is a snapshot of that issue captured 2026-11-26T19:02:50Z; change the issue,
not this file.

## Problem and intended users

AI-authored content is made today by repository agent skills
(`animama-animation`, `animama-effect-assets`, `animama-avatar-vfx`,
`animama-particle-vfx` and `animama-scene-vfx`). They need a source checkout, an
agent CLI and development tooling: the motion checks run from `pnpm` scripts,
review renders use Playwright, and saving drives the creator in a headless
browser. The preview used while authoring is a development page outside the app.

Inside the app the creators are manual. The Gesture creator edits beats and
poses by hand, and nothing starts from a description, so a person who cannot
animate has no way to make a Gesture. No model call in the app writes content.

Intended users are people who run Animama locally, in the desktop app or a
self-hosted stack, and want new Gestures and Reactions for their Animas without
animation skill or developer tooling. The maintainer also gains an authoring
loop beside the live Avatar.

## Goals, scope and non-goals

Goals:

- Ask for a Gesture or Reaction in words, watch drafts play on an Avatar,
  revise them by chat and save them as Local content.
- Reach a model through the ChatGPT plan connection or any other Model
  connection. The plan connection and its sign-in are delivered separately
  (#919, `docs/plans/chatgpt-plan/`).
- Approach the quality of the `animama-animation` skill without making the
  person wait on, or be blocked by, its checks.
- Ask for several items at once, give references, and start from presets.
- Let a person with a Claude subscription author from their own Claude client.

This spec covers Gestures and Reactions. Later slices need their own spec or an
agreed revision of this one:

- Effect art. Agreed direction: an image model reached with the person's own API
  key. The chat models here do not produce raster images.
- Generating Avatar, Particle and Scene Effects.

Non-goals:

- The hosted composition.
- Signing in to Claude inside Animama, or sending the assistant's requests
  through a Claude plan. Anthropic's terms do not permit either for a
  third-party app.
- A terminal in the app, and starting Claude Code, Codex or another agent CLI
  from the app.
- An Anima generating content during an ordinary chat.
- Creating or editing effects, and adding sounds to a timeline.
- Equipping generated content on an Anima. That stays a separate step.
- Promoting content to Included content.

## Required behavior

"The assistant" is the AI that authors content here. It is not an Anima.

### R1: Where the assistant lives

- **R1.1** A Generate page shows a conversation with the assistant, an Avatar
  preview and a list of the conversation's drafts. It is for new items and
  batches.
- **R1.2** The Gesture and Reaction creators show a Generate control at the
  bottom right. It opens the same assistant, scoped to the open item, in a panel
  that floats above the creator's other panels and is not part of their sizing.
- **R1.3** The Generate page is reachable from the Create page and the sidebar's
  Create menu.
- **R1.4** Opening the assistant with no usable model shows setup: Continue with
  ChatGPT, choose a model from the configured Model connections, or follow
  instructions for a Claude subscription (R9). Until R9 is delivered, setup
  says that a Claude API key works through Model connections. Setup can be
  reopened later. Continue with ChatGPT is offered where the plan connection
  offers sign-in (#919 R1.7).
- **R1.5** The assistant has no persona and no Anima. Its conversations are not
  Chats: they do not appear in the chat list, and the Memory Manager, episode
  processing and chat search never read them.

### R2: Model access

- **R2.1** The assistant uses a model the person chooses from the ChatGPT plan
  connection or from any other configured Model connection. The choice is
  remembered. Sign-in, tokens, the plan notice, limits and sign-out belong
  to the ChatGPT plan connection (#919), which is delivered; the assistant
  reuses them.
- **R2.2** Only models that support tool calling can be chosen.
- **R2.3** With a model that does not accept images, frame review (R4.4) and
  image references (R8.2, R8.3) are unavailable and the app says why. The
  checks in R4.1 and R4.2 still run.
- **R2.4** An expired sign-in, a plan or rate limit, or a provider error ends
  the run with a plain message. The conversation and drafts are kept, and the
  person can sign in again, retry or choose another model. On a ChatGPT plan
  model these failures are the plan connection's own (#919 R5): the same
  states and wording, **Manage usage** at a usage limit, and no move to
  another connection unless the person chooses one.

### R3: Authoring one item

- **R3.1** A request produces a draft: an `animaPoseClip/2.0` clip organised by
  beats, with generated detail, and the name, description and other metadata
  the creator's Save needs. A Reaction draft also carries its emotion and
  intensity suggestion.
- **R3.2** The assistant may ask a short set of questions when the request
  leaves the performance open. The person can skip them.
- **R3.3** A draft plays in the preview as soon as it loads. Its status shows
  whether checks are running, being repaired, passed or left warnings.
- **R3.4** A follow-up message revises the selected draft. The person can
  restore the version from before the last revision.
- **R3.5** Save stores the draft as Local content through the same save path as
  the creator. The saved item opens in its creator with its beats editable.
  Saving is always the person's action; the assistant never saves by itself.
- **R3.6** "Open in creator" moves a draft into the creator as an unsaved
  document for manual edits.
- **R3.7** Gesture and Reaction drafts follow one facial expression guidance.
  The assistant keys named blendshapes according to what the chosen Avatar
  offers: VRM presets and VRoid's parts, MMD morphs under their Japanese
  names, ARKit shapes, and blendshapes the Avatar's author added.

### R4: Checks and repair

- **R4.1** Every draft is validated for structure, anatomical limits and size.
  A draft the app cannot load is never shown as playable or offered for Save.
  The assistant repairs it, or the draft is marked failed with the reason.
- **R4.2** Every loadable draft runs the motion checks the skill uses (pose,
  range, smoothness, oscillation, intersection, fingers, contacts, feet, loop
  seam and parity) on both Included Avatars.
- **R4.3** The assistant repairs failed checks itself for up to three rounds.
  What remains is listed on the draft as warnings in plain words. Warnings
  never block Save.
- **R4.4** With a model that accepts images, the assistant looks at rendered
  frames of each draft version (front, three-quarter, side and face) before
  marking it ready. The app renders the frames itself. They reach the model
  through the image input that chat image input gave the model adapters
  (#904).

### R5: Preview

- **R5.1** The preview plays the selected draft on an Avatar the person picks
  from their own Avatars and the Included Avatars, with play, pause, restart
  and loop. It defaults to the Avatar of the Anima they chatted with last.
- **R5.2** In a creator, the assistant's drafts play in the creator's own
  preview.
- **R5.3** Effects on the draft's timeline (R7.3) show in the preview.

### R6: Runs

- **R6.1** While the assistant works, the app shows progress in plain words
  (for example writing, checking, repairing, reviewing frames), not only a
  spinner.
- **R6.2** The person can stop a run at any time. Drafts finished so far are
  kept, and an unfinished draft is kept only if it loads.
- **R6.3** With a key-based model the app shows tokens used by the run and the
  conversation, and an estimated cost when it knows the model's price. With a
  ChatGPT plan model it shows the plan notice instead: **Using ChatGPT plan**
  with **Manage usage**, beside the assistant's model choice as in the chat's
  model picker (#919 R3.7).
- **R6.4** Conversations, unsaved drafts and their references survive closing
  and restarting the app. The person can discard a draft or a conversation,
  which removes its stored data. A saved item no longer depends on its
  conversation.
- **R6.5** A conversation runs one request at a time.

### R7: Beyond one new Gesture

- **R7.1** From a creator, the assistant revises the open Local Gesture or
  Reaction. Its change appears as an unsaved change the person can undo, and
  the creator's Save keeps the item's identity. An Included item is customised
  into a new Local item, as the creator does today.
- **R7.2** Everything in R3 to R6 applies to Reactions, on the Generate page
  and in the Reaction creator.
- **R7.3** The assistant may place existing Avatar, Particle and Scene Effects
  from the Library on a draft's timeline, with per-use overrides. Save records
  them as dependencies.
- **R7.4** One request may ask for up to ten items. Each is its own draft with
  its own status, a failed item does not stop the others, and the person saves
  selected drafts or all of them. Each saved draft is its own Local item, and a
  failed save is reported per item.

### R8: References and presets

- **R8.1** The person can pick Gestures from the Library as a starting point or
  as an example of the feel they want.
- **R8.2** The person can attach reference images to a request. They are
  stored with the conversation and removed with it. They use chat image
  input's upload, stored copy and limits, and reach the model the same way
  (#904, ADR 0038).
- **R8.3** The person can attach a short video. The app samples frames locally
  and sends them as images through the same path as R8.2. This requirement
  stands only if check C3 passes; otherwise video is deferred by a recorded
  decision.
- **R8.4** A gallery of prompt starters fills the request field for editing.
- **R8.5** Named style presets apply to any request and stay selected for the
  conversation.
- **R8.6** An inspirations gallery offers images and short loops rendered from
  Animama's own Included content, the person's own saved reference images, and
  curated outside images. Choosing one attaches it as a reference.

### R9: Authoring from the person's own Claude client

- **R9.1** A connector the person installs lets their own Claude Desktop or
  Claude Code, or another agent client that accepts local connectors, author
  through the assistant's tools: create and revise drafts, run checks and get
  frames. Drafts appear in the Generate page's list as they are made.
- **R9.2** The client uses its own sign-in. Animama never sees or stores the
  person's Claude credentials.
- **R9.3** A connector reaches the app only after the person pairs it from the
  Generate page, and they can revoke it. It can use the authoring tools and
  nothing else. Saving stays the person's action in Animama (R3.5).

## Constraints

- **Local compositions only.** A runtime capability hides the feature in the
  hosted composition, and new routes are classified local (ADRs 0017 and 0021).
- **Provider terms.** The ChatGPT plan connection follows its own spec. Under
  OpenAI's terms the plan serves only Animama's own features, so the connector
  in R9 never relays plan-backed requests: an outside client uses its own
  model. If the plan connection is unavailable, the assistant keeps working on
  other Model connections. Every run starts from the person's own message, so
  on the plan it is one of their own requests (ADR 0039) and needs no
  agreement to background use.
- **Content rules.** Saves go through the typed save path (ADR 0004). Clips use
  `animaPoseClip/2.0` and its hand and contact vocabulary (ADRs 0014, 0016,
  0019 and 0020). Non-portable content (ADR 0018) cannot be picked as a
  reference or starting point, and its data is never sent to a model.
- **Untrusted output.** Model output is validated before the app loads it. The
  assistant's tools are limited to authoring: no shell, file paths or commands,
  in keeping with the desktop bridge's existing rule. Conversation text renders
  under the existing Markdown policy.
- **Privacy.** Requests, references and frames go only to the model provider
  the person selected. Frames sent to a model are rendered on the Included
  Avatars; the person's own Avatar is never shown to a model. Only the names
  of its expressions and blendshapes are sent, so the assistant can key them
  (R3.7). Reference images follow the storage and metadata rules of chat
  image input (#904, ADR 0038).
- **One source of truth.** The app and the `animama-animation` skill share the
  same check logic and authoring guidance, and the skill keeps working.
- **Cost bounds.** Repair rounds (R4.3), batch size (R7.4) and frames per
  review are bounded, so one request cannot spend without limit.
- **Responsiveness.** The stop control and the rest of the interface stay
  responsive while checks run. The preview uses one Avatar canvas at a time.
- **Schema and API.** Stored conversations and drafts need a new Alembic
  revision with the ORM change (ADR 0035). API changes regenerate the frontend
  client through `pnpm openapi-ts`.
- **Language and accessibility.** Interface text is localised, and the assistant
  converses in the UI locale (ADR 0024). The floating control is reachable and
  dismissible with the keyboard and does not trap focus.
- **Licensing.** Every shipped inspiration image has a licence inventory entry
  that permits redistribution. Images without one do not ship.
- **Records.** The change needs an ADR for the assistant, and glossary entries
  for the assistant and a draft.

## Acceptance criteria

- [ ] The owner runs two or three agreed requests on a named ChatGPT plan
  model and judges the saved Gestures against the skill's output for the same
  requests. The plan names the requests and the model.
- [ ] A browser journey covers request, a draft playing on the chosen Avatar
  and on each Included Avatar, a revision by chat, Save, and the item opening in
  the Gesture creator with editable beats after a reload.
- [ ] With a ChatGPT plan model, a run completes in the desktop app and in a
  self-hosted stack and shows the plan notice. With a key-based model, a
  run completes and shows token use.
- [ ] With no model, setup appears. A model without tool calling cannot be
  chosen. With a model that does not accept images, frame review and image
  references are disabled with an explanation.
- [ ] Tests show that a draft with a seeded motion fault is repaired or saved
  with a visible warning, that an unloadable model output reaches neither the
  preview nor Save, and that the app and the skill report the same findings for
  the same clip.
- [ ] Stopping a run keeps finished drafts. Restarting the app restores the
  conversation and unsaved drafts, and discarding removes their stored data.
- [ ] A cost estimate shows beside token use when the model's price is known.
- [ ] The hosted composition exposes neither the routes nor the interface.
- [ ] From a creator, a revised Local Gesture keeps its identity on Save, and
  the same works for a Reaction. A draft with effects saves with its
  dependencies. A batch with one failing item still saves the others.
- [ ] Non-portable items cannot be chosen as references. Reference images, and
  video if R8.3 stands, reach an image-capable model. A prompt starter fills
  the request field, and a style preset stays selected for the conversation.
  Every shipped inspiration passes the licence inventory check.
- [ ] Tests show that the assistant's conversations appear in no chat list,
  memory file or chat search result.
- [ ] Tests show that the assistant is given the chosen Avatar's expression
  and blendshape names, and that Gesture and Reaction requests carry the same
  facial expression guidance. The owner checks a Gesture and a Reaction made
  for an Avatar with ARKit or MMD shapes: both key names that Avatar has.
- [ ] A paired client creates a draft that appears in the Generate page. An
  unpaired or revoked client is refused, and the connector offers only the
  authoring tools.
- [ ] Backend tests, `pnpm verify` and the affected browser tests pass. The
  feature, model settings and creator documentation describe the behavior.

## Open questions and decisions

Agreed by the owner (2026-11-24):

1. **Users and reach.** People running Animama locally; not the hosted
   composition.
2. **Placement.** A Generate page plus a floating bottom-right control in the
   creators, with one neutral assistant and setup on first use.
3. **Model access.** Continue with ChatGPT and existing Model connections in
   the app. Claude subscribers use a connector, delivered after the in-app
   assistant on the same authoring tools. No terminal and no CLI launching.
4. **Quality.** Check and repair automatically; never block Save.
5. **Preview.** On the person's own Avatar and the Included Avatars.
6. **Scope.** New items, revising saved ones, Reactions, effects on the
   timeline and batches.
7. **References and presets.** Existing Gestures, images, and video if it
   proves workable; prompt starters, style presets and inspirations from the
   three sources in R8.6.
8. **Runs.** Stop, plain-word progress, usage or cost, and drafts that survive
   closing.
9. **Acceptance.** Two or three requests compared with the skill, not ten.
10. **Delivery order.** The first usable phase runs on the ChatGPT plan
    connection, with one new Gesture end to end. It therefore follows the
    first phase of the ChatGPT plan spec. (2026-11-26: that work is
    delivered, so this phase no longer waits on it.)
11. **Sign-in split out.** The ChatGPT sign-in, its tokens and its use for
    Anima chat are specified in the ChatGPT plan spec, which this spec
    depends on.
12. **Facial expressions (2026-11-26).** Gesture and Reaction generation
    share one facial expression guidance. It keys named blendshapes (VRoid
    presets, MMD morphs with their Japanese labels, ARKit shapes and
    custom-authored blendshapes) according to what is available (R3.7).

Proposed by this draft and accepted by the owner on 2026-11-24:

- **P1** The Generate page's entry points (R1.3).
- **P2** Withdrawn on 2026-11-24. It limited the ChatGPT sign-in to the
  assistant; decision 11 replaces it.
- **P3** The assistant's model is its own remembered choice (R2.1).
- **P4** Clarifying questions are skippable and limited to one round (R3.2).
- **P5** Restoring the version before the last revision (R3.4). Keeping every
  version, comparing two, and notes pinned to a moment were not chosen.
- **P6** Saving is always the person's action, for the assistant and the
  connector (R3.5, R9.3).
- **P7** Three repair rounds (R4.3) and frame review once per draft version
  (R4.4).
- **P8** Frames sent to a model use the Included Avatars only (Privacy).
- **P9** The preview's default Avatar (R5.1).
- **P10** A batch limit of ten, as in the skill (R7.4).
- **P11** The companion guardrail (ADR 0008) covers chat turns with an Anima
  and does not apply to the assistant; the provider's own safeguards do.
- **P12** After the first phase: Model connections, the creator control with
  revising and Reactions, batches and effects, references and presets, then
  the connector.

Open checks, each a bounded task that blocks the work named:

- **C1** Resolved on 2026-11-25. It had moved to the ChatGPT plan spec, whose
  live trial and packaged desktop check passed (#919): sign-in works in the
  desktop app and in a self-hosted stack opened on the same machine, tool
  calling works on the plan route with tools in a namespace, the route takes
  image input and offers no image generation, and models are listed per
  account. This spec's first phase is unblocked.
- **C2** Whether the motion checks and frame rendering run in the app, how
  long a draft takes to check, and whether checks should also run on the
  person's own Avatar. Blocks R4.
- **C3** Whether a model reads motion well enough from sampled video frames.
  Blocks R8.3 only.
- **C4** Whether Claude Desktop shows a connector's image results to the model,
  and how a connector pairs with the app's request admission (ADR 0002). Blocks
  R9.
- **C5** Which models are adequate, and what the app tells a person whose
  model is not.

Related work, both delivered: the ChatGPT plan connection (#919, ADR 0039) and
chat image input (#904, ADR 0038), which gave every model adapter image
input, the plan route included. Frame review and reference images reuse it.

## Spec

This issue.

## ExecPlan

Approved by the owner on 2026-11-26 (G0), including D1 to D17. Tracked as
`docs/plans/in-app-generation/in-app-generation-execplan.md` on branch
`feat/in-app-generation`; it is linked here at its reviewed revision once the
branch is pushed.

## Delivery links

To be added as phases complete.
