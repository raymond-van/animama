"""OpenAI's sign-in service as the ChatGPT plan session reaches it: fixed hosts, no redirects (T4)."""

from __future__ import annotations

import base64
import hashlib
import time
from collections.abc import AsyncIterator
from urllib.parse import parse_qs, parse_qsl, urlsplit

import httpx
import jwt
import pytest
import pytest_asyncio

from animama.adapters.chatgpt_plan.openai_identity import (
    API_BASE,
    AUTHORIZE_URL,
    REGISTRATION_CLIENT_ID,
    TOKEN_URL,
    OpenAIChatGPTPlanIdentity,
)
from animama.app.ports.chatgpt_plan_port import AuthorizeRequest, ChatGPTPlanIdentityError
from tests.chatgpt_plan_fakes import ISSUER, FakeOpenAIAuth

HOST_ID = "urn:uuid:00000000-0000-4000-8000-000000000000"
REDIRECT = "http://127.0.0.1:8123/auth/callback"


@pytest.fixture
def fake() -> FakeOpenAIAuth:
    return FakeOpenAIAuth()


@pytest_asyncio.fixture
async def identity(fake: FakeOpenAIAuth) -> AsyncIterator[OpenAIChatGPTPlanIdentity]:
    adapter = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    yield adapter
    await adapter.aclose()


def _query(url: str) -> dict[str, str]:
    return {name: values[0] for name, values in parse_qs(urlsplit(url).query).items()}


def _request(**overrides: object) -> AuthorizeRequest:
    fields: dict[str, object] = {
        "client_id": None,
        "host_id": HOST_ID,
        "redirect_uri": REDIRECT,
        "state": "state-1",
        "nonce": "nonce-1",
        "code_challenge": "challenge-1",
    }
    fields.update(overrides)
    return AuthorizeRequest(**fields)  # type: ignore[arg-type]


def test_the_first_sign_in_registers_the_installation_under_its_own_name(
    identity: OpenAIChatGPTPlanIdentity,
) -> None:
    url = identity.authorize_url(_request())

    assert url.startswith(f"{AUTHORIZE_URL}?")
    assert _query(url) == {
        "client_id": REGISTRATION_CLIENT_ID,
        "agent_name_hint": "Animama",
        "ext_agent_host_id": HOST_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT,
        "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        "resource": API_BASE,
        "state": "state-1",
        "nonce": "nonce-1",
        "code_challenge": "challenge-1",
        "code_challenge_method": "S256",
    }


def test_a_returning_sign_in_uses_the_issued_client_and_hints(identity: OpenAIChatGPTPlanIdentity) -> None:
    url = identity.authorize_url(
        _request(client_id="app_issued", login_hint="person@example.test", prompt_consent=True)
    )

    query = _query(url)
    assert query["client_id"] == "app_issued" and "agent_name_hint" not in query
    assert (query["login_hint"], query["prompt"]) == ("person@example.test", "consent")
    assert query["ext_agent_host_id"] == HOST_ID


async def _signed_in(fake: FakeOpenAIAuth, identity: OpenAIChatGPTPlanIdentity) -> tuple[str, dict[str, str]]:
    verifier = "verifier-" + "x" * 50
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = fake.authorize(identity.authorize_url(_request(code_challenge=challenge)))
    return verifier, params


async def test_a_code_is_exchanged_with_its_verifier(fake: FakeOpenAIAuth, identity: OpenAIChatGPTPlanIdentity) -> None:
    verifier, params = await _signed_in(fake, identity)

    grant = await identity.exchange_code(
        client_id=params["client_id"], code=params["code"], verifier=verifier, redirect_uri=REDIRECT
    )

    assert grant.scopes is not None and "chatgpt.tokens.use.direct" in grant.scopes
    assert grant.expires_in == 3600 and isinstance(grant.earliest_refresh_at, float)
    assert grant.id_token is not None and grant.access_token.startswith("access-")
    form = dict(parse_qsl(fake.requests[-1].content.decode()))
    assert form == {
        "grant_type": "authorization_code",
        "client_id": "app_issued",
        "code": params["code"],
        "code_verifier": verifier,
        "redirect_uri": REDIRECT,
        "resource": API_BASE,
    }

    with pytest.raises(ChatGPTPlanIdentityError) as refused:
        await identity.exchange_code(
            client_id="app_issued", code=params["code"], verifier=verifier, redirect_uri=REDIRECT
        )
    assert (refused.value.code, refused.value.rejected) == ("invalid_grant", True)


