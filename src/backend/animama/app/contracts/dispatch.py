"""Shared dispatch contracts; delivery owns admission and transport."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from animama.app.contracts.elevenlabs import ElevenLabsRealtimeTtsModelId, replace_retired_elevenlabs_tts_model_id
from animama.app.contracts.gemini import SUPPORTED_GEMINI_TTS_MODEL_IDS, GeminiTtsModelId
from animama.domain.events import EventType


class PyAnimaTtsRunOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    provider: Literal["browser", "pocket_tts", "elevenlabs", "gemini"] | None = None
    transport: Literal["auto", "direct"] | None = None
    language_code: str | None = Field(default=None, min_length=2, max_length=8)
    model_id: ElevenLabsRealtimeTtsModelId | GeminiTtsModelId | None = None
    finalized_chunking: Literal["sentence", "paragraph"] | None = None

    @field_validator("model_id", mode="before")
    @classmethod
    def _replace_retired_model(cls, value: object) -> object:
        """Speak a retired ElevenLabs model id with its replacement instead of refusing the turn."""

        return replace_retired_elevenlabs_tts_model_id(value)

    @model_validator(mode="after")
    def _model_matches_provider(self) -> PyAnimaTtsRunOptions:
        """A Gemini model needs the Gemini provider, and Gemini takes only its own models."""

        if self.model_id is not None and (self.model_id in SUPPORTED_GEMINI_TTS_MODEL_IDS) != (
            self.provider == "gemini"
        ):
            raise ValueError("model_id does not belong to the TTS provider")
        return self


class PyAnimaDispatchOptions(BaseModel):
    disable_emotion_updates: bool | None = None
    disable_emotion_influence: bool | None = None
    disable_memory_influence: bool | None = None
    disable_memory_updates: bool | None = None
    incognito: bool | None = None
    main_structured_response: bool | None = None
    native_tools: list[str] | None = None
    reasoning_effort: str | None = None
    tts: PyAnimaTtsRunOptions | None = None


class PyAnimaEventPublishRequest(BaseModel):
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)
    topic: str | None = None
    correlation_id: str | None = None
    causation_id: str | None = None
    anima_ids: list[str] | None = None
    binary: bool = False
