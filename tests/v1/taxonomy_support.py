"""Published concept schemes, rules, assignments and profiles for tests that read the taxonomy.

Writes the working rows (schemes, concepts, labels, relations, mappings, groups),
then publishes the way ``:publish`` leaves them: a ``concept_scheme_versions``
snapshot, ``published_version`` and the ``concept_closure`` of the published graph.
:func:`seed_taxonomy` publishes several schemes (:class:`S`) and creates
``concept_rules`` (:class:`R`) in one call.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Concept,
    ConceptClosure,
    ConceptGroup,
    ConceptGroupMember,
    ConceptLabel,
    ConceptMapping,
    ConceptRelation,
    ConceptRule,
    ConceptScheme,
    ConceptSchemeVersion,
    DocumentApplicability,
    DocumentProfile,
    DocumentSupersession,
    ItemConcept,
    MemberAffiliation,
    Tenant,
    User,
)
from bomesh.services.taxonomy.closure import closure_rows
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.snapshot import ConceptView, GroupView, SchemeSnapshot, snapshot_json
from harness import Sessions


@dataclass(frozen=True, slots=True)
class C:
    """One concept: notation, Vietnamese prefLabel and the rest of its published facts."""

    notation: str
    pref: str
    alt: tuple[str, ...] = ()
    hidden: tuple[str, ...] = ()
    broader: tuple[str, ...] = ()
    time_sensitive: bool = False
    color: str | None = None
    icon: str | None = None
    definition: str | None = None
    #: (target_system, target_code, match_type)
    mappings: tuple[tuple[str, str, str], ...] = ()
    pref_en: str | None = None
    scope_note: str | None = None
    examples: tuple[str, ...] = ()
    match_patterns: tuple[str, ...] = ()
    #: Notations of related concepts of the same scheme.
    related: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class G:
    code: str
    name: str
    members: tuple[str, ...]
    query_expansion: bool = False


@dataclass(slots=True)
class Published:
    scheme_id: UUID
    code: str
    ids: dict[str, UUID] = field(default_factory=dict)

    def __getitem__(self, notation: str) -> UUID:
        return self.ids[notation]


async def publish_scheme(
    sessions: Sessions,
    tenant_id: UUID,
    publisher: UUID,
    code: str,
    concepts: Sequence[C],
    *,
    name: str | None = None,
    purpose: str = "classification",
    position: int = 0,
    groups: Sequence[G] = (),
    assign_top_concepts: bool = True,
    max_depth: int = 3,
    max_labels: int | None = None,
    min_labels: int = 0,
    has_primary: bool = False,
    llm_policy: str | None = None,
    section_assignments: bool = False,
    auto_threshold: float | None = None,
    review_threshold: float | None = None,
) -> Published:
    """Create scheme ``code`` with ``concepts`` (all PUBLISHED) and publish it as version 1.

    ``llm_policy`` defaults to ``always`` for a classification scheme, ``never`` otherwise.
    """
    classification = purpose == "classification"
    scheme = ConceptScheme(
        id=uuid4(),
        tenant_id=tenant_id,
        code=code,
        scheme_name=name or code,
        purpose=purpose,
        position=position,
        max_depth=max_depth,
        min_labels=min_labels,
        max_labels=max_labels,
        has_primary=has_primary,
        assign_top_concepts=assign_top_concepts,
        section_assignments=section_assignments,
        llm_policy=llm_policy or ("always" if classification else "never"),
        auto_threshold=None if auto_threshold is None else Decimal(str(auto_threshold)),
        review_threshold=None if review_threshold is None else Decimal(str(review_threshold)),
        published_version=1,
    )
    ids = {spec.notation: uuid4() for spec in concepts}
    views: dict[UUID, ConceptView] = {}
    async with transaction_scope(sessions) as session:
        session.add(scheme)
        await session.flush()
        for spec in concepts:
            session.add(
                Concept(
                    id=ids[spec.notation],
                    tenant_id=tenant_id,
                    scheme_id=scheme.id,
                    notation=spec.notation,
                    definition=spec.definition or spec.pref,
                    scope_note=spec.scope_note,
                    examples=list(spec.examples),
                    match_patterns=list(spec.match_patterns),
                    color=spec.color,
                    icon=spec.icon,
                    time_sensitive=spec.time_sensitive,
                    state="published",
                    first_version=1,
                )
            )
        await session.flush()
        for spec in concepts:
            cid = ids[spec.notation]
            labels = [("pref", "vi", spec.pref)]
            if spec.pref_en:
                labels.append(("pref", "en", spec.pref_en))
            labels += [("alt", "vi", text) for text in spec.alt]
            labels += [("hidden", "vi", text) for text in spec.hidden]
            for kind, language, text in labels:
                session.add(
                    ConceptLabel(
                        concept_id=cid,
                        kind=kind,
                        language_code=language,
                        label_text=text,
                        normalized=normalize_label(text),
                    )
                )
            for parent in spec.broader:
                session.add(
                    ConceptRelation(
                        source_concept_id=cid, target_concept_id=ids[parent], kind="broader"
                    )
                )
            for other in spec.related:
                source, target = sorted((cid, ids[other]))
                session.add(
                    ConceptRelation(
                        source_concept_id=source, target_concept_id=target, kind="related"
                    )
                )
            for system, target, match in spec.mappings:
                session.add(
                    ConceptMapping(
                        concept_id=cid, target_system=system, target_code=target, match_type=match
                    )
                )
            views[cid] = ConceptView(
                id=cid,
                notation=spec.notation,
                scheme_code=code,
                state="published",
                pref_labels={"vi": spec.pref, **({"en": spec.pref_en} if spec.pref_en else {})},
                alt_labels=tuple(("vi", text) for text in spec.alt),
                hidden_labels=tuple(("vi", text) for text in spec.hidden),
                definition=spec.definition or spec.pref,
                scope_note=spec.scope_note,
                examples=spec.examples,
                color=spec.color,
                icon=spec.icon,
                match_patterns=spec.match_patterns,
                time_sensitive=spec.time_sensitive,
                broader=tuple(ids[parent] for parent in spec.broader),
                related=tuple(ids[other] for other in spec.related),
                mappings=tuple((system, target, None, match) for system, target, match in spec.mappings),
            )
        group_views = []
        for position_in_scheme, group in enumerate(groups):
            row = ConceptGroup(
                id=uuid4(),
                scheme_id=scheme.id,
                code=group.code,
                group_name=group.name,
                position=position_in_scheme,
                query_expansion=group.query_expansion,
            )
            session.add(row)
            await session.flush()
            for position_in_group, member in enumerate(group.members):
                session.add(
                    ConceptGroupMember(
                        group_id=row.id, concept_id=ids[member], position=position_in_group
                    )
                )
            group_views.append(
                GroupView(
                    id=row.id,
                    code=group.code,
                    name=group.name,
                    position=position_in_scheme,
                    query_expansion=group.query_expansion,
                    members=tuple(ids[member] for member in group.members),
                )
            )
        snapshot = SchemeSnapshot(
            scheme_id=scheme.id,
            code=code,
            name=scheme.scheme_name,
            purpose=purpose,
            version=1,
            position=position,
            min_labels=min_labels,
            max_labels=max_labels,
            has_primary=has_primary,
            max_depth=max_depth,
            assign_top_concepts=assign_top_concepts,
            section_assignments=section_assignments,
            llm_policy=scheme.llm_policy,
            auto_threshold=auto_threshold,
            review_threshold=review_threshold,
            concepts=views,
            groups=tuple(group_views),
        )
        session.add(
            ConceptSchemeVersion(
                scheme_id=scheme.id,
                version=1,
                published_by_user_id=publisher,
                snapshot=snapshot_json(snapshot),
            )
        )
        for ancestor, descendant, depth in closure_rows(snapshot):
            session.add(ConceptClosure(ancestor_id=ancestor, descendant_id=descendant, depth=depth))
    return Published(scheme_id=scheme.id, code=code, ids=ids)


@dataclass(frozen=True, slots=True)
class S:
    """One scheme of :func:`seed_taxonomy`: its concepts and settings (see :func:`publish_scheme`)."""

    concepts: tuple[C, ...]
    name: str | None = None
    purpose: str = "classification"
    min_labels: int = 0
    max_labels: int | None = None
    has_primary: bool = False
    llm_policy: str | None = None
    section_assignments: bool = False
    assign_top_concepts: bool = True
    max_depth: int = 3
    auto_threshold: float | None = None
    review_threshold: float | None = None
    groups: tuple[G, ...] = ()


@dataclass(frozen=True, slots=True)
class R:
    """One ``concept_rules`` row; concepts as ``(scheme code, notation)``, exactly one ``when_*``."""

    code: str
    then: tuple[str, str]
    when_concept: tuple[str, str] | None = None
    when_collection: UUID | None = None
    when_source: UUID | None = None
    effect: str = "implies"
    weight: float | None = None


@dataclass(slots=True)
class Taxonomy:
    """What :func:`seed_taxonomy` created: published schemes by code and rule ids by code."""

    schemes: dict[str, Published] = field(default_factory=dict)
    rules: dict[str, UUID] = field(default_factory=dict)

    def __getitem__(self, code: str) -> Published:
        return self.schemes[code]

    def concept(self, scheme: str, notation: str) -> UUID:
        return self.schemes[scheme][notation]


async def seed_taxonomy(
    sessions: Sessions,
    workspace: Tenant | UUID,
    publisher: User | UUID,
    spec: Mapping[str, S],
    *,
    rules: Sequence[R] = (),
) -> Taxonomy:
    """Publish every scheme of ``spec`` (positions in mapping order), then create ``rules``."""
    tenant_id = workspace if isinstance(workspace, UUID) else workspace.id
    publisher_id = publisher if isinstance(publisher, UUID) else publisher.id
    taxonomy = Taxonomy()
    for position, (code, scheme) in enumerate(spec.items()):
        taxonomy.schemes[code] = await publish_scheme(
            sessions,
            tenant_id,
            publisher_id,
            code,
            scheme.concepts,
            name=scheme.name,
            purpose=scheme.purpose,
            position=position,
            groups=scheme.groups,
            assign_top_concepts=scheme.assign_top_concepts,
            max_depth=scheme.max_depth,
            max_labels=scheme.max_labels,
            min_labels=scheme.min_labels,
            has_primary=scheme.has_primary,
            llm_policy=scheme.llm_policy,
            section_assignments=scheme.section_assignments,
            auto_threshold=scheme.auto_threshold,
            review_threshold=scheme.review_threshold,
        )
    for spec_rule in rules:
        taxonomy.rules[spec_rule.code] = await rule(sessions, tenant_id, taxonomy, spec_rule)
    return taxonomy


async def rule(sessions: Sessions, tenant_id: UUID, taxonomy: Taxonomy, spec: R) -> UUID:
    """Create one live ``concept_rules`` row of the tenant."""
    row = ConceptRule(
        id=uuid4(),
        tenant_id=tenant_id,
        code=spec.code,
        when_concept_id=None if spec.when_concept is None else taxonomy.concept(*spec.when_concept),
        when_collection_item_id=spec.when_collection,
        when_ingestion_source_id=spec.when_source,
        then_concept_id=taxonomy.concept(*spec.then),
        effect=spec.effect,
        weight=None if spec.weight is None else Decimal(str(spec.weight)),
    )
    async with transaction_scope(sessions) as session:
        session.add(row)
    return row.id


async def label(
    sessions: Sessions,
    item_id: UUID,
    scheme: Published,
    *notations: str,
    state: str = "accepted",
    source: str = "human",
    primary: str | None = None,
) -> None:
    """Assign ``notations`` of ``scheme`` to the document (whole document)."""
    async with transaction_scope(sessions) as session:
        for notation in notations:
            session.add(
                ItemConcept(
                    item_id=item_id,
                    concept_id=scheme[notation],
                    scheme_id=scheme.scheme_id,
                    is_primary=notation == primary,
                    source=source,
                    state=state,
                    confidence=None if source == "human" else 0.9,
                )
            )


async def profile(
    sessions: Sessions,
    item_id: UUID,
    *,
    level: str | None = None,
    applies_to: Iterable[UUID] = (),
    cohorts: Sequence[int] = (),
    issued_on: date | None = None,
    issuer: UUID | None = None,
    source: str = "human",
    confidence: float | None = None,
    supersedes: Iterable[UUID] = (),
) -> None:
    """The document's profile: applicability (``source`` human or extracted), issue date."""
    sources: dict[str, str] = {}
    if level is not None:
        sources["applicability"] = source
    if issued_on is not None:
        sources["issue_date"] = source
    if issuer is not None:
        sources["issuer"] = source
    async with transaction_scope(sessions) as session:
        session.add(
            DocumentProfile(
                item_id=item_id,
                issuer_concept_id=issuer,
                issued_on=issued_on,
                applicability_level=level,
                applicability_cohorts=list(cohorts),
                applicability_confidence=(
                    confidence if confidence is not None else (1.0 if source == "human" else None)
                ),
                field_sources=sources,
            )
        )
        await session.flush()
        for concept_id in applies_to:
            session.add(DocumentApplicability(item_id=item_id, concept_id=concept_id))
        for superseded in supersedes:
            session.add(
                DocumentSupersession(item_id=item_id, superseded_item_id=superseded, source=source)
            )


async def affiliate(
    sessions: Sessions,
    tenant_id: UUID,
    user_id: UUID,
    concepts: Iterable[UUID],
    *,
    cohort: int | None = None,
    source: str = "directory",
) -> None:
    async with transaction_scope(sessions) as session:
        for concept_id in concepts:
            session.add(
                MemberAffiliation(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    concept_id=concept_id,
                    cohort=cohort,
                    source=source,
                )
            )


def ids_of(published: Mapping[str, Published], *pairs: tuple[str, str]) -> list[UUID]:
    return [published[scheme][notation] for scheme, notation in pairs]


__all__ = [
    "C",
    "G",
    "Published",
    "R",
    "S",
    "Taxonomy",
    "affiliate",
    "ids_of",
    "label",
    "profile",
    "publish_scheme",
    "rule",
    "seed_taxonomy",
]
