"""The shared-route inventory matches the local app and the hosted capability contract (ADR 0021)."""

from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, APIWebSocketRoute

from animama.product_http.inventory import ROUTES, SERVED_STAGES, RouteSpec
from animama.product_http.ports import get_read_session, get_write_session
from animama.product_http.routes import ROUTERS
from animama.server.app import create_local_app
from animama.server.config import Settings
from tests.route_support import served_routes

ROOT = Path(__file__).resolve().parents[1]
HOSTED = json.loads((ROOT / "contracts/runtime-capabilities/hosted.json").read_text())
# The permissions of the capability contract (contracts/hosted-web.md, "Capabilities
# and requests"). The other boolean fields report runtime state, not permission.
PERMISSIONS = (
    "chat",
    "model_selection",
    "model_role_selection",
    "model_configuration",
    "provider_credentials",
    "chat_file_uploads",
    "anima_creation",
    "automatic_episode_processing",
    "chatgpt_plan",
    "local_filesystem_administration",
    "native_features",
    "user_file_processing.enabled",
    "web_search.configuration",
)
RUNTIME_STATE = (
    "library_previews",
    "offline_speech_enabled",
    "offline_multilingual_speech_enabled",
    "companion_safety.enabled",
    "companion_safety.ai_notice_enabled",
    "companion_safety.crisis_detection_enabled",
    "web_search.configured",
)


def boolean_leaves(value: dict[str, Any], prefix: str = "") -> set[str]:
    leaves = set()
    for key, child in value.items():
        if isinstance(child, bool):
            leaves.add(prefix + key)
        elif isinstance(child, dict):
            leaves |= boolean_leaves(child, f"{prefix}{key}.")
    return leaves


def hosted_permission(name: str) -> bool:
    value: Any = HOSTED
    for part in name.split("."):
        value = value[part]
    assert isinstance(value, bool), name
    return value


def local_app(tmp_path: Path, *, desktop: bool, web_root: bool) -> FastAPI:
    """The local app as development (no web root), built web, or desktop runs it."""

    options: dict[str, Any] = {}
    if web_root:
        root = tmp_path / "web"
        root.mkdir()
        (root / "index.html").write_text("<html>fixture</html>")
        options["animama_web_root"] = root
    if desktop:
        options |= {"animama_desktop_renderer_capability": "e" * 64, "animama_desktop_control_token": "c" * 64}
    # Desktop startup scrubs credential names from the environment; keep this test's.
    with mock.patch.dict(os.environ):
        return create_local_app(
            runtime_settings=Settings(
                animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data", **options
            )
        )


def route_table(app: FastAPI) -> list[tuple[str, str, str]]:
    """The app's ordered (method, path, handler) table, one entry per method."""

    table = []
    for route in served_routes(app):
        assert isinstance(route, APIRoute | APIWebSocketRoute), route
        methods = ["WEBSOCKET"] if isinstance(route, APIWebSocketRoute) else sorted(route.methods or ())
        table += [(method, route.path, route.endpoint.__name__) for method in methods]
    return table


MODES = {
    "development": {"desktop": False, "web_root": False},
    "built": {"desktop": False, "web_root": True},
    "desktop": {"desktop": True, "web_root": True},
}


@pytest.mark.parametrize("mode", MODES)
def test_inventory_lists_every_local_route_in_order(tmp_path: Path, mode: str) -> None:
    desktop, web_root = MODES[mode]["desktop"], MODES[mode]["web_root"]
    expected = [
        (spec.method, spec.path, spec.handler)
        for spec in ROUTES
        if (desktop or not spec.desktop_only) and (web_root or not spec.web_root_only)
    ]
    assert route_table(local_app(tmp_path, desktop=desktop, web_root=web_root)) == expected


def test_creation_options_matches_before_the_anima_path_parameter() -> None:
    paths = [spec.path for spec in ROUTES]
    assert paths.index("/v1/animas/creation-options") < paths.index("/v1/animas/{anima_id}")


def test_every_route_precedes_the_web_asset_catch_all() -> None:
    # The catch-all answers unknown /v1 paths too, so a route mounted after it is unreachable.
    catch_all = [index for index, spec in enumerate(ROUTES) if spec.web_root_only]
    assert catch_all == [len(ROUTES) - 2, len(ROUTES) - 1]


def test_every_boolean_capability_is_a_permission_or_runtime_state() -> None:
    assert boolean_leaves(HOSTED) == set(PERMISSIONS) | set(RUNTIME_STATE)


def test_every_false_hosted_permission_withholds_at_least_one_route() -> None:
    gated = {spec.capability for spec in ROUTES if spec.disposition == "hosted-excluded"}
    withheld = {name for name in PERMISSIONS if not hosted_permission(name)}
    assert withheld <= gated


def test_routes_are_withheld_only_by_false_hosted_permissions() -> None:
    for spec in ROUTES:
        if spec.disposition == "hosted-excluded":
            assert spec.capability in PERMISSIONS, spec.path
            assert hosted_permission(spec.capability) is False, spec.path


