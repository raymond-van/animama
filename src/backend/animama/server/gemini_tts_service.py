"""Gemini text-to-speech for chat replies, with the key from the process credential store.

Each reply segment is one streamed Interactions request with the Anima's prebuilt
voice and a speaking style from the reply's emotional tone. Gemini streams
24 kHz 16-bit little-endian PCM (``audio/l16``; measured 2026-10-11), which is
re-framed into ``pcm_24000`` payloads of at least 0.2 s for the chat stream.
Nothing is stored on Google's side (``store: false``). Error messages reach the
browser, so they name only the HTTP status, never request text or the key.
"""

from __future__ import annotations

import asyncio
import base64
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import status

from animama.app.contracts.gemini import (
    DEFAULT_GEMINI_TTS_MODEL_ID,
    GEMINI_TTS_MISSING_CREDENTIAL_CODE,
    GEMINI_TTS_MISSING_CREDENTIAL_MESSAGE,
    SUPPORTED_GEMINI_TTS_MODEL_IDS,
    gemini_voice_or_default,
)
from animama.app.model_clients.credential_store import GEMINI_CREDENTIAL_ENV
from animama.app.voice_emotional_tone import gemini_speaking_style
from animama.domain.request_principal import RequestPrincipal
from animama.logging_config import get_logger
from animama.product_http.ports import ProductRefusal
from animama.server.finalized_speech import FINALIZED_TTS_OUTPUT_FORMAT, finalized_tts_text, pop_pcm_audio_frame
from animama.server.runtime_credentials import runtime_credentials

_log = get_logger("server.gemini_tts_service")

GEMINI_TTS_STREAM_FAILED_CODE = "gemini_tts_stream_failed"
GEMINI_TTS_SAMPLE_RATE = 24000
GEMINI_TTS_REQUEST_TIMEOUT_MS = 60_000
GEMINI_TTS_MAX_IN_FLIGHT = 3
"""Gemini requests in flight across the process; others wait for a slot."""

_semaphore = asyncio.Semaphore(GEMINI_TTS_MAX_IN_FLIGHT)
_client_cache: tuple[str, Any] | None = None
"""The key and the client built for it."""


@dataclass(frozen=True, slots=True)
class GeminiFinalizedSpeech:
    """One reply segment ready to speak: the text, voice, model and style."""

    run_id: str
    voice_id: str
    model_id: str
    text: str
    style: str | None
    output_format: str = FINALIZED_TTS_OUTPUT_FORMAT


def _require_api_key() -> str:
    api_key = (runtime_credentials.current().get(GEMINI_CREDENTIAL_ENV) or "").strip()
    if not api_key:
        raise ProductRefusal(status.HTTP_503_SERVICE_UNAVAILABLE, GEMINI_TTS_MISSING_CREDENTIAL_CODE)
    return api_key


def _client(api_key: str) -> Any:
    """One SDK client per key; a changed key builds a new one.

    The dropped client is not closed here, because a reply may still be speaking
    through it; the SDK closes it once nothing references it. The SDK is imported
    on first use, so installations without Gemini voice never load it.
    """

    global _client_cache
    if _client_cache is not None and _client_cache[0] == api_key:
        return _client_cache[1]
    from animama.adapters.voice.gemini_client import gemini_sdk_client

    _client_cache = (api_key, gemini_sdk_client(api_key=api_key, timeout_ms=GEMINI_TTS_REQUEST_TIMEOUT_MS))
    return _client_cache[1]


async def prepare_gemini_finalized_speech(
    *,
    voice_id: str | None,
    run_id: str | None,
    text: str,
    model_id: str | None,
    text_basis: str,
    emotional_tone: str | None,
    emotional_state: dict[str, int] | None,
) -> GeminiFinalizedSpeech:
    """Check the key and prepare one segment; an unknown voice or model falls back to the default."""

    _require_api_key()
    return GeminiFinalizedSpeech(
        run_id=run_id or f"tts-{uuid.uuid4().hex}",
        voice_id=gemini_voice_or_default(voice_id),
        model_id=model_id if model_id in SUPPORTED_GEMINI_TTS_MODEL_IDS else DEFAULT_GEMINI_TTS_MODEL_ID,
        text=finalized_tts_text(text, text_basis=text_basis),
        # Every segment speaks in the reply's style.
        style=gemini_speaking_style(emotional_tone=emotional_tone, emotional_state=emotional_state),
    )


def _interaction_request(prepared: GeminiFinalizedSpeech) -> dict[str, Any]:
    content: dict[str, Any] = {"type": "text", "text": prepared.text}
    if prepared.style:
        content["annotations"] = [{"type": "speech_metadata", "style": prepared.style}]
    return {
        "model": prepared.model_id,
        "input": [{"type": "user_input", "content": [content]}],
        "response_format": {"type": "audio", "mime_type": "audio/l16", "sample_rate": GEMINI_TTS_SAMPLE_RATE},
        "generation_config": {"speech_config": [{"voice": prepared.voice_id}]},
        "store": False,
        "stream": True,
    }


