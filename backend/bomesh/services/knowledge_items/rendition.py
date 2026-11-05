"""Whole-document rendition serialized from one canonical DocumentItem.

The rendition is the parse the index already cites: one block per content
part, keyed by the part's ``element_id``. See
``docs_design/document_viewer.md`` for the contract.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from bomesh.connector.protocol import (
    AnyContentPart,
    CitationInfo,
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



def viewer_elements(
    item_id: str,
    payloads: list[dict[str, Any]],
    citations: Mapping[str, CitationInfo],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Group indexed chunks into unambiguous viewer elements."""

    groups: dict[str, dict[str, Any] | None] = {}
    chunks_by_id: dict[str, dict[str, Any]] = {}
    for payload in payloads:
        chunk_index = int(payload.get("chunk_index") or 0)
        chunk_id = str(payload.get("chunk_id") or f"{item_id}:{chunk_index}")
        chunks_by_id[chunk_id] = payload
        chunks_by_id[f"{item_id}:{chunk_index}"] = payload
        _add_citation_content(
            groups,
            str(payload.get("chunk_text") or ""),
            citations.get(chunk_id, payload_citation(payload)),
        )
    return [value for value in groups.values() if value is not None], chunks_by_id


def payload_citation(payload: Mapping[str, Any]) -> CitationInfo:
    """Rebuild a citation from an indexed chunk payload."""

    raw_section_path = payload.get("section_path")
    section_path = tuple(
        value.strip()
        for value in raw_section_path or ()
        if isinstance(value, str) and value.strip()
    )
    return CitationInfo(
        section=section_path[-1] if section_path else None,
        section_path=section_path,
        anchor=_payload_text(payload, "citation_anchor"),
        page_start=_payload_int(payload, "page_start"),
        page_end=_payload_int(payload, "page_end"),
    )


def _add_citation_content(
    groups: dict[str, dict[str, Any] | None],
    content: str,
    citation: CitationInfo,
) -> None:
    if not content or len(citation.spans) != 1:
        return
    span = citation.spans[0]
    if (
        span.element_id is None
        or span.start_offset != 0
        or span.end_offset != len(content)
    ):
        return
    candidate = {
        "element_id": span.element_id,
        "text": content,
        "page": span.page,
        "section": citation.section,
        "section_path": list(citation.section_path),
        "anchor": citation.anchor,
        "bounding_box": span.bounding_box,
    }
    if span.element_id not in groups:
        groups[span.element_id] = candidate
    elif groups[span.element_id] != candidate:
        groups[span.element_id] = None


def _payload_text(metadata: Mapping[str, Any], key: str) -> str | None:
    value = metadata.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _payload_int(payload: Mapping[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return None


__all__ = [
    "MAX_BLOCKS",
    "MAX_CELLS",
    "MAX_TABLE_ROWS",
    "MAX_UNCOMPRESSED_BYTES",
    "DocumentRendition",
    "build_document_rendition",
    "payload_citation",
    "viewer_elements",
]
