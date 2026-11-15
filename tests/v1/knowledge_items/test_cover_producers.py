"""Cover producers (``covers.render_cover``): one small first page per format.

Fixtures are generated in memory: PDFs and images with Pillow, OOXML packages
with ``zipfile`` (and ``openpyxl``), with and without an embedded thumbnail.
"""

from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path

import openpyxl
import pytest
from PIL import Image, ImageDraw

from bomesh.services.knowledge_items.covers import (
    CELL_CHARS,
    COLUMN_COUNT,
    COVER_WIDTH,
    LINE_CHARS,
    LINE_COUNT,
    ROW_COUNT,
    TEXT_CHARS,
    TITLE_CHARS,
    RenderedCover,
    render_cover,
)

#: A cover image a list can afford per card.
MAX_COVER_BYTES = 40 * 1024

_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
_THUMBNAIL = f"{_RELS}/metadata/thumbnail"
_OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _render(tmp_path: Path, name: str, data: bytes, content_type: str | None = None) -> RenderedCover | None:
    path = tmp_path / name
    path.write_bytes(data)
    return render_cover(path, file_name=name, content_type=content_type)


def _image(cover: RenderedCover | None) -> Image.Image:
    assert cover is not None and cover.image is not None
    image = Image.open(BytesIO(cover.image))
    assert image.format == "WEBP"
    assert image.size == (cover.width, cover.height)
    return image


def _pdf(colors: list[str], size: tuple[int, int] = (1240, 1754)) -> bytes:
    pages = [Image.new("RGB", size, color) for color in colors]
    output = BytesIO()
    pages[0].save(output, "PDF", resolution=150, save_all=True, append_images=pages[1:])
    return output.getvalue()


