from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select, update

from animama.adapters.repositories.sqlalchemy.anima_repo import SQLAlchemyAnimaRepository
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.app.anima_creation_contract import EnsureAnimaStartersRequest
from animama.app.ports.anima_creation_port import StarterReceipt
from animama.app.services import anima_starter_service
from animama.app.services.anima_loadout_service import AnimaLoadoutService
from animama.app.services.anima_starter_service import STARTER_ANIMA_SPECS, AnimaStarterService
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.starter_idle_pool import starter_idle_keys, starter_idle_pool
from animama.app.services.starter_loadout_policy import starter_loadout_policy, starter_reaction_pools
from animama.domain.anima import Anima
from animama.domain.anima_chat_profile import AnimaChatProfile
from animama.domain.anima_creation_error import AnimaCreationError
from animama.domain.anima_definition import ANIMA_MEMORIES_TEMPLATE, DEFAULT_ANIMA_VOICE_ID
from animama.domain.avatar import Avatar
from animama.domain.request_principal import RequestPrincipal
from animama.domain.settings import AnimaSettings
from animama.orm import ORMAnima, ORMAnimaCreationReceipt, ORMAnimaSettings, ORMAnimaStarterReceipt, ORMMemoryEntry
from animama.product_http.routes.animas import list_animas
from animama.runtime.starter_content import CORE_LIBRARY_ROOTS
from tests.anima_creation_service_support import (
    EXPECTED_STARTER_GESTURE_IDS,
    anima_creation_fixture,
    copy_tracked_included,
    write_supplied_starter_fixture,
)
from tests.local_http_client import local_client

REQUEST = EnsureAnimaStartersRequest(schema_version=1, repairs=[])


def idle_seed_keys() -> set[str]:
    """Every Gesture named by the reviewed starter Idle seed, installed or not."""

    return set(starter_idle_keys())


def idle_keys(members) -> list[str]:
    """Logical keys of Idle members; an unavailable member has none and reads as ''."""
    return [(member.source.logical_key or "") if member.source else "" for member in members]


async def legacy_anima(session, fixture, spec, *, profile: bool = True, pocket_voice: str | None = None):
    """Construct stored starter-adoption evidence directly in the fixture.

    Real Version 1 identity history is essential to the adoption check. A later
    customized value must never become a new source of historical provenance.
    """

    service = fixture.service(session)
    avatar = await service.uow.avatars.get(spec.legacy_avatar_id)
    if avatar is None:
        avatar = await service.uow.avatars.create(
            Avatar(
                id=spec.legacy_avatar_id,
                name=f"Legacy {spec.display_name} {uuid4().hex}",
                identity=spec.identity_markdown,
                file_path=f"/shared/{spec.avatar_locator}",
                private=False,
            )
        )
        fixture.extra_avatar_ids.add(avatar.id)
    anima = Anima(
        id=f"legacy-{uuid4().hex}",
        user_id=fixture.owner,
        display_name=avatar.name,
        avatar=avatar,
        profile_picture_url=spec.legacy_profile_url if profile else None,
    )
    stored = await service.uow.animas.create(anima)
    await MemoryEntryService(
        memory_entries=service.uow.memory_entries,
        animas=service.uow.animas,
        uow=service.uow,
        commit_on_write=False,
    ).initialize_anima_identity(
        user_id=fixture.owner,
        anima_id=anima.id,
        content=avatar.identity,
        description=f"Initial identity of {avatar.name}",
        metadata={
            "anima_id": anima.id,
            "source": {"type": "avatar_identity_seed", "avatar_id": avatar.id, "avatar_name": avatar.name},
        },
    )
    await service.uow.settings.upsert(
        AnimaSettings(
            user_id=fixture.owner,
            anima_id=anima.id,
            preferences={
                "speech": {
                    "elevenlabs": {"primary_voice": {"voice_id": "legacy_voice"}},
                    **({"tts_pocket_anima_voice": pocket_voice} if pocket_voice is not None else {}),
                }
            },
        )
    )
    await service.uow.chat_profiles.upsert(
        AnimaChatProfile(anima_id=anima.id, default_model_provider_id=fixture.provider)
    )
    await session.commit()
    return stored


