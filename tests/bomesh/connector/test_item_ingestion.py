from __future__ import annotations

import ast
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID, uuid4

import bomesh.services.knowledge_items.indexing as item_ingestion
import pytest
from bomesh.connector.file import FileNoTextError
from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    ProviderCacheEntry,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.models import Item, ItemRevision
from bomesh.document_index import IndexingContext, ItemIndex
from bomesh.storage import StoredObject
from bomesh.storage.keys import content_key
from bomesh.services import DocumentProcessingError
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from bomesh.services.knowledge_items.item_store import show_revision
from bomesh.services.knowledge_items.file_types import file_class
from bomesh.services.knowledge_items.original_parser import OriginalParser
from bomesh.services.previews.results import ConversionFailed
from docling_core.types.doc import DocItemLabel, DoclingDocument

VERSION = "0123456789abcdef"


class _Embedder:
    embedding_model = "test-embedding-v1"

    async def embed_query(self, query: str) -> list[float]:
        return [float(len(query))]

    async def embed_documents(self, documents: list[str]) -> list[list[float]]:
        return [[float(len(document))] for document in documents]


def _context(document: Item, *, tenant_id: object | None = None) -> IndexingContext:
    return IndexingContext(
        tenant_id=str(tenant_id or document.tenant_id),
        collection_item_id=str(document.parent_item_id),
        parent_item_id=str(document.parent_item_id),
        connector_key="file",
        revision_number=1,
        structure_version=VERSION,
    )


@pytest.mark.asyncio
async def test_item_ingestion_owns_the_source_neutral_indexing_sequence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class Session:
        """Only what recording the finished index reads: the locked row."""

        async def get(self, *_: Any, **__: Any) -> Item:
            return stored

        async def flush(self) -> None:
            return None

    async def unchanged_collection(_: object, item_id: Any) -> Any:
        return stored.parent_item_id

    monkeypatch.setattr(item_ingestion, "_governing_collection", unchanged_collection)

    class SessionFactory:
        def begin(self) -> SessionFactory:
            return self

        async def __aenter__(self) -> Session:
            return Session()

        async def __aexit__(self, *_: Any) -> None:
            return None

    class Items:
        def __init__(self, _: object) -> None:
            pass

        async def mark_index_processing(self, _: Any) -> None:
            events.append("processing")

        async def mark_index_ready(
            self, _: Any, *, processed_version: str, indexed_revision_number: int | None
        ) -> None:
            assert processed_version == "parser=p;chunker=c"
            assert indexed_revision_number == 1
            events.append("ready")

        async def current_revision(self, _: Any) -> Any:
            return SimpleNamespace(revision_number=1)

        async def mark_index_failed(self, _: Any) -> None:
            events.append("failed")

    class Index:
        async def index_item_content(
            self,
            _: DocumentItem,
            chunks: Any,
            *,
            context: IndexingContext,
            classification: Any = None,
            classification_cache: Any = None,
            progress: Any = None,
        ) -> tuple[int, None]:
            assert len(chunks) == 1
            assert context.connector_key == "file"
            assert (context.revision_number, context.structure_version) == (1, VERSION)
            assert classification is None
            events.append("vectors")
            return len(chunks), None

    monkeypatch.setattr(item_ingestion, "ItemService", Items)
    stored = _document("text/plain")
    canonical = DocumentItem(
        id=str(stored.id),
        title=stored.item_name or "sample",
        document_kind=DocumentKind.NOTE,
        source=SourceIdentity(
            connector_id="upload",
            provider=SourceProvider.FILE,
            external_id=str(stored.id),
        ),
        hierarchy=Hierarchy(parent_id=str(stored.parent_item_id)),
        access=AccessPolicy(),
    )
    chunk = Chunk(
        id=f"{stored.id}:0",
        item_id=str(stored.id),
        chunk_index=0,
        chunk_text="grounded content",
        content_type="text",
        refs=("texts/0",),
    )
    ingestion = ItemIngestionService(
        cast(Any, SessionFactory()),
        index=cast(Any, Index()),
    )

    count = await ingestion.process_item_content(
        stored,
        canonical,
        [chunk],
        context=_context(stored),
        processed_version="parser=p;chunker=c",
    )

    assert count == 1
    assert events == ["processing", "vectors", "ready"]


