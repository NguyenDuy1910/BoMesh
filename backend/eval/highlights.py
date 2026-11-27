"""Citation highlights: does every chunk mark, in the Original preview, the text it holds?

For each indexed chunk of a document, the regions it carries (``Chunk.highlights``)
are read back from the representation people see — the text inside each box
of the PDF (pdfium), or the cells of each sheet range (the TABLE payload) — and
compared with the chunk: the share of the chunk's value words found there.
A table chunk's words are its values (``column = value`` statements keep the
value), since column names sit in the header, outside the cited rows.

Per document and per file type: how many chunks have boxes or ranges, only a
page, or nothing, and how well the marked regions hold the chunk's words.
"""

from __future__ import annotations

import gzip
import json
import re
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import select

from bomesh.connector.processing.highlights import PdfTextLayer, fold
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_structure import CELL_RANGE_PATTERN
from bomesh.runtime import AppRuntime
from bomesh.services.previews.engine import PreviewEngine
from bomesh.services.previews.manifest import representation_key, stored_representation
from eval.metrics import mean
from eval.report import markdown_table

#: A chunk is well marked when its marked regions hold this share of its words.
WELL_MARKED = 0.8
_MAX_REPRESENTATION_BYTES = 256 * 1024 * 1024
_WORD = re.compile(r"\w+")


