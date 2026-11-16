"""The reader view of a document: its preview and passages (citation targets).

GetItemPreview is PostgreSQL plus signed storage URLs only (``document_viewer.md``):
the preview engine answers from the revision's stored representation and
never converts; a missing one is asked of the ingestion worker
(``bomesh_preview``). Passages are the index's citation targets; PostgreSQL
authorizes first and the index is then read by ``item_id``, never by the
payload's collection, so a lagging payload cannot hide content
(``item_model.md`` §4.10).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from bomesh.connector.protocol import CitationInfo
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import ContextualChunk
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import ItemRef
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.citations import CitationService
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.knowledge_items.records import (
    BoundingBox,
    PassageRecord,
    PreviewRecord,
)
from bomesh.services.knowledge_items.support import KnowledgeDeps, load_content_source

#: Passages read for one document; a document has far fewer chunks.
MAX_PASSAGES = 10_000


class ItemContentService:
    """GetItemPreview, ListPassages and GetPassage."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemContentService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def get_preview(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, revision: int | None
    ) -> PreviewRecord:
        """How to show the current (or the given) revision's own file; never needs processing."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_content_source(
                session, ctx, workspace_id, item_id, reviewer_exception=True
            )
            if item.item_type != "document":
                raise InvalidArgument("A COLLECTION has no preview.")
            if item.status != "ready":
                raise FailedPrecondition(
                    "The document's content is not available yet.", reason="CONTENT_NOT_AVAILABLE"
                )
            items = ItemService(session)
            stored = (
                await items.revision(item_id, revision)
                if revision is not None
                else await items.current_revision(item_id)
            )
            if stored is None:
                if revision is not None:
                    raise NotFound(
                        f"Revision {revision} of '{item_name(workspace_id, item_id)}' was not found."
                    )
                raise FailedPrecondition(
                    "The document's content is not available yet.", reason="CONTENT_NOT_AVAILABLE"
                )
            view = await self._deps.previews.read(session, item, stored)
            return PreviewRecord(
                workspace_id=workspace_id,
                item_id=item_id,
                revision=stored.revision_number,
                state=view.state,
                unavailable_reason=view.unavailable_reason,
                representation=view.representation,
                original=view.original,
            )

    async def list_passages(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, offset: int, limit: int
    ) -> list[PassageRecord]:
        """Passages of ``indexedRevision`` in document order."""
        item = await self._readable_document(ctx, workspace_id, item_id)
        chunks = await self._chunks(item)
        return await self._passages(item, chunks[offset : offset + limit])

    async def get_passage(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, chunk_id: str
    ) -> PassageRecord:
        item = await self._readable_document(ctx, workspace_id, item_id)
        chunks = await self._deps.index.get_item_content(
            str(item.id), tenant_id=str(workspace_id), chunk_id=chunk_id, limit=1
        )
        if not chunks:
            raise NotFound(f"Passage '{chunk_id}' of '{item_name(workspace_id, item_id)}' was not found.")
        return (await self._passages(item, chunks))[0]

    async def _readable_document(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID
    ) -> Item:
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_content_source(session, ctx, workspace_id, item_id)
        if item.item_type != "document":
            raise InvalidArgument("A COLLECTION has no passages.")
        return item

    async def _chunks(self, item: Item) -> list[ContextualChunk]:
        return await self._deps.index.get_item_content(
            str(item.id), tenant_id=str(item.tenant_id), limit=MAX_PASSAGES
        )

    async def _passages(self, item: Item, chunks: list[ContextualChunk]) -> list[PassageRecord]:
        async with transaction_scope(self._deps.sessions) as session:
            citations = await CitationService(session).get_for_chunks(
                item.id, [chunk.id for chunk in chunks]
            )
        records: list[PassageRecord] = []
        for chunk in chunks:
            citation = citations.get(chunk.id, chunk.citation)
            records.append(
                PassageRecord(
                    workspace_id=item.tenant_id,
                    item_id=item.id,
                    chunk_id=chunk.id,
                    text=chunk.chunk_text,
                    page_number=citation.page_start,
                    bounding_boxes=_boxes(citation),
                    element_ids=tuple(
                        dict.fromkeys(
                            span.element_id for span in citation.spans if span.element_id
                        )
                    ),
                    revision=item.indexed_revision_number,
                )
            )
        return records


def _boxes(citation: CitationInfo) -> tuple[BoundingBox, ...]:
    return tuple(
        BoundingBox(
            page_number=span.page,
            left=span.bounding_box.x,
            top=span.bounding_box.y,
            width=span.bounding_box.width,
            height=span.bounding_box.height,
        )
        for span in citation.spans
        if span.bounding_box is not None and span.page is not None
    )


__all__ = ["ItemContentService"]
