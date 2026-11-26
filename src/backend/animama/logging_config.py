"""Anima logging utilities and configuration.

Environment variables:
- ``ANIMAMA_LOG_TO_FILE``: Enable/disable file logging (default: true)
- ``ANIMAMA_LOG_TO_CONSOLE``: Enable/disable console logging (default: true)
- ``ANIMAMA_LOG_TZ`` / ``ANIMAMA_LOG_TIMEZONE``: IANA timezone name for
  timestamps and daily file rotation (e.g., "America/New_York", "UTC").
  Unset uses the system local timezone.

File logs are emitted as single-line JSON to make ingestion by Loki/OTel
collectors straightforward. Console logs remain human-friendly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import date, datetime
from logging.config import dictConfig
from logging.handlers import BaseRotatingHandler
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from animama.logging import AnimaLoggerAdapter, get_logger

_LOG_DIRECTORY_MODE = 0o775
_LAST_FILE_LOG_DIR: str | None = None
_LAST_FILE_LOG_ERROR: str | None = None


def _ensure_log_directory_permissions(directory: Path) -> None:
    if os.name == "nt":
        return
    try:
        directory.chmod(_LOG_DIRECTORY_MODE)
    except OSError:
        pass


def _str_to_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    value_normalized = value.strip().lower()
    return value_normalized in {"1", "true", "yes", "on"}


def _is_debug_enabled() -> bool:
    return _str_to_bool(os.getenv("ANIMAMA_DEBUG"), default=False)


def _is_file_logging_enabled() -> bool:
    """Return True if file logging should be enabled.

    Controlled via the env var ``ANIMAMA_LOG_TO_FILE`` (defaults to True).
    Set ``ANIMAMA_LOG_TO_FILE=0`` (or "false", "no", etc.) to disable file logs.
    """
    return _str_to_bool(os.getenv("ANIMAMA_LOG_TO_FILE"), default=True)


def _is_console_logging_enabled() -> bool:
    """Return True if console (stdout) logging should be enabled.

    Controlled via the env var ``ANIMAMA_LOG_TO_CONSOLE`` (defaults to True).
    Set ``ANIMAMA_LOG_TO_CONSOLE=0`` (or "false", "no", etc.) to disable
    console logs. Useful for test runs or quiet CI output.
    """
    return _str_to_bool(os.getenv("ANIMAMA_LOG_TO_CONSOLE"), default=True)


def _resolve_log_directory() -> Path:
    path = os.getenv("ANIMAMA_LOG_DIR")
    if path:
        directory = Path(path)
        directory.mkdir(parents=True, exist_ok=True)
        _ensure_log_directory_permissions(directory)
        return directory

    project_root = Path(__file__).resolve().parents[2]
    primary = project_root / ".animama-logs"
    fallback = Path.home() / ".animama-logs"

    for candidate in (primary, fallback):
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            _ensure_log_directory_permissions(candidate)
        except PermissionError:
            continue
        if candidate.is_dir() and os.access(candidate, os.W_OK | os.X_OK):
            return candidate

    raise RuntimeError(f"Unable to locate a writable log directory. Checked: {primary}, {fallback}")


# ---------------- Timezone helpers ----------------


def _get_log_timezone_name() -> str | None:
    """Return configured timezone name or None for system local time.

    Reads from ``ANIMAMA_LOG_TZ`` or ``ANIMAMA_LOG_TIMEZONE``. Examples:
    - "UTC" for Coordinated Universal Time
    - "America/New_York" for US Eastern (observes DST)
    - unset/empty uses the system local timezone
    """
    tz = os.getenv("ANIMAMA_LOG_TZ") or os.getenv("ANIMAMA_LOG_TIMEZONE")
    if tz:
        tz = tz.strip()
        if tz:
            return tz
    return None


def _get_log_timezone() -> ZoneInfo | None:
    name = _get_log_timezone_name()
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        # Invalid timezone string; fall back to local time
        return None


_LOG_TZ = _get_log_timezone()


def _log_datetime_from_ts(ts: float) -> datetime:
    if _LOG_TZ is not None:
        return datetime.fromtimestamp(ts, tz=_LOG_TZ)
    return datetime.fromtimestamp(ts)


def _log_today() -> date:
    if _LOG_TZ is not None:
        return datetime.now(tz=_LOG_TZ).date()
    return date.today()


class DailyLogFileHandler(BaseRotatingHandler):
    """Rotate log files daily using ISO date filenames (e.g., ``2024-05-16.log``)."""

    def __init__(
        self,
        log_directory: str | Path,
        *,
        backup_count: int = 7,
        encoding: str | None = "utf-8",
    ) -> None:
        directory = Path(log_directory)
        directory.mkdir(parents=True, exist_ok=True)
        _ensure_log_directory_permissions(directory)
        self._log_directory = directory
        self.backupCount = backup_count
        self._next_base_filename: Path | None = None
        initial_file = self._filename_for_date(_log_today())
        super().__init__(filename=str(initial_file), mode="a", encoding=encoding, delay=True)

    def shouldRollover(self, record: logging.LogRecord) -> bool:
        record_date = _log_datetime_from_ts(record.created).date()
        current_filename = Path(self.baseFilename).stem
        if record_date.isoformat() != current_filename:
            self._next_base_filename = self._filename_for_date(record_date)
            return True
        return False

    def doRollover(self) -> None:
        if self.stream:
            self.stream.close()
            self.stream = None  # type: ignore[assignment]
        target = self._next_base_filename or self._filename_for_date(_log_today())
        self.baseFilename = str(target)
        self._next_base_filename = None
        if self.backupCount > 0:
            self._prune_old_logs()

    def _filename_for_date(self, current_date: date) -> Path:
        return self._log_directory / f"{current_date.isoformat()}.log"

    def _prune_old_logs(self) -> None:
        log_files = sorted(self._log_directory.glob("*.log"))
        if len(log_files) <= self.backupCount:
            return
        for path in log_files[: len(log_files) - self.backupCount]:
            try:
                path.unlink()
            except OSError:
                # Ignore deletion errors to avoid crashing logging
                pass


def _daily_log_handler_factory(
    log_directory: str,
    backup_count: int = 7,
    encoding: str | None = "utf-8",
) -> DailyLogFileHandler:
    return DailyLogFileHandler(
        log_directory=log_directory,
        backup_count=backup_count,
        encoding=encoding,
    )


class ContextFormatter(logging.Formatter):
    """Attach arbitrary ``extra`` context as JSON after the base log message."""

    _RESERVED_KEYS = set(logging.makeLogRecord({}).__dict__.keys())
    _COERCE_PRIMITIVES = (str, int, float, bool)
    _COERCE_SEQUENCES = (list, tuple, set)

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extras: dict[str, Any] = {}
        for key, value in record.__dict__.items():
            if key in self._RESERVED_KEYS or key.startswith("_"):
                continue
            extras[key] = self._coerce(value)
        if not extras:
            return base
        extras_json = json.dumps(extras, ensure_ascii=False, sort_keys=True, indent=2)
        return f"{base}\n{extras_json}"

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # Match logging API
        dt = _log_datetime_from_ts(record.created)
        if datefmt:
            return dt.strftime(datefmt)
        # Match logging.Formatter default format: '%Y-%m-%d %H:%M:%S,%03d'
        return f"{dt.strftime('%Y-%m-%d %H:%M:%S')},{int(record.msecs):03d}"

    @classmethod
    def _coerce(cls, value: Any) -> Any:
        if isinstance(value, cls._COERCE_PRIMITIVES) or value is None:
            return value
        if isinstance(value, cls._COERCE_SEQUENCES):
            return [cls._coerce(item) for item in value]
        if isinstance(value, dict):
            return {str(k): cls._coerce(v) for k, v in value.items()}
        try:
            return str(value)
        except Exception:  # pragma: no cover - defensive
            return repr(value)


class JsonFormatter(logging.Formatter):
    """Emit one-line JSON logs with standard fields plus any ``extra`` context."""

    def format(self, record: logging.LogRecord) -> str:
        payload = self._build_payload(record)
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)

    def _build_payload(self, record: logging.LogRecord) -> dict[str, Any]:
        dt = _log_datetime_from_ts(record.created)
        try:
            if dt.tzinfo is None:
                dt = dt.astimezone()
        except Exception:
            pass

        timestamp = dt.isoformat(timespec="milliseconds")

        payload: dict[str, Any] = {
            "timestamp": timestamp,
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
            "process": record.process,
            "thread": record.threadName,
        }

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        elif record.exc_text:
            payload["exception"] = record.exc_text

        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)

        reserved = ContextFormatter._RESERVED_KEYS
        for key, value in record.__dict__.items():
            if key in reserved or key.startswith("_"):
                continue
            if key in payload:
                continue
            payload[key] = ContextFormatter._coerce(value)

        return payload


_DEBUG_ENABLED = _is_debug_enabled()
_SELECTED_LEVEL = logging.DEBUG if _DEBUG_ENABLED else logging.INFO


def _build_logging_config() -> dict[str, Any]:
    """Construct logging config dynamically so file logging can be disabled."""
    global _LAST_FILE_LOG_DIR, _LAST_FILE_LOG_ERROR
    _LAST_FILE_LOG_DIR = None
    _LAST_FILE_LOG_ERROR = None

    formatters = {
        "standard": {
            "()": ContextFormatter,
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        },
        "json": {
            "()": JsonFormatter,
        },
    }

    handlers: dict[str, Any] = {}
    root_handlers: list[str] = []

    # Optional console handler
    if _is_console_logging_enabled():
        handlers["console"] = {
            "level": _SELECTED_LEVEL,
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout",
            "formatter": "standard",
        }
        root_handlers.append("console")
    if _is_file_logging_enabled():
        try:
            log_dir = str(_resolve_log_directory())
            _LAST_FILE_LOG_DIR = log_dir
            handlers["file"] = {
                "level": "DEBUG",
                "()": _daily_log_handler_factory,
                "log_directory": log_dir,
                "backup_count": 7,
                "formatter": "json",
            }
            root_handlers.append("file")
        except Exception as exc:
            _LAST_FILE_LOG_ERROR = str(exc)
            # If we cannot resolve a writable dir, fall back to console-only
            pass

    loggers = {
        # Our package logs
        "anima": {
            "level": logging.DEBUG if _DEBUG_ENABLED else logging.INFO,
            "propagate": True,
        },
        # Uvicorn server logs. Access lines stay off: see uvicorn.access below.
        "uvicorn": {
            "level": "INFO",
            "propagate": True,
        },
        "uvicorn.error": {
            "level": "INFO",
            "propagate": True,
        },
        # Off, as the launcher's ``access_log=False`` intends: a request line carries its
        # query, which for the ChatGPT sign-in return holds a one-time code and state.
        # Uvicorn writes access lines whenever this logger has a handler, so it gets
        # none and does not propagate to the root handlers.
        "uvicorn.access": {
            "level": "INFO",
            "handlers": [],
            "propagate": False,
        },
        # Optional: client logs (httpx). Many details are DEBUG-level in httpx/httpcore.
        # The provider SDKs log through httpx2/httpcore2, configured the same way.
        "httpx": {
            "level": "INFO",
            "propagate": False,
        },
        "httpcore": {
            "level": "WARNING",
            "propagate": False,
        },
        "httpx2": {
            "level": "INFO",
            "propagate": False,
        },
        "httpcore2": {
            "level": "WARNING",
            "propagate": False,
        },
        # At DEBUG the provider SDKs log each request body, with the chat's text
        # and any images it sends, so they stay at INFO even with ANIMAMA_DEBUG.
        "anthropic": {
            "level": "INFO",
            "propagate": True,
        },
        "openai": {
            "level": "INFO",
            "propagate": True,
        },
    }

    cfg = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": formatters,
        "handlers": handlers,
        "root": {
            "level": logging.DEBUG if _DEBUG_ENABLED else logging.INFO,
            "handlers": root_handlers,
        },
        "loggers": loggers,
    }
    return cfg


__all__ = ["configure_logging", "get_logger", "AnimaLoggerAdapter"]

# ---------------- Log broadcast support (for WS streaming) ----------------


class _LogSubscribers:
    def __init__(self) -> None:
        self._subs: list[asyncio.Queue[dict[str, Any]]] = []
        self._lock = asyncio.Lock()

    async def subscribe(self, *, size: int = 512) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(size)
        async with self._lock:
            self._subs.append(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            try:
                self._subs.remove(q)
            except ValueError:
                pass

    async def publish(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # Drop if consumer is slow
                pass


_LOG_SUBS = _LogSubscribers()


class BroadcastLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - integration
        try:
            # Use this handler's formatter to build the same line that goes to console/file
            try:
                formatted = self.format(record)
            except Exception:
                formatted = f"{record.name} - {record.levelname} - {record.getMessage()}"

            payload: dict[str, Any] = {
                "logger": record.name,
                "level": record.levelname,
                "message": record.getMessage(),
                "time": _log_datetime_from_ts(record.created).isoformat(),
                # Preformatted full line (including extras JSON) for direct CLI printing
                "text": formatted,
            }
            # Attach safe extras (keys not reserved); clients can still consume structured fields if desired
            for k, v in record.__dict__.items():
                if k in ContextFormatter._RESERVED_KEYS or k.startswith("_"):
                    continue
                if k in (
                    "msg",
                    "args",
                    "name",
                    "levelname",
                    "levelno",
                    "pathname",
                    "filename",
                    "module",
                    "exc_info",
                    "exc_text",
                    "stack_info",
                    "lineno",
                    "funcName",
                    "created",
                    "msecs",
                    "relativeCreated",
                    "thread",
                    "threadName",
                    "processName",
                    "process",
                ):
                    continue
                try:
                    payload[k] = ContextFormatter._coerce(v)
                except Exception:
                    payload[k] = str(v)
            loop = asyncio.get_running_loop()
            loop.create_task(_LOG_SUBS.publish(payload))
        except RuntimeError:
            # No running loop; ignore broadcast in this context
            pass


async def subscribe_logs(queue_size: int = 512) -> asyncio.Queue[dict[str, Any]]:
    return await _LOG_SUBS.subscribe(size=queue_size)


async def unsubscribe_logs(q: asyncio.Queue[dict[str, Any]]) -> None:
    await _LOG_SUBS.unsubscribe(q)


def _attach_broadcast_handler() -> None:
    """Attach a single broadcast handler to root (idempotent across reconfigure)."""
    root_logger = logging.getLogger()
    for handler in list(root_logger.handlers):
        if getattr(handler, "_anima_broadcast_handler", False):
            root_logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass

    handler = BroadcastLogHandler()
    handler._anima_broadcast_handler = True  # type: ignore[attr-defined]
    handler.setLevel(_SELECTED_LEVEL)
    # Match console/file "standard" format so websocket clients see identical lines
    handler.setFormatter(ContextFormatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s"))
    root_logger.addHandler(handler)


def configure_logging() -> None:
    """(Re)apply Anima logging handlers and restore the broadcast handler.

    Uvicorn/FastAPI may install their own logging config after module import,
    which can replace root handlers (including our file handler). Calling this
    after app startup restores Anima's logging configuration.
    """
    cfg = _build_logging_config()
    dictConfig(cfg)
    _attach_broadcast_handler()

    try:
        logging.getLogger("anima.logging_config").info(
            "Logging configured",
            extra={
                "console_enabled": "console" in cfg.get("handlers", {}),
                "file_enabled": "file" in cfg.get("handlers", {}),
                "file_log_dir": _LAST_FILE_LOG_DIR,
                "file_log_error": _LAST_FILE_LOG_ERROR,
                "root_handler_types": [type(h).__name__ for h in logging.getLogger().handlers],
            },
        )
    except Exception:
        pass


# Configure once on import, then callers (e.g., app startup) may re-apply.
try:  # pragma: no cover - depends on runtime environment
    configure_logging()
except Exception:
    pass

# end timezone helpers
