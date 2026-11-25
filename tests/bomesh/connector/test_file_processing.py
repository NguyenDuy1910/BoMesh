from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

import httpx
import pytest
from docling.datamodel.base_models import (
    ConversionStatus,
    DocumentStream,
    VlmStopReason,
)
from docling_core.transforms.chunker import DocChunk, DocMeta
from docling_core.transforms.chunker.line_chunker import LineBasedTokenChunker
from docling_core.transforms.chunker.tokenizer.base import BaseTokenizer
from docling_core.types.doc import (
    BoundingBox as DoclingBoundingBox,
)
from docling_core.types.doc import (
    DescriptionAnnotation,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
    TextItem,
)
from openpyxl import Workbook
from PIL import Image as PILImage
from pptx import Presentation
from pptx.util import Inches

from bomesh.connector.file import (
    FileNoTextError,
    FileProcessingError,
    FileSizeLimitError,
    FileTextLimitError,
    FileTranscriptionError,
    UnsupportedFileTypeError,
)
from bomesh.connector.file.processing import FileProcessor
from bomesh.connector.processing import (
    ApproximateTokenizer,
    DoclingChunker,
    DoclingChunkingError,
    DoclingProcessingError,
    DoclingProcessor,
    DoclingTranscriptionError,
    VisionModel,
)
from bomesh.connector.processing.docling import transcript_key
from bomesh.connector.processing.vision import picture_descriptions, picture_reader
from bomesh.connector.protocol import Chunk
from bomesh.document_structure import StructureView

FIXTURES = Path(__file__).parent / "fixtures"


class _Converter:
    def __init__(self, document: DoclingDocument) -> None:
        self.document = document
        self.calls: list[tuple[object, dict[str, object]]] = []

    def convert(self, source: object, **kwargs: object) -> object:
        self.calls.append((source, kwargs))
        return SimpleNamespace(
            status=ConversionStatus.SUCCESS,
            errors=[],
            document=self.document,
        )


class _Chunker:
    """A Docling chunker that yields the given chunks for any document."""

    def __init__(self, chunks: list[DocChunk]) -> None:
        self.chunks = chunks

    def chunk(self, document: DoclingDocument) -> Iterator[DocChunk]:
        del document
        yield from self.chunks


class _WhitespaceTokenizer(BaseTokenizer):
    max_tokens: int = 8

    def count_tokens(self, text: str) -> int:
        return len(text.split())

    def get_max_tokens(self) -> int:
        return self.max_tokens

    def get_tokenizer(self):
        return self.count_tokens


