"""The content assistant's routes: mounted only by the local composition.

A run spends the owner's own plan or key on requests this backend builds, and
its drafts are checked by the local page. The hosted composition never mounts
these routes and reports ``content_generation = false`` in its capabilities.

The caller is always the owner: every route reads only the caller's
conversations and drafts, and another owner's id answers like a missing one.
No route takes instructions, tools or model output. The handlers hold no
logic of their own; ``server/generation.py`` composes what they call.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.generation.usage import conversation_usage
from animama.domain.generation import GenerationError
from animama.domain.request_principal import RequestPrincipal
from animama.server.deps import get_async_session, get_current_principal
from animama.server.generation import (
    REVIEW_FRAMES_REQUEST_BODY,
    RUN_IN_PROGRESS,
    RunHold,
    accept_review_frames,
    generation_refusal,
    generation_runtime,
    generation_service,
    hold_generation_run,
    list_owner_conversations,
    read_conversation,
    record_check_report,
    refusal,
    start_generation_run,
)
from animama.server.schemas.generation import (
    PyGenerationCheckReport,
    PyGenerationConversation,
    PyGenerationConversationCreate,
    PyGenerationConversationList,
    PyGenerationConversationSnapshot,
    PyGenerationConversationUsage,
    PyGenerationDraft,
    PyGenerationMarkSaved,
    PyGenerationMessage,
    PyGenerationRunRequest,
)

router = APIRouter(tags=["generation"])

Owner = Annotated[RequestPrincipal, Depends(get_current_principal)]
Session = Annotated[AsyncSession, Depends(get_async_session)]
# Declared before the run's session, so it leaves after it: see ``hold_generation_run``.
HeldRun = Annotated[RunHold, Depends(hold_generation_run, scope="function")]
# Function scope closes the session before the response is sent, so none is open while a run streams.
SetupSession = Annotated[AsyncSession, Depends(get_async_session, scope="function")]


@contextmanager
def _refusals() -> Iterator[None]:
    """Answer a refused storage operation with its code: 404 for a row that is missing or another owner's."""

    try:
        yield
    except GenerationError as error:
        raise generation_refusal(error) from error


def _require_no_run(request: Request, owner_user_id: str, conversation_id: str) -> None:
    """Refuse a change that would pull a conversation's drafts from under its run."""

    if generation_runtime(request.app).runs.running(owner_user_id, conversation_id):
        raise refusal(RUN_IN_PROGRESS, 409)


@router.get("/v1/generation/conversations", response_model=PyGenerationConversationList)
async def list_generation_conversations(
    request: Request, principal: Owner, session: Session
) -> PyGenerationConversationList:
    """Return the caller's assistant conversations, the most recently written to first.

    A creator's conversation that outlived what it belongs to is removed
    first: one whose item is no longer in the caller's Library, and one about
    an unsaved item that was not written to for seven days
    (``list_owner_conversations``).
    """

    conversations = await list_owner_conversations(request.app, session, principal)
    # The wire schema names no owner field, so the stored owner id is not copied.
    return PyGenerationConversationList(
        conversations=[PyGenerationConversation.model_validate(item, from_attributes=True) for item in conversations]
    )


@router.post("/v1/generation/conversations", response_model=PyGenerationConversation, status_code=201)
async def create_generation_conversation(
    body: PyGenerationConversationCreate, request: Request, principal: Owner, session: Session
) -> PyGenerationConversation:
    """Start an empty conversation on the Generate page or in a creator."""

    conversation = await generation_service(request.app, session).create_conversation(
        principal.id, body.scope.model_dump()
    )
    return PyGenerationConversation.model_validate(conversation, from_attributes=True)


@router.get("/v1/generation/conversations/{conversation_id}", response_model=PyGenerationConversationSnapshot)
async def get_generation_conversation(
    conversation_id: str, request: Request, principal: Owner, session: Session
) -> PyGenerationConversationSnapshot:
    """Return a conversation with its messages in the order added, its drafts by position and its token use.

    With no run in flight on the conversation, a draft whose status does not
    describe it is settled first (one a run left mid-step, or one whose
    report arrived after it was left): by its current version's report, to
    ``checking`` when that version has none, or deleted when it never got a
    project. ``usage`` adds up what the stored runs recorded.
    """

    with _refusals():
        snapshot = await read_conversation(request.app, session, principal.id, conversation_id)
    return PyGenerationConversationSnapshot(
        conversation=PyGenerationConversation.model_validate(snapshot.conversation, from_attributes=True),
        messages=[PyGenerationMessage.model_validate(message, from_attributes=True) for message in snapshot.messages],
        drafts=[PyGenerationDraft.from_domain(draft) for draft in snapshot.drafts],
        usage=PyGenerationConversationUsage.from_domain(conversation_usage(snapshot.messages)),
    )


