from __future__ import annotations

from types import MappingProxyType

import pytest

from animama.adapters.repositories.sqlalchemy.chat_compaction_repo import SQLAlchemyChatCompactionRepository
from animama.adapters.repositories.sqlalchemy.chat_message_repo import SQLAlchemyChatMessageRepository
from animama.adapters.repositories.sqlalchemy.chat_repo import SQLAlchemyChatRepository
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.chat.api_standard import (
    CHAT_API_STANDARD_CHAT_COMPLETIONS,
    CHAT_API_STANDARD_RESPONSES,
    chat_api_standard_for_provider,
)
from animama.app.chat.direct_turn.message_builders import assistant_message_data
from animama.app.model_clients import ModelClientFinal
from animama.app.services import ChatApiStandardConflictError, ChatManager, ModelProviderCatalogService
from animama.app.services.chat_title_generation_service import sanitize_generated_chat_title
from animama.domain import ModelProvider
from animama.domain.chat import Chat, ChatMessage, MessageRole
from animama.domain.chat_compaction import ChatCompaction
from animama.domain.usage import Usage, UsageOutputDetails
from animama.orm import ORMAnima, ORMChat


def _chat_manager(async_session) -> ChatManager:
    return ChatManager(
        chats=SQLAlchemyChatRepository(async_session),
        messages=SQLAlchemyChatMessageRepository(async_session),
        compactions=SQLAlchemyChatCompactionRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    )


async def _sync_model_catalog(async_session) -> None:
    await ModelProviderCatalogService(
        model_providers=SQLAlchemyModelProviderRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    ).sync_from_registry()


