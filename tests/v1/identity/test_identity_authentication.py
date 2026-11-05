"""Bearer authentication is an Identity use case (``SessionService.authenticate``).

The HTTP layer only extracts the token; resolving it, and recording what
resolution learns (an expired session ends), happens in the Identity services.
"""

from __future__ import annotations

import ast
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import update

from bomesh.services.identity.sessions import SessionService
from bomesh.db.models import AccessSession
from bomesh.errors import Unauthenticated
from bomesh.runtime import AppRuntime
from harness import ApiClient, Sessions, World


API_PACKAGE = Path(__file__).resolve().parents[3] / "backend" / "api"


@pytest.mark.asyncio
async def test_authenticate_resolves_a_token_to_its_principal(
    client: ApiClient, world: World, runtime: AppRuntime
) -> None:
    alice = await client.as_(await world.make_user())
    assert alice.token is not None

    principal = await SessionService.from_runtime(runtime).authenticate(alice.token)

    assert (principal.user_id, principal.session_id) == (alice.user_id, alice.session_id)


@pytest.mark.asyncio
async def test_an_expired_session_is_rejected_and_its_end_is_committed(
    client: ApiClient, world: World, runtime: AppRuntime, sessions: Sessions
) -> None:
    alice = await client.as_(await world.make_user())
    assert alice.token is not None
    async with sessions.begin() as session:
        await session.execute(
            update(AccessSession)
            .where(AccessSession.id == alice.session_id)
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )

    with pytest.raises(Unauthenticated):
        await SessionService.from_runtime(runtime).authenticate(alice.token)

    async with sessions() as session:
        row = await session.get(AccessSession, alice.session_id)
    assert row is not None
    assert (row.status, row.end_reason) == ("expired", "session_expired")


@pytest.mark.asyncio
async def test_garbage_tokens_are_unauthenticated(runtime: AppRuntime) -> None:
    with pytest.raises(Unauthenticated):
        await SessionService.from_runtime(runtime).authenticate("not.a.token")


def test_the_http_layer_opens_no_transactions() -> None:
    offenders = sorted(
        str(path.relative_to(API_PACKAGE))
        for path in API_PACKAGE.rglob("*.py")
        if _imports(path, "bomesh.db.engine")
    )

    assert offenders == []


def _imports(path: Path, module: str) -> bool:
    tree = ast.parse(path.read_text())
    return any(
        (isinstance(node, ast.ImportFrom) and node.module == module)
        or (isinstance(node, ast.Import) and any(alias.name == module for alias in node.names))
        for node in ast.walk(tree)
    )
