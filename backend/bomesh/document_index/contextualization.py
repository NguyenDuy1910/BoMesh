"""Build immutable retrieval chunks from canonical connector chunks."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Mapping, Sequence

from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    DocumentItem,
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
)
from bomesh.document_index import (
    ChunkContext,
    ChunkContextGenerator,
    ClassificationCache,
    ClassificationRequest,
    ContextualChunk,
    DocumentClassification,
    IndexProgress,
    ModelUsage,
)

log = logging.getLogger(__name__)

_DOCUMENT_CONTEXT_MAX_CHARACTERS = 12_000
_DOCUMENT_CONTEXT_METADATA_MAX_CHARACTERS = 3_000
_DOCUMENT_CONTEXT_CHUNK_MAX_CHARACTERS = 2_000
#: A window is the run of neighbouring chunks one contextualization prompt
#: shows in full; its prefix is written to the provider's cache once and read
#: by every batch of chunks asked for in it. Kept well under the provider's
#: 32k-token price tier.
_WINDOW_MAX_CHUNKS = 24
_WINDOW_MAX_CHARACTERS = 14_000
#: The leading excerpt that situates a window that does not start the document.
_OVERVIEW_LEADING_CHARACTERS = 3_000
#: Windows contextualized at the same time for one document (each runs its
#: batches after its first call warmed the cache).
_WINDOW_CONCURRENCY = 4
#: A document this short is its own context: title, section and summary say
#: what a model would.
_TINY_DOCUMENT_CHUNKS = 2
#: A document whose chunks are at least this share tables (a spreadsheet, a
#: roster, a schedule) gets no model context on its table chunks.
_TABULAR_DOCUMENT_SHARE = 0.8
#: Part of every reuse key: a change of the contextualization prompt or of how
#: windows are built must not reuse contexts written the old way.
CONTEXT_PROMPT_VERSION = "window-v1"


class ContextualChunkBuilder:
    """Assemble one retrieval chunk without changing canonical evidence."""

    def contextualize(
        self,
        chunk: Chunk,
        *,
        title: str | None,
        source: SourceIdentity,
        hierarchy: Hierarchy,
        access: AccessPolicy | EffectiveAccess,
        revision_number: int,
        structure_version: str,
        document_summary: str | None = None,
        semantic_context: str | None = None,
        semantic_key: str | None = None,
    ) -> ContextualChunk:
        semantic = semantic_context.strip() if semantic_context and semantic_context.strip() else None
        context = ChunkContext(
            section_path=list(chunk.section_path),
            summary=document_summary,
            semantic=semantic,
            semantic_key=semantic_key if semantic else None,
        )
        prefix = []
        if title:
            prefix.append(f"Document: {title}")
        if chunk.section_path:
            prefix.append(f"Section: {' > '.join(chunk.section_path)}")
        retrieval_context = semantic or document_summary
        if retrieval_context:
            prefix.append(f"Context: {retrieval_context}")
        contextual_text = "\n".join(prefix)
        contextual_text = (
            f"{contextual_text}\n\n{chunk.chunk_text}"
            if contextual_text
            else chunk.chunk_text
        )
        effective_access = (
            access.effective if isinstance(access, AccessPolicy) else access
        )
        return ContextualChunk(
            id=chunk.id,
            item_id=chunk.item_id,
            chunk_index=chunk.chunk_index,
            content_type=chunk.content_type,
            chunk_text=chunk.chunk_text,
            contextual_text=contextual_text,
            context=context,
            title=title,
            source=source,
            hierarchy=hierarchy,
            access=effective_access,
            refs=chunk.refs,
            quote=chunk.quote,
            location=chunk.location,
            highlights=chunk.highlights,
            revision_number=revision_number,
            structure_version=structure_version,
        )


async def build_contextual_chunks(
    chunks: Sequence[Chunk],
    item: DocumentItem,
    *,
    revision_number: int,
    structure_version: str,
    semantic_contextualizer: ChunkContextGenerator | None = None,
    classification: ClassificationRequest | None = None,
    progress: IndexProgress | None = None,
    known_contexts: Mapping[str, str] | None = None,
    classification_cache: ClassificationCache | None = None,
) -> tuple[list[ContextualChunk], DocumentClassification | None]:
    """Build retrieval text without modifying the chunks' block refs.

    ``revision_number`` and ``structure_version`` name the Structured Document
    the chunks were cut from; every retrieval chunk carries them.

    With a contextualizer and a ``classification`` that has candidates, the
    Document is first classified (the CLASSIFYING step); its summary stands in
    for a missing item summary in every chunk's structural context. Then the
    chunks are contextualized window by window (:func:`_windows`): one prompt
    prefix per window, batches of chunks per call. ``known_contexts`` maps a
    reuse key (:func:`_context_key`) to a context written before — the
    Document's previous index — so unchanged chunks cost no model call. Tiny
    and tabular content is not sent (:func:`_needs_context`). Returns the
    chunks and the classification, ``None`` when none was made or it failed.
    ``classification_cache`` holds the Document's earlier classification
    answers: an unchanged document, taxonomy and model cost no model call.
    """

    validated = _validate_chunks(chunks, item)
    chunk_builder = ContextualChunkBuilder()
    own_summary = _metadata_scalar(item.metadata, "summary")
    summary = own_summary
    classified = None
    if (
        semantic_contextualizer is not None
        and classification is not None
        and classification.candidates
    ):
        if progress is not None:
            progress("classifying", 0, 1)
        if classification.settled:
            # A matching rule settles the topics; the model is not asked.
            classified = DocumentClassification(topics=classification.settled)
        else:
            try:
                classified = await semantic_contextualizer.classify(
                    document_context=_document_context(item, validated, summary=summary),
                    request=classification,
                    title=item.title,
                    cache=classification_cache,
                )
            except Exception as exc:  # noqa: BLE001 - classification is best effort
                log.warning(
                    "document classification failed for item %s; "
                    "indexing it unclassified: %s",
                    item.id,
                    type(exc).__name__,
                )
        if progress is not None:
            progress("classifying", 1, 1)
        if summary is None and classified is not None:
            summary = classified.summary

    semantic: dict[int, tuple[str, str]] = {}
    if semantic_contextualizer is not None:
        semantic = await _contextualize(
            semantic_contextualizer,
            item,
            validated,
            # The model's summary changes from run to run: it would change every
            # reuse key, so windows are situated by the Document's own summary only.
            own_summary=own_summary,
            known=known_contexts or {},
            progress=progress,
        )
    contextual = []
    for chunk in validated:
        semantic_context, semantic_key = semantic.get(chunk.chunk_index, (None, None))
        contextual.append(
            chunk_builder.contextualize(
                chunk,
                title=item.title,
                source=item.source,
                hierarchy=item.hierarchy,
                access=item.access,
                revision_number=revision_number,
                structure_version=structure_version,
                document_summary=summary,
                semantic_context=semantic_context,
                semantic_key=semantic_key,
            )
        )
    return contextual, classified


async def _contextualize(
    generator: ChunkContextGenerator,
    item: DocumentItem,
    chunks: Sequence[Chunk],
    *,
    own_summary: str | None,
    known: Mapping[str, str],
    progress: IndexProgress | None,
) -> dict[int, tuple[str, str]]:
    """``chunk_index`` → (context, reuse key) for every chunk that got one."""

    needed = _needs_context(chunks)
    total = len(chunks)
    done = total - len(needed)
    if progress is not None:
        progress("contextualizing", done, total)
    result: dict[int, tuple[str, str]] = {}
    asked: list[tuple[str, list[Chunk], list[int], dict[int, str]]] = []
    reused = 0
    for window in _windows(chunks):
        overview = _overview(item, chunks, window, own_summary=own_summary)
        window_key = _window_key(generator.model_name, item.title, overview, window)
        keys = {
            chunk.chunk_index: _context_key(window_key, chunk)
            for chunk in window
            if chunk.chunk_index in needed
        }
        targets = []
        for index, key in keys.items():
            previous = known.get(key)
            if previous:
                result[index] = (previous, key)
                reused += 1
            else:
                targets.append(index)
        if targets:
            asked.append((overview, list(window), targets, keys))
    done += reused
    if progress is not None:
        progress("contextualizing", done, total)

    gate = asyncio.Semaphore(_WINDOW_CONCURRENCY)
    usage = ModelUsage()

    async def run(overview: str, window: list[Chunk], targets: list[int], keys: dict[int, str]) -> None:
        nonlocal done, usage
        async with gate:
            try:
                answer = await generator.describe_window(
                    title=item.title, overview=overview, window=window, targets=targets
                )
            except Exception as exc:  # noqa: BLE001 - enrichment is best effort
                log.warning(
                    "semantic context generation failed for a window of item %s; "
                    "using structural context: %s",
                    item.id,
                    type(exc).__name__,
                )
                answer = None
        if answer is not None:
            usage += answer.usage
            for index, context in answer.contexts.items():
                if index in keys:
                    result[index] = (context, keys[index])
        done += len(targets)
        if progress is not None:
            progress("contextualizing", done, total)

    await asyncio.gather(*(run(*window) for window in asked))
    log.info(
        "contextualization: item %s, %d chunks, %d needed context, %d reused, %d written,"
        " %d windows, %d calls, input %d tokens (%d cached), output %d tokens",
        item.id,
        total,
        len(needed),
        reused,
        len(result) - reused,
        len(asked),
        usage.calls,
        usage.input_tokens,
        usage.cached_tokens,
        usage.output_tokens,
    )
    return result


def _needs_context(chunks: Sequence[Chunk]) -> set[int]:
    """The chunks worth a model call (``chunk_index``).

    None in a tiny document (its title, section and summary already situate
    it); in a mostly tabular document (spreadsheets, rosters, schedules), none
    of its table chunks: each row block would cost a call for a context the
    sheet name, section and header already give.
    """

    if len(chunks) <= _TINY_DOCUMENT_CHUNKS:
        return set()
    tables = sum(1 for chunk in chunks if chunk.content_type == "table")
    tabular = tables >= _TABULAR_DOCUMENT_SHARE * len(chunks)
    return {
        chunk.chunk_index
        for chunk in chunks
        if not (tabular and chunk.content_type == "table")
    }


def _windows(chunks: Sequence[Chunk]) -> list[list[Chunk]]:
    """Consecutive chunks in document order, at most ``_WINDOW_MAX_CHUNKS`` and
    about ``_WINDOW_MAX_CHARACTERS`` each (a single larger chunk is its own window)."""

    windows: list[list[Chunk]] = []
    current: list[Chunk] = []
    size = 0
    for chunk in sorted(chunks, key=lambda value: value.chunk_index):
        length = min(len(chunk.chunk_text), _DOCUMENT_CONTEXT_CHUNK_MAX_CHARACTERS)
        if current and (len(current) >= _WINDOW_MAX_CHUNKS or size + length > _WINDOW_MAX_CHARACTERS):
            windows.append(current)
            current, size = [], 0
        current.append(chunk)
        size += length
    if current:
        windows.append(current)
    return windows


def _overview(
    item: DocumentItem,
    chunks: Sequence[Chunk],
    window: Sequence[Chunk],
    *,
    own_summary: str | None,
) -> str:
    """What situates one window: the Document's kind, own summary and sections,
    and — when the window does not start the document — its leading excerpt."""

    kind = (
        item.document_kind.value
        if hasattr(item.document_kind, "value")
        else str(item.document_kind)
    )
    lines = [f"Document kind: {kind}"]
    if own_summary:
        lines.append(f"Summary: {own_summary}")
    sections = list(
        dict.fromkeys(" > ".join(chunk.section_path) for chunk in chunks if chunk.section_path)
    )
    if sections:
        lines.append(f"Sections: {'; '.join(sections)}")
    metadata = _prompt_text_prefix("\n".join(lines), _DOCUMENT_CONTEXT_METADATA_MAX_CHARACTERS)
    first = min(chunk.chunk_index for chunk in chunks)
    if window[0].chunk_index == first:
        return metadata
    leading: list[str] = []
    remaining = _OVERVIEW_LEADING_CHARACTERS
    for chunk in sorted(chunks, key=lambda value: value.chunk_index):
        if remaining <= 0 or chunk.chunk_index >= window[0].chunk_index:
            break
        excerpt = _prompt_text_prefix(chunk.chunk_text, remaining)
        leading.append(excerpt)
        remaining -= _prompt_text_length(excerpt) + 1
    return f"{metadata}\nDocument opening:\n" + "\n".join(leading)


def _window_key(
    model: str | None, title: str | None, overview: str, window: Sequence[Chunk]
) -> str:
    """Everything a window's prompt is built from, hashed."""

    digest = hashlib.sha256()
    for part in (CONTEXT_PROMPT_VERSION, model or "", title or "", overview):
        digest.update(part.encode())
        digest.update(b"\x00")
    for chunk in window:
        digest.update(f"{chunk.chunk_index}\x00{' > '.join(chunk.section_path)}\x00".encode())
        digest.update(chunk.chunk_text.encode())
        digest.update(b"\x00")
    return digest.hexdigest()


