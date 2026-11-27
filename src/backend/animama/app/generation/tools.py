"""The function tools a pass offers a model, and what each call does to the pass's working draft.

A pass (``write``, ``revise``, ``repair`` or ``review``) gives the model a
fixed set of tools. Each takes typed arguments and never a path, a URL or a
command (threat T2), and each call is a model's output: ``run_tool`` parses
it, bounds it and validates the draft it would leave before anything changes
(T1), and never raises. A call that validates ends the pass; any other is a
refused call whose result lists the problems, for another round.

The working draft is in memory only. The run pipeline stores it once a pass
has ended.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal, cast

from animama.app.model_clients import ModelClientToolCall
from animama.domain.anima_loadout import REACTION_INTENSITIES
from animama.domain.emotions import TRACKED_EMOTIONS
from animama.logging import failure_site, get_logger

from .clip_edits import JsonObject, apply_operations
from .draft_validation import (
    DETAIL_FIELDS,
    MAX_CLIP_BYTES,
    Intent,
    SelectorInUse,
    bounded_problems,
    build_project,
    clip_and_details,
    draft_problems,
    is_storable_text,
)

_log = get_logger("app.generation.tools")

PassKind = Literal["write", "revise", "repair", "review"]
Outcome = Literal["submitted", "edited", "accepted", "asked"]
"""How a tool call ended a pass."""
ExampleReader = Callable[[str], Mapping[str, Any] | None]
"""Returns the clip of one Included Gesture named in ``EXAMPLE_NAMES``, or ``None`` when it cannot."""

EXAMPLE_NAMES: Final = ("wave-hello", "mild-laugh", "have-an-idea")
"""The portable Included Gestures ``read_example`` may return; the shared guidance names them."""

MAX_TOOL_ROUNDS: Final = 8
"""Model responses in one pass. The pass runner enforces it and the instructions tell the model."""

PASS_TOOLS: Final[Mapping[PassKind, tuple[str, ...]]] = {
    "write": ("submit_draft", "read_example", "ask_questions"),
    "revise": ("edit_draft", "submit_draft", "read_example", "ask_questions"),
    "repair": ("edit_draft", "submit_draft"),
    "review": ("accept_draft", "edit_draft"),
}

MAX_QUESTIONS: Final = 4
MIN_OPTIONS: Final = 2
MAX_OPTIONS: Final = 4
MAX_QUESTION_LENGTH: Final = 300
MAX_OPTION_LENGTH: Final = 120
MAX_NOTE_LENGTH: Final = 1000
# A whole clip at its size limit, with room for JSON escapes, details and a note.
MAX_ARGUMENTS_LENGTH: Final = 2 * MAX_CLIP_BYTES
MAX_QUOTED_TOOL_NAME: Final = 64

_EVENTS_FIELD: Final = "events"
"""The clip field ``read_example`` leaves out: timeline events, which no draft may hold yet."""

TOOL_FAILED: Final = "the tool could not process these arguments"
"""The one problem of a call that failed unexpectedly. Fixed, because an exception's wording could quote the model."""


# --- Definitions ------------------------------------------------------------------


def _function_tool(name: str, description: str, properties: JsonObject, required: Sequence[str]) -> JsonObject:
    """One OpenAI-style function tool. ``strict`` is off because a clip and an edit value are free-form JSON."""

    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "strict": False,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": list(required),
                "additionalProperties": False,
            },
        },
    }


def _note(description: str) -> JsonObject:
    return {"type": "string", "description": description}


_DETAIL_PROPERTIES: Final[Mapping[str, JsonObject]] = {
    "name": {"type": "string", "description": 'The display name, for example "Shy Wave".'},
    "ai_description": {
        "type": "string",
        "description": (
            'When chat should play this Gesture ("Use when …"), then what it shows in a few words: about 120 '
            "characters in all."
        ),
    },
    "selector_id": {
        "type": "string",
        "description": "The snake_case id chat selects the Gesture by, for example shy_wave.",
    },
    "emotion": {
        "type": "string",
        "enum": list(TRACKED_EMOTIONS),
        "description": "The tracked emotion this Reaction shows.",
    },
    "intensity": {
        "type": "integer",
        "enum": list(REACTION_INTENSITIES),
        "description": "How strong the emotion is, from 1 (mildest) to 4 (strongest).",
    },
}

_OPERATIONS: Final[JsonObject] = {
    "type": "array",
    "minItems": 1,
    "description": "Changes to the clip, applied in order. Leave it out to change details only.",
    "items": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["set", "remove"]},
            "path": {
                "type": "string",
                "description": "A JSON Pointer (RFC 6901) into the clip, for example "
                "/joints/rightUpperArm/elevation/1/v. A last token of - appends to an array.",
            },
            "value": {"description": 'The JSON value to store; required for "set".'},
        },
        "required": ["op", "path"],
        "additionalProperties": False,
    },
}

