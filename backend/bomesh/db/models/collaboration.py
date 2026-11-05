"""Spaces and their children, request types, requests and request messages."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    Index,
    Interval,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    flag,
    json_array,
    json_object,
    one_of,
    timestamp,
    uuid_fk,
)

JOIN_POLICIES = ("open", "request", "invite")
REQUEST_KINDS = ("service", "question", "collection_access", "space_membership", "connector")
REQUEST_STATES = ("open", "needs_info", "approved", "denied", "answered", "withdrawn", "closed")


class Space(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A workspace space; membership is space-scoped role assignments."""

    __tablename__ = "spaces"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "tenant_id", "deleted_at"),
        Index(None, "tenant_id", "space_type"),
        CheckConstraint(one_of("join_policy", JOIN_POLICIES), name="space_join_policy_is_valid"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    space_type: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    join_policy: Mapped[str] = choice("invite")
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()


class SpaceMaterial(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A reference from a space to an Item; never grants access."""

    __tablename__ = "space_materials"
    __table_args__ = (
        UniqueConstraint("space_id", "item_id"),
        Index(None, "space_id", "created_at"),
        Index(None, "item_id"),
    )

    space_id: Mapped[UUID] = uuid_fk("spaces.id", nullable=False)
    item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    added_by_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)


class SpaceAnnouncement(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "space_announcements"
    __table_args__ = (Index(None, "space_id", "pinned", "created_at"),)

    space_id: Mapped[UUID] = uuid_fk("spaces.id", nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    pinned: Mapped[bool] = flag(False)
    author_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)


class SpaceEvent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "space_events"
    __table_args__ = (
        Index(None, "space_id", "start_at"),
        CheckConstraint(
            "end_at IS NULL OR end_at >= start_at", name="space_event_end_is_valid"
        ),
    )

    space_id: Mapped[UUID] = uuid_fk("spaces.id", nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    start_at: Mapped[datetime] = timestamp(nullable=False)
    end_at: Mapped[datetime | None] = timestamp()
    location: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")


class RequestType(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The form and eligibility rules of SERVICE requests in a space."""

    __tablename__ = "request_types"
    __table_args__ = (
        UniqueConstraint("space_id", "code"),
        Index(None, "space_id", "deleted_at"),
        CheckConstraint("jsonb_typeof(fields) = 'array'", name="request_type_fields_is_array"),
        CheckConstraint("jsonb_typeof(rules) = 'array'", name="request_type_rules_is_array"),
    )

    space_id: Mapped[UUID] = uuid_fk("spaces.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    fields: Mapped[list[Any]] = json_array()
    rules: Mapped[list[Any]] = json_array()
    sla_duration: Mapped[timedelta | None] = mapped_column(Interval)
    deleted_at: Mapped[datetime | None] = timestamp()
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")


class Request(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Every ask-and-decide flow except contribution review."""

    __tablename__ = "requests"
    __table_args__ = (
        Index(None, "tenant_id", "state", "created_at"),
        Index(None, "tenant_id", "requester_user_id", "state"),
        Index(None, "tenant_id", "assignee_user_id", "state"),
        Index(None, "space_id", "state", "created_at"),
        Index(None, "collection_item_id", "state"),
        Index(None, "connector_key", "state"),
        Index(
            "ix_requests_open_due",
            "tenant_id",
            "due_at",
            postgresql_where=text(
                "state IN ('open', 'needs_info') AND due_at IS NOT NULL"
            ),
        ),
        Index(
            "uq_requests_open_ask",
            "tenant_id",
            "requester_user_id",
            "kind",
            "collection_item_id",
            "space_id",
            "connector_key",
            unique=True,
            postgresql_nulls_not_distinct=True,
            postgresql_where=text(
                "state IN ('open', 'needs_info') AND kind IN "
                "('collection_access', 'space_membership', 'connector')"
            ),
        ),
        CheckConstraint(one_of("kind", REQUEST_KINDS), name="request_kind_is_valid"),
        CheckConstraint(one_of("state", REQUEST_STATES), name="request_state_is_valid"),
        # Exactly the kind-specific references are set.
        CheckConstraint(
            "(kind = 'service' AND request_type_id IS NOT NULL AND space_id IS NOT NULL "
            "AND collection_item_id IS NULL AND connector_key IS NULL "
            "AND requested_role_id IS NULL)"
            " OR (kind = 'question' AND request_type_id IS NULL AND space_id IS NOT NULL "
            "AND collection_item_id IS NULL AND connector_key IS NULL "
            "AND requested_role_id IS NULL)"
            " OR (kind = 'space_membership' AND request_type_id IS NULL "
            "AND space_id IS NOT NULL AND collection_item_id IS NULL "
            "AND connector_key IS NULL AND requested_role_id IS NOT NULL)"
            " OR (kind = 'collection_access' AND request_type_id IS NULL "
            "AND space_id IS NULL AND collection_item_id IS NOT NULL "
            "AND connector_key IS NULL AND requested_role_id IS NOT NULL)"
            " OR (kind = 'connector' AND request_type_id IS NULL AND space_id IS NULL "
            "AND collection_item_id IS NULL AND connector_key IS NOT NULL "
            "AND requested_role_id IS NULL)",
            name="request_references_match_kind",
        ),
        CheckConstraint(
            "granted_role_id IS NULL OR requested_role_id IS NOT NULL",
            name="granted_role_answers_requested_role",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    request_type_id: Mapped[UUID | None] = uuid_fk("request_types.id")
    space_id: Mapped[UUID | None] = uuid_fk("spaces.id")
    collection_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    connector_key: Mapped[str | None] = mapped_column(String(64))
    requested_role_id: Mapped[UUID | None] = uuid_fk("roles.id")
    granted_role_id: Mapped[UUID | None] = uuid_fk("roles.id")
    title: Mapped[str | None] = mapped_column(String(255))
    fields: Mapped[JsonObject] = json_object()
    question: Mapped[str | None] = mapped_column(Text)
    assistant_context: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    eligibility: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    requester_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    assignee_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    state: Mapped[str] = choice("open")
    due_at: Mapped[datetime | None] = timestamp()
    faq_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    decided_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    decided_at: Mapped[datetime | None] = timestamp()
    closed_at: Mapped[datetime | None] = timestamp()


class RequestMessage(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """Append-only message on a request; ``internal`` is staff-only."""

    __tablename__ = "request_messages"
    __table_args__ = (Index(None, "request_id", "created_at"),)

    request_id: Mapped[UUID] = uuid_fk("requests.id", nullable=False)
    author_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    internal: Mapped[bool] = flag(False)
