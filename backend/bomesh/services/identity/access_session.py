"""Access sessions: issue a bearer token for a user, authenticate it, end it.

Sessions carry no workspace (``auth_contract.md``). A bearer token is
accepted only while its session is ACTIVE, unexpired, at the token's version,
and its user (and external identity, if any) is ACTIVE; anything else is
UNAUTHENTICATED. The Identity interface (CreateSession, DeleteSession,
SuspendUser, ResetPassword) and the test harness issue and end sessions here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import AccessSession, AuthIdentity, User
from bomesh.errors import FailedPrecondition, Unauthenticated
from bomesh.iam.authorizer import Principal
from bomesh.services.identity.jwt_tokens import JwtTokenService

#: ``last_seen_at`` and ``users.last_active_at`` are written at most this often.
_LAST_SEEN_RESOLUTION = timedelta(minutes=1)


@dataclass(frozen=True, slots=True)
class IssuedSession:
    """A new session and its bearer token; the token is never stored or readable again."""

    session: AccessSession
    access_token: str


class AccessSessionService:
    """Session lifecycle inside the caller's transaction."""

    def __init__(self, session: AsyncSession, tokens: JwtTokenService) -> None:
        self._session = session
        self._tokens = tokens

    async def create(
        self,
        user_id: UUID,
        *,
        authentication_method: str,
        auth_identity_id: UUID | None = None,
    ) -> IssuedSession:
        """Open an ACTIVE session for an ACTIVE user and sign its token."""
        user = await self._session.get(User, user_id)
        if user is None or user.status != "active":
            raise FailedPrecondition("The account is suspended.", reason="USER_SUSPENDED")
        now = datetime.now(UTC)
        row = AccessSession(
            user_id=user_id,
            auth_identity_id=auth_identity_id,
            authentication_method=authentication_method,
            assurance_level="aal1",
            expires_at=now + timedelta(seconds=self._tokens.expires_in_seconds),
            last_seen_at=now,
        )
        self._session.add(row)
        await self._session.flush()
        token = self._tokens.issue(
            session_id=row.id,
            user_id=user_id,
            token_version=row.token_version,
            expires_at=row.expires_at,
        )
        return IssuedSession(session=row, access_token=token)

    async def authenticate(self, token: str) -> Principal:
        """Resolve a bearer token to its :class:`Principal`, or UNAUTHENTICATED."""
        claims = self._tokens.verify(token)
        row = await self._session.get(AccessSession, claims.session_id)
        if row is None or row.user_id != claims.user_id:
            raise Unauthenticated("The session is unavailable.")
        now = datetime.now(UTC)
        if row.status == "active" and _expired(row, now):
            self._end_row(row, status="expired", reason="session_expired", now=now)
            await self._session.flush()
        if row.status != "active":
            raise Unauthenticated("The session has ended.")
        if row.token_version != claims.token_version:
            raise Unauthenticated("The access token was replaced.")
        user = await self._session.get(User, row.user_id)
        if user is None or user.status != "active":
            raise Unauthenticated("The account is not active.")
        if row.auth_identity_id is not None:
            identity = await self._session.get(AuthIdentity, row.auth_identity_id)
            if identity is None or identity.status != "active":
                raise Unauthenticated("The sign-in identity is disabled.")
        if row.last_seen_at is None or now - row.last_seen_at >= _LAST_SEEN_RESOLUTION:
            row.last_seen_at = now
            user.last_active_at = now
            await self._session.flush()
        return Principal(user_id=row.user_id, session_id=row.id)

    async def end(self, session_id: UUID, *, reason: str = "logout") -> AccessSession:
        """ACTIVE → ended (revoked); an already ended session is FAILED_PRECONDITION."""
        row = await self._session.scalar(
            select(AccessSession).where(AccessSession.id == session_id).with_for_update()
        )
        if row is None or row.status != "active":
            raise FailedPrecondition("The session has already ended.")
        self._end_row(row, status="revoked", reason=reason, now=datetime.now(UTC))
        await self._session.flush()
        return row

    async def end_all(self, user_id: UUID, *, reason: str) -> int:
        """End every ACTIVE session of a user (SuspendUser, ResetPassword)."""
        result = await self._session.execute(
            update(AccessSession)
            .where(AccessSession.user_id == user_id, AccessSession.status == "active")
            .values(status="revoked", ended_at=datetime.now(UTC), end_reason=reason)
        )
        return result.rowcount or 0

    @staticmethod
    def _end_row(row: AccessSession, *, status: str, reason: str, now: datetime) -> None:
        row.status = status
        row.ended_at = now
        row.end_reason = reason


def _expired(row: AccessSession, now: datetime) -> bool:
    return row.expires_at <= now or (
        row.idle_expires_at is not None and row.idle_expires_at <= now
    )


__all__ = ["AccessSessionService", "IssuedSession"]
