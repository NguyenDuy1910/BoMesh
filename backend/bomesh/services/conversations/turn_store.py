"""Durable turns of a server-owned conversation, as the streaming chat stores them.

The Conversation resource itself (create, scope, delete) belongs to
``bomesh.services.conversations``; this engine stores and reads the turns:
the user message (``start_turn``), the assistant answer (``finish_turn``), the
answered history the agent replays, and the resources earlier turns referenced.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.agent import ResourceRef
from bomesh.agent.models import ConversationMessage
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Conversation, Item, Message, MessageItem
from bomesh.errors import FailedPrecondition, InvalidArgument
from bomesh.iam import ItemRef, WorkspaceAccess
from bomesh.iam.visibility import is_visible
from bomesh.services.knowledge_items.item_store import ItemService

GenerationState = Literal["completed", "interrupted", "failed"]

_TITLE_LENGTH = 120


class ConversationService:
    """Persist and read turns without coupling storage to the agent loop."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def start_turn(
        self,
        conversation_id: UUID,
        *,
        access: WorkspaceAccess,
        content: str,
        attachment_ids: Sequence[UUID],
        request_id: str,
        replace_from: UUID | None = None,
    ) -> Message:
        """Store the user's message, replacing an earlier turn when asked.

        ``replace_from`` names an active user message of the conversation:
        under the conversation row lock it and every later message are
        superseded (kept, never deleted) before the new message is stored.
        """

        text = content.strip()
        async with transaction_scope(self._session_factory) as session:
            conversation = await _locked_conversation(session, conversation_id, access)
            now = datetime.now(UTC)
            if replace_from is not None:
                start = await _replaceable_sequence(session, conversation.id, replace_from)
                await session.execute(
                    update(Message)
                    .where(
                        Message.conversation_id == conversation.id,
                        Message.status == "active",
                        Message.sequence_number >= start,
                    )
                    .values(status="superseded", superseded_at=now)
                )
            message = Message(
                conversation_id=conversation.id,
                role="user",
                content=text,
                metadata_={"request_id": request_id},
                sequence_number=await _next_sequence(session, conversation.id),
            )
            session.add(message)
            conversation.last_message_at = now
            if not conversation.title:
                conversation.title = " ".join(text.split())[:_TITLE_LENGTH]
            await session.flush()
            items = ItemService(session)
            for position, attachment_id in enumerate(attachment_ids):
                await items.link_message(
                    message.id, attachment_id, "attachment", access=access, position=position
                )
            return message

    async def finish_turn(
        self,
        conversation_id: UUID,
        *,
        access: WorkspaceAccess,
        question_id: UUID,
        message_id: UUID,
        content: str,
        state: GenerationState,
        citations: Sequence[Mapping[str, Any]],
        artifact_ids: Iterable[UUID],
        request_id: str,
    ) -> Message:
        """Store the answer ``message_id`` to ``question_id``, the message ``start_turn`` stored.

        Every turn stores its answer, partial or empty, with its generation
        state. A retry or edit can supersede the question while its answer is
        still streaming; the late answer is then stored superseded too, so it
        never enters history after the replacement question.
        """

        async with transaction_scope(self._session_factory) as session:
            conversation = await session.scalar(
                select(Conversation)
                .where(
                    Conversation.id == conversation_id,
                    Conversation.tenant_id == access.workspace_id,
                    Conversation.owner_user_id == access.user_id,
                )
                .with_for_update()
            )
            if conversation is None:
                raise FailedPrecondition(f"Conversation {conversation_id} no longer exists.")
            now = datetime.now(UTC)
            question_status = await session.scalar(
                select(Message.status).where(
                    Message.id == question_id,
                    Message.conversation_id == conversation.id,
                    Message.role == "user",
                )
            )
            superseded = question_status != "active"
            message = Message(
                id=message_id,
                conversation_id=conversation.id,
                role="assistant",
                content=content.strip(),
                metadata_={"request_id": request_id, "citations": list(citations)},
                sequence_number=await _next_sequence(session, conversation.id),
                generation_state=state,
                status="superseded" if superseded else "active",
                superseded_at=now if superseded else None,
            )
            session.add(message)
            conversation.last_message_at = now
            await session.flush()
            items = ItemService(session)
            # A document the turn created or revised is the answer's artifact.
            for position, artifact_id in enumerate(dict.fromkeys(artifact_ids)):
                await items.link_message(
                    message.id, artifact_id, "artifact", access=access, position=position
                )
            return message

    async def resources(
        self,
        resource_ids: Sequence[UUID],
        *,
        access: WorkspaceAccess,
    ) -> tuple[ResourceRef, ...]:
        """Stable references for this turn's attachments (already authorized documents)."""

        async with transaction_scope(self._session_factory) as session:
            items = ItemService(session)
            return tuple(
                [
                    _resource_ref(await items.get_item(resource_id, access=access))
                    for resource_id in dict.fromkeys(resource_ids)
                ]
            )

    async def history(
        self,
        conversation_id: UUID,
        *,
        limit_messages: int,
        before_message: UUID | None = None,
    ) -> tuple[ConversationMessage, ...]:
        """Answered turns the agent may read, oldest first.

        Only active messages count, so superseded attempts never return. A
        question without an answer (stopped, failed, or still streaming) is
        skipped, and the result always starts with a question.
        ``before_message`` stops at the message a retry or edit is about to
        replace.
        """

        if limit_messages < 1:
            return ()
        async with transaction_scope(self._session_factory) as session:
            conditions = await _active_before(session, conversation_id, before_message)
            # Unanswered questions are dropped below, so read past them a little.
            rows = await session.execute(
                select(Message.role, Message.content, Message.generation_state)
                .where(*conditions)
                .order_by(Message.sequence_number.desc())
                .limit(2 * limit_messages)
            )
            newest_first = rows.all()
        return _answered_turns(reversed(newest_first), limit_messages)

    async def referenced_resources(
        self,
        conversation_id: UUID,
        *,
        access: WorkspaceAccess,
        limit: int = 10,
        before_message: UUID | None = None,
    ) -> tuple[ResourceRef, ...]:
        """Accessible resources linked by earlier turns of this conversation.

        These are the durable ``MessageItem`` links ``start_turn`` and
        ``finish_turn`` recorded: attachments and the artifacts a turn
        exported, so a follow-up can reopen them without a second search.
        Only identities the caller can still read are returned, newest
        reference first; superseded messages and the turns a retry or edit is
        about to replace (``before_message``) do not count.
        """

        if limit < 1:
            return ()
        async with transaction_scope(self._session_factory) as session:
            conditions = await _active_before(session, conversation_id, before_message)
            last_reference = func.max(Message.sequence_number)
            rows = await session.execute(
                select(Item)
                .join(MessageItem, MessageItem.item_id == Item.id)
                .join(Message, Message.id == MessageItem.message_id)
                .where(
                    *conditions,
                    MessageItem.deleted_at.is_(None),
                    Item.tenant_id == access.workspace_id,
                    Item.item_type == "document",
                    Item.deleted_at.is_(None),
                )
                .group_by(Item.id)
                .order_by(last_reference.desc(), Item.id)
                .limit(limit)
            )
            candidates = list(rows.scalars())
        # Access is re-checked now: a permission revoked after the turn that
        # referenced a document removes it from context.
        return tuple(
            [
                _resource_ref(item)
                for item in candidates
                if await is_visible(
                    access.authorizer, access.principal, ItemRef(access.workspace_id, item.id)
                )
            ]
        )


