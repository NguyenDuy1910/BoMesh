"""The KnowledgeItems API other slices call, and the purge job.

Contribution approval (``move_item``, ``publish_item``, ``append_revision_from``,
``delete_item``), personal collections (Workspaces), document creation
(Artifacts), reference summaries and the purge of objects no live revision
references.
"""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select, update

from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.documents import set_document_metadata, tag_document
from bomesh.services.knowledge_items.indexing import sync_item_payloads
from bomesh.services.knowledge_items.item_store import (
    ensure_personal_collection,
    personal_collection_id,
)
from bomesh.services.knowledge_items.items import (
    KnowledgeItemService,
    append_revision_from,
    create_document,
    delete_item,
    move_item,
    publish_item,
)
from bomesh.services.knowledge_items.purge import purge_deleted_items
from bomesh.services.knowledge_items.summary import get_item_summaries
from bomesh.services.knowledge_items.records import UploadedFile
from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Contribution,
    IngestionSource,
    IntegrationConnection,
    Item,
    RoleAssignment,
    Topic,
)
from bomesh.errors import InvalidArgument
from bomesh.services import InvalidDocumentStateError
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.storage.keys import COVER, content_key, derived_key, new_content_id
from bomesh.iam.authorizer import Authorizer, Principal
from harness import Fakes, World
from knowledge_support import Knowledge, item_url

pytestmark = pytest.mark.asyncio


