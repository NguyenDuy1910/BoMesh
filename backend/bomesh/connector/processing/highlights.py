"""Where a chunk's blocks are in the document's Original preview.

A citation opens the file people read — the Original preview of its revision
— with the cited passage marked (``document_viewer.md`` "Citations open in
the Original"). The marks are located here, at chunking, from what processing
already holds, never guessed by a client:

- :class:`PageLocator` — the parsed bytes are the shown bytes (a PDF, or a
  format parsed from its PDF representation): every block's Docling
  provenance is its box on the shown page. A table chunk names only its rows,
  so their cells are found inside the table's box in the PDF's text layer.
- :class:`SheetLocator` — a workbook (or CSV) shown as a TABLE
  representation: a table's provenance is its place on the sheet, so a chunk's
  rows are a cell range in A1 notation.
- :class:`AlignedLocator` — a format parsed as itself but shown as a PDF
  (DOCX, PPTX, HTML): Docling has no geometry for LibreOffice's or Chromium's
  layout, so every block's text is found, in reading order, in the PDF's text
  layer. A block not found keeps its neighbour's page without a box.

Text is compared folded (:func:`fold`): compatibility-decomposed, lower-case,
letters and digits only, so spacing, punctuation, list numbering, ligatures
and diacritic encoding never decide a match. A highlight is exact or absent.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from docling_core.types.doc import (
    CoordOrigin,
    DocItem,
    DoclingDocument,
    GroupItem,
    TableItem,
    TextItem,
)

from bomesh.document_structure import (
    MAX_HIGHLIGHT_BOXES,
    MAX_TARGET_HIGHLIGHTS,
    Box,
    Highlight,
)

from .pdfium_lock import PDFIUM_LOCK

#: A chunk's table rows, by table ``self_ref``: the first and last grid row it holds.
TableRows = Mapping[str, tuple[int, int]]

#: Folded characters a block needs before it is looked for (shorter text matches anywhere).
_MIN_KEY = 4
#: Folded characters of a long block's head and tail matched when the whole does not.
_EDGE = 48
#: Decimal places kept of a box's page fractions.
_PRECISION = 4


class Locator(Protocol):
    """Where a chunk's blocks are; one per document, used for each of its chunks in order."""

    def locate(self, items: Sequence[DocItem], rows: TableRows) -> tuple[Highlight, ...]: ...


# -- Text folding and the PDF text layer ------------------------------------------


def fold(text: str) -> str:
    """``text`` as compared: NFKD, lower-case, letters and digits only."""

    return "".join(_fold_char(char) for char in text)


def _fold_char(char: str) -> str:
    return "".join(
        part
        for part in unicodedata.normalize("NFKD", char).lower()
        if unicodedata.category(part)[0] in "LN"
    )


@dataclass(slots=True)
class _Stream:
    """Folded text with, for every folded character, its page and PDF character index."""

    text: list[str] = field(default_factory=list)
    at: list[tuple[int, int]] = field(default_factory=list)
    joined: str = ""

    def seal(self) -> _Stream:
        self.joined = "".join(self.text)
        return self

    def find(self, key: str, cursor: int) -> int:
        """``key``'s first place from ``cursor``, else from the start; -1 when absent."""

        found = self.joined.find(key, cursor)
        return found if found >= 0 or cursor == 0 else self.joined.find(key)

    def span(self, text: str, cursor: int) -> tuple[int, int] | None:
        """Where ``text`` is (folded): the whole, else its head to its tail, else its head."""

        key = fold(text)
        if len(key) < _MIN_KEY:
            return None
        start = self.find(key, cursor)
        if start >= 0:
            return start, start + len(key)
        head = key[:_EDGE]
        start = self.find(head, cursor)
        if start < 0:
            return None
        tail = key[-_EDGE:]
        end = self.joined.find(tail, start + len(head)) if len(key) > _EDGE else -1
        if 0 <= end <= start + 2 * len(key):
            return start, end + len(tail)
        return start, start + len(head)


