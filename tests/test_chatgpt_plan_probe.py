"""Offline tests for the ChatGPT plan probe (scripts/chatgpt_plan_probe.py).

A person runs the probe with real tokens. These tests use a fake OpenAI, so
nothing here reaches a provider.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import struct
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlsplit

import httpx
import httpx2
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from scripts import chatgpt_plan_probe as probe

EMAIL = "person@example.test"
CODE = "authorization-code-sentinel"
REDIRECT = "http://127.0.0.1:1455/auth/callback"
JWKS_URL = f"{probe.ISSUER}/.well-known/jwks.json"
REVOCATION_URL = f"{probe.ISSUER}/api/accounts/oauth/revoke"


def _sse(*events: dict[str, Any]) -> httpx.Response:
    content = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=content.encode())


# Unix seconds, the form the live token response uses. The value is made up.
EARLIEST_REFRESH_AT = 1_800_000_000


def _completed(*items: dict[str, Any]) -> httpx.Response:
    response = {"output": list(items), "usage": {"input_tokens": 3, "output_tokens": 1}}
    return _sse(
        {"type": "response.output_text.delta", "delta": "ready"},
        {"type": "response.completed", "response": response},
    )


class FakeOpenAI:
    """Enough of OpenAI's sign-in and plan route to exercise the probe."""

    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.signing_key: Any = self.key
        self.algorithm = "ES256"
        self.client_id = "oaiapp_issued"
        self.nonce = ""
        self.audience = self.client_id
        self.scope: str | None = probe.SCOPES
        self.refresh_fails = False
        self.refreshes = 0
        self.discovery: dict[str, Any] = {
            "issuer": probe.ISSUER,
            "jwks_uri": JWKS_URL,
            "revocation_endpoint": REVOCATION_URL,
            "authorization_endpoint": probe.AUTHORIZE_URL,
            "token_endpoint": probe.TOKEN_URL,
        }
        self.revocation_status = 200
        self.model_extra: dict[str, Any] = {}
        self.requests: list[httpx.Request] = []
        self.on_response: Callable[[dict[str, Any]], httpx.Response] = lambda body: _completed(
            {"type": "message", "role": "assistant"}
        )

    def _jwt(self, **claims: Any) -> str:
        now = int(time.time())
        payload = {"iss": probe.ISSUER, "sub": "subject-sentinel", "iat": now, "exp": now + 3600, **claims}
        return jwt.encode(payload, self.signing_key, algorithm=self.algorithm, headers={"kid": "key-1"})

    def _tokens(self) -> dict[str, Any]:
        tokens = {
            "access_token": self._jwt(aud=probe.API_BASE, jti=f"access-{self.refreshes}"),
            "refresh_token": f"refresh-sentinel-{self.refreshes}",
            "id_token": self._jwt(aud=self.audience, nonce=self.nonce, email=EMAIL, email_verified=True),
            "token_type": "Bearer",
            "expires_in": 3600,
            "earliest_refresh_at": EARLIEST_REFRESH_AT,
        }
        return tokens if self.scope is None else {**tokens, "scope": self.scope}

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == probe.DISCOVERY_URL:
            return httpx.Response(200, json=self.discovery)
        if url == probe.TOKEN_URL:
            form = dict(parse_qsl(request.content.decode()))
            if form["grant_type"] == "refresh_token":
                if self.refresh_fails:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                self.refreshes += 1
            elif form.get("code") != CODE or form.get("redirect_uri") != REDIRECT or not form.get("code_verifier"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json=self._tokens())
        if url == JWKS_URL:
            key = {**ECAlgorithm.to_jwk(self.key.public_key(), as_dict=True), "kid": "key-1", "use": "sig"}
            return httpx.Response(200, json={"keys": [key]})
        if url == REVOCATION_URL:
            return httpx.Response(self.revocation_status)
        if url == f"{probe.API_BASE}/models":
            item = {"slug": "gpt-test", "display_name": "GPT Test", "visibility": "list", "context_window": 1000}
            return httpx.Response(200, json={"models": [{**item, **self.model_extra}]})
        if url == f"{probe.API_BASE}/responses":
            return self.on_response(json.loads(request.content))
        return httpx.Response(403, json={"detail": "This route is not available for ChatGPT plan usage."})

    def sent_to(self, url: str) -> list[httpx.Request]:
        return [item for item in self.requests if str(item.url) == url]

    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(item.content) for item in self.sent_to(f"{probe.API_BASE}/responses")]


