"""The format registry: which representation a file becomes and how (``document_viewer.md``).

One table: a file's extension (else, when the extension is unknown, its MIME
type) names a :class:`Format`: the representation ``kind`` and either
:attr:`Producer.AS_IS` (the original is the representation) or the producer
that makes it. Adding a format is adding a row; nothing else in the engine
or the client knows file formats.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Literal

Kind = Literal["PDF", "IMAGE", "TABLE", "TEXT", "MEDIA", "ARCHIVE"]
TextFormat = Literal["MARKDOWN", "PLAIN"]
MediaType = Literal["VIDEO", "AUDIO"]


class Producer(StrEnum):
    """How a representation is obtained from the original."""

    #: The original is the representation.
    AS_IS = "as_is"
    #: Gotenberg LibreOffice → PDF.
    LIBREOFFICE = "libreoffice"
    #: Gotenberg Chromium → PDF (e-mail and MHTML become one HTML page first).
    CHROMIUM = "chromium"
    #: Pillow → WebP.
    PILLOW = "pillow"
    #: CSV reader / openpyxl → TABLE JSON.
    TABLE = "table"
    #: Charset detection → UTF-8 text.
    TEXT = "text"
    #: ZIP central directory → ARCHIVE JSON.
    ARCHIVE = "archive"


@dataclass(frozen=True, slots=True)
class Format:
    """One registry row: what a file is shown as."""

    #: The registry key (an extension without the dot, or a known file name).
    name: str
    kind: Kind
    producer: Producer
    #: The original's MIME type when it is the representation (AS_IS).
    mime_type: str | None = None
    text_format: TextFormat | None = None
    #: TEXT: a hint for monospaced code (``python``, ``json`` …).
    language: str | None = None
    media_type: MediaType | None = None
    #: A presentation: its PDF's first page is a ``SLIDE`` cover.
    slides: bool = False


def _rows(kind: Kind, producer: Producer, names: str, **fields: object) -> dict[str, Format]:
    return {
        name: Format(name=name, kind=kind, producer=producer, **fields)  # type: ignore[arg-type]
        for name in names.split()
    }


def _as_is(kind: Kind, types: dict[str, str], **fields: object) -> dict[str, Format]:
    return {
        name: Format(name=name, kind=kind, producer=Producer.AS_IS, mime_type=mime, **fields)  # type: ignore[arg-type]
        for name, mime in types.items()
    }


#: TEXT formats and their ``language`` hint (``None``: plain prose).
_TEXT_LANGUAGES: dict[str, str | None] = {
    "txt": None,
    "log": None,
    "json": "json",
    "jsonl": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "xml": "xml",
    "toml": "toml",
    "ini": "ini",
    "cfg": "ini",
    "conf": "ini",
    "env": "dotenv",
    "sql": "sql",
    "graphql": "graphql",
    "proto": "protobuf",
    "py": "python",
    "js": "javascript",
    "mjs": "javascript",
    "ts": "typescript",
    "tsx": "tsx",
    "jsx": "jsx",
    "java": "java",
    "kt": "kotlin",
    "go": "go",
    "rs": "rust",
    "c": "c",
    "h": "c",
    "cc": "cpp",
    "cpp": "cpp",
    "hpp": "cpp",
    "cs": "csharp",
    "rb": "ruby",
    "php": "php",
    "swift": "swift",
    "scala": "scala",
    "sh": "bash",
    "bash": "bash",
    "zsh": "bash",
    "ps1": "powershell",
    "bat": "batch",
    "r": "r",
    "lua": "lua",
    "pl": "perl",
    "dart": "dart",
    "vue": "vue",
    "svelte": "svelte",
    "css": "css",
    "scss": "scss",
    "less": "less",
    "dockerfile": "dockerfile",
    "makefile": "makefile",
}

FORMATS: dict[str, Format] = {
    **_as_is("PDF", {"pdf": "application/pdf"}),
    **_rows(
        "PDF",
        Producer.LIBREOFFICE,
        "doc docx docm dot dotx dotm odt ott rtf wpd xls ods ots vsd vsdx odg pub",
    ),
    **_rows(
        "PDF",
        Producer.LIBREOFFICE,
        "ppt pptx pptm pps ppsx pot potx odp otp",
        slides=True,
    ),
    **_rows("PDF", Producer.CHROMIUM, "html htm xhtml mht eml"),
    **_as_is(
        "IMAGE",
        {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "gif": "image/gif",
            "webp": "image/webp",
            "avif": "image/avif",
            "svg": "image/svg+xml",
        },
    ),
    **_rows("IMAGE", Producer.PILLOW, "bmp tif tiff ico"),
    **_rows("TABLE", Producer.TABLE, "csv tsv xlsx xlsm"),
    **_rows("TEXT", Producer.TEXT, "md markdown", text_format="MARKDOWN"),
    **{
        name: Format(
            name=name,
            kind="TEXT",
            producer=Producer.TEXT,
            text_format="PLAIN",
            language=language,
        )
        for name, language in _TEXT_LANGUAGES.items()
    },
    **_as_is(
        "MEDIA",
        {
            "mp4": "video/mp4",
            "m4v": "video/mp4",
            "webm": "video/webm",
            "ogv": "video/ogg",
        },
        media_type="VIDEO",
    ),
    **_as_is(
        "MEDIA",
        {
            "mp3": "audio/mpeg",
            "m4a": "audio/mp4",
            "aac": "audio/aac",
            "wav": "audio/wav",
            "oga": "audio/ogg",
            "ogg": "audio/ogg",
            "opus": "audio/ogg",
            "flac": "audio/flac",
        },
        media_type="AUDIO",
    ),
    **_rows("ARCHIVE", Producer.ARCHIVE, "zip"),
}

#: A MIME type → its registry row, for files whose extension is unknown.
_BY_MIME_TYPE: dict[str, str] = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-word.document.macroenabled.12": "docm",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template": "dotx",
    "application/vnd.ms-word.template.macroenabled.12": "dotm",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.text-template": "ott",
    "application/rtf": "rtf",
    "text/rtf": "rtf",
    "application/vnd.wordperfect": "wpd",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
    "application/vnd.openxmlformats-officedocument.presentationml.template": "potx",
    "application/vnd.oasis.opendocument.presentation": "odp",
    "application/vnd.oasis.opendocument.presentation-template": "otp",
    "application/vnd.ms-excel": "xls",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.spreadsheet-template": "ots",
    "application/vnd.visio": "vsd",
    "application/vnd.ms-visio.drawing": "vsdx",
    "application/vnd.oasis.opendocument.graphics": "odg",
    "application/vnd.ms-publisher": "pub",
    "application/x-mspublisher": "pub",
    "text/html": "html",
    "application/xhtml+xml": "xhtml",
    "application/x-mimearchive": "mht",
    "multipart/related": "mht",
    "message/rfc822": "eml",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/x-ms-bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
    "text/markdown": "md",
    "text/x-markdown": "md",
    "application/json": "json",
    "application/x-ndjson": "jsonl",
    "application/jsonl": "jsonl",
    "application/xml": "xml",
    "application/yaml": "yaml",
    "application/x-yaml": "yaml",
    "application/toml": "toml",
    "application/sql": "sql",
    "application/graphql": "graphql",
    "application/javascript": "js",
    "application/x-sh": "sh",
    "video/mp4": "mp4",
    "video/x-m4v": "m4v",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
}


def format_key(file_name: str) -> str:
    """The registry key of a file name: its extension, else its whole name.

    ``report.PDF`` → ``pdf``; ``Dockerfile`` → ``dockerfile``; ``.env`` → ``env``.
    """
    path = PurePosixPath(file_name.strip().replace("\\", "/"))
    suffix = path.suffix.casefold()
    return suffix[1:] if suffix else path.name.casefold().lstrip(".")


def classify(file_name: str, content_type: str | None) -> Format | None:
    """The registry row of a file: by extension, then by MIME type; ``None`` when unsupported.

    Any ``text/*`` type without a row of its own (``text/html`` has one) is
    plain TEXT.
    """
    row = FORMATS.get(format_key(file_name))
    if row is not None:
        return row
    mime = (content_type or "").split(";", 1)[0].strip().casefold()
    name = _BY_MIME_TYPE.get(mime)
    if name is not None:
        return FORMATS[name]
    if mime.startswith("text/"):
        return FORMATS["txt"]
    return None


__all__ = ["FORMATS", "Format", "Kind", "MediaType", "Producer", "TextFormat", "classify", "format_key"]
