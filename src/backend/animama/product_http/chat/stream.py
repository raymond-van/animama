"""Prepare and stream one ``POST /v1/animas/{anima_id}/chat:sse`` direct turn (ADR 0021).

The composition's chat-turn lease guards the whole turn: it is admitted after the
owner and runtime-revision checks and before anything is written or dispatched,
checked while the model streams and during the completion steps, and settled
exactly once: by the ``TurnHold`` when the request fails before its response runs
(including the composition's own setup commit), otherwise when the response ends.
The admitted turn is in the app's active-turn registry for that same span, so a
chat or Anima delete can stop it and wait until it has settled.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

import anyio
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect
from starlette.types import Message, Receive, Scope, Send

from animama.app.chat.completion import complete_successful_turn
from animama.app.chat.speech_tags import speech_tag_provider
from animama.app.contracts.chat import PyAnimaChatRequest
from animama.app.services.chat_title_generation_service import ChatTitleGenerationResult
from animama.domain.events import EventType
from animama.domain.request_principal import RequestPrincipal
from animama.logging import get_logger
from animama.product_http.ports import (
    ChatTurnAdmission,
    ChatTurnLease,
    ChatTurnOutcome,
    ProductPorts,
    ProductRefusal,
    refusal_error,
)

from .active_turns import ActiveChatTurn, ActiveChatTurns
from .compaction import compact_chat_after_success as _compact_chat_after_success
from .safety import ai_notice_frame, attach_crisis_resources
from .server_speech import ServerSpeechFeed
from .setup_helpers import TurnSessions
from .sse_events import SseTextState, format_denial_error_event, format_error_event
from .sse_runtime import (
    DirectChatEventBridge,
    TurnStopped,
    direct_run_completed_frame,
    drain_events_while_task_runs,
    drain_pending_events,
    extra_frames_while_task_runs,
    fallback_run_completed_frame,
    run_prepared_direct_turn,
    unexpected_error_event,
)
from .title import (
    chat_title_generation_skip_reason as _chat_title_generation_skip_reason,
    chat_title_updated_frame as _chat_title_updated_frame,
    generate_chat_title_for_stream as _generate_chat_title_for_stream,
    should_generate_chat_title as _should_generate_chat_title,
)
from .tts import (
    FinalizedTtsStreamBootstrap as _FinalizedTtsStreamBootstrap,
    TtsSessionBootstrap as _TtsSessionBootstrap,
    elevenlabs_tts_options as _elevenlabs_tts_options,
    gemini_finalized_tts_requested as _gemini_finalized_tts_requested,
    tts_speech_payload_enabled as _tts_speech_payload_enabled,
)
from .turn_setup import prepare_direct_chat_turn, resolve_turn_target

_log = get_logger("product_http.chat.stream")
# Bound on the shielded cleanup that stops the turn's tasks and settles its lease.
_SETTLE_TIMEOUT_SECONDS = 5.0

__all__ = ["DirectChatEventBridge", "TurnHold", "hold_chat_turn", "stream_direct_chat_sse"]


@dataclass
class TurnHold:
    """An admitted turn's lease and registry entry while its request may still fail before the response runs."""

    lease: ChatTurnLease | None = None
    turn: ActiveChatTurn | None = None

    async def release(self) -> None:
        """Settle the held lease as ``unstarted``; nothing was dispatched."""

        lease, self.lease = self.lease, None
        turn, self.turn = self.turn, None
        try:
            if lease is not None:
                with anyio.move_on_after(_SETTLE_TIMEOUT_SECONDS, shield=True):
                    await lease.settle("unstarted")
        finally:
            if turn is not None:
                turn.settled()


async def hold_chat_turn() -> AsyncIterator[TurnHold]:
    """Hold the turn's lease around the setup session.

    A function-scoped dependency entered before the handler's write session leaves
    after it, so it also sees the composition's setup commit fail, after the handler
    returned and before the response runs.
    """

    hold = TurnHold()
    try:
        yield hold
    except BaseException:
        await hold.release()
        raise


