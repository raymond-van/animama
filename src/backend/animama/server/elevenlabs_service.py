from __future__ import annotations

import asyncio
import base64
import json
import math
import random
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from io import BytesIO
from typing import Any, cast

import httpx
from elevenlabs.client import ElevenLabs
from elevenlabs.core import ApiError
from fastapi import HTTPException, status
from starlette.concurrency import run_in_threadpool

from animama.app.contracts.elevenlabs import (
    DEFAULT_ELEVENLABS_REALTIME_TTS_MODEL_ID,
    replace_retired_elevenlabs_tts_model_id,
)
from animama.app.model_clients.credential_store import ELEVENLABS_CREDENTIAL_ENV, CredentialSnapshot
from animama.domain.request_principal import RequestPrincipal
from animama.logging_config import get_logger
from animama.product_http.ports import VoiceResolver
from animama.server.config import Settings, settings
from animama.server.runtime_credentials import runtime_credentials
from animama.server.schemas.elevenlabs import (
    SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS,
    ElevenLabsRealtimeTtsModelId,
    PyElevenLabsAnimaVoiceProfileInput,
    PyElevenLabsAudioResponse,
    PyElevenLabsRealtimeTtsSessionResponse,
    PyElevenLabsSoundEffectsRequest,
    PyElevenLabsTextToSpeechRequest,
    PyElevenLabsVoice,
)

DEFAULT_TTS_MEDIA_TYPE = "audio/mpeg"
ELEVENLABS_REALTIME_TTS_OUTPUT_FORMAT = "pcm_24000"
# Ask for character timing with the audio; it costs nothing extra.
ELEVENLABS_REALTIME_TTS_SYNC_ALIGNMENT = True
ELEVENLABS_REALTIME_TTS_WEBSOCKET_BASE_URL = "wss://api.elevenlabs.io"
# The Text to Dialogue socket accepts only this token type; ``tts_websocket``
# tokens are refused with ``invalid_token_type``.
ELEVENLABS_DIALOGUE_WEBSOCKET_TOKEN_TYPE = "ttd_websocket"
ELEVENLABS_VOICE_ACCESS_POSITIVE_TTL_SECONDS = 30 * 60
ELEVENLABS_VOICE_ACCESS_NEGATIVE_TTL_SECONDS = 60
ELEVENLABS_APP_LABEL = "anima"
LABEL_OWNER_USER_ID = "owner_user_id"
LABEL_SOURCE = "source"
RETRYABLE_ELEVENLABS_CODES = {"concurrent_limit_exceeded", "rate_limit_exceeded"}
RETRY_AFTER_RE = re.compile(r"retry after\s+(?P<seconds>\d+(?:\.\d+)?)\s*seconds?", re.IGNORECASE)

_log = get_logger("server.elevenlabs")
_SDK_OMIT = cast(Any, ...)
# The SDK default when it builds its own HTTP client.
_ELEVENLABS_TIMEOUT_SECONDS = 240.0


@dataclass(frozen=True, slots=True)
class _ElevenLabsVoiceAccessCacheEntry:
    expires_at: float
    status_code: int | None = None
    detail: Any = None


_ELEVENLABS_VOICE_ACCESS_CACHE: dict[tuple[str, int], _ElevenLabsVoiceAccessCacheEntry] = {}


def _voice_access_cache_key(voice_id: str) -> tuple[str, int]:
    """Partition results by credential generation, so a replaced key never
    reuses an answer for the old one (including one stored late by a request
    still finishing on the old key)."""

    return voice_id.strip(), runtime_credentials.current().generation


def _clear_voice_access_cache_on_key_change(previous: CredentialSnapshot, current: CredentialSnapshot) -> None:
    if previous.get(ELEVENLABS_CREDENTIAL_ENV) != current.get(ELEVENLABS_CREDENTIAL_ENV):
        _ELEVENLABS_VOICE_ACCESS_CACHE.clear()


runtime_credentials.subscribe(_clear_voice_access_cache_on_key_change)