@pytest.mark.asyncio
async def test_chat_manager_creates_missing_owned_chat(async_session):
    async_session.add(ORMAnima(id="anima-chat-manager", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)

    chat = await manager.ensure_owned_chat(
        anima_id="anima-chat-manager",
        chat_id="chat-manager-1",
        user_id="user-1",
    )

    assert chat.id == "chat-manager-1"
    assert chat.anima_id == "anima-chat-manager"
    assert chat.user_id == "user-1"


@pytest.mark.asyncio
async def test_chat_manager_creates_missing_chat_with_api_standard(async_session):
    async_session.add(ORMAnima(id="anima-chat-manager-standard", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)

    chat = await manager.ensure_owned_chat(
        anima_id="anima-chat-manager-standard",
        chat_id="chat-manager-standard-1",
        user_id="user-1",
        api_standard=CHAT_API_STANDARD_CHAT_COMPLETIONS,
        model_provider_id="OpenAIHTTPAgent:gpt-6-luna",
    )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-manager-standard-1")

    assert chat.api_standard == CHAT_API_STANDARD_CHAT_COMPLETIONS
    assert chat.last_model_client is None
    assert stored is not None
    assert stored.api_standard == CHAT_API_STANDARD_CHAT_COMPLETIONS
    assert stored.last_model_client is None


@pytest.mark.asyncio
async def test_chat_manager_initializes_empty_existing_chat_api_standard(async_session):
    async_session.add(ORMAnima(id="anima-chat-empty-standard", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(id="chat-empty-standard-1", anima_id="anima-chat-empty-standard", user_id="user-1")
    )
    await async_session.commit()
    manager = _chat_manager(async_session)

    chat = await manager.ensure_owned_chat(
        anima_id="anima-chat-empty-standard",
        chat_id="chat-empty-standard-1",
        user_id="user-1",
        api_standard=CHAT_API_STANDARD_RESPONSES,
        model_provider_id="OpenAIResponsesHTTPAgent:gpt-6-luna",
    )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-empty-standard-1")

    assert chat.api_standard == CHAT_API_STANDARD_RESPONSES
    assert chat.last_model_client is None
    assert stored is not None
    assert stored.api_standard == CHAT_API_STANDARD_RESPONSES
    assert stored.last_model_client is None


@pytest.mark.asyncio
async def test_chat_manager_allows_same_standard_and_rejects_mismatch(async_session):
    async_session.add(ORMAnima(id="anima-chat-standard-switch", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(
            id="chat-standard-switch-1",
            anima_id="anima-chat-standard-switch",
            user_id="user-1",
            api_standard=CHAT_API_STANDARD_CHAT_COMPLETIONS,
        )
    )
    await async_session.commit()
    manager = _chat_manager(async_session)

    allowed = await manager.ensure_owned_chat(
        anima_id="anima-chat-standard-switch",
        chat_id="chat-standard-switch-1",
        user_id="user-1",
        api_standard=CHAT_API_STANDARD_CHAT_COMPLETIONS,
        model_provider_id="OpenAIHTTPAgent:gpt-5-mini",
    )
    with pytest.raises(ChatApiStandardConflictError) as exc:
        await manager.ensure_owned_chat(
            anima_id="anima-chat-standard-switch",
            chat_id="chat-standard-switch-1",
            user_id="user-1",
            api_standard=CHAT_API_STANDARD_RESPONSES,
            model_provider_id="OpenAIResponsesHTTPAgent:gpt-6-luna",
        )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-standard-switch-1")

    assert allowed.api_standard == CHAT_API_STANDARD_CHAT_COMPLETIONS
    assert exc.value.detail == {
        "code": "chat_api_standard_mismatch",
        "chat_id": "chat-standard-switch-1",
        "chat_api_standard": CHAT_API_STANDARD_CHAT_COMPLETIONS,
        "requested_api_standard": CHAT_API_STANDARD_RESPONSES,
        "requested_model_provider_id": "OpenAIResponsesHTTPAgent:gpt-6-luna",
        "action": "start_new_chat",
    }
    assert stored is not None
    assert stored.api_standard == CHAT_API_STANDARD_CHAT_COMPLETIONS


@pytest.mark.asyncio
async def test_chat_manager_rejects_non_empty_null_api_standard_chat(async_session):
    async_session.add(ORMAnima(id="anima-chat-null-standard", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(id="chat-null-standard-1", anima_id="anima-chat-null-standard", user_id="user-1")
    )
    await SQLAlchemyChatMessageRepository(async_session).append(
        ChatMessage(
            id=None,
            chat_id="chat-null-standard-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="old message",
            data=None,
            usage=None,
            turn=1,
            created_at=None,
            internal=False,
        )
    )
    await async_session.commit()
    manager = _chat_manager(async_session)

    with pytest.raises(ChatApiStandardConflictError) as exc:
        await manager.ensure_owned_chat(
            anima_id="anima-chat-null-standard",
            chat_id="chat-null-standard-1",
            user_id="user-1",
            api_standard=CHAT_API_STANDARD_CHAT_COMPLETIONS,
            model_provider_id="OpenAIHTTPAgent:gpt-6-luna",
        )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-null-standard-1")

    assert exc.value.detail["chat_api_standard"] is None
    assert exc.value.detail["requested_api_standard"] == CHAT_API_STANDARD_CHAT_COMPLETIONS
    assert stored is not None
    assert stored.api_standard is None


@pytest.mark.asyncio
async def test_chat_manager_set_title_if_blank_does_not_overwrite(async_session):
    async_session.add(ORMAnima(id="anima-chat-title", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(anima_id="anima-chat-title", chat_id="chat-title-1", user_id="user-1")

    updated = await manager.set_title_if_blank(
        chat_id="chat-title-1",
        user_id="user-1",
        title="Generated title",
        metadata_patch={"title_generation": {"prompt_version": "chat-title-v1-test"}},
    )
    skipped = await manager.set_title_if_blank(
        chat_id="chat-title-1",
        user_id="user-1",
        title="Replacement title",
        metadata_patch={"title_generation": {"prompt_version": "ignored"}},
    )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-title-1")

    assert updated is not None
    assert updated.title == "Generated title"
    assert skipped is None
    assert stored is not None
    assert stored.title == "Generated title"
    assert stored.metadata == {"title_generation": {"prompt_version": "chat-title-v1-test"}}


def test_sanitize_generated_chat_title_enforces_48_character_cap() -> None:
    title = sanitize_generated_chat_title(
        '"Title: This generated chat title is intentionally too long!"',
        max_chars=48,
    )

    assert title == "This generated chat title is intentionally too l"
    assert len(title) <= 48


@pytest.mark.asyncio
async def test_chat_manager_history_is_visible_chat_history_only(async_session):
    async_session.add(ORMAnima(id="anima-chat-history", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(anima_id="anima-chat-history", chat_id="chat-history-1", user_id="user-1")

    await manager.record_turn(
        anima_id="anima-chat-history",
        chat_id="chat-history-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-history-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="visible",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-history-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="internal",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=True,
        ),
    )

    context = await manager.get_chat_context(
        chat_id="chat-history-1",
    )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-history-1")

    assert [message.content for message in context.messages] == ["visible"]
    assert [message.turn for message in context.messages] == [1]
    assert stored is not None
    assert stored.next_turn == 3


@pytest.mark.asyncio
async def test_chat_manager_prepare_chat_context_returns_owned_chat_and_context(async_session):
    async_session.add(ORMAnima(id="anima-chat-prepare", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)

    chat, context = await manager.prepare_chat_context(
        anima_id="anima-chat-prepare",
        chat_id="chat-prepare-1",
        user_id="user-1",
    )

    assert chat.id == "chat-prepare-1"
    assert chat.anima_id == "anima-chat-prepare"
    assert context.messages == []


@pytest.mark.asyncio
async def test_chat_manager_record_turn_persists_messages_and_usage(async_session):
    await _sync_model_catalog(async_session)
    async_session.add(ORMAnima(id="anima-chat-turn", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(anima_id="anima-chat-turn", chat_id="chat-turn-1", user_id="user-1")

    await manager.record_turn(
        anima_id="anima-chat-turn",
        chat_id="chat-turn-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-turn-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="hello",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-turn-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="hi",
            data=None,
            usage=Usage(input_tokens=3, output_tokens=5, total_tokens=8),
            turn=None,
            created_at=None,
            model="gpt-6-luna",
            model_provider="OpenAIHTTPAgent",
            internal=False,
        ),
    )

    context = await manager.get_chat_context(
        chat_id="chat-turn-1",
    )
    stored = await SQLAlchemyChatRepository(async_session).get("chat-turn-1")

    assert [message.content for message in context.messages] == ["hello", "hi"]
    assert [message.turn for message in context.messages] == [1, 2]
    assert [(message.model_provider, message.model) for message in context.messages] == [
        (None, None),
        ("OpenAIHTTPAgent", "gpt-6-luna"),
    ]
    assert stored is not None
    assert stored.usage.input_tokens == 3
    assert stored.usage.output_tokens == 5
    assert stored.usage.total_tokens == 8
    assert stored.active_context_tokens == 8
    assert stored.next_turn == 3

    await manager.record_turn(
        anima_id="anima-chat-turn",
        chat_id="chat-turn-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-turn-1",
            run_id="run-2",
            message_type="message",
            role=MessageRole.USER,
            content="again",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-turn-1",
            run_id="run-2",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="again hi",
            data=None,
            usage=Usage(
                input_tokens=11,
                output_tokens=13,
                total_tokens=24,
                output_tokens_details=UsageOutputDetails(reasoning_tokens=4),
            ),
            turn=None,
            created_at=None,
            internal=False,
        ),
    )
    stored_after_second_turn = await SQLAlchemyChatRepository(async_session).get("chat-turn-1")
    context_after_second_turn = await manager.get_chat_context(
        chat_id="chat-turn-1",
    )

    assert stored_after_second_turn is not None
    assert stored_after_second_turn.usage.input_tokens == 14
    assert stored_after_second_turn.usage.output_tokens == 18
    assert stored_after_second_turn.usage.total_tokens == 32
    assert stored_after_second_turn.usage.output_tokens_details.reasoning_tokens == 4
    assert stored_after_second_turn.active_context_tokens == 20
    assert stored_after_second_turn.next_turn == 5
    assert [message.turn for message in context_after_second_turn.messages] == [1, 2, 3, 4]


@pytest.mark.asyncio
async def test_chat_message_data_raw_response_round_trips(async_session):
    async_session.add(ORMAnima(id="anima-chat-raw-response", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(id="chat-raw-response-1", anima_id="anima-chat-raw-response", user_id="user-1")
    )
    messages = SQLAlchemyChatMessageRepository(async_session)

    stored = await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-raw-response-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="hello",
            data={
                "openai": {"provider": "OpenAIResponsesHTTPAgent", "response_id": "resp_1"},
                "raw_response": {"id": "resp_1", "object": "response"},
                "stream_event_summary": MappingProxyType(
                    {
                        "counts_by_kind": MappingProxyType({"finish_reason": 1}),
                        "finish_reasons": (MappingProxyType({"finish_reason": "stop"}),),
                    }
                ),
            },
            usage=None,
            turn=1,
            created_at=None,
            internal=False,
        )
    )
    await async_session.commit()

    fetched = await messages.list_by_chat("chat-raw-response-1")

    assert stored.data is not None
    assert stored.data["raw_response"] == {"id": "resp_1", "object": "response"}
    assert stored.data["stream_event_summary"] == {
        "counts_by_kind": {"finish_reason": 1},
        "finish_reasons": [{"finish_reason": "stop"}],
    }
    assert fetched[0].data is not None
    assert fetched[0].data["raw_response"] == {"id": "resp_1", "object": "response"}
    assert fetched[0].data["stream_event_summary"] == {
        "counts_by_kind": {"finish_reason": 1},
        "finish_reasons": [{"finish_reason": "stop"}],
    }


@pytest.mark.asyncio
async def test_chat_openai_previous_response_id_round_trips_and_update_preserves(async_session):
    async_session.add(ORMAnima(id="anima-chat-cursor", user_id="user-1"))
    await async_session.commit()
    chats = SQLAlchemyChatRepository(async_session)

    created = await chats.create(
        Chat(
            id="chat-cursor-1",
            anima_id="anima-chat-cursor",
            user_id="user-1",
            openai_previous_response_id="resp_1",
        )
    )
    await async_session.commit()

    assert created.openai_previous_response_id == "resp_1"
    fetched = await chats.get("chat-cursor-1")
    assert fetched is not None
    assert fetched.openai_previous_response_id == "resp_1"

    updated_title = await chats.update(
        Chat(
            id="chat-cursor-1",
            anima_id="anima-chat-cursor",
            user_id="user-1",
            title="Renamed",
            metadata={"topic": "cursor"},
        )
    )
    assert updated_title.openai_previous_response_id == "resp_1"

    updated_cursor = await chats.update(
        Chat(
            id="chat-cursor-1",
            anima_id="anima-chat-cursor",
            user_id="user-1",
            openai_previous_response_id="resp_2",
        )
    )
    assert updated_cursor.openai_previous_response_id == "resp_2"


@pytest.mark.asyncio
async def test_chat_manager_record_turn_advances_openai_previous_response_id(async_session, monkeypatch):
    async_session.add(ORMAnima(id="anima-chat-cursor-turn", user_id="user-1"))
    await async_session.commit()
    chat_repo = SQLAlchemyChatRepository(async_session)
    reserved_cursor: dict[str, str | bool | None] = {}
    original_reserve = chat_repo.reserve_message_turns_and_add_usage

    async def recording_reserve_message_turns_and_add_usage(chat_id: str, **kwargs):
        reserved_cursor["value"] = kwargs.get("openai_previous_response_id")
        reserved_cursor["clear"] = kwargs.get("clear_openai_previous_response_id")
        return await original_reserve(chat_id, **kwargs)

    monkeypatch.setattr(chat_repo, "reserve_message_turns_and_add_usage", recording_reserve_message_turns_and_add_usage)
    manager = ChatManager(
        chats=chat_repo,
        messages=SQLAlchemyChatMessageRepository(async_session),
        compactions=SQLAlchemyChatCompactionRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    )
    await manager.ensure_owned_chat(
        anima_id="anima-chat-cursor-turn",
        chat_id="chat-cursor-turn-1",
        user_id="user-1",
    )

    await manager.record_turn(
        anima_id="anima-chat-cursor-turn",
        chat_id="chat-cursor-turn-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-cursor-turn-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="hello",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-cursor-turn-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="hi",
            data={"openai": {"provider": "OpenAIResponsesHTTPAgent", "response_id": " resp_turn_1 "}},
            usage=Usage(input_tokens=2, output_tokens=3, total_tokens=5),
            turn=None,
            created_at=None,
            internal=False,
        ),
    )

    stored = await SQLAlchemyChatRepository(async_session).get("chat-cursor-turn-1")
    assert reserved_cursor["value"] == "resp_turn_1"
    assert reserved_cursor["clear"] is False
    assert stored is not None
    assert stored.openai_previous_response_id == "resp_turn_1"
    assert await manager.openai_previous_response_id("chat-cursor-turn-1") == "resp_turn_1"
    assert stored.next_turn == 3
    assert stored.usage.total_tokens == 5


@pytest.mark.asyncio
async def test_chat_manager_record_turn_clears_cursor_from_invalid_or_non_responses_metadata(async_session):
    async_session.add(ORMAnima(id="anima-chat-cursor-invalid", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(
            id="chat-cursor-invalid-1",
            anima_id="anima-chat-cursor-invalid",
            user_id="user-1",
            openai_previous_response_id="resp_existing",
        )
    )
    await async_session.commit()
    manager = _chat_manager(async_session)

    await manager.record_turn(
        anima_id="anima-chat-cursor-invalid",
        chat_id="chat-cursor-invalid-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-cursor-invalid-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="hello",
            data={"openai": {"provider": "OpenAIResponsesHTTPAgent", "response_id": "resp_user"}},
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-cursor-invalid-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="hi",
            data={"openai": {"provider": "OpenAIResponsesHTTPAgent", "response_id": " "}},
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
    )

    stored = await SQLAlchemyChatRepository(async_session).get("chat-cursor-invalid-1")
    assert stored is not None
    assert stored.openai_previous_response_id is None


@pytest.mark.asyncio
async def test_chat_manager_record_turn_clears_cursor_for_chat_completions_turn_with_usage(async_session, monkeypatch):
    async_session.add(ORMAnima(id="anima-chat-cursor-chat-completions", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(
            id="chat-cursor-chat-completions-1",
            anima_id="anima-chat-cursor-chat-completions",
            user_id="user-1",
            openai_previous_response_id="resp_existing",
        )
    )
    await async_session.commit()
    chat_repo = SQLAlchemyChatRepository(async_session)
    reserved_cursor: dict[str, object] = {}
    original_reserve = chat_repo.reserve_message_turns_and_add_usage

    async def recording_reserve_message_turns_and_add_usage(chat_id: str, **kwargs):
        reserved_cursor["value"] = kwargs.get("openai_previous_response_id")
        reserved_cursor["clear"] = kwargs.get("clear_openai_previous_response_id")
        return await original_reserve(chat_id, **kwargs)

    monkeypatch.setattr(chat_repo, "reserve_message_turns_and_add_usage", recording_reserve_message_turns_and_add_usage)
    manager = ChatManager(
        chats=chat_repo,
        messages=SQLAlchemyChatMessageRepository(async_session),
        compactions=SQLAlchemyChatCompactionRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    )

    await manager.record_turn(
        anima_id="anima-chat-cursor-chat-completions",
        chat_id="chat-cursor-chat-completions-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-cursor-chat-completions-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="hello",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-cursor-chat-completions-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="hi",
            data={"model_client": {"provider_type": "OpenAIHTTPAgent"}},
            usage=Usage(input_tokens=2, output_tokens=3, total_tokens=5),
            turn=None,
            created_at=None,
            internal=False,
        ),
    )

    stored = await SQLAlchemyChatRepository(async_session).get("chat-cursor-chat-completions-1")
    assert reserved_cursor["value"] is None
    assert reserved_cursor["clear"] is True
    assert stored is not None
    assert stored.openai_previous_response_id is None
    assert stored.usage.total_tokens == 5


@pytest.mark.asyncio
async def test_a_chat_moves_between_key_and_plan_models_and_a_plan_turn_leaves_no_cursor(async_session):
    """Spec #919 R3.6: both use the Responses standard; a plan turn's response is not stored at OpenAI."""

    async_session.add(ORMAnima(id="anima-plan-move", user_id="user-1"))
    await async_session.commit()
    await SQLAlchemyChatRepository(async_session).create(
        Chat(
            id="chat-plan-move-1",
            anima_id="anima-plan-move",
            user_id="user-1",
            api_standard=CHAT_API_STANDARD_RESPONSES,
            openai_previous_response_id="resp_key_model",
        )
    )
    await async_session.commit()
    manager = _chat_manager(async_session)
    plan = ModelProvider(
        id="ChatGPTPlanResponsesHTTPAgent:gpt-6-luna",
        provider_type="ChatGPTPlanResponsesHTTPAgent",
        model="gpt-6-luna",
        model_label="GPT-6 Luna",
        provider_label="ChatGPT plan",
        connection_id="chatgpt_plan",
    )

    await manager.ensure_owned_chat(
        anima_id="anima-plan-move",
        chat_id="chat-plan-move-1",
        user_id="user-1",
        api_standard=chat_api_standard_for_provider(plan).api_standard,  # type: ignore[union-attr]
        model_provider_id=plan.id,
    )
    final = ModelClientFinal(
        text="hi", raw_provider_metadata={"provider": plan.provider_type, "response_id": "resp_plan_unstored"}
    )
    await manager.record_turn(
        anima_id="anima-plan-move",
        chat_id="chat-plan-move-1",
        user_msg=ChatMessage(
            id=None,
            chat_id="chat-plan-move-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="hello",
            data=None,
            usage=None,
            turn=None,
            created_at=None,
            internal=False,
        ),
        assistant_msg=ChatMessage(
            id=None,
            chat_id="chat-plan-move-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="hi",
            data=assistant_message_data(structured={}, final=final, model_provider=plan),
            usage=Usage(input_tokens=2, output_tokens=3, total_tokens=5),
            turn=None,
            created_at=None,
            internal=False,
        ),
    )

    stored = await SQLAlchemyChatRepository(async_session).get("chat-plan-move-1")
    assert stored is not None and stored.openai_previous_response_id is None
    assert stored.api_standard == CHAT_API_STANDARD_RESPONSES


@pytest.mark.asyncio
async def test_chat_manager_active_compaction_filters_to_recent_exact_history(async_session):
    async_session.add(ORMAnima(id="anima-chat-compaction-context", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(
        anima_id="anima-chat-compaction-context",
        chat_id="chat-compaction-context-1",
        user_id="user-1",
    )
    messages = SQLAlchemyChatMessageRepository(async_session)
    compactions = SQLAlchemyChatCompactionRepository(async_session)

    old_user = await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-context-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="old user",
            data=None,
            usage=None,
            turn=1,
            created_at=None,
            internal=False,
        )
    )
    old_assistant = await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-context-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="old assistant",
            data=None,
            usage=None,
            turn=2,
            created_at=None,
            internal=False,
        )
    )
    await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-context-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="internal after compaction",
            data=None,
            usage=None,
            turn=3,
            created_at=None,
            internal=True,
        )
    )
    await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-context-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.SYSTEM,
            content="system after compaction",
            data=None,
            usage=None,
            turn=4,
            created_at=None,
            internal=False,
        )
    )
    await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-context-1",
            run_id="run-2",
            message_type="message",
            role=MessageRole.USER,
            content="recent user",
            data=None,
            usage=None,
            turn=5,
            created_at=None,
            internal=False,
        )
    )
    await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-context-1",
            run_id="run-2",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="recent assistant",
            data=None,
            usage=None,
            turn=6,
            created_at=None,
            internal=False,
        )
    )
    await compactions.activate_new(
        ChatCompaction(
            id=None,
            chat_id="chat-compaction-context-1",
            user_id="user-1",
            anima_id="anima-chat-compaction-context",
            summary_text="Old context summary.",
            start_turn=old_user.turn,
            end_turn=old_assistant.turn,
        )
    )
    await async_session.commit()

    context = await manager.get_chat_context(
        chat_id="chat-compaction-context-1",
    )

    assert context.active_compaction is not None
    assert context.active_compaction.summary_text == "Old context summary."
    assert [message.content for message in context.messages] == ["recent user", "recent assistant"]


