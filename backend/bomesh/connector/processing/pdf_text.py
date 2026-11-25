"""PDF knowledge from the file's own text layer: no model, no page images.

A PDF that was typed (exported from Word, a browser, LaTeX, ...) already
carries its text and where every character sits. PDFium reads that in about
a millisecond per page, deterministically, and cannot invent anything. Its
lines are grouped into paragraphs and headings with their page and box,
which is what chunking and citation highlighting need. Headings are told by
font size against the size most of the text is set in, and nested by size.

What it does not read: scans, text inside pictures or screenshots, and table
structure (a table's rows arrive as lines of text). ``scanned_pages`` names
the scanned pages so the caller can have them transcribed instead, and
``pdf_pictures`` hands over the pictures of typed pages for a run that reads
images.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
)
from PIL.Image import Image

from . import DoclingProcessingError
from .pdfium_lock import PDFIUM_LOCK

#: A page with an image and fewer non-space characters than this is a scan: a
#: printed page number or stamp on a scanned page is not its content.
_SCAN_TEXT_CHARACTERS = 20

#: Top and bottom bands of a page where running headers and footers sit.
_MARGIN_BAND = 0.1
#: A line in those bands repeated on this share of pages is page furniture.
_FURNITURE_SHARE = 0.5
#: A line set this much larger than body text is a heading.
_HEADING_RATIO = 1.25
_MAX_HEADING_CHARACTERS = 200
#: Lines further apart than this many line heights start a new paragraph.
_PARAGRAPH_GAP = 1.0
_LIST_MARKER = re.compile(r"^(?:[•●▪◦‣∙·\-–*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s")


@dataclass(slots=True)
class _Line:
    """One line of a page, boxed in PDF points with a bottom-left origin."""

    page: int
    text: str
    left: float
    bottom: float
    right: float
    top: float
    #: The font size its characters are set in (points); 0 when PDFium cannot tell.
    size: float = 0.0

    @property
    def height(self) -> float:
        return max(self.top - self.bottom, 0.0)


@dataclass(slots=True)
class _Block:
    heading: bool
    #: The size of its first line, in the document's measure (:func:`_measure`).
    size: float
    lines: list[_Line] = field(default_factory=list)

    @property
    def page(self) -> int:
        return self.lines[0].page

    def text(self) -> str:
        joined = ""
        for line in self.lines:
            if not joined:
                joined = line.text
            elif joined.endswith("-") and joined[-2:-1].isalpha() and line.text[:1].islower():
                joined = joined[:-1] + line.text  # a word hyphenated across lines
            else:
                joined = f"{joined} {line.text}"
        return joined

    def bbox(self) -> BoundingBox:
        return BoundingBox(
            l=min(line.left for line in self.lines),
            t=max(line.top for line in self.lines),
            r=max(line.right for line in self.lines),
            b=min(line.bottom for line in self.lines),
            coord_origin=CoordOrigin.BOTTOMLEFT,
        )


def pdf_text_document(
    source: Path | bytes,
    *,
    name: str,
    page_range: tuple[int, int],
    max_pages: int,
) -> DoclingDocument:
    """Paragraphs and headings of a PDF's text layer, with page and box provenance.

    Raises ``DoclingProcessingError`` when the file cannot be read or has more
    than ``max_pages`` pages. A range without a text layer (a scan, images
    only) yields its pages and no items; the caller decides whether that is
    an error.
    """

    with PDFIUM_LOCK:
        try:
            pdf = pdfium.PdfDocument(source if isinstance(source, bytes) else str(source))
        except pdfium.PdfiumError as exc:
            raise DoclingProcessingError(f"Docling could not read {name}") from exc
        try:
            if len(pdf) > max_pages:
                raise DoclingProcessingError(f"{name} has more than {max_pages} pages")
            sizes, lines = _read_lines(pdf, page_range)
        except pdfium.PdfiumError as exc:
            raise DoclingProcessingError(f"Docling could not read {name}") from exc
        finally:
            pdf.close()

    measure = _measure(lines)
    lines = _without_furniture(lines, sizes, measure)
    document = DoclingDocument(name=Path(name).stem or name)
    for page_no, size in sizes.items():
        document.add_page(page_no=page_no, size=size)
    blocks = _blocks(lines, measure)
    levels = _heading_levels(blocks)
    for block in blocks:
        text = block.text()
        provenance = ProvenanceItem(page_no=block.page, bbox=block.bbox(), charspan=(0, len(text)))
        if block.heading:
            document.add_heading(text=text, level=levels[_size_key(block.size)], prov=provenance)
        else:
            document.add_text(label=DocItemLabel.TEXT, text=text, prov=provenance)
    return document


def scanned_pages(
    source: Path | bytes,
    *,
    name: str,
    page_range: tuple[int, int],
    max_pages: int,
) -> tuple[range, frozenset[int]]:
    """The 1-based pages of ``page_range`` in the file, and which of them are scans.

    A scan is a page holding an image and (almost) no text layer. A blank
    page is not a scan: there is nothing on it to transcribe.
    """

    with PDFIUM_LOCK:
        try:
            pdf = pdfium.PdfDocument(source if isinstance(source, bytes) else str(source))
        except pdfium.PdfiumError as exc:
            raise DoclingProcessingError(f"Docling could not read {name}") from exc
        try:
            if len(pdf) > max_pages:
                raise DoclingProcessingError(f"{name} has more than {max_pages} pages")
            first, last = page_range
            pages = range(first, min(last, len(pdf)) + 1)
            scans = frozenset(page_no for page_no in pages if _is_scan(pdf[page_no - 1]))
        except pdfium.PdfiumError as exc:
            raise DoclingProcessingError(f"Docling could not read {name}") from exc
        finally:
            pdf.close()
    return pages, scans


@dataclass(frozen=True, slots=True)
class PdfPicture:
    """One picture of a typed page: where it sits (PDF points, bottom-left origin) and its pixels."""

    page: int
    bbox: BoundingBox
    image: Image


def pdf_pictures(
    source: Path | bytes, *, name: str, pages: Iterable[int], min_side: float
) -> list[PdfPicture]:
    """The pictures of ``pages``, as drawn (masks and transforms applied).

    A picture narrower or shorter than ``min_side`` points on the page is an
    icon or a rule, never text to read.
    """

    pictures: list[PdfPicture] = []
    with PDFIUM_LOCK:
        try:
            pdf = pdfium.PdfDocument(source if isinstance(source, bytes) else str(source))
        except pdfium.PdfiumError as exc:
            raise DoclingProcessingError(f"Docling could not read {name}") from exc
        try:
            for page_no in pages:
                page = pdf[page_no - 1]
                try:
                    for picture in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE]):
                        left, bottom, right, top = picture.get_bounds()
                        if right - left < min_side or top - bottom < min_side:
                            continue
                        pictures.append(
                            PdfPicture(
                                page=page_no,
                                bbox=BoundingBox(
                                    l=left, t=top, r=right, b=bottom,
                                    coord_origin=CoordOrigin.BOTTOMLEFT,
                                ),
                                image=picture.get_bitmap(render=True).to_pil(),
                            )
                        )
                finally:
                    page.close()
        except pdfium.PdfiumError as exc:
            raise DoclingProcessingError(f"Docling could not read {name}") from exc
        finally:
            pdf.close()
    return pictures


def _is_scan(page: pdfium.PdfPage) -> bool:
    try:
        text_page = page.get_textpage()
        try:
            characters = sum(1 for character in text_page.get_text_range() if not character.isspace())
        finally:
            text_page.close()
        if characters >= _SCAN_TEXT_CHARACTERS:
            return False
        images = page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE])
        return next(images, None) is not None
    finally:
        page.close()


def _read_lines(
    pdf: pdfium.PdfDocument, page_range: tuple[int, int]
) -> tuple[dict[int, Size], list[_Line]]:
    first, last = page_range
    sizes: dict[int, Size] = {}
    lines: list[_Line] = []
    for index in range(first - 1, min(last, len(pdf))):
        page = pdf[index]
        try:
            width, height = page.get_size()
            sizes[index + 1] = Size(width=width, height=height)
            text_page = page.get_textpage()
            try:
                lines.extend(_page_lines(text_page, index + 1))
            finally:
                text_page.close()
        finally:
            page.close()
    return sizes, _joined_fragments(lines)


def _page_lines(text_page: pdfium.PdfTextPage, page_no: int) -> list[_Line]:
    """PDFium's own lines (it breaks the text stream with CR/LF), boxed by their characters.

    Character boxes are PDF points with a bottom-left origin, aligned with the
    text one character per index. PDFium marks a word hyphenated at a line end
    with U+FFFE and no line break; that is a line end whose hyphen is kept, so
    the paragraph rejoins the word.
    """

    count = text_page.count_chars()
    text = text_page.get_text_range(0, count)
    lines: list[_Line] = []
    start = 0
    for end, character in enumerate(f"{text}\n"):
        if character not in "\r\n\ufffe":
            continue
        content = " ".join(text[start:end].split())
        if content and character == "\ufffe":
            content = f"{content}-"
        if content:
            indexes = [index for index in range(start, min(end, count)) if not text[index].isspace()]
            boxes = [
                box
                for box in (text_page.get_charbox(index) for index in indexes)
                if box[2] > box[0] or box[3] > box[1]
            ]
            if boxes:
                lines.append(
                    _Line(
                        page_no,
                        content,
                        min(box[0] for box in boxes),
                        min(box[1] for box in boxes),
                        max(box[2] for box in boxes),
                        max(box[3] for box in boxes),
                        median(
                            pdfium_c.FPDFText_GetFontSize(text_page.raw, index)
                            for index in indexes
                        ),
                    )
                )
        start = end + 1
    return lines


def _joined_fragments(lines: list[_Line]) -> list[_Line]:
    """Rejoin a line PDFium split mid-baseline (at a superscript or a style change)."""

    joined: list[_Line] = []
    for line in lines:
        previous = joined[-1] if joined else None
        if previous is not None and previous.page == line.page and _same_baseline(previous, line):
            joined[-1] = _Line(
                line.page,
                f"{previous.text} {line.text}",
                previous.left,
                min(previous.bottom, line.bottom),
                max(previous.right, line.right),
                max(previous.top, line.top),
                # A superscript or footnote mark is smaller than the line it sits on.
                max(previous.size, line.size),
            )
        else:
            joined.append(line)
    return joined


def _same_baseline(previous: _Line, line: _Line) -> bool:
    overlap = min(previous.top, line.top) - max(previous.bottom, line.bottom)
    shorter = max(min(previous.height, line.height), 1.0)
    gap = line.left - previous.right
    return overlap >= shorter * 0.5 and -2.0 <= gap <= max(previous.height, line.height) * 3


def _measure(lines: list[_Line]) -> Callable[[_Line], float]:
    """How large a line's text is: its font size, else (some line has none) its glyph height.

    Glyph height varies with the letters (Vietnamese marks make a line taller);
    the font size does not, so it is used whenever every line has one.
    """

    if all(line.size > 0 for line in lines):
        return lambda line: line.size
    return lambda line: line.height


def _body_size(lines: list[_Line], measure: Callable[[_Line], float]) -> float:
    """The size most of the text is set in: the median weighted by characters.

    Weighting by characters keeps a short document's headings, a few lines
    each as many as its paragraphs, from passing for body text.
    """

    weighted = sorted((measure(line), len(line.text)) for line in lines)
    half = sum(count for _, count in weighted) / 2
    seen = 0
    for size, count in weighted:
        seen += count
        if seen >= half:
            return size or 1.0
    return 1.0


def _size_key(size: float) -> float:
    """Sizes within half a point are one size."""

    return round(size * 2) / 2


def _without_furniture(
    lines: list[_Line], sizes: dict[int, Size], measure: Callable[[_Line], float]
) -> list[_Line]:
    """Drop running headers, footers and page numbers: same text, same band, most pages.

    A heading is never furniture, even one repeated at the top of every page.
    """

    if len(sizes) < 3 or not lines:
        return lines
    body_size = _body_size(lines, measure)
    pages_by_key: dict[str, set[int]] = {}
    keys: list[str | None] = []
    for line in lines:
        height = sizes[line.page].height
        in_band = line.top > height * (1 - _MARGIN_BAND) or line.bottom < height * _MARGIN_BAND
        small = measure(line) < body_size * _HEADING_RATIO
        key = re.sub(r"\d+", "#", line.text.casefold()) if in_band and small else None
        keys.append(key)
        if key is not None:
            pages_by_key.setdefault(key, set()).add(line.page)
    threshold = max(3, len(sizes) * _FURNITURE_SHARE)
    furniture = {key for key, pages in pages_by_key.items() if len(pages) >= threshold}
    return [line for line, key in zip(lines, keys) if key not in furniture]


def _blocks(lines: list[_Line], measure: Callable[[_Line], float]) -> list[_Block]:
    if not lines:
        return []
    body_size = _body_size(lines, measure)
    blocks: list[_Block] = []
    for line in lines:
        size = measure(line)
        heading = size >= body_size * _HEADING_RATIO and len(line.text) <= _MAX_HEADING_CHARACTERS
        current = blocks[-1] if blocks else None
        if (
            current is not None
            and current.heading == heading
            # A heading continues only in its own size: a title is not its first section.
            and (not heading or _size_key(size) == _size_key(current.size))
            and _continues(current.lines[-1], line)
        ):
            current.lines.append(line)
        else:
            blocks.append(_Block(heading=heading, size=size, lines=[line]))
    return blocks


def _heading_levels(blocks: list[_Block]) -> dict[float, int]:
    """Heading level by size: the largest heading size is level 1, the next 2, …"""

    sizes = sorted({_size_key(block.size) for block in blocks if block.heading}, reverse=True)
    return {size: level for level, size in enumerate(sizes, start=1)}


def _continues(previous: _Line, line: _Line) -> bool:
    """Whether ``line`` is the next line of ``previous``'s paragraph."""

    if line.page != previous.page or _LIST_MARKER.match(line.text):
        return False
    tallest = max(previous.height, line.height, 1.0)
    if abs(previous.height - line.height) > tallest * 0.25:
        return False
    gap = previous.bottom - line.top
    return -tallest * 0.5 <= gap <= tallest * _PARAGRAPH_GAP


__all__ = ["pdf_text_document", "scanned_pages"]
