"""Workspace audit events: list, get, export (LRO), summarize; platform metadata-only reads."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from harness import ApiClient, Fakes, World
from workspaces_support import add_audit_event, ws_path

pytestmark = pytest.mark.asyncio


async def test_list_and_get_audit_events(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    other = await world.make_workspace(owner)
    now = datetime.now(UTC)
    old = await add_audit_event(sessions, workspace, actor=owner, created_at=now - timedelta(days=2))
    new = await add_audit_event(
        sessions, workspace, category="people", action="CreateMember", outcome="failed"
    )
    await add_audit_event(sessions, other, actor=owner)
    api = await client.as_(owner)

    listed = (await api.get(f"{ws_path(workspace)}/auditEvents")).json()["auditEvents"]
    assert [e["name"] for e in listed] == [
        f"workspaces/{workspace.id}/auditEvents/{new.id}",
        f"workspaces/{workspace.id}/auditEvents/{old.id}",
    ]
    first = listed[1]
    assert first["actor"] == f"users/{owner.id}"
    assert first["category"] == "KNOWLEDGE"
    assert first["target"] == "workspaces/x/items/secret-title"
    assert first["description"] == "Publish item (item)"
    assert listed[0]["actor"] == "system"
    assert listed[0]["outcome"] == "FAILED"

    by_category = await api.get(
        f"{ws_path(workspace)}/auditEvents", params={"filter": "category = PEOPLE"}
    )
    assert [e["action"] for e in by_category.json()["auditEvents"]] == ["CreateMember"]
    by_actor = await api.get(
        f"{ws_path(workspace)}/auditEvents", params={"filter": f'actor = "users/{owner.id}"'}
    )
    assert len(by_actor.json()["auditEvents"]) == 1
    by_time = await api.get(
        f"{ws_path(workspace)}/auditEvents",
        params={"filter": f'createTime > "{(now - timedelta(days=1)).isoformat()}"'},
    )
    assert [e["action"] for e in by_time.json()["auditEvents"]] == ["CreateMember"]
    ascending = await api.get(f"{ws_path(workspace)}/auditEvents", params={"orderBy": "createTime"})
    assert ascending.json()["auditEvents"][0]["name"].endswith(str(old.id))
    bad = await api.get(f"{ws_path(workspace)}/auditEvents", params={"filter": "target = x"})
    assert bad.status_code == 400

    got = await api.get(f"{ws_path(workspace)}/auditEvents/{old.id}")
    assert got.json()["target"] == "workspaces/x/items/secret-title"
    assert (await api.get(f"{ws_path(workspace)}/auditEvents/{uuid4()}")).status_code == 404
    cross = await api.get(f"{ws_path(other)}/auditEvents/{old.id}")
    assert cross.status_code == 404

    member = await client.as_(await world.add_member(workspace))
    assert (await member.get(f"{ws_path(workspace)}/auditEvents")).status_code == 403
    assert (await member.get(f"{ws_path(workspace)}/auditEvents/{old.id}")).status_code == 403


async def test_platform_reads_are_metadata_only(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    other = await world.make_workspace(owner)
    event = await add_audit_event(sessions, workspace, actor=owner)
    await add_audit_event(sessions, other)
    await add_audit_event(sessions, None, category="sign_in", action="CreateSession")
    operator = await client.as_(await world.platform_operator(await world.make_user()))

    across = (await operator.get("/api/v1/workspaces/-/auditEvents")).json()["auditEvents"]
    assert {e["name"].split("/")[1] for e in across} == {str(workspace.id), str(other.id)}
    assert all("target" not in e and "description" not in e for e in across)

    one = (await operator.get(f"{ws_path(workspace)}/auditEvents")).json()["auditEvents"]
    assert [e["name"] for e in one] == [f"workspaces/{workspace.id}/auditEvents/{event.id}"]
    assert "target" not in one[0]
    got = (await operator.get(f"{ws_path(workspace)}/auditEvents/{event.id}")).json()
    assert "target" not in got and "description" not in got

    admin = await client.as_(owner)
    assert (await admin.get("/api/v1/workspaces/-/auditEvents")).status_code == 403


async def test_export_audit_events(
    client: ApiClient, world: World, sessions, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await add_audit_event(sessions, workspace, actor=owner, category="people", action="CreateMember")
    await add_audit_event(sessions, workspace, action="PublishItem")
    api = await client.as_(owner)

    response = await api.post(
        f"{ws_path(workspace)}/auditEvents:export", json={"filter": "category = PEOPLE"}
    )

    assert response.status_code == 200, response.text
    operation = response.json()
    assert operation["done"] is True
    assert operation["response"]["downloadUri"]
    assert operation["response"]["expireTime"]
    key = f"exports/audit/{operation['name'].removeprefix('operations/')}.csv"
    csv = (await fakes.storage.read(key, max_bytes=1 << 20)).decode()
    lines = csv.strip().splitlines()
    assert lines[0].endswith("target,description")
    assert len(lines) == 2 and "CreateMember" in lines[1]

    operator = await client.as_(await world.platform_operator(await world.make_user()))
    platform = await operator.post("/api/v1/workspaces/-/auditEvents:export", json={})
    platform_key = f"exports/audit/{platform.json()['name'].removeprefix('operations/')}.csv"
    header = (await fakes.storage.read(platform_key, max_bytes=1 << 20)).decode().splitlines()[0]
    assert "target" not in header

    request_id = str(uuid4())
    first = await api.post(f"{ws_path(workspace)}/auditEvents:export?requestId={request_id}", json={})
    again = await api.post(f"{ws_path(workspace)}/auditEvents:export?requestId={request_id}", json={})
    assert first.json()["name"] == again.json()["name"]

    bad = await api.post(f"{ws_path(workspace)}/auditEvents:export", json={"filter": "nope = 1"})
    assert bad.status_code == 400
    member = await client.as_(await world.add_member(workspace))
    assert (await member.post(f"{ws_path(workspace)}/auditEvents:export", json={})).status_code == 403


async def test_summarize_audit_events(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    await add_audit_event(sessions, workspace, created_at=now - timedelta(days=1))
    await add_audit_event(sessions, workspace, created_at=now - timedelta(days=1, hours=1))
    await add_audit_event(sessions, workspace, category="people", created_at=now - timedelta(days=1))
    await add_audit_event(sessions, workspace, created_at=now - timedelta(days=20))
    api = await client.as_(owner)

    response = await api.get(f"{ws_path(workspace)}/auditEvents:summarize", params={"window": "P7D"})

    assert response.status_code == 200, response.text
    buckets = response.json()["buckets"]
    day = (now - timedelta(days=1)).date().isoformat()
    assert {(b["startTime"][:10], b["category"], b["eventCount"]) for b in buckets} == {
        (day, "KNOWLEDGE", "2"),
        (day, "PEOPLE", "1"),
    }
    filtered = await api.get(
        f"{ws_path(workspace)}/auditEvents:summarize",
        params={"window": "P30D", "filter": "category = KNOWLEDGE"},
    )
    assert sum(int(b["eventCount"]) for b in filtered.json()["buckets"]) == 3
    zoned = await api.get(
        f"{ws_path(workspace)}/auditEvents:summarize", params={"timeZone": "Asia/Ho_Chi_Minh"}
    )
    assert zoned.status_code == 200
    assert zoned.json()["buckets"][0]["startTime"].endswith("17:00:00Z")
    assert (
        await api.get(f"{ws_path(workspace)}/auditEvents:summarize", params={"timeZone": "Mars/Base"})
    ).status_code == 400
    assert (
        await api.get(f"{ws_path(workspace)}/auditEvents:summarize", params={"window": "P2D"})
    ).status_code == 400
    member = await client.as_(await world.add_member(workspace))
    assert (await member.get(f"{ws_path(workspace)}/auditEvents:summarize")).status_code == 403
