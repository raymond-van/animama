"""Installed-wheel content consumer with opaque memory ports, no filesystem store.

Run this file outside the checkout against the installed candidate. The fixture
adapters deliberately support only a small Gesture sample; they are executable
port examples, not a production archive validator or persistence implementation.
The save/export/review/import/receipt paths are the real shared services.
"""

from __future__ import annotations

# ruff: noqa: E402 -- install the standalone import fence before shared imports.
import asyncio
import copy
import hashlib
import importlib.abc
import json
import struct
import sys
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import PurePosixPath
from uuid import uuid4
from zipfile import ZipFile

from pydantic import TypeAdapter


class RejectLocalImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if any(
            fullname == name or fullname.startswith(name + ".")
            for name in (
                "animama.local",
                "animama.server",
                "animama.runtime",
                "animama.logging_config",
                "animama.hooks",
            )
        ):
            raise ImportError(f"content consumer imported local composition: {fullname}")
        return None


if __name__ == "__main__":
    sys.meta_path.insert(0, RejectLocalImports())


from animama.adapters.package_inspection import TemporaryPackageInspector
from animama.app.contracts.content_package import PackageManifest, portable_revision
from animama.app.contracts.content_package_staging import PartAck, PartReceipt, StageLimits, StageRecord
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_kind_registry import handler_for_kind
from animama.app.services.content_package_archive import InspectedPackage, InspectedPackageEntry
from animama.app.services.content_package_capabilities import derive_file_capabilities, validate_capabilities
from animama.app.services.content_package_service import ContentPackageService
from animama.app.services.content_portability import restricted_sha256 as tracked_restricted_sha256
from animama.app.services.content_save_service import ContentSaveService
from animama.app.services.local_content_mutations import _finish_owned_work
from animama.domain.content_catalog import (
    CatalogContentEntry,
    CatalogContentFile,
    ContentConflictError,
    ContentIntegrityError,
    ContentKind,
    ContentNotFoundError,
    ContentScope,
    ContentSource,
    ContentStatus,
    ScannedContentEntry,
    ScannedContentFile,
    VerifiedContentFile,
)


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def vrma(label):
    payload = json.dumps(
        {
            "asset": {"version": "2.0"},
            "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}},
            "extras": {"label": label},
        }
    ).encode()
    payload += b" " * (-len(payload) % 4)
    return struct.pack("<4sII", b"glTF", 2, len(payload) + 20) + struct.pack("<II", len(payload), 0x4E4F534A) + payload


def metadata(name="Wave"):
    return json.dumps(
        {
            "schema_version": 1,
            "id": "sample:gesture:wave",
            "name": name,
            "provenance": {"creator": "Public fixture", "license": "fixture-only"},
        }
    ).encode()


@dataclass(frozen=True)
class Resource:
    payload: bytes

    def open(self):
        return BytesIO(self.payload)


class MemoryStore:
    """Opaque owner partitions have no path, scan, journal, or directory API."""

    def __init__(self, owner_id, partitions):
        self.owner_id, self.partitions = owner_id, partitions
        partitions.setdefault(owner_id, {})
        self.pending = None
        self.fail_install = False

    @property
    def restricted_sha256(self):
        """Account stores refuse the same non-portable bytes as Local content."""
        return tracked_restricted_sha256()

    @property
    def values(self):
        return self.pending if self.pending is not None else self.partitions[self.owner_id]

    def save_standalone_stream(
        self, *, relative_locator, payload_stream, payload_size_bytes, metadata_sidecar, operation_id, **kwargs
    ):
        payload = payload_stream.read(payload_size_bytes + 1)
        assert len(payload) == payload_size_bytes
        self.values[relative_locator] = payload
        self.values[str(PurePosixPath(relative_locator).with_suffix(".meta.json"))] = metadata_sidecar
        return operation_id

    def package_destination_exists(self, *, relative_locator):
        return relative_locator in self.values

    def open_verified_file(self, *, relative_path, source, expected_size_bytes, expected_sha256, media_type, **kwargs):
        values = self.partitions["included"] if source is ContentSource.INCLUDED else self.values
        payload = values[relative_path]
        if (len(payload), digest(payload)) != (expected_size_bytes, expected_sha256):
            raise ContentIntegrityError("fixture verified bytes changed")
        return VerifiedContentFile(BytesIO(payload), len(payload), digest(payload), media_type)

    def install_package_atomic(self, *, entries, **kwargs):
        for entry in entries:
            assert entry.kind is ContentKind.GESTURE
            assert entry.relative_locator not in self.values
            for member in entry.files:
                assert member.source_path is None and member.handle is None
                with member.open_source() as handle:
                    payload = handle.read(member.size_bytes + 1)
                assert len(payload) == member.size_bytes
                locator = str(PurePosixPath(entry.relative_locator).parent / member.relative_path)
                self.values[locator] = payload
        if self.fail_install:
            raise RuntimeError("fixture fails after staging closure")

    def delete_entry(self, *, entry):
        assert entry.source is ContentSource.LOCAL and entry.owner_user_id == self.owner_id
        for member in entry.files:
            self.values.pop(member.relative_path, None)


