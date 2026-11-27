"""Concepts of a scheme's working copy: create, read, update, delete (drafts) and deprecate.

Edits change only the working copy; classification and query mapping see them
at the next publish. A concept's notation is its immutable API ID and is never
reused in the scheme (deleted drafts keep theirs). :func:`write_concept` is the
one validated writer of a concept's fields (labels through
:func:`~bomesh.services.taxonomy.normalize.normalize_label`, broader/related,
mappings, patterns): :func:`check_concept` validates, :func:`apply_writes`
writes, set-based for many concepts (ImportConcepts). CreateConcept,
UpdateConcept, ImportConcepts, template changes and accepted proposals all use
it. ``documentCount`` and
``inReviewCount`` count the documents the caller can read (visibility rule)
with an ACCEPTED / SUGGESTED assignment of the concept or of a concept under
it in the published hierarchy.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Select,
    and_,
    delete,
    distinct,
    exists,
    func,
    insert,
    literal_column,
    or_,
    select,
    tuple_,
    union_all,
)
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemConcept
from bomesh.db.models.taxonomy import (
    Concept,
    ConceptClosure,
    ConceptGroup,
    ConceptGroupMember,
    ConceptLabel,
    ConceptMapping,
    ConceptRelation,
    ConceptReplacement,
    ConceptRule,
    ConceptScheme,
    MAPPING_MATCH_TYPES,
)
from bomesh.errors import AlreadyExists, FailedPrecondition, FieldViolation, InvalidArgument
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.iam.visibility import item_visibility
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.taxonomy.classification.patterns import validate_pattern
from bomesh.services.taxonomy.names import concept_name, group_name, is_code, scheme_name
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.records import ConceptRecord, LabelValue, MappingValue
from bomesh.services.taxonomy.snapshot import ConceptView
from bomesh.services.taxonomy.support import (
    TaxonomyDeps,
    api_state,
    audit,
    authorize,
    concept_etag,
    concept_views,
    deprecation_pending,
    load_concept,
    load_scheme,
    now,
    touch,
)

#: Paths of a concept's writable fields (UpdateConcept mask, import columns).
CONCEPT_FIELDS = (
    "prefLabels",
    "altLabels",
    "hiddenLabels",
    "definition",
    "scopeNote",
    "examples",
    "broader",
    "related",
    "mappings",
    "matchPatterns",
    "timeSensitive",
    "color",
    "icon",
)
_LABEL_KINDS = {"prefLabels": "pref", "altLabels": "alt", "hiddenLabels": "hidden"}
MAX_LABEL = 255
MAX_EXAMPLES = 5
MAX_PATTERNS = 20
_LANGUAGE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$")
_COLOR = re.compile(r"^#[0-9a-f]{6}$")
_ICON = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_SYSTEM = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")
DOCUMENT_COUNT = literal_column("document_count")


# -- The scheme's concept graph (working copy) ---------------------------------------


@dataclass(slots=True)
class SchemeIndex:
    """Every concept of a scheme by notation (deleted drafts too) and the broader edges."""

    scheme: ConceptScheme
    by_notation: dict[str, Concept]
    broader: dict[UUID, set[UUID]] = field(default_factory=dict)

    @classmethod
    async def load(cls, session: AsyncSession, scheme: ConceptScheme) -> SchemeIndex:
        concepts = list(await session.scalars(select(Concept).where(Concept.scheme_id == scheme.id)))
        index = cls(scheme, {concept.notation: concept for concept in concepts})
        ids = [concept.id for concept in concepts]
        if ids:
            for source, target in (
                await session.execute(
                    select(ConceptRelation.source_concept_id, ConceptRelation.target_concept_id).where(
                        ConceptRelation.source_concept_id.in_(ids),
                        ConceptRelation.kind == "broader",
                    )
                )
            ).tuples():
                index.broader.setdefault(source, set()).add(target)
        return index

    def add(self, concept: Concept) -> None:
        self.by_notation[concept.notation] = concept

    def ancestors(self, cid: UUID) -> set[UUID]:
        found: set[UUID] = set()
        frontier = list(self.broader.get(cid, ()))
        while frontier:
            current = frontier.pop()
            if current not in found:
                found.add(current)
                frontier.extend(self.broader.get(current, ()))
        return found


# -- Validation and writing ------------------------------------------------------------


def _text(value: Any) -> str | None:
    if value is None:
        return None
    stripped = str(value).strip()
    return stripped or None


def _labels(
    path: str, values: Sequence[LabelValue], problems: list[FieldViolation]
) -> list[tuple[str, str, str]]:
    """``(language, text, normalized)`` of valid labels; problems name ``path[i].…``."""
    result = []
    for index, (language, text) in enumerate(values):
        where = f"{path}[{index}]"
        language = (language or "").strip()
        text = (text or "").strip()
        if not _LANGUAGE.match(language):
            problems.append(FieldViolation(f"{where}.languageCode", "A BCP-47 language code is required."))
            continue
        normalized = normalize_label(text)
        if not normalized:
            problems.append(FieldViolation(f"{where}.text", "A label needs letters or digits."))
            continue
        if len(text) > MAX_LABEL:
            problems.append(FieldViolation(f"{where}.text", f"A label has at most {MAX_LABEL} characters."))
            continue
        result.append((language, text, normalized))
    return result


def _mappings(values: Sequence[MappingValue], path: str, problems: list[FieldViolation]) -> list[MappingValue]:
    result: list[MappingValue] = []
    seen: set[tuple[str, str]] = set()
    for index, (system, code, label, match) in enumerate(values):
        where = f"{path}[{index}]"
        system, code = (system or "").strip(), (code or "").strip()
        if not _SYSTEM.match(system):
            problems.append(FieldViolation(f"{where}.system", "A code system ID (≤ 32 lowercase characters) is required."))
            continue
        if not code or len(code) > 64:
            problems.append(FieldViolation(f"{where}.code", "A code of 1–64 characters is required."))
            continue
        if match not in MAPPING_MATCH_TYPES:
            problems.append(FieldViolation(f"{where}.match", "EXACT, CLOSE, BROAD or NARROW."))
            continue
        if (system, code) in seen:
            problems.append(FieldViolation(where, f"'{system}:{code}' is listed twice."))
            continue
        seen.add((system, code))
        result.append((system, code, _text(label), match))
    return result


def _resolve(
    index: SchemeIndex,
    notations: Sequence[str],
    path: str,
    concept: Concept,
    problems: list[FieldViolation],
) -> list[Concept]:
    """Live, non-deprecated concepts of the scheme named by ``notations``."""
    found: list[Concept] = []
    for position, notation in enumerate(notations):
        target = index.by_notation.get(notation)
        where = f"{path}[{position}]"
        if target is None or target.deleted_at is not None:
            problems.append(
                FieldViolation(
                    where,
                    f"'{concept_name(index.scheme.tenant_id, index.scheme.code, notation)}' is not a concept of this scheme.",
                )
            )
        elif target.id == concept.id:
            problems.append(FieldViolation(where, "A concept cannot name itself."))
        elif target.state == "deprecated":
            problems.append(FieldViolation(where, f"'{notation}' is deprecated."))
        elif target not in found:
            found.append(target)
    return found


@dataclass(slots=True)
class ConceptWrite:
    """A validated :func:`check_concept` change of one concept, applied by :func:`apply_writes`."""

    concept: Concept
    scalars: dict[str, Any]
    #: ``(language, text, normalized)`` by label kind, the changed kinds only.
    labels: dict[str, list[tuple[str, str, str]]]
    broader: list[Concept] | None
    related: list[Concept] | None
    mappings: list[MappingValue] | None


async def write_concept(
    session: AsyncSession,
    index: SchemeIndex,
    concept: Concept,
    changes: Mapping[str, Any],
    *,
    current: ConceptView | None,
    prefix: str = "",
    problems: list[FieldViolation] | None = None,
) -> None:
    """Validate and apply ``changes`` (by path, see :data:`CONCEPT_FIELDS`) to ``concept``.

    Labels are ``[(language, text)]``, ``broader``/``related`` notations,
    ``mappings`` :data:`MappingValue`. Every problem is collected with its
    field path (``prefix`` + path); with ``problems`` given the caller raises,
    else INVALID_ARGUMENT is raised here. Nothing is written when a problem is found.
    """
    write = check_concept(index, concept, changes, current=current, prefix=prefix, problems=problems)
    if write is not None:
        await apply_writes(session, index, [write])


def check_concept(
    index: SchemeIndex,
    concept: Concept,
    changes: Mapping[str, Any],
    *,
    current: ConceptView | None,
    prefix: str = "",
    problems: list[FieldViolation] | None = None,
) -> ConceptWrite | None:
    """The validation of :func:`write_concept`, without writing: the write, or None on a problem.

    A valid ``broader`` change is recorded in ``index`` at once, so the cycle
    check of a later write sees it as if this one were applied.
    """
    own: list[FieldViolation] = [] if problems is None else problems
    start = len(own)

    def at(path: str) -> str:
        return f"{prefix}{path}"

    scalars: dict[str, Any] = {}
    if "definition" in changes:
        scalars["definition"] = _text(changes["definition"])
    if "scopeNote" in changes:
        scalars["scope_note"] = _text(changes["scopeNote"])
    if "examples" in changes:
        examples = [text for text in (_text(value) for value in changes["examples"] or ()) if text]
        if len(examples) > MAX_EXAMPLES:
            own.append(FieldViolation(at("examples"), f"At most {MAX_EXAMPLES} examples."))
        scalars["examples"] = examples
    if "matchPatterns" in changes:
        patterns = [text for text in (_text(value) for value in changes["matchPatterns"] or ()) if text]
        if len(patterns) > MAX_PATTERNS:
            own.append(FieldViolation(at("matchPatterns"), f"At most {MAX_PATTERNS} patterns."))
        for position, pattern in enumerate(patterns):
            problem = validate_pattern(pattern)
            if problem is not None:
                own.append(FieldViolation(at(f"matchPatterns[{position}]"), f"Invalid pattern: {problem}."))
        scalars["match_patterns"] = patterns
    if "timeSensitive" in changes:
        scalars["time_sensitive"] = bool(changes["timeSensitive"])
    if "icon" in changes:
        icon = _text(changes["icon"])
        if icon is not None and not _ICON.match(icon):
            own.append(FieldViolation(at("icon"), "An icon name matches ^[a-z][a-z0-9-]{0,63}$."))
        scalars["icon"] = icon
    if "color" in changes:
        color = _text(changes["color"])
        color = color.lower() if color else None
        if color is not None and not _COLOR.match(color):
            own.append(FieldViolation(at("color"), "A colour is #rrggbb."))
        scalars["color"] = color

    label_sets: dict[str, list[tuple[str, str, str]]] = {}
    for path, kind in _LABEL_KINDS.items():
        if path in changes:
            label_sets[kind] = _labels(at(path), list(changes[path] or ()), own)
        else:
            existing = (
                []
                if current is None
                else list(
                    current.pref_labels.items()
                    if kind == "pref"
                    else current.alt_labels
                    if kind == "alt"
                    else current.hidden_labels
                )
            )
            label_sets[kind] = [(language, text, normalize_label(text)) for language, text in existing]
    if any(path in changes for path in _LABEL_KINDS):
        seen_pref: set[str] = set()
        seen: set[tuple[str, str]] = set()
        for kind, path in (("pref", "prefLabels"), ("alt", "altLabels"), ("hidden", "hiddenLabels")):
            for position, (language, text, normalized) in enumerate(label_sets[kind]):
                if kind == "pref":
                    if language in seen_pref:
                        own.append(
                            FieldViolation(at(f"{path}[{position}].languageCode"), f"Only one prefLabel per language ('{language}').")
                        )
                    seen_pref.add(language)
                if (language, normalized) in seen:
                    own.append(
                        FieldViolation(at(f"{path}[{position}].text"), f"'{text}' is already a label of this concept in '{language}'.")
                    )
                seen.add((language, normalized))

    broader: list[Concept] | None = None
    if "broader" in changes:
        broader = _resolve(index, list(changes["broader"] or ()), at("broader"), concept, own)
        if any(concept.id == parent.id or concept.id in index.ancestors(parent.id) for parent in broader):
            own.append(FieldViolation(at("broader"), "This broader concept would create a cycle."))
    related: list[Concept] | None = None
    if "related" in changes:
        related = _resolve(index, list(changes["related"] or ()), at("related"), concept, own)
    mappings: list[MappingValue] | None = None
    if "mappings" in changes:
        mappings = _mappings(list(changes["mappings"] or ()), at("mappings"), own)

    final_color = scalars["color"] if "color" in scalars else concept.color
    has_broader = bool(broader) if broader is not None else bool(index.broader.get(concept.id))
    if final_color is not None and has_broader:
        own.append(FieldViolation(at("color"), "Only a top concept (without broader) has a colour."))

    if len(own) > start:
        if problems is None:
            raise InvalidArgument(own[0].description, field_violations=own)
        return None
    if broader is not None:
        index.broader[concept.id] = {parent.id for parent in broader}
    return ConceptWrite(
        concept=concept,
        scalars=scalars,
        labels={kind: label_sets[kind] for path, kind in _LABEL_KINDS.items() if path in changes},
        broader=broader,
        related=related,
        mappings=mappings,
    )


async def apply_writes(session: AsyncSession, index: SchemeIndex, writes: Sequence[ConceptWrite]) -> None:
    """Apply validated writes of ``index``'s scheme with set-based statements.

    The outcome is that of applying them one after the other: a later write of a
    concept's field replaces an earlier one, and a ``related`` change replaces
    every related pair of its concept, pairs an earlier write added included.
    """
    if not writes:
        return
    broader: dict[UUID, list[Concept]] = {}
    related: dict[tuple[UUID, UUID], None] = {}
    relating: set[UUID] = set()
    labels: dict[tuple[UUID, str], list[tuple[str, str, str]]] = {}
    mappings: dict[UUID, list[MappingValue]] = {}
    for write in writes:
        cid = write.concept.id
        if write.broader is not None:
            broader[cid] = write.broader
        if write.related is not None:
            relating.add(cid)
            related = {pair: None for pair in related if cid not in pair}
            for other in write.related:
                low, high = sorted((cid, other.id), key=str)
                related[(low, high)] = None
        for kind, values in write.labels.items():
            labels[(cid, kind)] = values
        if write.mappings is not None:
            mappings[cid] = write.mappings
    if broader:
        await session.execute(
            delete(ConceptRelation).where(
                ConceptRelation.source_concept_id.in_(list(broader)), ConceptRelation.kind == "broader"
            )
        )
    for write in writes:
        for attribute, value in write.scalars.items():
            setattr(write.concept, attribute, value)
    await session.flush()
    rows: list[dict[str, Any]] = [
        {"source_concept_id": cid, "target_concept_id": parent.id, "kind": "broader"}
        for cid, parents in broader.items()
        for parent in parents
    ]
    if rows:
        await session.execute(insert(ConceptRelation), rows)
    if relating:
        await session.execute(
            delete(ConceptRelation).where(
                ConceptRelation.kind == "related",
                or_(
                    ConceptRelation.source_concept_id.in_(list(relating)),
                    ConceptRelation.target_concept_id.in_(list(relating)),
                ),
            )
        )
        if related:
            await session.execute(
                insert(ConceptRelation),
                [{"source_concept_id": low, "target_concept_id": high, "kind": "related"} for low, high in related],
            )
    if labels:
        await session.execute(
            delete(ConceptLabel).where(tuple_(ConceptLabel.concept_id, ConceptLabel.kind).in_(list(labels)))
        )
        rows = [
            {
                "concept_id": cid,
                "kind": kind,
                "language_code": language,
                "label_text": text,
                "normalized": normalized,
            }
            for (cid, kind), values in labels.items()
            for language, text, normalized in values
        ]
        if rows:
            await session.execute(insert(ConceptLabel), rows)
    if mappings:
        await session.execute(delete(ConceptMapping).where(ConceptMapping.concept_id.in_(list(mappings))))
        rows = [
            {
                "concept_id": cid,
                "target_system": system,
                "target_code": code,
                "target_label": label,
                "match_type": match,
            }
            for cid, values in mappings.items()
            for system, code, label, match in values
        ]
        if rows:
            await session.execute(insert(ConceptMapping), rows)
    # After the scalar UPDATE: their ``onupdate`` expired ``updated_at``, so one batched UPDATE sets it.
    await touch(session, *dict.fromkeys(write.concept for write in writes), index.scheme)
    await session.flush()


def draft_concept(
    session: AsyncSession,
    ctx: RequestContext | None,
    index: SchemeIndex,
    notation: str,
    *,
    template_concept_id: UUID | None = None,
) -> Concept:
    """Add a new DRAFT concept of ``index``'s scheme to ``session`` and ``index`` (inserted at the next flush)."""
    scheme = index.scheme
    if notation in index.by_notation:
        raise AlreadyExists(
            f"Concept '{concept_name(scheme.tenant_id, scheme.code, notation)}' already exists "
            "or its ID is reserved."
        )
    concept = Concept(
        tenant_id=scheme.tenant_id,
        scheme_id=scheme.id,
        notation=notation,
        state="draft",
        template_concept_id=template_concept_id,
        created_by_user_id=ctx.user_id if ctx is not None else None,
    )
    session.add(concept)
    index.add(concept)
    return concept


