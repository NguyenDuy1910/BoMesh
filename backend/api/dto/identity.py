"""Identity messages (``openapi.yaml`` tag Identity) and their list field maps."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from api.aip.filtering import FilterSchema, enum, string
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import AccessSession, User
from bomesh.services.identity.records import (
    Appearance,
    AuthenticationMethod,
    EmailNotifications,
    PlatformRole,
    SessionRecord,
    SessionState,
    UserPreferencesRecord,
    UserRecord,
    UserState,
    UserSummary,
    session_method_column,
    session_state_column,
    user_name,
    user_platform_role_column,
    user_state_column,
)
from bomesh.services.kernel.workspaces import workspace_name

# -- Users ------------------------------------------------------------------------


class UserMessage(ProtoMessage):
    """``User``: an account. Output-only fields sent on input are ignored."""

    name: str | None = None
    email: str | None = None
    username: str | None = None
    display_name: str | None = None
    password: str | None = Field(default=None, json_schema_extra={"writeOnly": True})
    state: UserState | None = None
    platform_role: PlatformRole | None = None
    last_active_time: Timestamp | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None


class ListUsersResponse(ProtoMessage):
    users: list[UserMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class ActivateUserRequest(ProtoMessage):
    """Empty body; the user is named only by the path."""


class SuspendUserRequest(ProtoMessage):
    """Empty body; the user is named only by the path."""


class SendPasswordResetRequest(ProtoMessage):
    email: str


class ResetPasswordRequest(ProtoMessage):
    reset_token: str
    new_password: str


class Empty(ProtoMessage):
    """``google.protobuf.Empty``."""


def user_message(record: UserRecord) -> UserMessage:
    return UserMessage(
        name=record.name,
        email=record.email,
        username=record.username,
        display_name=record.display_name,
        state=record.state,
        platform_role=record.platform_role,
        last_active_time=record.last_active_at,
        create_time=record.created_at,
        update_time=record.updated_at,
    )


def user_summary_message(summary: UserSummary) -> UserMessage:
    """LookupUser's restricted fields: ``name``, ``email``, ``displayName``, ``state``."""
    return UserMessage(
        name=summary.name,
        email=summary.email,
        display_name=summary.display_name,
        state=summary.state,
    )


USER_FILTERS = FilterSchema(
    {
        "state": enum(user_state_column(), ("ACTIVE", "SUSPENDED")),
        "platformRole": enum(user_platform_role_column(), ("NONE", "OPERATOR", "ADMIN")),
        "email": string(User.email),
    }
)
USER_ORDER = OrderSchema(
    {
        "createTime": User.created_at,
        "lastActiveTime": User.last_active_at,
        "displayName": User.display_name,
    },
    tie_breaker=[User.id],
    default="createTime",
)


# -- Preferences ----------------------------------------------------------------------


class UserAppearance(ProtoMessage):
    mode: Literal["SYSTEM", "LIGHT", "DARK"] | None = None
    theme: str | None = None
    accent_color: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")] | None = None
    background_tint: str | None = None
    corner_radius: Literal["SHARP", "DEFAULT", "ROUNDED"] | None = None
    font: str | None = None


class UserEmailNotifications(ProtoMessage):
    source_failures: bool | None = None
    access_requests: bool | None = None
    contribution_updates: bool | None = None
    review_queue: bool | None = None
    request_updates: bool | None = None
    cited_document_changes: bool | None = None
    weekly_summary: bool | None = None


class UserPreferencesMessage(ProtoMessage):
    """Singleton ``users/{user}/preferences``."""

    name: str | None = None
    language_code: str | None = None
    show_work_steps: bool | None = None
    appearance: UserAppearance | None = None
    email_notifications: UserEmailNotifications | None = None
    last_workspace: str | None = None


