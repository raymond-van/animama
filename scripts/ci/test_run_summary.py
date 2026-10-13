"""The job summary shows the selection, every step's duration and browser files."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from run_summary import job_steps, render
from validation_policy import choose_plan

JOBS = {
    "jobs": [
        {
            "name": "Validation",
            "started_at": "2026-10-12T10:00:00Z",
            "steps": [
                {
                    "name": "Check out",
                    "conclusion": "success",
                    "started_at": "2026-10-12T10:00:00Z",
                    "completed_at": "2026-10-12T10:00:30Z",
                },
                {"name": "Build packages", "conclusion": "skipped", "started_at": None, "completed_at": None},
                {
                    "name": "Run backend suite",
                    "conclusion": "success",
                    "started_at": "2026-10-12T10:00:30Z",
                    "completed_at": "2026-10-12T10:09:30Z",
                },
                {"name": "Evaluate", "conclusion": None, "started_at": "2026-10-12T10:09:30Z", "completed_at": None},
            ],
        }
    ]
}


class SummaryTests(unittest.TestCase):
    def test_job_steps_include_action_steps_and_omit_skipped_or_running_steps(self):
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "5", "GITHUB_RUN_ATTEMPT": "2"}):
            paths = []
            rows, wall = job_steps(lambda path: paths.append(path) or JOBS)
        self.assertEqual(paths, ["/repos/o/r/actions/runs/5/attempts/2/jobs?per_page=100&page=1"])
        self.assertEqual(
            [(row["name"], row["seconds"]) for row in rows], [("Check out", 30), ("Run backend suite", 540)]
        )
        self.assertEqual(wall, 570)

    def test_selective_summary_lists_skips_timings_and_browser_files(self):
        plan = choose_plan(
            "pull_request",
            {"action": "opened", "pull_request": {"draft": False, "labels": []}},
            [{"status": "M", "old_path": None, "path": "tests/test_chat.py"}],
        )
        browser = {
            "groups": ["core"],
            "wall_seconds": 75.0,
            "files": [
                {"file": "a.browser.test.mjs", "group": "core", "lane": "prelude", "status": "passed", "seconds": 4}
            ],
        }
        rows = [{"name": "x", "result": "success", "seconds": 3}]
        text = render(plan, "All passed", [], browser, "Evidence line.", steps=lambda: (rows, 600))
        self.assertIn("Evidence line.", text)
        self.assertIn("Profile: **selective**", text)
        self.assertIn("| promotion | no | No packaging input changed", text)
        self.assertIn("Job wall-clock before the gate: **10.0 min**", text)
        self.assertIn("| x | success | 3 |", text)
        self.assertIn("| a.browser.test.mjs | core | prelude | passed | 4 |", text)
        self.assertNotIn("owner-reviewed", text)

    def test_unavailable_timings_fall_back_to_command_receipts(self):
        def fail():
            raise RuntimeError("https://signed.example/secret")

        checks = [{"id": "backend-tests", "status": "passed", "duration_seconds": 12.5}]
        text = render(None, "Failed", checks, None, steps=fail)
        self.assertIn("| backend-tests | passed | 12.5 |", text)
        self.assertNotIn("secret", text)
        local = choose_plan(
            "pull_request",
            {"action": "opened", "pull_request": {"draft": False, "labels": []}},
            [{"status": "M", "old_path": None, "path": "tests/test_chat.py"}],
            local_reviewed=True,
        )
        self.assertIn("owner-reviewed", render(local, "ok", checks, None, steps=fail))


if __name__ == "__main__":
    unittest.main()
