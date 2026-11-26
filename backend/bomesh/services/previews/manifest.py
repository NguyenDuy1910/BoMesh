"""What a revision records about its representation, and where the object lives.

``item_revisions.exports.representation`` (:class:`StoredRepresentation`)
describes the representation of the revision's content: ``stored`` is true
when the engine made an object (:func:`representation_key`), false when the
original is the representation. ``item_revisions.exports.representation_failure``
(``reason``) records a file that cannot be shown. A manifest never holds a key
or names the content it shows: a revision's content never changes, and a
revision that reuses a ``content_id`` starts with the exports of the revision
it reuses (``document_viewer.md`` "Producing → Stored").
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from bomesh.storage.keys import REPRESENTATION, derived_key

#: Producer version of every stored representation: another version is made again
#: (2: TABLE rows from A1, values as the sheet shows them, ``.xls`` as a TABLE).
#: It is part of the processing version: citation highlights index it.
REPRESENTATION_VERSION = 2


@dataclass(frozen=True, slots=True)
class StoredRepresentation:
    """``item_revisions.exports.representation``."""

    kind: str
    mime_type: str
    size_bytes: int
    #: The engine made an object (:func:`representation_key`); false when the
    #: original is the representation.
    stored: bool = False
    text_format: str | None = None
    language: str | None = None
    media_type: str | None = None
    truncated: bool = False
    version: int = REPRESENTATION_VERSION

    def to_json(self) -> dict[str, Any]:
        stored: dict[str, Any] = {
            "version": self.version,
            "kind": self.kind,
            "stored": self.stored,
            "mime_type": self.mime_type,
            "size_bytes": self.size_bytes,
            "truncated": self.truncated,
        }
        for name in ("text_format", "language", "media_type"):
            value = getattr(self, name)
            if value is not None:
                stored[name] = value
        return stored


def stored_representation(exports: Mapping[str, Any]) -> StoredRepresentation | None:
    """The revision's representation, if this producer version made it."""
    value = exports.get("representation")
    if not isinstance(value, Mapping) or value.get("version") != REPRESENTATION_VERSION:
        return None
    kind, mime_type, size = value.get("kind"), value.get("mime_type"), value.get("size_bytes")
    if not isinstance(kind, str) or not isinstance(mime_type, str) or not isinstance(size, int):
        return None
    return StoredRepresentation(
        kind=kind,
        mime_type=mime_type,
        size_bytes=size,
        stored=value.get("stored") is True,
        text_format=_string(value.get("text_format")),
        language=_string(value.get("language")),
        media_type=_string(value.get("media_type")),
        truncated=value.get("truncated") is True,
    )


def representation_failure(exports: Mapping[str, Any]) -> str | None:
    """The recorded reason the revision's content cannot be shown, if any."""
    value = exports.get("representation_failure")
    if not isinstance(value, Mapping):
        return None
    reason = value.get("reason")
    return reason if isinstance(reason, str) else None


def representation_key(workspace: str, content_id: UUID) -> str:
    """The representation object of one content by this producer version."""
    return derived_key(workspace, content_id, REPRESENTATION, REPRESENTATION_VERSION)


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "REPRESENTATION_VERSION",
    "StoredRepresentation",
    "representation_failure",
    "representation_key",
    "stored_representation",
]