class MemoryCatalog:
    def __init__(self, owner_id):
        self.owner_id, self.rows, self.receipts = owner_id, {}, {}

    def admit(self, user_id):
        if user_id != self.owner_id:
            raise ContentNotFoundError("fixture owner mismatch")

    async def list_visible(self, *, user_id):
        self.admit(user_id)
        return list(self.rows.values())

    async def get_visible_item(self, *, item_id, user_id, **kwargs):
        self.admit(user_id)
        return self.rows.get(item_id)

    async def get_by_locator(self, *, source, relative_locator):
        return next(
            (row for row in self.rows.values() if row.source is source and row.relative_locator == relative_locator),
            None,
        )

    async def get_visible_file(self, *, file_ref, user_id):
        self.admit(user_id)
        return next((f for row in self.rows.values() for f in row.files if f.file_ref == file_ref), None)

    async def lock_source(self, **kwargs):
        pass

    async def lock_save(self, **kwargs):
        pass

    async def get_mutation_receipt(self, *, user_id, operation_id):
        self.admit(user_id)
        return copy.deepcopy(self.receipts.get(operation_id))

    async def record_import_provenance(self, *, user_id, item_id, provenance):
        self.admit(user_id)
        self.rows[item_id] = replace(self.rows[item_id], provenance=provenance)
        return self.rows[item_id]

    async def item_usage(self, **kwargs):
        return ()

    async def purge_item(self, *, item_id):
        del self.rows[item_id]


class MemoryPublication:
    def __init__(self, store, catalog):
        self.owner_id, self.store, self.catalog = store.owner_id, store, catalog

    async def refresh(self, *, user_id, planned_item_ids=None, **kwargs):
        self.catalog.admit(user_id)
        rows = {}
        for source, values in (
            (ContentSource.LOCAL, self.store.values),
            (ContentSource.INCLUDED, self.store.partitions["included"]),
        ):
            for locator, payload in values.items():
                if not locator.endswith(".vrma"):
                    continue
                sidecar = str(PurePosixPath(locator).with_suffix(".meta.json"))
                parsed = handler_for_kind(ContentKind.GESTURE).parse_document(
                    json.loads(values[sidecar]), fallback_path=PurePosixPath(locator), descriptor_backed=False
                )
                prior = await self.catalog.get_by_locator(source=source, relative_locator=locator)
                item_id = (planned_item_ids or {}).get(locator) or (prior.id if prior else uuid4().hex)
                files = tuple(
                    CatalogContentFile(
                        file_ref=f"{item_id}:{role}",
                        item_id=item_id,
                        source=source,
                        relative_path=path,
                        role=role,
                        media_type=media,
                        size_bytes=len(values[path]),
                        sha256=digest(values[path]),
                    )
                    for path, role, media in (
                        (locator, "animation", "model/gltf-binary"),
                        (sidecar, "metadata", "application/json"),
                    )
                )
                rows[item_id] = CatalogContentEntry(
                    id=item_id,
                    source=source,
                    scope=ContentScope.INCLUDED if source is ContentSource.INCLUDED else ContentScope.OWNER,
                    owner_user_id=None if source is ContentSource.INCLUDED else user_id,
                    kind=ContentKind.GESTURE,
                    relative_locator=locator,
                    display_name=parsed.display_name,
                    status=ContentStatus.VALID,
                    revision_sha256=digest(payload + values[sidecar]),
                    files=files,
                    logical_key=parsed.logical_key,
                    metadata=parsed.metadata,
                    provenance=parsed.metadata.get("provenance", {}),
                )
        self.catalog.rows = rows
        return ()


