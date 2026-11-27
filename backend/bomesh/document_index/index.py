"""The single public capability for indexing, searching, and removing Item content."""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from bomesh.connector.protocol import Chunk, DocumentItem
from bomesh.document_index import (
    DEFAULT_HYBRID_CANDIDATE_LIMIT,
    INDEX_SCHEMA_VERSION,
    ChunkContextGenerator,
    ClassificationCache,
    ClassificationRequest,
    ContextualChunk,
    DocumentClassification,
    EmbeddingService,
    IndexingContext,
    IndexProgress,
    ItemPayloadState,
    sample_document_context,
)
from bomesh.document_index.contextualization import classify_chunks
from bomesh.document_index._qdrant import _QdrantBackend
from bomesh.document_index.payload import (
    _contextual_chunk_from_point,
    build_index_records,
)
from bomesh.request_timing import stage

log = logging.getLogger(__name__)

#: Tenant and collection of the warm-up search: no point carries them.
_WARM_UP_SCOPE = "warm-up"


class ItemIndex:
    """Index, search, and remove Item content in the derived vector index."""

    def __init__(
        self,
        *,
        backend: _QdrantBackend | None = None,
        collection_name: str | None = None,
        url: str | None = None,
        api_key: str | None = None,
        prefer_grpc: bool | None = None,
        timeout: float | None = 60,
        embedder: EmbeddingService | None = None,
        semantic_contextualizer: ChunkContextGenerator | None = None,
        embedding_batch_size: int = 32,
        candidate_limit: int = DEFAULT_HYBRID_CANDIDATE_LIMIT,
        query_embedding_cache_size: int = 512,
        search_deadline_seconds: float | None = None,
    ) -> None:
        if embedding_batch_size < 1:
            raise ValueError("embedding_batch_size must be at least one")
        if candidate_limit < 1:
            raise ValueError("candidate_limit must be at least one")
        if query_embedding_cache_size < 0:
            raise ValueError("query_embedding_cache_size must not be negative")
        if search_deadline_seconds is not None and search_deadline_seconds <= 0:
            raise ValueError("search_deadline_seconds must be greater than zero")
        self._backend = backend or _QdrantBackend(
            collection_name=collection_name,
            url=url,
            api_key=api_key,
            prefer_grpc=prefer_grpc,
            timeout=timeout,
        )
        self._embedder = embedder
        self._semantic_contextualizer = semantic_contextualizer
        self._embedding_batch_size = embedding_batch_size
        self._candidate_limit = candidate_limit
        #: One deadline for a search's query embeddings and vector query together.
        self._search_deadline_seconds = search_deadline_seconds
        # Query-time vectors only, keyed by embedding model and normalized text:
        # a follow-up or retried search skips the embedding round trip.
        # Ingestion never reads or fills it.
        self._query_embedding_cache_size = query_embedding_cache_size
        self._query_embeddings: OrderedDict[tuple[str, str], list[float]] = (
            OrderedDict()
        )

    async def index_item_content(
        self,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        context: IndexingContext,
        classification: ClassificationRequest | None = None,
        classification_cache: ClassificationCache | None = None,
        progress: IndexProgress | None = None,
    ) -> tuple[int, DocumentClassification | None]:
        """Classify, contextualize, embed, and replace all indexed content for one Item.

        Work already done for unchanged content is reused from the Item's
        current points: a chunk whose context key is unchanged keeps its
        context (no model call), and a point whose contextual text and embedding
        model are unchanged keeps its vector (no embedding call). Returns the
        chunk count and the classification (``None`` when none was asked for, no
        contextualizer is configured, or it failed). ``classification_cache``
        holds the Item's content's earlier classification answers.
        """

        embedder = self._require_embedder()
        known_contexts, known_vectors = await self._previous_work(
            item.id, tenant_id=context.tenant_id, embedding_model=embedder.embedding_model
        )
        records, classified = await build_index_records(
            chunks,
            item,
            context,
            semantic_contextualizer=self._semantic_contextualizer,
            classification=classification,
            classification_cache=classification_cache,
            progress=progress,
            known_contexts=known_contexts,
            embedding_model=embedder.embedding_model,
        )
        texts = [record.payload.contextual_text for record in records]
        vectors: list[list[float] | None] = [known_vectors.get(text) for text in texts]
        missing = [position for position, vector in enumerate(vectors) if vector is None]
        for start in range(0, len(missing), self._embedding_batch_size):
            if progress is not None:
                progress("embedding", len(texts) - len(missing) + start, len(texts))
            batch = missing[start : start + self._embedding_batch_size]
            for position, vector in zip(
                batch,
                await embedder.embed_documents([texts[position] for position in batch]),
                strict=True,
            ):
                vectors[position] = vector
        if any(not vector for vector in vectors):
            raise ValueError("every contextual chunk requires one embedding")
        if len(texts) > len(missing):
            log.info(
                "indexing: item %s reused %d of %d embeddings",
                item.id,
                len(texts) - len(missing),
                len(texts),
            )

        if progress is not None:
            progress("storing", 0, len(records))
        await self._backend.replace_item_points(
            item_id=item.id,
            tenant_id=context.tenant_id,
            records=records,
            vectors=[vector for vector in vectors if vector],
        )
        if progress is not None:
            progress("storing", len(records), len(records))
        return len(records), classified

    async def _previous_work(
        self, item_id: str, *, tenant_id: str, embedding_model: str
    ) -> tuple[dict[str, str], dict[str, list[float]]]:
        """Contexts by reuse key, and vectors by contextual text (same embedding
        model only), of the Item's current points. Reuse is an optimization: a
        failure to read them only means paying for the work again."""

        try:
            points = await self._backend.previous_item_points(item_id=item_id, tenant_id=tenant_id)
        except Exception as exc:  # noqa: BLE001 - reuse is best effort
            log.warning("previous index points of item %s unavailable: %s", item_id, type(exc).__name__)
            return {}, {}
        contexts: dict[str, str] = {}
        vectors: dict[str, list[float]] = {}
        for payload, vector in points:
            key, semantic = payload.get("context_key"), payload.get("semantic_context")
            if isinstance(key, str) and key and isinstance(semantic, str) and semantic.strip():
                contexts[key] = semantic
            text = payload.get("contextual_text")
            if vector and isinstance(text, str) and payload.get("embedding_model") == embedding_model:
                vectors[text] = vector
        return contexts, vectors

    async def search_item_content(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        tenant_id: str,
        collection_item_ids: tuple[str, ...],
        editable_collection_ids: tuple[str, ...],
        document_item_ids: tuple[str, ...] = (),
        within_item_ids: tuple[str, ...] | None = None,
    ) -> list[ContextualChunk]:
        """Return the fused candidates of every query, within the access scope.

        A point matches when its collection is in ``collection_item_ids`` and
        it is published or its collection is in ``editable_collection_ids``, or
        when its item is in ``document_item_ids``. ``within_item_ids`` narrows
        that scope to those items (``None`` = no narrowing, empty = nothing): the
        recall pass over the documents a query's concepts match. Embedding and
        the vector query share the search deadline: past it, :class:`TimeoutError`.
        """

        normalized_queries = [" ".join(query.split()) for query in queries]
        if not normalized_queries or not all(normalized_queries):
            raise ValueError("queries must be non-empty")
        if limit < 1:
            raise ValueError("limit must be at least one")
        normalized_tenant_id = tenant_id.strip() if isinstance(tenant_id, str) else ""
        if not normalized_tenant_id:
            raise ValueError("tenant_id must not be empty")
        if not collection_item_ids and not document_item_ids:
            return []
        if within_item_ids is not None and not within_item_ids:
            return []

        async with asyncio.timeout(self._search_deadline_seconds):
            with stage("embedding"):
                vectors = await asyncio.gather(
                    *(self._embed_query(query) for query in normalized_queries)
                )
            with stage("index"):
                points = await self._backend.search_item_points(
                    queries=list(zip(normalized_queries, vectors, strict=True)),
                    tenant_id=normalized_tenant_id,
                    collection_item_ids=collection_item_ids,
                    editable_collection_ids=editable_collection_ids,
                    document_item_ids=document_item_ids,
                    within_item_ids=within_item_ids,
                    limit=limit,
                    candidate_limit=max(limit, self._candidate_limit),
                )
        return _normalise_points(points)

    async def warm_up(self) -> None:
        """Open the embedding provider's and the index's connections before the first search.

        Runs the search path once for a scope that matches nothing; the first
        real query then pays neither connection setup nor client initialization.
        """

        await self.search_item_content(
            ["warm up"],
            limit=1,
            tenant_id=_WARM_UP_SCOPE,
            collection_item_ids=(_WARM_UP_SCOPE,),
            editable_collection_ids=(),
        )

    async def get_item_content(
        self,
        item_id: str,
        *,
        tenant_id: str,
        chunk_id: str | None = None,
        limit: int = 100,
    ) -> list[ContextualChunk]:
        """The live chunks of one Item the caller was authorized for, in source order."""

        if limit < 1:
            raise ValueError("limit must be at least one")
        points = await self._backend.get_item_points(
            item_id=_required_text(item_id, "item_id"),
            tenant_id=_required_text(tenant_id, "tenant_id"),
            chunk_id=chunk_id,
            limit=limit,
        )
        return sorted(_normalise_points(points), key=lambda chunk: chunk.chunk_index)

    async def get_item_chunks(self, *, tenant_id: str, chunks: Mapping[str, Collection[int]]) -> list[ContextualChunk]:
        """The live chunks at the given ``chunk_index`` values of Items the caller was
        authorized for, in one index read; per Item in source order."""

        points = await self._backend.get_chunk_points(
            tenant_id=_required_text(tenant_id, "tenant_id"),
            chunks={item_id: sorted(set(indexes)) for item_id, indexes in chunks.items()},
        )
        return sorted(_normalise_points(points), key=lambda chunk: (chunk.item_id, chunk.chunk_index))

    async def remove_item_content(
        self,
        item_id: str,
        *,
        tenant_id: str,
    ) -> None:
        """Tombstone all indexed content for one Item."""

        await self._backend.tombstone_item_points(
            _required_text(item_id, "item_id"),
            tenant_id=_required_text(tenant_id, "tenant_id"),
        )

    async def apply_item_payload(
        self, item_id: str, *, tenant_id: str, state: ItemPayloadState
    ) -> None:
        """Re-apply the access fields of one Document's points (no re-embedding)."""

        await self._backend.set_item_payload(
            _required_text(item_id, "item_id"),
            tenant_id=_required_text(tenant_id, "tenant_id"),
            payload=state.to_payload(),
        )

    async def count_item_content(self, item_id: str, *, tenant_id: str) -> int:
        """How many points one Item has, tombstoned ones included."""

        return await self._backend.count_item_points(
            _required_text(item_id, "item_id"),
            tenant_id=_required_text(tenant_id, "tenant_id"),
        )

    async def purge_item_content(self, item_id: str, *, tenant_id: str) -> None:
        """Delete one Item's points for good."""

        await self._backend.delete_item_points(
            _required_text(item_id, "item_id"),
            tenant_id=_required_text(tenant_id, "tenant_id"),
        )

    async def aclose(self) -> None:
        for dependency in (self._embedder, self._backend):
            if dependency is None:
                continue
            close = getattr(dependency, "aclose", None)
            if close is not None:
                await close()

    async def classify_sample(
        self, *, title: str, text: str, request: ClassificationRequest
    ) -> DocumentClassification | None:
        """CLASSIFYING of a sample document, exactly as processing does it: an
        empty answer when the request asks the model nothing, else one call to
        the contextualization model. ``None`` when the model is needed but
        contextualization is not configured."""

        if not request.needs_model:
            return DocumentClassification()
        if self._semantic_contextualizer is None:
            return None
        return await self._semantic_contextualizer.classify(
            document_context=sample_document_context(title, text),
            request=request,
            title=title,
        )

    async def classify_document(
        self,
        item: DocumentItem,
        chunks: Sequence[Chunk],
        *,
        classification: ClassificationRequest,
        cache: ClassificationCache | None = None,
        progress: IndexProgress | None = None,
    ) -> DocumentClassification | None:
        """Step 0 of indexing alone (classifyOnly runs): no contextualizing,
        embedding or storing. ``None`` when the model is needed but not
        configured, or the call failed."""

        return await classify_chunks(
            chunks,
            item,
            semantic_contextualizer=self._semantic_contextualizer,
            classification=classification,
            classification_cache=cache,
            progress=progress,
        )

    @property
    def embedder(self) -> EmbeddingService | None:
        """The index's embedding service; ``None`` when not configured."""

        return self._embedder

    async def nearest_items(
        self,
        probe: str,
        vector: list[float],
        *,
        tenant_id: str,
        document_item_ids: tuple[str, ...],
        limit: int,
    ) -> list[ContextualChunk]:
        """The chunks of ``document_item_ids`` nearest to ``probe`` (its text, for
        BM25) and ``vector`` (its dense embedding), fused; ``[]`` without ids."""

        if not document_item_ids:
            return []
        if limit < 1:
            raise ValueError("limit must be at least one")
        normalized_probe = " ".join(probe.split())
        if not normalized_probe:
            raise ValueError("probe must not be empty")
        points = await self._backend.search_item_points(
            queries=[(normalized_probe, vector)],
            tenant_id=_required_text(tenant_id, "tenant_id"),
            collection_item_ids=(),
            editable_collection_ids=(),
            document_item_ids=document_item_ids,
            limit=limit,
            candidate_limit=max(limit, self._candidate_limit),
        )
        return _normalise_points(points)

    def current_processing_signature(self) -> dict[str, Any]:
        """Report this index's own embedding/contextualization/schema versions.

        Callers use this to decide whether previously indexed content is still
        current, without document_index owning that decision itself.
        """

        return {
            "embedding_model": self._require_embedder().embedding_model,
            "index_schema_version": INDEX_SCHEMA_VERSION,
            "contextualization_enabled": self._semantic_contextualizer is not None,
            "contextualization_model": (
                self._semantic_contextualizer.model_name
                if self._semantic_contextualizer is not None
                else None
            ),
        }

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed short texts with the index's embedding model (one batched call)."""

        return await self._require_embedder().embed_documents(texts)

    def _require_embedder(self) -> EmbeddingService:
        if self._embedder is None:
            raise RuntimeError("Item content embedding is not configured")
        return self._embedder

    async def _embed_query(self, query: str) -> list[float]:
        """Embed one normalized search query through the bounded LRU cache."""

        embedder = self._require_embedder()
        if self._query_embedding_cache_size == 0:
            return await embedder.embed_query(query)
        key = (embedder.embedding_model, query)
        cached = self._query_embeddings.get(key)
        if cached is not None:
            self._query_embeddings.move_to_end(key)
            return cached
        vector = await embedder.embed_query(query)
        self._query_embeddings[key] = vector
        if len(self._query_embeddings) > self._query_embedding_cache_size:
            self._query_embeddings.popitem(last=False)
        return vector


def _normalise_points(points: Sequence[object]) -> list[ContextualChunk]:
    chunks: list[ContextualChunk] = []
    seen_ids: set[str] = set()
    for point in points:
        chunk = _contextual_chunk_from_point(point)
        if chunk is None or chunk.id in seen_ids:
            continue
        seen_ids.add(chunk.id)
        chunks.append(chunk)
    return chunks


def _required_text(value: str, field: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise ValueError(f"{field} must not be empty")
    return normalized


__all__ = ["ItemIndex"]
