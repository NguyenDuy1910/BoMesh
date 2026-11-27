"""Pure classification metrics: per-scheme precision/recall, metadata accuracy, calibration.

Nothing here calls a model or a database; ``runner.py`` turns the classifier's
results into :class:`SampleOutcome` rows and these functions score them.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from eval.classification.labels import METADATA_FIELDS, LabeledSample
from eval.report import markdown_table

#: Confidence thresholds of the calibration table: 0.30 to 0.95 by 0.05, then 0.99.
THRESHOLDS: tuple[float, ...] = (*(round(0.30 + 0.05 * step, 2) for step in range(14)), 0.99)
#: ``auto`` is the lowest threshold whose precision reaches this, per scheme.
AUTO_PRECISION_TARGET = 0.95
#: ``review`` is the highest threshold whose recall still reaches this, per scheme.
REVIEW_RECALL_TARGET = 0.9
ACCEPTED: frozenset[str] = frozenset({"accepted"})
WRITTEN: frozenset[str] = frozenset({"accepted", "suggested"})


@dataclass(frozen=True, slots=True)
class PredictedLabel:
    """One label the classifier gave a sample (document- or section-level)."""

    notation: str
    confidence: float
    state: str  # accepted | suggested
    primary: bool = False
    source: str = "llm"
    section: str | None = None


@dataclass(frozen=True, slots=True)
class SampleOutcome:
    """What the classifier did with one labeled sample.

    ``written`` are the rows routed with the schemes' own thresholds (what
    processing would store); ``scored`` keeps every label the classifier chose
    with its confidence, whatever the review threshold (the calibration input).
    """

    sample: LabeledSample
    written: Mapping[str, tuple[PredictedLabel, ...]] = field(default_factory=dict)
    scored: Mapping[str, tuple[PredictedLabel, ...]] = field(default_factory=dict)
    outcomes: Mapping[str, str] = field(default_factory=dict)
    metadata: Mapping[str, Any] = field(default_factory=dict)
    model_called: bool = False
    error: str | None = None


@dataclass(frozen=True, slots=True)
class Score:
    tp: int = 0
    fp: int = 0
    fn: int = 0

    def __add__(self, other: Score) -> Score:
        return Score(self.tp + other.tp, self.fp + other.fp, self.fn + other.fn)

    @property
    def precision(self) -> float | None:
        predicted = self.tp + self.fp
        return self.tp / predicted if predicted else None

    @property
    def recall(self) -> float | None:
        gold = self.tp + self.fn
        return self.tp / gold if gold else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "precision": self.precision,
            "recall": self.recall,
        }


def compare(predicted: Iterable[str], gold: Iterable[str]) -> Score:
    """Set comparison of one sample's labels in one scheme."""

    chosen, expected = set(predicted), set(gold)
    return Score(len(chosen & expected), len(chosen - expected), len(expected - chosen))


def _judged(outcomes: Iterable[SampleOutcome]) -> list[SampleOutcome]:
    return [outcome for outcome in outcomes if outcome.error is None]


def scheme_scores(outcomes: Iterable[SampleOutcome], *, states: frozenset[str]) -> dict[str, Score]:
    """Micro precision/recall per scheme over the written rows in ``states``.

    ``ACCEPTED`` measures what is applied without review; ``WRITTEN``
    (accepted and suggested) measures what reaches a person at all.
    """

    scores: dict[str, Score] = {}
    for outcome in _judged(outcomes):
        for scheme in outcome.sample.schemes:
            chosen = (label.notation for label in outcome.written.get(scheme, ()) if label.state in states)
            gold = outcome.sample.labels.get(scheme, frozenset())
            scores[scheme] = scores.get(scheme, Score()) + compare(chosen, gold)
    return dict(sorted(scores.items()))


def threshold_scores(outcomes: Iterable[SampleOutcome], threshold: float) -> dict[str, Score]:
    """Per-scheme scores if every scored label at or above ``threshold`` were kept."""

    scores: dict[str, Score] = {}
    for outcome in _judged(outcomes):
        for scheme in outcome.sample.schemes:
            chosen = (
                label.notation
                for label in outcome.scored.get(scheme, ())
                if label.confidence >= threshold - 1e-9
            )
            gold = outcome.sample.labels.get(scheme, frozenset())
            scores[scheme] = scores.get(scheme, Score()) + compare(chosen, gold)
    return dict(sorted(scores.items()))


