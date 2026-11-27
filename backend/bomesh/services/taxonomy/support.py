"""Infrastructure shared by the taxonomy services: authorization, loading and the working copy.

A scheme's concepts, labels, relations, mappings, replacements and groups are
its **working copy**; :func:`working_snapshot` turns it into the
:class:`~bomesh.services.taxonomy.snapshot.SchemeSnapshot` the next publish
would store (drafts published, pending deprecations deprecated), which the
validator, the diff and the template comparison all read.

``tenant_id`` None addresses the platform templates (``conceptSchemes/…``):
they are changed with the permission held on the platform and read by
platform callers or by members holding it in any workspace. A workspace's
taxonomy is read and changed only through tenant grants; a platform grant of
the same permission never reaches it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import SessionFactory
from bomesh.db.models.taxonomy import (
    Concept,
    ConceptGroup,
    ConceptGroupMember,
    ConceptLabel,
    ConceptMapping,
    ConceptRelation,
    ConceptReplacement,
    ConceptScheme,
)
from bomesh.errors import NotFound
from bomesh.iam.authorizer import PlatformRef, WorkspaceRef, permission_denied
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import WorkspaceResolver, require_usable
from bomesh.services.taxonomy.names import concept_name, group_name, scheme_name
from bomesh.services.taxonomy.snapshot import ConceptView, GroupView, SchemeSnapshot

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: The platform template catalog, for error messages.
TEMPLATES = PlatformRef("conceptSchemes")
_READ_METHODS = ("get", "list")


@dataclass(frozen=True, slots=True)
class TaxonomyDeps:
    sessions: SessionFactory
    request_hash_secret: bytes
    #: The application runtime, handed to the reclassification hooks after commit.
    runtime: Any = None

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> TaxonomyDeps:
        return cls(
            sessions=runtime.sessions(),
            request_hash_secret=runtime.request_hash_secret(),
            runtime=runtime,
        )


async def authorize(
    ctx: RequestContext, tenant_id: UUID | None, permission: str, *, write: bool
) -> None:
    """Gate a taxonomy method on a workspace (tenant grants only) or on the templates."""
    authorizer, principal = ctx.authorizer, ctx.principal
    if tenant_id is not None:
        if permission not in await authorizer.workspace_permissions(principal, tenant_id):
            raise permission_denied(permission, WorkspaceRef(tenant_id))
        workspace = await WorkspaceResolver().get(ctx, tenant_id)
        require_usable(workspace, write=write)
        return
    if permission in await authorizer.platform_permissions(principal):
        return
    if not write and permission.rsplit(".", 1)[1] in _READ_METHODS:
        for workspace_id in await authorizer.member_workspaces(principal):
            if permission in await authorizer.workspace_permissions(principal, workspace_id):
                return
    raise permission_denied(permission, TEMPLATES)


async def now(session: AsyncSession) -> datetime:
    return await session.scalar(select(func.now()))


# -- Loading -----------------------------------------------------------------------


async def find_scheme(
    session: AsyncSession, tenant_id: UUID | None, code: str, *, for_update: bool = False
) -> ConceptScheme | None:
    statement = select(ConceptScheme).where(
        ConceptScheme.tenant_id.is_not_distinct_from(tenant_id),
        ConceptScheme.code == code,
        ConceptScheme.deleted_at.is_(None),
    )
    if for_update:
        statement = statement.with_for_update()
    return await session.scalar(statement)


async def load_scheme(
    session: AsyncSession, tenant_id: UUID | None, code: str, *, for_update: bool = False
) -> ConceptScheme:
    scheme = await find_scheme(session, tenant_id, code, for_update=for_update)
    if scheme is None:
        raise NotFound(f"Concept scheme '{scheme_name(tenant_id, code)}' does not exist.")
    return scheme


async def load_concept(
    session: AsyncSession,
    scheme: ConceptScheme,
    notation: str,
    *,
    for_update: bool = False,
) -> Concept:
    """The concept (deleted drafts included); NOT_FOUND when the notation was never used."""
    statement = select(Concept).where(
        Concept.scheme_id == scheme.id, Concept.notation == notation
    )
    if for_update:
        statement = statement.with_for_update()
    concept = await session.scalar(statement)
    if concept is None:
        raise NotFound(
            f"Concept '{concept_name(scheme.tenant_id, scheme.code, notation)}' does not exist."
        )
    return concept


async def touch(session: AsyncSession, *rows: Any) -> None:
    """Bump ``updated_at`` (etags): a working-copy edit changes the scheme's etag too."""
    moment = await now(session)
    for row in rows:
        row.updated_at = moment


def scheme_etag(scheme: ConceptScheme) -> str:
    return etags.compute(scheme_name(scheme.tenant_id, scheme.code), scheme.updated_at)


def concept_etag(scheme: ConceptScheme, concept: Concept) -> str:
    return etags.compute(
        concept_name(scheme.tenant_id, scheme.code, concept.notation), concept.updated_at
    )


def group_etag(scheme: ConceptScheme, group: ConceptGroup) -> str:
    return etags.compute(group_name(scheme.tenant_id, scheme.code, group.code), group.updated_at)


