"""CLASSIFYING (design §7): the run plan, the per-Document request, and the decision.

``load_plan`` (once per run) → ``prepare`` (per Document, after chunking:
metadata, patterns, rules, candidates → one :class:`ClassificationRequest`)
→ the one model call in ``document_index`` (only when a scheme is asked) →
``decide`` (answer → per-scheme rows and outcomes, written by
``assignments.py`` / ``profiles.py``).

Per scheme in scope:

- ``match_patterns`` over title, number and the first heading lines naming
  exactly one concept settle it (source ``rule``, ``evidence.pattern``); two or
  more become the shortlist the model chooses from.
- ``implies`` rules whose condition holds (a settled concept, the issuer, the
  campus, an applicability unit or program, the collection, the source) settle
  their target; a scheme is settled when the settled concepts reach
  ``min_labels`` (any for ``fallback``/``never`` schemes). Settled schemes are
  shown to the model as context, never asked.
- ``prior`` rules (and a program's ``closeMatch``/``exactMatch`` mapping to a
  classification concept, at :data:`PROGRAM_PRIOR_WEIGHT`) add a ``prior``
  signal; lexical (Aho-Corasick, title ×3), card and kNN signals complete the
  candidates; the top :data:`SHORTLIST_SIZE` form an ``always`` scheme's
  shortlist. A ``fallback`` scheme without ≥ 2 pattern hits may take any label.
- ``never`` schemes are decided by rules alone.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.connector.protocol import Chunk, DocumentItem
from bomesh.document_index import (
    METADATA_FIELDS,
    ClassificationRequest,
    DocumentClassification,
    PromptCandidate,
    PromptConcept,
    PromptScheme,
    SchemeTask,
    SectionExcerpt,
    classification_context,
)
from bomesh.services.taxonomy.authority import PROGRAM_SCHEME
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.snapshot import (
    ConceptView,
    SchemeSnapshot,
    TaxonomySnapshot,
    load_published,
)

from .aho import AhoCorasick
from .calibration import (
    CARD_CORROBORATION_RANK,
    CLASSIFIER_VERSION,
    CORROBORATING_SIGNALS,
    RULE_CONFIDENCE,
    SHORTLIST_SIZE,
    confidence,
    held_below_auto,
    route,
)
from .metadata import (
    AuthorityIndex,
    ExtractedMetadata,
    document_number,
    extract_metadata,
    merge_answered,
)
from .patterns import CompiledPattern, compile_pattern, pattern_input
from .rules import (
    PRIOR_DECAY,
    RuleView,
    implied_concepts,
    is_target,
    load_rules,
    prior_scores,
    rule_evidence,
    scheme_of,
)
from .signals import Signals

log = logging.getLogger(__name__)

HEAD_CHARACTERS = 4000
SECTION_CHARACTERS = 600
#: Section-level labels are asked only for Documents with at least this many level-1 sections.
MIN_SECTIONS = 3
#: A program named by the applicability favors the classification concepts it maps to.
PROGRAM_PRIOR_WEIGHT = 0.6
PROGRAM_PRIOR_MATCHES = ("exact", "close")
#: Weights of the candidate sources in the combined score (normalized over the available ones).
SIGNAL_WEIGHTS = {"lexical": 0.35, "card": 0.25, "knn": 0.25, "prior": 0.15}
#: A lexical score saturates: hits / (hits + LEXICAL_HALF) with title hits counted ×3.
LEXICAL_HALF = 3.0
TITLE_WEIGHT = 3
#: Labels shorter than this never match lexically.
MIN_LEXICAL_LABEL = 2
PATH_SEPARATOR = " › "


@dataclass(frozen=True, slots=True)
class ClassificationOptions:
    """``RunClassification`` with ids parsed."""

    #: Restrict the shortlists of their schemes to these concepts and their descendants.
    concepts: tuple[UUID, ...] = ()
    note: str | None = None
    #: scheme code → the only candidates; only these concepts' machine rows are rewritten.
    rerank: Mapping[str, tuple[UUID, ...]] = field(default_factory=dict)
    #: Empty = every classification scheme.
    schemes: tuple[str, ...] = ()
    #: Machine rows are written SUGGESTED only.
    suggest_only: bool = False


@dataclass(frozen=True, slots=True)
class _PlanIndex:
    """Matchers built once per plan."""

    schemes: tuple[str, ...]
    lexical: Mapping[str, AhoCorasick[UUID]]
    patterns: Mapping[str, tuple[tuple[UUID, CompiledPattern], ...]]
    authority: AuthorityIndex
    label_of: Mapping[UUID, str]
    targets: Mapping[str, frozenset[UUID]]
    #: scheme code → the concepts a run restricts it to (rerank / concepts option).
    restricted: Mapping[str, frozenset[UUID]]
    #: program concept → classification target → prior weight.
    program_priors: Mapping[UUID, Mapping[UUID, float]]


@dataclass(frozen=True, slots=True)
class ClassificationPlan:
    """Everything a run's Documents share, built once per run."""

    tenant_id: UUID
    workspace_code: str
    taxonomy: TaxonomySnapshot
    rules: tuple[RuleView, ...]
    options: ClassificationOptions
    prompt_schemes: tuple[PromptScheme, ...]
    #: short label ("D12") → concept id
    labels: Mapping[str, UUID]
    fingerprint: str
    _index: _PlanIndex = field(repr=False, compare=False)

    def scheme(self, code: str) -> SchemeSnapshot:
        return self.taxonomy.schemes[code]

    @property
    def schemes(self) -> tuple[str, ...]:
        """Classification scheme codes in scope, by position."""

        return self._index.schemes

    @property
    def write_profile(self) -> bool:
        """Rerank and scheme-filtered runs leave the issuance and applicability alone."""

        return not self.options.rerank and not self.options.schemes


