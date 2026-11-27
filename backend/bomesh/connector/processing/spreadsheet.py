"""Shape a workbook's Docling tables into what a reader of the sheet sees.

Docling's xlsx backend turns every contiguous block of a sheet into one table
and takes its first row as the column header. Real workbooks are often forms:
a letterhead block, a title merged over the table, a header two rows deep,
numbered rows, notes under the table. Read as Docling leaves them, every value
is cited as "<title> = value" against a row number, and a model answers from
the wrong row. Per sheet, in reading order:

- a table inside another table's box is dropped: Docling reads a table's
  whole box but grows it only from touching cells, so in a sparse matrix (a
  survey sheet, one row per respondent, a ``1`` under each chosen option)
  every cell that touched nothing is read a second time as a table of its own;
- a cell that is only a repeated character (``¾¾¾``, ``-----``) is decoration
  and is emptied, and so is a formula error (``#REF!``, ``#N/A``): it says
  nothing about the row;
- numbers and dates are shown as the sheet formats them (``0.00``, ``#,##0``,
  ``0%``, ``dd/mm/yyyy``), read from the workbook (Docling keeps the raw value);
- a block whose rows hold one value each (notes) becomes text, row by row; a
  short block of two-value rows above another table (a letterhead: issuer on
  the left, motto and date on the right) becomes text, column by column;
- in a table, leading rows holding one value (a title, a remark) become text
  before it; the header is the first remaining row and every row a header
  cell spans into, so a two-level header labels each column with both levels;
- the first column of mostly non-numeric values (a name, not a row number)
  is the row header that labels each row.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO

from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    TableCell,
    TableData,
    TableItem,
)
from openpyxl import load_workbook

log = logging.getLogger(__name__)

#: A cell that is one symbol repeated (``¾¾¾``, ``-----``) draws a line; it says nothing.
#: A repeated digit or letter (``111``, ``AAA``) is a value.
_REPEATED = re.compile(r"^(\S)\1{2,}$")
_NUMBER = re.compile(r"^[-+]?\d[\d.,\s]*%?$")
#: Spreadsheet formula errors: a cached result that never was a value.
_FORMULA_ERRORS = frozenset(
    {"#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?", "#NUM!", "#NULL!", "#SPILL!", "#CALC!"}
)
#: A block above another table this short, with no row of three values, is layout.
_LAYOUT_MAX_ROWS = 8
#: A column labels the rows when this share of its body cells is filled and not numeric.
_LABEL_SHARE = 0.6


def shape_workbook(document: DoclingDocument, source: Path | BinaryIO | None) -> None:
    """Shape every sheet's tables of ``document`` (converted from ``source``) in place."""

    numbers = _formatted_numbers(document, source) if source is not None else {}
    #: Tables turned into text (or empty), deleted in one pass: each deletion walks the document.
    replaced: list[TableItem] = []
    for group in list(document.groups):
        if getattr(group.label, "value", group.label) != "sheet":
            continue
        tables = [
            item
            for child in group.children
            if isinstance(item := child.resolve(document), TableItem)
        ]
        enclosed = _enclosed(tables)
        replaced += enclosed
        dropped = {id(item) for item in enclosed}
        tables = [table for table in tables if id(table) not in dropped]
        for index, table in enumerate(tables):
            _format_numbers(table, numbers.get(id(table), {}))
            _drop_decoration(table)
            widest = max((len(row) for row in _row_values(table).values()), default=0)
            if widest == 0:
                replaced.append(table)
            elif widest == 1:
                _to_text(document, table, by_columns=False)
                replaced.append(table)
            elif (
                widest == 2
                and index < len(tables) - 1
                and table.data.num_rows <= _LAYOUT_MAX_ROWS
            ):
                _to_text(document, table, by_columns=True)
                replaced.append(table)
            else:
                _lift_banners(document, table)
                _mark_headers(table)
    if replaced:
        document.delete_items(node_items=replaced)


# -- Numbers ----------------------------------------------------------------------


