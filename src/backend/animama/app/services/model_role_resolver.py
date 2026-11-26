"""Model roles: which catalog row does each installation-wide job.

Roles are chosen in App Settings (user preferences) with operator defaults from
the environment:

- **chat** — the default chat model for new Animas.
- **utility** — chat titles and compaction; defaults to the chat role.
- **memory_manager** — the Memory Manager agent; defaults to the chat role and
  needs tool calling.
- **embeddings** — uploaded-file and archive search; off until chosen.

An assignment that names a removed, hidden-kind or incapable row falls back to
the default instead of failing the job. A ChatGPT plan model is the exception:
while it is unavailable (signed out, or no longer listed for the account) the
role waits, because falling back would move the job to another connection or
key (spec #919 R5.2). When the composition disables owner model configuration
(hosted), only operator defaults apply.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from animama.app.ports import ModelProviderRepository, UserSettingsRepository
from animama.domain import ModelProvider
from animama.domain.model_connection import (
    BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
    MODEL_KIND_CHAT,
    MODEL_KIND_EMBEDDING,
    MODEL_SOURCE_OWNER,
)
from animama.logging import get_logger

ROLE_CHAT = "chat"
ROLE_UTILITY = "utility"
ROLE_MEMORY_MANAGER = "memory_manager"
ROLE_EMBEDDINGS = "embeddings"
MODEL_ROLES = (ROLE_CHAT, ROLE_UTILITY, ROLE_MEMORY_MANAGER, ROLE_EMBEDDINGS)

ROLE_PREFERENCE_PATHS: dict[str, tuple[str, str]] = {
    ROLE_CHAT: ("chat", "default_model_provider_id"),
    ROLE_UTILITY: ("models", "utility_model_provider_id"),
    ROLE_MEMORY_MANAGER: ("models", "memory_manager_model_provider_id"),
    ROLE_EMBEDDINGS: ("models", "embedding_model_provider_id"),
}
"""Preference location of each role's catalog row id."""

ROLE_SOURCE_OWNER = "owner"
ROLE_SOURCE_DEFAULT = "default"
ROLE_SOURCE_INHERITED = "inherited"
ROLE_SOURCE_OFF = "off"


@dataclass(frozen=True, slots=True)
class ModelRoleDefaults:
    """Operator defaults (row ids) from the environment; ``None`` means none."""

    chat: str
    utility: str | None = None
    memory_manager: str | None = None
    embeddings: str | None = None

    def for_role(self, role: str) -> str | None:
        return {
            ROLE_CHAT: self.chat,
            ROLE_UTILITY: self.utility,
            ROLE_MEMORY_MANAGER: self.memory_manager,
            ROLE_EMBEDDINGS: self.embeddings,
        }[role]


@dataclass(frozen=True, slots=True)
class ResolvedModelRole:
    """The row that does a role's job, how it was chosen and whether the choice held.

    ``requested_id`` is the owner's assignment; ``assignment_available`` is
    False when that assignment could not be used and the role fell back.
    """

    role: str
    model_provider: ModelProvider | None
    source: str
    requested_id: str | None = None
    assignment_available: bool = True


