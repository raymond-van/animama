"""Closed compatibility requirements for local content packages.

These versions describe implemented renderers, not a sender's catalog snapshot.
The shared frontend fixtures exercise the real parsers and built-in registries.
Only data is admitted; resource references must name registered package files.
"""

from __future__ import annotations

import copy
import json
import math
import re
import struct
import xml.etree.ElementTree as ET
from collections.abc import Iterable, Mapping
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from pydantic import ValidationError

from animama.app.contracts.avatar_effect import (
    AVATAR_EFFECT_SCHEMA_V1,
    AVATAR_EFFECT_SCHEMA_V2,
    MAX_DEFINITION_BYTES as MAX_AVATAR_EFFECT_DEFINITION_BYTES,
    AvatarEffectDefinitionV2,
    project_avatar_effect_definition,
)
from animama.app.contracts.content_package import NON_PORTABLE_REFERENCES_CAPABILITY
from animama.app.contracts.scene_effect_limits import SCENE_EFFECT_LIMITS
from animama.app.services.effect_art_validation import emitter_grid_issue
from animama.domain.content_catalog import SCENE_EMOJI_ITEM_REMOVED, ContentDiagnostic, ContentKind
from animama.domain.content_documents import (
    AvatarEffectDocumentV1,
    ContentDocumentError,
    GestureDocumentV1,
    ParticleEffectDocumentV1,
    PoseDocumentV1,
    ReactionDocumentV1,
    SceneEffectDocumentV1,
    TypedContentDocument,
    VoiceDocumentV1,
)

from .avatar_effect_conversion import (
    CONVERSION_HINT,
    CONVERSION_REQUIRED as AVATAR_EFFECT_CONVERSION_REQUIRED,
    PACKAGE_CONVERSION_HINT,
    avatar_effect_validation_error,
)
from .avatar_effect_overrides import check_clip_effect_overrides
from .clip_format import (
    ANIMA_POSE_CLIP_SCHEMA,
    CLIP_FORMAT_UNSUPPORTED,
    RETIRED_ANIMA_POSE_CLIP_SCHEMA,
    unsupported_clip_format_message,
)
from .content_voice import POCKET_CLONE_CODEC, validate_pocket_clone_document
from .idle_clip_validation import validate_clip_v2_timeline
from .pocket_voice_catalog import MAX_POCKET_VOICE_CATALOG_BYTES, validate_pocket_voice_catalog_bytes

MAX_DEFINITION_BYTES = 16 * 1024 * 1024
# Included Poses a clip's ``basePose`` may name. Packages reference them as app
# primitives rather than bundling them; the frontend's package-capabilities
# fixture (``builtinPoses``) mirrors this set.
BUILTIN_POSES = frozenset(
    "arms-crossed cat-monster-rawr cat-monster-rawr-2 cheeky-finger-guns cheeky-finger-guns-2 "
    "double-peace-sign double-thumbs-down double-thumbs-up hands-on-hips heart-hands left-ok-sign "
    "left-peace-sign meme-dab relaxedRest right-face-palm right-finger-point right-thumbs-down "
    "right-thumbs-up shy-finger-poke-1 shy-finger-poke-2 single-hand-on-heart soldier-salute "
    "soldier-salute-2 thinking-hand-on-chin thinking-head-scratch-1 thinking-head-scratch-2".split()
)
SUPPORTED_CAPABILITIES = frozenset(
    {
        "animaPose/1.0",
        ANIMA_POSE_CLIP_SCHEMA,
        "VRM/0.0",
        "VRMC_vrm/1.0",
        "VRMC_vrm_animation/1.0",
        AVATAR_EFFECT_SCHEMA_V2,
        "animama/scene-effect/1",
        "animama/pocket-voice/1",
        "three.quarks/3.0",
        NON_PORTABLE_REFERENCES_CAPABILITY,
    }
    | {f"animama/builtin-pose/1/{name}" for name in BUILTIN_POSES}
)
# Packages from before the sticker set declared each Twemoji glyph they used.
_RETIRED_TWEMOJI_CAPABILITY = "animama/twemoji/"
_PARTICLE_TYPES = frozenset(
    "ConstantValue IntervalValue PiecewiseBezier ConstantColor ColorRange RandomColor RandomColorBetweenGradient "
    "Gradient CLinearFunction AxisAngle Euler RandomQuat ColorOverLife ForceOverLife FrameOverLife "
    "LimitSpeedOverLife Noise OrbitOverLife Rotation3DOverLife RotationOverLife SizeOverLife SpeedOverLife "
    "TurbulenceField WidthOverLength point sphere cone rectangle".split()
)
_PARTICLE_BEHAVIORS = frozenset(
    "ColorOverLife ForceOverLife FrameOverLife LimitSpeedOverLife Noise OrbitOverLife Rotation3DOverLife "
    "RotationOverLife SizeOverLife SpeedOverLife TurbulenceField WidthOverLength".split()
)
# glTF extensions a packaged VRM or VRMA may use or require. The web loaders
# register the VRM, VRMAnimation and lilToon plugins and the meshopt decoder on
# Three's GLTFLoader (``avatarGltfLoader.ts``). Packages also accept what
# converted and optimized Avatars carry: Mochiya Avatar Tools' extensions,
# Animama Avatar Converter's marker and both mesh compressions. The Draco decoder is not served yet, so the import
# review and the runtime report a Draco Avatar as not loadable
# (``avatar_extension_unsupported``) instead of the package refusing it. Basis
# textures stay out: no decoder. Adding a name needs no package capability; an
# older reader that lacks it rejects the package with
# ``package_definition_invalid``. The web runtime's loadable list plus
# ``UNDECODED_GLTF_EXTENSIONS`` is this list (pinned by the shared
# ``package-capabilities.json`` fixture).
_GLTF_EXTENSIONS = frozenset(
    "VRM VRMC_vrm VRMC_vrm_animation VRMC_springBone VRMC_springBone_extended_collider VRMC_materials_mtoon "
    "VRMC_node_constraint "
    "VRMC_materials_hdr_emissiveMultiplier KHR_lights_punctual KHR_materials_clearcoat KHR_materials_dispersion "
    "KHR_materials_ior KHR_materials_sheen KHR_materials_specular KHR_materials_transmission "
    "KHR_materials_iridescence KHR_materials_anisotropy KHR_materials_unlit KHR_materials_volume "
    "KHR_texture_transform KHR_mesh_quantization KHR_materials_emissive_strength EXT_materials_bump "
    "EXT_texture_webp EXT_texture_avif EXT_mesh_gpu_instancing "
    "MOCHIYA_avatar_composition MOCHIYA_materials_liltoon ANIMAMA_avatar_conversion EXT_meshopt_compression "
    "KHR_draco_mesh_compression".split()
)
# Accepted compression the runtime cannot decode yet (web
# ``UNDECODED_GLTF_EXTENSIONS``); three fails on it wherever it is used.
UNDECODED_GLTF_EXTENSIONS = frozenset({"KHR_draco_mesh_compression"})


