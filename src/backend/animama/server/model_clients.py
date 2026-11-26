from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from openai import AsyncOpenAI

from animama.adapters.model_clients import (
    OPENAI_HTTP_PROVIDER_TYPE,
    OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
    AnthropicMessagesModelClient,
    MockModelClient,
    OpenAIChatCompletionsModelClient,
    OpenAIResponsesModelClient,
)
from animama.adapters.model_clients.anthropic_messages.probe import AnthropicClientFactory
from animama.adapters.model_clients.openai_chat_completions.support import resolve_openai_base_url
from animama.adapters.model_clients.openai_responses.chatgpt_plan_client import ChatGPTPlanResponsesModelClient
from animama.app.chat.api_standard import ANTHROPIC_MESSAGES_PROVIDER_TYPE, CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
from animama.app.model_clients import StaticModelClientRegistry
from animama.app.model_clients.credentials import ModelCredentialResolver, StoreModelCredentialResolver
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanTokenSource
from animama.server.config import Settings, settings
from animama.server.runtime_credentials import runtime_credentials

_STATE_ATTR = "model_client_registry"


def _truthy_env(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def build_model_credential_resolver() -> ModelCredentialResolver:
    """Resolve connection keys from the process's runtime credential store."""

    return StoreModelCredentialResolver(runtime_credentials)


def openai_base_url() -> str:
    """Return the built-in OpenAI connection's base URL from the process environment."""

    return resolve_openai_base_url()


def build_model_client_registry(
    *,
    app_settings: Settings = settings,
    openai_client: AsyncOpenAI | None = None,
    credential_resolver: ModelCredentialResolver | None = None,
    anthropic_client_factory: AnthropicClientFactory | None = None,
    chatgpt_plan_session: Callable[[], ChatGPTPlanTokenSource] | None = None,
) -> StaticModelClientRegistry:
    """Build shared model clients for app startup without request-local state.

    Each provider type has its own client and reads only its own connection's
    key; with ``ANIMAMA_LLM_SKIP`` every type uses the deterministic mock.
    ChatGPT plan models get a client only when the composition supplies the
    session (the local composition does; hosted has no plan sign-in).
    ``openai_client`` and ``anthropic_client_factory`` are test hooks.
    """

    registry = StaticModelClientRegistry()
    if _truthy_env(os.getenv("ANIMAMA_LLM_SKIP")):
        mock_client = MockModelClient()
        for provider_type in (
            OPENAI_HTTP_PROVIDER_TYPE,
            OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
            ANTHROPIC_MESSAGES_PROVIDER_TYPE,
            CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE,
        ):
            registry.register(provider_type, mock_client)
        registry.register(MockModelClient.PROVIDER_TYPE, mock_client)
        return registry

    base_url = openai_base_url()
    credentials = credential_resolver or build_model_credential_resolver()
    registry.register(
        OPENAI_HTTP_PROVIDER_TYPE,
        OpenAIChatCompletionsModelClient(
            base_url=base_url,
            credential_resolver=credentials,
            client=openai_client,
            timeout=app_settings.anima_model_client_timeout_seconds,
            close_client=True if openai_client is not None else None,
        ),
    )
    registry.register(
        OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        OpenAIResponsesModelClient(
            credential_resolver=credentials,
            base_url=base_url,
            client=openai_client,
            timeout=app_settings.anima_model_client_timeout_seconds,
            compaction_threshold_tokens=app_settings.anima_openai_responses_compaction_threshold_tokens,
            close_client=False if openai_client is not None else True,
        ),
    )
    registry.register(
        ANTHROPIC_MESSAGES_PROVIDER_TYPE,
        AnthropicMessagesModelClient(
            credential_resolver=credentials,
            timeout=app_settings.anima_model_client_timeout_seconds,
            client_factory=anthropic_client_factory,
        ),
    )
    if chatgpt_plan_session is not None:
        registry.register(
            CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE,
            ChatGPTPlanResponsesModelClient(
                session=chatgpt_plan_session, timeout=app_settings.anima_model_client_timeout_seconds
            ),
        )
    return registry


async def init_model_client_registry(
    app: Any,
    *,
    app_settings: Settings = settings,
    chatgpt_plan_session: Callable[[], ChatGPTPlanTokenSource] | None = None,
) -> StaticModelClientRegistry:
    """Attach the process-wide model-client registry to ``app.state``."""

    registry = build_model_client_registry(app_settings=app_settings, chatgpt_plan_session=chatgpt_plan_session)
    setattr(app.state, _STATE_ATTR, registry)
    return registry


def get_model_client_registry(app: Any) -> StaticModelClientRegistry | None:
    """Return the app-scoped model-client registry when startup has initialized it."""

    registry = getattr(app.state, _STATE_ATTR, None)
    return registry if isinstance(registry, StaticModelClientRegistry) else None


async def close_model_client_registry(app: Any) -> None:
    """Close and detach the app-scoped model-client registry."""

    registry = get_model_client_registry(app)
    if registry is not None:
        await registry.aclose()
    if hasattr(app.state, _STATE_ATTR):
        delattr(app.state, _STATE_ATTR)


__all__ = [
    "build_model_client_registry",
    "build_model_credential_resolver",
    "close_model_client_registry",
    "get_model_client_registry",
    "init_model_client_registry",
    "openai_base_url",
]
