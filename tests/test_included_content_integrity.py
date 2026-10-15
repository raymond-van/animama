from __future__ import annotations

import json
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

from animama.app.services.starter_idle_pool import starter_idle_keys, starter_idle_pool
from tests.anima_creation_service_support import copy_tracked_included

ROOT = Path(__file__).parents[1]


def test_included_license_inventory_records_the_release_gate() -> None:
    inventory = json.loads((ROOT / "content/included/licenses/inventory.json").read_text(encoding="utf-8"))

    assert inventory["schema_version"] == 1
    rules = inventory["rules"]
    assert rules
    assert all(rule["creator"] for rule in rules)
    assert all(rule["license_id"] for rule in rules)
    assert all(rule["redistribution_review"] == "pending" for rule in rules)
    assert rules[-1]["glob"] == "**/*"
    assert rules[-1]["creator"] == "Animama project owner"
    by_glob = {rule["glob"]: rule for rule in rules}
    assert by_glob["poses/**/*.json"]["license_id"] == "LicenseRef-Animama-owner-authored"
    assert by_glob["gestures/**/*.json"]["license_id"] == "LicenseRef-Animama-owner-authored"
    # Mixamo motion ships only as the separate non-portable pack (see below).
    assert not any(rule["license_id"] == "LicenseRef-Adobe-Mixamo-embedded-product" for rule in rules)
    # The Scene creator's built-in sticker set and the Scene PNG art are owner-authored;
    # no third-party emoji art remains.
    assert by_glob["resources/scene-vfx/stickers/**"]["license_id"] == "LicenseRef-Animama-owner-authored"
    assert by_glob["vfx/scene/**/*.png"]["license_id"] == "LicenseRef-Animama-owner-authored"
    assert not any("emoji" in rule["glob"] or "twemoji" in rule["provenance"].lower() for rule in rules)
    # Each Particle Effect has its own rule. Keep the existing owner-authored
    # terms separate from the agent-authored effects and their reused texture provenance.
    agent_authored_particles = {
        "butterfly-flutter",
        "musical-cascade",
        "snow-crystal-flurry",
        # Reaction pools (#569).
        "buzzing-flies",
        "cold-breeze",
        "dizzy-stars",
        "drifting-leaves",
        "flower-pop",
        "fright-jolt",
        "golden-aura",
        "petal-drift",
        "rage-embers",
        "sparkle-bubbles",
        "sweat-spray",
        # Content Library expansion, including the replaced Heart stream.
        "aroma-ribbons",
        "cheer-streamers",
        "electric-crackle",
        "energy-wave-charge",
        "hearts-v1",
        "overheat-steam",
        "spit-spray-mist",
        "ta-da-glitter",
    }
    particle_rules = [
        rule for rule in rules if rule["glob"].startswith("vfx/particle/quark/") and rule["glob"].endswith("/**")
    ]
    for stem in sorted(path.name for path in (ROOT / "content/included/vfx/particle/quark").iterdir()):
        rule = by_glob[f"vfx/particle/quark/{stem}/**"]
        if stem in agent_authored_particles:
            expected = "LicenseRef-Animama-agent-authored"
        else:
            expected = "LicenseRef-Animama-owner-authored"
        assert rule["license_id"] == expected, stem
    assert len(particle_rules) == len(list((ROOT / "content/included/vfx/particle/quark").iterdir()))
    # Copied creator textures retain their approved source terms ahead of each
    # effect-wide rule; they are not additional Particle Effects.
    reused_texture_terms = {
        **dict.fromkeys(
            (
                "aroma-ribbons/textures/aroma-ribbons-glint.png",
                "cheer-streamers/textures/cheer-star-glint.png",
                "cheer-streamers/textures/cheer-soft-haze.png",
                "electric-crackle/textures/soft-haze.png",
                "hearts-v1/textures/soft-haze.png",
                "hearts-v1/textures/star-glint.png",
                "musical-cascade/textures/soft-haze.png",
                "musical-cascade/textures/star-glint.png",
                "overheat-steam/textures/overheat-steam-glint.png",
            ),
            "LicenseRef-Animama-owner-authored",
        ),
        **dict.fromkeys(
            (
                "energy-wave-charge/textures/glow-soft.png",
                "energy-wave-charge/textures/glow-sharp.png",
                "energy-wave-charge/textures/shock-ring.png",
                "energy-wave-charge/textures/soft-dot.png",
            ),
            "LicenseRef-Animama-generated-and-CC0-particle-VFX",
        ),
    }
    assert {
        rule["glob"].removeprefix("vfx/particle/quark/"): rule["license_id"]
        for rule in rules
        if rule["glob"].startswith("vfx/particle/quark/") and not rule["glob"].endswith("/**")
    } == reused_texture_terms


