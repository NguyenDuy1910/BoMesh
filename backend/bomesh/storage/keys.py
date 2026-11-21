"""The one object key convention (``database_architecture.md`` "Object storage").

PostgreSQL never stores an object key: every key is a pure function of
identities the rows already hold, and this module is the only place that
formats one. The first segment is the lifecycle class (bucket lifecycle
rules, backups and inventories select a class by prefix), the second the
owning tenant UUID (``platform`` for platform-level objects), the leaf an
immutable identity. Keys never contain file names, titles or provider paths.

==========  ===============================================  ============================
Class       Key                                              Holds
==========  ===============================================  ============================
content     ``content/{tenant}/{content_id}``                the bytes of a revision
derived     ``derived/{tenant}/{content_id}/{product}-v{n}``  what is built from them
assets      ``assets/{tenant}/{kind}/{asset_id}``            workspace assets
exports     ``exports/{tenant | platform}/{operation_id}``   export Operation results
==========  ===============================================  ============================
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE

CONTENT = "content"
DERIVED = "derived"
ASSETS = "assets"
EXPORTS = "exports"
#: Every lifecycle class that holds a tenant's objects (a workspace's objects
#: are one prefix per class).
TENANT_CLASSES = (CONTENT, DERIVED, ASSETS, EXPORTS)
#: The scope of objects that belong to no tenant (platform exports).
PLATFORM = "platform"

#: Immutable objects: a key is written once (derived keys change by version).
IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable"

#: Derived products (``derived/{tenant}/{content}/{product}-v{n}``).
REPRESENTATION = "representation"
COVER = "cover"
PREVIEW = "preview"

#: Asset kinds (``assets/{tenant}/{kind}/{id}``).
MAP_BACKGROUND = "map-background"

_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_PART = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def content_key(tenant_id: UUID, content_id: UUID) -> str:
    """The bytes of every revision with this ``content_id``."""

    return f"{CONTENT}/{_uuid(tenant_id)}/{_uuid(content_id)}"


def derived_prefix(tenant_id: UUID, content_id: UUID) -> str:
    """Everything built from one content; deleted with it."""

    return f"{DERIVED}/{_uuid(tenant_id)}/{_uuid(content_id)}/"


def derived_key(
    tenant_id: UUID,
    content_id: UUID,
    product: str,
    version: int,
    part: str | None = None,
) -> str:
    """One derived product of a content, e.g. ``…/representation-v1`` or ``…/preview-v1/page-0001``.

    A product is rebuilt under a new key by bumping ``version``, never
    overwritten with different bytes.
    """

    if version < 1:
        raise ValueError("a derived product version starts at 1")
    key = f"{derived_prefix(tenant_id, content_id)}{_segment(product)}-v{version}"
    return f"{key}/{_part(part)}" if part is not None else key


def asset_key(tenant_id: UUID, kind: str, asset_id: UUID) -> str:
    """A workspace asset that is not a Document (``MAP_BACKGROUND``)."""

    return f"{ASSETS}/{_uuid(tenant_id)}/{_segment(kind)}/{_uuid(asset_id)}"


def export_key(tenant_id: UUID | None, operation_id: UUID) -> str:
    """The result of a finished export Operation; ``None`` is a platform export."""

    scope = _uuid(tenant_id) if tenant_id is not None else PLATFORM
    return f"{EXPORTS}/{scope}/{_uuid(operation_id)}"


def tenant_prefixes(tenant_id: UUID) -> tuple[str, ...]:
    """Every prefix holding a tenant's objects, one per lifecycle class."""

    return tuple(f"{kind}/{_uuid(tenant_id)}/" for kind in TENANT_CLASSES)


def new_content_id() -> UUID:
    """The identity of bytes nobody wrote before (an upload, an artifact)."""

    return uuid4()


def source_content_id(connection_id: str, external_id: str, version: str | None) -> UUID:
    """The identity of one provider version of a source original.

    Derived, so a retried or repeated sync writes the same object instead of a
    new one. An unversioned provider object gets a fresh identity: it must
    never overwrite bytes an older revision still shows.
    """

    if not version:
        return uuid4()
    return _derived("source-content", connection_id, external_id, version)


def archive_member_content_id(archive_content_id: UUID, member_path: str) -> UUID:
    """The identity of one archive member's bytes: a retried expansion rewrites the same object."""

    return _derived("archive-content", str(archive_content_id), member_path)


def content_disposition(file_name: str, *, attachment: bool = False) -> str:
    """``Content-Disposition`` for a signed download: the name never lives in the key."""

    name = " ".join(str(file_name).split()) or "file"
    folded = unicodedata.normalize("NFKD", name.replace("đ", "d").replace("Đ", "D"))
    ascii_name = folded.encode("ascii", "ignore").decode("ascii").replace('"', "") or "file"
    kind = "attachment" if attachment else "inline"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


def _derived(kind: str, *parts: str) -> UUID:
    name = ":".join((PERSISTED_IDENTITY_NAMESPACE, kind, *parts))
    return uuid5(NAMESPACE_URL, name)


def _uuid(value: UUID) -> str:
    if not isinstance(value, UUID):
        value = UUID(str(value))
    return str(value)


def _segment(value: str) -> str:
    if not _SEGMENT.match(value):
        raise ValueError(f"invalid object key segment: {value!r}")
    return value


def _part(value: str) -> str:
    if not _PART.match(value):
        raise ValueError(f"invalid object key part: {value!r}")
    return value


__all__ = [
    "ASSETS",
    "CONTENT",
    "COVER",
    "DERIVED",
    "EXPORTS",
    "IMMUTABLE_CACHE_CONTROL",
    "MAP_BACKGROUND",
    "PLATFORM",
    "PREVIEW",
    "REPRESENTATION",
    "TENANT_CLASSES",
    "archive_member_content_id",
    "asset_key",
    "content_disposition",
    "content_key",
    "derived_key",
    "derived_prefix",
    "export_key",
    "new_content_id",
    "source_content_id",
    "tenant_prefixes",
]
