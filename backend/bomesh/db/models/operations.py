"""Long-running operations, requestId idempotency and platform health history."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    UUIDPrimaryKeyMixin,
    one_of,
    timestamp,
    uuid_column,
    uuid_fk,
)

OPERATION_VERBS = (
    "createWorkspace",
    "exportAuditEvents",
    "exportUsage",
    "createArtifact",
    "reviseArtifact",
)
HEALTH_STATUSES = ("healthy", "degraded", "unhealthy", "not_configured")


class RequestIdempotency(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """One successful idempotent write (AIP-155 ``requestId``)."""

    __tablename__ = "request_idempotency"
    __table_args__ = (
        Index(
            "uq_request_idempotency_user_request",
            "user_id",
            "request_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
        Index(None, "expires_at"),
    )

    user_id: Mapped[UUID | None] = uuid_fk("users.id")
    request_id: Mapped[UUID] = uuid_column(nullable=False)
    method: Mapped[str] = mapped_column(String(64), nullable=False)
    parent: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    result_name: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = timestamp(nullable=False)


class Operation(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A google.longrunning.Operation; reads are own-only."""

    __tablename__ = "operations"
    __table_args__ = (
        Index(None, "user_id", "created_at"),
        Index(None, "user_id", "verb", "created_at"),
        Index(None, "user_id", "target"),
        Index(None, "expires_at"),
        CheckConstraint(one_of("verb", OPERATION_VERBS), name="operation_verb_is_valid"),
        CheckConstraint(
            "progress_percent BETWEEN 0 AND 100", name="operation_progress_is_valid"
        ),
    )

    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    tenant_id: Mapped[UUID | None] = uuid_fk("tenants.id")
    verb: Mapped[str] = mapped_column(String(64), nullable=False)
    target: Mapped[str] = mapped_column(Text, nullable=False)
    progress_percent: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0, server_default="0"
    )
    cancel_requested_at: Mapped[datetime | None] = timestamp()
    finished_at: Mapped[datetime | None] = timestamp()
    error: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    result_name: Mapped[str | None] = mapped_column(Text)
    result_object_key: Mapped[str | None] = mapped_column(Text)
    result_expires_at: Mapped[datetime | None] = timestamp()
    expires_at: Mapped[datetime] = timestamp(nullable=False)


class PlatformHealthCheck(UUIDPrimaryKeyMixin, Base):
    """One periodic probe of one service; components and incidents derive from it."""

    __tablename__ = "platform_health_checks"
    __table_args__ = (
        Index(None, "service", "checked_at"),
        CheckConstraint(one_of("status", HEALTH_STATUSES), name="health_status_is_valid"),
    )

    checked_at: Mapped[datetime] = timestamp(nullable=False)
    service: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error_category: Mapped[str | None] = mapped_column(String(64))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
