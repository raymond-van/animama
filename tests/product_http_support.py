"""Test compositions for shared product routes (ADR 0021).

``product_app`` mounts routers with explicit ports and a test-only resolver.
``DeferredCommitPorts`` mimics a consumer's commit authority and refuses writes on
read sessions, and ``TwoOwnerComposition`` serves two owners from one database with
separate roots.
``install_local_ports`` gives local-app tests the local ports on their own session.
Chat turns on the doubles use the ports' ``model_clients``, ``FakeSpeech``, any
``FakeGeminiSpeech`` and a ``RecordingChatGuard`` that keeps every lease it grants.
Nothing here is installed outside tests.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from fastapi import APIRouter, FastAPI, HTTPException, Request, Response, WebSocket
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.content_store.private_file_store import FilesystemPrivateFileStorage
from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.app.contracts.elevenlabs import (
    PyElevenLabsAudioResponse,
    PyElevenLabsRealtimeTtsSessionResponse,
    PyElevenLabsSoundEffectsRequest,
    PyElevenLabsTextToSpeechRequest,
    PyElevenLabsVoice,
)
from animama.app.contracts.gemini import DEFAULT_GEMINI_TTS_MODEL_ID
from animama.app.contracts.runtime_capabilities import RuntimeCapabilities
from animama.app.model_clients import ModelClientRegistry
from animama.app.ports.text_embedder import TextEmbedder
from animama.app.safety.config import OperatorSafetyConfig
from animama.app.safety.crisis_resources import CrisisResourceTable, crisis_resource_table
from animama.app.services.chat_compaction_service import ChatCompactionSettings
from animama.app.services.chat_title_generation_service import ChatTitleGenerationSettings
from animama.app.services.content_package_export import DownloadLease
from animama.app.services.content_package_staging import PackageStageService
from animama.app.services.embedding_refresh_service import (
    EMBEDDINGS_STATE_CURRENT,
    EMBEDDINGS_STATE_OFF,
    EmbeddingRefreshStatus,
)
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy
from animama.app.services.model_role_resolver import ModelRoleDefaults
from animama.app.services.user_profile_service import UserProfileService
from animama.app.web_search import WebSearchToolService
from animama.domain.content_catalog import VerifiedContentFile
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_profile import UserProfilePatch
from animama.product_http.chat.setup_helpers import TurnSessions
from animama.product_http.delivery import PackageDownloadResponse, encoded_json_response, verified_file_response
from animama.product_http.ports import (
    ChatTurnAdmission,
    ChatTurnLease,
    ChatTurnOutcome,
    ChatTurnPolicy,
    ChatTurnStop,
    FinalizedSpeech,
    FinalizedSpeechPort,
    ProductContent,
    ProductPolicy,
    ProductPorts,
    ProductRefusal,
    ProductUploads,
    VoiceResolver,
    install_product_ports,
    model_role_resolver,
)
from animama.server.config import Settings
from animama.server.local_runtime import LocalRuntimePaths, initialize_local_runtime
from animama.server.memory_manager import local_memory_manager_service
from animama.server.product_ports import LocalProductPorts, local_product_content

OWNER_HEADER = "X-Test-Owner"
# The local default limits and chat model (server/config.py).
TEST_POLICY = ProductPolicy(
    memory_file_max_bytes=32 * 1024, voice_catalog_max_upload_bytes=25 * 1024 * 1024, private_upload_ttl_seconds=900
)
TEST_ROLE_DEFAULTS = ModelRoleDefaults(chat="OpenAIResponsesHTTPAgent:gpt-6-luna")
# A hosted-like turn: no optional model work, and error frames hide provider detail.
TEST_CHAT_POLICY = ChatTurnPolicy(
    compaction=ChatCompactionSettings(enabled=False),
    presend_compaction_timeout_seconds=1.0,
    title_generation=ChatTitleGenerationSettings(enabled=False),
    companion_safety=OperatorSafetyConfig(),
    public_error_text="The reply could not be completed.",
)
# What a hosted consumer reports; the test doubles report it too.
HOSTED_CAPABILITIES = RuntimeCapabilities.model_validate_json(
    (Path(__file__).resolve().parents[1] / "contracts/runtime-capabilities/hosted.json").read_text()
)


class HeaderOwnerResolver:
    """Test-only: the request names its owner. Never install this outside tests."""

    def _owner(self, owner: str | None) -> RequestPrincipal:
        if not owner:
            raise HTTPException(status_code=401, detail={"code": "test_owner_missing"})
        return RequestPrincipal(id=owner)

    async def resolve_http(self, request: Request) -> RequestPrincipal:
        return self._owner(request.headers.get(OWNER_HEADER))

    async def resolve_websocket(self, websocket: WebSocket) -> RequestPrincipal:
        return self._owner(websocket.headers.get(OWNER_HEADER))


async def save_display_name(session: AsyncSession, principal: RequestPrincipal, display_name: str) -> str:
    """Apply only the shared profile rules, as a composition without local personalization would."""

    repositories = SQLAlchemyProductRepositories(session)
    profile = await UserProfileService(
        profiles=repositories.user_profiles, uow=repositories.unit_of_work
    ).update_profile(user_id=principal.id, patch=UserProfilePatch(display_name=display_name, display_name_set=True))
    assert profile.display_name is not None
    return profile.display_name


@dataclass
class FakeSpeech:
    """Records each speech operation with its owner and arguments; never calls a provider.

    With ``refusal`` set, a reply's realtime session declines with it.
    """

    audio_upload_max_bytes: int = 1024
    calls: list[tuple[str, str, object]] = field(default_factory=list)
    refusal: ProductRefusal | None = None

    async def clone_voice(
        self,
        principal: RequestPrincipal,
        *,
        name: str,
        files: list[tuple[str, bytes, str]],
        description: str | None,
        remove_background_noise: bool,
    ) -> PyElevenLabsVoice:
        self.calls.append(("clone", principal.id, (name, files, description, remove_background_noise)))
        return PyElevenLabsVoice(voice_id=f"voice-{principal.id}", name=name, labels={"owner_user_id": principal.id})

    async def synthesize_text(
        self, principal: RequestPrincipal, request: PyElevenLabsTextToSpeechRequest
    ) -> PyElevenLabsAudioResponse:
        self.calls.append(("text_to_speech", principal.id, request))
        return PyElevenLabsAudioResponse(audio_base64="", media_type="audio/mpeg", voice_id=request.voice_id)

    async def generate_sound_effect(
        self, principal: RequestPrincipal, request: PyElevenLabsSoundEffectsRequest
    ) -> PyElevenLabsAudioResponse:
        self.calls.append(("sound_effect", principal.id, request))
        return PyElevenLabsAudioResponse(audio_base64="", media_type="audio/mpeg")

    async def realtime_session(
        self,
        principal: RequestPrincipal,
        *,
        voice: VoiceResolver,
        language_code: str | None,
        model_id: str | None,
    ) -> PyElevenLabsRealtimeTtsSessionResponse:
        if self.refusal is not None:
            raise self.refusal
        # Resolving the voice runs the turn's owner check, as a provider call would.
        resolved = await voice()
        self.calls.append(("realtime_session", principal.id, resolved.voice_id))
        return PyElevenLabsRealtimeTtsSessionResponse(
            voice_id=resolved.voice_id,
            model_id=model_id or "eleven_v4_turbo",
            output_format="pcm_24000",
            sync_alignment=True,
            language_code=language_code,
            token="fake-speech-token",
            websocket_base_url="wss://speech.invalid",
        )


@dataclass
class FakeGeminiSpeech:
    """A composition's Gemini speech port (``ChatTurnServices.gemini_speech``); never calls Gemini.

    Records each prepared segment's owner and the voice the turn resolved. With
    ``refusal`` set, preparing a segment declines with it; with ``stream_refusal``
    set, a prepared segment declines while it streams.
    """

    calls: list[tuple[str, str, object]] = field(default_factory=list)
    refusal: ProductRefusal | None = None
    stream_refusal: ProductRefusal | None = None

    async def prepare_finalized(
        self,
        principal: RequestPrincipal,
        *,
        voice_id: str,
        anima_id: str,
        run_id: str,
        text: str,
        model_id: str | None,
        text_basis: str,
        emotional_tone: str | None,
        emotional_state: dict[str, int] | None,
    ) -> FakeFinalizedSpeech:
        if self.refusal is not None:
            raise self.refusal
        self.calls.append(("prepare_finalized", principal.id, voice_id))
        return FakeFinalizedSpeech(voice_id=voice_id, model_id=model_id or DEFAULT_GEMINI_TTS_MODEL_ID)

    async def stream_finalized(self, prepared: FinalizedSpeech) -> AsyncIterator[dict[str, Any]]:
        if self.stream_refusal is not None:
            raise self.stream_refusal
        frame = {"model_id": prepared.model_id, "output_format": prepared.output_format}
        yield {"type": "audio", "audio_base64": "AAAA", **frame}
        yield {"type": "done", **frame}


@dataclass(frozen=True)
class FakeFinalizedSpeech:
    voice_id: str
    model_id: str
    output_format: str = "pcm_24000"


# Decides at each check whether the turn must stop now.
StopRule = Callable[[], Awaitable[ChatTurnStop | None]]


@dataclass
class RecordingChatTurnLease:
    """One admitted turn's lease: its ``stop`` rule may end the turn at any check.

    Each settlement also records the turn's tasks still running at that moment.
    """

    admission: ChatTurnAdmission
    owner: str
    stop: StopRule | None = None
    checks: int = 0
    settlements: list[ChatTurnOutcome] = field(default_factory=list)
    running_at_settlement: list[str] = field(default_factory=list)

    async def check(self) -> ChatTurnStop | None:
        self.checks += 1
        return None if self.stop is None else await self.stop()

    async def settle(self, outcome: ChatTurnOutcome) -> None:
        self.settlements.append(outcome)
        self.running_at_settlement.extend(
            task.get_name()
            for task in asyncio.all_tasks()
            if not task.done() and task.get_name().startswith("direct-chat-")
        )


@dataclass
class RecordingChatGuard:
    """A chat-turn guard that keeps every lease it grants, or refuses every turn with ``refusal``."""

    refusal: ProductRefusal | None = None
    stop: StopRule | None = None
    leases: list[RecordingChatTurnLease] = field(default_factory=list)

    async def admit(self, principal: RequestPrincipal, admission: ChatTurnAdmission) -> RecordingChatTurnLease:
        if self.refusal is not None:
            raise self.refusal
        lease = RecordingChatTurnLease(admission=admission, owner=principal.id, stop=self.stop)
        self.leases.append(lease)
        return lease


@dataclass
class FakeChatTurnServices:
    """A turn's collaborators on the doubles: model clients, speech and any Gemini speech; no search or embeddings."""

    model_clients: ModelClientRegistry | None
    speech: FakeSpeech
    gemini_speech: FinalizedSpeechPort | None = None

    async def web_search_tool(self, session: AsyncSession) -> WebSearchToolService | None:
        return None

    async def attachment_embedder(self, session: AsyncSession) -> TextEmbedder | None:
        return None


