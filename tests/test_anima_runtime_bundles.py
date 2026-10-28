"""Optional delivery bundles retain exact-file authority and fault isolation."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI

from animama.adapters.content_store import FilesystemContentStore
from animama.app.services.anima_runtime_service import RuntimeFileAuthorization, RuntimeSnapshotError, _runtime_response
from animama.domain.content_catalog import ContentSource
from animama.domain.request_principal import RequestPrincipal
from animama.domain.runtime_bundles import (
    BINARY_BUNDLE_MAGIC,
    MAX_RUNTIME_BUNDLES,
    runtime_bundle_id,
    select_runtime_bundles,
)
from animama.product_http.delivery import encoded_json_response
from animama.product_http.ports import install_product_ports
from animama.product_http.principal import get_current_principal
from animama.product_http.routes import anima_runtime
from animama.server.config import Settings
from animama.server.local_runtime import initialize_local_runtime
from animama.server.product_ports import local_file_response
from tests.local_http_client import local_client


def _member(
    ref: str, *, size: int = 20, role: str = "sequence", media_type: str = "application/json"
) -> dict[str, Any]:
    return {"file_ref": ref, "role": role, "media_type": media_type, "size_bytes": size}


def _catalog(count: int = 3, size: int = 20) -> dict[str, Any]:
    members = [_member(f"file-{index:03}", size=size) for index in range(count)]
    return {
        "avatar": {"runtime_root_id": "avatar", "files": [members[0]]},
        "gestures": [{"files": members[1:]}],
        "content_descriptor": {"members": members, "roots": [{"root_id": "avatar", "member_refs": ["file-000"]}]},
    }


def _refs(catalog: dict[str, Any]) -> list[tuple[str, list[str]]]:
    return [(bundle.format, bundle.file_refs) for bundle in select_runtime_bundles(catalog)]


def test_selection_puts_idle_first_and_leaves_out_essential_control_and_unprojected_files() -> None:
    members = [
        _member("avatar-model", media_type="model/gltf-binary"),
        _member("avatar-texture", role="texture", media_type="image/png"),
        _member("voice-catalog", role="pocket_voice_catalog", media_type="application/octet-stream"),
        _member("voice-clip"),
        *[_member(f"idle-{index}") for index in range(2)],
        *[_member(f"idle-image-{index}", role="texture", media_type="image/png") for index in range(2)],
        *[_member(f"wave-{index}") for index in range(2)],
        *[_member(f"wave-image-{index}", role="texture", media_type="image/png") for index in range(2)],
        _member("wave-descriptor", role="descriptor"),
        _member("wave-meta", role="meta"),
        _member("wave-vrma", media_type="application/octet-stream"),
        _member("unprojected"),
    ]
    by_ref = {member["file_ref"]: member for member in members}

    def files(*refs: str) -> list[dict[str, Any]]:
        return [by_ref[ref] for ref in refs]

    roots = [
        {"root_id": "avatar", "member_refs": ["avatar-model", "avatar-texture"]},
        {"root_id": "voice", "member_refs": ["voice-catalog", "voice-clip"]},
        {"root_id": "idle", "member_refs": ["idle-0", "idle-1", "idle-image-0", "idle-image-1"]},
    ]
    catalog: dict[str, Any] = {
        "avatar": {"runtime_root_id": "avatar", "files": files("avatar-model")},
        "voice": {"runtime_root_id": "voice", "files": files("voice-catalog")},
        "idle": {"gestures": [{"runtime_root_id": "idle", "files": files("idle-0", "idle-1", "idle-image-0")}]},
        "gestures": [
            # A projected file of the voice and Idle closures, shared with a Gesture.
            {"files": files("voice-clip", "idle-image-1", "wave-0", "wave-1", "wave-image-0", "wave-image-1")},
            {"files": files("wave-descriptor", "wave-meta", "wave-vrma", "avatar-texture")},
        ],
        "content_descriptor": {"members": members, "roots": roots},
    }
    expected = [
        ("json", ["idle-0", "idle-1"]),
        ("binary", ["idle-image-0", "idle-image-1"]),
        ("json", ["wave-0", "wave-1"]),
        ("binary", ["wave-image-0", "wave-image-1"]),
    ]
    assert _refs(catalog) == expected
    catalog["content_descriptor"]["members"].reverse()
    assert _refs(catalog) == expected


def test_selection_packs_next_fit_within_each_format_limit() -> None:
    assert _refs(_catalog(2)) == []
    assert [len(refs) for _, refs in _refs(_catalog(301))] == [256, 44]
    assert [len(refs) for _, refs in _refs(_catalog(21, 256 * 1024))] == [8, 8, 4]
    assert _refs(_catalog(3, 256 * 1024 + 1)) == []
    images = _catalog(67, 1024)
    for member in images["content_descriptor"]["members"][1:]:
        member.update(role="texture", media_type="image/webp")
    # 64 members fill one bundle; the two left over make another.
    assert [(format, len(refs)) for format, refs in _refs(images)] == [("binary", 64), ("binary", 2)]
    large = _catalog(4, 512 * 1024 + 1)
    for member in large["content_descriptor"]["members"][1:]:
        member["media_type"] = "image/png"
    assert _refs(large) == []
    # Sixty-six full binary bundles are cut at the per-revision limit.
    many = _catalog(1 + 66 * 64, 1024)
    for member in many["content_descriptor"]["members"][1:]:
        member.update(role="texture", media_type="image/png")
    assert len(select_runtime_bundles(many)) == MAX_RUNTIME_BUNDLES


def test_a_bundle_id_names_its_format_and_member_set() -> None:
    [bundle] = select_runtime_bundles(_catalog())
    assert (
        bundle.id == runtime_bundle_id("json", ["file-002", "file-001"]) == runtime_bundle_id("json", bundle.file_refs)
    )
    assert bundle.id != runtime_bundle_id("binary", bundle.file_refs)
    assert bundle.id != runtime_bundle_id("json", ["file-001"])


def test_issuance_advertises_bundles_without_mutating_the_persisted_catalog() -> None:
    catalog = _catalog()
    [bundle] = select_runtime_bundles(catalog)
    issued = _runtime_response(
        catalog, bundles=[bundle], anima_id="anima", effective_revision="revision", lease_expires_at=datetime.now(UTC)
    )
    assert issued["bundles"] == [
        {
            "id": bundle.id,
            "format": "json",
            "url": f"/v1/animas/anima/runtime/revisions/revision/bundles/{bundle.id}",
            "file_refs": ["file-001", "file-002"],
            "total_bytes": 40,
        }
    ]
    assert "bundles" not in catalog


@pytest.fixture
def bundle_http(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SimpleNamespace:
    app = FastAPI()
    app.include_router(anima_runtime.router)
    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    app.state.local_runtime_paths = paths
    state = SimpleNamespace(
        app=app,
        owner="owner",
        expires=datetime.now(UTC) + timedelta(hours=1),
        session=SimpleNamespace(commit=AsyncMock()),
        catalog_service=SimpleNamespace(mark_scan_required=AsyncMock()),
        opens=0,
        queries=0,
        raw=[b"{}", '{\r\n "name": "é🙂", "value": 1.00 }\n'.encode(), b'{"tracks": []}\n'],
        catalog=_catalog(),
        denied_ref=None,
        paths=[],
        revision="revision",
    )
    authorizations = {}
    for member, raw in zip(state.catalog["content_descriptor"]["members"], state.raw, strict=True):
        relative = f"{member['file_ref']}.json"
        path = paths.local_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        state.paths.append(path)
        member["sha256"] = hashlib.sha256(raw).hexdigest()
        member["size_bytes"] = len(raw)
        authorizations[member["file_ref"]] = RuntimeFileAuthorization(
            item_id=member["file_ref"],
            source=ContentSource.LOCAL,
            relative_path=relative,
            role="sequence",
            media_type="application/json",
            size_bytes=len(raw),
            sha256=member["sha256"],
        )
    state.authorizations = authorizations

    class Runtime:
        def __init__(self, _session):  # noqa: ANN001
            self.catalog = state.catalog_service
            self.session = state.session

        async def get_bundle(self, *, user_id: str, anima_id: str, revision: str, bundle_id: str):  # noqa: ANN202
            # The snapshot's refusals, over the bundles issuance stored for its catalog.
            if (user_id, anima_id, revision) != ("owner", "anima", state.revision):
                raise RuntimeSnapshotError("runtime_file_not_found")
            if state.expires <= datetime.now(UTC):
                raise RuntimeSnapshotError("runtime_remount_required")
            stored = {bundle.id: bundle for bundle in select_runtime_bundles(state.catalog)}
            if bundle_id not in stored:
                raise RuntimeSnapshotError("runtime_file_not_found")
            return stored[bundle_id]

        async def authorize_files(self, *, file_refs: list[str], **_kwargs):  # noqa: ANN003, ANN202
            state.queries += 1
            return {
                ref: RuntimeSnapshotError("runtime_file_changed_remount_required")
                if ref == state.denied_ref
                else authorizations[ref]
                for ref in file_refs
            }

    async def principal() -> RequestPrincipal:
        return RequestPrincipal(id=state.owner)

    class Ports:
        """Serve the fake runtime and the real local store as the owner's content."""

        store = FilesystemContentStore(
            included_root=paths.included_root,
            included_sources=paths.included_sources,
            local_root=paths.local_root,
            operations_root=paths.operations_root,
        )

        @asynccontextmanager
        async def write_session(self, principal: RequestPrincipal) -> AsyncIterator[Any]:
            yield state.session

        read_session = write_session

        @asynccontextmanager
        async def content(self, session: Any, principal: RequestPrincipal) -> AsyncIterator[Any]:
            yield SimpleNamespace(runtime=Runtime(session), store=self.store)

        def repositories(self, session: Any) -> Any:
            return SimpleNamespace(content_catalog=state.catalog_service)

        async def json_response(self, request: Any, body: bytes, **options: Any) -> Any:
            # The local delivery policy.
            return await encoded_json_response(body, **options)

        def file_response(self, request: Any, file: Any, **options: Any) -> Any:
            return local_file_response(file, **options)

    original_open = FilesystemContentStore.open_verified_file

    def opened(self, **kwargs):  # noqa: ANN001, ANN003, ANN202
        state.opens += 1
        return original_open(self, **kwargs)

    app.dependency_overrides[get_current_principal] = principal
    install_product_ports(app, Ports())  # type: ignore[arg-type]
    monkeypatch.setattr(FilesystemContentStore, "open_verified_file", opened)
    return state


