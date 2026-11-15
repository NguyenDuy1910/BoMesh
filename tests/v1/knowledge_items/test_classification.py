"""CLASSIFYING inside contextual retrieval: candidates, assistant-applied topics.

The contextualization model picks the run's candidate topics that apply (no
threshold); they replace only earlier assistant-applied ``item_topics`` rows.
"""

from __future__ import annotations

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
from bomesh.db.models import Item, ItemTopic, Tenant, Topic
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
    assert row.publication_state == "unpublished"


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
