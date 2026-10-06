"""The processing core: turn one stored Document into indexed knowledge.

An Ingestion Run is the only caller of :meth:`ItemIngestionService.process_document`:
uploads and connector Items alike have their original in object storage, and
processing always starts from it. Adding data never comes through here.
Deleting does: removing a Document removes its derived index content too.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import joinedload

from bomesh.connector.protocol import Chunk, DocumentItem
from bomesh.db.engine import advisory_lock_scope, transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import (
    EmbeddingRejectedError,
    IndexingContext,
    IndexProgress,
    ItemIndex,
)
from bomesh.services import (
    AuthContext,
    DocumentNotFoundError,
    DocumentProcessingError,
    DocumentUnavailableError,
    StoredFileContent,
    current_processing_version,
    require_user_identity,
)
from bomesh.services.citation import CitationService
from bomesh.services.identity_access.authorization import AuthorizationService
from bomesh.services.item import ItemService
from bomesh.services.preview import KnowledgePreview

log = logging.getLogger(__name__)

INTERRUPTED_MESSAGE = "Processing was interrupted before it finished."


class PhaseRecorder:
    """Where one Document is in the pipeline; an ``IndexProgress`` observer.

    Each call is ``(phase, done, total)``; a new phase closes the previous one.
    The run keeps :attr:`phases` on the Document's run item as it goes.
    """

    def __init__(self) -> None:
        self.phases: list[dict[str, Any]] = []
        #: Bumped on every report; readers compare it to skip unchanged state.
        self.version = 0

    def __call__(self, phase: str, done: int, total: int) -> None:
        now = datetime.now(UTC).isoformat()
        if not self.phases or self.phases[-1]["phase"] != phase:
            self._finish(now, completed=True)
            self.phases.append(
                {"phase": phase, "started_at": now, "finished_at": None, "done": 0, "total": 0}
            )
        self.phases[-1]["done"] = done
        self.phases[-1]["total"] = total
        self.version += 1

    def close(self, *, completed: bool = False) -> list[dict[str, Any]]:
        """End the phase in flight; only a Document that succeeded finished its work."""

        self._finish(datetime.now(UTC).isoformat(), completed=completed)
        self.version += 1
        return self.phases

    def snapshot(self) -> dict[str, Any]:
        current = self.phases[-1] if self.phases else None
        return {
            "phase": current["phase"] if current else "queued",
            "done": current["done"] if current else 0,
            "total": current["total"] if current else 0,
        }

    def _finish(self, now: str, *, completed: bool) -> None:
        # Progress is reported before each unit of work, so a phase that handed
        # over to the next got through all of it; one cut short by a failure or
        # a cancel keeps the count it reached.
        if self.phases and self.phases[-1]["finished_at"] is None:
            self.phases[-1]["finished_at"] = now
            if completed:
                self.phases[-1]["done"] = self.phases[-1]["total"]


def failure_message(exc: BaseException) -> str:
    """The reason a person is shown: a processing error's own words, else generic."""

    if isinstance(exc, EmbeddingRejectedError):
        # The provider's own text can carry account details; the status cannot.
        return (
            f"The embedding provider refused the request (HTTP {exc.status_code}). "
            "An administrator must check the model provider key, credit and "
            "embedding model, then retry."
        )
    if not isinstance(exc, DocumentProcessingError):
        return INTERRUPTED_MESSAGE
    text = str(exc).strip() or "The document could not be processed"
    text = text[0].upper() + text[1:]
    return text if text.endswith((".", "!", "?")) else f"{text}."


