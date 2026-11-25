"""Legacy Excel (``.xls``, BIFF) workbooks rewritten as ``.xlsx`` for the workbook parser.

Docling reads only Office Open XML. Read through its PDF, a workbook becomes
printed pages: rows run together and no value is named by its column. The
rewrite keeps what the parser reads (:mod:`bomesh.connector.processing.spreadsheet`):
every sheet, cell values (dates as dates), number formats and merged cells.
"""

from __future__ import annotations

from pathlib import Path

import xlrd
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

_EMPTY = {xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK}


def xls_to_xlsx(source: Path, target: Path) -> None:
    """Write the ``.xls`` workbook at ``source`` as an ``.xlsx`` workbook at ``target``."""

    book = xlrd.open_workbook(str(source), formatting_info=True, on_demand=True)
    try:
        output = Workbook()
        output.remove(output.active)
        for index in range(book.nsheets):
            sheet = book.sheet_by_index(index)
            target_sheet = output.create_sheet(title=sheet.name[:31] or f"Sheet{index + 1}")
            for row in range(sheet.nrows):
                for column in range(sheet.ncols):
                    cell = sheet.cell(row, column)
                    if cell.ctype in _EMPTY:
                        continue
                    written = target_sheet.cell(row=row + 1, column=column + 1, value=_value(book, cell))
                    number_format = book.format_map[book.xf_list[cell.xf_index].format_key].format_str
                    if cell.ctype in (xlrd.XL_CELL_NUMBER, xlrd.XL_CELL_DATE) and number_format:
                        written.number_format = number_format
            for top, bottom, left, right in sheet.merged_cells:
                if bottom - top > 1 or right - left > 1:
                    target_sheet.merge_cells(
                        start_row=top + 1, end_row=bottom, start_column=left + 1, end_column=right
                    )
            book.unload_sheet(index)
        output.save(target)
    finally:
        book.release_resources()


def _value(book: xlrd.Book, cell: xlrd.sheet.Cell) -> object:
    if cell.ctype == xlrd.XL_CELL_TEXT:
        return ILLEGAL_CHARACTERS_RE.sub("", cell.value)
    if cell.ctype == xlrd.XL_CELL_DATE:
        try:
            return xlrd.xldate_as_datetime(cell.value, book.datemode)
        except (ValueError, OverflowError, xlrd.xldate.XLDateError):
            return cell.value
    if cell.ctype == xlrd.XL_CELL_BOOLEAN:
        return bool(cell.value)
    if cell.ctype == xlrd.XL_CELL_ERROR:
        return xlrd.error_text_from_code.get(cell.value, "#ERR")
    return cell.value


__all__ = ["xls_to_xlsx"]
