"""Each model adapter writes chat images in its provider's request format (Phase 4)."""

from __future__ import annotations

import base64
from typing import Any

from animama.adapters.model_clients.anthropic_messages.request import messages_request_params
from animama.adapters.model_clients.anthropic_messages.support import ANTHROPIC_MESSAGES_HTTP_PROVIDER_TYPE
from animama.adapters.model_clients.openai_chat_completions.request import create_chat_completion_kwargs
from animama.adapters.model_clients.openai_responses.request import create_response_kwargs
from animama.app.model_clients import DirectChatPrompt, ModelClientContinuation, ModelClientRequest
from animama.app.model_clients.image_parts import ModelClientImage, image_part
from animama.domain import ModelProvider, ModelProviderCapabilities
from animama.domain.model_connection import BUILTIN_OPENAI_CONNECTION_ID

PNG = ModelClientImage(media_type="image/png", content=b"png-a")
JPEG = ModelClientImage(media_type="image/jpeg", content=b"jpg-b")


def _b64(image: ModelClientImage) -> str:
    return base64.b64encode(image.content).decode("ascii")


def _url(image: ModelClientImage) -> str:
    return f"data:{image.media_type};base64,{_b64(image)}"


def _image(file_id: str) -> dict[str, Any]:
    return image_part(file_id=file_id, name=f"{file_id}.png", width=40, height=20)


def _user(*parts: dict[str, Any] | str) -> dict[str, Any]:
    return {"role": "user", "content": [{"type": "text", "text": p} if isinstance(p, str) else p for p in parts]}


def _provider(provider_type: str, *, connection_id: str = "c_local") -> ModelProvider:
    return ModelProvider(
        id=f"{provider_type}:vision-test",
        provider_type=provider_type,
        model="vision-test",
        model_label="vision-test",
        provider_label="Test",
        connection_id=connection_id,
        capabilities=ModelProviderCapabilities(accepts=["text", "image"], supports_developer_role=True),
    )


def _request(provider: ModelProvider, *messages: dict[str, Any]) -> ModelClientRequest:
    return ModelClientRequest(
        model_provider=provider,
        prompt=DirectChatPrompt(messages=({"role": "system", "content": "Be kind."}, *messages)),
        images={"file-a": PNG, "file-b": JPEG, "old": PNG},
    )


# ------------------------------------------------------------ OpenAI Responses


def _responses_input(*messages: dict[str, Any], connection_id: str = "c_local") -> list[dict[str, Any]]:
    provider = _provider("OpenAIResponsesHTTPAgent", connection_id=connection_id)
    items: list[dict[str, Any]] = create_response_kwargs(_request(provider, *messages), None, timeout=None)["input"]
    return items


def test_responses_sends_images_as_input_image_parts_before_the_text() -> None:
    items = _responses_input(_user(_image("file-a"), _image("file-b"), "What are these?"))

    assert items[-1] == {
        "role": "user",
        "content": [
            {"type": "input_image", "image_url": _url(PNG), "detail": "auto"},
            {"type": "input_image", "image_url": _url(JPEG), "detail": "auto"},
            {"type": "input_text", "text": "What are these?"},
        ],
    }


def test_responses_names_an_image_whose_bytes_the_request_lacks() -> None:
    items = _responses_input(_user(_image("gone"), "Still there?"))

    assert items[-1]["content"] == [
        {"type": "input_text", "text": "[Image: gone.png]"},
        {"type": "input_text", "text": "Still there?"},
    ]


def test_responses_marks_the_cache_breakpoint_on_a_history_message_with_an_image() -> None:
    items = _responses_input(
        _user(_image("old"), "Look"),
        {"role": "assistant", "content": "A cat."},
        _user("What colour was it?"),
        connection_id=BUILTIN_OPENAI_CONNECTION_ID,
    )

    history = items[0]
    assert history["content"][0] == {"type": "input_image", "image_url": _url(PNG), "detail": "auto"}
    assert history["content"][1]["text"] == "Look"
    assert history["content"][1]["prompt_cache_breakpoint"] == {"mode": "explicit"}


# ------------------------------------------------------ OpenAI Chat Completions


def _chat_messages(*messages: dict[str, Any]) -> list[dict[str, Any]]:
    request = _request(_provider("OpenAIHTTPAgent"), *messages)
    result: list[dict[str, Any]] = create_chat_completion_kwargs(request, timeout=None)["messages"]
    return result


