"""The Memory Manager on a ChatGPT plan model, and the consent boundary for work that starts by itself (Phase 7).

The runtime tests drive the real Agents SDK through a mock HTTP transport, so
they see each request as it would leave the machine (T7, D5, D6).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import replace
from typing import Any

import httpx2
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from animama.adapters.memory_manager.openai_agents_runtime import OpenAIAgentsMemoryManagerRuntime
from animama.adapters.openai_agents import OpenAIAgentsRunOutput
from animama.adapters.repositories.sqlalchemy.memory_entry_repo import SQLAlchemyMemoryEntryRepository
from animama.adapters.repositories.sqlalchemy.memory_manager_repo import SQLAlchemyMemoryManagerRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.model_clients.credentials import builtin_chatgpt_plan_connection, static_credential_resolver
from animama.app.model_clients.limits import ModelCallLimits
from animama.app.ports.memory_manager_runtime import (
    MemoryManagerPinnedModelUnavailableError,
    MemoryManagerRuntimeConfigurationError,
)
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.domain import ModelProvider, ModelProviderCapabilities
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.domain.memory_manager import (
    MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC,
    MEMORY_MANAGER_RUN_ORIGIN_KEY,
    MEMORY_MANAGER_RUN_STATUS_ACTIVE,
    MemoryManagerApproval,
    MemoryManagerMessage,
    MemoryManagerRun,
    new_memory_manager_run_id,
)
from animama.orm import (
    ORMMemoryEntry,
    ORMMemoryEntryVersion,
    ORMMemoryManagerApproval,
    ORMMemoryManagerMessage,
    ORMMemoryManagerRun,
)
from tests.test_chatgpt_plan_client import (
    FIRST_TOKEN,
    SECOND_TOKEN,
    _completed,
    _error,
    _message,
    _Route,
    _Session,
)
from tests.test_memory_manager import _manager_credentials, _manager_model

PLAN_ROW = ModelProvider(
    id="ChatGPTPlanResponsesHTTPAgent:gpt-6-luna",
    provider_type="ChatGPTPlanResponsesHTTPAgent",
    model="gpt-6-luna",
    model_label="GPT-6 Luna",
    provider_label="ChatGPT plan",
    connection_id="chatgpt_plan",
    connection=builtin_chatgpt_plan_connection(),
    context_window_tokens=272_000,
    capabilities=ModelProviderCapabilities(supports_tools=True, supports_streaming=True),
)

# Fields the plan's route refuses; none may leave the machine.
REFUSED = (
    "previous_response_id",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "prompt",
    "prompt_cache_retention",
    "truncation",
    "temperature",
    "top_p",
    "top_logprobs",
    "user",
    "background",
    "context_management",
    "include",
)


@pytest_asyncio.fixture
async def memory_entries(async_session: Any) -> Any:
    yield MemoryEntryService(
        memory_entries=SQLAlchemyMemoryEntryRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    )
    await async_session.rollback()
    await async_session.execute(delete(ORMMemoryEntryVersion))
    await async_session.execute(delete(ORMMemoryEntry))
    await async_session.commit()


def _runtime(
    memory_entries: Any, route: _Route, session: _Session, **overrides: Any
) -> OpenAIAgentsMemoryManagerRuntime:
    return OpenAIAgentsMemoryManagerRuntime(
        user_id="owner",
        memory_entries=memory_entries,
        model_provider=PLAN_ROW,
        credential_resolver=static_credential_resolver({"OPENAI_API_KEY": "sk-never-sent"}),
        timeout_seconds=5.0,
        chatgpt_plan_session=lambda: session,
        chatgpt_plan_transport=httpx2.MockTransport(route),
        **overrides,
    )


def _run(*, automatic: bool = False) -> MemoryManagerRun:
    return MemoryManagerRun(
        id=new_memory_manager_run_id(),
        user_id="owner",
        status=MEMORY_MANAGER_RUN_STATUS_ACTIVE,
        metadata={MEMORY_MANAGER_RUN_ORIGIN_KEY: MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC} if automatic else None,
    )


def _ask(run: MemoryManagerRun, text: str = "Tidy my memories.") -> MemoryManagerMessage:
    return MemoryManagerMessage(id=f"msg-{uuid.uuid4()}", run_id=run.id, user_id="owner", role="user", content=text)


def _list_files_call() -> dict[str, Any]:
    return {
        "id": "fc_1",
        "type": "function_call",
        "call_id": "call_1",
        "name": "memory_list_files",
        "namespace": "animama",
        "arguments": "{}",
        "status": "completed",
    }


TEA_NOTE = '+---\n+description: "Drinks the person likes."\n+---\n+# Tea\n+Likes green tea.\n'


def _reasoning() -> dict[str, Any]:
    return {"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "sealed"}


async def test_a_memory_manager_run_on_the_plan_sends_only_what_the_route_takes(memory_entries: Any) -> None:
    """The request-capture test (Phase 7 step 2): streamed, unstored, tools in a namespace, items without ids."""

    route = _Route(_completed([_reasoning(), _list_files_call()]), _completed([_message("Nothing to tidy.")]))
    session = _Session()
    run = _run()

    result = await _runtime(memory_entries, route, session).run_user_message(run=run, user_message=_ask(run))

    assert result.assistant_message == "Nothing to tidy."
    # A plan response is never stored, so the run keeps no cursor.
    assert result.openai_previous_response_id is None
    assert [str(request.url) for request in route.requests] == ["https://api.openai.com/v1/responses"] * 2
    assert {request.headers["authorization"] for request in route.requests} == {f"Bearer {FIRST_TOKEN}"}
    for index in range(2):
        body = route.body(index)
        assert body["stream"] is True and body["store"] is False
        assert not set(REFUSED) & set(body), set(REFUSED) & set(body)
        # Every function tool, memory edits included, sits in one namespace; no hosted apply_patch tool.
        assert [tool["type"] for tool in body["tools"]] == ["namespace"]
        names = {tool["name"] for tool in body["tools"][0]["tools"]}
        assert {"memory_list_files", "memory_read_files", "apply_patch"} <= names
        for item in body["input"]:
            assert "id" not in item and item.get("type") != "reasoning"
    replayed = route.body(1)["input"]
    call = next(item for item in replayed if item.get("type") == "function_call")
    assert (call["call_id"], call["name"], call["namespace"]) == ("call_1", "memory_list_files", "animama")
    assert any(item.get("type") == "function_call_output" and item["call_id"] == "call_1" for item in replayed)
    # The person's own run uses interactive tokens, asked again for each request, and clears a pause.
    assert set(session.purposes) == {"interactive"} and session.successes == 2


class _EnforcingSession(_Session):
    """A session that refuses background tokens while paused, as the real one does."""

    async def access_token(self, purpose: str) -> str:
        if purpose == "background" and self.paused:
            self.purposes.append(purpose)
            raise ChatGPTPlanUnavailableError("paused")
        return await super().access_token(purpose)


async def test_a_pause_that_starts_mid_run_stops_its_next_background_request(memory_entries: Any) -> None:
    """T7: the pause applies between a run's rounds, not only when it starts (P7-R1-F1)."""

    session = _EnforcingSession()

    class _PausingRoute(_Route):
        def __call__(self, request: httpx2.Request) -> httpx2.Response:
            answer = super().__call__(request)
            # The person's own chat turn hits the limit while this round's tool runs.
            session.paused = True
            return answer

    route = _PausingRoute(_completed([_list_files_call()]), _completed([_message("Done.")]))
    run = _run(automatic=True)

    with pytest.raises(MemoryManagerRuntimeConfigurationError) as refused:
        await _runtime(memory_entries, route, session).run_user_message(run=run, user_message=_ask(run))

    assert "paused after a usage limit" in refused.value.detail
    assert len(route.requests) == 1