async def test_scopes_come_from_the_access_token_when_the_response_omits_them(
    identity: OpenAIChatGPTPlanIdentity, fake: FakeOpenAIAuth
) -> None:
    access = jwt.encode({"scope": "openid chatgpt.tokens.use.direct"}, "k" * 32, algorithm="HS256")
    body = {"access_token": access, "refresh_token": "r", "id_token": "i", "expires_in": 3600}
    adapter = OpenAIChatGPTPlanIdentity(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)))
    try:
        grant = await adapter.refresh(client_id="app_issued", refresh_token="r0")
    finally:
        await adapter.aclose()

    assert grant.scopes == ("chatgpt.tokens.use.direct", "openid")
    assert grant.earliest_refresh_at is None


@pytest.mark.parametrize(
    ("status", "error", "rejected"),
    [
        (400, "invalid_grant", True),
        (401, "invalid_client", True),
        (400, "unauthorized_client", True),
        (400, "invalid_request", False),
        (403, "anything", False),
        (408, "timeout", False),
        (429, "slow_down", False),
    ],
)
async def test_a_refused_refresh_says_whether_the_grant_itself_was_rejected(
    fake: FakeOpenAIAuth, identity: OpenAIChatGPTPlanIdentity, status: int, error: str, rejected: bool
) -> None:
    fake.refresh_status, fake.refresh_error = status, error

    with pytest.raises(ChatGPTPlanIdentityError) as refused:
        await identity.refresh(client_id="app_issued", refresh_token="refresh-1")

    assert refused.value.rejected is rejected


