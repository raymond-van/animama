"""Ports each composition installs for the shared product routes (ADR 0021).

A composition installs one ``ProductPorts`` object with ``install_product_ports``
when it builds its app. Shared handlers obtain every collaborator through it and
never construct repositories or stores or read process-global settings. Without
ports, shared routes fail closed with 503 ``product_ports_unavailable``. Families add
the ports they need as they move into this package.
"""

from __future__ import annotations

import math
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal, Protocol, cast
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.contracts.chat import PyAnimaChatRequest
from animama.app.contracts.elevenlabs import (
    PyElevenLabsAudioResponse,
    PyElevenLabsRealtimeTtsSessionResponse,
    PyElevenLabsSoundEffectsRequest,
    PyElevenLabsTextToSpeechRequest,
    PyElevenLabsVoice,
)
from animama.app.contracts.runtime_capabilities import RuntimeCapabilities
from animama.app.model_clients import ModelClientRegistry
from animama.app.ports.anima_chat_profile_port import AnimaChatProfileRepository
from animama.app.ports.anima_port import AnimaRepository
from animama.app.ports.anima_presentation_port import AnimaPresentationRepository
from animama.app.ports.anima_runtime_snapshot_port import AnimaRuntimeSnapshotReader
from animama.app.ports.avatar_port import AvatarRepository
from animama.app.ports.chat_compaction_port import ChatCompactionRepository
from animama.app.ports.chat_message_port import ChatMessageRepository
from animama.app.ports.chat_port import ChatRepository
from animama.app.ports.companion_safety_port import CompanionSafetyStateRepository
from animama.app.ports.content_catalog import ContentCatalog
from animama.app.ports.content_store import ContentStore
from animama.app.ports.memory_entry_port import MemoryEntryRepository
from animama.app.ports.memory_episode_port import MemoryEpisodeRepository
from animama.app.ports.model_provider_port import ModelProviderRepository
from animama.app.ports.private_file_storage import PrivateFileStorage
from animama.app.ports.settings_port import AnimaSettingsRepository, UserSettingsRepository
from animama.app.ports.text_embedder import TextEmbedder
from animama.app.ports.uow_port import UnitOfWork
from animama.app.ports.user_file_processing_port import UserFileProcessingRepository
from animama.app.ports.user_profile_port import UserProfileRepository
from animama.app.ports.voice_catalog_upload_port import VoiceCatalogUploadRepository
from animama.app.safety.config import OperatorSafetyConfig
from animama.app.safety.crisis_resources import CrisisResourceTable
from animama.app.safety.moderation import CrisisModerator
from animama.app.services.anima_loadout_service import AnimaLoadoutService
from animama.app.services.anima_runtime_service import AnimaRuntimeService
from animama.app.services.avatar_face_parts_service import AvatarFacePartsService
from animama.app.services.avatar_settings_service import AvatarSettingsService
from animama.app.services.chat_compaction_service import ChatCompactionSettings
from animama.app.services.chat_title_generation_service import ChatTitleGenerationSettings
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_package_export import DownloadLease
from animama.app.services.content_package_service import ContentPackageService
from animama.app.services.content_save_service import ContentSaveService
from animama.app.services.embedding_refresh_service import EmbeddingRefreshStatus
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy
from animama.app.services.model_role_resolver import ModelRoleDefaults, ModelRoleResolver
from animama.app.services.typed_content_service import TypedContentService
from animama.app.web_search import WebSearchToolService
from animama.domain.content_catalog import VerifiedContentFile
from animama.domain.request_principal import RequestPrincipal
from animama.product_http.delivery import DeferredJsonBody
from animama.product_http.principal import get_current_principal


