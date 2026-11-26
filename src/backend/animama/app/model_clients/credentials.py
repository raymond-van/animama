"""Per-connection model credentials.

Model clients ask a :class:`ModelCredentialResolver` for the key of the
connection that owns the selected catalog row. A key is never shared across
connections: the built-in OpenAI connection uses only the OpenAI key, the
built-in Anthropic connection uses only the Anthropic key, and an owner
connection uses only the key variable it names, and only where that key may go
(:func:`key_refusal`). Keys come from the process's
:class:`~animama.app.model_clients.credential_store.RuntimeCredentialStore`,
never directly from ``os.environ``. Values are never stored in the database or
returned by APIs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

from animama.app.model_clients.credential_store import (
    ANTHROPIC_CREDENTIAL_ENV,
    KNOWN_PROVIDER_CREDENTIAL_ENVS,
    MANAGED_CREDENTIAL_ENV_PATTERN,
    OPENAI_CREDENTIAL_ENV,
    PROVIDER_CREDENTIAL_ORIGINS,
    WEB_SEARCH_CREDENTIAL_ENVS,
    WEB_SEARCH_MANAGED_CREDENTIAL_ENV,
    CredentialSource,
    FixedCredentials,
    connection_origin_env,
    is_allowed_credential_env,
)
from animama.app.model_clients.key_origins import canonical_origin, is_this_computer
from animama.app.model_connection_presets import (
    ANTHROPIC_CONNECTION_COMPATIBILITY,
    PRESET_ANTHROPIC,
    PRESET_CHATGPT_PLAN,
    PRESET_OPENAI,
)
from animama.domain import ModelProvider
from animama.domain.model_connection import (
    BUILTIN_ANTHROPIC_CONNECTION_ID,
    BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
    BUILTIN_OPENAI_CONNECTION_ID,
    MODEL_SOURCE_BUILTIN,
    ModelConnection,
)

CREDENTIAL_CONFIGURED = "configured"
CREDENTIAL_MISSING = "missing"
CREDENTIAL_NOT_REQUIRED = "not_required"

CREDENTIAL_ORIGIN_MISMATCH = "credential_origin_mismatch"
"""The key belongs to another origin than the connection's base URL."""
CREDENTIAL_ORIGIN_MISSING = "credential_origin_missing"
"""A connection key has no origin saved with it, so it is not sent anywhere."""
CREDENTIAL_INSECURE_TRANSPORT = "credential_insecure_transport"
"""The base URL is plain HTTP to another computer, where no key may travel."""


def key_refusal(name: str, base_url: str | None, saved_origin: str | None) -> str | None:
    """Return why key ``name`` must not be sent to ``base_url``, or ``None`` when it may.

    A provider key goes only to its provider's API and a connection key only to
    ``saved_origin``, the origin saved with it. No key goes over plain HTTP unless
    the host is this computer.
    """

    origin = canonical_origin(base_url)
    if origin is None:
        return CREDENTIAL_ORIGIN_MISMATCH
    if origin.startswith("http://") and not is_this_computer(origin):
        return CREDENTIAL_INSECURE_TRANSPORT
    expected = PROVIDER_CREDENTIAL_ORIGINS.get(name) or canonical_origin(saved_origin)
    if expected is None:
        return CREDENTIAL_ORIGIN_MISSING
    return None if expected == origin else CREDENTIAL_ORIGIN_MISMATCH


def is_allowed_web_search_credential_env(name: str) -> bool:
    """Return whether the web search backend may read its key from ``name``."""

    return name in WEB_SEARCH_CREDENTIAL_ENVS


def managed_credential_env(connection_id: str) -> str:
    """Return the managed key variable name for a generated connection id.

    Generated ids use only lowercase letters, digits and underscores, so the
    mapping is one-to-one; other ids are rejected rather than risk two
    connections sharing one key.
    """

    if not re.fullmatch(r"[a-z0-9_]{1,48}", connection_id):
        raise ValueError(f"Connection id cannot name a managed key: {connection_id!r}")
    return f"ANIMAMA_CONNECTION_{connection_id.upper()}_API_KEY"


def builtin_openai_connection() -> ModelConnection:
    """Return the built-in OpenAI connection, which uses process OpenAI settings."""

    return ModelConnection(
        id=BUILTIN_OPENAI_CONNECTION_ID,
        name="OpenAI",
        preset=PRESET_OPENAI,
        source=MODEL_SOURCE_BUILTIN,
    )


def builtin_anthropic_connection() -> ModelConnection:
    """Return the built-in Anthropic connection, which uses ``ANTHROPIC_API_KEY``."""

    return ModelConnection(
        id=BUILTIN_ANTHROPIC_CONNECTION_ID,
        name="Anthropic",
        preset=PRESET_ANTHROPIC,
        source=MODEL_SOURCE_BUILTIN,
        compatibility=ANTHROPIC_CONNECTION_COMPATIBILITY,
    )


def builtin_chatgpt_plan_connection() -> ModelConnection:
    """Return the built-in ChatGPT plan connection, whose credential is the sign-in session's token.

    It names no key, so the key resolver reports ``not_required``; the model
    connection list reports its state from the session instead.
    """

    return ModelConnection(
        id=BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
        name="ChatGPT plan",
        preset=PRESET_CHATGPT_PLAN,
        source=MODEL_SOURCE_BUILTIN,
    )


