"""Wire frames of a direct chat turn over SSE, and the state they carry between events."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from animama.app.contracts.elevenlabs import PyElevenLabsRealtimeTtsSessionResponse
from animama.app.contracts.gemini import DEFAULT_GEMINI_TTS_MODEL_ID
from animama.app.gruut_text import gruut_prepares_text
from animama.app.main_structured_response import (
    MAIN_STRUCTURED_RESPONSE_FORMAT,
    MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE,
    MAIN_STRUCTURED_RESPONSE_PART_SPEECH,
)
from animama.domain.emotions import emotion_values_payload
from animama.domain.events import EventType
from animama.logging import get_logger
from animama.product_http.ports import ProductRefusal

from .emotional_state import persist_emotional_state_update
from .setup_helpers import TurnSessions

_log = get_logger("product_http.chat.sse_events")
# Codes a composition with public error text still shows: short lowercase identifiers.
_PUBLIC_ERROR_CODE = re.compile(r"^[a-z0-9_.]{1,64}$")

GruutSseTextBuilder = Callable[..., Mapping[str, object] | None]
TTS_TEXT_BASIS_GRUUT_TEXT_WITH_WS = "gruut_text_with_ws"
# The reply's own text, spoken as written; the provider normalizes it.
TTS_TEXT_BASIS_VISIBLE_TEXT = "visible_text"


def _is_main_structured_response_format(response_format: object) -> bool:
    return response_format == MAIN_STRUCTURED_RESPONSE_FORMAT


@dataclass(slots=True)
class SsePreparedTtsSpeechSegment:
    visible_text: str
    tts_text: str
    tts_phonemized_text: list[object]
    text_basis: str
    part_index: int
    part_final: bool
    paragraph_index: int = 0
    paragraph_break_before: bool = False


@dataclass(slots=True)
class SseTextState:
    stream_text_parts: list[str] = field(default_factory=list)
    last_full_text: str | None = None
    main_structured_response_seen: bool = False
    emotional_tone: str | None = None
    emotional_intensity: int | None = None
    emotional_state: dict[str, int] | None = None
    tts_speech_payload_enabled: bool = False
    tts_speech_segments: list[SsePreparedTtsSpeechSegment] = field(default_factory=list)
    tts_speech_segments_closed: bool = False
    tts_speech_paragraph_index: int = 0
    crisis_resources: Mapping[str, Any] | None = None
    """Resolved crisis-resource region for this turn, attached to crisis frames."""
    crisis_support_emitted: bool = False
    public_error_text: str | None = None
    """The composition's fixed error text for turn error frames, if it hides error detail."""


def _payload_value(payload: Any, key: str) -> Any:
    if isinstance(payload, Mapping):
        return payload.get(key)
    return getattr(payload, key, None)


def _payload_run_id(payload: Any) -> str | None:
    value = _payload_value(payload, "run_id")
    return value if isinstance(value, str) else None


def _has_leading_blank_line_break(value: str) -> bool:
    leading_whitespace = value[: len(value) - len(value.lstrip())]
    if "\n" not in leading_whitespace and "\r" not in leading_whitespace:
        return False
    normalized = leading_whitespace.replace("\r\n", "\n").replace("\r", "\n")
    return re.search(r"\n[ \t\f\v]*\n", normalized) is not None


def format_sse(event: str, data: dict[str, object], event_id: str | None = None) -> str:
    payload = json.dumps(data, ensure_ascii=True)
    lines: list[str] = []
    if event_id:
        lines.append(f"id: {event_id}")
    if event:
        lines.append(f"event: {event}")
    lines.append(f"data: {payload}")
    return "\n".join(lines) + "\n\n"


def format_tts_session_event(
    *,
    run_id: str,
    session: PyElevenLabsRealtimeTtsSessionResponse,
) -> str:
    data: dict[str, object] = {
        "type": "tts.session",
        "run_id": run_id,
        "provider": "elevenlabs",
        "transport": "direct",
        "voice_id": session.voice_id,
        "model_id": session.model_id,
        "output_format": session.output_format,
        "sync_alignment": session.sync_alignment,
    }
    if session.language_code:
        data["language_code"] = session.language_code
    if session.websocket_base_url:
        data["websocket_base_url"] = session.websocket_base_url
    if session.token:
        data["token"] = session.token
    return format_sse("tts.session", data, event_id=f"tts-session-{run_id}")


