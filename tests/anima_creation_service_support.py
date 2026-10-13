"""Real scanned files and isolated owners for private-creation integration tests."""

from __future__ import annotations

import json
import shutil
import struct
import subprocess
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI
from PIL import Image, ImageDraw
from sqlalchemy import delete, select

from animama.adapters.content_store import FilesystemContentStore
from animama.adapters.repositories.sqlalchemy.anima_aggregate_uow import SQLAlchemyAnimaAggregateUnitOfWork
from animama.adapters.repositories.sqlalchemy.anima_creation_repo import SQLAlchemyAnimaCreationRepository
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.anima_creation_contract import CreateAnimaRequest
from animama.app.services.anima_creation_service import AnimaCreationService
from animama.app.services.anima_creation_sources import AnimaCreationSources, item_ref
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_gltf import REQUIRED_VRM_HUMANOID_BONES
from animama.app.services.starter_loadout_policy import starter_loadout_policy, starter_pack_identity
from animama.domain.content_catalog import CatalogContentEntry
from animama.domain.content_sources import IncludedContentSource
from animama.domain.emotions import TRACKED_EMOTIONS
from animama.domain.request_principal import RequestPrincipal
from animama.orm import ORMAnima, ORMAvatar, ORMModelProvider
from animama.orm.content_catalog import ORMContentCatalogItem
from animama.orm.memory_entry import ORMMemoryEntry, ORMMemoryEntryVersion
from animama.product_http.routes import chat_turns, loadouts, typed_content
from animama.server.config import Settings, settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.local_runtime import LocalRuntimePaths, initialize_local_runtime
from animama.server.routers import anima_creation
from tests.product_http_support import install_local_ports


def glb(document: dict[str, Any]) -> bytes:
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    return struct.pack("<4sII", b"glTF", 2, 20 + len(encoded)) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded


def vrm(label: str = "avatar", version: str = "1.0") -> bytes:
    names = sorted(REQUIRED_VRM_HUMANOID_BONES)
    extension = "VRMC_vrm" if version == "1.0" else "VRM"
    bones = (
        {name: {"node": index} for index, name in enumerate(names)}
        if version == "1.0"
        else [{"bone": name, "node": index} for index, name in enumerate(names)]
    )
    return glb(
        {
            "asset": {"version": "2.0", "generator": label},
            "nodes": [{"name": name} for name in names],
            "extensionsUsed": [extension],
            "extensions": {extension: {"specVersion": version, "humanoid": {"humanBones": bones}}},
        }
    )


