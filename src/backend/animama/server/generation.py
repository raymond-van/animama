"""The content assistant in the local composition: its process state, its Library lookups and the run stream.

Only the local composition has this module (spec #942). It keeps, on the
app's state, what must be shared by every request of the process: which
conversations have a run in flight (one at a time, decision D10), the review
sheets runs are waiting for (in memory only, threat T6) and the wake-ups for
runs waiting on a check report. It also turns a run's events into the SSE
stream the page reads, and stops the run when the page closes that stream.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Collection, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, BinaryIO, Final, cast

import anyio
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.types import Receive, Scope, Send

from animama.adapters.model_clients import MockModelClient
from animama.adapters.repositories.sqlalchemy.generation_repo import SQLAlchemyGenerationRepository
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.generation.check_report import MAX_REPORT_BYTES, final_status
from animama.app.generation.deterministic_author import DeterministicAuthor
from animama.app.generation.draft_validation import MAX_CLIP_BYTES, Intent
from animama.app.generation.review_frames import (
    MAX_REVIEW_SHEET_BYTES,
    MAX_REVIEW_SHEETS,
    ReviewFrameStore,
    ReviewSheetError,
    decode_review_sheet,
)
from animama.app.generation.run import (
    RUN_FAILED,
    RUN_STATUSES,
    DraftUpdated,
    FramesRequested,
    GenerationRun,
    MessageDelta,
    Progress,
    Questions,
    RunCompleted,
    RunEvent,
    RunFailed,
    RunStarted,
    RunUsage,
    Storage,
    model_unusable_reason,
    plan_run,
)
from animama.app.generation.service import CheckReportSignal, GenerationService, is_unsettled
from animama.app.generation.tools import example_names
from animama.app.model_clients import ModelClient
from animama.app.services.content_portability import is_non_portable
from animama.domain import ModelProvider
from animama.domain.content_catalog import CatalogContentEntry, ContentKind, ContentSource
from animama.domain.content_documents import GestureDocumentV1
from animama.domain.generation import (
    GENERATION_SCOPE_CREATOR,
    GenerationConversation,
    GenerationConversationSnapshot,
    GenerationDraft,
    GenerationError,
    GenerationNotFoundError,
)
from animama.domain.request_principal import RequestPrincipal
from animama.logging import failure_site, get_logger
from animama.product_http.chat.sse_events import format_sse
from animama.product_http.ports import ProductContent
from animama.server.deps import get_async_session_factory
from animama.server.model_clients import get_model_client_registry
from animama.server.schemas.generation import PyGenerationCheckReport, PyGenerationDraft, PyGenerationRunRequest

_log = get_logger("server.generation")

HEARTBEAT_SECONDS = 15.0
"""How long a run's stream stays silent before it sends a comment, so a proxy or the page does not give up."""
STOP_TIMEOUT_SECONDS: Final = 5.0
"""Bound on stopping a run whose stream ended: cancelling its model request and leaving its draft settled."""
RUN_IN_PROGRESS: Final = "generation_run_in_progress"
MODEL_UNUSABLE: Final = "generation_model_unusable"

_STATE_ATTR: Final = "generation_runtime"
_STATUS_BY_CODE: Final[Mapping[str, int]] = {
    "generation_not_found": 404,
    "generation_stale_version": 409,
    "generation_nothing_to_restore": 409,
    "generation_draft_empty": 409,
    "generation_document_invalid": 422,
    "generation_reasoning_effort_unsupported": 422,
    "generation_frame_not_an_image": 422,
    "generation_frame_too_large": 413,
}
# Room for the multipart boundaries and part headers around the sheets.
_FRAMES_BODY_LIMIT: Final = MAX_REVIEW_SHEETS * MAX_REVIEW_SHEET_BYTES + 64 * 1024
_EXAMPLE_KINDS: Final[Mapping[str, tuple[ContentKind, str]]] = {
    "gesture": (ContentKind.GESTURE, "builtin:gesture:"),
    "reaction": (ContentKind.REACTION, "builtin:reaction:"),
}
"""The catalog kind and logical-key prefix of the Included items each intent's ``read_example`` may return."""
_CLIP_FILE_ROLE: Final = "sequence"


def refusal(code: str, status_code: int, **fields: str) -> HTTPException:
    """A refused request, with its stable code for the page."""

    return HTTPException(status_code=status_code, detail={"code": code, **fields})


