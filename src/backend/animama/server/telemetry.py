"""Optional OpenTelemetry wiring for the local server: exporters, FastAPI, HTTP-client,
database, logging and WebSocket instrumentation, and process metrics.

Every part is best-effort, so missing exporters or packages never block start-up.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from opentelemetry.metrics import CallbackOptions, Observation
    from opentelemetry.sdk.metrics.export import MetricExporter
    from opentelemetry.sdk.trace.export import SpanExporter
    from sqlalchemy.engine import Engine
    from sqlalchemy.ext.asyncio import AsyncEngine
    from starlette.middleware.base import RequestResponseEndpoint
    from starlette.responses import Response
    from starlette.types import ASGIApp, Message, Receive, Scope, Send

from fastapi import FastAPI, Request

_log = logging.getLogger(__name__)
_providers_initialized = False
_instrumented: set[str] = set()
_http_metrics_initialized = False
_ws_metrics_initialized = False

_http_request_counter = None
_http_error_counter = None
_http_duration_histogram = None
_http_active_requests = None

_ws_connection_counter = None
_ws_disconnect_counter = None
_ws_error_counter = None
_ws_message_counter = None
_ws_duration_histogram = None
_ws_active_connections = None


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_csv(name: str) -> set[str]:
    raw = os.getenv(name, "")
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _is_disabled(name: str, extra_aliases: Iterable[str] | None = None) -> bool:
    disabled = _env_csv("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS")
    name = name.lower()
    if name in disabled:
        return True
    if extra_aliases:
        return any(alias.lower() in disabled for alias in extra_aliases)
    return False


def _exporter_enabled(env_name: str, *, default: bool = True) -> bool:
    value = os.getenv(env_name)
    if value is None:
        return default
    return value.strip().lower() not in {"none", "false", "0", "no"}


def _otlp_protocol() -> str:
    return os.getenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc").strip().lower()


def _default_otlp_endpoint(protocol: str) -> str:
    if protocol.startswith("http"):
        return "http://otel-collector:4318"
    return "otel-collector:4317"


def _normalize_otlp_endpoint(endpoint: str | None, protocol: str, *, signal: str | None = None) -> str:
    if not endpoint:
        return _default_otlp_endpoint(protocol)
    endpoint = endpoint.strip()
    if protocol.startswith("http"):
        if not endpoint.startswith("http://") and not endpoint.startswith("https://"):
            endpoint = f"http://{endpoint}"
        if signal:
            try:
                from urllib.parse import urlparse, urlunparse

                parsed = urlparse(endpoint)
                if not parsed.path or parsed.path == "/":
                    endpoint = urlunparse(parsed._replace(path=f"/v1/{signal}"))
            except Exception:
                pass
        return endpoint
    if endpoint.startswith("http://"):
        return endpoint[len("http://") :]
    if endpoint.startswith("https://"):
        return endpoint[len("https://") :]
    return endpoint


def _route_for_request(request: Request, fallback: str) -> str:
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    return route_path or fallback


def _http_metrics_excluded(path: str) -> bool:
    excludes = _env_csv("ANIMAMA_OTEL_HTTP_METRICS_EXCLUDE")
    if not excludes:
        return False
    return path in excludes


def _ws_metrics_excluded(path: str) -> bool:
    excludes = _env_csv("ANIMAMA_OTEL_WS_METRICS_EXCLUDE")
    if not excludes:
        return False
    return path in excludes


def _route_for_scope(scope: Mapping[str, Any], fallback: str) -> str:
    route = scope.get("route")
    route_path = getattr(route, "path", None)
    return route_path or fallback


def _setup_http_metrics(app: FastAPI) -> None:
    global _http_metrics_initialized
    global _http_request_counter, _http_error_counter, _http_duration_histogram, _http_active_requests
    if _http_metrics_initialized:
        return
    try:
        from opentelemetry import metrics

        meter = metrics.get_meter("anima.http")
        _http_request_counter = meter.create_counter(
            "anima.http.requests",
            description="Total inbound HTTP requests",
            unit="1",
        )
        _http_error_counter = meter.create_counter(
            "anima.http.errors",
            description="Total inbound HTTP 5xx responses",
            unit="1",
        )
        _http_duration_histogram = meter.create_histogram(
            "anima.http.duration",
            description="Inbound HTTP request duration",
            unit="ms",
        )
        _http_active_requests = meter.create_up_down_counter(
            "anima.http.active_requests",
            description="Active inbound HTTP requests",
            unit="1",
        )
    except Exception as exc:
        _log.warning("HTTP metrics setup failed: %s", exc)
        return

    @app.middleware("http")
    async def _otel_http_metrics(request: Request, call_next: RequestResponseEndpoint) -> Response:
        raw_path = request.url.path
        if _http_metrics_excluded(raw_path):
            return await call_next(request)

        active_attrs = {"http.method": request.method, "http.route": raw_path}
        if _http_active_requests is not None:
            _http_active_requests.add(1, active_attrs)

        status_code = 500
        exc_raised = False
        start = time.perf_counter()
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception:
            exc_raised = True
            raise
        finally:
            duration_ms = (time.perf_counter() - start) * 1000.0
            route = _route_for_request(request, raw_path)
            attrs: dict[str, str | int] = {
                "http.method": request.method,
                "http.route": route,
                "http.status_code": status_code,
            }
            if _http_request_counter is not None:
                _http_request_counter.add(1, attrs)
            if _http_duration_histogram is not None:
                _http_duration_histogram.record(duration_ms, attrs)
            if (exc_raised or status_code >= 500) and _http_error_counter is not None:
                _http_error_counter.add(1, attrs)
            if _http_active_requests is not None:
                _http_active_requests.add(-1, active_attrs)

    _http_metrics_initialized = True


class WebSocketMetricsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "websocket":
            return await self.app(scope, receive, send)

        raw_path = scope.get("path", "")
        if _ws_metrics_excluded(raw_path):
            return await self.app(scope, receive, send)

        route = _route_for_scope(scope, raw_path)
        active_attrs = {"ws.route": route}
        if _ws_active_connections is not None:
            _ws_active_connections.add(1, active_attrs)

        start = time.perf_counter()
        close_code = None
        exc_raised = False

        async def wrapped_receive() -> Message:
            message = await receive()
            if message.get("type") == "websocket.receive" and _ws_message_counter is not None:
                _ws_message_counter.add(1, {"ws.route": route, "ws.direction": "in"})
            return message

        async def wrapped_send(message: Message) -> None:
            nonlocal close_code
            msg_type = message.get("type")
            if msg_type == "websocket.send" and _ws_message_counter is not None:
                _ws_message_counter.add(1, {"ws.route": route, "ws.direction": "out"})
            if msg_type == "websocket.close":
                close_code = message.get("code")
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        except Exception:
            exc_raised = True
            raise
        finally:
            duration_ms = (time.perf_counter() - start) * 1000.0
            attrs: dict[str, str | int] = {"ws.route": route}
            if close_code is not None:
                attrs["ws.close_code"] = close_code
            if _ws_connection_counter is not None:
                _ws_connection_counter.add(1, attrs)
            if _ws_duration_histogram is not None:
                _ws_duration_histogram.record(duration_ms, attrs)
            if _ws_disconnect_counter is not None:
                _ws_disconnect_counter.add(1, attrs)
            if exc_raised and _ws_error_counter is not None:
                _ws_error_counter.add(1, attrs)
            if _ws_active_connections is not None:
                _ws_active_connections.add(-1, active_attrs)


def _setup_ws_metrics(app: FastAPI) -> None:
    global _ws_metrics_initialized
    global _ws_connection_counter
    global _ws_disconnect_counter
    global _ws_error_counter
    global _ws_message_counter
    global _ws_duration_histogram
    global _ws_active_connections
    if _ws_metrics_initialized:
        return
    try:
        from opentelemetry import metrics

        meter = metrics.get_meter("anima.websocket")
        _ws_connection_counter = meter.create_counter(
            "ws.server.connections",
            description="Total websocket connections",
            unit="1",
        )
        _ws_disconnect_counter = meter.create_counter(
            "ws.server.disconnects",
            description="Total websocket disconnects",
            unit="1",
        )
        _ws_error_counter = meter.create_counter(
            "ws.server.errors",
            description="Total websocket handler errors",
            unit="1",
        )
        _ws_message_counter = meter.create_counter(
            "ws.server.messages",
            description="Total websocket messages",
            unit="1",
        )
        _ws_duration_histogram = meter.create_histogram(
            "ws.server.duration",
            description="Websocket session duration",
            unit="ms",
        )
        _ws_active_connections = meter.create_up_down_counter(
            "ws.server.active_connections",
            description="Active websocket connections",
            unit="1",
        )
    except Exception as exc:
        _log.warning("WebSocket metrics setup failed: %s", exc)
        return

    app.add_middleware(WebSocketMetricsMiddleware)
    _ws_metrics_initialized = True


def fastapi_excluded_urls() -> str:
    """The operator's excluded URLs plus the ChatGPT sign-in return.

    The return's query carries a one-time code and the attempt's state, so it is
    never traced. Passing a list replaces the environment's, so both are kept.
    """

    configured = os.getenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS") or os.getenv("OTEL_PYTHON_EXCLUDED_URLS") or ""
    return ",".join(part for part in (configured.strip(), "auth/callback") if part)


def _instrument_fastapi(app: FastAPI) -> None:
    if _is_disabled("fastapi", extra_aliases=("asgi",)):
        return
    if "fastapi" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls=fastapi_excluded_urls())
        _instrumented.add("fastapi")
    except Exception as exc:
        _log.warning("FastAPI instrumentation failed: %s", exc)


def _instrument_httpx() -> None:
    if _is_disabled("httpx"):
        return
    if "httpx" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        _instrumented.add("httpx")
    except Exception as exc:
        _log.warning("httpx instrumentation failed: %s", exc)


def _instrument_aiohttp() -> None:
    if _is_disabled("aiohttp-client", extra_aliases=("aiohttp",)):
        return
    if "aiohttp-client" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.aiohttp_client import AioHttpClientInstrumentor

        AioHttpClientInstrumentor().instrument()
        _instrumented.add("aiohttp-client")
    except Exception as exc:
        _log.warning("aiohttp client instrumentation failed: %s", exc)


def _instrument_asyncpg() -> None:
    if _is_disabled("asyncpg"):
        return
    if "asyncpg" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor

        AsyncPGInstrumentor().instrument()  # type: ignore[no-untyped-call]
        _instrumented.add("asyncpg")
    except Exception as exc:
        _log.warning("asyncpg instrumentation failed: %s", exc)


def _instrument_process_metrics() -> None:
    if _is_disabled("process-metrics", extra_aliases=("process",)):
        return
    if "process-metrics" in _instrumented:
        return
    try:
        import psutil
        from opentelemetry import metrics
        from opentelemetry.metrics import Observation

        proc = psutil.Process()
        proc.cpu_percent(interval=None)
        meter = metrics.get_meter("anima.process")

        def cpu_callback(_: CallbackOptions) -> list[Observation]:
            try:
                return [Observation(proc.cpu_percent(interval=None))]
            except Exception:
                return []

        def rss_callback(_: CallbackOptions) -> list[Observation]:
            try:
                return [Observation(proc.memory_info().rss)]
            except Exception:
                return []

        def vms_callback(_: CallbackOptions) -> list[Observation]:
            try:
                return [Observation(proc.memory_info().vms)]
            except Exception:
                return []

        def threads_callback(_: CallbackOptions) -> list[Observation]:
            try:
                return [Observation(proc.num_threads())]
            except Exception:
                return []

        meter.create_observable_gauge(
            "process.cpu.percent",
            callbacks=[cpu_callback],
            description="Process CPU utilization",
            unit="%",
        )
        meter.create_observable_gauge(
            "process.memory.rss",
            callbacks=[rss_callback],
            description="Process resident memory",
            unit="By",
        )
        meter.create_observable_gauge(
            "process.memory.vms",
            callbacks=[vms_callback],
            description="Process virtual memory",
            unit="By",
        )
        meter.create_observable_gauge(
            "process.threads",
            callbacks=[threads_callback],
            description="Process thread count",
            unit="1",
        )

        _instrumented.add("process-metrics")
    except Exception as exc:
        _log.warning("Process metrics instrumentation failed: %s", exc)


def _instrument_system_metrics() -> None:
    if _is_disabled("system-metrics", extra_aliases=("system",)):
        return
    if "system-metrics" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor

        SystemMetricsInstrumentor().instrument()
        _instrumented.add("system-metrics")
    except Exception as exc:
        _log.warning("System metrics instrumentation failed: %s", exc)


def _instrument_logging() -> None:
    if _is_disabled("logging"):
        return
    if "logging" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.logging import LoggingInstrumentor

        LoggingInstrumentor().instrument(set_logging_format=False)
        _instrumented.add("logging")
    except Exception as exc:
        _log.warning("Logging instrumentation failed: %s", exc)


def instrument_sqlalchemy(engine: AsyncEngine | Engine) -> None:
    if _is_disabled("sqlalchemy"):
        return
    if "sqlalchemy" in _instrumented:
        return
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        sync_engine = getattr(engine, "sync_engine", engine)
        SQLAlchemyInstrumentor().instrument(engine=sync_engine)
        _instrumented.add("sqlalchemy")
    except Exception as exc:
        _log.warning("SQLAlchemy instrumentation failed: %s", exc)


def setup_telemetry(app: FastAPI, *, service_name: str, service_version: str | None) -> None:
    if _env_flag("OTEL_SDK_DISABLED", True):
        return

    global _providers_initialized
    if not _providers_initialized:
        try:
            from opentelemetry import metrics, trace
            from opentelemetry.sdk.metrics import MeterProvider
            from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
            from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor

            environment = os.getenv("ANIMAMA_ENV") or os.getenv("ENV") or "local"
            resource = Resource.create(
                {
                    SERVICE_NAME: os.getenv("OTEL_SERVICE_NAME", service_name),
                    SERVICE_VERSION: service_version or "0.1.0",
                    "deployment.environment": environment,
                }
            )

            insecure = _env_flag("OTEL_EXPORTER_OTLP_INSECURE", True)
            protocol = _otlp_protocol()
            traces_endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.getenv(
                "OTEL_EXPORTER_OTLP_ENDPOINT"
            )
            metrics_endpoint = os.getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") or os.getenv(
                "OTEL_EXPORTER_OTLP_ENDPOINT"
            )
            traces_endpoint = _normalize_otlp_endpoint(traces_endpoint, protocol, signal="traces")
            metrics_endpoint = _normalize_otlp_endpoint(metrics_endpoint, protocol, signal="metrics")

            if _exporter_enabled("OTEL_TRACES_EXPORTER", default=True):
                span_exporter: SpanExporter
                if protocol.startswith("http"):
                    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                        OTLPSpanExporter as HttpOTLPSpanExporter,
                    )

                    span_exporter = HttpOTLPSpanExporter(endpoint=traces_endpoint)
                else:
                    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

                    span_exporter = OTLPSpanExporter(endpoint=traces_endpoint, insecure=insecure)
                tracer_provider = TracerProvider(resource=resource)
                tracer_provider.add_span_processor(BatchSpanProcessor(span_exporter))
                trace.set_tracer_provider(tracer_provider)

            if _exporter_enabled("OTEL_METRICS_EXPORTER", default=True):
                metric_exporter: MetricExporter
                if protocol.startswith("http"):
                    from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
                        OTLPMetricExporter as HttpOTLPMetricExporter,
                    )

                    metric_exporter = HttpOTLPMetricExporter(endpoint=metrics_endpoint)
                else:
                    from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

                    metric_exporter = OTLPMetricExporter(endpoint=metrics_endpoint, insecure=insecure)
                metric_reader = PeriodicExportingMetricReader(metric_exporter)
                metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[metric_reader]))

            _providers_initialized = True
        except Exception as exc:
            _log.warning("OpenTelemetry provider setup failed: %s", exc)
            return

    _instrument_fastapi(app)
    _instrument_httpx()
    _instrument_aiohttp()
    _instrument_asyncpg()
    if _env_flag("ANIMAMA_OTEL_LOG_CORRELATION", False):
        _instrument_logging()

    if _exporter_enabled("OTEL_METRICS_EXPORTER", default=True):
        if _env_flag("ANIMAMA_OTEL_HTTP_METRICS", True):
            _setup_http_metrics(app)
        if _env_flag("ANIMAMA_OTEL_WS_METRICS", True):
            _setup_ws_metrics(app)
        if _env_flag("ANIMAMA_OTEL_PROCESS_METRICS", True):
            _instrument_process_metrics()
        if _env_flag("ANIMAMA_OTEL_SYSTEM_METRICS", True):
            _instrument_system_metrics()
