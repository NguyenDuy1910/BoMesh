"""Shared helpers of the Collaboration API tests."""

from __future__ import annotations

from typing import Any

import httpx
from sqlalchemy import select

from bomesh.db.models import Notification, Space, Tenant, User
from harness import Sessions


def reason(response: httpx.Response) -> str | None:
    """The ErrorInfo reason of an error response."""
    for detail in response.json()["error"].get("details", []):
        if detail.get("@type", "").endswith("ErrorInfo"):
            return detail.get("reason")
    return None


def ws_path(workspace: Tenant) -> str:
    return f"/api/v1/workspaces/{workspace.id}"


def space_path(workspace: Tenant, space: Space | str) -> str:
    code = space if isinstance(space, str) else space.code
    return f"{ws_path(workspace)}/spaces/{code}"


def space_name(workspace: Tenant, space: Space | str) -> str:
    return space_path(workspace, space).removeprefix("/api/v1/")


def member_name(workspace: Tenant, user: User) -> str:
    return f"workspaces/{workspace.id}/members/{user.id}"


def item_name(workspace: Tenant, item: Any) -> str:
    return f"workspaces/{workspace.id}/items/{item.id}"


def path_of(name: str) -> str:
    return f"/api/v1/{name}"


async def set_settings(sessions: Sessions, workspace: Tenant, **values: Any) -> None:
    """Merge ``values`` into the stored workspace settings (e.g. ``modules``, ``space_types``)."""
    async with sessions.begin() as session:
        row = await session.get(Tenant, workspace.id)
        assert row is not None
        row.settings = {**row.settings, **values}


async def notifications_of(sessions: Sessions, user: User) -> list[Notification]:
    async with sessions.begin() as session:
        return list(
            await session.scalars(
                select(Notification).where(Notification.recipient_user_id == user.id)
            )
        )
