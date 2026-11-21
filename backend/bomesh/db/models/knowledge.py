"""The unified Item tree, its revisions, curation and references."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    case,
    func,
    null,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import (
    Mapped,
    column_property,
    mapped_column,
    relationship,
    validates,
)

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    created_now,
    json_array,
    json_object,
    one_of,
    text_array,
    timestamp,
    uuid_array,
    uuid_fk,
)

#: Structural kind (``items.item_kind``): decides containment and content.
ITEM_KINDS = ("collection", "document")
#: ``items.item_type`` of a Collection (a Document's is its file class).
COLLECTION_TYPES = ("standard", "personal", "conversation_artifacts")
#: ``Document.contentState`` (derived, never stored; :attr:`Item.content_state`).
CONTENT_STATES = ("pending", "available", "failed")
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
TOPIC_CORRECTION_CHANGE_TYPES = ("removed", "added")
#: Why a Document exists (``items.purpose``).
DOCUMENT_PURPOSES = ("knowledge", "conversation_attachment")


class Item(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One Collection or Document of the unified Item tree.

    ``item_kind`` is the structure (collection | document); ``item_type`` the
    immutable classification within it (a collection's standard | personal |
    conversation_artifacts, a document's file class derived from its content,
    :mod:`bomesh.services.knowledge_items.file_types`). A kind's columns are
    NULL on the other kind. Content (:attr:`content_state`, derived),
    publication, indexing and deletion (``deleted_at``) are independent.
    Cross-row tree rules live in ``triggers``. A Document's indexing state
    lives in :class:`ItemIndexState`, so processing never writes this row
    (nor its ``updated_at`` / etag); ``index_status``, ``processed_version``
    and ``indexed_revision_number`` are read-only views of it. Nothing about a
    Document's content is stored here: the revision ``current_revision_id``
    names holds it (and, before it exists, the upload ledger); :attr:`content`
    reads whichever applies. No row stores an object key
    (``bomesh.storage.keys``).
    """

    __tablename__ = "items"
    __table_args__ = (
        Index(None, "tenant_id"),
        Index(None, "parent_item_id"),
        Index(
            "ix_items_live_children",
            "tenant_id",
            "parent_item_id",
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(None, "tenant_id", "item_kind", "item_type"),
        Index(None, "owner_user_id", postgresql_where=text("owner_user_id IS NOT NULL")),
        Index(
            None,
            "current_revision_id",
            unique=True,
            postgresql_where=text("current_revision_id IS NOT NULL"),
        ),
        CheckConstraint(one_of("item_kind", ITEM_KINDS), name="item_kind_is_valid"),
        CheckConstraint("item_type ~ '^[a-z][a-z0-9_]{0,63}$'", name="item_type_is_valid"),
        CheckConstraint(
            f"item_kind <> 'collection' OR {one_of('item_type', COLLECTION_TYPES)}",
            name="collection_type_is_valid",
        ),
        CheckConstraint(
            "parent_item_id IS NULL OR parent_item_id <> id",
            name="item_cannot_parent_itself",
        ),
        CheckConstraint(
            "(item_kind = 'collection') = (inherit_access IS NOT NULL)"
            " AND (item_kind = 'collection') = (discoverable IS NOT NULL)"
            " AND (item_kind = 'collection') = (accepts_contributions IS NOT NULL)",
            name="collection_attributes_match_kind",
        ),
        CheckConstraint(
            "item_kind <> 'collection' OR item_type = 'standard'"
            " OR (NOT discoverable AND NOT accepts_contributions)",
            name="system_collection_is_closed",
        ),
        CheckConstraint(
            "(item_kind = 'document') = (purpose IS NOT NULL)"
            " AND (item_kind = 'document') = (is_published IS NOT NULL)",
            name="document_attributes_match_kind",
        ),
        CheckConstraint(
            one_of("purpose", DOCUMENT_PURPOSES, nullable=True), name="item_purpose_is_valid"
        ),
        CheckConstraint(
            "item_kind = 'document' OR num_nonnulls(current_revision_id, language_code,"
            " owner_user_id, verified_by_user_id, verified_at, next_review_at) = 0",
            name="document_only_attributes",
        ),
        CheckConstraint(
            "(verified_at IS NULL) = (verified_by_user_id IS NULL)",
            name="verification_is_complete",
        ),
        CheckConstraint(
            "next_review_at IS NULL OR verified_at IS NOT NULL",
            name="review_requires_verification",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    item_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    item_type: Mapped[str] = mapped_column(String(64), nullable=False)
    #: API ``displayName``.
    item_name: Mapped[str] = mapped_column(Text, nullable=False)
    #: ``collection.description`` / ``document.summary``.
    description: Mapped[str | None] = mapped_column(Text)
    parent_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    #: The tombstone; a subtree delete stamps one value on the whole cohort.
    deleted_at: Mapped[datetime | None] = timestamp()
    #: Collections only (NOT NULL there): false = an access boundary.
    inherit_access: Mapped[bool | None] = mapped_column(Boolean)
    #: Collections only: listed LOCKED to members who cannot read it.
    discoverable: Mapped[bool | None] = mapped_column(Boolean)
    #: Collections only: members may propose documents into it.
    accepts_contributions: Mapped[bool | None] = mapped_column(Boolean)
    #: Documents only (NOT NULL there): knowledge | conversation_attachment.
    purpose: Mapped[str | None] = mapped_column(String(32))
    #: Documents only (NOT NULL there): whether readers without edit rights see it.
    is_published: Mapped[bool | None] = mapped_column(Boolean)
    #: Documents only: the newest live revision, which the Document shows
    #: (a deferred trigger keeps it so).
    current_revision_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(
            "item_revisions.id",
            use_alter=True,
            name="fk_items_current_revision_id_item_revisions",
        ),
    )
    #: Documents only: language and the accountable owner.
    language_code: Mapped[str | None] = mapped_column(String(16))
    owner_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    #: Documents only: the last verification (verified iff ``verified_at`` is set)
    #: and when it is due again.
    verified_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    verified_at: Mapped[datetime | None] = timestamp()
    next_review_at: Mapped[datetime | None] = timestamp()
    if TYPE_CHECKING:
        content_state: Mapped[str | None]
        index_status: Mapped[str | None]
        processed_version: Mapped[str | None]
        indexed_revision_number: Mapped[int | None]
        content_id: Mapped[UUID | None]
        mime_type: Mapped[str | None]
        size_bytes: Mapped[int | None]
        file_name: Mapped[str | None]
        cover: Mapped[JsonObject | None]

    #: Never loaded implicitly; the content views below cover reads.
    upload: Mapped[ItemUpload | None] = relationship(
        back_populates="item",
        foreign_keys="ItemUpload.item_id",
        uselist=False,
        lazy="raise_on_sql",
    )
    #: Never loaded implicitly: load it explicitly where the full row is needed.
    current_revision: Mapped[ItemRevision | None] = relationship(
        foreign_keys=[current_revision_id], lazy="raise_on_sql", post_update=True
    )

    @validates(
        "content_state",
        "index_status",
        "processed_version",
        "indexed_revision_number",
        "content_id",
        "mime_type",
        "size_bytes",
        "file_name",
        "cover",
    )
    def _read_only(self, key: str, value: object) -> object:
        raise AttributeError(f"Item.{key} is read-only; written through ItemService")

    @property
    def content(self) -> ItemContent | None:
        """What the Document shows: its current revision, else a pending upload's promise."""

        if self.content_id is None:
            return None
        return ItemContent(
            content_id=self.content_id,
            mime_type=self.mime_type or "",
            size_bytes=self.size_bytes,
            file_name=self.file_name or "",
        )


@dataclass(frozen=True, slots=True)
class ItemContent:
    """The content a Document shows (its current revision, else a pending upload's promise)."""

    content_id: UUID
    mime_type: str
    size_bytes: int | None
    file_name: str


class ItemIndexState(Base):
    """The indexing state of one Document (1:1, created by a trigger with the Document).

    Kept off ``items`` because the ingestion pipeline and the payload sync
    write it several times per run; ``items`` changes only with what people do.
    """

    __tablename__ = "item_index_states"
    __table_args__ = (
        Index(None, "payload_dirty_at", postgresql_where=text("payload_dirty_at IS NOT NULL")),
        CheckConstraint(one_of("index_status", INDEX_STATUSES), name="index_status_is_valid"),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    #: Only an Ingestion Run moves a Document past ``pending``.
    index_status: Mapped[str] = choice("pending")
    #: ``processing_version()`` the current index was built with; ready with
    #: a different current version reads as outdated.
    processed_version: Mapped[str | None] = mapped_column(Text)
    indexed_revision_number: Mapped[int | None] = mapped_column(Integer)
    #: Set with a move, (un)publish or (un)delete; cleared once the Qdrant
    #: payload has been re-applied.
    payload_dirty_at: Mapped[datetime | None] = timestamp()


def _index_view(column: Any) -> Any:
    """A read-only ``Item`` attribute over its :class:`ItemIndexState` (NULL for collections).

    Flushing the ``items`` row never changes it, so it is not expired on flush
    (``ItemService.set_index_state`` keeps loaded values current).
    """
    return column_property(
        select(column)
        .where(ItemIndexState.item_id == Item.__table__.c.id)
        .correlate_except(ItemIndexState)
        .scalar_subquery(),
        expire_on_flush=False,
    )


Item.index_status = _index_view(ItemIndexState.index_status)  # type: ignore[misc]
Item.processed_version = _index_view(ItemIndexState.processed_version)  # type: ignore[misc]
Item.indexed_revision_number = _index_view(ItemIndexState.indexed_revision_number)  # type: ignore[misc]


class ItemRevision(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """One immutable content version of a Document Item; append-only.

    ``content_id`` is the identity of the bytes (``bomesh.storage.keys``): a
    revision that shows existing bytes copies it, so objects are never copied.
    """

    __tablename__ = "item_revisions"
    __table_args__ = (
        UniqueConstraint("item_id", "revision_number"),
        Index(None, "content_id"),
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
    content_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    contribution_id: Mapped[UUID | None] = uuid_fk("contributions.id")
    external_version: Mapped[str | None] = mapped_column(Text)
    restored_from: Mapped[int | None] = mapped_column(Integer)
    author: Mapped[str | None] = mapped_column(String(16))
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    exports: Mapped[JsonObject] = json_object()
    deleted_at: Mapped[datetime | None] = timestamp()


class ItemUpload(TimestampMixin, Base):
    """Private upload ledger of one Document; never exposed.

    Holds what the upload promised (``content_id`` reserved for its key,
    declared type, size and name) until completion records revision 1, and
    where the bytes came from when they were extracted from an archive.
    """

    __tablename__ = "item_uploads"
    __table_args__ = (
        Index(None, "tenant_id", "owner_user_id", "status"),
        Index(None, "archive_item_id", postgresql_where=text("archive_item_id IS NOT NULL")),
        CheckConstraint(one_of("status", UPLOAD_STATUSES), name="item_upload_status_is_valid"),
        CheckConstraint(
            "size_bytes IS NULL OR size_bytes >= 0", name="item_upload_size_is_valid"
        ),
        CheckConstraint(
            "(archive_item_id IS NULL) = (archive_path IS NULL)",
            name="item_upload_archive_member_is_complete",
        ),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    owner_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    content_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = choice("pending")
    error_code: Mapped[str | None] = mapped_column(String(128))
    #: The archive Document these bytes were extracted from and the member path.
    archive_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    archive_path: Mapped[str | None] = mapped_column(Text)
    uploaded_at: Mapped[datetime | None] = timestamp()

    item: Mapped[Item] = relationship(back_populates="upload", foreign_keys=[item_id])


def _content_view(revision_column: Any, upload_column: Any) -> Any:
    """A read-only ``Item`` attribute: the current revision's value, else the upload's.

    Correlated scalar subqueries keep a page of Items one statement; not
    expired on flush (``ItemService`` keeps loaded values current).
    """
    items = Item.__table__.c
    return column_property(
        func.coalesce(
            select(revision_column)
            .where(ItemRevision.id == items.current_revision_id)
            .correlate_except(ItemRevision)
            .scalar_subquery(),
            select(upload_column)
            .where(ItemUpload.item_id == items.id)
            .correlate_except(ItemUpload)
            .scalar_subquery(),
        ),
        expire_on_flush=False,
    )


Item.content_id = _content_view(ItemRevision.content_id, ItemUpload.content_id)  # type: ignore[misc]
Item.mime_type = _content_view(ItemRevision.mime_type, ItemUpload.mime_type)  # type: ignore[misc]
Item.size_bytes = _content_view(ItemRevision.size_bytes, ItemUpload.size_bytes)  # type: ignore[misc]
Item.file_name = _content_view(ItemRevision.file_name, ItemUpload.file_name)  # type: ignore[misc]
#: The current revision's ``exports.cover`` (None when it has none).
Item.cover = column_property(  # type: ignore[misc]
    select(ItemRevision.__table__.c.exports["cover"])
    .where(ItemRevision.id == Item.__table__.c.current_revision_id)
    .correlate_except(ItemRevision)
    .scalar_subquery(),
    expire_on_flush=False,
)
#: ``Document.contentState``, derived and never stored: ``available`` with a
#: current revision, else ``failed`` when the upload failed, else ``pending``;
#: NULL for collections. ``ItemService`` keeps loaded values current.
Item.content_state = column_property(  # type: ignore[misc]
    case(
        (Item.__table__.c.item_kind != "document", null()),
        (Item.__table__.c.current_revision_id.is_not(None), "available"),
        (
            select(ItemUpload.item_id)
            .where(ItemUpload.item_id == Item.__table__.c.id, ItemUpload.status == "failed")
            .correlate_except(ItemUpload)
            .exists(),
            "failed",
        ),
        else_="pending",
    ),
    expire_on_flush=False,
)


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
    topic_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str | None] = mapped_column(String(64))
    color: Mapped[str | None] = mapped_column(String(32))
    keywords: Mapped[list[str]] = text_array()
    synonyms: Mapped[list[str]] = text_array()
    guidance: Mapped[str | None] = mapped_column(Text)
    example_item_ids: Mapped[list[UUID]] = uuid_array()
    rule_collection_ids: Mapped[list[UUID]] = uuid_array()
    rule_source_codes: Mapped[list[str]] = text_array()
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


class TopicCorrection(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A person's change of a Document's topics away from the assistant's.

    OPEN while ``dismissed_at`` is null; the changed topics are
    :class:`TopicCorrectionChange` rows (at least one, checked at commit).
    """

    __tablename__ = "topic_corrections"
    __table_args__ = (
        Index(
            None, "tenant_id", "created_at", postgresql_where=text("dismissed_at IS NULL")
        ),
        Index(None, "item_id"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    #: Historical: never re-pointed by MergeItem.
    item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    actor_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    dismissed_at: Mapped[datetime | None] = timestamp()


class TopicCorrectionChange(Base):
    """One topic a correction removed (``fromTopics``) or added (``toTopics``)."""

    __tablename__ = "topic_correction_changes"
    __table_args__ = (
        Index(None, "topic_id", "change_type", "topic_correction_id"),
        CheckConstraint(
            one_of("change_type", TOPIC_CORRECTION_CHANGE_TYPES),
            name="topic_correction_change_type_is_valid",
        ),
    )

    topic_correction_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("topic_corrections.id", ondelete="CASCADE"),
        primary_key=True,
    )
    topic_id: Mapped[UUID] = uuid_fk("topics.id", primary_key=True)
    change_type: Mapped[str] = mapped_column(String(16), nullable=False)


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


class ItemShortcut(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A shortcut of a Document inside another Collection; never a grant."""

    __tablename__ = "item_shortcuts"
    __table_args__ = (
        Index(
            "uq_item_shortcuts_live_collection_target",
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
