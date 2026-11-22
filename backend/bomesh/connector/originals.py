"""Where a connector keeps the original of each source Document.

Every connector Document is registered with its original in object storage.
Each provider version of a source item is one content: its id is derived from
the connection, the external id and the version (``source_content_id``), and
its object key from the tenant and that id (``content_key``). A new version
therefore never overwrites the object an older revision (or the published
Document while a REVIEW_FIRST candidate waits for review) still references.
Connectors store originals as they are; nothing here parses.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from bomesh.connector.protocol import RawObjectStore, StorageObject
from bomesh.storage import StoredObject
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, content_key, source_content_id


@dataclass(frozen=True, slots=True)
class OriginalTarget:
    """One provider version of a source item, whose original is being stored."""

    tenant_id: str | UUID
    connection_id: str | UUID
    external_id: str
    version: str | None

    @property
    def content_id(self) -> UUID:
        return source_content_id(str(self.connection_id), self.external_id, self.version)


def store_original(
    storage: RawObjectStore | None,
    *,
    target: OriginalTarget,
    file_name: str,
    content_type: str,
    data: bytes | None = None,
    path: Path | None = None,
) -> StorageObject:
    """Write one provider version's original (bytes or a downloaded file)."""

    if storage is None:
        raise RuntimeError("source sync requires configured object storage")
    if (data is None) == (path is None):
        raise ValueError("store exactly one of data or path")
    content_id = target.content_id
    key = content_key(UUID(str(target.tenant_id)), content_id)
    stored = (
        storage.put_bytes(
            data, key, content_type=content_type, cache_control=IMMUTABLE_CACHE_CONTROL
        )
        if data is not None
        else storage.put_path(
            path,  # type: ignore[arg-type]
            key,
            content_type=content_type,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )
    )
    if not isinstance(stored, StoredObject):
        raise RuntimeError("configured object storage returned invalid metadata")
    return StorageObject(
        content_id=content_id,
        file_name=file_name,
        size_bytes=stored.size_bytes,
        content_type=stored.content_type or content_type,
        etag=stored.etag,
        version_id=stored.version_id,
    )


__all__ = ["OriginalTarget", "store_original"]