def _document(
    content_type: str,
    *,
    size_bytes: int = 1024,
    file_name: str = "sample",
) -> Item:
    collection_id = uuid4()
    document = Item(
        id=uuid4(),
        item_kind="document",
        item_type=file_class(content_type, file_name),
        parent_item_id=collection_id,
        tenant_id=uuid4(),
        item_name="sample",
        purpose="knowledge",
        is_published=True,
    )
    document.upload = None
    document.workspace_code = "hcmute"
    revision = ItemRevision(
        id=uuid4(),
        item_id=document.id,
        revision_number=1,
        content_id=uuid4(),
        mime_type=content_type,
        size_bytes=size_bytes,
        file_name=file_name,
        exports={},
    )
    document.current_revision = revision
    show_revision(document, revision)
    return document


def _revision(document: Item) -> ItemRevision:
    assert document.current_revision is not None
    return document.current_revision


class _StreamingStorage:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.downloads = 0
        self.reads = 0
        self.keys: list[str] = []

    async def download_to_path(
        self,
        key: str,
        path: Path,
        *,
        max_bytes: int,
    ) -> StoredObject:
        self.keys.append(key)
        assert len(self.content) <= max_bytes
        self.downloads += 1
        path.write_bytes(self.content)
        return StoredObject(
            size_bytes=len(self.content),
            content_type="text/plain",
        )

    async def read(self, key: str, *, max_bytes: int) -> bytes:
        del key, max_bytes
        self.reads += 1
        raise AssertionError("parsing must not read the full object")


class _PathProcessor:
    """``FileProcessor.parse_path``: records what it was given, parses one paragraph."""

    def __init__(self, error: Exception | None = None) -> None:
        self.content: bytes | None = None
        self.file_name: str | None = None
        self.read_images: bool | None = None
        self.error = error

    def parse_path(self, path: Path, **kwargs: Any) -> DoclingDocument:
        self.content = path.read_bytes()
        self.file_name = str(kwargs["file_name"])
        self.read_images = bool(kwargs["read_images"])
        assert kwargs["transcripts"] is not None
        if self.error is not None:
            raise self.error
        document = DoclingDocument(name="parsed")
        document.add_text(label=DocItemLabel.PARAGRAPH, text="streamed evidence")
        return document


class _Pdfs:
    """``PreviewEngine``'s PDF representations."""

    def __init__(self, *, key: str | None = None, error: ConversionFailed | None = None) -> None:
        self.key = key
        self.error = error
        self.asked: list[tuple[UUID, int | None]] = []

    async def pdf_key(self, item_id: UUID, revision_number: int | None = None) -> str:
        self.asked.append((item_id, revision_number))
        if self.error is not None:
            raise self.error
        assert self.key is not None
        return self.key

    def stored_pdf_key(self, item: Item, revision: ItemRevision) -> str | None:
        del item, revision
        return None


def _parser(storage: Any, processor: Any, **options: Any) -> OriginalParser:
    return OriginalParser(object_storage=storage, processor=processor, **options)


@pytest.mark.asyncio
async def test_parsing_streams_the_revisions_original_to_a_temporary_path() -> None:
    raw = b"bounded source content"
    storage = _StreamingStorage(raw)
    processor = _PathProcessor()
    document = _document("text/plain", size_bytes=len(raw), file_name="notes.txt")
    revision = _revision(document)

    parsed = await _parser(storage, processor).parse(document, revision=revision, read_images=True)

    assert storage.keys == [content_key(document.workspace_code, revision.content_id)]
    assert storage.reads == 0
    assert processor.content == raw
    assert (processor.file_name, processor.read_images) == ("notes.txt", True)
    assert parsed.texts[0].text == "streamed evidence"


@pytest.mark.asyncio
async def test_parsing_rejects_an_oversize_original_before_download() -> None:
    storage = _StreamingStorage(b"oversize")
    document = _document("text/plain", size_bytes=8)

    with pytest.raises(DocumentProcessingError, match="processing limit"):
        await _parser(storage, _PathProcessor(), max_processing_bytes=4).parse(
            document, revision=_revision(document)
        )

    assert storage.downloads == 0


