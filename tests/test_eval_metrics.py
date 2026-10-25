from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from eval.matching import contains_quote
from eval.metrics import (
    binary_ndcg_at_k,
    hit_at_k,
    ndcg_at_k,
    percentile,
    precision_at_k,
    recall_at_k,
    reciprocal_rank,
)
from eval.report import summarize

NONE: frozenset[int] = frozenset()


def gold(*indexes: int) -> frozenset[int]:
    return frozenset(indexes)


class TestContainsQuote:
    def test_matches_across_case_whitespace_and_unicode_composition(self) -> None:
        # "ệ" precomposed in the passage, decomposed (e + combining marks) in the quote.
        passage = "Lệ phí   làm bằng\ntốt nghiệp là 50.000 đồng."
        quote = "LE\u0323\u0302 PHÍ làm bằng tốt nghiệp"
        assert contains_quote(passage, quote)

    def test_tolerates_small_extraction_noise_in_order(self) -> None:
        passage = "Sinh viên nhận bằng tại Phòng Đào tạo A1-201, lầu 2 tòa nhà trung tâm"
        quote = "Sinh viên nhận bằng tại Phòng Đào tạo (A1-201) – lầu 2, tòa nhà trung tâm"
        assert contains_quote(passage, quote)

    def test_shared_vocabulary_in_another_order_is_not_the_quote(self) -> None:
        passage = "tâm trung nhà tòa 2 lầu A1-201 tạo Đào Phòng tại bằng nhận viên Sinh"
        quote = "Sinh viên nhận bằng tại Phòng Đào tạo A1-201 lầu 2 tòa nhà trung tâm"
        assert not contains_quote(passage, quote)

    def test_partial_quote_below_coverage_does_not_match(self) -> None:
        passage = "Lịch thi chính thức từ ngày 28/05/2018"
        quote = "Lịch thi chính thức từ ngày 28/05/2018 đến ngày 20/06/2018 cho mọi khóa"
        assert not contains_quote(passage, quote)


class TestRankingMetrics:
    def test_recall_counts_each_gold_evidence_once(self) -> None:
        matches = [gold(0), gold(0), NONE, gold(1)]
        assert recall_at_k(matches, 2, 2) == 0.5
        assert recall_at_k(matches, 2, 4) == 1.0

    def test_precision_counts_missing_slots_as_not_relevant(self) -> None:
        assert precision_at_k([gold(0)], 5) == pytest.approx(0.2)

    def test_hit_and_reciprocal_rank_use_first_relevant_rank(self) -> None:
        matches = [NONE, NONE, gold(0)]
        assert hit_at_k(matches, 2) == 0.0
        assert hit_at_k(matches, 3) == 1.0
        assert reciprocal_rank(matches) == pytest.approx(1 / 3)
        assert reciprocal_rank([NONE, NONE]) == 0.0

    def test_binary_ndcg_stays_within_one_when_duplicates_carry_the_quote(self) -> None:
        # Two copies of the same notice both carry the single gold quote.
        assert binary_ndcg_at_k([gold(0), gold(0)], 1, 5) == pytest.approx(1.0)
        assert binary_ndcg_at_k([NONE, gold(0)], 1, 5) < 1.0

    def test_graded_ndcg_is_normalized_by_the_best_known_ordering(self) -> None:
        assert ndcg_at_k([2.0, 1.0, 0.0], 3, ideal=[0.0, 1.0, 2.0]) == pytest.approx(1.0)
        assert ndcg_at_k([0.0, 1.0, 2.0], 3, ideal=[2.0, 1.0, 0.0]) < 1.0
        assert ndcg_at_k([0.0], 3, ideal=[0.0]) == 0.0

    def test_percentile_interpolates(self) -> None:
        assert percentile([10.0, 20.0, 30.0, 40.0], 50) == pytest.approx(25.0)
        assert percentile([], 95) is None


def test_summary_excludes_failed_probes_and_sums_leak_violations() -> None:
    rows = [
        {"variant": "v", "stage": "final", "type": "factual", "empty": False, "recall@6": 1.0},
        {"variant": "v", "stage": "final", "type": "factual", "empty": False, "recall@6": 0.0},
        {"variant": "v", "stage": "final", "type": "unanswerable", "empty": True},
        {"variant": "v", "stage": "final", "type": "factual", "error": "timeout"},
        {"variant": "v", "stage": "leak_tenant", "type": "factual",
         "index_violations": 2, "retriever_violations": 0},
        {"variant": "v", "stage": "leak_tenant", "type": "factual",
         "index_violations": 1, "retriever_violations": 1},
    ]
    summary = summarize(rows, {"v": {"final_top_k": 6}})
    final = summary["stages"]["v"]["final"]
    assert final["n"] == 3
    assert final["errors"] == 1
    assert final["recall@6"] == pytest.approx(0.5)
    assert final["unanswerable_empty"] == 1.0
    assert final["answerable_empty"] == 0.0
    leak = summary["stages"]["v"]["leak_tenant"]
    assert leak["index_violations"] == 3
    assert leak["retriever_violations"] == 1
