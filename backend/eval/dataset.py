"""Benchmark dataset: a manifest plus one question per JSONL line."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, get_args

QuestionType = Literal[
    "factual", "exact_code", "paraphrase", "table", "multi_hop", "unanswerable"
]
QUESTION_TYPES: tuple[str, ...] = get_args(QuestionType)

DATASETS_ROOT = Path(__file__).resolve().parent / "datasets"


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

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> BenchmarkQuestion:
        return cls(
            id=payload["id"],
            question=payload["question"],
            type=payload["type"],
            language=payload["language"],
            gold=tuple(GoldEvidence(**gold) for gold in payload.get("gold", ())),
            reference_answer=payload.get("reference_answer"),
        )


@dataclass(frozen=True, slots=True)
class DatasetManifest:
    """Where the questions were drawn from and how."""

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


def dataset_directory(name: str) -> Path:
    if not name or "/" in name or name.startswith("."):
        raise ValueError(f"invalid dataset name: {name!r}")
    return DATASETS_ROOT / name


def save_dataset(dataset: Dataset) -> Path:
    directory = dataset_directory(dataset.manifest.name)
    directory.mkdir(parents=True, exist_ok=True)
    manifest = asdict(dataset.manifest)
    manifest["question_count"] = len(dataset.questions)
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (directory / "questions.jsonl").open("w", encoding="utf-8") as handle:
        for question in dataset.questions:
            handle.write(json.dumps(question.to_json(), ensure_ascii=False) + "\n")
    return directory


def load_dataset(name: str) -> Dataset:
    directory = dataset_directory(name)
    manifest_payload = json.loads((directory / "manifest.json").read_text("utf-8"))
    manifest_payload.pop("question_count", None)
    manifest_payload["collection_item_ids"] = tuple(
        manifest_payload["collection_item_ids"]
    )
    questions: list[BenchmarkQuestion] = []
    seen: set[str] = set()
    with (directory / "questions.jsonl").open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            question = BenchmarkQuestion.from_json(json.loads(line))
            if question.id in seen:
                raise ValueError(f"questions.jsonl:{line_number}: duplicate id {question.id}")
            seen.add(question.id)
            questions.append(question)
    return Dataset(DatasetManifest(**manifest_payload), tuple(questions))


__all__ = [
    "QUESTION_TYPES",
    "BenchmarkQuestion",
    "Dataset",
    "DatasetManifest",
    "GoldEvidence",
    "QuestionType",
    "dataset_directory",
    "load_dataset",
    "save_dataset",
]
