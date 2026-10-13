"""Selection and single-job acceptance stay conservative at input boundaries."""

from __future__ import annotations

import copy
import unittest

from validation_policy import BASE, PROFILES, SUITES, choose_plan, classify, evaluate, select_suites


def event(action="synchronize", draft=False, labels=()):
    return {"action": action, "pull_request": {"draft": draft, "labels": [{"name": name} for name in labels]}}


def main_event():
    return {"ref": "refs/heads/main", "before": "a" * 40, "after": "b" * 40}


def modified(path):
    return {"status": "M", "old_path": None, "path": path}


def results(plan):
    return {name: {"outcome": "success", "conclusion": "success"} for name in plan["required"]}


class ClassificationTests(unittest.TestCase):
    def test_reduced_path_allowlist(self):
        for path, area in {
            "docs/backend/operations/development.md": "docs",
            "tests/test_chat.py": "backend",
            "src/backend/animama/app/services/memory_entry_diff.py": "backend",
            "src/frontend/web/src/ui/components/button.tsx": "web",
            "src/frontend/web/src/ui/components/card.tsx": "web",
            "src/frontend/web/src/ui/components/input.tsx": "web",
        }.items():
            self.assertEqual(classify([modified(path)]), area, path)

    def test_high_risk_and_unknown_paths_never_reduce_with_review(self):
        paths = [
            "README.md",
            "AGENTS.md",
            "docs/AGENTS.md",
            "docs/SKILL.md",
            "docs/PLANS.md",
            "docs/configuration.json",
            "docs/script.py",
            "docs/package.json",
            "docs/safety/crisis-protocol.md",
            "package.json",
            "src/backend/animama/app/services/chat.py",
            "tests/conftest.py",
            "tests/fixtures/test_shared.py",
            "tests/test_fixture_helper.py",
            "tests/test_support.py",
            "tests/test_accountless_repository_boundaries.py",
            "tests/test_compose_network_boundaries.py",
            "tests/test_desktop_runtime_packaging.py",
            "tests/test_included_content_integrity.py",
            "tests/test_model_store.py",
            "tests/test_browser_model_store.py",
            "tests/test_generate_synthetic_docs.py",
            "src/frontend/desktop/src/main.cts",
            "src/frontend/web/src/main.local.tsx",
            "src/frontend/web/src/routes/index.tsx",
            "src/frontend/web/src/ui/script.js",
            "src/frontend/web/src/ui/create-anima/createAnimaDraftStorage.ts",
            "src/frontend/web/src/ui/sidebar/ApplicationSettingsModal.tsx",
            "src/frontend/web/src/ui/components/model-selector.tsx",
            "src/frontend/web/src/ui/components/new-control.tsx",
            "src/frontend/web/src/components/Button.tsx",
            "src/frontend/web/vite.config.ts",
            "src/frontend/web/public/image.png",
            "src/frontend/packages/runtime-contracts/src/index.ts",
            "src/frontend/desktop/resources/runtime.py",
            "src/frontend/e2e/journeys/library.spec.ts",
            "src/frontend/pnpm-lock.yaml",
            "uv.lock",
            "pyproject.toml",
            "docker-compose.yml",
            ".github/workflows/validate-public.yml",
            "scripts/ci/validation_policy.py",
            "content/included/guide.md",
            "unknown/file.md",
        ]
        paths += [
            f"src/frontend/web/src/ui/{name}.tsx"
            for name in (
                "Chat",
                "Avatar",
                "voice",
                "speech",
                "Canvas",
                "content",
                "owner",
                "credentials",
                "bootstrap",
                "auth",
                "runtime",
                "generated/client",
                "vendor/Control",
                "catalog/data",
                "routeTree.gen",
            )
        ]
        for path in paths:
            self.assertEqual(classify([modified(path)]), "full", path)
            # Full PR runs may still skip suites whose inputs did not change.
            mode = choose_plan("pull_request", event(), [modified(path)], local_reviewed=True)["mode"]
            self.assertIn(mode, {"full", "selective"}, path)
            self.assertEqual(choose_plan("push", main_event(), [modified(path)], local_reviewed=True)["mode"], "full")

    def test_nonmodifications_rename_sides_and_mixed_areas(self):
        for status in ("A", "D", "R", "R100", "C", "C100", "T", "U", "M ", None, []):
            self.assertEqual(classify([{"status": status, "old_path": None, "path": "docs/new.md"}]), "full")
        for old, new in (
            ("docs/old.md", "docs/new.md"),
            ("scripts/ci/validation.py", "docs/a.md"),
            ("docs/a.md", "scripts/ci/validation.py"),
        ):
            for status in ("M", "R100"):
                self.assertEqual(classify([{"status": status, "old_path": old, "path": new}]), "full")
        for paths in (
            ["docs/a.md", "tests/test_chat.py"],
            ["tests/test_chat.py", "src/frontend/web/src/ui/components/label.tsx"],
            ["docs/a.md", "uv.lock"],
        ):
            self.assertEqual(classify([modified(path) for path in paths]), "full")
        self.assertEqual(classify([modified("docs/a.md"), modified("docs/b.md")]), "docs")

    def test_caller_exclusions_and_malformed_classification_inputs(self):
        for path in ("docs/notice.md", "src/frontend/web/src/ui/components/button.tsx", "tests/test_chat.py"):
            self.assertEqual(classify([modified(path)], excluded_paths=[path]), "full")
        self.assertEqual(classify([modified("docs/a.md")], excluded_paths=["docs/other.md"]), "docs")
        for changes in (None, [], {}, (), [{}], [None], [modified("docs/a.md") | {"extra": True}]):
            self.assertEqual(classify(changes), "full")
        for path in (
            None,
            [],
            "",
            "../docs/a.md",
            "/docs/a.md",
            "docs//a.md",
            "docs/./a.md",
            "docs/../a.md",
            "docs/a\n.md",
            "docs\\a.md",
            "docs/a\x00.md",
        ):
            self.assertEqual(classify([modified(path)]), "full")
        for excluded in (None, "docs/a.md", [[]], [False], ["../docs/a.md"]):
            self.assertEqual(classify([modified("docs/a.md")], excluded_paths=excluded), "full")


