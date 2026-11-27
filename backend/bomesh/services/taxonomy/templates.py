"""DiffConceptSchemeTemplate and ApplyConceptSchemeTemplateChanges: forks follow their template.

Three-way: the template version the fork took (``template_version``, base),
the template's latest published version and the fork's working copy. Every
template change since the base is one :class:`TemplateChangeRecord`; it is a
conflict when the fork changed the same field itself (or holds the new
concept's notation, or added narrower concepts under a concept the template
deprecates). Applying writes only the selected, non-conflicting changes,
declines the rest and records the latest ``template_version``: the system
never overwrites the fork's own edits. Groups are not compared.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models.taxonomy import Concept, ConceptReplacement, ConceptScheme
from bomesh.errors import FailedPrecondition, InvalidArgument
from bomesh.services.kernel.context import RequestContext
from bomesh.services.taxonomy.changes import published_snapshot
from bomesh.services.taxonomy.concepts import SchemeIndex, write_concept
from bomesh.services.taxonomy.names import concept_name, scheme_name
from bomesh.services.taxonomy.records import SchemeRecord, TemplateChangeRecord, TemplateDiff
from bomesh.services.taxonomy.schemes import SETTINGS, apply_settings, copy_concepts, scheme_record
from bomesh.services.taxonomy.snapshot import ConceptView, SchemeSnapshot
from bomesh.services.taxonomy.support import (
    TaxonomyDeps,
    audit,
    authorize,
    concept_views,
    load_scheme,
    scheme_etag,
    touch,
)

#: Scheme setting path → snapshot attribute (template side of UPDATE_SCHEME).
_SCHEME_FIELDS = {
    "displayName": "name",
    "position": "position",
    "cardinality.min": "min_labels",
    "cardinality.max": "max_labels",
    "cardinality.primary": "has_primary",
    "maxDepth": "max_depth",
    "assignTopConcepts": "assign_top_concepts",
    "sectionAssignments": "section_assignments",
    "llmPolicy": "llm_policy",
    "autoThreshold": "auto_threshold",
    "reviewThreshold": "review_threshold",
}


def concept_fields(view: ConceptView, notation_of: Mapping[UUID, str]) -> dict[str, Any]:
    """A concept's comparable fields (JSON values; references by notation)."""
    return {
        "prefLabels": sorted([language, text] for language, text in view.pref_labels.items()),
        "altLabels": sorted([language, text] for language, text in view.alt_labels),
        "hiddenLabels": sorted([language, text] for language, text in view.hidden_labels),
        "definition": view.definition,
        "scopeNote": view.scope_note,
        "examples": list(view.examples),
        "broader": sorted(notation_of[cid] for cid in view.broader if cid in notation_of),
        "related": sorted(notation_of[cid] for cid in view.related if cid in notation_of),
        "mappings": sorted(list(mapping) for mapping in view.mappings),
        "matchPatterns": list(view.match_patterns),
        "timeSensitive": view.time_sensitive,
        "color": view.color,
        "icon": view.icon,
    }


def _scheme_value(value: Any) -> Any:
    return float(value) if isinstance(value, Decimal) else value


def _snapshot_settings(snapshot: SchemeSnapshot) -> dict[str, Any]:
    return {path: getattr(snapshot, attribute) for path, attribute in _SCHEME_FIELDS.items()}


def _scheme_settings(scheme: ConceptScheme) -> dict[str, Any]:
    return {path: _scheme_value(getattr(scheme, SETTINGS[path])) for path in _SCHEME_FIELDS}


async def _fork_state(
    session: AsyncSession, scheme: ConceptScheme
) -> tuple[ConceptScheme, SchemeSnapshot | None, SchemeSnapshot, dict[UUID, Concept], dict[UUID, ConceptView]]:
    if scheme.template_scheme_id is None:
        raise FailedPrecondition("The scheme is not a fork of a template.", reason="NOT_A_FORK")
    template = await session.get(ConceptScheme, scheme.template_scheme_id)
    assert template is not None
    latest = await published_snapshot(session, template)
    if latest is None:
        raise FailedPrecondition("The template was never published.", reason="TEMPLATE_UNPUBLISHED")
    base = await published_snapshot(session, template, scheme.template_version)
    concepts = list(await session.scalars(select(Concept).where(Concept.scheme_id == scheme.id)))
    views = await concept_views(session, scheme, [concept for concept in concepts if concept.deleted_at is None])
    linked = {
        concept.template_concept_id: concept
        for concept in concepts
        if concept.template_concept_id is not None and concept.deleted_at is None
    }
    return template, base, latest, linked, views


