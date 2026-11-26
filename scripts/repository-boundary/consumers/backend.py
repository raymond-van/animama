"""Exercise shared backend APIs with local composition imports unavailable.

The artifact audit copies this file outside the checkout and runs it against an
installed wheel. It needs the wheel's declared dependencies, no database, model
credential, server app, installation singleton or filesystem content library.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.abc
import json
import sys
from pathlib import Path
from types import SimpleNamespace

FORBIDDEN = ("animama.local", "animama.server", "animama.runtime", "animama.logging_config", "animama.hooks")


class RejectLocalImports(importlib.abc.MetaPathFinder):
    """Make accidental local-composition imports fail even when files are installed."""

    def find_spec(self, fullname, path=None, target=None):
        if any(fullname == name or fullname.startswith(name + ".") for name in FORBIDDEN):
            raise ImportError(f"Shared consumer imported local composition: {fullname}")
        return None


sys.meta_path.insert(0, RejectLocalImports())

from animama.adapters.repositories.inmemory import InMemoryAnimaRepository, InMemoryUnitOfWork  # noqa: E402
from animama.app.chat import DirectChatMemoryContext, DirectChatTurnExecutor, DirectChatTurnRequest  # noqa: E402
from animama.app.model_clients import (  # noqa: E402
    ModelClientDelta,
    ModelClientFinal,
    StaticModelClientRegistry,
)
from animama.app.ports.owner_profile_bootstrap_port import OwnerProfileBootstrapResult  # noqa: E402
from animama.app.services.anima_service import AnimaService  # noqa: E402
from animama.app.services.chat_manager import ChatManager  # noqa: E402
from animama.app.services.chat_service import ChatService  # noqa: E402
from animama.app.services.owner_bootstrap_service import OwnerBootstrapPolicy, OwnerBootstrapService  # noqa: E402
from animama.domain import (  # noqa: E402
    Anima,
    AnimaChatProfile,
    ModelProvider,
    ModelProviderCapabilities,
    RequestPrincipal,
)
from animama.prompts.avatar_animation_manifest import get_manifest_gesture_inventory  # noqa: E402
from animama.resources.authoring_guidance import GESTURE_GUIDANCE_FILES, gesture_authoring_guidance  # noqa: E402


class Profiles:
    def __init__(self):
        self.owners = set()

    async def ensure(self, *, owner_id):
        created = owner_id not in self.owners
        self.owners.add(owner_id)
        return OwnerProfileBootstrapResult(created=created)


class Settings:
    def __init__(self):
        self.values = {}

    async def get(self, owner_id):
        return self.values.get(owner_id)

    async def upsert(self, value):
        self.values[value.user_id] = value
        return value


class ExistingMemories:
    async def get_entry_by_path(self, **kwargs):
        # Existing private edits must survive repeated owner bootstrap.
        return SimpleNamespace(content=f"Private edit for {kwargs['user_id']}")


class Chats:
    def __init__(self):
        self.rows = {}
        self.turns = {}

    async def get(self, chat_id):
        return self.rows.get(chat_id)

    async def create(self, value):
        self.rows[value.id] = value
        return value

    update = create

    async def list_for_user(self, *, user_id):
        return [row for row in self.rows.values() if row.user_id == user_id]

    async def delete(self, chat_id):
        return self.rows.pop(chat_id, None) is not None

    async def initialize_or_validate_api_standard(self, chat_id, *, api_standard):
        row = self.rows[chat_id]
        row.api_standard = row.api_standard or api_standard
        return row

    async def reserve_message_turns_and_add_usage(self, chat_id, *, message_count, **kwargs):
        first = self.turns.get(chat_id, 0) + 1
        self.turns[chat_id] = first + message_count - 1
        return first, kwargs.get("usage")

    async def merge_metadata(self, chat_id, patch):
        self.rows[chat_id].metadata.update(patch)
        return True


class Messages:
    def __init__(self):
        self.rows = []

    async def recent_model_history(self, chat_id, **kwargs):
        return [row for row in self.rows if row.chat_id == chat_id]

    async def append_many(self, rows):
        for row in rows:
            row.id = len(self.rows) + 1
            self.rows.append(row)
        return list(rows)


class ProviderRepository:
    def __init__(self, provider):
        self.provider = provider

    async def get(self, provider_id):
        return self.provider if provider_id == self.provider.id else None


class ChatProfiles:
    def __init__(self, provider):
        self.provider = provider

    async def resolve_for_anima(self, anima_id):
        return AnimaChatProfile(anima_id=anima_id, default_model_provider_id=self.provider.id)


class MemoryContext:
    async def build_context(self, *, user_id, anima_id, **kwargs):
        return DirectChatMemoryContext(
            anima_identity=f"Anima belonging to {user_id}.",
            manifest={"version": 1, "anima_id": anima_id, "opened_files": []},
            anima_name="Boundary fixture",
        )


class ModelClient:
    def __init__(self):
        self.requests = []

    async def stream(self, request):
        self.requests.append(request)
        payload = json.dumps(
            {
                "emotional_tone": "neutral",
                "emotional_intensity": 1,
                "speech": "Hello from the shared wheel.",
                "gesture": "",
                "display": None,
                "remember": None,
            }
        )
        yield ModelClientDelta(kind="text_delta", text=payload)
        yield ModelClientDelta(kind="final", final=ModelClientFinal(text=payload))
        yield ModelClientDelta(kind="done")

    async def aclose(self):
        return None


async def exercise() -> dict:
    """Use real bootstrap, Anima, chat ownership, prompt/stream and persistence services."""
    owners = [RequestPrincipal("11111111-1111-4111-8111-111111111111"), RequestPrincipal("hosted-user-fixture")]
    uow = InMemoryUnitOfWork()
    profiles, settings = Profiles(), Settings()
    bootstrap = OwnerBootstrapService(
        profiles=profiles,
        user_settings=settings,
        memory_entries=ExistingMemories(),
        starters=None,
        uow=uow,
    )
    policy = OwnerBootstrapPolicy(profile_template_version="2", starter_anima_ids=())
    animas = AnimaService(animas=InMemoryAnimaRepository(), uow=uow)
    chats, messages = Chats(), Messages()
    chat_service = ChatService(chats=chats, uow=uow)
    manager = ChatManager(chats=chats, messages=messages, uow=uow)
    provider = ModelProvider(
        id="OpenAIHTTPAgent:fixture",
        model="fixture",
        provider_type="OpenAIHTTPAgent",
        model_label="Fixture",
        provider_label="Fixture",
        capabilities=ModelProviderCapabilities(
            supports_streaming=True,
            supports_tools=False,
            structured_kinds=["main_structured_response"],
            structured_output_transport="json_schema",
        ),
    )
    client = ModelClient()
    executor = DirectChatTurnExecutor(
        registry=StaticModelClientRegistry({provider.provider_type: client}),
        profile_service=ChatProfiles(provider),
        model_providers=ProviderRepository(provider),
        chat_manager=manager,
        memory_context_service=MemoryContext(),
    )
    event_count = 0
    for number, principal in enumerate(owners):
        assert (await bootstrap.ensure(owner_id=principal.id, policy=policy)).ready
        settings.values[principal.id].theme = f"preserved-{number}"
        assert (await bootstrap.ensure(owner_id=principal.id, policy=policy)).ready
        assert settings.values[principal.id].theme == f"preserved-{number}"
        anima_id, chat_id = f"anima-{number}", f"chat-{number}"
        await animas.create(Anima(id=anima_id, user_id=principal.id, display_name=f"Anima {number}"))
        assert (await animas.get(anima_id)).user_id == principal.id
        await chat_service.create(anima_id=anima_id, user_id=principal.id, chat_id=chat_id)
        events = [
            event
            async for event in executor.stream_turn(
                DirectChatTurnRequest(
                    anima_id=anima_id,
                    user_id=principal.id,
                    chat_id=chat_id,
                    run_id=f"run-{number}",
                    user_message="Hello",
                    request_options={"disable_memory_updates": True, "disable_memory_influence": True},
                    runtime_gesture_ids=(),
                )
            )
        ]
        event_count += len(events)
        own_messages = [row for row in messages.rows if row.chat_id == chat_id]
        assert len(own_messages) == 2
        assert {row.run_id for row in own_messages} == {f"run-{number}"}
        assert events and any("Hello from the shared wheel." in (row.content or "") for row in own_messages)
        assert len(await chat_service.list_for_user(user_id=principal.id)) == 1
    assert profiles.owners == {owner.id for owner in owners}
    assert len(client.requests) == 2
    assert len(messages.rows) == 4
    assert await chat_service.update(chat_id="chat-0", user_id=owners[1].id, title="wrong owner") is None
    try:
        await manager.ensure_owned_chat(anima_id="anima-0", chat_id="chat-0", user_id=owners[1].id)
    except PermissionError:
        pass
    else:
        raise AssertionError("Cross-owner chat access was accepted")
    assert get_manifest_gesture_inventory()
    # Reading every guidance file proves the wheel carries the authoring Markdown.
    assert gesture_authoring_guidance()
    return {
        "owners": len(owners),
        "chat_turns": len(client.requests),
        "events": event_count,
        "persisted_messages": len(messages.rows),
        "catalogs": 1,
        "authoring_guidance_files": len(GESTURE_GUIDANCE_FILES),
        "local_imports": 0,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forbid-source", type=Path)
    args = parser.parse_args()
    result = asyncio.run(exercise())
    if args.forbid_source:
        root = args.forbid_source.resolve()
        leaked = [
            name
            for name, module in sys.modules.items()
            if name.startswith("animama")
            and getattr(module, "__file__", None)
            and Path(module.__file__).resolve().is_relative_to(root)
        ]
        if leaked:
            raise AssertionError(f"Consumer loaded checkout modules: {leaked}")
    print(json.dumps(result, sort_keys=True))
