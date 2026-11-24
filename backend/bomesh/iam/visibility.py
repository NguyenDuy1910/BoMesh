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
applies only to GetItem, GetItemPreview and ``alt=media``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, any_, exists, false, literal, or_, select, true
from sqlalchemy.dialects.postgresql import ARRAY
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
        It is decided on the row itself: a COLLECTION by its id, a DOCUMENT by
        its parent collection (one array probe each, so the planner keeps the
        query's own index and stops at its ``LIMIT``). Only a document whose
        parent is not a collection of the workspace (a CHILD/ATTACHMENT
        document, rare) walks up to its governing collection.
        """
        if not self.readable and not self.restorable:
            return false()
        return or_(
            *self._branches(item, self.readable, self.editable, include_deleted=False),
            *self._branches(
                item, self.restorable, self.restorable_editable, include_deleted=True
            ),
        )

    def _branches(
        self,
        item: Any,
        readable: frozenset[UUID],
        editable: frozenset[UUID],
        *,
        include_deleted: bool,
    ) -> list[ColumnElement[bool]]:
        """The visible collections and documents of the live (or the DELETED) items."""
        if not readable:
            return []
        readable_ids = _ids(readable)
        editable_ids = _ids(editable)
        state = item.deleted_at.is_not(None) if include_deleted else item.deleted_at.is_(None)

        def governs(node: Any) -> ColumnElement[bool]:
            return and_(
                node.c.item_kind == "collection",
                node.c.id == any_(readable_ids),
                or_(item.is_published, node.c.id == any_(editable_ids)),
            )

        return [
            and_(
                item.tenant_id == self.workspace_id,
                item.item_kind == "collection",
                item.id == any_(readable_ids),
                state,
            ),
            and_(
                item.tenant_id == self.workspace_id,
                item.item_kind == "document",
                item.parent_item_id == any_(readable_ids),
                state,
                or_(item.is_published, item.parent_item_id == any_(editable_ids)),
            ),
            and_(
                item.tenant_id == self.workspace_id,
                item.item_kind == "document",
                state,
                below_document_reaching(
                    item, self.workspace_id, governs, live=not include_deleted
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
    # Listing a deleted item needs what GetItem needs for it: `items.undelete` and `items.get`.
    restorable = await authorizer.allowed_collections(
        principal, workspace_id, RESTORE, include_deleted=True
    ) & await authorizer.allowed_collections(principal, workspace_id, READ, include_deleted=True)
    return ItemVisibility(
        workspace_id,
        readable,
        editable,
        restorable=restorable,
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
    return _readable(node.item_kind, bool(node.is_published), held)


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
            and _readable(path[0].item_kind, bool(path[0].is_published), permissions)
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
    - ``reviewer_exception`` (GetItem, GetItemPreview, ``alt=media`` only):
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
            published = bool(item.is_published)
            visible = _readable(item.item_kind, published, held) and (
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


def _readable(item_kind: str, published: bool, held: frozenset[str]) -> bool:
    if READ not in held:
        return False
    return item_kind == "collection" or published or EDIT in held


def _ids(ids: frozenset[UUID]) -> ColumnElement[Any]:
    """One ``uuid[]`` parameter (``= ANY(...)`` probes it as a hashed array)."""
    return literal(sorted(ids), ARRAY(Item.__table__.c.id.type))


def _ancestry(item: Any, stops: Callable[[Any], ColumnElement[bool]] | None = None) -> Any:
    """CTE of ``item``'s ancestors from its parent up, climbing through documents
    only (the first COLLECTION, or a node ``stops`` admits, ends the walk). It is
    correlated to the row, one primary-key lookup per level."""
    step = Item.__table__.alias("ancestor")
    ancestry = (
        select(step.c.id, step.c.parent_item_id, step.c.item_kind, step.c.deleted_at)
        .where(step.c.id == item.parent_item_id)
        .correlate(item)
        .cte("ancestry", recursive=True, nesting=True)
    )
    above = Item.__table__.alias("ancestor_above")
    climbs = [above.c.id == ancestry.c.parent_item_id, ancestry.c.item_kind == "document"]
    if stops is not None:
        climbs.append(~stops(ancestry))
    return ancestry.union_all(
        select(above.c.id, above.c.parent_item_id, above.c.item_kind, above.c.deleted_at)
        .where(*climbs)
        .correlate(item)
    )


def below_document(item: Any, workspace_id: Any) -> ColumnElement[bool]:
    """``item``'s parent is not a collection of ``workspace_id`` (a hashed probe of
    a small set): only then can it sit below another document (the guard of
    :func:`below_document_reaching` and :func:`governing_collection_id`)."""
    collection = Item.__table__.alias("workspace_collection")
    collections = select(collection.c.id).where(
        collection.c.tenant_id == workspace_id, collection.c.item_kind == "collection"
    )
    return item.parent_item_id.in_(collections).is_not(true())


def _live_between(ancestry: Any) -> ColumnElement[bool]:
    return ~exists().where(
        ancestry.c.item_kind == "document", ancestry.c.deleted_at.is_not(None)
    )


def below_document_reaching(
    item: Any,
    workspace_id: Any,
    accepts: Callable[[Any], ColumnElement[bool]],
    *,
    live: bool,
) -> ColumnElement[bool]:
    """``item`` sits below another document, and climbing its documents reaches a
    node ``accepts`` admits (``accepts(node)`` over the walk's ``id``/``item_kind``
    columns); with ``live``, every document climbed through is live.

    The walk (:func:`_ancestry`) only runs for rows whose parent is not a
    collection, so CHILD/ATTACHMENT documents alone pay for it.
    """
    ancestry = _ancestry(item, accepts)
    reached = exists().where(accepts(ancestry))
    if live:
        reached = and_(reached, _live_between(ancestry))
    return and_(below_document(item, workspace_id), reached)


def governing_collection_id(item: Any, *, live: bool) -> ColumnElement[Any]:
    """Scalar: the collection governing a document below another document (the
    first COLLECTION up its tree); with ``live``, NULL when a document climbed
    through is DELETED. Callers guard it with the parent not being a collection."""
    ancestry = _ancestry(item)
    governing = select(ancestry.c.id).where(ancestry.c.item_kind == "collection")
    if live:
        governing = governing.where(_live_between(ancestry))
    return governing.scalar_subquery()


__all__ = [
    "ItemVisibility",
    "below_document",
    "below_document_reaching",
    "governing_collection_id",
    "is_contribution_reviewer",
    "is_visible",
    "item_visibility",
    "require_visible_item",
    "visible_to",
]
