#!/usr/bin/env python3
"""Probe whether a ChatGPT plan model can write and repair a Gesture clip through function tools.

Developer tooling for in-app generation (docs/plans/in-app-generation, Phase 0
step 2). One invocation runs one authoring pass as that plan describes it: a
fresh request holding the authoring guidance and a small fixed tool set, with
at most three tool rounds. It prints token use, time and validation problems,
and saves the clip so `pnpm -s animation check` can judge it.

Run it inside a signed-in development stack's server container, from the
repository root (mounted at /app):

    python scripts/generation_probe.py list
    python scripts/generation_probe.py write --model SLUG --out DIR --request 1
    python scripts/generation_probe.py write --model SLUG --out DIR \
        --request "a slow nod" --expressions FILE --effort low
    python scripts/generation_probe.py repair --model SLUG --out DIR \
        --clip FILE --findings FILE --mode rewrite|edit
    python scripts/generation_probe.py review --model SLUG --out DIR \
        --clip FILE --sheet PNG --sheet PNG

The guidance is the packaged Gesture authoring guidance
(animama.resources.authoring_guidance), which ends with the joint table. --out
must be a folder under .animama-drafts/ or outside the repository, so a clip
cannot be committed by accident. --effort names a reasoning effort; without it
the model uses its own. A pass exits 0 only when the model submitted, edited
or accepted a draft.

The probe holds no token code. It composes the installation's ChatGPT plan
session and model client as the server does and sends its requests through
them, so sign in in the app first. It is a second process over the same
session file, and the server keeps its own copy of the session in memory: if
the probe has to renew the token, that copy goes stale, so restart the server
after a probe session or sign in again when chat asks for it.

Every request to the plan's route counts against the plan and against a budget
of at most 15 requests across all invocations, kept in one file
(.animama-drafts/generation-probe-budget.json unless --budget-file names
another). A request is counted before it is sent and is sent once: the model
client is told not to retry, and the one resend it makes after a refused token
is counted as a request of its own. Once the budget is used up the probe sends
nothing; --max-requests can only lower the bound.

The terminal gets tool names, counts, times and validation problems. A problem
can quote a short name the model wrote, such as a joint or a path; it is
bounded in length and printed JSON-escaped. Clips, prompts and whole tool
arguments are written only under --out.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol, cast

from animama.adapters.chatgpt_plan.openai_identity import OpenAIChatGPTPlanIdentity
from animama.adapters.chatgpt_plan.session_store import FileChatGPTPlanSessionStore
from animama.adapters.model_clients.openai_responses.chatgpt_plan_client import ChatGPTPlanResponsesModelClient
from animama.app.generation.clip_edits import apply_operations
from animama.app.generation.draft_validation import DETAIL_FIELDS as PRODUCT_DETAIL_FIELDS, clip_problems
from animama.app.generation.expression_names import filter_expression_names as bounded_expression_names
from animama.app.generation.prompts import expression_names_block
from animama.app.generation.tools import (
    EXAMPLE_NAMES,
    TOOL_FAILED,
    ToolReply,
    ignored_call_reply,
    refused,
    tool_definition,
)
from animama.app.model_clients import (
    DirectChatPrompt,
    ModelClient,
    ModelClientError,
    ModelClientFinal,
    ModelClientRequest,
    ModelClientToolCall,
)
from animama.app.model_clients.error_categories import model_error_category
from animama.app.model_clients.image_parts import ModelClientImage, image_part
from animama.app.model_clients.limits import ModelCallLimits
from animama.app.model_clients.prompt import (
    ChatCompletionReasoningEffort,
    copy_direct_chat_prompt,
    prompt_messages,
)
from animama.app.model_clients.tool_rounds import (
    assistant_tool_call_prompt_message,
    continuation_after_tool_round,
    tool_result_prompt_message,
)
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanTokenSource, PlanModelListing
from animama.app.services.chatgpt_plan_models import plan_model_row
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.domain import ModelProvider
from animama.domain.chatgpt_plan import ChatGPTPlanPurpose, ChatGPTPlanStatus, ChatGPTPlanUnavailableError
from animama.resources.authoring_guidance import gesture_authoring_guidance
from animama.server.config import settings
from animama.server.local_runtime import resolve_local_runtime_paths

JsonObject = dict[str, Any]

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_DIR = REPO_ROOT / "content/included/gestures"
# Probe output may sit here inside the repository: the folder is ignored by Git.
DRAFTS_DIR = REPO_ROOT / ".animama-drafts"
# One count for every out directory, so the bound holds across the whole trial.
DEFAULT_BUDGET_FILE = DRAFTS_DIR / "generation-probe-budget.json"

BUILT_IN_REQUESTS = {
    "1": "a shy little wave with a small smile",
    "2": "thinking with a hand on the chin, held while the Anima thinks",
    "3": "a hearty laugh",
}

MAX_ROUNDS = 3
# The trial's bound on plan requests (the plan's gate G1); --max-requests can only lower it.
MAX_REQUESTS = 15
DEFAULT_TIMEOUT_SECONDS = 600.0
# ModelCallLimits needs an output figure. The plan's route takes no output limit, so this one is never sent.
UNSENT_MAX_OUTPUT_TOKENS = 128_000
EFFORTS = ("low", "medium", "high")
MAX_SHEETS = 4
# The listing's own figure for the plan's models; a probe row needs one to be built.
CONTEXT_WINDOW_TOKENS = 272_000
# A fixed key, so OpenAI can serve the guidance, which every pass repeats, from its prompt cache.
PROMPT_CACHE_KEY = "animama-generation-probe"

DETAIL_FIELDS = PRODUCT_DETAIL_FIELDS["gesture"]
SUCCESS_OUTCOMES = frozenset({"submitted", "edited", "accepted"})
PASS_TOOLS: Mapping[str, tuple[str, ...]] = {
    "write": ("submit_draft", "read_example"),
    "repair-rewrite": ("submit_draft",),
    "repair-edit": ("edit_draft",),
    "review": ("accept_draft", "edit_draft"),
}

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_FILE_STEM = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")

ROLE_STATEMENT = """\
You author Gestures for Animama, an AI Avatar companion app. A Gesture is a short body-and-face motion for a 3D VRM \
Avatar, written as one `animaPoseClip/2.0` JSON clip. You have no persona and you are not chatting: do the authoring \
task in the user message and nothing else.

