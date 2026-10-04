"""Where a connector keeps the original of each source Document.

Every connector Document is registered with its original in object storage,
under one key convention, so processing reads the same bytes whichever source
they came from. Connectors store originals as they are; nothing here parses.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from bomesh.connector.protocol import RawObjectStore, StorageObject
from bomesh.storage import StoredObject


def original_key(
    *,
    tenant_id: str,
    connection_id: str,
    provider: str,
    external_id: str,
    file_name: str,
) -> str:
    """The object key of one source Document's original."""

    return (
        f"tenants/{_part(tenant_id)}/sources/{_part(connection_id)}/{provider}/"
        f"{_part(external_id)}/{_part(file_name)}"
    )


def store_original(
    storage: RawObjectStore | None,
    *,
    key: str,
    file_name: str,
    content_type: str,
    data: bytes | None = None,
    path: Path | None = None,
) -> StorageObject:
    """Write one original (bytes or a downloaded file) and describe it."""

    if storage is None:
        raise RuntimeError("source sync requires configured object storage")
    if (data is None) == (path is None):
        raise ValueError("store exactly one of data or path")
    stored = (
        storage.put_bytes(data, key, content_type=content_type)
        if data is not None
        else storage.put_path(path, key, content_type=content_type)  # type: ignore[arg-type]
    )
    if not isinstance(stored, StoredObject):
        raise RuntimeError("configured object storage returned invalid metadata")
    return StorageObject(
        provider=_optional_text(getattr(storage, "provider", None)),
        bucket=_optional_text(getattr(storage, "bucket", None)),
        key=key,
        file_name=file_name,
        size_bytes=stored.size_bytes,
        content_type=stored.content_type or content_type,
        etag=stored.etag,
        version_id=stored.version_id,
    )


def _part(value: str) -> str:
    return quote(value, safe="-_.")


def _optional_text(value: object) -> str | None:
    result = str(value).strip() if value is not None else ""
    return result or None


__all__ = ["original_key", "store_original"]