@dataclass(frozen=True, slots=True)
class DocumentInput:
    title: str
    #: ``classification_context(...)`` / ``sample_document_context(...)``
    context: str
    #: Leading text in chunk order (header, number, first heading), ≤ 4000 characters.
    head: str
    #: Level-1 sections: (ref, heading, first 600 characters).
    sections: tuple[tuple[str, str, str], ...] = ()
    #: Collection placement (rules).
    ancestor_ids: tuple[UUID, ...] = ()
    #: ``ingestion_sources.id`` (rules).
    source_id: UUID | None = None
    #: ``None`` for testClassification samples.
    item_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ScoredCandidate:
    concept_id: UUID
    #: (kind, score) with kind ∈ lexical|card|knn|prior, nonzero only.
    scores: tuple[tuple[str, float], ...]
    score: float
    #: The kinds that corroborate a model pick (``calibration.CORROBORATING_SIGNALS``;
    #: card only among the top ``CARD_CORROBORATION_RANK`` cards).
    corroboration: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class MachineAssignment:
    concept_id: UUID
    primary: bool
    confidence: float
    #: rule | lexical | knn | llm
    source: str
    #: accepted | suggested
    state: str
    #: {"quote"?, "signals": [{"kind", "score"}], "corroborated"?, "rule"?, "pattern"?, "section"?}
    evidence: Mapping[str, Any]
    section_ref: str | None = None


@dataclass(frozen=True, slots=True)
class PreparedDocument:
    request: ClassificationRequest
    #: scheme code → rule rows (confidence 1.0, source rule).
    settled: Mapping[str, tuple[MachineAssignment, ...]]
    #: scheme code → ranked candidates (the shortlist when there is one).
    candidates: Mapping[str, tuple[ScoredCandidate, ...]]
    metadata: ExtractedMetadata
    #: Scheme codes in scope for this Document.
    schemes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SchemeResult:
    scheme_id: UUID
    scheme_code: str
    scheme_version: int
    #: assigned | empty | uncertain | failed
    outcome: str
    confidence: float | None
    assignments: tuple[MachineAssignment, ...]
    #: Rerank: only these concepts' machine rows are rewritten.
    replace_concepts: frozenset[UUID] | None = None


@dataclass(frozen=True, slots=True)
class ClassificationOutcome:
    schemes: tuple[SchemeResult, ...]
    metadata: ExtractedMetadata
    summary: str | None
    title: str | None
    model_called: bool
    #: False for rerank / scheme-filtered runs.
    write_profile: bool
    suggest_only: bool


# --------------------------------------------------------------------------- plan


def _name(concept: ConceptView) -> str:
    return concept.pref_labels.get("vi") or next(iter(concept.pref_labels.values()), concept.notation)


def _path(scheme: SchemeSnapshot, concept: ConceptView) -> str:
    """Ancestors' names along the first-listed parents, top first."""

    names: list[str] = []
    seen = {concept.id}
    current = concept
    while True:
        parent = next((p for p in current.broader if p in scheme.concepts and p not in seen), None)
        if parent is None:
            break
        seen.add(parent)
        current = scheme.concepts[parent]
        names.append(_name(current))
    return PATH_SEPARATOR.join(reversed(names))


