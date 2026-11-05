"""Operations interface — Operations slice: Long-running operations (Get/List/Cancel), platform components, incidents and platform audit events.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.dto.operations import (
    OPERATION_FILTERS,
    OPERATION_ORDER,
    CancelOperationRequest,
    ComponentMessage,
    IncidentMessage,
    ListComponentsResponse,
    ListIncidentsResponse,
    ListOperationsResponse,
    OperationMessage,
    component_filters,
    component_message,
    component_order,
    incident_filters,
    incident_message,
    incident_order,
    operation_message,
)
from api.dto.operations_audit import (
    PLATFORM_AUDIT_FILTERS,
    PLATFORM_AUDIT_ORDER,
    ExportPlatformAuditEventsRequest,
    ListPlatformAuditEventsResponse,
)
from api.dto.workspaces import AuditEventMessage, audit_event_message
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.services.operations.audit import PlatformAuditService
from bomesh.services.operations.health import PlatformHealthService
from bomesh.services.operations.operations import OperationService

router = APIRouter(tags=["Operations"])

Operations = Annotated[OperationService, Depends(service(OperationService.from_runtime))]
Health = Annotated[PlatformHealthService, Depends(service(PlatformHealthService.from_runtime))]
Audit = Annotated[PlatformAuditService, Depends(service(PlatformAuditService.from_runtime))]
Listing = Annotated[ListParams, Depends()]


@router.get("/operations", name="ListOperations")
async def list_operations(
    params: Listing, ctx: Context, operations: Operations
) -> ListOperationsResponse:
    query, paging = list_query(
        params, parent="operations", filters=OPERATION_FILTERS, order=OPERATION_ORDER
    )
    page = paging.page(await operations.list(ctx, query))
    return ListOperationsResponse(
        operations=[operation_message(view) for view in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/operations/{operation:id}", name="GetOperation")
async def get_operation(
    operation: UUID, ctx: Context, operations: Operations
) -> OperationMessage:
    return operation_message(await operations.get(ctx, operation))


@router.post("/operations/{operation:id}:cancel", name="CancelOperation")
async def cancel_operation(
    operation: UUID, body: CancelOperationRequest, ctx: Context, operations: Operations
) -> dict[str, object]:
    await operations.cancel(ctx, operation)
    return {}


@router.get("/components", name="ListComponents")
async def list_components(params: Listing, ctx: Context, health: Health) -> ListComponentsResponse:
    table = health.components_table()
    query, paging = list_query(
        params, parent="components", filters=component_filters(table), order=component_order(table)
    )
    page = paging.page(await health.list_components(ctx, query, table))
    return ListComponentsResponse(
        components=[component_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/components/{component:id}", name="GetComponent")
async def get_component(component: str, ctx: Context, health: Health) -> ComponentMessage:
    return component_message(await health.get_component(ctx, component))


@router.get("/incidents", name="ListIncidents")
async def list_incidents(params: Listing, ctx: Context, health: Health) -> ListIncidentsResponse:
    table = health.incidents_table()
    query, paging = list_query(
        params, parent="incidents", filters=incident_filters(table), order=incident_order(table)
    )
    page = paging.page(await health.list_incidents(ctx, query, table))
    return ListIncidentsResponse(
        incidents=[incident_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/incidents/{incident:id}", name="GetIncident")
async def get_incident(incident: UUID, ctx: Context, health: Health) -> IncidentMessage:
    return incident_message(await health.get_incident(ctx, incident))


@router.get("/auditEvents", name="ListPlatformAuditEvents")
async def list_platform_audit_events(
    params: Listing, ctx: Context, audit: Audit
) -> ListPlatformAuditEventsResponse:
    query, paging = list_query(
        params, parent="auditEvents", filters=PLATFORM_AUDIT_FILTERS, order=PLATFORM_AUDIT_ORDER
    )
    page = paging.page(await audit.list(ctx, query))
    return ListPlatformAuditEventsResponse(
        audit_events=[
            audit_event_message(event, name=f"auditEvents/{event.id}", metadata_only=False)
            for event in page.items
        ],
        next_page_token=page.next_page_token or None,
    )


@router.post("/auditEvents:export", name="ExportPlatformAuditEvents")
async def export_platform_audit_events(
    body: ExportPlatformAuditEventsRequest,
    ctx: Context,
    audit: Audit,
    operations: Operations,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
) -> OperationMessage:
    where = PLATFORM_AUDIT_FILTERS.compile(body.filter)
    operation = await audit.export(
        ctx, where=where, filter=body.filter or "", request_id=request_id
    )
    return operation_message(await operations.describe(operation))


@router.get("/auditEvents/{auditEvent:id}", name="GetPlatformAuditEvent")
async def get_platform_audit_event(
    auditEvent: UUID,  # noqa: N803 - the contract's path variable
    ctx: Context,
    audit: Audit,
) -> AuditEventMessage:
    event = await audit.get(ctx, auditEvent)
    return audit_event_message(event, name=f"auditEvents/{event.id}", metadata_only=False)
