"""Issuance and bundle reads against a real database and Local library: results and work per request."""

from __future__ import annotations

import json
import re
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import delete, event, func, select, update

import animama
from animama.adapters.content_store import FilesystemContentStore
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.ports.avatar_face_parts import AvatarFacePartOverride
from animama.app.services import anima_runtime_service
from animama.app.services.anima_runtime_service import AnimaRuntimeService, PreparedRuntime, RuntimeSnapshotError
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.runtime_bundle_service import RuntimeBundleService
from animama.app.services.runtime_content_closure import RuntimeContentClosureCompiler
from animama.domain.anima_loadout import idle_slot_key
from animama.domain.content_catalog import (
    CatalogContentEntry,
    CatalogContentFile,
    ContentKind,
    ContentScope,
    ContentSource,
    ContentStatus,
)
from animama.domain.runtime_bundles import select_runtime_bundles
from animama.domain.runtime_content_descriptor import RuntimeContentRootSelection
from animama.orm.anima import ORMAnima
from animama.orm.anima_loadout import ORMAnimaLoadout, ORMAnimaRuntimeSnapshot
from animama.orm.content_catalog import ORMAnimaContentBinding, ORMContentCatalogItem
from animama.server.config import Settings
from animama.server.local_runtime import initialize_local_runtime
from tests.anima_creation_service_support import write_json
from tests.content_package_helpers import anima_clip
from tests.statement_counting import counted_statements

GESTURES = ("wave", "nod", "breathe")


@dataclass
class RuntimeFixture:
    owner: str
    anima_id: str
    store: FilesystemContentStore
    root: Path
    items: dict[str, CatalogContentEntry]

    def service(self, session) -> AnimaRuntimeService:
        return AnimaRuntimeService(session, store=self.store)


@asynccontextmanager
async def runtime_fixture(session, tmp_path: Path) -> AsyncIterator[RuntimeFixture]:
    """An Anima whose loadout equips two clip Gestures and one Idle Gesture from a scanned Local library."""

    owner = f"issuance-owner-{uuid4().hex}"
    # Local locators are installation-wide, so each fixture uses its own.
    suffix = uuid4().hex[:8]
    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    for name in GESTURES:
        locator = f"{name}-{suffix}"
        write_json(
            paths.local_root / f"gestures/{locator}/{locator}.meta.json",
            {
                "schema_version": 1,
                "content_type": "gesture",
                "content_id": f"local:gesture:{locator}",
                "name": name,
                "semantic_key": name,
                "implementation": {"kind": "anima_clip", "file_role": "sequence"},
                "files": [{"path": f"{locator}.json", "role": "sequence"}],
            },
        )
        write_json(
            paths.local_root / f"gestures/{locator}/{locator}.json", anima_clip(clip_id=name, name=name, duration=2)
        )
    store = FilesystemContentStore(
        included_root=paths.included_root, local_root=paths.local_root, operations_root=paths.operations_root
    )
    scanned = await ContentCatalogService(store=store, catalog=SQLAlchemyContentCatalog(session)).rescan(
        user_id=owner, include_included=False
    )
    items = {item.relative_locator.split("/")[1].removesuffix(f"-{suffix}"): item for item in scanned.items}
    anima_id = f"issuance-anima-{uuid4().hex}"
    session.add(ORMAnima(id=anima_id, user_id=owner))
    await session.flush()
    session.add(ORMAnimaLoadout(anima_id=anima_id, owner_user_id=owner, revision=1, starter_catalog_version=1))
    await session.flush()
    for name in ("wave", "nod"):
        session.add(
            ORMAnimaContentBinding(
                id=str(uuid4()),
                anima_id=anima_id,
                slot_key=f"gesture:{name}",
                catalog_item_id=items[name].id,
                kind="gesture",
                config={},
            )
        )
    session.add(
        ORMAnimaContentBinding(
            id=str(uuid4()),
            anima_id=anima_id,
            slot_key=idle_slot_key("default", items["breathe"].id),
            catalog_item_id=items["breathe"].id,
            kind="gesture",
            config={},
        )
    )
    await session.commit()
    try:
        yield RuntimeFixture(owner, anima_id, store, paths.local_root, items)
    finally:
        await session.rollback()
        await session.execute(delete(ORMAnima).where(ORMAnima.id == anima_id))
        await session.execute(
            delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id.in_([item.id for item in items.values()]))
        )
        await session.commit()


