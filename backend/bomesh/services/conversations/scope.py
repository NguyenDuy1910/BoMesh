"""What a conversation turn may read: its scope and this turn's attachments.

Every entry must be readable by the caller now (``item_model.md`` §6); the
contribution-reviewer exception never applies. Unreadable entries are
PERMISSION_DENIED, entries of the wrong kind INVALID_ARGUMENT.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Conversation
from bomesh.errors import InvalidArgument, PermissionDenied
from bomesh.iam.authorizer import ItemRef, SpaceRef, permission_denied
from bomesh.services.collaboration.membership import space_id_for_code
from bomesh.services.collaboration.records import space_name
from bomesh.services.collaboration.support import parse_space_name
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.knowledge_items.summary import (
    ItemSummary,
    collection_ids_for_spaces,
    get_item_summary,
)

_READ_ITEM = "items.get"
_READ_SPACE = "spaces.get"


async def require_scope(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    collections: Sequence[str],
    spaces: Sequence[str],
) -> tuple[tuple[UUID, ...], tuple[UUID, ...]]:
    """The IDs of ``scope.collections`` and ``scope.spaces`` names, each readable."""
    collection_ids = tuple(
        dict.fromkeys(parse_item(name, workspace_id, field="scope.collections") for name in collections)
    )
    space_codes = tuple(
        dict.fromkeys(parse_space_name(name, workspace_id, field="scope.spaces") for name in spaces)
    )
    for item_id in collection_ids:
        summary = await _readable(session, ctx, workspace_id, item_id)
        if summary.item_type != "COLLECTION":
            raise InvalidArgument.for_field(
                "scope.collections", f"Item '{item_id}' is not a COLLECTION item."
            )
    space_ids: list[UUID] = []
    for code in space_codes:
        space_id = await space_id_for_code(session, workspace_id, code)
        if space_id is None or not await _can_read_space(ctx, SpaceRef(workspace_id, space_id)):
            raise PermissionDenied(
                f"Permission '{_READ_SPACE}' denied on resource "
                f"'{space_name(workspace_id, code)}' (or it might not exist)."
            )
        space_ids.append(space_id)
    return collection_ids, tuple(space_ids)


async def retrieval_roots(
    session: AsyncSession, ctx: RequestContext, conversation: Conversation
) -> tuple[UUID, ...]:
    """The collection subtrees this turn searches.

    A conversation without scope searches every collection the caller can
    read. A scoped one re-checks its entries (a revoked one is
    PERMISSION_DENIED) and adds the collections of its spaces; the retriever
    still narrows every candidate to what the caller can read.
    """
    workspace_id = conversation.tenant_id
    if not conversation.scope_collection_ids and not conversation.scope_space_ids:
        return tuple(
            await ctx.authorizer.allowed_collections(ctx.principal, workspace_id, _READ_ITEM)
        )
    for item_id in conversation.scope_collection_ids:
        await _readable(session, ctx, workspace_id, item_id)
    for space_id in conversation.scope_space_ids:
        ref = SpaceRef(workspace_id, space_id)
        if not await _can_read_space(ctx, ref):
            raise permission_denied(_READ_SPACE, ref)
    spaces = await collection_ids_for_spaces(
        session,
        workspace_id,
        conversation.scope_space_ids,
        principal=ctx.principal,
        authorizer=ctx.authorizer,
    )
    return tuple(
        dict.fromkeys(
            (*conversation.scope_collection_ids, *(c for ids in spaces.values() for c in ids))
        )
    )


async def require_attachments(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, attachments: Sequence[str]
) -> tuple[UUID, ...]:
    """The readable DOCUMENT items ``attachments`` name (a merged duplicate resolves)."""
    resolved: list[UUID] = []
    for name in dict.fromkeys(attachments):
        item_id = parse_item(name, workspace_id, field="attachments")
        summary = await _readable(session, ctx, workspace_id, item_id)
        if summary.item_type != "DOCUMENT":
            raise InvalidArgument.for_field(
                "attachments", f"Attachment '{name}' is not a DOCUMENT item."
            )
        resolved.append(summary.item_id)
    return tuple(dict.fromkeys(resolved))


async def _can_read_space(ctx: RequestContext, ref: SpaceRef) -> bool:
    return bool(await ctx.authorizer.test_permissions(ctx.principal, ref, (_READ_SPACE,)))


async def _readable(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item_id: UUID
) -> ItemSummary:
    summary = await get_item_summary(session, ctx.authorizer, ctx.principal, workspace_id, item_id)
    if summary is None:
        raise permission_denied(_READ_ITEM, ItemRef(workspace_id, item_id))
    return summary


__all__ = ["require_attachments", "require_scope", "retrieval_roots"]
