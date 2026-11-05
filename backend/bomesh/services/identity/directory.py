"""The account directory other slices read (cross-slice API of Identity).

Every function runs in the caller's session, so a slice reads accounts inside
its own ``transaction_scope``. Nothing here authorizes: the caller has already
decided that the reader may see these accounts (a member list, an audit actor).
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import User
from bomesh.errors import NotFound
from bomesh.iam.policy import platform_role
from bomesh.services.identity.records import (
    UserRecord,
    platform_role_of,
    user_name,
    user_platform_role_column,
)


async def get_user_record(session: AsyncSession, user_id: UUID) -> UserRecord:
    """The account, whatever its state; NOT_FOUND when there is none."""
    user = await session.get(User, user_id)
    if user is None:
        raise NotFound(f"Resource '{user_name(user_id)}' was not found.")
    return UserRecord.of(user, platform_role_of(await platform_role(session, user_id)))


async def get_user_records(
    session: AsyncSession, user_ids: Iterable[UUID]
) -> dict[UUID, UserRecord]:
    """The existing accounts among ``user_ids`` in one query, keyed by ID."""
    wanted = set(user_ids)
    if not wanted:
        return {}
    rows = await session.execute(
        select(User, user_platform_role_column()).where(User.id.in_(wanted))
    )
    return {user.id: UserRecord.of(user, role) for user, role in rows.tuples()}


async def lookup_user(session: AsyncSession, email: str) -> UserRecord | None:
    """The account with exactly this email (case-insensitive), or None."""
    user = await session.scalar(select(User).where(User.email == email.strip().casefold()))
    if user is None:
        return None
    return UserRecord.of(user, platform_role_of(await platform_role(session, user.id)))


def display_name(user: User | UserRecord) -> str:
    """How people see an account: its display name, else its username, else its email."""
    return user.display_name or user.username or user.email


async def display_names(session: AsyncSession, user_ids: Iterable[UUID]) -> dict[UUID, str]:
    """:func:`display_name` of the existing accounts among ``user_ids``, keyed by ID."""
    wanted = set(user_ids)
    if not wanted:
        return {}
    rows = await session.execute(
        select(User.id, User.display_name, User.username, User.email).where(User.id.in_(wanted))
    )
    return {
        user_id: name or username or email for user_id, name, username, email in rows.tuples()
    }


__all__ = [
    "display_name",
    "display_names",
    "get_user_record",
    "get_user_records",
    "lookup_user",
]
