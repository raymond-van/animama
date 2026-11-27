from __future__ import annotations

import json
import struct
import wave
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import FastAPI

from animama.adapters.content_store import FilesystemContentStore
from animama.app.services.anima_runtime_service import AnimaRuntimeService
from animama.app.services.content_kind_registry import RuntimeProjectionInput, handler_for_kind
from animama.domain.content_catalog import (
    ContentKind,
    ContentSource,
    ContentStatus,
    ContentValidationError,
    PreparedPackageEntry,
    PreparedPackageFile,
)
from animama.domain.content_documents import ContentDocumentError
from animama.domain.request_principal import RequestPrincipal
from animama.product_http.routes.content import router as content_router
from animama.product_http.routes.loadouts import router as loadout_router
from animama.product_http.routes.typed_content import router as typed_router
from animama.server.config import Settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.local_runtime import initialize_local_runtime
from animama.server.schemas.runtime_content import PyAnimaRuntime
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports
from tests.typed_loadout_support import cleanup_loadout_fixture, create_loadout_fixture


def source_audio() -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\x00\x00" * 240)
    return output.getvalue()


def voice_catalog(value: float = 0.0) -> bytes:
    return struct.pack("<I32sII", 1, b"neutral", 1, 1024) + struct.pack("<1024f", *([value] * 1024))


def clone_document(name: str = "Narrator") -> dict[str, object]:
    return {
        "schema_version": 1,
        "content_type": "voice",
        "id": "local:voice:narrator",
        "name": name,
        "codec": "pocket-tts-catalog-v1",
        "voices": ["neutral"],
        "provenance": {"encoder": "pocket-tts", "format_version": 1},
        "files": [
            {"path": "original.wav", "role": "source_sample"},
            {"path": "voice.bin", "role": "pocket_voice_catalog"},
        ],
    }


def content_store(tmp_path: Path) -> FilesystemContentStore:
    for name in ("included", "local", "operations"):
        (tmp_path / name).mkdir(parents=True, exist_ok=True)
    return FilesystemContentStore(
        included_root=tmp_path / "included",
        local_root=tmp_path / "local",
        operations_root=tmp_path / "operations",
    )


@pytest.mark.parametrize("catalog_value", [float("nan"), float("inf"), float("-inf")])
def test_clone_save_rejects_nonfinite_embedding(tmp_path: Path, catalog_value: float) -> None:
    with pytest.raises(ContentValidationError):
        content_store(tmp_path).save_descriptor_entry(
            kind=ContentKind.VOICE,
            relative_locator="voices/narrator",
            descriptor=json.dumps(clone_document()).encode(),
            companion_files={"original.wav": source_audio(), "voice.bin": voice_catalog(catalog_value)},
            operation_id="invalid-embedding",
        )


def test_clone_runtime_projects_encoded_catalog_without_original() -> None:
    handler = handler_for_kind(ContentKind.VOICE)
    document = handler.parse_document(clone_document(), fallback_path=Path("voices/narrator"), descriptor_backed=True)
    catalog = {"file_ref": "catalog", "filename": "voice.bin", "role": "pocket_voice_catalog"}
    source = {"file_ref": "source", "filename": "original.wav", "role": "source_sample"}
    projected = handler.project_runtime(
        document.document,
        RuntimeProjectionInput(
            item_id="narrator",
            runtime_root_id="root-voice",
            slot_key="voice",
            source={"type": "catalog_item"},
            revision="a" * 64,
            context={},
            files=[source, catalog],
            logical_files={},
            dependency_files={},
            reference_map={},
        ),
    )
    assert projected.lane == "voice"
    assert projected.payload is not None
    assert projected.payload["files"] == [catalog]
    assert projected.payload["name"] == "Narrator"


def test_clone_scan_rejects_malformed_source_despite_valid_header(tmp_path: Path) -> None:
    folder = tmp_path / "local/voices/narrator"
    folder.mkdir(parents=True)
    (folder / "narrator.json").write_text(json.dumps(clone_document()))
    (folder / "original.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVE" + b"broken")
    (folder / "voice.bin").write_bytes(voice_catalog())
    scanned = content_store(tmp_path).scan(ContentSource.LOCAL)
    assert len(scanned) == 1
    assert scanned[0].status is ContentStatus.INVALID


def test_clone_save_rejects_zero_rate_audio_as_validation_error(tmp_path: Path) -> None:
    malformed = bytearray(source_audio())
    struct.pack_into("<II", malformed, 24, 0, 0)
    with pytest.raises(ContentValidationError):
        content_store(tmp_path).save_descriptor_entry(
            kind=ContentKind.VOICE,
            relative_locator="voices/narrator",
            descriptor=json.dumps(clone_document()).encode(),
            companion_files={"original.wav": bytes(malformed), "voice.bin": voice_catalog()},
            operation_id="invalid-sample-rate",
        )


