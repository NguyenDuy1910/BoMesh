"""The cross-slice API Library Home reads (visibility-checked, caller's session)."""

from __future__ import annotations

import pytest

from bomesh.services.knowledge_curation.contributions import (
    member_contributions,
    review_queue_count,
)
from bomesh.services.knowledge_curation.reading_lists import (
    featured_item_ids,
    reading_list_summaries,
)
from bomesh.services.knowledge_curation.topics import topic_count, topic_summaries
from bomesh.db.models import ItemTopic
from bomesh.iam.authorizer import Principal
from curation_support import Scene, item_name

pytestmark = pytest.mark.asyncio


async def test_home_summaries_respect_visibility(scene: Scene) -> None:
    domain = await scene.topic("people", "People", kind="domain")
    hiring = await scene.topic("hiring", "Hiring")
    secret = await scene.world.make_collection(scene.ws)
    readable = await scene.world.make_document(scene.kb)
    hidden = await scene.world.make_document(secret)
    async with scene.sessions.begin() as session:
        row = await session.get(type(hiring), hiring.id)
        assert row is not None
        row.parent_topic_id = domain.id
        session.add(ItemTopic(item_id=readable.id, topic_id=hiring.id))
        session.add(ItemTopic(item_id=hidden.id, topic_id=hiring.id))
    admin = await scene.as_(scene.admin)
    await admin.post(scene.url("readingLists"), params={"readingListId": "featured"}, json={"displayName": "F"})
    await admin.post(
        scene.url("readingLists"), params={"readingListId": "team"}, json={"displayName": "T", "audience": "WORKSPACE"}
    )
    for item in (hidden, readable):
        await admin.post(scene.url("readingLists/featured/entries"), json={"item": item_name(item)})
        await admin.post(scene.url("readingLists/team/entries"), json={"item": item_name(item)})
    contribution = await scene.submit(await scene.candidate(title="Draft"))

    authorizer = scene.world.authorizer()
    member = Principal(scene.outsider.id)
    async with scene.sessions() as session:
        [summary] = await topic_summaries(session, authorizer, member, scene.ws.id, limit=5)
        assert (summary.code, summary.document_count) == ("people", 1)
        assert [(t.code, t.document_count) for t in summary.top_topics] == [("hiring", 1)]
        assert await topic_count(session, scene.ws.id) == 1
        [shared] = await reading_list_summaries(session, authorizer, member, scene.ws.id, limit=5)
        assert (shared.code, shared.item_count) == ("team", 1)
        assert await featured_item_ids(session, authorizer, member, scene.ws.id, limit=5) == [readable.id]
        [mine] = await member_contributions(session, scene.ws.id, scene.member.id, limit=5)
        assert (str(mine.contribution_id), mine.display_name, mine.state) == (
            contribution["name"].rsplit("/", 1)[1],
            "Draft",
            "IN_REVIEW",
        )
        reviewer = Principal(scene.reviewer.id)
        assert await review_queue_count(session, authorizer, reviewer, scene.ws.id) == 1
        assert await review_queue_count(session, authorizer, member, scene.ws.id) == 0
