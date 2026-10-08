"""The isolated asset boundary; these tests do not start the product app."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from dataclasses import FrozenInstanceError
from pathlib import Path

import httpx
import pytest
from starlette.requests import Request

from animama.local.http import assets as asset_module
from animama.local.http.assets import (
    IMMUTABLE_APP_ASSET_CACHE,
    PARAKEET_MOUNT,
    PARAKEET_WEBGPU_MOUNT,
    LocalAssets,
    ModelFile,
    ModelMount,
    StaticModelMounts,
)
from tests.filesystem_links import link_directory, require_symlinks

pytestmark = pytest.mark.asyncio
_HTML = b'<html><script src="/assets/app-abcdefgh.js"></script></html>'
_MODEL = b"model-fixture"
_VERSION = "0.1.0-exact"


def _mounted(web_root: Path, base: ModelMount | None, webgpu: ModelMount | None = None) -> LocalAssets:
    return LocalAssets(web_root, mount_source=StaticModelMounts({PARAKEET_MOUNT: base, PARAKEET_WEBGPU_MOUNT: webgpu}))


@pytest.fixture(autouse=True)
def request_principal_override():
    """The suite's product-principal fixture is unnecessary for this boundary."""

    yield


@pytest.fixture
def web_root(tmp_path: Path) -> Path:
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / ".vite").mkdir()
    (root / "index.html").write_bytes(_HTML)
    (root / "assets/app-abcdefgh.js").write_bytes(b"export const app = true;")
    (root / "assets/app-abcdefgh.css").write_bytes(b"body { color: red; }")
    (root / "assets/unlisted-abcdefgh.js").write_bytes(b"unlisted")
    (root / "assets/app-abcdefgh.js.map").write_bytes(b"{}")
    (root / "config.json").write_bytes(b'{"v":1}')
    (root / ".vite/manifest.json").write_text(
        json.dumps(
            {
                "src/main.tsx": {
                    "file": "assets/app-abcdefgh.js",
                    "css": ["assets/app-abcdefgh.css"],
                    "assets": ["assets/app-abcdefgh.js.map", "config.json"],
                },
            }
        )
    )
    for name in ("index.html", "config.json", "assets/app-abcdefgh.js", "assets/app-abcdefgh.css"):
        os.utime(root / name, (1704067200, 1704067200))
    return root


@pytest.fixture
def model_mount(tmp_path: Path) -> ModelMount:
    root = tmp_path / "models"
    root.mkdir()
    (root / "encoder.onnx").write_bytes(_MODEL)
    (root / "private.txt").write_text("not inventoried")
    return ModelMount(
        root,
        _VERSION,
        (
            ModelFile(
                "encoder.onnx",
                len(_MODEL),
                hashlib.sha256(_MODEL).hexdigest(),
                "application/octet-stream",
            ),
        ),
    )


def _client(assets: LocalAssets) -> httpx.AsyncClient:
    async def app(scope, receive, send):
        request = Request(scope, receive)
        response = await assets.response(request)
        await response(scope, receive, send)

    return httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:3000")


def _model_url(name: str = "encoder.onnx", *, version: str | None = _VERSION) -> str:
    return PARAKEET_MOUNT + name + ("?v=" + version if version is not None else "")


@pytest.mark.parametrize("path", ["/", "/anima", "/anima/", "/index.html"])
async def test_navigation_and_head_revalidate_html_bytes(web_root: Path, path: str) -> None:
    async with _client(LocalAssets(web_root)) as client:
        first = await client.get(path, headers={"accept": "text/html"})
        assert first.status_code == 200
        assert first.content == _HTML
        assert first.headers["content-type"] == "text/html; charset=utf-8"
        assert first.headers["content-length"] == str(len(_HTML))
        assert first.headers["x-content-type-options"] == "nosniff"
        assert first.headers["cache-control"] == "no-cache"
        assert "last-modified" not in first.headers
        etag = '"' + hashlib.sha256(_HTML).hexdigest() + '"'
        assert first.headers["etag"] == etag
        head = await client.head(path, headers={"sec-fetch-mode": "navigate"})
        assert head.status_code == 200 and not head.content
        assert head.headers["content-length"] == str(len(_HTML))
        for method in ("GET", "HEAD"):
            unchanged = await client.request(
                method, path, headers={"accept": "text/html", "if-none-match": "W/" + etag}
            )
            assert unchanged.status_code == 304 and not unchanged.content
            assert "content-length" not in unchanged.headers
            assert unchanged.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("name", ["app-abcdefgh.js", "app-abcdefgh.css"])
