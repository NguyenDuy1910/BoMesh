"""Permission-scoped knowledge retrieval and grounded evidence contracts."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from bomesh.connector.protocol import SourceIdentity
from bomesh.document_index import ContextualChunk
from bomesh.document_structure import CitationTarget


class RetrievalContext(Protocol):
    """Who searches, in which workspace, over which collections (and their subtrees) and
    which single documents (space materials).

    The retriever resolves what the user may read in PostgreSQL itself;
    ``collection_item_ids`` and ``document_item_ids`` only narrow it.
    """

    tenant_id: str
    user_id: str
    collection_item_ids: tuple[str, ...]
    document_item_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DocumentFacts:
    """What a reader sees about a found document besides its passage, read with the re-check."""

    mime_type: str | None = None
    file_name: str | None = None
    updated_at: datetime | None = None
    #: Display name of the collection the document lives in (its parent).
    collection_title: str | None = None


@dataclass(frozen=True, slots=True)
class ReadScope:
    """What one caller may retrieve: the index pre-filter and the hit re-check.

    ``readable`` and ``editable`` are collection IDs (published points of
    readable collections, and every point of editable ones); ``documents`` are
    document IDs searched on their own (every point; the re-check decides).
    ``recheck`` returns the item IDs the visibility rule admits right now, each
    with its :class:`DocumentFacts` (read in the same query, so no extra round trip).
    """

    readable: tuple[str, ...]
    editable: tuple[str, ...]
    recheck: Callable[[Sequence[str]], Awaitable[Mapping[str, DocumentFacts]]]
    documents: tuple[str, ...] = ()


class ReadAccess(Protocol):
    """Resolves a :class:`ReadScope` from the authoritative store (PostgreSQL)."""

    async def scope(self, ctx: RetrievalContext) -> ReadScope: ...


@dataclass(frozen=True, slots=True)
class Evidence:
    """Canonical source evidence safe to pass to the agent.

    ``target`` is what a citation of this evidence stores: the blocks of the
    item's Structured Document the chunk was cut from. ``chunk_id`` is only the
    turn's internal key for the evidence (``CitationReferences``); it is never
    persisted.
    """

    id: str
    item_id: str
    chunk_id: str
    title: str
    content: str
    target: CitationTarget
    collection_item_id: str | None = None
    source: SourceIdentity | None = None
    section_path: tuple[str, ...] = ()
    contextual_text: str | None = None
    relevance_score: float | None = None
    rerank_score: float | None = None
    document: DocumentFacts | None = None
    #: The chunks around this match in document order (same revision, same
    #: heading or sheet), each its own citable evidence; empty unless the search
    #: asked for context. ``content`` stays the match alone.
    context_before: tuple[Evidence, ...] = ()
    context_after: tuple[Evidence, ...] = ()
    #: The reading of an ambiguous query this match answers (an option's display
    #: name, e.g. ``Loại tài liệu: Đồ án – khóa luận``); None for the single reading.
    group: str | None = None

    @property
    def passage(self) -> str:
        """The match with its context, in document order."""

        return "\n".join(part.content for part in (*self.context_before, self, *self.context_after))


@dataclass(frozen=True, slots=True)
class EvidenceContext:
    """Bounded model context and the exact evidence represented in it."""

    text: str
    evidence: tuple[Evidence, ...]


@dataclass(frozen=True, slots=True)
class QueryInterpretation:
    """How one query was read against the published taxonomy (``conversation_loop.md`` "Knowledge retrieval").

    ``concepts`` are the resolved readings (``"khóa luận" → Nghiệp vụ: …``); an
    ambiguous span's ``options`` are the groups its evidence is labeled with."""

    query: str
    concepts: tuple[str, ...] = ()
    ambiguity: str | None = None
    options: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Retrieval:
    """A search's evidence and how its queries were read."""

    evidence: list[Evidence]
    interpretations: tuple[QueryInterpretation, ...] = ()


@dataclass(frozen=True, slots=True)
class Recall:
    """A recall pass: ``query`` searched only over ``item_ids`` (documents a reading's
    concepts match, already within the caller's visibility)."""

    key: str
    query: str
    item_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RankedList:
    """Candidates in final order; ``group`` names the ambiguity option they answer."""

    chunks: list[ContextualChunk]
    group: str | None = None


class RankingPlan(Protocol):
    """One search's taxonomy-aware ranking (built per search by :class:`SearchRanking`)."""

    interpretations: tuple[QueryInterpretation, ...]
    recalls: tuple[Recall, ...]

    async def order(
        self, base: Sequence[ContextualChunk], recalled: Mapping[str, Sequence[ContextualChunk]]
    ) -> list[RankedList]:
        """The main ranking (``group`` None) or, for an ambiguous query, one list per
        option; boosted, and without documents the searcher's applicability excludes."""
        ...


class SearchRanking(Protocol):
    """Plans the interpretation, recall passes and boosts of one retrieval."""

    async def plan(
        self, ctx: RetrievalContext, queries: Sequence[str], scope: ReadScope
    ) -> RankingPlan | None: ...


@runtime_checkable
class KnowledgeRetriever(Protocol):
    """Tenant-scoped evidence retrieval boundary consumed by agents.

    One search answers every query together: their candidates are fused and
    ranked as one list, so the result is a single relevance ranking.
    """

    async def search(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: RetrievalContext,
        context_chunks: int = 0,
    ) -> list[Evidence]:
        """``limit`` matches, strongest first; with ``context_chunks``, each brings that
        many neighbours on each side (:attr:`Evidence.context_before` / ``context_after``)."""

    async def search_interpreted(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: RetrievalContext,
        context_chunks: int = 0,
    ) -> Retrieval:
        """:meth:`search` with how the queries were read; evidence of an ambiguous query
        is grouped per reading (:attr:`Evidence.group`). Without a taxonomy-aware
        ranking this is the plain search."""
        return Retrieval(
            evidence=await self.search(queries, limit=limit, ctx=ctx, context_chunks=context_chunks)
        )


class Reranker(Protocol):
    """Optional second stage over permission-filtered chunks.

    It returns only the chunks that help answer the queries, strongest first;
    an empty result means none do.
    """

    def rerank(
        self,
        chunks: Sequence[ContextualChunk],
        *,
        queries: Sequence[str],
        limit: int,
    ) -> list[ContextualChunk] | Awaitable[list[ContextualChunk]]: ...


class ContextBuilder(Protocol):
    """Build bounded model context from ranked canonical evidence."""

    def build(self, evidence: Sequence[Evidence]) -> EvidenceContext: ...


from .access import ItemReadAccess
from .context_builder import EvidenceContextBuilder
from .evidence import CitationResolver
from .retriever import ItemKnowledgeRetriever
from .semantic_reranker import SemanticReranker

__all__ = [
    "CitationResolver",
    "ContextBuilder",
    "DocumentFacts",
    "Evidence",
    "EvidenceContext",
    "EvidenceContextBuilder",
    "ItemKnowledgeRetriever",
    "ItemReadAccess",
    "KnowledgeRetriever",
    "QueryInterpretation",
    "RankedList",
    "RankingPlan",
    "ReadAccess",
    "ReadScope",
    "Recall",
    "Reranker",
    "Retrieval",
    "RetrievalContext",
    "SearchRanking",
    "SemanticReranker",
]
