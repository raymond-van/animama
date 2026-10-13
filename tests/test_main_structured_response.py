from __future__ import annotations

from typing import Any, cast

import pytest
from pydantic import ValidationError

from animama.app.main_structured_response import (
    MAIN_STRUCTURED_RESPONSE_PART_DISPLAY,
    MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE,
    MAIN_STRUCTURED_RESPONSE_PART_SPEECH,
    MainStructuredJsonStreamParser,
    build_main_response_model,
    build_main_structured_output_schema,
    build_main_structured_prompt,
    build_main_structured_response_json_schema,
    parse_main_structured_response,
    render_main_structured_json,
    validate_main_emotional_intensity,
    validate_main_structured_gesture,
)
from animama.app.voice_emotional_tone import ELEVENLABS_EMOTIONAL_TONE_VALUES
from animama.product_http.chat.options import merge_chat_request_options
from animama.product_http.chat.tts import FinalizedTtsStreamBootstrap

TEST_RUNTIME_GESTURE_IDS = ("wave", "thoughtful_pose")


def _stream_event_tuples(events):
    return [
        (
            event.response_part,
            event.text,
            event.is_delta,
            event.part_index,
            event.part_final,
            event.emotional_intensity,
        )
        for event in events
    ]


def test_merge_chat_request_options_includes_main_structured_response() -> None:
    merged = merge_chat_request_options(
        request_opts={"main_structured_response": True},
        user_prefs=None,
        anima_prefs=None,
    )

    assert merged["main_structured_response"] is True


def test_merge_chat_request_options_includes_native_tools_and_reasoning_effort() -> None:
    merged = merge_chat_request_options(
        request_opts={
            "native_tools": ["web_search", "web_search", "", None],
            "reasoning_effort": "high",
        },
        user_prefs=None,
        anima_prefs=None,
    )

    assert merged["native_tools"] == ["web_search"]
    assert merged["reasoning_effort"] == "high"


def test_merge_chat_request_options_preserves_request_tts_options() -> None:
    merged = merge_chat_request_options(
        request_opts={
            "main_structured_response": True,
            "tts": {
                "enabled": True,
                "provider": "elevenlabs",
                "transport": "auto",
                "language_code": "en",
                "model_id": "eleven_v4_turbo",
                "finalized_chunking": "paragraph",
                "ignored": "value",
            },
        },
        user_prefs=None,
        anima_prefs=None,
    )

    assert merged["main_structured_response"] is True
    assert merged["tts"] == {
        "enabled": True,
        "provider": "elevenlabs",
        "transport": "auto",
        "language_code": "en",
        "model_id": "eleven_v4_turbo",
        "finalized_chunking": "paragraph",
    }


def test_merge_chat_request_options_defaults_finalized_tts_chunking_at_use_site() -> None:
    merged = merge_chat_request_options(
        request_opts={
            "tts": {
                "enabled": True,
                "provider": "gemini",
                "model_id": "gemini-3.8-flash-tts",
            },
        },
        user_prefs=None,
        anima_prefs=None,
    )

    assert merged["tts"] == {
        "enabled": True,
        "provider": "gemini",
        "model_id": "gemini-3.8-flash-tts",
    }
    bootstrap = FinalizedTtsStreamBootstrap.start_if_requested(
        chat_options=merged,
        sessions=cast(Any, None),
        anima_id="anima-1",
        run_id="run-1",
        gemini_speech=cast(Any, object()),
    )
    assert bootstrap.finalized_chunking == "sentence"


def test_merge_chat_request_options_does_not_infer_tts_from_main_structured_response() -> None:
    merged = merge_chat_request_options(
        request_opts={"main_structured_response": True},
        user_prefs=None,
        anima_prefs=None,
    )

    assert merged["main_structured_response"] is True
    assert merged["tts"] is None


