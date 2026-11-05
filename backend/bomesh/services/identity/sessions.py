"""Sign-in sessions (``auth_contract.md``): sign in, read own sessions, sign out.

``sessions/current`` names the session of the presented token. Sessions end
softly and stay readable; another user's session is PERMISSION_DENIED.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import AccessSession, AuthIdentity, User
from bomesh.errors import NotFound, PermissionDenied, Unauthenticated
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.services import VerifiedGoogleIdentity
from bomesh.services.identity.access_session import AccessSessionService
from bomesh.services.identity.auth import AuthenticationService
from bomesh.services.identity.google import GoogleIdentityVerifier
from bomesh.services.identity.records import Current, SessionRecord, session_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime


@dataclass(frozen=True, slots=True)
class PasswordCredential:
    """Exactly one of ``email`` and ``username``, plus the password."""

    password: str
    email: str | None = None
    username: str | None = None


@dataclass(frozen=True, slots=True)
class GoogleCredential:
    id_token: str


Credential = PasswordCredential | GoogleCredential


class SessionService:
    """The one service for ``sessions/{session}``."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        authorizers: Callable[[], Authorizer],
        authentication: Callable[[AsyncSession], AuthenticationService],
        access_sessions: Callable[[AsyncSession], AccessSessionService],
        google: Callable[[], GoogleIdentityVerifier],
    ) -> None:
        self._sessions = sessions
        self._authorizers = authorizers
        self._authentication = authentication
        self._access_sessions = access_sessions
        self._google = google

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SessionService:
        return cls(
            runtime.sessions(),
            authorizers=runtime.authorizer_factory,
            authentication=runtime.authentication_service,
            access_sessions=runtime.access_session_service,
            google=runtime.google_identity_verifier,
        )

    async def authenticate(self, token: str) -> Principal:
        """The caller a bearer token names, or UNAUTHENTICATED.

        What resolution learns (an expired session ends) is committed even
        when the token is rejected.
        """
        rejected: Unauthenticated
        async with transaction_scope(self._sessions) as session:
            try:
                return await self._access_sessions(session).authenticate(token)
            except Unauthenticated as error:
                rejected = error
        raise rejected

    async def create(self, credential: Credential, *, ip_address: str | None = None) -> SessionRecord:
        """Public sign-in. The token is in the returned record only.

        Records one platform ``SIGN_IN`` audit event plus one in each workspace
        where the user is an active member.
        """
        google = (
            await self._google().verify(credential.id_token)
            if isinstance(credential, GoogleCredential)
            else None
        )
        async with transaction_scope(self._sessions) as session:
            user, identity = await self._verify(session, credential, google)
            issued = await self._access_sessions(session).create(
                user.id,
                authentication_method="password" if identity is None else "oidc",
                auth_identity_id=identity.id if identity is not None else None,
            )
            await session.refresh(issued.session)
            record = SessionRecord.of(issued.session, access_token=issued.access_token)
            await self._audit_sign_in(session, record, ip_address)
        return record

    async def _verify(
        self,
        session: AsyncSession,
        credential: Credential,
        google: VerifiedGoogleIdentity | None,
    ) -> tuple[User, AuthIdentity | None]:
        authentication = self._authentication(session)
        if google is not None:
            return await authentication.verify_google(google)
        assert isinstance(credential, PasswordCredential)
        user = await authentication.verify_password(
            email=credential.email, username=credential.username, password=credential.password
        )
        return user, None

    async def _audit_sign_in(
        self, session: AsyncSession, record: SessionRecord, ip_address: str | None
    ) -> None:
        ctx = RequestContext(
            Principal(record.user_id, record.id), self._authorizers(), ip_address=ip_address
        )
        audit = Audit(session)
        details = {"authenticationMethod": record.authentication_method}
        workspaces = await ctx.authorizer.member_workspaces(ctx.principal)
        for workspace_id in (None, *sorted(workspaces)):
            await audit.record(
                ctx,
                workspace_id=workspace_id,
                category="sign_in",
                action="CreateSession",
                target=record.name,
                details=details,
            )

    async def get(self, ctx: RequestContext, session_ref: UUID | Current) -> SessionRecord:
        """One of the caller's sessions."""
        async with transaction_scope(self._sessions) as session:
            return SessionRecord.of(await _own_session(session, ctx, session_ref))

    async def list(self, ctx: RequestContext, query: ListQuery) -> list[SessionRecord]:
        """The caller's sessions; tokens are never returned."""
        async with transaction_scope(self._sessions) as session:
            rows = await session.scalars(
                query.apply(select(AccessSession).where(AccessSession.user_id == ctx.user_id))
            )
            return [SessionRecord.of(row) for row in rows]

    async def delete(self, ctx: RequestContext, session_ref: UUID | Current) -> SessionRecord:
        """Sign out: ACTIVE → ENDED, revoking the session's token."""
        async with transaction_scope(self._sessions) as session:
            row = await _own_session(session, ctx, session_ref)
            ended = await self._access_sessions(session).end(row.id, reason="logout")
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="sign_in",
                action="DeleteSession",
                target=session_name(ended.id),
            )
            await session.refresh(ended)
            return SessionRecord.of(ended)


async def _own_session(
    session: AsyncSession, ctx: RequestContext, session_ref: UUID | Current
) -> AccessSession:
    session_id = ctx.principal.session_id if session_ref == "current" else session_ref
    row = await session.get(AccessSession, session_id) if session_id is not None else None
    name = session_name(session_id) if isinstance(session_id, UUID) else "sessions/current"
    if row is None:
        raise NotFound(f"Resource '{name}' was not found.")
    if row.user_id != ctx.user_id:
        raise PermissionDenied(
            f"Permission denied on resource '{name}' (or it might not exist): "
            "only the session's own user may use it."
        )
    return row


__all__ = ["Credential", "GoogleCredential", "PasswordCredential", "SessionService"]