def _letters(codes: Sequence[str]) -> dict[str, str]:
    """A unique alphabetic label prefix per scheme: its initial, else its word initials,
    else its first two letters, else initial + A…Z (labels stay ``letters + digits``)."""

    used: set[str] = set()
    letters: dict[str, str] = {}
    for code in codes:
        words = [word for word in code.split("-") if word]
        options = [code[0].upper()]
        if len(words) > 1:
            options.append("".join(word[0] for word in words).upper())
        alpha = [character for character in code if character.isalpha()]
        if len(alpha) > 1:
            options.append((alpha[0] + alpha[1]).upper())
        options.extend(code[0].upper() + chr(letter) for letter in range(ord("A"), ord("Z") + 1))
        letter = next(option for option in options if option.isalpha() and option not in used)
        used.add(letter)
        letters[code] = letter
    return letters


def _restricted(
    taxonomy: TaxonomySnapshot, codes: Sequence[str], options: ClassificationOptions
) -> dict[str, frozenset[UUID]]:
    restricted: dict[str, frozenset[UUID]] = {}
    for code in codes:
        scheme = taxonomy.schemes[code]
        if code in options.rerank:
            restricted[code] = frozenset(
                concept for concept in options.rerank[code] if is_target(scheme, concept)
            )
            continue
        chosen = [concept for concept in options.concepts if concept in scheme.concepts]
        if chosen:
            subtree = {
                member
                for concept in chosen
                for member in (concept, *scheme.descendants(concept))
                if is_target(scheme, member)
            }
            restricted[code] = frozenset(subtree)
    return restricted


def _program_priors(taxonomy: TaxonomySnapshot, codes: Sequence[str]) -> dict[UUID, dict[UUID, float]]:
    programs = taxonomy.schemes.get(PROGRAM_SCHEME)
    if programs is None:
        return {}
    by_notation = {
        code: {concept.notation: concept.id for concept in taxonomy.schemes[code].concepts.values()}
        for code in codes
    }
    priors: dict[UUID, dict[UUID, float]] = {}
    for program in programs.concepts.values():
        for system, target_code, _label, match in program.mappings:
            if system not in by_notation or match not in PROGRAM_PRIOR_MATCHES:
                continue
            target = by_notation[system].get(target_code)
            if target is None:
                continue
            scheme = taxonomy.schemes[system]
            spread = (
                {target: 0}
                if is_target(scheme, target)
                else {
                    descendant: distance
                    for descendant, distance in scheme.descendants(target).items()
                    if is_target(scheme, descendant)
                }
            )
            bucket = priors.setdefault(program.id, {})
            for concept, distance in spread.items():
                weight = round(PROGRAM_PRIOR_WEIGHT * PRIOR_DECAY**distance, 4)
                bucket[concept] = max(bucket.get(concept, 0.0), weight)
    return priors


