"""The ``animama/avatar-effect/2`` definition: the one source of Avatar Effect fields.

These strict models type the Avatar Effect API projections, so OpenAPI carries
them to the generated TypeScript types and zod validators that the frontend
runtime and creator use. The backend validates Save, package export and import
with the same models. JSON keys are camelCase, as in the stored descriptors.

An effect describes four separate things: where its art attaches
(``attachment``), how the art looks (``appearance``), which image or flipbook it
draws (``art``) and how it moves on its own timeline (``motion``). The Gesture or
Reaction event that plays the effect owns when it starts and ends and its fade,
and may override the attachment, appearance, motion and sound for that one use
(``AvatarEffectEventOverride``).

Numeric bounds are part of the untrusted-input contract: definitions come from
Local content and imported packages, and the renderer allocates canvases,
textures and per-frame work from these values.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

AVATAR_EFFECT_SCHEMA_V2 = "animama/avatar-effect/2"
AVATAR_EFFECT_SCHEMA_V1 = "animama/avatar-effect/1"

# Bounds shared by the converter and the runtime. Keep them generous enough for
# authored art but small enough that a hostile definition cannot ask the
# compositor for unbounded work.
# Serialized bytes of one definition; real definitions are under 4 KiB.
MAX_DEFINITION_BYTES = 64 * 1024
MAX_FLIPBOOK_GRID = 16
MAX_FLIPBOOK_FRAMES = 256
MAX_FLIPBOOK_FPS = 60.0
MAX_KEYFRAMES = 64
MAX_KEYFRAME_TIME_SECONDS = 600.0
MAX_SCALE = 20.0
MAX_ROTATION_DEGREES = 3600.0

FacePart = Literal["face_skin", "eye_iris", "eye_highlight", "eyeline", "eyelash"]
FaceSurfaceArea = Literal["full", "eyes", "undereye", "blush", "mouth"]
FaceLandmark = Literal["eyes", "mouth", "forehead", "top", "top_edge"]
LandmarkPosition = Literal["left", "middle", "right", "left_corner", "right_corner"]
Side = Literal["left", "right"]
SurfaceLayout = Literal["single", "span"]
SurfaceMode = Literal["overlay", "replace"]
Pivot = Literal[
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]
BodyBone = Literal["root", "hips", "spine", "chest", "neck", "head", "leftHand", "rightHand", "leftFoot", "rightFoot"]
Region = Literal["eyes", "undereye", "blush", "mouth", "emote", "full_face", "body", "sticker", "silhouette"]
Blend = Literal["normal", "additive", "multiply"]
FlipbookLoop = Literal["loop", "once", "pingpong"]
SpinDirection = Literal["clockwise", "counterclockwise"]

_FACE_REGIONS = frozenset({"eyes", "undereye", "blush", "mouth", "emote", "full_face"})

Scale = Annotated[float, Field(gt=0, le=MAX_SCALE)]
Degrees = Annotated[float, Field(ge=-MAX_ROTATION_DEGREES, le=MAX_ROTATION_DEGREES)]
UvOffset = Annotated[float, Field(ge=-2, le=2)]
Meters = Annotated[float, Field(ge=-5, le=5)]


class _Strict(BaseModel):
    """Reject unknown keys and coercions, and keep the validation-mode JSON Schema.

    Cross-field errors start with the offending path relative to the model
    (``"layout: required for this area"``) so callers can name the exact field.

    The frontend validates stored definitions, which omit defaulted fields, with
    the generated zod schema; a serialization-mode schema would require them.
    """

    model_config = ConfigDict(extra="forbid", strict=True, json_schema_mode_override="validation")


class AvatarEffectVector2(_Strict):
    """A 2D value; units depend on the attachment that owns it."""

    x: float = Field(default=0, ge=-10, le=10)
    y: float = Field(default=0, ge=-10, le=10)


class AvatarEffectUvOffset(_Strict):
    """Offset in fractions of the painted texture (UV space)."""

    x: UvOffset = 0
    y: UvOffset = 0


class AvatarEffectLandmarkOffset(_Strict):
    """Offset in metres in the Avatar's front frame at its anchor.

    +x is toward the viewer's right when facing the Avatar, +y up and +z
    forward, on VRM 0 and VRM 1 alike.
    """

    x: Meters = 0
    y: Meters = 0
    z: Meters = 0


class AvatarEffectScale2(_Strict):
    """Positive scale factors; a mirrored placement mirrors the art itself."""

    x: Scale = 1
    y: Scale = 1


class AvatarEffectRotation3(_Strict):
    """Euler rotation in degrees, applied X then Y then Z."""

    x: Degrees = 0
    y: Degrees = 0
    z: Degrees = 0


class FaceSurfaceAttachment(_Strict):
    """Art painted onto a detected face part, as an overlay or a replacement.

    ``area`` chooses the placement: ``full`` and ``eyes`` cover the part's
    texture layout, while ``undereye``, ``blush`` and ``mouth`` place a decal at
    a face anchor on ``face_skin``. ``layout`` chooses one side (``single``) or
    one image across both sides (``span``) for the paired areas.
    """

    kind: Literal["face_surface"]
    part: FacePart
    area: FaceSurfaceArea
    layout: SurfaceLayout | None = None
    side: Side | None = None
    mirror: bool = False
    mode: SurfaceMode = "overlay"
    pivot: Pivot | None = None
    offset: AvatarEffectUvOffset = Field(default_factory=AvatarEffectUvOffset)
    scale: AvatarEffectScale2 = Field(default_factory=AvatarEffectScale2)
    rotationDeg: Degrees = 0

    @model_validator(mode="after")
    def _check_area(self) -> Self:
        paired = self.area in {"eyes", "undereye", "blush"}
        decal = self.area in {"undereye", "blush", "mouth"}
        if paired and self.layout is None:
            raise ValueError("layout: required for this area")
        if not paired and self.layout is not None:
            raise ValueError("layout: applies only to the eyes, undereye and blush areas")
        if self.layout != "single" and (self.side is not None or self.mirror):
            raise ValueError("side: side and mirror apply only to a single layout")
        if decal and self.layout == "single" and self.side is None:
            raise ValueError("side: a single face decal requires a side")
        if decal and self.part != "face_skin":
            raise ValueError("part: face decals are painted on face_skin")
        if decal and self.mode != "overlay":
            raise ValueError("mode: face decals support only the overlay mode")
        if not decal and self.pivot is not None:
            raise ValueError("pivot: applies only to the undereye, blush and mouth areas")
        return self


class FaceLandmarkAttachment(_Strict):
    """A plane in front of an eye, the mouth, the forehead or above the head."""

    kind: Literal["face_landmark"]
    landmark: FaceLandmark
    position: LandmarkPosition | None = None
    side: Side | None = None
    mirror: bool = False
    offset: AvatarEffectLandmarkOffset = Field(default_factory=AvatarEffectLandmarkOffset)
    scale: AvatarEffectScale2 = Field(default_factory=AvatarEffectScale2)
    rotationDeg: AvatarEffectRotation3 = Field(default_factory=AvatarEffectRotation3)

    @model_validator(mode="after")
    def _check_landmark(self) -> Self:
        if self.landmark in {"forehead", "top", "top_edge"}:
            if self.position is None:
                raise ValueError("position: required for this landmark")
            if self.landmark != "top_edge" and self.position in {"left_corner", "right_corner"}:
                raise ValueError("position: corner positions apply only to the top_edge landmark")
        elif self.position is not None:
            raise ValueError("position: applies only to the forehead, top and top_edge landmarks")
        if self.landmark != "eyes" and (self.side is not None or self.mirror):
            raise ValueError("side: side and mirror apply only to the eyes landmark")
        return self


class BodyAttachment(_Strict):
    """A plane on a humanoid body point that follows its normalized bone.

    ``offset`` is in metres in the bone's frame (+x toward the viewer's right
    when facing the avatar, +y up, +z forward), ``size`` is the plane height in
    metres and ``rotationDeg`` turns the plane in its own plane. ``facing``
    keeps it toward the camera or in the bone's orientation.
    """

    kind: Literal["body"]
    bone: BodyBone
    offset: AvatarEffectLandmarkOffset = Field(default_factory=AvatarEffectLandmarkOffset)
    size: float = Field(default=0.2, gt=0, le=5)
    facing: Literal["camera", "bone"] = "camera"
    rotationDeg: Degrees = 0


class StickerAttachment(_Strict):
    """A camera-facing image beside the head or body centre that follows the avatar.

    ``size`` (plane height) and ``offset`` (in the screen plane) are fractions
    of the avatar's height; stickers draw over the avatar.
    """

    kind: Literal["sticker"]
    around: Literal["head", "body"] = "head"
    offset: AvatarEffectVector2 = Field(default_factory=AvatarEffectVector2)
    size: float = Field(default=0.25, gt=0, le=2)
    rotationDeg: Degrees = 0


class SilhouetteAttachment(_Strict):
    """Art drawn only over the avatar's visible pixels, without changing its materials.

    ``pattern`` tiles the art in screen space (at ``patternScale`` 1 a tile is a
    quarter of the avatar's on-screen height); ``tint`` fills with the art's
    average colour. ``scroll`` moves the pattern in tiles per second.
    """

    kind: Literal["silhouette"]
    fill: Literal["pattern", "tint"] = "pattern"
    patternScale: float = Field(default=1, gt=0, le=MAX_SCALE)
    scroll: AvatarEffectVector2 = Field(default_factory=AvatarEffectVector2)


AvatarEffectAttachment = Annotated[
    FaceSurfaceAttachment | FaceLandmarkAttachment | BodyAttachment | StickerAttachment | SilhouetteAttachment,
    Field(discriminator="kind"),
]


class AvatarEffectFlipbook(_Strict):
    """Frames laid out left to right, top to bottom on a grid in ``art.image``."""

    columns: int = Field(ge=1, le=MAX_FLIPBOOK_GRID)
    rows: int = Field(ge=1, le=MAX_FLIPBOOK_GRID)
    frames: int = Field(ge=1, le=MAX_FLIPBOOK_FRAMES)
    fps: float = Field(gt=0, le=MAX_FLIPBOOK_FPS)
    loop: FlipbookLoop = "loop"

    @model_validator(mode="after")
    def _check_grid(self) -> Self:
        if self.frames > self.columns * self.rows:
            raise ValueError("frames: cannot exceed columns × rows")
        return self


class AvatarEffectArt(_Strict):
    """Registered image names; ``otherEyeImage`` replaces the mirrored copy."""

    image: str = Field(min_length=1, max_length=255)
    otherEyeImage: str | None = Field(default=None, min_length=1, max_length=255)
    flipbook: AvatarEffectFlipbook | None = None


class AvatarEffectAppearance(_Strict):
    """Opacity, an optional multiplicative tint and the blend mode."""

    opacity: float = Field(default=1, ge=0, le=1)
    tint: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    blend: Blend = "normal"


class AvatarEffectPulse(_Strict):
    """Scale oscillation between ``scaleMin`` and ``scaleMax``."""

    scaleMin: Scale | None = None
    scaleMax: Scale | None = None
    cyclesPerSecond: float | None = Field(default=None, ge=0, le=30)


class AvatarEffectSpin(_Strict):
    """Rotation; below one turn it swings back and forth, otherwise it wraps."""

    degreesPerSecond: float | None = Field(default=None, ge=-36_000, le=36_000)
    amountTurns: float | None = Field(default=None, ge=0, le=100)
    direction: SpinDirection | None = None


class AvatarEffectDrift(_Strict):
    """Constant movement per second, in fractions of the art's size."""

    x: float | None = Field(default=None, ge=-10, le=10)
    y: float | None = Field(default=None, ge=-10, le=10)


class AvatarEffectKeyframe(_Strict):
    """One keyframe; omitted channels are interpolated from neighbouring frames."""

    t: float = Field(ge=0, le=MAX_KEYFRAME_TIME_SECONDS)
    opacity: float | None = Field(default=None, ge=0, le=1)
    scale: Scale | None = None
    rotationDeg: Degrees | None = None
    offset: AvatarEffectVector2 | None = None


class AvatarEffectKeyframes(_Strict):
    """Keyframes on the effect's own timeline, combined with the presets.

    Scale and opacity multiply, rotation and offset add. ``loop`` repeats the
    timeline from its last keyframe time; otherwise the last values hold.
    """

    loop: bool = False
    frames: list[AvatarEffectKeyframe] = Field(min_length=1, max_length=MAX_KEYFRAMES)

    @model_validator(mode="after")
    def _check_order(self) -> Self:
        times = [frame.t for frame in self.frames]
        if any(later <= earlier for earlier, later in zip(times, times[1:], strict=False)):
            raise ValueError("frames: keyframe times must increase")
        return self


class AvatarEffectMotion(_Strict):
    """Intrinsic motion; a preset is enabled when its object is present."""

    pulse: AvatarEffectPulse | None = None
    spin: AvatarEffectSpin | None = None
    drift: AvatarEffectDrift | None = None
    keyframes: AvatarEffectKeyframes | None = None


class AvatarEffectFaceOptions(_Strict):
    """Face cleanup options for eye and mouth effects.

    Where an option applies, ``forceBlink``, ``hideEyeDetails`` and ``faceCleanup`` default on and
    ``skinBackdrop`` defaults off, except that eye art which closes the eyes and hides their details on
    an MMD model converted by Animama Avatar Converter covers each closed eye with a skin patch unless
    it is ``false``.
    """

    forceBlink: bool | None = None
    hideEyeDetails: bool | None = None
    faceCleanup: bool | None = None
    skinBackdrop: bool | None = None
    hideParts: list[FacePart] | None = Field(default=None, max_length=5)


def _face_option_names(attachment: object) -> frozenset[str]:
    """Return the face options that the runtime honours for one attachment."""
    if isinstance(attachment, FaceLandmarkAttachment):
        if attachment.landmark == "eyes":
            return frozenset({"forceBlink", "hideEyeDetails", "faceCleanup", "skinBackdrop", "hideParts"})
        if attachment.landmark == "mouth":
            return frozenset({"faceCleanup", "skinBackdrop"})
    if isinstance(attachment, FaceSurfaceAttachment):
        if attachment.area == "mouth":
            return frozenset({"faceCleanup"})
        if attachment.area in {"full", "eyes"}:
            return frozenset({"hideParts"})
    return frozenset()


class AvatarEffectDefinitionV2(_Strict):
    """A complete ``animama/avatar-effect/2`` definition."""

    schema_: Literal["animama/avatar-effect/2"] = Field(alias="schema")
    region: Region
    attachment: AvatarEffectAttachment
    art: AvatarEffectArt
    appearance: AvatarEffectAppearance = Field(default_factory=AvatarEffectAppearance)
    motion: AvatarEffectMotion = Field(default_factory=AvatarEffectMotion)
    faceOptions: AvatarEffectFaceOptions | None = None
    soundAlias: str | None = Field(default=None, min_length=1, max_length=255)

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_mode_override="validation",
        serialize_by_alias=True,
    )

    @model_validator(mode="after")
    def _check_consistency(self) -> Self:
        kind = self.attachment.kind
        if kind in {"body", "sticker", "silhouette"}:
            if self.region != kind:
                raise ValueError(f"region: a {kind} attachment uses the {kind} region")
        elif self.region not in _FACE_REGIONS:
            raise ValueError("region: a face attachment uses a face region")
        if self.art.otherEyeImage is not None:
            attachment = self.attachment
            paired = (isinstance(attachment, FaceLandmarkAttachment) and attachment.landmark == "eyes") or (
                isinstance(attachment, FaceSurfaceAttachment) and attachment.area in {"eyes", "undereye", "blush"}
            )
            if not paired or not getattr(attachment, "mirror", False):
                raise ValueError("art.otherEyeImage: requires a mirrored eye or paired face placement")
        if self.faceOptions is not None:
            allowed = _face_option_names(self.attachment)
            used = {name for name, value in self.faceOptions if value is not None}
            unsupported = sorted(used - allowed)
            if unsupported:
                raise ValueError(f"faceOptions.{unsupported[0]}: does not apply to this attachment")
        return self


