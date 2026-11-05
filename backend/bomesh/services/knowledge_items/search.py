"""SearchItems and agent retrieval: PostgreSQL decides, the index pre-filters.

Readable and editable collections come from PostgreSQL per request; the index
returns only points of readable collections that are published or editable;
every hit is then re-checked in PostgreSQL before any text is returned
(``item_model.md`` §4.10, invariant 7).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemTopic, Topic
from bomesh.document_index import ContextualChunk
from bomesh.iam.authorizer import WorkspaceAccess, WorkspaceRef
from bomesh.iam.visibility import ItemVisibility
from bomesh.knowledge import Evidence, ItemKnowledgeRetriever
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.item_store import catalog_visibility
from bomesh.services.knowledge_items.queries import (
    LANGUAGE,
    OWNER_ID,
    SOURCE_CODE,
    VERIFICATION_STATE,
)
from bomesh.services.knowledge_items.records import (
    Facet,
    FacetRequest,
    FacetValue,
    SearchPage,
    SearchPassage,
    SearchRequest,
    SearchResult,
)
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    Projector,
    load_referenced,
)

#: Chunks read from the index for one search; hits are grouped per document.
CANDIDATE_CHUNKS = 200
SNIPPET_CHARACTERS = 240
DEFAULT_FACET_LIMIT = 10

_SCALAR_FACETS: dict[str, Any] = {
    "document.documentType": Item.document_type,
    "document.mimeType": Item.mime_type,
    "document.languageCode": LANGUAGE,
    "document.owner": OWNER_ID,
    "document.origin.source": SOURCE_CODE,
    "document.verification.state": VERIFICATION_STATE,
}
FACET_FIELDS = frozenset({*_SCALAR_FACETS, "document.topics", "ancestors"})


@dataclass(slots=True)
class _Hit:
    score: float
    chunks: list[ContextualChunk]


class ItemSearchService:
    """The one catalog and retrieval search over DOCUMENT items."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemSearchService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def search(
        self, ctx: RequestContext, workspace_id: UUID, request: SearchRequest
    ) -> SearchPage:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "items.search", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            for referenced in request.referenced_items:
                await load_referenced(session, ctx, workspace_id, referenced, permission="items.get")
            query = request.query.strip()
            excluded: UUID | None = None
            if request.related_item_id is not None:
                related = await load_referenced(
                    session, ctx, workspace_id, request.related_item_id, permission="items.get"
                )
                query = " ".join(
                    part
                    for part in (query, related.title, related.metadata_.get("summary"))
                    if isinstance(part, str) and part
                )
                excluded = related.id
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
        hits = await self._hits(workspace_id, visibility, query) if query else None
        if hits is not None and excluded is not None:
            hits.pop(excluded, None)
        async with transaction_scope(self._deps.sessions) as session:
            scope = and_(Item.item_type == "document", visibility.clause())
            if hits is not None:
                scope = and_(scope, Item.id.in_(list(hits)))
            matching = and_(scope, request.where)
            total = int(
                await session.scalar(
                    select(func.count()).select_from(select(Item.id).where(matching).subquery())
                )
                or 0
            )
            rows = await self._page(session, matching, request, hits)
            projector = Projector(session, ctx, workspace_id, self._deps, visibility=visibility)
            results = [
                await self._result(projector, row, hits, request) for row in rows
            ]
            facets = [
                await self._facet(session, workspace_id, visibility, scope, facet)
                for facet in request.facets
            ]
        return SearchPage(results=results, facets=facets, total_size=total)

    async def _hits(
        self, workspace_id: UUID, visibility: ItemVisibility, query: str
    ) -> dict[UUID, _Hit]:
        if not visibility.readable:
            return {}
        chunks = await self._deps.index.search_item_content(
            [query],
            limit=CANDIDATE_CHUNKS,
            tenant_id=str(workspace_id),
            collection_item_ids=tuple(str(value) for value in visibility.readable),
            editable_collection_ids=tuple(str(value) for value in visibility.editable),
        )
        hits: dict[UUID, _Hit] = {}
        for chunk in chunks:
            hit = hits.setdefault(UUID(chunk.item_id), _Hit(score=0.0, chunks=[]))
            hit.score = max(hit.score, chunk.relevance_score or 0.0)
            hit.chunks.append(chunk)
        return hits

    async def _page(
        self,
        session: AsyncSession,
        matching: Any,
        request: SearchRequest,
        hits: dict[UUID, _Hit] | None,
    ) -> list[Item]:
        if hits is None or request.order_by:
            order = request.order_by or (Item.updated_at.desc(), Item.id)
            return list(
                await session.scalars(
                    select(Item)
                    .where(matching)
                    .order_by(*order)
                    .offset(request.offset)
                    .limit(request.limit)
                )
            )
        rows = {row.id: row for row in await session.scalars(select(Item).where(matching))}
        ranked = sorted(rows, key=lambda item_id: (-hits[item_id].score, str(item_id)))
        return [rows[item_id] for item_id in ranked[request.offset : request.offset + request.limit]]

    async def _result(
        self,
        projector: Projector,
        item: Item,
        hits: dict[UUID, _Hit] | None,
        request: SearchRequest,
    ) -> SearchResult:
        record = await projector.project(item)
        hit = hits.get(item.id) if hits is not None else None
        if hit is None:
            return SearchResult(item=record, score=None)
        chunks = sorted(hit.chunks, key=lambda chunk: -(chunk.relevance_score or 0.0))
        return SearchResult(
            item=record,
            score=hit.score,
            snippets=(chunks[0].chunk_text[:SNIPPET_CHARACTERS],) if request.snippets else (),
            passages=tuple(
                SearchPassage(
                    chunk_id=chunk.id,
                    text=chunk.chunk_text,
                    page_number=chunk.citation.page_start,
                    score=chunk.relevance_score,
                )
                for chunk in chunks[: request.passages]
            ),
        )

    async def _facet(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        visibility: ItemVisibility,
        scope: Any,
        facet: FacetRequest,
    ) -> Facet:
        """Disjunctive counts: the facet's own clause is left out of ``facet.where``."""
        matching = select(Item.id).where(scope, facet.where).subquery()
        limit = facet.limit or DEFAULT_FACET_LIMIT
        if facet.field in _SCALAR_FACETS:
            expression = _SCALAR_FACETS[facet.field]
            rows = await session.execute(
                select(expression, func.count())
                .where(Item.id.in_(select(matching.c.id)), expression.is_not(None))
                .group_by(expression)
                .order_by(func.count().desc(), expression)
                .limit(limit)
            )
            values = tuple(
                FacetValue(
                    value=str(value),
                    display_name=None,
                    document_count=int(count),
                )
                for value, count in rows
            )
        elif facet.field == "document.topics":
            rows = await session.execute(
                select(Topic.code, Topic.display_name, func.count())
                .join(ItemTopic, ItemTopic.topic_id == Topic.id)
                .where(ItemTopic.item_id.in_(select(matching.c.id)))
                .group_by(Topic.code, Topic.display_name)
                .order_by(func.count().desc(), Topic.code)
                .limit(limit)
            )
            values = tuple(
                FacetValue(
                    value=code,
                    display_name=display_name,
                    document_count=int(count),
                )
                for code, display_name, count in rows
            )
        else:
            values = await self._ancestor_facet(session, workspace_id, visibility, matching, limit)
        return Facet(field=facet.field, values=values)

    async def _ancestor_facet(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        visibility: ItemVisibility,
        matching: Any,
        limit: int,
    ) -> tuple[FacetValue, ...]:
        """Counts per readable ancestor collection (the ``Item.ancestors`` truncation)."""
        seed = select(Item.id.label("document_id"), Item.parent_item_id.label("ancestor_id")).where(
            Item.id.in_(select(matching.c.id))
        ).cte("facet_ancestors", recursive=True)
        parent = Item.__table__.alias("facet_parent")
        tree = seed.union_all(
            select(seed.c.document_id, parent.c.parent_item_id).where(
                parent.c.id == seed.c.ancestor_id, parent.c.parent_item_id.is_not(None)
            )
        )
        rows = await session.execute(
            select(Item.id, Item.title, func.count(func.distinct(tree.c.document_id)))
            .join(tree, tree.c.ancestor_id == Item.id)
            .where(Item.item_type == "collection", Item.id.in_(visibility.readable))
            .group_by(Item.id, Item.title)
            .order_by(func.count(func.distinct(tree.c.document_id)).desc(), Item.title)
            .limit(limit)
        )
        return tuple(
            FacetValue(
                value=str(identifier),
                display_name=title,
                document_count=int(count),
            )
            for identifier, title, count in rows
        )


async def retrieve_passages(
    retriever: ItemKnowledgeRetriever,
    access: WorkspaceAccess,
    queries: Sequence[str],
    scope_collections: Sequence[UUID] | None,
    *,
    limit: int,
) -> list[Evidence]:
    """Passages the caller may read for the agent's knowledge tool.

    ``scope_collections`` narrows the search to those collections' subtrees;
    ``None`` searches every collection the caller can read. The retriever
    re-checks every hit in PostgreSQL.
    """
    if scope_collections is None:
        scope_collections = tuple(await access.allowed_collections("items.get"))
    return await retriever.search(
        queries,
        limit=limit,
        ctx=_Scope(
            tenant_id=str(access.workspace_id),
            user_id=str(access.user_id),
            collection_item_ids=tuple(str(value) for value in scope_collections),
        ),
    )


@dataclass(frozen=True, slots=True)
class _Scope:
    tenant_id: str
    user_id: str
    collection_item_ids: tuple[str, ...]


__all__ = ["FACET_FIELDS", "ItemSearchService", "retrieve_passages"]
