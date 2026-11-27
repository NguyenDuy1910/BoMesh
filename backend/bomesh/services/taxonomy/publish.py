"""PublishConceptScheme and the published versions (ConceptSchemeVersion).

One transaction validates the working copy (:func:`validation.validate`),
stores the immutable version (snapshot, ``changes`` against the previous
version, warnings, the ``reclassification`` plan), turns drafts published and
pending deprecations deprecated, rebuilds ``concept_closure``, remaps the
assignments of merged concepts (``assignments.remap``, no model) and records a
finished ``publishConceptScheme`` Operation. After commit a workspace scheme's
reclassification is scheduled (``reclassify.schedule_reclassification``):
a ``CLASSIFY_ONLY`` ingestion run with ``trigger_type = taxonomy`` limited to
the documents the diff affects. ``validateOnly`` stores nothing and returns a
transient finished Operation whose version preview carries the violations.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import ItemConcept, Operation
from bomesh.db.models.taxonomy import Concept, ConceptScheme, ConceptSchemeVersion
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.operations import OPERATION_HANDLERS, Operations
from bomesh.services.taxonomy.changes import diff, published_snapshot, reclassification
from bomesh.services.taxonomy.closure import rebuild_closure
from bomesh.services.taxonomy.names import (
    concept_name,
    group_name,
    is_code,
    scheme_name,
    version_name,
)
from bomesh.services.taxonomy.records import (
    ChangeEntry,
    PublishResult,
    ReclassificationRecord,
    RerankEntry,
    VersionRecord,
    ViolationEntry,
    WarningEntry,
)
from bomesh.services.taxonomy.snapshot import SchemeSnapshot, from_json, snapshot_json
from bomesh.services.taxonomy.support import (
    TaxonomyDeps,
    audit,
    authorize,
    load_scheme,
    now,
    scheme_etag,
    touch,
    working_snapshot,
)
from bomesh.services.taxonomy.validation import Finding, Violation, validate

_log = logging.getLogger(__name__)
VERB = "publishConceptScheme"
#: W4 looks back this far for reviewers' rejections.
CORRECTION_WINDOW = timedelta(days=90)


def _finding_json(finding: Finding) -> dict[str, Any]:
    return {
        "kind": finding.kind,
        "concepts": [str(cid) for cid in finding.concepts],
        "label": finding.label,
        "message": finding.message,
    }


def version_record(
    tenant_id: UUID | None,
    scheme_code: str,
    snapshot: SchemeSnapshot,
    *,
    changes: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
    reclassification_plan: dict[str, Any] | None,
    publish_time: Any = None,
    publisher: UUID | None = None,
    violations: Sequence[Violation] = (),
) -> VersionRecord:
    """The API view of a version (stored or previewed); IDs become resource names."""

    def name(value: str | UUID) -> str:
        cid = value if isinstance(value, UUID) else UUID(value)
        view = snapshot.concepts.get(cid)
        return concept_name(tenant_id, scheme_code, view.notation if view else str(cid))

    plan = reclassification_plan
    record = None
    if plan is not None:
        record = ReclassificationRecord(
            remapped_count=int(plan.get("remapped", 0)),
            rerank=tuple(
                RerankEntry(name(entry["concept"]), tuple(name(cid) for cid in entry["among"]))
                for entry in plan.get("rerank", ())
            ),
            rerun_parents=tuple(
                RerankEntry(name(entry["parent"]), tuple(name(cid) for cid in entry["among"]))
                for entry in plan.get("rerun_parents", ())
            ),
            patterns_changed=tuple(name(cid) for cid in plan.get("patterns_changed", ())),
            thresholds_changed=bool(plan.get("thresholds_changed")),
            state=str(plan.get("state", "pending")),
            runs=tuple(
                f"workspaces/{tenant_id}/ingestionRuns/{run}" for run in plan.get("runs", ()) if tenant_id
            ),
        )
    return VersionRecord(
        name=version_name(tenant_id, scheme_code, snapshot.version),
        version=snapshot.version,
        publish_time=publish_time,
        publisher=f"users/{publisher}" if publisher else None,
        concept_count=sum(1 for view in snapshot.concepts.values() if view.state == "published"),
        changes=tuple(
            ChangeEntry(
                kind=entry["kind"],
                concept=name(entry["concept"]) if entry.get("concept") else None,
                group=group_name(tenant_id, scheme_code, entry["group"]) if entry.get("group") else None,
                replaced_by=tuple(name(cid) for cid in entry.get("replaced_by", ())),
            )
            for entry in changes
        ),
        warnings=tuple(
            WarningEntry(
                kind=entry["kind"],
                concepts=tuple(name(cid) for cid in entry.get("concepts", ())),
                label=entry.get("label"),
                message=entry.get("message", ""),
            )
            for entry in warnings
        ),
        violations=tuple(
            ViolationEntry(
                invariant=violation.invariant,
                concepts=tuple(name(cid) for cid in violation.concepts),
                message=violation.message,
            )
            for violation in violations
        ),
        reclassification=record,
    )


def stored_version_record(
    tenant_id: UUID | None, scheme_code: str, row: ConceptSchemeVersion
) -> VersionRecord:
    return version_record(
        tenant_id,
        scheme_code,
        from_json(row.snapshot),
        changes=list(row.changes),
        warnings=list(row.warnings),
        reclassification_plan=row.reclassification,
        publish_time=row.published_at,
        publisher=row.published_by_user_id,
    )


async def _rejections(session: AsyncSession, scheme: ConceptScheme) -> dict[UUID, int]:
    """Reviewers' rejections per concept in the last 90 days (W4)."""
    if scheme.tenant_id is None:
        return {}
    rows = await session.execute(
        select(ItemConcept.concept_id, func.count())
        .where(
            ItemConcept.scheme_id == scheme.id,
            ItemConcept.state == "rejected",
            ItemConcept.reviewed_by_user_id.is_not(None),
            ItemConcept.reviewed_at > func.now() - CORRECTION_WINDOW,
        )
        .group_by(ItemConcept.concept_id)
    )
    return {cid: int(count) for cid, count in rows}


