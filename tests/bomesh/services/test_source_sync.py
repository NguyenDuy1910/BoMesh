"""A Source sync changes the knowledge inventory and never processes it.

Runs the real SourceSyncService, ItemService and PostgreSQL schema. Only the
provider (a stub connector), object storage and the index are replaced; the
index fake can only remove content, so any attempt to index fails loudly.
"""

from __future__ import annotations

import base64
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

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
from bomesh.db.models import (
    Base,
    Citation,
    ExternalResource,
    IngestionRun,
    IngestionSource,
    IntegrationConnection,
    Item,
)
from bomesh.services import AuthContext
from bomesh.services.citation import CitationService
from bomesh.services.identity_access.identity_store import IdentityStoreService
from bomesh.services.identity_access.role_assignments import RoleAssignmentService
from bomesh.services.ingestion_sources import IngestionSourceService
from bomesh.services.integration_credential import IntegrationCredentialService
from bomesh.services.item import ItemService
from bomesh.services.source_sync import SourceSyncService
from bomesh.storage import StoredObject

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required for PostgreSQL source sync tests",
)

ENCRYPTION_KEY = base64.urlsafe_b64encode(b"s" * 32).decode().rstrip("=")
SCOPE = ConnectorScope(scope_type="folder", scope_value="root", display_name="Root")


@dataclass
class FakeSource:
    """What the provider holds; tests change it between syncs."""

    files: dict[str, tuple[str, bytes]]
    deleted: list[str] = field(default_factory=list)
    #: Changes carry their Items, the way a checkpoint crawler reports them.
    embed: bool = False
    unreadable: set[str] = field(default_factory=set)
    error: Exception | None = None
    rotated: dict[str, Any] | None = None
    fetched: list[str] = field(default_factory=list)


class StubConnector(BaseSourceConnector):
    source = SourceProvider.FILE.value
    checkpoint_model = SourceCheckpoint

    def __init__(self, state: FakeSource, config: dict[str, Any]) -> None:
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
        del checkpoint, scope
        if self._state.error is not None:
            raise self._state.error
        return [
            ItemChange(
                type=ChangeType.UPDATED,
                item_id=file_id,
                provider_version=version,
                item=self._document(file_id) if self._state.embed else None,
            )
            for file_id, (version, _) in self._state.files.items()
        ] + [ItemChange(type=ChangeType.DELETED, item_id=file_id) for file_id in self._state.deleted]

    async def fetch_item(self, item_id: str) -> DocumentItem:
        self._state.fetched.append(item_id)
        return self._document(item_id)

    def next_checkpoint(self) -> ConnectorCheckpoint:
        return SourceCheckpoint(cursor=f"after-{len(self._state.files)}")

    def _document(self, file_id: str) -> DocumentItem:
        if file_id in self._state.unreadable:
            raise RuntimeError("download failed: https://internal.example/secret?token=x")
        version, data = self._state.files[file_id]
        file_name = f"{file_id}.txt"
        original = store_original(
            self._storage,
            key=original_key(
                tenant_id=self._tenant_id,
                connection_id=self._connection_id,
                provider=self.source,
                external_id=file_id,
                file_name=file_name,
            ),
            file_name=file_name,
            content_type="text/plain",
            data=data,
        )
        return DocumentItem(
            id=file_id,
            title=file_name,
            document_kind=DocumentKind.DOCUMENT,
            source=SourceIdentity(
                connector_id=self._connection_id,
                provider=SourceProvider.FILE,
                external_id=file_id,
                external_version=version,
                url=f"https://files.example/{file_id}",
            ),
            hierarchy=Hierarchy(parent_id="root"),
            metadata={"owner": "ops"},
            original=original,
        )


class RecordingStorage:
    provider = "test"
    bucket = "originals"

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_bytes(self, data: bytes, key: str, *, content_type: str | None = None) -> StoredObject:
        self.objects[key] = data
        return StoredObject(size_bytes=len(data), content_type=content_type)

    def put_path(self, path: Path, key: str, *, content_type: str | None = None) -> StoredObject:
        return self.put_bytes(path.read_bytes(), key, content_type=content_type)


class RemovalOnlyIndex:
    """A sync may remove a deleted Document's content; it may never index."""

    def __init__(self) -> None:
        self.removed: list[tuple[str, str]] = []

    async def remove_item_content(self, item_id: str, *, tenant_id: str) -> None:
        self.removed.append((item_id, tenant_id))


@dataclass
class World:
    sessions: async_sessionmaker[AsyncSession]
    tenant_id: UUID
    collection_id: UUID
    connection_id: UUID
    source_id: UUID
    state: FakeSource
    storage: RecordingStorage
    index: RemovalOnlyIndex
    service: SourceSyncService
    actor: AuthContext

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