async def _locked_conversation(
    session: AsyncSession, conversation_id: UUID, access: WorkspaceAccess
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            Conversation.tenant_id == access.workspace_id,
            Conversation.owner_user_id == access.user_id,
        )
        .with_for_update()
    )
    if conversation is None or conversation.deleted_at is not None:
        raise FailedPrecondition(
            f"Conversation {conversation_id} is deleted.", reason="CONVERSATION_DELETED"
        )
    return conversation


async def _replaceable_sequence(
    session: AsyncSession, conversation_id: UUID, message_id: UUID
) -> int:
    """Sequence number of an active user message of the conversation."""

    sequence = await session.scalar(
        select(Message.sequence_number).where(
            Message.id == message_id,
            Message.conversation_id == conversation_id,
            Message.role == "user",
            Message.status == "active",
        )
    )
    if sequence is None:
        raise InvalidArgument.for_field(
            "replaceFromMessage",
            "replaceFromMessage must name an active user message of this conversation.",
        )
    return int(sequence)


async def _active_before(
    session: AsyncSession, conversation_id: UUID, before_message: UUID | None
) -> list[Any]:
    conditions: list[Any] = [
        Message.conversation_id == conversation_id,
        Message.status == "active",
    ]
    if before_message is not None:
        start = await session.scalar(
            select(Message.sequence_number).where(
                Message.id == before_message, Message.conversation_id == conversation_id
            )
        )
        if start is not None:
            conditions.append(Message.sequence_number < start)
    return conditions


async def _next_sequence(session: AsyncSession, conversation_id: UUID) -> int:
    current = await session.scalar(
        select(func.max(Message.sequence_number)).where(
            Message.conversation_id == conversation_id
        )
    )
    return int(current or 0) + 1


def _answered_turns(
    messages: Iterable[tuple[str, str, str]], limit: int
) -> tuple[ConversationMessage, ...]:
    """Pair each completed answer with its question; drop questions left unanswered."""

    turns: list[ConversationMessage] = []
    question: str | None = None
    for role, content, state in messages:
        if role == "user":
            # A later question replaces one that never got an answer.
            question = content
        elif question is not None and state == "completed" and content:
            turns.append(ConversationMessage(role="user", content=question))
            turns.append(ConversationMessage(role="assistant", content=content))
            question = None
        else:
            question = None
    selected = turns[-limit:]
    if selected and selected[0].role == "assistant":
        selected = selected[1:]
    return tuple(selected)


def _resource_ref(item: Item) -> ResourceRef:
    return ResourceRef(
        id=str(item.id),
        name=str(item.metadata_.get("file_name") or item.title),
        mime_type=item.mime_type or "application/octet-stream",
        size_bytes=item.size_bytes,
        index_status=item.index_status,
    )


__all__ = ["ConversationService", "GenerationState"]
