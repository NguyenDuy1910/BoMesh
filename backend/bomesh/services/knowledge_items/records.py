"""Typed results of the Knowledge item use cases; the API maps them to messages.

Enum-valued fields already carry the contract's values (``ACTIVE``,
``AVAILABLE``, ``SUCCEEDED`` …): the storage values never leave this package.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from bomesh.document_structure import CitationTarget, ContentNode

if TYPE_CHECKING:
    from bomesh.services.previews.engine import PreviewFile, Representation


@dataclass(frozen=True, slots=True)
class Ancestor:
    item_id: UUID
    display_name: str


@dataclass(frozen=True, slots=True)
class CollectionFacet:
    owner_id: UUID | None
    owner_summary: str | None
    description: str | None
    inherit_access: bool
    discoverable: bool
    accepts_contributions: bool
    child_count: int | None
    document_count: int | None
    shortcut_count: int | None


@dataclass(frozen=True, slots=True)
class Verification:
    state: str
    verifier_id: UUID | None = None
    verify_time: datetime | None = None
    next_review_time: datetime | None = None


@dataclass(frozen=True, slots=True)
class Origin:
    #: The source's API ID (``code``).
    source_code: str | None
    external_uri: str | None
    path: str | None
    source_update_time: datetime | None


@dataclass(frozen=True, slots=True)
class Cover:
    """``DocumentCover``: what the current revision's first page looks like."""

    #: ``PAGE``, ``SLIDE``, ``SHEET``, ``TEXT`` or ``IMAGE``.
    kind: str
    image_uri: str | None = None
    width_pixels: int | None = None
    height_pixels: int | None = None
    title: str | None = None
    lines: tuple[str, ...] = ()
    cells: tuple[tuple[str, ...], ...] = ()


@dataclass(frozen=True, slots=True)
class DocumentFacet:
    file_name: str | None
    mime_type: str | None
    size_bytes: int | None
    purpose: str
    topics: tuple[str, ...]
    #: The subset of ``topics`` the assistant applied (``item_topics.created_by_user_id`` NULL).
    assistant_topics: tuple[str, ...]
    #: ``items.description``.
    summary: str | None
    language_code: str | None
    owner_id: UUID | None
    content_state: str
    publication_state: str
    #: ``PERSONAL`` in a member's My files (their private scope), else ``STANDARD``.
    collection_kind: str
    indexing_state: str
    revision: int | None
    indexed_revision: int | None
    verification: Verification
    origin: Origin | None
    upload_uri: str | None
    cover: Cover | None
    editor: bool
    #: The run of the document's latest ingestion task (``lastIngestionRun``).
    last_run_id: UUID | None = None
    #: That task's user-safe ``google.rpc.Status`` while the document is FAILED (``indexingError``).
    indexing_error: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ItemRecord:
    """One Item as the caller may see it; ``access`` LOCKED carries only the locked fields."""

    workspace_id: UUID
    item_id: UUID
    #: ``items.item_kind``: collection | document.
    item_kind: str
    #: ``items.item_type``: the classification within the kind.
    item_type: str
    display_name: str
    parent_id: UUID | None
    access: str | None
    state: str
    creator_id: UUID | None
    create_time: datetime
    update_time: datetime
    delete_time: datetime | None
    purge_time: datetime | None
    ancestors: tuple[Ancestor, ...] | None = None
    collection: CollectionFacet | None = None
    document: DocumentFacet | None = None


@dataclass(frozen=True, slots=True)
class ItemPage:
    items: Sequence[ItemRecord]
    total_size: int


@dataclass(frozen=True, slots=True)
class RevisionRecord:
    workspace_id: UUID
    item_id: UUID
    number: int
    create_time: datetime
    mime_type: str
    size_bytes: int
    change_summary: str | None
    contribution_id: UUID | None
    creator_id: UUID | None
    external_version: str | None
    restored_from: int | None


@dataclass(frozen=True, slots=True)
class SignedPicture:
    """A picture of a Structured Document, signed for the reader."""

    uri: str
    expire_time: datetime


@dataclass(frozen=True, slots=True)
class ContentRecord:
    """``ItemContent``: a window (or the outline) of one revision's Structured Document."""

    workspace_id: UUID
    item_id: UUID
    revision: int
    structure_version: str
    total_nodes: int
    start_index: int
    nodes: tuple[ContentNode, ...]
    #: Picture name → its signed object; a node's image is shown only when signed.
    pictures: Mapping[str, SignedPicture]
    #: Whether node pages are the pages the Original preview shows.
    page_numbers: bool
    previous_page_token: str | None
    next_page_token: str | None
    etag: str


@dataclass(frozen=True, slots=True)
class PreviewRecord:
    """``ItemPreview``: how a viewer shows one revision's own file."""

    workspace_id: UUID
    item_id: UUID
    revision: int
    #: ``READY``, ``PREPARING`` or ``UNAVAILABLE``.
    state: str
    #: ``FORMAT_NOT_SUPPORTED``, ``TOO_LARGE`` or ``CONVERSION_FAILED`` when UNAVAILABLE.
    unavailable_reason: str | None
    representation: Representation | None
    original: PreviewFile


