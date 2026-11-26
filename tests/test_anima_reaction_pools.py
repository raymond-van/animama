"""Reaction pools: up to four Reactions per emotion/intensity cell, four intensities, 96 cells."""

from __future__ import annotations

import hashlib
import json
from io import BytesIO
from typing import Any
from unittest.mock import Mock
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from animama.adapters.repositories.sqlalchemy.anima_aggregate_uow import SQLAlchemyAnimaAggregateUnitOfWork
from animama.adapters.repositories.sqlalchemy.anima_package_source_repo import SQLAlchemyAnimaPackageSourceRepository
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.anima_creation_contract import AnimaSpec, CreateAnimaRequest
from animama.app.contracts.anima_loadout import PyReactionIntent
from animama.app.contracts.portable_anima import PortableAnima
from animama.app.services.anima_creation_sources import item_ref
from animama.app.services.anima_loadout_service import AnimaLoadoutService
from animama.app.services.anima_package_source_service import AnimaPackageSourceService
from animama.app.services.anima_runtime_service import AnimaRuntimeService
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_package_service import ContentPackageService
from animama.app.services.runtime_content_closure import RuntimeContentClosureCompiler
from animama.app.services.starter_loadout_policy import starter_loadout_policy, starter_reaction_pools
from animama.app.services.typed_runtime_projection import project_typed_runtime_catalog
from animama.domain.anima_creation_error import AnimaCreationError
from animama.domain.anima_loadout import (
    REACTION_INTENSITIES,
    REACTION_POOL_LIMIT,
    AnimaLoadoutError,
    parse_reaction_slot_key,
    reaction_slot_key,
)
from animama.domain.content_catalog import (
    CatalogContentEntry,
    CatalogContentFile,
    ContentConflictError,
    ContentKind,
    ContentScope,
    ContentSource,
    ContentStatus,
    ContentUsage,
    VerifiedContentFile,
)
from animama.domain.emotions import TRACKED_EMOTIONS
from animama.domain.runtime_content_descriptor import RuntimeContentRootSelection
from animama.orm.anima_loadout import ORMAnimaLoadout
from animama.orm.content_catalog import ORMAnimaContentBinding, ORMContentCatalogItem
from tests.anima_creation_service_support import anima_creation_fixture, write_json
from tests.content_package_helpers import anima_clip, reviewed_import
from tests.local_http_client import local_client
from tests.typed_loadout_support import (
    LoadoutFixture,
    add_typed_item,
    catalog_source,
    cleanup_loadout_fixture,
    create_loadout_fixture,
)

REACTION_METADATA = {"implementation": {"kind": "anima_clip", "file_role": "sequence"}}


async def _reaction(session, fixture: LoadoutFixture, name: str) -> ORMContentCatalogItem:
    return await add_typed_item(session, fixture, kind="reaction", name=name, metadata=REACTION_METADATA)


async def _included_reaction(session, content_id: str, name: str) -> ORMContentCatalogItem:
    """An Included Reaction with a starter policy logical key; tests delete it themselves."""

    item_id = f"reaction-{uuid4().hex}"
    item = ORMContentCatalogItem(
        id=item_id,
        source="included",
        scope="included",
        owner_user_id=None,
        kind="reaction",
        relative_locator=f"reactions/{item_id}",
        descriptor_relative_path=f"reactions/{item_id}/{item_id}.meta.json",
        logical_key=content_id,
        display_name=name,
        status="valid",
        revision_sha256=uuid4().hex * 2,
        content_metadata={
            "schema_version": 1,
            "content_type": "reaction",
            "content_id": content_id,
            "name": name,
            **REACTION_METADATA,
        },
        diagnostics=[],
        provenance={},
    )
    session.add(item)
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
        family="reaction",
        expected_revision=revision,
        intent=intent,
    )
    result = await service.commit(
        user_id=fixture.user_id,
        anima_id=fixture.anima_id,
        family="reaction",
        expected_revision=revision,
        intent=intent,
        plan_digest=plan.digest,
        idempotency_key=key,
    )
    return result.action


def _add(item: ORMContentCatalogItem, emotion: str, intensity: int) -> dict[str, Any]:
    return {"operation": "add", "emotion": emotion, "intensity": intensity, "source": catalog_source(item)}


async def _revision(session, fixture: LoadoutFixture) -> int:
    root = await session.scalar(
        select(ORMAnimaLoadout)
        .where(ORMAnimaLoadout.anima_id == fixture.anima_id)
        .execution_options(populate_existing=True)
    )
    assert root is not None
    return int(root.revision)


