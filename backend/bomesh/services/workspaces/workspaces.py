"""Workspaces: create (LRO), read, update, lifecycle and ingestion pause (``api_design.md`` §4)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Operation, Tenant, TenantMembership, User
from bomesh.db.models.workspaces import TENANT_TEMPLATES
from bomesh.errors import AlreadyExists, FailedPrecondition, InvalidArgument
from bomesh.iam.authorizer import PlatformRef, WorkspaceRef, not_found
from bomesh.iam.policy import WORKSPACE_ADMIN, PolicyStore
from bomesh.services.identity.identity_store import IdentityStoreService
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.operations import OPERATION_HANDLERS, Operations
from bomesh.services.kernel.workspaces import (
    WorkspaceResolver,
    parse_workspace_name,
    workspace_name,
)
from bomesh.services.knowledge_items.item_store import ensure_personal_collection
from bomesh.services.workspaces.records import WorkspaceRecord
from bomesh.services.workspaces.support import (
    lock_workspace,
    member_count_of,
    own_operation,
)

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
_WORKSPACES = PlatformRef("workspaces")


@dataclass(frozen=True, slots=True)
class NewWorkspace:
    display_name: str
    code: str
    initial_admin_email: str
    template: str = "enterprise"
    demo: bool = False


class WorkspaceService:
    """Workspace resources; lifecycle methods are exempt from the state rules."""

    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> WorkspaceService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    # -- Create ---------------------------------------------------------------

    async def create(
        self, ctx: RequestContext, spec: NewWorkspace, *, request_id: UUID | None
    ) -> Operation:
        """CreateWorkspace: provision and finish the operation in ONE transaction.

        The workspace (CREATING → ACTIVE), its first admin, the admin's PERSONAL
        collection and the finished operation commit together, so a failure,
        a dropped connection or a crash leaves no CREATING workspace and no
        unfinished operation behind: the request simply fails.
        """
        await ctx.authorizer.require(ctx.principal, "workspaces.create", _WORKSPACES)
        spec = _validated(spec)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateWorkspace",
                    parent="",
                    request=_request_of(spec),
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await own_operation(session, ctx.user_id, replayed)
            admin = await _initial_admin(session, spec.initial_admin_email)
            workspace = await _insert_workspace(session, spec)
            operations = Operations(session)
            operation = await operations.create(
                ctx.principal,
                verb="createWorkspace",
                target=workspace_name(workspace.id),
                workspace_id=workspace.id,
            )
            await _provision(session, ctx, workspace.id, admin.id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace.id,
                category="settings",
                action="CreateWorkspace",
                target=workspace_name(workspace.id),
            )
            operation = await operations.complete(
                operation.id, result_name=workspace_name(workspace.id)
            )
            if key is not None:
                await idempotency.remember(key, f"operations/{operation.id}")
            return operation

    # -- Read -----------------------------------------------------------------

    async def get(self, ctx: RequestContext, workspace_id: UUID) -> WorkspaceRecord:
        await ctx.authorizer.require(ctx.principal, "workspaces.get", WorkspaceRef(workspace_id))
        return await self.load(workspace_id)

    async def load(self, workspace_id: UUID) -> WorkspaceRecord:
        """The workspace without any permission check (operation results, other slices)."""
        async with transaction_scope(self._sessions) as session:
            record = await _record(session, workspace_id)
        if record is None:
            raise not_found(WorkspaceRef(workspace_id))
        return record

    async def list(self, ctx: RequestContext, query: ListQuery) -> list[WorkspaceRecord]:
        """Every workspace for ``workspaces.list`` holders, else the caller's active ones."""
        statement = _records()
        if "workspaces.list" not in await ctx.authorizer.platform_permissions(ctx.principal):
            statement = statement.where(
                Tenant.id.in_(
                    select(TenantMembership.tenant_id).where(
                        TenantMembership.user_id == ctx.user_id,
                        TenantMembership.status == "active",
                        TenantMembership.deleted_at.is_(None),
                    )
                )
            )
        async with transaction_scope(self._sessions) as session:
            rows = (await session.execute(query.apply(statement))).all()
        return [WorkspaceRecord(workspace, count) for workspace, count in rows]

    # -- Update ---------------------------------------------------------------

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        changes: dict[str, Any],
        *,
        expected_etag: str | None,
    ) -> WorkspaceRecord:
        """``changes`` keyed by mask path: ``displayName`` and/or ``code``."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.update", write=True
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _etag(workspace))
            if "displayName" in changes:
                workspace.name = _display_name(changes["displayName"])
            if "code" in changes:
                code = _code(changes["code"])
                if code != workspace.code:
                    await _require_free_code(session, code)
                    workspace.code = code
            await _flush_unique(session)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="settings",
                action="UpdateWorkspace",
                target=workspace_name(workspace_id),
                details={"fields": sorted(changes)},
            )
            return await _require_record(session, workspace_id)

    # -- Lifecycle ------------------------------------------------------------

    async def archive(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        confirmation_code: str,
        expected_etag: str | None,
    ) -> WorkspaceRecord:
        """ACTIVE/SUSPENDED → ARCHIVED; ``confirmation_code`` must equal the code."""
        await ctx.authorizer.require(
            ctx.principal, "workspaces.archive", WorkspaceRef(workspace_id)
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _etag(workspace))
            if confirmation_code != workspace.code:
                raise InvalidArgument.for_field(
                    "confirmationCode", "confirmationCode must equal the workspace code."
                )
            _require_state(workspace, ("active", "suspended"), "archived")
            workspace.status = "archived"
            workspace.settings = {
                **workspace.settings,
                "archive": {
                    "archived_at": datetime.now(UTC).isoformat(),
                    "archived_by_user_id": str(ctx.user_id),
                },
            }
            return await self._transitioned(session, ctx, workspace, "ArchiveWorkspace")

    async def suspend(
        self, ctx: RequestContext, workspace_id: UUID, *, expected_etag: str | None
    ) -> WorkspaceRecord:
        """ACTIVE → SUSPENDED."""
        await ctx.authorizer.require(
            ctx.principal, "workspaces.suspend", WorkspaceRef(workspace_id)
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _etag(workspace))
            _require_state(workspace, ("active",), "suspended")
            workspace.status = "suspended"
            return await self._transitioned(session, ctx, workspace, "SuspendWorkspace")

    async def activate(
        self, ctx: RequestContext, workspace_id: UUID, *, expected_etag: str | None
    ) -> WorkspaceRecord:
        """SUSPENDED or ARCHIVED → ACTIVE (also unarchives)."""
        await ctx.authorizer.require(
            ctx.principal, "workspaces.activate", WorkspaceRef(workspace_id)
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _etag(workspace))
            _require_state(workspace, ("suspended", "archived"), "active")
            workspace.status = "active"
            workspace.settings = {
                key: value for key, value in workspace.settings.items() if key != "archive"
            }
            return await self._transitioned(session, ctx, workspace, "ActivateWorkspace")

    async def pause_ingestion(
        self, ctx: RequestContext, workspace_id: UUID, *, expected_etag: str | None
    ) -> WorkspaceRecord:
        """``ingestionState`` ACTIVE → PAUSED: no run or source sync starts."""
        return await self._set_ingestion(
            ctx, workspace_id, paused=True, expected_etag=expected_etag
        )

    async def resume_ingestion(
        self, ctx: RequestContext, workspace_id: UUID, *, expected_etag: str | None
    ) -> WorkspaceRecord:
        """``ingestionState`` PAUSED → ACTIVE."""
        return await self._set_ingestion(
            ctx, workspace_id, paused=False, expected_etag=expected_etag
        )

    async def _set_ingestion(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        paused: bool,
        expected_etag: str | None,
    ) -> WorkspaceRecord:
        permission = "workspaces.pauseIngestion" if paused else "workspaces.resumeIngestion"
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), permission, write=True)
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _etag(workspace))
            if (workspace.ingestion_paused_at is not None) == paused:
                raise FailedPrecondition(
                    "Ingestion is already paused." if paused else "Ingestion is not paused.",
                    reason="INGESTION_ALREADY_PAUSED" if paused else "INGESTION_NOT_PAUSED",
                )
            workspace.ingestion_paused_at = datetime.now(UTC) if paused else None
            action = "PauseWorkspaceIngestion" if paused else "ResumeWorkspaceIngestion"
            return await self._transitioned(session, ctx, workspace, action)

    async def _transitioned(
        self, session: AsyncSession, ctx: RequestContext, workspace: Tenant, action: str
    ) -> WorkspaceRecord:
        await session.flush()
        await Audit(session).record(
            ctx,
            workspace_id=workspace.id,
            category="settings",
            action=action,
            target=workspace_name(workspace.id),
        )
        return await _require_record(session, workspace.id)


# -- Provisioning ---------------------------------------------------------------


async def _provision(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, admin_id: UUID
) -> None:
    """The initial admin's membership, ``roles/workspaceAdmin`` and PERSONAL collection."""
    await IdentityStoreService(session).assign_membership(admin_id, workspace_id)
    await PolicyStore(session, ctx.authorizer).add_binding(
        WorkspaceRef(workspace_id), WORKSPACE_ADMIN, f"user:{admin_id}", created_by=ctx.user_id
    )
    await ensure_personal_collection(session, workspace_id, admin_id)
    workspace = await lock_workspace(session, workspace_id)
    workspace.status = "active"
    await session.flush()


