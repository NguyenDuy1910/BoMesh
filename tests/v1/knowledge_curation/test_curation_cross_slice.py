"""The cross-slice API Library Home reads (visibility-checked, caller's session)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from bomesh.services.knowledge_curation.contributions import (
    member_contributions,
    review_queue_statement,
)
from bomesh.services.knowledge_curation.topics import topic_count_statement, topic_summaries
from bomesh.db.models import ItemTopic
from bomesh.iam.authorizer import Principal
from curation_support import Scene

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
    contribution = await scene.submit(await scene.candidate(item_name="Draft"))

    authorizer = scene.world.authorizer()
    member = Principal(scene.outsider.id)
    async with scene.sessions() as session:
        [summary] = await topic_summaries(
            session, authorizer, member, scene.ws.id, limit=5, new_since=datetime.now(UTC) - timedelta(days=30)
        )
        assert (summary.code, summary.document_count, summary.new_document_count) == ("people", 1, 1)
        assert [(t.code, t.document_count) for t in summary.top_topics] == [("hiring", 1)]
        assert await session.scalar(topic_count_statement(scene.ws.id)) == 1
        [mine] = await member_contributions(session, scene.ws.id, scene.member.id, limit=5)
        assert (str(mine.contribution_id), mine.display_name, mine.state) == (
            contribution["name"].rsplit("/", 1)[1],
            "Draft",
            "IN_REVIEW",
        )
        reviewer = Principal(scene.reviewer.id)
        queue = review_queue_statement
        assert await session.scalar(await queue(authorizer, reviewer, scene.ws.id)) == 1
        assert await session.scalar(await queue(authorizer, member, scene.ws.id)) == 0
