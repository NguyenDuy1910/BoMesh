"""Which document answers a starter prompt: rarity-weighted lexical coverage.

A prompt's significant words (diacritics folded, stopwords and one-letter
tokens dropped) are weighted by how rare they are among the candidate
documents (``log(1 + N / df)``; a word no document uses weighs ``log(1 + N)``),
so "học phí" outweighs "học". A document's score counts each word found in its
title twice and in its summary once; it answers the prompt when the best score
covers at least :data:`ANSWERS_AT` of the prompt's full weight, so task-like
prompts ("what did students ask this week?") get no document.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

#: Least share of a prompt's weighted words a document must cover to answer it.
ANSWERS_AT = 0.2

_STOPWORDS = frozenset(
    (
        # English function words.
        "a an and are as at be by can do does for from how i if in is it me my of on or our"
        " the their to was we what when where which who why will with you your about this"
        " that these those there any all after before"
        # Vietnamese function words, folded.
        " la cua va cho khong nao gi toi duoc cac nhung mot voi thi ve nhu nay"
    ).split()
)
_SPLIT = re.compile(r"[\W_]+")


@dataclass(frozen=True, slots=True)
class Candidate:
    """A readable document a prompt may be answered by."""

    item_id: UUID
    title: str
    summary: str | None


def fold(text: str) -> str:
    """Lower case without diacritics (``đ`` → ``d``)."""
    decomposed = unicodedata.normalize("NFKD", text.replace("đ", "d").replace("Đ", "D"))
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def tokens(text: str) -> frozenset[str]:
    """The significant words of ``text``, folded."""
    return frozenset(
        word for word in _SPLIT.split(fold(text)) if len(word) > 1 and word not in _STOPWORDS
    )


def best_answers(candidates: Sequence[Candidate], prompts: Sequence[str]) -> list[UUID | None]:
    """For each prompt, the candidate that answers it (first best on ties), else None."""
    bags = [(c.item_id, tokens(c.title), tokens(c.summary or "")) for c in candidates]
    frequency: Counter[str] = Counter()
    for _, title, body in bags:
        frequency.update(title | body)
    size = len(bags)
    answers: list[UUID | None] = []
    for prompt in prompts:
        weights = {word: math.log(1 + size / (frequency[word] or 1)) for word in tokens(prompt)}
        full = 2 * sum(weights.values())
        best: UUID | None = None
        best_score = 0.0
        for item_id, title, body in bags:
            score = sum(
                (2 if word in title else 1 if word in body else 0) * weight
                for word, weight in weights.items()
            )
            if score > best_score:
                best, best_score = item_id, score
        answers.append(best if full and best_score / full >= ANSWERS_AT else None)
    return answers


__all__ = ["ANSWERS_AT", "Candidate", "best_answers", "fold", "tokens"]
