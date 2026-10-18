"""Minimal durable conversation/message boundary used by streaming chat."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.agent import ResourceRef
from bomesh.agent.models import ConversationMessage
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Conversation, Item, Message, MessageItem
from bomesh.services import AuthContext, DocumentNotFoundError, conversation_access_filter
from bomesh.services.identity_access.authorization import AuthorizationService
from bomesh.services.item import ItemService


class ConversationService:
    """Persist current turns without coupling storage to the agent loop."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._session_factory = session_factory

    async def start_turn(
        self,
        conversation_id: UUID,
        *,
        access: AuthContext,
        content: str,
        attachment_ids: Sequence[UUID],
        request_id: str,
        replace_from_turn: int | None = None,
    ) -> Message:
        """Store the user's message, replacing an earlier turn when asked.

        ``replace_from_turn`` is the zero-based index of an active user turn:
        that turn and every later message are superseded (kept, never deleted)
        before the new message is stored. An index equal to the number of
        active user turns appends; a larger one is rejected.
        """

        normalized_content = content.strip()
        if not normalized_content:
            raise ValueError("message content must not be blank")
        if access.tenant_id is None or access.user_id is None or access.session_id is None:
            raise DocumentNotFoundError(f"conversation not found: {conversation_id}")
        async with transaction_scope(self._session_factory) as session:
            now = datetime.now(UTC)
            await session.execute(
                insert(Conversation)
                .values(
                    id=conversation_id,
                    tenant_id=access.tenant_id,
                    owner_user_id=access.user_id,
                    created_by_session_id=access.session_id,
                    title=_title(normalized_content),
                    last_message_at=now,
                )
                .on_conflict_do_nothing(index_elements=[Conversation.id])
            )
            conversation = await session.scalar(
                select(Conversation)
                .where(Conversation.id == conversation_id)
                .with_for_update()
            )
            if conversation is None or not _can_access(conversation, access):
                raise DocumentNotFoundError(
                    f"conversation not found: {conversation_id}"
                )
            if replace_from_turn is not None:
                await _supersede_from_turn(
                    session, conversation.id, replace_from_turn, at=now
                )
            sequence = await _next_sequence(session, conversation.id)
            message = Message(
                conversation_id=conversation.id,
                role="user",
                content=normalized_content,
                metadata_={"request_id": request_id},
                sequence_number=sequence,
            )
            session.add(message)
            conversation.last_message_at = now
            await session.flush()
            items = ItemService(session)
            for position, attachment_id in enumerate(attachment_ids):
                await items.link_message(
                    message.id,
                    attachment_id,
                    "attachment",
                    access=access,
                    position=position,
                )
            return message

    async def finish_turn(
        self,
        conversation_id: UUID,
        *,
        access: AuthContext,
        question_id: UUID,
        content: str,
        referenced_document_ids: Iterable[UUID],
        request_id: str,
        artifact_ids: Iterable[UUID] = (),
    ) -> Message | None:
        """Store the answer to ``question_id``, the message ``start_turn`` stored.

        A retry or edit can supersede the question while its answer is still
        streaming; the late answer is then kept superseded too, so it never
        enters history after the replacement question.
        """

        normalized_content = content.strip()
        if not normalized_content:
            return None
        if access.tenant_id is None:
            raise DocumentNotFoundError(f"conversation not found: {conversation_id}")
        unique_references = list(dict.fromkeys(referenced_document_ids))
        unique_artifacts = list(dict.fromkeys(artifact_ids))
        async with transaction_scope(self._session_factory) as session:
            conversation = await session.scalar(
                select(Conversation)
                .where(
                    Conversation.id == conversation_id,
                    Conversation.tenant_id == access.tenant_id,
                    conversation_access_filter(access),
                    Conversation.status == "active",
                )
                .with_for_update()
            )
            if conversation is None:
                raise DocumentNotFoundError(
                    f"conversation not found: {conversation_id}"
                )
            now = datetime.now(UTC)
            question_status = await session.scalar(
                select(Message.status).where(
                    Message.id == question_id,
                    Message.conversation_id == conversation.id,
                    Message.role == "user",
                )
            )
            superseded = question_status != "active"
            sequence = await _next_sequence(session, conversation.id)
            message = Message(
                conversation_id=conversation.id,
                role="assistant",
                content=normalized_content,
                metadata_={"request_id": request_id},
                sequence_number=sequence,
                status="superseded" if superseded else "active",
                superseded_at=now if superseded else None,
            )
            session.add(message)
            conversation.last_message_at = now
            await session.flush()
            items = ItemService(session)
            for position, document_id in enumerate(unique_references):
                await items.link_message(
                    message.id,
                    document_id,
                    "reference",
                    access=access,
                    position=position,
                )
            # A document the turn created or revised is the answer's output.
            for position, artifact_id in enumerate(unique_artifacts):
                await items.link_message(
                    message.id,
                    artifact_id,
                    "output",
                    access=access,
                    position=position,
                )
            return message

    async def resources(
        self,
        resource_ids: Sequence[UUID],
        *,
        access: AuthContext,
    ) -> tuple[ResourceRef, ...]:
        """Return stable references for resources available to this turn."""

        if access.tenant_id is None:
            return ()
        async with transaction_scope(self._session_factory) as session:
            items = ItemService(session)
            result: list[ResourceRef] = []
            for resource_id in dict.fromkeys(resource_ids):
                item = await items.get_item(resource_id, access=access)
                if item.item_type != "document":
                    raise DocumentNotFoundError(f"resource not found: {resource_id}")
                result.append(_resource_ref(item))
            return tuple(result)

    async def history(
        self,
        conversation_id: UUID,
        *,
        access: AuthContext,
        limit_messages: int,
        before_turn: int | None = None,
    ) -> tuple[ConversationMessage, ...]:
        """Answered turns the agent may read, oldest first.

        Only active messages count, so superseded attempts never return. A
        question without an answer (stopped, failed, or still streaming) is
        skipped, and the result always starts with a question. ``before_turn``
        stops at that zero-based active user turn: the turn a retry or edit is
        about to replace. An unknown conversation is new and has no history; one
        the caller cannot read is not found, as in ``start_turn``.
        """

        if access.tenant_id is None or limit_messages < 1:
            return ()
        async with transaction_scope(self._session_factory) as session:
            conversation = await session.scalar(
                select(Conversation).where(Conversation.id == conversation_id)
            )
            if conversation is None:
                return ()
            if not _can_access(conversation, access):
                raise DocumentNotFoundError(f"conversation not found: {conversation_id}")
            conditions = [
                Message.conversation_id == conversation_id,
                Message.status == "active",
            ]
            if before_turn is not None:
                start = await _turn_start(session, conversation_id, before_turn)
                if start is not None:
                    conditions.append(Message.sequence_number < start)
            # Unanswered questions are dropped below, so read past them a little.
            rows = await session.execute(
                select(Message.role, Message.content)
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
        access: AuthContext,
        limit: int = 10,
        before_turn: int | None = None,
    ) -> tuple[ResourceRef, ...]:
        """Accessible resources linked by earlier turns of this conversation.

        These are the durable ``MessageItem`` links ``start_turn`` and
        ``finish_turn`` recorded. Explicit artifact ``output`` links are also
        resources: a follow-up can reopen a document that the prior turn
        deliberately exported, without duplicating its bytes in conversation
        state. Only identities the caller can still read are returned, newest
        reference first, so a follow-up such as "fill that form for me" can
        resolve the Document ID without a second search and without ever
        leaking a since-revoked title. Superseded messages do not count, and
        ``before_turn`` (as in ``history``) leaves out the turns a retry or
        edit is about to replace.
        """

        if access.tenant_id is None or limit < 1:
            return ()
        async with transaction_scope(self._session_factory) as session:
            conditions = [Message.conversation_id == conversation_id, Message.status == "active"]
            if before_turn is not None:
                start = await _turn_start(session, conversation_id, before_turn)
                if start is not None:
                    conditions.append(Message.sequence_number < start)
            last_reference = func.max(Message.sequence_number)
            rows = await session.execute(
                select(Item)
                .join(MessageItem, MessageItem.item_id == Item.id)
                .join(Message, Message.id == MessageItem.message_id)
                .join(Conversation, Conversation.id == Message.conversation_id)
                .where(
                    *conditions,
                    Conversation.tenant_id == access.tenant_id,
                    conversation_access_filter(access),
                    MessageItem.relation_type.in_(("attachment", "reference", "output")),
                    MessageItem.deleted_at.is_(None),
                    Item.tenant_id == access.tenant_id,
                    Item.item_type == "document",
                    Item.status != "deleted",
                    Item.deleted_at.is_(None),
                )
                .group_by(Item.id)
                .order_by(last_reference.desc(), Item.id)
                .limit(limit)
            )
            candidates = list(rows.scalars())
            # Access is re-checked at read time: a Collection permission
            # revoked after the turn that referenced a document must remove
            # it from context, not merely fail later tool calls.
            collections = AuthorizationService(session)
            allowed = set(await collections.allowed_collection_ids(access))
            references: list[ResourceRef] = []
            for item in candidates:
                collection_id = await collections.governing_collection_id(
                    item.id, tenant_id=access.tenant_id
                )
                if collection_id is None or collection_id not in allowed:
                    continue
                references.append(_resource_ref(item))
            return tuple(references)


