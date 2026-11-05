"""Conversations (``workspaces/{w}/conversations/{c}``): CRUD, undelete and the converse turn.

Conversations are owner-private: every method needs its workspace permission,
then a conversation owned by someone else is PERMISSION_DENIED.
"""

from __future__ import annotations

from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Iterable,
    Mapping,
    Sequence,
)
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.agent import AgentStreamEvent
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Conversation, Message
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.collaboration.membership import space_codes
from bomesh.services.collaboration.records import space_name
from bomesh.services.conversations.chat import ChatService, TurnRequest
from bomesh.services.conversations.records import (
    ConversationRecord,
    conversation_name,
    message_name,
)
from bomesh.services.conversations.references import CONVERSATION_ID, parse_message_name
from bomesh.services.conversations.scope import (
    require_attachments,
    require_scope,
    retrieval_roots,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import require_restorable
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.workspaces.settings import assistant_settings

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

MAX_DISPLAY_NAME = 512
_ANSWER_LENGTH_GUIDANCE = {
    "concise": "Keep answers short: lead with the answer and only the essential detail.",
    "detailed": "Give thorough answers with the relevant detail and context.",
}


class ConversationResourceService:
    """The Conversation resource and its ``:converse`` turn."""

    def __init__(
        self,
        sessions: SessionFactory,
        request_hash_secret: bytes,
        chat: Callable[[], ChatService],
    ) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._chat = chat
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> ConversationResourceService:
        return cls(runtime.sessions(), runtime.request_hash_secret(), runtime.chat_service)

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        conversation_id: str | None,
        display_name: str | None,
        pinned: bool,
        scope_collections: Sequence[str],
        scope_spaces: Sequence[str],
        request_id: UUID | None,
        validate_only: bool,
    ) -> ConversationRecord:
        """A conversation owned by the caller; ``conversation_id`` taken is ALREADY_EXISTS."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "conversations.create", write=True
        )
        if ctx.principal.session_id is None:
            raise PermissionDenied("Creating a conversation needs a signed-in session.")
        row_id = uuid4()
        code = _conversation_id(conversation_id) if conversation_id else f"r{row_id.hex}"
        title = _display_name(display_name)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None and not validate_only:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateConversation",
                    parent=f"workspaces/{workspace_id}",
                    request={
                        "conversationId": conversation_id,
                        "displayName": title,
                        "pinned": pinned,
                        "scope": {"collections": list(scope_collections), "spaces": list(scope_spaces)},
                    },
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await _record(session, await load_conversation(session, ctx, workspace_id, replayed.rsplit("/", 1)[-1]))
            collections, spaces = await require_scope(
                session, ctx, workspace_id, scope_collections, scope_spaces
            )
            taken = await session.scalar(
                select(Conversation.id).where(
                    Conversation.tenant_id == workspace_id, Conversation.code == code
                )
            )
            if taken is not None:
                raise AlreadyExists(f"The conversation ID '{code}' is already taken.")
            now = datetime.now(UTC)
            row = Conversation(
                id=row_id,
                tenant_id=workspace_id,
                code=code,
                owner_user_id=ctx.user_id,
                created_by_session_id=ctx.principal.session_id,
                title=title,
                pinned=pinned,
                scope_collection_ids=list(collections),
                scope_space_ids=list(spaces),
                state={},
                created_at=now,
                updated_at=now,
            )
            if validate_only:
                return await _record(session, row)
            session.add(row)
            await session.flush()
            name = conversation_name(workspace_id, code)
            await _audit(session, ctx, workspace_id, "CreateConversation", name)
            if key is not None:
                await idempotency.remember(key, name)
            return await _record(session, row)

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> ConversationRecord:
        """The caller's conversation, deleted ones included."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "conversations.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _record(session, await load_conversation(session, ctx, workspace_id, code))

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[ConversationRecord], int]:
        """The caller's conversations (``showDeleted`` adds deleted ones) and their total."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "conversations.list", write=False)
        statement = _owned(workspace_id, ctx.user_id, show_deleted=query.show_deleted)
        async with transaction_scope(self._sessions) as session:
            rows = list(await session.scalars(query.apply(statement)))
            total = int(await session.scalar(query.count(statement)) or 0)
            names = await _space_names(
                session, workspace_id, {s for row in rows for s in row.scope_space_ids}
            )
        return [ConversationRecord.of(row, names) for row in rows], total

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
    ) -> ConversationRecord:
        """``changes`` keyed by mask path: ``displayName``, ``pinned``, ``scope.collections``, ``scope.spaces``."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "conversations.update", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = await live_conversation(session, ctx, workspace_id, code)
            if "displayName" in changes:
                row.title = _display_name(changes["displayName"])
            if "pinned" in changes:
                row.pinned = bool(changes["pinned"])
            if "scope.collections" in changes or "scope.spaces" in changes:
                current = await _record(session, row)
                collections, spaces = await require_scope(
                    session,
                    ctx,
                    workspace_id,
                    _scope_change(changes, "scope.collections", current.scope_collections),
                    _scope_change(changes, "scope.spaces", current.scope_spaces),
                )
                row.scope_collection_ids = list(collections)
                row.scope_space_ids = list(spaces)
            row.updated_at = datetime.now(UTC)
            await session.flush()
            await _audit(session, ctx, workspace_id, "UpdateConversation", conversation_name(workspace_id, code))
            return await _record(session, row)

    async def delete(self, ctx: RequestContext, workspace_id: UUID, code: str) -> ConversationRecord:
        """Soft-delete; its live share stops resolving until ``:undelete``."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "conversations.delete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = await load_conversation(session, ctx, workspace_id, code, for_update=True)
            if row.deleted_at is not None:
                raise NotFound(f"Conversation '{conversation_name(workspace_id, code)}' is already deleted.")
            row.deleted_at = row.updated_at = datetime.now(UTC)
            await session.flush()
            await _audit(session, ctx, workspace_id, "DeleteConversation", conversation_name(workspace_id, code))
            return await _record(session, row)

    async def undelete(self, ctx: RequestContext, workspace_id: UUID, code: str) -> ConversationRecord:
        """Restore a deleted conversation before its ``purgeTime``."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "conversations.undelete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = await load_conversation(session, ctx, workspace_id, code, for_update=True)
            name = conversation_name(workspace_id, code)
            if row.deleted_at is None:
                raise AlreadyExists(f"Conversation '{name}' is not deleted.")
            require_restorable(row.deleted_at, name)
            row.deleted_at = None
            row.updated_at = datetime.now(UTC)
            await session.flush()
            await _audit(session, ctx, workspace_id, "UndeleteConversation", conversation_name(workspace_id, code))
            return await _record(session, row)

    async def converse(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        message: str,
        attachments: Sequence[str],
        replace_from_message: str | None,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[AgentStreamEvent]:
        """Authorize one turn, store the user message and return the reply's event stream.

        Errors are raised before the stream starts; once it runs, failures
        are reported in the stream (``response.failed``).
        """
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "conversations.converse", write=True
        )
        text = message.strip()
        if not text:
            raise InvalidArgument.for_field("message", "message must not be blank.")
        async with transaction_scope(self._sessions) as session:
            row = require_live(await load_conversation(session, ctx, workspace_id, code))
            replace_from = (
                await _replaceable(session, row, replace_from_message)
                if replace_from_message
                else None
            )
            attachment_ids = await require_attachments(session, ctx, workspace_id, attachments)
            roots = await retrieval_roots(session, ctx, row)
            assistant = await assistant_settings(session, workspace_id)
        message_id = uuid4()
        turn = TurnRequest(
            conversation_id=row.id,
            message_id=message_id,
            text=text,
            attachment_ids=attachment_ids,
            replace_from=replace_from,
            collection_ids=roots,
            workspace_instructions=_workspace_instructions(
                assistant.instructions, assistant.answer_length
            ),
            file_work=assistant.file_work,
            metadata={
                "conversation": conversation_name(workspace_id, code),
                "message": message_name(workspace_id, code, message_id),
            },
        )
        return await self._chat().stream_turn(
            ctx.in_workspace(workspace_id), turn, is_disconnected=is_disconnected
        )