class PdfTextLayer:
    """The text layer of the PDF the Original preview shows: its characters and their boxes.

    Read whole when made, under :data:`~.pdfium_lock.PDFIUM_LOCK` (PDFium is
    not thread-safe and the worker processes documents in parallel); nothing
    calls PDFium afterwards. Characters are read in drawing order, except that
    a character drawn after the rest of its line but standing earlier on it
    is put back in its place (:func:`_line_order`): LibreOffice draws the
    glyphs a font lacks (``ả``, ``ị`` …) from a fallback font at the end of the
    line, so ``bản`` would read ``b n … ả``.
    """

    def __init__(self, path: Path) -> None:
        self._sizes: list[tuple[float, float]] = []
        #: Per page, every character's box (left, bottom, right, top) in points, ``None`` when it has none.
        self._boxes: list[list[tuple[float, float, float, float] | None]] = []
        self.stream = _Stream()
        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(path)
            try:
                for index in range(len(pdf)):
                    page = pdf[index]
                    text_page = page.get_textpage()
                    try:
                        self._sizes.append(page.get_size())
                        boxes: list[tuple[float, float, float, float] | None] = []
                        codes: list[int] = []
                        for char_index in range(text_page.count_chars()):
                            left, bottom, right, top = text_page.get_charbox(char_index)
                            boxes.append((left, bottom, right, top) if right > left and top > bottom else None)
                            codes.append(pdfium_c.FPDFText_GetUnicode(text_page.raw, char_index))
                        self._boxes.append(boxes)
                    finally:
                        text_page.close()
                        page.close()
                    for char_index in _line_order(boxes):
                        code = codes[char_index]
                        for part in _fold_char(chr(code)) if code else "":
                            self.stream.text.append(part)
                            self.stream.at.append((index, char_index))
            finally:
                pdf.close()
        self.stream.seal()

    def page_size(self, page: int) -> tuple[float, float]:
        """Width and height in points of 1-based ``page``."""

        return self._sizes[page - 1]

    def boxes(self, stream: _Stream, start: int, end: int) -> dict[int, Box]:
        """The folded characters ``start``–``end`` of ``stream`` as one box per 1-based page."""

        bounds: dict[int, list[float]] = {}
        for page_index, char_index in stream.at[start:end]:
            box = self._boxes[page_index][char_index]
            if box is None:
                continue
            left, bottom, right, top = box
            seen = bounds.get(page_index)
            if seen is None:
                bounds[page_index] = [left, bottom, right, top]
            else:
                seen[0], seen[1] = min(seen[0], left), min(seen[1], bottom)
                seen[2], seen[3] = max(seen[2], right), max(seen[3], top)
        output: dict[int, Box] = {}
        for page_index, (left, bottom, right, top) in bounds.items():
            width, height = self._sizes[page_index]
            output[page_index + 1] = _fractions(left, height - top, right, height - bottom, width, height)
        return output

    def region(self, page: int, box: Box) -> _Stream:
        """The folded text of 1-based ``page`` whose characters lie inside ``box`` (page fractions)."""

        index = page - 1
        if not 0 <= index < len(self._sizes):
            return _Stream().seal()
        width, height = self._sizes[index]
        left, top, right, bottom = box[0] * width, box[1] * height, box[2] * width, box[3] * height
        stream = _Stream()
        for position, (page_index, char_index) in enumerate(self.stream.at):
            if page_index != index:
                continue
            char = self._boxes[page_index][char_index]
            if char is None:
                continue
            x = (char[0] + char[2]) / 2
            y = height - (char[1] + char[3]) / 2
            if left <= x <= right and top <= y <= bottom:
                stream.text.append(self.stream.text[position])
                stream.at.append((page_index, char_index))
        return stream.seal()


# -- Locators ----------------------------------------------------------------------