async def audit(
    session: AsyncSession,
    ctx: RequestContext,
    tenant_id: UUID | None,
    action: str,
    target: str,
    *,
    before: Any = None,
    after: Any = None,
    details: Mapping[str, Any] | None = None,
) -> None:
    """One ``knowledge`` audit event; ``details`` = ``{before, after}`` of the change."""
    payload: dict[str, Any] = dict(details or {})
    if before is not None or after is not None:
        payload["before"] = before
        payload["after"] = after
    await Audit(session).record(
        ctx,
        workspace_id=tenant_id,
        category="knowledge",
        action=action,
        target=target,
        details=payload or None,
    )


# -- Working copy --------------------------------------------------------------------


def api_state(concept: Concept) -> str:
    """``draft``, ``published``, ``deprecated`` or ``deleted`` (a deleted draft)."""
    return "deleted" if concept.deleted_at is not None else concept.state


def deprecation_pending(concept: Concept) -> bool:
    return concept.state == "published" and concept.deprecated_version is not None


async def concept_views(
    session: AsyncSession, scheme: ConceptScheme, concepts: Sequence[Concept]
) -> dict[UUID, ConceptView]:
    """The working-copy values of ``concepts`` (their stored states), by ID."""
    return await _concept_views(session, concepts, lambda _: scheme.code)


async def _concept_views(
    session: AsyncSession, concepts: Sequence[Concept], scheme_code: Callable[[Concept], str]
) -> dict[UUID, ConceptView]:
    """:func:`concept_views` of concepts of any schemes (four statements however many)."""
    ids = [concept.id for concept in concepts]
    if not ids:
        return {}
    id_set = set(ids)
    labels: dict[UUID, dict[str, list[tuple[str, str]]]] = {}
    for row in await session.scalars(
        select(ConceptLabel)
        .where(ConceptLabel.concept_id.in_(ids))
        # Label rows have random IDs: a stable order keeps reads and change detection deterministic.
        .order_by(
            ConceptLabel.concept_id,
            ConceptLabel.kind,
            ConceptLabel.language_code,
            ConceptLabel.normalized,
            ConceptLabel.label_text,
        )
    ):
        labels.setdefault(row.concept_id, {}).setdefault(row.kind, []).append(
            (row.language_code, row.label_text)
        )
    broader: dict[UUID, list[UUID]] = {}
    related: dict[UUID, list[UUID]] = {}
    for source, target, kind in (
        await session.execute(
            select(
                ConceptRelation.source_concept_id,
                ConceptRelation.target_concept_id,
                ConceptRelation.kind,
            ).where(
                or_(
                    ConceptRelation.source_concept_id.in_(ids),
                    ConceptRelation.target_concept_id.in_(ids),
                )
            )
        )
    ).tuples():
        if kind == "broader":
            if source in id_set:
                broader.setdefault(source, []).append(target)
        else:
            if source in id_set:
                related.setdefault(source, []).append(target)
            if target in id_set:
                related.setdefault(target, []).append(source)
    replaced: dict[UUID, list[UUID]] = {}
    for concept_id, replacement in (
        await session.execute(
            select(ConceptReplacement.concept_id, ConceptReplacement.replacement_concept_id).where(
                ConceptReplacement.concept_id.in_(ids)
            )
        )
    ).tuples():
        replaced.setdefault(concept_id, []).append(replacement)
    mappings: dict[UUID, list[tuple[str, str, str | None, str]]] = {}
    for row in await session.scalars(
        select(ConceptMapping)
        .where(ConceptMapping.concept_id.in_(ids))
        .order_by(ConceptMapping.target_system, ConceptMapping.target_code)
    ):
        mappings.setdefault(row.concept_id, []).append(
            (row.target_system, row.target_code, row.target_label, row.match_type)
        )
    views: dict[UUID, ConceptView] = {}
    for concept in concepts:
        own = labels.get(concept.id, {})
        views[concept.id] = ConceptView(
            id=concept.id,
            notation=concept.notation,
            scheme_code=scheme_code(concept),
            state=concept.state,
            pref_labels=dict(own.get("pref", [])),
            alt_labels=tuple(own.get("alt", [])),
            hidden_labels=tuple(own.get("hidden", [])),
            definition=concept.definition,
            scope_note=concept.scope_note,
            examples=tuple(concept.examples),
            color=concept.color,
            icon=concept.icon,
            match_patterns=tuple(concept.match_patterns),
            time_sensitive=concept.time_sensitive,
            broader=tuple(sorted(broader.get(concept.id, []), key=str)),
            related=tuple(sorted(related.get(concept.id, []), key=str)),
            replaced_by=tuple(sorted(replaced.get(concept.id, []), key=str)),
            mappings=tuple(mappings.get(concept.id, [])),
        )
    return views


