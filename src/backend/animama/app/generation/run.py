"""The run pipeline: one request from the person, as a stream of events for the page.

A run takes the person's message and makes or revises one draft through a few
bounded model passes (decision D2): a write or revise pass, repair passes while
the page's checks fail, and one frame review when the model accepts images. The
backend builds every request from stored state and fixed instructions and
tools (threat T3). Whatever a model wrote is validated before it is stored
(T1), and what the page reports only decides repairs and warnings (T6).

The limits of a run are here and in the modules it uses (T7): one draft a
request, ``MAX_TOOL_ROUNDS`` responses a pass, ``MAX_REPAIR_PASSES`` repair
passes and one review for a draft version, ``MAX_REVIEW_SHEETS`` sheets a
review, and bounded waits for the page's report and sheets.

A run holds no database session while it waits on the model or the page: each
storage step opens a short-lived one. It writes only the assistant's own
tables, never a Chat, a chat message, memory or an episode (T5). Logs carry
ids, counts and codes, never text.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, aclosing
from dataclasses import asdict, dataclass, field
from typing import Any, Final, Literal, cast
from uuid import uuid4

from animama.app.chat.direct_turn.events import model_error_details
from animama.app.chat.direct_turn.provider_state import validate_model_provider_for_direct_turn
from animama.app.chat.direct_turn.types import DirectChatTurnSetupError
from animama.app.chat.options import DirectChatOptions
from animama.app.model_clients import ModelClient, ModelClientError, ModelClientToolCall
from animama.app.model_clients.error_categories import model_error_category
from animama.app.model_clients.prompt import scoped_prompt_cache_key
from animama.app.util.json_values import json_safe_dict
from animama.domain import ModelProvider
from animama.domain.generation import (
    GenerationConversationSnapshot,
    GenerationDraft,
    GenerationDraftStatus,
    GenerationError,
    GenerationMessage,
    GenerationNotFoundError,
)
from animama.domain.model_connection import MODEL_KIND_CHAT, MODEL_SOURCE_OWNER
from animama.logging import failure_site, get_logger

from . import prompts
from .check_report import (
    final_status,
    is_loadable,
    names_not_on_review_sheets,
    needs_repair,
    unchecked_report,
)
from .deterministic_author import DeterministicAuthor
from .draft_validation import Intent, SelectorInUse
from .passes import PassCursorLost, PassEnd, PassRound, PassSpec, PassText, PassWriting, run_pass
from .review_frames import MAX_REVIEW_SHEETS, ReviewFrameStore, ReviewSheet
from .service import CheckReportSignal, GenerationService
from .tools import ExampleReader, PassKind, WorkingDraft, offered_tools, run_tool
from .usage import RunCostMeter, RunUsage, run_model

_log = get_logger("app.generation.run")

CHECK_WAIT_SECONDS: Final = 120
"""How long a run waits for the page's check report on a draft version."""
FRAMES_WAIT_SECONDS: Final = 60
"""How long a run waits for the page's review sheets."""
MAX_REPAIR_PASSES: Final = 3
"""Repair passes for a draft since the person's last request about it."""
REPORT_POLL_SECONDS: Final = 1.0
"""How often a waiting run reads the database again when nothing wakes it."""
MAX_REPLY_LENGTH: Final = 8000
"""Characters kept of the assistant's text for one run."""
MIN_CONTEXT_WINDOW_TOKENS: Final = 64_000
"""The smallest recorded context window a run's model may have.

A pass sends 16,000 to 24,000 tokens (the guidance, the clip and its
findings), and its tool rounds send the clip again with each result, so a
smaller window fails part-way through a draft. The page lists a model below
this figure as one that cannot be chosen, by the same number: the shared
fixture ``ui/generate/fixtures/model-requirements.json`` under the web
sources is the parity record that this constant and the page's are each
tested against.
"""

NO_VALID_DRAFT: Final = "generation_no_valid_draft"
"""A pass ended without a draft that validates."""
RUN_FAILED: Final = "generation_run_failed"
"""A run ended on a failure that is not a model's or the caller's."""

ProgressPhase = Literal["thinking", "writing", "checking", "repairing", "reviewing_frames"]
RunOutcome = Literal["draft", "questions", "reply", "failed", "stopped"]
"""How a run ended, as its assistant message records it."""

Storage = Callable[[], AbstractAsyncContextManager[GenerationService]]
"""Opens the assistant's storage on a session of its own, closed when the block ends."""