class PageLocator:
    """Blocks of a document whose parsed PDF is the shown PDF: their Docling boxes.

    ``layer`` (the same PDF's text layer) narrows a table chunk to its rows;
    without it a table chunk marks the table.
    """

    def __init__(self, document: DoclingDocument, layer: PdfTextLayer | None = None) -> None:
        self._document = document
        self._layer = layer
        #: (table self_ref, page) → grid row → its band on that page.
        self._bands: dict[tuple[str, int], dict[int, Box]] = {}

    def locate(self, items: Sequence[DocItem], rows: TableRows) -> tuple[Highlight, ...]:
        pages: dict[int, list[Box]] = {}
        for item in items:
            for page, box in self._item_boxes(item, rows.get(item.self_ref)):
                pages.setdefault(page, []).append(box)
        return _page_highlights(pages)

    def _item_boxes(self, item: DocItem, rows: tuple[int, int] | None) -> list[tuple[int, Box]]:
        output: list[tuple[int, Box]] = []
        for provenance in item.prov:
            page = self._document.pages.get(provenance.page_no)
            if page is None or page.size.width <= 0 or page.size.height <= 0:
                continue
            width, height = page.size.width, page.size.height
            bbox = provenance.bbox
            if bbox.coord_origin == CoordOrigin.BOTTOMLEFT:
                bbox = bbox.to_top_left_origin(page_height=height)
            box = _fractions(bbox.l, bbox.t, bbox.r, bbox.b, width, height)
            if isinstance(item, TableItem) and rows is not None:
                held = _cell_boxes(item, rows, width, height)
                if held:
                    box = _union(held)
                elif self._layer is not None:
                    box = self._rows_box(item, provenance.page_no, box, rows) or box
            output.append((provenance.page_no, box))
        return output

    def _rows_box(self, table: TableItem, page: int, box: Box, rows: tuple[int, int]) -> Box | None:
        """The union of the bands of rows ``rows`` on ``page``, found inside the table's box."""

        bands = self._bands.get((table.self_ref, page))
        if bands is None:
            assert self._layer is not None
            region = self._layer.region(page, box)
            found: list[tuple[int, dict[int, Box]]] = []
            cursor = 0
            for index, texts in _row_texts(table, self._document):
                boxes, cursor = _find_row(self._layer, region, texts, cursor)
                if page in boxes:
                    found.append((index, {page: boxes[page]}))
            bands = {
                index: band[page]
                for index, band in _bands(found, extents={page: (box[0], box[2])}, floors={page: box[3]}).items()
            }
            self._bands[(table.self_ref, page)] = bands
        held = [band for index, band in bands.items() if rows[0] <= index <= rows[1]]
        return _union(held) if held else None


def _cell_boxes(table: TableItem, rows: tuple[int, int], width: float, height: float) -> list[Box]:
    """The boxes of the cells on rows ``rows`` (a ruled PDF table's cells have them; a TableFormer's do not)."""

    output: list[Box] = []
    for cell in table.data.table_cells:
        if cell.bbox is None or cell.end_row_offset_idx <= rows[0] or cell.start_row_offset_idx > rows[1]:
            continue
        bbox = cell.bbox
        if bbox.coord_origin == CoordOrigin.BOTTOMLEFT:
            bbox = bbox.to_top_left_origin(page_height=height)
        output.append(_fractions(bbox.l, bbox.t, bbox.r, bbox.b, width, height))
    return output


@dataclass(slots=True)
class _Range:
    """Cells of one sheet, 1-based and inclusive."""

    sheet: str
    top: int
    left: int
    bottom: int
    right: int

    def highlight(self) -> Highlight:
        return Highlight(sheet=self.sheet, range=_a1(self.top, self.left, self.bottom, self.right))


class SheetLocator:
    """Blocks of a workbook shown as a TABLE representation: their cell ranges.

    ``sheet`` names the one sheet of a document without sheets (a CSV or TSV:
    the representation's sheet name), whose table starts at A1.
    """

    def __init__(self, document: DoclingDocument, *, sheet: str | None = None) -> None:
        self._document = document
        self._default = sheet

    def locate(self, items: Sequence[DocItem], rows: TableRows) -> tuple[Highlight, ...]:
        merged: list[_Range] = []
        for item in items:
            place = self._place(item, rows.get(item.self_ref))
            if place is None:
                continue
            last = merged[-1] if merged else None
            if (
                last is not None
                and (last.sheet, last.left, last.right) == (place.sheet, place.left, place.right)
                and last.bottom + 1 >= place.top
            ):
                last.bottom = max(last.bottom, place.bottom)
                continue
            merged.append(place)
        return tuple(place.highlight() for place in merged[:MAX_TARGET_HIGHLIGHTS])

    def _place(self, item: DocItem, rows: tuple[int, int] | None) -> _Range | None:
        sheet = self._sheet(item) or self._default
        if sheet is None:
            return None
        if item.prov:
            bbox = item.prov[0].bbox
            top, left = int(bbox.t), int(bbox.l)
            bottom, right = max(int(bbox.b), top + 1), max(int(bbox.r), left + 1)
        elif isinstance(item, TableItem):
            top, left, bottom, right = 0, 0, item.data.num_rows, item.data.num_cols
        else:
            return None
        if isinstance(item, TableItem) and rows is not None:
            return _Range(sheet, top + rows[0] + 1, left + 1, top + rows[1] + 1, right)
        return _Range(sheet, top + 1, left + 1, bottom, right)

    def _sheet(self, item: DocItem) -> str | None:
        """The name of the sheet group ``item`` is in, if any."""

        node = item.parent.resolve(self._document) if item.parent is not None else None
        while isinstance(node, GroupItem):
            if getattr(node.label, "value", node.label) == "sheet":
                return node.name
            node = node.parent.resolve(self._document) if node.parent is not None else None
        return None