def _url(state: SimpleNamespace, revision: str = "revision") -> str:
    [bundle] = select_runtime_bundles(state.catalog)
    return f"/v1/animas/anima/runtime/revisions/{revision}/bundles/{bundle.id}"


async def test_bundle_wire_integrity_revalidation_and_no_lease_renewal(bundle_http: SimpleNamespace) -> None:
    state = bundle_http
    URL = _url(state)
    expires = state.expires
    async with local_client(state.app) as client:
        identity = await client.get(URL, headers={"Accept-Encoding": "identity"})
        async with client.stream("GET", URL, headers={"Accept-Encoding": "gzip"}) as compressed:
            wire = b"".join([chunk async for chunk in compressed.aiter_raw()])
        assert gzip.decompress(wire) == identity.content
        assert int(compressed.headers["content-length"]) == len(wire)
        # Each content coding is its own representation with its own validator.
        assert compressed.headers["etag"] != identity.headers["etag"]
        assert compressed.headers["vary"] == "Accept-Encoding"
        assert identity.headers["cache-control"] == "private, no-cache"
        envelope = identity.json()
        assert [member["text"].encode() for member in envelope["members"]] == state.raw[1:]
        cached = await client.get(URL, headers={"Accept-Encoding": "gzip", "If-None-Match": compressed.headers["etag"]})
        assert cached.status_code == 304
        assert cached.content == b""
        assert cached.headers["etag"] == compressed.headers["etag"]
        assert state.opens == 6 and state.queries == 3
        assert state.expires == expires
        state.session.commit.assert_not_awaited()


