"""Failure paths of the Workspaces long-running methods, purge, names and layering."""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

import bomesh.services.workspaces.workspaces as workspace_module
from bomesh.services.workspaces.records import parse_member_name
from bomesh.db.models import Operation, Role, Tenant
from bomesh.errors import InvalidArgument
from harness import ApiClient, Fakes, World
from workspaces_support import add_audit_event, ws_path

pytestmark = pytest.mark.asyncio

BACKEND = Path(__file__).resolve().parents[3] / "backend"


# -- CreateWorkspace is atomic ----------------------------------------------------


async def test_failed_provisioning_leaves_no_workspace_or_operation(
    client: ApiClient, world: World, sessions, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await world.platform_admin(await world.make_user())
    api = await client.as_(admin)
    code = f"ws-{uuid4().hex[:8]}"

    async def broken(*_: object) -> None:
        raise RuntimeError("provisioning broke")

    monkeypatch.setattr(workspace_module, "ensure_personal_collection", broken)
    # The test transport re-raises unhandled app errors; in production they are a 500.
    with pytest.raises(RuntimeError, match="provisioning broke"):
        await api.post(
            "/api/v1/workspaces",
            json={"displayName": "Acme", "code": code, "initialAdminEmail": admin.email},
        )

    async with sessions.begin() as session:
        assert await session.scalar(select(Tenant).where(Tenant.code == code)) is None
        assert (await session.scalars(select(Operation))).all() == []

    monkeypatch.undo()
    retried = await api.post(
        "/api/v1/workspaces",
        json={"displayName": "Acme", "code": code, "initialAdminEmail": admin.email},
    )
    assert retried.status_code == 200
    assert retried.json()["response"]["state"] == "ACTIVE"


# -- Exports always finish their operation ------------------------------------------


def _break_storage(fakes: Fakes, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: object, **__: object) -> None:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(fakes.storage, "put_bytes", broken)


async def test_audit_export_failure_fails_the_operation(
    client: ApiClient, world: World, sessions, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await add_audit_event(sessions, workspace)
    _break_storage(fakes, monkeypatch)

    response = await (await client.as_(owner)).post(
        f"{ws_path(workspace)}/auditEvents:export", json={}
    )

    assert response.status_code == 200, response.text
    operation = response.json()
    assert operation["done"] is True
    assert operation["error"]["code"] == 13
    assert "response" not in operation


async def test_usage_export_failure_fails_the_operation(
    client: ApiClient, world: World, sessions, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    operator = await world.platform_operator(await world.make_user())
    _break_storage(fakes, monkeypatch)

    response = await (await client.as_(operator)).post("/api/v1/workspaces:exportUsage", json={})

    assert response.status_code == 200, response.text
    assert response.json()["done"] is True
    assert response.json()["error"]["code"] == 13
    async with sessions.begin() as session:
        operation = await session.scalar(select(Operation))
        assert operation.finished_at is not None


# -- Custom roles past their purge time -------------------------------------------------


async def test_purged_role_is_gone(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    role = await world.make_role(workspace, "auditor", ["auditEvents.list"])
    recent = await world.make_role(workspace, "recent", ["auditEvents.list"])
    async with sessions.begin() as session:
        (await session.get(Role, role.id)).deleted_at = datetime.now(UTC) - timedelta(days=31)
        (await session.get(Role, recent.id)).deleted_at = datetime.now(UTC) - timedelta(days=1)
    api = await client.as_(owner)
    base = f"{ws_path(workspace)}/roles"

    assert (await api.post(f"{base}/auditor:undelete", json={})).status_code == 404
    assert (await api.get(f"{base}/auditor")).status_code == 404
    listed = (await api.get(base, params={"showDeleted": "true"})).json()["roles"]
    assert [r["name"].rsplit("/", 1)[1] for r in listed] == ["recent"]
    restored = await api.post(f"{base}/recent:undelete", json={})
    assert restored.status_code == 200
    assert restored.json()["state"] == "ACTIVE"


# -- Names --------------------------------------------------------------------------


def test_parse_member_name() -> None:
    workspace_id, user_id, me = uuid4(), uuid4(), uuid4()
    prefix = f"workspaces/{workspace_id}/members"
    assert parse_member_name(f"{prefix}/{user_id}", workspace_id, field="member") == user_id
    assert parse_member_name(f"{prefix}/me", workspace_id, field="member", me=me) == me
    for bad in (f"{prefix}/me", f"workspaces/{uuid4()}/members/{user_id}", f"{prefix}/x", "x"):
        with pytest.raises(InvalidArgument) as raised:
            parse_member_name(bad, workspace_id, field="member")
        assert raised.value.field_violations[0].field == "member"


# -- Layering -------------------------------------------------------------------------


def test_create_workspace_result_is_registered_without_the_router() -> None:
    script = (
        "import bomesh.services.workspaces.workspaces\n"
        "from bomesh.services.kernel.operations import OPERATION_HANDLERS\n"
        "assert OPERATION_HANDLERS.result_loader('createWorkspace') is not None\n"
    )
    subprocess.run([sys.executable, "-c", script], cwd=BACKEND, check=True)


def test_workspaces_read_no_other_domains_tables() -> None:
    """The Workspaces package reads no other domain's tables."""
    foreign = re.compile(
        r"\b(Item|Message|Conversation|Contribution|IngestionRun|IngestionRunItem|"
        r"IngestionSource|IngestionSync|IntegrationConnection|Request|Space)\b[.,)\n]"
    )
    for module in sorted((BACKEND / "bomesh/services/workspaces").glob("*.py")):
        assert not foreign.search(module.read_text()), module.name
