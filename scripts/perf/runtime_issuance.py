"""Measure runtime issuance and bundle reads for a starter Anima.

Starts a disposable PostgreSQL container, scans this checkout's Included content
(pull its Git LFS files first), creates the supplied starter Animas and serves the
shared runtime routes in process. For each starter it issues the runtime several
times, reads every issued bundle and revalidates each JSON bundle with its ETag,
reporting wall time, process CPU time (worker threads included), SQL statements
and how long issuance holds its loadout row lock.

    uv run --no-sync python scripts/perf/runtime_issuance.py --issues 8 --rtt-ms 2

``--rtt-ms`` adds that round trip to every database exchange through a local
TCP proxy, to approximate a database across a network.
"""

from __future__ import annotations

import argparse
import asyncio
import cProfile
import shutil
import statistics
import tempfile
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

REPOSITORY = Path(__file__).resolve().parents[2]
OWNER = "runtime-benchmark-owner"


@dataclass
class Trace:
    """Statements and loadout-lock intervals seen by the engine."""

    statements: int = 0
    lock_started: dict[int, float] = field(default_factory=dict)
    lock_seconds: list[float] = field(default_factory=list)


def _install_trace(engine: Any, trace: Trace) -> None:
    sync_engine = engine.sync_engine

    @event.listens_for(sync_engine, "before_cursor_execute")
    def before(conn, _cursor, statement, _parameters, _context, _executemany):
        trace.statements += 1
        text = statement.upper()
        if "FROM ANIMA_LOADOUTS" in text and " FOR " in text:
            trace.lock_started.setdefault(id(conn.connection), time.perf_counter())

    def finished(conn) -> None:
        started = trace.lock_started.pop(id(conn.connection), None)
        if started is not None:
            trace.lock_seconds.append(time.perf_counter() - started)

    event.listen(sync_engine, "commit", finished)
    event.listen(sync_engine, "rollback", finished)


async def _delay_proxy(target_host: str, target_port: int, delay: float) -> tuple[asyncio.AbstractServer, int]:
    """A loopback TCP proxy that delays each direction by half the round trip."""

    async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while data := await reader.read(65536):
                await asyncio.sleep(delay)
                writer.write(data)
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()

    async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
        server_reader, server_writer = await asyncio.open_connection(target_host, target_port)
        await asyncio.gather(pipe(client_reader, server_writer), pipe(server_reader, client_writer))

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def _prepare_schema(url: str) -> None:
    import animama.local.installation_model  # Local schema registration
    import animama.orm  # noqa: F401 (shared schema registration)
    from animama.orm.base import Base

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql(
            "INSERT INTO model_connections (id, source, name, preset, compatibility, active) "
            "VALUES ('openai', 'builtin', 'OpenAI', 'openai', '{}'::jsonb, TRUE), "
            "('anthropic', 'builtin', 'Anthropic', 'anthropic', '{}'::jsonb, TRUE)"
        )
    await engine.dispose()


async def _create_starters(factory: async_sessionmaker[AsyncSession], paths: Any, settings: Any) -> list[str]:
    from animama.adapters.repositories.sqlalchemy.anima_aggregate_uow import SQLAlchemyAnimaAggregateUnitOfWork
    from animama.adapters.repositories.sqlalchemy.anima_creation_repo import SQLAlchemyAnimaCreationRepository
    from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
    from animama.app.anima_creation_contract import EnsureAnimaStartersRequest
    from animama.app.services.anima_creation_service import AnimaCreationService
    from animama.app.services.anima_creation_sources import AnimaCreationSources
    from animama.app.services.anima_starter_service import AnimaStarterService
    from animama.orm.model_provider import ORMModelProvider
    from animama.server.content_startup import rescan_content_once
    from animama.server.local_runtime import local_content_store

    await rescan_content_once(paths, owner_id=OWNER, session_factory=factory)
    async with factory() as session:
        if await session.get(ORMModelProvider, settings.anima_default_model_provider_id) is None:
            session.add(
                ORMModelProvider(
                    id=settings.anima_default_model_provider_id,
                    provider_type="test",
                    model="benchmark",
                    active=True,
                    model_label="Benchmark",
                    provider_label="Benchmark",
                )
            )
            await session.commit()
        creation = AnimaCreationService(
            uow=SQLAlchemyAnimaAggregateUnitOfWork(session),
            receipts=SQLAlchemyAnimaCreationRepository(session),
            sources=AnimaCreationSources(
                catalog=SQLAlchemyContentCatalog(session),
                store=local_content_store(paths),
                max_identity_bytes=settings.anima_memory_file_max_bytes,
            ),
            default_model_provider_id=settings.anima_default_model_provider_id,
        )
        result = await AnimaStarterService(creation).ensure(
            user_id=OWNER, request=EnsureAnimaStartersRequest(schema_version=1, repairs=[])
        )
        await session.commit()
    return [starter["anima_id"] for starter in result["starters"] if starter.get("anima_id")]


