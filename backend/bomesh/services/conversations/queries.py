"""Question rows for workspace insights and knowledge gaps (SQL builders; no session, no permission check).

A question is an active user message of a live conversation: superseded
attempts and deleted conversations never count. This module imports only
models, so any domain may import it.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Select, and_, select
from sqlalchemy.orm import aliased

from bomesh.db.models import Conversation, Message


def question_rows() -> Select[Any]:
    """One row per question: ``tenant_id``, ``user_id`` (the asker), ``asked_at``."""
    return (
        select(
            Conversation.tenant_id.label("tenant_id"),
            Conversation.owner_user_id.label("user_id"),
            Message.created_at.label("asked_at"),
        )
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(*_live_questions(Message))
    )


def answered_question_rows(workspace_id: UUID | ColumnElement[Any]) -> Select[Any]:
    """Questions of the workspace joined to their completed, active answer.

    Columns: ``content`` (question text), ``asked_at``, ``scope_collection_id``
    (the conversation's first scope collection, nullable), ``feedback_rating``
    (the answer's, nullable) and ``citations`` (the answer's stored citations,
    jsonb ``[{item_id, chunk_id, page, title, excerpt}]``).
    """
    question = aliased(Message, name="question")
    answer = aliased(Message, name="answer")
    return (
        select(
            question.content.label("content"),
            question.created_at.label("asked_at"),
            Conversation.scope_collection_ids[1].label("scope_collection_id"),
            answer.feedback_rating.label("feedback_rating"),
            answer.metadata_["citations"].label("citations"),
        )
        .join(Conversation, Conversation.id == question.conversation_id)
        .join(
            answer,
            and_(
                answer.conversation_id == question.conversation_id,
                answer.sequence_number == question.sequence_number + 1,
                answer.role == "assistant",
                answer.status == "active",
                answer.generation_state == "completed",
            ),
        )
        .where(Conversation.tenant_id == workspace_id, *_live_questions(question))
    )


def _live_questions(message: Any) -> list[ColumnElement[bool]]:
    return [
        Conversation.deleted_at.is_(None),
        message.role == "user",
        message.status == "active",
    ]


__all__ = ["answered_question_rows", "question_rows"]
