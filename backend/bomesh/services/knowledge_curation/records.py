"""Typed records the KnowledgeCuration services return (never HTTP messages)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from bomesh.errors import InvalidArgument

# -- Names -------------------------------------------------------------------------


def contribution_name(workspace_id: UUID, contribution_id: UUID) -> str:
    return f"workspaces/{workspace_id}/contributions/{contribution_id}"


def parse_contribution(name: str, workspace_id: UUID, *, field: str) -> UUID:
    """The ID of ``workspaces/{workspace_id}/contributions/{id}``; INVALID_ARGUMENT otherwise."""
    parts = name.split("/")
    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "contributions":
        try:
            parent, child = UUID(parts[1]), UUID(parts[3])
        except ValueError:
            pass
        else:
            if parent == workspace_id:
                return child
    raise InvalidArgument.for_field(
        field, f"'{name}' is not a contribution name of this workspace."
    )


# -- Contributions -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ContributionDraft:
    """CreateContribution input: IDs already parsed from resource names."""

    kind: str
    item_id: UUID
    target_id: UUID | None = None
    replaces_id: UUID | None = None
    note: str | None = None
    change_summary: str | None = None


@dataclass(frozen=True, slots=True)
class Approval:
    """ApproveContribution input."""

    etag: str
    target_id: UUID | None = None
    #: Concept resource names; the first of each scheme is its primary. ``None`` keeps
    #: the published document's concepts (a candidate's suggestions stay suggested).
    concepts: tuple[str, ...] | None = None
    summary: str | None = None
    #: The published document's new ``displayName``; ``None`` keeps it.
    title: str | None = None


@dataclass(frozen=True, slots=True)
class FlagRecord:
    kind: str
    #: Only set when the caller can see the related item.
    related_item_id: UUID | None


@dataclass(frozen=True, slots=True)
class EventRecord:
    kind: str
    actor_id: UUID | None
    message: str | None
    create_time: datetime


@dataclass(frozen=True, slots=True)
class DecisionRecord:
    reviewer_id: UUID | None
    message: str | None
    decide_time: datetime | None


@dataclass(frozen=True, slots=True)
class SuggestionsRecord:
    collection_id: UUID | None
    collection_confidence: float | None
    summary: str | None
    summary_confidence: float | None
    title: str | None


@dataclass(frozen=True, slots=True)
class ContributionRecord:
    workspace_id: UUID
    id: UUID
    kind: str
    origin: str
    item_id: UUID
    #: The candidate's title and ``document.indexingState`` (``itemDisplayName``,
    #: ``itemIndexingState``).
    item_display_name: str | None
    item_indexing_state: str | None
    target_id: UUID | None
    replaces_id: UUID | None
    contributor_id: UUID | None
    source_code: str | None
    external_version: str | None
    note: str | None
    change_summary: str | None
    suggestions: SuggestionsRecord
    flags: tuple[FlagRecord, ...]
    audience_summary: str | None
    state: str
    decision: DecisionRecord | None
    events: tuple[EventRecord, ...] | None
    create_time: datetime
    update_time: datetime
    etag: str


@dataclass(frozen=True, slots=True)
class ContributionSummary:
    """One of a member's open contributions (Library Home)."""

    contribution_id: UUID
    display_name: str
    state: str


JsonObject = dict[str, Any]