@pytest.fixture
def fake() -> FakeOpenAI:
    return FakeOpenAI()


@pytest.fixture
def client(fake: FakeOpenAI) -> httpx.Client:
    return probe.http_client(httpx.MockTransport(fake.handle))


@pytest.fixture
def offline(fake: FakeOpenAI, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the probe's commands at the fake, since they build their own client."""

    real = probe.http_client
    monkeypatch.setattr(probe, "http_client", lambda: real(httpx.MockTransport(fake.handle)))


def _attempt(path: Path, fake: FakeOpenAI) -> tuple[dict[str, Any], probe.Attempt, dict[str, str]]:
    record = probe.load_record(path)
    attempt = probe.new_attempt(record, REDIRECT)
    fake.nonce = attempt.nonce
    return record, attempt, {"code": CODE, "state": attempt.state, "client_id": fake.client_id}


def _signed_in(tmp_path: Path, fake: FakeOpenAI, client: httpx.Client) -> tuple[Path, dict[str, Any]]:
    path = tmp_path / "plan.json"
    record, attempt, params = _attempt(path, fake)
    probe.complete_sign_in(client, path, record, attempt, params, probe.discover(client))
    fake.requests.clear()
    return path, record


def _on_disk(path: Path) -> dict[str, Any]:
    saved: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return saved


def _open(url: str) -> Any:
    """Fetch from the loopback listener, whatever proxy the machine's environment names."""

    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=5)


def test_credentials_file_is_private_and_refused_where_it_could_be_committed(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    (repository / ".git").mkdir(parents=True)
    with pytest.raises(probe.ProbeError, match="outside any Git work tree"):
        probe.load_record(repository / "nested" / "plan.json")

    path = tmp_path / "plan.json"
    record = probe.load_record(path)
    assert record["host_id"].startswith("urn:uuid:")
    probe.save_record(path, record)
    assert _on_disk(path) == record

    link = tmp_path / "link.json"
    link.symlink_to(path)
    with pytest.raises(probe.ProbeError, match="symbolic link"):
        probe.load_record(link)

    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        path.chmod(0o644)
        with pytest.raises(probe.ProbeError, match="owner only"):
            probe.load_record(path)


def test_an_interrupted_write_keeps_the_previous_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "plan.json"
    record = probe.load_record(path)
    probe.save_record(path, {**record, "refresh_token": "the-token-in-use"})

    def fail(source: Any, destination: Any) -> None:
        raise OSError("the disk went away")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError, match="the disk went away"):
        probe.save_record(path, {**record, "refresh_token": "the-replacement"})

    assert _on_disk(path)["refresh_token"] == "the-token-in-use"
    assert [item.name for item in tmp_path.iterdir()] == ["plan.json"]


def test_first_sign_in_registers_and_a_later_one_reuses_the_issued_client(tmp_path: Path) -> None:
    record = probe.load_record(tmp_path / "plan.json")
    first = probe.new_attempt(record, REDIRECT)
    query = parse_qs(urlsplit(probe.authorize_url(record, first)).query)

    assert query["client_id"] == [probe.REGISTRATION_CLIENT_ID]
    assert query["agent_name_hint"] == [probe.APP_NAME]
    assert query["ext_agent_host_id"] == [record["host_id"]]
    assert query["redirect_uri"] == [REDIRECT]
    assert query["resource"] == [probe.API_BASE]
    assert query["scope"] == [probe.SCOPES]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] == [first.challenge]
    assert "id_token_hint" not in query
    assert first.verifier not in probe.authorize_url(record, first)
    assert first.verifier not in repr(first)

    record.update(client_id="oaiapp_issued", id_token="retained-id-token", email=EMAIL)
    later = probe.new_attempt(record, REDIRECT)
    query = parse_qs(urlsplit(probe.authorize_url(record, later)).query)

    assert query["client_id"] == ["oaiapp_issued"]
    assert query["id_token_hint"] == ["retained-id-token"]
    assert query["login_hint"] == [EMAIL]
    assert "agent_name_hint" not in query
    assert later.state != first.state and later.verifier != first.verifier


