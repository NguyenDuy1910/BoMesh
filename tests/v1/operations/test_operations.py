"""GetOperation, ListOperations and CancelOperation: own operations only (AIP-151)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import select

from api.aip.messages import ProtoMessage
from api.dto import operations as operation_schemas
from bomesh.services.kernel.operations import OperationHandlers
from bomesh.services.operations.operations import reconcile_abandoned_operations
from bomesh.db.models import Operation
from harness import ApiClient, Sessions, World

pytestmark = pytest.mark.asyncio


def reason(response: Any) -> str | None:
    return next(
        (d["reason"] for d in response.json()["error"]["details"] if d.get("reason")), None
    )


async def test_get_returns_a_running_operation_with_metadata(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    operation = await ops.operation(owner)

    response = await (await client.as_(owner)).get(f"/api/v1/operations/{operation.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == f"operations/{operation.id}"
    assert body["done"] is False
    assert "response" not in body and "error" not in body
    # Exactly the verb's typed metadata (x-operation-info), plus @type.
    assert set(body["metadata"]) == {"@type", "createTime", "progressPercent"}
    assert body["metadata"]["@type"] == "type.googleapis.com/bomesh.v1.WorkspaceExportMetadata"
    assert body["metadata"]["progressPercent"] == 0


async def test_a_finished_export_carries_a_signed_download_uri(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    operation = await ops.operation(
        owner, finished=True, result_object_key="exports/audit/x.csv"
    )

    body = (await (await client.as_(owner)).get(f"/api/v1/operations/{operation.id}")).json()

    assert body["done"] is True
    assert body["response"]["@type"].endswith(".WorkspaceExportResponse")
    assert body["response"]["downloadUri"].startswith("https://storage.test/")
    assert "exports/audit/x.csv" in body["response"]["downloadUri"]
    assert body["response"]["expireTime"].endswith("Z")
    assert body["metadata"]["progressPercent"] == 100


class _Named(ProtoMessage):
    name: str
    display_name: str


async def test_a_resource_result_is_loaded_and_rendered_by_its_registrations(
    client: ApiClient,
    world: World,
    ops: Any,
    handlers: OperationHandlers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def load(runtime: Any, name: str) -> tuple[str, str]:
        return (name, "Acme")

    handlers.register_result("createWorkspace", load)
    monkeypatch.setitem(
        operation_schemas._RESPONSE_MESSAGES,
        "Workspace",
        lambda record: _Named(name=record[0], display_name=record[1]),
    )
    owner = await world.make_user()
    operation = await ops.operation(
        owner, verb="createWorkspace", target="workspaces/w", finished=True, result_name="workspaces/w"
    )

    body = (await (await client.as_(owner)).get(f"/api/v1/operations/{operation.id}")).json()

    assert body["response"] == {
        "@type": "type.googleapis.com/bomesh.v1.Workspace",
        "name": "workspaces/w",
        "displayName": "Acme",
    }
    assert body["metadata"] == {
        "@type": "type.googleapis.com/bomesh.v1.CreateWorkspaceMetadata",
        "workspace": "workspaces/w",
        "createTime": body["metadata"]["createTime"],
        "progressPercent": 100,
    }


async def test_someone_elses_operation_is_denied_and_a_missing_one_is_not_found(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    stranger = await world.make_user()
    operation = await ops.operation(owner)
    as_stranger = await client.as_(stranger)

    assert (await as_stranger.get(f"/api/v1/operations/{operation.id}")).status_code == 403
    assert (await as_stranger.get(f"/api/v1/operations/{uuid4()}")).status_code == 404
    assert (await client.get(f"/api/v1/operations/{operation.id}")).status_code == 401


async def test_an_expired_operation_is_not_found(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    old = datetime.now(UTC) - timedelta(days=40)
    operation = await ops.operation(
        owner, created_at=old, finished=True, result_object_key="k.csv",
        expires_at=old + timedelta(days=30),
    )
    response = await (await client.as_(owner)).get(f"/api/v1/operations/{operation.id}")
    assert response.status_code == 404


async def test_list_shows_only_own_operations_newest_first_with_paging(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    other = await world.make_user()
    now = datetime.now(UTC)
    first = await ops.operation(owner, created_at=now - timedelta(minutes=3))
    second = await ops.operation(owner, created_at=now - timedelta(minutes=2), finished=True,
                                 result_object_key="a.csv")
    third = await ops.operation(owner, created_at=now - timedelta(minutes=1))
    await ops.operation(other)
    api = await client.as_(owner)

    page = (await api.get("/api/v1/operations", params={"pageSize": 2})).json()
    assert [o["name"] for o in page["operations"]] == [
        f"operations/{third.id}", f"operations/{second.id}"
    ]
    rest = (
        await api.get("/api/v1/operations", params={"pageSize": 2, "pageToken": page["nextPageToken"]})
    ).json()
    assert [o["name"] for o in rest["operations"]] == [f"operations/{first.id}"]
    assert "nextPageToken" not in rest

    ascending = (
        await api.get("/api/v1/operations", params={"orderBy": "metadata.createTime"})
    ).json()
    assert ascending["operations"][0]["name"] == f"operations/{first.id}"


async def test_list_filters_done_verb_and_target(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    running = await ops.operation(owner)
    done = await ops.operation(owner, finished=True, result_object_key="a.csv")
    workspace_op = await ops.operation(owner, verb="exportUsage", target="workspaces/-")
    api = await client.as_(owner)

    async def names(filter: str) -> set[str]:
        response = await api.get("/api/v1/operations", params={"filter": filter})
        assert response.status_code == 200, response.text
        return {o["name"] for o in response.json()["operations"]}

    assert await names("done = true") == {f"operations/{done.id}"}
    assert await names("done = false AND metadata.verb = \"exportAuditEvents\"") == {
        f"operations/{running.id}"
    }
    assert await names('metadata.target = "workspaces/-"') == {f"operations/{workspace_op.id}"}

    bad = await api.get("/api/v1/operations", params={"filter": "state = 1"})
    assert bad.status_code == 400
    bad_order = await api.get("/api/v1/operations", params={"orderBy": "verb"})
    assert bad_order.status_code == 400


async def test_cancel_ends_the_operation_with_cancelled_and_signals_the_work(
    client: ApiClient, world: World, ops: Any, handlers: OperationHandlers, sessions: Sessions
) -> None:
    signalled: list[Operation] = []

    async def hook(runtime: Any, operation: Operation) -> None:
        signalled.append(operation)

    handlers.register_cancel("createArtifact", hook)
    owner = await world.make_user()
    operation = await ops.operation(owner, verb="createArtifact", target="workspaces/w/artifacts/a")
    api = await client.as_(owner)

    response = await api.post(f"/api/v1/operations/{operation.id}:cancel", json={})

    assert response.status_code == 200
    assert response.json() == {}
    assert [o.id for o in signalled] == [operation.id]
    body = (await api.get(f"/api/v1/operations/{operation.id}")).json()
    assert body["done"] is True
    assert body["error"]["code"] == 1
    assert body["metadata"]["artifact"] == "workspaces/w/artifacts/a"
    assert set(body["metadata"]) == {"@type", "artifact", "createTime", "progressPercent"}
    async with sessions() as session:
        row = await session.scalar(select(Operation).where(Operation.id == operation.id))
    assert row is not None and row.cancel_requested_at is not None

    again = await api.post(f"/api/v1/operations/{operation.id}:cancel", json={})
    assert again.status_code == 400
    assert again.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_cancel_refuses_kinds_without_a_cancel_hook(
    client: ApiClient, world: World, ops: Any
) -> None:
    owner = await world.make_user()
    operation = await ops.operation(owner)

    response = await (await client.as_(owner)).post(
        f"/api/v1/operations/{operation.id}:cancel", json={}
    )

    assert response.status_code == 400
    assert reason(response) == "OPERATION_NOT_CANCELLABLE"


async def test_cancel_is_owner_only(
    client: ApiClient, world: World, ops: Any, handlers: OperationHandlers
) -> None:
    async def hook(runtime: Any, operation: Operation) -> None:
        raise AssertionError("must not be signalled")

    handlers.register_cancel("createArtifact", hook)
    owner = await world.make_user()
    stranger = await world.make_user()
    operation = await ops.operation(owner, verb="createArtifact", target="workspaces/w/artifacts/a")
    api = await client.as_(stranger)

    assert (await api.post(f"/api/v1/operations/{operation.id}:cancel", json={})).status_code == 403
    assert (await api.post(f"/api/v1/operations/{uuid4()}:cancel", json={})).status_code == 404


async def test_the_startup_reconciler_fails_abandoned_operations_and_repairs_their_work(
    runtime: Any, world: World, ops: Any, handlers: OperationHandlers, sessions: Sessions
) -> None:
    repaired: list[Operation] = []

    async def abandon(runtime: Any, operation: Operation) -> None:
        repaired.append(operation)

    async def broken(runtime: Any, operation: Operation) -> None:
        raise RuntimeError("repair failed")

    handlers.register_abandon("createArtifact", abandon)
    handlers.register_abandon("reviseArtifact", broken)
    owner = await world.make_user()
    started = datetime.now(UTC)
    before = started - timedelta(minutes=5)
    abandoned = await ops.operation(
        owner, verb="createArtifact", target="workspaces/w/artifacts/a", created_at=before
    )
    revising = await ops.operation(
        owner, verb="reviseArtifact", target="workspaces/w/artifacts/b", created_at=before
    )
    export = await ops.operation(owner, created_at=before)
    finished = await ops.operation(owner, created_at=before, finished=True, result_object_key="a.csv")
    current = await ops.operation(owner, created_at=started + timedelta(seconds=1))

    failed = await reconcile_abandoned_operations(runtime, started_before=started)

    assert failed == 3
    assert [o.id for o in repaired] == [abandoned.id]
    async with sessions() as session:
        rows = {
            row.id: row
            for row in (await session.scalars(select(Operation))).all()
        }
    for operation in (abandoned, revising, export):
        row = rows[operation.id]
        assert row.finished_at is not None
        assert row.error is not None and row.error["code"] == 14  # UNAVAILABLE
    assert rows[finished.id].error is None
    assert rows[current.id].finished_at is None
