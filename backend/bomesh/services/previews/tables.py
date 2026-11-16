"""TABLE: the sheets of a CSV, TSV or XLSX file as bounded gzip JSON.

``application/vnd.bomesh.table+json``::

    {"schema": 1, "sheets": [{"name", "rows": [[cell, ...], ...],
     "totalRows", "totalColumns", "truncated"}]}

Cells are the displayed values as strings (dates ISO 8601, numbers as
stored); trailing empty cells and rows are dropped. Bounds: :data:`MAX_SHEETS`
sheets, :data:`MAX_COLUMNS` columns and :data:`MAX_ROWS` rows per sheet,
:data:`MAX_CELLS` cells in all; past one the rest is dropped and ``truncated``
is set on the sheet (and the representation). Rows are streamed: a CSV is
read row by row (past the bounds only counted), a workbook with openpyxl in
read-only mode, values only, until its bounds.
"""

from __future__ import annotations

import csv
import gzip
import json
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

import openpyxl
from openpyxl.utils.exceptions import InvalidFileException

from bomesh.services.previews.results import EMPTY, UNREADABLE, ConversionFailed, Output
from bomesh.services.previews.text import decode_text, detect_encoding

TABLE_CONTENT_TYPE = "application/vnd.bomesh.table+json"
TABLE_SCHEMA = 1
MAX_SHEETS = 50
MAX_COLUMNS = 200
MAX_ROWS = 10_000
MAX_CELLS = 1_000_000
#: Bytes of a CSV read to detect its encoding and dialect.
_SAMPLE_BYTES = 64 * 1024
#: Largest single CSV field accepted (the csv module's default is 128 KiB).
_FIELD_CHARS = 1024 * 1024


@dataclass(slots=True)
class _Sheet:
    name: str
    rows: list[list[str]] = field(default_factory=list)
    total_rows: int = 0
    total_columns: int = 0
    truncated: bool = False

    def payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "rows": self.rows,
            "totalRows": self.total_rows,
            "totalColumns": self.total_columns,
            "truncated": self.truncated,
        }


@dataclass(slots=True)
class _Budget:
    """Cells the whole representation may still hold."""

    cells: int = field(default_factory=lambda: MAX_CELLS)


def produce_table(source: Path, extension: str, *, name: str) -> Output:
    """The TABLE representation of ``source`` (``csv``, ``tsv``, ``xlsx`` or ``xlsm``).

    ``name`` names the single sheet of a CSV or TSV file.
    """
    if extension in ("xlsx", "xlsm"):
        sheets, dropped = _workbook(source)
    else:
        sheets, dropped = [_delimited(source, name=name, tab=extension == "tsv")], False
    if not any(sheet.rows for sheet in sheets):
        raise ConversionFailed(EMPTY, "the table has no cells")
    payload = {"schema": TABLE_SCHEMA, "sheets": [sheet.payload() for sheet in sheets]}
    return Output(
        data=gzip_json(payload),
        mime_type=TABLE_CONTENT_TYPE,
        extension="table.json",
        content_encoding="gzip",
        truncated=dropped or any(sheet.truncated for sheet in sheets),
    )


def gzip_json(payload: dict[str, Any]) -> bytes:
    """Compact UTF-8 JSON, gzip-compressed (stored with ``Content-Encoding: gzip``)."""
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return gzip.compress(data, compresslevel=6, mtime=0)


def _delimited(source: Path, *, name: str, tab: bool) -> _Sheet:
    with source.open("rb") as stream:
        sample = stream.read(_SAMPLE_BYTES)
    complete = source.stat().st_size <= _SAMPLE_BYTES
    encoding = detect_encoding(sample, complete=complete)
    dialect: Any = csv.excel_tab if tab else _dialect(decode_text(sample, complete=complete))
    csv.field_size_limit(_FIELD_CHARS)
    sheet = _Sheet(name=name)
    # ``utf-8-sig``/``utf-16`` drop their byte-order mark themselves.
    with source.open(encoding=encoding, errors="replace", newline="") as stream:
        try:
            _fill(sheet, csv.reader(stream, dialect), _Budget(), count_rest=True)
        except csv.Error as exc:
            raise ConversionFailed(UNREADABLE, f"the file is not valid CSV: {exc}") from exc
    return sheet


