"""The local composition's ChatGPT plan session: where it lives and when sign-in is offered.

Sign-in is offered only when the installation's own origin is a loopback
``http`` origin (D14), because OpenAI sends the browser back to
``http://127.0.0.1:<port>/auth/callback`` and only then does that address reach
this server. A desktop profile also needs its vault's key for the session file;
without one, sign-in is unavailable rather than falling back to a plain file.

The service is created on first use, after startup has resolved the private
data root, and closed with the application.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Literal, cast

from fastapi import FastAPI

from animama.adapters.chatgpt_plan.openai_identity import OpenAIChatGPTPlanIdentity
from animama.adapters.chatgpt_plan.openai_models import OpenAIChatGPTPlanModels
from animama.adapters.chatgpt_plan.session_store import FileChatGPTPlanSessionStore
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanSessionStorePort
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.domain.chatgpt_plan import ChatGPTPlanRecord, ChatGPTPlanUnavailableError
from animama.local.http.config import LocalHTTPConfig
from animama.server.schemas.chatgpt_plan import ChatGPTPlanUnavailableReason

CALLBACK_PATH = "/auth/callback"
STORE_KEY_ENV = "ANIMAMA_CHATGPT_PLAN_STORE_KEY"

logger = logging.getLogger(__name__)


class _NoSessionFile:
    """The store of a desktop profile without a key: always signed out, and nothing is written."""

    def load(self) -> ChatGPTPlanRecord | None:
        return None

    def save(self, record: ChatGPTPlanRecord) -> None:
        raise OSError("The ChatGPT plan session needs the desktop vault's key")


def _config(app: FastAPI) -> LocalHTTPConfig:
    return cast(LocalHTTPConfig, app.state.local_http_config)


def chatgpt_plan_return_uri(app: FastAPI) -> str | None:
    """The address OpenAI sends the browser back to, or None when it could not reach this server."""

    authority = _config(app).sign_in_return_authority
    return f"http://{authority}{CALLBACK_PATH}" if authority is not None else None


class _ProcessStoreKey:
    """The session file's key as this process received it.

    Desktop's Electron main passes it in the environment of this process only.
    It is taken out of the environment the first time an app is built, so no
    child process inherits it, and kept for every later app the process builds:
    the desktop ``serve`` command builds a second app after importing the module
    that builds the first.
    """

    def __init__(self) -> None:
        self._value: str | None = None

    def take(self) -> str | None:
        value = os.environ.pop(STORE_KEY_ENV, None)
        if value is not None and value.strip():
            self._value = value.strip()
        return self._value


_PROCESS_STORE_KEY = _ProcessStoreKey()


def install_chatgpt_plan_store_key(app: FastAPI) -> None:
    """Give ``app`` the session file's key. A malformed key is logged without its value and ignored."""

    value = _PROCESS_STORE_KEY.take()
    key: bytes | None = None
    if value is not None:
        if re.fullmatch(r"[0-9a-f]{64}", value):
            key = bytes.fromhex(value)
        else:
            logger.error("The ChatGPT plan store key is not 32 bytes of lower-case hex, so it is ignored")
    app.state.chatgpt_plan_store_key = key


def chatgpt_plan_store_key(app: FastAPI) -> bytes | None:
    return cast(bytes | None, getattr(app.state, "chatgpt_plan_store_key", None))


def chatgpt_plan_unavailable_reason(app: FastAPI) -> ChatGPTPlanUnavailableReason | None:
    if chatgpt_plan_return_uri(app) is None:
        return "remote_origin"
    if _config(app).desktop is not None and chatgpt_plan_store_key(app) is None:
        return "secure_storage_unavailable"
    return None


def chatgpt_plan_session_for(app: FastAPI) -> ChatGPTPlanSessionService:
    """Return the installation's session service, creating it on first use."""

    service = getattr(app.state, "chatgpt_plan_session", None)
    if service is None:
        data_internal_root: Path = app.state.local_runtime_paths.data_internal_root
        identity = OpenAIChatGPTPlanIdentity()
        store: ChatGPTPlanSessionStorePort = FileChatGPTPlanSessionStore(
            data_internal_root / "chatgpt-plan", key=chatgpt_plan_store_key(app)
        )
        if chatgpt_plan_unavailable_reason(app) == "secure_storage_unavailable":
            # A desktop profile without its vault key reads and writes no session file at all.
            store = _NoSessionFile()
        service = ChatGPTPlanSessionService(identity=identity, store=store)
        app.state.chatgpt_plan_identity = identity
        app.state.chatgpt_plan_session = service
    return cast(ChatGPTPlanSessionService, service)


def chatgpt_plan_models_for(app: FastAPI) -> OpenAIChatGPTPlanModels:
    """Return the client that lists the account's models, creating it on first use."""

    models = getattr(app.state, "chatgpt_plan_models", None)
    if models is None:
        models = OpenAIChatGPTPlanModels()
        app.state.chatgpt_plan_models = models
    return cast(OpenAIChatGPTPlanModels, models)


def chatgpt_plan_models_lock(app: FastAPI) -> asyncio.Lock:
    """The lock every refresh and withdrawal of the plan's model rows takes, one per app."""

    lock = getattr(app.state, "chatgpt_plan_models_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app.state.chatgpt_plan_models_lock = lock
    return cast(asyncio.Lock, lock)


async def chatgpt_plan_credential_state(app: FastAPI) -> Literal["configured", "missing"]:
    """The plan connection's state for the model connection list: ``configured`` while the plan is usable."""

    paths = getattr(app.state, "local_runtime_paths", None)
    if getattr(paths, "data_internal_root", None) is None:
        # Before startup resolved the private data root there is no session to read.
        return "missing"
    try:
        status = await chatgpt_plan_session_for(app).status()
    except ChatGPTPlanUnavailableError:
        # An unreadable session file is reported on the plan's own card; the list still loads.
        return "missing"
    return "configured" if status.state == "signed_in" and status.plan_use_granted else "missing"


async def close_chatgpt_plan_session(app: FastAPI) -> None:
    identity = getattr(app.state, "chatgpt_plan_identity", None)
    if identity is not None:
        await identity.aclose()
        app.state.chatgpt_plan_identity = None
        app.state.chatgpt_plan_session = None
    models = getattr(app.state, "chatgpt_plan_models", None)
    if models is not None:
        await models.aclose()
        app.state.chatgpt_plan_models = None
