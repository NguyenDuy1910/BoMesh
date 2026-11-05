"""Spaces (``workspaces/{w}/spaces/{space}``): CRUD with soft delete, join/leave and IAM.

Membership and roles are space-scoped IAM grants (``roles/spaceLead``,
``roles/spaceStaff``, ``roles/spaceMember``) written through
:class:`~bomesh.iam.policy.PolicyStore`; there is no membership table. The
creator becomes the lead; the last lead can never leave or be removed.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import RoleAssignment, Space
from bomesh.errors import AlreadyExists, FailedPrecondition, InvalidArgument
from bomesh.iam.authorizer import SpaceRef, WorkspaceRef
from bomesh.iam.policy import SPACE_LEAD, Binding, Policy, PolicyStore
from bomesh.services.collaboration.members import member_record, remove_from_space
from bomesh.services.collaboration.records import (
    SpaceMemberRecord,
    SpaceRecord,
    space_name,
)
from bomesh.services.collaboration.support import (
    SPACE_MEMBER,
    Gate,
    caller_role_column,
    find_space,
    lock_space,
    member_count_column,
    missing,
    not_purged,
    now,
    replay,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import require_restorable
from bomesh.services.knowledge_items.summary import collection_ids_for_spaces
from bomesh.services.workspaces.settings import workspace_settings

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

SPACE_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
JOIN_POLICIES = {"OPEN": "open", "REQUEST": "request", "INVITE": "invite"}
MAX_DISPLAY_NAME = 200


class SpaceService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._gate = Gate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SpaceService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    # -- Standard methods -----------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        space_id: str | None,
        display_name: str,
        space_type: str | None,
        description: str | None,
        join_policy: str | None,
        validate_only: bool,
        request_id: UUID | None,
    ) -> SpaceRecord:
        """A new space led by the caller (``joinPolicy`` defaults to INVITE)."""
        parent = f"workspaces/{workspace_id}"
        await self._gate.workspace(
            ctx, workspace_id, "spaces", "spaces.create", parent, write=True
        )
        await ctx.authorizer.require(
            ctx.principal, "spaces.create", WorkspaceRef(workspace_id)
        )
        code = (
            _space_id(space_id) if space_id is not None else f"space-{uuid4().hex[:12]}"
        )
        async with transaction_scope(self._sessions) as session:
            space = Space(
                tenant_id=workspace_id,
                code=code,
                display_name=_display_name(display_name),
                space_type=await _space_type(session, workspace_id, space_type),
                description=description or None,
                join_policy=_join_policy(join_policy) or "invite",
                created_by_user_id=ctx.user_id,
            )
            if validate_only:
                await _require_free(session, workspace_id, code)
                space.created_at = space.updated_at = now()
                return SpaceRecord(workspace_id, space, 1, SPACE_LEAD, ())
            idempotency = Idempotency(session, self._secret)
            key, replayed = await replay(
                idempotency,
                ctx,
                request_id,
                method="CreateSpace",
                parent=parent,
                request={
                    "spaceId": space_id,
                    "displayName": display_name,
                    "spaceType": space_type,
                    "description": description,
                    "joinPolicy": join_policy,
                },
            )
            if replayed is not None:
                return await self._load(
                    session, ctx, workspace_id, replayed.rsplit("/", 1)[-1]
                )
            await _require_free(session, workspace_id, code)
            session.add(space)
            await session.flush()
            await PolicyStore(session, ctx.authorizer).add_binding(
                SpaceRef(workspace_id, space.id),
                SPACE_LEAD,
                f"user:{ctx.user_id}",
                created_by=ctx.user_id,
            )
            name = space_name(workspace_id, code)
            await _audit(session, ctx, workspace_id, "CreateSpace", name)
            if key is not None:
                await idempotency.remember(key, name)
            return await self._load(session, ctx, workspace_id, code)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str
    ) -> SpaceRecord:
        """A space, soft-deleted ones included."""
        await self._gate.space(
            ctx, workspace_id, code, "spaces.get", write=False, include_deleted=True
        )
        async with transaction_scope(self._sessions) as session:
            return await self._load(session, ctx, workspace_id, code)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> list[SpaceRecord]:
        """Spaces on which the caller holds ``spaces.get``; DELETED ones only with ``showDeleted``."""
        parent = f"workspaces/{workspace_id}"
        await self._gate.workspace(
            ctx, workspace_id, "spaces", "spaces.list", parent, write=False
        )
        await ctx.authorizer.require(
            ctx.principal, "spaces.list", WorkspaceRef(workspace_id)
        )
        statement = _spaces(ctx.user_id).where(Space.tenant_id == workspace_id)
        statement = statement.where(
            not_purged(Space.deleted_at)
            if query.show_deleted
            else Space.deleted_at.is_(None)
        )
        if "spaces.get" not in await ctx.authorizer.workspace_permissions(
            ctx.principal, workspace_id
        ):
            statement = statement.where(
                Space.id.in_(
                    select(RoleAssignment.space_id).where(
                        RoleAssignment.user_id == ctx.user_id,
                        RoleAssignment.deleted_at.is_(None),
                    )
                )
            )
        async with transaction_scope(self._sessions) as session:
            rows = list(await session.execute(query.apply(statement)))
            collections = await _collections(
                session, ctx, workspace_id, [space.id for space, _, _ in rows]
            )
        return [
            SpaceRecord(workspace_id, space, count, role, collections.get(space.id, ()))
            for space, count, role in rows
        ]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> SpaceRecord:
        """``changes`` keyed by mask path: displayName, spaceType, description, joinPolicy."""
        await self._gate.space(ctx, workspace_id, code, "spaces.update", write=True)
        async with transaction_scope(self._sessions) as session:
            space = await _locked(session, workspace_id, code)
            etag.check(expected_etag, _etag(workspace_id, space))
            if "displayName" in changes:
                space.display_name = _display_name(changes["displayName"])
            if "spaceType" in changes:
                space.space_type = await _space_type(
                    session, workspace_id, changes["spaceType"]
                )
            if "description" in changes:
                space.description = changes["description"] or None
            if "joinPolicy" in changes:
                space.join_policy = _join_policy(changes["joinPolicy"]) or "invite"
            space.updated_at = now()
            await session.flush()
            await _audit(
                session,
                ctx,
                workspace_id,
                "UpdateSpace",
                space_name(workspace_id, code),
            )
            return await self._load(session, ctx, workspace_id, code)

    async def delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        expected_etag: str | None,
    ) -> SpaceRecord:
        """Soft-delete: the space and its children are hidden until ``:undelete``."""
        await self._gate.space(ctx, workspace_id, code, "spaces.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            space = await _locked(session, workspace_id, code)
            etag.check(expected_etag, _etag(workspace_id, space))
            space.deleted_at = space.updated_at = now()
            await session.flush()
            await _audit(
                session,
                ctx,
                workspace_id,
                "DeleteSpace",
                space_name(workspace_id, code),
            )
            return await self._load(session, ctx, workspace_id, code)

    async def undelete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        expected_etag: str | None,
    ) -> SpaceRecord:
        await self._gate.space(
            ctx, workspace_id, code, "spaces.undelete", write=True, include_deleted=True
        )
        async with transaction_scope(self._sessions) as session:
            space = await find_space(session, workspace_id, code, for_update=True)
            if space is None:
                raise missing(space_name(workspace_id, code))
            require_restorable(space.deleted_at, space_name(workspace_id, code))
            etag.check(expected_etag, _etag(workspace_id, space))
            if space.deleted_at is None:
                raise AlreadyExists(f"The space '{code}' is not deleted.")
            space.deleted_at = None
            space.updated_at = now()
            await session.flush()
            await _audit(
                session,
                ctx,
                workspace_id,
                "UndeleteSpace",
                space_name(workspace_id, code),
            )
            return await self._load(session, ctx, workspace_id, code)

    # -- Membership -----------------------------------------------------------

    async def join(
        self, ctx: RequestContext, workspace_id: UUID, code: str
    ) -> SpaceMemberRecord:
        """Add the caller as ``roles/spaceMember`` of an OPEN space; returns the new member."""
        space = await self._gate.space(
            ctx, workspace_id, code, "spaces.join", write=True
        )
        if space.join_policy != "open":
            raise FailedPrecondition(
                "The space is not open; file a SPACE_MEMBERSHIP request instead.",
                reason="SPACE_NOT_OPEN",
            )
        async with transaction_scope(self._sessions) as session:
            await lock_space(session, space.id)
            if await _has_grant(session, space.id, ctx.user_id):
                raise AlreadyExists("You are already a member of this space.")
            await PolicyStore(session, ctx.authorizer).add_binding(
                SpaceRef(workspace_id, space.id),
                SPACE_MEMBER,
                f"user:{ctx.user_id}",
                created_by=ctx.user_id,
            )
            await _audit(
                session, ctx, workspace_id, "JoinSpace", space_name(workspace_id, code)
            )
            return await member_record(session, workspace_id, space, ctx.user_id)

    async def leave(self, ctx: RequestContext, workspace_id: UUID, code: str) -> None:
        """Drop every space binding of the caller (NOT_SPACE_MEMBER, LAST_SPACE_LEAD)."""
        space = await self._gate.space(
            ctx, workspace_id, code, "spaces.leave", write=True
        )
        async with transaction_scope(self._sessions) as session:
            await lock_space(session, space.id)
            if not await _has_grant(session, space.id, ctx.user_id):
                raise FailedPrecondition(
                    "You are not a member of this space.", reason="NOT_SPACE_MEMBER"
                )
            await remove_from_space(session, ctx, workspace_id, space.id, ctx.user_id)
            await _audit(
                session, ctx, workspace_id, "LeaveSpace", space_name(workspace_id, code)
            )

    # -- IAM ------------------------------------------------------------------

    async def get_policy(
        self, ctx: RequestContext, workspace_id: UUID, code: str
    ) -> Policy:
        space = await self._gate.space(
            ctx, workspace_id, code, "spaces.getIamPolicy", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await PolicyStore(session, ctx.authorizer).get_policy(
                SpaceRef(workspace_id, space.id)
            )

    async def set_policy(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        bindings: Sequence[Binding],
        *,
        expected_etag: str | None,
    ) -> Policy:
        space = await self._gate.space(
            ctx, workspace_id, code, "spaces.setIamPolicy", write=True
        )
        async with transaction_scope(self._sessions) as session:
            policy = await PolicyStore(session, ctx.authorizer).set_policy(
                ctx.principal,
                SpaceRef(workspace_id, space.id),
                bindings,
                etag=expected_etag,
            )
            await _audit(
                session,
                ctx,
                workspace_id,
                "SetSpaceIamPolicy",
                space_name(workspace_id, code),
                details={"roles": [binding.role for binding in policy.bindings]},
            )
            return policy

    async def test_permissions(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        permissions: Iterable[str],
    ) -> list[str]:
        """The requested permissions the caller holds on the space, in request order."""
        space = await self._gate.space(
            ctx, workspace_id, code, "spaces.testIamPermissions", write=False
        )
        requested = list(dict.fromkeys(permissions))
        held = await ctx.authorizer.test_permissions(
            ctx.principal, SpaceRef(workspace_id, space.id), requested
        )
        return [permission for permission in requested if permission in held]

    # -- Internals ------------------------------------------------------------

    async def _load(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, code: str
    ) -> SpaceRecord:
        row = (
            await session.execute(
                _spaces(ctx.user_id).where(
                    Space.tenant_id == workspace_id, Space.code == code
                )
            )
        ).one_or_none()
        if row is None:
            raise missing(space_name(workspace_id, code))
        space, count, role = row
        collections = await _collections(session, ctx, workspace_id, [space.id])
        return SpaceRecord(
            workspace_id, space, count, role, collections.get(space.id, ())
        )


def _spaces(user_id: UUID) -> Select[Any]:
    return select(Space, member_count_column(), caller_role_column(user_id))


async def _collections(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    space_ids: list[UUID],
) -> dict[UUID, tuple[UUID, ...]]:
    """The COLLECTION items linked to each space that the caller can read."""
    if not space_ids:
        return {}
    return await collection_ids_for_spaces(
        session,
        workspace_id,
        space_ids,
        principal=ctx.principal,
        authorizer=ctx.authorizer,
    )


async def _locked(session: AsyncSession, workspace_id: UUID, code: str) -> Space:
    space = await find_space(session, workspace_id, code, for_update=True)
    if space is None or space.deleted_at is not None:
        raise missing(space_name(workspace_id, code))
    return space


async def _has_grant(session: AsyncSession, space_id: UUID, user_id: UUID) -> bool:
    return (
        await session.scalar(
            select(RoleAssignment.id)
            .where(
                RoleAssignment.space_id == space_id,
                RoleAssignment.user_id == user_id,
                RoleAssignment.deleted_at.is_(None),
            )
            .limit(1)
        )
        is not None
    )


async def _require_free(session: AsyncSession, workspace_id: UUID, code: str) -> None:
    if await find_space(session, workspace_id, code) is not None:
        raise AlreadyExists(f"The space ID '{code}' is already taken.")


def _etag(workspace_id: UUID, space: Space) -> str:
    return etag.compute(space_name(workspace_id, space.code), space.updated_at)


def _space_id(value: str) -> str:
    if not SPACE_ID.match(value):
        raise InvalidArgument.for_field(
            "spaceId", "spaceId must match ^[a-z][a-z0-9-]{0,62}$."
        )
    return value


def _display_name(value: str | None) -> str:
    title = (value or "").strip()
    if not title:
        raise InvalidArgument.for_field("displayName", "displayName is required.")
    if len(title) > MAX_DISPLAY_NAME:
        raise InvalidArgument.for_field(
            "displayName", f"displayName is longer than {MAX_DISPLAY_NAME} characters."
        )
    return title


def _join_policy(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if value not in JOIN_POLICIES:
        raise InvalidArgument.for_field(
            "joinPolicy", "joinPolicy must be OPEN, REQUEST or INVITE."
        )
    return JOIN_POLICIES[value]


async def _space_type(
    session: AsyncSession, workspace_id: UUID, value: str | None
) -> str:
    """A key of ``WorkspaceSettings.spaceTypes``; empty when the caller sets none."""
    if not value:
        return ""
    settings = await workspace_settings(session, workspace_id)
    if value not in {entry.key for entry in settings.space_types if entry.enabled}:
        raise InvalidArgument.for_field(
            "spaceType", f"'{value}' is not a space type of this workspace."
        )
    return value


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    action: str,
    target: str,
    *,
    details: Mapping[str, Any] | None = None,
) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=workspace_id,
        category="spaces",
        action=action,
        target=target,
        details=details,
    )


__all__ = ["JOIN_POLICIES", "SpaceService"]