def test_sign_in_saves_the_tokens_and_reports_shapes(tmp_path: Path, fake: FakeOpenAI, client: httpx.Client) -> None:
    path = tmp_path / "plan.json"
    record, attempt, params = _attempt(path, fake)

    summary = probe.complete_sign_in(client, path, record, attempt, params, probe.discover(client))

    saved = _on_disk(path)
    assert saved["client_id"] == fake.client_id
    assert saved["subject"] == "subject-sentinel"
    assert saved["refresh_token"] == "refresh-sentinel-0"
    assert summary["plan_use_granted"] is True
    assert summary["id_token"]["kind"] == "jwt"
    assert summary["id_token"]["algorithm"] == "ES256"
    assert "nonce" in summary["id_token"]["claims"]
    assert summary["refresh_token"] == {"kind": "opaque", "characters": len("refresh-sentinel-0")}
    assert summary["issued_client_id_prefix"] == "oaiapp"
    assert summary["discovery_matches_documented_endpoints"] is True
    exchange = dict(parse_qsl(fake.sent_to(probe.TOKEN_URL)[0].content.decode()))
    assert exchange["client_id"] == fake.client_id
    assert exchange["code_verifier"] == attempt.verifier
    assert exchange["resource"] == probe.API_BASE


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"state": "another-state"}, "state does not match"),
        ({"state": "état-non-ascii"}, "state does not match"),
        ({"error": "access_denied"}, "access_denied"),
        ({"error": "<b>free text from outside</b>"}, "unrecognised"),
        ({"code": ""}, "no authorization code"),
        ({"client_id": ""}, "no issued client id"),
    ],
)
def test_a_bad_return_exchanges_nothing(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client, change: dict[str, str], message: str
) -> None:
    path = tmp_path / "plan.json"
    record, attempt, params = _attempt(path, fake)
    discovery = probe.discover(client)
    fake.requests.clear()

    with pytest.raises(probe.ProbeError, match=message) as refused:
        probe.complete_sign_in(client, path, record, attempt, {**params, **change}, discovery)

    assert "free text" not in str(refused.value)
    assert fake.requests == []
    assert not path.exists()


@pytest.mark.parametrize("fault", ["nonce", "audience", "issuer", "another key", "symmetric algorithm", "code"])
def test_tokens_are_not_saved_when_validation_fails(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client, fault: str
) -> None:
    path = tmp_path / "plan.json"
    record, attempt, params = _attempt(path, fake)
    discovery = probe.discover(client)
    if fault == "nonce":
        fake.nonce = "a-different-sign-in"
    elif fault == "audience":
        fake.audience = "another-client"
    elif fault == "issuer":
        discovery = probe.Discovery(f"{probe.ISSUER}/other", JWKS_URL, REVOCATION_URL, True)
    elif fault == "another key":
        fake.signing_key = ec.generate_private_key(ec.SECP256R1())
    elif fault == "symmetric algorithm":
        fake.signing_key, fake.algorithm = "a-shared-secret-that-is-long-enough-for-hs256", "HS256"
    else:
        params["code"] = "replayed-code"

    with pytest.raises(probe.ProbeError) as refused:
        probe.complete_sign_in(client, path, record, attempt, params, discovery)

    assert not path.exists()
    assert "access_token" not in record
    if fault == "symmetric algorithm":
        assert "unexpected algorithm (HS256)" in str(refused.value)
    if fault != "code":
        # The code was spent, so the probe says what came back and ends the session it opened.
        assert '"kind": "jwt"' in str(refused.value)
        assert "was revoked" in str(refused.value)
        assert len(fake.sent_to(REVOCATION_URL)) == 1
        assert "refresh-sentinel" not in str(refused.value) and EMAIL not in str(refused.value)


def test_discovery_must_point_at_openais_own_host(fake: FakeOpenAI, client: httpx.Client) -> None:
    fake.discovery["jwks_uri"] = "https://elsewhere.example/keys.json"
    with pytest.raises(probe.ProbeError, match="another host"):
        probe.discover(client)

    fake.discovery["jwks_uri"] = JWKS_URL
    fake.discovery["revocation_endpoint"] = "https://elsewhere.example/revoke"
    fake.discovery["token_endpoint"] = "https://auth.openai.com/moved"
    discovery = probe.discover(client)

    assert discovery.revocation_endpoint is None
    assert discovery.matches_documented_endpoints is False


