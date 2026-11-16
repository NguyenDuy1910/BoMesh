"""The format registry is the table of ``document_viewer.md`` "Format registry", row for row."""

from __future__ import annotations

import pytest

from bomesh.services.previews.formats import FORMATS, Producer, classify, format_key

_OFFICE = "doc docx docm dot dotx dotm odt ott rtf wpd ppt pptx pptm pps ppsx pot potx odp otp xls ods ots vsd vsdx odg pub"
_SLIDES = set("ppt pptx pptm pps ppsx pot potx odp otp".split())
_CODE = (
    "py js mjs ts tsx jsx java kt go rs c h cc cpp hpp cs rb php swift scala sh bash zsh "
    "ps1 bat r lua pl dart vue svelte css scss less dockerfile makefile"
)
_PLAIN = "txt log json jsonl yaml yml xml toml ini cfg conf env sql graphql proto"

#: (representation, names, producer, text format, media type) — the design's table.
TABLE: list[tuple[str, str, Producer, str | None, str | None]] = [
    ("PDF", "pdf", Producer.AS_IS, None, None),
    ("PDF", _OFFICE, Producer.LIBREOFFICE, None, None),
    ("PDF", "html htm xhtml mht eml", Producer.CHROMIUM, None, None),
    ("IMAGE", "png jpg jpeg gif webp avif svg", Producer.AS_IS, None, None),
    ("IMAGE", "bmp tif tiff ico", Producer.PILLOW, None, None),
    ("TABLE", "csv tsv xlsx xlsm", Producer.TABLE, None, None),
    ("TEXT", "md markdown", Producer.TEXT, "MARKDOWN", None),
    ("TEXT", f"{_PLAIN} {_CODE}", Producer.TEXT, "PLAIN", None),
    ("MEDIA", "mp4 m4v webm ogv", Producer.AS_IS, None, "VIDEO"),
    ("MEDIA", "mp3 m4a aac wav oga ogg opus flac", Producer.AS_IS, None, "AUDIO"),
    ("ARCHIVE", "zip", Producer.ARCHIVE, None, None),
]
ROWS = [
    (name, kind, producer, text_format, media_type)
    for kind, names, producer, text_format, media_type in TABLE
    for name in names.split()
]


def test_the_registry_has_exactly_the_designed_rows() -> None:
    assert sorted(FORMATS) == sorted(name for name, *_ in ROWS)


@pytest.mark.parametrize(("name", "kind", "producer", "text_format", "media_type"), ROWS)
def test_each_extension_maps_to_its_representation(
    name: str, kind: str, producer: Producer, text_format: str | None, media_type: str | None
) -> None:
    file_name = name.capitalize() if name in ("dockerfile", "makefile") else f"Report.{name.upper()}"
    row = classify(file_name, "application/octet-stream")
    assert row is not None
    assert (row.kind, row.producer, row.text_format, row.media_type) == (
        kind,
        producer,
        text_format,
        media_type,
    )
    assert row.slides == (name in _SLIDES)
    if producer is Producer.AS_IS:
        assert row.mime_type  # the representation's MIME type is the registry's


@pytest.mark.parametrize(
    ("mime_type", "name"),
    [
        ("application/pdf", "pdf"),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
        ("application/vnd.ms-excel", "xls"),
        ("text/html; charset=utf-8", "html"),
        ("message/rfc822", "eml"),
        ("image/tiff", "tiff"),
        ("text/csv", "csv"),
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
        ("text/markdown", "md"),
        ("application/json", "json"),
        ("video/mp4", "mp4"),
        ("audio/mpeg", "mp3"),
        ("application/zip", "zip"),
    ],
)
def test_an_unknown_extension_falls_back_to_the_mime_type(mime_type: str, name: str) -> None:
    assert classify("upload", mime_type) is FORMATS[name]


def test_the_extension_wins_over_the_mime_type() -> None:
    assert classify("notes.md", "application/octet-stream") is FORMATS["md"]
    assert classify("data.csv", "text/plain") is FORMATS["csv"]


def test_any_other_text_type_is_plain_text_but_html_is_a_page() -> None:
    plain = classify("README", "text/x-rst")
    assert plain is not None and (plain.kind, plain.text_format) == ("TEXT", "PLAIN")
    page = classify("index", "text/html")
    assert page is not None and (page.kind, page.producer) == ("PDF", Producer.CHROMIUM)


def test_unsupported_files_have_no_row() -> None:
    assert classify("archive.7z", "application/x-7z-compressed") is None
    assert classify("data.bin", "application/octet-stream") is None
    assert classify("noext", None) is None


def test_format_keys_of_special_names() -> None:
    assert format_key("Dockerfile") == "dockerfile"
    assert format_key("service.dockerfile") == "dockerfile"
    assert format_key(".env") == "env"
    assert format_key("dir\\Report.PDF") == "pdf"
