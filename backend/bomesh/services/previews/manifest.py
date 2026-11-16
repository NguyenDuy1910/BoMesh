"""What a revision records about its representation, and where derived objects live.

``item_revisions.exports.representation`` (:class:`StoredRepresentation`)
names the ``source`` (the ``storage_key`` it shows) and, unless the original
is the representation, the ``key`` of the object the engine made;
``item_revisions.exports.representation_failure`` (``source``, ``reason``)
records a file that cannot be shown. Both count only while ``source`` is the
revision's own ``storage_key``. Derived objects live under the Item's
``previews/`` prefix, named after the original they show, immutable.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from bomesh.db.models import Item

#: Producer version of every stored representation: another version is made again.
REPRESENTATION_VERSION = 1
#: Every derived object is immutable: its key changes with what it shows.
IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable"


@dataclass(frozen=True, slots=True)
class StoredRepresentation:
    """``item_revisions.exports.representation``."""

    source: str
    kind: str
    mime_type: str
    size_bytes: int
    #: The engine's object; ``None`` when the original is the representation.
    key: str | None = None
    text_format: str | None = None
    language: str | None = None
    media_type: str | None = None
    truncated: bool = False
    version: int = REPRESENTATION_VERSION

    def to_json(self) -> dict[str, Any]:
        stored: dict[str, Any] = {
            "version": self.version,
            "source": self.source,
            "kind": self.kind,
            "mime_type": self.mime_type,
            "size_bytes": self.size_bytes,
            "truncated": self.truncated,
        }
        for name in ("key", "text_format", "language", "media_type"):
            value = getattr(self, name)
            if value is not None:
                stored[name] = value
        return stored


def stored_representation(exports: Mapping[str, Any], source: str) -> StoredRepresentation | None:
    """The revision's representation, if it was made from ``source`` by this producer version."""
    value = exports.get("representation")
    if not isinstance(value, Mapping) or value.get("source") != source:
        return None
    if value.get("version") != REPRESENTATION_VERSION:
        return None
    kind, mime_type, size = value.get("kind"), value.get("mime_type"), value.get("size_bytes")
    if not isinstance(kind, str) or not isinstance(mime_type, str) or not isinstance(size, int):
        return None
    return StoredRepresentation(
        source=source,
        kind=kind,
        mime_type=mime_type,
        size_bytes=size,
        key=_string(value.get("key")),
        text_format=_string(value.get("text_format")),
        language=_string(value.get("language")),
        media_type=_string(value.get("media_type")),
        truncated=value.get("truncated") is True,
    )


def representation_failure(exports: Mapping[str, Any], source: str) -> str | None:
    """The recorded reason the revision's ``source`` cannot be shown, if any."""
    value = exports.get("representation_failure")
    if not isinstance(value, Mapping) or value.get("source") != source:
        return None
    reason = value.get("reason")
    return reason if isinstance(reason, str) else None


def preview_prefix(item: Item) -> str:
    """Where an Item's derived objects (representations, covers, page images) live."""
    if item.id is None:
        raise ValueError("a preview needs the Item's durable ID")
    tenant = str(item.tenant_id) if item.tenant_id is not None else "unscoped"
    return f"tenants/{tenant}/items/{item.id}/previews/"


def source_digest(storage_key: str) -> str:
    """The name derived objects of one original share."""
    return hashlib.sha256(storage_key.encode("utf-8")).hexdigest()


def representation_key(item: Item, storage_key: str, extension: str) -> str:
    """``…/previews/rep-v1/{sha256(storage_key)}.{extension}``."""
    return (
        f"{preview_prefix(item)}rep-v{REPRESENTATION_VERSION}/"
        f"{source_digest(storage_key)}.{extension}"
    )


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "IMMUTABLE_CACHE_CONTROL",
    "REPRESENTATION_VERSION",
    "StoredRepresentation",
    "preview_prefix",
    "representation_failure",
    "representation_key",
    "source_digest",
    "stored_representation",
]
