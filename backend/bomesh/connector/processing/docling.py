"""Docling conversion at the connector boundary.

Office, HTML, Markdown and CSV go through Docling's declarative backends;
plain-text formats are built directly. A PDF is read from its own text layer
(``pdf_text``); its scanned pages, when a vision model is configured, are
transcribed by Docling's VLM pipeline with that model (``PdfVision``). That is
the only model call here, and no model weights are ever loaded.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from io import BytesIO
from itertools import groupby
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from docling.datamodel.base_models import (
    ConversionStatus,
    DocumentStream,
    InputFormat,
    VlmStopReason,
)
from docling.datamodel.pipeline_options import VlmConvertOptions, VlmPipelineOptions
from docling.datamodel.pipeline_options_vlm_model import ResponseFormat
from docling.datamodel.stage_model_specs import VlmModelSpec
from docling.datamodel.vlm_engine_options import ApiVlmEngineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.models.inference_engines.vlm.base import VlmEngineType
from docling.pipeline.vlm_pipeline import VlmPipeline
from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DescriptionAnnotation,
    DocItem,
    DocItemLabel,
    DoclingDocument,
    PictureItem,
    ProvenanceItem,
    TableData,
    TableItem,
    TextItem,
)

from . import DoclingProcessingError, DoclingTranscriptionError
from .pdf_text import pdf_text_document, scanned_pages

log = logging.getLogger(__name__)


_DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
_DEFAULT_MAX_TEXT_CHARACTERS = 2_000_000
_DEFAULT_MAX_PAGES = 1_000

_PLAIN_TEXT_EXTENSIONS = frozenset(
    {
        ".json",
        ".jsonl",
        ".log",
        ".rst",
        ".sql",
        ".tsv",
        ".txt",
        ".xml",
        ".yaml",
        ".yml",
    }
)
_LINE_SENSITIVE_EXTENSIONS = frozenset({".jsonl", ".log", ".sql", ".tsv"})
#: Read from the file's own text layer, never by a model.
_PDF_EXTENSIONS = frozenset({".pdf"})
_CONVERTER_EXTENSIONS = frozenset(
    {
        ".csv",
        ".docx",
        ".htm",
        ".html",
        ".markdown",
        ".md",
        ".pptx",
        ".xlsx",
    }
)
#: Docling parses the page's Markdown natively (headings, lists, tables). A
#: grounded format with per-block boxes keeps only the first line of a block,
#: and vision models write a block's lines on separate lines.
_TRANSCRIPTION_PROMPT = (
    "Convert this page to Markdown. Transcribe every visible text exactly, in "
    "reading order and in its original language; use Markdown headings, lists "
    "and tables. Do not summarize, translate, omit or invent anything. Output "
    "only the Markdown."
)
#: Past these the model stopped reading the page (a runaway repetition, or
#: content withheld), so the transcription is not the page.
_INCOMPLETE_STOP_REASONS = frozenset({VlmStopReason.LENGTH, VlmStopReason.CONTENT_FILTERED})


@dataclass(frozen=True, slots=True)
class PdfVision:
    """The configured vision model that transcribes scanned PDF pages."""

    api_key: str
    base_url: str
    model: str
    timeout_seconds: float = 120.0
    concurrency: int = 2
    max_tokens: int = 8192

    def __post_init__(self) -> None:
        if not self.api_key.strip() or not self.model.strip():
            raise ValueError("PDF vision needs an API key and a model")
        if self.timeout_seconds <= 0 or self.concurrency < 1 or self.max_tokens < 1:
            raise ValueError("PDF vision limits must be positive")



class DoclingProcessor:
    """Convert bounded inputs; only scanned PDF pages reach a (configured) model."""

    def __init__(
        self,
        *,
        converter: Any | None = None,
        do_ocr: bool = True,
        do_table_structure: bool = True,
        do_picture_description: bool = False,
        max_file_bytes: int = _DEFAULT_MAX_FILE_BYTES,
        max_text_characters: int = _DEFAULT_MAX_TEXT_CHARACTERS,
        max_num_pages: int = _DEFAULT_MAX_PAGES,
        page_range: tuple[int, int] | None = None,
        allow_partial: bool = False,
        vision: PdfVision | None = None,
        vision_converter: Any | None = None,
    ) -> None:
        if max_file_bytes < 1:
            raise ValueError("max_file_bytes must be positive")
        if max_text_characters < 1:
            raise ValueError("max_text_characters must be positive")
        if max_num_pages < 1:
            raise ValueError("max_num_pages must be positive")
        resolved_page_range = page_range or (1, max_num_pages)
        if (
            len(resolved_page_range) != 2
            or resolved_page_range[0] < 1
            or resolved_page_range[1] < resolved_page_range[0]
        ):
            raise ValueError("page_range must be an inclusive positive (start, end) pair")
        if resolved_page_range[1] - resolved_page_range[0] + 1 > max_num_pages:
            raise ValueError("page_range cannot contain more than max_num_pages")

        self.max_file_bytes = max_file_bytes
        self.max_text_characters = max_text_characters
        self.max_num_pages = max_num_pages
        self.page_range = resolved_page_range
        self.allow_partial = allow_partial
        self._converter = converter
        self._vision = vision
        self._vision_converter = vision_converter
        # Retain the former keyword arguments as a stable public interface;
        # no layout or OCR model stage runs, so none of them changes anything.
        del do_ocr, do_table_structure, do_picture_description

    def process_path(
        self,
        path: str | Path,
        *,
        file_name: str | None = None,
    ) -> DoclingDocument:
        source = Path(path)
        if not source.is_file():
            raise DoclingProcessingError(f"Document path is not a file: {source}")
        self._validate_size(source.stat().st_size, file_name=file_name or source.name)
        resolved_name = _file_name(file_name or source.name)
        if _extension(resolved_name) in _PLAIN_TEXT_EXTENSIONS:
            return self.process_text(source.read_bytes(), file_name=resolved_name)
        if _extension(resolved_name) in _PDF_EXTENSIONS:
            return self._pdf(source, file_name=resolved_name)
        if (
            file_name is not None
            and _extension(resolved_name) != _extension(source.name)
        ) or _extension(resolved_name) in {".htm", ".markdown"}:
            return self.process_bytes(source.read_bytes(), file_name=resolved_name)
        self._validate_converter_extension(resolved_name)
        return self._convert(source, file_name=resolved_name)

    def process_bytes(self, data: bytes, *, file_name: str) -> DoclingDocument:
        resolved_name = _file_name(file_name)
        self._validate_size(len(data), file_name=resolved_name)
        if not data:
            raise DoclingProcessingError(f"Document is empty: {resolved_name}")
        if _extension(resolved_name) in _PLAIN_TEXT_EXTENSIONS:
            return self.process_text(data, file_name=resolved_name)
        if _extension(resolved_name) in _PDF_EXTENSIONS:
            return self._pdf(data, file_name=resolved_name)
        self._validate_converter_extension(resolved_name)
        stream = DocumentStream(name=_converter_file_name(resolved_name), stream=BytesIO(data))
        return self._convert(stream, file_name=resolved_name)

    def process_text(self, data: bytes, *, file_name: str) -> DoclingDocument:
        """Build a Docling document for formats without a Docling backend."""

        resolved_name = _file_name(file_name)
        extension = _extension(resolved_name)
        if extension not in _PLAIN_TEXT_EXTENSIONS:
            raise DoclingProcessingError(
                f"Text processing does not support extension {extension or '<none>'}"
            )
        self._validate_size(len(data), file_name=resolved_name)
        if not data:
            raise DoclingProcessingError(f"Document is empty: {resolved_name}")
        try:
            decoded = _decode_text(data)
            text = _normalized_text(decoded, extension=extension)
        except (UnicodeError, json.JSONDecodeError, ElementTree.ParseError) as exc:
            raise DoclingProcessingError(
                f"Invalid {extension.removeprefix('.').upper()} document: {resolved_name}"
            ) from exc
        if len(text) > self.max_text_characters:
            raise DoclingProcessingError(
                f"Extracted text exceeds {self.max_text_characters} characters: {resolved_name}"
            )
        if not text:
            raise DoclingProcessingError(
                f"No extractable content found in {resolved_name}"
            )
        document = DoclingDocument(name=resolved_name)
        if extension in _LINE_SENSITIVE_EXTENSIONS:
            for line in text.splitlines():
                if line.strip():
                    document.add_text(label=DocItemLabel.TEXT, text=line)
        else:
            document.add_text(label=DocItemLabel.TEXT, text=text)
        return document

    def _pdf(self, source: Path | bytes, *, file_name: str) -> DoclingDocument:
        """The text layer, with every run of scanned pages transcribed in its place.

        Without a configured vision model scanned pages contribute nothing, so
        a fully scanned PDF has no extractable content.
        """

        pages, scans = scanned_pages(
            source, name=file_name, page_range=self.page_range, max_pages=self.max_num_pages
        )
        # One pass over the whole range, so running headers are recognized
        # across every typed page, not per run.
        text_layer = pdf_text_document(
            source, name=file_name, page_range=self.page_range, max_pages=self.max_num_pages
        )
        if not scans or (self._vision is None and self._vision_converter is None):
            return self._checked(text_layer, file_name=file_name)
        parts = []
        for scanned, run in groupby(pages, key=scans.__contains__):
            numbers = list(run)
            parts.append(
                self._transcribe(source, file_name=file_name, page_range=(numbers[0], numbers[-1]))
                if scanned
                else text_layer.filter(page_nrs=set(numbers))
            )
        # Every part holds each page of its run under the file's page number,
        # so concatenation (which moves a part to follow the previous one's
        # last page) keeps the file's page numbers.
        document = parts[0] if len(parts) == 1 else DoclingDocument.concatenate(parts)
        return self._checked(document, file_name=file_name)

    def _transcribe(
        self, source: Path | bytes, *, file_name: str, page_range: tuple[int, int]
    ) -> DoclingDocument:
        if self._vision_converter is None:
            assert self._vision is not None
            self._vision_converter = _vision_converter(self._vision)
        stream = (
            source
            if isinstance(source, Path)
            else DocumentStream(name=file_name, stream=BytesIO(source))
        )
        try:
            result = self._vision_converter.convert(
                stream,
                raises_on_error=False,
                max_num_pages=self.max_num_pages,
                max_file_size=self.max_file_bytes,
                page_range=page_range,
            )
        except Exception as exc:
            raise DoclingTranscriptionError(f"Docling could not transcribe {file_name}") from exc
        status = getattr(result, "status", None)
        if status != ConversionStatus.SUCCESS:
            detail = _conversion_error_detail(getattr(result, "errors", ()))
            status_value = getattr(status, "value", str(status or "unknown"))
            suffix = f": {detail}" if detail else ""
            raise DoclingTranscriptionError(
                f"Docling transcription {status_value} for {file_name}{suffix}"
            )
        unfinished = [
            page.page_no
            for page in result.pages
            if page.predictions.vlm_response is not None
            and page.predictions.vlm_response.stop_reason in _INCOMPLETE_STOP_REASONS
        ]
        if unfinished:
            raise DoclingTranscriptionError(
                f"Page {', '.join(map(str, unfinished))} of {file_name} could not be"
                " transcribed completely"
            )
        return result.document

    def _convert(self, source: Any, *, file_name: str) -> DoclingDocument:
        if self._converter is None:
            self._converter = _configured_converter()
        try:
            result = self._converter.convert(
                source,
                raises_on_error=False,
                max_num_pages=self.max_num_pages,
                max_file_size=self.max_file_bytes,
                page_range=self.page_range,
            )
        except Exception as exc:
            raise DoclingProcessingError(
                f"Docling could not process {file_name}"
            ) from exc
        status = getattr(result, "status", None)
        successful = status == ConversionStatus.SUCCESS
        partial = status == ConversionStatus.PARTIAL_SUCCESS
        if not successful and not (partial and self.allow_partial):
            detail = _conversion_error_detail(getattr(result, "errors", ()))
            status_value = getattr(status, "value", str(status or "unknown"))
            suffix = f": {detail}" if detail else ""
            raise DoclingProcessingError(
                f"Docling conversion {status_value} for {file_name}{suffix}"
            )
        document = getattr(result, "document", None)
        if not isinstance(document, DoclingDocument):
            raise DoclingProcessingError(
                f"Docling returned no document for {file_name}"
            )
        if _extension(file_name) == ".xlsx":
            _lift_banner_rows(document)
        return self._checked(document, file_name=file_name)

    def _checked(self, document: DoclingDocument, *, file_name: str) -> DoclingDocument:
        if not any(
            isinstance(item, DocItem)
            for item, _ in document.iterate_items(traverse_pictures=False)
        ):
            raise DoclingProcessingError(
                f"No extractable content found in {file_name}"
            )
        text_characters = _document_text_characters(document)
        if text_characters > self.max_text_characters:
            raise DoclingProcessingError(
                f"Extracted text exceeds {self.max_text_characters} characters: {file_name}"
            )
        return document

    def _validate_size(self, size_bytes: int, *, file_name: str) -> None:
        if size_bytes > self.max_file_bytes:
            raise DoclingProcessingError(
                f"File exceeds {self.max_file_bytes} byte limit: {file_name}"
            )

    @staticmethod
    def _validate_converter_extension(file_name: str) -> None:
        extension = _extension(file_name)
        if extension not in _CONVERTER_EXTENSIONS:
            raise DoclingProcessingError(
                f"Unsupported file extension {extension or '<none>'}"
            )


def _configured_converter() -> DocumentConverter:
    """Docling's declarative backends only: no PDF pipeline, so no model."""

    return DocumentConverter(
        allowed_formats=[
            InputFormat.DOCX,
            InputFormat.PPTX,
            InputFormat.XLSX,
            InputFormat.HTML,
            InputFormat.MD,
            InputFormat.CSV,
        ]
    )