def compute_diff(
    scheme: ConceptScheme,
    template: ConceptScheme,
    base: SchemeSnapshot | None,
    latest: SchemeSnapshot,
    linked: Mapping[UUID, Concept],
    views: Mapping[UUID, ConceptView],
    taken_notations: set[str],
    narrower: Mapping[UUID, int],
) -> TemplateDiff:
    tenant_id = scheme.tenant_id
    ours_notation = {cid: view.notation for cid, view in views.items()}
    base_notation = {cid: view.notation for cid, view in (base.concepts.items() if base else ())}
    latest_notation = {cid: view.notation for cid, view in latest.concepts.items()}
    changes: list[TemplateChangeRecord] = []

    def name(notation: str) -> str:
        return concept_name(tenant_id, scheme.code, notation)

    for cid in sorted(latest.concepts, key=lambda key: latest.concepts[key].notation):
        theirs = latest.concepts[cid]
        old = base.concepts.get(cid) if base is not None else None
        own = linked.get(cid)
        if old is None:
            if theirs.state != "published" or own is not None:
                continue
            changes.append(
                TemplateChangeRecord(
                    key=f"add:{theirs.notation}",
                    kind="add_concept",
                    concept=name(theirs.notation),
                    field=None,
                    base_value=None,
                    template_value=concept_fields(theirs, latest_notation),
                    current_value=None,
                    replaced_by=(),
                    conflict=theirs.notation in taken_notations,
                )
            )
            continue
        if old.state == "published" and theirs.state == "deprecated":
            if own is None or own.state == "deprecated" or own.deprecated_version is not None:
                continue
            replaced = tuple(
                name(linked[target].notation) for target in theirs.replaced_by if target in linked
            )
            changes.append(
                TemplateChangeRecord(
                    key=f"deprecate:{theirs.notation}",
                    kind="deprecate_concept",
                    concept=name(own.notation),
                    field=None,
                    base_value=None,
                    template_value=None,
                    current_value=None,
                    replaced_by=replaced,
                    conflict=own.state != "published" or narrower.get(own.id, 0) > 0,
                )
            )
            continue
        if theirs.state != "published":
            continue
        before = concept_fields(old, base_notation)
        after = concept_fields(theirs, latest_notation)
        current = concept_fields(views[own.id], ours_notation) if own is not None and own.id in views else None
        for path in before:
            if before[path] == after[path]:
                continue
            if current is not None and current[path] == after[path]:
                continue
            changes.append(
                TemplateChangeRecord(
                    key=f"update:{theirs.notation}:{path}",
                    kind="update_concept",
                    concept=name(own.notation if own is not None else theirs.notation),
                    field=path,
                    base_value=before[path],
                    template_value=after[path],
                    current_value=None if current is None else current[path],
                    replaced_by=(),
                    conflict=current is None
                    or own is None
                    or own.state == "deprecated"
                    or current[path] != before[path],
                )
            )
    if base is not None:
        before_settings = _snapshot_settings(base)
        after_settings = _snapshot_settings(latest)
        current_settings = _scheme_settings(scheme)
        for path in _SCHEME_FIELDS:
            if before_settings[path] == after_settings[path] or current_settings[path] == after_settings[path]:
                continue
            changes.append(
                TemplateChangeRecord(
                    key=f"scheme:{path}",
                    kind="update_scheme",
                    concept=None,
                    field=path,
                    base_value=before_settings[path],
                    template_value=after_settings[path],
                    current_value=current_settings[path],
                    replaced_by=(),
                    conflict=current_settings[path] != before_settings[path],
                )
            )
    return TemplateDiff(
        template=scheme_name(None, template.code),
        from_version=scheme.template_version,
        to_version=latest.version,
        changes=tuple(changes),
    )


