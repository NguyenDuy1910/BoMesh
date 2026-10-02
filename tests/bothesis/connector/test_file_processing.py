from __future__ import annotations

from types import SimpleNamespace

import pytest
from docling.datamodel.base_models import (
    ConversionStatus,
    DocumentStream,
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

from bothesis.connector.file import UnsupportedFileTypeError
from bothesis.connector.file.processing import FileProcessor
from bothesis.connector.processing import (
    ApproximateTokenizer,
    DoclingChunker,
    DoclingProcessingError,
    DoclingProcessor,
    DocumentMapper,
)
from bothesis.connector.protocol import (
    DocumentItem,
    DocumentKind,
    SourceIdentity,
    SourceProvider,
    StorageObject,
    TablePart,
    TextPart,
)


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
    def __init__(self, chunks: list[DocChunk]) -> None:
        self.chunks = chunks

    def chunk(self, document: DoclingDocument):
        del document
        yield from self.chunks


class _DocumentChunker:
    """Deterministic Docling chunker used at the FileProcessor boundary."""

    def chunk(self, document: DoclingDocument):
        items = [
            item
            for item, _ in document.iterate_items(traverse_pictures=False)
            if getattr(item, "text", "").strip()
        ]
        text = "\n\n".join(str(item.text) for item in items)
        yield DocChunk(text=text, meta=DocMeta(doc_items=items))


class _WhitespaceTokenizer(BaseTokenizer):
    max_tokens: int = 8

    def count_tokens(self, text: str) -> int:
        return len(text.split())

    def get_max_tokens(self) -> int:
        return self.max_tokens

    def get_tokenizer(self):
        return self.count_tokens


def _file_processor() -> FileProcessor:
    chunker = _DocumentChunker()
    return FileProcessor(
        chunker=DoclingChunker(
            hybrid_chunker=chunker,
            line_chunker=chunker,
        )
    )


def test_file_processor_extracts_text_and_json_through_docling() -> None:
    processor = _file_processor()

    text = processor.process_bytes(b"alpha\r\n\r\nbeta", file_name="notes.txt")
    assert text.text == "alpha\n\nbeta"

    structured = processor.process_bytes(b'{"name":"Enterprise Agent"}', file_name="data.json")
    assert '"name": "Enterprise Agent"' in structured.text

    assert structured.item == structured.item.model_validate(
        structured.item.model_dump(mode="json")
    )
    assert structured.chunks[0].item_id == structured.item.id


def test_file_processor_rejects_unsupported_formats() -> None:
    with pytest.raises(UnsupportedFileTypeError):
        _file_processor().process_bytes(b"legacy", file_name="legacy.doc")
    # Images are not knowledge in this phase: nothing reaches the vision model.
    converter = _Converter(DoclingDocument(name="unused"))
    processor = FileProcessor(docling=DoclingProcessor(converter=converter))
    with pytest.raises(UnsupportedFileTypeError):
        processor.process_bytes(b"image-bytes", file_name="invoice.png")
    assert converter.calls == []


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


def _text_pdf(pages: list[list[tuple[float, float, float, str]]]) -> bytes:
    """A minimal typed PDF: each page lists (x, baseline, font size, text) in Helvetica."""

    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    kids = []
    number = 4
    for lines in pages:
        stream = "".join(
            f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n" for x, y, size, text in lines
        ).encode("latin-1")
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
        (
            "TextItem",
            1,
            "Travel requests are approved by the budget owner before booking any"
            " information is shared with vendors.",
        ),
        ("TextItem", 1, "Receipts are kept for seven years."),
    ]
    assert [page for _, page, _ in _texts(document)] == [1, 1, 1, 2, 2, 2, 3, 3, 3]
    assert converter.calls == []
    # Each paragraph keeps the box it occupies, for citation highlighting.
    paragraph = next(item for item, _ in document.iterate_items() if item.text.startswith("Travel"))
    box = paragraph.prov[0].bbox.to_top_left_origin(792)
    # Top of "Travel" (baseline 660) to the descenders of the third line (baseline 632).
    assert 60 < box.l < 80 and 118 < box.t < 128 and 155 < box.b < 165


def test_a_pdf_without_a_text_layer_has_nothing_to_index() -> None:
    scan = _text_pdf([[]])

    with pytest.raises(DoclingProcessingError, match="No extractable content"):
        DoclingProcessor().process_bytes(scan, file_name="scan.pdf")


