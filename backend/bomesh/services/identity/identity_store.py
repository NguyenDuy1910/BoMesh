"""Durable users, external identities, workspaces (tenants) and memberships.

Authorization lives in :mod:`bomesh.iam`; sessions in
:mod:`bomesh.services.identity.access_session`. Account input errors
are the contract's: INVALID_ARGUMENT on the offending field, ALREADY_EXISTS
``EMAIL_ALREADY_USED`` / ``USERNAME_ALREADY_USED`` (``auth_contract.md``).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import (
    AuthIdentity,
    Group,
    GroupMembership,
    Item,
    RoleAssignment,
    Space,
    Tenant,
    TenantMembership,
    User,
)
from bomesh.errors import AlreadyExists, InvalidArgument
from bomesh.services import (
    ACTIVE_STATUS,
    SUSPENDED_STATUS,
    IdentityConflictError,
    IdentityNotFoundError,
)

EMAIL_ALREADY_USED = "EMAIL_ALREADY_USED"
USERNAME_ALREADY_USED = "USERNAME_ALREADY_USED"

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+$")
_USERNAME = re.compile(r"^[a-z0-9._-]{3,64}$")
_MAX_EMAIL = 255
_MAX_DISPLAY_NAME = 255


@dataclass(frozen=True, slots=True)
class NewAccount:
    """Normalized, still unused sign-up identifiers."""

    email: str
    username: str | None


class IdentityStoreService:
    """Create and read users, identities, tenants and memberships."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def check_new_account(self, email: str, *, username: str | None = None) -> NewAccount:
        """Normalize sign-up identifiers and fail when either is already used."""
        account = NewAccount(
            email=normalize_email(email),
            username=normalize_username(username) if username is not None else None,
        )
        if await self._session.scalar(select(User.id).where(User.email == account.email)):
            raise AlreadyExists(
                "This email address is already used by an account.", reason=EMAIL_ALREADY_USED
            )
        if account.username is not None:
            await self._require_free_username(account.username, owner=None)
        return account

    async def create_user(
        self,
        email: str,
        *,
        username: str | None = None,
        password_hash: str | None = None,
        display_name: str | None = None,
        preferences: Mapping[str, Any] | None = None,
    ) -> User:
        account = await self.check_new_account(email, username=username)
        user = User(
            username=account.username,
            email=account.email,
            password_hash=password_hash,
            display_name=normalize_display_name(display_name),
            preferences=dict(preferences or {}),
        )
        try:
            async with self._session.begin_nested():
                self._session.add(user)
                await self._session.flush()
        except IntegrityError:
            # A concurrent sign-up won the unique index: report which identifier.
            await self.check_new_account(email, username=username)
            raise
        return user

    async def set_username(self, user: User, username: str | None) -> None:
        """Change (or clear) the sign-in handle; a handle in use is USERNAME_ALREADY_USED."""
        normalized = normalize_username(username) if username else None
        if normalized == user.username:
            return
        if normalized is not None:
            await self._require_free_username(normalized, owner=user.id)
        user.username = normalized
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise _username_used() from None

    @staticmethod
    def set_display_name(user: User, display_name: str | None) -> None:
        user.display_name = normalize_display_name(display_name)

    async def get_auth_identity(
        self, issuer: str, subject: str, *, include_disabled: bool = False
    ) -> AuthIdentity:
        identity = await self._session.scalar(
            select(AuthIdentity).where(
                AuthIdentity.issuer == _required_text(issuer, "identity issuer", 2048),
                AuthIdentity.subject == _required_text(subject, "identity subject", 2048),
            )
        )
        if identity is None or (not include_disabled and identity.status != ACTIVE_STATUS):
            raise IdentityNotFoundError("external identity not found")
        return identity

    async def create_auth_identity(
        self,
        user_id: UUID,
        *,
        protocol: str,
        provider_key: str,
        issuer: str,
        subject: str,
        email: str | None,
        email_verified: bool | None,
        profile: Mapping[str, Any] | None = None,
    ) -> AuthIdentity:
        await self.get_user(user_id)
        identity = AuthIdentity(
            user_id=user_id,
            protocol=_required_text(protocol, "identity protocol", 24).casefold(),
            provider_key=_required_text(provider_key, "identity provider", 64).casefold(),
            issuer=_required_text(issuer, "identity issuer", 2048),
            subject=_required_text(subject, "identity subject", 2048),
            email=email.strip().casefold() if email is not None else None,
            email_verified=email_verified,
            profile=dict(profile or {}),
            last_authenticated_at=datetime.now(UTC),
        )
        self._session.add(identity)
        await self._session.flush()
        return identity

    async def get_user(self, user_id: UUID, *, include_inactive: bool = False) -> User:
        user = await self._session.get(User, user_id)
        if user is None or (not include_inactive and user.status != ACTIVE_STATUS):
            raise IdentityNotFoundError(f"user not found: {user_id}")
        return user

    async def get_user_by_email(
        self,
        email: str,
        *,
        include_inactive: bool = False,
    ) -> User:
        """Exact, case-insensitive email match; IdentityNotFoundError otherwise."""
        user = await self._session.scalar(
            select(User).where(User.email == email.strip().casefold())
        )
        if user is None or (not include_inactive and user.status != ACTIVE_STATUS):
            raise IdentityNotFoundError("user not found")
        return user

    async def get_user_by_username(
        self,
        username: str,
        *,
        include_inactive: bool = False,
    ) -> User:
        user = await self._session.scalar(
            select(User).where(func.lower(User.username) == username.strip().casefold())
        )
        if user is None or (not include_inactive and user.status != ACTIVE_STATUS):
            raise IdentityNotFoundError("user not found")
        return user

    async def set_user_status(self, user_id: UUID, status: str) -> User:
        user = await self.get_user(user_id, include_inactive=True)
        if status not in {ACTIVE_STATUS, SUSPENDED_STATUS}:
            raise ValueError("user status must be active or suspended")
        user.status = status
        await self._session.flush()
        return user

    async def create_tenant(
        self,
        code: str,
        name: str,
        *,
        settings: Mapping[str, Any] | None = None,
    ) -> Tenant:
        normalized_code = _normalize_code(code, "tenant code")
        existing = await self._session.scalar(
            select(Tenant.id).where(Tenant.code == normalized_code)
        )
        if existing is not None:
            raise IdentityConflictError(
                f"tenant code already exists: {normalized_code}"
            )

        tenant = Tenant(
            code=normalized_code,
            name=_required_text(name, "tenant name", 255),
            settings=dict(settings or {}),
        )
        self._session.add(tenant)
        await self._session.flush()
        return tenant

    async def assign_membership(
        self,
        user_id: UUID,
        tenant_id: UUID,
    ) -> TenantMembership:
        """Record that a user belongs to a tenant. Roles are assigned separately.

        A former (deleted) membership is revived as a new join; the tenant may
        be in any state (CreateWorkspace adds the admin while CREATING).
        """

        await self.get_user(user_id)
        if await self._session.get(Tenant, tenant_id) is None:
            raise IdentityNotFoundError(f"tenant not found: {tenant_id}")

        membership = await self._session.get(
            TenantMembership, {"user_id": user_id, "tenant_id": tenant_id}
        )
        now = datetime.now(UTC)
        if membership is None:
            membership = TenantMembership(user_id=user_id, tenant_id=tenant_id, joined_at=now)
            self._session.add(membership)
        elif membership.deleted_at is not None:
            membership.status = ACTIVE_STATUS
            membership.joined_at = now
            membership.last_active_at = None
            membership.deleted_at = None
        await self._session.flush()
        return membership

    async def remove_membership(self, user_id: UUID, tenant_id: UUID) -> None:
        """End the membership with every role and group membership held in the tenant.

        A readmitted member never silently regains yesterday's access.
        """
        membership = await self._session.get(
            TenantMembership, {"user_id": user_id, "tenant_id": tenant_id}
        )
        if membership is None:
            raise IdentityNotFoundError(f"membership not found for user: {user_id}")
        if membership.deleted_at is not None:
            return
        now = datetime.now(UTC)
        membership.deleted_at = now
        tenant_items = select(Item.id).where(Item.tenant_id == tenant_id)
        tenant_spaces = select(Space.id).where(Space.tenant_id == tenant_id)
        tenant_groups = select(Group.id).where(Group.tenant_id == tenant_id)
        await self._session.execute(
            update(RoleAssignment)
            .where(
                RoleAssignment.user_id == user_id,
                RoleAssignment.deleted_at.is_(None),
                or_(
                    RoleAssignment.tenant_id == tenant_id,
                    RoleAssignment.item_id.in_(tenant_items),
                    RoleAssignment.space_id.in_(tenant_spaces),
                ),
            )
            .values(deleted_at=now)
        )
        await self._session.execute(
            update(GroupMembership)
            .where(
                GroupMembership.user_id == user_id,
                GroupMembership.group_id.in_(tenant_groups),
                GroupMembership.deleted_at.is_(None),
            )
            .values(deleted_at=now)
        )
        await self._session.flush()

    async def _require_free_username(self, username: str, *, owner: UUID | None) -> None:
        holder = await self._session.scalar(
            select(User.id).where(func.lower(User.username) == username)
        )
        if holder is not None and holder != owner:
            raise _username_used()


