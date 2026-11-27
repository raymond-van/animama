# 0037: Outside contributions are accepted under a contributor licence agreement

- Status: accepted (owner, 2026-11-24)
- Recorded: 2026-11-24
- Retrospective: no
- Original decision date: 2026-11-24 (owner decision, tracked in
  [#911](https://github.com/raymond-van/animama/issues/911))
- Decision basis: Explicit owner decision
- Amended: 2026-11-25, hosted validation runs on outside pull requests, each
  run after the owner's approval; the owner re-enabled it after the failures
  tracked in [#907](https://github.com/raymond-van/animama/issues/907) were
  fixed.

## Context

When the repository was prepared for publication, the owner chose
AGPL-3.0-only and decided that issues were welcome but outside pull requests
were not, for the time being. That kept the owner the sole copyright holder
and free to relicense, and left a DCO or CLA to be added later (decision D1 of
the [open-source readiness plan](../plans/open-source-readiness/open-source-readiness-execplan.md#decision-log),
2026-11-02).

The repository became public on 2026-11-18. People outside the project now
report bugs and fork the source, and a fix described in an issue has to be
rewritten by the maintainer before it can land.

The licensing constraint has not changed. Animama is also offered as a hosted
service that combines this source with private code
([Repository boundaries](../architecture/repository-boundaries.md)). The owner
can do that, and can change the public licence, only while holding the rights
to every part of the source.

## Decision

1. **Outside pull requests are accepted.** Small fixes go straight to a pull
   request. Larger changes start as an issue that the maintainer has agreed
   to.
2. **Every outside contributor agrees to the
   [Contributor Licence Agreement](../../.github/CLA.md).** It is a licence,
   not an assignment: the contributor keeps their copyright and grants the
   maintainer a broad copyright and patent licence, including the right to
   license the contribution under other terms.
3. **Agreement is a ticked box in the pull request description.** It covers
   that pull request and the contributor's later ones. The maintainer checks
   it before merging.
4. **Hosted validation runs on outside pull requests, and each run waits for
   the maintainer's approval in GitHub.** Contributors still
   report the local checks they ran, and the maintainer validates the exact
   head commit before merging. Until the 2026-11-25 amendment, hosted
   validation stayed off for pull requests.

## Rationale and consequences

Alternatives considered:

- **Developer Certificate of Origin.** A `Signed-off-by` line states where a
  contribution came from, but the contribution arrives under AGPL-3.0-only and
  nothing more. The maintainer could not relicense it or combine it with
  private code without the AGPL applying to the result.
- **No agreement.** GitHub's terms make a contribution inbound under the
  repository's licence. That has the same limit as the DCO, without the
  contributor's statement that the work is theirs to give.
- **Copyright assignment.** It gives the maintainer more than the project
  needs and asks more of contributors than a licence does.
- **A CLA bot.** It needs a third-party app with repository access, or a
  workflow that runs with a write token on fork pull requests. The expected
  volume does not justify either yet.

Consequences:

- After the first outside contribution merges, Raymond is no longer the sole
  copyright holder. Relicensing then rests on the agreement's grant, so a pull
  request without the ticked box cannot be merged.
- A file that an outside contributor adds or substantially rewrites lists them
  among its copyright holders in the
  [licence record](../../licenses/README.md).
- The agreement was written without a lawyer's review. A later review may
  revise it; a revision applies only to contributions made after a
  contributor agrees to it.
- An outside change is untrusted input until it has been read, and approving
  its hosted run runs its code. [Outside contributions](../../SDLC.md#outside-contributions)
  describes how the maintainer handles one.

## Evidence

- [CONTRIBUTING](../../.github/CONTRIBUTING.md): what contributors are asked
  to do.
- [Contributor Licence Agreement](../../.github/CLA.md): the terms.
- [Pull request template](../../.github/pull_request_template.md): the
  agreement box.
- [SDLC: outside contributions](../../SDLC.md#outside-contributions): the
  maintainer's checks before merging.