class ProductRepositories(Protocol):
    """Repositories over one owner session; families add theirs as they move."""

    @property
    def animas(self) -> AnimaRepository: ...

    @property
    def anima_chat_profiles(self) -> AnimaChatProfileRepository: ...

    @property
    def anima_presentations(self) -> AnimaPresentationRepository: ...

    @property
    def model_providers(self) -> ModelProviderRepository:
        """The composition's model catalog, which an Anima's chat model must name."""
        ...

    @property
    def chats(self) -> ChatRepository: ...

    @property
    def chat_messages(self) -> ChatMessageRepository: ...

    @property
    def chat_compactions(self) -> ChatCompactionRepository: ...

    @property
    def memory_entries(self) -> MemoryEntryRepository: ...

    @property
    def memory_episodes(self) -> MemoryEpisodeRepository: ...

    @property
    def user_settings(self) -> UserSettingsRepository: ...

    @property
    def anima_settings(self) -> AnimaSettingsRepository: ...

    @property
    def user_profiles(self) -> UserProfileRepository: ...

    @property
    def avatars(self) -> AvatarRepository: ...

    @property
    def content_catalog(self) -> ContentCatalog:
        """The owner's view of the content catalog, without content stores."""
        ...

    @property
    def anima_loadouts(self) -> AnimaLoadoutService:
        """The Anima loadout aggregate, which works on the session directly."""
        ...

    @property
    def voice_catalog_uploads(self) -> VoiceCatalogUploadRepository: ...

    @property
    def user_file_processing(self) -> UserFileProcessingRepository:
        """Uploaded files a chat turn may search; a composition without them reports none."""
        ...

    @property
    def companion_safety(self) -> CompanionSafetyStateRepository: ...

    @property
    def anima_runtime_snapshots(self) -> AnimaRuntimeSnapshotReader: ...

    @property
    def unit_of_work(self) -> UnitOfWork: ...


@dataclass(frozen=True)
class DenialDetails:
    """The optional fields a denial carries beside its code (``contracts/hosted-web.md``, "Hosted denials").

    ``limit`` names the exhausted limit (a string, or a count such as a chat
    allowance), ``retry_after_seconds`` is the wait before a retry can succeed,
    ``max_characters`` is the longest accepted message and ``download_url`` is an
    absolute ``https:`` URL, without credentials, where the user can download the
    desktop app. Unset fields are omitted.
    """

    limit: str | int | None = None
    retry_after_seconds: float | None = None
    max_characters: int | None = None
    download_url: str | None = None

    def __post_init__(self) -> None:
        limit = self.limit
        if limit is not None and not ((type(limit) is str and limit) or (type(limit) is int and limit >= 0)):
            raise ValueError("a denial's limit is a non-empty name or a count")
        retry = self.retry_after_seconds
        if retry is not None and (type(retry) not in (int, float) or not math.isfinite(retry) or retry < 0):
            raise ValueError("a denial's retry_after_seconds is a finite, non-negative wait")
        if self.max_characters is not None and (type(self.max_characters) is not int or self.max_characters < 1):
            raise ValueError("a denial's max_characters is a positive count")
        if self.download_url is not None:
            url = urlsplit(self.download_url)
            if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None:
                raise ValueError("a denial's download_url is an absolute https: URL without credentials")

    def fields(self) -> dict[str, object]:
        """The set fields, as a denial body or error frame carries them."""

        values = (
            ("limit", self.limit),
            ("retry_after_seconds", self.retry_after_seconds),
            ("max_characters", self.max_characters),
            ("download_url", self.download_url),
        )
        return {name: value for name, value in values if value is not None}


class ProductRefusal(Exception):
    """A composition-specific refusal a shared route reports as ``detail.code`` with its status.

    ``details`` adds the contract's denial fields: beside the code in an HTTP
    refusal, and on the error frame of a turn the refusal ends (a model request's
    call boundary, web search or the composition's deferred commit of a turn write
    may raise it while the turn runs).
    """

    def __init__(self, status_code: int, code: str, *, details: DenialDetails | None = None) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.details = details if details is not None else DenialDetails()


