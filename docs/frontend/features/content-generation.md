# Content generation

On the Generate page a person asks for a Gesture in words. The content
assistant, an AI with no persona that is not an Anima, writes it as a draft.
The app checks the draft and has the assistant repair what fails; the person
previews it on an Avatar, revises it by chat and saves it as Local content.

The page and its routes exist only in local compositions (desktop and
self-hosted web). They need the runtime capability `content_generation: true`,
which the hosted composition never reports. The reasons for the design are in
[ADR 0041](../../adr/0041-backend-built-content-assistant-runs.md).

Code: `web/src/ui/generate/` (the page, a run's stream and the page's draft
checks), hooks in `web/src/query/hooks/useGeneration.ts`, mutations in
`web/src/query/mutations/useGenerationMutations.ts` and the state of a run in
flight in `web/src/stores/generation-store.ts`. Validation, the motion checks
and the review sheets are the authoring code in
`web/src/lib/avatar/motion-authoring/`, which the `animama-animation` skill's
commands also run. The backend half is `app/generation/` behind the
[`/v1/generation` routes](../../backend/architecture/http-api.md#content-assistant).

The assistant authors Gestures. A request for a Reaction is refused
(`generation_intent_unavailable`), and a draft cannot place effects or sounds
on its timeline.

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

- Any chat model can be chosen that calls tools, streams, is shown in model
  lists and is active on an active connection, whichever connection that is.
  ChatGPT plan models are listed first. A model chat itself cannot use is not
  listed either, by the rule the chat's model picker disables rows with
  (`chatModelUnusableReason`): one of the owner's own models has no context
  window yet, or the app has no API for it.
- With no usable choice the page shows setup instead: none was made yet, or
  the chosen model was removed, hidden, or retired by signing out of the
  plan. Setup offers the [ChatGPT plan card](model-settings.md#chatgpt-plan)
  with **Continue with ChatGPT** where the plan connection offers sign-in,
  the models that can be chosen, and the way to model connections in App
  Settings → Models for any other model, such as one on a Claude API key.
  Setup can be reopened from the model control.
- While the chosen model is a ChatGPT plan model, the model control ends with
  "Using ChatGPT plan" and **Manage usage**, as the chat's model picker does.
- A model that does not accept images writes, checks and repairs drafts but
  skips the frame review, and the model control says so.
- The model can change between runs, in the middle of a conversation, but
  not while a run is in flight.

The backend checks the model again when a run starts and refuses one it
cannot use with `generation_model_unusable` and a reason.

## Asking

A message says what the Avatar should do, in at most 4,000 characters. It
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

A request made with no draft selected writes one new draft. Each draft shows
its name, a status and what its checks left:

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

**Save** stores a draft that loads as a Local Gesture through the Gesture
creator's own save, with the name, AI description and Selector ID the
assistant wrote, and then records the saved item on the draft. Saving is
always the person's action; the assistant never saves. The saved draft stays
in its conversation with a link that opens the item in the Gesture creator,
where its beats are editable. Saving the same draft again, for example after
another revision, replaces that item while the Library still holds it. The
saved item does not depend on the draft or its conversation: discarding
either leaves it in the Library.

**Open in creator** opens the Gesture creator on a new, unsaved document that
holds the draft's project, loaded as the creator's Import loads a project
file (`/gestures/new?draft=<id>&conversation=<id>`). The creator then works
on its own copy, and the draft stays in its conversation.

**Discard** removes a draft with the version kept for restoring. Save and
restore wait until a run in flight has finished, and so does Discard for the
draft that run is working on.

## What a run does

The backend builds every model request from its own instructions and tools.
Each step below is a fresh request, a *pass*:

1. A write pass, or a revise pass on the selected draft. The model gets the
   authoring guidance, the conversation's recent text turns and the message,
   and writes the clip through tools. The server validates what a tool call
   leaves and stores only a valid project.
2. The page checks that version and reports.
3. A repair pass while the report holds a validation problem or a failed
   check. Findings that only warn are passed along but start no repair.
4. One frame review, when the model accepts images: the page draws one
   contact sheet for each Included Avatar, with a row for each beat (at most
   six) showing the front, three-quarter, side and face views. The assistant
   accepts the draft or makes one edit, which the page checks once more.
5. The draft is left `ready`, `warnings` or `failed`.

| Limit | Value |
| --- | --- |
| Runs in flight for a conversation | 1 |
| Drafts a request writes or revises | 1 |
| Model responses in a pass | 8 |
| Repair passes for a draft after each request about it | 3 |
| Frame reviews in a run | 1, of at most two sheets |
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
  `repairing` after a restart.
- **Checks that cannot run.** If the page cannot run a draft's checks or
  send its report, the draft says so and offers to check again.
- **Model failures.** An expired sign-in, a plan or rate limit, a missing
  key or a provider error ends the run with the notice chat shows for the
  same failure, beside the request that failed, with **Manage usage** at a
  ChatGPT plan usage limit. The conversation and its drafts are kept, and no
  other model is used unless the person chooses one. The request can be
  sent again with **Try again**, unless the failed run had already stored
  its draft: a second pass would write a second draft, or replace the
  version a restore returns to.
- **The assistant's own failures** are worded from their codes in the
  `errors` catalog's `generation` area:

  | Code | When |
  | --- | --- |
  | `generation_no_valid_draft` | A pass ended without a draft that validates. A new draft is listed as `failed`; a revision leaves its draft unchanged. |
  | `generation_draft_unloadable` | The page could not load the draft's current version, so the draft is `failed`. |
  | `generation_model_unusable` | The chosen model cannot run, with a reason such as `tools_unsupported` or `connection_inactive`. |
  | `generation_run_in_progress` | The conversation already has a run in flight. |
  | `generation_stream_interrupted`, `generation_request_failed` | The connection was lost during a run, or the request never reached the backend. Drafts already stored are kept. |
  | `generation_run_failed` | Any other failure. |

## What is sent to the model provider

Requests go only to the provider of the chosen model. A run sends:

- the assistant's fixed instructions and Animama's authoring guidance;
- the person's message, their answers, and up to 20 earlier text turns of the
  same conversation;
- the draft being revised or repaired, with the page's check findings as
  text;
- the names of the chosen Avatar's expressions and blendshapes, at most 400
  names of at most 64 characters, listed as data;
- for a frame review, the two contact sheets, which show only the Included
  Avatars;
- one of three Included Gestures, when the model asks to read an example.

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
  incognito) chat are. Later tool rounds of a pass continue from the stored
  response.
- **Anthropic and Chat Completions models.** Animama sets no storage option,
  and the provider's own retention rules apply.

## What is stored

Conversations, their text turns, and each draft with its project, the one
version kept for restoring and its check report are stored in the
installation's database
([data model](../../backend/architecture/data-model.md#content-assistant)).
Discarding a draft or a conversation deletes its rows. Review frames are
never stored: the backend holds them in memory for one review. The token use
a run reported is stored with the assistant's turn; the page does not show
it.
