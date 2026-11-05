"""CreateSync, GetSync and ListSyncs, including ``sources/-/syncs`` (``api_design.md`` §6)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import update

from bomesh.db.models import IngestionSync
from harness import ApiClient, Fakes, Sessions, World
from sources_support import (
    Scene,
    build_scene,
    code_of,
    create_source,
    disable_connector,
    end_sync,
    pause_ingestion,
    set_connection_status,
    source_row,
    source_url,
    status,
    syncs_of,
    syncs_url,
)

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def scene(client: ApiClient, world: World, sessions: Sessions) -> Scene:
    return await build_scene(client, world, sessions)


async def _idle_source(scene: Scene, sessions: Sessions, fakes: Fakes, code: str) -> object:
    """A source whose creation sync already ended."""
    await create_source(scene.as_admin, scene, code)
    source = await source_row(sessions, scene.workspace, code)
    await end_sync(sessions, fakes.workflows, source.id)
    return source


async def test_create_sync_starts_a_manual_sync(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    source = await _idle_source(scene, sessions, fakes, "docs")

    response = await scene.as_manager.post(syncs_url(scene.workspace, "docs"), json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"].startswith(f"workspaces/{scene.workspace.id}/sources/docs/syncs/")
    assert (body["state"], body["trigger"]) == ("RUNNING", "MANUAL")
    assert body["startTime"] and "endTime" not in body
    assert (body["addedCount"], body["failedCount"], body["failures"]) == (0, 0, [])
    syncs = await syncs_of(sessions, source.id)  # type: ignore[attr-defined]
    manual = syncs[-1]
    assert (manual.trigger_type, manual.created_by_user_id) == ("manual", scene.manager.id)
    assert fakes.workflows.called("start_source_sync")[-1] == {
        "source_id": str(source.id),  # type: ignore[attr-defined]
        "tenant_id": str(scene.workspace.id),
        "sync_id": code_of(body["name"]),
    }
    got = await scene.as_admin.get(source_url(scene.workspace, "docs"))
    assert got.json()["lastSync"]["sync"] == body["name"]


async def test_create_sync_refuses_while_a_sync_runs_or_the_source_cannot_sync(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await create_source(scene.as_admin, scene, "busy")
    source = await source_row(sessions, scene.workspace, "busy")
    url = syncs_url(scene.workspace, "busy")

    running_row = await scene.as_admin.post(url, json={})
    # The row ended but the workflow is still open.
    async with sessions.begin() as session:
        await session.execute(
            update(IngestionSync)
            .where(IngestionSync.ingestion_source_id == source.id)
            .values(status="succeeded", finished_at=datetime.now(UTC))
        )
    workflow_open = await scene.as_admin.post(url, json={})
    fakes.workflows.finish_sync(source.id)
    assert (await scene.as_admin.post(source_url(scene.workspace, "busy", "pause"), json={})).status_code == 200
    paused = await scene.as_admin.post(url, json={})

    for refused in (running_row, workflow_open, paused):
        assert (refused.status_code, status(refused)) == (400, "FAILED_PRECONDITION")
    assert len(await syncs_of(sessions, source.id)) == 1


@pytest.mark.parametrize("cause", ["reauthorization", "ingestion paused", "connector disabled"])
async def test_create_sync_refuses_when_the_source_cannot_run(
    scene: Scene, sessions: Sessions, fakes: Fakes, cause: str
) -> None:
    await _idle_source(scene, sessions, fakes, "blocked")
    if cause == "reauthorization":
        await set_connection_status(sessions, scene.shared, "reauthorization_required")
    elif cause == "ingestion paused":
        await pause_ingestion(sessions, scene.workspace)
    else:
        await disable_connector(sessions, "confluence")

    response = await scene.as_admin.post(syncs_url(scene.workspace, "blocked"), json={})

    assert (response.status_code, status(response)) == (400, "FAILED_PRECONDITION")
    if cause == "ingestion paused":
        assert response.json()["error"]["message"] == "Ingestion is paused for this workspace."


async def test_create_sync_request_id_replays_and_authorization(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await _idle_source(scene, sessions, fakes, "replayed")
    url = syncs_url(scene.workspace, "replayed")
    request_id = str(uuid4())

    first = await scene.as_admin.post(url, json={}, params={"requestId": request_id})
    again = await scene.as_admin.post(url, json={}, params={"requestId": request_id})
    member = await scene.as_member.post(url, json={})
    missing = await scene.as_admin.post(syncs_url(scene.workspace, "nope"), json={})

    assert first.status_code == again.status_code == 200
    assert again.json()["name"] == first.json()["name"]
    assert (member.status_code, status(member)) == (403, "PERMISSION_DENIED")
    assert (missing.status_code, status(missing)) == (404, "NOT_FOUND")


async def test_a_sync_that_cannot_start_ends_failed(
    scene: Scene, sessions: Sessions, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = await _idle_source(scene, sessions, fakes, "unreachable")

    async def unavailable(*_: object, **__: object) -> bool:
        raise ConnectionError("Temporal is down")

    monkeypatch.setattr(type(fakes.workflows), "start_source_sync", unavailable)
    response = await scene.as_admin.post(syncs_url(scene.workspace, "unreachable"), json={})

    assert response.status_code == 200
    assert response.json()["state"] == "FAILED"
    assert response.json()["error"] == {
        "code": 14,
        "message": "The sync could not be started. Try again later.",
    }
    got = await scene.as_admin.get(source_url(scene.workspace, "unreachable"))
    assert got.json()["state"] == "FAILED"
    assert len(await syncs_of(sessions, source.id)) == 2  # type: ignore[attr-defined]


async def test_get_sync(scene: Scene, sessions: Sessions, fakes: Fakes) -> None:
    created = await create_source(scene.as_admin, scene, "read")
    name = created["lastSync"]["sync"]
    url = syncs_url(scene.workspace, "read", code_of(name))
    await create_source(scene.as_admin, scene, "other")

    got = await scene.as_manager.get(url)
    member = await scene.as_member.get(url)
    unknown = await scene.as_admin.get(syncs_url(scene.workspace, "read", str(uuid4())))
    other_source = await scene.as_admin.get(syncs_url(scene.workspace, "other", code_of(name)))
    bad_id = await scene.as_admin.get(syncs_url(scene.workspace, "read", "not-a-uuid"))

    assert got.status_code == 200
    assert (got.json()["name"], got.json()["trigger"]) == (name, "CREATION")
    assert member.status_code == 403
    assert unknown.status_code == other_source.status_code == 404
    assert (bad_id.status_code, status(bad_id)) == (400, "INVALID_ARGUMENT")


async def test_list_syncs_of_a_source_and_across_sources(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    first = await _idle_source(scene, sessions, fakes, "first")
    second = await _idle_source(scene, sessions, fakes, "second")
    manual = await scene.as_admin.post(syncs_url(scene.workspace, "first"), json={})
    assert manual.status_code == 200
    await end_sync(sessions, fakes.workflows, first.id, failed=True)  # type: ignore[attr-defined]
    # Make start times distinct and ordered: first's creation, second's, first's manual.
    base = datetime.now(UTC) - timedelta(hours=1)
    async with sessions.begin() as session:
        for offset, (source, trigger) in enumerate(
            [(first, "creation"), (second, "creation"), (first, "manual")]
        ):
            await session.execute(
                update(IngestionSync)
                .where(
                    IngestionSync.ingestion_source_id == source.id,  # type: ignore[attr-defined]
                    IngestionSync.trigger_type == trigger,
                )
                .values(started_at=base + timedelta(minutes=offset))
            )
    await create_source(scene.as_admin, scene, "deleted")
    assert (await scene.as_admin.delete(source_url(scene.workspace, "deleted"))).status_code == 200

    one = await scene.as_admin.get(syncs_url(scene.workspace, "first"))
    across = await scene.as_admin.get(syncs_url(scene.workspace, "-"), params={"pageSize": 2})
    rest = await scene.as_admin.get(
        syncs_url(scene.workspace, "-"),
        params={"pageSize": 2, "pageToken": across.json()["nextPageToken"]},
    )
    oldest_first = await scene.as_admin.get(
        syncs_url(scene.workspace, "-"), params={"orderBy": "startTime"}
    )
    manual_only = await scene.as_admin.get(
        syncs_url(scene.workspace, "-"), params={"filter": "trigger = MANUAL"}
    )
    failed_only = await scene.as_admin.get(
        syncs_url(scene.workspace, "-"), params={"filter": "state = FAILED"}
    )
    of_second = await scene.as_admin.get(
        syncs_url(scene.workspace, "-"),
        params={"filter": f'source = "workspaces/{scene.workspace.id}/sources/second"'},
    )
    member = await scene.as_member.get(syncs_url(scene.workspace, "-"))
    missing = await scene.as_admin.get(syncs_url(scene.workspace, "nope"))
    bad_order = await scene.as_admin.get(
        syncs_url(scene.workspace, "-"), params={"orderBy": "colour"}
    )

    def sources_of(response: object) -> list[str]:
        return [
            sync["name"].split("/")[3]
            for sync in response.json()["syncs"]  # type: ignore[attr-defined]
        ]

    assert [sync["trigger"] for sync in one.json()["syncs"]] == ["MANUAL", "CREATION"]
    assert one.json()["totalSize"] == 2
    assert across.json()["totalSize"] == 3
    assert sources_of(across) == ["first", "second"]
    assert sources_of(rest) == ["first"]
    assert sources_of(oldest_first) == ["first", "second", "first"]
    assert [sync["trigger"] for sync in manual_only.json()["syncs"]] == ["MANUAL"]
    assert sources_of(failed_only) == ["first"]
    assert sources_of(of_second) == ["second"]
    assert member.status_code == 403
    assert missing.status_code == 404
    assert (bad_order.status_code, status(bad_order)) == (400, "INVALID_ARGUMENT")
