"""Reuse successful hosted full validation only for the identical merge result.

The API establishes run provenance; a digest-checked artifact carries the full
contract and tested Git identity. Any discovery uncertainty retains full CI.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import UTC, datetime, timedelta

from github_evidence import _full_requested, _get_json, _merged_pull, _NoRedirect, _number, _repository, _sha
from validation_policy import SUITES, UNTIMED, evaluate

WORKFLOW_PATH = ".github/workflows/validate-public.yml"
MAX_BYTES = 8 * 1024 * 1024
MAX_AGE = timedelta(days=7)
_HEX64 = re.compile(r"[0-9a-f]{64}")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
# The PR run's promotion-suite steps and the outcomes its receipt recorded.
PROMOTION_SUCCESS = {name: "success" for name in sorted(SUITES["promotion"])}


def _require(condition: object, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _require(parsed.utcoffset() == timedelta(0), "Timestamp must be UTC")
    return parsed


def _open_artifact(repository: str, artifact_id: int):
    """Open an artifact ZIP, following GitHub's signed redirect without forwarding credentials."""
    token = os.environ.get("CI_READ_TOKEN", "")
    _require(token, "Missing read-only token")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/actions/artifacts/{artifact_id}/zip",
        headers={"Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28"},
    )
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as exc:
        _require(exc.code == 302, "Artifact download unavailable")
        destination = exc.headers.get("Location", "")
        parsed = urllib.parse.urlsplit(destination)
        _require(
            parsed.scheme == "https"
            and not parsed.username
            and not parsed.password
            and parsed.port in (None, 443)
            and parsed.hostname
            and parsed.hostname.endswith((".blob.core.windows.net", ".actions.githubusercontent.com")),
            "Unexpected artifact storage destination",
        )
        response = opener.open(urllib.request.Request(destination), timeout=30)
    return response


def _download(repository: str, artifact_id: int) -> bytes:
    """Read one small, bounded artifact ZIP."""
    response = _open_artifact(repository, artifact_id)
    with response:
        data = response.read(MAX_BYTES + 1)
    _require(len(data) <= MAX_BYTES, "Artifact exceeds size bound")
    return data