def calibration(
    outcomes: Sequence[SampleOutcome], thresholds: Sequence[float] = THRESHOLDS
) -> dict[str, list[dict[str, Any]]]:
    """Per scheme, one row per threshold: precision, recall and labels kept."""

    table: dict[str, list[dict[str, Any]]] = {}
    for threshold in thresholds:
        for scheme, score in threshold_scores(outcomes, threshold).items():
            table.setdefault(scheme, []).append(
                {
                    "threshold": threshold,
                    "precision": score.precision,
                    "recall": score.recall,
                    "kept": score.tp + score.fp,
                }
            )
    return table


def recommend_thresholds(
    table: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    precision_target: float = AUTO_PRECISION_TARGET,
    recall_target: float = REVIEW_RECALL_TARGET,
) -> dict[str, dict[str, float | None]]:
    """``auto``: the lowest threshold with precision ≥ the target; ``review``: the
    highest with recall ≥ the target, never above ``auto``. ``None`` when no
    threshold of the table reaches the target."""

    recommended: dict[str, dict[str, float | None]] = {}
    for scheme, rows in table.items():
        ordered = sorted(rows, key=lambda row: row["threshold"])
        auto = next(
            (
                row["threshold"]
                for row in ordered
                if row["precision"] is not None and row["precision"] >= precision_target
            ),
            None,
        )
        review = next(
            (
                row["threshold"]
                for row in reversed(ordered)
                if row["recall"] is not None and row["recall"] >= recall_target
            ),
            None,
        )
        if auto is not None and review is not None and review > auto:
            review = auto
        recommended[scheme] = {"auto": auto, "review": review}
    return recommended


def primary_accuracy(outcomes: Iterable[SampleOutcome]) -> dict[str, dict[str, Any]]:
    """Per scheme, of the samples with a gold primary: an accepted primary equal to it."""

    counts: dict[str, Counter[str]] = {}
    for outcome in _judged(outcomes):
        for scheme, gold in outcome.sample.primary.items():
            primary = next(
                (
                    label.notation
                    for label in outcome.written.get(scheme, ())
                    if label.primary and label.state == "accepted" and label.section is None
                ),
                None,
            )
            count = counts.setdefault(scheme, Counter())
            count["total"] += 1
            count["correct"] += primary == gold
    return {
        scheme: {**count, "accuracy": count["correct"] / count["total"]}
        for scheme, count in sorted(counts.items())
    }


def empty_scores(outcomes: Iterable[SampleOutcome]) -> dict[str, dict[str, int]]:
    """Per scheme: gold-empty samples, how many came out ``empty``, and samples
    with gold labels that came out ``empty`` (false empties)."""

    counts: dict[str, Counter[str]] = {}
    for outcome in _judged(outcomes):
        for scheme in outcome.sample.schemes:
            count = counts.setdefault(scheme, Counter())
            empty = outcome.outcomes.get(scheme) == "empty"
            if scheme in outcome.sample.empty:
                count["gold_empty"] += 1
                count["correct_empty"] += empty
            elif empty:
                count["false_empty"] += 1
    return {
        scheme: {key: count[key] for key in ("gold_empty", "correct_empty", "false_empty")}
        for scheme, count in sorted(counts.items())
    }


def outcome_counts(outcomes: Iterable[SampleOutcome]) -> dict[str, dict[str, int]]:
    """Per judged scheme, how many samples ended ``assigned``/``empty``/``uncertain``/``failed``."""

    counts: dict[str, Counter[str]] = {}
    for outcome in _judged(outcomes):
        for scheme in outcome.sample.schemes:
            counts.setdefault(scheme, Counter())[outcome.outcomes.get(scheme, "not_classified")] += 1
    return {scheme: dict(sorted(count.items())) for scheme, count in sorted(counts.items())}


def metadata_accuracy(outcomes: Iterable[SampleOutcome]) -> dict[str, dict[str, Any]]:
    """Per metadata field, of the samples whose gold has it: the extracted value equals it.

    Strings compare NFC, case-folded, whitespace-collapsed; lists as sets.
    """

    counts: dict[str, Counter[str]] = {}
    for outcome in _judged(outcomes):
        for name in METADATA_FIELDS:
            gold = outcome.sample.metadata.get(name)
            if gold is None:
                continue
            count = counts.setdefault(name, Counter())
            count["total"] += 1
            predicted = outcome.metadata.get(name)
            if predicted is None:
                count["missing"] += 1
            elif _normalized(predicted) == _normalized(gold):
                count["correct"] += 1
    return {
        name: {
            "total": counts[name]["total"],
            "correct": counts[name]["correct"],
            "missing": counts[name]["missing"],
            "accuracy": counts[name]["correct"] / counts[name]["total"],
        }
        for name in METADATA_FIELDS
        if name in counts
    }


def _normalized(value: Any) -> Any:
    if isinstance(value, (list, tuple, set, frozenset)):
        return frozenset(_normalized(item) for item in value)
    if isinstance(value, str):
        return " ".join(unicodedata.normalize("NFC", value).casefold().split())
    return value


