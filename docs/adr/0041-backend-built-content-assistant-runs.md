# 0041: The backend builds the content assistant's runs and the page checks its drafts

- Status: proposed (for owner acceptance with the pull request)
- Recorded: 2026-11-26
- Retrospective: no
- Original decision date: 2026-11-26 (owner approval of the execution plan,
  including D1 to D17, in
  [issue #942](https://github.com/raymond-van/animama/issues/942))
- Decision basis: Agent proposals D1 to D3, D5, D9, D10 and D16 in the
  [execution plan](../plans/in-app-generation/in-app-generation-execplan.md)
  Decision Log, approved by the owner with the plan, and requirement R1.5 of
  the agreed
  [specification snapshot](../plans/in-app-generation/in-app-generation-spec.md).
  The owner has not yet accepted this record.

## Context

In local compositions a person asks a content assistant for a Gesture or a
Reaction in words. The assistant has no persona. It writes each as an
`animaPoseClip/2.0` clip (a Reaction's holds a face and no body motion), the
app validates, checks and repairs it, and the person previews, revises and
saves it
([Content generation](../frontend/features/content-generation.md)).

Where each part of that loop can run is fixed by what the app already has:

- The motion checks and the renderer of review frames are browser code built
  on three-vrm and WebGL. Provider keys, the ChatGPT plan session and the
  model clients are in the backend.
- Under OpenAI's terms the ChatGPT plan connection
  ([ADR 0039](0039-chatgpt-plan-sign-in-and-connection.md)) serves only
  Animama's own features (the specification's provider-terms constraint), so
  the installation must not become a way to send someone else's prompts
  through it.
- A clip a model wrote is untrusted until it is validated.
- A Chat belongs to an Anima, and chat lists, chat search, episode notes, the
  Memory Manager and Reflection read Chats by owner. The assistant has no
  Anima.
- The person's own Avatar must not be shown to a model (the specification's
  privacy constraint).
- Included Gesture clips have a median size of 24 KB, so every extra copy of
  a clip in a request costs several thousand tokens.

## Decision

1. **The backend owns the conversation, the instructions and the tools; the
   page runs the checks and draws the frames** (D1). The page sends the
   person's message, the chosen model, the selected draft, the UI Locale and
   the names of the chosen Avatar's expressions; in a creator, the item open
   there as a document, which the backend validates as it does a model's
   clip; and the ids of the person's own Library Gestures, image files and
   style preset, each of which the backend reads itself. No route takes
   instructions, a tool list or model output from its caller. The page
   validates each draft version, runs the motion checks on the two Included
   Avatars and sends a bounded report, and draws review frames when a run
   asks for them.
2. **A run is a few bounded passes, each a fresh request built from stored
   state** (D2): one write or revise pass, at most three repair passes and
   one frame review for a draft version, each pass at most eight model
   responses. A run waits at most 120 seconds for the page's report and 60
   seconds for its frames. On the Generate page a write pass may instead
   plan a batch of up to ten drafts; each then gets those passes of its own,
   two drafts at a time, so one run holds at most two provider streams open,
   and the batch is still one run on its conversation.
3. **One tool loop on the model-client contract serves every provider** (D3).
   A pass offers a small fixed set of authoring tools with typed arguments,
   and what a call leaves is validated on the server before it is stored.
4. **A draft is stored as an `animamaActionProject/1.0` project** (D5), the
   document the creator's Import accepts. Save and Open in creator reuse the
   creator's own import and save code, and saving stays the person's action
   on the typed save path
   ([ADR 0004](0004-filesystem-content-and-recoverable-mutations.md)).
5. **The assistant's model is a preference, not a model role** (D9):
   `generation.model_provider_id`, sent with each run and checked there.
   With no usable choice the page shows setup. No run falls back to another
   model.
6. **A run lives as long as the page's request** (D10). There is no stop
   route: closing the stream stops the run, one run is in flight for a
   conversation at a time, and nothing continues or restarts a run.
7. **Between runs the model sees text turns and the selected draft** (D16).
   Earlier clip versions and tool exchanges are not replayed.
8. **The assistant's conversations are not Chats** (R1.5). They have their
   own tables, no Anima and no row in `chats` or `chat_messages`, so chat
   lists, chat search, memory, episode processing and Reflection never read
   them. The Companion Guardrails section
   ([ADR 0008](0008-non-overridable-companion-guardrail.md)) covers chat
   turns with an Anima and is not part of the assistant's instructions; the
   provider's own safeguards apply (the specification's P11).

The feature exists only where the runtime reports `content_generation`, which
the hosted composition never does
([ADR 0017](0017-common-web-application-and-hosted-artifact.md),
[ADR 0021](0021-shared-product-http-routes.md)).