async def test_only_inventoried_code_is_immutable_with_conditional_get_and_head(web_root: Path, name: str) -> None:
    async with _client(LocalAssets(web_root)) as client:
        path = "/assets/" + name
        first = await client.get(path)
        assert first.status_code == 200
        assert first.content == (web_root / "assets" / name).read_bytes()
        assert first.headers["cache-control"] == IMMUTABLE_APP_ASSET_CACHE
        head = await client.head(path)
        assert head.status_code == 200 and not head.content
        assert head.headers["content-length"] == first.headers["content-length"]
        for condition in (
            {"if-none-match": first.headers["etag"]},
            {"if-modified-since": first.headers["last-modified"]},
        ):
            for method in ("GET", "HEAD"):
                unchanged = await client.request(method, path, headers=condition)
                assert unchanged.status_code == 304 and not unchanged.content
                assert "content-length" not in unchanged.headers
                assert unchanged.headers["cache-control"] == IMMUTABLE_APP_ASSET_CACHE
        mismatch = await client.get(
            path,
            headers={
                "if-none-match": '"stale"',
                "if-modified-since": first.headers["last-modified"],
            },
        )
        assert mismatch.status_code == 200
        assert (await client.get(path, headers={"cache-control": "no-cache"})).status_code == 200


@pytest.mark.parametrize("path", ["/config.json", "/assets/unlisted-abcdefgh.js", "/assets/app-abcdefgh.js.map"])
async def test_unversioned_or_unlisted_files_cannot_validate_from_normalized_mtime(web_root: Path, path: str) -> None:
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get(
            path, headers={"if-none-match": "*", "if-modified-since": "Mon, 01 Jan 2091 00:00:00 GMT"}
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache"
        assert "etag" not in response.headers and "last-modified" not in response.headers


async def test_new_build_changes_same_length_normalized_html_and_drops_old_chunk(web_root: Path) -> None:
    async with _client(LocalAssets(web_root)) as client:
        old = await client.get("/index.html")
    new_html = _HTML.replace(b"abcdefgh", b"ijklmnop")
    (web_root / "index.html").write_bytes(new_html)
    os.utime(web_root / "index.html", (1704067200, 1704067200))
    (web_root / "assets/app-abcdefgh.js").rename(web_root / "assets/app-ijklmnop.js")
    (web_root / ".vite/manifest.json").write_text('{"main":{"file":"assets/app-ijklmnop.js"}}')
    async with _client(LocalAssets(web_root)) as client:
        current = await client.get("/index.html", headers={"if-none-match": old.headers["etag"]})
        assert current.status_code == 200 and current.content == new_html
        assert current.headers["etag"] != old.headers["etag"]
        missing = await client.get("/assets/app-abcdefgh.js", headers={"accept": "text/html"})
        assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"
        assert (await client.get("/assets/app-ijklmnop.js")).headers["cache-control"] == IMMUTABLE_APP_ASSET_CACHE


@pytest.mark.parametrize(
    "manifest",
    [None, b"not json", b"[]", b"null", b" " * (4 * 1024 * 1024 + 1)],
    # Short IDs: pytest copies the ID into an environment variable, which
    # Windows limits to 32,767 characters.
    ids=["missing", "invalid", "array", "null", "oversized"],
)
async def test_missing_invalid_or_oversized_manifest_degrades_safely(web_root: Path, manifest: bytes | None) -> None:
    path = web_root / ".vite/manifest.json"
    if manifest is None:
        path.unlink()
    else:
        path.write_bytes(manifest)
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get("/assets/app-abcdefgh.js")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache"
        assert "etag" not in response.headers


@pytest.mark.parametrize(
    "name,content_type",
    [
        (".css", "text/css; charset=utf-8"),
        (".html", "text/html; charset=utf-8"),
        (".ico", "image/x-icon"),
        (".jpeg", "image/jpeg"),
        (".jpg", "image/jpeg"),
        (".js", "text/javascript; charset=utf-8"),
        (".mjs", "text/javascript; charset=utf-8"),
        (".json", "application/json; charset=utf-8"),
        (".map", "application/json; charset=utf-8"),
        (".png", "image/png"),
        (".svg", "image/svg+xml"),
        (".wasm", "application/wasm"),
        (".webp", "image/webp"),
        (".woff", "font/woff"),
        (".woff2", "font/woff2"),
        (".unknown", "application/octet-stream"),
    ],
)
async def test_explicit_mime_binary_bytes_and_head(web_root: Path, name: str, content_type: str) -> None:
    payload = b"\x00\x01\x02\xff"
    (web_root / ("resource" + name)).write_bytes(payload)
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get("/resource" + name)
        assert response.status_code == 200 and response.content == payload
        assert response.headers["content-type"] == content_type
        assert response.headers["x-content-type-options"] == "nosniff"
        head = await client.head("/resource" + name)
        assert not head.content and head.headers["content-length"] == "4"


@pytest.mark.parametrize(
    "path",
    [
        "/.vite/manifest.json",
        "/%2evite/manifest.json",
        "/assets%2f..%2f.vite%2fmanifest.json",
        "/%2e%2e/private.txt",
        "/assets/%2e%2e/index.html",
        "/%5cprivate.txt",
        "/C:/private.txt",
        "/.env",
        "/.git/config",
        "/docs",
        "/redoc",
        "/openapi.json",
        "/api/auth/session",
        "/api/missing",
        "/v1/missing",
        "/_desktop/health",
        "/onnx/missing",
        "/tts/missing",
        "/basis/missing",
        "/assets/missing",
        "/content/missing",
        "/background/missing",
        "/effects/vfx/missing",
        "/missing.js",
        "/missing.js/",
        "/missing.",
    ],
)
async def test_private_unsafe_and_missing_reserved_paths_never_fall_back(web_root: Path, path: str) -> None:
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get(path, headers={"accept": "text/html", "sec-fetch-mode": "navigate"})
        assert response.status_code == 404
        assert response.headers["cache-control"] == "no-store"
        assert _HTML not in response.content


@pytest.mark.parametrize("path", ["/%ZZ", "/%2", "/%ff", "/%c0%af"])
async def test_malformed_encoding_is_bounded_400(web_root: Path, path: str) -> None:
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get(path, headers={"accept": "text/html"})
        assert response.status_code == 400 and response.headers["cache-control"] == "no-store"
        assert response.json() == {"error": "invalid_path"}


@pytest.mark.parametrize("path", ["/api/secret.txt", "/v1/secret.txt", "/_desktop/secret.txt", "/docs/index.html"])
async def test_reserved_names_cannot_be_served_even_if_the_file_exists(web_root: Path, path: str) -> None:
    destination = web_root / path[1:]
    destination.parent.mkdir(parents=True)
    destination.write_text("private")
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get(path)
        assert response.status_code == 404 and "private" not in response.text


async def test_directories_and_directory_links_are_not_documents(web_root: Path, tmp_path: Path) -> None:
    (web_root / "directory").mkdir()
    (tmp_path / "private.txt").write_text("private")
    link_directory(web_root / "linked-dir", tmp_path)
    async with _client(LocalAssets(web_root)) as client:
        for path in ("/directory", "/linked-dir/private.txt"):
            assert (await client.get(path, headers={"accept": "text/html"})).status_code == 404


@pytest.mark.parametrize("path", ["/effects/new", "/library", "/avatar-effects/new"])
async def test_app_pages_beside_static_asset_trees_fall_back_to_the_shell(web_root: Path, path: str) -> None:
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get(path, headers={"accept": "text/html", "sec-fetch-mode": "navigate"})
        assert response.status_code == 200
        assert _HTML in response.content


async def test_only_navigation_can_fall_back_and_file_links_are_not_documents(web_root: Path, tmp_path: Path) -> None:
    require_symlinks(tmp_path)
    (tmp_path / "private.txt").write_text("private")
    (web_root / "link").symlink_to(tmp_path / "private.txt")
    (web_root / "inside").symlink_to(web_root / "index.html")
    async with _client(LocalAssets(web_root)) as client:
        assert (await client.get("/anima")).status_code == 404
        for path in ("/link", "/inside"):
            assert (await client.get(path, headers={"accept": "text/html"})).status_code == 404
        for method in ("POST", "PUT", "DELETE", "OPTIONS"):
            response = await client.request(method, "/index.html", headers={"accept": "text/html"})
            assert response.status_code == 404 and response.headers["cache-control"] == "no-store"


async def test_model_get_head_validators_and_unversioned_cache(web_root: Path, model_mount: ModelMount) -> None:
    async with _client(_mounted(web_root, model_mount)) as client:
        response = await client.get(_model_url())
        assert response.status_code == 200 and response.content == _MODEL
        assert response.headers["cache-control"] == "private, max-age=31536000, immutable"
        assert response.headers["accept-ranges"] == "bytes"
        assert response.headers["content-length"] == str(len(_MODEL))
        assert response.headers["etag"] == '"' + model_mount.files[0].sha256 + '"'
        head = await client.head(_model_url())
        assert head.status_code == 200 and not head.content
        assert head.headers["content-length"] == str(len(_MODEL))
        unchanged = await client.get(_model_url(), headers={"if-none-match": response.headers["etag"]})
        assert unchanged.status_code == 304 and not unchanged.content and "content-length" not in unchanged.headers
        unversioned = await client.get(_model_url(version=None))
        assert unversioned.status_code == 200 and unversioned.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize(
    "byte_range,start,end",
    [("bytes=2-5", 2, 5), ("bytes=3-", 3, 12), ("bytes=-3", 10, 12), ("bytes=-500", 0, 12), ("bytes=1-500", 1, 12)],
)
async def test_model_single_ranges_seek_exact_bytes(
    web_root: Path,
    model_mount: ModelMount,
    byte_range: str,
    start: int,
    end: int,
) -> None:
    async with _client(_mounted(web_root, model_mount)) as client:
        for method in ("GET", "HEAD"):
            response = await client.request(method, _model_url(), headers={"range": byte_range})
            assert response.status_code == 206
            assert response.content == (_MODEL[start : end + 1] if method == "GET" else b"")
            assert response.headers["content-range"] == f"bytes {start}-{end}/{len(_MODEL)}"
            assert response.headers["content-length"] == str(end - start + 1)


@pytest.mark.parametrize(
    "byte_range", ["bytes=0-1,3-4", "bytes=500-", "bytes=-0", "bytes=a-b", "bytes=-", "bytes=5-2", "items=0-1"]
)
async def test_bad_or_unsatisfiable_model_ranges_are_not_cacheable(
    web_root: Path,
    model_mount: ModelMount,
    byte_range: str,
) -> None:
    async with _client(_mounted(web_root, model_mount)) as client:
        response = await client.get(_model_url(), headers={"range": byte_range})
        assert response.status_code == 416 and not response.content
        assert response.headers["content-range"] == f"bytes */{len(_MODEL)}"
        assert response.headers["cache-control"] == "no-store"


async def test_model_if_range_requires_current_strong_digest(web_root: Path, model_mount: ModelMount) -> None:
    async with _client(_mounted(web_root, model_mount)) as client:
        etag = '"' + model_mount.files[0].sha256 + '"'
        for if_range in ('"stale"', "W/" + etag, "Mon, 01 Jan 2024 00:00:00 GMT"):
            full = await client.get(_model_url(), headers={"range": "bytes=2-5", "if-range": if_range})
            assert full.status_code == 200 and full.content == _MODEL
        partial = await client.get(_model_url(), headers={"range": "bytes=2-5", "if-range": etag})
        assert partial.status_code == 206 and partial.content == _MODEL[2:6]


@pytest.mark.parametrize(
    "path",
    [
        _model_url(version="old"),
        _model_url(version=""),
        _model_url() + "&v=old",
        _model_url("private.txt"),
        _model_url("..%2Fprivate.txt"),
        _model_url("%2Fencoder.onnx"),
        _model_url("encoder.onnx/"),
        PARAKEET_MOUNT,
    ],
)
async def test_model_version_inventory_and_exact_path_are_required(
    web_root: Path, model_mount: ModelMount, path: str
) -> None:
    async with _client(_mounted(web_root, model_mount)) as client:
        response = await client.get(path, headers={"accept": "text/html"})
        assert response.status_code == 404 and response.headers["cache-control"] == "no-store"


async def test_absent_model_mount_never_falls_through_to_the_built_tree(web_root: Path) -> None:
    fake_model = web_root / PARAKEET_MOUNT[1:] / "encoder.onnx"
    fake_model.parent.mkdir(parents=True)
    fake_model.write_bytes(_MODEL)
    async with _client(LocalAssets(web_root)) as client:
        response = await client.get(_model_url(), headers={"accept": "text/html"})
        assert response.status_code == 404 and response.headers["cache-control"] == "no-store"


async def test_webgpu_encoder_mount_is_separate_and_absent_until_its_pack_is_active(
    web_root: Path, model_mount: ModelMount
) -> None:
    encoder = PARAKEET_WEBGPU_MOUNT + "encoder.onnx"
    # The base pack alone never serves the encoder path, nor the base files under it.
    async with _client(_mounted(web_root, model_mount)) as client:
        assert (await client.head(encoder)).status_code == 404
        assert (await client.head(encoder + "?v=" + _VERSION)).status_code == 404
    # Each pack keeps its own version: the encoder never accepts the base pack's.
    webgpu_mount = ModelMount(model_mount.root, "0.1.0-bbbbbbbbbbbbbbbb", model_mount.files)
    async with _client(_mounted(web_root, model_mount, webgpu_mount)) as client:
        assert (await client.head(encoder + "?v=" + _VERSION)).status_code == 404
        response = await client.head(encoder + "?v=" + webgpu_mount.version)
        assert response.status_code == 200
        assert response.headers["etag"] == '"' + model_mount.files[0].sha256 + '"'
        unversioned = await client.get(encoder)
        assert unversioned.content == _MODEL
        assert unversioned.headers["cache-control"] == "no-cache"
        assert (await client.get(PARAKEET_WEBGPU_MOUNT + "private.txt")).status_code == 404
        assert (await client.get(_model_url())).status_code == 200


@pytest.mark.parametrize("replacement", ["size", "symlink", "hardlink", "directory"])
async def test_model_rejects_changed_bytes_or_links(
    web_root: Path, model_mount: ModelMount, tmp_path: Path, replacement: str
) -> None:
    path = model_mount.root / "encoder.onnx"
    if replacement == "size":
        path.write_bytes(_MODEL + b" changed")
    elif replacement == "hardlink":
        os.link(path, tmp_path / "second-link")
    else:
        path.unlink()
        if replacement == "symlink":
            require_symlinks(tmp_path)
            private = tmp_path / "private.onnx"
            private.write_bytes(_MODEL)
            path.symlink_to(private)
        else:
            path.mkdir()
    async with _client(_mounted(web_root, model_mount)) as client:
        response = await client.get(_model_url())
        assert response.status_code == 404 and response.headers["cache-control"] == "no-store"


async def test_nested_model_directory_substitution_is_rejected(
    web_root: Path, model_mount: ModelMount, tmp_path: Path
) -> None:
    child = model_mount.root / "nested"
    child.mkdir()
    (child / "encoder.onnx").write_bytes(_MODEL)
    model = model_mount.files[0]
    mount = ModelMount(
        model_mount.root,
        _VERSION,
        (ModelFile("nested/encoder.onnx", model.size_bytes, model.sha256, model.media_type),),
    )
    child.rename(tmp_path / "outside")
    link_directory(child, tmp_path / "outside")
    async with _client(_mounted(web_root, mount)) as client:
        assert (await client.get(_model_url("nested/encoder.onnx"))).status_code == 404


async def test_model_zero_length_and_range(web_root: Path, tmp_path: Path) -> None:
    root = tmp_path / "empty-model"
    root.mkdir()
    (root / "empty.onnx").write_bytes(b"")
    mount = ModelMount(
        root, _VERSION, (ModelFile("empty.onnx", 0, hashlib.sha256(b"").hexdigest(), "application/octet-stream"),)
    )
    async with _client(_mounted(web_root, mount)) as client:
        full = await client.get(_model_url("empty.onnx"))
        assert full.status_code == 200 and not full.content and full.headers["content-length"] == "0"
        assert (await client.get(_model_url("empty.onnx"), headers={"range": "bytes=0-"})).status_code == 416


async def test_inventory_is_immutable_and_invalid_private_configuration_fails(model_mount: ModelMount) -> None:
    with pytest.raises(FrozenInstanceError):
        model_mount.version = "changed"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        model_mount.files[0].size_bytes = 9  # type: ignore[misc]
    mutable_files = list(model_mount.files)
    copy = ModelMount(model_mount.root, _VERSION, mutable_files)  # type: ignore[arg-type]
    mutable_files.clear()
    assert copy.files == model_mount.files
    with pytest.raises(ValueError):
        ModelMount(model_mount.root, _VERSION, model_mount.files * 2)
    with pytest.raises(ValueError):
        ModelFile("../encoder.onnx", 1, "0" * 64, "application/octet-stream")
    with pytest.raises(ValueError):
        ModelFile("encoder.onnx", True, "0" * 64, "application/octet-stream")
    with pytest.raises(ValueError):
        ModelFile("encoder.onnx", 1, "forged", "application/octet-stream")
    with pytest.raises(ValueError):
        ModelFile("encoder.onnx", 1, "0" * 64, "application/octet-stream\r\nx-forged: yes")


async def test_replacement_between_selection_and_send_cannot_escape(web_root: Path, tmp_path: Path) -> None:
    require_symlinks(tmp_path)
    assets = LocalAssets(web_root)

    async def app(scope, receive, send):
        response = await assets.response(Request(scope, receive))
        path = web_root / "assets/app-abcdefgh.js"
        path.unlink()
        path.symlink_to(tmp_path / "private.txt")
        await response(scope, receive, send)

    (tmp_path / "private.txt").write_text("private")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:3000") as client:
        response = await client.get("/assets/app-abcdefgh.js")
        assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
        assert "private" not in response.text


async def test_file_descriptor_closes_when_send_fails(web_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    opened = []
    original_open = asset_module._open_regular

    def recording_open(*args, **kwargs):
        handle = original_open(*args, **kwargs)
        opened.append(handle)
        return handle

    monkeypatch.setattr(asset_module, "_open_regular", recording_open)
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "method": "GET",
        "scheme": "http",
        "path": "/assets/app-abcdefgh.js",
        "raw_path": b"/assets/app-abcdefgh.js",
        "query_string": b"",
        "headers": [],
        "server": ("localhost", 3000),
    }
    response = await LocalAssets(web_root).response(Request(scope))

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            raise RuntimeError("client went away")

    with pytest.raises(RuntimeError, match="client went away"):
        await response(scope, receive, send)
    assert opened and all(handle.closed for handle in opened)


async def test_static_range_retains_existing_full_response_contract(web_root: Path) -> None:
    async with _client(LocalAssets(web_root)) as client:
        for method in ("GET", "HEAD"):
            response = await client.request(method, "/assets/app-abcdefgh.js", headers={"range": "bytes=2-5"})
            expected = (web_root / "assets/app-abcdefgh.js").read_bytes()
            assert response.status_code == 200
            assert response.content == (expected if method == "GET" else b"")
            assert response.headers["content-length"] == str(len(expected))
            assert "content-range" not in response.headers and "accept-ranges" not in response.headers


@pytest.mark.parametrize("spec_version", ["2.0", "2.4"])
async def test_file_descriptor_closes_on_task_cancellation(
    web_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    spec_version: str,
) -> None:
    opened = []
    original_open = asset_module._open_regular

    def recording_open(*args, **kwargs):
        handle = original_open(*args, **kwargs)
        opened.append(handle)
        return handle

    monkeypatch.setattr(asset_module, "_open_regular", recording_open)
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": spec_version},
        "method": "GET",
        "scheme": "http",
        "path": "/assets/app-abcdefgh.js",
        "raw_path": b"/assets/app-abcdefgh.js",
        "query_string": b"",
        "headers": [],
        "server": ("localhost", 3000),
    }
    response = await LocalAssets(web_root).response(Request(scope))
    body_started, never = asyncio.Event(), asyncio.Event()

    async def receive():
        await never.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            body_started.set()
            await never.wait()

    task = asyncio.create_task(response(scope, receive, send))
    try:
        await asyncio.wait_for(body_started.wait(), timeout=2)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert opened and all(handle.closed for handle in opened)


