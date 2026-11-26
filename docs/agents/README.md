# How Animama is built

Animama has one maintainer, Raymond Van, who builds it with AI coding agents
(OpenAI Codex and Anthropic Claude Code). Raymond decides what to build, agrees
each specification and plan, makes the consequential choices and approves
every merge. The agents investigate, implement, test and review the agreed
work, and record evidence that a reader can check. This page shows where each
part of that lifecycle lives; [SDLC.md](../../SDLC.md) is the full definition.

## The lifecycle

| Step | Who | Defined in | Skill |
| --- | --- | --- | --- |
| Clarify a raw idea | Raymond, interviewed by an agent | [SDLC.md](../../SDLC.md#delivery-workflow) | `intent-discovery` |
| Specify behaviour and acceptance | An agent drafts, Raymond agrees | [SPECS.md](../../SPECS.md) | `to-spec` |
| Plan substantial or risky work | An agent drafts, Raymond approves | [PLANS.md](../../PLANS.md) | `to-execplan` |
| Prepare the issue, branch and worktree | Agent | [AGENTS.md](../../AGENTS.md#workspace-selection) | `workspace-setup` |
| Implement each phase, test first | Agent | [SDLC.md](../../SDLC.md#delivery-workflow) | `implement`, `tdd` |
| Review each phase | A separate, read-only reviewer agent | [Bounded code review](../../SDLC.md#bounded-code-review) | `code-review` |
| Open the PR with its evidence | Agent | [PR template](../../.github/pull_request_template.md) | `git-workflow` |
| Approve and merge the exact candidate | Raymond | [CI and merge evidence](../../SDLC.md#ci-and-merge-evidence) | `merge-n-clean` |

Routine changes skip the specification and plan: an issue with acceptance
criteria and a brief approach is enough. Substantial, uncertain or risky work
gets an ExecPlan, judged by risk and uncertainty rather than size.

## What keeps the work honest

- **Written intent before code.** The specification and plan say what "done"
  means in observable terms, so review checks behaviour against agreed
  acceptance rather than against the implementer's own account.
- **Bounded, recorded review.** Each reviewed phase gets one full review by an
  independent reviewer ([sdlc-reviewer](../../.claude/agents/sdlc-reviewer.md)
  in Claude Code) and at most two repair rounds; a light phase may instead be
  covered by the final integration review of the whole plan. Findings, dispositions and
  fixes are written into the plan, and a blocker left at the limit stops the
  work instead of being re-reviewed until it passes.
- **Check records bound to Git trees.** Each check records its command, result
  and the exact tree it ran on, so a reviewer can reuse it or see that it is
  stale.
- **Local-first validation.** Checks run locally before a push, the heavy ones
  through machine-wide job slots (`scripts/heavy-slot.py`) that stop parallel
  agent sessions competing for the same cores. A PR says which checks ran,
  locally or in CI, and which did not.
- **Owner-only decisions stay with the owner.** Licences, product intent, scope
  changes, merges, releases, publication and repository settings need
  Raymond's explicit decision; a passing check or an agent's review never
  stands in for it.
- **Shared language.** The [glossary](../../GLOSSARY.md) fixes what domain terms
  mean in conversation, specifications, code and review; the
  [ADRs](../adr/README.md) record why significant choices were made.

## Where to look

- [AGENTS.md](../../AGENTS.md): the entry point every agent reads first, with
  scoped guides for the [backend](../../src/backend/AGENTS.md) and
  [frontend](../../src/frontend/AGENTS.md).
- [SDLC.md](../../SDLC.md): the lifecycle, review tiers and merge rules.
- [SPECS.md](../../SPECS.md) and [PLANS.md](../../PLANS.md): how
  specifications and ExecPlans are written.
- [docs/plans/](../plans/): the specifications and ExecPlans for each
  substantial change, with their phases, decisions, review findings and
  validation evidence.
- [docs/adr/](../adr/README.md): the architecture decision records.
- [.agents/skills/](../../.agents/skills/): the lifecycle skills above, plus
  domain skills for avatar animation, effects, VRM models, UI and local stacks.
  Each skill is a `SKILL.md` that both tools read; most also have an
  `agents/openai.yaml` with Codex display settings, and Claude Code finds the
  skills through `.claude/skills`, a link to this folder.
- [.claude/](../../.claude/): Claude Code's reviewer agent, a hook that
  formats edited files, a session-start hook that installs dependencies in
  cloud sessions, a permission list of read-only checks, and settings that
  keep tool attribution out of commits.

## A worked example

[Episode recall and processing](../plans/episode-recall-and-processing/episode-recall-and-processing-execplan.md)
shows the whole loop: an agreed specification with numbered requirements,
five phases with review tiers, the owner's plan-review decisions, review
rounds with stable finding IDs and their dispositions, a repair that was
reverted rather than spending a third round, and the final suite results.

## Authorship and AI involvement

Raymond is the author and copyright holder of Animama's original work, apart
from outside contributions. Outside contributors keep the copyright in what they contribute and license it under
the [Contributor Licence Agreement](../../.github/CLA.md).
Agents wrote much of the code and some of the artwork under Raymond's direction.
Commits on `main` carry no tool attribution, so the AI involvement is recorded
where the work is described: in the plans and issues, in the owner attestation
of the [source licence review](../../licenses/README.md) for the work as a
whole, and file by file for AI-generated artwork and content. The same review
lists every third-party exception.
