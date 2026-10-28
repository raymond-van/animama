# Model benchmark

The model benchmark scores the app's chat models in the conditions chat really
uses: chat's own turn executor, prompt assembly, reply schema and memory tools,
with a blind judge for the measures a program cannot check. It informs two
decisions: the default chat model, and how episodic memory should be saved.
The agreed requirements are in [issue #470](https://github.com/raymond-van/animama/issues/470);
the [`animama-model-benchmark` skill](../../.agents/skills/animama-model-benchmark/SKILL.md)
runs the whole flow, and every step below is also a command you can run
yourself.

A **benchmark run** is one approved execution over a fixed set of
configurations (a catalog row at a reasoning effort) and one prompt-set
version. It covers four **benchmark areas**: core turns, long chats, in-chat
memory with the episodic-memory arms, and the Memory Manager.

## Commands

Every command is `python -m scripts.evals.benchmark <command>` from the
repository root.

| Command | Where | What it does |
| --- | --- | --- |
| `plan` | anywhere; the backend container for rows that are not built in | The dry run: planned calls, tokens, cost and wall time, judging included, against the 4-hour bound. No model calls. |
| `run` | the backend container of a task stack | Runs the configurations and writes `turns.jsonl` and `manifest.json` to `--output-dir`. Needs `--max-calls` and `--max-usd`, the owner's caps. |
| `judge` | the host, signed in to Claude | Judges the run blind at one `--effort`; rerun it to resume. |
| `calibrate export` / `import` / `pilot` / `waive` | the host | The one-time calibration against the owner's ratings, or the owner's waiver of it. |
| `report` | anywhere | Renders the public-safe report from the recorded results. |
| `models` | the backend container | Lists the catalog's active chat rows. |
| `cleanup` | the backend container | Drops benchmark databases a killed run left behind. |

A free rehearsal runs everything against chat's mock model: add
`-e ANIMAMA_LLM_SKIP=1` after `docker compose exec`, and judge with the
stand-in `--claude scripts/evals/benchmark/stub_claude.py`. A paid run starts
only after the owner approves its `plan` output and caps; `--max-usd` refuses a
call once the spend so far plus the largest call so far would pass it, so the
spend can pass the cap by at most one call's growth. Turns that failed on a
connection error can run again with `run --retry-from <run>` and the run's own
options and caps: a new run copies the other records and reruns each failed
unit whole, and its report says so. Its fresh budget can pass what is left of
`--max-usd` by up to one call's whole cost. Raw results hold replies
and saved memory; keep them under the git-ignored
`.animama-drafts/model-benchmark/`.

```bash
source .animama-stack.env
docker compose -p "$COMPOSE_PROJECT_NAME" exec animama-server \
  python -m scripts.evals.benchmark plan --prompts docs/benchmarks/inputs/prompts.json --standard
```

`--standard` takes every visible built-in chat row at efforts none and low;
`--config <row id>@<effort>` names others, and `plan` then reads the stack's
catalog for any row that is not built in. `--tier smoke` takes the tracked
smoke subset.

## Inputs

[`inputs/`](inputs/) holds the tracked, owner-approved inputs:

- `prompts.json`: the prompt set (format v1, documented in
  [`prompt_set.py`](../../scripts/evals/benchmark/prompt_set.py)): personas,
  single-turn items with their acceptable Gestures, intended intensity band
  and fitting tones, scripted chats, memory fixtures, memory chats with
  checklists and recall probes, and Memory Manager runs. Files it names are
  pinned by sha256.
- `loadout-starter-v1.json`: the equipped Gestures every turn sees.
- `episodic-guidance.md`: the candidate `MEMORIES.md` guidance for memory arm (b).
- `rubrics.json`: the judge's rubrics, with 1–5 anchors and an example for each.

Any change to these makes a new prompt-set version; a changed rubric or judge
starts a new results series, so reports from different series are not
compared as like for like. Japanese items are agent translations, each paired
with its English original by `pair_id`. About a fifth of the items are
**held out**: nobody tunes prompts, Gesture descriptions, guidance or rubrics
against them, and the report shows them apart.

## Memory arms

Each configuration runs the memory chats in three arms, which decide how
episodic memory is saved:

| Arm | `remember` note | `MEMORIES.md` writes |
| --- | --- | --- |
| (a) `remember` only | Yes | No (read-only) |
| (b) `MEMORIES.md` only | No | Yes, with the candidate guidance |
| (c) both (the current app) | Yes | Yes |

Shared files such as `PROFILE.md`, and memory reads, are the same in every
arm. The arms are benchmark-only seams in chat (see
[Memory Manager and episodic memory](../backend/features/memory-manager-and-episodic-memory.md#benchmark-memory-arms));
production never sets them.

Memory work runs on a disposable PostgreSQL database,
`animama_benchmark_<run>_<time>_<random>`, created next to the application
database and dropped when the run ends; the application database is only read
for the model catalog. Run `cleanup` **between runs, not during one**: a
`cleanup` that lands while a run starts can drop its database, and one during
a run slows its turns.

## Judge

The judge is Claude Fable 5.1 (`claude-fable-5-1`) through the Claude CLI on the
owner's subscription, never an API key. Sign in once with `claude` on the host, and keep no user `~/.claude/CLAUDE.md`
while judging: the CLI would load it into every call, so judging refuses to
start.
Each call runs from an empty directory in restricted mode with no tools except
structured output, no MCP servers, skills or settings, and only a short list of
environment variables; a call that loads anything else, or is not signed in
through the subscription, stops judging.

Items are shuffled across configurations, arms and languages, under opaque
ids; nothing sent names a model, configuration, effort, arm or language.
Memory edits reach the judge as diffs of the stored files, so every provider's
tools read alike. Output that does not match the rubric's schema is retried
twice, then recorded as missing. A usage limit stops judging cleanly; run the
same command later to continue.

The judge shares a model family with Claude Haiku, a contestant, which the
owner accepted. Calibration checks it: on the first run, `calibrate export`
samples up to 36 English `reply` and `expression` items, the owner rates them
in `calibration/sheet.md` and `ratings.json`, `calibrate import` checks the
ratings, and `calibrate pilot` judges the sample at medium and high and pins
the effort that agrees better with the owner (medium on a tie). Later runs
reuse the pinned effort. When the owner waives calibration,
`calibrate waive --effort <effort>` records that and the effort they chose,
and the report says the judge's scores are unchecked. A waiver covers its own
run only: the next run of that prompt-set version still needs a calibration.

## Conditions and time

Run from a development task stack built from the checkout. Contestant calls run
one at a time, interleaved by configuration, after one discarded warm-up each.
`plan` estimates the wall time from calls and judge batches; a run over 4 hours
starts only with `--over-time-approved`, the owner's exception. Latency compares
only within one run.

## Reading a report

`report --run-dir <run> --prompts docs/benchmarks/inputs/prompts.json` writes
`report.md`. The owner's recommendations go in a Markdown file passed with
`--recommendations`; later `report` and `report --rerender` runs pass the same
file, and `--rerender` checks the report rebuilds byte for byte.
Owner-approved reports are tracked in this folder as `<YYYY-MM-DD>-<slug>.md`;
raw results stay in `.animama-drafts/`. The first is the
[2026-10-26 decision run](2026-10-26-first-decision-run.md).

- Judged scores are means on the 1–5 scale with a 95% bootstrap interval and
  the number of judged replies. Rates give their counts.
- Configurations are ranked only when their intervals are apart and each rests
  on at least five items or conversations; otherwise the report says they are
  not distinguishable or too few to compare.
- Expression is also measured without the judge: core turns by the Reaction
  intensity their intensity plays (1–2 none, 3–4 Mild, 5–6 Moderate, 7–8
  Strong, 9–10 Intense); single-turn replies inside, below or above the item's
  intended band and with a fitting tone; and, for each `audio-tag:<kind>`
  item kind, the replies carrying the tag it invites (any laugh for
  `laughs`; no tag at all for `none`).
- Missing judge scores, failed turns and unpriced costs are counted, never
  filled in. A run that stopped early is marked partial.
- The report holds ids, labels, counts and scores only; it refuses to write if
  any reply, saved memory or prompt text would appear in it.

## Limitations

- Memory turns and OpenAI Memory Manager runs keep the provider's real storage.
- PostgreSQL's english text search does not split Japanese into words, so
  Japanese episode notes are found only by their exact text.
- In arm (a) the memory tools still describe `MEMORIES.md` edits, which they
  then refuse.
- The Memory Manager runs once per catalog row at its own effort, since its
  runtimes take no chat effort.
- Calibration covers the `reply` and `expression` rubrics; the others are
  judged by the judge alone. A run whose calibration was waived checks none.
