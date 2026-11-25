"""Helpers for the KnowledgeItems slice tests: URLs, indexing content, uploads.

Tests import them with ``from knowledge_support import ...``; the ``knowledge``
fixture lives in ``conftest.py``.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from docling_core.types.doc import (
    BoundingBox,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
)
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemIndexState, ItemRevision
from bomesh.document_index import ClassificationRequest, IndexingContext
from bomesh.document_structure import (
    StructureManifest,
    StructureRef,
    StructureView,
    clip,
    decode_json,
    encode,
)
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from bomesh.storage.keys import content_key, new_content_id
from harness import ApiClient, Fakes, Sessions

#: ``Chunk.quote`` bound (``CitationTarget.quote``).
_QUOTE_CHARACTERS = 280


def paragraphs(texts: Sequence[str], *, page: int | None = None) -> DoclingDocument:
    """A Structured Document whose ``texts/{n}`` is the paragraph ``texts[n]``."""
    document = DoclingDocument(name="document")
    if page is not None:
        for number in range(1, page + 1):
            document.add_page(page_no=number, size=Size(width=600, height=800))
    for text in texts:
        provenance = (
            ProvenanceItem(
                page_no=page,
                bbox=BoundingBox(l=10, t=10, r=500, b=40),
                charspan=(0, len(text)),
            )
            if page is not None
            else None
        )
        document.add_text(label=DocItemLabel.PARAGRAPH, text=text, prov=provenance)
    return document


def ws_url(workspace: Any) -> str:
    return f"/api/v1/workspaces{_id(workspace)}"


def item_url(item: Item, suffix: str = "") -> str:
    return f"/api/v1/workspaces/{item.tenant_id}/items/{item.id}{suffix}"


def item_name(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


def _id(workspace: Any) -> str:
    return f"/{workspace.id if hasattr(workspace, 'id') else workspace}"


def error_reason(response: Any) -> str | None:
    for detail in response.json()["error"]["details"]:
        if "reason" in detail:
            return detail["reason"]
    return None


def chunk_id(document: Item, position: int) -> str:
    """The chunk ID processing gives a document's ``position``-th chunk (``{item}:{n}``)."""
    return f"{document.id}:{position}"


