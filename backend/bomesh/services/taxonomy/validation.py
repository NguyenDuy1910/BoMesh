"""The publish validator: a pure function over the prospective version of a scheme.

``PublishConceptScheme`` (and its ``validateOnly`` preview) calls
:func:`validate` on :func:`~bomesh.services.taxonomy.support.working_snapshot`,
so the publish dialog shows exactly what publishing would block
(``item_model.md`` §4.13):

- violations (block): I2 labels disjoint within a concept and language, I3 no
  broader cycle, I4 ``related`` never joins an ancestor and a descendant, I6
  depth ≤ ``max_depth``, I7 a published concept has a definition and a ``vi``
  prefLabel, I8 a deprecated concept has no live narrower concept and is
  replaced only by published concepts of the scheme. I1 (one prefLabel per
  language) holds by construction of the snapshot and the unique index.
- warnings (never block): W1 a label shared by two concepts of the scheme, W3
  a classification scheme with fewer than 8 or more than 20 top concepts, W4
  a concept reviewers rejected at least :data:`CORRECTION_THRESHOLD` times in
  the last 90 days that has no scope note.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.snapshot import ConceptView, SchemeSnapshot

REQUIRED_LANGUAGE = "vi"
TOP_CONCEPTS = (8, 20)
CORRECTION_THRESHOLD = 3


@dataclass(frozen=True, slots=True)
class Violation:
    #: ``disjoint_labels`` | ``broader_cycle`` | ``related_in_hierarchy`` | ``max_depth``
    #: | ``definition_required`` | ``deprecation``
    invariant: str
    concepts: tuple[UUID, ...]
    message: str


@dataclass(frozen=True, slots=True)
class Finding:
    #: ``shared_label`` | ``top_concept_count`` | ``missing_scope_note``
    kind: str
    concepts: tuple[UUID, ...]
    label: str | None
    message: str


def _labels(view: ConceptView) -> list[tuple[str, str]]:
    return [
        *view.pref_labels.items(),
        *view.alt_labels,
        *view.hidden_labels,
    ]


def _cycles(snapshot: SchemeSnapshot) -> list[tuple[UUID, ...]]:
    """Each broader cycle once, as the concepts on it (iterative DFS, colours)."""
    concepts = snapshot.concepts
    colour: dict[UUID, int] = {}
    found: list[tuple[UUID, ...]] = []
    seen_cycles: set[frozenset[UUID]] = set()
    for start in sorted(concepts, key=lambda cid: concepts[cid].notation):
        if colour.get(start):
            continue
        stack: list[tuple[UUID, int]] = [(start, 0)]
        path: list[UUID] = []
        while stack:
            node, index = stack.pop()
            if index == 0:
                colour[node] = 1
                path.append(node)
            parents = [parent for parent in concepts[node].broader if parent in concepts]
            if index < len(parents):
                stack.append((node, index + 1))
                parent = parents[index]
                state = colour.get(parent, 0)
                if state == 0:
                    stack.append((parent, 0))
                elif state == 1:
                    cycle = tuple(path[path.index(parent) :])
                    key = frozenset(cycle)
                    if key not in seen_cycles:
                        seen_cycles.add(key)
                        found.append(cycle)
            else:
                colour[node] = 2
                path.pop()
    return found


def validate(
    snapshot: SchemeSnapshot, *, rejections: Mapping[UUID, int] | None = None
) -> tuple[list[Violation], list[Finding]]:
    """Violations and warnings of ``snapshot``; ``rejections`` = human rejections (90 days)."""
    concepts = snapshot.concepts
    violations: list[Violation] = []
    warnings: list[Finding] = []
    ordered = sorted(concepts.values(), key=lambda view: view.notation)
    published = [view for view in ordered if view.state == "published"]

    for view in ordered:
        seen: dict[tuple[str, str], str] = {}
        for language, text in _labels(view):
            key = (language, normalize_label(text))
            if key in seen:
                violations.append(
                    Violation(
                        "disjoint_labels",
                        (view.id,),
                        f"'{view.notation}' has the label '{text}' twice in '{language}'.",
                    )
                )
            seen[key] = text

    cycles = _cycles(snapshot)
    in_cycle = {cid for cycle in cycles for cid in cycle}
    for cycle in cycles:
        violations.append(
            Violation(
                "broader_cycle",
                cycle,
                "Broader cycle: " + " → ".join(concepts[cid].notation for cid in cycle) + ".",
            )
        )

    for view in published:
        if view.id in in_cycle:
            continue
        ancestors = snapshot.ancestors(view.id)
        for other in view.related:
            if other in ancestors or (other in concepts and view.id in snapshot.ancestors(other)):
                if str(view.id) < str(other):
                    violations.append(
                        Violation(
                            "related_in_hierarchy",
                            (view.id, other),
                            f"'{view.notation}' and '{concepts[other].notation}' are related "
                            "but one is under the other.",
                        )
                    )
        depth = snapshot.depth(view.id)
        if depth > snapshot.max_depth:
            violations.append(
                Violation(
                    "max_depth",
                    (view.id,),
                    f"'{view.notation}' is at level {depth}; the scheme allows {snapshot.max_depth}.",
                )
            )
        if not (view.definition or "").strip() or not (
            view.pref_labels.get(REQUIRED_LANGUAGE) or ""
        ).strip():
            violations.append(
                Violation(
                    "definition_required",
                    (view.id,),
                    f"'{view.notation}' needs a definition and a '{REQUIRED_LANGUAGE}' prefLabel.",
                )
            )

    for view in ordered:
        if view.state != "deprecated":
            continue
        children = [
            child.id
            for child in published
            if view.id in child.broader
        ]
        if children:
            violations.append(
                Violation(
                    "deprecation",
                    (view.id, *children),
                    f"'{view.notation}' is deprecated but still has narrower concepts.",
                )
            )
        bad = [
            target
            for target in view.replaced_by
            if target not in concepts or concepts[target].state != "published"
        ]
        if bad:
            violations.append(
                Violation(
                    "deprecation",
                    (view.id, *(target for target in bad if target in concepts)),
                    f"'{view.notation}' is replaced by concepts that are not published.",
                )
            )

    holders: dict[str, list[UUID]] = {}
    for view in published:
        for _language, text in _labels(view):
            normalized = normalize_label(text)
            owners = holders.setdefault(normalized, [])
            if view.id not in owners:
                owners.append(view.id)
    for label, owners in sorted(holders.items()):
        if len(owners) > 1:
            warnings.append(
                Finding(
                    "shared_label",
                    tuple(owners),
                    label,
                    f"'{label}' is a label of "
                    + ", ".join(concepts[cid].notation for cid in owners)
                    + ".",
                )
            )

    if snapshot.purpose == "classification":
        tops = [view for view in published if snapshot.is_top(view.id)]
        low, high = TOP_CONCEPTS
        if tops and not low <= len(tops) <= high:
            warnings.append(
                Finding(
                    "top_concept_count",
                    (),
                    None,
                    f"The scheme has {len(tops)} top concepts; {low}–{high} is recommended.",
                )
            )

    for view in published:
        count = (rejections or {}).get(view.id, 0)
        if count >= CORRECTION_THRESHOLD and not (view.scope_note or "").strip():
            warnings.append(
                Finding(
                    "missing_scope_note",
                    (view.id,),
                    None,
                    f"Reviewers removed '{view.notation}' {count} times in 90 days; "
                    "add a scope note.",
                )
            )
    return violations, warnings


__all__ = ["CORRECTION_THRESHOLD", "Finding", "Violation", "validate"]
