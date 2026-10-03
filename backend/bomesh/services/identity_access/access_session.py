"""Durable access-session lifecycle and request-context resolution."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import and_, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import AccessSession, AuthIdentity, User
from bomesh.services import (
    ACTIVE_STATUS,
    AUDIT_READ_PERMISSION,
    AuthContext,
    AuthenticationError,
    ControlPlaneValidationError,
    JwtClaims,
    normalize_page,
    require_tenant_permission,
    timestamp,
)
from bomesh.services.identity_access.identity_store import IdentityStoreService

#: Why a session began: a fresh sign-in, or a switch from another workspace.
_ENTRY_BY_TRANSITION = {None: "sign_in", "tenant_switch": "workspace_switch"}


class AccessSessionService:
    """Create, transition, and validate one tenant-scoped security session."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._identities = IdentityStoreService(session)

    async def create_user(
        self,
        *,
        user: User,
        tenant_id: UUID,
        auth_identity: AuthIdentity | None,
        authentication_method: str,
        expires_in_seconds: int,
        parent: AccessSession | None = None,
        transition_reason: str | None = None,
    ) -> tuple[AccessSession, AuthContext]:
        context = await self._identities.get_context(user.id, tenant_id=tenant_id)
        now = datetime.now(UTC)
        row = AccessSession(
            tenant_id=tenant_id,
            user_id=user.id,
            auth_identity_id=auth_identity.id if auth_identity is not None else None,
            kind="user",
            authentication_method=authentication_method,
            assurance_level="aal1",
            parent_session_id=parent.id if parent is not None else None,
            transition_reason=transition_reason,
            expires_at=now + timedelta(seconds=expires_in_seconds),
            last_seen_at=now,
        )
        self._session.add(row)
        if parent is not None:
            self._end(parent, status="superseded", reason=transition_reason or "replaced")
        await self._session.flush()
        return row, replace(context, session_id=row.id, token_version=row.token_version)

    async def internal_user(
        self, *, user: User, tenant_id: UUID
    ) -> AuthContext:
        """Reuse one explicit development-only session instead of minting per request."""

        now = datetime.now(UTC)
        row = await self._session.scalar(
            select(AccessSession).where(
                AccessSession.user_id == user.id,
                AccessSession.tenant_id == tenant_id,
                AccessSession.kind == "user",
                AccessSession.authentication_method == "internal",
                AccessSession.status == "active",
                AccessSession.expires_at > now,
            )
        )
        context = await self._identities.get_context(user.id, tenant_id=tenant_id)
        if row is None:
            row, context = await self.create_user(
                user=user,
                tenant_id=tenant_id,
                auth_identity=None,
                authentication_method="internal",
                expires_in_seconds=86_400,
            )
            return context
        return replace(context, session_id=row.id, token_version=row.token_version)

    async def active(
        self, session_id: UUID, *, lock: bool = False
    ) -> AccessSession:
        statement = select(AccessSession).where(AccessSession.id == session_id)
        if lock:
            statement = statement.with_for_update()
        row = await self._session.scalar(statement)
        if row is None:
            raise AuthenticationError("access session is unavailable")
        now = datetime.now(UTC)
        expired = row.expires_at <= now or (
            row.idle_expires_at is not None and row.idle_expires_at <= now
        )
        if expired and row.status == "active":
            self._end(row, status="expired", reason="session_expired")
            await self._session.flush()
        if row.status != "active" or expired:
            raise AuthenticationError("access session is unavailable or expired")
        if row.kind != "user" or row.user_id is None:
            raise AuthenticationError("access session has no user subject")
        return row

    def revoke(self, row: AccessSession, *, reason: str = "logout") -> None:
        """Invalidate one durable session without deleting its audit trail."""

        self._end(row, status="revoked", reason=reason)

    async def resolve(self, claims: JwtClaims) -> AuthContext:
        row = await self.active(claims.session_id)
        if (
            row.tenant_id != claims.active_tenant_id
            or row.user_id != claims.user_id
            or row.token_version != claims.token_version
        ):
            raise AuthenticationError("access token no longer matches its session")
        if row.auth_identity_id is not None:
            identity = await self._session.get(AuthIdentity, row.auth_identity_id)
            if (
                identity is None
                or identity.status != ACTIVE_STATUS
                or identity.user_id != row.user_id
            ):
                raise AuthenticationError("session identity is unavailable")
        context = replace(
            await self._identities.get_context(row.user_id, tenant_id=row.tenant_id),
            session_id=row.id,
            token_version=row.token_version,
        )
        if (
            context.email != claims.email
            or context.permission_codes != claims.permissions
            or context.platform_permissions != claims.platform_permissions
        ):
            raise AuthenticationError(
                "access token no longer reflects current authorization"
            )
        now = datetime.now(UTC)
        if row.last_seen_at is None or now - row.last_seen_at >= timedelta(minutes=5):
            row.last_seen_at = now
            await self._session.flush()
        return context

    async def list_sessions(
        self,
        actor: AuthContext,
        *,
        page: int = 1,
        page_size: int = 20,
        status: str | None = None,
        user_id: UUID | None = None,
        search: str | None = None,
    ) -> dict[str, Any]:
        """Page the workspace's sign-in sessions, newest first, by effective status.

        A row still stored ``active`` whose absolute or idle expiry has passed
        is reported ``expired``: it is only rewritten when next presented.
        """

        tenant_id = require_tenant_permission(actor, AUDIT_READ_PERMISSION)
        page, page_size, offset = normalize_page(page, page_size)
        now = datetime.now(UTC)
        live = and_(
            AccessSession.status == ACTIVE_STATUS,
            AccessSession.expires_at > now,
            or_(
                AccessSession.idle_expires_at.is_(None),
                AccessSession.idle_expires_at > now,
            ),
        )
        filters = [AccessSession.tenant_id == tenant_id, AccessSession.kind == "user"]
        if status == "active":
            filters.append(live)
        elif status == "ended":
            filters.append(not_(live))
        elif status is not None:
            raise ControlPlaneValidationError("status must be one of active, ended")
        if user_id is not None:
            filters.append(AccessSession.user_id == user_id)
        if search and search.strip():
            term = f"%{search.strip()}%"
            filters.append(or_(User.email.ilike(term), User.display_name.ilike(term)))
        base = (
            select(AccessSession, User.email, User.display_name)
            .join(User, User.id == AccessSession.user_id)
            .where(*filters)
        )
        total = await self._session.scalar(
            select(func.count()).select_from(base.subquery())
        )
        rows = (
            await self._session.execute(
                base.order_by(AccessSession.created_at.desc(), AccessSession.id)
                .limit(page_size)
                .offset(offset)
            )
        ).all()
        return {
            "items": [
                _session_record(row, email, display_name, now, actor.session_id)
                for row, email, display_name in rows
            ],
            "total": int(total or 0),
            "page": page,
            "page_size": page_size,
        }

    @staticmethod
    def _end(row: AccessSession, *, status: str, reason: str) -> None:
        row.status = status
        row.ended_at = datetime.now(UTC)
        row.end_reason = reason


def _session_record(
    row: AccessSession,
    email: str | None,
    display_name: str | None,
    now: datetime,
    current_session_id: UUID | None,
) -> dict[str, Any]:
    """Safe session metadata: never tokens, metadata, or provider subjects."""

    status, ended_at, end_reason = row.status, row.ended_at, row.end_reason
    lapsed = [
        moment
        for moment in (row.expires_at, row.idle_expires_at)
        if moment is not None and moment <= now
    ]
    if status == ACTIVE_STATUS and lapsed:
        status, ended_at, end_reason = "expired", min(lapsed), "session_expired"
    return {
        "id": str(row.id),
        "user": {"id": str(row.user_id), "email": email, "display_name": display_name},
        "authentication_method": row.authentication_method,
        "entry": _ENTRY_BY_TRANSITION.get(row.transition_reason, "sign_in"),
        "status": status,
        "started_at": timestamp(row.created_at),
        "last_seen_at": timestamp(row.last_seen_at),
        "ended_at": timestamp(ended_at),
        "end_reason": end_reason,
        "expires_at": timestamp(row.expires_at),
        "current": current_session_id is not None and row.id == current_session_id,
    }


__all__ = ["AccessSessionService"]
