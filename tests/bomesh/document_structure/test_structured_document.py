"""The Structured Document: block layout, references, codec and pictures.

Fixtures are generated files parsed by the production DoclingProcessor, so the
tests pin how real Docling output is laid out, referenced and stored.
"""

from __future__ import annotations

import gzip
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pytest
from docx import Document as WordDocument
from docx.shared import Inches
from openpyxl import Workbook
from PIL import Image

from bomesh.connector.processing import ApproximateTokenizer
from bomesh.connector.processing.chunking import DoclingChunker
from bomesh.connector.processing.docling import DoclingProcessor
from bomesh.document_structure import (
    CitationTarget,
    NodeKind,
    ParseProfile,
    StructureRef,
    StructureView,
    decode_document,
    decode_json,
    encode,
    externalize_pictures,
)

MARKDOWN = """# Quy chế đào tạo

## 1. Phạm vi

Văn bản áp dụng cho sinh viên chính quy.

- Mục **một** có [liên kết](https://example.edu.vn/quy-che)
- Mục hai

## 13. Ngày phê duyệt lần đầu

09/12/2022
"""


@pytest.fixture(scope="module")
def processor() -> DoclingProcessor:
    return DoclingProcessor()


def _parse(processor: DoclingProcessor, path: Path):
    return processor.process_path(path)


def _markdown(tmp_path: Path) -> Path:
    path = tmp_path / "rules.md"
    path.write_text(MARKDOWN, encoding="utf-8")
    return path


def _docx(tmp_path: Path, *, picture: bytes | None = None, pictures: int = 1) -> Path:
    document = WordDocument()
    document.add_heading("Tờ hướng dẫn", level=0)
    document.add_heading("6. Liều dùng", level=1)
    table = document.add_table(rows=2, cols=3)
    merged = table.cell(0, 0).merge(table.cell(0, 1))
    merged.text = "Liều dùng"
    table.cell(0, 2).text = "Ghi chú"
    for column, value in enumerate(("Người lớn", "500 mg", "2 lần/ngày")):
        table.cell(1, column).text = value
    if picture is not None:
        for _ in range(pictures):
            document.add_picture(BytesIO(picture), width=Inches(1))
    document.add_heading("13. Ngày phê duyệt lần đầu", level=1)
    document.add_paragraph("09/12/2022")
    path = tmp_path / "leaflet.docx"
    document.save(path)
    return path


def _png(color: str = "red", size: int = 64) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (size, size), color).save(buffer, format="PNG")
    return buffer.getvalue()


def _view(document) -> StructureView:
    return StructureView(decode_json(encode(document)))


def test_markdown_blocks_keep_hierarchy_lists_and_inline_formatting(processor, tmp_path):
    view = _view(_parse(processor, _markdown(tmp_path)))
    nodes = view.window(start=0, size=50).nodes

    headings = [(node.level, node.text) for node in nodes if node.kind is NodeKind.HEADING]
    assert headings == [
        (1, "Quy chế đào tạo"),
        (2, "1. Phạm vi"),
        (2, "13. Ngày phê duyệt lần đầu"),
    ]
    (bullets,) = [node for node in nodes if node.kind is NodeKind.LIST]
    first, second = bullets.children
    assert first.kind is NodeKind.LIST_ITEM
    assert first.text == "Mục một có liên kết"
    assert [run.text.strip() for run in first.runs if run.bold] == ["một"]
    assert [run.uri for run in first.runs if run.uri] == ["https://example.edu.vn/quy-che"]
    assert second.text == "Mục hai"


def test_docx_table_keeps_merged_cells(processor, tmp_path):
    view = _view(_parse(processor, _docx(tmp_path)))
    (table,) = [node for node in view.window(start=0, size=50).nodes if node.kind is NodeKind.TABLE]
    header = table.rows[0]
    assert [(cell.text, cell.col_span, cell.header) for cell in header] == [
        ("Liều dùng", 2, True),
        ("Ghi chú", 1, True),
    ]
    assert [cell.text for cell in table.rows[1]] == ["Người lớn", "500 mg", "2 lần/ngày"]
    assert table.total_rows == 2


