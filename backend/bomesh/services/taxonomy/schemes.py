"""Concept schemes: create (or fork a platform template), read, list and update settings.

A fork copies the template's latest published version into the working copy:
its published concepts become DRAFT concepts keeping ``template_concept_id``,
with their labels, mappings, broader/related relations and the groups;
``template_version`` records the version taken. Settings take effect for
machines only when the scheme is published (they are part of the version).
``unpublishedChanges`` is the length of the diff the next publish would record.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models.taxonomy import (
    LLM_POLICIES,
    SCHEME_PURPOSES,
    Concept,
    ConceptGroup,
    ConceptGroupMember,
    ConceptLabel,
    ConceptMapping,
    ConceptRelation,
    ConceptScheme,
)
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    FieldViolation,
    InvalidArgument,
)
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.taxonomy.changes import diff, published_snapshot
from bomesh.services.taxonomy.names import is_code, scheme_name
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.records import SchemeDraft, SchemeRecord
from bomesh.services.taxonomy.snapshot import (
    ConceptView,
    SchemeSnapshot,
    published_versions,
)
from bomesh.services.taxonomy.support import (
    TaxonomyDeps,
    audit,
    authorize,
    find_scheme,
    load_scheme,
    scheme_etag,
    touch,
    working_snapshots,
)

#: Scheme settings by API path (UpdateConceptScheme mask) → column.
SETTINGS = {
    "displayName": "scheme_name",
    "description": "description",
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
#: Snapshot attribute of each setting column (fork, template diff).
SNAPSHOT_SETTINGS = {
    "scheme_name": "name",
    "position": "position",
    "min_labels": "min_labels",
    "max_labels": "max_labels",
    "has_primary": "has_primary",
    "max_depth": "max_depth",
    "assign_top_concepts": "assign_top_concepts",
    "section_assignments": "section_assignments",
    "llm_policy": "llm_policy",
    "auto_threshold": "auto_threshold",
    "review_threshold": "review_threshold",
}


def _threshold(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(round(float(value), 3)))


def apply_settings(scheme: ConceptScheme, changes: Mapping[str, Any]) -> None:
    """Validate ``changes`` (by API path) against the resulting settings and set them."""
    problems: list[FieldViolation] = []
    for path, value in changes.items():
        column = SETTINGS[path]
        match column:
            case "scheme_name":
                text = (value or "").strip()
                if not text or len(text) > 255:
                    problems.append(FieldViolation(path, "displayName is required (≤ 255 characters)."))
                    continue
                value = text
            case "description":
                value = (value or "").strip() or None
            case "position" | "min_labels":
                value = int(value or 0)
            case "max_depth":
                value = int(value or 1)
            case "max_labels":
                value = None if value in (None, 0) else int(value)
            case "has_primary" | "assign_top_concepts" | "section_assignments":
                value = bool(value)
            case "llm_policy":
                value = (value or "never").lower()
                if value not in LLM_POLICIES:
                    problems.append(FieldViolation(path, "ALWAYS, FALLBACK or NEVER."))
                    continue
            case "auto_threshold" | "review_threshold":
                if value is not None and not 0 <= float(value) <= 1:
                    problems.append(FieldViolation(path, "A threshold is between 0 and 1."))
                    continue
                value = _threshold(value)
        setattr(scheme, column, value)
    if scheme.min_labels < 0:
        problems.append(FieldViolation("cardinality.min", "cardinality.min is ≥ 0."))
    if scheme.max_labels is not None and scheme.max_labels < max(scheme.min_labels, 1):
        problems.append(FieldViolation("cardinality.max", "cardinality.max is ≥ cardinality.min and ≥ 1."))
    if scheme.max_depth < 1:
        problems.append(FieldViolation("maxDepth", "maxDepth is ≥ 1."))
    if scheme.purpose == "authority":
        if scheme.llm_policy != "never":
            problems.append(FieldViolation("llmPolicy", "An AUTHORITY scheme has llmPolicy NEVER."))
        for path, column in (("autoThreshold", "auto_threshold"), ("reviewThreshold", "review_threshold")):
            if getattr(scheme, column) is not None:
                problems.append(FieldViolation(path, "An AUTHORITY scheme has no thresholds."))
    elif (
        scheme.auto_threshold is not None
        and scheme.review_threshold is not None
        and scheme.review_threshold > scheme.auto_threshold
    ):
        problems.append(FieldViolation("reviewThreshold", "reviewThreshold is ≤ autoThreshold."))
    if problems:
        raise InvalidArgument(problems[0].description, field_violations=problems)


async def scheme_record(session: AsyncSession, scheme: ConceptScheme) -> SchemeRecord:
    return (await scheme_records(session, [scheme]))[0]


async def scheme_records(
    session: AsyncSession,
    schemes: Sequence[ConceptScheme],
    template_codes: Mapping[UUID, str] | None = None,
) -> list[SchemeRecord]:
    """The records of ``schemes`` in a fixed number of statements, however many.

    ``template_codes`` (template scheme ID → code) are the template codes the
    caller already read; the others are looked up.
    """
    codes = dict(template_codes or {})
    unknown = {
        scheme.template_scheme_id for scheme in schemes if scheme.template_scheme_id is not None
    } - codes.keys()
    if unknown:
        codes.update(
            (await session.execute(select(ConceptScheme.id, ConceptScheme.code).where(ConceptScheme.id.in_(unknown))))
            .tuples()
            .all()
        )
    published = await published_versions(
        session,
        [(scheme.id, scheme.published_version) for scheme in schemes if scheme.published_version is not None],
    )
    working = await working_snapshots(session, schemes)
    return [
        _record(
            scheme,
            codes.get(scheme.template_scheme_id) if scheme.template_scheme_id is not None else None,
            len(diff(published.get((scheme.id, scheme.published_version)), working[scheme.id])),
        )
        for scheme in schemes
    ]


def _record(scheme: ConceptScheme, template_code: str | None, pending: int) -> SchemeRecord:
    return SchemeRecord(
        name=scheme_name(scheme.tenant_id, scheme.code),
        display_name=scheme.scheme_name,
        description=scheme.description,
        purpose=scheme.purpose,
        position=scheme.position,
        min_labels=scheme.min_labels,
        max_labels=scheme.max_labels,
        has_primary=scheme.has_primary,
        max_depth=scheme.max_depth,
        assign_top_concepts=scheme.assign_top_concepts,
        section_assignments=scheme.section_assignments,
        llm_policy=scheme.llm_policy,
        auto_threshold=None if scheme.auto_threshold is None else float(scheme.auto_threshold),
        review_threshold=None if scheme.review_threshold is None else float(scheme.review_threshold),
        template=scheme_name(None, template_code) if template_code else None,
        template_version=scheme.template_version,
        published_version=scheme.published_version,
        unpublished_changes=pending,
        create_time=scheme.created_at,
        update_time=scheme.updated_at,
        etag=scheme_etag(scheme),
    )


def scheme_json(scheme: ConceptScheme) -> dict[str, Any]:
    """A scheme's settings for audit ``details``."""
    return {
        path: (float(value) if isinstance(value, Decimal) else value)
        for path, column in SETTINGS.items()
        for value in (getattr(scheme, column),)
    }