def generation_refusal(error: GenerationError) -> HTTPException:
    """The HTTP answer to a refused assistant operation, with the error's ``reason`` where it has one."""

    reason = getattr(error, "reason", None)
    fields = {"reason": reason} if isinstance(reason, str) else {}
    return refusal(error.code, _STATUS_BY_CODE.get(error.code, 400), **fields)


# --- Process state ------------------------------------------------------------------------


class GenerationRuns:
    """The conversations with a run in flight. One process and one event loop, so a plain set."""

    def __init__(self) -> None:
        self._running: set[tuple[str, str]] = set()

    def start(self, owner_user_id: str, conversation_id: str) -> bool:
        """Claim the conversation for a run; ``False`` when one is already in flight."""

        key = (owner_user_id, conversation_id)
        if key in self._running:
            return False
        self._running.add(key)
        return True

    def finish(self, owner_user_id: str, conversation_id: str) -> None:
        self._running.discard((owner_user_id, conversation_id))

    def claim(self, owner_user_id: str, conversation_id: str) -> Callable[[], None] | None:
        """Claim the conversation for a run and return what frees it; ``None`` when one is already in flight.

        The returned release frees the claim once and does nothing after
        that. A request's failure path and its teardown may both call it,
        and by the second call the conversation may be another request's.
        """

        if not self.start(owner_user_id, conversation_id):
            return None
        held = True

        def release() -> None:
            nonlocal held
            if held:
                held = False
                self.finish(owner_user_id, conversation_id)

        return release

    def running(self, owner_user_id: str, conversation_id: str) -> bool:
        return (owner_user_id, conversation_id) in self._running

    def any_running(self, owner_user_id: str) -> bool:
        """Whether a run is in flight on any of the owner's conversations."""

        return any(owner == owner_user_id for owner, _ in self._running)


@dataclass
class GenerationRuntime:
    """What every request of this process shares about the assistant's runs. Nothing here is stored."""

    runs: GenerationRuns = field(default_factory=GenerationRuns)
    frames: ReviewFrameStore = field(default_factory=ReviewFrameStore)
    check_reports: CheckReportSignal = field(default_factory=CheckReportSignal)


def generation_runtime(app: FastAPI) -> GenerationRuntime:
    """The app's run state, created the first time it is asked for."""

    runtime = getattr(app.state, _STATE_ATTR, None)
    if not isinstance(runtime, GenerationRuntime):
        runtime = GenerationRuntime()
        setattr(app.state, _STATE_ATTR, runtime)
    return runtime


def generation_service(app: FastAPI, session: AsyncSession) -> GenerationService:
    """The assistant's storage on ``session``, waking this app's waiting runs when a report is stored."""

    return GenerationService(
        SQLAlchemyGenerationRepository(session),
        SQLAlchemyUnitOfWork(session),
        check_reports=generation_runtime(app).check_reports,
    )


def _storage(app: FastAPI) -> Storage:
    """Storage for a run's steps: each opens a session of its own from the app's factory and closes it."""

    @asynccontextmanager
    async def open_storage() -> AsyncIterator[GenerationService]:
        async with get_async_session_factory(app)() as session:
            yield generation_service(app, session)

    return open_storage


async def read_conversation(
    app: FastAPI, session: AsyncSession, owner_user_id: str, conversation_id: str
) -> GenerationConversationSnapshot:
    """A conversation with its messages and drafts, after settling any draft whose status does not describe it.

    A run settles its own draft when it ends. Two kinds of draft are left
    for this read (``is_unsettled``): one a run could not settle (the process
    was killed, or stopping took longer than its bound), which is still in a
    step no run is doing; and one whose check report arrived after it was
    left, while another run held the conversation, so that its status no
    longer matches the report. With no run in flight on the conversation,
    each is settled here by the rule a run itself applies
    (``GenerationService.settle_draft``). A draft whose current version has
    no report stays ``checking``, for the page to check.
    """

    service = generation_service(app, session)
    snapshot = await service.get_conversation(owner_user_id, conversation_id)
    unsettled = [draft for draft in snapshot.drafts if is_unsettled(draft, RUN_STATUSES)]
    # Asked right after the read, with nothing awaited between: a run in flight owns these statuses.
    if not unsettled or generation_runtime(app).runs.running(owner_user_id, conversation_id):
        return snapshot
    for draft in unsettled:
        try:
            # Read again under its row's hold, so a draft settled or discarded meanwhile is left as it is.
            await service.settle_draft(owner_user_id, draft.id, RUN_STATUSES)
        except GenerationNotFoundError:
            continue
    _log.info("Generation drafts settled on read", conversation_id=conversation_id, draft_count=len(unsettled))
    return await service.get_conversation(owner_user_id, conversation_id)


