"""The ChatGPT plan session: sign-in (T2), refresh (T5), sign-out and the background rule (T7)."""

from __future__ import annotations

import asyncio
import errno
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
import pytest_asyncio

from animama.adapters.chatgpt_plan import session_store as store_module
from animama.adapters.chatgpt_plan.openai_identity import OpenAIChatGPTPlanIdentity
from animama.adapters.chatgpt_plan.session_store import FileChatGPTPlanSessionStore
from animama.app.ports.chatgpt_plan_port import TokenGrant
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.domain.chatgpt_plan import ChatGPTPlanRecord, ChatGPTPlanSignInError, ChatGPTPlanUnavailableError
from tests.chatgpt_plan_fakes import FakeOpenAIAuth

REDIRECT = "http://127.0.0.1:8123/auth/callback"
_REAL_SAVE = FileChatGPTPlanSessionStore.save


def _failing_save(self: FileChatGPTPlanSessionStore, record: ChatGPTPlanRecord) -> None:
    raise OSError(errno.ENOSPC, "disk full")


class Clock:
    def __init__(self) -> None:
        self.now = time.time()

    def __call__(self) -> float:
        return self.now


@dataclass
class Harness:
    fake: FakeOpenAIAuth
    identity: OpenAIChatGPTPlanIdentity
    directory: Path
    clock: Clock

    def service(self) -> ChatGPTPlanSessionService:
        """A fresh service over the same file, as after a restart."""

        return ChatGPTPlanSessionService(
            identity=self.identity,
            store=FileChatGPTPlanSessionStore(self.directory, key=None),
            clock=self.clock,
        )

    def store(self) -> FileChatGPTPlanSessionStore:
        return FileChatGPTPlanSessionStore(self.directory, key=None)


@pytest_asyncio.fixture
async def harness(tmp_path: Path) -> AsyncIterator[Harness]:
    fake = FakeOpenAIAuth()
    identity = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    yield Harness(fake=fake, identity=identity, directory=tmp_path / "chatgpt-plan", clock=Clock())
    await identity.aclose()


async def _sign_in(service: ChatGPTPlanSessionService, fake: FakeOpenAIAuth) -> None:
    await service.complete(fake.authorize(await service.begin(redirect_uri=REDIRECT)))


async def test_a_sign_in_completes_and_survives_a_restart(harness: Harness) -> None:
    service = harness.service()
    assert (await service.status()).state == "signed_out"

    url = await service.begin(redirect_uri=REDIRECT)
    assert (await service.status()).sign_in_pending is True
    status = await service.complete(harness.fake.authorize(url))

    assert (status.state, status.email, status.plan_use_granted) == ("signed_in", "person@example.test", True)
    assert (status.sign_in_pending, status.confirmation_due, status.background_agreed) == (False, True, False)
    restarted = await harness.service().status()
    assert (restarted.state, restarted.email) == ("signed_in", "person@example.test")
    assert await harness.service().access_token("interactive") == await service.access_token("interactive")


async def test_the_first_sign_in_registers_and_later_ones_reuse_the_issued_client(harness: Harness) -> None:
    service = harness.service()
    first = parse_qs(urlsplit(await service.begin(redirect_uri=REDIRECT)).query)
    await service.cancel()
    host_id = first["ext_agent_host_id"][0]
    assert host_id.startswith("urn:uuid:") and first["client_id"] == ["dynamic_agent_client"]

    await _sign_in(service, harness.fake)
    later = parse_qs(urlsplit(await harness.service().begin(redirect_uri=REDIRECT)).query)

    assert later["client_id"] == ["app_issued"] and later["ext_agent_host_id"] == [host_id]
    assert later["login_hint"] == ["person@example.test"]


@pytest.mark.parametrize("state", [None, "", "wrong"])
async def test_a_return_without_the_attempts_state_is_refused_and_keeps_the_attempt(
    harness: Harness, state: str | None
) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    forged = {**params, "code": "attacker-code"}
    if state is None:
        del forged["state"]
    else:
        forged["state"] = state

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(forged)

    assert refused.value.code == "state_mismatch"
    assert (await service.status()).sign_in_pending is True
    assert (await service.complete(params)).state == "signed_in"


async def test_a_return_is_used_once(harness: Harness) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    await service.complete(params)

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(params)

    assert refused.value.code == "no_pending_sign_in"


async def test_an_attempt_expires_after_ten_minutes(harness: Harness) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    harness.clock.now += 601

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(params)

    assert refused.value.code == "sign_in_expired"
    assert (await service.status()).sign_in_pending is False


