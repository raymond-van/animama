from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from animama.app.services.content_kind_registry import (
    CONTENT_TYPE_HANDLERS,
    RuntimeProjectionInput,
    definition_for_kind,
    descriptor_filename,
    handler_for_kind,
)
from animama.domain.content_catalog import ContentKind
from animama.domain.content_documents import (
    ContentDocumentError,
    GestureDocumentV1,
    ReactionDocumentV1,
)


def test_idle_style_is_no_longer_a_content_kind_or_scanned_folder() -> None:
    """Idle motion is each Anima's own pool; old ``idle-styles/`` folders are not scanned."""
    assert "idle_style" not in {kind.value for kind in ContentKind}
    assert all(handler.definition.directory != "idle-styles" for handler in CONTENT_TYPE_HANDLERS.handlers)


def test_handler_registry_is_exhaustive_and_reserves_anima() -> None:
    assert {handler.kind for handler in CONTENT_TYPE_HANDLERS.handlers} == set(ContentKind)
    assert len(CONTENT_TYPE_HANDLERS.handlers) == len(ContentKind)

    with pytest.raises(ContentDocumentError, match="reserved for the Base Anima") as error:
        handler_for_kind(ContentKind.ANIMA).parse_document(
            {"schema_version": 1, "content_type": "anima", "name": "Future Anima"},
            fallback_path=Path("animas/future"),
            descriptor_backed=True,
        )
    assert error.value.code == "anima_descriptor_reserved"


def test_action_control_documents_do_not_take_the_primary_payload_name() -> None:
    assert descriptor_filename(definition_for_kind(ContentKind.GESTURE), "wave") == "wave.meta.json"
    assert descriptor_filename(definition_for_kind(ContentKind.REACTION), "happy") == "happy.meta.json"
    assert descriptor_filename(definition_for_kind(ContentKind.SCENE_EFFECT), "dark") == "dark.json"


def test_gesture_handler_derives_standalone_document_and_rejects_loose_fields() -> None:
    parsed = handler_for_kind(ContentKind.GESTURE).parse_document(
        None,
        fallback_path=Path("gestures/Friendly Wave.vrma"),
        descriptor_backed=False,
    )
    assert isinstance(parsed.document, GestureDocumentV1)
    assert parsed.document.name == "Friendly Wave"
    assert parsed.document.semantic_key == "friendly-wave"
    assert parsed.document.implementation.kind == "vrma"

    with pytest.raises(ContentDocumentError) as error:
        handler_for_kind(ContentKind.GESTURE).parse_document(
            {
                "schema_version": 1,
                "content_type": "gesture",
                "name": "Wave",
                "semantic_key": "wave",
                "surprise": True,
            },
            fallback_path=Path("gestures/wave"),
            descriptor_backed=True,
        )
    assert error.value.code == "unexpected_document_fields"


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        # The AI selection description is an Action's one text; a stale Library copy never wins.
        ({"description": "Old text.", "ai_description": "Edited text."}, "Edited text."),
        ({"description": "Legacy text."}, "Legacy text."),
        ({"description": "Legacy text.", "ai_description": ""}, "Legacy text."),
        ({"description": "Legacy text.", "ai_description": "   "}, "Legacy text."),
        ({"ai_description": "Only AI text."}, "Only AI text."),
    ],
)
def test_action_description_is_the_ai_description_with_a_legacy_fallback(fields: dict[str, str], expected: str) -> None:
    parsed = handler_for_kind(ContentKind.GESTURE).parse_document(
        {"schema_version": 1, "content_type": "gesture", "name": "Wave", "semantic_key": "wave", **fields},
        fallback_path=Path("gestures/wave"),
        descriptor_backed=True,
    )

    assert parsed.document.description == expected
    assert parsed.metadata.get("description") == expected


def test_reaction_handler_preserves_hint_and_requires_registered_runtime_media() -> None:
    parsed = handler_for_kind(ContentKind.REACTION).parse_document(
        {
            "schema_version": 1,
            "content_type": "reaction",
            "content_id": "local:reaction:happy",
            "name": "Happy",
            "placement_hint": {"emotion": "joy", "intensity": 2},
            "implementation": {"kind": "vrma", "file_role": "animation"},
            "files": [{"path": "happy.vrma", "role": "animation"}],
        },
        fallback_path=Path("reactions/happy"),
        descriptor_backed=True,
    )
    assert isinstance(parsed.document, ReactionDocumentV1)
    assert (parsed.document.emotion, parsed.document.intensity) == ("joy", 2)

    invalid = {
        "schema_version": 1,
        "content_type": "reaction",
        "name": "Remote Happy",
        "placement_hint": {"emotion": "joy", "intensity": 2},
        "implementation": {
            "kind": "vrma",
            "technical_source": {
                "type": "public_url",
                "url": "/vrm/animations/happy.vrma",
            },
        },
    }
    with pytest.raises(ContentDocumentError) as error:
        handler_for_kind(ContentKind.REACTION).parse_document(
            invalid,
            fallback_path=Path("reactions/remote-happy"),
            descriptor_backed=True,
        )
    assert error.value.code == "public_url_not_portable"


