from __future__ import annotations

from typing import Any

import pytest

from animama.app.contracts.elevenlabs import PyElevenLabsVoice
from animama.app.voice_emotional_tone import normalize_elevenlabs_emotional_tone
from animama.server.app import app
from animama.server.elevenlabs_service import resolve_realtime_tts_session


async def _primary_voice() -> PyElevenLabsVoice:
    """The Anima's voice, as the chat route's resolver reads it from the owner's settings."""

    return PyElevenLabsVoice(voice_id="voice-primary")


def test_removed_elevenlabs_tts_proxy_routes_are_not_registered() -> None:
    paths = {getattr(route, "path", None) for route in app.routes}

    assert "/v1/animas/{anima_id}/tts/elevenlabs:stream" not in paths
    assert "/v1/elevenlabs/realtime-tts/session" not in paths
    assert "/v1/elevenlabs/realtime-tts/ws" not in paths


def test_elevenlabs_tone_helper_maps_canonical_emotion_to_tone_key() -> None:
    tone = normalize_elevenlabs_emotional_tone("joy")

    assert tone is not None
    assert tone.canonical_emotion == "joy"
    assert tone.tone_key == "happy"


def test_elevenlabs_tone_helper_maps_tone_key_to_canonical_emotion() -> None:
    tone = normalize_elevenlabs_emotional_tone("scared")

    assert tone is not None
    assert tone.canonical_emotion == "fear"
    assert tone.tone_key == "scared"


@pytest.mark.asyncio
async def test_realtime_tts_session_is_direct_only(
    monkeypatch: pytest.MonkeyPatch, set_runtime_credentials: Any
) -> None:
    set_runtime_credentials(ELEVENLABS_API_KEY="test-elevenlabs-key")
    voice_access_checks: list[str] = []

    async def _fake_ensure_voice_accessible(*, voice_id: str) -> None:
        voice_access_checks.append(voice_id)

    async def _fake_mint_token() -> str:
        return "sutkn-direct"

    monkeypatch.setattr(
        "animama.server.elevenlabs_service.ensure_elevenlabs_voice_accessible",
        _fake_ensure_voice_accessible,
    )
    monkeypatch.setattr(
        "animama.server.elevenlabs_service.mint_dialogue_websocket_single_use_token",
        _fake_mint_token,
    )

    payload = await resolve_realtime_tts_session(
        voice=_primary_voice,
        language_code="en",
        model_id="eleven_v4_turbo",
    )

    assert payload.voice_id == "voice-primary"
    assert payload.model_id == "eleven_v4_turbo"
    assert payload.output_format == "pcm_24000"
    # Character timing is always requested with the audio.
    assert payload.sync_alignment is True
    assert payload.language_code == "en"
    assert payload.token == "sutkn-direct"
    assert payload.websocket_base_url == "wss://api.elevenlabs.io"
    assert not hasattr(payload, "use_backend_intermediary")
    assert not hasattr(payload, "proxy_ws_path")
    assert voice_access_checks == ["voice-primary"]
