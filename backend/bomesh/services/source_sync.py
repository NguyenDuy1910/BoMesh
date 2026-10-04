"""Source sync: bring a Source's changes into the knowledge inventory.

A sync discovers what changed in one Source, stores each changed original and
registers its Document — ``pending`` when it is new or its content changed —
and tombstones Documents removed at the source together with their index
content. It never parses, contextualizes, chunks, embeds or indexes anything:
processing what a sync registered is an Ingestion Run.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.connector import ConnectorPipeline, ConnectorPipelineConfig
from bomesh.connector.pipeline import PipelineResult, Registration
from bomesh.connector.protocol import (
    AnyItem,
    CollectionItem,
    DocumentItem,
    DocumentKind,
)
from bomesh.connector.registry import ConnectorRegistry
from bomesh.db.engine import transaction_scope
from bomesh.db.models import ExternalResource, IngestionSource, Item
from bomesh.document_index import ItemIndex
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services import (
    ConnectionAuthorizationRequiredError,
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
)
from bomesh.services.citation import CitationService
from bomesh.services.ingestion_sources import IngestionSourceService
from bomesh.services.integration_connections import IntegrationConnectionService
from bomesh.services.item import ItemService
from bomesh.storage import DocumentStorage

log = logging.getLogger(__name__)

#: Item metadata a connector may not set: processing and storage own them.
_RESERVED_METADATA = frozenset({"preview", "processing", "storage"})
_PARENT_RELATIONS = frozenset({"contains", "child", "attachment", "embedded"})


@dataclass(frozen=True, slots=True)
class SourceSyncResult:
    """What one sync changed in the inventory."""

    added: int
    updated: int
    removed: int
    failed: int
    checkpoint_advanced: bool


class SourceSyncService:
    """Run one Source's sync and keep its outcome on the Source."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        raw_storage: DocumentStorage,
        registry: ConnectorRegistry | None = None,
        providers: ConnectionProviderRegistry | None = None,
        credential_encryption_key: str | None = None,
        pipeline_config: ConnectorPipelineConfig | None = None,
    ) -> None:
        self._sessions = session_factory
        self._index = index
        self._raw_storage = raw_storage
        self._registry = registry
        self._providers = providers
        self._credential_encryption_key = credential_encryption_key
        self._pipeline_config = pipeline_config or ConnectorPipelineConfig()

    async def sync(self, source_id: UUID) -> SourceSyncResult:
        """Sync one Source; record ``failed`` and raise when the sync itself stops.

        A Document that cannot be read does not stop the sync: it is counted
        as failed, the checkpoint stays where it was, and the next sync tries
        it again.
        """

        async with transaction_scope(self._sessions) as session:
            await self._sources(session).begin_sync(source_id)
        try:
            result = await self._run(source_id)
        except Exception as exc:
            await self._record_failure(source_id, exc)
            raise
        failed = sum(1 for failure in result.failures if failure.operation != "hierarchy")
        if result.failures:
            log.warning(
                "source sync incomplete source_id=%s failures=%s",
                source_id,
                [
                    (failure.item_id, failure.operation, failure.error_type, failure.message)
                    for failure in result.failures
                ],
            )
        async with transaction_scope(self._sessions) as session:
            await self._sources(session).finish_sync(
                source_id,
                succeeded=True,
                error=_incomplete_error(failed, bool(result.failures)),
                counts={
                    "added": result.added,
                    "updated": result.updated,
                    "removed": result.removed,
                    "failed": failed,
                },
                checkpoint=(
                    result.checkpoint.model_dump(mode="json")
                    if result.checkpoint_advanced
                    else None
                ),
            )
        return SourceSyncResult(
            added=result.added,
            updated=result.updated,
            removed=result.removed,
            failed=failed,
            checkpoint_advanced=result.checkpoint_advanced,
        )

    async def _run(self, source_id: UUID) -> PipelineResult:
        async with transaction_scope(self._sessions) as session:
            source, connector = await self._sources(session).runtime_for_source(source_id)
            connection_id = source.integration_connection_id
            connector_key = source.integration_connection.connector_key
            sink = _InventorySink(
                self._sessions,
                index=self._index,
                source_id=source.id,
                tenant_id=str(source.integration_connection.tenant_id),
                connection_id=str(connection_id),
                connector_key=connector_key,
            )
            checkpoint_data = dict(source.checkpoint or {})
        try:
            if connector.source != connector_key:
                raise ValueError("connector key does not match integration connection")
            set_storage = getattr(connector, "set_storage", None)
            if set_storage is not None:
                set_storage(self._raw_storage)
            scopes = await connector.list_scopes()
            if len(scopes) != 1:
                raise ValueError("a source must resolve to exactly one runtime scope")
            return await ConnectorPipeline(
                connector, sink, config=self._pipeline_config
            ).run_scope(
                scopes[0], connector.checkpoint_model.model_validate(checkpoint_data)
            )
        finally:
            # A connector that refreshed its own token mid-sync holds the only
            # copy of the rotated secret. Keep it whether the sync succeeded or
            # not, or the next sync starts from a credential that is gone.
            await self._persist_rotated_credentials(connection_id, connector)

    async def _persist_rotated_credentials(
        self, integration_connection_id: UUID, connector: object
    ) -> None:
        rotated = getattr(connector, "refreshed_credentials", None)
        if not rotated:
            return
        async with transaction_scope(self._sessions) as session:
            await self._connections(session).persist_rotated_credentials(
                integration_connection_id, rotated
            )

    async def _record_failure(self, source_id: UUID, exc: Exception) -> None:
        log.warning("source sync failed source_id=%s", source_id, exc_info=exc)
        try:
            async with transaction_scope(self._sessions) as session:
                if isinstance(exc, ConnectionAuthorizationRequiredError):
                    # The transaction that found the lapsed grant rolled back;
                    # write it down so the connection offers a reconnect.
                    connection_id = await session.scalar(
                        select(IngestionSource.integration_connection_id).where(
                            IngestionSource.id == source_id
                        )
                    )
                    if connection_id is not None:
                        await self._connections(session).record_health(
                            connection_id, status=exc.status, detail=exc.detail
                        )
                await self._sources(session).finish_sync(
                    source_id, succeeded=False, error=_sync_error(exc), counts={}
                )
        except Exception:
            # The sync's own failure is what the caller must see.
            log.exception("could not record the failed sync source_id=%s", source_id)

    def _sources(self, session: AsyncSession) -> IngestionSourceService:
        return IngestionSourceService(
            session,
            registry=self._registry,
            providers=self._providers,
            credential_encryption_key=self._credential_encryption_key,
        )

    def _connections(self, session: AsyncSession) -> IntegrationConnectionService:
        return IntegrationConnectionService(
            session,
            registry=self._registry,
            providers=self._providers,
            credential_encryption_key=self._credential_encryption_key,
        )