def _vision_converter(vision: PdfVision) -> DocumentConverter:
    """Docling's VLM pipeline over the configured OpenAI-compatible endpoint."""

    engine = ApiVlmEngineOptions(
        engine_type=VlmEngineType.API,
        url=f"{vision.base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {vision.api_key}"},
        params={"model": vision.model, "max_tokens": vision.max_tokens},
        timeout=vision.timeout_seconds,
        concurrency=vision.concurrency,
    )
    model = VlmModelSpec(
        name="BoMesh page transcription",
        default_repo_id=vision.model,
        prompt=_TRANSCRIPTION_PROMPT,
        response_format=ResponseFormat.MARKDOWN,
        supported_engines={VlmEngineType.API},
        temperature=0.0,
        max_new_tokens=vision.max_tokens,
    )
    options = VlmPipelineOptions(
        vlm_options=VlmConvertOptions(
            engine_options=engine, model_spec=model, batch_size=vision.concurrency
        ),
        enable_remote_services=True,
        generate_page_images=False,
        generate_picture_images=False,
    )
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_cls=VlmPipeline, pipeline_options=options)
        },
    )


def _lift_banner_rows(document: DoclingDocument) -> None:
    """Move a sheet's merged banner rows (title, notes) out of its tables.

    Docling's xlsx backend lifts one merged title row above a table, but a
    sheet with a title *and* a notes row keeps both inside it and takes the
    title as the column header, so every cell is chunked and cited as
    "<title> = value". Each leading row whose only text is one cell merged
    across columns becomes a text item before the table, and the first real
    row (at least two filled cells) becomes the header.
    """

    for table in list(document.tables):
        data = table.data
        banners = []
        row = 0
        while row < data.num_rows - 2:
            filled = [
                cell
                for cell in data.table_cells
                if cell.start_row_offset_idx == row and cell.text.strip()
            ]
            if len(filled) != 1 or filled[0].col_span < 2 or filled[0].row_span != 1:
                break
            banners.append(filled[0])
            row += 1
        header = sum(
            1
            for cell in data.table_cells
            if cell.start_row_offset_idx == row and cell.text.strip()
        )
        straddling = any(
            cell.start_row_offset_idx < row < cell.end_row_offset_idx
            for cell in data.table_cells
        )
        if not banners or header < 2 or straddling:
            continue
        table.data = TableData(
            num_rows=data.num_rows - row,
            num_cols=data.num_cols,
            table_cells=[
                cell.model_copy(
                    update={
                        "start_row_offset_idx": cell.start_row_offset_idx - row,
                        "end_row_offset_idx": cell.end_row_offset_idx - row,
                        "column_header": cell.start_row_offset_idx == row,
                    }
                )
                for cell in data.table_cells
                if cell.start_row_offset_idx >= row
            ],
        )
        origin = table.prov[0] if table.prov else None
        for banner in banners:
            prov = None
            if origin is not None:
                top = origin.bbox.t + banner.start_row_offset_idx
                left = origin.bbox.l + banner.start_col_offset_idx
                prov = ProvenanceItem(
                    page_no=origin.page_no,
                    charspan=(0, 0),
                    bbox=BoundingBox(
                        l=left,
                        t=top,
                        r=left + banner.col_span,
                        b=top + 1,
                        coord_origin=CoordOrigin.TOPLEFT,
                    ),
                )
            document.insert_text(
                sibling=table,
                label=DocItemLabel.TEXT,
                text=banner.text,
                prov=prov,
                content_layer=table.content_layer,
                after=False,
            )
        if origin is not None:
            origin.bbox = origin.bbox.model_copy(update={"t": origin.bbox.t + row})