def format_ai_notice_event(*, run_id: str, kind: str, anima_name: str | None) -> str:
    """App-rendered AI notice (spec R2); `type`-keyed so clients never read it as a reply."""

    return format_sse(
        "safety.ai_notice",
        {"type": "safety.ai_notice", "run_id": run_id, "kind": kind, "anima_name": anima_name},
        event_id=f"safety-ai-notice-{run_id}",
    )


def format_crisis_support_event(*, run_id: str, source: str, state: SseTextState) -> str | None:
    """Deterministic crisis card (spec R4), emitted at most once per run."""

    if state.crisis_support_emitted or state.crisis_resources is None:
        return None
    state.crisis_support_emitted = True
    return format_sse(
        "safety.crisis_support",
        {
            "type": "safety.crisis_support",
            "run_id": run_id,
            "source": source,
            "resources": jsonable_encoder(state.crisis_resources),
        },
        event_id=f"safety-crisis-support-{run_id}",
    )


def format_memory_updated_event(event: Any, *, run_id: str) -> str | None:
    """Memory cue for the run's saved reply; `type`-keyed so clients never read it as a reply."""

    payload = getattr(event, "payload", None)
    if _payload_run_id(payload) != run_id:
        return None
    memory_cue = _payload_value(payload, "memory_cue")
    if not isinstance(memory_cue, Mapping):
        return None
    message_id = _payload_value(payload, "message_id")
    return format_sse(
        "memory.updated",
        {
            "type": "memory.updated",
            "run_id": run_id,
            "message_id": message_id if isinstance(message_id, int) else None,
            "memory_cue": jsonable_encoder(memory_cue),
        },
        event_id=f"memory-updated-{run_id}",
    )


def format_run_status_event(event: Any, *, run_id: str) -> str | None:
    """Pending-reply status such as summarizing; `type`-keyed so clients never read it as a reply."""

    payload = getattr(event, "payload", None)
    if _payload_run_id(payload) != run_id:
        return None
    status = _payload_value(payload, "status")
    phase = _payload_value(payload, "phase")
    return format_sse(
        "run.status",
        {"type": "run.status", "run_id": run_id, "status": status, "phase": phase},
        event_id=getattr(event, "event_id", None) or f"run-status-{run_id}",
    )


def format_chat_title_updated_event(*, run_id: str, chat_id: str, title: str) -> str | None:
    clean_title = str(title or "").strip()
    if not clean_title:
        return None
    return format_sse(
        "chat.title.updated",
        {
            "type": "chat.title.updated",
            "run_id": run_id,
            "chat_id": chat_id,
            "title": clean_title,
        },
        event_id=f"chat-title-updated-{run_id}",
    )


def _http_exception_error_fields(exc: HTTPException) -> dict[str, object]:
    detail = exc.detail
    if isinstance(detail, Mapping):
        message = detail.get("message") or detail.get("detail") or detail.get("error")
        fields: dict[str, object] = {
            "error": str(message or "Failed to initialize ElevenLabs realtime TTS"),
            "details": jsonable_encoder(detail),
        }
        code = detail.get("code")
        if isinstance(code, str) and code:
            fields["code"] = code
        return fields
    return {"error": str(detail or "Failed to initialize ElevenLabs realtime TTS")}