class _InventorySink:
    """One Source's knowledge inventory, as a sync's registration sink."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        source_id: UUID,
        tenant_id: str,
        connection_id: str,
        connector_key: str,
    ) -> None:
        self._sessions = session_factory
        self._index = index
        self._source_id = source_id
        self._tenant_id = tenant_id
        self._connection_id = connection_id
        self._connector_key = connector_key

    async def register_collection(self, item: CollectionItem) -> None:
        self._require_connection(item)
        async with transaction_scope(self._sessions) as session:
            await ItemService(session).upsert_ingested_item(
                self._source_id,
                item.source.external_id,
                canonical_external_id=item.id,
                item_type=item.type,
                title=item.title,
                source_url=item.source.url,
                external_version=item.source.external_version,
                etag=item.source.etag,
                external_updated_at=item.updated_at,
                metadata=_metadata(item),
            )

    async def register_document(self, item: DocumentItem) -> Registration:
        self._require_connection(item)
        original = item.original
        if original is None:
            raise ValueError(f"document {item.id!r} has no stored original")
        metadata = {
            **_metadata(item),
            "file_name": original.file_name or item.title,
            "storage": original.model_dump(mode="json", exclude_none=True),
        }
        async with transaction_scope(self._sessions) as session:
            registered = await ItemService(session).upsert_ingested_item(
                self._source_id,
                item.source.external_id,
                canonical_external_id=item.id,
                item_type=item.type,
                title=item.title,
                document_type=_document_type(item, self._connector_key),
                parent_external_id=item.hierarchy.parent_id,
                parent_relation=_parent_relation(item),
                source_url=item.source.url,
                external_version=item.source.external_version,
                etag=item.source.etag,
                external_updated_at=item.updated_at,
                mime_type=original.content_type,
                size_bytes=original.size_bytes,
                metadata=metadata,
                storage_key=original.key,
            )
        if registered.created:
            return Registration.ADDED
        return Registration.UPDATED if registered.changed else Registration.UNCHANGED

    async def is_current(self, external_id: str, version: str) -> bool:
        async with transaction_scope(self._sessions) as session:
            row = (
                await session.execute(
                    select(ExternalResource.external_version, Item.storage_key)
                    .join(Item, Item.id == ExternalResource.item_id)
                    .where(
                        ExternalResource.ingestion_source_id == self._source_id,
                        ExternalResource.external_id == external_id,
                        ExternalResource.deleted_at.is_(None),
                        Item.item_type == "document",
                        Item.status != "deleted",
                    )
                )
            ).first()
        return row is not None and row.external_version == version and bool(row.storage_key)

    async def remove(self, external_id: str) -> bool:
        async with transaction_scope(self._sessions) as session:
            item_id = await session.scalar(
                select(Item.id)
                .join(ExternalResource, ExternalResource.item_id == Item.id)
                .where(
                    ExternalResource.ingestion_source_id == self._source_id,
                    ExternalResource.external_id == external_id,
                    ExternalResource.deleted_at.is_(None),
                    Item.item_type == "document",
                )
            )
        if item_id is None:
            return False
        # Index content goes first: if tombstoning then fails, the next sync
        # replays this deletion and both steps run again.
        await self._index.remove_item_content(str(item_id), tenant_id=self._tenant_id)
        async with transaction_scope(self._sessions) as session:
            await CitationService(session).replace_for_item(item_id, ())
            await ItemService(session).soft_delete_external_resource(
                self._source_id, external_id
            )
        return True

    def _require_connection(self, item: AnyItem) -> None:
        if str(item.source.connector_id) != self._connection_id:
            raise ValueError("item source does not belong to this source's connection")


def _metadata(item: AnyItem) -> dict[str, Any]:
    return {
        **{
            key: value
            for key, value in item.metadata.items()
            if key not in _RESERVED_METADATA
        },
        "source": item.source.model_dump(mode="json"),
        "external_hierarchy": item.hierarchy.model_dump(mode="json", exclude_none=True),
    }


def _document_type(item: DocumentItem, connector_key: str) -> str:
    if item.document_kind == DocumentKind.PAGE:
        return "confluence_page" if connector_key == "confluence" else "web_page"
    return {
        DocumentKind.PDF: "pdf",
        DocumentKind.DOCUMENT: "word_document",
        DocumentKind.IMAGE: "image",
        DocumentKind.ISSUE: "jira_issue",
        DocumentKind.MESSAGE: "plain_text",
        DocumentKind.EMAIL: "email",
        DocumentKind.NOTE: "plain_text",
        DocumentKind.WEB_PAGE: "web_page",
        DocumentKind.RECORD: "plain_text",
    }.get(item.document_kind, "plain_text")


def _parent_relation(item: DocumentItem) -> str:
    relation = item.metadata.get("parent_relation")
    if isinstance(relation, str) and relation in _PARENT_RELATIONS:
        return relation
    return "attachment" if item.metadata.get("attachment_id") else "child"


def _incomplete_error(failed: int, any_failure: bool) -> str | None:
    if failed:
        noun = "document" if failed == 1 else "documents"
        return f"{failed} {noun} could not be synced. The next sync tries again."
    if any_failure:
        return "The source's folders could not be read. The next sync tries again."
    return None


def _sync_error(exc: BaseException) -> str:
    """Why a sync stopped, in words a source manager can act on."""

    if isinstance(exc, ConnectionAuthorizationRequiredError):
        return "The account behind this source needs to be reconnected."
    if isinstance(exc, ControlPlaneNotFoundError):
        return (
            "This source cannot sync now: it is paused or disabled, or its "
            "connection was removed."
        )
    if isinstance(exc, ControlPlaneValidationError):
        return "This source's settings are not valid. Check the source and its connection."
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status in {401, 403}:
        return "The source refused access. Reconnect the account or check its permissions."
    if status == 404:
        return "The selected content was not found at the source. It may have been moved or deleted."
    if status == 429:
        return "The source is limiting requests. Try again later."
    if isinstance(status, int) and status >= 500:
        return "The source is unavailable right now. Try again later."
    if isinstance(exc, (httpx.TransportError, OSError)):
        return "The source could not be reached. Try again later."
    return "The sync stopped unexpectedly. Try again; if it keeps failing, reconnect the account."


__all__ = ["SourceSyncResult", "SourceSyncService"]
