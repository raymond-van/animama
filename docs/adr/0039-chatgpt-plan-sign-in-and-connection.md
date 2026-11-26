# 0039: A ChatGPT plan sign-in is a model connection's credential

- Status: accepted (owner, 2026-11-24)
- Recorded: 2026-11-24
- Retrospective: no
- Original decision date: 2026-11-24 (owner acceptance of the specification and
  of the execution plan, including D1 to D14, in
  [issue #919](https://github.com/raymond-van/animama/issues/919))
- Decision basis: Explicit owner decision, recorded in #919 and its
  [specification snapshot](../plans/chatgpt-plan/chatgpt-plan-spec.md);
  implementation choices in the
  [execution plan](../plans/chatgpt-plan/chatgpt-plan-execplan.md) Decision Log

## Context

Before this decision every cloud model needed an API key. Many people who would
use Animama already pay for a ChatGPT plan, and OpenAI's Sign in with ChatGPT
lets an open-source app send that account's eligible requests through the plan,
at no charge from the app. The credential is an OAuth sign-in, not a key:
tokens are short-lived, a rotating refresh token renews them, and the person
signs in at OpenAI in their own browser, which must come back to the app.

The plan's route also differs from the API on a key. OpenAI documents it as
taking only streamed, unstored Responses requests, without
`previous_response_id`, inline moderation or output limits, and as refusing
system-role input items. A live trial (the execution plan's Phase 0,
2026-11-24) confirmed the system-role refusal and found that the route also
refuses the hosted `apply_patch` tool, embeddings and moderations, that it
admits a server compaction setting without showing that compaction works,
and that the models it serves are listed per account.

## Decision

1. **The backend owns the sign-in in both runtimes.** One Python implementation
   registers the installation, exchanges the code with PKCE, validates the ID
   token, refreshes and revokes. Electron main only opens the browser, as for
   any link. The feature exists only in local compositions; the hosted
   composition reports no `chatgpt_plan` capability.
2. **The sign-in return has its own admission rule.** OpenAI sends the browser
   to `http://127.0.0.1:<port>/auth/callback`. Exactly that `GET`, on a
   loopback `http` installation origin, with that `Host`, no `Origin`, no body
   and navigation fetch metadata when present, is admitted without the normal
   local checks; anything else gets them. Sign-in is offered only where the
   origin is such a loopback origin, since only then can the return reach the
   backend.
3. **Desktop keeps the session in a file encrypted under a vault key.** The
   desktop vault gains one generated key; the backend writes the session as
   AES-256-GCM ciphertext in its data directory. Self-hosting uses an
   owner-only plain file. Copying every refreshed token set into the vault
   instead would need a new channel from the backend to Electron main and
   could lose the session between OpenAI's answer and the vault write.
4. **The plan is a built-in model connection with its own provider type.**
   `chatgpt_plan` joins the built-in connections, and its models use
   `ChatGPTPlanResponsesHTTPAgent`, which shares the Responses transcript
   standard so a chat moves between key and plan models. One Responses client
   serves both through a route profile that says what each endpoint accepts.
5. **The account's models are read-only built-in rows.** Sign-in and refresh
   store one row per model OpenAI lists for the account; a person may only hide
   or show one. The seed leaves them alone, and signing out retires them. While
   the session needs a new sign-in or plan use is off, the rows stay listed and
   requests on them fail with that reason.
6. **Agreement gates work that starts by itself.** Automatic episode
   processing uses the plan only with the person's recorded agreement and not
   while a usage limit pauses it; every request names its purpose and the
   session refuses a background token otherwise. Chats, their titles and
   compaction, Reflections and Memory Manager runs the person starts are their
   own requests and need none.
7. **A role whose plan model may not run waits.** It never moves to another
   connection or key: not when the plan is paused or lacks agreement, and not
   when signing out or OpenAI no longer listing a model retires the row.
8. **Agreement and the one-time confirmation live with the session**, not in
   shared preferences, so they stay local, follow the account and are asked
   again after a different account signs in.

## Alternatives

- **Sign-in in Electron main.** Rejected: it would need a second
  implementation for self-hosting and a channel to hand tokens to the backend.
- **Tokens in the desktop vault.** Rejected for the reasons in decision 3.
- **Plan models as rows of the built-in OpenAI connection.** Rejected: the
  cursor, inline moderation, native compaction and hosted tools are keyed by
  provider type, so a separate type avoids each without a connection check in
  every place.
- **Falling back to another model when the plan cannot serve.** Rejected: it
  would move spend to another connection or key without the person's choice.
- **Admitting the return through the normal local checks.** Not possible: the
  browser's navigation back from OpenAI carries no local credential.

## Consequences

- People can use Animama's cloud features without an API key, within their
  plan's limits; a limit ends the turn with a **Manage usage** link and pauses
  background use until one of their own requests succeeds.
- The plan's route rules are enforced in the request builders (chat, Utility
  and the Memory Manager's client for the Agents SDK). A chat or Memory
  Manager run continues across key and plan models by replaying history: a
  plan step stores nothing at OpenAI and keeps no cursor.
- Plan models do not get inline moderation, so plan turns show no
  moderation-triggered crisis card; the companion guardrail still applies, as
  on Anthropic and Chat Completions turns.
- OpenAI's route is a preview. Whether it accepts a replayed reasoning item is
  unconfirmed, so reasoning replay is built behind a route-profile switch that
  ships off.
- Backups and restores skip the session directory, so a restored profile signs
  in again.

## Evidence

- [Specification #919](https://github.com/raymond-van/animama/issues/919) and
  its [snapshot](../plans/chatgpt-plan/chatgpt-plan-spec.md): the requirements
  and the owner's acceptance.
- [Execution plan](../plans/chatgpt-plan/chatgpt-plan-execplan.md): the threat
  model, the live trial's findings, the Decision Log and each phase's reviews.