async def _initial_admin(session: AsyncSession, email: str) -> User:
    user = await session.scalar(select(User).where(User.email == email.strip().casefold()))
    if user is None or user.status != "active":
        raise InvalidArgument.for_field(
            "initialAdminEmail", "initialAdminEmail must be the email of an active account."
        )
    return user


async def _insert_workspace(session: AsyncSession, spec: NewWorkspace) -> Tenant:
    await _require_free_code(session, spec.code)
    workspace = Tenant(
        code=spec.code,
        name=spec.display_name,
        template=spec.template,
        demo=spec.demo,
        status="creating",
    )
    session.add(workspace)
    await _flush_unique(session)
    return workspace


# -- Queries --------------------------------------------------------------------


def _records() -> Select[tuple[Tenant, int]]:
    return select(Tenant, member_count_of(Tenant.id))


async def _record(session: AsyncSession, workspace_id: UUID) -> WorkspaceRecord | None:
    row = (await session.execute(_records().where(Tenant.id == workspace_id))).first()
    if row is None:
        return None
    await session.refresh(row[0])
    return WorkspaceRecord(row[0], row[1])


async def _require_record(session: AsyncSession, workspace_id: UUID) -> WorkspaceRecord:
    record = await _record(session, workspace_id)
    if record is None:
        raise not_found(WorkspaceRef(workspace_id))
    return record