async def mark_legacy(session, fixture):
    repository = fixture.service(session).receipts
    for spec in STARTER_ANIMA_SPECS:
        await repository.save_starter(
            user_id=fixture.owner, receipt=StarterReceipt(spec.id, 1, "legacy_unresolved", None, [])
        )
    await session.commit()


IDENTITY_TEMPLATE_HINTS = {
    "## Essence": "In a sentence or two, who they are at heart.",
    "## Personality": "Temperament, quirks, and how they react to people and situations.",
    "## Speaking style": "Tone, word choice, pace, humor and verbal habits. Replies are often spoken aloud.",
    "## Appearance and presence": "How they look, dress and carry themselves; how they move and express emotion.",
    "## Background": "The history and experiences that shape them.",
    "## Interests": "What they love, know about and enjoy talking about.",
    "## Values": "What matters to them and what they stand for.",
    "## With the user": "The role they play in the user's life (friend, sidekick, mentor…) and how they",
    "## Boundaries": "Topics they avoid, lines they will not cross and how they express limits.",
}


@pytest.mark.parametrize("spec", STARTER_ANIMA_SPECS, ids=lambda spec: spec.id)
def test_starter_identity_writes_every_identity_template_section(spec):
    lines = spec.identity_markdown.strip().splitlines()
    assert lines[0] == f"# {spec.display_name}"
    headings = [line for line in lines if line.startswith("## ")]
    assert headings == list(IDENTITY_TEMPLATE_HINTS)
    sections = re.split(r"^## .*$", spec.identity_markdown, flags=re.M)[1:]
    for heading, body in zip(headings, sections, strict=True):
        assert body.strip(), heading
        assert IDENTITY_TEMPLATE_HINTS[heading] not in body, heading


@pytest.mark.parametrize("mounted_included", [False, True])
@pytest.mark.parametrize("preserved_pocket_voice", [None, "jane"])
async def test_fresh_starters_retry_preserve_customization_and_deletion(
    async_session, tmp_path, monkeypatch, mounted_included, preserved_pocket_voice
):
    async with anima_creation_fixture(
        async_session, tmp_path, full_starter=True, mounted_included=mounted_included
    ) as fixture:
        service = AnimaStarterService(fixture.service(async_session))
        first = await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert first["complete"] is True
        assert [value["outcome"] for value in first["starters"]] == ["created", "created"]
        ids = [value["anima_id"] for value in first["starters"]]
        versions = [value["spec_version"] for value in first["starters"]]
        expected_pocket_voices = {"starter:annie": "eve", "starter:caitlyn": "azelma"}
        avatar_ids = []
        for anima_id, spec in zip(ids, STARTER_ANIMA_SPECS, strict=True):
            anima = await async_session.get(ORMAnima, anima_id)
            avatar_ids.append(anima.avatar_id)
            assert anima.display_name == spec.display_name
            avatar = await service.uow.avatars.get(anima.avatar_id)
            assert avatar is not None
            assert avatar.file_path.endswith(spec.avatar_locator)
            files = {
                entry.path: entry
                for entry in await async_session.scalars(
                    select(ORMMemoryEntry).where(ORMMemoryEntry.anima_id == anima_id)
                )
            }
            assert set(files) == {"IDENTITY.md", "MEMORIES.md"}
            assert files["IDENTITY.md"].content == spec.identity_markdown
            assert files["MEMORIES.md"].content == ANIMA_MEMORIES_TEMPLATE
            settings = await async_session.scalar(select(ORMAnimaSettings).where(ORMAnimaSettings.anima_id == anima_id))
            assert settings.preferences["speech"]["elevenlabs"]["primary_voice"]["voice_id"] == DEFAULT_ANIMA_VOICE_ID
            assert settings.preferences["speech"]["tts_pocket_anima_voice"] == expected_pocket_voices[spec.id]
            loadout = await AnimaLoadoutService(async_session).read_model(user_id=fixture.owner, anima_id=anima_id)
            assert len(loadout.gestures) == len(starter_loadout_policy()["gestures"])
            assert_starter_reaction_pools(loadout)
        # Launch uses the API's creation order, not names or recent updates.
        listed = json.loads(
            bytes(
                (
                    await list_animas(
                        repositories=SQLAlchemyProductRepositories(async_session),
                        user=RequestPrincipal(id=fixture.owner),
                    )
                ).body
            )
        )
        assert [anima["id"] for anima in listed] == ids
        assert listed[0]["display_name"] == "Annie"
        await async_session.execute(
            update(ORMAnima).where(ORMAnima.id == ids[0]).values(display_name="My customized Annie")
        )
        settings = await service.uow.settings.get(user_id=fixture.owner, anima_id=ids[0])
        assert settings is not None
        speech = dict(settings.preferences["speech"])
        if preserved_pocket_voice is None:
            speech.pop("tts_pocket_anima_voice")
        else:
            speech["tts_pocket_anima_voice"] = preserved_pocket_voice
        settings.preferences = {**settings.preferences, "speech": speech}
        await service.uow.settings.upsert(settings)
        await async_session.commit()
        listed = json.loads(
            bytes(
                (
                    await list_animas(
                        repositories=SQLAlchemyProductRepositories(async_session),
                        user=RequestPrincipal(id=fixture.owner),
                    )
                ).body
            )
        )
        assert [anima["id"] for anima in listed] == ids
        await SQLAlchemyAnimaRepository(async_session).delete(ids[1])
        await async_session.commit()
        monkeypatch.setattr(
            anima_starter_service,
            "STARTER_ANIMA_SPECS",
            tuple(
                replace(spec, version=spec.version + 1, avatar_locator="avatars/next-unavailable.vrm")
                for spec in STARTER_ANIMA_SPECS
            ),
        )
        replay = await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert [value["anima_id"] for value in replay["starters"]] == ids
        assert [value["outcome"] for value in replay["starters"]] == ["existing", "deleted"]
        assert [value["spec_version"] for value in replay["starters"]] == versions
        assert replay["complete"] is True
        assert (await async_session.get(ORMAnima, ids[0], populate_existing=True)).display_name == "My customized Annie"
        assert (await async_session.get(ORMAnima, ids[0])).avatar_id == avatar_ids[0]
        settings = await service.uow.settings.get(user_id=fixture.owner, anima_id=ids[0])
        assert settings is not None
        assert settings.preferences["speech"].get("tts_pocket_anima_voice") == preserved_pocket_voice


