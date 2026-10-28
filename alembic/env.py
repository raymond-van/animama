from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from urllib.parse import quote_plus, urlencode, urlsplit, urlunsplit

from sqlalchemy import engine_from_config, pool

from alembic import context

# Ensure the backend package root is on sys.path so `animama` is importable.
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
BACKEND_SRC_DIR = os.path.join(ROOT_DIR, "src", "backend")
if BACKEND_SRC_DIR not in sys.path:
    sys.path.insert(0, BACKEND_SRC_DIR)

# Import target metadata and models (package import loads models into Base.metadata)
from animama.local import installation_model  # noqa: F401
from animama.orm import Base  # type: ignore  # ruff: noqa: E402

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging. Alembic also runs inside backend
# processes (database bootstrap, tests), so leave their existing loggers enabled.
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)


def _coerce_sync_url(url: str) -> str:
    """Coerce asyncpg URL -> sync driver URL for Alembic (prefer psycopg v3)."""
    if url.startswith("postgresql+asyncpg"):
        # Prefer psycopg (v3) driver which is listed in requirements (psycopg[binary])
        return url.replace("+asyncpg", "+psycopg")
    if url.startswith("postgresql://") and "+" not in url.split("://", 1)[0]:
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _with_sslmode(url: str) -> str:
    sslmode = os.getenv("PGSSLMODE")
    if not sslmode and os.getenv("PGSSL") == "true":
        sslmode = "require"
    if not sslmode:
        return url

    parts = urlsplit(url)
    qs = dict([kv for kv in (p.split("=", 1) for p in parts.query.split("&") if p) if len(kv) == 2])
    qs.setdefault("sslmode", sslmode)
    new_query = urlencode(qs)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def get_url() -> str:
    url = os.getenv("ANIMAMA_DATABASE_URL")
    if not url:
        host = os.getenv("PGHOST")
        user = os.getenv("PGUSER")
        password = os.getenv("PGPASSWORD")
        database = os.getenv("PGDATABASE")
        port = os.getenv("PGPORT") or "5432"
        if host and user and database:
            auth = quote_plus(user)
            if password is not None and password != "":
                auth = f"{quote_plus(user)}:{quote_plus(password)}"
            url = f"postgresql+psycopg://{auth}@{host}:{port}/{quote_plus(database)}"
        else:
            user = os.getenv("POSTGRES_USER", "animama")
            password = os.getenv("POSTGRES_PASSWORD", "a")
            database = os.getenv("POSTGRES_DB", "animama")
            port = os.getenv("POSTGRES_PORT", "5432")
            auth = quote_plus(user)
            if password:
                auth = f"{quote_plus(user)}:{quote_plus(password)}"
            url = f"postgresql+psycopg://{auth}@localhost:{port}/{quote_plus(database)}"
    return _with_sslmode(_coerce_sync_url(url))


target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = get_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        future=True,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