class SelectionTests(unittest.TestCase):
    def test_hosted_reuse_is_only_for_verified_main_pushes(self):
        changes = [modified("uv.lock")]
        self.assertEqual(choose_plan("push", main_event(), changes, hosted_verified=True)["mode"], "reused")
        for name, value, kwargs in (
            ("pull_request", event(), {}),
            ("workflow_dispatch", {}, {}),
            ("schedule", {}, {}),
            ("push", {"ref": "refs/heads/feature"}, {}),
            ("push", main_event(), {"reusable": True}),
            ("push", main_event(), {"diff_error": "missing"}),
        ):
            self.assertEqual(choose_plan(name, value, changes, hosted_verified=True, **kwargs)["mode"], "full")

    def test_local_code_evidence_replaces_expensive_hosted_work_on_pr_and_main(self):
        for path, mode in (("tests/test_chat.py", "backend"), ("src/frontend/web/src/ui/components/label.tsx", "web")):
            for name, value in (("pull_request", event()), ("push", main_event())):
                for reviewed in (False, True, 1, "true", None):
                    plan = choose_plan(name, value, [modified(path)], local_reviewed=reviewed)
                    unreviewed = "selective" if name == "pull_request" and path.startswith("tests/") else "full"
                    self.assertEqual(plan["mode"], mode if reviewed is True else unreviewed)
                    if reviewed is True:
                        for omitted in ("backend-tests", "browser-smoke", "package-build"):
                            self.assertNotIn(omitted, plan["required"])
                        self.assertIn("audit", plan["required"])

    def test_docs_remain_minimal_on_pr_and_main_without_receipts(self):
        for name, value in (("pull_request", event()), ("push", main_event())):
            plan = choose_plan(name, value, [modified("docs/guide.md")])
            self.assertEqual(plan["mode"], "docs")
            self.assertIn("docs-tests", plan["required"])
            for omitted in (
                "hydrate",
                "browser-install",
                "model-inputs",
                "node",
                "pnpm-install",
                "backend-tests",
                "browser-smoke",
            ):
                self.assertNotIn(omitted, plan["required"])

    def test_draft_ready_label_and_base_edit_transitions(self):
        for action in (
            "opened",
            "synchronize",
            "reopened",
            "ready_for_review",
            "converted_to_draft",
            "labeled",
            "unlabeled",
            "edited",
        ):
            for draft in (False, True):
                for labels in ([], ["documentation"], ["ci:full"], ["documentation", "ci:full"]):
                    for path, mode in (("docs/a.md", "docs"), ("tests/test_chat.py", "backend")):
                        expected = "full" if "ci:full" in labels else "deferred" if draft else mode
                        value = event(action, draft, labels)
                        if action == "edited":
                            value["changes"] = {"base": {"ref": {"from": "checkpoint"}}}
                        self.assertEqual(
                            choose_plan("pull_request", value, [modified(path)], local_reviewed=True)["mode"], expected
                        )
        # Caller rejects stale receipt binding after a base change.
        self.assertEqual(
            choose_plan("pull_request", event("edited"), [modified("tests/test_chat.py")], local_reviewed=False)[
                "mode"
            ],
            "selective",
        )

    def test_manual_reusable_release_unknown_and_periodic_callers(self):
        for name in ("workflow_dispatch", "workflow_call", "release", "unknown", "", None, []):
            self.assertEqual(
                choose_plan(
                    name, event(draft=True), [modified("docs/a.md")], local_reviewed=True, periodic_unchanged=True
                )["mode"],
                "full",
            )
        for name, value in (("pull_request", event(draft=True)), ("push", main_event()), ("schedule", {})):
            self.assertEqual(
                choose_plan(name, value, [modified("docs/a.md")], reusable=True, periodic_unchanged=True)["mode"],
                "full",
            )
        for unchanged in (False, None, 1, "true", [], {}):
            self.assertEqual(choose_plan("schedule", {}, None, periodic_unchanged=unchanged)["mode"], "full")
        plan = choose_plan("schedule", {}, None, periodic_unchanged=True)
        self.assertEqual(plan["mode"], "unchanged")
        self.assertEqual(set(plan["required"]), BASE)

    def test_malformed_events_and_missing_diff_fall_back(self):
        events = [None, {}, {"action": []}, event("unknown"), event(draft="false"), event()]
        events[-1]["pull_request"]["labels"] = [{"name": []}]
        for value in events:
            self.assertEqual(choose_plan("pull_request", value, [modified("docs/a.md")])["mode"], "full")
        for pr in ([], None, {"draft": False, "labels": None}, {"draft": False, "labels": [None]}):
            self.assertEqual(
                choose_plan("pull_request", {"action": "opened", "pull_request": pr}, [modified("docs/a.md")])["mode"],
                "full",
            )
        for value in (None, {}, {"ref": "refs/heads/other"}, {"ref": []}):
            self.assertEqual(choose_plan("push", value, [modified("docs/a.md")], local_reviewed=True)["mode"], "full")
        for name, value in (("pull_request", event()), ("push", main_event())):
            for changes in (None, [], [{}]):
                self.assertEqual(choose_plan(name, value, changes, local_reviewed=True)["mode"], "full")
            self.assertEqual(
                choose_plan(name, value, [modified("docs/a.md")], diff_error="missing merge base", local_reviewed=True)[
                    "mode"
                ],
                "full",
            )