_QUESTIONS: Final[JsonObject] = {
    "type": "array",
    "minItems": 1,
    "maxItems": MAX_QUESTIONS,
    "items": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "One short question."},
            "options": {
                "type": "array",
                "minItems": MIN_OPTIONS,
                "maxItems": MAX_OPTIONS,
                "items": {"type": "string"},
                "description": "Concrete answers to choose from, your recommendation first.",
            },
        },
        "required": ["question", "options"],
        "additionalProperties": False,
    },
}


def _definitions(intent: Intent) -> dict[str, JsonObject]:
    details = {name: _DETAIL_PROPERTIES[name] for name in DETAIL_FIELDS[intent]}
    return {
        "submit_draft": _function_tool(
            "submit_draft",
            "Submit the whole clip with its details. The draft is validated: a valid submission ends the task, and "
            "an invalid one changes nothing and returns the problems to fix.",
            {
                "clip": {"type": "object", "description": "The whole animaPoseClip/2.0 clip."},
                **details,
                "note": _note("What you made and anything you are unsure of, in one or two sentences."),
            },
            ("clip", *details, "note"),
        ),
        "edit_draft": _function_tool(
            "edit_draft",
            "Change the current draft, then validate it: `operations` change its clip in order, and a detail given "
            "here replaces that detail. A valid result ends the task; otherwise the draft is left as it was and the "
            "problems are returned. To insert into the middle of an array, set the whole array. A parent object must "
            "exist before a value is set inside it.",
            {
                "operations": _OPERATIONS,
                **details,
                "note": _note("What you changed and why, in one or two sentences."),
            },
            ("note",),
        ),
        "accept_draft": _function_tool(
            "accept_draft",
            "Accept the current draft unchanged. This ends the task.",
            {"note": _note("What you saw in the frames, in one or two sentences.")},
            ("note",),
        ),
        "read_example": _function_tool(
            "read_example",
            "Read the clip of one Included Gesture as a worked example.",
            {"name": {"type": "string", "enum": list(EXAMPLE_NAMES)}},
            ("name",),
        ),
        "ask_questions": _function_tool(
            "ask_questions",
            "Ask the person up to four questions before writing, about choices that would change the clip. This ends "
            "the task; their answers arrive with the next one. Ask at most once.",
            {"questions": _QUESTIONS},
            ("questions",),
        ),
    }


_TOOL_DEFINITIONS: Final[Mapping[Intent, Mapping[str, JsonObject]]] = {
    "gesture": _definitions("gesture"),
    "reaction": _definitions("reaction"),
}


def offered_tools(kind: PassKind, *, can_ask: bool = True) -> tuple[str, ...]:
    """The names of the tools a pass offers, in order.

    ``can_ask`` is false once the person has answered or skipped the
    questions about their request, which are asked at most once.
    """

    return tuple(name for name in PASS_TOOLS[kind] if can_ask or name != "ask_questions")


def tool_definition(name: str, intent: Intent) -> JsonObject:
    """One tool's definition for a Gesture or a Reaction draft; ``KeyError`` for a name that is not a tool."""

    return copy.deepcopy(_TOOL_DEFINITIONS[intent][name])


def tool_definitions(kind: PassKind, intent: Intent, *, can_ask: bool = True) -> tuple[JsonObject, ...]:
    """The definitions a pass sends with its request, matching ``offered_tools``."""

    return tuple(tool_definition(name, intent) for name in offered_tools(kind, can_ask=can_ask))


# --- The working draft and a call's result ------------------------------------------


@dataclass
class WorkingDraft:
    """What a pass has so far: the clip and details it works on, and how a tool call ended it.

    A write pass starts empty; the other passes start ``from_project``. Only a
    call that validated changes ``clip`` and ``details``, so they are always
    either empty or a valid draft.
    """

    intent: Intent
    clip: JsonObject | None = None
    details: JsonObject = field(default_factory=dict)
    note: str = ""
    """The model's own account of its last accepted call, for the person."""
    questions: list[JsonObject] = field(default_factory=list)
    """Set by ``ask_questions``: each ``{"question": ..., "options": [...]}``."""
    outcome: Outcome | None = None
    """Set by the call that ends the pass."""

    @classmethod
    def from_project(cls, project: Mapping[str, Any]) -> WorkingDraft:
        """The working draft of a pass that starts from a stored project."""

        clip, details = clip_and_details(project)
        return cls(intent="reaction" if project.get("intent") == "reaction" else "gesture", clip=clip, details=details)

    def project(self) -> JsonObject:
        """The project to store. Raises ``ValueError`` while the draft holds no clip."""

        if self.clip is None:
            raise ValueError("The working draft holds no clip")
        return build_project(self.intent, self.clip, self.details)