def format_tts_session_error_event(*, run_id: str, exc: BaseException) -> str:
    data: dict[str, object] = {
        "type": "tts.session.error",
        "run_id": run_id,
        "provider": "elevenlabs",
    }
    if isinstance(exc, HTTPException):
        data.update(_http_exception_error_fields(exc))
        data["status_code"] = exc.status_code
    elif isinstance(exc, ProductRefusal):
        # The composition declined this reply's speech; its code tells the browser why.
        data["error"] = "Failed to initialize ElevenLabs realtime TTS"
        data["code"] = exc.code
        data["status_code"] = exc.status_code
    else:
        data["error"] = str(exc) or "Failed to initialize ElevenLabs realtime TTS"
        data["code"] = "tts_session_setup_failed"
        data["details"] = {"exc_type": exc.__class__.__name__}
    return format_sse("tts.session.error", data, event_id=f"tts-session-error-{run_id}")


def format_tts_audio_event(*, run_id: str, payload: Mapping[str, object], provider: str) -> str | None:
    audio_base64 = payload.get("audio_base64")
    if not isinstance(audio_base64, str) or not audio_base64:
        return None
    model_id = payload.get("model_id")
    output_format = payload.get("output_format")
    data: dict[str, object] = {
        "type": "tts.audio",
        "run_id": run_id,
        "provider": provider,
        "model_id": model_id if isinstance(model_id, str) else DEFAULT_GEMINI_TTS_MODEL_ID,
        "output_format": output_format if isinstance(output_format, str) else "pcm_24000",
        "audio_base64": audio_base64,
    }
    return format_sse("tts.audio", data)


def format_tts_done_event(*, run_id: str, payload: Mapping[str, object], provider: str) -> str:
    model_id = payload.get("model_id")
    output_format = payload.get("output_format")
    data: dict[str, object] = {
        "type": "tts.done",
        "run_id": run_id,
        "provider": provider,
        "model_id": model_id if isinstance(model_id, str) else DEFAULT_GEMINI_TTS_MODEL_ID,
        "output_format": output_format if isinstance(output_format, str) else "pcm_24000",
    }
    return format_sse("tts.done", data, event_id=f"tts-done-{run_id}")


def format_tts_error_event(
    *,
    run_id: str,
    error: str,
    code: str,
    model_id: str,
    output_format: str = "pcm_24000",
    provider: str,
) -> str:
    data: dict[str, object] = {
        "type": "tts.error",
        "run_id": run_id,
        "provider": provider,
        "model_id": model_id,
        "output_format": output_format,
        "error": error,
        "code": code,
    }
    return format_sse("tts.error", data, event_id=f"tts-error-{run_id}")


def _attach_tts_speech_payload(
    data: dict[str, object],
    *,
    state: SseTextState,
    value: str,
    is_delta: bool | None,
    part_index: int | None,
    part_final: bool | None,
    build_gruut_sse_text: GruutSseTextBuilder,
) -> None:
    effective_part_final = part_final if isinstance(part_final, bool) else is_delta is False
    if effective_part_final:
        state.tts_speech_segments_closed = True

    # Nothing to speak: whitespace, punctuation or emoji alone, such as a closing 😊,
    # stays visible text only.
    if not any(character.isalnum() for character in value):
        return

    # A complete speech event after streamed speech is a visible correction.
    # Audio already emitted for prior segments cannot be replaced, so do not
    # queue or tag the correction for another TTS pass.
    if is_delta is False and state.tts_speech_segments:
        return

    # Every sentence is spoken, whatever its language. gruut prepares English text
    # (its phonemes also time lip-sync); other text, or any text when gruut is
    # unavailable, is spoken as written.
    tts_payload = (
        build_gruut_sse_text(value, lang="en_US", tokenized_text_source="text_with_ws")
        if gruut_prepares_text(value)
        else None
    )
    gruut_text = tts_payload.get("tokenized_text") if tts_payload is not None else None
    if isinstance(gruut_text, str) and gruut_text.strip():
        gruut_phonemes = tts_payload.get("phonemized_text") if tts_payload is not None else None
        tts_text = gruut_text
        tts_phonemized_text = gruut_phonemes if isinstance(gruut_phonemes, list) else []
        text_basis = TTS_TEXT_BASIS_GRUUT_TEXT_WITH_WS
        data.update(
            {
                "tts_text": tts_text,
                "tts_phonemized_text": tts_phonemized_text,
                "tts_text_basis": text_basis,
            }
        )
    else:
        tts_text = value.strip()
        tts_phonemized_text = []
        text_basis = TTS_TEXT_BASIS_VISIBLE_TEXT
    paragraph_break_before = bool(state.tts_speech_segments) and _has_leading_blank_line_break(value)
    if paragraph_break_before:
        state.tts_speech_paragraph_index += 1

    state.tts_speech_segments.append(
        SsePreparedTtsSpeechSegment(
            visible_text=value,
            tts_text=tts_text,
            tts_phonemized_text=tts_phonemized_text,
            text_basis=text_basis,
            part_index=part_index if isinstance(part_index, int) else len(state.tts_speech_segments),
            part_final=effective_part_final,
            paragraph_index=state.tts_speech_paragraph_index,
            paragraph_break_before=paragraph_break_before,
        )
    )


