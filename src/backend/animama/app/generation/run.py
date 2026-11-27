"""The run pipeline: one request from the person, as a stream of events for the page.

A run takes the person's message and makes or revises one draft through a few
bounded model passes (decision D2): a write or revise pass, repair passes while
the page's checks fail, and one frame review when the model accepts images. The
backend builds every request from stored state and fixed instructions and
tools (threat T3). Whatever a model wrote is validated before it is stored
(T1), and what the page reports only decides repairs and warnings (T6).

On the Generate page a write pass may instead plan a batch (spec R7.4): up to
``MAX_BATCH_ITEMS`` items, each with a brief. Every item then gets a draft of
its own and its own write, check, repair and review passes, with at most
``MAX_BATCH_CONCURRENCY`` items in flight. An item that fails does not stop
the others, and the batch is still one run on its conversation.

The limits of a run are here and in the modules it uses (T7): one draft a
request or the planned items of one batch, ``MAX_TOOL_ROUNDS`` responses a
pass, ``MAX_REPAIR_PASSES`` repair passes and one review for a draft version,
``MAX_REVIEW_SHEETS`` sheets a review, bounded waits for the page's report and
sheets, and ``MAX_BATCH_SECONDS`` for the items of a batch. The worst case of
a batch is stated beside those constants.

A run holds no database session while it waits on the model or the page: each
storage step opens a short-lived one. It writes only the assistant's own
tables, never a Chat, a chat message, memory or an episode (T5). Logs carry
ids, counts and codes, never text.
"""

from __future__ import annotations

import asyncio
import copy
from collections import deque
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
from animama.app.model_clients.error_categories import (
    ERROR_CREDENTIAL_MISSING,
    ERROR_CREDENTIAL_REJECTED,
    ERROR_MODEL_NOT_FOUND,
    ERROR_NOT_ELIGIBLE,
    ERROR_QUOTA_EXCEEDED,
    ERROR_RATE_LIMITED,
    ERROR_SIGN_IN_REQUIRED,
    ERROR_USAGE_LIMIT,
    model_error_category,
)
from animama.app.model_clients.prompt import scoped_prompt_cache_key
from animama.app.services.idle_clip_validation import V2_CLIP_FIELDS
from animama.app.util.json_values import json_safe_dict
from animama.domain import ModelProvider
from animama.domain.generation import (
    GENERATION_INTENTS,
    GENERATION_SCOPE_CREATOR,
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
from .draft_validation import (
    ACTION_PROJECT_SCHEMA,
    CATALOG_STRING_LENGTH,
    Intent,
    JsonObject,
    SelectorInUse,
    clip_and_details,
    clip_id,
    held_detail_problems,
    held_details,
    timeline_problems,
)
from .effects import EffectAccess, EffectLibrary
from .passes import PassCursorLost, PassEnd, PassRound, PassSpec, PassText, PassWriting, run_pass
from .review_frames import MAX_REVIEW_SHEETS, ReviewFrameStore, ReviewSheet
from .service import CheckReportSignal, GenerationService
from .tools import (
    MAX_BATCH_ITEMS,
    MAX_TOOL_ROUNDS,
    ExampleReader,
    PassKind,
    WorkingDraft,
    offered_tools,
    run_tool,
)
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

MAX_PASSES_PER_DRAFT: Final = 1 + MAX_REPAIR_PASSES + 1
"""Model passes for one draft in one run: a write or revise pass, the repair passes, and one frame review."""
MAX_BATCH_CONCURRENCY: Final = 2
"""Items of a batch in flight at once, which is also the most provider streams one run holds open: an item
runs one pass at a time, a pass one request at a time, and the planning pass has ended before any item starts."""
MAX_BATCH_SECONDS: Final = 60 * 60
"""How long the items of one batch may take together, from the plan to the last item's end.

A batch that is still working then ends as a stopped run does (finished
drafts are kept, an unfinished item keeps what it had validated, and an item
never written is removed), with the failure ``BATCH_TIME_LIMIT``. Ten items
written, checked, repaired and reviewed two at a time take about half of it
on a slow model; the limit is the backstop that makes a batch's wall time
finite whatever a provider or the page does.
"""
MAX_BATCH_MODEL_RESPONSES: Final = MAX_TOOL_ROUNDS * (1 + MAX_BATCH_ITEMS * MAX_PASSES_PER_DRAFT)
"""The most model responses one batch can ask for: 408.

The planning pass (8 responses), then for each of 10 items at most 5 passes
(one write, three repairs, one review) of at most 8 responses each. A route
that lost its stored responses costs at most ``MAX_BATCH_CONCURRENCY``
refused requests on top, one for each item that found out at the same moment
(``PassCursorLost``). A model failure that every item would meet (an expired
sign-in, a spent allowance: ``fails_every_item``) ends the batch at once, so
it costs at most ``MAX_BATCH_CONCURRENCY`` requests, one for each item in
flight; any other model failure is its own item's and costs that item's
request.

Worst case of one batch, in all: 408 model responses, 2 concurrent provider
streams, and 60 minutes of wall time for its items after the planning pass,
which is a single run's ordinary write pass.
"""

NO_VALID_DRAFT: Final = "generation_no_valid_draft"
"""A pass ended without a draft that validates."""
RUN_FAILED: Final = "generation_run_failed"
"""A run ended on a failure that is not a model's or the caller's."""
BATCH_TIME_LIMIT: Final = "generation_batch_time_limit"
"""A batch's items were still being worked on after ``MAX_BATCH_SECONDS``."""

EVERY_ITEM_FAILURES: Final = frozenset(
    {
        ERROR_CREDENTIAL_MISSING,
        ERROR_CREDENTIAL_REJECTED,
        ERROR_MODEL_NOT_FOUND,
        ERROR_NOT_ELIGIBLE,
        ERROR_QUOTA_EXCEEDED,
        ERROR_RATE_LIMITED,
        ERROR_SIGN_IN_REQUIRED,
        ERROR_USAGE_LIMIT,
    }
)
"""The model clients' error categories that are about the connection or its allowance, not about one request:
a missing or refused key, a sign-in to renew, a model the provider does not serve, an account that may not use
it, and a quota, usage or rate limit. The next item of a batch would meet the same failure."""

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


class GenerationDocumentInvalidError(GenerationError):
    """The document sent with a run cannot be what a pass starts from.

    ``reason`` says what is wrong: ``document`` (it is not a creator's
    conversation, or the document is of another kind than the conversation's
    item), ``timeline`` (its clip fails the validation every draft's clip
    passes) or ``details`` (a detail the item has is not one a saved item
    may have).
    """

    code = "generation_document_invalid"

    def __init__(self, reason: Literal["document", "timeline", "details"] = "document") -> None:
        super().__init__()
        self.reason = reason


class GenerationDraftEmptyError(GenerationError):
    """The draft to revise holds no project, so there is nothing to revise."""

    code = "generation_draft_empty"


class GenerationReasoningEffortUnsupportedError(GenerationError):
    """The run names a reasoning effort its model cannot run a pass at."""

    code = "generation_reasoning_effort_unsupported"


def fails_every_item(error: ModelClientError) -> bool:
    """Whether a model failure in one item of a batch is one every other item would meet (``EVERY_ITEM_FAILURES``).

    Chat's own categories decide (``model_error_category``), so the batch
    ends on the failures whose notice offers the person something to do
    about the connection, and nowhere else.
    """

    return model_error_category(error.code, error.raw_metadata) in EVERY_ITEM_FAILURES


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
    for the model's default. ``document`` is the project a creator sent as
    the item open in it, already checked (``creator_document``): the run then
    revises it instead of the draft's stored project. ``can_plan`` lets the
    write pass plan a batch: only a request for a new draft on the Generate
    page may, never a creator's run (it works on the open item) and never a
    revision. ``effects`` lets the run's Gesture drafts place existing
    effects: true on the Generate page, false in a creator, whose page keeps
    the open item's events and dependencies off the request and puts them
    back on the result.
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
    document: Mapping[str, Any] | None = None
    can_plan: bool = False
    effects: bool = False

    @property
    def held_details(self) -> frozenset[str]:
        """The details that are the open item's own, which no pass of a creator's run changes."""

        if self.document is None:
            return frozenset()
        return held_details(self.intent, clip_and_details(self.document)[1])

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


DocumentFault = Literal["document", "timeline", "details"]
"""What is wrong with a creator's document: its shape or place, its clip, or its details."""


def _has_overlong_string(value: object, limit: int) -> bool:
    """Whether a JSON value holds a string, or an object key, longer than ``limit``.

    Walked without recursion; the caller has already bounded the value's depth
    and size.
    """

    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, str):
            if len(current) > limit:
                return True
        elif isinstance(current, dict):
            if any(isinstance(key, str) and len(key) > limit for key in current):
                return True
            pending.extend(current.values())
        elif isinstance(current, list | tuple):
            pending.extend(current)
    return False


