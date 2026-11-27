"""Benchmark suite: one local folder holding a corpus, its questions, and the Collection it was last ingested into.

``eval/suites/<name>/`` (git-ignored: the corpus and its quotes are workspace data)::

    files/            the documents, uploaded in name order
    questions.jsonl   one question per line; gold evidence names a file and a verbatim quote
    suite.json        who ingests it (workspace code, user email), the Collection of the last
                      ingestion, and how the questions were generated

Gold evidence names files, not item IDs, so the same questions score every fresh ingestion:
:meth:`Suite.dataset` binds them to the items of the Collection the corpus was last ingested into.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from eval.dataset import BenchmarkQuestion, Dataset, DatasetManifest, GoldEvidence

SUITES_ROOT = Path(__file__).resolve().parent / "suites"


@dataclass(frozen=True, slots=True)
class IngestedCollection:
    """Where the corpus was last ingested, and what it was then."""

    name: str
    run: str
    ingested_at: str
    files: dict[str, str]
    processing_signature: dict[str, Any] = field(default_factory=dict)

    @property
    def tenant_id(self) -> str:
        return self.name.split("/")[1]

    @property
    def collection_id(self) -> str:
        return self.name.split("/")[-1]


@dataclass(slots=True)
class Suite:
    name: str
    directory: Path
    workspace: str
    user: str
    collection: IngestedCollection | None = None
    generation: dict[str, Any] = field(default_factory=dict)

    @property
    def files_directory(self) -> Path:
        return self.directory / "files"

    @property
    def questions_path(self) -> Path:
        return self.directory / "questions.jsonl"

    def files(self) -> list[Path]:
        """The corpus in name order (hidden files skipped)."""

        if not self.files_directory.is_dir():
            return []
        return sorted(p for p in self.files_directory.iterdir() if p.is_file() and not p.name.startswith("."))

    def fingerprint(self) -> dict[str, str]:
        return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in self.files()}

    def questions(self) -> list[dict[str, Any]]:
        if not self.questions_path.exists():
            return []
        lines = self.questions_path.read_text("utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def dataset(self, items: dict[str, str]) -> Dataset:
        """The questions bound to the last ingestion: ``items`` maps each file name to its item ID."""

        if self.collection is None:
            raise SystemExit(f"suite {self.name} has not been ingested yet")
        questions: list[BenchmarkQuestion] = []
        seen: set[str] = set()
        for line, payload in enumerate(self.questions(), start=1):
            missing = [gold["file"] for gold in payload.get("gold", ()) if gold["file"] not in items]
            if missing:
                raise SystemExit(f"questions.jsonl:{line}: {missing[0]} is not in the ingested Collection")
            question = BenchmarkQuestion(
                id=payload["id"],
                question=payload["question"],
                type=payload["type"],
                language=payload["language"],
                gold=tuple(
                    GoldEvidence(item_id=items[gold["file"]], title=gold["file"], quote=gold["quote"])
                    for gold in payload.get("gold", ())
                ),
                reference_answer=payload.get("reference_answer"),
            )
            if question.id in seen:
                raise SystemExit(f"questions.jsonl:{line}: duplicate id {question.id}")
            seen.add(question.id)
            questions.append(question)
        manifest = DatasetManifest(
            name=self.name,
            tenant_id=self.collection.tenant_id,
            collection_item_ids=(self.collection.collection_id,),
            created_at=self.generation.get("generated_at", ""),
            generator_model=self.generation.get("generator_model"),
            processing_signature=self.generation.get("processing_signature", {}),
            seed=self.generation.get("seed"),
        )
        return Dataset(manifest, tuple(questions))

    def write_questions(self, dataset: Dataset) -> None:
        """Store generated questions by file name, with how they were generated."""

        with self.questions_path.open("w", encoding="utf-8") as handle:
            for question in dataset.questions:
                payload = question.to_json()
                payload["gold"] = [{"file": gold.title, "quote": gold.quote} for gold in question.gold]
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        manifest = dataset.manifest
        self.generation = {
            "generated_at": manifest.created_at,
            "generator_model": manifest.generator_model,
            "seed": manifest.seed,
            "processing_signature": manifest.processing_signature,
            "questions": len(dataset.questions),
        }
        self.save()

    def record_ingestion(self, *, collection: str, run: str, files: dict[str, str], processing_signature: dict[str, Any]) -> None:
        self.collection = IngestedCollection(
            name=collection,
            run=run,
            ingested_at=datetime.now(UTC).isoformat(timespec="seconds"),
            files=files,
            processing_signature=processing_signature,
        )
        self.save()

    def save(self) -> None:
        payload: dict[str, Any] = {"workspace": self.workspace, "user": self.user}
        if self.collection is not None:
            payload["collection"] = {
                "name": self.collection.name,
                "run": self.collection.run,
                "ingested_at": self.collection.ingested_at,
                "processing_signature": self.collection.processing_signature,
                "files": self.collection.files,
            }
        if self.generation:
            payload["questions"] = self.generation
        (self.directory / "suite.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")


def load_suite(name: str) -> Suite:
    if not name or "/" in name or name.startswith("."):
        raise SystemExit(f"invalid suite name: {name!r}")
    directory = SUITES_ROOT / name
    path = directory / "suite.json"
    if not path.exists():
        raise SystemExit(f"no suite {name}: create {path} with its workspace and user, and put the corpus in files/")
    payload = json.loads(path.read_text("utf-8"))
    collection = payload.get("collection")
    return Suite(
        name=name,
        directory=directory,
        workspace=payload["workspace"],
        user=payload["user"],
        collection=IngestedCollection(**collection) if collection else None,
        generation=payload.get("questions", {}),
    )


__all__ = ["SUITES_ROOT", "IngestedCollection", "Suite", "load_suite"]
