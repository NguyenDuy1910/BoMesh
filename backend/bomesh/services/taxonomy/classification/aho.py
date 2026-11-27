"""Aho-Corasick over normalized labels: every label occurrence in one pass.

Built once per classification plan. Text and labels are both
``normalize_label`` output; a match must start and end at a word boundary
(letters with Vietnamese diacritics, digits and ``_`` are word characters),
and overlapping matches resolve to the longest, then the leftmost.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Hashable, Iterable
from dataclasses import dataclass
from typing import Generic, TypeVar

P = TypeVar("P", bound=Hashable)


def _is_word(character: str) -> bool:
    return character.isalnum() or character == "_"


@dataclass(frozen=True, slots=True)
class Match(Generic[P]):
    start: int
    end: int
    label: str
    payloads: tuple[P, ...]


class AhoCorasick(Generic[P]):
    """Automaton over ``(label, payload)`` pairs; one label may carry several payloads."""

    __slots__ = ("_goto", "_fail", "_out", "_labels", "_payloads")

    def __init__(self, entries: Iterable[tuple[str, P]]) -> None:
        payloads: dict[str, list[P]] = {}
        for label, payload in entries:
            if not label:
                continue
            bucket = payloads.setdefault(label, [])
            if payload not in bucket:
                bucket.append(payload)
        self._labels: list[str] = list(payloads)
        self._payloads: list[tuple[P, ...]] = [tuple(payloads[label]) for label in self._labels]
        self._goto: list[dict[str, int]] = [{}]
        #: Per state, the label indexes ending there (own and via fail links).
        self._out: list[list[int]] = [[]]
        for index, label in enumerate(self._labels):
            state = 0
            for character in label:
                following = self._goto[state].get(character)
                if following is None:
                    following = len(self._goto)
                    self._goto[state][character] = following
                    self._goto.append({})
                    self._out.append([])
                state = following
            self._out[state].append(index)
        self._fail = [0] * len(self._goto)
        queue: deque[int] = deque(self._goto[0].values())
        while queue:
            state = queue.popleft()
            for character, following in self._goto[state].items():
                queue.append(following)
                fallback = self._fail[state]
                while fallback and character not in self._goto[fallback]:
                    fallback = self._fail[fallback]
                target = self._goto[fallback].get(character, 0)
                self._fail[following] = target if target != following else 0
                self._out[following] = self._out[following] + self._out[self._fail[following]]

    def __len__(self) -> int:
        return len(self._labels)

    def find_all(self, text: str) -> list[Match[P]]:
        """Every word-bounded occurrence, overlaps included."""

        found: list[Match[P]] = []
        state = 0
        for position, character in enumerate(text):
            while state and character not in self._goto[state]:
                state = self._fail[state]
            state = self._goto[state].get(character, 0)
            for index in self._out[state]:
                label = self._labels[index]
                start = position + 1 - len(label)
                end = position + 1
                if _is_word(label[0]) and start > 0 and _is_word(text[start - 1]):
                    continue
                if _is_word(label[-1]) and end < len(text) and _is_word(text[end]):
                    continue
                found.append(Match(start, end, label, self._payloads[index]))
        return found

    def find(self, text: str) -> list[Match[P]]:
        """Non-overlapping occurrences, longest first then leftmost, in text order."""

        if not self._labels:
            return []
        candidates = sorted(self.find_all(text), key=lambda match: (match.start - match.end, match.start))
        taken = bytearray(len(text))
        chosen: list[Match[P]] = []
        for match in candidates:
            if any(taken[match.start : match.end]):
                continue
            taken[match.start : match.end] = b"\x01" * (match.end - match.start)
            chosen.append(match)
        chosen.sort(key=lambda match: match.start)
        return chosen


__all__ = ["AhoCorasick", "Match"]