class DoubleCollaborators:
    """The non-session collaborators both port doubles share.

    Content comes from a separate local tree per owner under ``content_root``, as a
    consumer keeps each owner's bytes apart; clients never store its bytes or JSON.
    """

    settings_changes: list[str]
    content_root: Path | None
    model_catalog_policy: ModelCatalogPolicy
    model_role_defaults: ModelRoleDefaults
    speech: FakeSpeech
    # The composition's Gemini voice, or ``None`` where it offers none.
    gemini_speech: FakeGeminiSpeech | None
    chat_policy: ChatTurnPolicy
    chat_guard: RecordingChatGuard
    model_clients: ModelClientRegistry | None

    def _owner_runtime(self, principal: RequestPrincipal) -> tuple[Settings, LocalRuntimePaths]:
        if self.content_root is None:
            raise AssertionError("pass content_root to serve content and upload routes")
        root = self.content_root / principal.id
        settings = Settings(animama_content_root=root / "content", animama_data_root=root / "data")
        return settings, initialize_local_runtime(settings)

    @asynccontextmanager
    async def content(self, session: AsyncSession, principal: RequestPrincipal) -> AsyncIterator[ProductContent]:
        settings, paths = self._owner_runtime(principal)
        stages = PackageStageService(imports_root=paths.imports_staging_root, exports_root=paths.exports_staging_root)
        yield local_product_content(session, paths, settings, stages)

    def uploads(self, principal: RequestPrincipal) -> ProductUploads:
        _settings, paths = self._owner_runtime(principal)
        return ProductUploads(
            private_files=FilesystemPrivateFileStorage(paths), staging_directory=paths.uploads_staging_root
        )

    def file_response(
        self, request: Request, file: VerifiedContentFile, *, if_none_match: str | None, revalidate: bool
    ) -> Response:
        return verified_file_response(file, if_none_match=if_none_match, cache_control="private, no-store")

    async def json_response(
        self,
        request: Request,
        body: bytes,
        *,
        encoding: str,
        headers: dict[str, str],
        if_none_match: str | None,
        cacheable: bool,
    ) -> Response:
        return await encoded_json_response(body, encoding=encoding, headers=headers, cacheable=False)

    def download_response(self, request: Request, download: DownloadLease) -> Response:
        return PackageDownloadResponse(download)

    def repositories(self, session: AsyncSession) -> SQLAlchemyProductRepositories:
        return SQLAlchemyProductRepositories(session)

    async def update_display_name(self, session: AsyncSession, principal: RequestPrincipal, display_name: str) -> str:
        return await save_display_name(session, principal, display_name)

    def crisis_resources(self) -> CrisisResourceTable:
        return crisis_resource_table()

    async def runtime_capabilities(self, session: AsyncSession, principal: RequestPrincipal) -> RuntimeCapabilities:
        return HOSTED_CAPABILITIES

    def user_settings_changed(self, principal: RequestPrincipal) -> None:
        self.settings_changes.append(principal.id)

    async def embedding_refresh_status(
        self, session: AsyncSession, principal: RequestPrincipal, embedding_model_id: str | None
    ) -> EmbeddingRefreshStatus:
        # These compositions keep no vectors, so any embeddings role is current.
        state = EMBEDDINGS_STATE_OFF if embedding_model_id is None else EMBEDDINGS_STATE_CURRENT
        return EmbeddingRefreshStatus(state=state)

    async def admit_chat_turn(
        self, principal: RequestPrincipal, admission: ChatTurnAdmission
    ) -> RecordingChatTurnLease:
        return await self.chat_guard.admit(principal, admission)

    def chat_turn(self, principal: RequestPrincipal, lease: ChatTurnLease) -> FakeChatTurnServices:
        return FakeChatTurnServices(
            model_clients=self.model_clients, speech=self.speech, gemini_speech=self.gemini_speech
        )

    async def memory_manager(self, session: AsyncSession, principal: RequestPrincipal) -> MemoryManagerService:
        # The model-free runtime drafts an approval for any message naming a markdown path.
        return await local_memory_manager_service(
            session,
            principal.id,
            roles=model_role_resolver(cast(ProductPorts, self), self.repositories(session)),
            runtime_settings=Settings(anima_memory_file_max_bytes=TEST_POLICY.memory_file_max_bytes),
            llm_skip=True,
        )