def test_main_structured_prompt_includes_schema_dump_and_display_rules() -> None:
    output_type = build_main_response_model(agent_id="direct-chat", gesture_ids=TEST_RUNTIME_GESTURE_IDS)

    prompt = build_main_structured_prompt(output_type)
    gesture_ids = TEST_RUNTIME_GESTURE_IDS

    assert gesture_ids
    assert "Expected json schema" in prompt
    assert "Example valid json object" in prompt
    assert '"additionalProperties": false' in prompt
    assert '"required": [' in prompt
    assert '"emotional_tone"' in prompt
    assert '"emotional_intensity"' in prompt
    assert '"speech"' in prompt
    assert '"gesture"' in prompt
    assert '"display"' in prompt
    assert '"remember"' in prompt
    assert '"enum": [' in prompt
    assert '"type": [\n        "string",\n        "null"\n      ]' in prompt
    assert f'"{gesture_ids[0]}"' in prompt
    assert '"request_supervisor"' not in prompt
    assert (
        "Emit object properties in this order: emotional_tone, emotional_intensity, "
        "gesture, speech, display, remember." in prompt
    )
    assert prompt.index('"gesture"') < prompt.index('"speech"')
    assert prompt.index('"display"') < prompt.index('"remember"')


def test_main_structured_model_schema_is_openai_strict_by_construction() -> None:
    output_type = build_main_response_model(agent_id="direct-chat", gesture_ids=TEST_RUNTIME_GESTURE_IDS)

    schema = build_main_structured_response_json_schema(output_type)
    gesture_ids = TEST_RUNTIME_GESTURE_IDS

    assert gesture_ids
    assert schema["additionalProperties"] is False
    assert schema["required"] == [
        "emotional_tone",
        "emotional_intensity",
        "gesture",
        "speech",
        "display",
        "remember",
    ]
    assert list(schema["properties"]) == schema["required"]
    assert schema["properties"]["emotional_tone"]["enum"] == list(ELEVENLABS_EMOTIONAL_TONE_VALUES)
    assert schema["properties"]["gesture"]["enum"] == [None, *gesture_ids]
    assert "default" not in schema["properties"]["gesture"]
    assert "default" not in schema["properties"]["display"]
    assert "default" not in schema["properties"]["remember"]
    assert "anyOf" not in schema["properties"]["gesture"]
    assert "anyOf" not in schema["properties"]["display"]
    assert "anyOf" not in schema["properties"]["remember"]
    assert schema["properties"]["gesture"]["type"] == ["string", "null"]
    assert schema["properties"]["display"]["type"] == ["string", "null"]
    assert schema["properties"]["remember"]["type"] == ["string", "null"]


def test_main_structured_output_schema_lists_available_gesture_values() -> None:
    gesture_ids = TEST_RUNTIME_GESTURE_IDS

    schema = build_main_structured_output_schema(gesture_ids=gesture_ids)

    assert gesture_ids
    assert schema["fields"]["gesture"]["values"] == [None, *gesture_ids]
    assert schema["fields"]["remember"]["required"] is True


def test_main_structured_schema_uses_request_runtime_gesture_ids() -> None:
    victory_model = build_main_response_model(
        agent_id="victory-anima",
        gesture_ids=("victory-dance",),
    )
    thoughtful_model = build_main_response_model(
        agent_id="thoughtful-anima",
        gesture_ids=("thoughtful-pose",),
    )

    assert build_main_structured_response_json_schema(victory_model)["properties"]["gesture"]["enum"] == [
        None,
        "victory-dance",
    ]
    assert build_main_structured_response_json_schema(thoughtful_model)["properties"]["gesture"]["enum"] == [
        None,
        "thoughtful-pose",
    ]


def test_main_structured_gesture_validation_rejects_unknown_runtime_id() -> None:
    gesture_ids = ("victory-dance",)

    accepted = validate_main_structured_gesture(
        "victory-dance",
        gesture_ids=gesture_ids,
    )
    rejected = validate_main_structured_gesture(
        "other-anima-gesture",
        gesture_ids=gesture_ids,
    )

    assert accepted.gesture == "victory-dance"
    assert rejected.gesture == ""
    assert rejected.dropped_reason == "unknown_gesture_id"