async def test_issuance_stores_the_bundles_it_advertises(async_session, tmp_path: Path) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        issued = await fixture.service(async_session).issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        snapshot = await async_session.scalar(
            select(ORMAnimaRuntimeSnapshot).where(ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id)
        )
        assert snapshot is not None
        selected = select_runtime_bundles(snapshot.catalog)
        assert len(selected) == 1
        assert [bundle["id"] for bundle in issued["bundles"]] == [bundle.id for bundle in selected]
        stored = snapshot.bundles[selected[0].id]
        assert stored["format"] == selected[0].format
        assert stored["members"] == list(selected[0].members)


async def test_a_bundle_read_loads_only_its_own_members(async_session, tmp_path: Path) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        issued = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        [advertised] = issued["bundles"]
        bundles = RuntimeBundleService(service, fixture.store)
        with counted_statements(async_session) as statements:
            read = await bundles.read(
                user_id=fixture.owner,
                anima_id=fixture.anima_id,
                revision=issued["effective_revision"],
                bundle_id=advertised["id"],
            )
        assert read.complete and read.format == "json"
        assert [member["file_ref"] for member in json.loads(read.encode())["members"]] == advertised["file_refs"]
        assert len(statements) == 2
        assert not any(re.search(r"anima_runtime_snapshots\.catalog\b", statement) for statement in statements)


