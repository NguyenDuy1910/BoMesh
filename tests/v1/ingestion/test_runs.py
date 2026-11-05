"""CreateIngestionRun, Get/List, Cancel, Retry and Summarize ingestion runs (``api_design.md`` §6)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import func, select

from bomesh.db.models import (
    AuditLog,
    ExternalResource,
    IngestionRun,
    IngestionSource,
    IntegrationConnection,
)
from bomesh.runtime import AppRuntime
from harness import ApiClient, Fakes, Sessions, World
from runs_support import (
    Scene,
    attach_to_conversation,
    build_scene,
    document,
    item_ref,
    pause_ingestion,
    reason,
    run_id_of,
    runs_url,
    set_run,
    set_task,
    task_items,
)

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def scene(client: ApiClient, world: World, sessions: Sessions) -> Scene:
    return await build_scene(client, world, sessions)


async def _create(api: ApiClient, scene: Scene, body: dict[str, Any], **params: Any) -> Any:
    return await api.post(runs_url(scene.workspace), json=body, params=params)


def _started(fakes: Fakes) -> list[str]:
    return [call["run_id"] for method, call in fakes.workflows.calls if method == "start_run"]


# -- Create: selection ---------------------------------------------------------


async def test_an_ancestor_run_snapshots_its_waiting_subtree_and_starts_the_workflow(
    scene: Scene, sessions: Sessions, fakes: Fakes, runtime: AppRuntime
) -> None:
    current = runtime.processing_version()
    pending = await document(sessions, scene.handbook)
    nested = await document(sessions, scene.policies)
    outdated = await document(
        sessions, scene.handbook, index_status="ready", processed_version="parser=old"
    )
    await document(sessions, scene.handbook, index_status="ready", processed_version=current)
    await document(sessions, scene.handbook, index_status="failed")
    await document(sessions, scene.board)

    response = await _create(
        scene.as_editor,
        scene,
        {
            "selector": {"ancestor": item_ref(scene.handbook), "states": ["PENDING", "OUTDATED"]},
            "trigger": "API",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    run_id = run_id_of(body)
    assert body["name"] == f"workspaces/{scene.workspace.id}/ingestionRuns/{run_id}"
    assert body["state"] == "QUEUED" and body["trigger"] == "API"
    assert body["selector"] == {
        "ancestor": item_ref(scene.handbook),
        "states": ["PENDING", "OUTDATED"],
    }
    assert body["counts"]["totalCount"] == 3 and body["counts"]["queuedCount"] == 3
    assert body["createTime"].endswith("Z") and "error" not in body
    assert set(await task_items(sessions, run_id)) == {pending.id, nested.id, outdated.id}
    assert fakes.workflows.calls[-1] == (
        "start_run",
        {"run_id": str(run_id), "tenant_id": str(scene.workspace.id)},
    )
    async with sessions.begin() as session:
        action = await session.scalar(
            select(AuditLog.action).where(AuditLog.target_name == body["name"])
        )
    assert action == "CreateIngestionRun"


async def test_explicit_items_are_checked_one_by_one(scene: Scene, sessions: Sessions) -> None:
    mine = await document(sessions, scene.handbook)
    readable_only = await document(sessions, scene.board)
    hidden = await document(sessions, scene.board, published=False)

    # Readable but not processable, invisible, or absent: PERMISSION_DENIED.
    for item in (item_ref(readable_only), item_ref(hidden), f"workspaces/{scene.workspace.id}/items/{uuid4()}"):
        response = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(mine), item]}})
        assert response.status_code == 403, item
    collection = await _create(
        scene.as_editor, scene, {"selector": {"items": [item_ref(scene.handbook)]}}
    )
    assert collection.status_code == 400
    elsewhere = await _create(
        scene.as_editor, scene, {"selector": {"items": [f"workspaces/{uuid4()}/items/{mine.id}"]}}
    )
    assert elsewhere.status_code == 400

    response = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(mine)]}})
    assert response.status_code == 200
    assert set(await task_items(sessions, run_id_of(response.json()))) == {mine.id}
    assert response.json()["selector"]["items"] == [item_ref(mine)]


async def test_ancestor_source_and_states_silently_narrow_to_processable_collections(
    scene: Scene, sessions: Sessions, fakes: Fakes, world: World
) -> None:
    handbook_document = await document(sessions, scene.handbook)
    await document(sessions, scene.board)
    await document(sessions, scene.board)

    by_state = await _create(scene.as_editor, scene, {"selector": {"states": ["PENDING"]}})
    assert set(await task_items(sessions, run_id_of(by_state.json()))) == {handbook_document.id}

    # A readable subtree the editor may not process: an empty run that is already done.
    board = await _create(scene.as_editor, scene, {"selector": {"ancestor": item_ref(scene.board)}})
    assert board.status_code == 200
    assert board.json()["state"] == "SUCCEEDED"
    assert board.json()["counts"]["totalCount"] == 0
    assert "endTime" in board.json()
    assert str(run_id_of(board.json())) not in _started(fakes)

    # Nobody processes what nobody may read; a document is no ancestor.
    unreadable = await world.make_collection(scene.workspace, title="Secret")
    assert (
        await _create(scene.as_editor, scene, {"selector": {"ancestor": item_ref(unreadable)}})
    ).status_code == 403
    assert (
        await _create(
            scene.as_editor, scene, {"selector": {"ancestor": item_ref(handbook_document)}}
        )
    ).status_code == 400
    # A source the caller cannot read (sources.get) or that does not exist.
    for caller in (scene.as_editor, scene.as_admin):
        response = await _create(
            caller,
            scene,
            {"selector": {"source": f"workspaces/{scene.workspace.id}/sources/missing"}},
        )
        assert response.status_code == 403


async def test_a_source_selector_takes_what_the_source_registered(
    scene: Scene, sessions: Sessions
) -> None:
    synced = await document(sessions, scene.handbook)
    await document(sessions, scene.handbook)
    async with sessions.begin() as session:
        connection = IntegrationConnection(
            tenant_id=scene.workspace.id,
            code=f"c{uuid4().hex[:12]}",
            connector_key="confluence",
            display_name="Wiki",
        )
        session.add(connection)
        await session.flush()
        source = IngestionSource(
            tenant_id=scene.workspace.id,
            code="wiki",
            integration_connection_id=connection.id,
            target_item_id=scene.handbook.id,
        )
        session.add(source)
        await session.flush()
        session.add(
            ExternalResource(item_id=synced.id, ingestion_source_id=source.id, external_id="p1")
        )
    name = f"workspaces/{scene.workspace.id}/sources/wiki"

    response = await _create(scene.as_admin, scene, {"selector": {"source": name}})

    assert response.status_code == 200, response.text
    assert response.json()["selector"] == {"source": name}
    assert set(await task_items(sessions, run_id_of(response.json()))) == {synced.id}
    # Without sources.get the source is unreadable, even to a collection editor.
    assert (await _create(scene.as_editor, scene, {"selector": {"source": name}})).status_code == 403


async def test_attachments_artifacts_unsupported_unavailable_and_personal_are_never_selected(
    scene: Scene, sessions: Sessions
) -> None:
    shared = await document(sessions, scene.handbook)
    attached = await document(sessions, scene.handbook)
    await attach_to_conversation(
        sessions, attached, owner=scene.editor, session_id=scene.as_editor.session_id
    )
    await document(sessions, scene.artifacts)
    await document(sessions, scene.handbook, index_status="unsupported")
    await document(sessions, scene.handbook, status="pending")
    await document(sessions, scene.handbook, stored=False)
    personal = await document(sessions, scene.personal)

    workspace_wide = await _create(scene.as_admin, scene, {"selector": {"states": ["PENDING"]}})
    assert set(await task_items(sessions, run_id_of(workspace_wide.json()))) == {shared.id}

    # Named by item or ancestor, a personal document is its owner's to process.
    await set_run(sessions, run_id_of(workspace_wide.json()), status="succeeded")
    by_item = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(personal)]}})
    assert set(await task_items(sessions, run_id_of(by_item.json()))) == {personal.id}
    await set_run(sessions, run_id_of(by_item.json()), status="succeeded")
    by_ancestor = await _create(
        scene.as_editor, scene, {"selector": {"ancestor": item_ref(scene.personal)}}
    )
    assert set(await task_items(sessions, run_id_of(by_ancestor.json()))) == {personal.id}
    # An explicit attachment is silently left out.
    attachment = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(attached)]}})
    assert attachment.status_code == 200
    assert attachment.json()["counts"]["totalCount"] == 0


async def test_the_snapshot_is_fixed_and_documents_held_by_an_active_run_are_left_out(
    scene: Scene, sessions: Sessions
) -> None:
    before = await document(sessions, scene.handbook)
    first = await _create(scene.as_editor, scene, {"selector": {"ancestor": item_ref(scene.handbook)}})
    later = await document(sessions, scene.handbook)

    assert set(await task_items(sessions, run_id_of(first.json()))) == {before.id}
    second = await _create(scene.as_editor, scene, {"selector": {"ancestor": item_ref(scene.handbook)}})
    assert set(await task_items(sessions, run_id_of(second.json()))) == {later.id}


async def test_a_selector_is_required_and_validated(scene: Scene) -> None:
    cases = [
        {},
        {"selector": {}},
        {"selector": {"states": ["DONE"]}},
        {"selector": {"items": [f"workspaces/{scene.workspace.id}/items/{uuid4()}" for _ in range(1001)]}},
        {"selector": {"states": ["PENDING"]}, "trigger": "SCHEDULE"},
        {"selector": {"states": ["PENDING"]}, "trigger": "PLATFORM_RETRY"},
    ]
    for body in cases:
        response = await _create(scene.as_editor, scene, body)
        assert response.status_code == 400, (body, response.text)
    # Someone who may process nothing is told so first, whatever the selector.
    assert (await _create(scene.as_outsider, scene, {})).status_code == 403
    assert (await _create(scene.as_viewer, scene, {"selector": {"states": ["PENDING"]}})).status_code == 403


async def test_paused_ingestion_is_a_failed_precondition(scene: Scene, sessions: Sessions) -> None:
    await document(sessions, scene.handbook)
    await pause_ingestion(sessions, scene.workspace)

    response = await _create(scene.as_editor, scene, {"selector": {"states": ["PENDING"]}})

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert response.json()["error"]["message"] == "Ingestion is paused for this workspace."


async def test_a_workflow_that_cannot_start_fails_the_run_unavailable(
    scene: Scene, sessions: Sessions, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    doc = await document(sessions, scene.handbook)

    async def unavailable(self: Any, run_id: Any, tenant_id: Any) -> None:
        raise RuntimeError("temporal is down")

    monkeypatch.setattr(type(fakes.workflows), "start_run", unavailable)
    response = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(doc)]}})

    assert response.status_code == 503
    assert response.json()["error"]["status"] == "UNAVAILABLE"
    runs = (await scene.as_admin.get(runs_url(scene.workspace))).json()["ingestionRuns"]
    assert [(run["state"], run["error"]["code"]) for run in runs] == [("FAILED", 14)]
    # The failed run holds nothing: the document can be processed again.
    monkeypatch.undo()
    again = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(doc)]}})
    assert again.json()["counts"]["totalCount"] == 1


async def test_request_id_replays_and_validate_only_writes_nothing(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await document(sessions, scene.handbook)
    request_id = str(uuid4())
    body = {"selector": {"states": ["PENDING"]}}

    preview = await _create(scene.as_editor, scene, body, validateOnly="true")
    assert preview.status_code == 200 and preview.json()["counts"]["totalCount"] == 1
    first = await _create(scene.as_editor, scene, body, requestId=request_id)
    again = await _create(scene.as_editor, scene, body, requestId=request_id)
    other = await _create(
        scene.as_editor, scene, {"selector": {"states": ["FAILED"]}}, requestId=request_id
    )

    assert first.json()["name"] == again.json()["name"]
    assert again.json()["counts"]["totalCount"] == 1
    assert other.status_code == 400 and reason(other) == "REQUEST_ID_REUSED"
    assert _started(fakes) == [str(run_id_of(first.json()))]
    async with sessions.begin() as session:
        assert await session.scalar(select(func.count()).select_from(IngestionRun)) == 1


async def test_the_platform_console_retries_failed_work_as_metadata(
    scene: Scene, sessions: Sessions
) -> None:
    failed = await document(sessions, scene.handbook, index_status="failed")
    failed_elsewhere = await document(sessions, scene.board, index_status="failed")
    await document(sessions, scene.personal, index_status="failed")
    await document(sessions, scene.handbook)

    response = await _create(
        scene.as_operator,
        scene,
        {"selector": {"states": ["FAILED"]}, "trigger": "PLATFORM_RETRY"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["trigger"] == "PLATFORM_RETRY"
    assert "selector" not in body and "error" not in body
    assert body["counts"]["totalCount"] == 2
    assert set(await task_items(sessions, run_id_of(body))) == {failed.id, failed_elsewhere.id}
    # Platform callers can name no item, collection or source.
    for selector in (
        {"items": [item_ref(failed)]},
        {"ancestor": item_ref(scene.handbook)},
        {"source": f"workspaces/{scene.workspace.id}/sources/wiki"},
    ):
        assert (await _create(scene.as_operator, scene, {"selector": selector})).status_code == 403


# -- Get and List ----------------------------------------------------------------


async def test_reading_runs_needs_ingestion_runs_get_and_counts_only_visible_items(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    published = await document(sessions, scene.handbook)
    unpublished = await document(sessions, scene.handbook, published=False)
    board = await document(sessions, scene.board)
    created = await _create(
        scene.as_admin,
        scene,
        {"selector": {"items": [item_ref(published), item_ref(unpublished), item_ref(board)]}},
    )
    url = runs_url(scene.workspace, str(run_id_of(created.json())))
    role = await world.make_role(scene.workspace, "runreader", ["ingestionRuns.get", "ingestionRuns.list"])
    reader = await world.add_member(scene.workspace, role=role)
    await world.grant(reader, "roles/collectionViewer", on=scene.handbook)
    as_reader = await client.as_(reader)

    admin_view = (await scene.as_admin.get(url)).json()
    reader_view = (await as_reader.get(url)).json()
    operator_view = (await scene.as_operator.get(url)).json()

    assert admin_view["counts"]["totalCount"] == 3
    assert len(admin_view["selector"]["items"]) == 3
    assert reader_view["counts"]["totalCount"] == 1
    assert reader_view["selector"]["items"] == [item_ref(published)]
    assert operator_view["counts"]["totalCount"] == 3
    assert "selector" not in operator_view and "error" not in operator_view
    assert (await scene.as_editor.get(url)).status_code == 403
    assert (await scene.as_editor.get(runs_url(scene.workspace))).status_code == 403
    assert (await scene.as_admin.get(runs_url(scene.workspace, str(uuid4())))).status_code == 404
    assert (await scene.as_admin.get(runs_url(scene.workspace, "not-a-run"))).status_code == 400


async def test_the_selector_ancestor_is_echoed_only_to_readers_of_it(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    await document(sessions, scene.board)
    created = await _create(
        scene.as_admin, scene, {"selector": {"ancestor": item_ref(scene.board)}}
    )
    assert created.status_code == 200, created.text
    url = runs_url(scene.workspace, str(run_id_of(created.json())))
    role = await world.make_role(
        scene.workspace, "runreader", ["ingestionRuns.get", "ingestionRuns.list"]
    )
    reader = await world.add_member(scene.workspace, role=role)
    board_reader = await world.add_member(scene.workspace, role=role)
    await world.grant(board_reader, "roles/collectionViewer", on=scene.board)

    hidden = (await (await client.as_(reader)).get(url)).json()
    shown = (await (await client.as_(board_reader)).get(url)).json()
    listed = (await (await client.as_(reader)).get(runs_url(scene.workspace))).json()

    assert "ancestor" not in hidden.get("selector", {})
    assert "ancestor" not in listed["ingestionRuns"][0].get("selector", {})
    assert shown["selector"]["ancestor"] == item_ref(scene.board)


async def test_a_stale_run_whose_workflow_is_gone_reads_as_failed(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    doc = await document(sessions, scene.handbook)
    created = await _create(scene.as_admin, scene, {"selector": {"items": [item_ref(doc)]}})
    run_id = run_id_of(created.json())
    await set_run(sessions, run_id, updated_at=datetime.now(UTC) - timedelta(minutes=10))
    fakes.workflows.open_runs.clear()

    body = (await scene.as_admin.get(runs_url(scene.workspace, str(run_id)))).json()

    assert body["state"] == "FAILED"
    assert body["error"]["message"] == "Processing stopped unexpectedly."
    assert body["counts"]["cancelledCount"] == 1


async def test_list_pages_filters_and_orders_runs(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    names = []
    for _ in range(3):
        doc = await document(sessions, scene.handbook)
        created = await _create(scene.as_admin, scene, {"selector": {"items": [item_ref(doc)]}})
        names.append(created.json()["name"])
    await set_run(sessions, run_id_of({"name": names[0]}), status="cancelled")
    url = runs_url(scene.workspace)

    first = (await scene.as_admin.get(url, params={"pageSize": 2})).json()
    second = (
        await scene.as_admin.get(
            url, params={"pageSize": 2, "pageToken": first["nextPageToken"]}
        )
    ).json()
    oldest_first = (await scene.as_admin.get(url, params={"orderBy": "createTime"})).json()
    cancelled = (await scene.as_admin.get(url, params={"filter": "state = CANCELLED"})).json()
    manual = (await scene.as_admin.get(url, params={"filter": "trigger = MANUAL"})).json()

    assert [run["name"] for run in first["ingestionRuns"] + second["ingestionRuns"]] == names[::-1]
    assert "nextPageToken" not in second
    assert [run["name"] for run in oldest_first["ingestionRuns"]] == names
    assert [run["name"] for run in cancelled["ingestionRuns"]] == [names[0]]
    assert len(manual["ingestionRuns"]) == 3
    assert (await scene.as_admin.get(url, params={"filter": "owner = x"})).status_code == 400
    assert (await scene.as_admin.get(url, params={"orderBy": "state"})).status_code == 400


async def test_platform_callers_list_runs_across_workspaces_and_members_cannot(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    doc = await document(sessions, scene.handbook)
    await _create(scene.as_admin, scene, {"selector": {"items": [item_ref(doc)]}})
    other_admin = await world.make_user()
    other = await world.make_workspace(other_admin)
    other_root = await world.make_collection(other)
    other_doc = await document(sessions, other_root)
    await (await client.as_(other_admin)).post(
        runs_url(other), json={"selector": {"items": [item_ref(other_doc)]}}
    )

    across = await scene.as_operator.get(runs_url("-"))

    assert across.status_code == 200
    runs = across.json()["ingestionRuns"]
    assert {run["name"].split("/")[1] for run in runs} == {str(scene.workspace.id), str(other.id)}
    assert all("selector" not in run and "error" not in run for run in runs)
    assert (await scene.as_admin.get(runs_url("-"))).status_code == 403


# -- Cancel and retry --------------------------------------------------------------


async def test_cancel_moves_an_active_run_to_cancelled_once(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    doc = await document(sessions, scene.handbook)
    created = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(doc)]}})
    run_id = run_id_of(created.json())
    url = runs_url(scene.workspace, f"{run_id}:cancel")

    assert (await scene.as_editor.post(url, json={})).status_code == 403
    response = await scene.as_admin.post(url, json={})

    assert response.status_code == 200
    assert response.json()["state"] == "CANCELLED"
    assert response.json()["counts"]["cancelledCount"] == 1
    assert ("cancel_run", {"run_id": str(run_id)}) in fakes.workflows.calls
    again = await scene.as_admin.post(url, json={})
    assert again.status_code == 400 and again.json()["error"]["status"] == "FAILED_PRECONDITION"
    missing = await scene.as_admin.post(runs_url(scene.workspace, f"{uuid4()}:cancel"), json={})
    assert missing.status_code == 404


async def test_retry_takes_failed_and_cancelled_tasks_into_a_new_run(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    done = await document(sessions, scene.handbook)
    broken = await document(sessions, scene.handbook)
    stopped = await document(sessions, scene.handbook)
    board = await document(sessions, scene.board)
    created = await _create(
        scene.as_admin,
        scene,
        {"selector": {"items": [item_ref(item) for item in (done, broken, stopped, board)]}},
    )
    run_id = run_id_of(created.json())
    url = runs_url(scene.workspace, f"{run_id}:retry")

    running = await scene.as_admin.post(url, json={})
    assert running.status_code == 400 and running.json()["error"]["status"] == "FAILED_PRECONDITION"

    await set_run(sessions, run_id, status="failed")
    await set_task(sessions, run_id, done.id, status="succeeded")
    await set_task(sessions, run_id, broken.id, status="failed")
    await set_task(sessions, run_id, stopped.id, status="cancelled")
    await set_task(sessions, run_id, board.id, status="failed")
    request_id = str(uuid4())

    # The editor may only process the handbook: the board document is left out.
    retried = await scene.as_editor.post(url, json={}, params={"requestId": request_id})
    replayed = await scene.as_editor.post(url, json={}, params={"requestId": request_id})

    assert retried.status_code == 200, retried.text
    body = retried.json()
    assert body["retryOf"] == f"workspaces/{scene.workspace.id}/ingestionRuns/{run_id}"
    assert body["trigger"] == "MANUAL" and body["state"] == "QUEUED"
    assert set(await task_items(sessions, run_id_of(body))) == {broken.id, stopped.id}
    assert replayed.json()["name"] == body["name"]
    assert _started(fakes).count(str(run_id_of(body))) == 1
    assert (await scene.as_outsider.post(url, json={})).status_code == 403


# -- Summarize ---------------------------------------------------------------------


async def test_summarize_reports_queue_throughput_failures_and_error_classes(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    docs = [await document(sessions, scene.handbook) for _ in range(5)]
    created = await _create(
        scene.as_admin, scene, {"selector": {"items": [item_ref(doc) for doc in docs]}}
    )
    run_id = run_id_of(created.json())
    now = datetime.now(UTC)
    for doc in docs[:2]:
        await set_task(sessions, run_id, doc.id, status="succeeded", finished_at=now)
    await set_task(
        sessions, run_id, docs[2].id, status="failed", error_class="unsupported_format", finished_at=now
    )
    await set_task(sessions, run_id, docs[3].id, status="running")
    other = await world.make_workspace(await world.make_user())
    url = runs_url(scene.workspace) + ":summarize"

    mine = await scene.as_admin.get(url)
    across = await scene.as_operator.get(runs_url("-") + ":summarize")
    future = await scene.as_admin.get(
        url, params={"filter": f'createTime >= "{(now + timedelta(hours=1)).isoformat()}"'}
    )

    assert mine.status_code == 200, mine.text
    (summary,) = mine.json()["workspaceSummaries"]
    assert summary == {
        "workspace": f"workspaces/{scene.workspace.id}",
        "queuedTaskCount": 1,
        "runningTaskCount": 1,
        "throughputPerHour": 2.0,
        "failureRate": pytest.approx(1 / 3),
        "errorClasses": [{"errorClass": "unsupported_format", "taskCount": 1}],
    }
    rows = {row["workspace"]: row for row in across.json()["workspaceSummaries"]}
    assert set(rows) >= {f"workspaces/{scene.workspace.id}", f"workspaces/{other.id}"}
    assert rows[f"workspaces/{other.id}"]["queuedTaskCount"] == 0
    assert future.json()["workspaceSummaries"][0]["queuedTaskCount"] == 0
    assert (await scene.as_admin.get(runs_url("-") + ":summarize")).status_code == 403
    assert (await scene.as_editor.get(url)).status_code == 403
    assert (await scene.as_admin.get(url, params={"filter": "state = FAILED"})).status_code == 400