def test_a_saved_registration_refuses_another_client_or_account(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    path, record = _signed_in(tmp_path, fake, client)
    discovery = probe.discover(client)
    attempt = probe.new_attempt(record, REDIRECT)
    fake.nonce = attempt.nonce
    params = {"code": CODE, "state": attempt.state}

    with pytest.raises(probe.ProbeError, match="different client id"):
        probe.complete_sign_in(client, path, record, attempt, {**params, "client_id": "oaiapp_other"}, discovery)

    record["subject"] = "someone-else"
    with pytest.raises(probe.ProbeError, match="different ChatGPT account"):
        probe.complete_sign_in(client, path, record, attempt, params, discovery)
    assert _on_disk(path)["subject"] == "subject-sentinel"


def test_granted_scopes_come_from_the_response_or_the_access_token(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    fake.scope = "openid profile email offline_access"
    path = tmp_path / "declined.json"
    record, attempt, params = _attempt(path, fake)
    declined = probe.complete_sign_in(client, path, record, attempt, params, probe.discover(client))
    assert declined["plan_use_granted"] is False
    assert probe.PLAN_SCOPE not in declined["granted_scopes"]

    fake.scope = None
    silent = probe.refresh_tokens(client, path, record)
    assert silent["granted_scopes"] == probe.NOT_REPORTED
    assert silent["plan_use_granted"] == probe.NOT_REPORTED
    assert "scopes" not in _on_disk(path)

    claimed = {"access_token": fake._jwt(scope=f"openid {probe.PLAN_SCOPE}")}
    assert probe.granted_scopes(claimed) == sorted(["openid", probe.PLAN_SCOPE])


def test_the_listener_takes_only_its_path_and_logs_nothing(capfd: pytest.CaptureFixture[str]) -> None:
    server = probe.open_callback_server(0)
    port = server.server_address[1]
    returned: list[dict[str, str]] = []
    waiter = threading.Thread(target=lambda: returned.append(probe.wait_for_callback(server, 10)))
    waiter.start()
    try:
        with pytest.raises(urllib.error.HTTPError) as refused:
            _open(f"http://127.0.0.1:{port}/elsewhere?code={CODE}")
        assert refused.value.code == 404
        with _open(f"http://127.0.0.1:{port}/auth/callback?code={CODE}&state=s") as page:
            assert page.headers["Cache-Control"] == "no-store"
            assert CODE not in page.read().decode()
    finally:
        waiter.join(timeout=10)
        server.server_close()

    assert returned == [{"code": CODE, "state": "s"}]
    captured = capfd.readouterr()
    assert CODE not in captured.out + captured.err


def test_the_listener_gives_up_at_its_deadline_and_reports_a_busy_port(monkeypatch: pytest.MonkeyPatch) -> None:
    assert probe._CallbackHandler.timeout == 5
    monkeypatch.setattr(probe._CallbackHandler, "timeout", 0.2)
    server = probe.open_callback_server(0)
    port = server.server_address[1]
    try:
        with pytest.raises(probe.ProbeError, match="could not be opened"):
            probe.open_callback_server(port)
        # A connection that sends nothing must not hold the listener past its deadline.
        with socket.create_connection(("127.0.0.1", port), timeout=5):
            started = time.monotonic()
            with pytest.raises(probe.ProbeError, match="timeout"):
                probe.wait_for_callback(server, 0.5)
            assert time.monotonic() - started < 4
    finally:
        server.server_close()


def test_refresh_saves_the_replacement_token_and_keeps_the_old_one_on_failure(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    path, record = _signed_in(tmp_path, fake, client)

    summary = probe.refresh_tokens(client, path, record)

    assert summary["refresh_token_rotated"] is True
    assert summary["previous_earliest_refresh_at"] == EARLIEST_REFRESH_AT
    assert summary["refreshed_at"] == _on_disk(path)["saved_at"]
    assert _on_disk(path)["refresh_token"] == "refresh-sentinel-1"

    record["expires_at"] = time.time() + 10
    token = probe.access_token(client, path, record)
    assert fake.refreshes == 2
    assert token == _on_disk(path)["access_token"]
    assert probe.access_token(client, path, record) == token
    assert fake.refreshes == 2

    fake.refresh_fails = True
    with pytest.raises(probe.ProbeError, match="invalid_grant"):
        probe.refresh_tokens(client, path, record)
    assert _on_disk(path)["refresh_token"] == "refresh-sentinel-2"


def test_printed_output_carries_no_token_code_email_or_identifier(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "plan.json"
    record, attempt, params = _attempt(path, fake)
    summary = probe.complete_sign_in(client, path, record, attempt, params, probe.discover(client))
    redact = probe.redactor(record)
    secrets = [record["access_token"], record["refresh_token"], record["id_token"], EMAIL]
    identifiers = ["subject-sentinel", fake.client_id]
    # A provider error could echo anything the request or the account carried.
    echoed = " ".join([*secrets, *identifiers])
    fake.on_response = lambda body: httpx.Response(400, json={"error": {"code": "bad", "message": echoed}})

    probe.emit("sign-in", summary, redact)
    probe.emit("models", probe.list_models(client, record["access_token"]), redact)
    failed = probe.stream_response(client, record["access_token"], {"model": "gpt-test"}, name="t", redact=redact)
    probe.emit(failed.name, failed.printable(), redact)
    probe.emit("another token", {"note": fake._jwt(aud="x")}, redact)

    printed = capsys.readouterr().out
    assert all(value not in printed for value in [*secrets, *identifiers, CODE])
    assert "eyJ" not in printed
    assert "[redacted]" in printed and "[redacted-jwt]" in printed
    assert '"slug": "gpt-test"' in printed and '"context_window": 1000' in printed
    assert failed.error is not None and failed.error["code"] == "bad"


def test_an_issued_client_id_is_never_echoed_whole(tmp_path: Path, fake: FakeOpenAI, client: httpx.Client) -> None:
    fake.client_id = fake.audience = "issuedwithoutanunderscore"
    path = tmp_path / "plan.json"
    record, attempt, params = _attempt(path, fake)

    summary = probe.complete_sign_in(client, path, record, attempt, params, probe.discover(client))

    assert summary["issued_client_id_prefix"] == "no underscore"


def test_a_refresh_during_requests_cannot_leave_the_redactor_stale(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client, capsys: pytest.CaptureFixture[str], offline: None
) -> None:
    path, record = _signed_in(tmp_path, fake, client)
    probe.save_record(path, {**record, "expires_at": time.time() + 10})
    before = [record["access_token"], record["refresh_token"]]
    # The route echoes every credential the request could have carried, old and new.
    fake.on_response = lambda body: httpx.Response(
        400, json={"error": {"code": "bad", "message": " ".join([*before, "refresh-sentinel-1"])}}
    )

    assert probe.main(["requests", "--credentials", str(path), "--model", "gpt-test", "--only", "plain"]) == 0

    printed = capsys.readouterr().out
    after = _on_disk(path)
    assert fake.refreshes == 1 and after["refresh_token"] == "refresh-sentinel-1"
    assert all(value not in printed for value in [*before, after["access_token"], after["refresh_token"]])
    assert "== 1 requests sent" in printed


def test_sign_out_removes_tokens_only_once_openai_confirms(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    path, record = _signed_in(tmp_path, fake, client)

    fake.discovery["revocation_endpoint"] = "https://elsewhere.example/revoke"
    unreachable = probe.sign_out(client, path, record)
    assert unreachable["revocation_confirmed"] is False and unreachable["tokens_removed"] is False
    assert "elsewhere.example" not in {item.url.host for item in fake.requests}

    fake.discovery["revocation_endpoint"] = REVOCATION_URL
    fake.revocation_status = 503
    refused = probe.sign_out(client, path, record)
    assert refused == {"revocation_confirmed": False, "revocation": "status 503", "tokens_removed": False}
    assert _on_disk(path)["refresh_token"] == "refresh-sentinel-0"

    fake.revocation_status = 200
    summary = probe.sign_out(client, path, record)

    saved = _on_disk(path)
    assert summary == {"revocation_confirmed": True, "revocation": "status 200", "tokens_removed": True}
    assert not {"access_token", "refresh_token", "id_token"} & set(saved)
    assert saved["client_id"] == fake.client_id and saved["host_id"] == record["host_id"]
    assert dict(parse_qsl(fake.sent_to(REVOCATION_URL)[-1].content.decode())) == {
        "token": "refresh-sentinel-0",
        "token_type_hint": "refresh_token",
        "client_id": fake.client_id,
    }
    with pytest.raises(probe.ProbeError, match="Not signed in"):
        probe.access_token(client, path, saved)
    assert probe.sign_out(client, path, saved)["revocation"] == "nothing to revoke"


def test_the_sign_out_command_says_when_tokens_were_kept(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client, capsys: pytest.CaptureFixture[str], offline: None
) -> None:
    path, _ = _signed_in(tmp_path, fake, client)
    fake.revocation_status = 503

    assert probe.main(["sign-out", "--credentials", str(path)]) == 1
    assert "The tokens were kept" in capsys.readouterr().err
    assert "refresh_token" in _on_disk(path)

    assert probe.main(["sign-out", "--credentials", str(path), "--delete"]) == 1
    assert "The file was deleted anyway" in capsys.readouterr().err
    assert not path.exists()


def test_trials_report_what_the_route_accepted_and_refused(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    _, record = _signed_in(tmp_path, fake, client)
    call = {"type": "function_call", "name": "record_note", "namespace": "probe", "call_id": "call_1"}
    patch = {"type": "apply_patch_call", "call_id": "patch_1", "status": "completed", "operation": {"type": "x"}}

    def respond(body: dict[str, Any]) -> httpx.Response:
        if "max_output_tokens" in body:
            error = {"code": "subscription_sharing_unsupported_capability", "param": "max_output_tokens"}
            return httpx.Response(400, json={"error": error})
        kinds = {item.get("type") for item in body["input"]}
        tools = [tool["type"] for tool in body.get("tools", [])]
        if tools == ["apply_patch"] and "apply_patch_call_output" not in kinds:
            return _completed(patch)
        if tools == ["namespace"] and "function_call_output" not in kinds:
            reasoning = {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "opaque"}
            return _completed(reasoning, {**call, "arguments": '{"note": "ok"}'})
        if tools == ["web_search"]:
            return _completed({"type": "web_search_call"}, {"type": "message", "role": "assistant"})
        return _completed({"type": "message", "role": "assistant"})

    fake.on_response = respond
    available = probe.trials(client, record["access_token"], "gpt-test", probe.redactor(record))

    refused = available["rejected_field"]()[0]
    first, second = available["reasoning_replay"]()
    patched, patch_follow_up = available["apply_patch"]()
    searched = available["web_search"]()[0]
    compaction = available["context_management"]()[0]
    wrong_route = available["embeddings_route"]()[0]
    plain = available["plain"]()[0]

    assert (refused.status, refused.terminal) == (400, None)
    assert refused.error is not None and refused.error["param"] == "max_output_tokens"
    assert first.function_calls == [
        {"name": "record_note", "namespace": "probe", "has_call_id": True, "arguments": '{"note": "ok"}'}
    ]
    assert first.encrypted_reasoning is True
    assert (second.name, second.terminal, second.item_types) == (
        "reasoning_replay_follow_up",
        "response.completed",
        ["message"],
    )
    assert second.note == ""  # reasoning was replayed, so there is nothing to flag
    assert patched.item_types == ["apply_patch_call"] and patch_follow_up.terminal == "response.completed"
    assert searched.item_types == ["web_search_call", "message"]
    assert compaction.note.startswith("admission only")
    assert (wrong_route.status, wrong_route.error) == (
        403,
        {"shape": "detail", "detail": "This route is not available for ChatGPT plan usage."},
    )
    assert (plain.text, plain.usage_fields, plain.items_from) == (
        "ready",
        ["input_tokens", "output_tokens"],
        "terminal event",
    )
    assert plain.event_types == ["response.output_text.delta", "response.completed"]
    assert "output" not in plain.printable()

    bodies = fake.bodies()
    assert all(body["store"] is False and body["stream"] is True and body["model"] == "gpt-test" for body in bodies)
    replayed = bodies[2]["input"]
    assert [item.get("type") for item in replayed[1:]] == ["reasoning", "function_call", "function_call_output"]
    assert replayed[2]["namespace"] == "probe" and replayed[1]["encrypted_content"] == "opaque"
    assert bodies[1]["include"] == ["reasoning.encrypted_content"]
    # Low effort on a trivial call returned no reasoning item in the live trial, so the trial asks for more.
    assert bodies[1]["reasoning"] == {"effort": "high"} and "17 times 23" in bodies[1]["input"][0]["content"]
    assert [item.get("type") for item in bodies[4]["input"][1:]] == ["apply_patch_call", "apply_patch_call_output"]
    assert bodies[4]["input"][1]["operation"] == {"type": "x"}
    assert "Search the web" in bodies[5]["input"][0]["content"]


def test_a_reasoning_replay_that_replayed_no_reasoning_says_so(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    _, record = _signed_in(tmp_path, fake, client)
    call = {"type": "function_call", "name": "record_note", "call_id": "call_1", "arguments": "{}"}

    def respond(body: dict[str, Any]) -> httpx.Response:
        answered = any(item.get("type") == "function_call_output" for item in body["input"])
        return _completed({"type": "message", "role": "assistant"} if answered else call)

    fake.on_response = respond
    available = probe.trials(client, record["access_token"], "gpt-test", probe.redactor(record))

    first, second = available["reasoning_replay"]()

    assert first.encrypted_reasoning is False
    assert second.note == "the first response held no encrypted reasoning item, so none was replayed"


def test_the_model_list_shortens_long_text(fake: FakeOpenAI, client: httpx.Client) -> None:
    # A real item carries another product's instructions, tens of thousands of characters long.
    fake.model_extra = {"base_instructions": "x" * 5000, "model_messages": {"tools": ["y" * 300, "short"]}}

    listed = probe.list_models(client, "access-token")
    (item,) = listed["items"]

    assert item["base_instructions"] == "<5000 characters>"
    assert item["model_messages"] == {"tools": ["<300 characters>", "short"]}
    assert (item["slug"], item["context_window"]) == ("gpt-test", 1000)
    assert listed["item_fields"]["base_instructions"] == ["str"]


def test_items_delivered_only_as_stream_events_are_still_seen(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    _, record = _signed_in(tmp_path, fake, client)
    call = {"type": "function_call", "name": "record_note", "call_id": "call_1", "arguments": "{}"}
    fake.on_response = lambda body: _sse(
        {"type": "response.output_item.done", "item": call},
        {"type": "response.completed", "response": {"output": []}},
    )
    available = probe.trials(client, record["access_token"], "gpt-test", probe.redactor(record))

    first, second = available["tool_round_trip"]()

    assert first.items_from == "output_item.done events"
    assert first.item_types == ["function_call"]
    assert first.event_types == ["response.output_item.done", "response.completed"]
    assert second.name == "tool_round_trip_follow_up"

    fake.on_response = lambda body: _completed({"type": "message", "role": "assistant"})
    (silent,) = available["tool_round_trip"]()
    assert silent.note == "the model made no tool call, so nothing was replayed"


def test_a_lost_connection_or_a_skipped_trial_keeps_the_run_and_its_count_honest(
    tmp_path: Path,
    fake: FakeOpenAI,
    client: httpx.Client,
    capsys: pytest.CaptureFixture[str],
    offline: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path, _ = _signed_in(tmp_path, fake, client)
    call = {"type": "function_call", "name": "record_note", "call_id": "call_1", "arguments": "{}"}

    def respond(body: dict[str, Any]) -> httpx.Response:
        kinds = {item.get("type") for item in body["input"]}
        if body.get("prompt_cache_key") or "function_call_output" in kinds:
            raise httpx.ReadError("the connection dropped")
        if body.get("tools"):
            return _completed(call)
        return _completed({"type": "message", "role": "assistant"})

    fake.on_response = respond
    monkeypatch.setenv("OPENAI_CUSTOM_HEADERS", "X-Extra: 1")
    arguments = ["requests", "--credentials", str(path), "--model", "gpt-test"]
    chosen = ["prompt_cache_key", "tool_round_trip", "sdk_stream", "plain"]

    assert probe.main([*arguments, *[part for name in chosen for part in ("--only", name)]]) == 0

    printed = capsys.readouterr().out
    assert printed.count('"shape": "transport"') == 2 and printed.count('"error": "ReadError"') == 2
    # The first half of the round trip is still shown when its follow-up is lost.
    assert "== tool_round_trip\n" in printed and "== tool_round_trip_follow_up\n" in printed
    assert '"shape": "skipped"' in printed
    assert '"name": "plain"' in printed
    assert "== 4 requests sent" in printed

    assert probe.main([*arguments, "--only", "no-such-trial"]) == 1
    assert "Unknown trial: no-such-trial" in capsys.readouterr().err


def test_a_refused_tool_request_is_not_described_as_a_silent_model(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    _, record = _signed_in(tmp_path, fake, client)
    fake.on_response = lambda body: httpx.Response(400, json={"error": {"code": "unsupported_tool"}})
    available = probe.trials(client, record["access_token"], "gpt-test", probe.redactor(record))

    (refused,) = available["apply_patch"]()

    assert (refused.status, refused.note) == (400, "")


def test_the_sdk_trial_follows_no_redirect_and_sends_no_organization(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_ORG_ID", "org-from-the-shell")
    monkeypatch.setenv("OPENAI_PROJECT_ID", "project-from-the-shell")
    seen: list[httpx2.Request] = []

    def moved(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(302, headers={"location": "https://elsewhere.example/v1/responses"})

    result = probe.sdk_trial("access-token", "gpt-test", httpx2.MockTransport(moved))

    assert [request.url.host for request in seen] == ["api.openai.com"]
    assert result.status == 302 and result.terminal is None
    assert not {"openai-organization", "openai-project"} & {name.lower() for name in seen[0].headers}
    assert json.loads(seen[0].content)["store"] is False

    monkeypatch.setenv("OPENAI_CUSTOM_HEADERS", "X-Extra: 1")
    skipped = probe.sdk_trial("access-token", "gpt-test", httpx2.MockTransport(moved))
    assert skipped.error is not None and skipped.error["shape"] == "skipped"
    assert len(seen) == 1


def test_tokens_go_only_to_openai_and_redirects_are_not_followed(
    tmp_path: Path, fake: FakeOpenAI, client: httpx.Client
) -> None:
    path, record = _signed_in(tmp_path, fake, client)
    probe.list_models(client, probe.access_token(client, path, record))
    probe.refresh_tokens(client, path, record)
    probe.sign_out(client, path, record)

    assert {item.url.host for item in fake.requests} == {"auth.openai.com", "api.openai.com"}
    assert all(item.url.scheme == "https" for item in fake.requests)
    assert client.follow_redirects is False

    moved = probe.http_client(
        httpx.MockTransport(lambda request: httpx.Response(302, headers={"location": "https://elsewhere.example/"}))
    )
    with pytest.raises(probe.ProbeError, match="302"):
        probe.list_models(moved, "access-token")


def test_commands_fail_plainly_and_list_trials_without_a_request(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "plan.json"

    assert probe.main(["refresh", "--credentials", str(path)]) == 1
    assert capsys.readouterr().err == "error: Not signed in: run sign-in first.\n"

    assert probe.main(["requests", "--credentials", str(path), "--list"]) == 0
    listed = capsys.readouterr().out.split()
    assert {"plain", "namespace_tool", "tool_round_trip", "apply_patch", "rejected_field"} <= set(listed)
    assert not path.exists()


def test_small_helpers_keep_outside_text_and_identifiers_out() -> None:
    assert probe._safe_code("subscription_sharing_usage_limit_exceeded") == "subscription_sharing_usage_limit_exceeded"
    assert probe._safe_code("anything with spaces or <markup>") == "unrecognised"
    assert probe._error_code({"error": {"code": "a message, not a code"}}) == "unrecognised"
    assert probe._same("état", "état") and not probe._same("état", "etat")

    image = probe.red_square_png(4)
    assert image.startswith(b"\x89PNG\r\n\x1a\n")
    assert struct.unpack(">II", image[16:24]) == (4, 4)
    assert image.endswith(b"IEND\xaeB`\x82")