@pytest.mark.parametrize(
    "placement",
    [
        None,
        {},
        {"emotion": "joy"},
        {"intensity": 2},
        {"emotion": "unknown", "intensity": 2},
        {"emotion": "joy", "intensity": 0},
        {"emotion": "joy", "intensity": 5},
        {"emotion": "joy", "intensity": True},
        {"emotion": "joy", "intensity": 1.0},
    ],
)
def test_reaction_rejects_invalid_supplied_placement(placement: object) -> None:
    with pytest.raises(ContentDocumentError):
        handler_for_kind(ContentKind.REACTION).parse_document(
            {"schema_version": 1, "content_type": "reaction", "name": "Unplaced", "placement_hint": placement},
            fallback_path=Path("reactions/unplaced"),
            descriptor_backed=True,
        )


def test_reaction_without_hint_roundtrips_catalog_package_and_preview() -> None:
    handler = handler_for_kind(ContentKind.REACTION)
    descriptor = {
        "schema_version": 1,
        "content_type": "reaction",
        "name": "Unplaced",
        "implementation": {"kind": "anima_clip", "file_role": "sequence"},
    }
    parsed = handler.parse_document(descriptor, fallback_path=Path("reactions/unplaced"), descriptor_backed=True)
    assert isinstance(parsed.document, ReactionDocumentV1)
    assert (parsed.document.emotion, parsed.document.intensity) == (None, None)
    assert "placement_hint" not in parsed.metadata
    packaged = json.loads(
        handler.rewrite_package_document(json.dumps(descriptor).encode(), reference_rewrites={}, descriptor_backed=True)
    )
    assert "placement_hint" not in packaged
    projected = handler.project_runtime(
        parsed.document,
        RuntimeProjectionInput(
            item_id="reaction-item",
            runtime_root_id="reaction-root",
            slot_key="preview",
            source={"type": "catalog_item"},
            revision="revision-1",
            context={},
            files=[],
            logical_files={},
            dependency_files={},
            reference_map={},
        ),
    )
    assert projected.payload is not None
    assert projected.payload["emotion"] is None
    assert projected.payload["intensity"] is None


@pytest.mark.parametrize("hint", [None, {"emotion": "joy", "intensity": 4}])
def test_reaction_runtime_projection_reports_only_the_document_hint(hint: dict[str, Any] | None) -> None:
    """A pooled Reaction may play in many cells; its slot names the item, and the runtime pools name the cells."""

    handler = handler_for_kind(ContentKind.REACTION)
    parsed = handler.parse_document(
        {
            "schema_version": 1,
            "content_type": "reaction",
            "name": "Strong Joy",
            **({"placement_hint": hint} if hint else {}),
            "implementation": {"kind": "anima_clip", "file_role": "sequence"},
        },
        fallback_path=Path("reactions/strong-joy"),
        descriptor_backed=True,
    )

    projected = handler.project_runtime(
        parsed.document,
        RuntimeProjectionInput(
            item_id="reaction-item",
            runtime_root_id="reaction-root",
            slot_key="reaction:reaction-item",
            source={"type": "catalog_item"},
            revision="revision-1",
            context={"binding_id": "reaction:reaction-item", "reaction_cells": ["sadness-1"]},
            files=[],
            logical_files={},
            dependency_files={},
            reference_map={},
        ),
    )

    assert projected.lane == "reaction"
    assert projected.payload is not None
    assert projected.payload["binding_id"] == "reaction:reaction-item"
    assert (projected.payload["emotion"], projected.payload["intensity"]) == (
        (hint["emotion"], hint["intensity"]) if hint else (None, None)
    )


def test_dependency_declaration_and_resolved_kind_must_agree() -> None:
    handler = handler_for_kind(ContentKind.GESTURE)
    parsed = handler.parse_document(
        {
            "schema_version": 1,
            "content_type": "gesture",
            "name": "Sparkle Wave",
            "semantic_key": "sparkle-wave",
            "dependencies": [
                {
                    "ref": "builtin:particle-effect:sparkle",
                    "content_type": "particle_effect",
                    "alias": "sparkle",
                }
            ],
        },
        fallback_path=Path("gestures/sparkle-wave"),
        descriptor_backed=True,
    )
    diagnostics = handler.validate_resolved_dependencies([(parsed.document.dependencies[0], ContentKind.SOUND_EFFECT)])
    assert [diagnostic.code for diagnostic in diagnostics] == ["dependency_kind_mismatch"]


def test_directory_and_descriptor_discriminators_cannot_disagree() -> None:
    with pytest.raises(ContentDocumentError) as error:
        handler_for_kind(ContentKind.GESTURE).parse_document(
            {"schema_version": 1, "content_type": "reaction", "name": "Wrong"},
            fallback_path=Path("gestures/wrong"),
            descriptor_backed=True,
        )
    assert error.value.code == "content_kind_mismatch"


