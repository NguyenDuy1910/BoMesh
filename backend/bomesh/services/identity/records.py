"""Typed records the Identity use cases return (``api_design.md`` §3)."""

from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import ColumnElement, case, func

from bomesh.db.models import AccessSession, User
from bomesh.errors import InvalidArgument
from bomesh.iam.policy import platform_role_column

UserState = Literal["ACTIVE", "SUSPENDED"]
PlatformRole = Literal["NONE", "OPERATOR", "ADMIN"]
SessionState = Literal["ACTIVE", "ENDED"]
AuthenticationMethod = Literal["PASSWORD", "GOOGLE"]

#: ``users/me`` and ``sessions/current`` (AIP-122 aliases for the caller).
Me = Literal["me"]
Current = Literal["current"]

PLATFORM_ROLE_NAMES: dict[PlatformRole, str | None] = {
    "NONE": None,
    "OPERATOR": "roles/platformOperator",
    "ADMIN": "roles/platformAdmin",
}
_PLATFORM_ROLES: dict[str | None, PlatformRole] = {
    name: role for role, name in PLATFORM_ROLE_NAMES.items()
}
_AUTHENTICATION_METHODS: dict[str, AuthenticationMethod] = {
    "password": "PASSWORD",
    "oidc": "GOOGLE",
}


def user_name(user_id: UUID) -> str:
    return f"users/{user_id}"


def parse_user_name(name: str, *, field: str) -> UUID:
    """The ID of a ``users/{user}`` reference; INVALID_ARGUMENT on ``field`` otherwise.

    References never accept the ``me`` alias; only request paths do.
    """
    collection, _, user_id = name.partition("/")
    if collection == "users" and user_id and "/" not in user_id:
        try:
            return UUID(user_id)
        except ValueError:
            pass
    raise InvalidArgument.for_field(field, f"'{name}' is not a user name (users/{{user}}).")


def session_name(session_id: UUID) -> str:
    return f"sessions/{session_id}"


def platform_role_of(role_name: str | None) -> PlatformRole:
    """``User.platformRole`` of a ``PLATFORM_ROLES`` name (or none)."""
    return _PLATFORM_ROLES.get(role_name, "NONE")


def user_state_column() -> ColumnElement[str]:
    """``User.state`` in SQL (filters)."""
    return func.upper(User.status)


def user_platform_role_column() -> ColumnElement[str]:
    """``User.platformRole`` in SQL (filters, listing)."""
    role = platform_role_column(User.id)
    return case(
        *((role == name, value) for value, name in PLATFORM_ROLE_NAMES.items() if name),
        else_="NONE",
    )


def session_state_column() -> ColumnElement[str]:
    """``Session.state`` in SQL: every non-active status is ENDED."""
    return case((AccessSession.status == "active", "ACTIVE"), else_="ENDED")


def session_method_column() -> ColumnElement[str | None]:
    """``Session.authenticationMethod`` in SQL."""
    return case(
        *(
            (AccessSession.authentication_method == stored, value)
            for stored, value in _AUTHENTICATION_METHODS.items()
        ),
        else_=None,
    )


@dataclass(frozen=True, slots=True)
class UserRecord:
    """An account; ``id`` is None for a ``validateOnly`` sign-up."""

    id: UUID | None
    email: str
    username: str | None
    display_name: str | None
    state: UserState
    platform_role: PlatformRole
    last_active_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @property
    def name(self) -> str | None:
        return user_name(self.id) if self.id is not None else None

    @classmethod
    def of(cls, user: User, platform_role: PlatformRole) -> UserRecord:
        return cls(
            id=user.id,
            email=user.email,
            username=user.username,
            display_name=user.display_name,
            state="ACTIVE" if user.status == "active" else "SUSPENDED",
            platform_role=platform_role,
            last_active_at=user.last_active_at,
            created_at=user.created_at,
            updated_at=user.updated_at,
        )


@dataclass(frozen=True, slots=True)
class UserSummary:
    """The restricted view LookupUser returns: name, email, display name and state."""

    id: UUID
    email: str
    display_name: str | None
    state: UserState

    @property
    def name(self) -> str:
        return user_name(self.id)

    @classmethod
    def of(cls, user: User) -> UserSummary:
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            state="ACTIVE" if user.status == "active" else "SUSPENDED",
        )


@dataclass(frozen=True, slots=True)
class SessionRecord:
    """A sign-in session; ``access_token`` is set only by CreateSession."""

    id: UUID
    user_id: UUID
    authentication_method: AuthenticationMethod | None
    state: SessionState
    expires_at: datetime
    created_at: datetime
    last_seen_at: datetime | None
    access_token: str | None = None

    @property
    def name(self) -> str:
        return session_name(self.id)

    @classmethod
    def of(cls, row: AccessSession, *, access_token: str | None = None) -> SessionRecord:
        return cls(
            id=row.id,
            user_id=row.user_id,
            authentication_method=_AUTHENTICATION_METHODS.get(row.authentication_method),
            state="ACTIVE" if row.status == "active" else "ENDED",
            expires_at=row.expires_at,
            created_at=row.created_at,
            last_seen_at=row.last_seen_at,
            access_token=access_token,
        )


@dataclass(frozen=True, slots=True)
class Appearance:
    mode: str | None = None
    theme: str | None = None
    accent_color: str | None = None
    background_tint: str | None = None
    corner_radius: str | None = None
    font: str | None = None


@dataclass(frozen=True, slots=True)
class EmailNotifications:
    source_failures: bool | None = None
    access_requests: bool | None = None
    contribution_updates: bool | None = None
    review_queue: bool | None = None
    request_updates: bool | None = None
    cited_document_changes: bool | None = None
    weekly_summary: bool | None = None


@dataclass(frozen=True, slots=True)
class UserPreferencesRecord:
    """``users/{user}/preferences``; unset fields are None."""

    user_id: UUID
    language_code: str | None
    show_work_steps: bool | None
    appearance: Appearance
    email_notifications: EmailNotifications
    last_workspace_id: UUID | None

    @property
    def name(self) -> str:
        return f"{user_name(self.user_id)}/preferences"

    @classmethod
    def of(cls, user_id: UUID, stored: dict[str, Any]) -> UserPreferencesRecord:
        last_workspace = stored.get("last_workspace_id")
        return cls(
            user_id=user_id,
            language_code=stored.get("language_code"),
            show_work_steps=stored.get("show_work_steps"),
            appearance=_known(Appearance, stored.get("appearance")),
            email_notifications=_known(EmailNotifications, stored.get("email_notifications")),
            last_workspace_id=UUID(last_workspace) if last_workspace else None,
        )


def _known[T](record: type[T], stored: Any) -> T:
    """``record`` from the stored keys it declares."""
    values = stored if isinstance(stored, dict) else {}
    return record(**{f.name: values.get(f.name) for f in fields(record)})  # type: ignore[call-arg, arg-type]


__all__ = [
    "PLATFORM_ROLE_NAMES",
    "Appearance",
    "AuthenticationMethod",
    "Current",
    "EmailNotifications",
    "Me",
    "PlatformRole",
    "SessionRecord",
    "SessionState",
    "UserPreferencesRecord",
    "UserRecord",
    "UserSummary",
    "UserState",
    "parse_user_name",
    "platform_role_of",
    "session_method_column",
    "session_name",
    "session_state_column",
    "user_name",
    "user_platform_role_column",
    "user_state_column",
]
