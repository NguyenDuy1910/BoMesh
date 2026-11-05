"""Infrastructure and small helpers shared by the KnowledgeCuration services."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory
from bomesh.db.models import Item
from bomesh.document_index import ItemIndex
from bomesh.errors import NotFound
from bomesh.iam.authorizer import ItemRef, permission_denied
from bomesh.iam.visibility import require_visible_item
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import WorkspaceResolver

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime


@dataclass(frozen=True, slots=True)
class CurationDeps:
    sessions: SessionFactory
    index: ItemIndex
    request_hash_secret: bytes

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> CurationDeps:
        return cls(
            sessions=runtime.sessions(),
            index=runtime.item_index(),
            request_hash_secret=runtime.request_hash_secret(),
        )

    @property
    def workspaces(self) -> WorkspaceResolver:
        return WorkspaceResolver(self.sessions)


async def now(session: AsyncSession) -> datetime:
    return await session.scalar(select(func.now()))


async def referenced_item(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    item_id: UUID,
    *,
    for_update: bool = False,
) -> Item:
    """An item a request names in a field: one the caller cannot see is PERMISSION_DENIED."""
    ref = ItemRef(workspace_id, item_id)
    try:
        return await require_visible_item(
            session, ctx.authorizer, ctx.principal, ref, for_update=for_update
        )
    except NotFound:
        raise permission_denied("items.get", ref) from None
