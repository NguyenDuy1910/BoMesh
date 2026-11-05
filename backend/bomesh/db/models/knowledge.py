"""The unified Item tree, its revisions, curation and references."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    created_now,
    flag,
    json_array,
    json_object,
    one_of,
    text_array,
    timestamp,
    uuid_fk,
)

ITEM_TYPES = ("collection", "document")
ITEM_STATUSES = ("pending", "ready", "failed")
PARENT_RELATIONS = ("contains", "child", "attachment")
PUBLICATION_STATES = ("published", "unpublished")
INDEX_STATUSES = ("pending", "processing", "ready", "failed", "unsupported")
REVISION_AUTHORS = ("assistant", "user")
UPLOAD_STATUSES = ("pending", "available", "failed")
CONTRIBUTION_KINDS = ("new_document", "new_revision")
CONTRIBUTION_ORIGINS = ("member", "source")
CONTRIBUTION_STATES = (
    "analyzing",
    "in_review",
    "changes_requested",
    "approved",
    "rejected",
    "withdrawn",
)
OPEN_CONTRIBUTION_STATES = ("analyzing", "in_review", "changes_requested")
TOPIC_KINDS = ("domain", "topic")
TOPIC_STATES = ("proposed", "active", "rejected")
CONTRIBUTION_TOPIC_RELATIONS = ("suggested", "proposed")
READING_LIST_KINDS = ("standard", "featured")
READING_LIST_AUDIENCES = ("private", "space", "workspace")


class Item(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One Collection or Document of the unified Item tree.

    Content (``status``), publication, indexing and deletion (``deleted_at``)
    are independent. Cross-row tree rules live in ``triggers``.
    """

    __tablename__ = "items"
    __table_args__ = (
        Index(None, "tenant_id"),
        Index(None, "parent_item_id"),
        Index(None, "tenant_id", "status"),
        Index(
            "ix_items_live_children",
            "tenant_id",
            "parent_item_id",
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(None, "space_id", postgresql_where=text("space_id IS NOT NULL")),
        Index(
            None,
            "payload_dirty_at",
            postgresql_where=text("payload_dirty_at IS NOT NULL"),
        ),
        CheckConstraint(one_of("item_type", ITEM_TYPES), name="item_type_is_valid"),
        CheckConstraint(
            "(item_type = 'document') = (document_type IS NOT NULL)",
            name="item_document_type_matches_type",
        ),
        CheckConstraint(
            "item_type = 'collection' OR parent_item_id IS NOT NULL",
            name="document_requires_parent",
        ),
        CheckConstraint(
            "(parent_item_id IS NULL) = (parent_relation IS NULL)",
            name="item_parent_relation_matches_parent",
        ),
        CheckConstraint(
            "parent_item_id IS NULL OR parent_item_id <> id",
            name="item_cannot_parent_itself",
        ),
        CheckConstraint(
            one_of("parent_relation", PARENT_RELATIONS, nullable=True),
            name="item_parent_relation_is_valid",
        ),
        CheckConstraint(one_of("status", ITEM_STATUSES), name="item_status_is_valid"),
        CheckConstraint(
            "item_type = 'document' OR status = 'ready'",
            name="collection_is_ready",
        ),
        CheckConstraint(
            "(item_type = 'document') = (publication_state IS NOT NULL)",
            name="item_publication_matches_type",
        ),
        CheckConstraint(
            one_of("publication_state", PUBLICATION_STATES, nullable=True),
            name="item_publication_state_is_valid",
        ),
        CheckConstraint(
            one_of("index_status", INDEX_STATUSES, nullable=True),
            name="item_index_status_is_valid",
        ),
        CheckConstraint(
            "(item_type = 'document') = (index_status IS NOT NULL)",
            name="item_index_status_matches_type",
        ),
        CheckConstraint(
            "item_type = 'document' OR indexed_revision_number IS NULL",
            name="item_indexed_revision_matches_type",
        ),
        CheckConstraint("size_bytes IS NULL OR size_bytes >= 0", name="item_size_is_valid"),
        # Only a Collection holds grants, so only a Collection may end
        # inheritance; a Document that stopped inheriting would reach nobody.
        CheckConstraint(
            "item_type = 'collection' OR inherit_access",
            name="only_collections_end_inheritance",
        ),
        CheckConstraint(
            "parent_item_id IS NOT NULL OR NOT inherit_access",
            name="root_is_access_boundary",
        ),
        CheckConstraint(
            "space_id IS NULL OR item_type = 'collection'",
            name="only_collections_belong_to_spaces",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    item_type: Mapped[str] = mapped_column(String(16), nullable=False)
    parent_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    parent_relation: Mapped[str | None] = mapped_column(String(32))
    document_type: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(255))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    storage_key: Mapped[str | None] = mapped_column(Text)
    space_id: Mapped[UUID | None] = uuid_fk("spaces.id")
    metadata_: Mapped[JsonObject] = json_object("metadata")
    inherit_access: Mapped[bool] = flag(True)
    status: Mapped[str] = choice("pending")
    publication_state: Mapped[str | None] = mapped_column(String(16))
    #: Only an Ingestion Run moves a Document past ``pending``.
    index_status: Mapped[str | None] = mapped_column(String(16))
    #: ``processing_version()`` the current index was built with; ready with
    #: a different current version reads as outdated.
    processed_version: Mapped[str | None] = mapped_column(Text)
    indexed_revision_number: Mapped[int | None] = mapped_column(Integer)
    #: Set with a move, (un)publish or (un)delete; cleared once the Qdrant
    #: payload has been re-applied.
    payload_dirty_at: Mapped[datetime | None] = timestamp()
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    #: The tombstone; a subtree delete stamps one value on the whole cohort.
    deleted_at: Mapped[datetime | None] = timestamp()

    upload: Mapped[ItemUpload | None] = relationship(back_populates="item", uselist=False)


class ItemRevision(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """One immutable content version of a Document Item; append-only."""

    __tablename__ = "item_revisions"
    __table_args__ = (
        UniqueConstraint("item_id", "revision_number"),
        CheckConstraint("revision_number >= 1", name="revision_number_is_valid"),
        CheckConstraint("size_bytes >= 0", name="revision_size_is_valid"),
        CheckConstraint(
            "restored_from IS NULL OR (restored_from >= 1 AND restored_from < revision_number)",
            name="revision_restored_from_is_valid",
        ),
        CheckConstraint(
            one_of("author", REVISION_AUTHORS, nullable=True),
            name="revision_author_is_valid",
        ),
        CheckConstraint("jsonb_typeof(exports) = 'object'", name="exports_is_object"),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    contribution_id: Mapped[UUID | None] = uuid_fk("contributions.id")
    external_version: Mapped[str | None] = mapped_column(Text)
    restored_from: Mapped[int | None] = mapped_column(Integer)
    author: Mapped[str | None] = mapped_column(String(16))
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    exports: Mapped[JsonObject] = json_object()
    deleted_at: Mapped[datetime | None] = timestamp()


class ItemUpload(TimestampMixin, Base):
    """Private upload ledger of one Document; never exposed."""

    __tablename__ = "item_uploads"
    __table_args__ = (
        Index(None, "tenant_id", "owner_user_id", "status"),
        CheckConstraint(one_of("status", UPLOAD_STATUSES), name="item_upload_status_is_valid"),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    owner_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    status: Mapped[str] = choice("pending")
    error_code: Mapped[str | None] = mapped_column(String(128))
    uploaded_at: Mapped[datetime | None] = timestamp()

    item: Mapped[Item] = relationship(back_populates="upload")


class Contribution(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Review of one candidate Document; never changes who may read anything."""

    __tablename__ = "contributions"
    __table_args__ = (
        Index(None, "tenant_id", "state", "created_at"),
        Index(None, "target_item_id", "state"),
        Index(None, "contributor_user_id", "state"),
        Index(None, "ingestion_source_id", "state"),
        Index(
            "uq_contributions_open_item_id",
            "item_id",
            unique=True,
            postgresql_where=text(
                "state IN ('analyzing', 'in_review', 'changes_requested') "
                "AND deleted_at IS NULL"
            ),
        ),
        CheckConstraint(one_of("kind", CONTRIBUTION_KINDS), name="contribution_kind_is_valid"),
        CheckConstraint(
            one_of("origin", CONTRIBUTION_ORIGINS), name="contribution_origin_is_valid"
        ),
        CheckConstraint(
            one_of("state", CONTRIBUTION_STATES), name="contribution_state_is_valid"
        ),
        CheckConstraint(
            "(origin = 'member') = (contributor_user_id IS NOT NULL)",
            name="member_contribution_names_contributor",
        ),
        CheckConstraint(
            "(origin = 'source') = (ingestion_source_id IS NOT NULL)",
            name="source_contribution_names_source",
        ),
        CheckConstraint(
            "(kind = 'new_revision') = (replaces_item_id IS NOT NULL)",
            name="new_revision_names_replaced_item",
        ),
        CheckConstraint(
            "external_version IS NULL OR (origin = 'source' AND kind = 'new_revision')",
            name="external_version_is_source_revision",
        ),
        CheckConstraint("jsonb_typeof(suggestions) = 'object'", name="suggestions_is_object"),
        CheckConstraint("jsonb_typeof(flags) = 'array'", name="flags_is_array"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    origin: Mapped[str] = mapped_column(String(16), nullable=False)
    target_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    replaces_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    contributor_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    ingestion_source_id: Mapped[UUID | None] = uuid_fk("ingestion_sources.id")
    note: Mapped[str | None] = mapped_column(Text)
    change_summary: Mapped[str | None] = mapped_column(Text)
    external_version: Mapped[str | None] = mapped_column(Text)
    suggestions: Mapped[JsonObject] = json_object()
    flags: Mapped[list[Any]] = json_array()
    state: Mapped[str] = choice("analyzing", 24)
    decided_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    decision_note: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()


class Topic(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The workspace taxonomy: domains and the topics under them."""

    __tablename__ = "topics"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "tenant_id", "state", "kind"),
        Index(None, "parent_topic_id"),
        CheckConstraint(one_of("kind", TOPIC_KINDS), name="topic_kind_is_valid"),
        CheckConstraint(one_of("state", TOPIC_STATES), name="topic_state_is_valid"),
        CheckConstraint(
            "kind = 'topic' OR parent_topic_id IS NULL",
            name="domain_has_no_parent",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    parent_topic_id: Mapped[UUID | None] = uuid_fk("topics.id")
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str | None] = mapped_column(String(64))
    color: Mapped[str | None] = mapped_column(String(32))
    state: Mapped[str] = choice("active")
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()


class ItemTopic(Base):
    """One (Document, topic) tag."""

    __tablename__ = "item_topics"
    __table_args__ = (Index(None, "topic_id", "item_id"),)

    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    topic_id: Mapped[UUID] = uuid_fk("topics.id", primary_key=True)
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    created_at: Mapped[datetime] = created_now()


class ContributionTopic(Base):
    """A topic an analysis suggested (existing) or proposed (new) for a contribution."""

    __tablename__ = "contribution_topics"
    __table_args__ = (
        Index(None, "topic_id", "relation"),
        CheckConstraint(
            one_of("relation", CONTRIBUTION_TOPIC_RELATIONS),
            name="contribution_topic_relation_is_valid",
        ),
    )

    contribution_id: Mapped[UUID] = uuid_fk("contributions.id", primary_key=True)
    topic_id: Mapped[UUID] = uuid_fk("topics.id", primary_key=True)
    relation: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = created_now()


class ReadingList(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Curated, ordered references; never grants access."""

    __tablename__ = "reading_lists"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "tenant_id", "owner_user_id", "deleted_at"),
        Index(None, "tenant_id", "audience"),
        Index(None, "space_id"),
        Index(
            "uq_reading_lists_featured",
            "tenant_id",
            "kind",
            unique=True,
            postgresql_where=text("kind = 'featured'"),
        ),
        CheckConstraint(one_of("kind", READING_LIST_KINDS), name="reading_list_kind_is_valid"),
        CheckConstraint(
            one_of("audience", READING_LIST_AUDIENCES),
            name="reading_list_audience_is_valid",
        ),
        CheckConstraint(
            "(audience = 'space') = (space_id IS NOT NULL)",
            name="space_reading_list_names_space",
        ),
        CheckConstraint(
            "(kind = 'featured') = (code = 'featured')",
            name="featured_code_is_reserved",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    kind: Mapped[str] = choice("standard")
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    audience: Mapped[str] = choice("private")
    space_id: Mapped[UUID | None] = uuid_fk("spaces.id")
    deleted_at: Mapped[datetime | None] = timestamp()


class ReadingListEntry(Base):
    __tablename__ = "reading_list_entries"
    __table_args__ = (
        Index(None, "reading_list_id", "position"),
        Index(None, "item_id"),
        CheckConstraint("position >= 0", name="reading_list_position_is_valid"),
    )

    reading_list_id: Mapped[UUID] = uuid_fk("reading_lists.id", primary_key=True)
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    note: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    added_by_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    created_at: Mapped[datetime] = created_now()


class ItemLink(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A shortcut of a Document inside another Collection; never a grant."""

    __tablename__ = "item_links"
    __table_args__ = (
        Index(
            "uq_item_links_live_collection_target",
            "collection_item_id",
            "target_item_id",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(None, "target_item_id"),
        Index(None, "tenant_id"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    collection_item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    target_item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()


class Citation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Canonical chunk citation geometry for one Document Item."""

    __tablename__ = "citations"
    __table_args__ = (
        UniqueConstraint("item_id", "chunk_id"),
        Index(None, "item_id", "deleted_at"),
        CheckConstraint("page_start IS NULL OR page_start >= 1", name="page_start_is_valid"),
        CheckConstraint("page_end IS NULL OR page_end >= 1", name="page_end_is_valid"),
        CheckConstraint(
            "page_start IS NULL OR page_end IS NULL OR page_end >= page_start",
            name="page_range_is_valid",
        ),
        CheckConstraint("jsonb_typeof(spans) = 'array'", name="spans_is_array"),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    chunk_id: Mapped[str] = mapped_column(Text, nullable=False)
    section_path: Mapped[list[str]] = text_array()
    anchor: Mapped[str | None] = mapped_column(Text)
    page_start: Mapped[int | None] = mapped_column(Integer)
    page_end: Mapped[int | None] = mapped_column(Integer)
    spans: Mapped[list[JsonObject]] = json_array()
    deleted_at: Mapped[datetime | None] = timestamp()