def _png(size: tuple[int, int], *, blank: bool = False) -> bytes:
    """A picture of a page: a heading bar on white (``blank``: white only)."""
    image = Image.new("RGB", size, "white")
    if not blank:
        ImageDraw.Draw(image).rectangle((8, 8, size[0] - 8, size[1] // 4), fill="navy")
    output = BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def _package(parts: dict[str, str | bytes], *, thumbnail: tuple[str, bytes] | None = None) -> bytes:
    relationships = [f'<Relationship Id="rId1" Type="{_OFFICE}/officeDocument" Target="main.xml"/>']
    if thumbnail is not None:
        relationships.append(
            f'<Relationship Id="rId2" Type="{_THUMBNAIL}" Target="{thumbnail[0]}"/>'
        )
    output = BytesIO()
    with zipfile.ZipFile(output, "w") as package:
        package.writestr(
            "_rels/.rels", f'<Relationships xmlns="{_RELS}">{"".join(relationships)}</Relationships>'
        )
        for name, data in parts.items():
            package.writestr(name, data)
        if thumbnail is not None:
            package.writestr(thumbnail[0], thumbnail[1])
    return output.getvalue()


def _slide(title: str, *texts: str) -> str:
    def shape(text: str, placeholder: str) -> str:
        return (
            f"<p:sp><p:nvSpPr><p:cNvPr id='1' name='s'/><p:cNvSpPr/><p:nvPr>{placeholder}</p:nvPr></p:nvSpPr>"
            f"<p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"
        )

    shapes = shape(title, '<p:ph type="title"/>') + "".join(shape(text, "") for text in texts)
    return f'<p:sld xmlns:p="{_P}" xmlns:a="{_A}"><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>'


def _pptx(*, thumbnail: tuple[str, bytes] | None = None) -> bytes:
    # The first slide in sldIdLst order is slide2.xml, not slide1.xml.
    return _package(
        {
            "ppt/presentation.xml": (
                f'<p:presentation xmlns:p="{_P}" xmlns:r="{_OFFICE}"><p:sldIdLst>'
                '<p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId8"/>'
                "</p:sldIdLst></p:presentation>"
            ),
            "ppt/_rels/presentation.xml.rels": (
                f'<Relationships xmlns="{_RELS}">'
                f'<Relationship Id="rId8" Type="{_OFFICE}/slide" Target="slides/slide1.xml"/>'
                f'<Relationship Id="rId7" Type="{_OFFICE}/slide" Target="/ppt/slides/slide2.xml"/>'
                "</Relationships>"
            ),
            "ppt/slides/slide1.xml": _slide("Second slide", "not shown"),
            "ppt/slides/slide2.xml": _slide("Quarterly review", "Revenue up 12%", "Next steps"),
        },
        thumbnail=thumbnail,
    )


def _docx(paragraphs: list[tuple[str | None, str]], *, thumbnail: tuple[str, bytes] | None = None) -> bytes:
    body = "".join(
        (
            f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>'
            if style is not None
            else f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
            if text != "<page>"
            else '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
        )
        for style, text in paragraphs
    )
    return _package(
        {"word/document.xml": f'<w:document xmlns:w="{_W}"><w:body>{body}</w:body></w:document>'},
        thumbnail=thumbnail,
    )


def _xlsx(rows: list[list[object]], *, thumbnail: tuple[str, bytes] | None = None) -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Budget 2026"
    for row in rows:
        sheet.append(row)
    output = BytesIO()
    workbook.save(output)
    if thumbnail is None:
        return output.getvalue()
    rewritten = BytesIO()
    with zipfile.ZipFile(BytesIO(output.getvalue())) as source, zipfile.ZipFile(rewritten, "w") as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == "_rels/.rels":
                data = data.replace(
                    b"</Relationships>",
                    f'<Relationship Id="rIdThumb" Type="{_THUMBNAIL}" Target="docProps/thumbnail.png"/>'
                    "</Relationships>".encode(),
                )
            target.writestr(info, data)
        target.writestr("docProps/thumbnail.png", thumbnail[1])
    return rewritten.getvalue()


def test_pdf_cover_is_page_one_only_and_small(tmp_path: Path) -> None:
    cover = _render(tmp_path, "report.pdf", _pdf(["#c0392b", "#2980b9", "#27ae60"]))

    image = _image(cover)
    assert cover is not None and cover.kind == "page"
    assert image.width == COVER_WIDTH and image.height > image.width
    assert len(cover.image or b"") <= MAX_COVER_BYTES
    red, green, blue = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    assert red > 150 and green < 100 and blue < 100  # page 1, not the blue page 2


def test_image_cover_is_scaled_down_and_keeps_transparency(tmp_path: Path) -> None:
    photo = BytesIO()
    Image.new("RGB", (4000, 3000), "orange").save(photo, "JPEG", quality=90)
    jpeg = _render(tmp_path, "photo.jpg", photo.getvalue())
    clear = BytesIO()
    Image.new("RGBA", (300, 200), (0, 0, 0, 0)).save(clear, "PNG")
    png = _render(tmp_path, "logo.png", clear.getvalue())

    assert jpeg is not None and jpeg.kind == "image"
    assert _image(jpeg).size == (COVER_WIDTH, 360)
    assert len(jpeg.image or b"") <= MAX_COVER_BYTES
    assert png is not None and _image(png).size == (300, 200)  # never enlarged
    assert _image(png).mode == "RGBA"


def test_pptx_uses_its_embedded_thumbnail(tmp_path: Path) -> None:
    cover = _render(tmp_path, "deck.pptx", _pptx(thumbnail=("docProps/thumbnail.jpeg", _png((256, 144)))))

    assert cover is not None and cover.kind == "slide"
    assert _image(cover).size == (256, 144)
    assert cover.lines == () and cover.title is None


def test_pptx_without_a_usable_thumbnail_shows_the_first_slide_text(tmp_path: Path) -> None:
    emf = _render(tmp_path, "deck.pptx", _pptx(thumbnail=("docProps/thumbnail.emf", b"\x01\x00")))
    # Library-written files keep their template's blank thumbnail.
    blank = _render(
        tmp_path, "blank.pptx", _pptx(thumbnail=("docProps/thumbnail.jpeg", _png((256, 192), blank=True)))
    )
    plain = _render(tmp_path, "plain.pptx", _pptx())

    for cover in (emf, blank, plain):
        assert cover == RenderedCover(
            "slide", title="Quarterly review", lines=("Revenue up 12%", "Next steps")
        )


def test_docx_shows_its_thumbnail_else_the_first_page_text(tmp_path: Path) -> None:
    paragraphs: list[tuple[str | None, str]] = [
        (None, "Internal"),
        ("Heading1", "Travel policy"),
        (None, "Applies to every employee."),
        (None, "<page>"),
        (None, "Second page text"),
    ]
    thumbnail = _render(
        tmp_path, "policy.docx", _docx(paragraphs, thumbnail=("docProps/thumbnail.png", _png((200, 283))))
    )
    text = _render(tmp_path, "plain.docx", _docx(paragraphs))

    assert thumbnail is not None and thumbnail.kind == "page"
    assert _image(thumbnail).size == (200, 283)
    assert text == RenderedCover(
        "page", title="Travel policy", lines=("Internal", "Applies to every employee.")
    )


def test_xlsx_shows_its_thumbnail_else_the_top_left_cells(tmp_path: Path) -> None:
    rows: list[list[object]] = [
        ["Region", "Q1", "Q2", "Q3", "Q4", "Total", "Notes"],
        *[[f"Region {n}", 1.0, 2.5, 3, None, 6.5, "x" * 80] for n in range(10)],
    ]
    plain = _render(tmp_path, "budget.xlsx", _xlsx(rows))
    thumbnail = _render(
        tmp_path, "thumb.xlsx", _xlsx(rows, thumbnail=("docProps/thumbnail.png", _png((240, 160))))
    )

    assert plain is not None and plain.kind == "sheet" and plain.title == "Budget 2026"
    assert len(plain.cells) == ROW_COUNT
    assert all(len(row) == COLUMN_COUNT for row in plain.cells)
    assert plain.cells[0] == ("Region", "Q1", "Q2", "Q3", "Q4")
    assert plain.cells[1] == ("Region 0", "1", "2.5", "3", "")
    assert thumbnail is not None and thumbnail.kind == "sheet"
    assert _image(thumbnail).size == (240, 160)


def test_text_formats_keep_their_first_lines_within_bounds(tmp_path: Path) -> None:
    long_line = "word " * 100
    markdown = _render(tmp_path, "notes.md", f"# {'T' * 300}\n\n- {long_line}\n".encode() + b"line\n" * 20)
    text = _render(tmp_path, "notes.txt", b"\xef\xbb\xbffirst\n\n  second  \n")
    html = _render(
        tmp_path,
        "page.html",
        b"<html><head><title>Handbook</title><style>p{}</style></head>"
        b"<body><h1>Handbook</h1><p>Welcome <b>aboard</b>.</p><script>x()</script></body></html>",
    )
    csv = _render(tmp_path, "data.csv", b"a;b;c\n1;2;3\n" + b"4;5;6\n" * 10)

    assert markdown is not None and markdown.kind == "text"
    assert markdown.title == "T" * TITLE_CHARS
    assert len(markdown.lines) == LINE_COUNT
    assert all(len(line) <= LINE_CHARS for line in markdown.lines)
    assert text == RenderedCover("text", lines=("first", "second"))
    assert html == RenderedCover("text", title="Handbook", lines=("Welcome aboard .",))
    assert csv is not None and csv.kind == "sheet"
    assert csv.cells[:2] == (("a", "b", "c"), ("1", "2", "3")) and len(csv.cells) == ROW_COUNT


def test_all_lines_share_one_text_budget(tmp_path: Path) -> None:
    cover = _render(tmp_path, "long.txt", ("z" * 200 + "\n").encode() * 20)

    assert cover is not None
    assert [len(line) for line in cover.lines] == [LINE_CHARS, LINE_CHARS, LINE_CHARS]
    assert sum(map(len, cover.lines)) == TEXT_CHARS


def test_cells_are_clipped(tmp_path: Path) -> None:
    cover = _render(tmp_path, "wide.csv", ("," .join(["y" * 100] * 9) + "\n").encode())

    assert cover is not None
    assert cover.cells == (("y" * CELL_CHARS,) * COLUMN_COUNT,)


def test_unknown_or_unreadable_files_have_no_cover(tmp_path: Path) -> None:
    assert _render(tmp_path, "archive.zip", b"PK\x05\x06" + b"\x00" * 18) is None
    assert _render(tmp_path, "empty.txt", b"\n\n") is None
    with pytest.raises(Exception):
        _render(tmp_path, "broken.pdf", b"%PDF-1.7 not really")
    with pytest.raises(Exception):
        _render(tmp_path, "broken.pptx", b"not a zip")


def test_content_type_selects_the_producer_without_an_extension(tmp_path: Path) -> None:
    cover = _render(tmp_path, "upload", _pdf(["white"]), "application/pdf")

    assert cover is not None and cover.kind == "page"
