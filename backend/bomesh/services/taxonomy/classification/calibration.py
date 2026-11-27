"""Confidence of a model-chosen label and routing by the scheme's thresholds.

``confidence`` starts from the model's certainty, adds a step per candidate
source that agreed (lexical, card, kNN, prior) and subtracts a step per
shortlist rank below the first. The constants are the starting point the
labeled eval set (``backend/eval/classification``, design D3) calibrates; a
rule ``implies`` row is always 1.0.

Model certainty alone never auto-accepts: a label no candidate source
corroborates (its words in the text, a top card similarity, a kNN vote) is
held just below the scheme's auto threshold (:func:`held_below_auto`), so it
can only be suggested. A prior is a rule's hint, not corroboration.
"""

from __future__ import annotations

from bomesh.services.taxonomy.snapshot import SchemeSnapshot

CLASSIFIER_VERSION = "facet-1"
#: Used when a scheme's thresholds are NULL.
DEFAULT_AUTO_THRESHOLD = 0.9
DEFAULT_REVIEW_THRESHOLD = 0.5
SHORTLIST_SIZE = 12

#: Model certainty → base confidence; an answer without certainty reads as ``UNKNOWN_CERTAINTY``.
CERTAINTY_BASE = {"high": 0.9, "medium": 0.7, "low": 0.45}
UNKNOWN_CERTAINTY = 0.6
#: Per candidate source that scored the label (at most four kinds).
AGREEMENT_STEP = 0.03
MAX_AGREEMENT = 4
#: Per shortlist position after the first; the penalty stops at ``MAX_RANK_PENALTY``.
RANK_STEP = 0.02
MAX_RANK_PENALTY = 0.2
RULE_CONFIDENCE = 1.0
#: Sources that corroborate a model pick from the document itself.
CORROBORATING_SIGNALS = ("lexical", "card", "knn")
#: A card similarity corroborates only among the scheme's top this many cards.
CARD_CORROBORATION_RANK = 3
#: How far below the auto threshold an uncorroborated pick is held.
UNCORROBORATED_MARGIN = 0.01


def confidence(certainty: str | None, agreement: int, rank: int) -> float:
    """Calibrated confidence 0..1 of a label the model chose."""

    base = CERTAINTY_BASE.get(certainty or "", UNKNOWN_CERTAINTY)
    bonus = AGREEMENT_STEP * min(max(agreement, 0), MAX_AGREEMENT)
    penalty = min(RANK_STEP * max(rank, 0), MAX_RANK_PENALTY)
    return round(min(1.0, max(0.0, base + bonus - penalty)), 3)


def thresholds(scheme: SchemeSnapshot) -> tuple[float, float]:
    """``(auto, review)`` of the scheme, defaults when NULL."""

    auto = DEFAULT_AUTO_THRESHOLD if scheme.auto_threshold is None else scheme.auto_threshold
    review = (
        DEFAULT_REVIEW_THRESHOLD if scheme.review_threshold is None else scheme.review_threshold
    )
    return auto, review


def held_below_auto(value: float, scheme: SchemeSnapshot, corroborated: bool) -> float:
    """``value``, kept just below the scheme's auto threshold when nothing corroborates it."""

    if corroborated:
        return value
    auto, _review = thresholds(scheme)
    return round(min(value, auto - UNCORROBORATED_MARGIN), 3)


def route(confidence: float, scheme: SchemeSnapshot) -> str | None:
    """``accepted`` at or above auto, ``suggested`` at or above review, ``None`` below."""

    auto, review = thresholds(scheme)
    if confidence >= auto:
        return "accepted"
    if confidence >= review:
        return "suggested"
    return None


__all__ = [
    "AGREEMENT_STEP",
    "CARD_CORROBORATION_RANK",
    "CERTAINTY_BASE",
    "CLASSIFIER_VERSION",
    "CORROBORATING_SIGNALS",
    "DEFAULT_AUTO_THRESHOLD",
    "DEFAULT_REVIEW_THRESHOLD",
    "MAX_AGREEMENT",
    "MAX_RANK_PENALTY",
    "RANK_STEP",
    "RULE_CONFIDENCE",
    "SHORTLIST_SIZE",
    "UNCORROBORATED_MARGIN",
    "UNKNOWN_CERTAINTY",
    "confidence",
    "held_below_auto",
    "route",
    "thresholds",
]