def refusal_error(exc: ProductRefusal) -> HTTPException:
    """The HTTP error a shared route raises for a composition's refusal.

    A 429 or 503 refusal with a known wait also sends it as ``Retry-After`` in whole seconds.
    """

    retry = exc.details.retry_after_seconds
    headers = {"Retry-After": str(math.ceil(retry))} if retry is not None and exc.status_code in (429, 503) else None
    return HTTPException(
        status_code=exc.status_code, detail={"code": exc.code, **exc.details.fields()}, headers=headers
    )


@dataclass(frozen=True)
class ProductContent:
    """Content services for one owner over one session.

    A composition builds them on the session its ports opened and may release
    resources when the request ends. ``avatar_settings`` is optional: a
    composition that stores no per-owner Avatar settings leaves it ``None``
    (and builds its package service without them).
    """

    catalog: ContentCatalogService
    saves: ContentSaveService
    typed: TypedContentService
    face_parts: AvatarFacePartsService
    packages: ContentPackageService
    store: ContentStore
    runtime: AnimaRuntimeService
    avatar_settings: AvatarSettingsService | None = None


VoiceResolver = Callable[[], Awaitable[PyElevenLabsVoice]]
"""Looks up the Anima's ElevenLabs voice when a speech operation needs it."""


class FinalizedSpeech(Protocol):
    """One reply segment prepared for finalized speech (Gemini)."""

    @property
    def voice_id(self) -> str: ...

    @property
    def model_id(self) -> str: ...

    @property
    def output_format(self) -> str: ...


class FinalizedSpeechPort(Protocol):
    """Finalized speech for a chat reply: each segment prepared, then streamed as PCM payloads.

    A composition may offer it for Gemini through ``ChatTurnServices.gemini_speech``;
    ElevenLabs speaks in realtime instead.
    """

    async def prepare_finalized(
        self,
        principal: RequestPrincipal,
        *,
        voice_id: str,
        anima_id: str,
        run_id: str,
        text: str,
        model_id: str | None,
        emotional_tone: str | None,
        emotional_state: dict[str, int] | None,
        language_code: str | None = None,
    ) -> FinalizedSpeech:
        """Prepare one reply segment with the voice the turn resolved for the Anima.

        ``language_code`` is the conversation language (ISO 639-1), or ``None`` to
        let the provider detect it.
        """
        ...

    def stream_finalized(self, prepared: FinalizedSpeech) -> AsyncIterator[dict[str, Any]]:
        """Stream the segment's audio as ``audio`` payloads, then ``done`` or ``error``."""
        ...


class ProductSpeech(Protocol):
    """Paid speech operations a composition offers its owners (ElevenLabs).

    The composition holds the provider credentials, retries, concurrency and any
    metering; it refuses an operation it does not offer with ``ProductRefusal`` (or
    an ``HTTPException`` with its own body). ``audio_upload_max_bytes`` bounds each
    uploaded sample. The chat-turn operation (``realtime_session``) resolves the
    Anima's voice through the ``voice`` the turn supplies, after the composition's
    own checks. It declines a reply's speech with ``ProductRefusal``, whose code
    and status ``tts.session.error`` carries; other errors' messages reach the
    browser in that frame, so they must be safe to show.
    """

    @property
    def audio_upload_max_bytes(self) -> int: ...

    async def clone_voice(
        self,
        principal: RequestPrincipal,
        *,
        name: str,
        files: list[tuple[str, bytes, str]],
        description: str | None,
        remove_background_noise: bool,
    ) -> PyElevenLabsVoice:
        """Clone a voice from ``(filename, bytes, content type)`` samples, owned by ``principal``."""
        ...

    async def synthesize_text(
        self, principal: RequestPrincipal, request: PyElevenLabsTextToSpeechRequest
    ) -> PyElevenLabsAudioResponse:
        """Speak ``request.text`` with one of ``principal``'s voices."""
        ...

    async def generate_sound_effect(
        self, principal: RequestPrincipal, request: PyElevenLabsSoundEffectsRequest
    ) -> PyElevenLabsAudioResponse:
        """Generate a sound effect for ``principal`` from ``request.text``."""
        ...

    async def realtime_session(
        self,
        principal: RequestPrincipal,
        *,
        voice: VoiceResolver,
        language_code: str | None,
        model_id: str | None,
    ) -> PyElevenLabsRealtimeTtsSessionResponse:
        """Describe a realtime speech session for one chat reply.

        A direct session carries a provider token. A composition that speaks
        through its own socket instead returns ``transport="server"`` with that
        socket's ``websocket_url``, and receives the reply's text through
        ``ChatTurnServices.server_speech_text``.
        """
        ...