def clear_elevenlabs_voice_access_cache(*, voice_id: str | None = None) -> None:
    """Clear cached ElevenLabs voice accessibility results."""

    if voice_id is None:
        _ELEVENLABS_VOICE_ACCESS_CACHE.clear()
        return

    normalized_voice_id = voice_id.strip()
    if not normalized_voice_id:
        return
    for key in [key for key in _ELEVENLABS_VOICE_ACCESS_CACHE if key[0] == normalized_voice_id]:
        _ELEVENLABS_VOICE_ACCESS_CACHE.pop(key, None)


def _get_voice_access_cache_entry(voice_id: str) -> _ElevenLabsVoiceAccessCacheEntry | None:
    key = _voice_access_cache_key(voice_id)
    entry = _ELEVENLABS_VOICE_ACCESS_CACHE.get(key)
    if entry is None:
        return None
    if entry.expires_at <= time.monotonic():
        _ELEVENLABS_VOICE_ACCESS_CACHE.pop(key, None)
        return None
    return entry


def _store_voice_access_cache_success(voice_id: str) -> None:
    _ELEVENLABS_VOICE_ACCESS_CACHE[_voice_access_cache_key(voice_id)] = _ElevenLabsVoiceAccessCacheEntry(
        expires_at=time.monotonic() + ELEVENLABS_VOICE_ACCESS_POSITIVE_TTL_SECONDS,
    )


def _store_voice_access_cache_failure(voice_id: str, exc: HTTPException) -> None:
    _ELEVENLABS_VOICE_ACCESS_CACHE[_voice_access_cache_key(voice_id)] = _ElevenLabsVoiceAccessCacheEntry(
        expires_at=time.monotonic() + ELEVENLABS_VOICE_ACCESS_NEGATIVE_TTL_SECONDS,
        status_code=exc.status_code,
        detail=exc.detail,
    )


def _raise_cached_voice_access_failure(
    voice_id: str,
    entry: _ElevenLabsVoiceAccessCacheEntry,
) -> None:
    raise HTTPException(
        status_code=entry.status_code or status.HTTP_409_CONFLICT,
        detail=entry.detail
        or (f"Configured ElevenLabs voice is not available to the current ElevenLabs API key: {voice_id}"),
    )


def _require_api_key() -> str:
    """Return the ElevenLabs key pinned for this request."""

    api_key = runtime_credentials.current().get(ELEVENLABS_CREDENTIAL_ENV)
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ElevenLabs is not configured",
        )
    return api_key


def resolve_realtime_tts_model_id(
    model_id: ElevenLabsRealtimeTtsModelId | str | None,
) -> ElevenLabsRealtimeTtsModelId:
    """Resolve the ElevenLabs realtime TTS model id.

    No id speaks with v4 Turbo; a retired realtime id speaks with its replacement.
    """

    candidate = replace_retired_elevenlabs_tts_model_id(model_id.strip() if isinstance(model_id, str) else model_id)
    if not candidate:
        return DEFAULT_ELEVENLABS_REALTIME_TTS_MODEL_ID
    if candidate in SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS:
        return cast(ElevenLabsRealtimeTtsModelId, candidate)

    supported = ", ".join(SUPPORTED_ELEVENLABS_REALTIME_TTS_MODEL_IDS)
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=f"Unsupported ElevenLabs realtime TTS model_id: {candidate}. Supported values: {supported}",
    )


@lru_cache(maxsize=1)
def _elevenlabs_http_client() -> httpx.Client:
    """Connection pool shared by ElevenLabs clients; it holds no key."""

    return httpx.Client(timeout=_ELEVENLABS_TIMEOUT_SECONDS, follow_redirects=True)


def get_elevenlabs_client() -> ElevenLabs:
    """Return a client carrying this request's key over the shared pool.

    The SDK sends the key as a per-request header, so nothing long-lived keeps
    a replaced or removed key.
    """

    return ElevenLabs(api_key=_require_api_key(), httpx_client=_elevenlabs_http_client())