@pytest.mark.parametrize(
    "files",
    [
        [{"path": "original.wav", "role": "source_sample"}],
        [{"path": "original.flac", "role": "source_sample"}, {"path": "voice.bin", "role": "pocket_voice_catalog"}],
        [{"path": "original.wav", "role": "source_sample"}, {"path": "voice.wav", "role": "pocket_voice_catalog"}],
        [{"path": "original.wav", "role": "source_sample"}, {"path": "voice.bin", "role": "source_sample"}],
    ],
)
def test_clone_descriptor_requires_exact_supported_source_and_catalog(files: list[dict[str, str]]) -> None:
    with pytest.raises(ContentDocumentError):
        handler_for_kind(ContentKind.VOICE).parse_document(
            {**clone_document(), "files": files},
            fallback_path=Path("voices/narrator"),
            descriptor_backed=True,
        )


def test_clone_scan_rejects_oversized_source(tmp_path: Path) -> None:
    folder = tmp_path / "local/voices/narrator"
    folder.mkdir(parents=True)
    (folder / "narrator.json").write_text(json.dumps(clone_document()))
    with (folder / "original.wav").open("wb") as source:
        source.write(source_audio())
        source.truncate(25 * 1024 * 1024 + 1)
    (folder / "voice.bin").write_bytes(voice_catalog())
    scanned = content_store(tmp_path).scan(ContentSource.LOCAL)
    assert scanned[0].status is ContentStatus.INVALID
    assert "pocket_clone_file_size" in {diagnostic.code for diagnostic in scanned[0].diagnostics}


def test_clone_save_retains_exact_original_and_rejects_extra_files(tmp_path: Path) -> None:
    store = content_store(tmp_path)
    companions = {"original.wav": source_audio(), "voice.bin": voice_catalog()}
    store.save_descriptor_entry(
        kind=ContentKind.VOICE,
        relative_locator="voices/narrator",
        descriptor=json.dumps(clone_document()).encode(),
        companion_files=companions,
        operation_id="save-clone",
    )
    assert (tmp_path / "local/voices/narrator/original.wav").read_bytes() == source_audio()
    assert store.scan(ContentSource.LOCAL)[0].status is ContentStatus.VALID
    with pytest.raises(ContentValidationError):
        store.save_descriptor_entry(
            kind=ContentKind.VOICE,
            relative_locator="voices/extra",
            descriptor=json.dumps(clone_document()).encode(),
            companion_files={**companions, "extra.wav": source_audio()},
            operation_id="extra-clone-file",
        )


def test_clone_package_rejects_invalid_embedding_before_promotion(tmp_path: Path) -> None:
    store = content_store(tmp_path)
    files = {
        "narrator.json": json.dumps(clone_document()).encode(),
        "original.wav": source_audio(),
        "voice.bin": voice_catalog(float("nan")),
    }
    with pytest.raises(ContentValidationError, match="non-finite"):
        store.install_package_atomic(
            entries=(
                PreparedPackageEntry(
                    kind=ContentKind.VOICE,
                    relative_locator="voices/narrator",
                    files=tuple(
                        PreparedPackageFile(relative_path=name, handle=BytesIO(payload), size_bytes=len(payload))
                        for name, payload in files.items()
                    ),
                ),
            ),
            operation_id="import-invalid-clone",
        )
    assert not (tmp_path / "local/voices/narrator").exists()


def test_legacy_neutral_catalog_stays_valid_and_projects_without_source(tmp_path: Path) -> None:
    store = content_store(tmp_path)
    (tmp_path / "local/voices").mkdir()
    (tmp_path / "local/voices/legacy.bin").write_bytes(voice_catalog())
    scanned = store.scan(ContentSource.LOCAL)
    assert scanned[0].status is ContentStatus.VALID
    handler = handler_for_kind(ContentKind.VOICE)
    document = handler.parse_document(None, fallback_path=Path("voices/legacy.bin"), descriptor_backed=False)
    catalog = {"file_ref": "legacy", "filename": "legacy.bin", "role": "audio"}
    projected = handler.project_runtime(
        document.document,
        RuntimeProjectionInput(
            item_id="legacy",
            runtime_root_id="root-voice",
            slot_key="voice",
            source={},
            revision="a" * 64,
            context={},
            files=[catalog],
            logical_files={},
            dependency_files={},
            reference_map={},
        ),
    )
    assert projected.payload is not None
    assert projected.payload["files"] == [catalog]


