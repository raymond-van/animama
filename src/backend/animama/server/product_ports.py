"""The local composition's ports for the shared product routes (ADR 0021)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.content_store.private_file_store import FilesystemPrivateFileStorage
from animama.adapters.repositories.sqlalchemy.anima_aggregate_uow import SQLAlchemyAnimaAggregateUnitOfWork
from animama.adapters.repositories.sqlalchemy.anima_package_source_repo import SQLAlchemyAnimaPackageSourceRepository
from animama.adapters.repositories.sqlalchemy.avatar_face_part_override_repo import (
    SQLAlchemyAvatarFacePartOverrideRepository,
)
from animama.adapters.repositories.sqlalchemy.avatar_setting_override_repo import (
    SQLAlchemyAvatarSettingOverrideRepository,
)
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.adapters.repositories.sqlalchemy.user_profile_repo import SQLAlchemyUserProfileRepository
from animama.app.contracts.runtime_capabilities import RuntimeCapabilities
from animama.app.model_clients import ModelClientRegistry
from animama.app.ports.text_embedder import TextEmbedder
from animama.app.safety.crisis_resources import CrisisResourceTable
from animama.app.services.anima_package_source_service import AnimaPackageSourceService
from animama.app.services.anima_runtime_service import AnimaRuntimeService
from animama.app.services.avatar_face_parts_service import AvatarFacePartsService
from animama.app.services.avatar_settings_service import AvatarSettingsService
from animama.app.services.chat_compaction_service import ChatCompactionSettings
from animama.app.services.chat_title_generation_service import ChatTitleGenerationSettings
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_package_export import DownloadLease
from animama.app.services.content_package_service import ContentPackageService
from animama.app.services.content_package_staging import PackageStageService
from animama.app.services.content_save_service import ContentSaveService
from animama.app.services.embedding_refresh_service import EmbeddingRefreshStatus
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy
from animama.app.services.model_role_resolver import ModelRoleDefaults
from animama.app.services.typed_content_service import TypedContentService
from animama.app.web_search import WebSearchToolService
from animama.domain.content_catalog import VerifiedContentFile
from animama.domain.request_principal import RequestPrincipal
from animama.product_http.delivery import (
    DeferredJsonBody,
    PackageDownloadResponse,
    encoded_json_response,
    verified_file_response,
)
from animama.product_http.ports import (
    ChatTurnAdmission,
    ChatTurnLease,
    ChatTurnOutcome,
    ChatTurnPolicy,
    ChatUtilityPurpose,
    ProductContent,
    ProductPolicy,
    ProductRefusal,
    ProductUploads,
    model_role_resolver,
)
from animama.server.chatgpt_plan import chatgpt_plan_session_for
from animama.server.companion_safety import runtime_crisis_resources
from animama.server.config import Settings
from animama.server.deps import get_async_session_factory
from animama.server.elevenlabs_service import LocalSpeech
from animama.server.embedding_refresh import (
    embedding_refresh_status,
    get_embedding_refresh_worker,
    wake_embedding_refresh,
)
from animama.server.embeddings import role_embedder
from animama.server.episode_processing import wake_automatic_episode_processing
from animama.server.gemini_tts_service import LocalGeminiSpeech
from animama.server.installation_personalization import (
    FirstRunIncompleteError,
    InstallationPersonalizationService,
    InstallationPrincipalMismatchError,
)
from animama.server.local_runtime import LocalRuntimePaths, local_content_store
from animama.server.memory_manager import local_memory_manager_service
from animama.server.model_clients import get_model_client_registry
from animama.server.model_roles import ModelRoleSettings, composition_model_policy, model_role_defaults
from animama.server.runtime_capabilities import local_runtime_capabilities, runtime_settings_for
from animama.server.web_search import composition_web_search_enabled, turn_web_search_tool


def local_product_content(
    session: AsyncSession, paths: LocalRuntimePaths, settings: Settings, stages: PackageStageService
) -> ProductContent:
    """Build the local content services over ``session``, existing runtime paths and ``stages``.

    Nothing here creates directories: startup prepared ``paths``, and the caller
    reuses one package-stage coordinator rather than building one per request.
    """

    store = local_content_store(paths)
    catalog = SQLAlchemyContentCatalog(session)
    content = ContentCatalogService(store=store, catalog=catalog)
    saves = ContentSaveService(content=content)
    overrides = SQLAlchemyAvatarFacePartOverrideRepository(session)
    settings_overrides = SQLAlchemyAvatarSettingOverrideRepository(session)
    packages = ContentPackageService(
        content=content,
        stages=stages,
        exports_root=paths.exports_staging_root,
        imports_root=paths.imports_staging_root,
        anima_sources=AnimaPackageSourceService(
            catalog=content.mutations.catalog,
            sources=SQLAlchemyAnimaPackageSourceRepository(session),
            max_identity_bytes=settings.anima_memory_file_max_bytes,
        ),
        profiles=SQLAlchemyUserProfileRepository(session),
        uow=SQLAlchemyAnimaAggregateUnitOfWork(session),
        default_model_provider_id=settings.anima_default_model_provider_id,
        max_identity_bytes=settings.anima_memory_file_max_bytes,
        face_part_overrides=overrides,
        avatar_setting_overrides=settings_overrides,
    )
    return ProductContent(
        catalog=content,
        saves=saves,
        typed=TypedContentService(catalog=catalog, content=content),
        face_parts=AvatarFacePartsService(
            catalog=catalog, overrides=overrides, store=store, saves=saves, commit=session.commit
        ),
        packages=packages,
        store=store,
        runtime=AnimaRuntimeService(session, store=store),
        avatar_settings=AvatarSettingsService(catalog=catalog, overrides=settings_overrides, commit=session.commit),
    )


class LocalChatTurnLease:
    """The local guard admits every turn: one owner, no metering and no session lease."""

    def __init__(self, app: FastAPI) -> None:
        self._app = app

    async def check(self) -> None:
        return None

    async def settle(self, outcome: ChatTurnOutcome) -> None:
        # The turn and its episode note are saved by now; check whether enough notes are pending.
        wake_automatic_episode_processing(self._app)


class LocalChatTurnServices:
    """A local turn's collaborators: the app's model clients, owner web search and embeddings."""

    def __init__(self, app: FastAPI, principal: RequestPrincipal) -> None:
        self._app = app
        self._principal = principal

    @property
    def model_clients(self) -> ModelClientRegistry | None:
        return get_model_client_registry(self._app)

    def utility_model_clients(self, purpose: ChatUtilityPurpose) -> ModelClientRegistry | None:
        # Local compaction and titles use the app's one registry; nothing is metered.
        return get_model_client_registry(self._app)

    async def web_search_tool(self, session: AsyncSession) -> WebSearchToolService | None:
        return await turn_web_search_tool(session, enabled=composition_web_search_enabled(self._app))

    async def attachment_embedder(self, session: AsyncSession) -> TextEmbedder | None:
        return await role_embedder(session, self._principal.id, ModelRoleSettings.for_app(self._app))

    @property
    def speech(self) -> LocalSpeech:
        return LocalSpeech(runtime_settings_for(self._app))

    @property
    def gemini_speech(self) -> LocalGeminiSpeech:
        # The key and the concurrency limit stay process-wide in gemini_tts_service.
        return LocalGeminiSpeech()

    @property
    def server_speech_text(self) -> None:
        # Local speech sessions are direct: the browser speaks with a provider token.
        return None


# Bytes named by an exact runtime revision (ADR 0028) or an Included file's digest
# (ADR 0033) never change under that name.
IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable"


def local_file_response(
    file: VerifiedContentFile, *, if_none_match: str | None, revalidate: bool, immutable: bool = False
) -> Response:
    """The local policy: private bytes kept for a year when immutable, else revalidated
    by ETag, or never stored (which ``immutable`` cannot override); no Range or HEAD."""

    if not revalidate:
        cache_control = "private, no-store"
    else:
        cache_control = IMMUTABLE_PRIVATE if immutable else "private, no-cache"
    return verified_file_response(file, if_none_match=if_none_match, cache_control=cache_control)


class LocalProductPorts:
    """Serve shared routes from the local app's own database resources.

    Construction performs no IO: each session resolves the app's lazily created
    factory when it opens. The installation has one owner, so sessions do not vary
    by principal, and local handlers' commits take effect immediately.
    """

    def __init__(self, app: FastAPI) -> None:
        self._app = app
        self._stages: tuple[LocalRuntimePaths, PackageStageService] | None = None

    def _package_stages(self, paths: LocalRuntimePaths) -> PackageStageService:
        # Building a coordinator ensures its roots exist, so build one per runtime
        # layout rather than per request.
        if self._stages is None or self._stages[0] is not paths:
            self._stages = (
                paths,
                PackageStageService(imports_root=paths.imports_staging_root, exports_root=paths.exports_staging_root),
            )
        return self._stages[1]

    @property
    def policy(self) -> ProductPolicy:
        # The app's own runtime settings, read per request like the sessions.
        settings = runtime_settings_for(self._app)
        return ProductPolicy(
            memory_file_max_bytes=settings.anima_memory_file_max_bytes,
            voice_catalog_max_upload_bytes=settings.anima_pocket_voice_catalog_max_upload_bytes,
            private_upload_ttl_seconds=settings.private_upload_url_ttl_seconds,
        )

    @property
    def model_catalog_policy(self) -> ModelCatalogPolicy:
        # create_local_app installs ModelCatalogPolicy.local(): owner models, no validation.
        return composition_model_policy(self._app)

    @property
    def model_role_defaults(self) -> ModelRoleDefaults:
        return model_role_defaults(runtime_settings_for(self._app))

    @property
    def speech(self) -> LocalSpeech:
        # Credentials, retries and the concurrency limit stay process-wide in elevenlabs_service.
        return LocalSpeech(runtime_settings_for(self._app))

    @property
    def chat_policy(self) -> ChatTurnPolicy:
        settings = runtime_settings_for(self._app)
        return ChatTurnPolicy(
            compaction=ChatCompactionSettings(
                enabled=settings.anima_chat_compaction_enabled,
                threshold_tokens=settings.anima_chat_compaction_threshold_tokens,
                recent_message_min_count=settings.anima_chat_compaction_recent_message_min_count,
                prompt_version=settings.anima_chat_compaction_prompt_version,
            ),
            presend_compaction_timeout_seconds=settings.anima_chat_presend_compaction_timeout_seconds,
            title_generation=ChatTitleGenerationSettings(
                enabled=settings.anima_chat_title_generation_enabled,
                prompt_version=settings.anima_chat_title_generation_prompt_version,
                max_chars=settings.anima_chat_title_generation_max_chars,
                timeout_seconds=settings.anima_chat_title_generation_timeout_seconds,
                reasoning_effort=settings.anima_chat_title_generation_reasoning_effort,
            ),
            companion_safety=settings.companion_safety,
        )

    async def admit_chat_turn(self, principal: RequestPrincipal, admission: ChatTurnAdmission) -> ChatTurnLease:
        return LocalChatTurnLease(self._app)

    def chat_turn(self, principal: RequestPrincipal, lease: ChatTurnLease) -> LocalChatTurnServices:
        return LocalChatTurnServices(self._app, principal)

    @asynccontextmanager
    async def read_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        async with get_async_session_factory(self._app)() as session:
            yield session

    write_session = read_session

    def repositories(self, session: AsyncSession) -> SQLAlchemyProductRepositories:
        return SQLAlchemyProductRepositories(session)

    def _runtime_paths(self) -> LocalRuntimePaths:
        # Startup prepares the runtime paths; a request never creates them.
        paths = getattr(self._app.state, "local_runtime_paths", None)
        if not isinstance(paths, LocalRuntimePaths):
            raise HTTPException(status_code=503, detail={"code": "content_unavailable"})
        return paths

    @asynccontextmanager
    async def content(self, session: AsyncSession, principal: RequestPrincipal) -> AsyncIterator[ProductContent]:
        paths = self._runtime_paths()
        yield local_product_content(session, paths, runtime_settings_for(self._app), self._package_stages(paths))

    def uploads(self, principal: RequestPrincipal) -> ProductUploads:
        # One installation owner: its private files live under the data root's allowlisted areas.
        paths = self._runtime_paths()
        if not paths.uploads_staging_root.is_dir():
            # Startup created it; a request never recreates a missing or unmounted root.
            raise HTTPException(status_code=503, detail={"code": "uploads_unavailable"})
        return ProductUploads(
            private_files=FilesystemPrivateFileStorage(paths), staging_directory=paths.uploads_staging_root
        )

    def file_response(
        self,
        request: Request,
        file: VerifiedContentFile,
        *,
        if_none_match: str | None,
        revalidate: bool,
        immutable: bool = False,
    ) -> Response:
        return local_file_response(file, if_none_match=if_none_match, revalidate=revalidate, immutable=immutable)

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
        return await encoded_json_response(
            body, encoding=encoding, headers=headers, if_none_match=if_none_match, cacheable=cacheable
        )

    def download_response(self, request: Request, download: DownloadLease) -> Response:
        return PackageDownloadResponse(download)

    async def update_display_name(self, session: AsyncSession, principal: RequestPrincipal, display_name: str) -> str:
        # The installation owner's name also personalizes its memory files.
        try:
            result = await InstallationPersonalizationService(session).update_display_name(
                principal_id=principal.id, display_name=display_name
            )
        except FirstRunIncompleteError as exc:
            raise ProductRefusal(409, "first_run_incomplete") from exc
        except InstallationPrincipalMismatchError as exc:
            raise ProductRefusal(403, "installation_principal_mismatch") from exc
        return result.display_name

    def crisis_resources(self) -> CrisisResourceTable:
        # The packaged table, or an operator-supplied one (ANIMAMA_CRISIS_RESOURCES_PATH).
        return runtime_crisis_resources(runtime_settings_for(self._app))

    async def runtime_capabilities(self, session: AsyncSession, principal: RequestPrincipal) -> RuntimeCapabilities:
        return await local_runtime_capabilities(self._app, session)

    def user_settings_changed(self, principal: RequestPrincipal) -> None:
        # The embeddings role may have changed; re-check stored vectors now.
        wake_embedding_refresh(self._app)
        # Memory flags or the Memory Manager model may have changed too.
        wake_automatic_episode_processing(self._app)

    async def embedding_refresh_status(
        self, session: AsyncSession, principal: RequestPrincipal, embedding_model_id: str | None
    ) -> EmbeddingRefreshStatus:
        # The app's refresh worker reports why a pass is retrying.
        return await embedding_refresh_status(
            session,
            owner_id=principal.id,
            embedding_model_id=embedding_model_id,
            worker=get_embedding_refresh_worker(self._app),
        )

    async def memory_manager(self, session: AsyncSession, principal: RequestPrincipal) -> MemoryManagerService:
        return await local_memory_manager_service(
            session,
            principal.id,
            roles=model_role_resolver(self, self.repositories(session)),
            runtime_settings=runtime_settings_for(self._app),
            chatgpt_plan_session=lambda: chatgpt_plan_session_for(self._app),
        )