def _audio_payload(prepared: GeminiFinalizedSpeech, audio: bytes) -> dict[str, Any]:
    return {
        "type": "audio",
        "run_id": prepared.run_id,
        "model_id": prepared.model_id,
        "output_format": prepared.output_format,
        "audio_base64": base64.b64encode(audio).decode("ascii"),
    }


def _error_payload(
    prepared: GeminiFinalizedSpeech, error: str, *, code: str = GEMINI_TTS_STREAM_FAILED_CODE
) -> dict[str, Any]:
    return {
        "type": "error",
        "run_id": prepared.run_id,
        "model_id": prepared.model_id,
        "output_format": prepared.output_format,
        "error": error,
        "code": code,
    }


def _safe_error_text(exc: BaseException) -> str:
    status_code = getattr(exc, "status_code", None)
    if status_code == 429:
        # Free-tier keys allow only a few requests a minute and a day per model.
        return (
            "Gemini's rate limit or daily quota was reached (HTTP 429). Try again later, or raise your Gemini API tier."
        )
    if isinstance(status_code, int):
        return f"Gemini text-to-speech failed (HTTP {status_code})."
    return "Gemini text-to-speech failed."


async def stream_gemini_finalized_speech(prepared: GeminiFinalizedSpeech) -> AsyncGenerator[dict[str, Any], None]:
    """Stream one segment as ``audio`` payloads, then ``done``, or one ``error``."""

    try:
        client = _client(_require_api_key())
    except ProductRefusal:
        yield _error_payload(prepared, GEMINI_TTS_MISSING_CREDENTIAL_MESSAGE, code=GEMINI_TTS_MISSING_CREDENTIAL_CODE)
        return
    except Exception as exc:
        _log.warning("Gemini TTS client setup failed", run_id=prepared.run_id, exc_type=type(exc).__name__)
        yield _error_payload(prepared, _safe_error_text(exc))
        return
    async with _semaphore:
        try:
            stream = await client.aio.interactions.create(**_interaction_request(prepared))
            buffer = bytearray()
            completed = False
            async for event in stream:
                event_type = getattr(event, "event_type", None)
                if event_type == "step.delta":
                    delta = getattr(event, "delta", None)
                    if getattr(delta, "type", None) != "audio":
                        continue
                    buffer.extend(base64.b64decode(getattr(delta, "data", None) or ""))
                    frame = pop_pcm_audio_frame(buffer)
                    if frame is not None:
                        yield _audio_payload(prepared, frame)
                elif event_type == "error":
                    yield _error_payload(prepared, "Gemini text-to-speech failed.")
                    return
                elif event_type == "interaction.completed":
                    interaction = getattr(event, "interaction", None)
                    completed = getattr(interaction, "status", None) == "completed"
            frame = pop_pcm_audio_frame(buffer, force=True)
            if frame is not None:
                yield _audio_payload(prepared, frame)
            if not completed:
                yield _error_payload(prepared, "Gemini text-to-speech ended before completing.")
                return
            yield {
                "type": "done",
                "run_id": prepared.run_id,
                "model_id": prepared.model_id,
                "output_format": prepared.output_format,
            }
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log.warning(
                "Gemini finalized TTS stream failed",
                run_id=prepared.run_id,
                model_id=prepared.model_id,
                exc_type=type(exc).__name__,
                status_code=getattr(exc, "status_code", None),
            )
            yield _error_payload(prepared, _safe_error_text(exc))


class LocalGeminiSpeech:
    """The local composition's Gemini speech port (``ChatTurnServices.gemini_speech``)."""

    async def prepare_finalized(
        self,
        principal: RequestPrincipal,
        *,
        voice_id: str,
        anima_id: str,
        run_id: str,
        text: str,
        model_id: str | None,
        text_basis: str,
        emotional_tone: str | None,
        emotional_state: dict[str, int] | None,
    ) -> GeminiFinalizedSpeech:
        # The turn resolves the prebuilt voice itself; Gemini detects the language.
        return await prepare_gemini_finalized_speech(
            voice_id=voice_id,
            run_id=run_id,
            text=text,
            model_id=model_id,
            text_basis=text_basis,
            emotional_tone=emotional_tone,
            emotional_state=emotional_state,
        )

    def stream_finalized(self, prepared: Any) -> AsyncIterator[dict[str, Any]]:
        return stream_gemini_finalized_speech(prepared)


__all__ = [
    "GEMINI_TTS_MISSING_CREDENTIAL_CODE",
    "GEMINI_TTS_STREAM_FAILED_CODE",
    "GeminiFinalizedSpeech",
    "LocalGeminiSpeech",
    "prepare_gemini_finalized_speech",
    "stream_gemini_finalized_speech",
]
