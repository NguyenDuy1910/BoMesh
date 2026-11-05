"""Password reset (``auth_contract.md`` § Password reset): SendPasswordReset, ResetPassword.

SendPasswordReset answers the same whether or not the email belongs to an
account; only an ACTIVE account gets a token. The token travels in the email
alone: it is never returned, logged or audited.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import User
from bomesh.services import IdentityNotFoundError
from bomesh.services.identity.access_session import AccessSessionService
from bomesh.services.identity.identity_store import (
    IdentityStoreService,
    normalize_email,
)
from bomesh.services.identity.password_reset_mail import (
    PasswordResetMailer,
    UnconfiguredPasswordResetMailer,
)
from bomesh.services.identity.passwords import PasswordCredentialService
from bomesh.services.identity.records import user_name
from bomesh.services.identity.reset_tokens import (
    IssuedResetToken,
    PasswordResetTokenService,
)
from bomesh.services.kernel.audit import Audit

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime


class PasswordResetService:
    """Issue reset tokens by email and consume them to set a new password."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        access_sessions: Callable[[AsyncSession], AccessSessionService],
        mailer: PasswordResetMailer,
    ) -> None:
        self._sessions = sessions
        self._access_sessions = access_sessions
        self._mailer = mailer

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> PasswordResetService:
        return cls(
            runtime.sessions(),
            access_sessions=runtime.access_session_service,
            mailer=UnconfiguredPasswordResetMailer(),
        )

    async def send(self, email: str, *, ip_address: str | None = None) -> None:
        """Email a reset token to the ACTIVE account with this email, if there is one."""
        normalized = normalize_email(email)
        async with transaction_scope(self._sessions) as session:
            issued = await self._issue(session, normalized, ip_address)
        if issued is not None:
            await self._mailer.send_password_reset(
                email=normalized, reset_token=issued.token, expires_at=issued.expires_at
            )

    async def _issue(
        self, session: AsyncSession, email: str, ip_address: str | None
    ) -> IssuedResetToken | None:
        try:
            user = await IdentityStoreService(session).get_user_by_email(email)
        except IdentityNotFoundError:
            return None
        issued = await PasswordResetTokenService(session).issue(user.id, requested_ip=ip_address)
        await Audit(session).record(
            None,
            workspace_id=None,
            category="sign_in",
            action="SendPasswordReset",
            target=user_name(user.id),
        )
        return issued

    async def reset(self, reset_token: str, new_password: str) -> None:
        """Consume the token, set the password and end every session of the account."""
        PasswordCredentialService.require_acceptable(new_password, field="newPassword")
        password_hash = PasswordCredentialService.hash(new_password)
        async with transaction_scope(self._sessions) as session:
            user_id = await PasswordResetTokenService(session).consume(reset_token)
            user = await session.get(User, user_id, with_for_update=True)
            assert user is not None  # tokens reference their user
            user.password_hash = password_hash
            await self._access_sessions(session).end_all(user_id, reason="password_reset")
            await Audit(session).record(
                None,
                workspace_id=None,
                category="sign_in",
                action="ResetPassword",
                target=user_name(user_id),
            )


__all__ = ["PasswordResetService"]