@pytest_asyncio.fixture
async def world() -> AsyncIterator[World]:
    assert TEST_DATABASE_URL is not None
    schema = f"test_source_sync_{uuid4().hex}"
    admin_engine = create_async_engine(TEST_DATABASE_URL)
    async with admin_engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        TEST_DATABASE_URL, connect_args={"server_settings": {"search_path": schema}}
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions.begin() as session:
            identities = IdentityStoreService(session)
            await identities.sync_system_roles()
            tenant = await identities.create_tenant(f"sync-{uuid4().hex[:8]}", "Sync")
            user = await identities.create_user(f"{uuid4().hex[:8]}@example.com")
            role = await identities.create_role(
                tenant.id, "manager", "Manager", permission_codes=["source.manage"]
            )
            await identities.assign_membership(user.id, tenant.id)
            await RoleAssignmentService(session).replace_tenant_roles(
                user_id=user.id, tenant_id=tenant.id, role_ids=[role.id]
            )
            actor = await identities.get_context(user.id, tenant_id=tenant.id)
            collection = Item(
                tenant_id=tenant.id,
                item_type="collection",
                title="Shared files",
                status="ready",
                created_by_user_id=user.id,
            )
            session.add(collection)
            connection = IntegrationConnection(
                tenant_id=tenant.id,
                connector_key="file",
                owner_type="tenant",
                display_name="Shared files",
                status="connected",
                created_by_user_id=user.id,
            )
            session.add(connection)
            await session.flush()
            source = IngestionSource(
                integration_connection_id=connection.id,
                target_item_id=collection.id,
                checkpoint={},
                status="ready",
                created_by_user_id=user.id,
            )
            session.add(source)
            await session.flush()
            ids = (tenant.id, collection.id, connection.id, source.id)
        state = FakeSource(files={})
        storage = RecordingStorage()
        index = RemovalOnlyIndex()
        registry = ConnectorRegistry(
            (
                ConnectorDefinition(
                    key="file",
                    display_name="Files",
                    authentication_type="none",
                    capabilities=("documents",),
                    factory=lambda connection, _source, _credentials: StubConnector(
                        state, dict(connection)
                    ),
                ),
            )
        )
        service = SourceSyncService(
            sessions,
            index=index,  # type: ignore[arg-type]
            raw_storage=storage,  # type: ignore[arg-type]
            registry=registry,
            credential_encryption_key=ENCRYPTION_KEY,
        )
        yield World(sessions, *ids, state, storage, index, service, actor)
    finally:
        await engine.dispose()
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin_engine.dispose()


async def _mark_processed(world: World, item_id: UUID, version: str = "pv-1") -> None:
    async with world.sessions.begin() as session:
        items = ItemService(session)
        await items.mark_index_ready(item_id, processed_version=version)
        await items.merge_metadata(item_id, {"preview": {"pages": 1}})


@pytest.mark.asyncio
async def test_a_sync_registers_new_files_as_pending_documents_and_processes_nothing(
    world: World,
) -> None:
    world.state.files = {
        "a": ("v1", b"alpha"),
        "b": ("v1", b"beta"),
        "c": ("v1", b"gamma"),
    }

    result = await world.service.sync(world.source_id)

    assert (result.added, result.updated, result.removed, result.failed) == (3, 0, 0, 0)
    assert result.checkpoint_advanced is True
    documents = await world.documents()
    assert sorted(documents) == ["a", "b", "c"]
    for external_id, document in documents.items():
        assert document.item_type == "document"
        assert document.parent_item_id == world.collection_id
        assert document.index_status == "pending"
        assert document.processed_version is None
        assert document.mime_type == "text/plain"
        assert document.document_type == "word_document"
        assert document.storage_key is not None
        assert world.storage.objects[document.storage_key] == world.state.files[external_id][1]
        assert document.size_bytes == len(world.state.files[external_id][1])
        assert document.metadata_["file_name"] == f"{external_id}.txt"
        assert document.metadata_["source"]["external_id"] == external_id
        assert document.metadata_["source"]["external_version"] == "v1"
        assert document.metadata_["source"]["connector_id"] == str(world.connection_id)
    # Registration only: no index write, no Ingestion Run.
    assert world.index.removed == []
    async with world.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(IngestionRun)) == 0
    source = await world.source()
    assert source.last_sync_status == "succeeded"
    assert source.last_sync_error is None
    assert source.last_synced_at is not None
    assert source.last_sync_summary == {"added": 3, "updated": 0, "removed": 0, "failed": 0}
    assert source.checkpoint["cursor"] == "after-3"


@pytest.mark.asyncio
@pytest.mark.parametrize("embed", [False, True], ids=["fetched", "crawled"])
async def test_an_unchanged_document_keeps_its_processing_state(
    world: World, embed: bool
) -> None:
    world.state.files = {"a": ("v1", b"alpha")}
    world.state.embed = embed
    await world.service.sync(world.source_id)
    document = (await world.documents())["a"]
    await _mark_processed(world, document.id)
    fetched = list(world.state.fetched)

    result = await world.service.sync(world.source_id)

    assert (result.added, result.updated) == (0, 0)
    unchanged = (await world.documents())["a"]
    assert unchanged.index_status == "ready"
    assert unchanged.processed_version == "pv-1"
    assert unchanged.metadata_["preview"] == {"pages": 1}
    # The same version is never downloaded again.
    assert world.state.fetched == fetched
    assert (await world.source()).last_sync_summary["updated"] == 0


