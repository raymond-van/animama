#!/usr/bin/env python3
"""Probe OpenAI's Sign in with ChatGPT plan route with a real account.

Developer tooling for the ChatGPT plan connection (docs/plans/chatgpt-plan).
The route is a preview, so this script records what it accepts today:
registration and sign-in, the account's model list, the request shapes the
model client would send, token refresh and sign-out.

It handles real tokens. They are written only to the credentials file named
on the command line, which must sit outside any Git work tree and is created
with owner-only permissions. Output names fields, shapes and statuses. It
never prints a token, an authorization code, an email address or the
account's identifiers. `models` prints OpenAI's model metadata with any text
over 200 characters replaced by its length; read it before pasting it
anywhere.

Run from the repository root, with an eligible ChatGPT plan:

    uv run python scripts/chatgpt_plan_probe.py sign-in --credentials PATH
    uv run python scripts/chatgpt_plan_probe.py models --credentials PATH
    uv run python scripts/chatgpt_plan_probe.py requests --credentials PATH --model SLUG
    uv run python scripts/chatgpt_plan_probe.py refresh --credentials PATH
    uv run python scripts/chatgpt_plan_probe.py sign-out --credentials PATH --delete

`requests` sends at most 23 small requests, which count against the plan.
`requests --list` names the trials, and `--only NAME` reruns chosen ones.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import struct
import sys
import time
import uuid
import webbrowser
import zlib
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx
import jwt

JsonObject = dict[str, Any]
Redact = Callable[[str], str]

APP_NAME = "Animama"
ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{ISSUER}/api/accounts/authorize"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
API_BASE = "https://api.openai.com/v1"
REGISTRATION_CLIENT_ID = "dynamic_agent_client"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = f"openid profile email offline_access resource.invoke {PLAN_SCOPE}"
CALLBACK_PATH = "/auth/callback"
# The token's own header chooses among these; anything else is refused.
ID_TOKEN_ALGORITHMS = ("RS256", "ES256")
REFRESH_MARGIN_SECONDS = 300
TOKEN_FIELDS = ("access_token", "refresh_token", "id_token")
REDACTED_FIELDS = (*TOKEN_FIELDS, "email", "subject", "client_id")
NOT_REPORTED = "not reported"

_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_CODE_RE = re.compile(r"[A-Za-z0-9_.-]{1,80}")


class ProbeError(Exception):
    """A failure whose message is safe to print."""


# --- Credentials file -------------------------------------------------------


def _inside_git_work_tree(path: Path) -> bool:
    resolved = path.resolve()
    return any((parent / ".git").exists() for parent in (resolved.parent, *resolved.parent.parents))


def check_credentials_path(path: Path) -> None:
    """Refuse a location where tokens could be committed, followed or read by others."""

    if _inside_git_work_tree(path):
        raise ProbeError("The credentials file must sit outside any Git work tree.")
    if path.is_symlink():
        raise ProbeError("The credentials file must not be a symbolic link.")
    if not path.parent.is_dir():
        raise ProbeError("The credentials file's directory does not exist.")
    if path.exists() and os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ProbeError("The credentials file must be readable by its owner only (mode 0600).")


def load_record(path: Path) -> JsonObject:
    """Read the saved record, or start one with a host id that later sign-ins keep."""

    check_credentials_path(path)
    if not path.exists():
        return {"schema": 1, "host_id": f"urn:uuid:{uuid.uuid4()}"}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProbeError("The credentials file could not be read as JSON.") from error
    if not isinstance(record, dict) or record.get("schema") != 1 or not isinstance(record.get("host_id"), str):
        raise ProbeError("The credentials file is not a probe record.")
    return record


def save_record(path: Path, record: Mapping[str, Any]) -> None:
    """Replace the record atomically, so an interrupted write keeps the previous tokens."""

    check_credentials_path(path)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


# --- Output that is safe to paste -------------------------------------------


def redactor(record: Mapping[str, Any]) -> Redact:
    """Hide the record's secrets and identifiers, plus anything shaped like a JWT or an email.

    The record is read again on every call and earlier values are remembered,
    so a token refresh cannot leave either the old or the new token readable.
    """

    seen: set[str] = set()

    def remember() -> None:
        seen.update(str(record[name]) for name in REDACTED_FIELDS if len(str(record.get(name) or "")) >= 8)

    def redact(text: str) -> str:
        remember()
        for value in sorted(seen, key=len, reverse=True):
            text = text.replace(value, "[redacted]")
        return _EMAIL_RE.sub("[redacted-email]", _JWT_RE.sub("[redacted-jwt]", text))

    remember()
    return redact


def emit(title: str, payload: Any, redact: Redact) -> None:
    print(f"== {title}")
    print(redact(json.dumps(payload, indent=2, sort_keys=True, default=str)))


def _b64url_json(segment: str) -> Any:
    padded = segment + "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))


def _jwt_parts(value: str) -> tuple[JsonObject, JsonObject] | None:
    parts = value.split(".")
    if len(parts) != 3 or not all(parts):
        return None
    try:
        header, claims = _b64url_json(parts[0]), _b64url_json(parts[1])
    except (ValueError, UnicodeDecodeError):
        return None
    return (header, claims) if isinstance(header, dict) and isinstance(claims, dict) else None


def token_shape(value: str) -> JsonObject:
    """Describe a token without revealing it: its kind and length and, for a JWT, its header and claim names."""

    decoded = _jwt_parts(value)
    if decoded is None:
        return {"kind": "opaque", "characters": len(value)}
    header, claims = decoded
    issued, expires = claims.get("iat"), claims.get("exp")
    return {
        "kind": "jwt",
        "characters": len(value),
        "algorithm": header.get("alg"),
        "type": header.get("typ"),
        "has_key_id": "kid" in header,
        "claims": sorted(str(name) for name in claims),
        "lifetime_seconds": expires - issued if isinstance(issued, int) and isinstance(expires, int) else None,
    }


def _safe_code(value: object) -> str:
    """Echo a provider's short error code, never free text that arrived from outside."""

    text = str(value)
    return text if _CODE_RE.fullmatch(text) else "unrecognised"


