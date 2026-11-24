"""Knowledge curation messages (``openapi.yaml`` tag Knowledge: contributions,
topics) and their filter/order maps."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal
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
from bomesh.db.models import Contribution, Topic, TopicCorrection, TopicCorrectionChange
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.names import (
    parse_source,
    source_id_by_code,
    source_name,
)
from bomesh.services.knowledge_curation import queries
from bomesh.services.knowledge_curation.records import (
    ContributionRecord,
    TopicClassificationPrompt,
    TopicClassificationTest,
    TopicCorrectionRecord,
    TopicImportChange,
    TopicImportResult,
    TopicImportRow,
    TopicRecord,
    TopicRule,
    TopicSignals,
    contribution_name,
    parse_contribution,
    parse_topic,
    topic_correction_name,
    topic_name,
)
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.knowledge_items.queries import indexing_state_conditions
from bomesh.services.workspaces.records import member_name, parse_member_name

View = Literal["VIEW_UNSPECIFIED", "BASIC", "FULL"]
#: ImportTopics ``rows`` bound (``openapi.yaml``).
MAX_IMPORT_ROWS = 2000

# -- Contributions -------------------------------------------------------------------


class ContributionSuggestionsMessage(ProtoMessage):
    topics: list[str] | None = None
    topics_confidence: float | None = None
    proposed_topics: list[str] | None = None
    proposed_topics_confidence: float | None = None
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
    topics: list[str] | None = None
    summary: str | None = None
    title: str | None = None
    record_correction: bool | None = None


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
            topics=[topic_name(ws, code) for code in s.topic_codes] or None,
            topics_confidence=s.topics_confidence,
            proposed_topics=[topic_name(ws, code) for code in s.proposed_topic_codes] or None,
            proposed_topics_confidence=s.proposed_topics_confidence,
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

# -- Topics --------------------------------------------------------------------------

TopicKind = Literal["DOMAIN", "TOPIC"]
TopicState = Literal["PROPOSED", "ACTIVE", "REJECTED", "DELETED"]


class TopicRuleMessage(ProtoMessage):
    collection: str | None = None
    source: str | None = None


class TopicMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    kind: TopicKind | None = None
    parent_topic: str | None = None
    icon: str | None = None
    color: str | None = None
    keywords: list[str] | None = None
    synonyms: list[str] | None = None
    guidance: str | None = None
    examples: list[str] | None = None
    rules: list[TopicRuleMessage] | None = None
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


class TopicImportRowMessage(ProtoMessage):
    domain: str
    topic: str | None = None
    name: str | None = None
    description: str | None = None
    keywords: list[str] | None = None
    synonyms: list[str] | None = None
    guidance: str | None = None


class ImportTopicsRequest(ProtoMessage):
    rows: list[TopicImportRowMessage]
    mode: Literal["MERGE", "REPLACE"] = "MERGE"
    validate_only: bool = False


class TopicImportSkippedRowMessage(ProtoMessage):
    row: int
    reason: str


class TopicImportChangeMessage(ProtoMessage):
    topic: str
    kind: TopicKind
    display_name: str
    domain: str | None = None
    row: int | None = None
    changes: (
        list[Literal["RENAMED", "MOVED", "DESCRIPTION", "KEYWORDS", "SYNONYMS", "GUIDANCE"]] | None
    ) = None
    previous_display_name: str | None = None


class ImportTopicsResponse(ProtoMessage):
    created: list[TopicImportChangeMessage]
    updated: list[TopicImportChangeMessage]
    archived: list[TopicImportChangeMessage]
    unchanged_count: int
    skipped_rows: list[TopicImportSkippedRowMessage]


class TestTopicClassificationRequest(ProtoMessage):
    title: str
    text: str | None = None
    collection: str | None = None
    source: str | None = None
    topics: list[TopicMessage] | None = None


class TopicClassificationResultMessage(ProtoMessage):
    topic: str
    reason: Literal["RULE", "ASSISTANT"]


class TestTopicClassificationResponse(ProtoMessage):
    results: list[TopicClassificationResultMessage]
    summary: str | None = None


class TopicClassificationRuleSummaryMessage(ProtoMessage):
    topic: str
    rule: TopicRuleMessage


class CompileTopicClassificationPromptResponse(ProtoMessage):
    prompt: str
    rules: list[TopicClassificationRuleSummaryMessage]
    estimated_tokens: int


def topic_rule_message(workspace_id: UUID, rule: TopicRule) -> TopicRuleMessage:
    return TopicRuleMessage(
        collection=item_name(workspace_id, rule.collection_id) if rule.collection_id else None,
        source=source_name(workspace_id, rule.source_code) if rule.source_code else None,
    )


def topic_message(record: TopicRecord) -> TopicMessage:
    """A record of view BASIC (no signals) leaves the signal fields and ``evidence`` unset."""
    ws = record.workspace_id
    signals = record.signals
    return TopicMessage(
        name=topic_name(ws, record.code),
        display_name=record.display_name,
        description=record.description,
        kind=record.kind.upper(),  # type: ignore[arg-type]
        parent_topic=topic_name(ws, record.parent_code) if record.parent_code else None,
        icon=record.icon,
        color=record.color,
        keywords=list(signals.keywords) if signals is not None else None,
        synonyms=list(signals.synonyms) if signals is not None else None,
        guidance=signals.guidance if signals is not None else None,
        examples=(
            [item_name(ws, example) for example in signals.example_ids]
            if signals is not None
            else None
        ),
        rules=(
            [topic_rule_message(ws, rule) for rule in signals.rules]
            if signals is not None
            else None
        ),
        state=record.state.upper(),  # type: ignore[arg-type]
        evidence=(
            [contribution_name(ws, cid) for cid in record.evidence]
            if record.evidence is not None
            else None
        ),
        document_count=record.document_count,
        in_review_count=record.in_review_count,
        create_time=record.create_time,
        update_time=record.update_time,
        delete_time=record.delete_time,
        purge_time=record.purge_time,
        etag=record.etag,
    )


def topic_signal_values(values: Mapping[str, Any], workspace_id: UUID) -> dict[str, Any]:
    """Topic signal fields keyed by mask path, names resolved (``examples`` → item IDs,
    ``rules`` → :class:`TopicRule`); other paths pass through unchanged."""
    resolved = dict(values)
    if "examples" in resolved:
        resolved["examples"] = tuple(
            parse_item(name, workspace_id, field="examples") for name in resolved["examples"] or ()
        )
    if "rules" in resolved:
        resolved["rules"] = tuple(_topic_rule(rule, workspace_id) for rule in resolved["rules"] or ())
    return resolved


def topic_signals(message: TopicMessage, workspace_id: UUID) -> TopicSignals:
    """CreateTopic's signals."""
    values = topic_signal_values(
        {"examples": message.examples, "rules": message.rules}, workspace_id
    )
    return TopicSignals(
        keywords=tuple(message.keywords or ()),
        synonyms=tuple(message.synonyms or ()),
        guidance=message.guidance,
        example_ids=values["examples"],
        rules=values["rules"],
    )


