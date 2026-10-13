from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from typing import Any

import pytest
from elevenlabs.core import ApiError
from fastapi import HTTPException
from pydantic import ValidationError

from animama.product_http.chat.tts import resolve_realtime_voice_from_preferences
from animama.server.elevenlabs_service import (
    clear_elevenlabs_voice_access_cache,
    clone_voice,
    ensure_elevenlabs_voice_accessible,
    generate_sound_effect,
    get_owned_voice,
    isolate_audio,
    mint_dialogue_websocket_single_use_token,
    normalize_voice_profile,
    resolve_realtime_tts_model_id,
    synthesize_text,
    validate_elevenlabs_voice_profile,
)
from animama.server.schemas.elevenlabs import (
    PyElevenLabsAnimaVoiceProfileInput,
    PyElevenLabsSoundEffectsRequest,
    PyElevenLabsTextToSpeechRequest,
    PyElevenLabsVoiceSettings,
)


class _FakeVoicesIvcClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(voice_id="voice-created", requires_verification=False)


class _FakeVoicesClient:
    def __init__(self) -> None:
        self.ivc = _FakeVoicesIvcClient()
        self.by_id: dict[str, object] = {
            "voice-created": SimpleNamespace(
                voice_id="voice-created",
                name="Created Voice",
                description="Primary clone",
                preview_url="https://preview.example/voice-created.mp3",
                labels={"app": "anima", "owner_user_id": "user-1", "source": "ivc"},
                category="cloned",
            ),
            "voice-owned": SimpleNamespace(
                voice_id="voice-owned",
                name="Owned Voice",
                description="Owned by user",
                preview_url="https://preview.example/voice-owned.mp3",
                labels={"app": "anima", "owner_user_id": "user-1", "source": "ivc"},
                category="cloned",
            ),
            "voice-foreign": SimpleNamespace(
                voice_id="voice-foreign",
                name="Foreign Voice",
                description="Not owned",
                preview_url=None,
                labels={"app": "anima", "owner_user_id": "user-2", "source": "ivc"},
                category="cloned",
            ),
        }
        self.get_calls: list[str] = []

    def get(self, voice_id: str):
        self.get_calls.append(voice_id)
        return self.by_id[voice_id]


class _FakeTextToDialogueClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.outcomes: list[object] = []

    def convert(self, **kwargs):
        self.calls.append(kwargs)
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return iter([b"hello", b" ", b"world"])


class _FakeTextToSoundEffectsClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def convert(self, **kwargs):
        self.calls.append(kwargs)
        return iter([b"sfx-bytes"])


class _FakeAudioIsolationClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def convert(self, **kwargs):
        self.calls.append(kwargs)
        return iter([b"isolated-audio"])


class _FakeElevenLabsClient:
    def __init__(self) -> None:
        self.voices = _FakeVoicesClient()
        self.text_to_dialogue = _FakeTextToDialogueClient()
        self.text_to_sound_effects = _FakeTextToSoundEffectsClient()
        self.audio_isolation = _FakeAudioIsolationClient()
        self.tokens = SimpleNamespace(single_use=SimpleNamespace(create=self._create_single_use_token))
        self.single_use_token_calls: list[dict[str, Any]] = []
        self.single_use_token_outcomes: list[object] = []

    def _create_single_use_token(self, **kwargs):
        self.single_use_token_calls.append(kwargs)
        if self.single_use_token_outcomes:
            outcome = self.single_use_token_outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return SimpleNamespace(token="sutkn_123")


@pytest.fixture
def fake_client(monkeypatch) -> _FakeElevenLabsClient:
    client = _FakeElevenLabsClient()
    monkeypatch.setattr("animama.server.elevenlabs_service.get_elevenlabs_client", lambda: client)
    return client


@pytest.fixture(autouse=True)
def _clear_voice_access_cache():
    clear_elevenlabs_voice_access_cache()
    yield
    clear_elevenlabs_voice_access_cache()


@pytest.mark.asyncio
async def test_clone_voice_labels_new_voice(fake_client: _FakeElevenLabsClient) -> None:
    voice = await clone_voice(
        user_id="user-1",
        name="Astra",
        files=[("sample.wav", b"audio-bytes", "audio/wav")],
        description="Clone for Astra",
        remove_background_noise=False,
    )

    assert voice.voice_id == "voice-created"
    create_call = fake_client.voices.ivc.calls[0]
    labels = json.loads(create_call["labels"])
    assert labels["owner_user_id"] == "user-1"
    assert labels["source"] == "ivc"


