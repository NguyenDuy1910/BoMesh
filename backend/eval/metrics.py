"""Traditional ranking metrics over one ranked list.

``matches[i]`` is the set of gold evidence indexes the passage at rank ``i + 1``
carries (empty when it carries none). ``gold_count`` is how many evidence
quotes the question needs. Graded metrics take judge grades instead.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence


def hit_at_k(matches: Sequence[frozenset[int]], k: int) -> float:
    """1.0 when any of the top ``k`` passages carries gold evidence."""

    return 1.0 if any(matches[:k]) else 0.0


def recall_at_k(matches: Sequence[frozenset[int]], gold_count: int, k: int) -> float:
    """Share of distinct gold evidence quotes found in the top ``k``."""

    if gold_count < 1:
        raise ValueError("recall needs at least one gold evidence")
    found: set[int] = set()
    for matched in matches[:k]:
        found |= matched
    return len(found) / gold_count


def precision_at_k(matches: Sequence[frozenset[int]], k: int) -> float:
    """Share of the ``k`` slots holding a gold-carrying passage.

    The denominator is ``k`` even when fewer passages came back: an empty slot
    is not a relevant one.
    """

    if k < 1:
        raise ValueError("k must be at least one")
    return sum(1 for matched in matches[:k] if matched) / k


def reciprocal_rank(matches: Sequence[frozenset[int]]) -> float:
    for rank, matched in enumerate(matches, start=1):
        if matched:
            return 1.0 / rank
    return 0.0


def dcg(gains: Iterable[float]) -> float:
    return sum(gain / math.log2(rank + 1) for rank, gain in enumerate(gains, start=1))


def ndcg_at_k(gains: Sequence[float], k: int, *, ideal: Sequence[float]) -> float:
    """Normalized DCG of ``gains[:k]`` against the best ordering of ``ideal``.

    ``ideal`` is every known gain for the question (retrieved or not); it
    must contain the retrieved gains, so the result never exceeds 1.
    """

    best = dcg(sorted(ideal, reverse=True)[:k])
    if best == 0:
        return 0.0
    return dcg(gains[:k]) / best


def binary_ndcg_at_k(
    matches: Sequence[frozenset[int]], gold_count: int, k: int
) -> float:
    """nDCG with gain 1 per gold-carrying passage.

    A duplicate document can carry the same quote, so the ideal list holds as
    many relevant passages as were actually found, and never fewer than the
    gold evidence count.
    """

    gains = [1.0 if matched else 0.0 for matched in matches]
    relevant = max(gold_count, int(sum(gains)))
    return ndcg_at_k(gains, k, ideal=[1.0] * relevant)


def mean(values: Iterable[float]) -> float | None:
    collected = list(values)
    return sum(collected) / len(collected) if collected else None


def percentile(values: Iterable[float], q: float) -> float | None:
    """Linear-interpolated percentile, ``q`` in [0, 100]."""

    ordered = sorted(values)
    if not ordered:
        return None
    if not 0 <= q <= 100:
        raise ValueError("q must be within [0, 100]")
    position = (len(ordered) - 1) * q / 100
    lower = math.floor(position)
    upper = math.ceil(position)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


__all__ = [
    "binary_ndcg_at_k",
    "dcg",
    "hit_at_k",
    "mean",
    "ndcg_at_k",
    "percentile",
    "precision_at_k",
    "recall_at_k",
    "reciprocal_rank",
]
