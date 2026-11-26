"""A fake of OpenAI's sign-in service for ChatGPT plan tests.

It plays both the browser (``authorize`` reads the authorization URL and
returns what OpenAI would send back) and the server (``handle`` answers
discovery, signing keys, token and revocation requests). ID tokens are real
ES256 JWTs signed with a key the fake publishes, so validation runs unchanged.
"""

from __future__ import annotations

import base64
import hashlib
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from animama.adapters.chatgpt_plan import openai_identity as identity_module

ISSUER = identity_module.ISSUER
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
REVOCATION_URL = f"{ISSUER}/api/accounts/oauth/revoke"
PLAN_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"


@dataclass
class _Grant:
    client_id: str
    redirect_uri: str
    challenge: str
    nonce: str
    subject: str
    email: str
    scope: str


@dataclass
class FakeOpenAIAuth:
    """OpenAI's sign-in service, in memory. Set the public fields to steer it."""

    subject: str = "subject-1"
    email: str = "person@example.test"
    scope: str = PLAN_SCOPES
    issued_client_id: str = "app_issued"
    refresh_status: int = 200
    refresh_error: str = "invalid_grant"
    revocation_status: int = 200
    token_lifetime: int = 3600
    discovery_overrides: dict[str, Any] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)
    refreshes: int = 0
    revoked: list[str] = field(default_factory=list)
    key_id: str = "key-1"

    def __post_init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self._codes: dict[str, _Grant] = {}
        self._refresh_tokens: dict[str, _Grant] = {}
        self._issued = 0
        self.now = time.time

    # --- the browser --------------------------------------------------------

    def authorize(self, url: str, *, decline: bool = False) -> dict[str, str]:
        """Follow the authorization URL as a person would, and return the sign-in return's parameters."""

        parts = urlsplit(url)
        assert f"{parts.scheme}://{parts.netloc}{parts.path}" == identity_module.AUTHORIZE_URL
        query = {name: values[0] for name, values in parse_qs(parts.query).items()}
        if decline:
            return {"error": "access_denied", "state": query["state"]}
        client_id = query["client_id"]
        if client_id == identity_module.REGISTRATION_CLIENT_ID:
            client_id = self.issued_client_id
        self._issued += 1
        code = f"code-{self._issued}"
        self._codes[code] = _Grant(
            client_id=client_id,
            redirect_uri=query["redirect_uri"],
            challenge=query["code_challenge"],
            nonce=query["nonce"],
            subject=self.subject,
            email=self.email,
            scope=self.scope,
        )
        return {"code": code, "state": query["state"], "client_id": client_id, "iss": ISSUER, "scope": self.scope}

    # --- the server ---------------------------------------------------------

    def id_token(self, *, audience: str, nonce: str | None, **claims: Any) -> str:
        now = int(self.now())
        payload: dict[str, Any] = {
            "iss": ISSUER,
            "sub": self.subject,
            "aud": audience,
            "iat": now,
            "exp": now + 3600,
            "email": self.email,
            "email_verified": True,
            "name": "Person Name",
        }
        if nonce is not None:
            payload["nonce"] = nonce
        payload.update(claims)
        return jwt.encode(payload, self.key, algorithm="ES256", headers={"kid": self.key_id})

    def _tokens(self, grant: _Grant, *, nonce: str | None) -> dict[str, Any]:
        self._issued += 1
        refresh_token = f"refresh-{self._issued}"
        self._refresh_tokens[refresh_token] = grant
        return {
            "access_token": f"access-{self._issued}",
            "refresh_token": refresh_token,
            "id_token": self.id_token(audience=grant.client_id, nonce=nonce, sub=grant.subject, email=grant.email),
            "token_type": "Bearer",
            "expires_in": self.token_lifetime,
            "earliest_refresh_at": int(self.now()) + self.token_lifetime - 360,
            "scope": grant.scope,
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == identity_module.DISCOVERY_URL:
            document = {
                "issuer": ISSUER,
                "authorization_endpoint": identity_module.AUTHORIZE_URL,
                "token_endpoint": identity_module.TOKEN_URL,
                "jwks_uri": JWKS_URL,
                "revocation_endpoint": REVOCATION_URL,
                **self.discovery_overrides,
            }
            return httpx.Response(200, json=document)
        if url == JWKS_URL:
            key = {**ECAlgorithm.to_jwk(self.key.public_key(), as_dict=True), "kid": self.key_id, "use": "sig"}
            return httpx.Response(200, json={"keys": [key]})
        if url == identity_module.TOKEN_URL:
            return self._token(dict(parse_qsl(request.content.decode())))
        if url == REVOCATION_URL:
            form = dict(parse_qsl(request.content.decode()))
            self.revoked.append(form["token"])
            self._refresh_tokens.pop(form["token"], None)
            return httpx.Response(self.revocation_status)
        return httpx.Response(404, json={"error": "not_found"})

    def _token(self, form: dict[str, str]) -> httpx.Response:
        if form.get("resource") != identity_module.API_BASE:
            return httpx.Response(400, json={"error": "invalid_target"})
        if form["grant_type"] == "authorization_code":
            grant = self._codes.pop(form.get("code", ""), None)
            verifier = form.get("code_verifier", "")
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            if (
                grant is None
                or grant.client_id != form.get("client_id")
                or grant.redirect_uri != form.get("redirect_uri")
                or grant.challenge != challenge
            ):
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json=self._tokens(grant, nonce=grant.nonce))
        if form["grant_type"] == "refresh_token":
            self.refreshes += 1
            if self.refresh_status != 200:
                return httpx.Response(self.refresh_status, json={"error": self.refresh_error})
            grant = self._refresh_tokens.pop(form.get("refresh_token", ""), None)
            if grant is None or grant.client_id != form.get("client_id"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            # A refreshed ID token has no nonce, as the live service showed.
            return httpx.Response(200, json=self._tokens(grant, nonce=None))
        return httpx.Response(400, json={"error": "unsupported_grant_type"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)