@pytest.mark.asyncio
async def test_get_owned_voice_rejects_foreign_voice(fake_client: _FakeElevenLabsClient) -> None:
    with pytest.raises(HTTPException) as exc_info:
        await get_owned_voice(user_id="user-1", voice_id="voice-foreign")

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_synthesize_text_returns_base64_audio(fake_client: _FakeElevenLabsClient) -> None:
    response = await synthesize_text(
        user_id="user-1",
        request=PyElevenLabsTextToSpeechRequest(
            voice_id="voice-owned",
            text="hello world",
            output_format="mp3_44100_128",
        ),
    )

    assert base64.b64decode(response.audio_base64) == b"hello world"
    assert response.media_type == "audio/mpeg"
    # The utility route speaks with Eleven v4 Turbo through Text to Dialogue.
    assert fake_client.text_to_dialogue.calls == [
        {
            "inputs": [{"text": "hello world", "voice_id": "voice-owned"}],
            "model_id": "eleven_v4_turbo",
            "output_format": "mp3_44100_128",
            "settings": None,
        }
    ]


@pytest.mark.asyncio
async def test_synthesize_text_sends_the_settings_eleven_v4_supports(fake_client: _FakeElevenLabsClient) -> None:
    await synthesize_text(
        user_id="user-1",
        request=PyElevenLabsTextToSpeechRequest(
            voice_id="voice-owned",
            text="hello",
            model_id="eleven_v4_turbo",
            voice_settings=PyElevenLabsVoiceSettings(stability=0.4, similarity_boost=0.8),
        ),
    )

    [call] = fake_client.text_to_dialogue.calls
    assert call["model_id"] == "eleven_v4_turbo"
    assert call["settings"] == {"stability": 0.4, "similarity": 0.8}


def test_text_to_speech_request_refuses_settings_eleven_v4_ignores() -> None:
    with pytest.raises(ValidationError):
        PyElevenLabsVoiceSettings.model_validate({"stability": 0.4, "style": 0.3})


