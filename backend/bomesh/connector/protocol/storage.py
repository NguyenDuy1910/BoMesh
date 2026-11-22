"""Canonical raw-object references and the connector storage boundary."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class StorageObject(BaseModel):
    """The stored original of one provider version of a source Document.

    It names the content (``content_id``); its object key is derived from the
    tenant and the content id by ``bomesh.storage.keys.content_key`` and is
    never carried or stored.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    content_id: UUID
    file_name: str | None = Field(default=None, min_length=1)
    size_bytes: int | None = Field(default=None, ge=0)
    content_type: str | None = Field(default=None, min_length=1)
    etag: str | None = Field(default=None, min_length=1)
    version_id: str | None = Field(default=None, min_length=1)


@runtime_checkable
class RawObjectStore(Protocol):
    def put_bytes(
        self,
        data: bytes,
        key: str,
        *,
        content_type: str | None = None,
        cache_control: str | None = None,
    ) -> object: ...

    def put_path(
        self,
        path: Path,
        key: str,
        *,
        content_type: str | None = None,
        cache_control: str | None = None,
    ) -> object: ...


__all__ = ["RawObjectStore", "StorageObject"]