def _fingerprint(
    schemes: Iterable[SchemeSnapshot], rules: Iterable[RuleView], options: ClassificationOptions
) -> str:
    payload = {
        "classifier": CLASSIFIER_VERSION,
        "schemes": sorted([scheme.code, scheme.version] for scheme in schemes),
        "rules": [
            [rule.code, rule.when, str(rule.then_concept_id), rule.effect, rule.weight]
            for rule in sorted(rules, key=lambda value: value.code)
        ],
        "options": {
            "concepts": sorted(str(concept) for concept in options.concepts),
            "note": options.note,
            "rerank": {
                code: sorted(str(concept) for concept in concepts)
                for code, concepts in sorted(options.rerank.items())
            },
            "schemes": sorted(options.schemes),
            "suggest_only": options.suggest_only,
        },
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def scheme_patterns(scheme: SchemeSnapshot) -> tuple[tuple[UUID, CompiledPattern], ...]:
    """The compiled ``matchPatterns`` of the scheme's assignable concepts, by notation."""

    compiled: list[tuple[UUID, CompiledPattern]] = []
    for concept in sorted(scheme.concepts.values(), key=lambda view: view.notation):
        if not is_target(scheme, concept.id):
            continue
        for pattern in concept.match_patterns:
            value = compile_pattern(pattern)
            if value is None:
                log.debug("skipping invalid match pattern %r of %s", pattern, concept.notation)
                continue
            compiled.append((concept.id, value))
    return tuple(compiled)


def pattern_text(title: str, head: str, first_heading: str | None) -> str:
    """What patterns read: the title, the ``Số:`` number of ``head``, the first heading and
    the leading lines."""

    lines = [first_heading] if first_heading else []
    lines.extend(head.splitlines())
    return pattern_input(title, document_number(head), lines)


def pattern_hits(patterns: Iterable[tuple[UUID, CompiledPattern]], text: str) -> dict[UUID, str]:
    """Concept → the first of its patterns that matches ``text``."""

    found: dict[UUID, str] = {}
    for concept, pattern in patterns:
        if concept not in found and pattern.search(text):
            found[concept] = pattern.text
    return found



def build_plan(
    tenant_id: UUID,
    workspace_code: str,
    taxonomy: TaxonomySnapshot,
    rules: Sequence[RuleView],
    options: ClassificationOptions | None = None,
) -> ClassificationPlan | None:
    """The plan for a published taxonomy; ``None`` when no classification scheme is in scope."""

    options = options or ClassificationOptions()
    classification = sorted(
        (scheme for scheme in taxonomy.schemes.values() if scheme.purpose == "classification"),
        key=lambda scheme: (scheme.position, scheme.code),
    )
    if options.schemes:
        classification = [scheme for scheme in classification if scheme.code in options.schemes]
    if options.rerank:
        classification = [scheme for scheme in classification if scheme.code in options.rerank]
    if not classification:
        return None
    codes = tuple(scheme.code for scheme in classification)
    prompted = [scheme for scheme in classification if scheme.llm_policy != "never"]
    letters = _letters([scheme.code for scheme in prompted])
    prompt_schemes: list[PromptScheme] = []
    labels: dict[str, UUID] = {}
    label_of: dict[UUID, str] = {}
    for scheme in prompted:
        listed = sorted(
            (
                (_path(scheme, concept), _name(concept), concept)
                for concept in scheme.concepts.values()
                if is_target(scheme, concept.id)
            ),
            key=lambda entry: (
                f"{entry[0]}{PATH_SEPARATOR}{entry[1]}".casefold() if entry[0] else entry[1].casefold(),
                entry[2].notation,
            ),
        )
        concepts: list[PromptConcept] = []
        for number, (path, name, concept) in enumerate(listed, start=1):
            label = f"{letters[scheme.code]}{number}"
            labels[label] = concept.id
            label_of[concept.id] = label
            concepts.append(
                PromptConcept(
                    label=label,
                    concept_id=str(concept.id),
                    name=name,
                    path=path,
                    definition=concept.definition,
                    scope_note=concept.scope_note,
                    alt_labels=tuple(text for _language, text in concept.alt_labels),
                    examples=tuple(concept.examples),
                )
            )
        prompt_schemes.append(
            PromptScheme(
                code=scheme.code,
                name=scheme.name,
                letter=letters[scheme.code],
                version=scheme.version,
                min_labels=scheme.min_labels,
                max_labels=scheme.max_labels,
                has_primary=scheme.has_primary,
                concepts=tuple(concepts),
            )
        )
    lexical: dict[str, AhoCorasick[UUID]] = {}
    patterns: dict[str, tuple[tuple[UUID, CompiledPattern], ...]] = {}
    targets: dict[str, frozenset[UUID]] = {}
    for scheme in classification:
        entries: list[tuple[str, UUID]] = []
        scheme_targets: set[UUID] = set()
        for concept in sorted(scheme.concepts.values(), key=lambda view: view.notation):
            if not is_target(scheme, concept.id):
                continue
            scheme_targets.add(concept.id)
            for text in (
                *concept.pref_labels.values(),
                *(text for _language, text in concept.alt_labels),
                *(text for _language, text in concept.hidden_labels),
            ):
                label = normalize_label(text)
                if len(label) >= MIN_LEXICAL_LABEL:
                    entries.append((label, concept.id))
        lexical[scheme.code] = AhoCorasick(entries)
        patterns[scheme.code] = scheme_patterns(scheme)
        targets[scheme.code] = frozenset(scheme_targets)
    index = _PlanIndex(
        schemes=codes,
        lexical=lexical,
        patterns=patterns,
        authority=AuthorityIndex.build(taxonomy),
        label_of=label_of,
        targets=targets,
        restricted=_restricted(taxonomy, codes, options),
        program_priors=_program_priors(taxonomy, codes),
    )
    return ClassificationPlan(
        tenant_id=tenant_id,
        workspace_code=workspace_code,
        taxonomy=taxonomy,
        rules=tuple(rules),
        options=options,
        prompt_schemes=tuple(prompt_schemes),
        labels=labels,
        fingerprint=_fingerprint(classification, rules, options),
        _index=index,
    )


async def load_plan(
    session: AsyncSession,
    tenant_id: UUID,
    options: ClassificationOptions | None,
    *,
    workspace_code: str,
) -> ClassificationPlan | None:
    """The run's plan from the published taxonomy and live rules; ``None`` without a scheme in scope."""

    taxonomy = await load_published(session, tenant_id)
    if not any(scheme.purpose == "classification" for scheme in taxonomy.schemes.values()):
        return None
    rules = await load_rules(session, tenant_id)
    return build_plan(tenant_id, workspace_code, taxonomy, rules, options)


# --------------------------------------------------------------------------- input


def document_input(
    item: DocumentItem,
    chunks: Sequence[Chunk],
    *,
    ancestor_ids: Sequence[UUID] = (),
    source_id: UUID | None = None,
    item_id: UUID | None = None,
) -> DocumentInput:
    """What CLASSIFYING reads of a chunked Document."""

    ordered = sorted(chunks, key=lambda chunk: chunk.chunk_index)
    parts: list[str] = []
    size = 0
    for chunk in ordered:
        if size >= HEAD_CHARACTERS:
            break
        parts.append(chunk.chunk_text)
        size += len(chunk.chunk_text) + 1
    sections: dict[str, list[Any]] = {}
    for chunk in ordered:
        if not chunk.section_path:
            continue
        heading = chunk.section_path[0]
        entry = sections.get(heading)
        if entry is None:
            sections[heading] = [chunk.refs[0], [chunk.chunk_text], len(chunk.chunk_text)]
        elif entry[2] < SECTION_CHARACTERS:
            entry[1].append(chunk.chunk_text)
            entry[2] += len(chunk.chunk_text) + 1
    return DocumentInput(
        title=item.title or "",
        context=classification_context(item, chunks),
        head="\n".join(parts)[:HEAD_CHARACTERS],
        sections=tuple(
            (ref, heading, "\n".join(texts)[:SECTION_CHARACTERS])
            for heading, (ref, texts, _size) in sections.items()
        ),
        ancestor_ids=tuple(ancestor_ids),
        source_id=source_id,
        item_id=item_id,
    )


# --------------------------------------------------------------------------- prepare


def _lexical(matcher: AhoCorasick[UUID], title: str, body: str) -> dict[UUID, float]:
    hits: dict[UUID, float] = {}
    for text, weight in ((title, TITLE_WEIGHT), (body, 1)):
        if not text:
            continue
        for match in matcher.find(text):
            for concept in match.payloads:
                hits[concept] = hits.get(concept, 0.0) + weight
    return {concept: round(count / (count + LEXICAL_HALF), 4) for concept, count in hits.items()}


def _combine(
    scores: Mapping[UUID, Mapping[str, float]], available: Iterable[str]
) -> dict[UUID, ScoredCandidate]:
    kinds = [kind for kind in SIGNAL_WEIGHTS if kind in set(available)]
    total = sum(SIGNAL_WEIGHTS[kind] for kind in kinds) or 1.0
    cards = sorted(
        (values["card"], str(concept))
        for concept, values in scores.items()
        if values.get("card", 0.0) > 0
    )
    top_cards = {concept for _score, concept in cards[-CARD_CORROBORATION_RANK:]}
    combined: dict[UUID, ScoredCandidate] = {}
    for concept, values in scores.items():
        nonzero = tuple((kind, values[kind]) for kind in kinds if values.get(kind, 0.0) > 0)
        score = sum(SIGNAL_WEIGHTS[kind] * value for kind, value in nonzero) / total
        corroboration = tuple(
            kind
            for kind, _value in nonzero
            if kind in CORROBORATING_SIGNALS and (kind != "card" or str(concept) in top_cards)
        )
        combined[concept] = ScoredCandidate(concept, nonzero, round(min(score, 1.0), 4), corroboration)
    return combined


def _settled(code: str, scheme: SchemeSnapshot, rows: Mapping[UUID, Any]) -> bool:
    if not rows:
        return False
    return scheme.llm_policy != "always" or len(rows) >= scheme.min_labels


async def prepare(
    plan: ClassificationPlan, doc: DocumentInput, signals: Signals | None = None
) -> PreparedDocument:
    """The deterministic stages for one Document and the request the model answers."""

    index = plan._index
    metadata = extract_metadata(index.authority, title=doc.title, head=doc.head, text=doc.context)
    patterned = pattern_text(doc.title, doc.head, doc.sections[0][1] if doc.sections else None)

    hits: dict[str, dict[UUID, str]] = {}
    settled: dict[str, dict[UUID, dict[str, Any]]] = {code: {} for code in index.schemes}
    for code in index.schemes:
        restricted = index.restricted.get(code)
        found = pattern_hits(index.patterns[code], patterned)
        if restricted is not None:
            found = {concept: text for concept, text in found.items() if concept in restricted}
        hits[code] = found
        if len(found) == 1:
            concept, text = next(iter(found.items()))
            settled[code][concept] = {"pattern": text}

    holding = {concept for rows in settled.values() for concept in rows} | metadata.concepts()
    implied = implied_concepts(plan, plan.rules, holding, doc.ancestor_ids, doc.source_id)
    implied_schemes: set[str] = set()
    for concept, rule in implied.items():
        scheme = scheme_of(plan.taxonomy, concept)
        if scheme is None or scheme.code not in settled:
            continue
        restricted = index.restricted.get(scheme.code)
        if restricted is not None and concept not in restricted:
            continue
        if concept not in settled[scheme.code]:
            settled[scheme.code][concept] = rule_evidence(rule)
            implied_schemes.add(scheme.code)

    held = holding | set(implied)
    priors: dict[UUID, float] = {
        concept: weight
        for concept, (weight, _rule) in prior_scores(
            plan.taxonomy, plan.rules, held, doc.ancestor_ids, doc.source_id
        ).items()
    }
    for program in metadata.program_ids:
        for concept, weight in index.program_priors.get(program, {}).items():
            priors[concept] = max(priors.get(concept, 0.0), weight)

    asked = [
        code
        for code in index.schemes
        if plan.scheme(code).llm_policy != "never"
        and not _settled(code, plan.scheme(code), settled[code])
    ]
    external = await signals.collect(plan, doc, asked) if signals is not None and asked else {}

    title_text = normalize_label(doc.title)
    body_text = normalize_label(doc.context)
    candidates: dict[str, tuple[ScoredCandidate, ...]] = {}
    tasks: list[SchemeTask] = []
    for code in index.schemes:
        scheme = plan.scheme(code)
        if scheme.llm_policy == "never":
            continue
        settled_labels = tuple(
            index.label_of[concept] for concept in settled[code] if concept in index.label_of
        )
        if code not in asked:
            tasks.append(SchemeTask(scheme=code, settled=settled_labels))
            continue
        targets = index.targets[code]
        restricted = index.restricted.get(code)
        raw: dict[UUID, dict[str, float]] = {}
        for concept, score in _lexical(index.lexical[code], title_text, body_text).items():
            raw.setdefault(concept, {})["lexical"] = score
        for concept, weight in priors.items():
            if concept in targets:
                raw.setdefault(concept, {})["prior"] = weight
        scheme_signals = external.get(code, {})
        for concept, values in scheme_signals.items():
            raw.setdefault(concept, {}).update(values)
        available = {"lexical", "prior"} | {kind for values in scheme_signals.values() for kind in values}
        pool = set(raw) & targets
        if restricted is not None:
            pool = set(restricted)
        pool -= set(settled[code])
        scored = _combine({concept: raw.get(concept, {}) for concept in pool}, available)
        ranked = sorted(
            scored.values(),
            key=lambda candidate: (-candidate.score, index.label_of.get(candidate.concept_id, "")),
        )
        if code in plan.options.rerank:
            shortlist = ranked
        elif restricted is not None or scheme.llm_policy == "always":
            shortlist = ranked[:SHORTLIST_SIZE]
        elif len(hits[code]) >= 2:
            shortlist = [candidate for candidate in ranked if candidate.concept_id in hits[code]]
            shortlist += [
                ScoredCandidate(concept, (), 0.0)
                for concept in hits[code]
                if concept not in scored and concept not in settled[code]
            ]
        else:
            shortlist = []
        candidates[code] = tuple(shortlist or ranked[:SHORTLIST_SIZE])
        tasks.append(
            SchemeTask(
                scheme=code,
                settled=settled_labels,
                ask=True,
                shortlist=tuple(
                    PromptCandidate(
                        label=index.label_of[candidate.concept_id],
                        scores=candidate.scores,
                        score=candidate.score,
                    )
                    for candidate in shortlist
                    if candidate.concept_id in index.label_of
                ),
            )
        )

    section_scheme = next(
        (
            code
            for code in asked
            if plan.scheme(code).section_assignments and code not in implied_schemes
        ),
        None,
    )
    sections: tuple[SectionExcerpt, ...] = ()
    if section_scheme is not None and len(doc.sections) >= MIN_SECTIONS:
        sections = tuple(
            SectionExcerpt(label=f"S{number}", ref=ref, heading=heading, text=text[:SECTION_CHARACTERS])
            for number, (ref, heading, text) in enumerate(doc.sections, start=1)
        )
    else:
        section_scheme = None

    found = metadata.found()
    request = ClassificationRequest(
        schemes=plan.prompt_schemes,
        note=plan.options.note,
        fingerprint=plan.fingerprint,
        tasks=tuple(tasks),
        sections=sections,
        section_scheme=section_scheme,
        metadata_asks=(
            tuple(name for name in METADATA_FIELDS if name not in found) if plan.write_profile else ()
        ),
    )
    return PreparedDocument(
        request=request,
        settled={
            code: tuple(
                MachineAssignment(
                    concept_id=concept,
                    primary=False,
                    confidence=RULE_CONFIDENCE,
                    source="rule",
                    state="accepted",
                    evidence={**evidence, "signals": []},
                )
                for concept, evidence in rows.items()
            )
            for code, rows in settled.items()
            if rows
        },
        candidates=candidates,
        metadata=metadata,
        schemes=index.schemes,
    )


# --------------------------------------------------------------------------- decide


def _allowed(plan: ClassificationPlan, task: SchemeTask) -> frozenset[UUID]:
    """Concepts the model may name for a scheme: shortlist ∪ settled, else every target."""

    index = plan._index
    if task.shortlist:
        labels = [candidate.label for candidate in task.shortlist] + list(task.settled)
        return frozenset(plan.labels[label] for label in labels if label in plan.labels)
    allowed = index.targets.get(task.scheme, frozenset())
    restricted = index.restricted.get(task.scheme)
    return allowed & restricted if restricted is not None else allowed


def _ranked(prepared: PreparedDocument, task: SchemeTask) -> dict[UUID, tuple[int, ScoredCandidate]]:
    """Concept → (shortlist rank, candidate); without a shortlist (any label) rank is 0:
    the scores still count as agreement, but there is no order to fall behind in."""

    candidates = prepared.candidates.get(task.scheme, ())
    return {
        candidate.concept_id: (rank if task.shortlist else 0, candidate)
        for rank, candidate in enumerate(candidates)
    }



def _model_row(
    plan: ClassificationPlan,
    scheme: SchemeSnapshot,
    concept: UUID,
    certainty: str | None,
    ranked: Mapping[UUID, tuple[int, ScoredCandidate]],
    ranked_order: bool,
    *,
    primary: bool,
    evidence: Mapping[str, Any],
    section_ref: str | None = None,
) -> tuple[MachineAssignment | None, float]:
    rank, candidate = ranked.get(concept, (SHORTLIST_SIZE if ranked_order else 0, None))
    scores = candidate.scores if candidate is not None else ()
    corroborated = bool(candidate.corroboration) if candidate is not None else False
    value = held_below_auto(confidence(certainty, len(scores), rank), scheme, corroborated)
    state = route(value, scheme)
    if state is None:
        return None, value
    return (
        MachineAssignment(
            concept_id=concept,
            primary=primary,
            confidence=value,
            source="llm",
            state=state,
            evidence={
                **evidence,
                "signals": [{"kind": kind, "score": score} for kind, score in scores],
                "corroborated": corroborated,
            },
            section_ref=section_ref,
        ),
        value,
    )


def _with_primary(
    rows: list[MachineAssignment], scheme: SchemeSnapshot, preferred: UUID | None
) -> list[MachineAssignment]:
    whole = [row for row in rows if row.section_ref is None]
    if not scheme.has_primary or not whole:
        return [replace(row, primary=False) if row.primary else row for row in rows]
    chosen = next((row.concept_id for row in whole if row.concept_id == preferred), None)
    if chosen is None:
        chosen = max(whole, key=lambda row: (row.state == "accepted", row.confidence)).concept_id
    return [
        replace(row, primary=row.section_ref is None and row.concept_id == chosen)
        for row in rows
    ]


def decide(
    plan: ClassificationPlan, prepared: PreparedDocument, answer: DocumentClassification | None
) -> ClassificationOutcome:
    """Turn the model's answer (``None``: no answer) into per-scheme rows and outcomes."""

    index = plan._index
    request = prepared.request
    tasks = {task.scheme: task for task in request.tasks}
    rows: dict[str, list[MachineAssignment]] = {
        code: list(prepared.settled.get(code, ())) for code in prepared.schemes
    }
    status: dict[str, str | None] = {}
    preferred: dict[str, UUID | None] = {}
    best_below: dict[str, float] = {}
    answered_confidence: dict[str, float] = {}

    for code in prepared.schemes:
        scheme = plan.scheme(code)
        task = tasks.get(code)
        status[code] = None
        preferred[code] = None
        if task is None or not task.ask:
            continue
        reply = answer.schemes.get(code) if answer is not None else None
        if reply is None:
            status[code] = "failed"
            continue
        ranked = _ranked(prepared, task)
        allowed = _allowed(plan, task)
        settled = {row.concept_id for row in rows[code]}
        chosen: list[UUID] = []
        for label in reply.labels:
            concept = plan.labels.get(label)
            if concept is None or concept not in allowed or concept in chosen:
                continue
            chosen.append(concept)
        if reply.none and not chosen:
            status[code] = (
                "empty" if reply.certainty == "high" and scheme.min_labels == 0 else "uncertain"
            )
            answered_confidence[code] = confidence(reply.certainty, 0, 0)
            continue
        if chosen and scheme.has_primary:
            preferred[code] = chosen[0]
        evidence = {"quote": reply.evidence} if reply.evidence else {}
        for position, concept in enumerate(chosen):
            if concept in settled:
                continue
            row, value = _model_row(
                plan,
                scheme,
                concept,
                reply.certainty,
                ranked,
                bool(task.shortlist),
                primary=position == 0 and scheme.has_primary,
                evidence=evidence,
            )
            if row is None:
                best_below[code] = max(best_below.get(code, 0.0), value)
                continue
            rows[code].append(row)

    section_code = request.section_scheme
    if answer is not None and section_code is not None and section_code in rows:
        scheme = plan.scheme(section_code)
        task = tasks[section_code]
        allowed = _allowed(plan, task)
        headings = {section.ref: section.heading for section in request.sections}
        reply = answer.schemes.get(section_code)
        certainty = reply.certainty if reply is not None else None
        ranked = _ranked(prepared, task)
        for ref, labels in answer.sections.items():
            if ref not in headings:
                continue
            seen: set[UUID] = set()
            for label in labels:
                concept = plan.labels.get(label)
                if concept is None or concept not in allowed or concept in seen:
                    continue
                seen.add(concept)
                row, _value = _model_row(
                    plan,
                    scheme,
                    concept,
                    certainty,
                    ranked,
                    bool(task.shortlist),
                    primary=False,
                    evidence={"section": headings[ref]},
                    section_ref=ref,
                )
                if row is not None:
                    rows[section_code].append(row)

    # implies from what the model chose (e.g. T picked as a fallback → F/A).
    premises = {
        row.concept_id: row
        for code in prepared.schemes
        for row in rows[code]
        if row.source == "llm" and row.section_ref is None
    }
    if premises:
        for concept, rule in implied_concepts(plan, plan.rules, premises, (), None).items():
            scheme = scheme_of(plan.taxonomy, concept)
            if scheme is None or scheme.code not in rows:
                continue
            restricted = index.restricted.get(scheme.code)
            if restricted is not None and concept not in restricted:
                continue
            if any(row.concept_id == concept and row.section_ref is None for row in rows[scheme.code]):
                continue
            premise = premises[rule.when_concept_id]  # type: ignore[index]
            rows[scheme.code].append(
                MachineAssignment(
                    concept_id=concept,
                    primary=False,
                    confidence=premise.confidence,
                    source="rule",
                    state=premise.state,
                    evidence={
                        **rule_evidence(rule),
                        "signals": [],
                        "corroborated": premise.evidence.get("corroborated", True),
                    },
                )
            )

    results: list[SchemeResult] = []
    suggest_only = plan.options.suggest_only
    for code in prepared.schemes:
        scheme = plan.scheme(code)
        scheme_rows = _with_primary(rows[code], scheme, preferred[code])
        if suggest_only:
            scheme_rows = [replace(row, state="suggested") for row in scheme_rows]
        outcome: str
        value: float | None
        if status[code] == "failed":
            outcome, value = "failed", None
        elif scheme_rows:
            outcome = "assigned"
            value = max(row.confidence for row in scheme_rows)
        elif status[code] in ("empty", "uncertain"):
            outcome, value = status[code], answered_confidence.get(code)  # type: ignore[assignment]
        elif code in best_below:
            outcome, value = "uncertain", best_below[code]
        elif tasks.get(code) is not None and tasks[code].ask:
            outcome, value = "uncertain", None
        else:
            # Rules alone decide (never schemes, or nothing to ask): nothing held.
            outcome, value = ("empty" if scheme.min_labels == 0 else "uncertain"), None
        rerank = plan.options.rerank.get(code)
        results.append(
            SchemeResult(
                scheme_id=scheme.scheme_id,
                scheme_code=code,
                scheme_version=scheme.version,
                outcome=outcome,
                confidence=value,
                assignments=tuple(scheme_rows),
                replace_concepts=frozenset(rerank) if rerank is not None else None,
            )
        )

    metadata = prepared.metadata
    if answer is not None and answer.metadata:
        asked_fields = set(request.metadata_asks)
        metadata = merge_answered(
            metadata,
            {name: value for name, value in answer.metadata.items() if name in asked_fields},
            index.authority,
        )
    return ClassificationOutcome(
        schemes=tuple(results),
        metadata=metadata,
        summary=answer.summary if answer is not None else None,
        title=answer.title if answer is not None else None,
        model_called=request.needs_model and answer is not None,
        write_profile=plan.write_profile,
        suggest_only=suggest_only,
    )


__all__ = [
    "MIN_SECTIONS",
    "PROGRAM_PRIOR_WEIGHT",
    "SIGNAL_WEIGHTS",
    "ClassificationOptions",
    "ClassificationOutcome",
    "ClassificationPlan",
    "DocumentInput",
    "MachineAssignment",
    "PreparedDocument",
    "SchemeResult",
    "ScoredCandidate",
    "build_plan",
    "decide",
    "document_input",
    "load_plan",
    "pattern_hits",
    "pattern_text",
    "prepare",
    "scheme_patterns",
]