async def persist_sse_side_effect(
    event: Any,
    *,
    run_id: str,
    anima_id: str,
    sessions: TurnSessions,
) -> bool:
    """Persist current-run SSE side effects for one matching event."""
    payload = getattr(event, "payload", None)
    if _payload_run_id(payload) != run_id:
        return False
    event_type = getattr(event, "type", None)
    try:
        if event_type == EventType.EMOTION_UPDATE:
            return await persist_emotional_state_update(sessions, anima_id, payload)
    except Exception:
        _log.exception(
            "SSE side-effect sink failed",
            anima_id=anima_id,
            run_id=run_id,
            event_type=str(event_type),
        )
    return False


def format_user_response_event(
    event: Any,
    *,
    run_id: str,
    state: SseTextState,
    build_gruut_sse_text: GruutSseTextBuilder,
) -> str | None:
    payload = getattr(event, "payload", None)
    payload_run_id = _payload_run_id(payload)
    if payload_run_id != run_id:
        return None

    is_delta = _payload_value(payload, "is_delta")
    value = _payload_value(payload, "value")
    if not isinstance(value, str):
        return None

    node_id = _payload_value(payload, "node_id")
    response_format = _payload_value(payload, "response_format")
    response_part = _payload_value(payload, "response_part")
    part_index = _payload_value(payload, "part_index")
    part_final = _payload_value(payload, "part_final")
    if _is_main_structured_response_format(response_format):
        state.main_structured_response_seen = True
        if response_part == MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE:
            state.emotional_tone = value.strip()
            emotional_intensity = _payload_value(payload, "emotional_intensity")
            if isinstance(emotional_intensity, int):
                state.emotional_intensity = emotional_intensity
            return None

    data: dict[str, object] = {
        "event_id": getattr(event, "event_id", None),
        "run_id": payload_run_id,
        "node_id": node_id,
        "text": value,
    }
    if isinstance(response_format, str) and response_format:
        data["response_format"] = response_format
    if isinstance(response_part, str) and response_part:
        data["response_part"] = response_part
    if isinstance(is_delta, bool):
        data["is_delta"] = is_delta
    if isinstance(part_index, int):
        data["part_index"] = part_index
    if isinstance(part_final, bool):
        data["part_final"] = part_final
    if _is_main_structured_response_format(response_format) and response_part == MAIN_STRUCTURED_RESPONSE_PART_SPEECH:
        gruut_payload = build_gruut_sse_text(value, lang="en_US")
        if gruut_payload is not None:
            data.update(gruut_payload)
        if state.tts_speech_payload_enabled:
            _attach_tts_speech_payload(
                data,
                state=state,
                value=value,
                is_delta=is_delta if isinstance(is_delta, bool) else None,
                part_index=part_index if isinstance(part_index, int) else None,
                part_final=part_final if isinstance(part_final, bool) else None,
                build_gruut_sse_text=build_gruut_sse_text,
            )

    if is_delta is False:
        state.last_full_text = value
    else:
        state.stream_text_parts.append(value)

    return format_sse("user.response", data, event_id=str(getattr(event, "event_id", "")))


