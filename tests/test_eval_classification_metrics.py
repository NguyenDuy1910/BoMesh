from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from eval.classification.labels import (
    LABELS_FILE,
    LabeledSample,
    load_labels,
    parse_sample,
    suite_directory,
)
from eval.classification.metrics import (
    ACCEPTED,
    THRESHOLDS,
    WRITTEN,
    PredictedLabel,
    SampleOutcome,
    Score,
    calibration,
    compare,
    empty_scores,
    metadata_accuracy,
    outcome_counts,
    primary_accuracy,
    recommend_thresholds,
    render_markdown,
    scheme_scores,
    summarize,
)


def sample(
    sample_id: str = "s1",
    *,
    labels: dict[str, set[str]] | None = None,
    primary: dict[str, str] | None = None,
    empty: set[str] | None = None,
    metadata: dict[str, object] | None = None,
) -> LabeledSample:
    return LabeledSample(
        id=sample_id,
        title=sample_id,
        text="text",
        labels={scheme: frozenset(values) for scheme, values in (labels or {}).items()},
        primary=primary or {},
        empty=frozenset(empty or ()),
        metadata=metadata or {},
    )


def label(notation: str, confidence: float, state: str = "accepted", *, primary: bool = False) -> PredictedLabel:
    return PredictedLabel(notation=notation, confidence=confidence, state=state, primary=primary)


class TestLabels:
    def test_example_suite_parses(self) -> None:
        samples = load_labels(suite_directory("example") / LABELS_FILE)

        assert len(samples) == 3
        first = samples[0]
        assert first.labels["document-type"] == frozenset({"quyet-dinh"})
        assert first.primary == {"document-type": "quyet-dinh"}
        assert first.schemes == frozenset({"document-type", "function", "audience", "domain"})
        assert samples[2].metadata["cohorts"] == (2022,)

    def test_path_is_relative_to_the_suite(self, tmp_path: Path) -> None:
        parsed = parse_sample({"id": "a", "title": "A", "path": "files/a.pdf"}, base=tmp_path)

        assert parsed.path == tmp_path / "files" / "a.pdf"
        assert parsed.text is None

    @pytest.mark.parametrize(
        ("record", "message"),
        [
            ({"id": "a", "title": "A"}, "exactly one of text and path"),
            ({"id": "a", "title": "A", "text": "t", "path": "p"}, "exactly one of text and path"),
            ({"id": "a", "title": "A", "text": "t", "labels": {"d": ["x"]}, "primary": {"d": "y"}}, "not one of its labels"),
            ({"id": "a", "title": "A", "text": "t", "labels": {"d": ["x"]}, "empty": ["d"]}, "both labeled and empty"),
            ({"id": "a", "title": "A", "text": "t", "metadata": {"author": "x"}}, "unknown metadata"),
        ],
    )
    def test_rejects_malformed_samples(self, record: dict[str, object], message: str, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match=message):
            parse_sample(record, base=tmp_path)

    def test_duplicate_ids_name_the_line(self, tmp_path: Path) -> None:
        path = tmp_path / "labels.jsonl"
        line = '{"id": "a", "title": "A", "text": "t"}\n'
        path.write_text(line + line, "utf-8")

        with pytest.raises(ValueError, match=r"labels.jsonl:2: duplicate id"):
            load_labels(path)


class TestScores:
    def test_compare_counts_set_overlap(self) -> None:
        assert compare({"a", "b"}, {"b", "c", "d"}) == Score(tp=1, fp=1, fn=2)

    def test_precision_and_recall_are_none_without_denominator(self) -> None:
        assert Score().precision is None
        assert Score().recall is None
        assert Score(tp=1, fp=3, fn=1).precision == 0.25
        assert Score(tp=1, fp=3, fn=1).recall == 0.5

    def test_accepted_and_suggested_levels(self) -> None:
        outcome = SampleOutcome(
            sample=sample(labels={"domain": {"it-ai", "it-khdl"}}),
            written={"domain": (label("it-ai", 0.95), label("it-khdl", 0.6, "suggested"), label("it-mang", 0.55, "suggested"))},
        )

        accepted = scheme_scores([outcome], states=ACCEPTED)["domain"]
        written = scheme_scores([outcome], states=WRITTEN)["domain"]

        assert (accepted.tp, accepted.fp, accepted.fn) == (1, 0, 1)
        assert (written.tp, written.fp, written.fn) == (2, 1, 0)

    def test_only_judged_schemes_count_and_errors_are_skipped(self) -> None:
        judged = SampleOutcome(
            sample=sample(labels={"domain": {"it-ai"}}),
            written={"domain": (label("it-ai", 0.95),), "function": (label("dt-hoc-lieu", 1.0),)},
        )
        failed = SampleOutcome(sample=sample("s2", labels={"domain": {"it-mang"}}), error="FileNoTextError: …")

        scores = scheme_scores([judged, failed], states=ACCEPTED)

        assert set(scores) == {"domain"}
        assert scores["domain"] == Score(tp=1)

    def test_empty_scheme_prediction_is_a_false_positive(self) -> None:
        outcome = SampleOutcome(
            sample=sample(empty={"domain"}),
            written={"domain": (label("it-ai", 0.92),)},
            outcomes={"domain": "assigned"},
        )

        assert scheme_scores([outcome], states=ACCEPTED)["domain"] == Score(fp=1)