class AvatarEffectEventOverride(_Strict):
    """Changes an ``avatar_vfx`` clip event makes to its effect for that one use.

    Each part present replaces the effect's part whole, so the same models
    validate it; the attachment keeps the effect's kind. ``soundAlias`` picks
    one of the effect's declared sounds; an unknown or unmounted one is silent.
    The art, region, face options and the set of sounds stay with the effect.
    """

    attachment: AvatarEffectAttachment | None = None
    appearance: AvatarEffectAppearance | None = None
    motion: AvatarEffectMotion | None = None
    soundAlias: str | None = Field(default=None, min_length=1, max_length=255)

    @model_validator(mode="before")
    @classmethod
    def _refuse_null_parts(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key, value in data.items():
                if value is None:
                    raise ValueError(f"{key}: omit the part instead of setting it to null")
        return data

    @model_validator(mode="after")
    def _require_a_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("an override must change at least one part")
        return self


def merge_avatar_effect_override(
    definition: AvatarEffectDefinitionV2, override: AvatarEffectEventOverride
) -> AvatarEffectDefinitionV2:
    """Return the definition one use plays: each part the override sets replaces the effect's part.

    Raises ``ValueError`` (``"attachment.kind: …"``) for a different attachment
    kind, or ``ValidationError`` when the result breaks a cross-field rule.
    """
    if override.attachment is not None and override.attachment.kind != definition.attachment.kind:
        raise ValueError("attachment.kind: must match the effect's attachment kind")
    merged = definition.model_dump(by_alias=True, exclude_unset=True)
    merged.update(override.model_dump(exclude_unset=True))
    return AvatarEffectDefinitionV2.model_validate(merged)


AvatarEffectDefinitionError = Literal["avatar_effect_conversion_required", "avatar_effect_definition_invalid"]


def project_avatar_effect_definition(value: Any) -> tuple[AvatarEffectDefinitionV2 | None, str | None]:
    """Split a stored definition into a typed ``/2`` value or a projection error code.

    API projections stay readable when Local content still holds an unconverted
    ``/1`` definition (for example after a failed conversion): the item is
    listed with ``definition_error`` instead of failing the whole response.
    """
    if value is None:
        return None, None
    if isinstance(value, AvatarEffectDefinitionV2):
        return value, None
    if isinstance(value, dict) and value.get("schema") == AVATAR_EFFECT_SCHEMA_V1:
        return None, "avatar_effect_conversion_required"
    try:
        return AvatarEffectDefinitionV2.model_validate(value), None
    except ValidationError:
        return None, "avatar_effect_definition_invalid"


def avatar_effect_projection_fields(data: Any) -> Any:
    """Before-validator body for models that expose ``definition`` and ``definition_error``."""
    if isinstance(data, dict) and "definition" in data and not data.get("definition_error"):
        definition, error = project_avatar_effect_definition(data["definition"])
        data = {**data, "definition": definition, "definition_error": error}
    return data


__all__ = [
    "AvatarEffectDefinitionError",
    "avatar_effect_projection_fields",
    "project_avatar_effect_definition",
    "AVATAR_EFFECT_SCHEMA_V1",
    "AVATAR_EFFECT_SCHEMA_V2",
    "AvatarEffectAppearance",
    "AvatarEffectArt",
    "AvatarEffectAttachment",
    "AvatarEffectDefinitionV2",
    "AvatarEffectEventOverride",
    "AvatarEffectFaceOptions",
    "AvatarEffectFlipbook",
    "AvatarEffectKeyframe",
    "AvatarEffectKeyframes",
    "AvatarEffectMotion",
    "BodyAttachment",
    "FaceLandmarkAttachment",
    "FaceSurfaceAttachment",
    "MAX_DEFINITION_BYTES",
    "MAX_FLIPBOOK_FRAMES",
    "MAX_FLIPBOOK_GRID",
    "MAX_KEYFRAMES",
    "SilhouetteAttachment",
    "StickerAttachment",
    "merge_avatar_effect_override",
]