RUN_STATUSES: Final[frozenset[GenerationDraftStatus]] = frozenset({"writing", "checking", "repairing", "reviewing"})
"""The steps of a run. A run that ends leaves its draft in none of them unless its version awaits a check.
With no run in flight, a draft still in one was left by a run that ended without settling it (the process was
killed, or stopping took too long)."""
_DRAFT_ENDS: Final[frozenset[PassEnd]] = frozenset({"submitted", "edited"})


# --- What a run may be asked to do ----------------------------------------------------


class GenerationIntentUnavailableError(GenerationError):
    """The request names a kind of content the assistant does not author yet."""

    code = "generation_intent_unavailable"


class GenerationDraftEmptyError(GenerationError):
    """The draft to revise holds no project, so there is nothing to revise."""

    code = "generation_draft_empty"


class GenerationReasoningEffortUnsupportedError(GenerationError):
    """The run names a reasoning effort its model cannot run a pass at."""

    code = "generation_reasoning_effort_unsupported"


def model_unusable_reason(model_provider: ModelProvider | None) -> str | None:
    """Why a run cannot use this model row, as a reason code; ``None`` when it can.

    The row must exist, be active on an active connection, be a chat model
    that calls tools and streams, have room for a pass in its context window,
    and be one chat itself could use on its connection. A recorded window
    must be at least ``MIN_CONTEXT_WINDOW_TOKENS``; a row may record none
    where chat accepts that (a built-in row), and the owner's own model must
    record one, as in chat. A missing key or sign-in is not checked here: the
    request fails with the model client's own code, as it does in chat. There
    is no fallback to another model (decision D9).
    """

    if model_provider is None:
        return "not_found"
    if not model_provider.active:
        return "inactive"
    if model_provider.connection is not None and not model_provider.connection.active:
        return "connection_inactive"
    if model_provider.model_kind != MODEL_KIND_CHAT:
        return "not_chat_model"
    if not model_provider.capabilities.supports_tools:
        return "tools_unsupported"
    if not model_provider.capabilities.supports_streaming:
        return "streaming_unsupported"
    window = model_provider.context_window_tokens
    if window is None and model_provider.source == MODEL_SOURCE_OWNER:
        return "context_window_missing"
    if window is not None and window < MIN_CONTEXT_WINDOW_TOKENS:
        return "context_too_small"
    try:
        validate_model_provider_for_direct_turn(model_provider, request_options=DirectChatOptions())
    except DirectChatTurnSetupError:
        return "unsupported"
    return None


def accepted_reasoning_effort(model_provider: ModelProvider, reasoning_effort: str | None) -> str | None:
    """The reasoning effort a run sends with every pass; ``None`` leaves the model's own default.

    A named level must be one chat could send to this row with function
    tools in the request, which every pass has: the row lists it, and the
    route takes tools at it (OpenAI's Chat Completions takes them on its
    newer models at ``none`` only). Chat's own validator decides, so the two
    never disagree. Raises ``GenerationReasoningEffortUnsupportedError``
    otherwise; ``model_provider`` has already passed ``model_unusable_reason``.
    """

    effort = reasoning_effort.strip() if isinstance(reasoning_effort, str) else ""
    if not effort:
        return None
    try:
        validate_model_provider_for_direct_turn(
            model_provider,
            request_options=DirectChatOptions(reasoning_effort=effort),
            # The flag stands for "function tools ride on this request", which is what blocks an effort.
            memory_tools_active=True,
        )
    except DirectChatTurnSetupError as error:
        raise GenerationReasoningEffortUnsupportedError from error
    return effort


@dataclass(frozen=True)
class RunInput:
    """One run, planned from the stored conversation and the caller's request.

    ``draft`` is the draft to revise, or ``None`` for a new one. ``answers``
    is ``None`` while the request may still be asked about; otherwise what
    the person said to the questions, as ``prompts.write_message`` takes it.
    ``recent_turns`` are the conversation's last text turns before this
    request. ``reasoning_effort`` is the level every pass names, or ``None``
    for the model's default.
    """

    owner_user_id: str
    conversation_id: str
    message: str
    model_provider: ModelProvider
    intent: Intent
    draft: GenerationDraft | None
    ui_locale: str | None
    answers: Mapping[str, Any] | None
    recent_turns: tuple[Mapping[str, str], ...]
    avatar_expressions: Mapping[str, object] | None
    reasoning_effort: str | None = None

    @property
    def can_ask(self) -> bool:
        """Whether a pass may still ask the person about this request (once, decision P4)."""

        return self.answers is None


