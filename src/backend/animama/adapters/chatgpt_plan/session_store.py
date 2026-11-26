"""The ChatGPT plan session file beneath the private data root.

Layout: ``<data_root>/internal/chatgpt-plan/`` (mode 0700) holds one file,
mode 0600, replaced atomically on every write:

- ``session.bin`` on desktop: AES-256-GCM ciphertext under a 32-byte key that
  only the desktop vault holds (``version byte || 12-byte nonce || ciphertext``);
- ``session.json`` on a self-hosted installation, which has no vault.

A file that is missing, malformed, of another schema, or that the key cannot
open means signed out; an unreadable file is removed so it cannot be retried
or copied later. Links are never followed. With a key, a plain file is never
read, so a desktop profile cannot fall back to unencrypted tokens.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import stat
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from animama.domain.chatgpt_plan import ChatGPTPlanAccount, ChatGPTPlanRecord, ChatGPTPlanTokens
from animama.utils.files import is_directory, open_no_follow, path_is_link, replace, set_mode, sync_directory

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
_DIRECTORY_MODE = 0o700
_FILE_MODE = 0o600
_FORMAT_VERSION = b"\x01"
_NONCE_BYTES = 12
_ASSOCIATED_DATA = b"animama/chatgpt-plan-session/1"
_MAX_BYTES = 256 * 1024


class _Unreadable(ValueError):
    """The saved bytes cannot be turned into a record."""


class FileChatGPTPlanSessionStore:
    """Implement ``ChatGPTPlanSessionStorePort`` with one owner-only file."""

    def __init__(self, directory: Path, *, key: bytes | None) -> None:
        if key is not None and len(key) != 32:
            raise ValueError("The ChatGPT plan store key must be 32 bytes")
        self._directory = directory
        self._cipher = AESGCM(key) if key is not None else None
        self._path = directory / ("session.bin" if key is not None else "session.json")

    def __repr__(self) -> str:
        return f"{type(self).__name__}(encrypted={self._cipher is not None})"

    def load(self) -> ChatGPTPlanRecord | None:
        """Read the record. A temporary failure to open it raises ``OSError`` and keeps the file."""

        if path_is_link(self._directory) or not self._directory.is_dir():
            return None
        try:
            descriptor = open_no_follow(self._path, os.O_RDONLY)
        except FileNotFoundError:
            return None
        except OSError as error:
            if error.errno != errno.ELOOP:
                # Busy, denied or failing storage: the record may be fine, so it is kept and read again later.
                raise
            self._discard("a link")
            return None
        try:
            with os.fdopen(descriptor, "rb") as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise _Unreadable("not a regular file")
                stored = handle.read(_MAX_BYTES + 1)
            if len(stored) > _MAX_BYTES:
                raise _Unreadable("too large")
            return _decode(json.loads(self._open(stored)))
        except (_Unreadable, ValueError, TypeError, KeyError) as error:
            reason = str(error) if isinstance(error, _Unreadable) else type(error).__name__
            self._discard(reason)
            return None

    def save(self, record: ChatGPTPlanRecord) -> None:
        directory = self._prepare_directory()
        self._sweep()
        plain = json.dumps(_encode(record), sort_keys=True, separators=(",", ":")).encode("utf-8")
        content = self._seal(plain)
        temporary = directory / f".{self._path.name}.{uuid.uuid4().hex}.tmp"
        descriptor = open_no_follow(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, _FILE_MODE)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                set_mode(handle.fileno(), _FILE_MODE)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            # Replacing a link swaps the link itself; its target is never written.
            replace(temporary, self._path)
            sync_directory(directory)
        finally:
            temporary.unlink(missing_ok=True)

    def _prepare_directory(self) -> Path:
        if path_is_link(self._directory):
            raise OSError(f"refusing a linked session directory: {self._directory.name}")
        self._directory.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        metadata = os.lstat(self._directory)
        if not is_directory(metadata):
            raise OSError(f"the session directory is not a directory: {self._directory.name}")
        if os.name == "posix" and stat.S_IMODE(metadata.st_mode) != _DIRECTORY_MODE:
            os.chmod(self._directory, _DIRECTORY_MODE)
        return self._directory

    def _seal(self, plain: bytes) -> bytes:
        if self._cipher is None:
            return plain
        nonce = os.urandom(_NONCE_BYTES)
        return _FORMAT_VERSION + nonce + self._cipher.encrypt(nonce, plain, _ASSOCIATED_DATA)

    def _open(self, stored: bytes) -> bytes:
        if self._cipher is None:
            return stored
        if not stored.startswith(_FORMAT_VERSION) or len(stored) <= 1 + _NONCE_BYTES:
            raise _Unreadable("unknown format")
        nonce = stored[1 : 1 + _NONCE_BYTES]
        try:
            return self._cipher.decrypt(nonce, stored[1 + _NONCE_BYTES :], _ASSOCIATED_DATA)
        except InvalidTag as error:
            raise _Unreadable("the key does not open it") from error

    def _sweep(self) -> None:
        """Remove writes a crash left behind; on a self-hosted install they hold plaintext tokens.

        Only a save sweeps: saves run one at a time, while a read may overlap a save
        whose temporary file must survive until it replaces the record.
        """

        for entry in self._directory.iterdir():
            if entry.name.endswith(".tmp") and entry.name.startswith((".session.json.", ".session.bin.")):
                entry.unlink(missing_ok=True)

    def _discard(self, reason: str) -> None:
        logger.warning(
            "Discarding the unreadable ChatGPT plan session file (%s); the installation is signed out", reason
        )
        try:
            self._path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            # A directory or an undeletable entry: it is never read as a record either way.
            logger.warning("The unreadable ChatGPT plan session entry could not be removed")


def _encode(record: ChatGPTPlanRecord) -> dict[str, Any]:
    account = record.account
    return {
        "schema_version": SCHEMA_VERSION,
        "host_id": record.host_id,
        "client_id": record.client_id,
        "account": None
        if account is None
        else {
            "subject": account.subject,
            "email": account.email,
            "scopes": list(account.scopes),
            "tokens": None
            if account.tokens is None
            else {
                "access_token": account.tokens.access_token,
                "refresh_token": account.tokens.refresh_token,
                "id_token": account.tokens.id_token,
                "expires_at": account.tokens.expires_at,
                "earliest_refresh_at": account.tokens.earliest_refresh_at,
            },
            "confirmed_at": account.confirmed_at.isoformat() if account.confirmed_at else None,
            "background_agreed": account.background_agreed,
        },
    }


def _text(value: object, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value:
        raise _Unreadable("a field is not text")
    return value


def _number(value: object, *, optional: bool = False) -> float | None:
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _Unreadable("a field is not a number")
    return float(value)


def _decode(payload: object) -> ChatGPTPlanRecord:
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        raise _Unreadable("unknown schema")
    host_id = str(_text(payload.get("host_id")))
    account_payload = payload.get("account")
    account: ChatGPTPlanAccount | None = None
    if account_payload is not None:
        if not isinstance(account_payload, dict):
            raise _Unreadable("the account is not an object")
        tokens_payload = account_payload.get("tokens")
        tokens: ChatGPTPlanTokens | None = None
        if tokens_payload is not None:
            if not isinstance(tokens_payload, dict):
                raise _Unreadable("the tokens are not an object")
            tokens = ChatGPTPlanTokens(
                access_token=str(_text(tokens_payload.get("access_token"))),
                refresh_token=str(_text(tokens_payload.get("refresh_token"))),
                id_token=str(_text(tokens_payload.get("id_token"))),
                expires_at=float(_number(tokens_payload.get("expires_at")) or 0.0),
                earliest_refresh_at=_number(tokens_payload.get("earliest_refresh_at"), optional=True),
            )
        scopes = account_payload.get("scopes")
        if not isinstance(scopes, list) or not all(isinstance(scope, str) for scope in scopes):
            raise _Unreadable("the scopes are not a list of text")
        confirmed = _text(account_payload.get("confirmed_at"), optional=True)
        background = account_payload.get("background_agreed")
        if not isinstance(background, bool):
            raise _Unreadable("the background choice is not a boolean")
        account = ChatGPTPlanAccount(
            subject=str(_text(account_payload.get("subject"))),
            email=_text(account_payload.get("email"), optional=True),
            scopes=tuple(scopes),
            tokens=tokens,
            confirmed_at=datetime.fromisoformat(confirmed) if confirmed else None,
            background_agreed=background,
        )
    return ChatGPTPlanRecord(host_id=host_id, client_id=_text(payload.get("client_id"), optional=True), account=account)