@dataclass(frozen=True)
class ToolReply:
    """A tool result: the text the model reads, and the problems it lists (empty when the call worked)."""

    output: str
    problems: list[str] = field(default_factory=list)


def refused(problems: Sequence[str]) -> ToolReply:
    """A reply to a call that changed nothing, listing a bounded number of bounded problems."""

    bounded = bounded_problems(problems)
    lines = "\n".join(f"- {problem}" for problem in bounded)
    return ToolReply(
        output=f"Nothing was changed. Problems:\n{lines}\nFix them and call the tool again.", problems=bounded
    )


def ignored_call_reply() -> ToolReply:
    """The reply to every tool call after the first in one response: only one call a response is run."""

    return refused(["only one tool call per response is run; call the tool again"])


# --- Handlers ---------------------------------------------------------------------


@dataclass(frozen=True)
class _Context:
    """What a call may ask of its caller besides the working draft."""

    selector_in_use: SelectorInUse | None
    example_reader: ExampleReader | None


def _note_text(arguments: Mapping[str, Any]) -> str:
    """The call's note, cut to its limit. A note is never a reason to refuse a call."""

    note = arguments.get("note")
    return note.strip()[:MAX_NOTE_LENGTH] if isinstance(note, str) and is_storable_text(note) else ""


def _given_details(intent: Intent, arguments: Mapping[str, Any]) -> JsonObject:
    """The details a call gives, with text trimmed. A detail left out or null is not given."""

    given: JsonObject = {}
    for name in DETAIL_FIELDS[intent]:
        value = arguments.get(name)
        if value is not None:
            given[name] = value.strip() if isinstance(value, str) else value
    return given


def _submit_draft(draft: WorkingDraft, arguments: Mapping[str, Any], context: _Context) -> ToolReply:
    clip = arguments.get("clip")
    # A rewrite of an existing draft keeps the details it does not give again.
    details = {**draft.details, **_given_details(draft.intent, arguments)}
    problems = draft_problems(draft.intent, clip, details, selector_in_use=context.selector_in_use)
    if problems:
        return refused(problems)
    # A clip without problems is a JSON object.
    draft.clip, draft.details = cast(JsonObject, clip), details
    draft.note, draft.outcome = _note_text(arguments), "submitted"
    return ToolReply("The draft is valid. The task is complete.")


def _edit_draft(draft: WorkingDraft, arguments: Mapping[str, Any], context: _Context) -> ToolReply:
    if draft.clip is None:
        return refused(["there is no draft to edit; use submit_draft"])
    given = _given_details(draft.intent, arguments)
    operations = arguments.get("operations")
    if operations is None and not given:
        return refused(["edit_draft needs operations or a detail to change"])
    clip = draft.clip
    if operations is not None:
        clip, problems = apply_operations(clip, operations)
        if problems:
            return refused(problems)
    details = {**draft.details, **given}
    problems = draft_problems(draft.intent, clip, details, selector_in_use=context.selector_in_use)
    if problems:
        return refused(problems)
    draft.clip, draft.details, draft.note, draft.outcome = clip, details, _note_text(arguments), "edited"
    return ToolReply("The edit was applied and the draft is valid. The task is complete.")


def _accept_draft(draft: WorkingDraft, arguments: Mapping[str, Any], context: _Context) -> ToolReply:
    if draft.clip is None:
        return refused(["there is no draft to accept"])
    draft.note, draft.outcome = _note_text(arguments), "accepted"
    return ToolReply("The draft was accepted. The task is complete.")


def _read_example(draft: WorkingDraft, arguments: Mapping[str, Any], context: _Context) -> ToolReply:
    """Return one allowlisted Included Gesture's clip, without its timeline events.

    The name is a key into a fixed list, never a path.
    """

    name = arguments.get("name")
    if not isinstance(name, str) or name not in EXAMPLE_NAMES:
        return refused([f"name must be one of: {', '.join(EXAMPLE_NAMES)}"])
    unreadable = refused([f"the example {name} could not be read"])
    if context.example_reader is None:
        return unreadable
    try:
        clip = context.example_reader(name)
    except Exception as exc:
        _log.warning(
            "Generation example could not be read",
            example=name,
            exc_type=exc.__class__.__name__,
            site=failure_site(exc),
        )
        return unreadable
    if not isinstance(clip, Mapping):
        return unreadable
    # An Included Gesture may play effects or sounds, and a draft may not until its project can carry their
    # dependencies (see ``draft_validation``). The model is not shown a field it would be refused for copying.
    shown = {key: value for key, value in clip.items() if key != _EVENTS_FIELD}
    return ToolReply(json.dumps(shown, ensure_ascii=False, separators=(",", ":")))


