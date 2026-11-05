"""Helpers for the KnowledgeItems slice tests: URLs, indexing content, uploads.

Tests import them with ``from knowledge_support import ...``; the ``knowledge``
fixture lives in ``conftest.py``.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import select

from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    CitationInfo,
    CitationSpan,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.connector.protocol.citation import BoundingBox
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_index import IndexingContext
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from harness import ApiClient, Fakes, Sessions


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

    async def index(
        self,
        document: Item,
        texts: Sequence[str],
        *,
        page: int | None = None,
    ) -> list[str]:
        """Index ``texts`` as chunks ``{item}:{n}`` of ``document`` (its current payload
        state), marked SUCCEEDED for its current revision; returns the chunk IDs."""
        async with transaction_scope(self.sessions) as session:
            row = await session.get(Item, document.id)
            assert row is not None
            path = [row]
            while path[-1].item_type != "collection":
                parent = await session.get(Item, path[-1].parent_item_id)
                assert parent is not None
                path.append(parent)
            collection = path[-1]
            revision = await ItemService(session).current_revision(document.id)
        canonical = DocumentItem(
            id=str(row.id),
            title=row.title,
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
                citation=CitationInfo(
                    page_start=page,
                    page_end=page,
                    spans=(
                        CitationSpan(
                            page=page,
                            element_id=f"element-{position}",
                            bounding_box=BoundingBox(x=0.1, y=0.2, width=0.5, height=0.1),
                        ),
                    )
                    if page is not None
                    else (),
                ),
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
                document_type=row.document_type or "plain_text",
                connector_key="file",
                published=row.publication_state == "published",
            ),
            processed_version=self.runtime.processing_version(),
            revision_number=revision.revision_number if revision is not None else None,
        )
        return [chunk.id for chunk in chunks]

    async def add_revision(self, document: Item, *, key: str, size: int = 10) -> int:
        """Store an object and append it as the document's newest revision."""
        self.fakes.storage.put_bytes(b"x" * size, key, content_type="application/pdf")
        async with transaction_scope(self.sessions) as session:
            row = await session.get(Item, document.id)
            assert row is not None
            revision = await ItemService(session).append_revision(
                row, storage_key=key, mime_type="application/pdf", size_bytes=size
            )
            return revision.revision_number

    async def row(self, item: Item | UUID) -> Item:
        identifier = item if isinstance(item, UUID) else item.id
        async with transaction_scope(self.sessions) as session:
            row = await session.get(Item, identifier)
            assert row is not None
            return row

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
        "itemType": "DOCUMENT",
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
    "upload",
    "ws_url",
]
