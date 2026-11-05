"""Sign-in credential verification: a password or a verified Google identity → an ACTIVE user.

Issuing the session is :class:`~bomesh.services.identity.access_session.AccessSessionService`.
Wrong credentials answer the same whether or not the account exists
(UNAUTHENTICATED ``INVALID_CREDENTIALS``); a suspended account is
FAILED_PRECONDITION ``USER_SUSPENDED`` (``auth_contract.md``).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import AuthIdentity, User
from bomesh.errors import AlreadyExists, FailedPrecondition, Unauthenticated
from bomesh.iam.policy import set_platform_role
from bomesh.services import IdentityNotFoundError, VerifiedGoogleIdentity
from bomesh.services.identity.identity_store import IdentityStoreService
from bomesh.services.identity.passwords import PasswordCredentialService
from bomesh.services.workspaces.audit_log import AuditService

_PLATFORM_ADMIN = "roles/platformAdmin"


class AuthenticationService:
    """Resolve sign-in credentials to the user a session is issued for."""

    def __init__(
        self,
        session: AsyncSession,
        *,
        platform_admin_emails: frozenset[str] = frozenset(),
    ) -> None:
        self._session = session
        self._identities = IdentityStoreService(session)
        self._platform_admin_emails = platform_admin_emails

    async def verify_password(
        self, *, email: str | None, username: str | None, password: str
    ) -> User:
        """The ACTIVE user whose email or username and password match."""
        try:
            user = (
                await self._identities.get_user_by_email(email, include_inactive=True)
                if email is not None
                else await self._identities.get_user_by_username(
                    username or "", include_inactive=True
                )
            )
        except IdentityNotFoundError:
            raise _invalid_credentials() from None
        if user.password_hash is None or not PasswordCredentialService.verify(
            password, user.password_hash
        ):
            raise _invalid_credentials()
        return await self._signed_in(user)

    async def verify_google(self, identity: VerifiedGoogleIdentity) -> tuple[User, AuthIdentity]:
        """Link a verified Google subject to its user, creating the account on first sign-in."""
        try:
            auth_identity = await self._identities.get_auth_identity(
                identity.issuer, identity.subject, include_disabled=True
            )
        except IdentityNotFoundError:
            auth_identity = None
        if auth_identity is not None:
            if auth_identity.status != "active":
                raise _invalid_credentials()
            user = await self._identities.get_user(auth_identity.user_id, include_inactive=True)
            auth_identity.email = identity.email.casefold()
            auth_identity.email_verified = True
            auth_identity.last_authenticated_at = datetime.now(UTC)
            return await self._signed_in(user), auth_identity
        try:
            user = await self._identities.get_user_by_email(
                identity.email, include_inactive=True
            )
        except IdentityNotFoundError:
            user = await self._identities.create_user(
                identity.email, display_name=identity.display_name
            )
        _require_active(user)
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
                raise AlreadyExists(
                    "This Google account is linked to another user."
                ) from None
        return await self._signed_in(user), auth_identity

    async def _signed_in(self, user: User) -> User:
        _require_active(user)
        user.last_active_at = datetime.now(UTC)
        await self._grant_configured_platform_admin(user)
        await self._session.flush()
        return user

    async def _grant_configured_platform_admin(self, user: User) -> None:
        """Deployment bootstrap: configured emails hold ``roles/platformAdmin``."""
        if user.email not in self._platform_admin_emails:
            return
        if await set_platform_role(self._session, user.id, _PLATFORM_ADMIN):
            await AuditService(self._session).record(
                workspace_id=None,
                actor=None,
                category="people",
                action="UpdateUser",
                resource_type="user",
                target_name=f"users/{user.id}",
                details={"platformRole": "ADMIN", "source": "configured_platform_admin_emails"},
            )


def _require_active(user: User) -> None:
    if user.status != "active":
        raise FailedPrecondition("The account is suspended.", reason="USER_SUSPENDED")


def _invalid_credentials() -> Unauthenticated:
    return Unauthenticated(
        "The sign-in credentials are incorrect.", reason="INVALID_CREDENTIALS"
    )


__all__ = ["AuthenticationService"]
