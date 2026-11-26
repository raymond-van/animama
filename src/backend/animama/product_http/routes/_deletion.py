"""What deleting a chat and deleting an Anima share (issue #950): stopping their turns,
removing their pending episodes and deleting the chat images only they use.
"""

from __future__ import annotations

import asyncio
from collections.abc import Collection

from fastapi import HTTPException, status

from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.memory_episode_service import MemoryEpisodeService
from animama.app.services.pending_episode_removal import PendingEpisodeRemoval
from animama.domain.request_principal import RequestPrincipal
from animama.logging import get_logger
from animama.product_http.chat.active_turns import ActiveChatTurns, ChatTurnStopTimeout
from animama.product_http.ports import ProductPorts, ProductRepositories

_log = get_logger("product_http.routes.deletion")


async def stop_turns_before_delete(
    turns: ActiveChatTurns, *, owner_id: str, chat_ids: Collection[str] = (), anima_id: str | None = None
) -> None:
    """Stop the turns of what is about to be deleted, or refuse the delete with a retryable 409.

    A reply save that has begun finishes first, so the delete takes the saved
    reply with it instead of racing it.
    """

    try:
        await turns.stop_turns(owner_id=owner_id, chat_ids=chat_ids, anima_id=anima_id)
    except ChatTurnStopTimeout as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "chat_turn_stopping"}) from exc


def pending_episode_removal(repositories: ProductRepositories) -> PendingEpisodeRemoval:
    """The removal of a deleted chat's or Anima's pending episodes, in the request's transaction."""

    uow = repositories.unit_of_work
    return PendingEpisodeRemoval(
        memory_episodes=repositories.memory_episodes,
        memory_manager=repositories.memory_manager,
        episode_logs=MemoryEpisodeService(
            memory_episodes=repositories.memory_episodes,
            memory_entries=MemoryEntryService(
                memory_entries=repositories.memory_entries, uow=uow, commit_on_write=False
            ),
            uow=uow,
            commit_on_write=False,
        ),
    )


async def delete_chat_images(
    ports: ProductPorts, user: RequestPrincipal, repositories: ProductRepositories, image_ids: list[str]
) -> None:
    """Delete images as ``DELETE /v1/files/{file_id}`` would; their chats are already gone.

    Each image's row is committed with its own outcome, so a failure part way
    leaves the images not yet reached in the Library, where the person can
    delete them. As in ``DELETE /v1/files/{file_id}``, a failure between an
    image's byte delete and its commit leaves that one row ready without bytes.
    """

    try:
        storage = ports.uploads(user).private_files
        user_files = repositories.user_file_processing
        for file_id in image_ids:
            row = await user_files.get_user_file(user_id=user.id, file_id=file_id)
            if row is None:
                continue
            removed = await asyncio.to_thread(storage.delete, row.storage_locator)
            await user_files.record_file_deleted(user_id=user.id, file_id=file_id, object_deleted=removed)
            await repositories.unit_of_work.commit()
    except Exception as exc:
        _log.warning("Chat image cleanup failed", user_id=user.id, image_count=len(image_ids), error=str(exc))


__all__ = ["delete_chat_images", "pending_episode_removal", "stop_turns_before_delete"]