def _context_key(window_key: str, chunk: Chunk) -> str:
    """The reuse key of one chunk's context: its window's key and its own index."""

    return hashlib.sha256(f"{window_key}:{chunk.chunk_index}".encode()).hexdigest()


def _document_context(
    item: DocumentItem,
    chunks: Sequence[Chunk],
    *,
    summary: str | None,
) -> str:
    """Bounded metadata and the leading canonical chunks: what CLASSIFYING reads."""

    metadata = [f"Document: {item.title or item.id}"]
    kind = (
        item.document_kind.value
        if hasattr(item.document_kind, "value")
        else str(item.document_kind)
    )
    metadata.append(f"Document kind: {kind}")
    if summary:
        metadata.append(f"Summary: {summary}")
    sections = list(
        dict.fromkeys(
            " > ".join(chunk.section_path) for chunk in chunks if chunk.section_path
        )
    )
    if sections:
        metadata.append(f"Sections: {'; '.join(sections)}")
    metadata_text = _prompt_text_prefix(
        "\n".join(metadata),
        _DOCUMENT_CONTEXT_METADATA_MAX_CHARACTERS,
    )
    lines = [metadata_text, "Leading canonical chunk excerpts:"]
    remaining = _DOCUMENT_CONTEXT_MAX_CHARACTERS - sum(
        _prompt_text_length(line) + 1 for line in lines
    )
    for chunk in sorted(chunks, key=lambda chunk: chunk.chunk_index):
        if remaining <= 0:
            break
        section = " > ".join(chunk.section_path)
        label = f"[{chunk.chunk_index}{f' | {section}' if section else ''}] "
        excerpt = label + chunk.chunk_text[:_DOCUMENT_CONTEXT_CHUNK_MAX_CHARACTERS]
        bounded = _prompt_text_prefix(excerpt, remaining)
        lines.append(bounded)
        remaining -= _prompt_text_length(bounded) + 1
    return "\n".join(lines)


