"""The reader view of a document: content, passages (citation targets).

PostgreSQL authorizes first; the index is then read by ``item_id``, never by
the payload's collection, so a lagging payload cannot hide content
(``item_model.md`` §4.10).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.connector.protocol import CitationInfo
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import ContextualChunk
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import ItemRef
from bomesh.services import DOCUMENT_RENDITION_VERSION, PreviewManifest
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.citations import CitationService
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.knowledge_items.preview import KnowledgePreview, parse_manifest
from bomesh.services.knowledge_items.records import (
    BoundingBox,
    ContentElement,
    ContentRecord,
    PageAsset,
    PassageRecord,
    Rendition,
)
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    load_content_source,
    thumbnail_uri,
)

#: The rendition format version clients cache by (``document-v1`` → 1).
RENDITION_FORMAT_VERSION = int(DOCUMENT_RENDITION_VERSION.rsplit("v", 1)[1])
#: Passages read for one document; a document has far fewer chunks.
MAX_PASSAGES = 10_000


class ItemContentService:
    """GetItemContent, ListPassages and GetPassage."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemContentService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def get_content(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, revision: int | None
    ) -> ContentRecord:
        """The reader representation of the current (or the given) revision."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_content_source(
                session, ctx, workspace_id, item_id, reviewer_exception=True
            )
            if item.item_type != "document":
                raise InvalidArgument("A COLLECTION has no content.")
            items = ItemService(session)
            current = await items.current_revision(item_id)
            stored = await items.revision(item_id, revision) if revision is not None else current
            if stored is None:
                if revision is not None:
                    raise NotFound(
                        f"Revision {revision} of '{item_name(workspace_id, item_id)}' was not found."
                    )
                raise FailedPrecondition("The document has no content yet.")
            manifest = parse_manifest(stored.exports.get("preview"))
            if manifest is None and current is not None and stored.revision_number == current.revision_number:
                manifest = parse_manifest(item.metadata_.get("preview"))
            number = stored.revision_number
        if manifest is None:
            if revision is not None:
                raise FailedPrecondition(
                    "This revision has no stored preview.", reason="REVISION_NOT_RENDERED"
                )
            raise FailedPrecondition("The document has not been rendered yet.")
        elements = (
            await self._elements(item) if number == item.indexed_revision_number else ()
        )
        return ContentRecord(
            workspace_id=workspace_id,
            item_id=item_id,
            revision=number,
            elements=elements,
            page_assets=resolve_page_assets(
                self._deps.preview,
                item,
                manifest,
                expires_seconds=self._deps.download_url_seconds,
            ),
            rendition=resolve_rendition(
                self._deps.preview,
                item,
                manifest,
                expires_seconds=self._deps.download_url_seconds,
            ),
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
            manifest = await self._indexed_manifest(session, item)
        pages = self._page_urls(item, manifest)
        records: list[PassageRecord] = []
        for chunk in chunks:
            citation = citations.get(chunk.id, chunk.citation)
            page = citation.page_start
            records.append(
                PassageRecord(
                    workspace_id=item.tenant_id,
                    item_id=item.id,
                    chunk_id=chunk.id,
                    text=chunk.chunk_text,
                    page_number=page,
                    bounding_boxes=_boxes(citation),
                    element_ids=tuple(
                        dict.fromkeys(
                            span.element_id for span in citation.spans if span.element_id
                        )
                    ),
                    page_asset_uri=pages.get(page) if page is not None else None,
                    revision=item.indexed_revision_number,
                )
            )
        return records

    async def _indexed_manifest(self, session: Any, item: Item) -> PreviewManifest | None:
        if item.indexed_revision_number is None:
            return parse_manifest(item.metadata_.get("preview"))
        revision = await ItemService(session).revision(item.id, item.indexed_revision_number)
        manifest = parse_manifest(revision.exports.get("preview")) if revision else None
        return manifest or parse_manifest(item.metadata_.get("preview"))

    async def _elements(self, item: Item) -> tuple[ContentElement, ...]:
        """The indexed passages as reader elements (the view without a rendition)."""
        chunks = await self._chunks(item)
        async with transaction_scope(self._deps.sessions) as session:
            citations = await CitationService(session).get_for_chunks(
                item.id, [chunk.id for chunk in chunks]
            )
        elements: list[ContentElement] = []
        for chunk in chunks:
            citation = citations.get(chunk.id, chunk.citation)
            element_id = next(
                (span.element_id for span in citation.spans if span.element_id), chunk.id
            )
            elements.append(
                ContentElement(
                    element_id=element_id,
                    kind="PARAGRAPH",
                    text=chunk.chunk_text,
                    level=None,
                    page_number=citation.page_start,
                    chunk_id=chunk.id,
                )
            )
        return tuple(elements)

    def _page_urls(self, item: Item, manifest: PreviewManifest | None) -> dict[int, str]:
        if manifest is None:
            return {}
        return {
            asset.page: asset.url
            for asset in self._deps.preview.resolve_assets(
                item, manifest, expires_seconds=self._deps.download_url_seconds
            )
            if asset.page is not None
        }

def resolve_page_assets(
    preview: KnowledgePreview, item: Item, manifest: PreviewManifest, *, expires_seconds: int
) -> tuple[PageAsset, ...]:
    """Signed page images of a revision's manifest, after the caller was authorized."""
    return tuple(
        PageAsset(
            page_number=asset.page,
            image_uri=asset.url,
            width_pixels=asset.width,
            height_pixels=asset.height,
        )
        for asset in preview.resolve_assets(item, manifest, expires_seconds=expires_seconds)
    )


async def item_thumbnail(
    session: AsyncSession,
    preview: KnowledgePreview,
    item_id: UUID,
    *,
    expires_seconds: int,
) -> str | None:
    """:func:`thumbnail_uri` of ``item_id``; the caller has already authorized it."""
    item = await session.get(Item, item_id)
    if item is None:
        return None
    return thumbnail_uri(preview, item, expires_seconds=expires_seconds)


def resolve_rendition(
    preview: KnowledgePreview, item: Item, manifest: PreviewManifest, *, expires_seconds: int
) -> Rendition | None:
    """The signed whole-document rendition of a revision's manifest, if it has one."""
    resolved = preview.resolve_rendition(item, manifest, expires_seconds=expires_seconds)
    if resolved is None:
        return None
    return Rendition(
        uri=resolved.url,
        version=RENDITION_FORMAT_VERSION,
        size_bytes=resolved.size_bytes,
        block_count=resolved.block_count,
        truncated=resolved.truncated,
    )


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


__all__ = [
    "RENDITION_FORMAT_VERSION",
    "ItemContentService",
    "item_thumbnail",
    "resolve_page_assets",
    "resolve_rendition",
]
