"""Read one issued delivery bundle through the normal snapshot/file authority."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from animama.app.ports.content_store import ContentStore
from animama.app.services.anima_runtime_service import (
    AnimaRuntimeService,
    RuntimeFileAuthorization,
    RuntimeSnapshotError,
)
from animama.domain.content_catalog import ContentIntegrityError, ContentPathError, ContentSource
from animama.domain.runtime_bundles import BINARY_BUNDLE_MAGIC, BundleFormat, RuntimeBundle

CHANGED = "runtime_file_changed_remount_required"


@dataclass(slots=True)
class RuntimeBundleRead:
    """A bundle's members as read, whether every member was read, and members that drifted on disk.

    ``validator`` digests the envelope version, the revision and each member's
    ``file_ref`` and SHA-256. A complete read's members are exactly those bytes, so
    the validator names the encoded body before ``encode`` builds it.
    """

    format: BundleFormat
    envelope: dict[str, Any]
    payloads: list[bytes]
    complete: bool
    validator: str
    changed: dict[ContentSource, list[str]] = field(default_factory=dict)

    def encode(self) -> bytes:
        """The JSON envelope, or the binary frame of the members read.

        ``validator`` does not cover this serialization: bump the envelope version
        whenever the bytes written here change for the same members.
        """

        if self.format == "json":
            return json.dumps(self.envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return binary_bundle_frame(self.envelope, self.payloads)


def binary_bundle_frame(header: dict[str, Any], payloads: list[bytes]) -> bytes:
    """``AMB1``, the header's length (4 bytes, big-endian), the header, then the bytes."""

    encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return b"".join([BINARY_BUNDLE_MAGIC, len(encoded).to_bytes(4, "big"), encoded, *payloads])


class RuntimeBundleService:
    """Transport aggregation only: no new lease, archive, storage identity, or file permission."""

    def __init__(self, runtime: AnimaRuntimeService, store: ContentStore) -> None:
        self.runtime = runtime
        self.store = store

    async def read(self, *, user_id: str, anima_id: str, revision: str, bundle_id: str) -> RuntimeBundleRead:
        # The members issuance stored for this bundle, from a live snapshot of this owner.
        bundle = await self.runtime.get_bundle(
            user_id=user_id, anima_id=anima_id, revision=revision, bundle_id=bundle_id
        )
        # Recheck the live lease, current catalog pins, and ownership in one SQL
        # statement, rather than repeating the individual-file query for each member.
        authorizations = await self.runtime.authorize_files(
            user_id=user_id, anima_id=anima_id, revision=revision, file_refs=bundle.file_refs
        )
        return await asyncio.to_thread(self._read, bundle, revision, authorizations)

    def _read(
        self,
        bundle: RuntimeBundle,
        revision: str,
        authorizations: dict[str, RuntimeFileAuthorization | RuntimeSnapshotError],
    ) -> RuntimeBundleRead:
        """Keep filesystem hashing, bounded reads, and UTF-8 decoding off the event loop."""
        entries: list[dict[str, Any]] = []
        payloads: list[bytes] = []
        changed: dict[ContentSource, list[str]] = defaultdict(list)
        for member in bundle.members:
            ref = member["file_ref"]
            authorization = authorizations[ref]
            raw, error = self._read_member(member, authorization, changed)
            if error is None and bundle.format == "json":
                try:
                    entries.append({"file_ref": ref, "text": raw.decode("utf-8", errors="strict")})
                    continue
                except UnicodeError:
                    assert isinstance(authorization, RuntimeFileAuthorization)
                    changed[authorization.source].append(authorization.relative_path)
                    error = CHANGED
            if error is not None:
                entries.append({"file_ref": ref, "error": error})
            else:
                entries.append({"file_ref": ref, "size": len(raw)})
                payloads.append(raw)
        complete = not any("error" in entry for entry in entries)
        envelope = {"version": 1, "revision": revision, "members": entries}
        named = [envelope["version"], revision, [[member["file_ref"], member["sha256"]] for member in bundle.members]]
        validator = hashlib.sha256(json.dumps(named, separators=(",", ":")).encode("utf-8")).hexdigest()
        return RuntimeBundleRead(
            format=bundle.format,
            envelope=envelope,
            payloads=payloads,
            complete=complete,
            validator=validator,
            changed=dict(changed),
        )

    def _read_member(
        self,
        member: dict[str, Any],
        authorization: RuntimeFileAuthorization | RuntimeSnapshotError,
        changed: dict[ContentSource, list[str]],
    ) -> tuple[bytes, str | None]:
        if isinstance(authorization, RuntimeSnapshotError):
            return b"", authorization.code
        # The snapshot descriptor, not mutable catalog facts alone, remains the
        # exact-byte contract and enforces the selection's size bounds.
        if any(getattr(authorization, key) != member[key] for key in ("size_bytes", "sha256", "media_type", "role")):
            return b"", CHANGED
        try:
            file = self.store.open_verified_file(
                source=authorization.source,
                source_mount_id=authorization.source_mount_id,
                relative_path=authorization.relative_path,
                expected_size_bytes=member["size_bytes"],
                expected_sha256=member["sha256"],
                media_type=member["media_type"],
            )
            with file.handle:
                raw = file.handle.read(member["size_bytes"] + 1)
            # Check the actual read too, including writes after open_verified_file.
            if len(raw) != member["size_bytes"] or hashlib.sha256(raw).hexdigest() != member["sha256"]:
                raise ContentIntegrityError("runtime bundle member changed during read")
        except (ContentIntegrityError, ContentPathError, OSError):
            changed[authorization.source].append(authorization.relative_path)
            return b"", CHANGED
        return raw, None