async def test_a_revalidated_json_bundle_is_checked_but_not_rebuilt(
    bundle_http: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A matching validator costs the authorization and file checks, not a compressed body."""

    state = bundle_http
    URL = _url(state)
    compressed: list[int] = []
    compress = gzip.compress

    def counted(data: bytes, *args: Any, **kwargs: Any) -> bytes:
        compressed.append(len(data))
        return compress(data, *args, **kwargs)

    monkeypatch.setattr(gzip, "compress", counted)
    async with local_client(state.app) as client:
        first = await client.get(URL, headers={"Accept-Encoding": "gzip"})
        assert len(compressed) == 1
        for _ in range(2):
            again = await client.get(URL, headers={"Accept-Encoding": "gzip", "If-None-Match": first.headers["etag"]})
            assert (again.status_code, again.headers["etag"]) == (304, first.headers["etag"])
        assert len(compressed) == 1
        # Every conditional read still opened and verified both members on disk.
        assert state.opens == 6 and state.queries == 3

        # A member that changed on disk is still caught before any 304.
        state.paths[1].write_bytes(b"changed")
        degraded = await client.get(URL, headers={"Accept-Encoding": "gzip", "If-None-Match": first.headers["etag"]})
        assert degraded.status_code == 200
        assert degraded.headers["cache-control"] == "no-store"
        assert "etag" not in degraded.headers
        assert state.catalog_service.mark_scan_required.await_count == 1


async def test_a_json_bundle_validator_names_its_revision_and_member_bytes(bundle_http: SimpleNamespace) -> None:
    state = bundle_http
    async with local_client(state.app) as client:
        first = await client.get(_url(state))
        state.revision = "other-revision"
        url = _url(state, "other-revision")
        other_revision = await client.get(url, headers={"If-None-Match": first.headers["etag"]})
        assert other_revision.status_code == 200
        assert other_revision.headers["etag"] != first.headers["etag"]
        # The same member set with different bytes is a different representation.
        raw = b'{"tracks": [1]}\n'
        state.paths[2].write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest()
        state.catalog["content_descriptor"]["members"][2].update(size_bytes=len(raw), sha256=digest)
        state.authorizations["file-002"] = replace(state.authorizations["file-002"], size_bytes=len(raw), sha256=digest)
        changed = await client.get(url, headers={"If-None-Match": other_revision.headers["etag"]})
        assert changed.status_code == 200
        assert changed.json()["members"][1]["text"].encode() == raw
        assert changed.headers["etag"] not in {first.headers["etag"], other_revision.headers["etag"]}


@pytest.mark.parametrize("failure", ["changed", "deleted", "catalog", "invalid_utf8"])
async def test_bad_member_keeps_good_members_and_disables_caching(bundle_http: SimpleNamespace, failure: str) -> None:
    state = bundle_http
    URL = _url(state)
    async with local_client(state.app) as client:
        first = await client.get(URL)
        if failure == "deleted":
            state.paths[1].unlink()
        elif failure == "catalog":
            state.denied_ref = "file-001"
        else:
            state.paths[1].write_bytes(b"\xff" if failure == "invalid_utf8" else b"changed")
            if failure == "invalid_utf8":
                # Keep the descriptor/hash consistent so this exercises strict
                # UTF-8 decoding, not merely the already-tested digest rejection.
                digest = hashlib.sha256(b"\xff").hexdigest()
                state.catalog["content_descriptor"]["members"][1].update(size_bytes=1, sha256=digest)
                state.authorizations["file-001"] = replace(
                    state.authorizations["file-001"], size_bytes=1, sha256=digest
                )
        response = await client.get(URL, headers={"If-None-Match": first.headers["etag"]})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert "etag" not in response.headers
        bad, good = response.json()["members"]
        assert bad == {"file_ref": "file-001", "error": "runtime_file_changed_remount_required"}
        assert good["text"].encode() == state.raw[2]
        assert state.catalog_service.mark_scan_required.await_count == (0 if failure == "catalog" else 1)


@pytest.mark.parametrize("failure", ["owner", "expired", "revision", "bundle"])
async def test_bundle_conditional_request_cannot_bypass_authority(bundle_http: SimpleNamespace, failure: str) -> None:
    state = bundle_http
    URL = _url(state)
    async with local_client(state.app) as client:
        first = await client.get(URL)
        url = URL
        if failure == "owner":
            state.owner = "another-owner"
        elif failure == "expired":
            state.expires = datetime.now(UTC) - timedelta(seconds=1)
        elif failure == "revision":
            url = _url(state, "unknown")
        else:
            url = URL.rsplit("/", 1)[0] + "/" + runtime_bundle_id("binary", ["file-001", "file-002"])
        response = await client.get(url, headers={"If-None-Match": first.headers["etag"]})
        assert response.status_code == (409 if failure == "expired" else 404)
        assert state.opens == 2


def _frame(body: bytes) -> tuple[dict[str, Any], bytes]:
    assert body[:4] == BINARY_BUNDLE_MAGIC
    length = int.from_bytes(body[4:8], "big")
    return json.loads(body[8 : 8 + length]), body[8 + length :]


async def test_binary_bundle_frame_layout_revalidation_and_isolated_failure(bundle_http: SimpleNamespace) -> None:
    state = bundle_http
    for member in state.catalog["content_descriptor"]["members"]:
        member.update(role="texture", media_type="image/png")
    for ref, authorization in list(state.authorizations.items()):
        state.authorizations[ref] = replace(authorization, role="texture", media_type="image/png")
    [bundle] = select_runtime_bundles(state.catalog)
    assert bundle.format == "binary"
    url = _url(state)
    async with local_client(state.app) as client:
        response = await client.get(url, headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        header, payload = _frame(response.content)
        assert header == {
            "version": 1,
            "revision": "revision",
            "members": [
                {"file_ref": "file-001", "size": len(state.raw[1])},
                {"file_ref": "file-002", "size": len(state.raw[2])},
            ],
        }
        assert payload == state.raw[1] + state.raw[2]
        assert int(response.headers["content-length"]) == len(response.content)
        assert "content-encoding" not in response.headers
        assert response.headers["etag"] == f'"{hashlib.sha256(response.content).hexdigest()}"'
        # A complete binary bundle names fixed bytes, so the local policy keeps it a year.
        assert response.headers["cache-control"] == "private, max-age=31536000, immutable"
        # A conditional request still rechecks and rereads every member first.
        cached = await client.get(url, headers={"If-None-Match": response.headers["etag"]})
        assert (cached.status_code, cached.content) == (304, b"")
        assert state.opens == 4 and state.queries == 2
        state.paths[1].write_bytes(b"changed")
        degraded = await client.get(url, headers={"If-None-Match": response.headers["etag"]})
        assert degraded.status_code == 200
        header, payload = _frame(degraded.content)
        assert header["members"] == [
            {"file_ref": "file-001", "error": "runtime_file_changed_remount_required"},
            {"file_ref": "file-002", "size": len(state.raw[2])},
        ]
        assert payload == state.raw[2]
        assert degraded.headers["cache-control"] == "private, no-store"
        assert state.catalog_service.mark_scan_required.await_count == 1
        state.session.commit.assert_awaited_once()
