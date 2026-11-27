"""BM25 tokenizer variant: production `multilingual` (folds Vietnamese diacritics:
"bán" == "bàn") vs `word` (keeps them), both on contextual_text, alone and in
the production hybrid shape with the production dense vectors.

    cd backend && uv run python ../rag_review/experiments/run_tokenizer_variant.py DATASET.jsonl SNAP_DIR RESULTS_DIR

Also scores each question with its diacritics stripped (how users often type).
Writes RESULTS_DIR/tokenizer_variant.json. Uses only the scratch Qdrant.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import unicodedata
from pathlib import Path

import numpy as np
from qdrant_client import QdrantClient, models

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from bomesh.document_index import BM25_MODEL, BM25_OPTIONS  # noqa: E402
from eval.matching import matched_gold  # noqa: E402
from eval.metrics import hit_at_k, recall_at_k  # noqa: E402

DATASET, SNAP, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
client = QdrantClient(url=os.environ.get("RR_SCRATCH_QDRANT_URL", "http://127.0.0.1:16335"), timeout=300)
NAME = "rr_tokenizer"
WORD = {**BM25_OPTIONS, "tokenizer": "word"}
OPTIONS = {"multilingual": BM25_OPTIONS, "word": WORD}


def strip_marks(text: str) -> str:
    folded = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    return folded.replace("đ", "d").replace("Đ", "D")


def build() -> None:
    rows = [json.loads(line) for line in (SNAP / "points.jsonl").open(encoding="utf-8")]
    dense = np.load(SNAP / "dense.npy")
    if client.collection_exists(NAME):
        client.delete_collection(NAME)
    client.create_collection(
        NAME,
        vectors_config={"d": models.VectorParams(size=1536, distance=models.Distance.COSINE)},
        sparse_vectors_config={k: models.SparseVectorParams(modifier=models.Modifier.IDF) for k in OPTIONS},
    )
    batch = []
    for i, row in enumerate(rows):
        vector = {"d": dense[i].tolist()} | {
            k: models.Document(text=row["contextual_text"], model=BM25_MODEL, options=o) for k, o in OPTIONS.items()
        }
        batch.append(models.PointStruct(id=row["point_id"], vector=vector, payload={"chunk_text": row["chunk_text"]}))
        if len(batch) == 128:
            client.upsert(NAME, batch, wait=True)
            batch = []
    if batch:
        client.upsert(NAME, batch, wait=True)


def search(text: str, vector: list[float], tokenizer: str, hybrid: bool) -> list:
    sparse = models.Document(text=text, model=BM25_MODEL, options=OPTIONS[tokenizer])
    if not hybrid:
        return client.query_points(NAME, query=sparse, using=tokenizer, limit=20, with_payload=True).points
    return client.query_points(
        NAME,
        prefetch=[models.Prefetch(query=vector, using="d", limit=20), models.Prefetch(query=sparse, using=tokenizer, limit=20)],
        query=models.FusionQuery(fusion=models.Fusion.RRF),
        limit=20,
        with_payload=True,
    ).points


def main() -> None:
    build()
    questions = [json.loads(line) for line in DATASET.open(encoding="utf-8") if line.strip()]
    vectors = json.loads((OUT / "query_vectors.json").read_text())["vectors"]
    results = {}
    for tokenizer in OPTIONS:
        for hybrid in (False, True):
            # A folded query with the original query's dense vector would
            # overstate hybrid recall, so folding is scored on BM25 alone.
            for folded in ((False,) if hybrid else (False, True)):
                rows = []
                for question, vector in zip(questions, vectors, strict=True):
                    if not question["gold"]:
                        continue
                    text = strip_marks(question["question"]) if folded else question["question"]
                    points = search(text, vector, tokenizer, hybrid)
                    quotes = [g["quote"] for g in question["gold"]]
                    matches = [matched_gold(p.payload["chunk_text"], quotes) for p in points]
                    rows.append({"hit@5": hit_at_k(matches, 5), "recall@10": recall_at_k(matches, len(quotes), 10)})
                key = f"{tokenizer}/{'hybrid' if hybrid else 'bm25'}/{'query-no-diacritics' if folded else 'query-as-written'}"
                results[key] = {m: round(statistics.fmean(r[m] for r in rows), 3) for m in rows[0]}
                print(key, results[key], flush=True)
    (OUT / "tokenizer_variant.json").write_text(json.dumps(results, indent=1))
    client.delete_collection(NAME)


if __name__ == "__main__":
    main()