def _topic_rule(rule: TopicRuleMessage, workspace_id: UUID) -> TopicRule:
    if bool(rule.collection) == bool(rule.source):
        raise InvalidArgument.for_field("rules", "A rule names exactly one of collection or source.")
    if rule.collection:
        return TopicRule(collection_id=parse_item(rule.collection, workspace_id, field="rules"))
    assert rule.source is not None
    return TopicRule(source_code=parse_source(rule.source, workspace_id, field="rules"))


def topic_overrides(
    messages: Sequence[TopicMessage], workspace_id: UUID
) -> dict[str, dict[str, Any]]:
    """TestTopicClassification's unsaved topic changes: code → the fields given."""
    overrides: dict[str, dict[str, Any]] = {}
    for message in messages:
        if not message.name:
            raise InvalidArgument.for_field("topics", "Each topic names the topic it changes.")
        given = {
            path: getattr(message, attribute)
            for path, attribute in (
                ("displayName", "display_name"),
                ("description", "description"),
                ("keywords", "keywords"),
                ("synonyms", "synonyms"),
                ("guidance", "guidance"),
                ("examples", "examples"),
                ("rules", "rules"),
            )
            if attribute in message.model_fields_set
        }
        overrides[parse_topic(message.name, workspace_id, field="topics")] = topic_signal_values(
            given, workspace_id
        )
    return overrides


def import_rows(request: ImportTopicsRequest) -> tuple[TopicImportRow, ...]:
    if len(request.rows) > MAX_IMPORT_ROWS:
        raise InvalidArgument.for_field("rows", f"At most {MAX_IMPORT_ROWS} rows are allowed.")
    return tuple(
        TopicImportRow(
            domain=row.domain,
            topic=row.topic,
            name=row.name,
            description=row.description,
            keywords=tuple(row.keywords) if row.keywords is not None else None,
            synonyms=tuple(row.synonyms) if row.synonyms is not None else None,
            guidance=row.guidance,
        )
        for row in request.rows
    )


def import_response(workspace_id: UUID, result: TopicImportResult) -> ImportTopicsResponse:
    def change(record: TopicImportChange) -> TopicImportChangeMessage:
        return TopicImportChangeMessage(
            topic=topic_name(workspace_id, record.code),
            kind=record.kind.upper(),  # type: ignore[arg-type]
            display_name=record.display_name,
            domain=record.domain,
            row=record.row,
            changes=list(record.changes) or None,  # type: ignore[arg-type]
            previous_display_name=record.previous_display_name,
        )

    return ImportTopicsResponse(
        created=[change(record) for record in result.created],
        updated=[change(record) for record in result.updated],
        archived=[change(record) for record in result.archived],
        unchanged_count=result.unchanged_count,
        skipped_rows=[
            TopicImportSkippedRowMessage(row=row, reason=reason) for row, reason in result.skipped
        ],
    )