# --- Conversations that outlived what they belong to ------------------------------------------

UNSAVED_CONVERSATION_DAYS: Final = 7
"""How long a creator's conversation about an unsaved item is kept after it was last written to."""


def _is_creator_scope(conversation: GenerationConversation) -> bool:
    return conversation.scope.get("kind") == GENERATION_SCOPE_CREATOR


async def _library_item_kinds(
    app: FastAPI, session: AsyncSession, principal: RequestPrincipal, item_ids: Collection[str]
) -> dict[str, ContentKind] | None:
    """The kind of each of ``item_ids`` that is a row of the owner's Library; ``None`` when it cannot be read.

    Read from the catalog rows themselves, whatever their scan status: an
    item that is invalid, misses a file or a dependency, or waits for a
    rescan is still in the Library, with the same id. Nothing is parsed.
    """

    ports = getattr(app.state, "product_ports", None)
    if ports is None:
        return None
    try:
        async with ports.content(session, principal) as content:
            rows = await content.catalog.visible_items(item_ids=item_ids, user_id=principal.id)
            return {item_id: row.kind for item_id, row in rows.items()}
    except Exception as error:
        _log.warning(
            "Generation conversations kept: the Library could not be read",
            exc_type=type(error).__name__,
            site=failure_site(error),
        )
        return None


async def list_owner_conversations(
    app: FastAPI, session: AsyncSession, principal: RequestPrincipal, *, now: datetime | None = None
) -> list[GenerationConversation]:
    """The owner's conversations, without the creator conversations that outlived what they belong to.

    A creator's conversation belongs to the item open in that creator, and
    nothing lists it for the person once the item is gone, so it is removed
    here, with its messages and drafts, when the conversations are listed:

    - one about a saved item, when the owner's Library no longer holds a
      Gesture or Reaction (by the conversation's kind) with that id. The
      item's scan status does not matter: an item that is invalid, misses a
      file or waits for a rescan is still there. Another owner's item is not
      in this owner's Library;
    - one about an unsaved item, ``UNSAVED_CONVERSATION_DAYS`` days after it
      was last written to. Only a creator left open since then could still be
      showing it; its panel then starts an empty conversation.

    Nothing is removed while a run is in flight on any of the owner's
    conversations (checked again before each removal, since the Library is
    read in between), or while the Library cannot be read. The Generate
    page's own conversations are never removed here.
    """

    service = generation_service(app, session)
    owner = principal.id
    runs = generation_runtime(app).runs
    conversations = await service.list_conversations(owner)
    creators = [conversation for conversation in conversations if _is_creator_scope(conversation)]
    if not creators or runs.any_running(owner):
        return conversations
    item_ids = {
        item_id for conversation in creators if isinstance(item_id := conversation.scope.get("catalog_item_id"), str)
    }
    kinds = await _library_item_kinds(app, session, principal, item_ids) if item_ids else {}
    if kinds is None:
        return conversations
    expired_before = (now or datetime.now(UTC)) - timedelta(days=UNSAVED_CONVERSATION_DAYS)
    removed: set[str] = set()
    for conversation in creators:
        item_id = conversation.scope.get("catalog_item_id")
        if item_id is None:
            written = conversation.updated_at
            if written.tzinfo is None:
                written = written.replace(tzinfo=UTC)
            outlived = written < expired_before
        else:
            kind = _EXAMPLE_KINDS.get(str(conversation.scope.get("intent")), (None, ""))[0]
            outlived = kind is None or kinds.get(item_id) is not kind
        if not outlived:
            continue
        # A run may have started while the Library was read: it keeps what it works on.
        if runs.any_running(owner):
            break
        try:
            await service.delete_conversation(owner, conversation.id)
        except GenerationNotFoundError:
            pass
        removed.add(conversation.id)
    if removed:
        _log.info("Generation conversations removed with their items", conversation_count=len(removed))
    return [conversation for conversation in conversations if conversation.id not in removed]


# --- The owner's Library, as the tools may ask of it ------------------------------------------