@pytest.mark.asyncio
async def test_a_changed_version_goes_back_to_pending(world: World) -> None:
    world.state.files = {"a": ("v1", b"alpha")}
    await world.service.sync(world.source_id)
    await _mark_processed(world, (await world.documents())["a"].id)
    world.state.files = {"a": ("v2", b"alpha, edited")}

    result = await world.service.sync(world.source_id)

    assert (result.added, result.updated) == (0, 1)
    changed = (await world.documents())["a"]
    assert changed.index_status == "pending"
    assert "preview" not in changed.metadata_
    assert world.storage.objects[changed.storage_key] == b"alpha, edited"
    assert changed.metadata_["source"]["external_version"] == "v2"


@pytest.mark.asyncio
async def test_a_deletion_tombstones_the_document_and_removes_its_index_content(
    world: World,
) -> None:
    world.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta")}
    await world.service.sync(world.source_id)
    removed_id = (await world.documents())["a"].id
    async with world.sessions.begin() as session:
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
    world.state.files = {"b": ("v1", b"beta")}
    world.state.deleted = ["a"]

    result = await world.service.sync(world.source_id)

    assert result.removed == 1
    documents = await world.documents()
    assert documents["a"].status == "deleted"
    assert documents["a"].deleted_at is not None
    assert documents["b"].status == "ready"
    assert world.index.removed == [(str(removed_id), str(world.tenant_id))]
    async with world.sessions() as session:
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


@pytest.mark.asyncio
async def test_an_unreadable_document_is_counted_and_retried_by_the_next_sync(
    world: World,
) -> None:
    world.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta")}
    world.state.unreadable = {"b"}

    result = await world.service.sync(world.source_id)

    assert (result.added, result.failed) == (1, 1)
    assert result.checkpoint_advanced is False
    source = await world.source()
    assert source.last_sync_status == "succeeded"
    assert source.last_sync_error == "1 document could not be synced. The next sync tries again."
    assert source.last_sync_summary["failed"] == 1
    assert source.checkpoint == {}

    world.state.unreadable = set()
    retried = await world.service.sync(world.source_id)

    assert (retried.added, retried.failed) == (1, 0)
    assert (await world.source()).last_sync_error is None


@pytest.mark.asyncio
async def test_a_failing_sync_records_failed_with_a_user_safe_error_and_keeps_rotated_credentials(
    world: World,
) -> None:
    request = httpx.Request("GET", "https://internal.example/api/changes?token=secret")
    world.state.error = httpx.HTTPStatusError(
        "403 Forbidden for https://internal.example/api/changes?token=secret",
        request=request,
        response=httpx.Response(403, request=request),
    )
    world.state.rotated = {
        "access_token": "rotated-token",
        "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }

    with pytest.raises(httpx.HTTPStatusError):
        await world.service.sync(world.source_id)

    source = await world.source()
    assert source.last_sync_status == "failed"
    assert source.last_sync_error == (
        "The source refused access. Reconnect the account or check its permissions."
    )
    assert source.last_synced_at is not None
    assert source.last_sync_summary == {"added": 0, "updated": 0, "removed": 0, "failed": 0}
    async with world.sessions() as session:
        stored = await IntegrationCredentialService(session, ENCRYPTION_KEY).resolve(
            world.connection_id
        )
    assert stored["access_token"] == "rotated-token"


@pytest.mark.asyncio
async def test_the_source_shows_its_latest_sync_and_the_documents_waiting_for_processing(
    world: World,
) -> None:
    world.state.files = {"a": ("v1", b"alpha"), "b": ("v1", b"beta"), "c": ("v1", b"gamma")}
    async with world.sessions.begin() as session:
        before = await IngestionSourceService(session).get_source(world.actor, world.source_id)
    await world.service.sync(world.source_id)
    documents = await world.documents()
    await _mark_processed(world, documents["a"].id, "pv-current")
    await _mark_processed(world, documents["b"].id, "pv-previous")

    async with world.sessions.begin() as session:
        source = await IngestionSourceService(
            session, processing_version="pv-current"
        ).get_source(world.actor, world.source_id)

    assert before["sync"] is None
    assert before["pending_documents"] == 0
    # c is pending and b is outdated; a is ready at the current version.
    assert source["pending_documents"] == 2
    assert source["sync"]["status"] == "succeeded"
    assert source["sync"]["last_synced_at"] is not None
    assert (source["sync"]["added"], source["sync"]["failed"]) == (3, 0)
