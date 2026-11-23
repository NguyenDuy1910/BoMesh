"""Read a Document's stored original and produce its canonical content.

Uploads and connector Items both keep their original in object storage; this
is the one place it is parsed: :meth:`StoredFileContentService.canonicalize`
for indexing (parsed and chunked), :meth:`StoredFileContentService.parse` for
viewing (parsed only). Authorization happens before anything gets here (an
Ingestion Run, or an authorized resource read), so nothing below checks who
owns the bytes. Indexing keeps the vision model's transcriptions of scanned
PDF pages as a derived product of the content (:class:`StoredTranscripts`), so
processing the same content again with the same model does not pay for them twice.
"""

from __future__ import annotations

import asyncio
import base64
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, TypeVar
from uuid import UUID

from bomesh.connector.file import (
    FileNoTextError,
    FileProcessor,
    FileTranscriptionError,
    ProcessedFile,
)
from bomesh.connector.protocol import (
    AccessPolicy,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.models import Item
from bomesh.services import (
    DEFAULT_PROCESSING_MAX_BYTES,
    CanonicalDocumentContent,
    DocumentProcessingError,
    DocumentUnavailableError,
)
from bomesh.services.knowledge_items.item_store import item_content_key
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, TRANSCRIPT, derived_key

#: Model providers reject larger images; this also bounds what is held in memory.
MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
#: A stored transcription is the Docling document of one run of scanned pages.
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
#: The parsing kind of a Document, from its file class (``items.item_type``).
_KIND_BY_ITEM_TYPE = {
    "pdf": DocumentKind.PDF,
    "image": DocumentKind.IMAGE,
    "html": DocumentKind.WEB_PAGE,
}

_Parsed = TypeVar("_Parsed")


class StoredTranscripts:
    """The scanned-page transcriptions of one content, in object storage.

    A :class:`~bomesh.connector.processing.TranscriptCache` under
    ``derived/{tenant}/{content_id}/transcript-v1/{key}.json``, so they are
    purged with the content. Built on the event loop, used from the
    processing worker thread: a read runs on ``loop`` (the worker waits for
    it), a write is the storage's own blocking call.
    """

    def __init__(
        self,
        storage: DocumentStorage,
        *,
        tenant_id: UUID,
        content_id: UUID,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._storage = storage
        self._tenant_id = tenant_id
        self._content_id = content_id
        self._loop = loop

    def object_key(self, key: str) -> str:
        return derived_key(self._tenant_id, self._content_id, TRANSCRIPT, 1, part=f"{key}.json")

    def get(self, key: str) -> str | None:
        read = self._storage.read(self.object_key(key), max_bytes=MAX_TRANSCRIPT_BYTES)
        try:
            data = asyncio.run_coroutine_threadsafe(read, self._loop).result()
        except ObjectNotFoundError:
            return None
        return data.decode("utf-8")

    def put(self, key: str, document_json: str) -> None:
        self._storage.put_bytes(
            document_json.encode("utf-8"),
            self.object_key(key),
            content_type="application/json",
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )


class StoredFileContentService:
    """Resolve stored originals and produce canonical connector evidence."""

    def __init__(
        self,
        *,
        object_storage: DocumentStorage,
        processor: FileProcessor,
        max_processing_bytes: int = DEFAULT_PROCESSING_MAX_BYTES,
    ) -> None:
        if max_processing_bytes < 1:
            raise ValueError("document processing limit must be greater than zero")
        self._object_storage = object_storage
        self._processor = processor
        self._max_processing_bytes = max_processing_bytes

    async def canonicalize(
        self, document: Item, *, source: SourceIdentity | None = None, read_images: bool = False
    ) -> CanonicalDocumentContent:
        """Stream one Document's stored original through the file connector.

        ``source`` is the provider identity of a synced Document
        (:func:`source_identity`); an upload carries its own. ``read_images``
        has the vision model read the text inside its pictures
        (``IngestionRun.readImages``).
        """

        async with self._original(document) as path:
            processed = await self.process_path(
                document, path, source=source, read_images=read_images
            )
            return self._canonical_content(document, processed)

    async def parse(self, document: Item, *, timeout_seconds: float | None = None) -> DocumentItem:
        """The canonical document of one stored original, not chunked (a view of the file).

        No chunking, embedding or classification happens; the same converter
        as :meth:`canonicalize`, so element IDs agree with processing's.
        ``timeout_seconds`` bounds the parse alone (``TimeoutError``), never the
        download: a slow store is not a property of the file.
        """

        async with self._original(document) as path:
            item = await asyncio.wait_for(
                self._read(self._processor.parse_path, document, path), timeout_seconds
            )
        if item.id != str(document.id):
            raise DocumentProcessingError(
                "canonical document ID does not match its stored source"
            )
        return item

    async def process_path(
        self,
        document: Item,
        path: Path,
        *,
        source: SourceIdentity | None = None,
        read_images: bool = False,
    ) -> ProcessedFile:
        """Parse a local copy of one Item's stored original through the file connector.

        Scanned PDF pages already transcribed for this content with the
        configured model are reused (:class:`StoredTranscripts`).
        """

        content = document.content
        transcripts = (
            StoredTranscripts(
                self._object_storage,
                tenant_id=document.tenant_id,
                content_id=content.content_id,
                loop=asyncio.get_running_loop(),
            )
            if content is not None
            else None
        )
        return await self._read(
            self._processor.process_path,
            document,
            path,
            source=source,
            read_images=read_images,
            transcripts=transcripts,
        )

    @asynccontextmanager
    async def _original(self, document: Item) -> AsyncIterator[Path]:
        """A temporary local copy of the Document's stored original."""

        self._validate_size(document)
        if document.content is None:
            raise DocumentUnavailableError("the document has no stored original")
        with tempfile.TemporaryDirectory(prefix="bomesh-document-") as directory:
            suffix = Path(self._file_name(document)).suffix
            path = Path(directory) / f"source{suffix}"
            try:
                stored = await self._object_storage.download_to_path(
                    item_content_key(document),
                    path,
                    max_bytes=self._max_processing_bytes,
                )
            except ObjectNotFoundError as exc:
                raise DocumentUnavailableError(
                    "the original file is no longer in storage"
                ) from exc
            self._validate_stored_size(document, stored.size_bytes)
            yield path

    async def _read(
        self,
        read: Callable[..., _Parsed],
        document: Item,
        path: Path,
        *,
        source: SourceIdentity | None = None,
        **options: Any,
    ) -> _Parsed:
        """Run the file connector on a local original.

        Whatever the parser raises is a property of the file, never a reason
        to retry.
        """

        try:
            return await asyncio.to_thread(
                read, path, **self._processing_arguments(document, source), **options
            )
        except FileNoTextError as exc:
            raise DocumentProcessingError(
                "the file has no text to index; to read the text inside its pictures,"
                " process it with Read text in images"
            ) from exc
        except FileTranscriptionError as exc:
            raise DocumentProcessingError(
                "the vision model could not read its scanned pages or pictures;"
                " run the ingestion again later"
            ) from exc
        except Exception as exc:
            raise DocumentProcessingError(
                "the file could not be read; it may be damaged or in a format that cannot be parsed"
            ) from exc

    async def image_data_url(self, document: Item) -> str:
        """Return one stored image inline, as a ``data:`` URL for the model.

        The model provider never fetches from object storage: a private
        endpoint (local MinIO) is unreachable from it, and a signed URL would
        hand a third party a bearer link to the object.
        """

        if (document.size_bytes or 0) > MAX_INLINE_IMAGE_BYTES:
            raise DocumentProcessingError("the image is too large to show the model")
        if document.content is None:
            raise DocumentUnavailableError("the document has no stored original")
        data = await self._object_storage.read(
            item_content_key(document), max_bytes=MAX_INLINE_IMAGE_BYTES
        )
        self._validate_stored_size(document, len(data))
        mime_type = (document.mime_type or "").split(";", 1)[0].strip().lower()
        return f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}"

    def _canonical_content(
        self, document: Item, processed: ProcessedFile
    ) -> CanonicalDocumentContent:
        expected_item_id = str(document.id)
        if processed.item.id != expected_item_id:
            raise DocumentProcessingError(
                "canonical document ID does not match its stored source"
            )
        if any(chunk.item_id != expected_item_id for chunk in processed.chunks):
            raise DocumentProcessingError(
                "canonical chunk does not belong to its stored source"
            )
        return CanonicalDocumentContent(
            item=processed.item,
            chunks=tuple(processed.chunks),
        )

    def _validate_size(self, document: Item) -> None:
        if (document.size_bytes or 0) > self._max_processing_bytes:
            raise DocumentProcessingError(
                "document exceeds the configured processing limit"
            )

    @staticmethod
    def _validate_stored_size(document: Item, size_bytes: int) -> None:
        if document.size_bytes is not None and size_bytes != document.size_bytes:
            raise DocumentUnavailableError(
                "stored document size no longer matches metadata"
            )

    @classmethod
    def _processing_arguments(
        cls, document: Item, source: SourceIdentity | None
    ) -> dict[str, Any]:
        file_name = cls._file_name(document)
        return {
            "file_name": file_name,
            "item_id": str(document.id),
            "title": document.item_name or file_name,
            "source": source or cls._upload_identity(document),
            "document_kind": cls._document_kind(document),
            # Retrieval is Collection-scoped; the payload carries no reader list.
            "access": AccessPolicy(),
            "hierarchy": (
                Hierarchy(parent_id=str(document.parent_item_id))
                if document.parent_item_id
                else Hierarchy()
            ),
            # Contextualization reads the Document's description (its summary).
            "metadata": {"summary": document.description} if document.description else {},
        }

    @staticmethod
    def _upload_identity(document: Item) -> SourceIdentity:
        """The identity of a Document no Source registered: its own."""
        return SourceIdentity(
            connector_id="upload",
            provider=SourceProvider.FILE,
            external_id=str(document.id),
        )

    @staticmethod
    def _file_name(document: Item) -> str:
        value = document.file_name or document.item_name or str(document.id)
        return str(value)

    @staticmethod
    def _document_kind(document: Item) -> DocumentKind:
        return _KIND_BY_ITEM_TYPE.get(document.item_type, DocumentKind.DOCUMENT)


__all__ = ["StoredFileContentService", "StoredTranscripts"]
