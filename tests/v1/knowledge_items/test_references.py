"""References other slices resolve through KnowledgeItems (invariant 5).

Merge chains, merged-content withholding, LOCKED discoverable roots for access
requests, batch readability and space-linked collections.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import update

from bomesh.services.knowledge_items.summary import (
    collection_ids_for_spaces,
    get_item_summary,
    readable_item_ids,
    visible_or_discoverable_summary,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.iam.authorizer import Authorizer, Principal
from harness import World
from knowledge_support import Knowledge, item_name, item_url

pytestmark = pytest.mark.asyncio


async def _merge(client, admin, duplicate: Item, target: Item) -> None:
    response = await (await client.as_(admin)).post(
        item_url(duplicate, ":merge"), json={"targetItem": item_name(target)}
    )
    assert response.status_code == 200, response.text


async def _setup(world: World):
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(
        workspace, title="Shared", grants={reader: "roles/collectionViewer"}
    )
    secret = await world.make_collection(workspace, title="Secret")
    return admin, workspace, reader, shared, secret


async def _summary(knowledge: Knowledge, user, workspace, item_id: UUID):
    async with transaction_scope(knowledge.sessions) as session:
        return await get_item_summary(
            session, Authorizer(knowledge.sessions), Principal(user.id), workspace.id, item_id
        )


async def test_merge_chains_resolve_to_the_last_target(
    client, world: World, knowledge: Knowledge
) -> None:
    admin, workspace, reader, shared, _ = await _setup(world)
    first = await world.make_document(shared, title="First")
    second = await world.make_document(shared, title="Second")
    final = await world.make_document(shared, title="Final")
    await _merge(client, admin, first, second)
    await _merge(client, admin, second, final)

    summary = await _summary(knowledge, reader, workspace, first.id)

    assert summary is not None
    assert (summary.item_id, summary.merged_from, summary.display_name) == (
        final.id,
        first.id,
        "Final",
    )
    assert summary.serves_content is False


async def test_a_merge_cycle_reads_as_absent(world: World, knowledge: Knowledge) -> None:
    _, workspace, reader, shared, _ = await _setup(world)
    a = await world.make_document(shared)
    b = await world.make_document(shared)
    for source, target in ((a, b), (b, a)):
        async with transaction_scope(knowledge.sessions) as session:
            await session.execute(
                update(Item)
                .where(Item.id == source.id)
                .values(deleted_at=Item.created_at, metadata_={"merged_into": str(target.id)})
            )

    assert await _summary(knowledge, reader, workspace, a.id) is None


async def test_a_live_reference_serves_its_own_content(world: World, knowledge: Knowledge) -> None:
    _, workspace, reader, shared, _ = await _setup(world)
    document = await world.make_document(shared)

    summary = await _summary(knowledge, reader, workspace, document.id)

    assert summary is not None and summary.serves_content is True


async def test_access_requests_may_name_a_locked_discoverable_root(
    world: World, knowledge: Knowledge
) -> None:
    _, workspace, reader, _, secret = await _setup(world)
    hidden_root = await world.make_collection(workspace, title="Not discoverable")
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == secret.id).values(metadata_={"discoverable": True})
        )
    outsider = await world.make_user()

    async def summary(user, item):
        async with transaction_scope(knowledge.sessions) as session:
            return await visible_or_discoverable_summary(
                session, Authorizer(knowledge.sessions), Principal(user.id), workspace.id, item.id
            )

    locked = await summary(reader, secret)
    assert locked is not None
    assert (locked.locked, locked.item_type, locked.serves_content) == (True, "COLLECTION", False)
    assert await summary(reader, hidden_root) is None
    assert await summary(outsider, secret) is None


async def test_readable_item_ids_follow_merges_unless_asked_not_to(
    client, world: World, knowledge: Knowledge
) -> None:
    admin, workspace, reader, shared, secret = await _setup(world)
    readable = await world.make_document(shared)
    duplicate = await world.make_document(shared)
    target = await world.make_document(shared)
    private = await world.make_document(secret)
    await _merge(client, admin, duplicate, target)
    ids = [readable.id, duplicate.id, private.id, UUID(int=0)]

    async with transaction_scope(knowledge.sessions) as session:
        authorizer = Authorizer(knowledge.sessions)
        followed = await readable_item_ids(
            session, authorizer, Principal(reader.id), workspace.id, ids
        )
        strict = await readable_item_ids(
            session, authorizer, Principal(reader.id), workspace.id, ids, follow_merges=False
        )

    assert followed == {readable.id, duplicate.id}
    assert strict == {readable.id}


async def test_collection_ids_for_spaces_group_and_filter_by_reader(
    world: World, knowledge: Knowledge
) -> None:
    admin, workspace, reader, shared, secret = await _setup(world)
    space = await world.make_space(workspace, admin, code="ops")
    empty = await world.make_space(workspace, admin, code="empty")
    gone = await world.make_collection(workspace, title="Gone")
    for collection in (shared, secret, gone):
        async with transaction_scope(knowledge.sessions) as session:
            await session.execute(
                update(Item).where(Item.id == collection.id).values(space_id=space.id)
            )
    await world.delete(gone)

    async with transaction_scope(knowledge.sessions) as session:
        everything = await collection_ids_for_spaces(session, workspace.id, [space.id, empty.id])
        for_reader = await collection_ids_for_spaces(
            session,
            workspace.id,
            [space.id],
            principal=Principal(reader.id),
            authorizer=Authorizer(knowledge.sessions),
        )

    assert everything == {space.id: (shared.id, secret.id), empty.id: ()}
    assert for_reader == {space.id: (shared.id,)}
