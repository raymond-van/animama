"""Setup of one direct chat turn: the owner's Anima and runtime revision, then the executor.

``resolve_turn_target`` only reads, so a composition can admit the turn after it
and before ``prepare_direct_chat_turn`` writes anything (it may create the chat).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.chat import (
    DirectChatAttachmentContext,
    DirectChatMemoryContextService,
    DirectChatTurnExecutor,
    DirectChatTurnImagesUnsupportedError,
    DirectChatTurnRequest,
    DirectChatTurnSetupError,
    ModelClientNotFoundError,
    PreparedDirectChatTurn,
    RuntimeGestureDescriptor,
)
from animama.app.chat.attached_images import AttachedImageError, validate_attached_images
from animama.app.chat.conversation_language import conversation_language, with_speech_language
from animama.app.chat.memory_search import validate_searchable_attached_files
from animama.app.contracts.chat import PyAnimaChatRequest
from animama.app.model_clients import ModelClientRegistry
from animama.app.services.anima_chat_profile_service import AnimaChatProfileService
from animama.app.services.chat_manager import ChatApiStandardConflictError
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.user_file_overview import deserialize_user_file_overview
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_file import UserFile
from animama.logging import get_logger
from animama.product_http.ports import ChatTurnServices, ProductRepositories

from .compaction import pre_send_compactor
from .options import DirectChatOptions, resolve_chat_request_options
from .safety import TurnSafety, prepare_turn_safety
from .session_services import (
    SessionBackedChatImageLoader,
    SessionBackedChatTurnRecorder,
    SessionBackedMemoryEpisodeRecorder,
    SessionBackedMemoryToolService,
)
from .setup_helpers import TurnSessions, chat_manager

_log = get_logger("product_http.chat.turn_setup")


@dataclass(frozen=True, slots=True)
class TurnTarget:
    """The owner's Anima as a turn starts: its stored mood and the runtime revision it mounted."""

    emotional_state: dict[str, int] | None
    runtime_revision: str
    gesture_ids: tuple[str, ...]
    gesture_descriptors: tuple[RuntimeGestureDescriptor, ...]


@dataclass(slots=True)
class DirectChatTurnSetup:
    """Route-owned state needed by the SSE generator after setup finishes."""

    emotional_state: dict[str, int] | None
    chat_options: DirectChatOptions
    executor: DirectChatTurnExecutor
    prepared_turn: PreparedDirectChatTurn
    safety: TurnSafety


def _attachment_prompt_context(user_file: UserFile, *, chunk_count: int) -> DirectChatAttachmentContext:
    """Convert one validated upload row to safe, provider-neutral prompt data."""

    try:
        overview = deserialize_user_file_overview((user_file.metadata or {}).get("overview"))
    except Exception:
        # Stored JSON is untrusted historical data. A malformed overview must
        # never make an otherwise searchable attachment reject the chat turn.
        overview = None
    if overview is None:
        return DirectChatAttachmentContext(
            filename=user_file.original_filename,
            chunk_count=chunk_count,
        )
    return DirectChatAttachmentContext(
        filename=user_file.original_filename,
        chunk_count=chunk_count,
        description=overview.description,
        outline=overview.outline,
        outline_truncated=overview.outline_truncated,
    )