def vrma() -> bytes:
    return glb({"asset": {"version": "2.0"}, "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}}})


def image_bytes(*, portrait: bool = False, format: str = "PNG") -> bytes:
    image = Image.new("RGBA", (512, 512) if portrait else (32, 24), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((30, 20, 450, 470) if portrait else (2, 2, 28, 22), fill="red")
    output = BytesIO()
    image.save(output, format=format)
    image.close()
    return output.getvalue()


def write_file(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def write_json(path: Path, value: dict[str, Any]) -> None:
    write_file(path, json.dumps(value).encode())


@dataclass
class AnimaCreationFixture:
    owner: str
    provider: str
    paths: LocalRuntimePaths
    items: dict[str, CatalogContentEntry]
    owners: set[str] = field(default_factory=set)
    extra_avatar_ids: set[str] = field(default_factory=set)
    extra_catalog_ids: set[str] = field(default_factory=set)

    async def add_owner(self, session) -> str:
        owner = f"other-{uuid4().hex}"
        self.owners.add(owner)
        return owner

    async def add_action_support(self, session) -> None:
        """Give the fixture Gesture a real typed and byte-verified sound support."""

        audio = BytesIO()
        with wave.open(audio, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(b"\x01\x00" * 800)
        write_file(self.paths.local_root / "sfx/chime.wav", audio.getvalue())
        write_json(
            self.paths.local_root / "sfx/chime.meta.json",
            {"content_type": "sound_effect", "content_id": "local:sound-effect:chime", "name": "Chime"},
        )
        path = self.paths.local_root / "gestures/wave/wave.meta.json"
        document = json.loads(path.read_text())
        document["dependencies"] = [{"ref": "local:sound-effect:chime", "content_type": "sound_effect"}]
        write_json(path, document)
        result = await ContentCatalogService(
            catalog=SQLAlchemyContentCatalog(session),
            store=self.store(),
        ).rescan(user_id=self.owner, include_included=False)
        by_path = {item.relative_locator: item for item in result.items}
        for name, item in self.items.items():
            self.items[name] = by_path[item.relative_locator]
        self.items["sound"] = by_path["sfx/chime.wav"]
        assert self.items["gesture"].status.value == self.items["sound"].status.value == "valid"

    def store(self) -> FilesystemContentStore:
        return FilesystemContentStore(
            included_root=self.paths.included_root,
            included_sources=self.paths.included_sources,
            local_root=self.paths.local_root,
            operations_root=self.paths.operations_root,
        )

    def service(self, session, *, max_identity_bytes: int = 32768) -> AnimaCreationService:
        return AnimaCreationService(
            uow=SQLAlchemyAnimaAggregateUnitOfWork(session),
            receipts=SQLAlchemyAnimaCreationRepository(session),
            sources=AnimaCreationSources(
                catalog=SQLAlchemyContentCatalog(session), store=self.store(), max_identity_bytes=max_identity_bytes
            ),
            default_model_provider_id=self.provider,
        )

    def request(
        self, *, key: str = "creation-key", avatar: str = "local-avatar", actions: bool = False
    ) -> CreateAnimaRequest:
        roots = [self.items[avatar]]
        reactions: dict[str, dict[str, dict[str, str] | None]] = {
            emotion: {str(level): None for level in (1, 2, 3)} for emotion in TRACKED_EMOTIONS
        }
        gestures = []
        if actions:
            roots.extend([self.items["gesture"], self.items["reaction"]])
            gestures = [{"semantic_key": "wave", "source": item_ref(self.items["gesture"])}]
            # Reuse one source in two non-hint cells to prove unrestricted placement.
            reactions["sadness"]["3"] = item_ref(self.items["reaction"])
            reactions["joy"]["1"] = item_ref(self.items["reaction"])
        return CreateAnimaRequest.model_validate(
            {
                "schema_version": 1,
                "display_name": "  Test  Companion  ",
                "identity_markdown": "# Test\r\n\r\nKeep two spaces.  \r\n",
                "avatar": item_ref(roots[0]),
                "appearance": {"profile": None, "background": None},
                "gestures": gestures,
                "reactions": reactions,
                "starter_pack": starter_pack_identity(),
                "expected_source_revisions": {
                    item.id: {"kind": item.kind.value, "revision_sha256": item.revision_sha256} for item in roots
                },
                "idempotency_key": key,
            }
        )

    def app(self, session, monkeypatch) -> FastAPI:
        monkeypatch.setattr(settings, "anima_default_model_provider_id", self.provider)
        app = FastAPI()
        app.state.local_runtime_paths = self.paths
        app.include_router(anima_creation.router)
        app.include_router(chat_turns.router)
        app.include_router(loadouts.router)
        app.include_router(typed_content.router)

        async def user():
            return RequestPrincipal(id=self.owner)

        async def database():
            yield session

        app.dependency_overrides[get_current_principal] = user
        app.dependency_overrides[get_async_session] = database
        install_local_ports(app, session)
        return app


@asynccontextmanager
async def anima_creation_fixture(
    session, tmp_path: Path, *, full_starter: bool = False, mounted_included: bool = False
):
    owner = f"private-{uuid4().hex}"
    provider = f"test:{uuid4().hex}"
    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    write_json(paths.included_root / "licenses/inventory.json", {"rules": [{"glob": "**/*", "license_id": "test"}]})
    for name in ("AvatarSample_A_1_New", "AvatarSample_Y_0"):
        write_file(paths.included_root / f"avatars/{name}.vrm", vrm(name))
    write_file(paths.local_root / "avatars/local-avatar.vrm", vrm(owner))
    write_file(paths.local_root / "appearances/picture.png", image_bytes())
    write_json(
        paths.included_root / "idle-styles/starter/starter.json",
        {
            "schema_version": 1,
            "content_type": "idle_style",
            "content_id": "builtin:idle-style:starter",
            "name": "Starter Idle",
            "animations": [{"animation_id": "calm", "name": "Calm", "file_ref": "calm.vrma"}],
            "files": [{"path": "calm.vrma", "role": "animation"}],
            "default_pool": ["calm"],
            "emotion_pools": {},
            "compatibility": {"vrm_versions": ["0.x", "1.0"]},
        },
    )
    write_file(paths.included_root / "idle-styles/starter/calm.vrma", vrma())
    for kind, name in (("gesture", "wave"), ("reaction", "joy-2")):
        document: dict[str, Any] = {
            "schema_version": 1,
            "content_type": kind,
            "content_id": f"local:{kind}:{name}",
            "name": name,
            "implementation": {"kind": "vrma", "file_role": "animation"},
            "files": [{"path": "motion.vrma", "role": "animation"}],
        }
        if kind == "gesture":
            document["semantic_key"] = name
        else:
            document["placement_hint"] = {"emotion": "joy", "intensity": 2}
        write_json(paths.local_root / f"{kind}s/{name}/{name}.meta.json", document)
        write_file(paths.local_root / f"{kind}s/{name}/motion.vrma", vrma())
    if full_starter:
        policy = starter_loadout_policy()
        for kind, choices in (("gesture", policy["gestures"]), ("reaction", policy["reactions"])):
            for choice in choices:
                name = choice["content_id"].rsplit(":", 1)[-1]
                document = {
                    "schema_version": 1,
                    "content_type": kind,
                    "content_id": choice["content_id"],
                    "name": name,
                    "implementation": {"kind": "vrma", "file_role": "animation"},
                    "files": [{"path": "motion.vrma", "role": "animation"}],
                }
                document.update(
                    {"semantic_key": name}
                    if kind == "gesture"
                    else {"placement_hint": {"emotion": choice["emotion"], "intensity": choice["intensity"]}}
                )
                write_json(paths.included_root / f"{kind}s/{name}/{name}.meta.json", document)
                write_file(paths.included_root / f"{kind}s/{name}/motion.vrma", vrma())
    session.add_all(
        [
            ORMModelProvider(
                id=provider,
                provider_type="test",
                model=provider,
                active=True,
                model_label="Fixture",
                provider_label="Fixture",
            ),
        ]
    )
    await session.commit()
    if mounted_included:
        # The same fixture bytes exercise the desktop source selector; no real
        # starter assets or distribution permissions are required by this test.
        paths = replace(paths, included_sources=(IncludedContentSource("core", "fixture-v1", paths.included_root),))
    fixture = AnimaCreationFixture(owner, provider, paths, {})
    fixture.owners.add(owner)
    catalog = SQLAlchemyContentCatalog(session)
    content = ContentCatalogService(catalog=catalog, store=fixture.store())
    result = await content.rescan(user_id=owner)
    bad = [item for item in result.items if item.status.value != "valid"]
    assert not bad, [(item.relative_locator, item.diagnostics) for item in bad]
    by_path = {item.relative_locator: item for item in result.items}
    fixture.items = {
        "local-avatar": by_path["avatars/local-avatar.vrm"],
        "included-avatar": by_path["avatars/AvatarSample_A_1_New.vrm"],
        "idle": by_path["idle-styles/starter"],
        "gesture": by_path["gestures/wave"],
        "reaction": by_path["reactions/joy-2"],
        "image": by_path["appearances/picture.png"],
    }
    try:
        yield fixture
    finally:
        await session.rollback()
        ids = list(
            await session.scalars(
                select(ORMContentCatalogItem.id).where(
                    (ORMContentCatalogItem.owner_user_id.in_(fixture.owners))
                    | (
                        ORMContentCatalogItem.id.in_(
                            [item.id for item in result.items] + list(fixture.extra_catalog_ids)
                        )
                    )
                )
            )
        )
        avatar_ids = list(await session.scalars(select(ORMAvatar.id).where(ORMAvatar.catalog_item_id.in_(ids))))
        avatar_ids.extend(fixture.extra_avatar_ids)
        await session.execute(
            delete(ORMAnima).where((ORMAnima.user_id.in_(fixture.owners)) | ORMAnima.avatar_id.in_(avatar_ids))
        )
        await session.execute(delete(ORMAvatar).where(ORMAvatar.id.in_(avatar_ids)))
        await session.execute(delete(ORMMemoryEntryVersion).where(ORMMemoryEntryVersion.user_id.in_(fixture.owners)))
        await session.execute(delete(ORMMemoryEntry).where(ORMMemoryEntry.user_id.in_(fixture.owners)))
        await session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id.in_(ids)))
        await session.execute(delete(ORMModelProvider).where(ORMModelProvider.id == provider))
        await session.commit()


# The five Starter Poses plus the Gesture poses promoted to Included content (#337).
INCLUDED_POSE_IDS = frozenset(
    {
        "arms-crossed",
        "cat-monster-rawr",
        "cat-monster-rawr-2",
        "cheeky-finger-guns",
        "cheeky-finger-guns-2",
        "double-peace-sign",
        "double-thumbs-down",
        "double-thumbs-up",
        "hands-on-hips",
        "heart-hands",
        "left-ok-sign",
        "left-peace-sign",
        "meme-dab",
        "relaxedRest",
        "right-face-palm",
        "right-finger-point",
        "right-thumbs-down",
        "right-thumbs-up",
        "shy-finger-poke-1",
        "shy-finger-poke-2",
        "single-hand-on-heart",
        "soldier-salute",
        "soldier-salute-2",
        "thinking-hand-on-chin",
        "thinking-head-scratch-1",
        "thinking-head-scratch-2",
    }
)

# Shipped starter identities; optional Local Mixamo motions are not defaults.
# Keep this independent of the loaded policy so accidental policy changes cannot
# rewrite the test oracle.
EXPECTED_STARTER_GESTURE_IDS = (
    "builtin:gesture:shy-finger-poke-loop",
    "builtin:gesture:thinking-head-scratch",
    "builtin:gesture:thinking-hand-on-chin-hold",
    "builtin:gesture:right-thumbs-up",
    "builtin:gesture:right-thumbs-down",
    "builtin:gesture:right-finger-point",
    "builtin:gesture:left-peace-sign",
    "builtin:gesture:left-ok-sign",
    "builtin:gesture:hands-on-hips",
    "builtin:gesture:arms-crossed",
    "builtin:gesture:double-thumbs-down",
    "builtin:gesture:double-thumbs-up",
    "builtin:gesture:right-face-palm",
    "builtin:gesture:finger-heart-pose",
    "builtin:gesture:double-peace-pop",
    "builtin:gesture:heart-hands-build",
    "builtin:gesture:soldier-salute",
    "builtin:gesture:cheeky-finger-guns",
    "builtin:gesture:cat-monster-rawr",
    "builtin:gesture:single-hand-on-heart",
    "builtin:gesture:explain-open-palms",
    "builtin:gesture:goodbye-wave",
    "builtin:gesture:tear-wipe",
    "builtin:gesture:apology-bow",
    "builtin:gesture:prayer-hands-thanks",
    "builtin:gesture:air-quotes",
    "builtin:gesture:attentive-lean-in",
    "builtin:gesture:beckon",
    "builtin:gesture:big-circle-maru",
    "builtin:gesture:big-x-batsu",
    "builtin:gesture:blow-a-kiss",
    "builtin:gesture:blow-a-kiss-2",
    "builtin:gesture:cat-paws-nya",
    "builtin:gesture:celebration",
    "builtin:gesture:chefs-kiss",
    "builtin:gesture:count-on-fingers",
    "builtin:gesture:cover-face-and-peek",
    "builtin:gesture:cower",
    "builtin:gesture:deflated-sigh",
    "builtin:gesture:drumroll",
    "builtin:gesture:emphasise-a-point",
    "builtin:gesture:enthusiastic-yes",
    "builtin:gesture:ew-recoil",
    "builtin:gesture:excited-triple-clap",
    "builtin:gesture:fighting-fist-pump",
    "builtin:gesture:fingers-crossed",
    "builtin:gesture:fist-bump",
    "builtin:gesture:flex",
    "builtin:gesture:flustered-fan",
    "builtin:gesture:gentle-double-nod",
    "builtin:gesture:gentle-head-shake",
    "builtin:gesture:grr-fists",
    "builtin:gesture:hand-to-ear",
    "builtin:gesture:have-an-idea",
    "builtin:gesture:head-pat",
    "builtin:gesture:hearty-laugh",
    "builtin:gesture:high-five",
    "builtin:gesture:hysterical-laughter",
    "builtin:gesture:kyaa-hands-on-cheeks",
    "builtin:gesture:medium-laugh",
    "builtin:gesture:meme-dab",
    "builtin:gesture:mild-laugh",
    "builtin:gesture:mind-blown",
    "builtin:gesture:nervous-head-scratch",
    "builtin:gesture:ohohoho-noble-laugh",
    "builtin:gesture:on-one-hand",
    "builtin:gesture:palms-up-shrug",
    "builtin:gesture:peace-over-eye",
    "builtin:gesture:phew-brow-wipe",
    "builtin:gesture:pinky-promise",
    "builtin:gesture:please-hands",
    "builtin:gesture:polite-bow",
    "builtin:gesture:pon-realization",
    "builtin:gesture:pout-huff",
    "builtin:gesture:presenting",
    "builtin:gesture:scheming-hands",
    "builtin:gesture:shh",
    "builtin:gesture:shy-giggle",
    "builtin:gesture:small-shy-wave",
    "builtin:gesture:smug-heh",
    "builtin:gesture:so-so-wobble",
    "builtin:gesture:soul-leaves-body",
    "builtin:gesture:stretch-break",
    "builtin:gesture:surprise-gasp",
    "builtin:gesture:tehepero",
    "builtin:gesture:thinking-chin-rest",
    "builtin:gesture:this-big",
    "builtin:gesture:tiny-bit",
    "builtin:gesture:tongue-out-bleh",
    "builtin:gesture:typing-away",
    "builtin:gesture:virtual-hug",
    "builtin:gesture:wait-stop-palm",
    "builtin:gesture:wave-hello",
    "builtin:gesture:who-me",
    "builtin:gesture:zip-lips",
)


def copy_tracked_included(destination: Path) -> Path:
    """Copy only public tracked inputs, excluding a maintainer's private assets."""

    repo = Path(__file__).resolve().parents[1]
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--", "content/included"], cwd=repo)
    for name in filter(None, tracked.decode().split("\0")):
        target = destination / Path(name).relative_to("content/included")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repo / name, target)
    return destination


def write_supplied_animation_fixture(root: Path) -> Path:
    """Keep tracked descriptors and supply original structural animation fixtures.

    Catalog tests exercise the reviewed descriptors without private motion bytes.
    Production license exclusions remain intact; this is not a distributable pack
    or evidence of real user-supplied animation playback.
    """

    copy_tracked_included(root)
    for descriptor in sorted(root.rglob("*.json")):
        document = json.loads(descriptor.read_text())
        if not isinstance(document, dict):
            continue
        for item in document.get("files", []):
            relative = item.get("path", "")
            if not relative.endswith(".vrma"):
                continue
            target = descriptor.parent / relative
            assert target.resolve().is_relative_to(root.resolve())
            if not target.exists():
                write_file(target, vrma())
    return root


def write_supplied_starter_fixture(root: Path) -> Path:
    """Generate contract-only assets; no Mixamo bytes or real playback claim.

    These tiny original VRM/VRMA structures model a supplied, licensed content
    library. They do not implement the deferred acquisition/conversion workflow.
    """

    write_json(
        root / "licenses/inventory.json",
        {
            "rules": [
                {
                    "glob": "voices/*",
                    "license_id": "fixture-only",
                    "provenance": "Generated test audio",
                    "distribution": "excluded",
                },
                {
                    "glob": "**/*",
                    "license_id": "fixture-only",
                    "provenance": "Original generated Animama test structures",
                },
            ]
        },
    )
    for name in ("AvatarSample_A_1_New", "AvatarSample_Y_0"):
        write_file(root / f"avatars/{name}.vrm", vrm(name))
        portrait = root / f"appearances/avatar-portraits/{name}"
        write_file(portrait.with_suffix(".webp"), image_bytes(portrait=True, format="WEBP"))
        write_json(
            portrait.with_suffix(".meta.json"),
            {
                "content_id": f"builtin:avatar-portrait:{name}",
                "name": f"{name} test portrait",
                "avatar_model": name,
                "width": 512,
                "height": 512,
                "renderer_version": 1,
                "capture_preset_version": 2,
            },
        )
    policy = starter_loadout_policy()
    for kind, choices in (("gesture", policy["gestures"]), ("reaction", policy["reactions"])):
        for choice in choices:
            name = choice["content_id"].rsplit(":", 1)[-1]
            document = {
                "schema_version": 1,
                "content_type": kind,
                "content_id": choice["content_id"],
                "name": name,
                "implementation": {"kind": "vrma", "file_role": "animation"},
                "files": [{"path": "motion.vrma", "role": "animation"}],
            }
            document.update(
                {"semantic_key": name}
                if kind == "gesture"
                else {
                    "placement_hint": {"emotion": choice["emotion"], "intensity": choice["intensity"]},
                }
            )
            write_json(root / f"{kind}s/{name}/{name}.meta.json", document)
            write_file(root / f"{kind}s/{name}/motion.vrma", vrma())
    return root
