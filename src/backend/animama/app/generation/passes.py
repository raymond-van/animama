"""One pass of a run: a fresh model request, and tool rounds until a call ends it.

A pass (``write``, ``revise``, ``repair`` or ``review``) starts with a new
request built only from what this backend holds (decision D2): the instructions
as the system message, one user message, and the pass's fixed tools. Nothing of
an earlier pass or conversation rides along, so no pass depends on what a
provider stored for another. A response answers with at most one tool call
that is run; its result goes back in the provider's own shape for another
round, up to ``MAX_TOOL_ROUNDS`` responses. Within a pass, rounds after the
first continue as chat's tool rounds do: on a route that keeps a cursor
(OpenAI Responses on a key) the next request names the response it follows,
and on the others it carries the exchange again. Where the provider no longer
has that response (an organisation that stores none, or one that expired), the
round is sent again in full without the cursor, as chat does, and the rest of
the pass goes without one. The pass says so (``PassCursorLost``), and the run
tells its later passes (``PassSpec.stored_responses``), so a run spends at
most one refused request. Every other model error is raised as the model
clients raise it.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from typing import Any, Final, Literal, cast

from animama.app.model_clients import (
    DirectChatPrompt,
    ModelClient,
    ModelClientDelta,
    ModelClientError,
    ModelClientFinal,
    ModelClientRequest,
    ModelClientToolCall,
    ModelClientToolResult,
)
from animama.app.model_clients.image_parts import ModelClientImage, image_part
from animama.app.model_clients.tool_rounds import (
    model_request_with_appended_messages,
    model_request_without_continuation,
    should_retry_without_previous_response_id,
    tool_exchange_prompt_items,
)
from animama.domain import ModelProvider
from animama.domain.usage import Usage
from animama.logging import get_logger

from . import prompts
from .draft_validation import Intent, SelectorInUse
from .references import MAX_REFERENCE_IMAGES, ReferenceImage
from .review_frames import ReviewSheet
from .tools import (
    MAX_TOOL_ROUNDS,
    ExampleReader,
    PassKind,
    WorkingDraft,
    ignored_call_reply,
    offered_tools,
    run_tool,
    tool_definitions,
)

_log = get_logger("app.generation.passes")

PassEnd = Literal["submitted", "edited", "accepted", "asked", "planned", "no_tool_call", "round_limit"]
"""How a pass ended: a tool call's ``tools.Outcome``, an answer without a tool call, or the round limit."""

_TOOL_CALL_EVENTS: Final = frozenset({"function_tool_call_delta", "function_tool_call_done"})


@dataclass(frozen=True)
class PassSpec:
    """What one pass sends: the run's model row, the instructions, its user message and its tools' context.

    ``sheets`` are a review pass's contact sheets. ``can_ask`` is false once
    the person has answered or skipped the questions about their request.
    ``can_plan`` lets a write pass answer with a batch plan (``plan_batch``).
    ``effects`` offers the effect tools, for a draft that may place effects.
    ``reasoning_effort`` is the run's chosen level, already checked against
    the row; ``None`` leaves the model's default. ``stored_responses`` is
    false once an earlier pass of the run found that the provider could not
    resolve a stored response: no round of this pass then names one, and
    each carries the whole exchange.
    ``selector_in_use`` and ``example_reader`` are what the tools may ask of
    the owner's Library (see ``tools.run_tool``). ``reference_images`` are
    the person's own images for the request, which only a write or revise
    pass carries; one without bytes (the model takes no images) is not sent.
    """

    kind: PassKind
    model_provider: ModelProvider
    instructions: str
    message: str
    prompt_cache_key: str | None = None
    reasoning_effort: str | None = None
    stored_responses: bool = True
    sheets: tuple[ReviewSheet, ...] = ()
    can_ask: bool = True
    can_plan: bool = False
    effects: bool = False
    selector_in_use: SelectorInUse | None = None
    example_reader: ExampleReader | None = None
    reference_images: tuple[ReferenceImage, ...] = ()


@dataclass(frozen=True)
class PassText:
    """Text the model wrote outside a tool call, as it streams."""

    text: str


@dataclass(frozen=True)
class PassWriting:
    """The model began a tool call in this response: it is writing, no longer only thinking."""