@dataclass(frozen=True)
class ChatTurnPolicy:
    """How a composition runs chat turns.

    ``public_error_text``, when set, replaces the text and details of the turn's
    ``error`` frames, and their codes outside a short lowercase pattern become
    ``turn_failed``, so model-provider detail never reaches a browser. Speech error
    frames carry the speech port's own messages. The local composition keeps both.

    ``crisis_moderator``, when set, checks the user's message on Anthropic
    Messages turns, which have no inline moderation, so they can show the crisis
    card too. The local composition sets none.
    """

    compaction: ChatCompactionSettings
    presend_compaction_timeout_seconds: float
    title_generation: ChatTitleGenerationSettings
    companion_safety: OperatorSafetyConfig
    public_error_text: str | None = None
    crisis_moderator: CrisisModerator | None = None


@dataclass(frozen=True)
class ChatTurnAdmission:
    """A chat turn asking to start: its Anima, chat and run, and the parsed request."""

    anima_id: str
    chat_id: str
    run_id: str
    request: PyAnimaChatRequest


@dataclass(frozen=True)
class ChatTurnStop:
    """Why a composition ends a running turn: the error frame's code, message and any denial fields."""

    code: str
    message: str
    details: DenialDetails = field(default_factory=DenialDetails)


ChatTurnOutcome = Literal["unstarted", "completed", "failed", "interrupted"]
"""How an admitted turn ended: nothing dispatched (setup failed), the reply saved (or an
incognito turn finished), an error before the save, or a stop or disconnect before it."""


class ChatTurnLease(Protocol):
    """The composition's hold on one admitted chat turn."""

    async def check(self) -> ChatTurnStop | None:
        """Return a stop when the turn must end now.

        Awaited before each event the stream drains while the model runs (at least
        every 50 ms while the client keeps reading) and before each step and frame of
        a successful reply's completion (speech, title, compaction), so it must
        return quickly. A stop before the
        reply is saved ends the turn with an error frame; afterwards the remaining
        optional work is skipped.
        """
        ...

    async def settle(self, outcome: ChatTurnOutcome) -> None:
        """Called exactly once, after every turn task stopped, shielded from cancellation.

        A request that fails before its response runs, including when the
        composition's own commit of the setup session fails, settles ``unstarted``.
        """
        ...


ChatUtilityPurpose = Literal["pre_send_compaction", "compaction", "title"]
"""A turn's model work besides its reply: compaction before the reply when the chat
would not fit, compaction after a saved reply, and the title of a chat's first turn."""


class ServerSpeechText(Protocol):
    """Receives one ElevenLabs turn's speech text for a composition's own speech socket.

    A composition that serves speech through its own server (a ``transport:
    "server"`` realtime session) speaks the text the turn approved, never text a
    browser sends. The turn calls these on the event loop, so they must not block;
    a composition queues the text for its speech session. ``append`` receives each
    speech piece in reply order, prepared as the browser prepares ElevenLabs chunks:
    emoji removed, audio tags prepared for ElevenLabs (``ProviderSpeechText``) and
    the reply's tone tag before the first piece unless the speech opens with its
    own direction. Text is handed over only once the turn's realtime session is a
    server session (pieces that arrived earlier follow at once); a direct,
    declined or failed session's sink hears nothing. ``end`` follows the reply's
    last piece. ``abort`` means the turn stopped, failed or lost its client and its
    speech must stop; it may follow ``end`` (for example a stop after the reply was
    saved), may reach a session still being set up, and nothing follows it. The
    methods must not raise: a failure is logged and the turn goes on.
    """

    def append(self, text: str) -> None: ...

    def end(self) -> None: ...

    def abort(self) -> None: ...


