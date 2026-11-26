"""Persistence boundary for scanned readable content and opaque file registrations."""

from __future__ import annotations

from collections.abc import Iterable
from contextlib import AbstractAsyncContextManager
from datetime import datetime
from typing import Any, Protocol

from animama.domain.content_catalog import (
    CONTENT_USAGE_LIMIT,
    CatalogContentEntry,
    CatalogContentFile,
    ContentPreview,
    ContentPreviewFile,
    ContentScope,
    ContentSource,
    ContentUsage,
    ScannedContentEntry,
)


class ContentCatalog(Protocol):
    """Publish verified projections and enforce catalog visibility.

    An account adapter declares owner_id. All locator/logical-key lookups,
    uniqueness, source/save locks, reconciliation, receipts and invalidation are
    scoped to that bound identity even when a method has no user_id argument.
    Shared Included rows remain ownerless and immutable. The local SQL adapter
    intentionally retains its installation-wide uniqueness model; it must not be
    reused as an account catalog merely by prefixing storage keys.
    """

    def mutation_transaction(self) -> AbstractAsyncContextManager[None]:
        """Fence Local mutations and commit once, including durable success receipts.

        The scope adopts an existing read transaction. Catalog writes within it
        flush without committing; every failed scope aborts the entire mutation.
        Nested scopes and adapters sharing a session share the outer transaction.
        """

        raise NotImplementedError

    async def get_mutation_receipt(self, *, user_id: str, operation_id: str) -> dict[str, Any] | None:
        """Read original success facts independently of current content existence.

        Returns ``request_digest`` and a detached JSON ``result``, or None. The
        owner/operation pair remains reserved after later edits or deletion.
        """

        raise NotImplementedError

    async def record_mutation_receipt(
        self, *, user_id: str, operation_id: str, request_digest: str, result: dict[str, Any]
    ) -> None:
        """Record immutable success within an active mutation transaction.

        Repeating an existing digest preserves its original result; a different
        digest raises ``operation_id_reused``. No result is visible before commit.
        """

        raise NotImplementedError

    async def lock_source(self, *, source: ContentSource) -> None:
        """Coordinate a scan with file promotion/owner admission in one transaction."""

        raise NotImplementedError

    async def lock_items(self, *, user_id: str, item_ids: tuple[str, ...]) -> None:
        """Fence the visible subset of an exact catalog set without committing."""

        raise NotImplementedError

    async def lock_save(self, *, relative_locator: str, owner_digest: str | None = None) -> None:
        """Fence a Local destination and optional owner-scoped identical-byte key."""

        raise NotImplementedError

    async def item_has_live_animas(self, *, item_id: str) -> bool:
        raise NotImplementedError

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
        raise NotImplementedError

    async def list_visible(self, *, user_id: str) -> list[CatalogContentEntry]:
        raise NotImplementedError

    async def included_generation(self) -> str:
        """Name the current state of the listed Included rows, the same for every owner.

        The value must change whenever any of those rows, their files or dependency
        edges change, and with every application release, since a release may
        project any visible row differently. A composition whose Included rows are
        fixed for an application revision may return that revision.
        """

        raise NotImplementedError

    async def owned_and_shared_revision(self, *, user_id: str) -> str:
        """Name the current state of the caller's own and installation-shared listed rows.

        The value must change whenever any of those rows, their files or dependency
        edges change; other owners' rows never affect it. Releases are left to
        ``included_generation``.
        """

        raise NotImplementedError

    async def record_transition_failure(self, *, user_id: str, item_id: str, expected_revision: str, code: str) -> None:
        """Retain a safe repair diagnostic until the next authoritative rescan."""

        raise NotImplementedError

    async def get_visible_item(
        self,
        *,
        item_id: str,
        user_id: str,
        for_update: bool = False,
    ) -> CatalogContentEntry | None:
        raise NotImplementedError

    async def get_visible_items(
        self,
        *,
        item_ids: Iterable[str],
        user_id: str,
        for_update: bool = False,
    ) -> dict[str, CatalogContentEntry]:
        """The visible items among ``item_ids`` by ID, read (and locked) together."""

        raise NotImplementedError

    async def get_by_locator(
        self,
        *,
        source: ContentSource,
        relative_locator: str,
    ) -> CatalogContentEntry | None:
        raise NotImplementedError

    async def get_by_logical_key(
        self,
        *,
        source: ContentSource,
        logical_key: str,
    ) -> CatalogContentEntry | None:
        """Resolve one unambiguous logical identity, including a missing prior entry."""

        raise NotImplementedError

    async def item_usage(self, *, item_id: str, limit: int = CONTENT_USAGE_LIMIT) -> tuple[ContentUsage, ...]:
        """Name the Animas and items that use it, Anima uses first; empty when nothing does.

        Animas count through their Avatar and their loadout bindings, items through
        dependency edges. At most ``limit`` uses are named.
        """

        raise NotImplementedError

    async def delete_unbound_avatar_mapping(self, *, item_id: str, user_id: str) -> None:
        """Remove the owner's unused logical Avatar for an exact locked catalog item."""

        raise NotImplementedError

    async def purge_item(self, *, item_id: str) -> None:
        """Remove one explicitly deleted catalog identity after its bytes are gone."""

        raise NotImplementedError

    async def assign_creator_owner(self, *, item_id: str, user_id: str) -> CatalogContentEntry:
        """Claim a just-created network-mode item without deriving ownership from its path."""

        raise NotImplementedError

    async def record_import_provenance(
        self,
        *,
        item_id: str,
        user_id: str,
        provenance: dict[str, object],
    ) -> CatalogContentEntry:
        """Attach package-boundary provenance to one visible editable item."""

        raise NotImplementedError

    async def get_visible_file(self, *, file_ref: str, user_id: str) -> CatalogContentFile | None:
        raise NotImplementedError

    async def create_preview(
        self,
        *,
        item: CatalogContentEntry,
        members: tuple[CatalogContentEntry, ...] = (),
        user_id: str,
        expires_at: datetime,
    ) -> ContentPreview:
        raise NotImplementedError

    async def create_preview_bundle(
        self,
        *,
        anchor: CatalogContentEntry,
        entries: tuple[CatalogContentEntry, ...],
        user_id: str,
        expires_at: datetime,
    ) -> ContentPreview:
        """Freeze one deduplicated multi-root capability without rescanning."""

        raise NotImplementedError

    async def get_preview_file(
        self,
        *,
        preview_id: str,
        revision_sha256: str,
        file_ref: str,
        user_id: str,
        now: datetime,
    ) -> ContentPreviewFile | None:
        raise NotImplementedError

    async def mark_scan_required(
        self,
        *,
        source: ContentSource,
        relative_paths: tuple[str, ...],
        current_scan: list[ScannedContentEntry] | None = None,
    ) -> None:
        """Invalidate affected entries; fenced scan evidence may prove a stale notification.

        Omitting evidence always invalidates. Evidence must come from the current
        source scanner while holding the source mutation fence, not a client.
        """

        raise NotImplementedError


__all__ = ["ContentCatalog"]