Rules:
- Work only through the function tools you are given, one tool call per response. Do not answer in prose, and never \
put a clip in message text.
- Never invent a joint, component, hand preset, bone, ease or expression name. Use only names from the guidance \
below, from the joint list at its end, or from a list of expression names the task supplies.
- Keep every value within the limits the guidance and the joint list give.
- When a tool result lists problems, fix exactly those and call the tool again. A pass has at most three responses.

The guidance below is written for any author. You cannot ask the owner anything in this task: where it says to ask \
or to confirm, decide yourself."""


class ProbeError(Exception):
    """A failure whose message is safe to print."""


# --- The session and the model client, composed as the server composes them ---


class PlanSession(ChatGPTPlanTokenSource, Protocol):
    """What the probe needs from the installation's session: its state, and tokens for the model client."""

    async def status(self) -> ChatGPTPlanStatus: ...


SessionFactory = Callable[[], AbstractAsyncContextManager[PlanSession]]
ClientFactory = Callable[[ChatGPTPlanTokenSource, float], ModelClient]


@contextlib.asynccontextmanager
async def plan_session() -> AsyncIterator[PlanSession]:
    """The installation's ChatGPT plan session, built as the server builds it for a self-hosted stack.

    Mirrors ``animama.server.chatgpt_plan.chatgpt_plan_session_for`` without a
    desktop vault key, which a development stack does not have.
    """

    data_internal_root = resolve_local_runtime_paths(settings).data_internal_root
    identity = OpenAIChatGPTPlanIdentity()
    try:
        yield ChatGPTPlanSessionService(
            identity=identity,
            store=FileChatGPTPlanSessionStore(data_internal_root / "chatgpt-plan", key=None),
        )
    finally:
        await identity.aclose()


def plan_client(session: ChatGPTPlanTokenSource, timeout: float) -> ModelClient:
    """The plan's model client as ``animama.server.model_clients`` registers it; it asks for interactive tokens."""

    return ChatGPTPlanResponsesModelClient(session=lambda: session, timeout=timeout)


async def require_signed_in(session: PlanSession) -> None:
    """Stop before any request when the installation has no usable plan session."""

    try:
        status = await session.status()
    except ChatGPTPlanUnavailableError as error:
        raise ProbeError("The ChatGPT plan session could not be read. Try again.") from error
    if status.state != "signed_in":
        raise ProbeError("The ChatGPT plan is not signed in. Sign in in the app (Settings → Models) first.")
    if not status.plan_use_granted:
        raise ProbeError(
            "The ChatGPT account is signed in without plan use. Sign in again in the app (Settings → Models) "
            "and allow it."
        )


