"""Workspaces (tenants), people, authorization, audit and member state."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    and_,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

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
    updated_now,
    uuid_column,
    uuid_fk,
)

TENANT_TEMPLATES = ("enterprise", "campus")
TENANT_STATUSES = ("creating", "active", "suspended", "archived")
ROLE_SCOPES = ("platform", "tenant", "collection", "space")
MEMBERSHIP_STATUSES = ("active", "suspended")
AUDIT_CATEGORIES = (
    "knowledge",
    "files",
    "sources",
    "people",
    "settings",
    "spaces",
    "requests",
    "sign_in",
)
AUDIT_OUTCOMES = ("succeeded", "failed")
ANSWER_LENGTHS = ("concise", "balanced", "detailed")
GAP_DECISION_STATES = ("dismissed", "resolved")
NOTIFICATION_SUBJECT_TYPES = (
    "item",
    "contribution",
    "request",
    "ingestion_source",
    "integration_connection",
    "space",
)
SAVED_SEARCH_LAYOUTS = ("list", "table", "grid")


class Tenant(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A private workspace; reachable only through memberships and grants."""

    __tablename__ = "tenants"
    __table_args__ = (
        Index(None, "status", "created_at"),
        CheckConstraint(
            one_of("template", TENANT_TEMPLATES), name="tenant_template_is_valid"
        ),
        CheckConstraint(one_of("status", TENANT_STATUSES), name="tenant_status_is_valid"),
    )

    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    template: Mapped[str] = choice("enterprise")
    demo: Mapped[bool] = flag(False)
    status: Mapped[str] = choice("active")
    ingestion_paused_at: Mapped[datetime | None] = timestamp()
    settings: Mapped[JsonObject] = json_object()