def _file(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def _assert_cites(document: DoclingDocument, chunks: list[Chunk]) -> None:
    """Every chunk names blocks of ``document``; its quote is plain text."""

    view = StructureView(json.loads(document.model_dump_json()))
    for chunk in chunks:
        assert chunk.refs
        assert all(view.unit_index(ref) is not None for ref in chunk.refs), chunk.refs
        assert not any(mark in chunk.quote for mark in ("**", "](", "```")), chunk.quote


def test_file_processor_parses_text_and_json_into_a_docling_document(tmp_path: Path) -> None:
    processor = FileProcessor()

    text = processor.parse_path(
        _file(tmp_path, "notes.txt", b"alpha\r\n\r\nbeta"), file_name="notes.txt"
    )
    assert [item.text for item in text.texts] == ["alpha\n\nbeta"]

    structured = processor.parse_path(
        _file(tmp_path, "data.json", b'{"name":"BoMesh"}'), file_name="data.json"
    )
    assert '"name": "BoMesh"' in structured.texts[0].text
    assert DoclingDocument.model_validate_json(structured.model_dump_json()) == structured

    chunks = DoclingChunker().chunk(structured, item_id="data")
    assert [(chunk.id, chunk.item_id, chunk.refs) for chunk in chunks] == [
        ("data:0", "data", ("texts/0",))
    ]
    assert chunks[0].quote == '{ "name": "BoMesh" }'
    assert chunks[0].page is None


def test_markdown_chunks_carry_their_section_and_a_plain_quote(tmp_path: Path) -> None:
    path = _file(
        tmp_path,
        "leave.md",
        b"# Leave\n\n"
        b"Employees take **twelve** days, see [the policy](https://example.test/p).\n\n"
        b"```\nrequest_leave()\n```\n",
    )

    document = FileProcessor().parse_path(path, file_name="leave.md")
    chunks = DoclingChunker().chunk(document, item_id="leave")

    (chunk,) = chunks
    # The chunk text keeps the Markdown the embedding reads; the quote is plain.
    assert "**twelve**" in chunk.chunk_text
    assert "request_leave()" in chunk.quote
    assert chunk.quote.startswith("Employees take twelve days, see the policy")
    assert chunk.section_path == ["Leave"]
    assert chunk.location == "Leave"
    assert chunk.page is None
    _assert_cites(document, chunks)


def test_file_processor_rejects_unsupported_formats(tmp_path: Path) -> None:
    with pytest.raises(UnsupportedFileTypeError):
        FileProcessor().parse_path(_file(tmp_path, "legacy.doc", b"legacy"), file_name="legacy.doc")
    # Images are not knowledge in this phase: nothing reaches the vision model.
    converter = _Converter(DoclingDocument(name="unused"))
    processor = FileProcessor(docling=DoclingProcessor(converter=converter))
    with pytest.raises(UnsupportedFileTypeError):
        processor.parse_path(
            _file(tmp_path, "invoice.png", b"image-bytes"), file_name="invoice.png"
        )
    assert converter.calls == []


def _office_archive(members: dict[str, bytes]) -> bytes:
    data = BytesIO()
    with ZipFile(data, "w", compression=ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return data.getvalue()


def _encrypted(archive: bytes) -> bytes:
    """Set the "encrypted" flag on every central directory entry of ``archive``."""

    output = bytearray(archive)
    start = output.find(b"PK\x01\x02")
    while start != -1:
        output[start + 8] |= 0x1
        start = output.find(b"PK\x01\x02", start + 4)
    return bytes(output)


def test_file_processor_validates_size_and_office_archives_before_converting(
    tmp_path: Path,
) -> None:
    converter = _Converter(DoclingDocument(name="unused"))
    processor = FileProcessor(
        max_file_bytes=4_096,
        max_archive_uncompressed_bytes=1_024,
        docling=DoclingProcessor(converter=converter),
    )

    with pytest.raises(FileProcessingError, match="empty"):
        processor.parse_path(_file(tmp_path, "empty.txt", b""), file_name="empty.txt")
    with pytest.raises(FileSizeLimitError):
        processor.parse_path(_file(tmp_path, "large.txt", b"x" * 4_097), file_name="large.txt")
    with pytest.raises(FileProcessingError, match="Invalid Office"):
        processor.parse_path(_file(tmp_path, "broken.docx", b"not a zip"), file_name="broken.docx")
    encrypted = _encrypted(_office_archive({"word/document.xml": b"<w:document/>"}))
    with pytest.raises(FileProcessingError, match="Encrypted"):
        processor.parse_path(_file(tmp_path, "secret.docx", encrypted), file_name="secret.docx")
    bomb = _office_archive({"word/document.xml": b"\x00" * 2_048})
    with pytest.raises(FileSizeLimitError, match="Office archive"):
        processor.parse_path(_file(tmp_path, "bomb.docx", bomb), file_name="bomb.docx")
    assert converter.calls == []


def test_file_processor_bounds_the_text_a_document_holds(tmp_path: Path) -> None:
    path = _file(tmp_path, "notes.md", b"# Leave\n\nEmployees take twelve days.\n")

    # "Leave" and "Employees take twelve days." hold 32 characters.
    assert FileProcessor(max_text_characters=32).parse_path(path, file_name="notes.md").texts
    with pytest.raises(FileTextLimitError):
        FileProcessor(max_text_characters=31).parse_path(path, file_name="notes.md")
    with pytest.raises(FileNoTextError):
        FileProcessor().parse_path(_file(tmp_path, "blank.md", b"\n\n   \n"), file_name="blank.md")


def test_docling_processor_reuses_converter_and_enforces_limits() -> None:
    converted = DoclingDocument(name="policy.docx")
    converted.add_text(label=DocItemLabel.TEXT, text="Policy")
    converter = _Converter(converted)
    processor = DoclingProcessor(
        converter=converter,
        max_file_bytes=32,
        max_num_pages=8,
        page_range=(2, 5),
    )

    assert processor.process_bytes(b"PK", file_name="policy.docx") is converted
    source, arguments = converter.calls[0]
    assert isinstance(source, DocumentStream)
    assert arguments == {
        "raises_on_error": False,
        "max_num_pages": 8,
        "max_file_size": 32,
        "page_range": (2, 5),
    }
    normalized = processor.process_text(b'{"b": 2, "a": 1}', file_name="data.json")
    assert '"a": 1' in normalized.export_to_markdown()
    assert len(converter.calls) == 1

    with pytest.raises(ValueError, match="32 byte limit"):
        processor.process_bytes(b"x" * 33, file_name="large.pdf")


def _text_pdf(
    pages: list[list[tuple[float, float, float, str]]],
    *,
    scans: frozenset[int] = frozenset(),
    pictures: dict[int, tuple[float, float, float, float]] | None = None,
) -> bytes:
    """A minimal typed PDF: each page lists (x, baseline, font size, text) in Helvetica.

    A page whose 0-based index is in ``scans`` also carries a full-page image;
    one in ``pictures`` a 40×40 px gray picture drawn at (x, y, width, height).
    """

    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    kids = []
    number = 4
    for index, lines in enumerate(pages):
        stream = "".join(
            f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n" for x, y, size, text in lines
        ).encode("latin-1")
        if index in scans:
            stream += b"q 612 0 0 792 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q\n"
        if pictures and index in pictures:
            x, y, width, height = pictures[index]
            stream += b"q %g 0 0 %g %g %g cm BI /W 40 /H 40 /CS /G /BPC 8 ID " % (
                width, height, x, y
            )
            stream += b"\x80" * 1600 + b" EI Q\n"
        objects[number] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (number + 1)
        )
        objects[number + 1] = b"<< /Length %d >>\nstream\n%sendstream" % (len(stream), stream)
        kids.append(number)
        number += 2
    objects[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % kid for kid in kids),
        len(kids),
    )
    output = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for key in sorted(objects):
        offsets[key] = len(output)
        output += b"%d 0 obj\n%s\nendobj\n" % (key, objects[key])
    xref = len(output)
    output += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for key in sorted(objects):
        output += b"%010d 00000 n \n" % offsets[key]
    output += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(output)


def _handbook_page(number: int) -> list[tuple[float, float, float, str]]:
    return [
        (72, 750, 9, "ACME Employee Handbook"),
        (72, 700, 20, f"Chapter {number}"),
        (72, 660, 12, "Travel requests are approved by the"),
        (72, 646, 12, "budget owner before booking any infor-"),
        (72, 632, 12, "mation is shared with vendors."),
        (72, 590, 12, "Receipts are kept for seven years."),
        (300, 40, 9, f"Page {number}"),
    ]


_HANDBOOK_PARAGRAPH = (
    "Travel requests are approved by the budget owner before booking any"
    " information is shared with vendors."
)


def _texts(document: DoclingDocument) -> list[tuple[str, int, str]]:
    return [
        (type(item).__name__, item.prov[0].page_no, item.text)
        for item, _ in document.iterate_items()
        if isinstance(item, TextItem)
    ]


