"""Direct chat turns over SSE, shared by every composition (ADR 0021).

The handler prepares the turn on its write session, which closes before the stream
starts; :mod:`animama.product_http.chat.stream` owns the stream and the
composition's chat-turn lease. The turn hold is declared before the write session,
so it leaves after it and settles a lease whose setup commit fails.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from animama.app.contracts.chat import PyAnimaChatRequest
from animama.domain.request_principal import RequestPrincipal
from animama.product_http.chat.active_turns import ActiveTurns
from animama.product_http.chat.stream import TurnHold, hold_chat_turn, stream_direct_chat_sse
from animama.product_http.ports import Ports, WriteSession
from animama.product_http.principal import get_current_principal

router = APIRouter()
ChatTurnHold = Annotated[TurnHold, Depends(hold_chat_turn, scope="function")]


@router.post("/v1/animas/{anima_id}/chat:sse")
async def chat_anima_direct_sse(
    anima_id: str,
    req: PyAnimaChatRequest,
    ports: Ports,
    hold: ChatTurnHold,
    session: WriteSession,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    turns: ActiveTurns,
) -> StreamingResponse:
    """Run a direct avatar companion chat turn over SSE."""
    return await stream_direct_chat_sse(
        ports=ports,
        hold=hold,
        session=session,
        anima_id=anima_id,
        req=req,
        user=user,
        turns=turns,
    )


__all__ = ["router"]