def _same(left: str, right: str) -> bool:
    """Compare in constant time. Bytes, because `hmac` refuses non-ASCII text."""

    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


# --- OpenAI's sign-in service -----------------------------------------------


def http_client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    """One client for OpenAI. Redirects are never followed, so a token cannot be carried to another host."""

    return httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=False, transport=transport)


def _json_object(response: httpx.Response) -> JsonObject:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _error_code(payload: Mapping[str, Any]) -> str:
    error = payload.get("error")
    if isinstance(error, Mapping):
        return _safe_code(error.get("code") or error.get("type") or "unknown")
    return _safe_code(error or "unknown")


def _on_sign_in_host(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parts = urlsplit(value)
    return parts.scheme == "https" and parts.netloc == urlsplit(ISSUER).netloc


@dataclass(frozen=True)
class Discovery:
    """What OpenAI's discovery document says, kept only when it points at OpenAI's own sign-in host."""

    issuer: str
    jwks_uri: str
    revocation_endpoint: str | None
    matches_documented_endpoints: bool


def discover(client: httpx.Client) -> Discovery:
    """Read the issuer and signing-key location before any code is exchanged."""

    response = client.get(DISCOVERY_URL, headers={"Accept": "application/json"})
    if response.status_code != 200:
        raise ProbeError(f"OpenAI's discovery document answered {response.status_code}.")
    document = _json_object(response)
    issuer, jwks_uri, revocation = (document.get(name) for name in ("issuer", "jwks_uri", "revocation_endpoint"))
    if not isinstance(issuer, str) or not isinstance(jwks_uri, str):
        raise ProbeError("OpenAI's discovery document lacks an issuer or its signing keys.")
    if not _on_sign_in_host(issuer) or not _on_sign_in_host(jwks_uri):
        raise ProbeError("OpenAI's discovery document names an issuer or signing keys on another host.")
    return Discovery(
        issuer=issuer,
        jwks_uri=jwks_uri,
        revocation_endpoint=revocation if isinstance(revocation, str) and _on_sign_in_host(revocation) else None,
        matches_documented_endpoints=(
            document.get("authorization_endpoint") == AUTHORIZE_URL and document.get("token_endpoint") == TOKEN_URL
        ),
    )


def _token_request(client: httpx.Client, form: Mapping[str, str]) -> JsonObject:
    response = client.post(TOKEN_URL, data=dict(form), headers={"Accept": "application/json"})
    payload = _json_object(response)
    if response.status_code != 200:
        raise ProbeError(f"The token endpoint answered {response.status_code} ({_error_code(payload)}).")
    return payload


def revoke(client: httpx.Client, discovery: Discovery, client_id: str, refresh_token: str) -> int | None:
    """Ask OpenAI to end the renewable session. Returns the status, or None when nothing could be sent."""

    if discovery.revocation_endpoint is None:
        return None
    try:
        response = client.post(
            discovery.revocation_endpoint,
            data={"token": refresh_token, "token_type_hint": "refresh_token", "client_id": client_id},
        )
    except httpx.HTTPError:
        return None
    return response.status_code


def validate_id_token(
    client: httpx.Client, id_token: str, *, client_id: str, nonce: str, discovery: Discovery
) -> JsonObject:
    """Check the signature against OpenAI's published keys, then issuer, audience, expiry and nonce."""

    try:
        header = jwt.get_unverified_header(id_token)
        algorithm = header.get("alg")
        if algorithm not in ID_TOKEN_ALGORITHMS:
            raise ProbeError(f"The ID token uses an unexpected algorithm ({_safe_code(algorithm)}).")
        response = client.get(discovery.jwks_uri, headers={"Accept": "application/json"})
        if response.status_code != 200:
            raise ProbeError(f"OpenAI's signing keys answered {response.status_code}.")
        keys = jwt.PyJWKSet.from_dict(_json_object(response)).keys
        key = next((candidate for candidate in keys if candidate.key_id == header.get("kid")), None)
        if key is None:
            raise ProbeError("No published signing key matches the ID token.")
        claims: JsonObject = jwt.decode(
            id_token,
            key=key.key,
            algorithms=[algorithm],
            audience=client_id,
            issuer=discovery.issuer,
            leeway=5,
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as error:
        raise ProbeError(f"The ID token failed validation ({type(error).__name__}).") from error
    if not _same(str(claims.get("nonce", "")), nonce):
        raise ProbeError("The ID token's nonce does not match this sign-in.")
    return claims


def granted_scopes(tokens: Mapping[str, Any]) -> list[str] | None:
    """The scopes OpenAI granted, from the token response or the access token, or None when neither says."""

    reported = tokens.get("scope")
    if not isinstance(reported, str) and isinstance(tokens.get("access_token"), str):
        decoded = _jwt_parts(tokens["access_token"])
        reported = decoded[1].get("scope") if decoded else None
    return sorted(reported.split()) if isinstance(reported, str) else None


def _store_tokens(record: JsonObject, tokens: Mapping[str, Any]) -> None:
    for name in TOKEN_FIELDS:
        if isinstance(tokens.get(name), str):
            record[name] = tokens[name]
    scopes = granted_scopes(tokens)
    if scopes is None:
        record.pop("scopes", None)
    else:
        record["scopes"] = scopes
    lifetime = tokens.get("expires_in")
    record["expires_at"] = time.time() + (float(lifetime) if isinstance(lifetime, int | float) else 3600.0)
    record["earliest_refresh_at"] = tokens.get("earliest_refresh_at")
    record["saved_at"] = datetime.now(UTC).isoformat(timespec="seconds")


def _token_summary(tokens: Mapping[str, Any]) -> JsonObject:
    scopes = granted_scopes(tokens)
    summary: JsonObject = {
        "token_response_fields": sorted(tokens),
        "expires_in": tokens.get("expires_in"),
        "earliest_refresh_at": tokens.get("earliest_refresh_at"),
        "granted_scopes": NOT_REPORTED if scopes is None else scopes,
        "plan_use_granted": NOT_REPORTED if scopes is None else PLAN_SCOPE in scopes,
    }
    for name in TOKEN_FIELDS:
        if isinstance(tokens.get(name), str):
            summary[name] = token_shape(tokens[name])
    return summary


# --- Sign-in ----------------------------------------------------------------


@dataclass(frozen=True)
class Attempt:
    """One authorization attempt. The verifier never leaves this process."""

    client_id: str
    redirect_uri: str
    state: str
    nonce: str
    verifier: str = field(repr=False)

    @property
    def challenge(self) -> str:
        digest = hashlib.sha256(self.verifier.encode("ascii")).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_attempt(record: Mapping[str, Any], redirect_uri: str) -> Attempt:
    return Attempt(
        client_id=str(record.get("client_id") or REGISTRATION_CLIENT_ID),
        redirect_uri=redirect_uri,
        state=secrets.token_urlsafe(32),
        nonce=secrets.token_urlsafe(32),
        verifier=secrets.token_urlsafe(64),
    )


def authorize_url(record: Mapping[str, Any], attempt: Attempt) -> str:
    """Build the authorization URL. It can carry an ID token hint, so it is never printed."""

    params = {
        "client_id": attempt.client_id,
        "response_type": "code",
        "redirect_uri": attempt.redirect_uri,
        "scope": SCOPES,
        "resource": API_BASE,
        "state": attempt.state,
        "nonce": attempt.nonce,
        "code_challenge_method": "S256",
        "code_challenge": attempt.challenge,
        "ext_agent_host_id": str(record["host_id"]),
    }
    if attempt.client_id == REGISTRATION_CLIENT_ID:
        params["agent_name_hint"] = APP_NAME
    else:
        if record.get("id_token"):
            params["id_token_hint"] = str(record["id_token"])
        if record.get("email"):
            params["login_hint"] = str(record["email"])
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


class CallbackServer(HTTPServer):
    """A loopback listener that keeps the one return it is waiting for."""

    params: dict[str, str] | None = None


class _CallbackHandler(BaseHTTPRequestHandler):
    server: CallbackServer
    # A connection that sends nothing must not hold the listener past its deadline.
    timeout = 5

    def do_GET(self) -> None:
        target = urlsplit(self.path)
        if target.path != CALLBACK_PATH:
            self.send_error(404)
            return
        self.server.params = dict(parse_qsl(target.query, keep_blank_values=True))
        body = b"<!doctype html><meta charset=utf-8><title>Animama probe</title><p>You can close this tab.</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        """Stay silent: the request line carries the authorization code."""


def open_callback_server(port: int) -> CallbackServer:
    try:
        return CallbackServer(("127.0.0.1", port), _CallbackHandler)
    except OSError as error:
        raise ProbeError(f"The loopback port {port} could not be opened; choose another with --port.") from error


def wait_for_callback(server: CallbackServer, timeout_seconds: float) -> dict[str, str]:
    deadline = time.monotonic() + timeout_seconds
    server.timeout = 0.5
    while server.params is None:
        if time.monotonic() >= deadline:
            raise ProbeError("No sign-in return arrived before the timeout.")
        server.handle_request()
    return server.params


def complete_sign_in(
    client: httpx.Client,
    path: Path,
    record: JsonObject,
    attempt: Attempt,
    params: Mapping[str, str],
    discovery: Discovery,
) -> JsonObject:
    """Validate the return, exchange its code and save the tokens. Nothing is exchanged on a bad return."""

    if not _same(params.get("state", ""), attempt.state):
        raise ProbeError("The return's state does not match this sign-in; nothing was exchanged.")
    if "error" in params:
        raise ProbeError(f"OpenAI returned the sign-in error {_safe_code(params['error'])}.")
    code = params.get("code")
    if not code:
        raise ProbeError("The return carried no authorization code.")
    returned_client = params.get("client_id")
    if attempt.client_id == REGISTRATION_CLIENT_ID:
        if not returned_client or returned_client == REGISTRATION_CLIENT_ID:
            raise ProbeError("Registration is incomplete: the return carried no issued client id.")
        client_id = returned_client
    else:
        if returned_client and returned_client != attempt.client_id:
            raise ProbeError("The return names a different client id; the saved registration was kept.")
        client_id = attempt.client_id

    tokens = _token_request(
        client,
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "code_verifier": attempt.verifier,
            "redirect_uri": attempt.redirect_uri,
            "resource": API_BASE,
        },
    )
    missing = [name for name in TOKEN_FIELDS if not isinstance(tokens.get(name), str)]
    if missing:
        raise ProbeError(f"The token response lacks {', '.join(missing)}; it has {', '.join(sorted(tokens))}.")
    try:
        claims = validate_id_token(
            client, tokens["id_token"], client_id=client_id, nonce=attempt.nonce, discovery=discovery
        )
        if record.get("subject") and record["subject"] != claims["sub"]:
            raise ProbeError("A different ChatGPT account signed in; the saved account was kept.")
    except ProbeError as error:
        # The code is spent, so say what came back and end the session that was just opened.
        revoked = revoke(client, discovery, client_id, tokens["refresh_token"]) == 200
        shape = json.dumps(token_shape(tokens["id_token"]), sort_keys=True)
        outcome = "was revoked" if revoked else "could not be revoked; disconnect the app in ChatGPT's settings"
        raise ProbeError(
            f"{error} The new tokens were discarded and the session {outcome}. ID token: {shape}"
        ) from error

    record["client_id"] = client_id
    record["subject"] = claims["sub"]
    if isinstance(claims.get("email"), str):
        record["email"] = claims["email"]
    _store_tokens(record, tokens)
    save_record(path, record)
    return {
        **_token_summary(tokens),
        "id_token_has_email": "email" in claims,
        "id_token_email_verified": claims.get("email_verified"),
        "issued_client_id_prefix": client_id.split("_", 1)[0] if "_" in client_id else "no underscore",
        "return_fields": sorted(params),
        "discovery_matches_documented_endpoints": discovery.matches_documented_endpoints,
    }


def refresh_tokens(client: httpx.Client, path: Path, record: JsonObject) -> JsonObject:
    """Renew the tokens. The replacement refresh token is saved before anything uses the new access token."""

    client_id, refresh_token = record.get("client_id"), record.get("refresh_token")
    if not isinstance(client_id, str) or not isinstance(refresh_token, str):
        raise ProbeError("Not signed in: run sign-in first.")
    previous_earliest = record.get("earliest_refresh_at")
    tokens = _token_request(
        client,
        {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": refresh_token,
            "resource": API_BASE,
        },
    )
    if not isinstance(tokens.get("access_token"), str) or not isinstance(tokens.get("refresh_token"), str):
        raise ProbeError("The refresh response lacks an access or refresh token; the saved tokens were kept.")
    rotated = tokens["refresh_token"] != refresh_token
    _store_tokens(record, tokens)
    save_record(path, record)
    return {
        **_token_summary(tokens),
        "refresh_token_rotated": rotated,
        "refreshed_at": record["saved_at"],
        "previous_earliest_refresh_at": previous_earliest,
    }


def access_token(client: httpx.Client, path: Path, record: JsonObject) -> str:
    token = record.get("access_token")
    if not isinstance(token, str):
        raise ProbeError("Not signed in: run sign-in first.")
    expires_at = record.get("expires_at")
    if not isinstance(expires_at, int | float) or expires_at - time.time() < REFRESH_MARGIN_SECONDS:
        refresh_tokens(client, path, record)
        token = str(record["access_token"])
    return token


def sign_out(client: httpx.Client, path: Path, record: JsonObject) -> JsonObject:
    """Revoke the renewable session at OpenAI, then drop the tokens. The registration and host id stay.

    The tokens are removed only once OpenAI confirms, or when there is nothing
    to revoke. Otherwise they are kept so the sign-out can be tried again.
    """

    client_id, refresh_token = record.get("client_id"), record.get("refresh_token")
    status: int | None = None
    reason = "nothing to revoke"
    if isinstance(client_id, str) and isinstance(refresh_token, str):
        try:
            discovery = discover(client)
        except (ProbeError, httpx.HTTPError) as error:
            reason = str(error) if isinstance(error, ProbeError) else f"request failed ({type(error).__name__})"
        else:
            if discovery.revocation_endpoint is None:
                reason = "the discovery document names no revocation endpoint on OpenAI's own host"
            else:
                status = revoke(client, discovery, client_id, refresh_token)
                reason = "no answer from the revocation endpoint" if status is None else f"status {status}"
        confirmed = status == 200
    else:
        confirmed = True
    if confirmed:
        for name in (*TOKEN_FIELDS, "expires_at", "earliest_refresh_at"):
            record.pop(name, None)
        save_record(path, record)
    return {"revocation_confirmed": confirmed, "revocation": reason, "tokens_removed": confirmed}


# --- The plan route ---------------------------------------------------------


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


MODEL_TEXT_LIMIT = 200


def _brief(value: Any) -> Any:
    """Stand a length in for long text, such as the instructions a model item carries for another product."""

    if isinstance(value, str) and len(value) > MODEL_TEXT_LIMIT:
        return f"<{len(value)} characters>"
    if isinstance(value, dict):
        return {name: _brief(item) for name, item in value.items()}
    if isinstance(value, list):
        return [_brief(item) for item in value]
    return value


def list_models(client: httpx.Client, token: str) -> JsonObject:
    response = client.get(f"{API_BASE}/models", headers=_bearer(token))
    payload = _json_object(response)
    if response.status_code != 200:
        raise ProbeError(f"The model list answered {response.status_code} ({_error_code(payload)}).")
    listed = payload.get("models", payload.get("data"))
    items = [item for item in listed if isinstance(item, dict)] if isinstance(listed, list) else []
    item_fields: dict[str, set[str]] = {}
    for item in items:
        for name, value in item.items():
            item_fields.setdefault(str(name), set()).add(type(value).__name__)
    return {
        "top_level_fields": sorted(payload),
        "count": len(items),
        "item_fields": {name: sorted(kinds) for name, kinds in sorted(item_fields.items())},
        "items": [_brief(item) for item in items],
    }


@dataclass
class TrialResult:
    """What one request showed. `output` keeps the raw items for a follow-up request and is never printed."""

    name: str
    status: int
    note: str = ""
    terminal: str | None = None
    error: JsonObject | None = None
    event_types: list[str] = field(default_factory=list)
    items_from: str | None = None
    item_types: list[str] = field(default_factory=list)
    function_calls: list[JsonObject] = field(default_factory=list)
    encrypted_reasoning: bool = False
    usage_fields: list[str] = field(default_factory=list)
    text: str = ""
    output: list[JsonObject] = field(default_factory=list, repr=False)

    def printable(self) -> JsonObject:
        return {
            "name": self.name,
            "note": self.note,
            "status": self.status,
            "terminal": self.terminal,
            "error": self.error,
            "event_types": self.event_types,
            "items_from": self.items_from,
            "item_types": self.item_types,
            "function_calls": self.function_calls,
            "encrypted_reasoning": self.encrypted_reasoning,
            "usage_fields": self.usage_fields,
            "text": self.text,
        }


def _error_summary(payload: Mapping[str, Any], redact: Redact) -> JsonObject:
    error = payload.get("error")
    if isinstance(error, Mapping):
        return {
            "shape": "error object",
            "code": error.get("code"),
            "type": error.get("type"),
            "param": error.get("param"),
            "message": redact(str(error.get("message", "")))[:300],
        }
    if "detail" in payload:
        return {"shape": "detail", "detail": redact(str(payload["detail"]))[:300]}
    return {"shape": "other", "fields": sorted(payload)}


def _sse_events(lines: Iterable[str]) -> Iterator[JsonObject]:
    data: list[str] = []
    for line in (*lines, ""):
        if line.startswith("data:"):
            data.append(line[5:].strip())
        elif not line and data:
            with contextlib.suppress(ValueError):
                event = json.loads("\n".join(data))
                if isinstance(event, dict):
                    yield event
            data = []


def _set_output(result: TrialResult, items: list[JsonObject], source: str) -> None:
    result.output = items
    result.items_from = source
    result.item_types = [str(item.get("type")) for item in items]
    result.function_calls = [
        {
            "name": item.get("name"),
            "namespace": item.get("namespace"),
            "has_call_id": bool(item.get("call_id")),
            "arguments": item.get("arguments"),
        }
        for item in items
        if item.get("type") == "function_call"
    ]
    result.encrypted_reasoning = any(
        item.get("type") == "reasoning" and bool(item.get("encrypted_content")) for item in items
    )


def _apply_event(result: TrialResult, event: Mapping[str, Any], redact: Redact) -> None:
    kind = str(event.get("type"))
    if kind not in result.event_types:
        result.event_types.append(kind)
    if kind == "response.output_text.delta" and len(result.text) < 200:
        result.text = (result.text + str(event.get("delta", "")))[:200]
    elif kind == "response.output_item.done" and isinstance(event.get("item"), dict):
        # Kept in case the terminal event carries no items: the two must not be confused.
        _set_output(result, [*result.output, event["item"]], "output_item.done events")
    elif kind == "error":
        result.terminal = "error"
        result.error = _error_summary({"error": event}, redact)
    elif kind in ("response.completed", "response.failed", "response.incomplete"):
        result.terminal = kind
        response = event.get("response")
        response = response if isinstance(response, Mapping) else {}
        output = response.get("output")
        items = [item for item in output if isinstance(item, dict)] if isinstance(output, list) else []
        if items:
            _set_output(result, items, "terminal event")
        usage = response.get("usage")
        result.usage_fields = sorted(str(name) for name in usage) if isinstance(usage, Mapping) else []
        if isinstance(response.get("error"), Mapping):
            result.error = _error_summary({"error": response["error"]}, redact)
        elif isinstance(response.get("incomplete_details"), Mapping):
            result.error = {"shape": "incomplete", "reason": response["incomplete_details"].get("reason")}


def stream_response(
    client: httpx.Client, token: str, body: Mapping[str, Any], *, name: str, redact: Redact, note: str = ""
) -> TrialResult:
    headers = {**_bearer(token), "Accept": "text/event-stream"}
    with client.stream("POST", f"{API_BASE}/responses", headers=headers, json=dict(body)) as response:
        result = TrialResult(name=name, status=response.status_code, note=note)
        if response.status_code != 200:
            response.read()
            result.error = _error_summary(_json_object(response), redact)
            return result
        for event in _sse_events(response.iter_lines()):
            _apply_event(result, event, redact)
    return result


def post_route(
    client: httpx.Client, token: str, route: str, body: Mapping[str, Any], *, name: str, redact: Redact
) -> TrialResult:
    response = client.post(f"{API_BASE}{route}", headers=_bearer(token), json=dict(body))
    result = TrialResult(name=name, status=response.status_code)
    if response.status_code != 200:
        result.error = _error_summary(_json_object(response), redact)
    return result


def red_square_png(size: int = 16) -> bytes:
    """A tiny solid red PNG, so the image trial needs no file."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = (b"\x00" + b"\xff\x00\x00" * size) * size
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


NOTE_FUNCTION: JsonObject = {
    "type": "function",
    "name": "record_note",
    "description": "Record a short note.",
    "parameters": {
        "type": "object",
        "properties": {"note": {"type": "string"}},
        "required": ["note"],
        "additionalProperties": False,
    },
    "strict": True,
}
NOTE_NAMESPACE: JsonObject = {
    "type": "namespace",
    "name": "probe",
    "description": "Tools for the route probe.",
    "tools": [NOTE_FUNCTION],
}
READY_PROMPT: list[JsonObject] = [{"role": "user", "content": "Reply with the single word: ready"}]
NOTE_PROMPT: list[JsonObject] = [
    {"role": "user", "content": "Call the record_note tool with the note 'ok'. Do not answer in text."}
]
THINK_PROMPT: list[JsonObject] = [
    {
        "role": "user",
        "content": "Work out 17 times 23, then call the record_note tool with the product as the note. "
        "Do not answer in text.",
    }
]
SEARCH_PROMPT: list[JsonObject] = [
    {"role": "user", "content": "Search the web for today's date in UTC and answer with that date only."}
]
PATCH_PROMPT: list[JsonObject] = [
    {
        "role": "user",
        "content": "Use the apply_patch tool to create a file named note.txt whose only line is: ok. "
        "Do not answer in text.",
    }
]


def tool_follow_up(first: TrialResult, prompt: Sequence[JsonObject]) -> list[JsonObject] | None:
    """Replay a tool round by hand, as an unstored request must: each call, its result and any encrypted reasoning."""

    if not any(item.get("type") in ("function_call", "apply_patch_call") for item in first.output):
        return None
    items: list[JsonObject] = list(prompt)
    for item in first.output:
        if item.get("type") == "reasoning" and item.get("encrypted_content"):
            items.append(
                {
                    "type": "reasoning",
                    "id": item.get("id"),
                    "summary": item.get("summary", []),
                    "encrypted_content": item["encrypted_content"],
                }
            )
        elif item.get("type") == "function_call":
            call: JsonObject = {
                "type": "function_call",
                "call_id": item.get("call_id"),
                "name": item.get("name"),
                "arguments": item.get("arguments", "{}"),
            }
            if item.get("namespace"):
                call["namespace"] = item["namespace"]
            items.append(call)
            items.append({"type": "function_call_output", "call_id": item.get("call_id"), "output": "recorded"})
        elif item.get("type") == "apply_patch_call":
            items.append(
                {
                    "type": "apply_patch_call",
                    "call_id": item.get("call_id"),
                    "status": item.get("status", "completed"),
                    "operation": item.get("operation"),
                }
            )
            items.append(
                {
                    "type": "apply_patch_call_output",
                    "call_id": item.get("call_id"),
                    "status": "completed",
                    "output": "Created note.txt",
                }
            )
    return items


def sdk_trial(token: str, model: str, transport: Any = None) -> TrialResult:
    """Send one request through the pinned OpenAI SDK, built the way the plan's model client must be.

    That means no redirects, no SDK retries, and no organization or project
    header taken from the environment.
    """

    import openai

    result = TrialResult(name="sdk_stream", status=200)
    if os.environ.get("OPENAI_CUSTOM_HEADERS"):
        result.status = 0
        result.error = {"shape": "skipped", "reason": "OPENAI_CUSTOM_HEADERS is set in this shell"}
        return result
    prompt: Any = READY_PROMPT
    # The SDK would otherwise add these from OPENAI_ORG_ID and OPENAI_PROJECT_ID.
    no_shell_identity: dict[str, Any] = {"OpenAI-Organization": openai.Omit(), "OpenAI-Project": openai.Omit()}
    try:
        with openai.OpenAI(
            api_key=token,
            base_url=API_BASE,
            max_retries=0,
            http_client=openai.DefaultHttpxClient(follow_redirects=False, transport=transport),
            default_headers=no_shell_identity,
        ) as sdk:
            for event in sdk.responses.create(model=model, input=prompt, store=False, stream=True):
                if event.type not in result.event_types:
                    result.event_types.append(event.type)
                if event.type in ("response.completed", "response.failed", "response.incomplete"):
                    result.terminal = event.type
    except Exception as error:  # the SDK's own error classes are what this trial reports
        result.status = int(getattr(error, "status_code", 0) or 0)
        result.error = {"shape": type(error).__name__, "code": _safe_code(getattr(error, "code", None))}
    return result


def trials(client: httpx.Client, token: str, model: str, redact: Redact) -> dict[str, Callable[[], list[TrialResult]]]:
    """Name every request the plan needs an answer about. Each sends one or two small requests."""

    def lost(name: str, note: str, error: httpx.HTTPError) -> TrialResult:
        # One lost connection must not hide what the other requests show, or drop a result already in hand.
        return TrialResult(name=name, status=0, note=note, error={"shape": "transport", "error": type(error).__name__})

    def ask(name: str, note: str = "", **fields: Any) -> TrialResult:
        body = {"model": model, "store": False, "stream": True, "input": READY_PROMPT, **fields}
        try:
            return stream_response(client, token, body, name=name, redact=redact, note=note)
        except httpx.HTTPError as error:
            return lost(name, note, error)

    def route(name: str, path: str, body: JsonObject) -> TrialResult:
        try:
            return post_route(client, token, path, body, name=name, redact=redact)
        except httpx.HTTPError as error:
            return lost(name, "", error)

    def round_trip(name: str, prompt: list[JsonObject], tools: list[JsonObject], **fields: Any) -> list[TrialResult]:
        first = ask(name, input=prompt, tools=tools, **fields)
        follow_up = tool_follow_up(first, prompt)
        if follow_up is None:
            if first.terminal == "response.completed":
                first.note = "the model made no tool call, so nothing was replayed"
            return [first]
        return [first, ask(f"{name}_follow_up", input=follow_up, tools=tools, **fields)]

    def reasoning_replay() -> list[TrialResult]:
        # Low effort on a trivial call returned no reasoning item, which left nothing to replay.
        results = round_trip(
            "reasoning_replay",
            THINK_PROMPT,
            [NOTE_NAMESPACE],
            reasoning={"effort": "high"},
            include=["reasoning.encrypted_content"],
        )
        if len(results) == 2 and not results[0].encrypted_reasoning:
            results[1].note = "the first response held no encrypted reasoning item, so none was replayed"
        return results

    image = base64.b64encode(red_square_png()).decode("ascii")
    return {
        "plain": lambda: [ask("plain")],
        "instructions_and_developer": lambda: [
            ask(
                "instructions_and_developer",
                instructions="Answer in one word.",
                input=[{"role": "developer", "content": "The user is testing a connection."}, *READY_PROMPT],
            )
        ],
        "system_role_item": lambda: [
            ask(
                "system_role_item",
                input=[{"type": "message", "role": "system", "content": "Answer in one word."}, *READY_PROMPT],
            )
        ],
        "flat_function_tool": lambda: [ask("flat_function_tool", input=NOTE_PROMPT, tools=[NOTE_FUNCTION])],
        "namespace_tool": lambda: [ask("namespace_tool", input=NOTE_PROMPT, tools=[NOTE_NAMESPACE])],
        "additional_tools": lambda: [
            ask(
                "additional_tools",
                input=[{"type": "additional_tools", "role": "developer", "tools": [NOTE_FUNCTION]}, *NOTE_PROMPT],
            )
        ],
        "tool_choice_and_parallel": lambda: [
            ask(
                "tool_choice_and_parallel",
                input=NOTE_PROMPT,
                tools=[NOTE_NAMESPACE],
                tool_choice="auto",
                parallel_tool_calls=False,
            )
        ],
        "tool_round_trip": lambda: round_trip("tool_round_trip", NOTE_PROMPT, [NOTE_NAMESPACE]),
        "reasoning_effort": lambda: [ask("reasoning_effort", reasoning={"effort": "low"})],
        "reasoning_replay": reasoning_replay,
        "prompt_cache_key": lambda: [ask("prompt_cache_key", prompt_cache_key="animama-probe")],
        "text_format": lambda: [
            ask(
                "text_format",
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "probe",
                        "strict": True,
                        "schema": {
                            "type": "object",
                            "properties": {"word": {"type": "string"}},
                            "required": ["word"],
                            "additionalProperties": False,
                        },
                    }
                },
            )
        ],
        "image_input": lambda: [
            ask(
                "image_input",
                input=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "What colour is this square? Answer in one word."},
                            {"type": "input_image", "image_url": f"data:image/png;base64,{image}"},
                        ],
                    }
                ],
            )
        ],
        "context_management": lambda: [
            ask(
                "context_management",
                note="admission only: a prompt this short cannot reach the compaction threshold",
                context_management=[{"type": "compaction", "compact_threshold": 90000}],
            )
        ],
        "web_search": lambda: [
            ask(
                "web_search",
                note="a search ran only if item_types includes web_search_call",
                input=SEARCH_PROMPT,
                tools=[{"type": "web_search", "search_context_size": "low"}],
            )
        ],
        "apply_patch": lambda: round_trip("apply_patch", PATCH_PROMPT, [{"type": "apply_patch"}]),
        "rejected_field": lambda: [ask("rejected_field", max_output_tokens=64)],
        "sdk_stream": lambda: [sdk_trial(token, model)],
        "embeddings_route": lambda: [
            route("embeddings_route", "/embeddings", {"model": "text-embedding-3-small", "input": "probe"})
        ],
        "moderations_route": lambda: [
            route("moderations_route", "/moderations", {"model": "omni-moderation-latest", "input": "probe"})
        ],
    }


