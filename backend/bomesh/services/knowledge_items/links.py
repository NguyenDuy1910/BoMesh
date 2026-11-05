"""Item links: shortcuts of a Document inside another Collection (``item_model.md`` §4.2).

A link never grants access: it is shown only to callers who can read the
container and its (merge-resolved) target.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemLink
from bomesh.errors import AlreadyExists, FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import ItemRef
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.knowledge_items.item_store import (
    PURPOSE_ATTACHMENT,
    ItemService,
    catalog_visibility,
    has_open_contribution,
    purpose,
)
from bomesh.services.knowledge_items.names import item_name, link_name
from bomesh.services.knowledge_items.records import LinkRecord
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    load_item,
    load_referenced,
    visible_links,
)


class ItemLinkService:
    """Create, read, list and delete the links of one container collection."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemLinkService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        collection_id: UUID,
        target_id: UUID,
        *,
        request_id: UUID | None,
    ) -> LinkRecord:
        """CreateItemLink: the link ID is the target's item ID."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemLinks.create", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateItemLink",
                    parent=item_name(workspace_id, collection_id),
                    request={"targetItem": str(target_id)},
                )
                if await idempotency.replay(key) is not None:
                    return await self._get(session, ctx, workspace_id, collection_id, target_id)
            container = await load_item(
                session,
                ctx,
                workspace_id,
                collection_id,
                permission="itemLinks.create",
                include_deleted=True,
            )
            if container.item_type != "collection":
                raise InvalidArgument("Links live in COLLECTION items only.")
            if container.deleted_at is not None:
                raise FailedPrecondition("The collection is deleted.")
            target = await load_referenced(
                session, ctx, workspace_id, target_id, permission="items.get", include_deleted=True
            )
            await _check_target(session, container, target)
            items = ItemService(session)
            if await items.live_link(container.id, target.id) is not None:
                raise AlreadyExists("The collection already links this document.")
            session.add(
                ItemLink(
                    tenant_id=workspace_id,
                    collection_item_id=container.id,
                    target_item_id=target.id,
                    created_by_user_id=ctx.user_id,
                )
            )
            await session.flush()
            name = link_name(workspace_id, container.id, target.id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="CreateItemLink",
                target=name,
            )
            if key is not None:
                await idempotency.remember(key, name)
            return await self._get(session, ctx, workspace_id, collection_id, target_id)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, collection_id: UUID, target_id: UUID
    ) -> LinkRecord:
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemLinks.get", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            await load_item(session, ctx, workspace_id, collection_id, permission="itemLinks.get")
            return await self._get(session, ctx, workspace_id, collection_id, target_id)

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        collection_id: UUID,
        *,
        order_by: Sequence[Any],
        offset: int,
        limit: int,
    ) -> list[LinkRecord]:
        """ListItemLinks: links whose target the caller can see; others are omitted."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemLinks.list", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            container = await load_item(
                session, ctx, workspace_id, collection_id, permission="itemLinks.list"
            )
            if container.item_type != "collection":
                raise InvalidArgument("Links live in COLLECTION items only.")
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
            rows = await session.execute(
                visible_links(visibility, collection_id)
                .order_by(*order_by)
                .offset(offset)
                .limit(limit)
            )
            return [_record(workspace_id, *row) for row in rows]

    async def delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        collection_id: UUID,
        target_id: UUID,
        *,
        etag: str | None,
    ) -> LinkRecord:
        """DeleteItemLink: soft delete; the target is never affected."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemLinks.delete", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            await load_item(
                session, ctx, workspace_id, collection_id, permission="itemLinks.delete"
            )
            current = await self._get(session, ctx, workspace_id, collection_id, target_id)
            etags.check(etag, link_etag(current))
            link = await ItemService(session).live_link(collection_id, target_id)
            assert link is not None
            link.deleted_at = await session.scalar(select(func.now()))
            await session.flush()
            await session.refresh(link)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="DeleteItemLink",
                target=link_name(workspace_id, collection_id, target_id),
            )
            return LinkRecord(
                workspace_id=workspace_id,
                collection_id=collection_id,
                target_id=target_id,
                resolved_target_id=current.resolved_target_id,
                merged_from=current.merged_from,
                target_display_name=current.target_display_name,
                creator_id=link.created_by_user_id,
                create_time=link.created_at,
                update_time=link.updated_at,
                delete_time=link.deleted_at,
            )

    async def _get(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        collection_id: UUID,
        target_id: UUID,
    ) -> LinkRecord:
        visibility = await catalog_visibility(session, ctx.authorizer, ctx.principal, workspace_id)
        row = (
            await session.execute(
                visible_links(visibility, collection_id).where(
                    ItemLink.target_item_id == target_id
                )
            )
        ).first()
        if row is None:
            raise NotFound(
                f"Resource '{link_name(workspace_id, collection_id, target_id)}' was not found."
            )
        return _record(workspace_id, *row)


def link_etag(link: LinkRecord) -> str:
    return etags.compute(
        link_name(link.workspace_id, link.collection_id, link.target_id), link.update_time
    )


async def _check_target(session: AsyncSession, container: Item, target: Item) -> None:
    if target.item_type != "document":
        raise InvalidArgument(
            "A link targets a DOCUMENT.", reason="LINK_TARGET_NOT_DOCUMENT"
        )
    if target.deleted_at is not None:
        raise FailedPrecondition("The target document is deleted.")
    if target.parent_item_id == container.id:
        raise FailedPrecondition(
            "The document already lives in this collection.", reason="LINK_TO_OWN_PARENT"
        )
    if purpose(target) == PURPOSE_ATTACHMENT or await has_open_contribution(session, target.id):
        raise FailedPrecondition(
            "Conversation attachments and contribution candidates cannot be linked.",
            reason="LINK_TARGET_NOT_ALLOWED",
        )


def _record(workspace_id: UUID, link: ItemLink, target: Item, merged: Item | None) -> LinkRecord:
    resolved = merged if merged is not None else target
    return LinkRecord(
        workspace_id=workspace_id,
        collection_id=link.collection_item_id,
        target_id=link.target_item_id,
        resolved_target_id=resolved.id,
        merged_from=target.id if merged is not None else None,
        target_display_name=resolved.title,
        creator_id=link.created_by_user_id,
        create_time=link.created_at,
        update_time=link.updated_at,
        delete_time=link.deleted_at,
    )


__all__ = ["ItemLinkService", "link_etag"]
