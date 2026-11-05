"""The reviewer exception (item_model.md §6.4): GetItem, GetItemContent and ``alt=media`` only.

A reviewer of an open contribution may read its candidate through those three
calls and nothing else: not list, search, passages, link (attach), merge or
move it.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from harness import World
from knowledge_support import Knowledge, item_name, item_url, ws_url

pytestmark = pytest.mark.asyncio


def _manifest(document: Item) -> dict[str, Any]:
    prefix = f"tenants/{document.tenant_id}/items/{document.id}/previews/"
    return {
        "source_version": "v1",
        "representation": "pages",
        "assets": [
            {
                "key": f"{prefix}page-1.webp",
                "content_type": "image/webp",
                "size_bytes": 1,
                "width": 10,
                "height": 10,
                "page": 1,
            }
        ],
    }


async def _setup(world: World, knowledge: Knowledge):
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    contributor = await world.add_member(workspace)
    reviewer = await world.add_member(workspace)
    personal = await world.make_collection(workspace, personal_for=contributor)
    target = await world.make_collection(workspace, grants={reviewer: "roles/collectionOwner"})
    candidate = await world.make_document(personal, creator=contributor, title="Candidate plan")
    await knowledge.add_revision(candidate, key=f"objects/{candidate.id}")
    await knowledge.index(candidate, ["candidate plan budget"])
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item)
            .where(Item.id == candidate.id)
            .values(metadata_={"preview": _manifest(candidate)})
        )
    await world.make_contribution(candidate, contributor=contributor, target=target)
    return workspace, reviewer, target, candidate


async def test_reviewer_reads_the_candidate_through_the_three_calls(
    client, world: World, knowledge: Knowledge
) -> None:
    _, reviewer, _, candidate = await _setup(world, knowledge)
    api = await client.as_(reviewer)

    got = await api.get(item_url(candidate))
    content = await api.get(item_url(candidate, "/content"))
    media = await api.get(item_url(candidate), params={"alt": "media"})

    assert got.status_code == 200, got.text
    assert content.status_code == 200, content.text
    assert media.status_code == 302


async def test_reviewer_cannot_find_cite_attach_merge_or_move_the_candidate(
    client, world: World, knowledge: Knowledge
) -> None:
    workspace, reviewer, target, candidate = await _setup(world, knowledge)
    own = await world.make_document(target, title="Existing plan")
    api = await client.as_(reviewer)

    listed = await api.get(f"{ws_url(workspace)}/items")
    searched = await api.post(f"{ws_url(workspace)}/items:search", json={"query": "candidate plan"})
    passages = await api.get(item_url(candidate, "/passages"))
    linked = await api.post(item_url(target, "/links"), json={"targetItem": item_name(candidate)})
    merged = await api.post(item_url(own, ":merge"), json={"targetItem": item_name(candidate)})
    moved = await api.post(item_url(candidate, ":move"), json={"destinationParent": item_name(target)})

    assert item_name(candidate) not in [item["name"] for item in listed.json()["items"]]
    assert searched.json()["results"] == []
    assert passages.status_code == 403
    assert linked.status_code == 403
    assert merged.status_code == 403
    assert moved.status_code == 403