def model_row(slug: str, effort: str | None = None) -> ModelProvider:
    """A plan model row for ``slug``, as a listing of it would produce, offering ``effort`` when one is named."""

    return plan_model_row(
        PlanModelListing(
            slug=slug,
            display_name=slug,
            listed=True,
            context_window=CONTEXT_WINDOW_TOKENS,
            input_modalities=("text", "image"),
            reasoning_efforts=(effort,) if effort else (),
            supports_search=False,
        )
    )


# --- The tools the model is offered -------------------------------------------


# The product's own definitions for a Gesture draft, so the probe sends what the app sends. The probe keeps its
# own dispatcher: it records details as given, and it ignores a detail given to `edit_draft`.
TOOL_DEFINITIONS: Mapping[str, JsonObject] = {
    name: tool_definition(name, "gesture") for name in ("submit_draft", "edit_draft", "accept_draft", "read_example")
}


@dataclass
class Draft:
    """What a pass has so far: the current clip, its details, the model's note and how the pass ended."""

    clip: JsonObject | None = None
    details: dict[str, str] = field(default_factory=dict)
    note: str = ""
    outcome: str | None = None
    """Set by the tool call that ends the pass: ``submitted``, ``edited`` or ``accepted``."""


def _text(arguments: Mapping[str, Any], key: str) -> str:
    value = arguments.get(key)
    return value.strip() if isinstance(value, str) else ""


def _submit_draft(draft: Draft, arguments: Mapping[str, Any]) -> ToolReply:
    clip = arguments.get("clip")
    problems = clip_problems(clip)
    if problems:
        return refused(problems)
    draft.clip = cast(JsonObject, clip)
    # Details are recorded as given: the trial reads them, and a missing one is reported, not sent back.
    draft.details = {key: _text(arguments, key) for key in DETAIL_FIELDS if _text(arguments, key)}
    draft.note = _text(arguments, "note")
    draft.outcome = "submitted"
    return ToolReply("The draft is valid and was stored.")


def _edit_draft(draft: Draft, arguments: Mapping[str, Any]) -> ToolReply:
    if draft.clip is None:
        return refused(["there is no clip to edit"])
    edited, problems = apply_operations(draft.clip, arguments.get("operations"))
    problems = problems or clip_problems(edited)
    if problems:
        return refused(problems)
    draft.clip = edited
    draft.note = _text(arguments, "note")
    draft.outcome = "edited"
    return ToolReply("The edit was applied and the clip is valid.")


def _accept_draft(draft: Draft, arguments: Mapping[str, Any]) -> ToolReply:
    draft.note = _text(arguments, "note")
    draft.outcome = "accepted"
    return ToolReply("The draft was accepted.")