@pytest.mark.parametrize("retired_model_id", ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3"])
def test_text_to_speech_request_maps_retired_models(retired_model_id: str) -> None:
    request = PyElevenLabsTextToSpeechRequest(voice_id="voice-owned", text="hi", model_id=retired_model_id)
    assert request.model_id == "eleven_v4_turbo"


def test_text_to_speech_request_refuses_text_over_the_dialogue_limit() -> None:
    """Text to Dialogue takes at most 2,000 characters a request, so longer utility text is refused."""

    assert len(PyElevenLabsTextToSpeechRequest(voice_id="voice-owned", text="a" * 2_000).text) == 2_000
    with pytest.raises(ValidationError):
        PyElevenLabsTextToSpeechRequest(voice_id="voice-owned", text="a" * 2_001)


@pytest.mark.asyncio
async def test_synthesize_text_retries_retryable_429(
    fake_client: _FakeElevenLabsClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client.text_to_dialogue.outcomes = [
        ApiError(
            status_code=429,
            headers={"retry-after": "1"},
            body={
                "detail": {
                    "code": "rate_limit_exceeded",
                    "message": "Rate limit exceeded, please retry after 1 seconds",
                }
            },
        ),
        iter([b"retry-success"]),
    ]
    sleep_calls: list[float] = []

    async def _fake_sleep(delay: float) -> None:
        sleep_calls.append(delay)

    monkeypatch.setattr("animama.server.elevenlabs_service.asyncio.sleep", _fake_sleep)
    monkeypatch.setattr("animama.server.elevenlabs_service.random.random", lambda: 0.0)
    monkeypatch.setattr("animama.server.config.settings.elevenlabs_max_retries", 1)

    response = await synthesize_text(
        user_id="user-1",
        request=PyElevenLabsTextToSpeechRequest(
            voice_id="voice-owned",
            text="hello after retry",
            output_format="mp3_44100_128",
        ),
    )

    assert base64.b64decode(response.audio_base64) == b"retry-success"
    assert len(fake_client.text_to_dialogue.calls) == 2
    assert sleep_calls == [1.0]


@pytest.mark.asyncio
async def test_synthesize_text_exposes_retryable_concurrency_error(
    fake_client: _FakeElevenLabsClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client.text_to_dialogue.outcomes = [
        ApiError(
            status_code=429,
            headers={
                "current-concurrent-requests": "2",
                "maximum-concurrent-requests": "2",
            },
            body={
                "detail": {
                    "code": "concurrent_limit_exceeded",
                    "message": "Too many concurrent requests are in progress",
                }
            },
        ),
        ApiError(
            status_code=429,
            headers={
                "current-concurrent-requests": "2",
                "maximum-concurrent-requests": "2",
            },
            body={
                "detail": {
                    "code": "concurrent_limit_exceeded",
                    "message": "Too many concurrent requests are in progress",
                }
            },
        ),
    ]

    async def _fake_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr("animama.server.elevenlabs_service.asyncio.sleep", _fake_sleep)
    monkeypatch.setattr("animama.server.config.settings.elevenlabs_max_retries", 1)

    with pytest.raises(HTTPException) as exc_info:
        await synthesize_text(
            user_id="user-1",
            request=PyElevenLabsTextToSpeechRequest(
                voice_id="voice-owned",
                text="still busy",
                output_format="mp3_44100_128",
            ),
        )

    assert exc_info.value.status_code == 429
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail == {
        "provider": "elevenlabs",
        "code": "concurrent_limit_exceeded",
        "message": "Too many concurrent requests are in progress",
        "retryable": True,
        "current_concurrent_requests": 2,
        "maximum_concurrent_requests": 2,
    }


@pytest.mark.asyncio
async def test_generate_sound_effect_returns_audio(fake_client: _FakeElevenLabsClient) -> None:
    response = await generate_sound_effect(
        PyElevenLabsSoundEffectsRequest(
            text="A heavy metal gate slamming shut",
            output_format="mp3_44100_128",
        )
    )

    assert base64.b64decode(response.audio_base64) == b"sfx-bytes"
    assert response.media_type == "audio/mpeg"
    sound_effect_call = fake_client.text_to_sound_effects.calls[0]
    assert sound_effect_call["loop"] is Ellipsis
    assert sound_effect_call["duration_seconds"] is Ellipsis
    assert sound_effect_call["prompt_influence"] is Ellipsis


@pytest.mark.asyncio
async def test_isolate_audio_returns_audio(fake_client: _FakeElevenLabsClient) -> None:
    response = await isolate_audio(
        filename="sample.wav",
        audio_bytes=b"raw-audio",
        file_format="other",
    )

    assert base64.b64decode(response.audio_base64) == b"isolated-audio"
    assert response.file_name == "isolated-audio"


def test_normalize_voice_profile_ignores_legacy_variants() -> None:
    profile = PyElevenLabsAnimaVoiceProfileInput.model_validate(
        {
            "primary_voice": {"voice_id": "voice-primary"},
            "variants": {"joy_2": {"voice_id": "voice-joy-2"}},
        }
    )

    normalized = normalize_voice_profile(profile)

    assert normalized["primary_voice"]["voice_id"] == "voice-primary"
    assert "variants" not in normalized


def test_resolve_realtime_voice_from_preferences_uses_primary_voice_only() -> None:
    # Emotion variants are stored but never chosen: every reply speaks with the primary voice.
    preferences = {
        "speech": {
            "elevenlabs": {
                "primary_voice": {"voice_id": "voice-primary"},
                "variants": {
                    "sad_1": {"voice_id": "voice-sad-1"},
                    "joy_2": {"voice_id": "voice-joy-2"},
                },
            }
        }
    }

    assert resolve_realtime_voice_from_preferences(preferences).voice_id == "voice-primary"


def test_resolve_realtime_voice_from_preferences_rejects_missing_profile() -> None:
    with pytest.raises(HTTPException) as exc_info:
        resolve_realtime_voice_from_preferences({"speech": {}})

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_mint_dialogue_websocket_single_use_token(fake_client: _FakeElevenLabsClient) -> None:
    """The Text to Dialogue socket refuses ``tts_websocket`` tokens; it needs ``ttd_websocket``."""

    token = await mint_dialogue_websocket_single_use_token()

    assert token == "sutkn_123"
    assert fake_client.single_use_token_calls == [{"token_type": "ttd_websocket"}]


@pytest.mark.asyncio
async def test_mint_dialogue_websocket_single_use_token_surfaces_api_error(
    fake_client: _FakeElevenLabsClient,
) -> None:
    fake_client.single_use_token_outcomes = [ApiError(status_code=502, body={"detail": "upstream unavailable"})]

    with pytest.raises(HTTPException) as exc_info:
        await mint_dialogue_websocket_single_use_token()

    assert exc_info.value.status_code == 502


def test_realtime_tts_model_defaults_to_eleven_v4_turbo() -> None:
    assert resolve_realtime_tts_model_id(None) == "eleven_v4_turbo"
    assert resolve_realtime_tts_model_id(" ") == "eleven_v4_turbo"
    assert resolve_realtime_tts_model_id("eleven_v4_turbo") == "eleven_v4_turbo"


@pytest.mark.parametrize("legacy_model_id", ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3"])
def test_realtime_tts_model_maps_retired_models_to_eleven_v4_turbo(legacy_model_id: str) -> None:
    assert resolve_realtime_tts_model_id(legacy_model_id) == "eleven_v4_turbo"


@pytest.mark.parametrize("model_id", ["eleven_turbo_v2", "eleven_v4"])
def test_realtime_tts_model_rejects_unknown_models(model_id: str) -> None:
    """Unknown ids are refused, including the removed finalized ``eleven_v4``."""

    with pytest.raises(HTTPException) as exc_info:
        resolve_realtime_tts_model_id(model_id)

    assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_ensure_elevenlabs_voice_accessible_rejects_inaccessible_voice(
    fake_client: _FakeElevenLabsClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client.voices.get_calls.clear()

    def _raise_not_found(_voice_id: str):
        raise ApiError(
            status_code=404,
            body={"detail": "A voice with this voice_id does not exist."},
        )

    monkeypatch.setattr(fake_client.voices, "get", _raise_not_found)

    with pytest.raises(HTTPException) as exc_info:
        await ensure_elevenlabs_voice_accessible(voice_id="voice-missing")

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == (
        "Configured ElevenLabs voice is not available to the current ElevenLabs API key: voice-missing"
    )


@pytest.mark.asyncio
async def test_ensure_elevenlabs_voice_accessible_uses_positive_cache(
    fake_client: _FakeElevenLabsClient,
) -> None:
    fake_client.voices.get_calls.clear()

    await ensure_elevenlabs_voice_accessible(voice_id="voice-owned")
    await ensure_elevenlabs_voice_accessible(voice_id="voice-owned")

    assert fake_client.voices.get_calls == ["voice-owned"]


@pytest.mark.asyncio
async def test_ensure_elevenlabs_voice_accessible_uses_short_negative_cache(
    fake_client: _FakeElevenLabsClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def _raise_not_found(voice_id: str):
        calls.append(voice_id)
        raise ApiError(
            status_code=404,
            body={"detail": "A voice with this voice_id does not exist."},
        )

    monkeypatch.setattr(fake_client.voices, "get", _raise_not_found)

    for _ in range(2):
        with pytest.raises(HTTPException) as exc_info:
            await ensure_elevenlabs_voice_accessible(voice_id="voice-missing")
        assert exc_info.value.status_code == 409

    assert calls == ["voice-missing"]


@pytest.mark.asyncio
async def test_validate_elevenlabs_voice_profile_fresh_validates_and_primes_cache(
    fake_client: _FakeElevenLabsClient,
) -> None:
    profile = PyElevenLabsAnimaVoiceProfileInput.model_validate({"primary_voice": {"voice_id": "voice-owned"}})
    fake_client.voices.get_calls.clear()

    await validate_elevenlabs_voice_profile(profile)
    await ensure_elevenlabs_voice_accessible(voice_id="voice-owned")

    assert fake_client.voices.get_calls == ["voice-owned"]


@pytest.mark.asyncio
async def test_local_speech_port_acts_as_the_requesting_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    from animama.domain.request_principal import RequestPrincipal
    from animama.server import elevenlabs_service
    from animama.server.config import Settings

    calls: list[tuple[str, dict[str, Any]]] = []

    async def record(operation: str, /, **kwargs: Any) -> str:
        calls.append((operation, kwargs))
        return operation

    monkeypatch.setattr(elevenlabs_service, "clone_voice", lambda **kwargs: record("clone", **kwargs))
    monkeypatch.setattr(elevenlabs_service, "synthesize_text", lambda **kwargs: record("speak", **kwargs))
    monkeypatch.setattr(elevenlabs_service, "generate_sound_effect", lambda request: record("effect", request=request))
    speech = elevenlabs_service.LocalSpeech(Settings(elevenlabs_audio_max_upload_bytes=123))
    owner = RequestPrincipal(id="owner-1")
    tts = PyElevenLabsTextToSpeechRequest(voice_id="voice-owned", text="Hi")
    effect = PyElevenLabsSoundEffectsRequest(text="Rain")

    await speech.clone_voice(owner, name="Wren", files=[], description=None, remove_background_noise=True)
    await speech.synthesize_text(owner, tts)
    await speech.generate_sound_effect(owner, effect)

    # Voice ownership labels and checks use the caller's ID.
    assert calls == [
        (
            "clone",
            {"user_id": "owner-1", "name": "Wren", "files": [], "description": None, "remove_background_noise": True},
        ),
        ("speak", {"user_id": "owner-1", "request": tts}),
        ("effect", {"request": effect}),
    ]
    assert speech.audio_upload_max_bytes == 123
