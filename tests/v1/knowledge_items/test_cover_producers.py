"""Cover producers (``previews.covers``): one small first page per representation.

``cover_plan`` picks what a cover is drawn from (the PDF or picture
representation, the original sheet, the UTF-8 TEXT); ``render_cover`` draws
it. Fixtures are generated in memory: PDFs and images with Pillow, workbooks
with ``openpyxl``.
"""

from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path
from uuid import UUID

import openpyxl
import pytest
from PIL import Image, ImageDraw

from bomesh.services.previews.covers import (
    CELL_CHARS,
    COLUMN_COUNT,
    COVER_WIDTH,
    LINE_CHARS,
    LINE_COUNT,
    ROW_COUNT,
    TEXT_CHARS,
    TITLE_CHARS,
    CoverPlan,
    RenderedCover,
    cover_plan,
    render_cover,
)
from bomesh.services.previews.formats import FORMATS
from bomesh.services.previews.manifest import StoredRepresentation, representation_key
from bomesh.storage.keys import content_key

#: A cover image a list can afford per card.
MAX_COVER_BYTES = 40 * 1024

_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
_THUMBNAIL = f"{_RELS}/metadata/thumbnail"
_TENANT = UUID("00000000-0000-4000-8000-000000000001")
_CONTENT = UUID("00000000-0000-4000-8000-000000000002")
#: The original, and the object the engine made from it.
_ORIGINAL = content_key(_TENANT, _CONTENT)
_MADE = representation_key(_TENANT, _CONTENT)


def _render(
    tmp_path: Path, extension: str, data: bytes, producer: str, kind: str | None = None
) -> RenderedCover | None:
    path = tmp_path / f"source-{len(list(tmp_path.iterdir()))}.{extension}"
    path.write_bytes(data)
    return render_cover(path, CoverPlan(producer, "key", len(data), extension, kind=kind))


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