def test_slot_helpers_never_split_the_catalog_item_id() -> None:
    item_id = "1f0e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
    slot = reaction_slot_key("disappointment-4", item_id)
    assert slot == f"reaction:disappointment-4:{item_id}"
    assert parse_reaction_slot_key(slot) == ("disappointment-4", item_id)
    for invalid in ("reaction:joy-2", "reaction:joy-5:item", "reaction:neutral-1:item", "idle:joy-1:item", "gesture:x"):
        assert parse_reaction_slot_key(invalid) is None


def test_starter_policy_cells_are_valid_with_at_most_four_unique_members() -> None:
    entries = starter_loadout_policy()["reactions"]
    pools = starter_reaction_pools()
    assert sum(len(pool) for pool in pools.values()) == len(entries)
    for cell, pool in pools.items():
        emotion, _, level = cell.partition("-")
        assert emotion in TRACKED_EMOTIONS and int(level) in REACTION_INTENSITIES
        assert len(set(pool)) == len(pool) <= REACTION_POOL_LIMIT
    # Every cell holds all of its Included Reactions (D16): one at intensity 1, two at 2-4.
    assert len(pools) == 96
    assert pools["joy-1"] == ("builtin:reaction:joy-1",)
    assert pools["joy-4"] == ("builtin:reaction:joy-4", "builtin:reaction:joy-4-b")


def test_reaction_intent_has_only_pool_operations_and_complete_targets() -> None:
    source = {"type": "catalog", "catalog_item_id": "item", "source": "local"}
    for operation in ("replace", "update", "reconfigure", "revert", "leave_empty", "set"):
        with pytest.raises(ValidationError):
            PyReactionIntent.model_validate(
                {"operation": operation, "emotion": "joy", "intensity": 1, "source": source}
            )
    for invalid in (
        {"operation": "add", "emotion": "joy", "intensity": 5, "source": source},
        {"operation": "add", "emotion": "joy", "intensity": 0, "source": source},
        {"operation": "add", "emotion": "neutral", "intensity": 1, "source": source},
        {"operation": "add", "emotion": "joy", "source": source},
        {"operation": "add", "emotion": "joy", "intensity": 1},
        {"operation": "add", "emotion": "joy", "intensity": 1, "source": source, "config_overrides": {}},
        {"operation": "remove", "binding_id": "row", "emotion": "joy", "intensity": 1},
        {"operation": "remove", "source": source},
        {"operation": "restore_starter", "emotion": "joy", "intensity": 1, "source": source},
        {"operation": "restore_starter", "binding_id": "row"},
    ):
        with pytest.raises(ValidationError):
            PyReactionIntent.model_validate(invalid)
    assert PyReactionIntent.model_validate({"operation": "add", "emotion": "joy", "intensity": 4, "source": source})
    assert PyReactionIntent.model_validate({"operation": "remove", "binding_id": "row"}).binding_id == "row"
    assert PyReactionIntent.model_validate({"operation": "restore_starter", "emotion": "joy", "intensity": 1})