@lru_cache(maxsize=1)
def get_elevenlabs_semaphore() -> asyncio.Semaphore:
    return asyncio.Semaphore(max(1, settings.elevenlabs_max_in_flight))


def _normalize_api_error_headers(exc: ApiError) -> dict[str, str]:
    headers = getattr(exc, "headers", None)
    if not isinstance(headers, dict):
        return {}
    return {
        str(key).strip().lower(): str(value).strip()
        for key, value in headers.items()
        if key is not None and value is not None
    }


def _find_string_field(value: Any, field_name: str) -> str | None:
    if isinstance(value, dict):
        candidate = value.get(field_name)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
        for nested in value.values():
            match = _find_string_field(nested, field_name)
            if match:
                return match
    if isinstance(value, list):
        for nested in value:
            match = _find_string_field(nested, field_name)
            if match:
                return match
    return None


def _api_error_body(exc: ApiError) -> Any:
    """The error body as plain data; some SDK errors carry a typed model (e.g. a 422).

    The SDK builds that model without validation, so the provider's actual body may
    not match its declared fields; dump it as found, without serializer warnings.
    """

    body = getattr(exc, "body", None)
    model_dump = getattr(body, "model_dump", None)
    if callable(model_dump):
        return model_dump(by_alias=True, warnings=False)
    return body


def _decode_api_error_detail(exc: ApiError) -> str:
    body = _api_error_body(exc)
    if isinstance(body, dict):
        detail = body.get("detail") or body.get("message") or body.get("error")
        if isinstance(detail, dict):
            message = detail.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()
            return str(detail)
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
        return str(body)
    return str(exc)


def _extract_api_error_code(exc: ApiError) -> str | None:
    body = _api_error_body(exc)
    code = _find_string_field(body, "code")
    if code:
        return code

    detail = _decode_api_error_detail(exc).lower()
    if "concurrent" in detail:
        return "concurrent_limit_exceeded"
    if isinstance(exc.status_code, int) and exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        return "rate_limit_exceeded"
    return None


def _extract_retry_after_seconds(exc: ApiError) -> int | None:
    headers = _normalize_api_error_headers(exc)
    retry_after = headers.get("retry-after")
    if retry_after:
        try:
            return max(1, math.ceil(float(retry_after)))
        except ValueError:
            pass

    detail = _decode_api_error_detail(exc)
    match = RETRY_AFTER_RE.search(detail)
    if not match:
        return None

    try:
        return max(1, math.ceil(float(match.group("seconds"))))
    except ValueError:
        return None


def _extract_optional_int_header(exc: ApiError, header_name: str) -> int | None:
    value = _normalize_api_error_headers(exc).get(header_name.lower())
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _build_retryable_api_error_detail(exc: ApiError, *, fallback_detail: str) -> dict[str, Any]:
    code = _extract_api_error_code(exc) or "rate_limit_exceeded"
    detail: dict[str, Any] = {
        "provider": "elevenlabs",
        "code": code,
        "message": _decode_api_error_detail(exc) or fallback_detail,
        "retryable": True,
    }

    retry_after_seconds = _extract_retry_after_seconds(exc)
    if retry_after_seconds is not None:
        detail["retry_after_seconds"] = retry_after_seconds

    current_requests = _extract_optional_int_header(exc, "current-concurrent-requests")
    if current_requests is not None:
        detail["current_concurrent_requests"] = current_requests

    maximum_requests = _extract_optional_int_header(exc, "maximum-concurrent-requests")
    if maximum_requests is not None:
        detail["maximum_concurrent_requests"] = maximum_requests

    return detail


def _raise_from_api_error(exc: ApiError, *, fallback_detail: str) -> None:
    status_code = exc.status_code if isinstance(exc.status_code, int) else status.HTTP_502_BAD_GATEWAY
    if status_code < 400 or status_code >= 600:
        status_code = status.HTTP_502_BAD_GATEWAY

    if status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        raise HTTPException(
            status_code=status_code,
            detail=_build_retryable_api_error_detail(exc, fallback_detail=fallback_detail),
        ) from exc

    raise HTTPException(
        status_code=status_code,
        detail=_decode_api_error_detail(exc) or fallback_detail,
    ) from exc