def test_a_pdf_is_read_from_its_own_text_layer_without_a_model() -> None:
    converter = _Converter(DoclingDocument(name="unused"))
    pdf = _text_pdf([_handbook_page(1), _handbook_page(2), _handbook_page(3)])

    document = DoclingProcessor(converter=converter).process_bytes(pdf, file_name="handbook.pdf")

    # Headings by size, paragraphs by spacing, a hyphenated word rejoined, and
    # the running header and page numbers dropped from every page.
    assert _texts(document)[:3] == [
        ("SectionHeaderItem", 1, "Chapter 1"),
        ("TextItem", 1, _HANDBOOK_PARAGRAPH),
        ("TextItem", 1, "Receipts are kept for seven years."),
    ]
    assert [page for _, page, _ in _texts(document)] == [1, 1, 1, 2, 2, 2, 3, 3, 3]
    assert converter.calls == []
    # Each paragraph keeps the box it occupies, for citation highlighting.
    paragraph = next(item for item, _ in document.iterate_items() if item.text.startswith("Travel"))
    box = paragraph.prov[0].bbox.to_top_left_origin(792)
    # Top of "Travel" (baseline 660) to the descenders of the third line (baseline 632).
    assert 60 < box.l < 80 and 118 < box.t < 128 and 155 < box.b < 165


def test_a_short_pdf_tells_headings_by_font_size_and_nests_them() -> None:
    # As many heading lines as body lines: a per-line median would call the
    # section headings body text.
    pdf = _text_pdf(
        [
            [
                (72, 740, 32, "Awards policy 2025"),
                (72, 700, 24, "Article 1. Scholarships"),
                (72, 672, 16, "Students with a GPA of 3.6 or more"),
                (72, 654, 16, "receive 120 percent of tuition."),
                (72, 614, 24, "Article 2. Awards"),
                (72, 586, 16, "Awards are given in November."),
            ]
        ]
    )

    document = DoclingProcessor().process_bytes(pdf, file_name="awards.pdf")

    assert [
        (type(item).__name__, getattr(item, "level", None), item.text)
        for item, _ in document.iterate_items()
        if isinstance(item, TextItem)
    ] == [
        ("SectionHeaderItem", 1, "Awards policy 2025"),
        ("SectionHeaderItem", 2, "Article 1. Scholarships"),
        ("TextItem", None, "Students with a GPA of 3.6 or more receive 120 percent of tuition."),
        ("SectionHeaderItem", 2, "Article 2. Awards"),
        ("TextItem", None, "Awards are given in November."),
    ]


@pytest.mark.parametrize("pages", [1, 3], ids=["one-page", "multi-page"])
def test_a_scan_without_a_vision_model_has_nothing_to_index(pages: int) -> None:
    # From three pages on, running headers are looked for: a scan has none.
    scan = _text_pdf([[] for _ in range(pages)], scans=frozenset(range(pages)))

    with pytest.raises(DoclingProcessingError, match="No extractable content"):
        DoclingProcessor().process_bytes(scan, file_name="scan.pdf")


class _VisionConverter:
    """Docling's VLM pipeline result shape: one transcribed paragraph per page."""

    def __init__(self, stop_reason: VlmStopReason = VlmStopReason.END_OF_SEQUENCE) -> None:
        self.page_ranges: list[tuple[int, int]] = []
        self.stop_reason = stop_reason

    def convert(self, source: object, **kwargs: object) -> object:
        first, last = kwargs["page_range"]
        self.page_ranges.append((first, last))
        document = DoclingDocument(name="scan")
        for page_no in range(first, last + 1):
            document.add_page(page_no=page_no, size=Size(width=612, height=792))
            document.add_text(
                label=DocItemLabel.TEXT,
                text=f"Transcribed page {page_no}",
                prov=ProvenanceItem(
                    page_no=page_no,
                    bbox=DoclingBoundingBox(l=0, t=792, r=612, b=0),
                    charspan=(0, 0),
                ),
            )
        pages = [
            SimpleNamespace(
                page_no=page_no,
                predictions=SimpleNamespace(
                    vlm_response=SimpleNamespace(stop_reason=self.stop_reason)
                ),
            )
            for page_no in range(first, last + 1)
        ]
        return SimpleNamespace(
            status=ConversionStatus.SUCCESS, errors=[], document=document, pages=pages
        )


def test_scanned_pages_are_transcribed_in_place_among_text_layer_pages() -> None:
    vision = _VisionConverter()
    pdf = _text_pdf(
        [_handbook_page(1), [], [], _handbook_page(4), _handbook_page(5)], scans=frozenset({1, 2})
    )

    document = DoclingProcessor(vision_converter=vision).process_bytes(pdf, file_name="mixed.pdf")

    # Only the scanned run reaches the model; typed pages keep their text layer,
    # running headers are still dropped across them, and pages keep their numbers.
    assert vision.page_ranges == [(2, 3)]
    assert [(page, text) for _, page, text in _texts(document)] == [
        (1, "Chapter 1"),
        (1, _HANDBOOK_PARAGRAPH),
        (1, "Receipts are kept for seven years."),
        (2, "Transcribed page 2"),
        (3, "Transcribed page 3"),
        (4, "Chapter 4"),
        (4, _HANDBOOK_PARAGRAPH),
        (4, "Receipts are kept for seven years."),
        (5, "Chapter 5"),
        (5, _HANDBOOK_PARAGRAPH),
        (5, "Receipts are kept for seven years."),
    ]