class MemoryMutations:
    """A fixture UoW atomically publishes owner rows, bytes and immutable receipts."""

    def __init__(self, store, catalog):
        self.store, self.catalog = store, catalog
        self.fail_after_commit = False
        self.entered, self.resume = None, None

    def has_pending(self, *, user_id, operation_id):
        self.catalog.admit(user_id)
        return self.store.pending is not None

    async def reconcile(self, action):
        return await action()

    async def run(self, *, user_id, operation_id, request_digest, result_type, action):
        self.catalog.admit(user_id)
        adapter = TypeAdapter(result_type)
        receipt = self.catalog.receipts.get(operation_id)
        if receipt:
            if receipt["request_digest"] != request_digest:
                raise ContentConflictError("operation_id_reused")
            return adapter.validate_python(receipt["result"]["value"])

        async def publish():
            rows = copy.deepcopy(self.catalog.rows)
            self.store.pending = copy.deepcopy(self.store.partitions[user_id])
            try:
                if self.entered is not None:
                    self.entered.set()
                    await self.resume.wait()
                result = await action()
                value = adapter.dump_python(result, mode="json")
                self.catalog.receipts[operation_id] = {"request_digest": request_digest, "result": {"value": value}}
                self.store.partitions[user_id] = self.store.pending
            except BaseException:
                self.catalog.rows = rows
                raise
            finally:
                self.store.pending = None
            if self.fail_after_commit:
                raise OSError("fixture unknown commit outcome")
            return result

        return await _finish_owned_work(publish())


class MemoryStages:
    def __init__(self, owner_id):
        self.owner_id, self.records, self.blobs, self.active = owner_id, {}, {}, set()
        self.limits = StageLimits(max_archive_bytes=1024**2, max_expanded_bytes=1024**2, part_bytes=128)

    def admit(self, owner):
        if owner != self.owner_id:
            raise ContentNotFoundError("fixture stage owner mismatch")

    def create(self, owner, operation, filename, size, kind):
        self.admit(owner)
        if size > self.limits.max_archive_bytes:
            raise ContentConflictError("package_size_invalid")
        stage_id, now = uuid4().hex, datetime.now(UTC)
        record = StageRecord(
            stage_id=stage_id,
            user_id=owner,
            operation_id=operation,
            kind=kind,
            filename=filename,
            expected_bytes=size,
            reserved_bytes=size,
            state="uploading" if kind == "import" else "preparing",
            created_at=now,
            expires_at=now + timedelta(seconds=60),
        )
        self.records[stage_id] = record
        return record

    def create_import(self, user_id, operation_id, filename, expected_bytes):
        return self.create(user_id, operation_id, filename, expected_bytes, "import")

    def reserve_export(self, user_id, filename, expected_bytes):
        record = self.create(user_id, None, filename, expected_bytes, "export")
        return self.acquire(user_id, record.stage_id, "export")

    def acquire(self, user_id, stage_id, kind="import", *, allow_expired=False):
        self.admit(user_id)
        record = self.records.get(stage_id)
        if record is None or record.kind != kind:
            raise ContentConflictError("package_stage_unavailable")
        if not allow_expired and record.expires_at < datetime.now(UTC):
            raise ContentConflictError("package_stage_expired")
        if stage_id in self.active:
            raise ContentConflictError("package_stage_active")
        self.active.add(stage_id)
        return MemoryLease(self, stage_id)

    def append_part(self, user_id, stage_id, index, source):
        with self.acquire(user_id, stage_id) as lease:
            record = lease.record
            payload = source.read(self.limits.part_bytes + 1)
            if len(payload) > self.limits.part_bytes:
                raise ContentConflictError("package_part_size_invalid")
            receipt = PartReceipt(
                index=index, offset=index * self.limits.part_bytes, size_bytes=len(payload), sha256=digest(payload)
            )
            if index < len(record.parts):
                if record.parts[index] != receipt:
                    raise ContentConflictError("package_part_changed")
            else:
                if index != len(record.parts) or record.state != "uploading":
                    raise ContentConflictError("package_part_order")
                total = record.received_bytes + len(payload)
                if total > record.expected_bytes:
                    raise ContentConflictError("package_size_invalid")
                self.blobs[stage_id] = self.blobs.get(stage_id, b"") + payload
                lease.update(
                    parts=record.parts + (receipt,),
                    received_bytes=total,
                    state="uploaded" if total == record.expected_bytes else "uploading",
                )
            return PartAck(
                stage_id=stage_id,
                index=index,
                size_bytes=len(payload),
                sha256=digest(payload),
                received_bytes=lease.record.received_bytes,
                next_part_index=len(lease.record.parts),
                complete=lease.record.state == "uploaded",
            )

    def find_import(self, user_id, operation_id):
        self.admit(user_id)
        return next((r for r in self.records.values() if r.operation_id == operation_id), None)

    def status(self, user_id, stage_id, kind="import"):
        self.admit(user_id)
        if self.records[stage_id].kind != kind:
            raise ContentConflictError("package_stage_unavailable")
        return self.records[stage_id], stage_id in self.active

    def discard(self, user_id, stage_id, kind="import"):
        with self.acquire(user_id, stage_id, kind) as lease:
            lease.discard()

    def sweep_expired(self, user_id=None):
        self.admit(user_id or self.owner_id)
        for stage_id, record in list(self.records.items()):
            if (
                record.expires_at < datetime.now(UTC)
                and stage_id not in self.active
                and record.state not in {"committing", "recovery_needed"}
            ):
                self.records.pop(stage_id)
                self.blobs.pop(stage_id, None)


