"""The processing core: turn one stored Document into indexed knowledge.

An Ingestion Run is the only caller of :meth:`ItemIngestionService.process_document`:
uploads and connector Items alike have their original in object storage, and
processing always starts from it. Adding data never comes through here.
It also keeps the access fields of indexed points in step with PostgreSQL
after a move, (un)publish or (un)delete (``payload_dirty_at``).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any
from uuid import UUID

from docling_core.types.doc import DoclingDocument
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import joinedload

from bomesh.connector.processing import (
    ChunkStrategy,
    DoclingChunker,
    DoclingChunkingError,
)
from bomesh.connector.processing.highlights import (
    AlignedLocator,
    Locator,
    PageLocator,
    PdfTextLayer,
    SheetLocator,
)
from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import advisory_lock_scope, transaction_scope
from bomesh.db.models import (
    Contribution,
    ExternalResource,
    Item,
    ItemIndexState,
    ItemRevision,
    Tenant,
)
from bomesh.document_index import (
    ClassificationCache,
    DocumentClassification,
    EmbeddingRejectedError,
    IndexingContext,
    IndexProgress,
    ItemIndex,
    ItemPayloadState,
)
from bomesh.document_structure import StructureManifest, StructureRef
from bomesh.iam.authorizer import item_ancestry
from bomesh.services import (
    DocumentNotFoundError,
    DocumentProcessingError,
    DocumentUnavailableError,
    current_processing_version,
)
from bomesh.services.knowledge_curation.access import (
    deciding_collection,
    open_new_document_contributions,
)
from bomesh.services.knowledge_items.classification_answers import StoredClassifications
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.original_parser import (
    OriginalParser,
    parsed_as_pdf,
    parsed_file_name,
)
from bomesh.services.knowledge_items.structure_store import (
    ParsedStructure,
    StructureStore,
    StructureUnavailable,
)
from bomesh.services.previews.engine import revision_file_name
from bomesh.services.previews.formats import Producer, classify
from bomesh.services.taxonomy.assignments import replace_machine_assignments
from bomesh.services.taxonomy.classification import (
    ClassificationOptions,
    ClassificationPlan,
    PreparedDocument,
    Signals,
    decide,
    document_input,
    load_plan,
    prepare,
)
from bomesh.services.taxonomy.profiles import write_extracted_profile

if TYPE_CHECKING:
    from bomesh.services.ingestion.run_engine import RunClassification

log = logging.getLogger(__name__)

INTERRUPTED_MESSAGE = "Processing was interrupted before it finished."
#: Formats whose lines are the units: chunked line by line.
_LINE_EXTENSIONS = frozenset({".jsonl", ".log", ".sql", ".tsv"})
#: The parsing kind of a Document, from its file class (``items.item_type``).
_KIND_BY_ITEM_TYPE = {
    "pdf": DocumentKind.PDF,
    "image": DocumentKind.IMAGE,
    "html": DocumentKind.WEB_PAGE,
}


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

    Owns the Document's index-status transitions around indexing; the
    Structured Document is the injected ``StructureStore``'s and indexing
    itself the injected ``ItemIndex``'s.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        structures: StructureStore | None = None,
        pdfs: OriginalParser | None = None,
        chunker: DoclingChunker | None = None,
        classifications: StoredClassifications | None = None,
        signals: Signals | None = None,
    ) -> None:
        """``pdfs`` reads the PDF a document's Original preview shows, where its
        citations' boxes are found; without it, only sheet ranges and the boxes
        Docling recorded are located. ``signals`` adds the concept-card and kNN
        candidate signals to CLASSIFYING; without it, candidates come from
        lexical matches, rules and priors only."""
        self._session_factory = session_factory
        self._index = index
        self._structures = structures
        self._pdfs = pdfs
        self._chunker = chunker or DoclingChunker()
        #: Where classification answers are kept for reuse; ``None`` asks every time.
        self._classifications = classifications
        self._signals = signals

    def processing_version(self) -> str:
        """The version processing produces now; it marks what a run made ready."""

        return current_processing_version(self._index.current_processing_signature())

    async def classification_plan(
        self, tenant_id: UUID, classification: RunClassification | None
    ) -> ClassificationPlan | None:
        """A run's CLASSIFYING plan, built once for all its Documents.

        The tenant's published classification schemes in the run's scope, its
        rules and the shared prompt prefix; ``None`` when no published
        classification scheme is in scope (nothing is classified).
        """

        options = (
            ClassificationOptions(
                concepts=tuple(UUID(value) for value in classification.concepts),
                note=classification.note,
                rerank={
                    code: tuple(UUID(value) for value in ids)
                    for code, ids in classification.rerank.items()
                },
                schemes=tuple(classification.schemes),
                suggest_only=classification.suggest_only,
            )
            if classification is not None
            else None
        )
        async with transaction_scope(self._session_factory) as session:
            workspace_code = await session.scalar(select(Tenant.code).where(Tenant.id == tenant_id))
            if workspace_code is None:
                return None
            return await load_plan(session, tenant_id, options, workspace_code=workspace_code)

    async def process_document(
        self,
        document_id: UUID,
        *,
        tenant_id: UUID,
        progress: IndexProgress | None = None,
        plan: ClassificationPlan | None = None,
        read_images: bool = False,
    ) -> int:
        """Chunk, classify, contextualize, embed and index one Document's current revision.

        The revision's Structured Document is parsed first when it has none for
        the current parse profile (:meth:`StructureStore.ensure`); its chunks
        point at its blocks.

        Uploads and connector Items alike. Authorization happened when the run
        was created; this only requires the Document to belong to the tenant
        and its original to be stored. ``plan`` is the run's
        :meth:`classification_plan`: the Document is prepared against it after
        chunking (rules match its collections and source; the candidate of an
        open NEW_DOCUMENT contribution matches where it is headed), the model
        answers inside indexing, and the labels, outcomes and profile are
        written with the index state. ``read_images`` is the run's
        ``readImages``: the vision model reads the text inside the Document's
        pictures.
        The index (and what CLASSIFYING chose) is recorded only if the
        revision and governing collection did not change meanwhile; otherwise
        the Document waits for another run and its payload is re-applied.
        Returns the chunk count. A content problem raises
        ``DocumentProcessingError`` (the Document is failed); anything else is
        infrastructure and raises as is.
        """

        if self._structures is None:
            raise RuntimeError(  # noqa: TRY004 - invalid service composition
                "ItemIngestionService needs a StructureStore to process documents"
            )
        async with advisory_lock_scope(
            self._advisory_lock_key(document_id), engine=self._require_engine()
        ):
            started = await self._load_processable(document_id, tenant_id=tenant_id)
            document = started.document
            revision = started.revision
            try:
                # The run has started: parsing is its first step, not a prelude.
                async with transaction_scope(self._session_factory) as session:
                    await ItemService(session).mark_index_processing(document.id)
                if progress is not None:
                    progress("parsing", 0, 0)
                structure = await self._structures.ensure(
                    document, revision=revision, read_images=read_images
                )
                async with self._locating(document, revision, structure.document) as locator:
                    chunks = await asyncio.to_thread(
                        self._chunk,
                        structure.document,
                        document=document,
                        revision=revision,
                        locator=locator,
                    )
            except Exception:
                await self._record_failure(document.id)
                raise

            item = _envelope(document, revision, source=started.source)
            return await self.process_item_content(
                document,
                item,
                chunks,
                context=IndexingContext(
                    tenant_id=str(tenant_id),
                    collection_item_id=str(started.collection_id),
                    parent_item_id=(
                        str(document.parent_item_id) if document.parent_item_id else None
                    ),
                    connector_key=item.source.provider.value,
                    published=bool(document.is_published),
                    revision_number=revision.revision_number,
                    structure_version=structure.ref.fingerprint,
                ),
                processed_version=self.processing_version(),
                plan=plan,
                ancestor_ids=started.ancestor_ids,
                source_id=started.source_id,
                classification_cache=self._classification_cache(document, revision),
                progress=progress,
            )

    async def classify_document(
        self,
        document_id: UUID,
        *,
        tenant_id: UUID,
        progress: IndexProgress | None = None,
        plan: ClassificationPlan | None,
    ) -> int:
        """CLASSIFY_ONLY: classify one Document's current revision again, index untouched.

        Reuses the revision's stored Structured Document (parsed only when it
        has none) and chunks it again; nothing is contextualized, embedded or
        stored in the index, and the index state is not changed. The labels,
        outcomes and profile are recorded only if the revision did not change
        meanwhile. Returns the chunk count.
        """

        if self._structures is None:
            raise RuntimeError(  # noqa: TRY004 - invalid service composition
                "ItemIngestionService needs a StructureStore to classify documents"
            )
        async with advisory_lock_scope(
            self._advisory_lock_key(document_id), engine=self._require_engine()
        ):
            started = await self._load_processable(document_id, tenant_id=tenant_id)
            document = started.document
            revision = started.revision
            if progress is not None:
                progress("parsing", 0, 0)
            structure = await self._stored_structure(document, revision)
            # Highlights are not needed to classify: no locator, no PDF read.
            chunks = await asyncio.to_thread(
                self._chunk, structure.document, document=document, revision=revision, locator=None
            )
            if plan is None:
                return len(chunks)
            item = _envelope(document, revision, source=started.source)
            prepared = await self._prepare(
                plan,
                item,
                chunks,
                item_id=document.id,
                ancestor_ids=started.ancestor_ids,
                source_id=started.source_id,
            )
            if prepared is None:
                return len(chunks)
            classified = await self._index.classify_document(
                item,
                chunks,
                classification=prepared.request,
                cache=self._classification_cache(document, revision),
                progress=progress,
            )
            async with transaction_scope(self._session_factory) as session:
                row = await session.get(
                    Item, document.id, with_for_update=True, populate_existing=True
                )
                current = await ItemService(session).current_revision(document.id)
                if (
                    row is None
                    or row.deleted_at is not None
                    or current is None
                    or current.revision_number != revision.revision_number
                ):
                    log.info(
                        "classification skipped: document %s changed while classifying",
                        document.id,
                    )
                    return len(chunks)
                await _record_classification(
                    session,
                    row,
                    plan,
                    prepared,
                    classified,
                    revision_number=revision.revision_number,
                )
            return len(chunks)

    async def process_item_content(
        self,
        stored: Item,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        context: IndexingContext,
        processed_version: str,
        plan: ClassificationPlan | None = None,
        ancestor_ids: tuple[UUID, ...] = (),
        source_id: UUID | None = None,
        classification_cache: ClassificationCache | None = None,
        progress: IndexProgress | None = None,
    ) -> int:
        """Index the chunks of revision ``context.revision_number``'s Structured Document.

        With a ``plan`` the Document is classified too: ``ancestor_ids`` and
        ``source_id`` are what its collection and source rules match.
        ``classification_cache`` holds earlier classification answers of the
        content (:class:`StoredClassifications`).
        """

        try:
            async with transaction_scope(self._session_factory) as session:
                await ItemService(session).mark_index_processing(stored.id)
            if item.id != str(stored.id):
                raise ValueError("canonical item does not match the stored document")
            if any(chunk.item_id != item.id for chunk in chunks):
                raise ValueError("canonical chunk belongs to a different document")

            prepared = (
                await self._prepare(
                    plan,
                    item,
                    chunks,
                    item_id=stored.id,
                    ancestor_ids=ancestor_ids,
                    source_id=source_id,
                )
                if plan is not None
                else None
            )
            count, classified = await self._index.index_item_content(
                item,
                chunks,
                context=context,
                classification=prepared.request if prepared is not None else None,
                classification_cache=classification_cache,
                progress=progress,
            )

            async with transaction_scope(self._session_factory) as session:
                await self._record_indexed(
                    session,
                    stored.id,
                    context=context,
                    processed_version=processed_version,
                    plan=plan,
                    prepared=prepared,
                    classified=classified,
                )
            return count
        except Exception:
            await self._record_failure(stored.id)
            raise

    async def _prepare(
        self,
        plan: ClassificationPlan,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        item_id: UUID,
        ancestor_ids: tuple[UUID, ...],
        source_id: UUID | None,
    ) -> PreparedDocument | None:
        """The Document's classification request; ``None`` (logged) when preparing failed:
        CLASSIFYING is best effort and the Document is indexed with its labels unchanged."""

        try:
            return await prepare(
                plan,
                document_input(
                    item, chunks, ancestor_ids=ancestor_ids, source_id=source_id, item_id=item_id
                ),
                self._signals,
            )
        except Exception:
            log.warning("classification could not be prepared item_id=%s", item_id, exc_info=True)
            return None

    def _classification_cache(
        self, document: Item, revision: ItemRevision
    ) -> ClassificationCache | None:
        if self._classifications is None:
            return None
        return self._classifications.of(document.workspace_code, revision.content_id)

    async def _stored_structure(self, document: Item, revision: ItemRevision) -> ParsedStructure:
        """The revision's stored Structured Document whatever profile parsed it; parsed
        (current profile, no images) only when it has none."""

        assert self._structures is not None
        manifest = StructureManifest.parse(revision.exports)
        if manifest is not None:
            ref = StructureRef(document.workspace_code, revision.content_id, manifest.fingerprint)
            try:
                return ParsedStructure(ref, manifest, await self._structures.document(ref))
            except StructureUnavailable:
                pass
        return await self._structures.ensure(document, revision=revision)

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

    def _chunk(
        self,
        parsed: DoclingDocument,
        *,
        document: Item,
        revision: ItemRevision,
        locator: Locator | None,
    ) -> list[Chunk]:
        """The retrieval chunks of a Structured Document (runs in a worker thread)."""

        extension = Path(parsed_file_name(document, revision)).suffix.casefold()
        strategy: ChunkStrategy = "line" if extension in _LINE_EXTENSIONS else "hybrid"
        try:
            return self._chunker.chunk(
                parsed, item_id=str(document.id), strategy=strategy, locator=locator
            )
        except DoclingChunkingError as exc:
            raise DocumentProcessingError("the file has no text to index") from exc

    @asynccontextmanager
    async def _locating(
        self, document: Item, revision: ItemRevision, parsed: DoclingDocument
    ) -> AsyncIterator[Locator | None]:
        """What places the chunks' blocks in the Original preview (``document_viewer.md``).

        A TABLE representation: sheet ranges. A PDF representation whose bytes
        were parsed: Docling's boxes (table rows found in the PDF's text). A
        PDF representation of a format parsed as itself: blocks found in the
        PDF's text. Anything else (text shown as text) gets no highlights.
        """

        file_name = revision_file_name(document, revision)
        row = classify(file_name, revision.mime_type)
        if row is not None and row.kind == "TABLE":
            yield SheetLocator(parsed, sheet=PurePosixPath(file_name).stem or file_name)
            return
        if row is None or row.kind != "PDF":
            yield None
            return
        parsed_is_shown = row.producer is Producer.AS_IS or parsed_as_pdf(document, revision)
        if self._pdfs is None or (parsed_is_shown and not parsed.tables):
            yield PageLocator(parsed) if parsed_is_shown else None
            return
        async with self._pdfs.shown_pdf(document, revision) as path:
            if path is None:
                yield PageLocator(parsed) if parsed_is_shown else None
                return
            layer = await asyncio.to_thread(PdfTextLayer, path)
        # The layer is read whole: the PDF is no longer needed once it is made.
        if parsed_is_shown:
            yield PageLocator(parsed, layer)
        else:
            yield await asyncio.to_thread(AlignedLocator, parsed, layer)

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
            if revision is None:
                raise DocumentUnavailableError("the document has no stored original")
            # The candidate of an open NEW_DOCUMENT contribution is classified
            # where it is headed, not in the contributor's PERSONAL collection.
            contribution = (
                await open_new_document_contributions(session, tenant_id, [document.id])
            ).get(document.id)
            decision = deciding_collection(contribution) if contribution is not None else None
            placement = (
                await item_ancestry(session, decision) if decision is not None else path[1:]
            )
            source, source_id = await _provider_identity(session, document.id)
            return _ProcessingStart(
                document=document,
                collection_id=collection_id,
                revision=revision,
                ancestor_ids=tuple(node.item_id for node in placement),
                source=source,
                source_id=source_id,
            )

    @staticmethod
    async def _record_indexed(
        session: AsyncSession,
        item_id: UUID,
        *,
        context: IndexingContext,
        processed_version: str,
        plan: ClassificationPlan | None = None,
        prepared: PreparedDocument | None = None,
        classified: DocumentClassification | None = None,
    ) -> None:
        """Mark the index current and record the classification (labels,
        outcomes, profile and an open NEW_DOCUMENT contribution's suggestions),
        unless the content or placement moved on meanwhile."""

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
            (current.revision_number if current is not None else None) == context.revision_number
            and str(await _governing_collection(session, item_id)) == context.collection_item_id
        )
        if not unchanged:
            await items.set_index_state((item,), index_status="pending")
            await items.mark_payload_dirty((item_id,), func.now())
            return
        await items.mark_index_ready(
            item_id,
            processed_version=processed_version,
            indexed_revision_number=context.revision_number,
        )
        if plan is not None and prepared is not None:
            await _record_classification(
                session, item, plan, prepared, classified, revision_number=context.revision_number
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
    revision: ItemRevision
    #: CLASSIFYING's collection rules match these Item IDs: the Document's
    #: ancestors, or for an open NEW_DOCUMENT contribution's candidate its
    #: deciding collection and that collection's ancestors.
    ancestor_ids: tuple[UUID, ...]
    #: The provider identity of a synced Document and its ingestion source
    #: (CLASSIFYING's source rules); ``None`` for an upload.
    source: SourceIdentity | None
    source_id: UUID | None


async def _record_classification(
    session: AsyncSession,
    item: Item,
    plan: ClassificationPlan,
    prepared: PreparedDocument,
    classified: DocumentClassification | None,
    *,
    revision_number: int,
) -> None:
    """Decide on the answer and write it: labels and outcomes per scheme, the
    extracted profile, and an open NEW_DOCUMENT contribution's suggestions.

    ``classified`` is ``None`` when the model failed: the schemes that needed
    it keep their labels (outcome ``failed``); the rest is written. The
    candidate of an open NEW_DOCUMENT contribution only gets suggestions.
    """

    # Imported here: contributions imports this module (sync_item_payloads).
    from bomesh.services.knowledge_curation.contributions import (
        record_classified_suggestions,
    )

    outcome = decide(plan, prepared, classified)
    contribution = (
        await open_new_document_contributions(session, item.tenant_id, [item.id])
    ).get(item.id)
    await replace_machine_assignments(
        session,
        item.id,
        outcome.schemes,
        revision_number=revision_number,
        suggest_only=outcome.suggest_only or contribution is not None,
    )
    if outcome.write_profile:
        await write_extracted_profile(
            session, item.id, item.tenant_id, outcome.metadata, revision_number=revision_number
        )
    if contribution is not None and classified is not None:
        await record_classified_suggestions(session, contribution, outcome.summary, outcome.title)


async def _provider_identity(
    session: AsyncSession, document_id: UUID
) -> tuple[SourceIdentity | None, UUID | None]:
    """The ``external_resources`` identity of a synced Document (a live one first)
    and its ingestion source.

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
    resource = await session.scalar(
        select(ExternalResource)
        .where((ExternalResource.item_id == document_id) | (ExternalResource.item_id == replaced))
        .order_by(
            (ExternalResource.item_id == document_id).desc(),
            ExternalResource.deleted_at.desc().nulls_first(),
        )
        .limit(1)
    )
    if resource is None:
        return None, None
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
    return identity, resource.ingestion_source_id


def _envelope(
    document: Item, revision: ItemRevision, *, source: SourceIdentity | None
) -> DocumentItem:
    """What the index says about the Document beside its chunks.

    ``source`` is the provider identity of a synced Document; an upload
    carries its own. Retrieval is Collection-scoped, so the payload carries no
    reader list; contextualization reads the Document's description (its summary).
    """

    file_name = parsed_file_name(document, revision)
    return DocumentItem(
        id=str(document.id),
        title=document.item_name or file_name,
        source=source
        or SourceIdentity(
            connector_id="upload", provider=SourceProvider.FILE, external_id=str(document.id)
        ),
        document_kind=(
            DocumentKind.PDF
            if parsed_as_pdf(document, revision)
            else _KIND_BY_ITEM_TYPE.get(document.item_type, DocumentKind.DOCUMENT)
        ),
        access=AccessPolicy(),
        hierarchy=(
            Hierarchy(parent_id=str(document.parent_item_id))
            if document.parent_item_id
            else Hierarchy()
        ),
        metadata={"summary": document.description} if document.description else {},
    )


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