def test_shared_routes_are_product_api_routes() -> None:
    shared = [spec for spec in ROUTES if spec.disposition == "shared"]
    assert shared
    assert all(spec.path.startswith("/v1/") and not (spec.desktop_only or spec.web_root_only) for spec in shared)


def depends_on(dependant: Dependant, call: object) -> bool:
    return dependant.call is call or any(depends_on(child, call) for child in dependant.dependencies)


def test_moved_handlers_use_the_session_their_access_names(tmp_path: Path) -> None:
    # access is provisional until a family moves; then it must match the handler.
    specs = {(spec.method, spec.path): spec for spec in ROUTES}
    for route in served_routes(local_app(tmp_path, desktop=False, web_root=False)):
        if not (isinstance(route, APIRoute) and route.endpoint.__module__.startswith("animama.product_http.")):
            continue
        for method in route.methods or ():
            spec = specs[(method, route.path)]
            assert spec.disposition == "shared", route.path
            if spec.access in ("read", "write"):
                expected = get_read_session if spec.access == "read" else get_write_session
                assert depends_on(route.dependant, expected), (method, route.path, spec.access)
            if spec.access == "read":
                # A read route never opens a write session the composition must settle.
                assert not depends_on(route.dependant, get_write_session), (method, route.path)
            if spec.access == "staged":
                # Its write session is opened only for the final write, never held while it prepares.
                assert not depends_on(route.dependant, get_write_session), (method, route.path)
            if spec.access == "stream":
                # A stream prepares on a write session that the composition settles before the body runs.
                assert depends_on(route.dependant, get_write_session), (method, route.path)
            if spec.access == "speech":
                # Speech utilities call the speech port and open no session at all.
                assert not depends_on(route.dependant, get_read_session), (method, route.path)
                assert not depends_on(route.dependant, get_write_session), (method, route.path)


def test_the_package_serves_exactly_the_served_stages(tmp_path: Path) -> None:
    modules: dict[tuple[str, str], str] = {}
    for route in served_routes(local_app(tmp_path, desktop=True, web_root=True)):
        assert isinstance(route, APIRoute | APIWebSocketRoute), route
        methods = ["WEBSOCKET"] if isinstance(route, APIWebSocketRoute) else sorted(route.methods or ())
        for method in methods:
            modules[(method, route.path)] = route.endpoint.__module__
    for spec in ROUTES:
        served = modules[(spec.method, spec.path)].startswith("animama.product_http.")
        if spec.disposition != "shared":
            assert not served, (spec.method, spec.path)
        else:
            assert served == (spec.stage in SERVED_STAGES), (spec.method, spec.path, spec.stage)


def test_each_stage_shares_the_planned_routes() -> None:
    # The ExecPlan's stages; audio isolation stays local (owner, 2026-10-10).
    shared = Counter(spec.stage for spec in ROUTES if spec.disposition == "shared")
    assert shared == {2: 45, 3: 82, 4: 18, 5: 1}


def test_routers_mount_the_served_routes_in_inventory_order() -> None:
    # A consumer mounts ROUTERS as they are, so their order must already be the inventory's.
    mounted = [
        (method, route.path, route.endpoint.__name__)
        for router in ROUTERS
        for route in router.routes
        if isinstance(route, APIRoute)
        for method in sorted(route.methods or ())
    ]
    served = [
        (spec.method, spec.path, spec.handler)
        for spec in ROUTES
        if spec.disposition == "shared" and spec.stage in SERVED_STAGES
    ]
    assert mounted == served


def test_avatar_settings_routes_belong_to_the_local_composition() -> None:
    # Only the local composition stores per-owner Avatar settings, so a consumer
    # mounting ROUTERS never serves them (its ProductContent may omit the store).
    specs = {
        (spec.method, spec.handler): spec for spec in ROUTES if spec.path == "/v1/avatar-content/{item_id}/settings"
    }
    assert set(specs) == {("GET", "get_avatar_settings"), ("PUT", "save_avatar_settings")}
    assert all(spec.disposition == "local" for spec in specs.values())
    shared_paths = {route.path for router in ROUTERS for route in router.routes if isinstance(route, APIRoute)}
    assert "/v1/avatar-content/{item_id}/settings" not in shared_paths


def test_route_specs_reject_mismatched_stage_or_capability() -> None:
    with pytest.raises(ValueError, match="stage"):
        RouteSpec("GET", "/v1/chats", "list_chats", "shared", "read")
    with pytest.raises(ValueError, match="stage"):
        RouteSpec("GET", "/health", "health", "local", "read", stage=2)
    with pytest.raises(ValueError, match="capability"):
        RouteSpec("POST", "/v1/files/uploads", "init_user_file_upload", "hosted-excluded", "write")
    with pytest.raises(ValueError, match="capability"):
        RouteSpec("GET", "/v1/chats", "list_chats", "shared", "read", stage=2, capability="chat")
