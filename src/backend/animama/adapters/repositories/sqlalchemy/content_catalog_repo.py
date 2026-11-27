"""SQLAlchemy catalog adapter for readable Included and Local content."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import defaultdict
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, cast

from sqlalchemy import ColumnElement, case, delete, func, literal, or_, select, text, update
from sqlalchemy.dialects.postgresql import aggregate_order_by, insert
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.feature_pack_removal_repo import included_source_blockers
from animama.app.ports.content_catalog import ContentCatalog
from animama.app.services.content_access_policy import ContentAccessPolicy
from animama.app.services.content_kind_registry import handler_for_kind
from animama.app.services.content_portability import DISTRIBUTION_KEY, DISTRIBUTION_NON_PORTABLE
from animama.domain.content_catalog import (
    ACTION_KINDS,
    CONTENT_SOURCE_LOCK_ORDER,
    CONTENT_USAGE_LIMIT,
    MISSING_EFFECT_DEPENDENCY,
    REMOVABLE_EFFECT_KINDS,
    CatalogContentEntry,
    CatalogContentFile,
    ContentConflictError,
    ContentDiagnostic,
    ContentKind,
    ContentNotFoundError,
    ContentPreview,
    ContentPreviewFile,
    ContentScope,
    ContentSource,
    ContentStatus,
    ContentUsage,
    ContentUsageKind,
    ScannedContentEntry,
)
from animama.domain.content_documents import ContentDocumentError
from animama.orm.anima import ORMAnima
from animama.orm.avatar import ORMAvatar
from animama.orm.content_catalog import (
    ORMAnimaContentBinding,
    ORMContentCatalogDependency,
    ORMContentCatalogFile,
    ORMContentCatalogItem,
    ORMContentPreview,
    ORMContentPreviewFile,
)
from animama.orm.content_mutation import ORMContentMutationReceipt

_MUTATION_TRANSACTION_KEY = "animama.content_mutation_transaction"
# ``Session.info`` key a composition sets when its shared catalog rows (those with no
# owner) never change at runtime. ``get_visible_item`` and ``get_visible_items`` then
# lock only owner rows, so a loadout write never queues another owner behind a shared
# row; ``lock_items`` and reconciliation lock as before. The local composition leaves
# it unset: its Included rows can be retired by a rescan, so every row read for a
# write is locked.
SHARED_CATALOG_ROWS_IMMUTABLE = "animama.shared_catalog_rows_immutable"
# Included removals are application-version history, not a user-repairable library
# problem. Their tombstones stay for identity and reconciliation but are never listed.
_LISTED = or_(
    ORMContentCatalogItem.source != ContentSource.INCLUDED.value,
    ORMContentCatalogItem.status != ContentStatus.MISSING.value,
)
# The use an Anima loadout binding of each kind names (``item_usage``). A Gesture
# binding whose slot is ``idle:…`` is an Idle pool member instead.
_BINDING_USES: dict[str, ContentUsageKind] = {
    "avatar": "anima_avatar",
    "appearance": "anima_appearance",
    "voice": "anima_voice",
    "gesture": "anima_gesture",
    "reaction": "anima_reaction",
    "music_track": "anima_music",
}
_USE_ORDER: tuple[ContentUsageKind, ...] = (
    "anima_avatar",
    "anima_appearance",
    "anima_voice",
    "anima_gesture",
    "anima_idle",
    "anima_reaction",
    "anima_music",
)


@dataclass(slots=True)
class _MutationTransactionState:
    """Share commit ownership across catalog adapters using the same session."""

    failed: bool = False


def _diagnostic_dict(item: ContentDiagnostic) -> dict[str, Any]:
    value: dict[str, Any] = {"code": item.code, "message": item.message}
    if item.relative_path is not None:
        value["relative_path"] = item.relative_path
    return value


def _diagnostics(values: list[dict[str, Any]]) -> tuple[ContentDiagnostic, ...]:
    result: list[ContentDiagnostic] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        code = value.get("code")
        message = value.get("message")
        if isinstance(code, str) and isinstance(message, str):
            relative = value.get("relative_path")
            result.append(ContentDiagnostic(code, message, relative if isinstance(relative, str) else None))
    return tuple(result)


def _scanned_file_identity(entry: ScannedContentEntry) -> tuple[tuple[str, str, int, str], ...]:
    """Return rename-only byte identity without weakening semantic revisions."""

    return tuple(sorted((file.role, file.media_type, file.size_bytes, file.sha256) for file in entry.files))


def _catalog_file_identity(
    rows: list[ORMContentCatalogFile],
) -> tuple[tuple[str, str, int, str], ...]:
    """Project persisted canonical files into the rename reconciliation shape."""

    return tuple(sorted((row.role, row.media_type, row.size_bytes, row.sha256) for row in rows))


def _is_removed_effect(
    source: ContentSource,
    kind: ContentKind,
    ref: str,
    declared_kind: ContentKind | None,
    claimed_keys: set[str],
) -> bool:
    """Whether an unresolved edge is a Local Action's removed Included effect.

    Only a Local Gesture or Reaction outlives one, only for an Avatar,
    Particle or Scene Effect, and only when no present entry claims the ref
    (an invalid or ambiguous target still invalidates the Action).
    """

    return (
        source is ContentSource.LOCAL
        and kind in ACTION_KINDS
        and declared_kind in REMOVABLE_EFFECT_KINDS
        and ref.startswith("builtin:")
        and ref not in claimed_keys
    )


def _mount_source(mount_id: str | None) -> str:
    """Versions may replace one source; identities never migrate between sources."""

    return mount_id.split("@", 1)[0] if mount_id else ""


class SQLAlchemyContentCatalog(ContentCatalog):
    """Reconcile scans while preserving opaque item and file identities."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @asynccontextmanager
    async def mutation_transaction(self) -> AsyncIterator[None]:
        """Own one Local mutation, including any existing autobegun read scope."""

        active = self._session.info.get(_MUTATION_TRANSACTION_KEY)
        if isinstance(active, _MutationTransactionState):
            try:
                yield
            except BaseException:
                active.failed = True
                raise
            return

        state = _MutationTransactionState()
        self._session.info[_MUTATION_TRANSACTION_KEY] = state
        try:
            # Do not call begin(): preflight reads may already have autobegun
            # this same transaction. The advisory lock lives until final commit.
            await self.lock_source(source=ContentSource.LOCAL)
            yield
            if state.failed:
                raise RuntimeError("A nested content mutation failed; the transaction cannot commit")
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise
        finally:
            self._session.info.pop(_MUTATION_TRANSACTION_KEY, None)

    async def _complete_write(self) -> None:
        """Leave transaction ownership with a surrounding mutation when present."""

        if _MUTATION_TRANSACTION_KEY in self._session.info:
            await self._session.flush()
        else:
            await self._session.commit()

    async def get_mutation_receipt(self, *, user_id: str, operation_id: str) -> dict[str, Any] | None:
        row = (
            await self._session.execute(
                select(ORMContentMutationReceipt.request_digest, ORMContentMutationReceipt.result).where(
                    ORMContentMutationReceipt.owner_user_id == user_id,
                    ORMContentMutationReceipt.operation_id == operation_id,
                )
            )
        ).one_or_none()
        return None if row is None else {"request_digest": row.request_digest, "result": deepcopy(row.result)}

    async def record_mutation_receipt(
        self, *, user_id: str, operation_id: str, request_digest: str, result: dict[str, Any]
    ) -> None:
        if _MUTATION_TRANSACTION_KEY not in self._session.info:
            raise RuntimeError("Content mutation receipts require mutation_transaction()")
        await self._session.execute(
            insert(ORMContentMutationReceipt)
            .values(
                owner_user_id=user_id,
                operation_id=operation_id,
                request_digest=request_digest,
                result=deepcopy(result),
            )
            .on_conflict_do_nothing(
                index_elements=[ORMContentMutationReceipt.owner_user_id, ORMContentMutationReceipt.operation_id]
            )
        )
        existing = await self.get_mutation_receipt(user_id=user_id, operation_id=operation_id)
        if existing is None or existing["request_digest"] != request_digest:
            raise ContentConflictError("operation_id_reused")

    @staticmethod
    def _new_item_id(entry: ScannedContentEntry) -> str:
        if entry.source is ContentSource.INCLUDED:
            identity = entry.logical_key or entry.relative_locator
            if entry.source_mount_id:
                identity = f"{_mount_source(entry.source_mount_id)}/{identity}"
            return str(uuid.uuid5(uuid.NAMESPACE_URL, f"https://animama.local/included/{identity}"))
        return str(uuid.uuid4())

    async def _load_entries(self, rows: list[ORMContentCatalogItem]) -> list[CatalogContentEntry]:
        if not rows:
            return []
        item_ids = [row.id for row in rows]
        file_result = await self._session.execute(
            select(ORMContentCatalogFile)
            .where(ORMContentCatalogFile.item_id.in_(item_ids))
            .order_by(ORMContentCatalogFile.item_id, ORMContentCatalogFile.ordinal)
            .execution_options(populate_existing=True)
        )
        dependency_result = await self._session.execute(
            select(ORMContentCatalogDependency)
            .where(ORMContentCatalogDependency.item_id.in_(item_ids))
            .order_by(ORMContentCatalogDependency.item_id, ORMContentCatalogDependency.ordinal)
            .execution_options(populate_existing=True)
        )
        files_by_item: dict[str, list[ORMContentCatalogFile]] = defaultdict(list)
        for file_row in file_result.scalars():
            files_by_item[file_row.item_id].append(file_row)
        # A valid Action's unresolved edge is a removed Included effect only
        # when the scan recorded it as one; any other null target stays a
        # declared dependency, so it cannot pass as a tolerated gap.
        removed_by_item = {
            row.id: {
                diagnostic.get("relative_path")
                for diagnostic in row.diagnostics or []
                if diagnostic.get("code") == MISSING_EFFECT_DEPENDENCY
            }
            for row in rows
            if row.status == ContentStatus.VALID.value
        }
        dependencies_by_item: dict[str, list[str]] = defaultdict(list)
        dependency_ids_by_item: dict[str, list[str]] = defaultdict(list)
        missing_by_item: dict[str, list[str]] = defaultdict(list)
        for dependency in dependency_result.scalars():
            if dependency.target_item_id is None and dependency.declared_ref in removed_by_item.get(
                dependency.item_id, ()
            ):
                missing_by_item[dependency.item_id].append(dependency.declared_ref)
                continue
            dependencies_by_item[dependency.item_id].append(dependency.declared_ref)
            if dependency.target_item_id is not None:
                dependency_ids_by_item[dependency.item_id].append(dependency.target_item_id)

        entries: list[CatalogContentEntry] = []
        for row in rows:
            source = ContentSource(row.source)
            files = tuple(
                CatalogContentFile(
                    file_ref=file_row.file_ref,
                    item_id=row.id,
                    source=source,
                    source_mount_id=row.source_mount_id,
                    relative_path=file_row.relative_path,
                    role=file_row.role,
                    media_type=file_row.media_type,
                    size_bytes=file_row.size_bytes,
                    sha256=file_row.sha256,
                )
                for file_row in files_by_item[row.id]
            )
            entries.append(
                CatalogContentEntry(
                    id=row.id,
                    source=source,
                    scope=ContentScope(row.scope),
                    owner_user_id=row.owner_user_id,
                    kind=ContentKind(row.kind),
                    relative_locator=row.relative_locator,
                    display_name=row.display_name,
                    status=ContentStatus(row.status),
                    revision_sha256=row.revision_sha256,
                    files=files,
                    logical_key=row.logical_key,
                    dependencies=tuple(dependencies_by_item[row.id]),
                    dependency_item_ids=tuple(dependency_ids_by_item[row.id]),
                    missing_dependencies=tuple(missing_by_item[row.id]),
                    provenance=dict(row.provenance or {}),
                    metadata=dict(row.content_metadata or {}),
                    diagnostics=_diagnostics(list(row.diagnostics or [])),
                    scanned_at=row.scanned_at,
                    source_mount_id=row.source_mount_id,
                )
            )
        return entries

    async def reconcile_source(
        self,
        *,
        source: ContentSource,
        entries: list[ScannedContentEntry],
        new_item_scope: ContentScope,
        new_item_owner_user_id: str | None,
        creator_claim: tuple[str, str] | None = None,
        active_included_mount_ids: tuple[str, ...] | None = None,
        planned_item_ids: dict[str, str] | None = None,
    ) -> list[CatalogContentEntry]:
        """Reconcile each mount's identities, and atomically withdraw unmounted packs."""

        if (new_item_scope is ContentScope.OWNER) != (new_item_owner_user_id is not None):
            raise ValueError("owner scope and owner_user_id must be supplied together")
        now = datetime.now(UTC)
        if active_included_mount_ids is not None and any(
            entry.source_mount_id not in active_included_mount_ids for entry in entries
        ):
            raise ValueError("Scanned entry does not belong to an active Included source")
        result = await self._session.execute(
            select(ORMContentCatalogItem)
            .where(ORMContentCatalogItem.source == source.value)
            .order_by(ORMContentCatalogItem.id)
            .with_for_update()
        )
        existing = list(result.scalars())
        # An import is an independent copy, even if its bytes equal a missing
        # item. Only explicitly planned, unused Local locations bypass ordinary
        # rename recovery; subsequent scans use the normal matching rules.
        planned = planned_item_ids or {}
        if planned:
            if source is not ContentSource.LOCAL or len(set(planned.values())) != len(planned):
                raise ContentConflictError("package_destination_changed")
            scanned_locations = [entry.relative_locator for entry in entries]
            if any(scanned_locations.count(locator) != 1 for locator in planned):
                raise ContentConflictError("package_destination_changed")
            if any(row.relative_locator in planned for row in existing):
                raise ContentConflictError("package_destination_changed")
            occupied = await self._session.scalar(
                select(ORMContentCatalogItem.id).where(ORMContentCatalogItem.id.in_(planned.values())).limit(1)
            )
            if occupied is not None:
                raise ContentConflictError("package_destination_changed")
        fresh_indexes = {index for index, entry in enumerate(entries) if entry.relative_locator in planned}
        if source is ContentSource.INCLUDED and active_included_mount_ids is not None:
            active_sources = {mount.split("@", 1)[0] for mount in active_included_mount_ids}
            withdrawn = [
                row
                for row in existing
                if row.source_mount_id and row.source_mount_id.split("@", 1)[0] not in active_sources
            ]
            if withdrawn:
                # Included edges are rebuilt from this scan below, so they never
                # hold a pack in place: a built-in effect whose optional sound
                # left loses the edge, and a required one becomes unresolved.
                # Local items, bindings and leases still block withdrawal.
                await self._session.execute(
                    delete(ORMContentCatalogDependency).where(
                        ORMContentCatalogDependency.item_id.in_([row.id for row in existing])
                    )
                )
                await self._withdraw_included_sources(withdrawn, now=now)
                withdrawn_ids = {row.id for row in withdrawn}
                existing = [row for row in existing if row.id not in withdrawn_ids]
        existing_item_ids = [row.id for row in existing]
        existing_file_result = await self._session.execute(
            select(ORMContentCatalogFile).where(ORMContentCatalogFile.item_id.in_(existing_item_ids))
        )
        existing_file_rows = list(existing_file_result.scalars())
        existing_file_rows_by_item: dict[str, list[ORMContentCatalogFile]] = defaultdict(list)
        for file_row in existing_file_rows:
            existing_file_rows_by_item[file_row.item_id].append(file_row)
        by_locator = {(_mount_source(row.source_mount_id), row.relative_locator): row for row in existing}
        by_logical_key: dict[tuple[str, str], list[ORMContentCatalogItem]] = defaultdict(list)
        for row in existing:
            if row.logical_key:
                by_logical_key[(_mount_source(row.source_mount_id), row.logical_key)].append(row)

        matched: dict[int, ORMContentCatalogItem] = {}
        claimed_ids: set[str] = set()
        for index, entry in enumerate(entries):
            if index in fresh_indexes:
                continue
            existing_row = by_locator.get((_mount_source(entry.source_mount_id), entry.relative_locator))
            if existing_row is not None:
                matched[index] = existing_row
                claimed_ids.add(existing_row.id)
        for index, entry in enumerate(entries):
            if index in fresh_indexes or index in matched or not entry.logical_key:
                continue
            logical_candidates = [
                candidate
                for candidate in by_logical_key.get((_mount_source(entry.source_mount_id), entry.logical_key), [])
                if candidate.id not in claimed_ids
            ]
            if len(logical_candidates) == 1:
                matched[index] = logical_candidates[0]
                claimed_ids.add(logical_candidates[0].id)

        unmatched_existing: dict[tuple[str, str, str], list[ORMContentCatalogItem]] = defaultdict(list)
        unmatched_scanned: dict[tuple[str, str, str], list[int]] = defaultdict(list)
        for row in existing:
            if row.id not in claimed_ids and row.revision_sha256:
                unmatched_existing[(_mount_source(row.source_mount_id), row.kind, row.revision_sha256)].append(row)
        for index, entry in enumerate(entries):
            if index not in fresh_indexes and index not in matched and entry.revision_sha256:
                unmatched_scanned[
                    (_mount_source(entry.source_mount_id), entry.kind.value, entry.revision_sha256)
                ].append(index)
        for key, scanned_indexes in unmatched_scanned.items():
            revision_candidates = unmatched_existing.get(key, [])
            if len(scanned_indexes) == 1 and len(revision_candidates) == 1:
                matched[scanned_indexes[0]] = revision_candidates[0]
                claimed_ids.add(revision_candidates[0].id)

        # A bare-file or entry-folder rename can change handler-derived
        # semantics and therefore must change revision_sha256. Preserve its
        # catalog identity only when the complete byte/role projection is a
        # unique one-to-one match; ambiguous duplicate content stays new.
        unmatched_existing_files: dict[
            tuple[str, str, tuple[tuple[str, str, int, str], ...]],
            list[ORMContentCatalogItem],
        ] = defaultdict(list)
        unmatched_scanned_files: dict[
            tuple[str, str, tuple[tuple[str, str, int, str], ...]],
            list[int],
        ] = defaultdict(list)
        for row in existing:
            file_identity = _catalog_file_identity(existing_file_rows_by_item[row.id])
            if row.id not in claimed_ids and file_identity:
                unmatched_existing_files[(_mount_source(row.source_mount_id), row.kind, file_identity)].append(row)
        for index, entry in enumerate(entries):
            file_identity = _scanned_file_identity(entry)
            if index not in fresh_indexes and index not in matched and entry.revision_sha256 and file_identity:
                unmatched_scanned_files[(_mount_source(entry.source_mount_id), entry.kind.value, file_identity)].append(
                    index
                )
        for file_key, scanned_indexes in unmatched_scanned_files.items():
            file_candidates = unmatched_existing_files.get(file_key, [])
            if len(scanned_indexes) == 1 and len(file_candidates) == 1:
                matched[scanned_indexes[0]] = file_candidates[0]
                claimed_ids.add(file_candidates[0].id)

        rows_by_scan_index: dict[int, ORMContentCatalogItem] = {}
        for index, entry in enumerate(entries):
            matched_row = matched.get(index)
            if matched_row is None:
                catalog_row = ORMContentCatalogItem(
                    id=planned.get(entry.relative_locator) or self._new_item_id(entry),
                    source=source.value,
                    scope=new_item_scope.value,
                    owner_user_id=new_item_owner_user_id,
                    kind=entry.kind.value,
                    relative_locator=entry.relative_locator,
                    display_name=entry.display_name,
                    status=entry.status.value,
                )
                self._session.add(catalog_row)
            elif source is ContentSource.INCLUDED:
                catalog_row = matched_row
                catalog_row.scope = ContentScope.INCLUDED.value
                catalog_row.owner_user_id = None
            else:
                catalog_row = matched_row
            if (
                creator_claim is not None
                and source is ContentSource.LOCAL
                and entry.relative_locator == creator_claim[0]
            ):
                if matched_row is not None and matched_row.owner_user_id != creator_claim[1]:
                    raise ContentConflictError("content_creator_claim_conflict")
                catalog_row.scope = ContentScope.OWNER.value
                catalog_row.owner_user_id = creator_claim[1]
            catalog_row.kind = entry.kind.value
            catalog_row.source_mount_id = entry.source_mount_id
            catalog_row.relative_locator = entry.relative_locator
            catalog_row.descriptor_relative_path = entry.descriptor_relative_path
            catalog_row.logical_key = entry.logical_key
            catalog_row.display_name = entry.display_name
            catalog_row.status = entry.status.value
            catalog_row.revision_sha256 = entry.revision_sha256
            prior_provenance = dict(catalog_row.provenance or {})
            catalog_row.provenance = dict(entry.provenance)
            # Package admission facts are internal catalog state rather than
            # everyday Local-library machinery. Preserve them across rescans
            # unless a future package import explicitly replaces them.
            if "import" in prior_provenance and "import" not in catalog_row.provenance:
                catalog_row.provenance["import"] = prior_provenance["import"]
            catalog_row.content_metadata = dict(entry.metadata)
            catalog_row.diagnostics = [_diagnostic_dict(item) for item in entry.diagnostics]
            catalog_row.scanned_at = now
            rows_by_scan_index[index] = catalog_row
        await self._session.flush()

        active_ids = {row.id for row in rows_by_scan_index.values()}
        missing_rows = [row for row in existing if row.id not in active_ids]
        for row in missing_rows:
            row.status = ContentStatus.MISSING.value
            row.diagnostics = [
                {
                    "code": "missing_from_filesystem",
                    "message": "The catalog entry was not present in the latest authoritative scan",
                    "relative_path": row.relative_locator,
                }
            ]
            row.scanned_at = now

        source_item_ids = [row.id for row in existing]
        source_item_ids.extend(row.id for row in rows_by_scan_index.values() if row.id not in source_item_ids)
        existing_files_by_item: dict[str, dict[str, ORMContentCatalogFile]] = defaultdict(dict)
        for existing_file_row in existing_file_rows:
            existing_files_by_item[existing_file_row.item_id][existing_file_row.relative_path] = existing_file_row

        for index, entry in enumerate(entries):
            row = rows_by_scan_index[index]
            remaining = existing_files_by_item[row.id]
            for ordinal, scanned_file in enumerate(entry.files, start=1):
                catalog_file = (
                    remaining.pop(scanned_file.relative_path) if scanned_file.relative_path in remaining else None
                )
                if catalog_file is None:
                    catalog_file = ORMContentCatalogFile(
                        file_ref=str(uuid.uuid4()),
                        item_id=row.id,
                        relative_path=scanned_file.relative_path,
                        role=scanned_file.role,
                        media_type=scanned_file.media_type,
                        size_bytes=scanned_file.size_bytes,
                        sha256=scanned_file.sha256,
                        ordinal=ordinal,
                    )
                    self._session.add(catalog_file)
                else:
                    catalog_file.role = scanned_file.role
                    catalog_file.media_type = scanned_file.media_type
                    catalog_file.size_bytes = scanned_file.size_bytes
                    catalog_file.sha256 = scanned_file.sha256
                    catalog_file.ordinal = ordinal
            for removed in remaining.values():
                await self._session.delete(removed)
        for row in missing_rows:
            for removed in existing_files_by_item[row.id].values():
                await self._session.delete(removed)

        if source_item_ids:
            await self._session.execute(
                delete(ORMContentCatalogDependency).where(ORMContentCatalogDependency.item_id.in_(source_item_ids))
            )
        await self._session.flush()

        active_result = await self._session.execute(
            select(ORMContentCatalogItem).where(ORMContentCatalogItem.status == ContentStatus.VALID.value)
        )
        active_rows = list(active_result.scalars())
        active_by_id = {row.id: row for row in active_rows}
        logical_targets: dict[str, list[str]] = defaultdict(list)
        locator_targets: dict[str, list[str]] = defaultdict(list)
        for row in active_rows:
            if row.logical_key:
                logical_targets[row.logical_key].append(row.id)
            locator_targets[row.relative_locator].append(row.id)

        # Logical keys some present entry still claims, whatever its state: a
        # dependency on one is invalid or ambiguous, never a removed effect.
        claimed_result = await self._session.execute(
            select(ORMContentCatalogItem.logical_key).where(
                ORMContentCatalogItem.logical_key.is_not(None),
                ORMContentCatalogItem.status != ContentStatus.MISSING.value,
            )
        )
        claimed_keys = {key for key in claimed_result.scalars() if key is not None}

        graph: dict[str, set[str]] = defaultdict(set)
        for index, entry in enumerate(entries):
            row = rows_by_scan_index[index]
            declared_kinds: dict[str, ContentKind] = {}
            try:
                parsed = handler_for_kind(entry.kind).parse_document(
                    entry.metadata,
                    fallback_path=Path(entry.relative_locator),
                    descriptor_backed=entry.descriptor_relative_path is not None,
                )
                declared_kinds = {item.ref: item.kind for item in parsed.dependencies}
                if entry.source is ContentSource.LOCAL and any(item.optional for item in parsed.dependencies):
                    # Optional edges exist only for built-in content whose sound a
                    # build may not ship; Local content always names real files.
                    row.status = ContentStatus.INVALID.value
                    row.diagnostics = [
                        *list(row.diagnostics or []),
                        {
                            "code": "dependency_optional_not_allowed",
                            "message": "Only built-in content can declare an optional sound",
                        },
                    ]
            except (ContentDocumentError, TypeError):
                # Scanner diagnostics remain authoritative. This guard keeps
                # reconciliation fault-isolated if a stale adapter supplies an
                # entry that did not pass the shared handler.
                declared_kinds = {}
            seen_dependencies: set[str] = set()
            ordinal = 0
            for declared_ref in entry.dependencies:
                if declared_ref in seen_dependencies:
                    continue
                seen_dependencies.add(declared_ref)
                ordinal += 1
                target_candidates = logical_targets.get(declared_ref, []) or locator_targets.get(declared_ref, [])
                target_id = target_candidates[0] if len(target_candidates) == 1 else None
                if target_id is None and _is_removed_effect(
                    source, entry.kind, declared_ref, declared_kinds.get(declared_ref), claimed_keys
                ):
                    row.diagnostics = [
                        *list(row.diagnostics or []),
                        {
                            "code": MISSING_EFFECT_DEPENDENCY,
                            "message": "An Included effect this Action uses was removed; it plays without it",
                            "relative_path": declared_ref,
                        },
                    ]
                elif target_id is None:
                    row.status = ContentStatus.INVALID.value
                    row.diagnostics = [
                        *list(row.diagnostics or []),
                        {
                            "code": "unresolved_dependency",
                            "message": "A declared content dependency could not be resolved unambiguously",
                            "relative_path": declared_ref,
                        },
                    ]
                else:
                    target = active_by_id.get(target_id)
                    declared_kind = declared_kinds.get(declared_ref)
                    if target is not None and declared_kind is not None and target.kind != declared_kind.value:
                        row.status = ContentStatus.INVALID.value
                        row.diagnostics = [
                            *list(row.diagnostics or []),
                            {
                                "code": "dependency_kind_mismatch",
                                "message": (f"Dependency declares {declared_kind.value} but resolves to {target.kind}"),
                                "relative_path": declared_ref,
                            },
                        ]
                    elif (
                        entry.source is ContentSource.LOCAL
                        and target is not None
                        and target.kind == ContentKind.SOUND_EFFECT.value
                        and (target.provenance or {}).get(DISTRIBUTION_KEY) == DISTRIBUTION_NON_PORTABLE
                    ):
                        # Licensed built-in sounds play only through built-in
                        # content; they are never part of the owner's own work.
                        row.status = ContentStatus.INVALID.value
                        row.diagnostics = [
                            *list(row.diagnostics or []),
                            {
                                "code": "non_portable_dependency",
                                "message": "Licensed built-in sounds cannot be used in your own content",
                                "relative_path": declared_ref,
                            },
                        ]
                    else:
                        graph[row.id].add(target_id)
                self._session.add(
                    ORMContentCatalogDependency(
                        item_id=row.id,
                        ordinal=ordinal,
                        declared_ref=declared_ref,
                        target_item_id=target_id,
                    )
                )

        visiting: set[str] = set()
        visited: set[str] = set()
        cyclic: set[str] = set()

        def visit(item_id: str, path: list[str]) -> None:
            if item_id in visiting:
                cyclic.update(path[path.index(item_id) :])
                return
            if item_id in visited:
                return
            visiting.add(item_id)
            path.append(item_id)
            for target_id in graph.get(item_id, set()):
                visit(target_id, path)
            path.pop()
            visiting.remove(item_id)
            visited.add(item_id)

        for item_id in graph:
            visit(item_id, [])
        for row in rows_by_scan_index.values():
            if row.id in cyclic:
                row.status = ContentStatus.INVALID.value
                row.diagnostics = [
                    *list(row.diagnostics or []),
                    {"code": "dependency_cycle", "message": "Content dependencies contain a cycle"},
                ]

        rows_by_id = {row.id: row for row in active_rows}
        rows_by_id.update({row.id: row for row in rows_by_scan_index.values()})
        changed = True
        while changed:
            changed = False
            for item_id, target_ids in graph.items():
                dependent_row = rows_by_id.get(item_id)
                if dependent_row is None or dependent_row.status != ContentStatus.VALID.value:
                    continue
                if any(
                    (target := rows_by_id.get(target_id)) is None or target.status != ContentStatus.VALID.value
                    for target_id in target_ids
                ):
                    dependent_row.status = ContentStatus.INVALID.value
                    dependent_row.diagnostics = [
                        *list(dependent_row.diagnostics or []),
                        {
                            "code": "dependency_unavailable",
                            "message": "A resolved content dependency is not valid",
                        },
                    ]
                    changed = True

        await self._complete_write()
        refreshed_result = await self._session.execute(
            select(ORMContentCatalogItem)
            .where(ORMContentCatalogItem.source == source.value)
            .order_by(ORMContentCatalogItem.kind, ORMContentCatalogItem.display_name)
        )
        return await self._load_entries(list(refreshed_result.scalars()))

    async def lock_items(self, *, user_id: str, item_ids: tuple[str, ...]) -> None:
        """Lock parents first in stable order, then registered file/edge facts.

        Coordinated Save/Rescan and deletion lock these same rows. No database
        lock can prevent an operator editing bytes, so callers recheck files too.

        Parents follow the full rescan's source order before ID, so a mixed
        Included and Local closure cannot invert it. They take FOR NO KEY UPDATE:
        it still excludes reconciliation, updates and deletion, but admits the
        KEY SHARE that a Local-only rescan's dependency foreign keys take on
        Included targets after it has locked Local rows.
        """

        if not item_ids:
            return
        source_rank = case(
            {source.value: rank for rank, source in enumerate(CONTENT_SOURCE_LOCK_ORDER)},
            value=ORMContentCatalogItem.source,
        )
        locked = await self._session.scalars(
            select(ORMContentCatalogItem.id)
            .where(
                ORMContentCatalogItem.id.in_(item_ids),
                or_(
                    ORMContentCatalogItem.scope.in_(
                        [ContentScope.INCLUDED.value, ContentScope.INSTALLATION_SHARED.value]
                    ),
                    ORMContentCatalogItem.owner_user_id == user_id,
                ),
            )
            .order_by(source_rank, ORMContentCatalogItem.id)
            .with_for_update(key_share=True)
        )
        visible_ids = tuple(locked)
        await self._session.execute(
            select(ORMContentCatalogFile.file_ref)
            .where(ORMContentCatalogFile.item_id.in_(visible_ids))
            .order_by(ORMContentCatalogFile.item_id, ORMContentCatalogFile.ordinal)
            .with_for_update()
        )
        await self._session.execute(
            select(ORMContentCatalogDependency.item_id)
            .where(ORMContentCatalogDependency.item_id.in_(visible_ids))
            .order_by(ORMContentCatalogDependency.item_id, ORMContentCatalogDependency.ordinal)
            .with_for_update()
        )

    async def _lock_transaction(self, key: str) -> None:
        lock_id = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big", signed=True)
        await self._session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})

    async def lock_source(self, *, source: ContentSource) -> None:
        """Do not let another scan expose new creator bytes before owner admission."""

        await self._lock_transaction(f"content-source:{source.value}")

    async def lock_save(self, *, relative_locator: str, owner_digest: str | None = None) -> None:
        """Transaction locks cover the absent destination before its first insert."""

        keys = [f"content-save:{relative_locator}"]
        if owner_digest is not None:
            keys.append(f"content-model:{owner_digest}")
        for key in sorted(keys):
            await self._lock_transaction(key)

    async def item_has_live_animas(self, *, item_id: str) -> bool:
        direct = await self._session.scalar(
            select(ORMAnima.id)
            .join(ORMAvatar, ORMAnima.avatar_id == ORMAvatar.id)
            .where(ORMAvatar.catalog_item_id == item_id)
            .limit(1)
        )
        binding = await self._session.scalar(
            select(ORMAnimaContentBinding.anima_id).where(ORMAnimaContentBinding.catalog_item_id == item_id).limit(1)
        )
        return direct is not None or binding is not None

    async def record_transition_failure(self, *, user_id: str, item_id: str, expected_revision: str, code: str) -> None:
        """Keep an unconvertible source unavailable without losing its originals."""
        async with self.mutation_transaction():
            entry = await self.get_visible_item(item_id=item_id, user_id=user_id, for_update=True)
            if entry is None or entry.revision_sha256 != expected_revision:
                raise ContentConflictError("content_transition_source_changed")
            row = await self._session.get(ORMContentCatalogItem, item_id)
            assert row is not None
            row.status = ContentStatus.INVALID.value
            row.diagnostics = [
                *list(row.diagnostics or []),
                {
                    "code": code,
                    "message": (
                        "This legacy content could not be converted. Original files are preserved; "
                        "repair its Action, motion or pool references and rescan."
                    ),
                },
            ]
            await self._session.flush()

    async def list_visible(self, *, user_id: str) -> list[CatalogContentEntry]:
        result = await self._session.execute(
            select(ORMContentCatalogItem)
            .where(
                or_(
                    ORMContentCatalogItem.scope.in_(
                        [ContentScope.INCLUDED.value, ContentScope.INSTALLATION_SHARED.value]
                    ),
                    ORMContentCatalogItem.owner_user_id == user_id,
                ),
                _LISTED,
            )
            .order_by(ORMContentCatalogItem.kind, ORMContentCatalogItem.display_name)
            .execution_options(populate_existing=True)
        )
        return await self._load_entries(list(result.scalars()))

    async def included_generation(self) -> str:
        """Name the current state of the listed Included rows, which every owner sees.

        It changes with any change to those rows: a reconciliation, a pack's drift
        or its withdrawal. It changes with a release only because a release's first
        start reconciles every source, as the local composition's start-up does. A
        composition that does not reconcile at start must override this with a value
        that changes with every application revision, such as that revision.
        """

        return await self._rows_revision(ORMContentCatalogItem.scope == ContentScope.INCLUDED.value)

    async def owned_and_shared_revision(self, *, user_id: str) -> str:
        """Name the current state of the other listed rows ``user_id`` sees: its own and installation-shared ones.

        A release that projects these rows differently changes the Included
        generation, which every catalog validator also names.
        """

        return await self._rows_revision(
            or_(
                ORMContentCatalogItem.scope == ContentScope.INSTALLATION_SHARED.value,
                ORMContentCatalogItem.owner_user_id == user_id,
            )
        )

    async def _rows_revision(self, rows: ColumnElement[bool]) -> str:
        """Digest the listed ``rows``' identities and last changes inside the database.

        ``updated_at`` also versions a row's files and dependency edges: only
        reconciliation writes those, and it rewrites their row with them.
        """

        item = ORMContentCatalogItem
        changes = func.string_agg(func.concat(item.id, " ", item.updated_at), aggregate_order_by(literal(","), item.id))
        digest = func.sha256(func.convert_to(func.coalesce(changes, ""), literal("UTF8")))
        # An aggregate always returns its one row; no rows digest the empty string.
        value = await self._session.scalar(select(digest).where(rows, _LISTED))
        return cast(bytes, value).hex()

    async def get_visible_item(
        self, *, item_id: str, user_id: str, for_update: bool = False
    ) -> CatalogContentEntry | None:
        """Return one catalog item only when its persisted scope admits the caller."""

        lock = for_update and not self._session.info.get(SHARED_CATALOG_ROWS_IMMUTABLE)
        row = await self._session.get(
            ORMContentCatalogItem,
            item_id,
            with_for_update=True if lock else None,
            populate_existing=for_update,
        )
        if for_update and not lock and row is not None and row.owner_user_id is not None:
            # Shared rows are immutable here; an owner row keeps its lock.
            row = await self._session.get(ORMContentCatalogItem, item_id, with_for_update=True, populate_existing=True)
        return await self._visible_entry(row, user_id=user_id)

    async def get_visible_items(
        self, *, item_ids: Iterable[str], user_id: str, for_update: bool = False
    ) -> dict[str, CatalogContentEntry]:
        """The visible items among ``item_ids``, read (and locked) in one statement.

        With ``for_update`` every named row that exists is locked, as
        ``get_visible_item`` locks one, in item ID order (only owner rows when the
        session declares ``SHARED_CATALOG_ROWS_IMMUTABLE``); only the rows the caller
        may read are returned, keyed by ID.
        """

        ids = sorted(set(item_ids))
        if not ids:
            return {}
        statement = (
            select(ORMContentCatalogItem)
            .where(ORMContentCatalogItem.id.in_(ids))
            .order_by(ORMContentCatalogItem.id)
            .execution_options(populate_existing=True)
        )
        if for_update and self._session.info.get(SHARED_CATALOG_ROWS_IMMUTABLE):
            # Lock the owner rows first; the read below then sees them as locked.
            await self._session.execute(
                select(ORMContentCatalogItem.id)
                .where(ORMContentCatalogItem.id.in_(ids), ORMContentCatalogItem.owner_user_id.is_not(None))
                .order_by(ORMContentCatalogItem.id)
                .with_for_update()
            )
        elif for_update:
            statement = statement.with_for_update()
        rows = [
            row
            for row in (await self._session.execute(statement)).scalars()
            if ContentAccessPolicy.can_read(
                scope=ContentScope(row.scope), owner_user_id=row.owner_user_id, user_id=user_id
            )
        ]
        return {entry.id: entry for entry in await self._load_entries(rows)}

    async def _visible_entry(self, row: ORMContentCatalogItem | None, *, user_id: str) -> CatalogContentEntry | None:
        if row is None:
            return None
        if not ContentAccessPolicy.can_read(
            scope=ContentScope(row.scope),
            owner_user_id=row.owner_user_id,
            user_id=user_id,
        ):
            return None
        loaded = await self._load_entries([row])
        return loaded[0] if loaded else None

    async def delete_unbound_avatar_mapping(self, *, item_id: str, user_id: str) -> None:
        """Release an unused owned mapping inside the caller's catalog deletion.

        The caller holds the catalog parent lock. Lock the Avatar too so a new
        Anima's foreign-key reference cannot race the check and removal. A live
        mapping remains and is rejected by the ordinary runtime reference check.
        """
        avatar = await self._session.scalar(
            select(ORMAvatar)
            .where(
                ORMAvatar.catalog_item_id == item_id,
                ORMAvatar.user_id == user_id,
                ORMAvatar.private.is_(True),
            )
            .with_for_update()
        )
        if avatar is None:
            return
        if await self._session.scalar(select(ORMAnima.id).where(ORMAnima.avatar_id == avatar.id).limit(1)) is not None:
            return
        await self._session.delete(avatar)
        await self._session.flush()

    async def item_usage(self, *, item_id: str, limit: int = CONTENT_USAGE_LIMIT) -> tuple[ContentUsage, ...]:
        """Name the Animas and items that keep an item from being deleted.

        An Avatar counts through the Animas that select its mapping; the owner's
        unused mapping is released by deletion, so it is not a use. Each loadout
        binding counts by its kind, and a Gesture slot ``idle:…`` as an Idle pool
        member. Dependency rows protect support content reached transitively
        rather than equipped. Each Anima use is named once, ordered by Anima name
        and then use; dependent items follow by name.
        """

        avatar_animas = await self._session.execute(
            select(ORMAnima.id, ORMAnima.display_name)
            .join(ORMAvatar, ORMAnima.avatar_id == ORMAvatar.id)
            .where(ORMAvatar.catalog_item_id == item_id)
            .order_by(ORMAnima.display_name, ORMAnima.id)
            .limit(limit)
        )
        anima_uses = {ContentUsage("anima_avatar", anima_id, name) for anima_id, name in avatar_animas}
        idle = ORMAnimaContentBinding.slot_key.startswith("idle:").label("idle")
        bindings = await self._session.execute(
            select(ORMAnimaContentBinding.kind, idle, ORMAnima.id, ORMAnima.display_name)
            .join(ORMAnima, ORMAnima.id == ORMAnimaContentBinding.anima_id)
            .where(ORMAnimaContentBinding.catalog_item_id == item_id)
            .distinct()
            .order_by(ORMAnima.display_name, ORMAnima.id, ORMAnimaContentBinding.kind, idle)
            .limit(limit)
        )
        anima_uses.update(
            ContentUsage("anima_idle" if is_idle else _BINDING_USES[kind], anima_id, name)
            for kind, is_idle, anima_id, name in bindings
        )
        dependents = await self._session.execute(
            select(ORMContentCatalogItem.id, ORMContentCatalogItem.display_name)
            .join(ORMContentCatalogDependency, ORMContentCatalogDependency.item_id == ORMContentCatalogItem.id)
            .where(ORMContentCatalogDependency.target_item_id == item_id)
            .distinct()
            .order_by(ORMContentCatalogItem.display_name, ORMContentCatalogItem.id)
            .limit(limit)
        )
        ordered = sorted(anima_uses, key=lambda use: (use.name.casefold(), use.id, _USE_ORDER.index(use.kind)))
        ordered.extend(
            sorted(
                (ContentUsage("content", dependent_id, name) for dependent_id, name in dependents),
                key=lambda use: (use.name.casefold(), use.id),
            )
        )
        return tuple(ordered[:limit])

    async def _withdraw_included_sources(self, rows: list[ORMContentCatalogItem], *, now: datetime) -> None:
        """Withdraw absent packs atomically, never reinterpret them as missing files.

        The source advisory lock is held by the caller. Refuse every live binding,
        external dependency, preview or runtime lease before cascading deletion.
        Desktop removal preflight exposes the same blockers before changing mounts
        (it also counts Included edges, which reconciliation rebuilds instead).
        """

        ids = [row.id for row in rows]
        if await included_source_blockers(
            self._session, mount_ids=[row.source_mount_id for row in rows if row.source_mount_id], now=now, limit=1
        ):
            raise ContentConflictError("included_source_in_use")
        await self._session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id.in_(ids)))

    async def purge_item(self, *, item_id: str) -> None:
        """Purge an explicit-delete identity; scan-created missing rows are retained."""

        deleted_id = (
            await self._session.execute(
                delete(ORMContentCatalogItem)
                .where(ORMContentCatalogItem.id == item_id)
                .returning(ORMContentCatalogItem.id)
            )
        ).scalar_one_or_none()
        if deleted_id is None:
            if _MUTATION_TRANSACTION_KEY not in self._session.info:
                await self._session.rollback()
            raise ContentNotFoundError("catalog item was not found")
        await self._complete_write()

    async def get_by_locator(
        self,
        *,
        source: ContentSource,
        relative_locator: str,
    ) -> CatalogContentEntry | None:
        """Resolve a server-generated readable locator for mutation preflight."""

        row = (
            await self._session.execute(
                select(ORMContentCatalogItem).where(
                    ORMContentCatalogItem.source == source.value,
                    ORMContentCatalogItem.relative_locator == relative_locator,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        loaded = await self._load_entries([row])
        return loaded[0] if loaded else None

    async def get_by_logical_key(
        self,
        *,
        source: ContentSource,
        logical_key: str,
    ) -> CatalogContentEntry | None:
        """Resolve stable readable identity without guessing among duplicates."""

        rows = list(
            (
                await self._session.execute(
                    select(ORMContentCatalogItem).where(
                        ORMContentCatalogItem.source == source.value,
                        ORMContentCatalogItem.logical_key == logical_key,
                    )
                )
            ).scalars()
        )
        if len(rows) != 1:
            return None
        loaded = await self._load_entries(rows)
        return loaded[0] if loaded else None

    async def assign_creator_owner(self, *, item_id: str, user_id: str) -> CatalogContentEntry:
        """Attach creator ownership to the exact new Local item in network mode."""

        row = await self._session.get(ORMContentCatalogItem, item_id)
        if row is None or row.source != ContentSource.LOCAL.value:
            raise ContentNotFoundError("Local catalog item was not found")
        scope = ContentScope(row.scope)
        if scope is ContentScope.OWNER and row.owner_user_id != user_id:
            raise ContentNotFoundError("Local catalog item was not found")
        if scope is ContentScope.INSTALLATION_SHARED:
            row.scope = ContentScope.OWNER.value
            row.owner_user_id = user_id
            await self._complete_write()
        loaded = await self._load_entries([row])
        if not loaded:
            raise ContentNotFoundError("Local catalog item was not found")
        return loaded[0]

    async def record_import_provenance(
        self,
        *,
        item_id: str,
        user_id: str,
        provenance: dict[str, object],
    ) -> CatalogContentEntry:
        """Persist distribution facts without adding package files to Local."""

        row = await self._session.get(ORMContentCatalogItem, item_id)
        if row is None or row.source != ContentSource.LOCAL.value:
            raise ContentNotFoundError("Local catalog item was not found")
        if not ContentAccessPolicy.can_mutate(
            entry=(await self._load_entries([row]))[0],
            user_id=user_id,
        ):
            raise ContentNotFoundError("Local catalog item was not found")
        row.provenance = dict(provenance)
        await self._complete_write()
        loaded = await self._load_entries([row])
        if not loaded:
            raise ContentNotFoundError("Local catalog item was not found")
        return loaded[0]

    async def get_visible_file(self, *, file_ref: str, user_id: str) -> CatalogContentFile | None:
        result = await self._session.execute(
            select(ORMContentCatalogFile, ORMContentCatalogItem)
            .join(
                ORMContentCatalogItem,
                ORMContentCatalogItem.id == ORMContentCatalogFile.item_id,
            )
            .where(
                ORMContentCatalogFile.file_ref == file_ref,
                ORMContentCatalogItem.status == ContentStatus.VALID.value,
            )
        )
        pair = result.one_or_none()
        if pair is None:
            return None
        file_row, item_row = pair
        scope = ContentScope(item_row.scope)
        if not ContentAccessPolicy.can_read(scope=scope, owner_user_id=item_row.owner_user_id, user_id=user_id):
            return None
        return CatalogContentFile(
            file_ref=file_row.file_ref,
            item_id=file_row.item_id,
            source=ContentSource(item_row.source),
            source_mount_id=item_row.source_mount_id,
            relative_path=file_row.relative_path,
            role=file_row.role,
            media_type=file_row.media_type,
            size_bytes=file_row.size_bytes,
            sha256=file_row.sha256,
        )

    async def create_preview(
        self,
        *,
        item: CatalogContentEntry,
        members: tuple[CatalogContentEntry, ...] = (),
        user_id: str,
        expires_at: datetime,
    ) -> ContentPreview:
        """Freeze one root through the shared bundle persistence path."""

        return await self.create_preview_bundle(
            anchor=item,
            entries=(item, *members),
            user_id=user_id,
            expires_at=expires_at,
        )

    async def create_preview_bundle(
        self,
        *,
        anchor: CatalogContentEntry,
        entries: tuple[CatalogContentEntry, ...],
        user_id: str,
        expires_at: datetime,
    ) -> ContentPreview:
        """Freeze a canonical union with one row per unique registered file."""

        by_id = {entry.id: entry for entry in entries}
        if anchor.id not in by_id:
            raise ValueError("A preview bundle anchor must be a member")
        closure = tuple(by_id[item_id] for item_id in sorted(by_id))
        await self.lock_items(user_id=user_id, item_ids=tuple(by_id))
        # A pack may have been withdrawn after the caller read the catalog.
        # Recheck custody under the row locks just taken. Refresh without
        # upgrading them to FOR UPDATE, which would conflict with a concurrent
        # rescan's dependency foreign-key checks.
        for entry in closure:
            row = await self._session.get(ORMContentCatalogItem, entry.id, populate_existing=True)
            current = await self._visible_entry(row, user_id=user_id)
            if (
                current is None
                or current.status is not ContentStatus.VALID
                or current.revision_sha256 != entry.revision_sha256
                or current.source_mount_id != entry.source_mount_id
                or current.files != entry.files
            ):
                raise ContentConflictError("preview_catalog_changed")
        if any(entry.revision_sha256 is None for entry in closure):
            raise ValueError("A preview requires an exact catalog revision")
        revision_sha256 = anchor.revision_sha256 or ""
        if len(closure) > 1:
            identity = [{"item_id": entry.id, "revision_sha256": entry.revision_sha256} for entry in closure]
            revision_sha256 = hashlib.sha256(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        await self._session.execute(delete(ORMContentPreview).where(ORMContentPreview.expires_at <= datetime.now(UTC)))
        # Always issue a fresh capability. A filesystem-only rename may retain
        # the same content revision while changing its exact safe relative path.
        # Reusing by revision would therefore return memberships that do not
        # match the frozen database rows.
        existing = ORMContentPreview(
            id=str(uuid.uuid4()),
            owner_user_id=user_id,
            item_id=anchor.id,
            revision_sha256=revision_sha256,
            expires_at=expires_at,
        )
        self._session.add(existing)
        await self._session.flush()
        files_by_ref: dict[str, CatalogContentFile] = {}
        for entry in closure:
            for file in entry.files:
                prior = files_by_ref.get(file.file_ref)
                if prior is not None and prior != file:
                    raise ValueError("A preview file reference resolved to conflicting facts")
                files_by_ref[file.file_ref] = file
        all_files = tuple(files_by_ref[file_ref] for file_ref in sorted(files_by_ref))
        for ordinal, file in enumerate(all_files, start=1):
            self._session.add(
                ORMContentPreviewFile(
                    preview_id=existing.id,
                    file_ref=file.file_ref,
                    source=file.source.value,
                    source_mount_id=file.source_mount_id,
                    relative_path=file.relative_path,
                    role=file.role,
                    media_type=file.media_type,
                    size_bytes=file.size_bytes,
                    sha256=file.sha256,
                    ordinal=ordinal,
                )
            )
        await self._complete_write()
        files = tuple(
            ContentPreviewFile(
                file_ref=file.file_ref,
                source=file.source,
                source_mount_id=file.source_mount_id,
                relative_path=file.relative_path,
                role=file.role,
                media_type=file.media_type,
                size_bytes=file.size_bytes,
                sha256=file.sha256,
            )
            for file in all_files
        )
        return ContentPreview(
            id=existing.id,
            owner_user_id=user_id,
            item_id=anchor.id,
            revision_sha256=revision_sha256,
            files=files,
            expires_at=existing.expires_at,
        )

    async def get_preview_file(
        self,
        *,
        preview_id: str,
        revision_sha256: str,
        file_ref: str,
        user_id: str,
        now: datetime,
    ) -> ContentPreviewFile | None:
        """Authorize a preview membership and return its frozen expected facts."""

        pair = (
            await self._session.execute(
                select(ORMContentPreviewFile, ORMContentPreview)
                .join(
                    ORMContentPreview,
                    ORMContentPreview.id == ORMContentPreviewFile.preview_id,
                )
                .where(
                    ORMContentPreview.id == preview_id,
                    ORMContentPreview.owner_user_id == user_id,
                    ORMContentPreview.revision_sha256 == revision_sha256,
                    ORMContentPreview.expires_at > now,
                    ORMContentPreviewFile.file_ref == file_ref,
                )
            )
        ).one_or_none()
        if pair is None:
            return None
        file_row, _ = pair
        return ContentPreviewFile(
            file_ref=file_row.file_ref,
            source=ContentSource(file_row.source),
            source_mount_id=file_row.source_mount_id,
            relative_path=file_row.relative_path,
            role=file_row.role,
            media_type=file_row.media_type,
            size_bytes=file_row.size_bytes,
            sha256=file_row.sha256,
        )

    async def mark_scan_required(
        self,
        *,
        source: ContentSource,
        relative_paths: tuple[str, ...],
        current_scan: list[ScannedContentEntry] | None = None,
    ) -> None:
        """Invalidate changed entries and their dependents without blocking unrelated content."""

        paths = tuple(dict.fromkeys(path.strip("/") for path in relative_paths if path.strip("/")))
        if not paths:
            return
        result = await self._session.execute(
            select(ORMContentCatalogItem).where(ORMContentCatalogItem.source == source.value)
        )
        source_rows = list(result.scalars())
        affected_ids: set[str] = set()
        if source is ContentSource.INCLUDED and any(
            path == "licenses" or path.startswith("licenses/") for path in paths
        ):
            affected_ids.update(row.id for row in source_rows)
        else:
            file_result = await self._session.execute(
                select(ORMContentCatalogFile.item_id)
                .join(
                    ORMContentCatalogItem,
                    ORMContentCatalogItem.id == ORMContentCatalogFile.item_id,
                )
                .where(
                    ORMContentCatalogItem.source == source.value,
                    ORMContentCatalogFile.relative_path.in_(paths),
                )
            )
            affected_ids.update(file_result.scalars())
            for row in source_rows:
                locator = row.relative_locator.rstrip("/")
                locator_stem = str(PurePosixPath(locator).with_suffix(""))
                for path in paths:
                    path_stem = path.removesuffix(".meta.json")
                    if (
                        path == locator
                        or path.startswith(f"{locator}/")
                        or locator.startswith(f"{path}/")
                        or path_stem == locator_stem
                    ):
                        affected_ids.add(row.id)
                        break

        if current_scan is not None:
            # A delayed notification can describe bytes already admitted by a
            # creator transaction. Compare the scanner's complete semantic and
            # file revision, never timestamps or a blanket ignore interval.
            by_locator: dict[tuple[str | None, str], list[ScannedContentEntry]] = defaultdict(list)
            logical_counts: dict[str, int] = defaultdict(int)
            for entry in current_scan:
                if entry.source is source:
                    by_locator[(entry.source_mount_id, entry.relative_locator)].append(entry)
                    if entry.logical_key:
                        logical_counts[entry.logical_key] += 1
            for row in source_rows:
                candidates = by_locator[(row.source_mount_id, row.relative_locator)]
                ambiguous = row.logical_key is not None and logical_counts[row.logical_key] > 1
                if ambiguous:
                    # A new duplicate can change dependency resolution even
                    # when its path does not overlap the prior target's path.
                    affected_ids.add(row.id)
                elif len(candidates) == 1:
                    entry = candidates[0]
                    if (
                        row.status == ContentStatus.VALID.value
                        and entry.status is ContentStatus.VALID
                        and row.kind == entry.kind.value
                        and row.logical_key == entry.logical_key
                        and row.revision_sha256 is not None
                        and row.revision_sha256 == entry.revision_sha256
                    ):
                        affected_ids.discard(row.id)

        if affected_ids:
            dependency_result = await self._session.execute(
                select(
                    ORMContentCatalogDependency.item_id,
                    ORMContentCatalogDependency.target_item_id,
                ).where(ORMContentCatalogDependency.target_item_id.is_not(None))
            )
            reverse_dependencies: dict[str, set[str]] = defaultdict(set)
            for item_id, target_item_id in dependency_result:
                if target_item_id is not None:
                    reverse_dependencies[target_item_id].add(item_id)
            pending = list(affected_ids)
            while pending:
                target_id = pending.pop()
                for dependent_id in reverse_dependencies.get(target_id, set()):
                    if dependent_id not in affected_ids:
                        affected_ids.add(dependent_id)
                        pending.append(dependent_id)

            await self._session.execute(
                update(ORMContentCatalogItem)
                .where(ORMContentCatalogItem.id.in_(affected_ids))
                .values(status=ContentStatus.SCAN_REQUIRED.value)
            )
        await self._complete_write()


__all__ = ["SHARED_CATALOG_ROWS_IMMUTABLE", "SQLAlchemyContentCatalog"]