async def _next_sequence(session: AsyncSession, conversation_id: UUID) -> int:
    current = await session.scalar(
        select(func.max(Message.sequence_number)).where(
            Message.conversation_id == conversation_id
        )
    )
    return int(current or 0) + 1


async def _turn_start(session: AsyncSession, conversation_id: UUID, turn: int) -> int | None:
    """Sequence number of the zero-based active user turn, if it exists."""

    return await session.scalar(
        select(Message.sequence_number)
        .where(
            Message.conversation_id == conversation_id,
            Message.role == "user",
            Message.status == "active",
        )
        .order_by(Message.sequence_number)
        .offset(turn)
        .limit(1)
    )


async def _supersede_from_turn(
    session: AsyncSession, conversation_id: UUID, turn: int, *, at: datetime
) -> None:
    """Supersede a user turn and everything after it; caller holds the row lock."""

    start = await _turn_start(session, conversation_id, turn)
    if start is None:
        active_turns = await session.scalar(
            select(func.count()).where(
                Message.conversation_id == conversation_id,
                Message.role == "user",
                Message.status == "active",
            )
        )
        # Replacing the turn right after the last one is appending.
        if turn > int(active_turns or 0):
            raise ValueError(
                f"replace_from_turn {turn} is beyond the conversation's "
                f"{int(active_turns or 0)} turns"
            )
        return
    await session.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.status == "active",
            Message.sequence_number >= start,
        )
        .values(status="superseded", superseded_at=at)
    )


