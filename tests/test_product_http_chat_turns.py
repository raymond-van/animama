"""The shared chat route under a composition's chat-turn guard, and between owners (ADR 0021).

The route runs over deferred-commit ports with a recording guard and a scripted
model. Admission follows the owner and runtime checks and precedes every write and
model call; a stop ends the turn at the next check; and every admitted turn
settles exactly once, after its tasks stopped, with how it ended.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, AsyncIterator, MutableMapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.app.chat import DirectChatTurnExecutor, PreparedDirectChatTurn
from animama.app.contracts.gemini import DEFAULT_GEMINI_VOICE
from animama.app.model_clients import ModelClientProviderError, StaticModelClientRegistry
from animama.app.services.chat_title_generation_service import ChatTitleGenerationSettings
from animama.app.services.model_role_resolver import ModelRoleDefaults
from animama.domain.chat import MessageRole
from animama.domain.events import Event, EventType, RunStatusPayload
from animama.orm import ORMAnima, ORMChat, ORMChatMessage
from animama.product_http.chat.sse_runtime import DirectChatEventBridge, run_prepared_direct_turn
from animama.product_http.chat.tts import anima_elevenlabs_voice
from animama.product_http.ports import ChatTurnStop, ProductRefusal
from animama.product_http.routes import chat_turns
from tests.chat_turn_support import CHAT_ROW, ScriptedModel, remove_chat_owner, seed_chat_owner, structured
from tests.product_http_support import (
    OWNER_HEADER,
    TEST_CHAT_POLICY,
    DeferredCommitFailed,
    DeferredCommitPorts,
    FakeGeminiSpeech,
    TwoOwnerComposition,
    product_app,
)

STOP = ChatTurnStop(code="credits_exhausted", message="Your credits ran out.")
# Gemini is the only voice pushed in the reply's stream (``tts.audio`` / ``tts.error``).
GEMINI_SPEECH = {"tts": {"enabled": True, "provider": "gemini", "model_id": "gemini-3.8-flash-tts"}}


def frames(stream: str) -> list[tuple[str, dict[str, Any]]]:
    """Each SSE frame's event name and data."""

    parsed = []
    for frame in stream.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in frame.splitlines() if ": " in line)
        if "event" in lines:
            parsed.append((lines["event"], json.loads(lines["data"])))
    return parsed


@dataclass
class GuardedChat:
    """Two owners with one Anima each, served by the shared chat route over guarded ports."""

    factory: async_sessionmaker[AsyncSession]
    ports: DeferredCommitPorts
    composition: TwoOwnerComposition
    model: ScriptedModel
    animas: dict[str, str]
    revisions: dict[str, str]
    suffix: str

    @property
    def owner(self) -> str:
        return self.composition.owners[0]

    @property
    def other(self) -> str:
        return self.composition.owners[1]

    def chat_id(self, run: str) -> str:
        return f"chat-{run}-{self.suffix}"

    async def turn(
        self,
        run: str,
        *,
        owner: str | None = None,
        anima_id: str | None = None,
        chat_id: str | None = None,
        revision: str | None = None,
        **values: Any,
    ) -> httpx.Response:
        owner = owner or self.owner
        body = {
            "message": "Good morning!",
            "run_id": f"run-{run}",
            "chat_id": chat_id or self.chat_id(run),
            "runtime_revision": revision or self.revisions[owner],
            **values,
        }
        async with self.composition.client(owner) as client:
            return await client.post(f"/v1/animas/{anima_id or self.animas[owner]}/chat:sse", json=body)

    async def chat(self, run: str) -> ORMChat | None:
        async with self.factory() as session:
            return await session.get(ORMChat, self.chat_id(run))

    async def replies(self, run: str) -> int:
        """How many assistant replies the chat holds."""

        async with self.factory() as session:
            count = await session.scalar(
                select(func.count())
                .select_from(ORMChatMessage)
                .where(ORMChatMessage.chat_id == self.chat_id(run), ORMChatMessage.role == MessageRole.ASSISTANT.value)
            )
        return int(count or 0)


