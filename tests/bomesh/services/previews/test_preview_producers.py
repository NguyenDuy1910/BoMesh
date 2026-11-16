"""The engine's local producers: TEXT, TABLE, ARCHIVE, IMAGE and the HTML of e-mail.

Each turns a file into its bounded representation, or raises
``ConversionFailed`` for a file that cannot be shown. Fixtures are made in
memory (openpyxl, zipfile, Pillow, the email package).
"""

from __future__ import annotations

import gzip
import json
import zipfile
from datetime import date, datetime
from email.message import EmailMessage
from io import BytesIO
from pathlib import Path
from typing import Any

import openpyxl
import pytest
from PIL import Image

from bomesh.services.previews import archives, tables
from bomesh.services.previews.archives import produce_archive
from bomesh.services.previews.gotenberg import email_html, mhtml_html
from bomesh.services.previews.images import MAX_SIDE, produce_image
from bomesh.services.previews.results import EMPTY, UNREADABLE, ConversionFailed
from bomesh.services.previews.tables import TABLE_CONTENT_TYPE, produce_table
from bomesh.services.previews.text import TEXT_BYTES, produce_text

FRENCH = (
    "Le café crème coûte trois euros à Paris; déjà très cher pour un étudiant naïf. "
    "Où est la bibliothèque? Les élèves préfèrent le thé glacé en été.\n"
) * 20


def _text(data: bytes, *, complete: bool = True, markdown: bool = False, pretty: bool = False) -> Any:
    return produce_text(data, complete=complete, markdown=markdown, pretty_json=pretty)


def _json(data: bytes) -> Any:
    return json.loads(gzip.decompress(data))


# -- TEXT ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "data",
    [
        pytest.param(FRENCH.encode("cp1252"), id="cp1252"),
        pytest.param(FRENCH.encode("utf-16"), id="utf-16-bom"),
        pytest.param(b"\xef\xbb\xbf" + FRENCH.encode("utf-8"), id="utf-8-bom"),
        pytest.param(FRENCH.encode("utf-8"), id="utf-8"),
    ],
)
def test_text_in_any_encoding_becomes_utf8(data: bytes) -> None:
    output = _text(data)

    assert output.data.decode("utf-8") == FRENCH
    assert output.mime_type == "text/plain; charset=utf-8"
    assert output.extension == "txt"
    assert output.content_encoding is None and output.truncated is False


def test_markdown_keeps_its_text_and_type() -> None:
    output = _text("# Titre\n\nUn paragraphe.".encode(), markdown=True)

    assert output.data == "# Titre\n\nUn paragraphe.".encode()
    assert (output.mime_type, output.extension) == ("text/markdown; charset=utf-8", "md")


