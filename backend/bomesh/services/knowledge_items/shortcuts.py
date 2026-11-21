"""Item shortcuts: a Document shown inside another Collection (``item_model.md`` §4.2).

A shortcut never grants access: it is shown only to callers who can read the
container and its target.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemShortcut
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
from bomesh.services.knowledge_items.names import item_name, shortcut_name
from bomesh.services.knowledge_items.records import ShortcutRecord
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    load_item,
    load_referenced,
    visible_shortcuts,
)


class ItemShortcutService:
    """Create, read, list and delete the shortcuts of one container collection."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemShortcutService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        collection_id: UUID,
        target_id: UUID,
        *,
        request_id: UUID | None,
    ) -> ShortcutRecord:
        """CreateItemShortcut: the shortcut ID is the target's item ID."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemShortcuts.create", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateItemShortcut",
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
                permission="itemShortcuts.create",
                include_deleted=True,
            )
            if container.item_kind != "collection":
                raise InvalidArgument("Shortcuts live in COLLECTION items only.")
            if container.deleted_at is not None:
                raise FailedPrecondition("The collection is deleted.")
            target = await load_referenced(
                session, ctx, workspace_id, target_id, permission="items.get", include_deleted=True
            )
            await _check_target(session, container, target)
            items = ItemService(session)
            if await items.live_shortcut(container.id, target.id) is not None:
                raise AlreadyExists("The collection already has a shortcut to this document.")
            session.add(
                ItemShortcut(
                    tenant_id=workspace_id,
                    collection_item_id=container.id,
                    target_item_id=target.id,
                    created_by_user_id=ctx.user_id,
                )
            )
            await session.flush()
            name = shortcut_name(workspace_id, container.id, target.id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="CreateItemShortcut",
                target=name,
            )
            if key is not None:
                await idempotency.remember(key, name)
            return await self._get(session, ctx, workspace_id, collection_id, target_id)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, collection_id: UUID, target_id: UUID
    ) -> ShortcutRecord:
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemShortcuts.get", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            await load_item(session, ctx, workspace_id, collection_id, permission="itemShortcuts.get")
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
    ) -> list[ShortcutRecord]:
        """ListItemShortcuts: shortcuts whose target the caller can see; others are omitted."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemShortcuts.list", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            container = await load_item(
                session, ctx, workspace_id, collection_id, permission="itemShortcuts.list"
            )
            if container.item_kind != "collection":
                raise InvalidArgument("Shortcuts live in COLLECTION items only.")
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
            rows = await session.execute(
                visible_shortcuts(visibility, collection_id)
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
    ) -> ShortcutRecord:
        """DeleteItemShortcut: soft delete; the target is never affected."""
        await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, collection_id), "itemShortcuts.delete", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            await load_item(
                session, ctx, workspace_id, collection_id, permission="itemShortcuts.delete"
            )
            current = await self._get(session, ctx, workspace_id, collection_id, target_id)
            etags.check(etag, shortcut_etag(current))
            shortcut = await ItemService(session).live_shortcut(collection_id, target_id)
            assert shortcut is not None
            shortcut.deleted_at = await session.scalar(select(func.now()))
            await session.flush()
            await session.refresh(shortcut)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="DeleteItemShortcut",
                target=shortcut_name(workspace_id, collection_id, target_id),
            )
            return ShortcutRecord(
                workspace_id=workspace_id,
                collection_id=collection_id,
                target_id=target_id,
                target_display_name=current.target_display_name,
                creator_id=shortcut.created_by_user_id,
                create_time=shortcut.created_at,
                update_time=shortcut.updated_at,
                delete_time=shortcut.deleted_at,
            )

    async def _get(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        collection_id: UUID,
        target_id: UUID,
    ) -> ShortcutRecord:
        visibility = await catalog_visibility(session, ctx.authorizer, ctx.principal, workspace_id)
        row = (
            await session.execute(
                visible_shortcuts(visibility, collection_id).where(
                    ItemShortcut.target_item_id == target_id
                )
            )
        ).first()
        if row is None:
            raise NotFound(
                f"Resource '{shortcut_name(workspace_id, collection_id, target_id)}' was not found."
            )
        return _record(workspace_id, *row)


def shortcut_etag(shortcut: ShortcutRecord) -> str:
    return etags.compute(
        shortcut_name(shortcut.workspace_id, shortcut.collection_id, shortcut.target_id), shortcut.update_time
    )


async def _check_target(session: AsyncSession, container: Item, target: Item) -> None:
    if target.item_kind != "document":
        raise InvalidArgument(
            "A shortcut targets a DOCUMENT.", reason="LINK_TARGET_NOT_DOCUMENT"
        )
    if target.deleted_at is not None:
        raise FailedPrecondition("The target document is deleted.")
    if target.parent_item_id == container.id:
        raise FailedPrecondition(
            "The document already lives in this collection.", reason="LINK_TO_OWN_PARENT"
        )
    if purpose(target) == PURPOSE_ATTACHMENT or await has_open_contribution(session, target.id):
        raise FailedPrecondition(
            "Conversation attachments and contribution candidates cannot get a shortcut.",
            reason="LINK_TARGET_NOT_ALLOWED",
        )


def _record(workspace_id: UUID, shortcut: ItemShortcut, target: Item) -> ShortcutRecord:
    return ShortcutRecord(
        workspace_id=workspace_id,
        collection_id=shortcut.collection_item_id,
        target_id=shortcut.target_item_id,
        target_display_name=target.item_name,
        creator_id=shortcut.created_by_user_id,
        create_time=shortcut.created_at,
        update_time=shortcut.updated_at,
        delete_time=shortcut.deleted_at,
    )


__all__ = ["ItemShortcutService", "shortcut_etag"]
