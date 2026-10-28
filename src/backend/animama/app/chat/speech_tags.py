"""The prompt's Speech section, chosen by the voice that will speak ``speech``.

With a voice on, ``speech`` must read naturally aloud, so links, markdown and the
like go to ``display``. Gemini and ElevenLabs perform audio tags; every other turn
(speech off, Pocket TTS, browser speech) must not get them. The section is a
stable instruction section, so each voice setting keeps a byte-identical prompt
prefix, and changing the voice changes it once. Whatever the prompt says, the
speech paths prepare the text each voice receives (``animama.domain.audio_tags``).

How often to tag is phrased per instruction style: Claude follows "sparingly"
as meant, while the default phrasing names the moments a sound belongs to,
since GPT-6 Luna read "sparingly" as almost never (benchmark run of
2026-10-26: 2% of replies tagged, and no laugh, sigh or gasp where one was
invited).
"""

from __future__ import annotations

from animama.app.chat.anthropic_instructions import INSTRUCTION_STYLE_ANTHROPIC, INSTRUCTION_STYLE_DEFAULT
from animama.app.chat.options import DirectChatTtsOptions
from animama.domain.audio_tags import SpeechTagProvider

_HEADING = "# Speech\n\n"

_SPOKEN = """\
A voice reads `speech` aloud, so write it the way you would say it:
- Keep it to a few natural sentences; put longer detail in `display`.
- Never put links, URLs, email addresses, file paths, code, markdown, lists, tables or emoji in `speech`. Put them \
in `display` and refer to them in words, such as "I've put the link below".
- Write numbers, symbols and abbreviations the way you would say them when they could be misread aloud."""

_NEUTRAL_RULES = """\
- Write tags in square brackets and in English, in every language: [laughs], [chuckles], [giggles], [sighs], \
[gasps], [breathes], [short pause], [long pause] and [whispers].
- Place a tag at a sentence or clause boundary, where the sound happens. A pause or a sigh works best at the start \
of a sentence.
- [whispers] goes at the start of a sentence, only when your mood really shifts, and whispers that sentence.
- Write a sound you make as its tag, never spelled out in words such as "haha", "*sigh*" or "あはは".
- `speech` always needs words; a tag never replaces them. Never put tags in `display`."""

# How often to tag, by instruction style: the opening line, and what follows the sound cap.
_HOW_OFTEN = {
    INSTRUCTION_STYLE_ANTHROPIC: ("Use them sparingly, only where a real sound belongs:", "; most replies need none."),
    INSTRUCTION_STYLE_DEFAULT: (
        "Use one wherever you would really make the sound: laugh or chuckle when something is funny, sigh at "
        "something sad or tiring, gasp at a surprise, and whisper when the moment is hushed. Other replies need "
        "none. Write them this way:",
        ".",
    ),
}

_GEMINI_TAGS = """\
The selected voice performs audio tags in `speech`. {how_often}

{rules}
- This voice performs no other tags.
- Use at most two sounds (laughs, chuckles, giggles, sighs, gasps, breaths and pauses) in a reply{cap_tail}"""

_ELEVENLABS_TAGS = """\
The selected voice performs audio tags in `speech`. {how_often}

{rules}
- This voice also follows other short directions in square brackets, in English:
  - an emotion or delivery change, such as [excited], [softly] or [whispering, playful], before the words it \
affects and only when your mood really shifts. Your `emotional_tone` already sets how the reply begins;
  - other non-verbal sounds, such as [coughs] or [yawns];
  - sound effects, such as [applause] or [door knocks].
- Never ask for an accent.
- Use at most two sounds (laughs, sighs, gasps and other non-verbal sounds, sound effects and pauses) in a \
reply{cap_tail}
- A direction lasts until the next one, so after a whispered sentence, return to your reply's tone with a direction \
for it."""

_NO_TAGS = """\
Never write bracketed directions such as [laughs] or <sigh> in `speech`, even if earlier replies in this chat \
contain them; put the feeling into your words instead."""


def speech_tag_provider(tts: DirectChatTtsOptions | None) -> SpeechTagProvider | None:
    """The tag-capable voice this turn speaks with, or ``None`` when tags must not be written."""

    if tts is None or not _voice_on(tts):
        return None
    if tts.provider == "gemini":
        return "gemini"
    # Eleven v4 Turbo is the only ElevenLabs model: the chat options keep no other
    # ElevenLabs id (merge_chat_request_options), and it performs tags.
    if tts.provider == "elevenlabs":
        return "elevenlabs"
    return None


def speech_instruction(tts: DirectChatTtsOptions | None, *, instruction_style: str = INSTRUCTION_STYLE_DEFAULT) -> str:
    """The stable Speech section for the turn's speech options, phrased for the row's instruction style."""

    provider = speech_tag_provider(tts)
    template = _GEMINI_TAGS if provider == "gemini" else _ELEVENLABS_TAGS if provider == "elevenlabs" else None
    how_often, cap_tail = _HOW_OFTEN.get(instruction_style, _HOW_OFTEN[INSTRUCTION_STYLE_DEFAULT])
    tags = (
        _NO_TAGS if template is None else template.format(how_often=how_often, rules=_NEUTRAL_RULES, cap_tail=cap_tail)
    )
    # Without a voice, `speech` is read as text, so only the tag rule applies.
    parts = (_SPOKEN, tags) if _voice_on(tts) else (tags,)
    return _HEADING + "\n\n".join(parts)


def _voice_on(tts: DirectChatTtsOptions | None) -> bool:
    return tts is not None and tts.enabled is True


__all__ = ["speech_instruction", "speech_tag_provider"]
