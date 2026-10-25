"""LLM judges on the configured OpenRouter model.

Traditional metrics only see the gold quote; the relevance judge also credits
passages that answer the question in other words or from another document, and
the answer judge grades what the agent actually said.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from hashlib import sha256

from eval.llm import JsonCache, JsonModel, render

_MAX_PASSAGE_CHARACTERS = 1_500
_BATCH_SIZE = 8


class RelevanceJudge:
    """Grade passages 0 (useless), 1 (related), 2 (answers) per question.

    Grades are cached per (model, question, passage text), so one passage is
    judged once across stages, variants and runs.
    """

    def __init__(self, model: JsonModel, grades: JsonCache) -> None:
        self._model = model
        self._grades = grades

    async def grade(self, question: str, passages: Sequence[str]) -> list[int]:
        keys = [self._key(question, passage) for passage in passages]
        pending: dict[str, str] = {}
        for key, passage in zip(keys, passages, strict=True):
            if self._grades.get(key) is None:
                pending.setdefault(key, passage)
        pending_items = list(pending.items())
        for start in range(0, len(pending_items), _BATCH_SIZE):
            await self._grade_batch(question, pending_items[start : start + _BATCH_SIZE])
        grades: list[int] = []
        for key in keys:
            cached = self._grades.get(key)
            if cached is None:
                raise ValueError("relevance judge left a passage ungraded")
            grades.append(int(cached["grade"]))
        return grades

    async def _grade_batch(self, question: str, batch: list[tuple[str, str]]) -> None:
        labelled = {f"p{index}": item for index, item in enumerate(batch, start=1)}
        passages = "\n\n".join(
            f'<passage id="{label}">\n{text[:_MAX_PASSAGE_CHARACTERS]}\n</passage>'
            for label, (_, text) in labelled.items()
        )
        answer = await self._model.ask(
            render("judge_relevance", question=question, passages=passages)
        )
        for entry in answer.get("grades", []):
            label = str(entry.get("id", ""))
            grade = entry.get("grade")
            if label in labelled and grade in (0, 1, 2):
                await self._grades.put(labelled[label][0], {"grade": grade})

    def _key(self, question: str, passage: str) -> str:
        return sha256(
            f"{self._model.model_name}\0{question}\0{passage}".encode()
        ).hexdigest()


@dataclass(frozen=True, slots=True)
class AnswerVerdict:
    correctness: int
    grounded: bool
    abstained: bool
    reason: str


class AnswerJudge:
    def __init__(self, model: JsonModel) -> None:
        self._model = model

    async def judge(
        self,
        *,
        question: str,
        reference: str | None,
        answer: str,
        cited_passages: Sequence[tuple[str, str]],
    ) -> AnswerVerdict:
        cited = (
            "\n\n".join(
                f'<passage title="{title}">\n{text[:_MAX_PASSAGE_CHARACTERS]}\n</passage>'
                for title, text in cited_passages
            )
            or "(none)"
        )
        value = await self._model.ask(
            render(
                "judge_answer",
                question=question,
                reference=reference or "NONE",
                answer=answer or "(empty)",
                cited=cited,
            )
        )
        correctness = value.get("correctness")
        if correctness not in (0, 1, 2):
            raise ValueError(f"answer judge returned correctness={correctness!r}")
        return AnswerVerdict(
            correctness=int(correctness),
            grounded=_as_bool(value.get("grounded")),
            abstained=_as_bool(value.get("abstained")),
            reason=str(value.get("reason", "")),
        )


def _as_bool(value: object) -> bool:
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return value is True


__all__ = ["AnswerJudge", "AnswerVerdict", "RelevanceJudge"]
