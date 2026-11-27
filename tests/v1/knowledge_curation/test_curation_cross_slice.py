"""The cross-slice API Library Home reads (visibility-checked, caller's session)."""

from __future__ import annotations

import pytest

from bomesh.services.knowledge_curation.contributions import (
    member_contributions,
    review_queue_statement,
)
from bomesh.iam.authorizer import Principal
from curation_support import Scene

pytestmark = pytest.mark.asyncio


async def test_home_contributions_and_review_queue_respect_visibility(scene: Scene) -> None:
    contribution = await scene.submit(await scene.candidate(item_name="Draft"))

    authorizer = scene.world.authorizer()
    member = Principal(scene.outsider.id)
    async with scene.sessions() as session:
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