class DeferredCommitFailed(RuntimeError):
    """A deferred commit that ``DeferredCommitPorts.fail_next_commit`` failed."""


@dataclass
class DeferredCommitPorts(DoubleCollaborators):
    """Ports whose write sessions defer handler commits to the session's end.

    A handler's ``session.commit()`` only flushes. When the session ends after the
    handler returned, the composition commits if the handler asked to and rolls back
    otherwise; it also rolls back if the handler raised. This is the commit authority
    a hosted consumer keeps (for example to settle metering first). Limits: changes
    made after the last requested commit are committed with it, and
    ``session.begin()`` after a deferred commit fails because a transaction is open.
    Read sessions refuse to flush or commit, so a route classified ``read`` that
    writes fails its test. Each opened session records its owner in ``owners``.
    With ``fail_next_commit`` set, the next deferred commit rolls back and raises
    instead, as a composition's commit or lease recheck can.
    """

    session_factory: async_sessionmaker[AsyncSession]
    policy: ProductPolicy = field(default_factory=lambda: TEST_POLICY)
    model_catalog_policy: ModelCatalogPolicy = field(default_factory=ModelCatalogPolicy)
    model_role_defaults: ModelRoleDefaults = field(default_factory=lambda: TEST_ROLE_DEFAULTS)
    speech: FakeSpeech = field(default_factory=FakeSpeech)
    gemini_speech: FakeGeminiSpeech | None = None
    chat_policy: ChatTurnPolicy = field(default_factory=lambda: TEST_CHAT_POLICY)
    chat_guard: RecordingChatGuard = field(default_factory=RecordingChatGuard)
    model_clients: ModelClientRegistry | None = None
    commits_requested: int = 0
    commits: int = 0
    rollbacks: int = 0
    fail_next_commit: bool = False
    owners: list[str] = field(default_factory=list)
    settings_changes: list[str] = field(default_factory=list)
    content_root: Path | None = None

    @asynccontextmanager
    async def read_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        self.owners.append(principal.id)
        async with self.session_factory() as session:

            def refuse_flush(*_: object) -> None:
                raise AssertionError("a read session flushed changes")

            async def refuse_commit() -> None:
                raise AssertionError("a read session committed")

            event.listen(session.sync_session, "before_flush", refuse_flush)
            session.commit = refuse_commit  # type: ignore[method-assign]
            yield session

    @asynccontextmanager
    async def write_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        self.owners.append(principal.id)
        async with self.session_factory() as session:
            commit = session.commit
            requested = False

            async def deferred_commit() -> None:
                nonlocal requested
                requested = True
                self.commits_requested += 1
                await session.flush()

            session.commit = deferred_commit  # type: ignore[method-assign]
            try:
                yield session
            except BaseException:
                await session.rollback()
                self.rollbacks += 1
                raise
            if requested and self.fail_next_commit:
                self.fail_next_commit = False
                await session.rollback()
                self.rollbacks += 1
                raise DeferredCommitFailed("the composition's deferred commit failed")
            if requested:
                await commit()
                self.commits += 1
            else:
                await session.rollback()
                self.rollbacks += 1