def test_a_longer_file_keeps_its_first_mib_cut_on_a_character() -> None:
    original = b"a" + "é".encode() * TEXT_BYTES  # 2 MiB + 1 byte: the cut splits a character
    prefix = original[:TEXT_BYTES]  # what the engine's Range read returns

    output = _text(prefix, complete=False)

    text = output.data.decode("utf-8")  # strict: no half character survives
    assert output.truncated is True
    assert len(output.data) <= TEXT_BYTES
    assert text == "a" + "é" * ((TEXT_BYTES - 1) // 2)


def test_text_that_grows_in_utf8_is_cut_to_one_mib() -> None:
    original = FRENCH * (TEXT_BYTES * 97 // 100 // len(FRENCH))
    data = original.encode("cp1252")
    assert len(data) <= TEXT_BYTES < len(original.encode("utf-8"))

    output = _text(data)

    assert output.truncated is True
    assert len(output.data) <= TEXT_BYTES
    assert original.startswith(output.data.decode("utf-8"))


def test_json_is_pretty_printed_when_it_parses() -> None:
    assert _text(b'{"a":[1,2],"b":"\xc3\xa9"}', pretty=True).data.decode() == (
        '{\n  "a": [\n    1,\n    2\n  ],\n  "b": "é"\n}'
    )
    assert _text(b'{"a": broken', pretty=True).data == b'{"a": broken'


def test_binary_or_empty_text_is_a_file_failure() -> None:
    with pytest.raises(ConversionFailed) as binary:
        _text(bytes(range(256)) * 64)
    assert binary.value.reason == UNREADABLE
    with pytest.raises(ConversionFailed) as empty:
        _text(b"  \n")
    assert empty.value.reason == EMPTY


# -- TABLE -----------------------------------------------------------------------------


def _table(path: Path, extension: str, name: str = "data") -> tuple[Any, dict[str, Any]]:
    output = produce_table(path, extension, name=name)
    assert output.mime_type == TABLE_CONTENT_TYPE
    assert (output.extension, output.content_encoding) == ("table.json", "gzip")
    payload = _json(output.data)
    assert payload["schema"] == 1
    return output, payload


def test_csv_dialect_is_sniffed(tmp_path: Path) -> None:
    source = tmp_path / "source.csv"
    source.write_text('name;amount;note\n"Smith; John";12,5;"said ""hi"""\nDoe;3;\n', "utf-8")

    output, payload = _table(source, "csv", name="ledger")

    [sheet] = payload["sheets"]
    assert sheet == {
        "name": "ledger",
        "rows": [["name", "amount", "note"], ["Smith; John", "12,5", 'said "hi"'], ["Doe", "3"]],
        "totalRows": 3,
        "totalColumns": 3,
        "truncated": False,
    }
    assert output.truncated is False


def test_tsv_and_a_legacy_encoding(tmp_path: Path) -> None:
    source = tmp_path / "source.tsv"
    source.write_bytes("ville\tprix\nMontréal\t12\nQuébec\t9,5\n".encode("cp1252") * 200)

    _, payload = _table(source, "tsv")

    rows = payload["sheets"][0]["rows"]
    assert rows[:3] == [["ville", "prix"], ["Montréal", "12"], ["Québec", "9,5"]]


def test_csv_bounds_truncate_and_still_count(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables, "MAX_ROWS", 3)
    monkeypatch.setattr(tables, "MAX_COLUMNS", 2)
    source = tmp_path / "source.csv"
    source.write_text("".join(f"{n},b,c\n" for n in range(10)), "utf-8")

    output, payload = _table(source, "csv")

    [sheet] = payload["sheets"]
    assert sheet["rows"] == [["0", "b"], ["1", "b"], ["2", "b"]]
    assert (sheet["totalRows"], sheet["totalColumns"], sheet["truncated"]) == (10, 3, True)
    assert output.truncated is True


def _workbook(path: Path, sheets: dict[str, list[list[Any]]]) -> Path:
    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    for title, rows in sheets.items():
        sheet = workbook.create_sheet(title)
        for row in rows:
            sheet.append(row)
    workbook.save(path)
    return path


def test_xlsx_cells_are_displayed_strings(tmp_path: Path) -> None:
    source = _workbook(
        tmp_path / "source.xlsx",
        {
            "Budget": [
                ["item", "amount", "due", "paid", "at"],
                ["rent", 1200, date(2026, 1, 31), True, datetime(2026, 1, 2, 9, 30)],
                ["fee", 12.5, None, False, None],
                [],
                ["total", 1212.5],
            ],
            "Notes": [["only one cell"]],
        },
    )

    output, payload = _table(source, "xlsx")

    budget, notes = payload["sheets"]
    assert budget["name"] == "Budget"
    assert budget["rows"] == [
        ["item", "amount", "due", "paid", "at"],
        ["rent", "1200", "2026-01-31", "TRUE", "2026-01-02T09:30:00"],
        ["fee", "12.5", "", "FALSE"],
        [],
        ["total", "1212.5"],
    ]
    assert (budget["totalRows"], budget["totalColumns"], budget["truncated"]) == (5, 5, False)
    assert notes["rows"] == [["only one cell"]]
    assert output.truncated is False


def test_xlsx_bounds_rows_columns_cells_and_sheets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tables, "MAX_ROWS", 4)
    monkeypatch.setattr(tables, "MAX_COLUMNS", 3)
    monkeypatch.setattr(tables, "MAX_CELLS", 10)
    monkeypatch.setattr(tables, "MAX_SHEETS", 2)
    source = _workbook(
        tmp_path / "source.xlsx",
        {
            "Wide": [[f"r{r}c{c}" for c in range(6)] for r in range(8)],
            "Second": [["x"]],
            "Third": [["y"]],
        },
    )

    output, payload = _table(source, "xlsx")

    [wide] = payload["sheets"]  # the 10-cell budget ran out within the first sheet
    assert wide["rows"] == [[f"r{r}c{c}" for c in range(3)] for r in range(3)]
    assert wide["truncated"] is True
    assert (wide["totalRows"], wide["totalColumns"]) == (8, 6)
    assert output.truncated is True


def test_xlsx_sheet_count_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables, "MAX_SHEETS", 2)
    source = _workbook(tmp_path / "source.xlsx", {f"S{n}": [[n]] for n in range(4)})

    output, payload = _table(source, "xlsx")

    assert [sheet["name"] for sheet in payload["sheets"]] == ["S0", "S1"]
    assert output.truncated is True


