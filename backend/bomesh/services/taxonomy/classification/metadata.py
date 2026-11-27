"""Issuance and applicability read from a Document's text by rules (design §7).

Vietnamese administrative documents follow NĐ 30/2020: a header naming the
issuing unit, ``Số: 123/QĐ-ĐHCNKT-ĐT`` (the last ký hiệu segment is the
drafting unit, an org-unit alt label), ``TP. Hồ Chí Minh, ngày 05 tháng 8 năm
2025``, "có hiệu lực (thi hành) (kể) từ ngày …", the scope ("áp dụng cho/đối
với …", "phạm vi điều chỉnh …", "đối tượng (áp dụng) …", "cho sinh viên khóa
2022 ngành …") and "thay thế Quyết định số …". What the rules miss the model
may fill (:func:`merge_answered`); a human-entered field is never overwritten
(that is ``profiles.py``'s job).

A document number is only ever one in the NĐ 30 form: the ``Số:`` line, or a
model answer shaped ``123/QĐ-ĐHCNKT`` (digits, ``/``, a ký hiệu starting with a
capital and carrying a ``-``); course or form codes ("DIGI330163", "BM5") are not.

Applicability a statement in the text names is explicit
(:data:`EXPLICIT_APPLICABILITY`, at or above ``authority.APPLICABILITY_AUTO_THRESHOLD``:
ranking may exclude another unit's document); a cue in the title or the model's
``applies_to`` (which may only restate the issuer) stays weak.

Campus: an org-unit concept is a campus when its notation starts with
``phan-hieu``/``co-so`` or one of its labels starts with "phân hiệu", "cơ sở"
or "trụ sở" (the seeded HCM-UTE units). A campus named in the header is the
document's campus; nothing else marks one reliably, so otherwise it stays
``None``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import date
from uuid import UUID

from bomesh.services.taxonomy.authority import ORG_UNIT_SCHEME, PROGRAM_SCHEME
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.snapshot import TaxonomySnapshot

from .aho import AhoCorasick

#: ``ExtractedMetadata.applicability_confidence``: a scope statement in the text read.
EXPLICIT_APPLICABILITY = 0.95
#: A weaker cue (a program or cohort in the title, or the model's ``applies_to``).
WEAK_APPLICABILITY = 0.6
HEADER_LINES = 8
#: Header matching ignores one-word labels (acronyms such as "CK" are too ambiguous there).
HEADER_MIN_WORDS = 2
_CAMPUS_NOTATIONS = ("phan-hieu", "co-so")
_CAMPUS_LABELS = ("phân hiệu", "cơ sở", "trụ sở")

_NUMBER_CORE = r"\d{1,6}[a-zA-Z]?(?:[ \t]*/[ \t]*\d{4})?[ \t]*/[ \t]*[^\W_]+(?:[ \t]*-[ \t]*[^\W_]+)*"
#: NĐ 30 writes ``Số: …`` (the colon keeps body references such as "Quyết định số 12/…" out).
_NUMBER = re.compile(rf"\bSố(?:[ \t]+hiệu)?[ \t]*:[ \t]*({_NUMBER_CORE})", re.IGNORECASE)
_DATE = (
    r"(?:(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})"
    r"|(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}))"
)
_ISSUE_DATE = re.compile(rf"(,[ \t]*)?\bngày\s+{_DATE}", re.IGNORECASE)
_EFFECTIVE = re.compile(
    rf"có\s+hiệu\s+lực(?:\s+thi\s+hành)?\s+(?:kể\s+)?từ\s+ngày\s+(?:(ký|ban\s+hành)\b|{_DATE})",
    re.IGNORECASE,
)
_SUPERSEDES = re.compile(
    r"thay\s+thế(?:\s+cho)?(?:\s+các)?(?:\s+(?:quyết\s+định|quy\s+định|quy\s+chế|thông\s+tư|"
    r"nghị\s+định|hướng\s+dẫn|kế\s+hoạch|thông\s+báo|công\s+văn|văn\s+bản))?\s+số\s+"
    rf"({_NUMBER_CORE})",
    re.IGNORECASE,
)
_STUDENTS = r"(?:sinh\s+viên|SV|học\s+viên|nghiên\s+cứu\s+sinh|người\s+học)"
#: What opens a scope statement; :func:`_statement` reads the sentence after it.
_APPLIES_CUE = (
    r"áp\s+dụng\s+(?:cho|đối\s+với)"
    r"|phạm\s+vi\s+(?:điều\s+chỉnh|áp\s+dụng)"
    r"|đối\s+tượng(?:\s+(?:áp\s+dụng|tham\s+dự|tham\s+gia|thực\s+hiện))?(?=[ \t]*[:\n])"
    r"|(?:\bcho|đối\s+với|dành\s+cho)(?=\s+(?:tất\s+cả\s+|toàn\s+bộ\s+|các\s+)?"
    rf"{_STUDENTS}\s+(?:toàn\s+|thuộc\s+|của\s+)?"
    r"(?:khoa|ngành|khóa|khoá|K\d|lớp|chuyên\s+ngành|bộ\s+môn|viện)\b)"
)
_APPLIES = re.compile(_APPLIES_CUE, re.IGNORECASE)
#: Separators and a list marker between a cue and its statement.
_STATEMENT_LEAD = re.compile(r"[ \t]*[:–-]?\s*(?:[-+•*]\s+|\d+[.)]\s+)?")
_LIST_ITEM = re.compile(r"\s*(?:[-+•*]|\d+[.)]|[a-zđ][.)])\s", re.IGNORECASE)
_SENTENCE_END = re.compile(r"[.;]")
_STATEMENT_CHARACTERS = 300
#: NĐ 30's number and ký hiệu: ``123/QĐ-ĐHCNKT-ĐT``, ``12/2020/NĐ-CP``.
_DOCUMENT_NUMBER = re.compile(r"\d{1,6}[a-zA-Z]?(?:/\d{4})?/([^\W\d_][^\W_]*)(?:-[^\W_]+)+")
_COHORT_K = re.compile(r"(?<![^\W\d_])K(\d{4}|\d{2})(?!\w)")
_COHORT_WORD = re.compile(r"\bkh(?:óa|oá)\s+(\d{4})(?!\d)", re.IGNORECASE)
_INSTITUTION = re.compile(r"\btoàn\s+(?:trường|thể)\b|\btất\s+cả\b|\bmọi\b", re.IGNORECASE)
_ISO_DATE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")


@dataclass(frozen=True, slots=True)
class ExtractedMetadata:
    number: str | None = None
    issued_on: date | None = None
    effective_on: date | None = None
    issuer_concept_id: UUID | None = None
    campus_concept_id: UUID | None = None
    #: institution | unit | program | cohort
    level: str | None = None
    unit_ids: tuple[UUID, ...] = ()
    program_ids: tuple[UUID, ...] = ()
    cohorts: tuple[int, ...] = ()
    applicability_confidence: float | None = None
    #: Document numbers as printed ("thay thế Quyết định số …").
    supersedes: tuple[str, ...] = ()

    def found(self) -> frozenset[str]:
        """The ``METADATA_FIELDS`` already known."""

        known: set[str] = set()
        if self.number:
            known.add("number")
        if self.issued_on is not None:
            known.add("issue_date")
        if self.effective_on is not None:
            known.add("effective_date")
        if self.issuer_concept_id is not None:
            known.add("issuer")
        if self.level is not None or self.unit_ids or self.program_ids or self.cohorts:
            known.add("applies_to")
        return frozenset(known)

    def concepts(self) -> frozenset[UUID]:
        """Authority concepts the metadata holds (rule conditions)."""

        held = {*self.unit_ids, *self.program_ids}
        if self.issuer_concept_id is not None:
            held.add(self.issuer_concept_id)
        if self.campus_concept_id is not None:
            held.add(self.campus_concept_id)
        return frozenset(held)


@dataclass(frozen=True, slots=True)
class AuthorityIndex:
    """Org-unit and program labels of the published taxonomy."""

    #: normalized label → (concept, words in the label).
    matcher: AhoCorasick[tuple[UUID, int]]
    #: normalized label → org-unit/program concepts carrying it.
    labels: Mapping[str, frozenset[UUID]]
    units: frozenset[UUID] = frozenset()
    programs: frozenset[UUID] = frozenset()
    campuses: frozenset[UUID] = frozenset()

    @classmethod
    def build(cls, taxonomy: TaxonomySnapshot) -> AuthorityIndex:
        entries: list[tuple[str, tuple[UUID, int]]] = []
        labels: dict[str, set[UUID]] = {}
        units: set[UUID] = set()
        programs: set[UUID] = set()
        campuses: set[UUID] = set()
        for code, bucket in ((ORG_UNIT_SCHEME, units), (PROGRAM_SCHEME, programs)):
            scheme = taxonomy.schemes.get(code)
            if scheme is None:
                continue
            for concept in scheme.concepts.values():
                if concept.state != "published":
                    continue
                bucket.add(concept.id)
                texts = [
                    *concept.pref_labels.values(),
                    *(text for _language, text in concept.alt_labels),
                    *(text for _language, text in concept.hidden_labels),
                ]
                normalized = [label for label in (normalize_label(text) for text in texts) if label]
                if code == ORG_UNIT_SCHEME and (
                    concept.notation.startswith(_CAMPUS_NOTATIONS)
                    or any(label.startswith(_CAMPUS_LABELS) for label in normalized)
                ):
                    campuses.add(concept.id)
                for label in normalized:
                    labels.setdefault(label, set()).add(concept.id)
                    entries.append((label, (concept.id, len(label.split()))))
        return cls(
            matcher=AhoCorasick(entries),
            labels={label: frozenset(ids) for label, ids in labels.items()},
            units=frozenset(units),
            programs=frozenset(programs),
            campuses=frozenset(campuses),
        )

    def find(self, text: str, *, min_words: int = 1) -> list[UUID]:
        """Unambiguous authority concepts named in ``text``, in text order."""

        found: list[UUID] = []
        for match in self.matcher.find(normalize_label(text)):
            ids = {concept for concept, words in match.payloads if words >= min_words}
            if len(ids) == 1:
                found.append(next(iter(ids)))
        return found

    def lookup(self, text: str) -> UUID | None:
        """The one concept whose label is exactly ``text``."""

        ids = self.labels.get(normalize_label(text), frozenset())
        return next(iter(ids)) if len(ids) == 1 else None


def _date(groups: Iterable[str | None]) -> date | None:
    values = [value for value in groups if value is not None]
    if len(values) != 3:
        return None
    day, month, year = (int(value) for value in values)
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _compact(number: str) -> str:
    return re.sub(r"\s+", "", number)


def document_number(head: str) -> str | None:
    """The number on the NĐ 30 ``Số:`` line of the leading text."""

    match = _NUMBER.search(head)
    return _compact(match.group(1)) if match else None


def is_document_number(value: str) -> bool:
    """Whether ``value`` has the NĐ 30 number form (``123/QĐ-ĐHCNKT``), not a course or form code."""

    match = _DOCUMENT_NUMBER.fullmatch(_compact(value))
    return match is not None and match.group(1)[0].isupper()


def _issued_on(head: str) -> date | None:
    first: date | None = None
    for match in _ISSUE_DATE.finditer(head):
        value = _date(match.groups()[1:])
        if value is None:
            continue
        if match.group(1):  # "<place>, ngày …": the NĐ 30 date line.
            return value
        first = first or value
    return first


def _effective_on(text: str, issued_on: date | None) -> date | None:
    match = _EFFECTIVE.search(text)
    if match is None:
        return None
    if match.group(1):
        return issued_on
    return _date(match.groups()[1:])


def _supersedes(text: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(_compact(match.group(1)) for match in _SUPERSEDES.finditer(text)))


def cohorts(text: str) -> tuple[int, ...]:
    """Entry years named as ``K22``, ``K2022``, ``khóa 2022`` or ``khoá 2022``."""

    years: list[int] = []
    for match in _COHORT_K.finditer(text):
        digits = match.group(1)
        years.append(2000 + int(digits) if len(digits) == 2 else int(digits))
    years.extend(int(match.group(1)) for match in _COHORT_WORD.finditer(text))
    return tuple(sorted({year for year in years if 1950 <= year <= 2100}))


def _header(head: str) -> str:
    lines: list[str] = []
    for line in head.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _NUMBER.search(stripped):
            break
        lines.append(stripped)
        if len(lines) >= HEADER_LINES:
            break
    return " ".join(lines)


def _issuer(index: AuthorityIndex, head: str, number: str | None) -> UUID | None:
    suffix: UUID | None = None
    suffix_is_last = False
    if number:
        segments = [segment for segment in number.split("/")[-1].split("-") if segment]
        for position in range(len(segments) - 1, 0, -1):
            concept = index.lookup(segments[position])
            if concept is not None and concept in index.units and concept not in index.campuses:
                suffix = concept
                # ``QĐ-ĐHCNKT-ĐT``: the last of two or more org segments is the drafting
                # unit; a lone segment is the institution's code, so a header unit is narrower.
                suffix_is_last = position == len(segments) - 1 and len(segments) >= 3
                break
    if suffix is not None and suffix_is_last:
        return suffix
    header = [
        concept
        for concept in index.find(_header(head), min_words=HEADER_MIN_WORDS)
        if concept in index.units and concept not in index.campuses
    ]
    return header[-1] if header else suffix


def _campus(index: AuthorityIndex, head: str) -> UUID | None:
    found = [
        concept
        for concept in index.find(_header(head), min_words=HEADER_MIN_WORDS)
        if concept in index.campuses
    ]
    return found[0] if found else None


@dataclass(frozen=True, slots=True)
class _Applicability:
    level: str | None = None
    unit_ids: tuple[UUID, ...] = ()
    program_ids: tuple[UUID, ...] = ()
    cohorts: tuple[int, ...] = ()
    confidence: float | None = None


def applicability(index: AuthorityIndex, span: str, confidence: float) -> _Applicability:
    """Units, programs and cohorts a phrase names, and the narrowest level they give."""

    named = list(dict.fromkeys(index.find(span)))
    units = tuple(concept for concept in named if concept in index.units)
    programs = tuple(concept for concept in named if concept in index.programs)
    years = cohorts(span)
    if years:
        level = "cohort"
    elif programs:
        level = "program"
    elif units:
        level = "unit"
    elif _INSTITUTION.search(span):
        level = "institution"
    else:
        return _Applicability()
    return _Applicability(level, units, programs, years, confidence)


def _heading(line: str) -> bool:
    """A line opening with an upper-case word of two letters or more (a heading)."""

    word = re.match(r"[^\W\d_]+", line)
    return word is not None and len(word.group(0)) >= 2 and word.group(0).isupper()


def _statement(text: str, start: int) -> str:
    """The sentence after a scope cue: up to ``.``/``;``, across wrapped lines; a blank
    line, a list item, a heading or a line ending in ``:`` ends it."""

    position = _STATEMENT_LEAD.match(text, start)
    lines = text[position.end() if position else start :].split("\n")
    kept: list[str] = []
    size = 0
    for number, line in enumerate(lines):
        if number and (
            not line.strip()
            or _LIST_ITEM.match(line)
            or _heading(line.strip())
            or kept[-1].rstrip().endswith(":")
        ):
            break
        end = _SENTENCE_END.search(line)
        kept.append(line[: end.start()] if end else line)
        size += len(kept[-1]) + 1
        if end or size >= _STATEMENT_CHARACTERS:
            break
    return " ".join(kept)[:_STATEMENT_CHARACTERS]


def _applies(index: AuthorityIndex, title: str, text: str) -> _Applicability:
    for match in _APPLIES.finditer(text):
        found = applicability(index, _statement(text, match.end()), EXPLICIT_APPLICABILITY)
        if found.level is not None:
            return found
    programs = tuple(
        dict.fromkeys(
            concept
            for concept in index.find(title, min_words=HEADER_MIN_WORDS)
            if concept in index.programs
        )
    )
    years = cohorts(title)
    if years or programs:
        return _Applicability(
            "cohort" if years else "program", (), programs, years, WEAK_APPLICABILITY
        )
    return _Applicability()


def extract_metadata(index: AuthorityIndex, *, title: str, head: str, text: str) -> ExtractedMetadata:
    """Everything the rules read; ``head`` is the leading text, ``text`` adds the excerpt."""

    number = document_number(head)
    issued_on = _issued_on(head)
    # A blank line keeps a statement at the end of ``head`` from running into ``text``.
    body = f"{head}\n\n{text}"
    applies = _applies(index, title, body)
    return ExtractedMetadata(
        number=number,
        issued_on=issued_on,
        effective_on=_effective_on(body, issued_on),
        issuer_concept_id=_issuer(index, head, number),
        campus_concept_id=_campus(index, head),
        level=applies.level,
        unit_ids=applies.unit_ids,
        program_ids=applies.program_ids,
        cohorts=applies.cohorts,
        applicability_confidence=applies.confidence,
        supersedes=_supersedes(body),
    )


def _iso(value: str) -> date | None:
    match = _ISO_DATE.match(value)
    if match is None:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _answered_issuer(index: AuthorityIndex, value: str) -> UUID | None:
    exact = index.lookup(value)
    if exact is not None and exact in index.units:
        return exact
    named = [concept for concept in index.find(value) if concept in index.units]
    return named[-1] if named else None


def merge_answered(
    metadata: ExtractedMetadata, answered: Mapping[str, str], index: AuthorityIndex
) -> ExtractedMetadata:
    """Fill the fields the rules did not find from the model's ``metadata`` answer."""

    found = metadata.found()
    changes: dict[str, object] = {}
    number = _compact(answered.get("number") or "")
    if "number" not in found and number and is_document_number(number):
        changes["number"] = number[:128]
    if "issue_date" not in found and answered.get("issue_date"):
        changes["issued_on"] = _iso(answered["issue_date"])
    if "effective_date" not in found and answered.get("effective_date"):
        changes["effective_on"] = _iso(answered["effective_date"])
    if "issuer" not in found and answered.get("issuer"):
        changes["issuer_concept_id"] = _answered_issuer(index, answered["issuer"])
    if "applies_to" not in found and answered.get("applies_to"):
        applies = applicability(index, answered["applies_to"], WEAK_APPLICABILITY)
        if applies.level is not None:
            changes.update(
                level=applies.level,
                unit_ids=applies.unit_ids,
                program_ids=applies.program_ids,
                cohorts=applies.cohorts,
                applicability_confidence=applies.confidence,
            )
    return replace(metadata, **changes) if changes else metadata  # type: ignore[arg-type]


__all__ = [
    "EXPLICIT_APPLICABILITY",
    "WEAK_APPLICABILITY",
    "AuthorityIndex",
    "ExtractedMetadata",
    "applicability",
    "cohorts",
    "document_number",
    "extract_metadata",
    "is_document_number",
    "merge_answered",
]
