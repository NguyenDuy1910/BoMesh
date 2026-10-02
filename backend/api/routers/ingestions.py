"""Workspace Ingestion resources: document uploads and source syncs."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query, status

from api.deps import Caller, Ingestions
from api.routers import Ingestion, IngestionEventList, IngestionPage, IngestionSummary

router = APIRouter(prefix="/ingestions", tags=["ingestions"])


@router.get("", response_model=IngestionPage)
async def list_ingestions(
    caller: Caller,
    ingestions: Ingestions,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    kind: Literal["document", "source"] | None = None,
    status: Literal["pending", "running", "completed", "failed", "cancelled", "timed_out"]
    | None = None,
    collection_id: UUID | None = None,
    document_id: UUID | None = None,
    source_id: UUID | None = None,
    connection_id: UUID | None = None,
) -> IngestionPage:
    return IngestionPage.model_validate(
        await ingestions.list_ingestions(
            caller,
            page=page,
            page_size=page_size,
            kind=kind,
            status=status,
            collection_id=collection_id,
            document_id=document_id,
            source_id=source_id,
            connection_id=connection_id,
        )
    )


# Declared before ``/{ingestion_id}`` so "summary" is never read as an id.
@router.get("/summary", response_model=IngestionSummary)
async def get_ingestion_summary(
    caller: Caller,
    ingestions: Ingestions,
    window: Literal["1h", "24h", "7d"] = "24h",
) -> IngestionSummary:
    return IngestionSummary.model_validate(await ingestions.summarize(caller, window=window))


@router.get("/{ingestion_id}", response_model=Ingestion)
async def get_ingestion(ingestion_id: UUID, caller: Caller, ingestions: Ingestions) -> Ingestion:
    return Ingestion.model_validate(await ingestions.get_ingestion(caller, ingestion_id))


@router.get("/{ingestion_id}/events", response_model=IngestionEventList)
async def list_ingestion_events(
    ingestion_id: UUID, caller: Caller, ingestions: Ingestions
) -> IngestionEventList:
    return IngestionEventList.model_validate(
        await ingestions.list_events(caller, ingestion_id)
    )


@router.post(
    "/{ingestion_id}/retry", response_model=Ingestion, status_code=status.HTTP_202_ACCEPTED
)
async def retry_ingestion(ingestion_id: UUID, caller: Caller, ingestions: Ingestions) -> Ingestion:
    return Ingestion.model_validate(await ingestions.retry_ingestion(caller, ingestion_id))


@router.post("/{ingestion_id}/cancel", response_model=Ingestion)
async def cancel_ingestion(ingestion_id: UUID, caller: Caller, ingestions: Ingestions) -> Ingestion:
    return Ingestion.model_validate(await ingestions.cancel_ingestion(caller, ingestion_id))


__all__ = ["router"]
