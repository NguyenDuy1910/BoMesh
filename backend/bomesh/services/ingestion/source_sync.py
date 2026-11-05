"""Source sync: bring a Source's changes into the knowledge inventory.

A sync discovers what changed in one Source (from the connector checkpoint the
Source keeps), stores each changed original under a per-version key and
registers its Document, and tombstones Documents removed at the source together
with their index content and citations. It never parses, contextualizes,
chunks, embeds or indexes anything: processing is an Ingestion Run.

The Source's ``publishing_policy`` decides how content lands:

- AUTO_PUBLISH: a new file is a PUBLISHED Document (revision 1); a changed one
  gets a new revision that records the provider version.
- REVIEW_FIRST: a new file lands UNPUBLISHED in the target Collection with a
  SOURCE ``new_document`` contribution. A changed PUBLISHED file becomes an
  UNPUBLISHED candidate Document holding the new content plus a
  ``new_revision`` contribution (the published Document keeps answering); one
  contribution per (document, provider version). A changed UNPUBLISHED file
  just gets a new revision.

Contributions belong to KnowledgeCuration (:func:`open_source_contribution`,
:func:`source_revision_contribution`).
Synced Documents name their Source by its immutable ``code``
(``metadata.source.source_code``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import joinedload

from bomesh.connector import ConnectorPipeline, ConnectorPipelineConfig
from bomesh.connector.base import BaseSourceConnector
from bomesh.connector.pipeline import PipelineFailure, PipelineResult, Registration
from bomesh.connector.protocol import (
    AnyItem,
    CollectionItem,
    ConnectorCheckpoint,
    DocumentItem,
    DocumentKind,
)
from bomesh.connector.registry import ConnectorRegistry
from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    ExternalResource,
    IngestionSource,
    IngestionSync,
    Item,
)
from bomesh.document_index import ItemIndex
from bomesh.errors import FailedPrecondition, InvalidArgument, StatusCode
from bomesh.iam.authorizer import item_ancestry
from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE as _NS
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services import ConnectionAuthorizationRequiredError
from bomesh.services.ingestion.connection_store import IntegrationConnectionService
from bomesh.services.ingestion.source_store import (
    SYNC_RUNNING,
    SyncCounts,
    finish_sync,
    load_source,
    refresh_next_sync,
    running_sync,
    start_sync,
    sync_refusal,
)
from bomesh.services.knowledge_curation.contributions import (
    open_source_contribution,
    source_revision_contribution,
)
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.storage import DocumentStorage

log = logging.getLogger(__name__)

#: Item metadata a connector may not set: processing and storage own them.
_RESERVED_METADATA = frozenset({"preview", "processing", "storage", "file_name", "purpose"})
#: Item metadata a registration keeps from the existing row.
_KEPT_METADATA = ("preview", "processing", "file_name", "purpose")
_PARENT_RELATIONS = frozenset({"child", "attachment"})
_UNKNOWN_MIME_TYPE = "application/octet-stream"


@dataclass(frozen=True, slots=True)
class SourceSyncResult:
    """What one sync changed in the inventory."""

    added: int
    updated: int
    removed: int
    failed: int


@dataclass(frozen=True, slots=True)
class _SyncPlan:
    source_id: UUID
    tenant_id: UUID
    connection_id: UUID
    connector_key: str
    #: The config the checkpoint belongs to; a replaced config voids it.
    config: dict[str, Any]
    connector: BaseSourceConnector
    checkpoint: ConnectorCheckpoint


class SourceSyncService:
    """Run a Source's ``ingestion_syncs`` rows (worker side: nobody to authorize)."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        raw_storage: DocumentStorage,
        providers: ConnectionProviderRegistry,
        credential_encryption_key: str | None = None,
        connectors: ConnectorRegistry | None = None,
        pipeline_config: ConnectorPipelineConfig | None = None,
    ) -> None:
        self._sessions = session_factory
        self._index = index
        self._raw_storage = raw_storage
        self._providers = providers
        self._credential_encryption_key = credential_encryption_key
        self._connectors = connectors
        self._pipeline_config = pipeline_config or ConnectorPipelineConfig()

    async def begin_scheduled_sync(self, source_id: UUID) -> UUID | None:
        """Open the RUNNING row of one schedule firing; ``None`` skips the firing silently.

        A firing is skipped when the Source cannot sync now (deleted, paused,
        reauthorization required, ingestion paused, connector disabled) or a
        sync of it is already running.
        """
        async with transaction_scope(self._sessions) as session:
            source = await load_source(session, source_id, for_update=True)
            if source is None or await sync_refusal(session, source) is not None:
                return None
            if await running_sync(session, source.id) is not None:
                return None
            return (await start_sync(session, source, trigger="scheduled")).id

    async def sync(self, sync_id: UUID) -> SourceSyncResult | None:
        """Run one RUNNING sync row; ``None`` when it already ended.

        A sync that stops is recorded as FAILED with a user-safe error and the
        exception is raised. A Document that cannot be read does not stop the
        sync: it is counted as failed, the checkpoint does not advance, and the
        next sync tries it again.
        """
        async with transaction_scope(self._sessions) as session:
            sync = await session.get(IngestionSync, sync_id)
            if sync is None or sync.status != SYNC_RUNNING:
                return None
            source_id = sync.ingestion_source_id
        try:
            plan = await self._prepare(source_id)
            result = await self._run(plan)
        except Exception as exc:
            await self._record_failure(source_id, sync_id, exc)
            raise
        return await self._finish(plan, sync_id, result)

    async def _prepare(self, source_id: UUID) -> _SyncPlan:
        async with transaction_scope(self._sessions) as session:
            source = await load_source(session, source_id)
            if source is None:
                raise FailedPrecondition("This source was deleted.")
            refusal = await sync_refusal(session, source)
            if refusal is not None:
                raise FailedPrecondition(refusal)
            connection = source.integration_connection
            connector = await self._connections(session).runtime_for(
                connection, source_config=source.config
            )
            return _SyncPlan(
                source_id=source.id,
                tenant_id=source.tenant_id,
                connection_id=connection.id,
                connector_key=connection.connector_key,
                config=dict(source.config),
                connector=connector,
                checkpoint=_checkpoint(connector, source.sync_checkpoint),
            )

    async def _run(self, plan: _SyncPlan) -> PipelineResult:
        connector = plan.connector
        sink = _InventorySink(
            self._sessions,
            index=self._index,
            source_id=plan.source_id,
            tenant_id=str(plan.tenant_id),
            connection_id=str(plan.connection_id),
            connector_key=plan.connector_key,
        )
        try:
            if connector.source != plan.connector_key:
                raise ValueError("connector key does not match integration connection")
            set_storage = getattr(connector, "set_storage", None)
            if set_storage is not None:
                set_storage(self._raw_storage)
            scopes = await connector.list_scopes()
            if len(scopes) != 1:
                raise ValueError("a source must resolve to exactly one runtime scope")
            return await ConnectorPipeline(
                connector, sink, config=self._pipeline_config
            ).run_scope(scopes[0], plan.checkpoint)
        finally:
            # A connector that refreshed its own token mid-sync holds the only
            # copy of the rotated secret. Keep it whether the sync succeeded or
            # not, or the next sync starts from a credential that is gone.
            await self._persist_rotated_credentials(plan.connection_id, connector)

    async def _finish(
        self, plan: _SyncPlan, sync_id: UUID, result: PipelineResult
    ) -> SourceSyncResult:
        document_failures = [
            failure for failure in result.failures if failure.operation != "hierarchy"
        ]
        if result.failures:
            log.warning(
                "source sync incomplete source_id=%s failures=%s",
                plan.source_id,
                [
                    (failure.item_id, failure.operation, failure.error_type, failure.message)
                    for failure in result.failures
                ],
            )
        outcome = SourceSyncResult(
            added=result.added,
            updated=result.updated,
            removed=result.removed,
            failed=len(document_failures),
        )
        async with transaction_scope(self._sessions) as session:
            await finish_sync(
                session,
                sync_id,
                counts=SyncCounts(
                    added=outcome.added,
                    updated=outcome.updated,
                    removed=outcome.removed,
                    failed=outcome.failed,
                ),
                failures=[_failure_entry(failure) for failure in result.failures],
            )
            source = await load_source(session, plan.source_id, for_update=True)
            if source is not None:
                if result.checkpoint_advanced and source.config == plan.config:
                    source.sync_checkpoint = result.checkpoint.model_dump(mode="json")
                refresh_next_sync(source, now=datetime.now(UTC))
        return outcome

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

    async def _record_failure(self, source_id: UUID, sync_id: UUID, exc: Exception) -> None:
        log.warning("source sync failed source_id=%s", source_id, exc_info=exc)
        try:
            async with transaction_scope(self._sessions) as session:
                source = await load_source(session, source_id, for_update=True)
                if source is not None and isinstance(exc, ConnectionAuthorizationRequiredError):
                    # The transaction that found the lapsed grant rolled back;
                    # write it down so the connection offers a reconnect.
                    await self._connections(session).record_health(
                        source.integration_connection_id, status=exc.status, detail=exc.detail
                    )
                await finish_sync(session, sync_id, counts=SyncCounts(), error=_sync_error(exc))
                if source is not None:
                    refresh_next_sync(source, now=datetime.now(UTC))
        except Exception:
            # The sync's own failure is what the caller must see.
            log.exception("could not record the failed sync source_id=%s", source_id)

    def _connections(self, session: AsyncSession) -> IntegrationConnectionService:
        return IntegrationConnectionService(
            session,
            providers=self._providers,
            credential_encryption_key=self._credential_encryption_key,
            connectors=self._connectors,
        )


