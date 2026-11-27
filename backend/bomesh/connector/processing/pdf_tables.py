"""Ruled tables of a typed PDF page, read from the lines that draw them.

A table exported from Word, LibreOffice or a browser is drawn with rules: a
thin filled rectangle or a stroked line per border, a stroked rectangle per
cell. Read as text lines, its cells arrive one fragment at a time and in
drawing order, so a row's values scatter among other paragraphs and a chunk
holds pieces of several rows. Here the rules are read instead (the lattice
method):

- every thin path (a border) and every side of a stroked rectangle is a rule;
- rules that touch form one grid; one with at least two rows and two columns
  is a table (a box around a letterhead is not);
- the grid's lines are the distinct positions of its rules; a cell border a
  rule does not draw merges the cells on both sides (a spanned header, a
  section row);
- each character whose centre lies in a cell is that cell's text, read line by
  line and left to right within it, so a glyph drawn late (a fallback font's
  ``ả``) still lands in its word.

Every cell keeps its box, so a citation marks exactly the rows it holds.
Tables without rules (aligned columns of text) stay lines of text.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

#: Paths thinner than this (points) are rules.
_RULE_THICKNESS = 2.5
#: Rules shorter than this are corner marks, not borders.
_RULE_MIN_LENGTH = 3.0
#: Positions closer than this (points) are one grid line; rules this close touch.
_TOLERANCE = 2.0
#: A border is drawn when its rules cover this share of the cell side.
_COVERED = 0.5
#: A grid of fewer rows or columns is a box (a letterhead), not a table.
_MIN_ROWS = 2
_MIN_COLUMNS = 2


@dataclass(slots=True)
class PdfCell:
    """One cell, 0-based in the grid, with its spans, text and box (PDF points, bottom-left origin)."""

    row: int
    column: int
    row_span: int
    column_span: int
    text: str
    left: float
    bottom: float
    right: float
    top: float


@dataclass(slots=True)
class PdfTable:
    page: int
    left: float
    bottom: float
    right: float
    top: float
    rows: int
    columns: int
    #: Grid column lines, left to right.
    xs: list[float] = field(default_factory=list)
    #: Grid row lines, top to bottom.
    ys: list[float] = field(default_factory=list)
    cells: list[PdfCell] = field(default_factory=list)

    def holds(self, x: float, y: float) -> bool:
        return self.left <= x <= self.right and self.bottom <= y <= self.top


@dataclass(slots=True)
class _Rule:
    horizontal: bool
    #: y of a horizontal rule, x of a vertical one.
    at: float
    start: float
    end: float


def page_tables(page: pdfium.PdfPage, text_page: pdfium.PdfTextPage, page_no: int) -> list[PdfTable]:
    """The ruled tables of ``page`` (the caller holds the PDFium lock), top to bottom."""

    rules = _rules(page)
    if len(rules) < 6:
        return []
    tables = [table for group in _groups(rules) if (table := _table(group, page_no)) is not None]
    if not tables:
        return []
    _fill(tables, text_page)
    tables.sort(key=lambda table: -table.top)
    return tables


# -- Rules ---------------------------------------------------------------------------


def _rules(page: pdfium.PdfPage) -> list[_Rule]:
    rules: list[_Rule] = []
    for item in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_PATH,), max_depth=1):
        left, bottom, right, top = item.get_bounds()
        width, height = right - left, top - bottom
        if height <= _RULE_THICKNESS and width >= _RULE_MIN_LENGTH:
            rules.append(_Rule(True, (top + bottom) / 2, left, right))
        elif width <= _RULE_THICKNESS and height >= _RULE_MIN_LENGTH:
            rules.append(_Rule(False, (left + right) / 2, bottom, top))
        elif width >= _RULE_MIN_LENGTH and height >= _RULE_MIN_LENGTH and _stroked_box(item):
            rules += [
                _Rule(True, bottom, left, right),
                _Rule(True, top, left, right),
                _Rule(False, left, bottom, top),
                _Rule(False, right, bottom, top),
            ]
    return rules


def _stroked_box(item: pdfium.PdfObject) -> bool:
    """A stroked, unfilled rectangle: a cell drawn as a box (a filled one is shading)."""

    if pdfium_c.FPDFPath_CountSegments(item.raw) not in (4, 5):
        return False
    fill = pdfium_c.c_int()
    stroke = pdfium_c.FPDF_BOOL()
    if not pdfium_c.FPDFPath_GetDrawMode(item.raw, fill, stroke):
        return False
    return bool(stroke.value) and fill.value == 0


def _groups(rules: list[_Rule]) -> list[list[_Rule]]:
    """Rules that touch, transitively."""

    parent = list(range(len(rules)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for first in range(len(rules)):
        for second in range(first + 1, len(rules)):
            if _touch(rules[first], rules[second]):
                parent[find(first)] = find(second)
    groups: dict[int, list[_Rule]] = {}
    for index, rule in enumerate(rules):
        groups.setdefault(find(index), []).append(rule)
    return list(groups.values())


def _touch(a: _Rule, b: _Rule) -> bool:
    if a.horizontal == b.horizontal:
        return abs(a.at - b.at) <= _TOLERANCE and a.start <= b.end + _TOLERANCE and b.start <= a.end + _TOLERANCE
    horizontal, vertical = (a, b) if a.horizontal else (b, a)
    return (
        horizontal.start - _TOLERANCE <= vertical.at <= horizontal.end + _TOLERANCE
        and vertical.start - _TOLERANCE <= horizontal.at <= vertical.end + _TOLERANCE
    )


# -- Grid ----------------------------------------------------------------------------


def _positions(values: list[float]) -> list[float]:
    """Distinct positions: values within the tolerance are one, at their mean."""

    merged: list[list[float]] = []
    for value in sorted(values):
        if merged and value - merged[-1][-1] <= _TOLERANCE:
            merged[-1].append(value)
        else:
            merged.append([value])
    return [sum(group) / len(group) for group in merged]


def _covered(rules: list[_Rule], at: float, start: float, end: float) -> bool:
    """Whether rules at ``at`` draw most of the side from ``start`` to ``end``."""

    spans = sorted(
        (max(rule.start, start), min(rule.end, end))
        for rule in rules
        if abs(rule.at - at) <= _TOLERANCE and rule.end > start and rule.start < end
    )
    drawn = 0.0
    reached = start
    for low, high in spans:
        if high > reached:
            drawn += high - max(low, reached)
            reached = high
    return drawn >= (end - start) * _COVERED


def _table(rules: list[_Rule], page_no: int) -> PdfTable | None:
    horizontal = [rule for rule in rules if rule.horizontal]
    vertical = [rule for rule in rules if not rule.horizontal]
    if not horizontal or not vertical:
        return None
    xs = _positions([rule.at for rule in vertical])
    ys = _positions([rule.at for rule in horizontal])[::-1]  # top to bottom
    rows, columns = len(ys) - 1, len(xs) - 1
    if rows < _MIN_ROWS or columns < _MIN_COLUMNS:
        return None
    # Each grid cell's region: merged across every border no rule draws.
    region = [[row * columns + column for column in range(columns)] for row in range(rows)]
    parent = [cell for row in region for cell in row]

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for row in range(rows):
        top, bottom = ys[row], ys[row + 1]
        for column in range(columns - 1):
            if not _covered(vertical, xs[column + 1], bottom, top):
                parent[find(region[row][column])] = find(region[row][column + 1])
    for row in range(rows - 1):
        for column in range(columns):
            if not _covered(horizontal, ys[row + 1], xs[column], xs[column + 1]):
                parent[find(region[row][column])] = find(region[row + 1][column])
    spans: dict[int, list[int]] = {}
    for row in range(rows):
        for column in range(columns):
            root = find(region[row][column])
            first_row, first_column, last_row, last_column = spans.get(root, [row, column, row, column])
            spans[root] = [min(first_row, row), min(first_column, column), max(last_row, row), max(last_column, column)]
    table = PdfTable(page_no, xs[0], ys[-1], xs[-1], ys[0], rows, columns, xs=xs, ys=ys)
    for first_row, first_column, last_row, last_column in sorted(spans.values()):
        table.cells.append(
            PdfCell(
                row=first_row,
                column=first_column,
                row_span=last_row - first_row + 1,
                column_span=last_column - first_column + 1,
                text="",
                left=xs[first_column],
                bottom=ys[last_row + 1],
                right=xs[last_column + 1],
                top=ys[first_row],
            )
        )
    if len(table.cells) == 1:
        return None  # one box, however many rules drew it
    return table


# -- Text ----------------------------------------------------------------------------


@dataclass(slots=True)
class _Char:
    text: str
    left: float
    right: float
    #: Where its baseline is (PDF points), and the size of its font.
    baseline: float
    size: float
    #: Whether the text stream had a space just before it.
    spaced: bool


def _fill(tables: list[PdfTable], text_page: pdfium.PdfTextPage) -> None:
    """Give every cell the characters whose centre lies in it."""

    cells: dict[int, list[_Char]] = {}
    owners: list[dict[tuple[int, int], PdfCell]] = []
    for table in tables:
        owner: dict[tuple[int, int], PdfCell] = {}
        for cell in table.cells:
            for row in range(cell.row, cell.row + cell.row_span):
                for column in range(cell.column, cell.column + cell.column_span):
                    owner[(row, column)] = cell
        owners.append(owner)
    texts: dict[int, PdfCell] = {}
    spaced = False
    x_origin, y_origin = pdfium_c.c_double(), pdfium_c.c_double()
    for index in range(text_page.count_chars()):
        code = pdfium_c.FPDFText_GetUnicode(text_page.raw, index)
        if not code or chr(code).isspace():
            spaced = True
            continue
        was_spaced, spaced = spaced, False
        left, bottom, right, top = text_page.get_charbox(index)
        if right <= left and top <= bottom:
            continue
        x, y = (left + right) / 2, (bottom + top) / 2
        for table, owner in zip(tables, owners, strict=True):
            if not table.holds(x, y):
                continue
            column = min(max(bisect_right(table.xs, x) - 1, 0), table.columns - 1)
            row = min(sum(1 for line in table.ys[1:-1] if y < line), table.rows - 1)
            cell = owner.get((row, column))
            if cell is not None:
                pdfium_c.FPDFText_GetCharOrigin(text_page.raw, index, x_origin, y_origin)
                size = pdfium_c.FPDFText_GetFontSize(text_page.raw, index) or (top - bottom)
                cells.setdefault(id(cell), []).append(
                    _Char(chr(code), left, right, y_origin.value, size, was_spaced)
                )
                texts[id(cell)] = cell
            break
    for key, characters in cells.items():
        texts[key].text = _read(characters)


def _read(characters: list[_Char]) -> str:
    """A cell's characters as text: lines by baseline, top to bottom, each left to right.

    A word break is a space the text stream had (where the characters are
    apart at all) or a gap wider than a third of the font size; a glyph drawn
    late from a fallback font sits on its line with no gap, so it joins its word.
    """

    lines: list[list[_Char]] = []
    for char in sorted(characters, key=lambda c: -c.baseline):
        line = lines[-1] if lines else None
        if line is not None and line[0].baseline - char.baseline <= 0.3 * max(char.size, line[0].size):
            line.append(char)
        else:
            lines.append([char])
    words: list[str] = []
    for line in lines:
        line.sort(key=lambda c: c.left)
        text = ""
        previous: _Char | None = None
        for char in line:
            if previous is not None:
                gap = char.left - previous.right
                if gap > char.size / 3 or (char.spaced and gap > char.size * 0.05):
                    text += " "
            text += char.text
            previous = char
        words.append(text)
    return " ".join(" ".join(words).split())


__all__ = ["PdfCell", "PdfTable", "page_tables"]