@pytest.mark.asyncio
async def test_chat_manager_ignores_active_compaction_without_summary_or_boundary(async_session):
    async_session.add(ORMAnima(id="anima-chat-compaction-invalid", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(
        anima_id="anima-chat-compaction-invalid",
        chat_id="chat-compaction-invalid-1",
        user_id="user-1",
    )
    messages = SQLAlchemyChatMessageRepository(async_session)
    compactions = SQLAlchemyChatCompactionRepository(async_session)

    await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-invalid-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.USER,
            content="visible user",
            data=None,
            usage=None,
            turn=1,
            created_at=None,
            internal=False,
        )
    )
    await messages.append(
        ChatMessage(
            id=None,
            chat_id="chat-compaction-invalid-1",
            run_id="run-1",
            message_type="message",
            role=MessageRole.ASSISTANT,
            content="visible assistant",
            data=None,
            usage=None,
            turn=2,
            created_at=None,
            internal=False,
        )
    )
    await compactions.activate_new(
        ChatCompaction(
            id=None,
            chat_id="chat-compaction-invalid-1",
            user_id="user-1",
            anima_id="anima-chat-compaction-invalid",
            summary_text=" ",
            end_turn=1,
        )
    )
    await async_session.commit()

    context = await manager.get_chat_context(
        chat_id="chat-compaction-invalid-1",
    )

    assert context.active_compaction is None
    assert [message.content for message in context.messages] == ["visible user", "visible assistant"]