async def test_fresh_signup_reuses_seeded_avatar_rows_without_lazy_io(async_session, tmp_path):
    """Starter ensure reuses Included Avatar rows seeded before owner bootstrap."""

    async with anima_creation_fixture(async_session, tmp_path, full_starter=True) as fixture:
        creation = fixture.service(async_session)
        for spec in STARTER_ANIMA_SPECS:
            avatar = await creation.uow.avatars.create(
                Avatar(
                    id=f"seeded-{uuid4().hex}",
                    name=f"Seeded {spec.display_name} {uuid4().hex}",
                    file_path=f"/shared/{spec.avatar_locator}",
                    private=False,
                )
            )
            fixture.extra_avatar_ids.add(avatar.id)
        await async_session.commit()
        result = await AnimaStarterService(creation).ensure(user_id=fixture.owner, request=REQUEST)
        assert result["complete"] is True
        assert [value["outcome"] for value in result["starters"]] == ["created", "created"]
        again = await AnimaStarterService(creation).ensure(user_id=fixture.owner, request=REQUEST)
        assert [value["anima_id"] for value in again["starters"]] == [value["anima_id"] for value in result["starters"]]


async def test_partial_ensure_commits_first_and_retry_only_finishes_second(async_session, tmp_path, monkeypatch):
    async with anima_creation_fixture(async_session, tmp_path, full_starter=True) as fixture:
        creation = fixture.service(async_session)
        service = AnimaStarterService(creation)
        original = creation.materializer.materialize

        async def fail_second(*args, **kwargs):
            if kwargs["spec"].display_name == "Caitlyn":
                raise RuntimeError("temporary second-starter failure")
            return await original(*args, **kwargs)

        monkeypatch.setattr(creation.materializer, "materialize", fail_second)
        with pytest.raises(RuntimeError, match="second-starter"):
            await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert (
            await async_session.scalar(
                select(func.count()).select_from(ORMAnima).where(ORMAnima.user_id == fixture.owner)
            )
            == 1
        )
        first_id = await async_session.scalar(select(ORMAnima.id).where(ORMAnima.user_id == fixture.owner))
        assert (
            await async_session.scalar(
                select(func.count())
                .select_from(ORMAnimaCreationReceipt)
                .where(ORMAnimaCreationReceipt.owner_user_id == fixture.owner)
            )
            == 1
        )
        monkeypatch.setattr(creation.materializer, "materialize", original)
        result = await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert result["starters"][0]["anima_id"] == first_id
        assert [value["outcome"] for value in result["starters"]] == ["existing", "created"]


