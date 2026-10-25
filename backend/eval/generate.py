"""Draw a benchmark dataset from the already-indexed workspace corpus.

Every answerable question keeps a verbatim quote that was verified to occur in
the indexed passage it was written from. Unanswerable candidates are kept only
when the relevance judge finds no retrieved passage that answers them.
"""

from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from random import Random
from typing import Any

from bomesh.db.engine import SessionFactory
from bomesh.document_index import ContextualChunk, ItemIndex
from eval.corpus import CorpusDocument, document_chunks, indexed_documents
from eval.dataset import (
    BenchmarkQuestion,
    Dataset,
    DatasetManifest,
    GoldEvidence,
)
from eval.judge import RelevanceJudge
from eval.llm import JsonModel, render
from eval.matching import normalize, tokens

#: Prose passages rotate through these; spreadsheet passages are "table".
_PROSE_TYPES = ("factual", "exact_code", "paraphrase")
_TABLE_MIME_MARKERS = ("spreadsheet", "csv", "excel")
_MIN_QUOTE_TOKENS = 8
_MIN_TABLE_QUOTE_TOKENS = 3
_MIN_PASSAGE_CHARACTERS = 200
_UNANSWERABLE_PROBE_DEPTH = 10


@dataclass(frozen=True, slots=True)
class GenerationPlan:
    single_hop: int
    multi_hop: int
    unanswerable: int
    language: str
    second_language: str | None
    second_language_every: int
    seed: int
    concurrency: int


@dataclass(frozen=True, slots=True)
class _Source:
    document: CorpusDocument
    chunk: ContextualChunk


@dataclass(slots=True)
class GenerationReport:
    requested: dict[str, int]
    produced: dict[str, int]
    rejected: dict[str, int]


async def generate_dataset(
    *,
    name: str,
    tenant_id: str,
    collection_item_ids: tuple[str, ...],
    plan: GenerationPlan,
    sessions: SessionFactory,
    index: ItemIndex,
    model: JsonModel,
    relevance: RelevanceJudge,
) -> tuple[Dataset, GenerationReport]:
    documents = await indexed_documents(
        sessions, tenant_id=tenant_id, collection_item_ids=collection_item_ids
    )
    if not documents:
        raise ValueError("no indexed documents in the selected Collections")
    rng = Random(plan.seed)
    ordered = _stratified(documents, rng)
    limiter = asyncio.Semaphore(plan.concurrency)
    report = GenerationReport(
        requested={
            "single_hop": plan.single_hop,
            "multi_hop": plan.multi_hop,
            "unanswerable": plan.unanswerable,
        },
        produced={},
        rejected=defaultdict(int),
    )

    single_attempts = math.ceil(plan.single_hop * 1.25)
    multi_attempts = math.ceil(plan.multi_hop * 1.5)
    needed = single_attempts + 2 * multi_attempts
    picked = [ordered[index % len(ordered)] for index in range(needed)]
    unique = list(dict.fromkeys(picked))
    chunk_lists = await _bounded(
        limiter,
        [
            lambda document=document: document_chunks(index, document, tenant_id=tenant_id)
            for document in unique
        ],
    )
    chunks_by_item: dict[str, list[ContextualChunk]] = {}
    for document, chunks in zip(unique, chunk_lists, strict=True):
        if isinstance(chunks, Exception):
            report.rejected["source:chunk_read_error"] += 1
            chunks = []
        chunks_by_item[document.item_id] = chunks
    sources = [
        _Source(document, chunk)
        for document in picked
        if (chunk := _pick_chunk(chunks_by_item[document.item_id], rng)) is not None
    ]

    single_sources = sources[:single_attempts]
    single_drafts = await _bounded(
        limiter,
        [
            lambda source=source, position=position, question_type=question_type: _single_hop(
                model, source, _language(plan, position), question_type
            )
            for position, (source, question_type) in enumerate(
                zip(single_sources, _question_types(single_sources), strict=True)
            )
        ],
    )
    pair_sources = sources[single_attempts:]
    pairs = [
        (pair_sources[i], pair_sources[i + 1])
        for i in range(0, len(pair_sources) - 1, 2)
        if pair_sources[i].document.item_id != pair_sources[i + 1].document.item_id
    ]
    multi_drafts = await _bounded(
        limiter,
        [lambda pair=pair: _multi_hop(model, pair, plan.language) for pair in pairs],
    )

    questions: list[BenchmarkQuestion] = []
    seen: set[str] = set()

    def accept(
        drafts: Sequence[list[dict[str, Any]] | Exception], limit: int, kind: str
    ) -> None:
        produced = 0
        for draft in drafts:
            if isinstance(draft, Exception):
                report.rejected[f"{kind}:model_error"] += 1
                continue
            for candidate in draft:
                if produced >= limit:
                    break
                key = normalize(candidate["question"])
                if key in seen:
                    report.rejected[f"{kind}:duplicate"] += 1
                    continue
                seen.add(key)
                questions.append(_question(len(questions) + 1, candidate))
                produced += 1
        report.produced[kind] = produced

    accept(
        [
            draft if isinstance(draft, Exception) else _validated_single(draft, source, report)
            for draft, source in zip(single_drafts, single_sources, strict=True)
        ],
        plan.single_hop,
        "single_hop",
    )
    accept(
        [
            draft if isinstance(draft, Exception) else _validated_multi(draft, pair, report)
            for draft, pair in zip(multi_drafts, pairs, strict=True)
        ],
        plan.multi_hop,
        "multi_hop",
    )
    if plan.unanswerable:
        unanswerable = await _unanswerable(
            model=model,
            relevance=relevance,
            index=index,
            documents=documents,
            plan=plan,
            rng=rng,
            tenant_id=tenant_id,
            collection_item_ids=collection_item_ids,
            limiter=limiter,
            report=report,
        )
        accept([unanswerable], plan.unanswerable, "unanswerable")

    manifest = DatasetManifest(
        name=name,
        tenant_id=tenant_id,
        collection_item_ids=collection_item_ids,
        created_at=datetime.now(UTC).isoformat(timespec="seconds"),
        generator_model=model.model_name,
        processing_signature=index.current_processing_signature(),
        seed=plan.seed,
    )
    report.rejected = dict(report.rejected)
    return Dataset(manifest, tuple(questions)), report


