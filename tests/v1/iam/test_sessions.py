"""Bearer authentication through the app (``auth_contract.md``, ``api.auth``).

The test app carries one throwaway route that depends on
``current_principal``; production routers are not involved. Every rejected
token answers 401 with the ``google.rpc.Status`` envelope.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

import httpx
import pytest
from fastapi import APIRouter, Depends, FastAPI
from sqlalchemy import update

from api.app import create_app
from api.auth import current_principal
from bomesh.db.models import AccessSession
from bomesh.errors import ERROR_DOMAIN, ERROR_INFO_TYPE, FailedPrecondition
from bomesh.iam.authorizer import Principal
from bomesh.runtime import AppRuntime
from bomesh.services.identity.jwt_tokens import JwtTokenService
from harness import ApiClient, World

pytestmark = pytest.mark.asyncio

WHOAMI = "/api/v1/__test/whoami"


@pytest.fixture
def app(runtime: AppRuntime) -> FastAPI:
    router = APIRouter()

    @router.get(WHOAMI)
    async def whoami(
        caller: Annotated[Principal, Depends(current_principal)],
    ) -> dict[str, str]:
        return {"userId": str(caller.user_id), "sessionId": str(caller.session_id)}

    app = create_app(runtime)
    app.include_router(router)
    return app


def _assert_unauthenticated(response: httpx.Response) -> None:
    assert response.status_code == 401
    error = response.json()["error"]
    assert error["code"] == 401
    assert error["status"] == "UNAUTHENTICATED"
    assert error["message"]
    assert error["details"][0]["@type"] == ERROR_INFO_TYPE
    assert error["details"][0]["domain"] == ERROR_DOMAIN


async def _end_session(client: ApiClient, session_id: UUID | None) -> None:
    assert session_id is not None
    async with client.runtime.sessions().begin() as session:
        await client.runtime.access_session_service(session).end(session_id)


async def _update_session(client: ApiClient, **values: object) -> None:
    async with client.runtime.sessions().begin() as session:
        await session.execute(
            update(AccessSession).where(AccessSession.id == client.session_id).values(**values)
        )


async def test_an_issued_token_resolves_to_its_user_and_session(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    alice = await client.as_(user)

    response = await alice.get(WHOAMI)

    assert response.status_code == 200
    assert response.json() == {"userId": str(user.id), "sessionId": str(alice.session_id)}


async def test_a_request_without_a_bearer_token_is_unauthenticated(client: ApiClient) -> None:
    _assert_unauthenticated(await client.get(WHOAMI))
    _assert_unauthenticated(
        await client.get(WHOAMI, headers={"Authorization": "Basic YWxpY2U6c2VjcmV0"})
    )


@pytest.mark.parametrize("token", ["garbage", "a.b.c", "eyJhbGciOiJub25lIn0.e30."])
async def test_a_malformed_token_is_unauthenticated(client: ApiClient, token: str) -> None:
    _assert_unauthenticated(await client.with_token(token).get(WHOAMI))


async def test_a_token_signed_with_another_secret_is_unauthenticated(
    client: ApiClient, world: World
) -> None:
    alice = await client.as_(await world.make_user())
    assert alice.session_id is not None and alice.user_id is not None
    identity = client.runtime.config.identity
    forged = JwtTokenService(
        secret="another-deployment-secret-of-32-bytes-or-more",
        issuer=identity.jwt_issuer,
        audience=identity.jwt_audience,
        expires_in_seconds=identity.jwt_expires_in_seconds,
    ).issue(
        session_id=alice.session_id,
        user_id=alice.user_id,
        token_version=1,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )

    _assert_unauthenticated(await client.with_token(forged).get(WHOAMI))


async def test_an_ended_session_is_unauthenticated_and_others_are_not(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    laptop, phone = await client.as_(user), await client.as_(user)

    await _end_session(client, laptop.session_id)

    _assert_unauthenticated(await laptop.get(WHOAMI))
    assert (await phone.get(WHOAMI)).status_code == 200


async def test_an_expired_session_is_unauthenticated_and_recorded_as_expired(
    client: ApiClient, world: World
) -> None:
    alice = await client.as_(await world.make_user())
    await _update_session(alice, expires_at=datetime.now(UTC) - timedelta(seconds=1))

    _assert_unauthenticated(await alice.get(WHOAMI))

    async with client.runtime.sessions()() as session:
        row = await session.get(AccessSession, alice.session_id)
    assert row is not None
    assert (row.status, row.end_reason) == ("expired", "session_expired")
    assert row.ended_at is not None


async def test_an_idle_expired_session_is_unauthenticated(
    client: ApiClient, world: World
) -> None:
    alice = await client.as_(await world.make_user())
    await _update_session(alice, idle_expires_at=datetime.now(UTC) - timedelta(seconds=1))

    _assert_unauthenticated(await alice.get(WHOAMI))


async def test_a_replaced_token_version_is_unauthenticated(
    client: ApiClient, world: World
) -> None:
    alice = await client.as_(await world.make_user())
    await _update_session(alice, token_version=AccessSession.token_version + 1)

    _assert_unauthenticated(await alice.get(WHOAMI))


async def test_a_suspended_user_is_unauthenticated_and_cannot_sign_in(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    alice = await client.as_(user)
    assert (await alice.get(WHOAMI)).status_code == 200

    await world.suspend_user(user)

    _assert_unauthenticated(await alice.get(WHOAMI))
    with pytest.raises(FailedPrecondition) as refused:
        await client.as_(user)
    assert refused.value.reason == "USER_SUSPENDED"


async def test_ending_every_session_of_a_user_signs_them_out_everywhere(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    laptop, phone = await client.as_(user), await client.as_(user)

    async with client.runtime.sessions().begin() as session:
        ended = await client.runtime.access_session_service(session).end_all(
            user.id, reason="password_reset"
        )

    assert ended == 2
    for device in (laptop, phone):
        _assert_unauthenticated(await device.get(WHOAMI))