@dataclass
class SessionPorts(DoubleCollaborators):
    """Ports that hand every shared route one existing session.

    For tests that mount shared routers beside local routers sharing one test session.
    """

    session: AsyncSession
    policy: ProductPolicy = field(default_factory=lambda: TEST_POLICY)
    model_catalog_policy: ModelCatalogPolicy = field(default_factory=ModelCatalogPolicy)
    model_role_defaults: ModelRoleDefaults = field(default_factory=lambda: TEST_ROLE_DEFAULTS)
    speech: FakeSpeech = field(default_factory=FakeSpeech)
    gemini_speech: FakeGeminiSpeech | None = None
    chat_policy: ChatTurnPolicy = field(default_factory=lambda: TEST_CHAT_POLICY)
    chat_guard: RecordingChatGuard = field(default_factory=RecordingChatGuard)
    model_clients: ModelClientRegistry | None = None
    settings_changes: list[str] = field(default_factory=list)
    content_root: Path | None = None

    @asynccontextmanager
    async def read_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        yield self.session

    write_session = read_session


def install_local_ports(app: FastAPI, session: AsyncSession) -> None:
    """Serve shared routes through the local composition's ports, on one test session.

    For local-app tests that need local behavior from a shared route (personalization,
    the local crisis table or capability report) beside local routes on that session.
    """

    @asynccontextmanager
    async def session_factory() -> AsyncIterator[AsyncSession]:
        yield session

    app.state.session_factory = session_factory
    install_product_ports(app, LocalProductPorts(app))


