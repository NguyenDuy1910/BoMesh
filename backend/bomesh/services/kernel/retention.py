"""Soft-delete retention (AIP-164): one window for every undeletable resource.

A tombstoned resource stays restorable until ``purge_time``; after that it
answers exactly like an absent one (NOT_FOUND), whatever slice owns it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from bomesh.errors import NotFound

RETENTION = timedelta(days=30)


def purge_time(deleted_at: datetime | None) -> datetime | None:
    """When a resource deleted at ``deleted_at`` is purged; ``None`` while it is live."""
    return deleted_at + RETENTION if deleted_at is not None else None


def is_purged(deleted_at: datetime | None, *, now: datetime | None = None) -> bool:
    """Whether a tombstoned resource is past its retention window."""
    purged_at = purge_time(deleted_at)
    return purged_at is not None and purged_at <= (now or datetime.now(UTC))


def require_restorable(deleted_at: datetime | None, name: str) -> None:
    """Undelete guard: a purged resource no longer exists."""
    if is_purged(deleted_at):
        raise NotFound(f"Resource '{name}' was not found.")


__all__ = ["RETENTION", "is_purged", "purge_time", "require_restorable"]
