"""CLASSIFYING writes: ``item_concepts``, ``item_classifications`` and ``document_profiles``.

Processing with a run's plan prepares each Document after chunking, the model
answers inside indexing (scripted here: no model is called) and the outcome is
written with the index state. Human decisions are never overwritten by
machines; a concept a person rejected is never suggested again.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import date
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from harness import Fakes, World, principal
from knowledge_support import Knowledge
from sqlalchemy import func, select, update
from taxonomy_support import C, R, S, Taxonomy, rule, seed_taxonomy

from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Concept,
    ConceptRule,
    ConceptScheme,
    DocumentProfile,
    Item,
    ItemClassification,
    ItemConcept,
    Tenant,
    User,
)
from bomesh.document_index import (
    ClassificationRequest,
    DocumentClassification,
    ItemIndex,
    SchemeAnswer,
)
from bomesh.runtime import AppRuntime
from bomesh.services.ingestion.run_engine import RunClassification
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from bomesh.services.taxonomy import assignments, profiles
from bomesh.services.taxonomy.classification import (
    CLASSIFIER_VERSION,
    ClassificationPlan,
    ExtractedMetadata,
    MachineAssignment,
    SchemeResult,
)

pytestmark = pytest.mark.asyncio

TITLE = "Quyết định về trí tuệ nhân tạo"
TEXTS = (
    "Quyết định này quy định việc nghiên cứu trí tuệ nhân tạo.",
    "Khoa học dữ liệu và công nghệ thông tin hỗ trợ việc học.",
)


class ScriptedIndex:
    """The runtime's index with step 0 scripted: ``reply`` answers asked requests.

    ``reply`` ``None`` is a model failure (step 0 is best effort: no answer).
    """

    def __init__(self, inner: ItemIndex) -> None:
        self.inner = inner
        self.reply: Callable[[ClassificationRequest], DocumentClassification] | None = (
            None
        )
        self.requests: list[ClassificationRequest] = []
        self.indexed = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)

    async def index_item_content(
        self,
        item: Any,
        chunks: Any,
        *,
        context: Any,
        classification: Any = None,
        **kwargs: Any,
    ) -> tuple[int, DocumentClassification | None]:
        kwargs.pop("classification_cache", None)
        count, _ = await self.inner.index_item_content(
            item, chunks, context=context, **kwargs
        )
        self.indexed += 1
        return count, self._answer(classification)

    async def classify_document(
        self, item: Any, chunks: Any, *, classification: ClassificationRequest, **_: Any
    ) -> DocumentClassification | None:
        return self._answer(classification)

    def _answer(
        self, request: ClassificationRequest | None
    ) -> DocumentClassification | None:
        if request is None:
            return None
        self.requests.append(request)
        if not request.needs_model:
            return DocumentClassification()
        return self.reply(request) if self.reply is not None else None


class Setup:
    def __init__(
        self,
        world: World,
        knowledge: Knowledge,
        index: ScriptedIndex,
        admin: User,
        workspace: Tenant,
        handbook: Item,
        taxonomy: Taxonomy,
    ) -> None:
        self.world = world
        self.knowledge = knowledge
        self.index = index
        self.admin = admin
        self.workspace = workspace
        self.handbook = handbook
        self.taxonomy = taxonomy
        self.plan: ClassificationPlan | None = None

    @property
    def sessions(self) -> Any:
        return self.world.sessions

    def ingestion(self, runtime: AppRuntime | None = None) -> ItemIngestionService:
        return ItemIngestionService(
            self.sessions,
            index=self.index,  # type: ignore[arg-type]
            structures=runtime.structure_store() if runtime is not None else None,
        )

    async def load_plan(
        self, classification: RunClassification | None = None
    ) -> ClassificationPlan:
        plan = await self.ingestion().classification_plan(
            self.workspace.id, classification
        )
        assert plan is not None
        self.plan = plan
        return plan

    def answer(
        self, *notations: str, certainty: str = "high", none: bool = False
    ) -> None:
        """The model answers the domain scheme with ``notations`` (primary first)."""

        def reply(request: ClassificationRequest) -> DocumentClassification:
            assert self.plan is not None
            label_of = {concept: label for label, concept in self.plan.labels.items()}
            labels = tuple(
                label_of[self.taxonomy.concept("domain", n)] for n in notations
            )
            return DocumentClassification(
                schemes={
                    "domain": SchemeAnswer(
                        labels=labels,
                        none=none,
                        certainty=certainty,
                        evidence="trí tuệ nhân tạo",
                    )
                },
                summary="Quy định về AI.",
            )

        self.index.reply = reply

    def fail(self) -> None:
        self.index.reply = None

    async def document(self, title: str = TITLE) -> Item:
        return await self.world.make_document(self.handbook, item_name=title)

    async def index_document(
        self, document: Item, texts: Sequence[str] = TEXTS
    ) -> None:
        if self.plan is None:
            await self.load_plan()
        await self.knowledge.index(document, list(texts), plan=self.plan)

    def ctx(self) -> RequestContext:
        return RequestContext(
            principal=principal(self.admin), authorizer=self.world.authorizer()
        )


@pytest_asyncio.fixture
async def setup(runtime: AppRuntime, world: World, knowledge: Knowledge) -> Setup:
    index = ScriptedIndex(runtime.item_index())
    runtime._index = index  # type: ignore[assignment]
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    handbook = await world.make_collection(workspace, item_name="Handbook")
    taxonomy = await seed_taxonomy(
        world.sessions,
        workspace,
        admin,
        {
            "domain": S(
                concepts=(
                    C("it", "Công nghệ thông tin"),
                    C("ai", "Trí tuệ nhân tạo", broader=("it",)),
                    C("data", "Khoa học dữ liệu", broader=("it",)),
                    C("law", "Luật"),
                ),
                max_labels=2,
                has_primary=True,
                auto_threshold=0.85,
                review_threshold=0.5,
            ),
            "document-type": S(
                concepts=(
                    C("decision", "Quyết định", match_patterns=("(?i)^quyết định",)),
                    C("syllabus", "Đề cương"),
                ),
                max_labels=1,
                llm_policy="fallback",
            ),
            "function": S(
                concepts=(
                    C("training", "Đào tạo"),
                    C("research", "Nghiên cứu khoa học"),
                ),
                llm_policy="never",
            ),
        },
        rules=(
            R(
                "decision-training",
                then=("function", "training"),
                when_concept=("document-type", "decision"),
            ),
        ),
    )
    return Setup(world, knowledge, index, admin, workspace, handbook, taxonomy)


async def _rows(setup: Setup, item: Item | UUID) -> list[tuple[str, str, ItemConcept]]:
    item_id = item if isinstance(item, UUID) else item.id
    async with transaction_scope(setup.sessions) as session:
        result = await session.execute(
            select(ConceptScheme.code, Concept.notation, ItemConcept)
            .join(Concept, Concept.id == ItemConcept.concept_id)
            .join(ConceptScheme, ConceptScheme.id == ItemConcept.scheme_id)
            .where(ItemConcept.item_id == item_id)
            .order_by(ConceptScheme.code, Concept.notation, ItemConcept.created_at)
        )
        return [(code, notation, row) for code, notation, row in result.all()]


async def _live(setup: Setup, item: Item | UUID) -> dict[tuple[str, str], ItemConcept]:
    return {
        (code, notation): row
        for code, notation, row in await _rows(setup, item)
        if row.state != "rejected"
    }


async def _outcomes(setup: Setup, item: Item) -> dict[str, ItemClassification]:
    async with transaction_scope(setup.sessions) as session:
        result = await session.execute(
            select(ConceptScheme.code, ItemClassification)
            .join(ConceptScheme, ConceptScheme.id == ItemClassification.scheme_id)
            .where(ItemClassification.item_id == item.id)
        )
        return dict(result.tuples().all())


def _state(
    rows: dict[tuple[str, str], ItemConcept],
) -> dict[tuple[str, str], tuple[str, str, bool]]:
    return {key: (row.source, row.state, row.is_primary) for key, row in rows.items()}


async def test_indexing_with_a_plan_writes_rule_and_model_rows(
    setup: Setup, knowledge: Knowledge
) -> None:
    document = await setup.document()
    await setup.load_plan()
    setup.answer("ai", "data")

    await setup.index_document(document)

    rows = await _live(setup, document)
    assert _state(rows) == {
        ("document-type", "decision"): ("rule", "accepted", False),
        ("domain", "ai"): ("llm", "accepted", True),
        ("domain", "data"): ("llm", "accepted", False),
        ("function", "training"): ("rule", "accepted", False),
    }
    assert "pattern" in rows[("document-type", "decision")].evidence
    assert rows[("function", "training")].evidence["rule"] == "decision-training"
    assert rows[("function", "training")].confidence == 1.0
    assert rows[("domain", "ai")].evidence["quote"] == "trí tuệ nhân tạo"
    assert {row.classifier_version for row in rows.values()} == {CLASSIFIER_VERSION}
    assert {row.scheme_version for row in rows.values()} == {1}
    outcomes = await _outcomes(setup, document)
    assert {code: row.outcome for code, row in outcomes.items()} == {
        "document-type": "assigned",
        "domain": "assigned",
        "function": "assigned",
    }
    assert outcomes["domain"].revision_number == 1
    # Only the domain scheme was asked; the document is indexed.
    (request,) = setup.index.requests
    assert [task.scheme for task in request.tasks if task.ask] == ["domain"]
    assert (await knowledge.index_state(document)).index_status == "ready"
    async with transaction_scope(setup.sessions) as session:
        profile = await session.get(DocumentProfile, document.id)
        assert profile is not None and profile.revision_number == 1


async def test_outcomes_failed_uncertain_and_empty(
    setup: Setup, knowledge: Knowledge
) -> None:
    document = await setup.document()
    await setup.load_plan()
    setup.answer("ai", "data")
    await setup.index_document(document)
    before = _state(await _live(setup, document))

    # The model fails: the domain keeps its rows, the outcome is failed, the
    # settled schemes are still written and the document is indexed.
    setup.fail()
    await setup.index_document(document)
    assert _state(await _live(setup, document)) == before
    outcomes = await _outcomes(setup, document)
    assert outcomes["domain"].outcome == "failed"
    assert outcomes["function"].outcome == "assigned"
    assert (await knowledge.index_state(document)).index_status == "ready"

    # Low certainty: below the review threshold, nothing is kept.
    setup.answer("ai", certainty="low")
    await setup.index_document(document)
    rows = await _live(setup, document)
    assert not any(code == "domain" for code, _ in rows)
    assert (await _outcomes(setup, document))["domain"].outcome == "uncertain"

    # Nothing fits, said with high certainty, on a scheme that may stay empty.
    setup.answer(none=True)
    await setup.index_document(document)
    assert (await _outcomes(setup, document))["domain"].outcome == "empty"

    # Medium certainty routes to review.
    setup.answer("data", certainty="medium")
    await setup.index_document(document)
    rows = await _live(setup, document)
    assert _state(rows)[("domain", "data")] == ("llm", "suggested", False)


async def test_human_rows_win_and_a_rejected_concept_is_not_suggested_again(
    setup: Setup,
) -> None:
    document = await setup.document()
    await setup.load_plan()
    setup.answer("ai", "data")
    await setup.index_document(document)
    law = setup.taxonomy.concept("domain", "law")

    async with transaction_scope(setup.sessions) as session:
        await assignments.set_human_assignments(
            session, setup.ctx(), document.id, "domain", [law], law
        )

    setup.answer("ai", "data", "it")
    await setup.index_document(document)

    rows = await _rows(setup, document)
    live = {(code, n): row for code, n, row in rows if row.state != "rejected"}
    rejected = {(code, n) for code, n, row in rows if row.state == "rejected"}
    assert _state({key: row for key, row in live.items() if key[0] == "domain"}) == {
        ("domain", "law"): ("human", "accepted", True),
        # A person holds accepted domain labels: the machine only suggests.
        ("domain", "it"): ("llm", "suggested", False),
    }
    assert live[("domain", "law")].reviewed_by_user_id == setup.admin.id
    assert {("domain", "ai"), ("domain", "data")} <= rejected
    assert all(
        row.reviewed_by_user_id == setup.admin.id
        for code, n, row in rows
        if row.state == "rejected"
    )


async def test_primary_and_max_labels(setup: Setup) -> None:
    document = await setup.document()
    domain = setup.taxonomy["domain"]

    def machine(
        notation: str, value: float, *, primary: bool = False
    ) -> MachineAssignment:
        return MachineAssignment(
            concept_id=domain[notation],
            primary=primary,
            confidence=value,
            source="llm",
            state="accepted",
            evidence={"signals": []},
        )

    def result(
        *rows: MachineAssignment, replace: frozenset[UUID] | None = None
    ) -> SchemeResult:
        return SchemeResult(
            scheme_id=domain.scheme_id,
            scheme_code="domain",
            scheme_version=1,
            outcome="assigned",
            confidence=max(row.confidence for row in rows),
            assignments=rows,
            replace_concepts=replace,
        )

    async def write(*results: SchemeResult) -> None:
        async with transaction_scope(setup.sessions) as session:
            await assignments.replace_machine_assignments(
                session, document.id, results, revision_number=1
            )

    # max_labels 2: the third accepted label is a suggestion; the highest is primary.
    await write(result(machine("ai", 0.95), machine("data", 0.97), machine("it", 0.92)))
    assert _state(await _live(setup, document)) == {
        ("domain", "ai"): ("llm", "accepted", False),
        ("domain", "data"): ("llm", "accepted", True),
        ("domain", "it"): ("llm", "suggested", False),
    }

    # The classifier's primary wins; duplicates collapse; rows not chosen are deleted.
    await write(
        result(
            machine("law", 0.9),
            machine("law", 0.96),
            machine("ai", 0.99),
            machine("data", 0.91, primary=True),
        )
    )
    rows = await _live(setup, document)
    assert _state(rows) == {
        ("domain", "ai"): ("llm", "accepted", False),
        ("domain", "data"): ("llm", "accepted", True),
        ("domain", "law"): ("llm", "suggested", False),
    }
    assert rows[("domain", "law")].confidence == pytest.approx(0.96)

    # Rerank among {it, law}: only those concepts' machine rows are rewritten.
    await write(
        result(machine("it", 0.97), replace=frozenset({domain["it"], domain["law"]}))
    )
    assert _state(await _live(setup, document)) == {
        ("domain", "ai"): ("llm", "accepted", False),
        ("domain", "data"): ("llm", "accepted", True),
        ("domain", "it"): ("llm", "suggested", False),
    }


async def test_remap_merges_and_dedupes(setup: Setup) -> None:
    domain = setup.taxonomy["domain"]
    first = await setup.document()
    second = await setup.document()

    async def label(
        item: Item, notation: str, *, source: str, state: str = "accepted"
    ) -> None:
        async with transaction_scope(setup.sessions) as session:
            session.add(
                ItemConcept(
                    item_id=item.id,
                    concept_id=domain[notation],
                    scheme_id=domain.scheme_id,
                    is_primary=True,
                    source=source,
                    state=state,
                    confidence=None if source == "human" else 0.9,
                    created_by_user_id=setup.admin.id if source == "human" else None,
                )
            )

    await label(first, "law", source="llm")
    await label(second, "law", source="llm")
    async with transaction_scope(setup.sessions) as session:
        await assignments.set_human_assignments(
            session,
            setup.ctx(),
            second.id,
            "domain",
            [domain["ai"], domain["law"]],
            domain["ai"],
        )

    async with transaction_scope(setup.sessions) as session:
        assert (
            await assignments.remap(
                session, domain["law"], [domain["ai"], domain["data"]]
            )
            == 0
        )
        moved = await assignments.remap(session, domain["law"], [domain["ai"]])

    assert moved == 2
    first_rows = await _live(setup, first)
    assert _state(first_rows) == {("domain", "ai"): ("llm", "accepted", True)}
    assert first_rows[("domain", "ai")].evidence["replacedFrom"] == str(domain["law"])
    # The document already carrying the target keeps one label, the stronger one.
    second_rows = await _rows(setup, second)
    assert [(code, n, row.state) for code, n, row in second_rows] == [
        ("domain", "ai", "accepted")
    ]
    assert second_rows[0][2].is_primary


async def test_reevaluate_rule_rows_follows_changed_rules(setup: Setup) -> None:
    document = await setup.document()
    await setup.load_plan()
    setup.answer("ai")
    await setup.index_document(document)
    assert ("function", "training") in await _live(setup, document)

    async with transaction_scope(setup.sessions) as session:
        await session.execute(
            update(ConceptRule)
            .where(ConceptRule.code == "decision-training")
            .values(deleted_at=func.now())
        )
    await rule(
        setup.sessions,
        setup.workspace.id,
        setup.taxonomy,
        R(
            "handbook-research",
            then=("function", "research"),
            when_collection=setup.handbook.id,
        ),
    )

    async with transaction_scope(setup.sessions) as session:
        changed = await assignments.reevaluate_rule_rows(
            session, setup.workspace.id, [document.id]
        )

    assert changed == 2
    rows = await _live(setup, document)
    assert _state({key: row for key, row in rows.items() if key[0] != "domain"}) == {
        ("document-type", "decision"): ("rule", "accepted", False),
        ("function", "research"): ("rule", "accepted", False),
    }
    assert rows[("function", "research")].evidence["rule"] == "handbook-research"


async def test_profiles_keep_human_fields_and_resolve_supersessions(
    setup: Setup,
) -> None:
    old = await setup.document("Quyết định cũ")
    new = await setup.document("Quyết định mới")
    later = await setup.document("Quyết định sau")
    tenant = setup.workspace.id

    async with transaction_scope(setup.sessions) as session:
        await profiles.write_extracted_profile(
            session,
            new.id,
            tenant,
            ExtractedMetadata(
                number="123/QĐ-X",
                issued_on=date(2025, 8, 5),
                level="cohort",
                cohorts=(2022,),
                applicability_confidence=0.95,
                supersedes=("45/QĐ-X",),
            ),
            revision_number=1,
        )
    async with transaction_scope(setup.sessions) as session:
        profile = await session.get(DocumentProfile, new.id)
        assert profile is not None
        assert profile.unresolved_supersedes == ["45/QĐ-X"]
        assert profile.field_sources["number"] == "extracted"

    # A person numbers the old document (spacing and case differ): the pending
    # reference resolves.
    async with transaction_scope(setup.sessions) as session:
        await profiles.set_issuance(
            session, old.id, tenant, profiles.IssuanceInput(number="45/qđ - X")
        )
    # Extraction resolves a printed number at once.
    async with transaction_scope(setup.sessions) as session:
        await profiles.write_extracted_profile(
            session,
            later.id,
            tenant,
            ExtractedMetadata(supersedes=("123/QĐ-X",)),
            revision_number=1,
        )
    async with transaction_scope(setup.sessions) as session:
        records = await profiles.profile_records(session, [old.id, new.id, later.id])
    assert records[new.id].supersedes == (old.id,)
    assert records[later.id].supersedes == (new.id,)
    assert records[old.id].field_sources["number"] == "human"
    async with transaction_scope(setup.sessions) as session:
        profile = await session.get(DocumentProfile, new.id)
        assert profile is not None and profile.unresolved_supersedes == []

    # Human fields survive extraction; the others take the new revision's values.
    async with transaction_scope(setup.sessions) as session:
        await profiles.set_applicability(
            session, new.id, tenant, profiles.ApplicabilityInput(level="institution")
        )
    async with transaction_scope(setup.sessions) as session:
        await profiles.write_extracted_profile(
            session,
            new.id,
            tenant,
            ExtractedMetadata(number="124/QĐ-X", level="cohort", cohorts=(2023,)),
            revision_number=2,
        )
    async with transaction_scope(setup.sessions) as session:
        records = await profiles.profile_records(session, [new.id])
        profile = await session.get(DocumentProfile, new.id)
    record = records[new.id]
    assert record.level == "institution" and record.cohorts == ()
    assert record.applicability_confidence == 1.0
    assert record.number == "124/QĐ-X" and record.issued_on is None
    assert record.supersedes == ()
    assert profile is not None and profile.revision_number == 2

    # A person's issuance is never overwritten by extraction.
    async with transaction_scope(setup.sessions) as session:
        await profiles.write_extracted_profile(
            session,
            old.id,
            tenant,
            ExtractedMetadata(number="99/QĐ-X"),
            revision_number=2,
        )
        records = await profiles.profile_records(session, [old.id])
    assert records[old.id].number == "45/qđ - X"


async def test_classify_document_reuses_the_structure_without_indexing(
    setup: Setup, runtime: AppRuntime, fakes: Fakes, knowledge: Knowledge
) -> None:
    document = await setup.document()
    await setup.load_plan()
    setup.answer("ai", "data")
    await setup.index_document(document)
    points = dict(fakes.index_backend.points)
    indexed = setup.index.indexed
    state = await knowledge.index_state(document)
    before = (
        state.index_status,
        state.processed_version,
        state.indexed_revision_number,
    )

    setup.answer("data")
    count = await setup.ingestion(runtime).classify_document(
        document.id, tenant_id=setup.workspace.id, plan=setup.plan
    )

    assert count >= 1
    # The original was never stored: a parse would have failed.
    assert setup.index.indexed == indexed
    assert fakes.index_backend.points == points
    state = await knowledge.index_state(document)
    assert (
        state.index_status,
        state.processed_version,
        state.indexed_revision_number,
    ) == before
    rows = await _live(setup, document)
    assert _state({key: row for key, row in rows.items() if key[0] == "domain"}) == {
        ("domain", "data"): ("llm", "accepted", True),
    }
    assert (await _outcomes(setup, document))["domain"].outcome == "assigned"