@asynccontextmanager
async def _app(factory: async_sessionmaker[AsyncSession], paths: Any) -> AsyncIterator[AsyncClient]:
    from animama.domain.request_principal import RequestPrincipal
    from animama.product_http.ports import install_product_ports
    from animama.product_http.principal import get_current_principal
    from animama.product_http.routes import anima_runtime
    from animama.server.product_ports import LocalProductPorts

    app = FastAPI()
    app.include_router(anima_runtime.router)
    app.state.local_runtime_paths = paths
    app.state.session_factory = factory

    async def principal() -> RequestPrincipal:
        return RequestPrincipal(id=OWNER)

    app.dependency_overrides[get_current_principal] = principal
    install_product_ports(app, LocalProductPorts(app))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost:8000") as client:
        yield client


def _summary(values: list[float]) -> str:
    if not values:
        return "-"
    ms = sorted(value * 1000 for value in values)
    return f"median {statistics.median(ms):7.1f} ms  min {ms[0]:7.1f}  max {ms[-1]:7.1f}"


async def _measure(
    client: AsyncClient, trace: Trace, anima_id: str, issues: int, profile: cProfile.Profile | None
) -> None:
    wall: list[float] = []
    cpu: list[float] = []
    statements: list[int] = []
    locks: list[float] = []
    runtime: dict[str, Any] = {}
    for index in range(issues + 1):
        trace.lock_seconds.clear()
        before_statements = trace.statements
        if profile is not None and index > 0:
            profile.enable()
        started, started_cpu = time.perf_counter(), time.process_time()
        response = await client.get(f"/v1/animas/{anima_id}/runtime", headers={"Accept-Encoding": "gzip"})
        elapsed, elapsed_cpu = time.perf_counter() - started, time.process_time() - started_cpu
        if profile is not None:
            profile.disable()
        response.raise_for_status()
        runtime = response.json()
        if index == 0:
            print(
                f"  first issue: {elapsed * 1000:.1f} ms wall, {elapsed_cpu * 1000:.1f} ms CPU, "
                f"{trace.statements - before_statements} statements, "
                f"lock {sum(trace.lock_seconds) * 1000:.1f} ms"
            )
            continue
        wall.append(elapsed)
        cpu.append(elapsed_cpu)
        statements.append(trace.statements - before_statements)
        locks.append(sum(trace.lock_seconds))
    descriptor = runtime["content_descriptor"]
    print(
        f"  descriptor: {len(descriptor['members'])} members, {descriptor['total_bytes'] / 1e6:.1f} MB, "
        f"{len(descriptor.get('diagnostics', []))} diagnostics, {len(runtime['bundles'])} bundles, "
        f"response {len(response.content) / 1e6:.2f} MB JSON"
    )
    print(f"  reissue wall: {_summary(wall)}")
    print(f"  reissue CPU:  {_summary(cpu)}")
    print(f"  reissue statements: {statistics.median(statements):.0f}, loadout lock {_summary(locks)}")

    bundle_wall: list[float] = []
    bundle_cpu: list[float] = []
    bundle_statements: list[int] = []
    for _ in range(max(1, issues // 2)):
        for bundle in runtime["bundles"]:
            before_statements = trace.statements
            started, started_cpu = time.perf_counter(), time.process_time()
            read = await client.get(bundle["url"], headers={"Accept-Encoding": "gzip"})
            bundle_wall.append(time.perf_counter() - started)
            bundle_cpu.append(time.process_time() - started_cpu)
            bundle_statements.append(trace.statements - before_statements)
            read.raise_for_status()
    print(f"  bundle wall:  {_summary(bundle_wall)}")
    print(f"  bundle CPU:   {_summary(bundle_cpu)}")
    print(f"  bundle statements: {statistics.median(bundle_statements):.0f}")

    # A revisit revalidates each JSON bundle (ADR 0028) with the validator it holds.
    revalidation_wall: list[float] = []
    revalidation_cpu: list[float] = []
    json_bundles = [bundle for bundle in runtime["bundles"] if bundle["format"] == "json"]
    for bundle in json_bundles:
        etag = (await client.get(bundle["url"], headers={"Accept-Encoding": "gzip"})).headers["etag"]
        for _ in range(max(1, issues // 2)):
            started, started_cpu = time.perf_counter(), time.process_time()
            read = await client.get(bundle["url"], headers={"Accept-Encoding": "gzip", "If-None-Match": etag})
            revalidation_wall.append(time.perf_counter() - started)
            revalidation_cpu.append(time.process_time() - started_cpu)
            if read.status_code != 304:
                raise RuntimeError(f"JSON bundle revalidation returned {read.status_code}, not 304")
    print(f"  JSON bundle 304 wall: {_summary(revalidation_wall)} ({len(json_bundles)} bundles)")
    print(f"  JSON bundle 304 CPU:  {_summary(revalidation_cpu)}")


async def main(arguments: argparse.Namespace) -> None:
    from testcontainers.postgres import PostgresContainer

    from animama.server.config import Settings
    from animama.server.local_runtime import initialize_local_runtime

    with (
        tempfile.TemporaryDirectory(prefix="runtime-issuance-") as directory,
        PostgresContainer(image=arguments.image) as container,
    ):
        root = Path(directory)
        shutil.copytree(REPOSITORY / "content/included", root / "content/included")
        settings = Settings(animama_content_root=root / "content", animama_data_root=root / "data")
        paths = initialize_local_runtime(settings)
        url = make_url(container.get_connection_url(driver="asyncpg"))
        await _prepare_schema(url.render_as_string(hide_password=False))
        proxy = None
        if arguments.rtt_ms > 0:
            proxy, port = await _delay_proxy(url.host or "127.0.0.1", int(url.port or 5432), arguments.rtt_ms / 2000)
            url = url.set(host="127.0.0.1", port=port)
        engine = create_async_engine(url.render_as_string(hide_password=False), pool_size=10)
        trace = Trace()
        _install_trace(engine, trace)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        anima_ids = await _create_starters(factory, paths, settings)
        from animama.orm.anima import ORMAnima

        async with factory() as session:
            names = dict((await session.execute(select(ORMAnima.id, ORMAnima.display_name))).tuples().all())
        profile = cProfile.Profile() if arguments.profile else None
        async with _app(factory, paths) as client:
            for anima_id in anima_ids:
                print(f"{names.get(anima_id, anima_id)} (database round trip {arguments.rtt_ms} ms):")
                await _measure(client, trace, anima_id, arguments.issues, profile)
        if profile is not None:
            profile.dump_stats(arguments.profile)
        await engine.dispose()
        if proxy is not None:
            proxy.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--issues", type=int, default=8, help="reissues to time after the first issue")
    parser.add_argument("--rtt-ms", type=float, default=0, help="added database round trip")
    parser.add_argument("--profile", type=Path, help="write the event loop's reissue profile (pstats) here")
    parser.add_argument("--image", default="pgvector/pgvector:pg16", help="PostgreSQL image with pgvector")
    asyncio.run(main(parser.parse_args()))
