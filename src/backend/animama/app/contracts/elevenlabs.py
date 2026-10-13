"""Shared elevenlabs contracts; delivery owns admission and transport."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _ElevenLabsSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ElevenLabs speaks every reply with Eleven v4 Turbo, streamed while the reply is
# written; it offers no finalized model.
ElevenLabsRealtimeTtsModelId = Literal["eleven_v4_turbo"]

SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS: tuple[ElevenLabsRealtimeTtsModelId, ...] = ("eleven_v4_turbo",)

DEFAULT_ELEVENLABS_REALTIME_TTS_MODEL_ID: ElevenLabsRealtimeTtsModelId = "eleven_v4_turbo"

# Text to Dialogue's documented limit across one request's inputs; longer requests
# can end early while streaming or be refused.
ELEVENLABS_DIALOGUE_MAX_REQUEST_CHARS = 2_000

# Retired model ids and the model that now speaks for them. Saved preferences
# and requests from a tab opened before an upgrade still carry these ids.
RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS: dict[str, ElevenLabsRealtimeTtsModelId] = {
    "eleven_flash_v2_5": "eleven_v4_turbo",
    "eleven_multilingual_v2": "eleven_v4_turbo",
    "eleven_v3": "eleven_v4_turbo",
}


def replace_retired_elevenlabs_tts_model_id(value: object) -> object:
    """Return the current model for a retired ElevenLabs model id, or the value unchanged."""

    if isinstance(value, str):
        return RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS.get(value, value)
    return value


class PyElevenLabsVoiceSettings(_ElevenLabsSchema):
    """The voice settings Eleven v4 accepts; it has no Style, Speed or Speaker Boost."""

    stability: float | None = Field(default=None, ge=0.0, le=1.0)
    similarity_boost: float | None = Field(default=None, ge=0.0, le=1.0)


class PyElevenLabsVoice(_ElevenLabsSchema):
    voice_id: str
    name: str | None = None
    description: str | None = None
    preview_url: str | None = None
    labels: dict[str, str] = Field(default_factory=dict)
    category: str | None = None
    requires_verification: bool | None = None


class PyElevenLabsAnimaVoiceProfileInput(_ElevenLabsSchema):
    model_config = ConfigDict(extra="ignore")

    primary_voice: PyElevenLabsVoice


class PyElevenLabsTextToSpeechRequest(_ElevenLabsSchema):
    voice_id: str = Field(..., min_length=1)
    text: str = Field(..., min_length=1, max_length=ELEVENLABS_DIALOGUE_MAX_REQUEST_CHARS)
    model_id: ElevenLabsRealtimeTtsModelId = "eleven_v4_turbo"
    output_format: str | None = Field(default="mp3_44100_128")
    voice_settings: PyElevenLabsVoiceSettings | None = None

    @field_validator("model_id", mode="before")
    @classmethod
    def _replace_retired_model(cls, value: object) -> object:
        return replace_retired_elevenlabs_tts_model_id(value)


class PyElevenLabsAudioResponse(_ElevenLabsSchema):
    audio_base64: str
    media_type: str
    output_format: str | None = None
    file_name: str | None = None
    voice_id: str | None = None


class PyElevenLabsSoundEffectsRequest(_ElevenLabsSchema):
    text: str = Field(..., min_length=1, max_length=1000)
    output_format: str | None = Field(default="mp3_44100_128")
    loop: bool | None = None
    duration_seconds: float | None = Field(default=None, gt=0.0, le=22.0)
    prompt_influence: float | None = Field(default=None, ge=0.0, le=1.0)
    model_id: str | None = None


class PyElevenLabsRealtimeTtsSessionResponse(_ElevenLabsSchema):
    voice_id: str
    model_id: str
    output_format: str
    sync_alignment: bool
    language_code: str | None = None
    token: str | None = None
    websocket_base_url: str | None = None
