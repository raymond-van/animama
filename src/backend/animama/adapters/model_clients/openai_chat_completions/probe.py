"""Capability probe for OpenAI-compatible model connections.

Each step is one small request with a short prompt. The first request may load
the model on a local server, so steps use the connection timeout. After chat
steps succeed, the probe asks known local servers for the window they serve:
llama.cpp ``/props`` and Ollama ``/api/ps`` report the loaded context size, and
LM Studio's native API reports it only while the model is loaded.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx2
from openai import AsyncOpenAI, OpenAIError

from animama.adapters.model_clients.openai_errors import classify_openai_exception
from animama.app.model_catalog import (
    STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT,
    STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
    chat_completions_function_tool_effort,
)
from animama.app.model_clients import ModelClientProviderError
from animama.app.model_clients.credentials import ModelCredentialResolver
from animama.app.model_clients.error_categories import (
    ERROR_CREDENTIAL_MISSING,
    ERROR_CREDENTIAL_REJECTED,
    ERROR_INVALID_BASE_URL,
    ERROR_MODEL_NOT_FOUND,
    ERROR_TIMEOUT,
    ERROR_UNEXPECTED_RESPONSE,
    ERROR_UNREACHABLE,
    model_error_category,
)
from animama.app.model_clients.probe import (
    PROBE_STEP_AVAILABLE,
    PROBE_STEP_EMBEDDINGS,
    PROBE_STEP_JSON_MODE,
    PROBE_STEP_STREAMING,
    PROBE_STEP_STRUCTURED_OUTPUT,
    PROBE_STEP_TOOL_CALLS,
    PROBE_STEP_TOOLS_WITH_STRUCTURED_OUTPUT,
    ModelConnectionProbeError,
    ModelProbeReport,
    ModelProbeStep,
)
from animama.app.model_connection_presets import PRESET_LLAMA_CPP, PRESET_LM_STUDIO, PRESET_OLLAMA
from animama.domain.model_connection import ModelConnection
from animama.logging import get_logger

from .connection_sdk import (
    CONNECT_TIMEOUT_SECONDS,
    connection_base_url,
    connection_timeout,
    keyless_request_headers,
    sdk_client_for_connection,
)
from .support import OPENAI_API, OPENAI_HTTP_PROVIDER_TYPE, resolve_openai_base_url

_log = get_logger("adapters.model_clients.openai_chat_completions.probe")

_MAX_LISTED_MODELS = 500
_CONTEXT_LOOKUP_TIMEOUT_SECONDS = 5.0
# A server that is down should fail fast even when loading a model may take minutes.
# Failures a probe step reports instead of raising: SDK errors, any transport
# error the SDK's HTTPX2 client raises unwrapped, and replies that are not
# OpenAI-compatible JSON.
_STEP_FAILURES: tuple[type[BaseException], ...] = (
    OpenAIError,
    httpx2.HTTPError,
    ValueError,
    TypeError,
    AttributeError,
    KeyError,
    IndexError,
)
# A failed first request says nothing about streaming support in these cases.
_UNDETERMINED_CATEGORIES = frozenset(
    {ERROR_UNREACHABLE, ERROR_TIMEOUT, ERROR_MODEL_NOT_FOUND, ERROR_CREDENTIAL_REJECTED}
)
_PROBE_TOOL_NAME = "record_answer"
_PROBE_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": _PROBE_TOOL_NAME,
        "description": "Record the requested answer.",
        "parameters": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}
_PROBE_SCHEMA: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "probe_answer",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
    },
}


class OpenAICompatibleConnectionProbe:
    """Probe models on any Chat Completions connection (and Responses on OpenAI)."""

    def __init__(
        self,
        *,
        credential_resolver: ModelCredentialResolver,
        openai_base_url: str | None = None,
        default_timeout: float | None = 60.0,
        http_transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self._credentials = credential_resolver
        self._openai_base_url = resolve_openai_base_url(openai_base_url)
        self._default_timeout = default_timeout
        self._http_transport = http_transport

    async def list_models(self, connection: ModelConnection) -> list[str]:
        """Return the model ids the connection reports through ``/v1/models``."""

        async with self._session(connection) as session:
            try:
                ids: list[str] = []
                async for item in session.client.models.list(extra_headers=session.extra_headers):
                    ids.append(str(item.id))
                    if len(ids) >= _MAX_LISTED_MODELS:
                        break
            except _STEP_FAILURES as exc:
                category, detail = _failure(exc, model="")
                if category == ERROR_MODEL_NOT_FOUND:
                    # A missing /models endpoint means the base URL points at the wrong path.
                    category, detail = ERROR_UNREACHABLE, "The server has no /models endpoint at this base URL."
                raise ModelConnectionProbeError(detail or "Could not list models", category=category) from exc
        return sorted(set(ids))

    async def probe_chat_model(self, connection: ModelConnection, *, model: str) -> ModelProbeReport:
        async with self._session(connection) as session:
            streaming = await self._streaming_step(session, model)
            steps = [streaming]
            if not streaming.ok:
                undetermined = streaming.category in _UNDETERMINED_CATEGORIES
                return ModelProbeReport(
                    model=model,
                    steps=tuple(steps),
                    supports_streaming=None if undetermined else False,
                )

            schema = await self._answer_step(
                session, model, PROBE_STEP_STRUCTURED_OUTPUT, response_format=_PROBE_SCHEMA
            )
            steps.append(schema)
            transport: str | None = STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA if schema.ok else None
            if not schema.ok:
                json_mode = await self._answer_step(
                    session,
                    model,
                    PROBE_STEP_JSON_MODE,
                    response_format={"type": "json_object"},
                    prompt='Return a JSON object with the key "answer" set to "ok".',
                )
                steps.append(json_mode)
                transport = STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT if json_mode.ok else None

            tools = await self._tool_step(session, model, PROBE_STEP_TOOL_CALLS, response_format=None)
            steps.append(tools)
            combined: bool | None = None
            if tools.ok and transport == STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA:
                combined_step = await self._tool_step(
                    session, model, PROBE_STEP_TOOLS_WITH_STRUCTURED_OUTPUT, response_format=_PROBE_SCHEMA
                )
                steps.append(combined_step)
                combined = combined_step.ok
            elif tools.ok:
                # JSON mode cannot constrain a tool round; treat it as separate rounds.
                combined = False

            context_window = await self._detect_context_window(session, model)
        return ModelProbeReport(
            model=model,
            steps=tuple(steps),
            supports_streaming=True,
            structured_output_transport=transport,
            supports_tools=tools.ok,
            tools_with_structured_output=combined,
            context_window_tokens=context_window,
        )

    async def probe_responses_model(self, connection: ModelConnection, *, model: str) -> ModelProbeReport:
        """Check that an OpenAI Responses model exists; its capabilities come from a template."""

        async with self._session(connection) as session:
            try:
                await session.client.models.retrieve(model)
                step = ModelProbeStep(name=PROBE_STEP_AVAILABLE, ok=True)
            except _STEP_FAILURES as exc:
                category, detail = _failure(exc, model=model)
                step = ModelProbeStep(name=PROBE_STEP_AVAILABLE, ok=False, category=category, detail=detail)
        return ModelProbeReport(
            model=model,
            steps=(step,),
            notes=("Responses capabilities are copied from the chosen built-in model.",),
        )

    async def probe_embedding_model(self, connection: ModelConnection, *, model: str) -> ModelProbeReport:
        async with self._session(connection) as session:
            try:
                response = await session.client.embeddings.create(
                    model=model,
                    input=["probe"],
                    # Matches the embedder: every OpenAI-compatible server accepts float.
                    encoding_format="float",
                    extra_headers=session.extra_headers,
                )
                vector = response.data[0].embedding if response.data else []
                dimensions = len(vector) if isinstance(vector, list) else None
                ok = bool(dimensions)
                step = ModelProbeStep(
                    name=PROBE_STEP_EMBEDDINGS,
                    ok=ok,
                    detail=None if ok else "The server returned no embedding vector.",
                )
            except _STEP_FAILURES as exc:
                category, detail = _failure(exc, model=model)
                step = ModelProbeStep(name=PROBE_STEP_EMBEDDINGS, ok=False, category=category, detail=detail)
                dimensions = None
        return ModelProbeReport(model=model, steps=(step,), embedding_dimensions=dimensions if step.ok else None)

    def _session(self, connection: ModelConnection) -> _ProbeSession:
        credential = self._credentials.resolve(connection)
        if not credential.usable:
            raise ModelConnectionProbeError(
                f"No key is configured for {connection.name}",
                category=ERROR_CREDENTIAL_MISSING,
            )
        try:
            base_url = connection_base_url(connection, openai_base_url=self._openai_base_url)
        except ModelClientProviderError as exc:
            raise ModelConnectionProbeError(str(exc), category=model_error_category(exc.code)) from exc
        seconds = connection.timeout_seconds if connection.timeout_seconds is not None else self._default_timeout
        timeout = connection_timeout(seconds) or httpx2.Timeout(None, connect=CONNECT_TIMEOUT_SECONDS)
        try:
            client = sdk_client_for_connection(connection, credential=credential, base_url=base_url, timeout=timeout)
        except (httpx2.InvalidURL, ValueError) as exc:
            raise ModelConnectionProbeError(
                "The connection's base URL is not valid", category=ERROR_INVALID_BASE_URL
            ) from exc
        return _ProbeSession(
            connection=connection,
            # A probe reports failures directly; SDK retries would only delay them.
            client=client.with_options(max_retries=0),
            owned_client=client,
            base_url=base_url,
            api_key=credential.api_key,
            extra_headers=keyless_request_headers(connection, credential),
            http_transport=self._http_transport,
        )

    async def _streaming_step(self, session: _ProbeSession, model: str) -> ModelProbeStep:
        try:
            stream = await _chat_create(
                session,
                **_request(session, model, "Reply with the single word: ok"),
                stream=True,
            )
            text_seen = False
            async for chunk in stream:
                for choice in chunk.choices or ():
                    if choice.delta is not None and choice.delta.content:
                        text_seen = True
            if not text_seen:
                return ModelProbeStep(
                    name=PROBE_STEP_STREAMING,
                    ok=False,
                    category=ERROR_UNEXPECTED_RESPONSE,
                    detail="The stream returned no text.",
                )
            return ModelProbeStep(name=PROBE_STEP_STREAMING, ok=True)
        except _STEP_FAILURES as exc:
            category, detail = _failure(exc, model=model)
            return ModelProbeStep(name=PROBE_STEP_STREAMING, ok=False, category=category, detail=detail)

    async def _answer_step(
        self,
        session: _ProbeSession,
        model: str,
        name: str,
        *,
        response_format: Mapping[str, Any],
        prompt: str = 'Set "answer" to "ok".',
    ) -> ModelProbeStep:
        try:
            completion = await _chat_create(
                session,
                **_request(session, model, prompt),
                response_format=dict(response_format),
            )
            content = completion.choices[0].message.content if completion.choices else None
            answer = _json_answer(content)
            if answer is None:
                return ModelProbeStep(name=name, ok=False, detail="The reply was not the requested JSON object.")
            return ModelProbeStep(name=name, ok=True)
        except _STEP_FAILURES as exc:
            category, detail = _failure(exc, model=model)
            return ModelProbeStep(name=name, ok=False, category=category, detail=detail)

    async def _tool_step(
        self,
        session: _ProbeSession,
        model: str,
        name: str,
        *,
        response_format: Mapping[str, Any] | None,
    ) -> ModelProbeStep:
        tool = _tool_for_connection(session.connection)
        extra: dict[str, Any] = {"tools": [tool], "tool_choice": "auto"}
        # OpenAI refuses tools at the default effort from GPT-5.4 on; chat requests send the same effort.
        effort = chat_completions_function_tool_effort(model, session.connection.compatibility)
        if effort is not None:
            extra["reasoning_effort"] = effort
        if response_format is not None:
            extra["response_format"] = dict(response_format)
        try:
            completion = await _chat_create(
                session,
                **_request(session, model, f'Call the {_PROBE_TOOL_NAME} tool with answer set to "ok".'),
                **extra,
            )
            calls = completion.choices[0].message.tool_calls if completion.choices else None
            if not calls or not any(
                getattr(getattr(call, "function", None), "name", None) == _PROBE_TOOL_NAME for call in calls
            ):
                return ModelProbeStep(name=name, ok=False, detail="The model did not call the tool.")
            return ModelProbeStep(name=name, ok=True)
        except _STEP_FAILURES as exc:
            category, detail = _failure(exc, model=model)
            return ModelProbeStep(name=name, ok=False, category=category, detail=detail)

    async def _detect_context_window(self, session: _ProbeSession, model: str) -> int | None:
        root = session.base_url.removesuffix("/v1")
        preset = session.connection.preset
        headers = {"Authorization": f"Bearer {session.api_key}"} if session.api_key else {}
        try:
            async with httpx2.AsyncClient(
                timeout=_CONTEXT_LOOKUP_TIMEOUT_SECONDS,
                transport=session.http_transport,
                headers=headers,
            ) as http:
                if preset == PRESET_LLAMA_CPP:
                    payload = (await http.get(f"{root}/props")).json()
                    settings = payload.get("default_generation_settings") if isinstance(payload, dict) else None
                    return _positive_int((settings or {}).get("n_ctx")) or _positive_int(payload.get("n_ctx"))
                if preset == PRESET_OLLAMA:
                    payload = (await http.get(f"{root}/api/ps")).json()
                    loaded = payload.get("models") if isinstance(payload, dict) else None
                    for item in loaded if isinstance(loaded, list) else ():
                        if isinstance(item, dict) and model in {item.get("name"), item.get("model")}:
                            return _positive_int(item.get("context_length"))
                    return None
                if preset == PRESET_LM_STUDIO:
                    payload = (await http.get(f"{root}/api/v0/models/{model}")).json()
                    # max_context_length is the model maximum, not the served window.
                    return _positive_int(payload.get("loaded_context_length")) if isinstance(payload, dict) else None
        except (httpx2.HTTPError, ValueError, AttributeError) as exc:
            _log.info("Model context window lookup unavailable", preset=preset, error_type=exc.__class__.__name__)
        return None


class _ProbeSession:
    """One probe's SDK client, closed when the probe ends."""

    def __init__(
        self,
        *,
        connection: ModelConnection,
        client: AsyncOpenAI,
        owned_client: AsyncOpenAI,
        base_url: str,
        api_key: str | None,
        extra_headers: dict[str, Any] | None,
        http_transport: httpx2.AsyncBaseTransport | None,
    ) -> None:
        self.connection = connection
        self.client = client
        self._owned_client = owned_client
        self.base_url = base_url
        self.api_key = api_key
        self.extra_headers = extra_headers
        self.http_transport = http_transport

    async def __aenter__(self) -> _ProbeSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self._owned_client.close()


