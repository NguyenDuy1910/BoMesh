"""Assistant messages, conversation part (``openapi.yaml`` tag Assistant), and their field maps.

``ChatMessage`` is the contract ``Message`` (the name avoids ``MessageMessage``).
``sse_frame`` renders one turn event as a Server-Sent Event.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import ColumnElement, exists, func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.agent import AgentStreamEvent
from bomesh.db.models import Conversation, Item, Message, MessageCitation
from bomesh.services.conversations.records import (
    CitationRecord,
    ConversationRecord,
    FeedbackRecord,
    MessageRecord,
)
from bomesh.services.conversations.references import parse_conversation_name
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.workspaces.records import member_name

Role = Literal["USER", "ASSISTANT"]


# -- Conversations --------------------------------------------------------------


class ConversationScopeMessage(ProtoMessage):
    collections: list[str] | None = None
    spaces: list[str] | None = None


class OutdatedSourceMessage(ProtoMessage):
    """An entry of ``Conversation.outdatedSources``."""

    item: str
    display_name: str | None = None
    update_time: Timestamp | None = None


class ConversationMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    owner: str | None = None
    pinned: bool | None = None
    scope: ConversationScopeMessage | None = None
    last_message_time: Timestamp | None = None
    last_answer_snippet: str | None = None
    outdated_sources: list[OutdatedSourceMessage] | None = None
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
        last_answer_snippet=record.last_answer_snippet,
        outdated_sources=[
            OutdatedSourceMessage(
                item=source.item,
                display_name=source.display_name,
                update_time=source.update_time,
            )
            for source in record.outdated_sources
        ]
        if record.outdated_sources is not None
        else None,
        create_time=record.created_at,
        update_time=record.updated_at,
        delete_time=record.deleted_at,
        purge_time=record.purge_at,
    )


CONVERSATION_FIELDS = MutableFields(("displayName", "pinned", "scope.collections", "scope.spaces"))


def conversation_filters(workspace_id: UUID) -> FilterSchema:
    """ListConversations; ``name`` batch-reads (names not listed are simply absent)."""
    return FilterSchema(
        {
            "name": filtering.resource_name(
                Conversation.code,
                lambda name: parse_conversation_name(name, workspace_id, field="filter"),
            ),
            "pinned": filtering.boolean(Conversation.pinned),
            "displayName": filtering.string(Conversation.conversation_name),
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
    outdated: bool | None = None
    update_time: Timestamp | None = None


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
    available: bool | None = None


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
        outdated=record.outdated,
        update_time=record.update_time,
    )


def chat_message(record: MessageRecord) -> ChatMessage:
    if not record.available:
        return ChatMessage(
            name=record.name,
            role=record.role,
            state=record.state,
            create_time=record.created_at,
            available=False,
        )
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


def message_filters(workspace_id: UUID) -> FilterSchema:
    """ListMessages: ``role``, ``state`` and ``citations.item`` (cites a live item)."""

    def cites(item_id: UUID) -> ColumnElement[bool]:
        return exists().where(
            MessageCitation.message_id == Message.id,
            MessageCitation.item_id == item_id,
            Item.id == MessageCitation.item_id,
            Item.deleted_at.is_(None),
        )

    return FilterSchema(
        {
            "role": filtering.enum(func.upper(Message.role), ("USER", "ASSISTANT")),
            "state": filtering.enum(
                func.upper(Message.generation_state), ("COMPLETED", "INTERRUPTED", "FAILED")
            ),
            "citations.item": filtering.repeated(
                filtering.resource_name(
                    Message.id, lambda name: parse_item(name, workspace_id, field="filter")
                ),
                has=cites,
            ),
        }
    )


MESSAGE_ORDER = OrderSchema(
    # Conversation order: the sequence breaks ties between equal timestamps.
    {"createTime": Message.sequence_number},
    tie_breaker=[Message.id],
    default="createTime",
)


# -- Converse stream ------------------------------------------------------------


def sse_frame(event: AgentStreamEvent) -> str:
    """One Server-Sent Event: the OpenResponses event type and its JSON payload."""
    return f"event: {event.type}\ndata: {event.model_dump_json(exclude_none=True)}\n\n"
