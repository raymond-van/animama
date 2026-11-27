from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .avatar import Avatar


@dataclass(slots=True)
class Anima:
    id: str
    display_name: str = ""
    aggregate_revision: int = 1
    identity_status: str = "repair_required"
    user_id: str | None = None
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    archive_id: str | None = None
    # Avatar relationship
    avatar: Avatar | None = None
    # Optional profile picture URL (e.g., public image path)
    profile_picture_url: str | None = None
    emotional_state: dict[str, int] | None = None
    # Sidebar pin time; None when unpinned. Runtime state outside the definition,
    # changed only through AnimaRepository.set_pinned.
    pinned_at: datetime | None = None


__all__ = ["Anima"]
