"""Live OpenAI Agents SDK runtime for the memory manager."""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Mapping, Sequence
from copy import copy
from hashlib import sha256
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Literal, cast

import httpx2
from openai import APIStatusError, AsyncOpenAI
from openai.types.shared import Reasoning, ReasoningEffort
from pydantic import BaseModel, ConfigDict

from animama.adapters.model_clients.openai_chat_completions.connection_sdk import (
    connection_base_url,
    connection_timeout,
    keyless_request_headers,
    sdk_client_for_connection,
)
from animama.adapters.model_clients.openai_chat_completions.request import function_tools_for_connection
from animama.adapters.model_clients.openai_chat_completions.support import resolve_openai_base_url
from animama.adapters.model_clients.openai_errors import classify_openai_exception
from animama.adapters.model_clients.openai_responses.chatgpt_plan_client import plan_error_code, plan_sdk_client
from animama.adapters.openai_agents import OpenAIAgentsRunner, OpenAIAgentsRunOutput
from animama.app.chat.api_standard import (
    ANTHROPIC_MESSAGES_PROVIDER_TYPE,
    CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE,
    OPENAI_RESPONSES_PROVIDER_TYPE,
)
from animama.app.chat.conversation_language import MEMORY_LANGUAGE_RULE
from animama.app.chat.memory_tools import (
    MEMORY_SEARCH_FILES_DESCRIPTION,
    MEMORY_TOOL_LIST_FILES,
    MEMORY_TOOL_READ_FILES,
    MEMORY_TOOL_SEARCH_MEMORY_FILES,
)
from animama.app.model_catalog import chat_completions_function_tool_effort
from animama.app.model_clients import ModelClientProviderError
from animama.app.model_clients.credentials import (
    ModelCredential,
    ModelCredentialResolver,
    connection_for_model_provider,
)
from animama.app.model_clients.limits import ModelCallLimits
from animama.app.ports.anima_port import AnimaRepository
from animama.app.ports.chat_message_port import ChatMessageRepository
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanTokenSource
from animama.app.ports.memory_episode_port import MemoryEpisodeRepository
from animama.app.ports.memory_manager_runtime import (
    MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED,
    MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL,
    MemoryManagerPinnedModelUnavailableError,
    MemoryManagerPreviousResponseUnresolvableError,
    MemoryManagerRuntimeApprovalRequest,
    MemoryManagerRuntimeConfigurationError,
    MemoryManagerRuntimeResult,
)
from animama.app.ports.model_provider_port import ModelProviderRepository
from animama.app.safety.prompts import SENSITIVE_MEMORY_RULE
from animama.app.services.anima_identity_memory import ManagerFileAccess, manager_file_access_for_run
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.model_role_resolver import ROLE_MEMORY_MANAGER, usable_for_role
from animama.app.services.user_memory_read_tools import UserMemoryReadToolService
from animama.domain import ModelProvider
from animama.domain.chatgpt_plan import ChatGPTPlanPurpose, ChatGPTPlanUnavailableError
from animama.domain.memory_manager import (
    MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING,
    MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
    MemoryManagerApproval,
    MemoryManagerEpisodeTaskState,
    MemoryManagerMessage,
    MemoryManagerReflectionTaskState,
    MemoryManagerRun,
    memory_manager_run_is_automatic,
)
from animama.domain.model_connection import ModelConnection, ModelConnectionCompatibility
from animama.logging import get_logger

from .chatgpt_plan_agents import (
    PLAN_TOOL_NAMESPACE,
    PLAN_TOOL_NAMESPACE_DESCRIPTION,
    ChatGPTPlanAgentsClient,
    ChatGPTPlanResponseFailedError,
    as_openai_client,
)
from .episode_processing import load_episode_processing_batch, render_episode_processing_instructions
from .reflection import (
    MEMORY_TOOL_READ_REFLECTION_TURNS,
    ReflectionTurnReader,
    reflection_task_or_none,
    render_reflection_instructions,
)
from .runtime_support import blocked_result, max_turns_for_run, rejection_message
from .workspace import MemoryManagerPatchRejected, MemoryManagerVirtualWorkspace

if TYPE_CHECKING:
    from agents import Agent, RunConfig
    from agents.editor import ApplyPatchEditor

_MAX_INVALID_PATCH_RESUMES = 2
_TRACE_WORKFLOW_NAME = "Animama memory manager"
_PATCH_TOOL_NAME = "apply_patch"
_HISTORY_ROLES = frozenset({"user", "assistant"})