def _dialect(sample: str) -> Any:
    # Sniff whole lines only: a cut last line misleads the sniffer.
    lines = sample.splitlines()[:50]
    try:
        return csv.Sniffer().sniff("\n".join(lines), delimiters=",;\t|")
    except csv.Error:
        return csv.excel


def _workbook(source: Path) -> tuple[list[_Sheet], bool]:
    try:
        workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, OSError, ValueError) as exc:
        raise ConversionFailed(UNREADABLE, "the workbook cannot be read") from exc
    try:
        budget = _Budget()
        sheets: list[_Sheet] = []
        worksheets = workbook.worksheets
        for worksheet in worksheets[:MAX_SHEETS]:
            if budget.cells <= 0:
                break
            sheet = _Sheet(name=str(worksheet.title))
            rows = ([_cell(value) for value in row] for row in worksheet.iter_rows(values_only=True))
            _fill(sheet, rows, budget, count_rest=False)
            if sheet.truncated:
                # Reading stopped at the bounds: the sheet's declared size counts the rest.
                sheet.total_rows = max(sheet.total_rows, _int(worksheet.max_row))
                sheet.total_columns = max(sheet.total_columns, _int(worksheet.max_column))
            sheets.append(sheet)
        dropped = len(sheets) < len(worksheets)
    except (zipfile.BadZipFile, KeyError, OSError, ValueError, TypeError) as exc:
        raise ConversionFailed(UNREADABLE, "the workbook cannot be read") from exc
    finally:
        workbook.close()
    return sheets, dropped


def _fill(sheet: _Sheet, rows: Iterable[list[str]], budget: _Budget, *, count_rest: bool) -> None:
    """Keep ``rows`` within the bounds and size the sheet.

    Blank rows between data are kept (as ``[]``), trailing ones are not.
    Past a bound, ``count_rest`` keeps reading only to count the sheet's rows
    and columns; otherwise reading stops.
    """
    keeping = True
    blank = 0
    for number, raw in enumerate(rows, start=1):
        row = _trimmed(raw)
        if not row:
            blank += 1
            continue
        sheet.total_rows = number
        sheet.total_columns = max(sheet.total_columns, len(row))
        if not keeping:
            if count_rest:
                continue
            break
        if len(row) > MAX_COLUMNS:
            row = row[:MAX_COLUMNS]
            sheet.truncated = True
        if len(sheet.rows) + blank + 1 > MAX_ROWS or len(row) > budget.cells:
            if len(row) > budget.cells:
                budget.cells = 0  # The representation is full: later sheets are dropped.
            sheet.truncated = True
            keeping = False
            if not count_rest:
                break
            continue
        sheet.rows.extend([] for _ in range(blank))
        sheet.rows.append(row)
        budget.cells -= len(row)
        blank = 0


def _trimmed(row: list[str]) -> list[str]:
    end = len(row)
    while end and not row[end - 1]:
        end -= 1
    return row[:end]


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e16:
        return str(int(value))
    if isinstance(value, datetime):
        if value.time() == time.min and value.tzinfo is None:
            return value.date().isoformat()
        return value.isoformat()
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    return str(value)


def _int(value: object) -> int:
    return value if isinstance(value, int) else 0


__all__ = [
    "MAX_CELLS",
    "MAX_COLUMNS",
    "MAX_ROWS",
    "MAX_SHEETS",
    "TABLE_CONTENT_TYPE",
    "TABLE_SCHEMA",
    "gzip_json",
    "produce_table",
]
