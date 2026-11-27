"""Use cases for scanning, listing, and opening readable local content."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import uuid4

from animama.app.ports.content_catalog import ContentCatalog
from animama.app.ports.content_publication import ContentMutations, ContentPublication
from animama.app.ports.content_store import ContentStore, LocalContentStore
from animama.app.services.avatar_portraits import portrait_matches
from animama.app.services.content_access_policy import ContentAccessPolicy
from animama.app.services.content_kind_registry import RETIRED_CONTENT_KINDS
from animama.app.services.local_content_mutations import LocalContentMutations, mutation_digest
from animama.domain.content_catalog import (
    CONTENT_SOURCE_LOCK_ORDER,
    CatalogContentEntry,
    CatalogContentFile,
    ContentConflictError,
    ContentIntegrityError,
    ContentKind,
    ContentNotFoundError,
    ContentPathError,
    ContentPreview,
    ContentPreviewFile,
    ContentScanSummary,
    ContentScope,
    ContentSource,
    ContentStatus,
    ContentUsage,
    VerifiedContentFile,
)


@dataclass(frozen=True, slots=True)
class ContentRescanResult:
    """Authoritative scan counts and the caller-visible catalog."""

    summaries: tuple[ContentScanSummary, ...]
    items: tuple[CatalogContentEntry, ...]


class ContentCatalogService:
    """Coordinate verified bytes and catalog publication without FastAPI."""

    def __init__(
        self,
        *,
        store: ContentStore,
        catalog: ContentCatalog,
        mutations: ContentMutations | None = None,
        publication: ContentPublication | None = None,
    ) -> None:
        self._store = store
        self._catalog = catalog
        owners = {getattr(adapter, "owner_id", None) for adapter in (store, catalog)}
        if len(owners) != 1:
            raise ValueError("content catalog and store must bind the same owner")
        self.owner_id = owners.pop()
        if self.owner_id is not None and (not isinstance(self.owner_id, str) or not self.owner_id):
            raise ValueError("content owner must be a nonempty server-resolved identity")
        if publication is not None and publication.owner_id != self.owner_id:
            raise ValueError("content publication must bind the same owner")
        if mutations is not None and (mutations.store is not store or mutations.catalog is not catalog):
            raise ValueError("content mutation coordinator must own the same adapters")
        if self.owner_id is not None and (mutations is None or publication is None):
            raise ValueError("an owner-bound content composition requires explicit publication and mutation authority")
        self._publication = publication
        self.mutations: ContentMutations = mutations or LocalContentMutations(
            store=cast(LocalContentStore, store), catalog=catalog
        )

    def require_owner(self, user_id: str) -> None:
        """Reject cross-owner calls before replay, catalog lookup or byte access."""
        if self.owner_id is not None and user_id != self.owner_id:
            raise ContentNotFoundError("content owner was not found")

    async def rescan(
        self,
        *,
        user_id: str,
        include_included: bool = True,
        creator_claim_locator: str | None = None,
        planned_item_ids: dict[str, str] | None = None,
    ) -> ContentRescanResult:
        """Recover unfinished mutations before admitting a complete source scan."""

        self.require_owner(user_id)
        return await self.mutations.reconcile(
            lambda: self._rescan(
                user_id=user_id,
                include_included=include_included,
                creator_claim_locator=creator_claim_locator,
                planned_item_ids=planned_item_ids,
            )
        )

    async def _rescan(
        self,
        *,
        user_id: str,
        include_included: bool,
        creator_claim_locator: str | None,
        planned_item_ids: dict[str, str] | None = None,
    ) -> ContentRescanResult:
        """Scan registered roots; a bad entry never prevents reconciliation of peers."""

        if self._publication is not None:
            published_summaries = await self._publication.refresh(
                user_id=user_id,
                include_included=include_included,
                creator_claim_locator=creator_claim_locator,
                planned_item_ids=planned_item_ids,
            )
            return await self.visible_scan_result(published_summaries, user_id=user_id)
        # Row-lock helpers rely on this order; see CONTENT_SOURCE_LOCK_ORDER.
        sources = [source for source in CONTENT_SOURCE_LOCK_ORDER if include_included or source is ContentSource.LOCAL]
        summaries: list[ContentScanSummary] = []
        included_mount_ids = getattr(self._store, "included_mount_ids", None)
        for source in sources:
            # A coordinated Save holds this fence from file promotion through
            # owner admission. Scan only after that commit, never in its gap.
            await self._catalog.lock_source(source=source)
            scanned = await asyncio.to_thread(cast(LocalContentStore, self._store).scan, source)
            if source is ContentSource.INCLUDED:
                scope = ContentScope.INCLUDED
                owner_user_id = None
            else:
                scope = ContentScope.OWNER
                owner_user_id = user_id
            reconciled = await self._catalog.reconcile_source(
                source=source,
                entries=scanned,
                new_item_scope=scope,
                new_item_owner_user_id=owner_user_id,
                creator_claim=(creator_claim_locator, user_id)
                if source is ContentSource.LOCAL and creator_claim_locator
                else None,
                planned_item_ids=planned_item_ids if source is ContentSource.LOCAL else None,
                **(
                    {"active_included_mount_ids": included_mount_ids}
                    if source is ContentSource.INCLUDED and included_mount_ids is not None
                    else {}
                ),
            )
            summaries.append(
                ContentScanSummary(
                    source=source,
                    scanned=len(scanned),
                    valid=sum(item.status is ContentStatus.VALID for item in reconciled),
                    invalid=sum(item.status is ContentStatus.INVALID for item in reconciled),
                    missing=sum(item.status is ContentStatus.MISSING for item in reconciled),
                )
            )
        return await self.visible_scan_result(tuple(summaries), user_id=user_id)

    async def list_visible(self, *, user_id: str) -> list[CatalogContentEntry]:
        """List supported content; raw retired rows remain private transition evidence."""
        self.require_owner(user_id)
        return [
            item for item in await self._catalog.list_visible(user_id=user_id) if item.kind not in RETIRED_CONTENT_KINDS
        ]

    async def visible_items(self, *, item_ids: Iterable[str], user_id: str) -> dict[str, CatalogContentEntry]:
        """The caller's visible rows among ``item_ids``, by id, whatever their scan status.

        A narrow read of the rows themselves: nothing is parsed, and a row
        that is invalid, missing its files or waiting for a rescan is still
        returned, because it is still an item of the Library. Retired kinds
        are left out, as in ``list_visible``.
        """
        self.require_owner(user_id)
        found = await self._catalog.get_visible_items(item_ids=item_ids, user_id=user_id)
        return {item_id: item for item_id, item in found.items() if item.kind not in RETIRED_CONTENT_KINDS}

    async def visible_revision(self, *, user_id: str) -> str:
        """Name the caller's visible catalog without listing it.

        It changes whenever a row the caller sees changes, and with every release
        through the Included generation; it stays put otherwise.
        The caller's identity is part of it, so no value names another owner's
        catalog. Read it before the listing: a change between the two then shows
        as a new revision on the next read instead of hiding behind an old one.
        """

        self.require_owner(user_id)
        generation = await self._catalog.included_generation()
        owned = await self._catalog.owned_and_shared_revision(user_id=user_id)
        return hashlib.sha256(json.dumps([user_id, generation, owned]).encode()).hexdigest()

    async def visible_scan_result(
        self, summaries: tuple[ContentScanSummary, ...], *, user_id: str
    ) -> ContentRescanResult:
        """Report current supported rows after preserving conversions have finished."""
        items = tuple(await self.list_visible(user_id=user_id))
        return ContentRescanResult(
            tuple(
                ContentScanSummary(
                    source=summary.source,
                    scanned=sum(
                        item.source is summary.source and item.status is not ContentStatus.MISSING for item in items
                    ),
                    valid=sum(item.source is summary.source and item.status is ContentStatus.VALID for item in items),
                    invalid=sum(
                        item.source is summary.source and item.status is ContentStatus.INVALID for item in items
                    ),
                    missing=sum(
                        item.source is summary.source and item.status is ContentStatus.MISSING for item in items
                    ),
                )
                for summary in summaries
            ),
            items,
        )

    async def item_usage(self, *, item_id: str, user_id: str) -> tuple[ContentUsage, ...]:
        """Name what keeps an item from being deleted, without changing anything.

        It answers for exactly the items Delete accepts, so an Included,
        installation-shared or other owner's item is not found. An empty result
        means Delete would not be refused as in use.
        """

        self.require_owner(user_id)
        item = await self._catalog.get_visible_item(item_id=item_id, user_id=user_id)
        if item is None or not ContentAccessPolicy.can_mutate(entry=item, user_id=user_id):
            raise ContentNotFoundError("editable catalog item was not found")
        return await self._catalog.item_usage(item_id=item.id)

    async def delete_item(
        self,
        *,
        item_id: str,
        user_id: str,
        expected_revision: str,
    ) -> None:
        """Delete one exact revision with compensation until catalog commit.

        When a registered file changed on disk, nothing is deleted and the refusal
        is ``catalog_item_changed``. Local is then rescanned in its own
        transaction, so the catalog and a retry see the files as they are now; the
        refusal names the item's revision after that scan.
        """

        self.require_owner(user_id)
        try:
            await self.mutations.run(
                user_id=user_id,
                operation_id=str(uuid4()),
                request_digest=mutation_digest(
                    {"operation": "delete", "item_id": item_id, "revision": expected_revision}
                ),
                result_type=type(None),
                action=lambda: self._delete_item(item_id=item_id, user_id=user_id, expected_revision=expected_revision),
            )
        except ContentConflictError as exc:
            if exc.code != "catalog_item_changed":
                raise
            await self.rescan(user_id=user_id, include_included=False)
            current = await self._catalog.get_visible_item(item_id=item_id, user_id=user_id)
            raise ContentConflictError(
                "catalog_item_changed", current_revision=current.revision_sha256 if current is not None else None
            ) from exc

    async def _delete_item(self, *, item_id: str, user_id: str, expected_revision: str) -> None:
        """Delete one exact unused editable entry, and an Avatar's unused portrait."""

        await self._catalog.lock_source(source=ContentSource.LOCAL)
        item = await self._catalog.get_visible_item(item_id=item_id, user_id=user_id)
        if item is None or not ContentAccessPolicy.can_mutate(entry=item, user_id=user_id):
            raise ContentNotFoundError("editable catalog item was not found")
        portrait_ids = (
            [
                portrait.id
                for portrait in portrait_matches(item, await self._catalog.list_visible(user_id=user_id))
                if ContentAccessPolicy.can_mutate(entry=portrait, user_id=user_id)
            ]
            if item.kind is ContentKind.AVATAR
            else []
        )
        # Lock the item and its portraits in ID order, and hold the locks through
        # deletion, so a concurrent FK-backed Avatar or loadout binding cannot
        # appear after the reference check.
        locked = await self._catalog.get_visible_items(
            item_ids=[item_id, *portrait_ids], user_id=user_id, for_update=True
        )
        item = locked.get(item_id)
        if item is None or not ContentAccessPolicy.can_mutate(entry=item, user_id=user_id):
            raise ContentNotFoundError("editable catalog item was not found")
        if item.revision_sha256 != expected_revision:
            raise ContentConflictError(
                "catalog_revision_conflict",
                current_revision=item.revision_sha256,
            )
        if item.kind is ContentKind.AVATAR:
            await self._catalog.delete_unbound_avatar_mapping(item_id=item.id, user_id=user_id)
        used_by = await self._catalog.item_usage(item_id=item.id)
        if used_by:
            raise ContentConflictError("catalog_item_in_use", used_by=used_by)
        await self._delete_entry(item)
        for portrait_id in portrait_ids:
            # A portrait something else uses stays, as an ordinary Appearance.
            portrait = locked.get(portrait_id)
            if (
                portrait is not None
                and portrait.revision_sha256 is not None
                and portrait_matches(item, [portrait])
                and not await self._catalog.item_usage(item_id=portrait.id, limit=1)
            ):
                await self._delete_entry(portrait)
        await self.rescan(user_id=user_id, include_included=False)

    async def _delete_entry(self, item: CatalogContentEntry) -> None:
        """Remove an entry's registered files, then its catalog identity.

        A ``missing`` entry was absent from the latest scan, so only its catalog
        row goes: bytes the scan did not attribute to it are never removed. A
        registered file that changed, vanished or became a link since the scan
        refuses the delete as ``catalog_item_changed`` before any of the entry's
        files is removed; the failed mutation restores files an earlier entry of
        the same delete removed.
        """

        if item.status is not ContentStatus.MISSING:
            try:
                await asyncio.to_thread(self._store.delete_entry, entry=item)
            except (ContentIntegrityError, ContentPathError) as exc:
                raise ContentConflictError("catalog_item_changed") from exc
        await self._catalog.purge_item(item_id=item.id)

    async def open_registered_file(self, *, file_ref: str, user_id: str) -> VerifiedContentFile:
        """Authorize the opaque registration before resolving and verifying bytes."""

        self.require_owner(user_id)
        registered = await self._catalog.get_visible_file(file_ref=file_ref, user_id=user_id)
        if registered is None:
            raise ContentNotFoundError("registered content file was not found")
        return await self._open_registered(registered)

    async def open_included_file(self, *, file_ref: str, sha256: str, user_id: str) -> VerifiedContentFile:
        """Open an Included registration only while it still has the digest its URL names.

        A digest URL may be kept as immutable, so a file with other bytes, or one that
        is not Included, is not found under it (ADR 0033).
        """

        self.require_owner(user_id)
        registered = await self._catalog.get_visible_file(file_ref=file_ref, user_id=user_id)
        if registered is None or registered.source is not ContentSource.INCLUDED or registered.sha256 != sha256:
            raise ContentNotFoundError("Included content file with this digest was not found")
        return await self._open_registered(registered)

    async def _open_registered(self, registered: CatalogContentFile) -> VerifiedContentFile:
        """Contain and digest-check an authorized registration's bytes off the event loop."""

        return await asyncio.to_thread(
            self._store.open_verified_file,
            source=registered.source,
            source_mount_id=registered.source_mount_id,
            relative_path=registered.relative_path,
            expected_size_bytes=registered.size_bytes,
            expected_sha256=registered.sha256,
            media_type=registered.media_type,
        )

    async def issue_preview_bundle(
        self,
        *,
        anchor: CatalogContentEntry,
        entries: tuple[CatalogContentEntry, ...],
        user_id: str,
        ttl_seconds: int = 300,
    ) -> ContentPreview:
        """Issue one capability from an already resolved caller-visible union."""

        self.require_owner(user_id)
        unique = {entry.id: entry for entry in entries}
        if anchor.id not in unique or any(
            entry.status is not ContentStatus.VALID or entry.revision_sha256 is None for entry in unique.values()
        ):
            raise ContentNotFoundError("previewable content bundle was not found")
        return await self._catalog.create_preview_bundle(
            anchor=anchor,
            entries=tuple(unique[item_id] for item_id in sorted(unique)),
            user_id=user_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=max(1, ttl_seconds)),
        )

    async def open_preview_file(
        self,
        *,
        preview_id: str,
        revision_sha256: str,
        file_ref: str,
        user_id: str,
    ) -> VerifiedContentFile:
        """Open only a file whose exact facts were frozen into this preview."""

        self.require_owner(user_id)
        registered: ContentPreviewFile | None = await self._catalog.get_preview_file(
            preview_id=preview_id,
            revision_sha256=revision_sha256,
            file_ref=file_ref,
            user_id=user_id,
            now=datetime.now(UTC),
        )
        if registered is None:
            raise ContentNotFoundError("preview file was not found")
        return await asyncio.to_thread(
            self._store.open_verified_file,
            source=registered.source,
            source_mount_id=registered.source_mount_id,
            relative_path=registered.relative_path,
            expected_size_bytes=registered.size_bytes,
            expected_sha256=registered.sha256,
            media_type=registered.media_type,
        )

    async def mark_scan_required(self, *, source: ContentSource, relative_paths: tuple[str, ...]) -> None:
        await self._catalog.mark_scan_required(source=source, relative_paths=relative_paths)

    async def invalidate_watched_changes(self, *, source: ContentSource, relative_paths: tuple[str, ...]) -> None:
        """Fence external edits without invalidating a just-admitted creator save.

        Host notifications may arrive after Save has committed the same bytes.
        Reuse the bounded scanner under the publication fence to identify those
        redundant notifications. An unreadable/unknown scan still invalidates;
        only the subsequent ordinary reconciliation can admit changed content.
        """

        async def invalidate() -> None:
            await self._catalog.lock_source(source=source)
            if source is not ContentSource.LOCAL:
                # Included is never written by creator saves. Preserve its
                # unconditional license/mount invalidation semantics.
                await self._catalog.mark_scan_required(source=source, relative_paths=relative_paths)
                return
            try:
                scanned = await asyncio.to_thread(cast(LocalContentStore, self._store).scan, source)
            except Exception:
                # Failure is uncertainty, never permission to keep serving an
                # affected revision. The scheduled rescan reports its failure.
                scanned = None
            await self._catalog.mark_scan_required(source=source, relative_paths=relative_paths, current_scan=scanned)

        try:
            await self.mutations.reconcile(invalidate)
        except Exception:
            # A blocked journal recovery is also unknown filesystem state. Its
            # failed transaction has rolled back; fence affected registrations
            # in a fresh owned transaction without claiming recovery succeeded.
            async with self._catalog.mutation_transaction():
                await self._catalog.lock_source(source=source)
                await self._catalog.mark_scan_required(source=source, relative_paths=relative_paths)


__all__ = ["ContentRescanResult", "ContentCatalogService"]
