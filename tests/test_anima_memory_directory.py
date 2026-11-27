"""Backend contracts behind the Memory workspace's virtual Animas directory."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import delete, func, select

from animama.adapters.repositories.sqlalchemy.anima_repo import SQLAlchemyAnimaRepository
from animama.adapters.repositories.sqlalchemy.memory_entry_repo import SQLAlchemyMemoryEntryRepository
from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.services.memory_entry_service import (
    MemoryEntryConflictError,
    MemoryEntryProtectedError,
    MemoryEntryService,
    MemoryEntryValidationError,
)
from animama.domain.anima_definition import ANIMA_MEMORIES_KIND, ANIMA_MEMORIES_MAX_BYTES, ANIMA_MEMORIES_TEMPLATE
from animama.domain.memory_entry import MEMORY_ENTRY_OPERATION_UNDO
from animama.domain.request_principal import RequestPrincipal
from animama.orm import ORMAnima, ORMMemoryEntry, ORMMemoryEntryVersion
from animama.product_http.chat.active_turns import ActiveChatTurns
from animama.product_http.routes import animas as anima_router, memory as memory_entries_router
from animama.server.app import app
from animama.server.schemas.memory_entry import (
    PyMemoryEntryCreateRequest,
    PyMemoryEntryPatchRequest,
    PyMemoryEntryRevertRequest,
)
from tests.product_http_support import TEST_POLICY, local_ports

_BASE_TIME = datetime(2026, 1, 1, 12, 0, 0)


def _user(user_id: str) -> RequestPrincipal:
    return RequestPrincipal(id=user_id)


async def _delete_anima(async_session, anima_id: str, user: RequestPrincipal) -> None:
    await anima_router.delete_anima(
        anima_id,
        repositories=SQLAlchemyProductRepositories(async_session),
        user=user,
        ports=local_ports(),
        turns=ActiveChatTurns(),
    )


def _service(async_session) -> MemoryEntryService:
    return MemoryEntryService(
        memory_entries=SQLAlchemyMemoryEntryRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
        animas=SQLAlchemyAnimaRepository(async_session),
    )


async def _store_anima(async_session, *, user_id: str, name: str, created_offset: int = 0) -> str:
    anima_id = f"anima-{uuid.uuid4()}"
    async_session.add(
        ORMAnima(
            id=anima_id,
            user_id=user_id,
            display_name=name,
            created_at=_BASE_TIME + timedelta(minutes=created_offset),
        )
    )
    await async_session.flush()
    return anima_id


async def _create_identity(async_session, *, user_id: str, anima_id: str, content: str = "# Identity"):
    return await memory_entries_router.create_memory_entry(
        PyMemoryEntryCreateRequest(
            anima_id=anima_id,
            expected_aggregate_revision=1,
            type="file",
            name="IDENTITY.md",
            content=content,
            description="Who this Anima is",
        ),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=_user(user_id),
    )


async def _repair_memories(async_session, *, user_id: str, anima_id: str):
    return await memory_entries_router.repair_anima_memories(
        anima_id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=_user(user_id)
    )


async def _aggregate_revision(async_session, anima_id: str) -> int:
    revision = await async_session.scalar(select(ORMAnima.aggregate_revision).where(ORMAnima.id == anima_id))
    assert isinstance(revision, int)
    return revision


async def _store_legacy_anima_file(async_session, *, user_id: str, anima_id: str, name: str) -> str:
    """Insert an Anima-scope row that predates the two-file rule."""

    entry = ORMMemoryEntry(
        id=f"mem-{uuid.uuid4()}",
        user_id=user_id,
        anima_id=anima_id,
        parent_id=None,
        type="file",
        name=name,
        normalized_name=name.casefold(),
        path=name,
        normalized_path=name.casefold(),
        content="legacy",
        content_sha256="0" * 64,
        size_bytes=6,
        version=1,
        metadata_={},
    )
    async_session.add(entry)
    await async_session.commit()
    return entry.id


@pytest_asyncio.fixture
async def clean_tables(async_session):
    async def _clean() -> None:
        await async_session.execute(delete(ORMMemoryEntryVersion))
        await async_session.execute(delete(ORMMemoryEntry).where(ORMMemoryEntry.parent_id.is_not(None)))
        await async_session.execute(delete(ORMMemoryEntry))
        await async_session.commit()

    await _clean()
    yield
    await _clean()


@pytest.mark.asyncio
async def test_anima_identity_listing_orders_owned_animas_and_reports_missing_identity(
    async_session, clean_tables
) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    foreign_id = f"user-{uuid.uuid4()}"
    later = await _store_anima(async_session, user_id=owner_id, name="Annie", created_offset=5)
    earlier = await _store_anima(async_session, user_id=owner_id, name="Annie", created_offset=1)
    await _store_anima(async_session, user_id=foreign_id, name="Foreign", created_offset=0)
    identity = await _create_identity(async_session, user_id=owner_id, anima_id=earlier)

    memories = await _repair_memories(async_session, user_id=owner_id, anima_id=later)

    listing = await memory_entries_router.list_anima_identities(
        repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=_user(owner_id)
    )

    assert [item.anima_id for item in listing.identities] == [earlier, later]
    first, second = listing.identities
    assert first.display_name == "Annie"
    assert first.aggregate_revision == identity.aggregate_revision
    assert first.identity_status == "ready"
    assert first.entry is not None
    assert first.entry.id == identity.id
    assert first.entry.scope == "anima"
    assert first.entry.description == "Who this Anima is"
    assert "content" not in first.entry.model_dump()
    assert second.entry is None
    assert second.identity_status == "repair_required"
    # MEMORIES.md is reported independently of the identity.
    assert first.memories_entry is None
    assert second.memories_entry is not None
    assert second.memories_entry.id == memories.id
    assert second.memories_entry.kind == ANIMA_MEMORIES_KIND
    assert "content" not in second.memories_entry.model_dump()


@pytest.mark.asyncio
async def test_user_scope_rejects_reserved_animas_paths(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    notes = await memory_entries_router.create_memory_entry(
        PyMemoryEntryCreateRequest(type="directory", name="notes"),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )

    attempts = [
        PyMemoryEntryCreateRequest(type="directory", name="Animas"),
        PyMemoryEntryCreateRequest(type="file", name="animas/annie.md", content="x", create_parents=True),
    ]
    for request in attempts:
        with pytest.raises(HTTPException) as error:
            await memory_entries_router.create_memory_entry(
                request, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
            )
        assert error.value.status_code == 403
        assert "reserved" in error.value.detail

    with pytest.raises(HTTPException) as rename_error:
        await memory_entries_router.patch_memory_entry(
            notes.id,
            PyMemoryEntryPatchRequest(name="ANIMAS", expected_version=notes.version),
            repositories=SQLAlchemyProductRepositories(async_session),
            policy=TEST_POLICY,
            user=user,
        )
    assert rename_error.value.status_code == 403

    with pytest.raises(MemoryEntryProtectedError):
        await _service(async_session).put_file_by_path(
            user_id=owner_id,
            path="animas/notes.md",
            content="x",
            expected_version=0,
            create_parents=True,
        )


@pytest.mark.asyncio
async def test_existing_reserved_user_entries_can_only_be_moved_renamed_or_deleted(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    legacy_dir = ORMMemoryEntry(
        id=f"mem-{uuid.uuid4()}",
        user_id=owner_id,
        anima_id=None,
        parent_id=None,
        type="directory",
        name="animas",
        normalized_name="animas",
        path="animas",
        normalized_path="animas",
        version=1,
        metadata_={},
    )
    async_session.add(legacy_dir)
    await async_session.flush()
    legacy_file = ORMMemoryEntry(
        id=f"mem-{uuid.uuid4()}",
        user_id=owner_id,
        anima_id=None,
        parent_id=legacy_dir.id,
        type="file",
        name="old.md",
        normalized_name="old.md",
        path="animas/old.md",
        normalized_path="animas/old.md",
        content="legacy",
        content_sha256="0" * 64,
        size_bytes=6,
        version=1,
        metadata_={},
    )
    async_session.add(legacy_file)
    await async_session.commit()
    dir_id, file_id = legacy_dir.id, legacy_file.id

    listed = await memory_entries_router.list_memory_entries(
        repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user, recursive=True
    )
    assert {entry.path for entry in listed.entries} == {"animas", "animas/old.md"}

    with pytest.raises(HTTPException) as edit_error:
        await memory_entries_router.patch_memory_entry(
            file_id,
            PyMemoryEntryPatchRequest(content="edited", expected_version=1),
            repositories=SQLAlchemyProductRepositories(async_session),
            policy=TEST_POLICY,
            user=user,
        )
    assert edit_error.value.status_code == 403

    with pytest.raises(HTTPException) as rename_inside_error:
        await memory_entries_router.patch_memory_entry(
            file_id,
            PyMemoryEntryPatchRequest(name="renamed.md", expected_version=1),
            repositories=SQLAlchemyProductRepositories(async_session),
            policy=TEST_POLICY,
            user=user,
        )
    assert rename_inside_error.value.status_code == 403

    moved = await memory_entries_router.patch_memory_entry(
        file_id,
        PyMemoryEntryPatchRequest(parent_id=None, expected_version=1),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert moved.path == "old.md"
    edited = await memory_entries_router.patch_memory_entry(
        file_id,
        PyMemoryEntryPatchRequest(content="edited", expected_version=moved.version),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert edited.content == "edited"

    with pytest.raises(HTTPException) as move_into_error:
        await memory_entries_router.patch_memory_entry(
            file_id,
            PyMemoryEntryPatchRequest(parent_id=dir_id, expected_version=edited.version),
            repositories=SQLAlchemyProductRepositories(async_session),
            policy=TEST_POLICY,
            user=user,
        )
    assert move_into_error.value.status_code == 403

    renamed_dir = await memory_entries_router.patch_memory_entry(
        dir_id,
        PyMemoryEntryPatchRequest(name="old-animas", expected_version=1),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert renamed_dir.path == "old-animas"


@pytest.mark.asyncio
async def test_existing_reserved_user_file_can_be_deleted_but_not_reverted(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    service = _service(async_session)
    created = await memory_entries_router.create_memory_entry(
        PyMemoryEntryCreateRequest(type="file", name="legacy.md", content="v1"),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    updated = await memory_entries_router.patch_memory_entry(
        created.id,
        PyMemoryEntryPatchRequest(content="v2", expected_version=created.version),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    # Simulate an entry that predates the reservation by renaming it in storage.
    legacy = await async_session.get(ORMMemoryEntry, created.id)
    assert legacy is not None
    legacy.name = legacy.path = "Animas"
    legacy.normalized_name = legacy.normalized_path = "animas"
    entry_id = created.id
    await async_session.commit()

    with pytest.raises(MemoryEntryProtectedError):
        await service.revert_entry(
            user_id=owner_id,
            entry_id=entry_id,
            target_version=1,
            expected_version=updated.version,
        )
    await memory_entries_router.delete_memory_entry(
        entry_id,
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
        expected_version=updated.version,
    )
    with pytest.raises(HTTPException) as missing:
        await memory_entries_router.get_memory_entry(
            entry_id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
        )
    assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_deleting_anima_removes_its_scoped_memory_only(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    doomed = await _store_anima(async_session, user_id=owner_id, name="Annie")
    kept = await _store_anima(async_session, user_id=owner_id, name="Caitlin", created_offset=1)
    doomed_identity = await _create_identity(async_session, user_id=owner_id, anima_id=doomed)
    await memory_entries_router.patch_memory_entry(
        doomed_identity.id,
        PyMemoryEntryPatchRequest(
            content="# Updated identity",
            expected_version=doomed_identity.version,
            expected_aggregate_revision=doomed_identity.aggregate_revision,
        ),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    memories = await _repair_memories(async_session, user_id=owner_id, anima_id=doomed)
    await memory_entries_router.patch_memory_entry(
        memories.id,
        PyMemoryEntryPatchRequest(content="We met today.", expected_version=memories.version),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    kept_identity = await _create_identity(async_session, user_id=owner_id, anima_id=kept)
    profile = await memory_entries_router.create_memory_entry(
        PyMemoryEntryCreateRequest(type="file", name="PROFILE.md", content="# Me"),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )

    await _delete_anima(async_session, doomed, user)

    remaining_entries = (
        await async_session.execute(select(func.count()).where(ORMMemoryEntry.anima_id == doomed))
    ).scalar_one()
    remaining_versions = (
        await async_session.execute(select(func.count()).where(ORMMemoryEntryVersion.anima_id == doomed))
    ).scalar_one()
    assert remaining_entries == 0
    assert remaining_versions == 0
    for entry_id in (doomed_identity.id, memories.id):
        with pytest.raises(HTTPException) as missing:
            await memory_entries_router.get_memory_entry(
                entry_id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
            )
        assert missing.value.status_code == 404

    assert (
        await memory_entries_router.get_memory_entry(
            kept_identity.id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
        )
    ).id
    assert (
        await memory_entries_router.get_memory_entry(
            profile.id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
        )
    ).id
    listing = await memory_entries_router.list_anima_identities(
        repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
    )
    assert [item.anima_id for item in listing.identities] == [kept]

    with pytest.raises(HTTPException) as repeat:
        await _delete_anima(async_session, doomed, user)
    assert repeat.value.status_code == 404


@pytest.mark.asyncio
async def test_trusted_identity_writes_lock_the_current_anima_revision(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    anima_id = await _store_anima(async_session, user_id=owner_id, name="Annie")
    identity = await _create_identity(async_session, user_id=owner_id, anima_id=anima_id, content="# Before")
    animas = SQLAlchemyAnimaRepository(async_session)
    renamed = await animas.record_definition_revision(
        user_id=owner_id,
        anima_id=anima_id,
        expected_revision=identity.aggregate_revision,
        reason="rename",
        display_name="Annie Two",
    )
    await async_session.commit()
    service = _service(async_session)

    with pytest.raises(MemoryEntryConflictError):
        await service.patch_entry(
            user_id=owner_id,
            entry_id=identity.id,
            expected_version=identity.version,
            content="# After",
            content_set=True,
        )

    updated = await service.patch_entry(
        user_id=owner_id,
        entry_id=identity.id,
        expected_version=identity.version,
        content="# After",
        content_set=True,
        use_current_aggregate_revision=True,
    )
    assert updated.content == "# After"
    assert updated.aggregate_revision == renamed.aggregate_revision + 1

    with pytest.raises(MemoryEntryValidationError):
        await service.patch_entry(
            user_id=owner_id,
            entry_id=identity.id,
            expected_version=updated.version,
            content="   ",
            content_set=True,
            use_current_aggregate_revision=True,
        )
    with pytest.raises(MemoryEntryConflictError):
        await service.patch_entry(
            user_id=owner_id,
            entry_id=identity.id,
            expected_version=identity.version,
            content="# Stale",
            content_set=True,
            use_current_aggregate_revision=True,
        )

    undone = await service.undo_approved_update(
        user_id=owner_id,
        entry_id=identity.id,
        expected_version=updated.version,
        old_content="# Before",
        old_description="Who this Anima is",
        change_metadata={"source_type": "memory_manager_undo"},
        use_current_aggregate_revision=True,
    )
    assert undone.content == "# Before"
    assert undone.aggregate_revision == updated.aggregate_revision + 1
    history = await service.list_versions(user_id=owner_id, entry_id=identity.id)
    assert history.versions[0].operation == MEMORY_ENTRY_OPERATION_UNDO

    with pytest.raises(MemoryEntryValidationError):
        await service.undo_approved_update(
            user_id=owner_id,
            entry_id=identity.id,
            expected_version=undone.version,
            old_content="",
            old_description=None,
            change_metadata={"source_type": "memory_manager_undo"},
            use_current_aggregate_revision=True,
        )
    with pytest.raises(MemoryEntryConflictError):
        await service.undo_approved_update(
            user_id=owner_id,
            entry_id=identity.id,
            expected_version=undone.version,
            old_content="# Without the trusted lock",
            old_description=None,
            change_metadata={"source_type": "memory_manager_undo"},
        )
    with pytest.raises(MemoryEntryProtectedError):
        await service.undo_approved_create(
            user_id=owner_id,
            entry_id=identity.id,
            expected_version=undone.version,
            change_metadata={"source_type": "memory_manager_undo"},
        )


@pytest.mark.asyncio
async def test_anima_memories_repair_creates_the_template_once_for_owned_animas(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    anima_id = await _store_anima(async_session, user_id=owner_id, name="Annie")

    created = await _repair_memories(async_session, user_id=owner_id, anima_id=anima_id)

    assert (created.path, created.kind, created.scope) == ("MEMORIES.md", ANIMA_MEMORIES_KIND, "anima")
    assert created.version == 1
    assert created.description == "Annie's memories"
    assert "content" not in created.model_dump()
    stored = await memory_entries_router.get_memory_entry(
        created.id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
    )
    assert stored.content == ANIMA_MEMORIES_TEMPLATE
    assert stored.aggregate_revision is None

    edited = await memory_entries_router.patch_memory_entry(
        created.id,
        PyMemoryEntryPatchRequest(content="We met today.", expected_version=created.version),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    repeated = await _repair_memories(async_session, user_id=owner_id, anima_id=anima_id)
    assert (repeated.id, repeated.version) == (edited.id, edited.version)
    unchanged = await memory_entries_router.get_memory_entry(
        created.id, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
    )
    assert unchanged.content == "We met today."
    assert await _aggregate_revision(async_session, anima_id) == 1

    for requester, target in ((f"user-{uuid.uuid4()}", anima_id), (owner_id, f"anima-{uuid.uuid4()}")):
        with pytest.raises(HTTPException) as missing:
            await _repair_memories(async_session, user_id=requester, anima_id=target)
        assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_anima_memories_edits_are_protected_and_leave_the_definition_alone(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    anima_id = await _store_anima(async_session, user_id=owner_id, name="Annie")
    identity = await _create_identity(async_session, user_id=owner_id, anima_id=anima_id)
    memories = await _repair_memories(async_session, user_id=owner_id, anima_id=anima_id)
    revision = await _aggregate_revision(async_session, anima_id)

    # No aggregate revision is required, and line endings are normalized.
    edited = await memory_entries_router.patch_memory_entry(
        memories.id,
        PyMemoryEntryPatchRequest(content="# Memories\r\n\nWe met on a rainy day.\r", expected_version=1),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert edited.content == "# Memories\n\nWe met on a rainy day.\n"
    assert edited.aggregate_revision is None
    blank = await memory_entries_router.patch_memory_entry(
        memories.id,
        PyMemoryEntryPatchRequest(content="", expected_version=edited.version),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert blank.content == "" and blank.kind == ANIMA_MEMORIES_KIND
    for content, detail in (
        ("bad\x00text", "anima_memories_invalid"),
        ("a" * (ANIMA_MEMORIES_MAX_BYTES + 1), "anima_memories_too_large"),
    ):
        with pytest.raises(HTTPException) as invalid:
            await memory_entries_router.patch_memory_entry(
                memories.id,
                PyMemoryEntryPatchRequest(content=content, expected_version=blank.version),
                repositories=SQLAlchemyProductRepositories(async_session),
                policy=TEST_POLICY,
                user=user,
            )
        assert (invalid.value.status_code, invalid.value.detail) == (400, detail)
    reverted = await memory_entries_router.revert_memory_entry(
        memories.id,
        PyMemoryEntryRevertRequest(target_version=edited.version, expected_version=blank.version),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert reverted.content == edited.content

    for request in (
        PyMemoryEntryPatchRequest(name="OTHER.md", expected_version=reverted.version),
        PyMemoryEntryPatchRequest(parent_id=None, expected_version=reverted.version),
        PyMemoryEntryPatchRequest(kind="user_memory", expected_version=reverted.version),
    ):
        with pytest.raises(HTTPException) as protected:
            await memory_entries_router.patch_memory_entry(
                memories.id,
                request,
                repositories=SQLAlchemyProductRepositories(async_session),
                policy=TEST_POLICY,
                user=user,
            )
        assert protected.value.status_code == 403
    with pytest.raises(HTTPException) as undeletable:
        await memory_entries_router.delete_memory_entry(
            memories.id,
            repositories=SQLAlchemyProductRepositories(async_session),
            policy=TEST_POLICY,
            user=user,
            expected_version=reverted.version,
        )
    assert undeletable.value.status_code == 403
    with pytest.raises(MemoryEntryProtectedError):
        await _service(async_session).undo_approved_create(
            user_id=owner_id,
            entry_id=memories.id,
            expected_version=reverted.version,
            change_metadata={"source_type": "memory_manager_undo"},
        )

    # A kind-less whole-file write keeps the reserved kind.
    rewritten = await _service(async_session).put_file_by_path(
        user_id=owner_id,
        anima_id=anima_id,
        path="memories.md",
        content="Rewritten",
        expected_version=reverted.version,
    )
    assert (rewritten.path, rewritten.kind) == ("MEMORIES.md", ANIMA_MEMORIES_KIND)

    # None of these writes advanced the definition, so an open identity draft still saves.
    assert await _aggregate_revision(async_session, anima_id) == revision
    saved_identity = await memory_entries_router.patch_memory_entry(
        identity.id,
        PyMemoryEntryPatchRequest(
            content="# Updated identity", expected_version=identity.version, expected_aggregate_revision=revision
        ),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert saved_identity.aggregate_revision == revision + 1


@pytest.mark.asyncio
async def test_anima_scope_admits_only_identity_and_memories(async_session, clean_tables) -> None:
    owner_id = f"user-{uuid.uuid4()}"
    user = _user(owner_id)
    anima_id = await _store_anima(async_session, user_id=owner_id, name="Annie")
    # Rejected writes roll back the request transaction, so keep the Anima durable.
    await async_session.commit()

    for request in (
        PyMemoryEntryCreateRequest(anima_id=anima_id, type="file", name="notes.md", content="x"),
        PyMemoryEntryCreateRequest(anima_id=anima_id, type="directory", name="notes"),
        PyMemoryEntryCreateRequest(
            anima_id=anima_id, type="file", name="notes/extra.md", content="x", create_parents=True
        ),
    ):
        with pytest.raises(HTTPException) as rejected:
            await memory_entries_router.create_memory_entry(
                request, repositories=SQLAlchemyProductRepositories(async_session), policy=TEST_POLICY, user=user
            )
        assert rejected.value.status_code == 403
        assert "IDENTITY.md and MEMORIES.md" in rejected.value.detail
    with pytest.raises(MemoryEntryProtectedError):
        await _service(async_session).put_file_by_path(
            user_id=owner_id,
            anima_id=anima_id,
            path="notes/extra.md",
            content="x",
            expected_version=0,
            create_parents=True,
        )
    with pytest.raises(HTTPException) as misplaced_kind:
        await memory_entries_router.create_memory_entry(
            PyMemoryEntryCreateRequest(type="file", name="relationship.md", content="x", kind=ANIMA_MEMORIES_KIND),
            repositories=SQLAlchemyProductRepositories(async_session),
            policy=TEST_POLICY,
            user=user,
        )
    assert misplaced_kind.value.status_code == 400

    # The reserved file itself can be created explicitly, with canonical casing and kind.
    memories = await memory_entries_router.create_memory_entry(
        PyMemoryEntryCreateRequest(anima_id=anima_id, type="file", name="memories.md", content="Hello\r\n"),
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
    )
    assert (memories.path, memories.kind, memories.content) == ("MEMORIES.md", ANIMA_MEMORIES_KIND, "Hello\n")
    listing = await memory_entries_router.list_memory_entries(
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
        anima_id=anima_id,
        recursive=True,
    )
    assert [entry.path for entry in listing.entries] == ["MEMORIES.md"]

    # Rows that predate the rule can be read or deleted, but not renamed within the folder
    # or moved onto a protected file.
    legacy_id = await _store_legacy_anima_file(async_session, user_id=owner_id, anima_id=anima_id, name="old.md")
    for name in ("renamed.md", "IDENTITY.md"):
        with pytest.raises(HTTPException) as rename_error:
            await memory_entries_router.patch_memory_entry(
                legacy_id,
                PyMemoryEntryPatchRequest(name=name, expected_version=1),
                repositories=SQLAlchemyProductRepositories(async_session),
                policy=TEST_POLICY,
                user=user,
            )
        assert rename_error.value.status_code == 403
    await memory_entries_router.delete_memory_entry(
        legacy_id,
        repositories=SQLAlchemyProductRepositories(async_session),
        policy=TEST_POLICY,
        user=user,
        expected_version=1,
    )


def test_openapi_exposes_anima_identity_listing() -> None:
    app.openapi_schema = None
    openapi = app.openapi()
    assert "get" in openapi["paths"]["/v1/memory/anima-identities"]
    item = openapi["components"]["schemas"]["PyAnimaIdentityItem"]["properties"]
    assert {"anima_id", "display_name", "aggregate_revision", "identity_status", "entry", "memories_entry"} <= set(item)
    assert "post" in openapi["paths"]["/v1/memory/anima-memories/{anima_id}:repair"]