class AlignedLocator:
    """Blocks of a document parsed as itself but shown as a PDF: found in its text layer.

    Every text block and table row is looked for once, in reading order, when
    the locator is made; a chunk then reads the boxes of its blocks.
    """

    def __init__(self, document: DoclingDocument, layer: PdfTextLayer) -> None:
        self._layer = layer
        #: Block self_ref → its boxes, one per page.
        self._blocks: dict[str, dict[int, Box]] = {}
        #: Table self_ref → grid row → its boxes, one per page.
        self._rows: dict[str, dict[int, dict[int, Box]]] = {}
        #: Block self_ref → the page it is on, or its nearest located neighbour's.
        self._pages: dict[str, int] = {}
        order: list[str] = []
        cursor = 0
        stream = layer.stream
        for item, _ in document.iterate_items(traverse_pictures=False):
            if isinstance(item, TableItem):
                located: list[tuple[int, dict[int, Box]]] = []
                for index, texts in _row_texts(item, document):
                    found, cursor = _find_row(layer, stream, texts, cursor)
                    if found:
                        located.append((index, found))
                self._rows[item.self_ref] = _bands(located)
                self._blocks[item.self_ref] = _union_pages(self._rows[item.self_ref].values())
            elif isinstance(item, TextItem):
                span = stream.span(item.text, cursor)
                if span is not None:
                    self._blocks[item.self_ref] = layer.boxes(stream, *span)
                    cursor = span[1]
            else:
                continue
            order.append(item.self_ref)
        last: int | None = None
        for ref in order:
            boxes = self._blocks.get(ref)
            if boxes:
                last = min(boxes)
                self._pages[ref] = last
            elif last is not None:
                self._pages[ref] = last
        following: int | None = None
        for ref in reversed(order):
            boxes = self._blocks.get(ref)
            if boxes:
                following = min(boxes)
            elif ref not in self._pages and following is not None:
                self._pages[ref] = following

    def locate(self, items: Sequence[DocItem], rows: TableRows) -> tuple[Highlight, ...]:
        pages: dict[int, list[Box]] = {}
        for item in items:
            ref = item.self_ref
            span = rows.get(ref)
            if isinstance(item, TableItem) and span is not None:
                found = _union_pages(
                    boxes for index, boxes in self._rows.get(ref, {}).items() if span[0] <= index <= span[1]
                )
            else:
                found = self._blocks.get(ref, {})
            if found:
                for page, box in found.items():
                    pages.setdefault(page, []).append(box)
            elif ref in self._pages:
                pages.setdefault(self._pages[ref], [])
        return _page_highlights(pages)


# -- Helpers ------------------------------------------------------------------------


#: Characters looked back over to put a late-drawn one back in its line.
_LINE_LOOKBACK = 400


def _line_order(boxes: Sequence[tuple[float, float, float, float] | None]) -> list[int]:
    """Character indices in drawing order, a late character moved back before those right of it on its line.

    Only moves within one line (vertical overlap of half a character); a
    character starting a new line, a column or a table cell is never moved, so
    drawing order stays the reading order of everything else.
    """

    output: list[int] = []
    for index, box in enumerate(boxes):
        position = len(output)
        if box is not None:
            scan = position
            while scan > 0 and position - scan < _LINE_LOOKBACK:
                previous = boxes[output[scan - 1]]
                if previous is None:
                    scan -= 1
                    continue
                overlap = min(box[3], previous[3]) - max(box[1], previous[1])
                if overlap < 0.5 * min(box[3] - box[1], previous[3] - previous[1]) or previous[0] <= box[0]:
                    break
                scan -= 1
                position = scan
        output.insert(position, index)
    return output


def _fractions(left: float, top: float, right: float, bottom: float, width: float, height: float) -> Box:
    def clamp(value: float) -> float:
        return round(min(1.0, max(0.0, value)), _PRECISION)

    x0, x1 = sorted((clamp(left / width), clamp(right / width)))
    y0, y1 = sorted((clamp(top / height), clamp(bottom / height)))
    return (x0, y0, x1, y1)


