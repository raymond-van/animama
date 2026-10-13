from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from animama.domain.emotions import (
    NEUTRAL_EMOTION,
    emotion_value_level,
    normalize_emotion_name,
    normalize_emotional_state,
)
from animama.logging import get_logger

_log = get_logger("app.voice_emotional_tone")

CANONICAL_EMOTION_TO_ELEVENLABS_TONE: dict[str, str] = {
    NEUTRAL_EMOTION: NEUTRAL_EMOTION,
    "admiration": "impressed",
    "caring": "gentle",
    "love": "affectionate",
    "respect": "respectful",
    "confidence": "confident",
    "gratitude": "grateful",
    "amusement": "amused",
    "excitement": "excited",
    "joy": "happy",
    "desire": "eager",
    "curiosity": "curious",
    "optimism": "hopeful",
    "fear": "scared",
    "nervousness": "nervous",
    "confusion": "confused",
    "anger": "angry",
    "annoyance": "irritated",
    "disapproval": "stern",
    "disgust": "disgusted",
    "embarrassment": "embarrassed",
    "remorse": "regretful",
    "disappointment": "disappointed",
    "grief": "sorrowful",
    "sadness": "sad",
}

DEFAULT_ELEVENLABS_TONE_KEY = "friendly"

ELEVENLABS_TONE_TO_CANONICAL_EMOTION: dict[str, str] = {
    tone: emotion for emotion, tone in CANONICAL_EMOTION_TO_ELEVENLABS_TONE.items()
}

ELEVENLABS_EMOTIONAL_TONE_VALUES: tuple[str, ...] = tuple(dict.fromkeys(CANONICAL_EMOTION_TO_ELEVENLABS_TONE.values()))

VOICE_EMOTIONAL_TONE_VALUES: tuple[str, ...] = tuple(
    dict.fromkeys(
        (
            *CANONICAL_EMOTION_TO_ELEVENLABS_TONE.keys(),
            *CANONICAL_EMOTION_TO_ELEVENLABS_TONE.values(),
        )
    )
)


@dataclass(frozen=True, slots=True)
class ElevenLabsEmotionalTone:
    canonical_emotion: str
    tone_key: str

    @property
    def is_neutral(self) -> bool:
        return self.canonical_emotion == NEUTRAL_EMOTION


def _normalize_tone_token(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    token = value.strip().lower()
    return token or None


def normalize_elevenlabs_emotional_tone(value: Any) -> ElevenLabsEmotionalTone | None:
    token = _normalize_tone_token(value)
    if token is None:
        return None
    canonical = normalize_emotion_name(token, allow_neutral=True)
    if canonical is None:
        canonical = ELEVENLABS_TONE_TO_CANONICAL_EMOTION.get(token)
    if canonical is None:
        return None
    tone_key = CANONICAL_EMOTION_TO_ELEVENLABS_TONE.get(canonical)
    if tone_key is None:
        return None
    return ElevenLabsEmotionalTone(canonical_emotion=canonical, tone_key=tone_key)


def validate_voice_emotional_tone(
    value: Any,
    *,
    context: str = "main_structured_response",
    warn: bool = True,
) -> str:
    token = _normalize_tone_token(value)
    if token is None:
        if warn:
            _log.warning(
                "Main structured emotional_tone missing or blank; speech will use the friendly default tone",
                context=context,
                raw_type=type(value).__name__,
            )
        return NEUTRAL_EMOTION
    if normalize_elevenlabs_emotional_tone(token) is None:
        if warn:
            _log.warning(
                "Main structured emotional_tone is not allowlisted; speech will use the friendly default tone",
                context=context,
                emotional_tone=token,
            )
        return NEUTRAL_EMOTION
    return token


def gemini_speaking_style(
    *,
    emotional_tone: Any,
    emotional_state: Mapping[str, Any] | None,
) -> str:
    """One style sentence for Gemini speech, from the reply's tone and its level.

    Neutral or unknown tones speak in the friendly default; without an emotional
    state the tone carries no intensity word.
    """

    tone = normalize_elevenlabs_emotional_tone(emotional_tone)
    if tone is None or tone.is_neutral:
        description = DEFAULT_ELEVENLABS_TONE_KEY
    elif emotional_state is None:
        description = tone.tone_key
    else:
        level = emotion_value_level(normalize_emotional_state(emotional_state).get(tone.canonical_emotion))
        description = (
            f"slightly {tone.tone_key}" if level <= 0 else tone.tone_key if level == 1 else f"very {tone.tone_key}"
        )
    article = "an" if description[0] in "aeiou" else "a"
    return f"Speak in {article} {description} tone."


__all__ = [
    "gemini_speaking_style",
    "CANONICAL_EMOTION_TO_ELEVENLABS_TONE",
    "DEFAULT_ELEVENLABS_TONE_KEY",
    "ELEVENLABS_TONE_TO_CANONICAL_EMOTION",
    "ELEVENLABS_EMOTIONAL_TONE_VALUES",
    "VOICE_EMOTIONAL_TONE_VALUES",
    "ElevenLabsEmotionalTone",
    "normalize_elevenlabs_emotional_tone",
    "validate_voice_emotional_tone",
]