def concept_json(view: ConceptView | None, names: Mapping[UUID, str]) -> dict[str, Any] | None:
    """A concept's fields for audit ``details`` (references by notation)."""
    if view is None:
        return None
    return {
        "prefLabels": [[language, text] for language, text in sorted(view.pref_labels.items())],
        "altLabels": [list(label) for label in view.alt_labels],
        "hiddenLabels": [list(label) for label in view.hidden_labels],
        "definition": view.definition,
        "scopeNote": view.scope_note,
        "examples": list(view.examples),
        "broader": sorted(names.get(cid, str(cid)) for cid in view.broader),
        "related": sorted(names.get(cid, str(cid)) for cid in view.related),
        "mappings": [list(mapping) for mapping in view.mappings],
        "matchPatterns": list(view.match_patterns),
        "timeSensitive": view.time_sensitive,
        "color": view.color,
        "icon": view.icon,
        "state": view.state,
        "replacedBy": sorted(names.get(cid, str(cid)) for cid in view.replaced_by),
    }


# -- Records ---------------------------------------------------------------------------


def _assignment_counts(state: str, visible: ColumnElement[bool]) -> Select[Any]:
    """``(concept_id, document_count)``: visible documents assigned the concept or one under it."""
    own = select(ItemConcept.item_id.label("item_id"), ItemConcept.concept_id.label("concept_id")).where(
        ItemConcept.state == state
    )
    rolled = (
        select(ItemConcept.item_id.label("item_id"), ConceptClosure.ancestor_id.label("concept_id"))
        .join(ConceptClosure, ConceptClosure.descendant_id == ItemConcept.concept_id)
        .where(ItemConcept.state == state, ConceptClosure.depth > 0)
    )
    rows = union_all(own, rolled).subquery("concept_assignments")
    return (
        select(rows.c.concept_id, func.count(distinct(Item.id)).label("document_count"))
        .join(Item, Item.id == rows.c.item_id)
        .where(visible)
        .group_by(rows.c.concept_id)
    )


