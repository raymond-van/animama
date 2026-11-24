"""Discriminated HTTP contracts for editable typed catalog content."""

from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from animama.app.anima_creation_contract import (
    ItemId,
    ItemRevisionRef,
    RevisionSha256,
    SourceKind,
    SourceRevision,
    StrictCreationModel,
)
from animama.app.contracts.avatar_effect import (
    AvatarEffectDefinitionError,
    AvatarEffectDefinitionV2,
    avatar_effect_projection_fields,
)
from animama.app.contracts.avatar_face_parts import AvatarFacePartCorrection
from animama.app.contracts.idle import PyIdlePlayback
from animama.app.services.avatar_face_parts import local_face_parts
from animama.app.services.content_file_urls import content_file_url
from animama.app.services.content_portability import Portability, portability
from animama.app.services.runtime_budget_policy import MAX_RUNTIME_ENTRIES
from animama.app.services.typed_content_batch_service import (
    BuiltinTypedRoot,
    CatalogTypedRoot,
    ResolvedTypedRoot,
    TypedBatchDiagnostic,
    TypedBatchResolution,
)
from animama.app.services.typed_content_service import TypedCatalogItem, TypedContentPreview
from animama.domain.anima_loadout import ReactionIntensity
from animama.domain.content_catalog import CatalogContentFile, ContentPreview, optional_omitted_references
from animama.domain.content_documents import (
    AppearanceDocumentV1,
    AvatarDocumentV1,
    AvatarEffectDocumentV1,
    GestureDocumentV1,
    MusicTrackDocumentV1,
    ParticleEffectDocumentV1,
    PoseClipDocumentV1,
    PoseDocumentV1,
    ReactionDocumentV1,
    SceneEffectDocumentV1,
    SoundEffectDocumentV1,
    VoiceDocumentV1,
)


