"""The stored form of a Structured Document: deterministic gzip JSON.

Identical documents encode to identical bytes (no gzip timestamp, stable key
order from pydantic), so concurrent or repeated writes of one key are
harmless.
"""

from __future__ import annotations

import gzip
import json
from typing import Any

from docling_core.types.doc import DoclingDocument

MEDIA_TYPE = "application/vnd.docling.document+json"
_GZIP_LEVEL = 6


class StructureDecodeError(ValueError):
    """A stored Structured Document that cannot be read (corrupt or of an unknown schema)."""


def encode(document: DoclingDocument) -> bytes:
    raw = document.model_dump_json(exclude_none=True).encode("utf-8")
    return gzip.compress(raw, compresslevel=_GZIP_LEVEL, mtime=0)


def decode_json(data: bytes) -> dict[str, Any]:
    """The raw JSON (for :class:`~bomesh.document_structure.view.StructureView`)."""

    try:
        value = json.loads(gzip.decompress(data))
    except (OSError, EOFError, ValueError) as exc:
        raise StructureDecodeError("the stored Structured Document is unreadable") from exc
    if not isinstance(value, dict):
        raise StructureDecodeError("the stored Structured Document is not an object")
    return value


def decode_document(data: bytes) -> DoclingDocument:
    """A validated ``DoclingDocument`` (for chunking and Docling's serializers)."""

    try:
        return DoclingDocument.model_validate_json(gzip.decompress(data))
    except (OSError, EOFError, ValueError) as exc:
        raise StructureDecodeError("the stored Structured Document is unreadable") from exc


__all__ = ["MEDIA_TYPE", "StructureDecodeError", "decode_document", "decode_json", "encode"]