@pytest.fixture
async def guarded(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> AsyncIterator[GuardedChat]:
    suffix = uuid4().hex[:8]
    owners = (f"guard-a-{suffix}", f"guard-b-{suffix}")
    model = ScriptedModel()
    ports = DeferredCommitPorts(
        async_session_factory,
        model_clients=StaticModelClientRegistry({"OpenAIResponsesHTTPAgent": model}),
        model_role_defaults=ModelRoleDefaults(chat=CHAT_ROW, utility=CHAT_ROW),
        # A first turn's title shows which optional work a stop after the reply skips.
        chat_policy=replace(TEST_CHAT_POLICY, title_generation=ChatTitleGenerationSettings(enabled=True)),
    )
    composition = TwoOwnerComposition(product_app(chat_turns.router, ports=ports), tmp_path, owners=owners)
    animas = {owner: f"guard-anima-{index}-{suffix}" for index, owner in enumerate(owners)}
    revisions = {owner: f"tr1-guard-{index}-{suffix}" for index, owner in enumerate(owners)}
    for owner in owners:
        await seed_chat_owner(async_session_factory, owner=owner, anima_id=animas[owner], revision=revisions[owner])
    try:
        yield GuardedChat(async_session_factory, ports, composition, model, animas, revisions, suffix)
    finally:
        for owner in owners:
            await remove_chat_owner(async_session_factory, owner=owner, anima_id=animas[owner])


async def test_a_refused_turn_writes_nothing_and_reaches_no_model(guarded: GuardedChat) -> None:
    guarded.ports.chat_guard.refusal = ProductRefusal(402, "credits_exhausted")

    response = await guarded.turn("refused")

    assert response.status_code == 402
    assert response.json() == {"detail": {"code": "credits_exhausted"}}
    assert guarded.ports.chat_guard.leases == []
    assert guarded.model.requests == []
    assert await guarded.chat("refused") is None
    assert guarded.ports.commits_requested == 0


async def test_an_admitted_turn_settles_once_as_completed(guarded: GuardedChat) -> None:
    guarded.model.replies.append(structured("Good morning! Shall we have tea?"))

    response = await guarded.turn("completed")

    assert response.status_code == 200
    [lease] = guarded.ports.chat_guard.leases
    assert lease.owner == guarded.owner
    assert lease.admission.anima_id == guarded.animas[guarded.owner]
    assert (lease.admission.chat_id, lease.admission.run_id) == (guarded.chat_id("completed"), "run-completed")
    assert lease.admission.request.message == "Good morning!"
    assert lease.settlements == ["completed"]
    assert lease.checks > 0
    names = [name for name, _data in frames(response.text)]
    assert "error" not in names
    assert names[-2:] == ["chat.title.updated", "run.completed"]
    # The setup session's new chat and the stream's own writes were committed by the composition.
    chat = await guarded.chat("completed")
    assert chat is not None and chat.user_id == guarded.owner and chat.title == "Morning Tea"
    assert await guarded.replies("completed") == 1
    assert set(guarded.ports.owners) == {guarded.owner}


async def test_a_stop_while_the_model_streams_ends_the_turn_unsaved(guarded: GuardedChat) -> None:
    guarded.model.hold = asyncio.Event()
    guarded.model.replies.append(structured("First sentence. Second sentence."))

    async def once_streaming() -> ChatTurnStop | None:
        return STOP if guarded.model.holding.is_set() else None

    guarded.ports.chat_guard.stop = once_streaming

    response = await guarded.turn("stopped")

    assert response.status_code == 200
    parsed = frames(response.text)
    assert ("error", {"run_id": "run-stopped", "error": STOP.message, "code": STOP.code}) in parsed
    assert parsed[-1][0] == "run.completed"
    assert guarded.model.cancelled
    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["interrupted"]
    assert lease.running_at_settlement == []
    assert await guarded.replies("stopped") == 0


async def test_a_stop_after_the_reply_is_saved_keeps_it_and_skips_the_rest(guarded: GuardedChat) -> None:
    guarded.model.replies.append(structured("Good morning! Shall we have tea?"))

    async def once_saved() -> ChatTurnStop | None:
        return STOP if await guarded.replies("saved") else None

    guarded.ports.chat_guard.stop = once_saved

    response = await guarded.turn("saved")

    assert response.status_code == 200
    names = [name for name, _data in frames(response.text)]
    assert "error" not in names
    assert "chat.title.updated" not in names
    assert names[-1] == "run.completed"
    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["completed"]
    assert lease.running_at_settlement == []
    assert await guarded.replies("saved") == 1
    chat = await guarded.chat("saved")
    assert chat is not None and chat.title is None


async def test_a_stop_while_the_reply_saves_keeps_the_reply_and_its_frames(
    guarded: GuardedChat, monkeypatch: pytest.MonkeyPatch
) -> None:
    guarded.model.replies.append(structured("Good morning! Shall we have tea?"))
    original = guarded.ports.write_session

    @asynccontextmanager
    async def slow_save(principal: Any) -> AsyncIterator[Any]:
        # The reply save takes long enough for a check to land while it runs.
        current = asyncio.current_task()
        if current is not None and current.get_name() == "direct-chat-save":
            await asyncio.sleep(0.3)
        async with original(principal) as session:
            yield session

    async def while_saving() -> ChatTurnStop | None:
        saving = any(task.get_name() == "direct-chat-save" and not task.done() for task in asyncio.all_tasks())
        return STOP if saving else None

    monkeypatch.setattr(guarded.ports, "write_session", slow_save)
    guarded.ports.chat_guard.stop = while_saving

    response = await guarded.turn("while-saving")

    parsed = frames(response.text)
    names = [name for name, _data in parsed]
    # The save finished, its reply reached the client, and the stop skipped the title.
    assert "error" not in names and "chat.title.updated" not in names
    speech = "".join(str(data.get("text", "")) for name, data in parsed if name == "user.response")
    assert "Shall we have tea?" in speech
    assert names[-1] == "run.completed"
    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["completed"]
    assert lease.running_at_settlement == []
    assert await guarded.replies("while-saving") == 1


async def test_a_provider_failure_settles_failed_with_public_error_text(guarded: GuardedChat) -> None:
    guarded.model.replies.append(ModelClientProviderError("upstream said: key sk-live-123 rejected", code="bad key!"))

    response = await guarded.turn("failed")

    parsed = frames(response.text)
    errors = [data for name, data in parsed if name == "error"]
    # The policy's public text replaces provider detail, and an unsafe code becomes turn_failed.
    assert errors == [{"run_id": "run-failed", "error": TEST_CHAT_POLICY.public_error_text, "code": "turn_failed"}]
    assert "sk-live" not in response.text
    assert parsed[-1][0] == "run.completed"
    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["failed"]


async def test_a_failed_setup_commit_still_settles_the_turn(guarded: GuardedChat) -> None:
    # The composition's commit of the setup session (the new chat) fails after the
    # handler returned its response, so that response never runs.
    guarded.ports.fail_next_commit = True

    with pytest.raises(DeferredCommitFailed):
        await guarded.turn("commit-failed")

    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["unstarted"]
    assert guarded.model.requests == []
    assert await guarded.chat("commit-failed") is None


async def test_a_finished_incognito_turn_settles_completed(guarded: GuardedChat) -> None:
    guarded.model.replies.append(structured("Good morning!"))

    response = await guarded.turn("incognito", dispatch_options={"incognito": True})

    assert [name for name, _data in frames(response.text)][-1] == "run.completed"
    [lease] = guarded.ports.chat_guard.leases
    # Nothing is recorded, yet the finished turn completes.
    assert lease.settlements == ["completed"]
    assert await guarded.replies("incognito") == 0


async def test_setup_failure_after_admission_settles_unstarted_and_rolls_back(guarded: GuardedChat) -> None:
    guarded.ports.model_clients = None

    response = await guarded.turn("unavailable")

    assert response.status_code == 503
    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["unstarted"]
    assert guarded.model.requests == []
    assert await guarded.chat("unavailable") is None
    assert guarded.ports.commits == 0


async def test_a_disconnect_stops_the_turn_and_settles_once(guarded: GuardedChat) -> None:
    guarded.model.hold = asyncio.Event()
    guarded.model.replies.append(structured("First sentence. Second sentence."))
    disconnected = asyncio.Event()
    sent = False
    body = {
        "message": "Good morning!",
        "run_id": "run-gone",
        "chat_id": guarded.chat_id("gone"),
        "runtime_revision": guarded.revisions[guarded.owner],
    }

    async def receive() -> dict[str, Any]:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": json.dumps(body).encode(), "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        # Leave once the model is streaming.
        if message["type"] == "http.response.body" and guarded.model.holding.is_set():
            disconnected.set()

    path = f"/v1/animas/{guarded.animas[guarded.owner]}/chat:sse"
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"test"),
            (b"content-type", b"application/json"),
            (OWNER_HEADER.lower().encode(), guarded.owner.encode()),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("test", 80),
    }
    await asyncio.wait_for(guarded.composition.app(scope, receive, send), timeout=10)

    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["interrupted"]
    assert guarded.model.cancelled
    # The lease settled only after every turn task had stopped.
    assert lease.running_at_settlement == []
    assert await guarded.replies("gone") == 0