async def copy_concepts(
    session: AsyncSession,
    ctx: RequestContext | None,
    scheme: ConceptScheme,
    template: SchemeSnapshot,
    template_ids: set[UUID],
    *,
    existing: Mapping[UUID, UUID] | None = None,
) -> dict[UUID, UUID]:
    """Insert DRAFT copies of the template concepts ``template_ids`` into ``scheme``.

    Relations are copied between concepts the fork holds (``existing`` maps
    template concept IDs the fork already copied to its own). Returns the new
    template → fork ID map (``existing`` included).
    """
    mapping: dict[UUID, UUID] = dict(existing or {})
    views: list[ConceptView] = [
        template.concepts[cid]
        for cid in sorted(template_ids, key=lambda cid: template.concepts[cid].notation)
    ]
    for view in views:
        concept = Concept(
            tenant_id=scheme.tenant_id,
            scheme_id=scheme.id,
            notation=view.notation,
            state="draft",
            definition=view.definition,
            scope_note=view.scope_note,
            examples=list(view.examples),
            color=view.color,
            icon=view.icon,
            match_patterns=list(view.match_patterns),
            time_sensitive=view.time_sensitive,
            template_concept_id=view.id,
            created_by_user_id=ctx.user_id if ctx is not None else None,
        )
        session.add(concept)
        await session.flush()
        mapping[view.id] = concept.id
    labels, relations, mappings = [], [], []
    for view in views:
        own = mapping[view.id]
        for kind, values in (
            ("pref", list(view.pref_labels.items())),
            ("alt", list(view.alt_labels)),
            ("hidden", list(view.hidden_labels)),
        ):
            labels.extend(
                {
                    "concept_id": own,
                    "kind": kind,
                    "language_code": language,
                    "label_text": text,
                    "normalized": normalize_label(text),
                }
                for language, text in values
            )
        relations.extend(
            {"source_concept_id": own, "target_concept_id": mapping[parent], "kind": "broader"}
            for parent in view.broader
            if parent in mapping
        )
        for other in view.related:
            if other in mapping:
                low, high = sorted((own, mapping[other]), key=str)
                relations.append({"source_concept_id": low, "target_concept_id": high, "kind": "related"})
        mappings.extend(
            {
                "concept_id": own,
                "target_system": system,
                "target_code": code,
                "target_label": label,
                "match_type": match,
            }
            for system, code, label, match in view.mappings
        )
    if labels:
        await session.execute(insert(ConceptLabel), labels)
    unique = {(row["source_concept_id"], row["target_concept_id"], row["kind"]): row for row in relations}
    if unique:
        present = set(
            (
                await session.execute(
                    select(
                        ConceptRelation.source_concept_id,
                        ConceptRelation.target_concept_id,
                        ConceptRelation.kind,
                    ).where(
                        ConceptRelation.source_concept_id.in_(
                            {row["source_concept_id"] for row in unique.values()}
                        )
                    )
                )
            ).tuples()
        )
        rows = [row for key, row in unique.items() if key not in present]
        if rows:
            await session.execute(insert(ConceptRelation), rows)
    if mappings:
        await session.execute(insert(ConceptMapping), mappings)
    return mapping


