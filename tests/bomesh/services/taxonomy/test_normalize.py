"""Vietnamese tone placement in label normalization."""

from __future__ import annotations

import pytest

from bomesh.services.taxonomy.normalize import fold, normalize_label


@pytest.mark.parametrize(
    ("old", "new"),
    [("khoá", "khóa"), ("hoà", "hòa"), ("thuỷ", "thủy"), ("hoạ", "họa"), ("Khoẻ", "khỏe")],
)
def test_old_and_new_tone_placement_normalize_equal(old: str, new: str) -> None:
    assert normalize_label(old) == normalize_label(new) == new.lower()
    assert normalize_label(f"Học {old} 2024") == f"học {new.lower()} 2024"
    assert fold(old) == fold(new)


@pytest.mark.parametrize("word", ["quý", "quỳnh", "hoàng", "toán", "khoa", "thuyền", "giá"])
def test_other_syllables_are_unchanged(word: str) -> None:
    assert normalize_label(word) == word


def test_diacritics_still_distinguish() -> None:
    assert normalize_label("khoa") != normalize_label("khóa")
