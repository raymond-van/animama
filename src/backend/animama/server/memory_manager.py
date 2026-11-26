"""The local composition's Memory Manager service (ADR 0021).

The shared Memory Manager routes ask the composition's ports for the owner's
service. Locally each step runs on the runtime of its model row's provider type
(OpenAI Agents or Anthropic), or on the deterministic runtime when
``ANIMAMA_LLM_SKIP`` is set.
"""

from __future__ import annotations

import os
from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.memory_manager import (
    AnthropicMemoryManagerRuntime,
    DeterministicMemoryManagerRuntime,
    MemoryManagerRuntimeSelector,
    OpenAIAgentsMemoryManagerRuntime,
)
from animama.adapters.repositories.sqlalchemy.anima_memory_reflection_repo import (
    SQLAlchemyAnimaMemoryReflectionRepository,
)
from animama.adapters.repositories.sqlalchemy.anima_repo import SQLAlchemyAnimaRepository
from animama.adapters.repositories.sqlalchemy.chat_message_repo import SQLAlchemyChatMessageRepository
from animama.adapters.repositories.sqlalchemy.memory_entry_repo import SQLAlchemyMemoryEntryRepository
from animama.adapters.repositories.sqlalchemy.memory_episode_repo import SQLAlchemyMemoryEpisodeRepository
from animama.adapters.repositories.sqlalchemy.memory_manager_repo import SQLAlchemyMemoryManagerRepository
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.chat.api_standard import CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
from animama.app.model_clients.credentials import connection_for_model_provider
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanTokenSource
from animama.app.ports.memory_manager_runtime import MemoryManagerRuntime
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.memory_episode_service import MemoryEpisodeService
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.app.services.model_role_resolver import ROLE_MEMORY_MANAGER, ModelRoleResolver
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.server.config import Settings
from animama.server.episode_processing import ModelReadiness
from animama.server.model_clients import build_model_credential_resolver, openai_base_url


async def local_memory_manager_service(
    session: AsyncSession,
    user_id: str,
    *,
    roles: ModelRoleResolver,
    runtime_settings: Settings,
    llm_skip: bool | None = None,
    chatgpt_plan_session: Callable[[], ChatGPTPlanTokenSource] | None = None,
) -> MemoryManagerService:
    """Build a request-local manager service with the owner's Memory Manager model.

    ``llm_skip`` selects the deterministic runtime; by default ``ANIMAMA_LLM_SKIP``
    decides on every call. ``chatgpt_plan_session`` lets a ChatGPT plan row run.
    """

    memory_entries = MemoryEntryService(
        memory_entries=SQLAlchemyMemoryEntryRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
        animas=SQLAlchemyAnimaRepository(session),
        max_file_bytes=runtime_settings.anima_memory_file_max_bytes,
        commit_on_write=False,
    )
    uow = SQLAlchemyUnitOfWork(session)
    memory_episode_repository = SQLAlchemyMemoryEpisodeRepository(session)
    anima_repository = SQLAlchemyAnimaRepository(session)
    chat_message_repository = SQLAlchemyChatMessageRepository(session)
    memory_episodes = MemoryEpisodeService(
        memory_episodes=memory_episode_repository,
        memory_entries=memory_entries,
        uow=uow,
        commit_on_write=False,
    )
    if llm_skip is None:
        llm_skip = _truthy_env(os.getenv("ANIMAMA_LLM_SKIP"))
    runtime: MemoryManagerRuntime
    if llm_skip:
        runtime = DeterministicMemoryManagerRuntime(
            user_id=user_id,
            memory_entries=memory_entries,
            memory_episodes=memory_episode_repository,
            animas=anima_repository,
            chat_messages=chat_message_repository,
        )
    else:
        model_providers = SQLAlchemyModelProviderRepository(session)
        credential_resolver = build_model_credential_resolver()
        timeout_seconds = runtime_settings.anima_model_client_timeout_seconds
        # Each step runs on the runtime of its row's provider type; approvals resume on the pinned row's.
        runtime = MemoryManagerRuntimeSelector(
            model_provider=(await roles.resolve(user_id, ROLE_MEMORY_MANAGER)).model_provider,
            model_providers=model_providers,
            openai_agents=lambda row: OpenAIAgentsMemoryManagerRuntime(
                user_id=user_id,
                memory_entries=memory_entries,
                memory_episodes=memory_episode_repository,
                animas=anima_repository,
                chat_messages=chat_message_repository,
                model_provider=row,
                model_providers=model_providers,
                credential_resolver=credential_resolver,
                openai_base_url=openai_base_url(),
                timeout_seconds=timeout_seconds,
                chatgpt_plan_session=chatgpt_plan_session,
            ),
            anthropic=lambda row: AnthropicMemoryManagerRuntime(
                user_id=user_id,
                memory_entries=memory_entries,
                memory_episodes=memory_episode_repository,
                animas=anima_repository,
                chat_messages=chat_message_repository,
                model_provider=row,
                model_providers=model_providers,
                credential_resolver=credential_resolver,
                timeout_seconds=timeout_seconds,
            ),
        )
    return MemoryManagerService(
        memory_manager=SQLAlchemyMemoryManagerRepository(session),
        memory_entries=memory_entries,
        memory_episodes=memory_episodes,
        chat_messages=chat_message_repository,
        anima_reflections=SQLAlchemyAnimaMemoryReflectionRepository(session),
        runtime=runtime,
        uow=uow,
    )


async def local_memory_manager_model_readiness(
    user_id: str,
    *,
    roles: ModelRoleResolver,
    llm_skip: bool | None = None,
    chatgpt_plan_session: Callable[[], ChatGPTPlanSessionService] | None = None,
) -> ModelReadiness:
    """Whether the owner's Memory Manager model may run work that starts by itself, and if not, why.

    A key model needs its key. A ChatGPT plan model needs a usable sign-in, the
    owner's agreement and no usage-limit pause (spec #919 D5, D6); the session
    refuses background tokens on the same rule. The deterministic runtime
    (``ANIMAMA_LLM_SKIP``) needs nothing.
    """

    if llm_skip is None:
        llm_skip = _truthy_env(os.getenv("ANIMAMA_LLM_SKIP"))
    if llm_skip:
        return "usable"
    row = (await roles.resolve(user_id, ROLE_MEMORY_MANAGER)).model_provider
    if row is None:
        return "needs_model"
    if row.provider_type == CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE:
        if chatgpt_plan_session is None:
            return "needs_model"
        try:
            status = await chatgpt_plan_session().status()
        except ChatGPTPlanUnavailableError:
            return "needs_model"
        if status.state != "signed_in" or not status.plan_use_granted:
            # A model is chosen; the plan needs signing in again or plan use turned on.
            return "needs_plan_sign_in"
        if not status.background_agreed:
            return "needs_plan_agreement"
        return "plan_paused" if status.paused else "usable"
    try:
        connection = connection_for_model_provider(row)
    except ValueError:
        return "needs_model"
    return "usable" if build_model_credential_resolver().resolve(connection).usable else "needs_model"


def _truthy_env(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


__all__ = ["local_memory_manager_model_readiness", "local_memory_manager_service"]
