"""The shared product repositories over one SQLAlchemy owner session (ADR 0021).

Compositions return this bundle from ``ProductPorts.repositories``: the local app
directly, and a hosted consumer on its tenant-bound sessions or wrapped with its own
accounting. Each repository is created on first use and shares the session's
transaction.
"""

from __future__ import annotations

from functools import cached_property

from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.anima_chat_profile_repo import SQLAlchemyAnimaChatProfileRepository
from animama.adapters.repositories.sqlalchemy.anima_presentation_repo import SQLAlchemyAnimaPresentationRepository
from animama.adapters.repositories.sqlalchemy.anima_repo import SQLAlchemyAnimaRepository
from animama.adapters.repositories.sqlalchemy.avatar_repo import SQLAlchemyAvatarRepository
from animama.adapters.repositories.sqlalchemy.chat_compaction_repo import SQLAlchemyChatCompactionRepository
from animama.adapters.repositories.sqlalchemy.chat_message_repo import SQLAlchemyChatMessageRepository
from animama.adapters.repositories.sqlalchemy.chat_repo import SQLAlchemyChatRepository
from animama.adapters.repositories.sqlalchemy.companion_safety_repo import SQLAlchemyCompanionSafetyRepository
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.adapters.repositories.sqlalchemy.memory_entry_repo import SQLAlchemyMemoryEntryRepository
from animama.adapters.repositories.sqlalchemy.memory_episode_repo import SQLAlchemyMemoryEpisodeRepository
from animama.adapters.repositories.sqlalchemy.memory_manager_repo import SQLAlchemyMemoryManagerRepository
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.settings_repo import (
    SQLAlchemyAnimaSettingsRepository,
    SQLAlchemyUserSettingsRepository,
)
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.adapters.repositories.sqlalchemy.user_file_processing_repo import SQLAlchemyUserFileProcessingRepository
from animama.adapters.repositories.sqlalchemy.user_profile_repo import SQLAlchemyUserProfileRepository
from animama.adapters.repositories.sqlalchemy.voice_catalog_upload_repo import SQLAlchemyVoiceCatalogUploadRepository
from animama.app.services.anima_loadout_service import AnimaLoadoutService
from animama.app.services.anima_runtime_service import AnimaRuntimeService


class SQLAlchemyProductRepositories:
    """Repositories for the shared product routes, all on ``session``."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @cached_property
    def animas(self) -> SQLAlchemyAnimaRepository:
        return SQLAlchemyAnimaRepository(self._session)

    @cached_property
    def anima_chat_profiles(self) -> SQLAlchemyAnimaChatProfileRepository:
        return SQLAlchemyAnimaChatProfileRepository(self._session)

    @cached_property
    def anima_presentations(self) -> SQLAlchemyAnimaPresentationRepository:
        return SQLAlchemyAnimaPresentationRepository(self._session)

    @cached_property
    def model_providers(self) -> SQLAlchemyModelProviderRepository:
        return SQLAlchemyModelProviderRepository(self._session)

    @cached_property
    def chats(self) -> SQLAlchemyChatRepository:
        return SQLAlchemyChatRepository(self._session)

    @cached_property
    def chat_messages(self) -> SQLAlchemyChatMessageRepository:
        return SQLAlchemyChatMessageRepository(self._session)

    @cached_property
    def chat_compactions(self) -> SQLAlchemyChatCompactionRepository:
        return SQLAlchemyChatCompactionRepository(self._session)

    @cached_property
    def memory_entries(self) -> SQLAlchemyMemoryEntryRepository:
        return SQLAlchemyMemoryEntryRepository(self._session)

    @cached_property
    def memory_episodes(self) -> SQLAlchemyMemoryEpisodeRepository:
        return SQLAlchemyMemoryEpisodeRepository(self._session)

    @cached_property
    def memory_manager(self) -> SQLAlchemyMemoryManagerRepository:
        return SQLAlchemyMemoryManagerRepository(self._session)

    @cached_property
    def user_settings(self) -> SQLAlchemyUserSettingsRepository:
        return SQLAlchemyUserSettingsRepository(self._session)

    @cached_property
    def anima_settings(self) -> SQLAlchemyAnimaSettingsRepository:
        return SQLAlchemyAnimaSettingsRepository(self._session)

    @cached_property
    def user_profiles(self) -> SQLAlchemyUserProfileRepository:
        return SQLAlchemyUserProfileRepository(self._session)

    @cached_property
    def avatars(self) -> SQLAlchemyAvatarRepository:
        return SQLAlchemyAvatarRepository(self._session)

    @cached_property
    def content_catalog(self) -> SQLAlchemyContentCatalog:
        return SQLAlchemyContentCatalog(self._session)

    @cached_property
    def anima_loadouts(self) -> AnimaLoadoutService:
        return AnimaLoadoutService(self._session)

    @cached_property
    def voice_catalog_uploads(self) -> SQLAlchemyVoiceCatalogUploadRepository:
        return SQLAlchemyVoiceCatalogUploadRepository(self._session)

    @cached_property
    def user_file_processing(self) -> SQLAlchemyUserFileProcessingRepository:
        return SQLAlchemyUserFileProcessingRepository(self._session)

    @cached_property
    def companion_safety(self) -> SQLAlchemyCompanionSafetyRepository:
        return SQLAlchemyCompanionSafetyRepository(self._session)

    @cached_property
    def anima_runtime_snapshots(self) -> AnimaRuntimeService:
        return AnimaRuntimeService(self._session)

    @cached_property
    def unit_of_work(self) -> SQLAlchemyUnitOfWork:
        return SQLAlchemyUnitOfWork(self._session)
