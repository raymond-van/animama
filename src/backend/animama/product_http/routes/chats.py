"""Owner-scoped chat history routes shared by every composition (ADR 0021)."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from animama.app.chat.memory_cue import memory_cue_payload, stored_memories_cue
from animama.app.contracts.chat_history import (
    PyChatCreate,
    PyChatMessage,
    PyChatMessagesResponse,
    PyChatResponse,
    PyChatSearchRequest,
    PyChatSearchResponse,
    PyChatSearchResult,
    PyChatUpdate,
    PyMemoryCue,
    PyUsage,
    PyUsageInputDetails,
    PyUsageOutputDetails,
)
from animama.app.ports.memory_episode_port import MemoryEpisodeRepository
from animama.app.services import ChatService
from animama.domain.chat import Chat, ChatMessage, ChatSearchResult
from animama.domain.request_principal import RequestPrincipal
from animama.domain.usage import Usage
from animama.logging import get_logger
from animama.product_http.ports import Ports, ProductRepositories, ReadRepositories, WriteRepositories
from animama.product_http.principal import get_current_principal
from animama.product_http.routes._owner import require_owned_anima

router = APIRouter()
_log = get_logger("product_http.routes.chats")


def _to_schema(chat: Chat, *, last_message_at: datetime | None = None) -> PyChatResponse:
    return PyChatResponse(
        id=chat.id,
        anima_id=chat.anima_id,
        title=chat.title,
        api_standard=chat.api_standard,
        last_model_client=chat.last_model_client,
        last_model_id=chat.last_model_id,
        last_model_provider_id=chat.last_model_provider_id,
        metadata=chat.metadata or {},
        created_at=chat.created_at,
        updated_at=chat.updated_at,
        last_message_at=last_message_at,
        usage=_usage_to_schema(chat.usage),
        active_context_tokens=int(getattr(chat, "active_context_tokens", 0) or 0),
    )


def _usage_to_schema(usage: Usage | None) -> PyUsage | None:
    if usage is None:
        return None
    return PyUsage(
        requests=getattr(usage, "requests", 0) or 0,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
        total_tokens=getattr(usage, "total_tokens", 0) or 0,
        input_tokens_details=PyUsageInputDetails(
            cached_tokens=getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", 0) or 0,
            audio_tokens=getattr(getattr(usage, "input_tokens_details", None), "audio_tokens", 0) or 0,
        ),
        output_tokens_details=PyUsageOutputDetails(
            reasoning_tokens=getattr(getattr(usage, "output_tokens_details", None), "reasoning_tokens", 0) or 0,
            audio_tokens=getattr(getattr(usage, "output_tokens_details", None), "audio_tokens", 0) or 0,
            accepted_prediction_tokens=getattr(
                getattr(usage, "output_tokens_details", None), "accepted_prediction_tokens", 0
            )
            or 0,
            rejected_prediction_tokens=getattr(
                getattr(usage, "output_tokens_details", None), "rejected_prediction_tokens", 0
            )
            or 0,
        ),
    )


def _public_message_data(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if data is None:
        return None
    public_data = dict(data)
    public_data.pop("raw_response", None)
    return public_data


def _public_message_content(message: ChatMessage) -> str | None:
    data = message.data if isinstance(message.data, Mapping) else {}
    structured = data.get("structured")
    if message.role is not None and message.role.value == "assistant" and isinstance(structured, dict):
        display = structured.get("display")
        if isinstance(display, str) and display.strip():
            return display
        speech = structured.get("speech")
        if isinstance(speech, str) and speech.strip():
            return speech
    return message.content


def _is_visible_assistant_message(message: ChatMessage) -> bool:
    return message.role is not None and message.role.value == "assistant" and not message.internal


def _memory_cue(message: ChatMessage, *, episode_text: str | None) -> PyMemoryCue | None:
    """Combine a reply's stored MEMORIES.md change with the episode captured from it."""

    if not _is_visible_assistant_message(message):
        return None
    payload = memory_cue_payload(episode_text=episode_text, memories=stored_memories_cue(message.data))
    return PyMemoryCue.model_validate(payload) if payload is not None else None


async def _episode_texts_by_message_id(
    episodes: MemoryEpisodeRepository,
    *,
    user_id: str,
    messages: list[ChatMessage],
) -> dict[int, str]:
    """Load, in one owner-scoped query, the episode note captured from each assistant reply on the page."""

    message_ids = [
        str(message.id) for message in messages if message.id is not None and _is_visible_assistant_message(message)
    ]
    items = await episodes.list_items_by_source_message_ids(
        user_id=user_id,
        source_message_ids=message_ids,
    )
    texts: dict[int, str] = {}
    for item in items:
        if item.source_message_id is not None and item.source_message_id.isdigit():
            # A turn records at most one note; keep the earliest if several exist.
            texts.setdefault(int(item.source_message_id), item.text)
    return texts


def _message_to_schema(message: ChatMessage, *, episode_text: str | None = None) -> PyChatMessage:
    return PyChatMessage(
        id=message.id,
        chat_id=message.chat_id,
        run_id=message.run_id,
        message_type=message.message_type,
        role=message.role.value if message.role is not None else None,
        content=_public_message_content(message),
        model=message.model,
        model_provider=message.model_provider,
        data=_public_message_data(dict(message.data) if message.data is not None else None),
        usage=_usage_to_schema(message.usage),
        turn=message.turn,
        created_at=message.created_at,
        internal=bool(message.internal),
        memory_cue=_memory_cue(message, episode_text=episode_text),
    )


