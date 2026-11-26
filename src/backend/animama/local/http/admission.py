"""Pure ASGI admission, streamed input limits, and request lifetime accounting."""

from __future__ import annotations

import asyncio
import hashlib
import hmac

from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from animama.local.http.config import CAPABILITY_COOKIE, LocalHTTPConfig
from animama.local.http.lifecycle import LocalHTTPLifecycle

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_HIDDEN_PREFIXES = ("/docs", "/redoc", "/openapi.json", "/api/auth")
_UNIQUE_HEADERS = frozenset(
    {b"host", b"origin", b"sec-fetch-site", b"x-animama-csrf", b"x-animama-desktop-control", b"content-length"}
)
# Browsers attach these to requests for loopback URLs; Electron main's Node
# fetch never does. A private control request carrying one came from a page.
_BROWSER_CONTEXT_HEADERS = ("origin", "sec-fetch-site", "sec-fetch-dest")


class _BodyFailure(MultiPartException):
    """Abort parsing with Starlette's partial-upload cleanup protocol.

    Request.form may translate this into 400. The outer response fence retains
    the original transport status, independently of parser exception mapping.
    """

    def __init__(self, status_code: int, code: str) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.detail = {"code": code}


def _secret_matches(actual: str, expected: str) -> bool:
    """Compare fixed-size hashes without accepting duplicate or non-ASCII tokens."""
    return hmac.compare_digest(hashlib.sha256(actual.encode()).digest(), hashlib.sha256(expected.encode()).digest())


def _cookie_matches(raw: str, expected: str) -> bool:
    values = [
        part.strip().partition("=")[2] for part in raw.split(";") if part.strip().partition("=")[0] == CAPABILITY_COOKIE
    ]
    return len(values) == 1 and _secret_matches(values[0], expected)


def _under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


