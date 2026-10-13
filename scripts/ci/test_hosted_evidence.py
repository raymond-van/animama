"""Hosted reuse must prove the exact merged tree, baseline and full run."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import unittest
import urllib.error
import zipfile
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from hosted_evidence import MAX_BYTES, WORKFLOW_PATH, _download, bound_evidence, hosted_for_main
from validation_policy import SUITES, UNTIMED, _plan

REPO = "raymond-van/animama"
PREFIX = f"/repos/{REPO}"
HEAD, TREE, BASE, MERGE, TESTED = (character * 40 for character in "abcde")
NOW = datetime(2026, 9, 18, 12, tzinfo=UTC)
RUN_PATH = f"{PREFIX}/actions/runs/90"
RUNS_PATH = (
    f"{PREFIX}/actions/workflows/validate-public.yml/runs?event=pull_request&head_sha={HEAD}&per_page=100&page=1"
)
ARTIFACTS_PATH = f"{RUN_PATH}/artifacts?per_page=100&page=1"
JOBS_PATH = f"{RUN_PATH}/attempts/1/jobs?per_page=100&page=1"
SET_PATH = f"{PREFIX}/actions/artifacts/300"
SET_DIGEST = "sha256:" + "9" * 64


class Fixture:
    """A complete API and immutable ZIP fixture, with explicit corruptions per test."""

    def __init__(self):
        self.paths = []
        self.downloads = []
        self.selection = {
            "schema_version": 3,
            "event": "pull_request",
            "reusable": False,
            "diff_error": None,
            "source_commit": TESTED,
            "source_tree": TREE,
            "base": BASE,
            "merge_base": BASE,
            "head": HEAD,
            "pull_request": 7,
            "run_id": "90",
            "run_attempt": "1",
            "plan": _plan("full", "Full checks"),
        }
        self.receipt = {
            "schema_version": 3,
            "success": True,
            "selection": self.selection,
            "steps": {
                name: {"outcome": "success", "conclusion": "success"} for name in self.selection["plan"]["required"]
            },
            "checks": [
                {
                    "id": name,
                    "status": "passed",
                    "exit_code": 0,
                    "duration_seconds": 1.0,
                    "log_sha256": "f" * 64,
                    "command": ["test", name],
                }
                for name in sorted(set(self.selection["plan"]["required"]) - UNTIMED)
            ],
            "package_set": {
                "artifact_id": 300,
                "artifact_digest": SET_DIGEST,
                "manifest_sha256": "7" * 64,
                "source": {"commit": TESTED, "tree": TREE, "dirty": False},
                "consumer_receipt_sha256": "8" * 64,
                "promotion_suites": {name: "success" for name in sorted(SUITES["promotion"])},
            },
        }
        pr = {
            "number": 7,
            "merged": True,
            "merged_at": "2026-09-18T11:59:00Z",
            "merge_commit_sha": MERGE,
            "labels": [],
            "head": {"sha": HEAD, "repo": {"full_name": REPO}},
            "base": {"ref": "main", "repo": {"full_name": REPO}},
        }
        run = {
            "id": 90,
            "event": "pull_request",
            "head_sha": HEAD,
            "path": WORKFLOW_PATH,
            "workflow_id": 12,
            "repository": {"id": 123, "full_name": REPO},
            "head_repository": {"full_name": REPO},
            "status": "completed",
            "conclusion": "success",
            "run_attempt": 1,
            "updated_at": "2026-09-18T11:55:00Z",
        }
        self.artifact = {
            "id": 100,
            "name": f"validation-receipt-{TESTED}-1",
            "expired": False,
            "workflow_run": {"id": 90, "head_sha": HEAD, "repository_id": 123, "head_repository_id": 123},
        }
        self.responses = {
            f"{PREFIX}/commits/{MERGE}/pulls?per_page=100&page=1": [pr],
            f"{PREFIX}/pulls/7": pr,
            f"{PREFIX}/actions/workflows/validate-public.yml": {"id": 12, "path": WORKFLOW_PATH},
            RUNS_PATH: {"total_count": 1, "workflow_runs": [run]},
            RUN_PATH: run,
            ARTIFACTS_PATH: {"total_count": 1, "artifacts": [self.artifact]},
            JOBS_PATH: {"total_count": 1, "jobs": [{"name": "Validation", "conclusion": "success"}]},
            SET_PATH: {
                "id": 300,
                "name": f"animama-set-{TESTED}-1",
                "expired": False,
                "digest": SET_DIGEST,
                "expires_at": "2026-10-02T11:55:00Z",
                "workflow_run": {"id": 90},
            },
        }
        for commit in (MERGE, TESTED):
            self.responses[f"{PREFIX}/git/commits/{commit}"] = {
                "sha": commit,
                "tree": {"sha": TREE},
                "parents": [{"sha": BASE}, {"sha": HEAD}],
            }
        self.pack()

    def pack(self, extra=None):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("selection.json", json.dumps(self.selection))
            archive.writestr("validation.json", json.dumps(self.receipt))
            for check in self.receipt["checks"]:
                archive.writestr(f"checks/{check['id']}.json", json.dumps(check))
            for name, value in (extra or {}).items():
                archive.writestr(name, value)
        self.archive = output.getvalue()
        self.digest()

    def digest(self):
        self.artifact.update(
            size_in_bytes=len(self.archive), digest="sha256:" + hashlib.sha256(self.archive).hexdigest()
        )

    def get_json(self, path):
        self.paths.append(path)
        value = self.responses[path]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def get_archive(self, repository, artifact_id):
        self.downloads.append((repository, artifact_id))
        return self.archive

    def verify(self, **changes):
        arguments = {
            "source_commit": MERGE,
            "source_tree": TREE,
            "baseline": BASE,
            "now": NOW,
            "get_json": self.get_json,
            "get_archive": self.get_archive,
        }
        arguments.update(changes)
        event = arguments.pop(
            "event", {"ref": "refs/heads/main", "before": BASE, "after": MERGE, "repository": {"full_name": REPO}}
        )
        return hosted_for_main(event, **arguments)


class HostedEvidenceTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO})
        environment.start()
        self.addCleanup(environment.stop)

    def test_exact_full_merge_records_traceable_evidence(self):
        fixture = Fixture()
        result = fixture.verify()
        self.assertTrue(result["accepted"])
        self.assertEqual(result["tested_commit"], TESTED)
        self.assertEqual(result["source_commit"], MERGE)
        self.assertEqual(result["artifact_digest"], fixture.artifact["digest"])
        self.assertEqual(result["run_url"], f"https://github.com/{REPO}/actions/runs/90")
        self.assertEqual(fixture.downloads, [(REPO, 100)])
        package_set = result["package_set"]
        self.assertEqual(
            (package_set["artifact_id"], package_set["artifact_name"], package_set["artifact_digest"]),
            (300, f"animama-set-{TESTED}-1", SET_DIGEST),
        )
        self.assertEqual(package_set["source"]["commit"], TESTED)
        self.assertEqual(package_set["source"]["tree"], TREE)
        self.assertEqual(package_set["tested_commit_parents"], [BASE, HEAD])
        self.assertEqual(package_set["expires_at"], "2026-10-02T11:55:00Z")

    def test_reuse_requires_a_live_set_bound_to_the_tested_merge(self):
        for kind in (
            "absent",
            "expired",
            "renamed",
            "digest",
            "foreign_run",
            "commit",
            "tree",
            "suites",
            "step",
            "bad_id",
        ):
            with self.subTest(kind=kind):
                fixture = Fixture()
                artifact, recorded = fixture.responses[SET_PATH], fixture.receipt["package_set"]
                if kind == "absent":
                    del fixture.receipt["package_set"]
                elif kind == "expired":
                    artifact["expired"] = True
                elif kind == "renamed":
                    artifact["name"] = f"animama-set-{HEAD}-1"
                elif kind == "digest":
                    artifact["digest"] = "sha256:" + "0" * 64
                elif kind == "foreign_run":
                    artifact["workflow_run"]["id"] = 91
                elif kind == "commit":
                    recorded["source"]["commit"] = HEAD
                elif kind == "tree":
                    recorded["source"]["tree"] = BASE
                elif kind == "suites":
                    recorded["promotion_suites"] = recorded["promotion_suites"] | {"package-build": "skipped"}
                elif kind == "step":
                    fixture.receipt["steps"]["package-consumers"]["outcome"] = "skipped"
                else:
                    recorded["artifact_id"] = "300"
                fixture.pack()
                self.assertFalse(fixture.verify()["accepted"])

    def test_source_baseline_and_head_must_match_both_merge_commits(self):
        for commit in (MERGE, TESTED):
            for field in ("tree", "baseline", "head"):
                with self.subTest(commit=commit, field=field):
                    fixture = Fixture()
                    value = fixture.responses[f"{PREFIX}/git/commits/{commit}"]
                    if field == "tree":
                        value["tree"]["sha"] = "f" * 40
                    else:
                        value["parents"][0 if field == "baseline" else 1]["sha"] = "f" * 40
                    self.assertFalse(fixture.verify()["accepted"])

    def test_older_feature_ancestry_is_safe_when_tested_merge_baseline_matches(self):
        fixture = Fixture()
        fixture.selection["merge_base"] = "f" * 40
        fixture.pack()
        self.assertTrue(fixture.verify()["accepted"])

    def test_receipt_identity_and_attempt_must_match(self):
        changes = {
            "source_tree": "f" * 40,
            "base": "f" * 40,
            "merge_base": "not-a-sha",
            "head": "f" * 40,
            "run_id": "91",
            "run_attempt": "2",
            "pull_request": 8,
            "event": "push",
            "reusable": True,
            "diff_error": "unknown",
        }
        for key, value in changes.items():
            with self.subTest(field=key):
                fixture = Fixture()
                fixture.selection[key] = value
                fixture.pack()
                self.assertFalse(fixture.verify()["accepted"])

    def test_workflow_repository_and_run_must_be_successful(self):
        changes = {
            "path": ".github/workflows/other.yml",
            "workflow_id": 99,
            "head_sha": "f" * 40,
            "event": "push",
            "status": "in_progress",
            "conclusion": "failure",
            "head_repository": {"full_name": "someone/fork"},
        }
        for key, value in changes.items():
            with self.subTest(field=key):
                fixture = Fixture()
                fixture.responses[RUN_PATH][key] = value
                self.assertFalse(fixture.verify()["accepted"])

    def test_latest_failed_run_cannot_be_hidden_by_older_success(self):
        fixture = Fixture()
        newer = copy.deepcopy(fixture.responses[RUN_PATH]) | {"id": 91, "conclusion": "failure"}
        fixture.responses[RUNS_PATH]["workflow_runs"].append(newer)
        fixture.responses[RUNS_PATH]["total_count"] = 2
        fixture.responses[f"{PREFIX}/actions/runs/91"] = newer
        self.assertFalse(fixture.verify()["accepted"])
        self.assertEqual(fixture.downloads, [])

    def test_newer_metadata_only_skipped_run_does_not_hide_full_run(self):
        fixture = Fixture()
        newer = copy.deepcopy(fixture.responses[RUN_PATH]) | {"id": 91}
        fixture.responses[RUNS_PATH]["workflow_runs"].append(newer)
        fixture.responses[RUNS_PATH]["total_count"] = 2
        fixture.responses[f"{PREFIX}/actions/runs/91"] = newer
        fixture.responses[f"{PREFIX}/actions/runs/91/attempts/1/jobs?per_page=100&page=1"] = {
            "total_count": 1,
            "jobs": [{"name": "Validation", "conclusion": "skipped"}],
        }
        result = fixture.verify()
        self.assertTrue(result["accepted"])
        self.assertEqual(result["run_id"], 90)

    def test_stale_future_and_postmerge_runs_are_rejected(self):
        for timestamp in ("2026-09-10T11:55:00Z", "2026-09-19T11:55:00Z", "2026-09-18T11:59:30Z"):
            fixture = Fixture()
            fixture.responses[RUN_PATH]["updated_at"] = timestamp
            self.assertFalse(fixture.verify()["accepted"])

    def test_reduced_failed_or_incomplete_receipts_are_rejected(self):
        for kind in ("reduced", "selective", "old_schema", "failed", "step", "missing_check", "failed_check"):
            with self.subTest(kind=kind):
                fixture = Fixture()
                if kind == "reduced":
                    fixture.selection["plan"] = _plan("docs", "Documentation")
                elif kind == "selective":
                    # A full PR run that skipped the promotion suite is never promotion-complete.
                    fixture.selection["plan"] = _plan("selective", "Full PR", ["promotion"])
                elif kind == "old_schema":
                    fixture.receipt["schema_version"] = 2
                elif kind == "failed":
                    fixture.receipt["success"] = False
                elif kind == "step":
                    fixture.receipt["steps"]["backend-tests"]["outcome"] = "failure"
                elif kind == "missing_check":
                    fixture.receipt["checks"].pop()
                else:
                    fixture.receipt["checks"][0]["exit_code"] = 1
                fixture.pack()
                self.assertFalse(fixture.verify()["accepted"])

    def test_expired_missing_and_mismatched_artifacts_are_rejected(self):
        for kind in ("expired", "missing", "attempt", "digest", "provenance", "malformed", "traversal"):
            with self.subTest(kind=kind):
                fixture = Fixture()
                if kind == "expired":
                    fixture.artifact["expired"] = True
                elif kind == "missing":
                    fixture.responses[ARTIFACTS_PATH] = {"total_count": 0, "artifacts": []}
                elif kind == "attempt":
                    fixture.artifact["name"] = f"validation-receipt-{TESTED}-2"
                elif kind == "digest":
                    fixture.artifact["digest"] = "sha256:" + "0" * 64
                elif kind == "provenance":
                    fixture.artifact["workflow_run"]["head_repository_id"] = 999
                elif kind == "malformed":
                    fixture.archive = b"not a ZIP"
                    fixture.digest()
                else:
                    fixture.pack({"../outside.json": "{}"})
                self.assertFalse(fixture.verify()["accepted"])

    def test_rerun_ignores_prior_attempt_artifact(self):
        fixture = Fixture()
        prior = copy.deepcopy(fixture.artifact)
        prior["expired"] = True
        fixture.selection["run_attempt"] = "2"
        fixture.responses[RUN_PATH]["run_attempt"] = 2
        fixture.responses[f"{RUN_PATH}/attempts/2/jobs?per_page=100&page=1"] = fixture.responses[JOBS_PATH]
        fixture.artifact["name"] = f"validation-receipt-{TESTED}-2"
        fixture.responses[SET_PATH]["name"] = f"animama-set-{TESTED}-2"
        fixture.pack()
        fixture.responses[ARTIFACTS_PATH]["artifacts"].append(prior)
        fixture.responses[ARTIFACTS_PATH]["total_count"] = 2
        result = fixture.verify()
        self.assertTrue(result["accepted"])
        self.assertEqual(result["run_attempt"], 2)
        self.assertEqual(fixture.downloads, [(REPO, 100)])

    def test_ci_full_avoids_hosted_run_and_artifact_queries(self):
        fixture = Fixture()
        fixture.responses[f"{PREFIX}/pulls/7"]["labels"] = [{"name": "ci:full"}]
        self.assertFalse(fixture.verify()["accepted"])
        self.assertFalse(any("/actions/" in path for path in fixture.paths))
        self.assertEqual(fixture.downloads, [])

    def test_wrong_push_and_api_failures_fail_closed_without_secrets(self):
        fixture = Fixture()
        self.assertFalse(fixture.verify(event={})["accepted"])
        self.assertEqual(fixture.paths, [])
        fixture.responses[RUN_PATH] = RuntimeError("signed-secret-url")
        result = fixture.verify()
        self.assertFalse(result["accepted"])
        self.assertNotIn("signed-secret", result["reason"])

    def test_bound_evidence_requires_matching_source_and_push(self):
        evidence = Fixture().verify()
        selection = {
            "event": "push",
            "reusable": False,
            "source_commit": MERGE,
            "source_tree": TREE,
            "base": BASE,
            "hosted_evidence": evidence,
        }
        self.assertTrue(bound_evidence(selection))
        for changes in (
            {"source_commit": HEAD},
            {"source_tree": BASE},
            {"base": HEAD},
            {"event": "pull_request"},
            {"reusable": True},
            {"hosted_evidence": {}},
        ):
            self.assertFalse(bound_evidence(selection | changes))
        for changes in (
            {"accepted": False},
            {"workflow": "other.yml"},
            {"run_id": True},
            {"artifact_id": None},
            {"baseline": HEAD},
            {"package_set": None},
            {"tested_commit": HEAD},
        ):
            self.assertFalse(bound_evidence(selection | {"hosted_evidence": evidence | changes}))
        for changes in (
            {"artifact_name": f"animama-set-{HEAD}-1"},
            {"artifact_digest": "9" * 64},
            {"manifest_sha256": "short"},
            {"source": {"commit": TESTED, "tree": BASE}},
            {"tested_commit_parents": [HEAD, HEAD]},
            {"promotion_suites": []},
            {"promotion_suites": {"package-build": "success"}},
        ):
            package_set = evidence["package_set"] | changes
            self.assertFalse(bound_evidence(selection | {"hosted_evidence": evidence | {"package_set": package_set}}))


class ArtifactDownloadTests(unittest.TestCase):
    def test_signed_storage_redirect_does_not_receive_authorization(self):
        for host in ("results.blob.core.windows.net", "results.actions.githubusercontent.com"):
            with self.subTest(host=host):
                destination = f"https://{host}/archive?signature=test"
                redirect = urllib.error.HTTPError(
                    "https://api.github.com", 302, "Found", {"Location": destination}, None
                )
                response = MagicMock()
                response.read.return_value = b"receipt"
                opener = MagicMock()
                opener.open.side_effect = [redirect, response]
                with (
                    patch.dict(os.environ, {"CI_READ_TOKEN": "private-token"}),
                    patch("hosted_evidence.urllib.request.build_opener", return_value=opener),
                ):
                    self.assertEqual(_download(REPO, 100), b"receipt")
                initial, storage = [call.args[0] for call in opener.open.call_args_list]
                self.assertEqual(initial.get_header("Authorization"), "Bearer private-token")
                self.assertEqual(storage.full_url, destination)
                self.assertIsNone(storage.get_header("Authorization"))
                self.assertEqual(storage.header_items(), [])
                response.read.assert_called_once_with(MAX_BYTES + 1)

    def test_unsafe_storage_redirects_are_rejected_before_following(self):
        for destination in (
            "http://results.blob.core.windows.net/archive",
            "https://untrusted.example/archive",
            "https://results.blob.core.windows.net.evil.example/archive",
            "https://user:password@results.blob.core.windows.net/archive",
            "https://results.blob.core.windows.net:8443/archive",
        ):
            with self.subTest(destination=destination):
                redirect = urllib.error.HTTPError(
                    "https://api.github.com", 302, "Found", {"Location": destination}, None
                )
                opener = MagicMock()
                opener.open.side_effect = redirect
                with (
                    patch.dict(os.environ, {"CI_READ_TOKEN": "private-token"}),
                    patch("hosted_evidence.urllib.request.build_opener", return_value=opener),
                    self.assertRaises(ValueError),
                ):
                    _download(REPO, 100)
                self.assertEqual(opener.open.call_count, 1)

    def test_download_has_a_strict_byte_bound(self):
        response = MagicMock()
        response.read.return_value = b"x" * (MAX_BYTES + 1)
        opener = MagicMock()
        opener.open.return_value = response
        with (
            patch.dict(os.environ, {"CI_READ_TOKEN": "private-token"}),
            patch("hosted_evidence.urllib.request.build_opener", return_value=opener),
            self.assertRaisesRegex(ValueError, "size bound"),
        ):
            _download(REPO, 100)
        response.read.assert_called_once_with(MAX_BYTES + 1)


if __name__ == "__main__":
    unittest.main()