def _checkpoint(
    connector: BaseSourceConnector, stored: dict[str, Any] | None
) -> ConnectorCheckpoint:
    """The Source's stored cursor; a missing or unreadable one starts a full listing."""
    model = connector.checkpoint_model
    if stored is None:
        return model()
    try:
        return model.model_validate(stored)
    except ValidationError:
        log.warning("discarding an unreadable %s checkpoint", connector.source)
        return model()


# -- Registration -------------------------------------------------------------------


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
            source = await _ingestion_source(session, self._source_id)
            resource = await _locked_resource(session, source.id, item.source.external_id)
            _upsert_resource(
                session,
                source,
                resource,
                item=item,
                item_id=source.target_item_id,
                approved=True,
            )
            await session.flush()

    async def register_document(self, item: DocumentItem) -> Registration:
        self._require_connection(item)
        if item.original is None:
            raise ValueError(f"document {item.id!r} has no stored original")
        async with transaction_scope(self._sessions) as session:
            source = await _ingestion_source(session, self._source_id)
            return await _register_document(
                session,
                source,
                item,
                connector_key=self._connector_key,
            )

    async def is_current(self, external_id: str, version: str) -> bool:
        async with transaction_scope(self._sessions) as session:
            row = (
                await session.execute(
                    select(ExternalResource.external_version, Item.id, Item.storage_key)
                    .join(Item, Item.id == ExternalResource.item_id)
                    .where(
                        ExternalResource.ingestion_source_id == self._source_id,
                        ExternalResource.external_id == external_id,
                        ExternalResource.deleted_at.is_(None),
                        Item.item_type == "document",
                        Item.deleted_at.is_(None),
                    )
                )
            ).first()
            if row is None:
                return False
            if row.external_version == version and bool(row.storage_key):
                return True
            proposed = await source_revision_contribution(
                session, self._source_id, row.id, version
            )
            return proposed is not None

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
            await soft_delete_external_resource(session, self._source_id, external_id)
        return True

    def _require_connection(self, item: AnyItem) -> None:
        if str(item.source.connector_id) != self._connection_id:
            raise ValueError("item source does not belong to this source's connection")