## Alternatives

- **A loop driven by the page.** The page would hold the instructions and
  call a general model route. Rejected: that route would take a prompt and
  tools from its caller, which turns the installation into a relay for the
  plan and for the person's keys.
- **One long tool transcript.** The checks would return to the model as tool
  results in one growing exchange. Rejected: every round would resend each
  earlier clip version, the transcript would tie a conversation to one
  provider's message format, and model adapters read images only in user
  messages, so frames could not be a tool result.
- **The Agents SDK client.** The Memory Manager uses it on the plan route.
  Rejected: it does not stream there, and Anthropic models would need a
  second loop.
- **A model role.** Rejected: a fifth role would enter the shared roles
  contract, which the hosted composition also serves. A role also resolves
  to a default when none is chosen, while the assistant must never run on a
  model the person did not choose.

## Consequences

- Checks need the page open. A run waits on the page for each version's
  report; without one the draft is left with a warning that its checks did
  not run, and the page checks such a draft when it next shows the
  conversation. The report only decides repairs and warnings: loading and
  saving never depend on it.
- A run stops when the page closes its request: when the person stops it,
  on leaving the page or its conversation, and when the app closes. Drafts
  already stored stay.
- The plan serves only this feature's own requests. The backend builds every
  request from fixed instructions and tools, and each run starts from the
  person's own message, so on a plan model it is one of their own requests
  and needs no agreement to background use (ADR 0039, decision 6).
- Review frames are drawn on the two Included Avatars only, held in the
  backend's memory for one review and never stored. Of the person's own
  Avatar only the names of its expressions leave the page, capped and sent as
  data. A face keyed with names the Included Avatars lack cannot be judged
  from the frames, so the review is told which names those are.
- Each pass repeats the instructions, which are byte-identical within a run
  so that a provider's prompt cache can serve them.
- Repair is bounded, so some drafts end with warnings. Warnings never block
  Save.
- A pass uses chat's default provider options, with the reasoning effort the
  person chose for the assistant's model where they chose one. On an OpenAI
  Responses model reached with an API key its requests are therefore stored
  by OpenAI, as an ordinary chat's are, and its later tool rounds continue
  from the stored response, or resend the exchange where OpenAI has none; on
  the plan route nothing is stored.
- The person may change model in the middle of a conversation, because no
  run depends on another run's provider state.
- The one-run rule and the frames a review waits for are held in the server
  process's memory. That fits local launchers, which run one backend
  process.

## Evidence

- [Specification #942](https://github.com/raymond-van/animama/issues/942) and
  its [snapshot](../plans/in-app-generation/in-app-generation-spec.md): the
  requirements (R1.5 and R3 to R6), the constraints on provider terms,
  untrusted output, privacy and cost, and the owner's acceptance.
- [Execution plan](../plans/in-app-generation/in-app-generation-execplan.md):
  the threat model, the Decision Log and two trials. The page trial showed
  the motion checks and the frame renderer running in the page with the same
  findings as the command line. The authoring trial, on a ChatGPT plan
  model, showed the plan route accepting the tools, a fresh write pass of
  about 20 seconds, edits by JSON Pointer at a third of a rewrite's output,
  and repairs that leave some failed checks on a hard pose.
- [`app/generation/run.py`](../../src/backend/animama/app/generation/run.py),
  [`passes.py`](../../src/backend/animama/app/generation/passes.py) and
  [`tools.py`](../../src/backend/animama/app/generation/tools.py): the
  passes, their limits and the tools.
  [`server/routers/generation.py`](../../src/backend/animama/server/routers/generation.py)
  and
  [`server/schemas/generation.py`](../../src/backend/animama/server/schemas/generation.py):
  what a caller may send.
- [`draftChecks.ts`](../../src/frontend/web/src/lib/avatar/motion-authoring/draftChecks.ts)
  and
  [`reviewSheet.ts`](../../src/frontend/web/src/lib/avatar/motion-authoring/reviewSheet.ts):
  the page's checks and the sheet renderer, which draws the Included Avatars
  and has no parameter for another.
- [`tests/test_generation_api.py`](../../tests/test_generation_api.py) and
  [`tests/test_generation_run.py`](../../tests/test_generation_run.py): no
  route takes instructions, tools or model output; a conversation appears in
  no chat feature; review frames are stored nowhere; the limits on rounds,
  repairs and waits hold; and closing the stream stops a run and keeps its
  draft.
- [HTTP API](../backend/architecture/http-api.md#content-assistant) and
  [data model](../backend/architecture/data-model.md#content-assistant): the
  current routes and tables.
