"""Canonical independently addressable source resources."""

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .access import AccessPolicy
from .hierarchy import Hierarchy
from .source import SourceIdentity
from .storage import StorageObject


Metadata = dict[str, str | list[str]]


class CollectionKind(str, Enum):
    SPACE = "space"
    FOLDER = "folder"
    PROJECT = "project"
    CHANNEL = "channel"
    COLLECTION = "collection"
    DATABASE = "database"


class DocumentKind(str, Enum):
    PAGE = "page"
    PDF = "pdf"
    DOCUMENT = "document"
    IMAGE = "image"
    ISSUE = "issue"
    MESSAGE = "message"
    EMAIL = "email"
    NOTE = "note"
    WEB_PAGE = "web_page"
    RECORD = "record"


class Item(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    type: str
    title: str = Field(min_length=1)
    source: SourceIdentity
    hierarchy: Hierarchy = Field(default_factory=Hierarchy)
    access: AccessPolicy = Field(default_factory=AccessPolicy)
    metadata: Metadata = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CollectionItem(Item):
    type: Literal["collection"] = "collection"
    collection_kind: CollectionKind


class DocumentItem(Item):
    """A document's envelope; its content is the Structured Document of its original."""

    type: Literal["document"] = "document"
    document_kind: DocumentKind
    original: StorageObject | None = None


class SlimItem(BaseModel):
    """Minimal item reference used by permission synchronisation."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    permission_data: dict[str, Any] | None = None


class ItemFailure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(min_length=1)
    item_url: str | None = None


class ConnectorFailure(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid")

    failed_item: ItemFailure | None = None
    failure_message: str = Field(min_length=1)
    exception: Exception | None = None


AnyItem = Annotated[
    CollectionItem | DocumentItem,
    Field(discriminator="type"),
]
