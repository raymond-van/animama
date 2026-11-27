# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web-builder
ARG TARGETARCH
WORKDIR /app
RUN corepack enable
# Install from lock/config inputs before source changes invalidate build layers.
COPY src/frontend/package.json src/frontend/pnpm-lock.yaml src/frontend/pnpm-workspace.yaml ./
COPY src/frontend/patches ./patches
COPY src/frontend/web/package.json ./web/package.json
COPY src/frontend/packages/runtime-contracts/package.json ./packages/runtime-contracts/package.json
COPY src/frontend/packages/product-ui/package.json ./packages/product-ui/package.json
COPY src/frontend/packages/discover-client/package.json ./packages/discover-client/package.json
RUN --mount=type=cache,id=animama-pnpm-linux-${TARGETARCH}-node22-pnpm10.33.0,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter animama-frontend-workspace --filter animama-web... --prod=false
COPY src/frontend ./
COPY models /models
COPY LICENSE /LICENSE
# Package builds write the upstream notices for third-party code they contain.
COPY licenses/third-party /licenses/third-party
COPY content/included /content/included
COPY docs/safety /docs/safety
ENV NODE_ENV=production \
    VITE_DISABLE_WEBUI_TELEMETRY=true \
    ANIMAMA_BROWSER_MODEL_DIR=/opt/animama/browser-models
# Explicit verified input, never a download during build. Only dist enters runtime.
# Bundle without `tsc -b`: type checking belongs to the source checks, not every
# image build. Package builds still emit their declarations.
RUN --mount=from=browser_models,target=/opt/animama/browser-models \
    pnpm packages:build && pnpm --filter animama-web bundle:source

FROM python:3.12-slim AS base
ARG TARGETARCH
WORKDIR /app
# ALEMBIC_CONFIG lets `alembic` commands run in the container find the backend's
# migration config without `-c`.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    PATH="/opt/venv/bin:/root/.local/bin:$PATH" \
    PYTHONPATH=/app/src \
    ALEMBIC_CONFIG=/app/src/backend/alembic.ini
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends curl build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.11.28
COPY pyproject.toml uv.lock LICENSE ./
RUN touch README.md

FROM base AS source
COPY src/backend/alembic.ini ./src/backend/alembic.ini
COPY src/backend/migrations ./src/backend/migrations
COPY content/included ./content/included
COPY src/backend/animama ./src/backend/animama
COPY src/backend/packaging/hatch_build.py src/backend/packaging/shared_catalogs.py ./src/backend/packaging/
COPY scripts/voices/selection.json ./scripts/voices/selection.json
COPY src/frontend/web/src/assets/vrm/animations/manifest.json \
    ./src/frontend/web/src/assets/vrm/animations/manifest.json
COPY src/frontend/web/src/lib/avatar/motion-authoring/authoring-joints.generated.md \
    ./src/frontend/web/src/lib/avatar/motion-authoring/authoring-joints.generated.md

FROM base AS animama-server-development
RUN --mount=type=cache,id=animama-uv-linux-${TARGETARCH}-py312-uv0.11.28,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-dev --extra documents --no-install-project
COPY --from=source /app /app
RUN --mount=type=cache,id=animama-uv-linux-${TARGETARCH}-py312-uv0.11.28,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-dev --extra documents
EXPOSE 8000
CMD ["python", "-m", "animama.server.compose_entrypoint"]

FROM animama-server-development AS animama-server
COPY --from=web-builder /app/web/dist /opt/animama/web
ENV ANIMAMA_WEB_ROOT=/opt/animama/web