class AggregateTests(unittest.TestCase):
    def plans(self):
        return [
            choose_plan("workflow_dispatch", {}, None),
            choose_plan("pull_request", event(), [modified("docs/a.md")]),
            choose_plan("push", main_event(), [modified("tests/test_chat.py")], local_reviewed=True),
            choose_plan(
                "pull_request",
                event(),
                [modified("src/frontend/web/src/ui/components/button.tsx")],
                local_reviewed=True,
            ),
            choose_plan("schedule", {}, None, periodic_unchanged=True),
        ]

    def test_schema_three_success_and_intentionally_omitted_steps(self):
        for plan in self.plans():
            self.assertEqual(plan["schema_version"], 3)
            self.assertEqual(set(plan), {"schema_version", "mode", "reason", "required", "skipped"})
            self.assertTrue(evaluate(plan, results(plan))["success"])
            steps = results(plan) | {"unselected-check": {"outcome": "skipped", "conclusion": "skipped"}}
            self.assertTrue(evaluate(plan, steps)["success"])
            steps["artifact-upload"] = {"outcome": "success", "conclusion": "success"}
            self.assertTrue(evaluate(plan, steps)["success"])

    def test_every_required_step_must_succeed_without_continue_on_error_masking(self):
        plan = self.plans()[0]
        self.assertGreater(len(plan["required"]), 20)
        for name in plan["required"]:
            steps = results(plan)
            del steps[name]
            self.assertFalse(evaluate(plan, steps)["success"], name)
            for value in ("skipped", "failure", "cancelled", "timed_out", "unknown", None, []):
                for outcome, conclusion in ((value, value), (value, "success"), ("success", value)):
                    steps = results(plan)
                    steps[name] = {"outcome": outcome, "conclusion": conclusion}
                    self.assertFalse(evaluate(plan, steps)["success"], (name, outcome, conclusion))

    def test_unselected_failed_work_cannot_be_hidden(self):
        plan = self.plans()[1]
        for value in ("failure", "cancelled", "timed_out", "unknown", None, [], {}):
            for conclusion in (value, "success"):
                steps = results(plan) | {"unexpected-check": {"outcome": value, "conclusion": conclusion}}
                self.assertFalse(evaluate(plan, steps)["success"])

    def test_missing_malformed_steps_and_invalid_required_sets(self):
        for plan in self.plans():
            for value in (None, [], {}, {"checkout": {"outcome": "success", "conclusion": "success"}}):
                self.assertFalse(evaluate(plan, value)["success"])
            for value in (None, [], "success", {}, {"result": "success"}, {"outcome": "success"}):
                steps = results(plan)
                steps["checkout"] = value
                self.assertFalse(evaluate(plan, steps)["success"])
            for key, value in (
                ("schema_version", True),
                ("schema_version", 2),
                ("schema_version", "3"),
                ("mode", []),
                ("mode", "unknown"),
                ("reason", ""),
                ("reason", None),
                ("required", None),
                ("required", []),
                ("required", {}),
                ("required", plan["required"][:-1]),
                ("required", plan["required"] + ["unexpected"]),
                ("required", plan["required"] + [plan["required"][0]]),
                ("required", list(reversed(plan["required"]))),
                ("required", tuple(plan["required"])),
                ("required", [[]]),
            ):
                changed = copy.deepcopy(plan)
                changed[key] = value
                self.assertFalse(evaluate(changed, results(plan))["success"])
            self.assertFalse(evaluate(plan | {"allow_failure": True}, results(plan))["success"])
        self.assertFalse(evaluate(None, {})["success"])
        full = self.plans()[0]
        self.assertFalse(evaluate(full | {"mode": "docs"}, results(full))["success"])

    def test_deferred_never_accepts_even_when_setup_succeeds(self):
        plan = choose_plan("pull_request", event(draft=True), [])
        self.assertEqual(plan["mode"], "deferred")
        self.assertFalse(evaluate(plan, results(plan))["success"])
        all_success = {name: {"outcome": "success", "conclusion": "success"} for name in BASE | PROFILES["full"]}
        self.assertFalse(evaluate(plan, all_success)["success"])


