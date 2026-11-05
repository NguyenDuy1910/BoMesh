"""The source sync engine (``SourceSyncService``) with a stub connector.

Migrated from the legacy ``tests/bomesh/services/test_source_sync.py``: real
PostgreSQL, ``ItemService`` and pipeline; only the provider is stubbed.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select

from bomesh.connector import ConnectorDefinition
from bomesh.connector.base import BaseSourceConnector
from bomesh.connector.originals import original_key, store_original
from bomesh.connector.protocol import (
    ChangeType,
    Chunk,
    CitationInfo,
    CitationSpan,
    ConnectorCheckpoint,
    ConnectorScope,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    ItemChange,
    SourceCheckpoint,
    SourceIdentity,
    SourceProvider,
)
from bomesh.connector.registry import ConnectorRegistry
from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Citation,
    Contribution,
    ExternalResource,
    IngestionRun,
    IngestionSource,
    IngestionSync,
    Item,
    ItemRevision,
)
from bomesh.services.knowledge_items.citations import CitationService
from bomesh.services.ingestion.source_store import load_source, start_sync
from bomesh.services.ingestion.credentials import IntegrationCredentialService
from bomesh.services.ingestion.source_sync import SourceSyncService
from fakes import FakeObjectStorage
from harness import ENCRYPTION_KEY, Fakes, Sessions, World
from sources_support import make_connection

pytestmark = pytest.mark.asyncio

SCOPE = ConnectorScope(scope_type="folder", scope_value="root", display_name="Root")


@dataclass
class ProviderState:
    """What the provider holds; tests change it between syncs."""

    files: dict[str, tuple[str, bytes]] = field(default_factory=dict)
    deleted: list[str] = field(default_factory=list)
    unreadable: set[str] = field(default_factory=set)
    error: Exception | None = None
    rotated: dict[str, Any] | None = None
    #: Checkpoints the connector was started from, in order.
    started_from: list[SourceCheckpoint] = field(default_factory=list)
    fetched: list[str] = field(default_factory=list)


class StubConnector(BaseSourceConnector):
    """An incremental connector: a stored cursor reports only what changed since."""

    source = SourceProvider.FILE.value
    checkpoint_model = SourceCheckpoint

    def __init__(self, state: ProviderState, config: dict[str, Any]) -> None:
        self._state = state
        self._tenant_id = config["_tenant_id"]
        self._connection_id = config["_integration_connection_id"]
        self._storage: Any = None

    def set_storage(self, storage: Any) -> None:
        self._storage = storage

    @property
    def refreshed_credentials(self) -> dict[str, Any] | None:
        return self._state.rotated

    async def test_connection(self) -> bool:
        return True

    async def list_scopes(self) -> list[ConnectorScope]:
        return [SCOPE]

    async def discover_changes(
        self, checkpoint: ConnectorCheckpoint, scope: ConnectorScope
    ) -> list[ItemChange]:
        assert isinstance(checkpoint, SourceCheckpoint)
        self._state.started_from.append(checkpoint)
        if self._state.error is not None:
            raise self._state.error
        known = checkpoint.versions
        changes = [
            ItemChange(type=ChangeType.UPDATED, item_id=file_id, provider_version=version)
            for file_id, (version, _) in self._state.files.items()
            if known.get(file_id) != version
        ]
        # Like Drive's Changes API, deletions are only reported incrementally.
        if checkpoint.cursor is not None:
            changes += [
                ItemChange(type=ChangeType.DELETED, item_id=file_id)
                for file_id in self._state.deleted
            ]
        return changes

    async def fetch_item(self, item_id: str) -> DocumentItem:
        self._state.fetched.append(item_id)
        if item_id in self._state.unreadable:
            raise RuntimeError("download failed: https://internal.example/secret?token=x")
        version, data = self._state.files[item_id]
        file_name = f"{item_id}.txt"
        original = store_original(
            self._storage,
            key=original_key(
                tenant_id=self._tenant_id,
                connection_id=self._connection_id,
                provider=self.source,
                external_id=item_id,
                version=version,
                file_name=file_name,
            ),
            file_name=file_name,
            content_type="text/plain",
            data=data,
        )
        return DocumentItem(
            id=item_id,
            title=file_name,
            document_kind=DocumentKind.DOCUMENT,
            source=SourceIdentity(
                connector_id=self._connection_id,
                provider=SourceProvider.FILE,
                external_id=item_id,
                external_version=version,
                url=f"https://files.example/{item_id}",
            ),
            hierarchy=Hierarchy(parent_id="root"),
            metadata={"owner": "ops"},
            original=original,
        )

    def next_checkpoint(self) -> ConnectorCheckpoint:
        return SourceCheckpoint(
            cursor=f"after-{len(self._state.started_from)}",
            versions={file_id: version for file_id, (version, _) in self._state.files.items()},
        )


class RecordingIndex:
    """A sync may remove a deleted Document's content; it never indexes."""

    def __init__(self) -> None:
        self.removed: list[tuple[str, str]] = []

    async def remove_item_content(self, item_id: str, *, tenant_id: str) -> None:
        self.removed.append((item_id, tenant_id))