async def test_ensure_personal_collection_is_idempotent_and_owner_only(
    client, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    other = await world.add_member(workspace)

    async with transaction_scope(knowledge.sessions) as session:
        first = await ensure_personal_collection(session, workspace.id, member.id)
        again = await ensure_personal_collection(session, workspace.id, member.id)
        grants = list(
            await session.scalars(
                select(RoleAssignment).where(
                    RoleAssignment.item_id == first, RoleAssignment.deleted_at.is_(None)
                )
            )
        )

    assert first == again == personal_collection_id(workspace.id, member.id)
    assert [grant.user_id for grant in grants] == [member.id]
    personal = (await (await client.as_(member)).get(f"/api/v1/workspaces/{workspace.id}/items/{first}")).json()
    assert personal["itemType"] == "PERSONAL"
    assert personal["collection"]["inheritAccess"] is False
    assert (await (await client.as_(other)).get(f"/api/v1/workspaces/{workspace.id}/items/{first}")).status_code == 403


async def test_contribution_approval_moves_and_publishes_the_candidate(
    runtime, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    contributor = await world.add_member(workspace)
    personal = await world.make_collection(workspace, personal_for=contributor)
    target = await world.make_collection(workspace, item_name="Policies")
    candidate = await world.make_document(personal, published=False, creator=contributor)
    await knowledge.index(candidate, ["draft content"])

    async with transaction_scope(knowledge.sessions) as session:
        dirty = set(await move_item(session, workspace.id, candidate.id, target.id))
        dirty |= set(await publish_item(session, workspace.id, candidate.id))
    await sync_item_payloads(runtime.sessions(), runtime.item_index(), dirty)

    row = await knowledge.row(candidate)
    assert (row.parent_item_id, row.is_published) == (target.id, True)
    assert knowledge.payload(candidate)["collection_item_id"] == str(target.id)
    assert knowledge.payload(candidate)["published"] is True
    assert (await knowledge.index_state(candidate)).payload_dirty_at is None


async def test_move_item_rejects_a_document_destination(world: World, knowledge: Knowledge) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    first = await world.make_document(collection)
    second = await world.make_document(collection)

    with pytest.raises(InvalidArgument):
        async with transaction_scope(knowledge.sessions) as session:
            await move_item(session, workspace.id, first.id, second.id)


async def test_new_revision_approval_reuses_the_candidates_object(
    world: World, knowledge: Knowledge, fakes: Fakes
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    published = await world.make_document(collection)
    candidate = await world.make_document(collection)
    await knowledge.add_revision(published)
    await knowledge.add_revision(candidate, size=42)
    shown = (await knowledge.row(candidate)).current_revision
    assert shown is not None
    objects_before = set(fakes.storage.objects)

    async with transaction_scope(knowledge.sessions) as session:
        number = await append_revision_from(session, candidate.id, published.id, None)
        await delete_item(session, workspace.id, candidate.id)

    row = await knowledge.row(published)
    assert number == 3  # after the published document's revisions 1 and 2
    current = row.current_revision
    assert current is not None
    assert (current.content_id, row.size_bytes, row.index_status) == (shown.content_id, 42, "pending")
    assert set(fakes.storage.objects) == objects_before
    assert (await knowledge.row(candidate)).deleted_at is not None


async def test_create_document_stores_bytes_with_revision_one(
    runtime, world: World, knowledge: Knowledge, fakes: Fakes
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    ctx = RequestContext(principal=Principal(admin.id), authorizer=Authorizer(knowledge.sessions))

    item_id = await create_document(
        KnowledgeItemService.from_runtime(runtime),
        ctx,
        workspace.id,
        collection.id,
        UploadedFile(data=b"# Report", file_name="report.md", content_type="text/markdown"),
        display_name="Report",
        published=False,
    )

    row = await knowledge.row(item_id)
    assert (row.item_kind, row.item_type, row.content_state, row.is_published) == (
        "document",
        "markdown",
        "available",
        False,
    )
    revisions = await knowledge.revisions(row)
    assert [revision.revision_number for revision in revisions] == [1]
    content = fakes.storage.objects[content_key(workspace.code, revisions[0].content_id)]
    assert content.data == b"# Report"
    assert revisions[0].file_name == "report.md"


async def test_item_summary_rechecks_visibility(
    client, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    secret = await world.make_collection(workspace)
    duplicate = await world.make_document(shared, item_name="Copy")
    original = await world.make_document(shared, item_name="Original")
    hidden = await world.make_document(secret)
    merged = await (await client.as_(admin)).post(
        item_url(duplicate, ":merge"),
        json={"targetItem": f"workspaces/{workspace.id}/items/{original.id}"},
    )
    assert merged.status_code == 200

    async with transaction_scope(knowledge.sessions) as session:
        summaries = await get_item_summaries(
            session,
            Authorizer(knowledge.sessions),
            Principal(reader.id),
            workspace.id,
            (duplicate.id, original.id, hidden.id),
        )

    assert list(summaries) == [original.id]
    assert summaries[original.id].display_name == "Original"


async def test_purge_deletes_only_objects_no_live_revision_references(
    client, runtime, world: World, knowledge: Knowledge, fakes: Fakes
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    kept = await world.make_document(collection)
    purged = await world.make_document(collection)
    shared, own = new_content_id(), new_content_id()
    await knowledge.add_revision(kept, content_id=shared)
    await knowledge.add_revision(purged, content_id=shared)
    await knowledge.add_revision(purged, content_id=own)
    derived = derived_key(workspace.code, own, COVER, 1)
    fakes.storage.put_bytes(b"cover", derived, content_type="image/webp")
    await knowledge.index(purged, ["to be purged"])
    await (await client.as_(admin)).delete(item_url(purged))
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item)
            .where(Item.id == purged.id)
            .values(deleted_at=Item.deleted_at - timedelta(days=31))
        )

    count = await purge_deleted_items(
        runtime.sessions(), runtime.item_index(), runtime.object_storage()
    )

    assert count == 1
    assert content_key(workspace.code, shared) in fakes.storage.objects
    assert content_key(workspace.code, own) not in fakes.storage.objects
    assert derived not in fakes.storage.objects
    assert [p for p in fakes.index_backend.points.values() if p.payload["item_id"] == str(purged.id)] == []
    assert (await knowledge.row(purged)).deleted_at is not None
    assert await purge_deleted_items(
        runtime.sessions(), runtime.item_index(), runtime.object_storage()
    ) == 0
    gone = await (await client.as_(admin)).post(item_url(purged, ":undelete"), json={})
    assert gone.status_code == 404


async def test_a_failed_object_delete_is_retried_by_the_next_purge(
    client, runtime, world: World, knowledge: Knowledge, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    purged = await world.make_document(collection)
    own = new_content_id()
    await knowledge.add_revision(purged, content_id=own)
    await (await client.as_(admin)).delete(item_url(purged))
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == purged.id).values(deleted_at=Item.deleted_at - timedelta(days=31))
        )

    async def storage_down(prefix: str) -> int:
        raise RuntimeError("storage unavailable")

    monkeypatch.setattr(fakes.storage, "delete_prefix", storage_down)
    with pytest.raises(RuntimeError):
        await purge_deleted_items(runtime.sessions(), runtime.item_index(), runtime.object_storage())
    assert [revision.deleted_at for revision in await knowledge.revisions(purged)] == [None, None]

    monkeypatch.undo()
    assert await purge_deleted_items(
        runtime.sessions(), runtime.item_index(), runtime.object_storage()
    ) == 1
    assert content_key(workspace.code, own) not in fakes.storage.objects


async def test_document_metadata_and_tags_go_through_one_tagger(
    client, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    document = await world.make_document(collection)
    async with transaction_scope(knowledge.sessions) as session:
        session.add(Topic(tenant_id=workspace.id, code="finance", kind="domain", topic_name="Finance"))
        session.add(
            Topic(tenant_id=workspace.id, code="old", kind="domain", topic_name="Old", state="rejected")
        )

    async with transaction_scope(knowledge.sessions) as session:
        await set_document_metadata(
            session,
            workspace.id,
            document.id,
            summary="Spending rules",
            topics=["finance"],
            created_by_user_id=admin.id,
        )
    shown = (await (await client.as_(admin)).get(item_url(document))).json()["document"]
    with pytest.raises(InvalidArgument):
        async with transaction_scope(knowledge.sessions) as session:
            await tag_document(session, workspace.id, document.id, ["old"], created_by_user_id=None)
    unknown = await (await client.as_(admin)).patch(
        item_url(document),
        params={"updateMask": "document.topics"},
        json={"document": {"topics": [f"workspaces/{workspace.id}/topics/missing"]}},
    )

    assert shown["summary"] == "Spending rules"
    assert shown["topics"] == [f"workspaces/{workspace.id}/topics/finance"]
    assert unknown.status_code == 400


async def test_origin_names_the_source_by_its_code(
    client, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    synced = await world.make_document(collection, item_name="Synced")
    await world.make_document(collection, item_name="Uploaded")
    await world.make_synced(synced, source_code="wiki", url="https://wiki/p")
    api = await client.as_(admin)
    source = f"workspaces/{workspace.id}/sources/wiki"

    origin = (await api.get(item_url(synced))).json()["document"]["origin"]
    filtered = await api.get(
        f"/api/v1/workspaces/{workspace.id}/items",
        params={"filter": f'document.origin.source="{source}"'},
    )

    assert origin == {"source": source, "externalUri": "https://wiki/p"}
    assert [item["name"] for item in filtered.json()["items"]] == [
        f"workspaces/{workspace.id}/items/{synced.id}"
    ]


async def test_delete_is_refused_while_a_source_candidate_inside_is_open(
    client, world: World
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    folder = await world.make_collection(workspace, collection)
    candidate = await world.make_document(folder, published=False)
    async with transaction_scope(world.sessions) as session:
        session.add(
            Contribution(
                tenant_id=workspace.id,
                item_id=candidate.id,
                kind="new_document",
                origin="source",
                ingestion_source_id=await _source(session, workspace, collection, admin),
                state="in_review",
            )
        )

    response = await (await client.as_(admin)).delete(item_url(collection), params={"force": "true"})

    assert response.status_code == 400
    assert response.json()["error"]["details"][0]["reason"] == "CONTRIBUTION_OPEN"


async def _source(session, workspace, collection: Item, admin) -> UUID:
    connection = IntegrationConnection(
        tenant_id=workspace.id,
        code="wiki",
        connector_key="confluence",
        integration_connection_name="Wiki",
        status="active",
        created_by_user_id=admin.id,
    )
    session.add(connection)
    await session.flush()
    source = IngestionSource(
        tenant_id=workspace.id,
        code="wiki-space",
        integration_connection_id=connection.id,
        target_item_id=collection.id,
        created_by_user_id=admin.id,
    )
    session.add(source)
    await session.flush()
    return source.id


async def test_artifact_revisions_are_written_only_through_the_engine(
    world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)

    async with transaction_scope(knowledge.sessions) as session:
        items = ItemService(session)
        item = await items.create_artifact_item(
            workspace.id, admin.id, item_name="Report", mime_type="text/markdown", file_name="report.md"
        )
        first, second = new_content_id(), new_content_id()
        await items.append_revision(item, content_id=first, mime_type="text/markdown", size_bytes=3, author="assistant")
        await items.append_revision(item, content_id=second, mime_type="text/markdown", size_bytes=5, author="user")
        current = await items.delete_newest_revision(item, 2)
        count = await items.count_live_revisions(item.id)
        with pytest.raises(InvalidDocumentStateError):
            await items.delete_newest_revision(item, 1)

    row = await knowledge.row(item.id)
    assert first != second
    assert (current.revision_number, count) == (1, 1)
    assert row.current_revision is not None
    assert (row.current_revision.content_id, row.size_bytes, row.index_status) == (first, 3, "unsupported")
