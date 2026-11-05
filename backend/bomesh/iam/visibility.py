"""The Item visibility rule (``item_model.md`` §6.3) as reusable building blocks.

A COLLECTION is visible iff it is ACTIVE, every ancestor is ACTIVE and the
caller holds ``items.get`` on it. A DOCUMENT is visible iff it is ACTIVE,
every ancestor is ACTIVE, the caller holds ``items.get`` on its governing
collection, and it is PUBLISHED or the caller holds ``items.update`` there.
DELETED items are visible only to ``items.undelete`` holders (grants resolve
through the deleted cohort; the published rule still applies).

"Readable" means exactly this everywhere: lists, search, facets, counts,
references. :class:`ItemVisibility` turns it into one SQL predicate for
derived surfaces; :func:`require_visible_item` answers a Get with AIP-211
semantics. The contribution-reviewer exception (:func:`is_contribution_reviewer`)
applies only to GetItem, GetItemContent and ``alt=media``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, false, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Contribution, Item
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    Principal,
    not_found,
    permission_denied,
)

READ = "items.get"
EDIT = "items.update"
RESTORE = "items.undelete"
REVIEW = "contributions.review"


@dataclass(frozen=True, slots=True)
class ItemVisibility:
    """The caller's collection sets for one workspace, computed in PostgreSQL per request.

    ``readable``/``editable`` hold live, live-rooted collections where the
    caller has ``items.get``/``items.update``. ``restorable``/``restorable_editable``
    are filled only for ``showDeleted`` and resolve through deleted cohorts.
    """

    workspace_id: UUID
    readable: frozenset[UUID]
    editable: frozenset[UUID]
    restorable: frozenset[UUID] = frozenset()
    restorable_editable: frozenset[UUID] = frozenset()

    def clause(self, item: Any = Item) -> ColumnElement[bool]:
        """Predicate over ``item`` (the ``Item`` entity or an alias) selecting visible items.

        Usable in any list, search re-check or count; DELETED items are
        included only when the visibility was built with ``show_deleted``.
        """
        live = and_(
            item.tenant_id == self.workspace_id,
            item.deleted_at.is_(None),
            self._visible(item, self.readable, self.editable, include_deleted=False),
        )
        if not self.restorable:
            return live
        deleted = and_(
            item.tenant_id == self.workspace_id,
            item.deleted_at.is_not(None),
            self._visible(
                item, self.restorable, self.restorable_editable, include_deleted=True
            ),
        )
        return or_(live, deleted)

    def _visible(
        self,
        item: Any,
        readable: frozenset[UUID],
        editable: frozenset[UUID],
        *,
        include_deleted: bool,
    ) -> ColumnElement[bool]:
        if not readable:
            return false()
        governed = _governed_documents(
            self.workspace_id, readable, include_deleted=include_deleted
        )
        documents = select(governed.c.item_id).where(
            or_(
                governed.c.publication_state == "published",
                governed.c.collection_id.in_(editable),
            )
        )
        return or_(
            and_(item.item_type == "collection", item.id.in_(readable)),
            and_(item.item_type == "document", item.id.in_(documents)),
        )


async def item_visibility(
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    *,
    show_deleted: bool = False,
) -> ItemVisibility:
    """Compute the caller's :class:`ItemVisibility` for ``workspace_id``."""
    readable = await authorizer.allowed_collections(principal, workspace_id, READ)
    editable = await authorizer.allowed_collections(principal, workspace_id, EDIT)
    if not show_deleted:
        return ItemVisibility(workspace_id, readable, editable)
    return ItemVisibility(
        workspace_id,
        readable,
        editable,
        restorable=await authorizer.allowed_collections(
            principal, workspace_id, RESTORE, include_deleted=True
        ),
        restorable_editable=await authorizer.allowed_collections(
            principal, workspace_id, EDIT, include_deleted=True
        ),
    )


async def is_visible(
    authorizer: Authorizer, principal: Principal, ref: ItemRef
) -> bool:
    """Whether one ACTIVE item is visible to the caller (references, single checks)."""
    path = await authorizer.ancestry(ref.item_id)
    if not path or path[0].tenant_id != ref.workspace_id:
        return False
    if any(node.deleted_at is not None for node in path):
        return False
    held = await authorizer.collection_permissions(principal, ref.item_id)
    node = path[0]
    return _readable(node.item_type, node.publication_state == "published", held)


