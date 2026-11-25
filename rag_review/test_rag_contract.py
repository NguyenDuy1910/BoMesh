"""Regression probes for the RAG review (rag_review/REPORT.md).

Each test states the DESIRED behaviour. Tests for gaps that exist today are
``xfail(strict=True)`` with the finding ID: the suite is green now, and the
moment a fix lands the test XPASSes, fails the strict marker, and the marker
must be removed so the behaviour stays pinned.

Run offline (no API keys, no database, no Qdrant):
    cd backend && uv run python -m pytest ../rag_review -q -rxX
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))
os.environ.setdefault("BOMESH_SANDBOX_ENABLED", "false")

from native_responses import (  # noqa: E402
    ScriptedResponsesTransport,
    completed,
    created,
    function_call,
    message,
)

from bomesh import render_agent_base  # noqa: E402
from bomesh.agent import Agent, SessionConfiguration  # noqa: E402
from bomesh.agent.models import AgentContext  # noqa: E402
from bomesh.agent.tools import ToolRegistry  # noqa: E402
from bomesh.agent.tools.core.orchestrator import _tool_signature  # noqa: E402
from bomesh.agent.tools.knowledge_search import KnowledgeSearch  # noqa: E402
from bomesh.connector.protocol import (  # noqa: E402
    CitationInfo,
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.document_index import ChunkContext, ContextualChunk  # noqa: E402
from bomesh.document_index.payload import _IndexedChunk  # noqa: E402
from bomesh.knowledge import (  # noqa: E402
    DocumentFacts,
    EvidenceContextBuilder,
    ItemKnowledgeRetriever,
    KnowledgeRetriever,
    ReadScope,
)

CONTEXT = AgentContext(
    user_id="user-1",
    tenant_id="tenant-1",
    collection_item_ids=("collection-1",),
    allowed_tool_names=("knowledge_search",),
)


def chunk(item_id: str, title: str, text: str, score: float) -> ContextualChunk:
    return ContextualChunk(
        id=f"{item_id}:0",
        item_id=item_id,
        chunk_index=0,
        content_type="text",
        chunk_text=text,
        contextual_text=f"Document: {title}\n\n{text}",
        context=ChunkContext(section_path=[]),
        title=title,
        collection_item_id="collection-1",
        source=SourceIdentity(
            connector_id="upload",
            provider=SourceProvider.FILE if hasattr(SourceProvider, "FILE") else SourceProvider.CONFLUENCE,
            external_id=item_id,
        ),
        hierarchy=Hierarchy(),
        access=EffectiveAccess(),
        citation=CitationInfo(),
        relevance_score=score,
    )


class Index:
    def __init__(self, chunks: list[ContextualChunk]) -> None:
        self.chunks = chunks

    async def search_item_content(self, queries: Sequence[str], **_: object) -> list[ContextualChunk]:
        return self.chunks


class Access:
    """Re-check admits every hit, reporting each document's database update time."""

    def __init__(self, updated: dict[str, datetime]) -> None:
        self.updated = updated

    async def scope(self, ctx: AgentContext) -> ReadScope:
        async def recheck(item_ids: Sequence[str]) -> dict[str, DocumentFacts]:
            return {i: DocumentFacts(updated_at=self.updated.get(i)) for i in item_ids}

        return ReadScope(readable=ctx.collection_item_ids, editable=(), recheck=recheck, documents=())


OLD = chunk("reg-2024", "Quy chế chi tiêu nội bộ", "Phụ cấp hạng A là 100.000 đồng/tháng.", 0.82)
NEW = chunk("reg-2026", "Quy chế chi tiêu nội bộ", "Phụ cấp hạng A là 150.000 đồng/tháng.", 0.80)
UPDATED = {
    "reg-2024": datetime(2024, 1, 15, tzinfo=UTC),
    "reg-2026": datetime(2026, 7, 1, tzinfo=UTC),
}


# --- A. Ingestion / index --------------------------------------------------


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-A1: index payload has no validity/version/status fields")
def test_index_payload_carries_validity_version_and_status() -> None:
    assert {"effective_from", "valid_until", "revision_number", "doc_status"} <= set(
        _IndexedChunk.model_fields
    )


# --- B. Retrieval ----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-A4/B6: superseded version is returned (and ranked first)")
async def test_current_question_does_not_return_superseded_version() -> None:
    retriever = ItemKnowledgeRetriever(Index([OLD, NEW]), access=Access(UPDATED))
    evidence = await retriever.search(["phụ cấp hạng A hiện hành"], limit=6, ctx=CONTEXT)
    assert [e.item_id for e in evidence] == ["reg-2026"]


