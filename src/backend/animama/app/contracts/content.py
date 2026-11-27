"""HTTP representations for the readable self-hosted content catalog."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from animama.app.services.content_file_urls import content_file_url
from animama.app.services.content_portability import Portability, portability
from animama.domain.content_catalog import (
    CatalogContentEntry,
    ContentPreview,
    ContentScanSummary,
    ContentUsage,
    ContentUsageKind,
    SavedContent,
)


def _preview_metadata(
    item: CatalogContentEntry,
    preview: ContentPreview,
) -> dict[str, Any]:
    """Add transport-only logical file identities to readable metadata."""

    metadata = dict(item.metadata)
    if isinstance(metadata.get("logical_resource_files"), dict):
        return metadata
    prefix = f"{item.relative_locator.rstrip('/')}/"
    logical_files: dict[str, dict[str, Any]] = {}
    for ordinal, file in enumerate(preview.files, start=1):
        if file.role in {"descriptor", "manifest", "metadata"}:
            continue
        logical_name = file.relative_path.removeprefix(prefix)
        if logical_name == file.relative_path:
            logical_name = file.relative_path.rsplit("/", 1)[-1]
        logical_files[logical_name] = {"role": file.role, "ordinal": ordinal}
    if logical_files:
        metadata["logical_resource_files"] = logical_files
    return metadata


class PyContentDiagnostic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    relative_path: str | None = None


class PyContentFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_ref: str
    relative_path: str
    role: str
    media_type: str
    size_bytes: int
    sha256: str
    ordinal: int
    filename: str
    # Where to read the bytes: an Included file's URL names its digest (ADR 0033).
    url: str


class PyContentSelection(BaseModel):
    """Stable logical selection used by creators and Anima loadouts."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["catalog"] = "catalog"
    catalog_item_id: str
    logical_key: str | None


class PyContentItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str
    source: Literal["included", "local"]
    scope: Literal["included", "owner", "installation_shared"]
    kind: str
    relative_locator: str
    logical_key: str | None
    display_name: str
    status: Literal["valid", "invalid", "missing", "scan_required"]
    revision_sha256: str | None
    dependencies: list[str]
    provenance: dict[str, Any]
    metadata: dict[str, Any]
    diagnostics: list[PyContentDiagnostic]
    files: list[PyContentFile]
    scanned_at: datetime | None
    name: str
    description: str | None
    semantic_key: str | None
    implementation_kind: str | None
    origin: Literal["included", "local"]
    editable: bool
    portability: Portability = "portable"
    selection: PyContentSelection

    @classmethod
    def from_domain(cls, item: CatalogContentEntry) -> PyContentItem:
        description = item.metadata.get("description")
        implementation = item.metadata.get("implementation")
        implementation_kind = (
            implementation.get("kind")
            if isinstance(implementation, dict) and isinstance(implementation.get("kind"), str)
            else item.metadata.get("implementation_kind")
        )
        return cls(
            item_id=item.id,
            source=item.source.value,
            scope=item.scope.value,
            kind=item.kind.value,
            relative_locator=item.relative_locator,
            logical_key=item.logical_key,
            display_name=item.display_name,
            status=item.status.value,
            revision_sha256=item.revision_sha256,
            dependencies=list(item.dependencies),
            provenance=item.provenance,
            metadata=item.metadata,
            diagnostics=[
                PyContentDiagnostic(
                    code=diagnostic.code,
                    message=diagnostic.message,
                    relative_path=diagnostic.relative_path,
                )
                for diagnostic in item.diagnostics
            ],
            files=[
                PyContentFile(
                    file_ref=file.file_ref,
                    relative_path=file.relative_path,
                    role=file.role,
                    media_type=file.media_type,
                    size_bytes=file.size_bytes,
                    sha256=file.sha256,
                    ordinal=index,
                    filename=file.relative_path.rsplit("/", 1)[-1],
                    url=content_file_url(file_ref=file.file_ref, sha256=file.sha256, source=file.source),
                )
                for index, file in enumerate(item.files, start=1)
            ],
            scanned_at=item.scanned_at,
            name=item.display_name,
            description=description if isinstance(description, str) else None,
            semantic_key=(
                item.metadata.get("semantic_key") if isinstance(item.metadata.get("semantic_key"), str) else None
            ),
            implementation_kind=implementation_kind if isinstance(implementation_kind, str) else None,
            origin=item.source.value,
            editable=item.source.value == "local",
            portability=portability(item),
            selection=PyContentSelection(
                catalog_item_id=item.id,
                logical_key=item.logical_key,
            ),
        )


class PyContentCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scan_required: bool
    items: list[PyContentItem]


class PyContentUsage(BaseModel):
    """One thing that keeps an owned item from being deleted.

    ``anima_avatar``, ``anima_appearance`` (profile or background),
    ``anima_voice``, ``anima_gesture``, ``anima_idle`` (an Idle pool member),
    ``anima_reaction`` (a Reaction cell member) and ``anima_music`` name the
    Anima by ``id`` and ``name``; ``content`` names the catalog item that
    depends on it.
    """

    model_config = ConfigDict(extra="forbid")

    kind: ContentUsageKind
    id: str
    name: str

    @classmethod
    def from_domain(cls, use: ContentUsage) -> PyContentUsage:
        return cls(kind=use.kind, id=use.id, name=use.name)


class PyContentItemUsage(BaseModel):
    """What uses an owned item, at most ten uses with Anima uses first; empty when unused."""

    model_config = ConfigDict(extra="forbid")

    item_id: str
    used_by: list[PyContentUsage]


class PyContentScanSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["included", "local"]
    scanned: int
    valid: int
    invalid: int
    missing: int

    @classmethod
    def from_domain(cls, summary: ContentScanSummary) -> PyContentScanSummary:
        return cls(
            source=summary.source.value,
            scanned=summary.scanned,
            valid=summary.valid,
            invalid=summary.invalid,
            missing=summary.missing,
        )


class PyContentRescan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summaries: list[PyContentScanSummary]
    catalog: PyContentCatalog


class PyContentSaveResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: str
    item: PyContentItem

    @classmethod
    def from_domain(cls, saved: SavedContent) -> PyContentSaveResult:
        return cls(
            operation_id=saved.operation_id,
            item=PyContentItem.from_domain(saved.item),
        )


class PyContentPreviewFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_ref: str
    role: str
    ordinal: int
    filename: str
    media_type: str
    size_bytes: int
    sha256: str
    url: str


class PyContentPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: str
    item_id: str
    revision: str
    revision_sha256: str
    expires_at: datetime
    files: list[PyContentPreviewFile]
    item: PyContentItem
    metadata: dict[str, Any]

    @classmethod
    def from_domain(cls, preview: ContentPreview, item: CatalogContentEntry) -> PyContentPreview:
        return cls(
            preview_id=preview.id,
            item_id=preview.item_id,
            revision_sha256=preview.revision_sha256,
            expires_at=preview.expires_at,
            files=[
                PyContentPreviewFile(
                    file_ref=file.file_ref,
                    role=file.role,
                    ordinal=index,
                    filename=file.relative_path.rsplit("/", 1)[-1],
                    media_type=file.media_type,
                    size_bytes=file.size_bytes,
                    sha256=file.sha256,
                    url=(
                        f"/v1/content/previews/{preview.id}/revisions/{preview.revision_sha256}/files/{file.file_ref}"
                    ),
                )
                for index, file in enumerate(preview.files, start=1)
            ],
            revision=preview.revision_sha256,
            item=PyContentItem.from_domain(item),
            metadata=_preview_metadata(item, preview),
        )


__all__ = [name for name in globals() if name.startswith("Py")]
