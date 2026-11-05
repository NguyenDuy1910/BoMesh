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
    select,
)

from bomesh.db.models import Contribution, ReadingList, Topic

# -- Contributions -------------------------------------------------------------------

CONTRIBUTION_STATE = func.upper(Contribution.state)
CONTRIBUTION_KIND = func.upper(Contribution.kind)
CONTRIBUTION_ORIGIN = func.upper(Contribution.origin)


def contribution_has_flag(kind: str) -> ColumnElement[bool]:
    """``flags:KIND`` — the contribution carries a flag of ``kind`` (UPPER_SNAKE)."""
    return Contribution.flags.contains([{"flag": kind.lower()}])


def in_review_contribution_ids(workspace_id: UUID) -> Select[tuple[UUID]]:
    """``SELECT id`` of the workspace's live IN_REVIEW contributions (no permission check)."""
    return select(Contribution.id).where(
        Contribution.tenant_id == workspace_id,
        Contribution.state == "in_review",
        Contribution.deleted_at.is_(None),
    )


# -- Reading lists -------------------------------------------------------------------

READING_LIST_AUDIENCE = func.upper(ReadingList.audience)
READING_LIST_TYPE = func.upper(ReadingList.kind)

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


__all__ = [
    "CONTRIBUTION_KIND",
    "CONTRIBUTION_ORIGIN",
    "CONTRIBUTION_STATE",
    "DOCUMENT_COUNT",
    "READING_LIST_AUDIENCE",
    "READING_LIST_TYPE",
    "TOPIC_KIND",
    "TOPIC_STATE",
    "contribution_has_flag",
    "in_review_contribution_ids",
    "topic_id_by_code",
]
