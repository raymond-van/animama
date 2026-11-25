# Contributing

Animama has one maintainer, Raymond Van. Bug reports, feature ideas and pull
requests are welcome. Reviews are best effort, so a reply can take a while.

## Report a bug or suggest a feature

Open an issue with the [bug report](https://github.com/raymond-van/animama/issues/new?template=bug.yml)
or [feature request](https://github.com/raymond-van/animama/issues/new?template=feature.yml)
form. Search existing issues first. Report security problems privately, as the
[security policy](https://github.com/raymond-van/animama/security/policy)
describes, never in a public issue or pull request.

Questions and conversation belong in the
[Discord](https://discord.gg/pUHHRrZ2xg).

## Pull requests

### Before you start

- A small change, such as a bug fix, a documentation correction or a
  translation fix, can go straight to a pull request.
- Anything larger starts as an issue: a new feature, a new dependency, a
  change to the API or the database schema, or a refactor. Wait until the
  maintainer agrees with the approach before you write code. A large pull
  request that arrives unannounced is likely to be declined.
- Issues labelled
  [good first issue](https://github.com/raymond-van/animama/labels/good%20first%20issue)
  or [help wanted](https://github.com/raymond-van/animama/labels/help%20wanted)
  are open for anyone. Comment on the issue before you start, so two people
  don't do the same work.

### What helps most

- Bug fixes that come with steps to reproduce the problem.
- Translation corrections from fluent speakers, in the app or the READMEs.
- Fixes for VRM avatars that load or animate incorrectly. Say which avatar
  shows the problem and where it comes from.
- Fixes for local model servers (Ollama, LM Studio, llama.cpp and vLLM),
  which are still experimental.
- Corrections to the documentation in this repository.

Two kinds of change are declined whatever their quality: anything that adds
accounts or sign-in to the local app, and avatars, animations, sounds or
artwork whose licence does not allow redistribution.

### Contributor agreement

A pull request asks you to agree to the
[Contributor Licence Agreement](CLA.md) by ticking a box in its description.
You keep the copyright in your work. The agreement licenses it to the
maintainer, including the right to offer it under terms other than the AGPL:
Animama is also offered as a hosted service that combines this source with
private code, and holding the rights to the whole source keeps that possible.
A pull request cannot be merged without the agreement. If you would rather not
agree, describe your fix in an issue instead.

### Make the change

1. Fork the repository and branch from `main`. Name the branch
   `<type>/<short-kebab-case-task>`, for example `fix/chat-reconnect`;
   [names and labels](../SDLC.md#names-and-labels) lists the types.
2. Set up a local stack as the [README](../README.md#self-host) and
   [development and operations](../docs/backend/operations/development.md)
   describe.
3. Keep the pull request to one purpose and follow the code around your
   change. [AGENTS.md](../AGENTS.md) holds the code quality rules and the
   ownership boundaries, and links the backend and frontend guides. For
   example, generated API clients and merged database migrations are never
   edited by hand.
4. Add or update tests for the behavior you change, and update documentation
   that your change would leave wrong.
5. When you add, move or delete a file, update its entry in
   `licenses/source-review.json` and run
   `python3 scripts/public-release/check_source.py`. For a file you add or
   substantially rewrite, name yourself in the entry as
   [Source licensing review](../licenses/README.md) describes. If any of the
   material is not your own work, record its source and licence there and say
   so in the pull request.
6. Keep credentials, API keys, personal data and real conversations out of
   code, tests, logs and screenshots.

### Check your change

Hosted CI runs on your pull request after the maintainer approves each run,
which can take a while. Run the checks for the area you touched yourself, and
paste the commands and their results into the pull request:

- Backend, from the repository root: `uv run ruff check` and
  `uv run pytest -q`.
- Frontend, from `src/frontend`: `pnpm verify`.
- Documentation only: `git diff --check`.

[AGENTS.md](../AGENTS.md#verification) lists the full set. Say which checks
you could not run. For a change that people see or hear, such as the UI, an
avatar, voice or the desktop app, add a screenshot or a short recording.

### Open the pull request

- Title it `<type>: <summary>`, for example
  `fix: restore chat after reconnect`. Write commit subjects as
  `<type>(<scope>): <summary>`, for example
  `fix(chat): restore chat after reconnect`.
- Fill in the template's Summary, Related work, Local validation, UI evidence,
  Risks and limitations, and Contributor agreement sections. Write "Not
  applicable" under the others unless the maintainer asked for them; they
  record the maintainer's own planning and review.
- Leave "Allow edits by maintainers" ticked, so small fixes can be pushed to
  your branch.

### Review and merge

Animama is built with AI coding agents under the maintainer's direction, as
[How Animama is built](../docs/agents/README.md) describes, so an agent may
make the first review pass. The maintainer makes every merge decision. Expect
requests for changes, and sometimes a decline: a good change can still be
outside what the project wants to carry. Accepted pull requests are merged
with a merge commit.

### AI-assisted contributions

AI-assisted work is welcome. You are responsible for it: read and understand
what you submit, test it, and make sure the agreement's confirmations hold for
it. Commits on `main` carry no tool attribution, so leave those trailers out
of commit messages and describe the AI involvement in the pull request
instead.

## Working on your own copy

The source is licensed AGPL-3.0-only, so you are free to study, change and run
it under that licence. A modified build that you distribute or host must use
its own name and infrastructure; see [Name and logo](../docs/trademarks.md).

- [README](../README.md#self-host) and
  [development and operations](../docs/backend/operations/development.md):
  setting up and running a local stack.
- [How Animama is built](../docs/agents/README.md): the development lifecycle,
  and where specs, plans and decision records live.
- [AGENTS.md](../AGENTS.md): the guide AI coding agents read first; it also
  lists the checks.
- `python3 scripts/public-release/check_source.py`: every tracked file needs a
  licence-review entry; see [Source licensing review](../licenses/README.md).

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