def _require(condition: bool, message: str, path: str | None = None) -> None:
    """Reject package data; ``path`` names the offending JSON value when known."""
    if not condition:
        raise ContentDocumentError("package_definition_invalid", message, field=path)


def _child(path: str | None, key: str | int) -> str | None:
    """Extend a JSON path with an object key or array index."""
    if path is None:
        return None
    return f"{path}[{key}]" if isinstance(key, int) else f"{path}.{key}"


def _object(value: Any, field: str, *, path: str | None = None) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{field} must be an object", path)
    return dict(value)


def _array(value: Any, field: str, *, path: str | None = None) -> list[Any]:
    _require(isinstance(value, list), f"{field} must be an array", path)
    return list(value)


def _string(value: Any, field: str, *, path: str | None = None) -> str:
    _require(isinstance(value, str) and bool(value.strip()), f"{field} must be a nonempty string", path)
    return str(value)


def _enum(value: Any, allowed: Iterable[str], field: str, *, path: str | None = None) -> str:
    _require(isinstance(value, str) and value in allowed, f"Unsupported {field} primitive", path)
    return str(value)


def _fields(value: dict[str, Any], allowed: str, field: str, *, path: str | None = None) -> None:
    """Allow only the listed keys; the first unsupported key names the error path."""
    permitted = set(allowed.split())
    unsupported = next((key for key in value if key not in permitted), None)
    _require(unsupported is None, f"Unsupported {field} field: {unsupported}", _child(path, str(unsupported)))


def _number(value: Any, field: str, *, path: str | None = None) -> float:
    _require(type(value) in (float, int), f"{field} must be finite", path)
    try:
        number = float(value)
    except OverflowError as exc:
        raise ContentDocumentError("package_definition_invalid", f"{field} must be finite", field=path) from exc
    _require(math.isfinite(number), f"{field} must be finite", path)
    return number


def _numbers(value: dict[str, Any], fields: str, *, path: str | None = None) -> None:
    for field in fields.split():
        _number(value.get(field), field, path=_child(path, field))


def _booleans(value: dict[str, Any], fields: str, *, path: str | None = None) -> None:
    for field in fields.split():
        if field in value:
            _require(type(value[field]) is bool, f"{field} must be boolean", _child(path, field))


def _safe_data(value: Any, *, path: str | None = None) -> None:
    """Bound nested data and reject executable or external-resource escape hatches."""
    pending = [(value, 0, path)]
    count = 0
    while pending:
        item, depth, item_path = pending.pop()
        count += 1
        _require(depth <= 32 and count <= 100_000, "Package definition exceeds structural limits", path)
        if isinstance(item, dict):
            for key, child in item.items():
                child_path = _child(item_path, key)
                _require(
                    key.lower() not in {"script", "scripts", "code", "javascript", "vertexshader", "fragmentshader"},
                    "Executable package definitions are unsupported",
                    child_path,
                )
                if key.lower() in {"url", "uri", "src", "href", "assetpath"} and isinstance(child, str):
                    embedded = child.startswith(
                        (
                            "data:application/octet-stream;base64,",
                            "data:application/gltf-buffer;base64,",
                            "data:image/png;base64,",
                            "data:image/jpeg;base64,",
                            "data:image/webp;base64,",
                        )
                    )
                    _require(
                        embedded or not child.startswith(("/", "\\")) and ":" not in child and "\\" not in child,
                        "External package resources are unsupported",
                        child_path,
                    )
                pending.append((child, depth + 1, child_path))
        elif isinstance(item, list):
            pending.extend((child, depth + 1, _child(item_path, index)) for index, child in enumerate(item))
        elif type(item) in (int, float):
            _number(item, "Definition number", path=item_path)


def _resource(value: Any, document: TypedContentDocument, roles: set[str], *, path: str | None = None) -> None:
    name = _string(value, "Resource reference", path=path)
    _require(
        any(file.path == name and file.role in roles for file in document.files),
        "Resource reference must name a registered package file",
        path,
    )


def _sound(definition: dict[str, Any], document: TypedContentDocument, *, path: str | None = None) -> None:
    if "soundAlias" in definition:
        alias_path = _child(path, "soundAlias")
        alias = _string(definition["soundAlias"], "soundAlias", path=alias_path)
        _require(
            any(
                dep.kind is ContentKind.SOUND_EFFECT and (dep.alias or dep.ref) == alias
                for dep in document.dependencies
            ),
            "Sound alias must name a bundled Sound Effect dependency",
            alias_path,
        )


def validate_declared_capabilities(capabilities: Iterable[str]) -> None:
    """Reject unsupported or duplicate claims before archive extraction."""
    seen: set[str] = set()
    for capability in capabilities:
        if capability == AVATAR_EFFECT_SCHEMA_V1:
            # Name the conversion instead of a generic unavailable capability.
            raise ContentDocumentError(AVATAR_EFFECT_CONVERSION_REQUIRED, PACKAGE_CONVERSION_HINT)
        if capability == RETIRED_ANIMA_POSE_CLIP_SCHEMA:
            raise ContentDocumentError(CLIP_FORMAT_UNSUPPORTED, unsupported_clip_format_message(capability))
        if isinstance(capability, str) and capability.startswith(_RETIRED_TWEMOJI_CAPABILITY):
            raise ContentDocumentError(
                SCENE_EMOJI_ITEM_REMOVED,
                "This package uses Twemoji emoji in a Scene Effect, which Animama no longer provides. "
                "Replace or remove each emoji item in its creator, then export the package again",
            )
        if not isinstance(capability, str) or capability not in SUPPORTED_CAPABILITIES:
            raise ContentDocumentError("package_capability_unsupported", "Package requires an unavailable capability")
        if capability in seen:
            raise ContentDocumentError("package_capabilities_mismatch", "Package declares a duplicate capability")
        seen.add(capability)


def validate_capabilities(declared: Iterable[str], required: Iterable[str]) -> None:
    """Require an exact declaration of the capabilities derived from package data."""
    declarations = tuple(declared)
    requirements = frozenset(required)
    validate_declared_capabilities(declarations)
    validate_declared_capabilities(requirements)
    if frozenset(declarations) != requirements:
        raise ContentDocumentError("package_capabilities_mismatch", "Package capabilities do not match its content")


_AVATAR_EFFECT_PATH = "definition"