def test_spreadsheet_blocks_name_their_sheet_and_hide_the_sheet_index(processor, tmp_path):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Học phí 2025"
    sheet.append(["Mã ngành", "Học phí"])
    sheet.append(["7480201", 450000])
    path = tmp_path / "fees.xlsx"
    workbook.save(path)

    document = _parse(processor, path)
    (table,) = [node for node in _view(document).window(start=0, size=10).nodes]
    assert table.kind is NodeKind.TABLE
    assert table.sheet == "Học phí 2025"
    assert table.page is None
    (chunk,) = DoclingChunker().chunk(document, item_id="i")
    assert chunk.location == "Học phí 2025"
    assert chunk.page is None


@pytest.mark.parametrize("fixture", ["markdown", "docx"])
def test_every_chunk_refers_to_blocks_the_reader_can_show(processor, tmp_path, fixture):
    path = _markdown(tmp_path) if fixture == "markdown" else _docx(tmp_path)
    document = _parse(processor, path)
    view = _view(document)

    chunks = DoclingChunker().chunk(document, item_id="item")

    for chunk in chunks:
        for ref in chunk.refs:
            index = view.unit_index(ref)
            assert index is not None, ref
            window = view.window_around(ref, size=8)
            assert window is not None
            shown = {node.id for node in window.nodes} | {
                child.id for node in window.nodes for child in node.children
            }
            assert ref in shown
        assert "**" not in chunk.quote
        assert "](" not in chunk.quote
        assert "```" not in chunk.quote


def test_the_approval_date_is_cited_as_its_own_block_under_its_heading(processor, tmp_path):
    document = _parse(processor, _docx(tmp_path))
    view = _view(document)

    (chunk,) = [c for c in DoclingChunker().chunk(document, item_id="i") if "09/12/2022" in c.chunk_text]
    assert chunk.quote == "09/12/2022"
    assert chunk.location == "13. Ngày phê duyệt lần đầu"
    window = view.window_around(chunk.refs[0], size=8)
    texts = [node.text for node in window.nodes]
    position = texts.index("09/12/2022")
    assert texts[position - 1] == "13. Ngày phê duyệt lần đầu"


def test_rechunking_keeps_references_valid(processor, tmp_path):
    """Chunk size is not part of the document: refs from any chunking resolve in the same view."""

    document = _parse(processor, _docx(tmp_path))
    view = _view(document)
    small = DoclingChunker(tokenizer=ApproximateTokenizer(max_tokens=16))
    large = DoclingChunker(tokenizer=ApproximateTokenizer(max_tokens=2048))

    small_chunks = small.chunk(document, item_id="i")
    large_chunks = large.chunk(document, item_id="i")

    assert len(small_chunks) > len(large_chunks)
    for chunk in (*small_chunks, *large_chunks):
        assert all(view.unit_index(ref) is not None for ref in chunk.refs)


def test_window_pages_through_the_reading_flow(processor, tmp_path):
    view = _view(_parse(processor, _docx(tmp_path)))
    first = view.window(start=0, size=2)
    second = view.window(start=first.stop, size=2)
    assert (first.start, first.stop, first.total) == (0, 2, view.total)
    assert {node.id for node in first.nodes}.isdisjoint(node.id for node in second.nodes)
    assert view.window(start=view.total + 5, size=2).nodes == ()
    assert view.window_around("texts/9999", size=4) is None


def test_encoding_is_deterministic_and_round_trips(processor, tmp_path):
    document = _parse(processor, _docx(tmp_path))
    data = encode(document)
    assert gzip.decompress(data)[:1] == b"{"
    assert encode(decode_document(data)) == data
    assert encode(_parse(processor, _docx(tmp_path))) == data


