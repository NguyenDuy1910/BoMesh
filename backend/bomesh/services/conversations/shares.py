"""Shares (``…/conversations/{c}/shares/{s}``): one live share per conversation.

The snapshot is taken from the stored turns at share time and re-filtered for
every reader: an assistant turn citing an item the reader cannot read now is
withheld, and so is any citation the reader cannot open.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Conversation,
    ConversationShare,
    ConversationShareRecipient,
    Message,
)
from bomesh.db.models.assistant import MAX_SHARE_MESSAGES
from bomesh.errors import (
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.conversations.citations import (
    citation_record,
    readable_source,
    readable_summaries,
    unreadable_items,
)
from bomesh.services.conversations.conversations import (
    live_conversation,
    load_conversation,
)
from bomesh.services.conversations.records import (
    Audience,
    ShareRecord,
    SnapshotMessageRecord,
    SnapshotRecord,
    StoredCitation,
    conversation_name,
    share_name,
    stored_citations,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.workspaces.members import active_member_ids
from bomesh.services.workspaces.records import parse_member_name

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

_UNTITLED = "Shared conversation"


class ShareService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> ShareService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        audience: Audience,
        recipients: Sequence[str],
        request_id: UUID | None,
    ) -> ShareRecord:
        """Snapshot the conversation for ``audience``, revoking its previous share.

        Refused (AUDIENCE_CANNOT_READ_SOURCES) when some audience member
        cannot read an item the shared turns cite.
        """
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.create", write=True)
        recipient_ids = _recipients(audience, recipients, workspace_id)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateShare",
                    parent=conversation_name(workspace_id, code),
                    request={"audience": audience, "recipients": list(recipients)},
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    conversation = await load_conversation(session, ctx, workspace_id, code)
                    share = await _share(session, conversation, UUID(replayed.rsplit("/", 1)[-1]))
                    return await _render(session, ctx, conversation, share)
            conversation = await live_conversation(session, ctx, workspace_id, code)
            members = await active_member_ids(session, workspace_id)
            if not recipient_ids <= members:
                raise FailedPrecondition(
                    "Every recipient must be an active member of the workspace.",
                    reason="NOT_WORKSPACE_MEMBER",
                )
            snapshot = await _snapshot(session, conversation.id)
            cited = {
                UUID(value) for turn in snapshot for value in turn["source_item_ids"]
            }
            audience_ids = members if audience == "WORKSPACE" else recipient_ids
            if await unreadable_items(ctx.authorizer, workspace_id, audience_ids, cited):
                raise FailedPrecondition(
                    "Some people in the audience cannot read every source the shared answers cite.",
                    reason="AUDIENCE_CANNOT_READ_SOURCES",
                )
            now = datetime.now(UTC)
            await session.execute(
                update(ConversationShare)
                .where(
                    ConversationShare.conversation_id == conversation.id,
                    ConversationShare.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            share = ConversationShare(
                tenant_id=workspace_id,
                conversation_id=conversation.id,
                owner_user_id=ctx.user_id,
                audience=audience.lower(),
                title=conversation.title or _UNTITLED,
                snapshot={"messages": snapshot},
                message_count=len(snapshot),
                created_at=now,
            )
            session.add(share)
            await session.flush()
            session.add_all(
                ConversationShareRecipient(share_id=share.id, user_id=user_id)
                for user_id in sorted(recipient_ids)
            )
            await session.flush()
            name = share_name(workspace_id, code, share.id)
            await _audit(session, ctx, workspace_id, "CreateShare", name, audience)
            if key is not None:
                await idempotency.remember(key, name)
            return await _render(session, ctx, conversation, share)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, offset: int, limit: int
    ) -> tuple[list[ShareRecord], int]:
        """The live shares of the caller's conversation (at most one)."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.list", write=False)
        async with transaction_scope(self._sessions) as session:
            conversation = await load_conversation(session, ctx, workspace_id, code)
            live = select(ConversationShare).where(
                ConversationShare.conversation_id == conversation.id,
                ConversationShare.revoked_at.is_(None),
            )
            rows = await session.scalars(
                live.order_by(ConversationShare.created_at.desc(), ConversationShare.id)
                .offset(offset)
                .limit(limit)
            )
            total = await session.scalar(select(func.count()).select_from(live.subquery()))
            return [await _render(session, ctx, conversation, row) for row in rows], int(total or 0)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, share_id: UUID
    ) -> ShareRecord:
        """The share rendered for the caller: its owner or its audience."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.get", write=False)
        async with transaction_scope(self._sessions) as session:
            conversation = await session.scalar(
                select(Conversation).where(
                    Conversation.tenant_id == workspace_id,
                    Conversation.code == code,
                    Conversation.deleted_at.is_(None),
                )
            )
            name = share_name(workspace_id, code, share_id)
            if conversation is None:
                raise NotFound(f"Resource '{name}' was not found.")
            share = await _share(session, conversation, share_id)
            if conversation.owner_user_id != ctx.user_id and not await _in_audience(
                session, share, ctx.user_id
            ):
                raise PermissionDenied(f"Share '{name}' was not shared with you.")
            return await _render(session, ctx, conversation, share)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, share_id: UUID
    ) -> None:
        """Revoke the share permanently."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            conversation = await load_conversation(session, ctx, workspace_id, code)
            share = await _share(session, conversation, share_id, for_update=True)
            share.revoked_at = datetime.now(UTC)
            await session.flush()
            await _audit(
                session,
                ctx,
                workspace_id,
                "DeleteShare",
                share_name(workspace_id, code, share_id),
                share.audience.upper(),
            )


