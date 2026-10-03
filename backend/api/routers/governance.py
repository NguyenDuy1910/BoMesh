"""Approval requests, audit-log, and access-session resources."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query, status

from api.deps import Caller, WorkspaceControlPlane
from api.routers import (
    AccessSessionPage,
    AccessSessionRecord,
    ApprovalRequest,
    ApprovalRequestCreate,
    ApprovalRequestPage,
    ApprovalRequestUpdate,
    AuditLog,
    AuditLogPage,
)
from api.routers._mapping import approval_request_payload

router = APIRouter(tags=["governance"])


@router.get("/approval-requests", response_model=ApprovalRequestPage)
async def list_approval_requests(
    caller: Caller,
    control_plane: WorkspaceControlPlane,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ApprovalRequestPage:
    value = await control_plane.list_approval_requests(
        caller, page=page, page_size=page_size
    )
    return ApprovalRequestPage(
        items=[
            ApprovalRequest.model_validate(approval_request_payload(item))
            for item in value.get("items", [])
        ],
        page=value.get("page", page),
        page_size=value.get("page_size", page_size),
        total=value.get("total", 0),
    )


@router.post(
    "/approval-requests",
    response_model=ApprovalRequest,
    status_code=status.HTTP_201_CREATED,
)
async def create_approval_request(
    body: ApprovalRequestCreate,
    caller: Caller,
    control_plane: WorkspaceControlPlane,
) -> ApprovalRequest:
    return ApprovalRequest.model_validate(
        approval_request_payload(
            await control_plane.create_approval_request(caller, body.model_dump())
        )
    )


@router.get(
    "/approval-requests/{approval_request_id}", response_model=ApprovalRequest
)
async def get_approval_request(
    approval_request_id: UUID,
    caller: Caller,
    control_plane: WorkspaceControlPlane,
) -> ApprovalRequest:
    return ApprovalRequest.model_validate(
        approval_request_payload(
            await control_plane.get_approval_request(caller, approval_request_id)
        )
    )


@router.patch(
    "/approval-requests/{approval_request_id}",
    response_model=ApprovalRequest,
)
async def update_approval_request(
    approval_request_id: UUID,
    body: ApprovalRequestUpdate,
    caller: Caller,
    control_plane: WorkspaceControlPlane,
) -> ApprovalRequest:
    return ApprovalRequest.model_validate(
        approval_request_payload(
            await control_plane.update_approval_request(
                caller, approval_request_id, body.model_dump()
            )
        )
    )


@router.get("/audit-logs", response_model=AuditLogPage)
async def list_audit_logs(
    caller: Caller,
    control_plane: WorkspaceControlPlane,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    search: str | None = None,
) -> AuditLogPage:
    value = await control_plane.list_audit_logs(
        caller, page=page, page_size=page_size, search=search
    )
    return AuditLogPage(
        items=[AuditLog.model_validate(item) for item in value.get("items", [])],
        page=value.get("page", page),
        page_size=value.get("page_size", page_size),
        total=value.get("total", 0),
    )


@router.get("/access-sessions", response_model=AccessSessionPage)
async def list_access_sessions(
    caller: Caller,
    control_plane: WorkspaceControlPlane,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    status: Literal["active", "ended"] | None = None,
    user_id: UUID | None = None,
    search: str | None = None,
) -> AccessSessionPage:
    value = await control_plane.list_access_sessions(
        caller,
        page=page,
        page_size=page_size,
        status=status,
        user_id=user_id,
        search=search,
    )
    return AccessSessionPage(
        items=[
            AccessSessionRecord.model_validate(item) for item in value.get("items", [])
        ],
        page=value.get("page", page),
        page_size=value.get("page_size", page_size),
        total=value.get("total", 0),
    )


__all__ = ["router"]
