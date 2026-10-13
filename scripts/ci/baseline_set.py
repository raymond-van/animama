#!/usr/bin/env python3
"""Compare the candidate package set with its baseline's retained validated set.

A full run of the baseline commit on `main` (or the PR run that a `reused` main
receipt names) already uploaded a verified set for the same tree. When its
producer code matches the candidate's, `build.py compare` reaches the same
verdict as against a rebuild, so the rebuild is skipped. Any missing, expired,
mismatched or unverifiable evidence falls back to today's rebuild.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from github_evidence import _get_json, _number, _repository, _sha
from hosted_evidence import WORKFLOW_PATH, _download, _open_artifact, _receipt, _require

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "scripts/package-sets/build.py"
MAX_SET_BYTES = 2 * 1024 * 1024 * 1024
MAIN_EVENTS = {"push", "workflow_dispatch", "schedule"}
# Contract files are the compared inputs, not the producer: a candidate that
# changes them still compares against the baseline's own contracts.
CONTRACT_RECIPE = re.compile(r"contracts/.+")


def _artifact(prefix: str, artifact_id: object, run_id: int, name: str, fetch) -> dict:
    _require(_number(artifact_id), "Malformed set artifact identity")
    artifact = fetch(f"{prefix}/actions/artifacts/{artifact_id}")
    _require(
        artifact["id"] == artifact_id
        and artifact["name"] == name
        and artifact["expired"] is False
        and 0 < artifact["size_in_bytes"] <= MAX_SET_BYTES
        and artifact["workflow_run"]["id"] == run_id
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"]),
        "Retained set artifact unavailable or mismatched",
    )
    return artifact


def find(baseline: str, baseline_tree: str, *, fetch=_get_json, download=_download) -> dict:
    """Locate a verified set for the baseline tree from a successful main run."""
    repository, _ = _repository()
    prefix = f"/repos/{repository}"
    _require(_sha(baseline) and _sha(baseline_tree), "Invalid baseline identity")
    response = fetch(
        f"{prefix}/actions/workflows/validate-public.yml/runs?head_sha={baseline}&status=success&per_page=100&page=1"
    )
    runs = [
        run
        for run in response["workflow_runs"]
        if run["event"] in MAIN_EVENTS
        and run["head_branch"] == "main"
        and run["head_sha"] == baseline
        and run["path"] == WORKFLOW_PATH
        and run["repository"]["full_name"] == repository
        and run["conclusion"] == "success"
    ]
    for run in sorted(runs, key=lambda item: item["id"], reverse=True)[:5]:
        try:
            listing = fetch(f"{prefix}/actions/runs/{run['id']}/artifacts?per_page=100&page=1")
            _require(listing["total_count"] == len(listing["artifacts"]) < 100, "Incomplete artifact discovery")
            by_name = {artifact["name"]: artifact for artifact in listing["artifacts"]}
            attempt = run["run_attempt"]
            receipt_artifact = by_name[f"validation-receipt-{baseline}-{attempt}"]
            _require(receipt_artifact["workflow_run"]["id"] == run["id"], "Receipt provenance mismatch")
            receipt = _receipt(download(repository, receipt_artifact["id"]), receipt_artifact, {"full", "reused"})
            selection = receipt["selection"]
            _require(
                selection["source_commit"] == baseline
                and selection["source_tree"] == baseline_tree
                and selection["event"] == run["event"]
                and selection["run_id"] == str(run["id"]),
                "Receipt does not describe the baseline run",
            )
            if selection["plan"]["mode"] == "full":
                name = f"animama-set-{baseline}-{attempt}"
                artifact = _artifact(prefix, by_name.get(name, {}).get("id"), run["id"], name, fetch)
                return {"run_id": run["id"], "artifact": artifact, "source_commit": baseline}
            # A reused main run names the promotion-complete PR set for the same tree.
            named = selection["hosted_evidence"]["package_set"]
            _require(named["source"]["tree"] == baseline_tree, "Named set describes another tree")
            artifact = _artifact(
                prefix,
                named["artifact_id"],
                selection["hosted_evidence"]["run_id"],
                named["artifact_name"],
                fetch,
            )
            _require(artifact["digest"] == named["artifact_digest"], "Named set digest mismatch")
            return {
                "run_id": selection["hosted_evidence"]["run_id"],
                "artifact": artifact,
                "source_commit": named["source"]["commit"],
            }
        except Exception:  # noqa: BLE001 - try the next run; transport text may contain signed URLs.
            continue
    raise ValueError("No retained validated set for the baseline")


def fetch_set(repository: str, artifact: dict, destination: Path) -> None:
    """Stream, digest-check and safely extract one set artifact."""
    archive = destination.with_suffix(".zip")
    try:
        _extract(repository, artifact, archive, destination)
    finally:
        # Free the runner's disk before any rebuild.
        archive.unlink(missing_ok=True)


def _extract(repository: str, artifact: dict, archive: Path, destination: Path) -> None:
    digest = hashlib.sha256()
    size = 0
    with _open_artifact(repository, artifact["id"]) as response, archive.open("wb") as target:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            _require(size <= MAX_SET_BYTES, "Set artifact exceeds size bound")
            digest.update(chunk)
            target.write(chunk)
    _require(artifact["digest"] == "sha256:" + digest.hexdigest(), "Set artifact digest mismatch")
    destination.mkdir(parents=True)
    with zipfile.ZipFile(archive) as files:
        for member in files.infolist():
            name = member.filename
            _require(
                re.fullmatch(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*/?", name) is not None
                and ".." not in name.split("/")
                and (member.external_attr >> 16) & 0o170000 in (0, 0o100000, 0o040000),
                "Unsafe set artifact member",
            )
        _require(sum(member.file_size for member in files.infolist()) <= 2 * MAX_SET_BYTES, "Set expands too far")
        files.extractall(destination)


def recipe_compatible(old: dict, new: dict) -> bool:
    """True when both sets came from the same producer code and pinned toolchain."""

    def producer(manifest: dict) -> dict:
        build = manifest["build"]
        recipe = {name: value for name, value in build["recipe"].items() if not CONTRACT_RECIPE.match(name)}
        return {"recipe": recipe, **{tool: build[tool] for tool in ("python", "uv", "node", "pnpm")}}

    return producer(old) == producer(new)


def run(args: argparse.Namespace) -> int:
    record: dict[str, object] = {"schema_version": 1, "baseline": args.baseline}
    tree = subprocess.check_output(["git", "-C", str(args.checkout), "rev-parse", "HEAD^{tree}"], text=True).strip()
    old = args.work / "base-artifacts"
    try:
        evidence = find(args.baseline, tree)
        repository, _ = _repository()
        fetch_set(repository, evidence["artifact"], old)
        manifest = json.loads((old / "manifest.json").read_bytes())
        candidate = json.loads((args.candidate / "manifest.json").read_bytes())
        _require(manifest["source"]["tree"] == tree, "Retained set describes another tree")
        _require(manifest["source"]["commit"] == evidence["source_commit"], "Retained set commit mismatch")
        _require(recipe_compatible(manifest, candidate), "Packaging producer changed since the baseline")
        record |= {
            "path": "retained",
            "run_id": evidence["run_id"],
            "artifact_id": evidence["artifact"]["id"],
            "artifact_name": evidence["artifact"]["name"],
            "artifact_digest": evidence["artifact"]["digest"],
            "manifest_sha256": hashlib.sha256((old / "manifest.json").read_bytes()).hexdigest(),
            "source": manifest["source"],
        }
    except Exception as exc:  # noqa: BLE001 - any doubt rebuilds; transport text may contain signed URLs.
        reason = str(exc) if isinstance(exc, ValueError) and "http" not in str(exc) else type(exc).__name__
        record |= {"path": "rebuilt", "reason": reason}
        # Record the decision before a rebuild that may itself fail.
        args.record.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        shutil.rmtree(old, ignore_errors=True)
        python = [sys.executable, str(BUILD)]
        subprocess.run([*python, "models", "--source", str(args.checkout)], check=True)
        subprocess.run(
            [*python, "build", "--source", str(args.checkout), "--commit", args.baseline, "--output", str(old)],
            check=True,
        )
    record["recorded_at"] = datetime.now(UTC).isoformat()
    args.record.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    print(json.dumps(record, indent=2, sort_keys=True), flush=True)
    return subprocess.run(
        [sys.executable, str(BUILD), "compare", str(old), str(args.candidate)], check=False
    ).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--checkout", required=True, type=Path, help="Exact baseline checkout, for a rebuild")
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--record", required=True, type=Path)
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
