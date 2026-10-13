#!/usr/bin/env python3
"""Bind conservative CI selection and acceptance to exact Git/event evidence."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import subprocess
from pathlib import Path

from browser_tests import browser_groups
from validation_policy import LOCAL_CHECKS, SUITES, UNTIMED, choose_plan, classify, evaluate

SHA = re.compile(r"[0-9a-f]{40}")
WORKFLOW = "Portable product validation"


def git(root: Path, *args: str, env: dict | None = None, data: bytes | None = None) -> bytes:
    """Never interpolate event values into a shell or include credentials in logs."""
    result = subprocess.run(["git", "-C", str(root), *args], env=env, input=data, capture_output=True)
    if result.returncode:
        raise ValueError(f"Git {args[0]} failed (exit {result.returncode})")
    return result.stdout


def exact_sha(value: object) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError("Expected a full immutable Git commit")
    return value


def fetch(root: Path, commits: list[str], depth: int) -> None:
    """Authenticate one read-only fetch without persisting checkout credentials."""
    env = os.environ.copy()
    token = env.pop("CI_READ_TOKEN", "")
    if token:
        server = env.get("GITHUB_SERVER_URL", "https://github.com")
        if server != "https://github.com":
            raise ValueError("Unexpected GitHub server for authenticated fetch")
        authorization = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update(
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0=f"http.{server}/.extraheader",
            GIT_CONFIG_VALUE_0=f"AUTHORIZATION: basic {authorization}",
            GIT_TERMINAL_PROMPT="0",
        )
    git(root, "fetch", "--no-tags", f"--depth={depth}", "origin", *commits, env=env)


def parse_changes(data: bytes) -> list[dict]:
    """Parse complete NUL-delimited name-status output, including rename sources."""
    if data and not data.endswith(b"\0"):
        raise ValueError("Truncated changed-file discovery")
    fields = data.decode("utf-8", errors="strict").split("\0")[:-1]
    changes = []
    while fields:
        status = fields.pop(0)
        if not re.fullmatch(r"[ACDMRTUXB][0-9]*", status):
            raise ValueError("Unknown Git change status")
        count = 2 if status.startswith(("R", "C")) else 1
        if len(fields) < count:
            raise ValueError("Truncated changed-file discovery")
        paths, fields = fields[:count], fields[count:]
        if any(not path or path.startswith("/") or ".." in path.split("/") for path in paths):
            raise ValueError("Invalid changed path")
        changes.append({"status": status, "old_path": paths[0] if count == 2 else None, "path": paths[-1]})
    return changes


def discover(root: Path, event: dict) -> tuple[list[dict], str]:
    """Inspect the entire PR diff; shallow-history uncertainty never narrows checks."""
    pr = event["pull_request"]
    head, base = exact_sha(pr["head"]["sha"]), exact_sha(pr["base"]["sha"])
    for depth in (0, 32, 128, 512):
        if depth:
            fetch(root, [head, base], depth)
        try:
            merge_base = exact_sha(git(root, "merge-base", base, head).decode().strip())
            data = git(root, "diff", "--name-status", "-z", "--find-renames", merge_base, head, "--")
            return parse_changes(data), merge_base
        except ValueError:
            if depth == 512:
                raise ValueError("Complete PR merge-base diff unavailable after bounded fetch") from None
    raise AssertionError("Unreachable history search")


def dependency_fingerprint(path: str, source: str) -> tuple[str, ...]:
    """Recognize a deliberately small static dependency grammar, not code purity.

    Unsupported syntax and dynamic dependency access force full validation.
    JavaScript comments/string text can cause conservative false positives.
    """
    import ast

    if path.endswith(".py"):
        tree = ast.parse(source)
        dependencies = []
        dynamic = {"__import__", "import_module", "load_module", "exec_module", "eval", "exec", "getattr"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import | ast.ImportFrom):
                dependencies.append(ast.dump(node, include_attributes=False))
            if isinstance(node, ast.Name) and node.id in dynamic | {"importlib", "runpy"}:
                raise ValueError("Dynamic Python dependency access")
            if isinstance(node, ast.Attribute) and node.attr in dynamic:
                raise ValueError("Dynamic Python dependency access")
        return tuple(sorted(dependencies))

    # No general JS parser: only ordinary quoted ES imports/re-exports qualify.
    # Reject dynamic import/require, escaped identifiers and import.meta before
    # removing comments so obfuscation never makes a dependency appear static.
    if re.search(r"\\(?:u|x)|\b(?:require|eval|Function)\b|\bimport\s*(?:\(|\.)", source):
        raise ValueError("Dynamic or escaped JavaScript dependency syntax")
    text = re.sub(r"/\*[\s\S]*?\*/|//[^\n]*", "", source)
    module = r"(?P<quote>['\"])(?P<module>[^'\"\s\\]+)(?P=quote)"
    identifier = r"[A-Za-z_$][\w$]*"
    item = rf"(?:type\s+)?{identifier}(?:\s+as\s+{identifier})?"
    named = rf"\{{\s*(?:{item}(?:\s*,\s*{item})*\s*,?)?\s*\}}"
    namespace = rf"\*\s+as\s+{identifier}"
    binding = rf"(?:{namespace}|{named}|{identifier}(?:\s*,\s*(?:{namespace}|{named}))?)"
    statement = re.compile(
        rf"(?m)^[ \t]*(?P<clause>import\s+(?:(?:type\s+)?{binding}\s+from\s+)?"
        rf"|export\s+(?:type\s+)?(?:\*|{named})\s+from\s+)" + module + r"[ \t]*;[ \t]*$"
    )
    dependencies = []

    def collect(match: re.Match[str]) -> str:
        clause = " ".join(match["clause"].split())
        dependencies.append(json.dumps([clause, match["module"]]))
        return "\n" * match[0].count("\n")

    remaining = statement.sub(collect, text)
    if re.search(r"\bimport\b|\bfrom\s*['\"]|\bexport\s+\*", remaining):
        raise ValueError("Unrecognized JavaScript dependency declaration")
    return tuple(sorted(dependencies))


def changed_dependencies(root: Path, merge_base: str | None, source_head: str, changes: list[dict] | None) -> set[str]:
    """Compare complete branch endpoints, never just the last commit or merge tree."""
    from validation_policy import classify

    excluded = set()
    for change in changes or []:
        path = change["path"]
        area = classify([change])
        if area != "web" and not (area == "backend" and path.startswith("src/backend/")):
            continue
        try:
            if merge_base is None:
                raise ValueError("Missing dependency baseline")
            before = git(root, "show", f"{merge_base}:{path}").decode("utf-8")
            after = git(root, "show", f"{source_head}:{path}").decode("utf-8")
            if dependency_fingerprint(path, before) != dependency_fingerprint(path, after):
                excluded.add(path)
        except (ValueError, SyntaxError, UnicodeError):
            excluded.add(path)
    return excluded


def special_inputs(
    root: Path,
    merge_base: str | None,
    changes: list[dict] | None,
    *,
    source_head: str = "HEAD",
    dependencies: bool = True,
) -> set[str]:
    """Special files and (unless disabled) changed/uncertain dependencies require full validation."""
    excluded = changed_dependencies(root, merge_base, source_head, changes) if dependencies else set()
    for revision in filter(None, ("HEAD", merge_base)):
        for entry in git(root, "ls-tree", "-r", "-z", revision).split(b"\0"):
            if entry:
                metadata, path = entry.split(b"\t", 1)
                if metadata.split()[0] != b"100644":
                    excluded.add(path.decode())
    paths = [row["path"] for row in changes or []]
    if paths:
        attributes = git(
            root,
            "check-attr",
            "--cached",
            "-z",
            "--stdin",
            "filter",
            data=b"".join(path.encode() + b"\0" for path in paths),
        ).split(b"\0")
        for index in range(0, len(attributes) - 1, 3):
            if attributes[index + 2] == b"lfs":
                excluded.add(attributes[index].decode())
    return excluded


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def hydrate(root: Path) -> None:
    """Reuse the candidate checkout; authenticate LFS only for this subprocess."""
    env = os.environ.copy()
    token = env.pop("CI_READ_TOKEN", "")
    if token:
        authorization = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update(
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0=f"AUTHORIZATION: basic {authorization}",
        )
    # The routing checkout deliberately disabled LFS. Do not rely on a runner's
    # global filter setup when comparing hydrated bytes against tracked pointers.
    git(root, "lfs", "install", "--local", env=env)
    git(root, "lfs", "fetch", "origin", "HEAD", env=env)
    git(root, "lfs", "checkout", env=env)
    git(root, "lfs", "fsck", env=env)


def plan(root: Path, output: Path) -> None:
    from datetime import UTC, datetime

    from github_evidence import main_docs_override, periodic_unchanged, review_for_event

    event_name = os.environ["GITHUB_EVENT_NAME"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    inputs = json.loads(os.environ.get("CI_INPUTS", "{}"))
    if not isinstance(event, dict) or not isinstance(inputs, dict):
        raise ValueError("Malformed event or workflow inputs")
    if "full-validation" in inputs and inputs["full-validation"] is not True:
        raise ValueError("Reusable validation must request the complete contract")
    reusable = "full-validation" in inputs or os.environ.get("GITHUB_WORKFLOW") != WORKFLOW
    source = exact_sha(git(root, "rev-parse", "HEAD").decode().strip())
    tree = git(root, "rev-parse", "HEAD^{tree}").decode().strip()
    if source != exact_sha(os.environ["GITHUB_SHA"]):
        raise ValueError("Checked-out source differs from the workflow source")
    changes, merge_base, error = None, None, None
    baseline = None
    try:
        if event_name == "pull_request":
            baseline = exact_sha(event["pull_request"]["base"]["sha"])
            changes, merge_base = discover(root, event)
        elif event_name == "push":
            baseline = exact_sha(event["before"])
            try:
                git(root, "cat-file", "-e", baseline + "^{commit}")
            except ValueError:
                fetch(root, [baseline], 1)
            changes = parse_changes(git(root, "diff", "--name-status", "-z", "--find-renames", baseline, source, "--"))
            merge_base = baseline
        else:
            baseline = exact_sha(git(root, "rev-parse", "HEAD^").decode().strip())
    except (ValueError, KeyError, TypeError, UnicodeError) as exc:
        error = str(exc)
    try:
        dependency_head = exact_sha(event["pull_request"]["head"]["sha"]) if event_name == "pull_request" else source
        # Links, executables and LFS inputs select every suite; changed imports only
        # matter to the reduced profiles' allowlists.
        special = special_inputs(root, merge_base, changes, source_head=dependency_head, dependencies=False)
        excluded = special | changed_dependencies(root, merge_base, dependency_head, changes)
    except (ValueError, KeyError, TypeError, OSError):
        excluded, special, error = set(), set(), "Cannot establish special-input exclusions"
    # Local assertions never reduce high-risk changes. Hosted full results may.
    selected = choose_plan(event_name, event, changes, error, reusable, excluded, special_paths=special)
    area = classify(changes, excluded)
    reviewed = {"accepted": False, "reason": "Not applicable to this selection"}
    pr = event.get("pull_request", {})
    labels = pr.get("labels", []) if isinstance(pr, dict) else []
    explicit = (
        reusable
        or event_name == "workflow_dispatch"
        or any(
            isinstance(label, dict) and label.get("name") == "ci:full"
            for label in (labels if isinstance(labels, list) else [])
        )
    )
    docs_override = None
    if event_name == "push" and selected["mode"] == "docs" and not reusable:
        docs_override = main_docs_override(event, source_commit=source, baseline=baseline)
        if docs_override.get("allow_focused") is not True:
            # Keep the known baseline: uncertain PR metadata expands coverage,
            # rather than failing source selection before full checks can run.
            selected = choose_plan(
                event_name, event, changes, "Main documentation override", reusable, excluded, special_paths=special
            )
            selected["reason"] = docs_override["reason"]
        if docs_override.get("full_requested") is True:
            explicit = True
    if not explicit and selected["mode"] != "deferred" and not error and area in LOCAL_CHECKS:
        reviewed = review_for_event(
            event_name,
            event,
            source_commit=source,
            source_tree=tree,
            baseline=baseline,
            required_checks=LOCAL_CHECKS[area],
            now=datetime.now(UTC),
        )
        selected = choose_plan(
            event_name,
            event,
            changes,
            error,
            reusable,
            excluded,
            local_reviewed=reviewed.get("accepted") is True,
            special_paths=special,
        )
    if event_name == "schedule" and not reusable:
        selected = choose_plan(
            event_name, event, changes, reusable=False, periodic_unchanged=periodic_unchanged(source)
        )
    hosted = {"accepted": False, "reason": "Not applicable to this selection"}
    if event_name == "push" and selected["mode"] == "full" and not explicit and not error:
        from hosted_evidence import hosted_for_main

        hosted = hosted_for_main(
            event, source_commit=source, source_tree=tree, baseline=baseline, now=datetime.now(UTC)
        )
        if hosted.get("accepted") is True:
            selected = choose_plan(event_name, event, changes, hosted_verified=True)
    receipt = {
        "schema_version": 3,
        "source_commit": source,
        "source_tree": tree,
        "event": event_name,
        "action": event.get("action"),
        "reusable": reusable,
        "pull_request": event.get("number"),
        "head": pr.get("head", {}).get("sha") if isinstance(pr, dict) and isinstance(pr.get("head"), dict) else None,
        "base": baseline,
        "merge_base": merge_base,
        "changes": changes,
        "diff_error": error,
        "plan": selected,
        "local_evidence": reviewed,
        "hosted_evidence": hosted,
        "main_docs_override": docs_override,
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "cold_cache": inputs.get("cold-cache", False),
    }
    write_json(output, receipt)
    skipped = {row["suite"] for row in selected.get("skipped", [])}
    promotion = selected["mode"] in {"full", "selective"} and "promotion" not in skipped
    with open(os.environ["GITHUB_OUTPUT"], "a") as target:
        target.write("mode=" + selected["mode"] + "\n")
        target.write("baseline=" + (baseline or "") + "\n")
        target.write("promotion=" + ("true" if promotion else "false") + "\n")
        target.write("browser-groups=" + ",".join(browser_groups(skipped)) + "\n")
        # Promotion-complete sets outlive the reuse window and serve later baselines.
        target.write(f"retention={14 if explicit or event_name == 'schedule' or selected['mode'] == 'full' else 3}\n")
    if promotion and (baseline is None or baseline == "0" * 40):
        raise ValueError("Full validation requires an exact compatibility baseline")
    print(json.dumps(receipt, indent=2))


def check_receipts(directory: Path, selected: object) -> tuple[list[dict], str | None]:
    """A successful command must also leave its duration and matching diagnostic log."""
    checks = []
    try:
        for path in sorted(directory.glob("*.json")):
            check = json.loads(path.read_text())
            if not isinstance(check, dict) or check.get("id") != path.stem:
                raise ValueError("Malformed check identity")
            duration = check.get("duration_seconds")
            if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0:
                raise ValueError("Malformed check duration")
            if (
                not isinstance(check.get("command"), list)
                or not check["command"]
                or any(not isinstance(arg, str) for arg in check["command"])
            ):
                raise ValueError("Malformed check command")
            if check.get("log_sha256") != hashlib.sha256(path.with_suffix(".log").read_bytes()).hexdigest():
                raise ValueError("Missing or changed check log")
            if check.get("status") not in ("passed", "failed") or type(check.get("exit_code")) is not int:
                raise ValueError("Malformed command result")
            checks.append(check)
        if any(row["status"] != "passed" or row["exit_code"] != 0 for row in checks):
            return checks, "One or more command receipts report failure"
        if isinstance(selected, dict) and isinstance(selected.get("required"), list):
            required = set(selected["required"]) - UNTIMED
            passed = {
                row["id"]
                for row in checks
                if row.get("status") == "passed" and type(row.get("exit_code")) is int and row["exit_code"] == 0
            }
            if required - passed:
                return checks, "Missing or unsuccessful command receipts: " + ", ".join(sorted(required - passed))
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        return checks, "Malformed command receipt or missing diagnostic log"
    return checks, None


def package_set_record(steps: object, directory: Path) -> tuple[dict | None, str | None]:
    """Identify the uploaded set of a run that executed the promotion suite.

    The PR receipt carries this record so a later `reused` main run can name the
    set without downloading it; a missing identity fails the run.
    """
    upload = steps.get("package-artifacts") if isinstance(steps, dict) else None
    if not isinstance(upload, dict) or upload.get("outcome") != "success":
        return None, None
    try:
        outputs = upload["outputs"]
        digest = outputs["artifact-digest"].removeprefix("sha256:")
        manifest = (directory / "manifest.json").read_bytes()
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Malformed artifact digest")
        return {
            "artifact_id": int(outputs["artifact-id"]),
            "artifact_digest": "sha256:" + digest,
            "manifest_sha256": hashlib.sha256(manifest).hexdigest(),
            "source": json.loads(manifest)["source"],
            "consumer_receipt_sha256": hashlib.sha256((directory / "validation.json").read_bytes()).hexdigest(),
            # Outcome of every promotion-suite step, so consumers see what ran.
            "promotion_suites": {name: steps[name]["outcome"] for name in sorted(SUITES["promotion"])},
        }, None
    except (OSError, KeyError, TypeError, ValueError, AttributeError):
        return None, "Uploaded package set cannot be identified"


def browser_record(steps: object, selected: object, path: Path) -> tuple[dict | None, str | None]:
    """A successful browser step must have run exactly the plan's groups, all passing."""
    step = steps.get("browser-tests") if isinstance(steps, dict) else None
    if not isinstance(step, dict) or step.get("outcome") != "success":
        return None, None
    try:
        record = json.loads(path.read_text())
        skipped = {row["suite"] for row in selected["skipped"]}
        if record["groups"] != browser_groups(skipped):
            return record, "Browser groups differ from the selection"
        if not record["files"] or any(row["status"] != "passed" for row in record["files"]):
            return record, "Browser file results missing or failed"
        return record, None
    except (OSError, ValueError, KeyError, TypeError):
        return None, "Missing or malformed browser file results"


