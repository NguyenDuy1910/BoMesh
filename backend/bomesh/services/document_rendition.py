"""Whole-document rendition serialized from one canonical DocumentItem.

The rendition is the parse the index already cites: one block per content
part, keyed by the part's ``element_id``. See
``docs_design/document_viewer.md`` for the contract.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from typing import Any

from bomesh.connector.protocol import (
    AnyContentPart,
    CodePart,
    DocumentItem,
    ImagePart,
    LinkPart,
    StructuredPart,
    TablePart,
    TextPart,
)

RENDITION_SCHEMA = 1
MAX_BLOCKS = 20_000
MAX_TABLE_ROWS = 20_000
MAX_CELLS = 1_000_000
MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
_MAX_HEADING_LEVEL = 4


@dataclass(frozen=True, slots=True)
class DocumentRendition:
    """Gzip-compressed rendition JSON plus the facts the manifest records."""

    data: bytes
    block_count: int
    truncated: bool


def build_document_rendition(item: DocumentItem) -> DocumentRendition:
    """Serialize ``item.content`` into bounded, deterministic rendition bytes."""

    encoded: list[bytes] = []
    truncated = False
    cells = 0
    # Envelope bytes plus one separator per block are counted with the blocks.
    size = len(_envelope(truncated=True, blocks=b""))
    for index, part in enumerate(item.content):
        if len(encoded) >= MAX_BLOCKS:
            truncated = True
            break
        block = _block(part, index)
        if block is None:
            continue
        stop = False
        if isinstance(part, TablePart):
            rows, cells, rows_truncated, stop = _bounded_rows(
                part.rows, columns=len(block["columns"]), cells=cells
            )
            block["rows"] = rows
            truncated = truncated or rows_truncated
        data = json.dumps(block, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        size += len(data) + (1 if encoded else 0)
        if size > MAX_UNCOMPRESSED_BYTES:
            truncated = True
            break
        encoded.append(data)
        if stop:
            truncated = True
            break
    raw = _envelope(truncated=truncated, blocks=b",".join(encoded))
    return DocumentRendition(
        data=gzip.compress(raw, compresslevel=6, mtime=0),
        block_count=len(encoded),
        truncated=truncated,
    )


def _envelope(*, truncated: bool, blocks: bytes) -> bytes:
    # Equivalent to json.dumps({"schema", "truncated", "blocks"}) with compact
    # separators, without serializing each block a second time.
    flag = b"true" if truncated else b"false"
    return (
        b'{"schema":' + str(RENDITION_SCHEMA).encode("ascii")
        + b',"truncated":' + flag
        + b',"blocks":[' + blocks + b"]}"
    )


def _bounded_rows(
    rows: list[list[str]], *, columns: int, cells: int
) -> tuple[list[list[str]], int, bool, bool]:
    """Return the rows within bounds, the new cell total, whether this table
    was cut, and whether the document cell budget is now exhausted."""

    cells += columns
    kept: list[list[str]] = []
    for row in rows:
        if len(kept) >= MAX_TABLE_ROWS:
            return kept, cells, True, False
        if cells + len(row) > MAX_CELLS:
            return kept, cells, True, True
        cells += len(row)
        kept.append(row)
    return kept, cells, False, cells >= MAX_CELLS


def _block(part: AnyContentPart, index: int) -> dict[str, Any] | None:
    block_id = part.element_id or f"block_{index}"
    if isinstance(part, TextPart):
        text = part.text.strip()
        if not text:
            return None
        if _element_kind(part.element_id) == "heading":
            level = min(max(len(part.section_path), 1), _MAX_HEADING_LEVEL)
            return {
                "id": block_id,
                "kind": "heading",
                "level": level,
                "text": text,
                "page": part.page,
            }
        if part.link:
            return {
                "id": block_id,
                "kind": "link",
                "text": text,
                "url": part.link,
                "page": part.page,
            }
        return {"id": block_id, "kind": "paragraph", "text": text, "page": part.page}
    if isinstance(part, TablePart):
        return {
            "id": block_id,
            "kind": "table",
            "caption": part.caption,
            "columns": part.columns,
            "rows": part.rows,
            "total_rows": len(part.rows),
            "page": part.page,
        }
    if isinstance(part, CodePart):
        if not part.code.strip():
            return None
        return {
            "id": block_id,
            "kind": "code",
            "text": part.code,
            "language": part.language,
            "page": part.page,
        }
    if isinstance(part, ImagePart):
        values = (part.alt_text, part.ocr_text, part.description)
        text = "\n".join(
            value.strip() for value in dict.fromkeys(values) if value and value.strip()
        )
        if not text:
            return None
        return {"id": block_id, "kind": "image", "text": text, "page": part.page}
    if isinstance(part, LinkPart):
        return {
            "id": block_id,
            "kind": "link",
            "text": part.title or part.url,
            "url": part.url,
            "page": part.page,
        }
    if isinstance(part, StructuredPart):
        if not part.data:
            return None
        text = json.dumps(
            part.data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        return {"id": block_id, "kind": "paragraph", "text": text, "page": part.page}
    return None


def _element_kind(element_id: str | None) -> str | None:
    """Kind segment of ``{p001|doc}_{kind}_{seq}`` element ids."""

    if element_id is None:
        return None
    segments = element_id.split("_")
    return segments[1] if len(segments) == 3 else None


__all__ = [
    "MAX_BLOCKS",
    "MAX_CELLS",
    "MAX_TABLE_ROWS",
    "MAX_UNCOMPRESSED_BYTES",
    "DocumentRendition",
    "build_document_rendition",
]
