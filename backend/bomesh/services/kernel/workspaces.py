"""Resolve the workspace a request names and apply its state and module rules.

State rules (``api_design.md`` §4): inside a workspace that is CREATING every
method fails FAILED_PRECONDITION ``WORKSPACE_CREATING``; SUSPENDED fails
``WORKSPACE_SUSPENDED``; ARCHIVED is read-only, so writes fail
``WORKSPACE_ARCHIVED``. Workspace lifecycle methods (Get, Suspend, Activate,
Archive) read the workspace with :meth:`WorkspaceResolver.get` and are not
subject to them. A module switched off in ``WorkspaceSettings.modules`` fails
FAILED_PRECONDITION ``MODULE_DISABLED``; a module not mentioned is on.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Tenant
from bomesh.errors import FailedPrecondition, InvalidArgument
from bomesh.iam.authorizer import (
    ItemRef,
    SpaceRef,
    WorkspaceRef,
    not_found,
    permission_denied,
)
from bomesh.services.kernel.context import RequestContext

Module = Literal["spaces", "work", "requests"]

_STATE_REASONS = {
    "creating": ("The workspace is still being created.", "WORKSPACE_CREATING"),
    "suspended": ("The workspace is suspended.", "WORKSPACE_SUSPENDED"),
}


def workspace_name(workspace_id: UUID) -> str:
    return f"workspaces/{workspace_id}"


def parse_workspace_name(name: str, *, field: str = "name") -> UUID:
    """The ID of ``workspaces/{workspace}``; INVALID_ARGUMENT for anything else."""
    collection, _, value = name.partition("/")
    if collection == "workspaces" and "/" not in value:
        try:
            return UUID(value)
        except ValueError:
            pass
    raise InvalidArgument.for_field(field, f"'{name}' is not a workspace name.")


class WorkspaceResolver:
    """Load workspaces for services."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    async def get(self, workspace_id: UUID) -> Tenant:
        """The workspace row whatever its state; NOT_FOUND if absent (check permission first)."""
        async with transaction_scope(self._sessions) as session:
            workspace = await session.get(Tenant, workspace_id)
        if workspace is None:
            raise not_found(WorkspaceRef(workspace_id))
        return workspace

    async def open(
        self,
        ctx: RequestContext,
        resource: WorkspaceRef | ItemRef | SpaceRef,
        permission: str,
        *,
        write: bool,
    ) -> Tenant:
        """Gate a request inside a workspace, then apply the state rules.

        On a :class:`WorkspaceRef` this enforces ``permission`` itself. On an
        item or space it only requires an ACTIVE membership (PERMISSION_DENIED
        naming ``resource`` otherwise); the caller then checks ``permission``
        on the resource (``Authorizer.require``, ``require_visible_item``).
        """
        if isinstance(resource, WorkspaceRef):
            await ctx.authorizer.require(ctx.principal, permission, resource)
        elif not await ctx.authorizer.is_active_member(ctx.principal, resource.workspace_id):
            raise permission_denied(permission, resource)
        workspace = await self.get(resource.workspace_id)
        require_usable(workspace, write=write)
        return workspace


def require_usable(workspace: Tenant, *, write: bool) -> None:
    """Apply the workspace state rules of the module docstring."""
    if workspace.status in _STATE_REASONS:
        message, reason = _STATE_REASONS[workspace.status]
        raise FailedPrecondition(message, reason=reason)
    if write and workspace.status == "archived":
        raise FailedPrecondition("The workspace is archived.", reason="WORKSPACE_ARCHIVED")


def require_module(workspace: Tenant, module: Module) -> None:
    """MODULE_DISABLED when ``WorkspaceSettings.modules[module]`` is false."""
    modules = workspace.settings.get("modules") or {}
    if modules.get(module, True) is False:
        raise FailedPrecondition(
            f"The {module} module is turned off in this workspace.",
            reason="MODULE_DISABLED",
            metadata={"module": module},
        )


__all__ = [
    "Module",
    "WorkspaceResolver",
    "parse_workspace_name",
    "require_module",
    "require_usable",
    "workspace_name",
]
