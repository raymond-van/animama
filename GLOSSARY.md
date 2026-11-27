# Shared language

This glossary establishes common meanings between Raymond and AI agents in
conversation, specifications, implementation and reviews. These are Animama's
domain meanings, not universal definitions. Surface conflicting usage rather than
silently choosing another meaning; propose a clarification when a distinction is
missing. Definitions describe the current local product, not promised features.

## Anima

The owned, live companion: its name, private identity, chat state and selected
content. An Anima is not just its Avatar; changing visual content does not replace
the companion's identity or conversations.

## Avatar

The typed content that supplies a companion's visual representation and related
content defaults. Use **Anima** for the live companion and **Avatar** for this
selected content, rather than treating the words as interchangeable.

## Installation owner / installation principal

The single durable owner generated for a local installation; **principal** is its
authorization representation. This is not a login account, a central Cloud account
or the temporary credential used to admit a desktop renderer.

## Owner

Raymond Van, who directs the project: product intent, specifications, plans,
consequential choices, merges, releases and publication. Process documents
(the lifecycle documents, plans and skills) say **the owner** for the role and
**Raymond** where the person matters. Not the **installation owner**, the local
runtime's single generated principal, which product documents call the owner.

## Cloud (hosted composition)

Animama Cloud, the hosted service that a separate, private repository builds from
this repository's shared packages and contracts, with accounts and hosted
storage. This repository builds, tests and runs without it; Cloud consumes only
its reviewed, immutable public artifacts (see
[repository boundaries](docs/architecture/repository-boundaries.md)). Code that
serves both says **local composition** and **hosted composition**.

## Chat

A persisted conversation associated with one Anima and its owner, containing
ordered messages. A chat can span many requests; it is not an SSE connection or
one model invocation.

## Turn

One request-local interaction with a companion, potentially involving several
model/tool rounds and stored messages. The existing `ChatMessage.turn` field orders
individual messages; it is not a shared number for all messages in one conversational
turn. A `run_id` identifies the streamed interaction, not the saved chat.

## Included content

Content supplied through read-only library sources, including shipped content and
installed Included-content packs. **Included** describes its source and editability,
not its creator, licensing rights or a hosted deployment mode.

## Local content

Content in the writable local library, including created, imported or manually
added items. **Local** distinguishes this content from Included content; both are
used by the local application and access is governed separately by the catalog.

## Pose

A static set of humanoid bone transforms and expression weights. A saved Pose is
self-contained Included or Local content. Inserting it into a Gesture copies its
effective values; later source edits or deletion do not change that Gesture.

## Pose Clip

A timed sequence of poses, expressions and optional effects or sounds, stored as
an Action-owned implementation document. Gestures and Reactions can use Pose
Clips; clips are not independently selectable catalog items. A standalone Pose
has no timeline and is not Anima equipment. `animaPoseClip/2.0` is the only
clip format; the retired 1.0 format is rejected
([ADR 0016](docs/adr/0016-anima-pose-clip-2-only.md)).

## Gesture

An equippable Action in which an Anima moves its body, usually with facial
expressions, to accompany what it says. It is implemented as a Pose Clip or a
VRMA animation. Agents can author Gesture motion; people adjust it by beats in
the Gesture creator. A Reaction is the separate, expression-led Action chosen
by emotion and intensity.

## Beat

A named moment in a Pose Clip's timeline, such as "Raise" or "Settle", shown as
a keyframe on the creator's Pose lane. In `animaPoseClip/2.0` every key belongs
to a beat, so retiming, re-posing or deleting the beat carries its keys with
it.

## Generated detail

A beat's keys besides its pose at the beat's own time: lead and lag between
body parts, overshoots, bounces and finger motion, usually authored by an
agent. Detail follows its beat when the beat is retimed or re-posed and is
removed with it; people do not edit it key by key.

## Idle

The finite Gestures an Anima plays while it is quiet, chosen from its built-in
Idle pool: a Default pool plus one cell per emotion and intensity. Each idle is
a Default Gesture half the time and, the other half, a Gesture from the current
emotion's cells at or below its intensity. Every Anima has exactly
one pool, seeded at creation and edited in its loadout. Idle Gestures are never
AI-callable. Formerly "Idle Style", reusable content that no longer exists
([ADR 0026](docs/adr/0026-built-in-idle-pool-per-anima.md)); do not use that term.