def _answered_turns(
    messages: Iterable[tuple[str, str]], limit: int
) -> tuple[ConversationMessage, ...]:
    """Pair each answer with its question; drop questions left unanswered."""

    turns: list[ConversationMessage] = []
    question: str | None = None
    for role, content in messages:
        if role == "user":
            # A later question replaces one that never got an answer.
            question = content
        elif role == "assistant" and question is not None:
            turns.append(ConversationMessage(role="user", content=question))
            turns.append(ConversationMessage(role="assistant", content=content))
            question = None
    selected = turns[-limit:]
    if selected and selected[0].role == "assistant":
        selected = selected[1:]
    return tuple(selected)


def _title(content: str) -> str:
    normalized = " ".join(content.split())
    return normalized[:120]


def _can_access(conversation: Conversation, access: AuthContext) -> bool:
    if conversation.tenant_id != access.tenant_id or conversation.status != "active":
        return False
    return access.user_id is not None and conversation.owner_user_id == access.user_id


def _resource_ref(item: Item) -> ResourceRef:
    return ResourceRef(
        id=str(item.id),
        name=str(item.metadata_.get("file_name") or item.title),
        mime_type=item.mime_type or "application/octet-stream",
        size_bytes=item.size_bytes,
        index_status=item.index_status,
    )


__all__ = ["ConversationService"]