class MemoryLease:
    def __init__(self, stages, stage_id):
        self.stages, self.stage_id = stages, stage_id

    @property
    def record(self):
        return self.stages.records[self.stage_id]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self.stages.active.discard(self.stage_id)

    def update(self, **values):
        self.stages.records[self.stage_id] = self.record.model_copy(update=values)
        return self.record

    def set_state(self, state):
        return self.update(state=state)

    def discard(self):
        if self.record.state in {"committing", "recovery_needed"}:
            raise ContentConflictError("package_stage_active")
        self.stages.records.pop(self.stage_id)
        self.stages.blobs.pop(self.stage_id, None)

    def open_archive(self):
        return BytesIO(self.stages.blobs[self.stage_id])

    @contextmanager
    def write_archive(self):
        with BytesIO() as output:
            yield output
            self.stages.blobs[self.stage_id] = output.getvalue()

    def ensure_capacity(self, size):
        if size > self.stages.limits.max_archive_bytes:
            raise ContentConflictError("package_size_invalid")

    def seal_archive(self):
        payload = self.stages.blobs[self.stage_id]
        self.ensure_capacity(len(payload))
        if self.record.kind == "import" and len(payload) != self.record.expected_bytes:
            raise ContentConflictError("package_upload_incomplete")
        self.update(actual_bytes=len(payload), archive_sha256=digest(payload))
        return len(payload), digest(payload)

    def verify_archive(self):
        payload = self.stages.blobs[self.stage_id]
        if (len(payload), digest(payload)) != (self.record.actual_bytes, self.record.archive_sha256):
            raise ContentConflictError("package_archive_changed")
        return len(payload), digest(payload)

    def publish_review(self, review, review_digest):
        return self.update(review=review, review_digest=review_digest, state="reviewed")

    def renew_review(self, review_digest):
        assert self.record.review_digest == review_digest
        return self.record