async def test_all_current_parakeet_inventory_categories_are_served_exactly(web_root: Path, tmp_path: Path) -> None:
    """Use tiny local payloads for the seven paths in feature-pack-build.ts."""

    root = tmp_path / "complete-pack"
    root.mkdir()
    inventory = []
    expected = {
        "ATTRIBUTION.md": "text/plain; charset=utf-8",
        "README.md": "text/plain; charset=utf-8",
        "config.json": "application/json",
        "decoder_joint-model.int8.onnx": "application/octet-stream",
        "encoder-model.int8.onnx": "application/octet-stream",
        "nemo128.onnx": "application/octet-stream",
        "vocab.txt": "text/plain; charset=utf-8",
    }
    for name, media_type in expected.items():
        payload = name.encode()
        (root / name).write_bytes(payload)
        inventory.append(ModelFile(name, len(payload), hashlib.sha256(payload).hexdigest(), media_type))
    mount = ModelMount(root, _VERSION, tuple(inventory))
    async with _client(_mounted(web_root, mount)) as client:
        for name, media_type in expected.items():
            response = await client.get(_model_url(name))
            assert response.status_code == 200 and response.content == name.encode()
            assert response.headers["content-type"] == media_type
            assert response.headers["etag"] == '"' + hashlib.sha256(name.encode()).hexdigest() + '"'
