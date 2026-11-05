"""Create, Get, List, Update, Delete, Pause and Resume sources (``api_design.md`` §6)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import func, select, update

from bomesh.db.models import (
    AuditLog,
    Contribution,
    ExternalResource,
    IngestionSource,
    IngestionSync,
    Item,
)
from harness import ApiClient, Fakes, Sessions, World
from sources_support import (
    Scene,
    build_scene,
    code_of,
    create_source,
    disable_connector,
    end_sync,
    item_ref,
    pause_ingestion,
    reason,
    set_connection_status,
    set_default_policy,
    source_body,
    source_row,
    source_url,
    sources_url,
    status,
    syncs_of,
)

pytestmark = pytest.mark.asyncio

SCHEDULE = {"cron": "0 6 * * 1-5", "timeZone": "Europe/Berlin"}


@pytest_asyncio.fixture
async def scene(client: ApiClient, world: World, sessions: Sessions) -> Scene:
    return await build_scene(client, world, sessions)


# -- CreateSource -------------------------------------------------------------------


async def test_create_source_starts_the_creation_sync(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    response = await scene.as_admin.post(
        sources_url(scene.workspace),
        params={"sourceId": "policies"},
        json=source_body(scene, resource_id="POL", displayName="Policies"),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    name = f"workspaces/{scene.workspace.id}/sources/policies"
    assert body["name"] == name
    assert body["connection"] == f"workspaces/{scene.workspace.id}/connections/shared-drive"
    assert body["targetCollection"] == item_ref(scene.handbook)
    assert body["externalResource"] == {
        "type": "space",
        "resourceId": "POL",
        "displayName": "Policies space",
    }
    assert body["displayName"] == "Policies"
    assert body["config"] == {"space": "POL"}
    assert body["publishingPolicy"] == "AUTO_PUBLISH"
    assert body["state"] == "ACTIVE"
    assert body["lastSync"]["state"] == "RUNNING"
    assert body["lastSync"]["sync"].startswith(f"{name}/syncs/")
    assert (body["pendingDocumentCount"], body["inReviewCount"]) == (0, 0)
    assert body["etag"] and body["createTime"] and body["updateTime"]
    assert "schedule" not in body

    source = await source_row(sessions, scene.workspace, "policies")
    [sync] = await syncs_of(sessions, source.id)
    assert (sync.trigger_type, sync.status, sync.created_by_user_id) == (
        "creation",
        "running",
        scene.admin.id,
    )
    assert fakes.workflows.called("start_source_sync") == [
        {"source_id": str(source.id), "tenant_id": str(scene.workspace.id), "sync_id": str(sync.id)}
    ]
    assert fakes.workflows.called("upsert_schedule") == []
    async with sessions() as session:
        audited = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == "CreateSource", AuditLog.target_name == name)
        )
    assert audited == 1


async def test_create_source_with_a_schedule_creates_the_temporal_schedule(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    body = await create_source(scene.as_admin, scene, "nightly", schedule=SCHEDULE)

    assert body["schedule"] == SCHEDULE
    source = await source_row(sessions, scene.workspace, "nightly")
    assert source.next_sync_at is not None and source.next_sync_at > datetime.now(UTC)
    assert source.next_sync_at.astimezone(UTC).hour in {4, 5}  # 06:00 in Berlin
    [call] = fakes.workflows.called("upsert_schedule")
    assert call["source_id"] == str(source.id)
    assert call["values"] == {
        "cron_expression": "0 6 * * 1-5",
        "timezone": "Europe/Berlin",
        "enabled": True,
    }


async def test_create_source_defaults_to_the_workspace_publishing_policy(
    scene: Scene, sessions: Sessions
) -> None:
    await set_default_policy(sessions, scene.workspace, "review_first")

    body = await create_source(scene.as_admin, scene)
    explicit = await create_source(scene.as_admin, scene, publishingPolicy="AUTO_PUBLISH")

    assert body["publishingPolicy"] == "REVIEW_FIRST"
    assert explicit["publishingPolicy"] == "AUTO_PUBLISH"


async def test_create_source_validate_only_stores_and_starts_nothing(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    response = await scene.as_admin.post(
        sources_url(scene.workspace),
        params={"sourceId": "dry-run", "validateOnly": "true"},
        json=source_body(scene, schedule=SCHEDULE),
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"].endswith("/sources/dry-run")
    assert response.json()["state"] == "ACTIVE"
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(IngestionSource)) == 0
    assert fakes.workflows.calls == []


async def test_create_source_request_id_replays_the_first_result(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    request_id = str(uuid4())
    body = source_body(scene, resource_id="NINE")

    first = await scene.as_admin.post(
        sources_url(scene.workspace), json=body, params={"requestId": request_id}
    )
    again = await scene.as_admin.post(
        sources_url(scene.workspace), json=body, params={"requestId": request_id}
    )
    other = await scene.as_admin.post(
        sources_url(scene.workspace),
        json=source_body(scene, resource_id="TEN"),
        params={"requestId": request_id},
    )

    assert first.status_code == again.status_code == 200
    assert again.json()["name"] == first.json()["name"]
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(IngestionSource)) == 1
    assert len(fakes.workflows.called("start_source_sync")) == 1
    assert other.status_code == 400
    assert reason(other) == "REQUEST_ID_REUSED"


async def test_create_source_while_ingestion_is_paused_starts_no_sync(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await pause_ingestion(sessions, scene.workspace)

    body = await create_source(scene.as_admin, scene, "quiet")

    assert "lastSync" not in body
    source = await source_row(sessions, scene.workspace, "quiet")
    assert await syncs_of(sessions, source.id) == []
    assert fakes.workflows.called("start_source_sync") == []


async def test_create_source_conflicts(scene: Scene) -> None:
    await create_source(scene.as_admin, scene, "taken", resource_id="ONE")

    same_id = await scene.as_admin.post(
        sources_url(scene.workspace),
        params={"sourceId": "taken"},
        json=source_body(scene, resource_id="TWO"),
    )
    same_resource = await scene.as_admin.post(
        sources_url(scene.workspace), json=source_body(scene, resource_id="ONE")
    )

    assert (same_id.status_code, status(same_id)) == (409, "ALREADY_EXISTS")
    assert (same_resource.status_code, status(same_resource)) == (409, "ALREADY_EXISTS")


async def test_create_source_authorization(scene: Scene) -> None:
    url = sources_url(scene.workspace)
    member = await scene.as_member.post(url, json=source_body(scene))
    others_personal = await scene.as_admin.post(
        url, json=source_body(scene, connection=scene.personal)
    )
    own_personal = await scene.as_colleague.post(
        url, json=source_body(scene, connection=scene.personal)
    )
    missing_connection = await scene.as_admin.post(
        url,
        json={
            **source_body(scene),
            "connection": f"workspaces/{scene.workspace.id}/connections/nope",
        },
    )
    unreadable = await scene.as_manager.post(url, json=source_body(scene, target=scene.board))
    missing_collection = await scene.as_admin.post(
        url,
        json={
            **source_body(scene),
            "targetCollection": f"workspaces/{scene.workspace.id}/items/{uuid4()}",
        },
    )
    publish_denied = await scene.as_manager.post(url, json=source_body(scene, target=scene.drafts))
    review_first = await scene.as_manager.post(
        url, json=source_body(scene, target=scene.drafts, publishingPolicy="REVIEW_FIRST")
    )
    editor = await scene.as_manager.post(url, json=source_body(scene, target=scene.handbook))

    for denied in (
        member,
        others_personal,
        missing_connection,
        unreadable,
        missing_collection,
        publish_denied,
    ):
        assert (denied.status_code, status(denied)) == (403, "PERMISSION_DENIED"), denied.text
    assert own_personal.status_code == 200, own_personal.text
    assert review_first.status_code == 200, review_first.text
    assert editor.status_code == 200, editor.text


async def test_create_source_invalid_arguments(scene: Scene) -> None:
    url = sources_url(scene.workspace)
    cases = {
        "document target": source_body(scene, target=scene.document),
        "bad cron": source_body(scene, schedule={"cron": "every day", "timeZone": "UTC"}),
        "six fields": source_body(scene, schedule={"cron": "0 0 6 * * *", "timeZone": "UTC"}),
        "bad zone": source_body(scene, schedule={"cron": "0 6 * * *", "timeZone": "Mars/Base"}),
        "half schedule": source_body(scene, schedule={"cron": "0 6 * * *"}),
        "no resource": {
            key: value for key, value in source_body(scene).items() if key != "externalResource"
        },
        "bad policy": source_body(scene, publishingPolicy="SOMETIMES"),
    }
    for case, body in cases.items():
        response = await scene.as_admin.post(url, json=body)
        assert (response.status_code, status(response)) == (400, "INVALID_ARGUMENT"), case

    bad_id = await scene.as_admin.post(url, json=source_body(scene), params={"sourceId": "Bad_ID"})
    assert (bad_id.status_code, status(bad_id)) == (400, "INVALID_ARGUMENT")


async def test_create_source_needs_an_active_connection_and_connector(
    scene: Scene, sessions: Sessions
) -> None:
    broken = await scene.as_admin.post(
        sources_url(scene.workspace), json=source_body(scene, connection=scene.broken)
    )
    await disable_connector(sessions, "confluence")
    disabled = await scene.as_admin.post(sources_url(scene.workspace), json=source_body(scene))

    assert (broken.status_code, status(broken)) == (400, "FAILED_PRECONDITION")
    assert (disabled.status_code, status(disabled)) == (400, "FAILED_PRECONDITION")


# -- GetSource / ListSources --------------------------------------------------------


async def test_get_source_computes_counts_and_state(
    scene: Scene, sessions: Sessions, fakes: Fakes, runtime: object
) -> None:
    created = await create_source(scene.as_admin, scene, "counted", publishingPolicy="REVIEW_FIRST")
    source = await source_row(sessions, scene.workspace, "counted")
    current = runtime.processing_version()  # type: ignore[attr-defined]
    async with sessions.begin() as session:
        for index, (index_status, version) in enumerate(
            [("pending", None), ("ready", "old-version"), ("ready", current)]
        ):
            document = Item(
                tenant_id=scene.workspace.id,
                item_type="document",
                parent_item_id=scene.handbook.id,
                parent_relation="contains",
                document_type="pdf",
                title=f"Synced {index}",
                status="ready",
                publication_state="unpublished",
                index_status=index_status,
                processed_version=version,
            )
            session.add(document)
            await session.flush()
            session.add(
                ExternalResource(
                    item_id=document.id, ingestion_source_id=source.id, external_id=f"f{index}"
                )
            )
            session.add(
                Contribution(
                    tenant_id=scene.workspace.id,
                    item_id=document.id,
                    kind="new_document",
                    origin="source",
                    ingestion_source_id=source.id,
                    target_item_id=scene.handbook.id,
                    state="in_review" if index < 2 else "approved",
                )
            )

    got = await scene.as_admin.get(source_url(scene.workspace, "counted"))

    assert got.status_code == 200
    assert got.json()["pendingDocumentCount"] == 2  # pending + outdated
    assert got.json()["inReviewCount"] == 2
    assert got.json()["etag"] == created["etag"]

    await end_sync(sessions, fakes.workflows, source.id, failed=True)
    assert (await scene.as_admin.get(source_url(scene.workspace, "counted"))).json()[
        "state"
    ] == "FAILED"
    await set_connection_status(sessions, scene.shared, "reauthorization_required")
    assert (await scene.as_admin.get(source_url(scene.workspace, "counted"))).json()[
        "state"
    ] == "REAUTHORIZATION_REQUIRED"


async def test_get_source_403_and_404(scene: Scene) -> None:
    await create_source(scene.as_admin, scene, "secret")

    member = await scene.as_member.get(source_url(scene.workspace, "secret"))
    member_missing = await scene.as_member.get(source_url(scene.workspace, "nope"))
    missing = await scene.as_admin.get(source_url(scene.workspace, "nope"))

    assert (member.status_code, member_missing.status_code) == (403, 403)
    assert (missing.status_code, status(missing)) == (404, "NOT_FOUND")


async def test_list_sources_pages_filters_and_orders(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await create_source(scene.as_admin, scene, "alpha", displayName="Alpha")
    await create_source(scene.as_admin, scene, "bravo", displayName="Bravo")
    await create_source(
        scene.as_admin, scene, "charlie", displayName="Charlie", publishingPolicy="REVIEW_FIRST"
    )
    bravo = await source_row(sessions, scene.workspace, "bravo")
    await end_sync(sessions, fakes.workflows, bravo.id)
    paused = await scene.as_admin.post(source_url(scene.workspace, "bravo", "pause"), json={})
    assert paused.status_code == 200, paused.text
    url = sources_url(scene.workspace)

    first = await scene.as_admin.get(url, params={"pageSize": 2})
    second = await scene.as_admin.get(
        url, params={"pageSize": 2, "pageToken": first.json()["nextPageToken"]}
    )
    by_name = await scene.as_admin.get(url, params={"orderBy": "displayName"})
    paused_only = await scene.as_admin.get(url, params={"filter": "state = PAUSED"})
    review = await scene.as_admin.get(url, params={"filter": "publishingPolicy = REVIEW_FIRST"})
    by_connection = await scene.as_admin.get(
        url,
        params={"filter": f'connection = "workspaces/{scene.workspace.id}/connections/shared-drive"'},
    )
    bad_filter = await scene.as_admin.get(url, params={"filter": "colour = red"})
    member = await scene.as_member.get(url)

    assert [code_of(s["name"]) for s in first.json()["sources"]] == ["charlie", "bravo"]
    assert first.json()["totalSize"] == 3
    assert [code_of(s["name"]) for s in second.json()["sources"]] == ["alpha"]
    assert "nextPageToken" not in second.json()
    assert [s["displayName"] for s in by_name.json()["sources"]] == ["Alpha", "Bravo", "Charlie"]
    assert [code_of(s["name"]) for s in paused_only.json()["sources"]] == ["bravo"]
    assert [code_of(s["name"]) for s in review.json()["sources"]] == ["charlie"]
    assert by_connection.json()["totalSize"] == 3
    assert (bad_filter.status_code, status(bad_filter)) == (400, "INVALID_ARGUMENT")
    assert member.status_code == 403


# -- UpdateSource -------------------------------------------------------------------


async def test_update_source_mutable_fields_and_schedule(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await create_source(scene.as_admin, scene, "editable")
    source = await source_row(sessions, scene.workspace, "editable")
    async with sessions.begin() as session:
        await session.execute(
            update(IngestionSource)
            .where(IngestionSource.id == source.id)
            .values(sync_checkpoint={"cursor": "page-7"})
        )
    url = source_url(scene.workspace, "editable")
    created = (await scene.as_admin.get(url)).json()

    renamed = await scene.as_admin.patch(
        url,
        params={"updateMask": "displayName,schedule,publishingPolicy"},
        json={
            "displayName": "Renamed",
            "schedule": SCHEDULE,
            "publishingPolicy": "REVIEW_FIRST",
            "etag": created["etag"],
        },
    )
    rescoped = await scene.as_admin.patch(
        url, params={"updateMask": "config"}, json={"config": {"include_shared": True}}
    )
    unscheduled = await scene.as_admin.patch(url, params={"updateMask": "schedule"}, json={})

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["displayName"] == "Renamed"
    assert renamed.json()["schedule"] == SCHEDULE
    assert renamed.json()["publishingPolicy"] == "REVIEW_FIRST"
    assert renamed.json()["etag"] != created["etag"]
    assert rescoped.status_code == 200, rescoped.text
    # The selected space stays part of the scope; replacing config re-scans.
    assert rescoped.json()["config"] == {
        "space": source.external_resource_id,
        "include_shared": True,
    }
    assert unscheduled.status_code == 200 and "schedule" not in unscheduled.json()
    stored = await source_row(sessions, scene.workspace, "editable")
    assert stored.sync_checkpoint is None
    assert stored.next_sync_at is None
    assert [call["values"]["cron_expression"] for call in fakes.workflows.called("upsert_schedule")] == [
        "0 6 * * 1-5"
    ]
    assert fakes.workflows.called("delete_schedule") == [{"source_id": str(source.id)}]


async def test_update_source_rejects_immutable_fields_and_stale_etags(scene: Scene) -> None:
    created = await create_source(scene.as_admin, scene, "fixed")
    url = source_url(scene.workspace, "fixed")
    await scene.as_admin.patch(url, params={"updateMask": "displayName"}, json={"displayName": "x"})

    immutable = {
        "connection": {"connection": "workspaces/x/connections/y"},
        "targetCollection": {"targetCollection": item_ref(scene.drafts)},
        "externalResource": {"externalResource": {"type": "space", "resourceId": "Z"}},
    }
    for path, body in immutable.items():
        response = await scene.as_admin.patch(url, params={"updateMask": path}, json=body)
        assert (response.status_code, status(response)) == (400, "INVALID_ARGUMENT"), path
    stale = await scene.as_admin.patch(
        url,
        params={"updateMask": "displayName"},
        json={"displayName": "y", "etag": created["etag"]},
    )
    bad_cron = await scene.as_admin.patch(
        url, params={"updateMask": "schedule"}, json={"schedule": {"cron": "*", "timeZone": "UTC"}}
    )
    member = await scene.as_member.patch(
        url, params={"updateMask": "displayName"}, json={"displayName": "z"}
    )

    assert (stale.status_code, status(stale), reason(stale)) == (409, "ABORTED", "ETAG_MISMATCH")
    assert (bad_cron.status_code, status(bad_cron)) == (400, "INVALID_ARGUMENT")
    assert member.status_code == 403


async def test_update_source_to_auto_publish_needs_items_publish(scene: Scene) -> None:
    await create_source(
        scene.as_manager, scene, "drafted", target=scene.drafts, publishingPolicy="REVIEW_FIRST"
    )
    url = source_url(scene.workspace, "drafted")

    denied = await scene.as_manager.patch(
        url, params={"updateMask": "publishingPolicy"}, json={"publishingPolicy": "AUTO_PUBLISH"}
    )
    allowed = await scene.as_admin.patch(
        url, params={"updateMask": "publishingPolicy"}, json={"publishingPolicy": "AUTO_PUBLISH"}
    )

    assert (denied.status_code, status(denied)) == (403, "PERMISSION_DENIED")
    assert allowed.status_code == 200 and allowed.json()["publishingPolicy"] == "AUTO_PUBLISH"


# -- DeleteSource -------------------------------------------------------------------


async def test_delete_source_tombstones_it_and_keeps_its_items(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    created = await create_source(scene.as_admin, scene, "gone", schedule=SCHEDULE)
    source = await source_row(sessions, scene.workspace, "gone")
    async with sessions.begin() as session:
        session.add(
            ExternalResource(
                item_id=scene.document.id, ingestion_source_id=source.id, external_id="f1"
            )
        )
    url = source_url(scene.workspace, "gone")

    member = await scene.as_member.delete(url)
    stale = await scene.as_admin.delete(url, params={"etag": "stale"})
    deleted = await scene.as_admin.delete(url, params={"etag": created["etag"]})
    after = await scene.as_admin.get(url)
    again = await scene.as_admin.delete(url)

    assert member.status_code == 403
    assert (stale.status_code, status(stale)) == (409, "ABORTED")
    assert (deleted.status_code, deleted.json()) == (200, {})
    assert after.status_code == 404 and again.status_code == 404
    assert fakes.workflows.called("delete_schedule") == [{"source_id": str(source.id)}]
    async with sessions() as session:
        document = await session.get(Item, scene.document.id)
        listed = await scene.as_admin.get(sources_url(scene.workspace))
    assert document is not None and document.deleted_at is None
    assert listed.json()["sources"] == [] or "sources" not in listed.json()


# -- PauseSource / ResumeSource -----------------------------------------------------


async def test_pause_and_resume_follow_the_state_machine(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    created = await create_source(scene.as_admin, scene, "toggled", schedule=SCHEDULE)
    source = await source_row(sessions, scene.workspace, "toggled")
    url = source_url(scene.workspace, "toggled")

    resume_active = await scene.as_admin.post(f"{url}:resume", json={})
    stale = await scene.as_admin.post(f"{url}:pause", json={"etag": "stale"})
    paused = await scene.as_admin.post(f"{url}:pause", json={"etag": created["etag"]})
    paused_again = await scene.as_admin.post(f"{url}:pause", json={})
    member = await scene.as_member.post(f"{url}:resume", json={})

    assert (resume_active.status_code, status(resume_active)) == (400, "FAILED_PRECONDITION")
    assert (stale.status_code, status(stale)) == (409, "ABORTED")
    assert paused.status_code == 200 and paused.json()["state"] == "PAUSED"
    assert (paused_again.status_code, status(paused_again)) == (400, "FAILED_PRECONDITION")
    assert member.status_code == 403
    assert (await source_row(sessions, scene.workspace, "toggled")).next_sync_at is None
    assert fakes.workflows.called("pause_schedule") == [{"source_id": str(source.id)}]
    assert fakes.workflows.schedules[str(source.id)]["paused"] is True

    resumed = await scene.as_admin.post(f"{url}:resume", json={"etag": paused.json()["etag"]})

    assert resumed.status_code == 200 and resumed.json()["state"] == "ACTIVE"
    assert (await source_row(sessions, scene.workspace, "toggled")).next_sync_at is not None
    assert fakes.workflows.called("resume_schedule") == [{"source_id": str(source.id)}]


async def test_resume_refuses_while_the_connection_needs_reauthorization(
    scene: Scene, sessions: Sessions
) -> None:
    await create_source(scene.as_admin, scene, "lapsed")
    url = source_url(scene.workspace, "lapsed")
    assert (await scene.as_admin.post(f"{url}:pause", json={})).status_code == 200
    await set_connection_status(sessions, scene.shared, "reauthorization_required")

    resumed = await scene.as_admin.post(f"{url}:resume", json={})
    got = await scene.as_admin.get(url)

    assert (resumed.status_code, status(resumed)) == (400, "FAILED_PRECONDITION")
    assert got.json()["state"] == "PAUSED"


async def test_a_failed_source_cannot_be_paused(
    scene: Scene, sessions: Sessions, fakes: Fakes
) -> None:
    await create_source(scene.as_admin, scene, "broken")
    source = await source_row(sessions, scene.workspace, "broken")
    await end_sync(sessions, fakes.workflows, source.id, failed=True)

    response = await scene.as_admin.post(source_url(scene.workspace, "broken", "pause"), json={})

    assert (response.status_code, status(response)) == (400, "FAILED_PRECONDITION")
    async with sessions() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(IngestionSync)
                .where(IngestionSync.ingestion_source_id == source.id)
            )
            == 1
        )
