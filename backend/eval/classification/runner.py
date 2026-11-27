"""Run the facet classifier on a labeled suite, as processing runs it, and report.

Per sample: the file (or text, parsed as Markdown) is parsed and chunked like an
upload, then ``document_input`` → ``prepare`` (rules, patterns, metadata, lexical,
card and kNN candidates) → the configured contextualization model's ``classify``
when a scheme is unsettled → ``decide``. Nothing is written to the database or the
index; the workspace's published taxonomy and rules are only read.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import select

from bomesh.agent.transports.openrouter import OpenRouterTransport
from bomesh.connector.file.processing import FileProcessor
from bomesh.connector.processing import DoclingChunker
from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Tenant
from bomesh.document_index import DocumentClassification, SemanticContextualizer
from bomesh.iam.authorizer import item_ancestry
from bomesh.runtime import AppRuntime
from bomesh.services.taxonomy.classification import (
    ClassificationOutcome,
    ClassificationPlan,
    Signals,
    decide,
    document_input,
    load_plan,
    prepare,
)
from bomesh.services.taxonomy.snapshot import TaxonomySnapshot
from config import AppConfig
from eval.classification.labels import LABELS_FILE, LabeledSample, load_labels, suite_directory
from eval.classification.metrics import PredictedLabel, SampleOutcome, render_markdown, summarize
from eval.llm import JsonCache
from eval.report import write_report

log = logging.getLogger(__name__)

EVAL_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = EVAL_ROOT / "runs" / "classification"
ANSWER_CACHE = EVAL_ROOT / "cache" / "classification_answers.jsonl"
#: Formats chunked line by line, as processing chunks them.
_LINE_EXTENSIONS = frozenset({".jsonl", ".log", ".sql", ".tsv"})
#: Calibration keeps every label the model chose: no scored label falls below review.
_CALIBRATION_REVIEW_THRESHOLD = 0.01


class AnswerCache:
    """``ClassificationCache`` over the benchmark's on-disk cache: a rerun of the
    same suite, taxonomy and model reads the answers already paid for."""

    def __init__(self, cache: JsonCache) -> None:
        self._cache = cache

    async def get(self, key: str) -> str | None:
        entry = self._cache.get(key)
        return None if entry is None else str(entry["answer"])

    async def put(self, key: str, answer: str) -> None:
        await self._cache.put(key, {"answer": answer})


@dataclass(frozen=True, slots=True)
class ClassificationRun:
    directory: Path
    summary: dict[str, Any]
    markdown: list[str]


async def run_classification(
    config: AppConfig,
    *,
    suite: str,
    workspace: str,
    concurrency: int = 4,
    limit: int | None = None,
) -> ClassificationRun:
    """Classify every sample of ``suite`` against ``workspace``'s published taxonomy."""

    labels_path = suite_directory(suite) / LABELS_FILE
    if not labels_path.is_file():
        raise SystemExit(f"no classification suite {suite}: create {labels_path}")
    samples = load_labels(labels_path)[:limit] if limit else load_labels(labels_path)
    started = datetime.now()
    runtime = AppRuntime(config)
    transport: OpenRouterTransport | None = None
    try:
        sessions = runtime.sessions()
        index = runtime.item_index()
        async with transaction_scope(sessions) as session:
            tenant_id = (
                await session.execute(select(Tenant.id).where(Tenant.code == workspace))
            ).scalar_one_or_none()
            if tenant_id is None:
                raise SystemExit(f"no workspace {workspace}")
            plan = await load_plan(session, tenant_id, None, workspace_code=workspace)
            ancestors = await _collection_ancestors(session, samples)
        if plan is None:
            raise SystemExit(f"workspace {workspace} has no published classification scheme")
        contextualizer = None
        model = config.model
        if model.contextualization_enabled:
            # Built as AppRuntime.item_index builds it: the `.env` model, nothing pinned.
            transport = OpenRouterTransport(
                base_url=model.openrouter_base_url, model=model.contextualization_model
            )
            contextualizer = SemanticContextualizer(
                transport,
                model_name=model.contextualization_model,
                reasoning_effort=model.contextualization_reasoning_effort,
            )
        else:
            log.warning("contextualization is disabled: unsettled schemes come out failed")
        classifier = _Classifier(
            plan=plan,
            calibration_plan=_calibration_plan(plan),
            signals=Signals(sessions=sessions, index=index, storage=runtime.object_storage()),
            contextualizer=contextualizer,
            cache=AnswerCache(JsonCache(ANSWER_CACHE)),
            ancestors=ancestors,
        )
        gate = asyncio.Semaphore(concurrency)

        async def classify(sample: LabeledSample) -> tuple[SampleOutcome, dict[str, Any]]:
            async with gate:
                return await classifier.classify(sample)

        rows = await asyncio.gather(*(classify(sample) for sample in samples))
    finally:
        if transport is not None:
            await transport.aclose()
        await runtime.aclose()

    outcomes = [outcome for outcome, _ in rows]
    summary = {
        "suite": suite,
        "workspace": workspace,
        "fingerprint": plan.fingerprint,
        "schemes": {code: scheme.version for code, scheme in plan.taxonomy.schemes.items()},
        "model": contextualizer.model_name if contextualizer is not None else None,
        **summarize(outcomes),
    }
    markdown = [f"# Classification {suite} ({started:%Y-%m-%d %H:%M})", "", f"Workspace `{workspace}`", ""]
    markdown += render_markdown(summary)
    directory = RUNS_ROOT / suite / f"{started:%Y%m%d-%H%M%S}"
    write_report(
        directory,
        summary=summary,
        markdown=markdown,
        documents=[row for _, row in rows],
        results=[result for outcome in outcomes for result in _scheme_rows(outcome)],
    )
    return ClassificationRun(directory=directory, summary=summary, markdown=markdown)