@pytest.mark.asyncio
async def test_reaction_pool_members_are_added_removed_and_restored_per_cell(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    # The starter policy puts builtin:reaction:joy-2 (and joy-2-b, absent here) in the joy-2 pool.
    starter = await _included_reaction(async_session, "builtin:reaction:joy-2", "Joy Starter")
    starter_id = starter.id
    cheer = await _reaction(async_session, fixture, "Cheer")
    cheer_id = cheer.id
    grin = await _reaction(async_session, fixture, "Grin")
    service = AnimaLoadoutService(async_session)
    try:
        empty = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        assert [(cell.emotion, cell.intensity) for cell in empty.reactions] == [
            (emotion, intensity) for emotion in sorted(TRACKED_EMOTIONS) for intensity in (1, 2, 3, 4)
        ]
        assert all(cell.state == "empty" and cell.members == () for cell in empty.reactions)

        assert await _change(service, fixture, revision=1, intent=_add(starter, "joy", 2), key="r-1") == "add"
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        joy2 = next(cell for cell in loadout.reactions if (cell.emotion, cell.intensity) == ("joy", 2))
        assert joy2.state == "starter"
        assert [(member.name, member.origin, member.available) for member in joy2.members] == [
            ("Joy Starter", "starter", True)
        ]

        # A pool holds several Reactions, and one Reaction may sit in several cells.
        assert await _change(service, fixture, revision=2, intent=_add(cheer, "joy", 2), key="r-2") == "add"
        assert await _change(service, fixture, revision=3, intent=_add(cheer, "joy", 4), key="r-3") == "add"
        assert await _change(service, fixture, revision=4, intent=_add(grin, "joy", 1), key="r-4") == "add"
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        cells = {(cell.emotion, cell.intensity): cell for cell in loadout.reactions}
        assert cells[("joy", 2)].state == "custom"
        assert [(member.name, member.origin) for member in cells[("joy", 2)].members] == [
            ("Cheer", "custom"),
            ("Joy Starter", "starter"),
        ]
        assert [member.item_id for member in cells[("joy", 4)].members] == [cheer.id]
        assert cells[("joy", 4)].state == "custom"
        assert loadout.revision == 5
        rows = list(
            await async_session.scalars(
                select(ORMAnimaContentBinding.slot_key).where(ORMAnimaContentBinding.anima_id == fixture.anima_id)
            )
        )
        assert sorted(rows) == sorted(
            [
                reaction_slot_key("joy-2", starter.id),
                reaction_slot_key("joy-2", cheer.id),
                reaction_slot_key("joy-4", cheer.id),
                reaction_slot_key("joy-1", grin.id),
            ]
        )
        starter_member = next(member for member in cells[("joy", 2)].members if member.item_id == starter.id)
        remove = {"operation": "remove", "binding_id": starter_member.binding_id}
        assert await _change(service, fixture, revision=5, intent=remove, key="r-5") == "remove"
        # Removing a member that no longer exists changes nothing.
        assert await _change(service, fixture, revision=6, intent=remove, key="r-6") == "unchanged"
        assert await _revision(async_session, fixture) == 6

        restore = {"operation": "restore_starter", "emotion": "joy", "intensity": 2}
        plan = await service.plan(
            user_id=fixture.user_id, anima_id=fixture.anima_id, family="reaction", expected_revision=6, intent=restore
        )
        assert plan.action == "revert"
        # The plan covers the starter Reactions' revisions: a changed starter makes it stale.
        original_revision = starter.revision_sha256
        starter.revision_sha256 = "f" * 64
        await async_session.commit()
        with pytest.raises(AnimaLoadoutError, match="loadout_plan_stale"):
            await service.commit(
                user_id=fixture.user_id,
                anima_id=fixture.anima_id,
                family="reaction",
                expected_revision=6,
                intent=restore,
                plan_digest=plan.digest,
                idempotency_key="r-stale",
            )
        await async_session.rollback()
        starter = await async_session.get(ORMContentCatalogItem, starter_id, populate_existing=True)
        assert starter is not None
        starter.revision_sha256 = original_revision
        await async_session.commit()
        assert await _revision(async_session, fixture) == 6
        assert await _change(service, fixture, revision=6, intent=restore, key="r-7") == "revert"
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        cells = {(cell.emotion, cell.intensity): cell for cell in loadout.reactions}
        assert cells[("joy", 2)].state == "starter"
        assert [member.item_id for member in cells[("joy", 2)].members] == [starter_id]
        # Restoring one cell leaves the Reaction's other cells alone.
        assert [member.item_id for member in cells[("joy", 4)].members] == [cheer_id]
        assert await _change(service, fixture, revision=7, intent=restore, key="r-8") == "unchanged"

        # A cell whose starter pool is empty restores to empty.
        restore_empty = {"operation": "restore_starter", "emotion": "joy", "intensity": 1}
        assert await _change(service, fixture, revision=7, intent=restore_empty, key="r-9") == "revert"
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        joy1 = next(cell for cell in loadout.reactions if (cell.emotion, cell.intensity) == ("joy", 1))
        assert joy1.state == "empty" and joy1.members == ()
        assert loadout.revision == 8
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id == starter_id))
        await async_session.commit()


@pytest.mark.asyncio
async def test_restore_skips_an_unavailable_starter_with_a_warning(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    # The starter policy puts builtin:reaction:joy-2 (and joy-2-b, absent here) in the joy-2 pool.
    starter = await _included_reaction(async_session, "builtin:reaction:joy-2", "Joy Starter")
    starter_id = starter.id
    cheer = await _reaction(async_session, fixture, "Cheer")
    service = AnimaLoadoutService(async_session)
    try:
        assert await _change(service, fixture, revision=1, intent=_add(cheer, "joy", 2), key="u-1") == "add"
        starter.status = "invalid"
        await async_session.commit()
        restore = {"operation": "restore_starter", "emotion": "joy", "intensity": 2}
        plan = await service.plan(
            user_id=fixture.user_id, anima_id=fixture.anima_id, family="reaction", expected_revision=2, intent=restore
        )
        assert [(warning.code, warning.params) for warning in plan.warnings] == [
            ("starter_reaction_unavailable", {"contentId": "builtin:reaction:joy-2"}),
            ("starter_reaction_unavailable", {"contentId": "builtin:reaction:joy-2-b"}),
        ]
        assert await _change(service, fixture, revision=2, intent=restore, key="u-2") == "revert"
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        joy2 = next(cell for cell in loadout.reactions if (cell.emotion, cell.intensity) == ("joy", 2))
        # The custom member goes and the unavailable starter is not restored.
        assert joy2.state == "empty" and joy2.members == ()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id == starter_id))
        await async_session.commit()


