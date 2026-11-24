"""Knowledge interface — KnowledgeCuration slice: Contributions and topics.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query

from api.aip.fieldmask import MutableFields, apply
from api.dto.identity import Empty
from api.dto.knowledge_curation import (
    CONTRIBUTION_ORDER,
    TOPIC_CORRECTION_ORDER,
    TOPIC_ORDER,
    AcceptTopicRequest,
    ApproveContributionRequest,
    CompileTopicClassificationPromptResponse,
    ConfirmTopicAssignmentsRequest,
    ConfirmTopicAssignmentsResponse,
    ContributionMessage,
    DecisionRequest,
    DismissTopicCorrectionRequest,
    EtagRequest,
    ImportTopicsRequest,
    ImportTopicsResponse,
    ListContributionsResponse,
    ListTopicCorrectionsResponse,
    ListTopicsResponse,
    MergeTopicRequest,
    ResubmitContributionRequest,
    TestTopicClassificationRequest,
    TestTopicClassificationResponse,
    TopicCorrectionMessage,
    TopicMessage,
    View,
    classification_prompt_response,
    classification_test_response,
    contribution_filters,
    contribution_message,
    import_response,
    import_rows,
    referenced_collections,
    topic_correction_filters,
    topic_correction_message,
    topic_filters,
    topic_message,
    topic_overrides,
    topic_signal_values,
    topic_signals,
)
from api.dto.knowledge_items import item_filters, referenced_items
from api.v1.deps import Context, Runtime, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.names import parse_source
from bomesh.services.knowledge_curation.contributions import ContributionService
from bomesh.services.knowledge_curation.records import (
    Approval,
    ContributionDraft,
    TopicDraft,
    parse_topic,
)
from bomesh.services.knowledge_curation.topic_assignments import TopicAssignmentService
from bomesh.services.knowledge_curation.topics import TopicService
from bomesh.services.knowledge_items.names import parse_item

router = APIRouter(tags=["Knowledge"])

Contributions = Annotated[
    ContributionService, Depends(service(ContributionService.from_runtime))
]
Topics = Annotated[TopicService, Depends(service(TopicService.from_runtime))]
TopicAssignments = Annotated[
    TopicAssignmentService, Depends(service(TopicAssignmentService.from_runtime))
]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
Etag = Annotated[str | None, Query()]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
_ID_PATTERN = r"^[a-z][a-z0-9-]{0,62}$"

_WS = "/workspaces/{workspace:id}"
_CONTRIBUTION = f"{_WS}/contributions/{{contribution:id}}"
_TOPIC = f"{_WS}/topics/{{topic:id}}"

_TOPIC_FIELDS = MutableFields(
    (
        "displayName",
        "description",
        "parentTopic",
        "icon",
        "color",
        "keywords",
        "synonyms",
        "guidance",
        "examples",
        "rules",
    )
)


# -- Contributions -------------------------------------------------------------------


@router.post(f"{_WS}/contributions", name="CreateContribution")
async def create_contribution(
    workspace: UUID,
    body: ContributionMessage,
    ctx: Context,
    contributions: Contributions,
    request_id: RequestId = None,
) -> ContributionMessage:
    if not body.item:
        raise InvalidArgument.for_field("item", "item is required.")
    draft = ContributionDraft(
        kind=(body.kind or "NEW_DOCUMENT").lower(),
        item_id=parse_item(body.item, workspace, field="item"),
        target_id=parse_item(body.target_collection, workspace, field="targetCollection")
        if body.target_collection
        else None,
        replaces_id=parse_item(body.replaces_item, workspace, field="replacesItem")
        if body.replaces_item
        else None,
        note=body.note,
        change_summary=body.change_summary,
    )
    record = await contributions.create(ctx, workspace, draft, request_id=request_id)
    return contribution_message(record)


@router.get(f"{_WS}/contributions", name="ListContributions")
async def list_contributions(
    workspace: UUID,
    ctx: Context,
    contributions: Contributions,
    params: Annotated[ListParams, Depends()],
    view: Annotated[View, Query()] = "BASIC",
) -> ListContributionsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=contribution_filters(workspace, ctx.principal.user_id),
        order=CONTRIBUTION_ORDER,
    )
    rows, total = await contributions.list(
        ctx,
        workspace,
        query,
        full=view == "FULL",
        referenced_collections=referenced_collections(params.filter, workspace),
    )
    page = paging.page(rows, total_size=total)
    return ListContributionsResponse(
        contributions=[contribution_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_CONTRIBUTION, name="GetContribution")
async def get_contribution(
    workspace: UUID,
    contribution: UUID,
    ctx: Context,
    contributions: Contributions,
    view: Annotated[View, Query()] = "FULL",
) -> ContributionMessage:
    record = await contributions.get(ctx, workspace, contribution, full=view != "BASIC")
    return contribution_message(record)


@router.delete(_CONTRIBUTION, name="DeleteContribution")
async def delete_contribution(
    workspace: UUID,
    contribution: UUID,
    ctx: Context,
    contributions: Contributions,
    etag: Etag = None,
) -> Empty:
    await contributions.delete(ctx, workspace, contribution, etag=etag)
    return Empty()


@router.post(f"{_CONTRIBUTION}:approve", name="ApproveContribution")
async def approve_contribution(
    workspace: UUID,
    contribution: UUID,
    body: ApproveContributionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    approval = Approval(
        etag=body.etag,
        target_id=parse_item(body.target_collection, workspace, field="targetCollection")
        if body.target_collection
        else None,
        topic_codes=tuple(parse_topic(name, workspace, field="topics") for name in body.topics)
        if body.topics is not None
        else None,
        summary=body.summary,
        title=body.title,
        record_correction=bool(body.record_correction),
    )
    return contribution_message(await contributions.approve(ctx, workspace, contribution, approval))


@router.post(f"{_CONTRIBUTION}:reject", name="RejectContribution")
async def reject_contribution(
    workspace: UUID,
    contribution: UUID,
    body: DecisionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.reject(
        ctx, workspace, contribution, message=body.message, etag=body.etag
    )
    return contribution_message(record)


@router.post(f"{_CONTRIBUTION}:requestChanges", name="RequestContributionChanges")
async def request_contribution_changes(
    workspace: UUID,
    contribution: UUID,
    body: DecisionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.request_changes(
        ctx, workspace, contribution, message=body.message, etag=body.etag
    )
    return contribution_message(record)


@router.post(f"{_CONTRIBUTION}:resubmit", name="ResubmitContribution")
async def resubmit_contribution(
    workspace: UUID,
    contribution: UUID,
    body: ResubmitContributionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.resubmit(
        ctx,
        workspace,
        contribution,
        change_summary=body.change_summary,
        item_id=parse_item(body.item, workspace, field="item") if body.item else None,
        note=body.note,
        etag=body.etag,
    )
    return contribution_message(record)


@router.post(f"{_CONTRIBUTION}:withdraw", name="WithdrawContribution")
async def withdraw_contribution(
    workspace: UUID,
    contribution: UUID,
    body: EtagRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.withdraw(ctx, workspace, contribution, etag=body.etag)
    return contribution_message(record)


# -- Topics --------------------------------------------------------------------------


@router.post(f"{_WS}/topics", name="CreateTopic")
async def create_topic(
    workspace: UUID,
    body: TopicMessage,
    ctx: Context,
    topics: Topics,
    topic_id: Annotated[str | None, Query(alias="topicId", pattern=_ID_PATTERN)] = None,
    request_id: RequestId = None,
) -> TopicMessage:
    if not body.display_name:
        raise InvalidArgument.for_field("displayName", "displayName is required.")
    draft = TopicDraft(
        display_name=body.display_name,
        kind=(body.kind or "TOPIC").lower(),
        description=body.description,
        parent_code=parse_topic(body.parent_topic, workspace, field="parentTopic")
        if body.parent_topic
        else None,
        icon=body.icon,
        color=body.color,
        signals=topic_signals(body, workspace),
    )
    record = await topics.create(ctx, workspace, draft, topic_id=topic_id, request_id=request_id)
    return topic_message(record)


@router.get(f"{_WS}/topics", name="ListTopics")
async def list_topics(
    workspace: UUID,
    ctx: Context,
    topics: Topics,
    params: Annotated[ListParams, Depends()],
    view: Annotated[View, Query()] = "BASIC",
) -> ListTopicsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=topic_filters(workspace),
        order=TOPIC_ORDER,
    )
    rows, total = await topics.list(ctx, workspace, query, full=view == "FULL")
    page = paging.page(rows, total_size=total)
    return ListTopicsResponse(
        topics=[topic_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_TOPIC, name="GetTopic")
async def get_topic(workspace: UUID, topic: str, ctx: Context, topics: Topics) -> TopicMessage:
    return topic_message(await topics.get(ctx, workspace, topic))


@router.patch(_TOPIC, name="UpdateTopic")
async def update_topic(
    workspace: UUID,
    topic: str,
    body: TopicMessage,
    ctx: Context,
    topics: Topics,
    update_mask: UpdateMask = None,
) -> TopicMessage:
    changes: dict[str, Any] = topic_signal_values(
        apply(_TOPIC_FIELDS.parse(update_mask, body), body), workspace
    )
    if changes.get("parentTopic"):
        changes["parentTopic"] = parse_topic(changes["parentTopic"], workspace, field="parentTopic")
    record = await topics.update(ctx, workspace, topic, changes, etag=body.etag)
    return topic_message(record)


@router.delete(_TOPIC, name="DeleteTopic")
async def delete_topic(
    workspace: UUID, topic: str, ctx: Context, topics: Topics, etag: Etag = None
) -> TopicMessage:
    return topic_message(await topics.delete(ctx, workspace, topic, etag=etag))


@router.post(f"{_TOPIC}:undelete", name="UndeleteTopic")
async def undelete_topic(
    workspace: UUID, topic: str, body: EtagRequest, ctx: Context, topics: Topics
) -> TopicMessage:
    return topic_message(await topics.undelete(ctx, workspace, topic, etag=body.etag))


@router.post(f"{_TOPIC}:accept", name="AcceptTopic")
async def accept_topic(
    workspace: UUID, topic: str, body: AcceptTopicRequest, ctx: Context, topics: Topics
) -> TopicMessage:
    record = await topics.accept(
        ctx,
        workspace,
        topic,
        parent_code=parse_topic(body.parent_topic, workspace, field="parentTopic")
        if body.parent_topic
        else None,
        display_name=body.display_name,
        etag=body.etag,
    )
    return topic_message(record)


@router.post(f"{_TOPIC}:reject", name="RejectTopic")
async def reject_topic(
    workspace: UUID, topic: str, body: EtagRequest, ctx: Context, topics: Topics
) -> TopicMessage:
    return topic_message(await topics.reject(ctx, workspace, topic, etag=body.etag))


@router.post(f"{_TOPIC}:merge", name="MergeTopic")
async def merge_topic(
    workspace: UUID, topic: str, body: MergeTopicRequest, ctx: Context, topics: Topics
) -> TopicMessage:
    target = parse_topic(body.target_topic, workspace, field="targetTopic")
    return topic_message(await topics.merge(ctx, workspace, topic, target, etag=body.etag))


@router.post(f"{_WS}/topics:import", name="ImportTopics")
async def import_topics(
    workspace: UUID, body: ImportTopicsRequest, ctx: Context, topics: Topics
) -> ImportTopicsResponse:
    result = await topics.import_topics(
        ctx,
        workspace,
        import_rows(body),
        replace=body.mode == "REPLACE",
        validate_only=body.validate_only,
    )
    return import_response(workspace, result)


@router.post(f"{_WS}/topics:testClassification", name="TestTopicClassification")
async def test_topic_classification(
    workspace: UUID, body: TestTopicClassificationRequest, ctx: Context, topics: Topics
) -> TestTopicClassificationResponse:
    result = await topics.test_classification(
        ctx,
        workspace,
        title=body.title,
        text=body.text or "",
        collection_id=parse_item(body.collection, workspace, field="collection")
        if body.collection
        else None,
        source_code=parse_source(body.source, workspace, field="source") if body.source else None,
        overrides=topic_overrides(body.topics or (), workspace),
    )
    return classification_test_response(workspace, result)


@router.get(f"{_WS}/topics:compileClassificationPrompt", name="CompileTopicClassificationPrompt")
async def compile_topic_classification_prompt(
    workspace: UUID, ctx: Context, topics: Topics
) -> CompileTopicClassificationPromptResponse:
    return classification_prompt_response(
        workspace, await topics.compile_classification_prompt(ctx, workspace)
    )


# -- Topic assignments and corrections -------------------------------------------------

_CORRECTION = f"{_WS}/topicCorrections/{{topicCorrection:id}}"


@router.post(f"{_TOPIC}:confirmAssignments", name="ConfirmTopicAssignments")
async def confirm_topic_assignments(
    workspace: UUID,
    topic: str,
    body: ConfirmTopicAssignmentsRequest,
    ctx: Context,
    assignments: TopicAssignments,
    runtime: Runtime,
) -> ConfirmTopicAssignmentsResponse:
    where = item_filters(workspace, runtime.processing_version()).compile(body.filter)
    confirmed = await assignments.confirm(
        ctx, workspace, topic, where, referenced=referenced_items(body.filter, workspace)
    )
    return ConfirmTopicAssignmentsResponse(confirmed_count=confirmed)


@router.get(f"{_WS}/topicCorrections", name="ListTopicCorrections")
async def list_topic_corrections(
    workspace: UUID,
    ctx: Context,
    assignments: TopicAssignments,
    params: Annotated[ListParams, Depends()],
) -> ListTopicCorrectionsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=topic_correction_filters(workspace),
        order=TOPIC_CORRECTION_ORDER,
    )
    rows, total = await assignments.list_corrections(ctx, workspace, query)
    page = paging.page(rows, total_size=total)
    return ListTopicCorrectionsResponse(
        topic_corrections=[topic_correction_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_CORRECTION, name="GetTopicCorrection")
async def get_topic_correction(
    workspace: UUID,
    ctx: Context,
    assignments: TopicAssignments,
    correction: Annotated[UUID, Path(alias="topicCorrection")],
) -> TopicCorrectionMessage:
    return topic_correction_message(
        await assignments.get_correction(ctx, workspace, correction)
    )


@router.post(f"{_CORRECTION}:dismiss", name="DismissTopicCorrection")
async def dismiss_topic_correction(
    workspace: UUID,
    body: DismissTopicCorrectionRequest,
    ctx: Context,
    assignments: TopicAssignments,
    correction: Annotated[UUID, Path(alias="topicCorrection")],
) -> TopicCorrectionMessage:
    return topic_correction_message(
        await assignments.dismiss_correction(ctx, workspace, correction)
    )