async def _register_document(
    session: AsyncSession,
    source: IngestionSource,
    item: DocumentItem,
    *,
    connector_key: str,
) -> Registration:
    """Register one Document with its stored original under the Source's policy."""
    assert item.original is not None
    content = _Content.of(item)
    resource = await _locked_resource(session, source.id, item.source.external_id)
    parent, relation = await _parent(session, source, item)
    review_first = source.publishing_policy == "review_first"
    items = ItemService(session)
    document = (
        await session.get(Item, resource.item_id, with_for_update=True)
        if resource is not None
        else None
    )

    if document is None:
        document = await items.create_document(
            workspace_id=source.tenant_id,
            parent=parent,
            title=item.title,
            document_type=_document_type(item, connector_key),
            mime_type=content.mime_type,
            size_bytes=content.size_bytes,
            file_name=content.file_name,
            published=not review_first,
            created_by_user_id=None,
            metadata=_item_metadata(item, source.code),
            item_id=_document_id(source.id, item.id),
        )
        document.parent_relation = relation
        await content.append_to(items, document)
        if review_first:
            await open_source_contribution(
                session,
                source=source,
                item=document,
                kind="new_document",
                target_item_id=source.target_item_id,
            )
        _upsert_resource(session, source, resource, item=item, item_id=document.id, approved=True)
        await session.flush()
        return Registration.ADDED

    assert resource is not None
    restored = resource.deleted_at is not None or document.deleted_at is not None
    content_changed = (
        resource.external_version != item.source.external_version
        or resource.etag != item.source.etag
        or document.storage_key != content.storage_key
    )
    if document.deleted_at is not None:
        cohort = await items.deleted_cohort(document)
        await items.restore_cohort(cohort, document.deleted_at)
    if content_changed and review_first and document.publication_state == "published":
        proposed = await _propose_revision(
            session, source, document, item, content, connector_key
        )
        _upsert_resource(session, source, resource, item=item, item_id=document.id, approved=False)
        await session.flush()
        if restored:
            return Registration.ADDED
        return Registration.UPDATED if proposed else Registration.UNCHANGED

    _refresh_document(document, item, parent, relation, source.code, connector_key)
    if content_changed:
        await content.append_to(items, document)
    _upsert_resource(session, source, resource, item=item, item_id=document.id, approved=True)
    await session.flush()
    if restored:
        return Registration.ADDED
    return Registration.UPDATED if content_changed else Registration.UNCHANGED


