"""Concept proposals from unsure clusters and recurring corrections; never a concept."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from sqlalchemy import func, select

from bomesh.db.models import (
    Concept,
    ConceptProposal,
    ConceptProposalItem,
    ConceptScheme,
    Item,
    ItemClassification,
    ItemConcept,
    Tenant,
    User,
)
from bomesh.services.taxonomy.proposal_jobs import (
    ClusterDocument,
    ProposalDraft,
    propose_from_clusters,
    propose_from_corrections,
)
from harness import Sessions, World

pytestmark = pytest.mark.asyncio


class Scene:
    def __init__(self, sessions: Sessions, world: World) -> None:
        self.sessions, self.world = sessions, world
        self.user: User
        self.workspace: Tenant
        self.collection: Item

    async def setup(self) -> Scene:
        self.user = await self.world.make_user()
        self.workspace = await self.world.make_workspace(self.user)
        self.collection = await self.world.make_collection(self.workspace)
        self.scheme = ConceptScheme(
            id=uuid4(),
            tenant_id=self.workspace.id,
            code="d",
            scheme_name="Discipline",
            purpose="classification",
            max_depth=3,
            llm_policy="always",
            published_version=1,
        )
        await self.add(self.scheme)
        return self

    async def concept(self, notation: str) -> Concept:
        concept = Concept(
            id=uuid4(),
            tenant_id=self.workspace.id,
            scheme_id=self.scheme.id,
            notation=notation,
            state="published",
            first_version=1,
        )
        await self.add(concept)
        return concept

    async def document(self, title: str) -> UUID:
        return (await self.world.make_document(self.collection, item_name=title)).id

    async def add(self, *rows: Any) -> None:
        async with self.sessions.begin() as session:
            for row in rows:
                session.add(row)
                await session.flush()

    async def proposals(self) -> list[tuple[ConceptProposal, set[UUID]]]:
        async with self.sessions.begin() as session:
            proposals = (await session.scalars(select(ConceptProposal))).all()
            return [
                (
                    proposal,
                    set(
                        (
                            await session.scalars(
                                select(ConceptProposalItem.item_id).where(
                                    ConceptProposalItem.proposal_id == proposal.id
                                )
                            )
                        ).all()
                    ),
                )
                for proposal in proposals
            ]

    async def concept_count(self) -> int:
        async with self.sessions.begin() as session:
            return int(await session.scalar(select(func.count()).select_from(Concept)) or 0)


@pytest_asyncio.fixture
async def scene(sessions: Sessions, world: World) -> Scene:
    return await Scene(sessions, world).setup()


class FakeNamer:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def __call__(
        self, scheme_name: str, existing: Sequence[str], documents: Sequence[ClusterDocument]
    ) -> ProposalDraft:
        self.calls.append([document.title for document in documents])
        return ProposalDraft(name="Học bổng", definition="Học bổng của sinh viên.")


async def _embed(texts: list[str]) -> list[list[float]]:
    """Titles starting with the same word share a direction."""
    axes = {"scholarship": [1.0, 0.0, 0.0], "robotics": [0.0, 1.0, 0.0]}
    return [axes.get(text.split()[0], [0.0, 0.0, 1.0]) for text in texts]


async def test_cluster_job_proposes_one_concept_per_qualifying_cluster(scene: Scene) -> None:
    scholarship = [await scene.document(f"scholarship notice {n}") for n in range(6)]
    robotics = [await scene.document(f"robotics lab {n}") for n in range(3)]
    confident_empty = await scene.document("scholarship rules")
    await scene.add(
        *(
            ItemClassification(item_id=item, scheme_id=scene.scheme.id, outcome="uncertain")
            for item in scholarship + robotics
        ),
        ItemClassification(
            item_id=confident_empty, scheme_id=scene.scheme.id, outcome="empty", confidence=0.9
        ),
    )
    concepts = await scene.concept_count()
    namer = FakeNamer()

    created = await propose_from_clusters(scene.sessions, embed=_embed, name=namer)

    assert created == 1
    [(proposal, items)] = await scene.proposals()
    assert (proposal.kind, proposal.origin, proposal.state) == ("new_concept", "cluster", "open")
    assert proposal.proposal_name == "Học bổng"
    assert proposal.concept_id is None
    assert items == set(scholarship)
    assert len(namer.calls) == 1
    assert await scene.concept_count() == concepts

    # The same cluster is not proposed again.
    assert await propose_from_clusters(scene.sessions, embed=_embed, name=namer) == 0
    assert len(namer.calls) == 1


async def test_learn_job_proposes_labels_at_the_recurrence_threshold(scene: Scene) -> None:
    machine_pick, chosen, rare = (
        await scene.concept("x"),
        await scene.concept("y"),
        await scene.concept("z"),
    )

    async def correct(title: str, target: Concept) -> UUID:
        item_id = await scene.document(title)
        await scene.add(
            ItemConcept(
                item_id=item_id,
                concept_id=machine_pick.id,
                scheme_id=scene.scheme.id,
                source="llm",
                state="rejected",
                confidence=0.7,
                reviewed_by_user_id=scene.user.id,
            ),
            ItemConcept(
                item_id=item_id,
                concept_id=target.id,
                scheme_id=scene.scheme.id,
                source="human",
                state="accepted",
                created_by_user_id=scene.user.id,
            ),
        )
        return item_id

    recurring = [
        await correct("Thông báo học bổng khuyến khích đợt 1", chosen),
        await correct("Quyết định học bổng khuyến khích học kỳ 2", chosen),
        await correct("Danh sách học bổng khuyến khích năm 2024", chosen),
    ]
    await correct("Thông báo vay vốn sinh viên", rare)
    await correct("Hướng dẫn vay vốn sinh viên", rare)

    assert await propose_from_corrections(scene.sessions) == 1

    [(proposal, items)] = await scene.proposals()
    assert (proposal.kind, proposal.origin) == ("label", "correction")
    assert proposal.target_concept_id == chosen.id
    assert proposal.proposal_name == "học bổng khuyến khích"
    assert items == set(recurring)
    assert await propose_from_corrections(scene.sessions) == 0
