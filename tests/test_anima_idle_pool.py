from __future__ import annotations

import hashlib
import json
from io import BytesIO
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.contracts.anima_loadout import PyIdleIntent
from animama.app.services.anima_loadout_service import AnimaLoadoutService
from animama.app.services.anima_runtime_service import AnimaRuntimeService
from animama.domain.anima_loadout import AnimaLoadoutError
from animama.domain.content_catalog import ContentUsage, VerifiedContentFile
from animama.orm.anima_loadout import ORMAnimaLoadout
from animama.orm.content_catalog import ORMContentCatalogFile, ORMContentCatalogItem
from tests.content_package_helpers import anima_clip
from tests.typed_loadout_support import (
    LoadoutFixture,
    add_typed_item,
    catalog_source,
    cleanup_loadout_fixture,
    create_loadout_fixture,
)

CLIP = json.dumps(anima_clip(clip_id="idle", name="Idle", duration=2)).encode()


class _Store:
    def open_verified_file(self, **facts):
        return VerifiedContentFile(BytesIO(CLIP), len(CLIP), facts["expected_sha256"], facts["media_type"])


async def _idle_gesture(
    session,
    fixture: LoadoutFixture,
    name: str,
    *,
    config: dict[str, Any] | None = None,
) -> ORMContentCatalogItem:
    item = await add_typed_item(
        session,
        fixture,
        kind="gesture",
        name=name,
        metadata={
            "semantic_key": name.casefold().replace(" ", "-"),
            "implementation": {"kind": "anima_clip", "file_role": "sequence"},
            "config": config or {},
        },
    )
    session.add(
        ORMContentCatalogFile(
            file_ref=f"{item.id}:clip",
            item_id=item.id,
            relative_path=f"gesture/{item.id}/clip.json",
            role="sequence",
            media_type="application/json",
            size_bytes=len(CLIP),
            sha256=hashlib.sha256(CLIP).hexdigest(),
            ordinal=1,
        )
    )
    await session.commit()
    return item


async def _change(
    service: AnimaLoadoutService,
    fixture: LoadoutFixture,
    *,
    revision: int,
    intent: dict[str, Any],
    key: str,
) -> str:
    plan = await service.plan(
        user_id=fixture.user_id,
        anima_id=fixture.anima_id,
        family="idle",
        expected_revision=revision,
        intent=intent,
        store=_Store(),  # type: ignore[arg-type]
    )
    result = await service.commit(
        user_id=fixture.user_id,
        anima_id=fixture.anima_id,
        family="idle",
        expected_revision=revision,
        intent=intent,
        plan_digest=plan.digest,
        idempotency_key=key,
        store=_Store(),  # type: ignore[arg-type]
    )
    return result.action


