"""Identity password reset: SendPasswordReset, ResetPassword (``auth_contract.md``)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import update

from bomesh.db.models import PasswordResetToken
from harness import ApiClient, Sessions, World

if TYPE_CHECKING:
    from conftest import Accounts, AuditReader, Outbox, Reason

pytestmark = pytest.mark.asyncio

SEND = "/api/v1/users:sendPasswordReset"
RESET = "/api/v1/users:resetPassword"
NEW_PASSWORD = "a brand new password"


async def _send(client: ApiClient, email: str) -> None:
    response = await client.post(SEND, json={"email": email})
    assert response.status_code == 200
    assert response.json() == {}


async def test_a_reset_sets_the_password_and_ends_every_session(
    client: ApiClient, accounts: Accounts, outbox: Outbox, audit: AuditReader
) -> None:
    user = await accounts.sign_up("reset@example.com")
    device = await accounts.signed_in(email="reset@example.com")
    await _send(client, "Reset@Example.com")
    [mail] = outbox.sent

    response = await client.post(
        RESET, json={"resetToken": mail.reset_token, "newPassword": NEW_PASSWORD}
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert mail.email == "reset@example.com"
    assert mail.expires_at - datetime.now(UTC) <= timedelta(minutes=30)
    assert (await device.get("/api/v1/sessions/current")).status_code == 401
    assert (await accounts.sign_in(email="reset@example.com")).status_code == 401
    assert (await accounts.sign_in(NEW_PASSWORD, email="reset@example.com")).status_code == 200
    assert [e.target_name for e in await audit("ResetPassword")] == [user["name"]]
    events = await audit("SendPasswordReset")
    assert all(mail.reset_token not in str(e.details) for e in events)


async def test_send_answers_the_same_for_unknown_and_suspended_accounts(
    client: ApiClient, accounts: Accounts, world: World, outbox: Outbox
) -> None:
    user = await accounts.sign_up("gone@example.com")
    await world.suspend_user(await accounts.user_row(user))

    await _send(client, "nobody@example.com")
    await _send(client, "gone@example.com")

    assert outbox.sent == []


async def test_send_rejects_a_malformed_email(client: ApiClient, outbox: Outbox) -> None:
    assert (await client.post(SEND, json={"email": "not-an-email"})).status_code == 400
    assert (await client.post(SEND, json={})).status_code == 400


async def test_a_token_works_once(
    client: ApiClient, accounts: Accounts, outbox: Outbox, reason: Reason
) -> None:
    await accounts.sign_up("once@example.com")
    await _send(client, "once@example.com")
    token = outbox.sent[0].reset_token
    body = {"resetToken": token, "newPassword": NEW_PASSWORD}

    first = await client.post(RESET, json=body)
    second = await client.post(RESET, json=body)

    assert first.status_code == 200
    assert second.status_code == 400
    assert second.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert reason(second) == "RESET_TOKEN_INVALID"


async def test_unknown_and_expired_tokens_are_invalid(
    client: ApiClient, accounts: Accounts, outbox: Outbox, sessions: Sessions, reason: Reason
) -> None:
    await accounts.sign_up("late@example.com")
    await _send(client, "late@example.com")
    async with sessions.begin() as session:
        await session.execute(
            update(PasswordResetToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )

    expired = await client.post(
        RESET, json={"resetToken": outbox.sent[0].reset_token, "newPassword": NEW_PASSWORD}
    )
    unknown = await client.post(RESET, json={"resetToken": "made-up", "newPassword": NEW_PASSWORD})

    assert reason(expired) == "RESET_TOKEN_INVALID"
    assert reason(unknown) == "RESET_TOKEN_INVALID"
    assert (await accounts.sign_in(email="late@example.com")).status_code == 200


async def test_a_weak_password_is_rejected_without_consuming_the_token(
    client: ApiClient, accounts: Accounts, outbox: Outbox
) -> None:
    await accounts.sign_up("weak@example.com")
    await _send(client, "weak@example.com")
    token = outbox.sent[0].reset_token

    weak = await client.post(RESET, json={"resetToken": token, "newPassword": "short"})
    strong = await client.post(RESET, json={"resetToken": token, "newPassword": NEW_PASSWORD})

    assert weak.status_code == 400
    assert weak.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert strong.status_code == 200
