"""ListSharedLabels: normalized labels held by several concepts of a workspace.

Across schemes (W2, valid: queries resolve them by context) the labels come
from the ``cross_scheme_labels`` view over published concepts; within one
scheme (W1, a warning the publish dialog also shows) from the working copy.
One record per label and scheme set, ordered by label.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import Column, MetaData, Table, Text, distinct, func, select
from sqlalchemy.dialects.postgresql import ARRAY, UUID as PG_UUID

from bomesh.db.engine import transaction_scope
from bomesh.db.models.taxonomy import Concept, ConceptLabel, ConceptScheme
from bomesh.services.kernel.context import RequestContext
from bomesh.services.taxonomy.names import concept_name, scheme_name
from bomesh.services.taxonomy.records import SharedLabelEntry, SharedLabelRecord
from bomesh.services.taxonomy.support import TaxonomyDeps, authorize

_CROSS = Table(
    "cross_scheme_labels",
    MetaData(),
    Column("tenant_id", PG_UUID(as_uuid=True)),
    Column("normalized", Text),
    Column("scheme_ids", ARRAY(PG_UUID(as_uuid=True))),
    Column("concept_ids", ARRAY(PG_UUID(as_uuid=True))),
)


class SharedLabelService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> SharedLabelService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        cross_scheme: bool | None = None,
        scheme_code: str | None = None,
    ) -> list[SharedLabelRecord]:
        await authorize(ctx, workspace_id, "conceptSchemes.get", write=False)
        groups: list[tuple[str, bool, set[UUID]]] = []
        async with transaction_scope(self._deps.sessions) as session:
            if cross_scheme is not False:
                for normalized, concept_ids in (
                    await session.execute(
                        select(_CROSS.c.normalized, _CROSS.c.concept_ids).where(_CROSS.c.tenant_id == workspace_id)
                    )
                ).tuples():
                    groups.append((normalized, True, set(concept_ids)))
            if cross_scheme is not True:
                same = (
                    select(
                        ConceptLabel.normalized,
                        Concept.scheme_id,
                        func.array_agg(distinct(Concept.id)),
                    )
                    .join(Concept, Concept.id == ConceptLabel.concept_id)
                    .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
                    .where(
                        ConceptScheme.tenant_id == workspace_id,
                        ConceptScheme.deleted_at.is_(None),
                        Concept.deleted_at.is_(None),
                        Concept.state != "deprecated",
                    )
                    .group_by(ConceptLabel.normalized, Concept.scheme_id)
                    .having(func.count(distinct(Concept.id)) > 1)
                )
                for normalized, _scheme_id, concept_ids in (await session.execute(same)).tuples():
                    groups.append((normalized, False, set(concept_ids)))
            ids = {cid for _, _, concept_ids in groups for cid in concept_ids}
            labels: dict[UUID, list[tuple[str, str, str, str]]] = {}
            concepts: dict[UUID, tuple[str, str]] = {}
            if ids:
                for cid, notation, code, normalized, kind, language, text in (
                    await session.execute(
                        select(
                            Concept.id,
                            Concept.notation,
                            ConceptScheme.code,
                            ConceptLabel.normalized,
                            ConceptLabel.kind,
                            ConceptLabel.language_code,
                            ConceptLabel.label_text,
                        )
                        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
                        .join(ConceptLabel, ConceptLabel.concept_id == Concept.id)
                        .where(Concept.id.in_(ids))
                    )
                ).tuples():
                    concepts[cid] = (notation, code)
                    labels.setdefault(cid, []).append((normalized, kind, language, text))
        records: list[SharedLabelRecord] = []
        for normalized, cross, concept_ids in sorted(groups, key=lambda group: (group[0], not group[1])):
            schemes = {concepts[cid][1] for cid in concept_ids if cid in concepts}
            if scheme_code is not None and scheme_code not in schemes:
                continue
            entries = sorted(
                (
                    SharedLabelEntry(
                        concept=concept_name(workspace_id, concepts[cid][1], concepts[cid][0]),
                        scheme=scheme_name(workspace_id, concepts[cid][1]),
                        kind=kind,
                        language_code=language,
                        text=text,
                    )
                    for cid in concept_ids
                    if cid in concepts
                    for label, kind, language, text in labels[cid]
                    if label == normalized
                ),
                key=lambda entry: (entry.scheme, entry.concept, entry.kind),
            )
            records.append(SharedLabelRecord(label=normalized, cross_scheme=cross, concepts=tuple(entries)))
        return records


__all__ = ["SharedLabelService"]
