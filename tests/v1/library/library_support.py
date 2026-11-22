"""Helpers of the Library API tests."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import update

from bomesh.services.kernel.notifications import NotificationPublisher, NotificationSubject
from bomesh.db.models import Item, Notification, Tenant, User
from bomesh.iam.authorizer import Authorizer
from harness import Sessions


def me(workspace: Tenant, member: str = "me") -> str:
    return f"/api/v1/workspaces/{workspace.id}/members/{member}"


def item_ref(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


def reason(response: httpx.Response) -> str | None:
    details: list[dict[str, Any]] = response.json()["error"]["details"]
    return next((d.get("reason") for d in details if "reason" in d), None)


async def notify(
    sessions: Sessions,
    workspace: Tenant,
    user: User,
    *,
    kind: str = "ITEM_PUBLISHED",
    item: Item | None = None,
    subject: NotificationSubject | None = None,
    title: str = "Something happened",
) -> Notification:
    """Publish one notification; non-item ``subject``s skip the publish-time rule."""
    async with sessions.begin() as session:
        written = await NotificationPublisher(session, Authorizer(sessions)).publish(
            workspace_id=workspace.id,
            recipients=[user.id],
            kind=kind,
            title=title,
            body="Body",
            subject=NotificationSubject("item", item.id) if item is not None else subject,
            can_read=_always if subject is not None else None,
        )
    assert written, "the recipient was filtered out"
    return written[0]


async def _always(users: frozenset[UUID]) -> frozenset[UUID]:
    return users


async def set_created(sessions: Sessions, notification: Notification, moment: datetime) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(Notification).where(Notification.id == notification.id).values(created_at=moment)
        )


async def merge(admin: Any, duplicate: Item, target: Item) -> None:
    """MergeItem ``duplicate`` into ``target`` as ``admin`` (references move to ``target``)."""
    merged = await admin.post(
        f"/api/v1/{item_ref(duplicate)}:merge", json={"targetItem": item_ref(target)}
    )
    assert merged.status_code == 200, merged.text


def uuid_of(name: str) -> UUID:
    return UUID(name.rsplit("/", 1)[-1])
