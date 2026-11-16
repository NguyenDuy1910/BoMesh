"""CLASSIFYING inside contextual retrieval: candidates, assistant-applied topics.

The contextualization model picks the run's candidate topics that apply (no
threshold); they replace only earlier assistant-applied ``item_topics`` rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    CitationInfo,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Contribution,
    ContributionTopic,
    Item,
    ItemTopic,
    Tenant,
    Topic,
    User,
)
from bomesh.document_index import ItemIndex, SemanticContextualizer
from bomesh.runtime import AppRuntime
from bomesh.services.ingestion.run_engine import RunClassification
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from harness import Fakes, World
from knowledge_support import Knowledge

pytestmark = pytest.mark.asyncio


class _ProfileTransport:
    """The configured contextualization model: a profile reply, a context reply."""

    model = "configured-contextualization-model"

    def __init__(self, profile: str | Exception) -> None:
        self.profile = profile
        self.profile_prompts: list[str] = []

    async def responses(self, *, input: str, model: str | None = None, **_: Any) -> Any:
        if "<document_profile_instructions>" not in input:
            return SimpleNamespace(output_text="Situates the chunk in the policy.")
        self.profile_prompts.append(input)
        if isinstance(self.profile, Exception):
            raise self.profile
        return SimpleNamespace(output_text=self.profile)


def _classifying(runtime: AppRuntime, fakes: Fakes, transport: _ProfileTransport) -> None:
    runtime._index = ItemIndex(
        backend=fakes.index_backend,  # type: ignore[arg-type]
        embedder=fakes.embedder,
        semantic_contextualizer=SemanticContextualizer(
            transport, model_name=transport.model  # type: ignore[arg-type]
        ),
    )


async def _topic(
    world: World,
    workspace: Tenant,
    code: str,
    *,
    kind: str = "topic",
    parent: Topic | None = None,
    state: str = "active",
    deleted: bool = False,
) -> Topic:
    async with transaction_scope(world.sessions) as session:
        topic = Topic(
            tenant_id=workspace.id,
            code=code,
            kind=kind,
            parent_topic_id=parent.id if parent else None,
            display_name=code.title(),
            description=f"About {code}",
            state=state,
        )
        if deleted:
            topic.deleted_at = func.now()
        session.add(topic)
    return topic


async def _tags(world: World, document: Item) -> dict[str, Any]:
    async with transaction_scope(world.sessions) as session:
        rows = await session.execute(
            select(Topic.code, ItemTopic.created_by_user_id)
            .join(Topic, Topic.id == ItemTopic.topic_id)
            .where(ItemTopic.item_id == document.id)
        )
        return dict(rows.all())


async def _tag(world: World, document: Item, topic: Topic, by: Any) -> None:
    async with transaction_scope(world.sessions) as session:
        session.add(ItemTopic(item_id=document.id, topic_id=topic.id, created_by_user_id=by))


async def test_classification_replaces_assistant_topics_and_keeps_a_persons(
    runtime: AppRuntime, fakes: Fakes, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    handbook = await world.make_collection(workspace, title="Handbook")
    document = await world.make_document(handbook, title="Lending policy", published=False)
    await _topic(world, workspace, "lending")
    hr = await _topic(world, workspace, "hr")
    stale = await _topic(world, workspace, "stale")
    await _tag(world, document, hr, admin.id)
    await _tag(world, document, stale, None)
    transport = _ProfileTransport(
        '{"topics": ["lending", "hr", "made-up"], "summary": "The retail lending policy."}'
    )
    _classifying(runtime, fakes, transport)
    ingestion = ItemIngestionService(knowledge.sessions, index=runtime.item_index())
    request = await ingestion.classification_request(
        workspace.id, RunClassification(topics=(), note="Bank policies")
    )

    await knowledge.index(document, ["Loans need two approvals."], classification=request)

    assert len(transport.profile_prompts) == 1
    assert "Bank policies" in transport.profile_prompts[0]
    assert {"lending", "hr", "stale"} <= {c.code for c in request.candidates}  # type: ignore[union-attr]
    assert await _tags(world, document) == {"lending": None, "hr": admin.id}
    row = await knowledge.row(document)
    assert row.index_status == "ready"
    assert row.is_published is False


@pytest.mark.parametrize("profile", ["not json at all", RuntimeError("provider down")])
async def test_a_failed_classification_still_indexes_without_topics(
    runtime: AppRuntime,
    fakes: Fakes,
    world: World,
    knowledge: Knowledge,
    profile: str | Exception,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    handbook = await world.make_collection(workspace, title="Handbook")
    document = await world.make_document(handbook, title="Lending policy")
    await _topic(world, workspace, "lending")
    transport = _ProfileTransport(profile)
    _classifying(runtime, fakes, transport)
    ingestion = ItemIngestionService(knowledge.sessions, index=runtime.item_index())
    request = await ingestion.classification_request(workspace.id, None)

    await knowledge.index(document, ["Loans need two approvals."], classification=request)

    assert len(transport.profile_prompts) == 1
    assert await _tags(world, document) == {}
    assert (await knowledge.row(document)).index_status == "ready"


async def test_classification_request_files_under_topics_and_keeps_only_active_ones(
    world: World, knowledge: Knowledge, runtime: AppRuntime
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    retail = await _topic(world, workspace, "retail", kind="domain")
    await _topic(world, workspace, "lending", parent=retail)
    await _topic(world, workspace, "cards", parent=retail, state="proposed")
    await _topic(world, workspace, "deposits", parent=retail, deleted=True)
    await _topic(world, workspace, "hr")
    await _topic(world, workspace, "payroll")
    # A domain without ACTIVE topics stands for itself.
    legal = await _topic(world, workspace, "legal", kind="domain")
    await _topic(world, workspace, "contracts", parent=legal, state="proposed")
    ingestion = ItemIngestionService(knowledge.sessions, index=runtime.item_index())

    chosen = await ingestion.classification_request(
        workspace.id, RunClassification(topics=("retail", "hr", "legal"), note="Q3 batch")
    )
    every = await ingestion.classification_request(workspace.id, None)
    other = await world.make_workspace(admin)
    nothing = await ingestion.classification_request(other.id, None)

    assert chosen is not None and every is not None
    # A domain is never a candidate beside its own topics: documents are filed under topics.
    assert [(c.code, c.domain) for c in chosen.candidates] == [
        ("hr", None),
        ("legal", None),
        ("lending", "Retail"),
    ]
    assert chosen.note == "Q3 batch"
    assert [c.code for c in every.candidates] == ["hr", "legal", "lending", "payroll"]
    assert every.note is None
    assert nothing is None


class _Content:
    """Stored content that canonicalizes into one chunk (no object storage)."""

    async def canonicalize(self, document: Item) -> Any:
        item = DocumentItem(
            id=str(document.id),
            title=document.title,
            document_kind=DocumentKind.NOTE,
            source=SourceIdentity(
                connector_id="upload", provider=SourceProvider.FILE, external_id=str(document.id)
            ),
            hierarchy=Hierarchy(parent_id=str(document.parent_item_id)),
            access=AccessPolicy(),
        )
        chunk = Chunk(
            id=f"{document.id}:0",
            item_id=str(document.id),
            chunk_index=0,
            chunk_text="Dispute 42 was charged back.",
            content_type="text",
            citation=CitationInfo(),
        )
        return SimpleNamespace(item=item, chunks=[chunk])


async def test_a_matching_rule_settles_topics_without_asking_the_model(
    runtime: AppRuntime, fakes: Fakes, world: World, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    handbook = await world.make_collection(workspace, title="Handbook")
    folder = await world.make_collection(workspace, handbook, title="Chargebacks")
    document = await world.make_document(folder, title="Dispute 42")
    async with transaction_scope(world.sessions) as session:
        row = await session.get(Item, document.id)
        assert row is not None
        row.storage_key = f"objects/{document.id}"
        chargebacks = Topic(
            tenant_id=workspace.id,
            code="chargebacks",
            kind="topic",
            display_name="Chargebacks",
            rule_collection_ids=[handbook.id],
        )
        session.add_all([chargebacks, Topic(tenant_id=workspace.id, code="hr", kind="topic", display_name="HR")])
    transport = _ProfileTransport('{"topics": ["hr"], "summary": "Should not be asked."}')
    _classifying(runtime, fakes, transport)
    ingestion = ItemIngestionService(
        knowledge.sessions, index=runtime.item_index(), content=_Content()  # type: ignore[arg-type]
    )
    request = await ingestion.classification_request(workspace.id, None)
    phases: list[str] = []

    await ingestion.process_document(
        document.id,
        tenant_id=workspace.id,
        classification=request,
        progress=lambda phase, *_: phases.append(phase),
    )

    assert transport.profile_prompts == []
    assert "classifying" in phases
    assert await _tags(world, document) == {"chargebacks": None}


# -- The candidate of an open NEW_DOCUMENT contribution (processing before review) --

_RULE_SUGGESTIONS = {
    "document_type": "pdf",
    "document_type_confidence": 0.9,
    "topics_confidence": 0.6,
    "summary": "From the rules.",
    "summary_confidence": 0.4,
}


@dataclass
class _Submission:
    workspace: Tenant
    kb: Item
    candidate: Item
    contribution: Contribution
    stale: Topic


async def _submission(world: World, *, target: bool = True) -> _Submission:
    """A member's candidate in their PERSONAL collection, under review for ``kb``
    (its target, or with ``target=False`` the suggested collection); the rule
    analysis suggested ``stale``."""
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member: User = await world.add_member(workspace)
    kb = await world.make_collection(workspace, title="Handbook")
    personal = await world.make_collection(workspace, personal_for=member)
    candidate = await world.make_document(personal, title="Dispute 42", creator=member)
    stale = await _topic(world, workspace, "stale")
    async with transaction_scope(world.sessions) as session:
        row = await session.get(Item, candidate.id)
        assert row is not None
        row.storage_key = f"objects/{candidate.id}"
        contribution = Contribution(
            tenant_id=workspace.id,
            item_id=candidate.id,
            kind="new_document",
            origin="member",
            contributor_user_id=member.id,
            target_item_id=kb.id if target else None,
            suggestions=(
                _RULE_SUGGESTIONS if target else {**_RULE_SUGGESTIONS, "collection_id": str(kb.id)}
            ),
            state="in_review",
        )
        session.add(contribution)
        await session.flush()
        session.add(
            ContributionTopic(contribution_id=contribution.id, topic_id=stale.id, relation="suggested")
        )
    return _Submission(workspace, kb, candidate, contribution, stale)


async def _suggested(world: World, contribution: Contribution) -> tuple[set[str], Contribution]:
    async with transaction_scope(world.sessions) as session:
        codes = set(
            await session.scalars(
                select(Topic.code)
                .join(ContributionTopic, ContributionTopic.topic_id == Topic.id)
                .where(
                    ContributionTopic.contribution_id == contribution.id,
                    ContributionTopic.relation == "suggested",
                )
            )
        )
        row = await session.get(Contribution, contribution.id)
        assert row is not None
        return codes, row


async def _process_candidate(
    runtime: AppRuntime, knowledge: Knowledge, submission: _Submission
) -> None:
    ingestion = ItemIngestionService(
        knowledge.sessions, index=runtime.item_index(), content=_Content()  # type: ignore[arg-type]
    )
    request = await ingestion.classification_request(submission.workspace.id, None)
    await ingestion.process_document(
        submission.candidate.id, tenant_id=submission.workspace.id, classification=request
    )


async def test_processing_an_open_candidate_replaces_its_contribution_suggestions(
    runtime: AppRuntime, fakes: Fakes, world: World, knowledge: Knowledge
) -> None:
    submission = await _submission(world)
    await _topic(world, submission.workspace, "lending")
    transport = _ProfileTransport(
        '{"topics": ["lending"], "summary": "The retail lending dispute."}'
    )
    _classifying(runtime, fakes, transport)
    _, before = await _suggested(world, submission.contribution)

    await _process_candidate(runtime, knowledge, submission)

    codes, after = await _suggested(world, submission.contribution)
    assert len(transport.profile_prompts) == 1
    assert codes == {"lending"}
    # Confidences are cleared: the run chose, there is no score.
    assert after.suggestions == {
        "document_type": "pdf",
        "document_type_confidence": 0.9,
        "summary": "The retail lending dispute.",
    }
    assert after.updated_at > before.updated_at
    assert after.state == "in_review"
    assert (await knowledge.row(submission.candidate)).index_status == "ready"


@pytest.mark.parametrize("target", [True, False], ids=["target", "suggested"])
async def test_an_open_candidate_matches_rules_where_it_is_headed(
    runtime: AppRuntime, fakes: Fakes, world: World, knowledge: Knowledge, target: bool
) -> None:
    submission = await _submission(world, target=target)
    async with transaction_scope(world.sessions) as session:
        session.add(
            Topic(
                tenant_id=submission.workspace.id,
                code="chargebacks",
                kind="topic",
                display_name="Chargebacks",
                rule_collection_ids=[submission.kb.id],
            )
        )
    transport = _ProfileTransport('{"topics": ["stale"], "summary": "Should not be asked."}')
    _classifying(runtime, fakes, transport)

    await _process_candidate(runtime, knowledge, submission)

    codes, after = await _suggested(world, submission.contribution)
    assert transport.profile_prompts == []
    assert codes == {"chargebacks"}
    assert await _tags(world, submission.candidate) == {"chargebacks": None}
    assert "topics_confidence" not in after.suggestions


async def test_a_failed_classification_keeps_the_rule_suggestions(
    runtime: AppRuntime, fakes: Fakes, world: World, knowledge: Knowledge
) -> None:
    submission = await _submission(world)
    _classifying(runtime, fakes, _ProfileTransport(RuntimeError("provider down")))
    before_codes, before = await _suggested(world, submission.contribution)

    await _process_candidate(runtime, knowledge, submission)

    codes, after = await _suggested(world, submission.contribution)
    assert codes == before_codes == {"stale"}
    assert after.suggestions == _RULE_SUGGESTIONS
    assert after.updated_at == before.updated_at
    assert (await knowledge.row(submission.candidate)).index_status == "ready"
