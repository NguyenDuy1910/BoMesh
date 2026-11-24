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
    ScalarSelect,
    Select,
    case,
    func,
    literal_column,
    or_,
    select,
)

from bomesh.db.models import (
    Contribution,
    Item,
    ItemIndexState,
    Topic,
    TopicCorrection,
    TopicCorrectionChange,
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


# -- Topics --------------------------------------------------------------------------

TOPIC_STATE = case((Topic.deleted_at.is_not(None), "DELETED"), else_=func.upper(Topic.state))
TOPIC_KIND = func.upper(Topic.kind)

#: ``orderBy=documentCount``: the per-caller count column ListTopics selects
#: (documents tagged with the topic that the caller can see).
DOCUMENT_COUNT = literal_column("document_count")


def topic_id_by_code(workspace_id: UUID, code: str) -> ScalarSelect[Any]:
    """The id of ``workspaces/{workspace}/topics/{code}`` as a scalar subquery."""
    return (
        select(Topic.id)
        .where(Topic.tenant_id == workspace_id, Topic.code == code)
        .scalar_subquery()
    )


# -- Topic corrections ---------------------------------------------------------------

TOPIC_CORRECTION_STATE = case(
    (TopicCorrection.dismissed_at.is_(None), "OPEN"), else_="DISMISSED"
)
#: ``state = OPEN|DISMISSED`` as ``dismissed_at`` tests, so the open-corrections
#: partial index applies.
TOPIC_CORRECTION_STATE_CONDITIONS: dict[str, ColumnElement[bool]] = {
    "OPEN": TopicCorrection.dismissed_at.is_(None),
    "DISMISSED": TopicCorrection.dismissed_at.is_not(None),
}


def correction_to_topic(workspace_id: UUID, code: str) -> ColumnElement[bool]:
    """``toTopics:"workspaces/w/topics/{code}"`` — the person added that topic."""
    return (
        select(TopicCorrectionChange.topic_correction_id)
        .where(
            TopicCorrectionChange.topic_id == topic_id_by_code(workspace_id, code),
            TopicCorrectionChange.change_type == "added",
            TopicCorrectionChange.topic_correction_id == TopicCorrection.id,
        )
        .exists()
    )


__all__ = [
    "CONTRIBUTION_ITEM_DISPLAY_NAME",
    "DOCUMENT_COUNT",
    "TOPIC_CORRECTION_STATE",
    "TOPIC_CORRECTION_STATE_CONDITIONS",
    "TOPIC_KIND",
    "TOPIC_STATE",
    "candidate_shown",
    "contribution_has_flag",
    "contribution_item_indexing_state",
    "correction_to_topic",
    "in_review_contribution_ids",
    "topic_id_by_code",
]
