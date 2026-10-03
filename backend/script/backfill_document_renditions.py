#!/usr/bin/env python3
"""Write whole-document renditions for knowledge documents indexed before them.

Each selected document's stored original is re-parsed with the same file
connector ingestion uses (no embeddings, no model calls), its rendition is
stored beside the page previews, and the preview manifest is merged into
``Item.metadata.preview``. Documents whose rendition is current are skipped,
so the run is idempotent. See ``docs_design/document_viewer.md``.

    PYTHONPATH=. uv run python script/backfill_document_renditions.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import tempfile
from pathlib import Path
from typing import Any
from uuid import UUID

from dotenv import load_dotenv
from sqlalchemy import select

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

load_dotenv(BACKEND_ROOT.parent / ".env", override=False)

from config import get_config
from bothesis.db.engine import transaction_scope
from bothesis.db.models import Item
from bothesis.runtime import AppRuntime
from bothesis.services.item import ItemService
from bothesis.services.preview import KnowledgePreview
from bothesis.services.stored_file_content import StoredFileContentService


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill document renditions for indexed knowledge documents."
    )
    parser.add_argument(
        "--collection-id",
        type=UUID,
        help="Only documents directly inside this Collection",
    )
    parser.add_argument("--limit", type=int, help="At most this many documents")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Documents processed at once (default: %(default)s)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be done without parsing or writing anything",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild renditions even when the stored one is current",
    )
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error("--concurrency must be at least 1")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    return args


async def _documents(
    runtime: AppRuntime, *, collection_id: UUID | None, limit: int | None
) -> list[Item]:
    statement = (
        select(Item)
        .where(
            Item.item_type == "document",
            Item.deleted_at.is_(None),
            Item.status != "deleted",
            Item.storage_key.is_not(None),
            Item.index_status == "ready",
        )
        .order_by(Item.created_at, Item.id)
    )
    if collection_id is not None:
        statement = statement.where(Item.parent_item_id == collection_id)
    if limit is not None:
        statement = statement.limit(limit)
    async with transaction_scope(runtime.sessions()) as session:
        return list((await session.scalars(statement)).all())


def _without_rendition(item: Item) -> None:
    """Drop the stored rendition from the detached Item so it is rebuilt."""

    preview = item.metadata_.get("preview")
    if isinstance(preview, dict) and preview.get("rendition") is not None:
        item.metadata_ = {
            **dict(item.metadata_),
            "preview": {**preview, "rendition": None},
        }


async def _backfill_one(
    runtime: AppRuntime,
    item: Item,
    *,
    preview: KnowledgePreview,
    content: StoredFileContentService,
    max_bytes: int,
    dry_run: bool,
    force: bool,
) -> tuple[str, str]:
    """Return the summary bucket and the line printed for one document."""

    if not force and await preview.has_current_rendition(item):
        return "skipped", "skipped (current)"
    if dry_run:
        return "done", "would build"
    if force:
        _without_rendition(item)
    assert item.storage_key is not None
    suffix = Path(str(item.metadata_.get("file_name") or item.title or "")).suffix
    with tempfile.TemporaryDirectory(prefix="bothesis-rendition-") as directory:
        path = Path(directory) / f"source{suffix}"
        await runtime.object_storage().download_to_path(
            item.storage_key, path, max_bytes=max_bytes
        )
        # Access is irrelevant here: only the parsed content is kept.
        processed = await content.process_path(
            item, path, user_id=item.created_by_user_id or item.id
        )
        manifest = await preview.generate(
            item, source_path=path, content=processed.item
        )
    if manifest is None or manifest.rendition is None:
        raise RuntimeError("no rendition was produced")
    async with transaction_scope(runtime.sessions()) as session:
        await ItemService(session).merge_metadata(
            item.id, {"preview": manifest.model_dump(mode="json")}
        )
    rendition = manifest.rendition
    flag = ", truncated" if rendition.truncated else ""
    return "done", (
        f"done ({rendition.block_count} blocks, {rendition.size_bytes} bytes{flag})"
    )


async def _main() -> int:
    args = _parse_args()
    runtime = AppRuntime(get_config())
    preview = runtime.knowledge_preview()
    content = runtime.stored_file_content()
    max_bytes = runtime.config.upload.processing_max_bytes
    counts = {"done": 0, "skipped": 0, "failed": 0}
    try:
        items = await _documents(
            runtime, collection_id=args.collection_id, limit=args.limit
        )
        semaphore = asyncio.Semaphore(args.concurrency)

        async def run(item: Item) -> None:
            async with semaphore:
                try:
                    bucket, outcome = await _backfill_one(
                        runtime,
                        item,
                        preview=preview,
                        content=content,
                        max_bytes=max_bytes,
                        dry_run=args.dry_run,
                        force=args.force,
                    )
                except Exception as exc:  # noqa: BLE001 - one failure never stops the run
                    bucket, outcome = "failed", f"failed ({type(exc).__name__}: {exc})"
                counts[bucket] += 1
                print(f"{item.id} {item.title!r}: {outcome}", flush=True)

        await asyncio.gather(*(run(item) for item in items))
    finally:
        await runtime.aclose()
    label = "would build" if args.dry_run else "done"
    print(
        f"{len(items)} document(s): {counts['done']} {label}, "
        f"{counts['skipped']} skipped, {counts['failed']} failed"
    )
    return 0 if counts["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
