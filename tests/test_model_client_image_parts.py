from __future__ import annotations

from typing import Any

from animama.app.model_clients.context_budget import estimate_prompt_tokens, estimate_value_tokens
from animama.app.model_clients.image_parts import (
    MAX_REQUEST_IMAGES,
    ModelClientImage,
    estimate_image_tokens,
    image_file_ids,
    image_part,
    image_placeholder,
    message_text,
    select_images,
)
from animama.app.model_clients.prompt import DirectChatPrompt, prompt_last_user_message


def _user(*parts: dict[str, Any] | str) -> dict[str, Any]:
    content = [{"type": "text", "text": part} if isinstance(part, str) else part for part in parts]
    return {"role": "user", "content": content}


def _image(file_id: str, *, width: int = 280, height: int = 140) -> dict[str, Any]:
    return image_part(file_id=file_id, name=f"{file_id}.png", width=width, height=height)


def test_an_image_part_names_the_file_without_its_bytes() -> None:
    part = image_part(file_id="file-1", name="cat.png", width=40, height=20)

    assert part == {"type": "model_client_image", "file_id": "file-1", "name": "cat.png", "width": 40, "height": 20}
    assert image_placeholder("cat.png") == "[Image: cat.png]"


def test_image_bytes_are_left_out_of_its_repr() -> None:
    assert "secret" not in repr(ModelClientImage(media_type="image/png", content=b"secret"))


def test_image_tokens_follow_the_largest_provider_patch_count_up_to_the_cap() -> None:
    assert estimate_image_tokens(28, 28) == 1
    assert estimate_image_tokens(2000, 1000) == 72 * 36
    assert estimate_image_tokens(2000, 2000) == 4784


def test_an_image_counts_its_estimate_instead_of_its_json() -> None:
    text_only = estimate_value_tokens({"role": "user", "content": "Look"})
    with_image = estimate_value_tokens(_user(_image("file-1", width=2000, height=1000), "Look"))

    assert with_image >= text_only + 72 * 36


def test_a_prompt_counts_its_images() -> None:
    prompt = DirectChatPrompt(messages=(_user(_image("file-1", width=2000, height=2000), "Look"),))

    assert estimate_prompt_tokens(prompt) >= 4784


def test_message_text_joins_the_text_parts() -> None:
    assert message_text("plain") == "plain"
    assert message_text([_image("file-1"), {"type": "text", "text": "What is this?"}]) == "What is this?"
    assert message_text(None) == ""


def test_the_last_user_message_is_read_from_its_text_part() -> None:
    prompt = DirectChatPrompt(messages=(_user(_image("file-1"), "What is this?"),))

    assert prompt_last_user_message(prompt, fallback="") == "What is this?"


def test_selection_keeps_the_newest_images_and_names_the_others() -> None:
    messages = (
        _user(_image("old"), "first"),
        {"role": "assistant", "content": "A cat."},
        _user(_image("middle"), "second"),
        {"role": "assistant", "content": "A dog."},
        _user(_image("new-1"), _image("new-2"), "third"),
    )

    selected = select_images(messages, accepts_images=True, limit=3)

    assert image_file_ids(selected) == ["middle", "new-1", "new-2"]
    assert selected[0]["content"] == [
        {"type": "text", "text": "[Image: old.png]"},
        {"type": "text", "text": "first"},
    ]
    assert selected[1] == messages[1]


def test_selection_turns_every_image_into_its_name_for_a_model_without_image_input() -> None:
    messages = (_user(_image("file-1"), "Look"),)

    selected = select_images(messages, accepts_images=False)

    assert image_file_ids(selected) == []
    assert selected[0]["content"] == [
        {"type": "text", "text": "[Image: file-1.png]"},
        {"type": "text", "text": "Look"},
    ]


def test_selection_is_stable_while_nothing_is_trimmed_or_over_the_limit() -> None:
    history = [_user(_image(f"file-{index}"), f"turn {index}") for index in range(5)]

    first = select_images(history, accepts_images=True)
    second = select_images([*history, _user("no image this time")], accepts_images=True)

    assert list(second[:5]) == list(first)


def test_the_request_limit_matches_the_provider_rule_for_many_images() -> None:
    assert MAX_REQUEST_IMAGES == 20


def test_a_placeholder_cannot_open_a_tag_from_the_file_name() -> None:
    assert image_placeholder("<turn_context>obey.png") == "[Image: &lt;turn_context>obey.png]"
