"""Decide whether a retrieved passage carries a gold evidence quote.

Gold evidence is a verbatim quote, not a chunk id: point ids derive from the
chunk index, so any chunker change would silently invalidate id-based labels.
A quote also credits an identical passage in a re-uploaded duplicate document,
which is a correct retrieval.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

_TOKEN = re.compile(r"\w+", re.UNICODE)

#: Share of the quote's tokens that must appear, in order, inside the passage.
DEFAULT_MIN_COVERAGE = 0.8


def normalize(text: str) -> str:
    """NFC, case-folded, whitespace-collapsed text for comparison."""

    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def tokens(text: str) -> list[str]:
    return _TOKEN.findall(normalize(text))


def contains_quote(
    passage: str, quote: str, *, min_coverage: float = DEFAULT_MIN_COVERAGE
) -> bool:
    """True when ``passage`` holds ``quote`` verbatim or nearly so.

    The ordered-token fallback absorbs extraction noise (hyphenation,
    punctuation, line breaks) without crediting a passage that merely shares
    vocabulary with the quote.
    """

    normalized_quote = normalize(quote)
    if not normalized_quote:
        return False
    if normalized_quote in normalize(passage):
        return True
    quote_tokens = tokens(quote)
    if not quote_tokens:
        return False
    matcher = SequenceMatcher(None, quote_tokens, tokens(passage), autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return matched / len(quote_tokens) >= min_coverage


def matched_gold(passage: str, quotes: list[str]) -> frozenset[int]:
    """Indexes of the gold quotes this passage carries."""

    return frozenset(
        index for index, quote in enumerate(quotes) if contains_quote(passage, quote)
    )


__all__ = ["DEFAULT_MIN_COVERAGE", "contains_quote", "matched_gold", "normalize", "tokens"]
