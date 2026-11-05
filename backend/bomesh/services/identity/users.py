"""Accounts: sign-up, platform administration and self-service (``api_design.md`` §3).

GetUser and UpdateUser accept ``users/me``; responses carry canonical names.
``platformRole`` is read from and written to platform role grants
(:mod:`bomesh.iam.policy`), never stored on the user.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import User
from bomesh.errors import (
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import Authorizer, PlatformRef, Principal, not_found
from bomesh.iam.policy import platform_role, set_platform_role
from bomesh.services import ACTIVE_STATUS, SUSPENDED_STATUS
from bomesh.services.identity.access_session import AccessSessionService
from bomesh.services.identity.identity_store import (
    IdentityStoreService,
    normalize_display_name,
    normalize_email,
)
from bomesh.services.identity.passwords import PasswordCredentialService
from bomesh.services.identity.records import (
    PLATFORM_ROLE_NAMES,
    Me,
    PlatformRole,
    UserRecord,
    UserSummary,
    platform_role_of,
    user_name,
    user_platform_role_column,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

SELF_MODIFICATION = "SELF_MODIFICATION"
_USERS = PlatformRef("users")

#: UpdateUser fields only the account's own user changes.
PROFILE_FIELDS = frozenset({"displayName", "username"})
UserField = Literal["displayName", "username", "platformRole"]


@dataclass(frozen=True, slots=True)
class NewUser:
    """CreateUser input; ``password`` may be omitted only with ``validateOnly``."""

    email: str
    password: str | None = None
    username: str | None = None
    display_name: str | None = None
    platform_role: PlatformRole | None = None


@dataclass(frozen=True, slots=True)
class UserPage:
    users: list[UserRecord]
    total_size: int


class UserService:
    """The one service for ``users/{user}``."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        authorizers: Callable[[], Authorizer],
        access_sessions: Callable[[AsyncSession], AccessSessionService],
        request_hash_secret: Callable[[], bytes],
    ) -> None:
        self._sessions = sessions
        self._authorizers = authorizers
        self._access_sessions = access_sessions
        self._request_hash_secret = request_hash_secret

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> UserService:
        return cls(
            runtime.sessions(),
            authorizers=runtime.authorizer_factory,
            access_sessions=runtime.access_session_service,
            request_hash_secret=runtime.request_hash_secret,
        )

    # -- Sign-up --------------------------------------------------------------

    async def create(
        self,
        new: NewUser,
        *,
        request_id: UUID | None = None,
        validate_only: bool = False,
        ip_address: str | None = None,
    ) -> UserRecord:
        """Public sign-up; the account starts ACTIVE and is not signed in."""
        if new.platform_role not in (None, "NONE"):
            raise InvalidArgument.for_field(
                "platformRole", "A new account has no platform role; it is granted with UpdateUser."
            )
        if validate_only:
            return await self._validate_sign_up(new)
        if new.password is None:
            raise InvalidArgument.for_field("password", "A password is required.")
        PasswordCredentialService.require_acceptable(new.password)
        normalize_email(new.email)
        password_hash = PasswordCredentialService.hash(new.password)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._request_hash_secret())
            key = None
            if request_id is not None:
                key = idempotency.key(
                    None,
                    request_id,
                    method="CreateUser",
                    parent="",
                    request={
                        "email": new.email,
                        "password": new.password,
                        "username": new.username,
                        "displayName": new.display_name,
                    },
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await _record(session, UUID(replayed.removeprefix("users/")))
            user = await IdentityStoreService(session).create_user(
                new.email,
                username=new.username,
                display_name=new.display_name,
                password_hash=password_hash,
            )
            ctx = RequestContext(Principal(user.id), self._authorizers(), ip_address=ip_address)
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="people",
                action="CreateUser",
                target=user_name(user.id),
            )
            if key is not None:
                await idempotency.remember(key, user_name(user.id))
            return await _record(session, user.id)

    async def _validate_sign_up(self, new: NewUser) -> UserRecord:
        async with transaction_scope(self._sessions) as session:
            account = await IdentityStoreService(session).check_new_account(
                new.email, username=new.username
            )
        return UserRecord(
            id=None,
            email=account.email,
            username=account.username,
            display_name=normalize_display_name(new.display_name),
            state="ACTIVE",
            platform_role="NONE",
        )

    # -- Reads ------------------------------------------------------------------

    async def get(self, ctx: RequestContext, user: UUID | Me) -> UserRecord:
        """Self, or ``users.get`` (platform)."""
        user_id = _resolve(ctx, user)
        if user_id != ctx.user_id:
            await ctx.authorizer.require(ctx.principal, "users.get", _ref(user_id))
        async with transaction_scope(self._sessions) as session:
            return await _record(session, user_id)

    async def list(self, ctx: RequestContext, query: ListQuery) -> UserPage:
        """Every account (``users.list``, platform)."""
        await ctx.authorizer.require(ctx.principal, "users.list", _USERS)
        async with transaction_scope(self._sessions) as session:
            rows = await session.execute(
                query.apply(select(User, user_platform_role_column()))
            )
            total = await session.scalar(query.count(select(User)))
        return UserPage(
            users=[UserRecord.of(user, role) for user, role in rows.tuples()],
            total_size=total or 0,
        )

    async def lookup(self, ctx: RequestContext, email: str) -> UserSummary:
        """The account with exactly this email, for callers adding members somewhere."""
        await self._require_member_adder(ctx)
        normalized = normalize_email(email)
        async with transaction_scope(self._sessions) as session:
            user = await session.scalar(select(User).where(User.email == normalized))
        if user is None:
            raise NotFound("No account has this email address.")
        return UserSummary.of(user)

    async def _require_member_adder(self, ctx: RequestContext) -> None:
        for workspace_id in await ctx.authorizer.member_workspaces(ctx.principal):
            if "members.create" in await ctx.authorizer.workspace_permissions(
                ctx.principal, workspace_id
            ):
                return
        raise PermissionDenied(
            "Permission 'members.create' denied on resource 'users' "
            "(it is needed in at least one workspace)."
        )

    # -- Writes -----------------------------------------------------------------

    async def update(
        self, ctx: RequestContext, user: UUID | Me, changes: Mapping[UserField, str | None]
    ) -> UserRecord:
        """Self changes ``displayName``/``username``; ``users.update`` changes ``platformRole``."""
        user_id = _resolve(ctx, user)
        is_self = user_id == ctx.user_id
        if "platformRole" in changes or not is_self:
            await ctx.authorizer.require(ctx.principal, "users.update", _ref(user_id))
        if "platformRole" in changes and is_self:
            raise FailedPrecondition(
                "You cannot change your own platform role.", reason=SELF_MODIFICATION
            )
        if not is_self and PROFILE_FIELDS & changes.keys():
            raise PermissionDenied(
                "Only the account's own user may change its displayName and username."
            )
        async with transaction_scope(self._sessions) as session:
            row = await _user(session, user_id)
            store = IdentityStoreService(session)
            if "displayName" in changes:
                store.set_display_name(row, changes["displayName"])
            if "username" in changes:
                await store.set_username(row, changes["username"])
            if "platformRole" in changes:
                await set_platform_role(
                    session,
                    user_id,
                    PLATFORM_ROLE_NAMES[_platform_role(changes["platformRole"])],
                    created_by=ctx.user_id,
                )
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="people",
                action="UpdateUser",
                target=user_name(user_id),
                details={"updateMask": sorted(changes), **_role_detail(changes)},
            )
            await session.refresh(row)
            return await _record(session, user_id)

    async def suspend(self, ctx: RequestContext, user: UUID | Me) -> UserRecord:
        """ACTIVE → SUSPENDED (``users.suspend``); every session of the account ends."""
        return await self._transition(
            ctx, user, permission="users.suspend", action="SuspendUser", to=SUSPENDED_STATUS
        )

    async def activate(self, ctx: RequestContext, user: UUID | Me) -> UserRecord:
        """SUSPENDED → ACTIVE (``users.activate``)."""
        return await self._transition(
            ctx, user, permission="users.activate", action="ActivateUser", to=ACTIVE_STATUS
        )

    async def _transition(
        self, ctx: RequestContext, user: UUID | Me, *, permission: str, action: str, to: str
    ) -> UserRecord:
        user_id = _resolve(ctx, user)
        await ctx.authorizer.require(ctx.principal, permission, _ref(user_id))
        if user_id == ctx.user_id:
            raise FailedPrecondition(
                "You cannot change the state of your own account.", reason=SELF_MODIFICATION
            )
        async with transaction_scope(self._sessions) as session:
            row = await _user(session, user_id, for_update=True)
            if row.status == to:
                raise FailedPrecondition(f"The account is already {to}.")
            row.status = to
            if to == SUSPENDED_STATUS:
                await self._access_sessions(session).end_all(user_id, reason="user_suspended")
            await session.flush()
            await Audit(session).record(
                ctx, workspace_id=None, category="people", action=action, target=user_name(user_id)
            )
            await session.refresh(row)
            return await _record(session, user_id)


