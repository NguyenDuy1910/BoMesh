"""Build a scratch ablation collection from an exported snapshot (export_points.py).

One point per production chunk, with three representations side by side:

    raw     chunk_text
    struct  "Document: {title}\\nSection: {path}\\n\\n{chunk_text}"   (no generated context)
    ctx     production contextual_text (structural + generated/summary context)

Each representation has a dense vector (d_*) and a BM25 sparse vector (s_*)
built with production's exact BM25 options. ctx dense vectors are the
production vectors (no re-embedding); raw/struct are embedded once with the
configured EMBEDDING_MODEL (cached in SNAP/dense_{raw,struct}.npy).

    cd backend && env -u OPENAI_BASE_URL uv run python ../rag_review/experiments/build_ablation_index.py /tmp/rr/snap

Writes only to the scratch collection RR_ABLATION_COLLECTION (default
rr_ablation) on RR_SCRATCH_QDRANT_URL (default local http://127.0.0.1:6333).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from qdrant_client import QdrantClient, models

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
load_dotenv(ROOT / ".env", override=False)

from bomesh.agent.transports.openai import OpenAITransport  # noqa: E402
from bomesh.document_index import BM25_MODEL, BM25_OPTIONS  # noqa: E402

SNAP = Path(sys.argv[1])
COLLECTION = os.environ.get("RR_ABLATION_COLLECTION", "rr_ablation")
SCRATCH = os.environ.get("RR_SCRATCH_QDRANT_URL", "http://127.0.0.1:6333")
REPRESENTATIONS = ("raw", "struct", "ctx")


def structural(row: dict) -> str:
    prefix = [f"Document: {row['title']}"] if row.get("title") else []
    if row.get("section_path"):
        prefix.append(f"Section: {' > '.join(row['section_path'])}")
    head = "\n".join(prefix)
    return f"{head}\n\n{row['chunk_text']}" if head else row["chunk_text"]


def texts(rows: list[dict]) -> dict[str, list[str]]:
    return {
        "raw": [r["chunk_text"] for r in rows],
        "struct": [structural(r) for r in rows],
        "ctx": [r["contextual_text"] for r in rows],
    }


async def embed_all(values: list[str], cache: Path) -> np.ndarray:
    if cache.exists():
        return np.load(cache)
    transport = OpenAITransport(embedding_model=os.environ["EMBEDDING_MODEL"])
    out: list[list[float]] = []
    for start in range(0, len(values), 256):
        out.extend(await transport.embed_documents(values[start : start + 256]))
        print(f"  embedded {len(out)}/{len(values)}", flush=True)
    array = np.asarray(out, dtype=np.float32)
    np.save(cache, array)
    return array


async def main() -> None:
    rows = [json.loads(line) for line in (SNAP / "points.jsonl").open(encoding="utf-8")]
    representation = texts(rows)
    dense = {
        "ctx": np.load(SNAP / "dense.npy"),
        "raw": await embed_all(representation["raw"], SNAP / "dense_raw.npy"),
        "struct": await embed_all(representation["struct"], SNAP / "dense_struct.npy"),
    }
    client = QdrantClient(url=SCRATCH, timeout=300)
    if client.collection_exists(COLLECTION):
        client.delete_collection(COLLECTION)
    client.create_collection(
        COLLECTION,
        vectors_config={f"d_{r}": models.VectorParams(size=1536, distance=models.Distance.COSINE) for r in REPRESENTATIONS},
        sparse_vectors_config={f"s_{r}": models.SparseVectorParams(modifier=models.Modifier.IDF) for r in REPRESENTATIONS},
    )
    batch: list[models.PointStruct] = []
    for i, row in enumerate(rows):
        vector: dict = {f"d_{r}": dense[r][i].tolist() for r in REPRESENTATIONS}
        vector |= {
            f"s_{r}": models.Document(text=representation[r][i], model=BM25_MODEL, options=BM25_OPTIONS)
            for r in REPRESENTATIONS
        }
        batch.append(
            models.PointStruct(
                id=row["point_id"],
                vector=vector,
                payload={k: row.get(k) for k in ("item_id", "chunk_id", "chunk_index", "title", "chunk_text", "collection_item_id", "content_type")},
            )
        )
        if len(batch) == 128:
            client.upsert(COLLECTION, batch, wait=True)
            batch = []
    if batch:
        client.upsert(COLLECTION, batch, wait=True)
    print(COLLECTION, client.count(COLLECTION, exact=True).count, "points")


if __name__ == "__main__":
    asyncio.run(main())