def _union(boxes: Iterable[Box]) -> Box:
    listed = list(boxes)
    return (
        min(b[0] for b in listed),
        min(b[1] for b in listed),
        max(b[2] for b in listed),
        max(b[3] for b in listed),
    )


def _union_pages(found: Iterable[Mapping[int, Box]]) -> dict[int, Box]:
    pages: dict[int, list[Box]] = {}
    for boxes in found:
        for page, box in boxes.items():
            pages.setdefault(page, []).append(box)
    return {page: _union(boxes) for page, boxes in sorted(pages.items())}


def _bands(
    rows: Sequence[tuple[int, Mapping[int, Box]]],
    *,
    extents: Mapping[int, tuple[float, float]] | None = None,
    floors: Mapping[int, float] | None = None,
) -> dict[int, dict[int, Box]]:
    """Each located row as a band of its table: from its first line to where the next row starts.

    A row is found by its words, but its cells run on below them (a cell of
    several lines, a cell longer than what was matched), so a row reaches down
    to the next row's top on the same page — or to ``floors`` (the table's
    bottom), else its own last line — and across the table: ``extents`` (left,
    right) per page, else every located row's on that page.
    """

    if extents is None:
        spans: dict[int, list[Box]] = {}
        for _, boxes in rows:
            for page, box in boxes.items():
                spans.setdefault(page, []).append(box)
        extents = {page: (min(b[0] for b in boxes), max(b[2] for b in boxes)) for page, boxes in spans.items()}
    output: dict[int, dict[int, Box]] = {}
    for position, (index, boxes) in enumerate(rows):
        following = rows[position + 1][1] if position + 1 < len(rows) else {}
        band: dict[int, Box] = {}
        for page, (left, top, right, bottom) in boxes.items():
            next_box = following.get(page)
            if next_box is not None and next_box[1] > top:
                bottom = next_box[1]
            elif floors is not None and page in floors:
                bottom = max(bottom, floors[page])
            low, high = extents.get(page, (left, right))
            band[page] = (min(low, left), top, max(high, right), bottom)
        output[index] = band
    return output


def _page_highlights(pages: Mapping[int, list[Box]]) -> tuple[Highlight, ...]:
    """One highlight per page in document order; too many boxes on a page become their union."""

    output: list[Highlight] = []
    for page, boxes in list(pages.items())[:MAX_TARGET_HIGHLIGHTS]:
        unique = list(dict.fromkeys(boxes))
        if len(unique) > MAX_HIGHLIGHT_BOXES:
            unique = [_union(unique)]
        output.append(Highlight(page=page, boxes=tuple(unique)))
    return tuple(output)


def _row_texts(table: TableItem, document: DoclingDocument) -> list[tuple[int, list[str]]]:
    """Every grid row of ``table`` with the texts of the cells starting on it."""

    output: list[tuple[int, list[str]]] = []
    for index, row in enumerate(table.data.grid):
        texts: list[str] = []
        seen: set[tuple[int, int]] = set()
        for cell in row:
            key = (cell.start_row_offset_idx, cell.start_col_offset_idx)
            if key in seen or cell.start_row_offset_idx != index:
                continue
            seen.add(key)
            text = " ".join((cell.text or cell._get_text(doc=document)).split())
            if text:
                texts.append(text)
        if texts:
            output.append((index, texts))
    return output


def _find_row(
    layer: PdfTextLayer, stream: _Stream, texts: list[str], cursor: int
) -> tuple[dict[int, Box], int]:
    """A table row's boxes: its cells read in a row, else each cell long enough to be told apart."""

    span = stream.span(" ".join(texts), cursor)
    if span is not None and span[1] - span[0] >= len(fold(" ".join(texts))):
        return layer.boxes(stream, *span), span[1]
    found: list[dict[int, Box]] = []
    position = cursor
    for text in texts:
        cell = stream.span(text, position)
        if cell is not None:
            found.append(layer.boxes(stream, *cell))
            position = cell[1]
    if not found:
        return {}, cursor
    return _union_pages(found), position


def _column(index: int) -> str:
    """1 → ``A``, 27 → ``AA``."""

    letters = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def _a1(top: int, left: int, bottom: int, right: int) -> str:
    start, end = f"{_column(left)}{top}", f"{_column(right)}{bottom}"
    return start if start == end else f"{start}:{end}"


__all__ = [
    "AlignedLocator",
    "Locator",
    "PageLocator",
    "PdfTextLayer",
    "SheetLocator",
    "TableRows",
    "fold",
]