def _avatar_effect_model(definition: dict[str, Any]) -> AvatarEffectDefinitionV2:
    """Validate the ``/2`` shape, naming the first failing JSON path."""
    try:
        return AvatarEffectDefinitionV2.model_validate(definition)
    except ValidationError as exc:
        path, message = avatar_effect_validation_error(exc)
        raise ContentDocumentError("package_definition_invalid", f"{path}: {message}", field=path) from exc


def validate_avatar_effect_document(
    document: AvatarEffectDocumentV1, *, code: str = "package_definition_invalid"
) -> str:
    """Validate an ``animama/avatar-effect/2`` definition with the shared contract.

    Save, preview, package export and import share these rules. Failures raise
    ``ContentDocumentError(code, message, field=<JSON path>)``; the path starts
    at ``definition``. A ``/1`` definition raises
    ``avatar_effect_conversion_required`` with the conversion hint instead.
    Returns the definition schema capability.
    """
    schema = AVATAR_EFFECT_SCHEMA_V2
    schema_path = _child(_AVATAR_EFFECT_PATH, "schema")
    try:
        definition = _object(document.definition, "Effect definition", path=_AVATAR_EFFECT_PATH)
        if definition.get("schema") == AVATAR_EFFECT_SCHEMA_V1:
            raise ContentDocumentError(AVATAR_EFFECT_CONVERSION_REQUIRED, CONVERSION_HINT, field=schema_path)
        _safe_data(definition, path=_AVATAR_EFFECT_PATH)
        _require(
            len(json.dumps(definition, separators=(",", ":")).encode()) <= MAX_AVATAR_EFFECT_DEFINITION_BYTES,
            "Avatar Effect definition exceeds its size limit",
            _AVATAR_EFFECT_PATH,
        )
        _require(definition.get("schema") == schema, "Unsupported effect definition schema", schema_path)
        model = _avatar_effect_model(definition)
        art_path = _child(_AVATAR_EFFECT_PATH, "art")
        _resource(model.art.image, document, {"image", "texture"}, path=_child(art_path, "image"))
        if model.art.otherEyeImage is not None:
            _resource(model.art.otherEyeImage, document, {"image", "texture"}, path=_child(art_path, "otherEyeImage"))
        _sound(definition, document, path=_AVATAR_EFFECT_PATH)
    except ContentDocumentError as exc:
        if exc.code in {code, AVATAR_EFFECT_CONVERSION_REQUIRED}:
            raise
        raise ContentDocumentError(code, str(exc), field=exc.field) from exc
    return schema


_SCENE_DIRECTIONS = frozenset(
    {
        "static",
        "left",
        "right",
        "up",
        "down",
        "diagonal-up-left",
        "diagonal-down-left",
        "diagonal-up-right",
        "diagonal-down-right",
    }
)


def _scene_items(items: Any, document: TypedContentDocument, field: str, *, path: str | None = None) -> list[Any]:
    """Validate marquee or scatter items: each names a registered image.

    An ``emoji`` item (Twemoji, no longer provided) is refused by name.
    """
    values = _array(items, field, path=path)
    for index, raw in enumerate(values):
        item_path = _child(path, index)
        item = _object(raw, f"{field} item", path=item_path)
        if item.get("kind") == "emoji":
            # Named as a scan and Save name it (``marquee.items.0``).
            name = _dotted(item_path)
            raise ContentDocumentError(SCENE_EMOJI_ITEM_REMOVED, _emoji_item_message(item, name), field=name)
        _fields(item, "id kind label image", f"{field} item", path=item_path)
        _string(item.get("id"), f"{field} item id")
        _string(item.get("label"), f"{field} item label")
        _enum(item.get("kind"), {"image"}, f"{field} item")
        _resource(item.get("image"), document, {"image", "texture"}, path=_child(item_path, "image"))
    return values


def _dotted(path: str | None) -> str | None:
    """A JSON path in the dotted form the creator uses: ``scatters[0]`` -> ``scatters.0``."""
    return None if path is None else re.sub(r"\[(\d+)\]", r".\1", path)


def _emoji_item_message(item: dict[str, Any], field: str | None, *, scanned: bool = False) -> str:
    """Name an emoji item; a scan adds that the Scene still plays without it."""
    label = item.get("label")
    name = f" ({label})" if isinstance(label, str) and label.strip() else ""
    if scanned:
        return (
            f"Scene item {field}{name} is an emoji, which Animama no longer provides; it plays without it. "
            "Open the Scene Effect to replace it with a sticker or image, or remove it"
        )
    return (
        f"Scene item {field}{name} is an emoji, which Animama no longer provides; "
        "replace it with a sticker or image, or remove it"
    )


def scene_emoji_items(definition: Any) -> tuple[tuple[str, dict[str, Any]], ...]:
    """Each ``emoji`` marquee or scatter item, named by field (``marquee.items.0``).

    Reads defensively: a malformed definition has its own diagnostic.
    """
    if not isinstance(definition, dict):
        return ()
    lists: list[tuple[str, Any]] = []
    marquee = definition.get("marquee")
    if isinstance(marquee, dict):
        lists.append(("marquee.items", marquee.get("items")))
    scatters = definition.get("scatters")
    if isinstance(scatters, list):
        lists.extend(
            (f"scatters.{index}.items", layer.get("items"))
            for index, layer in enumerate(scatters)
            if isinstance(layer, dict)
        )
    return tuple(
        (f"{field}.{index}", item)
        for field, items in lists
        if isinstance(items, list)
        for index, item in enumerate(items)
        if isinstance(item, dict) and item.get("kind") == "emoji"
    )


def _without_emoji_items(definition: dict[str, Any]) -> tuple[dict[str, Any], frozenset[int]]:
    """The definition as it plays, its emoji items skipped, and the scatter layers they filled.

    A scatter layer of only emoji items stays, empty, so every layer keeps the
    index the creator and Save name it by; its item count is not checked.
    """
    playable = copy.deepcopy(definition)

    def playable_items(items: Any) -> Any:
        if not isinstance(items, list):
            return items
        return [item for item in items if not (isinstance(item, dict) and item.get("kind") == "emoji")]

    marquee = playable.get("marquee")
    if isinstance(marquee, dict):
        marquee["items"] = playable_items(marquee.get("items"))
    emptied: set[int] = set()
    scatters = playable.get("scatters")
    if isinstance(scatters, list):
        for index, layer in enumerate(scatters):
            if isinstance(layer, dict):
                items = playable_items(layer.get("items"))
                if items == [] and layer.get("items"):
                    emptied.add(index)
                layer["items"] = items
    return playable, frozenset(emptied)