class MemoryInspector:
    """Validate this bounded sample with real schemas, hashes and capabilities.

    This fixture only accepts standalone Gesture packages. A real adapter must
    implement every requirement in PackageInspector, including all kind parsers.
    """

    def __init__(self):
        self.active = 0

    @contextmanager
    def inspect(self, lease):
        self.active += 1
        try:
            with lease.open_archive() as stream, ZipFile(stream) as archive:
                manifest = PackageManifest.model_validate_json(archive.read("package.json"))
                entries, capabilities = {}, set()
                declared = {member.archive_path for entry in manifest.entries for member in entry.files}
                assert set(archive.namelist()) == declared | {"package.json"}
                for entry in manifest.entries:
                    assert entry.kind is ContentKind.GESTURE
                    assert sum(m.size_bytes for m in entry.files) <= 1024**2
                    resources = {m.relative_path: Resource(archive.read(m.archive_path)) for m in entry.files}
                    for member in entry.files:
                        payload = resources[member.relative_path].payload
                        assert len(payload) == member.size_bytes and digest(payload) == member.sha256
                    assert portable_revision(entry.files) == entry.portable_revision_sha256
                    locator = "gestures/" + next(m.relative_path for m in entry.files if m.role == "animation")
                    document = json.loads(
                        next(resources[m.relative_path].payload for m in entry.files if m.role == "metadata")
                    )
                    parsed = handler_for_kind(entry.kind).parse_document(
                        document, fallback_path=PurePosixPath(locator), descriptor_backed=False
                    )
                    assert parsed.logical_key == entry.package_entry_id
                    assert parsed.display_name == entry.display_name
                    for member in entry.files:
                        with resources[member.relative_path].open() as content:
                            capabilities.update(
                                derive_file_capabilities(
                                    entry.kind, parsed.document, member.relative_path, content, role=member.role
                                )
                            )
                    scanned = ScannedContentEntry(
                        source=ContentSource.LOCAL,
                        kind=entry.kind,
                        relative_locator=locator,
                        display_name=entry.display_name,
                        status=ContentStatus.VALID,
                        revision_sha256=entry.portable_revision_sha256,
                        logical_key=parsed.logical_key,
                        metadata=parsed.metadata,
                        files=tuple(
                            ScannedContentFile(
                                relative_path="gestures/" + m.relative_path,
                                role=m.role,
                                media_type=m.media_type,
                                size_bytes=m.size_bytes,
                                sha256=m.sha256,
                            )
                            for m in entry.files
                        ),
                    )
                    entries[entry.package_entry_id] = InspectedPackageEntry(parsed.document, scanned, resources)
                validate_capabilities(manifest.capabilities, capabilities)
                yield InspectedPackage(manifest, entries)
        finally:
            self.active -= 1


def compose(owner, partitions):
    store, catalog, stages = MemoryStore(owner, partitions), MemoryCatalog(owner), MemoryStages(owner)
    mutations = MemoryMutations(store, catalog)
    content = ContentCatalogService(
        store=store, catalog=catalog, mutations=mutations, publication=MemoryPublication(store, catalog)
    )
    inspector = MemoryInspector()
    packages = ContentPackageService(content=content, stages=stages, inspector=inspector, allow_anima_import=False)
    return content, ContentSaveService(content=content), packages, mutations, inspector


async def expect_error(exception, operation):
    try:
        await operation
    except exception:
        return
    raise AssertionError(f"expected {exception.__name__}")


