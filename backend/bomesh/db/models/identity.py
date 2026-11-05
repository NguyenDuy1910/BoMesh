"""Durable human identity, external identities and access sessions."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.orm import Mapped, mapped_column

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    json_object,
    one_of,
    timestamp,
    uuid_fk,
)

USER_STATUSES = ("active", "suspended")
AUTH_IDENTITY_PROTOCOLS = ("oidc", "saml")
AUTH_IDENTITY_STATUSES = ("active", "disabled")
AUTHENTICATION_METHODS = ("password", "oidc", "saml", "internal")
ASSURANCE_LEVELS = ("aal0", "aal1", "aal2")
SESSION_STATUSES = ("active", "superseded", "revoked", "expired")


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Durable human identity; sessions and token state never live here."""

    __tablename__ = "users"

    username: Mapped[str | None] = mapped_column(String(64))
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(256))
    display_name: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = choice("active")
    preferences: Mapped[JsonObject] = json_object()
    last_active_at: Mapped[datetime | None] = timestamp()

    __table_args__ = (
        # Local-login identifiers compare case-insensitively.
        Index(
            "uq_users_username",
            func.lower(username),
            unique=True,
            postgresql_where=username.is_not(None),
        ),
        Index(None, "status", "created_at"),
        Index(None, "last_active_at"),
        CheckConstraint(one_of("status", USER_STATUSES), name="user_status_is_valid"),
    )


class AuthIdentity(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Stable external-provider subject linked to one durable human User."""

    __tablename__ = "auth_identities"
    __table_args__ = (
        UniqueConstraint("issuer", "subject"),
        Index(None, "user_id", "status"),
        Index(None, "provider_key", "status"),
        CheckConstraint(
            one_of("protocol", AUTH_IDENTITY_PROTOCOLS),
            name="auth_identity_protocol_is_valid",
        ),
        CheckConstraint(
            one_of("status", AUTH_IDENTITY_STATUSES),
            name="auth_identity_status_is_valid",
        ),
    )

    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    protocol: Mapped[str] = mapped_column(String(24), nullable=False)
    provider_key: Mapped[str] = mapped_column(String(64), nullable=False)
    issuer: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str | None] = mapped_column(String(255))
    email_verified: Mapped[bool | None] = mapped_column(Boolean)
    status: Mapped[str] = choice("active")
    profile: Mapped[JsonObject] = json_object()
    last_authenticated_at: Mapped[datetime | None] = timestamp()


class AccessSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One revocable authentication context of one User.

    Sessions carry no tenant: every workspace is explicit in the resource name
    and authorized per request. Token rotation creates a child session.
    """

    __tablename__ = "access_sessions"
    __table_args__ = (
        Index(None, "user_id", "status"),
        Index(None, "user_id", "created_at"),
        Index(None, "auth_identity_id", "status"),
        Index(None, "parent_session_id"),
        Index(None, "status", "expires_at"),
        Index(None, "status", "idle_expires_at"),
        CheckConstraint(
            one_of("authentication_method", AUTHENTICATION_METHODS),
            name="access_session_auth_method_is_valid",
        ),
        CheckConstraint(
            one_of("assurance_level", ASSURANCE_LEVELS),
            name="access_session_assurance_level_is_valid",
        ),
        CheckConstraint(
            one_of("status", SESSION_STATUSES), name="access_session_status_is_valid"
        ),
        CheckConstraint("token_version >= 1", name="access_session_token_version_is_valid"),
        CheckConstraint(
            "(status = 'active') = (ended_at IS NULL)",
            name="access_session_end_is_complete",
        ),
        CheckConstraint(
            "parent_session_id IS NULL OR parent_session_id <> id",
            name="access_session_cannot_parent_itself",
        ),
    )

    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    auth_identity_id: Mapped[UUID | None] = uuid_fk("auth_identities.id")
    authentication_method: Mapped[str] = mapped_column(String(32), nullable=False)
    assurance_level: Mapped[str] = choice("aal0")
    status: Mapped[str] = choice("active")
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    parent_session_id: Mapped[UUID | None] = uuid_fk("access_sessions.id")
    expires_at: Mapped[datetime] = timestamp(nullable=False)
    idle_expires_at: Mapped[datetime | None] = timestamp()
    last_seen_at: Mapped[datetime | None] = timestamp()
    ended_at: Mapped[datetime | None] = timestamp()
    end_reason: Mapped[str | None] = mapped_column(String(64))
    metadata_: Mapped[JsonObject] = json_object("metadata")


class PasswordResetToken(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """Single-use reset link; only a hash of the emailed token is kept."""

    __tablename__ = "password_reset_tokens"
    __table_args__ = (Index(None, "user_id", "created_at"),)

    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    expires_at: Mapped[datetime] = timestamp(nullable=False)
    used_at: Mapped[datetime | None] = timestamp()
    requested_ip: Mapped[str | None] = mapped_column(INET)
