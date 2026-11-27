"""Selection and single-job acceptance stay conservative at input boundaries."""

from __future__ import annotations

import copy
import re
import subprocess
import unittest
from pathlib import Path, PurePosixPath

from validation_policy import (
    BASE,
    ORDINARY,
    PROFILES,
    SHARED_TESTS,
    SUITES,
    _plan,
    choose_plan,
    classify,
    covers,
    evaluate,
    route,
    select_suites,
)


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
            # Ordinary runs may still skip suites whose inputs did not change,
            # and route one-sided changes; local review never reduces these.
            for name, value in (("pull_request", event()), ("push", main_event())):
                mode = choose_plan(name, value, [modified(path)], local_reviewed=True)["mode"]
                self.assertIn(mode, {"full", *ORDINARY}, (name, path))

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
                    unreviewed = {"backend": "backend-only", "web": "frontend-only"}[mode]
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
            "backend-only",
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
    """Ordinary runs skip each expensive suite unless its own inputs changed."""

    def test_paths_select_only_the_suites_they_can_affect(self):
        tooling, hosted = {"browser-tooling"}, {"browser-hosted"}
        for path, suites in {
            # Product code, content, docs and tests defer every suite to promotion runs.
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
            "src/backend/animama/app/services/chat.py": set(),
            "src/backend/migrations/versions/0001_baseline.sql": set(),
            "README.md": set(),
            "licenses/pocket-tts.txt": set(),
            "src/frontend/desktop/runtime/notices/onnxruntime.txt": set(),
            "src/frontend/desktop/scripts/runtime/licenses.mjs": set(),
            "src/frontend/desktop/assets/icon.png": set(),
            "src/frontend/web/src/ui/components/button.tsx": set(),
            "src/frontend/web/src/lib/avatar/vfx/runtime.ts": set(),
            "src/frontend/packages/product-ui/src/index.ts": set(),
            "src/frontend/scripts/hosted-build-resources.mjs": set(),
            "content/included/vfx/sparkle/effect.json": set(),
            "docs/safety/crisis-protocol.md": set(),
            "contracts/versions.json": set(),
            "src/frontend/web/scripts/generate-routes.mjs": set(),
            "scripts/content/import.py": set(),
            "unknown/file.txt": set(),
            # The tools, their preview pages, renderer stages and preview sessions.
            "src/frontend/web/scripts/effect-check.mjs": tooling,
            "src/frontend/web/scripts/animation-preview/review.mjs": tooling,
            "src/frontend/web/scripts/effect-render.browser.test.mjs": tooling,
            "src/frontend/web/scripts/effect-render/stage.ts": tooling,
            "src/frontend/web/src/lib/avatar/motion-authoring/preview/previewSession.ts": tooling,
            # The hosted composition, its fixtures and tests.
            "src/frontend/web/scripts/hosted-workflows.browser.test.mjs": hosted,
            "src/frontend/web/tests/fixtures/hosted-composition/main.tsx": hosted,
            "src/frontend/web/tests/fixtures/retained-screens/main.tsx": hosted,
            "src/frontend/web/src/app/hosted-runtime/hosted-composition.ts": hosted,
            "src/frontend/web/src/main.hosted.tsx": hosted,
            # Shared browser setup, also copied into the whole-application consumer.
            "src/frontend/web/scripts/fixtures/hosted-workflows-http.mjs": set(ALL_SUITES),
            # Read by the Vite configuration that every browser file loads.
            "src/frontend/desktop/package.json": set(ALL_SUITES),
            "models/browser-speech/manifest.json": set(ALL_SUITES),
            "scripts/models/parakeet.py": set(ALL_SUITES),
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
            # The promotion suite's own scripts: a set always comes from a full run.
            "scripts/package-sets/build.py",
            "scripts/repository-boundary/consumers/hosted-app/verify.mjs",
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

    def test_ordinary_runs_record_selective_skips(self):
        for name, value in (("pull_request", event()), ("push", main_event())):
            plan = choose_plan(name, value, [modified("tests/test_chat.py"), modified("tests/conftest.py")])
            self.assertEqual(plan["mode"], "selective")
            self.assertEqual(skipped(plan), ALL_SUITES)
            self.assertTrue(all(row["reason"] for row in plan["skipped"]))
            for step in SUITES["promotion"]:
                self.assertNotIn(step, plan["required"])
            for step in ("backend-tests", "web-tests", "browser-tests", "browser-smoke", "web-build", "compose-check"):
                self.assertIn(step, plan["required"])
            self.assertTrue(evaluate(plan, results(plan))["success"])
            # Product code is ordinary: promotion runs cover its packaging and browser groups.
            backend = choose_plan(name, value, [modified("src/backend/animama/app/services/chat.py")])
            self.assertEqual((backend["mode"], skipped(backend)), ("backend-only", ALL_SUITES))

        tooling = choose_plan("pull_request", event(), [modified("src/frontend/web/scripts/effect-check.mjs")])
        self.assertEqual((tooling["mode"], skipped(tooling)), ("selective", ["browser-hosted", "promotion"]))
        hosted = choose_plan(
            "pull_request", event(), [modified("src/frontend/web/tests/fixtures/retained-screens/a.tsx")]
        )
        self.assertEqual((hosted["mode"], skipped(hosted)), ("selective", ["browser-tooling", "promotion"]))

    def test_promotion_runs_and_everything_inputs_keep_full(self):
        full = sorted(BASE | PROFILES["full"])
        cheap = [modified("tests/test_chat.py")]
        for name, value, kwargs in (
            ("pull_request", event(labels=["ci:full"]), {}),
            ("workflow_dispatch", {}, {}),
            ("schedule", {}, {}),
            ("pull_request", event(), {"reusable": True}),
            ("push", main_event(), {"reusable": True}),
            ("pull_request", event(), {"diff_error": "missing"}),
            ("push", main_event(), {"diff_error": "missing"}),
        ):
            plan = choose_plan(name, value, cheap, **kwargs)
            self.assertEqual((plan["mode"], plan["required"], plan["skipped"]), ("full", full, []), name)
        for path in (
            "scripts/ci/validation.py",
            "uv.lock",
            "models/browser-speech/manifest.json",
            "scripts/package-sets/build.py",
        ):
            for name, value in (("pull_request", event()), ("push", main_event())):
                plan = choose_plan(name, value, [modified(path)])
                self.assertEqual((plan["mode"], plan["required"], plan["skipped"]), ("full", full, []), path)
        # Reduced profiles and drafts are unchanged.
        self.assertEqual(choose_plan("pull_request", event(), [modified("docs/a.md")])["mode"], "docs")
        self.assertEqual(choose_plan("pull_request", event(draft=True), cheap)["mode"], "deferred")
        self.assertEqual(choose_plan("pull_request", event(), cheap, local_reviewed=True)["mode"], "backend")

    def test_changed_imports_reduce_nothing_but_special_files_select_everything(self):
        changes = [modified("tests/test_chat.py")]
        excluded = ["tests/test_chat.py"]
        plan = choose_plan("pull_request", event(), changes, excluded_paths=excluded, special_paths=[])
        self.assertEqual(plan["mode"], "backend-only")
        plan = choose_plan("pull_request", event(), changes, excluded_paths=excluded, special_paths=excluded)
        self.assertEqual(plan["mode"], "full")
        plan = choose_plan("push", main_event(), changes, excluded_paths=excluded, special_paths=excluded)
        self.assertEqual(plan["mode"], "full")
        self.assertEqual(choose_plan("pull_request", event(), changes, excluded_paths=excluded)["mode"], "full")

    def test_gate_rejects_plans_that_do_not_match_their_skips(self):
        plan = choose_plan("pull_request", event(), [modified("tests/conftest.py")])
        self.assertEqual(plan["mode"], "selective")
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


def change(status, path, old_path=None):
    return {"status": status, "old_path": old_path, "path": path}


BACKEND_PATHS = (
    "src/backend/animama/app/services/chat.py",
    "src/backend/animama/product_http/routes.py",
    "src/backend/animama/prompts/README.md",
    "tests/test_chat.py",
    "tests/test_anima_chat_sse.py",
)
FRONTEND_PATHS = (
    "src/frontend/web/src/ui/Chat.tsx",
    "src/frontend/web/src/ui/components/button.tsx",
    "src/frontend/web/src/lib/avatar/vfx/runtime.ts",
    "src/frontend/web/src/routes/index.tsx",
    "src/frontend/desktop/src/main.cts",
    "src/frontend/desktop/src/main-process/runtime/supervisor.ts",
)
# Paths either side reads, configuration and anything the selector does not recognize.
UNROUTED_PATHS = (
    "src/backend/AGENTS.md",
    "src/backend/animama/resources/model-assets.v1.json",
    "src/backend/animama/app/contracts/avatar_effect.py",
    "src/backend/packaging/desktop/stage_content.py",
    "tests/conftest.py",
    "tests/__init__.py",
    "tests/test_support.py",
    "tests/test_fixture_helper.py",
    "tests/chat_turn_support.py",
    "tests/fixtures/test_shared.py",
    "tests/live/test_live_chat.py",
    *(f"tests/{name}" for name in sorted(SHARED_TESTS)),
    "src/frontend/web/src/lib/content/fixtures/package-capabilities.json",
    "src/frontend/web/src/lib/avatar/poses/animaPoseClip/fixtures/v2-vocabulary.json",
    "src/frontend/desktop/src/main-process/runtime/vault.ts",
    "src/frontend/web/src/app/hosted-runtime/hosted-composition.ts",
    "src/frontend/web/src/assets/vrm/animations/manifest.json",
    "src/frontend/web/src/lib/avatar/motion-authoring/authoring-joints.generated.md",
    "src/frontend/web/src/assets/effect-templates/sparkle.webp",
    "src/frontend/web/src/lib/lipsync/text/english-dictionary.data.ts",
    "src/frontend/web/src/lib/speech/pocket/voice-catalog.ts",
    "src/frontend/web/src/AGENTS.md",
    "src/frontend/web/vite.config.ts",
    "src/frontend/web/vite-plugins/app-version.ts",
    "src/frontend/web/package.json",
    "src/frontend/web/tsconfig.json",
    "src/frontend/web/eslint.config.js",
    "src/frontend/desktop/package.json",
    "src/frontend/package.json",
    "src/frontend/pnpm-lock.yaml",
    "src/frontend/patches/vite.patch",
    "src/frontend/web/tests/localParakeetModels.test.ts",
    "src/frontend/web/tests/fixtures/hosted-composition/main.tsx",
    "src/frontend/web/scripts/effect-check.mjs",
    "src/frontend/web/scripts/fixtures/hosted-workflows-http.mjs",
    "src/frontend/web/public/image.png",
    "src/frontend/desktop/runtime/notices/onnxruntime.txt",
    "src/frontend/desktop/tests/runtime-ipc.test.ts",
    "src/frontend/shared/desktop-runtime.ts",
    "src/frontend/packages/product-ui/src/index.ts",
    "src/frontend/packages/runtime-contracts/src/generated/sdk.gen.ts",
    "src/frontend/e2e/journeys/library.spec.ts",
    "src/backend/migrations/versions/0001_baseline.sql",
    "src/backend/alembic.ini",
    "docs/guide.md",
    "uv.lock",
    "pyproject.toml",
    ".github/workflows/validate-public.yml",
    "scripts/ci/validation_policy.py",
    "models/browser-speech/manifest.json",
    "docker-compose.yml",
    "unknown/file.txt",
    "src/backend",
    "src/frontend/web/src",
)


class RoutingTests(unittest.TestCase):
    """One-sided ordinary changes skip the other side's checks; uncertainty never does."""

    def test_one_sided_changes_route_on_prs_and_main(self):
        for paths, mode in ((BACKEND_PATHS, "backend-only"), (FRONTEND_PATHS, "frontend-only")):
            for path in paths:
                for status in ("M", "A", "D"):
                    with self.subTest(path=path, status=status):
                        self.assertEqual(route([change(status, path)]), mode.removesuffix("-only"))
                        for name, value in (("pull_request", event()), ("push", main_event())):
                            plan = choose_plan(name, value, [change(status, path)])
                            self.assertEqual((plan["mode"], skipped(plan)), (mode, ALL_SUITES))
                            self.assertTrue(evaluate(plan, results(plan))["success"])
            # Several changes, renames and copies within one side.
            changes = [modified(path) for path in paths]
            changes += [change("R100", paths[0], paths[1]), change("C75", paths[1], paths[0])]
            self.assertEqual(choose_plan("pull_request", event(), changes)["mode"], mode)

    def test_backend_only_keeps_python_backend_sdk_build_and_smoke(self):
        plan = choose_plan("pull_request", event(), [modified(BACKEND_PATHS[0])])
        for step in (
            "backend-format",
            "backend-lint",
            "backend-types",
            "backend-tests",
            "sdk-freshness",
            "web-build",
            "browser-smoke",
            "audit",
            "tooling-tests",
            "desktop-tests",
            "compose-check",
        ):
            self.assertIn(step, plan["required"])
        for step in (
            "web-tests",
            "browser-tests",
            "frontend-lint",
            "frontend-types",
            "desktop-types",
            "packages-types",
            "harness-types",
            "packages-tests",
            *SUITES["promotion"],
        ):
            self.assertNotIn(step, plan["required"])

    def test_frontend_only_keeps_web_checks_and_the_accountless_guard(self):
        plan = choose_plan("pull_request", event(), [modified(FRONTEND_PATHS[0])])
        for step in (
            "frontend-lint",
            "frontend-types",
            "desktop-types",
            "packages-types",
            "harness-types",
            "web-tests",
            "browser-tests",
            "packages-tests",
            "desktop-tests",
            "sdk-freshness",
            "web-build",
            "browser-smoke",
            "accountless-guards",
        ):
            self.assertIn(step, plan["required"])
        for step in ("backend-format", "backend-lint", "backend-types", "backend-tests", *SUITES["promotion"]):
            self.assertNotIn(step, plan["required"])

    def test_frontend_only_still_runs_the_browser_groups_its_paths_select(self):
        for path, ran in (
            ("src/frontend/web/src/lib/avatar/motion-authoring/preview/previewSession.ts", "browser-tooling"),
            ("src/frontend/web/src/app/hosted-runtime/hosted-shell.tsx", "browser-hosted"),
            ("src/frontend/web/src/main.hosted.tsx", "browser-hosted"),
        ):
            with self.subTest(path=path):
                plan = choose_plan("pull_request", event(), [modified(path)])
                self.assertEqual(plan["mode"], "frontend-only")
                self.assertNotIn(ran, skipped(plan))
                self.assertIn("promotion", skipped(plan))

    def test_shared_configuration_and_unknown_paths_never_route(self):
        for path in UNROUTED_PATHS:
            with self.subTest(path=path):
                self.assertIsNone(route([modified(path)]))
                for name, value in (("pull_request", event()), ("push", main_event())):
                    self.assertIn(choose_plan(name, value, [modified(path)])["mode"], {"docs", "full", "selective"})

    def test_mixed_sides_and_cross_side_renames_never_route(self):
        for changes in (
            [modified(BACKEND_PATHS[0]), modified(FRONTEND_PATHS[0])],
            [modified(BACKEND_PATHS[0]), modified("docs/guide.md")],
            [modified(FRONTEND_PATHS[0]), modified("docs/guide.md")],
            [modified(FRONTEND_PATHS[0]), modified("src/frontend/web/package.json")],
            [change("R100", FRONTEND_PATHS[0], BACKEND_PATHS[0])],
            [change("R100", BACKEND_PATHS[0], "src/backend/animama/resources/x.json")],
            [change("C100", "src/frontend/web/src/lib/content/fixtures/a.json", FRONTEND_PATHS[0])],
        ):
            with self.subTest(changes=changes):
                self.assertIsNone(route(changes))
                self.assertIn(choose_plan("pull_request", event(), changes)["mode"], {"full", "selective"})

    def test_routing_fails_closed_on_malformed_unusual_and_special_inputs(self):
        path = BACKEND_PATHS[0]
        for status in ("T", "U", "X", "B", "", "M ", "m", "R", None, [], 1):
            self.assertIsNone(route([change(status, path)]), status)
        # A rename needs both sides; other statuses have only one.
        self.assertIsNone(route([change("R100", path)]))
        self.assertIsNone(route([change("M", path, path)]))
        # A missing path never routes, even beside routable changes.
        self.assertIsNone(route([modified(path), modified(None)]))
        for changes in (None, [], {}, (), [{}], [None], [modified(path) | {"extra": True}]):
            self.assertIsNone(route(changes))
        for bad in (None, [], "", "../tests/test_chat.py", "/src/backend/a.py", "src//backend/a.py", "src\\a.py"):
            self.assertIsNone(route([modified(bad)]), bad)
        # Links, executables and LFS inputs.
        self.assertIsNone(route([modified(path)], excluded_paths=[path]))
        self.assertIsNone(route([change("R100", path, BACKEND_PATHS[1])], excluded_paths=[BACKEND_PATHS[1]]))
        for excluded in (None, path, [[]], ["../a"]):
            self.assertIsNone(route([modified(path)], excluded_paths=excluded))
        plan = choose_plan("pull_request", event(), [modified(path)], special_paths=[path])
        self.assertEqual(plan["mode"], "full")

    def test_promotion_drafts_local_review_and_docs_take_precedence(self):
        for path in (BACKEND_PATHS[0], FRONTEND_PATHS[0]):
            changes = [modified(path)]
            for name, value, kwargs in (
                ("pull_request", event(labels=["ci:full"]), {}),
                ("workflow_dispatch", {}, {}),
                ("schedule", {}, {}),
                ("push", main_event(), {"reusable": True}),
                ("pull_request", event(), {"diff_error": "missing"}),
            ):
                self.assertEqual(choose_plan(name, value, changes, **kwargs)["mode"], "full", (path, name))
            self.assertEqual(choose_plan("pull_request", event(draft=True), changes)["mode"], "deferred")
        self.assertEqual(
            choose_plan("pull_request", event(), [modified("tests/test_chat.py")], local_reviewed=True)["mode"],
            "backend",
        )
        self.assertEqual(choose_plan("push", main_event(), [modified("docs/a.md")])["mode"], "docs")

    def test_gate_rejects_inconsistent_routed_plans(self):
        plan = choose_plan("pull_request", event(), [modified(BACKEND_PATHS[0])])
        for key, value in (
            ("skipped", []),
            ("skipped", [row for row in plan["skipped"] if row["suite"] != "promotion"]),
            ("mode", "frontend-only"),
            ("mode", "selective"),
            ("required", plan["required"] + ["web-tests"]),
        ):
            changed = copy.deepcopy(plan)
            changed[key] = value
            self.assertFalse(evaluate(changed, results(plan))["success"], (key, value))
        # A routed plan must skip the promotion suite even when its rows are consistent.
        self.assertFalse(evaluate(_plan("backend-only", "x", ["browser-hosted"]), {})["success"])
        steps = results(plan) | {"package-build": {"outcome": "success", "conclusion": "success"}}
        self.assertFalse(evaluate(plan, steps)["success"])
        steps = results(plan) | {"backend-tests": {"outcome": "skipped", "conclusion": "skipped"}}
        self.assertFalse(evaluate(plan, steps)["success"])


ROOT = Path(__file__).resolve().parents[2]
# Repository paths, or paths relative to src/frontend such as "desktop/src/...".
FRONTEND_REFERENCE = re.compile(r"(?<![\w./-])(?:src/frontend/)?(?:web|desktop)/src(?:/[\w.@-]+)*")
# Segmented joins such as `ROOT / "src" / "frontend" / "web" / "src" / ...`.
FRONTEND_SEGMENTS = re.compile(r'"src"(?:\s*/\s*"[\w.@-]+")+')
BACKEND_REFERENCE = re.compile(r"(?:\bsrc/|(?:\.\./)+)backend(?:/[\w.@-]+)*")
# Mentions and directory reads reviewed against the routing tables.
REVIEWED = {
    # The accountless guard scans all web sources; frontend-only runs it.
    ("tests/test_accountless_repository_boundaries.py", "src/frontend/web/src"),
    # Joined only with fixtures paths (checked below).
    ("tests/test_content_package_capabilities.py", "src/frontend/web/src/lib"),
    ("tests/test_content_package_import_resources.py", "src/frontend/web/src/lib"),
    # Docstrings naming the frontend counterpart; the shared fixtures are the parity records.
    ("src/backend/animama/app/services/content_names.py", "src/frontend/web/src/lib/content/nameIdentifiers.ts"),
    ("src/backend/animama/app/contracts/scene_effect_limits.py", "src/frontend/web/src/lib/scene-vfx"),
    # Synthetic paths the cleanup measurement test writes in a temporary tree.
    ("scripts/repository-cleanup/test_measure.py", "src/frontend/web/src/lib/speech/pocket/index.js"),
    # The accountless smoke runs the backend; both routed profiles run it.
    ("src/frontend/scripts/e2e/run-accountless-smoke.py", "src/backend"),
}
SCANNED = (".py", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".sh")
FRONTEND_PREFIXES = ("src/frontend/web/src", "src/frontend/desktop/src")


class CrossReadTests(unittest.TestCase):
    """A file one side's tests or tools read must not route to the other side."""

    @classmethod
    def setUpClass(cls):
        listing = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True)
        cls.files = [name for name in listing.stdout.decode().split("\0") if name]

    def check_references(self, sources, references, side):
        tracked = set(self.files)
        found = 0
        for source in sources:
            text = (ROOT / source).read_text(errors="replace")
            for path in sorted({path.rstrip("/.") for path in references(text)}):
                if (source, path) in REVIEWED:
                    continue
                if path in tracked:
                    found += 1
                    self.assertNotEqual(route([modified(path)]), side, (source, path))
                    continue
                inside = [name for name in self.files if name.startswith(path + "/")]
                if not inside or "fixtures" in PurePosixPath(path).parts:
                    continue
                found += 1
                routed = [name for name in inside if route([modified(name)]) == side]
                self.assertEqual(routed, [], (source, path))
        return found

    def test_backend_tests_and_their_code_read_no_routable_frontend_source(self):
        # Backend tests import backend code and, through the repository root, scripts.
        sources = [
            name
            for name in self.files
            if name.startswith(("tests/", "src/backend/", "scripts/"))
            and not name.startswith("scripts/ci/")
            and name.endswith(".py")
        ]

        def references(text):
            for reference in FRONTEND_REFERENCE.findall(text):
                yield reference if reference.startswith("src/") else "src/frontend/" + reference
            for joined in FRONTEND_SEGMENTS.findall(text):
                path = "/".join(re.findall(r'"([^"]+)"', joined))
                if path.startswith(FRONTEND_PREFIXES):
                    yield path

        self.assertGreater(self.check_references(sources, references, "frontend"), 5)
        for source in ("tests/test_content_package_capabilities.py", "tests/test_content_package_import_resources.py"):
            joined = re.findall(r'FRONTEND\s*/\s*"([^"]+)"', (ROOT / source).read_text())
            self.assertTrue(joined, source)
            for relative in joined:
                self.assertIn("fixtures", PurePosixPath(relative).parts, (source, relative))

    def test_frontend_code_reads_no_routable_backend_file(self):
        generated = "src/frontend/packages/runtime-contracts/src/generated/"
        sources = [
            name
            for name in self.files
            if name.startswith("src/frontend/") and name.endswith(SCANNED) and not name.startswith(generated)
        ]

        def references(text):
            for reference in BACKEND_REFERENCE.findall(text):
                yield "src/" + reference[reference.index("backend") :]

        self.assertGreater(self.check_references(sources, references, "backend"), 5)