@dataclass(frozen=True, slots=True)
class ShortcutRecord:
    workspace_id: UUID
    collection_id: UUID
    target_id: UUID
    target_display_name: str | None
    creator_id: UUID | None
    create_time: datetime
    update_time: datetime
    delete_time: datetime | None


@dataclass(frozen=True, slots=True)
class PolicyRecord:
    bindings: tuple[tuple[str, tuple[str, ...]], ...]
    etag: str
    version: int


@dataclass(frozen=True, slots=True)
class SearchReference:
    """Where a search hit is in its document: the matched chunk's nodes."""

    target: CitationTarget
    score: float | None


@dataclass(frozen=True, slots=True)
class SearchResult:
    item: ItemRecord
    score: float | None
    snippets: tuple[str, ...] = ()
    references: tuple[SearchReference, ...] = ()


@dataclass(frozen=True, slots=True)
class Interval:
    """An interval facet bucket: inclusive bounds, ``None`` = unbounded."""

    minimum: datetime | None
    maximum: datetime | None


@dataclass(frozen=True, slots=True)
class FacetValue:
    """``value`` is the raw key: an item or member ID, a topic or source code, or a
    literal; interval facets carry ``interval`` instead (``value`` is ``None``)."""

    value: str | None
    display_name: str | None
    document_count: int
    interval: Interval | None = None


@dataclass(frozen=True, slots=True)
class Facet:
    field: str
    values: tuple[FacetValue, ...]


@dataclass(frozen=True, slots=True)
class SearchPage:
    results: Sequence[SearchResult]
    facets: Sequence[Facet]
    total_size: int


@dataclass(frozen=True, slots=True)
class NewCollection:
    description: str | None = None
    discoverable: bool | None = None
    accepts_contributions: bool | None = None
    inherit_access: bool | None = None


@dataclass(frozen=True, slots=True)
class NewDocument:
    mime_type: str | None = None
    file_name: str | None = None
    size_bytes: int | None = None
    purpose: str = "knowledge"
    summary: str | None = None
    language_code: str | None = None
    owner_id: UUID | None = None
    topics: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class NewItem:
    """CreateItem input with names already resolved to IDs of this workspace."""

    item_kind: str
    display_name: str
    parent_id: UUID | None
    collection: NewCollection | None = None
    document: NewDocument | None = None

    def fingerprint(self) -> Mapping[str, Any]:
        """What makes two CreateItem requests the same (``requestId``)."""
        return {
            "itemKind": self.item_kind,
            "displayName": self.display_name,
            "parent": str(self.parent_id or ""),
            "collection": _plain(self.collection),
            "document": _plain(self.document),
        }


def _plain(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        name: str(getattr(value, name)) if getattr(value, name) is not None else None
        for name in value.__dataclass_fields__  # type: ignore[attr-defined]
    }


@dataclass(frozen=True, slots=True)
class UploadedFile:
    """A multipart ``file`` part (CreateItemMedia, UploadMapBackground)."""

    data: bytes
    file_name: str | None
    content_type: str | None


@dataclass(frozen=True, slots=True)
class CollectionImportRow:
    """One ImportCollections row: display names from the import's collection down
    to a folder (untrimmed, as sent) and the description of a folder it creates."""

    path: tuple[str, ...]
    description: str | None = None


@dataclass(frozen=True, slots=True)
class CollectionImportChange:
    """A folder an import creates: ``item_id`` ``None`` with ``validateOnly``, ``path``
    the trimmed display names from the import's collection down to it, ``row`` the
    1-based row naming it (``None`` for an intermediate folder no row names)."""

    item_id: UUID | None
    path: tuple[str, ...]
    row: int | None = None


@dataclass(frozen=True, slots=True)
class CollectionImportResult:
    created: tuple[CollectionImportChange, ...]
    unchanged_count: int
    #: ``(1-based row, reason)``.
    skipped: tuple[tuple[int, str], ...]


@dataclass(frozen=True, slots=True)
class SearchRequest:
    """SearchItems input: compiled filters stay SQLAlchemy expressions."""

    query: str
    where: Any
    order_by: tuple[Any, ...]
    offset: int
    limit: int
    facets: Sequence[FacetRequest] = ()
    related_item_id: UUID | None = None
    snippets: bool = False
    references: int = 0
    referenced_items: frozenset[UUID] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class FacetRequest:
    field: str
    where: Any
    limit: int
    #: Buckets of an interval facet (``updateTime``); empty for value facets.
    intervals: tuple[Interval, ...] = ()
    #: ``where`` is the search's own filter (not excluded, or nothing to exclude):
    #: the facet counts nothing when the search matches nothing.
    matches_request: bool = False


__all__ = [
    "Ancestor",
    "CollectionFacet",
    "ContentRecord",
    "CollectionImportChange",
    "CollectionImportResult",
    "CollectionImportRow",
    "DocumentFacet",
    "Facet",
    "FacetRequest",
    "FacetValue",
    "Interval",
    "ItemPage",
    "ItemRecord",
    "NewCollection",
    "NewDocument",
    "NewItem",
    "Origin",
    "PolicyRecord",
    "PreviewRecord",
    "RevisionRecord",
    "SearchPage",
    "SearchReference",
    "SearchRequest",
    "SearchResult",
    "ShortcutRecord",
    "SignedPicture",
    "UploadedFile",
    "Verification",
]
