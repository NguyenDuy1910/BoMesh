"""Single-use password-reset tokens (``design.dbml`` ``password_reset_tokens``).

Only the SHA-256 of a token is stored; the token itself exists in the reset
email alone. A token is valid once, for 30 minutes.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import PasswordResetToken
from bomesh.errors import FailedPrecondition

RESET_TOKEN_LIFETIME = timedelta(minutes=30)
RESET_TOKEN_INVALID = "RESET_TOKEN_INVALID"

_TOKEN_BYTES = 32


@dataclass(frozen=True, slots=True)
class IssuedResetToken:
    """A new token for the reset email; never stored or logged."""

    token: str
    expires_at: datetime


class PasswordResetTokenService:
    """Issue and consume reset tokens inside the caller's transaction."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def issue(self, user_id: UUID, *, requested_ip: str | None) -> IssuedResetToken:
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        expires_at = datetime.now(UTC) + RESET_TOKEN_LIFETIME
        self._session.add(
            PasswordResetToken(
                user_id=user_id,
                token_hash=_digest(token),
                expires_at=expires_at,
                requested_ip=requested_ip,
            )
        )
        await self._session.flush()
        return IssuedResetToken(token=token, expires_at=expires_at)

    async def consume(self, token: str) -> UUID:
        """Mark the token used and return its user; RESET_TOKEN_INVALID if unusable."""
        row = await self._session.scalar(
            select(PasswordResetToken)
            .where(PasswordResetToken.token_hash == _digest(token))
            .with_for_update()
        )
        now = datetime.now(UTC)
        if row is None or row.used_at is not None or row.expires_at <= now:
            raise FailedPrecondition(
                "The password reset link is invalid or has expired.",
                reason=RESET_TOKEN_INVALID,
            )
        row.used_at = now
        await self._session.flush()
        return row.user_id


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


__all__ = [
    "RESET_TOKEN_INVALID",
    "RESET_TOKEN_LIFETIME",
    "IssuedResetToken",
    "PasswordResetTokenService",
]
