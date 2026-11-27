"""SQL expressions the curation list methods filter and sort on.

The API layer maps contract filter/orderBy fields onto these; it never builds
SQL itself. Expressions over other slices' resources (sources, spaces) come
from their owners.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Select,
    func,
    or_,
    select,
)

from bomesh.db.models import (
    Contribution,
    Item,
    ItemIndexState,
)
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.services.knowledge_items.queries import indexing_state

# -- Contributions -------------------------------------------------------------------

def contribution_has_flag(kind: str) -> ColumnElement[bool]:
    """``flags:KIND`` — the contribution carries a flag of ``kind`` (UPPER_SNAKE)."""
    return Contribution.flags.contains([{"flag": kind.lower()}])


def candidate_shown(me: UUID) -> ColumnElement[bool]:
    """Where the contribution's candidate may be read as a party to it: the caller's own
    contribution, or an open one (the reviewer exception, item_model.md §6.4)."""
    return or_(
        Contribution.contributor_user_id == me, Contribution.state.in_(OPEN_CONTRIBUTION_STATES)
    )


#: ``itemDisplayName`` — the candidate's title.
CONTRIBUTION_ITEM_DISPLAY_NAME: ColumnElement[Any] = (
    select(Item.item_name)
    .where(Item.id == Contribution.item_id)
    .correlate(Contribution)
    .scalar_subquery()
)


def contribution_item_indexing_state(processing_version: str) -> ColumnElement[Any]:
    """``itemIndexingState`` — the candidate's ``document.indexingState``, read from its
    ``item_index_states`` row (a candidate without one has not been processed: PENDING)."""
    state = indexing_state(
        processing_version, ItemIndexState.index_status, ItemIndexState.processed_version
    )
    return func.coalesce(
        select(state)
        .where(ItemIndexState.item_id == Contribution.item_id)
        .correlate(Contribution)
        .scalar_subquery(),
        "PENDING",
    )


def in_review_contribution_ids(workspace_id: UUID) -> Select[tuple[UUID]]:
    """``SELECT id`` of the workspace's live IN_REVIEW contributions (no permission check)."""
    return select(Contribution.id).where(
        Contribution.tenant_id == workspace_id,
        Contribution.state == "in_review",
        Contribution.deleted_at.is_(None),
    )


__all__ = [
    "CONTRIBUTION_ITEM_DISPLAY_NAME",
    "candidate_shown",
    "contribution_has_flag",
    "contribution_item_indexing_state",
    "in_review_contribution_ids",
]
