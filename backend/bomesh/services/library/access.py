"""The self-only gate of every Library method and the shared reference helpers."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory
from bomesh.errors import PermissionDenied
from bomesh.iam.authorizer import ItemRef, WorkspaceRef, permission_denied
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.knowledge_items.summary import ItemSummary, get_item_summary
from bomesh.services.workspaces.records import ME, member_name


@dataclass(frozen=True, slots=True)
class Owner:
    """The member whose library a request reads: always the caller."""

    workspace_id: UUID
    user_id: UUID

    @property
    def name(self) -> str:
        return member_name(self.workspace_id, self.user_id)


class LibraryGate:
    """``permission`` on the workspace, then the caller must be ``{member}`` (or ``me``)."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._resolver = WorkspaceResolver(sessions)

    async def open(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        permission: str,
        *,
        write: bool,
    ) -> Owner:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), permission, write=write)
        if member != ME and _user_id(member) != ctx.user_id:
            name = f"workspaces/{workspace_id}/members/{member}"
            raise PermissionDenied(
                f"Permission '{permission}' denied on resource '{name}' (or it might not exist)",
                metadata={"permission": permission, "resource": name},
            )
        return Owner(workspace_id, ctx.user_id)


def _user_id(member: str) -> UUID | None:
    try:
        return UUID(member)
    except ValueError:
        return None


async def readable_item(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item_id: UUID
) -> ItemSummary | None:
    """The reference summary of ``item_id`` for the caller; ``None`` reads as absent."""
    return await get_item_summary(session, ctx.authorizer, ctx.principal, workspace_id, item_id)


def unreadable(workspace_id: UUID, item_id: UUID) -> PermissionDenied:
    """AIP-211 for a referenced item the member cannot read (or that does not exist)."""
    return permission_denied("items.get", ItemRef(workspace_id, item_id))


__all__ = ["LibraryGate", "Owner", "readable_item", "unreadable"]
