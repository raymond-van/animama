"""Neutral completion ordering shared by local and hosted compositions."""

import asyncio

import pytest

from animama.app.chat.completion import complete_successful_turn
from animama.app.chat.options import DirectChatOptions


@pytest.mark.asyncio
@pytest.mark.parametrize("incognito", [False, True])
async def test_completion_is_after_speech_title_and_compaction_with_incognito_preserved(incognito):
    calls = []

    async def events():
        calls.append("events")
        yield "emotion"

    async def speech():
        calls.append("speech")
        yield "audio"

    async def effect(name):
        calls.append(name)
        return name

    def completed():
        calls.append("completed")
        return "completed"

    output = [
        value
        async for value in complete_successful_turn(
            options=DirectChatOptions(incognito=incognito, disable_memory_updates=True),
            pending_events=events(),
            finish_session=lambda: effect("session"),
            speech_events=speech(),
            finish_title=lambda: effect("title"),
            compact=lambda: effect("compact"),
            completed=completed,
        )
    ]
    assert output == ["emotion", "session", "audio", *([] if incognito else ["title"]), "completed"]
    assert calls == ["events", "session", "speech", *([] if incognito else ["title", "compact"]), "completed"]


@pytest.mark.asyncio
async def test_cancelled_side_effect_never_emits_success_completion():
    async def empty():
        if False:
            yield None

    async def cancel():
        raise asyncio.CancelledError()

    def completed():
        raise AssertionError("must not complete")

    with pytest.raises(asyncio.CancelledError):
        _ = [
            value
            async for value in complete_successful_turn(
                options=DirectChatOptions(),
                pending_events=empty(),
                finish_session=cancel,
                speech_events=empty(),
                finish_title=cancel,
                compact=cancel,
                completed=completed,
            )
        ]


# Selective validation probe for raymond-van/animama#442 (H2); this PR is closed unmerged.