@dataclass(frozen=True)
class AuthoringLibrary:
    """What a run's tools may know of the owner's Library, read once before the run starts.

    ``selector_ids`` are the Selector IDs of the owner's Gestures, without
    the draft's own saved item; a Reaction has no Selector ID, so its run
    reads none. ``examples`` are the clips of the allowlisted Included items
    of the run's kind that could be read.
    """

    selector_ids: frozenset[str] = frozenset()
    examples: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)

    def selector_in_use(self, selector_id: str) -> bool:
        return selector_id in self.selector_ids

    def example(self, name: str) -> Mapping[str, Any] | None:
        return self.examples.get(name)


def _read_all(handle: BinaryIO) -> bytes:
    with handle:
        return handle.read(MAX_CLIP_BYTES + 1)


async def _example_clip(
    content: ProductContent, item: CatalogContentEntry, owner_user_id: str
) -> Mapping[str, Any] | None:
    """One Included item's clip through the catalog's own verified read; ``None`` when it is not a clip."""

    clip_file = next((file for file in item.files if file.role == _CLIP_FILE_ROLE), None)
    if clip_file is None or clip_file.size_bytes > MAX_CLIP_BYTES:
        return None
    verified = await content.catalog.open_registered_file(file_ref=clip_file.file_ref, user_id=owner_user_id)
    raw = await asyncio.to_thread(_read_all, verified.handle)
    if len(raw) > MAX_CLIP_BYTES:
        return None
    clip = json.loads(raw)
    return clip if isinstance(clip, dict) else None


async def read_authoring_library(
    content: ProductContent, owner_user_id: str, *, saved_item_id: str | None, intent: Intent = "gesture"
) -> AuthoringLibrary:
    """Read what a run of ``intent`` may ask of the Library: Gesture Selector IDs in use, and example clips.

    An example is one of ``example_names(intent)`` among the Included items
    of that kind. A non-portable item is never read, whatever it is called
    (threat T4), and an example that cannot be read as a clip is left out.
    ``saved_item_id`` is the Library item the draft was saved as or the
    creator has open, whose own Selector ID is not a clash.
    """

    kind, key_prefix = _EXAMPLE_KINDS[intent]
    items = await content.typed.list_kind(user_id=owner_user_id, kind=kind)
    selector_ids = frozenset(
        item.document.semantic_key
        for item in items
        if isinstance(item.document, GestureDocumentV1) and item.item.id != saved_item_id
    )
    included = {item.item.logical_key: item.item for item in items if item.item.source is ContentSource.INCLUDED}
    examples: dict[str, Mapping[str, Any]] = {}
    for name in example_names(intent):
        item = included.get(f"{key_prefix}{name}")
        if item is None or is_non_portable(item):
            continue
        try:
            clip = await _example_clip(content, item, owner_user_id)
        except Exception as error:
            _log.warning(
                "Generation example could not be read",
                example=name,
                exc_type=type(error).__name__,
                site=failure_site(error),
            )
            continue
        if clip is not None:
            examples[name] = clip
    return AuthoringLibrary(selector_ids=selector_ids, examples=examples)


async def _authoring_library(
    app: FastAPI, session: AsyncSession, principal: RequestPrincipal, *, saved_item_id: str | None, intent: Intent
) -> AuthoringLibrary:
    """The Library for a run, or an empty one when content is unavailable.

    A run then checks no Selector ID clash and reads no example. Neither is
    needed to author a draft, so a content root that failed to start does not
    stop the assistant.
    """

    ports = getattr(app.state, "product_ports", None)
    if ports is None:
        return AuthoringLibrary()
    try:
        async with ports.content(session, principal) as content:
            return await read_authoring_library(content, principal.id, saved_item_id=saved_item_id, intent=intent)
    except Exception as error:
        _log.warning(
            "Generation run starts without its Library", exc_type=type(error).__name__, site=failure_site(error)
        )
        return AuthoringLibrary()


# --- Starting a run -------------------------------------------------------------------------


@dataclass
class RunHold:
    """A claimed conversation while its request may still fail before the stream runs."""

    release: Callable[[], None] | None = None


async def hold_generation_run() -> AsyncGenerator[RunHold, None]:
    """Free a claimed conversation when its request fails before the response runs.

    A function-scoped dependency declared before the request's session leaves
    after it, so it also sees that session fail to close. Once the response
    runs, the response itself frees the conversation.
    """

    hold = RunHold()
    try:
        yield hold
    except BaseException:
        if hold.release is not None:
            hold.release()
        raise


