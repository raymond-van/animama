"""Request and response schemas for the ChatGPT plan session (local composition only).

Responses describe the session; none carries a token, a code or the
authorization URL except the one response that starts a sign-in.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from animama.domain.settings import UiLocale

ChatGPTPlanUnavailableReason = Literal["remote_origin", "secure_storage_unavailable"]
"""Why this installation cannot offer sign-in: its origin is not a loopback ``http`` origin
the return can reach, or a desktop profile has no vault key for the session file."""


class PyChatGPTPlanStatus(BaseModel):
    sign_in_available: bool
    unavailable_reason: ChatGPTPlanUnavailableReason | None = None
    state: Literal["signed_out", "signed_in", "sign_in_required"]
    email: str | None = None
    plan_use_granted: bool
    sign_in_pending: bool
    confirmation_due: bool
    background_agreed: bool
    paused: bool
    failure: str | None = None


class PyChatGPTPlanSignInRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enable_plan_use: bool = False
    ui_locale: UiLocale | None = None


class PyChatGPTPlanSignIn(BaseModel):
    authorize_url: str


class PyChatGPTPlanSignOut(BaseModel):
    was_signed_in: bool
    confirmed: bool


class PyChatGPTPlanModels(BaseModel):
    """The plan's model rows after a refresh: their ids, active and listed by OpenAI for this account."""

    model_provider_ids: list[str]


class PyChatGPTPlanPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmed: bool = False
    background_agreed: bool | None = None
