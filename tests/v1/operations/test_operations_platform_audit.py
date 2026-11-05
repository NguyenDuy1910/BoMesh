"""Platform-level audit events: List, Get and Export (platform roles only)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest

from harness import ApiClient, Fakes, World

pytestmark = pytest.mark.asyncio

NOW = datetime.now(UTC)


async def _operator(client: ApiClient, world: World) -> ApiClient:
    return await client.as_(await world.platform_operator(await world.make_user()))


async def test_list_returns_only_platform_events_newest_first(
    client: ApiClient, world: World, ops: Any
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    older = await ops.audit(actor=admin, at=NOW - timedelta(minutes=2))
    newer = await ops.audit(action="UpdateUser", category="people", at=NOW - timedelta(minutes=1))
    await ops.audit(tenant_id=workspace.id, category="knowledge", action="CreateItem")
    api = await _operator(client, world)

    body = (await api.get("/api/v1/auditEvents")).json()

    assert [e["name"] for e in body["auditEvents"]] == [
        f"auditEvents/{newer.id}", f"auditEvents/{older.id}"
    ]
    event = body["auditEvents"][1]
    assert event["actor"] == f"users/{admin.id}"
    assert event["category"] == "SIGN_IN"
    assert event["outcome"] == "SUCCEEDED"
    assert event["action"] == "CreateSession"
    assert event["description"]


async def test_list_filters_and_pages(client: ApiClient, world: World, ops: Any) -> None:
    for _ in range(3):
        await ops.audit()
    failed = await ops.audit(outcome="failed")
    api = await _operator(client, world)

    only_failed = (await api.get("/api/v1/auditEvents", params={"filter": 'outcome = "FAILED"'})).json()
    assert [e["name"] for e in only_failed["auditEvents"]] == [f"auditEvents/{failed.id}"]
    page = (await api.get("/api/v1/auditEvents", params={"pageSize": 3})).json()
    assert len(page["auditEvents"]) == 3 and page["nextPageToken"]
    bad = await api.get("/api/v1/auditEvents", params={"filter": "nope = 1"})
    assert bad.status_code == 400


async def test_get_reads_platform_events_only(client: ApiClient, world: World, ops: Any) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    platform = await ops.audit()
    scoped = await ops.audit(tenant_id=workspace.id, category="knowledge", action="CreateItem")
    api = await _operator(client, world)

    got = await api.get(f"/api/v1/auditEvents/{platform.id}")
    assert got.status_code == 200
    assert got.json()["name"] == f"auditEvents/{platform.id}"
    assert (await api.get(f"/api/v1/auditEvents/{scoped.id}")).status_code == 404
    assert (await api.get(f"/api/v1/auditEvents/{uuid4()}")).status_code == 404


async def test_workspace_admins_are_denied(client: ApiClient, world: World, ops: Any) -> None:
    admin = await world.make_user()
    await world.make_workspace(admin)
    event = await ops.audit()
    api = await client.as_(admin)

    assert (await api.get("/api/v1/auditEvents")).status_code == 403
    assert (await api.get(f"/api/v1/auditEvents/{event.id}")).status_code == 403
    assert (await api.get(f"/api/v1/auditEvents/{uuid4()}")).status_code == 403
    assert (await api.post("/api/v1/auditEvents:export", json={})).status_code == 403


async def test_export_writes_a_csv_and_returns_a_done_operation(
    client: ApiClient, world: World, ops: Any, fakes: Fakes
) -> None:
    await ops.audit(outcome="failed")
    await ops.audit()
    api = await _operator(client, world)

    response = await api.post(
        "/api/v1/auditEvents:export", json={"filter": 'outcome = "FAILED"'}
    )

    assert response.status_code == 200, response.text
    operation = response.json()
    assert operation["done"] is True
    assert operation["metadata"]["@type"].endswith(".WorkspaceExportMetadata")
    assert operation["response"]["downloadUri"].startswith("https://storage.test/")
    [stored] = fakes.storage.objects.values()
    lines = stored.data.decode().strip().splitlines()
    assert len(lines) == 2  # header and the failed event

    polled = await api.get(f"/api/v1/{operation['name']}")
    assert polled.status_code == 200
    assert polled.json()["response"]["downloadUri"]


async def test_export_honours_request_id(client: ApiClient, world: World, ops: Any) -> None:
    await ops.audit()
    api = await _operator(client, world)
    request_id = str(uuid4())

    first = await api.post("/api/v1/auditEvents:export", params={"requestId": request_id}, json={})
    again = await api.post("/api/v1/auditEvents:export", params={"requestId": request_id}, json={})
    other = await api.post(
        "/api/v1/auditEvents:export",
        params={"requestId": request_id},
        json={"filter": 'outcome = "FAILED"'},
    )

    assert first.json()["name"] == again.json()["name"]
    assert other.status_code == 400


async def test_export_rejects_a_bad_filter(client: ApiClient, world: World) -> None:
    api = await _operator(client, world)
    response = await api.post("/api/v1/auditEvents:export", json={"filter": "nope = 1"})
    assert response.status_code == 400