@pytest.mark.asyncio
async def test_a_file_without_text_fails_with_the_read_images_hint() -> None:
    document = _document("text/plain", size_bytes=3, file_name="blank.txt")
    processor = _PathProcessor(error=FileNoTextError("No extractable content found"))

    with pytest.raises(DocumentProcessingError, match="Read text in images"):
        await _parser(_StreamingStorage(b"   "), processor).parse(
            document, revision=_revision(document)
        )


@pytest.mark.asyncio
async def test_a_legacy_office_file_is_parsed_from_its_pdf_representation() -> None:
    # .doc has no parser: processing reads the PDF the viewer shows, not the original.
    pdf = b"%PDF-1.7 converted by Gotenberg"
    storage = _StreamingStorage(pdf)
    processor = _PathProcessor()
    pdfs = _Pdfs(key="workspaces/hcmute/files/content/preview-v1")
    # The original's size differs from the PDF's; only the original's is checked.
    document = _document("application/msword", size_bytes=4096, file_name="report.doc")

    await _parser(storage, processor, pdfs=pdfs).parse(document, revision=_revision(document))

    assert pdfs.asked == [(document.id, 1)]
    assert storage.keys == ["workspaces/hcmute/files/content/preview-v1"]
    assert processor.content == pdf
    assert processor.file_name == "report.pdf"


@pytest.mark.asyncio
async def test_a_legacy_office_file_that_cannot_become_pdf_fails_as_the_files_problem() -> None:
    storage = _StreamingStorage(b"")
    pdfs = _Pdfs(error=ConversionFailed("CONVERSION_ERROR", "LibreOffice could not open it"))
    document = _document("application/vnd.ms-powerpoint", file_name="budget.ppt")

    with pytest.raises(DocumentProcessingError, match=r"converted to PDF.*CONVERSION_ERROR"):
        await _parser(storage, _PathProcessor(), pdfs=pdfs).parse(
            document, revision=_revision(document)
        )

    assert storage.downloads == 0


@pytest.mark.asyncio
async def test_without_conversion_a_legacy_file_whose_pdf_is_not_stored_is_not_processed() -> None:
    storage = _StreamingStorage(b"")
    pdfs = _Pdfs(key="never-asked")
    document = _document("application/msword", file_name="report.doc")

    with pytest.raises(DocumentProcessingError, match="has not been processed yet"):
        await _parser(storage, _PathProcessor(), pdfs=pdfs).parse(
            document, revision=_revision(document), convert=False
        )

    assert pdfs.asked == []
    assert storage.downloads == 0


def test_a_synced_item_is_indexed_under_its_connector_identity() -> None:
    # A connector Item's chunks must cite the provider page, not an upload.
    document = _document("text/html", file_name="release-notes.html")
    source = SourceIdentity(
        connector_id="connection-1",
        provider=SourceProvider.CONFLUENCE,
        external_id="page-42",
        external_version="7",
        url="https://wiki.example.test/pages/42",
    )

    item = item_ingestion._envelope(document, _revision(document), source=source)

    assert item.id == str(document.id)
    assert item.source == source
    assert item.document_kind == DocumentKind.WEB_PAGE
    assert item.hierarchy.parent_id == str(document.parent_item_id)


def test_an_upload_is_indexed_under_its_own_identity() -> None:
    document = _document("application/pdf", file_name="scan.pdf")
    document.description = "A scanned contract."

    item = item_ingestion._envelope(document, _revision(document), source=None)

    assert item.source.provider == SourceProvider.FILE
    assert item.source.external_id == str(document.id)
    assert item.document_kind == DocumentKind.PDF
    assert item.metadata == {"summary": "A scanned contract."}


def test_item_ingestion_has_no_raw_processing_implementation_dependencies() -> None:
    source_path = Path(cast(str, item_ingestion.__file__))
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    imported_modules = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module is not None
    }
    imported_modules.update(
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    )

    # It chunks a Structured Document; parsing files and storage are not its business.
    assert not any(
        module.startswith(("bomesh.connector.file", "bomesh.storage"))
        for module in imported_modules
    )
    assert not {"base64", "hashlib", "tempfile"} & imported_modules
    assert "EmbeddingService" not in {
        node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
    }


