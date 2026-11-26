"""Built React assets and the installation's verified optional speech-to-text mounts.

Speech-to-text mounts (Parakeet and SenseVoice) come from a
``ModelMountSource`` consulted on every request, so a composition can activate
or remove a model set without a new responder.

This responder registers no routes and supplies no browser admission policy.
The local composition calls it only after admission and product routes. Its
filesystem and fallback restrictions also apply when it is used directly.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from typing import BinaryIO, Protocol, cast
from urllib.parse import unquote_to_bytes

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.types import Receive, Scope, Send

from animama.utils.files import WINDOWS, final_path, is_directory, open_no_follow

PARAKEET_MOUNT = "/onnx/models/parakeet-tdt-0.6b-v2/"
# The optional FP16 encoder set; it is served only while its source supplies it.
PARAKEET_WEBGPU_MOUNT = "/onnx/models/parakeet-tdt-0.6b-v2-webgpu/"
# SenseVoice-Small (multilingual speech-to-text) and its optional WebGPU graph.
SENSEVOICE_MOUNT = "/onnx/models/sensevoice-small/"
SENSEVOICE_WEBGPU_MOUNT = "/onnx/models/sensevoice-small-webgpu/"
MODEL_MOUNT_PATHS = (PARAKEET_MOUNT, PARAKEET_WEBGPU_MOUNT, SENSEVOICE_MOUNT, SENSEVOICE_WEBGPU_MOUNT)
IMMUTABLE_APP_ASSET_CACHE = "public, max-age=31536000, immutable"
# Every built file carries the application's policy, because a worker takes its
# policy from its own response (a worklet follows its document's). Pages fetch
# inline `data:` clips and model data, which never leave the device; their only
# outside connections are the public voice-sample host with the download CDN it
# redirects to, and the realtime speech socket.
APP_CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'none'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self' blob: data: https://huggingface.co https://*.hf.co wss://api.elevenlabs.io",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    )
)
# Pocket TTS's pinned sentencepiece binding builds call wrappers at runtime (#698),
# so its exact worker alone may evaluate strings, as contracts/hosted-web.md specifies.
POCKET_WORKER = "tts/workers/inference-worker.js"
POCKET_WORKER_CONTENT_SECURITY_POLICY = APP_CONTENT_SECURITY_POLICY.replace(
    "'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'", 1
)
# Written by the web build beside Vite's manifest; hidden names are never served.
BROWSER_RUNTIME_RECORD = ".vite/browser-runtime.json"
_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_FINGERPRINTED_CODE = re.compile(r"assets/[^/]+-[\w-]{8,}\.(?:js|css)", re.ASCII)
_CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
_PRIVATE_PREFIXES = ("/api", "/v1", "/_desktop", "/docs", "/redoc", "/openapi.json")
_NO_FALLBACK_PREFIXES = _PRIVATE_PREFIXES + (
    # The ChatGPT sign-in return is a route; no /auth path is an app page.
    "/auth",
    "/onnx",
    "/tts",
    "/basis",
    "/assets",
    "/content",
    "/background",
    # Included effect assets (`includedContentAliases` in src/frontend/web/vite.config.ts);
    # other /effects paths, such as /effects/new, are app routes.
    "/effects/scene-vfx",
    "/effects/vfx",
    "/effects/resources",
)


def _safe_name(name: str) -> bool:
    """Accept exact relative names, excluding traversal and hidden metadata."""

    return (
        bool(name)
        and not re.search(r"[\\:\x00-\x1f\x7f]", name)
        and all(part and not part.startswith(".") for part in name.split("/"))
    )


@dataclass(frozen=True)
class ModelFile:
    """One file from a privately verified active model inventory."""

    path: str
    size_bytes: int
    sha256: str
    media_type: str

    def __post_init__(self) -> None:
        if not isinstance(self.path, str) or not _safe_name(self.path):
            raise ValueError("Model file path must be a safe relative name")
        if type(self.size_bytes) is not int or self.size_bytes < 0:
            raise ValueError("Model file size must be a nonnegative integer")
        if not isinstance(self.sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", self.sha256):
            raise ValueError("Model file digest must be a lowercase SHA-256 digest")
        if not isinstance(self.media_type, str) or not re.fullmatch(
            r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?", self.media_type
        ):
            raise ValueError("Model file media type must be a safe MIME value")


@dataclass(frozen=True)
class ModelMount:
    """An immutable installed speech-to-text set: its version and exact inventory.

    The backend model-asset store verifies digests before activation; the
    version is the set's manifest digest. Requests recheck file identity,
    length and link safety, without hashing multi-gigabyte models on every
    read.
    """

    root: Path
    version: str
    files: tuple[ModelFile, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}", self.version):
            raise ValueError("Model version must be an exact set version")
        files = tuple(self.files)
        if not all(isinstance(file, ModelFile) for file in files) or len({file.path for file in files}) != len(files):
            raise ValueError("Model inventory must contain distinct ModelFile entries")
        object.__setattr__(self, "root", Path(os.path.abspath(self.root)))
        object.__setattr__(self, "files", files)


class ModelMountSource(Protocol):
    """Resolve the active mount for one of ``MODEL_MOUNT_PATHS`` on each request."""

    def mount(self, path: str) -> ModelMount | None:
        """Return the mount served at ``path``, or ``None`` while it is unavailable."""


@dataclass(frozen=True)
class StaticModelMounts:
    """Mounts fixed for the process lifetime (no mounts by default, or test fixtures)."""

    mounts: Mapping[str, ModelMount | None]

    def mount(self, path: str) -> ModelMount | None:
        return self.mounts.get(path)


def _open_regular(root: Path, name: str, *, model: ModelFile | None = None) -> BinaryIO:
    """Open below a trusted root without following replaced directory entries.

    Directory-relative opens keep intermediate symlink substitutions from
    escaping the mount. The final descriptor is checked and then used for the
    entire stream; a path is never reopened by Starlette after these checks.
    """

    try:
        if root.resolve(strict=True) != root:
            raise ValueError("Asset root cannot traverse a symlink")
    except RuntimeError as exc:  # Path resolution can report symlink loops this way.
        raise ValueError("Asset root cannot traverse a symlink loop") from exc
    if WINDOWS:
        return _checked_handle(_open_windows(root, name), model)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = name.split("/")
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        # NONBLOCK avoids waiting on a substituted FIFO before fstat rejects it.
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    return _checked_handle(descriptor, model)


def _open_windows(root: Path, name: str) -> int:
    """Windows has no directory descriptors: refuse a reparse point at every level.

    Each folder is checked before it is entered and the leaf is opened as itself.
    The opened file's resolved path must then be exactly the requested one, which
    also refuses a folder swapped after its check and an 8.3 short-name alias.
    """

    *folders, leaf = name.split("/")
    current = root
    for part in folders:
        current = current / part
        info = os.lstat(current)
        if not is_directory(info):
            raise ValueError("Asset path cannot traverse a link")
    path = current / leaf
    descriptor = open_no_follow(path, os.O_RDONLY)
    try:
        if os.path.normcase(final_path(descriptor)) != os.path.normcase(path):
            raise ValueError("Asset path resolved outside its requested location")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _checked_handle(descriptor: int, model: ModelFile | None) -> BinaryIO:
    """Accept only a regular file; model files must also be single-link and exact-size."""

    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or (
            model is not None and (metadata.st_nlink != 1 or metadata.st_size != model.size_bytes)
        ):
            raise ValueError("Asset is not an eligible regular file")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def _inspect_file(root: Path, name: str, model: ModelFile | None = None) -> tuple[os.stat_result, bytes | None]:
    with _open_regular(root, name, model=model) as handle:
        metadata = os.fstat(handle.fileno())
        html = handle.read() if model is None and Path(name).suffix.lower() == ".html" else None
        return metadata, html


def _read_build_record(root: Path, name: str) -> object:
    """Parse one bounded JSON record from the build; raise when absent, oversized or invalid."""

    with _open_regular(root, name) as handle:
        if os.fstat(handle.fileno()).st_size > _MAX_MANIFEST_BYTES:
            raise ValueError("Build record is too large")
        payload = handle.read(_MAX_MANIFEST_BYTES + 1)
    if len(payload) > _MAX_MANIFEST_BYTES:
        raise ValueError("Build record is too large")
    return json.loads(payload)


def _read_runtime_digests(root: Path) -> Mapping[str, tuple[int, str]]:
    """Map each verified browser runtime file's served name to its size and SHA-256.

    The web build writes the record after copying and rehashing the speech
    runtime under ``onnx/``. Any invalid entry discards the whole record, so
    those files degrade to revalidation without a validator.
    """

    try:
        record = _read_build_record(root, BROWSER_RUNTIME_RECORD)
        if (
            not isinstance(record, dict)
            or record.get("schema_version") != 1
            or not isinstance(record.get("files"), list)
        ):
            return {}
        digests: dict[str, tuple[int, str]] = {}
        for entry in record["files"]:
            if not isinstance(entry, dict):
                return {}
            path, size, digest = entry.get("path"), entry.get("size"), entry.get("sha256")
            if (
                not isinstance(path, str)
                or not path.startswith("onnx/")
                or not _safe_name(path)
                or type(size) is not int
                or size < 0
                or not isinstance(digest, str)
                or not re.fullmatch(r"[0-9a-f]{64}", digest)
            ):
                return {}
            digests[path] = (size, digest)
        return digests
    except (OSError, ValueError, RecursionError):
        return {}


def _read_inventory(root: Path) -> frozenset[str]:
    """Invalid or old build inventories degrade to revalidation, never guessing."""

    try:
        manifest = _read_build_record(root, ".vite/manifest.json")
        if not isinstance(manifest, dict):
            return frozenset()
        paths: set[str] = set()
        for entry in manifest.values():
            if not isinstance(entry, dict):
                continue
            values = [entry.get("file")]
            for field in ("css", "assets"):
                if isinstance(entry.get(field), list):
                    values.extend(entry[field])
            for value in values:
                if isinstance(value, str) and _FINGERPRINTED_CODE.fullmatch(value) and _safe_name(value):
                    paths.add(value)
        return frozenset(paths)
    except (OSError, ValueError, RecursionError):
        return frozenset()


def _error(request: Request, status: int = 404) -> Response:
    response = JSONResponse(
        {"error": "invalid_path" if status == 400 else "not_found"},
        status_code=status,
        headers={"cache-control": "no-store", "x-content-type-options": "nosniff"},
    )
    if request.method == "HEAD":
        response.body = b""
    return response


def _matches_prefix(path: str, prefixes: tuple[str, ...]) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes)


def _decoded_path(request: Request) -> str:
    """Decode the ASGI raw path exactly once and reject malformed UTF-8/escapes."""

    raw = request.scope.get("raw_path")
    if raw is None:
        return cast(str, request.scope["path"])  # An ASGI server's path is already decoded.
    if re.search(rb"%(?![0-9a-fA-F]{2})", raw):
        raise ValueError("Invalid percent encoding")
    return unquote_to_bytes(raw).decode("utf-8", errors="strict")


def _etag_matches(condition: str, etag: str) -> bool:
    return any(
        value.strip() == "*" or value.strip().removeprefix("W/") == etag.removeprefix("W/")
        for value in condition.split(",")
    )


def _unchanged(request: Request, etag: str | None, modified: float | None = None) -> bool:
    if etag is None:
        return False
    condition = request.headers.get("if-none-match")
    if condition is not None:
        return _etag_matches(condition, etag)
    modified_since = request.headers.get("if-modified-since")
    if modified is not None and modified_since:
        try:
            parsed = parsedate_to_datetime(modified_since)
            return parsed.tzinfo is not None and int(modified) <= parsed.timestamp()
        except (ValueError, TypeError, OverflowError):
            pass
    return False


class _FileStream(Response):
    """Use Starlette streaming/disconnect handling with a checked file descriptor."""

    def __init__(
        self,
        request: Request,
        root: Path,
        name: str,
        metadata: os.stat_result,
        headers: dict[str, str],
        *,
        start: int = 0,
        status: int = 200,
        model: ModelFile | None = None,
        not_found: Callable[[Request], Response] = _error,
    ) -> None:
        super().__init__(status_code=status, headers=headers)
        self._request, self._root, self._name = request, root, name
        self._not_found = not_found
        self._metadata, self._model, self._start = metadata, model, start

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        def open_checked() -> BinaryIO:
            handle = _open_regular(self._root, self._name, model=self._model)
            actual = os.fstat(handle.fileno())
            fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
            if any(getattr(actual, field) != getattr(self._metadata, field) for field in fields):
                handle.close()
                raise ValueError("Asset changed before delivery")
            return handle

        try:
            handle = await anyio.to_thread.run_sync(open_checked)
        except (OSError, ValueError):
            await self._not_found(self._request)(scope, receive, send)
            return

        # This outer owner closes even when the client disconnects before the
        # iterator starts, or the ASGI send operation raises during a chunk.
        with handle:

            async def chunks() -> AsyncIterator[bytes]:
                await anyio.to_thread.run_sync(handle.seek, self._start)
                remaining = int(self.headers["content-length"])
                while remaining:
                    chunk = await anyio.to_thread.run_sync(handle.read, min(64 * 1024, remaining))
                    if not chunk:
                        raise OSError("Asset was truncated during delivery")
                    remaining -= len(chunk)
                    yield chunk

            response = StreamingResponse(chunks(), status_code=self.status_code, headers=dict(self.headers))
            await response(scope, receive, send)


class LocalAssets:
    """Serve built browser files and the optional verified model mounts.

    Every built file, including the ``index.html`` fallback for app routes,
    carries ``APP_CONTENT_SECURITY_POLICY`` (the Pocket worker its exception).
    Roots and inventories come from the local composition, never request data.
    Construct a new instance for a different application build. Model mounts
    are resolved per request from ``mount_source``; without one, no models are
    served. An unavailable mount answers 404 and never falls through to the
    built tree.
    """

    def __init__(self, web_root: Path, *, mount_source: ModelMountSource | None = None) -> None:
        self._root = web_root.resolve()
        self._mount_source = mount_source or StaticModelMounts({})
        self._inventory: frozenset[str] | None = None
        self._runtime_digests: Mapping[str, tuple[int, str]] | None = None

    async def response(self, request: Request) -> Response:
        """Respond after product routing; reject unsafe paths before any lookup."""

        if request.method not in ("GET", "HEAD"):
            return _error(request)
        try:
            path = _decoded_path(request)
        except (ValueError, UnicodeError):
            return _error(request, 400)
        if not path.startswith("/") or path.startswith("//"):
            return _error(request)
        name = path[1:].removesuffix("/")
        if (path != "/" and not _safe_name(name)) or _matches_prefix(path, _PRIVATE_PREFIXES):
            return _error(request)
        for prefix in MODEL_MOUNT_PATHS:
            if path == prefix[:-1] or path.startswith(prefix):
                return await self._model_response(request, self._mount_source.mount(prefix), path[len(prefix) :])
        try:
            if name:
                try:
                    metadata, html = await anyio.to_thread.run_sync(_inspect_file, self._root, name)
                except FileNotFoundError:
                    pass
                else:
                    return await self._static_response(request, name, metadata, html)
            navigation = request.headers.get("sec-fetch-mode") == "navigate" or "text/html" in request.headers.get(
                "accept", ""
            )
            # Hidden names were already rejected; a remaining dot in the last
            # component also catches trailing dots, as Node's extname does.
            if not navigation or _matches_prefix(path, _NO_FALLBACK_PREFIXES) or "." in name.rsplit("/", 1)[-1]:
                return _error(request)
            metadata, html = await anyio.to_thread.run_sync(_inspect_file, self._root, "index.html")
            return await self._static_response(request, "index.html", metadata, html)
        except (OSError, ValueError):
            return _error(request)

    async def _static_response(
        self,
        request: Request,
        name: str,
        metadata: os.stat_result,
        html: bytes | None,
    ) -> Response:
        # The built-app Hono responder ignores Range. Preserve its full 200
        # response here; only the optional model mount advertises byte ranges.
        if self._inventory is None:
            self._inventory = await anyio.to_thread.run_sync(_read_inventory, self._root)
        if self._runtime_digests is None:
            self._runtime_digests = await anyio.to_thread.run_sync(_read_runtime_digests, self._root)
        content_type = _CONTENT_TYPES.get(Path(name).suffix.lower(), "application/octet-stream")
        fingerprinted = name in self._inventory and content_type.split(";", 1)[0] in ("text/css", "text/javascript")
        runtime = self._runtime_digests.get(name)
        etag = None
        if html is not None:
            etag = f'"{hashlib.sha256(html).hexdigest()}"'
        elif fingerprinted:
            etag = f'W/"{metadata.st_size:x}-{metadata.st_mtime_ns:x}"'
        elif runtime is not None and runtime[0] == metadata.st_size:
            # Unversioned speech runtime URLs still revalidate, but by the build's
            # verified digest, which normalized file dates cannot make stale.
            etag = f'"{runtime[1]}"'
        headers = {
            "content-type": content_type,
            "content-length": str(len(html) if html is not None else metadata.st_size),
            "x-content-type-options": "nosniff",
            "cache-control": IMMUTABLE_APP_ASSET_CACHE if fingerprinted else "no-cache",
            "content-security-policy": (
                POCKET_WORKER_CONTENT_SECURITY_POLICY if name == POCKET_WORKER else APP_CONTENT_SECURITY_POLICY
            ),
        }
        if etag:
            headers["etag"] = etag
        if fingerprinted:
            headers["last-modified"] = formatdate(metadata.st_mtime, usegmt=True)
        if _unchanged(request, etag, metadata.st_mtime if fingerprinted else None):
            headers.pop("content-length")
            return Response(status_code=304, headers=headers)
        if request.method == "HEAD" or html is not None or not metadata.st_size:
            return Response(content=html if request.method == "GET" else None, headers=headers)
        return _FileStream(request, self._root, name, metadata, headers)

    async def _model_response(self, request: Request, mount: ModelMount | None, name: str) -> Response:
        model = next((file for file in mount.files if file.path == name), None) if mount else None
        versions = request.query_params.getlist("v")
        if mount is None or model is None or (versions and versions != [mount.version]):
            return _error(request)
        cache_control = "private, max-age=31536000, immutable" if versions else "no-cache"
        return await verified_file_response(request, mount.root, model, cache_control=cache_control)


async def verified_file_response(
    request: Request,
    root: Path,
    model: ModelFile,
    *,
    cache_control: str,
    not_found: Callable[[Request], Response] = _error,
) -> Response:
    """Serve one digest-pinned file below a trusted root with ETag and Range.

    The file's identity, link count and length are checked when opened; the
    digest is trusted from the verified inventory rather than rehashed. Missing
    or ineligible files return ``not_found(request)``, by default the ordinary
    JSON 404.
    """

    name = model.path
    try:
        metadata, _ = await anyio.to_thread.run_sync(_inspect_file, root, name, model)
    except (OSError, ValueError):
        return not_found(request)
    etag = f'"{model.sha256}"'
    headers = {
        "content-type": model.media_type,
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "cache-control": cache_control,
        "etag": etag,
    }
    if _unchanged(request, etag):
        return Response(status_code=304, headers=headers)
    start, end, status = 0, metadata.st_size - 1, 200
    requested_range = request.headers.get("range")
    if requested_range and request.headers.get("if-range", etag) == etag:
        try:
            match = re.fullmatch(r"bytes=([0-9]*)-([0-9]*)", requested_range)
            if match is None or not any(match.groups()):
                raise ValueError("Only a single byte range is supported")
            first, last = match.groups()
            start = int(first) if first else max(0, metadata.st_size - int(last))
            end = min(int(last), end) if first and last else end
            if start > end or start < 0:
                raise ValueError("Unsatisfiable range")
        except ValueError:
            headers.update({"content-range": f"bytes */{metadata.st_size}", "cache-control": "no-store"})
            return Response(status_code=416, headers=headers)
        status = 206
        headers["content-range"] = f"bytes {start}-{end}/{metadata.st_size}"
    headers["content-length"] = str(max(0, end - start + 1))
    if request.method == "HEAD" or not metadata.st_size:
        return Response(status_code=status, headers=headers)
    return _FileStream(
        request, root, name, metadata, headers, start=start, status=status, model=model, not_found=not_found
    )
