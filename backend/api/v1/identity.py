"""Identity interface — Identity slice: Accounts (`users`), preferences, sign-in sessions, password reset and Google sign-in (`auth_contract.md`).

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
CreateUser, CreateSession, SendPasswordReset and ResetPassword are public:
they never read a bearer token.
"""

from __future__ import annotations

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from api.aip.fieldmask import MutableFields, apply
from api.aip.names import ResourcePattern
from api.dto.identity import (
    SESSION_FILTERS,
    SESSION_ORDER,
    USER_FILTERS,
    USER_ORDER,
    ActivateUserRequest,
    Empty,
    ListSessionsResponse,
    ListUsersResponse,
    ResetPasswordRequest,
    SendPasswordResetRequest,
    SessionCredential,
    SessionMessage,
    SuspendUserRequest,
    UserMessage,
    UserPreferencesMessage,
    preferences_message,
    session_message,
    user_message,
    user_summary_message,
)
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.identity.password_reset import PasswordResetService
from bomesh.services.identity.preferences import (
    PREFERENCE_PATHS,
    UserPreferencesService,
)
from bomesh.services.identity.records import Current, Me
from bomesh.services.identity.sessions import (
    Credential,
    GoogleCredential,
    PasswordCredential,
    SessionService,
)
from bomesh.services.identity.users import NewUser, UserField, UserService

router = APIRouter(tags=["Identity"])

Users = Annotated[UserService, Depends(service(UserService.from_runtime))]
Sessions = Annotated[SessionService, Depends(service(SessionService.from_runtime))]
Preferences = Annotated[
    UserPreferencesService, Depends(service(UserPreferencesService.from_runtime))
]
password_reset_service = service(PasswordResetService.from_runtime)
PasswordResets = Annotated[PasswordResetService, Depends(password_reset_service)]

_USER = ResourcePattern("users/{user}", uuid=["user"], aliases={"user": ["me"]})
_SESSION = ResourcePattern("sessions/{session}", uuid=["session"], aliases={"session": ["current"]})
_USER_FIELDS = MutableFields(("displayName", "username", "platformRole"))
_PREFERENCE_FIELDS = MutableFields(PREFERENCE_PATHS)


def _user(user: str) -> UUID | Me:
    value = _USER.parse(f"users/{user}")["user"]
    return "me" if value == "me" else UUID(value)


def _session(session: str) -> UUID | Current:
    value = _SESSION.parse(f"sessions/{session}")["session"]
    return "current" if value == "current" else UUID(value)


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client is not None else None


# -- Sessions ---------------------------------------------------------------------------


@router.post("/sessions", name="CreateSession")
async def create_session(
    body: SessionMessage, request: Request, sessions: Sessions
) -> SessionMessage:
    record = await sessions.create(_credential(body.credential), ip_address=_client_ip(request))
    return session_message(record)


def _credential(credential: SessionCredential | None) -> Credential:
    if credential is None:
        raise InvalidArgument.for_field("credential", "A credential is required.")
    if credential.google is not None:
        return GoogleCredential(id_token=credential.google.id_token)
    password = cast(Any, credential.password)
    return PasswordCredential(
        password=password.password, email=password.email, username=password.username
    )