def summarize(outcomes: Sequence[SampleOutcome]) -> dict[str, Any]:
    """Every metric of one run, JSON-ready."""

    judged = _judged(outcomes)
    table = calibration(judged)
    accepted = scheme_scores(judged, states=ACCEPTED)
    written = scheme_scores(judged, states=WRITTEN)
    return {
        "samples": len(outcomes),
        "errors": len(outcomes) - len(judged),
        "model_calls": sum(outcome.model_called for outcome in judged),
        "schemes": {
            scheme: {
                "accepted": accepted[scheme].as_dict(),
                "suggested": written[scheme].as_dict(),
            }
            for scheme in accepted
        },
        "primary": primary_accuracy(judged),
        "empty": empty_scores(judged),
        "outcomes": outcome_counts(judged),
        "metadata": metadata_accuracy(judged),
        "calibration": table,
        "recommended_thresholds": recommend_thresholds(table),
        "targets": {"auto_precision": AUTO_PRECISION_TARGET, "review_recall": REVIEW_RECALL_TARGET},
    }


def _cell(value: float | None) -> str:
    return "—" if value is None else f"{value:.3f}"


def render_markdown(summary: Mapping[str, Any]) -> list[str]:
    """The report's Markdown body (after its title)."""

    lines = [
        f"{summary['samples']} samples · {summary['errors']} not classified (errors) · "
        f"{summary['model_calls']} model calls",
        "",
        "## Labels per scheme",
        "",
        "`accepted`: rows applied without review; `suggested`: accepted and suggested rows.",
        "",
    ]
    lines += markdown_table(
        ["Scheme", "P accepted", "R accepted", "P suggested", "R suggested", "Gold labels"],
        [
            [
                scheme,
                _cell(scores["accepted"]["precision"]),
                _cell(scores["accepted"]["recall"]),
                _cell(scores["suggested"]["precision"]),
                _cell(scores["suggested"]["recall"]),
                str(scores["suggested"]["tp"] + scores["suggested"]["fn"]),
            ]
            for scheme, scores in summary["schemes"].items()
        ],
    )
    lines += ["## Outcomes", ""]
    lines += markdown_table(
        ["Scheme", "Outcomes", "Gold empty → empty", "False empty", "Primary correct"],
        [
            [
                scheme,
                ", ".join(f"{name} {count}" for name, count in counts.items()),
                f"{summary['empty'].get(scheme, {}).get('correct_empty', 0)}/"
                f"{summary['empty'].get(scheme, {}).get('gold_empty', 0)}",
                str(summary["empty"].get(scheme, {}).get("false_empty", 0)),
                (
                    f"{summary['primary'][scheme]['correct']}/{summary['primary'][scheme]['total']}"
                    if scheme in summary["primary"]
                    else "—"
                ),
            ]
            for scheme, counts in summary["outcomes"].items()
        ],
    )
    if summary["metadata"]:
        lines += ["## Metadata", ""]
        lines += markdown_table(
            ["Field", "Accuracy", "Correct", "Missing", "Gold"],
            [
                [name, _cell(row["accuracy"]), str(row["correct"]), str(row["missing"]), str(row["total"])]
                for name, row in summary["metadata"].items()
            ],
        )
    targets = summary["targets"]
    lines += [
        "## Threshold calibration",
        "",
        f"Recommended `auto`: lowest threshold with precision ≥ {targets['auto_precision']}; "
        f"`review`: highest with recall ≥ {targets['review_recall']} (never above `auto`).",
        "",
    ]
    lines += markdown_table(
        ["Scheme", "auto", "review"],
        [
            [scheme, _cell(row["auto"]), _cell(row["review"])]
            for scheme, row in summary["recommended_thresholds"].items()
        ],
    )
    for scheme, rows in summary["calibration"].items():
        lines += [f"### {scheme}", ""]
        lines += markdown_table(
            ["Threshold", "Precision", "Recall", "Kept"],
            [
                [f"{row['threshold']:.2f}", _cell(row["precision"]), _cell(row["recall"]), str(row["kept"])]
                for row in rows
            ],
        )
    return lines


__all__ = [
    "ACCEPTED",
    "AUTO_PRECISION_TARGET",
    "REVIEW_RECALL_TARGET",
    "THRESHOLDS",
    "WRITTEN",
    "PredictedLabel",
    "SampleOutcome",
    "Score",
    "calibration",
    "compare",
    "empty_scores",
    "metadata_accuracy",
    "outcome_counts",
    "primary_accuracy",
    "recommend_thresholds",
    "render_markdown",
    "scheme_scores",
    "summarize",
    "threshold_scores",
]
