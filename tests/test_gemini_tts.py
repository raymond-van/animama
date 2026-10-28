"""Gemini text-to-speech: key handling, contracts, speaking style and the voice service.

The service is driven through a duck-typed fake SDK client that streams scripted
Interactions events, so no key or network is used.
"""

from __future__ import annotations

import base64
import logging
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from animama.app.chat.options import merge_chat_request_options
from animama.app.contracts.dispatch import PyAnimaTtsRunOptions
from animama.app.contracts.gemini import DEFAULT_GEMINI_VOICE, GEMINI_PREBUILT_VOICES, gemini_tts_capability
from animama.app.model_clients.credential_store import (
    GEMINI_CREDENTIAL_ENV,
    KNOWN_PROVIDER_CREDENTIAL_ENVS,
    is_allowed_credential_env,
    is_deliverable_credential_env,
    is_process_credential_env,
)
from animama.app.voice_emotional_tone import gemini_speaking_style
from animama.domain.request_principal import RequestPrincipal
from animama.product_http.ports import ProductRefusal
from animama.product_http.routes import runtime_capabilities
from animama.server import gemini_tts_service
from animama.server.config import Settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.finalized_speech import FINALIZED_TTS_PCM_FRAME_BYTES
from animama.server.gemini_tts_service import (
    GeminiFinalizedSpeech,
    prepare_gemini_finalized_speech,
    stream_gemini_finalized_speech,
)
from animama.server.runtime_credentials import runtime_credentials
from tests.gemini_support import (
    FakeInteractions as _FakeInteractions,
    audio_event as _audio,
    completed_event as _completed,
    install_client as _install_client,
)
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports

KEY = "gemini-key-for-tests"


@pytest.fixture
def gemini_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_credentials, "current", lambda: {GEMINI_CREDENTIAL_ENV: KEY})


def _prepared(**overrides: Any) -> GeminiFinalizedSpeech:
    values: dict[str, Any] = {
        "run_id": "run-1",
        "voice_id": "Kore",
        "model_id": "gemini-3.8-flash-lite-tts",
        "text": "Hello there.",
        "style": "Speak in a happy tone.",
    }
    values.update(overrides)
    return GeminiFinalizedSpeech(**values)


async def _collect(prepared: GeminiFinalizedSpeech) -> list[dict[str, Any]]:
    return [payload async for payload in stream_gemini_finalized_speech(prepared)]


# Key handling


def test_gemini_key_is_loaded_and_deliverable_but_never_nameable_by_owner_connections() -> None:
    assert is_process_credential_env(GEMINI_CREDENTIAL_ENV)
    assert is_deliverable_credential_env(GEMINI_CREDENTIAL_ENV)
    assert GEMINI_CREDENTIAL_ENV not in KNOWN_PROVIDER_CREDENTIAL_ENVS
    assert not is_allowed_credential_env(GEMINI_CREDENTIAL_ENV)
    assert not is_allowed_credential_env("GOOGLE_API_KEY")
    assert not is_process_credential_env("GOOGLE_API_KEY")


# Contracts


def test_dispatch_accepts_gemini_and_its_models_only() -> None:
    options = PyAnimaTtsRunOptions(enabled=True, provider="gemini", model_id="gemini-3.8-flash-tts")
    assert options.provider == "gemini"
    with pytest.raises(ValidationError):
        PyAnimaTtsRunOptions(enabled=True, provider="gemini", model_id="gemini-0-unknown-tts")
    with pytest.raises(ValidationError):
        PyAnimaTtsRunOptions(enabled=True, provider="elevenlabs", model_id="gemini-3.8-flash-tts")
    with pytest.raises(ValidationError):
        PyAnimaTtsRunOptions(enabled=True, provider="gemini", model_id="eleven_v4_turbo")


def test_chat_options_keep_gemini_and_drop_unknown_models() -> None:
    kept = merge_chat_request_options(
        request_opts={"tts": {"enabled": True, "provider": "gemini", "model_id": "gemini-3.8-flash-lite-tts"}},
        user_prefs=None,
        anima_prefs=None,
    )
    assert kept.tts is not None
    assert (kept.tts.provider, kept.tts.model_id) == ("gemini", "gemini-3.8-flash-lite-tts")
    dropped = merge_chat_request_options(
        request_opts={"tts": {"enabled": True, "provider": "gemini", "model_id": "gemini-0-unknown-tts"}},
        user_prefs=None,
        anima_prefs=None,
    )
    assert dropped.tts is not None
    assert dropped.tts.model_id is None
    crossed = merge_chat_request_options(
        request_opts={"tts": {"enabled": True, "provider": "elevenlabs", "model_id": "gemini-3.8-flash-tts"}},
        user_prefs=None,
        anima_prefs=None,
    )
    assert crossed.tts is not None
    assert crossed.tts.model_id is None


def test_local_capabilities_offer_gemini_voices() -> None:
    capability = gemini_tts_capability()
    assert capability.default_model == "gemini-3.8-flash-lite-tts"
    assert capability.models == ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]
    assert len(capability.voices) == 30
    assert capability.default_voice == DEFAULT_GEMINI_VOICE == "Kore"