def classification_test_response(
    workspace_id: UUID, result: TopicClassificationTest
) -> TestTopicClassificationResponse:
    return TestTopicClassificationResponse(
        results=[
            TopicClassificationResultMessage(
                topic=topic_name(workspace_id, code),
                reason=reason.upper(),  # type: ignore[arg-type]
            )
            for code, reason in result.results
        ],
        summary=result.summary,
    )


def classification_prompt_response(
    workspace_id: UUID, result: TopicClassificationPrompt
) -> CompileTopicClassificationPromptResponse:
    return CompileTopicClassificationPromptResponse(
        prompt=result.prompt,
        rules=[
            TopicClassificationRuleSummaryMessage(
                topic=topic_name(workspace_id, code), rule=topic_rule_message(workspace_id, rule)
            )
            for code, rule in result.rules
        ],
        estimated_tokens=result.estimated_tokens,
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
    {"displayName": Topic.topic_name, "documentCount": queries.DOCUMENT_COUNT},
    tie_breaker=[Topic.id],
    default="displayName",
)


# -- Topic assignments and corrections -------------------------------------------------

TopicCorrectionState = Literal["OPEN", "DISMISSED"]


class ConfirmTopicAssignmentsRequest(ProtoMessage):
    filter: str | None = None


class ConfirmTopicAssignmentsResponse(ProtoMessage):
    confirmed_count: int


class TopicCorrectionMessage(ProtoMessage):
    name: str | None = None
    item: str | None = None
    item_display_name: str | None = None
    from_topics: list[str] | None = None
    to_topics: list[str] | None = None
    actor: str | None = None
    state: TopicCorrectionState | None = None
    create_time: Timestamp | None = None


class ListTopicCorrectionsResponse(ProtoMessage):
    topic_corrections: list[TopicCorrectionMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class DismissTopicCorrectionRequest(ProtoMessage):
    pass


def topic_correction_message(record: TopicCorrectionRecord) -> TopicCorrectionMessage:
    ws = record.workspace_id
    return TopicCorrectionMessage(
        name=topic_correction_name(ws, record.id),
        item=item_name(ws, record.item_id) if record.item_id else None,
        item_display_name=record.item_display_name if record.item_id else None,
        from_topics=[topic_name(ws, code) for code in record.from_topic_codes],
        to_topics=[topic_name(ws, code) for code in record.to_topic_codes],
        actor=member_name(ws, record.actor_id),
        state=record.state.upper(),  # type: ignore[arg-type]
        create_time=record.create_time,
    )


def topic_correction_filters(workspace_id: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "state": enum(
                queries.TOPIC_CORRECTION_STATE,
                TopicCorrectionState.__args__,
                conditions=queries.TOPIC_CORRECTION_STATE_CONDITIONS,
            ),
            "toTopics": repeated(
                resource_name(
                    TopicCorrectionChange.topic_id,
                    lambda name: parse_topic(name, workspace_id, field="filter"),
                ),
                has=lambda code: queries.correction_to_topic(workspace_id, code),
            ),
        }
    )


TOPIC_CORRECTION_ORDER = OrderSchema(
    {"createTime": TopicCorrection.created_at},
    tie_breaker=[TopicCorrection.id],
    default="createTime desc",
)


__all__ = [
    "CONTRIBUTION_ORDER",
    "TOPIC_CORRECTION_ORDER",
    "TOPIC_ORDER",
    "AcceptTopicRequest",
    "ApproveContributionRequest",
    "CompileTopicClassificationPromptResponse",
    "ConfirmTopicAssignmentsRequest",
    "ConfirmTopicAssignmentsResponse",
    "ContributionMessage",
    "DecisionRequest",
    "DismissTopicCorrectionRequest",
    "EtagRequest",
    "ImportTopicsRequest",
    "ImportTopicsResponse",
    "ListContributionsResponse",
    "ListTopicCorrectionsResponse",
    "ListTopicsResponse",
    "MergeTopicRequest",
    "ResubmitContributionRequest",
    "TestTopicClassificationRequest",
    "TestTopicClassificationResponse",
    "TopicCorrectionMessage",
    "TopicMessage",
    "TopicRuleMessage",
    "View",
    "classification_prompt_response",
    "classification_test_response",
    "contribution_filters",
    "contribution_message",
    "import_response",
    "import_rows",
    "referenced_collections",
    "topic_correction_filters",
    "topic_correction_message",
    "topic_filters",
    "topic_message",
    "topic_overrides",
    "topic_signal_values",
    "topic_signals",
]
