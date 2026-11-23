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


def topic_correction_name(workspace_id: UUID, correction_id: UUID) -> str:
    return f"workspaces/{workspace_id}/topicCorrections/{correction_id}"


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
    topic_codes: tuple[str, ...] | None = None
    summary: str | None = None
    #: The published document's new ``displayName``; ``None`` keeps it.
    title: str | None = None
    #: Record a TopicCorrection when ``topic_codes`` differ from the suggested topics.
    record_correction: bool = False


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
    topic_codes: tuple[str, ...]
    topics_confidence: float | None
    proposed_topic_codes: tuple[str, ...]
    proposed_topics_confidence: float | None
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
class TopicRule:
    """``Topic.rules[]``: exactly one of a Collection subtree or a source."""

    collection_id: UUID | None = None
    source_code: str | None = None


@dataclass(frozen=True, slots=True)
class TopicSignals:
    """A TOPIC's classification signals (``Topic.keywords`` … ``rules``)."""

    keywords: tuple[str, ...] = ()
    synonyms: tuple[str, ...] = ()
    guidance: str | None = None
    example_ids: tuple[UUID, ...] = ()
    rules: tuple[TopicRule, ...] = ()


#: UpdateTopic mask paths of the signals; TestTopicClassification overrides use them too.
SIGNAL_PATHS = ("keywords", "synonyms", "guidance", "examples", "rules")


@dataclass(frozen=True, slots=True)
class TopicDraft:
    display_name: str
    kind: str
    description: str | None = None
    parent_code: str | None = None
    icon: str | None = None
    color: str | None = None
    signals: TopicSignals = TopicSignals()


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
    #: Examples filtered to the documents the caller can see.
    signals: TopicSignals
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
class TopicImportRow:
    """One ImportTopics row, by display name: ``topic`` ``None`` = the row is its
    ``domain``; ``name`` is the topic resource name from an export (unparsed: an
    unknown one skips the row). Other ``None`` = the column is absent (left unchanged)."""

    domain: str
    topic: str | None = None
    name: str | None = None
    description: str | None = None
    keywords: tuple[str, ...] | None = None
    synonyms: tuple[str, ...] | None = None
    guidance: str | None = None


@dataclass(frozen=True, slots=True)
class TopicImportChange:
    """A topic or domain an import creates, updates or archives, by code; ``domain`` is
    its domain's display name after the import (topics only), ``row`` the 1-based row
    that caused it, ``changes`` what an update changes (``RENAMED``, ``MOVED``, …)."""

    code: str
    kind: str
    display_name: str
    domain: str | None = None
    row: int | None = None
    changes: tuple[str, ...] = ()
    previous_display_name: str | None = None


@dataclass(frozen=True, slots=True)
class TopicImportResult:
    created: tuple[TopicImportChange, ...]
    updated: tuple[TopicImportChange, ...]
    archived: tuple[TopicImportChange, ...]
    unchanged_count: int
    #: ``(1-based row, reason)``.
    skipped: tuple[tuple[int, str], ...]


@dataclass(frozen=True, slots=True)
class TopicClassificationTest:
    """TestTopicClassification: ``(code, "rule" | "assistant")`` ranked, and the summary."""

    results: tuple[tuple[str, str], ...]
    summary: str | None


@dataclass(frozen=True, slots=True)
class TopicClassificationPrompt:
    prompt: str
    #: ``(topic code, rule)`` of every candidate rule, checked before the model.
    rules: tuple[tuple[str, TopicRule], ...]
    estimated_tokens: int


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
    description: str | None
    icon: str | None
    color: str | None
    document_count: int
    new_document_count: int
    top_topics: list[TopicSummary]


# -- Topic corrections ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TopicCorrectionRecord:
    workspace_id: UUID
    id: UUID
    #: The document and its title, only when the caller can see it.
    item_id: UUID | None
    item_display_name: str | None
    from_topic_codes: tuple[str, ...]
    to_topic_codes: tuple[str, ...]
    actor_id: UUID
    state: str
    create_time: datetime


JsonObject = dict[str, Any]