_BUILTIN_CONNECTIONS = {
    BUILTIN_OPENAI_CONNECTION_ID: builtin_openai_connection,
    BUILTIN_ANTHROPIC_CONNECTION_ID: builtin_anthropic_connection,
    BUILTIN_CHATGPT_PLAN_CONNECTION_ID: builtin_chatgpt_plan_connection,
}

_BUILTIN_CREDENTIAL_ENVS = {
    BUILTIN_OPENAI_CONNECTION_ID: OPENAI_CREDENTIAL_ENV,
    BUILTIN_ANTHROPIC_CONNECTION_ID: ANTHROPIC_CREDENTIAL_ENV,
}
"""The only key each built-in connection may use; neither falls back to the other's."""


def builtin_connection(connection_id: str) -> ModelConnection | None:
    """Return the built-in connection with this id, or ``None`` for owner connections."""

    factory = _BUILTIN_CONNECTIONS.get(connection_id)
    return factory() if factory is not None else None


def builtin_model_connections() -> list[ModelConnection]:
    """Return every release-managed connection, OpenAI first."""

    return [factory() for factory in _BUILTIN_CONNECTIONS.values()]


def connection_for_model_provider(model_provider: ModelProvider) -> ModelConnection:
    """Return the row's loaded connection.

    Only rows on a built-in connection may omit it (rows built outside the
    database). A row on an owner connection without its loaded connection is
    rejected so its request can never fall back to a built-in connection.
    """

    if model_provider.connection is not None:
        return model_provider.connection
    connection = builtin_connection(model_provider.connection_id)
    if connection is not None:
        return connection
    raise ValueError(f"Model connection is not loaded for {model_provider.id}")


@dataclass(frozen=True, slots=True)
class ModelCredential:
    """Resolved key state for one connection; the key is excluded from ``repr``.

    ``refusal`` names why a stored key is not used at the connection's base URL
    (see :func:`key_refusal`); the state is then ``missing``.
    """

    state: str
    api_key: str | None = field(default=None, repr=False)
    refusal: str | None = None

    @property
    def usable(self) -> bool:
        return self.state != CREDENTIAL_MISSING


class ModelCredentialResolver(Protocol):
    """Resolve the key for a connection without persisting it."""

    def resolve(self, connection: ModelConnection) -> ModelCredential: ...


class StoreModelCredentialResolver:
    """Resolve keys from the runtime credential store on every call.

    Each ``resolve`` reads the context's current snapshot (the one pinned for
    the request, or the latest), so a changed key applies to the next request
    without rebuilding clients. Callers resolve once per request and reuse the
    result so one request never mixes keys.
    """

    def __init__(self, store: CredentialSource) -> None:
        self._store = store

    def resolve(self, connection: ModelConnection) -> ModelCredential:
        snapshot = self._store.current()
        builtin_env = _BUILTIN_CREDENTIAL_ENVS.get(connection.id)
        if builtin_env is not None:
            return _credential(snapshot.get(builtin_env))
        name = (connection.credential_env or "").strip()
        if not name:
            return ModelCredential(state=CREDENTIAL_NOT_REQUIRED)
        if not is_allowed_credential_env(name):
            return ModelCredential(state=CREDENTIAL_MISSING)
        refusal = key_refusal(name, connection.base_url, snapshot.get(connection_origin_env(name)))
        if refusal is not None:
            return ModelCredential(state=CREDENTIAL_MISSING, refusal=refusal)
        return _credential(snapshot.get(name))


def static_credential_resolver(values: dict[str, str] | None = None) -> StoreModelCredentialResolver:
    """Resolve from a fixed set of keys, for clients built without the process store."""

    return StoreModelCredentialResolver(FixedCredentials(values))


def _credential(value: str | None) -> ModelCredential:
    if value:
        return ModelCredential(state=CREDENTIAL_CONFIGURED, api_key=value)
    return ModelCredential(state=CREDENTIAL_MISSING)


__all__ = [
    "WEB_SEARCH_CREDENTIAL_ENVS",
    "WEB_SEARCH_MANAGED_CREDENTIAL_ENV",
    "is_allowed_web_search_credential_env",
    "CREDENTIAL_CONFIGURED",
    "CREDENTIAL_INSECURE_TRANSPORT",
    "CREDENTIAL_MISSING",
    "CREDENTIAL_NOT_REQUIRED",
    "CREDENTIAL_ORIGIN_MISMATCH",
    "CREDENTIAL_ORIGIN_MISSING",
    "KNOWN_PROVIDER_CREDENTIAL_ENVS",
    "MANAGED_CREDENTIAL_ENV_PATTERN",
    "ModelCredential",
    "ModelCredentialResolver",
    "StoreModelCredentialResolver",
    "builtin_anthropic_connection",
    "builtin_connection",
    "builtin_model_connections",
    "builtin_openai_connection",
    "connection_for_model_provider",
    "is_allowed_credential_env",
    "key_refusal",
    "managed_credential_env",
    "static_credential_resolver",
]
