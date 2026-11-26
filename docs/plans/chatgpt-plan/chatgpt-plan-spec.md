# Use a ChatGPT plan instead of an API key

Status: Agreed
Owner decision: accepted as written by the owner on 2026-11-24, including the
choices this draft proposed (P1 to P8). R2.1, R4.1 and R4.2 were revised the
same day with the ExecPlan's D2, D5 and D6, which the owner approved.
Authority: [#919](https://github.com/raymond-van/animama/issues/919). This file
is a snapshot of that issue captured 2026-11-24T18:25:43Z; change the issue,
not this file.

## Problem and intended users

A local installation reaches models through Model connections, and every one
of them needs a key or a model server: an OpenAI or Anthropic API key, a key
for another provider, or a local server such as Ollama. Getting an API key
means creating a developer account, adding billing and pasting a secret into
the app. For someone who is not technical, that is the main barrier to
chatting with an Anima at all.

OpenAI's Sign in with ChatGPT lets an open-source app that runs on the
person's own machine make requests that count against their ChatGPT plan. The
person signs in with OpenAI in their browser and pastes no key. Animama has no
sign-in of this kind: its credentials are keys, read from the desktop vault or
the environment.

Intended users are people who run Animama locally, in the desktop app or a
self-hosted stack, and have an eligible ChatGPT plan. In-app content
generation (drafted separately as `docs/plans/in-app-generation/`) is the
first feature that uses the sign-in.

## Goals, scope and non-goals

Goals:

- Sign in with ChatGPT from the app and use the plan for model requests,
  without an API key.
- Offer the plan's models wherever the app chooses a chat-capable model: an
  Anima's chat, the default chat model, Utility, the Memory Manager, and
  features that pick their own model.
- Keep sign-in tokens on the person's machine under the same custody rules as
  provider keys.
- Make it plain when the plan is in use, where to manage usage, and what
  happened when a limit is reached.

Non-goals:

- The hosted composition. OpenAI's terms require requests to come from the
  person's own runtime.
- Embeddings, speech recognition, text to speech and image generation through
  the plan. The plan route offers none of them.
- Driving Codex, or signing in through it. The app calls OpenAI directly.
- Several ChatGPT accounts signed in at once, and a saved-account picker.
- Paid tiers or credits of Animama's own. The app charges nothing.
- Signing in to Claude. Anthropic's terms do not permit that for a
  third-party app.

## Required behavior

### R1: Signing in

- **R1.1** App Settings → Models offers "Use your ChatGPT plan" with a
  **Continue with ChatGPT** action. The same action appears wherever the app
  asks for a model and none is configured.
- **R1.2** Sign-in happens at OpenAI in the system browser. Animama never asks
  for, sees or stores a ChatGPT password, and it presents itself to OpenAI
  under its own name.
- **R1.3** The first time sign-in succeeds with plan use granted, the app
  confirms once that eligible requests now use the ChatGPT plan, names what
  uses it (including the background work in R4) and says where to manage
  usage.
- **R1.4** If the person declines plan use, or the account is not eligible,
  the app says so, does not loop back into sign-in, and offers to enable plan
  use later or to use another Model connection.
- **R1.5** Settings shows the signed-in account, whether plan use is enabled,
  a **Manage usage** link to ChatGPT's usage settings, and sign-out. Sign-out
  ends the session at OpenAI and removes the stored tokens. If OpenAI could not
  confirm the session ended, the app says so and tells the person they can
  disconnect the app in ChatGPT's settings.
- **R1.6** One ChatGPT account is active per installation. Signing in with a
  different account replaces it only after the new sign-in is validated.
- **R1.7** Sign-in works when the browser runs on the machine that runs
  Animama: the desktop app, or a self-hosted stack opened on that machine.
  Opened from another machine, the app explains that sign-in must be done on
  the machine running Animama.

### R2: Tokens

- **R2.1** Tokens are stored only on the person's machine. The desktop app
  keeps them in a file encrypted with a key held in its vault; a self-hosted
  installation keeps them in a protected owner-only file in its private data.
  They never enter the database, logs, diagnostics, stream events, browser
  storage or URLs, and the page cannot read them back.
- **R2.2** The app renews tokens by itself, one renewal at a time. The person
  stays signed in across restarts.
- **R2.3** When OpenAI rejects the tokens (signed out elsewhere, disconnected
  in ChatGPT's settings, or expired beyond renewal), the app stops using them,
  removes them and asks the person to sign in again. A temporary network or
  service failure does not remove them.

### R3: Using the plan for models

- **R3.1** A built-in ChatGPT plan connection lists the models OpenAI reports
  for the signed-in account. The list refreshes at sign-in and on request.
- **R3.2** A plan model can be chosen as an Anima's chat model, the default
  chat model, the Utility model and the Memory Manager model, and by features
  that pick their own model. It cannot be chosen for Embeddings.
- **R3.3** Chat on a plan model behaves like chat on an OpenAI key model:
  streamed replies, the app's memory and file tools, and image input where the
  model accepts it (#904). R3.4 to R3.6 are the exceptions.
- **R3.4** Crisis support. The plan route cannot carry the inline moderation
  that adds a crisis card on OpenAI key models. Plan turns behave as local
  Anthropic and Chat Completions turns do today: no moderation-triggered card,
  while the Companion guardrail's crisis rule still applies.
- **R3.5** Web search on a plan model is offered only if the route allows it
  for the account. Otherwise its setting explains why it is unavailable.
- **R3.6** A chat continues when its Anima moves between an OpenAI key model
  and a plan model, in either direction.
- **R3.7** Whenever the selected model is a plan model, the app shows **Using
  ChatGPT plan** with a **Manage usage** link near the composer or model
  selector.

### R4: Background work

- **R4.1** The plan is used for work the backend starts by itself, which is
  automatic episode processing, only after the person has agreed to it. A
  Reflection the person starts is their own request and needs no agreement.
  The confirmation in R1.3 asks, and a setting changes the answer later.
- **R4.2** Without that agreement, automatic episode processing on a plan
  model does not run, and it does not move to another model. Nothing uses the
  plan silently.

### R5: Limits and failures

- **R5.1** When a request hits a usage limit, the turn ends with a message
  that says so and a **Manage usage** action. The app pauses further plan
  requests, including background work, until the person retries.
- **R5.2** The app never switches a request to another connection or key by
  itself. The person may choose another model.
- **R5.3** A temporary failure at OpenAI is retried with bounded backoff and
  the tokens are kept. A request OpenAI rejects as unsupported is reported
  with its diagnostic detail and not retried unchanged.

## Constraints

- **Local compositions only.** A runtime capability hides the feature in the
  hosted composition, and new routes are classified local (ADRs 0017 and 0021).
- **OpenAI's terms.** Follow the Sign in with ChatGPT terms (effective
  2026-11-04) and interface guidelines for open-source apps. Under them the
  plan serves only Animama's own features, so no endpoint relays plan-backed
  requests for other tools; using the plan costs the person nothing in
  Animama; and OpenAI may suspend an app's access. Verify the flow, request
  rules and terms against current official OpenAI documentation before
  implementation.
- **A preview.** The route accepts only streaming Responses requests that are
  not stored, and rejects several fields and tools the OpenAI key adapter
  sends today, including inline moderation, `previous_response_id` and
  `max_output_tokens`. If OpenAI withdraws the route, the connection is
  disabled with an explanation and other Model connections keep working.
- **Credential custody.** Tokens stay in the backend and its token file. The
  desktop main process holds only that file's key, and the page can read
  neither back. Backends receive credentials from the environment or the
  vault today, so a token file that the server renews is a new kind of
  storage.
- **Companion safety.** The Companion guardrail (ADR 0008) and the AI notice
  are unchanged on plan models. R3.4 is the only difference.
- **Model policy.** The plan connection is a composition input under the model
  catalog policy (ADR 0011). The hosted composition has none.
- **Privacy.** Requests go to OpenAI under the person's own account. The
  account's email is shown locally and sent nowhere else.
- **Licensing.** The sign-in is implemented from OpenAI's documentation.
  OpenAI's own kit is used only if its licence passes the repository's source
  review.
- **Schema and API.** A schema change needs a new Alembic revision with the
  ORM change (ADR 0035). API changes regenerate the frontend client through
  `pnpm openapi-ts`.
- **Records.** The change needs an ADR for sign-in credentials and the plan
  connection, and a glossary update: the Model connection entry describes
  key-based endpoints only.

## Acceptance criteria

- [ ] With an eligible account, sign-in completes in the desktop app and in a
  self-hosted stack opened on the same machine. The person stays signed in
  after a restart, and sign-out ends the session and removes the tokens.
- [ ] Tests show tokens in no database row, log, stream event, diagnostics
  output, browser storage or URL.
- [ ] Tests show the request built for a plan model: streaming, not stored,
  and carrying none of the fields or tools the route rejects.
- [ ] A manual check with a real plan model: an Anima replies with streaming,
  uses a memory tool, and gets a chat title. After agreement, automatic
  episode processing runs on the plan; without it, it does not. A Reflection
  runs either way.
- [ ] The plan indicator and **Manage usage** link show on a plan model and
  not on a key model.
- [ ] Tests with simulated OpenAI errors show that a declined or ineligible
  sign-in is explained without a loop, that a usage limit ends the turn with
  **Manage usage** and pauses plan requests, and that no request moves to
  another connection by itself.
- [ ] A plan model cannot be chosen for Embeddings, and speech settings are
  unchanged.
- [ ] A chat started on an OpenAI key model continues on a plan model and
  back.
- [ ] The hosted composition exposes neither the routes nor the interface.
- [ ] Backend tests, `pnpm verify` and the affected browser tests pass. The
  model settings, provider and chat safety documentation describe the
  behavior.

## Open questions and decisions

Agreed by the owner (2026-11-24):

1. **Its own spec.** The sign-in is specified here, apart from in-app content
   generation, which depends on it.
2. **Order.** The sign-in is delivered first and is usable by the content
   generation assistant; Anima chat, Utility and the Memory Manager follow.
3. **Direct sign-in.** Continue with ChatGPT, not Codex's app-server.
4. **Reach.** Local compositions only.
5. **Revisions with the ExecPlan.** Desktop tokens rest in a file encrypted
   with a vault-held key (R2.1). Agreement gates automatic episode processing
   only, and such a job waits rather than moving to another model (R4.1,
   R4.2). P3 and P5 below are read with these revisions.

Proposed by this draft and accepted by the owner on 2026-11-24:

- **P1** One active account per installation (R1.6).
- **P2** Sign-in only from a browser on the machine running Animama (R1.7).
  OpenAI's flow returns to a loopback address on that machine.
- **P3** A protected file for tokens in a self-hosted installation (R2.1).
- **P4** Plan turns have no moderation-triggered crisis card, as local
  Anthropic and Chat Completions turns have none today (R3.4).
- **P5** The Memory Manager and automatic episode processing are the
  background work that needs agreement. Chat titles and summarising a
  conversation that is too long arise from the person's own chat and need none
  (R4.1). OpenAI's terms require consent before background use.
- **P6** No automatic switch to another connection on a limit (R5.2).
- **P7** Chats continue across a move between key and plan models (R3.6).
- **P8** The sign-in is offered wherever the app asks for a model, including
  first-run setup (R1.1).

Open checks, each a bounded task that blocks the work named:

- **C1** A live trial with an eligible ChatGPT plan account, which is a
  prerequisite for this work: the sign-in callback in the desktop app and
  when the server runs in a container, tool calling and image input under the
  route's request rules, what the account's model list contains, and how long
  tokens last. Blocks everything.
- **C2** Which chat features the route accepts: web search, reasoning effort,
  prompt caching and server-side compaction. Blocks R3.3 and R3.5.
- **C3** Whether a chat can move between key and plan models when plan
  requests are not stored. Blocks R3.6; if it cannot, such chats are kept
  apart as Anthropic chats are.
- **C4** Whether the app's existing privacy notice covers plan use, which
  OpenAI's terms expect before processing. An owner check.

## Spec

This issue.

## ExecPlan

Approved by the owner on 2026-11-24. Tracked as
`docs/plans/chatgpt-plan/chatgpt-plan-execplan.md` on branch
`feat/chatgpt-plan`; it is linked here at its reviewed revision once the
branch is pushed.

## Delivery links

To be added as phases complete.
