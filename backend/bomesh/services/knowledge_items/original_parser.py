"""Parse a Document revision's stored original into a ``DoclingDocument``.

Uploads and connector Items both keep their original in object storage; this
is the one place it is parsed, and only :class:`~bomesh.services.knowledge_items.
structure_store.StructureStore` calls it: the parse is stored as the
revision's Structured Document and never repeated for the same parse profile.
A format without a parser of its own (legacy and OpenDocument office files,
:func:`processed_as_pdf`) is parsed from its PDF representation instead, the
same PDF the viewer shows, so citations point at the pages people see.
Authorization happens before anything gets here, so nothing below checks who
owns the bytes. The vision model's transcriptions of scanned PDF pages are
kept as a derived product of the content (:class:`StoredTranscripts`), so
parsing the same content again with the same model does not pay for them twice.
"""

from __future__ import annotations

import asyncio
import base64
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Protocol
from uuid import UUID

from docling_core.types.doc import DoclingDocument

from bomesh.connector.file import FileNoTextError, FileProcessor, FileTranscriptionError
from bomesh.db.models import Item, ItemRevision
from bomesh.services import (
    DEFAULT_PROCESSING_MAX_BYTES,
    DocumentProcessingError,
    DocumentUnavailableError,
)
from bomesh.services.knowledge_items.file_types import processed_as_pdf
from bomesh.services.knowledge_items.item_store import item_content_key
from bomesh.services.previews.engine import revision_file_name
from bomesh.services.previews.results import ConversionFailed
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, TRANSCRIPT, content_key, derived_key

#: Model providers reject larger images; this also bounds what is held in memory.
MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
#: A stored transcription is the Docling document of one run of scanned pages.
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024


class PdfRepresentations(Protocol):
    """A revision's PDF representation (:class:`~bomesh.services.previews.engine.PreviewEngine`)."""

    async def pdf_key(self, item_id: UUID, revision_number: int | None = None) -> str: ...

    def stored_pdf_key(self, item: Item, revision: ItemRevision) -> str | None: ...


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


class OriginalParser:
    """Download a revision's original (or its PDF representation) and parse it."""

    def __init__(
        self,
        *,
        object_storage: DocumentStorage,
        processor: FileProcessor,
        max_processing_bytes: int = DEFAULT_PROCESSING_MAX_BYTES,
        pdfs: PdfRepresentations | None = None,
    ) -> None:
        """``pdfs`` resolves a revision's PDF representation; without it, formats
        parsed through their PDF cannot be read."""
        if max_processing_bytes < 1:
            raise ValueError("document processing limit must be greater than zero")
        self._object_storage = object_storage
        self._processor = processor
        self._max_processing_bytes = max_processing_bytes
        self._pdfs = pdfs

    async def parse(
        self,
        document: Item,
        *,
        revision: ItemRevision,
        read_images: bool = False,
        convert: bool = True,
    ) -> DoclingDocument:
        """The ``DoclingDocument`` of ``revision``'s stored original.

        ``read_images`` has the vision model read the text inside its pictures
        (``IngestionRun.readImages``). ``convert=False`` never asks Gotenberg:
        a format parsed through its PDF whose PDF is not stored yet raises
        :class:`DocumentProcessingError`. Whatever the parser raises is a
        property of the file, never a reason to retry.
        """

        transcripts = StoredTranscripts(
            self._object_storage,
            tenant_id=document.tenant_id,
            content_id=revision.content_id,
            loop=asyncio.get_running_loop(),
        )
        async with self._original(document, revision, convert=convert) as path:
            try:
                return await asyncio.to_thread(
                    self._processor.parse_path,
                    path,
                    file_name=parsed_file_name(document, revision),
                    read_images=read_images,
                    transcripts=transcripts,
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
                    "the file could not be read; it may be damaged or in a format"
                    " that cannot be parsed"
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
        if document.size_bytes is not None and len(data) != document.size_bytes:
            raise DocumentUnavailableError("stored document size no longer matches metadata")
        mime_type = (document.mime_type or "").split(";", 1)[0].strip().lower()
        return f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}"

    @asynccontextmanager
    async def _original(
        self, document: Item, revision: ItemRevision, *, convert: bool
    ) -> AsyncIterator[Path]:
        """A temporary local copy of what is parsed: the original, or its PDF representation."""

        if revision.size_bytes > self._max_processing_bytes:
            raise DocumentProcessingError("document exceeds the configured processing limit")
        as_pdf = parsed_as_pdf(document, revision)
        key = (
            await self._pdf_of(document, revision, convert=convert)
            if as_pdf
            else content_key(document.tenant_id, revision.content_id)
        )
        with tempfile.TemporaryDirectory(prefix="bomesh-document-") as directory:
            path = Path(directory) / f"source{Path(parsed_file_name(document, revision)).suffix}"
            try:
                stored = await self._object_storage.download_to_path(
                    key, path, max_bytes=self._max_processing_bytes
                )
            except ObjectNotFoundError as exc:
                raise DocumentUnavailableError("the original file is no longer in storage") from exc
            if not as_pdf and stored.size_bytes != revision.size_bytes:
                raise DocumentUnavailableError("stored document size no longer matches metadata")
            yield path

    async def _pdf_of(self, document: Item, revision: ItemRevision, *, convert: bool) -> str:
        """The object key of the revision's PDF representation (made now if missing and ``convert``)."""

        if self._pdfs is None:
            raise DocumentProcessingError(
                "this file type is read from its PDF conversion, which is not configured"
            )
        if not convert:
            key = self._pdfs.stored_pdf_key(document, revision)
            if key is None:
                raise DocumentProcessingError("this file has not been processed yet")
            return key
        try:
            return await self._pdfs.pdf_key(document.id, revision.revision_number)
        except ConversionFailed as exc:
            raise DocumentProcessingError(
                f"the file could not be converted to PDF for processing ({exc.reason})"
            ) from exc


def parsed_as_pdf(document: Item, revision: ItemRevision) -> bool:
    """Whether ``revision`` is parsed from its PDF representation (its pages are the PDF's)."""

    return processed_as_pdf(revision_file_name(document, revision), revision.mime_type)


def parsed_file_name(document: Item, revision: ItemRevision) -> str:
    """The name the parser sees: the original's, or ``<stem>.pdf`` for its PDF."""

    file_name = revision_file_name(document, revision)
    return f"{Path(file_name).stem}.pdf" if parsed_as_pdf(document, revision) else file_name


__all__ = [
    "MAX_INLINE_IMAGE_BYTES",
    "OriginalParser",
    "PdfRepresentations",
    "StoredTranscripts",
    "parsed_as_pdf",
    "parsed_file_name",
]
