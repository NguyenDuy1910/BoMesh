"""Knowledge curation messages (``openapi.yaml`` tag Knowledge: contributions,
reading lists, topics) and their filter/order maps."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from api.aip.filtering import (
    FilterSchema,
    enum,
    parse,
    repeated,
    resource_name,
    restrictions,
)
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import Contribution, ReadingList, Topic
from bomesh.services.collaboration.membership import space_id_by_code
from bomesh.services.collaboration.records import space_name
from bomesh.services.collaboration.support import parse_space_name
from bomesh.services.ingestion.names import (
    parse_source,
    source_id_by_code,
    source_name,
)
from bomesh.services.knowledge_curation import queries
from bomesh.services.knowledge_curation.records import (
    ContributionRecord,
    EntryRecord,
    ReadingListRecord,
    TopicRecord,
    contribution_name,
    entry_name,
    parse_topic,
    reading_list_name,
    topic_name,
)
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.workspaces.records import member_name, parse_member_name

View = Literal["VIEW_UNSPECIFIED", "BASIC", "FULL"]

# -- Contributions -------------------------------------------------------------------


class ContributionSuggestionsMessage(ProtoMessage):
    document_type: str | None = None
    document_type_confidence: float | None = None
    topics: list[str] | None = None
    topics_confidence: float | None = None
    proposed_topics: list[str] | None = None
    proposed_topics_confidence: float | None = None
    collection: str | None = None
    collection_confidence: float | None = None
    summary: str | None = None
    summary_confidence: float | None = None


class ContributionFlagMessage(ProtoMessage):
    kind: Literal["DUPLICATE", "NEW_REVISION", "PERSONAL_DATA", "UNSEARCHABLE_FORMAT"]
    related_item: str | None = None


class ContributionDecisionMessage(ProtoMessage):
    reviewer: str | None = None
    message: str | None = None
    decide_time: Timestamp | None = None


class ContributionEventMessage(ProtoMessage):
    kind: str
    actor: str | None = None
    message: str | None = None
    create_time: Timestamp | None = None


ContributionState = Literal[
    "ANALYZING", "IN_REVIEW", "CHANGES_REQUESTED", "APPROVED", "REJECTED", "WITHDRAWN"
]


class ContributionMessage(ProtoMessage):
    name: str | None = None
    kind: Literal["NEW_DOCUMENT", "NEW_REVISION"] | None = None
    origin: Literal["MEMBER", "SOURCE"] | None = None
    item: str | None = None
    target_collection: str | None = None
    replaces_item: str | None = None
    contributor: str | None = None
    source: str | None = None
    external_version: str | None = None
    note: str | None = None
    change_summary: str | None = None
    suggestions: ContributionSuggestionsMessage | None = None
    flags: list[ContributionFlagMessage] | None = None
    audience_summary: str | None = None
    state: ContributionState | None = None
    decision: ContributionDecisionMessage | None = None
    events: list[ContributionEventMessage] | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None


class ListContributionsResponse(ProtoMessage):
    contributions: list[ContributionMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class ApproveContributionRequest(ProtoMessage):
    etag: str
    target_collection: str | None = None
    document_type: str | None = None
    topics: list[str] | None = None
    summary: str | None = None


class DecisionRequest(ProtoMessage):
    """Body of RejectContribution and RequestContributionChanges."""

    message: str
    etag: str | None = None


class ResubmitContributionRequest(ProtoMessage):
    change_summary: str
    item: str | None = None
    note: str | None = None
    etag: str | None = None


class EtagRequest(ProtoMessage):
    """Body of the custom methods that take only an optional etag."""

    etag: str | None = None


def contribution_message(record: ContributionRecord) -> ContributionMessage:
    ws = record.workspace_id
    s = record.suggestions
    return ContributionMessage(
        name=contribution_name(ws, record.id),
        kind=record.kind.upper(),  # type: ignore[arg-type]
        origin=record.origin.upper(),  # type: ignore[arg-type]
        item=item_name(ws, record.item_id),
        target_collection=item_name(ws, record.target_id) if record.target_id else None,
        replaces_item=item_name(ws, record.replaces_id) if record.replaces_id else None,
        contributor=member_name(ws, record.contributor_id) if record.contributor_id else None,
        source=source_name(ws, record.source_code) if record.source_code else None,
        external_version=record.external_version,
        note=record.note,
        change_summary=record.change_summary,
        suggestions=ContributionSuggestionsMessage(
            document_type=s.document_type,
            document_type_confidence=s.document_type_confidence,
            topics=[topic_name(ws, code) for code in s.topic_codes] or None,
            topics_confidence=s.topics_confidence,
            proposed_topics=[topic_name(ws, code) for code in s.proposed_topic_codes] or None,
            proposed_topics_confidence=s.proposed_topics_confidence,
            collection=item_name(ws, s.collection_id) if s.collection_id else None,
            collection_confidence=s.collection_confidence,
            summary=s.summary,
            summary_confidence=s.summary_confidence,
        ),
        flags=[
            ContributionFlagMessage(
                kind=flag.kind.upper(),  # type: ignore[arg-type]
                related_item=item_name(ws, flag.related_item_id) if flag.related_item_id else None,
            )
            for flag in record.flags
        ],
        audience_summary=record.audience_summary,
        state=record.state.upper(),  # type: ignore[arg-type]
        decision=ContributionDecisionMessage(
            reviewer=member_name(ws, record.decision.reviewer_id)
            if record.decision.reviewer_id
            else None,
            message=record.decision.message,
            decide_time=record.decision.decide_time,
        )
        if record.decision
        else None,
        events=[
            ContributionEventMessage(
                kind=event.kind,
                actor=member_name(ws, event.actor_id) if event.actor_id else None,
                message=event.message,
                create_time=event.create_time,
            )
            for event in record.events
        ]
        if record.events is not None
        else None,
        create_time=record.create_time,
        update_time=record.update_time,
        etag=record.etag,
    )


def contribution_filters(workspace_id: UUID, me: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "state": enum(queries.CONTRIBUTION_STATE, ContributionState.__args__),
            "kind": enum(queries.CONTRIBUTION_KIND, ("NEW_DOCUMENT", "NEW_REVISION")),
            "origin": enum(queries.CONTRIBUTION_ORIGIN, ("MEMBER", "SOURCE")),
            "targetCollection": resource_name(
                Contribution.target_item_id,
                lambda name: parse_item(name, workspace_id, field="filter") if name else None,
            ),
            "contributor": resource_name(
                Contribution.contributor_user_id,
                lambda name: parse_member_name(name, workspace_id, field="filter", me=me),
            ),
            "flags": repeated(
                enum(
                    Contribution.flags,
                    ("DUPLICATE", "NEW_REVISION", "PERSONAL_DATA", "UNSEARCHABLE_FORMAT"),
                ),
                has=queries.contribution_has_flag,
            ),
            "source": resource_name(
                Contribution.ingestion_source_id,
                lambda name: source_id_by_code(
                    workspace_id, parse_source(name, workspace_id, field="filter")
                ),
            ),
        }
    )


def referenced_collections(filter: str | None, workspace_id: UUID) -> tuple[UUID, ...]:
    """The ``targetCollection`` items a filter names (they must be readable)."""
    return tuple(
        parse_item(r.value.text, workspace_id, field="filter")
        for r in restrictions(parse(filter))
        if r.field == "targetCollection" and r.value.text
    )


CONTRIBUTION_ORDER = OrderSchema(
    {"createTime": Contribution.created_at, "updateTime": Contribution.updated_at},
    tie_breaker=[Contribution.id],
    default="createTime desc",
)

# -- Reading lists -------------------------------------------------------------------

Audience = Literal["PRIVATE", "SPACE", "WORKSPACE"]


class ReadingListMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    owner: str | None = None
    audience: Audience | None = None
    space: str | None = None
    type: Literal["STANDARD", "FEATURED"] | None = None
    item_count: int | None = None
    hidden_item_count: int | None = None
    state: Literal["ACTIVE", "DELETED"] | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None
    etag: str | None = None


class ListReadingListsResponse(ProtoMessage):
    reading_lists: list[ReadingListMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class ReadingListEntryMessage(ProtoMessage):
    name: str | None = None
    item: str | None = None
    note: str | None = None
    position: int | None = None
    added_by: str | None = None
    create_time: Timestamp | None = None


class ListReadingListEntriesResponse(ProtoMessage):
    entries: list[ReadingListEntryMessage]
    next_page_token: str | None = None
    hidden_item_count: int | None = None


class CopyReadingListRequest(ProtoMessage):
    display_name: str | None = None
    reading_list_id: str | None = None


def reading_list_message(record: ReadingListRecord) -> ReadingListMessage:
    ws = record.workspace_id
    return ReadingListMessage(
        name=reading_list_name(ws, record.code),
        display_name=record.display_name,
        description=record.description,
        owner=member_name(ws, record.owner_id),
        audience=record.audience.upper(),  # type: ignore[arg-type]
        space=space_name(ws, record.space_code) if record.space_code else None,
        type=record.kind.upper(),  # type: ignore[arg-type]
        item_count=record.item_count,
        hidden_item_count=record.hidden_item_count,
        state="DELETED" if record.delete_time else "ACTIVE",
        create_time=record.create_time,
        update_time=record.update_time,
        delete_time=record.delete_time,
        purge_time=record.purge_time,
        etag=record.etag,
    )


def entry_message(record: EntryRecord) -> ReadingListEntryMessage:
    ws = record.workspace_id
    return ReadingListEntryMessage(
        name=entry_name(ws, record.list_code, record.entry_id),
        item=item_name(ws, record.item_id),
        note=record.note,
        position=record.position,
        added_by=member_name(ws, record.added_by),
        create_time=record.create_time,
    )


def reading_list_filters(workspace_id: UUID, me: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "audience": enum(queries.READING_LIST_AUDIENCE, Audience.__args__),
            "type": enum(queries.READING_LIST_TYPE, ("STANDARD", "FEATURED")),
            "space": resource_name(
                ReadingList.space_id,
                lambda name: space_id_by_code(
                    workspace_id, parse_space_name(name, workspace_id, field="filter")
                )
                if name
                else None,
            ),
            "owner": resource_name(
                ReadingList.owner_user_id,
                lambda name: parse_member_name(name, workspace_id, field="filter", me=me),
            ),
        }
    )


READING_LIST_ORDER = OrderSchema(
    {"displayName": ReadingList.title, "updateTime": ReadingList.updated_at},
    tie_breaker=[ReadingList.id],
    default="displayName",
)

# -- Topics --------------------------------------------------------------------------

TopicKind = Literal["DOMAIN", "TOPIC"]
TopicState = Literal["PROPOSED", "ACTIVE", "REJECTED", "DELETED"]


class TopicMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    kind: TopicKind | None = None
    parent_topic: str | None = None
    icon: str | None = None
    color: str | None = None
    state: TopicState | None = None
    evidence: list[str] | None = None
    document_count: int | None = None
    in_review_count: int | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None
    etag: str | None = None


class ListTopicsResponse(ProtoMessage):
    topics: list[TopicMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class AcceptTopicRequest(ProtoMessage):
    parent_topic: str | None = None
    display_name: str | None = None
    etag: str | None = None


class MergeTopicRequest(ProtoMessage):
    target_topic: str
    etag: str | None = None


def topic_message(record: TopicRecord) -> TopicMessage:
    ws = record.workspace_id
    return TopicMessage(
        name=topic_name(ws, record.code),
        display_name=record.display_name,
        description=record.description,
        kind=record.kind.upper(),  # type: ignore[arg-type]
        parent_topic=topic_name(ws, record.parent_code) if record.parent_code else None,
        icon=record.icon,
        color=record.color,
        state=record.state.upper(),  # type: ignore[arg-type]
        evidence=[contribution_name(ws, cid) for cid in record.evidence],
        document_count=record.document_count,
        in_review_count=record.in_review_count,
        create_time=record.create_time,
        update_time=record.update_time,
        delete_time=record.delete_time,
        purge_time=record.purge_time,
        etag=record.etag,
    )


def topic_filters(workspace_id: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "state": enum(queries.TOPIC_STATE, TopicState.__args__),
            "kind": enum(queries.TOPIC_KIND, TopicKind.__args__),
            "parentTopic": resource_name(
                Topic.parent_topic_id,
                lambda name: queries.topic_id_by_code(
                    workspace_id, parse_topic(name, workspace_id, field="filter")
                )
                if name
                else None,
            ),
        }
    )


#: ``documentCount`` sorts on the caller's own visible count (selected by ListTopics).
TOPIC_ORDER = OrderSchema(
    {"displayName": Topic.display_name, "documentCount": queries.DOCUMENT_COUNT},
    tie_breaker=[Topic.id],
    default="displayName",
)

__all__ = [
    "CONTRIBUTION_ORDER",
    "READING_LIST_ORDER",
    "TOPIC_ORDER",
    "AcceptTopicRequest",
    "ApproveContributionRequest",
    "ContributionMessage",
    "CopyReadingListRequest",
    "DecisionRequest",
    "EtagRequest",
    "ListContributionsResponse",
    "ListReadingListEntriesResponse",
    "ListReadingListsResponse",
    "ListTopicsResponse",
    "MergeTopicRequest",
    "ReadingListEntryMessage",
    "ReadingListMessage",
    "ResubmitContributionRequest",
    "TopicMessage",
    "View",
    "contribution_filters",
    "contribution_message",
    "entry_message",
    "reading_list_filters",
    "reading_list_message",
    "referenced_collections",
    "topic_filters",
    "topic_message",
]