## Reaction

The expression-led Action an Anima plays while talking, chosen by the turn's
emotion and Reaction intensity: Mild, Moderate, Strong or Intense (1–4). Each
of the 24 emotions has one cell per intensity, 96 in all, and each cell holds a
pool of up to four Reactions; a Reaction may sit in any number of cells. For
each emotion event chat plays one member of that cell at random, never the
member it played last when the pool has two or more. An empty cell plays no
Reaction and never falls back to another cell. A Reaction's emotion/intensity
suggestion is only a hint for where it fits.

## Content assistant

The AI that authors content from a person's request on the Generate page of a
local composition, at present Gestures; the interface and the documents call
it **the assistant**. It has no persona and is not an **Anima**. Its
conversations are not **Chats**: they appear in no chat list, and memory,
episode processing, Reflection and chat search never read them. It writes
only **drafts**, and saving one is always the person's action. Its model is
its own remembered choice, not a **Model role**. Not the `assistant` role of
a chat message, and not an agent skill that authors content from a source
checkout. See
[ADR 0041](docs/adr/0041-backend-built-content-assistant-runs.md).

## Draft (assistant draft)

Content the assistant wrote that the person has not saved: held with its
conversation, with a status, the warnings its checks left and, after a
revision, the one version before it. It stays there across restarts until
the person discards it or its conversation. Saving a draft makes a Local item
that no longer depends on it. Not a creator's unsaved document, an agent
skill's clip file before it is saved, or the saved progress of creating an
Anima, which code and documents also call drafts.

## Non-portable content