@pytest.mark.parametrize("failure", ["server", "network", "garbled", "html403", "html404"])
async def test_a_temporary_failure_never_rejects_the_grant(failure: str) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if failure == "network":
            raise httpx.ConnectError("offline", request=request)
        if failure == "server":
            return httpx.Response(503, text="<html>maintenance</html>")
        if failure.startswith("html"):
            # A CDN or bot-check page is not OpenAI refusing the grant.
            return httpx.Response(int(failure[4:]), text="<html>maintenance</html>")
        return httpx.Response(200, text="not json")

    adapter = OpenAIChatGPTPlanIdentity(transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(ChatGPTPlanIdentityError) as failed:
            await adapter.refresh(client_id="app_issued", refresh_token="refresh-1")
    finally:
        await adapter.aclose()

    assert failed.value.rejected is False
    assert "maintenance" not in str(failed.value)


async def test_an_id_token_is_checked_against_the_published_keys(
    fake: FakeOpenAIAuth, identity: OpenAIChatGPTPlanIdentity
) -> None:
    good = fake.id_token(audience="app_issued", nonce="nonce-1")

    claims = await identity.validate_id_token(good, client_id="app_issued", nonce="nonce-1")
    assert (claims.subject, claims.email) == ("subject-1", "person@example.test")
    assert (
        await identity.validate_id_token(
            fake.id_token(audience="app_issued", nonce=None), client_id="app_issued", nonce=None
        )
    ).subject == "subject-1"

    other_key = FakeOpenAIAuth()
    bad_tokens = {
        "nonce": fake.id_token(audience="app_issued", nonce="another"),
        "missing nonce": fake.id_token(audience="app_issued", nonce=None),
        "audience": fake.id_token(audience="someone_else", nonce="nonce-1"),
        "issuer": fake.id_token(audience="app_issued", nonce="nonce-1", iss="https://auth.example.test"),
        "expired": fake.id_token(audience="app_issued", nonce="nonce-1", exp=int(time.time()) - 600),
        "another key": other_key.id_token(audience="app_issued", nonce="nonce-1"),
        "symmetric": jwt.encode(
            {"iss": ISSUER, "sub": "s", "aud": "app_issued", "nonce": "nonce-1", "iat": 1, "exp": 4_000_000_000},
            "k" * 32,
            algorithm="HS256",
            headers={"kid": "key-1"},
        ),
    }
    for name, token in bad_tokens.items():
        with pytest.raises(ChatGPTPlanIdentityError) as refused:
            await identity.validate_id_token(token, client_id="app_issued", nonce="nonce-1")
        assert refused.value.code == "id_token_invalid", name


async def test_rotated_signing_keys_are_fetched_again_once(
    fake: FakeOpenAIAuth, identity: OpenAIChatGPTPlanIdentity
) -> None:
    await identity.validate_id_token(
        fake.id_token(audience="app_issued", nonce=None), client_id="app_issued", nonce=None
    )
    fake.key_id = "key-2"
    fake.key = FakeOpenAIAuth().key

    claims = await identity.validate_id_token(
        fake.id_token(audience="app_issued", nonce=None), client_id="app_issued", nonce=None
    )

    assert claims.subject == "subject-1"
    assert [str(request.url) for request in fake.requests].count(f"{ISSUER}/.well-known/jwks.json") == 2


@pytest.mark.parametrize("field", ["issuer", "jwks_uri"])
async def test_a_discovery_document_pointing_elsewhere_is_refused(fake: FakeOpenAIAuth, field: str) -> None:
    fake.discovery_overrides[field] = "https://evil.example.test/keys"
    adapter = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    try:
        with pytest.raises(ChatGPTPlanIdentityError) as refused:
            await adapter.validate_id_token(fake.id_token(audience="a", nonce=None), client_id="a", nonce=None)
    finally:
        await adapter.aclose()

    assert refused.value.rejected is False
    assert all(request.url.host == "auth.openai.com" for request in fake.requests)


@pytest.mark.parametrize(
    ("revocation", "status", "confirmed"),
    [("documented", 200, True), ("documented", 503, False), ("elsewhere", 200, False), ("absent", 200, False)],
)
async def test_revocation_is_confirmed_only_by_openai(
    fake: FakeOpenAIAuth, revocation: str, status: int, confirmed: bool
) -> None:
    fake.revocation_status = status
    if revocation == "elsewhere":
        fake.discovery_overrides["revocation_endpoint"] = "https://evil.example.test/revoke"
    elif revocation == "absent":
        fake.discovery_overrides["revocation_endpoint"] = None
    adapter = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    try:
        result = await adapter.revoke(client_id="app_issued", refresh_token="refresh-9")
    finally:
        await adapter.aclose()

    assert result is confirmed
    assert all(request.url.host == "auth.openai.com" for request in fake.requests)


async def test_a_network_failure_during_revocation_is_unconfirmed() -> None:
    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    adapter = OpenAIChatGPTPlanIdentity(transport=httpx.MockTransport(offline))
    try:
        assert await adapter.revoke(client_id="app_issued", refresh_token="refresh-9") is False
    finally:
        await adapter.aclose()


async def test_redirects_are_not_followed_and_the_environment_cannot_move_the_hosts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example.test/v1")
    seen: list[httpx.Request] = []

    def moved(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"location": "https://elsewhere.example.test/token"})

    adapter = OpenAIChatGPTPlanIdentity(transport=httpx.MockTransport(moved))
    try:
        with pytest.raises(ChatGPTPlanIdentityError) as refused:
            await adapter.refresh(client_id="app_issued", refresh_token="refresh-1")
    finally:
        await adapter.aclose()

    assert refused.value.rejected is False
    assert [str(request.url) for request in seen] == [TOKEN_URL]