class CoverageTests(unittest.TestCase):
    """A `main` push may reuse a PR run only when that run covered the push's own plan."""

    def plans(self):
        all_skipped = choose_plan("pull_request", event(), [modified("tests/conftest.py")])
        tooling = choose_plan("pull_request", event(), [modified("src/frontend/web/scripts/effect-check.mjs")])
        return {
            "full": choose_plan("workflow_dispatch", {}, None),
            "selective": all_skipped,
            "selective-tooling": tooling,
            "backend-only": choose_plan("pull_request", event(), [modified(BACKEND_PATHS[0])]),
            "frontend-only": choose_plan("pull_request", event(), [modified(FRONTEND_PATHS[0])]),
            "docs": choose_plan("pull_request", event(), [modified("docs/a.md")]),
            "backend": choose_plan("pull_request", event(), [modified("tests/test_chat.py")], local_reviewed=True),
            "deferred": choose_plan("pull_request", event(draft=True), []),
            "reused": choose_plan("push", main_event(), [], hosted_verified=True),
            "unchanged": choose_plan("schedule", {}, None, periodic_unchanged=True),
        }

    def test_a_run_covers_plans_whose_steps_and_suites_it_ran(self):
        plans = self.plans()
        self.assertEqual(plans["selective-tooling"]["mode"], "selective")
        expected = {
            ("full", "full"),
            ("full", "selective"),
            ("full", "selective-tooling"),
            ("full", "backend-only"),
            ("selective", "selective"),
            ("selective", "backend-only"),
            ("selective-tooling", "selective"),
            ("selective-tooling", "selective-tooling"),
            ("selective-tooling", "backend-only"),
            ("backend-only", "backend-only"),
            # Only routed frontend runs execute the separate accountless guard step.
            ("frontend-only", "frontend-only"),
        }
        for tested, tested_plan in plans.items():
            for selected, selected_plan in plans.items():
                with self.subTest(tested=tested, selected=selected):
                    self.assertEqual(covers(tested_plan, selected_plan), (tested, selected) in expected)

    def test_malformed_plans_cover_nothing(self):
        plans = self.plans()
        selective = plans["selective"]
        for key, value in (
            ("required", selective["required"] + ["unexpected"]),
            ("required", plans["full"]["required"]),
            ("skipped", []),
            ("mode", "full"),
            ("schema_version", 2),
        ):
            changed = copy.deepcopy(selective)
            changed[key] = value
            self.assertFalse(covers(changed, selective), key)
            self.assertFalse(covers(plans["full"], changed), key)
        for value in (None, {}, [], "full", selective | {"extra": 1}):
            self.assertFalse(covers(value, selective))
            self.assertFalse(covers(plans["full"], value))


if __name__ == "__main__":
    unittest.main()
