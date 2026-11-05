"""Audit every write: one event per action, filed under a category with its target name."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import AuditLog
from bomesh.services.kernel.context import RequestContext
from bomesh.services.workspaces.audit_log import AuditService

Category = Literal[
    "knowledge", "files", "sources", "people", "settings", "spaces", "requests", "sign_in"
]


class Audit:
    """Record the caller's action in the caller's transaction (``AuditEvent``)."""

    def __init__(self, session: AsyncSession) -> None:
        self._service = AuditService(session)

    async def record(
        self,
        ctx: RequestContext | None,
        *,
        workspace_id: UUID | None,
        category: Category,
        action: str,
        target: str,
        outcome: Literal["succeeded", "failed"] = "succeeded",
        details: Mapping[str, Any] | None = None,
        resource_type: str | None = None,
    ) -> AuditLog:
        """``action`` is the operationId (``CreateItem``), ``target`` the resource name.

        ``ctx=None`` records a system action; ``workspace_id=None`` a platform
        one. ``resource_type`` defaults to the singular of the target's last
        collection (``workspaces/w/items/i`` → ``item``).
        """
        return await self._service.record(
            workspace_id=workspace_id,
            actor=ctx.principal if ctx is not None else None,
            category=category,
            action=action,
            resource_type=resource_type or resource_type_of(target),
            target_name=target,
            outcome=outcome,
            details=details,
            ip_address=ctx.ip_address if ctx is not None else None,
        )


def resource_type_of(name: str) -> str:
    """The singular resource type of a resource name (its last collection ID)."""
    segments = name.split("/")
    collection = segments[-2] if len(segments) % 2 == 0 else segments[-1]
    if collection.endswith("ies"):
        return collection[:-3] + "y"
    if collection.endswith("s") and collection != "settings":
        return collection[:-1]
    return collection


__all__ = ["Audit", "Category", "resource_type_of"]