async def exercise():
    partitions = {
        "included": {"gestures/included.vrma": vrma("included"), "gestures/included.meta.json": metadata("Included")}
    }
    alice, alice_saves, packages, authority, inspector = compose("alice", partitions)
    bob, bob_saves, bob_packages, _, _ = compose("bob", partitions)

    def save(service, owner, label, operation="save-wave", **changes):
        return service.save_standalone(
            user_id=owner,
            kind=ContentKind.GESTURE,
            entry_name="Wave",
            filename="wave.vrma",
            payload=vrma(label),
            metadata_sidecar=metadata(),
            operation_id=operation,
            catalog_item_id=changes.get("catalog_item_id"),
            expected_revision=changes.get("expected_revision"),
        )

    first, other = await save(alice_saves, "alice", "alice"), await save(bob_saves, "bob", "bob")
    assert first.item.relative_locator == other.item.relative_locator == "gestures/wave.vrma"
    assert first.item.id != other.item.id
    assert partitions["alice"]["gestures/wave.vrma"] != partitions["bob"]["gestures/wave.vrma"]
    assert await save(alice_saves, "alice", "alice") == first
    await expect_error(ContentConflictError, save(alice_saves, "alice", "changed"))
    await expect_error(ContentNotFoundError, alice.list_visible(user_id="bob"))
    await expect_error(
        ContentNotFoundError, alice.open_registered_file(user_id="alice", file_ref=other.item.files[0].file_ref)
    )
    included = next(item for item in await alice.list_visible(user_id="alice") if item.source is ContentSource.INCLUDED)
    await expect_error(
        ContentNotFoundError,
        alice.delete_item(user_id="alice", item_id=included.id, expected_revision=included.revision_sha256),
    )
    await expect_error(
        ContentConflictError,
        save(
            alice_saves,
            "alice",
            "revision",
            operation="stale",
            catalog_item_id=first.item.id,
            expected_revision="0" * 64,
        ),
    )

    summary = await packages.summarize(user_id="alice", item_ids=(first.item.id,))
    review = await packages.prepare_export(user_id="alice", item_ids=(first.item.id,), expected_digest=summary.digest)
    download = await packages.exports.download(user_id="alice", export_id=review.export_id)
    payload = download.handle.read()
    assert digest(payload) == review.package_sha256
    stages = packages.stages
    stages.records[review.export_id] = stages.records[review.export_id].model_copy(
        update={"expires_at": datetime.now(UTC) - timedelta(seconds=1)}
    )
    stages.sweep_expired("alice")
    assert review.export_id in stages.records  # active download excludes cleanup
    download.close()
    stages.sweep_expired("alice")
    assert review.export_id not in stages.records

    async def import_command(operation, service=packages):
        record = stages.create_import("alice", operation, "gesture.zip", len(payload))
        for index, offset in enumerate(range(0, len(payload), stages.limits.part_bytes)):
            part = payload[offset : offset + stages.limits.part_bytes]
            ack = stages.append_part("alice", record.stage_id, index, BytesIO(part))
            assert stages.append_part("alice", record.stage_id, index, BytesIO(part)) == ack
        assert ack.complete
        reviewed = await service.imports.review(user_id="alice", stage_id=record.stage_id)
        return {
            "user_id": "alice",
            "stage_id": record.stage_id,
            "operation_id": operation,
            "review_digest": reviewed.review_digest,
        }

    command = await import_command("import-wave")
    before = copy.deepcopy(partitions["alice"])
    authority.store.fail_install = True
    await expect_error(RuntimeError, packages.imports.commit(**command))
    assert partitions["alice"] == before and "import-wave" not in authority.catalog.receipts
    assert inspector.active == 0 and not stages.active
    authority.store.fail_install = False
    authority.fail_after_commit = True
    completed = await packages.imports.commit(**command)  # durable receipt resolves unknown commit
    authority.fail_after_commit = False
    assert len(completed.items) == 1 and completed.items[0].item_id != first.item.id
    stages.records[command["stage_id"]] = stages.records[command["stage_id"]].model_copy(
        update={"expires_at": datetime.now(UTC) - timedelta(seconds=1)}
    )
    assert await packages.imports.commit(**command) == completed  # receipt before expired stage
    stages.records.clear()
    stages.blobs.clear()
    assert await packages.imports.commit(**command) == completed  # receipt before missing/expired stage
    assert (await packages.imports.operation_status(user_id="alice", operation_id="import-wave")).state == "completed"
    await expect_error(ContentConflictError, packages.imports.commit(**(command | {"review_digest": "0" * 64})))
    await expect_error(ContentNotFoundError, bob_packages.imports.commit(**command))

    cancellation = await import_command("cancelled-import")
    authority.entered, authority.resume = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(packages.imports.commit(**cancellation))
    await authority.entered.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    assert not task.done() and stages.active and inspector.active
    authority.resume.set()
    try:
        await task
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("request cancellation must propagate after owned work")
    assert "cancelled-import" in authority.catalog.receipts
    assert not stages.active and inspector.active == 0
    assert (
        await packages.imports.operation_status(user_id="alice", operation_id="cancelled-import")
    ).state == "completed"
    # Use the complete production parser over the same opaque persistent store.
    # Its generated temporary validation tree is not the installed byte store.
    production = ContentPackageService(
        content=alice,
        stages=stages,
        inspector=TemporaryPackageInspector(limits=stages.limits),
        allow_anima_import=False,
    )
    summary = await production.summarize(user_id="alice", item_ids=(first.item.id,))
    production_review = await production.prepare_export(
        user_id="alice", item_ids=(first.item.id,), expected_digest=summary.digest
    )
    production_download = await production.exports.download(user_id="alice", export_id=production_review.export_id)
    try:
        payload = production_download.handle.read()
        assert digest(payload) == production_review.package_sha256
    finally:
        production_download.close()
    production_command = await import_command("canonical-inspection", production)
    assert len((await production.imports.commit(**production_command)).items) == 1
    print("content consumer: owner isolation, save, export, import, rollback, replay, cancellation and cleanup passed")


if __name__ == "__main__":
    asyncio.run(exercise())
