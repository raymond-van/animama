"""Model connections: the endpoint and credential boundary for model rows.

A model connection names one model server: the built-in OpenAI API, the
built-in Anthropic Messages API, OpenAI's API through a ChatGPT plan sign-in
(the built-in ``chatgpt_plan`` connection), or an owner-configured
OpenAI-compatible Chat Completions endpoint such as Ollama. Every catalog row belongs to exactly one
connection, and requests for that row go only to the connection's endpoint with
only the connection's credential.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

BUILTIN_OPENAI_CONNECTION_ID = "openai"
BUILTIN_ANTHROPIC_CONNECTION_ID = "anthropic"
BUILTIN_CHATGPT_PLAN_CONNECTION_ID = "chatgpt_plan"
"""A ChatGPT plan sign-in (spec #919): its models are listed from the signed-in account, not the catalog."""
BUILTIN_CONNECTION_IDS = frozenset(
    {BUILTIN_OPENAI_CONNECTION_ID, BUILTIN_ANTHROPIC_CONNECTION_ID, BUILTIN_CHATGPT_PLAN_CONNECTION_ID}
)
"""Release-managed connections. Owner connection ids are generated and never collide with these."""

MODEL_SOURCE_BUILTIN = "builtin"
MODEL_SOURCE_OWNER = "owner"
MODEL_SOURCES = frozenset({MODEL_SOURCE_BUILTIN, MODEL_SOURCE_OWNER})

MODEL_KIND_CHAT = "chat"
MODEL_KIND_EMBEDDING = "embedding"
MODEL_KINDS = frozenset({MODEL_KIND_CHAT, MODEL_KIND_EMBEDDING})

REASONING_MODE_OPENAI_EFFORT = "openai_effort"
REASONING_MODE_DEEPSEEK_THINKING = "deepseek_thinking"
REASONING_MODE_OMIT = "omit"
REASONING_MODES = frozenset({REASONING_MODE_OPENAI_EFFORT, REASONING_MODE_DEEPSEEK_THINKING, REASONING_MODE_OMIT})


@dataclass(frozen=True, slots=True)
class ModelConnectionCompatibility:
    """Request-shape options for servers that differ from OpenAI's behavior.

    - ``fold_developer_role``: send no ``developer`` messages, for servers or
      chat templates that reject the role. Each turn's context goes in a
      tagged ``<turn_context>`` block at the start of the user message; only
      an app compaction summary and within-turn instructions are merged into
      the system message.
    - ``send_openai_extensions``: send ``prompt_cache_key`` and
      ``parallel_tool_calls``, which some servers reject as unknown fields.
    - ``send_stream_usage``: request streamed usage with
      ``stream_options.include_usage``.
    - ``strip_function_strict``: remove ``strict`` from function tool schemas.
    - ``reasoning_mode``: how a requested reasoning effort is sent; ``omit``
      never sends one.
    """

    fold_developer_role: bool = False
    send_openai_extensions: bool = True
    send_stream_usage: bool = True
    strip_function_strict: bool = False
    reasoning_mode: str = REASONING_MODE_OPENAI_EFFORT

    def __post_init__(self) -> None:
        if self.reasoning_mode not in REASONING_MODES:
            raise ValueError(f"Unsupported reasoning mode: {self.reasoning_mode}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "fold_developer_role": self.fold_developer_role,
            "send_openai_extensions": self.send_openai_extensions,
            "send_stream_usage": self.send_stream_usage,
            "strip_function_strict": self.strip_function_strict,
            "reasoning_mode": self.reasoning_mode,
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> ModelConnectionCompatibility:
        """Read stored options, keeping defaults for absent keys."""

        if not value:
            return cls()
        defaults = cls()
        return cls(
            fold_developer_role=bool(value.get("fold_developer_role", defaults.fold_developer_role)),
            send_openai_extensions=bool(value.get("send_openai_extensions", defaults.send_openai_extensions)),
            send_stream_usage=bool(value.get("send_stream_usage", defaults.send_stream_usage)),
            strip_function_strict=bool(value.get("strip_function_strict", defaults.strip_function_strict)),
            reasoning_mode=str(value.get("reasoning_mode") or defaults.reasoning_mode),
        )


@dataclass(slots=True)
class ModelConnection:
    """One model server and how to reach it; never holds a credential value.

    ``credential_env`` names the environment variable that holds the key, or is
    ``None`` when the server needs no key. Built-in connections have no stored
    base URL or reference: OpenAI uses the process OpenAI configuration and
    Anthropic uses ``ANTHROPIC_API_KEY`` against Anthropic's API.
    """

    id: str
    name: str
    preset: str
    source: str = MODEL_SOURCE_OWNER
    base_url: str | None = None
    credential_env: str | None = None
    compatibility: ModelConnectionCompatibility = field(default_factory=ModelConnectionCompatibility)
    timeout_seconds: float | None = None
    active: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @property
    def is_builtin(self) -> bool:
        """Whether this is a release-managed connection the owner cannot edit or remove."""

        return self.id in BUILTIN_CONNECTION_IDS

    @property
    def is_builtin_openai(self) -> bool:
        return self.id == BUILTIN_OPENAI_CONNECTION_ID

    @property
    def is_builtin_anthropic(self) -> bool:
        return self.id == BUILTIN_ANTHROPIC_CONNECTION_ID

    @property
    def is_builtin_chatgpt_plan(self) -> bool:
        return self.id == BUILTIN_CHATGPT_PLAN_CONNECTION_ID


__all__ = [
    "BUILTIN_ANTHROPIC_CONNECTION_ID",
    "BUILTIN_CHATGPT_PLAN_CONNECTION_ID",
    "BUILTIN_CONNECTION_IDS",
    "BUILTIN_OPENAI_CONNECTION_ID",
    "MODEL_KINDS",
    "MODEL_KIND_CHAT",
    "MODEL_KIND_EMBEDDING",
    "MODEL_SOURCES",
    "MODEL_SOURCE_BUILTIN",
    "MODEL_SOURCE_OWNER",
    "REASONING_MODES",
    "REASONING_MODE_DEEPSEEK_THINKING",
    "REASONING_MODE_OMIT",
    "REASONING_MODE_OPENAI_EFFORT",
    "ModelConnection",
    "ModelConnectionCompatibility",
]
