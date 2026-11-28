"""Wire schemas of the content assistant's routes (local composition only, spec #942).

No schema carries an owner id: the caller is the owner. No request schema has
a field for instructions, tools or model output: the backend builds every
model request itself (threat T3). Request bodies refuse unknown fields.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StringConstraints, model_validator

from animama.app.generation.check_report import (
    MAX_REPORT_FINDINGS,
    MAX_REPORT_ISSUES,
    MAX_REPORT_NAME_LENGTH,
    MAX_REPORT_NAMES,
    MAX_REPORT_TEXT_LENGTH,
    FindingCategory,
    FindingSeverity,
)
from animama.app.generation.draft_validation import is_storable_text
from animama.app.generation.references import MAX_EXAMPLE_GESTURES, MAX_REFERENCE_IMAGES, ImageKind
from animama.app.generation.tools import MAX_QUESTION_LENGTH, MAX_QUESTIONS
from animama.app.generation.usage import ConversationUsage, CostEstimate, RunUsage, StoredRunUsage
from animama.domain.generation import (
    GenerationDraft,
    GenerationDraftStatus,
    GenerationIntent,
    GenerationMessageRole,
)

MAX_RUN_MESSAGE_LENGTH = 4000
MAX_ANSWER_LENGTH = 1000
# Far above what the page sends (it applies decision D19's caps itself); the prompt builder applies those caps
# again and drops what does not fit. These only keep a request's size sane.
MAX_EXPRESSION_FAMILIES = 16
MAX_EXPRESSION_FAMILY_NAMES = 2000
MAX_EXPRESSION_TEXT_LENGTH = 256
MAX_REASONING_EFFORT_LENGTH = 32


def _storable(value: str) -> str:
    """Refuse text PostgreSQL cannot store (a NUL or an unpaired surrogate) instead of failing on the write."""

    if not is_storable_text(value):
        raise ValueError("text holds a character that cannot be stored")
    return value


def _not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("text must not be blank")
    return value


_Storable = AfterValidator(_storable)
_ReportText = Annotated[str, StringConstraints(max_length=MAX_REPORT_TEXT_LENGTH), _Storable]
_ReportName = Annotated[str, StringConstraints(min_length=1, max_length=MAX_REPORT_NAME_LENGTH), _Storable]
_Id = Annotated[str, StringConstraints(min_length=1, max_length=255), _Storable]
_ExpressionText = Annotated[str, StringConstraints(max_length=MAX_EXPRESSION_TEXT_LENGTH)]


class _Request(BaseModel):
    """A request body: unknown fields are refused, and no number may be NaN or infinite."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


# --- Conversations --------------------------------------------------------------------


class PyGenerationPageScope(BaseModel):
    """A conversation started on the Generate page."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["page"]


class PyGenerationCreatorScope(BaseModel):
    """A conversation started in a creator, about the item open in it (``null`` for an unsaved one)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["creator"]
    intent: GenerationIntent
    catalog_item_id: _Id | None = None


PyGenerationScope = Annotated[PyGenerationPageScope | PyGenerationCreatorScope, Field(discriminator="kind")]


class PyGenerationConversationCreate(_Request):
    """Where the new conversation is started."""

    scope: PyGenerationScope


class PyGenerationStylePreset(_Request):
    """The style preset chosen for a conversation: one of the backend's preset ids, or ``null`` for none.

    Only the id is taken. The sentence a preset adds to the assistant's
    instructions is the backend's own.
    """

    style_preset: Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")] | None


class PyGenerationConversation(BaseModel):
    id: str
    title: str
    scope: PyGenerationScope
    style_preset: str | None = None
    created_at: datetime
    updated_at: datetime


class PyGenerationConversationList(BaseModel):
    """The caller's conversations, the most recently written to first."""

    conversations: list[PyGenerationConversation]