async def _diff(session: AsyncSession, scheme: ConceptScheme) -> tuple[TemplateDiff, Any]:
    template, base, latest, linked, views = await _fork_state(session, scheme)
    taken = set(await session.scalars(select(Concept.notation).where(Concept.scheme_id == scheme.id)))
    index = await SchemeIndex.load(session, scheme)
    narrower: dict[UUID, int] = {}
    live = {concept.id for concept in index.by_notation.values() if concept.deleted_at is None and concept.state != "deprecated"}
    for child, parents in index.broader.items():
        if child in live:
            for parent in parents:
                narrower[parent] = narrower.get(parent, 0) + 1
    result = compute_diff(scheme, template, base, latest, linked, views, taken, narrower)
    return result, (latest, linked, index)


class TemplateService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> TemplateService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def diff(self, ctx: RequestContext, workspace_id: UUID, code: str) -> TemplateDiff:
        await authorize(ctx, workspace_id, "conceptSchemes.update", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, workspace_id, code)
            return (await _diff(session, scheme))[0]

    async def apply(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        keys: Sequence[str],
        *,
        etag: str | None,
    ) -> SchemeRecord:
        await authorize(ctx, workspace_id, "conceptSchemes.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, workspace_id, code, for_update=True)
            etags.check(etag, scheme_etag(scheme))
            result, (latest, linked, index) = await _diff(session, scheme)
            by_key = {change.key: change for change in result.changes}
            unknown = [key for key in keys if key not in by_key]
            if unknown:
                raise InvalidArgument.for_field("changes", f"Not in the current template diff: {', '.join(unknown)}.")
            conflicts = [key for key in keys if by_key[key].conflict]
            if conflicts:
                raise FailedPrecondition(
                    "These changes conflict with the fork's own edits and are never applied: "
                    + ", ".join(conflicts),
                    reason="TEMPLATE_CONFLICT",
                )
            selected = [by_key[key] for key in dict.fromkeys(keys)]
            additions = {
                cid
                for cid, view in latest.concepts.items()
                if f"add:{view.notation}" in {change.key for change in selected}
            }
            mapping = {template_id: concept.id for template_id, concept in linked.items()}
            if additions:
                mapping = await copy_concepts(session, ctx, scheme, latest, additions, existing=mapping)
                index = await SchemeIndex.load(session, scheme)
            settings: dict[str, Any] = {}
            for change in selected:
                if change.kind == "update_scheme":
                    settings[change.field] = change.template_value
                elif change.kind == "update_concept":
                    notation = change.concept.rsplit("/", 1)[1]
                    concept = index.by_notation[notation]
                    current = (await concept_views(session, scheme, [concept]))[concept.id]
                    await write_concept(
                        session, index, concept, {change.field: change.template_value}, current=current
                    )
                elif change.kind == "deprecate_concept":
                    notation = change.concept.rsplit("/", 1)[1]
                    concept = index.by_notation[notation]
                    targets = [index.by_notation[name.rsplit("/", 1)[1]].id for name in change.replaced_by]
                    await session.execute(
                        delete(ConceptReplacement).where(ConceptReplacement.concept_id == concept.id)
                    )
                    if targets:
                        await session.execute(
                            insert(ConceptReplacement),
                            [{"concept_id": concept.id, "replacement_concept_id": target} for target in targets],
                        )
                    concept.deprecated_version = (scheme.published_version or 0) + 1
                    await touch(session, concept)
            if settings:
                apply_settings(scheme, settings)
            previous_version = scheme.template_version
            scheme.template_version = latest.version
            await touch(session, scheme)
            await session.flush()
            await audit(
                session,
                ctx,
                workspace_id,
                "ApplyConceptSchemeTemplateChanges",
                scheme_name(workspace_id, code),
                details={
                    "applied": [change.key for change in selected],
                    "declined": [key for key in by_key if key not in keys],
                    "templateVersion": {"before": previous_version, "after": latest.version},
                },
            )
            await session.refresh(scheme)
            return await scheme_record(session, scheme)


__all__ = ["TemplateService", "compute_diff", "concept_fields"]