class _RecordingIndexBackend:
    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.deleted_tenants: list[str | None] = []
        self.batches: list[tuple[list[Any], list[list[float]]]] = []

    async def replace_item_points(
        self,
        *,
        item_id: str,
        tenant_id: str,
        records: Any,
        vectors: Any,
    ) -> None:
        self.deleted.append(item_id)
        self.deleted_tenants.append(tenant_id)
        self.batches.append((list(records), [list(vector) for vector in vectors]))

    async def tombstone_item_points(
        self,
        document_id: str,
        *,
        tenant_id: str | None = None,
    ) -> None:
        self.deleted.append(document_id)
        self.deleted_tenants.append(tenant_id)


@pytest.mark.asyncio
async def test_item_index_replacement_uses_deterministic_bounded_payloads() -> None:
    tenant_id = uuid4()
    user_id = uuid4()
    document = _document("text/plain")
    item = DocumentItem(
        id=str(document.id),
        title="sample",
        document_kind=DocumentKind.NOTE,
        source=SourceIdentity(
            connector_id="file",
            provider=SourceProvider.FILE,
            external_id=str(document.id),
        ),
        hierarchy=Hierarchy(parent_id=str(document.parent_item_id)),
        access=AccessPolicy.from_reader_ids([str(user_id)]),
    )
    chunks = [
        Chunk(
            id=f"{document.id}:0",
            item_id=str(document.id),
            chunk_index=0,
            content_type="text",
            chunk_text="grounded content",
            section_path=["Summary"],
            refs=("texts/1", "texts/2"),
            quote="grounded content",
            location="Summary",
            page=3,
        )
    ]
    backend = _RecordingIndexBackend()
    index = ItemIndex(backend=cast(Any, backend), embedder=_Embedder())

    await index.index_item_content(item, chunks, context=_context(document, tenant_id=tenant_id))
    await index.index_item_content(item, chunks, context=_context(document, tenant_id=tenant_id))

    assert backend.deleted == [str(document.id), str(document.id)]
    assert backend.deleted_tenants == [str(tenant_id), str(tenant_id)]
    assert backend.batches[0][0][0].point_id == backend.batches[1][0][0].point_id
    payload = backend.batches[0][0][0].payload.to_payload()
    expected_text = "Document: sample\nSection: Summary\n\ngrounded content"
    assert backend.batches[0][1] == [[float(len(expected_text))]]
    assert payload["tenant_id"] == str(tenant_id)
    assert payload["collection_item_id"] == str(document.parent_item_id)
    assert "integration_connection_id" not in payload
    assert "ingestion_source_id" not in payload
    assert "root_id" not in payload
    assert "context_summary" not in payload
    assert payload["item_id"] == str(document.id)
    assert payload["chunk_id"] == f"{document.id}:0"
    assert payload["chunk_text"] == "grounded content"
    assert "Document: sample" in payload["contextual_text"]
    assert payload["content_type"] == "text"
    assert payload["section_path"] == ["Summary"]
    assert payload["refs"] == ["texts/1", "texts/2"]
    assert (payload["revision_number"], payload["structure_version"]) == (1, VERSION)
    assert (payload["quote"], payload["location"], payload["page"]) == (
        "grounded content",
        "Summary",
        3,
    )
    assert "access" not in payload
    assert "storage" not in payload

    await index.remove_item_content(str(document.id), tenant_id=str(tenant_id))
    assert backend.deleted == [str(document.id), str(document.id), str(document.id)]


def test_provider_cache_expiry_uses_utc() -> None:
    entry = ProviderCacheEntry(
        provider="openrouter",
        provider_version="v1",
        reference={"file_id": "file-123"},
        expires_at=datetime(2000, 1, 1, tzinfo=UTC),
    )

    assert entry.is_expired


def test_processing_writes_no_viewer_rendition_for_knowledge_documents() -> None:
    # Viewing is the preview engine's (bomesh.services.previews): processing only indexes.
    assert not hasattr(ItemIngestionService, "_persist_preview")
    with pytest.raises(TypeError):
        ItemIngestionService(cast(Any, object()), index=cast(Any, object()), preview=object())  # type: ignore[call-arg]