def _formatted_numbers(
    document: DoclingDocument, source: Path | BinaryIO
) -> dict[int, dict[tuple[int, int], str]]:
    """Per table, the formatted text of each numeric cell, by (row, column) offset.

    A table's provenance box is its place on the sheet (columns and rows from
    0). Best effort: a workbook openpyxl cannot read keeps Docling's text.
    """

    if hasattr(source, "seek"):
        source.seek(0)
    try:
        workbook = load_workbook(source, read_only=True, data_only=True)
    except Exception:  # noqa: BLE001 - formatting is cosmetic; Docling already read it
        log.warning("workbook number formats unavailable", exc_info=True)
        return {}
    try:
        output: dict[int, dict[tuple[int, int], str]] = {}
        for group in document.groups:
            if getattr(group.label, "value", group.label) != "sheet" or group.name not in workbook:
                continue
            boxes = {
                id(table): (int(table.prov[0].bbox.l), int(table.prov[0].bbox.t), table)
                for child in group.children
                if isinstance(table := child.resolve(document), TableItem) and table.prov
            }
            if not boxes:
                continue
            # One pass over the rows the tables cover: a read-only sheet re-reads
            # its XML from the start for every iter_rows call.
            shown: dict[tuple[int, int], str] = {}
            for row in workbook[group.name].iter_rows(
                min_row=min(top for _, top, _ in boxes.values()) + 1,
                max_row=max(top + table.data.num_rows for _, top, table in boxes.values()),
                min_col=min(left for left, _, _ in boxes.values()) + 1,
                max_col=max(left + table.data.num_cols for left, _, table in boxes.values()),
            ):
                for cell in row:
                    text = display_number(
                        getattr(cell, "value", None), getattr(cell, "number_format", "General")
                    )
                    if text is not None:
                        shown[(cell.row - 1, cell.column - 1)] = text
            for key, (left, top, table) in boxes.items():
                output[key] = {
                    (row, column): text
                    for row in range(table.data.num_rows)
                    for column in range(table.data.num_cols)
                    if (text := shown.get((top + row, left + column))) is not None
                }
        return output
    finally:
        workbook.close()


def display_number(value: Any, number_format: str | None) -> str | None:
    """``value`` as a sheet shows it under ``number_format``; ``None`` for a non-number.

    Covers what tables use: decimals, digit grouping, percent and exponent.
    ``General`` shows at most ten significant digits, like a spreadsheet does.
    A date shows day, month and year in the format's order (``dd/mm/yyyy``).
    """

    if isinstance(value, datetime):
        return _display_date(value, number_format or "")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    section = (number_format or "General").split(";", 1)[0]
    section = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.|_.|\*.', "", section).strip()
    if section.lower() in {"", "general", "@"}:
        return f"{value:.10g}" if isinstance(value, float) else str(value)
    percent = "%" in section
    number = value * 100 if percent else value
    fraction = re.search(r"\.([0#?]+)", section)
    decimals = len(fraction.group(1)) if fraction else 0
    if "E" in section.upper():
        return f"{number:.{decimals}E}"
    grouped = "," in section.split(".", 1)[0]
    text = f"{number:,.{decimals}f}" if grouped else f"{number:.{decimals}f}"
    return f"{text}%" if percent else text


def _display_date(value: datetime, number_format: str) -> str:
    section = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", number_format.split(";", 1)[0]).lower()
    order = [part for part in re.findall(r"[dmy]", section) if part in "dmy"]
    first = next(iter(order), "y")
    day = {"d": "%d/%m/%Y", "m": "%m/%d/%Y"}.get(first, "%Y-%m-%d")
    has_time = "h" in section or (not order and (value.hour, value.minute, value.second) != (0, 0, 0))
    return value.strftime(f"{day} %H:%M" if has_time else day)


def _format_numbers(table: TableItem, shown: dict[tuple[int, int], str]) -> None:
    if not shown:
        return
    table.data = _with_cells(
        table.data,
        (
            cell.model_copy(update={"text": text})
            if (text := shown.get((cell.start_row_offset_idx, cell.start_col_offset_idx)))
            is not None
            else cell
            for cell in table.data.table_cells
        ),
    )


# -- Blocks that are not tables ---------------------------------------------------


# -- Fragments ---------------------------------------------------------------------


def _enclosed(tables: list[TableItem]) -> list[TableItem]:
    """The tables lying inside another table's box: copies of cells that table holds.

    Docling grows a table from touching cells but reads its whole box, gaps
    included; a cell inside the box that touched nothing starts a table of its
    own as well, so a sparse matrix is read once whole and again as hundreds of
    one-cell tables.
    """

    def area(table: TableItem) -> int:
        return table.data.num_rows * table.data.num_cols

    boxes = [(table, table.prov[0].bbox) for table in tables if table.prov]
    containers = [(table, box) for table, box in boxes if area(table) > 1]
    return [
        table
        for table, box in boxes
        if any(
            area(other) > area(table)
            and outer.l <= box.l
            and box.r <= outer.r
            and outer.t <= box.t
            and box.b <= outer.b
            for other, outer in containers
        )
    ]


def _drop_decoration(table: TableItem) -> None:
    table.data = _with_cells(
        table.data,
        (
            cell.model_copy(update={"text": ""}) if _is_decoration(cell.text) else cell
            for cell in table.data.table_cells
        ),
    )


def _is_decoration(text: str) -> bool:
    value = text.strip()
    if value.upper() in _FORMULA_ERRORS:
        return True
    return bool(_REPEATED.match(value)) and not value[0].isalpha() and not value[0].isdecimal()


def _row_values(table: TableItem) -> dict[int, list[TableCell]]:
    """The filled cells starting on each row (a spanned cell once)."""

    rows: dict[int, list[TableCell]] = {}
    for cell in table.data.table_cells:
        if cell.text.strip():
            rows.setdefault(cell.start_row_offset_idx, []).append(cell)
    return rows