def _build_voice_labels(
    *,
    user_id: str,
    source: str,
) -> dict[str, str]:
    return {
        "app": ELEVENLABS_APP_LABEL,
        LABEL_OWNER_USER_ID: user_id,
        LABEL_SOURCE: source,
    }


def _serialize_ivc_labels(labels: dict[str, str]) -> str:
    # The ElevenLabs IVC SDK sends labels as multipart form data, so dicts must
    # be serialized before httpx can include them in the request body.
    return json.dumps(labels, separators=(",", ":"), sort_keys=True)


def _sdk_optional(value: Any) -> Any:
    return _SDK_OMIT if value is None else value


def _compute_retry_delay_seconds(exc: ApiError, *, attempt_index: int) -> float:
    retry_after_seconds = _extract_retry_after_seconds(exc)
    code = _extract_api_error_code(exc)

    if code == "concurrent_limit_exceeded":
        delay = float(
            retry_after_seconds
            if retry_after_seconds is not None
            else settings.elevenlabs_concurrency_retry_delay_seconds
        )
        return min(delay, settings.elevenlabs_retry_max_delay_seconds)

    delay = min(
        settings.elevenlabs_retry_base_delay_seconds * (2**attempt_index),
        settings.elevenlabs_retry_max_delay_seconds,
    )
    if retry_after_seconds is not None:
        delay = max(delay, float(retry_after_seconds))
    return float(min(delay * (1.0 + (random.random() * 0.25)), settings.elevenlabs_retry_max_delay_seconds))


async def _call_elevenlabs(
    func: Any,
    *args: Any,
    fallback_detail: str,
    operation_name: str,
    **kwargs: Any,
) -> Any:
    max_retries = max(0, settings.elevenlabs_max_retries)

    async with get_elevenlabs_semaphore():
        attempt_index = 0
        while True:
            try:
                return await run_in_threadpool(func, *args, **kwargs)
            except ApiError as exc:
                code = _extract_api_error_code(exc)
                should_retry = (
                    isinstance(exc.status_code, int)
                    and exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS
                    and code in RETRYABLE_ELEVENLABS_CODES
                    and attempt_index < max_retries
                )
                if not should_retry:
                    _raise_from_api_error(exc, fallback_detail=fallback_detail)

                delay_seconds = _compute_retry_delay_seconds(exc, attempt_index=attempt_index)
                _log.warning(
                    "ElevenLabs request throttled",
                    operation=operation_name,
                    code=code,
                    attempt=attempt_index + 1,
                    max_retries=max_retries,
                    retry_delay_seconds=delay_seconds,
                    current_concurrent_requests=_extract_optional_int_header(exc, "current-concurrent-requests"),
                    maximum_concurrent_requests=_extract_optional_int_header(exc, "maximum-concurrent-requests"),
                )
                attempt_index += 1
                await asyncio.sleep(delay_seconds)


def _voice_to_schema(
    voice: Any,
    *,
    requires_verification: bool | None = None,
) -> PyElevenLabsVoice:
    labels = voice.labels if isinstance(getattr(voice, "labels", None), dict) else {}
    return PyElevenLabsVoice(
        voice_id=str(getattr(voice, "voice_id", "")),
        name=getattr(voice, "name", None),
        description=getattr(voice, "description", None),
        preview_url=getattr(voice, "preview_url", None),
        labels={str(key): str(value) for key, value in labels.items()},
        category=str(getattr(voice, "category", "")) or None,
        requires_verification=requires_verification,
    )


def _collect_audio_bytes(chunks: Iterable[bytes]) -> bytes:
    payload = bytearray()
    for chunk in chunks:
        if isinstance(chunk, bytes | bytearray):
            payload.extend(chunk)
    return bytes(payload)


