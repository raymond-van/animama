"""Baseline set reuse accepts only verified sets for the same tree and producer."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import baseline_set
from validation_policy import choose_plan

REPOSITORY = "owner/animama"
BASELINE, TREE, TESTED = "a" * 40, "b" * 40, "c" * 40
PREFIX = f"/repos/{REPOSITORY}"
RUN = 500
RUNS = f"{PREFIX}/actions/workflows/validate-public.yml/runs?head_sha={BASELINE}&status=success&per_page=100&page=1"


def receipt_zip(selection: dict) -> bytes:
    steps = {name: {"outcome": "success", "conclusion": "success"} for name in selection["plan"]["required"]}
    checks = []
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name in selection["plan"]["required"]:
            check = {"id": name, "status": "passed", "exit_code": 0}
            checks.append(check)
            archive.writestr(f"checks/{name}.json", json.dumps(check))
        receipt = {"schema_version": 3, "success": True, "selection": selection, "steps": steps, "checks": checks}
        archive.writestr("selection.json", json.dumps(selection))
        archive.writestr("validation.json", json.dumps(receipt))
    return buffer.getvalue()


class Fixture:
    def __init__(self, mode="full"):
        plan = choose_plan("workflow_dispatch", {}, None) if mode == "full" else None
        self.selection = {
            "schema_version": 3,
            "event": "workflow_dispatch",
            "source_commit": BASELINE,
            "source_tree": TREE,
            "run_id": str(RUN),
            "plan": plan,
        }
        set_name = f"animama-set-{BASELINE}-1"
        if mode == "reused":
            self.selection["event"] = "push"
            self.selection["plan"] = choose_plan(
                "push",
                {"ref": "refs/heads/main"},
                [{"status": "M", "old_path": None, "path": "uv.lock"}],
                hosted_verified=True,
            )
            set_name = f"animama-set-{TESTED}-1"
            self.selection["hosted_evidence"] = {
                "run_id": 90,
                "package_set": {
                    "artifact_id": 77,
                    "artifact_name": set_name,
                    "artifact_digest": "sha256:" + "d" * 64,
                    "source": {"commit": TESTED, "tree": TREE},
                },
            }
        self.run = {
            "id": RUN,
            "event": self.selection["event"],
            "head_branch": "main",
            "head_sha": BASELINE,
            "path": ".github/workflows/validate-public.yml",
            "repository": {"full_name": REPOSITORY},
            "conclusion": "success",
            "run_attempt": 1,
        }
        self.receipt_artifact = {
            "id": 66,
            "name": f"validation-receipt-{BASELINE}-1",
            "expired": False,
            "size_in_bytes": 100,
            "workflow_run": {"id": RUN},
        }
        self.set_artifact = {
            "id": 77,
            "name": set_name,
            "expired": False,
            "size_in_bytes": 1000,
            "workflow_run": {"id": 90 if mode == "reused" else RUN},
            "digest": "sha256:" + "d" * 64,
        }

    def responses(self):
        data = receipt_zip(self.selection)
        self.receipt_artifact["digest"] = "sha256:" + hashlib.sha256(data).hexdigest()
        listing = [self.receipt_artifact]
        if self.set_artifact["workflow_run"]["id"] == RUN:
            listing.append(self.set_artifact)
        return data, {
            RUNS: {"workflow_runs": [self.run]},
            f"{PREFIX}/actions/runs/{RUN}/artifacts?per_page=100&page=1": {
                "total_count": len(listing),
                "artifacts": listing,
            },
            f"{PREFIX}/actions/artifacts/77": self.set_artifact,
        }

    def find(self):
        data, responses = self.responses()
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": REPOSITORY}):
            return baseline_set.find(BASELINE, TREE, fetch=responses.__getitem__, download=lambda *_: data)


class FindTests(unittest.TestCase):
    def test_full_main_run_names_its_own_set(self):
        evidence = Fixture().find()
        self.assertEqual(
            (evidence["run_id"], evidence["artifact"]["id"], evidence["source_commit"]), (RUN, 77, BASELINE)
        )

    def test_reused_main_run_names_the_pr_set_for_the_same_tree(self):
        evidence = Fixture("reused").find()
        self.assertEqual((evidence["run_id"], evidence["source_commit"]), (90, TESTED))

    def test_unverifiable_sets_are_refused(self):
        corruptions = {
            "expired": lambda f: f.set_artifact.update(expired=True),
            "renamed": lambda f: f.set_artifact.update(name="animama-set-other-1"),
            "foreign_run": lambda f: f.set_artifact["workflow_run"].update(id=999),
            "pr_event": lambda f: f.run.update(event="pull_request"),
            "branch": lambda f: f.run.update(head_branch="feature"),
            "tree": lambda f: f.selection.update(source_tree="e" * 40),
            "selective": lambda f: f.selection.update(
                plan=choose_plan(
                    "pull_request",
                    {"action": "opened", "pull_request": {"draft": False, "labels": []}},
                    [{"status": "M", "old_path": None, "path": "tests/test_chat.py"}],
                )
            ),
        }
        for name, corrupt in corruptions.items():
            with self.subTest(name=name):
                fixture = Fixture()
                corrupt(fixture)
                with self.assertRaises(ValueError):
                    fixture.find()
        fixture = Fixture("reused")
        fixture.selection["hosted_evidence"]["package_set"]["source"]["tree"] = "e" * 40
        with self.assertRaises(ValueError):
            fixture.find()
        fixture = Fixture("reused")
        fixture.set_artifact["digest"] = "sha256:" + "f" * 64
        with self.assertRaises(ValueError):
            fixture.find()


class RecipeAndArchiveTests(unittest.TestCase):
    def manifest(self, **recipe):
        base = {"scripts/package-sets/build.py": "1" * 64, "contracts/versions.json": "2" * 64}
        tools = {"python": "3.12.13", "uv": "0.11.28", "node": "24.15.0", "pnpm": "10.33.0"}
        return {"build": {"recipe": base | recipe, **tools}}

    def test_only_contract_inputs_may_differ(self):
        self.assertTrue(baseline_set.recipe_compatible(self.manifest(), self.manifest()))
        changed = self.manifest(**{"contracts/versions.json": "3" * 64})
        self.assertTrue(baseline_set.recipe_compatible(self.manifest(), changed))
        changed = self.manifest(**{"scripts/package-sets/build.py": "3" * 64})
        self.assertFalse(baseline_set.recipe_compatible(self.manifest(), changed))
        extra = copy.deepcopy(self.manifest())
        extra["build"]["recipe"]["scripts/package-sets/application.py"] = "4" * 64
        self.assertFalse(baseline_set.recipe_compatible(self.manifest(), extra))
        toolchain = copy.deepcopy(self.manifest())
        toolchain["build"]["node"] = "24.16.0"
        self.assertFalse(baseline_set.recipe_compatible(self.manifest(), toolchain))

    def fetch(self, members: dict[str, bytes], digest: str | None = None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, data in members.items():
                archive.writestr(name, data)
        data = buffer.getvalue()
        artifact = {"id": 1, "digest": digest or "sha256:" + hashlib.sha256(data).hexdigest()}
        destination = Path(tempfile.mkdtemp()) / "set"
        with patch("baseline_set._open_artifact", return_value=io.BytesIO(data)):
            baseline_set.fetch_set(REPOSITORY, artifact, destination)
        return destination

    def test_archives_are_digest_checked_and_safely_extracted(self):
        destination = self.fetch({"manifest.json": b"{}", "packages/a.whl": b"x"})
        self.assertEqual((destination / "packages/a.whl").read_bytes(), b"x")
        with self.assertRaises(ValueError):
            self.fetch({"manifest.json": b"{}"}, digest="sha256:" + "0" * 64)
        for name in ("../escape", "/abs", "a/../../b", "a\\b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.fetch({name: b"x"})


TOOLS = {"python": "3.12.13", "uv": "0.11.28", "node": "24.15.0", "pnpm": "10.33.0"}


class RunTests(unittest.TestCase):
    def args(self, root: Path):
        candidate = root / "candidate"
        candidate.mkdir()
        recipe = {"scripts/package-sets/build.py": "1" * 64}
        (candidate / "manifest.json").write_text(json.dumps({"build": {"recipe": recipe, **TOOLS}}))
        return baseline_set.argparse.Namespace(
            baseline=BASELINE, checkout=root, candidate=candidate, work=root, record=root / "record.json"
        )

    def run_with(self, find, recipe="1"):
        root = Path(tempfile.mkdtemp())
        args = self.args(root)

        def fetch(repository, artifact, destination):
            destination.mkdir(parents=True)
            manifest = {
                "source": {"commit": BASELINE, "tree": TREE},
                "build": {"recipe": {"scripts/package-sets/build.py": recipe * 64}, **TOOLS},
            }
            (destination / "manifest.json").write_text(json.dumps(manifest))

        calls = []

        def run(command, **kwargs):
            calls.append(command)
            return type("Result", (), {"returncode": 0})()

        with (
            patch.dict(os.environ, {"GITHUB_REPOSITORY": REPOSITORY}),
            patch("baseline_set.subprocess.check_output", return_value=TREE + "\n"),
            patch("baseline_set.find", side_effect=find),
            patch("baseline_set.fetch_set", side_effect=fetch),
            patch("baseline_set.subprocess.run", side_effect=run),
            patch("sys.stdout", io.StringIO()),
        ):
            code = baseline_set.run(args)
        return code, json.loads(args.record.read_text()), [command[2] for command in calls]

    def test_verified_retained_set_skips_the_rebuild(self):
        evidence = {
            "run_id": RUN,
            "artifact": {"id": 77, "name": "n", "digest": "sha256:" + "d" * 64},
            "source_commit": BASELINE,
        }
        code, record, steps = self.run_with(lambda *a: evidence)
        self.assertEqual((code, record["path"], record["artifact_id"]), (0, "retained", 77))
        self.assertEqual(steps, ["compare"])

    def test_missing_or_incompatible_sets_rebuild_the_baseline(self):
        def missing(*args):
            raise ValueError("No retained validated set for the baseline")

        code, record, steps = self.run_with(missing)
        self.assertEqual((record["path"], record["reason"]), ("rebuilt", "No retained validated set for the baseline"))
        self.assertEqual(steps, ["models", "build", "compare"])
        evidence = {"run_id": RUN, "artifact": {"id": 77, "name": "n", "digest": "x"}, "source_commit": BASELINE}
        code, record, steps = self.run_with(lambda *a: evidence, recipe="2")
        self.assertEqual(
            (record["path"], record["reason"]), ("rebuilt", "Packaging producer changed since the baseline")
        )
        self.assertEqual(steps, ["models", "build", "compare"])


if __name__ == "__main__":
    unittest.main()