async def resolve_turn_target(
    repositories: ProductRepositories,
    *,
    anima_id: str,
    req: PyAnimaChatRequest,
    user: RequestPrincipal,
) -> TurnTarget:
    """Check the caller's Anima and its mounted runtime revision; reads only."""

    # Ownership is enforced before any model/provider setup so callers cannot
    # infer chat or model state for another owner's Anima, or an unowned one.
    animas = repositories.animas
    if not await animas.is_owned_by_user(user_id=user.id, anima_id=anima_id):
        raise HTTPException(status_code=404, detail="Anima not found")
    emotional_state = await animas.stored_emotional_state(anima_id)

    # Browser chat mounts an immutable runtime revision before sending. Resolve
    # and fence that exact catalog while the setup session is still open and
    # before provider selection, prompt construction, or model invocation.
    if req.runtime_revision is None:
        raise HTTPException(status_code=409, detail={"code": "runtime_remount_required"})
    snapshot = await repositories.anima_runtime_snapshots.get_snapshot(
        user_id=user.id,
        anima_id=anima_id,
        revision=req.runtime_revision,
    )
    if snapshot is None or snapshot.expires_at <= datetime.now(UTC):
        raise HTTPException(status_code=409, detail={"code": "runtime_remount_required"})
    catalog = snapshot.catalog
    return TurnTarget(
        emotional_state=emotional_state,
        runtime_revision=req.runtime_revision,
        gesture_ids=tuple(str(row["semantic_key"]) for row in catalog.get("gestures", []) if row.get("semantic_key")),
        gesture_descriptors=tuple(
            RuntimeGestureDescriptor(
                selector=str(row["semantic_key"]),
                name=str(row.get("name") or row["semantic_key"]),
                description=str(row.get("description") or row.get("name") or row["semantic_key"]),
            )
            for row in catalog.get("gestures", [])
            if row.get("semantic_key")
        ),
    )