def _encode_audio_response(
    *,
    audio_bytes: bytes,
    media_type: str,
    output_format: str | None,
    file_name: str | None = None,
    voice_id: str | None = None,
) -> PyElevenLabsAudioResponse:
    return PyElevenLabsAudioResponse(
        audio_base64=base64.b64encode(audio_bytes).decode("ascii"),
        media_type=media_type,
        output_format=output_format,
        file_name=file_name,
        voice_id=voice_id,
    )


def _resolve_media_type(output_format: str | None, default: str = DEFAULT_TTS_MEDIA_TYPE) -> str:
    normalized = (output_format or "").strip().lower()
    if not normalized:
        return default
    if normalized.startswith("mp3_"):
        return "audio/mpeg"
    if normalized.startswith("wav_"):
        return "audio/wav"
    if normalized.startswith("opus_"):
        return "audio/ogg"
    if normalized.startswith("pcm_"):
        return "audio/pcm"
    if normalized.startswith("ulaw_"):
        return "audio/basic"
    if normalized.startswith("alaw_"):
        return "audio/basic"
    return default


def _dialogue_settings(request: PyElevenLabsTextToSpeechRequest) -> dict[str, float] | None:
    """Eleven v4's dialogue settings: Stability and Similarity only."""

    if request.voice_settings is None:
        return None
    settings_payload = {
        "stability": request.voice_settings.stability,
        "similarity": request.voice_settings.similarity_boost,
    }
    return {name: value for name, value in settings_payload.items() if value is not None} or None


async def clone_voice(
    *,
    user_id: str,
    name: str,
    files: list[tuple[str, bytes, str]],
    description: str | None,
    remove_background_noise: bool,
) -> PyElevenLabsVoice:
    client = get_elevenlabs_client()
    sdk_files = [(filename, BytesIO(data), content_type) for filename, data, content_type in files]
    labels = _build_voice_labels(user_id=user_id, source="ivc")

    try:
        created = await _call_elevenlabs(
            client.voices.ivc.create,
            fallback_detail="Failed to clone voice",
            operation_name="clone_voice",
            name=name,
            files=sdk_files,
            remove_background_noise=remove_background_noise,
            description=_sdk_optional(description),
            labels=_serialize_ivc_labels(labels),
        )
        voice = await _call_elevenlabs(
            client.voices.get,
            created.voice_id,
            fallback_detail="Failed to fetch cloned voice",
            operation_name="get_cloned_voice",
        )
    except ApiError as exc:
        _raise_from_api_error(exc, fallback_detail="Failed to clone voice")

    return _voice_to_schema(
        voice,
        requires_verification=getattr(created, "requires_verification", None),
    )


async def get_owned_voice(*, user_id: str, voice_id: str) -> Any:
    client = get_elevenlabs_client()
    try:
        voice = await _call_elevenlabs(
            client.voices.get,
            voice_id,
            fallback_detail="Failed to fetch voice",
            operation_name="get_voice",
        )
    except ApiError as exc:
        _raise_from_api_error(exc, fallback_detail="Failed to fetch voice")

    labels = voice.labels if isinstance(getattr(voice, "labels", None), dict) else {}
    if labels.get("app") != ELEVENLABS_APP_LABEL or labels.get(LABEL_OWNER_USER_ID) != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Voice does not belong to the current user")
    return voice


async def synthesize_text(
    *,
    user_id: str,
    request: PyElevenLabsTextToSpeechRequest,
) -> PyElevenLabsAudioResponse:
    client = get_elevenlabs_client()
    await get_owned_voice(user_id=user_id, voice_id=request.voice_id)
    dialogue_settings = _dialogue_settings(request)

    def _convert() -> bytes:
        # Eleven v4 speaks through Text to Dialogue; one input is one voice.
        return _collect_audio_bytes(
            client.text_to_dialogue.convert(
                inputs=[{"text": request.text, "voice_id": request.voice_id}],
                model_id=request.model_id,
                output_format=cast(Any, request.output_format),
                settings=cast(Any, dialogue_settings),
            )
        )

    try:
        audio_bytes = await _call_elevenlabs(
            _convert,
            fallback_detail="Failed to synthesize speech",
            operation_name="text_to_speech",
        )
    except ApiError as exc:
        _raise_from_api_error(exc, fallback_detail="Failed to synthesize speech")

    return _encode_audio_response(
        audio_bytes=audio_bytes,
        media_type=_resolve_media_type(request.output_format),
        output_format=request.output_format,
        file_name="speech-sample",
        voice_id=request.voice_id,
    )