async def _require_free_code(session: AsyncSession, code: str) -> None:
    if await session.scalar(select(Tenant.id).where(Tenant.code == code)) is not None:
        raise _code_taken(code)


async def _flush_unique(session: AsyncSession) -> None:
    """Flush; a concurrent writer that took the same code is ALREADY_EXISTS."""
    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise _code_taken("") from None


def _code_taken(code: str) -> AlreadyExists:
    taken = f" '{code}'" if code else ""
    return AlreadyExists(
        f"The workspace code{taken} is already taken.", reason="WORKSPACE_CODE_TAKEN"
    )


def _etag(workspace: Tenant) -> str:
    return etag.compute(workspace_name(workspace.id), workspace.updated_at)


def _require_state(workspace: Tenant, allowed: tuple[str, ...], target: str) -> None:
    if workspace.status not in allowed:
        raise FailedPrecondition(
            f"A {workspace.status.upper()} workspace cannot become {target.upper()}.",
            reason="INVALID_WORKSPACE_STATE",
        )


# -- Validation -----------------------------------------------------------------


def _validated(spec: NewWorkspace) -> NewWorkspace:
    if spec.template not in TENANT_TEMPLATES:
        raise InvalidArgument.for_field("template", "template must be ENTERPRISE or CAMPUS.")
    if "@" not in spec.initial_admin_email:
        raise InvalidArgument.for_field("initialAdminEmail", "initialAdminEmail is required.")
    return NewWorkspace(
        display_name=_display_name(spec.display_name),
        code=_code(spec.code),
        initial_admin_email=spec.initial_admin_email.strip().casefold(),
        template=spec.template,
        demo=spec.demo,
    )


def _display_name(value: object) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or len(text) > 255:
        raise InvalidArgument.for_field("displayName", "displayName must be 1-255 characters.")
    return text


def _code(value: object) -> str:
    if not isinstance(value, str) or not CODE_PATTERN.match(value):
        raise InvalidArgument.for_field(
            "code", "code must match ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$."
        )
    return value


def _request_of(spec: NewWorkspace) -> dict[str, Any]:
    return {
        "displayName": spec.display_name,
        "code": spec.code,
        "template": spec.template,
        "demo": spec.demo,
        "initialAdminEmail": spec.initial_admin_email,
    }


async def load_created_workspace(runtime: AppRuntime, result_name: str) -> WorkspaceRecord:
    """The ``createWorkspace`` operation result: the workspace, unauthorized (reads are own-only)."""
    return await WorkspaceService.from_runtime(runtime).load(parse_workspace_name(result_name))


OPERATION_HANDLERS.register_result("createWorkspace", load_created_workspace)


__all__ = ["CODE_PATTERN", "NewWorkspace", "WorkspaceService", "load_created_workspace"]