def gate(output: Path) -> int:
    """Evaluate actual step outcomes and preserve a receipt even after early failure."""
    try:
        selection = json.loads(Path(os.environ["CI_PLAN_PATH"]).read_text())
        selected = selection["plan"]
    except (OSError, KeyError, ValueError, TypeError):
        selection, selected = None, None
    try:
        steps = json.loads(os.environ.get("CI_STEPS", "{}"))
    except ValueError:
        steps = None
    result = evaluate(selected, steps)
    if isinstance(selected, dict) and selected.get("mode") == "reused":
        from hosted_evidence import bound_evidence

        if not isinstance(selection, dict) or not bound_evidence(selection):
            result = {"success": False, "reason": "Missing or mismatched hosted reuse evidence"}
    directory = Path(os.environ.get("CI_RESULTS_DIR", str(Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "checks")))
    checks, receipt_error = check_receipts(directory, selected)
    if receipt_error:
        result = {"success": False, "reason": receipt_error}
    package_set, set_error = package_set_record(steps, Path(os.environ.get("CI_PACKAGE_SET_DIR", "/nonexistent")))
    if set_error:
        result = {"success": False, "reason": set_error}
    baseline_set, baseline_record = None, Path(os.environ.get("CI_BASELINE_RECORD", "/nonexistent"))
    if baseline_record.is_file():
        try:
            baseline_set = json.loads(baseline_record.read_text())
        except (OSError, ValueError):
            result = {"success": False, "reason": "Malformed baseline set record"}
    browser, browser_error = browser_record(steps, selected, Path(os.environ.get("CI_BROWSER_RESULTS", "/nonexistent")))
    if browser_error:
        result = {"success": False, "reason": browser_error}
    receipt = {"schema_version": 3, "selection": selection, "steps": steps, "checks": checks, **result}
    if package_set:
        receipt["package_set"] = package_set
    if baseline_set is not None:
        receipt["baseline_set"] = baseline_set
    write_json(output, receipt)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        from run_summary import render

        try:
            evidence = ""
            if isinstance(selected, dict) and selected.get("mode") == "reused" and result["success"]:
                hosted = selection["hosted_evidence"]
                named = hosted["package_set"]
                evidence = (
                    f"Full hosted evidence: [run {hosted['run_id']}]({hosted['run_url']}); "
                    f"artifact `{hosted['artifact_id']}`, digest `{hosted['artifact_digest']}`.\n\n"
                    f"Package set for promotion: `{named['artifact_name']}` "
                    f"(artifact `{named['artifact_id']}`, manifest `{named['manifest_sha256']}`), "
                    f"built from tested merge `{hosted['tested_commit']}` with this tree."
                )
            text = render(selected, result["reason"], checks, browser, evidence)
        except (KeyError, TypeError, ValueError):
            # The summary is informational; acceptance is already decided above.
            text = f"## Validation\n\n{result['reason']}\n\nSummary details unavailable.\n\n"
        with open(summary, "a") as target:
            target.write(text)
    print(json.dumps(receipt, indent=2))
    return 0 if result["success"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("plan", "gate", "hydrate"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.operation == "hydrate":
        hydrate(Path.cwd())
        return 0
    if args.output is None:
        parser.error("--output is required for plan and gate")
    if args.operation == "gate":
        return gate(args.output)
    plan(Path.cwd(), args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
