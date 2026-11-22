"""Which document answers a starter prompt (rarity-weighted lexical coverage)."""

from __future__ import annotations

from uuid import uuid4

from bomesh.services.library.starters import ANSWERS_AT, Candidate, best_answers, tokens


def test_tokens_fold_diacritics_and_drop_stopwords_and_short_words() -> None:
    assert tokens("Học phí là bao nhiêu? What is đ-a") == {"hoc", "phi", "bao", "nhieu"}


def test_the_best_covering_document_answers_whatever_the_diacritics() -> None:
    tuition = Candidate(uuid4(), "Học phí học kỳ 2025", "Mức học phí và hạn nộp")
    timetable = Candidate(uuid4(), "Lịch học", "Thời khóa biểu các lớp")
    dorm = Candidate(uuid4(), "Ký túc xá", "Đăng ký chỗ ở")
    pool = [timetable, tuition, dorm]
    assert best_answers(pool, ["Học phí năm nay là bao nhiêu?", "hoc phi"]) == [
        tuition.item_id,
        tuition.item_id,
    ]


def test_coverage_below_the_threshold_answers_nothing() -> None:
    assert ANSWERS_AT == 0.2
    only = Candidate(uuid4(), "Leave", None)
    # One title word of four: 2w / 8w = 0.25.
    assert best_answers([only], ["leave balance carry over"]) == [only.item_id]
    # One summary word of three: w / 6w ≈ 0.17.
    summary = Candidate(uuid4(), "Handbook", "leave")
    assert best_answers([summary], ["leave balance carryover"]) == [None]
    # Task-like prompts no document covers.
    assert best_answers([only, summary], ["What did students ask this week?"]) == [None]
    assert best_answers([], ["leave"]) == [None]
