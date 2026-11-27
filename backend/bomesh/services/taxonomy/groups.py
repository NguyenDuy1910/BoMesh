"""Concept groups (skos:Collection): display grouping and query expansion, never a target.

Groups belong to the working copy: changes reach query mapping at the next
publish. ``members`` are live concepts of the scheme, in display order.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models.taxonomy import Concept, ConceptGroup, ConceptGroupMember, ConceptScheme
from bomesh.errors import AlreadyExists, FieldViolation, InvalidArgument, NotFound
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.taxonomy.names import concept_name, group_name, is_code
from bomesh.services.taxonomy.records import GroupRecord
from bomesh.services.taxonomy.support import (
    TaxonomyDeps,
    audit,
    authorize,
    group_etag,
    load_scheme,
    touch,
)

GROUP_FIELDS = ("displayName", "position", "members", "queryExpansion")


async def _load(
    session: AsyncSession, scheme: ConceptScheme, code: str, *, for_update: bool = False
) -> ConceptGroup:
    statement = select(ConceptGroup).where(ConceptGroup.scheme_id == scheme.id, ConceptGroup.code == code)
    if for_update:
        statement = statement.with_for_update()
    group = await session.scalar(statement)
    if group is None:
        raise NotFound(f"'{group_name(scheme.tenant_id, scheme.code, code)}' does not exist.")
    return group


async def group_records(
    session: AsyncSession, scheme: ConceptScheme, groups: Sequence[ConceptGroup]
) -> list[GroupRecord]:
    members: dict[UUID, list[str]] = {}
    if groups:
        for group_id, notation in (
            await session.execute(
                select(ConceptGroupMember.group_id, Concept.notation)
                .join(Concept, Concept.id == ConceptGroupMember.concept_id)
                .where(ConceptGroupMember.group_id.in_([group.id for group in groups]))
                .order_by(ConceptGroupMember.group_id, ConceptGroupMember.position)
            )
        ).tuples():
            members.setdefault(group_id, []).append(concept_name(scheme.tenant_id, scheme.code, notation))
    return [
        GroupRecord(
            name=group_name(scheme.tenant_id, scheme.code, group.code),
            display_name=group.group_name,
            position=group.position,
            members=tuple(members.get(group.id, ())),
            query_expansion=group.query_expansion,
            create_time=group.created_at,
            update_time=group.updated_at,
            etag=group_etag(scheme, group),
        )
        for group in groups
    ]


async def _members(session: AsyncSession, scheme: ConceptScheme, notations: Sequence[str]) -> list[UUID]:
    found = dict(
        (
            await session.execute(
                select(Concept.notation, Concept.id).where(
                    Concept.scheme_id == scheme.id,
                    Concept.notation.in_(list(notations)),
                    Concept.deleted_at.is_(None),
                )
            )
        ).tuples().all()
    )
    problems = [
        FieldViolation(f"members[{position}]", f"'{notation}' is not a live concept of this scheme.")
        for position, notation in enumerate(notations)
        if notation not in found
    ]
    if problems:
        raise InvalidArgument(problems[0].description, field_violations=problems)
    ids: list[UUID] = []
    for notation in notations:
        if found[notation] not in ids:
            ids.append(found[notation])
    return ids


async def _apply(
    session: AsyncSession, scheme: ConceptScheme, group: ConceptGroup, changes: Mapping[str, Any]
) -> None:
    if "displayName" in changes:
        name = (changes["displayName"] or "").strip()
        if not name or len(name) > 255:
            raise InvalidArgument.for_field("displayName", "displayName is required (≤ 255 characters).")
        group.group_name = name
    if "position" in changes:
        group.position = int(changes["position"] or 0)
    if "queryExpansion" in changes:
        group.query_expansion = bool(changes["queryExpansion"])
    await session.flush()
    if "members" in changes:
        ids = await _members(session, scheme, list(changes["members"] or ()))
        await session.execute(delete(ConceptGroupMember).where(ConceptGroupMember.group_id == group.id))
        if ids:
            await session.execute(
                insert(ConceptGroupMember),
                [{"group_id": group.id, "concept_id": cid, "position": index} for index, cid in enumerate(ids)],
            )
    await touch(session, group, scheme)
    await session.flush()


class GroupService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> GroupService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        code: str,
        changes: Mapping[str, Any],
    ) -> GroupRecord:
        await authorize(ctx, tenant_id, "conceptSchemes.update", write=True)
        if not is_code(code):
            raise InvalidArgument.for_field("groupId", "A group ID matches ^[a-z][a-z0-9-]{0,62}$.")
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            exists = await session.scalar(
                select(ConceptGroup.id).where(ConceptGroup.scheme_id == scheme.id, ConceptGroup.code == code)
            )
            if exists is not None:
                raise AlreadyExists(f"'{group_name(tenant_id, scheme_code, code)}' already exists.")
            group = ConceptGroup(scheme_id=scheme.id, code=code, group_name="")
            session.add(group)
            await _apply(session, scheme, group, {"displayName": changes.get("displayName"), **changes})
            records = await group_records(session, scheme, [group])
            await audit(
                session, ctx, tenant_id, "CreateConceptGroup", records[0].name, after=_json(records[0])
            )
            return records[0]

    async def get(
        self, ctx: RequestContext, tenant_id: UUID | None, scheme_code: str, code: str
    ) -> GroupRecord:
        await authorize(ctx, tenant_id, "conceptSchemes.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code)
            return (await group_records(session, scheme, [await _load(session, scheme, code)]))[0]

    async def list(
        self, ctx: RequestContext, tenant_id: UUID | None, scheme_code: str, query: ListQuery
    ) -> list[GroupRecord]:
        await authorize(ctx, tenant_id, "conceptSchemes.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code)
            groups = list(
                await session.scalars(query.apply(select(ConceptGroup).where(ConceptGroup.scheme_id == scheme.id)))
            )
            return await group_records(session, scheme, groups)

    async def update(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        code: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> GroupRecord:
        await authorize(ctx, tenant_id, "conceptSchemes.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            group = await _load(session, scheme, code, for_update=True)
            etags.check(etag, group_etag(scheme, group))
            before = (await group_records(session, scheme, [group]))[0]
            await _apply(session, scheme, group, changes)
            after = (await group_records(session, scheme, [group]))[0]
            await audit(
                session, ctx, tenant_id, "UpdateConceptGroup", after.name, before=_json(before), after=_json(after)
            )
            return after

    async def delete(
        self, ctx: RequestContext, tenant_id: UUID | None, scheme_code: str, code: str, *, etag: str | None
    ) -> None:
        await authorize(ctx, tenant_id, "conceptSchemes.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=True)
            group = await _load(session, scheme, code, for_update=True)
            etags.check(etag, group_etag(scheme, group))
            before = (await group_records(session, scheme, [group]))[0]
            await session.delete(group)
            await touch(session, scheme)
            await session.flush()
            await audit(session, ctx, tenant_id, "DeleteConceptGroup", before.name, before=_json(before))


def _json(record: GroupRecord) -> dict[str, Any]:
    return {
        "displayName": record.display_name,
        "position": record.position,
        "members": list(record.members),
        "queryExpansion": record.query_expansion,
    }


__all__ = ["GROUP_FIELDS", "GroupService", "group_records"]