def sample_document_context(title: str, text: str) -> str:
    """The bounded document context of a sample (TestTopicClassification): the
    same shape and budget CLASSIFYING reads for a processed document."""

    lines = [
        _prompt_text_prefix(f"Document: {title}", _DOCUMENT_CONTEXT_METADATA_MAX_CHARACTERS),
        "Leading canonical chunk excerpts:",
    ]
    remaining = _DOCUMENT_CONTEXT_MAX_CHARACTERS - sum(
        _prompt_text_length(line) + 1 for line in lines
    )
    if text.strip():
        lines.append(_prompt_text_prefix(text.strip(), remaining))
    return "\n".join(lines)


def _prompt_text_length(value: str) -> int:
    """Measure text after the prompt renderer escapes XML tag delimiters."""

    return sum(5 if char == "&" else 4 if char in "<>" else 1 for char in value)


def _prompt_text_prefix(value: str, budget: int) -> str:
    if budget <= 0:
        return ""
    consumed = 0
    for end, char in enumerate(value, start=1):
        consumed += 5 if char == "&" else 4 if char in "<>" else 1
        if consumed > budget:
            return value[: end - 1]
    return value


def _validate_chunks(chunks: Sequence[Chunk], item: DocumentItem) -> tuple[Chunk, ...]:
    if not isinstance(item, DocumentItem):
        raise TypeError("item must be a DocumentItem")
    resolved = tuple(chunks)
    if not resolved:
        raise ValueError(f"Document item {item.id!r} has no connector chunks")

    seen_ids: set[str] = set()
    seen_indexes: set[int] = set()
    for chunk in resolved:
        if not isinstance(chunk, Chunk):
            raise TypeError("chunks must contain only connector Chunk values")
        if chunk.item_id != item.id:
            raise ValueError(
                f"Chunk {chunk.id!r} belongs to item {chunk.item_id!r}, not {item.id!r}"
            )
        if chunk.id in seen_ids:
            raise ValueError(f"Duplicate chunk id {chunk.id!r} for item {item.id!r}")
        if chunk.chunk_index in seen_indexes:
            raise ValueError(
                f"Duplicate chunk index {chunk.chunk_index} for item {item.id!r}"
            )
        seen_ids.add(chunk.id)
        seen_indexes.add(chunk.chunk_index)
    return resolved


def _metadata_scalar(metadata: dict[str, str | list[str]], key: str) -> str | None:
    value = metadata.get(key)
    if isinstance(value, list):
        return value[0].strip() if value and value[0].strip() else None
    return value.strip() if isinstance(value, str) and value.strip() else None


__all__ = [
    "ContextualChunkBuilder",
    "build_contextual_chunks",
    "sample_document_context",
]