@pytest.mark.asyncio
@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-B9: no relevance floor when reranking is off (default)")
async def test_irrelevant_candidates_are_not_returned_as_evidence() -> None:
    noise = chunk("menu", "Thực đơn căng tin", "Thứ Hai: cơm gà, canh chua.", 0.016)
    retriever = ItemKnowledgeRetriever(Index([noise]), access=Access({}))
    evidence = await retriever.search(["mức phạt vi phạm hợp đồng NCC-2025-07"], limit=6, ctx=CONTEXT)
    assert evidence == []


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-B12: evidence shown to the model carries no date/version")
def test_evidence_header_tells_the_model_how_current_the_source_is() -> None:
    retriever_evidence = [
        _evidence(OLD, UPDATED["reg-2024"]),
        _evidence(NEW, UPDATED["reg-2026"]),
    ]
    text = EvidenceContextBuilder().build(retriever_evidence).text
    assert "2024" in text.split("Evidence:")[0] and "2026-07-01" in text


def _evidence(c: ContextualChunk, updated_at: datetime):
    from bomesh.knowledge import Evidence, source_reference

    return Evidence(
        id=source_reference(c.item_id, c.id),
        item_id=c.item_id,
        chunk_id=c.id,
        collection_item_id=c.collection_item_id,
        title=c.title or c.item_id,
        content=c.chunk_text,
        source=c.source,
        citation=c.citation,
        section_path=(),
        contextual_text=c.contextual_text,
        relevance_score=c.relevance_score,
        rerank_score=None,
        document=DocumentFacts(updated_at=updated_at),
    )


# --- B. Tool contract and agent loop ---------------------------------------


class _NoRetriever(KnowledgeRetriever):
    async def search(self, queries, *, limit, ctx):  # type: ignore[override]
        return []


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-B6: knowledge_search accepts only free-text queries")
def test_search_tool_accepts_time_and_scope_filters() -> None:
    properties = KnowledgeSearch(_NoRetriever()).spec().input_schema["properties"]
    assert "as_of" in properties


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-B7: duplicate guard compares raw JSON, not normalized queries")
def test_near_identical_search_is_treated_as_a_repeat() -> None:
    first = _tool_signature("knowledge_search", {"queries": ["nghỉ phép năm"]})
    again = _tool_signature("knowledge_search", {"queries": ["Nghỉ phép năm "]})
    assert first == again


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-B1: prompt mandates search for out-of-domain questions")
def test_prompt_exempts_general_knowledge_from_search() -> None:
    prompt = " ".join(render_agent_base().split()).lower()
    exemption = prompt.split("answer without searching", 1)[1].split(".", 1)[0]
    assert "general" in exemption or "unrelated to" in exemption


def _direct_answer() -> list[list[object]]:
    return [[*created("r1"), *message(item_id="m1", output_index=0, deltas=["Xin chào!"], phase="final_answer"), *completed("r1")]]


@pytest.mark.asyncio
@pytest.mark.xfail(strict=True, raises=AssertionError, reason="F-B2: the model is never told today's date")
async def test_model_input_states_the_current_date() -> None:
    transport = ScriptedResponsesTransport(_direct_answer())
    registry = ToolRegistry()
    registry.register(KnowledgeSearch(_NoRetriever()))
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=2)
    agent = Agent(model=transport, tools=registry, configuration=configuration)
    _ = [event async for event in agent.run("Quy chế nào đang có hiệu lực?", CONTEXT)]
    request = transport.requests[0]
    today = date.today().isoformat()
    assert today in request["instructions"] or today in str(request["input"])


@pytest.mark.asyncio
async def test_empty_search_reaches_the_model_as_no_evidence() -> None:
    """Đạt today: an empty retrieval is reported to the model, not silently dropped."""
    transport = ScriptedResponsesTransport(
        [
            [
                *created("r1"),
                *function_call(
                    item_id="fc1",
                    output_index=0,
                    call_id="c1",
                    name="knowledge_search",
                    argument_deltas=['{"queries":["quy trình hoàn ứng QT-99"]}'],
                ),
                *completed("r1"),
            ],
            [*created("r2"), *message(item_id="m2", output_index=0, deltas=["Không tìm thấy."], phase="final_answer"), *completed("r2")],
        ]
    )
    registry = ToolRegistry()
    registry.register(KnowledgeSearch(_NoRetriever()))
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=2)
    agent = Agent(model=transport, tools=registry, configuration=configuration)
    _ = [event async for event in agent.run("Quy trình hoàn ứng QT-99?", CONTEXT)]
    tool_output = str(transport.requests[1]["input"])
    assert "No matching access-permitted enterprise documents were found." in tool_output
