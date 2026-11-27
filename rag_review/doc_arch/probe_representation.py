"""Measure what BoMesh's real parse path keeps, per format, on generated fixtures.

Read-only diagnostic for DOCUMENT_ARCHITECTURE_REVIEW.md. Runs the production
classes (DoclingProcessor, DocumentMapper, DoclingChunker, build_document_rendition)
on fixtures generated into a temp directory; no database, storage, index or model.

    cd backend && uv run python ../rag_review/doc_arch/probe_representation.py \
        [--pdf path/to/converted.pdf] > ../rag_review/doc_arch/results/probe.json

Optional --pdf: a PDF of fixture.docx (e.g. converted by Gotenberg) to compare the
typed-PDF path against the native DOCX parse of the same content.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import resource
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

APPROVAL_HEADING = "13. Ngày phê duyệt lần đầu"
APPROVAL_DATE = "09/12/2022"
FILLER = (
    "Thuốc được chỉ định cho người lớn và trẻ em trên 12 tuổi. Liều dùng được điều chỉnh "
    "theo chức năng thận và theo dõi lâm sàng định kỳ trong suốt quá trình điều trị. "
)


def make_docx(path: Path, *, preface: bool = False) -> None:
    from docx import Document
    from docx.enum.text import WD_BREAK

    doc = Document()
    if preface:
        doc.add_paragraph("Đoạn mở đầu được thêm vào bản sửa đổi.")
    doc.add_heading("Tờ hướng dẫn sử dụng thuốc", level=0)
    for number in range(1, 13):
        doc.add_heading(f"{number}. Mục {number}", level=1)
        doc.add_paragraph(FILLER * (2 + number % 3))
        if number == 4:
            doc.add_paragraph("Tác dụng phụ thường gặp:")
            for value in ("Buồn nôn", "Đau đầu", "Chóng mặt"):
                doc.add_paragraph(value, style="List Bullet")
        if number == 6:
            table = doc.add_table(rows=4, cols=3)
            table.style = "Table Grid"
            merged = table.cell(0, 0).merge(table.cell(0, 1))
            merged.text = "Liều dùng (gộp ô)"
            table.cell(0, 2).text = "Ghi chú"
            for row, values in enumerate(
                (("Người lớn", "500 mg", "2 lần/ngày"), ("Trẻ em", "250 mg", "1 lần/ngày"),
                 ("Người cao tuổi", "250 mg", "Theo dõi thận")),
                start=1,
            ):
                for col, value in enumerate(values):
                    table.cell(row, col).text = value
        if number == 8:
            doc.paragraphs[-1].add_run().add_break(WD_BREAK.PAGE)
    doc.add_heading(APPROVAL_HEADING, level=1)
    doc.add_paragraph(APPROVAL_DATE)
    doc.add_heading("14. Ngày sửa đổi", level=1)
    doc.add_paragraph("15/03/2024")
    doc.save(path)


def make_xlsx(path: Path) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Học phí 2025"
    ws["A1"] = "BẢNG HỌC PHÍ NĂM HỌC 2025-2026"
    ws.merge_cells("A1:D1")
    ws.append(["Mã ngành", "Tên ngành", "Học phí (VNĐ/tín chỉ)", "Ghi chú"])
    for index in range(1, 301):
        ws.append([f"7{index:06d}", f"Ngành số {index}", 450000 + index * 1000, "Chính quy"])
    other = wb.create_sheet("Lệ phí")
    other.append(["Khoản", "Mức thu"])
    other.append(["Lệ phí thi", 300000])
    wb.save(path)


MARKDOWN = f"""# Quy chế đào tạo

## 1. Phạm vi

{FILLER}

