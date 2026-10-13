from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, cast

from animama.app.contracts.elevenlabs import SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS
from animama.app.contracts.gemini import SUPPORTED_GEMINI_TTS_MODEL_IDS

DirectChatFinalizedTtsChunking = Literal["sentence", "paragraph"]
DEFAULT_FINALIZED_TTS_CHUNKING: DirectChatFinalizedTtsChunking = "sentence"
_FINALIZED_TTS_CHUNKING_VALUES: set[str] = {"sentence", "paragraph"}


def _string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list | tuple | set | frozenset):
        return ()
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        if item is None:
            continue
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return tuple(result)


@dataclass(frozen=True, slots=True)
class DirectChatTtsOptions:
    enabled: bool | None = None
    provider: str | None = None
    transport: str | None = None
    language_code: str | None = None
    model_id: str | None = None
    finalized_chunking: DirectChatFinalizedTtsChunking | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider", _clean_string(self.provider))
        object.__setattr__(self, "transport", _clean_string(self.transport))
        object.__setattr__(self, "language_code", _clean_string(self.language_code))
        object.__setattr__(self, "model_id", _clean_string(self.model_id))
        object.__setattr__(self, "finalized_chunking", _clean_finalized_chunking(self.finalized_chunking))

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> DirectChatTtsOptions | None:
        if not isinstance(value, Mapping):
            return None
        enabled = value.get("enabled")
        return cls(
            enabled=enabled if isinstance(enabled, bool) else None,
            provider=_clean_string(value.get("provider")),
            transport=_clean_string(value.get("transport")),
            language_code=_clean_string(value.get("language_code")),
            model_id=_clean_string(value.get("model_id")),
            finalized_chunking=_clean_finalized_chunking(value.get("finalized_chunking")),
        )

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {}
        if self.enabled is not None:
            out["enabled"] = self.enabled
        if self.provider is not None:
            out["provider"] = self.provider
        if self.transport is not None:
            out["transport"] = self.transport
        if self.language_code is not None:
            out["language_code"] = self.language_code
        if self.model_id is not None:
            out["model_id"] = self.model_id
        if self.finalized_chunking is not None:
            out["finalized_chunking"] = self.finalized_chunking
        return out

    def get(self, key: str, default: object = None) -> object:
        return self.to_dict().get(key, default)

    def __getitem__(self, key: str) -> object:
        return self.to_dict()[key]


@dataclass(frozen=True, slots=True)
class DirectChatOptions:
    disable_memory_influence: bool = False
    disable_memory_updates: bool = False
    disable_emotion_influence: bool = False
    disable_emotion_updates: bool = False
    incognito: bool = False
    main_structured_response: bool = False
    native_tools: tuple[str, ...] = ()
    reasoning_effort: str | None = None
    tts: DirectChatTtsOptions | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "native_tools", _string_tuple(self.native_tools))
        object.__setattr__(self, "reasoning_effort", _clean_string(self.reasoning_effort))

    @classmethod
    def from_value(cls, value: DirectChatOptions | Mapping[str, Any] | None) -> DirectChatOptions:
        if isinstance(value, DirectChatOptions):
            return value
        if not isinstance(value, Mapping):
            return cls()
        tts = value.get("tts")
        return cls(
            disable_memory_influence=bool(value.get("disable_memory_influence", False)),
            disable_memory_updates=bool(value.get("disable_memory_updates", False)),
            disable_emotion_influence=bool(value.get("disable_emotion_influence", False)),
            disable_emotion_updates=bool(value.get("disable_emotion_updates", False)),
            incognito=bool(value.get("incognito", False)),
            main_structured_response=bool(value.get("main_structured_response", False)),
            native_tools=_string_tuple(value.get("native_tools")),
            reasoning_effort=_clean_string(value.get("reasoning_effort")),
            tts=DirectChatTtsOptions.from_mapping(tts) if isinstance(tts, Mapping) else None,
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "disable_memory_influence": self.disable_memory_influence,
            "disable_memory_updates": self.disable_memory_updates,
            "disable_emotion_influence": self.disable_emotion_influence,
            "disable_emotion_updates": self.disable_emotion_updates,
            "incognito": self.incognito,
            "main_structured_response": self.main_structured_response,
            "native_tools": list(self.native_tools),
            "reasoning_effort": self.reasoning_effort,
            "tts": self.tts.to_dict() if self.tts is not None else None,
        }

    def get(self, key: str, default: object = None) -> object:
        return self.to_dict().get(key, default)

    def __getitem__(self, key: str) -> object:
        return self.to_dict()[key]


