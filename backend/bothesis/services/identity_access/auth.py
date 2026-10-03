"""Verified-provider sign-in and access-session transitions."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from bothesis.db.models import AuthIdentity, Role, User
from bothesis.services import (
    ACTIVE_STATUS,
    PLATFORM_ADMIN_ROLE,
    TENANT_ADMIN_ROLE,
    AuthenticationError,
    AuthenticationSession,
    AuthorizationError,
    IdentityConflictError,
    IdentityInactiveError,
    IdentityNotFoundError,
    TenantMembershipSummary,
    VerifiedGoogleIdentity,
)
from bothesis.services.audit import AuditService
from bothesis.services.identity_access.access_session import AccessSessionService
from bothesis.services.identity_access.identity_store import IdentityStoreService
from bothesis.services.identity_access.jwt_tokens import JwtTokenService
from bothesis.services.identity_access.role_assignments import RoleAssignmentService
from bothesis.services.identity_access.passwords import PasswordCredentialService


class AuthenticationService:
    """Provision durable users and issue revocable tenant-scoped sessions."""

    def __init__(
        self,
        session: AsyncSession,
        *,
        tokens: JwtTokenService,
        platform_admin_emails: frozenset[str] = frozenset(),
    ) -> None:
        self._session = session
        self._identities = IdentityStoreService(session)
        self._access_sessions = AccessSessionService(session)
        self._assignments = RoleAssignmentService(session)
        self._tokens = tokens
        self._platform_admin_emails = platform_admin_emails

    async def create_account(
        self,
        *,
        email: str,
        password: str,
        username: str | None = None,
        display_name: str | None = None,
    ) -> AuthenticationSession:
        """Create one local Account and issue its first canonical Session."""

        user = await self._identities.create_user(
            email,
            username=username,
            password_hash=PasswordCredentialService.hash(password),
            display_name=display_name,
        )
        await self._create_personal_workspace(user)
        return await self._issue_user_session(user, authentication_method="password")

    async def create_session(
        self,
        *,
        method: str,
        email: str | None = None,
        username: str | None = None,
        password: str | None = None,
        credential: str | None = None,
    ) -> AuthenticationSession:
        """Dispatch typed auth methods into one Session creation operation."""

        if method == "password":
            if password is None or (email is None) == (username is None):
                raise AuthenticationError("email or username and password are incorrect")
            try:
                user = (
                    await self._identities.get_user_by_email(email)
                    if email is not None
                    else await self._identities.get_user_by_username(username or "")
                )
            except IdentityNotFoundError as exc:
                raise AuthenticationError("email or username and password are incorrect") from exc
            if user.password_hash is None or not PasswordCredentialService.verify(
                password, user.password_hash
            ):
                raise AuthenticationError("email or username and password are incorrect")
            return await self._issue_user_session(user, authentication_method="password")
        if method == "google":
            if credential is None:
                raise AuthenticationError("google credential is required")
            raise AuthenticationError(
                "google credentials must be verified at the API composition boundary"
            )
        raise AuthenticationError("unsupported authentication method")

    async def update_session(
        self, *, current_session_id: UUID, active_workspace_id: UUID
    ) -> AuthenticationSession:
        return await self._switch_session(
            current_session_id=current_session_id, tenant_id=active_workspace_id
        )

    async def invalidate_session(self, session_id: UUID) -> None:
        row = await self._access_sessions.active(session_id, lock=True)
        self._access_sessions.revoke(row)
        await self._session.flush()

    async def current_session(self, session_id: UUID):
        row = await self._access_sessions.active(session_id)
        context = await self._identities.get_context(row.user_id, tenant_id=row.tenant_id)
        memberships = await self._identities.list_active_tenant_memberships(row.user_id)
        return row, context, memberships

    async def complete_verified_external_session(
        self, identity: VerifiedGoogleIdentity
    ) -> AuthenticationSession:
        """Link a verified Google subject and issue its user session."""

        user, auth_identity, personal_tenant_id = await self._find_or_provision_user(
            identity
        )
        await self._grant_configured_platform_admin(user)
        memberships = await self._identities.list_active_tenant_memberships(user.id)
        if not memberships:
            raise AuthorizationError("user has no active tenant membership")
        active_tenant_id = personal_tenant_id or _default_tenant_id(
            memberships, user_id=str(user.id)
        )
        row, context = await self._access_sessions.create_user(
            user=user,
            tenant_id=active_tenant_id,
            auth_identity=auth_identity,
            authentication_method="oidc",
            expires_in_seconds=self._tokens.expires_in_seconds,
        )
        access_token, expires_at = self._tokens.issue(context)
        return AuthenticationSession(
            access_token=access_token,
            expires_at=min(row.expires_at, expires_at),
            session_id=row.id,
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            active_tenant_id=active_tenant_id,
            permissions=context.permission_codes,
            tenants=memberships,
            platform_permissions=context.platform_permissions,
        )

    async def _issue_user_session(
        self, user: User, *, authentication_method: str
    ) -> AuthenticationSession:
        await self._grant_configured_platform_admin(user)
        memberships = await self._identities.list_active_tenant_memberships(user.id)
        if not memberships:
            raise AuthorizationError("user has no active tenant membership")
        active_tenant_id = _default_tenant_id(memberships, user_id=str(user.id))
        row, context = await self._access_sessions.create_user(
            user=user,
            tenant_id=active_tenant_id,
            auth_identity=None,
            authentication_method=authentication_method,
            expires_in_seconds=self._tokens.expires_in_seconds,
        )
        access_token, expires_at = self._tokens.issue(context)
        return AuthenticationSession(
            access_token=access_token,
            expires_at=min(row.expires_at, expires_at),
            session_id=row.id,
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            active_tenant_id=active_tenant_id,
            permissions=context.permission_codes,
            tenants=memberships,
            platform_permissions=context.platform_permissions,
        )

    async def _switch_session(
        self, *, current_session_id: UUID, tenant_id: UUID
    ) -> AuthenticationSession:
        """Replace current user session with one selecting another membership."""

        parent = await self._access_sessions.active(current_session_id, lock=True)
        user = await self._identities.get_user(parent.user_id)
        memberships = await self._identities.list_active_tenant_memberships(user.id)
        if tenant_id not in {membership.tenant_id for membership in memberships}:
            raise AuthorizationError(f"user is not a member of tenant: {tenant_id}")
        auth_identity = (
            await self._session.get(AuthIdentity, parent.auth_identity_id)
            if parent.auth_identity_id is not None
            else None
        )
        if auth_identity is None and parent.authentication_method not in {"internal", "password"}:
            raise AuthorizationError("session identity is unavailable")
        row, context = await self._access_sessions.create_user(
            user=user,
            tenant_id=tenant_id,
            auth_identity=auth_identity,
            authentication_method=parent.authentication_method,
            expires_in_seconds=self._tokens.expires_in_seconds,
            parent=parent,
            transition_reason="tenant_switch",
        )
        access_token, expires_at = self._tokens.issue(context)
        return AuthenticationSession(
            access_token=access_token,
            expires_at=min(row.expires_at, expires_at),
            session_id=row.id,
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            active_tenant_id=tenant_id,
            permissions=context.permission_codes,
            tenants=memberships,
            platform_permissions=context.platform_permissions,
        )

    async def _find_or_provision_user(
        self, identity: VerifiedGoogleIdentity
    ) -> tuple[User, AuthIdentity, UUID | None]:
        try:
            auth_identity = await self._identities.get_auth_identity(
                identity.issuer, identity.subject, include_disabled=True
            )
        except IdentityNotFoundError:
            auth_identity = None
        if auth_identity is not None:
            if auth_identity.status != ACTIVE_STATUS:
                raise IdentityInactiveError("external identity is disabled")
            user = await self._identities.get_user(
                auth_identity.user_id, include_inactive=True
            )
            if not user.status:
                raise IdentityInactiveError(f"user is not active: {user.id}")
            auth_identity.email = identity.email.casefold()
            auth_identity.email_verified = True
            auth_identity.last_authenticated_at = datetime.now(UTC)
            user.last_login_at = datetime.now(UTC)
            await self._session.flush()
            return user, auth_identity, None

        personal_tenant_id: UUID | None = None
        try:
            user = await self._identities.get_user_by_email(
                identity.email, include_inactive=True
            )
            if not user.status:
                raise IdentityInactiveError(f"user is not active: {user.id}")
        except IdentityNotFoundError:
            user, personal_tenant_id = await self._provision_personal_workspace(identity)
        try:
            async with self._session.begin_nested():
                auth_identity = await self._identities.create_auth_identity(
                    user.id,
                    protocol="oidc",
                    provider_key="google",
                    issuer=identity.issuer,
                    subject=identity.subject,
                    email=identity.email,
                    email_verified=True,
                    profile={"display_name": identity.display_name},
                )
        except IntegrityError:
            auth_identity = await self._identities.get_auth_identity(
                identity.issuer, identity.subject
            )
            if auth_identity.user_id != user.id:
                raise IdentityConflictError(
                    "external identity is already linked to another user"
                )
        user.last_login_at = datetime.now(UTC)
        await self._session.flush()
        return user, auth_identity, personal_tenant_id

    async def _provision_personal_workspace(
        self, identity: VerifiedGoogleIdentity
    ) -> tuple[User, UUID | None]:
        try:
            async with self._session.begin_nested():
                user = await self._identities.create_user(
                    identity.email, display_name=identity.display_name
                )
                display_name = user.display_name or user.email.partition("@")[0]
                tenant = await self._identities.create_tenant(
                    f"tenant-{user.id}", f"{display_name[:243].rstrip()}'s Workspace"
                )
                await self._identities.assign_membership(user.id, tenant.id)
                await self._assignments.replace_tenant_roles(
                    user_id=user.id,
                    tenant_id=tenant.id,
                    role_ids=[await self._tenant_admin_role_id()],
                    created_by_user_id=user.id,
                )
                return user, tenant.id
        except (IdentityConflictError, IntegrityError):
            user = await self._identities.get_user_by_email(
                identity.email, include_inactive=True
            )
            if not user.status:
                raise IdentityInactiveError(f"user is not active: {user.id}")
            return user, None

    async def _create_personal_workspace(self, user: User) -> UUID:
        tenant = await self._identities.create_tenant(
            f"tenant-{user.id}",
            f"{(user.display_name or user.username or user.email.partition('@')[0])[:243].rstrip()}'s Workspace",
        )
        await self._identities.assign_membership(user.id, tenant.id)
        await self._assignments.replace_tenant_roles(
            user_id=user.id,
            tenant_id=tenant.id,
            role_ids=[await self._tenant_admin_role_id()],
            created_by_user_id=user.id,
        )
        return tenant.id

    async def _tenant_admin_role_id(self) -> UUID:
        role = await self._session.scalar(
            select(Role).where(
                Role.code == TENANT_ADMIN_ROLE,
                Role.tenant_id.is_(None),
                Role.status == ACTIVE_STATUS,
            )
        )
        if role is None:
            raise IdentityNotFoundError(
                "system roles are missing; run the system role sync"
            )
        return role.id

    async def _grant_configured_platform_admin(self, user: User) -> None:
        if user.email not in self._platform_admin_emails:
            return
        granted = await self._assignments.ensure_platform_role(
            user.id, PLATFORM_ADMIN_ROLE
        )
        if granted:
            await AuditService(self._session).record_platform_event(
                actor_user_id=user.id,
                action="role_assignment.platform_admin.granted",
                resource_type="user",
                resource_id=str(user.id),
                details={"source": "configured_platform_admin_emails"},
            )


def _default_tenant_id(
    memberships: tuple[TenantMembershipSummary, ...], *, user_id: str
) -> UUID:
    personal_code = f"tenant-{user_id}"
    personal = next(
        (membership for membership in memberships if membership.tenant_code == personal_code),
        None,
    )
    return (personal or memberships[0]).tenant_id


__all__ = ["AuthenticationService"]
