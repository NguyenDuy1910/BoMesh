"""The published taxonomy as immutable values: the input of classification and query mapping.

A :class:`SchemeSnapshot` is stored as ``concept_scheme_versions.snapshot``
(:func:`snapshot_json` / :func:`from_json`, snake_case keys) and loaded per
tenant by :func:`load_published`, cached in-process by (scheme, version):
a published version never changes.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models.taxonomy import ConceptScheme, ConceptSchemeVersion

#: (language_code, label_text)
Label = tuple[str, str]
#: (target_system, target_code, target_label, match_type)
MappingValue = tuple[str, str, str | None, str]


@dataclass(frozen=True, slots=True)
class ConceptView:
    id: UUID
    notation: str
    scheme_code: str
    state: str
    #: language_code → prefLabel.
    pref_labels: Mapping[str, str]
    alt_labels: tuple[Label, ...] = ()
    hidden_labels: tuple[Label, ...] = ()
    definition: str | None = None
    scope_note: str | None = None
    examples: tuple[str, ...] = ()
    color: str | None = None
    icon: str | None = None
    match_patterns: tuple[str, ...] = ()
    time_sensitive: bool = False
    broader: tuple[UUID, ...] = ()
    related: tuple[UUID, ...] = ()
    replaced_by: tuple[UUID, ...] = ()
    mappings: tuple[MappingValue, ...] = ()


@dataclass(frozen=True, slots=True)
class GroupView:
    id: UUID
    code: str
    name: str
    position: int
    query_expansion: bool
    members: tuple[UUID, ...] = ()


@dataclass(frozen=True, slots=True)
class SchemeSnapshot:
    """One published scheme version: settings, concepts (published and deprecated), groups."""

    scheme_id: UUID
    code: str
    name: str
    purpose: str
    version: int
    position: int
    min_labels: int
    max_labels: int | None
    has_primary: bool
    max_depth: int
    assign_top_concepts: bool
    section_assignments: bool
    llm_policy: str
    auto_threshold: float | None
    review_threshold: float | None
    concepts: Mapping[UUID, ConceptView]
    groups: tuple[GroupView, ...] = ()
    _narrower: Mapping[UUID, tuple[UUID, ...]] = field(
        init=False, repr=False, compare=False
    )

    def __post_init__(self) -> None:
        narrower: dict[UUID, list[UUID]] = {}
        for concept in self.concepts.values():
            for parent in concept.broader:
                if parent in self.concepts:
                    narrower.setdefault(parent, []).append(concept.id)
        object.__setattr__(
            self, "_narrower", {key: tuple(value) for key, value in narrower.items()}
        )

    def _walk(self, cid: UUID, step: Any) -> dict[UUID, int]:
        distances: dict[UUID, int] = {}
        queue = deque([(cid, 0)])
        seen = {cid}
        while queue:
            current, distance = queue.popleft()
            for following in step(current):
                if following not in seen and following in self.concepts:
                    seen.add(following)
                    distances[following] = distance + 1
                    queue.append((following, distance + 1))
        return distances

    def ancestors(self, cid: UUID) -> dict[UUID, int]:
        """Ancestor → shortest broader distance (self excluded); multi-parent safe."""

        return self._walk(cid, lambda current: self.concepts[current].broader)

    def descendants(self, cid: UUID) -> dict[UUID, int]:
        """Descendant → shortest narrower distance (self excluded)."""

        return self._walk(cid, lambda current: self._narrower.get(current, ()))

    def is_top(self, cid: UUID) -> bool:
        return not any(parent in self.concepts for parent in self.concepts[cid].broader)

    def depth(self, cid: UUID) -> int:
        """Level of the concept: 1 for a top concept, else 1 + its deepest parent's level."""

        levels: dict[UUID, int] = {}

        def level(current: UUID, path: frozenset[UUID]) -> int:
            if current in levels:
                return levels[current]
            parents = [
                parent
                for parent in self.concepts[current].broader
                if parent in self.concepts and parent not in path
            ]
            value = 1 + max((level(parent, path | {current}) for parent in parents), default=0)
            levels[current] = value
            return value

        return level(cid, frozenset())

    def color_of(self, cid: UUID) -> str | None:
        """The concept's color, else the nearest colored ancestor's (ties by notation)."""

        own = self.concepts[cid].color
        if own is not None:
            return own
        colored = [
            (distance, self.concepts[ancestor].notation, self.concepts[ancestor].color)
            for ancestor, distance in self.ancestors(cid).items()
            if self.concepts[ancestor].color is not None
        ]
        return min(colored)[2] if colored else None

    def targets(self) -> tuple[ConceptView, ...]:
        """Published concepts a Document may be labeled with, by notation."""

        return tuple(
            concept
            for concept in sorted(self.concepts.values(), key=lambda view: view.notation)
            if concept.state == "published"
            and (self.assign_top_concepts or not self.is_top(concept.id))
        )


@dataclass(frozen=True, slots=True)
class TaxonomySnapshot:
    """Every published scheme of one tenant, by scheme code."""

    tenant_id: UUID
    schemes: Mapping[str, SchemeSnapshot]

    def by_concept(self, cid: UUID) -> ConceptView | None:
        for scheme in self.schemes.values():
            concept = scheme.concepts.get(cid)
            if concept is not None:
                return concept
        return None


def _labels(labels: Iterable[Label]) -> list[list[str]]:
    return [[language, label] for language, label in labels]


def _ids(ids: Iterable[UUID]) -> list[str]:
    return [str(value) for value in ids]


