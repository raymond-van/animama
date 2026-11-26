"""The ChatGPT plan session: one signed-in ChatGPT account whose plan pays for model requests.

A person signs in at OpenAI in their system browser ("Sign in with ChatGPT").
The installation then holds one account's tokens and uses them, instead of an
API key, for requests to models that account's plan includes. The tokens stay
in the backend and its private session file; nothing here is a database row.

The record keeps the registration OpenAI issued to this installation (a client
id under a stable host id) across sign-outs, so a later sign-in reuses it.
Secret and identifying fields are excluded from ``repr`` so a logged object
never carries them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct"
"""The scope that lets the tokens draw on the account's plan. Without it the account is signed in but unusable."""

ChatGPTPlanState = Literal["signed_out", "signed_in", "sign_in_required"]
"""``sign_in_required``: OpenAI rejected the tokens, so they were removed and the person must sign in again."""

ChatGPTPlanPurpose = Literal["interactive", "background"]
"""Who asked for a request: the person (``interactive``) or work the backend started by itself (``background``)."""


@dataclass(frozen=True, slots=True)
class ChatGPTPlanTokens:
    """One token set. ``expires_at`` and ``earliest_refresh_at`` are Unix seconds."""

    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    id_token: str = field(repr=False)
    expires_at: float
    earliest_refresh_at: float | None


@dataclass(frozen=True, slots=True)
class ChatGPTPlanAccount:
    """The signed-in account and the person's choices for it.

    ``tokens`` is None once OpenAI has rejected them (state ``sign_in_required``).
    ``confirmed_at`` records the one-time "You're using your ChatGPT plan"
    confirmation, and ``background_agreed`` whether work the backend starts by
    itself may use the plan. Both belong to this account: another account
    signing in starts without them.
    """

    subject: str = field(repr=False)
    email: str | None = field(repr=False)
    scopes: tuple[str, ...]
    tokens: ChatGPTPlanTokens | None
    confirmed_at: datetime | None = None
    background_agreed: bool = False

    @property
    def plan_use_granted(self) -> bool:
        return CHATGPT_PLAN_SCOPE in self.scopes


@dataclass(frozen=True, slots=True)
class ChatGPTPlanRecord:
    """Everything the session file holds.

    ``host_id`` (``urn:uuid:`` version 4) identifies this installation to
    OpenAI and is created once. ``client_id`` is the registration OpenAI issued
    at the first sign-in; None until then.
    """

    host_id: str
    client_id: str | None = field(default=None, repr=False)
    account: ChatGPTPlanAccount | None = None


@dataclass(frozen=True, slots=True)
class ChatGPTPlanStatus:
    """What the person may see about the session. It never carries a token or the account's subject.

    ``failure`` is the code of the last sign-in attempt that did not complete,
    such as ``access_denied`` when the person declined at OpenAI.
    """

    state: ChatGPTPlanState
    email: str | None
    plan_use_granted: bool
    sign_in_pending: bool
    confirmation_due: bool
    background_agreed: bool
    paused: bool
    failure: str | None


@dataclass(frozen=True, slots=True)
class ChatGPTPlanSignOutResult:
    """``confirmed`` is False when OpenAI could not confirm the session ended; the tokens are removed either way."""

    was_signed_in: bool
    confirmed: bool


class ChatGPTPlanError(Exception):
    """A failure with a stable code the page can explain. The message never carries a token."""

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


class ChatGPTPlanSignInError(ChatGPTPlanError):
    """A sign-in return that did not complete.

    Codes: ``no_pending_sign_in``, ``sign_in_expired``, ``state_mismatch``,
    ``access_denied``, ``sign_in_refused``, ``client_mismatch``,
    ``id_token_invalid``, ``temporarily_unavailable``.
    """


class ChatGPTPlanUnavailableError(ChatGPTPlanError):
    """The plan cannot serve a request now.

    Codes: ``not_signed_in``, ``sign_in_required``, ``plan_use_not_granted``,
    ``background_not_agreed``, ``paused``, ``temporarily_unavailable``.
    """
