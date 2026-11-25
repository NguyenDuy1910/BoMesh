"""The one object key convention (``database_architecture.md`` "Object storage").

PostgreSQL never stores an object key: every key is a pure function of
identities the rows already hold, and this module is the only place that
formats one. A key reads as a path a person can follow: whose object it is
(a workspace by its immutable ``code``, or the platform), what part of the
product it belongs to (a file, branding, an export), then an immutable
identity. Keys never contain file names, titles or provider paths.

=================================================================  =====================================
Key                                                                Holds
=================================================================  =====================================
``workspaces/{workspace}/files/{content_id}/original``             the bytes of a file: a document,
                                                                   a chat attachment, an artifact
``workspaces/{workspace}/files/{content_id}/{product}-v{n}[/…]``   what is built from that file
``workspaces/{workspace}/branding/{kind}/{asset_id}``              the workspace logo, map background
``workspaces/{workspace}/exports/{operation_id}.csv``              a workspace export's CSV
``platform/exports/{operation_id}.csv``                            a platform export's CSV
=================================================================  =====================================

One file is one folder: its original and everything built from it, so a
purge deletes one prefix.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE

#: Objects of one workspace (``workspaces/{code}/…``) and of the platform.
WORKSPACES = "workspaces"
PLATFORM = "platform"
#: The parts of a workspace's (or the platform's) objects.
FILES = "files"
BRANDING = "branding"
EXPORTS = "exports"
#: The object of a file's own bytes.
ORIGINAL = "original"

#: Immutable objects: a key is written once (derived keys change by version).
IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable"

#: Products built from a file (``…/files/{content}/{product}-v{n}``), named
#: for what a person finds there.
#: The representation the Original preview shows (a PDF, image or text).
REPRESENTATION = "preview"
#: The cover image of a document card.
COVER = "thumbnail"
#: Vision-model readings of a PDF's scanned page runs, one part per model
#: and run (``ocr-v1/{fingerprint}-p{first}-{last}.json``).
TRANSCRIPT = "ocr"
#: The Structured Document of a file, one part per parse profile
#: (``structure-v1/{fingerprint}.json.gz``), and the images it references by
#: name (``images-v1/{sha256}.png``), shared by every profile of the file.
STRUCTURE = "structure"
PICTURE = "images"
#: The contextualization model's classification answers for a file, one part
#: per reuse key (``classification-v1/{key}.json``: model, prompt, taxonomy,
#: note and the document's part), so processing it again asks the model only
#: when one of them changed.
CLASSIFICATION = "classification"

#: Branding kinds (``…/branding/{kind}/{id}``).
MAP_BACKGROUND = "map-background"
LOGO = "logo"

#: ``Workspace.code`` (``openapi.yaml``): set on create, never changed.
_WORKSPACE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_PART = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def workspace_prefix(workspace: str) -> str:
    """Every object of one workspace."""

    return f"{WORKSPACES}/{_workspace(workspace)}/"


def file_prefix(workspace: str, content_id: UUID) -> str:
    """One file: its original and everything built from it; deleted together."""

    return f"{workspace_prefix(workspace)}{FILES}/{_uuid(content_id)}/"


def content_key(workspace: str, content_id: UUID) -> str:
    """The bytes of every revision with this ``content_id``."""

    return f"{file_prefix(workspace, content_id)}{ORIGINAL}"


def derived_key(
    workspace: str,
    content_id: UUID,
    product: str,
    version: int,
    part: str | None = None,
) -> str:
    """One product built from a file, e.g. ``…/preview-v1`` or ``…/structure-v1/{fp}.json.gz``.

    A product is rebuilt under a new key by bumping ``version``, never
    overwritten with different bytes.
    """

    if version < 1:
        raise ValueError("a derived product version starts at 1")
    key = f"{file_prefix(workspace, content_id)}{_segment(product)}-v{version}"
    return f"{key}/{_part(part)}" if part is not None else key


def asset_key(workspace: str, kind: str, asset_id: UUID) -> str:
    """A branding image of a workspace (``MAP_BACKGROUND``, ``LOGO``)."""

    return f"{workspace_prefix(workspace)}{BRANDING}/{_segment(kind)}/{_uuid(asset_id)}"


def exports_prefix(workspace: str | None) -> str:
    """Every export CSV of a workspace; ``None``: of the platform."""

    scope = workspace_prefix(workspace) if workspace is not None else f"{PLATFORM}/"
    return f"{scope}{EXPORTS}/"


def export_key(workspace: str | None, operation_id: UUID) -> str:
    """The CSV of a finished export Operation; ``None`` is a platform export."""

    return f"{exports_prefix(workspace)}{_uuid(operation_id)}.csv"


def export_operation_id(key: str) -> UUID | None:
    """The Operation an export CSV key names (:func:`export_key`); ``None`` for another key."""

    name = key.rpartition("/")[2]
    if not name.endswith(".csv"):
        return None
    try:
        return UUID(name.removesuffix(".csv"))
    except ValueError:
        return None


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


def _workspace(value: str) -> str:
    if not isinstance(value, str) or not _WORKSPACE.match(value):
        raise ValueError(f"invalid workspace code in object key: {value!r}")
    return value


def _segment(value: str) -> str:
    if not _SEGMENT.match(value):
        raise ValueError(f"invalid object key segment: {value!r}")
    return value


def _part(value: str) -> str:
    if not _PART.match(value):
        raise ValueError(f"invalid object key part: {value!r}")
    return value


__all__ = [
    "BRANDING",
    "CLASSIFICATION",
    "COVER",
    "EXPORTS",
    "FILES",
    "IMMUTABLE_CACHE_CONTROL",
    "LOGO",
    "MAP_BACKGROUND",
    "ORIGINAL",
    "PICTURE",
    "PLATFORM",
    "REPRESENTATION",
    "STRUCTURE",
    "TRANSCRIPT",
    "WORKSPACES",
    "archive_member_content_id",
    "asset_key",
    "content_disposition",
    "content_key",
    "derived_key",
    "export_key",
    "export_operation_id",
    "exports_prefix",
    "file_prefix",
    "new_content_id",
    "source_content_id",
    "workspace_prefix",
]