def _png(size: tuple[int, int]) -> bytes:
    """A picture of a page: a heading bar on white."""
    image = Image.new("RGB", size, "white")
    ImageDraw.Draw(image).rectangle((8, 8, size[0] - 8, size[1] // 4), fill="navy")
    output = BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def _xlsx(rows: list[list[object]], *, thumbnail: bytes | None = None) -> bytes:
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
        target.writestr("docProps/thumbnail.png", thumbnail)
    return rewritten.getvalue()


def _stored(kind: str, stored: bool = False, **fields: object) -> StoredRepresentation:
    return StoredRepresentation(
        kind=kind, mime_type="x", size_bytes=10, stored=stored, **fields  # type: ignore[arg-type]
    )


def _plan(file_format: str | None, representation: StoredRepresentation | None, size: int) -> CoverPlan | None:
    return cover_plan(
        FORMATS[file_format] if file_format is not None else None,
        representation,
        tenant_id=_TENANT,
        content_id=_CONTENT,
        size_bytes=size,
    )


# -- What a cover is drawn from ------------------------------------------------------


def test_a_pdf_representation_draws_page_one_and_slides_are_slides() -> None:
    original = _plan("pdf", _stored("PDF"), 99)
    converted = _plan("docx", _stored("PDF", stored=True), 99)
    deck = _plan("pptx", _stored("PDF", stored=True), 99)

    assert original == CoverPlan("pdf", _ORIGINAL, 99, "pdf", kind="page")
    assert converted == CoverPlan("pdf", _MADE, 10, "pdf", kind="page")
    assert deck == CoverPlan("pdf", _MADE, 10, "pdf", kind="slide")


def test_pictures_sheets_and_text_draw_from_what_shows_them() -> None:
    assert _plan("png", _stored("IMAGE"), 5) == CoverPlan("image", _ORIGINAL, 5, "png")
    assert _plan("tiff", _stored("IMAGE", stored=True), 5) == CoverPlan("image", _MADE, 10, "webp")
    assert _plan("xlsx", _stored("TABLE", stored=True), 5) == CoverPlan("xlsx", _ORIGINAL, 5, "xlsx")
    assert _plan("tsv", _stored("TABLE", stored=True), 5) == CoverPlan("csv", _ORIGINAL, 5, "tsv")
    assert _plan("md", _stored("TEXT", stored=True, text_format="MARKDOWN"), 5) == CoverPlan(
        "markdown", _MADE, 10, "txt"
    )
    assert _plan("py", _stored("TEXT", stored=True, text_format="PLAIN"), 5) == CoverPlan(
        "text", _MADE, 10, "txt"
    )


def test_media_archives_failures_and_unknown_formats_have_no_picture() -> None:
    assert _plan("mp4", _stored("MEDIA"), 5) is None
    assert _plan("zip", _stored("ARCHIVE", stored=True), 5) is None
    assert _plan("docx", None, 5) is None
    assert _plan(None, None, 5) is None


# -- Drawing --------------------------------------------------------------------------


def test_pdf_cover_is_page_one_only_and_small(tmp_path: Path) -> None:
    cover = _render(tmp_path, "pdf", _pdf(["#c0392b", "#2980b9", "#27ae60"]), "pdf", "page")

    image = _image(cover)
    assert cover is not None and cover.kind == "page"
    assert image.width == COVER_WIDTH and image.height > image.width
    assert len(cover.image or b"") <= MAX_COVER_BYTES
    red, green, blue = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    assert red > 150 and green < 100 and blue < 100  # page 1, not the blue page 2


def test_a_presentations_pdf_is_a_slide(tmp_path: Path) -> None:
    cover = _render(tmp_path, "pdf", _pdf(["#ffffff"], size=(1600, 900)), "pdf", "slide")

    assert cover is not None and cover.kind == "slide"
    assert _image(cover).size == (COVER_WIDTH, 270)


def test_image_cover_is_scaled_down_and_keeps_transparency(tmp_path: Path) -> None:
    photo = BytesIO()
    Image.new("RGB", (4000, 3000), "orange").save(photo, "JPEG", quality=90)
    jpeg = _render(tmp_path, "jpg", photo.getvalue(), "image")
    clear = BytesIO()
    Image.new("RGBA", (300, 200), (0, 0, 0, 0)).save(clear, "WEBP")
    webp = _render(tmp_path, "webp", clear.getvalue(), "image")

    assert jpeg is not None and jpeg.kind == "image"
    assert _image(jpeg).size == (COVER_WIDTH, 360)
    assert len(jpeg.image or b"") <= MAX_COVER_BYTES
    assert webp is not None and _image(webp).size == (300, 200)  # never enlarged
    assert _image(webp).mode == "RGBA"


def test_xlsx_shows_its_thumbnail_else_the_top_left_cells(tmp_path: Path) -> None:
    rows: list[list[object]] = [
        ["Region", "Q1", "Q2", "Q3", "Q4", "Total", "Notes"],
        *[[f"Region {n}", 1.0, 2.5, 3, None, 6.5, "x" * 80] for n in range(10)],
    ]
    plain = _render(tmp_path, "xlsx", _xlsx(rows), "xlsx")
    thumbnail = _render(tmp_path, "xlsx", _xlsx(rows, thumbnail=_png((240, 160))), "xlsx")

    assert plain is not None and plain.kind == "sheet" and plain.title == "Budget 2026"
    assert len(plain.cells) == ROW_COUNT
    assert all(len(row) == COLUMN_COUNT for row in plain.cells)
    assert plain.cells[0] == ("Region", "Q1", "Q2", "Q3", "Q4")
    assert plain.cells[1] == ("Region 0", "1", "2.5", "3", "")
    assert thumbnail is not None and thumbnail.kind == "sheet"
    assert _image(thumbnail).size == (240, 160)


def test_text_formats_keep_their_first_lines_within_bounds(tmp_path: Path) -> None:
    long_line = "word " * 100
    markdown = _render(
        tmp_path, "txt", f"# {'T' * 300}\n\n- {long_line}\n".encode() + b"line\n" * 20, "markdown"
    )
    text = _render(tmp_path, "txt", "first\n\n  second  \n".encode(), "text")
    csv = _render(tmp_path, "csv", b"a;b;c\n1;2;3\n" + b"4;5;6\n" * 10, "csv")
    tsv = _render(tmp_path, "tsv", "ville\tprix\nMontréal\t12\n".encode("cp1252"), "csv")

    assert markdown is not None and markdown.kind == "text"
    assert markdown.title == "T" * TITLE_CHARS
    assert len(markdown.lines) == LINE_COUNT
    assert all(len(line) <= LINE_CHARS for line in markdown.lines)
    assert text == RenderedCover("text", lines=("first", "second"))
    assert csv is not None and csv.kind == "sheet"
    assert csv.cells[:2] == (("a", "b", "c"), ("1", "2", "3")) and len(csv.cells) == ROW_COUNT
    assert tsv is not None and tsv.cells == (("ville", "prix"), ("Montréal", "12"))


def test_all_lines_share_one_text_budget(tmp_path: Path) -> None:
    cover = _render(tmp_path, "txt", ("z" * 200 + "\n").encode() * 20, "text")

    assert cover is not None
    assert [len(line) for line in cover.lines] == [LINE_CHARS, LINE_CHARS, LINE_CHARS]
    assert sum(map(len, cover.lines)) == TEXT_CHARS


def test_cells_are_clipped(tmp_path: Path) -> None:
    cover = _render(tmp_path, "csv", (",".join(["y" * 100] * 9) + "\n").encode(), "csv")

    assert cover is not None
    assert cover.cells == (("y" * CELL_CHARS,) * COLUMN_COUNT,)


def test_empty_or_unreadable_sources_have_no_cover(tmp_path: Path) -> None:
    assert _render(tmp_path, "txt", b"\n\n", "text") is None
    with pytest.raises(Exception):
        _render(tmp_path, "pdf", b"%PDF-1.7 not really", "pdf")
    with pytest.raises(Exception):
        _render(tmp_path, "xlsx", b"not a zip", "xlsx")