async def _remap(session: AsyncSession, from_id: UUID, to_ids: list[UUID]) -> int:
    from bomesh.services.taxonomy import assignments  # Classification slice

    return int(await assignments.remap(session, from_id, to_ids) or 0)


async def _schedule(runtime: Any, ctx: RequestContext, tenant_id: UUID, scheme_id: UUID, version: int) -> None:
    from bomesh.services.taxonomy import reclassify  # Reclassify slice

    await reclassify.schedule_reclassification(runtime, ctx, tenant_id, scheme_id, version)


class PublishService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> PublishService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def publish(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        code: str,
        *,
        etag: str | None,
        validate_only: bool,
    ) -> PublishResult:
        await authorize(ctx, tenant_id, "conceptSchemes.publish", write=not validate_only)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, code, for_update=not validate_only)
            etags.check(etag, scheme_etag(scheme))
            previous = await published_snapshot(session, scheme)
            current = await working_snapshot(session, scheme)
            violations, findings = validate(current, rejections=await _rejections(session, scheme))
            changes = diff(previous, current)
            warnings = [_finding_json(finding) for finding in findings]
            plan = reclassification(previous, current, changes) if tenant_id is not None else None
            target = scheme_name(tenant_id, code)
            if validate_only:
                moment = await now(session)
                operation = Operation(
                    id=uuid4(),
                    user_id=ctx.user_id,
                    tenant_id=tenant_id,
                    verb=VERB,
                    target=target,
                    progress_percent=100,
                    created_at=moment,
                    finished_at=moment,
                    expires_at=moment,
                )
                preview = version_record(
                    tenant_id,
                    code,
                    current,
                    changes=changes,
                    warnings=warnings,
                    reclassification_plan=plan,
                    violations=violations,
                )
                return PublishResult(operation=operation, version=preview)
            if violations:
                raise FailedPrecondition(
                    "The working copy breaks the taxonomy invariants: "
                    + " ".join(violation.message for violation in violations[:5]),
                    reason="TAXONOMY_INVALID",
                    metadata={"violations": str(len(violations))},
                )
            if previous is not None and not changes:
                raise FailedPrecondition("Nothing changed since the last version.", reason="NO_CHANGES")
            version = current.version
            await session.execute(
                update(Concept)
                .where(Concept.scheme_id == scheme.id, Concept.deleted_at.is_(None), Concept.state == "draft")
                .values(state="published", first_version=version)
            )
            await session.execute(
                update(Concept)
                .where(
                    Concept.scheme_id == scheme.id,
                    Concept.state == "published",
                    Concept.deprecated_version.is_not(None),
                )
                .values(state="deprecated", deprecated_version=version)
            )
            await session.flush()
            await rebuild_closure(session, scheme.id, current)
            if plan is not None and scheme.purpose == "classification":
                remapped = 0
                for entry in changes:
                    if entry["kind"] == "deprecated" and len(entry["replaced_by"]) == 1:
                        remapped += await _remap(
                            session, UUID(entry["concept"]), [UUID(entry["replaced_by"][0])]
                        )
                plan["remapped"] = remapped
            user_id = ctx.user_id
            row = ConceptSchemeVersion(
                scheme_id=scheme.id,
                version=version,
                published_by_user_id=user_id,
                snapshot=snapshot_json(current),
                changes=changes,
                warnings=warnings,
                reclassification=plan,
            )
            session.add(row)
            scheme.published_version = version
            await touch(session, scheme)
            await session.flush()
            operations = Operations(session)
            operation = await operations.create(
                ctx.principal, verb=VERB, target=target, workspace_id=tenant_id
            )
            operation = await operations.complete(
                operation.id, result_name=version_name(tenant_id, code, version)
            )
            await audit(
                session,
                ctx,
                tenant_id,
                "PublishConceptScheme",
                target,
                details={
                    "version": version,
                    "changes": len(changes),
                    "warnings": len(warnings),
                    "remapped": (plan or {}).get("remapped", 0),
                },
            )
            await session.refresh(row)
            record = stored_version_record(tenant_id, code, row)
        if tenant_id is not None:
            try:
                await _schedule(self._deps.runtime, ctx, tenant_id, scheme.id, version)
            except Exception:
                # The version is committed and its reclassification stays ``pending``.
                _log.exception("scheduling the reclassification of %s v%s failed", target, version)
        return PublishResult(operation=operation, version=record)

    async def get_version(
        self, ctx: RequestContext, tenant_id: UUID | None, code: str, version: int
    ) -> VersionRecord:
        await authorize(ctx, tenant_id, "conceptSchemes.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            return await self.load_version(session, tenant_id, code, version)

    @staticmethod
    async def load_version(
        session: AsyncSession, tenant_id: UUID | None, code: str, version: int
    ) -> VersionRecord:
        scheme = await load_scheme(session, tenant_id, code)
        row = await session.scalar(
            select(ConceptSchemeVersion).where(
                ConceptSchemeVersion.scheme_id == scheme.id, ConceptSchemeVersion.version == version
            )
        )
        if row is None:
            raise NotFound(f"'{version_name(tenant_id, code, version)}' does not exist.")
        return stored_version_record(tenant_id, code, row)

    async def list_versions(
        self, ctx: RequestContext, tenant_id: UUID | None, code: str, query: ListQuery
    ) -> list[VersionRecord]:
        await authorize(ctx, tenant_id, "conceptSchemes.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, code)
            rows = await session.scalars(
                query.apply(
                    select(ConceptSchemeVersion).where(ConceptSchemeVersion.scheme_id == scheme.id)
                )
            )
            return [stored_version_record(tenant_id, code, row) for row in rows]


def parse_version_name(name: str) -> tuple[UUID | None, str, int]:
    """``(tenant_id, scheme_code, version)`` of a version name (workspace or template)."""
    parts = name.split("/")
    tenant_id: UUID | None = None
    if parts and parts[0] == "workspaces" and len(parts) == 6:
        tenant_id = UUID(parts[1])
        parts = parts[2:]
    if len(parts) != 4 or parts[0] != "conceptSchemes" or parts[2] != "versions" or not is_code(parts[1]):
        raise InvalidArgument(f"'{name}' is not a concept scheme version name.")
    return tenant_id, parts[1], int(parts[3])


async def load_published_version(runtime: Any, result_name: str) -> VersionRecord:
    """The ``publishConceptScheme`` operation result, unauthorized (reads are own-only)."""
    tenant_id, code, version = parse_version_name(result_name)
    async with transaction_scope(runtime.sessions()) as session:
        return await PublishService.load_version(session, tenant_id, code, version)


OPERATION_HANDLERS.register_result(VERB, load_published_version)


__all__ = [
    "PublishService",
    "load_published_version",
    "parse_version_name",
    "stored_version_record",
    "version_record",
]