async def test_an_owner_never_chats_with_another_owners_anima_chat_or_revision(guarded: GuardedChat) -> None:
    guarded.model.replies.append(structured("Good morning!"))
    assert (await guarded.turn("owned")).status_code == 200
    owned = await guarded.chat("owned")
    assert owned is not None

    # The other owner cannot use the first owner's Anima, even with its revision.
    response = await guarded.turn(
        "foreign-anima",
        owner=guarded.other,
        anima_id=guarded.animas[guarded.owner],
        revision=guarded.revisions[guarded.owner],
    )
    assert (response.status_code, response.json()) == (404, {"detail": "Anima not found"})
    # Nor the first owner's mounted revision on its own Anima.
    response = await guarded.turn("foreign-revision", owner=guarded.other, revision=guarded.revisions[guarded.owner])
    assert (response.status_code, response.json()) == (409, {"detail": {"code": "runtime_remount_required"}})
    # Nor continue the first owner's chat from its own Anima.
    response = await guarded.turn("foreign-chat", owner=guarded.other, chat_id=guarded.chat_id("owned"))
    assert (response.status_code, response.json()) == (404, {"detail": "Chat not found"})

    # Only the last request reached admission; its setup failed, so it settled unstarted.
    assert [(lease.owner, lease.settlements) for lease in guarded.ports.chat_guard.leases] == [
        (guarded.owner, ["completed"]),
        (guarded.other, ["unstarted"]),
    ]
    assert len(guarded.model.requests) == 2  # the first owner's reply and its title
    after = await guarded.chat("owned")
    assert after is not None and (after.user_id, after.next_turn) == (guarded.owner, owned.next_turn)


