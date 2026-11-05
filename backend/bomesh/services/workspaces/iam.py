"""Workspace IAM: Get/Set/TestIamPermissions and AnalyzeWorkspaceIamPolicy.

The analysis lists the effective roles of one principal on the workspace,
every COLLECTION item that is an access boundary (``inherit_access = false``,
roots included, hidden system collections excluded) and
every live space. A workspace role reaches every collection and space, so it
is listed on each of them too. A user counts only while their membership is
ACTIVE; groups count through active memberships of live groups.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ColumnElement, false, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Group,
    GroupMembership,
    Role,
    RoleAssignment,
    TenantMembership,
)
from bomesh.errors import InvalidArgument
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.iam.policy import WORKSPACE_MEMBERS, Binding, Policy, PolicyStore, role_name
from bomesh.services.collaboration.queries import live_space_rows
from bomesh.services.collaboration.records import space_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.knowledge_items.inventory import access_boundary_ids
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.records import IamAnalysisResult

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

@dataclass(frozen=True, slots=True)
class _Holder:
    """Which assignments belong to the analyzed principal."""

    user_ids: frozenset[UUID]
    group_ids: frozenset[UUID]
    all_members: bool

    def clause(self, *, collections: bool) -> ColumnElement[bool]:
        clauses: list[ColumnElement[bool]] = []
        if self.user_ids:
            clauses.append(RoleAssignment.user_id.in_(self.user_ids))
        if self.group_ids:
            clauses.append(RoleAssignment.group_id.in_(self.group_ids))
        if self.all_members and collections:
            clauses.append(RoleAssignment.all_members.is_(True))
        return or_(*clauses) if clauses else false()


class WorkspaceIamService:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> WorkspaceIamService:
        return cls(runtime.sessions())

    async def get_policy(self, ctx: RequestContext, workspace_id: UUID) -> Policy:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.getIamPolicy", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await PolicyStore(session, ctx.authorizer).get_policy(WorkspaceRef(workspace_id))

    async def set_policy(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        bindings: Sequence[Binding],
        *,
        expected_etag: str | None,
    ) -> Policy:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.setIamPolicy", write=True
        )
        async with transaction_scope(self._sessions) as session:
            policy = await PolicyStore(session, ctx.authorizer).set_policy(
                ctx.principal, WorkspaceRef(workspace_id), bindings, etag=expected_etag
            )
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="people",
                action="SetWorkspaceIamPolicy",
                target=workspace_name(workspace_id),
                details={"roles": [binding.role for binding in policy.bindings]},
            )
            return policy

    async def test_permissions(
        self, ctx: RequestContext, workspace_id: UUID, permissions: Iterable[str]
    ) -> list[str]:
        """The requested permissions the caller holds on the workspace, in request order."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.testIamPermissions", write=False
        )
        requested = list(dict.fromkeys(permissions))
        held = await ctx.authorizer.test_permissions(
            ctx.principal, WorkspaceRef(workspace_id), requested
        )
        return [permission for permission in requested if permission in held]

    async def analyze(
        self, ctx: RequestContext, workspace_id: UUID, principal: str
    ) -> list[IamAnalysisResult]:

        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.analyzeIamPolicy", write=False
        )
        async with transaction_scope(self._sessions) as session:
            holder = await _holder(session, workspace_id, principal)
            workspace_roles = await _roles(
                session,
                RoleAssignment.tenant_id == workspace_id,
                holder.clause(collections=False),
                key=RoleAssignment.tenant_id,
            )
            inherited = workspace_roles.get(workspace_id, set())
            boundaries = list(await session.scalars(access_boundary_ids(workspace_id)))
            collection_roles = await _roles(
                session,
                RoleAssignment.item_id.in_(boundaries),
                holder.clause(collections=True),
                key=RoleAssignment.item_id,
            )
            spaces = (await session.execute(live_space_rows(workspace_id))).all()
            space_roles = await _roles(
                session,
                RoleAssignment.space_id.in_([space_id for space_id, _ in spaces]),
                holder.clause(collections=False),
                key=RoleAssignment.space_id,
            )
        results = [IamAnalysisResult(workspace_name(workspace_id), tuple(sorted(inherited)))]
        results += [
            IamAnalysisResult(
                item_name(workspace_id, item_id),
                tuple(sorted(inherited | collection_roles.get(item_id, set()))),
            )
            for item_id in boundaries
        ]
        results += [
            IamAnalysisResult(
                space_name(workspace_id, code),
                tuple(sorted(inherited | space_roles.get(space_id, set()))),
            )
            for space_id, code in spaces
        ]
        return results


async def _holder(session: AsyncSession, workspace_id: UUID, principal: str) -> _Holder:
    if principal == WORKSPACE_MEMBERS:
        return _Holder(frozenset(), frozenset(), all_members=True)
    kind, _, value = principal.partition(":")
    if kind == "user":
        try:
            user_id = UUID(value)
        except ValueError:
            raise _invalid(principal) from None
        status = await session.scalar(
            select(TenantMembership.status).where(
                TenantMembership.tenant_id == workspace_id,
                TenantMembership.user_id == user_id,
                TenantMembership.deleted_at.is_(None),
            )
        )
        if status is None:
            raise InvalidArgument.for_field(
                "principal", f"'{principal}' is not a member of this workspace."
            )
        if status != "active":
            return _Holder(frozenset(), frozenset(), all_members=False)
        groups = await session.scalars(
            select(GroupMembership.group_id)
            .join(Group, Group.id == GroupMembership.group_id)
            .where(
                Group.tenant_id == workspace_id,
                Group.deleted_at.is_(None),
                GroupMembership.user_id == user_id,
                GroupMembership.status == "active",
                GroupMembership.deleted_at.is_(None),
            )
        )
        return _Holder(frozenset({user_id}), frozenset(groups), all_members=True)
    if kind == "group" and value:
        group_id = await session.scalar(
            select(Group.id).where(
                Group.tenant_id == workspace_id, Group.code == value, Group.deleted_at.is_(None)
            )
        )
        if group_id is None:
            raise InvalidArgument.for_field(
                "principal", f"'{principal}' is not a group of this workspace."
            )
        return _Holder(frozenset(), frozenset({group_id}), all_members=False)
    raise _invalid(principal)


async def _roles(
    session: AsyncSession,
    scope: ColumnElement[bool],
    holder: ColumnElement[bool],
    *,
    key: ColumnElement[UUID],
) -> dict[UUID, set[str]]:
    rows = await session.execute(
        select(key, Role)
        .join(Role, Role.id == RoleAssignment.role_id)
        .where(scope, holder, RoleAssignment.deleted_at.is_(None), Role.deleted_at.is_(None))
    )
    result: dict[UUID, set[str]] = defaultdict(set)
    for resource_id, role in rows:
        result[resource_id].add(role_name(role))
    return result


def _invalid(principal: str) -> InvalidArgument:
    return InvalidArgument.for_field(
        "principal",
        f"Invalid principal '{principal}'; expected user:{{userId}}, group:{{groupId}} "
        "or workspaceMembers.",
    )


__all__ = ["WorkspaceIamService"]