Included content that plays, previews and can be equipped but never leaves the
app as files: it cannot be customized into a Local copy, exported in a
[Portable package](#portable-package) or imported. Its licence inventory rule
sets `"distribution": "non-portable"`, and identical bytes stored anywhere are
restricted too. The Mixamo-motion pack in desktop and hosted builds is
non-portable. See [ADR 0018](docs/adr/0018-non-portable-included-content.md).

## Avatar Effect

Reusable art drawn on or around an Avatar during a Gesture or Reaction: painted
on the face, floating in front of it, on a body point, as a sticker beside the
Avatar or filling its silhouette. The effect owns its art and its default
placement, look, motion and sounds; the Action event that plays it owns when
it starts, ends and fades, and may override the placement, look, motion and
sound for that one use ([ADR 0025](docs/adr/0025-per-use-avatar-effect-overrides.md)).
It is never equipped directly. Art that only sits on the Avatar and moves as
one piece is an Avatar Effect, not a Particle Effect.

## Particle Effect

A three.quarks effect of one or more emitters, such as sparkles, hearts or
bursts, attached to a point on the Avatar and played by a Gesture or Reaction.
Its textures are its own images or the creator's built-in ones. A single
long-lived particle is a valid layer when it uses particle behaviour
(emission, life curves, bursting into other particles), usually alongside
other layers.

## Scene Effect

Background layers (solid, gradient, pattern, tile, rays or lines, marquee,
scatter and an entry flash) or focus lines drawn in page layers behind or in
front of the Avatar, outside its 3D scene, and played by a Gesture or Reaction.
It never changes the Avatar itself.

## Face part

A part of an Avatar's face that Avatar Effects use: face skin, each eye's iris,
eye highlights, eye lines, eyelashes or hair. The app detects parts from VRM
signals, not material names. A user's correction is saved with that Avatar and
applies only to the exact model file it was made on. "Face skin" is a detected
part, not a glTF skin.

## Portable package

A local `.zip` file containing selected content and its required dependencies,
or one saved Anima definition and its content. An Anima package includes the
reviewed identity and selections, not conversations or other private memory.
Import creates independent Local content and, for an Anima package, a new companion.

## Loadout

An Anima's persisted, revisioned selection of content and bindings. It describes
what is equipped, not copied content bytes or an already mounted runtime snapshot.
The Anima page shows it as the **Behavior** tab; code, API and docs keep the
name Loadout.

## Runtime snapshot

An owner-scoped, leased resolution of selected content and its dependencies into
an exact runtime revision and catalog. It pins what a runtime can use; it is not
the editable loadout, a live view of changing files or a database backup.

## Feature pack

A verified, data-only optional desktop distribution component, installed by
Electron's pack manager with a service restart: currently only expanded
Included content. Upload processing is part of the core app, not a pack. A
feature pack is distinct from a **Model asset**, a portable content
import/export package and a wheel/npm software package set; installation alone
does not equip an Anima.

## Model asset

A pinned model file or multi-file set (a model asset set) that the backend
downloads, verifies and activates in place, without a restart, on desktop and
self-host: the offline speech recognition sets (Parakeet and SenseVoice-Small,
each a CPU set with an optional GPU add-on), downloadable Pocket voices and the
voice-cloning encoder. It is not a **Feature pack**, and installing one changes
no provider or voice selection.

## App settings

Installation-wide preferences chosen in App Settings, stored in
`user_settings` for the installation owner. For memory and emotion behaviour
they are defaults that every Anima follows unless it sets its own value.
Per-machine choices such as the microphone device are local to that machine,
not App settings.

## Locale (UI Locale)

The one language Animama uses for its interface, its date, number and plural
formatting, and its Animas' conversations: `en`, or the beta `ja`, `ko`,
`zh-Hans` and `zh-Hant`. Saved in App settings, where unset means "System
default". It is not the crisis-resource region; see
[ADR 0024](docs/adr/0024-ui-locale-is-the-conversation-language.md).
Code that names the browser's language tag `locale` (for example the chat client
context's `locale`) is not the UI Locale; the context's `ui_locale` is.

## Conversation language

The language an Anima replies, speaks and listens in. It is always the active
**Locale**: a non-English locale instructs the model and sets the speech
language code; English leaves both to their defaults. Unless the owner chose
an offline speech recognizer, it also chooses one when dictation or Voice Mode
starts: Parakeet for English, SenseVoice-Small for Japanese, Korean and Chinese
([ADR 0029](docs/adr/0029-sensevoice-offline-speech-recognition.md),
[ADR 0031](docs/adr/0031-offline-speech-engine-is-the-owners-choice.md)).
Parakeet and Pocket TTS work only in English and show a warning under other
locales. New memory text is written in the language of the conversation or
notes it comes from ([ADR 0024](docs/adr/0024-ui-locale-is-the-conversation-language.md)).

## Audio tag

A short bracketed direction in a reply's `speech`, such as `[laughs]`,
`<long pause>` or `[whispers]`, that the voice performs and never speaks as
words. The chat model may write them only when the turn's voice is Gemini or
ElevenLabs. Each voice receives its own spelling, and Pocket TTS, browser
speech and chat bubbles receive none. Stored replies keep the tags as written.
See [audio tags](docs/backend/integrations/voice-and-speech.md#audio-tags).

## Anima settings

Per-Anima preferences stored in `anima_settings`. A memory or emotion value
here overrides the App settings default for that Anima only; choosing
"App default" removes the override. Distinct from the **Loadout**, which selects content.

## Anima memories

An Anima's own `MEMORIES.md`: its first-person record of its relationship and
shared history with the installation owner, such as milestones, nicknames, how
the two relate and open threads. It belongs to one Anima and is included in that
Anima's every turn while memory influence is on. Facts about the owner that every Anima should know belong in
shared memory such as `PROFILE.md`; episodes are the shared log of what happened.
See [ADR 0009](docs/adr/0009-shared-user-memory-and-per-anima-relationship-memory.md).

## Reflection

An owner-started Memory Manager conversation that reads one Anima's turns not yet
covered by an applied Reflection and proposes a curated edit of its Anima
memories. It never runs automatically. Turns count as covered only once its change
is applied.

## Automatic episode processing

In the local composition, Memory Manager episode processing that the backend
starts by itself once the owner's pending episode notes (saved by chat's
`remember` field) reach the App Settings threshold. It approves its own proposals,
writes only shared user memory such as `PROFILE.md`, and labels each change in
version history as an automatic update from episode notes. Distinct from
**Reflection**, which stays owner-started; hosted has no automatic processing. See
[ADR 0034](docs/adr/0034-automatic-episode-processing-and-profile-context.md).

## Model connection

An endpoint the installation reaches models through: a base URL, its
credential and compatibility options. A connection speaks an OpenAI protocol
(Responses or Chat Completions) or Anthropic's Messages API. The credential is
usually a key: the built-in OpenAI connection uses the OpenAI key and base URL
from API Keys or the environment, and the built-in Anthropic connection uses
only the Anthropic key against Anthropic's API. The built-in **ChatGPT plan
connection**'s credential is a sign-in instead. The owner adds others, such as
Ollama, LM Studio, llama.cpp or any OpenAI-compatible Chat Completions server,
in App Settings → Models. Keys and sign-in tokens never enter the database. A
connection's **models** are built-in (read-only templates the owner can hide),
**account-listed** or owner-added. The hosted composition has no owner
connections; see
[ADR 0011](docs/adr/0011-application-owned-companion-features-and-composition-catalog-policy.md).

## ChatGPT plan connection

The built-in model connection whose credential is the owner's Sign in with
ChatGPT session, in local compositions only. Eligible requests (chats, their
titles and compaction, Memory Manager runs and the content assistant's runs)
use the usage included in the
account's ChatGPT plan instead of an API key; automatic episode processing uses
it only with the owner's agreement. Its models are **account-listed**. A role
whose plan model cannot run waits rather than moving to another connection. See
[ADR 0039](docs/adr/0039-chatgpt-plan-sign-in-and-connection.md).

## Account-listed models

The models OpenAI lists for the signed-in ChatGPT account, stored as read-only
rows of the ChatGPT plan connection when the owner signs in or refreshes the
list, and retired at sign-out. The owner can hide one but not add or remove
one.

## Model role

A job the installation gives a model: the default chat model for new Animas,
Utility (chat titles and compaction), Memory Manager and Embeddings (file and
archive search). Utility and the Memory Manager follow the default chat model
unless chosen; Embeddings stay off, with keyword search, until chosen. An
Anima's own chat model is chosen per Anima, not by a role.

## Pre-send compaction

Summarizing earlier conversation with the Utility role before a turn is sent,
so a model without native compaction never receives a prompt larger than its
context window. The chat shows "Summarizing earlier conversation…" meanwhile;
if summarizing fails, the oldest messages are left out of that request
instead. Post-response compaction, after a reply, remains the usual path.

## Application web search

Web search that Animama runs itself through the installation's configured
backend (SearXNG or the Brave Search API), offered as a `web_search` tool to
tool-calling models other than Anthropic's. OpenAI Responses models with hosted
search use OpenAI's search instead, and Anthropic models use only Anthropic's
own search. The per-model Web search control turns either on.

## Companion guardrail

The fixed, server-owned **Companion Guardrails** instruction section that ends
every chat turn's system instructions: honesty about being an AI, no
therapist claims, no manipulative retention and a caring crisis response. No
identity, memory, setting or safety switch removes it; see
[ADR 0008](docs/adr/0008-non-overridable-companion-guardrail.md).

## AI notice

The app-rendered line reminding the user that an Anima is an AI, not a person.
The backend decides when it is due (a start notice on the first turn of each
local day, and a reminder during a long continuing interaction); it is not
assistant text and is never spoken or saved in the chat.

## Continuing interaction

A run of turns with the same installation owner, across Animas, where each turn
starts less than 30 minutes after the previous one. AI-notice reminders are
measured from its start or the last notice, whichever is later.

## Benchmark run

One approved execution of the [model benchmark](docs/benchmarks/README.md)
over a fixed set of configurations (a catalog chat row at a reasoning effort)
and one prompt-set version. It produces raw results, judge scores and one
report; quality compares across runs of the same prompt-set version and judge
series, latency only within a run.

## Benchmark area

A group of related benchmark measures: core turns, long chats, in-chat memory
with the episodic-memory arms, or the Memory Manager. The word avoids
"domain", which names domain documentation and the backend `domain` layer.

## Using these terms

For implemented behavior, consult the [backend](docs/backend/README.md) and
[frontend](docs/frontend/README.md) documentation. Architectural reasons and
decision history belong in the [ADR index](docs/adr/README.md); the
[domain documentation guide](docs/agents/domain.md) explains how to maintain them.