_SCENE_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _scene_color(value: Any, field: str) -> None:
    """Scene colours are six-digit hex: anything else could reach CSS or SVG paint."""
    _require(isinstance(value, str) and bool(_SCENE_COLOR.fullmatch(value)), f"{field} must be a #rrggbb colour", field)


def _scene_flags(owner: dict[str, Any], fields: str, path: str) -> None:
    """Require booleans the runtime reads (absent ones would make the Scene unplayable)."""
    for field in fields.split():
        _require(type(owner.get(field)) is bool, f"{field} must be boolean", f"{path}.{field}")


def _scene_range(
    owner: dict[str, Any], key: str, limits: tuple[float, float], field: str, *, integer: bool = False
) -> None:
    """Require ``owner[key]`` inside an inclusive limit range (and whole, if asked)."""
    value = owner.get(key)
    minimum, maximum = limits
    _require(
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and minimum <= value <= maximum
        and (not integer or float(value).is_integer()),
        f"{field} must be between {minimum:g} and {maximum:g}{' in whole steps' if integer else ''}",
        field,
    )


def _scene_count(items: list[Any], limits: tuple[int, int], field: str) -> None:
    _require(limits[0] <= len(items) <= limits[1], f"{field} needs {limits[0]} to {limits[1]} entries", field)


def _scene_ordered(owner: dict[str, Any], low: str, high: str, field: str) -> None:
    _require(owner[low] <= owner[high], f"{field}: the minimum cannot exceed the maximum", field)


def _scene_background_layers(
    definition: dict[str, Any], document: TypedContentDocument, *, emoji_emptied_scatters: frozenset[int]
) -> None:
    """The optional background layers (C1-C6), with the shared limits.

    The creator checks the same ranges (``lib/scene-vfx/limits.ts``); both
    read ``SCENE_EFFECT_LIMITS``, kept equal by a parity fixture. A scatter
    layer in ``emoji_emptied_scatters`` lost all its (emoji) items, which are
    reported on their own, so its item count is not checked.
    """
    limits = SCENE_EFFECT_LIMITS
    seed = limits["seed"]
    if "gradient" in definition:
        gradient = _object(definition["gradient"], "gradient", path="gradient")
        _fields(gradient, "enabled type angleDeg centerX centerY stops", "gradient", path="gradient")
        _scene_flags(gradient, "enabled", "gradient")
        _enum(gradient.get("type"), {"linear", "radial"}, "gradient type")
        g = limits["gradient"]
        _scene_range(gradient, "angleDeg", g["angleDeg"], "gradient.angle")
        _scene_range(gradient, "centerX", g["center"], "gradient.centerX")
        _scene_range(gradient, "centerY", g["center"], "gradient.centerY")
        stops = _array(gradient.get("stops"), "gradient stops", path="gradient.stops")
        _scene_count(stops, g["stops"], "gradient.stops")
        positions: list[float] = []
        for index, raw in enumerate(stops):
            stop = _object(raw, "gradient stop", path=f"gradient.stops[{index}]")
            _fields(stop, "color position", "gradient stop")
            _scene_color(stop.get("color"), f"gradient.stops.{index}.color")
            _scene_range(stop, "position", g["position"], f"gradient.stops.{index}")
            positions.append(stop["position"])
        _require(positions == sorted(positions), "gradient.stops must run in ascending position", "gradient.stops")
    if "tile" in definition:
        tile = _object(definition["tile"], "tile", path="tile")
        _fields(tile, "enabled image size opacity direction speedPxPerSec", "tile", path="tile")
        _scene_flags(tile, "enabled", "tile")
        _resource(tile.get("image"), document, {"image", "texture"}, path="tile.image")
        _enum(tile.get("direction"), _SCENE_DIRECTIONS, "tile direction")
        t = limits["tile"]
        _scene_range(tile, "size", t["size"], "tile.size")
        _scene_range(tile, "opacity", t["opacity"], "tile.opacity")
        _scene_range(tile, "speedPxPerSec", t["speedPxPerSec"], "tile.speed")
    if "screen" in definition:
        screen = _object(definition["screen"], "screen", path="screen")
        kind = _enum(screen.get("kind"), {"rays", "lines"}, "screen kind")
        _scene_flags(screen, "enabled spiky" if kind == "rays" else "enabled", "screen")
        _scene_color(screen.get("color"), "screen.color")
        _scene_range(screen, "seed", seed, "screen.seed", integer=True)
        if kind == "rays":
            _fields(
                screen,
                "enabled kind color opacity count centerX centerY spiky turnSeconds throbPerSec seed",
                "rays screen",
                path="screen",
            )
            r = limits["rays"]
            _scene_range(screen, "count", r["count"], "screen.count", integer=True)
            _scene_range(screen, "opacity", r["opacity"], "screen.opacity")
            _scene_range(screen, "centerX", r["center"], "screen.centerX")
            _scene_range(screen, "centerY", r["center"], "screen.centerY")
            _scene_range(screen, "throbPerSec", r["throbPerSec"], "screen.throb")
            _number(screen.get("turnSeconds"), "screen.turnSeconds")
            if screen["turnSeconds"] != 0:
                _scene_range({"turn": abs(screen["turnSeconds"])}, "turn", r["turnSeconds"], "screen.turnSeconds")
        else:
            _fields(
                screen,
                "enabled kind color opacity count minLength maxLength minWidthPx maxWidthPx swaySeconds seed",
                "lines screen",
                path="screen",
            )
            n = limits["lines"]
            _scene_range(screen, "count", n["count"], "screen.count", integer=True)
            _scene_range(screen, "opacity", n["opacity"], "screen.opacity")
            for key in ("minLength", "maxLength"):
                _scene_range(screen, key, n["length"], f"screen.{key}")
            _scene_ordered(screen, "minLength", "maxLength", "screen.length")
            _scene_range(screen, "minWidthPx", n["widthPx"], "screen.minWidth")
            _scene_range(screen, "maxWidthPx", n["widthPx"], "screen.maxWidth")
            _scene_ordered(screen, "minWidthPx", "maxWidthPx", "screen.width")
            _number(screen.get("swaySeconds"), "screen.swaySeconds")
            if screen["swaySeconds"] != 0:
                _scene_range(screen, "swaySeconds", n["swaySeconds"], "screen.sway")
    if "scatters" in definition:
        sc = limits["scatter"]
        layers = _array(definition["scatters"], "scatters", path="scatters")
        _scene_count(layers, (0, sc["layers"]), "scatters")
        total = 0
        for index, raw in enumerate(layers):
            path = f"scatters[{index}]"
            field = f"scatters.{index}"
            layer = _object(raw, "scatter", path=path)
            _fields(
                layer,
                "enabled items count seed minSize maxSize minRotationDeg maxRotationDeg minOpacity maxOpacity "
                "regionTop regionBottom keepFaceClear direction speedPxPerSec minSpinDegPerSec maxSpinDegPerSec "
                "alternateSpin pulse",
                "scatter",
                path=path,
            )
            _scene_flags(layer, "enabled keepFaceClear alternateSpin", field)
            items = _scene_items(layer.get("items"), document, "scatter", path=f"{path}.items")
            if index not in emoji_emptied_scatters:
                _scene_count(items, sc["items"], f"{field}.items")
            _scene_range(layer, "count", sc["count"], f"{field}.count", integer=True)
            total += int(layer["count"])
            _scene_range(layer, "seed", seed, f"{field}.seed", integer=True)
            for low, high, key, name in (
                ("minSize", "maxSize", "sizePx", "size"),
                ("minRotationDeg", "maxRotationDeg", "rotationDeg", "rotation"),
                ("minOpacity", "maxOpacity", "opacity", "opacity"),
                ("regionTop", "regionBottom", "region", "region"),
                ("minSpinDegPerSec", "maxSpinDegPerSec", "spinDegPerSec", "spin"),
            ):
                _scene_range(layer, low, sc[key], f"{field}.{low}")
                _scene_range(layer, high, sc[key], f"{field}.{high}")
                _scene_ordered(layer, low, high, f"{field}.{name}")
            _scene_range(layer, "speedPxPerSec", sc["speedPxPerSec"], f"{field}.speed")
            _enum(layer.get("direction"), _SCENE_DIRECTIONS, "scatter direction")
            _enum(layer.get("pulse"), {"none", "twinkle", "pop", "flicker"}, "scatter pulse")
        _require(
            total <= sc["totalCount"], f"Scattered layers can show at most {sc['totalCount']} items in all", "scatters"
        )
    if "flash" in definition:
        flash = _object(definition["flash"], "flash", path="flash")
        _fields(flash, "enabled color durationMs", "flash", path="flash")
        _scene_flags(flash, "enabled", "flash")
        _scene_color(flash.get("color"), "flash.color")
        _scene_range(flash, "durationMs", limits["flash"]["durationMs"], "flash.duration", integer=True)