class ModelRoleResolver:
    """Resolve roles for one owner from preferences, defaults and row capabilities."""

    def __init__(
        self,
        *,
        model_providers: ModelProviderRepository,
        user_settings: UserSettingsRepository,
        defaults: ModelRoleDefaults,
        owner_roles_enabled: bool,
    ) -> None:
        self._model_providers = model_providers
        self._user_settings = user_settings
        self._defaults = defaults
        self._owner_roles_enabled = owner_roles_enabled
        self._log = get_logger("app.services.model_role_resolver")

    async def resolve(self, owner_id: str, role: str) -> ResolvedModelRole:
        if role not in ROLE_PREFERENCE_PATHS:
            raise ValueError(f"Unknown model role: {role}")
        preferences = await self._preferences(owner_id)
        requested = role_preference(preferences, *ROLE_PREFERENCE_PATHS[role]) if self._owner_roles_enabled else None
        if requested is not None:
            row = await self._model_providers.get(requested)
            if row is not None and usable_for_role(role, row):
                return ResolvedModelRole(
                    role=role, model_provider=row, source=ROLE_SOURCE_OWNER, requested_id=requested
                )
            if row is not None and row.connection_id == BUILTIN_CHATGPT_PLAN_CONNECTION_ID:
                self._log.info("ChatGPT plan model for the role is unavailable; the role waits", role=role)
                return ResolvedModelRole(
                    role=role,
                    model_provider=None,
                    source=ROLE_SOURCE_OFF,
                    requested_id=requested,
                    assignment_available=False,
                )
            self._log.warning("Model role assignment unavailable; using the default", role=role)
        fallback = await self._default(owner_id, role)
        return ResolvedModelRole(
            role=role,
            model_provider=fallback.model_provider,
            source=fallback.source,
            requested_id=requested,
            assignment_available=requested is None and fallback.assignment_available,
        )

    async def _default(self, owner_id: str, role: str) -> ResolvedModelRole:
        default_id = self._defaults.for_role(role)
        if default_id is not None:
            row = await self._usable_row(role, default_id)
            if row is not None:
                return ResolvedModelRole(role=role, model_provider=row, source=ROLE_SOURCE_DEFAULT)
            self._log.warning("Operator default for model role is unavailable", role=role)
        if role in {ROLE_UTILITY, ROLE_MEMORY_MANAGER}:
            chat = await self.resolve(owner_id, ROLE_CHAT)
            if chat.model_provider is not None and suits_role(role, chat.model_provider):
                return ResolvedModelRole(role=role, model_provider=chat.model_provider, source=ROLE_SOURCE_INHERITED)
            if chat.model_provider is None and not chat.assignment_available:
                # The chat role's own choice is unavailable and it has nothing to fall back to (for example a
                # ChatGPT plan model while signed out), so this role reports that wait rather than "no model".
                return ResolvedModelRole(
                    role=role, model_provider=None, source=ROLE_SOURCE_OFF, assignment_available=False
                )
        return ResolvedModelRole(role=role, model_provider=None, source=ROLE_SOURCE_OFF)

    async def _usable_row(self, role: str, model_provider_id: str) -> ModelProvider | None:
        row = await self._model_providers.get(model_provider_id)
        return row if row is not None and usable_for_role(role, row) else None

    async def _preferences(self, owner_id: str) -> dict[str, Any]:
        settings = await self._user_settings.get(owner_id)
        return dict(settings.preferences) if settings is not None else {}


def usable_for_role(role: str, row: ModelProvider) -> bool:
    """Whether an active row on an active connection can do a role's job."""

    if not row.active or (row.connection is not None and not row.connection.active):
        return False
    return suits_role(role, row)


def suits_role(role: str, row: ModelProvider) -> bool:
    """Whether a row can do a role's job.

    The Memory Manager needs tool calling (its requests are not streamed); chat
    and utility stream, and owner rows need a context window for them (spec R3).
    """

    if role == ROLE_EMBEDDINGS:
        return row.model_kind == MODEL_KIND_EMBEDDING
    if row.model_kind != MODEL_KIND_CHAT:
        return False
    if role == ROLE_MEMORY_MANAGER:
        return row.capabilities.supports_tools
    if not row.capabilities.supports_streaming:
        return False
    return row.source != MODEL_SOURCE_OWNER or row.context_window_tokens is not None


def role_preference(preferences: dict[str, Any], section: str, key: str) -> str | None:
    values = preferences.get(section)
    value = values.get(key) if isinstance(values, dict) else None
    return value.strip() if isinstance(value, str) and value.strip() else None


async def unusable_role_preferences(
    model_providers: ModelProviderRepository,
    preferences: dict[str, Any],
    *,
    offered: Callable[[ModelProvider], bool],
) -> tuple[str, ...]:
    """The roles whose preference names a row the catalog does not offer or that cannot do the role's job."""

    unusable = []
    for role, path in ROLE_PREFERENCE_PATHS.items():
        selected = role_preference(preferences, *path)
        if selected is None:
            continue
        row = await model_providers.get(selected)
        if row is None or not offered(row) or not usable_for_role(role, row):
            unusable.append(role)
    return tuple(unusable)


__all__ = [
    "MODEL_ROLES",
    "role_preference",
    "suits_role",
    "unusable_role_preferences",
    "usable_for_role",
    "ROLE_CHAT",
    "ROLE_EMBEDDINGS",
    "ROLE_MEMORY_MANAGER",
    "ROLE_PREFERENCE_PATHS",
    "ROLE_SOURCE_DEFAULT",
    "ROLE_SOURCE_INHERITED",
    "ROLE_SOURCE_OFF",
    "ROLE_SOURCE_OWNER",
    "ROLE_UTILITY",
    "ModelRoleDefaults",
    "ModelRoleResolver",
    "ResolvedModelRole",
]