# Speaking style


@pytest.mark.parametrize(
    ("tone", "state", "style"),
    [
        (None, None, "Speak in a friendly tone."),
        ("neutral", {"joy": 16}, "Speak in a friendly tone."),
        ("joy", None, "Speak in a happy tone."),
        ("joy", {"joy": 0}, "Speak in a slightly happy tone."),
        ("joy", {"joy": 5}, "Speak in a happy tone."),
        ("joy", {"joy": 16}, "Speak in a very happy tone."),
        ("sad", {"sadness": 100}, "Speak in a very sad tone."),
        ("excitement", None, "Speak in an excited tone."),
        ("anger", {"anger": 5}, "Speak in an angry tone."),
        ("anger", {"anger": 0}, "Speak in a slightly angry tone."),
    ],
)
def test_speaking_style_follows_the_tone_and_its_level(
    tone: str | None, state: dict[str, int] | None, style: str
) -> None:
    assert gemini_speaking_style(emotional_tone=tone, emotional_state=state) == style


# Preparing a segment


@pytest.mark.asyncio
async def test_prepare_without_a_key_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_credentials, "current", lambda: {})
    with pytest.raises(ProductRefusal) as refused:
        await prepare_gemini_finalized_speech(
            voice_id="Kore",
            run_id="run-1",
            text="Hello.",
            model_id=None,
            emotional_tone=None,
            emotional_state=None,
        )
    assert refused.value.code == "gemini_tts_missing_credential"


@pytest.mark.asyncio
async def test_prepare_falls_back_to_the_default_voice_and_model(gemini_key: None) -> None:
    prepared = await prepare_gemini_finalized_speech(
        voice_id="NotAVoice",
        run_id="run-1",
        text="Hello.",
        model_id="eleven_v4_turbo",
        emotional_tone="joy",
        emotional_state={"joy": 16},
    )
    assert (prepared.voice_id, prepared.model_id) == ("Kore", "gemini-3.8-flash-lite-tts")
    assert prepared.text == "Hello."
    assert prepared.style == "Speak in a very happy tone."
    assert prepared.output_format == "pcm_24000"


@pytest.mark.asyncio
async def test_prepare_keeps_a_prebuilt_voice_and_always_sets_the_style(gemini_key: None) -> None:
    """Every segment speaks in the reply's style; without a mood the tone has no intensity word."""

    prepared = await prepare_gemini_finalized_speech(
        voice_id=GEMINI_PREBUILT_VOICES[-1],
        run_id="run-1",
        text="Hello.",
        model_id="gemini-3.8-flash-tts",
        emotional_tone="joy",
        emotional_state=None,
    )
    assert (prepared.voice_id, prepared.model_id, prepared.style) == (
        "Sulafat",
        "gemini-3.8-flash-tts",
        "Speak in a happy tone.",
    )


@pytest.mark.parametrize(
    "text",
    [
        # Gemini reads numbers and symbols itself.
        "Call 100 at 3:30 pm, it's 72°F.",
        "今日は3時です。",
    ],
)
@pytest.mark.asyncio
async def test_prepare_speaks_the_text_as_written(gemini_key: None, text: str) -> None:
    prepared = await prepare_gemini_finalized_speech(
        voice_id="Kore",
        run_id="run-1",
        text=text,
        model_id=None,
        emotional_tone=None,
        emotional_state=None,
    )

    assert prepared.text == text


# Streaming a segment