def _short_text(value: object, where: str, maximum: int, problems: list[str]) -> str:
    """``value`` trimmed. Adds to ``problems`` when it is not a short text the person can be shown."""

    if not isinstance(value, str) or not value.strip() or not is_storable_text(value):
        problems.append(f"{where} must be a non-empty string")
        return ""
    text = value.strip()
    if len(text) > maximum:
        problems.append(f"{where} must be at most {maximum} characters")
    return text


def _ask_questions(draft: WorkingDraft, arguments: Mapping[str, Any], context: _Context) -> ToolReply:
    questions = arguments.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_QUESTIONS:
        return refused(["questions must be an array of one to four questions"])
    problems: list[str] = []
    asked: list[JsonObject] = []
    for index, entry in enumerate(questions):
        where = f"questions[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{where} must be an object with a question and its options")
            continue
        question = _short_text(entry.get("question"), f"{where}.question", MAX_QUESTION_LENGTH, problems)
        options = entry.get("options")
        if not isinstance(options, list) or not MIN_OPTIONS <= len(options) <= MAX_OPTIONS:
            problems.append(f"{where}.options must be an array of two to four options")
            continue
        asked.append(
            {
                "question": question,
                "options": [
                    _short_text(option, f"{where}.options[{number}]", MAX_OPTION_LENGTH, problems)
                    for number, option in enumerate(options)
                ],
            }
        )
    if problems:
        return refused(problems)
    draft.questions, draft.outcome = asked, "asked"
    return ToolReply("The questions were sent to the person. The task is complete.")


_HANDLERS: Final[Mapping[str, Callable[[WorkingDraft, Mapping[str, Any], _Context], ToolReply]]] = {
    "submit_draft": _submit_draft,
    "edit_draft": _edit_draft,
    "accept_draft": _accept_draft,
    "read_example": _read_example,
    "ask_questions": _ask_questions,
}


def run_tool(
    working_draft: WorkingDraft,
    call: ModelClientToolCall,
    offered: Sequence[str],
    *,
    selector_in_use: SelectorInUse | None = None,
    example_reader: ExampleReader | None = None,
) -> ToolReply:
    """Run one tool call of a pass on its working draft and return the result for the model.

    ``offered`` is what ``offered_tools`` gave the pass. A tool the pass does
    not offer, arguments that are oversized, malformed or not an object, a
    draft that does not validate and any unexpected failure are all a refused
    call that changes nothing: this never raises. The pass has ended when
    ``working_draft.outcome`` is set afterwards.

    ``selector_in_use`` answers whether another Gesture of the owner uses a
    Selector ID; without it no id clashes. ``example_reader`` supplies the
    allowlisted example clips, so this module reads no file.
    """

    try:
        return _run_tool(working_draft, call, offered, _Context(selector_in_use, example_reader))
    except Exception as exc:
        # A defect met on odd arguments costs a round, never the run. The log names the failure's type, and the
        # tool when it is a real one; never the failure's own wording, which could quote the model.
        _log.warning(
            "Generation tool call failed unexpectedly",
            tool=call.name if call.name in _HANDLERS else None,
            exc_type=exc.__class__.__name__,
            site=failure_site(exc),
        )
        return refused([TOOL_FAILED])


def _run_tool(draft: WorkingDraft, call: ModelClientToolCall, offered: Sequence[str], context: _Context) -> ToolReply:
    usable = [name for name in offered if name in _HANDLERS]
    if call.name not in usable:
        # The name is the model's text: quoted in part.
        return refused([f"this task has no tool named {call.name[:MAX_QUOTED_TOOL_NAME]}; use {' or '.join(usable)}"])
    if len(call.arguments) > MAX_ARGUMENTS_LENGTH:
        return refused(["the tool arguments are too large"])
    try:
        # A call without arguments is an empty object.
        arguments = json.loads(call.arguments) if call.arguments.strip() else {}
    except (ValueError, RecursionError):
        return refused(["the tool arguments are not valid JSON"])
    if not isinstance(arguments, dict):
        return refused(["the tool arguments must be a JSON object"])
    return _HANDLERS[call.name](draft, arguments, context)


__all__ = [
    "EXAMPLE_NAMES",
    "MAX_ARGUMENTS_LENGTH",
    "MAX_NOTE_LENGTH",
    "MAX_OPTIONS",
    "MAX_OPTION_LENGTH",
    "MAX_QUESTIONS",
    "MAX_QUESTION_LENGTH",
    "MAX_TOOL_ROUNDS",
    "MIN_OPTIONS",
    "PASS_TOOLS",
    "TOOL_FAILED",
    "ExampleReader",
    "Outcome",
    "PassKind",
    "ToolReply",
    "WorkingDraft",
    "ignored_call_reply",
    "offered_tools",
    "refused",
    "run_tool",
    "tool_definition",
    "tool_definitions",
]
