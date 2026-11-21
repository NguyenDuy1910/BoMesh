"""Reusable provider-reference cache for document processing pipelines."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.connector.protocol import ProviderCacheEntry, ProviderFileCache
from bomesh.db.engine import transaction_scope
from bomesh.db.models import ExternalResource, Item

DEFAULT_MAX_PROVIDER_CACHE_BYTES = 4 * 1024 * 1024


class PostgresProviderFileCache:
    """Store bounded provider references in ``external_resources.provider_data``.

    The cache belongs to the provider identity of a synced Document: a Document
    without a live external resource caches nothing.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        max_entry_bytes: int = DEFAULT_MAX_PROVIDER_CACHE_BYTES,
    ) -> None:
        if max_entry_bytes < 1:
            raise ValueError("provider cache limit must be greater than zero")
        self._session_factory = session_factory
        self._max_entry_bytes = max_entry_bytes

    async def get(
        self,
        document_id: UUID,
        *,
        provider: str,
        provider_version: str,
    ) -> ProviderCacheEntry | None:
        normalized_provider = _provider(provider)
        async with transaction_scope(self._session_factory) as session:
            provider_data = await session.scalar(
                select(ExternalResource.provider_data)
                .join(Item, Item.id == ExternalResource.item_id)
                .where(
                    ExternalResource.item_id == document_id,
                    ExternalResource.deleted_at.is_(None),
                    Item.deleted_at.is_(None),
                )
                .limit(1)
            )
        if not isinstance(provider_data, Mapping):
            return None
        provider_cache = provider_data.get("provider_cache")
        if not isinstance(provider_cache, Mapping):
            return None
        raw_entry = provider_cache.get(normalized_provider)
        if not isinstance(raw_entry, Mapping):
            return None
        if _datetime(raw_entry.get("deleted_at")) is not None:
            return None
        if raw_entry.get("provider_version") != provider_version:
            return None
        reference = raw_entry.get("reference")
        if not isinstance(reference, Mapping):
            return None
        expires_at = _datetime(raw_entry.get("expires_at"))
        entry = ProviderCacheEntry(
            provider=normalized_provider,
            provider_version=provider_version,
            reference={str(key): value for key, value in reference.items()},
            expires_at=expires_at,
        )
        return None if entry.is_expired else entry

    async def put(
        self,
        document_id: UUID,
        entry: ProviderCacheEntry,
    ) -> None:
        provider = _provider(entry.provider)
        serialized = {
            "provider_version": entry.provider_version,
            "reference": dict(entry.reference),
            "expires_at": entry.expires_at.isoformat() if entry.expires_at else None,
            "updated_at": datetime.now(UTC).isoformat(),
        }
        encoded = json.dumps(serialized, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > self._max_entry_bytes:
            raise ValueError(
                "provider cache entry exceeds the configured provider data limit"
            )
        async with transaction_scope(self._session_factory) as session:
            resource = await _locked_resource(session, document_id, live_document=True)
            if resource is None:
                return
            provider_cache = dict(resource.provider_data.get("provider_cache") or {})
            provider_cache[provider] = serialized
            resource.provider_data = {**resource.provider_data, "provider_cache": provider_cache}

    async def invalidate(self, document_id: UUID, *, provider: str) -> None:
        normalized_provider = _provider(provider)
        async with transaction_scope(self._session_factory) as session:
            resource = await _locked_resource(session, document_id)
            if resource is None:
                return
            provider_cache = dict(resource.provider_data.get("provider_cache") or {})
            raw_entry = provider_cache.get(normalized_provider)
            if not isinstance(raw_entry, Mapping):
                return
            provider_cache[normalized_provider] = {
                **dict(raw_entry),
                "deleted_at": datetime.now(UTC).isoformat(),
            }
            resource.provider_data = {**resource.provider_data, "provider_cache": provider_cache}

    async def clear(self, document_id: UUID) -> None:
        async with transaction_scope(self._session_factory) as session:
            resource = await _locked_resource(session, document_id)
            if resource is None:
                return
            provider_cache = resource.provider_data.get("provider_cache")
            if not isinstance(provider_cache, Mapping):
                return
            deleted_at = datetime.now(UTC).isoformat()
            resource.provider_data = {
                **resource.provider_data,
                "provider_cache": {
                    str(provider): (
                        {**dict(entry), "deleted_at": deleted_at}
                        if isinstance(entry, Mapping)
                        else entry
                    )
                    for provider, entry in provider_cache.items()
                },
            }


async def _locked_resource(
    session: AsyncSession, document_id: UUID, *, live_document: bool = False
) -> ExternalResource | None:
    """The Document's live external resource, locked; ``None`` when it has none."""
    statement = (
        select(ExternalResource)
        .where(ExternalResource.item_id == document_id, ExternalResource.deleted_at.is_(None))
        .order_by(ExternalResource.id)
        .limit(1)
        .with_for_update()
    )
    if live_document:
        statement = statement.where(
            ExternalResource.item_id.in_(
                select(Item.id).where(Item.id == document_id, Item.deleted_at.is_(None))
            )
        )
    return await session.scalar(statement)


def _provider(value: str) -> str:
    normalized = value.strip().casefold()
    if not normalized or len(normalized) > 64:
        raise ValueError("provider name is invalid")
    return normalized


def _datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


__all__ = [
    "PostgresProviderFileCache",
    "ProviderCacheEntry",
    "ProviderFileCache",
]
