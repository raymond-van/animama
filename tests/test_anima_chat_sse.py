from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import AsyncGenerator, Callable, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from functools import cached_property
from pathlib import Path
from types import SimpleNamespace
from typing import Any, TypedDict, cast
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from httpx import ASGITransport, AsyncClient
from openai.types.chat import ChatCompletionFunctionToolParam, ChatCompletionToolUnionParam
from pydantic import ValidationError
from sqlalchemy import select

from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.app.chat.memory_context import ANIMA_MEMORIES_WRITE_GUIDANCE
from animama.app.contracts.gemini import DEFAULT_GEMINI_VOICE
from animama.app.main_structured_response import MAIN_STRUCTURED_RESPONSE_FORMAT, MAIN_STRUCTURED_RESPONSE_KIND
from animama.app.model_clients import (
    ModelClientDelta,
    ModelClientFinal,
    ModelClientProviderError,
    ModelClientRequest,
    ModelClientToolCall,
    StaticModelClientRegistry,
)
from animama.app.model_clients.credential_store import GEMINI_CREDENTIAL_ENV
from animama.app.model_clients.prompt import prompt_last_user_message
from animama.app.safety.ai_notice import AiNoticeState
from animama.app.services.chat_title_generation_service import ChatTitleGenerationSettings
from animama.app.services.direct_model_prompt_runner import DirectModelPromptResult
from animama.domain.anima_chat_profile import AnimaChatProfile
from animama.domain.chat import ChatMessage
from animama.domain.emotions import normalize_emotional_state
from animama.domain.events import EmotionUpdatePayload
from animama.domain.model_provider import ModelProvider, ModelProviderCapabilities
from animama.domain.request_principal import RequestPrincipal
from animama.domain.usage import Usage, UsageInputDetails, UsageOutputDetails
from animama.domain.user_file import STATUS_READY, STATUS_UPLOADED
from animama.orm import (
    ORMAnimaChatProfile,
    ORMChat,
    ORMChatCompaction,
    ORMChatMessage,
    ORMMemoryEntry,
    ORMMemoryEntryVersion,
    ORMModelConnection,
    ORMModelProvider,
)
from animama.orm.anima import ORMAnima
from animama.orm.user_file import ORMUserFile
from animama.orm.user_file_chunk import ORMUserFileChunk
from animama.product_http.chat import (
    compaction as chat_compaction,
    title as chat_title,
    tts as chat_tts,
    turn_setup as chat_turn_setup,
)
from animama.product_http.chat.options import resolve_chat_request_options
from animama.product_http.chat.setup_helpers import chat_manager as product_chat_manager
from animama.product_http.chat.sse_events import SsePreparedTtsSpeechSegment
from animama.product_http.chat.stream import hold_chat_turn
from animama.product_http.ports import install_product_ports
from animama.product_http.routes import chat_turns, chats as chats_router
from animama.product_http.routes.chat_turns import router
from animama.server import elevenlabs_service, gemini_tts_service
from animama.server.config import Settings, settings as app_settings
from animama.server.deps import get_current_principal
from animama.server.product_ports import LocalChatTurnServices, LocalProductPorts
from animama.server.routers import router as api_router
from animama.server.runtime_credentials import runtime_credentials
from animama.server.schemas.chat import PyAnimaChatRequest
from animama.server.schemas.elevenlabs import PyElevenLabsRealtimeTtsSessionResponse


def _function_tool(tool: ChatCompletionToolUnionParam) -> ChatCompletionFunctionToolParam:
    """Require the function-tool variant asserted by these fixtures."""
    assert tool["type"] == "function"
    return tool


def _json_object(value: object) -> dict[str, Any]:
    """Check the JSON object shape before asserting its nested wire payload."""
    assert isinstance(value, dict)
    return value


def _text(value: object) -> str:
    """Require text rather than accepting a different provider payload shape."""
    assert isinstance(value, str)
    return value


class _FakeSession:
    def __init__(
        self,
        *,
        anima_row: object | None = None,
        execute_result: object | None = None,
    ) -> None:
        self.close_calls = 0
        self.flush_calls = 0
        self.commit_calls = 0
        self.execute_calls = 0
        self.anima_row = anima_row or SimpleNamespace(
            id="anima-1",
            name="Anima",
            description=None,
            user_id="user-1",
            metadata_={},
            personality=None,
            emotional_state=None,
        )
        self.execute_result = execute_result

    async def get(self, model, key):
        if model is ORMAnima and key == "anima-1":
            return self.anima_row
        return None

    async def execute(self, _stmt):
        self.execute_calls += 1
        if self.execute_result is not None:
            return self.execute_result
        raise AssertionError("Unexpected execute")

    async def flush(self) -> None:
        self.flush_calls += 1

    async def commit(self) -> None:
        self.commit_calls += 1

    async def close(self) -> None:
        self.close_calls += 1

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        await self.close()


class _FakeSessionFactory:
    def __init__(self, session: _FakeSession, extra_sessions: list[_FakeSession] | None = None) -> None:
        self.session = session
        self.sessions = [session, *(extra_sessions or [])]
        self.created_sessions: list[_FakeSession] = []

    def __call__(self) -> _FakeSession:
        index = len(self.created_sessions)
        if index < len(self.sessions):
            session = self.sessions[index]
        else:
            session = _FakeSession(anima_row=self.session.anima_row)
        self.created_sessions.append(session)
        return session


class _FakeChatManager:
    def __init__(self, *, openai_previous_response_id: str | None = None) -> None:
        self.openai_previous_response_id = openai_previous_response_id
        self.record_turn_calls = 0
        self.record_turn_payloads: list[dict[str, Any]] = []
        self.ensure_chat_calls: list[dict[str, Any]] = []
        self.context_calls: list[dict[str, Any]] = []

    async def ensure_owned_chat(self, **kwargs):  # noqa: ANN001
        self.ensure_chat_calls.append(dict(kwargs))
        return SimpleNamespace(
            id=kwargs.get("chat_id"),
            anima_id=kwargs.get("anima_id"),
            user_id=kwargs.get("user_id"),
            metadata={},
            openai_previous_response_id=self.openai_previous_response_id,
        )

    async def get_chat_context(self, **kwargs):  # noqa: ANN001
        self.context_calls.append(dict(kwargs))
        return SimpleNamespace(messages=[], blocks=[])

    async def prepare_chat_context(self, **kwargs):  # noqa: ANN001
        chat = await self.ensure_owned_chat(**kwargs)
        context = await self.get_chat_context(chat_id=kwargs["chat_id"])
        return chat, context

    async def record_turn(self, **kwargs) -> None:  # noqa: ANN001
        self.record_turn_calls += 1
        self.record_turn_payloads.append(dict(kwargs))