def _author_or_client(
    app: FastAPI, model_provider: ModelProvider
) -> tuple[ModelClient | None, DeterministicAuthor | None]:
    """The model client a run uses, or the deterministic author when this server runs without models.

    Under ``ANIMAMA_LLM_SKIP`` every provider type is served by the mock
    client, which cannot call tools; the author then stands in for each pass.
    """

    registry = get_model_client_registry(app)
    client = registry.get(model_provider.provider_type) if registry is not None else None
    if client is None:
        raise refusal(MODEL_UNUSABLE, 422, reason="no_model_client")
    if isinstance(client, MockModelClient):
        return None, DeterministicAuthor()
    return client, None


async def start_generation_run(
    request: Request,
    *,
    session: AsyncSession,
    principal: RequestPrincipal,
    conversation_id: str,
    body: PyGenerationRunRequest,
    hold: RunHold,
) -> StreamingResponse:
    """Check and plan one run on the request's session, then return the stream that runs it.

    The conversation is claimed first, so everything read here is what the
    run works from, and freed again when the request is refused: once, by
    whichever of this function, the hold and the response gets there first.
    The session closes before the stream starts; the run opens its own
    short-lived ones.
    """

    app = cast(FastAPI, request.app)
    runtime, owner = generation_runtime(app), principal.id
    release = runtime.runs.claim(owner, conversation_id)
    if release is None:
        raise refusal(RUN_IN_PROGRESS, 409)
    hold.release = release
    try:
        snapshot = await generation_service(app, session).get_conversation(owner, conversation_id)
        model_provider = await SQLAlchemyModelProviderRepository(session).get(body.model_provider_id)
        reason = model_unusable_reason(model_provider)
        if model_provider is None or reason is not None:
            raise refusal(MODEL_UNUSABLE, 422, reason=reason or "not_found")
        plan = plan_run(
            snapshot,
            message=body.message,
            model_provider=model_provider,
            intent=body.intent,
            draft_id=body.draft_id,
            ui_locale=body.ui_locale,
            answers=body.answers.model_dump() if body.answers is not None else None,
            avatar_expressions=body.avatar_expressions,
            reasoning_effort=body.reasoning_effort,
            document=body.document,
        )
        client, author = _author_or_client(app, model_provider)
        # The item whose own Selector ID is no clash: the one the draft was saved as, or the one a creator
        # has open.
        own_item = plan.draft.saved_item_id if plan.draft is not None else None
        own_item = own_item or snapshot.conversation.scope.get("catalog_item_id")
        library = await _authoring_library(app, session, principal, saved_item_id=own_item, intent=plan.intent)
    except GenerationError as error:
        release()
        raise generation_refusal(error) from error
    except BaseException:
        release()
        raise
    run = GenerationRun(
        plan,
        storage=_storage(app),
        client=client,
        author=author,
        check_reports=runtime.check_reports,
        frames=runtime.frames,
        selector_in_use=library.selector_in_use,
        example_reader=library.example,
    )
    _log.info(
        "Generation run admitted",
        run_id=run.run_id,
        conversation_id=conversation_id,
        selector_id_count=len(library.selector_ids),
        example_count=len(library.examples),
        expression_family_count=len(body.avatar_expressions or {}),
        with_document=plan.document is not None,
    )
    return GenerationRunResponse(run_frames(run), release=release)


# --- The run's stream -----------------------------------------------------------------------


def event_frame(event: RunEvent) -> str:
    """One run event as an SSE frame: its name, and its payload as JSON."""

    data: dict[str, Any]
    if isinstance(event, RunStarted):
        name, data = "run.started", {"run_id": event.run_id}
    elif isinstance(event, Progress):
        name, data = "progress", {"phase": event.phase}
        if event.draft_id is not None:
            data["draft_id"] = event.draft_id
    elif isinstance(event, MessageDelta):
        name, data = "message.delta", {"text": event.text}
    elif isinstance(event, Questions):
        name, data = "questions", {"questions": [dict(question) for question in event.questions]}
    elif isinstance(event, DraftUpdated):
        name, data = "draft.updated", {"draft": draft_resource(event.draft)}
    elif isinstance(event, FramesRequested):
        name, data = "frames.requested", {"draft_id": event.draft_id, "version": event.version}
    elif isinstance(event, RunFailed):
        name, data = "run.failed", {"code": event.code, "category": event.category, "details": dict(event.details)}
    else:
        name, data = "run.completed", {"usage": asdict(event.usage)}
    return format_sse(name, data)


