"""Explicit immutable configuration for an installation-owned HTTP boundary."""

from __future__ import annotations

import ipaddress
import math
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

TRANSPORT_BODY_LIMIT = 128 * 1024 * 1024
CAPABILITY_COOKIE = "animama_renderer_capability"


def canonical_origin(value: str) -> str:
    """Reject ambiguous URL input and return a bare browser origin."""
    if not isinstance(value, str) or not value or not value.isascii():
        raise ValueError("Local HTTP requires an ASCII HTTP(S) origin")
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value) or "\\" in value:
        raise ValueError("Local HTTP origin contains invalid characters")
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or "?" in value
            or "#" in value
            or port == 0
            or "%" in parsed.netloc
            or parsed.netloc.endswith(":")
        ):
            raise ValueError("Local HTTP requires a bare HTTP(S) origin")
    except ValueError as error:
        raise ValueError("Local HTTP requires a valid HTTP(S) origin") from error
    host = parsed.hostname.lower()
    if ":" in host:
        ipaddress.IPv6Address(host)
    elif not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?", host):
        raise ValueError("Local HTTP origin contains an invalid hostname")
    authority = f"[{host}]" if ":" in host else host
    if port is not None and port != (443 if parsed.scheme == "https" else 80):
        authority += f":{port}"
    return f"{parsed.scheme}://{authority}"


@dataclass(frozen=True)
class DesktopAccess:
    """Separate launch secrets; neither credential is printable configuration."""

    renderer_capability: str = field(repr=False)
    control_token: str = field(repr=False)

    def __post_init__(self) -> None:
        for value in (self.renderer_capability, self.control_token):
            if (
                not isinstance(value, str)
                or len(value) < 32
                or not value.isascii()
                or any(not character.isalnum() and character not in "-_" for character in value)
            ):
                raise ValueError("Desktop credentials must be at least 32 URL-safe ASCII characters")
        if self.renderer_capability == self.control_token:
            raise ValueError("Desktop renderer and control credentials must be distinct")


@dataclass(frozen=True)
class LocalHTTPConfig:
    """Composition-owned policy, never derived from request headers or query input."""

    public_origin: str
    desktop: DesktopAccess | None = None
    max_body_bytes: int = TRANSPORT_BODY_LIMIT
    body_timeout_seconds: float = 120.0
    allow_same_site_fetches: bool = False
    sign_in_return_path: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "public_origin", canonical_origin(self.public_origin))
        if self.desktop is not None and not isinstance(self.desktop, DesktopAccess):
            raise ValueError("Desktop access must use the explicit credential configuration")
        if type(self.max_body_bytes) is not int or not 0 < self.max_body_bytes <= TRANSPORT_BODY_LIMIT:
            raise ValueError("The request body ceiling must be positive and no larger than 128 MiB")
        if (
            isinstance(self.body_timeout_seconds, bool)
            or not isinstance(self.body_timeout_seconds, int | float)
            or not math.isfinite(self.body_timeout_seconds)
            or not 0 < self.body_timeout_seconds <= 120
        ):
            raise ValueError("The request body deadline must be positive and no longer than 120 seconds")
        if type(self.allow_same_site_fetches) is not bool:
            raise ValueError("Same-site admission must be an explicit boolean")
        if self.sign_in_return_path is not None and not re.fullmatch(r"(/[a-z]+)+", self.sign_in_return_path):
            raise ValueError("The sign-in return path must be a fixed lower-case path")

    @property
    def authority(self) -> str:
        """The single expected Host header, including a non-default port."""
        return urlsplit(self.public_origin).netloc

    @property
    def sign_in_return_authority(self) -> str | None:
        """The ``Host`` of an OpenAI sign-in return, ``127.0.0.1:<port>``, or None when it cannot reach this server.

        OpenAI sends the browser back only to ``http://127.0.0.1:<port>``. That
        address reaches this server only when its own origin is loopback
        ``http`` at the same port (D14): ``127.0.0.1``, ``localhost`` or a
        ``*.localhost`` name, which browsers resolve to loopback (RFC 6761).
        """
        if self.sign_in_return_path is None:
            return None
        parsed = urlsplit(self.public_origin)
        host = parsed.hostname or ""
        if parsed.scheme != "http" or not (host in {"localhost", "127.0.0.1"} or host.endswith(".localhost")):
            return None
        # Browsers omit the default port from Host, so port 80 is a bare address.
        return "127.0.0.1" if parsed.port in (None, 80) else f"127.0.0.1:{parsed.port}"