def _direct_structured_response(
    *,
    speech: str = "Hello",
    emotional_tone: str = "neutral",
    emotional_intensity: int = 1,
    display: str | None = None,
    gesture: str = "",
    remember: str | None = None,
) -> str:
    return json.dumps(
        {
            "emotional_tone": emotional_tone,
            "emotional_intensity": emotional_intensity,
            "speech": speech,
            "gesture": gesture,
            "display": display,
            "remember": remember,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


class _RouteModelClient:
    def __init__(
        self,
        *,
        text: str | None = None,
        usage: Usage | None = None,
        fail: bool = False,
        on_stream_start: Any | None = None,
        finals: list[ModelClientFinal] | None = None,
    ) -> None:
        self.text = text or _direct_structured_response()
        self.usage = usage or Usage()
        self.fail = fail
        self.on_stream_start = on_stream_start
        self.finals = list(finals or [])
        self.seen_specs: list[ModelClientRequest] = []
        self.close_calls = 0

    async def stream(self, spec: ModelClientRequest):  # noqa: ANN201
        if self.on_stream_start is not None:
            self.on_stream_start()
        self.seen_specs.append(spec)
        if self.fail:
            raise ModelClientProviderError("provider failed", code="provider_failed")
        scripted_final = self.finals.pop(0) if self.finals else None
        if scripted_final is not None:
            if scripted_final.text:
                yield ModelClientDelta(kind="text_delta", text=scripted_final.text)
            yield ModelClientDelta(kind="final", final=scripted_final)
            yield ModelClientDelta(kind="done")
            return
        yield ModelClientDelta(kind="text_delta", text=self.text)
        yield ModelClientDelta(
            kind="final",
            final=ModelClientFinal(
                text=self.text,
                usage=self.usage,
                raw_provider_metadata={"provider_run_id": spec.prompt.metadata.get("run_id")},
            ),
        )
        yield ModelClientDelta(kind="done")

    async def aclose(self) -> None:
        self.close_calls += 1


class _FakePromptRunner:
    def __init__(
        self,
        *,
        text: str,
        usage: Usage | None = None,
        fail: bool = False,
        started_event: asyncio.Event | None = None,
        release_event: asyncio.Event | None = None,
    ) -> None:
        self.text = text
        self.usage = usage
        self.fail = fail
        self.started_event = started_event
        self.release_event = release_event
        self.calls: list[Any] = []

    async def model_provider_for_role(self, user_id: str, role: str = "utility") -> ModelProvider | None:
        # No window is recorded, so compaction input is not bounded in these tests.
        return None

    async def run_prompt(self, request):
        self.calls.append(request)
        if self.started_event is not None:
            self.started_event.set()
        if self.release_event is not None:
            await self.release_event.wait()
        if self.fail:
            raise RuntimeError("prompt runner failed")
        return DirectModelPromptResult(
            text=self.text,
            usage=self.usage,
            model_provider=ModelProvider(
                id="OpenAIResponsesHTTPAgent:gpt-6-luna",
                provider_type="OpenAIResponsesHTTPAgent",
                model="gpt-6-luna",
                model_label="gpt-6-luna",
                provider_label="OpenAI",
                active=True,
            ),
        )


class _FakeAnimaRepository:
    """The fake session's one Anima row, read and recorded as the Anima repository does."""

    def __init__(self, session: _FakeSession) -> None:
        self._row: Any = session.anima_row

    async def is_owned_by_user(self, *, user_id: str, anima_id: str) -> bool:
        return bool(anima_id == self._row.id and self._row.user_id == user_id)

    async def stored_emotional_state(self, anima_id: str) -> dict[str, int] | None:
        if anima_id != self._row.id or self._row.emotional_state is None:
            return None
        return normalize_emotional_state(self._row.emotional_state)

    async def record_emotional_state(self, *, user_id: str, anima_id: str, emotional_state: dict[str, int]) -> bool:
        if not await self.is_owned_by_user(user_id=user_id, anima_id=anima_id):
            return False
        if normalize_emotional_state(self._row.emotional_state) == emotional_state:
            return False
        self._row.emotional_state = dict(emotional_state)
        return True


_WAVE_CATALOG: dict[str, object] = {
    "gestures": [
        {
            "semantic_key": "wave",
            "name": "Wave",
            "description": "A friendly wave.",
        }
    ]
}


class _FakeRuntimeSnapshots:
    """Every requested runtime revision is mounted with ``catalog`` until five minutes from now."""

    def __init__(self, catalog: Mapping[str, object] | None = None) -> None:
        self.catalog = dict(catalog or _WAVE_CATALOG)

    async def get_snapshot(self, **_kwargs: object) -> object | None:
        return SimpleNamespace(expires_at=datetime.now(UTC) + timedelta(minutes=5), catalog=self.catalog)


class _FakeUserSettings:
    async def get(self, _user_id: str) -> None:
        return None


class _FakeAnimaSettings:
    async def get(self, *, user_id: str, anima_id: str) -> object:
        return SimpleNamespace(preferences={"speech": {"elevenlabs": {"primary_voice": {"voice_id": "voice-primary"}}}})


class _FakeCompanionSafety:
    """No stored notice state, so every turn opens with the day's AI notice."""

    async def lock_ai_notice_state(self, _user_id: str) -> AiNoticeState:
        return AiNoticeState()

    async def save_ai_notice_state(self, _user_id: str, _state: AiNoticeState) -> None:
        return None


class _FakeUnitOfWork:
    def __init__(self, session: _FakeSession) -> None:
        self._session = session

    async def commit(self) -> None:
        await self._session.commit()

    async def flush(self) -> None:
        await self._session.flush()

    async def rollback(self) -> None:
        return None


class _UnexpectedRepository:
    """A repository the fake turn never reads, as the fake session never executes queries."""

    def __init__(self, name: str) -> None:
        self._name = name

    def __getattr__(self, attribute: str) -> Any:
        raise AssertionError(f"Unexpected {self._name}.{attribute}")


class _FakeRepositories:
    """The product repositories over a fake session: its Anima row, one profile and one provider."""

    def __init__(
        self,
        session: _FakeSession,
        *,
        model_provider: ModelProvider,
        runtime_catalog: Mapping[str, object] | None = None,
    ) -> None:
        self.animas = _FakeAnimaRepository(session)
        self.anima_runtime_snapshots = _FakeRuntimeSnapshots(runtime_catalog)
        self.model_providers = _FakeModelProviderRepository(session, model_provider)
        self.anima_chat_profiles = _FakeAnimaChatProfileRepository(
            session,
            AnimaChatProfile(
                anima_id="anima-1",
                default_model_provider_id=model_provider.id,
                metadata={"source": "test"},
            ),
        )
        self.user_settings = _FakeUserSettings()
        self.anima_settings = _FakeAnimaSettings()
        self.companion_safety = _FakeCompanionSafety()
        self.unit_of_work = _FakeUnitOfWork(session)

    def __getattr__(self, name: str) -> Any:
        return _UnexpectedRepository(name)


class _MountedRepositories(SQLAlchemyProductRepositories):
    """The SQLAlchemy repositories, with every runtime revision mounted with the wave gesture."""

    @cached_property
    def anima_runtime_snapshots(self) -> Any:
        return _FakeRuntimeSnapshots()


class _RouteTestPorts(LocalProductPorts):
    """The local ports over the test's repositories, fake or SQLAlchemy."""

    def __init__(self, app: FastAPI, repositories: Callable[[Any], Any]) -> None:
        super().__init__(app)
        self._repositories = repositories

    def repositories(self, session: Any) -> Any:
        return self._repositories(session)


class _FakeModelProviderRepository:
    def __init__(self, _session, provider: ModelProvider | None = None) -> None:
        self.provider = provider or _model_provider()
        self.calls: list[str] = []

    async def get(self, model_provider_id: str) -> ModelProvider | None:
        self.calls.append(model_provider_id)
        return self.provider if self.provider.id == model_provider_id else None


class _FakeAnimaChatProfileRepository:
    def __init__(self, _session, profile: AnimaChatProfile | None = None) -> None:
        self.profile = profile or AnimaChatProfile(
            anima_id="anima-1",
            default_model_provider_id=_model_provider().id,
            metadata={"source": "test"},
        )

    async def get(self, _anima_id: str) -> AnimaChatProfile | None:
        return self.profile


def _model_provider(
    *,
    model_provider_id: str = "OpenAIHTTPAgent:gpt-6-luna",
    provider_type: str = "OpenAIHTTPAgent",
    model: str = "gpt-6-luna",
    active: bool = True,
    supports_streaming: bool = True,
    structured_kinds: list[str] | None = None,
    supports_reasoning: bool | None = True,
    supported_reasoning_efforts: list[str] | None = None,
    supports_tools: bool = True,
    native_tool_support: list[str] | None = None,
) -> ModelProvider:
    return ModelProvider(
        id=model_provider_id,
        provider_type=provider_type,
        model=model,
        model_label=model,
        provider_label=provider_type,
        active=active,
        capabilities=ModelProviderCapabilities(
            supports_streaming=supports_streaming,
            structured_kinds=structured_kinds if structured_kinds is not None else [MAIN_STRUCTURED_RESPONSE_KIND],
            supports_reasoning=supports_reasoning,
            supported_reasoning_efforts=supported_reasoning_efforts
            if supported_reasoning_efforts is not None
            else ["low", "medium", "high"],
            supports_tools=supports_tools,
            native_tool_support=native_tool_support if native_tool_support is not None else ["web_search"],
        ),
    )


# What the next test app serves: set by the install helpers, read by `_route_app`.
def _unconfigured_session_factory() -> None:
    return None


_CURRENT_TEST_REGISTRY: StaticModelClientRegistry | None = None
_CURRENT_SESSION_FACTORY: Callable[[], Any] = _unconfigured_session_factory
_CURRENT_REPOSITORIES: Callable[[Any], Any] = _MountedRepositories
_CURRENT_SETTINGS_UPDATES: dict[str, object] = {}


def _route_app(app: FastAPI | None = None, *, runtime_settings: Settings | None = None) -> FastAPI:
    """An app whose local ports serve the installed model clients, sessions and repositories."""

    app = app or FastAPI()
    app.state.model_client_registry = _CURRENT_TEST_REGISTRY
    app.state.session_factory = _CURRENT_SESSION_FACTORY()
    app.state.runtime_settings = (runtime_settings or app_settings).model_copy(update=_CURRENT_SETTINGS_UPDATES)
    install_product_ports(app, _RouteTestPorts(app, _CURRENT_REPOSITORIES))
    return app


def _test_request(*, runtime_settings: Settings | None = None) -> Request:
    return Request({"type": "http", "app": _route_app(runtime_settings=runtime_settings)})


async def chat_anima_direct_sse(
    anima_id: str, req: PyAnimaChatRequest, *, request: Request, user: RequestPrincipal
) -> StreamingResponse:
    """Call the shared handler as FastAPI does: its turn hold around a write session that closes when it returns."""

    ports = request.app.state.product_ports
    async with asynccontextmanager(hold_chat_turn)() as hold, ports.write_session(user) as session:
        return await chat_turns.chat_anima_direct_sse(anima_id, req, ports, hold, session, user)


def _chat_request(**values: Any) -> PyAnimaChatRequest:
    """Create a chat request against the required frozen typed runtime."""

    values.setdefault("runtime_revision", "tr1-test")
    return PyAnimaChatRequest(**values)


def _install_route_mocks(
    monkeypatch,
    *,
    session: _FakeSession | None = None,
    chat_options: Mapping[str, object] | None = None,
    emotional_state: dict[str, int] | None = None,
    chat_manager: _FakeChatManager | None = None,
    model_client: _RouteModelClient | None = None,
    model_provider: ModelProvider | None = None,
    runtime_catalog: dict[str, object] | None = None,
) -> _FakeSession:
    global _CURRENT_TEST_REGISTRY, _CURRENT_SESSION_FACTORY, _CURRENT_REPOSITORIES, _CURRENT_SETTINGS_UPDATES

    provider = model_provider or _model_provider()
    model_client = model_client or _RouteModelClient()
    _CURRENT_TEST_REGISTRY = StaticModelClientRegistry({provider.provider_type: model_client})
    anima_row = SimpleNamespace(
        id="anima-1",
        name="Anima",
        description=None,
        user_id="user-1",
        metadata_={},
        personality=None,
        emotional_state=emotional_state,
    )
    setup_session = session or _FakeSession(anima_row=anima_row)

    def _session_factory() -> _FakeSessionFactory:
        # Each request's first session is the setup session; later ones are the stream's own.
        return _FakeSessionFactory(setup_session)

    def _repositories(fake_session: _FakeSession) -> _FakeRepositories:
        return _FakeRepositories(fake_session, model_provider=provider, runtime_catalog=runtime_catalog)

    _CURRENT_SESSION_FACTORY = _session_factory
    _CURRENT_REPOSITORIES = _repositories
    _CURRENT_SETTINGS_UPDATES = {}

    async def _fake_resolve_chat_request_options(**_kwargs):
        return chat_options or {}

    monkeypatch.setattr(chat_turn_setup, "resolve_chat_request_options", _fake_resolve_chat_request_options)
    fake_chat_manager = chat_manager or _FakeChatManager()
    monkeypatch.setattr(chat_turn_setup, "chat_manager", lambda *_args, **_kwargs: fake_chat_manager)

    class _MemoryContextService:
        def __init__(self, **_kwargs) -> None:
            pass

        async def build_context(self, **kwargs):  # noqa: ANN003
            return SimpleNamespace(
                anima_identity="Test anima identity.",
                anima_name="Anima",
                manifest={
                    "version": 1,
                    "anima_id": kwargs["anima_id"],
                    "opened_files": [
                        {
                            "anima_id": kwargs["anima_id"],
                            "path": "identity.md",
                            "status": "opened",
                            "version": 1,
                            "sha256": "test-sha",
                            "kind": "anima_identity",
                        }
                    ],
                },
            )

    monkeypatch.setattr(chat_turn_setup, "DirectChatMemoryContextService", _MemoryContextService)
    return setup_session


def _stream_body(response) -> AsyncGenerator[str | bytes, None]:
    """The chat route yields an async generator of SSE text/bytes, never memoryviews."""
    return cast(AsyncGenerator[str | bytes, None], response.body_iterator)


async def _collect_chunks(response) -> list[str]:
    chunks: list[str] = []
    async for chunk in _stream_body(response):
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    return chunks


def _event_data(chunks: list[str], event_name: str) -> dict[str, Any]:
    for chunk in chunks:
        if f"event: {event_name}" not in chunk:
            continue
        for line in chunk.splitlines():
            if line.startswith("data: "):
                data = json.loads(line.removeprefix("data: "))
                assert isinstance(data, dict)
                return data
    raise AssertionError(f"event {event_name!r} not found")


def _event_data_all(chunks: list[str], event_name: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for chunk in chunks:
        if f"event: {event_name}" not in chunk:
            continue
        for line in chunk.splitlines():
            if line.startswith("data: "):
                events.append(json.loads(line.removeprefix("data: ")))
                break
    return events


def _event_count(chunks: list[str], event_name: str) -> int:
    return sum(1 for chunk in chunks if f"event: {event_name}" in chunk)


def _prepared_tts_segment(
    text: str,
    *,
    part_index: int,
    paragraph_index: int = 0,
    paragraph_break_before: bool = False,
) -> SsePreparedTtsSpeechSegment:
    return SsePreparedTtsSpeechSegment(
        visible_text=text,
        tts_text=text.strip(),
        tts_phonemized_text=[["PH"]],
        text_basis="gruut_text_with_ws",
        part_index=part_index,
        part_final=False,
        paragraph_index=paragraph_index,
        paragraph_break_before=paragraph_break_before,
    )


def _install_db_route_mocks(
    monkeypatch,
    session_factory,
    *,
    chat_options: Mapping[str, object] | None = None,
    model_client: _RouteModelClient | None = None,
    default_model_provider_id: str = "OpenAIHTTPAgent:gpt-6-luna",
    patch_profile_service: bool = True,
) -> None:
    global _CURRENT_TEST_REGISTRY, _CURRENT_SESSION_FACTORY, _CURRENT_REPOSITORIES, _CURRENT_SETTINGS_UPDATES

    model_client = model_client or _RouteModelClient()
    _CURRENT_TEST_REGISTRY = StaticModelClientRegistry(
        {
            "OpenAIHTTPAgent": model_client,
            "OpenAIResponsesHTTPAgent": model_client,
        }
    )

    def _session_factory() -> Any:
        return session_factory

    _CURRENT_SESSION_FACTORY = _session_factory
    _CURRENT_REPOSITORIES = _MountedRepositories
    # Title generation is opted into per test with `_install_route_title_mocks`.
    _CURRENT_SETTINGS_UPDATES = {"anima_chat_title_generation_enabled": False}

    async def _fake_resolve_chat_request_options(**_kwargs):
        return chat_options or {}

    monkeypatch.setattr(chat_turn_setup, "resolve_chat_request_options", _fake_resolve_chat_request_options)

    if patch_profile_service:

        class _ProfileService:
            def __init__(self, **_kwargs) -> None:
                pass

            async def resolve_for_anima(self, anima_id: str) -> AnimaChatProfile:
                return AnimaChatProfile(
                    anima_id=anima_id,
                    default_model_provider_id=default_model_provider_id,
                    metadata={"source": "test"},
                )

        monkeypatch.setattr(chat_turn_setup, "AnimaChatProfileService", _ProfileService)


class _ProviderSeedOptions(TypedDict, total=False):
    provider_type: str
    model: str
    provider_label: str
    connection_id: str
    source: str
    context_window_tokens: int | None
    metadata: dict[str, Any] | None
    active: bool
    supports_streaming: bool
    structured_kinds: list[str] | None
    supports_reasoning: bool | None
    supported_reasoning_efforts: list[str] | None
    supports_tools: bool
    native_tool_support: list[str] | None


async def _seed_chat_model_provider(
    async_session,  # noqa: ANN001
    model_provider_id: str,
    *,
    provider_type: str = "OpenAIResponsesHTTPAgent",
    model: str = "gpt-6-luna",
    provider_label: str = "OpenAI",
    connection_id: str = "openai",
    source: str = "builtin",
    context_window_tokens: int | None = 128_000,
    metadata: dict[str, Any] | None = None,
    active: bool = True,
    supports_streaming: bool = True,
    structured_kinds: list[str] | None = None,
    supports_reasoning: bool | None = True,
    supported_reasoning_efforts: list[str] | None = None,
    supports_tools: bool = True,
    native_tool_support: list[str] | None = None,
) -> None:
    existing = await async_session.get(ORMModelProvider, model_provider_id)
    values = {
        "provider_type": provider_type,
        "model": model,
        "model_label": model,
        "provider_label": provider_label,
        "connection_id": connection_id,
        "source": source,
        "context_window_tokens": context_window_tokens,
        "active": active,
        "accepts": ["text"],
        "produces": ["text"],
        "supports_tools": supports_tools,
        "supports_streaming": supports_streaming,
        "structured_kinds": structured_kinds if structured_kinds is not None else [MAIN_STRUCTURED_RESPONSE_KIND],
        "supports_reasoning": supports_reasoning,
        "supported_reasoning_efforts": supported_reasoning_efforts
        if supported_reasoning_efforts is not None
        else ["low", "medium", "high"],
        "native_tool_support": native_tool_support if native_tool_support is not None else ["web_search"],
        "metadata_": metadata or {},
    }
    if existing is None:
        async_session.add(ORMModelProvider(id=model_provider_id, **values))
    else:
        for field_name, value in values.items():
            setattr(existing, field_name, value)
    await async_session.commit()


async def _seed_owner_connection(
    async_session,  # noqa: ANN001
    connection_id: str,
    *,
    preset: str,
    base_url: str,
    name: str,
    credential_env: str | None = None,
) -> None:
    async_session.add(
        ORMModelConnection(
            id=connection_id,
            source="owner",
            name=name,
            preset=preset,
            base_url=base_url,
            credential_env=credential_env,
            compatibility={"fold_developer_role": True, "send_openai_extensions": False},
        )
    )
    await async_session.commit()


async def _seed_default_chat_model_provider(async_session) -> None:  # noqa: ANN001
    await _seed_chat_model_provider(
        async_session,
        "OpenAIHTTPAgent:gpt-6-luna",
        provider_type="OpenAIHTTPAgent",
        model="gpt-6-luna",
    )


async def _seed_uploaded_file_chunk(
    async_session,  # noqa: ANN001
    *,
    file_id: str,
    user_id: str = "user-1",
    status: str = STATUS_READY,
    text: str | list[str] = "Attached file text.",
    original_filename: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    texts = [text] if isinstance(text, str) else text
    total_size = sum(len(chunk_text) for chunk_text in texts)
    async_session.add(
        ORMUserFile(
            id=file_id,
            user_id=user_id,
            storage_locator=f"users/{user_id}/files/{file_id}/object.txt",
            original_filename=original_filename or f"{file_id}.txt",
            normalized_extension=".txt",
            declared_content_type="text/plain",
            declared_size_bytes=max(1, total_size),
            stored_size_bytes=max(1, total_size),
            status=status,
            upload_expires_at=datetime.now(UTC) + timedelta(minutes=10),
            metadata_=metadata or {},
        )
    )
    async_session.add_all(
        [
            ORMUserFileChunk(
                id=f"chunk-{file_id}-{chunk_index:06d}",
                file_id=file_id,
                user_id=user_id,
                chunk_index=chunk_index,
                text=chunk_text,
                embedding=[1.0, 0.0, 0.0],
                char_count=len(chunk_text),
                token_estimate=max(1, len(chunk_text) // 4),
                metadata_={},
            )
            for chunk_index, chunk_text in enumerate(texts)
        ]
    )
    await async_session.commit()


async def _seed_anima_identity_file(async_session, *, anima_id: str, user_id: str = "user-1") -> None:  # noqa: ANN001
    content = f"Identity for {anima_id}."
    async_session.add(
        ORMMemoryEntry(
            id=f"mem-{anima_id}",
            user_id=user_id,
            anima_id=anima_id,
            parent_id=None,
            type="file",
            name="identity.md",
            normalized_name="identity.md",
            path="identity.md",
            normalized_path="identity.md",
            content=content,
            content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            version=1,
            size_bytes=len(content.encode("utf-8")),
            kind="anima_identity",
            metadata_={"anima_id": anima_id, "source": {"type": "test"}},
        )
    )
    await async_session.commit()


async def _seed_anima_memories_file(async_session, *, anima_id: str, content: str) -> str:  # noqa: ANN001
    entry_id = f"mem-memories-{anima_id}"
    async_session.add(
        ORMMemoryEntry(
            id=entry_id,
            user_id="user-1",
            anima_id=anima_id,
            parent_id=None,
            type="file",
            name="MEMORIES.md",
            normalized_name="memories.md",
            path="MEMORIES.md",
            normalized_path="memories.md",
            content=content,
            content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            version=1,
            size_bytes=len(content.encode("utf-8")),
            kind="anima_memories",
            description="Shared history with the user",
            metadata_={},
        )
    )
    await async_session.commit()
    return entry_id


def _self_memories_patch_final() -> ModelClientFinal:
    return ModelClientFinal(
        text="",
        usage=Usage(requests=1, input_tokens=5, output_tokens=1, total_tokens=6),
        tool_calls=(
            ModelClientToolCall(
                id="call-memories",
                name="memory_apply_patch",
                arguments=json.dumps(
                    {
                        "path": "[self]/MEMORIES.md",
                        "replacements": [
                            {
                                "old_text": "We met at the lake.",
                                "new_text": "We met at the lake.\nMira calls me her lake twin.",
                                "replace_all": False,
                            }
                        ],
                        "update_description": False,
                        "description": None,
                    }
                ),
            ),
        ),
    )


async def _seed_user_memory_file(
    async_session,  # noqa: ANN001
    *,
    relative_path: str,
    content: str,
    user_id: str = "user-1",
    description: str | None = None,
) -> None:
    async_session.add(
        ORMMemoryEntry(
            id=f"mem-user-{relative_path.replace('/', '-')}",
            user_id=user_id,
            anima_id=None,
            parent_id=None,
            type="file",
            name=relative_path.rsplit("/", 1)[-1],
            normalized_name=relative_path.rsplit("/", 1)[-1].casefold(),
            path=relative_path,
            normalized_path=relative_path.casefold(),
            content=content,
            content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            version=1,
            size_bytes=len(content.encode("utf-8")),
            kind="user_memory",
            description=description,
            metadata_={"source": {"type": "test"}},
        )
    )
    await async_session.commit()


def _install_route_compaction_mocks(
    monkeypatch,
    *,
    threshold_tokens: int = 1,
    recent_message_min_count: int = 2,
    summary: str = "Compacted continuity summary.",
    usage: Usage | None = None,
    fail: bool = False,
    started_event: asyncio.Event | None = None,
    release_event: asyncio.Event | None = None,
) -> list[_FakePromptRunner]:
    _CURRENT_SETTINGS_UPDATES.update(
        anima_chat_compaction_enabled=True,
        anima_chat_compaction_threshold_tokens=threshold_tokens,
        anima_chat_compaction_recent_message_min_count=recent_message_min_count,
        anima_chat_compaction_prompt_version="chat-compaction-v1-test",
    )
    runners: list[_FakePromptRunner] = []

    def _fake_direct_model_prompt_runner(*_args, **_kwargs):  # noqa: ANN002, ANN003
        runner = _FakePromptRunner(
            text=summary,
            usage=usage,
            fail=fail,
            started_event=started_event,
            release_event=release_event,
        )
        runners.append(runner)
        return runner

    monkeypatch.setattr(chat_compaction, "direct_model_prompt_runner", _fake_direct_model_prompt_runner)
    return runners


def _install_route_title_mocks(
    monkeypatch,
    *,
    title: str = "Generated title",
    usage: Usage | None = None,
    fail: bool = False,
    started_event: asyncio.Event | None = None,
    release_event: asyncio.Event | None = None,
) -> list[_FakePromptRunner]:
    _CURRENT_SETTINGS_UPDATES.update(
        anima_chat_title_generation_enabled=True,
        anima_chat_title_generation_prompt_version="chat-title-v1-test",
        anima_chat_title_generation_max_chars=48,
        anima_chat_title_generation_timeout_seconds=1.0,
        anima_chat_title_generation_reasoning_effort=ChatTitleGenerationSettings().reasoning_effort,
    )
    runners: list[_FakePromptRunner] = []

    def _fake_direct_model_prompt_runner(*_args, **_kwargs):  # noqa: ANN002, ANN003
        runner = _FakePromptRunner(
            text=title,
            usage=usage,
            fail=fail,
            started_event=started_event,
            release_event=release_event,
        )
        runners.append(runner)
        return runner

    monkeypatch.setattr(chat_title, "direct_model_prompt_runner", _fake_direct_model_prompt_runner)
    return runners


def _prompt_runner_call_count(runners: list[_FakePromptRunner]) -> int:
    return sum(len(runner.calls) for runner in runners)


async def _seed_visible_chat_messages(async_session, *, chat_id: str, contents: list[str]) -> list[ORMChatMessage]:
    rows: list[ORMChatMessage] = []
    for index, content in enumerate(contents):
        rows.append(
            ORMChatMessage(
                chat_id=chat_id,
                run_id=f"old-run-{index}",
                message_type="message",
                role="user" if index % 2 == 0 else "assistant",
                content=content,
                message_data={},
                turn=index + 1,
                internal=False,
            )
        )
    async_session.add_all(rows)
    chat = await async_session.get(ORMChat, chat_id)
    if chat is not None:
        chat.next_turn = len(contents) + 1
    await async_session.commit()
    return rows


def test_chat_sse_route_is_mounted_and_dispatch_sse_is_retired() -> None:
    paths = {getattr(route, "path", None) for route in router.routes}
    api_paths = {getattr(route, "path", None) for route in api_router.routes}
    endpoints = {getattr(route, "path", None): getattr(route, "endpoint", None) for route in api_router.routes}
    assert "/v1/animas/{anima_id}/chat:sse" in paths
    assert "/v1/animas/{anima_id}/chat:sse" in api_paths
    assert endpoints["/v1/animas/{anima_id}/chat:sse"] is not None
    assert endpoints["/v1/animas/{anima_id}/chat:sse"].__name__ == "chat_anima_direct_sse"
    assert "/v1/animas/{anima_id}/dispatch:sse" not in paths
    assert "/v1/animas/{anima_id}/dispatch:sse" not in api_paths


def test_anima_gruut_wrapper_accepts_tokenized_text_source(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def _fake_build_gruut_sse_text(text: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"text": text, **kwargs})
        return {"tokenized_text": "Speak this.", "phonemized_text": [["S"]]}

    monkeypatch.setattr(chat_turns, "build_gruut_sse_text", _fake_build_gruut_sse_text)

    assert chat_turns._build_gruut_sse_text(
        "Speak this.",
        lang="en_US",
        tokenized_text_source="text_with_ws",
    ) == {"tokenized_text": "Speak this.", "phonemized_text": [["S"]]}
    assert calls == [
        {
            "text": "Speak this.",
            "lang": "en_US",
            "tokenized_text_source": "text_with_ws",
        }
    ]


def test_anima_chat_request_rejects_blank_message() -> None:
    with pytest.raises(ValidationError):
        _chat_request(message=" \n\t ")
    assert _chat_request(message="  hello  ").message == "hello"


def test_anima_chat_request_requires_runtime_revision() -> None:
    with pytest.raises(ValidationError):
        PyAnimaChatRequest.model_validate({"message": "hello"})


def test_anima_chat_request_accepts_model_provider_id() -> None:
    request = _chat_request(message="hello", model_provider_id="  OpenAIResponsesHTTPAgent:gpt-6-luna  ")

    assert request.model_provider_id == "OpenAIResponsesHTTPAgent:gpt-6-luna"
    with pytest.raises(ValidationError):
        _chat_request(message="hello", model_provider_id=" \n\t ")


def test_anima_chat_request_accepts_chat_id_alias() -> None:
    request = _chat_request(message="hello", chat_id="chat-1")

    assert request.chat_id == "chat-1"


@pytest.mark.asyncio
async def test_chat_sse_refuses_the_removed_eleven_v4_model(monkeypatch) -> None:
    """ElevenLabs speaks only in realtime with v4 Turbo now.

    A request that names the removed ``eleven_v4`` is refused before its turn starts.
    """

    model_client = _RouteModelClient()
    _install_route_mocks(monkeypatch, model_client=model_client)
    app = _route_app()
    app.include_router(router)
    app.dependency_overrides[get_current_principal] = lambda: RequestPrincipal(id="user-1")
    body = _chat_request(message="hello", run_id="run-1", chat_id="chat-1").model_dump()
    body["dispatch_options"] = {"tts": {"enabled": True, "provider": "elevenlabs", "model_id": "eleven_v4"}}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/v1/animas/anima-1/chat:sse", json=body)

    assert response.status_code == 422
    assert {tuple(error["loc"][:4]) for error in response.json()["detail"]} == {
        ("body", "dispatch_options", "tts", "model_id")
    }
    assert model_client.seen_specs == []


@pytest.mark.parametrize(
    ("retired_model_id", "replacement"),
    [
        ("eleven_flash_v2_5", "eleven_v4_turbo"),
        ("eleven_multilingual_v2", "eleven_v4_turbo"),
        ("eleven_v3", "eleven_v4_turbo"),
    ],
)
def test_anima_chat_request_maps_retired_models_to_their_replacement(retired_model_id: str, replacement: str) -> None:
    """A tab opened before the upgrade still sends a retired id; its reply must not be refused."""

    request = _chat_request(
        message="hello",
        dispatch_options={"tts": {"enabled": True, "provider": "elevenlabs", "model_id": retired_model_id}},
    )

    assert request.dispatch_options is not None
    assert request.dispatch_options.tts is not None
    assert request.dispatch_options.tts.model_id == replacement


def test_anima_chat_request_rejects_unknown_elevenlabs_tts_model() -> None:
    with pytest.raises(ValidationError):
        _chat_request(
            message="hello",
            dispatch_options={
                "tts": {
                    "enabled": True,
                    "provider": "elevenlabs",
                    "model_id": "eleven_turbo_v2",
                }
            },
        )


def test_anima_chat_request_rejects_unknown_finalized_tts_chunking() -> None:
    tts = {"enabled": True, "provider": "gemini", "model_id": "gemini-3.8-flash-tts"}
    accepted = _chat_request(message="hello", dispatch_options={"tts": {**tts, "finalized_chunking": "paragraph"}})
    assert accepted.dispatch_options is not None and accepted.dispatch_options.tts is not None
    assert accepted.dispatch_options.tts.finalized_chunking == "paragraph"
    with pytest.raises(ValidationError):
        _chat_request(message="hello", dispatch_options={"tts": {**tts, "finalized_chunking": "chapter"}})


def test_finalized_tts_paragraph_batcher_flushes_at_visible_char_limit() -> None:
    batcher = chat_tts.FinalizedTtsSegmentBatcher("paragraph")
    first = "A" * 350
    second = "B" * 260

    batcher.add_segment(_prepared_tts_segment(first, part_index=0))
    assert batcher.pop_ready() is None

    batcher.add_segment(_prepared_tts_segment(f" {second}", part_index=1))
    batch = batcher.pop_ready()

    assert batch is not None
    assert batch.text == f"{first} {second}"
    assert batch.text_basis == "visible_text"
    assert batcher.pop_ready() is None


def test_finalized_tts_silence_audio_is_400ms_pcm() -> None:
    audio_base64 = chat_tts._finalized_tts_silence_audio_base64(
        duration_sec=chat_tts.FINALIZED_TTS_PARAGRAPH_LEADING_PAUSE_SEC,
        sample_rate=chat_tts.FINALIZED_TTS_PCM_SAMPLE_RATE,
    )
    audio_bytes = base64.b64decode(audio_base64)

    assert len(audio_bytes) == round(
        chat_tts.FINALIZED_TTS_PARAGRAPH_LEADING_PAUSE_SEC * chat_tts.FINALIZED_TTS_PCM_SAMPLE_RATE * 2
    )
    assert set(audio_bytes) == {0}


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership", ["missing", "foreign", "owned"])
async def test_chat_sse_anima_ownership_precedes_runtime_and_provider_setup(monkeypatch, ownership: str) -> None:
    """Exercise the HTTP route with independent row and principal ownership.

    Missing and foreign Animas share the same public error. Rejection must
    happen before runtime/profile/model lookups or transcript side effects;
    the owned control proves the request otherwise reaches a working stream.
    """

    model_client = _RouteModelClient()
    chats = _FakeChatManager()
    session = _install_route_mocks(monkeypatch, model_client=model_client, chat_manager=chats)
    anima_id = "missing-anima" if ownership == "missing" else "anima-1"
    principal = RequestPrincipal(id="other-owner" if ownership == "foreign" else "user-1")
    get_snapshot = AsyncMock(wraps=_FakeRuntimeSnapshots().get_snapshot)
    get_provider = AsyncMock(wraps=_FakeModelProviderRepository(None).get)
    get_profile = AsyncMock(wraps=_FakeAnimaChatProfileRepository(None).get)
    memory_context = Mock(wraps=vars(chat_turn_setup)["DirectChatMemoryContextService"])
    persist_emotions = AsyncMock(return_value=True)
    monkeypatch.setattr(_FakeRuntimeSnapshots, "get_snapshot", lambda _self, **kwargs: get_snapshot(**kwargs))
    monkeypatch.setattr(_FakeModelProviderRepository, "get", lambda _self, key: get_provider(key))
    monkeypatch.setattr(_FakeAnimaChatProfileRepository, "get", lambda _self, key: get_profile(key))
    monkeypatch.setattr(chat_turn_setup, "DirectChatMemoryContextService", memory_context)
    monkeypatch.setattr("animama.product_http.chat.sse_events.persist_emotional_state_update", persist_emotions)

    app = _route_app()
    app.include_router(router)
    app.dependency_overrides[get_current_principal] = lambda: principal
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            f"/v1/animas/{anima_id}/chat:sse",
            json=_chat_request(message="hello", run_id="run-ownership", chat_id="chat-1").model_dump(),
        )

    assert session.close_calls == 1
    if ownership == "owned":
        assert response.status_code == 200
        assert "event: user.response" in response.text
        assert "event: run.completed" in response.text
        get_snapshot.assert_awaited_once_with(user_id="user-1", anima_id="anima-1", revision="tr1-test")
        get_provider.assert_awaited()
        get_profile.assert_awaited_once_with("anima-1")
        memory_context.assert_called_once()
        assert len(model_client.seen_specs) == 1
        assert chats.record_turn_calls == 1
        assert chats.ensure_chat_calls[0]["user_id"] == principal.id
    else:
        assert response.status_code == 404
        assert response.json() == {"detail": "Anima not found"}
        get_snapshot.assert_not_awaited()
        get_provider.assert_not_awaited()
        get_profile.assert_not_awaited()
        memory_context.assert_not_called()
        persist_emotions.assert_not_awaited()
        assert model_client.seen_specs == []
        assert chats.ensure_chat_calls == []
        assert chats.context_calls == []
        assert chats.record_turn_calls == 0
        assert session.execute_calls == session.flush_calls == session.commit_calls == 0


@pytest.mark.asyncio
async def test_chat_sse_success_emits_user_response_and_completed(monkeypatch) -> None:
    model_client = _RouteModelClient()
    session = _install_route_mocks(monkeypatch, model_client=model_client)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: user.response" in chunk for chunk in chunks)
    assert any('"text": "Hello"' in chunk for chunk in chunks)
    assert not any('"tts_text"' in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert _event_count(chunks, "run.completed") == 1
    assert any('"chat_id": "chat-1"' in chunk for chunk in chunks if "event: run.completed" in chunk)
    assert session.close_calls == 1
    assert model_client.close_calls == 0


@pytest.mark.asyncio
async def test_chat_sse_closes_setup_session_before_model_stream(monkeypatch) -> None:
    session = _FakeSession()
    stream_start_close_calls: list[int] = []

    def _capture_setup_session_close_count() -> None:
        stream_start_close_calls.append(session.close_calls)

    model_client = _RouteModelClient(on_stream_start=_capture_setup_session_close_count)
    _install_route_mocks(monkeypatch, session=session, model_client=model_client)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    assert stream_start_close_calls == [1]
    assert session.close_calls == 1


@pytest.mark.asyncio
async def test_chat_sse_uses_chat_id_when_provided(monkeypatch) -> None:
    chats = _FakeChatManager()
    _install_route_mocks(monkeypatch, chat_manager=chats)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert chats.ensure_chat_calls[0]["chat_id"] == "chat-1"
    assert chats.context_calls[0]["chat_id"] == "chat-1"
    assert any('"chat_id": "chat-1"' in chunk for chunk in chunks if "event: run.completed" in chunk)


@pytest.mark.asyncio
async def test_chat_sse_emits_tts_session_for_elevenlabs_intent(monkeypatch) -> None:
    session = _install_route_mocks(
        monkeypatch,
        chat_options={
            "tts": {
                "enabled": True,
                "provider": "elevenlabs",
                "transport": "auto",
                "language_code": "en",
                "model_id": "eleven_v4_turbo",
            }
        },
    )
    calls: list[dict[str, Any]] = []

    async def _fake_resolve_realtime_tts_session(**kwargs):
        calls.append(kwargs)
        return PyElevenLabsRealtimeTtsSessionResponse(
            voice_id="voice-primary",
            model_id="eleven_v4_turbo",
            output_format="pcm_24000",
            sync_alignment=True,
            language_code="en",
            token="sutkn-chat",
            websocket_base_url="wss://api.elevenlabs.io",
        )

    monkeypatch.setattr(elevenlabs_service, "resolve_realtime_tts_session", _fake_resolve_realtime_tts_session)

    request = _test_request()
    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=request,
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    tts_index = next(index for index, chunk in enumerate(chunks) if "event: tts.session" in chunk)
    completed_index = next(index for index, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    assert tts_index < completed_index
    assert any("event: user.response" in chunk for chunk in chunks)
    assert '"type": "tts.session"' in chunks[tts_index]
    assert '"provider": "elevenlabs"' in chunks[tts_index]
    assert '"transport": "direct"' in chunks[tts_index]
    assert '"model_id": "eleven_v4_turbo"' in chunks[tts_index]
    assert '"token": "sutkn-chat"' in chunks[tts_index]
    call = dict(calls[0])
    voice = call.pop("voice")
    assert call == {"language_code": "en", "model_id": "eleven_v4_turbo"}
    # The speech port resolves the owner's Anima's voice in a session of its own.
    assert (await voice()).voice_id == "voice-primary"
    voice_session = request.app.state.session_factory.created_sessions[-1]
    assert voice_session is not session
    assert voice_session.close_calls == 1


@pytest.mark.asyncio
async def test_chat_sse_streams_user_response_while_tts_session_pending(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={
            "tts": {
                "enabled": True,
                "provider": "elevenlabs",
                "transport": "auto",
            }
        },
    )
    release_tts_session = asyncio.Event()

    async def _fake_resolve_realtime_tts_session(**_kwargs):
        await release_tts_session.wait()
        return PyElevenLabsRealtimeTtsSessionResponse(
            voice_id="voice-primary",
            model_id="eleven_v4_turbo",
            output_format="pcm_24000",
            sync_alignment=True,
            token="sutkn-chat",
            websocket_base_url="wss://api.elevenlabs.io",
        )

    monkeypatch.setattr(elevenlabs_service, "resolve_realtime_tts_session", _fake_resolve_realtime_tts_session)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )

    chunks: list[str] = []
    body_iterator = _stream_body(response)
    while True:
        raw_chunk = await asyncio.wait_for(anext(body_iterator), timeout=1.0)
        chunk = raw_chunk.decode() if isinstance(raw_chunk, bytes) else raw_chunk
        chunks.append(chunk)
        if "event: user.response" in chunk:
            break

    assert not any("event: tts.session" in chunk for chunk in chunks)

    release_tts_session.set()
    while True:
        try:
            raw_chunk = await asyncio.wait_for(anext(body_iterator), timeout=1.0)
        except StopAsyncIteration:
            break
        chunk = raw_chunk.decode() if isinstance(raw_chunk, bytes) else raw_chunk
        chunks.append(chunk)

    user_index = next(index for index, chunk in enumerate(chunks) if "event: user.response" in chunk)
    tts_index = next(index for index, chunk in enumerate(chunks) if "event: tts.session" in chunk)
    completed_index = next(index for index, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    assert user_index < tts_index < completed_index


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tts_options",
    [
        None,
        {"enabled": False, "provider": "elevenlabs"},
        {"enabled": True, "provider": "browser"},
        {"enabled": True, "provider": "pocket_tts"},
    ],
)
async def test_chat_sse_does_not_resolve_tts_session_without_elevenlabs_intent(
    monkeypatch,
    tts_options: dict[str, object] | None,
) -> None:
    chat_options = {"tts": tts_options} if tts_options is not None else {}
    _install_route_mocks(monkeypatch, chat_options=chat_options)

    async def _unexpected_resolve_realtime_tts_session(**_kwargs):
        raise AssertionError("TTS session resolution should not be called")

    monkeypatch.setattr(elevenlabs_service, "resolve_realtime_tts_session", _unexpected_resolve_realtime_tts_session)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert not any("event: tts.session" in chunk for chunk in chunks)
    assert any("event: user.response" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_speaks_a_retired_eleven_v3_request_in_realtime(monkeypatch) -> None:
    """A tab opened before the upgrade still asks for Eleven v3; its reply speaks in realtime with v4 Turbo."""

    _install_route_mocks(monkeypatch)
    # The request's own speech options reach the turn, as they do outside these tests.
    monkeypatch.setattr(chat_turn_setup, "resolve_chat_request_options", resolve_chat_request_options)
    calls: list[dict[str, Any]] = []

    async def _fake_resolve_realtime_tts_session(**kwargs):
        calls.append(kwargs)
        return PyElevenLabsRealtimeTtsSessionResponse(
            voice_id="voice-primary",
            model_id=kwargs["model_id"],
            output_format="pcm_24000",
            sync_alignment=True,
            token="sutkn-chat",
            websocket_base_url="wss://api.elevenlabs.io",
        )

    monkeypatch.setattr(elevenlabs_service, "resolve_realtime_tts_session", _fake_resolve_realtime_tts_session)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-1",
            chat_id="chat-1",
            dispatch_options={"tts": {"enabled": True, "provider": "elevenlabs", "model_id": "eleven_v3"}},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert [call["model_id"] for call in calls] == ["eleven_v4_turbo"]
    assert _event_data(chunks, "tts.session")["model_id"] == "eleven_v4_turbo"
    # No audio is pushed in the reply's stream for it.
    assert [_event_count(chunks, name) for name in ("tts.audio", "tts.done", "tts.error")] == [0, 0, 0]
    assert _event_count(chunks, "run.completed") == 1


@pytest.mark.asyncio
async def test_chat_sse_tts_session_error_continues_chat_stream(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={"tts": {"enabled": True, "provider": "elevenlabs"}},
    )

    async def _fail_resolve_realtime_tts_session(**_kwargs):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_missing", "message": "Anima voice is missing"},
        )

    monkeypatch.setattr(elevenlabs_service, "resolve_realtime_tts_session", _fail_resolve_realtime_tts_session)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    error_index = next(index for index, chunk in enumerate(chunks) if "event: tts.session.error" in chunk)
    completed_index = next(index for index, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    assert error_index < completed_index
    assert '"type": "tts.session.error"' in chunks[error_index]
    assert '"code": "voice_missing"' in chunks[error_index]
    assert '"status_code": 409' in chunks[error_index]
    assert any("event: user.response" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_does_not_call_graph_runtime_or_runner_registry(monkeypatch) -> None:
    model_client = _RouteModelClient()
    _install_route_mocks(monkeypatch, model_client=model_client)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    await _collect_chunks(response)
    assert len(model_client.seen_specs) == 1
    assert prompt_last_user_message(model_client.seen_specs[0].prompt, fallback="") == "hello"


def test_direct_chat_production_code_has_no_graph_runtime_imports() -> None:
    root = Path(__file__).resolve().parents[1]
    checked_paths = [
        root / "src/backend/animama/product_http/chat/stream.py",
        root / "src/backend/animama/product_http/routes/chat_turns.py",
    ]
    forbidden = (
        "from animama.app.runtime.runtime import AnimaRuntime",
        "make_runner_registry_for_graph",
        "stream_stateless_dispatch_sse",
        "resolve_direct_chat_runtime_config",
        "build_direct_chat_agents_for_config",
        "AgentRunner",
    )
    offenders: list[str] = []

    for path in checked_paths:
        text = path.read_text(encoding="utf-8")
        hits = [token for token in forbidden if token in text]
        if hits:
            offenders.append(f"{path.relative_to(root)}: {', '.join(hits)}")

    assert not offenders


@pytest.mark.asyncio
async def test_chat_sse_chat_options_flow_into_runtime_context(monkeypatch) -> None:
    model_client = _RouteModelClient()
    _install_route_mocks(
        monkeypatch,
        chat_options={
            "disable_emotion_updates": True,
            "disable_memory_influence": True,
            "disable_memory_updates": True,
            "main_structured_response": True,
            "native_tools": ["web_search"],
            "reasoning_effort": "low",
        },
        model_client=model_client,
        model_provider=_model_provider(
            model_provider_id="OpenAIResponsesHTTPAgent:gpt-6-luna",
            provider_type="OpenAIResponsesHTTPAgent",
        ),
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    await _collect_chunks(response)

    model_request = model_client.seen_specs[0]
    assert model_request.provider_options["native_tools"] == ("web_search",) or model_request.provider_options[
        "native_tools"
    ] == ["web_search"]
    assert model_request.prompt.reasoning_effort == "low"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response_part", "expected_gruut_call_count"),
    [
        ("speech", 1),
        ("display", 1),
    ],
)
async def test_chat_sse_main_structured_gruut_behavior(
    monkeypatch,
    response_part: str,
    expected_gruut_call_count: int,
) -> None:
    display = "Display this." if response_part == "display" else None
    model_client = _RouteModelClient(text=_direct_structured_response(speech="Speak this.", display=display))
    _install_route_mocks(
        monkeypatch,
        chat_options={"main_structured_response": True},
        model_client=model_client,
    )
    gruut_calls: list[dict[str, Any]] = []

    def _fake_gruut(final_text, lang="en_US", **kwargs):
        gruut_calls.append({"text": final_text, "lang": lang, **kwargs})
        return {"tokenized_text": final_text, "phonemized_text": [["S"], ["DH"]]}

    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", _fake_gruut)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-1",
            chat_id="chat-1",
            dispatch_options={"main_structured_response": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any('"response_format": "main_structured_json"' in chunk for chunk in chunks)
    assert any('"response_part": "speech"' in chunk for chunk in chunks)
    if display:
        assert any('"response_part": "display"' in chunk for chunk in chunks)
        assert any('"text": "Display this."' in chunk for chunk in chunks)
    assert len(gruut_calls) == expected_gruut_call_count
    assert gruut_calls == [
        {"text": "Speak this.", "lang": "en_US"},
    ]
    assert any('"tokenized_text": "Speak this."' in chunk for chunk in chunks)
    assert not any('"tokenized_text": "Display this."' in chunk for chunk in chunks)
    assert not any('"tts_text"' in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_main_structured_emotional_tone_is_internal(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={"main_structured_response": True},
        model_client=_RouteModelClient(text=_direct_structured_response(speech="Speak this.", emotional_tone="joy")),
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-1",
            chat_id="chat-1",
            dispatch_options={"main_structured_response": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any('"response_part": "speech"' in chunk for chunk in chunks)
    assert any('"text": "Speak this."' in chunk for chunk in chunks)
    assert not any('"response_part": "emotional_tone"' in chunk for chunk in chunks)
    assert not any('"text": "joy"' in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_primary_structured_uses_main_structured_sse_behavior(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={"disable_emotion_updates": True},
        model_client=_RouteModelClient(text=_direct_structured_response(speech="Speak this.", emotional_tone="joy")),
    )
    gruut_calls: list[dict[str, Any]] = []

    def _fake_gruut(final_text, lang="en_US", **kwargs):
        gruut_calls.append({"text": final_text, "lang": lang, **kwargs})
        return {"tokenized_text": final_text, "phonemized_text": [["S"], ["DH"]]}

    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", _fake_gruut)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any(f'"response_format": "{MAIN_STRUCTURED_RESPONSE_FORMAT}"' in chunk for chunk in chunks)
    assert any('"response_part": "speech"' in chunk for chunk in chunks)
    assert any('"text": "Speak this."' in chunk for chunk in chunks)
    assert not any('"response_part": "emotional_tone"' in chunk for chunk in chunks)
    assert not any('"text": "joy"' in chunk for chunk in chunks)
    assert gruut_calls == [{"text": "Speak this.", "lang": "en_US"}]
    assert any('"tokenized_text": "Speak this."' in chunk for chunk in chunks)


_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts"


def _gemini_tts_options(**values: object) -> dict[str, object]:
    """Gemini speech, the only voice pushed in the reply's stream; ``values`` adds e.g. ``finalized_chunking``."""

    return {"enabled": True, "provider": "gemini", "model_id": _GEMINI_TTS_MODEL, **values}


def _gemini_tts_route_mocks(
    monkeypatch, *, speech: str = "First sentence. Second sentence.", **tts_values: object
) -> None:
    """A joyful structured reply of ``speech`` that asks for Gemini speech; gruut keeps its text."""

    _install_route_mocks(
        monkeypatch,
        chat_options={
            "main_structured_response": True,
            "disable_emotion_updates": True,
            "tts": _gemini_tts_options(**tts_values),
        },
        emotional_state={"joy": 16},
        model_client=_RouteModelClient(text=_direct_structured_response(speech=speech, emotional_tone="joy")),
    )

    def _fake_gruut(final_text, lang="en_US", **kwargs):
        del lang, kwargs
        return {"tokenized_text": " ".join(final_text.split()), "phonemized_text": [["S"], ["DH"]]}

    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", _fake_gruut)

    # An attempt would surface as a ``tts.session.error`` frame, never as a provider call.
    async def _unexpected_elevenlabs(**_kwargs):
        raise AssertionError("a Gemini reply must not open an ElevenLabs session")

    monkeypatch.setattr(elevenlabs_service, "resolve_realtime_tts_session", _unexpected_elevenlabs)


def _gemini_tts_request(**tts_values: object) -> PyAnimaChatRequest:
    return _chat_request(
        message="hello",
        run_id="run-1",
        chat_id="chat-1",
        dispatch_options={"main_structured_response": True, "tts": _gemini_tts_options(**tts_values)},
    )


def _install_gemini_speech(
    monkeypatch, *, audio: Callable[[Any], str] = lambda _prepared: "AAAA"
) -> list[dict[str, Any]]:
    """Fake Gemini at its service: each prepared segment streams one ``audio(prepared)`` frame, then done.

    Returns each segment's preparation arguments, in order.
    """

    prepared_calls: list[dict[str, Any]] = []

    async def _fake_prepare(**kwargs):
        prepared_calls.append(kwargs)
        return SimpleNamespace(
            model_id=kwargs["model_id"], output_format="pcm_24000", text=kwargs["text"], voice_id=kwargs["voice_id"]
        )

    async def _fake_stream(prepared):
        frame = {"run_id": "run-1", "model_id": prepared.model_id, "output_format": "pcm_24000"}
        yield {"type": "audio", "audio_base64": audio(prepared), **frame}
        yield {"type": "done", **frame}

    monkeypatch.setattr(gemini_tts_service, "prepare_gemini_finalized_speech", _fake_prepare)
    monkeypatch.setattr(gemini_tts_service, "stream_gemini_finalized_speech", _fake_stream)
    return prepared_calls


@pytest.mark.asyncio
async def test_chat_sse_plain_text_fallback_is_spoken_with_neutral_tone(monkeypatch) -> None:
    # Both the reply and its one repair are plain text, so the turn falls back
    # to a neutral plain-text reply that still reaches finalized TTS.
    plain = [ModelClientFinal(text="Just words.", usage=Usage()) for _ in range(2)]
    model_client = _RouteModelClient(finals=plain)
    _install_route_mocks(
        monkeypatch,
        chat_options={"main_structured_response": True, "tts": _gemini_tts_options()},
        model_client=model_client,
    )
    monkeypatch.setattr(
        "animama.product_http.routes.chat_turns._build_gruut_sse_text",
        lambda final_text, lang="en_US", **kwargs: {"tokenized_text": final_text, "phonemized_text": [["S"]]},
    )
    # Gemini's own preparation builds the style it would send; only its stream is faked.
    monkeypatch.setattr(runtime_credentials, "current", lambda: {GEMINI_CREDENTIAL_ENV: "gemini-key-for-tests"})
    prepare_gemini = gemini_tts_service.prepare_gemini_finalized_speech
    prepared_speech: list[tuple[str | None, Any]] = []

    async def _prepare_and_record(**kwargs):
        prepared = await prepare_gemini(**kwargs)
        prepared_speech.append((kwargs["emotional_tone"], prepared))
        return prepared

    async def _fake_stream(prepared):
        frame = {"run_id": "run-1", "model_id": prepared.model_id, "output_format": "pcm_24000"}
        yield {"type": "audio", "audio_base64": "AQACAA==", **frame}
        yield {"type": "done", **frame}

    monkeypatch.setattr(gemini_tts_service, "prepare_gemini_finalized_speech", _prepare_and_record)
    monkeypatch.setattr(gemini_tts_service, "stream_gemini_finalized_speech", _fake_stream)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-1",
            chat_id="chat-1",
            dispatch_options={"main_structured_response": True, "tts": _gemini_tts_options()},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert len(model_client.seen_specs) == 2
    assert not any("event: error" in chunk for chunk in chunks)
    assert not any("avatar.gesture.requested" in chunk for chunk in chunks)
    assert any('"text": "Just words."' in chunk for chunk in chunks)
    # The neutral tone speaks in Gemini's friendly default style.
    assert [(tone, prepared.text, prepared.style) for tone, prepared in prepared_speech] == [
        ("neutral", "Just words.", "Speak in a friendly tone.")
    ]
    assert any('"audio_base64": "AQACAA=="' in chunk for chunk in chunks)
    assert _event_data(chunks, "emotion.update")["emotional_tone"] == "neutral"
    assert sum("run.completed" in chunk for chunk in chunks) == 1


@pytest.mark.asyncio
async def test_chat_sse_main_structured_tts_speech_includes_tts_text(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="Speak this.")
    gruut_calls: list[dict[str, Any]] = []

    def _fake_gruut(final_text, lang="en_US", **kwargs):
        gruut_calls.append({"text": final_text, "lang": lang, **kwargs})
        return {"tokenized_text": final_text, "phonemized_text": [["S"], ["DH"]]}

    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", _fake_gruut)
    prepared_calls = _install_gemini_speech(monkeypatch, audio=lambda _prepared: "AQACAA==")

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    assert gruut_calls == [
        {"text": "Speak this.", "lang": "en_US"},
        {
            "text": "Speak this.",
            "lang": "en_US",
            "tokenized_text_source": "text_with_ws",
        },
    ]
    assert any('"tokenized_text": "Speak this."' in chunk for chunk in chunks)
    assert any('"tts_text": "Speak this."' in chunk for chunk in chunks)
    assert any('"tts_text_basis": "gruut_text_with_ws"' in chunk for chunk in chunks)
    assert prepared_calls == [
        {
            # The Anima names no Gemini voice, so the turn speaks with the default one.
            "voice_id": DEFAULT_GEMINI_VOICE,
            "run_id": "run-1",
            "text": "Speak this.",
            "model_id": _GEMINI_TTS_MODEL,
            "text_basis": "gruut_text_with_ws",
            "emotional_tone": "joy",
            "emotional_state": {
                "admiration": 0,
                "caring": 0,
                "love": 0,
                "respect": 0,
                "confidence": 0,
                "gratitude": 0,
                "amusement": 0,
                "excitement": 0,
                "joy": 16,
                "desire": 0,
                "curiosity": 0,
                "optimism": 0,
                "fear": 0,
                "nervousness": 0,
                "confusion": 0,
                "anger": 0,
                "annoyance": 0,
                "disapproval": 0,
                "disgust": 0,
                "embarrassment": 0,
                "remorse": 0,
                "disappointment": 0,
                "grief": 0,
                "sadness": 0,
            },
        }
    ]
    user_response_index = next(index for index, chunk in enumerate(chunks) if "event: user.response" in chunk)
    audio_index = next(index for index, chunk in enumerate(chunks) if "event: tts.audio" in chunk)
    done_index = next(index for index, chunk in enumerate(chunks) if "event: tts.done" in chunk)
    completed_index = next(index for index, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    assert user_response_index < audio_index < done_index < completed_index
    assert '"audio_base64": "AQACAA=="' in chunks[audio_index]


def _gruut_for_any_language(final_text, lang="en_US", **kwargs):
    """gruut keeps the text of any script, but phonemizes only English-looking words.

    Like gruut, it returns nothing for text without letters or digits.
    """

    del lang, kwargs
    if not any(char.isalnum() for char in final_text):
        return None
    text = " ".join(final_text.split())
    english_words = [word for word in text.split() if word.isascii() and any(char.isalpha() for char in word)]
    return {"tokenized_text": text, "phonemized_text": [["a"] for _ in english_words]}


def _gruut_unavailable(*_args, **_kwargs):
    return None


@pytest.mark.parametrize(
    "speech",
    [
        "おはようございます。今日はどうですか？",
        "안녕하세요. 오늘 어때요?",
        "你好。今天怎么样？",
        "¡Hola! ¿Cómo estás hoy?",
    ],
)
@pytest.mark.parametrize("gruut", [_gruut_for_any_language, _gruut_unavailable], ids=["gruut", "no-gruut"])
@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_speaks_every_language(monkeypatch, speech, gruut) -> None:
    """No phoneme step decides what is spoken: every sentence reaches the finalized voice."""

    _gemini_tts_route_mocks(monkeypatch, speech=speech)
    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", gruut)
    prepared_calls = _install_gemini_speech(monkeypatch)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    assert _event_count(chunks, "tts.error") == 0
    assert _event_count(chunks, "tts.done") == 1
    assert _event_data_all(chunks, "tts.audio")
    assert "".join(call["text"] for call in prepared_calls).replace(" ", "") == speech.replace(" ", "")


@pytest.mark.parametrize("speech", ["That’s lovely — see you at 3:30!", "Well… let me think. 😊"])
@pytest.mark.asyncio
async def test_chat_sse_english_speech_keeps_gruut_text_whatever_its_punctuation(monkeypatch, speech) -> None:
    """Typographic punctuation and emoji do not send English past gruut's preparation."""

    _gemini_tts_route_mocks(monkeypatch, speech=speech)
    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", _gruut_for_any_language)
    prepared_calls = _install_gemini_speech(monkeypatch)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    assert prepared_calls
    assert {call["text_basis"] for call in prepared_calls} == {"gruut_text_with_ws"}
    assert any('"tts_text_basis": "gruut_text_with_ws"' in chunk for chunk in chunks)
    assert _event_count(chunks, "tts.done") == 1


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_shows_but_does_not_speak_a_closing_emoji(monkeypatch) -> None:
    """An emoji after the last sentence stays visible; only words reach the voice."""

    _gemini_tts_route_mocks(monkeypatch, speech="See you tomorrow! 😊👋")
    monkeypatch.setattr("animama.product_http.routes.chat_turns._build_gruut_sse_text", _gruut_for_any_language)
    prepared_calls = _install_gemini_speech(monkeypatch)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    assert [call["text"] for call in prepared_calls] == ["See you tomorrow!"]
    speech = "".join(
        data.get("text") or ""
        for data in _event_data_all(chunks, "user.response")
        if data.get("response_part") == "speech"
    )
    assert "😊👋" in speech
    assert _event_count(chunks, "tts.error") == 0
    assert _event_count(chunks, "tts.done") == 1


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_without_speakable_text_reports_missing_tts_text(monkeypatch) -> None:
    """Speech with nothing to speak ends the reply's speech with one error frame; the text is intact."""

    _gemini_tts_route_mocks(monkeypatch, speech="😊")
    prepared_calls = _install_gemini_speech(monkeypatch)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    errors = _event_data_all(chunks, "tts.error")
    assert [(error["provider"], error["code"]) for error in errors] == [("gemini", "missing_tts_text")]
    assert prepared_calls == []
    assert [_event_count(chunks, name) for name in ("tts.audio", "tts.done", "run.completed")] == [0, 0, 1]
    speech = "".join(
        data.get("text") or ""
        for data in _event_data_all(chunks, "user.response")
        if data.get("response_part") == "speech"
    )
    assert "😊" in speech


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_paragraph_chunking_batches_sentence_segments(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, finalized_chunking="paragraph")
    prepared_calls = _install_gemini_speech(monkeypatch, audio=lambda _prepared: "PARAGRAPH")

    response = await chat_anima_direct_sse(
        "anima-1",
        _gemini_tts_request(finalized_chunking="paragraph"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert [event["audio_base64"] for event in _event_data_all(chunks, "tts.audio")] == ["PARAGRAPH"]
    assert _event_count(chunks, "tts.done") == 1
    assert [(call["text"], call["text_basis"]) for call in prepared_calls] == [
        ("First sentence. Second sentence.", "visible_text")
    ]
    assert not any("paragraph_index" in chunk or "paragraph_break_before" in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_paragraph_chunking_splits_paragraph_breaks(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="First paragraph.\n\nSecond paragraph.", finalized_chunking="paragraph")
    prepared_calls = _install_gemini_speech(
        monkeypatch, audio=lambda prepared: "FIRST" if prepared.text == "First paragraph." else "SECOND"
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _gemini_tts_request(finalized_chunking="paragraph"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert [(call["text"], call["text_basis"]) for call in prepared_calls] == [
        ("First paragraph.", "visible_text"),
        ("Second paragraph.", "visible_text"),
    ]
    audio_events = _event_data_all(chunks, "tts.audio")
    assert len(audio_events) == 3
    assert audio_events[0]["audio_base64"] == "FIRST"
    assert audio_events[2]["audio_base64"] == "SECOND"
    # The later paragraph starts after 400 ms of silence in the same voice's stream.
    silence_bytes = base64.b64decode(audio_events[1]["audio_base64"])
    assert len(silence_bytes) == round(
        chat_tts.FINALIZED_TTS_PARAGRAPH_LEADING_PAUSE_SEC * chat_tts.FINALIZED_TTS_PCM_SAMPLE_RATE * 2
    )
    assert set(silence_bytes) == {0}
    assert {(event["provider"], event["model_id"]) for event in audio_events} == {("gemini", _GEMINI_TTS_MODEL)}
    assert _event_count(chunks, "tts.done") == 1


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_paragraph_chunking_flushes_after_four_sentences(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="One. Two. Three. Four. Five.", finalized_chunking="paragraph")
    prepared_calls = _install_gemini_speech(
        monkeypatch, audio=lambda prepared: "BATCH1" if prepared.text.startswith("One.") else "BATCH2"
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _gemini_tts_request(finalized_chunking="paragraph"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert [(call["text"], call["text_basis"]) for call in prepared_calls] == [
        ("One. Two. Three. Four.", "visible_text"),
        ("Five.", "visible_text"),
    ]
    assert [event["audio_base64"] for event in _event_data_all(chunks, "tts.audio")] == ["BATCH1", "BATCH2"]
    assert _event_count(chunks, "tts.done") == 1


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_segment_failure_emits_error_without_done(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch)
    prepared_calls: list[dict[str, Any]] = []

    async def _fake_prepare(**kwargs):
        prepared_calls.append(kwargs)
        return SimpleNamespace(model_id=kwargs["model_id"], output_format="pcm_24000", text=kwargs["text"])

    async def _failing_stream(prepared):
        yield {
            "type": "error",
            "run_id": "run-1",
            "model_id": prepared.model_id,
            "output_format": "pcm_24000",
            "error": "stream failed",
            "code": "gemini_tts_stream_failed",
        }

    monkeypatch.setattr(gemini_tts_service, "prepare_gemini_finalized_speech", _fake_prepare)
    monkeypatch.setattr(gemini_tts_service, "stream_gemini_finalized_speech", _failing_stream)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    # The first segment's failure ends the reply's speech; the second is never requested.
    assert len(prepared_calls) == 1
    assert _event_count(chunks, "tts.error") == 1
    assert _event_count(chunks, "tts.done") == 0
    assert _event_count(chunks, "run.completed") == 1
    assert _event_data(chunks, "tts.error")["error"] == "stream failed"


@pytest.mark.asyncio
async def test_chat_sse_early_stream_close_cancels_finalized_tts_work(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch)
    stream_waiting = asyncio.Event()
    stream_cancelled = asyncio.Event()
    release_stream = asyncio.Event()

    async def _fake_prepare(**kwargs):
        return SimpleNamespace(model_id=kwargs["model_id"], output_format="pcm_24000", text=kwargs["text"])

    async def _held_stream(prepared):
        frame = {"run_id": "run-1", "model_id": prepared.model_id, "output_format": "pcm_24000"}
        yield {"type": "audio", "audio_base64": "FIRST", **frame}
        stream_waiting.set()
        try:
            await release_stream.wait()
        except asyncio.CancelledError:
            stream_cancelled.set()
            raise
        yield {"type": "done", **frame}

    monkeypatch.setattr(gemini_tts_service, "prepare_gemini_finalized_speech", _fake_prepare)
    monkeypatch.setattr(gemini_tts_service, "stream_gemini_finalized_speech", _held_stream)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    body_iterator = _stream_body(response)
    while True:
        raw_chunk = await asyncio.wait_for(anext(body_iterator), timeout=1.0)
        chunk = raw_chunk.decode() if isinstance(raw_chunk, bytes) else raw_chunk
        if "event: tts.audio" in chunk:
            break

    await asyncio.wait_for(stream_waiting.wait(), timeout=1.0)
    await body_iterator.aclose()
    await asyncio.wait_for(stream_cancelled.wait(), timeout=1.0)


@pytest.mark.asyncio
async def test_chat_sse_finalized_speech_audio_streams_before_run_completed(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="Speak this.")
    _install_gemini_speech(monkeypatch, audio=lambda _prepared: "AQACAA==")

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )

    chunks: list[str] = []
    body_iterator = _stream_body(response)
    while True:
        raw_chunk = await asyncio.wait_for(anext(body_iterator), timeout=1.0)
        chunk = raw_chunk.decode() if isinstance(raw_chunk, bytes) else raw_chunk
        chunks.append(chunk)
        if "event: tts.audio" in chunk:
            break

    user_response_index = next(index for index, chunk in enumerate(chunks) if "event: user.response" in chunk)
    audio_index = next(index for index, chunk in enumerate(chunks) if "event: tts.audio" in chunk)
    assert user_response_index < audio_index

    while True:
        try:
            raw_chunk = await asyncio.wait_for(anext(body_iterator), timeout=1.0)
        except StopAsyncIteration:
            break
        chunk = raw_chunk.decode() if isinstance(raw_chunk, bytes) else raw_chunk
        chunks.append(chunk)

    assert any("event: run.completed" in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_emotion_update_is_persisted_and_streamed(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={"main_structured_response": True},
        emotional_state={"joy": 1, "sadness": 5},
        model_client=_RouteModelClient(
            text=_direct_structured_response(
                speech="Speak this.",
                emotional_tone="joy",
                emotional_intensity=5,
            )
        ),
    )
    persist_calls: list[tuple[str, object]] = []

    async def _fake_persist_emotional_state_update(sessions, anima_id, payload):
        persist_calls.append((anima_id, payload))
        return True

    monkeypatch.setattr("animama.app.primary_emotion_update.random.choice", lambda _candidates: "sadness")
    monkeypatch.setattr(
        "animama.product_http.chat.sse_events.persist_emotional_state_update",
        _fake_persist_emotional_state_update,
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: emotion.update" in chunk for chunk in chunks)
    assert any('"node_id": "direct-chat:model-client"' in chunk for chunk in chunks)
    assert any('"emotional_tone": "joy"' in chunk for chunk in chunks)
    assert any('"emotional_intensity": 2' in chunk for chunk in chunks)
    assert not any('"emotion_intensity"' in chunk for chunk in chunks)
    assert any('"promoted_emotion": "joy"' in chunk for chunk in chunks)
    assert any('"demoted_emotion": "sadness"' in chunk for chunk in chunks)
    assert not any('"animation"' in chunk for chunk in chunks)
    assert not any('"vfx"' in chunk for chunk in chunks)
    assert len(persist_calls) == 1
    assert persist_calls[0][0] == "anima-1"
    payload = persist_calls[0][1]
    assert isinstance(payload, EmotionUpdatePayload)
    state = {item.emotion: item.value for item in payload.emotions}
    assert state["joy"] == 3
    assert state["sadness"] == 3
    assert payload.node_id == "direct-chat:model-client"


@pytest.mark.asyncio
async def test_chat_sse_neutral_emotion_update_is_streamed_as_noop(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={"main_structured_response": True},
        emotional_state={"joy": 5},
        model_client=_RouteModelClient(
            text=_direct_structured_response(
                speech="Speak this.",
                emotional_tone="friendly",
                emotional_intensity=10,
            )
        ),
    )
    persist_calls: list[tuple[str, object]] = []

    async def _fake_persist_emotional_state_update(sessions, anima_id, payload):
        persist_calls.append((anima_id, payload))
        return True

    monkeypatch.setattr(
        "animama.product_http.chat.sse_events.persist_emotional_state_update",
        _fake_persist_emotional_state_update,
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: emotion.update" in chunk for chunk in chunks)
    assert any('"emotional_tone": "neutral"' in chunk for chunk in chunks)
    assert any('"emotional_intensity": 0' in chunk for chunk in chunks)
    assert not any('"emotion_intensity"' in chunk for chunk in chunks)
    assert any('"promoted_emotion": null' in chunk for chunk in chunks)
    assert any('"demoted_emotion": null' in chunk for chunk in chunks)
    assert len(persist_calls) == 1
    payload = persist_calls[0][1]
    assert isinstance(payload, EmotionUpdatePayload)
    state = {item.emotion: item.value for item in payload.emotions}
    assert state["joy"] == 5


@pytest.mark.asyncio
async def test_chat_sse_disable_emotion_updates_suppresses_primary_update(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        chat_options={"main_structured_response": True, "disable_emotion_updates": True},
        emotional_state={"joy": 1},
        model_client=_RouteModelClient(
            text=_direct_structured_response(
                speech="Speak this.",
                emotional_tone="joy",
                emotional_intensity=10,
            )
        ),
    )
    persist_calls: list[tuple[str, object]] = []

    async def _fake_persist_emotional_state_update(sessions, anima_id, payload):
        persist_calls.append((anima_id, payload))
        return True

    monkeypatch.setattr(
        "animama.product_http.chat.sse_events.persist_emotional_state_update",
        _fake_persist_emotional_state_update,
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert not any("event: emotion.update" in chunk for chunk in chunks)
    assert persist_calls == []


@pytest.mark.asyncio
async def test_chat_sse_avatar_gesture_requested_is_streamed(monkeypatch) -> None:
    _install_route_mocks(
        monkeypatch,
        model_client=_RouteModelClient(text=_direct_structured_response(gesture="wave")),
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: avatar.gesture.requested" in chunk for chunk in chunks)
    assert any('"gesture": "wave"' in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_chat_sse_revision_conflict_happens_before_model_invocation(monkeypatch) -> None:
    model_client = _RouteModelClient()
    _install_route_mocks(monkeypatch, model_client=model_client)

    async def _unmounted(_self, **_kwargs):  # noqa: ANN001, ANN003
        return None

    monkeypatch.setattr(_FakeRuntimeSnapshots, "get_snapshot", _unmounted)

    with pytest.raises(HTTPException) as raised:
        await chat_anima_direct_sse(
            "anima-1",
            _chat_request(
                message="hello",
                run_id="run-1",
                chat_id="chat-1",
                runtime_revision="tr1-stale",
            ),
            request=_test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert raised.value.status_code == 409
    assert _json_object(raised.value.detail) == {"code": "runtime_remount_required"}
    assert model_client.seen_specs == []


@pytest.mark.asyncio
async def test_chat_sse_custom_runtime_gesture_carries_matching_revision(monkeypatch) -> None:
    model_client = _RouteModelClient(
        text=_direct_structured_response(gesture="victory-dance"),
    )
    _install_route_mocks(
        monkeypatch,
        model_client=model_client,
        runtime_catalog={
            "gestures": [
                {
                    "semantic_key": "victory-dance",
                    "name": "Victory Dance",
                    "description": "Celebrate an exciting success.",
                }
            ]
        },
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-1",
            chat_id="chat-1",
            runtime_revision="tr1-custom",
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)
    event = _event_data(chunks, "avatar.gesture.requested")

    assert event["gesture"] == "victory-dance"
    assert event["runtime_revision"] == "tr1-custom"
    schema = model_client.seen_specs[0].prompt.response_format
    assert schema is not None
    assert schema["type"] == "json_schema"
    gesture_schema = _json_object(schema["json_schema"]["schema"])
    assert _json_object(_json_object(gesture_schema["properties"])["gesture"])["enum"] == [
        None,
        "victory-dance",
    ]


@pytest.mark.asyncio
async def test_chat_sse_direct_executor_persists_chat_turn(monkeypatch) -> None:
    chats = _FakeChatManager()
    _install_route_mocks(monkeypatch, chat_manager=chats)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    await _collect_chunks(response)

    assert chats.record_turn_calls == 1
    payload = chats.record_turn_payloads[0]
    assert payload["chat_id"] == "chat-1"
    assert payload["last_model_client"] == "openai_chat_completions"
    assert payload["last_model_id"] == "gpt-6-luna"
    assert payload["user_msg"].model is None
    assert payload["user_msg"].model_provider is None
    assistant_messages = payload["assistant_msg"]
    assert isinstance(assistant_messages, ChatMessage)
    assistant_messages = [assistant_messages]
    assert [(message.model_provider, message.model) for message in assistant_messages] == [
        ("OpenAIHTTPAgent", "gpt-6-luna")
    ]


@pytest.mark.asyncio
async def test_chat_sse_model_provider_override_persists_selected_snapshot(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-model-override"
    chat_id = "chat-db-model-override"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_chat_model_provider(
        async_session,
        "OpenAIHTTPAgent:gpt-5-mini",
        provider_type="OpenAIHTTPAgent",
        model="gpt-5-mini",
    )
    model_client = _RouteModelClient(text=_direct_structured_response(speech="using gpt-5-mini"))
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-db-model-override",
            chat_id=chat_id,
            model_provider_id="OpenAIHTTPAgent:gpt-5-mini",
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == chat_id
    assert model_client.seen_specs[0].model_provider.id == "OpenAIHTTPAgent:gpt-5-mini"
    assistant = (
        await async_session.execute(
            select(ORMChatMessage).where(
                ORMChatMessage.chat_id == chat_id,
                ORMChatMessage.role == "assistant",
            )
        )
    ).scalar_one()
    assert assistant.content == model_client.text
    assert assistant.raw_provider_message == {"role": "assistant", "content": model_client.text}
    assert assistant.model_provider == "OpenAIHTTPAgent"
    assert assistant.model == "gpt-5-mini"
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None
    assert chat.last_model_client == "openai_chat_completions"
    assert chat.last_model_id == "gpt-5-mini"


@pytest.mark.asyncio
async def test_chat_sse_owner_connection_row_initializes_chat_completions_and_persists_snapshot(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-owner-connection"
    chat_id = "chat-db-owner-connection"
    model_provider_id = "owner:deepseek-flash"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_owner_connection(
        async_session,
        "conn-deepseek",
        preset="deepseek",
        base_url="https://api.deepseek.com",
        name="DeepSeek",
    )
    await _seed_chat_model_provider(
        async_session,
        model_provider_id,
        provider_type="OpenAIHTTPAgent",
        model="deepseek-v4-flash",
        provider_label="DeepSeek",
        connection_id="conn-deepseek",
        source="owner",
        supported_reasoning_efforts=["none", "high", "max"],
    )
    model_client = _RouteModelClient(text=_direct_structured_response(speech="using deepseek"))
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-db-owner-connection",
            chat_id=chat_id,
            model_provider_id=model_provider_id,
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == chat_id
    spec = model_client.seen_specs[0]
    assert spec.model_provider.id == model_provider_id
    assert spec.model_provider.connection is not None
    assert spec.model_provider.connection.id == "conn-deepseek"
    assert spec.model_provider.connection.base_url == "https://api.deepseek.com"
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None
    assert chat.api_standard == "chat_completions"
    assert chat.last_model_client == "openai_chat_completions"
    assert chat.last_model_id == "deepseek-v4-flash"
    assert chat.last_model_provider_id == model_provider_id


@pytest.mark.asyncio
async def test_chat_sse_owner_connection_row_is_rejected_for_responses_chat_before_model_call(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-owner-connection-mismatch"
    chat_id = "chat-db-owner-connection-mismatch"
    model_provider_id = "owner:deepseek-pro"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            api_standard="responses",
            metadata_={},
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_owner_connection(
        async_session,
        "conn-deepseek-mismatch",
        preset="deepseek",
        base_url="https://api.deepseek.com",
        name="DeepSeek",
    )
    await _seed_chat_model_provider(
        async_session,
        model_provider_id,
        provider_type="OpenAIHTTPAgent",
        model="deepseek-v4-pro",
        provider_label="DeepSeek",
        connection_id="conn-deepseek-mismatch",
        source="owner",
        supported_reasoning_efforts=["none", "high", "max"],
    )
    model_client = _RouteModelClient()
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    with pytest.raises(HTTPException) as exc_info:
        await chat_anima_direct_sse(
            anima_id,
            _chat_request(
                message="hello",
                run_id="run-db-owner-connection-mismatch",
                chat_id=chat_id,
                model_provider_id=model_provider_id,
            ),
            request=_test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc_info.value.status_code == 409
    assert _json_object(exc_info.value.detail)["code"] == "chat_api_standard_mismatch"
    assert _json_object(exc_info.value.detail)["chat_api_standard"] == "responses"
    assert _json_object(exc_info.value.detail)["requested_api_standard"] == "chat_completions"
    assert _json_object(exc_info.value.detail)["requested_model_provider_id"] == model_provider_id
    assert model_client.seen_specs == []


@pytest.mark.asyncio
async def test_chat_sse_owner_model_on_the_openai_connection_completes_a_turn(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    """A newly released OpenAI model added by the owner chats without a code change."""

    anima_id = "anima-db-owner-openai"
    chat_id = "chat-db-owner-openai"
    model_provider_id = "owner:gpt-6-luna"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_chat_model_provider(
        async_session,
        model_provider_id,
        provider_type="OpenAIResponsesHTTPAgent",
        model="gpt-6-luna",
        source="owner",
        context_window_tokens=1_050_000,
        supported_reasoning_efforts=["none", "low"],
    )
    model_client = _RouteModelClient(text=_direct_structured_response(speech="new model"))
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello", run_id="run-db-owner-openai", chat_id=chat_id, model_provider_id=model_provider_id
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == chat_id
    spec = model_client.seen_specs[0]
    assert spec.model_provider.model == "gpt-6-luna"
    assert spec.model_provider.connection is not None and spec.model_provider.connection.is_builtin_openai
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None and chat.api_standard == "responses"


@pytest.mark.asyncio
async def test_chat_sse_selects_the_requested_connection_when_two_serve_the_same_model(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-same-slug"
    chat_id = "chat-db-same-slug"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    for connection_id, preset, port in (("conn-ollama", "ollama", 11434), ("conn-lmstudio", "lmstudio", 1234)):
        await _seed_owner_connection(
            async_session,
            connection_id,
            preset=preset,
            base_url=f"http://127.0.0.1:{port}/v1",
            name=preset,
        )
        await _seed_chat_model_provider(
            async_session,
            f"owner:{connection_id}-qwen",
            provider_type="OpenAIHTTPAgent",
            model="qwen3:8b",
            provider_label=preset,
            connection_id=connection_id,
            source="owner",
            supports_reasoning=None,
            supported_reasoning_efforts=[],
            native_tool_support=[],
        )
    model_client = _RouteModelClient(text=_direct_structured_response(speech="local"))
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-db-same-slug",
            chat_id=chat_id,
            model_provider_id="owner:conn-lmstudio-qwen",
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == chat_id
    spec = model_client.seen_specs[0]
    assert spec.model_provider.id == "owner:conn-lmstudio-qwen"
    assert spec.model_provider.connection is not None
    assert spec.model_provider.connection.base_url == "http://127.0.0.1:1234/v1"


@pytest.mark.asyncio
async def test_chat_sse_uses_anima_chat_profile_default_model_provider(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-profile-model-default"
    chat_id = "chat-db-profile-model-default"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_chat_model_provider(
        async_session,
        "OpenAIHTTPAgent:gpt-5-profile",
        provider_type="OpenAIHTTPAgent",
        model="gpt-5-profile",
    )
    async_session.add(
        ORMAnimaChatProfile(
            anima_id=anima_id,
            default_model_provider_id="OpenAIHTTPAgent:gpt-5-profile",
            metadata_={"source": "test"},
        )
    )
    await async_session.commit()

    model_client = _RouteModelClient(text=_direct_structured_response(speech="default gpt-5-profile"))
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=model_client,
        default_model_provider_id="OpenAIHTTPAgent:gpt-5-profile",
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-profile-default", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    await _collect_chunks(response)

    assert model_client.seen_specs[0].model_provider.id == "OpenAIHTTPAgent:gpt-5-profile"
    assistant = (
        await async_session.execute(
            select(ORMChatMessage).where(
                ORMChatMessage.chat_id == chat_id,
                ORMChatMessage.role == "assistant",
            )
        )
    ).scalar_one()
    assert assistant.content == model_client.text
    assert assistant.raw_provider_message == {"role": "assistant", "content": model_client.text}
    assert assistant.model_provider == "OpenAIHTTPAgent"
    assert assistant.model == "gpt-5-profile"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model_provider_id", "seed_kwargs", "expected_detail"),
    [
        ("OpenAIHTTPAgent:missing", None, "Model provider not found"),
        (
            "OpenAIHTTPAgent:inactive",
            {"provider_type": "OpenAIHTTPAgent", "model": "gpt-5-inactive", "active": False},
            "inactive",
        ),
        (
            "OpenAIHTTPAgent:no-stream",
            {"provider_type": "OpenAIHTTPAgent", "model": "gpt-5-no-stream", "supports_streaming": False},
            "streaming",
        ),
    ],
)
async def test_chat_sse_model_provider_override_rejects_missing_inactive_or_unsupported_catalog_rows(
    monkeypatch,
    async_session,
    async_session_factory,
    model_provider_id: str,
    seed_kwargs: _ProviderSeedOptions | None,
    expected_detail: str,
) -> None:
    anima_id = f"anima-db-{model_provider_id}".replace(":", "-")
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    if seed_kwargs is not None:
        await _seed_chat_model_provider(async_session, model_provider_id, **seed_kwargs)

    _install_db_route_mocks(monkeypatch, async_session_factory)

    with pytest.raises(HTTPException) as exc:
        await chat_anima_direct_sse(
            anima_id,
            _chat_request(message="hello", model_provider_id=model_provider_id),
            request=_test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc.value.status_code == 400
    assert expected_detail in str(exc.value.detail)


@pytest.mark.asyncio
async def test_chat_sse_model_provider_override_rejects_missing_provider(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-missing-provider-override"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    _install_db_route_mocks(monkeypatch, async_session_factory)

    with pytest.raises(HTTPException) as exc:
        await chat_anima_direct_sse(
            anima_id,
            _chat_request(message="hello", model_provider_id="MissingProvider:gpt-6-luna"),
            request=_test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc.value.status_code == 400
    assert "Model provider not found" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_chat_sse_missing_profile_without_override_fails_setup(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-missing-chat-profile"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_default_chat_model_provider(async_session)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        patch_profile_service=False,
    )

    with pytest.raises(HTTPException) as exc:
        await chat_anima_direct_sse(
            anima_id,
            _chat_request(message="hello"),
            request=_test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc.value.status_code == 400
    assert "Anima chat profile is required" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_chat_sse_model_provider_override_works_without_profile(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-override-without-chat-profile"
    chat_id = "chat-db-override-without-chat-profile"
    model_provider_id = "OpenAIHTTPAgent:gpt-5-override-no-profile"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_chat_model_provider(
        async_session,
        model_provider_id,
        provider_type="OpenAIHTTPAgent",
        model="gpt-5-override-no-profile",
    )
    model_client = _RouteModelClient(text=_direct_structured_response(speech="override without profile"))
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=model_client,
        patch_profile_service=False,
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-db-override-without-profile",
            chat_id=chat_id,
            model_provider_id=model_provider_id,
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == chat_id
    assert model_client.seen_specs[0].model_provider.id == model_provider_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model_provider_id", "seed_kwargs", "chat_options", "dispatch_options", "expected_detail"),
    [
        (
            "OpenAIHTTPAgent:no-reasoning",
            {
                "provider_type": "OpenAIHTTPAgent",
                "model": "gpt-5-no-reasoning",
                "supports_reasoning": False,
                "supported_reasoning_efforts": [],
            },
            {"reasoning_effort": "high"},
            {"reasoning_effort": "high"},
            "reasoning effort high",
        ),
    ],
)
async def test_chat_sse_model_provider_override_rejects_unsupported_requested_turn_features(
    monkeypatch,
    async_session,
    async_session_factory,
    model_provider_id: str,
    seed_kwargs: _ProviderSeedOptions,
    chat_options: dict[str, object],
    dispatch_options: dict[str, object],
    expected_detail: str,
) -> None:
    anima_id = f"anima-db-{model_provider_id}".replace(":", "-")
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_chat_model_provider(async_session, model_provider_id, **seed_kwargs)

    _install_db_route_mocks(monkeypatch, async_session_factory, chat_options=chat_options)

    with pytest.raises(HTTPException) as exc:
        await chat_anima_direct_sse(
            anima_id,
            _chat_request(
                message="hello",
                model_provider_id=model_provider_id,
                dispatch_options=dispatch_options,
            ),
            request=_test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc.value.status_code == 400
    assert expected_detail in str(exc.value.detail)


@pytest.mark.asyncio
async def test_chat_sse_responses_memory_tools_active_and_gated_by_options(monkeypatch) -> None:
    model_provider = _model_provider(
        model_provider_id="OpenAIResponsesHTTPAgent:gpt-test",
        provider_type="OpenAIResponsesHTTPAgent",
        model="gpt-test",
        native_tool_support=["web_search"],
    )
    model_client = _RouteModelClient()
    _install_route_mocks(monkeypatch, model_provider=model_provider, model_client=model_client)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-responses-tools", chat_id="chat-responses-tools"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    assert [_function_tool(tool)["function"]["name"] for tool in model_client.seen_specs[0].prompt.tools] == [
        "memory_list_files",
        "memory_read_files",
        "search_memory_files",
        "memory_apply_patch",
        "memory_write_file",
    ]
    assert model_client.seen_specs[0].provider_options.memory_apply_patch_enabled is False

    capable_provider = _model_provider(
        model_provider_id="OpenAIResponsesHTTPAgent:gpt-6-luna",
        provider_type="OpenAIResponsesHTTPAgent",
        model="gpt-6-luna",
        native_tool_support=["web_search", "apply_patch"],
    )
    model_client = _RouteModelClient()
    _install_route_mocks(monkeypatch, model_provider=capable_provider, model_client=model_client)
    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-responses-native", chat_id="chat-responses-native"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    assert [_function_tool(tool)["function"]["name"] for tool in model_client.seen_specs[0].prompt.tools] == [
        "memory_list_files",
        "memory_read_files",
        "search_memory_files",
    ]
    assert model_client.seen_specs[0].provider_options.memory_apply_patch_enabled is True

    model_client = _RouteModelClient()
    _install_route_mocks(
        monkeypatch,
        model_provider=capable_provider,
        model_client=model_client,
        chat_options={"disable_memory_influence": True, "disable_memory_updates": True},
    )
    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-responses-no-tools",
            chat_id="chat-responses-no-tools",
            dispatch_options={"disable_memory_influence": True, "disable_memory_updates": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    assert model_client.seen_specs[0].prompt.tools == ()
    assert model_client.seen_specs[0].provider_options.memory_apply_patch_enabled is False


@pytest.mark.asyncio
async def test_chat_sse_equips_uploaded_file_search_for_attached_searchable_uploads(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-uploads"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await _seed_default_chat_model_provider(async_session)
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_uploaded_file_chunk(
        async_session,
        file_id="file-ready",
        text=[
            "The attached Atlas upload can be searched.",
            "A second persisted chunk proves the prompt count is not a constant.",
        ],
        original_filename="atlas-dossier.md",
        metadata={
            "overview": {
                "version": 1,
                "description": "An Atlas project dossier.",
                "outline": [
                    {"level": 1, "title": "Atlas"},
                    {"level": 2, "title": "Launch Plan"},
                ],
                "method": "structured",
                "outline_truncated": False,
            }
        },
    )
    await _seed_uploaded_file_chunk(
        async_session,
        file_id="file-malformed-overview",
        text="This searchable upload has malformed historical overview metadata.",
        original_filename="legacy-notes.txt",
        metadata={"overview": {"version": 999, "description": "do not trust"}},
    )
    await _seed_uploaded_file_chunk(
        async_session,
        file_id="file-unattached",
        text="The unattached Atlas upload must not influence tool availability.",
    )
    await _seed_uploaded_file_chunk(
        async_session,
        file_id="file-unprocessed",
        status=STATUS_UPLOADED,
        text="The unprocessed Atlas upload must not validate.",
    )
    await _seed_uploaded_file_chunk(
        async_session,
        file_id="file-foreign",
        user_id="user-2",
        text="The foreign Atlas upload must not validate.",
    )
    model_client = _RouteModelClient()
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-upload-tools",
            chat_id="chat-upload-tools",
            attached_file_ids=[
                "file-ready",
                "file-malformed-overview",
                "file-unprocessed",
                "file-foreign",
            ],
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    assert [_function_tool(tool)["function"]["name"] for tool in model_client.seen_specs[0].prompt.tools] == [
        "memory_list_files",
        "memory_read_files",
        "search_memory_files",
        "search_uploaded_files",
        "read_uploaded_file_chunks",
        "memory_apply_patch",
        "memory_write_file",
    ]
    request_context = _text(model_client.seen_specs[0].prompt.messages[-2]["content"])
    assert 'filename: "atlas-dossier.md"' in request_context
    assert "chunk_count: 2" in request_context
    assert 'description: "An Atlas project dossier."' in request_context
    assert 'title: "Atlas"' in request_context
    assert 'title: "Launch Plan"' in request_context
    assert 'filename: "legacy-notes.txt"' in request_context
    assert request_context.count("chunk_count: 1") == 1
    assert "description: null" in request_context
    assert "file-ready" not in request_context
    assert "file-malformed-overview" not in request_context
    assert "file-unprocessed.txt" not in request_context
    assert "file-foreign.txt" not in request_context
    assert "storage_locator" not in request_context
    assert "storage" not in request_context
    assert "untrusted user-provided document metadata" in request_context
    messages = (
        await async_session.execute(
            select(ORMChatMessage).where(ORMChatMessage.chat_id == "chat-upload-tools").order_by(ORMChatMessage.turn)
        )
    ).scalars()
    persisted = list(messages)
    assert persisted[0].message_data == {"attached_file_ids": ["file-ready", "file-malformed-overview"]}


@pytest.mark.asyncio
async def test_chat_sse_incognito_skips_chat_persistence(monkeypatch) -> None:
    chats = _FakeChatManager()
    _install_route_mocks(
        monkeypatch,
        chat_options={"incognito": True},
        chat_manager=chats,
    )

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(
            message="hello",
            run_id="run-1",
            chat_id="chat-1",
            dispatch_options={"incognito": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    await _collect_chunks(response)

    assert chats.record_turn_calls == 0


@pytest.mark.asyncio
async def test_chat_sse_with_chat_id_persists_visible_turn_and_usage(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-persist"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    usage = Usage(
        input_tokens=3,
        output_tokens=4,
        total_tokens=7,
        input_tokens_details=UsageInputDetails(cached_tokens=1),
        output_tokens_details=UsageOutputDetails(reasoning_tokens=2),
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=usage),
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-1", chat_id="chat-db-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == "chat-db-1"
    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == "chat-db-1").order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert [(row.role, row.content, row.internal) for row in rows] == [
        ("user", "hello", False),
        ("assistant", _direct_structured_response(), False),
    ]
    assert rows[0].raw_provider_message == {"role": "user", "content": "hello"}
    assert rows[1].raw_provider_message == {"role": "assistant", "content": _direct_structured_response()}
    chat = await async_session.get(ORMChat, "chat-db-1")
    assert chat is not None
    assert chat.cum_input_tokens == 3
    assert chat.cum_output_tokens == 4
    assert chat.cum_total_tokens == 7
    assert chat.cum_cached_input_tokens == 1
    assert chat.cum_output_reasoning_tokens == 2
    assert chat.active_context_tokens == 5


@pytest.mark.asyncio
async def test_chat_sse_tool_assisted_turn_emits_normal_frames_and_persists_internal_messages(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-memory-tools"
    chat_id = "chat-db-memory-tools"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_user_memory_file(
        async_session,
        relative_path="profile.md",
        content="Ray likes concise answers.",
        description="RequestPrincipal profile",
    )
    await _seed_default_chat_model_provider(async_session)
    model_client = _RouteModelClient(
        finals=[
            ModelClientFinal(
                text="",
                usage=Usage(requests=1, input_tokens=5, output_tokens=1, total_tokens=6),
                tool_calls=(
                    ModelClientToolCall(
                        id="call-read",
                        name="memory_read_files",
                        arguments=json.dumps({"paths": "profile.md"}),
                    ),
                ),
            ),
            ModelClientFinal(
                text=_direct_structured_response(speech="I checked your profile."),
                usage=Usage(requests=1, input_tokens=7, output_tokens=3, total_tokens=10),
            ),
        ]
    )
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-memory-tools", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: user.response" in chunk for chunk in chunks)
    assert any('"text": "I checked your profile."' in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert not any("event: error" in chunk for chunk in chunks)
    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id).order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert [(row.role, row.message_type, row.internal) for row in rows] == [
        ("user", "message", False),
        ("assistant", "tool_call", True),
        ("tool", "tool_result", True),
        ("assistant", "message", False),
    ]
    assert rows[-1].total_tokens == 16


@pytest.mark.asyncio
async def test_chat_sse_capable_responses_model_commits_native_patch_and_persists_exchange(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-native-patch"
    chat_id = "chat-db-native-patch"
    provider_id = "OpenAIResponsesHTTPAgent:gpt-6-luna"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_chat_model_provider(
        async_session,
        provider_id,
        model="gpt-6-luna",
        native_tool_support=["web_search", "apply_patch"],
    )
    operation = {
        "type": "create_file",
        "path": "native.md",
        "diff": (
            "+---\n"
            '+description: "Memory saved through native OpenAI Apply Patch."\n'
            "+---\n"
            "+# Native memory\n"
            "+\n"
            "+Saved through OpenAI Apply Patch.\n"
        ),
    }
    model_client = _RouteModelClient(
        finals=[
            ModelClientFinal(
                text="",
                usage=Usage(requests=1, input_tokens=5, output_tokens=1, total_tokens=6),
                raw_provider_metadata={"response_id": "resp-native-patch"},
                tool_calls=(
                    ModelClientToolCall(
                        id="call-native-patch",
                        name="apply_patch",
                        arguments=json.dumps(operation),
                        tool_type="apply_patch",
                    ),
                ),
            ),
            ModelClientFinal(
                text=_direct_structured_response(speech="I saved that memory."),
                usage=Usage(requests=1, input_tokens=7, output_tokens=3, total_tokens=10),
                raw_provider_metadata={
                    "response_id": "resp-native-final",
                    "previous_response_id": "resp-native-patch",
                },
            ),
        ]
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=model_client,
        default_model_provider_id=provider_id,
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="remember this", run_id="run-db-native-patch", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any('"text": "I saved that memory."' in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert not any("event: error" in chunk for chunk in chunks)
    assert model_client.seen_specs[0].provider_options.memory_apply_patch_enabled is True
    assert [_function_tool(tool)["function"]["name"] for tool in model_client.seen_specs[0].prompt.tools] == [
        "memory_list_files",
        "memory_read_files",
        "search_memory_files",
    ]
    stored = await async_session.scalar(
        select(ORMMemoryEntry).where(
            ORMMemoryEntry.user_id == "user-1",
            ORMMemoryEntry.path == "native.md",
        )
    )
    assert stored is not None
    assert stored.content == "# Native memory\n\nSaved through OpenAI Apply Patch."
    assert stored.description == "Memory saved through native OpenAI Apply Patch."
    version = await async_session.scalar(
        select(ORMMemoryEntryVersion).where(
            ORMMemoryEntryVersion.entry_id == stored.id,
            ORMMemoryEntryVersion.version == 1,
        )
    )
    assert version is not None
    assert version.metadata_["last_ai_write"]["chat_id"] == chat_id
    assert version.metadata_["last_ai_write"]["run_id"] == "run-db-native-patch"
    assert version.metadata_["last_ai_write"]["tool_call_id"] == "call-native-patch"
    assert version.metadata_["last_ai_write"]["tool_type"] == "apply_patch"
    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id).order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert [(row.role, row.message_type, row.internal) for row in rows] == [
        ("user", "message", False),
        ("assistant", "tool_call", True),
        ("tool", "tool_result", True),
        ("assistant", "message", False),
    ]
    assert rows[1].raw_provider_message["type"] == "model_client_tool_call"
    assert rows[1].raw_provider_message["tool_type"] == "apply_patch"
    assert rows[2].raw_provider_message["type"] == "model_client_tool_result"
    assert rows[2].raw_provider_message["status"] == "completed"


@pytest.mark.asyncio
async def test_chat_sse_with_existing_chat_id_persists_visible_turn_and_usage(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-existing-persist"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id="chat-db-existing",
            anima_id=anima_id,
            user_id="user-1",
            title="Existing",
            metadata_={},
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    usage = Usage(
        input_tokens=3,
        output_tokens=4,
        total_tokens=7,
        input_tokens_details=UsageInputDetails(cached_tokens=1),
        output_tokens_details=UsageOutputDetails(reasoning_tokens=2),
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=usage),
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-existing", chat_id="chat-db-existing"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert _event_data(chunks, "run.completed")["chat_id"] == "chat-db-existing"
    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == "chat-db-existing").order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert [(row.role, row.content, row.internal) for row in rows] == [
        ("user", "hello", False),
        ("assistant", _direct_structured_response(), False),
    ]
    chat = await async_session.get(ORMChat, "chat-db-existing")
    assert chat is not None
    assert chat.cum_input_tokens == 3
    assert chat.cum_output_tokens == 4
    assert chat.cum_total_tokens == 7
    assert chat.cum_cached_input_tokens == 1
    assert chat.cum_output_reasoning_tokens == 2
    assert chat.active_context_tokens == 5


@pytest.mark.asyncio
async def test_chat_sse_generates_title_for_first_untitled_chat(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-title"
    chat_id = "chat-db-title"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", metadata_={}))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=Usage(input_tokens=3, output_tokens=4, total_tokens=7)),
    )
    title_runners = _install_route_title_mocks(
        monkeypatch,
        title="A generated title that is deliberately longer than forty eight characters.",
        usage=Usage(input_tokens=2, output_tokens=3, total_tokens=5),
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="help me plan a React refactor", run_id="run-db-title", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    title_event = _event_data(chunks, "chat.title.updated")
    title_index = next(index for index, chunk in enumerate(chunks) if "event: chat.title.updated" in chunk)
    completed_index = next(index for index, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    chat = await async_session.get(ORMChat, chat_id)

    assert title_index < completed_index
    assert title_event["chat_id"] == chat_id
    assert title_event["run_id"] == "run-db-title"
    assert title_event["title"] == "A generated title that is deliberately longer th"
    assert len(title_event["title"]) <= 48
    assert chat is not None
    assert chat.title == title_event["title"]
    assert chat.metadata_["title_generation"]["prompt_version"] == "chat-title-v1-test"
    assert chat.metadata_["title_generation"]["usage"]["total_tokens"] == 5
    assert _prompt_runner_call_count(title_runners) == 1
    assert dict(title_runners[0].calls[0].request_options) == {"reasoning_effort": "minimal"}


@pytest.mark.asyncio
async def test_chat_sse_title_generation_does_not_block_primary_response(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-title-primary-response"
    chat_id = "chat-db-title-primary-response"
    speech = "Primary response while title generation waits."
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", metadata_={}))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(text=_direct_structured_response(speech=speech)),
    )
    title_started = asyncio.Event()
    title_release = asyncio.Event()
    title_runners = _install_route_title_mocks(
        monkeypatch,
        title="Generated after response",
        started_event=title_started,
        release_event=title_release,
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="show the primary response first",
            run_id="run-db-title-primary-response",
            chat_id=chat_id,
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks: list[str] = []
    iterator = _stream_body(response).__aiter__()

    async def _read_until_primary_response() -> str:
        while True:
            chunk = await iterator.__anext__()
            text = chunk.decode() if isinstance(chunk, bytes) else chunk
            chunks.append(text)
            if "event: user.response" in text and speech in text:
                return text

    reader = asyncio.create_task(_read_until_primary_response())
    await asyncio.wait_for(title_started.wait(), timeout=1.0)
    primary_chunk = await asyncio.wait_for(reader, timeout=1.0)

    assert speech in primary_chunk
    assert not title_release.is_set()

    title_release.set()
    while True:
        try:
            chunk = await asyncio.wait_for(iterator.__anext__(), timeout=1.0)
        except StopAsyncIteration:
            break
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        chunks.append(text)

    assert any("event: chat.title.updated" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert _prompt_runner_call_count(title_runners) == 1


@pytest.mark.asyncio
async def test_chat_sse_does_not_generate_title_for_existing_title(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-title-existing"
    chat_id = "chat-db-title-existing"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            title="Existing title",
            metadata_={},
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=Usage(input_tokens=3, output_tokens=4, total_tokens=7)),
    )
    title_runners = _install_route_title_mocks(monkeypatch, title="Replacement title")

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-title-existing", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)
    chat = await async_session.get(ORMChat, chat_id)

    assert not any("event: chat.title.updated" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert chat is not None
    assert chat.title == "Existing title"
    assert _prompt_runner_call_count(title_runners) == 0


@pytest.mark.asyncio
async def test_chat_sse_incognito_skips_title_generation(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-title-incognito"
    chat_id = "chat-db-title-incognito"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", metadata_={}))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        chat_options={"incognito": True},
        model_client=_RouteModelClient(usage=Usage(input_tokens=3, output_tokens=4, total_tokens=7)),
    )
    title_runners = _install_route_title_mocks(monkeypatch, title="Incognito title")

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="secret",
            run_id="run-db-title-incognito",
            chat_id=chat_id,
            dispatch_options={"incognito": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)
    chat = await async_session.get(ORMChat, chat_id)

    assert not any("event: chat.title.updated" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert chat is not None
    assert chat.title is None
    assert _prompt_runner_call_count(title_runners) == 0


@pytest.mark.asyncio
async def test_chat_sse_title_generation_failure_does_not_fail_stream(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-title-failure"
    chat_id = "chat-db-title-failure"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", metadata_={}))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=Usage(input_tokens=3, output_tokens=4, total_tokens=7)),
    )
    title_runners = _install_route_title_mocks(monkeypatch, fail=True)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-title-failure", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)
    chat = await async_session.get(ORMChat, chat_id)

    assert not any("event: chat.title.updated" in chunk for chunk in chunks)
    assert not any("event: error" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert chat is not None
    assert chat.title is None
    assert _prompt_runner_call_count(title_runners) == 1


@pytest.mark.asyncio
async def test_chat_sse_compacts_after_successful_response_without_streaming_summary(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-post-compact"
    chat_id = "chat-db-post-compact"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            api_standard="chat_completions",
            metadata_={},
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    old_rows = await _seed_visible_chat_messages(
        async_session,
        chat_id=chat_id,
        contents=["old-user-1", "old-assistant-1", "old-user-2", "old-assistant-2"],
    )
    primary_usage = Usage(
        input_tokens=20,
        output_tokens=22,
        total_tokens=42,
        output_tokens_details=UsageOutputDetails(reasoning_tokens=10),
    )
    compaction_usage = Usage(input_tokens=9, output_tokens=3, total_tokens=12)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=primary_usage),
    )
    compaction_runners = _install_route_compaction_mocks(
        monkeypatch,
        summary="Compacted summary should stay hidden.",
        usage=compaction_usage,
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-post-compact", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert sum(1 for chunk in chunks if "event: user.response" in chunk) == 1
    assert any('"text": "Hello"' in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert not any("Compacted summary should stay hidden." in chunk for chunk in chunks)
    active = (
        await async_session.execute(
            select(ORMChatCompaction).where(
                ORMChatCompaction.chat_id == chat_id,
                ORMChatCompaction.status == "active",
            )
        )
    ).scalar_one()
    assert active.summary_text == "Compacted summary should stay hidden."
    assert active.start_turn == old_rows[0].turn
    assert active.end_turn == old_rows[-1].turn
    assert active.source_message_count == 4
    assert active.total_tokens == 12
    assert active.metadata_["trigger_active_context_tokens"] == 32
    assert active.metadata_["preserved_message_count"] == 2
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None
    assert chat.cum_total_tokens == 42
    assert chat.cum_output_reasoning_tokens == 10
    assert chat.active_context_tokens == 32
    assert chat.next_turn == 7
    context = await product_chat_manager(SQLAlchemyProductRepositories(async_session)).get_chat_context(
        chat_id=chat_id,
    )
    assert context.active_compaction is not None
    assert context.active_compaction.summary_text == "Compacted summary should stay hidden."
    assert [message.content for message in context.messages] == ["hello", _direct_structured_response()]
    assert len(compaction_runners) == 1
    assert len(compaction_runners[0].calls) == 1


@pytest.mark.asyncio
async def test_chat_sse_openai_responses_skips_local_compaction_for_native_compaction(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-responses-native-compact"
    chat_id = "chat-db-responses-native-compact"
    model_provider_id = "OpenAIResponsesHTTPAgent:gpt-6-luna"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            api_standard="responses",
            metadata_={},
            active_context_tokens=100,
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_chat_model_provider(
        async_session,
        model_provider_id,
        provider_type="OpenAIResponsesHTTPAgent",
        model="gpt-6-luna",
    )
    await _seed_visible_chat_messages(
        async_session,
        chat_id=chat_id,
        contents=["old-user-1", "old-assistant-1", "old-user-2", "old-assistant-2"],
    )
    model_client = _RouteModelClient(usage=Usage(input_tokens=20, output_tokens=22, total_tokens=42))
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=model_client,
        default_model_provider_id=model_provider_id,
    )
    compaction_runners = _install_route_compaction_mocks(monkeypatch)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-responses-native-compact", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    assert model_client.seen_specs[0].model_provider.provider_type == "OpenAIResponsesHTTPAgent"
    assert compaction_runners == []
    active = (
        await async_session.execute(
            select(ORMChatCompaction).where(
                ORMChatCompaction.chat_id == chat_id,
                ORMChatCompaction.status == "active",
            )
        )
    ).scalar_one_or_none()
    assert active is None


@pytest.mark.asyncio
async def test_chat_sse_finishes_compaction_before_run_completed(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-compact-before-complete"
    chat_id = "chat-db-compact-before-complete"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            api_standard="chat_completions",
            metadata_={},
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    await _seed_visible_chat_messages(
        async_session,
        chat_id=chat_id,
        contents=["old-user-1", "old-assistant-1", "old-user-2", "old-assistant-2"],
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        chat_options={"disable_emotion_updates": True},
        model_client=_RouteModelClient(usage=Usage(input_tokens=20, output_tokens=22, total_tokens=42)),
    )
    compaction_started = asyncio.Event()
    compaction_release = asyncio.Event()
    _install_route_compaction_mocks(
        monkeypatch,
        summary="Summary created before completion.",
        started_event=compaction_started,
        release_event=compaction_release,
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-compact-before-complete", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    iterator = _stream_body(response).__aiter__()
    chunks: list[str] = []

    while True:
        chunk = await asyncio.wait_for(iterator.__anext__(), timeout=1.0)
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        chunks.append(text)
        if "event: user.response" in text:
            break

    next_chunk_task = asyncio.ensure_future(iterator.__anext__())
    await asyncio.wait_for(compaction_started.wait(), timeout=1.0)
    await asyncio.sleep(0.05)
    assert not next_chunk_task.done()

    compaction_release.set()
    chunk = await asyncio.wait_for(next_chunk_task, timeout=1.0)
    chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    while True:
        try:
            chunk = await asyncio.wait_for(iterator.__anext__(), timeout=1.0)
        except StopAsyncIteration:
            break
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        chunks.append(text)

    assert any("event: run.completed" in chunk for chunk in chunks)
    active = (
        await async_session.execute(
            select(ORMChatCompaction).where(
                ORMChatCompaction.chat_id == chat_id,
                ORMChatCompaction.status == "active",
            )
        )
    ).scalar_one()
    assert active.summary_text == "Summary created before completion."


@pytest.mark.asyncio
async def test_chat_sse_incognito_skips_post_response_compaction(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-incognito-compact"
    chat_id = "chat-db-incognito-compact"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            api_standard="chat_completions",
            metadata_={},
            active_context_tokens=99,
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_visible_chat_messages(
        async_session,
        chat_id=chat_id,
        contents=["old-user-1", "old-assistant-1", "old-user-2", "old-assistant-2"],
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        chat_options={"incognito": True},
        model_client=_RouteModelClient(usage=Usage(input_tokens=3, output_tokens=4, total_tokens=7)),
    )
    compaction_runners = _install_route_compaction_mocks(monkeypatch)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-db-incognito-compact",
            chat_id=chat_id,
            dispatch_options={"incognito": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    active = (
        await async_session.execute(
            select(ORMChatCompaction).where(
                ORMChatCompaction.chat_id == chat_id,
                ORMChatCompaction.status == "active",
            )
        )
    ).scalar_one_or_none()
    assert active is None
    assert compaction_runners == []


@pytest.mark.asyncio
async def test_chat_sse_post_response_compaction_failure_does_not_emit_error_or_revert_turn(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-compact-failure"
    chat_id = "chat-db-compact-failure"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(
            id=chat_id,
            anima_id=anima_id,
            user_id="user-1",
            api_standard="chat_completions",
            metadata_={},
        )
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    await _seed_visible_chat_messages(
        async_session,
        chat_id=chat_id,
        contents=["old-user-1", "old-assistant-1", "old-user-2", "old-assistant-2"],
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        model_client=_RouteModelClient(usage=Usage(input_tokens=3, output_tokens=40, total_tokens=43)),
    )
    compaction_runners = _install_route_compaction_mocks(monkeypatch, fail=True)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-compact-failure", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: user.response" in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert not any("event: error" in chunk for chunk in chunks)
    active = (
        await async_session.execute(
            select(ORMChatCompaction).where(
                ORMChatCompaction.chat_id == chat_id,
                ORMChatCompaction.status == "active",
            )
        )
    ).scalar_one_or_none()
    assert active is None
    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id).order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert [row.content for row in rows][-2:] == ["hello", _direct_structured_response()]
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None
    assert chat.cum_total_tokens == 43
    assert chat.active_context_tokens == 43
    assert len(compaction_runners) == 1
    assert len(compaction_runners[0].calls) == 1


@pytest.mark.asyncio
async def test_chat_sse_without_id_creates_chat_and_emits_generated_chat_id(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-generated"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    _install_db_route_mocks(monkeypatch, async_session_factory)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-2"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    chat_id = _event_data(chunks, "run.completed")["chat_id"]
    assert chat_id.startswith("chat-")
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None
    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id).order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert [row.content for row in rows] == ["hello", _direct_structured_response()]


@pytest.mark.asyncio
async def test_chat_sse_incognito_does_not_persist_messages_or_usage(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-incognito"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(ORMChat(id="chat-incognito", anima_id=anima_id, user_id="user-1", metadata_={}))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    usage = Usage(input_tokens=3, output_tokens=4, total_tokens=7)
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        chat_options={"incognito": True},
        model_client=_RouteModelClient(usage=usage),
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="hello",
            run_id="run-db-incognito",
            chat_id="chat-incognito",
            dispatch_options={"incognito": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    await _collect_chunks(response)

    rows = (
        (
            await async_session.execute(
                select(ORMChatMessage).where(ORMChatMessage.chat_id == "chat-incognito").order_by(ORMChatMessage.id)
            )
        )
        .scalars()
        .all()
    )
    assert rows == []
    chat = await async_session.get(ORMChat, "chat-incognito")
    assert chat is not None
    assert chat.api_standard == "chat_completions"
    assert chat.cum_total_tokens == 0
    assert chat.active_context_tokens == 0
    assert chat.last_model_client is None
    assert chat.last_model_id is None


@pytest.mark.asyncio
async def test_chat_sse_provider_error_emits_error_and_completed(monkeypatch) -> None:
    _install_route_mocks(monkeypatch, model_client=_RouteModelClient(fail=True))

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: error" in chunk for chunk in chunks)
    assert any('"error": "provider failed"' in chunk for chunk in chunks)
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert _event_count(chunks, "run.completed") == 1


@pytest.mark.asyncio
async def test_chat_sse_cleans_up_when_stream_closes_early(monkeypatch) -> None:
    model_client = _RouteModelClient()
    session = _install_route_mocks(monkeypatch, model_client=model_client)

    response = await chat_anima_direct_sse(
        "anima-1",
        _chat_request(message="hello", run_id="run-1", chat_id="chat-1"),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )

    body = _stream_body(response)
    first_chunk = await anext(body)
    first_chunk_text = first_chunk.decode() if isinstance(first_chunk, bytes) else first_chunk
    # The AI notice precedes provider output on the first turn of the day.
    assert "event: safety.ai_notice" in first_chunk_text
    reply_chunk = await anext(body)
    reply_chunk_text = reply_chunk.decode() if isinstance(reply_chunk, bytes) else reply_chunk
    assert "event: user.response" in reply_chunk_text

    await _stream_body(response).aclose()

    assert session.close_calls == 1
    assert model_client.close_calls == 0


class _FailingRouteModelClient(_RouteModelClient):
    def __init__(self, error: ModelClientProviderError) -> None:
        super().__init__()
        self.error = error

    async def stream(self, spec: ModelClientRequest):  # noqa: ANN201
        self.seen_specs.append(spec)
        raise self.error
        yield  # pragma: no cover


@pytest.mark.parametrize(
    ("code", "metadata", "category"),
    [
        ("openai_connection_error", {}, "unreachable"),
        ("openai_authentication_error", {"status_code": 401}, "credential_rejected"),
        ("openai_not_found", {"status_code": 404}, "model_not_found"),
        ("openai_timeout", {}, "timeout"),
        (
            "openai_bad_request",
            {"status_code": 400, "provider_error_message": "the request exceeds the available context size"},
            "context_exceeded",
        ),
        ("missing_api_key", {}, "credential_missing"),
        ("openai_rate_limit", {"status_code": 429}, "rate_limited"),
        ("openai_quota_exceeded", {"status_code": 429}, "quota_exceeded"),
        ("openai_server_error", {"status_code": 500}, "server_error"),
        ("openai_bad_request", {"status_code": 400, "provider_error_message": "Unsupported parameter"}, "bad_request"),
    ],
)
@pytest.mark.asyncio
async def test_chat_sse_provider_failures_name_the_connection_and_leave_the_chat_unchanged(
    monkeypatch,
    async_session,
    async_session_factory,
    code,
    metadata,
    category,
) -> None:
    suffix = f"{code}-{category}".replace("_", "-")
    anima_id = f"anima-db-failure-{suffix}"
    chat_id = f"chat-db-failure-{suffix}"
    connection_id = f"conn-failure-{suffix}"
    model_provider_id = f"owner:failure-{suffix}"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", api_standard="chat_completions", metadata_={})
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_owner_connection(
        async_session, connection_id, preset="ollama", base_url="http://127.0.0.1:11434/v1", name="Ollama"
    )
    await _seed_chat_model_provider(
        async_session,
        model_provider_id,
        provider_type="OpenAIHTTPAgent",
        model="qwen3:8b",
        connection_id=connection_id,
        source="owner",
        supports_reasoning=None,
        supported_reasoning_efforts=[],
        native_tool_support=[],
    )
    before = await async_session.get(ORMChat, chat_id)
    assert before is not None
    next_turn_before = before.next_turn
    usage_before = before.cum_total_tokens
    model_client = _FailingRouteModelClient(
        ModelClientProviderError("provider failed", code=code, raw_metadata={"provider": "openai", **metadata})
    )
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id=f"run-{suffix}", chat_id=chat_id, model_provider_id=model_provider_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    error = _event_data(chunks, "error")
    assert error["code"] == code
    assert error["details"]["category"] == category
    assert error["details"]["connection_name"] == "Ollama"
    assert error["details"]["connection_preset"] == "ollama"
    assert error["details"]["provider"] == "ollama"
    assert error["details"]["connection_base_url"] == "http://127.0.0.1:11434/v1"
    assert sum(1 for chunk in chunks if "event: run.completed" in chunk) == 1
    async_session.expire_all()
    rows = (
        (await async_session.execute(select(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id))).scalars().all()
    )
    assert rows == []
    after = await async_session.get(ORMChat, chat_id)
    assert after is not None
    assert after.next_turn == next_turn_before
    assert after.cum_total_tokens == usage_before
    assert after.openai_previous_response_id is None
    assert after.last_model_provider_id is None


@pytest.mark.asyncio
async def test_chat_sse_estimated_usage_advances_context_and_triggers_compaction(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    """A server that streams no usage still grows the context and compacts."""

    from animama.adapters.model_clients import OpenAIChatCompletionsModelClient
    from tests.test_model_client_registry import _FakeOpenAIClient, _sdk_chunk

    anima_id = "anima-db-estimated-usage"
    chat_id = "chat-db-estimated-usage"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(
        ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", api_standard="chat_completions", metadata_={})
    )
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    await _seed_default_chat_model_provider(async_session)
    await _seed_visible_chat_messages(
        async_session,
        chat_id=chat_id,
        contents=["old-user-1", "old-assistant-1", "old-user-2", "old-assistant-2"],
    )
    reply = _direct_structured_response(speech="estimated")
    adapter = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=_FakeOpenAIClient([_sdk_chunk(content=reply), _sdk_chunk(finish_reason="stop")]),  # type: ignore[arg-type]
    )
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=adapter)  # type: ignore[arg-type]
    _install_route_compaction_mocks(monkeypatch, summary="Earlier talk.", usage=Usage(total_tokens=5))

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="hello", run_id="run-db-estimated-usage", chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    assert any("event: run.completed" in chunk for chunk in chunks)
    async_session.expire_all()
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None and chat.active_context_tokens > 0
    assistant = (
        (
            await async_session.execute(
                select(ORMChatMessage)
                .where(ORMChatMessage.chat_id == chat_id, ORMChatMessage.role == "assistant")
                .order_by(ORMChatMessage.turn.desc())
            )
        )
        .scalars()
        .first()
    )
    assert assistant is not None
    assert assistant.message_data["model_client"]["raw_provider_metadata"]["usage_estimated"] is True
    compaction = (
        await async_session.execute(select(ORMChatCompaction).where(ORMChatCompaction.chat_id == chat_id))
    ).scalar_one()
    assert compaction.metadata_["trigger_active_context_tokens"] == chat.active_context_tokens


@pytest.mark.asyncio
async def test_chat_sse_memory_updated_carries_the_cue_the_history_api_returns(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-memory-cue"
    chat_id = "chat-db-memory-cue"
    run_id = "run-db-memory-cue"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    memories_body = "# Memories\n\n## Our story\nWe met at the lake.\n"
    entry_id = await _seed_anima_memories_file(async_session, anima_id=anima_id, content=memories_body)
    await _seed_default_chat_model_provider(async_session)
    model_client = _RouteModelClient(
        finals=[
            _self_memories_patch_final(),
            ModelClientFinal(
                text=_direct_structured_response(
                    speech="Lake twins it is.",
                    remember="Mira shared her lake twin nickname.",
                ),
                usage=Usage(requests=1, input_tokens=7, output_tokens=3, total_tokens=10),
            ),
        ]
    )
    _install_db_route_mocks(monkeypatch, async_session_factory, model_client=model_client)

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(message="Call me your lake twin", run_id=run_id, chat_id=chat_id),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    system = _text(model_client.seen_specs[0].prompt.messages[0]["content"])
    assert "# Anima Memories" in system and ANIMA_MEMORIES_WRITE_GUIDANCE.strip() in system
    assert not any("event: error" in chunk for chunk in chunks)
    memory_frame_index = next(i for i, chunk in enumerate(chunks) if "event: memory.updated" in chunk)
    completed_frame_index = next(i for i, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    assert memory_frame_index < completed_frame_index
    assert f"id: memory-updated-{run_id}" in chunks[memory_frame_index]
    assert _event_count(chunks, "memory.updated") == 1
    assistant = await async_session.scalar(
        select(ORMChatMessage).where(
            ORMChatMessage.chat_id == chat_id,
            ORMChatMessage.role == "assistant",
            ORMChatMessage.internal.is_(False),
        )
    )
    assert assistant is not None
    memories_cue = {"entry_id": entry_id, "version": 2, "excerpt": "Mira calls me her lake twin."}
    assert _event_data(chunks, "memory.updated") == {
        "type": "memory.updated",
        "run_id": run_id,
        "message_id": assistant.id,
        "memory_cue": {"episode": {"text": "Mira shared her lake twin nickname."}, "memories": memories_cue},
    }
    assert assistant.message_data["memory"] == {"updates_enabled": True, "memories": memories_cue}
    stored = await async_session.get(ORMMemoryEntry, entry_id)
    assert stored is not None
    await async_session.refresh(stored)
    assert stored.content == memories_body.replace("lake.\n", "lake.\nMira calls me her lake twin.\n")

    history = await chats_router.list_chat_messages(
        chat_id, user=RequestPrincipal(id="user-1"), repositories=SQLAlchemyProductRepositories(async_session)
    )
    cues = [message.memory_cue for message in history.messages]
    assert cues[0] is None  # The user message never carries a cue.
    assert cues[-1] is not None
    assert cues[-1].model_dump() == _event_data(chunks, "memory.updated")["memory_cue"]


@pytest.mark.asyncio
async def test_chat_sse_incognito_turn_neither_edits_memories_nor_emits_memory_updated(
    monkeypatch,
    async_session,
    async_session_factory,
) -> None:
    anima_id = "anima-db-memory-incognito"
    chat_id = "chat-db-memory-incognito"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    async_session.add(ORMChat(id=chat_id, anima_id=anima_id, user_id="user-1", metadata_={}))
    await async_session.commit()
    await _seed_anima_identity_file(async_session, anima_id=anima_id)
    memories_body = "# Memories\n\n## Our story\nWe met at the lake.\n"
    entry_id = await _seed_anima_memories_file(async_session, anima_id=anima_id, content=memories_body)
    await _seed_default_chat_model_provider(async_session)
    model_client = _RouteModelClient(
        finals=[
            _self_memories_patch_final(),
            ModelClientFinal(
                text=_direct_structured_response(speech="Noted.", remember="Mira shared a nickname."),
                usage=Usage(requests=1, input_tokens=7, output_tokens=3, total_tokens=10),
            ),
        ]
    )
    _install_db_route_mocks(
        monkeypatch,
        async_session_factory,
        chat_options={"incognito": True},
        model_client=model_client,
    )

    response = await chat_anima_direct_sse(
        anima_id,
        _chat_request(
            message="Call me your lake twin",
            run_id="run-db-memory-incognito",
            chat_id=chat_id,
            dispatch_options={"incognito": True},
        ),
        request=_test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await _collect_chunks(response)

    system = _text(model_client.seen_specs[0].prompt.messages[0]["content"])
    assert "[self]/MEMORIES.md" not in system
    assert "memory_apply_patch" not in {
        _function_tool(tool)["function"]["name"] for tool in model_client.seen_specs[0].prompt.tools
    }
    assert any("event: run.completed" in chunk for chunk in chunks)
    assert _event_count(chunks, "memory.updated") == 0
    stored = await async_session.get(ORMMemoryEntry, entry_id)
    assert stored is not None
    await async_session.refresh(stored)
    assert (stored.version, stored.content) == (1, memories_body)


@pytest.mark.asyncio
async def test_chat_sse_gemini_tts_streams_each_sentence_with_the_anima_voice_and_style(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch)
    voice_reads: list[str] = []

    async def _gemini_settings(self, *, user_id: str, anima_id: str) -> object:
        voice_reads.append(anima_id)
        return SimpleNamespace(preferences={"speech": {"tts_provider": "gemini", "gemini": {"voice": "Puck"}}})

    monkeypatch.setattr(_FakeAnimaSettings, "get", _gemini_settings)
    prepared_calls = _install_gemini_speech(
        monkeypatch, audio=lambda prepared: "FIRST" if prepared.text == "First sentence." else "SECOND"
    )

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    audio = _event_data_all(chunks, "tts.audio")
    assert [event["audio_base64"] for event in audio] == ["FIRST", "SECOND"]
    assert {event["provider"] for event in audio} == {"gemini"}
    assert {event["model_id"] for event in audio} == {"gemini-3.8-flash-tts"}
    done = _event_data_all(chunks, "tts.done")
    assert [(event["provider"], event["model_id"]) for event in done] == [("gemini", "gemini-3.8-flash-tts")]
    assert [call["text"] for call in prepared_calls] == ["First sentence.", "Second sentence."]
    # The turn reads the Anima's voice once; later segments reuse it.
    assert voice_reads == ["anima-1"]
    assert [call["voice_id"] for call in prepared_calls] == ["Puck", "Puck"]
    # Every segment carries the reply's tone, so Gemini speaks each in the same style.
    assert [call["emotional_tone"] for call in prepared_calls] == ["joy", "joy"]
    second_audio_index = next(index for index, chunk in enumerate(chunks) if '"audio_base64": "SECOND"' in chunk)
    done_index = next(index for index, chunk in enumerate(chunks) if "event: tts.done" in chunk)
    completed_index = next(index for index, chunk in enumerate(chunks) if "event: run.completed" in chunk)
    assert second_audio_index < done_index < completed_index
    assert _event_count(chunks, "run.completed") == 1
    # Gemini alone speaks: no ElevenLabs session (or session error) is sent.
    assert _event_count(chunks, "tts.session") == 0


@pytest.mark.asyncio
async def test_chat_sse_gemini_tts_without_a_key_shows_a_voice_error_and_keeps_the_reply(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="Only sentence.")
    monkeypatch.setattr(runtime_credentials, "current", lambda: {})

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    errors = _event_data_all(chunks, "tts.error")
    assert [(event["provider"], event["code"]) for event in errors] == [("gemini", "gemini_tts_missing_credential")]
    # The notice tells the owner what to add.
    assert errors[0]["error"] == "Gemini text-to-speech needs a Gemini API key."
    assert _event_count(chunks, "tts.audio") == 0
    assert _event_count(chunks, "tts.done") == 0
    assert any('"speech": "Only sentence."' in chunk or "Only sentence." in chunk for chunk in chunks)
    assert _event_count(chunks, "run.completed") == 1


@pytest.mark.asyncio
async def test_chat_sse_gemini_tts_setup_failure_reaches_the_browser_without_its_detail(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="Only sentence.")

    async def _failing_settings(self, *, user_id: str, anima_id: str) -> object:
        raise RuntimeError("internal detail")

    monkeypatch.setattr(_FakeAnimaSettings, "get", _failing_settings)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    errors = _event_data_all(chunks, "tts.error")
    assert [(event["provider"], event["code"], event["error"]) for event in errors] == [
        ("gemini", "gemini_tts_stream_setup_failed", "Gemini TTS setup failed.")
    ]
    assert not any("internal detail" in chunk for chunk in chunks)
    assert _event_count(chunks, "run.completed") == 1


@pytest.mark.asyncio
async def test_chat_sse_gemini_tts_is_dropped_where_the_composition_does_not_offer_it(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="Only sentence.")
    monkeypatch.setattr(LocalChatTurnServices, "gemini_speech", property(lambda _self: None))

    async def _unexpected_gemini(**_kwargs):
        raise AssertionError("a composition without Gemini speech must not prepare it")

    monkeypatch.setattr(gemini_tts_service, "prepare_gemini_finalized_speech", _unexpected_gemini)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    assert not any(chunk.startswith("event: tts.") or "\nevent: tts." in chunk for chunk in chunks)
    assert _event_count(chunks, "run.completed") == 1


@pytest.mark.asyncio
async def test_chat_sse_gemini_tts_provider_failure_ends_speech_but_not_the_reply(monkeypatch) -> None:
    _gemini_tts_route_mocks(monkeypatch, speech="Only sentence.")

    async def _fake_prepare(**kwargs):
        return SimpleNamespace(
            model_id=kwargs["model_id"], output_format="pcm_24000", text=kwargs["text"], voice_id=kwargs["voice_id"]
        )

    async def _failing_stream(prepared):
        yield {
            "type": "error",
            "run_id": "run-1",
            "model_id": prepared.model_id,
            "output_format": "pcm_24000",
            "error": "Gemini text-to-speech failed (HTTP 503).",
            "code": "gemini_tts_stream_failed",
        }

    monkeypatch.setattr(gemini_tts_service, "prepare_gemini_finalized_speech", _fake_prepare)
    monkeypatch.setattr(gemini_tts_service, "stream_gemini_finalized_speech", _failing_stream)

    response = await chat_anima_direct_sse(
        "anima-1", _gemini_tts_request(), request=_test_request(), user=RequestPrincipal(id="user-1")
    )
    chunks = await _collect_chunks(response)

    errors = _event_data_all(chunks, "tts.error")
    assert [(event["provider"], event["code"], event["error"]) for event in errors] == [
        ("gemini", "gemini_tts_stream_failed", "Gemini text-to-speech failed (HTTP 503).")
    ]
    assert _event_count(chunks, "tts.done") == 0
    assert _event_count(chunks, "run.completed") == 1