async def prepare_direct_chat_turn(
    *,
    session: AsyncSession,
    repositories: ProductRepositories,
    sessions: TurnSessions,
    services: ChatTurnServices,
    model_client_registry: ModelClientRegistry,
    target: TurnTarget,
    anima_id: str,
    req: PyAnimaChatRequest,
    run_id: str,
    chat_id: str,
    on_recorded: Callable[[], None] | None = None,
) -> DirectChatTurnSetup:
    """Build the app-layer direct chat turn on the setup ``session`` and its ``repositories``.

    Resolves request options, the turn's safety, attachments and collaborators,
    and asks `DirectChatTurnExecutor` to prepare the provider-neutral model
    request before the stream opens. ``on_recorded`` runs once the turn is saved.
    """

    user = sessions.principal
    ports = sessions.ports
    policy = ports.chat_policy

    # Route request options are merged with persisted user/anima settings before
    # reaching app-layer direct chat code.
    request_options = req.dispatch_options.model_dump(exclude_unset=True) if req.dispatch_options else None
    chat_options = DirectChatOptions.from_value(
        await resolve_chat_request_options(
            repositories=repositories,
            user=user,
            anima_id=anima_id,
            request_opts=request_options,
        )
    )
    # The Anima replies and speaks in the UI Locale the client applied (ADR 0024).
    language = conversation_language(req.client_context.ui_locale if req.client_context is not None else None)
    chat_options = with_speech_language(chat_options, language)
    # Companion safety (notice cadence, moderation, crisis resources) never blocks the turn.
    safety = await prepare_turn_safety(
        repositories=repositories,
        user_id=user.id,
        client_context=req.client_context,
        operator=policy.companion_safety,
        crisis_resources=ports.crisis_resources(),
    )
    try:
        attached = await validate_attached_images(
            user_file_processing=repositories.user_file_processing,
            user_id=user.id,
            file_ids=req.attached_file_ids,
        )
    except AttachedImageError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    validated_attachments = await validate_searchable_attached_files(
        user_file_processing=repositories.user_file_processing,
        user_id=user.id,
        file_ids=attached.other_file_ids,
    )
    attached_files = tuple(attachment.user_file for attachment in validated_attachments)
    attached_file_ids = tuple(user_file.id for user_file in attached_files)
    attachment_context = tuple(
        _attachment_prompt_context(
            attachment.user_file,
            chunk_count=attachment.chunk_count,
        )
        for attachment in validated_attachments
    )
    _log.info(
        "Direct chat attached upload validation completed",
        anima_id=anima_id,
        requested_attached_file_count=len(req.attached_file_ids or ()),
        searchable_attached_file_count=len(attached_file_ids),
        attached_image_count=len(attached.images),
    )

    # Only attached uploads are searched during the turn, so the embeddings role
    # is resolved only when files are attached.
    upload_embedder = await services.attachment_embedder(session) if attached_files else None
    # Compaction before the reply has its own registry, so a composition can meter it apart.
    pre_send_registry = services.utility_model_clients("pre_send_compaction")

    executor = DirectChatTurnExecutor(
        registry=model_client_registry,
        profile_service=AnimaChatProfileService(
            profiles=repositories.anima_chat_profiles,
            model_providers=repositories.model_providers,
        ),
        model_providers=repositories.model_providers,
        chat_manager=chat_manager(repositories),
        turn_recorder=SessionBackedChatTurnRecorder(
            sessions, chat_manager_factory=chat_manager, on_recorded=on_recorded
        ),
        memory_episode_recorder=SessionBackedMemoryEpisodeRecorder(sessions),
        memory_context_service=DirectChatMemoryContextService(
            memory_entries=MemoryEntryService(
                memory_entries=repositories.memory_entries,
                uow=repositories.unit_of_work,
                animas=repositories.animas,
                commit_on_write=False,
            ),
            animas=repositories.animas,
            memory_episodes=repositories.memory_episodes,
            user_settings=repositories.user_settings,
        ),
        memory_tool_service=SessionBackedMemoryToolService(
            sessions,
            max_file_bytes=ports.policy.memory_file_max_bytes,
            embedder_factory=lambda: upload_embedder,
            allowed_uploaded_files={user_file.id: user_file.original_filename for user_file in attached_files},
        ),
        pre_send_compactor=(
            pre_send_compactor(
                sessions=sessions,
                model_client_registry=pre_send_registry,
                settings=policy.compaction,
            )
            if policy.compaction.enabled and pre_send_registry is not None
            else None
        ),
        pre_send_compaction_timeout_seconds=policy.presend_compaction_timeout_seconds,
        web_search_tool=await services.web_search_tool(session),
        crisis_moderator=policy.crisis_moderator,
        # Earlier turns' images are replayed too, so the loader is there for every turn.
        image_loader=SessionBackedChatImageLoader(sessions),
    )
    direct_request = DirectChatTurnRequest(
        anima_id=anima_id,
        user_id=user.id,
        chat_id=chat_id,
        run_id=run_id,
        user_message=req.message,
        model_provider_id=req.model_provider_id,
        attached_file_ids=attached_file_ids,
        attached_files=attachment_context,
        attached_images=attached.images,
        request_options=chat_options,
        emotional_state=target.emotional_state,
        runtime_revision=target.runtime_revision,
        runtime_gesture_ids=target.gesture_ids,
        runtime_gesture_descriptors=target.gesture_descriptors,
        provider_moderation=safety.provider_moderation,
        conversation_language=language,
    )
    try:
        # `prepare_turn` resolves the selected model provider, compiles memory
        # context, chooses any Responses continuation cursor, and creates the
        # provider-neutral `ModelClientRequest`.
        prepared_turn = await executor.prepare_turn(direct_request)
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="Chat not found") from exc
    except ChatApiStandardConflictError as exc:
        raise HTTPException(status_code=409, detail=exc.detail) from exc
    except DirectChatTurnImagesUnsupportedError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "message": "The selected model does not accept images."},
        ) from exc
    except DirectChatTurnSetupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ModelClientNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    model_provider = prepared_turn.model_request.model_provider
    _log.info(
        "Direct chat model provider selected",
        anima_id=anima_id,
        model_provider_id=model_provider.id,
        provider_type=model_provider.provider_type,
        model=model_provider.model,
        request_override=req.model_provider_id is not None,
    )
    return DirectChatTurnSetup(
        emotional_state=target.emotional_state,
        chat_options=chat_options,
        executor=executor,
        prepared_turn=prepared_turn,
        safety=safety,
    )


__all__ = ["DirectChatTurnSetup", "TurnTarget", "prepare_direct_chat_turn", "resolve_turn_target"]