class PyGenerationMessage(BaseModel):
    """One text turn. ``data`` holds what it carried besides text.

    The person's turn: ``draft_id`` (the draft it revises) and ``answers``.
    The assistant's turn: ``run_id``, ``outcome`` (``draft``, ``questions``,
    ``reply``, ``failed`` or ``stopped``), ``usage``, ``model`` (the row the
    run named, and its reasoning effort when it named one), and where they
    apply ``cost`` (the run's estimate), ``draft_id``, ``questions`` and
    ``error`` (``code`` and ``category``).
    """

    id: str
    role: GenerationMessageRole
    text: str
    data: dict[str, Any]
    created_at: datetime


class PyGenerationDraft(BaseModel):
    """A draft as stored: its project, the page's report on ``checked_version``, and where it stands.

    ``project`` is an ``animamaActionProject/1.0`` document the creator's
    Import accepts, or ``null`` for a draft that failed before it had one.
    ``has_previous_version`` says whether a restore has something to return
    to; the earlier project itself stays on the server.
    """

    id: str
    conversation_id: str
    intent: GenerationIntent
    position: int
    status: GenerationDraftStatus
    version: int
    project: dict[str, Any] | None
    has_previous_version: bool
    check_report: dict[str, Any] | None
    checked_version: int | None
    repair_count: int
    failure_reason: str | None
    saved_item_id: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_domain(cls, draft: GenerationDraft) -> PyGenerationDraft:
        return cls(
            id=draft.id,
            conversation_id=draft.conversation_id,
            intent=draft.intent,
            position=draft.position,
            status=draft.status,
            version=draft.version,
            project=draft.project,
            has_previous_version=draft.previous_project is not None,
            check_report=draft.check_report,
            checked_version=draft.checked_version,
            repair_count=draft.repair_count,
            failure_reason=draft.failure_reason,
            saved_item_id=draft.saved_item_id,
            created_at=draft.created_at,
            updated_at=draft.updated_at,
        )


class PyGenerationTokenUse(BaseModel):
    """Tokens that model responses reported, added up; ``requests`` counts the responses."""

    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    requests: int

    @staticmethod
    def counts(usage: RunUsage) -> dict[str, int]:
        return {
            "input_tokens": usage.input_tokens,
            "cached_input_tokens": usage.cached_input_tokens,
            "output_tokens": usage.output_tokens,
            "reasoning_tokens": usage.reasoning_tokens,
            "requests": usage.requests,
        }


class PyGenerationCostEstimate(BaseModel):
    """An estimated cost from the model's listed prices when the run happened; not a bill.

    ``amount`` is a decimal string in ``currency`` (an ISO 4217 code).
    """

    currency: str
    amount: str

    @classmethod
    def from_domain(cls, cost: CostEstimate | None) -> PyGenerationCostEstimate | None:
        return cls(**cost.stored()) if cost is not None else None


class PyGenerationRunUsage(PyGenerationTokenUse):
    """One stored run's token use. ``plan`` is true for a run on the ChatGPT plan, which never has a ``cost``."""

    run_id: str | None
    model_provider_id: str | None
    plan: bool
    cost: PyGenerationCostEstimate | None

    @classmethod
    def from_domain(cls, run: StoredRunUsage) -> PyGenerationRunUsage:
        return cls(
            **cls.counts(run.usage),
            run_id=run.run_id,
            model_provider_id=run.model_provider_id,
            plan=run.plan,
            cost=PyGenerationCostEstimate.from_domain(run.cost),
        )


class PyGenerationConversationUsage(PyGenerationTokenUse):
    """A conversation's token use over its ``runs`` stored runs, and its last run's.

    ``cost`` adds the runs that have an estimate (``null`` when none has, or
    when they are in more than one currency). ``cost_complete`` is false when
    a run that made a model request has no estimate, so the amount covers
    only part of the conversation.
    """

    runs: int
    cost: PyGenerationCostEstimate | None
    cost_complete: bool
    last_run: PyGenerationRunUsage | None

    @classmethod
    def from_domain(cls, usage: ConversationUsage) -> PyGenerationConversationUsage:
        return cls(
            **cls.counts(usage.usage),
            runs=usage.runs,
            cost=PyGenerationCostEstimate.from_domain(usage.cost),
            cost_complete=usage.cost_complete,
            last_run=PyGenerationRunUsage.from_domain(usage.last_run) if usage.last_run is not None else None,
        )


