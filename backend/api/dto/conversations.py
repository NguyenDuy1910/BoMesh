"""Assistant messages, conversation part (``openapi.yaml`` tag Assistant), and their field maps.

``ChatMessage`` is the contract ``Message`` (the name avoids ``MessageMessage``).
``sse_frame`` renders one turn event as a Server-Sent Event.
"""

from __future__ import annotations

from typing import Literal

from sqlalchemy import func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.agent import AgentStreamEvent
from bomesh.db.models import Conversation, Message
from bomesh.services.conversations.records import (
    CitationRecord,
    ConversationRecord,
    FeedbackRecord,
    MessageRecord,
    ShareRecord,
    SnapshotMessageRecord,
)
from bomesh.services.workspaces.records import member_name

Role = Literal["USER", "ASSISTANT"]


# -- Conversations --------------------------------------------------------------


class ConversationScopeMessage(ProtoMessage):
    collections: list[str] | None = None
    spaces: list[str] | None = None


class ConversationMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    owner: str | None = None
    pinned: bool | None = None
    scope: ConversationScopeMessage | None = None
    last_message_time: Timestamp | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None


class ListConversationsResponse(ProtoMessage):
    conversations: list[ConversationMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class UndeleteConversationRequest(ProtoMessage):
    pass


class ConverseRequest(ProtoMessage):
    message: str
    attachments: list[str] | None = None
    replace_from_message: str | None = None


def conversation_message(record: ConversationRecord) -> ConversationMessage:
    return ConversationMessage(
        name=record.name,
        display_name=record.display_name,
        owner=member_name(record.workspace_id, record.owner_user_id),
        pinned=record.pinned,
        scope=ConversationScopeMessage(
            collections=list(record.scope_collections), spaces=list(record.scope_spaces)
        ),
        last_message_time=record.last_message_at,
        create_time=record.created_at,
        update_time=record.updated_at,
        delete_time=record.deleted_at,
        purge_time=record.purge_at,
    )


CONVERSATION_FIELDS = MutableFields(("displayName", "pinned", "scope.collections", "scope.spaces"))
CONVERSATION_FILTERS = FilterSchema(
    {
        "pinned": filtering.boolean(Conversation.pinned),
        "displayName": filtering.string(Conversation.title),
        "lastMessageTime": filtering.timestamp(Conversation.last_message_at),
    }
)
CONVERSATION_ORDER = OrderSchema(
    {
        # A conversation without messages sorts by when it was created.
        "lastMessageTime": func.coalesce(Conversation.last_message_at, Conversation.created_at),
        "createTime": Conversation.created_at,
        "updateTime": Conversation.updated_at,
    },
    tie_breaker=[Conversation.id],
    default="lastMessageTime desc",
)


# -- Messages -------------------------------------------------------------------


class CitationMessage(ProtoMessage):
    """The contract ``Citation``; unavailable → only ``available``."""

    passage: str | None = None
    item: str | None = None
    display_name: str | None = None
    page_number: int | None = None
    excerpt: str | None = None
    available: bool


class MessageFeedbackMessage(ProtoMessage):
    rating: Literal["HELPFUL", "UNHELPFUL"]
    reason: str | None = None
    comment: str | None = None
    create_time: Timestamp | None = None


class ChatMessage(ProtoMessage):
    name: str | None = None
    role: Role | None = None
    text: str | None = None
    citations: list[CitationMessage] | None = None
    artifacts: list[str] | None = None
    state: Literal["COMPLETED", "INTERRUPTED", "FAILED"] | None = None
    feedback: MessageFeedbackMessage | None = None
    create_time: Timestamp | None = None


class ListMessagesResponse(ProtoMessage):
    messages: list[ChatMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class SubmitMessageFeedbackRequest(ProtoMessage):
    rating: Literal["HELPFUL", "UNHELPFUL", "RATING_UNSPECIFIED"]
    reason: str | None = None
    comment: str | None = None


def citation_message(record: CitationRecord) -> CitationMessage:
    return CitationMessage(
        passage=record.passage,
        item=record.item,
        display_name=record.display_name,
        page_number=record.page_number,
        excerpt=record.excerpt,
        available=record.available,
    )


def chat_message(record: MessageRecord) -> ChatMessage:
    return ChatMessage(
        name=record.name,
        role=record.role,
        text=record.text,
        citations=[citation_message(citation) for citation in record.citations],
        artifacts=list(record.artifact_names),
        state=record.state,
        feedback=_feedback(record.feedback) if record.feedback is not None else None,
        create_time=record.created_at,
    )


def _feedback(record: FeedbackRecord) -> MessageFeedbackMessage:
    return MessageFeedbackMessage(
        rating=record.rating,
        reason=record.reason,
        comment=record.comment,
        create_time=record.created_at,
    )


MESSAGE_FILTERS = FilterSchema(
    {
        "role": filtering.enum(func.upper(Message.role), ("USER", "ASSISTANT")),
        "state": filtering.enum(
            func.upper(Message.generation_state), ("COMPLETED", "INTERRUPTED", "FAILED")
        ),
    }
)
MESSAGE_ORDER = OrderSchema(
    # Conversation order: the sequence breaks ties between equal timestamps.
    {"createTime": Message.sequence_number},
    tie_breaker=[Message.id],
    default="createTime",
)


# -- Shares ---------------------------------------------------------------------


class ShareSnapshotMessageMessage(ProtoMessage):
    role: Role
    text: str | None = None
    citations: list[CitationMessage] | None = None
    available: bool


class ShareSnapshotMessage(ProtoMessage):
    display_name: str | None = None
    messages: list[ShareSnapshotMessageMessage] | None = None
    snapshot_time: Timestamp | None = None


class ShareMessage(ProtoMessage):
    name: str | None = None
    audience: Literal["WORKSPACE", "PEOPLE"]
    recipients: list[str] | None = None
    uri: str | None = None
    snapshot: ShareSnapshotMessage | None = None
    create_time: Timestamp | None = None


class ListSharesResponse(ProtoMessage):
    shares: list[ShareMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def share_message(record: ShareRecord) -> ShareMessage:
    snapshot = record.snapshot
    return ShareMessage(
        name=record.name,
        audience=record.audience,
        recipients=[member_name(record.workspace_id, user) for user in record.recipients],
        uri=record.uri,
        snapshot=ShareSnapshotMessage(
            display_name=snapshot.display_name,
            messages=[_snapshot_message(message) for message in snapshot.messages],
            snapshot_time=snapshot.snapshot_time,
        ),
        create_time=record.created_at,
    )


def _snapshot_message(record: SnapshotMessageRecord) -> ShareSnapshotMessageMessage:
    if not record.available:
        return ShareSnapshotMessageMessage(role=record.role, available=False)
    return ShareSnapshotMessageMessage(
        role=record.role,
        text=record.text,
        citations=[citation_message(citation) for citation in record.citations],
        available=True,
    )


# -- Converse stream ------------------------------------------------------------


def sse_frame(event: AgentStreamEvent) -> str:
    """One Server-Sent Event: the OpenResponses event type and its JSON payload."""
    return f"event: {event.type}\ndata: {event.model_dump_json(exclude_none=True)}\n\n"