def _clean_string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _clean_finalized_chunking(value: object) -> DirectChatFinalizedTtsChunking | None:
    text = _clean_string(value)
    if text in _FINALIZED_TTS_CHUNKING_VALUES:
        return cast(DirectChatFinalizedTtsChunking, text)
    return None


def _pick_bool(*values: object) -> bool:
    for val in values:
        if isinstance(val, bool):
            return val
    return False


def _pick_str(*values: object) -> str | None:
    for val in values:
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list | tuple | set):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        if item is None:
            continue
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _normalize_tts_options(value: object) -> DirectChatTtsOptions | None:
    if not isinstance(value, dict):
        return None

    normalized: dict[str, object] = {}
    enabled = value.get("enabled")
    if isinstance(enabled, bool):
        normalized["enabled"] = enabled

    provider = value.get("provider")
    if provider in {"browser", "pocket_tts", "elevenlabs", "gemini"}:
        normalized["provider"] = provider

    transport = value.get("transport")
    if transport in {"auto", "direct"}:
        normalized["transport"] = transport

    language_code = _pick_str(value.get("language_code"))
    if language_code is not None:
        normalized["language_code"] = language_code

    model_id = _pick_str(value.get("model_id"))
    # A model id is kept only for its own provider.
    provider_models = (
        SUPPORTED_GEMINI_TTS_MODEL_IDS if provider == "gemini" else SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS
    )
    if model_id in provider_models:
        normalized["model_id"] = model_id

    finalized_chunking = _pick_str(value.get("finalized_chunking"))
    if finalized_chunking in {"sentence", "paragraph"}:
        normalized["finalized_chunking"] = finalized_chunking

    if not normalized:
        return None
    return DirectChatTtsOptions.from_mapping(normalized)


def _get_pref_section(prefs: dict[str, Any] | None, key: str) -> dict[str, Any]:
    if isinstance(prefs, dict):
        section = prefs.get(key)
        if isinstance(section, dict):
            return section
    return {}


def merge_chat_request_options(
    *,
    request_opts: dict[str, Any] | None,
    user_prefs: dict[str, Any] | None,
    anima_prefs: dict[str, Any] | None,
) -> DirectChatOptions:
    """Resolve request, Anima and owner preferences without composition authority.

    Only explicit booleans override an inherited flag. Disabling memory influence
    also disables its writes, even when that value comes from another layer.
    """

    req = dict(request_opts or {})
    user_memory = _get_pref_section(user_prefs, "memory")
    anima_memory = _get_pref_section(anima_prefs, "memory")
    user_emotion = _get_pref_section(user_prefs, "emotion")
    anima_emotion = _get_pref_section(anima_prefs, "emotion")

    disable_memory_influence = _pick_bool(
        req.get("disable_memory_influence"),
        anima_memory.get("disable_influence"),
        user_memory.get("disable_influence"),
    )
    return DirectChatOptions(
        disable_memory_influence=disable_memory_influence,
        # Memory is never written while it is not read, even when the two
        # flags resolve from different levels (e.g. App off, Anima updates on).
        disable_memory_updates=disable_memory_influence
        or _pick_bool(
            req.get("disable_memory_updates"),
            anima_memory.get("disable_updates"),
            user_memory.get("disable_updates"),
        ),
        disable_emotion_influence=_pick_bool(
            req.get("disable_emotion_influence"),
            anima_emotion.get("disable_influence"),
            user_emotion.get("disable_influence"),
        ),
        disable_emotion_updates=_pick_bool(
            req.get("disable_emotion_updates"),
            anima_emotion.get("disable_updates"),
            user_emotion.get("disable_updates"),
        ),
        incognito=_pick_bool(req.get("incognito")),
        main_structured_response=_pick_bool(req.get("main_structured_response")),
        native_tools=tuple(_string_list(req.get("native_tools"))),
        reasoning_effort=_pick_str(req.get("reasoning_effort")),
        tts=_normalize_tts_options(req.get("tts")),
    )


__all__ = [
    "DEFAULT_FINALIZED_TTS_CHUNKING",
    "DirectChatFinalizedTtsChunking",
    "DirectChatOptions",
    "DirectChatTtsOptions",
    "merge_chat_request_options",
]
