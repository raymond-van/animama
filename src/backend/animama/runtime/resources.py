"""One resource map for source execution and the frozen desktop executable.

Only the source adapter knows the checkout layout. Frozen code resolves all
resources through importlib and fails closed instead of looking in a checkout.
The PyInstaller spec consumes the same map, including the full migration tree.
"""

from __future__ import annotations

import json
import sys
from importlib.resources import files
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from alembic.config import Config

RESOURCE_INPUTS = {
    "alembic": "src/backend/migrations",
    "alembic.ini": "src/backend/alembic.ini",
    "sql": "src/backend/migrations/seeds",
    "animation-manifest.json": "src/frontend/web/src/assets/vrm/animations/manifest.json",
}


def runtime_resource(name: str) -> Path:
    """Resolve a declared resource in a source tree or onedir installation."""

    if name not in RESOURCE_INPUTS:
        raise ValueError(f"Unknown runtime resource: {name}")
    packaged = files("animama.resources").joinpath("runtime").joinpath(name)
    if packaged.is_file() or packaged.is_dir():
        # onedir is an unpacked filesystem package, not a transient zip resource.
        return Path(str(packaged))
    if getattr(sys, "frozen", False):
        raise FileNotFoundError(f"Required packaged resource is missing: {name}")
    return Path(__file__).resolve().parents[4] / RESOURCE_INPUTS[name]


def alembic_config() -> Config:
    """Use packaged migration scripts without invoking an external executable."""

    from alembic.config import Config

    config = Config(str(runtime_resource("alembic.ini")))
    config.set_main_option("script_location", str(runtime_resource("alembic")))
    return config


def audit_resources() -> dict[str, Any]:
    """Validate resource structure without a database, HTTP listener, or provider key."""

    from alembic.script import ScriptDirectory
    from fastapi.routing import iter_route_contexts
    from pgvector.sqlalchemy import Vector

    from animama.app.generation.deterministic_author import example_gesture_clip
    from animama.app.generation.draft_validation import clip_problems
    from animama.app.services.starter_loadout_policy import starter_loadout_policy
    from animama.orm import Base
    from animama.prompts.avatar_animation_manifest import get_manifest_gesture_inventory
    from animama.resources.authoring_guidance import GESTURE_GUIDANCE_FILES, gesture_authoring_guidance
    from animama.server.app import app

    for name in RESOURCE_INPUTS:
        if not runtime_resource(name).exists():
            raise FileNotFoundError(f"Required runtime resource is missing: {name}")
    migrations = ScriptDirectory.from_config(alembic_config())
    head = migrations.get_current_head()
    if not head:
        raise ValueError("Packaged Alembic head is missing or ambiguous")
    # Walk every revision so an omitted migration or its SQL fails the audit.
    revisions = list(migrations.walk_revisions())
    baseline = runtime_resource("alembic") / "versions" / "0001_baseline.sql"
    if not baseline.is_file() or not baseline.read_text(encoding="utf-8").strip():
        raise ValueError("Packaged baseline SQL is missing")
    sql = sorted(runtime_resource("sql").glob("*.sql"))
    if not sql or not all(p.read_text(encoding="utf-8").strip() for p in sql):
        raise ValueError("Packaged bootstrap SQL is missing or empty")
    policy = starter_loadout_policy()
    gestures = get_manifest_gesture_inventory()
    if not policy["gestures"] or not policy["reactions"] or not gestures:
        raise ValueError("Packaged starter or animation resources are empty")
    # The guidance is package data a freezer could leave out; reading it names a missing or empty file.
    gesture_authoring_guidance()
    # So is the clip the content assistant submits when the server runs without models; it must still be a draft.
    example = example_gesture_clip()
    if clip_problems(example):
        raise ValueError("Packaged example Gesture is not a valid draft")
    # Included routers are nested entries in app.routes; count the routes they serve.
    routes = list(iter_route_contexts(app.routes))
    if "/v1/animas/{anima_id}/chat:sse" not in {route.path for route in routes}:
        raise ValueError("Frozen FastAPI application is missing its chat route")
    # Postgres rejects any other type for the vector columns, so a build without
    # pgvector would fail every upload chunk and archive passage write.
    embedding_columns = [table.c.embedding for table in Base.metadata.tables.values() if "embedding" in table.c]
    if not embedding_columns or not all(isinstance(column.type, Vector) for column in embedding_columns):
        raise ValueError("Packaged ORM does not map embeddings to pgvector's vector type")
    return {
        "schema": "animama-resource-audit/1",
        "local_http_schema_version": 1,
        "frozen": bool(getattr(sys, "frozen", False)),
        "alembic_head": head,
        "migration_count": len(revisions),
        "sql_count": len(sql),
        "gesture_count": len(gestures),
        "authoring_guidance_files": len(GESTURE_GUIDANCE_FILES),
        "generation_example_beats": len(example.get("beats", [])),
        "starter_policy": policy["id"],
        "api_route_count": len(routes),
    }


def print_resource_audit() -> None:
    print(json.dumps(audit_resources(), indent=2, sort_keys=True))