@router.delete("/v1/generation/conversations/{conversation_id}", status_code=204)
async def delete_generation_conversation(
    conversation_id: str, request: Request, principal: Owner, session: Session
) -> Response:
    """Delete a conversation with its messages and drafts. Refused while a run works on it: stop the run first."""

    _require_no_run(request, principal.id, conversation_id)
    with _refusals():
        await generation_service(request.app, session).delete_conversation(principal.id, conversation_id)
    return Response(status_code=204)


@router.post("/v1/generation/conversations/{conversation_id}/runs:sse")
async def run_generation_sse(
    conversation_id: str,
    body: PyGenerationRunRequest,
    request: Request,
    principal: Owner,
    hold: HeldRun,
    session: SetupSession,
) -> StreamingResponse:
    """Run one request to the assistant and stream its events; closing the stream stops the run.

    Refused with 409 ``generation_run_in_progress`` while the conversation
    has a run in flight, with 422 ``generation_model_unusable`` and a
    ``reason`` when the named model cannot be used, and with 422
    ``generation_reasoning_effort_unsupported`` when the model cannot run a
    pass at the named effort.
    """

    return await start_generation_run(
        request, session=session, principal=principal, conversation_id=conversation_id, body=body, hold=hold
    )


@router.put("/v1/generation/drafts/{draft_id}/check-report", response_model=PyGenerationDraft)
async def record_generation_check_report(
    draft_id: str, body: PyGenerationCheckReport, request: Request, principal: Owner, session: Session
) -> PyGenerationDraft:
    """Store the page's check report for the draft's current version; a stale version is refused with 409."""

    with _refusals():
        draft = await record_check_report(request.app, session, principal.id, draft_id, body)
    return PyGenerationDraft.from_domain(draft)


@router.put("/v1/generation/drafts/{draft_id}/review-frames", status_code=204, openapi_extra=REVIEW_FRAMES_REQUEST_BODY)
async def upload_generation_review_frames(
    draft_id: str, request: Request, principal: Owner, version: Annotated[int, Query(ge=1)]
) -> Response:
    """Take the contact sheets a run asked for with ``frames.requested``, for that draft version only."""

    await accept_review_frames(request, principal.id, draft_id, version)
    return Response(status_code=204)


@router.post("/v1/generation/drafts/{draft_id}:restore", response_model=PyGenerationDraft)
async def restore_generation_draft(
    draft_id: str, request: Request, principal: Owner, session: Session
) -> PyGenerationDraft:
    """Put back the project from before the person's last revising message, as a new version to check."""

    service = generation_service(request.app, session)
    with _refusals():
        _require_no_run(request, principal.id, (await service.get_draft(principal.id, draft_id)).conversation_id)
        draft = await service.restore_previous(principal.id, draft_id)
    return PyGenerationDraft.from_domain(draft)


@router.post("/v1/generation/drafts/{draft_id}:mark-saved", response_model=PyGenerationDraft)
async def mark_generation_draft_saved(
    draft_id: str, body: PyGenerationMarkSaved, request: Request, principal: Owner, session: Session
) -> PyGenerationDraft:
    """Record the Library item the person saved this draft as. Saving itself is the creator's own save."""

    with _refusals():
        draft = await generation_service(request.app, session).mark_saved(principal.id, draft_id, body.item_id)
    return PyGenerationDraft.from_domain(draft)


@router.delete("/v1/generation/drafts/{draft_id}", status_code=204)
async def delete_generation_draft(draft_id: str, request: Request, principal: Owner, session: Session) -> Response:
    """Discard a draft. A run that was working on it ends."""

    with _refusals():
        await generation_service(request.app, session).delete_draft(principal.id, draft_id)
    return Response(status_code=204)


__all__ = ["router"]