async def require_visible_item(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    ref: ItemRef,
    *,
    permission: str = READ,
    include_deleted: bool = False,
    reviewer_exception: bool = False,
    for_update: bool = False,
) -> Item:
    """Load an item the caller can see and holds ``permission`` on, in ``session``.

    - Visible and ``permission`` held → the row.
    - Visible without ``permission`` → PERMISSION_DENIED.
    - DELETED: only with ``include_deleted`` and only for ``items.undelete``
      holders (resolved through the deleted cohort, published rule applies).
    - ``reviewer_exception`` (GetItem, GetItemContent, ``alt=media`` only):
      reviewers of an open contribution read its candidate with ``items.get``.
    - Otherwise the item answers like an absent one (AIP-211): NOT_FOUND when
      the caller holds ``permission`` on the workspace, else PERMISSION_DENIED.
    """
    statement = select(Item).where(Item.id == ref.item_id, Item.tenant_id == ref.workspace_id)
    if for_update:
        statement = statement.with_for_update()
    item = await session.scalar(statement)
    if item is not None:
        path = await authorizer.ancestry(item.id)
        live = all(node.deleted_at is None for node in path)
        if live or include_deleted:
            held = await authorizer.collection_permissions(
                principal, item.id, include_deleted=not live
            )
            published = item.publication_state == "published"
            visible = _readable(item.item_type, published, held) and (
                live or RESTORE in held
            )
            if visible:
                if permission in held:
                    return item
                raise permission_denied(permission, ref)
        if (
            live
            and reviewer_exception
            and permission == READ
            and await is_contribution_reviewer(session, authorizer, principal, ref)
        ):
            return item
    if permission in await authorizer.workspace_permissions(principal, ref.workspace_id):
        raise not_found(ref)
    raise permission_denied(permission, ref)


async def is_contribution_reviewer(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, ref: ItemRef
) -> bool:
    """Whether the caller reviews an open contribution whose candidate is ``ref``.

    Reviewers hold ``contributions.review`` on the target collection; when
    it is empty, on the assistant-suggested collection or at workspace level.
    """
    open_contributions = await session.execute(
        select(Contribution.target_item_id, Contribution.suggestions).where(
            Contribution.tenant_id == ref.workspace_id,
            Contribution.item_id == ref.item_id,
            Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
            Contribution.deleted_at.is_(None),
        )
    )
    decisions = [
        target_item_id or _suggested_collection(suggestions)
        for target_item_id, suggestions in open_contributions
    ]
    if not decisions:
        return False
    if REVIEW in await authorizer.workspace_permissions(principal, ref.workspace_id):
        return True
    for collection_id in decisions:
        if collection_id is not None and REVIEW in await authorizer.collection_permissions(
            principal, collection_id
        ):
            return True
    return False


def _suggested_collection(suggestions: dict[str, Any]) -> UUID | None:
    value = suggestions.get("collection_id")
    try:
        return UUID(str(value)) if value else None
    except ValueError:
        return None


def _readable(item_type: str, published: bool, held: frozenset[str]) -> bool:
    if READ not in held:
        return False
    return item_type == "collection" or published or EDIT in held


def _governed_documents(
    workspace_id: UUID, collections: frozenset[UUID], *, include_deleted: bool
):
    """Documents under ``collections`` with their governing collection.

    Direct children of a collection are governed by it; CHILD/ATTACHMENT
    documents under a document inherit its governing collection.
    """

    def alive(column):
        return true() if include_deleted else column.is_(None)

    governed = (
        select(
            Item.id.label("item_id"),
            Item.parent_item_id.label("collection_id"),
            Item.publication_state.label("publication_state"),
        )
        .where(
            Item.tenant_id == workspace_id,
            Item.item_type == "document",
            Item.parent_item_id.in_(collections),
            alive(Item.deleted_at),
        )
        .cte(
            "governed_deleted_documents" if include_deleted else "governed_documents",
            recursive=True,
        )
    )
    child = Item.__table__.alias(
        "deleted_child_document" if include_deleted else "child_document"
    )
    return governed.union_all(
        select(child.c.id, governed.c.collection_id, child.c.publication_state).where(
            child.c.parent_item_id == governed.c.item_id,
            child.c.tenant_id == workspace_id,
            child.c.item_type == "document",
            alive(child.c.deleted_at),
        )
    )


__all__ = [
    "ItemVisibility",
    "is_contribution_reviewer",
    "is_visible",
    "item_visibility",
    "require_visible_item",
]
