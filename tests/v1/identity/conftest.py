"""Identity test fixtures: a scripted Google verifier, a reset-mail outbox, account helpers."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, ClassVar
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from api.v1.identity import password_reset_service
from bomesh.services.identity.password_reset import PasswordResetService
from bomesh.db.models import AuditLog, User
from bomesh.errors import Unauthenticated
from bomesh.runtime import AppRuntime
from bomesh.services import VerifiedGoogleIdentity
from harness import ApiClient, Sessions

PASSWORD = "correct horse battery"


class FakeGoogle:
    """Google ID-token verification scripted per token."""

    def __init__(self) -> None:
        self.identities: dict[str, VerifiedGoogleIdentity] = {}

    def token_for(self, email: str, *, subject: str | None = None, name: str | None = None) -> str:
        token = f"google-{uuid4().hex}"
        self.identities[token] = VerifiedGoogleIdentity(
            issuer="https://accounts.google.com",
            subject=subject or uuid4().hex,
            email=email,
            display_name=name,
        )
        return token

    async def verify(self, credential: str) -> VerifiedGoogleIdentity:
        identity = self.identities.get(credential)
        if identity is None:
            raise Unauthenticated("Google credential is malformed", reason="INVALID_CREDENTIALS")
        return identity


@dataclass(frozen=True, slots=True)
class SentReset:
    email: str
    reset_token: str
    expires_at: datetime


@dataclass(slots=True)
class Outbox:
    """Captures what the password-reset mailer was asked to send."""

    sent: list[SentReset] = field(default_factory=list)

    async def send_password_reset(
        self, *, email: str, reset_token: str, expires_at: datetime
    ) -> None:
        self.sent.append(SentReset(email, reset_token, expires_at))


@pytest.fixture
def google(runtime: AppRuntime) -> FakeGoogle:
    fake = FakeGoogle()
    runtime._google_identity = fake  # type: ignore[assignment]
    return fake


@pytest.fixture
def outbox(app: FastAPI, runtime: AppRuntime) -> Outbox:
    box = Outbox()
    app.dependency_overrides[password_reset_service] = lambda: PasswordResetService(
        runtime.sessions(), access_sessions=runtime.access_session_service, mailer=box
    )
    return box


@dataclass(slots=True)
class Accounts:
    """Sign up and sign in through the public API."""

    client: ApiClient
    #: The password :meth:`sign_up` sets by default.
    password: ClassVar[str] = PASSWORD

    async def sign_up(
        self,
        email: str | None = None,
        *,
        password: str = PASSWORD,
        username: str | None = None,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "email": email or f"user-{uuid4().hex[:10]}@example.com",
            "password": password,
        }
        if username is not None:
            body["username"] = username
        if display_name is not None:
            body["displayName"] = display_name
        response = await self.client.post("/api/v1/users", json=body)
        assert response.status_code == 200, response.text
        return response.json()

    async def sign_in(self, password: str = PASSWORD, **identifier: str) -> httpx.Response:
        return await self.client.post(
            "/api/v1/sessions",
            json={"credential": {"password": {**identifier, "password": password}}},
        )

    async def signed_in(self, password: str = PASSWORD, **identifier: str) -> ApiClient:
        response = await self.sign_in(password, **identifier)
        assert response.status_code == 200, response.text
        session = response.json()
        return ApiClient(
            self.client.http,
            self.client.runtime,
            token=session["accessToken"],
            session_id=UUID(session["name"].removeprefix("sessions/")),
            user_id=UUID(session["user"].removeprefix("users/")),
        )

    async def user_row(self, user: dict[str, Any]) -> User:
        """The ``users`` row behind a User message (for the World factories)."""
        async with self.client.runtime.sessions()() as session:
            row = await session.get(User, UUID(user["name"].removeprefix("users/")))
        assert row is not None
        return row


@pytest.fixture
def accounts(client: ApiClient) -> Accounts:
    return Accounts(client)


AuditReader = Callable[[str], Awaitable[list[AuditLog]]]
Reason = Callable[[httpx.Response], str | None]


@pytest.fixture
def audit(sessions: Sessions) -> AuditReader:
    """The audit events recorded for an action (operationId), oldest first."""

    async def events(action: str) -> list[AuditLog]:
        async with sessions() as session:
            return list(
                await session.scalars(
                    select(AuditLog)
                    .where(AuditLog.action == action)
                    .order_by(AuditLog.created_at)
                )
            )

    return events


def _reason(response: httpx.Response) -> str | None:
    return response.json()["error"]["details"][0].get("reason")


@pytest.fixture
def reason() -> Reason:
    """The ErrorInfo reason of an error response."""
    return _reason
