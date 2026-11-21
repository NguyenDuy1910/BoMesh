"""The PostgreSQL side of retrieval: who may read which Item (``item_model.md`` §4.10)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
from uuid import UUID

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
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
        """The caller's visibility narrowed to the subtrees of ``ctx.collection_item_ids``
        and the documents of ``ctx.document_item_ids``."""
        workspace_id = UUID(ctx.tenant_id)
        roots = [UUID(value) for value in ctx.collection_item_ids]
        documents = [UUID(value) for value in ctx.document_item_ids]
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
        documents_only = frozenset(documents)

        async def recheck(item_ids: Sequence[str]) -> Mapping[str, DocumentFacts]:
            return await self._recheck(narrowed, visibility, documents_only, item_ids)

        return ReadScope(
            readable=tuple(str(value) for value in narrowed.readable),
            editable=tuple(str(value) for value in narrowed.editable),
            recheck=recheck,
            documents=tuple(str(value) for value in documents),
        )

    async def _recheck(
        self,
        narrowed: ItemVisibility,
        visibility: ItemVisibility,
        documents: frozenset[UUID],
        item_ids: Sequence[str],
    ) -> Mapping[str, DocumentFacts]:
        """The hits the visibility admits, with what a reader sees about each.

        Hits in the scoped subtrees are re-checked against ``narrowed``; hits that are
        only scoped as single documents against the full ``visibility``. Each check is
        one primary-key query (a statement carries one visibility set).
        """
        ids = list(dict.fromkeys(UUID(value) for value in item_ids))
        if not ids:
            return {}
        async with transaction_scope(self._sessions) as session:
            facts = await _facts(session, narrowed.clause(), ids)
            rest = [item_id for item_id in ids if item_id in documents and str(item_id) not in facts]
            if rest:
                facts.update(await _facts(session, visibility.clause(), rest))
        return facts


async def _facts(
    session: AsyncSession, admitted: ColumnElement[bool], ids: Sequence[UUID]
) -> dict[str, DocumentFacts]:
    parent = aliased(Item)
    statement = (
        select(
            Item.id,
            ItemRevision.mime_type,
            ItemRevision.file_name,
            Item.updated_at,
            parent.item_name,
        )
        .outerjoin(ItemRevision, ItemRevision.id == Item.current_revision_id)
        .outerjoin(parent, parent.id == Item.parent_item_id)
        .where(Item.id.in_(ids), admitted)
    )
    return {
        str(item_id): DocumentFacts(
            mime_type=mime_type,
            file_name=file_name,
            updated_at=updated_at,
            collection_title=collection_title,
        )
        for item_id, mime_type, file_name, updated_at, collection_title in (
            await session.execute(statement)
        ).all()
    }


__all__ = ["ItemReadAccess"]