@pytest.mark.parametrize("pocket_voice", [None, "jane"])
async def test_unambiguous_legacy_adoption_preserves_identity_voice_and_history(async_session, tmp_path, pocket_voice):
    async with anima_creation_fixture(async_session, tmp_path) as fixture:
        await mark_legacy(async_session, fixture)
        created = [
            await legacy_anima(async_session, fixture, spec, pocket_voice=pocket_voice) for spec in STARTER_ANIMA_SPECS
        ]
        await async_session.execute(
            update(ORMAnima).where(ORMAnima.id == created[0].id).values(display_name="Custom live name")
        )
        await async_session.execute(
            update(ORMMemoryEntry)
            .where(ORMMemoryEntry.anima_id == created[0].id)
            .values(content="# Owner customization", version=2)
        )
        await async_session.commit()
        result = await AnimaStarterService(fixture.service(async_session)).ensure(
            user_id=fixture.owner, request=REQUEST
        )
        assert [value["outcome"] for value in result["starters"]] == ["adopted", "adopted"]
        assert [value["anima_id"] for value in result["starters"]] == [value.id for value in created]
        assert (
            await async_session.get(ORMAnima, created[0].id, populate_existing=True)
        ).display_name == "Custom live name"
        identity = await async_session.scalar(select(ORMMemoryEntry).where(ORMMemoryEntry.anima_id == created[0].id))
        assert identity.content == "# Owner customization" and identity.version == 2
        settings = await async_session.scalar(
            select(ORMAnimaSettings).where(ORMAnimaSettings.anima_id == created[0].id)
        )
        assert settings.preferences["speech"]["elevenlabs"]["primary_voice"]["voice_id"] == "legacy_voice"
        assert settings.preferences["speech"].get("tts_pocket_anima_voice") == pocket_voice


@pytest.mark.parametrize("signature", ["absent", "partial", "ambiguous"])
async def test_legacy_uncertainty_never_automatically_recreates(async_session, tmp_path, signature):
    async with anima_creation_fixture(async_session, tmp_path) as fixture:
        await mark_legacy(async_session, fixture)
        if signature != "absent":
            await legacy_anima(async_session, fixture, STARTER_ANIMA_SPECS[0], profile=signature != "partial")
        if signature == "ambiguous":
            await legacy_anima(async_session, fixture, STARTER_ANIMA_SPECS[0])
        count = await async_session.scalar(
            select(func.count()).select_from(ORMAnima).where(ORMAnima.user_id == fixture.owner)
        )
        service = AnimaStarterService(fixture.service(async_session))
        result = await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert result["complete"] is False
        assert all(value["outcome"] == "repair_required" for value in result["starters"])
        assert result == await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert (
            await async_session.scalar(
                select(func.count()).select_from(ORMAnima).where(ORMAnima.user_id == fixture.owner)
            )
            == count
        )


async def test_explicit_legacy_repairs_are_owned_and_cannot_override_success(async_session, tmp_path, monkeypatch):
    async with anima_creation_fixture(async_session, tmp_path, full_starter=True) as fixture:
        await mark_legacy(async_session, fixture)
        creation = fixture.service(async_session)
        service = AnimaStarterService(creation)
        await service.ensure(user_id=fixture.owner, request=REQUEST)
        candidate = await creation.create(user_id=fixture.owner, request=fixture.request())
        request = EnsureAnimaStartersRequest.model_validate(
            {
                "schema_version": 1,
                "repairs": [
                    {"starter_id": "starter:annie", "action": "adopt", "anima_id": candidate["anima_id"]},
                    {"starter_id": "starter:caitlyn", "action": "create_missing"},
                ],
            }
        )
        result = await service.ensure(user_id=fixture.owner, request=request)
        assert result["complete"] is True
        assert [value["outcome"] for value in result["starters"]] == ["adopted", "created"]
        replay = await service.ensure(user_id=fixture.owner, request=REQUEST)
        assert [value["anima_id"] for value in replay["starters"]] == [
            value["anima_id"] for value in result["starters"]
        ]
        with pytest.raises(AnimaCreationError) as error:
            await service.ensure(user_id=fixture.owner, request=request)
        issues = error.value.detail["issues"]
        assert isinstance(issues, list)
        assert issues[0]["code"] == "starter_repair_not_allowed"
        async with local_client(fixture.app(async_session, monkeypatch)) as client:
            response = await client.post("/v1/animas/starters:ensure", json=REQUEST.model_dump())
            assert response.status_code == 200, response.text
            assert response.json()["complete"] is True