def _to_text(document: DoclingDocument, table: TableItem, *, by_columns: bool) -> None:
    """Insert ``table``'s values before it as text items, in reading order (the caller deletes it)."""

    cells = [cell for row in _row_values(table).values() for cell in row]
    cells.sort(
        key=(
            (lambda c: (c.start_col_offset_idx, c.start_row_offset_idx))
            if by_columns
            else (lambda c: (c.start_row_offset_idx, c.start_col_offset_idx))
        )
    )
    for cell in cells:
        document.insert_text(
            sibling=table,
            label=DocItemLabel.TEXT,
            text=" ".join(cell.text.split()),
            prov=_cell_prov(table, cell),
            content_layer=table.content_layer,
            after=False,
        )


# -- Tables -----------------------------------------------------------------------


def _lift_banners(document: DoclingDocument, table: TableItem) -> None:
    """Move leading banner rows before the table as text.

    A banner row holds one value (a title, a remark), or two in a table at
    least four values wide (a letterhead touching the table: issuer on the
    left, motto on the right).
    """

    data = table.data
    rows = _row_values(table)
    widest = max((len(values) for values in rows.values()), default=0)
    banner_width = 2 if widest >= 4 else 1
    row = 0
    while row < data.num_rows - 2 and len(values := rows.get(row, [])) <= banner_width:
        tall = [cell for cell in values if cell.row_span != 1]
        # A title merged over several rows is a banner when it spans most of
        # the table's width; a tall narrow cell ("STT") starts the header.
        if not tall:
            row += 1
        elif len(values) == 1 and tall[0].col_span * 2 >= data.num_cols:
            row = tall[0].end_row_offset_idx
        else:
            break
    straddling = any(
        cell.start_row_offset_idx < row < cell.end_row_offset_idx for cell in data.table_cells
    )
    if row == 0 or len(rows.get(row, [])) < 2 or straddling:
        return
    for banner in sorted(
        (cell for index in range(row) for cell in rows.get(index, [])),
        key=lambda c: (c.start_row_offset_idx, c.start_col_offset_idx),
    ):
        document.insert_text(
            sibling=table,
            label=DocItemLabel.TEXT,
            text=" ".join(banner.text.split()),
            prov=_cell_prov(table, banner),
            content_layer=table.content_layer,
            after=False,
        )
    table.data = TableData(
        num_rows=data.num_rows - row,
        num_cols=data.num_cols,
        table_cells=[
            cell.model_copy(
                update={
                    "start_row_offset_idx": cell.start_row_offset_idx - row,
                    "end_row_offset_idx": cell.end_row_offset_idx - row,
                }
            )
            for cell in data.table_cells
            if cell.start_row_offset_idx >= row
        ],
    )
    if table.prov:
        origin = table.prov[0]
        origin.bbox = origin.bbox.model_copy(update={"t": origin.bbox.t + row})


def _mark_headers(table: TableItem) -> None:
    """Mark the header band (column headers) and the label column (row headers)."""

    data = table.data
    end = 1
    while True:
        grown = max(
            (c.end_row_offset_idx for c in data.table_cells if c.start_row_offset_idx < end),
            default=end,
        )
        if grown <= end:
            break
        end = grown
    if end >= data.num_rows:
        end = 1
    body = [c for c in data.table_cells if c.start_row_offset_idx >= end]
    body_rows = data.num_rows - end
    label: int | None = None
    if data.num_cols > 1 and body_rows:
        for column in range(data.num_cols):
            values = [
                c.text.strip()
                for c in body
                if c.start_col_offset_idx == column and c.text.strip()
            ]
            words = [v for v in values if not _NUMBER.match(v)]
            if len(values) >= _LABEL_SHARE * body_rows and len(words) >= _LABEL_SHARE * len(values):
                label = column
                break
    table.data = _with_cells(
        data,
        (
            cell.model_copy(
                update={
                    "column_header": cell.start_row_offset_idx < end,
                    "row_header": cell.start_row_offset_idx >= end
                    and label is not None
                    and cell.start_col_offset_idx == label,
                }
            )
            for cell in data.table_cells
        ),
    )


# -- Helpers ----------------------------------------------------------------------


def _with_cells(data: TableData, cells: Iterable[TableCell]) -> TableData:
    return TableData(num_rows=data.num_rows, num_cols=data.num_cols, table_cells=list(cells))


def _cell_prov(table: TableItem, cell: TableCell) -> ProvenanceItem | None:
    """Where ``cell`` is on its sheet: the table's box offset by the cell's place."""

    if not table.prov:
        return None
    origin = table.prov[0]
    left = origin.bbox.l + cell.start_col_offset_idx
    top = origin.bbox.t + cell.start_row_offset_idx
    return ProvenanceItem(
        page_no=origin.page_no,
        charspan=(0, 0),
        bbox=BoundingBox(
            l=left,
            t=top,
            r=left + cell.col_span,
            b=top + cell.row_span,
            coord_origin=CoordOrigin.TOPLEFT,
        ),
    )


__all__ = ["display_number", "shape_workbook"]