async def visible_documents(
    authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> ColumnElement[bool]:
    return (await item_visibility(authorizer, principal, workspace_id)).clause()


def document_counts_subquery(visible: ColumnElement[bool]) -> Any:
    return _assignment_counts("accepted", visible).subquery("concept_document_counts")


async def _counts(
    session: AsyncSession, state: str, visible: ColumnElement[bool], ids: Sequence[UUID]
) -> dict[UUID, int]:
    counts = _assignment_counts(state, visible).subquery()
    rows = await session.execute(
        select(counts.c.concept_id, counts.c.document_count).where(counts.c.concept_id.in_(ids))
    )
    return {cid: int(count) for cid, count in rows}


async def concept_records(
    session: AsyncSession,
    ctx: RequestContext | None,
    scheme: ConceptScheme,
    concepts: Sequence[Concept],
    *,
    document_counts: Mapping[UUID, int] | None = None,
) -> list[ConceptRecord]:
    """Records of ``concepts`` (one scheme); counts only for a workspace scheme and a caller."""
    if not concepts:
        return []
    tenant_id = scheme.tenant_id
    views = await concept_views(session, scheme, concepts)
    notation_of = dict(
        (await session.execute(select(Concept.id, Concept.notation).where(Concept.scheme_id == scheme.id))).tuples().all()
    )
    ids = [concept.id for concept in concepts]
    groups: dict[UUID, list[str]] = {}
    for concept_id, code in (
        await session.execute(
            select(ConceptGroupMember.concept_id, ConceptGroup.code)
            .join(ConceptGroup, ConceptGroup.id == ConceptGroupMember.group_id)
            .where(ConceptGroupMember.concept_id.in_(ids))
            .order_by(ConceptGroup.position, ConceptGroup.code)
        )
    ).tuples():
        groups.setdefault(concept_id, []).append(group_name(tenant_id, scheme.code, code))
    template_ids = {concept.template_concept_id for concept in concepts if concept.template_concept_id}
    templates: dict[UUID, str] = {}
    if template_ids:
        for cid, notation, code in (
            await session.execute(
                select(Concept.id, Concept.notation, ConceptScheme.code)
                .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
                .where(Concept.id.in_(template_ids))
            )
        ).tuples():
            templates[cid] = concept_name(None, code, notation)
    in_review: dict[UUID, int] | None = None
    counts: Mapping[UUID, int] | None = document_counts
    if tenant_id is not None and ctx is not None:
        visible = await visible_documents(ctx.authorizer, ctx.principal, tenant_id)
        if counts is None:
            counts = await _counts(session, "accepted", visible, ids)
        in_review = await _counts(session, "suggested", visible, ids)

    def name(cid: UUID) -> str:
        return concept_name(tenant_id, scheme.code, notation_of.get(cid, str(cid)))

    records = []
    for concept in concepts:
        view = views[concept.id]
        pref = sorted(view.pref_labels.items())
        records.append(
            ConceptRecord(
                name=name(concept.id),
                display_name=view.pref_labels.get("vi")
                or (pref[0][1] if pref else concept.notation),
                pref_labels=tuple(pref),
                alt_labels=view.alt_labels,
                hidden_labels=view.hidden_labels,
                definition=concept.definition,
                scope_note=concept.scope_note,
                examples=tuple(concept.examples),
                broader=tuple(sorted(name(cid) for cid in view.broader)),
                related=tuple(sorted(name(cid) for cid in view.related)),
                mappings=view.mappings,
                match_patterns=tuple(concept.match_patterns),
                time_sensitive=concept.time_sensitive,
                color=concept.color,
                icon=concept.icon,
                state=api_state(concept),
                deprecation_pending=deprecation_pending(concept),
                replaced_by=tuple(sorted(name(cid) for cid in view.replaced_by)),
                groups=tuple(groups.get(concept.id, ())),
                template_concept=templates.get(concept.template_concept_id)
                if concept.template_concept_id
                else None,
                first_version=concept.first_version,
                deprecated_version=concept.deprecated_version
                if concept.state == "deprecated"
                else None,
                document_count=None if counts is None else counts.get(concept.id, 0),
                in_review_count=None if in_review is None else in_review.get(concept.id, 0),
                create_time=concept.created_at,
                update_time=concept.updated_at,
                delete_time=concept.deleted_at,
                etag=concept_etag(scheme, concept),
            )
        )
    return records


async def notation_names(session: AsyncSession, scheme_id: UUID) -> dict[UUID, str]:
    return dict(
        (await session.execute(select(Concept.id, Concept.notation).where(Concept.scheme_id == scheme_id))).tuples().all()
    )


# -- Service ---------------------------------------------------------------------------


class ConceptService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ConceptService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        notation: str,
        changes: Mapping[str, Any],
        *,
        request_id: UUID | None = None,
    ) -> ConceptRecord:
        """CreateConcept: a DRAFT concept in the working copy."""
        await authorize(ctx, tenant_id, "concepts.create", write=True)
        if not is_code(notation):
            raise InvalidArgument.for_field("conceptId", "A concept ID matches ^[a-z][a-z0-9-]{0,62}$.")
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateConcept",
                    parent=scheme_name(tenant_id, scheme_code),
                    request={"conceptId": notation, **{path: changes[path] for path in sorted(changes)}},
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    concept = await load_concept(session, scheme, replayed.rsplit("/", 1)[1])
                    return (await concept_records(session, ctx, scheme, [concept]))[0]
            concept = await self.insert(session, ctx, scheme, notation, changes)
            name = concept_name(tenant_id, scheme.code, notation)
            view = (await concept_views(session, scheme, [concept]))[concept.id]
            await audit(
                session,
                ctx,
                tenant_id,
                "CreateConcept",
                name,
                after=concept_json(view, await notation_names(session, scheme.id)),
            )
            if key is not None:
                await idempotency.remember(key, name)
            return (await concept_records(session, ctx, scheme, [concept]))[0]

    @staticmethod
    async def insert(
        session: AsyncSession,
        ctx: RequestContext | None,
        scheme: ConceptScheme,
        notation: str,
        changes: Mapping[str, Any],
        *,
        index: SchemeIndex | None = None,
        template_concept_id: UUID | None = None,
    ) -> Concept:
        """Insert a DRAFT concept with ``changes`` (no authorization, no audit)."""
        index = index or await SchemeIndex.load(session, scheme)
        concept = draft_concept(session, ctx, index, notation, template_concept_id=template_concept_id)
        await session.flush()
        await write_concept(session, index, concept, changes, current=None)
        return concept

    async def get(
        self, ctx: RequestContext, tenant_id: UUID | None, scheme_code: str, notation: str
    ) -> ConceptRecord:
        await authorize(ctx, tenant_id, "concepts.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code)
            concept = await load_concept(session, scheme, notation)
            return (await concept_records(session, ctx, scheme, [concept]))[0]

    async def list(
        self, ctx: RequestContext, tenant_id: UUID | None, scheme_code: str, query: ListQuery
    ) -> tuple[list[ConceptRecord], int]:
        await authorize(ctx, tenant_id, "concepts.list", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code)
            statement = select(Concept).where(Concept.scheme_id == scheme.id)
            if not query.show_deleted:
                statement = statement.where(Concept.deleted_at.is_(None))
            counts: dict[UUID, int] | None = None
            if tenant_id is not None:
                visible = await visible_documents(ctx.authorizer, ctx.principal, tenant_id)
                tallied = document_counts_subquery(visible)
                counted = statement.outerjoin(tallied, tallied.c.concept_id == Concept.id).add_columns(
                    func.coalesce(tallied.c.document_count, 0).label(DOCUMENT_COUNT.name)
                )
            else:
                counted = statement.add_columns(literal_column("0").label(DOCUMENT_COUNT.name))
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = (await session.execute(query.apply(counted))).tuples().all()
            if tenant_id is not None:
                counts = {concept.id: int(count) for concept, count in rows}
            records = await concept_records(
                session, ctx, scheme, [concept for concept, _ in rows], document_counts=counts
            )
            return records, total

    async def update(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        notation: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> ConceptRecord:
        await authorize(ctx, tenant_id, "concepts.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            concept = await load_concept(session, scheme, notation, for_update=True)
            etags.check(etag, concept_etag(scheme, concept))
            if concept.deleted_at is not None or concept.state == "deprecated":
                raise FailedPrecondition(f"The concept is {api_state(concept).upper()}; it cannot change.")
            names = await notation_names(session, scheme.id)
            before = (await concept_views(session, scheme, [concept]))[concept.id]
            index = await SchemeIndex.load(session, scheme)
            await write_concept(session, index, concept, changes, current=before)
            after = (await concept_views(session, scheme, [concept]))[concept.id]
            await audit(
                session,
                ctx,
                tenant_id,
                "UpdateConcept",
                concept_name(tenant_id, scheme.code, notation),
                before=concept_json(before, names),
                after=concept_json(after, names),
            )
            await session.refresh(concept)
            return (await concept_records(session, ctx, scheme, [concept]))[0]

    async def delete(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        notation: str,
        *,
        etag: str | None,
    ) -> ConceptRecord:
        """DeleteConcept: only a never-published DRAFT nothing references (tombstone)."""
        await authorize(ctx, tenant_id, "concepts.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            concept = await load_concept(session, scheme, notation, for_update=True)
            etags.check(etag, concept_etag(scheme, concept))
            if concept.deleted_at is not None:
                raise FailedPrecondition("The concept is already deleted.")
            if concept.state != "draft" or concept.first_version is not None:
                raise FailedPrecondition(
                    "Only a never-published DRAFT concept can be deleted; deprecate it instead.",
                    reason="CONCEPT_PUBLISHED",
                )
            referenced = await session.scalar(
                select(
                    exists().where(ConceptRelation.target_concept_id == concept.id)
                    | exists().where(
                        ConceptRelation.source_concept_id == concept.id, ConceptRelation.kind == "related"
                    )
                    | exists().where(ConceptGroupMember.concept_id == concept.id)
                    | exists().where(ConceptReplacement.replacement_concept_id == concept.id)
                    | exists().where(
                        ConceptRule.deleted_at.is_(None),
                        or_(ConceptRule.when_concept_id == concept.id, ConceptRule.then_concept_id == concept.id),
                    )
                )
            )
            if referenced:
                raise FailedPrecondition(
                    "Other concepts, groups or rules still name this concept.", reason="CONCEPT_IN_USE"
                )
            await session.execute(
                delete(ConceptRelation).where(ConceptRelation.source_concept_id == concept.id)
            )
            concept.deleted_at = await now(session)
            await touch(session, concept, scheme)
            await session.flush()
            await audit(session, ctx, tenant_id, "DeleteConcept", concept_name(tenant_id, scheme.code, notation))
            return (await concept_records(session, ctx, scheme, [concept]))[0]

    async def deprecate(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        notation: str,
        replaced_by: Sequence[str],
        *,
        etag: str | None,
    ) -> ConceptRecord:
        """DeprecateConcept: pending until the next publish; one replacement = merge, several = split."""
        await authorize(ctx, tenant_id, "concepts.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            concept = await load_concept(session, scheme, notation, for_update=True)
            etags.check(etag, concept_etag(scheme, concept))
            if concept.deleted_at is not None or concept.state != "published":
                raise FailedPrecondition(
                    f"Only a PUBLISHED concept is deprecated; this one is {api_state(concept).upper()}"
                    " (delete a draft instead)."
                )
            index = await SchemeIndex.load(session, scheme)
            problems: list[FieldViolation] = []
            targets = _resolve(index, list(replaced_by), "replacedBy", concept, problems)
            if problems:
                raise InvalidArgument(problems[0].description, field_violations=problems)
            children = await session.scalar(
                select(func.count())
                .select_from(ConceptRelation)
                .join(Concept, Concept.id == ConceptRelation.source_concept_id)
                .where(
                    ConceptRelation.target_concept_id == concept.id,
                    ConceptRelation.kind == "broader",
                    Concept.deleted_at.is_(None),
                    Concept.state != "deprecated",
                    Concept.deprecated_version.is_(None),
                )
            )
            if children:
                raise FailedPrecondition(
                    "The concept still has narrower concepts; move or deprecate them first.",
                    reason="CONCEPT_HAS_NARROWER",
                )
            names = await notation_names(session, scheme.id)
            before = (await concept_views(session, scheme, [concept]))[concept.id]
            await session.execute(delete(ConceptReplacement).where(ConceptReplacement.concept_id == concept.id))
            if targets:
                await session.execute(
                    insert(ConceptReplacement),
                    [{"concept_id": concept.id, "replacement_concept_id": target.id} for target in targets],
                )
            concept.deprecated_version = (scheme.published_version or 0) + 1
            await touch(session, concept, scheme)
            await session.flush()
            after = (await concept_views(session, scheme, [concept]))[concept.id]
            await audit(
                session,
                ctx,
                tenant_id,
                "DeprecateConcept",
                concept_name(tenant_id, scheme.code, notation),
                before=concept_json(before, names),
                after=concept_json(after, names),
            )
            return (await concept_records(session, ctx, scheme, [concept]))[0]


__all__ = [
    "CONCEPT_FIELDS",
    "ConceptService",
    "ConceptWrite",
    "SchemeIndex",
    "apply_writes",
    "check_concept",
    "concept_json",
    "concept_records",
    "draft_concept",
    "notation_names",
    "visible_documents",
    "write_concept",
]