def test_starter_request_forbids_templates_duplicate_and_unknown_repairs():
    for payload in (
        {"schema_version": 1, "repairs": [], "animas": []},
        {"schema_version": 1, "repairs": [{"starter_id": "starter:other", "action": "create_missing"}]},
        {"schema_version": 1, "repairs": [{"starter_id": "starter:annie", "action": "create_missing"}] * 2},
        {
            "schema_version": 1,
            "repairs": [{"starter_id": "starter:annie", "action": "create_missing", "anima_id": "forbidden"}],
        },
    ):
        with pytest.raises(ValidationError):
            EnsureAnimaStartersRequest.model_validate(payload)


async def test_starter_repair_cannot_adopt_another_owners_companion(async_session, tmp_path):
    async with anima_creation_fixture(async_session, tmp_path) as fixture:
        other = await fixture.add_owner(async_session)
        creation = fixture.service(async_session)
        foreign = await creation.create(user_id=other, request=fixture.request(avatar="included-avatar"))
        await mark_legacy(async_session, fixture)
        request = EnsureAnimaStartersRequest.model_validate(
            {
                "schema_version": 1,
                "repairs": [{"starter_id": "starter:annie", "action": "adopt", "anima_id": foreign["anima_id"]}],
            }
        )
        with pytest.raises(AnimaCreationError) as error:
            await AnimaStarterService(creation).ensure(user_id=fixture.owner, request=request)
        assert error.value.status == 404
        assert (
            await creation.receipts.starter(user_id=fixture.owner, starter_id="starter:annie")
        ).state == "legacy_unresolved"


async def test_retired_bulk_api_is_absent_and_cannot_write_legacy_receipts(async_session, tmp_path, monkeypatch):
    async with anima_creation_fixture(async_session, tmp_path) as fixture:
        app = fixture.app(async_session, monkeypatch)
        assert "/v1/animas/bulk" not in app.openapi()["paths"]
        async with local_client(app) as client:
            response = await client.post("/v1/animas/bulk", json=[{"anima": {"avatar_id": "old"}}])
            assert response.status_code in {404, 405}
        assert (
            await async_session.scalar(
                select(func.count()).select_from(ORMAnima).where(ORMAnima.user_id == fixture.owner)
            )
            == 0
        )
        assert (
            await async_session.scalar(
                select(func.count())
                .select_from(ORMAnimaStarterReceipt)
                .where(ORMAnimaStarterReceipt.owner_user_id == fixture.owner)
            )
            == 0
        )


async def test_supplied_fixture_content_can_materialize_both_starters(async_session, tmp_path):
    """Exercise supplied-content contracts without claiming real avatar playback."""

    async with anima_creation_fixture(async_session, tmp_path) as fixture:
        fixture.paths = replace(fixture.paths, included_root=write_supplied_starter_fixture(tmp_path / "supplied"))
        scanned = await ContentCatalogService(
            catalog=SQLAlchemyContentCatalog(async_session),
            store=fixture.store(),
        ).rescan(user_id=fixture.owner)
        fixture.extra_catalog_ids.update(item.id for item in scanned.items)
        result = await AnimaStarterService(fixture.service(async_session)).ensure(
            user_id=fixture.owner, request=REQUEST
        )
        assert result["complete"] is True
        assert [value["outcome"] for value in result["starters"]] == ["created", "created"]
        for value in result["starters"]:
            assert value["diagnostics"] == []
            loadout = await AnimaLoadoutService(async_session).read_model(
                user_id=fixture.owner, anima_id=value["anima_id"]
            )
            assert {gesture.source.logical_key for gesture in loadout.gestures if gesture.source} == set(
                EXPECTED_STARTER_GESTURE_IDS
            )
            assert len(loadout.gestures) == 99
            # The supplied library ships no Gesture of the Idle seed, so the pool is empty.
            assert loadout.idle.default_pool == ()
            assert len(loadout.idle.cells) == 72 and all(not cell.gestures for cell in loadout.idle.cells)
            assert_starter_reaction_pools(loadout)