# --- Commands ---------------------------------------------------------------


def _sign_in(args: argparse.Namespace) -> int:
    path: Path = args.credentials
    record = load_record(path)
    save_record(path, record)  # the host id is kept from before the first sign-in
    with http_client() as client:
        discovery = discover(client)  # before the browser opens, so a failure here spends no code
        server = open_callback_server(args.port)
        try:
            attempt = new_attempt(record, f"http://127.0.0.1:{server.server_address[1]}{CALLBACK_PATH}")
            if not webbrowser.open(authorize_url(record, attempt)):
                raise ProbeError("No browser could be opened on this machine.")
            print("Opened OpenAI's sign-in page in your browser. Waiting for the return...")
            params = wait_for_callback(server, args.timeout)
        finally:
            server.server_close()
        summary = complete_sign_in(client, path, record, attempt, params, discovery)
    emit("sign-in", summary, redactor(record))
    return 0


def _models(args: argparse.Namespace) -> int:
    record = load_record(args.credentials)
    redact = redactor(record)
    with http_client() as client:
        summary = list_models(client, access_token(client, args.credentials, record))
    emit("models", summary, redact)
    return 0


def _requests(args: argparse.Namespace) -> int:
    if args.list:
        with http_client() as unused:
            print("\n".join(trials(unused, "", "", str)))
        return 0
    if not args.model:
        raise ProbeError("Name a model with --model; `models` lists the account's slugs.")
    record = load_record(args.credentials)
    redact = redactor(record)
    sent = 0
    with http_client() as client:
        available = trials(client, access_token(client, args.credentials, record), args.model, redact)
        unknown = sorted(set(args.only or []) - set(available))
        if unknown:
            raise ProbeError(f"Unknown trial: {', '.join(unknown)}. `requests --list` names them.")
        try:
            for name in args.only or list(available):
                for result in available[name]():
                    # A skipped trial sent nothing, so it does not count against the plan.
                    sent += (result.error or {}).get("shape") != "skipped"
                    emit(result.name, result.printable(), redact)
        finally:
            print(f"== {sent} requests sent")
    return 0