class ChatTurnServices(Protocol):
    """The paid collaborators of one admitted chat turn, which a composition may bind to its lease."""

    @property
    def model_clients(self) -> ModelClientRegistry | None:
        """The registry for the reply's model rounds, or ``None`` while it is unavailable."""
        ...

    def utility_model_clients(self, purpose: ChatUtilityPurpose) -> ModelClientRegistry | None:
        """The registry for one kind of the turn's other model work, or ``None`` to skip it.

        Each purpose asks separately, so a composition can meter or limit it apart
        from the reply's rounds. Asking does not mean the work runs (a turn asks
        before it knows whether it needs compaction or a title), so a composition
        reserves when a request is made, not here. A composition with one registry
        returns it for every purpose.
        """
        ...

    async def web_search_tool(self, session: AsyncSession) -> WebSearchToolService | None:
        """The turn's web-search tool, or ``None`` when search is off."""
        ...

    async def attachment_embedder(self, session: AsyncSession) -> TextEmbedder | None:
        """The embedder for the turn's attached files, or ``None`` while embeddings are off."""
        ...

    @property
    def speech(self) -> ProductSpeech:
        """The reply's speech operations."""
        ...

    @property
    def gemini_speech(self) -> FinalizedSpeechPort | None:
        """Gemini speech for the reply, or ``None`` where the composition does not offer it.

        Read only when a turn asks for Gemini voice. The turn resolves the Anima's
        prebuilt voice itself and passes it as ``voice_id``.
        """
        ...

    @property
    def server_speech_text(self) -> ServerSpeechText | None:
        """Where an ElevenLabs turn's speech text goes when the composition speaks it
        through its own socket, or ``None`` when its sessions are direct."""
        ...


@dataclass(frozen=True)
class ProductPolicy:
    """Owner limits a composition enforces on the shared routes."""

    memory_file_max_bytes: int
    voice_catalog_max_upload_bytes: int
    # How long a staged upload waits for its bytes.
    private_upload_ttl_seconds: int


@dataclass(frozen=True)
class ProductUploads:
    """Where an owner's staged uploads live: private storage and a spool directory.

    A composition prepares both before serving; a request never creates them (the
    storage creates only each upload's own subdirectories).
    """

    private_files: PrivateFileStorage
    staging_directory: Path


