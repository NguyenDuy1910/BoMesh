"""CreateIngestionRun, Get/List, Cancel, Retry and Summarize ingestion runs (``api_design.md`` §6)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import func, select, update

from bomesh.db.models import AuditLog, IngestionRun, Item, ItemIndexState, ItemTopic, Topic
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


def _subtree(collection: Item) -> str:
    """The ``ancestors:`` filter of a collection's whole subtree."""
    return f'ancestors:"{item_ref(collection)}"'


def _topic(scene: Scene, code: str) -> str:
    return f"workspaces/{scene.workspace.id}/topics/{code}"


def _violations(response: Any) -> set[str]:
    return {
        violation["field"]
        for detail in response.json()["error"]["details"]
        for violation in detail.get("fieldViolations", ())
    }


# -- Create: selection ---------------------------------------------------------


async def test_a_filter_run_snapshots_its_waiting_subtree_and_queues_it(
    scene: Scene, sessions: Sessions, runtime: AppRuntime
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
    selector = {
        "filter": f"{_subtree(scene.handbook)} AND "
        "(document.indexingState = PENDING OR document.indexingState = OUTDATED)"
    }

    response = await _create(scene.as_editor, scene, {"selector": selector, "trigger": "API"})

    assert response.status_code == 200, response.text
    body = response.json()
    run_id = run_id_of(body)
    assert body["name"] == f"workspaces/{scene.workspace.id}/ingestionRuns/{run_id}"
    assert body["state"] == "QUEUED" and body["trigger"] == "API"
    assert body["selector"] == selector
    assert "classification" not in body
    assert body["counts"]["totalCount"] == 3 and body["counts"]["queuedCount"] == 3
    assert body["createTime"].endswith("Z") and "error" not in body
    assert set(await task_items(sessions, run_id)) == {pending.id, nested.id, outdated.id}
    # The QUEUED row is the queue: an ingestion worker claims it.
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


async def test_the_filter_silently_narrows_to_processable_collections(
    scene: Scene, sessions: Sessions, world: World
) -> None:
    handbook_document = await document(sessions, scene.handbook)
    await document(sessions, scene.board)
    await document(sessions, scene.board)

    by_state = await _create(
        scene.as_editor, scene, {"selector": {"filter": "document.indexingState = PENDING"}}
    )
    assert set(await task_items(sessions, run_id_of(by_state.json()))) == {handbook_document.id}

    # A readable subtree the editor may not process: an empty run that is already done.
    board = await _create(scene.as_editor, scene, {"selector": {"filter": _subtree(scene.board)}})
    assert board.status_code == 200
    assert board.json()["state"] == "SUCCEEDED"
    assert board.json()["counts"]["totalCount"] == 0
    assert "endTime" in board.json()

    # Nobody processes what nobody may read: an item the filter names must be readable.
    unreadable = await world.make_collection(scene.workspace, item_name="Secret")
    hidden = await _create(scene.as_editor, scene, {"selector": {"filter": _subtree(unreadable)}})
    assert hidden.status_code == 403
    # The ListItems grammar: malformed filters, unknown fields and values are the field's error.
    for text in (
        "document.indexingState =",
        "colour = RED",
        "document.indexingState = DONE",
        'ancestors:"workspaces/x/items/y"',
    ):
        response = await _create(scene.as_editor, scene, {"selector": {"filter": text}})
        assert response.status_code == 400, text
        assert _violations(response) == {"selector.filter"}, text


async def test_the_filter_selects_by_type_topic_and_source(
    scene: Scene, sessions: Sessions
) -> None:
    policy = await document(
        sessions, scene.handbook, item_name="policy.pdf", mime_type="application/pdf"
    )
    tagged = await document(sessions, scene.handbook)
    synced = await document(sessions, scene.handbook, source_code="wiki")
    plain = await document(sessions, scene.handbook)
    broken = await document(sessions, scene.handbook, index_status="failed")
    async with sessions.begin() as session:
        domain = Topic(tenant_id=scene.workspace.id, code="hr", kind="domain", topic_name="HR")
        session.add(domain)
        await session.flush()
        session.add(ItemTopic(item_id=tagged.id, topic_id=domain.id))
    source = f"workspaces/{scene.workspace.id}/sources/wiki"

    by_type = await _create(scene.as_editor, scene, {"selector": {"filter": "itemType = PDF"}})
    by_topic = await _create(
        scene.as_editor,
        scene,
        {"selector": {"filter": f'document.topics:"{_topic(scene, "hr")}"'}},
    )
    by_source = await _create(
        scene.as_editor, scene, {"selector": {"filter": f'document.origin.source = "{source}"'}}
    )
    # Explicit items and the filter narrow each other.
    both = await _create(
        scene.as_editor,
        scene,
        {
            "selector": {
                "items": [item_ref(plain), item_ref(broken)],
                "filter": "document.indexingState = FAILED",
            }
        },
    )

    assert set(await task_items(sessions, run_id_of(by_type.json()))) == {policy.id}
    assert set(await task_items(sessions, run_id_of(by_topic.json()))) == {tagged.id}
    assert set(await task_items(sessions, run_id_of(by_source.json()))) == {synced.id}
    assert by_source.json()["selector"] == {"filter": f'document.origin.source = "{source}"'}
    assert set(await task_items(sessions, run_id_of(both.json()))) == {broken.id}


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
    await document(sessions, scene.handbook, stored=False)
    personal = await document(sessions, scene.personal)

    workspace_wide = await _create(
        scene.as_admin, scene, {"selector": {"filter": "document.indexingState = PENDING"}}
    )
    assert set(await task_items(sessions, run_id_of(workspace_wide.json()))) == {shared.id}

    # Named by item or by the filter, a personal document is its owner's to process.
    await set_run(sessions, run_id_of(workspace_wide.json()), status="succeeded")
    by_item = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(personal)]}})
    assert set(await task_items(sessions, run_id_of(by_item.json()))) == {personal.id}
    await set_run(sessions, run_id_of(by_item.json()), status="succeeded")
    by_filter = await _create(
        scene.as_editor, scene, {"selector": {"filter": _subtree(scene.personal)}}
    )
    assert set(await task_items(sessions, run_id_of(by_filter.json()))) == {personal.id}
    # An explicit attachment is silently left out.
    attachment = await _create(scene.as_editor, scene, {"selector": {"items": [item_ref(attached)]}})
    assert attachment.status_code == 200
    assert attachment.json()["counts"]["totalCount"] == 0