class _Transcripts:
    """A transcription store in memory."""

    def __init__(self) -> None:
        self.entries: dict[str, str] = {}
        self.puts: list[str] = []

    def get(self, key: str) -> str | None:
        return self.entries.get(key)

    def put(self, key: str, document_json: str) -> None:
        self.puts.append(key)
        self.entries[key] = document_json


class _BrokenTranscripts:
    def get(self, key: str) -> str | None:
        raise OSError("store unavailable")

    def put(self, key: str, document_json: str) -> None:
        raise OSError("store unavailable")


def _two_scanned_runs() -> bytes:
    return _text_pdf(
        [_handbook_page(1), [], _handbook_page(3), [], [], _handbook_page(6)],
        scans=frozenset({1, 3, 4}),
    )


def test_stored_transcriptions_are_reused_with_the_files_page_numbers(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = _file(tmp_path, "mixed.pdf", _two_scanned_runs())
    vision = _VisionConverter()
    files = FileProcessor(docling=DoclingProcessor(vision=_VISION, vision_converter=vision))
    transcripts = _Transcripts()

    with caplog.at_level(logging.INFO, logger="bomesh.connector.processing.docling"):
        first = files.parse_path(path, file_name="mixed.pdf", transcripts=transcripts)
        assert vision.page_ranges == [(2, 2), (4, 5)]
        second = files.parse_path(path, file_name="mixed.pdf", transcripts=transcripts)

    # The second pass reads both runs from the store: no model call.
    assert vision.page_ranges == [(2, 2), (4, 5)]
    assert transcripts.puts == [transcript_key(_VISION, (2, 2)), transcript_key(_VISION, (4, 5))]
    assert second.model_dump(mode="json") == first.model_dump(mode="json")
    assert [
        (page, text) for _, page, text in _texts(second) if text.startswith("Transcribed")
    ] == [(2, "Transcribed page 2"), (4, "Transcribed page 4"), (5, "Transcribed page 5")]
    chunks = DoclingChunker().chunk(second, item_id="mixed")
    assert chunks == DoclingChunker().chunk(first, item_id="mixed")
    # A chunk is on the page its first block is on, and under that block's heading.
    assert [
        (chunk.page, chunk.section_path) for chunk in chunks if "Transcribed" in chunk.chunk_text
    ] == [(1, ["Chapter 1"]), (3, ["Chapter 3"])]
    _assert_cites(second, chunks)
    assert [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("pdf transcription:")
    ] == [
        "pdf transcription: 3 scanned pages in 2 runs, 0 runs reused, 2 transcribed",
        "pdf transcription: 3 scanned pages in 2 runs, 2 runs reused, 0 transcribed",
    ]


def test_a_page_the_vision_model_did_not_finish_fails_the_file(tmp_path: Path) -> None:
    path = _file(
        tmp_path,
        "mixed.pdf",
        _text_pdf([_handbook_page(1), [], _handbook_page(3)], scans=frozenset({1})),
    )
    vision = _VisionConverter(stop_reason=VlmStopReason.LENGTH)
    files = FileProcessor(docling=DoclingProcessor(vision=_VISION, vision_converter=vision))

    with pytest.raises(FileTranscriptionError, match="Page 2"):
        files.parse_path(path, file_name="mixed.pdf")
    assert vision.page_ranges == [(2, 2)]


def test_a_transcription_key_names_the_model_and_the_run() -> None:
    key = transcript_key(_VISION, (2, 15))

    fingerprint, pages = key.split("-", 1)
    assert len(fingerprint) == 16 and int(fingerprint, 16) >= 0
    assert pages == "p00002-00015"
    assert transcript_key(_VISION, (2, 15)) == key
    assert transcript_key(replace(_VISION, model="other"), (2, 15)) != key
    assert transcript_key(replace(_VISION, max_tokens=1), (2, 15)) != key
    # Endpoint and credentials are not part of what made the transcription.
    moved = replace(_VISION, api_key="other-key", base_url="https://elsewhere.test")
    assert transcript_key(moved, (2, 15)) == key


def test_an_unreadable_stored_transcription_is_transcribed_again_and_replaced() -> None:
    vision = _VisionConverter()
    pdf = _text_pdf([_handbook_page(1), [], _handbook_page(3)], scans=frozenset({1}))
    key = transcript_key(_VISION, (2, 2))
    transcripts = _Transcripts()
    transcripts.entries[key] = '{"schema_name": "DoclingDocument", "texts": ['

    document = DoclingProcessor(vision=_VISION, vision_converter=vision).process_bytes(
        pdf, file_name="mixed.pdf", transcripts=transcripts
    )

    assert vision.page_ranges == [(2, 2)]
    assert transcripts.puts == [key]
    stored = DoclingDocument.model_validate_json(transcripts.entries[key])
    assert [(item.prov[0].page_no, item.text) for item in stored.texts] == [
        (2, "Transcribed page 2")
    ]
    assert (2, "Transcribed page 2") in [(page, text) for _, page, text in _texts(document)]


def test_a_failing_transcription_store_never_fails_processing() -> None:
    vision = _VisionConverter()
    pdf = _text_pdf([_handbook_page(1), [], _handbook_page(3)], scans=frozenset({1}))

    document = DoclingProcessor(vision=_VISION, vision_converter=vision).process_bytes(
        pdf, file_name="mixed.pdf", transcripts=_BrokenTranscripts()
    )

    assert vision.page_ranges == [(2, 2)]
    assert (2, "Transcribed page 2") in [(page, text) for _, page, text in _texts(document)]


class _Pictures:
    """The vision model: the same text for every picture, counting the calls."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    def __call__(self, png: bytes) -> str:
        assert png.startswith(b"\x89PNG")
        self.calls += 1
        return self.text


def _picture_slides(*colors: str) -> bytes:
    """A deck of slides that are only pictures (the slides of a talk saved as images)."""
    deck = Presentation()
    for color in colors:
        picture = BytesIO()
        PILImage.new("RGB", (120, 80), color).save(picture, format="PNG")
        picture.seek(0)
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        slide.shapes.add_picture(picture, Inches(1), Inches(1), Inches(6), Inches(4))
    data = BytesIO()
    deck.save(data)
    return data.getvalue()


def test_slides_of_pictures_are_read_only_when_processing_reads_images(tmp_path: Path) -> None:
    path = _file(tmp_path, "ipv6.pptx", _picture_slides("white", "white", "navy"))
    vision = _Pictures("Subnet mask 255.255.255.0")
    files = FileProcessor(docling=DoclingProcessor(picture_reader=vision))

    with pytest.raises(FileNoTextError):
        files.parse_path(path, file_name="ipv6.pptx")
    assert vision.calls == 0

    document = files.parse_path(path, file_name="ipv6.pptx", read_images=True)

    # The same picture on two slides is read once; its text is each picture's own.
    assert vision.calls == 2
    assert [picture_descriptions(picture) for picture in document.pictures] == [
        ["Subnet mask 255.255.255.0"]
    ] * 3
    assert [picture.prov[0].page_no for picture in document.pictures] == [1, 2, 3]
    chunks = DoclingChunker().chunk(document, item_id="ipv6")
    assert chunks
    assert all("Subnet mask 255.255.255.0" in chunk.chunk_text for chunk in chunks)
    assert [(chunk.content_type, chunk.refs, chunk.page) for chunk in chunks] == [
        ("image", ("pictures/0", "pictures/1", "pictures/2"), 1)
    ]
    _assert_cites(document, chunks)


def test_a_typed_pdf_page_gets_its_picture_read_in_reading_order() -> None:
    vision = _Pictures("Diagram: request, approve, book")
    page = _handbook_page(1)
    # Under the receipts line (baseline 590), above the page number.
    pdf = _text_pdf([page], pictures={0: (72, 400, 200, 150)})
    icon = _text_pdf([page], pictures={0: (72, 300, 20, 20)})
    processor = DoclingProcessor(picture_reader=vision)

    assert not processor.process_bytes(pdf, file_name="handbook.pdf").pictures
    document = processor.process_bytes(pdf, file_name="handbook.pdf", read_images=True)
    order = [
        "picture" if item.label == DocItemLabel.PICTURE else item.text
        for item, _ in document.iterate_items(traverse_pictures=False)
    ]
    assert order[order.index("Receipts are kept for seven years.") + 1] == "picture"
    (picture,) = document.pictures
    assert picture.prov[0].page_no == 1
    assert picture.meta.description.text == vision.text
    # A picture under 32 points on a side is an icon: never sent to the model.
    calls = vision.calls
    assert not processor.process_bytes(icon, file_name="icon.pdf", read_images=True).pictures
    assert vision.calls == calls


def _vision_replies(*replies: int | str) -> tuple[list[dict[str, object]], httpx.MockTransport]:
    """An endpoint answering each call in turn: a status code, or a 200 with that text."""
    calls: list[dict[str, object]] = []
    queue = list(replies)

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        reply = queue.pop(0)
        if isinstance(reply, int):
            return httpx.Response(reply, headers={"retry-after": "0"})
        choice = {"finish_reason": "stop", "message": {"content": reply}}
        return httpx.Response(200, json={"choices": [choice]})

    return calls, httpx.MockTransport(handle)


_VISION = VisionModel(api_key="key", base_url="https://vision.test/api/v1", model="vision-1")


def test_the_vision_model_is_asked_again_when_busy_and_no_text_is_nothing() -> None:
    calls, transport = _vision_replies(429, 503, "# IPv6 Features", "NO_TEXT")
    read = picture_reader(_VISION, transport=transport)

    assert read(b"png") == "# IPv6 Features"
    assert read(b"png") == ""
    assert len(calls) == 4 and calls[0]["model"] == "vision-1"


def test_a_picture_the_vision_model_never_reads_fails_the_transcription() -> None:
    calls, transport = _vision_replies(429, 429, 429, 429)

    with pytest.raises(DoclingTranscriptionError):
        picture_reader(_VISION, transport=transport)(b"png")
    assert len(calls) == 4


def test_spreadsheet_banner_rows_leave_the_table_and_the_real_header_leads_it() -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Graduation list, round 4", None, None])
    sheet.append(["Check your details before 12/07.", None, None])
    sheet.append(["No", "Student ID", "Name"])
    sheet.append([1, "09101070", "Minh"])
    sheet.append([2, "09911028", "Nghiep"])
    sheet.merge_cells("A1:C1")
    sheet.merge_cells("A2:C2")
    data = BytesIO()
    workbook.save(data)

    document = DoclingProcessor().process_bytes(data.getvalue(), file_name="list.xlsx")

    items = [item for item, _ in document.iterate_items()]
    assert [getattr(item, "text", None) for item in items[:2]] == [
        "Graduation list, round 4",
        "Check your details before 12/07.",
    ]
    (table,) = document.tables
    assert table.data.num_rows == 3
    assert [cell.text for cell in table.data.table_cells if cell.column_header] == [
        "No",
        "Student ID",
        "Name",
    ]
    chunks = DoclingChunker().chunk(document, item_id="list")
    # The name column labels the row; the numeric ones keep their column names.
    assert any("Minh: No = 1; Student ID = 09101070" in chunk.chunk_text for chunk in chunks)
    # A sheet's page number is only its index: the chunk is located by sheet name.
    assert {(chunk.location, chunk.page) for chunk in chunks} == {(sheet.title, None)}
    _assert_cites(document, chunks)


def test_small_sheets_are_chunked_apart_and_each_chunk_quotes_its_rows() -> None:
    workbook = Workbook()
    exams = workbook.active
    exams.title = "Exams"
    exams.append(["Course", "Date"])
    exams.append(["Artificial intelligence", "16/01/2026"])
    appeals = workbook.create_sheet("Appeals")
    appeals.append(["Appeal procedure", None])
    appeals.merge_cells("A1:B1")
    appeals.append(["Fee", "50,000 VND per course"])
    data = BytesIO()
    workbook.save(data)
    document = DoclingProcessor().process_bytes(data.getvalue(), file_name="exams.xlsx")

    chunks = DoclingChunker().chunk(document, item_id="exams")

    # Both sheets fit one chunk; a chunk still never joins two sheets.
    assert [chunk.location for chunk in chunks] == ["Exams", "Appeals"]
    appeal = chunks[1]
    assert appeal.quote.startswith("Appeal procedure")
    assert "50,000 VND per course" in appeal.quote
    assert "16/01/2026" not in appeal.chunk_text
    _assert_cites(document, chunks)


def _report_workbook() -> bytes:
    """A form sheet: letterhead, ruled lines, a title, a two-level header, numbered rows, notes."""

    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["C1"] = "TRƯỜNG ĐẠI HỌC SƯ PHẠM KỸ THUẬT", "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM"
    sheet["A2"], sheet["C2"] = "PHÒNG ĐẢM BẢO CHẤT LƯỢNG", "Độc lập - Tự do - Hạnh phúc"
    sheet["A3"], sheet["C3"] = "¾¾¾¾¾¾¾¾", "¾¾¾¾¾¾¾¾"
    sheet["C4"] = "TP. Hồ Chí Minh, ngày 23 tháng 10 năm 2020"
    for row in (1, 2, 3):
        sheet.merge_cells(f"A{row}:B{row}")
        sheet.merge_cells(f"C{row}:F{row}")
    sheet.merge_cells("C4:F4")
    sheet["A6"] = "TỔNG HỢP SỐ LƯỢNG CỰU SINH VIÊN THAM GIA KHẢO SÁT"
    sheet.merge_cells("A6:E6")  # one column short of the table
    sheet["D7"] = "Số lượng cập nhật"
    sheet.append(["TT", "Tên Khoa", "Số lượng cựu SV (luỹ kế)", None, None, "Tỷ lệ (%)"])
    sheet.append([None, None, "Tuần 3", "Tuần 4", "Ghi chú", None])
    sheet.merge_cells("A8:A9")
    sheet.merge_cells("B8:B9")
    sheet.merge_cells("C8:E8")
    sheet.merge_cells("F8:F9")
    sheet.append([1, "Khoa Cơ khí Động lực", 100, 111, None, 38.4083044982699])
    sheet.append([12, "Khoa Xây dựng", 73, 79, None, 59.84848484848485])
    sheet.append([None, "Cộng", 3104, 324, None, 10.438144329896907])
    for cell in ("F10", "F11", "F12"):
        sheet[cell].number_format = "0.00"
    sheet["C12"].number_format = "#,##0"
    sheet["A14"] = "1. P.ĐBCL chỉ thống kê sinh viên đã tốt nghiệp sau 1 năm."
    sheet["A15"] = "2. Đề nghị các Khoa tiếp tục đôn đốc cựu sinh viên."
    data = BytesIO()
    workbook.save(data)
    return data.getvalue()


def test_a_form_sheet_reads_as_text_around_one_table_of_named_rows() -> None:
    document = DoclingProcessor().process_bytes(_report_workbook(), file_name="report.xlsx")

    texts = [item.text for item in document.texts]
    # The letterhead reads by its blocks (issuer, then motto and date); ruled
    # lines are gone; the title and the remark lead the table; notes follow it.
    assert texts == [
        "TRƯỜNG ĐẠI HỌC SƯ PHẠM KỸ THUẬT",
        "PHÒNG ĐẢM BẢO CHẤT LƯỢNG",
        "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
        "Độc lập - Tự do - Hạnh phúc",
        "TP. Hồ Chí Minh, ngày 23 tháng 10 năm 2020",
        "TỔNG HỢP SỐ LƯỢNG CỰU SINH VIÊN THAM GIA KHẢO SÁT",
        "Số lượng cập nhật",
        "1. P.ĐBCL chỉ thống kê sinh viên đã tốt nghiệp sau 1 năm.",
        "2. Đề nghị các Khoa tiếp tục đôn đốc cựu sinh viên.",
    ]
    assert len(document.tables) == 1

    chunks = DoclingChunker().chunk(document, item_id="report")

    rows = "\n".join(chunk.chunk_text for chunk in chunks)
    # Each row is named by its faculty, each value by both header levels, as the sheet shows it.
    assert (
        "Khoa Xây dựng: TT = 12; Số lượng cựu SV (luỹ kế) – Tuần 3 = 73; "
        "Số lượng cựu SV (luỹ kế) – Tuần 4 = 79; Tỷ lệ (%) = 59.85"
    ) in rows
    assert "Khoa Cơ khí Động lực: TT = 1; Số lượng cựu SV (luỹ kế) – Tuần 3 = 100;" in rows
    assert "Cộng: Số lượng cựu SV (luỹ kế) – Tuần 3 = 3,104;" in rows
    assert "¾" not in rows and "TỔNG HỢP SỐ LƯỢNG CỰU SINH VIÊN THAM GIA KHẢO SÁT =" not in rows
    # Chunks are joined by line breaks above, so a row cut across chunks fails the checks.
    _assert_cites(document, chunks)


def test_a_sparse_survey_sheet_reads_as_one_table_of_respondents() -> None:
    # One row per respondent, a 1 under the chosen option: Docling reads the
    # table whole, and again each 1 that touches no other cell as a table.
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"], sheet["C1"] = "STT", "Ngành", "Câu 1. Hài lòng?"
    sheet["C2"], sheet["D2"], sheet["E2"] = "Có", "Không", "Phân vân"
    for cells in ("A1:A2", "B1:B2", "C1:E1"):
        sheet.merge_cells(cells)
    for number, column in enumerate("CEDCED", start=1):
        sheet[f"A{number + 2}"], sheet[f"B{number + 2}"] = number, "Xây dựng"
        sheet[f"{column}{number + 2}"] = 1
    data = BytesIO()
    workbook.save(data)

    document = DoclingProcessor().process_bytes(data.getvalue(), file_name="survey.xlsx")
    chunks = DoclingChunker().chunk(document, item_id="survey")

    # The table is read once: no stray "1" beside it.
    assert len(document.tables) == 1
    assert document.texts == []
    rows = "\n".join(chunk.chunk_text for chunk in chunks)
    assert "Xây dựng: STT = 2; Câu 1. Hài lòng? – Phân vân = 1" in rows
    assert "Xây dựng: STT = 3; Câu 1. Hài lòng? – Không = 1" in rows
    _assert_cites(document, chunks)


def test_an_excel_97_workbook_is_read_as_a_workbook_with_its_formats() -> None:
    # A letterhead touching the table, a title merged over two rows, a date
    # column and a two-decimal column: what the university's .xls lists hold.
    path = FIXTURES / "warning_list.xls"

    document = FileProcessor().parse_path(path, file_name=path.name)
    chunks = DoclingChunker().chunk(document, item_id="warnings")

    assert [item.text for item in document.texts] == [
        "TRƯỜNG ĐẠI HỌC SƯ PHẠM KỸ THUẬT",
        "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
        "DANH SÁCH SINH VIÊN DỰ KIẾN CẢNH BÁO",
    ]
    rows = [line for chunk in chunks for line in chunk.chunk_text.splitlines()]
    assert "Lê Quang: STT = 1; MSSV = 21104021; Tên = Minh; Ngày sinh = 07/07/2003; Điểm TBC = 0.92" in rows
    assert chunks[-1].location == "Danh sách" and chunks[-1].page is None
    _assert_cites(document, chunks)


def test_a_row_too_long_for_a_chunk_names_its_row_in_every_part() -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Respondent", *(f"Question {number} about the graduate's first job" for number in range(40))])
    sheet.append(["Lan", *(f"answer {number}" for number in range(40))])
    data = BytesIO()
    workbook.save(data)
    document = DoclingProcessor().process_bytes(data.getvalue(), file_name="answers.xlsx")

    chunks = DoclingChunker().chunk(document, item_id="answers")

    lines = [line for chunk in chunks for line in chunk.chunk_text.splitlines() if line.strip()]
    assert len(lines) > 1
    identity = "Lan: Question 0 about the graduate's first job = answer 0"
    assert all(line.startswith(identity) for line in lines)
    answers = [part for line in lines for part in line.split("; ") if part != identity]
    assert answers == [
        f"Question {number} about the graduate's first job = answer {number}" for number in range(1, 40)
    ]


def _report() -> DoclingDocument:
    """One PDF page: a heading, a paragraph, a table and a captioned, described picture."""

    def on_page(top: float, bottom: float) -> ProvenanceItem:
        return ProvenanceItem(
            page_no=1,
            bbox=DoclingBoundingBox(l=20, t=top, r=180, b=bottom),
            charspan=(0, 0),
        )

    document = DoclingDocument(name="report.pdf")
    document.add_page(page_no=1, size=Size(width=200, height=400))
    document.add_heading("Risk", level=1, prov=on_page(20, 50))
    document.add_text(label=DocItemLabel.PARAGRAPH, text="Past due accounts", prov=on_page(60, 100))
    cells = [
        TableCell(
            start_row_offset_idx=0,
            end_row_offset_idx=1,
            start_col_offset_idx=0,
            end_col_offset_idx=1,
            text="Account",
            column_header=True,
        ),
        TableCell(
            start_row_offset_idx=1,
            end_row_offset_idx=2,
            start_col_offset_idx=0,
            end_col_offset_idx=1,
            text="A-100",
        ),
    ]
    document.add_table(
        data=TableData(table_cells=cells, num_rows=2, num_cols=1), prov=on_page(110, 220)
    )
    caption = document.add_text(label=DocItemLabel.CAPTION, text="Trend chart")
    document.add_picture(
        caption=caption,
        annotations=[DescriptionAnnotation(text="Balances increase by month", provenance="test")],
        prov=on_page(230, 350),
    )
    return document


def test_chunks_name_the_blocks_they_were_cut_from_with_section_and_page() -> None:
    document = _report()

    chunks = DoclingChunker().chunk(document, item_id="report")

    (chunk,) = chunks
    assert chunk.id == "report:0"
    assert chunk.content_type == "mixed"
    # The caption is shown in its picture's block: it is cited through the picture.
    assert chunk.refs == ("texts/1", "tables/0", "pictures/0")
    assert "A-100" in chunk.chunk_text
    assert "Balances increase by month" in chunk.chunk_text
    # The table speaks through its rows, as the chunker serializes them.
    assert chunk.quote == "Past due accounts Account = A-100 Trend chart"
    assert chunk.section_path == ["Risk"]
    assert chunk.location == "Risk"
    assert chunk.page == 1
    _assert_cites(document, chunks)


def test_a_chunk_of_many_tiny_blocks_is_cut_so_each_part_can_be_cited() -> None:
    # A sparse sheet's scattered cells: many one-word blocks fit one chunk's tokens.
    document = DoclingDocument(name="sparse.md")
    document.add_heading(text="Answers", level=1)
    for number in range(150):
        document.add_text(label=DocItemLabel.PARAGRAPH, text=f"a{number}")

    chunks = DoclingChunker().chunk(document, item_id="sparse")

    assert [len(chunk.refs) for chunk in chunks] == [64, 64, 22]
    cited = [ref for chunk in chunks for ref in chunk.refs]
    assert cited == [f"texts/{number}" for number in range(1, 151)]
    assert chunks[1].chunk_text.splitlines() == [f"a{number}" for number in range(64, 128)]
    assert all(chunk.section_path == ["Answers"] for chunk in chunks)
    _assert_cites(document, chunks)


def test_a_sparse_sheet_is_cut_without_writing_its_split_table_out_whole() -> None:
    # A table, then scattered one-cell answers: the table's last rows and the
    # answers share a chunk of more blocks than a citation names.
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Answers"
    sheet.append(["Name", "Score", "Note"])
    for number in range(120):
        sheet.append([f"Student {number}", number, f"note {number}"])
    for row in range(124, 400, 2):
        sheet.cell(row=row, column=1 + (row // 2) % 5 * 2, value=1)
    data = BytesIO()
    workbook.save(data)
    document = DoclingProcessor().process_bytes(data.getvalue(), file_name="sparse.xlsx")
    tokenizer = ApproximateTokenizer()

    chunks = DoclingChunker(tokenizer=tokenizer).chunk(document, item_id="sparse")

    assert max(len(chunk.refs) for chunk in chunks) == 64
    assert all(
        tokenizer.count_tokens(chunk.chunk_text) <= tokenizer.get_max_tokens() for chunk in chunks
    )
    rows = [line for chunk in chunks for line in chunk.chunk_text.splitlines() if "Student" in line]
    assert len(rows) == len(set(rows)) == 120
    _assert_cites(document, chunks)


def test_a_chunk_spanning_pages_is_on_the_page_it_starts_and_quotes_plain_text() -> None:
    document = DoclingDocument(name="cross-page.pdf")
    document.add_page(page_no=1, size=Size(width=100, height=100))
    document.add_page(page_no=2, size=Size(width=100, height=100))
    text_item = document.add_text(
        label=DocItemLabel.PARAGRAPH,
        text="alpha\nbeta",
        prov=ProvenanceItem(
            page_no=1,
            bbox=DoclingBoundingBox(l=0, t=0, r=100, b=40),
            charspan=(0, 5),
        ),
    )
    text_item.prov.append(
        ProvenanceItem(
            page_no=2,
            bbox=DoclingBoundingBox(l=0, t=0, r=100, b=40),
            charspan=(6, 10),
        )
    )
    chunker = DoclingChunker(
        hybrid_chunker=_Chunker(
            [DocChunk(text="alpha\nbeta", meta=DocMeta(doc_items=[text_item], headings=["Risk"]))]
        )
    )

    (chunk,) = chunker.chunk(document, item_id="cross-page")

    assert chunk.chunk_text == "alpha\nbeta"
    assert chunk.refs == ("texts/0",)
    assert chunk.quote == "alpha beta"
    assert chunk.section_path == ["Risk"]
    assert chunk.location == "Risk"
    assert chunk.page == 1


def test_a_chunk_cut_from_part_of_a_block_quotes_only_its_part() -> None:
    document = DoclingDocument(name="repeated.txt")
    repeated = document.add_text(label=DocItemLabel.TEXT, text="repeat once, repeat twice")
    chunker = DoclingChunker(
        hybrid_chunker=_Chunker(
            [
                DocChunk(text="repeat once,", meta=DocMeta(doc_items=[repeated])),
                DocChunk(text="repeat twice", meta=DocMeta(doc_items=[repeated])),
            ]
        )
    )

    chunks = chunker.chunk(document, item_id="repeated")

    assert [(chunk.refs, chunk.quote, chunk.page) for chunk in chunks] == [
        (("texts/0",), "repeat once,", None),
        (("texts/0",), "repeat twice", None),
    ]


def test_a_document_without_indexable_chunks_fails_chunking() -> None:
    document = DoclingDocument(name="empty.txt")
    words = document.add_text(label=DocItemLabel.TEXT, text="words")
    chunker = DoclingChunker(
        hybrid_chunker=_Chunker([DocChunk(text="   ", meta=DocMeta(doc_items=[words]))])
    )

    with pytest.raises(DoclingChunkingError, match="no indexable content"):
        chunker.chunk(document, item_id="empty")


def test_docling_chunker_repeats_table_headers_without_a_downloaded_tokenizer_model() -> None:
    chunker = DoclingChunker()

    assert isinstance(chunker._resolve_chunker("hybrid").tokenizer, ApproximateTokenizer)
    assert chunker._resolve_chunker("hybrid").repeat_table_header is True
    assert isinstance(chunker._resolve_chunker("line"), LineBasedTokenChunker)
    assert isinstance(chunker._resolve_chunker("line").tokenizer, ApproximateTokenizer)
    configured = DoclingChunker(tokenizer=_WhitespaceTokenizer())
    assert isinstance(configured._resolve_chunker("hybrid").tokenizer, _WhitespaceTokenizer)


def test_line_chunking_cites_each_record_block(tmp_path: Path) -> None:
    path = _file(tmp_path, "events.log", b"first record\nsecond record")
    document = FileProcessor().parse_path(path, file_name="events.log")

    chunks = DoclingChunker(tokenizer=_WhitespaceTokenizer()).chunk(
        document,
        item_id="events",
        strategy="line",
    )

    assert [(chunk.chunk_text, chunk.refs, chunk.quote) for chunk in chunks] == [
        ("first record", ("texts/0",), "first record"),
        ("second record", ("texts/1",), "second record"),
    ]
    _assert_cites(document, chunks)