async def _propose_revision(
    session: AsyncSession,
    source: IngestionSource,
    document: Item,
    item: DocumentItem,
    content: _Content,
    connector_key: str,
) -> bool:
    """A candidate holding the new content plus its NEW_REVISION contribution; once per version."""
    version = item.source.external_version
    if await source_revision_contribution(session, source.id, document.id, version) is not None:
        return False
    items = ItemService(session)
    candidate = await items.create_document(
        workspace_id=source.tenant_id,
        parent=source.target_item,
        title=item.title,
        document_type=_document_type(item, connector_key),
        mime_type=content.mime_type,
        size_bytes=content.size_bytes,
        file_name=content.file_name,
        published=False,
        created_by_user_id=None,
        metadata=_item_metadata(item, source.code),
    )
    await content.append_to(items, candidate)
    await open_source_contribution(
        session,
        source=source,
        item=candidate,
        kind="new_revision",
        target_item_id=await _governing_collection(session, document.id),
        replaces_item_id=document.id,
        external_version=version,
    )
    return True


@dataclass(frozen=True, slots=True)
class _Content:
    """One stored provider version of a Document's original."""

    storage_key: str
    mime_type: str
    size_bytes: int
    file_name: str
    external_version: str | None

    @classmethod
    def of(cls, item: DocumentItem) -> _Content:
        assert item.original is not None
        original = item.original
        return cls(
            storage_key=original.key,
            mime_type=original.content_type or _UNKNOWN_MIME_TYPE,
            size_bytes=original.size_bytes or 0,
            file_name=original.file_name or item.title,
            external_version=item.source.external_version,
        )

    async def append_to(self, items: ItemService, document: Item) -> None:
        await items.append_revision(
            document,
            storage_key=self.storage_key,
            mime_type=self.mime_type,
            size_bytes=self.size_bytes,
            file_name=self.file_name,
            external_version=self.external_version,
        )


