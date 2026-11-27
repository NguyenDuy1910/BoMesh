"""Label normalization: the ``concept_labels.normalized`` key and its diacritic-free fold."""

from __future__ import annotations

import re
import unicodedata

#: Combining tone marks (grave, acute, tilde, hook above, dot below); other
#: marks (circumflex, breve, horn) are part of the vowel letter.
_TONES = frozenset("\u0300\u0301\u0303\u0309\u0323")
_WORD = re.compile(r"\w+")
#: Open-syllable diphthongs whose tone placement varies between spelling styles.
_DIPHTHONGS = ("oa", "oe", "uy")


def _is_edge_noise(character: str) -> bool:
    category = unicodedata.category(character)
    return category[0] in "PSZ" or category == "Cc"


def _place_tone(word: str) -> str:
    """Put the tone of a word ending in open ``oa``/``oe``/``uy`` on the first vowel.

    ``khoá`` → ``khóa``, ``hoạ`` → ``họa``, ``thuỷ`` → ``thủy``. Words with a
    final consonant (``hoàng``), ``qu`` + vowel (``quý``) and other vowels are
    left unchanged.
    """

    letters: list[list[str]] = []
    for character in unicodedata.normalize("NFD", word):
        if unicodedata.combining(character) and letters:
            letters[-1].append(character)
        else:
            letters.append([character])
    if len(letters) < 2:
        return word
    base = "".join(letter[0] for letter in letters)
    first, second = letters[-2], letters[-1]
    if (
        base[-2:] not in _DIPHTHONGS
        or any(mark not in _TONES for mark in first[1:] + second[1:])
        or (len(base) > 2 and base[-3] in "qaeiouy")
    ):
        return word
    tones = [mark for mark in first[1:] + second[1:]]
    if len(tones) != 1:
        return word
    letters[-2] = [first[0], tones[0]]
    letters[-1] = [second[0]]
    return unicodedata.normalize("NFC", "".join("".join(letter) for letter in letters))


def normalize_label(text: str) -> str:
    """NFC, casefolded, whitespace collapsed, surrounding punctuation stripped.

    Diacritics are kept (``khoa`` and ``khóa`` stay distinct), but the tone of
    an open ``oa``/``oe``/``uy`` syllable is moved onto its first vowel, so
    old- and new-style spellings agree: ``khoá`` = ``khóa``, ``hoà`` = ``hòa``,
    ``thuỷ`` = ``thủy``. ``qu``/``gi`` + vowel and closed syllables are untouched.
    """

    folded = unicodedata.normalize("NFC", unicodedata.normalize("NFC", text).casefold())
    collapsed = " ".join(folded.split())
    start, end = 0, len(collapsed)
    while start < end and _is_edge_noise(collapsed[start]):
        start += 1
    while end > start and _is_edge_noise(collapsed[end - 1]):
        end -= 1
    return _WORD.sub(lambda match: _place_tone(match.group()), collapsed[start:end])


def fold(text: str) -> str:
    """:func:`normalize_label` without diacritics (``đ`` → ``d``), for accent-insensitive matching."""

    decomposed = unicodedata.normalize("NFD", normalize_label(text).replace("đ", "d"))
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", stripped)
