"""Operations-slice factories: operation rows, probe history and platform audit events."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from bomesh.services.kernel.operations import OPERATION_HANDLERS, OperationHandlers
from bomesh.db.models import AuditLog, Operation, PlatformHealthCheck, User
from harness import Sessions


class OperationsWorld:
    def __init__(self, sessions: Sessions) -> None:
        self.sessions = sessions

    async def operation(
        self,
        user: User,
        *,
        verb: str = "exportAuditEvents",
        target: str = "auditEvents",
        created_at: datetime | None = None,
        finished: bool = False,
        result_object_key: str | None = None,
        result_name: str | None = None,
        expires_at: datetime | None = None,
    ) -> Operation:
        now = created_at or datetime.now(UTC)
        async with self.sessions.begin() as session:
            operation = Operation(
                user_id=user.id,
                verb=verb,
                target=target,
                created_at=now,
                finished_at=now if finished else None,
                progress_percent=100 if finished else 0,
                result_object_key=result_object_key,
                result_name=result_name,
                result_expires_at=now + timedelta(days=1) if result_object_key else None,
                expires_at=expires_at or now + timedelta(days=30),
            )
            session.add(operation)
        return operation

    async def check(
        self,
        service: str,
        status: str,
        at: datetime,
        *,
        error_category: str | None = None,
    ) -> UUID:
        async with self.sessions.begin() as session:
            row = PlatformHealthCheck(
                checked_at=at,
                service=service,
                status=status,
                error_category=error_category,
                latency_ms=3,
            )
            session.add(row)
            await session.flush()
            return row.id

    async def audit(
        self,
        *,
        action: str = "CreateSession",
        category: str = "sign_in",
        outcome: str = "succeeded",
        actor: User | None = None,
        tenant_id: UUID | None = None,
        at: datetime | None = None,
    ) -> AuditLog:
        async with self.sessions.begin() as session:
            event = AuditLog(
                tenant_id=tenant_id,
                actor_user_id=actor.id if actor is not None else None,
                category=category,
                action=action,
                resource_type="session",
                target_name="users/x/sessions/y",
                outcome=outcome,
                ip_address="10.0.0.1",
                details={},
                created_at=at or datetime.now(UTC),
            )
            session.add(event)
        return event


@pytest.fixture
def ops(sessions: Sessions) -> OperationsWorld:
    return OperationsWorld(sessions)


@pytest.fixture
def handlers() -> Iterator[OperationHandlers]:
    """The process registry, restored after the test."""
    saved = OPERATION_HANDLERS.snapshot()
    yield OPERATION_HANDLERS
    OPERATION_HANDLERS.restore(saved)