async def _chat_create(session: _ProbeSession, **kwargs: Any) -> Any:
    # Probe requests are built as plain dicts; the SDK overloads cannot type them.
    completions: Any = session.client.chat.completions
    return await completions.create(**kwargs)


def _request(session: _ProbeSession, model: str, prompt: str) -> dict[str, Any]:
    request: dict[str, Any] = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    if session.extra_headers is not None:
        request["extra_headers"] = session.extra_headers
    return request


def _tool_for_connection(connection: ModelConnection) -> dict[str, Any]:
    if not connection.compatibility.strip_function_strict:
        return _PROBE_TOOL
    function = {key: value for key, value in _PROBE_TOOL["function"].items() if key != "strict"}
    return {**_PROBE_TOOL, "function": function}


def _json_answer(content: object) -> str | None:
    if not isinstance(content, str):
        return None
    try:
        payload = json.loads(content)
    except ValueError:
        return None
    answer = payload.get("answer") if isinstance(payload, dict) else None
    return answer if isinstance(answer, str) else None


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _failure(exc: BaseException, *, model: str) -> tuple[str, str | None]:
    if isinstance(exc, OpenAIError):
        info = classify_openai_exception(exc, api=OPENAI_API, provider_type=OPENAI_HTTP_PROVIDER_TYPE, model=model)
        detail = info.metadata.get("provider_error_message")
        return model_error_category(info.code), detail if isinstance(detail, str) else None
    if isinstance(exc, httpx2.TimeoutException):
        return ERROR_TIMEOUT, "The server did not answer before the connection timeout."
    if isinstance(exc, httpx2.HTTPError):
        return ERROR_UNREACHABLE, "The connection to the server failed."
    _log.info("Model probe received an unexpected response", error_type=exc.__class__.__name__)
    return ERROR_UNEXPECTED_RESPONSE, "The server's reply was not an OpenAI-compatible response."


__all__ = ["OpenAICompatibleConnectionProbe"]
