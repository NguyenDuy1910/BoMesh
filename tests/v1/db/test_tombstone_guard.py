"""Tombstoned resources cannot be hard-deleted by any ORM session (AGENTS.md)."""

from __future__ import annotations

import pytest
from sqlalchemy import delete, func, select

from bomesh.db.models import Group, SavedItem
from bomesh.db.models.lifecycle import TombstoneViolation
from harness import World

pytestmark = pytest.mark.asyncio


async def test_deleting_a_tombstoned_row_is_refused(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    group = await world.make_group(workspace)

    with pytest.raises(TombstoneViolation):
        async with world.sessions.begin() as session:
            await session.delete(await session.get(Group, group.id))

    async with world.sessions.begin() as session:
        assert await session.get(Group, group.id) is not None


async def test_a_bulk_delete_of_a_tombstoned_table_is_refused(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    group = await world.make_group(workspace)

    with pytest.raises(TombstoneViolation):
        async with world.sessions.begin() as session:
            await session.execute(delete(Group).where(Group.id == group.id))


async def test_rows_without_a_tombstone_are_deleted_normally(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    document = await world.make_document(await world.make_collection(workspace))
    async with world.sessions.begin() as session:
        session.add(SavedItem(tenant_id=workspace.id, user_id=admin.id, item_id=document.id))

    async with world.sessions.begin() as session:
        await session.execute(delete(SavedItem).where(SavedItem.user_id == admin.id))

    async with world.sessions.begin() as session:
        assert await session.scalar(select(func.count()).select_from(SavedItem)) == 0