def snapshot_json(scheme: SchemeSnapshot) -> dict[str, Any]:
    """The JSON stored in ``concept_scheme_versions.snapshot`` (concepts ordered by notation)."""

    return {
        "scheme_id": str(scheme.scheme_id),
        "code": scheme.code,
        "name": scheme.name,
        "purpose": scheme.purpose,
        "version": scheme.version,
        "position": scheme.position,
        "min_labels": scheme.min_labels,
        "max_labels": scheme.max_labels,
        "has_primary": scheme.has_primary,
        "max_depth": scheme.max_depth,
        "assign_top_concepts": scheme.assign_top_concepts,
        "section_assignments": scheme.section_assignments,
        "llm_policy": scheme.llm_policy,
        "auto_threshold": scheme.auto_threshold,
        "review_threshold": scheme.review_threshold,
        "concepts": [
            {
                "id": str(concept.id),
                "notation": concept.notation,
                "state": concept.state,
                "pref_labels": dict(sorted(concept.pref_labels.items())),
                "alt_labels": _labels(concept.alt_labels),
                "hidden_labels": _labels(concept.hidden_labels),
                "definition": concept.definition,
                "scope_note": concept.scope_note,
                "examples": list(concept.examples),
                "color": concept.color,
                "icon": concept.icon,
                "match_patterns": list(concept.match_patterns),
                "time_sensitive": concept.time_sensitive,
                "broader": _ids(concept.broader),
                "related": _ids(concept.related),
                "replaced_by": _ids(concept.replaced_by),
                "mappings": [list(mapping) for mapping in concept.mappings],
            }
            for concept in sorted(scheme.concepts.values(), key=lambda view: view.notation)
        ],
        "groups": [
            {
                "id": str(group.id),
                "code": group.code,
                "name": group.name,
                "position": group.position,
                "query_expansion": group.query_expansion,
                "members": _ids(group.members),
            }
            for group in scheme.groups
        ],
    }


def _float(value: Any) -> float | None:
    return None if value is None else float(value)


def from_json(data: Mapping[str, Any]) -> SchemeSnapshot:
    """Inverse of :func:`snapshot_json`."""

    code = data["code"]
    concepts = {}
    for raw in data["concepts"]:
        concept = ConceptView(
            id=UUID(raw["id"]),
            notation=raw["notation"],
            scheme_code=code,
            state=raw["state"],
            pref_labels=dict(raw["pref_labels"]),
            alt_labels=tuple((language, label) for language, label in raw["alt_labels"]),
            hidden_labels=tuple(
                (language, label) for language, label in raw["hidden_labels"]
            ),
            definition=raw["definition"],
            scope_note=raw["scope_note"],
            examples=tuple(raw["examples"]),
            color=raw["color"],
            icon=raw["icon"],
            match_patterns=tuple(raw["match_patterns"]),
            time_sensitive=raw["time_sensitive"],
            broader=tuple(UUID(value) for value in raw["broader"]),
            related=tuple(UUID(value) for value in raw["related"]),
            replaced_by=tuple(UUID(value) for value in raw["replaced_by"]),
            mappings=tuple(
                (system, target, label, match) for system, target, label, match in raw["mappings"]
            ),
        )
        concepts[concept.id] = concept
    return SchemeSnapshot(
        scheme_id=UUID(data["scheme_id"]),
        code=code,
        name=data["name"],
        purpose=data["purpose"],
        version=data["version"],
        position=data["position"],
        min_labels=data["min_labels"],
        max_labels=data["max_labels"],
        has_primary=data["has_primary"],
        max_depth=data["max_depth"],
        assign_top_concepts=data["assign_top_concepts"],
        section_assignments=data["section_assignments"],
        llm_policy=data["llm_policy"],
        auto_threshold=_float(data["auto_threshold"]),
        review_threshold=_float(data["review_threshold"]),
        concepts=concepts,
        groups=tuple(
            GroupView(
                id=UUID(group["id"]),
                code=group["code"],
                name=group["name"],
                position=group["position"],
                query_expansion=group["query_expansion"],
                members=tuple(UUID(value) for value in group["members"]),
            )
            for group in data["groups"]
        ),
    )


#: (scheme_id, version) → parsed snapshot; published versions are immutable.
_CACHE: dict[tuple[UUID, int], SchemeSnapshot] = {}


async def published_versions(
    session: AsyncSession, keys: Iterable[tuple[UUID, int]]
) -> dict[tuple[UUID, int], SchemeSnapshot]:
    """The stored snapshots of ``(scheme_id, version)`` keys (absent keys left out), one query at most."""
    wanted = list(dict.fromkeys(keys))
    missing = [key for key in wanted if key not in _CACHE]
    if missing:
        rows = await session.execute(
            select(
                ConceptSchemeVersion.scheme_id,
                ConceptSchemeVersion.version,
                ConceptSchemeVersion.snapshot,
            ).where(
                tuple_(ConceptSchemeVersion.scheme_id, ConceptSchemeVersion.version).in_(
                    missing
                )
            )
        )
        for scheme_id, version, snapshot in rows:
            _CACHE[(scheme_id, version)] = from_json(snapshot)
    return {key: _CACHE[key] for key in wanted if key in _CACHE}


async def load_published(session: AsyncSession, tenant_id: UUID) -> TaxonomySnapshot:
    """The current published version of every live scheme of the tenant."""

    current = (
        await session.execute(
            select(ConceptScheme.id, ConceptScheme.published_version).where(
                ConceptScheme.tenant_id == tenant_id,
                ConceptScheme.deleted_at.is_(None),
                ConceptScheme.published_version.is_not(None),
            )
        )
    ).all()
    keys = [(scheme_id, version) for scheme_id, version in current]
    found = await published_versions(session, keys)
    schemes = {snapshot.code: snapshot for snapshot in (found[key] for key in keys if key in found)}
    return TaxonomySnapshot(tenant_id=tenant_id, schemes=schemes)
