"""Permission-scoped knowledge retrieval and grounded evidence contracts."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from bomesh.connector.protocol import CitationInfo, SourceIdentity
from bomesh.document_index import ContextualChunk


class RetrievalContext(Protocol):
    """Who searches, in which workspace, over which collections (and their subtrees).

    The retriever resolves what the user may read in PostgreSQL itself;
    ``collection_item_ids`` only narrows it.
    """

    tenant_id: str
    user_id: str
    collection_item_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ReadScope:
    """What one caller may retrieve: the index pre-filter and the hit re-check.

    ``readable`` and ``editable`` are collection IDs (published points of
    readable collections, and every point of editable ones); ``recheck``
    returns the subset of item IDs the visibility rule admits right now.
    """

    readable: tuple[str, ...]
    editable: tuple[str, ...]
    recheck: Callable[[Sequence[str]], Awaitable[frozenset[str]]]


class ReadAccess(Protocol):
    """Resolves a :class:`ReadScope` from the authoritative store (PostgreSQL)."""

    async def scope(self, ctx: RetrievalContext) -> ReadScope: ...


@dataclass(frozen=True, slots=True)
class Evidence:
    """Canonical source evidence safe to pass to the agent."""

    id: str
    item_id: str
    chunk_id: str
    title: str
    content: str
    collection_item_id: str | None = None
    source: SourceIdentity | None = None
    citation: CitationInfo = field(default_factory=CitationInfo)
    section_path: tuple[str, ...] = ()
    contextual_text: str | None = None
    relevance_score: float | None = None
    rerank_score: float | None = None


@dataclass(frozen=True, slots=True)
class EvidenceContext:
    """Bounded model context and the exact evidence represented in it."""

    text: str
    evidence: tuple[Evidence, ...]


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
    ) -> list[Evidence]: ...


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
from .retriever import ItemKnowledgeRetriever, source_reference
from .semantic_reranker import SemanticReranker

__all__ = [
    "CitationResolver",
    "ContextBuilder",
    "Evidence",
    "EvidenceContext",
    "EvidenceContextBuilder",
    "ItemKnowledgeRetriever",
    "ItemReadAccess",
    "KnowledgeRetriever",
    "ReadAccess",
    "ReadScope",
    "Reranker",
    "RetrievalContext",
    "SemanticReranker",
    "source_reference",
]