async def _single_hop(
    model: JsonModel, source: _Source, language: str, question_type: str
) -> list[dict[str, Any]]:
    answer = await model.ask(
        render(
            "generate_questions",
            count="1",
            language=language,
            question_type=question_type,
            title=source.document.title,
            passage=source.chunk.chunk_text,
        )
    )
    return [
        {**entry, "language": language, "type": question_type}
        for entry in answer.get("questions", [])
        if isinstance(entry, dict)
    ]


async def _multi_hop(
    model: JsonModel, pair: tuple[_Source, _Source], language: str
) -> list[dict[str, Any]]:
    first, second = pair
    answer = await model.ask(
        render(
            "generate_multi_hop",
            language=language,
            title_a=first.document.title,
            passage_a=first.chunk.chunk_text,
            title_b=second.document.title,
            passage_b=second.chunk.chunk_text,
        )
    )
    return [
        {**entry, "language": language}
        for entry in answer.get("questions", [])
        if isinstance(entry, dict)
    ]


def _validated_single(
    drafts: list[dict[str, Any]], source: _Source, report: GenerationReport
) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    for draft in drafts:
        question_type = draft["type"]
        quote = _verified_quote(
            draft.get("quote"),
            source.chunk.chunk_text,
            min_tokens=(
                _MIN_TABLE_QUOTE_TOKENS if question_type == "table" else _MIN_QUOTE_TOKENS
            ),
        )
        if not _text(draft.get("question")) or quote is None:
            report.rejected["single_hop:quote_not_in_passage"] += 1
            continue
        accepted.append(
            {
                "question": _text(draft["question"]),
                "type": question_type,
                "language": draft["language"],
                "reference_answer": _text(draft.get("answer")) or None,
                "gold": [_gold(source, quote)],
            }
        )
    return accepted


def _validated_multi(
    drafts: list[dict[str, Any]],
    pair: tuple[_Source, _Source],
    report: GenerationReport,
) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    for draft in drafts:
        quotes = draft.get("quotes")
        if not isinstance(quotes, list) or len(quotes) != 2:
            report.rejected["multi_hop:malformed"] += 1
            continue
        verified = [
            _verified_quote(quote, source.chunk.chunk_text, min_tokens=_MIN_TABLE_QUOTE_TOKENS)
            for quote, source in zip(quotes, pair, strict=True)
        ]
        if not _text(draft.get("question")) or None in verified:
            report.rejected["multi_hop:quote_not_in_passage"] += 1
            continue
        accepted.append(
            {
                "question": _text(draft["question"]),
                "type": "multi_hop",
                "language": draft["language"],
                "reference_answer": _text(draft.get("answer")) or None,
                "gold": [
                    _gold(source, quote)
                    for source, quote in zip(pair, verified, strict=True)
                    if quote is not None
                ],
            }
        )
    return accepted