@dataclass(frozen=True)
class PassRound:
    """One model response arrived. ``usage`` is what the provider reported for it when ``usage_reported``;
    otherwise the adapter's own figures: a rough count on a server that streams no usage, or nothing."""

    usage: Usage
    usage_reported: bool


@dataclass(frozen=True)
class PassCursorLost:
    """The provider could not resolve the response a round continued from: the round is sent again without it.

    Yielded once, before that round's response. No later round of the pass
    names a stored response, and the run should start its later passes with
    ``PassSpec.stored_responses`` false.
    """


@dataclass(frozen=True)
class PassEnded:
    """The pass is over. ``text`` is the last response's own text; the working draft holds the rest."""

    end: PassEnd
    text: str
    rounds: int


PassItem = PassText | PassWriting | PassRound | PassCursorLost | PassEnded


def pass_request(spec: PassSpec, intent: Intent, held: frozenset[str] = frozenset()) -> ModelClientRequest:
    """The pass's first request: the instructions, one user message and the pass's tools.

    It names the run's reasoning effort in the prompt option chat uses, or
    none for the model's default, and no response format and no continuation
    from anything before the pass. A review pass's sheets are
    image parts of the user message, the only place model adapters read
    images, with their bytes on the request itself; they never get an id
    outside it.

    A write or revise pass's reference images ride the same way (spec R8.2):
    the stored copies' bytes on the request, under ids and names made here,
    so neither the person's file names nor their file ids reach a provider.
    The message then says what the images are (``prompts.reference_images_text``).
    """

    if spec.sheets and spec.kind != "review":
        raise ValueError("Only a review pass carries contact sheets")
    if spec.reference_images and spec.kind not in ("write", "revise"):
        raise ValueError("Only a write or revise pass carries reference images")
    content: str | list[dict[str, Any]] = spec.message
    images: dict[str, ModelClientImage] = {}
    parts: list[dict[str, Any]] = []
    if spec.sheets:
        for number, sheet in enumerate(spec.sheets, start=1):
            file_id = f"review-sheet-{number}"
            parts.append(image_part(file_id=file_id, name=f"sheet-{number}", width=sheet.width, height=sheet.height))
            images[file_id] = ModelClientImage(media_type=sheet.media_type, content=sheet.content)
        content = [*parts, {"type": "text", "text": spec.message}]
    sent = [image for image in spec.reference_images if image.content is not None][:MAX_REFERENCE_IMAGES]
    if sent:
        for number, image in enumerate(sent, start=1):
            file_id = f"reference-image-{number}"
            parts.append(
                image_part(file_id=file_id, name=f"reference-{number}", width=image.width, height=image.height)
            )
            images[file_id] = ModelClientImage(media_type=image.media_type, content=cast(bytes, image.content))
        about = prompts.reference_images_text([image.kind for image in sent])
        content = [*parts, {"type": "text", "text": f"{spec.message}\n\n{about}"}]
    return ModelClientRequest(
        model_provider=spec.model_provider,
        prompt=DirectChatPrompt(
            messages=({"role": "system", "content": spec.instructions}, {"role": "user", "content": content}),
            tools=cast(
                Any,
                tool_definitions(
                    spec.kind, intent, can_ask=spec.can_ask, can_plan=spec.can_plan, effects=spec.effects, held=held
                ),
            ),
            tool_choice="auto",
            parallel_tool_calls=False,
            prompt_cache_key=spec.prompt_cache_key,
            reasoning_effort=cast(Any, spec.reasoning_effort),
        ),
        images=images,
    )


