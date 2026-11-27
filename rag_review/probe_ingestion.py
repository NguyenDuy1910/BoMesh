"""Offline ingestion probe: how a Vietnamese regulation is chunked and indexed.

Run (no API keys, no database):
    cd backend && PYTHONPATH=. uv run python ../rag_review/probe_ingestion.py

Prints, for the same regulation as Markdown (with headings) and as plain text
(the shape a PDF text layer produces: "Điều n." lines, no heading markup):
chunk count, each chunk's section_path, whether the article number travels
with the chunk, and the fields of the Qdrant payload actually written.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from bomesh.connector.file.processing import FileProcessor  # noqa: E402
from bomesh.connector.protocol import SourceIdentity, SourceProvider  # noqa: E402
from bomesh.document_index import build_contextual_chunks  # noqa: E402
from bomesh.document_index.payload import (  # noqa: E402
    IndexingContext,
    _IndexedChunk,
    build_index_records,
)

CLAUSE = (
    "Người lao động được hưởng phụ cấp theo mức quy định tại Phụ lục kèm theo "
    "và được chi trả cùng kỳ lương hằng tháng; trường hợp nghỉ không lương quá "
    "mười bốn ngày làm việc trong tháng thì không được hưởng phụ cấp của tháng đó. "
)


def regulation(markdown: bool) -> str:
    head = "## " if markdown else ""
    lines = [
        f"{head}QUY CHẾ CHI TIÊU NỘI BỘ 2026",
        "Có hiệu lực từ ngày 01/07/2026, thay thế Quy chế ban hành ngày 15/01/2024.",
        "",
    ]
    for article in (11, 12, 13):
        lines.append(f"{head}Điều {article}. Phụ cấp nhóm {article}")
        for clause in range(1, 5):
            lines.append(f"{clause}. {CLAUSE * 2}")
        lines.append("")
    lines += [
        f"{head}Bảng mức phụ cấp",
        "| Hạng | Mức cũ (2024) | Mức mới (2026) |",
        "|---|---|---|",
        *[f"| Hạng {c} | {100 + i * 50}.000 | {150 + i * 50}.000 |" for i, c in enumerate("ABCDEFGH")],
    ]
    return "\n".join(lines)


async def probe(name: str, text: str) -> None:
    processed = FileProcessor().process_bytes(text.encode(), file_name=name, title=name)
    chunks = processed.chunks
    print(f"\n=== {name}: {len(chunks)} chunks ===")
    orphans = 0
    for chunk in chunks:
        body = chunk.chunk_text
        path = list(chunk.section_path)
        located = "Điều " in body or any("Điều " in part for part in path)
        is_clause = chunk.chunk_index > 0 and "Hạng" not in body
        orphans += is_clause and not located
        print(
            f"- #{chunk.chunk_index:<2} chars={len(body):4d} section_path={path} "
            f"article_known={located} starts={body[:40]!r}"
        )
    print(f"clause chunks that do not say which article they belong to: {orphans}")
    records, _ = await build_index_records(
        chunks,
        processed.item,
        IndexingContext(tenant_id="t", collection_item_id="c", connector_key="file"),
        embedding_model=None,
    )
    payload = records[0].payload.to_payload()
    print("payload keys:", sorted(payload))
    print("contextual_text of chunk #5:", payload_of(records, 5)[:200].replace("\n", " | "))
    time_fields = {"effective_from", "valid_until", "version", "revision_number", "status",
                   "source_updated_at", "created_at", "updated_at"}
    print("time/version/status fields in payload schema:",
          sorted(time_fields & set(_IndexedChunk.model_fields)) or "NONE")
    print("effective date only inside body text of chunk #0:",
          "Có hiệu lực" in chunks[0].chunk_text)


def payload_of(records, index: int) -> str:
    record = records[min(index, len(records) - 1)]
    return record.payload.to_payload()["contextual_text"]


async def main() -> None:
    await probe("quy_che_2026.md", regulation(markdown=True))
    await probe("quy_che_2026.txt", regulation(markdown=False))


if __name__ == "__main__":
    asyncio.run(main())