def _calibration_plan(plan: ClassificationPlan) -> ClassificationPlan:
    """The same plan with every review threshold near zero, so ``decide`` keeps
    each label the classifier chose with its confidence."""

    schemes = {
        code: replace(scheme, review_threshold=_CALIBRATION_REVIEW_THRESHOLD)
        for code, scheme in plan.taxonomy.schemes.items()
    }
    return replace(plan, taxonomy=TaxonomySnapshot(tenant_id=plan.taxonomy.tenant_id, schemes=schemes))


async def _collection_ancestors(session: Any, samples: Sequence[LabeledSample]) -> dict[str, tuple[UUID, ...]]:
    """Each sample collection's ancestry (the collection first), for collection rules."""

    ancestors: dict[str, tuple[UUID, ...]] = {}
    for sample in samples:
        if sample.collection is None or sample.collection in ancestors:
            continue
        try:
            collection_id = UUID(sample.collection.rsplit("/", 1)[-1])
        except ValueError as exc:
            raise SystemExit(f"sample {sample.id}: collection must be an item id or name") from exc
        nodes = await item_ancestry(session, collection_id)
        if not nodes:
            raise SystemExit(f"sample {sample.id}: no collection {sample.collection}")
        ancestors[sample.collection] = tuple(node.item_id for node in nodes)
    return ancestors


