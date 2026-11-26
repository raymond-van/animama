"""Shared chat routes isolate owners and commit through the composition (ADR 0021)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.domain.chat import MessageRole
from animama.orm import ORMAnima, ORMChat, ORMChatMessage
from animama.product_http.routes import chats
from tests.product_http_support import DeferredCommitPorts, TwoOwnerComposition, product_app


async def seed_owner(factory: async_sessionmaker[AsyncSession], owner: str, words: str) -> tuple[str, str]:
    """An owner's Anima and one chat holding a visible message with ``words``."""

    anima_id, chat_id = f"anima-{uuid4().hex}", f"chat-{uuid4().hex}"
    async with factory() as session:
        session.add(ORMAnima(id=anima_id, user_id=owner))
        session.add(ORMChat(id=chat_id, anima_id=anima_id, user_id=owner, title="Seeded", metadata_={}))
        session.add(
            ORMChatMessage(
                chat_id=chat_id,
                role=MessageRole.USER.value,
                content=words,
                message_data={},
                internal=False,
                turn=1,
                created_at=datetime(2026, 1, 1, 12, 0, 0),
            )
        )
        await session.commit()
    return anima_id, chat_id


async def stored_chat(factory: async_sessionmaker[AsyncSession], chat_id: str) -> ORMChat | None:
    async with factory() as session:
        return await session.get(ORMChat, chat_id)


async def test_an_owner_never_reaches_another_owners_chats(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = DeferredCommitPorts(async_session_factory)
    composition = TwoOwnerComposition(product_app(chats.router, ports=ports), tmp_path)
    marker = f"zebra{uuid4().hex[:8]}"
    a_anima, a_chat = await seed_owner(async_session_factory, "owner-a", f"{marker} belongs to owner a")
    await seed_owner(async_session_factory, "owner-b", "owner b words")

    async with composition.client("owner-b") as b:
        assert (await b.post("/v1/chats", json={"anima_id": a_anima})).status_code == 404
        assert a_chat not in {chat["id"] for chat in (await b.get("/v1/chats")).json()}
        assert (await b.get(f"/v1/chats/{a_chat}")).status_code == 404
        assert (await b.patch(f"/v1/chats/{a_chat}", json={"title": "Taken"})).status_code == 404
        assert (await b.patch(f"/v1/chats/{a_chat}", json={"pinned": True})).status_code == 404
        assert (await b.delete(f"/v1/chats/{a_chat}")).status_code == 404
        assert (await b.get(f"/v1/chats/{a_chat}/messages")).status_code == 404
        assert (await b.post("/v1/chats/search", json={"query": marker})).json()["results"] == []

    async with composition.client("owner-a") as a:
        assert a_chat in {chat["id"] for chat in (await a.get("/v1/chats")).json()}
        assert (await a.get(f"/v1/chats/{a_chat}")).status_code == 200
        assert len((await a.get(f"/v1/chats/{a_chat}/messages")).json()["messages"]) == 1
        assert [
            hit["chat_id"] for hit in (await a.post("/v1/chats/search", json={"query": marker})).json()["results"]
        ] == [a_chat]

    # Owner b's refusals changed nothing, and nothing they wrote was committed.
    chat = await stored_chat(async_session_factory, a_chat)
    assert chat is not None and chat.title == "Seeded" and chat.user_id == "owner-a" and chat.pinned_at is None
    assert ports.commits == 0
    assert set(ports.owners) == {"owner-a", "owner-b"}


async def test_a_pinned_chat_keeps_its_place_in_the_list(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """A pin is not an edit: the list stays most recent first, and clients sort pinned chats first."""

    owner = f"owner-{uuid4().hex[:8]}"
    ports = DeferredCommitPorts(async_session_factory)
    composition = TwoOwnerComposition(product_app(chats.router, ports=ports), tmp_path, owners=(owner, "owner-b"))
    anima_id, older = await seed_owner(async_session_factory, owner, "older")
    newer = f"chat-{uuid4().hex}"
    async with async_session_factory() as session:
        older_row = await session.get(ORMChat, older)
        assert older_row is not None
        older_row.updated_at = datetime(2026, 1, 1, 12, 0, 0)
        session.add(
            ORMChat(
                id=newer,
                anima_id=anima_id,
                user_id=owner,
                title="Newer",
                metadata_={},
                updated_at=datetime(2026, 1, 2, 12, 0, 0),
            )
        )
        await session.commit()

    async with composition.client(owner) as a:
        listed = (await a.get("/v1/chats")).json()
        assert [(chat["id"], chat["pinned_at"]) for chat in listed] == [(newer, None), (older, None)]

        pinned = await a.patch(f"/v1/chats/{older}", json={"pinned": True})
        assert pinned.status_code == 200, pinned.text
        pinned_at = pinned.json()["pinned_at"]
        assert pinned_at is not None and pinned.json()["title"] == "Seeded"
        listed = (await a.get("/v1/chats")).json()
        assert [(chat["id"], chat["pinned_at"]) for chat in listed] == [(newer, None), (older, pinned_at)]
        assert (await a.get(f"/v1/chats/{older}")).json()["pinned_at"] == pinned_at

        # Pinning again keeps the first pin time; a rename keeps the pin.
        assert (await a.patch(f"/v1/chats/{older}", json={"pinned": True})).json()["pinned_at"] == pinned_at
        assert (await a.patch(f"/v1/chats/{older}", json={"title": "Renamed"})).json()["pinned_at"] == pinned_at

        unpinned = await a.patch(f"/v1/chats/{older}", json={"pinned": False})
        assert unpinned.status_code == 200, unpinned.text
        assert (unpinned.json()["title"], unpinned.json()["pinned_at"]) == ("Renamed", None)

    stored = await stored_chat(async_session_factory, older)
    assert stored is not None and stored.pinned_at is None
    # Pin, pin again, rename and unpin each committed through the composition.
    assert ports.commits == 4


async def test_chat_writes_commit_through_the_composition(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = DeferredCommitPorts(async_session_factory)
    composition = TwoOwnerComposition(product_app(chats.router, ports=ports), tmp_path)
    anima_id, _ = await seed_owner(async_session_factory, "owner-a", "hello")

    async with composition.client("owner-a") as a:
        created = await a.post("/v1/chats", json={"anima_id": anima_id, "title": "First"})
        assert created.status_code == 201
        chat_id = created.json()["id"]
        assert (await stored_chat(async_session_factory, chat_id)) is not None

        assert (await a.patch(f"/v1/chats/{chat_id}", json={"title": "Renamed"})).status_code == 200
        renamed = await stored_chat(async_session_factory, chat_id)
        assert renamed is not None and renamed.title == "Renamed"

        assert (await a.delete(f"/v1/chats/{chat_id}")).status_code == 204
        assert await stored_chat(async_session_factory, chat_id) is None

    # Each write asked once and was committed by the composition after the handler.
    assert (ports.commits_requested, ports.commits) == (3, 3)
