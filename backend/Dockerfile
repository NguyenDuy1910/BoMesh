# syntax=docker/dockerfile:1
#
# BoMesh API + ingestion worker image (build context: backend/).
#   API (default):  uvicorn api.app:create_app --factory on 0.0.0.0:8000
#   Worker:         python -m bomesh.services.ingestion.worker
# All configuration comes from environment variables.

ARG PYTHON_IMAGE=python:3.12.16-slim-bookworm

FROM ghcr.io/astral-sh/uv:0.12.5 AS uv

FROM ${PYTHON_IMAGE} AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app/backend
# Linux resolves torch/torchvision from the CPU-only index (pyproject tool.uv.sources).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    uv sync --frozen --no-dev --no-install-project

FROM ${PYTHON_IMAGE}
# libgl1 + libglib2.0-0: opencv-python (docling/rapidocr); curl: container healthchecks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /home/app/.cache/huggingface \
    && chown -R app:app /home/app/.cache
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/home/app/.cache/huggingface
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app/backend
COPY config ./config
COPY api ./api
COPY bomesh ./bomesh
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