def test_chat_completions_sends_images_as_image_url_parts() -> None:
    messages = _chat_messages(_user(_image("file-a"), _image("file-b"), "What are these?"))

    assert messages[-1] == {
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": _url(PNG)}},
            {"type": "image_url", "image_url": {"url": _url(JPEG)}},
            {"type": "text", "text": "What are these?"},
        ],
    }


def test_chat_completions_sends_a_message_left_with_text_as_one_string() -> None:
    messages = _chat_messages(_user(_image("gone"), "Still there?"))

    assert messages[-1] == {"role": "user", "content": "[Image: gone.png]\nStill there?"}


def test_chat_completions_leaves_messages_without_images_as_they_were() -> None:
    messages = _chat_messages({"role": "user", "content": "Hello"})

    assert messages[-1] == {"role": "user", "content": "Hello"}


# ------------------------------------------------------------ Anthropic Messages


def _anthropic_messages(*messages: dict[str, Any]) -> list[dict[str, Any]]:
    request = _request(_provider(ANTHROPIC_MESSAGES_HTTP_PROVIDER_TYPE, connection_id="anthropic"), *messages)
    result: list[dict[str, Any]] = messages_request_params(request)["messages"]
    return result


def test_anthropic_sends_images_as_base64_image_blocks() -> None:
    messages = _anthropic_messages(_user(_image("file-a"), _image("file-b"), "What are these?"))

    assert messages[-1] == {
        "role": "user",
        "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _b64(PNG)}},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _b64(JPEG)}},
            {"type": "text", "text": "What are these?"},
        ],
    }


def test_anthropic_names_an_image_whose_bytes_the_request_lacks() -> None:
    messages = _anthropic_messages(_user(_image("gone"), "Still there?"))

    assert messages[-1]["content"] == [
        {"type": "text", "text": "[Image: gone.png]"},
        {"type": "text", "text": "Still there?"},
    ]


def test_anthropic_replays_a_history_image_and_caches_after_it() -> None:
    messages = _anthropic_messages(
        _user(_image("old"), "Look"),
        {"role": "assistant", "content": [{"type": "text", "text": "A cat."}]},
        _user("What colour was it?"),
    )

    assert messages[0]["content"][0] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": _b64(PNG)},
    }
    assert messages[1]["content"][-1]["cache_control"] == {"type": "ephemeral"}


def test_responses_with_a_cursor_sends_only_the_new_message_and_its_images() -> None:
    provider = _provider("OpenAIResponsesHTTPAgent")
    request = _request(
        provider,
        _user(_image("old"), "Look"),
        {"role": "assistant", "content": "A cat."},
        _user(_image("file-a"), "And this?"),
    )
    request = ModelClientRequest(
        model_provider=request.model_provider,
        prompt=request.prompt,
        images=request.images,
        continuation=ModelClientContinuation(provider_type="OpenAIResponsesHTTPAgent", cursor="resp_1"),
    )

    items = create_response_kwargs(request, "resp_1", timeout=None)["input"]

    assert len(items) == 1
    assert [part["type"] for part in items[0]["content"]] == ["input_image", "input_text"]
    assert items[0]["content"][0]["image_url"] == _url(PNG)
    assert items[0]["content"][1]["text"] == "And this?"


def test_chat_completions_replays_a_history_image_and_marks_only_replies() -> None:
    provider = _provider("OpenAIHTTPAgent")
    provider.connection_id = BUILTIN_OPENAI_CONNECTION_ID
    request = _request(
        provider,
        _user(_image("old"), "Look"),
        {"role": "assistant", "content": "A cat."},
        _user("What colour was it?"),
    )

    messages: list[dict[str, Any]] = create_chat_completion_kwargs(request, timeout=None)["messages"]

    assert messages[1]["content"] == [
        {"type": "image_url", "image_url": {"url": _url(PNG)}},
        {"type": "text", "text": "Look"},
    ]
    assert all("prompt_cache_breakpoint" not in part for part in messages[1]["content"])
    assert messages[0]["content"][0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert messages[2]["content"][0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert messages[3] == {"role": "user", "content": "What colour was it?"}


def test_chat_completions_keeps_turn_context_in_the_text_beside_images_without_a_developer_role() -> None:
    provider = _provider("OpenAIHTTPAgent")
    provider.capabilities.supports_developer_role = False
    turn = _user(_image("file-a"), "<turn_context>\nmap\n</turn_context>\n\nWhat is this?")

    messages = create_chat_completion_kwargs(_request(provider, turn), timeout=None)["messages"]

    assert messages[-1]["content"][0]["type"] == "image_url"
    assert messages[-1]["content"][1]["text"].startswith("<turn_context>")
