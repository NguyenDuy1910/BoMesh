"""Publish reclassifies exactly what changed (``api_design.md`` ConceptScheme ``:publish``).

Only splits, new children and deprecations that orphan a required scheme
queue a ``classify_only`` run (the only path to the model); renames, merges
and threshold changes are settled without one. Human rows never change.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select, update

from bomesh.db.models import (
    Concept,
    ConceptClosure,
    ConceptReplacement,
    ConceptRule,
    ConceptScheme,
    ConceptSchemeVersion,
    IngestionRun,
    IngestionRunItem,
    Item,
    ItemClassification,
    ItemConcept,
    Tenant,
    User,
)
from bomesh.runtime import AppRuntime
from bomesh.services.taxonomy import reclassify
from bomesh.services.taxonomy.reclassify import schedule_reclassification
from harness import Sessions, World

pytestmark = pytest.mark.asyncio

VERSION = 2


class Scene:
    def __init__(self, sessions: Sessions, world: World, runtime: AppRuntime) -> None:
        self.sessions, self.world, self.runtime = sessions, world, runtime
        self.user: User
        self.workspace: Tenant
        self.collection: Item

    async def setup(self) -> Scene:
        self.user = await self.world.make_user()
        self.workspace = await self.world.make_workspace(self.user)
        self.collection = await self.world.make_collection(self.workspace)
        return self

    async def scheme(self, **values: Any) -> ConceptScheme:
        scheme = ConceptScheme(
            id=uuid4(),
            tenant_id=self.workspace.id,
            code=values.pop("code", f"s-{uuid4().hex[:8]}"),
            scheme_name="Scheme",
            purpose="classification",
            max_depth=3,
            llm_policy="always",
            published_version=VERSION,
            **values,
        )
        await self._add(scheme)
        return scheme

    async def concept(self, scheme: ConceptScheme, notation: str) -> Concept:
        concept = Concept(
            id=uuid4(),
            tenant_id=scheme.tenant_id,
            scheme_id=scheme.id,
            notation=notation,
            state="published",
            first_version=1,
        )
        await self._add(concept)
        return concept

    async def document(self) -> UUID:
        return (await self.world.make_document(self.collection)).id

    async def label(
        self,
        item_id: UUID,
        concept: Concept,
        *,
        source: str = "llm",
        state: str = "accepted",
        confidence: float | None = 0.9,
        evidence: dict[str, Any] | None = None,
    ) -> UUID:
        row = ItemConcept(
            item_id=item_id,
            concept_id=concept.id,
            scheme_id=concept.scheme_id,
            source=source,
            state=state,
            confidence=None if source == "human" else confidence,
            evidence=evidence or {},
        )
        await self._add(row)
        return row.id

    async def deprecate(self, concept: Concept, *replacements: Concept) -> None:
        async with self.sessions.begin() as session:
            await session.execute(
                update(Concept)
                .where(Concept.id == concept.id)
                .values(state="deprecated", deprecated_version=VERSION)
            )
            for replacement in replacements:
                session.add(
                    ConceptReplacement(
                        concept_id=concept.id, replacement_concept_id=replacement.id
                    )
                )

    async def publish(self, scheme: ConceptScheme, **plan: Any) -> None:
        await self._add(
            ConceptSchemeVersion(
                scheme_id=scheme.id,
                version=VERSION,
                published_by_user_id=self.user.id,
                reclassification={
                    "remapped": 0,
                    "rerank": [],
                    "rerun_parents": [],
                    "thresholds_changed": False,
                    "state": "pending",
                    **plan,
                },
            )
        )

    async def schedule(self, scheme: ConceptScheme) -> UUID | None:
        return await schedule_reclassification(
            self.runtime, None, self.workspace.id, scheme.id, VERSION
        )

    async def runs(self) -> list[tuple[IngestionRun, set[UUID]]]:
        async with self.sessions.begin() as session:
            runs = (
                await session.scalars(
                    select(IngestionRun).where(IngestionRun.tenant_id == self.workspace.id)
                )
            ).all()
            return [
                (
                    run,
                    set(
                        (
                            await session.scalars(
                                select(IngestionRunItem.item_id).where(
                                    IngestionRunItem.run_id == run.id
                                )
                            )
                        ).all()
                    ),
                )
                for run in runs
            ]

    async def rows(self, *row_ids: UUID) -> dict[UUID, ItemConcept]:
        async with self.sessions.begin() as session:
            rows = (await session.scalars(select(ItemConcept).where(ItemConcept.id.in_(row_ids)))).all()
            return {row.id: row for row in rows}

    async def plan(self, scheme: ConceptScheme) -> dict[str, Any]:
        async with self.sessions.begin() as session:
            row = await session.get(ConceptSchemeVersion, (scheme.id, VERSION))
            assert row is not None
            return dict(row.reclassification or {})

    async def _add(self, *rows: Any) -> None:
        async with self.sessions.begin() as session:
            for row in rows:
                session.add(row)
                await session.flush()


@pytest_asyncio.fixture
async def scene(sessions: Sessions, world: World, runtime: AppRuntime) -> Scene:
    return await Scene(sessions, world, runtime).setup()


def _human_state(row: ItemConcept) -> tuple[Any, ...]:
    return (row.concept_id, row.state, row.is_primary, row.confidence, row.evidence, row.source)


async def test_rename_and_merge_need_no_run(scene: Scene) -> None:
    scheme = await scene.scheme()
    concept = await scene.concept(scheme, "a")
    machine = await scene.label(await scene.document(), concept)
    human = await scene.label(await scene.document(), concept, source="human")
    before = await scene.rows(machine, human)
    # A merge is remapped by publish itself (``remapped``); nothing is left for the model.
    await scene.publish(scheme, remapped=3)

    assert await scene.schedule(scheme) is None

    assert await scene.runs() == []
    assert (await scene.plan(scheme))["state"] == "done"
    after = await scene.rows(machine, human)
    assert {key: _human_state(row) for key, row in after.items()} == {
        key: _human_state(row) for key, row in before.items()
    }


async def test_split_reranks_exactly_the_split_concepts_documents(scene: Scene) -> None:
    scheme = await scene.scheme()
    other_scheme = await scene.scheme()
    split = await scene.concept(scheme, "a")
    first, second = await scene.concept(scheme, "a1"), await scene.concept(scheme, "a2")
    unrelated = await scene.concept(scheme, "b")
    elsewhere = await scene.concept(other_scheme, "z")
    machine_doc, human_doc, other_doc = (
        await scene.document(),
        await scene.document(),
        await scene.document(),
    )
    await scene.label(machine_doc, split)
    human = await scene.label(human_doc, split, source="human")
    await scene.label(other_doc, unrelated)
    await scene.label(other_doc, elsewhere)
    before = await scene.rows(human)
    await scene.deprecate(split, first, second)
    await scene.publish(
        scheme, rerank=[{"concept": str(split.id), "among": [str(first.id), str(second.id)]}]
    )

    run_id = await scene.schedule(scheme)

    runs = await scene.runs()
    assert run_id in {run.id for run, _ in runs}
    assert set().union(*(items for _, items in runs)) == {machine_doc, human_doc}
    for run, items in runs:
        assert run.trigger_type == "taxonomy"
        assert run.configuration["classify_only"] is True
        classification = run.configuration["classification"]
        assert classification["schemes"] == [scheme.code]
        assert {code: set(ids) for code, ids in classification["rerank"].items()} == {
            scheme.code: {str(first.id), str(second.id)}
        }
        # The human-labelled Document only gets suggestions.
        assert classification["suggest_only"] is (items == {human_doc})
    plan = await scene.plan(scheme)
    assert plan["state"] == "running"
    assert set(plan["runs"]) == {str(run.id) for run, _ in runs}
    assert _human_state((await scene.rows(human))[human]) == _human_state(before[human])

    # Idempotent per (scheme, version).
    assert await scene.schedule(scheme) == run_id
    assert len(await scene.runs()) == len(runs)


async def test_new_child_reranks_only_the_parents_documents(scene: Scene) -> None:
    scheme = await scene.scheme()
    parent = await scene.concept(scheme, "p")
    child, new_child = await scene.concept(scheme, "c1"), await scene.concept(scheme, "c2")
    parent_doc, child_doc = await scene.document(), await scene.document()
    await scene.label(parent_doc, parent)
    await scene.label(child_doc, child)
    among = [str(parent.id), str(child.id), str(new_child.id)]
    await scene.publish(scheme, rerun_parents=[{"parent": str(parent.id), "among": among}])

    await scene.schedule(scheme)

    [(run, items)] = await scene.runs()
    assert items == {parent_doc}
    assert set(run.configuration["classification"]["rerank"][scheme.code]) == set(among)


async def test_deprecation_rejects_machine_rows_and_reruns_orphans(scene: Scene) -> None:
    scheme = await scene.scheme(min_labels=1)
    gone, kept = await scene.concept(scheme, "x"), await scene.concept(scheme, "y")
    orphan_doc, covered_doc, human_doc = (
        await scene.document(),
        await scene.document(),
        await scene.document(),
    )
    orphan_row = await scene.label(orphan_doc, gone)
    covered_row = await scene.label(covered_doc, gone)
    survivor = await scene.label(covered_doc, kept, state="suggested", confidence=0.6)
    human = await scene.label(human_doc, gone, source="human")
    before = await scene.rows(human)
    await scene.deprecate(gone)
    await scene.publish(scheme)

    await scene.schedule(scheme)

    rows = await scene.rows(orphan_row, covered_row, survivor, human)
    for row_id in (orphan_row, covered_row):
        assert rows[row_id].state == "rejected"
        assert rows[row_id].evidence["reason"] == "deprecated"
    assert rows[survivor].state == "suggested"
    assert _human_state(rows[human]) == _human_state(before[human])
    [(run, items)] = await scene.runs()
    assert items == {orphan_doc}
    assert run.configuration["classification"]["schemes"] == [scheme.code]
    assert not run.configuration["classification"]["rerank"]


async def test_threshold_change_reroutes_without_a_run(scene: Scene) -> None:
    scheme = await scene.scheme(auto_threshold=0.8, review_threshold=0.5)
    concept, other = await scene.concept(scheme, "a"), await scene.concept(scheme, "b")
    document, low_doc = await scene.document(), await scene.document()
    promoted = await scene.label(document, concept, state="suggested", confidence=0.9)
    demoted = await scene.label(document, other, state="accepted", confidence=0.6)
    dropped = await scene.label(low_doc, concept, state="suggested", confidence=0.3)
    human = await scene.label(low_doc, other, source="human")
    await scene._add(
        ItemClassification(item_id=low_doc, scheme_id=scheme.id, outcome="assigned")
    )
    before = await scene.rows(human)
    await scene.publish(scheme, thresholds_changed=True)

    assert await scene.schedule(scheme) is None

    rows = await scene.rows(promoted, demoted, dropped, human)
    assert rows[promoted].state == "accepted"
    assert rows[demoted].state == "suggested"
    assert rows[dropped].state == "rejected"
    assert rows[dropped].evidence["reason"] == "below_threshold"
    assert _human_state(rows[human]) == _human_state(before[human])
    assert await scene.runs() == []
    plan = await scene.plan(scheme)
    assert (plan["state"], plan["rerouted"]) == ("done", 3)


async def test_rule_change_reevaluates_documents_of_old_and_new_conditions(
    scene: Scene, monkeypatch: pytest.MonkeyPatch
) -> None:
    scheme = await scene.scheme()
    when, then = await scene.concept(scheme, "t"), await scene.concept(scheme, "f")
    other_collection = await scene.world.make_collection(scene.workspace)
    in_collection = (await scene.world.make_document(other_collection)).id
    tagged, untouched = await scene.document(), await scene.document()
    await scene._add(ConceptClosure(ancestor_id=when.id, descendant_id=when.id, depth=0))
    await scene.label(tagged, when)
    rule = ConceptRule(
        tenant_id=scene.workspace.id,
        code="r1",
        when_collection_item_id=other_collection.id,
        then_concept_id=then.id,
        effect="implies",
    )
    await scene._add(rule)
    seen: list[UUID] = []

    async def recompute(session: Any, tenant_id: UUID, item_ids: Any) -> int:
        seen.extend(item_ids)
        return 0

    monkeypatch.setattr(reclassify, "reevaluate_rule_rows", recompute)

    count = await reclassify.reevaluate_rules(
        scene.runtime,
        None,
        scene.workspace.id,
        [rule.id],
        previous=[{"when_concept_id": str(when.id), "then_concept_id": str(then.id)}],
    )

    assert count == 2
    assert set(seen) == {in_collection, tagged}
    assert untouched not in seen
    assert await scene.runs() == []


async def _implies(scene: Scene, code: str, when: Concept, then: Concept) -> None:
    await scene._add(
        ConceptRule(
            tenant_id=scene.workspace.id, code=code, when_concept_id=when.id, then_concept_id=then.id, effect="implies"
        )
    )


async def _outcome(scene: Scene, item_id: UUID, scheme: ConceptScheme) -> tuple[Any, ...]:
    async with scene.sessions.begin() as session:
        row = await session.get(ItemClassification, (item_id, scheme.id))
        assert row is not None
        return (row.outcome, row.confidence, row.scheme_version)


async def test_deprecation_rejects_the_rule_rows_its_concept_implied(scene: Scene) -> None:
    types = await scene.scheme()
    functions = await scene.scheme(min_labels=1)
    gone, other = await scene.concept(types, "x"), await scene.concept(types, "y")
    implied = await scene.concept(functions, "f")
    await _implies(scene, "x-f", gone, implied)
    await _implies(scene, "y-f", other, implied)
    recorded, legacy, shared = await scene.document(), await scene.document(), await scene.document()
    rule_rows = {}
    for item_id in (recorded, legacy, shared):
        await scene.label(item_id, gone)
        evidence = {"rule": "x-f", "premise": str(gone.id)} if item_id != legacy else {"rule": "x-f"}
        rule_rows[item_id] = await scene.label(item_id, implied, source="rule", confidence=1.0, evidence=evidence)
        await scene._add(
            ItemClassification(item_id=item_id, scheme_id=functions.id, outcome="assigned", confidence=1.0, scheme_version=1)
        )
    # On ``shared`` another live label implies the same function.
    await scene.label(shared, other, confidence=0.95)
    await scene.deprecate(gone)
    await scene.publish(types)

    await scene.schedule(types)

    rows = await scene.rows(*rule_rows.values())
    for item_id in (recorded, legacy):
        row = rows[rule_rows[item_id]]
        assert (row.state, row.evidence["reason"], row.evidence["premise"]) == ("rejected", "deprecated", str(gone.id))
        assert await _outcome(scene, item_id, functions) == ("uncertain", None, VERSION)
    assert rows[rule_rows[shared]].state == "accepted"
    assert await _outcome(scene, shared, functions) == ("assigned", 1.0, 1)


async def test_threshold_rerouting_carries_to_the_rule_rows_a_label_implied(scene: Scene) -> None:
    types = await scene.scheme(auto_threshold=0.8, review_threshold=0.5)
    functions = await scene.scheme(min_labels=1)
    premise = await scene.concept(types, "t")
    implied = await scene.concept(functions, "f")
    await _implies(scene, "t-f", premise, implied)
    demoted_doc, dropped_doc = await scene.document(), await scene.document()
    rule_rows = {}
    for item_id, confidence in ((demoted_doc, 0.7), (dropped_doc, 0.3)):
        await scene.label(item_id, premise, confidence=confidence)
        rule_rows[item_id] = await scene.label(
            item_id, implied, source="rule", confidence=confidence,
            evidence={"rule": "t-f", "premise": str(premise.id), "signals": []},
        )
        await scene._add(
            ItemClassification(item_id=item_id, scheme_id=functions.id, outcome="assigned", confidence=confidence, scheme_version=1)
        )
    await scene.publish(types, thresholds_changed=True)

    await scene.schedule(types)

    rows = await scene.rows(*rule_rows.values())
    demoted, dropped = rows[rule_rows[demoted_doc]], rows[rule_rows[dropped_doc]]
    assert (demoted.state, demoted.confidence) == ("suggested", pytest.approx(0.7))
    assert (dropped.state, dropped.evidence["reason"]) == ("rejected", "below_threshold")
    assert await _outcome(scene, demoted_doc, functions) == ("assigned", pytest.approx(0.7), VERSION)
    assert await _outcome(scene, dropped_doc, functions) == ("uncertain", None, VERSION)
