"""Resource shares: every URL the platform hands out (``database_architecture.md``
"Resource shares").

A ``share`` points at one item, space or conversation and grants nothing (a
conversation share is what lets its audience read the live conversation); an
``invite`` carries the role it grants at the workspace, a space or a
Collection. Only the SHA-256 of an invite's secret token is stored.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from bomesh.db.models.base import (
    Base,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    one_of,
    timestamp,
    uuid_array,
    uuid_fk,
)

SHARE_KINDS = ("share", "invite")
SHARE_AUDIENCES = ("workspace", "people", "anyone")
_TARGETS = "item_id, space_id, conversation_id"


class ResourceShare(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A share or invite URL; DeleteShare sets ``revoked_at`` (never undone)."""

    __tablename__ = "resource_shares"
    __table_args__ = (
        Index(None, "tenant_id", "created_by_user_id", "created_at"),
        Index(None, "item_id", postgresql_where=text("item_id IS NOT NULL")),
        Index(None, "space_id", postgresql_where=text("space_id IS NOT NULL")),
        Index(None, "conversation_id", postgresql_where=text("conversation_id IS NOT NULL")),
        Index(None, "recipient_user_ids", postgresql_using="gin"),
        Index(
            "uq_resource_shares_token_hash",
            "token_hash",
            unique=True,
            postgresql_where=text("token_hash IS NOT NULL"),
        ),
        CheckConstraint(one_of("kind", SHARE_KINDS), name="resource_share_kind_is_valid"),
        CheckConstraint(
            one_of("audience", SHARE_AUDIENCES), name="resource_share_audience_is_valid"
        ),
        CheckConstraint(
            f"num_nonnulls({_TARGETS}) <= 1", name="resource_share_has_one_target"
        ),
        CheckConstraint(
            f"kind = 'invite' OR num_nonnulls({_TARGETS}) = 1",
            name="share_names_its_target",
        ),
        CheckConstraint(
            "kind = 'share' OR conversation_id IS NULL",
            name="invite_never_targets_a_conversation",
        ),
        CheckConstraint(
            "(kind = 'invite') = (role_id IS NOT NULL)"
            " AND (kind = 'invite') = (token_hash IS NOT NULL)",
            name="invite_carries_role_and_token",
        ),
        CheckConstraint(
            "(kind = 'invite') = (audience = 'anyone')", name="invite_audience_is_anyone"
        ),
        CheckConstraint(
            "(audience = 'people') = (cardinality(recipient_user_ids) > 0)",
            name="people_audience_names_recipients",
        ),
        CheckConstraint(
            "max_uses IS NULL OR (kind = 'invite' AND max_uses >= 1)",
            name="max_uses_bounds_invites",
        ),
        CheckConstraint(
            "use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses)",
            name="use_count_within_max_uses",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    item_id: Mapped[UUID | None] = uuid_fk("items.id")
    space_id: Mapped[UUID | None] = uuid_fk("spaces.id")
    conversation_id: Mapped[UUID | None] = uuid_fk("conversations.id")
    role_id: Mapped[UUID | None] = uuid_fk("roles.id")
    audience: Mapped[str] = mapped_column(String(16), nullable=False)
    recipient_user_ids: Mapped[list[UUID]] = uuid_array()
    token_hash: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime | None] = timestamp()
    max_uses: Mapped[int | None] = mapped_column(Integer)
    use_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    created_by_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    last_used_at: Mapped[datetime | None] = timestamp()
    revoked_at: Mapped[datetime | None] = timestamp()


__all__ = ["SHARE_AUDIENCES", "SHARE_KINDS", "ResourceShare"]