class ProductPorts(Protocol):
    """The composition-owned collaborators of shared product handlers.

    Shared dependencies call the synchronous members (``policy``, ``chat_policy``,
    ``model_catalog_policy``, ``model_role_defaults``, ``speech``, ``uploads``,
    ``chat_turn``, ``repositories``, ``content``, ``file_response``,
    ``download_response``, ``crisis_resources`` and ``user_settings_changed``) on the
    event loop, so they must not block.
    """

    @property
    def policy(self) -> ProductPolicy: ...

    @property
    def model_catalog_policy(self) -> ModelCatalogPolicy:
        """Which catalog rows this composition offers, and whether it validates role preferences."""
        ...

    @property
    def model_role_defaults(self) -> ModelRoleDefaults:
        """The operator's row for each model role, used when an owner assigns none."""
        ...

    def read_session(self, principal: RequestPrincipal) -> AbstractAsyncContextManager[AsyncSession]:
        """Open a session for a handler that only reads ``principal``'s data."""
        ...

    def write_session(self, principal: RequestPrincipal) -> AbstractAsyncContextManager[AsyncSession]:
        """Open a session for a handler that changes ``principal``'s data.

        Handlers commit through the session as usual, but commit authority stays
        with the composition: it may defer a requested commit (for example to
        settle metering or recheck a lease) and must complete or roll it back when
        the context exits. That exit runs after the handler returns and before the
        response is sent.
        """
        ...

    def repositories(self, session: AsyncSession) -> ProductRepositories:
        """The product repositories over a session this composition opened."""
        ...

    def content(
        self, session: AsyncSession, principal: RequestPrincipal
    ) -> AbstractAsyncContextManager[ProductContent]:
        """Content services for ``principal`` over a session this composition opened.

        Through ``ReadContent`` the context stays open until the response ends, so
        streamed bytes remain readable; ``WriteContent`` ends it with its write
        session. A composition releases its content resources on exit.
        """
        ...

    def file_response(
        self,
        request: Request,
        file: VerifiedContentFile,
        *,
        if_none_match: str | None,
        revalidate: bool,
        immutable: bool = False,
    ) -> Response:
        """Deliver verified content bytes under this composition's caching policy.

        ``revalidate`` marks bytes a client may keep and revalidate by ETag; other
        bytes must not be stored. ``immutable`` marks bytes whose URL names them
        exactly, by a runtime revision (ADR 0028) or by an Included file's digest
        (ADR 0033), which a composition may let a client reuse without revalidating.
        The response owns ``file`` and closes its handle. A binary runtime
        bundle arrives here too, as an in-memory frame whose digest is its ETag; it is
        revalidatable and immutable only when every member was read.
        """
        ...

    async def json_response(
        self,
        request: Request,
        body: bytes | DeferredJsonBody,
        *,
        encoding: str,
        headers: dict[str, str],
        if_none_match: str | None,
        cacheable: bool,
    ) -> Response:
        """Deliver private JSON (runtime manifests and bundles, the content catalog)
        under this composition's caching policy.

        ``encoding`` is the negotiated ``gzip`` or ``identity``; ``cacheable`` marks a
        body a client may keep and revalidate by ETag. The content catalog and complete
        runtime JSON bundles arrive as a ``DeferredJsonBody``: ``encoded_json_response``
        answers a matching validator with a 304 before building it. Building the
        catalog reads the request's session, so keep that session and its read
        transaction open until this returns.
        """
        ...

    def download_response(self, request: Request, download: DownloadLease) -> Response:
        """Deliver a sealed package archive; the response owns and releases ``download``."""
        ...

    async def update_display_name(self, session: AsyncSession, principal: RequestPrincipal, display_name: str) -> str:
        """Save ``principal``'s display name on ``session`` and return the stored value.

        Raises ``UserProfileNotFoundError`` or ``UserProfileInvalidError`` for the
        shared profile rules and ``ProductRefusal`` for the composition's own.
        """
        ...

    def crisis_resources(self) -> CrisisResourceTable:
        """The crisis-resource regions this composition offers its owners."""
        ...

    async def runtime_capabilities(self, session: AsyncSession, principal: RequestPrincipal) -> RuntimeCapabilities:
        """What this composition offers ``principal`` now, reading any stored state on ``session``."""
        ...

    def user_settings_changed(self, principal: RequestPrincipal) -> None:
        """Tell the composition ``principal``'s user settings changed.

        Called after the handler requested its commit; a composition that defers
        commits acts on it once the commit completes.
        """
        ...

    async def embedding_refresh_status(
        self, session: AsyncSession, principal: RequestPrincipal, embedding_model_id: str | None
    ) -> EmbeddingRefreshStatus:
        """Whether ``principal``'s stored vectors match the row doing the embeddings role.

        ``embedding_model_id`` is that row, or ``None`` while embeddings are off.
        """
        ...

    @property
    def speech(self) -> ProductSpeech:
        """The composition's paid speech operations."""
        ...

    def uploads(self, principal: RequestPrincipal) -> ProductUploads:
        """Private storage and the spool directory for ``principal``'s staged uploads."""
        ...

    @property
    def chat_policy(self) -> ChatTurnPolicy: ...

    async def admit_chat_turn(self, principal: RequestPrincipal, admission: ChatTurnAdmission) -> ChatTurnLease:
        """Admit one chat turn before any write or paid work, or refuse it.

        A composition refuses with its own exception, rendered by its exception
        handlers, or with ``ProductRefusal``; a refused turn has no lease. The
        returned lease is settled exactly once, including when setup, or the
        composition's own commit of the setup session, fails after admission.
        """
        ...

    def chat_turn(self, principal: RequestPrincipal, lease: ChatTurnLease) -> ChatTurnServices:
        """The admitted turn's paid collaborators."""
        ...

    async def memory_manager(self, session: AsyncSession, principal: RequestPrincipal) -> MemoryManagerService:
        """``principal``'s Memory Manager over ``session``, on this composition's model runtime.

        A composition may wrap the service's operations with its own admission and
        refuse one with ``ProductRefusal``, here or from the operation.
        """
        ...


