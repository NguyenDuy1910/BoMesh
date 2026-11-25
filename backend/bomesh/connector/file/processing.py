"""Validated file-to-Structured-Document conversion through Docling."""

from __future__ import annotations

from pathlib import Path
from zipfile import BadZipFile, ZipFile

from docling_core.types.doc import DoclingDocument, PictureItem, TableItem, TextItem

from bomesh.connector.file import (
    DEFAULT_MAX_ARCHIVE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_TEXT_CHARACTERS,
    FileNoTextError,
    FileProcessingError,
    FileSizeLimitError,
    FileTextLimitError,
    FileTranscriptionError,
    FinxFileExtensions,
    UnsupportedFileTypeError,
)
from bomesh.connector.processing import (
    DoclingProcessingError,
    DoclingProcessor,
    DoclingTranscriptionError,
    TranscriptCache,
)
from bomesh.connector.processing.vision import picture_descriptions


class FileProcessor:
    """Validate one source file and convert it into a ``DoclingDocument``.

    The document is the file's Structured Document: it is stored as is,
    chunked for retrieval and read by the content API; nothing else parses
    the file again.
    """

    def __init__(
        self,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_text_characters: int = DEFAULT_MAX_TEXT_CHARACTERS,
        max_archive_uncompressed_bytes: int = DEFAULT_MAX_ARCHIVE_BYTES,
        docling: DoclingProcessor | None = None,
    ) -> None:
        if min(max_file_bytes, max_text_characters, max_archive_uncompressed_bytes) < 1:
            raise ValueError("file processing limits must be greater than zero")
        self.max_file_bytes = max_file_bytes
        self.max_text_characters = max_text_characters
        self.max_archive_uncompressed_bytes = max_archive_uncompressed_bytes
        self._docling = docling or DoclingProcessor(
            max_file_bytes=max_file_bytes,
            max_text_characters=max_text_characters,
        )

    def parse_path(
        self,
        path: Path,
        *,
        file_name: str,
        read_images: bool = False,
        transcripts: TranscriptCache | None = None,
    ) -> DoclingDocument:
        """The validated Docling document of a local file, within the text bounds.

        ``file_name`` decides the format; ``read_images``: the vision model reads
        the text inside the file's pictures; ``transcripts``: the stored
        transcriptions of this content's scanned PDF pages.
        """
        source_path = Path(path)
        if not source_path.is_file():
            raise FileProcessingError(f"Document path is not a file: {source_path}")
        resolved_name = _file_name(file_name)
        self._validate_input(resolved_name, size_bytes=source_path.stat().st_size)
        self._validate_archive(source_path, extension=_extension(resolved_name))
        try:
            # The path's extension is retained by upload/storage flows. Avoid
            # passing a display-name override because Docling would otherwise
            # materialize a second full byte buffer solely to rename the input.
            document = self._docling.process_path(
                source_path, read_images=read_images, transcripts=transcripts
            )
        except DoclingProcessingError as exc:
            raise _file_error(exc) from exc
        characters = _text_characters(document)
        if characters > self.max_text_characters:
            raise FileTextLimitError(
                f"Extracted text exceeds {self.max_text_characters} characters: {resolved_name}"
            )
        if characters == 0:
            raise FileNoTextError(f"No extractable content found in {resolved_name}")
        return document

    def _validate_input(self, file_name: str, *, size_bytes: int) -> None:
        if size_bytes < 1:
            raise FileProcessingError(f"Document is empty: {file_name}")
        if size_bytes > self.max_file_bytes:
            raise FileSizeLimitError(
                f"File exceeds {self.max_file_bytes} byte limit: {size_bytes} bytes"
            )
        extension = _extension(file_name)
        if extension not in FinxFileExtensions.KNOWLEDGE_EXTENSIONS:
            raise UnsupportedFileTypeError(
                f"Unsupported file extension {extension or '<none>'}"
            )

    def _validate_archive(self, path: Path, *, extension: str) -> None:
        if extension not in FinxFileExtensions.OFFICE_EXTENSIONS:
            return
        try:
            with ZipFile(path) as archive:
                self._validate_archive_members(archive)
        except BadZipFile as exc:
            raise FileProcessingError("Invalid Office Open XML archive") from exc

    def _validate_archive_members(self, archive: ZipFile) -> None:
        members = archive.infolist()
        if any(member.flag_bits & 0x1 for member in members):
            raise FileProcessingError("Encrypted Office archives are not supported")
        expanded = sum(member.file_size for member in members)
        if expanded > self.max_archive_uncompressed_bytes:
            raise FileSizeLimitError(
                "Office archive expands beyond the configured size limit"
            )


def _file_error(exc: DoclingProcessingError) -> FileProcessingError:
    message = str(exc)
    if isinstance(exc, DoclingTranscriptionError):
        return FileTranscriptionError(message)
    normalized = message.casefold()
    if "unsupported file extension" in normalized:
        return UnsupportedFileTypeError(message)
    if "characters" in normalized and "exceeds" in normalized:
        return FileTextLimitError(message)
    if "byte limit" in normalized or "file exceeds" in normalized:
        return FileSizeLimitError(message)
    if "no extractable content" in normalized:
        return FileNoTextError(message)
    return FileProcessingError(message)


def _file_name(value: str) -> str:
    normalized = value.strip()
    if not normalized or "\x00" in normalized:
        raise FileProcessingError("file_name must not be blank")
    return Path(normalized).name


def _extension(file_name: str) -> str:
    return Path(file_name).suffix.casefold()


def _text_characters(document: DoclingDocument) -> int:
    """Characters of text the document holds: its texts, table cells and picture text."""
    total = 0
    for item, _ in document.iterate_items(traverse_pictures=False):
        if isinstance(item, TextItem):
            total += len(item.text.strip())
        elif isinstance(item, TableItem):
            total += sum(len(cell.text.strip()) for cell in item.data.table_cells)
        elif isinstance(item, PictureItem):
            total += sum(len(text.strip()) for text in picture_descriptions(item))
    return total


__all__ = ["FileProcessor"]