@router.get("/sessions", name="ListSessions")
async def list_sessions(
    params: Annotated[ListParams, Depends()], ctx: Context, sessions: Sessions
) -> ListSessionsResponse:
    query, paging = list_query(
        params, parent=f"users/{ctx.user_id}", filters=SESSION_FILTERS, order=SESSION_ORDER
    )
    page = paging.page(await sessions.list(ctx, query))
    return ListSessionsResponse(
        sessions=[session_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/sessions/{session:id}", name="GetSession")
async def get_session(session: str, ctx: Context, sessions: Sessions) -> SessionMessage:
    return session_message(await sessions.get(ctx, _session(session)))


@router.delete("/sessions/{session:id}", name="DeleteSession")
async def delete_session(session: str, ctx: Context, sessions: Sessions) -> SessionMessage:
    return session_message(await sessions.delete(ctx, _session(session)))


# -- Users ------------------------------------------------------------------------------


@router.post("/users", name="CreateUser")
async def create_user(
    body: UserMessage,
    request: Request,
    users: Users,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
    validate_only: Annotated[bool, Query(alias="validateOnly")] = False,
) -> UserMessage:
    if body.email is None:
        raise InvalidArgument.for_field("email", "An email address is required.")
    record = await users.create(
        NewUser(
            email=body.email,
            password=body.password,
            username=body.username,
            display_name=body.display_name,
            platform_role=body.platform_role,
        ),
        request_id=request_id,
        validate_only=validate_only,
        ip_address=_client_ip(request),
    )
    return user_message(record)


@router.get("/users", name="ListUsers")
async def list_users(
    params: Annotated[ListParams, Depends()], ctx: Context, users: Users
) -> ListUsersResponse:
    query, paging = list_query(params, parent="", filters=USER_FILTERS, order=USER_ORDER)
    result = await users.list(ctx, query)
    page = paging.page(result.users, total_size=result.total_size)
    return ListUsersResponse(
        users=[user_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get("/users:lookup", name="LookupUser")
async def lookup_user(
    email: Annotated[str, Query()], ctx: Context, users: Users
) -> UserMessage:
    return user_summary_message(await users.lookup(ctx, email))


@router.post("/users:sendPasswordReset", name="SendPasswordReset")
async def send_password_reset(
    body: SendPasswordResetRequest, request: Request, resets: PasswordResets
) -> Empty:
    await resets.send(body.email, ip_address=_client_ip(request))
    return Empty()


@router.post("/users:resetPassword", name="ResetPassword")
async def reset_password(body: ResetPasswordRequest, resets: PasswordResets) -> Empty:
    await resets.reset(body.reset_token, body.new_password)
    return Empty()


@router.get("/users/{user:id}", name="GetUser")
async def get_user(user: str, ctx: Context, users: Users) -> UserMessage:
    return user_message(await users.get(ctx, _user(user)))


@router.patch("/users/{user:id}", name="UpdateUser")
async def update_user(
    user: str,
    body: UserMessage,
    ctx: Context,
    users: Users,
    update_mask: Annotated[str | None, Query(alias="updateMask")] = None,
) -> UserMessage:
    mask = _USER_FIELDS.parse(update_mask, body)
    changes = cast(dict[UserField, str | None], apply(mask, body))
    return user_message(await users.update(ctx, _user(user), changes))


@router.post("/users/{user:id}:activate", name="ActivateUser")
async def activate_user(
    user: str, body: ActivateUserRequest, ctx: Context, users: Users
) -> UserMessage:
    return user_message(await users.activate(ctx, _user(user)))


@router.post("/users/{user:id}:suspend", name="SuspendUser")
async def suspend_user(
    user: str, body: SuspendUserRequest, ctx: Context, users: Users
) -> UserMessage:
    return user_message(await users.suspend(ctx, _user(user)))


# -- Preferences ------------------------------------------------------------------------


@router.get("/users/{user:id}/preferences", name="GetUserPreferences")
async def get_user_preferences(
    user: str, ctx: Context, preferences: Preferences
) -> UserPreferencesMessage:
    return preferences_message(await preferences.get(ctx, _user(user)))


@router.patch("/users/{user:id}/preferences", name="UpdateUserPreferences")
async def update_user_preferences(
    user: str,
    body: UserPreferencesMessage,
    ctx: Context,
    preferences: Preferences,
    update_mask: Annotated[str | None, Query(alias="updateMask")] = None,
) -> UserPreferencesMessage:
    mask = _PREFERENCE_FIELDS.parse(update_mask, body)
    record = await preferences.update(ctx, _user(user), apply(mask, body))
    return preferences_message(record)
