"""References other slices resolve through KnowledgeItems (invariant 5).

Merged duplicates, LOCKED discoverable roots for access requests, batch
readability and the Items of space materials.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import update

from bomesh.services.knowledge_items.summary import (
    collection_ids_for_spaces,
    get_item_summary,
    readable_item_ids,
    space_material_items,
    visible_or_discoverable_summary,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, SpaceMaterial
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
        workspace, item_name="Shared", grants={reader: "roles/collectionViewer"}
    )
    secret = await world.make_collection(workspace, item_name="Secret")
    return admin, workspace, reader, shared, secret


async def _summary(knowledge: Knowledge, user, workspace, item_id: UUID):
    async with transaction_scope(knowledge.sessions) as session:
        return await get_item_summary(
            session, Authorizer(knowledge.sessions), Principal(user.id), workspace.id, item_id
        )


async def test_a_merged_duplicate_reads_as_absent(
    client, world: World, knowledge: Knowledge
) -> None:
    admin, workspace, reader, shared, _ = await _setup(world)
    duplicate = await world.make_document(shared)
    target = await world.make_document(shared)
    await _merge(client, admin, duplicate, target)

    assert await _summary(knowledge, reader, workspace, duplicate.id) is None
    summary = await _summary(knowledge, reader, workspace, target.id)
    assert summary is not None and summary.item_id == target.id


async def test_access_requests_may_name_a_locked_discoverable_root(
    world: World, knowledge: Knowledge
) -> None:
    _, workspace, reader, _, secret = await _setup(world)
    hidden_root = await world.make_collection(workspace, item_name="Not discoverable")
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == secret.id).values(discoverable=True)
        )
    outsider = await world.make_user()

    async def summary(user, item):
        async with transaction_scope(knowledge.sessions) as session:
            return await visible_or_discoverable_summary(
                session, Authorizer(knowledge.sessions), Principal(user.id), workspace.id, item.id
            )

    locked = await summary(reader, secret)
    assert locked is not None
    assert (locked.locked, locked.item_kind) == (True, "COLLECTION")
    assert await summary(reader, hidden_root) is None
    assert await summary(outsider, secret) is None


async def test_readable_item_ids_keep_only_readable_live_items(
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
        found = await readable_item_ids(
            session, Authorizer(knowledge.sessions), Principal(reader.id), workspace.id, ids
        )

    assert found == {readable.id}


async def test_collection_ids_for_spaces_read_collection_materials_for_the_reader(
    world: World, knowledge: Knowledge
) -> None:
    admin, workspace, reader, shared, secret = await _setup(world)
    space = await world.make_space(workspace, admin, code="ops")
    empty = await world.make_space(workspace, admin, code="empty")
    gone = await world.make_collection(workspace, item_name="Gone")
    document = await world.make_document(shared)
    for item in (secret, shared, gone, document):  # one transaction each: the added order
        async with transaction_scope(knowledge.sessions) as session:
            session.add(SpaceMaterial(space_id=space.id, item_id=item.id, added_by_user_id=admin.id))
    await world.delete(gone)

    async with transaction_scope(knowledge.sessions) as session:
        for_reader = await collection_ids_for_spaces(
            session,
            Authorizer(knowledge.sessions),
            Principal(reader.id),
            workspace.id,
            [space.id, empty.id],
        )
        for_admin = await collection_ids_for_spaces(
            session, Authorizer(knowledge.sessions), Principal(admin.id), workspace.id, [space.id]
        )
        materials = await space_material_items(session, workspace.id, [space.id, empty.id])

    assert for_reader == {space.id: (shared.id,), empty.id: ()}
    assert for_admin == {space.id: (secret.id, shared.id)}
    assert materials == ((secret.id, shared.id), (document.id,))
