"""The BoMesh HTTP application: ``/api/v1``, ``/upload/api/v1`` and ``/health``."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from api.aip.errors import register_error_handlers
from api.v1 import (
    artifacts,
    collaboration,
    conversations,
    identity,
    ingestion,
    knowledge_curation,
    knowledge_items,
    library,
    operations,
    workspaces,
)
from bomesh.health import HealthRecorder
from bomesh.runtime import AppRuntime
from bomesh.services.operations.operations import reconcile_abandoned_operations

API_PREFIX = "/api/v1"
UPLOAD_PREFIX = "/upload/api/v1"

#: One router per interface slice, mounted under ``API_PREFIX``.
ROUTERS: tuple[APIRouter, ...] = (
    identity.router,
    workspaces.router,
    library.router,
    knowledge_items.router,
    knowledge_curation.router,
    ingestion.router,
    conversations.router,
    artifacts.router,
    collaboration.router,
    operations.router,
)
#: Media-upload routers, mounted under ``UPLOAD_PREFIX``.
UPLOAD_ROUTERS: tuple[APIRouter, ...] = (knowledge_items.upload_router,)

log = logging.getLogger(__name__)


def create_app(runtime: AppRuntime | None = None) -> FastAPI:
    """Build the application around ``runtime`` (a new :class:`AppRuntime` by default)."""

    runtime = runtime or AppRuntime()
    app = FastAPI(
        title="BoMesh API",
        version="1.0.0",
        description="Enterprise knowledge and BI assistant.",
        lifespan=_lifespan,
        generate_unique_id_function=_operation_id,
    )
    app.state.runtime = runtime
    register_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # tighten per environment
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in ROUTERS:
        app.include_router(router, prefix=API_PREFIX)
    for router in UPLOAD_ROUTERS:
        app.include_router(router, prefix=UPLOAD_PREFIX)
    # The OAuth provider redirect target is a protocol endpoint, not an API method.
    app.include_router(ingestion.oauth_router)

    @app.get("/health", tags=["Health"], name="GetHealth")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def _operation_id(route: APIRoute) -> str:
    """The contract ``operationId`` is the route ``name``."""
    return route.name


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Repair state lost workflows left behind, start the sandbox and the health
    recorder, close clients at shutdown."""

    runtime: AppRuntime = app.state.runtime
    started = datetime.now(UTC)
    reconciling = asyncio.create_task(_reconcile_ingestion(runtime))
    # Single replica: every operation unfinished from before this process lost its worker.
    abandoning = asyncio.create_task(_reconcile_operations(runtime, started))
    # The sandbox never delays startup: until Docker answers, chat runs without it.
    sandbox = asyncio.create_task(_start_sandbox(runtime))
    # Components and incidents are derived from the probe history it records.
    recording = asyncio.create_task(
        HealthRecorder(runtime.health_service(), runtime.sessions()).run()
    )
    try:
        yield
    finally:
        for task in (reconciling, abandoning, sandbox, recording):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await runtime.aclose()


async def _reconcile_ingestion(runtime: AppRuntime) -> None:
    # Startup must not wait for, or fail on, the database or Temporal.
    try:
        await runtime.ingestion_run_service().reconcile()
    except Exception:  # noqa: BLE001 - best effort; a run's next read repairs it too
        log.warning("ingestion runs could not be reconciled", exc_info=True)


async def _reconcile_operations(runtime: AppRuntime, started: datetime) -> None:
    try:
        await reconcile_abandoned_operations(runtime, started_before=started)
    except Exception:  # noqa: BLE001 - best effort; the next start retries
        log.warning("abandoned operations could not be reconciled", exc_info=True)


async def _start_sandbox(runtime: AppRuntime) -> None:
    try:
        await runtime.start()
    except Exception:  # noqa: BLE001 - chat works without the sandbox
        log.warning("the sandbox could not be started", exc_info=True)


__all__ = ["API_PREFIX", "ROUTERS", "UPLOAD_PREFIX", "UPLOAD_ROUTERS", "create_app"]