@pytest.mark.asyncio
async def test_idle_pool_members_are_added_and_removed_per_cell(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    breathe = await _idle_gesture(async_session, fixture, "Breathe")
    sway = await _idle_gesture(async_session, fixture, "Sway")
    service = AnimaLoadoutService(async_session)
    try:
        empty = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        assert empty.idle.default_pool == ()
        assert len(empty.idle.cells) == 72
        assert all(not cell.gestures for cell in empty.idle.cells)

        add_default = {"operation": "add", "source": catalog_source(breathe)}
        add_joy = {"operation": "add", "emotion": "joy", "intensity": 2, "source": catalog_source(sway)}
        assert await _change(service, fixture, revision=1, intent=add_default, key="idle-1") == "add"
        assert await _change(service, fixture, revision=2, intent=add_joy, key="idle-2") == "add"

        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        assert loadout.revision == 3
        assert [member.name for member in loadout.idle.default_pool] == ["Breathe"]
        joy = next(cell for cell in loadout.idle.cells if (cell.emotion, cell.intensity) == ("joy", 2))
        assert [(member.item_id, member.available) for member in joy.gestures] == [(sway.id, True)]
        # Idle membership never equips a Gesture for AI invocation.
        assert loadout.gestures == ()

        [member] = loadout.idle.default_pool
        removed = await _change(
            service,
            fixture,
            revision=3,
            intent={"operation": "remove", "binding_id": member.binding_id},
            key="idle-3",
        )
        assert removed == "remove"
        after = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        assert after.idle.default_pool == ()
        assert after.revision == 4
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


@pytest.mark.asyncio
async def test_invalid_idle_additions_are_rejected_without_a_revision(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    breathe = await _idle_gesture(async_session, fixture, "Breathe")
    endless = await _idle_gesture(async_session, fixture, "Endless", config={"loop": True})
    reaction = await add_typed_item(
        async_session,
        fixture,
        kind="reaction",
        name="Smile",
        metadata={"implementation": {"kind": "anima_clip", "file_role": "sequence"}},
    )
    service = AnimaLoadoutService(async_session)
    try:
        await _change(
            service, fixture, revision=1, intent={"operation": "add", "source": catalog_source(breathe)}, key="idle-1"
        )
        rejected = {
            "idle_gesture_duplicate": {"operation": "add", "source": catalog_source(breathe)},
            "idle_gesture_ineligible": {"operation": "add", "source": catalog_source(endless)},
            "loadout_source_unavailable": {"operation": "add", "source": catalog_source(reaction)},
            "idle_cell_invalid": {"operation": "add", "emotion": "joy", "source": catalog_source(endless)},
        }
        for code, intent in rejected.items():
            with pytest.raises(AnimaLoadoutError, match=code):
                await service.plan(
                    user_id=fixture.user_id,
                    anima_id=fixture.anima_id,
                    family="idle",
                    expected_revision=2,
                    intent=intent,
                    store=_Store(),  # type: ignore[arg-type]
                )
        # Finite playback is read from exact bytes, so an add needs the content store.
        with pytest.raises(AnimaLoadoutError, match="idle_playback_unavailable"):
            await service.plan(
                user_id=fixture.user_id,
                anima_id=fixture.anima_id,
                family="idle",
                expected_revision=2,
                intent={"operation": "add", "emotion": "joy", "intensity": 1, "source": catalog_source(breathe)},
            )
        root = await async_session.scalar(select(ORMAnimaLoadout).where(ORMAnimaLoadout.anima_id == fixture.anima_id))
        assert root is not None and root.revision == 2
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


@pytest.mark.asyncio
async def test_unavailable_member_stays_visible_and_removable_and_pooled_gestures_are_in_use(
    async_session,
) -> None:
    fixture = await create_loadout_fixture(async_session)
    breathe = await _idle_gesture(async_session, fixture, "Breathe")
    service = AnimaLoadoutService(async_session)
    try:
        await _change(
            service, fixture, revision=1, intent={"operation": "add", "source": catalog_source(breathe)}, key="idle-1"
        )
        # A pooled Gesture is referenced, so deleting it is refused like an equipped one.
        assert await SQLAlchemyContentCatalog(async_session).item_usage(item_id=breathe.id) == (
            ContentUsage("anima_idle", fixture.anima_id, fixture.anima_id),
        )

        breathe.status = "invalid"
        await async_session.commit()
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        assert [(member.name, member.available) for member in loadout.idle.default_pool] == [("Breathe", False)]
        # The member says it is unavailable; no Loadout warning names its internal slot.
        assert not any(warning.code == "loadout_source_unavailable" for warning in loadout.warnings)

        # An unavailable member has no source; it is removed by its binding.
        [member] = loadout.idle.default_pool
        assert member.source is None
        removed = await _change(
            service,
            fixture,
            revision=2,
            intent={"operation": "remove", "binding_id": member.binding_id},
            key="idle-2",
        )
        assert removed == "remove"
        assert await SQLAlchemyContentCatalog(async_session).item_usage(item_id=breathe.id) == ()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


def test_idle_intent_has_no_whole_pool_operation_and_needs_a_complete_target() -> None:
    source = {"type": "catalog", "catalog_item_id": "item", "source": "local"}
    for operation in ("set", "replace", "leave_empty", "revert", "remove_all"):
        with pytest.raises(ValidationError):
            PyIdleIntent.model_validate({"operation": operation, "source": source})
    for invalid in (
        {"operation": "add", "emotion": "joy", "source": source},
        {"operation": "add", "emotion": "neutral", "intensity": 1, "source": source},
        {"operation": "add", "binding_id": "row"},
        {"operation": "remove", "source": source},
        {"operation": "remove", "binding_id": "row", "emotion": "joy", "intensity": 1},
    ):
        with pytest.raises(ValidationError):
            PyIdleIntent.model_validate(invalid)
    assert PyIdleIntent.model_validate({"operation": "add", "source": source}).emotion is None
    assert PyIdleIntent.model_validate({"operation": "remove", "binding_id": "row"}).binding_id == "row"


@pytest.mark.asyncio
async def test_runtime_selects_one_idle_root_per_gesture_ahead_of_ai_gestures(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    breathe = await _idle_gesture(async_session, fixture, "Breathe")
    wave = await _idle_gesture(async_session, fixture, "Wave")
    service = AnimaLoadoutService(async_session)
    try:
        additions: list[dict[str, Any]] = [
            {"operation": "add", "source": catalog_source(breathe)},
            {"operation": "add", "emotion": "joy", "intensity": 2, "source": catalog_source(breathe)},
        ]
        for revision, intent in enumerate(additions, start=1):
            await _change(service, fixture, revision=revision, intent=intent, key=f"idle-{revision}")
        # Another Gesture is equipped for AI invocation.
        plan = await service.plan(
            user_id=fixture.user_id,
            anima_id=fixture.anima_id,
            family="gesture",
            expected_revision=3,
            intent={"operation": "add", "source": catalog_source(wave), "config_overrides": {}},
        )
        await service.commit(
            user_id=fixture.user_id,
            anima_id=fixture.anima_id,
            family="gesture",
            expected_revision=3,
            intent={"operation": "add", "source": catalog_source(wave), "config_overrides": {}},
            plan_digest=plan.digest,
            idempotency_key="gesture-1",
        )
        visible = await SQLAlchemyContentCatalog(async_session).list_visible(user_id=fixture.user_id)

        selected = await AnimaRuntimeService(async_session)._selections(anima_id=fixture.anima_id, visible=visible)

        # Keep only this test's Gesture roots (the Avatar has its own).
        slots = [
            (root.slot_key, root.catalog_item_id)
            for root in selected.roots
            if root.catalog_item_id in {breathe.id, wave.id}
        ]
        # Idle roots keep budget precedence over AI-callable Gestures.
        assert slots == [(f"idle:{breathe.id}", breathe.id), ("gesture:wave", wave.id)]
        idle = next(value for value in selected.roots if value.slot_key == f"idle:{breathe.id}")
        assert idle.context["idle_cells"] == ["default", "joy-2"]
        assert idle.context["binding_id"] == f"idle:{breathe.id}"
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