def test_document_mapper_preserves_structure_storage_and_normalized_provenance() -> None:
    document = DoclingDocument(name="report.pdf")
    document.add_page(page_no=1, size=Size(width=200, height=400))
    document.add_heading(
        "Risk",
        level=1,
        prov=ProvenanceItem(
            page_no=1,
            bbox=DoclingBoundingBox(l=20, t=20, r=180, b=50),
            charspan=(0, 4),
        ),
    )
    document.add_text(
        label=DocItemLabel.PARAGRAPH,
        text="Past due accounts",
        prov=ProvenanceItem(
            page_no=1,
            bbox=DoclingBoundingBox(l=20, t=60, r=180, b=100),
            charspan=(0, 17),
        ),
    )
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
        data=TableData(table_cells=cells, num_rows=2, num_cols=1),
        prov=ProvenanceItem(
            page_no=1,
            bbox=DoclingBoundingBox(l=20, t=110, r=180, b=220),
            charspan=(0, 15),
        ),
    )
    caption = document.add_text(label=DocItemLabel.CAPTION, text="Trend chart")
    document.add_picture(
        caption=caption,
        annotations=[
            DescriptionAnnotation(
                text="Balances increase by month",
                provenance="test",
            )
        ],
        prov=ProvenanceItem(
            page_no=1,
            bbox=DoclingBoundingBox(l=20, t=230, r=180, b=350),
            charspan=(0, 11),
        ),
    )
    original = StorageObject(
        provider="cloudflare_r2",
        bucket="documents",
        region="auto",
        key="tenant/report.pdf",
        file_name="report.pdf",
    )

    item = DocumentMapper().to_item(
        document,
        item_id="report",
        title="Report",
        source=_file_source("report"),
        document_kind=DocumentKind.PDF,
        original=original,
    )

    table = next(part for part in item.content if isinstance(part, TablePart))
    assert table.columns == ["Account"]
    assert table.rows == [["A-100"]]
    assert table.section_path == ("Risk",)
    assert table.element_id == "p001_table_001"
    assert table.bounding_box is not None
    assert table.bounding_box.x == pytest.approx(0.1)
    assert table.bounding_box.y == pytest.approx(0.275)
    assert item.original == original
    assert "A-100" in item.get_text_content()
    assert "Balances increase by month" in item.get_text_content()


def test_docling_chunker_maps_multi_page_spans_and_preserves_chunk_text() -> None:
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
    chunk_text = "alpha\nbeta"
    chunker = DoclingChunker(
        hybrid_chunker=_Chunker(
            [
                DocChunk(
                    text=chunk_text,
                    meta=DocMeta(doc_items=[text_item], headings=["Risk"]),
                )
            ]
        )
    )

    chunk = chunker.chunk(document, item_id="cross-page")[0]

    assert chunk.chunk_text == chunk_text
    assert chunk.section_path == ["Risk"]
    assert [(span.page, span.start_offset, span.end_offset) for span in chunk.citation.spans] == [
        (1, 0, 5),
        (2, 6, 10),
    ]
    assert {span.element_id for span in chunk.citation.spans} == {"p001_para_001"}


def test_docling_chunker_preserves_source_native_part_provenance() -> None:
    item = DocumentItem(
        id="page-1",
        title="Policy",
        source=_file_source("page-1"),
        document_kind=DocumentKind.PAGE,
        content=[
            TextPart(
                text="Employees receive 20 days.",
                element_id="paragraph-7",
                page=3,
                section_path=("Benefits",),
            )
        ],
    )

    class NativeChunker:
        def chunk(self, document: DoclingDocument):
            doc_item = next(
                value
                for value, _ in document.iterate_items()
                if isinstance(value, TextItem) and value.text.startswith("Employees")
            )
            yield DocChunk(
                text=doc_item.text,
                meta=DocMeta(doc_items=[doc_item], headings=["Benefits"]),
            )

    chunk = DoclingChunker(hybrid_chunker=NativeChunker()).chunk_item(item)[0]

    assert chunk.citation.spans[0].element_id == "paragraph-7"
    assert chunk.citation.spans[0].page == 3
    assert chunk.citation.spans[0].start_offset == 0
    assert chunk.citation.spans[0].end_offset == len(chunk.chunk_text)
    configured = DoclingChunker(tokenizer=_WhitespaceTokenizer())
    assert configured._resolve_chunker("hybrid").repeat_table_header is True
    assert isinstance(configured._resolve_chunker("line"), LineBasedTokenChunker)


def test_docling_chunker_does_not_infer_offsets_from_repeated_text() -> None:
    document = DoclingDocument(name="repeated.txt")
    repeated = document.add_text(
        label=DocItemLabel.TEXT,
        text="repeat repeat",
    )
    chunker = DoclingChunker(
        hybrid_chunker=_Chunker(
            [DocChunk(text="repeat", meta=DocMeta(doc_items=[repeated]))]
        )
    )

    span = chunker.chunk(document, item_id="repeated")[0].citation.spans[0]

    assert span.element_id == "doc_para_001"
    assert span.start_offset is None
    assert span.end_offset is None


def test_docling_chunker_default_has_no_downloaded_tokenizer_model() -> None:
    chunker = DoclingChunker()

    assert isinstance(chunker._resolve_chunker("hybrid").tokenizer, ApproximateTokenizer)
    assert isinstance(chunker._resolve_chunker("line").tokenizer, ApproximateTokenizer)


def test_line_chunking_retains_exact_record_element_provenance() -> None:
    document = DoclingProcessor(converter=_Converter(DoclingDocument(name="unused"))).process_text(
        b"first record\nsecond record",
        file_name="events.log",
    )

    chunks = DoclingChunker(tokenizer=_WhitespaceTokenizer()).chunk(
        document,
        item_id="events",
        strategy="line",
    )

    assert [chunk.chunk_text for chunk in chunks] == ["first record", "second record"]
    assert [chunk.citation.spans[0].element_id for chunk in chunks] == [
        "doc_para_001",
        "doc_para_002",
    ]
    assert [
        (chunk.citation.spans[0].start_offset, chunk.citation.spans[0].end_offset)
        for chunk in chunks
    ] == [(0, 12), (0, 13)]


def _file_source(external_id: str) -> SourceIdentity:
    return SourceIdentity(
        connector_id="files",
        provider=SourceProvider.FILE,
        external_id=external_id,
    )
