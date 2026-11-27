"""Knowledge curation messages (``openapi.yaml`` tag Knowledge: contributions) and
their filter/order maps."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import and_, case

from api.aip.filtering import (
    FilterSchema,
    enum,
    parse,
    repeated,
    resource_name,
    restrictions,
    stored_enum,
    string,
)
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import Contribution
from bomesh.services.ingestion.names import (
    parse_source,
    source_id_by_code,
    source_name,
)
from bomesh.services.knowledge_curation import queries
from bomesh.services.knowledge_curation.records import (
    ContributionRecord,
    contribution_name,
    parse_contribution,
)
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.knowledge_items.queries import indexing_state_conditions
from bomesh.services.workspaces.records import member_name, parse_member_name

View = Literal["VIEW_UNSPECIFIED", "BASIC", "FULL"]

# -- Contributions -------------------------------------------------------------------


class ContributionSuggestionsMessage(ProtoMessage):
    collection: str | None = None
    collection_confidence: float | None = None
    summary: str | None = None
    summary_confidence: float | None = None
    title: str | None = None


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
    #: Output only: the candidate's title and how far it is processed.
    item_display_name: str | None = None
    item_indexing_state: (
        Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"] | None
    ) = None
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
    #: Concept resource names; the first of each scheme is its primary.
    concepts: list[str] | None = None
    summary: str | None = None
    title: str | None = None


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
        item_display_name=record.item_display_name,
        item_indexing_state=record.item_indexing_state,  # type: ignore[arg-type]
        target_collection=item_name(ws, record.target_id) if record.target_id else None,
        replaces_item=item_name(ws, record.replaces_id) if record.replaces_id else None,
        contributor=member_name(ws, record.contributor_id) if record.contributor_id else None,
        source=source_name(ws, record.source_code) if record.source_code else None,
        external_version=record.external_version,
        note=record.note,
        change_summary=record.change_summary,
        suggestions=ContributionSuggestionsMessage(
            collection=item_name(ws, s.collection_id) if s.collection_id else None,
            collection_confidence=s.collection_confidence,
            summary=s.summary,
            summary_confidence=s.summary_confidence,
            title=s.title,
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


def contribution_filters(workspace_id: UUID, me: UUID, processing_version: str) -> FilterSchema:
    return FilterSchema(
        {
            "name": resource_name(
                Contribution.id,
                lambda name: parse_contribution(name, workspace_id, field="filter"),
            ),
            "state": stored_enum(Contribution.state, ContributionState.__args__),
            "kind": stored_enum(Contribution.kind, ("NEW_DOCUMENT", "NEW_REVISION")),
            "origin": stored_enum(Contribution.origin, ("MEMBER", "SOURCE")),
            "item": resource_name(
                Contribution.item_id,
                lambda name: parse_item(name, workspace_id, field="filter"),
            ),
            # The candidate's title and processing state are filterable where the caller may read the
            # candidate as a contribution party: their own contributions, and open ones (the reviewer
            # exception). A closed contribution of someone else never matches on them.
            "itemDisplayName": string(
                case((queries.candidate_shown(me), queries.CONTRIBUTION_ITEM_DISPLAY_NAME))
            ),
            "itemIndexingState": enum(
                case(
                    (
                        queries.candidate_shown(me),
                        queries.contribution_item_indexing_state(processing_version),
                    )
                ),
                ("PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"),
                conditions={
                    value: and_(queries.candidate_shown(me), condition)
                    for value, condition in indexing_state_conditions(
                        processing_version, Contribution.item_id
                    ).items()
                },
            ),
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
        if r.field == "targetCollection" and r.value.text and not r.is_presence
    )


CONTRIBUTION_ORDER = OrderSchema(
    {"createTime": Contribution.created_at, "updateTime": Contribution.updated_at},
    tie_breaker=[Contribution.id],
    default="createTime desc",
)


__all__ = [
    "CONTRIBUTION_ORDER",
    "ApproveContributionRequest",
    "ContributionMessage",
    "DecisionRequest",
    "EtagRequest",
    "ListContributionsResponse",
    "ResubmitContributionRequest",
    "View",
    "contribution_filters",
    "contribution_message",
    "referenced_collections",
]