def _decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        value = data.decode("utf-16")
    else:
        value = data.decode("utf-8-sig")
    if "\x00" in value:
        raise UnicodeError("text document contains null bytes")
    return value


def _normalized_text(value: str, *, extension: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if extension == ".json":
        return json.dumps(
            json.loads(value),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    if extension == ".jsonl":
        return "\n".join(
            json.dumps(
                json.loads(line),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            for line in value.splitlines()
            if line.strip()
        )
    if extension == ".xml":
        root = ElementTree.fromstring(value)
        return "\n".join(text.strip() for text in root.itertext() if text.strip())
    return value.strip()


def _conversion_error_detail(errors: Any) -> str:
    values = []
    for error in errors or ():
        message = str(getattr(error, "error_message", "") or "").strip()
        if message:
            values.append(message)
    return "; ".join(values[:3])


def _document_text_characters(document: DoclingDocument) -> int:
    total = 0
    for item, _ in document.iterate_items(traverse_pictures=False):
        if isinstance(item, TextItem):
            total += len(item.text)
        elif isinstance(item, TableItem):
            total += sum(len(cell.text) for cell in item.data.table_cells)
        elif isinstance(item, PictureItem):
            total += sum(
                len(annotation.text)
                for annotation in item.__dict__.get("annotations", ())
                if isinstance(annotation, DescriptionAnnotation)
            )
    return total


def _file_name(value: str) -> str:
    normalized = value.strip()
    if not normalized or "\x00" in normalized:
        raise DoclingProcessingError("file_name must not be blank")
    return Path(normalized).name


def _extension(file_name: str) -> str:
    return Path(file_name).suffix.casefold()


def _converter_file_name(file_name: str) -> str:
    extension = _extension(file_name)
    if extension == ".markdown":
        return f"{Path(file_name).stem}.md"
    if extension == ".htm":
        return f"{Path(file_name).stem}.html"
    return file_name


__all__ = ["DoclingProcessor", "PdfVision"]
