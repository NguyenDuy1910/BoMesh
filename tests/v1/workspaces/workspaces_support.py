"""Shared helpers of the Workspaces API tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
from sqlalchemy import select

from bomesh.db.models import (
    AccessSession,
    AuditLog,
    Conversation,
    Item,
    Message,
    Tenant,
    User,
)
from harness import Sessions


def reason(response: httpx.Response) -> str | None:
    """The ErrorInfo reason of an error response."""
    for detail in response.json()["error"].get("details", []):
        if detail.get("@type", "").endswith("ErrorInfo"):
            return detail.get("reason")
    return None


def status(response: httpx.Response) -> str:
    return response.json()["error"]["status"]


def ws_path(workspace: Tenant | UUID) -> str:
    workspace_id = workspace.id if isinstance(workspace, Tenant) else workspace
    return f"/api/v1/workspaces/{workspace_id}"


def member_path(workspace: Tenant, user: User | str) -> str:
    member = user if isinstance(user, str) else user.id
    return f"{ws_path(workspace)}/members/{member}"


async def set_status(sessions: Sessions, workspace: Tenant, value: str) -> None:
    async with sessions.begin() as session:
        row = await session.get(Tenant, workspace.id)
        assert row is not None
        row.status = value


async def audit_actions(sessions: Sessions, workspace: Tenant | None) -> list[str]:
    async with sessions.begin() as session:
        statement = select(AuditLog.action).order_by(AuditLog.created_at, AuditLog.id)
        statement = statement.where(
            AuditLog.tenant_id == workspace.id
            if workspace is not None
            else AuditLog.tenant_id.is_(None)
        )
        return list(await session.scalars(statement))


async def add_audit_event(
    sessions: Sessions,
    workspace: Tenant | None,
    *,
    actor: User | None = None,
    category: str = "knowledge",
    action: str = "PublishItem",
    target: str | None = "workspaces/x/items/secret-title",
    outcome: str = "succeeded",
    created_at: datetime | None = None,
) -> AuditLog:
    async with sessions.begin() as session:
        event = AuditLog(
            tenant_id=workspace.id if workspace is not None else None,
            actor_user_id=actor.id if actor is not None else None,
            category=category,
            action=action,
            resource_type="item",
            target_name=target,
            outcome=outcome,
            details={},
        )
        if created_at is not None:
            event.created_at = created_at
        session.add(event)
    return event


class Conversations:
    """Conversation turns for knowledge-gap and usage tests (rows only)."""

    def __init__(self, sessions: Sessions) -> None:
        self.sessions = sessions

    async def ask(
        self,
        workspace: Tenant,
        user: User,
        question: str,
        *,
        rating: str | None = None,
        citations: list[dict[str, Any]] | None = None,
        asked_at: datetime | None = None,
        scope: list[UUID] | None = None,
    ) -> Conversation:
        """One conversation with one question and its completed answer."""
        asked = asked_at or datetime.now(UTC)
        async with self.sessions.begin() as session:
            access = AccessSession(
                user_id=user.id,
                authentication_method="password",
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
            session.add(access)
            await session.flush()
            conversation = Conversation(
                tenant_id=workspace.id,
                code=f"c-{uuid4().hex[:10]}",
                owner_user_id=user.id,
                created_by_session_id=access.id,
                scope_collection_ids=scope or [],
            )
            session.add(conversation)
            await session.flush()
            session.add(
                Message(
                    conversation_id=conversation.id,
                    role="user",
                    content=question,
                    sequence_number=1,
                    created_at=asked,
                )
            )
            session.add(
                Message(
                    conversation_id=conversation.id,
                    role="assistant",
                    content="An answer.",
                    metadata_={"citations": citations or []},
                    sequence_number=2,
                    created_at=asked,
                    feedback_rating=rating,
                    feedback_at=asked if rating else None,
                )
            )
        return conversation


async def set_next_review(sessions: Sessions, document: Item, when: datetime) -> None:
    async with sessions.begin() as session:
        row = await session.get(Item, document.id)
        assert row is not None
        row.metadata_ = {
            **row.metadata_,
            "verification": {"state": "verified", "next_review_at": when.isoformat()},
        }
