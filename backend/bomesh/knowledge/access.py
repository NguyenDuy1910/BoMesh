"""The PostgreSQL side of retrieval: who may read which Item (``item_model.md`` §4.10)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.db.engine import transaction_scope
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.iam.visibility import ItemVisibility
from bomesh.knowledge import ReadScope, RetrievalContext
from bomesh.services.knowledge_items.item_store import catalog_visibility, collection_subtree, visible_item_ids


class ItemReadAccess:
    """Readable/editable collections per search, and the visibility re-check of hits.

    No cache: a grant, revoke, move, unpublish or delete is effective at the
    next search.
    """

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def scope(self, ctx: RetrievalContext) -> ReadScope:
        """The caller's visibility narrowed to the subtrees of ``ctx.collection_item_ids``."""
        workspace_id = UUID(ctx.tenant_id)
        roots = [UUID(value) for value in ctx.collection_item_ids]
        async with transaction_scope(self._sessions) as session:
            visibility = await catalog_visibility(
                session, Authorizer(self._sessions), Principal(UUID(ctx.user_id)), workspace_id
            )
            subtree = await collection_subtree(session, workspace_id, roots)
        narrowed = replace(
            visibility,
            readable=visibility.readable & subtree,
            editable=visibility.editable & subtree,
        )

        async def recheck(item_ids: Sequence[str]) -> frozenset[str]:
            return await self._recheck(narrowed, item_ids)

        return ReadScope(
            readable=tuple(str(value) for value in narrowed.readable),
            editable=tuple(str(value) for value in narrowed.editable),
            recheck=recheck,
        )

    async def _recheck(
        self, visibility: ItemVisibility, item_ids: Sequence[str]
    ) -> frozenset[str]:
        async with transaction_scope(self._sessions) as session:
            visible = await visible_item_ids(
                session, visibility, (UUID(value) for value in item_ids)
            )
        return frozenset(str(value) for value in visible)


__all__ = ["ItemReadAccess"]