def _scene_effect(
    definition: dict[str, Any], document: TypedContentDocument, *, emoji_emptied_scatters: frozenset[int]
) -> None:
    _fields(
        definition,
        "schema kind durationMs coverUiOverlays dismissOnInput soundAlias solid pattern marquee "
        "gradient tile screen scatters flash "
        "renderPlacement lineCount color opacity baseThicknessPx thicknessVariationPx lengthVariation "
        "overscanPx target animation seed",
        "Scene Effect",
    )
    kind = _enum(definition.get("kind"), {"background_layers", "focus_lines"}, "Scene Effect kind")
    _booleans(definition, "coverUiOverlays dismissOnInput")
    limits = SCENE_EFFECT_LIMITS
    if definition.get("durationMs") is not None:
        _scene_range(definition, "durationMs", limits["durationMs"], "durationMs", integer=True)
    if kind == "focus_lines":
        f = limits["focus"]
        _enum(definition.get("renderPlacement"), {"behind_avatar", "front_of_avatar"}, "focus placement")
        _scene_range(definition, "lineCount", f["lineCount"], "focus.lineCount", integer=True)
        _scene_range(definition, "opacity", f["opacity"], "focus.opacity")
        _scene_range(definition, "baseThicknessPx", f["baseThicknessPx"], "focus.baseThickness")
        _scene_range(definition, "thicknessVariationPx", f["thicknessVariationPx"], "focus.thicknessVariation")
        _scene_range(definition, "lengthVariation", f["lengthVariation"], "focus.lengthVariation")
        _scene_range(definition, "overscanPx", f["overscanPx"], "focus.overscan")
        _scene_color(definition.get("color"), "focus.color")
        if definition.get("seed") is not None:
            _scene_range(definition, "seed", limits["seed"], "focus.seed", integer=True)
        target = _object(definition.get("target"), "target")
        target_kind = _enum(target.get("kind"), {"avatar_face", "manual_box"}, "focus target")
        if target_kind == "avatar_face":
            _fields(target, "kind paddingXPx paddingYPx", "target")
            _scene_range(target, "paddingXPx", f["paddingPx"], "focus.paddingX")
            _scene_range(target, "paddingYPx", f["paddingPx"], "focus.paddingY")
        else:
            _fields(target, "kind rect", "target")
            rect = _object(target.get("rect"), "target rectangle")
            _fields(rect, "x y width height", "target rectangle")
            _numbers(rect, "x y width height")
        animation = _object(definition.get("animation"), "focus animation")
        fields = "minVisibleMs maxVisibleMs minHiddenMs maxHiddenMs opacityJitter"
        _fields(animation, fields, "focus animation")
        for key in ("minVisibleMs", "maxVisibleMs", "minHiddenMs", "maxHiddenMs"):
            _scene_range(animation, key, f["animationMs"], f"focus.animation.{key}")
        _scene_range(animation, "opacityJitter", f["opacityJitter"], "focus.animation.opacityJitter")
        return
    solid = _object(definition.get("solid"), "solid")
    _fields(solid, "enabled color", "solid")
    _require(type(solid.get("enabled")) is bool, "Solid enabled must be boolean")
    _scene_color(solid.get("color"), "solid.color")
    pattern = _object(definition.get("pattern"), "pattern")
    _fields(pattern, "enabled pattern color size spacing opacity", "pattern")
    _require(type(pattern.get("enabled")) is bool, "Pattern enabled must be boolean")
    _enum(pattern.get("pattern"), {"none", "polkadot", "heart", "star"}, "background pattern")
    _scene_color(pattern.get("color"), "pattern.color")
    _scene_range(pattern, "size", limits["pattern"]["size"], "pattern.size")
    _scene_range(pattern, "spacing", limits["pattern"]["spacing"], "pattern.spacing")
    _scene_range(pattern, "opacity", limits["pattern"]["opacity"], "pattern.opacity")
    marquee = _object(definition.get("marquee"), "marquee")
    _fields(
        marquee,
        "enabled items itemSize gap rowGap direction itemRotationMode itemRotationOffsetDeg speedPxPerSec opacity",
        "marquee",
    )
    _require(type(marquee.get("enabled")) is bool, "Marquee enabled must be boolean")
    m = limits["marquee"]
    _scene_range(marquee, "itemSize", m["itemSize"], "marquee.itemSize")
    _scene_range(marquee, "gap", m["gap"], "marquee.gap")
    _scene_range(marquee, "rowGap", m["rowGap"], "marquee.rowGap")
    _scene_range(marquee, "itemRotationOffsetDeg", m["rotationDeg"], "marquee.rotation")
    _scene_range(marquee, "speedPxPerSec", m["speedPxPerSec"], "marquee.speed")
    _scene_range(marquee, "opacity", m["opacity"], "marquee.opacity")
    _enum(marquee.get("direction"), _SCENE_DIRECTIONS, "marquee direction")
    _enum(marquee.get("itemRotationMode"), {"upright", "follow-track"}, "marquee rotation")
    items = _scene_items(marquee.get("items"), document, "marquee", path="marquee.items")
    _scene_count(items, (0, m["items"]), "marquee.items")
    _scene_background_layers(definition, document, emoji_emptied_scatters=emoji_emptied_scatters)


