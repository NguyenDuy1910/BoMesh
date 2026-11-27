"""Pure comparison of two scheme versions: the publish diff and the reclassification it needs.

``changes`` and ``reclassification`` are stored in ``concept_scheme_versions``
with concept IDs as strings (snake_case keys); the API renders them with
resource names. Per ``api_design.md`` ConceptScheme ``:publish``: renames, definition edits, moves,
settings and group changes reclassify nothing; a merge (one replacement) is
remapped in SQL by the publish; a split reranks the old concept's documents
among its replacements; a new narrower concept reruns its parent's documents
among the parent and its children; changed thresholds re-route stored
confidences; changed ``matchPatterns`` (``patterns_changed``) re-evaluate the
scheme's pattern labels without the model, like a rule change. Deprecations
without replacement are derived by the reclassification itself.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models.taxonomy import ConceptScheme, ConceptSchemeVersion
from bomesh.services.taxonomy.snapshot import ConceptView, SchemeSnapshot, from_json

_SETTINGS = (
    "name",
    "position",
    "min_labels",
    "max_labels",
    "has_primary",
    "max_depth",
    "assign_top_concepts",
    "section_assignments",
    "llm_policy",
)
_KIND_ORDER = (
    "added",
    "relabeled",
    "redefined",
    "moved",
    "deprecated",
    "thresholds",
    "settings",
    "groups",
)


def _labels(view: ConceptView) -> tuple[Any, ...]:
    return (
        tuple(sorted(view.pref_labels.items())),
        tuple(sorted(view.alt_labels)),
        tuple(sorted(view.hidden_labels)),
    )


def _definition(view: ConceptView) -> tuple[Any, ...]:
    return (
        view.definition,
        view.scope_note,
        tuple(view.examples),
        tuple(sorted(view.related, key=str)),
        tuple(sorted(view.mappings)),
        tuple(view.match_patterns),
        view.color,
        view.icon,
        view.time_sensitive,
    )


def diff(previous: SchemeSnapshot | None, current: SchemeSnapshot) -> list[dict[str, Any]]:
    """The ``changes`` of ``current`` against ``previous`` (None: everything is added)."""
    found: list[tuple[int, str, dict[str, Any]]] = []

    def add(kind: str, sort_key: str, entry: dict[str, Any]) -> None:
        found.append((_KIND_ORDER.index(kind), sort_key, {"kind": kind, **entry}))

    before = previous.concepts if previous is not None else {}
    for cid, view in current.concepts.items():
        old = before.get(cid)
        if old is None:
            if view.state == "published":
                add("added", view.notation, {"concept": str(cid)})
            continue
        if old.state == "published" and view.state == "deprecated":
            add(
                "deprecated",
                view.notation,
                {"concept": str(cid), "replaced_by": [str(value) for value in view.replaced_by]},
            )
            continue
        if view.state != "published":
            continue
        if _labels(old) != _labels(view):
            add("relabeled", view.notation, {"concept": str(cid)})
        if _definition(old) != _definition(view):
            add("redefined", view.notation, {"concept": str(cid)})
        if set(old.broader) != set(view.broader):
            add("moved", view.notation, {"concept": str(cid)})
    if previous is not None:
        if (previous.auto_threshold, previous.review_threshold) != (
            current.auto_threshold,
            current.review_threshold,
        ):
            add("thresholds", "", {})
        if any(getattr(previous, name) != getattr(current, name) for name in _SETTINGS):
            add("settings", "", {})
    old_groups = {group.code: group for group in previous.groups} if previous else {}
    new_groups = {group.code: group for group in current.groups}
    for code in sorted(set(old_groups) | set(new_groups)):
        old_group, new_group = old_groups.get(code), new_groups.get(code)
        if old_group is None or new_group is None or (
            old_group.name,
            old_group.position,
            old_group.query_expansion,
            old_group.members,
        ) != (new_group.name, new_group.position, new_group.query_expansion, new_group.members):
            add("groups", code, {"group": code})
    return [entry for _, _, entry in sorted(found, key=lambda item: (item[0], item[1]))]


def reclassification(
    previous: SchemeSnapshot | None, current: SchemeSnapshot, changes: list[dict[str, Any]]
) -> dict[str, Any]:
    """The ``reclassification`` plan of a publish (``remapped`` is filled by the publish)."""
    rerank: list[dict[str, Any]] = []
    parents: dict[UUID, set[UUID]] = {}
    patterns: list[UUID] = []
    thresholds = False
    if current.purpose == "classification":
        before = previous.concepts if previous is not None else {}
        if previous is not None:
            for view in current.concepts.values():
                old = before.get(view.id)
                old_patterns = old.match_patterns if old is not None and old.state == "published" else ()
                if view.state == "published" and tuple(old_patterns) != tuple(view.match_patterns):
                    patterns.append(view.id)
        for entry in changes:
            kind = entry["kind"]
            if kind == "deprecated" and len(entry["replaced_by"]) >= 2:
                among = sorted(entry["replaced_by"], key=lambda cid: current.concepts[UUID(cid)].notation)
                rerank.append({"concept": entry["concept"], "among": among})
            elif kind == "added" and previous is not None:
                view = current.concepts[UUID(entry["concept"])]
                for parent in view.broader:
                    old = before.get(parent)
                    if old is not None and old.state == "published":
                        parents.setdefault(parent, set())
            elif kind == "thresholds":
                thresholds = True
    targets = {view.id for view in current.targets()}
    rerun_parents = []
    for parent in sorted(parents, key=lambda cid: current.concepts[cid].notation):
        children = [
            child.id
            for child in current.concepts.values()
            if child.state == "published" and parent in child.broader
        ]
        among = ([parent] if parent in targets else []) + sorted(
            (child for child in children if child in targets), key=lambda cid: current.concepts[cid].notation
        )
        rerun_parents.append({"parent": str(parent), "among": [str(cid) for cid in among]})
    return {
        "remapped": 0,
        "rerank": rerank,
        "rerun_parents": rerun_parents,
        "patterns_changed": [
            str(cid) for cid in sorted(patterns, key=lambda cid: current.concepts[cid].notation)
        ],
        "thresholds_changed": thresholds,
        "state": "pending",
    }


async def published_snapshot(
    session: AsyncSession, scheme: ConceptScheme, version: int | None = None
) -> SchemeSnapshot | None:
    """The stored snapshot of ``version`` (default: the current published one)."""
    version = version if version is not None else scheme.published_version
    if version is None:
        return None
    data = await session.scalar(
        select(ConceptSchemeVersion.snapshot).where(
            ConceptSchemeVersion.scheme_id == scheme.id, ConceptSchemeVersion.version == version
        )
    )
    return None if data is None else from_json(data)


__all__ = ["diff", "published_snapshot", "reclassification"]