async def test_chat_manager_active_context_uses_the_last_request_footprint(async_session):
    """A turn with several requests bills them all but keeps only the last in context."""

    await _sync_model_catalog(async_session)
    async_session.add(ORMAnima(id="anima-chat-context", user_id="user-1"))
    await async_session.commit()
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(anima_id="anima-chat-context", chat_id="chat-context-1", user_id="user-1")

    def _message(role: MessageRole, *, data=None, usage=None) -> ChatMessage:
        return ChatMessage(
            id=None,
            chat_id="chat-context-1",
            run_id="run-context",
            message_type="message",
            role=role,
            content="text",
            data=data,
            usage=usage,
            turn=None,
            created_at=None,
            internal=False,
        )

    await manager.record_turn(
        anima_id="anima-chat-context",
        chat_id="chat-context-1",
        user_msg=_message(MessageRole.USER),
        assistant_msg=_message(
            MessageRole.ASSISTANT,
            data={"model_client": {"raw_provider_metadata": {"context_tokens": 16}}},
            usage=Usage(input_tokens=35, output_tokens=6, total_tokens=41),
        ),
    )

    chat = await async_session.get(ORMChat, "chat-context-1")
    assert chat is not None
    assert chat.cum_total_tokens == 41
    assert chat.active_context_tokens == 16