async def generate_sound_effect(
    request: PyElevenLabsSoundEffectsRequest,
) -> PyElevenLabsAudioResponse:
    client = get_elevenlabs_client()

    def _convert() -> bytes:
        return _collect_audio_bytes(
            client.text_to_sound_effects.convert(
                text=request.text,
                output_format=request.output_format,
                loop=_sdk_optional(request.loop),
                duration_seconds=_sdk_optional(request.duration_seconds),
                prompt_influence=_sdk_optional(request.prompt_influence),
                model_id=_sdk_optional(request.model_id),
            )
        )

    try:
        audio_bytes = await _call_elevenlabs(
            _convert,
            fallback_detail="Failed to generate sound effect",
            operation_name="sound_effect",
        )
    except ApiError as exc:
        _raise_from_api_error(exc, fallback_detail="Failed to generate sound effect")

    return _encode_audio_response(
        audio_bytes=audio_bytes,
        media_type=_resolve_media_type(request.output_format),
        output_format=request.output_format,
        file_name="sound-effect",
    )


async def isolate_audio(
    *,
    filename: str,
    audio_bytes: bytes,
    file_format: str | None = None,
) -> PyElevenLabsAudioResponse:
    client = get_elevenlabs_client()
    effective_file_format = file_format or "other"

    def _convert() -> bytes:
        return _collect_audio_bytes(
            client.audio_isolation.convert(
                audio=(filename, BytesIO(audio_bytes), "application/octet-stream"),
                file_format=effective_file_format,
            )
        )

    try:
        isolated = await _call_elevenlabs(
            _convert,
            fallback_detail="Failed to isolate audio",
            operation_name="audio_isolation",
        )
    except ApiError as exc:
        _raise_from_api_error(exc, fallback_detail="Failed to isolate audio")

    return _encode_audio_response(
        audio_bytes=isolated,
        media_type=DEFAULT_TTS_MEDIA_TYPE,
        output_format=None,
        file_name="isolated-audio",
    )


def normalize_voice_profile(
    profile: PyElevenLabsAnimaVoiceProfileInput,
) -> dict[str, Any]:
    return profile.model_dump(mode="json")


async def mint_dialogue_websocket_single_use_token() -> str:
    """Mint a single-use token that admits one browser connection to the Text to Dialogue socket."""

    client = get_elevenlabs_client()
    try:
        response = await _call_elevenlabs(
            client.tokens.single_use.create,
            fallback_detail="Failed to mint ElevenLabs single-use token",
            operation_name="create_dialogue_websocket_token",
            token_type=ELEVENLABS_DIALOGUE_WEBSOCKET_TOKEN_TYPE,
        )
    except ApiError as exc:
        _raise_from_api_error(exc, fallback_detail="Failed to mint ElevenLabs single-use token")

    token = getattr(response, "token", None)
    if not isinstance(token, str) or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="ElevenLabs token response did not include a token",
        )
    return token.strip()