def local_turn_sessions(session_factory: Any, owner: str) -> TurnSessions:
    """A chat turn's short-lived owner sessions, opened as the local composition opens them."""

    app = FastAPI()
    app.state.session_factory = session_factory
    return TurnSessions(LocalProductPorts(app), RequestPrincipal(id=owner))


def local_ports(*, policy: ModelCatalogPolicy | None = None) -> LocalProductPorts:
    """The local composition's ports for direct handler calls that pass their own session.

    The policy defaults to the local one (owner models and roles); runtime settings are the process's.
    """

    app = FastAPI()
    app.state.model_catalog_policy = policy or ModelCatalogPolicy.local()
    return LocalProductPorts(app)


def product_app(*routers: APIRouter, ports: ProductPorts | None, resolver: Any = None) -> FastAPI:
    """A bare app mounting shared routers with explicit ports and resolver."""

    app = FastAPI()
    app.state.request_principal_resolver = resolver or HeaderOwnerResolver()
    if ports is not None:
        install_product_ports(app, ports)
    for router in routers:
        app.include_router(router)
    return app


@dataclass
class TwoOwnerComposition:
    """Two owners served by one app and one database, each with its own root."""

    app: FastAPI
    root: Path
    owners: tuple[str, str] = ("owner-a", "owner-b")
    roots: dict[str, Path] = field(init=False)

    def __post_init__(self) -> None:
        self.roots = {}
        for owner in self.owners:
            self.roots[owner] = self.root / owner
            self.roots[owner].mkdir(parents=True)

    def client(self, owner: str) -> AsyncClient:
        """A client whose requests resolve to ``owner``, on the test's event loop."""

        return AsyncClient(transport=ASGITransport(app=self.app), base_url="http://test", headers={OWNER_HEADER: owner})
