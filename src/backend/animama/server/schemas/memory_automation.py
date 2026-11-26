"""Automatic episode processing API (local composition only, spec #775 R11 and R13)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from animama.server.episode_processing import (
    EPISODE_PROCESSING_MAX_THRESHOLD,
    EPISODE_PROCESSING_MIN_THRESHOLD,
    EPISODE_PROCESSING_OFF,
)


class PyAutomaticEpisodeProcessingUpdate(BaseModel):
    """``threshold`` is 0 for Off, or the number of pending notes (5–50) that starts a run."""

    model_config = ConfigDict(extra="forbid")

    threshold: int = Field(ge=EPISODE_PROCESSING_OFF, le=EPISODE_PROCESSING_MAX_THRESHOLD)

    @field_validator("threshold")
    @classmethod
    def _off_or_in_range(cls, value: int) -> int:
        if value != EPISODE_PROCESSING_OFF and value < EPISODE_PROCESSING_MIN_THRESHOLD:
            raise ValueError(
                f"threshold must be {EPISODE_PROCESSING_OFF} (Off) or between "
                f"{EPISODE_PROCESSING_MIN_THRESHOLD} and {EPISODE_PROCESSING_MAX_THRESHOLD}"
            )
        return value


class PyAutomaticEpisodeProcessingStatus(BaseModel):
    """The setting and what automatic processing will do next.

    ``batch_size`` and ``started_at`` are set only while ``state`` is ``running``;
    ``next_attempt_at`` while ``backing_off``; ``last_error`` after a failed run,
    except during the daily-limit wait, which reports none.
    """

    threshold: int
    state: Literal[
        "off",
        "memory_off",
        "needs_model",
        "needs_plan_agreement",
        "needs_plan_sign_in",
        "plan_paused",
        "running",
        "paused",
        "backing_off",
        "waiting",
        "ready",
    ]
    pending_count: int
    runs_today: int
    last_error: str | None = None
    next_attempt_at: datetime | None = None
    batch_size: int | None = None
    started_at: datetime | None = None