async def ensure_elevenlabs_voice_accessible(*, voice_id: str, use_cache: bool = True) -> None:
    normalized_voice_id = voice_id.strip()
    if not normalized_voice_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Configured ElevenLabs voice id is blank",
        )

    if use_cache:
        cached = _get_voice_access_cache_entry(normalized_voice_id)
        if cached is not None:
            if cached.status_code is None:
                return
            _raise_cached_voice_access_failure(normalized_voice_id, cached)

    client = get_elevenlabs_client()
    try:
        await _call_elevenlabs(
            client.voices.get,
            normalized_voice_id,
            fallback_detail="Failed to validate ElevenLabs voice",
            operation_name="get_elevenlabs_voice",
        )
    except HTTPException as exc:
        if exc.status_code in {
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
        }:
            unavailable_exc = HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Configured ElevenLabs voice is not available to the current "
                    f"ElevenLabs API key: {normalized_voice_id}"
                ),
            )
            _store_voice_access_cache_failure(normalized_voice_id, unavailable_exc)
            raise unavailable_exc from exc
        raise
    except ApiError as exc:
        if isinstance(exc.status_code, int) and exc.status_code in {
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
        }:
            unavailable_exc = HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Configured ElevenLabs voice is not available to the current "
                    f"ElevenLabs API key: {normalized_voice_id}"
                ),
            )
            _store_voice_access_cache_failure(normalized_voice_id, unavailable_exc)
            raise unavailable_exc from exc
        _raise_from_api_error(exc, fallback_detail="Failed to validate ElevenLabs voice")
    _store_voice_access_cache_success(normalized_voice_id)


async def validate_elevenlabs_voice_profile(profile: PyElevenLabsAnimaVoiceProfileInput) -> None:
    """Freshly validate and cache an anima ElevenLabs voice profile at save time."""

    voice_id = profile.primary_voice.voice_id.strip()
    clear_elevenlabs_voice_access_cache(voice_id=voice_id)
    await ensure_elevenlabs_voice_accessible(voice_id=voice_id, use_cache=False)


async def resolve_realtime_tts_session(
    *,
    voice: VoiceResolver,
    language_code: str | None,
    model_id: ElevenLabsRealtimeTtsModelId | str | None,
) -> PyElevenLabsRealtimeTtsSessionResponse:
    """Describe a direct realtime socket session; ``voice`` resolves the Anima's voice after the key check."""

    _require_api_key()
    selected_model_id = resolve_realtime_tts_model_id(model_id)
    resolved = await voice()
    await ensure_elevenlabs_voice_accessible(voice_id=resolved.voice_id)

    return PyElevenLabsRealtimeTtsSessionResponse(
        voice_id=resolved.voice_id,
        model_id=selected_model_id,
        output_format=ELEVENLABS_REALTIME_TTS_OUTPUT_FORMAT,
        sync_alignment=ELEVENLABS_REALTIME_TTS_SYNC_ALIGNMENT,
        language_code=language_code.strip() if isinstance(language_code, str) and language_code.strip() else None,
        websocket_base_url=ELEVENLABS_REALTIME_TTS_WEBSOCKET_BASE_URL,
        token=await mint_dialogue_websocket_single_use_token(),
    )


class LocalSpeech:
    """The local composition's speech port: ElevenLabs with the process credential store.

    Cloned voices carry the owner's label, and text-to-speech only speaks with a
    voice labelled for the caller.
    """

    def __init__(self, app_settings: Settings) -> None:
        self._settings = app_settings

    @property
    def audio_upload_max_bytes(self) -> int:
        return self._settings.elevenlabs_audio_max_upload_bytes

    async def clone_voice(
        self,
        principal: RequestPrincipal,
        *,
        name: str,
        files: list[tuple[str, bytes, str]],
        description: str | None,
        remove_background_noise: bool,
    ) -> PyElevenLabsVoice:
        return await clone_voice(
            user_id=principal.id,
            name=name,
            files=files,
            description=description,
            remove_background_noise=remove_background_noise,
        )

    async def synthesize_text(
        self, principal: RequestPrincipal, request: PyElevenLabsTextToSpeechRequest
    ) -> PyElevenLabsAudioResponse:
        return await synthesize_text(user_id=principal.id, request=request)

    async def generate_sound_effect(
        self, principal: RequestPrincipal, request: PyElevenLabsSoundEffectsRequest
    ) -> PyElevenLabsAudioResponse:
        return await generate_sound_effect(request)

    async def realtime_session(
        self,
        principal: RequestPrincipal,
        *,
        voice: VoiceResolver,
        language_code: str | None,
        model_id: str | None,
    ) -> PyElevenLabsRealtimeTtsSessionResponse:
        return await resolve_realtime_tts_session(voice=voice, language_code=language_code, model_id=model_id)
