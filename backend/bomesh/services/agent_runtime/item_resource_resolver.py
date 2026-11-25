"""Resolve authorized Item resources for one agent run."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING
from uuid import UUID

from docling_core.types.doc import DoclingDocument, ImageRefMode
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.agent import ModelContent, ResourceRef
from bomesh.agent.protocol import InputImage
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_structure import StructureManifest, StructureRef
from bomesh.iam import WorkspaceAccess
from bomesh.services import DocumentNotFoundError, DocumentProcessingError
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.structure_store import StructureUnavailable

if TYPE_CHECKING:
    from bomesh.services.knowledge_items.original_parser import OriginalParser
    from bomesh.services.knowledge_items.structure_store import StructureStore


class ItemResourceResolver:
    """Map stable Item identities to explicit, access-checked capabilities."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        access: WorkspaceAccess,
        structures: StructureStore,
        originals: OriginalParser,
        max_read_characters: int,
    ) -> None:
        if max_read_characters < 1:
            raise ValueError("resource read limit must be greater than zero")
        self._sessions = session_factory
        self._access = access
        self._structures = structures
        self._originals = originals
        self._max_read_characters = max_read_characters

    async def inspect(self, resource: ResourceRef) -> dict[str, object]:
        item = await self._item(resource)
        return {
            "id": str(item.id),
            "name": item.file_name or item.item_name,
            "mime_type": item.mime_type or "application/octet-stream",
            "size_bytes": item.size_bytes,
            "kind": "image" if (item.mime_type or "").startswith("image/") else "file",
            "index_status": item.index_status,
        }

    async def read(self, resource: ResourceRef, *, max_characters: int) -> str:
        """The current revision's Structured Document as Markdown, clipped to the limit.

        A processed document is read from its stored Structured Document; one
        without parses its original once (never converting a legacy format).
        """
        if max_characters < 1:
            raise ValueError("resource read limit must be greater than zero")
        item = await self._item(resource)
        async with transaction_scope(self._sessions) as session:
            revision = await ItemService(session).current_revision(item.id)
        if revision is None:
            raise DocumentProcessingError("resource content is not available")
        document = await self._document(item, revision)
        text = (
            await asyncio.to_thread(
                document.export_to_markdown, image_mode=ImageRefMode.PLACEHOLDER
            )
        ).strip()
        limit = min(max_characters, self._max_read_characters)
        return text if len(text) <= limit else f"{text[:limit].rstrip()}…"

    async def materialize(self, resource: ResourceRef) -> tuple[ModelContent, ...]:
        item = await self._item(resource)
        mime_type = item.mime_type or ""
        if not mime_type.startswith("image/"):
            raise DocumentProcessingError("resource cannot be materialized as an image")
        return (InputImage(image_url=await self._originals.image_data_url(item)),)

    async def _document(self, item: Item, revision: ItemRevision) -> DoclingDocument:
        manifest = StructureManifest.parse(revision.exports)
        if manifest is not None:
            try:
                return await self._structures.document(
                    StructureRef(item.tenant_id, revision.content_id, manifest.fingerprint)
                )
            except StructureUnavailable:
                pass
        parsed = await self._structures.ensure(item, revision=revision, convert=False)
        return parsed.document

    async def _item(self, resource: ResourceRef) -> Item:
        try:
            item_id = UUID(resource.id)
        except ValueError as exc:
            raise DocumentNotFoundError("resource not found") from exc
        async with transaction_scope(self._sessions) as session:
            return await ItemService(session).get_item(item_id, access=self._access)


__all__ = ["ItemResourceResolver"]
