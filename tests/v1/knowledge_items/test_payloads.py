"""Index payloads follow PostgreSQL durably: ``payload_dirty_at`` (``item_model.md`` §4.10).

A move, (un)publish, delete or undelete marks the documents dirty in its own
transaction; the post-commit update clears the mark, and
``reconcile_dirty_payloads`` retries whatever did not land.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select, update

from bomesh.services.knowledge_items.indexing import reconcile_dirty_payloads
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Citation, Item
from bomesh.document_index import IndexingContext
from bomesh.services.knowledge_items.item_store import Cohort, ItemService
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from harness import Fakes, World
from knowledge_support import Knowledge, item_name, item_url

pytestmark = pytest.mark.asyncio


class _Outage(Exception):
    pass


async def _setup(world: World, knowledge: Knowledge):
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    handbook = await world.make_collection(workspace, title="Handbook")
    archive = await world.make_collection(workspace, title="Archive")
    document = await world.make_document(handbook, title="Policy")
    await knowledge.index(document, ["leave policy"])
    return admin, workspace, handbook, archive, document


def _fail_payload_updates(fakes: Fakes, monkeypatch: pytest.MonkeyPatch) -> None:
    async def outage(*args, **kwargs):
        raise _Outage

    monkeypatch.setattr(fakes.index_backend, "set_item_payload", outage)


async def test_publish_and_move_update_the_payload_and_clear_the_mark(
    client, world: World, knowledge: Knowledge
) -> None:
    admin, _, _, archive, document = await _setup(world, knowledge)
    api = await client.as_(admin)

    unpublished = await api.post(item_url(document, ":unpublish"), json={})
    moved = await api.post(
        item_url(document, ":move"), json={"destinationParent": item_name(archive)}
    )

    assert (unpublished.status_code, moved.status_code) == (200, 200)
    payload = knowledge.payload(document)
    assert payload["published"] is False
    assert payload["collection_item_id"] == str(archive.id)
    assert (await knowledge.row(document)).payload_dirty_at is None


async def test_a_failed_payload_update_stays_dirty_until_reconciled(
    client,
    runtime,
    world: World,
    knowledge: Knowledge,
    fakes: Fakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin, _, _, archive, document = await _setup(world, knowledge)
    api = await client.as_(admin)
    _fail_payload_updates(fakes, monkeypatch)

    moved = await api.post(
        item_url(document, ":move"), json={"destinationParent": item_name(archive)}
    )

    assert moved.status_code == 200
    assert moved.json()["parentItem"] == item_name(archive)
    assert (await knowledge.row(document)).payload_dirty_at is not None
    assert knowledge.payload(document)["collection_item_id"] != str(archive.id)

    monkeypatch.undo()
    cleaned = await reconcile_dirty_payloads(runtime.sessions(), runtime.item_index())

    assert cleaned == 1
    assert knowledge.payload(document)["collection_item_id"] == str(archive.id)
    assert (await knowledge.row(document)).payload_dirty_at is None
    assert await reconcile_dirty_payloads(runtime.sessions(), runtime.item_index()) == 0


async def test_delete_and_undelete_tombstone_and_restore_points(
    client, world: World, knowledge: Knowledge, fakes: Fakes
) -> None:
    admin, _, handbook, _, document = await _setup(world, knowledge)
    api = await client.as_(admin)

    deleted = await api.delete(item_url(handbook), params={"force": "true"})
    assert deleted.status_code == 200
    assert fakes.index_backend.live_points(document.id) == []
    assert knowledge.payload(document)["is_deleted"] is True

    restored = await api.post(item_url(handbook, ":undelete"), json={})
    assert restored.status_code == 200
    assert len(fakes.index_backend.live_points(document.id)) == 1
    assert (await knowledge.row(document)).payload_dirty_at is None


async def test_undelete_of_purged_points_waits_for_a_new_run(
    client, world: World, knowledge: Knowledge, fakes: Fakes
) -> None:
    admin, _, _, _, document = await _setup(world, knowledge)
    api = await client.as_(admin)
    await api.delete(item_url(document))
    await fakes.index_backend.delete_item_points(str(document.id), tenant_id=str(document.tenant_id))

    restored = await api.post(item_url(document, ":undelete"), json={})

    assert restored.status_code == 200
    assert restored.json()["document"]["indexingState"] == "PENDING"


async def test_a_newer_mark_is_never_cleared_by_an_older_update(
    runtime, world: World, knowledge: Knowledge
) -> None:
    _, _, _, _, document = await _setup(world, knowledge)
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == document.id).values(payload_dirty_at=Item.created_at)
        )
    payloads = ItemIngestionService(knowledge.sessions, index=runtime.item_index())
    original = payloads._index.apply_item_payload

    async def mark_again_meanwhile(*args, **kwargs):
        await original(*args, **kwargs)
        async with transaction_scope(knowledge.sessions) as session:
            await session.execute(
                update(Item).where(Item.id == document.id).values(payload_dirty_at=Item.updated_at)
            )

    payloads._index.apply_item_payload = mark_again_meanwhile  # type: ignore[method-assign]

    assert await payloads.sync_payloads([document.id]) == 0
    assert (await knowledge.row(document)).payload_dirty_at is not None


async def test_processing_keeps_the_index_pending_when_the_revision_changed(
    world: World, knowledge: Knowledge
) -> None:
    _, _, _, _, document = await _setup(world, knowledge)
    first = await knowledge.add_revision(document, key="objects/one")
    await knowledge.index(document, ["first content"])
    assert (await knowledge.row(document)).indexed_revision_number == first

    await knowledge.add_revision(document, key="objects/two")
    row = await knowledge.row(document)
    # A run that started from revision ``first`` finishes after revision two landed.
    async with transaction_scope(knowledge.sessions) as session:
        await ItemIngestionService._record_indexed(
            session,
            row.id,
            context=_context(row),
            processed_version="v",
            revision_number=first,
        )

    after = await knowledge.row(document)
    assert after.index_status == "pending"
    assert after.indexed_revision_number == first
    assert after.payload_dirty_at is not None


def _context(row: Item) -> IndexingContext:
    return IndexingContext(
        tenant_id=str(row.tenant_id),
        collection_item_id=str(row.parent_item_id),
        document_type="pdf",
        connector_key="file",
    )


@pytest.mark.parametrize(
    ("first", "then"),
    [
        (None, ":unpublish"),
        (":unpublish", ":publish"),
        (None, "DELETE"),
        ("DELETE", ":undelete"),
    ],
)
async def test_every_lifecycle_write_marks_the_payload_dirty_until_it_lands(
    client,
    runtime,
    world: World,
    knowledge: Knowledge,
    fakes: Fakes,
    monkeypatch: pytest.MonkeyPatch,
    first: str | None,
    then: str,
) -> None:
    admin, _, _, _, document = await _setup(world, knowledge)
    api = await client.as_(admin)

    async def call(verb: str):
        if verb == "DELETE":
            return await api.delete(item_url(document))
        return await api.post(item_url(document, verb), json={})

    if first is not None:
        assert (await call(first)).status_code == 200
    _fail_payload_updates(fakes, monkeypatch)

    assert (await call(then)).status_code == 200
    assert (await knowledge.row(document)).payload_dirty_at is not None

    monkeypatch.undo()
    assert await reconcile_dirty_payloads(runtime.sessions(), runtime.item_index()) == 1
    row = await knowledge.row(document)
    payload = knowledge.payload(document)
    assert row.payload_dirty_at is None
    assert payload["published"] is (row.publication_state == "published")
    assert payload["is_deleted"] is (row.deleted_at is not None)


async def test_a_document_deleted_while_indexing_stays_out_of_search(
    runtime, world: World, knowledge: Knowledge, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, _, _, document = await _setup(world, knowledge)
    original = ItemService.mark_index_processing

    async def processing_then_deleted(self: ItemService, item_id):
        item = await original(self, item_id)
        await self.delete_cohort(Cohort((item,)))
        return item

    monkeypatch.setattr(ItemService, "mark_index_processing", processing_then_deleted)

    await knowledge.index(document, ["reindexed policy"])

    row = await knowledge.row(document)
    assert row.payload_dirty_at is not None
    assert row.index_status != "ready"
    assert await _live_citations(knowledge, document) == 0
    monkeypatch.undo()
    await reconcile_dirty_payloads(runtime.sessions(), runtime.item_index())
    assert fakes.index_backend.live_points(document.id) == []


async def test_a_run_failing_on_a_deleted_document_marks_its_payload_not_failed(
    world: World, knowledge: Knowledge, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, _, _, document = await _setup(world, knowledge)

    async def delete_then_fail(**kwargs):
        await world.delete(document)
        raise _Outage

    monkeypatch.setattr(fakes.index_backend, "replace_item_points", delete_then_fail)

    with pytest.raises(_Outage):
        await knowledge.index(document, ["never stored"])

    row = await knowledge.row(document)
    assert row.payload_dirty_at is not None
    assert row.index_status == "failed"


async def _live_citations(knowledge: Knowledge, document: Item) -> int:
    async with transaction_scope(knowledge.sessions) as session:
        return int(
            await session.scalar(
                select(func.count()).where(
                    Citation.item_id == document.id, Citation.deleted_at.is_(None)
                )
            )
            or 0
        )
