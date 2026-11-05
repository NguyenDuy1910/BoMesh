"""Cross-slice reads of conversations and messages (no permission checks).

Other slices name conversations (``Artifact.conversation``) and messages
(``Request.sourceMessage``); these helpers parse those names and resolve them
in the caller's session, so no other slice queries the conversation tables.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import ScalarSelect, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Conversation, Message
from bomesh.errors import InvalidArgument, PermissionDenied
from bomesh.iam.authorizer import Principal
from bomesh.services.conversations.records import (
    SourceContext,
    conversation_name,
    stored_citations,
)

CONVERSATION_ID = re.compile(r"^[a-z0-9-]{1,63}$")


def parse_conversation_name(name: str, workspace_id: UUID, *, field: str) -> str:
    """The conversation ID of ``workspaces/{workspace}/conversations/{conversation}``."""
    parts = name.split("/")
    if (
        len(parts) == 4
        and parts[0] == "workspaces"
        and parts[1] == str(workspace_id)
        and parts[2] == "conversations"
        and CONVERSATION_ID.match(parts[3])
    ):
        return parts[3]
    raise InvalidArgument.for_field(
        field, f"'{name}' is not a conversation name of this workspace."
    )


def parse_message_name(name: str, workspace_id: UUID, *, field: str) -> tuple[str, UUID]:
    """``(conversation ID, message ID)`` of ``…/conversations/{c}/messages/{m}``."""
    head, separator, message = name.rpartition("/messages/")
    if separator:
        try:
            message_id = UUID(message)
        except ValueError:
            pass
        else:
            if str(message_id) == message.lower():
                return parse_conversation_name(head, workspace_id, field=field), message_id
    raise InvalidArgument.for_field(field, f"'{name}' is not a message name of this workspace.")


def conversation_id_by_code(workspace_id: UUID, code: str) -> ScalarSelect[UUID]:
    """``conversations.id`` of the conversation ID ``code`` (deleted included), as SQL."""
    return (
        select(Conversation.id)
        .where(Conversation.tenant_id == workspace_id, Conversation.code == code)
        .scalar_subquery()
    )


async def own_conversation_id(
    session: AsyncSession, workspace_id: UUID, owner_id: UUID, code: str
) -> UUID | None:
    """The live conversation ``code`` when ``owner_id`` owns it, else ``None``."""
    return await session.scalar(
        select(Conversation.id).where(
            Conversation.tenant_id == workspace_id,
            Conversation.code == code,
            Conversation.owner_user_id == owner_id,
            Conversation.deleted_at.is_(None),
        )
    )


async def conversation_codes(
    session: AsyncSession, conversation_ids: Iterable[UUID]
) -> dict[UUID, str]:
    """Conversation ID (``code``) of each row id, deleted conversations included."""
    ids = set(conversation_ids)
    if not ids:
        return {}
    rows = await session.execute(
        select(Conversation.id, Conversation.code).where(Conversation.id.in_(ids))
    )
    return {row_id: code for row_id, code in rows}


async def source_message_context(
    session: AsyncSession,
    principal: Principal,
    workspace_id: UUID,
    message_name: str,
    *,
    field: str = "sourceMessage",
) -> SourceContext:
    """The text and stored citations of an active message of the caller's live conversation.

    A malformed name is INVALID_ARGUMENT; a message that does not exist, was
    superseded, or belongs to a deleted or someone else's conversation is
    PERMISSION_DENIED. Render the citations per reader with ``render_citations``.
    """
    code, message_id = parse_message_name(message_name, workspace_id, field=field)
    message = await session.scalar(
        select(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Message.id == message_id,
            Message.status == "active",
            Conversation.tenant_id == workspace_id,
            Conversation.code == code,
            Conversation.owner_user_id == principal.user_id,
            Conversation.deleted_at.is_(None),
        )
    )
    if message is None:
        raise PermissionDenied(
            f"Message '{message_name}' is not a message of your conversation "
            f"'{conversation_name(workspace_id, code)}'."
        )
    return SourceContext(
        message_id=message.id,
        role="ASSISTANT" if message.role == "assistant" else "USER",
        answer=message.content,
        citations=stored_citations(message.metadata_),
    )


__all__ = [
    "CONVERSATION_ID",
    "conversation_codes",
    "conversation_id_by_code",
    "own_conversation_id",
    "parse_conversation_name",
    "parse_message_name",
    "source_message_context",
]
