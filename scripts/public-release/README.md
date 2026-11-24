# Check the source licence review

This repository is published as it is, with its history. Every tracked file
needs exactly one entry in [`licenses/source-review.json`](../../licenses/source-review.json),
which records the file's licence, its basis and, for third-party material, its
source and notices. See [Source licensing review](../../licenses/README.md) for
what the entries mean.

Check the review from the repository root with Python 3.11 or newer:

```bash
python3 scripts/public-release/check_source.py
```

It reads `git ls-files`, so stage new files first. It fails, listing each path,
when a tracked file has no entry, an entry lacks its path, licence, basis,
copyright or review, an entry names a file that is no longer tracked, a path
has two entries, a licence is still marked pending, or a tracked path is
private installation state or tooling output: `data/`, `cache/`, `backups/`,
`.animama/`, `.animama-stacks/`, `node_modules/`, `.venv/`, `.codex/`, `.env`
files other than `.env.example`, or Local content. When you add, move
or delete files, update their entries in the same change: a new original file
takes the original-work attestation entry its neighbours use, a file from an
outside contributor names them as
[Source licensing review](../../licenses/README.md) describes, and third-party
material records its upstream licence, source and notice.

A passing check is not publication approval. Recording a licence does not grant
redistribution permission that the upstream terms do not give.

Tests use disposable Git fixtures:

```bash
python3 -m unittest discover -s scripts/public-release -p 'test_*.py'
```
