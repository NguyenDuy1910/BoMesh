"""The reviewer exception (item_model.md §6.4): GetItem, GetItemPreview, GetItemContent
and ``alt=media`` only.

A reviewer of an open contribution may read its candidate through those four
calls and nothing else: not list, search, link (attach), merge or move it.
"""

from __future__ import annotations

import pytest

from harness import World
from knowledge_support import Knowledge, item_name, item_url, ws_url

pytestmark = pytest.mark.asyncio


async def _setup(world: World, knowledge: Knowledge):
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    contributor = await world.add_member(workspace)
    reviewer = await world.add_member(workspace)
    personal = await world.make_collection(workspace, personal_for=contributor)
    target = await world.make_collection(workspace, grants={reviewer: "roles/collectionOwner"})
    candidate = await world.make_document(personal, creator=contributor, item_name="Candidate plan")
    await knowledge.add_revision(candidate)
    await knowledge.index(candidate, ["candidate plan budget"])
    await world.make_contribution(candidate, contributor=contributor, target=target)
    return workspace, reviewer, target, candidate


async def test_reviewer_reads_the_candidate_through_the_four_calls(
    client, world: World, knowledge: Knowledge
) -> None:
    _, reviewer, _, candidate = await _setup(world, knowledge)
    api = await client.as_(reviewer)

    got = await api.get(item_url(candidate))
    preview = await api.get(item_url(candidate, "/preview"))
    content = await api.get(item_url(candidate, "/content"))
    media = await api.get(item_url(candidate), params={"alt": "media"})

    assert got.status_code == 200, got.text
    assert preview.status_code == 200, preview.text
    assert (preview.json()["representation"]["kind"], preview.json()["state"]) == ("PDF", "READY")
    assert content.status_code == 200, content.text
    assert content.json()["nodes"][0]["runs"] == [{"text": "candidate plan budget"}]
    assert media.status_code == 302


async def test_reviewer_cannot_find_cite_attach_merge_or_move_the_candidate(
    client, world: World, knowledge: Knowledge
) -> None:
    workspace, reviewer, target, candidate = await _setup(world, knowledge)
    own = await world.make_document(target, item_name="Existing plan")
    api = await client.as_(reviewer)

    listed = await api.get(f"{ws_url(workspace)}/items")
    searched = await api.post(f"{ws_url(workspace)}/items:search", json={"query": "candidate plan"})
    linked = await api.post(item_url(target, "/shortcuts"), json={"targetItem": item_name(candidate)})
    merged = await api.post(item_url(own, ":merge"), json={"targetItem": item_name(candidate)})
    moved = await api.post(item_url(candidate, ":move"), json={"destinationParent": item_name(target)})

    assert item_name(candidate) not in [item["name"] for item in listed.json()["items"]]
    assert searched.json()["results"] == []
    assert linked.status_code == 403
    assert merged.status_code == 403
    assert moved.status_code == 403