- Mục **một** có [liên kết](https://example.edu.vn/quy-che)
- Mục hai

## 2. Bảng điểm

| Thang chữ | Thang 10 |
|---|---|
| A | 8.5 - 10 |
| B | 7.0 - 8.4 |

```python
print("xin chào")
```

## {APPROVAL_HEADING}

{APPROVAL_DATE}
"""

HTML = f"""<html><body><h1>Thông báo</h1><h2>1. Nội dung</h2><p>{FILLER}</p>
<p>Xem <a href="https://example.edu.vn/tb">chi tiết</a>.</p>
<table><tr><th colspan="2">Lịch thi</th></tr><tr><td>Môn</td><td>Ngày</td></tr>
<tr><td>Toán</td><td>01/06/2025</td></tr></table>
<h2>{APPROVAL_HEADING}</h2><p>{APPROVAL_DATE}</p></body></html>"""


def measure(path: Path, file_name: str) -> dict:
    from bomesh.connector.processing.chunking import DoclingChunker
    from bomesh.connector.processing.docling import DoclingProcessor
    from bomesh.connector.processing.mapper import DocumentMapper
    from bomesh.connector.protocol import DocumentKind, SourceIdentity, SourceProvider
    from bomesh.services.artifacts.rendition import build_document_rendition

    processor = PROCESSOR
    started = time.perf_counter()
    document = processor.process_path(path, file_name=file_name)
    parse_s = time.perf_counter() - started

    started = time.perf_counter()
    item = DocumentMapper().to_item(
        document,
        item_id="item",
        title=file_name,
        source=SourceIdentity(connector_id="probe", provider=SourceProvider.FILE, external_id=file_name),
        document_kind=DocumentKind.DOCUMENT,
    )
    map_s = time.perf_counter() - started

    started = time.perf_counter()
    strategy = "line" if path.suffix in {".jsonl", ".log", ".sql", ".tsv"} else "hybrid"
    chunks = DoclingChunker().chunk(document, item_id="item", strategy=strategy)
    chunk_s = time.perf_counter() - started

    rendition = build_document_rendition(item)
    blocks = json.loads(gzip.decompress(rendition.data))["blocks"]
    docling_json = document.model_dump_json().encode()
    markdown = document.export_to_markdown().encode()

    block_ids = {block["id"] for block in blocks}
    span_ids = [span.element_id for chunk in chunks for span in chunk.citation.spans]
    approval = [
        {
            "chunk_id": chunk.id,
            "section_path": list(chunk.section_path),
            "chunk_text": chunk.chunk_text[:240],
            "spans": [
                {"element_id": s.element_id, "page": s.page, "offsets": [s.start_offset, s.end_offset],
                 "bbox": s.bounding_box is not None}
                for s in chunk.citation.spans
            ],
        }
        for chunk in chunks
        if APPROVAL_DATE in chunk.chunk_text
    ]
    approval_blocks = [b for b in blocks if APPROVAL_DATE in str(b.get("text", ""))]
    table_chunks = [c.chunk_text[:200] for c in chunks if c.content_type == "table"][:2]
    return {
        "file": file_name,
        "bytes": {
            "original": path.stat().st_size,
            "docling_json": len(docling_json),
            "docling_json_gz": len(gzip.compress(docling_json, 6)),
            "markdown": len(markdown),
            "rendition_json": len(gzip.decompress(rendition.data)),
            "rendition_gz": len(rendition.data),
        },
        "seconds": {"parse": round(parse_s, 3), "map": round(map_s, 3), "chunk": round(chunk_s, 3)},
        "parts": dict(Counter(type(p).__name__ for p in item.content)),
        "blocks": dict(Counter(b["kind"] for b in blocks)),
        "heading_levels_in_rendition": sorted({b.get("level") for b in blocks if b["kind"] == "heading"}),
        "docling_heading_levels": sorted(
            {getattr(t, "level", None) for t in document.texts if t.label.value == "section_header"}
        ),
        "list_items_in_docling": sum(1 for t in document.texts if t.label.value == "list_item"),
        "chunks": len(chunks),
        "chunk_content_types": dict(Counter(c.content_type for c in chunks)),
        "chunks_with_page": sum(1 for c in chunks if any(s.page for s in c.citation.spans)),
        "chunks_with_bbox": sum(1 for c in chunks if any(s.bounding_box for s in c.citation.spans)),
        "chunks_with_offsets": sum(1 for c in chunks if any(s.start_offset is not None for s in c.citation.spans)),
        "chunks_multi_element": sum(1 for c in chunks if len({s.element_id for s in c.citation.spans}) > 1),
        "chunks_without_element": sum(1 for c in chunks if not any(s.element_id for s in c.citation.spans)),
        "span_element_ids_resolving_to_block": f"{sum(1 for i in span_ids if i in block_ids)}/{len(span_ids)}",
        "markdown_syntax_in_chunks": sum(
            1 for c in chunks if re.search(r"(^|\n)#{1,6} |\*\*|\|---|```", c.chunk_text)
        ),
        "table_chunk_samples": table_chunks,
        "approval": approval,
        "approval_blocks": approval_blocks,
        "element_ids": sorted(block_ids)[:5],
        "_chunks": [(c.chunk_text, [s.element_id for s in c.citation.spans]) for c in chunks],
        "_blocks": {b["id"]: b.get("text") or b.get("caption") for b in blocks},
    }


def identity_drift(before: dict, after: dict) -> dict:
    """What a positional chunk id / element id points at after one paragraph is inserted."""

    chunks_before, chunks_after = before["_chunks"], after["_chunks"]
    same_index_changed = sum(
        1 for i in range(min(len(chunks_before), len(chunks_after))) if chunks_before[i][0] != chunks_after[i][0]
    )
    blocks_before, blocks_after = before["_blocks"], after["_blocks"]
    shared_ids = set(blocks_before) & set(blocks_after)
    id_text_changed = sum(1 for i in shared_ids if blocks_before[i] != blocks_after[i])
    approval_before = next(c for c in chunks_before if APPROVAL_DATE in c[0])
    index_before = chunks_before.index(approval_before)
    return {
        "chunks_before": len(chunks_before),
        "chunks_after": len(chunks_after),
        "chunk_ids_whose_text_changed": f"{same_index_changed}/{min(len(chunks_before), len(chunks_after))}",
        "element_ids_shared": len(shared_ids),
        "element_ids_whose_text_changed": id_text_changed,
        "approval_chunk_id_before": f"item:{index_before}",
        "old_approval_chunk_id_now_points_to": (chunks_after[index_before][0][:120] if index_before < len(chunks_after) else None),
        "old_approval_element_ids": approval_before[1],
        "old_approval_element_ids_now_point_to": [blocks_after.get(i) for i in approval_before[1]],
    }


def main() -> None:
    global PROCESSOR
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--keep", type=Path, help="write fixtures here")
    args = parser.parse_args()

    started = time.perf_counter()
    from bomesh.connector.processing.docling import DoclingProcessor  # noqa: PLC0415

    import_s = time.perf_counter() - started
    PROCESSOR = DoclingProcessor()

    with tempfile.TemporaryDirectory() as tmp:
        root = args.keep or Path(tmp)
        root.mkdir(parents=True, exist_ok=True)
        make_docx(root / "fixture.docx")
        make_docx(root / "fixture_v2.docx", preface=True)
        make_xlsx(root / "fixture.xlsx")
        (root / "fixture.md").write_text(MARKDOWN, encoding="utf-8")
        (root / "fixture.html").write_text(HTML, encoding="utf-8")

        results = {}
        cold = time.perf_counter()
        results["docx"] = measure(root / "fixture.docx", "fixture.docx")
        first_docx_s = time.perf_counter() - cold
        warm = time.perf_counter()
        results["docx_again"] = measure(root / "fixture.docx", "fixture.docx")
        second_docx_s = time.perf_counter() - warm
        results["docx_v2"] = measure(root / "fixture_v2.docx", "fixture_v2.docx")
        results["xlsx"] = measure(root / "fixture.xlsx", "fixture.xlsx")
        results["md"] = measure(root / "fixture.md", "fixture.md")
        results["html"] = measure(root / "fixture.html", "fixture.html")
        if args.pdf:
            results["pdf_of_docx"] = measure(args.pdf, "fixture.pdf")

    deterministic = results["docx"]["_chunks"] == results["docx_again"]["_chunks"]
    report = {
        "docling_import_seconds": round(import_s, 2),
        "first_docx_end_to_end_seconds": round(first_docx_s, 2),
        "second_docx_end_to_end_seconds": round(second_docx_s, 2),
        "reparse_deterministic": deterministic,
        "identity_drift_after_inserting_one_paragraph": identity_drift(results["docx"], results["docx_v2"]),
        "max_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024, 1),
        "formats": {
            key: {k: v for k, v in value.items() if not k.startswith("_")}
            for key, value in results.items()
            if key not in {"docx_again", "docx_v2"}
        },
    }
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)


PROCESSOR = None

if __name__ == "__main__":
    main()
