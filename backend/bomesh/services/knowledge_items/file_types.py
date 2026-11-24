"""A Document's file class (``items.item_type``): one rule for the services and the database.

The class is derived from content, never chosen: the format registry
(:mod:`bomesh.services.previews.formats`) names it by the file's extension,
else its MIME type; a file the registry does not know is ``image``, ``audio``
or ``video`` by its MIME family, else ``other``. :func:`file_class` applies the
rule in Python; :func:`file_class_function_sql` generates the same rule as the
SQL function ``bomesh_file_class`` that the revision and upload triggers use,
so the two can never disagree.
"""

from __future__ import annotations

import json

from bomesh.connector.file import FinxFileExtensions
from bomesh.services.previews.formats import (
    BY_MIME_TYPE,
    FORMATS,
    FileClass,
    Producer,
    classify,
    normalized_mime_type,
)

#: MIME families whose unknown members still have a class of their own.
_MEDIA_FAMILIES: dict[str, FileClass] = {"image": "image", "audio": "audio", "video": "video"}
#: The error code / reason of content whose file class is not the Document's.
ITEM_TYPE_MISMATCH = "ITEM_TYPE_MISMATCH"


class ItemTypeMismatchError(ValueError):
    """Content of another file class than the Document's ``item_type``.

    The engine raises it; each method maps it to its contract (a failed
    upload, FAILED_PRECONDITION, INVALID_ARGUMENT or a sync failure), always
    with reason :data:`ITEM_TYPE_MISMATCH`.
    """

    def __init__(self, item_type: str, content_type: str) -> None:
        super().__init__(
            f"the content is {content_type.upper()}, the document is {item_type.upper()}"
        )
        self.item_type = item_type
        self.content_type = content_type


def file_class(mime_type: str | None, file_name: str) -> FileClass:
    """The file class of content named ``file_name`` with MIME type ``mime_type``."""
    row = classify(file_name, mime_type)
    if row is not None:
        return row.file_class
    family = normalized_mime_type(mime_type).split("/", 1)[0]
    return _MEDIA_FAMILIES.get(family, "other")


def require_file_class(item_type: str, mime_type: str | None, file_name: str) -> None:
    """Raise :class:`ItemTypeMismatchError` unless the content maps to ``item_type``."""
    content_type = file_class(mime_type, file_name)
    if content_type != item_type:
        raise ItemTypeMismatchError(item_type, content_type)


def processed_as_pdf(file_name: str, mime_type: str | None = None) -> bool:
    """Whether processing parses the file's PDF representation instead of the file.

    Legacy binary and OpenDocument office formats (``.doc``, ``.xls``, ``.ppt``,
    ``.odt``, ``.rtf`` …) have no parser of their own. The preview engine already
    converts them to PDF with Gotenberg LibreOffice, and processing reads that PDF
    (``document_contract.md`` "Formats").
    """
    row = classify(file_name, mime_type)
    return (
        row is not None
        and row.producer is Producer.LIBREOFFICE
        and f".{row.name}" not in FinxFileExtensions.KNOWLEDGE_EXTENSIONS
    )


def file_class_function_sql() -> str:
    """``CREATE FUNCTION bomesh_file_class(mime_type, file_name)``: :func:`file_class` in SQL.

    The registry key is the lower-cased basename's last suffix (a leading dot
    alone is no suffix), else the basename without leading dots, exactly as
    :func:`~bomesh.services.previews.formats.format_key`.
    """
    by_extension = {name: row.file_class for name, row in FORMATS.items()}
    by_mime = {mime: FORMATS[name].file_class for mime, name in BY_MIME_TYPE.items()}
    # Every unknown text/* is plain text (``classify``), then the media families.
    families = {"text": "plain_text", **_MEDIA_FAMILIES}
    literals = [json.dumps(table, sort_keys=True) for table in (by_extension, by_mime)]
    # DDL is %-formatted and the literals are single-quoted.
    assert not any("'" in literal or "%" in literal for literal in literals)
    family_arms = " ".join(f"WHEN '{family}' THEN '{cls}'" for family, cls in families.items())
    return f"""
    CREATE OR REPLACE FUNCTION bomesh_file_class(p_mime_type text, p_file_name text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      WITH normalized AS (
        SELECT
          lower(regexp_replace(
            regexp_replace(
              regexp_replace(replace(p_file_name, chr(92), '/'), '^\\s+|\\s+$', '', 'g'),
              '/+$', ''
            ),
            '^.*/', ''
          )) AS name,
          lower(btrim(split_part(coalesce(p_mime_type, ''), ';', 1))) AS mime
      )
      SELECT coalesce(
        '{literals[0]}'::jsonb
          ->> coalesce(substring(name from '^.+\\.([^.]+)$'), ltrim(name, '.')),
        '{literals[1]}'::jsonb ->> mime,
        CASE split_part(mime, '/', 1) {family_arms} ELSE 'other' END
      )
      FROM normalized
    $$
    """


__all__ = [
    "ITEM_TYPE_MISMATCH",
    "ItemTypeMismatchError",
    "file_class",
    "file_class_function_sql",
    "require_file_class",
]