async def test_a_declined_sign_in_is_reported_without_a_loop(harness: Harness) -> None:
    service = harness.service()
    url = await service.begin(redirect_uri=REDIRECT)

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(harness.fake.authorize(url, decline=True))

    status = await service.status()
    assert refused.value.code == "access_denied"
    assert (status.state, status.sign_in_pending, status.failure) == ("signed_out", False, "access_denied")
    await service.begin(redirect_uri=REDIRECT)
    assert (await service.status()).failure is None


async def test_plan_use_not_granted_is_signed_in_but_unusable_until_enabled(harness: Harness) -> None:
    harness.fake.scope = "openid profile email offline_access"
    service = harness.service()
    await _sign_in(service, harness.fake)

    status = await service.status()
    assert (status.state, status.plan_use_granted, status.confirmation_due) == ("signed_in", False, False)
    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("interactive")
    assert refused.value.code == "plan_use_not_granted"

    url = await service.begin(redirect_uri=REDIRECT, enable_plan_use=True)
    assert parse_qs(urlsplit(url).query)["prompt"] == ["consent"]
    harness.fake.scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    assert (await service.complete(harness.fake.authorize(url))).plan_use_granted is True


async def test_a_reauthorization_naming_another_client_is_refused(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete({**params, "client_id": "app_other"})

    assert refused.value.code == "client_mismatch"
    assert (await service.status()).state == "signed_in"


async def test_an_invalid_id_token_ends_the_new_session_and_keeps_the_old_account(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    before = await service.access_token("interactive")
    harness.fake.subject, harness.fake.email = "subject-2", "other@example.test"
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    real_id_token = harness.fake.id_token
    monkeypatch.setattr(harness.fake, "id_token", lambda **claims: real_id_token(**{**claims, "nonce": "forged"}))

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(params)

    assert refused.value.code == "id_token_invalid"
    assert len(harness.fake.revoked) == 1
    status = await service.status()
    assert (status.email, status.failure) == ("person@example.test", "id_token_invalid")
    assert await service.access_token("interactive") == before


async def test_another_account_replaces_the_first_only_after_validation(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    await service.set_preferences(confirmed=True, background_agreed=True)
    first_refresh = harness.store().load()
    assert first_refresh is not None and first_refresh.account is not None and first_refresh.account.tokens

    harness.fake.subject, harness.fake.email = "subject-2", "other@example.test"
    await _sign_in(service, harness.fake)

    status = await service.status()
    assert (status.email, status.confirmation_due, status.background_agreed) == ("other@example.test", True, False)
    assert harness.fake.revoked == [first_refresh.account.tokens.refresh_token]


async def test_the_same_account_signing_in_again_keeps_its_choices(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    await service.set_preferences(confirmed=True, background_agreed=True)

    await _sign_in(service, harness.fake)

    status = await service.status()
    assert (status.confirmation_due, status.background_agreed) == (False, True)
    # Revoking the replaced grant might end the new one too, so only another account's is revoked.
    assert harness.fake.revoked == []


async def test_tokens_refresh_once_inside_the_last_five_minutes_even_under_concurrency(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    first = await service.access_token("interactive")
    harness.clock.now += 3600 - 299

    tokens = await asyncio.gather(*(service.access_token("interactive") for _ in range(10)))

    assert harness.fake.refreshes == 1
    assert len(set(tokens)) == 1 and tokens[0] != first
    saved = harness.store().load()
    assert saved is not None and saved.account is not None and saved.account.tokens is not None
    assert saved.account.tokens.access_token == tokens[0]


async def test_a_refresh_waits_for_the_earliest_refresh_time_unless_the_token_expired(harness: Harness) -> None:
    await _sign_in(harness.service(), harness.fake)
    saved = harness.store().load()
    assert saved is not None and saved.account is not None and saved.account.tokens is not None
    tokens = saved.account.tokens
    # Inside the five-minute margin but before the earliest refresh time: the valid token is kept.
    late = replace(tokens, earliest_refresh_at=tokens.expires_at - 100)
    harness.store().save(replace(saved, account=replace(saved.account, tokens=late)))
    harness.clock.now = tokens.expires_at - 200
    service = harness.service()

    assert await service.access_token("interactive") == tokens.access_token
    assert harness.fake.refreshes == 0

    harness.clock.now = tokens.expires_at + 1
    assert await service.access_token("interactive") != tokens.access_token
    assert harness.fake.refreshes == 1


async def test_a_rejected_token_forces_one_refresh_even_before_the_earliest_time(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    stale = await service.access_token("interactive")

    renewed = await asyncio.gather(*(service.refresh_rejected(stale, "interactive") for _ in range(5)))

    assert harness.fake.refreshes == 1 and len(set(renewed)) == 1 and renewed[0] != stale


async def test_a_rejected_refresh_removes_the_tokens_and_asks_for_sign_in(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    harness.fake.refresh_status, harness.fake.refresh_error = 400, "invalid_grant"
    harness.clock.now += 3600

    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("interactive")

    assert refused.value.code == "sign_in_required"
    status = await harness.service().status()
    assert (status.state, status.email) == ("sign_in_required", "person@example.test")
    saved = harness.store().load()
    assert saved is not None and saved.account is not None and saved.account.tokens is None


@pytest.mark.parametrize("status_code", [429, 503])
async def test_a_temporary_refresh_failure_keeps_the_tokens(harness: Harness, status_code: int) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    harness.fake.refresh_status = status_code
    harness.clock.now += 3600

    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("interactive")

    assert refused.value.code == "temporarily_unavailable"
    assert (await service.status()).state == "signed_in"
    harness.fake.refresh_status = 200
    harness.clock.now += 31  # past the retry backoff
    assert await service.access_token("interactive")


async def test_background_use_needs_agreement_and_stops_at_a_usage_limit(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)

    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("background")
    assert refused.value.code == "background_not_agreed"

    await service.set_preferences(background_agreed=True)
    assert await service.access_token("background")

    await service.record_usage_limit()
    assert (await service.status()).paused is True
    with pytest.raises(ChatGPTPlanUnavailableError) as paused:
        await service.access_token("background")
    assert paused.value.code == "paused"
    assert await service.access_token("interactive")

    await service.record_interactive_success()
    assert (await service.status()).paused is False
    assert await service.access_token("background")


async def test_the_confirmation_is_recorded_once(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)

    status = await service.set_preferences(confirmed=True)

    assert status.confirmation_due is False
    assert (await harness.service().status()).confirmation_due is False


async def test_preferences_need_a_signed_in_account(harness: Harness) -> None:
    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await harness.service().set_preferences(confirmed=True)

    assert refused.value.code == "not_signed_in"


@pytest.mark.parametrize(("revocation_status", "confirmed"), [(200, True), (503, False)])
async def test_sign_out_revokes_and_always_removes_the_tokens(
    harness: Harness, revocation_status: int, confirmed: bool
) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    saved = harness.store().load()
    assert saved is not None and saved.account is not None and saved.account.tokens is not None
    harness.fake.revocation_status = revocation_status

    result = await service.sign_out()

    assert (result.was_signed_in, result.confirmed) == (True, confirmed)
    assert harness.fake.revoked == [saved.account.tokens.refresh_token]
    after = harness.store().load()
    assert after is not None and after.account is None
    assert (after.host_id, after.client_id) == (saved.host_id, saved.client_id)
    assert saved.account.tokens.refresh_token.encode() not in (harness.directory / "session.json").read_bytes()
    with pytest.raises(ChatGPTPlanUnavailableError):
        await service.access_token("interactive")
    assert (await service.sign_out()).was_signed_in is False


async def test_nothing_is_requested_while_signed_out(harness: Harness) -> None:
    service = harness.service()

    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("interactive")

    assert refused.value.code == "not_signed_in"
    assert harness.fake.requests == []


async def test_no_token_code_or_email_reaches_a_log_or_a_repr(
    harness: Harness, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level("DEBUG")
    service = harness.service()
    url = await service.begin(redirect_uri=REDIRECT)
    params = harness.fake.authorize(url)
    await service.complete(params)
    saved = harness.store().load()
    assert saved is not None and saved.account is not None and saved.account.tokens is not None
    secrets = [
        saved.account.tokens.access_token,
        saved.account.tokens.refresh_token,
        saved.account.tokens.id_token,
        params["code"],
        params["state"],
        "person@example.test",
    ]
    # Every failure path that logs: a rejected refresh after an unvalidated refreshed ID token.
    real_id_token = harness.fake.id_token
    monkeypatch.setattr(harness.fake, "id_token", lambda **claims: real_id_token(**{**claims, "aud": "someone_else"}))
    harness.clock.now += 3600
    await service.access_token("interactive")
    harness.fake.refresh_status = 400
    harness.clock.now += 3600
    with pytest.raises(ChatGPTPlanUnavailableError):
        await service.access_token("interactive")

    printed = caplog.text + repr(saved) + repr(await service.status())
    assert "sign-in is required" in caplog.text and "did not validate" in caplog.text
    assert all(secret not in printed for secret in secrets[:5])
    assert "person@example.test" not in caplog.text + repr(saved)


class _SlowFirstLoad(FileChatGPTPlanSessionStore):
    """A store whose first read finishes only when the test says so."""

    def __init__(self, directory: Path) -> None:
        super().__init__(directory, key=None)
        self.release = threading.Event()
        self.calls = 0

    def load(self) -> ChatGPTPlanRecord | None:
        self.calls += 1
        record = super().load()
        if self.calls == 1:
            self.release.wait(5)
        return record


async def test_a_late_first_read_never_replaces_newer_tokens(harness: Harness) -> None:
    await _sign_in(harness.service(), harness.fake)
    store = _SlowFirstLoad(harness.directory)
    service = ChatGPTPlanSessionService(identity=harness.identity, store=store, clock=harness.clock)
    harness.clock.now += 3600

    slow_status = asyncio.create_task(service.status())
    await asyncio.sleep(0.05)
    renewed = await service.access_token("interactive")
    store.release.set()
    await slow_status

    assert await service.access_token("interactive") == renewed
    assert harness.fake.refreshes == 1


async def test_an_unreadable_session_file_is_kept_and_retried(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _sign_in(harness.service(), harness.fake)
    service = harness.service()

    def busy(path: object, flags: int, mode: int = 0o777) -> int:
        raise OSError(errno.EMFILE, "Too many open files")

    monkeypatch.setattr(store_module, "open_no_follow", busy)
    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("interactive")
    assert refused.value.code == "temporarily_unavailable"
    assert (harness.directory / "session.json").exists()

    monkeypatch.undo()
    assert await service.access_token("interactive")


async def test_a_failing_refresh_inside_the_margin_keeps_the_valid_token_and_backs_off(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    current = await service.access_token("interactive")
    harness.fake.refresh_status = 503
    harness.clock.now += 3600 - 200

    tokens = await asyncio.gather(*(service.access_token("interactive") for _ in range(10)))

    assert tokens == [current] * 10 and harness.fake.refreshes == 1
    harness.clock.now += 10
    assert await service.access_token("interactive") == current and harness.fake.refreshes == 1
    harness.fake.refresh_status = 200
    harness.clock.now += 30
    assert await service.access_token("interactive") != current and harness.fake.refreshes == 2


async def test_a_failing_refresh_after_expiry_is_tried_once_for_all_waiters(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    harness.fake.refresh_status = 503
    harness.clock.now += 3601

    results = await asyncio.gather(*(service.access_token("interactive") for _ in range(10)), return_exceptions=True)

    assert all(isinstance(result, ChatGPTPlanUnavailableError) for result in results)
    assert {result.code for result in results if isinstance(result, ChatGPTPlanUnavailableError)} == {
        "temporarily_unavailable"
    }
    assert harness.fake.refreshes == 1


async def test_an_unsaved_token_set_is_never_handed_out(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    harness.clock.now += 3600
    issued: list[str] = []
    real_refresh = harness.identity.refresh

    async def remember(**fields: str) -> TokenGrant:
        grant = await real_refresh(**fields)
        issued.append(grant.access_token)
        return grant

    monkeypatch.setattr(harness.identity, "refresh", remember)
    monkeypatch.setattr(FileChatGPTPlanSessionStore, "save", _failing_save)
    with pytest.raises(ChatGPTPlanUnavailableError):
        await service.access_token("interactive")
    monkeypatch.setattr(FileChatGPTPlanSessionStore, "save", _REAL_SAVE)

    # OpenAI already rotated the refresh token, so the saved one is refused; the unsaved set is never used.
    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("interactive")
    assert refused.value.code == "sign_in_required"
    assert issued and issued[0].encode() not in (harness.directory / "session.json").read_bytes()


async def test_a_registration_without_an_issued_client_id_is_refused(harness: Harness) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    del params["client_id"]

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(params)

    assert refused.value.code == "sign_in_refused"


async def test_a_sign_in_whose_save_fails_ends_the_new_session(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    monkeypatch.setattr(FileChatGPTPlanSessionStore, "save", _failing_save)

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete(params)

    assert refused.value.code == "temporarily_unavailable"
    assert len(harness.fake.revoked) == 1


async def test_sign_out_also_ends_a_pending_sign_in(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))

    await service.sign_out()

    assert (await service.status()).sign_in_pending is False
    with pytest.raises(ChatGPTPlanSignInError):
        await service.complete(params)


async def test_a_refreshed_id_token_for_another_subject_is_not_kept(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    before = harness.store().load()
    assert before is not None and before.account is not None and before.account.tokens is not None
    real_id_token = harness.fake.id_token
    monkeypatch.setattr(harness.fake, "id_token", lambda **claims: real_id_token(**{**claims, "sub": "someone-else"}))
    harness.clock.now += 3600

    await service.access_token("interactive")

    after = harness.store().load()
    assert after is not None and after.account is not None and after.account.tokens is not None
    assert after.account.tokens.id_token == before.account.tokens.id_token
    assert after.account.tokens.access_token != before.account.tokens.access_token


async def test_a_sign_in_stays_pending_while_it_completes(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    gate = asyncio.Event()
    real_exchange = harness.identity.exchange_code

    async def slow_exchange(**fields: str) -> TokenGrant:
        await gate.wait()
        return await real_exchange(**fields)

    monkeypatch.setattr(harness.identity, "exchange_code", slow_exchange)
    completing = asyncio.create_task(service.complete(params))
    await asyncio.sleep(0.01)

    assert (await service.status()).sign_in_pending is True
    gate.set()
    assert (await completing).sign_in_pending is False


async def test_a_sign_in_stays_pending_until_its_follow_up_finishes(harness: Harness) -> None:
    """The return stores the account's models before the sign-in reads as done (R3.1 at sign-in)."""

    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    seen: list[tuple[str, bool]] = []

    async def follow_up() -> None:
        status = await service.status()
        seen.append((status.state, status.sign_in_pending))
        # The follow-up can use the new session: it lists models with its token.
        assert await service.access_token("interactive")

    finished = await service.complete(params, after_sign_in=follow_up)

    assert seen == [("signed_in", True)]
    assert (finished.state, finished.sign_in_pending) == ("signed_in", False)


async def test_a_failed_follow_up_still_finishes_the_sign_in(harness: Harness) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))

    async def follow_up() -> None:
        raise RuntimeError("listing failed")

    with pytest.raises(RuntimeError):
        await service.complete(params, after_sign_in=follow_up)

    status = await service.status()
    assert (status.state, status.sign_in_pending) == ("signed_in", False)


async def test_a_refused_return_runs_no_follow_up(harness: Harness) -> None:
    service = harness.service()
    await service.begin(redirect_uri=REDIRECT)
    ran: list[bool] = []

    async def follow_up() -> None:
        ran.append(True)

    with pytest.raises(ChatGPTPlanSignInError):
        await service.complete({"state": "forged", "code": "x"}, after_sign_in=follow_up)

    assert ran == []


async def test_an_unknown_purpose_is_treated_as_background(harness: Harness) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)

    with pytest.raises(ChatGPTPlanUnavailableError) as refused:
        await service.access_token("unexpected")  # type: ignore[arg-type]

    assert refused.value.code == "background_not_agreed"


@pytest.mark.parametrize("error", ["invalid_client", "unauthorized_client"])
async def test_a_registration_openai_no_longer_accepts_is_dropped(harness: Harness, error: str) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    harness.fake.refresh_status, harness.fake.refresh_error = 401, error
    harness.clock.now += 3600

    with pytest.raises(ChatGPTPlanUnavailableError):
        await service.access_token("interactive")

    query = parse_qs(urlsplit(await service.begin(redirect_uri=REDIRECT)).query)
    assert query["client_id"] == ["dynamic_agent_client"]


async def test_a_rejected_session_is_never_used_even_when_clearing_it_fails(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = harness.service()
    await _sign_in(service, harness.fake)
    harness.fake.refresh_status, harness.fake.refresh_error = 400, "invalid_grant"
    harness.clock.now += 3600 - 200  # still valid, inside the refresh margin
    monkeypatch.setattr(FileChatGPTPlanSessionStore, "save", _failing_save)

    with pytest.raises(ChatGPTPlanUnavailableError):
        await service.access_token("interactive")


async def test_a_return_naming_another_issuer_is_refused_before_any_exchange(harness: Harness) -> None:
    service = harness.service()
    params = harness.fake.authorize(await service.begin(redirect_uri=REDIRECT))
    before = len(harness.fake.requests)

    with pytest.raises(ChatGPTPlanSignInError) as refused:
        await service.complete({**params, "iss": "https://auth.example.test"})

    assert refused.value.code == "sign_in_refused"
    assert len(harness.fake.requests) == before