class PyTypedDependency(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str
    item_id: str | None = None
    kind: Literal[
        "avatar",
        "gesture",
        "pose",
        "reaction",
        "particle_effect",
        "avatar_effect",
        "scene_effect",
        "sound_effect",
        "appearance",
        "voice",
    ]
    alias: str | None = None
    config: dict[str, object] = Field(default_factory=dict)


class PyTypedContentFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_ref: str
    logical_path: str
    role: str
    ordinal: int = Field(ge=1)
    filename: str
    media_type: str
    size_bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    # Where to read the bytes: an Included file's URL names its digest (ADR 0033).
    url: str

    @classmethod
    def from_domain(
        cls,
        value: CatalogContentFile,
        ordinal: int,
        *,
        entry_root: PurePosixPath,
    ) -> PyTypedContentFile:
        return cls(
            file_ref=value.file_ref,
            logical_path=_logical_path(value.relative_path, entry_root=entry_root),
            role=value.role,
            ordinal=ordinal,
            filename=value.relative_path.rsplit("/", 1)[-1],
            media_type=value.media_type,
            size_bytes=value.size_bytes,
            sha256=value.sha256,
            url=content_file_url(file_ref=value.file_ref, sha256=value.sha256, source=value.source),
        )


def _entry_root(value: TypedCatalogItem) -> PurePosixPath:
    """Return the portable directory against which an item's files are named."""

    locator = PurePosixPath(value.item.relative_locator)
    standalone = any(file.relative_path == value.item.relative_locator for file in value.item.files)
    return locator.parent if standalone else locator


def _logical_path(relative_path: str, *, entry_root: PurePosixPath) -> str:
    """Project a catalog path to the safe item-relative name used by documents."""

    path = PurePosixPath(relative_path)
    try:
        return path.relative_to(entry_root).as_posix()
    except ValueError:
        # Catalog containment already validates the physical path. This fallback
        # keeps legacy standalone/sidecar entries readable without exposing a
        # host path if their catalog locator predates the canonical layout.
        return path.name


class PyTypedContentBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str
    source: Literal["included", "local"]
    logical_key: str | None = None
    name: str
    description: str | None = None
    revision_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    editable: bool
    portability: Portability = "portable"
    dependencies: list[PyTypedDependency] = Field(default_factory=list)
    files: list[PyTypedContentFile] = Field(default_factory=list)


class PyActionImplementation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["anima_clip", "vrma"]
    file_role: str | None = None
    content_dependency_ref: str | None = None


class PyGesture(PyTypedContentBase):
    kind: Literal["gesture"] = "gesture"
    semantic_key: str
    implementation: PyActionImplementation
    config: dict[str, object] = Field(default_factory=dict)


class PyReaction(PyTypedContentBase):
    """A Reaction; ``emotion`` and ``intensity`` are its suggested cell, never a restriction."""

    kind: Literal["reaction"] = "reaction"
    emotion: str | None = None
    intensity: ReactionIntensity | None = None
    implementation: PyActionImplementation
    config: dict[str, object] = Field(default_factory=dict)


class PyPose(PyTypedContentBase):
    """Static Pose metadata; full values are delivered through registered bytes."""

    kind: Literal["pose"] = "pose"
    pose_id: str


class _LegacyPoseClip(PyTypedContentBase):
    kind: Literal["pose_clip"] = "pose_clip"
    clip_id: str
    role: str | None = None
    playback: dict[str, object] = Field(default_factory=dict)


class PyParticleEffect(PyTypedContentBase):
    kind: Literal["particle_effect"] = "particle_effect"
    runtime_defaults: dict[str, object] = Field(default_factory=dict)
    definition: dict[str, object] | None = None


class PyAvatarEffect(PyTypedContentBase):
    """An Avatar Effect; an unreadable stored definition is reported, not raised."""

    kind: Literal["avatar_effect"] = "avatar_effect"
    runtime_defaults: dict[str, object] = Field(default_factory=dict)
    technical_source: dict[str, object] | None = None
    definition: AvatarEffectDefinitionV2 | None = None
    definition_error: AvatarEffectDefinitionError | None = None

    @model_validator(mode="before")
    @classmethod
    def _project_definition(cls, data: Any) -> Any:
        return avatar_effect_projection_fields(data)


class PySceneEffect(PyTypedContentBase):
    kind: Literal["scene_effect"] = "scene_effect"
    runtime_defaults: dict[str, object] = Field(default_factory=dict)
    technical_source: dict[str, object] | None = None
    definition: dict[str, object] | None = None


class PySoundEffect(PyTypedContentBase):
    kind: Literal["sound_effect"] = "sound_effect"
    duration_seconds: float | None = None
    codec: str | None = None
    defaults: dict[str, object] = Field(default_factory=dict)


class _LegacyMusicTrack(PyTypedContentBase):
    kind: Literal["music_track"] = "music_track"
    duration_seconds: float = Field(ge=0)
    codec: str
    loop: bool
    gain: float = Field(ge=0, le=2)
    autoplay: bool


class PyAvatarPortrait(BaseModel):
    """An Avatar's portrait image and the capture it came from."""

    url: str
    # The Avatar revision a Local capture was made from; null for shipped and imported portraits.
    avatar_revision_sha256: str | None = None
    renderer_version: int | None = None
    capture_preset_version: int | None = None


class PyAvatarContent(PyTypedContentBase):
    kind: Literal["avatar"] = "avatar"
    model_role: Literal["model"] = "model"
    compatibility: dict[str, object] = Field(default_factory=dict)
    # The effective face-part correction for this revision and VRM, if any.
    face_parts: AvatarFacePartCorrection | None = None
    # List and Get overlay the caller's portrait; Preview and Save responses leave it null.
    portrait: PyAvatarPortrait | None = None


class PyAppearance(PyTypedContentBase):
    kind: Literal["appearance"] = "appearance"
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    avatar_model: str | None = None
    presentation: dict[str, object] = Field(default_factory=dict)


class PyVoiceContent(PyTypedContentBase):
    kind: Literal["voice"] = "voice"
    codec: str | None = None
    language: str | None = None
    sample_rate_hz: int | None = Field(default=None, gt=0)
    voices: list[str] = Field(default_factory=list)


PyTypedContent = Annotated[
    PyGesture
    | PyReaction
    | PyPose
    | PyParticleEffect
    | PyAvatarEffect
    | PySceneEffect
    | PySoundEffect
    | PyAvatarContent
    | PyAppearance
    | PyVoiceContent,
    Field(discriminator="kind"),
]


def _base(value: TypedCatalogItem) -> dict[str, object]:
    item = value.item
    document = value.document
    entry_root = _entry_root(value)
    return {
        "item_id": item.id,
        "source": item.source.value,
        "logical_key": item.logical_key,
        "name": document.name,
        "description": document.description,
        "revision_sha256": item.revision_sha256 or "",
        "editable": item.source.value == "local",
        "portability": portability(item),
        "dependencies": [
            PyTypedDependency(
                ref=dependency.ref,
                item_id=value.dependency_ids.get(dependency.ref),
                kind=dependency.kind.value,
                alias=dependency.alias,
                config=dependency.config,
            )
            for dependency in document.dependencies
        ],
        "files": [
            PyTypedContentFile.from_domain(
                file,
                ordinal,
                entry_root=entry_root,
            )
            for ordinal, file in enumerate(item.files, start=1)
        ],
    }


def legacy_saved_content_response(value: TypedCatalogItem) -> dict[str, object]:
    """Project a stored Save snapshot without re-admitting historical dependencies."""

    document = value.document
    clean = replace(value, document=replace(document, dependencies=()))
    base = _base(clean)
    if isinstance(document, PoseClipDocumentV1):
        result = _LegacyPoseClip(
            **base, clip_id=document.clip_id, role=document.role, playback=document.playback
        ).model_dump(mode="json")
    elif isinstance(document, MusicTrackDocumentV1):
        result = _LegacyMusicTrack(
            **base,
            duration_seconds=document.duration_seconds,
            codec=document.codec,
            loop=document.loop,
            gain=document.gain,
            autoplay=document.autoplay,
        ).model_dump(mode="json")
    else:
        result = typed_content_response(clean).model_dump(mode="json")
    result["dependencies"] = [
        {
            "ref": dependency.ref,
            "item_id": None,
            "kind": dependency.kind.value,
            "alias": dependency.alias,
            "config": dependency.config,
        }
        for dependency in document.dependencies
    ]
    return result


def typed_content_response(value: TypedCatalogItem) -> PyTypedContent:
    """Map a strict domain document to its generated discriminated contract."""

    document = value.document
    base = _base(value)
    if isinstance(document, GestureDocumentV1):
        return PyGesture(
            **base,
            semantic_key=document.semantic_key,
            implementation=PyActionImplementation(
                kind=document.implementation.kind,
                file_role=document.implementation.file_role,
                content_dependency_ref=document.implementation.content_dependency_ref,
            ),
            config=document.config,
        )
    if isinstance(document, ReactionDocumentV1):
        return PyReaction(
            **base,
            emotion=document.emotion,
            intensity=document.intensity,
            implementation=PyActionImplementation(
                kind=document.implementation.kind,
                file_role=document.implementation.file_role,
                content_dependency_ref=document.implementation.content_dependency_ref,
            ),
            config=document.config,
        )
    if isinstance(document, PoseDocumentV1):
        return PyPose(**base, pose_id=document.pose["id"])
    if isinstance(document, ParticleEffectDocumentV1):
        return PyParticleEffect(
            **base,
            runtime_defaults=document.runtime_defaults,
            definition=document.definition,
        )
    if isinstance(document, AvatarEffectDocumentV1):
        return PyAvatarEffect(
            **base,
            runtime_defaults=document.runtime_defaults,
            technical_source=document.technical_source,
            definition=document.definition,
        )
    if isinstance(document, SceneEffectDocumentV1):
        return PySceneEffect(
            **base,
            runtime_defaults=document.runtime_defaults,
            technical_source=document.technical_source,
            definition=document.definition,
        )
    if isinstance(document, SoundEffectDocumentV1):
        return PySoundEffect(
            **base,
            duration_seconds=document.duration_seconds,
            codec=document.codec,
            defaults=document.defaults,
        )
    if isinstance(document, AvatarDocumentV1):
        # Typed family routes overlay the caller's Included override; this is the Local sidecar.
        return PyAvatarContent(
            **base,
            compatibility=document.compatibility,
            face_parts=local_face_parts(
                source=value.item.source, document_face_parts=document.face_parts, files=value.item.files
            ),
        )
    if isinstance(document, AppearanceDocumentV1):
        return PyAppearance(
            **base,
            width=document.width,
            height=document.height,
            avatar_model=document.avatar_model,
            presentation=document.presentation,
        )
    if isinstance(document, VoiceDocumentV1):
        return PyVoiceContent(
            **base,
            codec=document.codec,
            language=document.language,
            sample_rate_hz=document.sample_rate_hz,
            voices=list(document.voices),
        )
    raise TypeError(f"Unsupported typed document: {type(document).__name__}")


class PyGesturePage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyGesture]


class PyReactionPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyReaction]


class PyPosePage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyPose]


class PyParticleEffectPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyParticleEffect]


class PyAvatarEffectPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyAvatarEffect]


class PySceneEffectPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PySceneEffect]


class PySoundEffectPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PySoundEffect]


class PyAvatarContentPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyAvatarContent]


class PyAppearancePage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyAppearance]


class PyVoiceContentPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PyVoiceContent]


class PyTypedPreviewFile(PyTypedContentFile):
    url: str


class PyTypedContentPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: str
    revision_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    expires_at: datetime
    item: PyTypedContent
    supports: list[PyTypedContent] = Field(default_factory=list)
    files: list[PyTypedPreviewFile]
    expected_source_revisions: dict[str, SourceRevision] = Field(default_factory=dict)
    idle_playback: dict[str, PyIdlePlayback] = Field(default_factory=dict)
    # Alias → ref of each optional dependency of ``item`` (a sound in a pack this
    # installation lacks) dropped from its ``dependencies``; it plays without them.
    optional_omitted: dict[str, str] = Field(default_factory=dict)

    @classmethod
    def from_domain(cls, value: TypedContentPreview) -> PyTypedContentPreview:
        preview = value.preview
        typed_items = (value.item, *value.supports)
        logical_paths_by_ref = {
            file.file_ref: _logical_path(file.relative_path, entry_root=_entry_root(item))
            for item in typed_items
            for file in item.item.files
        }
        return cls(
            preview_id=preview.id,
            revision_sha256=preview.revision_sha256,
            expires_at=preview.expires_at,
            item=typed_content_response(value.item),
            supports=[typed_content_response(item) for item in value.supports],
            expected_source_revisions=_source_revisions(typed_items),
            optional_omitted=optional_omitted_references(value.item.item.provenance),
            idle_playback={
                ref: PyIdlePlayback.model_validate(asdict(facts)) for ref, facts in value.idle_playback.items()
            },
            files=[
                PyTypedPreviewFile(
                    file_ref=file.file_ref,
                    logical_path=logical_paths_by_ref.get(
                        file.file_ref,
                        PurePosixPath(file.relative_path).name,
                    ),
                    role=file.role,
                    ordinal=ordinal,
                    filename=file.relative_path.rsplit("/", 1)[-1],
                    media_type=file.media_type,
                    size_bytes=file.size_bytes,
                    sha256=file.sha256,
                    url=(
                        f"/v1/content/previews/{preview.id}/revisions/{preview.revision_sha256}/files/{file.file_ref}"
                    ),
                )
                for ordinal, file in enumerate(preview.files, start=1)
            ],
        )


