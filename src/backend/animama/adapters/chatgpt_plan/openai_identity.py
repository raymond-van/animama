"""OpenAI's "Sign in with ChatGPT" service, as an installation reaches it.

The flow is OAuth 2.0 authorization code with PKCE (S256) and OpenID Connect,
from OpenAI's guide for open-source apps that use a person's ChatGPT plan. The
first sign-in registers the installation dynamically (``dynamic_agent_client``
with the app's name and a stable host id); the return carries the issued
client id, which later sign-ins reuse.

Every origin is a constant: tokens go only to OpenAI's sign-in host, never to
a host taken from the environment (``OPENAI_BASE_URL`` does not apply) or from
a redirect, which is never followed. The discovery document is read only for
the issuer, signing keys and revocation endpoint, each held to the same host.
Errors carry short codes, never response text, so nothing a server echoes can
reach a log.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
import jwt

from animama.app.ports.chatgpt_plan_port import (
    REJECTING_ERRORS,
    AuthorizeRequest,
    ChatGPTPlanIdentityError,
    IdentityClaims,
    TokenGrant,
)
from animama.domain.chatgpt_plan import CHATGPT_PLAN_SCOPE

APP_NAME = "Animama"
ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{ISSUER}/api/accounts/authorize"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
API_BASE = "https://api.openai.com/v1"
REGISTRATION_CLIENT_ID = "dynamic_agent_client"
SCOPES = f"openid profile email offline_access resource.invoke {CHATGPT_PLAN_SCOPE}"
# The token's header chooses among these; a symmetric or unsigned token is refused.
_ID_TOKEN_ALGORITHMS = ("RS256", "ES256")
_LEEWAY_SECONDS = 30
_SAFE_CODE = re.compile(r"[A-Za-z0-9_.-]{1,80}")
_DEFAULT_LIFETIME_SECONDS = 3600.0


def _safe_code(value: object) -> str:
    return value if isinstance(value, str) and _SAFE_CODE.fullmatch(value) else "unrecognised"


def _on_sign_in_host(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parts = urlsplit(value)
    return parts.scheme == "https" and parts.netloc == urlsplit(ISSUER).netloc


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


@dataclass(frozen=True, slots=True)
class _Discovery:
    issuer: str
    jwks_uri: str
    revocation_endpoint: str | None


class OpenAIChatGPTPlanIdentity:
    """Implement ``ChatGPTPlanIdentityPort`` over HTTPS with one pooled client.

    ``transport`` lets tests answer for OpenAI. The discovery document and the
    signing keys are cached; the keys are fetched again once when a token
    names a key id they lack, which is how a rotation shows.
    """

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None, app_name: str = APP_NAME) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=False,
            transport=transport,
            # Honour proxy settings as the OpenAI SDK does; an injected test transport takes none.
            trust_env=transport is None,
        )
        self._app_name = app_name
        self.issuer = ISSUER
        self._discovery: _Discovery | None = None
        self._keys: dict[str, jwt.PyJWK] = {}
        self._lock = asyncio.Lock()

    async def aclose(self) -> None:
        await self._client.aclose()

    def authorize_url(self, request: AuthorizeRequest) -> str:
        params = {
            "client_id": request.client_id or REGISTRATION_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": request.redirect_uri,
            "scope": SCOPES,
            "resource": API_BASE,
            "state": request.state,
            "nonce": request.nonce,
            "code_challenge": request.code_challenge,
            "code_challenge_method": "S256",
            "ext_agent_host_id": request.host_id,
        }
        if request.client_id is None:
            params["agent_name_hint"] = self._app_name
        if request.login_hint:
            params["login_hint"] = request.login_hint
        if request.prompt_consent:
            params["prompt"] = "consent"
        return f"{AUTHORIZE_URL}?{urlencode(params)}"

    async def exchange_code(self, *, client_id: str, code: str, verifier: str, redirect_uri: str) -> TokenGrant:
        return await self._token_request(
            {
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": redirect_uri,
                "resource": API_BASE,
            }
        )

    async def refresh(self, *, client_id: str, refresh_token: str) -> TokenGrant:
        return await self._token_request(
            {
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": refresh_token,
                "resource": API_BASE,
            }
        )

    async def validate_id_token(self, id_token: str, *, client_id: str, nonce: str | None) -> IdentityClaims:
        try:
            header = jwt.get_unverified_header(id_token)
        except jwt.PyJWTError as error:
            raise ChatGPTPlanIdentityError("id_token_invalid", rejected=True) from error
        algorithm = header.get("alg")
        if algorithm not in _ID_TOKEN_ALGORITHMS:
            raise ChatGPTPlanIdentityError("id_token_invalid", rejected=True)
        discovery = await self._discover()
        key = await self._signing_key(discovery, str(header.get("kid", "")))
        if key is None:
            raise ChatGPTPlanIdentityError("id_token_invalid", rejected=True)
        try:
            claims: dict[str, Any] = jwt.decode(
                id_token,
                key=key.key,
                algorithms=[str(algorithm)],
                audience=client_id,
                issuer=discovery.issuer,
                leeway=_LEEWAY_SECONDS,
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.PyJWTError as error:
            raise ChatGPTPlanIdentityError("id_token_invalid", rejected=True) from error
        if nonce is not None and not _same(claims.get("nonce"), nonce):
            raise ChatGPTPlanIdentityError("id_token_invalid", rejected=True)
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise ChatGPTPlanIdentityError("id_token_invalid", rejected=True)
        email = claims.get("email")
        return IdentityClaims(subject=subject, email=email if isinstance(email, str) and email else None)

    async def revoke(self, *, client_id: str, refresh_token: str) -> bool:
        try:
            discovery = await self._discover()
            if discovery.revocation_endpoint is None:
                return False
            response = await self._client.post(
                discovery.revocation_endpoint,
                data={"token": refresh_token, "token_type_hint": "refresh_token", "client_id": client_id},
                headers={"Accept": "application/json"},
            )
        except (httpx.HTTPError, ChatGPTPlanIdentityError):
            return False
        return response.status_code == 200

    async def _token_request(self, form: Mapping[str, str]) -> TokenGrant:
        try:
            response = await self._client.post(TOKEN_URL, data=dict(form), headers={"Accept": "application/json"})
        except httpx.HTTPError as error:
            raise ChatGPTPlanIdentityError("network_error", rejected=False) from error
        payload = _json_object(response)
        if response.status_code != 200:
            oauth_error = payload.get("error")
            # Only OpenAI's own OAuth answer can end the session; a status code alone never does.
            raise ChatGPTPlanIdentityError(
                _safe_code(oauth_error) if isinstance(oauth_error, str) else "temporarily_unavailable",
                rejected=response.status_code in (400, 401, 403) and oauth_error in REJECTING_ERRORS,
            )
        access, refresh, id_token = (payload.get(name) for name in ("access_token", "refresh_token", "id_token"))
        if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
            raise ChatGPTPlanIdentityError("token_response_invalid", rejected=False)
        return TokenGrant(
            access_token=access,
            refresh_token=refresh,
            id_token=id_token if isinstance(id_token, str) and id_token else None,
            expires_in=_positive_number(payload.get("expires_in")) or _DEFAULT_LIFETIME_SECONDS,
            # Unix seconds, as the live service sends it; any other form is ignored.
            earliest_refresh_at=_positive_number(payload.get("earliest_refresh_at")),
            scopes=_granted_scopes(payload.get("scope"), access),
        )

    async def _discover(self) -> _Discovery:
        if self._discovery is not None:
            return self._discovery
        async with self._lock:
            if self._discovery is None:
                self._discovery = await self._fetch_discovery()
            return self._discovery

    async def _fetch_discovery(self) -> _Discovery:
        try:
            response = await self._client.get(DISCOVERY_URL, headers={"Accept": "application/json"})
        except httpx.HTTPError as error:
            raise ChatGPTPlanIdentityError("network_error", rejected=False) from error
        document = _json_object(response)
        issuer, jwks_uri, revocation = (document.get(name) for name in ("issuer", "jwks_uri", "revocation_endpoint"))
        if response.status_code != 200 or not _on_sign_in_host(issuer) or not _on_sign_in_host(jwks_uri):
            raise ChatGPTPlanIdentityError("discovery_invalid", rejected=False)
        return _Discovery(
            issuer=str(issuer),
            jwks_uri=str(jwks_uri),
            revocation_endpoint=str(revocation) if _on_sign_in_host(revocation) else None,
        )

    async def _signing_key(self, discovery: _Discovery, key_id: str) -> jwt.PyJWK | None:
        if key_id in self._keys:
            return self._keys[key_id]
        async with self._lock:
            if key_id not in self._keys:
                self._keys = await self._fetch_keys(discovery)
            return self._keys.get(key_id)

    async def _fetch_keys(self, discovery: _Discovery) -> dict[str, jwt.PyJWK]:
        try:
            response = await self._client.get(discovery.jwks_uri, headers={"Accept": "application/json"})
        except httpx.HTTPError as error:
            raise ChatGPTPlanIdentityError("network_error", rejected=False) from error
        if response.status_code != 200:
            raise ChatGPTPlanIdentityError("signing_keys_unavailable", rejected=False)
        try:
            keys = jwt.PyJWKSet.from_dict(_json_object(response)).keys
        except jwt.PyJWTError as error:
            raise ChatGPTPlanIdentityError("signing_keys_unavailable", rejected=False) from error
        return {key.key_id: key for key in keys if key.key_id}


def _positive_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or value <= 0:
        return None
    return float(value)


def _same(left: object, right: str) -> bool:
    return isinstance(left, str) and hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def _granted_scopes(reported: object, access_token: str) -> tuple[str, ...] | None:
    """The scopes OpenAI granted: from the response, else from the access token's own claims, else unknown."""

    if not isinstance(reported, str):
        try:
            claims = jwt.decode(access_token, options={"verify_signature": False})
        except (jwt.PyJWTError, json.JSONDecodeError):
            return None
        reported = claims.get("scope")
    if isinstance(reported, list):
        return tuple(sorted(str(scope) for scope in reported))
    return tuple(sorted(reported.split())) if isinstance(reported, str) else None