@dataclass
class Engine:
    sessions: Sessions
    source_id: UUID
    tenant_id: UUID
    collection_id: UUID
    connection_id: UUID
    state: ProviderState
    storage: FakeObjectStorage
    index: RecordingIndex
    service: SourceSyncService

    async def sync(self) -> Any:
        async with transaction_scope(self.sessions) as session:
            source = await load_source(session, self.source_id)
            assert source is not None
            sync = await start_sync(session, source, trigger="manual")
        return await self.service.sync(sync.id)

    async def documents(self) -> dict[str, Item]:
        async with self.sessions() as session:
            rows = await session.execute(
                select(ExternalResource.external_id, Item)
                .join(Item, Item.id == ExternalResource.item_id)
                .where(ExternalResource.ingestion_source_id == self.source_id)
            )
            return {external_id: item for external_id, item in rows.all()}

    async def source(self) -> IngestionSource:
        async with self.sessions() as session:
            source = await session.get(IngestionSource, self.source_id)
        assert source is not None
        return source

    async def latest_sync(self) -> IngestionSync:
        async with self.sessions() as session:
            sync = await session.scalar(
                select(IngestionSync)
                .where(IngestionSync.ingestion_source_id == self.source_id)
                .order_by(IngestionSync.started_at.desc())
                .limit(1)
            )
        assert sync is not None
        return sync

    async def contributions(self) -> list[Contribution]:
        async with self.sessions() as session:
            return list(
                await session.scalars(
                    select(Contribution)
                    .where(Contribution.ingestion_source_id == self.source_id)
                    .order_by(Contribution.created_at)
                )
            )

    async def set_policy(self, policy: str) -> None:
        async with self.sessions.begin() as session:
            source = await session.get(IngestionSource, self.source_id)
            assert source is not None
            source.publishing_policy = policy


@pytest.fixture
def registry() -> Iterator[ProviderState]:
    state = ProviderState()
    original = ConnectorRegistry.default
    stub = ConnectorRegistry(
        (
            ConnectorDefinition(
                key="file",
                display_name="Files",
                description="Stub files",
                authentication_type="none",
                factory=lambda connection, _source, _credentials: StubConnector(
                    state, dict(connection)
                ),
            ),
        )
    )
    ConnectorRegistry.default = staticmethod(lambda: stub)  # type: ignore[method-assign]
    try:
        yield state
    finally:
        ConnectorRegistry.default = original  # type: ignore[method-assign]


@pytest_asyncio.fixture
async def engine(world: World, sessions: Sessions, fakes: Fakes, registry: ProviderState) -> Engine:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace, title="Shared files")
    connection = await make_connection(sessions, workspace, "files", connector_key="file")
    async with sessions.begin() as session:
        source = IngestionSource(
            tenant_id=workspace.id,
            code="files",
            integration_connection_id=connection.id,
            target_item_id=collection.id,
            resource_type="folder",
            external_resource_id="root",
        )
        session.add(source)
        await session.flush()
        source_id = source.id
    index = RecordingIndex()
    service = SourceSyncService(
        sessions,
        index=index,  # type: ignore[arg-type]
        raw_storage=fakes.storage,  # type: ignore[arg-type]
        providers=fakes.providers,
        credential_encryption_key=ENCRYPTION_KEY,
    )
    return Engine(
        sessions,
        source_id,
        workspace.id,
        collection.id,
        connection.id,
        registry,
        fakes.storage,
        index,
        service,
    )


async def _mark_processed(engine: Engine, item_id: UUID) -> None:
    async with engine.sessions.begin() as session:
        item = await session.get(Item, item_id)
        assert item is not None
        item.index_status = "ready"
        item.processed_version = "pv-1"
        item.metadata_ = {**item.metadata_, "preview": {"pages": 1}}