class ItemIngestionService:
    """Process stored Documents into the index, and remove what was derived from them.

    Owns the Document's index-status transitions and citation persistence
    around indexing; indexing itself is the injected ``ItemIndex``.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        content: StoredFileContent | None = None,
        preview: KnowledgePreview | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._index = index
        self._content = content
        self._preview = preview

    def processing_version(self) -> str:
        """The version processing produces now; it marks what a run made ready."""

        return current_processing_version(self._index.current_processing_signature())

    async def process_document(
        self,
        document_id: UUID,
        *,
        tenant_id: UUID,
        progress: IndexProgress | None = None,
    ) -> int:
        """Parse, chunk, contextualize, embed and index one Document's stored original.

        Uploads and connector Items alike. Authorization happened when the run
        was created; this only requires the Document to belong to the tenant
        and its original to be stored. Returns the chunk count. A content
        problem raises ``DocumentProcessingError`` (the Document is failed);
        anything else is infrastructure and raises as is.
        """

        if self._content is None:
            raise RuntimeError(  # noqa: TRY004 - invalid service composition
                "ItemIngestionService needs StoredFileContent to process documents"
            )
        async with advisory_lock_scope(
            self._advisory_lock_key(document_id), engine=self._require_engine()
        ):
            document, collection_id = await self._load_processable(
                document_id, tenant_id=tenant_id
            )
            try:
                # The run has started: parsing is its first step, not a prelude.
                async with transaction_scope(self._session_factory) as session:
                    await ItemService(session).mark_index_processing(document.id)
                if progress is not None:
                    progress("parsing", 0, 0)
                canonical = await self._content.canonicalize(document)
            except Exception:
                async with transaction_scope(self._session_factory) as session:
                    await ItemService(session).mark_index_failed(document.id)
                raise

            await self._persist_preview(document, canonical.item)
            return await self.process_item_content(
                document,
                canonical.item,
                canonical.chunks,
                context=IndexingContext(
                    tenant_id=str(tenant_id),
                    collection_item_id=str(collection_id),
                    parent_item_id=(
                        str(document.parent_item_id) if document.parent_item_id else None
                    ),
                    document_type=document.document_type or "plain_text",
                    connector_key=canonical.item.source.provider.value,
                ),
                processed_version=self.processing_version(),
                progress=progress,
            )

    async def process_item_content(
        self,
        stored: Item,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        context: IndexingContext,
        processed_version: str,
        progress: IndexProgress | None = None,
    ) -> int:
        """Index canonical content through the source-neutral path."""

        try:
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_processing(stored.id)
            if item.id != str(stored.id):
                raise ValueError("canonical item does not match the stored document")
            if any(chunk.item_id != item.id for chunk in chunks):
                raise ValueError("canonical chunk belongs to a different document")

            async with transaction_scope(self._session_factory) as session:
                await CitationService(session).replace_for_item(stored.id, chunks)

            count = await self._index.index_item_content(
                item,
                chunks,
                context=context,
                progress=progress,
            )

            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_ready(
                    stored.id, processed_version=processed_version
                )
            return count
        except Exception:
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_failed(stored.id)
            raise

    async def remove_upload(
        self,
        document_id: UUID,
        *,
        access: AuthContext,
    ) -> None:
        """Tombstone an upload and all of its derived index records."""

        if access.tenant_id is None:
            raise DocumentUnavailableError("an active tenant is required")
        user_id = require_user_identity(access)
        engine = self._require_engine()
        lock_key = self._advisory_lock_key(document_id)
        async with advisory_lock_scope(lock_key, engine=engine):
            async with transaction_scope(self._session_factory) as session:
                items = ItemService(session)
                document = await items.get_owned_upload(
                    document_id,
                    user_id,
                    access.tenant_id,
                    include_deleted=True,
                )
                if document.status == "deleted":
                    return
                await items.mark_index_processing(document.id)

            await self._index.remove_item_content(
                str(document_id),
                tenant_id=str(access.tenant_id),
            )
            async with transaction_scope(self._session_factory) as session:
                items = ItemService(session)
                await CitationService(session).replace_for_item(document_id, ())
                await items.soft_delete_item(document_id, actor=access)

    async def remove_item(self, item_id: UUID, *, actor: AuthContext) -> None:
        """Tombstone an authorized Item and all of its derived content."""

        if actor.tenant_id is None:
            raise DocumentUnavailableError("an active tenant is required")
        async with transaction_scope(self._session_factory) as session:
            items = ItemService(session)
            item = await items.get_item(item_id, access=actor)
            if item.status == "deleted":
                return
            if item.item_type == "document":
                await items.mark_index_processing(item.id)
        await self._index.remove_item_content(
            str(item_id),
            tenant_id=str(actor.tenant_id),
        )
        async with transaction_scope(self._session_factory) as session:
            await CitationService(session).replace_for_item(item_id, ())
            await ItemService(session).soft_delete_item(item_id, actor=actor)

    async def aclose(self) -> None:
        await self._index.aclose()

    # ---- Internals ----

    async def _load_processable(
        self, document_id: UUID, *, tenant_id: UUID
    ) -> tuple[Item, UUID]:
        """The Document with its original, and the Collection that governs it."""

        async with transaction_scope(self._session_factory) as session:
            document = await session.scalar(
                select(Item)
                .options(joinedload(Item.upload))
                .where(
                    Item.id == document_id,
                    Item.tenant_id == tenant_id,
                    Item.item_type == "document",
                    Item.status != "deleted",
                    Item.deleted_at.is_(None),
                )
            )
            if document is None:
                raise DocumentNotFoundError(f"document not found: {document_id}")
            if document.upload is not None and document.upload.status != "available":
                raise DocumentUnavailableError("document content is not available")
            if not document.storage_key:
                raise DocumentUnavailableError("the document has no stored original")
            collection_id = await AuthorizationService(session).governing_collection_id(
                document.id, tenant_id=tenant_id
            )
            if collection_id is None:
                raise DocumentUnavailableError("the document is not in a collection")
            return document, collection_id

    async def _persist_preview(self, stored: Item, content: DocumentItem | None = None) -> None:
        if self._preview is None or not stored.storage_key:
            return
        try:
            manifest = await self._preview.generate(stored, content=content)
            if manifest is None:
                return
            preview_metadata = manifest.model_dump(mode="json")
            if stored.metadata_.get("preview") == preview_metadata:
                return
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).merge_metadata(
                    stored.id,
                    {"preview": preview_metadata},
                )
            stored.metadata_ = {
                **dict(stored.metadata_),
                "preview": preview_metadata,
            }
        except Exception as exc:  # noqa: BLE001 - preview is best effort
            log.warning(
                "item preview generation failed item_id=%s error_type=%s",
                stored.id,
                type(exc).__name__,
            )

    def _require_engine(self) -> AsyncEngine:
        engine = self._session_factory.kw.get("bind")
        if not isinstance(engine, AsyncEngine):
            raise RuntimeError(  # noqa: TRY004 - invalid service composition
                "ItemIngestionService requires an AsyncEngine-bound session"
            )
        return engine

    @staticmethod
    def _advisory_lock_key(document_id: UUID) -> int:
        return int.from_bytes(document_id.bytes[:8], byteorder="big", signed=True)


__all__ = [
    "INTERRUPTED_MESSAGE",
    "ItemIngestionService",
    "PhaseRecorder",
    "failure_message",
]