def test_main_structured_stream_parser_emits_final_speech_fragment_after_string_closes() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed('{"emotional_tone":"happy","emotional_intensity":8,"gesture":null,"speech":"Short')
    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "happy", False, None, None, 8)
    ]
    events = parser.feed(' spoken answer."')

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "Short spoken answer.", True, 0, True, None)
    ]


def test_main_structured_stream_parser_emits_speech_sentence_before_string_closes() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed(
        '{"emotional_tone":"happy","emotional_intensity":8,"gesture":null,"speech":"First sentence. Sec'
    )

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "happy", False, None, None, 8),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "First sentence.", True, 0, False, None),
    ]

    events = parser.feed('ond sentence."')

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, " Second sentence.", True, 1, True, None)
    ]


def test_main_structured_stream_parser_emits_empty_final_marker_when_sentence_already_streamed() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed(
        '{"emotional_tone":"neutral","emotional_intensity":1,"gesture":null,"speech":"Done. ","display":null}'
    )

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "neutral", False, None, None, 1),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "Done.", True, 0, False, None),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "", True, 1, True, None),
    ]


def test_main_structured_stream_parser_decodes_escaped_speech_and_preserves_abbreviations() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed(
        '{"emotional_tone":"neutral","emotional_intensity":2,"gesture":null,'
        '"speech":"Dr. Smith said \\"hello\\". Unicode \\u263',
    )
    events.extend(parser.feed('A works."}'))

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "neutral", False, None, None, 2),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, 'Dr. Smith said "hello".', True, 0, False, None),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, " Unicode ☺ works.", True, 1, True, None),
    ]


def test_main_structured_stream_parser_disables_streaming_when_first_key_is_not_tone() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed('{"speech":"Too early. "')

    assert events == []
    assert parser.streaming_unavailable is True
    assert parser.feed(',"emotional_tone":"neutral"}') == []


def test_main_structured_stream_parser_disables_streaming_for_non_json_prefix() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed("not json")

    assert events == []
    assert parser.streaming_unavailable is True


def test_main_structured_stream_parser_streams_decoded_display_deltas() -> None:
    parser = MainStructuredJsonStreamParser()
    chunks = [
        '{"emotional_tone":"amusement","emotional_intensity":6,"gesture":null,'
        '"speech":"Speak now.","display":"Line 1 with \\"quote',
        '\\" and slash \\\\ plus unicode \\u263',
        'A done."}',
    ]

    events = []
    for chunk in chunks:
        events.extend(parser.feed(chunk))

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "amusement", False, None, None, 6),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "Speak now.", True, 0, True, None),
        (MAIN_STRUCTURED_RESPONSE_PART_DISPLAY, 'Line 1 with "quote', True, 0, False, None),
        (MAIN_STRUCTURED_RESPONSE_PART_DISPLAY, '" and slash \\ plus unicode ', True, 1, False, None),
        (MAIN_STRUCTURED_RESPONSE_PART_DISPLAY, "☺ done.", True, 2, True, None),
    ]
    assert all(event.is_delta for event in events if event.response_part == MAIN_STRUCTURED_RESPONSE_PART_DISPLAY)


def test_main_structured_stream_parser_rejects_empty_speech() -> None:
    parser = MainStructuredJsonStreamParser()

    with pytest.raises(ValueError, match="non-empty speech"):
        parser.feed(
            '{"emotional_tone":"neutral","emotional_intensity":1,"gesture":null,"speech":"   ","display":"No speech."}'
        )