def test_runtime_catalog_is_not_a_portable_typed_media_source() -> None:
    with pytest.raises(ContentDocumentError) as error:
        handler_for_kind(ContentKind.AVATAR_EFFECT).parse_document(
            {
                "schema_version": 1,
                "content_type": "avatar_effect",
                "name": "Legacy Star",
                "technical_source": {
                    "type": "runtime_catalog",
                    "catalog": "avatar_vfx",
                    "key": "star",
                },
            },
            fallback_path=Path("vfx/avatar/legacy-star"),
            descriptor_backed=True,
        )
    assert error.value.code == "runtime_catalog_not_portable"


def test_included_typed_documents_do_not_embed_browser_delivery_aliases() -> None:
    included = Path(__file__).resolve().parents[1] / "content" / "included"
    forbidden = ('"public_url"', '"runtime_catalog"', '"assetPath": "/', '"url": "/vrm')
    offenders = [
        path.relative_to(included).as_posix()
        for path in included.rglob("*.json")
        if any(value in path.read_text(encoding="utf-8") for value in forbidden)
    ]
    assert offenders == []


def _pose_descriptor() -> dict[str, Any]:
    """Resolved parser-compatible fixture, including partial bone transforms."""
    return {
        "schema_version": 1,
        "content_type": "pose",
        "content_id": "relaxedRest",
        "name": "Relaxed Rest",
        "pose": {
            "schema": "animaPose/1.0",
            "id": "relaxedRest",
            "name": "Relaxed Rest",
            "humanoid": {
                "hips": {"position": [0, 0.1, 0]},
                "leftUpperArm": {"rotation": [0, 0, 0, 1]},
            },
            "expressions": {"happy": 0.5, "customSmile": 1},
        },
    }


def test_pose_handler_admits_resolved_values_and_roundtrips_package_identity() -> None:
    from animama.domain.content_documents import PoseDocumentV1

    descriptor = _pose_descriptor()
    handler = handler_for_kind(ContentKind.POSE)
    parsed = handler.parse_document(descriptor, fallback_path=Path("poses/rest"), descriptor_backed=True)
    assert isinstance(parsed.document, PoseDocumentV1)
    assert parsed.document.pose == descriptor["pose"]
    assert parsed.dependencies == ()
    assert parsed.metadata["pose"] == descriptor["pose"]
    assert descriptor_filename(definition_for_kind(ContentKind.POSE), "rest") == "rest.json"
    packaged = json.loads(
        handler.rewrite_package_document(
            json.dumps(descriptor).encode(),
            reference_rewrites={"relaxedRest": "local:pose:rest-copy"},
            descriptor_backed=True,
        )
    )
    assert packaged["content_id"] == packaged["pose"]["id"] == "local:pose:rest-copy"
    assert packaged["pose"]["humanoid"] == descriptor["pose"]["humanoid"]


@pytest.mark.parametrize(
    "patch",
    [
        {"parent": {"ref": "relaxedRest"}},
        {"schema": "animaPose/2.0"},
        {"id": "different"},
        {"name": "Different"},
        {"script": "alert(1)"},
        {"rotationOrder": "XYZ"},
        {"humanoid": {"unknownBone": {}}},
        {"humanoid": {"hips": {"rotation": [0, 0, 0, 0]}}},
        {"humanoid": {"hips": {"rotation": [0, 0, 0, 2]}}},
        {"humanoid": {"hips": {"rotation": [0, 0, 1]}}},
        {"humanoid": {"hips": {"rotationEulerDegrees": [0, 0, 90]}}},
        {"humanoid": {"hips": {"position": [True, 0, 0]}}},
        {"humanoid": {"hips": {"position": [float("inf"), 0, 0]}}},
        {"humanoid": {"hips": {"position": [1e20, 0, 0]}}},
        {"expressions": {"happy": 1.1}},
        {"expressions": {"happy": -0.1}},
        {"expressions": {"happy": True}},
        {"expressions": {"": 0.5}},
    ],
)
def test_pose_handler_rejects_unresolved_or_invalid_payloads(patch: dict[str, Any]) -> None:
    descriptor = _pose_descriptor()
    descriptor["pose"].update(patch)
    with pytest.raises(ContentDocumentError):
        handler_for_kind(ContentKind.POSE).parse_document(
            descriptor,
            fallback_path=Path("poses/rest"),
            descriptor_backed=True,
        )


def test_pose_requires_descriptor_identity_and_has_no_dependencies_or_resource_files() -> None:
    for patch in (
        {"content_id": None},
        {"files": [{"path": "other.json", "role": "dependency"}]},
        {"dependencies": [{"ref": "relaxedRest", "content_type": "pose"}]},
    ):
        with pytest.raises(ContentDocumentError):
            handler_for_kind(ContentKind.POSE).parse_document(
                {**_pose_descriptor(), **patch},
                fallback_path=Path("poses/rest"),
                descriptor_backed=True,
            )


def test_pose_huge_json_integer_is_a_validation_error_not_an_overflow() -> None:
    descriptor = _pose_descriptor()
    descriptor["pose"]["humanoid"]["hips"]["position"] = [10**500, 0, 0]
    with pytest.raises(ContentDocumentError):
        handler_for_kind(ContentKind.POSE).parse_document(
            descriptor,
            fallback_path=Path("poses/rest"),
            descriptor_backed=True,
        )