async def check_document(runtime: AppRuntime, *, tenant_id: str, item_id: str) -> dict[str, Any]:
    """How the chunks of one document are marked, and how well."""

    chunks = await runtime.item_index().get_item_content(item_id, tenant_id=tenant_id, limit=10_000)
    async with transaction_scope(runtime.sessions()) as session:
        row = (
            await session.execute(
                select(Item, ItemRevision)
                .join(ItemRevision, ItemRevision.id == Item.current_revision_id)
                .where(Item.id == UUID(item_id))
            )
        ).first()
    if row is None:
        return {}
    item, revision = row
    representation = stored_representation(revision.exports)
    kind = representation.kind if representation is not None else None
    counts = {"chunks": len(chunks), "marked": 0, "page_only": 0, "unmarked": 0, "scanned": 0}
    coverage: list[float] = []
    storage = runtime.object_storage()
    with tempfile.TemporaryDirectory(prefix="bomesh-eval-highlights-") as directory:
        layer: PdfTextLayer | None = None
        sheets: dict[str, list[list[str]]] = {}
        pdf_key = PreviewEngine.stored_pdf_key(item, revision)
        if kind == "PDF" and pdf_key is not None:
            path = Path(directory) / "shown.pdf"
            await storage.download_to_path(pdf_key, path, max_bytes=_MAX_REPRESENTATION_BYTES)
            layer = PdfTextLayer(path)
        elif kind == "TABLE":
            data = await storage.read(
                representation_key(item.workspace_code, revision.content_id), max_bytes=_MAX_REPRESENTATION_BYTES
            )
            payload = json.loads(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
            sheets = {sheet["name"]: sheet["rows"] for sheet in payload["sheets"]}
        # Pages without a text layer (scans) cannot be read back: their marks are counted, not measured.
        typed = {page_index + 1 for page_index, _ in layer.stream.at} if layer is not None else set()
    for chunk in chunks:
        regions = [h for h in chunk.highlights if h.boxes or h.range]
        if regions:
            counts["marked"] += 1
        elif chunk.highlights:
            counts["page_only"] += 1
            continue
        else:
            counts["unmarked"] += 1
            continue
        if layer is not None and not any(h.page in typed for h in regions):
            counts["scanned"] += 1
            continue
        marked = "".join(_region_text(layer, sheets, highlight) for highlight in regions)
        words = _value_words(chunk.chunk_text)
        if words:
            coverage.append(sum(word in marked for word in words) / len(words))
    return {
        "representation": kind,
        **counts,
        "mean_coverage": mean(coverage),
        "well_marked": sum(value >= WELL_MARKED for value in coverage),
        "measured": len(coverage),
    }


async def check_collection(runtime: AppRuntime, *, collection_id: str) -> list[dict[str, Any]]:
    """:func:`check_document` for every live document directly in a Collection, in name order."""

    async with transaction_scope(runtime.sessions()) as session:
        documents = (
            await session.execute(
                select(Item.id, Item.tenant_id, Item.item_name)
                .where(
                    Item.parent_item_id == UUID(collection_id),
                    Item.item_kind == "document",
                    Item.deleted_at.is_(None),
                )
                .order_by(Item.item_name)
            )
        ).all()
    return [
        {
            "file": document.item_name,
            "extension": Path(document.item_name).suffix.casefold() or "(none)",
            "item": str(document.id),
            "highlights": await check_document(
                runtime, tenant_id=str(document.tenant_id), item_id=str(document.id)
            ),
        }
        for document in documents
    ]


def summarize_highlights(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per file type (and ``all``): chunk counts, and the share well marked."""

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        stats = row.get("highlights")
        if stats:
            groups[row["extension"]].append(stats)
            groups["all"].append(stats)
    output: dict[str, dict[str, Any]] = {}
    for extension, group in groups.items():
        chunks = sum(stats["chunks"] for stats in group)
        measured = sum(stats["measured"] for stats in group)
        output[extension] = {
            "documents": len(group),
            "chunks": chunks,
            "marked": sum(stats["marked"] for stats in group) / chunks if chunks else None,
            "page_only": sum(stats["page_only"] for stats in group) / chunks if chunks else None,
            "unmarked": sum(stats["unmarked"] for stats in group) / chunks if chunks else None,
            "scanned": sum(stats["scanned"] for stats in group),
            "well_marked": sum(stats["well_marked"] for stats in group) / measured if measured else None,
            "mean_coverage": mean(
                stats["mean_coverage"] for stats in group if stats["mean_coverage"] is not None
            ),
        }
    return output


def render_highlights_markdown(summary: dict[str, dict[str, Any]]) -> list[str]:
    def share(value: Any) -> str:
        return "—" if value is None else f"{100 * value:.1f}%"

    lines = [
        "## Citation highlights", "",
        (
            "Chunks marked in the Original preview (boxes or cell ranges), marked by page only, or not "
            f"marked; and, of the marked ones read back, the share whose regions hold at least "
            f"{WELL_MARKED:.0%} of the chunk's value words. Marks on scanned pages (no text layer to "
            "read back) are counted apart."
        ),
        "",
    ]
    lines += markdown_table(
        ["Type", "Documents", "Chunks", "Marked", "Page only", "Unmarked", "On scans", "Well marked",
         "Mean coverage"],
        [[extension, str(v["documents"]), str(v["chunks"]), share(v["marked"]), share(v["page_only"]),
          share(v["unmarked"]), str(v["scanned"]), share(v["well_marked"]), share(v["mean_coverage"])]
         for extension, v in sorted(summary.items(), key=lambda kv: (kv[0] == "all", kv[0]))],
    )
    return lines


def _value_words(text: str) -> list[str]:
    """The chunk's words as the file shows them: a ``column = value`` statement keeps its value."""

    values: list[str] = []
    for line in text.splitlines():
        for statement in line.split("; "):
            values.append(statement.split(" = ", 1)[1] if " = " in statement else statement)
    return [word for word in (fold(token) for token in _WORD.findall(" ".join(values))) if len(word) >= 2]


def _region_text(layer: PdfTextLayer | None, sheets: dict[str, list[list[str]]], highlight: Any) -> str:
    if highlight.page is not None and layer is not None:
        return "".join(layer.region(highlight.page, box).joined for box in highlight.boxes)
    if highlight.range is None or highlight.sheet not in sheets:
        return ""
    match = CELL_RANGE_PATTERN.match(highlight.range)
    if match is None:
        return ""
    first_column, first_row = _column_index(match.group(1)), int(match.group(2))
    last_column = _column_index(match.group(3) or match.group(1))
    last_row = int(match.group(4) or match.group(2))
    rows = sheets[highlight.sheet][first_row - 1 : last_row]
    return fold(" ".join(" ".join(row[first_column - 1 : last_column]) for row in rows))


def _column_index(letters: str) -> int:
    index = 0
    for letter in letters:
        index = index * 26 + ord(letter) - ord("A") + 1
    return index


__all__ = [
    "WELL_MARKED",
    "check_collection",
    "check_document",
    "render_highlights_markdown",
    "summarize_highlights",
]
