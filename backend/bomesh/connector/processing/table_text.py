"""A table as the chunker reads it: one line per row, every value named by its column.

Docling's triplet serializer writes ``"<first cell>, <column> = value"`` for
every cell: an empty value still costs a statement, a header two rows deep
becomes ``"TT.TT"``, and the row is named by its first column even when that is
a row number. Split at a token bound, a row's statements are cut apart, and a
chunk no longer says which row a number belongs to. Here a row is one line::

    Khoa Xây dựng: TT = 12; Số lượng SV tốt nghiệp = 132; … – Tuần 3 (19-23/10/2020) = 73

- the row is named by its row-header cell (``TableCell.row_header``), else
  by its first cell when that is not a number;
- a column is named by every distinct level of its header band, top down,
  joined with `` – ``;
- empty values and the cells a span repeats are left out; a cell holding
  paragraphs or a list (DOCX) reads as its plain text, never Markdown.

The serializer splits a long table at row boundaries, so every chunk of a
table carries its rows whole. A row too long for one chunk (a survey
respondent's hundred answers) is written as several lines cut between values,
each starting with the row's name and first value, so every part still says
whose values it holds.
"""

from __future__ import annotations

import re
from typing import Any

from docling_core.transforms.chunker.hierarchical_chunker import (
    ChunkingDocSerializer,
    ChunkingSerializerProvider,
)
from docling_core.transforms.serializer.base import (
    BaseDocSerializer,
    BaseTableSerializer,
    SerializationResult,
)
from docling_core.transforms.serializer.common import create_ser_result
from docling_core.types.doc import DoclingDocument, TableItem

#: Joins the levels of a two-row header into one column name.
_LEVEL_SEPARATOR = " – "
_NUMBER = re.compile(r"^[-+]?\d[\d.,\s]*%?$")
#: A row line longer than this (UTF-8 bytes) is cut between values. Below the
#: chunker's bound (``ApproximateTokenizer``: 256 tokens of 3 bytes), with room
#: for the headings a chunk repeats.
_MAX_ROW_BYTES = 600


def table_text(table: TableItem, document: DoclingDocument) -> str:
    """``table`` as one line per body row (see the module docstring)."""

    grid = table.data.grid
    if not grid:
        return ""
    columns = table.data.num_cols
    header_rows = 0
    while header_rows < len(grid) and any(cell.column_header for cell in grid[header_rows]):
        header_rows += 1
    names: list[str] = []
    for column in range(columns):
        levels: list[str] = []
        for row in grid[:header_rows]:
            text = _cell_text(row[column], document)
            if text and text not in levels:
                levels.append(text)
        names.append(_LEVEL_SEPARATOR.join(levels))
    body = grid[header_rows:]
    # A row without a row header is named by its first cell, unless that is
    # a number (a row number, a figure): then every value keeps its column name.
    label: int | None = next(
        (column for column in range(columns) if any(row[column].row_header for row in body)),
        0 if columns > 1 and not _numeric_column(body, 0, document) else None,
    )
    lines: list[str] = []
    for row in body:
        seen: set[tuple[int, int]] = set()
        name = ""
        if label is not None:
            cell = row[label]
            seen.add((cell.start_row_offset_idx, cell.start_col_offset_idx))
            name = _cell_text(cell, document)
        values: list[str] = []
        for column, cell in enumerate(row):
            key = (cell.start_row_offset_idx, cell.start_col_offset_idx)
            if key in seen:
                continue
            seen.add(key)
            value = _cell_text(cell, document)
            if value:
                values.append(f"{names[column]} = {value}" if names[column] else value)
        if values:
            lines += _row_lines(name, values)
        elif name:
            lines.append(name)
    if not lines:
        # A header-only table still says what it would hold.
        return "; ".join(name for name in names if name)
    return "\n".join(lines)



def _row_lines(name: str, values: list[str]) -> list[str]:
    """One row as lines of at most ``_MAX_ROW_BYTES``, each led by the row's identity."""

    head = f"{name}: " if name else ""
    identity = f"{head}{values[0]}"
    lines: list[str] = []
    current = identity
    for value in values[1:]:
        candidate = f"{current}; {value}"
        if len(candidate.encode("utf-8")) > _MAX_ROW_BYTES and current != identity:
            lines.append(current)
            candidate = f"{identity}; {value}"
        current = candidate
    lines.append(current)
    return lines

class RowTableSerializer(BaseTableSerializer):
    """Docling's table serializer contract over :func:`table_text`."""

    def serialize(
        self,
        *,
        item: TableItem,
        doc_serializer: BaseDocSerializer,
        doc: DoclingDocument,
        **kwargs: Any,
    ) -> SerializationResult:
        parts: list[SerializationResult] = []
        captions = doc_serializer.serialize_captions(item=item, **kwargs)
        if captions.text:
            parts.append(captions)
        if item.self_ref not in doc_serializer.get_excluded_refs(**kwargs):
            text = table_text(item, doc)
            if text:
                parts.append(create_ser_result(text=text, span_source=item))
        return create_ser_result(text="\n\n".join(part.text for part in parts), span_source=parts)

    def get_header_and_body_lines(
        self, *, table_text: str, **kwargs: Any
    ) -> tuple[list[str], list[str]]:
        """Every line is a whole row and names its columns: no header to repeat.

        The line chunker joins lines as given, so each keeps its line break.
        """

        return [], [f"{line}\n" for line in table_text.split("\n") if line.strip()]


class RowTableSerializerProvider(ChunkingSerializerProvider):
    """The chunking serializer with tables as rows."""

    def get_serializer(self, doc: DoclingDocument) -> ChunkingDocSerializer:
        return ChunkingDocSerializer(doc=doc, table_serializer=RowTableSerializer())


def _numeric_column(body: list[list[Any]], column: int, document: DoclingDocument) -> bool:
    """Whether most filled body cells of ``column`` are numbers."""

    values = [text for row in body if (text := _cell_text(row[column], document))]
    return bool(values) and sum(bool(_NUMBER.match(v)) for v in values) * 2 > len(values)


def _cell_text(cell: Any, document: DoclingDocument) -> str:
    """A cell's plain text. A rich cell (a DOCX cell holding paragraphs or a list)
    keeps its plain text too; Docling would serialize its content as Markdown."""

    return _plain(cell.text or cell._get_text(doc=document))


def _plain(value: str) -> str:
    return " ".join(value.split())


__all__ = ["RowTableSerializer", "RowTableSerializerProvider", "table_text"]
