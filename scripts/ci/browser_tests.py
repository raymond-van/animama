#!/usr/bin/env python3
"""Run the web package's browser test files for the selected groups.

Each file runs in its own `node --test` process. Lanes run concurrently and the
files inside a lane run one after another, so the layout below decides which
files may share the runner's two CPUs. Every file leaves a log and a result row
in `results.json`; any failed file fails the run.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "src/frontend/web"
PATTERN = "scripts/*.browser.test.mjs"
# Selectable groups (see validation_policy.SUITES). Every other file belongs to
# the always-run `core` group, so a new file runs until it is classified.
GROUPS = {
    "tooling": ("animation-preview", "animation-render", "effect-check", "effect-render", "effect-thumbnails"),
    "hosted": ("hosted-composition", "hosted-workflows", "retained-screens"),
}
SUITE_GROUPS = {"browser-tooling": "tooling", "browser-hosted": "hosted"}
# Lanes, in order of preference for each file. Files with tight timing windows
# run before the lanes start so they never share the CPUs with rendering work.
PRELUDE = ("initial-navigation-diagnostics", "model-download-coordination")
# One lane on the hosted two-vCPU runner. Two lanes (tooling renders beside the
# hosted screens) helped in a local two-CPU container but, in hosted run
# 38335080833, doubled each file's time, timed out an animation preview and took
# 19.3 min against 14.1 one at a time (see the shorten-full-validation ExecPlan).
# The effect renders share a Vite cache directory, so they must never be split
# across concurrent lanes.
LANES: tuple[tuple[str, ...], ...] = (GROUPS["tooling"] + GROUPS["hosted"],)
# A file whose browser fails to launch can leave a server open and never exit.
# Bound each file well above its slowest hosted time (about 4 minutes).
FILE_TIMEOUT_SECONDS = 20 * 60


def browser_groups(skipped_suites: set[str]) -> list[str]:
    """Groups to run when the plan skipped `skipped_suites`; core always runs."""
    return ["core", *sorted(group for suite, group in SUITE_GROUPS.items() if suite not in skipped_suites)]


def discover(web: Path = WEB) -> dict[str, str]:
    """Map each browser test file's stem to its group, failing on stale group entries."""
    stems = sorted(path.name.removesuffix(".browser.test.mjs") for path in web.glob(PATTERN))
    listed = {stem: group for group, members in GROUPS.items() for stem in members}
    missing = sorted(set(listed) - set(stems))
    if missing:
        raise SystemExit("Browser test groups name missing files: " + ", ".join(missing))
    return {stem: listed.get(stem, "core") for stem in stems}


def layout(files: dict[str, str], groups: list[str]) -> tuple[list[str], list[list[str]]]:
    """Order the selected files into a serial prelude and concurrent lanes."""
    selected = [stem for stem, group in files.items() if group in groups]
    prelude = [stem for stem in PRELUDE if stem in selected]
    lanes = [[stem for stem in lane if stem in selected and stem not in prelude] for lane in LANES]
    placed = set(prelude).union(*lanes)
    # Unplaced files (core, new files) share the last lane.
    lanes[-1] += [stem for stem in selected if stem not in placed]
    return prelude, [lane for lane in lanes if lane]


def run_file(stem: str, web: Path, log, timeout: float = FILE_TIMEOUT_SECONDS) -> str:
    """Run one file in its own process group so a timeout stops its servers and test process.

    Playwright starts Chromium in its own group; it exits once its controlling
    pipe closes, and SIGTERM first lets Playwright's cleanup run.
    """
    with subprocess.Popen(
        ["node", "--test", f"scripts/{stem}.browser.test.mjs"],
        cwd=web,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    ) as process:
        try:
            return "passed" if process.wait(timeout=timeout) == 0 else "failed"
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            log.write(f"\nTimed out after {timeout} seconds\n".encode())
            return "timed-out"


def run(groups: list[str], output: Path, web: Path = WEB) -> int:
    if "core" not in groups or any(group not in {"core", *GROUPS} for group in groups):
        raise SystemExit(f"Unknown or incomplete browser groups: {groups}")
    files = discover(web)
    prelude, lanes = layout(files, groups)
    output.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, object]] = []
    lock = threading.Lock()

    def execute(lane: str, stems: list[str]) -> None:
        for stem in stems:
            started = time.time()
            with (output / f"{stem}.log").open("wb") as log:
                status = run_file(stem, web, log)
            row = {
                "file": f"{stem}.browser.test.mjs",
                "group": files[stem],
                "lane": lane,
                "seconds": round(time.time() - started, 1),
                "status": status,
            }
            with lock:
                results.append(row)
                print(json.dumps(row), flush=True)

    started = time.time()
    execute("prelude", prelude)
    threads = [threading.Thread(target=execute, args=(f"lane-{index + 1}", stems)) for index, stems in enumerate(lanes)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    expected = len(prelude) + sum(len(stems) for stems in lanes)
    summary = {
        "groups": groups,
        "wall_seconds": round(time.time() - started, 1),
        "files": sorted(results, key=lambda row: row["file"]),
    }
    (output / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    failed = [row["file"] for row in results if row["status"] != "passed"]
    if failed or len(results) != expected:
        for name in failed:
            sys.stdout.write(f"\n--- {name} ---\n" + (output / name.replace(".browser.test.mjs", ".log")).read_text())
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--groups", required=True, help="Comma-separated groups from the selection plan")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    return run([group for group in args.groups.split(",") if group], args.output)


if __name__ == "__main__":
    raise SystemExit(main())
