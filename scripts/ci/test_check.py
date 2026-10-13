"""Exercise command failures, diagnostic integrity and YAML/policy integration."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import validation
from validation_policy import BASE, PROFILES, SUITES, UNTIMED

ROOT = Path(__file__).resolve().parents[2]


class CommandTests(unittest.TestCase):
    def test_commands_preserve_exit_stdin_output_and_hash(self):
        for code in (0, 7):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                result = subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "scripts/ci/check.py"),
                        "fixture",
                        "--",
                        sys.executable,
                        "-c",
                        f'import sys; print(sys.stdin.read()); print("diagnostic", file=sys.stderr); sys.exit({code})',
                    ],
                    input="input text",
                    text=True,
                    capture_output=True,
                    env={
                        key: value
                        for key, value in (os.environ | {"CI_RESULTS_DIR": directory}).items()
                        if key != "RUNNER_TEMP"
                    },
                )
                self.assertEqual(result.returncode, code, result.stderr)
                receipt = json.loads((Path(directory) / "fixture.json").read_text())
                log = (Path(directory) / "fixture.log").read_bytes()
                self.assertIn("input text", result.stdout)
                self.assertIn("diagnostic", result.stdout)
                self.assertEqual(receipt["exit_code"], code)
                self.assertEqual(receipt["status"], "passed" if code == 0 else "failed")
                self.assertEqual(receipt["log_sha256"], hashlib.sha256(log).hexdigest())
                self.assertGreaterEqual(receipt["duration_seconds"], 0)

    def test_missing_or_corrupt_or_failed_receipts_reject_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {"required": ["fixture"]}
            self.assertIsNotNone(validation.check_receipts(root, plan)[1])
            (root / "fixture.log").write_text("log")
            receipt = {
                "id": "fixture",
                "command": ["command"],
                "duration_seconds": 1,
                "status": "passed",
                "exit_code": 0,
                "log_sha256": hashlib.sha256(b"log").hexdigest(),
            }
            path = root / "fixture.json"
            path.write_text(json.dumps(receipt))
            self.assertIsNone(validation.check_receipts(root, plan)[1])
            for mutation in (
                {"duration_seconds": -1},
                {"status": "failed"},
                {"exit_code": 1},
                {"id": "other"},
                {"log_sha256": "bad"},
                {"command": []},
            ):
                with self.subTest(mutation=mutation):
                    path.write_text(json.dumps(receipt | mutation))
                    self.assertIsNotNone(validation.check_receipts(root, plan)[1])
            path.write_text("{")
            self.assertIsNotNone(validation.check_receipts(root, plan)[1])


class WorkflowContractTests(unittest.TestCase):
    def workflow_event(
        self,
        *,
        event="pull_request",
        action="synchronize",
        state="open",
        base_changed=False,
        number=4,
        ref="refs/pull/4/merge",
        run_id=100,
        workflow="Portable product validation",
    ):
        """Evaluate the workflow's small boolean/format expression subset with event fixtures."""
        text = (ROOT / ".github/workflows/validate-public.yml").read_text()
        context = {
            "github.workflow": workflow,
            "github.event_name": event,
            "github.event.action": action,
            "github.event.pull_request.state": state,
            "github.event.pull_request.number": number,
            "github.event.changes.base": base_changed,
            "github.ref": ref,
            "github.run_id": run_id,
        }

        def evaluate(expression):
            expression = re.sub(r"github\.[a-z_.]+", lambda match: repr(context[match[0]]), expression)
            expression = expression.replace("&&", " and ").replace("||", " or ")
            expression = re.sub(r"!(?!=)", "not ", expression)
            return eval(" ".join(expression.split()), {"__builtins__": {}, "format": str.format})

        group = re.search(r"^  group: >-\n(.*?)^  cancel-in-progress:", text, re.M | re.S)[1]
        group = re.sub(r"\$\{\{(.*?)\}\}", lambda match: str(evaluate(match[1])), group, flags=re.S).strip()
        condition = re.search(r"^    if: >-\n(.*?)^    runs-on:", text, re.M | re.S)[1]
        return bool(evaluate(condition)), group

    def test_metadata_edits_and_closed_prs_do_not_cancel_validation(self):
        meaningful, pr_group = self.workflow_event()
        self.assertTrue(meaningful)
        for state, action in (("open", "edited"), ("closed", "edited"), ("closed", "labeled")):
            with self.subTest(state=state, action=action):
                enabled, ignored = self.workflow_event(state=state, action=action, ref="refs/heads/main")
                self.assertFalse(enabled)
                self.assertNotEqual(ignored, pr_group)
                self.assertNotEqual(ignored, self.workflow_event(event="push", ref="refs/heads/main")[1])
                self.assertNotEqual(ignored, self.workflow_event(state=state, action=action, run_id=101)[1])

    def test_base_edits_and_existing_pr_actions_keep_pr_concurrency(self):
        expected = self.workflow_event()[1]
        for action in (
            "opened",
            "synchronize",
            "reopened",
            "ready_for_review",
            "converted_to_draft",
            "labeled",
            "unlabeled",
        ):
            with self.subTest(action=action):
                self.assertEqual(self.workflow_event(action=action), (True, expected))
        self.assertEqual(self.workflow_event(action="edited", base_changed=True), (True, expected))
        self.assertNotEqual(self.workflow_event(number=5)[1], expected)

    def test_pr_push_schedule_manual_and_release_groups_are_separate(self):
        results = [self.workflow_event(ref="refs/heads/main")]
        for event in ("push", "schedule", "workflow_dispatch"):
            results.append(self.workflow_event(event=event, ref="refs/heads/main"))
        for run_id in (100, 101):
            results.append(self.workflow_event(event="push", ref="refs/heads/main", workflow="Release", run_id=run_id))
        self.assertTrue(all(enabled for enabled, _ in results))
        self.assertEqual(len({group for _, group in results}), len(results))

    def test_one_job_and_selected_step_sets_match_gate(self):
        workflow = (ROOT / ".github/workflows/validate-public.yml").read_text()
        self.assertEqual(re.findall(r"^  ([a-z][a-z-]+):$", workflow.split("jobs:\n", 1)[1], re.M), ["validation"])
        self.assertIn("    name: Validation\n", workflow)
        blocks = re.split(r"^      - name: ", workflow, flags=re.M)[1:]
        ids = []
        for block in blocks:
            identity = re.search(r"^        id: (\S+)$", block, re.M)
            self.assertIsNotNone(identity)
            ids.append(identity[1])
        self.assertEqual(len(ids), len(set(ids)))
        cases = [(mode, mode in {"full", "selective"}, BASE | required) for mode, required in PROFILES.items()]
        cases.append(("selective", False, BASE | PROFILES["selective"] - SUITES["promotion"]))
        for mode, promotion, required in cases:
            selected = set()
            for block in blocks:
                identifier = re.search(r"^        id: (\S+)$", block, re.M)[1]
                if identifier in {"gate", "diagnostics", "receipts", "pnpm-cache", "speech-cache"}:
                    continue
                condition = re.search(r"^        if: (.+)$", block, re.M)
                if condition is None:
                    selected.add(identifier)
                    continue
                expression, _, gate = condition[1].partition(" && ")
                if gate:
                    self.assertEqual(gate, "steps.select.outputs.promotion == 'true'", identifier)
                    self.assertIn(identifier, SUITES["promotion"])
                if expression.startswith("contains(fromJSON("):
                    modes = re.search(r"fromJSON\('(.+)'\)", expression)
                    self.assertIsNotNone(modes)
                    chosen = mode in json.loads(modes[1])
                else:
                    expected = re.fullmatch(r"steps.select.outputs.mode == '(\w+)'", expression)
                    self.assertIsNotNone(expected, expression)
                    chosen = mode == expected[1]
                if chosen and (not gate or promotion):
                    selected.add(identifier)
                if identifier not in UNTIMED:
                    self.assertIn(f'check.py" {identifier} --', block)
            self.assertEqual(selected, required, (mode, promotion))
        # Every promotion-suite step carries the promotion condition.
        for identifier in SUITES["promotion"] - UNTIMED | {"baseline-checkout", "package-artifacts"}:
            block = next(block for block in blocks if f"id: {identifier}\n" in block)
            self.assertIn("steps.select.outputs.promotion == 'true'", block, identifier)
        self.assertIn("        if: always()\n", next(block for block in blocks if "id: gate\n" in block))


if __name__ == "__main__":
    unittest.main()