@pytest.mark.parametrize(
    ("status", "body", "says"),
    [
        (400, {"detail": "Unsupported tool type: custom"}, "refused the Memory Manager request: Unsupported tool type"),
        (
            403,
            {"error": {"message": "no", "code": "subscription_sharing_user_not_eligible"}},
            "does not include this use",
        ),
        (429, {"error": {"message": "slow down", "type": "rate_limit"}}, "limiting requests"),
    ],
)
async def test_a_refused_plan_request_says_why(
    memory_entries: Any, status: int, body: dict[str, Any], says: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R5.3: the run's error names the plan's reason; only a usage limit sets the pause (P7-R1-F5)."""

    import asyncio

    real_sleep = asyncio.sleep

    async def no_wait(delay: float, *args: Any, **kwargs: Any) -> Any:
        return await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", no_wait)
    route, session = _Route(*[_error(status, body) for _ in range(3)]), _Session()
    run = _run()

    with pytest.raises(MemoryManagerRuntimeConfigurationError) as failed:
        await _runtime(memory_entries, route, session).run_user_message(run=run, user_message=_ask(run))

    assert says in failed.value.detail and session.paused is False


async def test_a_memory_edit_on_the_plan_waits_for_the_person_s_approval(memory_entries: Any) -> None:
    """The function form of `apply_patch` still stops for approval, from inside the namespace."""

    patch_call = {
        "id": "fc_patch",
        "type": "function_call",
        "call_id": "call_patch",
        "name": "apply_patch",
        "namespace": "animama",
        "arguments": json.dumps({"operation": {"type": "create_file", "path": "notes/tea.md", "diff": TEA_NOTE}}),
        "status": "completed",
    }
    route, session = _Route(_completed([patch_call])), _Session()
    run = _run()

    result = await _runtime(memory_entries, route, session).run_user_message(
        run=run, user_message=_ask(run, "Remember that I like green tea.")
    )

    assert [approval.target_path for approval in result.approvals or []] == ["notes/tea.md"]
    assert result.serialized_agent_state and len(route.requests) == 1


async def test_an_approval_resumes_on_the_plan_with_the_route_s_rules(memory_entries: Any) -> None:
    """The request after a decision replays the call and its output, without ids or output limits (P7-R1-F4)."""

    patch_call = {
        "id": "fc_patch",
        "type": "function_call",
        "call_id": "call_patch",
        "name": "apply_patch",
        "namespace": "animama",
        "arguments": json.dumps({"operation": {"type": "create_file", "path": "notes/tea.md", "diff": TEA_NOTE}}),
        "status": "completed",
    }
    route = _Route(_completed([_reasoning(), patch_call]), _completed([_message("Left it out.")]))
    session = _Session()
    limits = ModelCallLimits(max_output_tokens=800, timeout_seconds=30.0)
    run = _run()
    proposed = await _runtime(memory_entries, route, session, model_limits=limits).run_user_message(
        run=run, user_message=_ask(run, "Remember that I like green tea.")
    )
    request = (proposed.approvals or [])[0]
    approval = MemoryManagerApproval(
        id="approval-1",
        run_id=run.id,
        user_id="owner",
        status="rejected",
        operation=request.operation,
        target_path=request.target_path,
        target_entry_id=None,
        expected_version=None,
        summary=None,
        old_content=None,
        new_content=None,
        old_description=None,
        new_description=None,
        unified_diff=request.unified_diff,
        operation_metadata=request.operation_metadata,
    )

    resumed = await _runtime(memory_entries, route, session, model_limits=limits).resume_approval_decision(
        run=replace(run, serialized_agent_state=proposed.serialized_agent_state),
        approval=approval,
        decision="reject",
        feedback="Not now.",
    )

    assert resumed.assistant_message == "Left it out."
    body = route.body(1)
    assert body["stream"] is True and body["store"] is False
    assert not set(REFUSED) & set(body), set(REFUSED) & set(body)
    assert all("id" not in item and item.get("type") != "reasoning" for item in body["input"])
    call = next(item for item in body["input"] if item.get("type") == "function_call")
    assert (call["call_id"], call["name"], call["namespace"]) == ("call_patch", "apply_patch", "animama")
    assert any(item.get("type") == "function_call_output" and item["call_id"] == "call_patch" for item in body["input"])


async def test_an_approval_is_refused_before_it_applies_when_the_plan_cannot_serve(memory_entries: Any) -> None:
    """A decision changes nothing while the session cannot serve the run (P7-R1-F10)."""

    route, session = _Route(), _Session()
    session.unavailable = "sign_in_required"

    with pytest.raises(MemoryManagerPinnedModelUnavailableError) as refused:
        await _runtime(memory_entries, route, session).for_run(replace(_run(), model_provider_id=PLAN_ROW.id))

    # The refusal names the plan's reason, not a missing model (P7-R2-F1).
    assert "Sign in with ChatGPT again" in refused.value.detail
    assert route.requests == []


@pytest_asyncio.fixture
async def manager_rows(async_session: Any) -> Any:
    yield
    await async_session.rollback()
    for table in (ORMMemoryManagerApproval, ORMMemoryManagerMessage, ORMMemoryManagerRun):
        await async_session.execute(delete(table))
    await async_session.commit()


class _RecordingRunner:
    """The Agents runner, replaced: records what each step would send and answers with ``response_ids``."""

    def __init__(self, response_ids: list[str | None]) -> None:
        self._response_ids = iter(response_ids)
        self.calls: list[dict[str, Any]] = []

    async def run(self, **kwargs: Any) -> OpenAIAgentsRunOutput:
        self.calls.append(dict(kwargs))
        response_id = next(self._response_ids)
        return OpenAIAgentsRunOutput(
            final_output=f"reply {len(self.calls)}",
            interruptions=[],
            serialized_agent_state=None,
            last_response_id=response_id,
            state=None,
            usage_metadata={},
            metadata={},
        )


@pytest.mark.usefixtures("manager_rows")
async def test_a_run_moving_to_the_plan_and_back_replays_what_the_plan_step_said(
    async_session: Any, memory_entries: Any
) -> None:
    """A plan step keeps no conversation, so the run drops its older key cursor (P7-R1-F2, R3.2)."""

    runner = _RecordingRunner(["resp-key-1", "resp-plan", "resp-key-2"])
    repository = SQLAlchemyMemoryManagerRepository(async_session)
    user_id = f"user-{uuid.uuid4()}"

    def service(runtime: OpenAIAgentsMemoryManagerRuntime) -> MemoryManagerService:
        runtime._runner = runner  # type: ignore[assignment]  # noqa: SLF001
        return MemoryManagerService(
            memory_manager=repository,
            memory_entries=memory_entries,
            runtime=runtime,
            uow=SQLAlchemyUnitOfWork(async_session),
        )

    def key() -> OpenAIAgentsMemoryManagerRuntime:
        return OpenAIAgentsMemoryManagerRuntime(
            user_id=user_id,
            memory_entries=memory_entries,
            model_provider=_manager_model(),
            credential_resolver=_manager_credentials(),
            timeout_seconds=1.0,
        )

    created = await service(key()).create_run(user_id=user_id)
    run_id = created.run.id
    await service(key()).append_user_message(user_id=user_id, run_id=run_id, content="First, on a key.")
    assert (await repository.get_run(user_id=user_id, run_id=run_id)).openai_previous_response_id == "resp-key-1"  # type: ignore[union-attr]

    plan = _runtime(memory_entries, _Route(), _Session())
    await service(plan).append_user_message(user_id=user_id, run_id=run_id, content="Second, on the plan.")
    assert (await repository.get_run(user_id=user_id, run_id=run_id)).openai_previous_response_id is None  # type: ignore[union-attr]

    await service(key()).append_user_message(user_id=user_id, run_id=run_id, content="Third, on a key.")

    third = runner.calls[2]
    assert third["previous_response_id"] is None
    assert "Second, on the plan." in [item["content"] for item in third["input_value"]]


@pytest.mark.usefixtures("manager_rows")
async def test_rejecting_a_change_the_plan_cannot_resume_says_why_and_stores_no_token(
    async_session: Any, memory_entries: Any
) -> None:
    """FI-R1-F7: the plan's reason, not "the model is gone"; FI-R1-F2: no token in any Memory Manager row."""

    patch_call = {
        "id": "fc_patch",
        "type": "function_call",
        "call_id": "call_patch",
        "name": "apply_patch",
        "namespace": "animama",
        "arguments": json.dumps({"operation": {"type": "create_file", "path": "notes/tea.md", "diff": TEA_NOTE}}),
        "status": "completed",
    }
    route, session = _Route(_completed([patch_call])), _Session()
    runtime = _runtime(memory_entries, route, session)
    service = MemoryManagerService(
        memory_manager=SQLAlchemyMemoryManagerRepository(async_session),
        memory_entries=memory_entries,
        runtime=runtime,
        uow=SQLAlchemyUnitOfWork(async_session),
    )
    user_id = f"user-{uuid.uuid4()}"
    created = await service.create_run(user_id=user_id)
    await service.append_user_message(user_id=user_id, run_id=created.run.id, content="Remember that I like green tea.")
    waiting = await service.get_run_snapshot(user_id=user_id, run_id=created.run.id)
    assert waiting.run.serialized_agent_state and len(waiting.approvals) == 1

    # Every Memory Manager row the plan step wrote, the paused agent state included, is free of tokens.
    for table in (ORMMemoryManagerRun, ORMMemoryManagerMessage, ORMMemoryManagerApproval):
        rows = (await async_session.execute(select(table))).scalars().all()
        dumped = repr([vars(row) for row in rows])
        assert FIRST_TOKEN not in dumped and SECOND_TOKEN not in dumped, table.__name__

    session.unavailable = "sign_in_required"
    await service.decide_approval(user_id=user_id, approval_id=waiting.approvals[0].id, decision="reject")

    ended = await service.get_run_snapshot(user_id=user_id, run_id=created.run.id)
    assert ended.run.error is not None and "Sign in with ChatGPT again" in ended.run.error
    assert len(route.requests) == 1


async def test_a_run_that_started_by_itself_asks_for_background_tokens(memory_entries: Any) -> None:
    route = _Route(_completed([_message("Processed.")]))
    session = _Session()
    run = _run(automatic=True)
    # Automatic runs are bounded; the route refuses output limits, so none is sent.
    limits = ModelCallLimits(max_output_tokens=800, timeout_seconds=30.0)

    await _runtime(memory_entries, route, session, model_limits=limits).run_user_message(
        run=run, user_message=_ask(run)
    )

    assert set(session.purposes) == {"background"}
    assert "max_output_tokens" not in route.body() and route.body()["store"] is False
    # Only the person's own request clears a usage-limit pause.
    assert session.successes == 0


@pytest.mark.parametrize(
    ("state", "says"),
    [
        ("background_not_agreed", "Allow them in App Settings"),
        ("paused", "paused after a usage limit"),
        ("sign_in_required", "Sign in with ChatGPT again"),
    ],
)
async def test_a_run_the_plan_may_not_serve_sends_nothing_and_says_why(
    memory_entries: Any, state: str, says: str
) -> None:
    route, session = _Route(), _Session()
    session.unavailable = state
    run = _run(automatic=True)

    with pytest.raises(MemoryManagerRuntimeConfigurationError) as refused:
        await _runtime(memory_entries, route, session).run_user_message(run=run, user_message=_ask(run))

    assert says in refused.value.detail and route.requests == []


async def test_a_usage_limit_pauses_background_use(memory_entries: Any) -> None:
    limit = {"error": {"message": "limit", "code": "subscription_sharing_usage_limit_exceeded"}}
    route, session = _Route(_error(429, limit)), _Session()
    run = _run()

    with pytest.raises(MemoryManagerRuntimeConfigurationError) as failed:
        await _runtime(memory_entries, route, session).run_user_message(run=run, user_message=_ask(run))

    assert "usage limit" in failed.value.detail and session.paused is True
    assert len(route.requests) == 1


async def test_a_refused_token_is_renewed_once(memory_entries: Any) -> None:
    route = _Route(_error(401, {"error": {"message": "expired"}}), _completed([_message("Done.")]))
    session = _Session()
    run = _run()

    result = await _runtime(memory_entries, route, session).run_user_message(run=run, user_message=_ask(run))

    assert result.assistant_message == "Done."
    assert [request.headers["authorization"] for request in route.requests] == [
        f"Bearer {FIRST_TOKEN}",
        f"Bearer {SECOND_TOKEN}",
    ]


async def test_the_plan_mode_traces_nothing_and_uses_the_function_form_of_memory_edits(memory_entries: Any) -> None:
    from animama.adapters.memory_manager.openai_agents_runtime import _approval_required_patch_editor
    from animama.adapters.memory_manager.workspace import MemoryManagerVirtualWorkspace

    route, session = _Route(), _Session()
    runtime = _runtime(memory_entries, route, session)
    run = _run()
    _connection, credential, client = await runtime._connect(run)  # noqa: SLF001
    try:
        agent, run_config = await runtime._build_agent(  # noqa: SLF001
            run=run,
            workspace=MemoryManagerVirtualWorkspace(user_id="owner", memory_entries=memory_entries),
            client=client,
            credential=credential,
            editor=_approval_required_patch_editor(),
        )
    finally:
        await client.close()

    assert run_config.tracing_disabled is True
    assert agent.model_settings.store is False
    assert "apply_patch" in {getattr(tool, "name", None) for tool in agent.tools}
    assert not [tool for tool in agent.tools if type(tool).__name__ == "ApplyPatchTool"]
    assert route.requests == []
