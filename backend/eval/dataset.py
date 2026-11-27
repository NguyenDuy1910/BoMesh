"""Benchmark questions bound to an ingested Collection (stored per suite: :mod:`eval.suite`)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, get_args

QuestionType = Literal[
    "factual", "exact_code", "paraphrase", "table", "multi_hop", "unanswerable"
]
QUESTION_TYPES: tuple[str, ...] = get_args(QuestionType)

@dataclass(frozen=True, slots=True)
class GoldEvidence:
    """One verbatim span a correct retrieval must surface."""

    item_id: str
    title: str
    quote: str


@dataclass(frozen=True, slots=True)
class BenchmarkQuestion:
    id: str
    question: str
    type: QuestionType
    language: str
    gold: tuple[GoldEvidence, ...] = ()
    reference_answer: str | None = None

    @property
    def answerable(self) -> bool:
        return self.type != "unanswerable"

    def __post_init__(self) -> None:
        if self.type not in QUESTION_TYPES:
            raise ValueError(f"{self.id}: unknown question type {self.type!r}")
        if not self.question.strip():
            raise ValueError(f"{self.id}: question must not be blank")
        if self.answerable and not self.gold:
            raise ValueError(f"{self.id}: an answerable question needs gold evidence")
        if not self.answerable and self.gold:
            raise ValueError(f"{self.id}: an unanswerable question has no gold evidence")

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["gold"] = [asdict(gold) for gold in self.gold]
        return payload


@dataclass(frozen=True, slots=True)
class DatasetManifest:
    """The Collection the questions are bound to, and how they were generated."""

    name: str
    tenant_id: str
    collection_item_ids: tuple[str, ...]
    created_at: str
    generator_model: str | None
    processing_signature: dict[str, Any] = field(default_factory=dict)
    seed: int | None = None


@dataclass(frozen=True, slots=True)
class Dataset:
    manifest: DatasetManifest
    questions: tuple[BenchmarkQuestion, ...]


__all__ = [
    "QUESTION_TYPES",
    "BenchmarkQuestion",
    "Dataset",
    "DatasetManifest",
    "GoldEvidence",
    "QuestionType",
]