def _refresh_document(
    document: Item,
    item: DocumentItem,
    parent: Item,
    relation: str,
    source_code: str,
    connector_key: str,
) -> None:
    document.title = item.title
    document.document_type = _document_type(item, connector_key)
    document.parent_item_id = parent.id
    document.parent_relation = relation
    document.metadata_ = {
        **{key: document.metadata_[key] for key in _KEPT_METADATA if key in document.metadata_},
        **_item_metadata(item, source_code),
    }


def _upsert_resource(
    session: AsyncSession,
    source: IngestionSource,
    resource: ExternalResource | None,
    *,
    item: AnyItem,
    item_id: UUID,
    approved: bool,
) -> None:
    """Record the provider identity; ``approved`` false keeps the published version.

    Under REVIEW_FIRST a proposed version becomes the resource's version only
    when its contribution is approved.
    """
    values: dict[str, Any] = {
        "item_id": item_id,
        "source_url": item.source.url,
        "metadata_": {"canonical_external_id": item.id},
        "last_seen_at": datetime.now(UTC),
        "deleted_at": None,
    }
    if approved or resource is None:
        values.update(
            external_version=item.source.external_version,
            etag=item.source.etag,
            external_updated_at=item.updated_at,
        )
    if resource is None:
        session.add(
            ExternalResource(
                ingestion_source_id=source.id,
                external_id=_required(item.source.external_id, "external id"),
                **values,
            )
        )
        return
    for attribute, value in values.items():
        setattr(resource, attribute, value)


