"""Workspace resources and workspace overview projection."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter
from uuid import UUID

from api.deps import Caller, WorkspaceControlPlane
from api.routers import (
    Workspace,
    WorkspaceActivity,
    WorkspaceOverview,
    WorkspacePage,
    WorkspaceUpdate,
)
from api.routers._mapping import workspace_payload

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.get("", response_model=WorkspacePage)
async def list_workspaces(
    caller: Caller, control_plane: WorkspaceControlPlane
) -> WorkspacePage:
    value = await control_plane.list_workspaces(caller)
    items = [workspace_payload(item) for item in value.get("items", [])]
    return WorkspacePage(
        items=items,
        page=value.get("page", 1),
        page_size=value.get("page_size", max(1, len(items))),
        total=value.get("total", len(items)),
    )


@router.get("/{workspace_id}", response_model=Workspace)
async def get_workspace(
    workspace_id: UUID, caller: Caller, control_plane: WorkspaceControlPlane
) -> Workspace:
    return Workspace.model_validate(
        workspace_payload(await control_plane.get_workspace(caller, workspace_id))
    )


@router.patch("/{workspace_id}", response_model=Workspace)
async def update_workspace(
    workspace_id: UUID,
    body: WorkspaceUpdate,
    caller: Caller,
    control_plane: WorkspaceControlPlane,
) -> Workspace:
    return Workspace.model_validate(
        workspace_payload(
            await control_plane.update_workspace(
                caller, workspace_id, body.model_dump(exclude_unset=True)
            )
        )
    )


@router.get("/{workspace_id}/overview", response_model=WorkspaceOverview)
async def get_workspace_overview(
    workspace_id: UUID,
    caller: Caller,
    control_plane: WorkspaceControlPlane,
    tz: str = "UTC",
) -> WorkspaceOverview:
    value = await control_plane.workspace_overview(caller, tz=tz)
    workspace = value.get("workspace") or await control_plane.get_workspace(
        caller, workspace_id
    )
    return WorkspaceOverview(
        workspace=Workspace.model_validate(workspace_payload(workspace)),
        metrics=value.get("metrics", {}),
        attention=value.get("attention", {}),
        recent_activity=value.get("recent_activity", []),
        knowledge=value["knowledge"],
        usage=value["usage"],
        generated_at=value.get("generated_at") or datetime.now(),
    )


@router.get("/{workspace_id}/activity", response_model=WorkspaceActivity)
async def get_workspace_activity(
    workspace_id: UUID,
    caller: Caller,
    control_plane: WorkspaceControlPlane,
    window: Literal["24h", "7d", "30d"] = "7d",
    tz: str = "UTC",
) -> WorkspaceActivity:
    return WorkspaceActivity.model_validate(
        await control_plane.workspace_activity(
            caller, workspace_id, window=window, tz=tz
        )
    )


__all__ = ["router"]