class SchemeService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> SchemeService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        draft: SchemeDraft,
        *,
        request_id: UUID | None = None,
    ) -> SchemeRecord:
        """CreateConceptScheme; ``draft.template`` (workspace only) forks a platform template."""
        await authorize(ctx, tenant_id, "conceptSchemes.create", write=True)
        if draft.template is not None and tenant_id is None:
            raise InvalidArgument.for_field("template", "A platform template does not fork another template.")
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateConceptScheme",
                    parent=scheme_name(tenant_id, "-").rsplit("/conceptSchemes", 1)[0],
                    request={
                        "conceptSchemeId": draft.code,
                        "displayName": draft.display_name,
                        "description": draft.description,
                        "purpose": draft.purpose,
                        "template": draft.template,
                        "settings": dict(sorted(draft.settings.items())),
                    },
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    return await scheme_record(
                        session, await load_scheme(session, tenant_id, replayed.rsplit("/", 1)[1])
                    )
            template: ConceptScheme | None = None
            snapshot: SchemeSnapshot | None = None
            if draft.template is not None:
                template = await find_scheme(session, None, draft.template)
                if template is None:
                    raise InvalidArgument.for_field(
                        "template", f"'{scheme_name(None, draft.template)}' is not a platform template."
                    )
                snapshot = await published_snapshot(session, template)
                if snapshot is None:
                    raise FailedPrecondition("The template was never published.", reason="TEMPLATE_UNPUBLISHED")
            code = draft.code or (template.code if template is not None else None)
            if not code:
                raise InvalidArgument.for_field("conceptSchemeId", "conceptSchemeId is required.")
            if not is_code(code):
                raise InvalidArgument.for_field("conceptSchemeId", "A scheme ID matches ^[a-z][a-z0-9-]{0,62}$.")
            taken = await session.scalar(
                select(ConceptScheme.id).where(
                    ConceptScheme.tenant_id.is_not_distinct_from(tenant_id), ConceptScheme.code == code
                )
            )
            if taken is not None:
                raise AlreadyExists(f"Concept scheme '{scheme_name(tenant_id, code)}' already exists.")
            if template is not None and snapshot is not None:
                scheme = ConceptScheme(
                    tenant_id=tenant_id,
                    code=code,
                    scheme_name=template.scheme_name,
                    description=template.description,
                    purpose=snapshot.purpose,
                    template_scheme_id=template.id,
                    template_version=snapshot.version,
                )
                for column, attribute in SNAPSHOT_SETTINGS.items():
                    value = getattr(snapshot, attribute)
                    if column in ("auto_threshold", "review_threshold"):
                        value = _threshold(value)
                    setattr(scheme, column, value)
            else:
                purpose = (draft.purpose or "").lower()
                if purpose not in SCHEME_PURPOSES:
                    raise InvalidArgument.for_field("purpose", "purpose is CLASSIFICATION or AUTHORITY.")
                scheme = ConceptScheme(
                    tenant_id=tenant_id,
                    code=code,
                    scheme_name="",
                    purpose=purpose,
                    llm_policy="always" if purpose == "classification" else "never",
                    position=0,
                    min_labels=0,
                    max_depth=1,
                    has_primary=False,
                    assign_top_concepts=True,
                    section_assignments=False,
                )
            settings: dict[str, Any] = dict(draft.settings)
            if draft.display_name is not None:
                settings["displayName"] = draft.display_name
            if draft.description is not None:
                settings["description"] = draft.description
            apply_settings(scheme, settings)
            session.add(scheme)
            await session.flush()
            if snapshot is not None:
                copied = await copy_concepts(
                    session,
                    ctx,
                    scheme,
                    snapshot,
                    {cid for cid, view in snapshot.concepts.items() if view.state == "published"},
                )
                for group in snapshot.groups:
                    row = ConceptGroup(
                        scheme_id=scheme.id,
                        code=group.code,
                        group_name=group.name,
                        position=group.position,
                        query_expansion=group.query_expansion,
                    )
                    session.add(row)
                    await session.flush()
                    members = [cid for cid in group.members if cid in copied]
                    if members:
                        await session.execute(
                            insert(ConceptGroupMember),
                            [
                                {"group_id": row.id, "concept_id": copied[cid], "position": position}
                                for position, cid in enumerate(members)
                            ],
                        )
            name = scheme_name(tenant_id, code)
            await audit(
                session,
                ctx,
                tenant_id,
                "CreateConceptScheme",
                name,
                after=scheme_json(scheme),
                details={"template": scheme_name(None, template.code)} if template else None,
            )
            if key is not None:
                await idempotency.remember(key, name)
            await session.refresh(scheme)
            return await scheme_record(session, scheme)

    async def get(self, ctx: RequestContext, tenant_id: UUID | None, code: str) -> SchemeRecord:
        await authorize(ctx, tenant_id, "conceptSchemes.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            return await scheme_record(session, await load_scheme(session, tenant_id, code))

    async def list(
        self, ctx: RequestContext, tenant_id: UUID | None, query: ListQuery
    ) -> tuple[list[SchemeRecord], int]:
        await authorize(ctx, tenant_id, "conceptSchemes.list", write=False)
        statement = select(ConceptScheme).where(
            ConceptScheme.tenant_id.is_not_distinct_from(tenant_id), ConceptScheme.deleted_at.is_(None)
        )
        template = aliased(ConceptScheme, name="template")
        page = query.apply(
            statement.add_columns(template.code).outerjoin(template, template.id == ConceptScheme.template_scheme_id)
        )
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = (await session.execute(page)).tuples().all()
            codes = {scheme.template_scheme_id: code for scheme, code in rows if code is not None}
            return await scheme_records(session, [scheme for scheme, _ in rows], codes), total

    async def update(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        code: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> SchemeRecord:
        await authorize(ctx, tenant_id, "conceptSchemes.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, code, for_update=True)
            etags.check(etag, scheme_etag(scheme))
            before = scheme_json(scheme)
            apply_settings(scheme, changes)
            await touch(session, scheme)
            await session.flush()
            await audit(
                session,
                ctx,
                tenant_id,
                "UpdateConceptScheme",
                scheme_name(tenant_id, code),
                before=before,
                after=scheme_json(scheme),
            )
            await session.refresh(scheme)
            return await scheme_record(session, scheme)


__all__ = [
    "SETTINGS",
    "SNAPSHOT_SETTINGS",
    "SchemeService",
    "apply_settings",
    "copy_concepts",
    "scheme_json",
    "scheme_record",
    "scheme_records",
]