class LocalHTTPAdmission:
    """Authenticate browser metadata before installing a server-owned principal.

    This middleware is added to FastAPI's user middleware stack, inside its
    outer error handler. No forwarded header, old gateway assertion, or browser
    owner header can select an installation identity.
    """

    def __init__(self, app: ASGIApp, *, config: LocalHTTPConfig, lifecycle: LocalHTTPLifecycle) -> None:
        self.app = app
        self.config = config
        self.lifecycle = lifecycle

    async def _reject(self, scope: Scope, receive: Receive, send: Send, status: int, code: str) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": code})
        else:
            await JSONResponse(
                {"error": code}, status_code=status, headers={"cache-control": "no-store", "connection": "close"}
            )(scope, receive, send)

    def _headers(self, scope: Scope) -> dict[str, str] | None:
        result: dict[str, str] = {}
        for name, value in scope["headers"]:
            key = name.lower()
            decoded = key.decode("latin-1")
            if key in _UNIQUE_HEADERS and decoded in result:
                return None
            if b"\r" in value or b"\n" in value or b"\x00" in value:
                return None
            if key == b"cookie" and decoded in result:
                result[decoded] += "; " + value.decode("latin-1")
            else:
                result[decoded] = value.decode("latin-1")
        return result

    def _sign_in_return(self, scope: Scope, headers: dict[str, str]) -> bool:
        """Whether this is the system browser arriving back from OpenAI's sign-in (T1).

        The return is a cross-site top-level navigation to ``127.0.0.1``, so it
        carries neither the page's ``Host`` (on a ``localhost`` stack), an
        ``Origin``, nor the desktop cookie. Only an exact ``GET`` of the return
        path with no body, no ``Origin`` and navigation fetch metadata, at the
        exact return authority, skips the browser checks; anything else falls
        through to them unchanged. The route itself admits only a return whose
        ``state`` matches the pending attempt.
        """
        authority = self.config.sign_in_return_authority
        return (
            authority is not None
            # A WebSocket scope has no method, so this also excludes every upgrade.
            and scope.get("method") == "GET"
            and scope["path"] == self.config.sign_in_return_path
            and headers.get("host", "").strip().lower() == authority
            and "origin" not in headers
            and "transfer-encoding" not in headers
            and headers.get("content-length", "0") == "0"
            and headers.get("sec-fetch-mode", "navigate").lower() == "navigate"
            and headers.get("sec-fetch-dest", "document").lower() == "document"
        )

    def _browser_status(self, scope: Scope, headers: dict[str, str]) -> int | None:
        origin = headers.get("origin")
        site = headers.get("sec-fetch-site")
        site = site.lower() if site is not None else None
        allowed_sites = {None, "none", "same-origin"}
        if self.config.allow_same_site_fetches:
            allowed_sites.add("same-site")
        if origin is not None and origin != self.config.public_origin:
            return 403
        if site not in allowed_sites:
            return 403
        websocket = scope["type"] == "websocket"
        method = scope.get("method", "GET")
        if websocket and origin != self.config.public_origin:
            return 403
        if self.config.desktop is not None:
            if origin is None and (method not in _SAFE_METHODS or site not in {"none", "same-origin"}):
                return 403
            if not _cookie_matches(headers.get("cookie", ""), self.config.desktop.renderer_capability):
                return 401
        if not websocket and _under(scope["path"], "/v1") and method not in _SAFE_METHODS:
            if headers.get("x-animama-csrf") != "1":
                return 403
            # Origin-less mutation is a deliberate local operator request, not
            # a browser fallback. Desktop mutations always require Origin.
            if origin is None:
                if site != "none":
                    return 403
            elif site != "same-origin" and not (self.config.allow_same_site_fetches and site == "same-site"):
                return 403
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        headers = self._headers(scope)
        if headers is None:
            await self._reject(scope, receive, send, 400, "gateway_request_rejected")
            return
        sign_in_return = self._sign_in_return(scope, headers)
        if not sign_in_return and headers.get("host", "").strip().lower() != self.config.authority:
            await self._reject(scope, receive, send, 421, "gateway_request_rejected")
            return
        path = scope["path"]
        if any(_under(path, prefix) for prefix in _HIDDEN_PREFIXES):
            await self._reject(scope, receive, send, 404, "not_found")
            return
        control = _under(path, "/_desktop")
        if control:
            desktop = self.config.desktop
            if (
                scope["type"] != "http"
                or desktop is None
                or any(name in headers for name in _BROWSER_CONTEXT_HEADERS)
                or not _secret_matches(headers.get("x-animama-desktop-control", ""), desktop.control_token)
            ):
                await self._reject(scope, receive, send, 404, "not_found")
                return
        elif not sign_in_return:
            if scope["type"] == "websocket" and path != "/v1/logs":
                await self._reject(scope, receive, send, 404, "not_found")
                return
            rejected = self._browser_status(scope, headers)
            if rejected is not None:
                await self._reject(scope, receive, send, rejected, "gateway_request_rejected")
                return

        length = headers.get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal()):
            await self._reject(scope, receive, send, 400, "gateway_request_rejected")
            return
        if length is not None and (len(length) > 20 or int(length) > self.config.max_body_bytes):
            await self._reject(scope, receive, send, 413, "request_body_too_large")
            return
        if not control:
            failure = self.lifecycle.admit(scope)
            if failure is not None:
                await self._reject(scope, receive, send, 503, failure)
                return
        try:
            if scope["type"] == "websocket":
                await self._websocket(scope, receive, send)
            else:
                await self._http(scope, receive, send)
        finally:
            if not control:
                self.lifecycle.release(scope)

    async def _http(self, scope: Scope, receive: Receive, send: Send) -> None:
        received = 0
        complete = False
        response_started = False
        failure_response_sent = False
        failure: _BodyFailure | None = None
        multipart = any(
            name.lower() == b"content-type" and value.lower().startswith(b"multipart/form-data")
            for name, value in scope["headers"]
        )
        deadline = asyncio.get_running_loop().time() + self.config.body_timeout_seconds

        async def limited_receive() -> Message:
            nonlocal received, complete, failure
            if failure is not None:
                raise failure
            try:
                message = (
                    await receive()
                    if complete
                    else await asyncio.wait_for(receive(), timeout=max(0, deadline - asyncio.get_running_loop().time()))
                )
            except TimeoutError as error:
                failure = _BodyFailure(408, "request_body_timeout")
                raise failure from error
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.config.max_body_bytes:
                    failure = _BodyFailure(413, "request_body_too_large")
                    raise failure
                complete = not message.get("more_body", False)
            elif message["type"] == "http.disconnect":
                if multipart and not complete:
                    failure = _BodyFailure(400, "request_disconnected")
                    raise failure
                complete = True
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started, failure_response_sent
            # A parser or route may catch/translate an input failure. Once the
            # transport limit has failed, it must never turn into a successful
            # response, even if downstream error handling attempts one.
            if failure is not None:
                if failure_response_sent:
                    return
                if response_started:
                    raise failure
                failure_response_sent = True
                response_started = True
                await JSONResponse(
                    {"detail": failure.detail},
                    status_code=failure.status_code,
                    headers={"cache-control": "no-store", "connection": "close"},
                )(scope, receive, send)
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _BodyFailure:
            if failure_response_sent:
                return
            if failure is None or response_started:
                raise
            await JSONResponse(
                {"detail": failure.detail},
                status_code=failure.status_code,
                headers={"cache-control": "no-store", "connection": "close"},
            )(scope, receive, send)

    async def _websocket(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Cancel receive-idle log subscriptions when their peer disconnects.

        The existing log endpoint only sends. A bounded receive pump observes
        disconnect independently and guarantees endpoint finally blocks run.
        It never alters HTTP cancellation or durable mutation semantics.
        """
        messages: asyncio.Queue[Message] = asyncio.Queue(maxsize=2)

        async def pump() -> None:
            while True:
                message = await receive()
                if message["type"] == "websocket.disconnect":
                    return
                try:
                    messages.put_nowait(message)
                except asyncio.QueueFull:
                    await send({"type": "websocket.close", "code": 1008, "reason": "unexpected_websocket_input"})
                    return

        async def run_application() -> None:
            await self.app(scope, messages.get, send)

        application = asyncio.create_task(run_application())
        incoming = asyncio.create_task(pump())
        try:
            done, _ = await asyncio.wait({application, incoming}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in (application, incoming):
                if not task.done():
                    task.cancel()
            # Await endpoint cleanup before releasing the lifecycle admission.
            await asyncio.gather(application, incoming, return_exceptions=True)