async def test_a_sync_registers_new_files_as_pending_documents_and_processes_nothing(
    engine: Engine,
) -> None:
    engine.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta")}

    result = await engine.sync()

    assert (result.added, result.updated, result.removed, result.failed) == (2, 0, 0, 0)
    documents = await engine.documents()
    assert sorted(documents) == ["a", "b"]
    # Stable provider identity: rediscovery after a tombstone keeps the same Item.
    assert documents["a"].id == uuid5(
        NAMESPACE_URL, f"{PERSISTED_IDENTITY_NAMESPACE}:external-resource:{engine.source_id}:a"
    )
    for external_id, document in documents.items():
        assert document.parent_item_id == engine.collection_id
        assert (document.publication_state, document.index_status) == ("published", "pending")
        assert document.storage_key is not None
        assert engine.storage.objects[document.storage_key].data == engine.state.files[external_id][1]
        assert document.metadata_["file_name"] == f"{external_id}.txt"
        assert document.metadata_["source"]["external_version"] == "v1"
        assert document.metadata_["source"]["source_code"] == "files"
        assert document.metadata_["source"]["connector_id"] == str(engine.connection_id)
    async with engine.sessions() as session:
        revisions = list(await session.scalars(select(ItemRevision)))
        assert await session.scalar(select(func.count()).select_from(IngestionRun)) == 0
    assert sorted((r.revision_number, r.external_version) for r in revisions) == [
        (1, "v1"),
        (1, "v1"),
    ]
    sync = await engine.latest_sync()
    assert (sync.status, sync.added_count, sync.error) == ("succeeded", 2, None)


async def test_the_checkpoint_is_persisted_and_reused(engine: Engine) -> None:
    engine.state.files = {"a": ("v1", b"alpha")}
    await engine.sync()
    stored = (await engine.source()).sync_checkpoint

    engine.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta")}
    second = await engine.sync()

    assert stored == {"cursor": "after-1", "updated_at": None, "versions": {"a": "v1"}}
    assert engine.state.started_from[0] == SourceCheckpoint()
    assert engine.state.started_from[1] == SourceCheckpoint.model_validate(stored)
    # Only the new file was fetched: the cursor knew "a".
    assert engine.state.fetched == ["a", "b"]
    assert (second.added, second.updated) == (1, 0)
    assert (await engine.source()).sync_checkpoint["versions"] == {"a": "v1", "b": "v1"}


async def test_a_sync_with_failures_keeps_the_previous_checkpoint(engine: Engine) -> None:
    engine.state.files = {"a": ("v1", b"alpha")}
    await engine.sync()
    before = (await engine.source()).sync_checkpoint
    engine.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta")}
    engine.state.unreadable = {"b"}

    result = await engine.sync()

    assert result.failed == 1
    assert (await engine.source()).sync_checkpoint == before
    sync = await engine.latest_sync()
    assert sync.failures == [
        {
            "external_id": "b",
            "display_name": None,
            "message": "This document could not be synced. The next sync tries again.",
        }
    ]
    engine.state.unreadable = set()
    retried = await engine.sync()
    assert (retried.added, retried.failed) == (1, 0)


async def test_a_drive_style_deletion_removes_the_document(engine: Engine) -> None:
    engine.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta")}
    await engine.sync()
    removed_id = (await engine.documents())["a"].id
    async with engine.sessions.begin() as session:
        await CitationService(session).replace_for_item(
            removed_id,
            [
                Chunk(
                    id=f"{removed_id}:0",
                    item_id=str(removed_id),
                    chunk_index=0,
                    chunk_text="alpha",
                    content_type="text",
                    citation=CitationInfo(spans=(CitationSpan(element_id="p1"),)),
                )
            ],
        )
    engine.state.files = {"b": ("v1", b"beta")}
    engine.state.deleted = ["a"]

    result = await engine.sync()

    assert result.removed == 1
    documents = await engine.documents()
    assert documents["a"].deleted_at is not None
    assert documents["b"].deleted_at is None
    assert engine.index.removed == [(str(removed_id), str(engine.tenant_id))]
    async with engine.sessions() as session:
        live_citations = await session.scalar(
            select(func.count())
            .select_from(Citation)
            .where(Citation.item_id == removed_id, Citation.deleted_at.is_(None))
        )
        resource = await session.scalar(
            select(ExternalResource).where(ExternalResource.item_id == removed_id)
        )
    assert live_citations == 0
    assert resource is not None and resource.deleted_at is not None


async def test_auto_publish_appends_a_revision_per_provider_version(engine: Engine) -> None:
    engine.state.files = {"a": ("v1", b"alpha")}
    await engine.sync()
    document = (await engine.documents())["a"]
    first_key = document.storage_key
    await _mark_processed(engine, document.id)

    unchanged = await engine.sync()
    engine.state.files = {"a": ("v2", b"alpha, edited")}
    changed = await engine.sync()

    assert (unchanged.added, unchanged.updated) == (0, 0)
    assert (changed.added, changed.updated) == (0, 1)
    edited = (await engine.documents())["a"]
    assert edited.index_status == "pending"
    assert "preview" not in edited.metadata_
    assert edited.storage_key != first_key
    assert engine.storage.objects[edited.storage_key].data == b"alpha, edited"
    assert engine.storage.objects[first_key].data == b"alpha"  # never overwritten
    async with engine.sessions() as session:
        revisions = list(
            await session.scalars(
                select(ItemRevision)
                .where(ItemRevision.item_id == document.id)
                .order_by(ItemRevision.revision_number)
            )
        )
    assert [(r.revision_number, r.external_version) for r in revisions] == [(1, "v1"), (2, "v2")]