_ENDED_EARLY: Final = frozenset({"failed", "stopped"})
"""Outcomes of a run that did not finish. Whether it used what the person sent is told by the draft it names."""


def _questions_outstanding(messages: Sequence[GenerationMessage]) -> bool:
    """Whether the assistant's questions still wait for a run that uses the person's answers.

    The conversation is read from its end:

    - the person's own turns are passed over;
    - an assistant turn that carries questions means they are outstanding,
      whatever its outcome (a stream closed as the questions were sent is
      stored as ``stopped``, with them);
    - an assistant turn of a run that failed or was stopped and that names no
      draft is an attempt that did no work, and is passed over: a retry after
      a plan limit, an expired sign-in or a stop still answers the questions,
      and they are not asked a second time;
    - any other assistant turn used what the person sent, so nothing is
      outstanding.

    A run's turn names a draft only when the run left one changed
    (``GenerationRun._settle``): a new draft it kept, the draft it revised
    once the revision was stored, or a new draft the page was shown and the
    person then discarded. So a run that got the answers, stored its draft and
    then failed or was stopped has answered the questions, while an attempt at
    a revision that stored nothing has not.
    """

    for message in reversed(messages):
        if message.role == "user":
            continue
        if message.data.get("questions"):
            return True
        if message.data.get("outcome") in _ENDED_EARLY and message.data.get("draft_id") is None:
            continue
        return False
    return False


def _given_answers(answers: Mapping[str, Any] | None) -> Mapping[str, Any]:
    """The caller's answers in the two shapes the prompts know; anything without an answer reads as skipped."""

    listed = answers.get("answers") if answers is not None else None
    given = [
        {"question": entry["question"], "answer": entry["answer"]}
        for entry in (listed if isinstance(listed, list | tuple) else ())
        if isinstance(entry, Mapping)
        and isinstance(entry.get("question"), str)
        and isinstance(entry.get("answer"), str)
    ]
    if answers is None or answers.get("skipped") is True or not given:
        return {"skipped": True}
    return {"answers": given}


def plan_run(
    snapshot: GenerationConversationSnapshot,
    *,
    message: str,
    model_provider: ModelProvider,
    intent: str = "gesture",
    draft_id: str | None = None,
    ui_locale: str | None = None,
    answers: Mapping[str, Any] | None = None,
    avatar_expressions: Mapping[str, object] | None = None,
    reasoning_effort: str | None = None,
) -> RunInput:
    """Plan a run on the owner's conversation, or refuse it with a ``GenerationError``.

    ``draft_id`` must be a draft of this conversation that holds a project,
    and a revision takes its draft's intent. Reactions are refused until
    their guidance exists (the plan's Phase 5). ``reasoning_effort`` must be
    a level the model can run a pass at (``accepted_reasoning_effort``); a
    blank one counts as none. Questions are asked once for a
    request whatever the caller sends: while the assistant's questions are
    outstanding (no run has used answers to them yet, however many failed or
    were stopped before they stored a draft), this run answers them, with
    ``answers`` or as skipped; answers to questions nobody asked are ignored.
    """

    draft: GenerationDraft | None = None
    if draft_id is not None:
        draft = next((candidate for candidate in snapshot.drafts if candidate.id == draft_id), None)
        if draft is None:
            raise GenerationNotFoundError
        if draft.project is None:
            raise GenerationDraftEmptyError
        intent = draft.intent
    if intent != "gesture":
        raise GenerationIntentUnavailableError
    effort = accepted_reasoning_effort(model_provider, reasoning_effort)
    conversation = snapshot.conversation
    turns = tuple({"role": turn.role, "text": turn.text} for turn in snapshot.messages[-prompts.MAX_RECENT_TURNS :])
    return RunInput(
        owner_user_id=conversation.owner_user_id,
        conversation_id=conversation.id,
        message=message,
        model_provider=model_provider,
        intent="gesture",
        draft=draft,
        ui_locale=ui_locale,
        answers=_given_answers(answers) if _questions_outstanding(snapshot.messages) else None,
        recent_turns=turns,
        avatar_expressions=avatar_expressions,
        reasoning_effort=effort,
    )


# --- What a run tells the page ------------------------------------------------------------


@dataclass(frozen=True)
class RunStarted:
    run_id: str