def format_emotion_update_event(event: Any, *, run_id: str) -> str | None:
    payload = getattr(event, "payload", None)
    payload_run_id = _payload_run_id(payload)
    if payload_run_id != run_id:
        return None

    emotional_tone = _payload_value(payload, "emotional_tone")
    emotional_intensity = _payload_value(payload, "emotional_intensity")
    promoted_emotion = _payload_value(payload, "promoted_emotion")
    demoted_emotion = _payload_value(payload, "demoted_emotion")
    data: dict[str, object] = {
        "event_id": getattr(event, "event_id", None),
        "run_id": payload_run_id,
        "node_id": _payload_value(payload, "node_id"),
        "emotions": emotion_values_payload(_payload_value(payload, "emotions") or []),
        "emotional_tone": emotional_tone if isinstance(emotional_tone, str) else None,
        "emotional_intensity": emotional_intensity if isinstance(emotional_intensity, int) else None,
        "promoted_emotion": promoted_emotion if isinstance(promoted_emotion, str) else None,
        "demoted_emotion": demoted_emotion if isinstance(demoted_emotion, str) else None,
    }
    return format_sse("emotion.update", data, event_id=str(getattr(event, "event_id", "")))


def format_avatar_gesture_requested_event(event: Any, *, run_id: str) -> str | None:
    payload = getattr(event, "payload", None)
    payload_run_id = _payload_run_id(payload)
    if payload_run_id != run_id:
        return None

    gesture = _payload_value(payload, "gesture")
    if not isinstance(gesture, str) or not gesture.strip():
        return None
    data: dict[str, object] = {
        "event_id": getattr(event, "event_id", None),
        "run_id": payload_run_id,
        "node_id": _payload_value(payload, "node_id"),
        "gesture": gesture.strip(),
        "runtime_revision": _payload_value(payload, "runtime_revision"),
    }
    return format_sse("avatar.gesture.requested", data, event_id=str(getattr(event, "event_id", "")))


def format_error_event(event: Any, *, run_id: str, public_error_text: str | None = None) -> str | None:
    """Format a turn error; ``public_error_text`` hides its text, details and unsafe codes."""

    payload = getattr(event, "payload", None)
    payload_run_id = _payload_run_id(payload)
    if payload_run_id != run_id:
        return None

    message = _payload_value(payload, "message")
    code = _payload_value(payload, "code")
    details = _payload_value(payload, "details")
    if public_error_text is not None:
        safe_code = code if isinstance(code, str) and _PUBLIC_ERROR_CODE.fullmatch(code) else "turn_failed"
        return format_sse(
            "error",
            {"run_id": payload_run_id, "error": public_error_text, "code": safe_code},
            event_id=str(getattr(event, "event_id", "")),
        )
    data: dict[str, object] = {
        "run_id": payload_run_id,
        "error": str(message or "Runtime error"),
    }
    if isinstance(code, str) and code:
        data["code"] = code
    if details is not None:
        data["details"] = jsonable_encoder(details)
    return format_sse("error", data, event_id=str(getattr(event, "event_id", "")))


def format_run_completed_event(
    event: Any,
    *,
    run_id: str,
    chat_id: str | None = None,
    state: SseTextState,
    build_gruut_sse_text: GruutSseTextBuilder,
) -> str | None:
    payload = getattr(event, "payload", None)
    if _payload_run_id(payload) != run_id:
        return None

    data: dict[str, object] = {"run_id": run_id}
    resolved_chat_id = chat_id or getattr(event, "chat_id", None)
    if isinstance(resolved_chat_id, str) and resolved_chat_id:
        data["chat_id"] = resolved_chat_id
    if not state.main_structured_response_seen:
        final_text = (
            state.last_full_text if state.last_full_text is not None else "".join(state.stream_text_parts)
        ).strip()
    else:
        final_text = ""
    if final_text:
        gruut_payload = build_gruut_sse_text(final_text, lang="en_US")
        if gruut_payload is not None:
            data.update(gruut_payload)
    return format_sse("run.completed", data, event_id=str(getattr(event, "event_id", "")))