@pytest.mark.asyncio
async def test_starting_a_loadout_leaves_out_an_unavailable_starter_reaction(async_session) -> None:
    """The shared starter step seeds each cell's available starter Reactions, like restore_starter."""

    fixture = await create_loadout_fixture(async_session)
    # The fixture starts a loadout itself; the shared step needs an Anima without one.
    await async_session.execute(delete(ORMAnimaLoadout).where(ORMAnimaLoadout.anima_id == fixture.anima_id))
    joy = await _included_reaction(async_session, "builtin:reaction:joy-2", "Joy Starter")
    unavailable = await _included_reaction(async_session, "builtin:reaction:joy-2-b", "Joy Starter B")
    unavailable.status = "invalid"
    anger = await _included_reaction(async_session, "builtin:reaction:anger-1", "Anger Starter")
    included_ids = [joy.id, unavailable.id, anger.id]
    service = AnimaLoadoutService(async_session)
    try:
        await service.create_starter_loadout(user_id=fixture.user_id, anima_id=fixture.anima_id, store=Mock())
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        cells = {(cell.emotion, cell.intensity): cell for cell in loadout.reactions}
        assert [member.item_id for member in cells["joy", 2].members] == [joy.id]
        assert cells["joy", 2].state == "starter"
        assert [member.item_id for member in cells["anger", 1].members] == [anger.id]
        # Cells whose starters are not installed start empty.
        assert cells["joy", 1].members == ()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id.in_(included_ids)))
        await async_session.commit()