def _recipients(audience: Audience, recipients: Sequence[str], workspace_id: UUID) -> set[UUID]:
    if audience == "PEOPLE" and not recipients:
        raise InvalidArgument.for_field("recipients", "recipients is required for audience PEOPLE.")
    if audience == "WORKSPACE" and recipients:
        raise InvalidArgument.for_field(
            "recipients", "recipients is only used with audience PEOPLE."
        )
    return {parse_member_name(name, workspace_id, field="recipients") for name in recipients}


async def _snapshot(session: AsyncSession, conversation_id: UUID) -> list[dict[str, Any]]:
    """The newest active turns with text, oldest first (at most ``MAX_SHARE_MESSAGES``)."""
    rows = await session.scalars(
        select(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.status == "active",
            Message.content != "",
        )
        .order_by(Message.sequence_number.desc())
        .limit(MAX_SHARE_MESSAGES)
    )
    turns: list[dict[str, Any]] = []
    for row in reversed(list(rows)):
        citations = stored_citations(row.metadata_) if row.role == "assistant" else ()
        turns.append(
            {
                "role": row.role,
                "content": row.content,
                "source_item_ids": sorted({str(c.item_id) for c in citations}),
                "citations": [citation.to_json() for citation in citations],
            }
        )
    return turns


async def _share(
    session: AsyncSession, conversation: Conversation, share_id: UUID, *, for_update: bool = False
) -> ConversationShare:
    statement = select(ConversationShare).where(
        ConversationShare.id == share_id,
        ConversationShare.conversation_id == conversation.id,
        ConversationShare.revoked_at.is_(None),
    )
    if for_update:
        statement = statement.with_for_update()
    share = await session.scalar(statement)
    if share is None:
        name = share_name(conversation.tenant_id, conversation.code, share_id)
        raise NotFound(f"Resource '{name}' was not found.")
    return share


async def _in_audience(session: AsyncSession, share: ConversationShare, user_id: UUID) -> bool:
    """WORKSPACE: every member (the caller holds ``shares.get``); PEOPLE: the recipients."""
    if share.audience == "workspace":
        return True
    return (
        await session.get(ConversationShareRecipient, {"share_id": share.id, "user_id": user_id})
        is not None
    )


async def _render(
    session: AsyncSession, ctx: RequestContext, conversation: Conversation, share: ConversationShare
) -> ShareRecord:
    workspace_id = conversation.tenant_id
    turns = [
        (turn, tuple(StoredCitation.from_json(value) for value in turn.get("citations") or ()))
        for turn in share.snapshot.get("messages") or ()
    ]
    summaries = await readable_summaries(
        session,
        ctx.authorizer,
        ctx.principal,
        workspace_id,
        (
            *(UUID(value) for turn, _ in turns for value in turn.get("source_item_ids") or ()),
            *(citation.item_id for _, citations in turns for citation in citations),
        ),
    )
    messages: list[SnapshotMessageRecord] = []
    for turn, citations in turns:
        role = "ASSISTANT" if turn.get("role") == "assistant" else "USER"
        sources = {UUID(value) for value in turn.get("source_item_ids") or ()}
        if not all(readable_source(summaries, source) for source in sources):
            messages.append(SnapshotMessageRecord(role=role, available=False))
            continue
        messages.append(
            SnapshotMessageRecord(
                role=role,
                available=True,
                text=str(turn.get("content") or ""),
                citations=tuple(
                    citation_record(workspace_id, citation, summaries) for citation in citations
                ),
            )
        )
    recipients = await session.scalars(
        select(ConversationShareRecipient.user_id)
        .where(ConversationShareRecipient.share_id == share.id)
        .order_by(ConversationShareRecipient.user_id)
    )
    return ShareRecord(
        workspace_id=workspace_id,
        conversation_code=conversation.code,
        id=share.id,
        audience="WORKSPACE" if share.audience == "workspace" else "PEOPLE",
        recipients=tuple(recipients),
        snapshot=SnapshotRecord(
            display_name=share.title, messages=tuple(messages), snapshot_time=share.created_at
        ),
        created_at=share.created_at,
    )


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    action: str,
    target: str,
    audience: str,
) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=workspace_id,
        category="knowledge",
        action=action,
        target=target,
        details={"audience": audience},
    )


__all__ = ["ShareService"]
