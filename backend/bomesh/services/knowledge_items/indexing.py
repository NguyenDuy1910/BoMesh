"""The processing core: turn one stored Document into indexed knowledge.

An Ingestion Run is the only caller of :meth:`ItemIngestionService.process_document`:
uploads and connector Items alike have their original in object storage, and
processing always starts from it. Adding data never comes through here.
It also keeps the access fields of indexed points in step with PostgreSQL
after a move, (un)publish or (un)delete (``payload_dirty_at``).
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import joinedload

from bomesh.connector.protocol import (
    Chunk,
    DocumentItem,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import advisory_lock_scope, transaction_scope
from bomesh.db.models import (
    Contribution,
    ExternalResource,
    IngestionSource,
    Item,
    ItemIndexState,
)
from bomesh.document_index import (
    ClassificationRequest,
    DocumentClassification,
    EmbeddingRejectedError,
    IndexingContext,
    IndexProgress,
    ItemIndex,
    ItemPayloadState,
)
from bomesh.iam.authorizer import item_ancestry
from bomesh.services import (
    DocumentNotFoundError,
    DocumentProcessingError,
    DocumentUnavailableError,
    StoredFileContent,
    current_processing_version,
)
from bomesh.services.knowledge_curation.access import (
    deciding_collection,
    open_new_document_contributions,
)
from bomesh.services.knowledge_curation.topic_assignments import (
    replace_classified_suggestions,
)
from bomesh.services.knowledge_curation.topics import classification_candidates
from bomesh.services.knowledge_items.citations import CitationService
from bomesh.services.knowledge_items.documents import apply_assistant_topics
from bomesh.services.knowledge_items.item_store import ItemService

if TYPE_CHECKING:
    from bomesh.services.ingestion.run_engine import RunClassification

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
    ) -> None:
        self._session_factory = session_factory
        self._index = index
        self._content = content

    def processing_version(self) -> str:
        """The version processing produces now; it marks what a run made ready."""

        return current_processing_version(self._index.current_processing_signature())

    async def classification_request(
        self, tenant_id: UUID, classification: RunClassification | None
    ) -> ClassificationRequest | None:
        """A run's CLASSIFYING candidates, loaded once for all its Documents.

        The run's topics, a DOMAIN standing for itself and its ACTIVE topics;
        none = every ACTIVE topic of the workspace; each with its signals and
        rules. ``None`` without candidates.
        """

        async with transaction_scope(self._session_factory) as session:
            candidates = await classification_candidates(
                session, tenant_id, classification.topics if classification is not None else ()
            )
        if not candidates:
            return None
        return ClassificationRequest(
            candidates=candidates,
            note=classification.note if classification is not None else None,
        )

    async def process_document(
        self,
        document_id: UUID,
        *,
        tenant_id: UUID,
        progress: IndexProgress | None = None,
        classification: ClassificationRequest | None = None,
        read_images: bool = False,
    ) -> int:
        """Parse, chunk, classify, contextualize, embed and index one Document's current revision.

        Uploads and connector Items alike. Authorization happened when the run
        was created; this only requires the Document to belong to the tenant
        and its original to be stored. ``classification`` is the run's
        :meth:`classification_request`; a candidate whose rule matches the
        Document (an ancestor collection, its source) settles its topics. The
        candidate of an open NEW_DOCUMENT contribution matches collection rules
        where it is headed (target, else suggested collection) and its
        classification replaces the contribution's suggested topics and summary.
        ``read_images`` is the run's ``readImages``: the vision model reads the
        text inside the Document's pictures.
        The index (and what CLASSIFYING chose) is recorded only if the
        revision and governing collection did not change meanwhile; otherwise
        the Document waits for another run and its payload is re-applied.
        Returns the chunk count. A content problem raises
        ``DocumentProcessingError`` (the Document is failed); anything else is
        infrastructure and raises as is.
        """

        if self._content is None:
            raise RuntimeError(  # noqa: TRY004 - invalid service composition
                "ItemIngestionService needs StoredFileContent to process documents"
            )
        async with advisory_lock_scope(
            self._advisory_lock_key(document_id), engine=self._require_engine()
        ):
            started = await self._load_processable(document_id, tenant_id=tenant_id)
            document = started.document
            try:
                # The run has started: parsing is its first step, not a prelude.
                async with transaction_scope(self._session_factory) as session:
                    await ItemService(session).mark_index_processing(document.id)
                if progress is not None:
                    progress("parsing", 0, 0)
                canonical = await self._content.canonicalize(
                    document, source=started.source, read_images=read_images
                )
            except Exception:
                await self._record_failure(document.id)
                raise

            return await self.process_item_content(
                document,
                canonical.item,
                canonical.chunks,
                context=IndexingContext(
                    tenant_id=str(tenant_id),
                    collection_item_id=str(started.collection_id),
                    parent_item_id=(
                        str(document.parent_item_id) if document.parent_item_id else None
                    ),
                    connector_key=canonical.item.source.provider.value,
                    published=bool(document.is_published),
                ),
                processed_version=self.processing_version(),
                revision_number=started.revision_number,
                classification=(
                    classification.for_document(
                        started.ancestor_ids, started.source_code
                    )
                    if classification is not None
                    else None
                ),
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
        revision_number: int | None = None,
        classification: ClassificationRequest | None = None,
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
                if await _live_for_update(session, stored.id):
                    # A deleted document keeps its tombstoned citations.
                    await CitationService(session).replace_for_item(stored.id, chunks)

            count, classified = await self._index.index_item_content(
                item,
                chunks,
                context=context,
                classification=classification,
                progress=progress,
            )

            async with transaction_scope(self._session_factory) as session:
                await self._record_indexed(
                    session,
                    stored.id,
                    context=context,
                    processed_version=processed_version,
                    revision_number=revision_number,
                    classified=classified,
                )
            return count
        except Exception:
            await self._record_failure(stored.id)
            raise

    # ---- Index payloads (item_model.md §4.10) ----

    async def sync_payloads(self, item_ids: Iterable[UUID]) -> int:
        """Re-apply the payload of dirty items after their transaction committed.

        Each item's ``payload_dirty_at`` is cleared only if no newer change
        marked it again meanwhile; a failure leaves it dirty for
        :meth:`reconcile_dirty_payloads`. Returns how many items were cleaned.
        """

        cleaned = 0
        for item_id in dict.fromkeys(item_ids):
            try:
                cleaned += await self._sync_payload(item_id)
            except Exception as exc:  # noqa: BLE001 - the scheduled retry converges
                log.warning(
                    "index payload update failed item_id=%s error_type=%s",
                    item_id,
                    type(exc).__name__,
                )
        return cleaned

    async def reconcile_dirty_payloads(self, *, limit: int = 500) -> int:
        """Retry every item still marked dirty, oldest first (the scheduled job)."""

        async with transaction_scope(self._session_factory) as session:
            dirty = list(
                await session.scalars(
                    select(ItemIndexState.item_id)
                    .where(ItemIndexState.payload_dirty_at.is_not(None))
                    .order_by(ItemIndexState.payload_dirty_at)
                    .limit(limit)
                )
            )
        return await self.sync_payloads(dirty)

    async def _sync_payload(self, item_id: UUID) -> int:
        async with transaction_scope(self._session_factory) as session:
            index_state = await session.get(ItemIndexState, item_id)
            item = await session.get(Item, item_id)
            if item is None or index_state is None or index_state.payload_dirty_at is None:
                return 0
            marked = index_state.payload_dirty_at
            path = await item_ancestry(session, item.id)
            state = None
            if item.item_kind == "document":
                collection_id = next(
                    (node.item_id for node in path if node.item_kind == "collection"), None
                )
                if collection_id is not None:
                    state = ItemPayloadState(
                        collection_item_id=str(collection_id),
                        published=bool(item.is_published),
                        is_deleted=any(node.deleted_at is not None for node in path),
                    )
            tenant_id = str(item.tenant_id)
            reindex = False
        if state is not None:
            await self._index.apply_item_payload(str(item_id), tenant_id=tenant_id, state=state)
            reindex = (
                not state.is_deleted
                and index_state.index_status == "ready"
                and await self._index.count_item_content(str(item_id), tenant_id=tenant_id)
                == 0
            )
        async with transaction_scope(self._session_factory) as session:
            values: dict[str, Any] = {"payload_dirty_at": None}
            if reindex:
                # The points were purged: undelete restores search by a new run.
                values["index_status"] = "pending"
            result = await session.execute(
                update(ItemIndexState)
                .where(ItemIndexState.item_id == item_id, ItemIndexState.payload_dirty_at == marked)
                .values(**values)
            )
        return int(result.rowcount or 0)

    async def aclose(self) -> None:
        await self._index.aclose()

    # ---- Internals ----

    async def _load_processable(
        self, document_id: UUID, *, tenant_id: UUID
    ) -> _ProcessingStart:
        """The Document with its original, its current revision and governing Collection."""

        async with transaction_scope(self._session_factory) as session:
            document = await session.scalar(
                select(Item)
                .options(joinedload(Item.upload))
                .where(
                    Item.id == document_id,
                    Item.tenant_id == tenant_id,
                    Item.item_kind == "document",
                    Item.deleted_at.is_(None),
                )
            )
            if document is None:
                raise DocumentNotFoundError(f"document not found: {document_id}")
            if document.upload is not None and document.upload.status != "available":
                raise DocumentUnavailableError("document content is not available")
            if document.current_revision_id is None:
                raise DocumentUnavailableError("the document has no stored original")
            path = await item_ancestry(session, document.id)
            collection_id = next(
                (node.item_id for node in path if node.item_kind == "collection"), None
            )
            if collection_id is None:
                raise DocumentUnavailableError("the document is not in a collection")
            revision = await ItemService(session).current_revision(document.id)
            # The candidate of an open NEW_DOCUMENT contribution is classified
            # where it is headed, not in the contributor's PERSONAL collection.
            contribution = (
                await open_new_document_contributions(session, tenant_id, [document.id])
            ).get(document.id)
            decision = deciding_collection(contribution) if contribution is not None else None
            placement = (
                await item_ancestry(session, decision) if decision is not None else path[1:]
            )
            source, source_code = await _provider_identity(session, document.id)
            return _ProcessingStart(
                document=document,
                collection_id=collection_id,
                revision_number=revision.revision_number if revision is not None else None,
                ancestor_ids=tuple(str(node.item_id) for node in placement),
                source=source,
                source_code=source_code,
            )

    @staticmethod
    async def _record_indexed(
        session: AsyncSession,
        item_id: UUID,
        *,
        context: IndexingContext,
        processed_version: str,
        revision_number: int | None,
        classified: DocumentClassification | None = None,
    ) -> None:
        """Mark the index current and apply the classified topics (and an open
        NEW_DOCUMENT contribution's suggestions), unless the content or
        placement moved on meanwhile."""

        item = await session.get(Item, item_id, with_for_update=True, populate_existing=True)
        if item is None:
            return
        items = ItemService(session)
        if item.deleted_at is not None:
            # Deleted while indexing: the points just written are live; the
            # payload sync tombstones them.
            await items.mark_payload_dirty((item_id,), func.now())
            return
        current = await items.current_revision(item_id)
        unchanged = (
            (current.revision_number if current is not None else None) == revision_number
            and str(await _governing_collection(session, item_id)) == context.collection_item_id
        )
        if not unchanged:
            await items.set_index_state((item,), index_status="pending")
            await items.mark_payload_dirty((item_id,), func.now())
            return
        await items.mark_index_ready(
            item_id,
            processed_version=processed_version,
            indexed_revision_number=revision_number,
        )
        if classified is not None:
            await apply_assistant_topics(
                session, item_id, [UUID(topic.id) for topic in classified.topics]
            )
            contribution = (
                await open_new_document_contributions(session, item.tenant_id, [item_id])
            ).get(item_id)
            if contribution is not None:
                await replace_classified_suggestions(
                    session,
                    contribution,
                    [UUID(topic.id) for topic in classified.topics],
                    classified.summary,
                    classified.title,
                )
        if bool(item.is_published) != context.published:
            await items.mark_payload_dirty((item_id,), func.now())

    async def _record_failure(self, item_id: UUID) -> None:
        """A run failed: the document is FAILED; deleted meanwhile, its points are re-tombstoned."""

        async with transaction_scope(self._session_factory) as session:
            item = await session.get(Item, item_id, with_for_update=True, populate_existing=True)
            if item is None:
                return
            items = ItemService(session)
            await items.set_index_state((item,), index_status="failed")
            if item.deleted_at is not None:
                await items.mark_payload_dirty((item_id,), func.now())

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


@dataclass(frozen=True, slots=True)
class _ProcessingStart:
    """What a run processes: the Document as it was when processing started."""

    document: Item
    collection_id: UUID
    revision_number: int | None
    #: CLASSIFYING's collection rules match these Item IDs: the Document's
    #: ancestors, or for an open NEW_DOCUMENT contribution's candidate its
    #: deciding collection and that collection's ancestors.
    ancestor_ids: tuple[str, ...]
    #: The provider identity of a synced Document and its Source's code
    #: (CLASSIFYING's source rules); ``None`` for an upload.
    source: SourceIdentity | None
    source_code: str | None


async def _provider_identity(
    session: AsyncSession, document_id: UUID
) -> tuple[SourceIdentity | None, str | None]:
    """The ``external_resources`` identity of a synced Document, a live one first.

    A Source's NEW_REVISION candidate has none of its own: it carries the
    identity of the Document it would replace.
    """
    replaced = (
        select(Contribution.replaces_item_id)
        .where(
            Contribution.item_id == document_id,
            Contribution.ingestion_source_id.is_not(None),
            Contribution.replaces_item_id.is_not(None),
        )
        .limit(1)
        .scalar_subquery()
    )
    row = (
        await session.execute(
            select(ExternalResource, IngestionSource.code)
            .join(IngestionSource, IngestionSource.id == ExternalResource.ingestion_source_id)
            .where(
                (ExternalResource.item_id == document_id) | (ExternalResource.item_id == replaced)
            )
            .order_by(
                (ExternalResource.item_id == document_id).desc(),
                ExternalResource.deleted_at.desc().nulls_first(),
            )
            .limit(1)
        )
    ).first()
    if row is None:
        return None, None
    resource, code = row
    data = resource.provider_data
    try:
        identity = SourceIdentity(
            connector_id=str(data.get("connector_id") or ""),
            provider=SourceProvider(str(data.get("provider") or "")),
            external_id=resource.external_id,
            external_version=resource.external_version,
            etag=resource.etag,
            url=resource.source_url,
        )
    except ValueError as exc:
        raise DocumentProcessingError("the document's source identity is invalid") from exc
    return identity, code


async def _live_for_update(session: AsyncSession, item_id: UUID) -> bool:
    item = await session.get(Item, item_id, with_for_update=True, populate_existing=True)
    return item is not None and item.deleted_at is None


async def _governing_collection(session: AsyncSession, item_id: UUID) -> UUID | None:
    return next(
        (
            node.item_id
            for node in await item_ancestry(session, item_id)
            if node.item_kind == "collection"
        ),
        None,
    )


async def sync_item_payloads(
    sessions: async_sessionmaker[AsyncSession], index: ItemIndex, item_ids: Iterable[UUID]
) -> int:
    """Re-apply index payloads after the transaction that marked them dirty committed."""
    return await ItemIngestionService(sessions, index=index).sync_payloads(item_ids)


async def reconcile_dirty_payloads(
    sessions: async_sessionmaker[AsyncSession], index: ItemIndex, *, limit: int = 500
) -> int:
    """Retry every item whose index payload update did not land; returns rows cleaned."""
    return await ItemIngestionService(sessions, index=index).reconcile_dirty_payloads(limit=limit)


__all__ = [
    "INTERRUPTED_MESSAGE",
    "ItemIngestionService",
    "PhaseRecorder",
    "failure_message",
    "reconcile_dirty_payloads",
    "sync_item_payloads",
]