async def _unanswerable(
    *,
    model: JsonModel,
    relevance: RelevanceJudge,
    index: ItemIndex,
    documents: list[CorpusDocument],
    plan: GenerationPlan,
    rng: Random,
    tenant_id: str,
    collection_item_ids: tuple[str, ...],
    limiter: asyncio.Semaphore,
    report: GenerationReport,
) -> list[dict[str, Any]]:
    titles = [document.title for document in rng.sample(documents, min(40, len(documents)))]
    try:
        answer = await model.ask(
            render(
                "generate_unanswerable",
                count=str(plan.unanswerable * 2),
                language=plan.language,
                titles="\n".join(f"- {title}" for title in titles),
            )
        )
    except ValueError:
        report.rejected["unanswerable:model_error"] += 1
        return []
    candidates = [
        _text(entry.get("question"))
        for entry in answer.get("questions", [])
        if isinstance(entry, dict) and _text(entry.get("question"))
    ]

    async def answered(question: str) -> bool:
        chunks = await index.search_item_content(
            (question,),
            limit=_UNANSWERABLE_PROBE_DEPTH,
            tenant_id=tenant_id,
            collection_item_ids=collection_item_ids,
        )
        grades = await relevance.grade(question, [chunk.chunk_text for chunk in chunks])
        return any(grade == 2 for grade in grades)

    verdicts = await _bounded(limiter, [lambda q=q: answered(q) for q in candidates])
    kept: list[dict[str, Any]] = []
    for question, verdict in zip(candidates, verdicts, strict=True):
        if isinstance(verdict, Exception):
            report.rejected["unanswerable:verification_error"] += 1
        elif verdict:
            report.rejected["unanswerable:answered_by_corpus"] += 1
        else:
            kept.append(
                {
                    "question": question,
                    "type": "unanswerable",
                    "language": plan.language,
                    "reference_answer": None,
                    "gold": [],
                }
            )
    return kept


def _question(number: int, payload: dict[str, Any]) -> BenchmarkQuestion:
    return BenchmarkQuestion(
        id=f"q{number:04d}",
        question=payload["question"],
        type=payload["type"],
        language=payload["language"],
        gold=tuple(payload["gold"]),
        reference_answer=payload["reference_answer"],
    )


def _gold(source: _Source, quote: str) -> GoldEvidence:
    return GoldEvidence(
        item_id=source.document.item_id, title=source.document.title, quote=quote
    )


def _verified_quote(value: object, passage: str, *, min_tokens: int) -> str | None:
    quote = _text(value)
    if len(tokens(quote)) < min_tokens:
        return None
    return quote if normalize(quote) in normalize(passage) else None


def _text(value: object) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _question_types(sources: Sequence[_Source]) -> list[str]:
    types: list[str] = []
    prose = 0
    for source in sources:
        mime = (source.document.mime_type or "").lower()
        if any(marker in mime for marker in _TABLE_MIME_MARKERS):
            types.append("table")
        else:
            types.append(_PROSE_TYPES[prose % len(_PROSE_TYPES)])
            prose += 1
    return types


def _language(plan: GenerationPlan, position: int) -> str:
    every = plan.second_language_every
    if plan.second_language and every > 0 and position % every == every - 1:
        return plan.second_language
    return plan.language


def _pick_chunk(chunks: list[ContextualChunk], rng: Random) -> ContextualChunk | None:
    if not chunks:
        return None
    substantial = [c for c in chunks if len(c.chunk_text) >= _MIN_PASSAGE_CHARACTERS]
    if substantial:
        return rng.choice(substantial)
    return max(chunks, key=lambda chunk: len(chunk.chunk_text))


def _stratified(documents: list[CorpusDocument], rng: Random) -> list[CorpusDocument]:
    """Round-robin over MIME types so every format is represented early."""

    groups: dict[str, list[CorpusDocument]] = defaultdict(list)
    for document in documents:
        groups[document.mime_type or "unknown"].append(document)
    for group in groups.values():
        rng.shuffle(group)
    ordered: list[CorpusDocument] = []
    queues = [groups[key] for key in sorted(groups)]
    while any(queues):
        for queue in queues:
            if queue:
                ordered.append(queue.pop())
    return ordered


async def _bounded[T](
    limiter: asyncio.Semaphore, factories: Sequence[Callable[[], Awaitable[T]]]
) -> list[T | Exception]:
    async def run(factory: Callable[[], Awaitable[T]]) -> T | Exception:
        async with limiter:
            try:
                return await factory()
            except Exception as exc:  # noqa: BLE001 - one bad draft must not end generation
                return exc

    return list(await asyncio.gather(*(run(factory) for factory in factories)))


__all__ = ["GenerationPlan", "GenerationReport", "generate_dataset"]