# -- Loading ---------------------------------------------------------------------


async def load_conversation(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    code: str,
    *,
    for_update: bool = False,
) -> Conversation:
    """The caller's conversation ``code`` (deleted included).

    Absent → NOT_FOUND; owned by someone else → PERMISSION_DENIED. The
    caller already holds the method's workspace permission.
    """
    statement = select(Conversation).where(
        Conversation.tenant_id == workspace_id, Conversation.code == code
    )
    if for_update:
        statement = statement.with_for_update()
    row = await session.scalar(statement)
    name = conversation_name(workspace_id, code)
    if row is None:
        raise NotFound(f"Resource '{name}' was not found.")
    if row.owner_user_id != ctx.user_id:
        raise PermissionDenied(f"Conversation '{name}' belongs to another member.")
    return row


async def live_conversation(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, code: str
) -> Conversation:
    """The caller's conversation, locked; a deleted one is FAILED_PRECONDITION."""
    return require_live(
        await load_conversation(session, ctx, workspace_id, code, for_update=True)
    )


def require_live(row: Conversation) -> Conversation:
    """``row`` unless it is deleted: writes to a deleted conversation are CONVERSATION_DELETED."""
    if row.deleted_at is not None:
        raise FailedPrecondition(
            f"Conversation '{conversation_name(row.tenant_id, row.code)}' is deleted; "
            "undelete it first.",
            reason="CONVERSATION_DELETED",
        )
    return row


