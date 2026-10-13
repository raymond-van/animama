"""Render the job summary: selection, step durations and browser files.

Step timings come from the jobs API, which covers action steps that leave no
command receipt. When the API is unavailable the summary falls back to the
command receipts; the timings are informational and never affect acceptance.
"""

from __future__ import annotations

import os
from datetime import datetime

from github_evidence import _get_json, _repository
from validation_policy import SUITES


def _seconds(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    parse = datetime.fromisoformat
    return round((parse(end.replace("Z", "+00:00")) - parse(start.replace("Z", "+00:00"))).total_seconds())


def job_steps(fetch=_get_json) -> tuple[list[dict], float | None]:
    """Completed steps of this job, and the job's wall-clock seconds so far."""
    repository, _ = _repository()
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    jobs = fetch(f"/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100&page=1")["jobs"]
    # Release callers prefix the reusable job's name ("<caller> / Validation").
    job = next(job for job in jobs if job["name"] == "Validation" or job["name"].endswith(" / Validation"))
    rows = [
        {
            "name": step["name"],
            "result": step["conclusion"],
            "seconds": _seconds(step["started_at"], step["completed_at"]),
        }
        for step in job["steps"]
        if step.get("conclusion") and step["conclusion"] != "skipped"
    ]
    last = max((step["completed_at"] for step in job["steps"] if step.get("completed_at")), default=None)
    return rows, _seconds(job["started_at"], last)


def render(
    plan: dict | None, reason: str, checks: list[dict], browser: dict | None, evidence: str = "", steps=None
) -> str:
    lines = ["## Validation", "", reason, ""]
    if isinstance(plan, dict) and isinstance(plan.get("mode"), str):
        lines += [f"Profile: **{plan['mode']}**. {plan.get('reason', '')}", ""]
        if evidence:
            lines += [evidence, ""]
        if plan["mode"] in {"backend", "web"}:
            lines += ["Local assertions are owner-reviewed, not independently executed by this runner.", ""]
        if plan["mode"] in {"full", "selective"}:
            skipped = {row["suite"]: row["reason"] for row in plan.get("skipped", [])}
            lines += ["| Suite | Ran | Reason |", "| --- | --- | --- |"]
            for suite in sorted(SUITES):
                reason = skipped.get(suite, "Promotion candidate or changed inputs")
                lines += [f"| {suite} | {'no' if suite in skipped else 'yes'} | {reason} |"]
            lines += [""]
    try:
        rows, wall = steps() if steps else job_steps()
        if wall is not None:
            lines += [f"Job wall-clock before the gate: **{wall / 60:.1f} min**.", ""]
        lines += ["| Step | Result | Seconds |", "| --- | --- | ---: |"]
        lines += [f"| {row['name']} | {row['result']} | {row['seconds']} |" for row in rows]
    except Exception:  # noqa: BLE001 - timings are informational; never print transport details.
        lines += ["Step timings unavailable; command receipts follow.", "", "| Check | Result | Seconds |"]
        lines += ["| --- | --- | ---: |"]
        lines += [f"| {check['id']} | {check['status']} | {check['duration_seconds']} |" for check in checks]
    if browser:
        lines += ["", f"Browser groups `{','.join(browser['groups'])}`: {browser['wall_seconds']} s wall-clock.", ""]
        lines += ["| Browser file | Group | Lane | Result | Seconds |", "| --- | --- | --- | --- | ---: |"]
        lines += [
            f"| {row['file']} | {row['group']} | {row['lane']} | {row['status']} | {row['seconds']} |"
            for row in browser["files"]
        ]
    return "\n".join(lines) + "\n\n"