async def test_clone_library_retains_bytes_rename_ownership_and_protected_deletion(
    async_session,
    tmp_path: Path,
) -> None:
    fixture = await create_loadout_fixture(async_session)
    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    app = FastAPI()
    app.state.local_runtime_paths = paths
    for router in (content_router, typed_router, loadout_router):
        app.include_router(router)
    owner = [fixture.user_id]

    async def current_owner() -> RequestPrincipal:
        return RequestPrincipal(id=owner[0])

    async def session_override():
        yield async_session

    app.dependency_overrides[get_current_principal] = current_owner
    app.dependency_overrides[get_async_session] = session_override
    install_local_ports(app, async_session)
    client = local_client(app)
    companions = [
        ("files", ("original.wav", source_audio(), "audio/wav")),
        ("files", ("voice.bin", voice_catalog(), "application/octet-stream")),
    ]
    data = {
        "operation_id": "create-narrator",
        "descriptor_json": json.dumps(clone_document()),
        "companion_paths_json": json.dumps(["original.wav", "voice.bin"]),
    }
    try:
        created = await client.put("/v1/voice-content/narrator", data=data, files=companions)
        assert created.status_code == 200, created.text
        item = created.json()
        original = next(file for file in item["files"] if file["role"] == "source_sample")
        original_url = f"/v1/content/files/{original['file_ref']}"
        assert (await client.get(original_url)).content == source_audio()
        listed = (await client.get("/v1/voice-content")).json()["items"]
        assert item["item_id"] in {voice["item_id"] for voice in listed}

        renamed = await client.put(
            "/v1/voice-content/unchanged-path",
            data={
                **data,
                "operation_id": "rename-narrator",
                "descriptor_json": json.dumps(clone_document("Reader")),
                "catalog_item_id": item["item_id"],
                "expected_revision": item["revision_sha256"],
            },
            files=companions,
        )
        assert renamed.status_code == 200, renamed.text
        renamed_item = renamed.json()
        assert renamed_item["item_id"] == item["item_id"]
        assert renamed_item["name"] == "Reader"
        assert (paths.local_root / "voices/narrator/original.wav").read_bytes() == source_audio()
        delete_url = f"/v1/content/items/{item['item_id']}?expected_revision={renamed_item['revision_sha256']}"

        owner[0] = "foreign-owner"
        assert (await client.get(original_url)).status_code == 404
        assert (await client.get(f"/v1/voice-content/{item['item_id']}")).status_code == 404
        assert (await client.delete(delete_url)).status_code == 404
        owner[0] = fixture.user_id

        async def select(intent: dict[str, object], revision: int) -> int:
            request = {"expected_revision": revision, "intent": intent}
            planned = await client.post(f"/v1/animas/{fixture.anima_id}/voice:plan", json=request)
            assert planned.status_code == 200, planned.text
            committed = await client.post(
                f"/v1/animas/{fixture.anima_id}/voice:commit",
                json={**request, "plan_digest": planned.json()["plan_digest"], "idempotency_key": f"voice-{revision}"},
            )
            assert committed.status_code == 200, committed.text
            return int(committed.json()["revision"])

        revision = await select(
            {"operation": "set", "source": {"type": "catalog", "catalog_item_id": item["item_id"], "source": "local"}},
            1,
        )
        store = FilesystemContentStore(
            included_root=paths.included_root,
            local_root=paths.local_root,
            operations_root=paths.operations_root,
        )
        mounted = await AnimaRuntimeService(async_session, store=store).issue(
            user_id=fixture.user_id,
            anima_id=fixture.anima_id,
        )
        runtime = PyAnimaRuntime.model_validate(mounted)
        assert runtime.voice is not None
        assert runtime.voice.name == "Reader"
        assert [file.role for file in runtime.voice.files] == ["pocket_voice_catalog"]
        assert runtime.voice.files[0].url.startswith(f"/v1/animas/{fixture.anima_id}/runtime/revisions/")
        assert any(member.role == "source_sample" for member in runtime.content_descriptor.members)
        # A newly constructed runtime service reads durable catalog/binding state.
        reloaded = await AnimaRuntimeService(async_session, store=store).issue(
            user_id=fixture.user_id,
            anima_id=fixture.anima_id,
        )
        assert reloaded["voice"] == mounted["voice"]
        blocked = await client.delete(delete_url)
        assert blocked.status_code == 409, blocked.text
        assert blocked.json()["detail"] == {
            "code": "catalog_item_in_use",
            "used_by": [{"kind": "anima_voice", "id": fixture.anima_id, "name": fixture.anima_id}],
        }
        await select({"operation": "remove"}, revision)
        assert (await client.delete(delete_url)).status_code == 204
        assert (await client.get(original_url)).status_code == 404
    finally:
        await client.aclose()
        await cleanup_loadout_fixture(async_session, fixture)
