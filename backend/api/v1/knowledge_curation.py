"""Knowledge interface — KnowledgeCuration slice: Contributions, reading lists and their entries, and topics.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query

from api.aip.fieldmask import MutableFields, apply
from api.aip.paging import PageRequest, query_fingerprint
from api.dto.identity import Empty
from api.dto.knowledge_curation import (
    CONTRIBUTION_ORDER,
    READING_LIST_ORDER,
    TOPIC_ORDER,
    AcceptTopicRequest,
    ApproveContributionRequest,
    ContributionMessage,
    CopyReadingListRequest,
    DecisionRequest,
    EtagRequest,
    ListContributionsResponse,
    ListReadingListEntriesResponse,
    ListReadingListsResponse,
    ListTopicsResponse,
    MergeTopicRequest,
    ReadingListEntryMessage,
    ReadingListMessage,
    ResubmitContributionRequest,
    TopicMessage,
    View,
    contribution_filters,
    contribution_message,
    entry_message,
    reading_list_filters,
    reading_list_message,
    referenced_collections,
    topic_filters,
    topic_message,
)
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.collaboration.support import parse_space_name
from bomesh.services.knowledge_curation.contributions import ContributionService
from bomesh.services.knowledge_curation.reading_lists import ReadingListService
from bomesh.services.knowledge_curation.records import (
    Approval,
    ContributionDraft,
    ReadingListDraft,
    TopicDraft,
    parse_topic,
    reading_list_name,
)
from bomesh.services.knowledge_curation.topics import TopicService
from bomesh.services.knowledge_items.names import parse_item

router = APIRouter(tags=["Knowledge"])

Contributions = Annotated[
    ContributionService, Depends(service(ContributionService.from_runtime))
]
ReadingLists = Annotated[ReadingListService, Depends(service(ReadingListService.from_runtime))]
Topics = Annotated[TopicService, Depends(service(TopicService.from_runtime))]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
Etag = Annotated[str | None, Query()]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
ListId = Annotated[str, Path(alias="readingList")]
_ID_PATTERN = r"^[a-z][a-z0-9-]{0,62}$"

_WS = "/workspaces/{workspace:id}"
_CONTRIBUTION = f"{_WS}/contributions/{{contribution:id}}"
_LIST = f"{_WS}/readingLists/{{readingList:id}}"
_ENTRY = f"{_LIST}/entries/{{entry:id}}"
_TOPIC = f"{_WS}/topics/{{topic:id}}"

_READING_LIST_FIELDS = MutableFields(("displayName", "description", "audience", "space"))
_ENTRY_FIELDS = MutableFields(("note", "position"))
_TOPIC_FIELDS = MutableFields(("displayName", "description", "parentTopic", "icon", "color"))


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
        document_type=body.document_type,
        topic_codes=tuple(parse_topic(name, workspace, field="topics") for name in body.topics)
        if body.topics is not None
        else None,
        summary=body.summary,
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


# -- Reading lists -------------------------------------------------------------------


@router.post(f"{_WS}/readingLists", name="CreateReadingList")
async def create_reading_list(
    workspace: UUID,
    body: ReadingListMessage,
    ctx: Context,
    reading_lists: ReadingLists,
    reading_list_id: Annotated[
        str | None, Query(alias="readingListId", pattern=_ID_PATTERN)
    ] = None,
    request_id: RequestId = None,
) -> ReadingListMessage:
    draft = ReadingListDraft(
        display_name=body.display_name or "",
        audience=(body.audience or "PRIVATE").lower(),
        description=body.description,
        space_code=parse_space_name(body.space, workspace, field="space") if body.space else None,
    )
    record = await reading_lists.create(
        ctx, workspace, draft, reading_list_id=reading_list_id, request_id=request_id
    )
    return reading_list_message(record)


@router.get(f"{_WS}/readingLists", name="ListReadingLists")
async def list_reading_lists(
    workspace: UUID,
    ctx: Context,
    reading_lists: ReadingLists,
    params: Annotated[ListParams, Depends()],
) -> ListReadingListsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=reading_list_filters(workspace, ctx.principal.user_id),
        order=READING_LIST_ORDER,
    )
    rows, total = await reading_lists.list(ctx, workspace, query)
    page = paging.page(rows, total_size=total)
    return ListReadingListsResponse(
        reading_lists=[reading_list_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_LIST, name="GetReadingList")
async def get_reading_list(
    workspace: UUID, reading_list: ListId, ctx: Context, reading_lists: ReadingLists
) -> ReadingListMessage:
    return reading_list_message(await reading_lists.get(ctx, workspace, reading_list))


@router.patch(_LIST, name="UpdateReadingList")
async def update_reading_list(
    workspace: UUID,
    reading_list: ListId,
    body: ReadingListMessage,
    ctx: Context,
    reading_lists: ReadingLists,
    update_mask: UpdateMask = None,
) -> ReadingListMessage:
    changes: dict[str, Any] = apply(_READING_LIST_FIELDS.parse(update_mask, body), body)
    if "audience" in changes:
        changes["audience"] = (changes["audience"] or "PRIVATE").lower()
    if "space" in changes:
        changes["space"] = (
            parse_space_name(changes["space"], workspace, field="space")
            if changes["space"]
            else None
        )
    record = await reading_lists.update(ctx, workspace, reading_list, changes, etag=body.etag)
    return reading_list_message(record)


@router.delete(_LIST, name="DeleteReadingList")
async def delete_reading_list(
    workspace: UUID,
    reading_list: ListId,
    ctx: Context,
    reading_lists: ReadingLists,
    etag: Etag = None,
) -> ReadingListMessage:
    return reading_list_message(
        await reading_lists.delete(ctx, workspace, reading_list, etag=etag)
    )


@router.post(f"{_LIST}:undelete", name="UndeleteReadingList")
async def undelete_reading_list(
    workspace: UUID,
    reading_list: ListId,
    body: EtagRequest,
    ctx: Context,
    reading_lists: ReadingLists,
) -> ReadingListMessage:
    return reading_list_message(
        await reading_lists.undelete(ctx, workspace, reading_list, etag=body.etag)
    )


@router.post(f"{_LIST}:copy", name="CopyReadingList")
async def copy_reading_list(
    workspace: UUID,
    reading_list: ListId,
    body: CopyReadingListRequest,
    ctx: Context,
    reading_lists: ReadingLists,
) -> ReadingListMessage:
    record = await reading_lists.copy(
        ctx,
        workspace,
        reading_list,
        display_name=body.display_name,
        reading_list_id=body.reading_list_id,
    )
    return reading_list_message(record)


@router.post(f"{_LIST}/entries", name="CreateReadingListEntry")
async def create_reading_list_entry(
    workspace: UUID,
    reading_list: ListId,
    body: ReadingListEntryMessage,
    ctx: Context,
    reading_lists: ReadingLists,
    entry_id: Annotated[str | None, Query(alias="entryId")] = None,
) -> ReadingListEntryMessage:
    if not body.item:
        raise InvalidArgument.for_field("item", "item is required.")
    item_id = parse_item(body.item, workspace, field="item")
    if entry_id is not None and entry_id != str(item_id):
        raise InvalidArgument.for_field("entryId", "entryId must equal the item ID.")
    record = await reading_lists.create_entry(
        ctx, workspace, reading_list, item_id, note=body.note, position=body.position
    )
    return entry_message(record)


@router.get(f"{_LIST}/entries", name="ListReadingListEntries")
async def list_reading_list_entries(
    workspace: UUID,
    reading_list: ListId,
    ctx: Context,
    reading_lists: ReadingLists,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
) -> ListReadingListEntriesResponse:
    paging = PageRequest.from_params(
        page_size,
        page_token,
        query_fingerprint(parent=reading_list_name(workspace, reading_list)),
    )
    result = await reading_lists.list_entries(
        ctx, workspace, reading_list, offset=paging.offset, limit=paging.fetch_limit
    )
    page = paging.page(result.entries)
    return ListReadingListEntriesResponse(
        entries=[entry_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        hidden_item_count=result.hidden_item_count,
    )


@router.get(_ENTRY, name="GetReadingListEntry")
async def get_reading_list_entry(
    workspace: UUID, reading_list: ListId, entry: UUID, ctx: Context, reading_lists: ReadingLists
) -> ReadingListEntryMessage:
    return entry_message(await reading_lists.get_entry(ctx, workspace, reading_list, entry))


@router.patch(_ENTRY, name="UpdateReadingListEntry")
async def update_reading_list_entry(
    workspace: UUID,
    reading_list: ListId,
    entry: UUID,
    body: ReadingListEntryMessage,
    ctx: Context,
    reading_lists: ReadingLists,
    update_mask: UpdateMask = None,
) -> ReadingListEntryMessage:
    changes = apply(_ENTRY_FIELDS.parse(update_mask, body), body)
    record = await reading_lists.update_entry(ctx, workspace, reading_list, entry, changes)
    return entry_message(record)


@router.delete(_ENTRY, name="DeleteReadingListEntry")
async def delete_reading_list_entry(
    workspace: UUID, reading_list: ListId, entry: UUID, ctx: Context, reading_lists: ReadingLists
) -> Empty:
    await reading_lists.delete_entry(ctx, workspace, reading_list, entry)
    return Empty()


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
    )
    record = await topics.create(ctx, workspace, draft, topic_id=topic_id, request_id=request_id)
    return topic_message(record)


@router.get(f"{_WS}/topics", name="ListTopics")
async def list_topics(
    workspace: UUID,
    ctx: Context,
    topics: Topics,
    params: Annotated[ListParams, Depends()],
) -> ListTopicsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=topic_filters(workspace),
        order=TOPIC_ORDER,
    )
    rows, total = await topics.list(ctx, workspace, query)
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
    changes: dict[str, Any] = apply(_TOPIC_FIELDS.parse(update_mask, body), body)
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