def test_a_broken_workbook_is_unreadable(tmp_path: Path) -> None:
    source = tmp_path / "source.xlsx"
    source.write_bytes(b"PK\x03\x04 not a workbook")
    with pytest.raises(ConversionFailed) as failed:
        produce_table(source, "xlsx", name="x")
    assert failed.value.reason == UNREADABLE


# -- ARCHIVE ---------------------------------------------------------------------------


def _zip(path: Path, entries: dict[str, bytes], *, stub: bytes = b"") -> Path:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    path.write_bytes(stub + buffer.getvalue())
    return path


def test_archive_lists_the_central_directory(tmp_path: Path) -> None:
    source = _zip(
        tmp_path / "source.zip",
        {"docs/": b"", "docs/report.pdf": b"%PDF" * 100, "résumé.txt": b"hello"},
        stub=b"MZ self-extracting stub " * 10,
    )

    output = produce_archive(source)

    assert (output.mime_type, output.extension) == ("application/vnd.bomesh.archive+json", "archive.json")
    assert output.content_encoding == "gzip"
    assert _json(output.data) == {
        "schema": 1,
        "entries": [
            {"path": "docs/", "sizeBytes": 0, "directory": True},
            {"path": "docs/report.pdf", "sizeBytes": 400, "directory": False},
            {"path": "résumé.txt", "sizeBytes": 5, "directory": False},
        ],
        "totalEntries": 3,
        "truncated": False,
    }


def test_archive_entries_are_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(archives, "MAX_ENTRIES", 2)
    source = _zip(tmp_path / "source.zip", {f"f{n}.txt": b"x" for n in range(5)})

    output = produce_archive(source)

    payload = _json(output.data)
    assert [entry["path"] for entry in payload["entries"]] == ["f0.txt", "f1.txt"]
    assert (payload["totalEntries"], payload["truncated"], output.truncated) == (5, True, True)


def test_a_file_that_is_no_zip_is_unreadable(tmp_path: Path) -> None:
    source = tmp_path / "source.zip"
    source.write_bytes(b"not an archive at all")
    with pytest.raises(ConversionFailed) as failed:
        produce_archive(source)
    assert failed.value.reason == UNREADABLE


# -- IMAGE -----------------------------------------------------------------------------


def test_a_large_bmp_becomes_a_bounded_webp(tmp_path: Path) -> None:
    source = tmp_path / "source.bmp"
    Image.new("RGB", (5000, 1000), "#3366cc").save(source, "BMP")

    output = produce_image(source)

    assert (output.mime_type, output.extension) == ("image/webp", "webp")
    with Image.open(BytesIO(output.data)) as image:
        assert image.format == "WEBP"
        assert image.size == (MAX_SIDE, 819)


def test_a_tiff_keeps_its_alpha_and_is_never_enlarged(tmp_path: Path) -> None:
    source = tmp_path / "source.tiff"
    Image.new("RGBA", (300, 200), (255, 0, 0, 128)).save(source, "TIFF")

    with Image.open(BytesIO(produce_image(source).data)) as image:
        assert image.size == (300, 200)
        assert image.mode == "RGBA"


def test_an_undecodable_picture_is_unreadable(tmp_path: Path) -> None:
    source = tmp_path / "source.ico"
    source.write_bytes(b"\x00\x00\x01\x00garbage")
    with pytest.raises(ConversionFailed) as failed:
        produce_image(source)
    assert failed.value.reason == UNREADABLE


# -- HTML of e-mail and MHTML ----------------------------------------------------------


def test_an_email_becomes_one_escaped_page() -> None:
    message = EmailMessage()
    message["Subject"] = "Budget <Q3>"
    message["From"] = "Ana <ana@example.com>"
    message["To"] = "team@example.com"
    message["Date"] = "Mon, 16 Nov 2026 09:00:00 +0700"
    message.set_content(
        "<html><body><h1>Hello</h1><p>See the <b>numbers</b>.</p>"
        "<script>alert(1)</script><img src='https://tracker.example/x.png'></body></html>",
        subtype="html",
    )
    message.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="q3 <final>.pdf")

    html = email_html(message.as_bytes()).decode("utf-8")

    assert "<title>Budget &lt;Q3&gt;</title>" in html
    assert "Ana &lt;ana@example.com&gt;" in html
    assert "Hello" in html and "See the numbers." in html
    assert "<script" not in html and "alert(1)" not in html and "tracker.example" not in html
    assert "<li>q3 &lt;final&gt;.pdf</li>" in html


def test_an_mhtml_archive_gives_its_page() -> None:
    data = (
        b'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n'
        b"--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Saved page</p>\r\n--b--\r\n"
    )
    assert b"<p>Saved page</p>" in mhtml_html(data)
    with pytest.raises(ConversionFailed):
        mhtml_html(b"Content-Type: text/plain\r\n\r\nno page")
