"""Ingestion Runs: explicit processing of a selection of Documents."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, status

from api.deps import Caller, IngestionRuns
from api.routers import (
    IngestionRun,
    IngestionRunCreate,
    IngestionRunItemPage,
    IngestionRunItemStatus,
    IngestionRunPage,
    IngestionRunStatus,
)

router = APIRouter(prefix="/ingestion-runs", tags=["ingestion-runs"])


@router.post("", response_model=IngestionRun, status_code=status.HTTP_202_ACCEPTED)
async def create_ingestion_run(
    body: IngestionRunCreate, caller: Caller, runs: IngestionRuns
) -> IngestionRun:
    return IngestionRun.model_validate(
        await runs.create_run(
            caller,
            trigger=body.trigger,
            document_ids=body.document_ids,
            collection_id=body.collection_id,
            source_id=body.source_id,
            states=body.states,
        )
    )


@router.get("", response_model=IngestionRunPage)
async def list_ingestion_runs(
    caller: Caller,
    runs: IngestionRuns,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    status: IngestionRunStatus | None = None,
    source_id: UUID | None = None,
    collection_id: UUID | None = None,
) -> IngestionRunPage:
    return IngestionRunPage.model_validate(
        await runs.list_runs(
            caller,
            page=page,
            page_size=page_size,
            status=status,
            source_id=source_id,
            collection_id=collection_id,
        )
    )


@router.get("/{ingestion_run_id}", response_model=IngestionRun)
async def get_ingestion_run(
    ingestion_run_id: UUID, caller: Caller, runs: IngestionRuns
) -> IngestionRun:
    return IngestionRun.model_validate(await runs.get_run(caller, ingestion_run_id))


@router.get("/{ingestion_run_id}/items", response_model=IngestionRunItemPage)
async def list_ingestion_run_items(
    ingestion_run_id: UUID,
    caller: Caller,
    runs: IngestionRuns,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
    status: IngestionRunItemStatus | None = None,
) -> IngestionRunItemPage:
    return IngestionRunItemPage.model_validate(
        await runs.list_run_items(
            caller, ingestion_run_id, page=page, page_size=page_size, status=status
        )
    )


@router.post(
    "/{ingestion_run_id}/cancel",
    response_model=IngestionRun,
    status_code=status.HTTP_202_ACCEPTED,
)
async def cancel_ingestion_run(
    ingestion_run_id: UUID, caller: Caller, runs: IngestionRuns
) -> IngestionRun:
    return IngestionRun.model_validate(await runs.cancel_run(caller, ingestion_run_id))


@router.post(
    "/{ingestion_run_id}/retry",
    response_model=IngestionRun,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_ingestion_run(
    ingestion_run_id: UUID, caller: Caller, runs: IngestionRuns
) -> IngestionRun:
    return IngestionRun.model_validate(await runs.retry_run(caller, ingestion_run_id))


__all__ = ["router"]
