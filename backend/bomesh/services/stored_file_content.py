"""Read a Document's stored original and produce its canonical content.

Uploads and connector Items both keep their original in object storage; this
is the one place it is parsed. Authorization happens before anything gets
here (an Ingestion Run, or an authorized resource read), so nothing below
checks who owns the bytes.
"""

from __future__ import annotations

import asyncio
import base64
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from bomesh.connector.file import (
    FileNoTextError,
    FileProcessor,
    FileTranscriptionError,
    ProcessedFile,
)
from bomesh.connector.protocol import (
    AccessPolicy,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.models import Item
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.services import (
    CanonicalDocumentContent,
    DEFAULT_PROCESSING_MAX_BYTES,
    DocumentProcessingError,
    DocumentUnavailableError,
)

#: Model providers reject larger images; this also bounds what is held in memory.
MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
#: The parsing kind of a Document, from the semantic type it was registered with.
_KIND_BY_DOCUMENT_TYPE = {
    "pdf": DocumentKind.PDF,
    "word_document": DocumentKind.DOCUMENT,
    "image": DocumentKind.IMAGE,
    "jira_issue": DocumentKind.ISSUE,
    "email": DocumentKind.EMAIL,
    "confluence_page": DocumentKind.PAGE,
    "web_page": DocumentKind.WEB_PAGE,
}


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

    async def canonicalize(self, document: Item) -> CanonicalDocumentContent:
        """Stream one Document's stored original through the file connector."""

        self._validate_size(document)
        if not document.storage_key:
            raise DocumentUnavailableError("the document has no stored original")
        with tempfile.TemporaryDirectory(prefix="bomesh-document-") as directory:
            suffix = Path(self._file_name(document)).suffix
            path = Path(directory) / f"source{suffix}"
            try:
                stored = await self._object_storage.download_to_path(
                    document.storage_key,
                    path,
                    max_bytes=self._max_processing_bytes,
                )
            except ObjectNotFoundError as exc:
                raise DocumentUnavailableError(
                    "the original file is no longer in storage"
                ) from exc
            self._validate_stored_size(document, stored.size_bytes)
            processed = await self.process_path(document, path)
            return self._canonical_content(document, processed)

    async def process_path(self, document: Item, path: Path) -> ProcessedFile:
        """Parse a local copy of one Item's stored original through the file connector.

        Whatever the parser raises is a property of the file, never a reason
        to retry.
        """

        try:
            return await asyncio.to_thread(
                self._processor.process_path,
                path,
                **self._processing_arguments(document),
            )
        except FileNoTextError as exc:
            raise DocumentProcessingError(
                "the file has no text to index; text inside images is not indexed"
                " and scanned PDFs need a configured vision model"
            ) from exc
        except FileTranscriptionError as exc:
            raise DocumentProcessingError(
                "the scanned pages could not be transcribed; run the ingestion again later"
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
        if not document.storage_key:
            raise DocumentUnavailableError("item has no raw object storage key")
        data = await self._object_storage.read(
            document.storage_key, max_bytes=MAX_INLINE_IMAGE_BYTES
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
    def _processing_arguments(cls, document: Item) -> dict[str, Any]:
        file_name = cls._file_name(document)
        return {
            "file_name": file_name,
            "item_id": str(document.id),
            "title": document.title or file_name,
            "source": cls._source_identity(document),
            "document_kind": cls._document_kind(document),
            # Retrieval is Collection-scoped; the payload carries no reader list.
            "access": AccessPolicy(),
            "hierarchy": (
                Hierarchy(parent_id=str(document.parent_item_id))
                if document.parent_item_id
                else Hierarchy()
            ),
            "metadata": cls._source_metadata(document.metadata_),
        }

    @staticmethod
    def _source_identity(document: Item) -> SourceIdentity:
        """The connector's identity for a synced Item, else the upload's own."""

        source = document.metadata_.get("source")
        if isinstance(source, Mapping):
            try:
                return SourceIdentity.model_validate(source)
            except ValueError as exc:
                raise DocumentProcessingError(
                    "the document's source identity is invalid"
                ) from exc
        return SourceIdentity(
            connector_id="upload",
            provider=SourceProvider.FILE,
            external_id=str(document.id),
        )

    @staticmethod
    def _file_name(document: Item) -> str:
        value = document.metadata_.get("file_name") or document.title or str(
            document.id
        )
        return str(value)

    @staticmethod
    def _source_metadata(
        metadata: Mapping[str, Any],
    ) -> dict[str, str | list[str]]:
        projected: dict[str, str | list[str]] = {}
        for key, value in metadata.items():
            if isinstance(value, str):
                projected[str(key)] = value
            elif isinstance(value, (list, tuple)) and all(
                isinstance(item, str) for item in value
            ):
                projected[str(key)] = list(value)
        return projected

    @staticmethod
    def _document_kind(document: Item) -> DocumentKind:
        kind = _KIND_BY_DOCUMENT_TYPE.get((document.document_type or "").casefold())
        if kind is not None:
            return kind
        normalized = (document.mime_type or "").split(";", 1)[0].strip().casefold()
        if normalized == "application/pdf":
            return DocumentKind.PDF
        if normalized in {"text/html", "application/xhtml+xml"}:
            return DocumentKind.WEB_PAGE
        return DocumentKind.DOCUMENT


__all__ = ["StoredFileContentService"]