def _refresh(args: argparse.Namespace) -> int:
    record = load_record(args.credentials)
    redact = redactor(record)
    with http_client() as client:
        summary = refresh_tokens(client, args.credentials, record)
    emit("refresh", summary, redact)
    return 0


def _sign_out(args: argparse.Namespace) -> int:
    record = load_record(args.credentials)
    redact = redactor(record)
    with http_client() as client:
        summary = sign_out(client, args.credentials, record)
    if args.delete:
        args.credentials.unlink(missing_ok=True)
        summary["credentials_file_deleted"] = True
    emit("sign-out", summary, redact)
    if summary["revocation_confirmed"]:
        return 0
    kept = "The file was deleted anyway." if args.delete else "The tokens were kept; run sign-out again."
    print(
        f"error: OpenAI did not confirm the sign-out. {kept} "
        "To end the session yourself, disconnect the app in ChatGPT's settings.",
        file=sys.stderr,
    )
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name: str, handler: Callable[[argparse.Namespace], int], summary: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=summary)
        sub.add_argument("--credentials", type=Path, required=True, help="token file, outside any Git work tree")
        sub.set_defaults(handler=handler)
        return sub

    sign_in = command("sign-in", _sign_in, "register or sign in, and save the tokens")
    sign_in.add_argument("--port", type=int, default=0, help="loopback port for the return (default: any free port)")
    sign_in.add_argument("--timeout", type=float, default=300.0, help="seconds to wait for the return")
    command("models", _models, "list the account's models and the fields each carries")
    requests = command("requests", _requests, "send the trial requests and report what the route accepts")
    requests.add_argument("--model", help="model slug from `models`")
    requests.add_argument("--only", action="append", metavar="NAME", help="run this trial only (repeatable)")
    requests.add_argument("--list", action="store_true", help="name the trials without sending anything")
    command("refresh", _refresh, "renew the tokens and report the response's fields")
    sign_out_parser = command("sign-out", _sign_out, "revoke the session and remove the tokens")
    sign_out_parser.add_argument("--delete", action="store_true", help="also delete the credentials file")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except ProbeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except httpx.HTTPError as error:
        print(f"error: the request failed ({type(error).__name__}).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