SCENE_DEFINITION_INVALID = "scene_definition_invalid"


def validate_scene_effect_definition(document: SceneEffectDocumentV1) -> tuple[ContentDiagnostic, ...]:
    """Check a Scene Effect definition as package export does, at Save and scan.

    A definition outside the shared limits, or one the runtime cannot draw, is
    reported against the field it names, so Save refuses it and a Local folder
    shows why it is unavailable. Each emoji item is reported on its own
    (``SCENE_EMOJI_ITEM_REMOVED``, which a Local scan tolerates) and the rest
    of the definition is checked as it plays, without those items.
    """
    if document.definition is None:
        return ()
    emoji_items = scene_emoji_items(document.definition)
    diagnostics = [
        ContentDiagnostic(SCENE_EMOJI_ITEM_REMOVED, _emoji_item_message(item, path, scanned=True))
        for path, item in emoji_items
    ]
    playable, emptied = _without_emoji_items(document.definition) if emoji_items else (document.definition, frozenset())
    try:
        _scene_effect_capabilities(replace(document, definition=playable), emoji_emptied_scatters=emptied)
    except ContentDocumentError as exc:
        # The diagnostic's path is a file; the message names the JSON field.
        diagnostics.append(ContentDiagnostic(SCENE_DEFINITION_INVALID, str(exc)))
    return tuple(diagnostics)


def _scene_effect_capabilities(
    document: SceneEffectDocumentV1, *, emoji_emptied_scatters: frozenset[int] = frozenset()
) -> tuple[str, ...]:
    """Validate a Scene Effect definition; see ``_scene_background_layers`` for the emptied layers."""
    definition = _object(document.definition, "Effect definition")
    _safe_data(definition)
    schema = "animama/scene-effect/1"
    _require(definition.get("schema") == schema, "Unsupported effect definition schema")
    _sound(definition, document)
    _scene_effect(definition, document, emoji_emptied_scatters=emoji_emptied_scatters)
    return (schema,)


def derive_document_capabilities(document: TypedContentDocument) -> tuple[str, ...]:
    """Validate actual typed definitions, never catalog-version compatibility claims."""
    if isinstance(document, VoiceDocumentV1):
        _require(document.codec == POCKET_CLONE_CODEC, "Only encoded Pocket clones are portable")
        validate_pocket_clone_document(document)
        _require(not document.dependencies, "A packaged Pocket clone cannot have dependencies")
        _require(
            len(document.files) == 1 and document.files[0].role == "pocket_voice_catalog",
            "A packaged Pocket clone must contain only its encoded catalog",
        )
        return ("animama/pocket-voice/1",)
    if isinstance(document, PoseDocumentV1):
        return ("animaPose/1.0",)
    if isinstance(document, AvatarEffectDocumentV1):
        return (validate_avatar_effect_document(document),)
    if isinstance(document, SceneEffectDocumentV1):
        return _scene_effect_capabilities(document)
    if isinstance(document, ParticleEffectDocumentV1):
        _require(document.definition is None, "Particle Effects require a registered Quarks manifest")
        _require(
            sum(file.role == "manifest" for file in document.files) == 1,
            "Particle Effect requires one registered manifest",
        )
    if isinstance(document, GestureDocumentV1 | ReactionDocumentV1):
        _require(document.implementation.content_dependency_ref is None, "Actions must own their animation resource")
        role = document.implementation.file_role or (
            "animation" if document.implementation.kind == "vrma" else "sequence"
        )
        # Standalone VRMA files have no explicit declarations; their suffix is checked below.
        _require(
            not document.files or sum(file.role == role for file in document.files) == 1,
            "Action requires one active animation resource",
        )
    _require(
        document.kind not in {ContentKind.MUSIC_TRACK, ContentKind.POSE_CLIP, ContentKind.VOICE, ContentKind.ANIMA},
        "Unsupported package content kind",
    )
    return ()


def _read_json(content: BinaryIO, *, size: int | None = None) -> dict[str, Any]:
    length = MAX_DEFINITION_BYTES + 1 if size is None else size
    _require(length <= MAX_DEFINITION_BYTES + 1, "Package definition exceeds byte limit")
    raw = content.read(length)
    _require(
        len(raw) <= MAX_DEFINITION_BYTES and (size is None or len(raw) == size),
        "Package definition is oversized or truncated",
    )
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ContentDocumentError("package_definition_invalid", "Package resource is not bounded valid JSON") from exc
    result = _object(value, "Package resource")
    _safe_data(result)
    return result


def _builtin_pose(value: Any) -> str:
    pose = _string(value, "App Pose reference")
    _require(pose in BUILTIN_POSES, "Unknown app Pose reference")
    return f"animama/builtin-pose/1/{pose}"


def normalized_action_selector(value: str) -> str:
    """Match the frontend's String.trim for authored cue/effect/preset IDs.

    ECMAScript trims BOM but not NEL or the information separators removed by
    Python's default strip. Keep names, descriptions and other fields untouched.
    """
    whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff"
    whitespace += "".join(chr(codepoint) for codepoint in range(0x2000, 0x200B))
    _require(isinstance(value, str), "Action event selector must be a string")
    result = value.strip(whitespace)
    _require(bool(result), "Action event selector cannot be empty")
    return result