def preferences_message(record: UserPreferencesRecord) -> UserPreferencesMessage:
    return UserPreferencesMessage(
        name=record.name,
        language_code=record.language_code,
        show_work_steps=record.show_work_steps,
        appearance=_appearance(record.appearance),
        email_notifications=_notifications(record.email_notifications),
        last_workspace=(
            workspace_name(record.last_workspace_id) if record.last_workspace_id else None
        ),
    )


def _appearance(value: Appearance) -> UserAppearance | None:
    message = UserAppearance(
        mode=value.mode,  # type: ignore[arg-type]
        theme=value.theme,
        accent_color=value.accent_color,
        background_tint=value.background_tint,
        corner_radius=value.corner_radius,  # type: ignore[arg-type]
        font=value.font,
    )
    return message if message.model_dump(exclude_none=True) else None


def _notifications(value: EmailNotifications) -> UserEmailNotifications | None:
    message = UserEmailNotifications(
        source_failures=value.source_failures,
        access_requests=value.access_requests,
        contribution_updates=value.contribution_updates,
        review_queue=value.review_queue,
        request_updates=value.request_updates,
        cited_document_changes=value.cited_document_changes,
        weekly_summary=value.weekly_summary,
    )
    return message if message.model_dump(exclude_none=True) else None


# -- Sessions ------------------------------------------------------------------------


class SessionPasswordCredential(ProtoMessage):
    """Exactly one of ``email`` or ``username``."""

    email: str | None = None
    username: str | None = None
    password: str

    @model_validator(mode="after")
    def _one_identifier(self) -> SessionPasswordCredential:
        if (self.email is None) == (self.username is None):
            raise ValueError("exactly one of email or username is required")
        return self


class SessionGoogleCredential(ProtoMessage):
    id_token: str


class SessionCredential(ProtoMessage):
    """Input only; exactly one of ``password`` or ``google``."""

    password: SessionPasswordCredential | None = None
    google: SessionGoogleCredential | None = None

    @model_validator(mode="after")
    def _one_variant(self) -> SessionCredential:
        if (self.password is None) == (self.google is None):
            raise ValueError("exactly one of password or google is required")
        return self


class SessionMessage(ProtoMessage):
    """``Session``: on create send only ``credential``; output-only fields are ignored."""

    name: str | None = None
    user: str | None = None
    credential: SessionCredential | None = None
    authentication_method: AuthenticationMethod | None = None
    access_token: str | None = None
    expire_time: Timestamp | None = None
    create_time: Timestamp | None = None
    last_seen_time: Timestamp | None = None
    state: SessionState | None = None


class ListSessionsResponse(ProtoMessage):
    sessions: list[SessionMessage]
    next_page_token: str | None = None


def session_message(record: SessionRecord) -> SessionMessage:
    return SessionMessage(
        name=record.name,
        user=user_name(record.user_id),
        authentication_method=record.authentication_method,
        access_token=record.access_token,
        expire_time=record.expires_at,
        create_time=record.created_at,
        last_seen_time=record.last_seen_at,
        state=record.state,
    )


SESSION_FILTERS = FilterSchema(
    {
        "state": enum(session_state_column(), ("ACTIVE", "ENDED")),
        "authenticationMethod": enum(session_method_column(), ("PASSWORD", "GOOGLE")),
    }
)
SESSION_ORDER = OrderSchema(
    {"createTime": AccessSession.created_at, "lastSeenTime": AccessSession.last_seen_at},
    tie_breaker=[AccessSession.id],
    default="createTime desc",
)


__all__ = [
    "SESSION_FILTERS",
    "SESSION_ORDER",
    "USER_FILTERS",
    "USER_ORDER",
    "ActivateUserRequest",
    "Empty",
    "ListSessionsResponse",
    "ListUsersResponse",
    "ResetPasswordRequest",
    "SendPasswordResetRequest",
    "SessionCredential",
    "SessionMessage",
    "SuspendUserRequest",
    "UserAppearance",
    "UserEmailNotifications",
    "UserMessage",
    "UserPreferencesMessage",
    "preferences_message",
    "session_message",
    "user_message",
    "user_summary_message",
]
