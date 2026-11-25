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
from validation_policy import BASE, ORDINARY, PROFILES, SUITES, UNTIMED

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


REPOSITORY = "owner/animama"
FORK = "contributor/animama"


def contains(items, item):
    """GitHub's contains() on an array: case-insensitive element equality."""
    return any(isinstance(value, str) and value.lower() == item.lower() for value in items)


class WorkflowContractTests(unittest.TestCase):
    def workflow_event(
        self,
        *,
        event="pull_request",
        action="synchronize",
        state="open",
        base_changed=False,
        label=None,
        labels=(),
        head_repo=FORK,
        number=4,
        ref="refs/pull/4/merge",
        run_id=100,
        workflow="Portable product validation",
    ):
        """Evaluate the workflow's small boolean/format expression subset with event fixtures.

        `labels` are the PR's labels before the event; a `labeled` or `unlabeled`
        event's payload already carries the change, as GitHub sends it.
        """
        text = (ROOT / ".github/workflows/validate-public.yml").read_text()
        current = [name for name in labels if not (action == "unlabeled" and name == label)]
        if action == "labeled" and label is not None and label not in current:
            current.append(label)
        context = {
            "github.workflow": workflow,
            "github.event_name": event,
            "github.repository": REPOSITORY,
            "github.event.action": action,
            "github.event.pull_request.state": state,
            "github.event.pull_request.number": number,
            "github.event.pull_request.head.repo.full_name": head_repo,
            "github.event.pull_request.labels.*.name": current,
            "github.event.changes.base": base_changed,
            "github.event.label.name": label,
            "github.ref": ref,
            "github.run_id": run_id,
        }

        def evaluate(expression):
            # Only the checked-in workflow's expressions reach eval, with the
            # fixture values substituted as literals and no builtins available.
            expression = re.sub(r"github\.[a-z_.*]+", lambda match: repr(context[match[0]]), expression)
            expression = expression.replace("&&", " and ").replace("||", " or ")
            expression = re.sub(r"!(?!=)", "not ", expression)
            namespace = {"__builtins__": {}, "format": str.format, "contains": contains}
            return eval(" ".join(expression.split()), namespace)

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
                self.assertNotEqual(ignored, self.workflow_event(event="schedule", ref="refs/heads/main")[1])
                self.assertNotEqual(ignored, self.workflow_event(state=state, action=action, run_id=101)[1])

    def test_labels_other_than_ci_full_and_ci_run_neither_run_nor_cancel_validation(self):
        meaningful, pr_group = self.workflow_event()
        self.assertTrue(meaningful)
        for action in ("labeled", "unlabeled"):
            # A deleted label may arrive without its name; it cannot be either control being added.
            # GitHub compares names case-insensitively and keeps them unique that way,
            # so no other label can match ci:full or ci:run.
            for label in ("type:feat", "documentation", "ci:fully", "ci:runs", None):
                for head_repo, labels in ((FORK, ()), (REPOSITORY, ("ci:run",)), (REPOSITORY, ("ci:full",))):
                    with self.subTest(action=action, label=label, head_repo=head_repo, labels=labels):
                        event = {"action": action, "label": label, "head_repo": head_repo, "labels": labels}
                        enabled, ignored = self.workflow_event(**event)
                        self.assertFalse(enabled)
                        self.assertNotEqual(ignored, pr_group)
                        self.assertNotEqual(ignored, self.workflow_event(**event, run_id=101)[1])
            for label in ("ci:full", "ci:run"):
                with self.subTest(action=action, label=label):
                    self.assertEqual(self.workflow_event(action=action, label=label), (True, pr_group))
        # Other actions carry no label and are unaffected.
        self.assertEqual(self.workflow_event(action="synchronize", label="type:feat"), (True, pr_group))

    def test_same_repository_prs_run_only_with_an_opt_in_label(self):
        pr_group = self.workflow_event()[1]
        actions = ("opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft")
        for action in actions:
            for labels, expected in (
                ((), False),
                (("type:feat", "documentation"), False),
                (("ci:run",), True),
                (("CI:Run",), True),
                (("ci:full",), True),
                (("type:feat", "ci:full", "ci:run"), True),
            ):
                with self.subTest(action=action, labels=labels):
                    self.assertEqual(
                        self.workflow_event(action=action, head_repo=REPOSITORY, labels=labels), (expected, pr_group)
                    )
        own = {"head_repo": REPOSITORY}
        # Adding either control starts a run.
        for label in ("ci:run", "ci:full"):
            self.assertEqual(self.workflow_event(action="labeled", label=label, **own), (True, pr_group))
        # Removing the last control cancels the opted-in run without starting another.
        self.assertEqual(
            self.workflow_event(action="unlabeled", label="ci:run", labels=("ci:run",), **own), (False, pr_group)
        )
        # Removing ci:full under a remaining ci:run replans to the ordinary profile.
        self.assertEqual(
            self.workflow_event(action="unlabeled", label="ci:full", labels=("ci:run", "ci:full"), **own),
            (True, pr_group),
        )
        # A base edit replans only an opted-in PR.
        self.assertEqual(self.workflow_event(action="edited", base_changed=True, **own), (False, pr_group))
        self.assertEqual(
            self.workflow_event(action="edited", base_changed=True, labels=("ci:run",), **own), (True, pr_group)
        )

    def test_fork_prs_run_without_labels_including_deleted_forks(self):
        pr_group = self.workflow_event()[1]
        for head_repo in (FORK, None):
            for action in ("opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"):
                with self.subTest(head_repo=head_repo, action=action):
                    self.assertEqual(self.workflow_event(action=action, head_repo=head_repo), (True, pr_group))
        # Closed fork PRs and their metadata edits still do nothing.
        self.assertFalse(self.workflow_event(state="closed")[0])
        self.assertFalse(self.workflow_event(action="edited")[0])

    def test_main_pushes_do_not_trigger_validation(self):
        workflow = (ROOT / ".github/workflows/validate-public.yml").read_text()
        triggers = re.search(r"^on:\n(.*?)^permissions:", workflow, re.M | re.S)[1]
        self.assertEqual(
            re.findall(r"^  ([a-z_]+):", triggers, re.M),
            ["pull_request", "schedule", "workflow_dispatch", "workflow_call"],
        )
        # Scheduled and manual runs need no PR metadata.
        for event in ("schedule", "workflow_dispatch"):
            with self.subTest(event=event):
                self.assertTrue(self.workflow_event(event=event, ref="refs/heads/main", head_repo=REPOSITORY)[0])

    def test_base_edits_and_existing_pr_actions_keep_pr_concurrency(self):
        expected = self.workflow_event()[1]
        for action in (
            "opened",
            "synchronize",
            "reopened",
            "ready_for_review",
            "converted_to_draft",
        ):
            with self.subTest(action=action):
                self.assertEqual(self.workflow_event(action=action), (True, expected))
        for action in ("labeled", "unlabeled"):
            for label in ("ci:full", "ci:run"):
                self.assertEqual(self.workflow_event(action=action, label=label), (True, expected))
        self.assertEqual(self.workflow_event(action="edited", base_changed=True), (True, expected))
        self.assertNotEqual(self.workflow_event(number=5)[1], expected)

    def test_pr_schedule_manual_and_release_groups_are_separate(self):
        results = [self.workflow_event(ref="refs/heads/main")]
        for event in ("schedule", "workflow_dispatch"):
            results.append(self.workflow_event(event=event, ref="refs/heads/main"))
        # A release caller reports its own trigger, which may be a push.
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
        cases = [case for case in cases if case[0] not in ORDINARY - {"selective"}]
        # Ordinary runs skip the promotion suite; routed runs always do.
        cases += [(mode, False, BASE | PROFILES[mode] - SUITES["promotion"]) for mode in sorted(ORDINARY)]
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

        # Cache restores follow the steps that use them.
        def modes(identifier):
            block = next(block for block in blocks if f"id: {identifier}\n" in block)
            return re.search(r"^        if: contains\(fromJSON\('(.+?)'\)", block, re.M)[1]

        self.assertEqual(modes("pnpm-cache"), modes("pnpm-install"))
        self.assertEqual(modes("speech-cache"), modes("model-inputs"))
        # Every promotion-suite step carries the promotion condition.
        for identifier in SUITES["promotion"] - UNTIMED | {"baseline-checkout", "package-artifacts"}:
            block = next(block for block in blocks if f"id: {identifier}\n" in block)
            self.assertIn("steps.select.outputs.promotion == 'true'", block, identifier)
        self.assertIn("        if: always()\n", next(block for block in blocks if "id: gate\n" in block))


if __name__ == "__main__":
    unittest.main()
