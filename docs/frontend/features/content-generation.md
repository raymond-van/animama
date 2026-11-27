# Content generation

On the Generate page a person asks for a Gesture or a Reaction in words. The
content assistant, an AI with no persona that is not an Anima, writes it as a
draft. The app checks the draft and has the assistant repair what fails; the
person previews it on an Avatar, revises it by chat and saves it as Local
content. The same assistant opens from the
[Generate control of the Gesture and Reaction creators](#in-a-creator), where
it revises the item open there.

The page and its routes exist only in local compositions (desktop and
self-hosted web). They need the runtime capability `content_generation: true`,
which the hosted composition never reports. The reasons for the design are in
[ADR 0041](../../adr/0041-backend-built-content-assistant-runs.md).

Code: `web/src/ui/generate/` (the page, a run's stream and the page's draft
checks; `creator/` holds the creators' control), hooks in `web/src/query/hooks/useGeneration.ts`, mutations in
`web/src/query/mutations/useGenerationMutations.ts` and the state of a run in
flight in `web/src/stores/generation-store.ts`. Validation, the motion checks
and the review sheets are the authoring code in
`web/src/lib/avatar/motion-authoring/`, which the `animama-animation` skill's
commands also run. The backend half is `app/generation/` behind the
[`/v1/generation` routes](../../backend/architecture/http-api.md#content-assistant).

The assistant authors Gestures and Reactions. A Gesture drafted on the
Generate page can also play
[effects that are already in the Library](#effects-on-the-timeline). The
assistant makes no effects and places no sounds.

A Reaction draft is a face only: expression tracks on beats, with a suggested
emotion and an intensity from 1 to 4. The server refuses it any field that
moves the body, which the Reaction creator would strip. The assistant writes
it from the packaged Reaction guidance (`resources/authoring/reaction.md`),
which builds on the faces guidance Gestures also use.

## Opening Generate

Generate opens from the Create page and from the sidebar's Create menu, at
`/generate`. A runtime without the capability shows neither entry, and the
direct link says that the feature is unavailable there.

The page shows a conversation with the assistant, a preview that plays the
selected draft on an Avatar, and the conversation's drafts. It opens on the
conversation written to most recently and starts the first one itself. The
person can start another, reopen an earlier one, or discard the open one with
its messages and unsaved drafts. These conversations are not Chats: no chat
list shows them, and memory, episode processing, Reflection and chat search
never read them.

## The assistant's model

The assistant uses one model, chosen on the page and remembered in the
owner's preferences as `generation.model_provider_id`. It is the assistant's
own choice, not a [model role](model-settings.md#default-models): it has no
default, and no run falls back to another model.

- The model control and setup list every chat model that is shown in model
  lists and active on an active connection, whichever connection that is,
  with ChatGPT plan models first. A model the assistant cannot use is listed
  disabled, with the reason:

  | Reason | The model |
  | --- | --- |
  | Cannot call tools | does not support tool calling, which every pass uses. |
  | Cannot stream replies | does not stream. |
  | Needs a context window of at least 64,000 tokens | records a smaller one. A pass sends 16,000 to 24,000 tokens and its tool rounds send the clip again. |
  | Set its context window in App Settings → Models | is one of the owner's own models with no context window recorded yet, which chat needs too. |
  | Not available for direct chat yet | has no API the app can talk to, as in the chat's model picker. |

  A built-in model that records no context window can be chosen, as in chat.
- Larger models write better motion; smaller ones need more repairs or leave
  more warnings. Setup and the model control say so, and name no model.
- With no usable choice the page shows setup instead: none was made yet, or
  the chosen model was removed, hidden, or retired by signing out of the
  plan. Setup offers the [ChatGPT plan card](model-settings.md#chatgpt-plan)
  with **Continue with ChatGPT** where the plan connection offers sign-in,
  the model list, and the way to model connections in App Settings → Models
  for any other model, such as one on a Claude API key. Setup can be
  reopened from the model control.
- While the chosen model is a ChatGPT plan model, the model control ends with
  "Using ChatGPT plan" and **Manage usage**, as the chat's model picker does.
- A model that does not accept images writes, checks and repairs drafts but
  skips the frame review, and the model control says so.
- The model can change between runs, in the middle of a conversation, but
  not while a run is in flight.

The backend checks the model again when a run starts and refuses one it
cannot use with `generation_model_unusable` and a reason. The 64,000-token
figure is one backend constant (`MIN_CONTEXT_WINDOW_TOKENS`) that the page
mirrors (`MIN_GENERATION_CONTEXT_WINDOW_TOKENS`). Each is tested against the
parity record `web/src/ui/generate/fixtures/model-requirements.json`; change
the three together.

### Reasoning effort

Where the chosen model offers reasoning effort levels, the model control
shows the chat picker's slider. Its first stop is **Model default**, which
names no level, and the others are the model's levels in order. A model that
offers none shows no control.

The choice is remembered for each model by itself, in the owner's preferences
as `generation.reasoning_efforts.<model id>`, so changing model and changing
back keeps both levels. Every model request of a run names the chosen level,
including a retry and a run that answers the assistant's questions; with
**Model default** none is named. Unlike chat, the assistant preselects no
level.

The backend refuses a level the model cannot run a pass at with
`generation_reasoning_effort_unsupported`: one the model does not list, or,
on OpenAI's Chat Completions API, any level but `none` on the models that
take function tools at no reasoning only.

### Token use and cost

Once a run has made a model request, the model control shows the last run's
input and output tokens and the open conversation's totals.

- **Key-based model with a listed price.** Each line ends with an estimated
  cost. The backend works it out from the prices the model had when the run
  started and stores the estimate with the run, so a later price change or a
  removed model does not alter it. It is an estimate, not a bill: it uses
  the standard input, cached-input and output prices only.
- **Model without a listed price**, such as most of the owner's own models:
  tokens only.
- **Claude API key.** The estimate is usually absent. The first response of
  a run writes Anthropic's prompt cache, and Animama has no price for cache
  writes, so the run is left without an estimate instead of an understated
  one. Token use still shows.
- **Server that reports no token use.** The tokens shown for such a response
  are Animama's own rough count, and the run has no estimate.
- **ChatGPT plan model.** Tokens only, with the plan notice in place of a
  cost. A plan run never gets an estimate, and no amount is shown at all
  while a plan model is chosen.

A conversation that used more than one model adds up the runs that have an
estimate and says that the amount covers only those.

## Asking

A message says what the Avatar should do, in at most 4,000 characters. While
the next message writes a new draft, a choice above the request field says
whether that draft is a Gesture or a Reaction; a conversation's drafts may be
of both kinds, and a revision keeps its draft's kind. The message
starts a run: one streamed request that the page follows, showing the
assistant's text as it arrives and what the run is doing in words (thinking,
writing, checking, repairing, looking at rendered frames).

Before writing, the assistant may ask up to four questions, once for a
request, each with two to four answers to choose from. The person answers
any of them or skips them all, and the run that follows writes the draft
without asking again. Unanswered questions return after a reload, and a run
that failed or was stopped before it stored a draft leaves them waiting. A
request the assistant cannot author gets a short answer in words and no
draft.

With each run the page sends the UI Locale, so the assistant writes the
name, the description and its own replies in that language
([ADR 0024](../../adr/0024-ui-locale-is-the-conversation-language.md)); in
English it switches only when the request itself is written in another
language. The page also sends the names of the expressions of the Avatar
chosen in the preview, so the face can key shapes that Avatar has.

## Drafts

A request made with no draft selected writes one new draft, or
[a batch](#batches) of up to ten when it asks for several items. Each draft
shows its name, a status and what its checks left:

| Status | Meaning |
| --- | --- |
| `writing`, `checking`, `repairing`, `reviewing` | A run is working on the draft: writing it, waiting for the page's checks, correcting what they failed, or looking at rendered frames. `checking` with no run in flight means the page still has to check the current version. |
| `ready` | The draft loads and nothing is left to warn of. |
| `warnings` | The draft loads and its warnings are listed. Warnings never block Save. |
| `failed` | No version loads. The draft cannot be played or saved, and says why. One that failed before it had a clip cannot be revised either: the page never selects it by itself, and a message sent while it is selected writes a new draft. |

For every new version the page does three things and sends one report to the
backend:

1. It validates the clip: structure, anatomical limits and saved size. Only a
   clip that loads is handed to the preview or offered for saving and for
   opening in the creator. This validation decides that, never the stored
   report.
2. It runs the motion checks on the two Included Avatars, Andrew and Annie,
   in a worker: pose, range, smoothness, oscillation, intersection, fingers,
   contact, feet, loop seam and parity, the checks `pnpm -s animation check`
   runs.
3. It compares the expression names the draft keys with the Avatar chosen in
   the preview.

A warning is one sentence in plain words, with the Included Avatar and the
time range it was measured on where it has them:

- a part of the clip that is not valid;
- a failed motion check, or one that only warns, by category;
- expression names the chosen Avatar cannot show;
- a version whose checks did not run.

Expression names that only some Avatars have (an ARKit shape, an MMD morph or
an author's own blendshape, as opposed to VRM presets and VRoid mood parts,
which play on every Avatar) are a note, not a warning: the draft plays them
only on Avatars that have them, and a draft whose only remark is such a note
is `ready`.

The preview plays the selected draft as soon as it loads, and again for each
new version and each newly chosen Avatar. The Avatar is picked from the
person's own Avatars and the Included Avatars, and starts as the Avatar of
the Anima they chatted with last. Play, pause, restart and loop apply to the
preview only.

### Batches

A request that asks for several items is planned as up to ten, each with a
short brief and its own draft. The run writes, checks, repairs and reviews
each item by itself, two at a time, and is still one run with one reply. A
creator's run never plans a batch: it works on the item open there.

- **Planned items.** Every item is listed as soon as the plan is made, before
  it is written, with its brief and kind. An item the run has not started on
  says that it is waiting for its turn; one in flight says its own step
  (thinking, writing, checking, repairing, reviewing frames). The
  conversation's progress line counts the items finished instead of naming
  one step: an item counts once its draft is listed and settled or its item
  failed, and a discarded item leaves the count. After a reload the briefs come from the run's stored turn, for
  the drafts that still exist.
- **Selection.** The first item to be written is selected when nothing is, so
  the preview has a draft to play. Items written after it leave the selection
  where it is.
- **A failed item.** An item that fails does not stop the others. Its card
  says why in the words a failed run uses: a model, plan or connection
  failure reads as the title of chat's notice, and never as a code. An item
  that fails after it had a version that loads keeps that version, and its
  card adds that the assistant could not finish it. A failure every item
  would meet (an expired sign-in, a missing or refused key, a usage, quota
  or rate limit, a model the provider does not serve) ends the whole run
  instead, with the notice a single run shows; drafts already written are
  kept and items not written yet are removed.
- **Checks and review sheets.** Two items can wait for the page at once. The
  page checks them one after another and draws their review sheets one after
  another, since the preview canvas draws one thing at a time. Each report
  and each set of sheets is built from, and sent for, its own draft id and
  version.
- **Discarding an item.** A batch item can be discarded while the run works:
  only that item ends, and what the run still reports about it is ignored.
  The assistant asks the model nothing more for it: an item discarded before
  its turn is never written, and one discarded while it is written stops
  after the response in flight.
- **Stopping.** Stop ends every item. Items with a version that validated are
  kept, and planned items that were not written yet are removed.

### Effects on the timeline

A Gesture draft written or revised on the Generate page may play Avatar,
Particle and Scene Effects that the Library already holds: the person's own
portable effects and the Included ones.

- **What the assistant places.** Up to 24 timeline events, each naming one
  effect, when it starts and, where the clip format allows, how long it
  shows; an Avatar Effect's event may adjust that use of the effect. It
  places no sound events: a Gesture sounds only through its effects. A
  Reaction draft holds no events, and a [creator's run](#in-a-creator) leaves
  the open item's own effects and sounds as they are.
- **How a draft names an effect.** An event names its effect by an alias made
  from the effect's name. The draft's project pins each alias to one Library
  item with a dependency, in the shape the creators use, so preview, Save and
  **Open in creator** read a draft's effects as they read a creator
  document's. The draft's card lists the aliases.
- **Preview.** The page resolves the selected draft's dependencies through
  the Library's preview route and mounts them in the preview as the creators
  mount a document's effects, so playing the draft plays its effects on the
  chosen Avatar. Mounting other effects reloads the Avatar. Moving between
  drafts that play no effects, or the same ones, does not.
- **Checks.** Validation reads events as part of the clip. The motion checks
  and the review sheets measure and draw the motion and the face only.
- **Save and Open in creator.** Save records the dependencies with the item
  through the creator's own save. **Open in creator** opens the document with
  the events and their dependencies, and the creator plays them.
- **An effect that is gone.** A second request resolves the dependencies of
  every listed draft, and is sent again each time the page opens. When the
  Library no longer holds an effect a draft plays, the card names it by its
  alias. That draft's Save is held, and **Save selected** and **Save all**
  skip it, until a run has revised the draft: the assistant then removes the
  event or places another effect. **Open in creator** stays available. Only
  an effect the Library reports as gone holds a draft back. One that could
  not be checked (the request is in flight or failed), or that the Library
  holds but cannot show at the moment, does not: the Library's own save
  decides then, and refuses a dependency it cannot resolve.

## Revising and restoring

A draft the assistant has just written is selected, and opening a
conversation selects its latest draft. While a draft is selected, the next
message revises it; clearing the selection makes the next message write a new
draft.

A revision gives the model the draft as it stands and the requested change.
The result is a new version, checked and repaired like the first. The version
from before the person's message is kept, and **Restore previous version**
puts it back once, as a new version that the page checks again. Repairs
inside a run are not revisions, so a restore returns to how the draft stood
before the message, not to a half-repaired state. A revision that produces no
valid change leaves the draft and its restore point as they were.

## Saving and opening in the creator

**Save** stores a draft that loads as a Local Gesture or Reaction through its
creator's own save, with the details the assistant wrote (a Gesture's name,
AI description and Selector ID; a Reaction's name, suggested emotion and
intensity), and then records the saved item on the draft. The assistant
only gives a draft a name the Library can save (in Latin script: letters,
digits, spaces, dots, underscores and hyphens, starting with a letter or
digit), since the page cannot rename a draft. Saving is
always the person's action; the assistant never saves. The saved draft stays
in its conversation with a link that opens the item in its creator,
where its beats are editable. Saving the same draft again, for example after
another revision, replaces that item while the Library still holds it. The
saved item does not depend on the draft or its conversation: discarding
either leaves it in the Library.

**Open in creator** opens the draft's creator on a new, unsaved document that
holds the draft's project, loaded as the creator's Import loads a project
file (`/gestures/new?draft=<id>&conversation=<id>`, or `/reactions/new` with
the same search). The creator then works
on its own copy, and the draft stays in its conversation.

With two or more drafts the list offers **Save selected** and **Save all**.
Each draft that loads has a mark for the selection. The drafts are saved one
after another through the same save, each as its own Local item, and nothing
is saved without that click. A draft that cannot be saved as it stands (no
version that loads, a version the page has not validated yet, a run working
on it, or [an effect that is gone](#effects-on-the-timeline)) is skipped. A save that fails is reported on that draft's card
until the draft is saved, and neither stops the rest. A summary under the
buttons counts the drafts saved, failed and skipped.

**Discard** removes a draft with the version kept for restoring. Save,
saving several and restore wait until a run in flight has finished, and so
does Discard for the draft a run is writing or revising. A
[batch item](#batches) can be discarded during its run.

## In a creator

The Gesture and Reaction creators show a **Generate** control at the bottom
right, above the timeline, on a runtime with the capability. It opens the
assistant's conversation in a panel that floats over the creator's other
panels without resizing them. The panel does not trap focus: Escape closes it
and returns focus to the control, and a run in flight goes on while it is
closed. The narrow layout and VRMA items have no control.

- **One conversation for each item.** The conversation is stored with the
  scope `creator`, the creator's kind and the item's catalog id, and is found
  again whenever that item is opened. It is started the first time the panel
  is used with a model chosen. An unsaved item has no id: it gets a
  conversation for as long as the creator stays open. Starting one deletes
  the conversations this browser tab's earlier unsaved items of that kind
  left behind (the tab remembers the ones it started for its session);
  another tab's are never touched. An Included item opened to customize
  counts as unsaved. These conversations are not listed on the Generate page.
- **Discarding it.** The panel's header discards the item's conversation
  with its messages and drafts, after the same confirmation as on the
  Generate page and never while a run is in flight. The panel then starts an
  empty conversation for the item, which the next request uses. The creator's
  document is not touched.
- **Conversations do not outlive their item.** When conversations are
  listed, the backend removes a creator's conversation whose item is no
  longer in the Library, and one about an unsaved item that was not written
  to for seven days
  ([`GET /v1/generation/conversations`](../../backend/architecture/http-api.md#content-assistant)).
  An item that cannot be used at the moment (it is invalid, misses a file
  or an effect, or waits for a rescan) is still in the Library and keeps its
  conversation. A creator left open for those seven days starts an empty
  conversation at its next request.
- **A run starts from the document.** With each run the creator sends the
  item as it stands, hand edits included, as a project (`document`). A run
  started in Pose mode switches the creator to Clip, where the result plays
  and Undo is the clip's. A keyframe's pose that was changed there is first
  applied to its keyframe, as the Clip tab does, so that edit is sent and is
  an entry of its own in the history; an unchanged one adds nothing. An
  unsaved pose of its own (a new pose, or a changed Library Pose) is on no
  keyframe and would be discarded by the result, so while one exists no run
  starts and no result is applied, in any mode: the panel says to save or
  discard it first. The
  server validates the document's clip as it validates a model's before any
  pass reads it, and the run revises that document, not a stored draft. An
  item with no beat yet sends none, and the run writes it anew.
- **What the assistant leaves alone.** Effects and sounds on the timeline, a
  Reaction's playback lifetime, any field the clip format does not define
  and the item's dependencies are not sent and are put back on the result.
  The item's name, AI description, Selector ID and suggested emotion and
  intensity stay the person's: the model is not offered the ones the item
  has, and they are checked by the Library's own rules for a saved item, not
  a draft's stricter ones. A result fills only the ones the item lacks.
- **One undoable change.** The result replaces the timeline. A run's first
  result is one entry in the creator's history, and a later version of the
  same run (a repair, a review's edit) takes that entry's place, so Undo
  returns to the document from before the request and Redo to the result.
  The result plays in the creator's own preview, and the review sheets are
  drawn on its canvas.
- **Edits made during a run.** A hand edit is an entry of its own, and a
  result is never put over a timeline that changed while the assistant
  worked. If the timeline is not what the run started from, or what its last
  result left, the result is refused, the run is stopped and the panel says
  so; the person's edits stay, and sending the request again works from the
  timeline as it is then. Nothing is applied after Stop or after a run has
  ended.
- **Nothing is saved.** Warnings show in the panel. The creator's own Save
  keeps the item's identity, and an Included item becomes a new Local item
  at its first Save, as without the assistant.

The assistant's model is the one chosen on the Generate page; with none
chosen the panel points there.

## What a run does

The backend builds every model request from its own instructions and tools.
Each step below is a fresh request, a *pass*:

1. A write pass, or a revise pass on the selected draft. The model gets the
   authoring guidance, the conversation's recent text turns and the message,
   and writes the clip through tools. The server validates what a tool call
   leaves and stores only a valid project. On the Generate page a write pass
   may plan a [batch](#batches) instead; every item then goes through the
   steps below by itself. For a Gesture on the Generate page the model can
   also list the Library's effects and read one, to
   [place it on the timeline](#effects-on-the-timeline).
2. The page checks that version and reports.
3. A repair pass while the report holds a validation problem or a failed
   check. Findings that only warn are passed along but start no repair.
4. One frame review, when the model accepts images: the page draws one
   contact sheet for each Included Avatar, with a row for each beat (at most
   six) showing the front, three-quarter, side and face views. A Reaction's
   sheet shows the face only, from the front and from three-quarters. A sheet
   reaches the model at the size it was drawn, up to 2,048 pixels on its
   longer edge. The assistant accepts the draft or makes one edit, which the
   page checks once more.
5. The draft is left `ready`, `warnings` or `failed`.

| Limit | Value |
| --- | --- |
| Runs in flight for a conversation | 1 |
| Drafts a request writes or revises | 1, or up to 10 written as a batch |
| Batch items in flight | 2 |
| Time for the items of a batch | 60 min |
| Model responses in a pass | 8 |
| Repair passes for a draft after each request about it | 3 |
| Frame reviews for a draft in a run | 1, of at most two sheets |
| Wait for the page's check report | 120 s |
| Wait for the review frames | 60 s |
| Clip size and length | 2 MiB and 60 s |

A report that does not arrive in time leaves the draft `warnings`, saying
that the version was not checked. The page checks that version once no run
is in flight on the conversation: when it next opens the conversation, or
on **Check again**. Frames that do not arrive in time skip the
review and the run goes on; that is also what happens when the page cannot
draw them, for example with no preview canvas showing.

## Stopping, reloads and failures

- **Stopping.** The composer offers a stop control during a run. Stopping
  closes the run's request, which is how the backend learns of it, and the
  model request is cancelled. Drafts stored so far are kept. A draft still
  being written is kept only once a version of it validated, and a revision
  that was not stored yet leaves its draft as it was.
- **Leaving.** Leaving the page, switching conversation and closing the app
  stop a run the same way, because the page's checks stop with it. Nothing
  continues or restarts a run.
- **Reloads and restarts.** Conversations, drafts and unanswered questions
  are stored and return. When a conversation is opened, the page checks any
  draft whose current version was never checked, and the backend first
  settles a draft that a run left in one of its steps, so no draft stays
  `repairing` after a restart. It also settles a draft whose check report
  arrived after the draft was left, while another run held the
  conversation, so the draft reads as that report describes it.
- **Checks that cannot run.** If the page cannot run a draft's checks or
  send its report, the draft says so and offers to check again.
- **Model failures.** An expired sign-in, a plan or rate limit, a missing
  key or a provider error ends the run with the notice chat shows for the
  same failure, beside the request that failed, with **Manage usage** at a
  ChatGPT plan usage limit. The conversation and its drafts are kept, and no
  other model is used unless the person chooses one: **Choose another
  model** opens the model control. The request can be sent again with
  **Try again**, unless the failed run had already stored its draft: a
  second pass would write a second draft, or replace the version a restore
  returns to. A request that never reached the backend can always be sent
  again, whatever the run before it stored.
- **A stored response OpenAI no longer has.** On an OpenAI API key's
  Responses models, a pass's later tool rounds continue from the response
  OpenAI stored. Where the organisation stores none, or the response
  expired, the round is sent once more in full, as chat does for a stale
  cursor, and the rest of the run sends the whole exchange each round. A run
  spends at most one refused request this way, and goes on without a
  notice.
- **The assistant's own failures** are worded from their codes in the
  `errors` catalog's `generation` area:

  | Code | When |
  | --- | --- |
  | `generation_no_valid_draft` | A pass ended without a draft that validates. A new draft is listed as `failed`; a revision leaves its draft unchanged. |
  | `generation_draft_unloadable` | The page could not load the draft's current version, so the draft is `failed`. |
  | `generation_model_unusable` | The chosen model cannot run, with a reason such as `tools_unsupported`, `context_too_small` or `connection_inactive`. |
  | `generation_reasoning_effort_unsupported` | The chosen model cannot run a pass at the chosen reasoning effort. |
  | `generation_run_in_progress` | The conversation already has a run in flight. |
  | `generation_batch_time_limit` | The items of a batch took longer than the batch may. The run ends as a stopped run does. |
  | `generation_stream_interrupted`, `generation_request_failed` | The connection was lost during a run, or the request never reached the backend. Drafts already stored are kept. |
  | `generation_run_failed` | Any other failure. |

## What is sent to the model provider

Requests go only to the provider of the chosen model. A run sends:

- the assistant's fixed instructions and Animama's authoring guidance;
- the person's message, their answers, and up to 20 earlier text turns of the
  same conversation;
- the draft being revised or repaired, with the page's check findings as
  text; in a creator, the open item's timeline and details instead of a
  stored draft, without its effects and sounds. A draft always reaches the
  model inside a tagged data block that nothing in it can close, and a
  creator's document keeps only the clip fields the format defines;
- the names of the chosen Avatar's expressions and blendshapes, at most 400
  names of at most 64 characters, listed as data;
- for a frame review, the two contact sheets, which show only the Included
  Avatars;
- one of three Included Gestures, or for a Reaction one of three Included
  Reactions, when the model asks to read an example;
- for a Gesture on the Generate page, when the model asks: the names, kinds
  and short descriptions of the Library's portable effects, at most 100 for
  each listing, and for one effect how an event plays it (for an Avatar
  Effect, its region and the settings an event may adjust). These reach the
  model as tagged data. An effect's images and other files are never sent.

A run does not send the person's own Avatar: not its file, its textures or
any picture of it. Checks and review frames use the Included Avatars alone,
and only the names above are read from the chosen Avatar. It also sends no
Chat, memory, profile or other Library content, and never a non-portable
item.

What the provider keeps depends on the connection:

- **ChatGPT plan.** Every request is sent with `store: false`, so OpenAI
  does not store it as a response.
- **OpenAI API key, Responses models.** Requests are stored by OpenAI as
  responses, review sheets included, as the requests of an ordinary (not
  incognito) chat are, unless the organisation has turned storage off. Later
  tool rounds of a pass continue from the stored response where there is one.
- **Anthropic and Chat Completions models.** Animama sets no storage option,
  and the provider's own retention rules apply.

## What is stored

Conversations, their text turns, and each draft with its project, the one
version kept for restoring and its check report are stored in the
installation's database
([data model](../../backend/architecture/data-model.md#content-assistant)).
Discarding a draft or a conversation deletes its rows. Review frames are
never stored: the backend holds them in memory for one review. The token use
a run reported is stored with the assistant's turn, with the model it ran on,
its reasoning effort and, where the model had a price, the estimated cost.