async def run_pass(
    client: ModelClient,
    spec: PassSpec,
    draft: WorkingDraft,
    *,
    on_request: Callable[[], None] | None = None,
) -> AsyncGenerator[PassItem, None]:
    """Run one pass on ``draft`` and yield what happens; the last item is its ``PassEnded``.

    Each round sends the request, forwards the response's text as it streams
    and runs its first tool call through ``tools.run_tool``. A call that ends
    the pass (``draft.outcome``) ends it here; any other gets its result, and
    every further call of the same response a refusal, in the next round's
    request. The pass also ends when a response holds no tool call, or after
    ``MAX_TOOL_ROUNDS`` responses, with ``draft`` as the last accepted call
    left it.

    A round that names a stored response the provider cannot resolve is sent
    once more without the cursor (the request already holds the whole
    exchange), after a ``PassCursorLost``, and no later round of the pass
    names one. That refused request is not a response, so it is neither a
    round nor counted in the usage. With ``spec.stored_responses`` false the
    pass names no stored response from its start.

    ``on_request`` is called just before each request leaves, the replay of
    a refused round included, so the caller knows of a request that was
    started whether or not a ``PassRound`` ever answers it.
    """

    offered = offered_tools(spec.kind, can_ask=spec.can_ask, can_plan=spec.can_plan, effects=spec.effects)
    request = pass_request(spec, draft.intent, draft.held)
    text = ""
    cursorless = not spec.stored_responses
    for round_number in range(1, MAX_TOOL_ROUNDS + 1):
        final: ModelClientFinal | None = None
        streamed, writing = False, False
        while True:
            if on_request is not None:
                on_request()
            stream = client.stream(request)
            try:
                async for delta in stream:
                    if delta.kind == "text_delta" and delta.text:
                        streamed = True
                        yield PassText(delta.text)
                    elif delta.kind == "event" and not writing and _begins_tool_call(delta):
                        writing = True
                        yield PassWriting()
                    elif delta.kind == "final" and delta.final is not None:
                        final = delta.final
                    elif delta.kind == "error":
                        raise ModelClientError(
                            delta.error or "Model client stream failed",
                            code="model_client_error",
                            raw_metadata=delta.raw_metadata,
                        )
            except ModelClientError as error:
                if not should_retry_without_previous_response_id(
                    error, request, partial_text_seen=streamed, allow_previous_response_retry=not cursorless
                ):
                    raise
                _log.warning(
                    "Generation pass replays a round without its stored response",
                    pass_kind=spec.kind,
                    round=round_number,
                    code=error.code,
                )
                # The sheets ride on the request itself, so the replay keeps them.
                cursorless, request = True, model_request_without_continuation(request, keep_images=True)
                yield PassCursorLost()
                continue
            finally:
                # A pass stopped at one of its own events must not leave the provider's stream open behind it.
                close = getattr(stream, "aclose", None)
                if close is not None:
                    await close()
            break
        if final is None:
            raise ModelClientError("Model client stream ended without a final result", code="model_client_error")
        text = final.text
        if text and not streamed:
            # An adapter that reports text only with its final still shows it.
            yield PassText(text)
        yield PassRound(usage=final.usage, usage_reported=final.usage_reported)
        if not final.tool_calls:
            yield PassEnded(end="no_tool_call", text=text, rounds=round_number)
            return
        call, *others = final.tool_calls
        reply = run_tool(draft, call, offered, selector_in_use=spec.selector_in_use, example_reader=spec.example_reader)
        _log.info(
            "Generation tool call ran",
            pass_kind=spec.kind,
            round=round_number,
            arguments_length=len(call.arguments),
            problem_count=len(reply.problems),
            outcome=draft.outcome,
            ignored_call_count=len(others),
        )
        if draft.outcome is not None:
            yield PassEnded(end=draft.outcome, text=text, rounds=round_number)
            return
        ignored = ignored_call_reply().output
        results = (
            _result(call, reply.output, ok=not reply.problems),
            *(_result(other, ignored, ok=False) for other in others),
        )
        request = model_request_with_appended_messages(
            request,
            tool_exchange_prompt_items(model_request=request, tool_calls=final.tool_calls, tool_results=results),
            previous_final=final,
            # The request carries the sheets' bytes itself, and some routes take the whole input every round.
            keep_images=True,
        )
        if cursorless:
            # The provider keeps no response to continue from: every later round carries the whole exchange.
            request = model_request_without_continuation(request, keep_images=True)
    yield PassEnded(end="round_limit", text=text, rounds=MAX_TOOL_ROUNDS)


def _begins_tool_call(delta: ModelClientDelta) -> bool:
    """Whether a stream observation shows the model writing a function tool call."""

    return getattr(delta.stream_event, "kind", None) in _TOOL_CALL_EVENTS


def _result(call: ModelClientToolCall, output: str, *, ok: bool) -> ModelClientToolResult:
    return ModelClientToolResult(
        call_id=call.id, tool_type=call.tool_type, status="completed" if ok else "failed", output=output
    )


__all__ = [
    "PassCursorLost",
    "PassEnd",
    "PassEnded",
    "PassItem",
    "PassRound",
    "PassSpec",
    "PassText",
    "PassWriting",
    "pass_request",
    "run_pass",
]