async def live_concepts(session: AsyncSession, scheme_ids: Sequence[UUID]) -> dict[UUID, list[Concept]]:
    """Every concept of each scheme's working copy except deleted drafts, by notation."""
    found: dict[UUID, list[Concept]] = {scheme_id: [] for scheme_id in scheme_ids}
    if not found:
        return found
    for concept in await session.scalars(
        select(Concept)
        .where(Concept.scheme_id.in_(list(found)), Concept.deleted_at.is_(None))
        .order_by(Concept.notation)
    ):
        found[concept.scheme_id].append(concept)
    return found


async def group_views(
    session: AsyncSession, scheme_ids: Sequence[UUID]
) -> dict[UUID, tuple[GroupView, ...]]:
    """Each scheme's groups (by position, code) with their members (by position)."""
    found: dict[UUID, dict[UUID, tuple[ConceptGroup, list[UUID]]]] = {scheme_id: {} for scheme_id in scheme_ids}
    if not found:
        return {}
    for group, concept_id in (
        await session.execute(
            select(ConceptGroup, ConceptGroupMember.concept_id)
            .outerjoin(ConceptGroupMember, ConceptGroupMember.group_id == ConceptGroup.id)
            .where(ConceptGroup.scheme_id.in_(list(found)))
            .order_by(ConceptGroup.position, ConceptGroup.code, ConceptGroup.id, ConceptGroupMember.position)
        )
    ).tuples():
        _, members = found[group.scheme_id].setdefault(group.id, (group, []))
        if concept_id is not None:
            members.append(concept_id)
    return {
        scheme_id: tuple(
            GroupView(
                id=group.id,
                code=group.code,
                name=group.group_name,
                position=group.position,
                query_expansion=group.query_expansion,
                members=tuple(members),
            )
            for group, members in groups.values()
        )
        for scheme_id, groups in found.items()
    }


def scheme_snapshot(
    scheme: ConceptScheme,
    version: int,
    concepts: Mapping[UUID, ConceptView],
    groups: tuple[GroupView, ...] = (),
) -> SchemeSnapshot:
    return SchemeSnapshot(
        scheme_id=scheme.id,
        code=scheme.code,
        name=scheme.scheme_name,
        purpose=scheme.purpose,
        version=version,
        position=scheme.position,
        min_labels=scheme.min_labels,
        max_labels=scheme.max_labels,
        has_primary=scheme.has_primary,
        max_depth=scheme.max_depth,
        assign_top_concepts=scheme.assign_top_concepts,
        section_assignments=scheme.section_assignments,
        llm_policy=scheme.llm_policy,
        auto_threshold=None if scheme.auto_threshold is None else float(scheme.auto_threshold),
        review_threshold=None
        if scheme.review_threshold is None
        else float(scheme.review_threshold),
        concepts=dict(concepts),
        groups=groups,
    )


def prospective_state(concept: Concept) -> str:
    """The state the next publish gives ``concept``."""
    if concept.state == "draft":
        return "published"
    if deprecation_pending(concept):
        return "deprecated"
    return concept.state


async def working_snapshot(session: AsyncSession, scheme: ConceptScheme) -> SchemeSnapshot:
    """The version the next publish would store (``version`` = ``publishedVersion`` + 1)."""
    return (await working_snapshots(session, [scheme]))[scheme.id]


async def working_snapshots(
    session: AsyncSession, schemes: Sequence[ConceptScheme]
) -> dict[UUID, SchemeSnapshot]:
    """:func:`working_snapshot` of each of ``schemes`` (by ID), in a fixed number of statements."""
    by_scheme = {scheme.id: scheme for scheme in schemes}
    concepts = await live_concepts(session, list(by_scheme))
    every = [concept for own in concepts.values() for concept in own]
    views = await _concept_views(session, every, lambda concept: by_scheme[concept.scheme_id].code)
    groups = await group_views(session, list(by_scheme))
    snapshots: dict[UUID, SchemeSnapshot] = {}
    for scheme_id, scheme in by_scheme.items():
        by_id = {concept.id: concept for concept in concepts[scheme_id]}
        prospective = {
            cid: replace(
                views[cid],
                state=prospective_state(concept),
                broader=tuple(parent for parent in views[cid].broader if parent in by_id),
                related=tuple(other for other in views[cid].related if other in by_id),
            )
            for cid, concept in by_id.items()
        }
        snapshots[scheme_id] = scheme_snapshot(
            scheme, (scheme.published_version or 0) + 1, prospective, groups[scheme_id]
        )
    return snapshots


def notations(snapshot_or_views: Mapping[UUID, ConceptView], ids: Iterable[UUID]) -> list[str]:
    return [snapshot_or_views[cid].notation for cid in ids if cid in snapshot_or_views]


__all__ = [
    "TEMPLATES",
    "TaxonomyDeps",
    "api_state",
    "audit",
    "authorize",
    "concept_etag",
    "concept_views",
    "deprecation_pending",
    "find_scheme",
    "group_etag",
    "group_views",
    "live_concepts",
    "load_concept",
    "load_scheme",
    "notations",
    "now",
    "prospective_state",
    "scheme_etag",
    "scheme_snapshot",
    "touch",
    "working_snapshot",
    "working_snapshots",
]
