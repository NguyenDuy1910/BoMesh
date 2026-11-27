"""Messages (``…/conversations/{c}/messages/{m}``): list, get and feedback.

``ListMessages`` returns the active turns; superseded attempts stay
addressable by name (variants keep their own feedback). Citations are
re-checked for the reader on every read.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Conversation, Message, MessageItem
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.conversations.citations import (
    citation_record,
    current_revisions,
    message_citations,
    readable_source,
)
from bomesh.services.conversations.conversations import (
    load_conversation,
    readable_conversation,
    require_live,
)
from bomesh.services.conversations.records import (
    FeedbackRecord,
    MessageRecord,
    message_name,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.knowledge_items.summary import get_item_summaries

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

MAX_FEEDBACK_REASON = 64
MAX_FEEDBACK_COMMENT = 4000

FeedbackRating = Literal["HELPFUL", "UNHELPFUL", "RATING_UNSPECIFIED"]


class MessageService:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver()

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> MessageService:
        return cls(runtime.sessions())

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> tuple[list[MessageRecord], int]:
        """Active messages of the caller's conversation (or one shared with them), and their total."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "messages.list", write=False)
        async with transaction_scope(self._sessions) as session:
            conversation, owner = await readable_conversation(session, ctx, workspace_id, code)
            statement = _active(conversation.id)
            rows = list(await session.scalars(query.apply(statement)))
            total = int(await session.scalar(query.count(statement)) or 0)
            return await _records(session, ctx, conversation, rows, owner=owner), total

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, message_id: UUID
    ) -> MessageRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "messages.get", write=False)
        async with transaction_scope(self._sessions) as session:
            conversation, owner = await readable_conversation(session, ctx, workspace_id, code)
            row = await _message(session, conversation, message_id)
            return (await _records(session, ctx, conversation, [row], owner=owner))[0]

    async def submit_feedback(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        message_id: UUID,
        *,
        rating: FeedbackRating,
        reason: str | None,
        comment: str | None,
    ) -> MessageRecord:
        """Rate an assistant message; ``RATING_UNSPECIFIED`` clears every feedback field."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "messages.submitFeedback", write=True
        )
        reason, comment = _bounded(reason, MAX_FEEDBACK_REASON, "reason"), _bounded(
            comment, MAX_FEEDBACK_COMMENT, "comment"
        )
        async with transaction_scope(self._sessions) as session:
            conversation = require_live(await load_conversation(session, ctx, workspace_id, code))
            row = await _message(session, conversation, message_id, for_update=True)
            if row.role != "assistant":
                raise FailedPrecondition("Only assistant messages can be rated.")
            if rating == "RATING_UNSPECIFIED":
                row.feedback_rating = row.feedback_reason = row.feedback_comment = None
                row.feedback_at = None
            else:
                row.feedback_rating = rating.lower()
                row.feedback_reason = reason
                row.feedback_comment = comment
                row.feedback_at = datetime.now(UTC)
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="SubmitMessageFeedback",
                target=message_name(workspace_id, code, message_id),
                details={"rating": rating},
            )
            return (await _records(session, ctx, conversation, [row]))[0]


def _active(conversation_id: UUID) -> Select[tuple[Message]]:
    return select(Message).where(
        Message.conversation_id == conversation_id, Message.superseded_at.is_(None)
    )


async def _message(
    session: AsyncSession, conversation: Conversation, message_id: UUID, *, for_update: bool = False
) -> Message:
    statement = select(Message).where(
        Message.id == message_id, Message.conversation_id == conversation.id
    )
    if for_update:
        statement = statement.with_for_update()
    row = await session.scalar(statement)
    if row is None:
        name = message_name(conversation.tenant_id, conversation.code, message_id)
        raise NotFound(f"Resource '{name}' was not found.")
    return row


async def _records(
    session: AsyncSession,
    ctx: RequestContext,
    conversation: Conversation,
    rows: Sequence[Message],
    *,
    owner: bool = True,
) -> list[MessageRecord]:
    """``rows`` for the caller; a shared reader (``owner=False``) never sees feedback,
    and a turn citing a source they cannot read now is withheld (``available=False``)."""
    artifacts = await _artifacts(session, [row.id for row in rows])
    stored = await message_citations(session, (row.id for row in rows))
    summaries = await get_item_summaries(
        session,
        ctx.authorizer,
        ctx.principal,
        conversation.tenant_id,
        (citation.item_id for citations in stored.values() for citation in citations),
    )
    current = await current_revisions(session, summaries)
    records: list[MessageRecord] = []
    for row in rows:
        cited = stored.get(row.id, ())
        available = owner or all(readable_source(summaries, c.item_id) for c in cited)
        records.append(
            MessageRecord(
                workspace_id=conversation.tenant_id,
                conversation_code=conversation.code,
                id=row.id,
                role="ASSISTANT" if row.role == "assistant" else "USER",
                text=row.content if available else "",
                citations=tuple(
                    citation_record(conversation.tenant_id, citation, summaries, current=current)
                    for citation in cited
                )
                if available
                else (),
                artifacts=artifacts.get(row.id, ()) if available else (),
                state=row.generation_state.upper(),  # type: ignore[arg-type]
                feedback=_feedback(row) if owner else None,
                created_at=row.created_at,
                available=available,
            )
        )
    return records


async def _artifacts(session: AsyncSession, message_ids: Sequence[UUID]) -> dict[UUID, tuple[UUID, ...]]:
    if not message_ids:
        return {}
    rows = await session.execute(
        select(MessageItem.message_id, MessageItem.item_id)
        .where(
            MessageItem.message_id.in_(message_ids),
            MessageItem.relation_type == "artifact",
            MessageItem.deleted_at.is_(None),
        )
        .order_by(MessageItem.message_id, MessageItem.position)
    )
    grouped: dict[UUID, list[UUID]] = defaultdict(list)
    for message_id, item_id in rows:
        grouped[message_id].append(item_id)
    return {key: tuple(values) for key, values in grouped.items()}


def _feedback(row: Message) -> FeedbackRecord | None:
    if row.feedback_rating is None:
        return None
    return FeedbackRecord(
        rating="HELPFUL" if row.feedback_rating == "helpful" else "UNHELPFUL",
        reason=row.feedback_reason,
        comment=row.feedback_comment,
        created_at=row.feedback_at,
    )


def _bounded(value: str | None, limit: int, field: str) -> str | None:
    text = (value or "").strip()
    if len(text) > limit:
        raise InvalidArgument.for_field(field, f"{field} must be at most {limit} characters.")
    return text or None


__all__ = ["FeedbackRating", "MessageService"]