class TestCalibration:
    def outcomes(self) -> list[SampleOutcome]:
        return [
            SampleOutcome(
                sample=sample("a", labels={"domain": {"x"}}),
                scored={"domain": (label("x", 0.92), label("y", 0.42, "suggested"))},
            ),
            SampleOutcome(
                sample=sample("b", labels={"domain": {"z"}}),
                scored={"domain": (label("z", 0.61, "suggested"), label("w", 0.36, "suggested"))},
            ),
        ]

    def test_thresholds_span_030_to_099(self) -> None:
        assert THRESHOLDS[0] == 0.30
        assert THRESHOLDS[-2:] == (0.95, 0.99)
        assert len(THRESHOLDS) == 15

    def test_table_counts_labels_at_or_above_each_threshold(self) -> None:
        rows = {row["threshold"]: row for row in calibration(self.outcomes())["domain"]}

        assert rows[0.35] == {"threshold": 0.35, "precision": 0.5, "recall": 1.0, "kept": 4}
        assert rows[0.6] == {"threshold": 0.6, "precision": 1.0, "recall": 1.0, "kept": 2}
        assert rows[0.95] == {"threshold": 0.95, "precision": None, "recall": 0.0, "kept": 0}

    def test_recommends_lowest_precise_auto_and_highest_recalling_review(self) -> None:
        recommended = recommend_thresholds(calibration(self.outcomes()))

        # precision ≥ 0.95 first reached at 0.45 (x and z kept); recall ≥ 0.9 last holds at 0.60,
        # above auto, so review is clamped to auto.
        assert recommended == {"domain": {"auto": 0.45, "review": 0.45}}

    def test_review_is_never_above_auto_and_unreached_targets_are_none(self) -> None:
        table = {
            "a": [
                {"threshold": 0.5, "precision": 0.96, "recall": 1.0},
                {"threshold": 0.9, "precision": 0.99, "recall": 0.95},
            ],
            "b": [{"threshold": 0.5, "precision": 0.5, "recall": 0.5}],
        }

        assert recommend_thresholds(table) == {
            "a": {"auto": 0.5, "review": 0.5},
            "b": {"auto": None, "review": None},
        }


class TestOutcomes:
    def test_primary_accuracy_reads_accepted_document_primary(self) -> None:
        right = SampleOutcome(
            sample=sample("a", labels={"domain": {"x", "y"}}, primary={"domain": "x"}),
            written={"domain": (label("x", 0.95, primary=True), label("y", 0.9))},
        )
        suggested = SampleOutcome(
            sample=sample("b", labels={"domain": {"x"}}, primary={"domain": "x"}),
            written={"domain": (label("x", 0.7, "suggested", primary=True),)},
        )

        assert primary_accuracy([right, suggested]) == {"domain": {"total": 2, "correct": 1, "accuracy": 0.5}}

    def test_empty_scores_and_outcome_counts(self) -> None:
        outcomes = [
            SampleOutcome(sample=sample("a", empty={"domain"}), outcomes={"domain": "empty"}),
            SampleOutcome(sample=sample("b", empty={"domain"}), outcomes={"domain": "uncertain"}),
            SampleOutcome(sample=sample("c", labels={"domain": {"x"}}), outcomes={"domain": "empty"}),
        ]

        assert empty_scores(outcomes) == {"domain": {"gold_empty": 2, "correct_empty": 1, "false_empty": 1}}
        assert outcome_counts(outcomes) == {"domain": {"empty": 2, "uncertain": 1}}

    def test_metadata_accuracy_normalizes_strings_and_lists(self) -> None:
        outcomes = [
            SampleOutcome(
                sample=sample(
                    "a",
                    metadata={"number": "456/QĐ-ĐHCNKT-CTSV", "cohorts": (2022, 2023), "issuer": "phong-ctsv"},
                ),
                metadata={"number": "456/qđ-đhcnkt-ctsv ", "cohorts": (2023, 2022), "issuer": "phong-dao-tao"},
            ),
            SampleOutcome(sample=sample("b", metadata={"number": "78/TB-ĐHCNKT-ĐT"})),
        ]

        accuracy = metadata_accuracy(outcomes)

        assert accuracy["number"] == {"total": 2, "correct": 1, "missing": 1, "accuracy": 0.5}
        assert accuracy["cohorts"]["accuracy"] == 1.0
        assert accuracy["issuer"]["accuracy"] == 0.0
        assert "issue_date" not in accuracy


def test_summary_and_markdown_cover_every_section() -> None:
    outcomes = [
        SampleOutcome(
            sample=sample("a", labels={"domain": {"x"}}, primary={"domain": "x"}, metadata={"level": "program"}),
            written={"domain": (label("x", 0.95, primary=True),)},
            scored={"domain": (label("x", 0.95, primary=True),)},
            outcomes={"domain": "assigned"},
            metadata={"level": "program"},
            model_called=True,
        ),
        SampleOutcome(sample=sample("b"), error="FileNoTextError: no text"),
    ]

    summary = summarize(outcomes)
    markdown = "\n".join(render_markdown(summary))

    assert summary["samples"] == 2
    assert summary["errors"] == 1
    assert summary["model_calls"] == 1
    assert summary["schemes"]["domain"]["accepted"]["precision"] == 1.0
    assert summary["recommended_thresholds"]["domain"] == {"auto": 0.3, "review": 0.3}
    for heading in ("## Labels per scheme", "## Outcomes", "## Metadata", "## Threshold calibration", "### domain"):
        assert heading in markdown