async def soft_delete_external_resource(
    session: AsyncSession, source_id: UUID, external_id: str
) -> Item | None:
    """Tombstone the resource and, for a live Document, its Item with its live subtree.

    ``ItemService.delete_cohort`` stamps one ``deleted_at``, retires links and
    citations and marks the index payloads dirty.
    """
    external_resource = await session.scalar(
        select(ExternalResource)
        # Every resource has its Item; an inner join lets both rows lock.
        .options(joinedload(ExternalResource.item, innerjoin=True))
        .where(
            ExternalResource.ingestion_source_id == source_id,
            ExternalResource.external_id == _required(external_id, "external id"),
            ExternalResource.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if external_resource is None:
        return None
    external_resource.deleted_at = datetime.now(UTC)
    item = external_resource.item
    if item.item_type == "document" and item.deleted_at is None:
        items = ItemService(session)
        await items.delete_cohort(await items.live_subtree(item))
    await session.flush()
    return item


async def _ingestion_source(session: AsyncSession, source_id: UUID) -> IngestionSource:
    """The Source a registration writes to; refused once it may no longer sync."""
    source = await session.scalar(
        select(IngestionSource)
        .options(
            joinedload(IngestionSource.integration_connection),
            joinedload(IngestionSource.target_item),
        )
        .where(IngestionSource.id == source_id)
    )
    if source is None:
        raise FailedPrecondition("This source was deleted.")
    refusal = await sync_refusal(session, source)
    if refusal is not None:
        raise FailedPrecondition(refusal)
    target = source.target_item
    if (
        target.item_type != "collection"
        or target.deleted_at is not None
        or target.tenant_id != source.tenant_id
    ):
        raise FailedPrecondition("The target collection of this source was deleted.")
    return source


async def _locked_resource(
    session: AsyncSession, source_id: UUID, external_id: str
) -> ExternalResource | None:
    return await session.scalar(
        select(ExternalResource)
        .where(
            ExternalResource.ingestion_source_id == source_id,
            ExternalResource.external_id == _required(external_id, "external id"),
        )
        .with_for_update()
    )


async def _resource_by_identity(
    session: AsyncSession, source_id: UUID, identity: str
) -> ExternalResource | None:
    normalized = _required(identity, "parent external id")
    return await session.scalar(
        select(ExternalResource).where(
            ExternalResource.ingestion_source_id == source_id,
            ExternalResource.deleted_at.is_(None),
            or_(
                ExternalResource.external_id == normalized,
                ExternalResource.metadata_["canonical_external_id"].astext == normalized,
            ),
        )
    )


async def _parent(
    session: AsyncSession, source: IngestionSource, item: DocumentItem
) -> tuple[Item, str]:
    """The Item a Document hangs under: a parent Document of the source, else the target."""
    parent_id = item.hierarchy.parent_id
    if parent_id:
        resource = await _resource_by_identity(session, source.id, parent_id)
        if resource is not None and resource.item_id != source.target_item_id:
            parent = await session.get(Item, resource.item_id)
            if (
                parent is not None
                and parent.item_type == "document"
                and parent.deleted_at is None
            ):
                return parent, _parent_relation(item)
    return source.target_item, "contains"


async def _governing_collection(session: AsyncSession, item_id: UUID) -> UUID:
    for node in await item_ancestry(session, item_id):
        if node.item_type == "collection":
            return node.item_id
    raise FailedPrecondition("The document has no governing collection.")


def _document_id(source_id: UUID, identity: str) -> UUID:
    """The stable ID of a source Document: rediscovery keeps the same Item."""
    normalized = _required(identity, "external identity")
    return uuid5(NAMESPACE_URL, f"{_NS}:external-resource:{source_id}:{normalized}")


def _item_metadata(item: AnyItem, source_code: str) -> dict[str, Any]:
    """Connector metadata plus ``metadata.source``: what makes a Document source-managed."""
    path = item.metadata.get("path")
    return {
        **{
            key: value
            for key, value in item.metadata.items()
            if key not in _RESERVED_METADATA
        },
        "source": {
            **item.source.model_dump(mode="json"),
            "source_code": source_code,
            "path": path if isinstance(path, str) else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        },
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


def _required(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} must not be blank")
    return normalized


def _failure_entry(failure: PipelineFailure) -> dict[str, Any]:
    """One ``ingestion_syncs.failures`` entry; never the raw provider message."""
    if failure.operation == "hierarchy":
        return {
            "external_id": None,
            "display_name": None,
            "message": "The source's folders could not be read. The next sync tries again.",
        }
    return {
        "external_id": failure.item_id,
        "display_name": None,
        "message": "This document could not be synced. The next sync tries again.",
    }


def _sync_error(exc: BaseException) -> dict[str, Any]:
    """Why a sync stopped, as a google.rpc.Status a source manager can act on."""
    if isinstance(exc, ConnectionAuthorizationRequiredError):
        return _status(
            StatusCode.FAILED_PRECONDITION,
            "The account behind this source needs to be reconnected.",
        )
    if isinstance(exc, FailedPrecondition):
        # Our own refusals are written for the source's manager.
        return _status(StatusCode.FAILED_PRECONDITION, exc.message)
    if isinstance(exc, InvalidArgument):
        return _status(
            StatusCode.INVALID_ARGUMENT,
            "This source's settings are not valid. Check the source and its connection.",
        )
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status in {401, 403}:
        return _status(
            StatusCode.PERMISSION_DENIED,
            "The source refused access. Reconnect the account or check its permissions.",
        )
    if status == 404:
        return _status(
            StatusCode.NOT_FOUND,
            "The selected content was not found at the source. It may have been moved or deleted.",
        )
    if status == 429:
        return _status(
            StatusCode.RESOURCE_EXHAUSTED,
            "The source is limiting requests. Try again later.",
        )
    if isinstance(status, int) and status >= 500:
        return _status(
            StatusCode.UNAVAILABLE, "The source is unavailable right now. Try again later."
        )
    if isinstance(exc, (httpx.TransportError, OSError)):
        return _status(
            StatusCode.UNAVAILABLE, "The source could not be reached. Try again later."
        )
    return _status(
        StatusCode.INTERNAL,
        "The sync stopped unexpectedly. Try again; if it keeps failing, reconnect the account.",
    )


def _status(code: StatusCode, message: str) -> dict[str, Any]:
    return {"code": int(code), "message": message}


__all__ = [
    "SourceSyncResult",
    "SourceSyncService",
    "soft_delete_external_resource",
]
