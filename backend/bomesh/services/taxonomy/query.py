"""Query mapping (``conversation_loop.md`` "Knowledge retrieval"): what a search query names in the taxonomy.

A :class:`LabelIndex` is built per published taxonomy (cached by scheme versions)
from every classification scheme's labels, the names of ``query_expansion`` groups
and the org-unit/program authority labels. :func:`interpret` matches it over the
query with an Aho-Corasick automaton on word tokens (longest match first, no
overlaps); a query written mostly without diacritics is matched a second time on
its folded form for the spans the first pass left. A label shared by several
classification schemes is resolved deterministically:

1. when the query already names a concept of scheme S, the shared label means a
   scheme other than S ("**quy định** làm khóa luận": T is named, so "khóa luận"
   is F);
2. when it names a ``domain`` concept and no ``document-type`` one, the shared label
   prefers ``document-type`` (looking for *documents* about a subject);
3. otherwise it stays an :class:`Ambiguity` whose options the search answers as
   separate groups.

A concept in a ``query_expansion`` group stands for every member of the group
("quy định" → {Quy chế, Quy định, Hướng dẫn}).
"""

from __future__ import annotations

import re
import unicodedata
from collections import deque
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from uuid import UUID

from bomesh.services.taxonomy.authority import AUTHORITY_SCHEMES
from bomesh.services.taxonomy.normalize import fold, normalize_label
from bomesh.services.taxonomy.snapshot import SchemeSnapshot, TaxonomySnapshot

#: Scheme codes rule 2 refers to (the university template's D and T).
DOMAIN_SCHEME = "domain"
DOCUMENT_TYPE_SCHEME = "document-type"
#: Options of one ambiguity a search answers as groups.
MAX_OPTIONS = 3
#: A query is "mostly without diacritics" when fewer than this share of its words carry one.
_ACCENTED_SHARE = 0.25
_WORD = re.compile(r"\w+")
#: Phrases asking for history: superseded documents are then not demoted (§8.5).
_HISTORY_PHRASES = (
    "lịch sử",
    "bản cũ",
    "văn bản cũ",
    "phiên bản cũ",
    "trước đây",
    "bị thay thế",
    "đã thay thế",
    "hết hiệu lực",
    "history",
    "previous version",
    "old version",
    "superseded",
)


@dataclass(frozen=True, slots=True)
class InterpretedTerm:
    """A span of the query read as concepts of one scheme (OR, group expansion included)."""

    text: str
    scheme: str
    concepts: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class Option:
    """One reading of an ambiguous span: the span as concepts of ``scheme``."""

    scheme: str
    concepts: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class Ambiguity:
    text: str
    options: tuple[Option, ...]


@dataclass(frozen=True, slots=True)
class Interpretation:
    """What one query names. ``authorities`` are the org-unit/program concepts it names."""

    terms: tuple[InterpretedTerm, ...] = ()
    ambiguities: tuple[Ambiguity, ...] = ()
    authorities: frozenset[UUID] = frozenset()
    asks_history: bool = False

    @property
    def empty(self) -> bool:
        return not self.terms and not self.ambiguities and not self.authorities

    def options(self) -> tuple[Option, ...]:
        """The options answered as groups: the first ambiguity's (one ambiguity is grouped)."""
        return self.ambiguities[0].options if self.ambiguities else ()

    def facets(self, option: Option | None = None) -> dict[str, frozenset[UUID]]:
        """Scheme → concepts the query asks for (OR within a scheme, AND across schemes),
        with ``option`` chosen for the grouped ambiguity."""
        facets: dict[str, set[UUID]] = {}
        for term in self.terms:
            facets.setdefault(term.scheme, set()).update(term.concepts)
        if option is not None:
            facets.setdefault(option.scheme, set()).update(option.concepts)
        return {scheme: frozenset(concepts) for scheme, concepts in facets.items()}


# -- Label index ------------------------------------------------------------------------


@dataclass(slots=True)
class _Targets:
    #: classification scheme code → concepts (before group expansion)
    concepts: dict[str, set[UUID]] = field(default_factory=dict)
    authorities: set[UUID] = field(default_factory=set)


class _Automaton:
    """Aho-Corasick over word tokens; reports every (start, end, pattern) occurrence."""

    def __init__(self, patterns: Iterable[tuple[str, ...]]) -> None:
        self._goto: list[dict[str, int]] = [{}]
        self._fail: list[int] = [0]
        self._out: list[list[tuple[str, ...]]] = [[]]
        for pattern in patterns:
            state = 0
            for token in pattern:
                following = self._goto[state].get(token)
                if following is None:
                    following = len(self._goto)
                    self._goto[state][token] = following
                    self._goto.append({})
                    self._fail.append(0)
                    self._out.append([])
                state = following
            self._out[state].append(pattern)
        queue = deque(self._goto[0].values())
        while queue:
            state = queue.popleft()
            for token, following in self._goto[state].items():
                queue.append(following)
                fallback = self._fail[state]
                while fallback and token not in self._goto[fallback]:
                    fallback = self._fail[fallback]
                candidate = self._goto[fallback].get(token, 0)
                self._fail[following] = candidate if candidate != following else 0
                self._out[following].extend(self._out[self._fail[following]])

    def matches(self, tokens: Sequence[str]) -> list[tuple[int, int, tuple[str, ...]]]:
        found: list[tuple[int, int, tuple[str, ...]]] = []
        state = 0
        for position, token in enumerate(tokens):
            while state and token not in self._goto[state]:
                state = self._fail[state]
            state = self._goto[state].get(token, 0)
            for pattern in self._out[state]:
                found.append((position + 1 - len(pattern), position + 1, pattern))
        return found


