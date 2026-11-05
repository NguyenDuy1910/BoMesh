"""Assistant interface — Conversations slice: Conversations, messages, converse (SSE), feedback and shares (`conversation_loop.md`).

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from api.aip import fieldmask
from api.aip.paging import PageRequest, query_fingerprint
from api.dto.conversations import (
    CONVERSATION_FIELDS,
    CONVERSATION_FILTERS,
    CONVERSATION_ORDER,
    MESSAGE_FILTERS,
    MESSAGE_ORDER,
    ChatMessage,
    ConversationMessage,
    ConverseRequest,
    ListConversationsResponse,
    ListMessagesResponse,
    ListSharesResponse,
    ShareMessage,
    SubmitMessageFeedbackRequest,
    UndeleteConversationRequest,
    chat_message,
    conversation_message,
    share_message,
    sse_frame,
)
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.services.conversations.conversations import ConversationResourceService
from bomesh.services.conversations.messages import MessageService
from bomesh.services.conversations.records import conversation_name
from bomesh.services.conversations.shares import ShareService

router = APIRouter(tags=["Assistant"])

Conversations = Annotated[
    ConversationResourceService, Depends(service(ConversationResourceService.from_runtime))
]
Messages = Annotated[MessageService, Depends(service(MessageService.from_runtime))]
Shares = Annotated[ShareService, Depends(service(ShareService.from_runtime))]
Listing = Annotated[ListParams, Depends()]
RequestId = Annotated[UUID | None, Query(alias="requestId")]

_CONVERSATIONS = "/workspaces/{workspace:id}/conversations"
_CONVERSATION = f"{_CONVERSATIONS}/{{conversation:id}}"
_MESSAGE = f"{_CONVERSATION}/messages/{{message:id}}"
_SHARE = f"{_CONVERSATION}/shares/{{share:id}}"


# -- Conversations ----------------------------------------------------------------


@router.post(_CONVERSATIONS, name="CreateConversation")
async def create_conversation(
    workspace: UUID,
    body: ConversationMessage,
    ctx: Context,
    conversations: Conversations,
    conversation_id: Annotated[str | None, Query(alias="conversationId")] = None,
    request_id: RequestId = None,
    validate_only: Annotated[bool, Query(alias="validateOnly")] = False,
) -> ConversationMessage:
    scope = body.scope
    record = await conversations.create(
        ctx,
        workspace,
        conversation_id=conversation_id,
        display_name=body.display_name,
        pinned=bool(body.pinned),
        scope_collections=(scope.collections or []) if scope else [],
        scope_spaces=(scope.spaces or []) if scope else [],
        request_id=request_id,
        validate_only=validate_only,
    )
    return conversation_message(record)


@router.get(_CONVERSATIONS, name="ListConversations")
async def list_conversations(
    workspace: UUID, params: Listing, ctx: Context, conversations: Conversations
) -> ListConversationsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=CONVERSATION_FILTERS,
        order=CONVERSATION_ORDER,
    )
    records, total = await conversations.list(ctx, workspace, query)
    page = paging.page(records, total_size=total)
    return ListConversationsResponse(
        conversations=[conversation_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_CONVERSATION, name="GetConversation")
async def get_conversation(
    workspace: UUID, conversation: str, ctx: Context, conversations: Conversations
) -> ConversationMessage:
    return conversation_message(await conversations.get(ctx, workspace, conversation))


@router.patch(_CONVERSATION, name="UpdateConversation")
async def update_conversation(
    workspace: UUID,
    conversation: str,
    body: ConversationMessage,
    ctx: Context,
    conversations: Conversations,
    update_mask: Annotated[str | None, Query(alias="updateMask")] = None,
) -> ConversationMessage:
    changes = fieldmask.apply(CONVERSATION_FIELDS.parse(update_mask, body), body)
    return conversation_message(await conversations.update(ctx, workspace, conversation, changes))


@router.delete(_CONVERSATION, name="DeleteConversation")
async def delete_conversation(
    workspace: UUID, conversation: str, ctx: Context, conversations: Conversations
) -> ConversationMessage:
    return conversation_message(await conversations.delete(ctx, workspace, conversation))


@router.post(f"{_CONVERSATION}:undelete", name="UndeleteConversation")
async def undelete_conversation(
    workspace: UUID,
    conversation: str,
    _: UndeleteConversationRequest,
    ctx: Context,
    conversations: Conversations,
) -> ConversationMessage:
    return conversation_message(await conversations.undelete(ctx, workspace, conversation))


@router.post(f"{_CONVERSATION}:converse", name="ConverseConversation")
async def converse_conversation(
    workspace: UUID,
    conversation: str,
    body: ConverseRequest,
    request: Request,
    ctx: Context,
    conversations: Conversations,
) -> StreamingResponse:
    events = await conversations.converse(
        ctx,
        workspace,
        conversation,
        message=body.message,
        attachments=body.attachments or [],
        replace_from_message=body.replace_from_message,
        is_disconnected=request.is_disconnected,
    )
    return StreamingResponse(
        (sse_frame(event) async for event in events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# -- Messages ---------------------------------------------------------------------


@router.get(f"{_CONVERSATION}/messages", name="ListMessages")
async def list_messages(
    workspace: UUID, conversation: str, params: Listing, ctx: Context, messages: Messages
) -> ListMessagesResponse:
    query, paging = list_query(
        params,
        parent=conversation_name(workspace, conversation),
        filters=MESSAGE_FILTERS,
        order=MESSAGE_ORDER,
    )
    records, total = await messages.list(ctx, workspace, conversation, query)
    page = paging.page(records, total_size=total)
    return ListMessagesResponse(
        messages=[chat_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_MESSAGE, name="GetMessage")
async def get_message(
    workspace: UUID, conversation: str, message: UUID, ctx: Context, messages: Messages
) -> ChatMessage:
    return chat_message(await messages.get(ctx, workspace, conversation, message))


@router.post(f"{_MESSAGE}:submitFeedback", name="SubmitMessageFeedback")
async def submit_message_feedback(
    workspace: UUID,
    conversation: str,
    message: UUID,
    body: SubmitMessageFeedbackRequest,
    ctx: Context,
    messages: Messages,
) -> ChatMessage:
    record = await messages.submit_feedback(
        ctx,
        workspace,
        conversation,
        message,
        rating=body.rating,
        reason=body.reason,
        comment=body.comment,
    )
    return chat_message(record)


# -- Shares -----------------------------------------------------------------------


@router.post(f"{_CONVERSATION}/shares", name="CreateShare")
async def create_share(
    workspace: UUID,
    conversation: str,
    body: ShareMessage,
    ctx: Context,
    shares: Shares,
    request_id: RequestId = None,
) -> ShareMessage:
    record = await shares.create(
        ctx,
        workspace,
        conversation,
        audience=body.audience,
        recipients=body.recipients or [],
        request_id=request_id,
    )
    return share_message(record)


@router.get(f"{_CONVERSATION}/shares", name="ListShares")
async def list_shares(
    workspace: UUID,
    conversation: str,
    ctx: Context,
    shares: Shares,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
) -> ListSharesResponse:
    paging = PageRequest.from_params(
        page_size, page_token, query_fingerprint(parent=conversation_name(workspace, conversation))
    )
    records, total = await shares.list(
        ctx, workspace, conversation, offset=paging.offset, limit=paging.fetch_limit
    )
    page = paging.page(records, total_size=total)
    return ListSharesResponse(
        shares=[share_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_SHARE, name="GetShare")
async def get_share(
    workspace: UUID, conversation: str, share: UUID, ctx: Context, shares: Shares
) -> ShareMessage:
    return share_message(await shares.get(ctx, workspace, conversation, share))


@router.delete(_SHARE, name="DeleteShare")
async def delete_share(
    workspace: UUID, conversation: str, share: UUID, ctx: Context, shares: Shares
) -> dict[str, object]:
    await shares.delete(ctx, workspace, conversation, share)
    return {}