def _clip_event_dependencies(
    value: dict[str, Any], document: TypedContentDocument, documents: Mapping[str, TypedContentDocument] | None
) -> None:
    """Require exactly one typed edge for every Action FX/audio selector.

    Pose capabilities describe checked app primitives. FX/audio names
    have no such fallback: their content must be in the reviewed package graph.
    Count aliases across every kind before checking the expected kind, because
    runtime alias maps cannot disambiguate a same-name edge of another type.
    """
    targets = {
        "sfx": ("cueId", ContentKind.SOUND_EFFECT),
        "avatar_vfx": ("effectId", ContentKind.AVATAR_EFFECT),
        "scene_vfx": ("presetId", ContentKind.SCENE_EFFECT),
        "particle_vfx": ("effectId", ContentKind.PARTICLE_EFFECT),
    }
    effects: dict[str, AvatarEffectDefinitionV2 | None] = {}
    for event in value.get("events", []):
        field, kind = targets[event["kind"]]
        selector = normalized_action_selector(event[field])
        matches = [edge for edge in document.dependencies if selector in {edge.alias, edge.ref}]
        _require(
            len(matches) == 1 and matches[0].kind is kind,
            "Action event selector must name one bundled dependency of the matching kind",
        )
        if kind is ContentKind.AVATAR_EFFECT:
            target = documents.get(matches[0].ref) if documents is not None else None
            if isinstance(target, AvatarEffectDocumentV1):
                effects[event[field]] = project_avatar_effect_definition(target.definition)[0]
        if kind is ContentKind.SCENE_EFFECT:
            target = documents.get(matches[0].ref) if documents is not None else None
            _require(
                isinstance(target, SceneEffectDocumentV1)
                and target.definition is not None
                and target.definition.get("kind") == event["sceneKind"],
                "Action scene selector must resolve to the requested bundled Scene Effect primitive",
            )
    check_clip_effect_overrides(value, effects, code="package_definition_invalid")


def _clip(
    value: dict[str, Any], document: TypedContentDocument, documents: Mapping[str, TypedContentDocument] | None
) -> set[str]:
    schema = value.get("schema")
    if schema != ANIMA_POSE_CLIP_SCHEMA:
        raise ContentDocumentError(CLIP_FORMAT_UNSUPPORTED, unsupported_clip_format_message(schema))
    _booleans(value, "loop")
    duration = None if "duration" not in value else _number(value["duration"], "Clip duration")
    _require(duration is None or duration > 0, "Clip duration must be positive")
    if "playback" in value:
        playback = _object(value["playback"], "playback")
        _fields(playback, "lifetime", "playback")
        lifetime = _object(playback.get("lifetime"), "playback lifetime")
        kind = _enum(lifetime.get("kind"), {"whileInteractionPhase", "whileAvatarState"}, "clip lifetime")
        key = "phases" if kind == "whileInteractionPhase" else "states"
        _fields(lifetime, f"kind scope {key}", "clip lifetime")
        _enum(lifetime.get("scope", "activeRun"), {"activeRun"}, "clip scope")
        allowed = (
            {"idle", "listening", "thinking", "gesture", "talking"}
            if key == "states"
            else {
                "idle",
                "user_typing",
                "listening",
                "user_speaking",
                "semantic_check",
                "submitting",
                "thinking",
                "responding_no_tts",
                "talking",
            }
        )
        values = _array(lifetime.get(key), key)
        _require(bool(values), "Clip lifetime selection cannot be empty")
        for selected in values:
            _enum(selected, allowed, key)
        _require(len(set(values)) == len(values), "Clip lifetime selections must be unique")
    # The existing validator admits the same timeline/pose/event primitives. Its
    # finite-idle policy excludes lifetime, already checked above for general Actions.
    timeline = {key: item for key, item in value.items() if key != "playback"}
    try:
        validate_clip_v2_timeline(timeline)
    except ContentDocumentError as exc:
        raise ContentDocumentError(
            "package_definition_invalid", str(exc).replace("Gesture clip", "Action clip"), field=exc.field
        ) from exc
    _clip_event_dependencies(value, document, documents)
    # Tracks hold values; only the base pose names a built-in Pose.
    requirements = {ANIMA_POSE_CLIP_SCHEMA}
    if "basePose" in value:
        requirements.add(_builtin_pose(value["basePose"]))
    return requirements


def _particle(value: dict[str, Any], document: TypedContentDocument) -> None:
    _fields(value, "metadata geometries materials textures images object animations", "Quarks document")
    _require(not value.get("animations"), "Separate Three animations are unsupported")
    for image in _array(value.get("images", []), "Quarks images"):
        _resource(_object(image, "Quarks image").get("url"), document, {"texture", "image"})
    for geometry in _array(value.get("geometries", []), "Quarks geometries"):
        _enum(_object(geometry, "Quarks geometry").get("type"), {"PlaneGeometry"}, "Quarks geometry")
    for material in _array(value.get("materials", []), "Quarks materials"):
        _enum(_object(material, "Quarks material").get("type"), {"MeshBasicMaterial"}, "Quarks material")
    pending = [_object(value.get("object"), "Quarks root")]
    emitters = 0
    while pending:
        node = pending.pop()
        kind = _enum(node.get("type"), {"Group", "ParticleEmitter"}, "Quarks node")
        pending.extend(_object(child, "Quarks child") for child in _array(node.get("children", []), "children"))
        if kind != "ParticleEmitter":
            continue
        emitters += 1
        ps = _object(node.get("ps"), "Particle system")
        _require(ps.get("version") == "3.0", "Unsupported particle system version")
        grid_issue = emitter_grid_issue(ps)
        _require(grid_issue is None, grid_issue or "")
        _require(type(ps.get("renderMode")) is int and ps["renderMode"] in range(6), "Unsupported particle render mode")
        _require(_number(ps.get("duration"), "Particle duration") > 0, "Particle duration must be positive")
        _enum(
            _object(ps.get("shape"), "Particle shape").get("type"),
            {"point", "sphere", "cone", "rectangle"},
            "Particle shape",
        )
        for behavior in _array(ps.get("behaviors", []), "Particle behaviors"):
            _enum(_object(behavior, "Particle behavior").get("type"), _PARTICLE_BEHAVIORS, "Particle behavior")
        objects = [ps]
        while objects:
            current = objects.pop()
            for key, child in current.items():
                if key == "type":
                    _enum(child, _PARTICLE_TYPES, "Particle behavior or generator")
                elif key == "subType":
                    _enum(child, {"Number", "Color"}, "Particle generator subtype")
                elif isinstance(child, dict):
                    objects.append(child)
                elif isinstance(child, list):
                    objects.extend(part for part in child if isinstance(part, dict))
    _require(emitters > 0, "Particle resource must contain an emitter")


def _gltf_json(content: BinaryIO) -> dict[str, Any]:
    """The bounded JSON document of a GLB, or of a JSON glTF file."""
    prefix = content.read(20)
    if prefix[:4] == b"glTF":
        _require(len(prefix) == 20, "Truncated GLB header")
        _, version, total, length, chunk_type = struct.unpack("<4sIIII", prefix)
        _require(
            version == 2 and chunk_type == 0x4E4F534A and 0 < length <= MAX_DEFINITION_BYTES and total >= length + 20,
            "Unsupported GLB container",
        )
        return _read_json(content, size=length)
    content.seek(0)
    return _read_json(content)