class PyGenerationConversationSnapshot(BaseModel):
    """A conversation with its messages in the order added, its drafts by position and its token use."""

    conversation: PyGenerationConversation
    messages: list[PyGenerationMessage]
    drafts: list[PyGenerationDraft]
    usage: PyGenerationConversationUsage


# --- A run ----------------------------------------------------------------------------


class PyGenerationAnswer(_Request):
    question: Annotated[str, StringConstraints(min_length=1, max_length=MAX_QUESTION_LENGTH), _Storable]
    answer: Annotated[str, StringConstraints(min_length=1, max_length=MAX_ANSWER_LENGTH), _Storable]


class PyGenerationAnswers(_Request):
    """What the person said to the questions the assistant last asked: their answers, or that they skipped them."""

    skipped: StrictBool = False
    answers: list[PyGenerationAnswer] = Field(default_factory=list, max_length=MAX_QUESTIONS)


class PyGenerationReferenceImage(_Request):
    """One of the person's own images given with a request, by the id its upload got (``/v1/files``).

    ``kind`` says what the image is: a picture, or ``video_frames`` for one
    strip of frames the page sampled from a short local video, in time order
    from left to right. The video itself is never uploaded.
    """

    file_id: _Id
    kind: ImageKind = "image"


class PyGenerationReferences(_Request):
    """What a request carries besides its words. Every part is the person's own content, named by id.

    ``starting_point`` is a Gesture in the caller's Library whose clip the
    new draft starts as; only a request for a new Gesture on the Generate
    page takes one. ``examples`` are Library Gestures shown to the model as
    examples of the feel. ``images`` are the caller's own uploaded images.
    The backend reads each itself and refuses what may not be read: no clip,
    text or image bytes are taken from this body.
    """

    starting_point: _Id | None = None
    examples: list[_Id] = Field(default_factory=list, max_length=MAX_EXAMPLE_GESTURES)
    images: list[PyGenerationReferenceImage] = Field(default_factory=list, max_length=MAX_REFERENCE_IMAGES)


class PyGenerationRunRequest(_Request):
    """One request to the assistant.

    ``message`` is the person's own words. With ``answers``, it is the request
    the questions were about, sent again. ``draft_id`` names the draft to
    revise; without it the run writes a new draft of ``intent``. A creator's
    conversation authors its item's kind whatever ``intent`` says, and may
    send ``document``: the item open in the creator as an
    ``animamaActionProject/1.0`` project, which the run then revises (into
    ``draft_id``'s draft, or a new one). Its clip is validated as a model's
    is before any pass reads it.
    ``avatar_expressions`` maps a family (as the page groups them) to the
    names of the chosen preview Avatar's expressions: names only, which reach
    the model as data. ``reasoning_effort`` is one of the model row's listed
    levels, applied to every model request of the run; without it the model's
    default applies. ``references`` name the Library Gestures and the
    person's own images given with the request.
    """

    message: Annotated[
        str, StringConstraints(min_length=1, max_length=MAX_RUN_MESSAGE_LENGTH), _Storable, AfterValidator(_not_blank)
    ]
    model_provider_id: _Id
    draft_id: _Id | None = None
    intent: GenerationIntent = "gesture"
    ui_locale: Annotated[str, StringConstraints(max_length=35)] | None = None
    answers: PyGenerationAnswers | None = None
    avatar_expressions: (
        Annotated[
            dict[_ExpressionText, Annotated[list[_ExpressionText], Field(max_length=MAX_EXPRESSION_FAMILY_NAMES)]],
            Field(max_length=MAX_EXPRESSION_FAMILIES),
        ]
        | None
    ) = None
    reasoning_effort: (
        Annotated[str, StringConstraints(min_length=1, max_length=MAX_REASONING_EFFORT_LENGTH), _Storable] | None
    ) = None
    document: dict[str, Any] | None = None
    references: PyGenerationReferences | None = None


