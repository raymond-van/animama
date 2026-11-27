"""Animama repository protocol (Stage 2).

Returns domain objects and does not import persistence frameworks.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from animama.domain.anima import Anima


class AnimaRepository(Protocol):
    """Repository operations for anima aggregates.

    Implementations should ensure persistence side effects are committed via an
    external UnitOfWork.
    """

    async def get(self, anima_id: str) -> Anima | None:
        """Return a anima by id, or None if missing."""

        raise NotImplementedError

    async def is_owned_by_user(self, *, user_id: str, anima_id: str) -> bool:
        """Return whether the anima exists and belongs to the user."""

        raise NotImplementedError

    async def list_owned(self, *, user_id: str) -> list[Anima]:
        """Return the user's Animas, oldest first, without their archives or chats."""

        raise NotImplementedError

    async def list(self, *, ids: Iterable[str] | None = None) -> list[Anima]:
        """Return all animas or a filtered subset by id."""

        raise NotImplementedError

    async def create(self, anima: Anima) -> Anima:
        """Create a new anima and return the stored value."""

        raise NotImplementedError

    async def update(self, anima: Anima) -> Anima:
        """Update an existing anima and return the stored value."""

        raise NotImplementedError

    async def delete(self, anima_id: str) -> bool:
        """Delete the anima with its chats, Anima-scoped memory and last-active setting; returns True if removed.

        Its pending episodes and chat images are the caller's to remove.
        """

        raise NotImplementedError

    async def set_pinned(self, *, user_id: str, anima_id: str, pinned: bool) -> Anima | None:
        """Pin or unpin the owner's Anima, without committing; ``None`` when no such Anima.

        A pin is runtime state: it takes no definition lock and never advances
        ``aggregate_revision``. Pinning keeps an existing pin time, and
        ``updated_at`` stays unchanged.
        """

        raise NotImplementedError

    async def stored_emotional_state(self, anima_id: str) -> dict[str, int] | None:
        """Return the Anima's stored emotional state, normalized, or ``None`` when none is stored."""

        raise NotImplementedError

    async def record_emotional_state(self, *, user_id: str, anima_id: str, emotional_state: dict[str, int]) -> bool:
        """Store the owned Anima's normalized emotional state; return whether it changed."""

        raise NotImplementedError

    async def lock_definition(self, *, user_id: str, anima_id: str, expected_revision: int | None = None) -> Anima:
        """Lock the owned aggregate before any memory/loadout row locks.

        A reviewed loadout digest can provide the optimistic guard instead of
        an explicit revision; other definition writers must supply one.
        """

        raise NotImplementedError

    async def record_definition_revision(
        self,
        *,
        user_id: str,
        anima_id: str,
        expected_revision: int,
        reason: str,
        display_name: str | None = None,
        initial: bool = False,
    ) -> Anima:
        """Append an audit pointer and advance authority, without committing."""

        raise NotImplementedError
