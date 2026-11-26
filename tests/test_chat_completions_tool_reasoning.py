"""OpenAI Chat Completions function tools on GPT-5.4 and later need reasoning effort ``none`` (#932).

OpenAI refuses function tools on these models with any other effort, and with
an omitted effort, because the model's default (``medium`` on ``gpt-6-luna``)
then applies.
"""

from __future__ import annotations

from typing import Any

import httpx2
import pytest

from animama.adapters.model_clients.openai_chat_completions.probe import OpenAICompatibleConnectionProbe
from animama.adapters.model_clients.openai_chat_completions.request import create_chat_completion_kwargs
from animama.app.model_catalog import chat_completions_function_tool_effort, chat_completions_tools_require_no_reasoning
from animama.app.model_clients import DirectChatPrompt, ModelClientRequest
from animama.app.model_clients.credentials import static_credential_resolver
from animama.domain import ModelProvider, ModelProviderCapabilities
from animama.domain.model_connection import (
    REASONING_MODE_DEEPSEEK_THINKING,
    REASONING_MODE_OMIT,
    ModelConnection,
    ModelConnectionCompatibility,
)
from tests.test_model_connection_probe import _Server, sdk_transport  # noqa: F401 (fixture)

_TOOL = {
    "type": "function",
    "function": {
        "name": "memory_list_files",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        "strict": True,
    },
}


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("gpt-5.4", True),
        ("gpt-5.4-mini", True),
        ("gpt-5.4-2026-03-05", True),
        ("gpt-5.6-terra", True),
        ("gpt-6", True),
        ("gpt-6-luna", True),
        ("gpt-5-nano", False),
        ("gpt-5.1", False),
        ("gpt-4.1", False),
        ("gpt-4o", False),
        ("gpt-oss-20b", False),
        ("openai/gpt-6-luna", False),
        ("qwen3:8b", False),
    ],
)
def test_the_rule_covers_openai_models_from_gpt_5_4(model: str, expected: bool) -> None:
    assert chat_completions_tools_require_no_reasoning(model) is expected


@pytest.mark.parametrize(
    ("model", "reasoning_mode", "expected"),
    [
        ("gpt-6-luna", "openai_effort", "none"),
        ("gpt-6-luna", REASONING_MODE_OMIT, None),
        ("gpt-6-luna", REASONING_MODE_DEEPSEEK_THINKING, None),
        ("gpt-5-nano", "openai_effort", None),
    ],
)
def test_the_tool_effort_follows_the_connection_reasoning_mode(
    model: str, reasoning_mode: str, expected: str | None
) -> None:
    compatibility = ModelConnectionCompatibility(reasoning_mode=reasoning_mode)

    assert chat_completions_function_tool_effort(model, compatibility) == expected


# ------------------------------------------------------------------ request


def _request(
    *,
    model: str = "gpt-6-luna",
    tools: tuple[Any, ...] = (_TOOL,),
    reasoning_effort: str | None = None,
    reasoning_mode: str = "openai_effort",
) -> ModelClientRequest:
    connection = ModelConnection(
        id="conn-test",
        name="Test",
        preset="custom",
        base_url="https://models.example.test/v1",
        compatibility=ModelConnectionCompatibility(reasoning_mode=reasoning_mode),
    )
    provider = ModelProvider(
        id=f"OpenAIHTTPAgent:{model}",
        provider_type="OpenAIHTTPAgent",
        model=model,
        model_label=model,
        provider_label="Test",
        connection_id=connection.id,
        connection=connection,
        capabilities=ModelProviderCapabilities(supports_tools=True, supports_streaming=True),
    )
    return ModelClientRequest(
        model_provider=provider,
        prompt=DirectChatPrompt(
            messages=({"role": "user", "content": "Hello"},),
            tools=tools,
            reasoning_effort=reasoning_effort,  # type: ignore[arg-type]
        ),
    )


def _sent_effort(request: ModelClientRequest) -> str | None:
    effort: str | None = create_chat_completion_kwargs(request, timeout=None).get("reasoning_effort")
    return effort


def test_a_request_with_tools_and_no_effort_sends_none() -> None:
    assert _sent_effort(_request()) == "none"


def test_a_chosen_effort_is_sent_as_chosen() -> None:
    # Direct chat setup refuses other efforts with memory tools before a request is built.
    assert _sent_effort(_request(reasoning_effort="none")) == "none"
    assert _sent_effort(_request(reasoning_effort="low")) == "low"


@pytest.mark.parametrize(
    "request_",
    [
        pytest.param(_request(tools=()), id="no tools"),
        pytest.param(_request(model="gpt-5-nano"), id="model before gpt-5.4"),
        pytest.param(_request(model="qwen3:8b"), id="other server's model"),
        pytest.param(_request(reasoning_mode=REASONING_MODE_OMIT), id="reasoning mode omit"),
    ],
)
def test_other_requests_keep_sending_no_effort(request_: ModelClientRequest) -> None:
    assert _sent_effort(request_) is None


# -------------------------------------------------------------------- probe


class _OpenAIServer(_Server):
    """Refuses function tools as OpenAI does for GPT-5.4 and later, unless the effort is none."""

    def _chat(self, body: dict[str, Any]) -> httpx2.Response:
        if body.get("tools") and body.get("reasoning_effort") != "none":
            message = (
                f"Function tools with reasoning_effort are not supported for {body['model']} in "
                "/v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."
            )
            return httpx2.Response(
                400,
                json={"error": {"message": message, "type": "invalid_request_error", "param": "reasoning_effort"}},
            )
        return super()._chat(body)


def _openai_connection() -> ModelConnection:
    return ModelConnection(
        id="conn-openai-direct", name="OpenAI", preset="custom", base_url="https://api.openai.com/v1"
    )


def _probe(server: _Server) -> OpenAICompatibleConnectionProbe:
    return OpenAICompatibleConnectionProbe(
        credential_resolver=static_credential_resolver({"OPENAI_API_KEY": "sk-openai"}),
        http_transport=httpx2.MockTransport(server),
    )


async def test_the_probe_finds_tool_calling_on_gpt_6_luna(sdk_transport):  # noqa: F811
    server = _OpenAIServer()
    sdk_transport(server)

    report = await _probe(server).probe_chat_model(_openai_connection(), model="gpt-6-luna")

    assert report.supports_tools is True
    tool_requests = [body for _method, _path, body in server.requests if body and body.get("tools")]
    assert tool_requests
    assert all(body["reasoning_effort"] == "none" for body in tool_requests)


async def test_the_probe_sends_no_effort_for_other_models(sdk_transport):  # noqa: F811
    server = _Server()
    sdk_transport(server)

    await _probe(server).probe_chat_model(_openai_connection(), model="gpt-5-nano")

    assert all("reasoning_effort" not in body for _method, _path, body in server.requests if body)