class Knowledge:
    """Index content, add revisions and read rows the way the tests need."""

    def __init__(self, runtime: AppRuntime, sessions: Sessions, fakes: Fakes) -> None:
        self.runtime = runtime
        self.sessions = sessions
        self.fakes = fakes

    async def store_structure(
        self,
        document: Item,
        structure: DoclingDocument,
        *,
        revision: int | None = None,
        pictures: dict[str, bytes] | None = None,
    ) -> str:
        """Store ``structure`` as the Structured Document of the current (or given)
        revision, the way processing does; returns its fingerprint (structure version)."""
        data = encode(structure)
        fingerprint = self.runtime.structure_store().profile(read_images=False).fingerprint()
        async with transaction_scope(self.sessions) as session:
            items = ItemService(session)
            stored = (
                await items.revision(document.id, revision)
                if revision is not None
                else await items.current_revision(document.id)
            )
            assert stored is not None
            ref = StructureRef(document.workspace_code, stored.content_id, fingerprint)
            manifest = StructureManifest(
                fingerprint=fingerprint,
                docling_schema=structure.version,
                size_bytes=len(data),
                nodes=StructureView(decode_json(data)).total,
                pictures=len(structure.pictures),
                pages=len(structure.pages) or None,
            )
            for row in await session.scalars(
                select(ItemRevision).where(ItemRevision.content_id == stored.content_id)
            ):
                row.exports = {**row.exports, "structure": manifest.model_dump(mode="json")}
        self.fakes.storage.put_bytes(data, ref.key, content_type="application/gzip")
        for name, image in (pictures or {}).items():
            self.fakes.storage.put_bytes(image, ref.picture_key(name), content_type="image/png")
        return fingerprint

    async def index(
        self,
        document: Item,
        texts: Sequence[str],
        *,
        page: int | None = None,
        classification: ClassificationRequest | None = None,
    ) -> list[str]:
        """Index ``texts`` as chunks ``{item}:{n}`` of ``document`` (its current payload
        state), each citing paragraph ``texts/{n}`` of a Structured Document stored for
        its current revision, marked SUCCEEDED for that revision; returns the chunk IDs."""
        version = await self.store_structure(document, paragraphs(texts, page=page))
        async with transaction_scope(self.sessions) as session:
            row = await session.get(Item, document.id)
            assert row is not None
            path = [row]
            while path[-1].item_kind != "collection":
                parent = await session.get(Item, path[-1].parent_item_id)
                assert parent is not None
                path.append(parent)
            collection = path[-1]
            revision = await ItemService(session).current_revision(document.id)
            assert revision is not None
        canonical = DocumentItem(
            id=str(row.id),
            title=row.item_name,
            document_kind=DocumentKind.NOTE,
            source=SourceIdentity(
                connector_id="upload", provider=SourceProvider.FILE, external_id=str(row.id)
            ),
            hierarchy=Hierarchy(parent_id=str(row.parent_item_id)),
            access=AccessPolicy(),
        )
        chunks = [
            Chunk(
                id=chunk_id(row, position),
                item_id=str(row.id),
                chunk_index=position,
                chunk_text=text,
                content_type="text",
                refs=(f"texts/{position}",),
                quote=clip(text, _QUOTE_CHARACTERS),
                page=page,
            )
            for position, text in enumerate(texts)
        ]
        await ItemIngestionService(self.sessions, index=self.runtime.item_index()).process_item_content(
            row,
            canonical,
            chunks,
            context=IndexingContext(
                tenant_id=str(row.tenant_id),
                collection_item_id=str(collection.id),
                parent_item_id=str(row.parent_item_id),
                connector_key="file",
                published=row.is_published,
                revision_number=revision.revision_number,
                structure_version=version,
            ),
            processed_version=self.runtime.processing_version(),
            classification=classification,
        )
        return [chunk.id for chunk in chunks]

    async def add_revision(
        self,
        document: Item,
        *,
        content_id: UUID | None = None,
        size: int = 10,
        data: bytes | None = None,
        mime_type: str = "application/pdf",
    ) -> int:
        """Store a content (a new one unless ``content_id`` names one) and append it
        as the document's newest revision."""
        content = content_id or new_content_id()
        body = data if data is not None else b"x" * size
        self.fakes.storage.put_bytes(
            body, content_key(document.workspace_code, content), content_type=mime_type
        )
        async with transaction_scope(self.sessions) as session:
            row = await session.get(Item, document.id)
            assert row is not None
            revision = await ItemService(session).append_revision(
                row, content_id=content, mime_type=mime_type, size_bytes=len(body)
            )
            return revision.revision_number

    async def row(self, item: Item | UUID) -> Item:
        """The Item with its current revision and upload loaded (tests inspect both)."""
        identifier = item if isinstance(item, UUID) else item.id
        async with transaction_scope(self.sessions) as session:
            row = await session.get(
                Item,
                identifier,
                options=(selectinload(Item.current_revision), selectinload(Item.upload)),
            )
            assert row is not None
            return row

    async def index_state(self, item: Item | UUID) -> ItemIndexState:
        """The document's ``item_index_states`` row (``payload_dirty_at`` lives only there)."""
        identifier = item if isinstance(item, UUID) else item.id
        async with transaction_scope(self.sessions) as session:
            state = await session.get(ItemIndexState, identifier)
            assert state is not None
            return state

    async def revisions(self, item: Item) -> list[ItemRevision]:
        async with transaction_scope(self.sessions) as session:
            return list(
                await session.scalars(
                    select(ItemRevision)
                    .where(ItemRevision.item_id == item.id)
                    .order_by(ItemRevision.revision_number)
                )
            )

    def payload(self, document: Item) -> dict[str, Any]:
        """The (shared) payload of the document's points."""
        points = [
            point
            for point in self.fakes.index_backend.points.values()
            if point.payload.get("item_id") == str(document.id)
        ]
        assert points, "the document has no indexed points"
        return points[0].payload


async def upload(
    client: ApiClient,
    parent: Item,
    *,
    data: bytes = b"hello knowledge",
    file_name: str = "notes.txt",
    mime_type: str = "text/plain",
    purpose: str | None = None,
    request_id: UUID | None = None,
) -> Any:
    """CreateItemMedia of ``data`` into ``parent``."""
    metadata: dict[str, Any] = {
        "itemKind": "DOCUMENT",
        "displayName": file_name,
        "parentItem": item_name(parent),
        "document": {"mimeType": mime_type, "fileName": file_name},
    }
    if purpose is not None:
        metadata["document"]["purpose"] = purpose
    params = {"requestId": str(request_id)} if request_id else None
    return await client.post(
        f"/upload/api/v1/workspaces/{parent.tenant_id}/items",
        data={"metadata": json.dumps(metadata)},
        files={"file": (file_name, data, mime_type)},
        params=params,
    )


__all__ = [
    "Knowledge",
    "chunk_id",
    "error_reason",
    "item_name",
    "item_url",
    "paragraphs",
    "upload",
    "ws_url",
]
