"""Classification answers kept with the file they classify (``document_contract.md``
"Classification reuse").

Each answer is one immutable object,
``workspaces/{code}/files/{content_id}/classification-v1/{key}.json``, purged
with the file. The key (made by the contextualizer) names everything an answer
depends on: model, prompt, taxonomy, note and the document's part.
"""

from __future__ import annotations

import asyncio
from uuid import UUID

from bomesh.document_index import ClassificationCache
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.storage.keys import CLASSIFICATION, IMMUTABLE_CACHE_CONTROL, derived_key

#: A stored answer is a small JSON object; anything larger is not one.
MAX_CLASSIFICATION_BYTES = 256 * 1024


class StoredClassifications:
    """The classification answers of every file, in object storage."""

    def __init__(self, storage: DocumentStorage) -> None:
        self._storage = storage

    def of(self, workspace: str, content_id: UUID) -> ClassificationCache:
        """The answers of one file (its ``content_id`` in ``workspace``)."""

        return _FileClassifications(self._storage, workspace, content_id)


class _FileClassifications:
    """A :class:`~bomesh.document_index.ClassificationCache` of one file."""

    def __init__(self, storage: DocumentStorage, workspace: str, content_id: UUID) -> None:
        self._storage = storage
        self._workspace = workspace
        self._content_id = content_id

    def object_key(self, key: str) -> str:
        return derived_key(self._workspace, self._content_id, CLASSIFICATION, 1, part=f"{key}.json")

    async def get(self, key: str) -> str | None:
        try:
            data = await self._storage.read(self.object_key(key), max_bytes=MAX_CLASSIFICATION_BYTES)
        except ObjectNotFoundError:
            return None
        return data.decode("utf-8")

    async def put(self, key: str, answer: str) -> None:
        await asyncio.to_thread(
            self._storage.put_bytes,
            answer.encode("utf-8"),
            self.object_key(key),
            content_type="application/json",
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )


__all__ = ["MAX_CLASSIFICATION_BYTES", "StoredClassifications"]