def test_main_structured_response_render_preserves_gesture_before_speech() -> None:
    output_type = build_main_response_model(agent_id="direct-chat")

    parsed = parse_main_structured_response(
        (
            '{"emotional_tone":"sad","emotional_intensity":7,"speech":"Short spoken answer.",'
            '"gesture":"wave","display":"More detail.","remember":"The user likes careful plans."}'
        ),
        output_type,
    )

    assert parsed.emotional_tone == "sad"
    assert parsed.emotional_intensity == 7
    assert parsed.structured["emotional_tone"] == "sad"
    assert parsed.structured["emotional_intensity"] == 7
    assert list(parsed.structured) == [
        "emotional_tone",
        "emotional_intensity",
        "gesture",
        "speech",
        "display",
        "remember",
    ]
    assert parsed.remember == "The user likes careful plans."
    assert parsed.structured["remember"] == "The user likes careful plans."
    rendered = render_main_structured_json(parsed)
    assert rendered.startswith('{"emotional_tone":"sad","emotional_intensity":7,"gesture"')
    assert rendered.index('"gesture"') < rendered.index('"speech"')
    assert rendered.index('"display"') < rendered.index('"remember"')


def test_main_structured_response_missing_required_fields_fails_validation() -> None:
    output_type = build_main_response_model(agent_id="direct-chat")

    with pytest.raises(ValidationError):
        parse_main_structured_response('{"speech":"Missing tone."}', output_type)


@pytest.mark.parametrize(
    ("raw_value", "expected"),
    [
        (None, 1),
        ("", 1),
        ("5", 5),
        (0, 1),
        (3.0, 3),
        (11, 10),
        ("not-a-number", 1),
        (False, 1),
    ],
)
def test_voice_emotional_intensity_normalizes_provider_output(raw_value: object, expected: int) -> None:
    assert validate_main_emotional_intensity(raw_value) == expected


def test_main_structured_response_normalizes_emotional_intensity() -> None:
    output_type = build_main_response_model(agent_id="direct-chat")

    parsed = parse_main_structured_response(
        (
            '{"emotional_tone":"happy","emotional_intensity":"10",'
            '"speech":"Strong happy answer.","gesture":"","display":null,"remember":null}'
        ),
        output_type,
    )

    assert parsed.emotional_intensity == 10
    assert parsed.structured["emotional_intensity"] == 10


def test_main_structured_response_normalizes_null_gesture_to_empty_string() -> None:
    output_type = build_main_response_model(agent_id="direct-chat")

    parsed = parse_main_structured_response(
        (
            '{"emotional_tone":"neutral","emotional_intensity":1,'
            '"speech":"No gesture needed.","gesture":null,"display":null,"remember":null}'
        ),
        output_type,
    )

    assert parsed.gesture == ""
    assert parsed.structured["gesture"] == ""


def test_main_structured_response_unexpected_emotional_tone_falls_back_to_neutral() -> None:
    output_type = build_main_response_model(agent_id="direct-chat")

    parsed = parse_main_structured_response(
        (
            '{"emotional_tone":"friendly","emotional_intensity":1,'
            '"speech":"Still speak.","gesture":"","display":null,"remember":""}'
        ),
        output_type,
    )

    assert parsed.emotional_tone == "neutral"
    assert parsed.structured["emotional_tone"] == "neutral"
    assert parsed.remember is None


def test_main_structured_stream_parser_non_string_tone_falls_back_to_neutral() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed('{"emotional_tone":null,"emotional_intensity":1,"gesture":null,"speech":"Still speak."}')

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "neutral", False, None, None, 1),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "Still speak.", True, 0, True, None),
    ]


def test_main_structured_stream_parser_unknown_tone_falls_back_to_neutral() -> None:
    parser = MainStructuredJsonStreamParser()

    events = parser.feed('{"emotional_tone":"friendly","emotional_intensity":1,"gesture":null,"speech":"Still speak."}')

    assert _stream_event_tuples(events) == [
        (MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE, "neutral", False, None, None, 1),
        (MAIN_STRUCTURED_RESPONSE_PART_SPEECH, "Still speak.", True, 0, True, None),
    ]
