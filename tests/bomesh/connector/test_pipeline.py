from __future__ import annotations

import asyncio

import pytest

from bomesh.connector.base import BaseSourceConnector
from bomesh.connector.pipeline import (
    ConnectorPipeline,
    ConnectorPipelineConfig,
    Registration,
)
from bomesh.connector.protocol import (
    ChangeType,
    CollectionItem,
    CollectionKind,
    ConnectorCheckpoint,
    ConnectorScope,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    ItemChange,
    SourceCheckpoint,
    SourceIdentity,
    SourceProvider,
    StorageObject,
)


class RecordingSink:
    """The inventory side of a sync: it only ever registers and removes."""

    def __init__(self, *, current: dict[str, str] | None = None) -> None:
        self.collections: list[str] = []
        self.documents: list[DocumentItem] = []
        self.removed: list[str] = []
        self.current = dict(current or {})

    async def register_collection(self, item: CollectionItem) -> None:
        self.collections.append(item.id)

    async def register_document(self, item: DocumentItem) -> Registration:
        known = item.id in self.current
        self.documents.append(item)
        self.current[item.id] = item.source.external_version or ""
        return Registration.UPDATED if known else Registration.ADDED

    async def is_current(self, external_id: str, version: str) -> bool:
        return self.current.get(external_id) == version

    async def remove(self, external_id: str) -> bool:
        self.removed.append(external_id)
        return True


class StubConnector(BaseSourceConnector):
    source = "file"
    checkpoint_model = SourceCheckpoint

    def __init__(
        self,
        *,
        fail_document: str | None = None,
        unstored_document: str | None = None,
    ) -> None:
        self.fail_document = fail_document
        self.unstored_document = unstored_document
        self.fetched: list[str] = []
        self.active_fetches = 0
        self.max_active_fetches = 0
        self._next = SourceCheckpoint(cursor="complete")

    async def test_connection(self) -> bool:
        return True

    async def list_scopes(self) -> list[ConnectorScope]:
        return [SCOPE]

    async def discover_changes(
        self, checkpoint: ConnectorCheckpoint, scope: ConnectorScope
    ) -> list[ItemChange]:
        del checkpoint, scope
        return [
            ItemChange(type=ChangeType.CREATED, item_id="doc-1", provider_version="v1"),
            ItemChange(type=ChangeType.CREATED, item_id="doc-2", provider_version="v1"),
            ItemChange(type=ChangeType.DELETED, item_id="doc-old"),
            ItemChange(type=ChangeType.UPDATED, item_id="doc-1", provider_version="v1"),
            ItemChange(type=ChangeType.CREATED, item_id="doc-3", provider_version="v1"),
        ]

    async def fetch_item(self, item_id: str) -> DocumentItem:
        self.fetched.append(item_id)
        self.active_fetches += 1
        self.max_active_fetches = max(self.max_active_fetches, self.active_fetches)
        try:
            await asyncio.sleep(0.01)
            if item_id == self.fail_document:
                raise RuntimeError("source failed")
            return DocumentItem(
                id=item_id,
                title=f"{item_id}.pdf",
                document_kind=DocumentKind.PDF,
                source=SourceIdentity(
                    connector_id="connector-1",
                    provider=SourceProvider.FILE,
                    external_id=item_id,
                    external_version="v1",
                ),
                hierarchy=Hierarchy(parent_id="root"),
                original=(
                    None
                    if item_id == self.unstored_document
                    else StorageObject(
                        key=f"originals/{item_id}.pdf",
                        content_type="application/pdf",
                        size_bytes=3,
                    )
                ),
            )
        finally:
            self.active_fetches -= 1

    async def fetch_hierarchy(self, scope: ConnectorScope) -> list[CollectionItem]:
        del scope
        return [
            CollectionItem(
                id="root",
                title="Root",
                collection_kind=CollectionKind.FOLDER,
                source=SourceIdentity(
                    connector_id="connector-1",
                    provider=SourceProvider.FILE,
                    external_id="root",
                ),
            )
        ]

    def next_checkpoint(self) -> ConnectorCheckpoint:
        return self._next


SCOPE = ConnectorScope(scope_type="folder", scope_value="root", display_name="Root")


@pytest.mark.asyncio
async def test_pipeline_registers_changes_with_bounded_fetches_and_advances_checkpoint() -> None:
    connector = StubConnector()
    sink = RecordingSink()
    pipeline = ConnectorPipeline(
        connector, sink, config=ConnectorPipelineConfig(fetch_concurrency=2)
    )

    result = await pipeline.run_scope(SCOPE, SourceCheckpoint())

    assert result.discovered_changes == 4
    assert (result.added, result.updated, result.unchanged, result.removed) == (3, 0, 0, 1)
    assert result.checkpoint_advanced is True
    assert result.checkpoint == SourceCheckpoint(cursor="complete")
    assert connector.max_active_fetches == 2
    assert sink.collections == ["root"]
    assert sink.removed == ["doc-old"]
    # Registration keeps discovery order (the duplicate moved to its latest place).
    assert [item.id for item in sink.documents] == ["doc-2", "doc-1", "doc-3"]
    assert all(item.original is not None for item in sink.documents)


@pytest.mark.asyncio
async def test_pipeline_does_not_download_a_version_already_registered() -> None:
    connector = StubConnector()
    sink = RecordingSink(current={"doc-2": "v1"})

    result = await ConnectorPipeline(connector, sink).run_scope(SCOPE, SourceCheckpoint())

    assert "doc-2" not in connector.fetched
    assert (result.added, result.unchanged) == (2, 1)
    assert result.checkpoint_advanced is True


@pytest.mark.asyncio
async def test_pipeline_keeps_registering_after_a_failure_but_holds_the_checkpoint() -> None:
    initial = SourceCheckpoint(cursor="before")
    connector = StubConnector(fail_document="doc-2", unstored_document="doc-3")
    sink = RecordingSink()
    pipeline = ConnectorPipeline(
        connector, sink, config=ConnectorPipelineConfig(fetch_hierarchy=False)
    )

    result = await pipeline.run_scope(SCOPE, initial)

    assert result.checkpoint_advanced is False
    assert result.checkpoint == initial
    assert [item.id for item in sink.documents] == ["doc-1"]
    assert result.added == 1
    # A Document is only registered with its stored original.
    assert [(failure.item_id, failure.operation) for failure in result.failures] == [
        ("doc-2", "fetch"),
        ("doc-3", "fetch"),
    ]
