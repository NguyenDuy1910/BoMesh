"""The shared ingestion core: ingest, refresh, and remove Item content.

Every way content enters the system ends here — a connector Source sync, a
Document indexed by managed (Temporal) ingestion, or a user's own upload run
directly by ``DocumentService``. Runners orchestrate; this module processes.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import joinedload

from bothesis.db.engine import advisory_lock_scope, transaction_scope
from bothesis.connector.protocol import (
    AnyItem,
    Chunk,
    CollectionItem,
    DocumentItem,
    DocumentKind,
)
from bothesis.db.models import ExternalResource, IngestionSource, Item
from bothesis.document_index import IndexingContext, IndexProgress, ItemIndex
from bothesis.services.citation import CitationService
from bothesis.services.item import ItemService
from bothesis.services import (
    CHUNKER_VERSION,
    PARSER_VERSION,
    AuthContext,
    StoredFileContent,
    DocumentProcessingError,
    DocumentUnavailableError,
    require_user_identity,
)
from bothesis.services.preview import KnowledgePreview

log = logging.getLogger(__name__)

#: How often a running upload's phases are written to its Ingestion record.
_PHASE_PERSIST_SECONDS = 1.0
INTERRUPTED_MESSAGE = "Processing was interrupted before it finished."


class PhaseRecorder:
    """Where one ingestion run is in the pipeline; an ``IndexProgress`` observer.

    Each call is ``(phase, done, total)``; a new phase closes the previous one.
    It is runner-agnostic: the managed Activity heartbeats :meth:`snapshot`,
    and :meth:`ItemIngestionService.index_upload` keeps :attr:`phases` on the
    Document's Ingestion record, so both runners report the same way.
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
        """End the phase in flight; only a run that succeeded finished its work."""

        self._finish(datetime.now(UTC).isoformat(), completed=completed)
        self.version += 1
        return self.phases

    def snapshot(self) -> dict[str, Any]:
        current = self.phases[-1] if self.phases else None
        return {
            "phase": current["phase"] if current else "queued",
            "done": current["done"] if current else 0,
            "total": current["total"] if current else 0,
            "phases": self.phases,
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

    if not isinstance(exc, DocumentProcessingError):
        return INTERRUPTED_MESSAGE
    text = str(exc).strip() or "The document could not be processed"
    text = text[0].upper() + text[1:]
    return text if text.endswith((".", "!", "?")) else f"{text}."


def progress_from_phases(phases: Sequence[Mapping[str, Any]], *, status: str) -> dict[str, Any]:
    """The Ingestion ``progress`` a run's recorded phases describe.

    Running: the phase in flight with its counts. Finished: what the run got
    through — chunks (or archive files) found, processed and stored.
    """

    def counts(phase: str, discovered: int = 0, processed: int = 0, indexed: int = 0) -> dict[str, Any]:
        return {
            "phase": phase,
            "discovered_count": discovered,
            "processed_count": processed,
            "indexed_count": indexed,
            "deleted_count": 0,
            "failed_count": 0,
        }

    if status == "pending" or (status == "running" and not phases):
        return counts("queued")
    if status == "running":
        current = phases[-1]
        done, total = int(current.get("done") or 0), int(current.get("total") or 0)
        phase = str(current.get("phase"))
        return counts(phase, total, done, done if phase == "storing" else 0)
    by_phase = {phase.get("phase"): phase for phase in phases}
    found = by_phase.get("contextualizing") or by_phase.get("embedding") or by_phase.get("expanding") or {}
    processed = by_phase.get("embedding") or by_phase.get("expanding") or {}
    stored = by_phase.get("storing") or {}
    return counts(
        "failed" if status == "timed_out" else status,
        int(found.get("total") or 0),
        int(processed.get("done") or 0),
        int(stored.get("done") or 0),
    )


class ItemIngestionService:
    """Ingest, refresh, and remove Item content for uploads and connectors.

    Owns Item index-status transitions and citation persistence around indexing;
    the actual indexing/search/removal work is delegated to the injected
    ItemIndex. Implements ConnectorIndexSink (write_item/write/soft_delete_item)
    directly so it can be handed straight to a ConnectorPipeline as its sink.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        ingestion_source_id: UUID | None = None,
        preview: KnowledgePreview | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._index = index
        self._ingestion_source_id = ingestion_source_id
        self._preview = preview

    async def index_upload(
        self,
        document_id: UUID,
        *,
        owner_user_id: UUID,
        tenant_id: UUID,
        source: StoredFileContent,
        progress: PhaseRecorder | None = None,
    ) -> Item:
        """Parse, chunk, contextualize, embed and index one stored upload.

        The one indexing entry point for stored uploads, whichever runner
        calls it: the managed ingestion Activity, or ``DocumentService``
        running a user's own upload directly. It verifies the immutable upload
        owner and tenant; callers authorize before they get here. The run's
        phases and a user-safe failure reason are kept on the Document's
        Ingestion record as it goes.
        """

        recorder = progress if progress is not None else PhaseRecorder()
        access = AuthContext(
            user_id=owner_user_id,
            email="ingestion@bothesis.internal",
            display_name=None,
            tenant_id=tenant_id,
            permission_codes=(),
            group_ids=(),
        )
        persisting = asyncio.create_task(self._persist_phases(document_id, recorder))
        error: str | None = None
        try:
            async with advisory_lock_scope(
                self._advisory_lock_key(document_id), engine=self._require_engine()
            ):
                document = await self._index_upload_under_lock(
                    document_id,
                    owner_user_id=owner_user_id,
                    tenant_id=tenant_id,
                    access=access,
                    source=source,
                    progress=recorder,
                )
            recorder.close(completed=True)
            return document
        except asyncio.CancelledError:
            recorder.close()
            raise
        except Exception as exc:
            recorder.close()
            error = failure_message(exc)
            raise
        finally:
            persisting.cancel()
            with suppress(asyncio.CancelledError):
                await persisting
            with suppress(Exception):
                await self._update_record(document_id, phases=recorder.phases, error=error)

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

    # ---- Connector-facing (ConnectorIndexSink) ----

    async def write_item(
        self,
        item: AnyItem,
        *,
        tenant_id: str,
        connector_id: str | int,
    ) -> UUID:
        self._validate_source(
            item,
            tenant_id=tenant_id,
            integration_connection_id=connector_id,
        )
        stored, _, _ = await self._persist_item(item)
        return stored.id

    async def write(
        self,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        tenant_id: str,
        connector_id: str | int,
    ) -> int:
        normalized_tenant = self._validate_source(
            item, tenant_id=tenant_id, integration_connection_id=connector_id
        )
        stored, source, _ = await self._persist_item(item)
        await self._persist_preview(stored)
        canonical_item, canonical_chunks = self._canonical_document(
            item,
            chunks,
            stored,
        )
        return await self.process_item_content(
            stored,
            canonical_item,
            canonical_chunks,
            context=IndexingContext(
                tenant_id=normalized_tenant,
                collection_item_id=str(source.target_item_id),
                parent_item_id=(
                    str(stored.parent_item_id) if stored.parent_item_id else None
                ),
                document_type=stored.document_type or "plain_text",
                connector_key=source.integration_connection.connector_key,
            ),
        )

    async def soft_delete_item(
        self,
        *,
        tenant_id: str,
        connector_id: str | int,
        item_id: str,
    ) -> None:
        if not tenant_id.strip():
            raise ValueError("tenant_id must not be blank")
        async with transaction_scope(self._session_factory) as session:
            source = await session.scalar(
                select(IngestionSource)
                .options(joinedload(IngestionSource.integration_connection))
                .where(IngestionSource.id == self._ingestion_source_id)
            )
            if source is None or str(source.integration_connection_id) != str(
                connector_id
            ):
                raise ValueError(
                    "ingestion source connection does not match the delete request"
                )
            stored = await ItemService(session).soft_delete_external_resource(
                source.id,
                item_id,
            )
            canonical_id = stored.id if stored is not None else None
            if canonical_id is not None:
                await CitationService(session).replace_for_item(canonical_id, ())
        if canonical_id is not None:
            await self._index.remove_item_content(
                str(canonical_id),
                tenant_id=tenant_id.strip(),
            )

    # ---- Shared core ----

    async def process_item_content(
        self,
        stored: Item,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        context: IndexingContext,
        processing_metadata: Mapping[str, Any] | None = None,
        progress: IndexProgress | None = None,
    ) -> int:
        """Index canonical connector output through the source-neutral path."""

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
                items = ItemService(session)
                if processing_metadata is not None:
                    await items.merge_metadata(
                        stored.id,
                        {"processing": dict(processing_metadata)},
                    )
                await items.mark_index_ready(stored.id)
            return count
        except Exception:
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_failed(stored.id)
            raise

    async def aclose(self) -> None:
        await self._index.aclose()

    # ---- Upload-flow internals ----

    async def _index_upload_under_lock(
        self,
        document_id: UUID,
        *,
        owner_user_id: UUID,
        tenant_id: UUID,
        access: AuthContext,
        source: StoredFileContent,
        progress: IndexProgress | None = None,
    ) -> Item:
        document = await self._load_owned_available_upload(
            document_id,
            owner_user_id=owner_user_id,
            tenant_id=tenant_id,
        )
        await self._index_loaded_upload(
            document,
            access=access,
            tenant_id=tenant_id,
            source=source,
            progress=progress,
        )
        return await self._load_owned_available_upload(
            document_id,
            owner_user_id=owner_user_id,
            tenant_id=tenant_id,
        )

    async def _persist_phases(self, document_id: UUID, recorder: PhaseRecorder) -> None:
        seen = recorder.version
        while True:
            await asyncio.sleep(_PHASE_PERSIST_SECONDS)
            if recorder.version != seen:
                seen = recorder.version
                with suppress(Exception):
                    await self._update_record(document_id, phases=recorder.phases)

    async def _update_record(self, document_id: UUID, **fields: Any) -> None:
        async with transaction_scope(self._session_factory) as session:
            await ItemService(session).update_ingestion_record(document_id, **fields)

    async def _index_loaded_upload(
        self,
        document: Item,
        *,
        access: AuthContext,
        tenant_id: UUID,
        source: StoredFileContent,
        progress: IndexProgress | None = None,
    ) -> None:
        if self._index_is_current(document):
            return
        try:
            # The run has started: parsing is its first step, not a prelude.
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_processing(document.id)
            if progress is not None:
                progress("parsing", 0, 0)
            canonical = await source.canonicalize(document, access=access)
        except Exception as exc:
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_failed(document.id)
            if isinstance(exc, DocumentProcessingError):
                raise
            raise DocumentProcessingError("document canonicalization failed") from exc

        await self._persist_preview(document)
        await self.process_item_content(
            document,
            canonical.item,
            canonical.chunks,
            context=IndexingContext(
                tenant_id=str(tenant_id),
                collection_item_id=str(document.parent_item_id),
                parent_item_id=str(document.parent_item_id),
                document_type=document.document_type or "plain_text",
                connector_key="file",
            ),
            processing_metadata=self._upload_processing_metadata(document),
            progress=progress,
        )

    async def _load_owned_available_upload(
        self,
        document_id: UUID,
        *,
        owner_user_id: UUID,
        tenant_id: UUID,
    ) -> Item:
        async with transaction_scope(self._session_factory) as session:
            document = await ItemService(session).get_owned_upload(
                document_id,
                owner_user_id,
                tenant_id,
            )
            assert document.upload is not None
            if document.upload.status != "available":
                raise DocumentUnavailableError("document content is not available")
            return document

    def _index_is_current(self, document: Item) -> bool:
        processing = document.metadata_.get("processing")
        if not isinstance(processing, Mapping):
            return False
        signature = self._index.current_processing_signature()
        return (
            document.index_status == "ready"
            and processing.get("provider_version") == self._provider_version(document)
            and processing.get("parser_version") == PARSER_VERSION
            and processing.get("chunker_version") == CHUNKER_VERSION
            and processing.get("embedding_model") == signature["embedding_model"]
            and processing.get("index_schema_version")
            == signature["index_schema_version"]
            and processing.get("contextualization_enabled")
            == signature["contextualization_enabled"]
            and processing.get("contextualization_model")
            == signature["contextualization_model"]
        )

    def _upload_processing_metadata(self, document: Item) -> dict[str, Any]:
        return {
            "provider_version": self._provider_version(document),
            "parser_version": PARSER_VERSION,
            "chunker_version": CHUNKER_VERSION,
            **self._index.current_processing_signature(),
        }

    @staticmethod
    def _provider_version(document: Item) -> str:
        metadata = document.metadata_
        for key in ("provider_version", "version_id", "etag"):
            value = metadata.get(key)
            if isinstance(value, str) and value:
                return value
        storage = metadata.get("storage")
        if isinstance(storage, Mapping):
            for key in ("provider_version", "version_id", "etag"):
                value = storage.get(key)
                if isinstance(value, str) and value:
                    return value
        updated_at = getattr(document, "updated_at", None)
        timestamp = updated_at.isoformat() if updated_at else "initial"
        return f"native:{document.id}:{timestamp}"

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

    # ---- Connector-flow internals ----

    async def _persist_item(
        self, item: AnyItem
    ) -> tuple[Item, IngestionSource, ExternalResource]:
        original = item.original if isinstance(item, DocumentItem) else None
        metadata = {
            **{
                key: value
                for key, value in item.metadata.items()
                if key not in {"preview", "processing", "storage"}
            },
            "source": item.source.model_dump(mode="json", exclude_none=True),
            "external_hierarchy": item.hierarchy.model_dump(
                mode="json", exclude_none=True
            ),
        }
        if original is not None:
            metadata["storage"] = original.model_dump(mode="json", exclude_none=True)
        async with transaction_scope(self._session_factory) as session:
            source = await session.scalar(
                select(IngestionSource)
                .options(
                    joinedload(IngestionSource.integration_connection),
                    joinedload(IngestionSource.target_item),
                )
                .where(IngestionSource.id == self._ingestion_source_id)
            )
            if source is None:
                raise ValueError(
                    f"ingestion source not found: {self._ingestion_source_id}"
                )
            stored = await ItemService(session).upsert_ingested_item(
                source.id,
                item.source.external_id,
                canonical_external_id=item.id,
                item_type=item.type,
                title=item.title,
                document_type=(
                    self._document_type(
                        item, source.integration_connection.connector_key
                    )
                    if isinstance(item, DocumentItem)
                    else None
                ),
                parent_external_id=item.hierarchy.parent_id,
                parent_relation=self._parent_relation(item),
                source_url=item.source.url,
                external_version=item.source.external_version,
                etag=item.source.etag,
                external_updated_at=item.updated_at,
                mime_type=(
                    original.content_type
                    if original is not None
                    else self._mime_type(item)
                ),
                size_bytes=original.size_bytes if original is not None else None,
                metadata=metadata,
                storage_key=original.key if original is not None else None,
                status="ready",
            )
            external_resource = await session.scalar(
                select(ExternalResource).where(
                    ExternalResource.ingestion_source_id == source.id,
                    ExternalResource.external_id == item.source.external_id,
                )
            )
            if external_resource is None:
                raise RuntimeError("external resource was not stored")
            session.expunge(stored)
            session.expunge(source)
            session.expunge(external_resource)
            return stored, source, external_resource

    async def _persist_preview(self, stored: Item) -> None:
        if self._preview is None or not stored.storage_key:
            return
        try:
            manifest = await self._preview.generate(stored)
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

    @staticmethod
    def _canonical_document(
        item: DocumentItem, chunks: Sequence[Chunk], stored: Item
    ) -> tuple[DocumentItem, tuple[Chunk, ...]]:
        canonical_id = str(stored.id)
        hierarchy = item.hierarchy.model_copy(
            update={
                "parent_id": str(stored.parent_item_id)
                if stored.parent_item_id
                else None,
                "root_id": None,
                "ancestor_ids": [],
            }
        )
        canonical_item = item.model_copy(
            update={"id": canonical_id, "hierarchy": hierarchy}
        )
        canonical_chunks = tuple(
            chunk.model_copy(
                update={
                    "id": f"{canonical_id}:{chunk.chunk_index}",
                    "item_id": canonical_id,
                }
            )
            for chunk in chunks
        )
        return canonical_item, canonical_chunks

    @staticmethod
    def _validate_source(
        item: AnyItem, *, tenant_id: str, integration_connection_id: str | int
    ) -> str:
        normalized_tenant = tenant_id.strip()
        if not normalized_tenant:
            raise ValueError("tenant_id must not be blank")
        if str(item.source.connector_id) != str(integration_connection_id):
            raise ValueError(
                "item source integration connection does not match the index request"
            )
        return normalized_tenant

    @staticmethod
    def _document_type(item: DocumentItem, connector_key: str) -> str:
        if item.document_kind == DocumentKind.PAGE:
            return "confluence_page" if connector_key == "confluence" else "web_page"
        return {
            DocumentKind.PDF: "pdf",
            DocumentKind.DOCUMENT: "word_document",
            DocumentKind.IMAGE: "image",
            DocumentKind.ISSUE: "jira_issue",
            DocumentKind.MESSAGE: "plain_text",
            DocumentKind.EMAIL: "email",
            DocumentKind.NOTE: "plain_text",
            DocumentKind.WEB_PAGE: "web_page",
            DocumentKind.RECORD: "plain_text",
        }.get(item.document_kind, "plain_text")

    @staticmethod
    def _mime_type(item: DocumentItem) -> str | None:
        if item.document_kind == DocumentKind.PDF:
            return "application/pdf"
        if item.document_kind == DocumentKind.IMAGE:
            return "image/*"
        if item.document_kind in {DocumentKind.PAGE, DocumentKind.WEB_PAGE}:
            return "text/html"
        return None

    @staticmethod
    def _parent_relation(item: AnyItem) -> str:
        relation = item.metadata.get("parent_relation")
        if isinstance(relation, str) and relation in {
            "contains",
            "child",
            "attachment",
            "embedded",
        }:
            return relation
        if isinstance(item, CollectionItem):
            return "contains"
        if item.metadata.get("attachment_id") or item.metadata.get("file_name"):
            return "attachment"
        return "child"


__all__ = [
    "INTERRUPTED_MESSAGE",
    "ItemIngestionService",
    "PhaseRecorder",
    "failure_message",
    "progress_from_phases",
]