def _anthropic_row(chat_id: str, turn: int, *, compaction: str | None = None, internal: bool = False) -> ChatMessage:
    """One stored Anthropic chat row; assistant rows may lead with a compaction block."""

    if turn % 2:
        return ChatMessage(
            id=None,
            chat_id=chat_id,
            run_id=f"run-{turn}",
            message_type="message",
            role=MessageRole.USER,
            content=f"user {turn}",
            data=None,
            usage=None,
            turn=turn,
            created_at=None,
            raw_provider_message={"role": "user", "content": f"user {turn}"},
        )
    content: list[dict[str, str]] = [{"type": "compaction", "content": compaction}] if compaction else []
    content.append({"type": "text", "text": f"assistant {turn}"})
    return ChatMessage(
        id=None,
        chat_id=chat_id,
        run_id=f"run-{turn - 1}",
        message_type="message",
        role=MessageRole.ASSISTANT,
        content=f"assistant {turn}",
        data=None,
        usage=None,
        turn=turn,
        created_at=None,
        internal=internal,
        raw_provider_message={"role": "assistant", "content": content},
    )


@pytest.mark.asyncio
async def test_native_compaction_replays_from_the_newest_compaction_block_beyond_the_window(async_session):
    async_session.add(ORMAnima(id="anima-native-compaction", user_id="user-1"))
    await async_session.commit()
    chat_id = "chat-native-compaction-1"
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(anima_id="anima-native-compaction", chat_id=chat_id, user_id="user-1")
    messages = SQLAlchemyChatMessageRepository(async_session)
    rows = [
        _anthropic_row(chat_id, turn, compaction={4: "older summary", 20: "newer summary"}.get(turn))
        for turn in range(1, 271)
    ]
    # A hidden row is never a replay start, even if its content looks like a compaction.
    rows.append(_anthropic_row(chat_id, 272, compaction="hidden", internal=True))
    await messages.append_many(rows)
    # An application compaction on the chat is ignored for Anthropic replay.
    await SQLAlchemyChatCompactionRepository(async_session).activate_new(
        ChatCompaction(
            id=None,
            chat_id=chat_id,
            user_id="user-1",
            anima_id="anima-native-compaction",
            summary_text="App summary.",
            start_turn=1,
            end_turn=100,
        )
    )
    await async_session.commit()

    native = await manager.get_chat_context(chat_id=chat_id, native_compaction=True)
    window = await manager.get_chat_context(chat_id=chat_id)

    assert await messages.latest_compaction_block_turn(chat_id) == 20
    assert native.active_compaction is None
    # Every row from the compacting reply on, more than the 200-message window.
    assert [message.turn for message in native.messages] == list(range(20, 271))
    assert native.messages[0].raw_provider_message["content"][0]["content"] == "newer summary"  # type: ignore[index]
    assert window.active_compaction is not None and len(window.messages) == 170