# --- What the page reports ------------------------------------------------------------


class PyGenerationCheckIssue(_Request):
    """One validation problem of the clip, by JSON path."""

    path: _ReportText
    message: _ReportText


class PyGenerationCheckFinding(_Request):
    """One motion check finding, as ``MotionCheckFinding`` in the frontend's ``checks.ts``."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, populate_by_name=True)

    category: FindingCategory
    severity: FindingSeverity
    avatar: _ReportText | None = None
    subject: _ReportText
    from_: float = Field(alias="from")
    to: float
    value: float
    limit: float
    unit: _ReportText
    detail: _ReportText
    actualOffset: tuple[float, float, float] | None = None  # noqa: N815 (the page's own field name)


class PyGenerationCheckExpressionNames(_Request):
    """Keyed expression names that will not show everywhere (decision D20)."""

    missing: list[_ReportName] = Field(default_factory=list, max_length=MAX_REPORT_NAMES)
    avatar_only: list[_ReportName] = Field(default_factory=list, max_length=MAX_REPORT_NAMES)

    @model_validator(mode="after")
    def _within_the_total(self) -> PyGenerationCheckExpressionNames:
        if len(self.missing) + len(self.avatar_only) > MAX_REPORT_NAMES:
            raise ValueError(f"a report lists at most {MAX_REPORT_NAMES} expression names")
        return self


class PyGenerationCheckReport(_Request):
    """The page's checks of one draft version.

    ``loadable`` false means the clip cannot be played. ``issues`` are the
    page's validation problems; ``findings`` its motion check findings on the
    Included Avatars; ``expression_names`` the keyed names the chosen Avatar
    lacks (``missing``) or only such Avatars have (``avatar_only``).
    """

    version: int = Field(ge=1)
    loadable: StrictBool
    issues: list[PyGenerationCheckIssue] = Field(default_factory=list, max_length=MAX_REPORT_ISSUES)
    findings: list[PyGenerationCheckFinding] = Field(default_factory=list, max_length=MAX_REPORT_FINDINGS)
    expression_names: PyGenerationCheckExpressionNames = Field(default_factory=PyGenerationCheckExpressionNames)

    def stored(self) -> dict[str, Any]:
        """The report as it is kept on the draft: everything but the version, which the draft records itself.

        A finding keeps ``actualOffset`` only when the page sent one, as the
        page's own type has it.
        """

        report = self.model_dump(mode="json", by_alias=True, exclude={"version"})
        for finding in report["findings"]:
            if finding["actualOffset"] is None:
                del finding["actualOffset"]
        return report


class PyGenerationMarkSaved(_Request):
    """The Library item the person saved the draft as."""

    item_id: _Id


__all__ = [
    "MAX_RUN_MESSAGE_LENGTH",
    "PyGenerationAnswer",
    "PyGenerationAnswers",
    "PyGenerationCheckExpressionNames",
    "PyGenerationCheckFinding",
    "PyGenerationCheckIssue",
    "PyGenerationCheckReport",
    "PyGenerationConversation",
    "PyGenerationConversationCreate",
    "PyGenerationConversationList",
    "PyGenerationConversationSnapshot",
    "PyGenerationConversationUsage",
    "PyGenerationCostEstimate",
    "PyGenerationCreatorScope",
    "PyGenerationDraft",
    "PyGenerationMarkSaved",
    "PyGenerationMessage",
    "PyGenerationPageScope",
    "PyGenerationReferenceImage",
    "PyGenerationReferences",
    "PyGenerationRunRequest",
    "PyGenerationRunUsage",
    "PyGenerationScope",
    "PyGenerationStylePreset",
    "PyGenerationTokenUse",
]
