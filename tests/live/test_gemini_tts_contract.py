"""Opt-in live check of Gemini text-to-speech through the Interactions API.

It records what a Gemini voice provider would rely on (docs/plans/gemini-tts):
time to first audio, chunk sizes, format, sample rate, byte order and whether a
speaking style is accepted, on both 3.8 TTS models. It makes paid requests, so
it runs only with ``ANIMAMA_RUN_LIVE_TESTS=1`` and a real ``GEMINI_API_KEY``.
Run with ``-s`` to see the measurements; no key or audio is printed or saved.
"""

from __future__ import annotations

import base64
import json
import os
import statistics
import time
from typing import Any, Literal

import pytest

from animama.adapters.voice.gemini_client import gemini_sdk_client

TTS_MODELS = ("gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts")
VOICE = "Kore"
SAMPLE_RATE = 24_000
INPUTS = {
    "one_sentence": "Good morning! I hope you slept well.",
    "three_sentences": (
        "Good morning! I hope you slept well. The sun is out and the kettle is on. "
        "Shall we plan something fun for today?"
    ),
}
STYLE = "Say this warmly and cheerfully."


def _api_key() -> str:
    return os.getenv("GEMINI_API_KEY", "").strip()


def _live_enabled() -> bool:
    return os.getenv("ANIMAMA_RUN_LIVE_TESTS") == "1" and _api_key() not in {"", "test-key"}


pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(not _live_enabled(), reason="requires ANIMAMA_RUN_LIVE_TESTS=1 and GEMINI_API_KEY"),
]


def _pcm_step_score(raw: bytes, *, byteorder: Literal["little", "big"]) -> float:
    """Mean absolute difference between neighbouring samples; real speech scores low."""

    count = len(raw) // 2
    if count < 2:
        return 0.0
    samples = [int.from_bytes(raw[index * 2 : index * 2 + 2], byteorder, signed=True) for index in range(count)]
    return sum(abs(samples[index] - samples[index - 1]) for index in range(1, count)) / (count - 1)


async def _synthesize(model: str, text: str, *, style: str | None) -> dict[str, Any]:
    content: dict[str, Any] = {"type": "text", "text": text}
    if style:
        content["annotations"] = [{"type": "speech_metadata", "style": style}]
    client: Any = gemini_sdk_client(api_key=_api_key(), timeout_ms=120_000)
    started = time.perf_counter()
    first_audio: float | None = None
    chunks: list[bytes] = []
    formats: set[str] = set()
    status = None
    stream = await client.aio.interactions.create(
        model=model,
        input=[{"type": "user_input", "content": [content]}],
        response_format={"type": "audio", "mime_type": "audio/l16", "sample_rate": SAMPLE_RATE},
        generation_config={"speech_config": [{"voice": VOICE}]},
        store=False,
        stream=True,
    )
    async for event in stream:
        payload = event.model_dump(mode="json", by_alias=True, exclude_none=True)
        delta = payload.get("delta") or {}
        if payload.get("event_type") == "step.delta" and delta.get("type") == "audio":
            if first_audio is None:
                first_audio = time.perf_counter() - started
            chunks.append(base64.b64decode(delta.get("data") or ""))
            formats.add(f"{delta.get('mime_type')}@{delta.get('sample_rate') or delta.get('rate')}")
        elif payload.get("event_type") == "interaction.completed":
            status = (payload.get("interaction") or {}).get("status")
    raw = b"".join(chunks)
    first_second = raw[: SAMPLE_RATE * 2]
    return {
        "status": status,
        "first_audio_seconds": round(first_audio or 0.0, 2),
        "total_seconds": round(time.perf_counter() - started, 2),
        "chunks": len(chunks),
        "median_chunk_bytes": int(statistics.median(len(chunk) for chunk in chunks)) if chunks else 0,
        "audio_seconds": round(len(raw) / 2 / SAMPLE_RATE, 2),
        "formats": sorted(formats),
        "little_endian_score": round(_pcm_step_score(first_second, byteorder="little"), 1),
        "big_endian_score": round(_pcm_step_score(first_second, byteorder="big"), 1),
    }


async def test_text_to_speech_latency_format_and_style() -> None:
    """Both TTS models, two inputs, with and without a speaking style."""

    measurements = []
    for model in TTS_MODELS:
        for label, text in INPUTS.items():
            for style in (None, STYLE):
                result = await _synthesize(model, text, style=style)
                assert result["status"] == "completed"
                assert result["chunks"] > 0
                measurements.append({"model": model, "input": label, "style": bool(style), **result})
    print(f"[gemini-tts] {json.dumps(measurements, sort_keys=True)}")


async def test_voice_service_streams_a_styled_two_sentence_reply() -> None:
    """The production service: one request per sentence, re-framed PCM, then done."""

    from animama.server.finalized_speech import FINALIZED_TTS_PCM_FRAME_BYTES
    from animama.server.gemini_tts_service import prepare_gemini_finalized_speech, stream_gemini_finalized_speech

    measurements = []
    for text in ("Good morning! ", "I hope you slept well."):
        started = time.perf_counter()
        prepared = await prepare_gemini_finalized_speech(
            voice_id="Puck",
            run_id="live-service",
            text=text,
            model_id="gemini-3.8-flash-lite-tts",
            text_basis="visible_text",
            emotional_tone="joy",
            emotional_state={"joy": 16},
        )
        first_frame: float | None = None
        frames: list[int] = []
        last_type = None
        async for payload in stream_gemini_finalized_speech(prepared):
            last_type = payload["type"]
            if payload["type"] == "audio":
                if first_frame is None:
                    first_frame = time.perf_counter() - started
                frames.append(len(base64.b64decode(payload["audio_base64"])))
        assert last_type == "done"
        assert frames and all(size >= FINALIZED_TTS_PCM_FRAME_BYTES for size in frames[:-1])
        measurements.append(
            {
                "style": prepared.style,
                "first_frame_seconds": round(first_frame or 0.0, 2),
                "frames": len(frames),
                "audio_seconds": round(sum(frames) / 2 / SAMPLE_RATE, 2),
            }
        )
    print(f"[gemini-tts-service] {json.dumps(measurements, sort_keys=True)}")