class Role(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A named permission bundle: predefined (no tenant) or a tenant custom role."""

    __tablename__ = "roles"
    __table_args__ = (
        # NULLS NOT DISTINCT: a tenant cannot reuse a predefined role code.
        Index(
            "uq_roles_tenant_id_code",
            "tenant_id",
            "code",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
        Index(None, "scope_type"),
        CheckConstraint(one_of("scope_type", ROLE_SCOPES), name="role_scope_type_is_valid"),
        CheckConstraint(
            "is_system = (tenant_id IS NULL)",
            name="role_ownership_matches_system_flag",
        ),
        # Custom roles are tenant roles; they bind at tenant, collection or
        # space scope of their own tenant.
        CheckConstraint(
            "is_system OR scope_type = 'tenant'",
            name="custom_role_is_tenant_scoped",
        ),
        CheckConstraint(
            "deleted_at IS NULL OR NOT is_system",
            name="only_custom_roles_are_deleted",
        ),
    )

    tenant_id: Mapped[UUID | None] = uuid_fk("tenants.id")
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False)
    is_system: Mapped[bool] = flag(False)
    deleted_at: Mapped[datetime | None] = timestamp()


class Permission(CreatedAtMixin, Base):
    """One `x-permission` value of the API catalog."""

    __tablename__ = "permissions"
    __table_args__ = (
        CheckConstraint(
            "scope_types <@ ARRAY['platform', 'tenant', 'collection', 'space']::text[]",
            name="permission_scope_types_are_valid",
        ),
    )

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    scope_types: Mapped[list[str]] = text_array()
    custom_roles_supported: Mapped[bool] = flag(True)


class RolePermission(TimestampMixin, Base):
    """One permission carried by one role; revocation is a tombstone.

    Every read must exclude tombstones, or a revoked capability keeps
    granting; join through :meth:`granted_by`.
    """

    __tablename__ = "role_permissions"

    role_id: Mapped[UUID] = uuid_fk("roles.id", primary_key=True)
    permission_code: Mapped[str] = mapped_column(
        String(64), ForeignKey("permissions.code"), primary_key=True
    )
    deleted_at: Mapped[datetime | None] = timestamp()

    @classmethod
    def granted_by(cls, role_id: Any) -> Any:
        """Join condition that only ever reaches live permission grants."""

        return and_(cls.role_id == role_id, cls.deleted_at.is_(None))


class RoleAssignment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """WHO holds WHICH ROLE at WHICH SCOPE; the only authorization grant.

    Principal (user | group | all_members) and scope (platform | tenant |
    collection | space) are exclusive arcs of real foreign keys. A row with no
    scope column set is a platform grant.
    """

    __tablename__ = "role_assignments"
    __table_args__ = (
        # NULLS NOT DISTINCT makes the unused arc columns compare equal.
        Index(
            "uq_role_assignments_principal_scope_role",
            "user_id",
            "group_id",
            "all_members",
            "tenant_id",
            "item_id",
            "space_id",
            "role_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(None, "user_id", "tenant_id"),
        Index(None, "group_id", "tenant_id"),
        Index(None, "item_id"),
        Index(None, "space_id", "user_id"),
        Index(None, "role_id"),
        CheckConstraint(
            "num_nonnulls(user_id, group_id) + all_members::int = 1",
            name="role_assignment_has_one_principal",
        ),
        CheckConstraint(
            "num_nonnulls(tenant_id, item_id, space_id) <= 1",
            name="role_assignment_has_one_scope",
        ),
        CheckConstraint(
            "NOT all_members OR item_id IS NOT NULL",
            name="all_members_grant_is_collection_scoped",
        ),
        CheckConstraint(
            "space_id IS NULL OR user_id IS NOT NULL",
            name="space_grant_has_user_principal",
        ),
    )

    user_id: Mapped[UUID | None] = uuid_fk("users.id")
    group_id: Mapped[UUID | None] = uuid_fk("groups.id")
    all_members: Mapped[bool] = flag(False)
    role_id: Mapped[UUID] = uuid_fk("roles.id", nullable=False)
    tenant_id: Mapped[UUID | None] = uuid_fk("tenants.id")
    item_id: Mapped[UUID | None] = uuid_fk("items.id")
    space_id: Mapped[UUID | None] = uuid_fk("spaces.id")
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()


class TenantMembership(TimestampMixin, Base):
    """The fact that a user belongs to a tenant; never an authorization grant."""

    __tablename__ = "tenant_memberships"
    __table_args__ = (
        Index(None, "tenant_id", "status"),
        CheckConstraint(
            one_of("status", MEMBERSHIP_STATUSES), name="tenant_membership_status_is_valid"
        ),
    )

    user_id: Mapped[UUID] = uuid_fk("users.id", primary_key=True)
    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", primary_key=True)
    status: Mapped[str] = choice("active")
    joined_at: Mapped[datetime | None] = timestamp()
    last_active_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()


class Group(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "groups"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "tenant_id", "status"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = choice("active")
    deleted_at: Mapped[datetime | None] = timestamp()


class GroupMembership(TimestampMixin, Base):
    __tablename__ = "group_memberships"
    __table_args__ = (
        Index(None, "user_id", "status"),
        Index(None, "group_id", "status"),
    )

    group_id: Mapped[UUID] = uuid_fk("groups.id", primary_key=True)
    user_id: Mapped[UUID] = uuid_fk("users.id", primary_key=True)
    status: Mapped[str] = choice("active")
    joined_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()


class AuditLog(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """One recorded action; append-only. A null tenant is a platform action."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index(None, "tenant_id", "created_at"),
        Index(None, "tenant_id", "category", "created_at"),
        Index(None, "tenant_id", "action", "created_at"),
        Index(None, "actor_user_id", "created_at"),
        Index(None, "actor_session_id", "created_at"),
        Index(None, "target_name", "created_at"),
        Index(None, "created_at"),
        CheckConstraint(
            one_of("category", AUDIT_CATEGORIES), name="audit_category_is_valid"
        ),
        CheckConstraint(one_of("outcome", AUDIT_OUTCOMES), name="audit_outcome_is_valid"),
    )

    tenant_id: Mapped[UUID | None] = uuid_fk("tenants.id")
    actor_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    actor_session_id: Mapped[UUID | None] = uuid_fk("access_sessions.id")
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    action: Mapped[str] = mapped_column(String(96), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_name: Mapped[str | None] = mapped_column(Text)
    outcome: Mapped[str] = choice("succeeded")
    ip_address: Mapped[str | None] = mapped_column(INET)
    details: Mapped[JsonObject] = json_object()


class WorkspaceAssistantSettings(Base):
    """One row per workspace; no row means product defaults."""

    __tablename__ = "workspace_assistant_settings"
    __table_args__ = (
        CheckConstraint(
            "char_length(instructions) <= 2000",
            name="assistant_instructions_length_is_valid",
        ),
        CheckConstraint(
            one_of("answer_length", ANSWER_LENGTHS),
            name="assistant_answer_length_is_valid",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", primary_key=True)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    answer_length: Mapped[str] = choice("balanced")
    capabilities: Mapped[JsonObject] = mapped_column(
        JSONB,
        nullable=False,
        default=lambda: {"web_search": False, "file_work": True, "charts": True},
        server_default=text(
            """'{"web_search": false, "file_work": true, "charts": true}'::jsonb"""
        ),
    )
    welcome_message: Mapped[str] = mapped_column(String(60), nullable=False)
    starter_prompts: Mapped[list[Any]] = json_array()
    updated_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    updated_at: Mapped[datetime] = updated_now()


class KnowledgeGapDecision(Base):
    """An administrator decision on a computed knowledge gap."""

    __tablename__ = "knowledge_gap_decisions"
    __table_args__ = (
        CheckConstraint(
            one_of("state", GAP_DECISION_STATES), name="gap_decision_state_is_valid"
        ),
        CheckConstraint(
            "state = 'resolved' OR resolved_by_item_id IS NULL",
            name="only_resolved_gap_names_an_item",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", primary_key=True)
    gap_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    resolved_by_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    decided_by_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    decided_at: Mapped[datetime] = timestamp(nullable=False)


class Notification(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """One notification of one recipient."""

    __tablename__ = "notifications"
    __table_args__ = (
        Index(None, "recipient_user_id", "tenant_id", "read_at", "created_at"),
        Index(None, "subject_type", "subject_id"),
        CheckConstraint(
            one_of("subject_type", NOTIFICATION_SUBJECT_TYPES, nullable=True),
            name="notification_subject_type_is_valid",
        ),
        CheckConstraint(
            "(subject_type IS NULL) = (subject_id IS NULL)",
            name="notification_subject_is_complete",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    recipient_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    subject_type: Mapped[str | None] = mapped_column(String(32))
    subject_id: Mapped[UUID | None] = uuid_column()
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    read_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()


class SavedItem(Base):
    """A member's saved Item; a reference only."""

    __tablename__ = "saved_items"
    __table_args__ = (
        Index(None, "tenant_id", "user_id", "created_at"),
        Index(None, "item_id"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", primary_key=True)
    user_id: Mapped[UUID] = uuid_fk("users.id", primary_key=True)
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    created_at: Mapped[datetime] = created_now()


class RecentItem(Base):
    """A member's recently opened Item; a reference only."""

    __tablename__ = "recent_items"
    __table_args__ = (
        Index(None, "tenant_id", "user_id", "viewed_at"),
        Index(None, "item_id"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", primary_key=True)
    user_id: Mapped[UUID] = uuid_fk("users.id", primary_key=True)
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    viewed_at: Mapped[datetime] = timestamp(nullable=False)


class SavedSearch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A stored SearchItems request; never stores results."""

    __tablename__ = "saved_searches"
    __table_args__ = (
        Index(None, "tenant_id", "user_id", "display_name"),
        Index(None, "tenant_id", "user_id", "updated_at"),
        CheckConstraint(
            one_of("layout", SAVED_SEARCH_LAYOUTS), name="saved_search_layout_is_valid"
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    query: Mapped[str | None] = mapped_column(Text)
    filter: Mapped[str | None] = mapped_column(Text)
    order_by: Mapped[str | None] = mapped_column(String(255))
    layout: Mapped[str] = choice("list")
