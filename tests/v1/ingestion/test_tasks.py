"""GetIngestionTask and ListIngestionTasks: the Item visibility rule and metadata-only platform reads."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio

from harness import ApiClient, Sessions, World
from runs_support import (
    Scene,
    build_scene,
    document,
    item_ref,
    run_id_of,
    runs_url,
    set_task,
)

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def scene(client: ApiClient, world: World, sessions: Sessions) -> Scene:
    return await build_scene(client, world, sessions)


async def _run(scene: Scene, *items: Any) -> UUID:
    response = await scene.as_admin.post(
        runs_url(scene.workspace), json={"selector": {"items": [item_ref(item) for item in items]}}
    )
    assert response.status_code == 200, response.text
    return run_id_of(response.json())


def _tasks_url(scene: Scene, run: UUID | str, *rest: str) -> str:
    return runs_url(scene.workspace, str(run), "tasks", *rest)


def _items(response: Any) -> set[str]:
    return {task["item"] for task in response.json()["tasks"]}


async def test_tasks_follow_the_item_visibility_rule(scene: Scene, sessions: Sessions) -> None:
    published = await document(sessions, scene.handbook)
    unpublished = await document(sessions, scene.handbook, published=False)
    board = await document(sessions, scene.board)
    run_id = await _run(scene, published, unpublished, board)

    viewer = await scene.as_viewer.get(_tasks_url(scene, run_id))
    editor = await scene.as_editor.get(_tasks_url(scene, run_id))
    outsider = await scene.as_outsider.get(_tasks_url(scene, run_id))

    assert viewer.status_code == 200
    assert _items(viewer) == {item_ref(published)}
    assert _items(editor) == {item_ref(published), item_ref(unpublished), item_ref(board)}
    # Without tasks.list anywhere a member is denied, not shown an empty page.
    assert outsider.status_code == 403
    hidden = await scene.as_viewer.get(_tasks_url(scene, run_id, str(unpublished.id)))
    assert hidden.status_code == 404
    shown = await scene.as_editor.get(_tasks_url(scene, run_id, str(unpublished.id)))
    assert shown.status_code == 200
    body = shown.json()
    assert body["name"] == (
        f"workspaces/{scene.workspace.id}/ingestionRuns/{run_id}/tasks/{unpublished.id}"
    )
    assert body["item"] == item_ref(unpublished)
    assert body["state"] == "QUEUED" and body["phase"] == "QUEUED" and body["phases"] == []
    missing = await scene.as_editor.get(_tasks_url(scene, run_id, str(uuid4())))
    assert missing.status_code == 404
    assert (await scene.as_editor.get(_tasks_url(scene, uuid4()))).status_code == 404
    stranger = await scene.as_viewer.get(
        runs_url(str(uuid4()), str(run_id), "tasks")
    )
    assert stranger.status_code == 403


async def test_a_task_shows_its_revision_phases_and_error_class(
    scene: Scene, sessions: Sessions
) -> None:
    doc = await document(sessions, scene.handbook)
    run_id = await _run(scene, doc)
    start = datetime.now(UTC) - timedelta(minutes=1)
    stamps = [(start + timedelta(seconds=step)).isoformat() for step in range(5)]
    await set_task(
        sessions,
        run_id,
        doc.id,
        status="failed",
        revision_number=1,
        error={"code": 13, "message": "The file could not be read."},
        error_class="unsupported_format",
        started_at=start,
        finished_at=start + timedelta(seconds=5),
        phases=[
            {"phase": "downloading", "started_at": stamps[0], "finished_at": stamps[1]},
            {"phase": "expanding", "started_at": stamps[1], "finished_at": stamps[2]},
            {"phase": "parsing", "started_at": stamps[2], "finished_at": stamps[3]},
            {"phase": "embedding", "started_at": stamps[3], "finished_at": stamps[4]},
        ],
    )

    body = (await scene.as_editor.get(_tasks_url(scene, run_id, str(doc.id)))).json()

    assert body["state"] == "FAILED"
    assert body["revision"] == f"{item_ref(doc)}/revisions/1"
    assert body["errorClass"] == "unsupported_format"
    assert body["error"]["message"] == "The file could not be read."
    assert body["phase"] == "EMBEDDING"
    assert [(phase["phase"], phase["state"]) for phase in body["phases"]] == [
        ("FETCHING", "SUCCEEDED"),
        ("PARSING", "SUCCEEDED"),
        ("EMBEDDING", "FAILED"),
    ]
    parsing = body["phases"][1]
    assert parsing["startTime"] < parsing["endTime"]
    assert body["startTime"].endswith("Z") and body["endTime"].endswith("Z")


async def test_platform_callers_read_every_task_as_metadata(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    unpublished = await document(sessions, scene.handbook, published=False)
    run_id = await _run(scene, unpublished)
    await set_task(sessions, run_id, unpublished.id, revision_number=1)
    other_admin = await world.make_user()
    other = await world.make_workspace(other_admin)
    other_doc = await document(sessions, await world.make_collection(other))
    created = await (await client.as_(other_admin)).post(
        runs_url(other), json={"selector": {"items": [item_ref(other_doc)]}}
    )
    assert created.status_code == 200

    listed = await scene.as_operator.get(_tasks_url(scene, run_id))
    single = await scene.as_operator.get(_tasks_url(scene, run_id, str(unpublished.id)))
    across = await scene.as_operator.get(runs_url("-", "-", "tasks"))
    one_run = await scene.as_operator.get(runs_url("-", str(run_id), "tasks"))

    assert [task["name"].rsplit("/", 1)[-1] for task in listed.json()["tasks"]] == [
        str(unpublished.id)
    ]
    for task in [*listed.json()["tasks"], single.json(), *across.json()["tasks"]]:
        assert "item" not in task and "revision" not in task
    assert {task["name"].split("/")[1] for task in across.json()["tasks"]} == {
        str(scene.workspace.id),
        str(other.id),
    }
    assert len(one_run.json()["tasks"]) == 1
    # Members read only inside their workspace, never across workspaces.
    assert (await scene.as_admin.get(runs_url("-", "-", "tasks"))).status_code == 403
    across_runs = await scene.as_viewer.get(runs_url(scene.workspace, "-", "tasks"))
    assert across_runs.status_code == 200 and across_runs.json()["tasks"] == []


async def test_tasks_need_the_task_permission_before_the_run_is_looked_up(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    doc = await document(sessions, scene.handbook)
    run_id = await _run(scene, doc)
    reader_role = await world.make_role(scene.workspace, "reader", ("items.get", "items.list"))
    reader = await world.add_member(scene.workspace)
    await world.grant(reader, reader_role, on=scene.handbook)
    as_reader = await client.as_(reader)

    # The reader sees the item but holds no tasks.* permission.
    assert (await as_reader.get(_tasks_url(scene, run_id))).status_code == 403
    assert (await as_reader.get(_tasks_url(scene, run_id, str(doc.id)))).status_code == 403
    # Denied before the run is looked up: a missing run answers like an existing one.
    assert (await scene.as_outsider.get(_tasks_url(scene, uuid4()))).status_code == 403
    assert (
        await scene.as_outsider.get(_tasks_url(scene, uuid4(), str(doc.id)))
    ).status_code == 403
    # Holding tasks.* on another collection does not reach the handbook's tasks.
    board_only = await world.add_member(scene.workspace)
    await world.grant(board_only, "roles/collectionViewer", on=scene.board)
    await world.grant(board_only, reader_role, on=scene.handbook)
    listed = await (await client.as_(board_only)).get(_tasks_url(scene, run_id))
    assert listed.status_code == 200 and listed.json()["tasks"] == []


async def test_platform_callers_never_read_task_error_details(
    scene: Scene, sessions: Sessions
) -> None:
    doc = await document(sessions, scene.handbook)
    run_id = await _run(scene, doc)
    detail = "Member 'payroll/2026/salaries.xlsx' of the archive could not be read."
    await set_task(
        sessions,
        run_id,
        doc.id,
        status="failed",
        error={"code": 3, "message": detail},
        error_class="unsupported_format",
    )

    member = (await scene.as_editor.get(_tasks_url(scene, run_id, str(doc.id)))).json()
    platform = (await scene.as_operator.get(_tasks_url(scene, run_id, str(doc.id)))).json()
    across = (await scene.as_operator.get(runs_url("-", "-", "tasks"))).json()["tasks"]

    assert member["error"]["message"] == detail
    for task in (platform, *across):
        assert task["error"] == {"code": 3, "message": "The document could not be processed."}
        assert task["errorClass"] == "unsupported_format"


async def test_list_pages_and_filters_tasks(scene: Scene, sessions: Sessions) -> None:
    docs = [await document(sessions, scene.handbook) for _ in range(3)]
    run_id = await _run(scene, *docs)
    await set_task(sessions, run_id, docs[0].id, status="failed", error_class="internal")
    url = _tasks_url(scene, run_id)

    first = (await scene.as_editor.get(url, params={"pageSize": 2})).json()
    second = (
        await scene.as_editor.get(url, params={"pageSize": 2, "pageToken": first["nextPageToken"]})
    ).json()
    failed = (await scene.as_editor.get(url, params={"filter": "state = FAILED"})).json()
    by_class = (await scene.as_editor.get(url, params={"filter": 'errorClass = "internal"'})).json()

    assert len(first["tasks"]) == 2 and len(second["tasks"]) == 1
    assert {task["item"] for task in first["tasks"] + second["tasks"]} == {
        item_ref(doc) for doc in docs
    }
    assert [task["item"] for task in failed["tasks"]] == [item_ref(docs[0])]
    assert [task["item"] for task in by_class["tasks"]] == [item_ref(docs[0])]
    assert (await scene.as_editor.get(url, params={"filter": "item = x"})).status_code == 400
    assert (await scene.as_editor.get(url, params={"orderBy": "endTime desc"})).status_code == 200
