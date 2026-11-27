"""Framework-neutral records for the readable self-hosted content library."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, BinaryIO, Literal


class ContentSource(str, Enum):
    """Physical library partition containing a catalog entry."""

    INCLUDED = "included"
    LOCAL = "local"


# A full rescan reconciles, and row-locks, every Included entry before any Local
# entry in one transaction. Any path that locks entries from both sources must
# follow the same order (then entry ID) or it can deadlock against that rescan.
# Such locks must also stay at FOR NO KEY UPDATE; see SQLAlchemyContentCatalog.lock_items.
CONTENT_SOURCE_LOCK_ORDER: tuple[ContentSource, ...] = (ContentSource.INCLUDED, ContentSource.LOCAL)


class ContentScope(str, Enum):
    """Authorization scope attached by the catalog, never inferred from a path."""

    INCLUDED = "included"
    OWNER = "owner"
    INSTALLATION_SHARED = "installation_shared"


class ContentStatus(str, Enum):
    """Current authoritative scan state for one logical entry."""

    VALID = "valid"
    INVALID = "invalid"
    MISSING = "missing"
    SCAN_REQUIRED = "scan_required"


class ContentKind(str, Enum):
    """Readable-library content kinds and their runtime ownership boundaries."""

    AVATAR = "avatar"
    GESTURE = "gesture"
    POSE = "pose"
    POSE_CLIP = "pose_clip"
    REACTION = "reaction"
    PARTICLE_EFFECT = "particle_effect"
    AVATAR_EFFECT = "avatar_effect"
    SCENE_EFFECT = "scene_effect"
    SOUND_EFFECT = "sound_effect"
    MUSIC_TRACK = "music_track"
    APPEARANCE = "appearance"
    VOICE = "voice"
    ANIMA = "anima"


# Pre-launch, Included effects are removed outright once Included content no
# longer uses them. A Local Action that still names a removed one stays valid
# and plays without it: its catalog row carries this diagnostic per removed
# effect, and the edge is reported as a missing dependency, not a member.
MISSING_EFFECT_DEPENDENCY = "missing_effect_dependency"
# Scan provenance naming, by clip alias, the optional edges of a Gesture or
# Reaction that this build omitted (their sounds aren't installed). Only the
# scanner sets it; a descriptor-supplied value is discarded.
OPTIONAL_OMITTED_KEY = "optional_omitted"


def optional_omitted_references(provenance: dict[str, Any]) -> dict[str, str]:
    """Return alias → ref of each optional edge the scanner omitted (``OPTIONAL_OMITTED_KEY``)."""

    omitted = provenance.get(OPTIONAL_OMITTED_KEY)
    if not isinstance(omitted, dict):
        return {}
    return {alias: ref for alias, ref in omitted.items() if isinstance(alias, str) and isinstance(ref, str)}


# Animama no longer provides Twemoji. A Local Scene Effect saved with an
# ``emoji`` marquee or scatter item stays valid and plays without the item; its
# scan reports this diagnostic per item until its creator replaces or removes
# it. Save, package import and Portable export refuse the item by this code.
SCENE_EMOJI_ITEM_REMOVED = "scene_emoji_item_removed"
# Scan diagnostics that leave Local content valid: it plays without the
# removed part and is listed in Content Health. Included content is held to
# the full contract, so the same diagnostic makes an Included entry invalid.
LOCAL_TOLERATED_DIAGNOSTICS = frozenset({SCENE_EMOJI_ITEM_REMOVED})
REMOVABLE_EFFECT_KINDS = frozenset({ContentKind.AVATAR_EFFECT, ContentKind.PARTICLE_EFFECT, ContentKind.SCENE_EFFECT})
ACTION_KINDS = frozenset({ContentKind.GESTURE, ContentKind.REACTION})


@dataclass(frozen=True, slots=True)
class ContentDiagnostic:
    """Safe reason-coded scan result; paths are library-relative only."""

    code: str
    message: str
    relative_path: str | None = None


@dataclass(frozen=True, slots=True)
class ScannedContentFile:
    """One verified regular file discovered beneath Included or Local."""

    relative_path: str
    role: str
    media_type: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class ScannedContentEntry:
    """Filesystem projection ready to reconcile into the SQL catalog."""

    source: ContentSource
    kind: ContentKind
    relative_locator: str
    display_name: str
    status: ContentStatus
    revision_sha256: str | None
    files: tuple[ScannedContentFile, ...] = ()
    descriptor_relative_path: str | None = None
    logical_key: str | None = None
    dependencies: tuple[str, ...] = ()
    provenance: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    diagnostics: tuple[ContentDiagnostic, ...] = ()
    source_mount_id: str | None = None


@dataclass(frozen=True, slots=True)
class CatalogContentFile:
    """Opaque catalog registration for one exact readable-library byte file."""

    file_ref: str
    item_id: str
    source: ContentSource
    relative_path: str
    role: str
    media_type: str
    size_bytes: int
    sha256: str
    source_mount_id: str | None = None


@dataclass(frozen=True, slots=True)
class CatalogContentEntry:
    """Persisted logical catalog item returned to application services."""

    id: str
    source: ContentSource
    scope: ContentScope
    owner_user_id: str | None
    kind: ContentKind
    relative_locator: str
    display_name: str
    status: ContentStatus
    revision_sha256: str | None
    files: tuple[CatalogContentFile, ...]
    logical_key: str | None = None
    dependencies: tuple[str, ...] = ()
    dependency_item_ids: tuple[str, ...] = ()
    # Declared refs of removed Included effects a valid Local Action outlives
    # (``MISSING_EFFECT_DEPENDENCY``); they are not in ``dependencies``.
    missing_dependencies: tuple[str, ...] = ()
    provenance: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    diagnostics: tuple[ContentDiagnostic, ...] = ()
    scanned_at: datetime | None = None
    source_mount_id: str | None = None


@dataclass(slots=True)
class VerifiedContentFile:
    """Verified byte stream owned by the caller until response completion."""

    handle: BinaryIO
    size_bytes: int
    sha256: str
    media_type: str


@dataclass(frozen=True, slots=True)
class ContentScanSummary:
    """Counts from one authoritative source reconciliation."""

    source: ContentSource
    scanned: int
    valid: int
    invalid: int
    missing: int


@dataclass(frozen=True, slots=True)
class SavedContent:
    """Result of one direct creator Save into the ordinary Local library."""

    operation_id: str
    item: CatalogContentEntry


@dataclass(frozen=True, slots=True)
class ContentPreviewFile:
    """Exact file registration frozen for one short-lived preview session."""

    file_ref: str
    source: ContentSource
    relative_path: str
    role: str
    media_type: str
    size_bytes: int
    sha256: str
    source_mount_id: str | None = None


@dataclass(frozen=True, slots=True)
class ContentPreview:
    """Owner-scoped preview of one exact validated catalog revision."""

    id: str
    owner_user_id: str
    item_id: str
    revision_sha256: str
    files: tuple[ContentPreviewFile, ...]
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class PreparedPackageFile:
    """One already-digest-verified package member ready for private staging."""

    relative_path: str
    handle: BinaryIO | None
    size_bytes: int
    source_path: Path | None = None
    # Reopen exactly one verified resource at consumption time. The consumer owns
    # the returned handle; this avoids one open descriptor per archive member.
    open_source: Callable[[], BinaryIO] | None = None


@dataclass(frozen=True, slots=True)
class PreparedPackageEntry:
    """One typed entry in a closure-wide atomic publication."""

    kind: ContentKind
    relative_locator: str
    files: tuple[PreparedPackageFile, ...]


class ContentError(Exception):
    """Base error for readable-library operations."""


class ContentPathError(ContentError):
    """A requested locator escaped or violated the filesystem contract."""


class ContentValidationError(ContentError):
    """Content bytes or a descriptor failed typed validation."""


class ContentIntegrityError(ContentError):
    """Registered bytes no longer match their catalog digest or size."""


class ContentNotFoundError(ContentError):
    """An opaque catalog registration was absent or unavailable."""


ContentUsageKind = Literal[
    "anima_avatar",
    "anima_appearance",
    "anima_voice",
    "anima_gesture",
    "anima_idle",
    "anima_reaction",
    "anima_music",
    "content",
]
# The most uses a usage read or an in-use refusal names.
CONTENT_USAGE_LIMIT = 10


@dataclass(frozen=True, slots=True)
class ContentUsage:
    """One thing that keeps an owned item from being deleted, safe to show its owner.

    An ``anima_*`` kind names the Anima (``id``, ``name``) and what it selects the
    item as: its Avatar, a profile or background Appearance, its voice, an equipped
    Gesture, an Idle pool member, a Reaction cell member or a retired music track.
    ``content`` names the catalog item (``id``, ``name``) that depends on it.
    """

    kind: ContentUsageKind
    id: str
    name: str


class ContentConflictError(ContentError):
    """A direct Save, preview, or Equip precondition no longer holds."""

    def __init__(
        self,
        code: str,
        *,
        current_revision: str | int | None = None,
        field: str | None = None,
        items: tuple[str, ...] = (),
        used_by: tuple[ContentUsage, ...] = (),
    ) -> None:
        super().__init__(code)
        self.code = code
        self.current_revision = current_revision
        self.field = field
        # Display names of the items that caused the conflict, safe to show.
        self.items = items
        # What keeps an item in use (``catalog_item_in_use``).
        self.used_by = used_by


__all__ = [
    "CatalogContentEntry",
    "CatalogContentFile",
    "ContentDiagnostic",
    "ContentError",
    "ContentConflictError",
    "ContentIntegrityError",
    "ContentKind",
    "ContentNotFoundError",
    "ContentPathError",
    "ContentPreview",
    "ContentPreviewFile",
    "ContentScanSummary",
    "ContentScope",
    "ContentSource",
    "ContentStatus",
    "ContentUsage",
    "ContentUsageKind",
    "CONTENT_USAGE_LIMIT",
    "ContentValidationError",
    "ScannedContentEntry",
    "ScannedContentFile",
    "SavedContent",
    "PreparedPackageEntry",
    "PreparedPackageFile",
    "VerifiedContentFile",
]