@dataclass(frozen=True)
class Progress:
    """What the run is doing now, for the page to say in words. ``draft_id`` is absent until the draft exists."""

    phase: ProgressPhase
    draft_id: str | None = None


@dataclass(frozen=True)
class MessageDelta:
    """More of the assistant's text for this run; the pieces in order are the stored message."""

    text: str


@dataclass(frozen=True)
class Questions:
    """The run ends here: the assistant asks the person before writing."""

    questions: tuple[Mapping[str, Any], ...]


@dataclass(frozen=True)
class DraftUpdated:
    """A draft as it is stored now: a new version, or a new status."""

    draft: GenerationDraft


@dataclass(frozen=True)
class FramesRequested:
    """The page should render and upload the review sheets of this draft version."""

    draft_id: str
    version: int


@dataclass(frozen=True)
class RunFailed:
    """Why the run failed: a model client's code with chat's own details, or a ``generation_*`` code."""

    code: str
    category: str
    details: Mapping[str, Any]


@dataclass(frozen=True)
class RunCompleted:
    """The run's last event, whatever its outcome, with its token use."""

    usage: RunUsage


RunEvent = RunStarted | Progress | MessageDelta | Questions | DraftUpdated | FramesRequested | RunFailed | RunCompleted


# --- The run ------------------------------------------------------------------------------


class _RunFailure(Exception):
    """A failure of the run itself, reported to the page as ``RunFailed``."""

    def __init__(self, code: str, details: Mapping[str, Any]) -> None:
        super().__init__(code)
        self.code = code
        self.details = details


@dataclass
class _Reply:
    """The assistant's text for one run: what the model said outside tool calls, and each pass's note.

    Pieces are separated by a blank line. ``add`` returns the text to send
    the page, so the deltas sent, joined, are the text kept.
    """

    parts: list[str] = field(default_factory=list)
    open: bool = False

    def add(self, text: str) -> str:
        if self.open:
            self.parts[-1] += text
            return text
        self.open = True
        self.parts.append(text)
        return text if len(self.parts) == 1 else f"\n\n{text}"

    def end_piece(self) -> None:
        self.open = False

    def text(self) -> str:
        return "\n\n".join(self.parts)


def _storable(text: str) -> str:
    """``text`` as PostgreSQL can store it, cut to its limit: no NUL, and no unpaired surrogate."""

    return text.replace("\x00", "").encode("utf-8", "replace").decode("utf-8")[:MAX_REPLY_LENGTH]


