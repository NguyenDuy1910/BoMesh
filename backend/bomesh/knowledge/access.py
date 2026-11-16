"""The PostgreSQL side of retrieval: who may read which Item (``item_model.md`` §4.10)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.iam.visibility import ItemVisibility
from bomesh.knowledge import DocumentFacts, ReadScope, RetrievalContext
from bomesh.services.knowledge_items.item_store import catalog_visibility, collection_subtree


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

        async def recheck(item_ids: Sequence[str]) -> Mapping[str, DocumentFacts]:
            return await self._recheck(narrowed, item_ids)

        return ReadScope(
            readable=tuple(str(value) for value in narrowed.readable),
            editable=tuple(str(value) for value in narrowed.editable),
            recheck=recheck,
        )

    async def _recheck(
        self, visibility: ItemVisibility, item_ids: Sequence[str]
    ) -> Mapping[str, DocumentFacts]:
        """The hits the visibility admits, with what a reader sees about each (one primary-key query)."""
        ids = list(dict.fromkeys(UUID(value) for value in item_ids))
        if not ids:
            return {}
        parent = aliased(Item)
        statement = (
            select(
                Item.id,
                Item.mime_type,
                Item.metadata_["file_name"].astext,
                Item.updated_at,
                parent.title,
            )
            .outerjoin(parent, parent.id == Item.parent_item_id)
            .where(Item.id.in_(ids), visibility.clause())
        )
        async with transaction_scope(self._sessions) as session:
            rows = (await session.execute(statement)).all()
        return {
            str(item_id): DocumentFacts(
                mime_type=mime_type,
                file_name=file_name,
                updated_at=updated_at,
                collection_title=collection_title,
            )
            for item_id, mime_type, file_name, updated_at, collection_title in rows
        }


__all__ = ["ItemReadAccess"]
