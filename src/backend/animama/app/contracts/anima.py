from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from animama.app.contracts.avatar import PyAvatarResponse
from animama.app.contracts.base import MetadataBase
from animama.domain.anima_definition import ANIMA_DISPLAY_NAME_MAX_CHARACTERS, normalize_display_name
from animama.domain.emotions import EMOTION_MAX_VALUE, EMOTION_MIN_VALUE

EmotionScore = Annotated[int, Field(ge=EMOTION_MIN_VALUE, le=EMOTION_MAX_VALUE)]


def _trim_nonblank_required_text(value: str, *, field_name: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError(f"{field_name} must not be blank")
    return trimmed


class PyEmotionalState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    admiration: EmotionScore = 0
    caring: EmotionScore = 0
    love: EmotionScore = 0
    respect: EmotionScore = 0
    confidence: EmotionScore = 0
    gratitude: EmotionScore = 0
    amusement: EmotionScore = 0
    excitement: EmotionScore = 0
    joy: EmotionScore = 0
    desire: EmotionScore = 0
    curiosity: EmotionScore = 0
    optimism: EmotionScore = 0
    fear: EmotionScore = 0
    nervousness: EmotionScore = 0
    confusion: EmotionScore = 0
    anger: EmotionScore = 0
    annoyance: EmotionScore = 0
    disapproval: EmotionScore = 0
    disgust: EmotionScore = 0
    embarrassment: EmotionScore = 0
    remorse: EmotionScore = 0
    disappointment: EmotionScore = 0
    grief: EmotionScore = 0
    sadness: EmotionScore = 0


def _trim_nonblank_model_provider_id(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("model_provider_id must not be blank")
    return trimmed


class PyAnimaUpdate(MetadataBase):
    __id_prefix__ = "anima"

    display_name: str | None = Field(
        None,
        min_length=1,
        max_length=ANIMA_DISPLAY_NAME_MAX_CHARACTERS,
    )
    organization_id: str | None = Field(None, description="Organization this anima belongs to, if any.")
    metadata: dict[str, Any] | None = Field(None, description="Additional metadata for this anima.")
    avatar_id: str | None = Field(None, description="Avatar id for this anima.")
    profile_picture_url: str | None = Field(None, description="Optional profile picture URL for this anima.")
    emotional_state: PyEmotionalState | None = Field(
        None,
        description="Tracked anima emotion values keyed by emotion name.",
    )

    @field_validator("avatar_id")
    @classmethod
    def trim_avatar_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _trim_nonblank_required_text(value, field_name="avatar_id")

    @field_validator("display_name", mode="before")
    @classmethod
    def validate_display_name(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("display_name must be a nonblank string")
        return normalize_display_name(value)


class PyAnimaUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anima: PyAnimaUpdate | None = None
    expected_aggregate_revision: int | None = Field(
        None, ge=1, description="Required for explicit name, Avatar, or profile edits."
    )
    pinned: bool | None = Field(
        None,
        description=(
            "Pin (true) or unpin (false) the Anima in the sidebar; omitted keeps the current state. "
            "A pin is runtime state: it needs no expected_aggregate_revision and does not advance it."
        ),
    )


class PyAnimaChatProfileResponse(BaseModel):
    anima_id: str
    default_model_provider_id: str
    reasoning_effort: str | None = Field(
        None,
        description=(
            "Reasoning effort the owner chose for the default model; null means the model's "
            "default_reasoning_effort, else its first supported effort."
        ),
    )
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PyAnimaChatProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_model_provider_id: str = Field(
        ...,
        min_length=1,
        description="Active model-provider catalog row id to use for this anima's direct chat profile.",
    )

    reasoning_effort: str | None = Field(
        None,
        max_length=16,
        description=(
            "Reasoning effort to save for this model; it must be one of the model's "
            "supported_reasoning_efforts. Null clears it. Omitted keeps the saved effort "
            "when the model is unchanged and clears it when the model changes."
        ),
    )

    @field_validator("default_model_provider_id")
    @classmethod
    def trim_default_model_provider_id(cls, value: str) -> str:
        trimmed = _trim_nonblank_model_provider_id(value)
        if trimmed is None:
            raise ValueError("default_model_provider_id must not be blank")
        return trimmed

    @field_validator("reasoning_effort")
    @classmethod
    def trim_reasoning_effort(cls, value: str | None) -> str | None:
        return None if value is None else _trim_nonblank_required_text(value, field_name="reasoning_effort")


class PyAnimaResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    display_name: str
    aggregate_revision: int = Field(ge=1)
    identity_status: Literal["ready", "repair_required"]
    organization_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    archive_id: str | None = None
    avatar_id: str | None = None
    avatar_catalog_item_id: str | None = None
    profile_picture_url: str | None = None
    emotional_state: PyEmotionalState | None = None
    pocket_voice_catalog_url: str | None = None
    avatar: PyAvatarResponse | None = None
    chat_profile: PyAnimaChatProfileResponse | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    pinned_at: datetime | None = Field(None, description="When the Anima was pinned; null when unpinned.")


class PyRuntimeImagePresentation(BaseModel):
    """Normalized image framing that adapts to each consumer's aspect ratio."""

    model_config = ConfigDict(extra="forbid")

    fit: Literal["cover", "contain"] = "cover"
    focal_x: float = Field(default=0.5, ge=0, le=1)
    focal_y: float = Field(default=0.5, ge=0, le=1)
    zoom: float = Field(default=1, ge=1, le=4)


class PyRuntimeImageReference(BaseModel):
    """Bounded presentation image; private bytes remain behind the local gateway."""

    model_config = ConfigDict(extra="forbid")

    source_type: Literal["catalog"]
    url: str
    content_type: str
    # 512 covers the stored Avatar portraits.
    width: int = Field(..., ge=1, le=512)
    height: int = Field(..., ge=1, le=512)
    content_revision: str
    presentation: PyRuntimeImagePresentation


class PyAnimaPresentation(BaseModel):
    """Lightweight presentation compiled independently of the full runtime."""

    model_config = ConfigDict(extra="forbid")

    anima_id: str
    presentation_revision: str
    display_name: str
    profile_thumbnail: PyRuntimeImageReference | None = None


class PyAnimaListItem(PyAnimaResponse):
    """Owned Anima list item with required navigation presentation data."""

    presentation: PyAnimaPresentation
