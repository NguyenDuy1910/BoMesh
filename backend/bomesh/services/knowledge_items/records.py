"""Typed results of the Knowledge item use cases; the API maps them to messages.

Enum-valued fields already carry the contract's values (``ACTIVE``,
``AVAILABLE``, ``SUCCEEDED`` …): the storage values never leave this package.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID


@dataclass(frozen=True, slots=True)
class Ancestor:
    item_id: UUID
    display_name: str


@dataclass(frozen=True, slots=True)
class CollectionFacet:
    kind: str
    owner_id: UUID | None
    owner_summary: str | None
    description: str | None
    inherit_access: bool
    discoverable: bool
    accepts_contributions: bool
    #: The space's resource name (``workspaces/{workspace}/spaces/{space}``).
    space: str | None
    child_count: int | None
    document_count: int | None
    link_count: int | None


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
class DocumentFacet:
    file_name: str | None
    mime_type: str | None
    size_bytes: int | None
    purpose: str
    document_type: str | None
    topics: tuple[str, ...]
    summary: str | None
    language_code: str | None
    owner_id: UUID | None
    content_state: str
    publication_state: str
    indexing_state: str
    revision: int | None
    indexed_revision: int | None
    verification: Verification
    origin: Origin | None
    merged_into: UUID | None
    upload_uri: str | None
    thumbnail_uri: str | None
    editor: bool


@dataclass(frozen=True, slots=True)
class ItemRecord:
    """One Item as the caller may see it; ``access`` LOCKED carries only the locked fields."""

    workspace_id: UUID
    item_id: UUID
    item_type: str
    display_name: str
    parent_id: UUID | None
    parent_relation: str | None
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
class BoundingBox:
    page_number: int
    left: float
    top: float
    width: float
    height: float


@dataclass(frozen=True, slots=True)
class PassageRecord:
    workspace_id: UUID
    item_id: UUID
    chunk_id: str
    text: str
    page_number: int | None
    bounding_boxes: tuple[BoundingBox, ...]
    element_ids: tuple[str, ...]
    page_asset_uri: str | None
    revision: int | None


@dataclass(frozen=True, slots=True)
class ContentElement:
    element_id: str
    kind: str
    text: str
    level: int | None
    page_number: int | None
    chunk_id: str | None


@dataclass(frozen=True, slots=True)
class PageAsset:
    page_number: int | None
    image_uri: str
    width_pixels: int
    height_pixels: int


@dataclass(frozen=True, slots=True)
class Rendition:
    uri: str
    version: int
    size_bytes: int
    block_count: int
    truncated: bool


@dataclass(frozen=True, slots=True)
class ContentRecord:
    workspace_id: UUID
    item_id: UUID
    revision: int
    elements: tuple[ContentElement, ...]
    page_assets: tuple[PageAsset, ...]
    rendition: Rendition | None


@dataclass(frozen=True, slots=True)
class LinkRecord:
    workspace_id: UUID
    collection_id: UUID
    target_id: UUID
    resolved_target_id: UUID
    merged_from: UUID | None
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
class SearchPassage:
    chunk_id: str
    text: str
    page_number: int | None
    score: float | None


@dataclass(frozen=True, slots=True)
class SearchResult:
    item: ItemRecord
    score: float | None
    snippets: tuple[str, ...] = ()
    passages: tuple[SearchPassage, ...] = ()


@dataclass(frozen=True, slots=True)
class FacetValue:
    """``value`` is the raw key: an item or member ID, a topic or source code, or a literal."""

    value: str
    display_name: str | None
    document_count: int


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
    #: ``collection.space`` as given: a space name, resolved by the service.
    space: str | None = None
    inherit_access: bool | None = None


@dataclass(frozen=True, slots=True)
class NewDocument:
    mime_type: str | None = None
    file_name: str | None = None
    size_bytes: int | None = None
    purpose: str = "knowledge"
    document_type: str | None = None
    summary: str | None = None
    language_code: str | None = None
    owner_id: UUID | None = None
    topics: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class NewItem:
    """CreateItem input with names already resolved to IDs of this workspace."""

    item_type: str
    display_name: str
    parent_id: UUID | None
    collection: NewCollection | None = None
    document: NewDocument | None = None

    def fingerprint(self) -> Mapping[str, Any]:
        """What makes two CreateItem requests the same (``requestId``)."""
        return {
            "itemType": self.item_type,
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
    """The ``file`` part of CreateItemMedia."""

    data: bytes
    file_name: str | None
    content_type: str | None


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
    passages: int = 0
    referenced_items: frozenset[UUID] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class FacetRequest:
    field: str
    where: Any
    limit: int


__all__ = [
    "Ancestor",
    "BoundingBox",
    "CollectionFacet",
    "ContentElement",
    "ContentRecord",
    "DocumentFacet",
    "Facet",
    "FacetRequest",
    "FacetValue",
    "ItemPage",
    "ItemRecord",
    "LinkRecord",
    "NewCollection",
    "NewDocument",
    "NewItem",
    "Origin",
    "PageAsset",
    "PassageRecord",
    "PolicyRecord",
    "Rendition",
    "RevisionRecord",
    "SearchPage",
    "SearchPassage",
    "SearchRequest",
    "SearchResult",
    "UploadedFile",
    "Verification",
]
