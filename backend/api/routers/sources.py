"""Ingestion source resources, their syncs, and schedules."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Response, status

from api.deps import Caller, ConnectionLifecycle
from api.routers import (
    Schedule,
    SchedulePatch,
    SchedulePut,
    Source,
    SourcePage,
    SourceUpdate,
)
from api.routers._mapping import source_payload

router = APIRouter(prefix="/sources", tags=["sources"])


@router.get("", response_model=SourcePage)
async def list_sources(
    caller: Caller,
    connections: ConnectionLifecycle,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    connection_id: UUID | None = None,
) -> SourcePage:
    value = await connections.list_sources(
        caller,
        page=page,
        page_size=page_size,
        integration_connection_id=connection_id,
    )
    return SourcePage(
        items=[source_payload(item) for item in value.get("items", [])],
        page=value.get("page", page),
        page_size=value.get("page_size", page_size),
        total=value.get("total", 0),
    )


@router.get("/{source_id}", response_model=Source)
async def get_source(
    source_id: UUID, caller: Caller, connections: ConnectionLifecycle
) -> Source:
    return Source.model_validate(
        source_payload(await connections.get_source(caller, source_id))
    )


@router.patch("/{source_id}", response_model=Source)
async def update_source(
    source_id: UUID,
    body: SourceUpdate,
    caller: Caller,
    connections: ConnectionLifecycle,
) -> Source:
    return Source.model_validate(
        source_payload(
            await connections.update_source(
                caller, source_id, body.model_dump(exclude_unset=True)
            )
        )
    )


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(
    source_id: UUID, caller: Caller, connections: ConnectionLifecycle
) -> Response:
    await connections.delete_source(caller, source_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{source_id}/syncs",
    response_model=Source,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_source_sync(
    source_id: UUID, caller: Caller, connections: ConnectionLifecycle
) -> Source:
    """Sync the Source's inventory now; processing is a separate Ingestion Run."""

    return Source.model_validate(
        source_payload(await connections.sync_source(caller, source_id))
    )


@router.get("/{source_id}/schedule", response_model=Schedule)
async def get_source_schedule(
    source_id: UUID, caller: Caller, connections: ConnectionLifecycle
) -> Schedule:
    return Schedule.model_validate(
        await connections.get_source_schedule(caller, source_id)
    )


@router.put("/{source_id}/schedule", response_model=Schedule)
async def put_source_schedule(
    source_id: UUID,
    body: SchedulePut,
    caller: Caller,
    connections: ConnectionLifecycle,
) -> Schedule:
    return Schedule.model_validate(
        await connections.set_source_schedule(
            caller, source_id, body.model_dump()
        )
    )


@router.patch("/{source_id}/schedule", response_model=Schedule)
async def patch_source_schedule(
    source_id: UUID,
    body: SchedulePatch,
    caller: Caller,
    connections: ConnectionLifecycle,
) -> Schedule:
    current = await connections.get_source_schedule(caller, source_id)
    current.update(body.model_dump(exclude_unset=True))
    return Schedule.model_validate(
        await connections.set_source_schedule(caller, source_id, current)
    )


@router.delete(
    "/{source_id}/schedule", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_source_schedule(
    source_id: UUID, caller: Caller, connections: ConnectionLifecycle
) -> Response:
    await connections.delete_source_schedule(caller, source_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