async def test_an_anima_without_an_owner_is_not_found(guarded: GuardedChat) -> None:
    unowned = f"guard-unowned-{guarded.suffix}"
    async with guarded.factory() as session:
        session.add(ORMAnima(id=unowned, user_id=None))
        await session.commit()
    try:
        response = await guarded.turn("unowned", anima_id=unowned)
    finally:
        async with guarded.factory() as session:
            await session.execute(delete(ORMAnima).where(ORMAnima.id == unowned))
            await session.commit()

    assert (response.status_code, response.json()) == (404, {"detail": "Anima not found"})
    assert guarded.ports.chat_guard.leases == []


async def test_speech_resolves_only_the_callers_anima_voice(guarded: GuardedChat) -> None:
    guarded.model.replies.append(structured("Hello there. The kettle is on."))
    realtime = {"tts": {"enabled": True, "provider": "elevenlabs", "model_id": "eleven_v4_turbo"}}

    response = await guarded.turn("speech", dispatch_options=realtime)

    assert "tts.session" in [name for name, _data in frames(response.text)]
    assert ("realtime_session", guarded.owner, "voice-mika") in guarded.ports.speech.calls
    unowned = f"guard-voice-unowned-{guarded.suffix}"
    async with guarded.factory() as session:
        session.add(ORMAnima(id=unowned, user_id=None))
        await session.flush()
        repositories = SQLAlchemyProductRepositories(session)
        # Another owner's Anima, or one without an owner, has no voice for the caller.
        for user_id, anima_id in ((guarded.other, guarded.animas[guarded.owner]), (guarded.owner, unowned)):
            with pytest.raises(HTTPException) as raised:
                await anima_elevenlabs_voice(repositories, user_id=user_id, anima_id=anima_id)
            assert raised.value.status_code == 404
        await session.rollback()