@pytest.mark.asyncio
async def test_stream_sends_one_unstored_request_and_reframes_audio(
    gemini_key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    chunk = b"\x01\x00" * 1920  # 3,840 bytes, the size Gemini streams
    interactions = _FakeInteractions(
        events=[SimpleNamespace(event_type="interaction.created"), *[_audio(chunk)] * 3, _completed()]
    )
    keys = _install_client(monkeypatch, interactions)

    payloads = await _collect(_prepared())

    assert keys == [KEY]
    assert interactions.calls == [
        {
            "model": "gemini-3.8-flash-lite-tts",
            "input": [
                {
                    "type": "user_input",
                    "content": [
                        {
                            "type": "text",
                            "text": "Hello there.",
                            "annotations": [{"type": "speech_metadata", "style": "Speak in a happy tone."}],
                        }
                    ],
                }
            ],
            "response_format": {"type": "audio", "mime_type": "audio/l16", "sample_rate": 24000},
            "generation_config": {"speech_config": [{"voice": "Kore"}]},
            "store": False,
            "stream": True,
        }
    ]
    audio = [base64.b64decode(payload["audio_base64"]) for payload in payloads if payload["type"] == "audio"]
    assert b"".join(audio) == chunk * 3
    assert len(audio[0]) >= FINALIZED_TTS_PCM_FRAME_BYTES
    assert payloads[-1] == {
        "type": "done",
        "run_id": "run-1",
        "model_id": "gemini-3.8-flash-lite-tts",
        "output_format": "pcm_24000",
    }


@pytest.mark.asyncio
async def test_stream_without_a_style_sends_plain_text(gemini_key: None, monkeypatch: pytest.MonkeyPatch) -> None:
    interactions = _FakeInteractions(events=[_audio(b"\x00\x00"), _completed()])
    _install_client(monkeypatch, interactions)

    await _collect(_prepared(style=None))

    assert interactions.calls[0]["input"][0]["content"] == [{"type": "text", "text": "Hello there."}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("events", "error"),
    [
        (
            [SimpleNamespace(event_type="error", error=SimpleNamespace(code="internal"))],
            "Gemini text-to-speech failed.",
        ),
        ([_audio(b"\x00\x00"), _completed("incomplete")], "Gemini text-to-speech ended before completing."),
        ([_audio(b"\x00\x00")], "Gemini text-to-speech ended before completing."),
    ],
)
async def test_stream_reports_failed_or_unfinished_audio(
    gemini_key: None, monkeypatch: pytest.MonkeyPatch, events: list[Any], error: str
) -> None:
    _install_client(monkeypatch, _FakeInteractions(events=events))

    payloads = await _collect(_prepared())

    assert payloads[-1]["type"] == "error"
    assert payloads[-1]["code"] == "gemini_tts_stream_failed"
    assert payloads[-1]["error"] == error
    assert all(payload["type"] != "done" for payload in payloads)


QUOTA_TEXT = (
    "Gemini's rate limit or daily quota was reached (HTTP 429). Try again later, or raise your Gemini API tier."
)


@pytest.mark.parametrize(
    ("status_code", "error"),
    [(500, "Gemini text-to-speech failed (HTTP 500)."), (429, QUOTA_TEXT)],
)
@pytest.mark.asyncio
async def test_stream_error_names_only_the_status_and_never_the_text_or_key(
    gemini_key: None,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    status_code: int,
    error: str,
) -> None:
    class _ProviderError(Exception):
        pass

    failure = _ProviderError(f"quota for {KEY}: Hello there.")
    failure.status_code = status_code  # type: ignore[attr-defined]
    _install_client(monkeypatch, _FakeInteractions(error=failure))
    # Capture at the service logger itself: an earlier logging configuration in the
    # same process can disable loggers that already exist.
    service_logger = gemini_tts_service._log.logger
    monkeypatch.setattr(service_logger, "disabled", False)
    caplog.set_level(logging.WARNING, logger=service_logger.name)
    service_logger.addHandler(caplog.handler)
    try:
        payloads = await _collect(_prepared())
    finally:
        service_logger.removeHandler(caplog.handler)

    assert payloads == [
        {
            "type": "error",
            "run_id": "run-1",
            "model_id": "gemini-3.8-flash-lite-tts",
            "output_format": "pcm_24000",
            "error": error,
            "code": "gemini_tts_stream_failed",
        }
    ]
    # Keyword arguments become record extras, which the file log writes out.
    assert caplog.records
    assert all(
        KEY not in str(record.__dict__) and "Hello there" not in str(record.__dict__) for record in caplog.records
    )


@pytest.mark.asyncio
async def test_stream_without_a_key_reports_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_credentials, "current", lambda: {})

    payloads = await _collect(_prepared())

    assert [(payload["type"], payload["code"]) for payload in payloads] == [("error", "gemini_tts_missing_credential")]


@pytest.mark.asyncio
async def test_stream_reports_a_client_setup_failure_safely(gemini_key: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def _broken_client(_api_key: str) -> Any:
        raise RuntimeError(f"configuration drift for {KEY}")

    monkeypatch.setattr(gemini_tts_service, "_client", _broken_client)

    payloads = await _collect(_prepared())

    assert [(payload["type"], payload["error"]) for payload in payloads] == [("error", "Gemini text-to-speech failed.")]


def test_a_changed_key_builds_a_new_client(monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[str] = []

    def _build(*, api_key: str, timeout_ms: int) -> object:
        built.append(api_key)
        return object()

    monkeypatch.setattr(gemini_tts_service, "_client_cache", None)
    monkeypatch.setattr("animama.adapters.voice.gemini_client.gemini_sdk_client", _build)

    first = gemini_tts_service._client("key-one")
    assert gemini_tts_service._client("key-one") is first
    assert gemini_tts_service._client("key-two") is not first
    assert built == ["key-one", "key-two"]


async def test_local_runtime_capabilities_offer_gemini_voice(async_session, tmp_path) -> None:  # noqa: ANN001
    app = FastAPI()
    app.state.runtime_settings = Settings(
        animama_content_root=tmp_path / "content",
        animama_data_root=tmp_path / "data",
        animama_user_file_processing_enabled=False,
    )
    app.state.local_runtime_paths = SimpleNamespace(included_sources=(), operations_root=tmp_path / "operations")
    app.include_router(runtime_capabilities.router)
    install_local_ports(app, async_session)

    async def principal() -> RequestPrincipal:
        return RequestPrincipal(id="gemini-owner")

    async def database():  # noqa: ANN202
        yield async_session

    app.dependency_overrides[get_current_principal] = principal
    app.dependency_overrides[get_async_session] = database
    async with local_client(app) as client:
        capabilities = (await client.get("/v1/runtime-capabilities")).json()

    assert capabilities["gemini_tts"] == gemini_tts_capability().model_dump(mode="json")