def _tokens(text: str) -> tuple[str, ...]:
    return tuple(_WORD.findall(normalize_label(text)))


class LabelIndex:
    """Published labels → concepts, on normalized and folded word tokens."""

    def __init__(self, taxonomy: TaxonomySnapshot) -> None:
        self.taxonomy = taxonomy
        normalized: dict[tuple[str, ...], _Targets] = {}
        folded: dict[tuple[str, ...], _Targets] = {}
        #: scheme code → concept → the members of its query_expansion groups
        self._expansion: dict[str, dict[UUID, set[UUID]]] = {}
        for scheme in taxonomy.schemes.values():
            classification = scheme.purpose == "classification"
            if not classification and scheme.code not in AUTHORITY_SCHEMES:
                continue
            for concept in scheme.concepts.values():
                if concept.state != "published":
                    continue
                texts = [
                    *concept.pref_labels.values(),
                    *(text for _, text in concept.alt_labels),
                    *(text for _, text in concept.hidden_labels),
                ]
                for text in texts:
                    self._add(normalized, folded, text, scheme, [concept.id], classification)
            if classification:
                self._groups(scheme, normalized, folded)
        self._normalized = normalized
        self._folded = folded
        self._automaton = _Automaton(normalized)
        self._folded_automaton = _Automaton(folded)

    def _groups(
        self,
        scheme: SchemeSnapshot,
        normalized: dict[tuple[str, ...], _Targets],
        folded: dict[tuple[str, ...], _Targets],
    ) -> None:
        expansion = self._expansion.setdefault(scheme.code, {})
        for group in scheme.groups:
            if not group.query_expansion:
                continue
            members = [
                member
                for member in group.members
                if member in scheme.concepts and scheme.concepts[member].state == "published"
            ]
            for member in members:
                expansion.setdefault(member, set()).update(members)
            if members:
                self._add(normalized, folded, group.name, scheme, members, True)

    @staticmethod
    def _add(
        normalized: dict[tuple[str, ...], _Targets],
        folded: dict[tuple[str, ...], _Targets],
        text: str,
        scheme: SchemeSnapshot,
        concepts: Sequence[UUID],
        classification: bool,
    ) -> None:
        tokens = _tokens(text)
        if not tokens:
            return
        for index, key in ((normalized, tokens), (folded, tuple(fold(t) for t in tokens))):
            targets = index.setdefault(key, _Targets())
            if classification:
                targets.concepts.setdefault(scheme.code, set()).update(concepts)
            else:
                targets.authorities.update(concepts)

    def expand(self, scheme: str, concepts: Iterable[UUID]) -> tuple[UUID, ...]:
        """``concepts`` with every member of their ``query_expansion`` groups, by notation."""
        expansion = self._expansion.get(scheme, {})
        found: set[UUID] = set()
        for concept in concepts:
            found.add(concept)
            found.update(expansion.get(concept, ()))
        snapshot = self.taxonomy.schemes[scheme]
        return tuple(sorted(found, key=lambda cid: snapshot.concepts[cid].notation))

    def spans(self, query: str) -> list[tuple[str, _Targets]]:
        """The matched spans of ``query`` in order: (surface text, targets)."""
        text = unicodedata.normalize("NFC", query)
        words = list(_WORD.finditer(text))
        tokens = [normalize_label(match.group()) for match in words]
        chosen = _longest(self._automaton.matches(tokens), taken=set())
        found = [(start, end, self._normalized[pattern]) for start, end, pattern in chosen]
        if tokens and _mostly_unaccented(tokens):
            taken = {position for start, end, _ in found for position in range(start, end)}
            folded_tokens = [fold(token) for token in tokens]
            for start, end, pattern in _longest(
                self._folded_automaton.matches(folded_tokens), taken=taken
            ):
                found.append((start, end, self._folded[pattern]))
        found.sort(key=lambda span: span[0])
        return [
            (text[words[start].start() : words[end - 1].end()], targets)
            for start, end, targets in found
        ]


def _longest(
    matches: list[tuple[int, int, tuple[str, ...]]], *, taken: set[int]
) -> list[tuple[int, int, tuple[str, ...]]]:
    """Longest matches first, then leftmost; a match overlapping a kept one is dropped."""
    kept: list[tuple[int, int, tuple[str, ...]]] = []
    for start, end, pattern in sorted(matches, key=lambda m: (m[0] - m[1], m[0])):
        if any(position in taken for position in range(start, end)):
            continue
        taken.update(range(start, end))
        kept.append((start, end, pattern))
    return kept