async def test_the_snapshot_is_fixed_and_documents_held_by_an_active_run_are_left_out(
    scene: Scene, sessions: Sessions
) -> None:
    before = await document(sessions, scene.handbook)
    first = await _create(scene.as_editor, scene, {"selector": {"filter": _subtree(scene.handbook)}})
    later = await document(sessions, scene.handbook)

    assert set(await task_items(sessions, run_id_of(first.json()))) == {before.id}
    second = await _create(scene.as_editor, scene, {"selector": {"filter": _subtree(scene.handbook)}})
    assert set(await task_items(sessions, run_id_of(second.json()))) == {later.id}


async def test_a_selector_is_required_and_validated(scene: Scene) -> None:
    pending = {"filter": "document.indexingState = PENDING"}
    cases = [
        {},
        {"selector": {}},
        {"selector": {"filter": "   "}},
        {"selector": {"ancestor": item_ref(scene.handbook)}},
        {"selector": {"items": [f"workspaces/{scene.workspace.id}/items/{uuid4()}" for _ in range(1001)]}},
        {"selector": pending, "trigger": "SCHEDULE"},
        {"selector": pending, "trigger": "PLATFORM_RETRY"},
    ]
    for body in cases:
        response = await _create(scene.as_editor, scene, body)
        assert response.status_code == 400, (body, response.text)
    # Someone who may process nothing is told so first, whatever the selector.
    assert (await _create(scene.as_outsider, scene, {})).status_code == 403
    assert (await _create(scene.as_viewer, scene, {"selector": pending})).status_code == 403


