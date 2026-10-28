# Inputs and memory arms

The tracked inputs live in `docs/benchmarks/inputs/` and were approved by the
owner (gate G2). The format is documented in the docstring of
`scripts/evals/benchmark/prompt_set.py`; `load_prompt_set` rejects unknown
keys, unknown personas, fixtures or Gestures, unsorted loadouts, Japanese
entries without an English `pair_id`, and files whose sha256 changed.

## Changing the set

Change inputs only when the owner asks, never to improve a result.

- Any change to items, fixtures, checklists, guidance, acceptable lists,
  intensity bands, tones or rubrics needs a new `version`, and the owner's approval before a run uses it.
- Update the pinned `sha256` of a changed file in `prompts.json`.
- Held-out entries (`held_out: true`, about a fifth of each area) are never
  used to tune prompts, Gesture descriptions, guidance or rubrics. Do not look
  at their results while changing any of these.
- A Japanese entry pairs with its English original through `pair_id`; keep the
  pair's held-out flag the same.
- Run `uv run --no-sync pytest -q tests/test_model_benchmark_inputs.py` and the
  full-tier `plan` after any change; the full tier must stay within 4 hours.

## Memory arms

Each configuration runs every memory chat in three arms
(`scripts/evals/benchmark/memory_runner.py`):

| Arm | Label in records | `remember` | `MEMORIES.md` writes |
| --- | --- | --- | --- |
| (a) | `remember_only` | Yes | Read-only |
| (b) | `memories_md_only` | Removed from the schema and guidance | Yes, with `episodic-guidance.md` |
| (c) | `both` | Yes | Yes (the current app) |

The arms reach chat only through `EpisodicMemoryArm`
(`src/backend/animama/app/chat/memory_arm.py`), passed to the executor's
constructor; production never sets it. Each configuration, arm and chat gets
its own owner and Anima in the run's disposable database, seeded from the
chat's fixture. After the chat, a `capture` record snapshots what was saved;
a fresh recall chat then asks the probes. Each memory turn records its tool
calls (from chat's own persisted rows) and `memory_changes`, the diff of the
stored files before and after it.

The Memory Manager runs each fixture once per catalog row at its runtime's
own effort (D16), with every proposal approved inside the run's database.