def _mostly_unaccented(tokens: Sequence[str]) -> bool:
    accented = sum(1 for token in tokens if fold(token) != token)
    return accented < _ACCENTED_SHARE * len(tokens)


_INDEXES: dict[tuple[tuple[UUID, int], ...], LabelIndex] = {}
_INDEX_CACHE_SIZE = 64


def label_index(taxonomy: TaxonomySnapshot) -> LabelIndex:
    """The index of a published taxonomy; cached in-process by (scheme, version) set."""
    key = tuple(
        sorted((scheme.scheme_id, scheme.version) for scheme in taxonomy.schemes.values())
    )
    index = _INDEXES.get(key)
    if index is None:
        if len(_INDEXES) >= _INDEX_CACHE_SIZE:
            _INDEXES.pop(next(iter(_INDEXES)))
        index = _INDEXES[key] = LabelIndex(taxonomy)
    return index


# -- Interpretation -----------------------------------------------------------------------


def interpret(index: LabelIndex, query: str) -> Interpretation:
    """What ``query`` names, cross-scheme labels resolved by §8.2's rules (in order)."""
    spans = index.spans(query)
    authorities: set[UUID] = set()
    resolved: list[tuple[int, str, str, set[UUID]]] = []
    pending: list[tuple[int, str, dict[str, set[UUID]]]] = []
    for position, (text, targets) in enumerate(spans):
        authorities.update(targets.authorities)
        if len(targets.concepts) == 1:
            ((scheme, concepts),) = targets.concepts.items()
            resolved.append((position, text, scheme, concepts))
        elif targets.concepts:
            pending.append((position, text, targets.concepts))
    # Each round resolves what the schemes named so far decide; repeat until stable.
    changed = True
    while pending and changed:
        changed = False
        named = {scheme for _, _, scheme, _ in resolved}
        still: list[tuple[int, str, dict[str, set[UUID]]]] = []
        decided: list[tuple[int, str, str, set[UUID]]] = []
        for position, text, candidates in pending:
            narrowed = _narrowed(candidates, named)
            scheme = _decide(narrowed, named)
            if scheme is None:
                still.append((position, text, narrowed))
            else:
                decided.append((position, text, scheme, narrowed[scheme]))
        if decided:
            resolved.extend(decided)
            changed = True
        pending = still
    resolved.sort(key=lambda entry: entry[0])
    terms = tuple(
        InterpretedTerm(text=text, scheme=scheme, concepts=index.expand(scheme, concepts))
        for _, text, scheme, concepts in resolved
    )
    ambiguities = tuple(
        Ambiguity(
            text=text,
            options=tuple(
                Option(scheme=scheme, concepts=index.expand(scheme, candidates[scheme]))
                for scheme in _ordered(index.taxonomy, candidates)[:MAX_OPTIONS]
            ),
        )
        for _, text, candidates in sorted(pending, key=lambda entry: entry[0])
    )
    normalized = " ".join(_tokens(query))
    folded = fold(normalized)
    asks_history = any(
        _contains(normalized, phrase) or _contains(folded, fold(phrase))
        for phrase in _HISTORY_PHRASES
    )
    return Interpretation(
        terms=terms,
        ambiguities=ambiguities,
        authorities=frozenset(authorities),
        asks_history=asks_history,
    )


def _narrowed(candidates: dict[str, set[UUID]], named: set[str]) -> dict[str, set[UUID]]:
    """Rule 1: a shared label means a scheme the query does not name already (when one is left)."""
    others = {scheme: ids for scheme, ids in candidates.items() if scheme not in named}
    return others or candidates


def _decide(candidates: Mapping[str, set[UUID]], named: set[str]) -> str | None:
    """The scheme a (narrowed) shared label means, or None while it stays ambiguous."""
    if len(candidates) == 1:
        return next(iter(candidates))  # rule 1
    if DOMAIN_SCHEME in named and DOCUMENT_TYPE_SCHEME not in named and (
        DOCUMENT_TYPE_SCHEME in candidates
    ):
        return DOCUMENT_TYPE_SCHEME  # rule 2
    return None


def _ordered(taxonomy: TaxonomySnapshot, candidates: Mapping[str, set[UUID]]) -> list[str]:
    """Options in scheme tab order."""
    return sorted(
        candidates,
        key=lambda code: (
            taxonomy.schemes[code].position if code in taxonomy.schemes else 0,
            code,
        ),
    )


def _contains(text: str, phrase: str) -> bool:
    return f" {phrase} " in f" {text} "


__all__ = [
    "DOCUMENT_TYPE_SCHEME",
    "DOMAIN_SCHEME",
    "MAX_OPTIONS",
    "Ambiguity",
    "InterpretedTerm",
    "Interpretation",
    "LabelIndex",
    "Option",
    "interpret",
    "label_index",
]