def install_product_ports(app: FastAPI, ports: ProductPorts) -> None:
    """Install a composition's ports; the annotation lets type checks confirm conformance."""
    app.state.product_ports = ports


async def get_product_ports(request: Request) -> ProductPorts:
    """Require the ports installed by the application factory."""
    ports = getattr(request.app.state, "product_ports", None)
    if ports is None:
        raise HTTPException(status_code=503, detail={"code": "product_ports_unavailable"})
    # Starlette state is dynamic; install_product_ports stores this protocol.
    return cast(ProductPorts, ports)


# A session opens only after the principal resolves, so unadmitted requests never
# reach the database, and the composition always knows whose session it opens.
async def get_read_session(
    ports: Annotated[ProductPorts, Depends(get_product_ports)],
    principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> AsyncIterator[AsyncSession]:
    async with ports.read_session(principal) as session:
        yield session


async def get_write_session(
    ports: Annotated[ProductPorts, Depends(get_product_ports)],
    principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> AsyncIterator[AsyncSession]:
    async with ports.write_session(principal) as session:
        yield session


ReadSession = Annotated[AsyncSession, Depends(get_read_session)]
# Function scope ends the session, and any deferred commit, before the response
# is sent, so a failed commit is reported instead of an earlier success. The
# session is therefore closed before a streaming body runs.
WriteSession = Annotated[AsyncSession, Depends(get_write_session, scope="function")]


Ports = Annotated[ProductPorts, Depends(get_product_ports)]


async def get_read_repositories(
    ports: Annotated[ProductPorts, Depends(get_product_ports)], session: ReadSession
) -> ProductRepositories:
    return ports.repositories(session)


async def get_write_repositories(
    ports: Annotated[ProductPorts, Depends(get_product_ports)], session: WriteSession
) -> ProductRepositories:
    return ports.repositories(session)


# Shared handlers take repositories rather than sessions, so they never build one.
ReadRepositories = Annotated[ProductRepositories, Depends(get_read_repositories)]
WriteRepositories = Annotated[ProductRepositories, Depends(get_write_repositories)]


async def get_read_content(
    ports: Annotated[ProductPorts, Depends(get_product_ports)],
    principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    session: ReadSession,
) -> AsyncIterator[ProductContent]:
    async with ports.content(session, principal) as content:
        yield content


async def get_write_content(
    ports: Annotated[ProductPorts, Depends(get_product_ports)],
    principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    session: WriteSession,
) -> AsyncIterator[ProductContent]:
    async with ports.content(session, principal) as content:
        yield content


# Read content stays open through a streamed body; write content ends with its
# session, before the response is sent.
ReadContent = Annotated[ProductContent, Depends(get_read_content)]
WriteContent = Annotated[ProductContent, Depends(get_write_content, scope="function")]


async def get_product_policy(ports: Annotated[ProductPorts, Depends(get_product_ports)]) -> ProductPolicy:
    return ports.policy


Policy = Annotated[ProductPolicy, Depends(get_product_policy)]


def model_role_resolver(ports: ProductPorts, repositories: ProductRepositories) -> ModelRoleResolver:
    """Resolve model roles from the owner's settings, the composition's catalog and its operator defaults."""

    return ModelRoleResolver(
        model_providers=repositories.model_providers,
        user_settings=repositories.user_settings,
        defaults=ports.model_role_defaults,
        # A composition without owner models applies only its operator defaults.
        owner_roles_enabled=ports.model_catalog_policy.owner_models_enabled,
    )
