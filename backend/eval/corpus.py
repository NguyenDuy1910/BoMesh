"""Read the already-indexed workspace corpus a dataset is drawn from."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import ContextualChunk, ItemIndex
from bomesh.iam import Authorizer


@dataclass(frozen=True, slots=True)
class CorpusDocument:
    item_id: str
    title: str
    mime_type: str | None
    collection_item_id: str


async def indexed_documents(
    sessions: SessionFactory,
    *,
    tenant_id: str,
    collection_item_ids: Sequence[str],
) -> list[CorpusDocument]:
    """Live Documents with a ready index, governed by one of the Collections."""

    wanted = {UUID(value) for value in collection_item_ids}
    tenant = UUID(tenant_id)
    async with transaction_scope(sessions) as session:
        rows = (
            await session.execute(
                select(Item.id, Item.title, Item.mime_type)
                .where(
                    Item.tenant_id == tenant,
                    Item.item_type == "document",
                    Item.index_status == "ready",
                    Item.deleted_at.is_(None),
                )
                .order_by(Item.id)
            )
        ).all()
    authorizer = Authorizer(sessions)
    documents: list[CorpusDocument] = []
    for row in rows:
        collection_id = await authorizer.governing_collection(row.id)
        if collection_id in wanted:
            documents.append(
                CorpusDocument(
                    item_id=str(row.id),
                    title=row.title,
                    mime_type=row.mime_type,
                    collection_item_id=str(collection_id),
                )
            )
    return documents


async def tenant_collection_ids(sessions: SessionFactory, *, tenant_id: str) -> list[str]:
    """Every live Collection of the tenant (used to scope leak probes)."""

    async with transaction_scope(sessions) as session:
        rows = await session.scalars(
            select(Item.id).where(
                Item.tenant_id == UUID(tenant_id),
                Item.item_type == "collection",
                Item.deleted_at.is_(None),
            )
        )
        return [str(value) for value in rows]


async def document_chunks(
    index: ItemIndex, document: CorpusDocument, *, tenant_id: str, limit: int = 500
) -> list[ContextualChunk]:
    return await index.get_item_content(
        document.item_id,
        tenant_id=tenant_id,
        collection_item_id=document.collection_item_id,
        limit=limit,
    )


__all__ = [
    "CorpusDocument",
    "document_chunks",
    "indexed_documents",
    "tenant_collection_ids",
]