def test_pictures_are_stored_by_reference_once(processor, tmp_path):
    document = _parse(processor, _docx(tmp_path, picture=_png("blue"), pictures=2))

    stored = externalize_pictures(document)

    assert len(stored) == 1
    raw = gzip.decompress(encode(document)).decode()
    assert "data:image" not in raw
    assert stored[0].name in raw
    assert Image.open(BytesIO(stored[0].data)).size == (64, 64)
    pictures = [
        node for node in _view(document).window(start=0, size=50).nodes if node.kind is NodeKind.PICTURE
    ]
    assert [node.image.name for node in pictures] == [stored[0].name, stored[0].name]


def test_tiny_pictures_keep_no_image(processor, tmp_path):
    document = _parse(processor, _docx(tmp_path, picture=_png(size=8)))

    assert externalize_pictures(document) == ()
    assert all(picture.image is None for picture in document.pictures)


def test_view_never_exposes_unstored_picture_uris():
    data = {
        "body": {"self_ref": "#/body", "children": [{"cref": "#/pictures/0"}]},
        "pictures": [
            {
                "self_ref": "#/pictures/0",
                "parent": {"cref": "#/body"},
                "label": "picture",
                "children": [],
                "captions": [],
                "image": {"uri": "https://evil.example/x.png", "mimetype": "image/png", "size": {"width": 1, "height": 1}},
            }
        ],
    }
    (node,) = StructureView(data).window(start=0, size=5).nodes
    assert node.kind is NodeKind.PICTURE
    assert node.image is None


def test_unsafe_links_are_dropped():
    data = {
        "body": {"self_ref": "#/body", "children": [{"cref": "#/texts/0"}]},
        "texts": [
            {
                "self_ref": "#/texts/0",
                "parent": {"cref": "#/body"},
                "label": "text",
                "text": "bấm vào đây",
                "hyperlink": "javascript:alert(1)",
            }
        ],
    }
    (node,) = StructureView(data).window(start=0, size=5).nodes
    assert node.runs[0].uri is None


def test_fingerprint_ignores_nothing_that_changes_the_parse():
    base = ParseProfile(parser_version="p1", docling_schema="1.10.0")
    assert base.fingerprint() == ParseProfile(parser_version="p1", docling_schema="1.10.0").fingerprint()
    others = {
        base.model_copy(update={"parser_version": "p2"}).fingerprint(),
        base.model_copy(update={"docling_schema": "1.11.0"}).fingerprint(),
        base.model_copy(update={"read_images": True}).fingerprint(),
        base.model_copy(update={"vision_model": "vlm"}).fingerprint(),
    }
    assert base.fingerprint() not in others
    assert len(others) == 4


def test_structure_keys_live_under_the_content():
    tenant, content = uuid4(), uuid4()
    ref = StructureRef(tenant, content, "0123456789abcdef")
    assert ref.key == f"derived/{tenant}/{content}/structure-v1/0123456789abcdef.json.gz"
    name = f"{'a' * 64}.png"
    assert ref.picture_key(name) == f"derived/{tenant}/{content}/picture-v1/{name}"
    with pytest.raises(ValueError):
        ref.picture_key("../../etc/passwd")
    with pytest.raises(ValueError):
        StructureRef(tenant, content, "not-a-fingerprint")


def test_citation_target_round_trips_and_rejects_bad_copies():
    target = CitationTarget(
        item_id=uuid4(),
        revision_number=3,
        structure_version="0123456789abcdef",
        refs=("texts/31",),
        quote="09/12/2022",
        location="13. Ngày phê duyệt lần đầu",
    )
    assert CitationTarget.from_json(target.to_json()) == target
    assert CitationTarget.from_json({**target.to_json(), "refs": []}) is None
    assert CitationTarget.from_json({**target.to_json(), "refs": ["#/texts/1"]}) is None
    assert CitationTarget.from_json("nope") is None