def draft_resource(draft: GenerationDraft) -> dict[str, Any]:
    """A draft as the routes and the stream return it."""

    return PyGenerationDraft.from_domain(draft).model_dump(mode="json")


async def _stop(task: asyncio.Future[Any] | None) -> None:
    """Cancel a run's pending step once and wait until it has stopped; its outcome is discarded."""

    if task is None:
        return
    if not task.done():
        task.cancel()
    with suppress(asyncio.CancelledError, Exception):
        await task


async def run_frames(run: GenerationRun) -> AsyncGenerator[str, None]:
    """A run's events as SSE frames, with a comment whenever nothing was sent for ``HEARTBEAT_SECONDS``.

    Each event is awaited in a task of its own, so a heartbeat never
    interrupts the run. When the stream ends early (the page closed it, or
    the request was cancelled) that task is cancelled, which cancels the
    model request inside it, and the run settles its draft before this
    returns. An event that cannot be made into a frame, or a failure the run
    did not report itself, stops the run and then ends the stream as a failed
    run ends it: ``run.failed``, then ``run.completed``. That last frame
    counts no tokens; the stopped run's own count is in its stored message.
    """

    events = run.events()
    pending: asyncio.Future[RunEvent] | None = None

    async def end_run() -> None:
        # Shielded and bounded: a client that has left cannot cut the run's cleanup short.
        with anyio.move_on_after(STOP_TIMEOUT_SECONDS, shield=True):
            await _stop(pending)
            await events.aclose()

    try:
        while True:
            pending = asyncio.ensure_future(anext(events))
            while not (await asyncio.wait({pending}, timeout=HEARTBEAT_SECONDS))[0]:
                yield ": heartbeat\n\n"
            try:
                # Built here too: an event that cannot be put into a frame must not break the stream.
                frame = event_frame(pending.result())
            except StopAsyncIteration:
                return
            except Exception as error:
                # The run reports its own failures; this is a defect in the run or in framing its event.
                _log.error(
                    "Generation stream failed",
                    run_id=run.run_id,
                    exc_type=type(error).__name__,
                    site=failure_site(error),
                )
                # Stopped first: when the page is told the run ended, its draft and message are as it left them.
                await end_run()
                yield event_frame(RunFailed(code=RUN_FAILED, category="internal", details={}))
                yield event_frame(RunCompleted(RunUsage()))
                return
            pending = None
            yield frame
    finally:
        await end_run()


class GenerationRunResponse(StreamingResponse):
    """A run's stream. Its conversation is free for the next run once the response has ended."""

    def __init__(self, content: AsyncGenerator[str, None], *, release: Callable[[], None]) -> None:
        headers = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
        super().__init__(content, media_type="text/event-stream", headers=headers)
        # The generator itself: ``body_iterator`` is typed as a plain async iterable.
        self._body = content
        self._release = release

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # A disconnect can leave the body suspended at a frame, or never started. Closing it runs its
            # cleanup, so the run has stopped before another may start on the conversation.
            with anyio.move_on_after(STOP_TIMEOUT_SECONDS, shield=True):
                await self._body.aclose()
            self._release()


# --- What the page reports --------------------------------------------------------------------