def _search_result_to_schema(result: ChatSearchResult) -> PyChatSearchResult:
    return PyChatSearchResult(
        message_id=result.message_id,
        chat_id=result.chat_id,
        anima_id=result.anima_id,
        anima_name=result.anima_name,
        anima_profile_picture_url=result.anima_profile_picture_url,
        chat_title=result.chat_title,
        snippet=result.snippet,
        score=result.score,
        turn=result.turn,
        created_at=result.created_at,
    )


def _chat_service(repositories: ProductRepositories) -> ChatService:
    return ChatService(chats=repositories.chats, uow=repositories.unit_of_work)


@router.post("/v1/chats", response_model=PyChatResponse, status_code=status.HTTP_201_CREATED)
async def create_chat(
    req: PyChatCreate,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: WriteRepositories,
) -> PyChatResponse:
    await require_owned_anima(repositories.animas, anima_id=req.anima_id, user_id=user.id)
    chat = await _chat_service(repositories).create(
        anima_id=req.anima_id,
        user_id=user.id,
        title=req.title,
        metadata=req.metadata,
    )
    return _to_schema(chat)


@router.get("/v1/chats", response_model=list[PyChatResponse])
async def list_chats(
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: ReadRepositories,
    include_last_message_at: Annotated[bool, Query()] = False,
) -> list[PyChatResponse]:
    message_repo = repositories.chat_messages if include_last_message_at else None
    chats = await _chat_service(repositories).list_for_user(user_id=user.id)
    if message_repo is None:
        return [_to_schema(chat) for chat in chats]

    out: list[PyChatResponse] = []
    for chat in chats:
        last_message_at: datetime | None = None
        messages = await message_repo.list_by_chat(chat.id, limit=1, offset=0, order="desc")
        if messages:
            last_message_at = messages[0].created_at
        out.append(_to_schema(chat, last_message_at=last_message_at))
    return out


@router.post("/v1/chats/search", response_model=PyChatSearchResponse)
async def search_chat_messages(
    req: PyChatSearchRequest,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: ReadRepositories,
) -> PyChatSearchResponse:
    results = await repositories.chat_messages.search_for_user(
        user_id=user.id,
        query=req.query,
        limit=req.limit + 1,
        offset=req.offset,
    )
    has_more = len(results) > req.limit
    page = results[: req.limit]
    return PyChatSearchResponse(
        query=req.query,
        limit=req.limit,
        offset=req.offset,
        has_more=has_more,
        results=[_search_result_to_schema(result) for result in page],
    )


@router.get("/v1/chats/{chat_id}", response_model=PyChatResponse)
async def get_chat(
    chat_id: str,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: ReadRepositories,
) -> PyChatResponse:
    chat = await _chat_service(repositories).get(chat_id)
    if chat is None or chat.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return _to_schema(chat)


@router.patch("/v1/chats/{chat_id}", response_model=PyChatResponse)
async def update_chat(
    chat_id: str,
    req: PyChatUpdate,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: WriteRepositories,
) -> PyChatResponse:
    chat = await _chat_service(repositories).update(
        chat_id=chat_id,
        user_id=user.id,
        title=req.title,
        metadata=req.metadata,
    )
    if chat is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return _to_schema(chat)


@router.delete(
    "/v1/chats/{chat_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_chat(
    chat_id: str,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: WriteRepositories,
    ports: Ports,
) -> Response:
    # Deleting a chat also deletes the chat images only it uses. (A comment, not a
    # docstring: the docstring is the operation's OpenAPI description.) Read them
    # before the delete: the chat's messages go with it.
    image_ids = await repositories.user_file_processing.image_file_ids_only_in_chat(user_id=user.id, chat_id=chat_id)
    ok = await _chat_service(repositories).delete(chat_id=chat_id, user_id=user.id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    if image_ids:
        await _delete_chat_images(ports, user, repositories, image_ids)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _delete_chat_images(
    ports: Ports, user: RequestPrincipal, repositories: ProductRepositories, image_ids: list[str]
) -> None:
    """Delete images as ``DELETE /v1/files/{file_id}`` would; the chat is already gone.

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


@router.get("/v1/chats/{chat_id}/messages", response_model=PyChatMessagesResponse)
async def list_chat_messages(
    chat_id: str,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    repositories: ReadRepositories,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
    order: Annotated[Literal["asc", "desc"], Query()] = "asc",
    include_internal: Annotated[bool, Query()] = False,
) -> PyChatMessagesResponse:
    chat = await _chat_service(repositories).get(chat_id)
    if chat is None or chat.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    messages = await repositories.chat_messages.list_by_chat(
        chat_id,
        limit=limit,
        offset=offset,
        order="desc" if order == "desc" else "asc",
        include_internal=include_internal,
    )
    episode_texts = await _episode_texts_by_message_id(repositories.memory_episodes, user_id=user.id, messages=messages)
    return PyChatMessagesResponse(
        chat_id=chat_id,
        messages=[
            _message_to_schema(message, episode_text=episode_texts.get(message.id) if message.id is not None else None)
            for message in messages
        ],
    )