class PyContentEvidenceRootRequest(StrictCreationModel):
    kind: SourceKind
    source: ItemRevisionRef


class PyContentEvidenceRequest(StrictCreationModel):
    schema_version: Literal[1]
    roots: list[PyContentEvidenceRootRequest] = Field(min_length=1, max_length=MAX_RUNTIME_ENTRIES)


class PyCatalogPreviewSource(StrictCreationModel):
    type: Literal["catalog"]
    catalog_item_id: ItemId


class PyBuiltinPreviewSource(StrictCreationModel):
    type: Literal["builtin"]
    content_id: str = Field(min_length=1, max_length=192, pattern=r"^[A-Za-z0-9][A-Za-z0-9:._-]*$")
    version: int = Field(ge=1)


PyPreviewSource = Annotated[PyCatalogPreviewSource | PyBuiltinPreviewSource, Field(discriminator="type")]


class PyContentPreviewRootRequest(StrictCreationModel):
    kind: SourceKind
    source: PyPreviewSource


class PyContentPreviewsPrepareRequest(StrictCreationModel):
    schema_version: Literal[1]
    roots: list[PyContentPreviewRootRequest] = Field(min_length=1, max_length=MAX_RUNTIME_ENTRIES)


class PyTypedBatchDiagnostic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root_key: str
    code: str
    message: str
    item_id: str | None = None
    expected_revision_sha256: RevisionSha256 | None = None
    current_revision_sha256: RevisionSha256 | None = None

    @classmethod
    def from_domain(cls, value: TypedBatchDiagnostic) -> PyTypedBatchDiagnostic:
        return cls(**{field: getattr(value, field) for field in cls.model_fields})


_SOURCE_KINDS = frozenset(get_args(SourceKind))


def _source_revisions(values: tuple[TypedCatalogItem, ...]) -> dict[str, SourceRevision]:
    """Pin every item an Anima creation request can name.

    Creation rebuilds the closure of each selected source and requires the
    submitted map to name exactly the same items, so this reports every kind the
    creation contract accepts. Other kinds have no ``SourceRevision``.
    """

    return {
        value.item.id: SourceRevision.model_validate(
            {"kind": value.item.kind.value, "revision_sha256": value.item.revision_sha256}
        )
        for value in values
        if value.item.kind.value in _SOURCE_KINDS
    }