def undecoded_gltf_extensions(content: BinaryIO) -> tuple[str, ...]:
    """The accepted extensions a glTF file uses that the runtime cannot decode, sorted."""
    value = _gltf_json(content)
    used = {
        name
        for field in ("extensionsRequired", "extensionsUsed")
        for name in _array(value.get(field, []), field)
        if isinstance(name, str)
    }
    return tuple(sorted(used & UNDECODED_GLTF_EXTENSIONS))


def _gltf(content: BinaryIO, relative_path: str) -> str:
    value = _gltf_json(content)
    for field in ("buffers", "images"):
        for resource in _array(value.get(field, []), f"glTF {field}"):
            uri = _object(resource, f"glTF {field}").get("uri")
            _require(
                uri is None or isinstance(uri, str) and uri.startswith("data:"), "glTF resources must be self-contained"
            )
    for field in ("extensionsRequired", "extensionsUsed"):
        for extension in _array(value.get(field, []), field):
            _enum(extension, _GLTF_EXTENSIONS, "glTF extension")
    extensions = _object(value.get("extensions"), "glTF extensions")
    for extension in extensions:
        _enum(extension, _GLTF_EXTENSIONS, "glTF extension")
    if relative_path.lower().endswith(".vrma"):
        extension = _object(extensions.get("VRMC_vrm_animation"), "VRMA extension")
        _require(extension.get("specVersion") == "1.0", "Unsupported VRMA version")
        return "VRMC_vrm_animation/1.0"
    if "VRMC_vrm" in extensions:
        _require(
            _object(extensions["VRMC_vrm"], "VRM extension").get("specVersion") == "1.0", "Unsupported VRM version"
        )
        return "VRMC_vrm/1.0"
    _require(_object(extensions.get("VRM"), "VRM extension").get("specVersion") == "0.0", "Unsupported VRM version")
    return "VRM/0.0"


def _svg(content: BinaryIO) -> None:
    raw = content.read(MAX_DEFINITION_BYTES + 1)
    _require(len(raw) <= MAX_DEFINITION_BYTES, "SVG resource exceeds byte limit")
    _require(b"<!DOCTYPE" not in raw.upper() and b"<!ENTITY" not in raw.upper(), "SVG entities are unsupported")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ContentDocumentError("package_definition_invalid", "Invalid SVG resource") from exc
    _require(root.tag.rsplit("}", 1)[-1] == "svg", "Resource must contain an SVG root")
    for element in root.iter():
        _require(
            element.tag.rsplit("}", 1)[-1].lower() not in {"script", "foreignobject", "style"},
            "Executable SVG resources are unsupported",
        )
        for key, value in element.attrib.items():
            attribute = key.rsplit("}", 1)[-1].lower()
            _require(not attribute.startswith("on"), "SVG event handlers are unsupported")
            if attribute in {"href", "src"}:
                _require(value.startswith("#"), "External SVG resources are unsupported")
            for target in re.findall(r"url\((.*?)\)", value, flags=re.IGNORECASE):
                _require(target.strip(" \"'").startswith("#"), "External SVG resources are unsupported")


def derive_file_capabilities(
    kind: ContentKind,
    document: TypedContentDocument,
    relative_path: str,
    content: BinaryIO,
    *,
    role: str | None = None,
    documents: Mapping[str, TypedContentDocument] | None = None,
) -> tuple[str, ...]:
    """Inspect one verified stream sequentially; caller may rewind it for ZIP output.

    Full media validation and file-registration ownership remain at the catalog
    boundary. Supply the verified catalog/scanner role to include inferred files
    whose author did not write a descriptor file declaration.
    """
    _require(document.kind == kind, "Package kind disagrees with typed document")
    suffix = PurePosixPath(relative_path).suffix.lower()
    declared_roles = {file.role for file in document.files if file.path == relative_path}
    _require(
        role is None or not declared_roles or declared_roles == {role},
        "Registered package resource role disagrees with its declaration",
    )
    roles = {role} if role is not None else declared_roles
    if isinstance(document, VoiceDocumentV1):
        # Inspect the binary using the same bounded pure parser as local clone
        # admission. A .bin suffix alone says nothing about its actual contents.
        derive_document_capabilities(document)
        if roles == {"descriptor"}:
            _require(suffix == ".json", "A packaged Pocket clone requires a JSON descriptor")
            return ()
        _require(
            roles == {"pocket_voice_catalog"} and suffix == ".bin",
            "Unsupported packaged Pocket clone resource",
        )
        try:
            voices = validate_pocket_voice_catalog_bytes(content.read(MAX_POCKET_VOICE_CATALOG_BYTES + 1))
        except ValueError as exc:
            raise ContentDocumentError("package_definition_invalid", "Invalid encoded Pocket voice catalog") from exc
        _require(set(voices) == {"neutral"}, "A packaged Pocket clone must contain only the neutral voice")
        return ("animama/pocket-voice/1",)
    if suffix == ".svg":
        _svg(content)
    if suffix in {".vrm", ".vrma"}:
        return (_gltf(content, relative_path),)
    if isinstance(document, GestureDocumentV1 | ReactionDocumentV1):
        if document.implementation.kind == "anima_clip" and (document.implementation.file_role or "sequence") in roles:
            return tuple(sorted(_clip(_read_json(content), document, documents)))
    if kind is ContentKind.PARTICLE_EFFECT and "manifest" in roles:
        _particle(_read_json(content), document)
        return ("three.quarks/3.0",)
    _require(
        suffix
        in {".json", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".bin", ".wav", ".ogg", ".mp3", ".flac", ".txt", ".md"},
        "Unsupported or executable package resource",
    )
    return ()


def derive_capabilities(
    kind: ContentKind,
    document: TypedContentDocument,
    files: Mapping[str, Path],
    *,
    roles: Mapping[str, str] | None = None,
    documents: Mapping[str, TypedContentDocument] | None = None,
) -> tuple[str, ...]:
    """Validate a staged entry with at most one resource handle open at a time."""
    _require(document.kind == kind, "Package kind disagrees with typed document")
    requirements = set(derive_document_capabilities(document))
    _require(all(file.path in files for file in document.files), "A registered package resource is missing")
    _require(roles is None or files.keys() == roles.keys(), "Registered package resource roles are incomplete")
    for relative_path, path in files.items():
        with path.open("rb") as content:
            requirements.update(
                derive_file_capabilities(
                    kind,
                    document,
                    relative_path,
                    content,
                    role=roles[relative_path] if roles is not None else None,
                    documents=documents,
                )
            )
    return tuple(sorted(requirements))
