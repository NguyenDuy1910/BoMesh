"""Ingestion resource names, reference parsing and caller classification.

Item and member names come from their owners (``knowledge_items.names``,
``workspaces.records``); the Source name from :mod:`~bomesh.services.ingestion.names`.
"""

from __future__ import annotations

from uuid import UUID

from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.names import source_name
from bomesh.services.kernel.context import RequestContext

#: ``workspaces/-``: read across workspaces (platform callers, AIP-159).
WILDCARD = "-"
DEFAULT_POLICY = "default"


def connector_name(connector: str) -> str:
    return f"connectors/{connector}"


def ingestion_policy_name(policy: str) -> str:
    return f"ingestionPolicies/{policy}"


def sync_name(workspace_id: UUID, source: str, sync_id: UUID) -> str:
    return f"{source_name(workspace_id, source)}/syncs/{sync_id}"


def run_name(workspace_id: UUID, run_id: UUID) -> str:
    return f"workspaces/{workspace_id}/ingestionRuns/{run_id}"


def task_name(workspace_id: UUID, run_id: UUID, item_id: UUID) -> str:
    return f"{run_name(workspace_id, run_id)}/tasks/{item_id}"


def parse_uuid(value: str, *, field: str) -> UUID:
    try:
        return UUID(value)
    except ValueError:
        raise InvalidArgument.for_field(field, f"'{value}' is not a valid ID.") from None


def parse_workspace_id(value: str, *, field: str = "workspace") -> UUID:
    """A workspace path ID; ``-`` is INVALID_ARGUMENT here."""
    return parse_uuid(value, field=field)


def parse_workspace_scope(value: str) -> UUID | None:
    """A workspace path ID, or ``None`` for the ``-`` wildcard."""
    return None if value == WILDCARD else parse_workspace_id(value)


def parse_child_name(
    name: str, *, workspace_id: UUID, collection: str, field: str
) -> str:
    """The ID in ``workspaces/{workspace_id}/{collection}/{id}``; anything else is INVALID_ARGUMENT.

    A name in another workspace is INVALID_ARGUMENT too: references never cross workspaces.
    """
    parts = name.split("/")
    if (
        len(parts) != 4
        or parts[0] != "workspaces"
        or parts[1] != str(workspace_id)
        or parts[2] != collection
        or not parts[3]
    ):
        raise InvalidArgument.for_field(
            field, f"'{name}' is not a {collection} name of workspaces/{workspace_id}."
        )
    return parts[3]


async def is_platform_caller(ctx: RequestContext, workspace_id: UUID) -> bool:
    """Whether the caller reaches the workspace only through a platform role.

    Such callers read metadata only (``api_design.md`` §6): never item names,
    selectors, file names or content.
    """
    return not await ctx.authorizer.is_active_member(ctx.principal, workspace_id)


__all__ = [
    "DEFAULT_POLICY",
    "WILDCARD",
    "connector_name",
    "ingestion_policy_name",
    "is_platform_caller",
    "parse_child_name",
    "parse_uuid",
    "parse_workspace_id",
    "parse_workspace_scope",
    "run_name",
    "sync_name",
    "task_name",
]
