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

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import CTE, ColumnElement, Select, and_, false, or_, select, true, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Contribution, Item
from bomesh.db.models.knowledge import DOCUMENT_CHILD_RELATIONS, OPEN_CONTRIBUTION_STATES
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
    #: The ``visible_items`` CTE, built on first use so every clause of one
    #: statement shares it.
    _visible: CTE | None = field(default=None, init=False, repr=False, compare=False)

    def clause(self, item: Any = Item) -> ColumnElement[bool]:
        """Predicate over ``item`` (the ``Item`` entity or an alias) selecting visible items.

        Usable in any list, search re-check or count; DELETED items are
        included only when the visibility was built with ``show_deleted``.
        It probes one materialized set of visible item ids
        (:meth:`_visible_items`) as a hashed SubPlan: the set is computed once
        per statement and each row costs one hash lookup. ``IS TRUE`` keeps
        PostgreSQL from turning the test into a semi-join, whose plan follows
        the outer row estimate: a misestimated filter (``upper(...)``, JSON
        paths) made it a nested loop rescanning the set for every row.
        """
        if not self.readable and not self.restorable:
            return false()
        if self._visible is None:
            object.__setattr__(self, "_visible", self._visible_items())
        assert self._visible is not None
        return item.id.in_(select(self._visible.c.id)).is_(true())

    def _visible_items(self) -> CTE:
        """``visible_items``: the ids of every visible item of the workspace.

        ``DISTINCT`` caps the planner's estimate of the set at its default
        group count, so a membership test outside a join is always a hashed
        SubPlan, whatever the workspace size.
        """
        branches = self._branches(
            self.readable, self.editable, include_deleted=False
        ) + self._branches(self.restorable, self.restorable_editable, include_deleted=True)
        ids = union_all(*branches).subquery("visible_branches")
        return (
            select(ids.c.id).distinct().cte("visible_items").prefix_with("MATERIALIZED")
        )

    def _branches(
        self,
        readable: frozenset[UUID],
        editable: frozenset[UUID],
        *,
        include_deleted: bool,
    ) -> list[Select[Any]]:
        """The visible collections and documents of the live (or the DELETED) items.

        Documents directly in a collection read ``items`` itself, so their row
        estimate comes from table statistics; only CHILD/ATTACHMENT documents
        need the recursive walk to their governing collection.
        """
        if not readable:
            return []
        nested = _nested_documents(self.workspace_id, readable, include_deleted=include_deleted)

        def state(column: Any) -> ColumnElement[bool]:
            return column.is_not(None) if include_deleted else column.is_(None)

        return [
            select(Item.id).where(
                Item.tenant_id == self.workspace_id,
                Item.item_type == "collection",
                Item.id.in_(readable),
                state(Item.deleted_at),
            ),
            select(Item.id).where(
                Item.tenant_id == self.workspace_id,
                Item.item_type == "document",
                Item.parent_item_id.in_(readable),
                state(Item.deleted_at),
                or_(Item.publication_state == "published", Item.parent_item_id.in_(editable)),
            ),
            select(nested.c.item_id.label("id")).where(
                state(nested.c.deleted_at),
                or_(
                    nested.c.publication_state == "published",
                    nested.c.collection_id.in_(editable),
                ),
            ),
        ]


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


async def visible_to(
    authorizer: Authorizer, user_ids: Iterable[UUID], refs: Iterable[ItemRef]
) -> dict[ItemRef, frozenset[UUID]]:
    """The users of ``user_ids`` to whom each item is visible: :func:`is_visible`
    of every (user, item) pair, in a number of queries constant in both (audiences)."""
    wanted = list(dict.fromkeys(refs))
    held = await authorizer.holders_permissions(user_ids, wanted)
    paths = await authorizer.ancestries(ref.item_id for ref in wanted)
    result: dict[ItemRef, frozenset[UUID]] = {}
    for ref in wanted:
        path = paths[ref.item_id]
        result[ref] = frozenset(
            user_id
            for user_id, permissions in held[ref].items()
            if path
            and _readable(path[0].item_type, path[0].publication_state == "published", permissions)
        )
    return result


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


def _nested_documents(
    workspace_id: UUID, collections: frozenset[UUID], *, include_deleted: bool
) -> CTE:
    """CHILD/ATTACHMENT documents below the documents of ``collections``, each with
    the collection that governs it (the one holding its top document).

    Both steps name that relation (the tree trigger reserves it for items under
    a Document), so PostgreSQL estimates the walk from its statistics.
    """
    prefix = "deleted_" if include_deleted else ""

    def alive(document: Any) -> ColumnElement[bool]:
        return true() if include_deleted else document.c.deleted_at.is_(None)

    def below(document: Any) -> ColumnElement[bool]:
        return and_(
            document.c.tenant_id == workspace_id,
            document.c.item_type == "document",
            document.c.parent_relation.in_(DOCUMENT_CHILD_RELATIONS),
            alive(document),
        )

    top = Item.__table__.alias(f"{prefix}top_document")
    child = Item.__table__.alias(f"{prefix}child_document")
    nested = (
        select(
            child.c.id.label("item_id"),
            top.c.parent_item_id.label("collection_id"),
            child.c.publication_state.label("publication_state"),
            child.c.deleted_at.label("deleted_at"),
        )
        .join_from(child, top, child.c.parent_item_id == top.c.id)
        .where(
            top.c.tenant_id == workspace_id,
            top.c.item_type == "document",
            top.c.parent_item_id.in_(collections),
            alive(top),
            below(child),
        )
        .cte(f"{prefix}nested_documents", recursive=True)
    )
    deeper = Item.__table__.alias(f"{prefix}deeper_document")
    return nested.union_all(
        select(
            deeper.c.id,
            nested.c.collection_id,
            deeper.c.publication_state,
            deeper.c.deleted_at,
        ).where(deeper.c.parent_item_id == nested.c.item_id, below(deeper))
    )


__all__ = [
    "ItemVisibility",
    "is_contribution_reviewer",
    "is_visible",
    "item_visibility",
    "require_visible_item",
    "visible_to",
]