def _owned(workspace_id: UUID, user_id: UUID, *, show_deleted: bool) -> Select[tuple[Conversation]]:
    statement = select(Conversation).where(
        Conversation.tenant_id == workspace_id, Conversation.owner_user_id == user_id
    )
    if not show_deleted:
        statement = statement.where(Conversation.deleted_at.is_(None))
    return statement


async def _record(session: AsyncSession, row: Conversation) -> ConversationRecord:
    return ConversationRecord.of(
        row, await _space_names(session, row.tenant_id, row.scope_space_ids)
    )


async def _space_names(
    session: AsyncSession, workspace_id: UUID, space_ids: Iterable[UUID]
) -> dict[UUID, str]:
    codes = await space_codes(session, space_ids)
    return {space_id: space_name(workspace_id, code) for space_id, code in codes.items()}


async def _replaceable(session: AsyncSession, row: Conversation, name: str) -> UUID:
    """The active user message of ``row`` that ``replaceFromMessage`` names."""
    code, message_id = parse_message_name(name, row.tenant_id, field="replaceFromMessage")
    found = (
        code == row.code
        and await session.scalar(
            select(Message.id).where(
                Message.id == message_id,
                Message.conversation_id == row.id,
                Message.role == "user",
                Message.status == "active",
            )
        )
        is not None
    )
    if not found:
        raise InvalidArgument.for_field(
            "replaceFromMessage",
            f"'{name}' is not an active user message of this conversation.",
        )
    return message_id


# -- Validation ------------------------------------------------------------------


def _conversation_id(value: str) -> str:
    if not CONVERSATION_ID.match(value):
        raise InvalidArgument.for_field(
            "conversationId", "conversationId must match ^[a-z0-9-]{1,63}$."
        )
    return value


def _display_name(value: object) -> str | None:
    text = " ".join(value.split()) if isinstance(value, str) else ""
    if len(text) > MAX_DISPLAY_NAME:
        raise InvalidArgument.for_field(
            "displayName", f"displayName must be at most {MAX_DISPLAY_NAME} characters."
        )
    return text or None


def _scope_change(
    changes: Mapping[str, Any], path: str, current: Sequence[str]
) -> Sequence[str]:
    return list(changes[path] or ()) if path in changes else current


def _workspace_instructions(instructions: str, answer_length: str) -> str:
    """The workspace's assistant guidance, static per workspace (prompt-cache stable)."""
    sections = [instructions.strip()] if instructions.strip() else []
    if guidance := _ANSWER_LENGTH_GUIDANCE.get(answer_length):
        sections.append(guidance)
    return "\n\n".join(sections)


async def _audit(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, action: str, target: str
) -> None:
    await Audit(session).record(
        ctx, workspace_id=workspace_id, category="knowledge", action=action, target=target
    )


__all__ = [
    "MAX_DISPLAY_NAME",
    "ConversationResourceService",
    "live_conversation",
    "load_conversation",
    "require_live",
]