@dataclass(slots=True)
class _Classifier:
    plan: ClassificationPlan
    calibration_plan: ClassificationPlan
    signals: Signals
    contextualizer: SemanticContextualizer | None
    cache: AnswerCache
    ancestors: Mapping[str, tuple[UUID, ...]]

    async def classify(self, sample: LabeledSample) -> tuple[SampleOutcome, dict[str, Any]]:
        try:
            item, chunks = await asyncio.to_thread(_parse, sample)
            document = document_input(
                item,
                chunks,
                ancestor_ids=self.ancestors.get(sample.collection or "", ()),
                source_id=None,
                item_id=None,
            )
            prepared = await prepare(self.plan, document, self.signals)
        except Exception as exc:  # one unreadable sample never stops the suite
            log.warning("sample %s was not classified: %s", sample.id, exc)
            outcome = SampleOutcome(sample=sample, error=f"{type(exc).__name__}: {exc}")
            return outcome, {"id": sample.id, "title": sample.title, "error": outcome.error}
        answer: DocumentClassification | None
        model_error = None
        if not prepared.request.needs_model:
            answer = DocumentClassification()
        elif self.contextualizer is None:
            answer = None
        else:
            try:
                answer = await self.contextualizer.classify(
                    document_context=document.context,
                    request=prepared.request,
                    title=document.title,
                    cache=self.cache,
                )
            except Exception as exc:  # best effort, as processing: the schemes asked fail
                log.warning("classification of %s failed: %s", sample.id, exc)
                answer, model_error = None, f"{type(exc).__name__}: {exc}"
        written = decide(self.plan, prepared, answer)
        scored = decide(self.calibration_plan, prepared, answer)
        outcome = SampleOutcome(
            sample=sample,
            written=self._labels(written),
            scored=self._labels(scored),
            outcomes={result.scheme_code: result.outcome for result in written.schemes},
            metadata=self._metadata(written),
            model_called=written.model_called,
        )
        row = {
            "id": sample.id,
            "title": sample.title,
            "model_called": written.model_called,
            "model_error": model_error,
            "dropped": list(answer.dropped) if answer is not None else [],
            "outcomes": dict(outcome.outcomes),
            "labels": {scheme: [_label_row(label) for label in labels] for scheme, labels in outcome.written.items()},
            "scored": {scheme: [_label_row(label) for label in labels] for scheme, labels in outcome.scored.items()},
            "gold": {scheme: sorted(labels) for scheme, labels in sample.labels.items()},
            "gold_empty": sorted(sample.empty),
            "metadata": {key: list(value) if isinstance(value, tuple) else value for key, value in outcome.metadata.items()},
            "gold_metadata": {
                key: list(value) if isinstance(value, tuple) else value for key, value in sample.metadata.items()
            },
            "title_suggestion": written.title,
            "summary": written.summary,
        }
        return outcome, row

    def _notation(self, concept_id: UUID) -> str:
        concept = self.plan.taxonomy.by_concept(concept_id)
        return concept.notation if concept is not None else str(concept_id)

    def _labels(self, outcome: ClassificationOutcome) -> dict[str, tuple[PredictedLabel, ...]]:
        return {
            result.scheme_code: tuple(
                PredictedLabel(
                    notation=self._notation(row.concept_id),
                    confidence=row.confidence,
                    state=row.state,
                    primary=row.primary,
                    source=row.source,
                    section=row.section_ref,
                )
                for row in result.assignments
            )
            for result in outcome.schemes
        }

    def _metadata(self, outcome: ClassificationOutcome) -> dict[str, Any]:
        metadata = outcome.metadata
        values: dict[str, Any] = {
            "number": metadata.number,
            "issue_date": metadata.issued_on.isoformat() if metadata.issued_on else None,
            "effective_date": metadata.effective_on.isoformat() if metadata.effective_on else None,
            "issuer": self._notation(metadata.issuer_concept_id) if metadata.issuer_concept_id else None,
            "level": metadata.level,
            "units": tuple(self._notation(value) for value in metadata.unit_ids) or None,
            "programs": tuple(self._notation(value) for value in metadata.program_ids) or None,
            "cohorts": tuple(metadata.cohorts) or None,
        }
        return {key: value for key, value in values.items() if value is not None}


def _parse(sample: LabeledSample) -> tuple[DocumentItem, list[Chunk]]:
    """The sample's envelope and retrieval chunks, parsed and chunked like an upload."""

    processor = FileProcessor()
    if sample.path is not None:
        path = sample.path
        parsed = processor.parse_path(path, file_name=path.name)
    else:
        with tempfile.TemporaryDirectory(prefix="bomesh-eval-") as directory:
            path = Path(directory) / "sample.md"
            path.write_text(sample.text or "", "utf-8")
            parsed = processor.parse_path(path, file_name=path.name)
    extension = path.suffix.casefold()
    chunks = DoclingChunker().chunk(
        parsed, item_id=sample.id, strategy="line" if extension in _LINE_EXTENSIONS else "hybrid"
    )
    item = DocumentItem(
        id=sample.id,
        title=sample.title,
        source=SourceIdentity(connector_id="eval", provider=SourceProvider.FILE, external_id=sample.id),
        document_kind=DocumentKind.PDF if extension == ".pdf" else DocumentKind.DOCUMENT,
        access=AccessPolicy(),
        hierarchy=Hierarchy(),
    )
    return item, chunks


def _label_row(label: PredictedLabel) -> dict[str, Any]:
    return {
        "notation": label.notation,
        "confidence": round(label.confidence, 4),
        "state": label.state,
        "primary": label.primary,
        "source": label.source,
        "section": label.section,
    }


def _scheme_rows(outcome: SampleOutcome) -> list[dict[str, Any]]:
    if outcome.error is not None:
        return []
    rows = []
    for scheme in sorted(outcome.sample.schemes):
        labels = outcome.written.get(scheme, ())
        rows.append(
            {
                "id": outcome.sample.id,
                "scheme": scheme,
                "outcome": outcome.outcomes.get(scheme),
                "gold": sorted(outcome.sample.labels.get(scheme, ())),
                "accepted": sorted({label.notation for label in labels if label.state == "accepted"}),
                "suggested": sorted({label.notation for label in labels if label.state == "suggested"}),
            }
        )
    return rows


__all__ = ["AnswerCache", "ClassificationRun", "run_classification"]
