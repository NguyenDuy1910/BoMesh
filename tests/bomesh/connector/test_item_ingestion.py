from __future__ import annotations

import ast
from datetime import UTC, datetime
from io import BytesIO
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
from bomesh.storage import PresignedRequest, StoredObject
from bomesh.storage.keys import PREVIEW, content_key, derived_key
from bomesh.services import DocumentProcessingError
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from bomesh.services.knowledge_items.item_store import show_revision
from bomesh.services.knowledge_items.file_types import file_class
from bomesh.services.knowledge_items.original_parser import OriginalParser
from bomesh.services.artifacts.preview import KnowledgePreview
from bomesh.services.previews.results import ConversionFailed
from docling_core.types.doc import DocItemLabel, DoclingDocument
from PIL import Image

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

    assert storage.keys == [content_key(document.tenant_id, revision.content_id)]
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
    pdfs = _Pdfs(key="derived/tenant/content/representation-v1")
    # The original's size differs from the PDF's; only the original's is checked.
    document = _document("application/msword", size_bytes=4096, file_name="report.doc")

    await _parser(storage, processor, pdfs=pdfs).parse(document, revision=_revision(document))

    assert pdfs.asked == [(document.id, 1)]
    assert storage.keys == ["derived/tenant/content/representation-v1"]
    assert processor.content == pdf
    assert processor.file_name == "report.pdf"


@pytest.mark.asyncio
async def test_a_legacy_office_file_that_cannot_become_pdf_fails_as_the_files_problem() -> None:
    storage = _StreamingStorage(b"")
    pdfs = _Pdfs(error=ConversionFailed("CONVERSION_ERROR", "LibreOffice could not open it"))
    document = _document("application/vnd.ms-excel", file_name="budget.xls")

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


class _PreviewStorage:
    def __init__(self, source: bytes, *, content_type: str) -> None:
        self.source = source
        self.content_type = content_type
        self.downloads = 0
        self.puts: dict[str, tuple[bytes, str | None]] = {}
        self.put_headers: dict[str, tuple[str | None, str | None]] = {}

    async def head(self, key: str) -> StoredObject:
        assert key.startswith("content/")
        return StoredObject(
            size_bytes=len(self.source),
            content_type=self.content_type,
            etag="source-etag",
        )

    async def download_to_path(
        self,
        key: str,
        path: Path,
        *,
        max_bytes: int,
    ) -> StoredObject:
        assert key.startswith("content/")
        assert len(self.source) <= max_bytes
        self.downloads += 1
        path.write_bytes(self.source)
        return await self.head(key)

    def put_bytes(
        self,
        data: bytes,
        key: str,
        *,
        content_type: str | None = None,
        content_encoding: str | None = None,
        cache_control: str | None = None,
    ) -> StoredObject:
        self.puts[key] = (data, content_type)
        self.put_headers[key] = (content_encoding, cache_control)
        return StoredObject(size_bytes=len(data), content_type=content_type)

    def presign_download(
        self,
        key: str,
        *,
        expires_seconds: int,
        stable: bool = False,
        file_name: str | None = None,
    ) -> PresignedRequest:
        return PresignedRequest(
            url=f"https://objects.example.test/{key}?expires={expires_seconds}",
            method="GET",
            headers={},
            expires_at=datetime.now(UTC),
        )


def _preview_document(content_type: str, source: bytes, *, file_name: str) -> Item:
    return _document(content_type, size_bytes=len(source), file_name=file_name)


@pytest.mark.asyncio
async def test_knowledge_preview_derives_versioned_webp_without_replacing_original(
    tmp_path: Path,
) -> None:
    source_buffer = BytesIO()
    Image.new("RGB", (2_400, 1_200), "navy").save(source_buffer, "PDF")
    source = source_buffer.getvalue()
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(source)
    storage = _PreviewStorage(source, content_type="application/pdf")
    service = KnowledgePreview(
        cast(Any, storage),
        max_dimension=800,
    )
    document = _preview_document("application/pdf", source, file_name="scan.pdf")

    manifest = await service.generate(document, page_images=True, source_path=source_path)

    assert manifest is not None
    assert manifest.representation == "pages"
    assert manifest.page_count == 1
    assert len(manifest.assets) == 1
    asset = manifest.assets[0]
    assert asset.page == 1
    assert (asset.width, asset.height) == (800, 400)
    assert asset.content_type == "image/webp"
    assert document.current_revision is not None
    key = derived_key(
        document.tenant_id, document.current_revision.content_id, PREVIEW, 1, "page-0001.webp"
    )
    assert set(storage.puts) == {key}
    assert storage.source == source
    rendered, rendered_type = storage.puts[key]
    assert rendered_type == "image/webp"
    with Image.open(BytesIO(rendered)) as preview:
        assert preview.format == "WEBP"

    document.current_revision.exports = {"preview": manifest.model_dump(mode="json")}
    assert await service.generate(document, page_images=True, source_path=source_path) == manifest
    assert len(storage.puts) == 1

    resolved = service.resolve(document, expires_seconds=300)
    assert resolved is not None
    assert resolved.original.content_type == "application/pdf"
    assert resolved.assets[0].page == 1


@pytest.mark.asyncio
async def test_office_preview_uses_the_consistent_original_representation() -> None:
    source = b"office source remains authoritative"
    content_type = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    storage = _PreviewStorage(source, content_type=content_type)
    service = KnowledgePreview(cast(Any, storage))
    document = _preview_document(content_type, source, file_name="report.docx")

    manifest = await service.generate(document, page_images=True)

    assert manifest is not None
    assert manifest.representation == "original"
    assert manifest.assets == ()
    assert storage.downloads == 0
    assert storage.puts == {}


def test_processing_writes_no_viewer_rendition_for_knowledge_documents() -> None:
    # Viewing is the preview engine's (bomesh.services.previews): processing only indexes.
    assert not hasattr(ItemIngestionService, "_persist_preview")
    with pytest.raises(TypeError):
        ItemIngestionService(cast(Any, object()), index=cast(Any, object()), preview=object())  # type: ignore[call-arg]


def test_pdf_preview_pages_are_bounded_and_keep_one_based_page_mapping(
    tmp_path: Path,
) -> None:
    pdf_path = tmp_path / "report.pdf"
    first = Image.new("RGB", (400, 600), "white")
    second = Image.new("RGB", (600, 400), "gray")
    try:
        first.save(pdf_path, "PDF", save_all=True, append_images=[second])
    finally:
        first.close()
        second.close()

    preview = KnowledgePreview(cast(Any, object()), max_pages=1, max_dimension=600).render(
        pdf_path,
        file_name="report.pdf",
        content_type="application/pdf",
    )

    assert preview.representation == "pages"
    assert preview.page_count == 2
    assert preview.truncated is True
    assert [asset.page for asset in preview.assets] == [1]
    assert preview.assets[0].content_type == "image/webp"
