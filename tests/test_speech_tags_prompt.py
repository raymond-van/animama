"""The prompt's Speech section follows the voice that will speak the reply (#479, #704)."""

from __future__ import annotations

import pytest

from animama.app.chat.anthropic_instructions import INSTRUCTION_STYLE_ANTHROPIC
from animama.app.chat.conversation_language import conversation_language
from animama.app.chat.openai_prompt import DirectChatPromptAssembler
from animama.app.chat.options import DirectChatOptions, DirectChatTtsOptions
from animama.app.chat.speech_tags import speech_instruction, speech_tag_provider
from animama.app.safety.prompts import COMPANION_GUARDRAILS
from animama.product_http.chat.tts import tts_speech_payload_enabled

GEMINI = DirectChatTtsOptions(enabled=True, provider="gemini", model_id="gemini-3.8-flash-lite-tts")
ELEVENLABS = DirectChatTtsOptions(enabled=True, provider="elevenlabs", model_id="eleven_v4_turbo")


@pytest.mark.parametrize(
    ("tts", "expected"),
    [
        (GEMINI, "gemini"),
        (DirectChatTtsOptions(enabled=True, provider="gemini"), "gemini"),
        (ELEVENLABS, "elevenlabs"),
        (DirectChatTtsOptions(enabled=True, provider="elevenlabs"), "elevenlabs"),
        (DirectChatTtsOptions(enabled=False, provider="gemini"), None),
        (DirectChatTtsOptions(provider="elevenlabs"), None),
        (DirectChatTtsOptions(enabled=True, provider="pocket_tts"), None),
        (DirectChatTtsOptions(enabled=True, provider="browser"), None),
        (None, None),
    ],
)
def test_only_gemini_and_elevenlabs_speak_tags(tts: DirectChatTtsOptions | None, expected: str | None) -> None:
    assert speech_tag_provider(tts) == expected


def test_gemini_gets_the_neutral_tags_only() -> None:
    rule = speech_instruction(GEMINI)

    assert rule.startswith("# Speech\n\n")
    for tag in ("[laughs]", "[chuckles]", "[giggles]", "[sighs]", "[gasps]", "[breathes]", "[whispers]"):
        assert tag in rule
    assert "[short pause]" in rule and "[long pause]" in rule
    assert "at most two sounds" in rule
    assert "in English, in every language" in rule
    assert "[whispers] goes at the start of a sentence, only when your mood really shifts" in rule
    assert "performs no other tags" in rule
    assert "[applause]" not in rule and "accent" not in rule


def test_elevenlabs_also_gets_the_extras_without_accents() -> None:
    rule = speech_instruction(ELEVENLABS)

    assert "[laughs]" in rule and "[long pause]" in rule
    assert "[excited]" in rule and "[coughs]" in rule and "[applause]" in rule
    assert "Never ask for an accent." in rule
    assert "[whispers] goes at the start of a sentence, only when your mood really shifts" in rule
    assert "return to your reply's tone" in rule
    assert "at most two sounds" in rule
    assert "performs no other tags" not in rule


@pytest.mark.parametrize("tts", [GEMINI, ELEVENLABS])
def test_how_often_to_tag_is_phrased_per_instruction_style(tts: DirectChatTtsOptions) -> None:
    anthropic = speech_instruction(tts, instruction_style=INSTRUCTION_STYLE_ANTHROPIC)
    default = speech_instruction(tts)

    # Claude keeps "sparingly"; the default phrasing names the moments a sound belongs to.
    assert "Use them sparingly, only where a real sound belongs" in anthropic and "most replies need none" in anthropic
    assert "sparingly" not in default and "most replies need none" not in default
    assert "laugh or chuckle when something is funny" in default and "Other replies need none" in default
    for rule in (anthropic, default):
        assert 'never spelled out in words such as "haha"' in rule and "at most two sounds" in rule


@pytest.mark.parametrize(
    "tts",
    [
        None,
        DirectChatTtsOptions(enabled=False, provider="elevenlabs"),
        DirectChatTtsOptions(enabled=True, provider="pocket_tts"),
    ],
)
def test_every_other_turn_is_told_not_to_write_tags(tts: DirectChatTtsOptions | None) -> None:
    rule = speech_instruction(tts)

    assert rule.startswith("# Speech\n\n")
    assert "Never write bracketed directions" in rule
    assert "even if earlier replies in this chat contain them" in rule


@pytest.mark.parametrize(
    "tts",
    [
        GEMINI,
        ELEVENLABS,
        DirectChatTtsOptions(enabled=True, provider="pocket_tts"),
        DirectChatTtsOptions(enabled=True, provider="browser"),
    ],
)
def test_a_spoken_reply_keeps_links_and_markup_out_of_speech(tts: DirectChatTtsOptions) -> None:
    rule = speech_instruction(tts)

    assert "A voice reads `speech` aloud" in rule
    for item in ("links, URLs", "file paths, code, markdown, lists, tables or emoji"):
        assert item in rule
    assert "in `display`" in rule
    # The spoken rule comes before the voice's tag rule.
    assert rule.index("A voice reads") < rule.index("bracket")


@pytest.mark.parametrize("tts", [None, DirectChatTtsOptions(enabled=False, provider="elevenlabs")])
def test_a_reply_without_a_voice_gets_no_spoken_rule(tts: DirectChatTtsOptions | None) -> None:
    assert "A voice reads" not in speech_instruction(tts)


def _system_text(**kwargs: object) -> str:
    prompt = DirectChatPromptAssembler().assemble(user_message="hi", anima_identity="Identity", **kwargs)  # type: ignore[arg-type]
    content = prompt.messages[0]["content"]
    assert isinstance(content, str)
    return content


@pytest.mark.parametrize("instruction_style", ["default", INSTRUCTION_STYLE_ANTHROPIC])
def test_the_rule_follows_response_guidance_and_precedes_the_language_and_guardrails(instruction_style: str) -> None:
    system = _system_text(
        speech_guidance=speech_instruction(GEMINI),
        conversation_language=conversation_language("ko"),
        instruction_style=instruction_style,
    )

    section = system.index("# Speech")
    assert system.index("# Response Guidance") < section < system.index("# Conversation Language")
    assert section < system.index(COMPANION_GUARDRAILS.strip())


def test_the_same_voice_keeps_the_system_text_and_a_new_voice_changes_only_the_rule() -> None:
    gemini = _system_text(speech_guidance=speech_instruction(GEMINI))
    elevenlabs = _system_text(speech_guidance=speech_instruction(ELEVENLABS))

    assert _system_text(speech_guidance=speech_instruction(GEMINI)) == gemini
    assert gemini.replace(speech_instruction(GEMINI), speech_instruction(ELEVENLABS)) == elevenlabs


def test_without_a_rule_the_prompt_has_no_tag_section() -> None:
    assert "# Speech" not in _system_text()


@pytest.mark.parametrize(
    ("tts", "expected"),
    [
        (ELEVENLABS, True),
        (GEMINI, True),
        # Client-spoken voices name themselves only for the Speech section; the server queues no speech for them.
        (DirectChatTtsOptions(enabled=True, provider="pocket_tts"), False),
        (DirectChatTtsOptions(enabled=True, provider="browser"), False),
        (DirectChatTtsOptions(enabled=False, provider="elevenlabs"), False),
        (None, False),
    ],
)
def test_only_server_voices_queue_speech_segments(tts: DirectChatTtsOptions | None, expected: bool) -> None:
    assert tts_speech_payload_enabled(DirectChatOptions(tts=tts)) is expected
