"""The provider-neutral tool-round helpers shared by chat and other tool loops."""

from __future__ import annotations

import subprocess
import sys
from typing import Any

import pytest

from animama.adapters.model_clients.openai_errors import OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE
from animama.app.chat.direct_turn import message_builders, model_stream, provider_state
from animama.app.model_clients import (
    DirectChatPrompt,
    ModelClientContinuation,
    ModelClientFinal,
    ModelClientProviderError,
    ModelClientProviderOptions,
    ModelClientRequest,
    ModelClientToolCall,
    ModelClientToolResult,
    tool_rounds,
)
from animama.app.model_clients.image_parts import ModelClientImage, image_part
from animama.app.model_clients.prompt import prompt_messages
from animama.domain import ModelProvider

RESPONSES = "OpenAIResponsesHTTPAgent"
CHAT_COMPLETIONS = "OpenAIHTTPAgent"
ANTHROPIC = "AnthropicMessagesHTTPAgent"
CHATGPT_PLAN = "ChatGPTPlanResponsesHTTPAgent"

CALL = ModelClientToolCall(id="call-1", name="submit_draft", arguments='{"name":"Wave"}')
RESULT = ModelClientToolResult(call_id="call-1", tool_type="function", status="completed", output='{"ok":true}')
SHEET = ModelClientImage(media_type="image/jpeg", content=b"sheet")


def _request(provider_type: str, **options: Any) -> ModelClientRequest:
    provider = ModelProvider(
        id=f"{provider_type}:tool-test",
        provider_type=provider_type,
        model="tool-test",
        model_label="tool-test",
        provider_label="Test",
    )
    user = {
        "role": "user",
        "content": [
            image_part(file_id="sheet", name="sheet.jpg", width=880, height=1980),
            {"type": "text", "text": "Review the frames."},
        ],
    }
    return ModelClientRequest(
        model_provider=provider,
        prompt=DirectChatPrompt(messages=({"role": "system", "content": "Author a Gesture."}, user)),
        images={"sheet": SHEET},
        **options,
    )


def _exchange(provider_type: str) -> list[dict[str, Any]]:
    return tool_rounds.tool_exchange_prompt_items(
        model_request=_request(provider_type), tool_calls=(CALL,), tool_results=(RESULT,)
    )


def test_responses_exchange_is_a_call_item_then_its_result_item() -> None:
    assert _exchange(RESPONSES) == [
        {
            "type": "model_client_tool_call",
            "call_id": "call-1",
            "tool_type": "function",
            "name": "submit_draft",
            "arguments": '{"name":"Wave"}',
        },
        {
            "type": "model_client_tool_result",
            "call_id": "call-1",
            "tool_type": "function",
            "status": "completed",
            "output": '{"ok":true}',
        },
    ]


def test_anthropic_exchange_is_a_tool_use_item_then_its_tool_result_item() -> None:
    assert _exchange(ANTHROPIC) == [
        {"type": "anthropic_tool_use", "id": "call-1", "name": "submit_draft", "input": {"name": "Wave"}},
        {"type": "anthropic_tool_result", "tool_use_id": "call-1", "content": '{"ok":true}'},
    ]


@pytest.mark.parametrize("provider_type", [CHAT_COMPLETIONS, CHATGPT_PLAN])
def test_other_providers_get_an_assistant_call_message_and_one_tool_message_per_result(provider_type: str) -> None:
    assert _exchange(provider_type) == [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "submit_draft", "arguments": '{"name":"Wave"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": '{"ok":true}'},
    ]


def test_an_exchange_needs_one_result_per_call() -> None:
    with pytest.raises(ValueError):
        tool_rounds.tool_exchange_prompt_items(
            model_request=_request(CHAT_COMPLETIONS), tool_calls=(CALL,), tool_results=()
        )


def test_next_round_request_appends_the_exchange_and_keeps_the_prompt_settings() -> None:
    request = _request(CHAT_COMPLETIONS)
    exchange = _exchange(CHAT_COMPLETIONS)

    following = tool_rounds.model_request_with_appended_messages(request, exchange)

    assert prompt_messages(following.prompt) == [*prompt_messages(request.prompt), *exchange]
    assert following.model_provider is request.model_provider
    assert following.limits is request.limits
    assert following.continuation is None


def test_next_round_request_advances_a_responses_cursor_to_the_tool_call_response() -> None:
    request = _request(RESPONSES)
    final = ModelClientFinal(text="", tool_calls=(CALL,), raw_provider_metadata={"response_id": " resp_2 "})

    following = tool_rounds.model_request_with_appended_messages(request, _exchange(RESPONSES), previous_final=final)

    assert following.continuation == ModelClientContinuation(
        provider_type=RESPONSES, cursor="resp_2", metadata={"source": "tool_call_response", "model": "tool-test"}
    )