def creator_document(intent: Intent, document: Mapping[str, Any]) -> JsonObject:
    """The project a creator's run starts from, or ``GenerationDocumentInvalidError`` saying what is wrong.

    The page sends the item open in a creator as an
    ``animamaActionProject/1.0`` project. It is untrusted input (threat T1),
    and it reaches a model, so nothing of it is kept that this backend does
    not know:

    - **The clip** keeps only the fields the 2.0 format defines
      (``V2_CLIP_FIELDS``), and then passes exactly the validation a model's
      clip passes: size, depth, structure, a draft's length, no body field in
      a Reaction, no timeline event, no playback lifetime. No string in it
      may be longer than the catalog allows a saved item's
      (``CATALOG_STRING_LENGTH``). Its ``id`` and ``name`` are not the
      caller's: they are derived from the item's name, as the creator does.
    - **The details** the item already has (``held_details``) are the
      person's. They are held to the catalog's own rules for a saved item
      (``held_detail_problems``), not a draft's stricter ones, since no pass
      may change them. A blank detail is not the item's yet: a pass writes
      it, and the tools then judge it as a draft's.

    What is returned is rebuilt from the kept clip fields and those details
    alone.
    """

    if document.get("schema") != ACTION_PROJECT_SCHEMA or document.get("intent") != intent:
        raise GenerationDocumentInvalidError("document")
    sent = document.get("sequence")
    if not isinstance(sent, dict):
        raise GenerationDocumentInvalidError("timeline")
    gesture = intent == "gesture"
    # The details first: a name that cannot be stored is a fault of the details, though the clip carries the
    # name too.
    details: JsonObject = {"name": document.get("name", "")}
    if gesture:
        details |= {"ai_description": document.get("aiDescription", ""), "selector_id": document.get("semanticKey", "")}
    else:
        details |= {"emotion": document.get("suggestedEmotion", ""), "intensity": document.get("suggestedIntensity", 1)}
    if held_detail_problems(intent, details):
        raise GenerationDocumentInvalidError("details")
    name = details["name"].strip()
    # A shallow selection: nothing outside the format's own fields is walked, sized or kept.
    clip = {field: sent[field] for field in V2_CLIP_FIELDS if field in sent}
    # The clip's own name and id are the item's name and its slug, as the creator keeps them; what the caller
    # put there is not read.
    clip["name"] = name or f"New {'Gesture' if gesture else 'Reaction'}"
    clip["id"] = clip_id(name, intent)
    if timeline_problems(intent, clip) or _has_overlong_string(clip, CATALOG_STRING_LENGTH):
        raise GenerationDocumentInvalidError("timeline")
    sequence = copy.deepcopy(clip)
    return {
        "schema": ACTION_PROJECT_SCHEMA,
        "intent": intent,
        "name": name,
        "aiDescription": details["ai_description"].strip() if gesture else "",
        "semanticKey": details["selector_id"].strip() if gesture else "",
        "suggestedEmotion": "" if gesture else details["emotion"].strip(),
        "suggestedIntensity": 1 if gesture else details["intensity"],
        "notes": "",
        "sequence": sequence,
        "dependencies": [],
    }


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
    document: Mapping[str, Any] | None = None,
) -> RunInput:
    """Plan a run on the owner's conversation, or refuse it with a ``GenerationError``.

    ``draft_id`` must be a draft of this conversation, and a revision takes
    its draft's intent. A creator's conversation authors its item's kind
    whatever the caller names. ``document`` is the item open in that creator
    (``creator_document``): only a creator's conversation takes one, and the
    run revises it instead of a stored project, into the draft ``draft_id``
    names or a new one. Without a document the draft to revise must hold a
    project. ``reasoning_effort`` must be a level the model can run a pass at
    (``accepted_reasoning_effort``); a blank one counts as none. Questions
    are asked once for a request whatever the caller sends: while the
    assistant's questions are outstanding (no run has used answers to them
    yet, however many failed or were stopped before they stored a draft),
    this run answers them, with ``answers`` or as skipped; answers to
    questions nobody asked are ignored.
    """

    conversation = snapshot.conversation
    in_creator = conversation.scope.get("kind") == GENERATION_SCOPE_CREATOR
    if in_creator:
        intent = str(conversation.scope.get("intent"))
    draft: GenerationDraft | None = None
    if draft_id is not None:
        draft = next((candidate for candidate in snapshot.drafts if candidate.id == draft_id), None)
        if draft is None:
            raise GenerationNotFoundError
        if draft.project is None and document is None:
            raise GenerationDraftEmptyError
        if in_creator and draft.intent != intent:
            raise GenerationDocumentInvalidError("document")
        intent = draft.intent
    if intent not in GENERATION_INTENTS:
        raise GenerationDocumentInvalidError("document")
    kind = cast(Intent, intent)
    if document is not None:
        if not in_creator:
            raise GenerationDocumentInvalidError("document")
        document = creator_document(kind, document)
    effort = accepted_reasoning_effort(model_provider, reasoning_effort)
    turns = tuple({"role": turn.role, "text": turn.text} for turn in snapshot.messages[-prompts.MAX_RECENT_TURNS :])
    return RunInput(
        owner_user_id=conversation.owner_user_id,
        conversation_id=conversation.id,
        message=message,
        model_provider=model_provider,
        intent=kind,
        draft=draft,
        ui_locale=ui_locale,
        answers=_given_answers(answers) if _questions_outstanding(snapshot.messages) else None,
        recent_turns=turns,
        avatar_expressions=avatar_expressions,
        reasoning_effort=effort,
        document=document,
        can_plan=not in_creator and draft is None,
        effects=not in_creator,
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
    """More of the assistant's text for this run; the pieces in order are the stored message.

    ``draft_id`` names the item when the text is one batch item's note.
    """

    text: str
    draft_id: str | None = None


@dataclass(frozen=True)
class Questions:
    """The run ends here: the assistant asks the person before writing."""

    questions: tuple[Mapping[str, Any], ...]


@dataclass(frozen=True)
class DraftUpdated:
    """A draft as it is stored now: a new version, or a new status."""

    draft: GenerationDraft


@dataclass(frozen=True)
class PlannedItem:
    """One item of a batch as planned: its draft, its kind and its brief."""

    draft_id: str
    intent: Intent
    brief: str


@dataclass(frozen=True)
class BatchPlanned:
    """The write pass planned a batch: these drafts now exist, in plan order, and each is worked on in turn."""

    items: tuple[PlannedItem, ...]


@dataclass(frozen=True)
class ItemFailed:
    """One item of a batch failed, as ``RunFailed`` says a run did; the run goes on with the others."""

    draft_id: str
    code: str
    category: str
    details: Mapping[str, Any]


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


RunEvent = (
    RunStarted
    | Progress
    | MessageDelta
    | Questions
    | BatchPlanned
    | DraftUpdated
    | FramesRequested
    | ItemFailed
    | RunFailed
    | RunCompleted
)


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


@dataclass(frozen=True)
class _BatchHalted:
    """A worker's word to the batch that an item met a failure every item would meet; the batch ends on it."""

    error: ModelClientError


@dataclass
class _Item:
    """One draft a run works on, and where its passes stand.

    A run for one draft has one item. A batch has one for each planned item,
    with its ``brief`` and its ``number`` in the plan; its draft exists from
    the plan on (``planned_draft_id``), before anything is written.
    """

    intent: Intent
    number: int = 1
    brief: str | None = None
    draft_id: str | None = None
    """The draft the run settles for this item; ``None`` before it exists and once it is known to be gone."""
    planned_draft_id: str | None = None
    told_status: GenerationDraftStatus | None = None
    """The status the page was last told for the draft."""
    pass_end: PassEnd = "round_limit"
    pass_text: str = ""
    working: WorkingDraft | None = None
    """The working draft of the item's current or last pass."""
    error: dict[str, str] | None = None
    """Why a batch item failed, as its ``ItemFailed`` said."""

    @property
    def in_batch(self) -> bool:
        return self.brief is not None

    @property
    def selector_id(self) -> str | None:
        """The Selector ID the item's draft has taken, once a pass of it holds a valid Gesture."""

        working = self.working
        if working is None or working.clip is None:
            return None
        selector_id = working.details.get("selector_id")
        return selector_id if isinstance(selector_id, str) and selector_id else None


class GenerationRun:
    """One run on one conversation. Iterate ``events`` once; closing or cancelling the iteration stops the run.

    ``storage`` opens the assistant's storage on a fresh session for each
    step. ``client`` is the model client of the run's model row; with
    ``author`` set, the deterministic author stands in for every model pass
    (``ANIMAMA_LLM_SKIP``) and no client is used. ``check_reports`` is the
    signal the storage wakes when the page stores a report, and ``frames``
    where the page's review sheets arrive. ``selector_in_use``,
    ``example_reader`` and ``effect_library`` are what the tools may ask of
    the owner's Library; without an effect library no draft of the run may
    hold timeline events.
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
        effect_library: EffectLibrary | None = None,
        check_wait_seconds: float | None = None,
        frames_wait_seconds: float | None = None,
        batch_seconds: float | None = None,
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
        # One access for the run: an effect any pass listed or read may be placed by every later pass.
        self._effects = EffectAccess(effect_library) if plan.effects and effect_library is not None else None
        self._check_wait = CHECK_WAIT_SECONDS if check_wait_seconds is None else check_wait_seconds
        self._frames_wait = FRAMES_WAIT_SECONDS if frames_wait_seconds is None else frames_wait_seconds
        self._batch_seconds = MAX_BATCH_SECONDS if batch_seconds is None else batch_seconds
        # Byte-identical for every pass on one kind of draft, so a provider's prompt cache can serve it. A
        # batch may hold both kinds; the other kind's are built when its first item starts.
        self._instructions: dict[Intent, str] = {}
        self._instructions_for(plan.intent)
        self._usage = RunUsage()
        self._cost = RunCostMeter(plan.model_provider)
        # False once a pass found that the provider keeps no response to continue from: the run's later
        # passes then name none, so the whole run spends at most one refused request on finding out.
        self._stored_responses = True
        self._reply = _Reply()
        self._outcome: RunOutcome = "stopped"
        self._questions: list[Mapping[str, Any]] = []
        self._error: dict[str, str] | None = None
        # One item for one draft; a planned batch replaces it with its items.
        self._items: list[_Item] = [_Item(intent=plan.intent)]
        self._request_stored = False
        self._reply_stored = False

    def _instructions_for(self, intent: Intent) -> str:
        """The system message of every pass on a draft of ``intent`` in this run."""

        if intent not in self._instructions:
            plan = self._plan
            self._instructions[intent] = prompts.instructions(
                intent, plan.ui_locale, plan.avatar_expressions, effects=self._effects_for(intent) is not None
            )
        return self._instructions[intent]

    def _effects_for(self, intent: Intent) -> EffectAccess | None:
        """The effects a draft of ``intent`` may place in this run: a Gesture's on the Generate page, or none."""

        return self._effects if intent == "gesture" else None

    def _cache_key_for(self, intent: Intent) -> str | None:
        plan = self._plan
        return scoped_prompt_cache_key(
            user_id=plan.owner_user_id,
            anima_id=f"content-assistant:{intent}",
            provider_type=plan.model_provider.provider_type,
            model=plan.model_provider.model,
        )

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
                            self._told(event.draft)
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
            for draft in left:
                yield DraftUpdated(draft)
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
                draft_id=next((item.draft_id for item in self._items if item.draft_id is not None), None),
                item_count=len(self._items),
                failed_item_count=sum(1 for item in self._items if item.error is not None),
                outcome=self._outcome,
                code=self._error["code"] if self._error is not None else None,
                model_requests=self._usage.requests,
            )

    # ------------------------------------------------------------------------ steps

    def _told(self, draft: GenerationDraft) -> None:
        """Remember the status the page was just told for a draft of this run."""

        for item in self._items:
            if item.draft_id == draft.id:
                item.told_status = draft.status

    async def _steps(self) -> AsyncGenerator[RunEvent, None]:
        """The write or revise pass, then what it leaves: one draft's checks, repairs and review, or a batch."""

        plan = self._plan
        owner, revised = plan.owner_user_id, plan.draft
        item = self._items[0]
        yield Progress("thinking", revised.id if revised is not None else None)
        async with self._storage() as service:
            await service.add_message(owner, plan.conversation_id, "user", plan.message, self._user_data())
        self._request_stored = True

        # A creator's run revises the item as it stands in the creator, hand edits included; any other
        # revision starts from the draft's stored project.
        base = plan.document if plan.document is not None else (revised.project if revised is not None else None)
        if base is not None:
            kind: PassKind = "revise"
            working = WorkingDraft.from_project(base, held=plan.held_details, effects=self._effects_for(plan.intent))
            message = prompts.revise_message(
                plan.message, base, plan.recent_turns, plan.answers, effects=working.effects is not None
            )
        else:
            kind, working = "write", WorkingDraft(intent=plan.intent, effects=self._effects_for(plan.intent))
            message = prompts.write_message(
                plan.message,
                plan.recent_turns,
                plan.answers,
                plan.intent,
                can_plan=plan.can_plan,
                effects=working.effects is not None,
            )
        first = self._pass(
            item,
            kind,
            working,
            message,
            draft_id=revised.id if revised else None,
            can_plan=plan.can_plan and kind == "write",
        )
        async with aclosing(first) as events:
            async for event in events:
                yield event

        if item.pass_end == "asked":
            self._outcome, self._questions = "questions", list(working.questions)
            yield Questions(tuple(working.questions))
            return
        if item.pass_end == "planned":
            async with aclosing(self._batch(working.plan)) as events:
                async for event in events:
                    yield event
            return
        if item.pass_end == "no_tool_call" and item.pass_text.strip():
            # The model answered in words: the request is not one it can author.
            self._outcome = "reply"
            return
        async with aclosing(self._finish(item, working, base=base, revised=revised)) as events:
            async for event in events:
                yield event

    async def _finish(
        self,
        item: _Item,
        working: WorkingDraft,
        *,
        base: Mapping[str, Any] | None,
        revised: GenerationDraft | None,
    ) -> AsyncGenerator[RunEvent, None]:
        """Store what an item's write or revise pass left, then check, repair and review that draft.

        ``base`` is the project a revision started from and ``revised`` the
        draft it revises; both are ``None`` for a new draft. A batch item's
        draft row exists already (``item.draft_id``); a single run's new
        draft gets its row here.
        """

        plan = self._plan
        owner = plan.owner_user_id
        if item.pass_end not in _DRAFT_ENDS:
            if base is not None:
                # Nothing was stored, so the draft and what a restore returns to are as they were, and so is
                # the creator's document.
                raise _RunFailure(NO_VALID_DRAFT, {"draft_id": revised.id} if revised is not None else {})
            async with self._storage() as service:
                if item.draft_id is None:
                    item.draft_id = (await service.create_draft(owner, plan.conversation_id, item.intent)).id
                failed = await service.set_status(owner, item.draft_id, "failed", NO_VALID_DRAFT)
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
                item.draft_id = revised.id
                draft = await service.store_revision(owner, revised.id, project)
            else:
                if item.draft_id is None:
                    item.draft_id = (await service.create_draft(owner, plan.conversation_id, item.intent)).id
                draft = await service.store_project(owner, item.draft_id, project, "checking")
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
            working = WorkingDraft.from_project(
                cast(Mapping[str, Any], draft.project), held=plan.held_details, effects=self._effects_for(item.intent)
            )
            repair = prompts.repair_message(cast(Mapping[str, Any], draft.project), report)
            async with aclosing(self._pass(item, "repair", working, repair, draft_id=draft.id)) as events:
                async for event in events:
                    yield event
            if item.pass_end not in _DRAFT_ENDS:
                # The model made no valid change; another pass on the same findings would be the same.
                break
            async with self._storage() as service:
                draft = await service.store_project(owner, draft.id, working.project(), "checking")
            yield DraftUpdated(draft)

        # One frame review, when the clip can be drawn and the model can look at it. The sheets are asked for
        # and held by draft id and version, so two items of a batch reviewed at once never cross.
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
                    working = WorkingDraft.from_project(
                        cast(Mapping[str, Any], draft.project),
                        held=plan.held_details,
                        effects=self._effects_for(item.intent),
                    )
                    review = prompts.review_message(
                        cast(Mapping[str, Any], draft.project), len(sheets), names_not_on_review_sheets(report)
                    )
                    reviewing = self._pass(item, "review", working, review, draft_id=draft.id, sheets=sheets)
                    async with aclosing(reviewing) as events:
                        async for event in events:
                            yield event
                    edited = item.pass_end == "edited"
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

    # ------------------------------------------------------------------------ a batch

    async def _batch(self, planned: Sequence[Mapping[str, Any]]) -> AsyncGenerator[RunEvent, None]:
        """Work on every planned item: a draft each, ``MAX_BATCH_CONCURRENCY`` in flight, as one stream of events.

        Each item's draft is created first, in plan order, so the page can
        list the whole plan at once. Workers then take the items in order;
        each runs one item's steps to their end before taking the next, so
        the number of workers is the number of items in flight and of model
        requests open at once. Their events reach this generator through a
        queue. Stopping the run (closing or cancelling this generator)
        cancels the workers, which closes each item's pass and its model
        request, and waits until they have stopped; the run then settles
        every item's draft. After ``MAX_BATCH_SECONDS`` the batch ends the
        same way, as a failure of the run, and so it does on a model failure
        every item would meet (``fails_every_item``): that failure is raised
        here as the run's own, so the page gets ``run.failed`` with it.
        """

        plan = self._plan
        owner = plan.owner_user_id
        # ``plan_batch`` already refused a longer plan; the slice keeps the bound here whatever a caller passes.
        items = [
            _Item(intent=cast(Intent, entry["intent"]), number=number, brief=str(entry["brief"]))
            for number, entry in enumerate(planned[:MAX_BATCH_ITEMS], start=1)
        ]
        # The items are the run's from here, so a run stopped while their rows are made still settles those made.
        self._items = items
        drafts: list[GenerationDraft] = []
        async with self._storage() as service:
            for item in items:
                draft = await service.create_draft(owner, plan.conversation_id, item.intent)
                item.draft_id = item.planned_draft_id = draft.id
                drafts.append(draft)
        self._outcome = "draft"
        yield BatchPlanned(
            tuple(
                PlannedItem(draft_id=draft.id, intent=item.intent, brief=cast(str, item.brief))
                for item, draft in zip(items, drafts, strict=True)
            )
        )
        for draft in drafts:
            yield DraftUpdated(draft)

        events: asyncio.Queue[RunEvent | _BatchHalted | None] = asyncio.Queue()
        waiting = deque(items)

        async def work() -> None:
            try:
                while waiting:
                    await self._run_item(waiting.popleft(), len(items), events)
            except ModelClientError as error:
                # Every item's failure (``_run_item`` raises no other): the batch ends on it.
                events.put_nowait(_BatchHalted(error))
            finally:
                # Also when cancelled: the reader counts the workers that have ended.
                events.put_nowait(None)

        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, self._batch_seconds)
        workers = [asyncio.create_task(work()) for _ in range(min(MAX_BATCH_CONCURRENCY, len(items)))]
        working = len(workers)
        _log.info(
            "Generation batch started",
            run_id=self.run_id,
            item_count=len(items),
            reaction_count=sum(1 for item in items if item.intent == "reaction"),
        )
        try:
            while working:
                try:
                    event = await asyncio.wait_for(events.get(), max(0.0, deadline - loop.time()))
                except TimeoutError:
                    raise _RunFailure(BATCH_TIME_LIMIT, {}) from None
                if event is None:
                    working -= 1
                elif isinstance(event, _BatchHalted):
                    raise event.error
                else:
                    yield event
        finally:
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

    async def _run_item(self, item: _Item, total: int, events: asyncio.Queue[RunEvent | _BatchHalted | None]) -> None:
        """Run one item of a batch to its end; what fails in it alone is the item's failure, never the run's.

        A model error, a failure of the pipeline and a defect each leave the
        item ``ItemFailed`` and the run working on the others. An item whose
        draft the person discarded just ends. Two things leave this method
        by raising: cancellation, which is the run being stopped, and a
        model failure every item would meet (``fails_every_item``), which
        the batch ends on instead of spending a request an item to meet it
        again.
        """

        plan = self._plan
        try:
            async with aclosing(self._item_steps(item, total)) as steps:
                async for event in steps:
                    events.put_nowait(event)
        except GenerationNotFoundError:
            # The person discarded this item's draft while the run worked on it. (Had the conversation gone,
            # every other item ends the same way.)
            _log.info("Generation batch item ended: its draft is gone", run_id=self.run_id, draft_id=item.draft_id)
        except ModelClientError as error:
            if fails_every_item(error):
                _log.info(
                    "Generation batch ends on a failure every item would meet",
                    run_id=self.run_id,
                    draft_id=item.draft_id,
                    code=error.code,
                )
                raise
            details = json_safe_dict(model_error_details(error, plan.model_provider))
            category = model_error_category(error.code, error.raw_metadata)
            await self._item_failed(item, events, error.code or "model_client_error", category, details)
        except _RunFailure as error:
            await self._item_failed(item, events, error.code, "generation", dict(error.details))
        except Exception as error:
            _log.error(
                "Generation batch item failed unexpectedly",
                run_id=self.run_id,
                draft_id=item.draft_id,
                exc_type=type(error).__name__,
                site=failure_site(error),
            )
            await self._item_failed(item, events, RUN_FAILED, "internal", {})

    async def _item_steps(self, item: _Item, total: int) -> AsyncGenerator[RunEvent, None]:
        """One item of a batch: its own write pass from its brief, then the checks, repairs and review of its draft.

        An item never asks the person and never plans: both were the
        planning pass's to do. Its draft may have been discarded while it
        waited its turn, so the draft is looked for before anything is asked
        of the model, and again after each response of its passes
        (``_pass``); a discarded item ends there.
        """

        plan = self._plan
        await self._require_draft(item)
        yield Progress("thinking", item.draft_id)
        working = WorkingDraft(intent=item.intent, effects=self._effects_for(item.intent))
        message = prompts.item_message(
            plan.message,
            cast(str, item.brief),
            item.number,
            total,
            plan.recent_turns,
            plan.answers,
            item.intent,
            effects=working.effects is not None,
        )
        writing = self._pass(item, "write", working, message, draft_id=item.draft_id, can_ask=False)
        async with aclosing(writing) as events:
            async for event in events:
                yield event
        async with aclosing(self._finish(item, working, base=None, revised=None)) as events:
            async for event in events:
                yield event

    async def _item_failed(
        self,
        item: _Item,
        events: asyncio.Queue[RunEvent | _BatchHalted | None],
        code: str,
        category: str,
        details: Mapping[str, Any],
    ) -> None:
        """Leave a failed item's draft in a status that describes it, and tell the page.

        A draft that never got a project is left ``failed`` with the
        failure's code as its reason. One that has a project keeps it and is
        settled as a stopped run would settle it: from the report of its
        current version, or left for the page to check.
        """

        owner, draft_id = self._plan.owner_user_id, cast(str, item.draft_id)
        item.error = {"code": code, "category": category}
        _log.info("Generation batch item failed", run_id=self.run_id, draft_id=draft_id, code=code)
        left: GenerationDraft | None = None
        try:
            async with self._storage() as service:
                draft = await service.get_draft(owner, draft_id)
                if draft.project is None:
                    left = await service.set_status(owner, draft_id, "failed", code)
                else:
                    left = await service.settle_draft(owner, draft_id, RUN_STATUSES)
        except GenerationNotFoundError:
            left = None
        except Exception as error:
            # The run's own settling reads the draft again when it ends.
            _log.warning(
                "Generation batch item could not be settled",
                run_id=self.run_id,
                draft_id=draft_id,
                exc_type=type(error).__name__,
                site=failure_site(error),
            )
        events.put_nowait(ItemFailed(draft_id=draft_id, code=code, category=category, details=details))
        if left is not None:
            events.put_nowait(DraftUpdated(left))

    async def _require_draft(self, item: _Item) -> None:
        """Raise ``GenerationNotFoundError`` when a batch item's draft is gone: the person discarded it.

        The storage's read of plain columns, never the project. Version 0 is
        no version, so no report is read either.
        """

        async with self._storage() as service:
            await service.check_report_for(self._plan.owner_user_id, cast(str, item.draft_id), 0)

    def _selector_check(self, item: _Item) -> SelectorInUse | None:
        """Whether a Selector ID is taken, for one item: by a Gesture in the Library, or by another item of the batch.

        Two items of a batch must not be saved with one Selector ID. A
        sibling's id counts from the moment a tool call of its pass
        validated, which happens without awaiting, so two items can never
        both take one.
        """

        library = self._selector_in_use
        if not item.in_batch:
            return library

        def in_use(selector_id: str) -> bool:
            if library is not None and library(selector_id):
                return True
            return any(other is not item and other.selector_id == selector_id for other in self._items)

        return in_use

    # ------------------------------------------------------------------------ a pass

    async def _pass(
        self,
        item: _Item,
        kind: PassKind,
        working: WorkingDraft,
        message: str,
        *,
        draft_id: str | None,
        sheets: Sequence[ReviewSheet] = (),
        can_ask: bool | None = None,
        can_plan: bool = False,
    ) -> AsyncGenerator[RunEvent, None]:
        """Run one pass on ``working`` for ``item``; how it ended is left in the item's ``pass_end`` and ``pass_text``.

        ``can_ask`` defaults to whether the request may still be asked about.
        Text a model writes outside its tool calls is the run's reply as it
        streams; in a batch two items write at once, so an item's stray text
        is not forwarded and its note arrives whole, named after its draft.
        """

        plan = self._plan
        item.pass_end, item.pass_text, item.working = "round_limit", "", working
        authoring = kind in ("write", "revise")
        asking = plan.can_ask if can_ask is None else can_ask
        selector_in_use = self._selector_check(item)
        rounds = 0
        if self._author is not None:
            if authoring:
                yield Progress("writing", draft_id)
            offered = offered_tools(kind, can_ask=asking, can_plan=can_plan, effects=working.effects is not None)
            for call in self._author_calls(item, kind, working, can_plan=can_plan):
                run_tool(working, call, offered, selector_in_use=selector_in_use, example_reader=self._example_reader)
            item.pass_end = working.outcome or "round_limit"
        else:
            spec = PassSpec(
                kind=kind,
                model_provider=plan.model_provider,
                instructions=self._instructions_for(working.intent),
                message=message,
                prompt_cache_key=self._cache_key_for(working.intent),
                reasoning_effort=plan.reasoning_effort,
                stored_responses=self._stored_responses,
                sheets=tuple(sheets),
                can_ask=asking,
                can_plan=can_plan,
                effects=working.effects is not None,
                selector_in_use=selector_in_use,
                example_reader=self._example_reader,
            )
            announced = False
            async with aclosing(run_pass(cast(ModelClient, self._client), spec, working)) as items:
                async for part in items:
                    if isinstance(part, PassText):
                        if not item.in_batch:
                            yield MessageDelta(self._reply.add(part.text))
                    elif isinstance(part, PassWriting):
                        if authoring and not announced:
                            announced = True
                            yield Progress("writing", draft_id)
                    elif isinstance(part, PassRound):
                        # The totals keep every response's figures; only a provider's own report is priced.
                        self._usage = self._usage.plus(part.usage)
                        self._cost.add(part.usage, reported=part.usage_reported)
                        if item.in_batch:
                            # Before the response's tool call is answered with another request: an item the
                            # person discarded meanwhile stops here, with this response counted.
                            await self._require_draft(item)
                        else:
                            self._reply.end_piece()
                    elif isinstance(part, PassCursorLost):
                        self._stored_responses = False
                    else:
                        item.pass_end, item.pass_text, rounds = part.end, part.text, part.rounds
        _log.info(
            "Generation pass ended",
            run_id=self.run_id,
            draft_id=draft_id,
            pass_kind=kind,
            end=item.pass_end,
            rounds=rounds,
            sheet_count=len(sheets),
        )
        if working.outcome in ("submitted", "edited", "accepted", "planned") and working.note:
            # The model's own account of what it made or changed is the assistant's reply. A batch item's is
            # one whole piece that begins with the draft's name, added without awaiting, so two items' notes
            # never run into each other.
            note = working.note
            name = working.details.get("name")
            if item.in_batch and isinstance(name, str) and name.strip():
                note = f"{name.strip()}: {note}"
            yield MessageDelta(self._reply.add(note), item.draft_id if item.in_batch else None)
            self._reply.end_piece()

    def _author_calls(
        self, item: _Item, kind: PassKind, working: WorkingDraft, *, can_plan: bool
    ) -> list[ModelClientToolCall]:
        """The deterministic author's tool calls for one pass, in order; the last is the one that ends it."""

        author = cast(DeterministicAuthor, self._author)
        if kind == "write":
            planned = author.plan(self._plan.message) if can_plan else None
            if planned is not None:
                return [planned]
            request = item.brief if item.brief is not None else self._plan.message
            placing = working.effects if author.places_effect(self._plan.message) else None
            write = author.write(
                request, intent=item.intent, selector_in_use=self._selector_check(item), effects=placing
            )
            # The author lists before it places, as a model must.
            return [author.list_effects(), write] if placing is not None else [write]
        if kind == "review":
            return [author.review()]
        return [author.revise(working.project()) if kind == "revise" else author.repair(working.project())]

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
        # The kind asked for, so questions about a new Reaction are answered as one after a reload.
        data: dict[str, Any] = {"intent": plan.intent}
        if plan.draft is not None:
            data["draft_id"] = plan.draft.id
        if plan.answers is not None:
            data["answers"] = dict(plan.answers)
        return data

    async def _settle_item(self, item: _Item) -> GenerationDraft | None:
        """Leave one item's draft as the run ended; returns the draft when the page has not seen it so.

        A draft still in one of the run's own steps is settled by the
        storage's rule (``GenerationService.settle_draft``): deleted when it
        never got a project, described by the report of its current version,
        or back to ``checking`` for the page to check. A draft that is gone
        is left alone.

        Afterwards ``item.draft_id`` is set only when the run left the draft
        changed: a new draft that was kept or that the page was shown before
        the person discarded it, or a revised one whose version moved.
        Whether a revision was stored is read from the draft, so a run that
        failed or was stopped as it stored one says what is true either way.
        A batch item's draft that is gone (never written when the run was
        stopped, or discarded) is no longer named.
        """

        if item.draft_id is None:
            return None
        async with self._storage() as service:
            try:
                settled = await service.settle_draft(self._plan.owner_user_id, item.draft_id, RUN_STATUSES)
            except GenerationNotFoundError:
                settled = None
        revised = self._plan.draft
        if settled is None:
            # Gone. A single run's draft that the page was already shown keeps its name on the turn: the run
            # made it. A batch names the drafts it kept.
            if item.told_status is None or item.in_batch:
                item.draft_id = None
        elif revised is not None and settled.version == revised.version:
            item.draft_id = None
        elif settled.status != item.told_status:
            return settled
        return None

    async def _settle(self) -> list[GenerationDraft]:
        """Leave every draft and the conversation as the run ended; returns the drafts the page has not seen so.

        Each item's draft is settled (``_settle_item``). The assistant's
        message is stored once, with the outcome, the token use, the model
        the run named and, where that model has a price, the estimate of
        what the run cost (``usage.py``); a batch's use and cost are those
        of its planning pass and every item's passes together. A
        conversation that is gone is left alone.

        The message names a draft only when the run left one changed, the
        first such draft of a batch; ``plan_run`` reads the name as "this run
        used what the person sent". A batch's message also lists its plan
        (``batch``): every planned item's draft, kind and brief, and the
        failure of an item that failed.
        """

        owner = self._plan.owner_user_id
        changed: list[GenerationDraft] = []
        for item in self._items:
            left = await self._settle_item(item)
            if left is not None:
                changed.append(left)
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
            named = next((item.draft_id for item in self._items if item.draft_id is not None), None)
            if named is not None:
                data["draft_id"] = named
            batch = [
                {
                    "draft_id": item.planned_draft_id,
                    "intent": item.intent,
                    "brief": item.brief,
                    **({"error": dict(item.error)} if item.error is not None else {}),
                }
                for item in self._items
                if item.planned_draft_id is not None
            ]
            if batch:
                data["batch"] = batch
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
    "BATCH_TIME_LIMIT",
    "CHECK_WAIT_SECONDS",
    "EVERY_ITEM_FAILURES",
    "FRAMES_WAIT_SECONDS",
    "MAX_BATCH_CONCURRENCY",
    "MAX_BATCH_MODEL_RESPONSES",
    "MAX_BATCH_SECONDS",
    "MAX_PASSES_PER_DRAFT",
    "MAX_REPAIR_PASSES",
    "MIN_CONTEXT_WINDOW_TOKENS",
    "NO_VALID_DRAFT",
    "RUN_FAILED",
    "RUN_STATUSES",
    "BatchPlanned",
    "DraftUpdated",
    "FramesRequested",
    "GenerationDocumentInvalidError",
    "GenerationDraftEmptyError",
    "GenerationReasoningEffortUnsupportedError",
    "GenerationRun",
    "ItemFailed",
    "MessageDelta",
    "PlannedItem",
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
    "creator_document",
    "fails_every_item",
    "model_unusable_reason",
    "plan_run",
]
