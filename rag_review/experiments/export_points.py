"""Read-only snapshot of live index points (payload + dense vector) for offline experiments.

    RR_QDRANT_URL=... RR_QDRANT_API_KEY=... uv run python ../rag_review/experiments/export_points.py OUT_DIR

Writes OUT_DIR/points.jsonl (payload) and OUT_DIR/dense.npy (row-aligned dense
vectors). Only scrolls; never writes to the source collection.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from qdrant_client import QdrantClient, models

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
client = QdrantClient(url=os.environ["RR_QDRANT_URL"], api_key=os.environ["RR_QDRANT_API_KEY"], timeout=120, prefer_grpc=False)
collection = os.environ.get("RR_QDRANT_COLLECTION", "bomesh")
live = models.Filter(must=[models.FieldCondition(key="is_deleted", match=models.MatchValue(value=False))])

rows, vectors, offset = [], [], None
while True:
    points, offset = client.scroll(
        collection, scroll_filter=live, limit=500, offset=offset, with_payload=True, with_vectors=["content"]
    )
    for point in points:
        rows.append({"point_id": str(point.id), **point.payload})
        vectors.append(point.vector["content"])
    if offset is None:
        break

with (out / "points.jsonl").open("w", encoding="utf-8") as handle:
    for row in rows:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
np.save(out / "dense.npy", np.asarray(vectors, dtype=np.float32))
print(f"{len(rows)} points, {len({r['item_id'] for r in rows})} documents -> {out}")