class PyContentEvidenceRoot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root_key: str
    kind: SourceKind
    source: ItemRevisionRef
    expected_source_revisions: dict[str, SourceRevision]

    @classmethod
    def from_domain(cls, value: ResolvedTypedRoot) -> PyContentEvidenceRoot:
        return cls(
            root_key=value.key,
            kind=value.item.item.kind.value,
            source=ItemRevisionRef.model_validate(
                {"item_id": value.item.item.id, "revision_sha256": value.item.item.revision_sha256}
            ),
            expected_source_revisions=_source_revisions(value.closure),
        )


class PyContentEvidenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    complete: bool
    roots: list[PyContentEvidenceRoot]
    combined_expected_source_revisions: dict[str, SourceRevision]
    diagnostics: list[PyTypedBatchDiagnostic]

    @classmethod
    def from_domain(cls, value: TypedBatchResolution) -> PyContentEvidenceResponse:
        return cls(
            complete=value.complete,
            roots=[PyContentEvidenceRoot.from_domain(root) for root in value.roots],
            combined_expected_source_revisions=_source_revisions(value.entries),
            diagnostics=[PyTypedBatchDiagnostic.from_domain(item) for item in value.diagnostics],
        )


class PyPreparedPreviewRoot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root_key: str
    kind: SourceKind
    source: PyPreviewSource
    item_id: str
    closure_item_ids: list[str]

    @classmethod
    def from_domain(cls, value: ResolvedTypedRoot) -> PyPreparedPreviewRoot:
        locator = value.locator
        if isinstance(locator, CatalogTypedRoot):
            source: PyPreviewSource = PyCatalogPreviewSource(
                type="catalog",
                catalog_item_id=locator.item_id,
            )
        elif isinstance(locator, BuiltinTypedRoot):
            source = PyBuiltinPreviewSource(
                type="builtin",
                content_id=locator.content_id,
                version=locator.version,
            )
        else:  # pragma: no cover - closed internal union
            raise TypeError("Unsupported typed root locator")
        return cls(
            root_key=value.key,
            kind=value.item.item.kind.value,
            source=source,
            item_id=value.item.item.id,
            closure_item_ids=[item.item.id for item in value.closure],
        )


def _preview_files(
    preview: ContentPreview,
    typed_items: tuple[TypedCatalogItem, ...],
) -> list[PyTypedPreviewFile]:
    logical_paths_by_ref = {
        file.file_ref: _logical_path(file.relative_path, entry_root=_entry_root(item))
        for item in typed_items
        for file in item.item.files
    }
    return [
        PyTypedPreviewFile(
            file_ref=file.file_ref,
            logical_path=logical_paths_by_ref.get(file.file_ref, PurePosixPath(file.relative_path).name),
            role=file.role,
            ordinal=ordinal,
            filename=file.relative_path.rsplit("/", 1)[-1],
            media_type=file.media_type,
            size_bytes=file.size_bytes,
            sha256=file.sha256,
            url=f"/v1/content/previews/{preview.id}/revisions/{preview.revision_sha256}/files/{file.file_ref}",
        )
        for ordinal, file in enumerate(preview.files, start=1)
    ]


class PyPreparedPreviewLease(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: str
    revision_sha256: RevisionSha256
    expires_at: datetime
    files: list[PyTypedPreviewFile]


class PyContentPreviewsPrepareResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    complete: bool
    roots: list[PyPreparedPreviewRoot]
    items: list[PyTypedContent]
    diagnostics: list[PyTypedBatchDiagnostic]
    lease: PyPreparedPreviewLease | None

    @classmethod
    def from_domain(
        cls,
        value: TypedBatchResolution,
        preview: ContentPreview | None,
    ) -> PyContentPreviewsPrepareResponse:
        return cls(
            complete=value.complete,
            roots=[PyPreparedPreviewRoot.from_domain(root) for root in value.roots],
            items=[typed_content_response(item) for item in value.entries],
            diagnostics=[PyTypedBatchDiagnostic.from_domain(item) for item in value.diagnostics],
            lease=(
                PyPreparedPreviewLease(
                    preview_id=preview.id,
                    revision_sha256=preview.revision_sha256,
                    expires_at=preview.expires_at,
                    files=_preview_files(preview, value.entries),
                )
                if preview is not None
                else None
            ),
        )


__all__ = [name for name in globals() if name.startswith("Py") or name == "typed_content_response"]
