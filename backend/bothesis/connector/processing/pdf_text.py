"""PDF knowledge from the file's own text layer: no model, no page images.

A PDF that was typed (exported from Word, a browser, LaTeX, ...) already
carries its text and where every character sits. PDFium reads that in about
a millisecond per page, deterministically, and cannot invent anything. Its
lines are grouped into paragraphs and headings with their page and box,
which is what chunking and citation highlighting need.

What it does not read: scans, text inside pictures or screenshots, and table
structure (a table's rows arrive as lines of text).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median

import pypdfium2 as pdfium
from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
)

from . import DoclingProcessingError

#: Top and bottom bands of a page where running headers and footers sit.
_MARGIN_BAND = 0.1
#: A line in those bands repeated on this share of pages is page furniture.
_FURNITURE_SHARE = 0.5
#: A line this much taller than body text is a heading.
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

    @property
    def height(self) -> float:
        return max(self.top - self.bottom, 0.0)


@dataclass(slots=True)
class _Block:
    heading: bool
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

    Raises ``DoclingProcessingError`` when the file cannot be read, has more
    than ``max_pages`` pages, or has no text layer (a scan or images only).
    """

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

    lines = _without_furniture(lines, sizes)
    if not lines:
        raise DoclingProcessingError(f"No extractable content found in {name}")
    document = DoclingDocument(name=Path(name).stem or name)
    for page_no, size in sizes.items():
        document.add_page(page_no=page_no, size=size)
    for block in _blocks(lines):
        text = block.text()
        provenance = ProvenanceItem(page_no=block.page, bbox=block.bbox(), charspan=(0, len(text)))
        if block.heading:
            document.add_heading(text=text, level=1, prov=provenance)
        else:
            document.add_text(label=DocItemLabel.TEXT, text=text, prov=provenance)
    return document


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
            boxes = [
                box
                for box in (
                    text_page.get_charbox(index)
                    for index in range(start, min(end, count))
                    if not text[index].isspace()
                )
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
            )
        else:
            joined.append(line)
    return joined


def _same_baseline(previous: _Line, line: _Line) -> bool:
    overlap = min(previous.top, line.top) - max(previous.bottom, line.bottom)
    shorter = max(min(previous.height, line.height), 1.0)
    gap = line.left - previous.right
    return overlap >= shorter * 0.5 and -2.0 <= gap <= max(previous.height, line.height) * 3


def _without_furniture(lines: list[_Line], sizes: dict[int, Size]) -> list[_Line]:
    """Drop running headers, footers and page numbers: same text, same band, most pages.

    A heading is never furniture, even one repeated at the top of every page.
    """

    if len(sizes) < 3:
        return lines
    body_height = median(line.height for line in lines) or 1.0
    pages_by_key: dict[str, set[int]] = {}
    keys: list[str | None] = []
    for line in lines:
        height = sizes[line.page].height
        in_band = line.top > height * (1 - _MARGIN_BAND) or line.bottom < height * _MARGIN_BAND
        small = line.height < body_height * _HEADING_RATIO
        key = re.sub(r"\d+", "#", line.text.casefold()) if in_band and small else None
        keys.append(key)
        if key is not None:
            pages_by_key.setdefault(key, set()).add(line.page)
    threshold = max(3, len(sizes) * _FURNITURE_SHARE)
    furniture = {key for key, pages in pages_by_key.items() if len(pages) >= threshold}
    return [line for line, key in zip(lines, keys) if key not in furniture]


def _blocks(lines: list[_Line]) -> list[_Block]:
    body_height = median(line.height for line in lines) or 1.0
    blocks: list[_Block] = []
    for line in lines:
        heading = (
            line.height >= body_height * _HEADING_RATIO
            and len(line.text) <= _MAX_HEADING_CHARACTERS
        )
        current = blocks[-1] if blocks else None
        if current is not None and current.heading == heading and _continues(current.lines[-1], line):
            current.lines.append(line)
        else:
            blocks.append(_Block(heading=heading, lines=[line]))
    return blocks


def _continues(previous: _Line, line: _Line) -> bool:
    """Whether ``line`` is the next line of ``previous``'s paragraph."""

    if line.page != previous.page or _LIST_MARKER.match(line.text):
        return False
    tallest = max(previous.height, line.height, 1.0)
    if abs(previous.height - line.height) > tallest * 0.25:
        return False
    gap = previous.bottom - line.top
    return -tallest * 0.5 <= gap <= tallest * _PARAGRAPH_GAP


__all__ = ["pdf_text_document"]