@pytest.mark.parametrize(("continuation_provider", "kept"), [(ANTHROPIC, True), (RESPONSES, False)])
def test_next_round_request_carries_only_the_same_providers_own_continuation(
    continuation_provider: str, kept: bool
) -> None:
    continuation = ModelClientContinuation(provider_type=continuation_provider, cursor="blocks")
    final = ModelClientFinal(text="", tool_calls=(CALL,), continuation=continuation)

    following = tool_rounds.model_request_with_appended_messages(
        _request(ANTHROPIC), _exchange(ANTHROPIC), previous_final=final
    )

    assert following.continuation == (continuation if kept else None)


def test_next_round_request_asks_for_moderation_on_the_first_round_only() -> None:
    request = _request(RESPONSES, provider_options=ModelClientProviderOptions(moderation_model="omni", store=False))

    following = tool_rounds.model_request_with_appended_messages(request, _exchange(RESPONSES))

    assert following.provider_options == ModelClientProviderOptions(moderation_model=None, store=False)


def test_next_round_request_drops_the_image_bytes_unless_asked_to_keep_them() -> None:
    # Chat fills the bytes again just before each dispatch, so its rounds start without them.
    request = _request(CHATGPT_PLAN)

    dropped = tool_rounds.model_request_with_appended_messages(request, _exchange(CHATGPT_PLAN))
    kept = tool_rounds.model_request_with_appended_messages(request, _exchange(CHATGPT_PLAN), keep_images=True)

    assert dropped.images == {}
    assert kept.images == {"sheet": SHEET}
    assert prompt_messages(kept.prompt) == prompt_messages(dropped.prompt)


def test_the_chat_turn_uses_the_shared_helpers() -> None:
    """One definition each: chat's tool loop and its builders are the shared module's."""

    for name in ("tool_exchange_prompt_items", "model_request_with_appended_messages"):
        assert getattr(model_stream, name) is getattr(tool_rounds, name), name
    for name in (
        "anthropic_tool_result_item",
        "anthropic_tool_use_item",
        "assistant_tool_call_prompt_message",
        "model_client_tool_call_prompt_item",
        "model_client_tool_result_prompt_item",
        "tool_result_prompt_message",
    ):
        assert getattr(message_builders, name) is getattr(tool_rounds, name), name
    for name in (
        "continuation_after_tool_round",
        "openai_responses_continuation_from_final",
        "model_request_without_continuation",
        "should_retry_without_previous_response_id",
    ):
        assert getattr(provider_state, name) is getattr(tool_rounds, name), name


CURSOR = ModelClientContinuation(provider_type=RESPONSES, cursor="resp_1")


def _stale(code: str = tool_rounds.OPENAI_RESPONSES_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE) -> ModelClientProviderError:
    return ModelClientProviderError("The previous response could not be resolved", code=code)


def test_a_request_without_its_continuation_sends_the_whole_prompt_again() -> None:
    request = _request(RESPONSES, continuation=CURSOR, provider_options=ModelClientProviderOptions(store=False))

    dropped = tool_rounds.model_request_without_continuation(request)
    kept = tool_rounds.model_request_without_continuation(request, keep_images=True)

    for replay in (dropped, kept):
        assert replay.continuation is None
        assert replay.prompt is request.prompt and replay.model_provider is request.model_provider
        assert replay.provider_options == request.provider_options
    # Chat fills the bytes again before each dispatch; a caller that put them on the request keeps them.
    assert dropped.images == {} and kept.images == {"sheet": SHEET}


def test_only_a_responses_request_that_named_a_stored_response_is_replayed() -> None:
    def replayed(request: ModelClientRequest, error: ModelClientProviderError, **flags: bool) -> bool:
        options = {"partial_text_seen": False, "allow_previous_response_retry": True, **flags}
        return tool_rounds.should_retry_without_previous_response_id(error, request, **options)

    stale_request = _request(RESPONSES, continuation=CURSOR)
    assert replayed(stale_request, _stale())
    # The adapters raise the code this module reads.
    assert (
        tool_rounds.OPENAI_RESPONSES_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE == OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE
    )
    # Never a second time, never once text of the reply was seen, and never for another failure.
    assert not replayed(stale_request, _stale(), allow_previous_response_retry=False)
    assert not replayed(stale_request, _stale(), partial_text_seen=True)
    assert not replayed(stale_request, _stale("openai_rate_limit"))
    # A request that named no response, or another provider's, has nothing to drop.
    assert not replayed(_request(RESPONSES), _stale())
    for provider_type in (CHAT_COMPLETIONS, ANTHROPIC, CHATGPT_PLAN):
        other = ModelClientContinuation(provider_type=provider_type, cursor="blocks")
        assert not replayed(_request(provider_type, continuation=other), _stale())


def test_the_shared_helpers_do_not_import_the_chat_turn() -> None:
    probe = (
        "import sys\n"
        "from animama.app.model_clients import tool_rounds\n"
        "leaked = sorted(m for m in sys.modules if m == 'animama.app.chat' or m.startswith('animama.app.chat.'))\n"
        "assert not leaked, leaked\n"
    )
    subprocess.run([sys.executable, "-c", probe], check=True)
