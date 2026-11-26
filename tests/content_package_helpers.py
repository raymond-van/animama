from __future__ import annotations

import asyncio
import json
import struct
from pathlib import Path
from tempfile import TemporaryFile
from typing import Any, BinaryIO, TypedDict, cast

from animama.adapters.content_store import FilesystemContentStore
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.contracts.content_package_import import ReviewedPackageImport
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_package_service import ContentPackageService, ExportedContentPackage
from animama.app.services.content_save_service import ContentSaveService
from animama.domain.content_catalog import ContentKind
from animama.server.config import Settings
from animama.server.local_runtime import initialize_local_runtime

# glTF extensions that converted (Mochiya Avatar Tools, Animama Avatar Converter)
# and optimized (meshopt, Draco) Avatar files carry; packages accept them beside
# the standard set.
CONVERTED_AVATAR_EXTENSIONS = (
    "MOCHIYA_avatar_composition",
    "MOCHIYA_materials_liltoon",
    "ANIMAMA_avatar_conversion",
    "EXT_meshopt_compression",
    "KHR_draco_mesh_compression",
)


class PackageCommitCommand(TypedDict):
    """A reviewed immutable command remains usable after staged bytes expire."""

    user_id: str
    stage_id: str
    operation_id: str
    review_digest: str


async def reviewed_export(
    packages: ContentPackageService, *, user_id: str, root_item_id: str
) -> ExportedContentPackage:
    summary = await packages.summarize(user_id=user_id, item_ids=(root_item_id,))
    review = await packages.prepare_export(user_id=user_id, item_ids=(root_item_id,), expected_digest=summary.digest)
    return await packages.get_export(user_id=user_id, export_id=review.export_id)


async def reviewed_import(
    packages: ContentPackageService, *, user_id: str, archive_path: Path, operation_id: str
) -> PackageCommitCommand:
    """Exercise allocation, sequential byte parts and review without committing."""
    _review, command = await review_import(
        packages, user_id=user_id, archive_path=archive_path, operation_id=operation_id
    )
    return command


async def review_import(
    packages: ContentPackageService, *, user_id: str, archive_path: Path, operation_id: str
) -> tuple[ReviewedPackageImport, PackageCommitCommand]:
    """``reviewed_import`` that also returns the review the user would see."""
    stage = packages.stages.create_import(
        user_id=user_id,
        operation_id=operation_id,
        filename=archive_path.name,
        expected_bytes=archive_path.stat().st_size,
    )
    with archive_path.open("rb") as archive:
        index = 0
        while True:
            with TemporaryFile("w+b") as part:
                while part.tell() < packages.stages.limits.part_bytes:
                    chunk = archive.read(min(1024 * 1024, packages.stages.limits.part_bytes - part.tell()))
                    if not chunk:
                        break
                    part.write(chunk)
                if not part.tell():
                    break
                part.seek(0)
                await asyncio.to_thread(
                    packages.stages.append_part,
                    user_id=user_id,
                    stage_id=stage.stage_id,
                    index=index,
                    source=cast(BinaryIO, part),
                )
                index += 1
    review = await packages.imports.review(user_id=user_id, stage_id=stage.stage_id)
    return review, {
        "user_id": user_id,
        "stage_id": stage.stage_id,
        "operation_id": operation_id,
        "review_digest": review.review_digest,
    }


def vrma(label: str) -> bytes:
    """Build a minimal VRM Animation GLB fixture with stable distinct bytes."""

    document = json.dumps(
        {
            "asset": {"version": "2.0"},
            "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}},
            "extras": {"label": label},
        },
        separators=(",", ":"),
    ).encode()
    document += b" " * (-len(document) % 4)
    return (
        struct.pack("<4sII", b"glTF", 2, 20 + len(document)) + struct.pack("<II", len(document), 0x4E4F534A) + document
    )


def anima_clip(
    *,
    clip_id: str = "clip",
    name: str = "Clip",
    duration: float = 1,
    events: list[dict[str, Any]] | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """Build a minimal valid ``animaPoseClip/2.0`` clip: one beat, one head key, optional events.

    Extra keyword fields (for example ``basePose`` or ``playback``) are merged in
    so tests can vary only what they exercise.
    """

    return {
        "schema": "animaPoseClip/2.0",
        "id": clip_id,
        "name": name,
        "duration": duration,
        "beats": [{"id": "start", "label": "Start", "time": 0}],
        "rotations": {"head": [{"beat": "start", "q": [0, 0.13, 0, 0.99]}]},
        "events": list(events or []),
        **fields,
    }


def package_services(async_session, tmp_path: Path):
    """Create the real filesystem/catalog/package service graph for a test."""

    paths = initialize_local_runtime(
        Settings(
            animama_content_root=tmp_path / "content",
            animama_data_root=tmp_path / "data",
        )
    )
    store = FilesystemContentStore(
        included_root=paths.included_root,
        local_root=paths.local_root,
        operations_root=paths.operations_root,
    )
    catalog = SQLAlchemyContentCatalog(async_session)
    content = ContentCatalogService(
        store=store,
        catalog=catalog,
    )
    saves = ContentSaveService(content=content)
    packages = ContentPackageService(
        content=content,
        exports_root=paths.exports_staging_root,
        imports_root=paths.imports_staging_root,
    )
    return paths, catalog, content, saves, packages


async def save_wave(saves: ContentSaveService, *, label: str = "original"):
    """Save one self-describing standalone Gesture through the public service."""

    return await saves.save_standalone(
        user_id="package-owner",
        kind=ContentKind.GESTURE,
        entry_name="Friendly Wave",
        filename="wave.vrma",
        payload=vrma(label),
        metadata_sidecar=json.dumps(
            {
                "schema_version": 1,
                "id": "local:gesture:friendly-wave",
                "name": "Friendly Wave",
                "description": "A portable wave fixture.",
                "provenance": {
                    "creator": "Animama test suite",
                    "license": "fixture-only",
                },
            }
        ).encode(),
        operation_id=f"save-wave-{label}",
        catalog_item_id=None,
        expected_revision=None,
    )
