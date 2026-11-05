"""Collection IAM policies: Get/Set/TestItemIamPermissions."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from bomesh.db.engine import transaction_scope
from bomesh.errors import InvalidArgument
from bomesh.iam.authorizer import ItemRef
from bomesh.iam.policy import (
    COLLECTION_VIEWER,
    WORKSPACE_MEMBERS,
    Binding,
    Policy,
    PolicyStore,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.knowledge_items.records import PolicyRecord
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    absent,
    is_hidden_item,
    load_item,
)


class ItemIamService:
    """IAM policies set directly on COLLECTION items (inherited bindings excluded)."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemIamService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def get_policy(self, ctx: RequestContext, workspace_id: UUID, item_id: UUID) -> PolicyRecord:
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, item_id), "items.getIamPolicy", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            await load_item(session, ctx, workspace_id, item_id, permission="items.getIamPolicy")
            policy = await PolicyStore(session, ctx.authorizer).get_policy(
                ItemRef(workspace_id, item_id)
            )
        return _record(policy)

    async def set_policy(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        bindings: Sequence[tuple[str, Sequence[str]]],
        *,
        etag: str | None,
    ) -> PolicyRecord:
        """Replace the policy; ``workspaceMembers`` may only view."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, item_id), "items.setIamPolicy", write=True
        )
        for role, members in bindings:
            if WORKSPACE_MEMBERS in members and role != COLLECTION_VIEWER:
                raise InvalidArgument.for_field(
                    "policy.bindings",
                    f"{WORKSPACE_MEMBERS} may only hold {COLLECTION_VIEWER}.",
                )
        async with transaction_scope(self._deps.sessions) as session:
            await load_item(session, ctx, workspace_id, item_id, permission="items.setIamPolicy")
            policy = await PolicyStore(session, ctx.authorizer).set_policy(
                ctx.principal,
                ItemRef(workspace_id, item_id),
                [Binding(role, tuple(members)) for role, members in bindings],
                etag=etag,
            )
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="people",
                action="SetItemIamPolicy",
                target=item_name(workspace_id, item_id),
            )
        return _record(policy)

    async def test_permissions(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        permissions: Sequence[str],
    ) -> list[str]:
        """The requested permissions the caller holds on the item (effective)."""
        ref = ItemRef(workspace_id, item_id)
        await self._deps.workspaces.open(ctx, ref, "items.testIamPermissions", write=False)
        await ctx.authorizer.require(ctx.principal, "items.testIamPermissions", ref)
        if await is_hidden_item(ctx, item_id):
            raise await absent(ctx, ref, "items.testIamPermissions")
        held = await ctx.authorizer.test_permissions(ctx.principal, ref, permissions)
        return [permission for permission in dict.fromkeys(permissions) if permission in held]


def _record(policy: Policy) -> PolicyRecord:
    return PolicyRecord(
        bindings=tuple((binding.role, binding.members) for binding in policy.bindings),
        etag=policy.etag,
        version=policy.version,
    )


__all__ = ["ItemIamService"]