class GenerationRun:
    """One run on one conversation. Iterate ``events`` once; closing or cancelling the iteration stops the run.

    ``storage`` opens the assistant's storage on a fresh session for each
    step. ``client`` is the model client of the run's model row; with
    ``author`` set, the deterministic author stands in for every model pass
    (``ANIMAMA_LLM_SKIP``) and no client is used. ``check_reports`` is the
    signal the storage wakes when the page stores a report, and ``frames``
    where the page's review sheets arrive. ``selector_in_use`` and
    ``example_reader`` are what the tools may ask of the owner's Library.
    """

    def __init__(
        self,
        plan: RunInput,
        *,
        storage: Storage,
        client: ModelClient | None,
        check_reports: CheckReportSignal,
        frames: ReviewFrameStore,
        author: DeterministicAuthor | None = None,
        selector_in_use: SelectorInUse | None = None,
        example_reader: ExampleReader | None = None,
        check_wait_seconds: float | None = None,
        frames_wait_seconds: float | None = None,
    ) -> None:
        if client is None and author is None:
            raise ValueError("A run needs a model client or the deterministic author")
        self.run_id = f"run-{uuid4().hex}"
        self._plan = plan
        self._storage = storage
        self._client = client
        self._author = author
        self._check_reports = check_reports
        self._frames = frames
        self._selector_in_use = selector_in_use
        self._example_reader = example_reader
        self._check_wait = CHECK_WAIT_SECONDS if check_wait_seconds is None else check_wait_seconds
        self._frames_wait = FRAMES_WAIT_SECONDS if frames_wait_seconds is None else frames_wait_seconds
        # Byte-identical for every pass of the run, so a provider's prompt cache can serve it.
        self._instructions = prompts.instructions(plan.intent, plan.ui_locale, plan.avatar_expressions)
        self._cache_key = scoped_prompt_cache_key(
            user_id=plan.owner_user_id,
            anima_id=f"content-assistant:{plan.intent}",
            provider_type=plan.model_provider.provider_type,
            model=plan.model_provider.model,
        )
        self._usage = RunUsage()
        self._cost = RunCostMeter(plan.model_provider)
        # False once a pass found that the provider keeps no response to continue from: the run's later
        # passes then name none, so the whole run spends at most one refused request on finding out.
        self._stored_responses = True
        self._reply = _Reply()
        self._outcome: RunOutcome = "stopped"
        self._questions: list[Mapping[str, Any]] = []
        self._error: dict[str, str] | None = None
        self._draft_id: str | None = None
        self._told_status: GenerationDraftStatus | None = None
        self._request_stored = False
        self._reply_stored = False
        self._pass_end: PassEnd = "round_limit"
        self._pass_text = ""

    async def events(self) -> AsyncGenerator[RunEvent, None]:
        """Run to the end, yielding what the page should know; the last event is ``RunCompleted``.

        A model error, a draft or conversation removed under the run, and any
        unexpected failure end the run with ``RunFailed`` before
        ``RunCompleted``. Stopping (closing or cancelling this iteration)
        yields nothing more. Either way the draft keeps its last stored
        project and is left in a status that describes it, and the
        conversation gets the assistant's message with the run's outcome and
        token use.
        """

        plan = self._plan
        _log.info(
            "Generation run started",
            run_id=self.run_id,
            conversation_id=plan.conversation_id,
            draft_id=plan.draft.id if plan.draft is not None else None,
            intent=plan.intent,
            model_provider_id=plan.model_provider.id,
            message_length=len(plan.message),
            recent_turn_count=len(plan.recent_turns),
            can_ask=plan.can_ask,
            reasoning_effort=plan.reasoning_effort,
            deterministic_author=self._author is not None,
        )
        yield RunStarted(self.run_id)
        settled = False
        try:
            failure: RunFailed | None = None
            try:
                # Closed with this block, so stopping at an event also ends the pass and its model request.
                async with aclosing(self._steps()) as steps:
                    async for event in steps:
                        if isinstance(event, DraftUpdated):
                            self._told_status = event.draft.status
                        yield event
            except ModelClientError as error:
                details = json_safe_dict(model_error_details(error, plan.model_provider))
                category = model_error_category(error.code, error.raw_metadata)
                failure = RunFailed(code=error.code or "model_client_error", category=category, details=details)
            except GenerationNotFoundError:
                # The person discarded the draft or the conversation while the run worked on it.
                failure = RunFailed(code=GenerationNotFoundError.code, category="generation", details={})
            except _RunFailure as error:
                failure = RunFailed(code=error.code, category="generation", details=dict(error.details))
            except Exception as error:
                # The failure's own wording could quote a clip or a message, so the log says what failed and where.
                _log.error(
                    "Generation run failed unexpectedly",
                    run_id=self.run_id,
                    exc_type=type(error).__name__,
                    site=failure_site(error),
                )
                failure = RunFailed(code=RUN_FAILED, category="internal", details={})
            if failure is not None:
                self._outcome = "failed"
                self._error = {"code": failure.code, "category": failure.category}
            left = await self._settle()
            settled = True
            if left is not None:
                yield DraftUpdated(left)
            if failure is not None:
                yield failure
            yield RunCompleted(self._usage)
        finally:
            if not settled:
                # Stopped: the page closed the stream, or the request was cancelled.
                self._outcome = "stopped"
                try:
                    await self._settle()
                except Exception as error:
                    _log.warning(
                        "Generation run could not be settled",
                        run_id=self.run_id,
                        exc_type=type(error).__name__,
                        site=failure_site(error),
                    )
            _log.info(
                "Generation run ended",
                run_id=self.run_id,
                conversation_id=plan.conversation_id,
                draft_id=self._draft_id,
                outcome=self._outcome,
                code=self._error["code"] if self._error is not None else None,
                model_requests=self._usage.requests,
            )

    # ------------------------------------------------------------------------ steps

    async def _steps(self) -> AsyncGenerator[RunEvent, None]:
        """The write or revise pass, then checks, repairs and the frame review of the draft it leaves."""

        plan = self._plan
        owner, revised = plan.owner_user_id, plan.draft
        yield Progress("thinking", revised.id if revised is not None else None)
        async with self._storage() as service:
            await service.add_message(owner, plan.conversation_id, "user", plan.message, self._user_data())
        self._request_stored = True

        if revised is not None and revised.project is not None:
            kind: PassKind = "revise"
            working = WorkingDraft.from_project(revised.project)
            message = prompts.revise_message(plan.message, revised.project, plan.recent_turns, plan.answers)
        else:
            kind, working = "write", WorkingDraft(intent=plan.intent)
            message = prompts.write_message(plan.message, plan.recent_turns, plan.answers)
        async with aclosing(self._pass(kind, working, message, draft_id=revised.id if revised else None)) as events:
            async for event in events:
                yield event

        if self._pass_end == "asked":
            self._outcome, self._questions = "questions", list(working.questions)
            yield Questions(tuple(working.questions))
            return
        if self._pass_end == "no_tool_call" and self._pass_text.strip():
            # The model answered in words: the request is not one it can author.
            self._outcome = "reply"
            return
        if self._pass_end not in _DRAFT_ENDS:
            if revised is not None:
                # Nothing was stored, so the draft and what a restore returns to are as they were.
                raise _RunFailure(NO_VALID_DRAFT, {"draft_id": revised.id})
            async with self._storage() as service:
                self._draft_id = (await service.create_draft(owner, plan.conversation_id, plan.intent)).id
                failed = await service.set_status(owner, self._draft_id, "failed", NO_VALID_DRAFT)
            self._outcome = "draft"
            yield DraftUpdated(failed)
            return

        # Only now, with a valid project in hand, does the draft change. A revision is one write: the project
        # from before the person's message and its replacement are stored together or not at all. A new draft
        # gets its row first; the draft is the run's from that write on, so a run stopped before the project is
        # stored still removes the empty row. The revised draft is the run's to settle from here as well, though
        # its turn names the draft only if the revision was stored (``_settle``).
        project = working.project()
        async with self._storage() as service:
            if revised is not None:
                self._draft_id = revised.id
                draft = await service.store_revision(owner, revised.id, project)
            else:
                self._draft_id = (await service.create_draft(owner, plan.conversation_id, plan.intent)).id
                draft = await service.store_project(owner, self._draft_id, project, "checking")
        self._outcome = "draft"
        yield DraftUpdated(draft)

        # Checks, and repairs while they fail.
        while True:
            yield Progress("checking", draft.id)
            report = await self._await_report(draft)
            if report is None:
                yield DraftUpdated(await self._leave_unchecked(draft))
                return
            if not needs_repair(report) or draft.repair_count >= MAX_REPAIR_PASSES or draft.project is None:
                break
            async with self._storage() as service:
                await service.count_repair(owner, draft.id)
                draft = await service.set_status(owner, draft.id, "repairing")
            yield DraftUpdated(draft)
            yield Progress("repairing", draft.id)
            working = WorkingDraft.from_project(cast(Mapping[str, Any], draft.project))
            repair = prompts.repair_message(cast(Mapping[str, Any], draft.project), report)
            async with aclosing(self._pass("repair", working, repair, draft_id=draft.id)) as events:
                async for event in events:
                    yield event
            if self._pass_end not in _DRAFT_ENDS:
                # The model made no valid change; another pass on the same findings would be the same.
                break
            async with self._storage() as service:
                draft = await service.store_project(owner, draft.id, working.project(), "checking")
            yield DraftUpdated(draft)

        # One frame review, when the clip can be drawn and the model can look at it.
        if is_loadable(report) and plan.model_provider.accepts_images and draft.project is not None:
            edited = False
            with self._frames.expecting(draft.id, draft.version) as arrival:
                yield FramesRequested(draft_id=draft.id, version=draft.version)
                sheets = await self._arrived(arrival)
                if sheets:
                    async with self._storage() as service:
                        draft = await service.set_status(owner, draft.id, "reviewing")
                    yield DraftUpdated(draft)
                    yield Progress("reviewing_frames", draft.id)
                    working = WorkingDraft.from_project(cast(Mapping[str, Any], draft.project))
                    review = prompts.review_message(
                        cast(Mapping[str, Any], draft.project), len(sheets), names_not_on_review_sheets(report)
                    )
                    reviewing = self._pass("review", working, review, draft_id=draft.id, sheets=sheets)
                    async with aclosing(reviewing) as events:
                        async for event in events:
                            yield event
                    edited = self._pass_end == "edited"
            if edited:
                # The review's one edit is checked once more; no further model pass follows it.
                async with self._storage() as service:
                    draft = await service.store_project(owner, draft.id, working.project(), "checking")
                yield DraftUpdated(draft)
                yield Progress("checking", draft.id)
                report = await self._await_report(draft)
                if report is None:
                    yield DraftUpdated(await self._leave_unchecked(draft))
                    return

        status, reason = final_status(report)
        async with self._storage() as service:
            draft = await service.set_status(owner, draft.id, status, reason)
        yield DraftUpdated(draft)

    async def _pass(
        self,
        kind: PassKind,
        working: WorkingDraft,
        message: str,
        *,
        draft_id: str | None,
        sheets: Sequence[ReviewSheet] = (),
    ) -> AsyncGenerator[RunEvent, None]:
        """Run one pass on ``working``; how it ended is left in ``_pass_end`` and ``_pass_text``."""

        plan = self._plan
        self._pass_end, self._pass_text = "round_limit", ""
        authoring = kind in ("write", "revise")
        rounds = 0
        if self._author is not None:
            if authoring:
                yield Progress("writing", draft_id)
            call = self._author_call(kind, working)
            run_tool(
                working,
                call,
                offered_tools(kind, can_ask=plan.can_ask),
                selector_in_use=self._selector_in_use,
                example_reader=self._example_reader,
            )
            self._pass_end = working.outcome or "round_limit"
        else:
            spec = PassSpec(
                kind=kind,
                model_provider=plan.model_provider,
                instructions=self._instructions,
                message=message,
                prompt_cache_key=self._cache_key,
                reasoning_effort=plan.reasoning_effort,
                stored_responses=self._stored_responses,
                sheets=tuple(sheets),
                can_ask=plan.can_ask,
                selector_in_use=self._selector_in_use,
                example_reader=self._example_reader,
            )
            announced = False
            async with aclosing(run_pass(cast(ModelClient, self._client), spec, working)) as items:
                async for item in items:
                    if isinstance(item, PassText):
                        yield MessageDelta(self._reply.add(item.text))
                    elif isinstance(item, PassWriting):
                        if authoring and not announced:
                            announced = True
                            yield Progress("writing", draft_id)
                    elif isinstance(item, PassRound):
                        # The totals keep every response's figures; only a provider's own report is priced.
                        self._usage = self._usage.plus(item.usage)
                        self._cost.add(item.usage, reported=item.usage_reported)
                        self._reply.end_piece()
                    elif isinstance(item, PassCursorLost):
                        self._stored_responses = False
                    else:
                        self._pass_end, self._pass_text, rounds = item.end, item.text, item.rounds
        _log.info(
            "Generation pass ended",
            run_id=self.run_id,
            draft_id=draft_id,
            pass_kind=kind,
            end=self._pass_end,
            rounds=rounds,
            sheet_count=len(sheets),
        )
        if working.outcome in ("submitted", "edited", "accepted") and working.note:
            # The model's own account of what it made or changed is the assistant's reply.
            yield MessageDelta(self._reply.add(working.note))
            self._reply.end_piece()

    def _author_call(self, kind: PassKind, working: WorkingDraft) -> ModelClientToolCall:
        """The deterministic author's tool call for one pass."""

        author = cast(DeterministicAuthor, self._author)
        if kind == "write":
            return author.write(self._plan.message, selector_in_use=self._selector_in_use)
        if kind == "review":
            return author.review()
        return author.revise(working.project()) if kind == "revise" else author.repair(working.project())

    # ------------------------------------------------------------------- the page

    async def _await_report(self, draft: GenerationDraft) -> dict[str, Any] | None:
        """Wait for the page's check report on this draft version; ``None`` when none arrives in time.

        No session is held while waiting: the report is read on a
        short-lived one at once, whenever this process stores a report for
        the draft, and otherwise every ``REPORT_POLL_SECONDS``. Raises
        ``GenerationNotFoundError`` once the draft is gone.
        """

        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, self._check_wait)
        with self._check_reports.listening(draft.id) as stored:
            while True:
                # Cleared before the read, so a report stored during it still ends the next wait at once.
                stored.clear()
                async with self._storage() as service:
                    report = await service.check_report_for(self._plan.owner_user_id, draft.id, draft.version)
                if report is not None:
                    return report
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return None
                try:
                    await asyncio.wait_for(stored.wait(), min(REPORT_POLL_SECONDS, remaining))
                except TimeoutError:
                    pass

    async def _leave_unchecked(self, draft: GenerationDraft) -> GenerationDraft:
        """Leave a version whose report did not arrive in time with a warning that its checks did not run.

        The report is read once more first, so one stored just as the wait
        ended is kept: the draft is then left as that report describes it.
        """

        owner = self._plan.owner_user_id
        async with self._storage() as service:
            report = await service.check_report_for(owner, draft.id, draft.version)
            if report is None:
                _log.info("Generation draft was not checked in time", run_id=self.run_id, draft_id=draft.id)
                report = unchecked_report()
                await service.record_check_report(owner, draft.id, draft.version, report)
            return await service.set_status(owner, draft.id, *final_status(report))

    async def _arrived(self, arrival: asyncio.Future[tuple[ReviewSheet, ...]]) -> tuple[ReviewSheet, ...]:
        """The review sheets the page uploads, at most ``MAX_REVIEW_SHEETS``; none when it uploads none in time."""

        try:
            sheets = await asyncio.wait_for(arrival, max(0.0, self._frames_wait))
        except TimeoutError:
            return ()
        return tuple(sheets)[:MAX_REVIEW_SHEETS]

    # ---------------------------------------------------------------------- ending

    def _user_data(self) -> dict[str, Any]:
        """What the person's turn carried besides its text."""

        plan = self._plan
        data: dict[str, Any] = {}
        if plan.draft is not None:
            data["draft_id"] = plan.draft.id
        if plan.answers is not None:
            data["answers"] = dict(plan.answers)
        return data

    async def _settle(self) -> GenerationDraft | None:
        """Leave the draft and the conversation as the run ended; returns the draft when the page has not seen it so.

        A draft still in one of the run's own steps is settled by the
        storage's rule (``GenerationService.settle_draft``): deleted when it
        never got a project, described by the report of its current version,
        or back to ``checking`` for the page to check. The assistant's
        message is stored once, with the outcome, the token use, the model
        the run named and, where that model has a price, the estimate of
        what the run cost (``usage.py``). A draft or conversation that is
        gone is left alone.

        The message names the draft only when the run left it changed: a new
        draft that was kept or that the page was shown before the person
        discarded it, or a revised one whose version moved. Whether a
        revision was stored is read from the draft, so a run that failed or
        was stopped as it stored one says what is true either way.
        ``plan_run`` reads the name as "this run used what the person sent".
        """

        owner, changed = self._plan.owner_user_id, None
        if self._draft_id is not None:
            async with self._storage() as service:
                try:
                    settled = await service.settle_draft(owner, self._draft_id, RUN_STATUSES)
                except GenerationNotFoundError:
                    settled = None
            revised = self._plan.draft
            if settled is None:
                # Gone. A draft the page was already shown keeps its name on the turn: the run made it.
                if self._told_status is None:
                    self._draft_id = None
            elif revised is not None and settled.version == revised.version:
                self._draft_id = None
            elif settled.status != self._told_status:
                changed = settled
        if self._request_stored and not self._reply_stored:
            data: dict[str, Any] = {
                "run_id": self.run_id,
                "outcome": self._outcome,
                "usage": asdict(self._usage),
                "model": run_model(self._plan.model_provider, self._plan.reasoning_effort),
            }
            # The estimate itself is stored, at the prices the row had when the run started, so a later price
            # change does not rewrite the turn.
            estimate = self._cost.estimate()
            if estimate is not None:
                data["cost"] = estimate.stored()
            if self._draft_id is not None:
                data["draft_id"] = self._draft_id
            if self._questions:
                data["questions"] = [dict(question) for question in self._questions]
            if self._error is not None:
                data["error"] = dict(self._error)
            async with self._storage() as service:
                try:
                    await service.add_message(
                        owner, self._plan.conversation_id, "assistant", _storable(self._reply.text()), data
                    )
                except GenerationNotFoundError:
                    pass
            self._reply_stored = True
        return changed


__all__ = [
    "CHECK_WAIT_SECONDS",
    "FRAMES_WAIT_SECONDS",
    "MAX_REPAIR_PASSES",
    "MIN_CONTEXT_WINDOW_TOKENS",
    "NO_VALID_DRAFT",
    "RUN_FAILED",
    "RUN_STATUSES",
    "DraftUpdated",
    "FramesRequested",
    "GenerationDraftEmptyError",
    "GenerationIntentUnavailableError",
    "GenerationReasoningEffortUnsupportedError",
    "GenerationRun",
    "MessageDelta",
    "Progress",
    "ProgressPhase",
    "Questions",
    "RunCompleted",
    "RunEvent",
    "RunFailed",
    "RunInput",
    "RunStarted",
    "RunUsage",
    "Storage",
    "accepted_reasoning_effort",
    "model_unusable_reason",
    "plan_run",
]