async def test_paused_ingestion_is_a_failed_precondition(scene: Scene, sessions: Sessions) -> None:
    await document(sessions, scene.handbook)
    await pause_ingestion(sessions, scene.workspace)

    response = await _create(
        scene.as_editor, scene, {"selector": {"filter": "document.indexingState = PENDING"}}
    )

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert response.json()["error"]["message"] == "Ingestion is paused for this workspace."


@pytest.mark.skip(reason="Temporal disabled")
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
    scene: Scene, sessions: Sessions
) -> None:
    await document(sessions, scene.handbook)
    request_id = str(uuid4())
    body = {"selector": {"filter": "document.indexingState = PENDING"}}

    preview = await _create(scene.as_editor, scene, body, validateOnly="true")
    assert preview.status_code == 200 and preview.json()["counts"]["totalCount"] == 1
    first = await _create(scene.as_editor, scene, body, requestId=request_id)
    again = await _create(scene.as_editor, scene, body, requestId=request_id)
    other = await _create(
        scene.as_editor,
        scene,
        {"selector": {"filter": "document.indexingState = FAILED"}},
        requestId=request_id,
    )

    assert first.json()["name"] == again.json()["name"]
    assert again.json()["counts"]["totalCount"] == 1
    assert other.status_code == 400 and reason(other) == "REQUEST_ID_REUSED"
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
        {"selector": {"filter": "document.indexingState = FAILED"}, "trigger": "PLATFORM_RETRY"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["trigger"] == "PLATFORM_RETRY"
    assert "selector" not in body and "error" not in body
    assert body["counts"]["totalCount"] == 2
    assert set(await task_items(sessions, run_id_of(body))) == {failed.id, failed_elsewhere.id}
    # Platform callers can name no item, by itself or in the filter.
    for selector in ({"items": [item_ref(failed)]}, {"filter": _subtree(scene.handbook)}):
        assert (await _create(scene.as_operator, scene, {"selector": selector})).status_code == 403


# -- Create: classification ------------------------------------------------------


async def test_classification_names_active_topics_and_is_kept_by_retry(
    scene: Scene, sessions: Sessions
) -> None:
    doc = await document(sessions, scene.handbook)
    other = await document(sessions, scene.handbook)
    async with sessions.begin() as session:
        session.add_all(
            [
                Topic(tenant_id=scene.workspace.id, code="hr", kind="domain", topic_name="HR"),
                Topic(
                    tenant_id=scene.workspace.id,
                    code="draft",
                    kind="domain",
                    topic_name="Draft",
                    state="proposed",
                ),
                Topic(
                    tenant_id=scene.workspace.id,
                    code="gone",
                    kind="domain",
                    topic_name="Gone",
                    deleted_at=datetime.now(UTC),
                ),
            ]
        )
    hr = _topic(scene, "hr")

    created = await _create(
        scene.as_admin,
        scene,
        {
            "selector": {"items": [item_ref(doc)]},
            "classification": {"topics": [hr, hr], "note": "  Digitised records 2015–2024  "},
        },
    )

    assert created.status_code == 200, created.text
    expected = {"topics": [hr], "note": "Digitised records 2015–2024"}
    assert created.json()["classification"] == expected
    run_id = run_id_of(created.json())
    url = runs_url(scene.workspace, str(run_id))
    assert "classification" not in (await scene.as_operator.get(url)).json()
    # A retry processes again with the same context.
    await set_run(sessions, run_id, status="failed")
    await set_task(sessions, run_id, doc.id, status="failed")
    retried = await scene.as_admin.post(f"{url}:retry", json={})
    assert retried.status_code == 200, retried.text
    assert retried.json()["classification"] == expected

    selector = {"items": [item_ref(other)]}
    invalid = [
        ({"topics": [_topic(scene, "missing")]}, "classification.topics"),
        ({"topics": [_topic(scene, "draft")]}, "classification.topics"),
        ({"topics": [_topic(scene, "gone")]}, "classification.topics"),
        ({"topics": [f"workspaces/{uuid4()}/topics/hr"]}, "classification.topics"),
        ({"topics": [_topic(scene, f"t{index}") for index in range(51)]}, "classification.topics"),
        ({"note": "x" * 1001}, "classification.note"),
    ]
    for classification, field in invalid:
        response = await _create(
            scene.as_admin, scene, {"selector": selector, "classification": classification}
        )
        assert response.status_code == 400, classification
        assert _violations(response) == {field}, classification
    # A classification that says nothing is not kept.
    blank = await _create(
        scene.as_admin, scene, {"selector": selector, "classification": {"topics": [], "note": " "}}
    )
    assert blank.status_code == 200 and "classification" not in blank.json()


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


async def test_the_selector_filter_is_echoed_only_to_readers_of_what_it_names(
    scene: Scene, sessions: Sessions, world: World, client: ApiClient
) -> None:
    await document(sessions, scene.board)
    created = await _create(scene.as_admin, scene, {"selector": {"filter": _subtree(scene.board)}})
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

    assert "filter" not in hidden.get("selector", {})
    assert "filter" not in listed["ingestionRuns"][0].get("selector", {})
    assert shown["selector"]["filter"] == _subtree(scene.board)


@pytest.mark.skip(reason="Temporal disabled")
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


async def test_cancel_settles_an_unclaimed_run_at_once_and_only_once(
    scene: Scene, sessions: Sessions
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
    # No worker holds the run: the cancel finishes it now.
    assert "endTime" in response.json()
    async with sessions.begin() as session:
        run = await session.get(IngestionRun, run_id)
        assert run is not None and run.finished_at is not None
    again = await scene.as_admin.post(url, json={})
    assert again.status_code == 400 and again.json()["error"]["status"] == "FAILED_PRECONDITION"
    missing = await scene.as_admin.post(runs_url(scene.workspace, f"{uuid4()}:cancel"), json={})
    assert missing.status_code == 404


async def test_retry_takes_failed_and_cancelled_tasks_into_a_new_run(
    scene: Scene, sessions: Sessions
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
    assert (await scene.as_outsider.post(url, json={})).status_code == 403


async def test_a_document_names_its_latest_run_and_why_it_failed(
    scene: Scene, sessions: Sessions
) -> None:
    broken = await document(sessions, scene.handbook)
    done = await document(sessions, scene.handbook)
    created = await _create(
        scene.as_admin, scene, {"selector": {"items": [item_ref(broken), item_ref(done)]}}
    )
    run_id = run_id_of(created.json())
    error = {"code": 13, "message": "The file has no text to index."}
    await set_run(sessions, run_id, status="failed")
    await set_task(sessions, run_id, broken.id, status="failed", error=error)
    await set_task(sessions, run_id, done.id, status="succeeded")

    async def index_status(item: Item, status: str) -> None:
        async with sessions.begin() as session:
            await session.execute(
                update(ItemIndexState)
                .where(ItemIndexState.item_id == item.id)
                .values(index_status=status)
            )

    async def facet(item: Item) -> dict[str, Any]:
        response = await scene.as_admin.get(f"/api/v1/workspaces/{scene.workspace.id}/items/{item.id}")
        assert response.status_code == 200, response.text
        return response.json()["document"]

    await index_status(broken, "failed")
    run = f"workspaces/{scene.workspace.id}/ingestionRuns/{run_id}"
    failed = await facet(broken)
    assert failed["indexingState"] == "FAILED"
    assert failed["lastIngestionRun"] == run and failed["indexingError"] == error
    succeeded = await facet(done)
    assert succeeded["lastIngestionRun"] == run and succeeded.get("indexingError") is None
    # A later content change resets the state, and with it the reason; the run stays named.
    await index_status(broken, "pending")
    reset = await facet(broken)
    assert reset["lastIngestionRun"] == run and reset.get("indexingError") is None


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
