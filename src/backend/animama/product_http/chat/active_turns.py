"""The chat turns an app is running, so deleting a chat or an Anima can stop them first (issue #950, D4).

A turn registers once it is admitted, under its owner, chat and Anima, and leaves
when its lease settles. ``stop_turns`` ends the matching turns as a client
disconnect would: their work is cancelled, but a reply save that has begun
finishes. It returns once every one of them has settled. A turn that has not
settled within the bound raises ``ChatTurnStopTimeout``, and the caller deletes
nothing; the client may retry.

The registry lives on ``app.state``, created on first use. It needs no
composition port: it only tracks this process's own streams.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection, Iterator
from typing import Annotated, Any

import anyio
from fastapi import Depends, FastAPI, Request

# How long a delete waits for the turns it stopped to settle.
STOP_TIMEOUT_SECONDS = 10.0
_STATE_ATTR = "active_chat_turns"


class ChatTurnStopTimeout(Exception):
    """A stopped turn did not settle in time; nothing may be deleted yet."""


class ActiveChatTurn:
    """One admitted chat turn, from its admission until its lease settles."""

    def __init__(self, registry: ActiveChatTurns, *, owner_id: str, chat_id: str, anima_id: str) -> None:
        self.owner_id = owner_id
        self.chat_id = chat_id
        self.anima_id = anima_id
        self._registry = registry
        self._stop_requested = False
        self._cancel: Callable[[], None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._settled = asyncio.Event()

    @property
    def stop_requested(self) -> bool:
        return self._stop_requested

    def bind_cancel(self, cancel: Callable[[], None]) -> None:
        """Let a stop cancel the turn's running response; cancels at once if a stop came first."""

        self._cancel = cancel
        if self._stop_requested:
            cancel()

    def track(self, task: asyncio.Task[Any]) -> None:
        """Wait for ``task`` too before the turn counts as stopped.

        The stream's own cleanup gives up after its bound, but a reply save still
        running then must finish before its chat may be deleted.
        """

        self._tasks.add(task)

    def request_stop(self) -> None:
        self._stop_requested = True
        if self._cancel is not None:
            self._cancel()

    def settled(self) -> None:
        """The turn's lease has settled: it leaves the registry and its waiters wake."""

        self._registry.discard(self)
        self._settled.set()

    async def wait_stopped(self) -> None:
        await self._settled.wait()
        running = [task for task in self._tasks if not task.done()]
        if running:
            await asyncio.wait(running)


class ActiveChatTurns:
    """The chat turns this app is running."""

    def __init__(self, *, stop_timeout_seconds: float = STOP_TIMEOUT_SECONDS) -> None:
        self.stop_timeout_seconds = stop_timeout_seconds
        self._turns: set[ActiveChatTurn] = set()

    def __len__(self) -> int:
        return len(self._turns)

    def __iter__(self) -> Iterator[ActiveChatTurn]:
        return iter(tuple(self._turns))

    def register(self, *, owner_id: str, chat_id: str, anima_id: str) -> ActiveChatTurn:
        turn = ActiveChatTurn(self, owner_id=owner_id, chat_id=chat_id, anima_id=anima_id)
        self._turns.add(turn)
        return turn

    def discard(self, turn: ActiveChatTurn) -> None:
        self._turns.discard(turn)

    async def stop_turns(self, *, owner_id: str, chat_ids: Collection[str] = (), anima_id: str | None = None) -> None:
        """Stop the owner's turns in any of ``chat_ids`` or with ``anima_id``, and wait until they settle.

        Raises ``ChatTurnStopTimeout`` when one has not settled within ``stop_timeout_seconds``.
        """

        stopping = [
            turn
            for turn in self._turns
            if turn.owner_id == owner_id and (turn.chat_id in chat_ids or turn.anima_id == anima_id)
        ]
        for turn in stopping:
            turn.request_stop()
        with anyio.move_on_after(self.stop_timeout_seconds) as waiting:
            for turn in stopping:
                await turn.wait_stopped()
        if waiting.cancelled_caught:
            raise ChatTurnStopTimeout


def active_chat_turns(app: FastAPI) -> ActiveChatTurns:
    """The app's turn registry, created on first use."""

    turns = getattr(app.state, _STATE_ATTR, None)
    if not isinstance(turns, ActiveChatTurns):
        turns = ActiveChatTurns()
        setattr(app.state, _STATE_ATTR, turns)
    return turns


async def get_active_chat_turns(request: Request) -> ActiveChatTurns:
    return active_chat_turns(request.app)


ActiveTurns = Annotated[ActiveChatTurns, Depends(get_active_chat_turns)]

__all__ = [
    "STOP_TIMEOUT_SECONDS",
    "ActiveChatTurn",
    "ActiveChatTurns",
    "ActiveTurns",
    "ChatTurnStopTimeout",
    "active_chat_turns",
    "get_active_chat_turns",
]