class _PatchOperation(BaseModel):
    """One memory file change for the function-tool form of ``apply_patch``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["create_file", "update_file"]
    path: str
    diff: str


class _ConnectionFunctionTools:
    """SDK client view that shapes Chat Completions function tools for the connection.

    The Agents SDK builds its own tool definitions: always ``strict``, and with
    an empty ``required`` list on a zero-argument tool. This view gives them the
    form the direct chat client sends on the same connection.
    """

    def __init__(self, client: AsyncOpenAI, compatibility: ModelConnectionCompatibility) -> None:
        self._client = client
        self._compatibility = compatibility
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs: Any) -> Any:
        if "tools" in kwargs:
            kwargs["tools"] = function_tools_for_connection(kwargs["tools"], compatibility=self._compatibility)
        return await self._client.chat.completions.create(**kwargs)

    def with_options(self, **options: Any) -> _ConnectionFunctionTools:
        return _ConnectionFunctionTools(self._client.with_options(**options), self._compatibility)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


class OpenAIAgentsMemoryManagerRuntime:
    """OpenAI Agents SDK runtime over Animama's virtual memory workspace."""

    name = "openai_agents"

    def __init__(
        self,
        *,
        user_id: str,
        memory_entries: MemoryEntryService,
        memory_episodes: MemoryEpisodeRepository | None = None,
        animas: AnimaRepository | None = None,
        chat_messages: ChatMessageRepository | None = None,
        model_provider: ModelProvider | None,
        model_providers: ModelProviderRepository | None = None,
        credential_resolver: ModelCredentialResolver,
        openai_base_url: str | None = None,
        timeout_seconds: float,
        model_wrapper: Callable[[Any, MemoryManagerRun], Any] | None = None,
        model_limits: ModelCallLimits | None = None,
        max_model_turns: int | None = None,
        chatgpt_plan_session: Callable[[], ChatGPTPlanTokenSource] | None = None,
        chatgpt_plan_transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        """Run the manager on the memory-manager role's catalog row.

        OpenAI Responses rows use the hosted ``apply_patch`` tool and server-side
        response continuity. Chat Completions rows (any connection) use an
        approval-gated ``apply_patch`` function tool and replay the run's stored
        messages, since those servers keep no conversation state. ChatGPT plan
        rows replay too, through :class:`ChatGPTPlanAgentsClient` with a token
        from ``chatgpt_plan_session``: ``background`` for a run that started by
        itself, ``interactive`` otherwise (spec #919). ``model_providers`` finds
        the row an earlier run started on, so an approval resumes on the model
        that proposed it. ``chatgpt_plan_transport`` is a test hook.
        """

        if max_model_turns is not None and (type(max_model_turns) is not int or max_model_turns < 1):
            raise ValueError("max_model_turns must be a positive integer")
        # Wrap the SDK Model itself, not Runner.run: each nested tool round and
        # resumed approval must cross the composition's admission boundary.
        self._model_wrapper = model_wrapper
        self._model_limits = model_limits
        self._max_model_turns = max_model_turns
        self._user_id = user_id
        self._memory_entries = memory_entries
        self._memory_episodes = memory_episodes
        self._animas = animas
        self._chat_messages = chat_messages
        self._model_provider = model_provider
        self._model_providers = model_providers
        self._credentials = credential_resolver
        self._openai_base_url = resolve_openai_base_url(openai_base_url)
        self._model = model_provider.model if model_provider is not None else ""
        self._timeout_seconds = max(0.1, float(timeout_seconds))
        self._chatgpt_plan_session = chatgpt_plan_session
        self._chatgpt_plan_transport = chatgpt_plan_transport
        self._runner = OpenAIAgentsRunner()
        self._log = get_logger("adapters.memory_manager.openai_agents")

    def _turn_limit(self, run: MemoryManagerRun) -> int:
        ordinary = max_turns_for_run(run)
        return min(ordinary, self._max_model_turns) if self._max_model_turns is not None else ordinary

    @property
    def model_provider_id(self) -> str | None:
        return self._model_provider.id if self._model_provider is not None else None

    async def for_run(self, run: MemoryManagerRun) -> OpenAIAgentsMemoryManagerRuntime:
        """Return a runtime on the row that ran ``run``'s latest step (runs without one use the role row)."""

        pinned_id = run.model_provider_id
        if pinned_id is None or pinned_id == self.model_provider_id:
            await self._ensure_plan_can_serve(run)
            return self
        row = await self._model_providers.get(pinned_id) if self._model_providers is not None else None
        if row is None or not usable_for_role(ROLE_MEMORY_MANAGER, row):
            raise MemoryManagerPinnedModelUnavailableError()
        pinned = copy(self)
        pinned._model_provider = row
        pinned._model = row.model
        try:
            # Fail before the decision is applied, not after an approved write commits.
            pinned._require_model()
        except MemoryManagerRuntimeConfigurationError as exc:
            raise MemoryManagerPinnedModelUnavailableError() from exc
        await pinned._ensure_plan_can_serve(run)
        return pinned

    async def _ensure_plan_can_serve(self, run: MemoryManagerRun) -> None:
        """For a ChatGPT plan row, refuse before an approval is applied when the session cannot serve the run."""

        if not self._uses_chatgpt_plan:
            return
        try:
            await self._plan_session().access_token(_plan_purpose(run))
        except ChatGPTPlanUnavailableError as exc:
            raise MemoryManagerPinnedModelUnavailableError(_plan_failure_message(exc)) from exc
        except MemoryManagerRuntimeConfigurationError as exc:
            raise MemoryManagerPinnedModelUnavailableError(exc.detail) from exc

    async def run_user_message(
        self,
        *,
        run: MemoryManagerRun,
        user_message: MemoryManagerMessage,
        history: Sequence[MemoryManagerMessage] = (),
    ) -> MemoryManagerRuntimeResult:
        """Run the live memory manager for a new user message."""

        connection, credential, client = await self._connect(run)
        workspace = self._workspace_for_run(run)
        try:
            agent, run_config = await self._build_agent(
                run=run,
                workspace=workspace,
                client=client,
                credential=credential,
                editor=_approval_required_patch_editor(),
            )
            if self._uses_responses:
                # Without a cursor (for example after the role moved from a Chat
                # Completions row), replay the run so its history is not lost.
                output = await self._runner.run(
                    agent=agent,
                    input_value=(
                        user_message.content
                        if run.openai_previous_response_id or not history
                        else _replayed_input(history, user_message)
                    ),
                    context=_context_for_run(run),
                    run_config=run_config,
                    max_turns=self._turn_limit(run),
                    previous_response_id=run.openai_previous_response_id,
                    auto_previous_response_id=True,
                )
            else:
                output = await self._runner.run(
                    agent=agent,
                    input_value=_replayed_input(history, user_message),
                    context=_context_for_run(run),
                    run_config=run_config,
                    max_turns=self._turn_limit(run),
                )
            result = await self._runtime_result_from_sdk_output(
                run=run,
                agent=agent,
                run_config=run_config,
                workspace=workspace,
                output=output,
            )
            # Only stored Responses keep the conversation; after any other step a cursor would skip it.
            result.keeps_conversation_state = self._uses_responses
            return result
        except APIStatusError as exc:
            if run.openai_previous_response_id and _is_unresolvable_previous_response_error(exc):
                raise MemoryManagerPreviousResponseUnresolvableError() from exc
            raise MemoryManagerRuntimeConfigurationError(self._request_failure(exc)) from exc
        except (ChatGPTPlanUnavailableError, ChatGPTPlanResponseFailedError) as exc:
            raise MemoryManagerRuntimeConfigurationError(_plan_failure_message(exc)) from exc
        except Exception as exc:
            if _is_max_turns_exceeded(exc):
                return blocked_result(
                    "The Memory Manager reached its turn limit before completing the review.",
                    runtime=self.name,
                )
            if isinstance(exc, MemoryManagerRuntimeConfigurationError):
                raise
            raise MemoryManagerRuntimeConfigurationError("The Memory Manager runtime failed.") from exc
        finally:
            await client.close()

    async def resume_approval_decision(
        self,
        *,
        run: MemoryManagerRun,
        approval: MemoryManagerApproval,
        decision: str,
        feedback: str | None = None,
    ) -> MemoryManagerRuntimeResult:
        """Best-effort resume of the SDK state after an approval decision."""

        if not run.serialized_agent_state:
            return blocked_result(
                "The Memory Manager approval state is missing and cannot be resumed.",
                runtime=self.name,
                serialized_agent_state=None,
                metadata={"resume": "skipped_missing_state"},
            )

        connection, credential, client = await self._connect(run)
        workspace = self._workspace_for_run(run)
        try:
            editor = _committed_approval_patch_editor(approval=approval if decision == "approve" else None)
            agent, run_config = await self._build_agent(
                run=run,
                workspace=workspace,
                client=client,
                credential=credential,
                editor=editor,
            )
            state = await self._runner.load_state(
                agent=agent,
                serialized_state=run.serialized_agent_state,
                context=_context_for_run(run),
                # Each approval resume gets the run's full turn budget (D24).
                turn_budget=self._turn_limit(run),
            )
            interruption = _find_interruption_for_approval(state.get_interruptions(), approval)
            if interruption is None:
                return blocked_result(
                    "The Memory Manager approval interruption is missing and cannot be resumed.",
                    runtime=self.name,
                    serialized_agent_state=run.serialized_agent_state,
                    metadata={"resume": "skipped_missing_interruption"},
                )

            if decision == "approve":
                state.approve(interruption)
            else:
                state.reject(
                    interruption,
                    rejection_message=rejection_message(approval.target_path, feedback),
                )
            output = await self._runner.resume_state(
                agent=agent,
                state=state,
                max_turns=self._turn_limit(run),
                run_config=run_config,
            )
            result = await self._runtime_result_from_sdk_output(
                run=run,
                agent=agent,
                run_config=run_config,
                workspace=workspace,
                output=output,
            )
            # Only stored Responses keep the conversation; after any other step a cursor would skip it.
            result.keeps_conversation_state = self._uses_responses
            return result
        except APIStatusError as exc:
            if run.openai_previous_response_id and _is_unresolvable_previous_response_error(exc):
                raise MemoryManagerPreviousResponseUnresolvableError() from exc
            raise MemoryManagerRuntimeConfigurationError(self._request_failure(exc)) from exc
        except (ChatGPTPlanUnavailableError, ChatGPTPlanResponseFailedError) as exc:
            raise MemoryManagerRuntimeConfigurationError(_plan_failure_message(exc)) from exc
        except Exception as exc:
            if _is_max_turns_exceeded(exc):
                return blocked_result(
                    "The Memory Manager reached its turn limit before completing the review.",
                    runtime=self.name,
                )
            if isinstance(exc, MemoryManagerRuntimeConfigurationError):
                raise
            raise MemoryManagerRuntimeConfigurationError("The Memory Manager runtime failed.") from exc
        finally:
            await client.close()

    def _workspace_for_run(self, run: MemoryManagerRun) -> MemoryManagerVirtualWorkspace:
        return MemoryManagerVirtualWorkspace(
            user_id=self._user_id,
            memory_entries=self._memory_entries,
            access=manager_file_access_for_run(run),
        )

    def _row_metadata(self) -> dict[str, Any]:
        """Identify the catalog row that ran, so runs record their actual provider."""

        row = self._model_provider
        if row is None:
            return {"model": self._model}
        return {
            "model": self._model,
            "model_provider": row.provider_type,
            "model_provider_id": row.id,
            "connection_id": row.connection_id,
        }

    @property
    def _uses_responses(self) -> bool:
        return self._model_provider is not None and self._model_provider.provider_type == OPENAI_RESPONSES_PROVIDER_TYPE

    @property
    def _uses_chatgpt_plan(self) -> bool:
        return (
            self._model_provider is not None
            and self._model_provider.provider_type == CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
        )

    async def _connect(self, run: MemoryManagerRun) -> tuple[ModelConnection, ModelCredential, Any]:
        """The role's connection, the credential this run uses and an SDK client that carries it."""

        connection, credential = self._require_model()
        if not self._uses_chatgpt_plan:
            return connection, credential, self._client(connection, credential)
        session = self._plan_session()
        purpose = _plan_purpose(run)
        try:
            # Fail with the plan's reason before the agent is built; each request asks again.
            await session.access_token(purpose)
        except ChatGPTPlanUnavailableError as exc:
            raise MemoryManagerRuntimeConfigurationError(_plan_failure_message(exc)) from exc
        timeout = self._model_limits.timeout_seconds if self._model_limits is not None else self._timeout_seconds
        client = ChatGPTPlanAgentsClient(
            client=plan_sdk_client(timeout=timeout, transport=self._chatgpt_plan_transport),
            session=session,
            purpose=purpose,
            timeout=timeout,
        )
        return connection, credential, client

    def _plan_session(self) -> ChatGPTPlanTokenSource:
        if self._chatgpt_plan_session is None:
            raise MemoryManagerRuntimeConfigurationError("ChatGPT plan models are not available here.")
        return self._chatgpt_plan_session()

    def _request_failure(self, exc: APIStatusError) -> str:
        """The run's error for a refused request; on the plan, worded from the plan's code (R5.3)."""

        if not self._uses_chatgpt_plan:
            return "The Memory Manager model request failed."
        info = classify_openai_exception(
            exc, api="responses", provider_type=CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE, model=self._model
        )
        code = plan_error_code(info.metadata)
        if code is not None and code in _PLAN_FAILURES:
            return _PLAN_FAILURES[code]
        if exc.status_code == 401:
            return _PLAN_FAILURES["sign_in_required"]
        detail = info.metadata.get("provider_error_message")
        if exc.status_code == 400 and isinstance(detail, str) and detail:
            # The route says what it does not accept; the error classifier already sanitized the text.
            return f"The ChatGPT plan refused the Memory Manager request: {detail}"
        if exc.status_code == 429:
            return "The ChatGPT plan is limiting requests right now. Try again shortly."
        return "The Memory Manager model request failed."

    def _require_model(self) -> tuple[ModelConnection, ModelCredential]:
        """Return the role's connection and the one key this run will use."""

        if self._model_provider is None:
            raise MemoryManagerRuntimeConfigurationError(
                "No model with tool calling is available for the Memory Manager. Choose one in App Settings."
            )
        if self._model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE:
            # Anthropic rows run on their own runtime; this client would send their key to an OpenAI endpoint.
            raise MemoryManagerRuntimeConfigurationError(
                "Anthropic models run on the Anthropic Memory Manager runtime."
            )
        try:
            connection = connection_for_model_provider(self._model_provider)
        except ValueError as exc:
            raise MemoryManagerRuntimeConfigurationError(str(exc)) from exc
        credential = self._credentials.resolve(connection)
        if not credential.usable:
            raise MemoryManagerRuntimeConfigurationError(f"No key is configured for {connection.name}.")
        return connection, credential

    def _client(self, connection: ModelConnection, credential: ModelCredential) -> AsyncOpenAI:
        """Reach the role's connection with only its own credential."""

        try:
            base_url = connection_base_url(connection, openai_base_url=self._openai_base_url)
        except ModelClientProviderError as exc:
            raise MemoryManagerRuntimeConfigurationError(str(exc)) from exc
        client = sdk_client_for_connection(
            connection,
            credential=credential,
            base_url=base_url,
            timeout=connection_timeout(
                connection.timeout_seconds if connection.timeout_seconds is not None else self._timeout_seconds
            ),
        )

        if self._model_limits is not None:
            client = client.with_options(max_retries=0, timeout=self._model_limits.timeout_seconds)
        return client

    async def _build_agent(
        self,
        *,
        run: MemoryManagerRun,
        workspace: MemoryManagerVirtualWorkspace,
        client: AsyncOpenAI,
        credential: ModelCredential,
        editor: ApplyPatchEditor,
    ) -> tuple[Agent[Any], RunConfig]:
        from agents import (
            Agent,
            ApplyPatchTool,
            ModelSettings,
            OpenAIChatCompletionsModel,
            OpenAIResponsesModel,
            RunConfig,
            function_tool,
            tool_namespace,
        )
        from agents.editor import ApplyPatchOperation

        user_memory_reads = UserMemoryReadToolService(
            memory_entries=self._memory_entries,
            manager_access=manager_file_access_for_run(run),
        )
        memory_map = await user_memory_reads.render_memory_map(user_id=self._user_id)
        reflection = self._reflection_task(run)

        @function_tool(name_override=MEMORY_TOOL_LIST_FILES)
        async def memory_list_files() -> dict[str, Any]:
            """List user memory files."""

            return await user_memory_reads.list_files(user_id=self._user_id)

        @function_tool(name_override=MEMORY_TOOL_READ_FILES)
        async def memory_read_files(paths: str | list[str]) -> dict[str, Any]:
            """Read patchable user memory documents by relative markdown path."""

            return await user_memory_reads.read_files(
                user_id=self._user_id,
                paths=paths,
                native_patch_mode=True,
            )

        @function_tool(
            name_override=MEMORY_TOOL_SEARCH_MEMORY_FILES, description_override=MEMORY_SEARCH_FILES_DESCRIPTION
        )
        async def search_memory_files(
            query: str,
            include_episodic_memory: bool,
        ) -> dict[str, Any]:
            """Search user memory files; the model sees the chat tool's shared description."""

            return await user_memory_reads.search_files(
                user_id=self._user_id,
                query=query,
                include_episodic_memory=include_episodic_memory,
            )

        tools: list[Any] = [memory_list_files, memory_read_files, search_memory_files]
        if reflection is not None:
            turn_reader = self._reflection_turn_reader(reflection)

            @function_tool(name_override=MEMORY_TOOL_READ_REFLECTION_TURNS)
            async def read_reflection_turns(page: int) -> dict[str, Any]:
                """Read one page of this Reflection's chat turns, oldest first, starting at page 1.

                Follow next_page until has_more is false.
                """

                return await turn_reader.read_page(page)

            tools.append(read_reflection_turns)

        instructions = await self._instructions_for_run(run=run, memory_map=memory_map)
        assert self._model_provider is not None
        connection = connection_for_model_provider(self._model_provider)
        cache_key = _memory_manager_prompt_cache_key(run_id=run.id, model=self._model)

        @function_tool(name_override=_PATCH_TOOL_NAME, needs_approval=True)
        async def apply_patch(operation: _PatchOperation) -> str:
            """Propose exactly one create_file or update_file memory change as a V4A diff."""

            patch = ApplyPatchOperation(type=operation.type, path=operation.path, diff=operation.diff)
            outcome = editor.create_file(patch) if operation.type == "create_file" else editor.update_file(patch)
            result = await outcome if inspect.isawaitable(outcome) else outcome
            if isinstance(result, str):
                return result or "Patch processed."
            return (result.output if result is not None else None) or "Patch processed."

        if self._uses_responses:
            model: Any = OpenAIResponsesModel(self._model, client)
            model_settings = ModelSettings(store=True, extra_args={"prompt_cache_key": cache_key})
            tools.append(ApplyPatchTool(editor=editor, needs_approval=True))
        elif self._uses_chatgpt_plan:
            # The plan's route refuses the hosted apply_patch tool, so edits use the function form;
            # the client makes every request streamed and unstored (spec #919).
            # ``client`` is the ChatGPTPlanAgentsClient that ``_connect`` built for this row.
            model = OpenAIResponsesModel(self._model, as_openai_client(cast(ChatGPTPlanAgentsClient, client)))
            model_settings = ModelSettings(store=False, extra_args={"prompt_cache_key": cache_key})
            # OpenAI's documentation asks for function tools inside a namespace on this route.
            tools = tool_namespace(
                name=PLAN_TOOL_NAMESPACE, description=PLAN_TOOL_NAMESPACE_DESCRIPTION, tools=[*tools, apply_patch]
            )
        else:
            model = OpenAIChatCompletionsModel(
                self._model,
                cast(AsyncOpenAI, _ConnectionFunctionTools(client, connection.compatibility)),
            )
            extra_args = {"prompt_cache_key": cache_key} if connection.compatibility.send_openai_extensions else None
            model_settings = ModelSettings(
                extra_args=extra_args,
                extra_headers=keyless_request_headers(connection, credential),
                reasoning=_function_tool_reasoning(self._model, connection),
            )
            tools.append(apply_patch)
        if self._model_limits is not None:
            model_settings.max_tokens = self._model_limits.max_output_tokens
        if self._model_wrapper is not None:
            model = self._model_wrapper(model, run)
        agent = Agent(
            name="Animama Memory Manager",
            instructions=instructions,
            model=model,
            model_settings=model_settings,
            tools=tools,
        )
        run_config = RunConfig(
            # Traces go to OpenAI; only runs on the built-in OpenAI connection send them.
            tracing_disabled=not connection.is_builtin_openai,
            trace_include_sensitive_data=False,
            workflow_name=_TRACE_WORKFLOW_NAME,
            group_id=run.id,
            trace_metadata={
                "memory_manager_run_id": run.id,
                "runtime": self.name,
                "model": self._model,
            },
        )
        return agent, run_config

    def _reflection_task(self, run: MemoryManagerRun) -> MemoryManagerReflectionTaskState | None:
        try:
            return reflection_task_or_none(run)
        except ValueError as exc:
            raise MemoryManagerRuntimeConfigurationError(str(exc)) from exc

    def _reflection_turn_reader(self, task: MemoryManagerReflectionTaskState) -> ReflectionTurnReader:
        if self._chat_messages is None:
            raise MemoryManagerRuntimeConfigurationError("Reflection is not configured")
        return ReflectionTurnReader(chat_messages=self._chat_messages, user_id=self._user_id, task=task)

    async def _instructions_for_run(self, *, run: MemoryManagerRun, memory_map: str) -> str:
        general = _instructions(memory_map=memory_map, access=manager_file_access_for_run(run))
        reflection = self._reflection_task(run)
        if reflection is not None:
            return f"{general}\n\n{render_reflection_instructions(task=reflection)}"
        if run.kind != MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING:
            return general
        try:
            task = MemoryManagerEpisodeTaskState.from_dict(run.task_state)
        except ValueError as exc:
            raise MemoryManagerRuntimeConfigurationError(str(exc)) from exc
        if task.status != MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING:
            return general
        if self._memory_episodes is None:
            raise MemoryManagerRuntimeConfigurationError("Episode processing is not configured")
        try:
            _task, batch = await load_episode_processing_batch(
                run=run,
                memory_episodes=self._memory_episodes,
                animas=self._animas,
            )
        except ValueError as exc:
            raise MemoryManagerRuntimeConfigurationError(str(exc)) from exc
        specialized = render_episode_processing_instructions(batch=batch)
        return f"{general}\n\n{specialized}"

    async def _runtime_result_from_sdk_output(
        self,
        *,
        run: MemoryManagerRun,
        agent: Agent[Any],
        run_config: RunConfig,
        workspace: MemoryManagerVirtualWorkspace,
        output: OpenAIAgentsRunOutput,
        invalid_resume_count: int = 0,
        latest_response_id: str | None = None,
    ) -> MemoryManagerRuntimeResult:
        # A plan response is never stored, so it is no cursor; the result also says the step kept no state.
        latest_response_id = None if self._uses_chatgpt_plan else (output.last_response_id or latest_response_id)
        interruptions = output.interruptions
        metadata = {
            "runtime": self.name,
            **self._row_metadata(),
            **output.metadata,
            "interruption_count": len(interruptions),
        }
        if not interruptions:
            final_output = output.final_output.strip() if output.final_output is not None else ""
            if not final_output:
                return blocked_result(
                    "The Memory Manager ended without a final response.",
                    runtime=self.name,
                    openai_previous_response_id=latest_response_id,
                    usage_metadata=output.usage_metadata,
                    metadata=metadata,
                )
            return MemoryManagerRuntimeResult(
                assistant_message=final_output,
                serialized_agent_state=None,
                openai_previous_response_id=latest_response_id,
                usage_metadata=output.usage_metadata,
                metadata=metadata,
                summary="Live OpenAI Agents memory-manager run",
                outcome=MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED,
            )

        state = output.state
        if state is None:
            return blocked_result(
                "I could not prepare a memory preview: the SDK did not return resumable state.",
                runtime=self.name,
                serialized_agent_state=None,
                openai_previous_response_id=latest_response_id,
                usage_metadata=output.usage_metadata,
                metadata=metadata,
                summary="Live OpenAI Agents memory-manager run",
            )
        approvals: list[MemoryManagerRuntimeApprovalRequest] = []
        invalid_messages: list[str] = []
        for interruption in interruptions:
            try:
                approval = await self._approval_from_interruption(workspace=workspace, interruption=interruption)
            except MemoryManagerPatchRejected as exc:
                invalid_messages.append(exc.detail)
                state.reject(interruption, rejection_message=exc.detail)
                continue
            approvals.append(approval)

        if approvals:
            if invalid_messages:
                metadata["auto_rejected_invalid_patch_count"] = len(invalid_messages)
            return MemoryManagerRuntimeResult(
                assistant_message="I prepared a memory file preview. Review the diff before approving it.",
                approvals=approvals,
                serialized_agent_state=state.to_string(),
                openai_previous_response_id=latest_response_id,
                usage_metadata=output.usage_metadata,
                metadata=metadata,
                summary="Live OpenAI Agents memory-manager run",
                outcome=MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL,
            )

        if invalid_messages and invalid_resume_count < _MAX_INVALID_PATCH_RESUMES:
            resumed = await self._runner.resume_state(
                agent=agent,
                state=state,
                max_turns=self._turn_limit(run),
                run_config=run_config,
            )
            return await self._runtime_result_from_sdk_output(
                run=run,
                agent=agent,
                run_config=run_config,
                workspace=workspace,
                output=resumed,
                invalid_resume_count=invalid_resume_count + 1,
                latest_response_id=latest_response_id,
            )

        message = (
            "I could not prepare a memory preview: "
            f"{invalid_messages[0] if invalid_messages else 'the patch request was invalid'}."
        )
        return blocked_result(
            message,
            runtime=self.name,
            serialized_agent_state=None,
            openai_previous_response_id=latest_response_id,
            usage_metadata=output.usage_metadata,
            metadata={**metadata, "invalid_patch_messages": invalid_messages},
            summary="Live OpenAI Agents memory-manager run",
        )

    async def _approval_from_interruption(
        self,
        *,
        workspace: MemoryManagerVirtualWorkspace,
        interruption: Any,
    ) -> MemoryManagerRuntimeApprovalRequest:
        call_id = _interruption_call_id(interruption)
        if not isinstance(call_id, str) or not call_id:
            raise MemoryManagerPatchRejected("Patch approval is missing a tool call id")
        payload = _apply_patch_payload(interruption)
        operations = _operations_from_payload(payload)
        if len(operations) != 1:
            raise MemoryManagerPatchRejected("Submit exactly one memory file operation per approval")
        operation = operations[0]
        operation_type = str(_get_value(operation, "type") or "")
        path = _get_value(operation, "path")
        diff = _get_value(operation, "diff")
        if not isinstance(path, str):
            raise MemoryManagerPatchRejected("Patch operation is missing a path")
        return await workspace.plan_v4a_operation(
            operation_type=operation_type,
            path=path,
            diff=diff if isinstance(diff, str) else None,
            metadata={
                "runtime": self.name,
                "sdk_call_id": call_id,
                "sdk_tool_name": _interruption_tool_name(interruption),
                "sdk_operation_type": operation_type,
                "v4a_diff": diff if isinstance(diff, str) else None,
            },
        )


def _approval_required_patch_editor() -> ApplyPatchEditor:
    """Build an SDK editor that should only run if approval pausing fails."""

    from agents.editor import ApplyPatchEditor, ApplyPatchOperation, ApplyPatchResult

    class ApprovalRequiredPatchEditor(ApplyPatchEditor):
        async def create_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            return ApplyPatchResult(status="failed", output=f"Patch for `{operation.path}` requires approval.")

        async def update_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            return ApplyPatchResult(status="failed", output=f"Patch for `{operation.path}` requires approval.")

        async def delete_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            return ApplyPatchResult(status="failed", output=f"Deleting `{operation.path}` is not allowed.")

    return ApprovalRequiredPatchEditor()


def _committed_approval_patch_editor(*, approval: MemoryManagerApproval | None) -> ApplyPatchEditor:
    """Build an SDK editor that acknowledges one already-committed approval."""

    from agents.editor import ApplyPatchEditor, ApplyPatchOperation, ApplyPatchResult

    class CommittedApprovalPatchEditor(ApplyPatchEditor):
        def __init__(self, *, approval: MemoryManagerApproval | None) -> None:
            self._approval = approval

        async def create_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            return self._result_for(operation)

        async def update_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            return self._result_for(operation)

        async def delete_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            return ApplyPatchResult(status="failed", output=f"Deleting `{operation.path}` is not allowed.")

        def _result_for(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            if self._approval is None:
                return ApplyPatchResult(status="failed", output=f"Patch for `{operation.path}` was not approved.")
            metadata = dict(self._approval.operation_metadata or {})
            if (
                # Stored paths compare case-insensitively; identity targets are canonicalized.
                operation.path.casefold() == self._approval.target_path.casefold()
                and operation.type == metadata.get("sdk_operation_type")
                and operation.diff == metadata.get("v4a_diff")
            ):
                return ApplyPatchResult(
                    status="completed",
                    output=f"Committed approved memory change for `{operation.path}`.",
                )
            return ApplyPatchResult(
                status="failed",
                output=f"Patch for `{operation.path}` does not match the approved operation.",
            )

    return CommittedApprovalPatchEditor(approval=approval)


def _replayed_input(
    history: Sequence[MemoryManagerMessage], user_message: MemoryManagerMessage
) -> list[dict[str, str]]:
    """Rebuild the run's conversation for servers without stored response state."""

    items = [
        {"role": message.role, "content": message.content}
        for message in history
        if message.role in _HISTORY_ROLES and message.content and message.id != user_message.id
    ]
    return [*items, {"role": "user", "content": user_message.content}]


def _context_for_run(run: MemoryManagerRun) -> dict[str, Any]:
    return {
        "runtime": "memory_manager",
        "run_id": run.id,
        "user_id": run.user_id,
    }


_ANIMA_FILES_INSTRUCTIONS = (
    "Entries under animas/<anima_id>/ belong to one Anima; the map's anima field names it. Entries are in Anima "
    "creation order; when names repeat, the workspace labels the second and later ones Name (2), Name (3), and so "
    "on. Never create, delete or move an Anima file, and never add other files under animas/.\n"
)
_ANIMA_IDENTITY_INSTRUCTIONS = (
    "animas/<anima_id>/IDENTITY.md is that Anima's required identity. Read it when the user asks about an Anima. "
    "Propose an update_file change to an identity only when the user's request is about that Anima's identity or "
    "personality, and never empty it.\n"
)
_ANIMA_MEMORIES_INSTRUCTIONS = (
    "animas/<anima_id>/MEMORIES.md is that Anima's own first-person record of its relationship with the user, "
    "which the Anima and Reflection maintain. Propose an update_file change to it only when the user explicitly "
    "asks to change that Anima's MEMORIES.md. "
    f"{SENSITIVE_MEMORY_RULE} Never record or frame the relationship as the Anima missing the user or feeling "
    "lonely without them, as jealousy, or in a way that discourages the user's other relationships.\n"
)


def _anima_file_instructions(access: ManagerFileAccess) -> str:
    """Describe the Anima files a general run may reach; Reflection mode supplies its own mandate."""

    if access.anima_id is not None or not access.anima_files:
        return ""
    return "".join(
        (
            _ANIMA_FILES_INSTRUCTIONS,
            _ANIMA_IDENTITY_INSTRUCTIONS if access.anima_identities else "",
            _ANIMA_MEMORIES_INSTRUCTIONS if access.anima_memories else "",
        )
    )


def _instructions(*, memory_map: str, access: ManagerFileAccess | None = None) -> str:
    anima_guidance = _anima_file_instructions(access) if access is not None else ""
    return (
        "You are Animama's user memory manager. Help the user maintain durable markdown memory files.\n"
        "You work only in the virtual user memory workspace. Do not ask for or assume shell access.\n"
        "Use memory_list_files, memory_read_files, and search_memory_files to inspect memory.\n"
        "When a new fact replaces an older one, also correct or remove the outdated statement wherever it appears "
        "(search_memory_files finds it), so the files never contradict each other.\n"
        f"{MEMORY_LANGUAGE_RULE}\n"
        "Descriptions in the memory map are a concise birds-eye index of each file without reading it. "
        "Give new files useful descriptions. Whenever content changes, review the description too. Preserve the "
        "description verbatim when it remains accurate, and update it when the file's scope or durable contents "
        "materially change.\n"
        "memory_read_files returns a synthetic patch document in each file's content field. Its first three lines "
        "are a reserved header in exactly this form:\n"
        "`---\n"
        'description: "Concise overview of the file."\n'
        "---`\n"
        "The remaining text is the stored Markdown body. Calculate apply_patch diffs against the entire returned "
        "content. "
        "For create_file, create both the reserved header with a suitable description and body. "
        "Never copy the synthetic header into "
        "the Markdown body or user-facing text.\n"
        "Similarly, for update_file operations, "
        "keep the descriptions up to date through the reserved description header. "
        "When proposing a memory edit, use apply_patch with exactly one create_file or update_file operation. "
        "Never request delete_file. Only use relative POSIX paths ending in .md.\n"
        "The user must approve apply_patch changes before they become durable.\n"
        f"{anima_guidance}"
        f"\n{memory_map}"
    )


_PLAN_FAILURES = {
    "not_signed_in": "Sign in with ChatGPT in App Settings → Models to use your plan for memory updates.",
    "sign_in_required": "Sign in with ChatGPT again in App Settings → Models to use your plan for memory updates.",
    "plan_use_not_granted": "Plan use is off for this ChatGPT account. Enable it in App Settings → Models.",
    "background_not_agreed": (
        "Automatic memory updates may not use your ChatGPT plan. Allow them in App Settings → Models."
    ),
    "paused": (
        "Automatic memory updates on your ChatGPT plan are paused after a usage limit. "
        "They resume once one of your own requests succeeds."
    ),
    "temporarily_unavailable": "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
    "usage_limit_exceeded": (
        "Your ChatGPT plan's usage limit was reached. Review it with Manage usage in App Settings → Models."
    ),
    "user_not_eligible": "Your ChatGPT plan does not include this use. Choose another Memory Manager model.",
    "usage_unavailable": "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
    "user_unavailable": "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
    "invalid_user": "Sign in with ChatGPT again in App Settings → Models to use your plan for memory updates.",
    "unsupported_capability": "The ChatGPT plan refused the Memory Manager request. Choose another model.",
    "route_not_supported": "The ChatGPT plan refused the Memory Manager request. Choose another model.",
}


def _plan_purpose(run: MemoryManagerRun) -> ChatGPTPlanPurpose:
    """Work that started by itself follows the background rule: agreement, and no usage-limit pause (D5)."""

    return "background" if memory_manager_run_is_automatic(run) else "interactive"


def _plan_failure_message(exc: ChatGPTPlanUnavailableError | ChatGPTPlanResponseFailedError) -> str:
    """What a Memory Manager run on the plan says when the plan could not serve it."""

    return _PLAN_FAILURES.get(exc.code or "", "The ChatGPT plan could not complete the Memory Manager request.")


def _is_max_turns_exceeded(exc: Exception) -> bool:
    """Avoid importing the optional SDK exception at module import time."""

    from agents import MaxTurnsExceeded

    return isinstance(exc, MaxTurnsExceeded)


def _memory_manager_prompt_cache_key(*, run_id: str, model: str) -> str:
    """Return a private stable cache bucket for one manager run and model."""

    return sha256(f"memory_manager\x1f{run_id}\x1f{model}".encode()).hexdigest()


def _function_tool_reasoning(model: str, connection: ModelConnection) -> Reasoning | None:
    """Return the reasoning setting for a Chat Completions manager, whose every request carries function tools.

    Sending no effort leaves the model's default, which OpenAI refuses with
    function tools from GPT-5.4 on, so those models run the manager at
    ``none``. Other models keep their server's default.
    """

    effort = chat_completions_function_tool_effort(model, connection.compatibility)
    return Reasoning(effort=cast(ReasoningEffort, effort)) if effort is not None else None


def _is_unresolvable_previous_response_error(exc: APIStatusError) -> bool:
    """Recognize OpenAI errors that specifically reject a stored response cursor."""

    if exc.status_code not in {400, 404}:
        return False
    body = exc.body if isinstance(exc.body, Mapping) else {}
    nested_error = body.get("error")
    if isinstance(nested_error, Mapping):
        body = nested_error
    param = body.get("param")
    if param == "previous_response_id":
        return True
    code = str(body.get("code") or "").lower()
    message = str(body.get("message") or exc).lower()
    mentions_previous_response = "previous_response_id" in message or "previous response" in message
    cannot_resolve = any(token in f"{code} {message}" for token in ("not found", "expired", "unresolvable"))
    return mentions_previous_response and cannot_resolve


def _apply_patch_payload(interruption: Any) -> dict[str, Any]:
    raw = getattr(interruption, "raw_item", None)
    for source in (_mapping_from_value(interruption), _mapping_from_value(raw)):
        for key in ("arguments", "input", "params"):
            value = source.get(key)
            if isinstance(value, str):
                try:
                    parsed = json.loads(value or "{}")
                except json.JSONDecodeError as exc:
                    raise MemoryManagerPatchRejected(f"Patch arguments are invalid JSON: {exc}") from exc
                if isinstance(parsed, Mapping):
                    return dict(parsed)
            if isinstance(value, Mapping):
                return dict(value)
    raw_mapping = _mapping_from_value(raw)
    return raw_mapping


def _operations_from_payload(payload: Mapping[str, Any]) -> list[Any]:
    operations = payload.get("operations")
    if isinstance(operations, list):
        return operations
    operation = payload.get("operation")
    if operation is not None:
        return [operation]
    raise MemoryManagerPatchRejected("Patch request is missing an operation")


def _mapping_from_value(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump()
        if isinstance(dumped, Mapping):
            return dict(dumped)
    result: dict[str, Any] = {}
    for key in ("type", "name", "call_id", "arguments", "operation", "operations", "input", "params"):
        attr = getattr(value, key, None)
        if attr is not None:
            result[key] = attr
    return result


def _get_value(value: Any, key: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(key)
    return getattr(value, key, None)


def _interruption_call_id(interruption: Any) -> str | None:
    value = getattr(interruption, "call_id", None)
    if isinstance(value, str) and value:
        return value
    raw = getattr(interruption, "raw_item", None)
    value = _get_value(raw, "call_id")
    if isinstance(value, str) and value:
        return value
    return None


def _interruption_tool_name(interruption: Any) -> str | None:
    value = getattr(interruption, "tool_name", None) or getattr(interruption, "name", None)
    if isinstance(value, str) and value:
        return value
    raw = getattr(interruption, "raw_item", None)
    value = _get_value(raw, "name")
    if isinstance(value, str) and value:
        return value
    return None


def _find_interruption_for_approval(interruptions: list[Any], approval: MemoryManagerApproval) -> Any | None:
    expected_call_id = dict(approval.operation_metadata or {}).get("sdk_call_id")
    for interruption in interruptions:
        if _interruption_call_id(interruption) == expected_call_id:
            return interruption
    return None


__all__ = ["OpenAIAgentsMemoryManagerRuntime"]