def normalize_email(value: str, *, field: str = "email") -> str:
    """Lower-cased sign-in email; INVALID_ARGUMENT on ``field`` when malformed."""
    email = value.strip().casefold()
    if len(email) > _MAX_EMAIL or not _EMAIL.match(email):
        raise InvalidArgument.for_field(field, "Enter a valid email address.")
    return email


def normalize_username(value: str, *, field: str = "username") -> str:
    """Lower-cased handle of 3–64 letters, digits, ``.``, ``_`` or ``-``."""
    username = value.strip().casefold()
    if not _USERNAME.match(username):
        raise InvalidArgument.for_field(
            field, "A username has 3 to 64 letters, digits, '.', '_' or '-'."
        )
    return username


def normalize_display_name(value: str | None, *, field: str = "displayName") -> str | None:
    """Trimmed display name; empty clears it."""
    if value is None or not value.strip():
        return None
    name = value.strip()
    if len(name) > _MAX_DISPLAY_NAME:
        raise InvalidArgument.for_field(
            field, f"A display name has at most {_MAX_DISPLAY_NAME} characters."
        )
    return name


def _username_used() -> AlreadyExists:
    return AlreadyExists("This username is already used.", reason=USERNAME_ALREADY_USED)


def _normalize_code(value: str, field_name: str, max_length: int = 64) -> str:
    return _required_text(value, field_name, max_length).casefold()


def _required_text(value: str, field_name: str, max_length: int) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} must not be blank")
    if len(normalized) > max_length:
        raise ValueError(f"{field_name} must be at most {max_length} characters")
    return normalized


__all__ = [
    "EMAIL_ALREADY_USED",
    "USERNAME_ALREADY_USED",
    "IdentityStoreService",
    "NewAccount",
    "normalize_display_name",
    "normalize_email",
    "normalize_username",
]