@pytest.mark.asyncio
async def test_invalid_reaction_changes_are_rejected_without_a_revision(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    reactions = [await _reaction(async_session, fixture, f"Reaction {index}") for index in range(5)]
    gesture = await add_typed_item(
        async_session,
        fixture,
        kind="gesture",
        name="Wave",
        metadata={"semantic_key": "wave", "implementation": {"kind": "anima_clip", "file_role": "sequence"}},
    )
    service = AnimaLoadoutService(async_session)
    try:
        for revision, reaction in enumerate(reactions[:REACTION_POOL_LIMIT], start=1):
            await _change(service, fixture, revision=revision, intent=_add(reaction, "joy", 3), key=f"fill-{revision}")
        assert await _revision(async_session, fixture) == 5
        missing = {"type": "catalog", "catalog_item_id": "missing-reaction", "source": "local"}
        rejected = [
            ("reaction_member_duplicate", _add(reactions[0], "joy", 3)),
            ("reaction_pool_full", _add(reactions[4], "joy", 3)),
            ("loadout_source_unavailable", {**_add(reactions[4], "joy", 1), "source": missing}),
            ("loadout_source_unavailable", _add(gesture, "joy", 1)),
            ("reaction_cell_invalid", _add(reactions[4], "joy", 5)),
            ("reaction_cell_invalid", _add(reactions[4], "joy", 0)),
            ("reaction_cell_invalid", _add(reactions[4], "neutral", 1)),
            ("reaction_cell_invalid", {"operation": "restore_starter", "emotion": "joy", "intensity": 5}),
            ("reaction_operation_invalid", {**_add(reactions[4], "joy", 1), "operation": "replace"}),
            ("reaction_operation_invalid", {"operation": "leave_empty", "emotion": "joy", "intensity": 1}),
            ("catalog_source_required", {"operation": "add", "emotion": "joy", "intensity": 1}),
        ]
        for code, intent in rejected:
            with pytest.raises(AnimaLoadoutError, match=code):
                await service.plan(
                    user_id=fixture.user_id,
                    anima_id=fixture.anima_id,
                    family="reaction",
                    expected_revision=5,
                    intent=intent,
                )
        # A change planned against a stale revision is refused at plan and at commit.
        with pytest.raises(AnimaLoadoutError, match="loadout_revision_conflict") as stale:
            await service.plan(
                user_id=fixture.user_id,
                anima_id=fixture.anima_id,
                family="reaction",
                expected_revision=4,
                intent=_add(reactions[4], "joy", 1),
            )
        assert stale.value.current_revision == 5
        with pytest.raises(AnimaLoadoutError, match="loadout_revision_conflict"):
            await service.commit(
                user_id=fixture.user_id,
                anima_id=fixture.anima_id,
                family="reaction",
                expected_revision=4,
                intent=_add(reactions[4], "joy", 1),
                plan_digest="0" * 64,
                idempotency_key="stale",
            )
        spare_id = reactions[4].id
        await async_session.rollback()
        assert await _revision(async_session, fixture) == 5
        # The database also refuses a single-cell Reaction slot without a member.
        async_session.add(
            ORMAnimaContentBinding(
                id=str(uuid4()),
                anima_id=fixture.anima_id,
                slot_key="reaction:joy-2",
                catalog_item_id=spare_id,
                kind="reaction",
                config={},
            )
        )
        with pytest.raises(IntegrityError, match="typed_slot_shape"):
            await async_session.flush()
        await async_session.rollback()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


@pytest.mark.asyncio
async def test_unavailable_member_stays_removable_and_a_pooled_reaction_cannot_be_deleted(
    async_session,
) -> None:
    fixture = await create_loadout_fixture(async_session)
    cheer = await _reaction(async_session, fixture, "Cheer")
    cheer_id, cheer_revision = cheer.id, cheer.revision_sha256
    assert cheer_revision is not None
    service = AnimaLoadoutService(async_session)
    try:
        await _change(service, fixture, revision=1, intent=_add(cheer, "sadness", 4), key="r-1")
        # A Local Reaction used only as a pool member is in use and cannot be deleted.
        store = Mock(owner_id=None)
        store.pending_mutations.return_value = ()
        catalog_service = ContentCatalogService(store=store, catalog=SQLAlchemyContentCatalog(async_session))
        with pytest.raises(ContentConflictError, match="catalog_item_in_use") as refused:
            await catalog_service.delete_item(
                item_id=cheer_id, user_id=fixture.user_id, expected_revision=cheer_revision
            )
        assert refused.value.used_by == (ContentUsage("anima_reaction", fixture.anima_id, fixture.anima_id),)
        await async_session.rollback()
        store.delete_entry.assert_not_called()

        cheer = await async_session.get(ORMContentCatalogItem, cheer_id, populate_existing=True)
        assert cheer is not None
        cheer.status = "invalid"
        await async_session.commit()
        loadout = await service.read_model(user_id=fixture.user_id, anima_id=fixture.anima_id)
        cell = next(cell for cell in loadout.reactions if (cell.emotion, cell.intensity) == ("sadness", 4))
        assert cell.state == "custom"
        assert [(member.name, member.available, member.source) for member in cell.members] == [("Cheer", False, None)]
        assert not any(warning.code == "loadout_source_unavailable" for warning in loadout.warnings)
        [member] = cell.members
        remove = {"operation": "remove", "binding_id": member.binding_id}
        assert await _change(service, fixture, revision=2, intent=remove, key="r-2") == "remove"
        assert await SQLAlchemyContentCatalog(async_session).item_usage(item_id=cheer.id) == ()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


@pytest.mark.asyncio
async def test_runtime_selects_one_root_per_reaction_with_all_its_cells(async_session) -> None:
    fixture = await create_loadout_fixture(async_session)
    cheer = await _reaction(async_session, fixture, "Cheer")
    sigh = await _reaction(async_session, fixture, "Sigh")
    service = AnimaLoadoutService(async_session)
    try:
        additions = [_add(sigh, "sadness", 3), _add(cheer, "joy", 4), _add(cheer, "anger", 1), _add(sigh, "joy", 4)]
        for revision, intent in enumerate(additions, start=1):
            await _change(service, fixture, revision=revision, intent=intent, key=f"r-{revision}")
        visible = await SQLAlchemyContentCatalog(async_session).list_visible(user_id=fixture.user_id)

        selected = await AnimaRuntimeService(async_session)._selections(anima_id=fixture.anima_id, visible=visible)

        reaction_roots = [value for value in selected.roots if value.kind is ContentKind.REACTION]
        # One root per Reaction, ordered by its lowest cell: intensity first, then emotion.
        assert [(value.slot_key, value.catalog_item_id) for value in reaction_roots] == [
            (f"reaction:{cheer.id}", cheer.id),
            (f"reaction:{sigh.id}", sigh.id),
        ]
        assert reaction_roots[0].context == {
            "binding_id": f"reaction:{cheer.id}",
            "reaction_cells": ["anger-1", "joy-4"],
            "origin": "catalog",
        }
        assert reaction_roots[1].context["reaction_cells"] == ["joy-4", "sadness-3"]
        # Reaction roots come after the Avatar, Idle and AI-callable Gestures.
        kinds = [value.kind for value in selected.roots]
        assert all(kind is not ContentKind.GESTURE for kind in kinds[kinds.index(ContentKind.REACTION) :])
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


def _entry(name: str, clip: bytes) -> CatalogContentEntry:
    item_id = str(uuid4())
    motion = CatalogContentFile(
        file_ref=f"catalog-{item_id}",
        item_id=item_id,
        source=ContentSource.LOCAL,
        relative_path=f"reactions/{name}/{name}.json",
        role="sequence",
        media_type="application/json",
        size_bytes=len(clip),
        sha256=hashlib.sha256(clip).hexdigest(),
    )
    return CatalogContentEntry(
        id=item_id,
        source=ContentSource.LOCAL,
        scope=ContentScope.OWNER,
        owner_user_id="owner",
        kind=ContentKind.REACTION,
        relative_locator=f"reactions/{name}",
        display_name=name.title(),
        status=ContentStatus.VALID,
        revision_sha256=hashlib.sha256(name.encode()).hexdigest(),
        logical_key=f"local:reaction:{name}",
        files=(motion,),
        metadata={
            "schema_version": 1,
            "content_type": "reaction",
            "name": name.title(),
            "placement_hint": {"emotion": "joy", "intensity": 4},
            **REACTION_METADATA,
        },
    )


@pytest.mark.asyncio
async def test_every_pool_member_is_projected_once_and_a_missing_member_is_skipped() -> None:
    clip = json.dumps(anima_clip(clip_id="cheer", name="Cheer")).encode()
    cheer, sigh = _entry("cheer", clip), _entry("sigh", clip)
    missing_id = str(uuid4())

    class Catalog:
        entries = [cheer, sigh]

        async def list_visible(self, *, user_id: str):
            return self.entries

        async def mark_scan_required(self, *, source, relative_paths):
            return None

    class Store:
        def open_verified_file(self, **facts):
            return VerifiedContentFile(BytesIO(clip), len(clip), facts["expected_sha256"], facts["media_type"])

    def root(item_id: str, cells: list[str]) -> RuntimeContentRootSelection:
        return RuntimeContentRootSelection(
            f"reaction:{item_id}",
            item_id,
            ContentKind.REACTION,
            context={"binding_id": f"reaction:{item_id}", "reaction_cells": cells, "origin": "catalog"},
        )

    descriptor = await RuntimeContentClosureCompiler(catalog=Catalog(), store=Store()).compile(  # type: ignore[arg-type]
        user_id="owner",
        loadout_revision=1,
        selections=(root(cheer.id, ["joy-1", "sadness-4"]), root(missing_id, ["joy-1"]), root(sigh.id, ["joy-1"])),
        visible_items=Catalog.entries,
    )
    assert [value.item_id for value in descriptor.roots] == [cheer.id, sigh.id]
    assert [issue.item_id for issue in descriptor.diagnostics] == [missing_id]

    runtime = project_typed_runtime_catalog(loadout_revision=1, descriptor=descriptor, visible=Catalog.entries)
    assert [action["binding_id"] for action in runtime["reactions"]] == [f"reaction:{cheer.id}", f"reaction:{sigh.id}"]
    assert runtime["reaction_cells"] == {"joy": {"1": [cheer.id, sigh.id]}, "sadness": {"4": [cheer.id]}}
    # Emotion and intensity are the document's suggestion, not the pools it plays in.
    assert {(action["emotion"], action["intensity"]) for action in runtime["reactions"]} == {("joy", 4)}
    # The missing member's root diagnostic (asserted by item above) reaches the runtime warnings.
    assert [warning["code"] for warning in runtime["warnings"]] == ["catalog_root_unavailable"]


def _empty_pools() -> dict[str, dict[str, list[dict[str, str]]]]:
    return {emotion: {str(level): [] for level in REACTION_INTENSITIES} for emotion in TRACKED_EMOTIONS}


async def _write_clip_reaction(fixture, name: str) -> None:
    root = fixture.paths.local_root / f"reactions/{name}"
    write_json(
        root / f"{name}.meta.json",
        {
            "schema_version": 1,
            "content_type": "reaction",
            "content_id": f"local:reaction:{name}",
            "name": name.title(),
            **REACTION_METADATA,
            "files": [{"path": f"{name}.json", "role": "sequence"}],
        },
    )
    write_json(root / f"{name}.json", anima_clip(clip_id=name, name=name))


@pytest.mark.asyncio
async def test_created_anima_reads_back_its_pools_and_round_trips_them_through_a_package(
    async_session,
    tmp_path,
    monkeypatch,
) -> None:
    # Starter Reactions are installed, so an import that refilled starter pools would show it.
    async with anima_creation_fixture(async_session, tmp_path, full_starter=True) as fixture:
        names = ["cheer", "beam", "grin", "smirk", "pout"]
        for name in names:
            await _write_clip_reaction(fixture, name)
        catalog = SQLAlchemyContentCatalog(async_session)
        content = ContentCatalogService(catalog=catalog, store=fixture.store())
        current = {item.relative_locator: item for item in (await content.rescan(user_id=fixture.owner)).items}
        items = {name: current[f"reactions/{name}"] for name in names}
        assert all(item.status is ContentStatus.VALID for item in items.values())
        pools = _empty_pools()
        pools["joy"]["1"] = [item_ref(items["cheer"]), item_ref(items["beam"])]
        pools["joy"]["4"] = [item_ref(items[name]) for name in names[:4]]
        pools["sadness"]["2"] = [item_ref(items["cheer"])]
        spec = fixture.request().model_dump()
        spec["reactions"] = pools
        spec["expected_source_revisions"].update(
            {item.id: {"kind": "reaction", "revision_sha256": item.revision_sha256} for item in items.values()}
        )
        # Pout is chosen only by the refused request below.
        del spec["expected_source_revisions"][items["pout"].id]

        # A diagnostic names the cell and the member's place in its pool.
        missing = AnimaSpec.model_validate(fixture.request().spec().model_dump())
        missing_pools = _empty_pools()
        missing_pools["joy"]["4"] = [
            item_ref(items["cheer"]),
            {"item_id": "reaction-gone", "revision_sha256": "d" * 64},
        ]
        missing = AnimaSpec.model_validate({**missing.model_dump(), "reactions": missing_pools})
        with pytest.raises(AnimaCreationError) as error:
            await fixture.service(async_session).validate(user_id=fixture.owner, spec=missing)
        issues = error.value.detail["issues"]
        assert isinstance(issues, list)
        assert [issue["path"] for issue in issues] == ["/reactions/joy/4/1"]

        app = fixture.app(async_session, monkeypatch)
        async with local_client(app) as client:
            # More than four members, or a Reaction twice in one cell, is refused.
            too_many = json.loads(json.dumps(spec))
            too_many["reactions"]["joy"]["4"] = [item_ref(items[name]) for name in names]
            twice = json.loads(json.dumps(spec))
            twice["reactions"]["joy"]["1"] = [item_ref(items["cheer"])] * 2
            three_levels = json.loads(json.dumps(spec))
            del three_levels["reactions"]["joy"]["4"]
            for invalid in (too_many, twice, three_levels):
                response = await client.post("/v1/animas", json=invalid)
                assert response.status_code == 422, response.text
            created = await client.post("/v1/animas", json=spec)
            assert created.status_code == 201, created.text
            anima_id = created.json()["anima_id"]
            loadout = await client.get(f"/v1/animas/{anima_id}/loadout")
            assert loadout.status_code == 200, loadout.text
            cells = loadout.json()["reactions"]

        assert len(cells) == 96
        read_back = {
            (cell["emotion"], cell["intensity"]): sorted(member["name"] for member in cell["members"])
            for cell in cells
            if cell["members"]
        }
        expected = {
            ("joy", 1): ["Beam", "Cheer"],
            ("joy", 4): sorted(name.title() for name in names[:4]),
            ("sadness", 2): ["Cheer"],
        }
        assert read_back == expected
        assert all(cell["state"] == ("custom" if cell["members"] else "empty") for cell in cells)

        sources = AnimaPackageSourceService(
            catalog=catalog, sources=SQLAlchemyAnimaPackageSourceRepository(async_session)
        )
        packages = ContentPackageService(
            content=content,
            exports_root=fixture.paths.exports_staging_root,
            imports_root=fixture.paths.imports_staging_root,
            anima_sources=sources,
            uow=SQLAlchemyAnimaAggregateUnitOfWork(async_session),
            default_model_provider_id=fixture.provider,
        )
        exported = await sources.capture(user_id=fixture.owner, anima_id=anima_id)
        # Each member is an ordinary Reaction entry; pools have a stable order.
        assert exported.definition.reactions["joy"]["1"] == sorted([items["cheer"].id, items["beam"].id])
        assert exported.definition.reactions["joy"]["4"] == sorted(items[name].id for name in names[:4])
        assert exported.definition.reactions["joy"]["2"] == []
        summary = await packages.summarize(user_id=fixture.owner, anima_id=anima_id)
        review = await packages.prepare_export(user_id=fixture.owner, anima_id=anima_id, expected_digest=summary.digest)
        cached = await packages.get_export(user_id=fixture.owner, export_id=review.export_id)
        command = await reviewed_import(
            packages, user_id=fixture.owner, archive_path=cached.path, operation_id="reaction-pools-copy"
        )
        result = await packages.imports.commit(**command)
        assert result.anima_id is not None and result.anima_id != anima_id
        imported = await AnimaLoadoutService(async_session).read_model(user_id=fixture.owner, anima_id=result.anima_id)
        imported_pools = {
            (cell.emotion, cell.intensity): sorted(member.name for member in cell.members)
            for cell in imported.reactions
            if cell.members
        }
        # Exactly the packaged pools, as renamed copies of the packaged Reactions; no starter Reactions are filled in.
        assert imported_pools == {key: [f"{name}-2" for name in pool] for key, pool in expected.items()}
        imported_ids = {member.item_id for cell in imported.reactions for member in cell.members}
        assert imported_ids.isdisjoint(item.id for item in items.values())


@pytest.mark.asyncio
async def test_new_anima_from_the_recommended_pools_reads_96_starter_cells(
    async_session,
    tmp_path,
) -> None:
    async with anima_creation_fixture(async_session, tmp_path, full_starter=True) as fixture:
        service = fixture.service(async_session)
        options = await service.sources.options(user_id=fixture.owner)
        assert options["diagnostics"] == []
        recommended = options["recommended"]["reactions"]
        assert {level for cells in recommended.values() for level in cells} == {"1", "2", "3", "4"}
        assert options["counts"]["recommended_reaction_cells"] == options["counts"]["available_reaction_cells"] == 96
        assert options["counts"]["recommended_reactions"] == options["counts"]["available_reactions"] == 168
        spec = fixture.request().model_dump()
        spec.update(options["recommended"])
        spec["expected_source_revisions"].update(options["expected_source_revisions"])
        created = await service.create(user_id=fixture.owner, request=CreateAnimaRequest.model_validate(spec))
        loadout = await AnimaLoadoutService(async_session).read_model(
            user_id=fixture.owner, anima_id=created["anima_id"]
        )
        assert len(loadout.reactions) == 96
        pools = starter_reaction_pools()
        for cell in loadout.reactions:
            keys = pools.get(f"{cell.emotion}-{cell.intensity}", ())
            # Every cell starts with all of its Included Reactions (D16).
            assert len(keys) == (1 if cell.intensity == 1 else 2)
            assert cell.state == "starter"
            assert [(member.origin, member.available) for member in cell.members] == [("starter", True)] * len(keys)
            assert [member.name for member in cell.members] == [key.rsplit(":", 1)[-1] for key in keys]


def test_portable_reactions_are_96_unique_pools_of_at_most_four() -> None:
    reactions: dict[str, dict[str, list[str]]] = {
        emotion: {str(level): [] for level in REACTION_INTENSITIES} for emotion in TRACKED_EMOTIONS
    }
    base = {
        "display_name": "Pools",
        "identity_markdown": "# Pools\n",
        "avatar": "avatar",
        "gestures": [],
        "reactions": reactions,
        "idle": {"default": [], "cells": {}},
        "appearance": {"profile": None, "background": None},
    }
    reactions["joy"]["4"] = ["a", "b", "c", "d"]
    reactions["joy"]["1"] = ["a"]
    definition = PortableAnima.model_validate(base)
    assert list(definition.reaction_members()).count(("joy", 4, "a")) == 1
    assert [ref for ref, kind in definition.entry_references() if kind is ContentKind.REACTION] == ["a", "b", "c", "d"]
    for mutate in (
        lambda value: value["reactions"]["joy"].__setitem__("4", ["a", "b", "c", "d", "e"]),
        lambda value: value["reactions"]["joy"].__setitem__("1", ["a", "a"]),
        lambda value: value["reactions"]["joy"].pop("4"),
        lambda value: value["reactions"]["joy"].__setitem__("1", {"entry_id": "a", "config": {}}),
    ):
        invalid = json.loads(json.dumps(base))
        mutate(invalid)
        with pytest.raises(ValidationError):
            PortableAnima.model_validate(invalid)


def test_creation_requests_take_all_96_cells_as_pools() -> None:
    ref = {"item_id": "reaction-a", "revision_sha256": "a" * 64}
    pools: dict[str, dict[str, list[dict[str, str]]]] = {
        emotion: {str(level): [] for level in REACTION_INTENSITIES} for emotion in TRACKED_EMOTIONS
    }
    pools["joy"]["4"] = [ref, {**ref, "item_id": "reaction-b"}]
    request = {
        "schema_version": 1,
        "display_name": "Pools",
        "identity_markdown": "# Pools\n",
        "avatar": {"item_id": "avatar", "revision_sha256": "b" * 64},
        "appearance": {"profile": None, "background": None},
        "gestures": [],
        "reactions": pools,
        "starter_pack": {"id": "builtin:starter-loadout", "version": 1, "revision_sha256": "c" * 64},
        "expected_source_revisions": {},
        "idempotency_key": "pools",
    }
    parsed = CreateAnimaRequest.model_validate(request)
    assert [value.item_id for value in parsed.reactions["joy"]["4"]] == ["reaction-a", "reaction-b"]
    for level, pool in (("4", [ref] * 2), ("4", [{**ref, "item_id": f"r-{index}"} for index in range(5)])):
        invalid = json.loads(json.dumps(request))
        invalid["reactions"]["joy"][level] = pool
        with pytest.raises(ValidationError):
            CreateAnimaRequest.model_validate(invalid)
    invalid = json.loads(json.dumps(request))
    invalid["reactions"]["joy"]["2"] = None
    with pytest.raises(ValidationError):
        CreateAnimaRequest.model_validate(invalid)