ALL_SUITES = sorted(SUITES)


def skipped(plan):
    return sorted(row["suite"] for row in plan["skipped"])


class SuiteSelectionTests(unittest.TestCase):
    """Full PR runs skip expensive suites only when none of their inputs changed."""

    def test_paths_select_only_the_suites_they_can_affect(self):
        for path, suites in {
            # Not packaged and not exercised by a selectable browser group.
            "tests/test_chat.py": set(),
            "tests/conftest.py": set(),
            "docs/guide.md": set(),
            "SDLC.md": set(),
            "src/frontend/desktop/src/main.cts": set(),
            "src/frontend/desktop/tests/runtime-ipc.test.ts": set(),
            "src/frontend/desktop/electron-builder.yml": set(),
            "src/frontend/e2e/journeys/library.spec.ts": set(),
            "docker-compose.yml": set(),
            "reset.sh": set(),
            "scripts/public-release/check.py": set(),
            "src/frontend/web/scripts/setup-downloads.browser.test.mjs": set(),
            "src/frontend/web/scripts/effects.test.mjs": set(),
            "src/frontend/web/tests/fixtures/setup-downloads/main.tsx": set(),
            # Tooling previews and their renderer stages.
            "src/frontend/web/scripts/effect-check.mjs": {"browser-tooling"},
            "src/frontend/web/scripts/animation-preview/review.mjs": {"browser-tooling"},
            "src/frontend/web/scripts/effect-render.browser.test.mjs": {"browser-tooling"},
            "src/frontend/web/scripts/effect-render/stage.ts": set(ALL_SUITES),
            # Hosted-screen fixtures and tests.
            "src/frontend/web/scripts/hosted-workflows.browser.test.mjs": {"browser-hosted"},
            "src/frontend/web/tests/fixtures/hosted-composition/main.tsx": {"browser-hosted"},
            "src/frontend/web/tests/fixtures/retained-screens/main.tsx": {"browser-hosted"},
            # Shared browser setup, also copied into the whole-application consumer.
            "src/frontend/web/scripts/fixtures/hosted-workflows-http.mjs": set(ALL_SUITES),
            # Every packaging input selects every suite, so its PR run is promotion-complete.
            "src/backend/animama/app/services/chat.py": set(ALL_SUITES),
            "alembic/versions/0001_baseline.sql": set(ALL_SUITES),
            "README.md": set(ALL_SUITES),
            "licenses/pocket-tts.txt": set(ALL_SUITES),
            "src/frontend/desktop/runtime/notices/onnxruntime.txt": set(ALL_SUITES),
            "src/frontend/desktop/scripts/runtime/licenses.mjs": set(ALL_SUITES),
            "scripts/package-sets/build.py": set(ALL_SUITES),
            "scripts/repository-boundary/consumers/hosted-app/verify.mjs": set(ALL_SUITES),
            # Read by the shared Vite configuration as well as the hosted build.
            "src/frontend/desktop/package.json": set(ALL_SUITES),
            "models/browser-speech/manifest.json": set(ALL_SUITES),
            "scripts/models/parakeet.py": set(ALL_SUITES),
            "src/frontend/desktop/assets/icon.png": set(ALL_SUITES),
            # The web app, its packages and Included content reach every suite.
            "src/frontend/web/src/ui/components/button.tsx": set(ALL_SUITES),
            "src/frontend/packages/product-ui/src/index.ts": set(ALL_SUITES),
            "src/frontend/scripts/hosted-build-resources.mjs": set(ALL_SUITES),
            "content/included/vfx/sparkle/effect.json": set(ALL_SUITES),
            "docs/safety/crisis-protocol.md": set(ALL_SUITES),
            "contracts/versions.json": set(ALL_SUITES),
            "src/frontend/web/scripts/generate-routes.mjs": set(ALL_SUITES),
        }.items():
            self.assertEqual(select_suites([modified(path)]), suites, path)

    def test_selection_fails_closed(self):
        for path in (
            ".github/workflows/validate-public.yml",
            "scripts/ci/validation_policy.py",
            "uv.lock",
            "pyproject.toml",
            "src/frontend/pnpm-lock.yaml",
            "src/frontend/package.json",
            "src/frontend/web/package.json",
            "src/frontend/web/vite.config.ts",
            "src/frontend/web/vite-plugins/app-version.ts",
            "src/frontend/patches/vite.patch",
            "scripts/content/import.py",
            "unknown/file.txt",
            "Makefile.local",
        ):
            self.assertEqual(select_suites([modified(path)]), set(ALL_SUITES), path)
        for changes in (None, [], [{}], [None], [modified("docs/a.md") | {"extra": True}], [modified("../a")]):
            self.assertEqual(select_suites(changes), set(ALL_SUITES))
        # Special files (links, executables, LFS) and changed dependencies select everything.
        self.assertEqual(select_suites([modified("docs/a.md")], excluded_paths=["docs/a.md"]), set(ALL_SUITES))
        for excluded in (None, "docs/a.md", [[]], ["../a"]):
            self.assertEqual(select_suites([modified("docs/a.md")], excluded_paths=excluded), set(ALL_SUITES))
        # Both sides of a rename count.
        rename = {"status": "R100", "old_path": "src/frontend/web/scripts/effect-x.mjs", "path": "tests/test_x.py"}
        self.assertEqual(select_suites([rename]), {"browser-tooling"})
        self.assertEqual(
            select_suites([modified("tests/test_chat.py"), modified("src/frontend/web/scripts/effect-check.mjs")]),
            {"browser-tooling"},
        )

    def test_full_pr_runs_record_selective_skips(self):
        plan = choose_plan("pull_request", event(), [modified("tests/test_chat.py"), modified("tests/conftest.py")])
        self.assertEqual(plan["mode"], "selective")
        self.assertEqual(skipped(plan), ALL_SUITES)
        self.assertTrue(all(row["reason"] for row in plan["skipped"]))
        for step in SUITES["promotion"]:
            self.assertNotIn(step, plan["required"])
        for step in ("backend-tests", "web-tests", "browser-tests", "browser-smoke", "web-build", "compose-check"):
            self.assertIn(step, plan["required"])
        self.assertTrue(evaluate(plan, results(plan))["success"])

        tooling = choose_plan("pull_request", event(), [modified("src/frontend/web/scripts/effect-check.mjs")])
        self.assertEqual((tooling["mode"], skipped(tooling)), ("selective", ["browser-hosted", "promotion"]))
        hosted = choose_plan(
            "pull_request", event(), [modified("src/frontend/web/tests/fixtures/retained-screens/a.tsx")]
        )
        self.assertEqual((hosted["mode"], skipped(hosted)), ("selective", ["browser-tooling", "promotion"]))
        # A packaging change runs everything, so the PR run can serve promotion.
        backend = choose_plan("pull_request", event(), [modified("src/backend/animama/app/services/chat.py")])
        self.assertEqual((backend["mode"], backend["skipped"]), ("full", []))

    def test_promotion_candidates_and_everything_inputs_keep_full(self):
        full = sorted(BASE | PROFILES["full"])
        cheap = [modified("tests/test_chat.py")]
        for name, value, kwargs in (
            ("pull_request", event(labels=["ci:full"]), {}),
            ("push", main_event(), {}),
            ("workflow_dispatch", {}, {}),
            ("schedule", {}, {}),
            ("pull_request", event(), {"reusable": True}),
            ("pull_request", event(), {"diff_error": "missing"}),
        ):
            plan = choose_plan(name, value, cheap, **kwargs)
            self.assertEqual((plan["mode"], plan["required"], plan["skipped"]), ("full", full, []), name)
        for path in ("src/frontend/web/src/main.local.tsx", "scripts/ci/validation.py", "unknown/file"):
            plan = choose_plan("pull_request", event(), [modified(path)])
            self.assertEqual((plan["mode"], plan["required"], plan["skipped"]), ("full", full, []), path)
        # Reduced profiles and drafts are unchanged.
        self.assertEqual(choose_plan("pull_request", event(), [modified("docs/a.md")])["mode"], "docs")
        self.assertEqual(choose_plan("pull_request", event(draft=True), cheap)["mode"], "deferred")
        self.assertEqual(choose_plan("pull_request", event(), cheap, local_reviewed=True)["mode"], "backend")

    def test_changed_imports_reduce_nothing_but_special_files_select_everything(self):
        changes = [modified("tests/test_chat.py")]
        excluded = ["tests/test_chat.py"]
        plan = choose_plan("pull_request", event(), changes, excluded_paths=excluded, special_paths=[])
        self.assertEqual(plan["mode"], "selective")
        plan = choose_plan("pull_request", event(), changes, excluded_paths=excluded, special_paths=excluded)
        self.assertEqual(plan["mode"], "full")
        self.assertEqual(choose_plan("pull_request", event(), changes, excluded_paths=excluded)["mode"], "full")

    def test_gate_rejects_plans_that_do_not_match_their_skips(self):
        plan = choose_plan("pull_request", event(), [modified("tests/test_chat.py")])
        for key, value in (
            ("skipped", []),
            ("skipped", None),
            ("skipped", plan["skipped"][:1]),
            ("skipped", plan["skipped"] + plan["skipped"][:1]),
            ("skipped", list(reversed(plan["skipped"]))),
            ("skipped", [{"suite": "unknown", "reason": "x"}] + plan["skipped"]),
            ("skipped", [row | {"reason": ""} for row in plan["skipped"]]),
            ("skipped", [row | {"extra": 1} for row in plan["skipped"]]),
            ("mode", "full"),
        ):
            changed = copy.deepcopy(plan)
            changed[key] = value
            self.assertFalse(evaluate(changed, results(plan))["success"], (key, value))
        full = choose_plan("workflow_dispatch", {}, None)
        self.assertFalse(evaluate(full | {"skipped": plan["skipped"]}, results(full))["success"])
        # Steps of a skipped suite must not run; a required step must not skip.
        steps = results(plan) | {"package-build": {"outcome": "success", "conclusion": "success"}}
        self.assertFalse(evaluate(plan, steps)["success"])
        steps = results(plan) | {"package-build": {"outcome": "skipped", "conclusion": "skipped"}}
        self.assertTrue(evaluate(plan, steps)["success"])
        steps = results(plan) | {"browser-tests": {"outcome": "skipped", "conclusion": "skipped"}}
        self.assertFalse(evaluate(plan, steps)["success"])


if __name__ == "__main__":
    unittest.main()