async def _stop_task(task: asyncio.Task[Any] | None) -> None:
    """Cancel ``task`` once, unless it is done, and wait for it; its outcome is discarded.

    A task already cancelling is not cancelled again, so a reply save it began finishes.
    """

    if task is None:
        return
    if not task.done() and not task.cancelling():
        task.cancel()
    with suppress(asyncio.CancelledError, Exception):
        await task


@dataclass
class _TurnProgress:
    """How far the turn got. Read when the lease settles, after every turn task stopped."""

    dispatched: bool = False
    saved: bool = False
    failed: bool = False

    def reply_saved(self) -> None:
        self.saved = True

    @property
    def outcome(self) -> ChatTurnOutcome:
        # A saved reply completes the turn, whatever later optional work did.
        if not self.dispatched:
            return "unstarted"
        if self.saved:
            return "completed"
        return "failed" if self.failed else "interrupted"


class _SentResponse:
    """Wraps a response's ``send`` to know how far it got, so a stopped stream can still end properly."""

    def __init__(self, send: Send) -> None:
        self._send = send
        self.started = False
        self.complete = False

    async def send(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            self.started = True
        elif message["type"] == "http.response.body" and not message.get("more_body", False):
            self.complete = True
        await self._send(message)

    async def end(self, status: int, headers: list[tuple[bytes, bytes]]) -> None:
        """Finish a response that a stop cut short or kept from starting; a client that left is ignored."""

        if self.complete:
            return
        with suppress(OSError, ClientDisconnect):
            if not self.started:
                await self.send({"type": "http.response.start", "status": status, "headers": headers})
            await self.send({"type": "http.response.body", "body": b"", "more_body": False})


class _LeasedStreamingResponse(StreamingResponse):
    """A turn's stream that settles its lease once the response ends, even if the body never ran.

    A stop from the active-turn registry (a chat or Anima delete) cancels the
    response as a client disconnect would, then ends whatever it had sent.
    """

    def __init__(
        self,
        content: AsyncGenerator[str, None],
        *,
        lease: ChatTurnLease,
        progress: _TurnProgress,
        turn: ActiveChatTurn,
        headers: dict[str, str],
    ) -> None:
        super().__init__(content, media_type="text/event-stream", headers=headers)
        # The generator itself: ``body_iterator`` is typed as a plain async iterable.
        self._body = content
        self._lease = lease
        self._progress = progress
        self._turn = turn

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        sent = _SentResponse(send)
        try:
            if self._turn.stop_requested:
                # Stopped during setup: the body never starts, so no model request is
                # sent and the lease settles ``unstarted``.
                await sent.end(self.status_code, self.raw_headers)
                return
            with anyio.CancelScope() as stop_scope:
                self._turn.bind_cancel(stop_scope.cancel)
                await super().__call__(scope, receive, sent.send)
            if stop_scope.cancelled_caught:
                # End the stream the stop cut short, so the server sees a finished response.
                await sent.end(self.status_code, self.raw_headers)
        finally:
            # A disconnect or a stop can leave the body suspended at a frame; closing it
            # runs its shielded cleanup, which stops every turn task, so the composition
            # settles only once nothing still runs. Settling has its own bound.
            try:
                with anyio.move_on_after(_SETTLE_TIMEOUT_SECONDS, shield=True):
                    await self._body.aclose()
                with anyio.move_on_after(_SETTLE_TIMEOUT_SECONDS, shield=True):
                    await self._lease.settle(self._progress.outcome)
            finally:
                self._turn.settled()


async def stream_direct_chat_sse(
    *,
    ports: ProductPorts,
    hold: TurnHold,
    session: AsyncSession,
    anima_id: str,
    req: PyAnimaChatRequest,
    user: RequestPrincipal,
    turns: ActiveChatTurns,
) -> StreamingResponse:
    """Prepare and stream one `POST /chat:sse` direct avatar companion turn.

    The handler does only route-level work: allocate request identifiers, check
    the owner's Anima, admit the turn and prepare it on the handler's write
    ``session`` (which closes before the stream starts), then return a streaming
    response whose generator owns the long-running model call and all downstream
    SSE side effects. Stream-time work opens its own short-lived sessions. ``hold``
    settles the admitted lease if the request fails before that response runs.
    The admitted turn is registered in ``turns`` until it settles.
    """

    _log.info("HTTP Anima Direct Chat SSE Start", anima_id=anima_id)
    run_id = req.run_id or f"run-{uuid.uuid4().hex}"
    chat_id = req.chat_id or f"chat-{uuid.uuid4().hex}"
    repositories = ports.repositories(session)
    target = await resolve_turn_target(repositories, anima_id=anima_id, req=req, user=user)
    try:
        lease = await ports.admit_chat_turn(
            user, ChatTurnAdmission(anima_id=anima_id, chat_id=chat_id, run_id=run_id, request=req)
        )
    except ProductRefusal as exc:
        raise refusal_error(exc) from exc
    # Until the response runs, a failure (here or in the setup commit) settles through the hold.
    hold.lease = lease
    # A delete that stops this turn during setup waits for it to settle, after the setup commit.
    active_turn = hold.turn = turns.register(owner_id=user.id, chat_id=chat_id, anima_id=anima_id)
    progress = _TurnProgress()
    sessions = TurnSessions(ports, user)
    policy = ports.chat_policy
    services = ports.chat_turn(user, lease)
    model_client_registry = services.model_clients
    if model_client_registry is None:
        raise HTTPException(status_code=503, detail="Model client registry is unavailable")
    turn = await prepare_direct_chat_turn(
        session=session,
        repositories=repositories,
        sessions=sessions,
        services=services,
        model_client_registry=model_client_registry,
        target=target,
        anima_id=anima_id,
        req=req,
        run_id=run_id,
        chat_id=chat_id,
        on_recorded=progress.reply_saved,
    )

    speech = services.speech
    # A composition that speaks through its own socket receives an ElevenLabs reply's text.
    server_speech_text = services.server_speech_text
    server_speech = (
        ServerSpeechFeed(server_speech_text)
        if server_speech_text is not None and _elevenlabs_tts_options(turn.chat_options) is not None
        else None
    )
    title_registry = services.utility_model_clients("title")
    compaction_registry = services.utility_model_clients("compaction")
    bridge = DirectChatEventBridge(anima_id=anima_id)
    chat = turn.prepared_turn.chat

    async def check_lease() -> None:
        stop = await lease.check()
        if stop is not None:
            raise TurnStopped(stop)

    async def _event_stream() -> AsyncGenerator[str, None]:
        """Bridge app-domain turn events, TTS/title side work, and final SSE frames."""

        frame: str | None
        state = SseTextState(
            emotional_state=turn.emotional_state,
            tts_speech_payload_enabled=_tts_speech_payload_enabled(turn.chat_options),
            speech_tone_tag_pending=speech_tag_provider(turn.chat_options.tts) == "elevenlabs",
            server_speech=server_speech,
            public_error_text=policy.public_error_text,
        )
        active_task: asyncio.Task[Any] | None = None
        title_task: asyncio.Task[ChatTitleGenerationResult] | None = None
        notice_task: asyncio.Task[str | None] | None = None
        tts_bootstrap = _TtsSessionBootstrap(run_id=run_id, anima_id=anima_id)
        finalized_tts = _FinalizedTtsStreamBootstrap.start_if_requested(
            chat_options=turn.chat_options,
            sessions=sessions,
            anima_id=anima_id,
            run_id=run_id,
            gemini_speech=services.gemini_speech if _gemini_finalized_tts_requested(turn.chat_options) else None,
        )
        completed_emitted = False

        def completed_frame() -> str | None:
            nonlocal completed_emitted
            frame = direct_run_completed_frame(
                anima_id=anima_id,
                chat_id=chat_id,
                user_id=user.id,
                run_id=run_id,
            )
            if frame is not None:
                completed_emitted = True
            return frame

        async def stop_turn_tasks() -> None:
            """Cancel the turn's title, notice, model and speech tasks and wait until each has stopped.

            Shielded and bounded: a client that leaves meanwhile cannot cut the wait
            short or cancel a reply save a second time.
            """

            with anyio.move_on_after(_SETTLE_TIMEOUT_SECONDS, shield=True):
                await _stop_task(title_task)
                await _stop_task(notice_task)
                await _stop_task(active_task)
                await tts_bootstrap.cancel()
                await finalized_tts.cancel()

        attach_crisis_resources(turn.safety, state)
        _log.info(
            "HTTP Anima Direct Chat SSE Stream Open",
            anima_id=anima_id,
            run_id=run_id,
            chat_id=chat_id,
        )
        try:
            if active_turn.stop_requested:
                # A stop that came as the response began may not have cancelled it yet:
                # dispatch nothing, so the turn ends ``unstarted``.
                return
            # Title generation is independent from the main assistant response.
            # It runs in parallel and is only surfaced after the direct turn has
            # succeeded so title failures do not corrupt the model stream.
            if title_registry is not None and _should_generate_chat_title(
                chat, chat_options=turn.chat_options, settings=policy.title_generation
            ):
                title_task = asyncio.create_task(
                    _generate_chat_title_for_stream(
                        sessions=sessions,
                        model_client_registry=title_registry,
                        settings=policy.title_generation,
                        anima_id=anima_id,
                        user_id=user.id,
                        chat_id=chat_id,
                        run_id=run_id,
                        message=req.message,
                    ),
                    name=f"direct-chat-title-{run_id}",
                )
            else:
                _log.info(
                    "Direct chat title generation skipped",
                    anima_id=anima_id,
                    chat_id=chat_id,
                    run_id=run_id,
                    reason=(
                        "no_title_model_clients"
                        if title_registry is None
                        else _chat_title_generation_skip_reason(
                            chat, chat_options=turn.chat_options, settings=policy.title_generation
                        )
                    ),
                    chat_has_title=bool(getattr(chat, "title", None)),
                    chat_next_turn=getattr(chat, "next_turn", None),
                )
            # TTS setup may produce early SSE frames before the model completes,
            # while finalized TTS waits until the final assistant text is known.
            tts_bootstrap = _TtsSessionBootstrap.start_if_requested(
                chat_options=turn.chat_options,
                speech=speech,
                sessions=sessions,
                anima_id=anima_id,
                run_id=run_id,
                # Server speech text waits until the session is known to be a server session.
                on_session=server_speech.session_ready if server_speech is not None else None,
            )

            def _poll_tts_frame() -> str | None:
                finalized_tts.start_if_ready(state)
                frame = finalized_tts.pop_ready_frame()
                if frame is not None:
                    return frame
                return tts_bootstrap.pop_ready_frame()

            # The app-layer turn publishes domain events into `bridge`; this
            # route generator drains the bridge into wire-level SSE frames.
            active_task = asyncio.create_task(
                run_prepared_direct_turn(turn.executor, turn.prepared_turn, bridge),
                name=f"direct-chat-model-client-{run_id}",
            )
            # The task saves the reply, so a delete waits for it even past the cleanup bound.
            active_turn.track(active_task)
            progress.dispatched = True
            _log.info(
                "Direct chat model turn task scheduled",
                anima_id=anima_id,
                chat_id=chat_id,
                run_id=run_id,
                task_name=active_task.get_name(),
            )
            # The AI notice (spec R2) precedes any provider output. The provider
            # task is already running, so recording notice state adds no time to
            # first text; its events wait in the bridge until drained. The speech
            # descriptor is not provider output: it is sent as soon as it is ready.
            notice_task = asyncio.create_task(
                ai_notice_frame(
                    turn.safety,
                    sessions=sessions,
                    user_id=user.id,
                    run_id=run_id,
                    anima_name=turn.prepared_turn.memory_context.anima_name,
                ),
                name=f"direct-chat-ai-notice-{run_id}",
            )
            async for frame in extra_frames_while_task_runs(
                notice_task,
                poll_extra_frame=tts_bootstrap.pop_ready_frame,
                extra_frame_wake=tts_bootstrap.pending_setup,
            ):
                yield frame
            notice = notice_task.result()
            notice_task = None
            if notice is not None:
                yield notice
            async for frame in drain_events_while_task_runs(
                active_task,
                bridge,
                run_id=run_id,
                anima_id=anima_id,
                sessions=sessions,
                state=state,
                stream_user_response=True,
                stream_emotion_update=True,
                poll_extra_frame=_poll_tts_frame,
                extra_frame_wake=tts_bootstrap.pending_setup,
                check_lease=check_lease,
            ):
                yield frame

            turn_events = await active_task
            active_task = None
            turn_failed = any(event.type == EventType.ERROR for event in turn_events)
            if not turn_failed:
                # The reply is recorded (or, incognito, complete); only optional work remains.
                progress.saved = True
            _log.info(
                "Direct chat model turn task joined",
                anima_id=anima_id,
                chat_id=chat_id,
                run_id=run_id,
                event_count=len(turn_events),
                error_count=sum(1 for event in turn_events if event.type == EventType.ERROR),
            )
            async for frame in drain_pending_events(
                bridge,
                run_id=run_id,
                anima_id=anima_id,
                sessions=sessions,
                state=state,
                stream_user_response=True,
                stream_emotion_update=True,
            ):
                yield frame
            # Every queued speech segment has reached the composition's socket by now.
            if server_speech is not None:
                if turn_failed:
                    server_speech.abort()
                else:
                    server_speech.end()

            # App-layer errors are already formatted and streamed as ERROR
            # events. Emit the public completion concept once, then stop any
            # optional side work that should not run after a failed turn.
            if turn_failed:
                _log.info(
                    "Direct chat model turn completed with app-layer error",
                    anima_id=anima_id,
                    chat_id=chat_id,
                    run_id=run_id,
                )
                progress.failed = True
                await stop_turn_tasks()
                frame = completed_frame()
                if frame is not None:
                    _log.info(
                        "Direct chat run.completed emitted after app-layer error",
                        anima_id=anima_id,
                        chat_id=chat_id,
                        run_id=run_id,
                    )
                    yield frame
                return

            # The model turn succeeded. Flush remaining non-text events before
            # optional post-turn side effects so the user-visible response order
            # remains assistant text/emotion first, then TTS/title/compaction.
            _log.info(
                "Direct chat post-model side effects started",
                anima_id=anima_id,
                chat_id=chat_id,
                run_id=run_id,
            )
            finalized_tts.start_if_ready(state)

            async def finish_session() -> str | None:
                await check_lease()
                return await tts_bootstrap.finish_frame()

            async def finish_title() -> str | None:
                nonlocal title_task
                await check_lease()
                frame = await _chat_title_updated_frame(
                    title_task=title_task,
                    sessions=sessions,
                    anima_id=anima_id,
                    user_id=user.id,
                    chat_id=chat_id,
                    run_id=run_id,
                )
                title_task = None
                return frame

            async def compact() -> None:
                await check_lease()
                if compaction_registry is None:
                    return
                await _compact_chat_after_success(
                    sessions=sessions,
                    model_client_registry=compaction_registry,
                    chat_id=chat_id,
                    user_id=user.id,
                    anima_id=anima_id,
                    run_id=run_id,
                    chat_options=turn.chat_options,
                    settings=policy.compaction,
                    model_provider=turn.prepared_turn.model_request.model_provider,
                )

            async for frame in complete_successful_turn(
                options=turn.chat_options,
                pending_events=drain_pending_events(
                    bridge,
                    run_id=run_id,
                    anima_id=anima_id,
                    sessions=sessions,
                    state=state,
                    stream_user_response=False,
                    stream_emotion_update=True,
                ),
                finish_session=finish_session,
                speech_events=finalized_tts.finish_frames(state),
                finish_title=finish_title,
                compact=compact,
                completed=completed_frame,
            ):
                if not completed_emitted:
                    await check_lease()
                yield frame
        except TurnStopped as stopped:
            # The composition ended the turn: stop its work first, so whether the
            # reply was saved is settled, then end the stream.
            if server_speech is not None:
                server_speech.abort()
            await stop_turn_tasks()
            _log.info(
                "HTTP Anima Direct Chat SSE Stream Stopped",
                anima_id=anima_id,
                run_id=run_id,
                code=stopped.stop.code,
                reply_saved=progress.saved,
            )
            if not progress.saved:
                yield format_denial_error_event(
                    run_id=run_id,
                    error=stopped.stop.message,
                    code=stopped.stop.code,
                    details=stopped.stop.details,
                    event_id=f"error-{run_id}",
                )
            else:
                # The saved reply's frames still queued reach the client before it completes.
                async for frame in drain_pending_events(
                    bridge,
                    run_id=run_id,
                    anima_id=anima_id,
                    sessions=sessions,
                    state=state,
                    stream_user_response=True,
                    stream_emotion_update=True,
                ):
                    yield frame
            if not completed_emitted:
                frame = completed_frame() if progress.saved else None
                yield frame or fallback_run_completed_frame(run_id=run_id, chat_id=chat_id)
        except asyncio.CancelledError:
            _log.info("HTTP Anima Direct Chat SSE Stream Cancelled", anima_id=anima_id, run_id=run_id)
            raise
        except GeneratorExit:
            _log.info("HTTP Anima Direct Chat SSE Stream Closed", anima_id=anima_id, run_id=run_id)
            raise
        except Exception as exc:
            # After the reply is recorded, an optional step's failure does not undo it.
            progress.failed = True
            _log.error(
                "HTTP Anima Direct Chat SSE Stream Error",
                anima_id=anima_id,
                run_id=run_id,
                error=str(exc),
            )
            if server_speech is not None:
                server_speech.abort()
            await stop_turn_tasks()
            if isinstance(exc, ProductRefusal):
                # A composition's denial (a refused model request or reply save) keeps its fields.
                frame = format_denial_error_event(
                    run_id=run_id,
                    error=state.public_error_text or exc.code,
                    code=exc.code,
                    details=exc.details,
                    event_id=f"error-{run_id}",
                )
            else:
                error_event = unexpected_error_event(
                    exc,
                    anima_id=anima_id,
                    chat_id=chat_id,
                    user_id=user.id,
                    run_id=run_id,
                )
                frame = format_error_event(error_event, run_id=run_id, public_error_text=state.public_error_text)
            if frame is not None:
                yield frame
            async for frame in drain_pending_events(
                bridge,
                run_id=run_id,
                anima_id=anima_id,
                sessions=sessions,
                state=state,
                stream_user_response=False,
                stream_emotion_update=True,
            ):
                yield frame
            if not completed_emitted:
                yield fallback_run_completed_frame(run_id=run_id, chat_id=chat_id)
        finally:
            # Client disconnects, generator errors, and normal completion all
            # converge here so background title/TTS/model tasks cannot outlive
            # the request that created them.
            if server_speech is not None and not completed_emitted:
                server_speech.abort()
            await stop_turn_tasks()
            _log.info(
                "HTTP Anima Direct Chat SSE Stream Cleanup Complete",
                anima_id=anima_id,
                chat_id=chat_id,
                run_id=run_id,
                completed_emitted=completed_emitted,
            )

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return _LeasedStreamingResponse(_event_stream(), lease=lease, progress=progress, turn=active_turn, headers=headers)
