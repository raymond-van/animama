"""Exercise real Git history and the CLI boundary, without network or dependencies."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import validation
from validation_policy import SUITES, UNTIMED, choose_plan


class GitSelectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "source"
        self.root.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "ci-fixture@example.invalid")
        self.git("config", "user.name", "CI fixture")
        self.write("docs/backend/a.md", "initial\n")
        self.write("docs/frontend/b.md", "initial\n")
        self.base = self.commit("base")

    def git(self, *args):
        return validation.git(self.root, *args).decode().strip()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, message):
        self.git("add", ".")
        self.git("-c", "commit.gpgsign=false", "commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def event(self, head):
        return {
            "action": "synchronize",
            "number": 12,
            "pull_request": {"head": {"sha": head}, "base": {"sha": self.base}, "draft": False, "labels": []},
        }

    def run_plan(self, event_name, event):
        event_path = Path(self.directory.name) / "event.json"
        event_path.write_text(json.dumps(event))
        receipt = Path(self.directory.name) / "selection.json"
        with (
            patch.dict(
                os.environ,
                {
                    "GITHUB_EVENT_NAME": event_name,
                    "GITHUB_EVENT_PATH": str(event_path),
                    "GITHUB_WORKFLOW": validation.WORKFLOW,
                    "GITHUB_SHA": self.git("rev-parse", "HEAD"),
                    "GITHUB_OUTPUT": str(Path(self.directory.name) / "outputs"),
                    "CI_INPUTS": "{}",
                },
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            validation.plan(self.root, receipt)
        return json.loads(receipt.read_text())

    def test_main_full_selection_requires_positive_hosted_evidence(self):
        self.write("uv.lock", "version = 1\n")
        head = self.commit("high risk")
        for accepted in (True, False, 1, None):
            with patch("hosted_evidence.hosted_for_main", return_value={"accepted": accepted}) as evidence:
                receipt = self.run_plan("push", {"ref": "refs/heads/main", "before": self.base, "after": head})
            self.assertEqual(receipt["plan"]["mode"], "reused" if accepted is True else "full")
            self.assertEqual(evidence.call_args.kwargs["baseline"], self.base)
            self.assertEqual(evidence.call_args.kwargs["source_tree"], self.git("rev-parse", "HEAD^{tree}"))
        with patch("hosted_evidence.hosted_for_main") as evidence:
            self.run_plan("pull_request", self.event(head))
            self.run_plan("workflow_dispatch", {})
        evidence.assert_not_called()

    def outputs(self):
        lines = (Path(self.directory.name) / "outputs").read_text().splitlines()
        return dict(line.split("=", 1) for line in lines)

    def test_step_outputs_follow_the_selected_suites(self):
        for path in ("tests/test_example.py", "src/backend/animama/example.py", "uv.lock"):
            self.write(path, "original\n")
        self.base = self.commit("inputs")
        for path, mode, promotion, groups, retention in (
            ("tests/test_example.py", "selective", "false", "core", "3"),
            ("src/backend/animama/example.py", "full", "true", "core,hosted,tooling", "14"),
            ("uv.lock", "full", "true", "core,hosted,tooling", "14"),
        ):
            with self.subTest(path=path):
                self.git("checkout", "-q", "--detach", self.base)
                self.write(path, "changed\n")
                head = self.commit(f"change {path}")
                (Path(self.directory.name) / "outputs").unlink(missing_ok=True)
                with patch("github_evidence.review_for_event", return_value={"accepted": False, "reason": "x"}):
                    receipt = self.run_plan("pull_request", self.event(head))
                self.assertEqual(receipt["plan"]["mode"], mode)
                outputs = self.outputs()
                self.assertEqual(
                    (outputs["mode"], outputs["promotion"], outputs["browser-groups"], outputs["retention"]),
                    (mode, promotion, groups, retention),
                )
                self.assertEqual(outputs["baseline"], self.base)
        (Path(self.directory.name) / "outputs").unlink()
        with patch("hosted_evidence.hosted_for_main", return_value={"accepted": False}):
            self.run_plan("push", {"ref": "refs/heads/main", "before": self.base, "after": head})
        outputs = self.outputs()
        self.assertEqual((outputs["mode"], outputs["promotion"], outputs["retention"]), ("full", "true", "14"))

    def test_complete_diff_includes_earlier_commits(self):
        self.write("docs/backend/a.md", "earlier\n")
        self.commit("first")
        self.write("docs/frontend/b.md", "latest\n")
        head = self.commit("second")
        changes, merge_base = validation.discover(self.root, self.event(head))
        self.assertEqual(merge_base, self.base)
        self.assertEqual({row["path"] for row in changes}, {"docs/backend/a.md", "docs/frontend/b.md"})
        self.assertTrue(all(row["old_path"] is None for row in changes))

    def test_shallow_checkout_fetches_enough_exact_history(self):
        self.git("checkout", "-b", "feature")
        for index in range(4):
            self.write("docs/backend/a.md", f"change {index}\n")
            self.commit(f"change {index}")
        head = self.git("rev-parse", "HEAD")
        clone = Path(self.directory.name) / "shallow"
        subprocess.run(
            ["git", "clone", "--quiet", "--depth=1", "--branch", "feature", self.root.as_uri(), str(clone)], check=True
        )
        changes, merge_base = validation.discover(clone, self.event(head))
        self.assertEqual(merge_base, self.base)
        self.assertEqual([row["path"] for row in changes], ["docs/backend/a.md"])

    def test_cli_selects_docs_without_repository_inventories(self):
        self.write("docs/backend/a.md", "documentation\n")
        head = self.commit("docs")
        event_path = Path(self.directory.name) / "event.json"
        event_path.write_text(json.dumps(self.event(head)))
        output_path = Path(self.directory.name) / "outputs"
        receipt = Path(self.directory.name) / "receipt.json"
        with patch.dict(
            os.environ,
            {
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": str(event_path),
                "GITHUB_WORKFLOW": validation.WORKFLOW,
                "GITHUB_SHA": head,
                "GITHUB_OUTPUT": str(output_path),
                "CI_INPUTS": "{}",
            },
        ):
            validation.plan(self.root, receipt)
        data = json.loads(receipt.read_text())
        self.assertEqual(data["plan"]["mode"], "docs")
        self.assertEqual(data["source_tree"], self.git("rev-parse", "HEAD^{tree}"))
        self.assertIn("mode=docs\n", output_path.read_text())

    def test_incomplete_history_cannot_select_docs(self):
        event = self.event("f" * 40)
        with self.assertRaises(ValueError):
            validation.discover(self.root, event)

    def test_executable_and_lfs_inputs_cannot_select_docs(self):
        self.write(".gitattributes", "docs/frontend/b.md filter=lfs\n")
        self.git("add", ".gitattributes")
        self.git("update-index", "--chmod=+x", "docs/backend/a.md")
        self.git("-c", "commit.gpgsign=false", "commit", "-m", "executable")
        changes = [{"status": "M", "old_path": None, "path": "docs/frontend/b.md"}]
        excluded = validation.special_inputs(self.root, self.base, changes)
        self.assertIn("docs/backend/a.md", excluded)
        self.assertIn("docs/frontend/b.md", excluded)

    def test_main_push_uses_complete_before_to_head_diff_for_docs(self):
        self.write("docs/backend/a.md", "earlier main change\n")
        self.commit("earlier")
        self.write("docs/frontend/b.md", "latest main change\n")
        head = self.commit("latest")
        with (
            patch("github_evidence.review_for_event") as review,
            patch("github_evidence.main_docs_override", return_value={"allow_focused": True, "full_requested": False}),
        ):
            receipt = self.run_plan("push", {"ref": "refs/heads/main", "before": self.base, "after": head})
        review.assert_not_called()
        self.assertEqual(receipt["plan"]["mode"], "docs")
        self.assertEqual(receipt["base"], self.base)
        self.assertEqual(receipt["merge_base"], self.base)
        self.assertEqual({row["path"] for row in receipt["changes"]}, {"docs/backend/a.md", "docs/frontend/b.md"})

    def test_narrow_code_uses_only_positive_review_for_exact_source(self):
        self.write("tests/test_example.py", "assert True\n")
        self.base = self.commit("existing test")
        self.write("tests/test_example.py", "assert 1 == 1\n")
        head = self.commit("test update")
        for event_name, event in (
            ("pull_request", self.event(head)),
            ("push", {"ref": "refs/heads/main", "before": self.base, "after": head}),
        ):
            for reviewed in (True, False, 1, None):
                with patch(
                    "github_evidence.review_for_event", return_value={"accepted": reviewed, "reason": "fixture"}
                ) as review:
                    receipt = self.run_plan(event_name, event)
                # A full PR run of an unpackaged test file skips the promotion suite.
                unreviewed = "selective" if event_name == "pull_request" else "full"
                self.assertEqual(receipt["plan"]["mode"], "backend" if reviewed is True else unreviewed)
                review.assert_called_once()
                self.assertEqual(review.call_args.kwargs["source_commit"], head)
                self.assertEqual(review.call_args.kwargs["source_tree"], self.git("rev-parse", "HEAD^{tree}"))
                self.assertEqual(review.call_args.kwargs["baseline"], self.base)
                self.assertEqual(set(review.call_args.kwargs["required_checks"]), {"backend-full"})

    def test_full_pr_selection_ignores_test_imports_but_not_special_files(self):
        self.write("tests/test_example.py", "assert True\n")
        self.write("tests/run_example.sh", "true\n")
        self.base = self.commit("existing test")
        self.write("tests/test_example.py", "import json\nassert json\n")
        head = self.commit("test imports")
        with patch("github_evidence.review_for_event", return_value={"accepted": False, "reason": "fixture"}):
            receipt = self.run_plan("pull_request", self.event(head))
        self.assertEqual(receipt["plan"]["mode"], "selective")
        self.assertEqual([row["suite"] for row in receipt["plan"]["skipped"]], sorted(SUITES))
        self.base = head
        (self.root / "tests/run_example.sh").chmod(0o755)
        self.git("add", "--chmod=+x", "tests/run_example.sh")
        head = self.commit("executable helper")
        with patch("github_evidence.review_for_event", return_value={"accepted": False, "reason": "fixture"}):
            receipt = self.run_plan("pull_request", self.event(head))
        self.assertEqual((receipt["plan"]["mode"], receipt["plan"]["skipped"]), ("full", []))

    def test_high_risk_path_and_explicit_full_do_not_consult_local_review(self):
        self.write("uv.lock", "version = 1\n")
        self.base = self.commit("lockfile exists")
        self.write("uv.lock", "version = 2\n")
        head = self.commit("lockfile change")
        with patch("github_evidence.review_for_event") as review:
            receipt = self.run_plan("pull_request", self.event(head))
        review.assert_not_called()
        self.assertEqual(receipt["plan"]["mode"], "full")

    def test_missing_or_malformed_main_baseline_cannot_reduce(self):
        self.write("docs/backend/a.md", "updated\n")
        head = self.commit("docs")
        with (
            patch("validation.fetch", side_effect=ValueError("fixture missing base")),
            patch("github_evidence.review_for_event") as review,
        ):
            receipt = self.run_plan("push", {"ref": "refs/heads/main", "before": "f" * 40, "after": head})
        self.assertEqual(receipt["plan"]["mode"], "full")
        self.assertIsNotNone(receipt["diff_error"])
        review.assert_not_called()
        for baseline in (None, "not-a-sha", "0" * 40):
            with (
                patch("validation.fetch", side_effect=ValueError("fixture missing base")),
                self.assertRaises(ValueError),
            ):
                self.run_plan("push", {"ref": "refs/heads/main", "before": baseline, "after": head})
            receipt = json.loads((Path(self.directory.name) / "selection.json").read_text())
            self.assertEqual(receipt["plan"]["mode"], "full")

    def test_changed_dependency_in_earlier_pr_commit_requires_full(self):
        path = "src/frontend/web/src/ui/components/card.tsx"
        self.write(path, 'import { cn } from "@/lib/utils";\nexport const Card = 1;\n')
        self.base = self.commit("existing leaf")
        self.write(path, 'import { cn } from "@/lib/persistence";\nexport const Card = 1;\n')
        self.commit("change dependency")
        self.write(path, 'import { cn } from "@/lib/persistence";\nexport const Card = 2;\n')
        head = self.commit("later presentation change")
        with patch("github_evidence.review_for_event") as review:
            receipt = self.run_plan("pull_request", self.event(head))
        self.assertEqual(receipt["plan"]["mode"], "full")
        review.assert_not_called()

    def test_dependency_comparison_uses_pr_head_not_checked_out_merge(self):
        path = "src/frontend/web/src/ui/components/card.tsx"
        original = 'import { cn } from "@/lib/utils";\nexport const Card = 1;\n'
        changed = 'import { cn } from "@/lib/persistence";\nexport const Card = 2;\n'
        self.write(path, original)
        self.base = self.commit("existing leaf")
        self.write(path, changed)
        head = self.commit("PR dependency changed")
        self.write(path, original)
        self.commit("different integrated content")
        with patch("github_evidence.review_for_event") as review:
            receipt = self.run_plan("pull_request", self.event(head))
        self.assertEqual(receipt["plan"]["mode"], "full")
        review.assert_not_called()

    def test_same_imports_allow_presentation_change_and_python_added_import_excludes(self):
        web = "src/frontend/web/src/ui/components/card.tsx"
        backend = "src/backend/animama/app/services/memory_entry_diff.py"
        self.write(web, 'import { cn } from "@/lib/utils";\nexport const Card = 1;\n')
        self.write(backend, "import difflib\nVALUE = 1\n")
        self.base = self.commit("existing narrow sources")
        self.write(web, 'import { cn } from "@/lib/utils";\nexport const Card = 2;\n')
        self.write(backend, "import difflib\nimport os\nVALUE = 1\n")
        head = self.commit("narrow sources edited")
        changes, base = validation.discover(self.root, self.event(head))
        excluded = validation.special_inputs(self.root, base, changes, source_head=head)
        self.assertNotIn(web, excluded)
        self.assertIn(backend, excluded)

    def test_main_docs_full_override_uses_real_api_policy_and_preserves_baseline(self):
        self.write("docs/backend/a.md", "updated documentation\n")
        head = self.commit("docs update")
        repository = "owner/project"
        prefix = f"/repos/{repository}"
        detail = {
            "number": 7,
            "merged": True,
            "merged_at": "2026-09-17T12:00:00Z",
            "base": {"ref": "main"},
            "merge_commit_sha": head,
            "labels": [],
        }
        for associated, labels, expected in (
            ([], [], "docs"),
            ([{"number": 7}], [], "docs"),
            ([{"number": 7}], [{"name": "ci:full"}], "full"),
            ([{"number": 7}, {"number": 8}], [], "full"),
            ([{"number": 7}], None, "full"),
            (ValueError("API unavailable"), [], "full"),
        ):

            def api(path, associated=associated, labels=labels):
                if isinstance(associated, Exception):
                    raise associated
                if path == f"{prefix}/commits/{head}/pulls?per_page=100&page=1":
                    return associated
                if path == f"{prefix}/pulls/7":
                    return detail | {"labels": labels}
                raise AssertionError(path)

            with (
                patch.dict(os.environ, {"GITHUB_REPOSITORY": repository}),
                patch("github_evidence._get_json", side_effect=api),
                patch("github_evidence.review_for_event") as review,
            ):
                receipt = self.run_plan("push", {"ref": "refs/heads/main", "before": self.base, "after": head})
            review.assert_not_called()
            self.assertEqual(receipt["plan"]["mode"], expected)
            self.assertEqual(receipt["base"], self.base)
            self.assertIsNone(receipt["diff_error"])
            self.assertIsNotNone(receipt["main_docs_override"])


class InputBoundaryTests(unittest.TestCase):
    def test_full_hydration_installs_local_filters_before_materialization(self):
        with patch.object(validation, "git", return_value=b"") as run:
            validation.hydrate(Path("/fixture"))
        self.assertEqual(
            [call.args[1:] for call in run.call_args_list],
            [("lfs", "install", "--local"), ("lfs", "fetch", "origin", "HEAD"), ("lfs", "checkout"), ("lfs", "fsck")],
        )

    def test_renames_deletions_and_unusual_filenames(self):
        rows = validation.parse_changes(b"R100\0old name\0new\nname\0D\0removed\0")
        self.assertEqual(rows[0], {"status": "R100", "old_path": "old name", "path": "new\nname"})
        self.assertEqual(rows[1], {"status": "D", "old_path": None, "path": "removed"})
        for malformed in (b"M\0truncated", b"R100\0one\0", b"M\0../escape\0", b"invalid\0path\0"):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                validation.parse_changes(malformed)

    def test_gate_writes_failure_for_absent_plan(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ, {"CI_PLAN_PATH": "/nonexistent-selection", "CI_STEPS": "{}", "CI_RESULTS_DIR": directory}
            ),
        ):
            output = Path(directory) / "gate.json"
            self.assertEqual(validation.gate(output), 1)
            self.assertFalse(json.loads(output.read_text())["success"])


class DependencyFingerprintTests(unittest.TestCase):
    def test_known_static_forms_and_bindings(self):
        source = "\n".join(
            [
                'import * as React from "react";',
                'import { type Props, cn } from "@/lib/utils";',
                'export * from "@animama/product-ui/components";',
            ]
        )
        first = validation.dependency_fingerprint("card.tsx", source)
        self.assertEqual(first, validation.dependency_fingerprint("card.tsx", source + "\nexport const Card = 2;"))
        self.assertNotEqual(first, validation.dependency_fingerprint("card.tsx", source.replace("cn", "other")))
        self.assertEqual(len(first), 3)

    def test_unsupported_or_dynamic_syntax_never_claims_static_dependencies(self):
        for source in (
            'const x = import("other");',
            'const x = require("other");',
            'const x = import.meta.resolve("other");',
            "import thing from variable;",
            'import { broken from "other"',
            'import { broken from "other";',
            'import multiple bare names from "other";',
            'import x from "other" with { type: "json" };',
            'import /*comment*/ ("other");',
            'const x = "\\u0069mport";',
            "export * from variable;",
        ):
            with self.subTest(source=source), self.assertRaises(ValueError):
                validation.dependency_fingerprint("card.tsx", source)
        for source in (
            "import (broken",
            '__import__("os")',
            'getattr(module, "import_module")("os")',
            'importlib.import_module("os")',
        ):
            with self.subTest(source=source), self.assertRaises((ValueError, SyntaxError)):
                validation.dependency_fingerprint("memory_entry_diff.py", source)


class GateReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.checks = self.root / "checks"
        self.checks.mkdir()
        self.plan = choose_plan("workflow_dispatch", {}, None)
        self.selection = self.root / "selection.json"
        self.selection.write_text(json.dumps({"plan": self.plan, "source_commit": "a" * 40, "source_tree": "b" * 40}))
        self.steps = {name: {"outcome": "success", "conclusion": "success"} for name in self.plan["required"]}
        self.steps["package-artifacts"]["outputs"] = {"artifact-id": "300", "artifact-digest": "9" * 64}
        self.set_dir = self.root / "public-artifacts"
        self.set_dir.mkdir()
        self.manifest = json.dumps({"source": {"commit": "a" * 40, "tree": "b" * 40}}).encode()
        (self.set_dir / "manifest.json").write_bytes(self.manifest)
        (self.set_dir / "validation.json").write_bytes(b'{"passed": true}')
        self.browser = self.root / "browser-results.json"
        self.write_browser(["core", "hosted", "tooling"])
        for name in set(self.plan["required"]) - UNTIMED:
            self.write_check(name)

    def write_browser(self, groups, status="passed"):
        files = [{"file": "a.browser.test.mjs", "group": "core", "lane": "prelude", "status": status, "seconds": 1}]
        self.browser.write_text(json.dumps({"groups": groups, "wall_seconds": 1, "files": files}))

    def write_check(self, name, **changes):
        log = f"Synthetic unit-test command record for {name}\n".encode()
        (self.checks / f"{name}.log").write_bytes(log)
        record = {
            "id": name,
            "status": "passed",
            "exit_code": 0,
            "duration_seconds": 1.25,
            "command": ["fixture-check", name],
            "log_sha256": hashlib.sha256(log).hexdigest(),
        } | changes
        (self.checks / f"{name}.json").write_text(json.dumps(record))

    def gate(self):
        output = self.root / "gate.json"
        with (
            patch.dict(
                os.environ,
                {
                    "CI_PLAN_PATH": str(self.selection),
                    "CI_STEPS": json.dumps(self.steps),
                    "CI_RESULTS_DIR": str(self.checks),
                    "CI_PACKAGE_SET_DIR": str(self.set_dir),
                    "CI_BASELINE_RECORD": str(self.root / "baseline-set.json"),
                    "CI_BROWSER_RESULTS": str(self.browser),
                    "GITHUB_STEP_SUMMARY": str(self.root / "summary.md"),
                },
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            code = validation.gate(output)
        return code, json.loads(output.read_text())

    def test_promotion_runs_record_their_uploaded_set(self):
        (self.root / "baseline-set.json").write_text(json.dumps({"path": "retained", "run_id": 5}))
        code, receipt = self.gate()
        self.assertEqual(code, 0, receipt["reason"])
        self.assertEqual(receipt["schema_version"], 3)
        self.assertEqual(
            receipt["package_set"],
            {
                "artifact_id": 300,
                "artifact_digest": "sha256:" + "9" * 64,
                "manifest_sha256": hashlib.sha256(self.manifest).hexdigest(),
                "source": {"commit": "a" * 40, "tree": "b" * 40},
                "consumer_receipt_sha256": hashlib.sha256(b'{"passed": true}').hexdigest(),
                "promotion_suites": {name: "success" for name in sorted(SUITES["promotion"])},
            },
        )
        self.assertEqual(receipt["baseline_set"], {"path": "retained", "run_id": 5})
        (self.root / "baseline-set.json").write_text("{truncated")
        code, receipt = self.gate()
        self.assertEqual((code, receipt["reason"]), (1, "Malformed baseline set record"))
        (self.root / "baseline-set.json").unlink()
        for outputs in (
            {},
            {"artifact-id": "x", "artifact-digest": "9" * 64},
            {"artifact-id": "1", "artifact-digest": "z"},
        ):
            self.steps["package-artifacts"]["outputs"] = outputs
            code, receipt = self.gate()
            self.assertEqual(code, 1)
            self.assertNotIn("package_set", receipt)
        self.steps["package-artifacts"]["outputs"] = {"artifact-id": "300", "artifact-digest": "9" * 64}
        (self.set_dir / "manifest.json").unlink()
        self.assertEqual(self.gate()[0], 1)

    def test_browser_results_must_match_the_selected_groups(self):
        self.assertEqual(self.gate()[0], 0)
        for groups, status in ((["core"], "passed"), (["core", "hosted", "tooling"], "failed")):
            self.write_browser(groups, status)
            self.assertEqual(self.gate()[0], 1)
        self.browser.unlink()
        code, receipt = self.gate()
        self.assertEqual((code, receipt["reason"]), (1, "Missing or malformed browser file results"))
        self.steps["browser-tests"] = {"outcome": "failure", "conclusion": "failure"}
        self.assertEqual(self.gate()[0], 1)

    def test_runs_without_the_promotion_suite_record_no_set(self):
        self.steps["package-artifacts"] = {"outcome": "skipped", "conclusion": "skipped"}
        code, receipt = self.gate()
        self.assertNotIn("package_set", receipt)
        self.assertNotIn("baseline_set", receipt)

    def test_reused_gate_rejects_missing_or_mismatched_evidence(self):
        from hosted_evidence import WORKFLOW_PATH

        selected = choose_plan("push", {"ref": "refs/heads/main"}, [], hosted_verified=True)
        evidence = {
            "accepted": True,
            "source_commit": "a" * 40,
            "source_tree": "b" * 40,
            "baseline": "c" * 40,
            "run_id": 10,
            "run_attempt": 1,
            "artifact_id": 20,
            "artifact_digest": "sha256:" + "d" * 64,
            "run_url": "https://github.com/owner/repo/actions/runs/10",
            "workflow": WORKFLOW_PATH,
            "tested_commit": "e" * 40,
            "package_set": {
                "artifact_id": 30,
                "artifact_name": f"animama-set-{'e' * 40}-1",
                "artifact_digest": "sha256:" + "f" * 64,
                "expires_at": "2026-10-26T00:00:00Z",
                "manifest_sha256": "1" * 64,
                "source": {"commit": "e" * 40, "tree": "b" * 40},
                "tested_commit_parents": ["c" * 40, "9" * 40],
                "consumer_receipt_sha256": "2" * 64,
                "promotion_suites": {name: "success" for name in sorted(SUITES["promotion"])},
            },
        }
        selection = {
            "plan": selected,
            "event": "push",
            "reusable": False,
            "source_commit": "a" * 40,
            "source_tree": "b" * 40,
            "base": "c" * 40,
        }
        for value in (None, {}, evidence | {"source_tree": "d" * 40}, evidence | {"package_set": {}}, evidence):
            selection["hosted_evidence"] = value
            self.selection.write_text(json.dumps(selection))
            self.assertEqual(self.gate()[0], 0 if value == evidence else 1)

    def test_full_gate_requires_successful_hashed_command_receipts(self):
        code, receipt = self.gate()
        self.assertEqual(code, 0)
        self.assertTrue(receipt["success"])
        self.assertEqual({item["id"] for item in receipt["checks"]}, set(self.plan["required"]) - UNTIMED)
        self.assertIn("package-compat", (self.root / "summary.md").read_text())

    def test_early_policy_failure_and_late_compatibility_failure_are_rejected(self):
        for name in ("ci-policy-tests", "package-compat"):
            for conclusion in ("failure", "success"):
                self.steps[name] = {"outcome": "failure", "conclusion": conclusion}
                self.write_check(name, status="failed", exit_code=1)
                code, receipt = self.gate()
                self.assertEqual(code, 1)
                self.assertFalse(receipt["success"])
                self.steps[name] = {"outcome": "success", "conclusion": "success"}
                self.write_check(name)

    def test_missing_command_receipt_and_unexpected_required_skip_cannot_pass(self):
        path = self.checks / "package-compat.json"
        path.unlink()
        self.assertEqual(self.gate()[0], 1)
        self.write_check("package-compat")
        self.steps["package-compat"] = {"outcome": "skipped", "conclusion": "skipped"}
        self.assertEqual(self.gate()[0], 1)
        del self.steps["package-compat"]
        self.assertEqual(self.gate()[0], 1)

    def test_changed_missing_and_malformed_diagnostics_fail_closed(self):
        path = self.checks / "package-compat.log"
        path.write_text("changed after receipt\n")
        self.assertEqual(self.gate()[0], 1)
        path.unlink()
        self.assertEqual(self.gate()[0], 1)
        for changes in (
            {"duration_seconds": 10**400},
            {"duration_seconds": -1},
            {"duration_seconds": True},
            {"command": []},
            {"exit_code": True},
            {"status": "skipped"},
        ):
            self.write_check("package-compat", **changes)
            self.assertEqual(self.gate()[0], 1)


if __name__ == "__main__":
    unittest.main()