def assert_starter_reaction_pools(loadout) -> None:  # noqa: ANN001
    """All 96 cells hold exactly their Included starter Reactions: one at intensity 1, two at 2-4 (D16)."""

    pools = starter_reaction_pools()
    assert len(loadout.reactions) == 96
    for cell in loadout.reactions:
        keys = pools.get(f"{cell.emotion}-{cell.intensity}", ())
        assert sorted(member.source.logical_key for member in cell.members if member.source) == sorted(keys)
        assert cell.state == ("starter" if keys else "empty")
        assert all(member.origin == "starter" and member.available for member in cell.members)
    assert [len(cell.members) for cell in loadout.reactions] == [1, 2, 2, 2] * 24


def test_starter_gesture_policy_matches_reviewed_identities():
    assert (
        tuple(choice["content_id"] for choice in starter_loadout_policy()["gestures"]) == EXPECTED_STARTER_GESTURE_IDS
    )


def test_starter_gestures_include_every_non_library_gesture_and_exclude_idle_seed():
    """Chat starters cover Included Gestures without equipping the Idle seed or Library-only motions."""

    included_root = Path(__file__).resolve().parents[1] / "content/included"
    included_ids = {
        json.loads(descriptor.read_text())["content_id"]
        for descriptor in (included_root / "gestures").glob("*/*.meta.json")
    }
    # The seed's Mixamo idles are optional non-portable pack Gestures, not tracked Included content.
    idle_ids = idle_seed_keys() & included_ids
    library_ids = {root for root in CORE_LIBRARY_ROOTS if root.startswith("builtin:gesture:")}
    starter_ids = {choice["content_id"] for choice in starter_loadout_policy()["gestures"]}

    assert len(included_ids) == 133
    assert len(library_ids) == 34
    assert len(idle_ids) == 12
    assert idle_ids <= library_ids <= included_ids
    assert starter_ids.isdisjoint(idle_ids)
    assert starter_ids == included_ids - library_ids
    assert len(starter_ids) == 99


async def test_tracked_checkout_materializes_both_starters_without_optional_local_assets(async_session, tmp_path):
    async with anima_creation_fixture(async_session, tmp_path) as fixture:
        fixture.paths = replace(fixture.paths, included_root=copy_tracked_included(tmp_path / "tracked"))
        scanned = await ContentCatalogService(
            catalog=SQLAlchemyContentCatalog(async_session), store=fixture.store()
        ).rescan(user_id=fixture.owner)
        fixture.extra_catalog_ids.update(item.id for item in scanned.items)
        result = await AnimaStarterService(fixture.service(async_session)).ensure(
            user_id=fixture.owner, request=REQUEST
        )
        assert result["complete"]
        for starter in result["starters"]:
            loadout = await AnimaLoadoutService(async_session).read_model(
                user_id=fixture.owner, anima_id=starter["anima_id"]
            )
            assert len(loadout.gestures) == 99
            assert_starter_reaction_pools(loadout)
            # Starters receive the reviewed Idle seed; its Gestures are never AI-callable.
            assert sorted(idle_keys(loadout.idle.default_pool)) == sorted(starter_idle_pool()["default"])
            cells = {(cell.emotion, cell.intensity): idle_keys(cell.gestures) for cell in loadout.idle.cells}
            # Strong inherits Moderate, and without the optional Mixamo idles Mild adds nothing.
            assert cells["joy", 2] == ["builtin:gesture:happy-sway"]
            assert cells["joy", 1] == cells["joy", 3] == cells["admiration", 1] == []
            gesture_keys = {gesture.source.logical_key for gesture in loadout.gestures if gesture.source}
            assert gesture_keys.isdisjoint(idle_seed_keys())