def _resolve(ctx: RequestContext, user: UUID | Me) -> UUID:
    return ctx.user_id if user == "me" else user  # type: ignore[return-value]


def _ref(user_id: UUID) -> PlatformRef:
    return PlatformRef(user_name(user_id))


async def _user(session: AsyncSession, user_id: UUID, *, for_update: bool = False) -> User:
    statement = select(User).where(User.id == user_id)
    row = await session.scalar(statement.with_for_update() if for_update else statement)
    if row is None:
        raise not_found(_ref(user_id))
    return row


async def _record(session: AsyncSession, user_id: UUID) -> UserRecord:
    row = await _user(session, user_id)
    return UserRecord.of(row, platform_role_of(await platform_role(session, user_id)))


def _platform_role(value: str | None) -> PlatformRole:
    if value is None:
        return "NONE"
    if value not in PLATFORM_ROLE_NAMES:
        raise InvalidArgument.for_field("platformRole", f"Unknown platform role '{value}'.")
    return value  # type: ignore[return-value]


def _role_detail(changes: Mapping[UserField, str | None]) -> dict[str, str]:
    if "platformRole" not in changes:
        return {}
    return {"platformRole": _platform_role(changes["platformRole"])}


__all__ = ["PROFILE_FIELDS", "SELF_MODIFICATION", "NewUser", "UserField", "UserPage", "UserService"]