@pytest.mark.asyncio
async def test_native_compaction_without_a_block_replays_the_recent_window(async_session):
    async_session.add(ORMAnima(id="anima-native-no-compaction", user_id="user-1"))
    await async_session.commit()
    chat_id = "chat-native-no-compaction-1"
    manager = _chat_manager(async_session)
    await manager.ensure_owned_chat(anima_id="anima-native-no-compaction", chat_id=chat_id, user_id="user-1")
    messages = SQLAlchemyChatMessageRepository(async_session)
    await messages.append_many([_anthropic_row(chat_id, turn) for turn in range(1, 211)])
    await async_session.commit()

    context = await manager.get_chat_context(chat_id=chat_id, native_compaction=True)

    assert await messages.latest_compaction_block_turn(chat_id) is None
    assert [message.turn for message in context.messages] == list(range(11, 211))


def _tool_round_row(chat_id: str, turn: int) -> ChatMessage:
    """One row of a four-row tool round: user, tool call, tool result, reply."""

    call_id = f"call-{(turn - 1) // 4}"
    position = (turn - 1) % 4
    content: str | None = None
    if position == 0:
        role, message_type, internal = MessageRole.USER, "message", False
        content = f"user {turn}"
        raw: dict[str, object] = {"role": "user", "content": content}
    elif position == 1:
        role, message_type, internal = MessageRole.ASSISTANT, "tool_call", True
        raw = {
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "recall", "arguments": "{}"}}],
        }
    elif position == 2:
        role, message_type, internal = MessageRole.TOOL, "tool_result", True
        raw = {"role": "tool", "tool_call_id": call_id, "content": "{}"}
    else:
        role, message_type, internal = MessageRole.ASSISTANT, "message", False
        content = f"assistant {turn}"
        raw = {"role": "assistant", "content": content}
    return ChatMessage(
        id=None,
        chat_id=chat_id,
        run_id=f"run-{call_id}",
        message_type=message_type,
        role=role,
        content=content,
        data=None,
        usage=None,
        turn=turn,
        created_at=None,
        internal=internal,
        raw_provider_message=raw,
    )


@pytest.mark.asyncio
async def test_truncated_history_window_never_starts_inside_a_tool_round(async_session):
    async_session.add(ORMAnima(id="anima-split-tool-round", user_id="user-1"))
    await async_session.commit()
    chat_id = "chat-split-tool-round-1"
    manager = ChatManager(
        chats=SQLAlchemyChatRepository(async_session),
        messages=SQLAlchemyChatMessageRepository(async_session),
        compactions=SQLAlchemyChatCompactionRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
        history_limit=6,
    )
    await manager.ensure_owned_chat(anima_id="anima-split-tool-round", chat_id=chat_id, user_id="user-1")
    messages = SQLAlchemyChatMessageRepository(async_session)
    # Three rounds; the newest six rows start at the second round's tool result.
    await messages.append_many([_tool_round_row(chat_id, turn) for turn in range(1, 13)])
    await async_session.commit()

    context = await manager.get_chat_context(chat_id=chat_id)
    native = await manager.get_chat_context(chat_id=chat_id, native_compaction=True)

    # The orphaned result and its round's reply are dropped; replay starts at a user message.
    assert [message.turn for message in context.messages] == [9, 10, 11, 12]
    assert [message.turn for message in native.messages] == [9, 10, 11, 12]