async def record_check_report(
    app: FastAPI, session: AsyncSession, owner_user_id: str, draft_id: str, body: PyGenerationCheckReport
) -> GenerationDraft:
    """Store the page's report for a draft's current version.

    While a run works on the draft's conversation, the run reads the report
    and decides what follows. With no run in flight (a restored version, or
    one a stopped run left unchecked) the report itself says how the draft is
    left: ready, with warnings, or failed. A draft that never had a project
    stays as it failed. A report for a draft the run in flight is not working
    on is stored too; the next read of the conversation after that run
    settles the draft from it (``read_conversation``).
    """

    report = body.stored()
    if len(json.dumps(report, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_REPORT_BYTES:
        raise refusal("generation_check_report_too_large", 413)
    service = generation_service(app, session)
    draft = await service.record_check_report(owner_user_id, draft_id, body.version, report)
    idle = not generation_runtime(app).runs.running(owner_user_id, draft.conversation_id)
    if idle and draft.project is not None:
        draft = await service.set_status(owner_user_id, draft_id, *final_status(report))
    return draft


class _InMemoryMultiPartParser(MultiPartParser):
    """Starlette's parser, keeping every file part in memory.

    Its spool size is above the whole body's limit, so a sheet is never
    rolled over to a temporary file on disk.
    """

    spool_max_size = _FRAMES_BODY_LIMIT + 1


async def _bounded_body(request: Request) -> AsyncGenerator[bytes, None]:
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > _FRAMES_BODY_LIMIT:
            raise refusal("generation_frames_too_large", 413)
        yield chunk


async def _uploaded_sheets(request: Request) -> list[bytes]:
    """The one or two files of a review-frames upload, read wholly in memory and bounded before parsing."""

    invalid = refusal("generation_frames_invalid", 422)
    if not request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
        raise invalid
    declared = request.headers.get("content-length", "")
    if declared.isdecimal() and int(declared) > _FRAMES_BODY_LIMIT:
        raise refusal("generation_frames_too_large", 413)
    parser = _InMemoryMultiPartParser(
        request.headers, _bounded_body(request), max_files=MAX_REVIEW_SHEETS, max_fields=0
    )
    try:
        form = await parser.parse()
    except MultiPartException as error:
        raise invalid from error
    try:
        uploads = form.getlist("frames")
        if not 1 <= len(uploads) <= MAX_REVIEW_SHEETS or len(form.multi_items()) != len(uploads):
            raise invalid
        sheets: list[bytes] = []
        for upload in uploads:
            if isinstance(upload, str):
                raise invalid
            if (upload.size or 0) > MAX_REVIEW_SHEET_BYTES:
                raise refusal("generation_frame_too_large", 413)
            sheets.append(await upload.read())
        return sheets
    finally:
        await form.close()


async def accept_review_frames(request: Request, owner_user_id: str, draft_id: str, version: int) -> None:
    """Take the page's review sheets for a draft version that a run is waiting to review.

    The draft must be the caller's, at this version, with a run waiting for
    its sheets; otherwise the upload is refused before its body is read. Each
    sheet is decoded by the bounded image opener on a worker thread and held
    in memory until the review ends. Nothing is written to a table or a file.
    """

    app = cast(FastAPI, request.app)
    frames = generation_runtime(app).frames
    # A short session of its own: none is held while the upload is read and decoded.
    async with get_async_session_factory(app)() as session:
        try:
            draft = await generation_service(app, session).get_draft(owner_user_id, draft_id)
        except GenerationError as error:
            raise generation_refusal(error) from error
    if draft.version != version:
        raise refusal("generation_stale_version", 409)
    not_requested = refusal("generation_frames_not_requested", 409)
    if not frames.expects(draft_id, version):
        raise not_requested
    uploaded = await _uploaded_sheets(request)
    try:
        sheets = [await asyncio.to_thread(decode_review_sheet, content) for content in uploaded]
    except ReviewSheetError as error:
        raise generation_refusal(error) from error
    if not frames.offer(draft_id, version, sheets):
        # The run stopped waiting while the sheets were read.
        raise not_requested
    _log.info(
        "Generation review frames accepted",
        draft_id=draft_id,
        version=version,
        sheet_count=len(sheets),
        uploaded_bytes=sum(len(content) for content in uploaded),
    )


REVIEW_FRAMES_REQUEST_BODY: Final[dict[str, Any]] = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["frames"],
                    "properties": {
                        "frames": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_REVIEW_SHEETS,
                            "items": {"type": "string", "format": "binary"},
                            "description": "One contact sheet per Included Avatar, as PNG or JPEG.",
                        }
                    },
                }
            }
        },
    }
}
"""The upload's body for OpenAPI: the route reads it itself, to keep it in memory and bounded."""


__all__ = [
    "HEARTBEAT_SECONDS",
    "MODEL_UNUSABLE",
    "REVIEW_FRAMES_REQUEST_BODY",
    "RUN_IN_PROGRESS",
    "UNSAVED_CONVERSATION_DAYS",
    "AuthoringLibrary",
    "GenerationRunResponse",
    "GenerationRuns",
    "GenerationRuntime",
    "RunHold",
    "accept_review_frames",
    "draft_resource",
    "event_frame",
    "generation_refusal",
    "generation_runtime",
    "generation_service",
    "hold_generation_run",
    "list_owner_conversations",
    "read_authoring_library",
    "read_conversation",
    "record_check_report",
    "refusal",
    "run_frames",
    "start_generation_run",
]