def _read_example(draft: Draft, arguments: Mapping[str, Any]) -> ToolReply:
    """Return one allowlisted Included Gesture clip; the name never reaches the filesystem otherwise."""

    name = arguments.get("name")
    if name not in EXAMPLE_NAMES:
        return refused([f"name must be one of: {', '.join(EXAMPLE_NAMES)}"])
    try:
        clip = json.loads((EXAMPLES_DIR / name / f"{name}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return refused([f"the example {name} could not be read"])
    return ToolReply(json.dumps(clip, ensure_ascii=False, separators=(",", ":")))


_TOOL_HANDLERS: Mapping[str, Callable[[Draft, Mapping[str, Any]], ToolReply]] = {
    "submit_draft": _submit_draft,
    "edit_draft": _edit_draft,
    "accept_draft": _accept_draft,
    "read_example": _read_example,
}


def run_tool(offered: Sequence[str], draft: Draft, call: ModelClientToolCall) -> ToolReply:
    """Run one tool call of a pass. A tool the pass does not offer, or malformed arguments, is refused."""

    if call.name not in offered:
        return refused([f"this task has no tool named {call.name[:64]}; use {' or '.join(offered)}"])
    try:
        arguments = json.loads(call.arguments)
    except (ValueError, RecursionError):
        return refused(["the tool arguments are not valid JSON"])
    if not isinstance(arguments, dict):
        return refused(["the tool arguments must be a JSON object"])
    return _TOOL_HANDLERS[call.name](draft, arguments)


# --- The request budget --------------------------------------------------------


class BudgetExhausted(Exception):
    """Sending one more request would pass the maximum."""


@dataclass
class RequestBudget:
    """Requests sent to the plan's route so far, across invocations, kept in a small JSON file."""

    path: Path
    maximum: int
    used: int = 0
    refused: bool = False
    """True once a request was held back because the maximum was reached."""

    @classmethod
    def load(cls, path: Path, maximum: int) -> RequestBudget:
        """Read the count. An unreadable file is an error: starting again from zero would lift the bound."""

        if not path.exists():
            return cls(path=path, maximum=maximum)
        try:
            used = json.loads(path.read_text(encoding="utf-8"))["requests"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ProbeError(f"The budget file {path} could not be read as a request count.") from error
        if isinstance(used, bool) or not isinstance(used, int) or used < 0:
            raise ProbeError(f"The budget file {path} does not hold a request count.")
        return cls(path=path, maximum=maximum, used=used)

    def spend(self) -> None:
        """Count one request before it is sent, so a request that fails or is interrupted still counts.

        A count that cannot be written stops the probe: an unrecorded request would lift the bound.
        """

        if self.used + 1 > self.maximum:
            self.refused = True
            raise BudgetExhausted
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"requests": self.used + 1}) + "\n", encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as error:
            raise ProbeError(f"The budget file {self.path} could not be written, so nothing was sent.") from error
        self.used += 1


class CountedSession:
    """The session as the model client sees it, with the client's resend after a refused token counted.

    The client calls ``refresh_rejected`` only when OpenAI refused the token of
    a request it then sends again. That second request is counted here, before
    the token is renewed; with no request left the renewal is refused, which
    the client reports instead of sending. Everything else passes through.
    """

    def __init__(self, session: ChatGPTPlanTokenSource, budget: RequestBudget) -> None:
        self._session = session
        self._budget = budget

    async def access_token(self, purpose: ChatGPTPlanPurpose) -> str:
        return await self._session.access_token(purpose)

    async def refresh_rejected(self, stale_access_token: str, purpose: ChatGPTPlanPurpose) -> str:
        try:
            self._budget.spend()
        except BudgetExhausted:
            raise ChatGPTPlanUnavailableError("request_budget_exhausted") from None
        return await self._session.refresh_rejected(stale_access_token, purpose)

    async def record_usage_limit(self) -> None:
        await self._session.record_usage_limit()

    async def record_interactive_success(self) -> None:
        await self._session.record_interactive_success()


# --- Inputs --------------------------------------------------------------------


def prepare_out_dir(path: Path) -> Path:
    """Create the output directory, refusing one where a clip could be committed by accident.

    Inside this repository only a folder under the ignored ``.animama-drafts``
    is accepted; outside the repository any folder is. The rule reads no Git
    state, so it is the same on the host and in the server container.
    """

    out = path.resolve()
    if out.is_relative_to(REPO_ROOT) and DRAFTS_DIR not in out.parents:
        raise ProbeError(
            f"--out {path} is inside the repository. Use a folder under .animama-drafts/ or outside the repository."
        )
    try:
        out.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ProbeError(f"--out {path} could not be created.") from error
    return out


def _read_text(path: Path, label: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ProbeError(f"The {label} {path} could not be read as text.") from error


def _read_json_object(path: Path, label: str) -> JsonObject:
    try:
        value = json.loads(_read_text(path, label))
    except (ValueError, RecursionError) as error:
        raise ProbeError(f"The {label} {path} is not valid JSON.") from error
    if not isinstance(value, dict):
        raise ProbeError(f"The {label} {path} must hold a JSON object.")
    return value


def filter_expression_names(raw: object) -> tuple[dict[str, list[str]], int]:
    """Keep the Avatar expression names that may reach the model, by family, and count the ones dropped.

    Names come from an Avatar file, which can name a morph target anything, so
    they are treated as data. The rules are the product's
    (``animama.app.generation.expression_names``): over-long names and names
    with non-printing characters are dropped, and at most 400 are kept in all.
    """

    if not isinstance(raw, dict) or not all(isinstance(names, list) for names in raw.values()):
        raise ProbeError("The expressions file must hold an object of family name to a list of names.")
    return bounded_expression_names(raw)


def png_size(content: bytes) -> tuple[int, int]:
    """The pixel width and height in a PNG's header; anything else is refused."""

    if len(content) < 24 or content[:8] != _PNG_SIGNATURE or content[12:16] != b"IHDR":
        raise ValueError("not a PNG image")
    return int.from_bytes(content[16:20], "big"), int.from_bytes(content[20:24], "big")


def _read_sheets(paths: Sequence[Path]) -> tuple[list[JsonObject], dict[str, ModelClientImage]]:
    """Load contact sheets as image parts for a user message and the bytes those parts name."""

    if len(paths) > MAX_SHEETS:
        raise ProbeError(f"At most {MAX_SHEETS} sheets can be sent.")
    parts: list[JsonObject] = []
    images: dict[str, ModelClientImage] = {}
    for number, path in enumerate(paths, start=1):
        try:
            content = path.read_bytes()
            width, height = png_size(content)
        except (OSError, ValueError) as error:
            raise ProbeError(f"The sheet {path} could not be read as a PNG image.") from error
        file_id = f"sheet-{number}"
        parts.append(image_part(file_id=file_id, name=path.name, width=width, height=height))
        images[file_id] = ModelClientImage(media_type="image/png", content=content)
    return parts, images


# --- Prompts -------------------------------------------------------------------


def system_message() -> str:
    """The role statement, then the packaged Gesture guidance in full; its last file is the joint table."""

    return f"{ROLE_STATEMENT}\n\n{gesture_authoring_guidance().strip()}"


def _clip_text(clip: JsonObject) -> str:
    return json.dumps(clip, ensure_ascii=False, separators=(",", ":"))


def expressions_block(names: Mapping[str, list[str]]) -> str:
    """The Avatar's expression names as the product's data block, then the one rule for choosing among them."""

    return (
        f"{expression_names_block(names)}\n"
        "Build the mood from VRM presets and VRoid parts, then add the Avatar's other named shapes where they "
        "express what those cannot."
    )


def write_message(request: str, expression_names: Mapping[str, list[str]] | None) -> str:
    parts = [f"Author one Gesture for this request:\n\n{request}"]
    if expression_names:
        parts.append(expressions_block(expression_names))
    parts.append(
        "Submit the whole clip with `submit_draft`, with its `name`, `ai_description`, `selector_id` and `note`. "
        f"You may first read one Included Gesture with `read_example` ({', '.join(EXAMPLE_NAMES)}); each call uses "
        "one of your three responses."
    )
    return "\n\n".join(parts)


def repair_message(clip: JsonObject, findings: str, mode: str) -> str:
    how = (
        "Submit the whole corrected clip with `submit_draft`, keeping its name, with `ai_description`, "
        "`selector_id` and a `note` that says what you changed."
        if mode == "rewrite"
        else "Make the correction with one `edit_draft` call that holds every operation needed, and a `note` that "
        "says what you changed. Each `path` is a JSON Pointer into the clip below; array indexes count from 0."
    )
    return (
        "The Gesture clip below was checked on both Included Avatars, and the findings follow it. Fix every FAIL "
        "finding. Fix a WARN finding only where that does not change what the Gesture shows. Change nothing else.\n\n"
        f"{how}\n\nClip:\n{_clip_text(clip)}\n\nFindings:\n{findings.strip()}"
    )


def review_message(clip: JsonObject, sheet_count: int) -> str:
    return (
        f"The {sheet_count} image(s) above are contact sheets of the Gesture clip below, one per Included Avatar. "
        "Each row is one beat of the clip, in time order, and shows four views of that moment. Look for what reads "
        "wrong: a hand or arm inside the body or head, a joint bent the wrong way, a pose that does not show what "
        "the Gesture is meant to, or a face that does not fit. If the Gesture reads well, call `accept_draft`. "
        "Otherwise make one correction with a single `edit_draft` call; each `path` is a JSON Pointer into the clip, "
        "and array indexes count from 0. Either way, say in `note` what you saw.\n\n"
        f"Clip:\n{_clip_text(clip)}"
    )


@dataclass(frozen=True)
class PassPlan:
    """One pass, ready to send: its tools, its user message, the draft it starts from and its inputs."""

    kind: str
    """Names the tool set, and the output files when the model gives no usable Selector ID."""
    content: str | list[JsonObject]
    draft: Draft
    images: Mapping[str, ModelClientImage] = field(default_factory=dict)
    inputs: JsonObject = field(default_factory=dict)
    """What the details file and the report record about the pass's inputs; never prompt text for the terminal."""


def plan_pass(args: argparse.Namespace) -> PassPlan:
    """Read a subcommand's input files and build its user message."""

    if args.command == "write":
        request = BUILT_IN_REQUESTS.get(args.request, args.request)
        names: dict[str, list[str]] | None = None
        inputs: JsonObject = {"request": request}
        if args.expressions is not None:
            names, dropped = filter_expression_names(_read_json_object(args.expressions, "expressions file"))
            sent = sum(len(family) for family in names.values())
            inputs["expression_names"] = {"sent": sent, "dropped": dropped}
        return PassPlan(kind="write", content=write_message(request, names), draft=Draft(), inputs=inputs)
    clip = _read_json_object(args.clip, "clip file")
    inputs = {"source_clip": str(args.clip)}
    if args.command == "repair":
        findings = _read_text(args.findings, "findings file")
        return PassPlan(
            kind=f"repair-{args.mode}",
            content=repair_message(clip, findings, args.mode),
            draft=Draft(clip=clip),
            inputs={**inputs, "mode": args.mode},
        )
    parts, images = _read_sheets(args.sheet)
    return PassPlan(
        kind="review",
        content=[*parts, {"type": "text", "text": review_message(clip, len(parts))}],
        draft=Draft(clip=clip),
        images=images,
        inputs={**inputs, "sheets": len(parts)},
    )


def first_request(model: str, system: str, plan: PassPlan, *, effort: str | None, timeout: float) -> ModelClientRequest:
    """The pass's fresh request: guidance as the system message, the task as the one user message.

    Images are named by parts in the user message, the only place adapters read
    them. The request carries limits because a bounded request is never retried
    inside the client or the SDK, which keeps one counted request to one sent;
    the plan's route takes no output limit, so only the timeout has an effect.
    """

    tools = tuple(TOOL_DEFINITIONS[name] for name in PASS_TOOLS[plan.kind])
    return ModelClientRequest(
        model_provider=model_row(model, effort),
        prompt=DirectChatPrompt(
            messages=({"role": "system", "content": system}, {"role": "user", "content": plan.content}),
            tools=cast(Any, tools),
            tool_choice="auto",
            parallel_tool_calls=False,
            prompt_cache_key=PROMPT_CACHE_KEY,
            reasoning_effort=cast(ChatCompletionReasoningEffort | None, effort),
        ),
        limits=ModelCallLimits(max_output_tokens=UNSENT_MAX_OUTPUT_TOKENS, timeout_seconds=timeout),
        images=plan.images,
    )


# --- Running a pass ------------------------------------------------------------


@dataclass
class RoundRecord:
    """One model response of a pass. ``arguments``, ``result`` and ``text`` go to the details file only."""

    seconds: float
    tokens: dict[str, int]
    usage_reported: bool
    text: str
    tool: str | None = None
    arguments: str | None = None
    result: str | None = None
    problems: list[str] = field(default_factory=list)


@dataclass
class PassResult:
    """How a pass went: its rounds, how it ended, and the model error that stopped it, if one did."""

    rounds: list[RoundRecord] = field(default_factory=list)
    outcome: str = "round_limit"
    error: JsonObject | None = None
    # The model client's own account of the failure, which it has already cleared of tokens. Saved, never printed.
    error_detail: JsonObject | None = None


async def final_of(client: ModelClient, request: ModelClientRequest) -> ModelClientFinal:
    """Send one request and return its final result, reading the stream to its end."""

    final: ModelClientFinal | None = None
    async for delta in client.stream(request):
        if delta.kind == "final" and delta.final is not None:
            final = delta.final
        elif delta.kind == "error":
            raise ModelClientError(
                "The model stream failed", code="model_client_error", raw_metadata=delta.raw_metadata
            )
    if final is None:
        raise ModelClientError("The model stream ended without a final result", code="model_client_error")
    return final


def next_round_request(
    request: ModelClientRequest, final: ModelClientFinal, results: Sequence[tuple[ModelClientToolCall, str]]
) -> ModelClientRequest:
    """The request for the next tool round: the same prompt plus this round's calls and their results.

    Built as the chat turn's tool loop builds it for this provider type: one
    assistant message holding the calls, one tool message per result, and the
    provider's own continuation state. The images stay, because the plan's
    route takes the whole input again on every request.
    """

    calls = tuple(call for call, _ in results)
    exchange = [
        assistant_tool_call_prompt_message(calls),
        *(tool_result_prompt_message(call, output) for call, output in results),
    ]
    prompt = request.prompt
    return replace(
        request,
        prompt=copy_direct_chat_prompt(prompt, messages=(*prompt_messages(prompt), *exchange)),
        continuation=continuation_after_tool_round(request, final),
    )


def _tokens(final: ModelClientFinal) -> dict[str, int]:
    usage = final.usage
    return {
        "input": usage.input_tokens,
        "cached_input": usage.input_tokens_details.cached_tokens,
        "output": usage.output_tokens,
        "reasoning": usage.output_tokens_details.reasoning_tokens,
    }


async def run_rounds(
    client: ModelClient, request: ModelClientRequest, offered: Sequence[str], draft: Draft, budget: RequestBudget
) -> PassResult:
    """Run a pass: at most three rounds, each answered by one tool call, until a call ends it.

    A round is one request, counted against the budget before it is sent. The
    request's limits stop the client retrying it; the one resend the client
    still makes, after a refused token, is counted by ``CountedSession``. Only
    the first tool call of a response is run; any other is answered with a
    refusal so the exchange stays complete.
    """

    result = PassResult()
    for _ in range(MAX_ROUNDS):
        try:
            budget.spend()
        except BudgetExhausted:
            result.outcome = "budget_exhausted"
            return result
        started = time.monotonic()
        try:
            final = await final_of(client, request)
        except ModelClientError as error:
            if budget.refused:
                # The client would have sent again after a refused token, and no request was left for it.
                result.outcome = "budget_exhausted"
                return result
            result.outcome = "model_error"
            result.error = {
                "code": error.code or "unknown",
                "category": model_error_category(error.code, error.raw_metadata),
                "seconds": round(time.monotonic() - started, 2),
            }
            result.error_detail = {"message": str(error), "metadata": dict(error.raw_metadata or {})}
            return result
        record = RoundRecord(
            seconds=round(time.monotonic() - started, 2),
            tokens=_tokens(final),
            usage_reported=final.usage_reported,
            text=final.text,
        )
        result.rounds.append(record)
        if not final.tool_calls:
            result.outcome = "no_tool_call"
            return result
        call, *others = final.tool_calls
        try:
            reply = run_tool(offered, draft, call)
        except Exception:
            # The request is already counted, so a defect met on odd arguments must not lose the round.
            # The text is fixed: an exception's own wording could quote the model.
            reply = refused([TOOL_FAILED])
        record.tool, record.arguments, record.result, record.problems = (
            call.name,
            call.arguments,
            reply.output,
            reply.problems,
        )
        if draft.outcome is not None:
            result.outcome = draft.outcome
            return result
        ignored = ignored_call_reply().output
        request = next_round_request(request, final, [(call, reply.output), *((other, ignored) for other in others)])
    return result


# --- Output --------------------------------------------------------------------


def _free_stem(out: Path, stem: str) -> str:
    """``stem``, or ``stem-2``, ``stem-3`` and so on when an earlier pass saved under it, so nothing is overwritten."""

    candidate, number = stem, 1
    while any((out / f"{candidate}.{suffix}").exists() for suffix in ("clip.json", "details.json")):
        number += 1
        candidate = f"{stem}-{number}"
    return candidate


def _write_json(path: Path, value: object) -> int:
    """Write pretty JSON and return its size in bytes."""

    data = (json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n").encode("utf-8")
    path.write_bytes(data)
    return len(data)


def save_and_report(
    args: argparse.Namespace, out: Path, plan: PassPlan, result: PassResult, budget: RequestBudget
) -> JsonObject:
    """Save the pass's files under ``out`` and return the report for the terminal.

    The clip is saved only when the pass ended well. The details file is saved
    whenever a response arrived or a request failed, and holds the raw tool
    calls and the failure's wording, so a failed pass's output and the reason
    a request was refused are not lost with its plan request.
    """

    draft = plan.draft
    report: JsonObject = {
        "subcommand": args.command,
        "model": args.model,
        "effort": args.effort,
        **{key: value for key, value in plan.inputs.items() if key in {"mode", "sheets", "expression_names"}},
        "outcome": result.outcome,
        "rounds": len(result.rounds),
        "per_round": [
            {
                "tool": record.tool,
                "seconds": record.seconds,
                "tokens": record.tokens,
                "usage_reported": record.usage_reported,
                "problems": record.problems,
            }
            for record in result.rounds
        ],
    }
    if result.error is not None:
        report["error"] = result.error
    if result.outcome == "submitted":
        report["details_missing"] = [key for key in DETAIL_FIELDS if key not in draft.details]
    clip_path = details_path = None
    if result.rounds or result.error is not None:
        selector = draft.details.get("selector_id", "")
        # A Selector ID is the model's text, so it names a file only when it is a plain lower-case id.
        stem = _free_stem(out, selector if _FILE_STEM.fullmatch(selector) else plan.kind)
        details_path = out / f"{stem}.details.json"
        if result.outcome in SUCCESS_OUTCOMES and draft.clip is not None:
            clip_path = out / f"{stem}.clip.json"
            report["clip_bytes"] = _write_json(clip_path, draft.clip)
            report["clip_valid"] = not clip_problems(draft.clip)
    report["saved"] = {
        "clip": str(clip_path) if clip_path else None,
        "details": str(details_path) if details_path else None,
    }
    report["requests_used"] = budget.used
    report["max_requests"] = budget.maximum
    if details_path is not None:
        _write_json(
            details_path,
            {
                **plan.inputs,
                "details": draft.details,
                "note": draft.note,
                "report": report,
                "error_detail": result.error_detail,
                "rounds": [
                    {"tool": record.tool, "arguments": record.arguments, "result": record.result, "text": record.text}
                    for record in result.rounds
                ],
            },
        )
    return report


# --- Command line --------------------------------------------------------------


async def run_pass(args: argparse.Namespace, session_factory: SessionFactory, client_factory: ClientFactory) -> int:
    """Run one subcommand's pass and print its report. Returns 0 only when the pass ended with a usable draft."""

    out = prepare_out_dir(args.out)
    budget = RequestBudget.load(args.budget_file, args.max_requests)
    plan = plan_pass(args)
    request = first_request(args.model, system_message(), plan, effort=args.effort, timeout=args.timeout)
    if budget.used >= budget.maximum:
        # Nothing can be sent, so the session is not even opened.
        result = PassResult(outcome="budget_exhausted")
    else:
        async with session_factory() as session:
            await require_signed_in(session)
            client = client_factory(CountedSession(session, budget), args.timeout)
            try:
                result = await run_rounds(client, request, PASS_TOOLS[plan.kind], plan.draft, budget)
            finally:
                await client.aclose()
    print(json.dumps(save_and_report(args, out, plan, result, budget), separators=(",", ":")))
    if result.outcome == "budget_exhausted":
        print(
            f"error: the request budget is used up ({budget.used} of {budget.maximum}); nothing more was sent.",
            file=sys.stderr,
        )
    elif result.error is not None:
        print(f"error: the model request failed: {result.error['code']} ({result.error['category']}).", file=sys.stderr)
    return 0 if result.outcome in SUCCESS_OUTCOMES else 1


def print_list() -> None:
    """Name the built-in requests and each pass's tools. Sends nothing."""

    print("Built-in requests (write --request N):")
    for number, text in BUILT_IN_REQUESTS.items():
        print(f"  {number}  {text}")
    print("Tools by pass:")
    for kind, tools in PASS_TOOLS.items():
        print(f"  {kind:<15} {', '.join(tools)}")
    print(f"Examples read_example returns: {', '.join(EXAMPLE_NAMES)}")


def _request_bound(text: str) -> int:
    """``--max-requests``: a whole number that cannot raise the trial's bound."""

    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a whole number") from None
    if not 0 <= value <= MAX_REQUESTS:
        raise argparse.ArgumentTypeError(f"must be between 0 and {MAX_REQUESTS}")
    return value


def _timeout_seconds(text: str) -> float:
    """``--timeout``: a positive, finite number of seconds, as the request's limits require."""

    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number of seconds") from None
    if not 0 < value < float("inf"):
        raise argparse.ArgumentTypeError("must be a positive number of seconds")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="name the built-in requests and the tools; sends nothing")

    def model_pass(name: str, summary: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=summary)
        sub.add_argument("--model", required=True, metavar="SLUG", help="ChatGPT plan model slug")
        sub.add_argument("--out", type=Path, required=True, metavar="DIR", help="folder for clips and details")
        sub.add_argument("--effort", choices=EFFORTS, help="reasoning effort (default: the model's own)")
        sub.add_argument(
            "--budget-file",
            type=Path,
            default=DEFAULT_BUDGET_FILE,
            metavar="FILE",
            help="request count, shared by every out folder (default: .animama-drafts/generation-probe-budget.json)",
        )
        sub.add_argument(
            "--max-requests",
            type=_request_bound,
            default=MAX_REQUESTS,
            metavar="N",
            help=f"stop at this many requests in all (at most {MAX_REQUESTS}, the default)",
        )
        sub.add_argument("--timeout", type=_timeout_seconds, default=DEFAULT_TIMEOUT_SECONDS, metavar="SECONDS")
        return sub

    write = model_pass("write", "one write pass for a request")
    write.add_argument("--request", required=True, help="1, 2 or 3 for a built-in request, or your own text")
    write.add_argument("--expressions", type=Path, metavar="FILE", help="JSON object: family name to expression names")
    repair = model_pass("repair", "one repair pass from check findings")
    repair.add_argument("--clip", type=Path, required=True, metavar="FILE")
    repair.add_argument("--findings", type=Path, required=True, metavar="FILE", help="`pnpm -s animation check` output")
    repair.add_argument("--mode", choices=("rewrite", "edit"), required=True)
    review = model_pass("review", "one frame-review pass over contact sheets")
    review.add_argument("--clip", type=Path, required=True, metavar="FILE")
    review.add_argument("--sheet", type=Path, action="append", required=True, metavar="PNG")
    return parser


def run(
    argv: Sequence[str] | None = None,
    *,
    session_factory: SessionFactory = plan_session,
    client_factory: ClientFactory = plan_client,
) -> int:
    """Run the probe. The factories are the test seam; by default they are the app's own composition."""

    args = build_parser().parse_args(argv)
    if args.command == "list":
        print_list()
        return 0
    try:
        return asyncio.run(run_pass(args, session_factory, client_factory))
    except ProbeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def main() -> int:
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