async def test_review_first_new_file_lands_unpublished_with_a_source_contribution(
    engine: Engine,
) -> None:
    await engine.set_policy("review_first")
    engine.state.files = {"a": ("v1", b"alpha")}

    await engine.sync()

    document = (await engine.documents())["a"]
    assert (document.parent_item_id, document.publication_state) == (
        engine.collection_id,
        "unpublished",
    )
    [contribution] = await engine.contributions()
    assert (
        contribution.item_id,
        contribution.kind,
        contribution.origin,
        contribution.state,
        contribution.target_item_id,
        contribution.replaces_item_id,
        contribution.external_version,
    ) == (document.id, "new_document", "source", "in_review", engine.collection_id, None, None)

    # A changed UNPUBLISHED (never approved) file just gets a new revision.
    engine.state.files = {"a": ("v2", b"alpha 2")}
    await engine.sync()
    assert len(await engine.contributions()) == 1
    async with engine.sessions() as session:
        assert (
            await session.scalar(
                select(func.max(ItemRevision.revision_number)).where(
                    ItemRevision.item_id == document.id
                )
            )
            == 2
        )


async def test_review_first_changed_published_file_opens_one_candidate_per_version(
    engine: Engine,
) -> None:
    engine.state.files = {"a": ("v1", b"alpha")}
    await engine.sync()
    published = (await engine.documents())["a"]
    await engine.set_policy("review_first")

    engine.state.files = {"a": ("v2", b"alpha v2")}
    proposed = await engine.sync()
    # The same provider version again: deduped, not downloaded again.
    fetched = list(engine.state.fetched)
    async with engine.sessions.begin() as session:
        source = await session.get(IngestionSource, engine.source_id)
        assert source is not None
        source.sync_checkpoint = None  # force a full listing
    repeated = await engine.sync()
    engine.state.files = {"a": ("v3", b"alpha v3")}
    newer = await engine.sync()

    assert (proposed.updated, repeated.updated, newer.updated) == (1, 0, 1)
    assert engine.state.fetched[len(fetched) :] == ["a"]  # only v3
    still = (await engine.documents())["a"]
    assert still.id == published.id
    assert (still.publication_state, still.storage_key) == ("published", published.storage_key)
    contributions = await engine.contributions()
    assert [(c.kind, c.external_version, c.replaces_item_id) for c in contributions] == [
        ("new_revision", "v2", published.id),
        ("new_revision", "v3", published.id),
    ]
    async with engine.sessions() as session:
        candidate = await session.get(Item, contributions[0].item_id)
    assert candidate is not None and candidate.id != published.id
    assert (candidate.parent_item_id, candidate.publication_state) == (
        engine.collection_id,
        "unpublished",
    )
    assert engine.storage.objects[candidate.storage_key].data == b"alpha v2"
    assert contributions[0].target_item_id == engine.collection_id
    assert contributions[0].state == "in_review"


async def test_a_failing_sync_records_a_user_safe_error_and_keeps_rotated_credentials(
    engine: Engine,
) -> None:
    request = httpx.Request("GET", "https://internal.example/api/changes?token=secret")
    engine.state.error = httpx.HTTPStatusError(
        "403 Forbidden", request=request, response=httpx.Response(403, request=request)
    )
    engine.state.rotated = {
        "access_token": "rotated-token",
        "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }

    with pytest.raises(httpx.HTTPStatusError):
        await engine.sync()

    sync = await engine.latest_sync()
    assert (sync.status, sync.finished_at is not None) == ("failed", True)
    assert sync.error == {
        "code": 7,
        "message": "The source refused access. Reconnect the account or check its permissions.",
    }
    async with engine.sessions() as session:
        stored = await IntegrationCredentialService(session, ENCRYPTION_KEY).resolve(
            engine.connection_id
        )
    assert stored["access_token"] == "rotated-token"


async def test_scheduled_firings_open_their_own_sync_and_skip_when_blocked(
    engine: Engine,
) -> None:
    sync_id = await engine.service.begin_scheduled_sync(engine.source_id)
    busy = await engine.service.begin_scheduled_sync(engine.source_id)

    assert sync_id is not None and busy is None
    async with engine.sessions() as session:
        sync = await session.get(IngestionSync, sync_id)
    assert sync is not None and (sync.trigger_type, sync.status) == ("scheduled", "running")

    await engine.service.sync(sync_id)
    async with engine.sessions.begin() as session:
        source = await session.get(IngestionSource, engine.source_id)
        assert source is not None
        source.paused_at = datetime.now(UTC)
    assert await engine.service.begin_scheduled_sync(engine.source_id) is None