def _receipt(data: bytes, artifact: dict, modes: frozenset[str] = frozenset({"full"})) -> dict:
    _require(len(data) <= MAX_BYTES, "Artifact exceeds size bound")
    _require(artifact["digest"] == "sha256:" + hashlib.sha256(data).hexdigest(), "Artifact digest mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        names = [member.filename for member in members]
        _require(len(names) == len(set(names)) and len(names) <= 200, "Ambiguous artifact members")
        _require(sum(member.file_size for member in members) <= MAX_BYTES, "Expanded artifact exceeds size bound")
        _require(
            all(re.fullmatch(r"(?:selection|validation)\.json|checks/[a-z0-9-]+\.json", name) for name in names),
            "Unexpected artifact members",
        )
        selection = json.loads(archive.read("selection.json"))
        receipt = json.loads(archive.read("validation.json"))
        _require(receipt["selection"] == selection, "Inconsistent artifact selection")
        _require(receipt["schema_version"] == 3 and receipt["success"] is True, "Unsuccessful full receipt")
        _require(selection["plan"]["mode"] in modes, "Prior run did not execute full validation")
        _require(evaluate(selection["plan"], receipt["steps"])["success"], "Full contract did not pass")
        checks = receipt["checks"]
        ids = [check["id"] for check in checks]
        _require(len(ids) == len(set(ids)), "Duplicate command receipt")
        _require(set(selection["plan"]["required"]) - UNTIMED <= set(ids), "Incomplete command receipts")
        for check in checks:
            _require(check["status"] == "passed" and check["exit_code"] == 0, "Failed command receipt")
            _require(json.loads(archive.read(f"checks/{check['id']}.json")) == check, "Command receipt mismatch")
    return receipt


def _package_set(receipt: dict, run: dict, tested: str, tree: str, parents: list[str], prefix: str, fetch) -> dict:
    """Name the PR run's uploaded set so promotion needs no second full run.

    The set records the test-merge commit; a consumer binds it to the main
    commit through the identical tree and parents recorded here.
    """
    recorded = receipt["package_set"]
    name = f"animama-set-{tested}-{run['run_attempt']}"
    _require(_number(recorded["artifact_id"]), "Malformed package set identity")
    _require(
        recorded["promotion_suites"] == PROMOTION_SUCCESS
        and all(receipt["steps"][step]["outcome"] == "success" for step in PROMOTION_SUCCESS),
        "Promotion suite did not succeed in the PR run",
    )
    artifact = fetch(f"{prefix}/actions/artifacts/{recorded['artifact_id']}")
    _require(
        artifact["id"] == recorded["artifact_id"]
        and artifact["name"] == name
        and artifact["expired"] is False
        and artifact["digest"] == recorded["artifact_digest"]
        and artifact["workflow_run"]["id"] == run["id"]
        and recorded["source"]["commit"] == tested
        and recorded["source"]["tree"] == tree
        and all(_HEX64.fullmatch(recorded[key]) for key in ("manifest_sha256", "consumer_receipt_sha256")),
        "Package set unavailable or not bound to the tested merge",
    )
    return {
        "artifact_id": artifact["id"],
        "artifact_name": name,
        "artifact_digest": artifact["digest"],
        "expires_at": artifact["expires_at"],
        "manifest_sha256": recorded["manifest_sha256"],
        "source": recorded["source"],
        "tested_commit_parents": parents,
        "consumer_receipt_sha256": recorded["consumer_receipt_sha256"],
        "promotion_suites": recorded["promotion_suites"],
    }


def hosted_for_main(
    event: dict,
    *,
    source_commit: str,
    source_tree: str,
    baseline: str,
    now: datetime,
    get_json=None,
    get_archive=None,
) -> dict:
    """Require one current successful PR run, exact source tree and merge baseline.

    Same-repository ordinary merges are supported. Squash/rebase, forks, batched
    pushes and unavailable evidence conservatively retain existing full checks.
    No recursive reuse: the imported receipt must describe actual full execution.
    """
    fetch = get_json or _get_json
    download = get_archive or _download
    try:
        repository, _ = _repository()
        prefix = f"/repos/{repository}"
        _require(all(_sha(value) for value in (source_commit, source_tree, baseline)), "Invalid Git identity")
        _require(
            event.get("ref") == "refs/heads/main"
            and event.get("before") == baseline
            and event.get("after") == source_commit
            and event.get("repository", {}).get("full_name") == repository,
            "Not an exact main push",
        )
        pr = _merged_pull(source_commit, repository, fetch)
        _require(not _full_requested(pr), "Persistent ci:full requests fresh full validation")
        head = pr["head"]["sha"]
        _require(_sha(head) and pr["head"]["repo"]["full_name"] == repository, "Unsupported PR source")
        _require(pr["base"]["repo"]["full_name"] == repository, "Unexpected PR target")
        merged_at = _time(pr["merged_at"])
        current = fetch(f"{prefix}/git/commits/{source_commit}")
        _require(
            current["sha"] == source_commit
            and current["tree"]["sha"] == source_tree
            and [parent["sha"] for parent in current["parents"]] == [baseline, head],
            "Main is not the same single-PR merge baseline",
        )
        workflow = fetch(f"{prefix}/actions/workflows/validate-public.yml")
        _require(workflow["path"] == WORKFLOW_PATH, "Unexpected workflow")
        response = fetch(
            f"{prefix}/actions/workflows/validate-public.yml/runs"
            f"?event=pull_request&head_sha={head}&per_page=100&page=1"
        )
        runs = response["workflow_runs"]
        _require(0 < len(runs) < 100 and response["total_count"] == len(runs), "Incomplete run discovery")
        _require(all(_number(run["id"]) for run in runs), "Malformed run identity")
        # Ignored metadata edits create successful runs with a skipped job. They
        # carry no validation evidence and must not obscure the last real run.
        for candidate in sorted(runs, key=lambda item: item["id"], reverse=True)[:10]:
            run = fetch(f"{prefix}/actions/runs/{candidate['id']}")
            _require(run["id"] == candidate["id"], "Run detail identity mismatch")
            if run["status"] != "completed" or run["conclusion"] != "success":
                break
            jobs = fetch(f"{prefix}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100&page=1")
            if not (
                jobs["total_count"] == len(jobs["jobs"]) == 1
                and jobs["jobs"][0]["name"] == "Validation"
                and jobs["jobs"][0]["conclusion"] == "skipped"
            ):
                break
        else:
            raise ValueError("No executed validation run in bounded discovery")
        _require(
            run["event"] == "pull_request"
            and run["head_sha"] == head
            and run["path"] == WORKFLOW_PATH
            and run["workflow_id"] == workflow["id"]
            and run["repository"]["full_name"] == repository
            and run["head_repository"]["full_name"] == repository
            and run["status"] == "completed"
            and run["conclusion"] == "success"
            and _number(run["run_attempt"]),
            "Latest PR run is not successful validation from this repository",
        )
        finished = _time(run["updated_at"])
        _require(now - MAX_AGE <= finished <= merged_at <= now + timedelta(minutes=5), "Stale or post-merge run")
        artifacts = fetch(f"{prefix}/actions/runs/{run['id']}/artifacts?per_page=100&page=1")
        _require(artifacts["total_count"] == len(artifacts["artifacts"]) < 100, "Incomplete artifact discovery")
        candidates = [
            a
            for a in artifacts["artifacts"]
            if a["name"].startswith("validation-receipt-") and a["name"].endswith(f"-{run['run_attempt']}")
        ]
        _require(len(candidates) == 1, "Missing or ambiguous receipt artifact")
        artifact = candidates[0]
        provenance = artifact["workflow_run"]
        _require(
            _number(artifact["id"])
            and artifact["expired"] is False
            and 0 < artifact["size_in_bytes"] <= MAX_BYTES
            and provenance["id"] == run["id"]
            and provenance["head_sha"] == head
            and provenance["repository_id"] == run["repository"]["id"]
            and provenance["head_repository_id"] == run["repository"]["id"],
            "Artifact provenance unavailable or mismatched",
        )
        receipt = _receipt(download(repository, artifact["id"]), artifact)
        selection = receipt["selection"]
        tested = selection["source_commit"]
        _require(_sha(tested), "Malformed tested commit")
        _require(
            selection["schema_version"] == 3
            and selection["event"] == "pull_request"
            and selection["reusable"] is False
            and selection["diff_error"] is None
            and selection["source_tree"] == source_tree
            and selection["base"] == baseline
            and _sha(selection["merge_base"])
            and selection["head"] == head
            and selection["pull_request"] == pr["number"]
            and selection["run_id"] == str(run["id"])
            and selection["run_attempt"] == str(run["run_attempt"])
            and artifact["name"] == f"validation-receipt-{tested}-{run['run_attempt']}",
            "Receipt does not cover this exact source, baseline and run attempt",
        )
        commit = fetch(f"{prefix}/git/commits/{tested}")
        _require(
            commit["sha"] == tested
            and commit["tree"]["sha"] == source_tree
            and [parent["sha"] for parent in commit["parents"]] == [baseline, head],
            "Hosted run did not test this proposed merged result",
        )
        package_set = _package_set(receipt, run, tested, source_tree, [baseline, head], prefix, fetch)
        return {
            "accepted": True,
            "reason": "Verified full hosted PR validation for identical tree and baseline",
            "source_commit": source_commit,
            "source_tree": source_tree,
            "baseline": baseline,
            "tested_commit": tested,
            "pull_request": pr["number"],
            "run_id": run["id"],
            "run_attempt": run["run_attempt"],
            "workflow": WORKFLOW_PATH,
            "run_url": f"https://github.com/{repository}/actions/runs/{run['id']}",
            "artifact_id": artifact["id"],
            "artifact_digest": artifact["digest"],
            "package_set": package_set,
            "verified_at": now.astimezone(UTC).isoformat(),
        }
    except Exception:
        # Transport exceptions may contain signed URLs. Never print their text.
        return {"accepted": False, "reason": "No verifiable matching full hosted PR run; full validation retained"}


def bound_evidence(selection: dict) -> bool:
    """The aggregate gate must not accept a reused plan without its bound evidence."""
    evidence = selection.get("hosted_evidence", {})
    return (
        isinstance(evidence, dict)
        and selection.get("event") == "push"
        and selection.get("reusable") is False
        and evidence.get("accepted") is True
        and all(_sha(selection.get(key)) for key in ("source_commit", "source_tree", "base"))
        and evidence.get("source_commit") == selection["source_commit"]
        and evidence.get("source_tree") == selection["source_tree"]
        and evidence.get("baseline") == selection["base"]
        and _number(evidence.get("run_id"))
        and _number(evidence.get("artifact_id"))
        and _number(evidence.get("run_attempt"))
        and isinstance(evidence.get("artifact_digest"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", evidence["artifact_digest"]) is not None
        and isinstance(evidence.get("run_url"), str)
        and re.fullmatch(r"https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+", evidence["run_url"])
        is not None
        and evidence.get("workflow") == WORKFLOW_PATH
        and _bound_package_set(evidence, selection)
    )


def _bound_package_set(evidence: dict, selection: dict) -> bool:
    package_set = evidence.get("package_set")
    if not isinstance(package_set, dict) or not isinstance(package_set.get("source"), dict):
        return False
    tested = evidence.get("tested_commit")
    parents = package_set.get("tested_commit_parents")
    return (
        _sha(tested)
        and _number(package_set.get("artifact_id"))
        and package_set.get("artifact_name") == f"animama-set-{tested}-{evidence['run_attempt']}"
        and isinstance(package_set.get("artifact_digest"), str)
        and _DIGEST.fullmatch(package_set["artifact_digest"]) is not None
        and all(
            isinstance(package_set.get(key), str) and _HEX64.fullmatch(package_set[key]) is not None
            for key in ("manifest_sha256", "consumer_receipt_sha256")
        )
        and package_set["source"].get("commit") == tested
        and package_set["source"].get("tree") == selection["source_tree"]
        and isinstance(parents, list)
        and len(parents) == 2
        and parents[0] == selection["base"]
        and _sha(parents[1])
        and package_set.get("promotion_suites") == PROMOTION_SUCCESS
    )