@pytest.mark.parametrize("case", ["unknown_bundle", "malformed_bundle", "other_revision", "expired"])
async def test_a_bundle_read_keeps_its_refusals(async_session, tmp_path: Path, case: str) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        issued = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        [advertised] = issued["bundles"]
        revision, bundle_id = issued["effective_revision"], advertised["id"]
        if case == "unknown_bundle":
            bundle_id = "0" * 64
        elif case == "malformed_bundle":
            bundle_id = "not-a-bundle\x00"
        elif case == "other_revision":
            revision = f"{revision[:-1]}0" if revision[-1] != "0" else f"{revision[:-1]}1"
        else:
            await async_session.execute(
                update(ORMAnimaRuntimeSnapshot)
                .where(ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id)
                .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
            await async_session.commit()
        expected = "runtime_remount_required" if case == "expired" else "runtime_file_not_found"
        with pytest.raises(RuntimeSnapshotError, match=expected):
            await RuntimeBundleService(service, fixture.store).read(
                user_id=fixture.owner, anima_id=fixture.anima_id, revision=revision, bundle_id=bundle_id
            )


def _writes_or_locks(statements: list[str]) -> list[str]:
    return [
        statement
        for statement in statements
        if any(word in statement.upper() for word in ("FOR SHARE", "FOR UPDATE", "INSERT ", "UPDATE ", "DELETE "))
    ]


async def test_preparation_takes_no_lock_and_writes_nothing(async_session, tmp_path: Path) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        with counted_statements(async_session) as statements:
            prepared = await service.prepare(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert statements and _writes_or_locks(statements) == []
        assert prepared.loadout_revision == 1


@pytest.mark.parametrize("reused", [False, True])
async def test_the_final_transaction_locks_rechecks_and_writes_only(
    async_session,
    tmp_path: Path,
    reused: bool,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        expected = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        if not reused:
            # A snapshot without an inputs digest is never reused, so this compiles.
            await async_session.execute(
                update(ORMAnimaRuntimeSnapshot)
                .where(ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id)
                .values(inputs_digest=None)
            )
            await async_session.commit()
        prepared = await service.prepare(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert (prepared.reused_snapshot_id is not None) is reused
        await async_session.rollback()
        with counted_statements(async_session) as statements:
            issued = await service.commit(prepared, user_id=fixture.owner)
        assert issued is not None
        assert issued["effective_revision"] == expected["effective_revision"]
        assert issued["content_descriptor"] == expected["content_descriptor"]
        # The loadout lock is the transaction's first statement; the catalog is not listed again.
        assert "FROM anima_loadouts" in statements[0] and "FOR SHARE" in statements[0]
        assert not any("content_catalog_dependencies" in statement for statement in statements)
        assert len(statements) <= 6


async def test_a_loadout_change_after_preparation_reissues_the_new_loadout(
    async_session,
    async_session_factory,
    tmp_path: Path,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        stale = await service.prepare(user_id=fixture.owner, anima_id=fixture.anima_id)
        await async_session.rollback()
        async with async_session_factory() as editor:
            await editor.execute(
                update(ORMAnimaLoadout).where(ORMAnimaLoadout.anima_id == fixture.anima_id).values(revision=2)
            )
            await editor.commit()
        assert await service.commit(stale, user_id=fixture.owner) is None
        await async_session.rollback()
        issued = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert issued["loadout_revision"] == 2


async def test_a_loadout_that_keeps_changing_is_refused_as_a_conflict(
    async_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        prepare = service.prepare

        async def outdated(**kwargs: str) -> PreparedRuntime:
            prepared = await prepare(**kwargs)
            return replace(prepared, loadout_revision=prepared.loadout_revision - 1)

        monkeypatch.setattr(service, "prepare", outdated)
        with pytest.raises(RuntimeSnapshotError, match="snapshot_conflict"):
            await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert (
            await async_session.scalar(select(func.count()).where(ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id))
            == 0
        )


async def test_changed_files_found_while_preparing_are_marked_when_committing(
    async_session,
    tmp_path: Path,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        wave = fixture.items["wave"]
        path = fixture.root / wave.files[0].relative_path
        path.write_bytes(path.read_bytes() + b" ")
        service = fixture.service(async_session)
        prepared = await service.prepare(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert ("runtime_source_changed", wave.id) in [
            (item["code"], item["item_id"]) for item in prepared.catalog_body["content_descriptor"]["diagnostics"]
        ]
        status = select(ORMContentCatalogItem.status).where(ORMContentCatalogItem.id == wave.id)
        assert await async_session.scalar(status) == "valid"
        await async_session.rollback()
        events: list[str] = []

        def statement(_conn, _cursor, text, _parameters, _context, _executemany):
            events.append(text)

        def committed(_conn) -> None:
            events.append("COMMIT")

        engine = async_session.bind.sync_engine
        event.listen(engine, "before_cursor_execute", statement)
        event.listen(engine, "commit", committed)
        try:
            issued = await service.commit(prepared, user_id=fixture.owner)
        finally:
            event.remove(engine, "before_cursor_execute", statement)
            event.remove(engine, "commit", committed)
        assert issued is not None
        assert await async_session.scalar(status) == "scan_required"
        # Marking commits before the loadout lock, which is then held until the snapshot is written.
        lock = next(index for index, text in enumerate(events) if "FROM anima_loadouts" in text)
        write = next(index for index, text in enumerate(events) if "INSERT INTO anima_runtime_snapshots" in text)
        assert "COMMIT" in events[:lock]
        assert "COMMIT" not in events[lock:write]


@pytest.mark.parametrize("owner", ["another-owner", None])
async def test_preparation_refuses_another_owners_or_a_missing_anima(
    async_session,
    tmp_path: Path,
    owner: str | None,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        with pytest.raises(RuntimeSnapshotError, match="anima_not_found"):
            await service.prepare(
                user_id=owner or fixture.owner, anima_id=fixture.anima_id if owner else "missing-anima"
            )


def _forbid_compiling(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail the test if issuance compiles, projects or reads content bytes."""

    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an unchanged loadout was compiled again")

    monkeypatch.setattr(RuntimeContentClosureCompiler, "compile_with_changes", forbidden)
    monkeypatch.setattr(anima_runtime_service, "project_typed_runtime_catalog", forbidden)
    monkeypatch.setattr(FilesystemContentStore, "open_verified_file", forbidden)


async def test_an_unchanged_loadout_is_reissued_without_compiling(
    async_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        first = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        with monkeypatch.context() as patch:
            _forbid_compiling(patch)
            again = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert {key: value for key, value in again.items() if key != "lease_expires_at"} == {
            key: value for key, value in first.items() if key != "lease_expires_at"
        }
        assert again["lease_expires_at"] >= first["lease_expires_at"]
        count = select(func.count()).where(ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id)
        assert await async_session.scalar(count) == 1


async def _change_loadout_revision(fixture: RuntimeFixture, session) -> None:
    await session.execute(
        update(ORMAnimaLoadout).where(ORMAnimaLoadout.anima_id == fixture.anima_id).values(revision=2)
    )


async def _change_motion(fixture: RuntimeFixture, session) -> None:
    path = fixture.root / fixture.items["nod"].files[0].relative_path
    path.write_bytes(json.dumps(anima_clip(clip_id="nod", name="nod", duration=3)).encode())
    await ContentCatalogService(store=fixture.store, catalog=SQLAlchemyContentCatalog(session)).rescan(
        user_id=fixture.owner, include_included=False
    )


async def _invalidate_item(fixture: RuntimeFixture, session) -> None:
    await session.execute(
        update(ORMContentCatalogItem)
        .where(ORMContentCatalogItem.id == fixture.items["breathe"].id)
        .values(status="scan_required")
    )


async def _show_a_hidden_item(fixture: RuntimeFixture, session) -> None:
    # The loadout already binds an item the owner could not see; now it can.
    await session.execute(
        update(ORMContentCatalogItem)
        .where(ORMContentCatalogItem.id == fixture.items["wave"].id)
        .values(owner_user_id=fixture.owner)
    )


@pytest.mark.parametrize("change", [_change_loadout_revision, _change_motion, _invalidate_item, _show_a_hidden_item])
async def test_each_changed_input_compiles_again(async_session, tmp_path: Path, change) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        if change is _show_a_hidden_item:
            await async_session.execute(
                update(ORMContentCatalogItem)
                .where(ORMContentCatalogItem.id == fixture.items["wave"].id)
                .values(owner_user_id=f"someone-else-{uuid4().hex}")
            )
            await async_session.commit()
        service = fixture.service(async_session)
        first = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        await change(fixture, async_session)
        await async_session.commit()
        compiled: list[int] = []
        compile_with_changes = RuntimeContentClosureCompiler.compile_with_changes

        async def counted(self, **kwargs):
            compiled.append(kwargs["loadout_revision"])
            return await compile_with_changes(self, **kwargs)

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(RuntimeContentClosureCompiler, "compile_with_changes", counted)
            again = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert len(compiled) == 1
        assert again["effective_revision"] != first["effective_revision"]


@pytest.mark.parametrize("change", [{"revision_sha256": "0" * 64}, {"owner_user_id": "another-owner"}])
async def test_a_reused_snapshot_is_fenced_like_a_fresh_one(
    async_session,
    async_session_factory,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    change: dict[str, str],
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        with monkeypatch.context() as patch:
            _forbid_compiling(patch)
            prepared = await service.prepare(user_id=fixture.owner, anima_id=fixture.anima_id)
        await async_session.rollback()
        async with async_session_factory() as editor:
            await editor.execute(
                update(ORMContentCatalogItem)
                .where(ORMContentCatalogItem.id == fixture.items["wave"].id)
                .values(**change)
            )
            await editor.commit()
        # A changed or now foreign pinned item is refused, as for a fresh compile.
        with pytest.raises(RuntimeSnapshotError, match="runtime_remount_required"):
            await service.commit(prepared, user_id=fixture.owner)


async def test_a_reused_snapshot_that_expires_before_commit_is_compiled_again(
    async_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        service = fixture.service(async_session)
        first = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        with monkeypatch.context() as patch:
            _forbid_compiling(patch)
            prepared = await service.prepare(user_id=fixture.owner, anima_id=fixture.anima_id)
        await async_session.rollback()
        expire = update(ORMAnimaRuntimeSnapshot).where(ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id)
        await async_session.execute(expire.values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await async_session.commit()
        assert await service.commit(prepared, user_id=fixture.owner) is None
        await async_session.rollback()
        again = await service.issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        assert again["effective_revision"] == first["effective_revision"]
        assert datetime.fromisoformat(again["lease_expires_at"]) > datetime.now(UTC)


async def test_a_compile_that_found_changed_files_is_never_reused(
    async_session,
    tmp_path: Path,
) -> None:
    async with runtime_fixture(async_session, tmp_path) as fixture:
        path = fixture.root / fixture.items["wave"].files[0].relative_path
        path.write_bytes(path.read_bytes() + b" ")
        await fixture.service(async_session).issue(user_id=fixture.owner, anima_id=fixture.anima_id)
        digests = select(ORMAnimaRuntimeSnapshot.inputs_digest).where(
            ORMAnimaRuntimeSnapshot.anima_id == fixture.anima_id
        )
        assert list(await async_session.scalars(digests)) == [None]


def _digest_inputs() -> dict[str, Any]:
    root_file = CatalogContentFile(
        file_ref="ref-root",
        item_id="root",
        source=ContentSource.LOCAL,
        relative_path="gestures/root/root.json",
        role="sequence",
        media_type="application/json",
        size_bytes=10,
        sha256="a" * 64,
    )

    def entry(item_id: str, **changes: Any) -> CatalogContentEntry:
        return replace(
            CatalogContentEntry(
                id=item_id,
                source=ContentSource.LOCAL,
                scope=ContentScope.OWNER,
                owner_user_id="owner",
                kind=ContentKind.GESTURE,
                relative_locator=f"gestures/{item_id}",
                display_name=item_id,
                status=ContentStatus.VALID,
                revision_sha256="b" * 64,
                files=(root_file,) if item_id == "root" else (),
                scanned_at=datetime(2026, 10, 1, tzinfo=UTC),
            ),
            **changes,
        )

    return {
        "build": "build",
        "loadout_revision": 1,
        "selections": (
            RuntimeContentRootSelection("gesture:root", "root", ContentKind.GESTURE, context={"config": {"gain": 1}}),
            RuntimeContentRootSelection("gesture:missing", "missing", ContentKind.GESTURE),
        ),
        "by_id": {"root": entry("root", dependency_item_ids=("support",)), "support": entry("support")},
        "overrides": {},
        "entry": entry,
    }


def _digest(inputs: dict[str, Any]) -> str:
    return anima_runtime_service._inputs_digest(**{key: value for key, value in inputs.items() if key != "entry"})


def _changed(name: str, inputs: dict[str, Any]) -> dict[str, Any]:
    entry = inputs["entry"]
    by_id = dict(inputs["by_id"])
    if name == "build":
        return {**inputs, "build": "upgraded"}
    if name == "avatar":
        [root, missing] = inputs["selections"]
        avatar = RuntimeContentRootSelection("avatar", "support", ContentKind.AVATAR, context={"avatar_id": "other"})
        return {**inputs, "selections": (root, missing, avatar)}
    if name == "loadout":
        return {**inputs, "loadout_revision": 2}
    if name == "context":
        [root, missing] = inputs["selections"]
        return {**inputs, "selections": (replace(root, context={"config": {"gain": 2}}), missing)}
    if name == "missing_item_appears":
        return {**inputs, "by_id": {**by_id, "missing": entry("missing")}}
    if name == "dependency_status":
        return {**inputs, "by_id": {**by_id, "support": entry("support", status=ContentStatus.INVALID)}}
    if name == "missing_dependencies":
        root = replace(by_id["root"], missing_dependencies=("effects/removed",))
        return {**inputs, "by_id": {**by_id, "root": root}}
    if name == "provenance":
        return {**inputs, "by_id": {**by_id, "support": entry("support", provenance={"license_id": "other"})}}
    if name == "file":
        root = by_id["root"]
        return {**inputs, "by_id": {**by_id, "root": replace(root, files=(replace(root.files[0], size_bytes=11),))}}
    if name == "face_part_override":
        override = AvatarFacePartOverride(avatar_item_id="root", avatar_revision_sha256="c" * 64, parts={"eyes": 1})
        return {**inputs, "overrides": {"root": override}}
    raise AssertionError(name)


@pytest.mark.parametrize(
    "change",
    [
        "build",
        "projection_version",
        "avatar",
        "loadout",
        "context",
        "missing_item_appears",
        "dependency_status",
        "missing_dependencies",
        "provenance",
        "file",
        "face_part_override",
    ],
)
def test_the_inputs_digest_changes_with_every_compile_input(change: str, monkeypatch: pytest.MonkeyPatch) -> None:
    inputs = _digest_inputs()
    before = _digest(inputs)
    if change == "projection_version":
        monkeypatch.setattr(
            anima_runtime_service, "RUNTIME_PROJECTION_VERSION", anima_runtime_service.RUNTIME_PROJECTION_VERSION + 1
        )
        assert _digest(inputs) != before
        return
    assert _digest(_changed(change, inputs)) != before


def test_the_inputs_digest_ignores_scan_times_and_unrelated_entries() -> None:
    inputs = _digest_inputs()
    entry = inputs["entry"]
    rescanned = {
        item_id: replace(item, scanned_at=datetime(2026, 10, 2, tzinfo=UTC))
        for item_id, item in inputs["by_id"].items()
    }
    unrelated = {**inputs["by_id"], "unrelated": entry("unrelated")}
    assert _digest({**inputs, "by_id": rescanned}) == _digest(inputs) == _digest({**inputs, "by_id": unrelated})


def _build_identity() -> str:
    return anima_runtime_service._backend_build.__wrapped__()


def test_a_frozen_build_is_identified_by_its_executable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    executable = tmp_path / "Animama"
    executable.write_bytes(b"release one")
    # A frozen build's modules live in its executable; its package directory holds
    # only data files, some of which are Python (the packaged Alembic scripts).
    package = tmp_path / "_internal/animama"
    (package / "resources/runtime/alembic").mkdir(parents=True)
    (package / "resources/runtime/alembic/env.py").write_bytes(b"unchanged by upgrades")
    monkeypatch.setattr(animama, "__file__", str(package / "__init__.pyc"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))
    first = _build_identity()
    executable.write_bytes(b"release two, upgraded")
    assert _build_identity() != first


@pytest.mark.parametrize("suffix", [".py", ".pyc"])
def test_a_package_is_identified_by_its_modules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str) -> None:
    package = tmp_path / "animama"
    package.mkdir()
    (package / f"__init__{suffix}").write_bytes(b"init")
    module = package / f"projection{suffix}"
    module.write_bytes(b"version one")
    monkeypatch.setattr(animama, "__file__", str(package / f"__init__{suffix}"))
    first = _build_identity()
    assert _build_identity() == first
    module.write_bytes(b"version two")
    assert _build_identity() != first