async def test_a_speech_refusal_keeps_its_code_in_the_speech_frames(guarded: GuardedChat) -> None:
    refusal = ProductRefusal(402, "speech_allowance_exhausted")
    # ElevenLabs speaks in realtime; Gemini audio is pushed in the reply's stream.
    guarded.ports.speech.refusal = refusal
    guarded.ports.gemini_speech = FakeGeminiSpeech(refusal=refusal)
    guarded.model.replies.extend(
        [structured("Hello there. The kettle is on."), structured("Hello again. The tea is ready.")]
    )

    realtime = await guarded.turn(
        "declined-realtime",
        dispatch_options={"tts": {"enabled": True, "provider": "elevenlabs", "model_id": "eleven_v4_turbo"}},
    )
    finalized = await guarded.turn("declined-finalized", dispatch_options=GEMINI_SPEECH)

    sessions = [data for name, data in frames(realtime.text) if name == "tts.session.error"]
    assert [(data["code"], data["status_code"]) for data in sessions] == [("speech_allowance_exhausted", 402)]
    speech = [data for name, data in frames(finalized.text) if name == "tts.error"]
    assert [(data["provider"], data["code"]) for data in speech] == [("gemini", "speech_allowance_exhausted")]
    # Declined speech leaves the turns themselves complete.
    assert [lease.settlements for lease in guarded.ports.chat_guard.leases] == [["completed"], ["completed"]]


async def test_cancelling_a_turn_stopped_by_a_full_bridge_stops_its_provider_stream() -> None:
    # A client that stops reading fills the bridge; the turn's task then waits to publish.
    produced: list[int] = []
    provider_cancelled: list[bool] = []

    class _Executor(DirectChatTurnExecutor):
        """The real ``stream_prepared_turn`` over stand-ins for the two streams it delegates to."""

        async def _fit_to_context_window(
            self, prepared: PreparedDirectChatTurn
        ) -> AsyncGenerator[Event | PreparedDirectChatTurn, None]:
            yield prepared

        async def _stream_fitted_turn(self, prepared: PreparedDirectChatTurn) -> AsyncGenerator[Event, None]:
            # As in the real turn, a provider task feeds the stream and its cleanup cancels it.
            provider = asyncio.create_task(asyncio.Event().wait(), name="direct-chat-model-stream-run-1")
            try:
                index = 0
                while True:
                    index += 1
                    produced.append(index)
                    yield Event(
                        event_id=f"status-{index}",
                        anima_id="anima-1",
                        type=EventType.RUN_STATUS,
                        payload=RunStatusPayload(run_id="run-1", status="searching_web", phase="started"),
                    )
            finally:
                provider.cancel()
                with suppress(asyncio.CancelledError):
                    await provider
                provider_cancelled.append(provider.cancelled())

    provider_row = SimpleNamespace(id="row", provider_type="OpenAIResponsesHTTPAgent", model="model")
    prepared = SimpleNamespace(
        request=SimpleNamespace(anima_id="anima-1", chat_id="chat-1", run_id="run-1"),
        model_request=SimpleNamespace(model_provider=provider_row),
    )
    bridge = DirectChatEventBridge(anima_id="anima-1", queue_size=2)
    executor = _Executor.__new__(_Executor)  # its collaborators are not needed here
    task = asyncio.create_task(run_prepared_direct_turn(executor, cast(Any, prepared), bridge))
    # Two events fill the bridge; the task then waits to publish the third.
    while len(produced) < 3:
        await asyncio.sleep(0)
    await asyncio.sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # The provider stream stopped before the turn's task ended, not when its generator is collected.
    assert provider_cancelled == [True]
    assert not [t for t in asyncio.all_tasks() if not t.done() and t.get_name().startswith("direct-chat-model-stream")]


async def test_a_refusal_while_streaming_speech_keeps_its_code(guarded: GuardedChat) -> None:
    gemini = FakeGeminiSpeech(stream_refusal=ProductRefusal(402, "speech_allowance_exhausted"))
    guarded.ports.gemini_speech = gemini
    guarded.model.replies.append(structured("Hello there. The kettle is on."))

    response = await guarded.turn("declined-stream", dispatch_options=GEMINI_SPEECH)

    speech = [data for name, data in frames(response.text) if name == "tts.error"]
    assert [(data["provider"], data["code"]) for data in speech] == [("gemini", "speech_allowance_exhausted")]
    # The first segment was prepared for the caller, with the voice the turn resolved (the default here).
    assert gemini.calls == [("prepare_finalized", guarded.owner, DEFAULT_GEMINI_VOICE)]
    [lease] = guarded.ports.chat_guard.leases
    assert lease.settlements == ["completed"]
