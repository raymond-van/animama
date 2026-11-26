from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator, Iterator
from importlib import util
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import pytest
import pytest_asyncio
import sqlalchemy

# Isolate before importing application modules: Settings captures some defaults
# at import time, and Embedder/live helpers may call python-dotenv themselves.
# Pytest never loads .env. Explicit live Make targets may export its credentials.
_test_environment = pytest.MonkeyPatch()
_test_roots = TemporaryDirectory(prefix="animama-pytest-")
_live_tests_enabled = os.environ.get("ANIMAMA_RUN_LIVE_TESTS") == "1"
for _name in tuple(os.environ):
    if _name.startswith("ANIMAMA_") and not (
        _name.startswith("ANIMAMA_TEST_")
        or _name in {"ANIMAMA_RUN_LIVE_TESTS", "ANIMAMA_RUN_ASSET_SCALE_BENCHMARK"}
        or (_live_tests_enabled and _name == "ANIMAMA_LIVE_OPENAI_API_KEY")
    ):
        _test_environment.delenv(_name)

_PROVIDER_ENVIRONMENT = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "DEEPSEEK_API_KEY",
    "HF_TOKEN",
    "OPENROUTER_API_KEY",
    "ELEVENLABS_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
)
for _name in _PROVIDER_ENVIRONMENT:
    if not (_live_tests_enabled and _name in {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"}):
        _test_environment.delenv(_name, raising=False)
if not _live_tests_enabled:
    _test_environment.setenv("OPENAI_API_KEY", "test-key")

_test_environment.setenv("PYTHON_DOTENV_DISABLED", "1")
_test_environment.setenv("ANIMAMA_CONTENT_ROOT", str(Path(__file__).resolve().parents[1] / "content"))
_test_environment.setenv("ANIMAMA_DATA_ROOT", str(Path(_test_roots.name) / "data"))
_test_environment.setenv("ANIMAMA_LOG_TO_FILE", "0")
_test_environment.setenv("ANIMAMA_LOG_TO_CONSOLE", "0")
_test_environment.setenv("ANIMAMA_DISABLE_WEBUI_TELEMETRY", "1")
_test_environment.setenv("OTEL_SDK_DISABLED", "1")


def pytest_unconfigure() -> None:
    """Restore the caller environment when pytest.main is used in-process."""

    _test_environment.undo()
    _test_roots.cleanup()


_session_spec = util.spec_from_file_location(
    "sqlalchemy.ext.asyncio.session",
    Path(sqlalchemy.__file__).resolve().parent / "ext" / "asyncio" / "session.py",
)
if _session_spec is None or _session_spec.loader is None:  # pragma: no cover
    raise ImportError("Unable to load sqlalchemy.ext.asyncio.session module")
session_mod = util.module_from_spec(_session_spec)
_session_spec.loader.exec_module(session_mod)

if not hasattr(session_mod, "async_sessionmaker"):
    from sqlalchemy.orm import sessionmaker

    def async_sessionmaker(*args: Any, **kwargs: Any):
        kwargs.setdefault("class_", session_mod.AsyncSession)
        return sessionmaker(*args, **kwargs)

    session_mod.async_sessionmaker = async_sessionmaker  # type: ignore[attr-defined]

sys.modules["sqlalchemy.ext.asyncio.session"] = session_mod

AsyncSession = session_mod.AsyncSession
async_sessionmaker = session_mod.async_sessionmaker

# Ensure local backend package and agents SDK are importable
REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
BACKEND_SRC_DIR = SRC_DIR / "backend"
AGENTS_SRC = SRC_DIR / "agents" / "src"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(BACKEND_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_SRC_DIR))
if AGENTS_SRC.exists() and str(AGENTS_SRC) not in sys.path:
    sys.path.insert(0, str(AGENTS_SRC))


class RequestPrincipalOverride:
    """Mutable dependency override for API tests that need explicit owners."""

    def __init__(self, principal_id: str = "test-installation-owner") -> None:
        self.id = principal_id

    def set(self, principal_id: str) -> None:
        self.id = principal_id

    async def dependency(self):
        from animama.domain.request_principal import RequestPrincipal

        return RequestPrincipal(id=self.id)


@pytest.fixture(autouse=True)
def request_principal_override() -> Iterator[RequestPrincipalOverride]:
    """Supply explicit unit-test bootstrap and the route's principal override.

    Separately created factory/boundary test applications remain unready. The
    shared route-test application admits ordinary validated browser metadata;
    no transport credential or caller-supplied owner bypass is introduced.
    """

    from animama.server.app import app
    from animama.server.deps import get_current_principal
    from animama.server.local_installation_bootstrap import LocalBootstrapState

    override = RequestPrincipalOverride()
    lifecycle = app.state.local_http_lifecycle
    if not lifecycle.ready:
        lifecycle.mark_ready(override.id)
    previous_state = getattr(app.state, "local_bootstrap_state", None)
    app.state.local_bootstrap_state = LocalBootstrapState(principal_id=override.id, failed_steps=())
    previous = app.dependency_overrides.get(get_current_principal)
    app.dependency_overrides[get_current_principal] = override.dependency
    try:
        yield override
    finally:
        app.state.local_bootstrap_state = previous_state
        if previous is None:
            app.dependency_overrides.pop(get_current_principal, None)
        else:
            app.dependency_overrides[get_current_principal] = previous


try:
    # testcontainers is optional for devs who don't run tests
    from testcontainers.postgres import PostgresContainer
except Exception as e:  # pragma: no cover - import error surfaced when running tests
    raise RuntimeError("testcontainers is required to run the test suite. Install extras from requirements.txt") from e


@pytest.fixture(autouse=True)
def _restore_runtime_credentials() -> Iterator[None]:
    """Give each test the process credentials, in the store and the environment, it started with.

    Building the desktop composition scrubs credential names from ``os.environ``.
    """

    from animama.app.model_clients.credential_store import is_process_credential_env
    from animama.server.runtime_credentials import runtime_credentials

    previous = runtime_credentials.snapshot()
    environment = {name: value for name, value in os.environ.items() if is_process_credential_env(name)}
    yield
    runtime_credentials.reset({name: previous.get(name) or "" for name in previous.names()})
    for name in [name for name in os.environ if is_process_credential_env(name)]:
        del os.environ[name]
    os.environ.update(environment)


@pytest.fixture
def set_runtime_credentials() -> Any:
    """Replace the process credentials for one test, e.g. ``set_runtime_credentials(ELEVENLABS_API_KEY="k")``."""

    from animama.server.runtime_credentials import runtime_credentials

    def install(**values: str) -> None:
        runtime_credentials.reset(values)

    return install


# Under pytest-xdist the controller owns one container and each worker gets its own
# database in it; see pytest_xdist_setupnodes. Serial runs start their own container.
_SHARED_POSTGRES = pytest.StashKey["PostgresContainer | str"]()
_WORKER_DATABASE_URL = "animama_postgres_url"
_WORKER_DATABASE_ERROR = "animama_postgres_error"


def _start_postgres() -> PostgresContainer:
    """Start Postgres from the pgvector image so VECTOR columns work."""
    container = PostgresContainer(image="pgvector/pgvector:pg16")
    container.start()
    return container


def _database_url(container: PostgresContainer, database: str | None = None) -> str:
    """Async SQLAlchemy URL for ``database`` (default: the container's own) in ``container``."""
    from sqlalchemy.engine import make_url

    url = make_url(container.get_connection_url(driver="asyncpg"))
    return url.set(database=database or url.database).render_as_string(hide_password=False)


@pytest.hookimpl(optionalhook=True)
def pytest_xdist_setupnodes(config: pytest.Config) -> None:
    """Start the one container that every xdist worker shares.

    Workers shut down independently as their queues empty, so only the
    controller outlives them all. Testcontainers' reaper removes the container if
    the controller is killed. A start failure errors every worker test that
    needs the database, so tests without one still run.
    """
    try:
        container = _start_postgres()
    except Exception as exc:  # Deferred to the workers' db_url fixture.
        config.stash[_SHARED_POSTGRES] = f"Test PostgreSQL did not start: {type(exc).__name__}: {exc}"
        return
    config.add_cleanup(container.stop)
    config.stash[_SHARED_POSTGRES] = container


@pytest.hookimpl(optionalhook=True)
def pytest_configure_node(node: Any) -> None:
    """Give each worker a fresh database of its own in the shared container."""
    import psycopg

    shared = node.config.stash.get(_SHARED_POSTGRES, "Test PostgreSQL was not started for xdist workers")
    if isinstance(shared, str):
        node.workerinput[_WORKER_DATABASE_ERROR] = shared
        return
    # Worker IDs are unique within a run; a restarted worker gets a new one.
    database = f"test_{node.workerinput['workerid']}"
    with psycopg.connect(shared.get_connection_url(driver=None), autocommit=True) as connection:
        connection.execute(f'CREATE DATABASE "{database}"')
    node.workerinput[_WORKER_DATABASE_URL] = _database_url(shared, database)


@pytest.fixture(scope="session")
def db_url(request: pytest.FixtureRequest) -> Iterator[str]:
    """Async SQLAlchemy URL of this process's empty test database."""
    workerinput = getattr(request.config, "workerinput", None)
    if workerinput is None:
        container = _start_postgres()
        try:
            yield _database_url(container)
        finally:
            container.stop()
        return
    if _WORKER_DATABASE_ERROR in workerinput:
        raise RuntimeError(workerinput[_WORKER_DATABASE_ERROR])
    yield workerinput[_WORKER_DATABASE_URL]


@pytest_asyncio.fixture(scope="session")
async def db_ready(db_url: str) -> AsyncIterator[str]:
    """Create all Anima ORM tables in the test database, set env for default engine.

    Uses the ORM Base metadata to create every registered table—no manual list.
    Yields the database URL for convenience.
    """
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    import animama.hooks as hookmod
    import animama.local.database as engmod
    import animama.local.installation_model  # noqa: F401 (local schema registration)
    import animama.orm as _orm  # noqa: F401 (shared schema registration)

    created_engines: list[Any] = []
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("ANIMAMA_DATABASE_URL", db_url)
        test_engine = create_async_engine(db_url, poolclass=NullPool, pool_pre_ping=True)
        try:
            async with test_engine.begin() as conn:
                await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")

                def _create_all(sync_conn):
                    from animama.orm.base import Base as _Base

                    _Base.metadata.create_all(bind=sync_conn)

                await conn.run_sync(_create_all)
                # Every catalog row belongs to a connection; the release seed
                # normally creates the built-in OpenAI, Anthropic and ChatGPT plan connections.
                await conn.exec_driver_sql(
                    "INSERT INTO model_connections (id, source, name, preset, compatibility, active) "
                    "VALUES ('openai', 'builtin', 'OpenAI', 'openai', '{}'::jsonb, TRUE), "
                    "('anthropic', 'builtin', 'Anthropic', 'anthropic', '{}'::jsonb, TRUE), "
                    "('chatgpt_plan', 'builtin', 'ChatGPT plan', 'chatgpt_plan', '{}'::jsonb, TRUE)"
                )

            def _get_engine_patched(url: str | None = None):
                engine = create_async_engine(url or db_url, poolclass=NullPool, pool_pre_ping=True)
                created_engines.append(engine)
                return engine

            patch.setattr(engmod, "get_engine", _get_engine_patched)
            patch.setattr(hookmod, "get_engine", _get_engine_patched)
            yield db_url
        finally:
            for engine in created_engines:
                await engine.dispose()
            await test_engine.dispose()


@pytest_asyncio.fixture
async def async_session(db_ready: str):
    """AsyncSession with per-test engine to avoid asyncpg concurrency issues.

    Using a dedicated engine per test prevents "another operation is in progress"
    errors when running many async tests sequentially against a shared connection.
    """
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(db_ready, poolclass=NullPool, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as sess:
        try:
            # Mutation receipts intentionally outlive item deletion in production.
            # Each test uses a different temporary library, even when owner and
            # operation IDs are reused, so receipts must not cross test cases.
            from sqlalchemy import delete

            from animama.orm.content_mutation import ORMContentMutationReceipt

            await sess.execute(delete(ORMContentMutationReceipt))
            await sess.commit()
            yield sess
        finally:
            await engine.dispose()


@pytest_asyncio.fixture
async def async_session_factory(db_ready: str):
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(db_ready, poolclass=NullPool, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def isolated_session(db_ready: str):
    """Provides a fully isolated AsyncSession backed by its own engine connection.

    Use this when a test must not share connections with others.
    """
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(db_ready, poolclass=NullPool, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as sess:
        try:
            yield sess
        finally:
            await engine.dispose()