@pytest.mark.parametrize(
    ("pack_id", "license_id"),
    [
        ("mixamo-motion", "LicenseRef-Adobe-Mixamo-embedded-product"),
        ("wow-comedy-sfx", "LicenseRef-WOW-Sound-Media-embedded-product"),
    ],
)
def test_private_pack_inventories_are_public_safe_and_non_portable(pack_id: str, license_id: str) -> None:
    inventory = json.loads((ROOT / f"scripts/{pack_id}/inventory.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / f"src/backend/animama/resources/{pack_id}-manifest.json").read_text(encoding="utf-8"))

    assert inventory["schema_version"] == 1
    [rule] = inventory["rules"]
    # One rule matching every locator and file, so runtime and staging agree.
    assert rule["glob"] == "**"
    assert rule["distribution"] == "non-portable"
    assert rule["license_id"] == license_id
    assert rule["redistribution_review"] == "pending"
    text = json.dumps(inventory)
    assert "@" not in text and "/Users/" not in text and "X-Amz" not in text
    assert manifest["pack_id"] == pack_id
    assert all(set(item) == {"path", "size_bytes", "sha256"} for item in manifest["files"])


# Public sources of the Mixamo pack's identities: its folder IDs (also its
# content-ID suffixes), the Selector IDs its descriptor templates started from,
# and the renames recorded in docs/plans/mixamo-built-in-motion (v1 `dance`,
# `yawn`, `quick_shrug`; v2 idle loops without the `mixamo-idle-` prefix). The
# other pack v2 renames are private, so new names are also checked by hand
# before promotion.
PACK_IDENTITY_SOURCES = (
    "src/backend/animama/resources/mixamo-motion-manifest.json",
    "scripts/mixamo-assets.json",
)
DOCUMENTED_PACK_RENAMES = {"dance", "yawn", "quick_shrug"}
# Core Palms Up Shrug kept `shrug`; the pack's clip became `quick_shrug` (#242).
ACCEPTED_PACK_OVERLAPS = {("palms-up-shrug", "shrug")}


def _identity(value: str) -> str:
    """Compare snake_case Selector IDs with kebab-case content-ID suffixes."""
    return value.replace("-", "_")


def _mixamo_pack_identities() -> set[str]:
    manifest = json.loads((ROOT / PACK_IDENTITY_SOURCES[0]).read_text(encoding="utf-8"))
    folders = {Path(entry["path"]).parts[1] for entry in manifest["files"] if entry["path"].startswith("gestures/")}
    idle_loops = {folder.removeprefix("mixamo-idle-") for folder in folders if folder.startswith("mixamo-idle-")}
    templates = json.loads((ROOT / PACK_IDENTITY_SOURCES[1]).read_text(encoding="utf-8"))
    keys = {asset["document"]["semantic_key"] for asset in templates["assets"]}
    renames = DOCUMENTED_PACK_RENAMES | {f"idle_{loop}" for loop in idle_loops}
    return {_identity(value) for value in folders | keys | renames}


def _pack_collisions(metas: list[dict[str, Any]], pack: set[str]) -> list[tuple[str, str]]:
    """Core Gestures whose Selector ID or content-ID suffix is also a pack identity."""
    collisions = []
    for meta in metas:
        folder = meta["content_id"].rsplit(":", 1)[-1]
        for value in sorted({meta["semantic_key"], folder}):
            if _identity(value) in pack and (folder, value) not in ACCEPTED_PACK_OVERLAPS:
                collisions.append((folder, value))
    return collisions


def test_core_gesture_identities_stay_distinct_from_the_mixamo_pack() -> None:
    pack = _mixamo_pack_identities()
    assert {"crying", "wave", "telling_secret", "yawn", "idle_bored"} <= pack
    metas = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((ROOT / "content/included/gestures").glob("*/*.meta.json"))
    ]
    assert len(metas) >= 133
    assert _pack_collisions(metas, pack) == []
    assert _pack_collisions([{"content_id": "builtin:gesture:goodbye-wave", "semantic_key": "wave"}], pack) == [
        ("goodbye-wave", "wave")
    ]


def test_the_preview_deny_list_holds_hashes_only() -> None:
    deny = json.loads(
        (ROOT / "src/backend/animama/resources/wow-comedy-sfx-preview-deny.json").read_text(encoding="utf-8")
    )

    assert deny["schema_version"] == 1
    assert deny["files"]
    assert all(set(item) == {"size_bytes", "sha256"} for item in deny["files"])


def test_typed_media_moved_but_browser_engine_assets_remained_public(tmp_path: Path) -> None:
    public = ROOT / "src/frontend/web/public"

    included = copy_tracked_included(tmp_path / "included")
    assert (included / "avatars/AvatarSample_A_1_New.vrm").is_file()
    assert not (included / "gestures/wave/wave.vrma").exists()
    assert not (included / "gestures/wave/wave.meta.json").exists()
    assert (ROOT / "scripts/mixamo-assets.json").is_file()
    assert not any((public / "vrm").glob("*.vrm"))
    assert not any((public / "vrm").glob("animations/*.vrma"))
    # Large ONNX inputs are external/dependency-backed; keep the reviewed manifest.
    assert (ROOT / "models/browser-runtime/manifest.json").is_file()
    assert (public / "basis").is_dir()


def test_included_tree_contains_no_symlinks_or_special_files() -> None:
    for path in (ROOT / "content/included").rglob("*"):
        assert not path.is_symlink()
        assert path.is_dir() or path.is_file()


def _included_action_metas() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Each Included Reaction and Gesture as (meta, clip)."""
    actions = []
    for kind in ("reactions", "gestures"):
        for path in sorted((ROOT / "content/included" / kind).glob("*/*.meta.json")):
            meta = json.loads(path.read_text())
            sequence = next(file["path"] for file in meta["files"] if file["role"] == "sequence")
            actions.append((meta, json.loads((path.parent / sequence).read_text())))
    return actions


def test_no_included_action_plays_a_mouth_effect() -> None:
    """Mouth effects sit on the lip-synced mouth, so no Reaction or Gesture uses them."""
    mouth_effects = {"builtin:avatar-effect:mouth_w", "builtin:avatar-effect:mouth_hover_w"}
    users = [
        meta["content_id"]
        for meta, _clip in _included_action_metas()
        if mouth_effects & {dependency["ref"] for dependency in meta.get("dependencies", [])}
    ]
    assert users == []


def test_every_reaction_emotion_has_a_variant_with_an_avatar_effect() -> None:
    emotions: dict[str, bool] = {}
    for meta, clip in _included_action_metas():
        if meta["content_type"] != "reaction":
            continue
        emotion = meta["placement_hint"]["emotion"]
        effect_aliases = {
            dependency["alias"]
            for dependency in meta.get("dependencies", [])
            if dependency["content_type"] == "avatar_effect"
        }
        # An event must play the effect; a declared dependency alone does not count.
        has_effect = any(
            event["kind"] == "avatar_vfx" and event["effectId"] in effect_aliases for event in clip.get("events", [])
        )
        emotions[emotion] = emotions.get(emotion, False) or has_effect
    assert len(emotions) == 24
    assert [emotion for emotion, has_effect in emotions.items() if not has_effect] == []


def test_included_avatar_effect_sounds_are_optional_licensed_pack_sounds() -> None:
    """A built-in Avatar Effect's sounds come from the private comedy pack.

    Most effects have one; a merged effect declares each of its uses' sounds
    and names its own in ``soundAlias`` (ADR 0025); some are silent by owner
    choice (idle-only effects, and gags the owner preferred quiet, #409).
    Events that pick a sound name one the effect declares.
    """

    manifest = json.loads(
        (ROOT / "src/backend/animama/resources/wow-comedy-sfx-manifest.json").read_text(encoding="utf-8")
    )
    shipped = {item["path"] for item in manifest["files"]}
    effects = sorted((ROOT / "content/included/vfx/avatar").glob("*/*.json"))
    assert effects
    referenced: set[str] = set()
    declared: dict[str, set[str]] = {}
    for path in effects:
        document = json.loads(path.read_text(encoding="utf-8"))
        edges = document["dependencies"]
        aliases = {edge["alias"] for edge in edges}
        declared[document["content_id"]] = aliases
        if not edges:
            assert "soundAlias" not in document["definition"], path.name
            continue
        assert len(aliases) == len(edges), path.name
        assert document["definition"]["soundAlias"] in aliases, path.name
        for edge in edges:
            assert edge["content_type"] == "sound_effect" and edge["optional"] is True, path.name
            key = edge["ref"].removeprefix("builtin:sound-effect:")
            assert {f"sfx/wow-comedy/{key}.ogg", f"sfx/wow-comedy/{key}.meta.json"} <= shipped, path.name
            referenced.add(key)
    # Only sounds that built-in effects use are shipped (owner decision Q3).
    expected = {f"sfx/wow-comedy/{key}{suffix}" for key in referenced for suffix in (".ogg", ".meta.json")}
    assert shipped == expected

    for meta in sorted((ROOT / "content/included").glob("*/*/*.meta.json")):
        if meta.parts[-3] not in {"reactions", "gestures"}:
            continue
        descriptor = json.loads(meta.read_text(encoding="utf-8"))
        refs = {edge.get("alias"): edge["ref"] for edge in descriptor.get("dependencies", [])}
        clip = json.loads((meta.parent / meta.name.replace(".meta.json", ".json")).read_text(encoding="utf-8"))
        for event in clip.get("events", []) if isinstance(clip, dict) else []:
            alias = (event.get("override") or {}).get("soundAlias") if event.get("kind") == "avatar_vfx" else None
            if alias is not None:
                assert alias in declared[refs[event["effectId"]]], (meta.name, event["id"])


def test_stacked_avatar_effects_play_one_accompanying_sound_at_a_time() -> None:
    """Effects applied together would otherwise play their sounds over each other."""

    for path in sorted((ROOT / "content/included").glob("*/*/*.json")):
        if path.parts[-3] not in {"reactions", "gestures"}:
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        events = document.get("events") if isinstance(document, dict) else None
        if not isinstance(events, list):
            continue
        audible = sorted(
            float(event.get("time", 0))
            for event in events
            if event.get("kind") == "avatar_vfx" and event.get("playAccompanyingSound", True)
        )
        assert all(later - earlier >= 0.3 for earlier, later in pairwise(audible)), path.name


def test_starter_idle_gestures_play_no_accompanying_sound() -> None:
    """Idle Gestures play while the Anima is quiet, so their effects stay silent.

    The seed's Mixamo idles are event-free VRMA motion in the separate pack, so
    only the tracked Included clips carry events to check.
    """

    seed = starter_idle_pool()
    keys = set(starter_idle_keys(seed))
    checked = set()
    for key in sorted(keys):
        slug = key.removeprefix("builtin:gesture:")
        meta_path = ROOT / f"content/included/gestures/{slug}/{slug}.meta.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        sequence = next(file["path"] for file in meta["files"] if file["role"] == "sequence")
        clip = json.loads((meta_path.parent / sequence).read_text(encoding="utf-8"))
        for event in clip.get("events", []):
            assert event.get("kind") != "sfx", (slug, event.get("id"))
            if event.get("kind") == "avatar_vfx":
                assert event.get("playAccompanyingSound") is False, (slug, event.get("id"))
        checked.add(key)
    assert set(seed["default"]) <= checked
