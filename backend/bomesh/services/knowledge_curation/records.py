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


def topic_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/topics/{code}"


def reading_list_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/readingLists/{code}"


def entry_name(workspace_id: UUID, code: str, item_id: UUID) -> str:
    return f"{reading_list_name(workspace_id, code)}/entries/{item_id}"


def parse_topic(name: str, workspace_id: UUID, *, field: str) -> str:
    """The code of ``workspaces/{workspace_id}/topics/{topic}``; INVALID_ARGUMENT otherwise."""
    parts = name.split("/")
    if (
        len(parts) == 4
        and parts[0] == "workspaces"
        and parts[1] == str(workspace_id)
        and parts[2] == "topics"
        and parts[3]
    ):
        return parts[3]
    raise InvalidArgument.for_field(field, f"'{name}' is not a topic name of this workspace.")


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
    document_type: str | None = None
    topic_codes: tuple[str, ...] | None = None
    summary: str | None = None


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
    document_type: str | None
    document_type_confidence: float | None
    topic_codes: tuple[str, ...]
    topics_confidence: float | None
    proposed_topic_codes: tuple[str, ...]
    proposed_topics_confidence: float | None
    collection_id: UUID | None
    collection_confidence: float | None
    summary: str | None
    summary_confidence: float | None


@dataclass(frozen=True, slots=True)
class ContributionRecord:
    workspace_id: UUID
    id: UUID
    kind: str
    origin: str
    item_id: UUID
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


# -- Topics ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TopicDraft:
    display_name: str
    kind: str
    description: str | None = None
    parent_code: str | None = None
    icon: str | None = None
    color: str | None = None


@dataclass(frozen=True, slots=True)
class TopicRecord:
    workspace_id: UUID
    id: UUID
    code: str
    display_name: str
    description: str | None
    kind: str
    parent_code: str | None
    icon: str | None
    color: str | None
    state: str
    evidence: tuple[UUID, ...]
    document_count: int
    in_review_count: int | None
    create_time: datetime
    update_time: datetime
    delete_time: datetime | None
    purge_time: datetime | None
    etag: str


@dataclass(frozen=True, slots=True)
class TopicSummary:
    topic_id: UUID
    code: str
    display_name: str
    document_count: int


@dataclass(frozen=True, slots=True)
class TopicDomainSummary:
    topic_id: UUID
    code: str
    display_name: str
    document_count: int
    top_topics: list[TopicSummary]


# -- Reading lists -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReadingListDraft:
    display_name: str
    audience: str = "private"
    description: str | None = None
    space_code: str | None = None


@dataclass(frozen=True, slots=True)
class ReadingListRecord:
    workspace_id: UUID
    id: UUID
    code: str
    display_name: str
    description: str | None
    owner_id: UUID
    audience: str
    space_code: str | None
    kind: str
    item_count: int
    hidden_item_count: int
    create_time: datetime
    update_time: datetime
    delete_time: datetime | None
    purge_time: datetime | None
    etag: str


@dataclass(frozen=True, slots=True)
class EntryRecord:
    workspace_id: UUID
    list_code: str
    entry_id: UUID
    item_id: UUID
    note: str | None
    position: int
    added_by: UUID
    create_time: datetime


@dataclass(frozen=True, slots=True)
class EntryPage:
    entries: list[EntryRecord]
    hidden_item_count: int


@dataclass(frozen=True, slots=True)
class ReadingListSummary:
    reading_list_id: UUID
    code: str
    display_name: str
    item_count: int


JsonObject = dict[str, Any]
