"""DeleteItem, UndeleteItem and DELETED visibility (item_model.md §4.10, §6.6, §7)."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from bomesh.db.models import ItemLink
from knowledge_support import error_reason, item_name, item_url, ws_url

pytestmark = pytest.mark.asyncio


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _status(response) -> str:
    return response.json()["error"]["status"]


async def _member(world, ws):
    user = await world.add_member(ws)
    return user


async def _links(sessions, container) -> list[ItemLink]:
    async with sessions() as session:
        return list(
            await session.scalars(
                select(ItemLink).where(ItemLink.collection_item_id == container.id)
            )
        )


# -- DeleteItem -----------------------------------------------------------------


async def test_delete_document_marks_deleted_with_purge_time(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    api = await client.as_(owner)

    response = await api.delete(item_url(doc))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == item_name(doc)
    assert body["state"] == "DELETED"
    delete_time = _time(body["deleteTime"])
    assert _time(body["purgeTime"]) - delete_time == timedelta(days=30)
    row = await knowledge.row(doc)
    assert row.deleted_at is not None
    assert row.deleted_at == delete_time


async def test_delete_non_empty_collection_without_force_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    api = await client.as_(owner)

    response = await api.delete(item_url(root))

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "COLLECTION_NOT_EMPTY"
    assert (await knowledge.row(root)).deleted_at is None
    assert (await knowledge.row(doc)).deleted_at is None


async def test_delete_empty_collection_needs_no_force(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    api = await client.as_(owner)

    response = await api.delete(item_url(root))

    assert response.status_code == 200, response.text
    assert response.json()["state"] == "DELETED"
    assert (await knowledge.row(root)).deleted_at is not None


async def test_force_delete_tombstones_live_subtree_with_one_timestamp(
    client, world, knowledge, fakes
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    nested = await world.make_collection(ws, root)
    top_doc = await world.make_document(root)
    nested_doc = await world.make_document(nested)
    unpublished = await world.make_document(nested, published=False)
    await knowledge.index(top_doc, ["annual leave policy"])
    await knowledge.index(nested_doc, ["travel expense policy"])
    assert fakes.index_backend.live_points(top_doc.id)
    api = await client.as_(owner)

    response = await api.delete(item_url(root), params={"force": True})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["state"] == "DELETED"
    stamps = {
        (await knowledge.row(item)).deleted_at
        for item in (root, nested, top_doc, nested_doc, unpublished)
    }
    assert len(stamps) == 1
    (stamp,) = stamps
    assert stamp is not None
    assert _time(body["deleteTime"]) == stamp
    # The cohort's documents leave the index and their payloads are synced.
    assert fakes.index_backend.live_points(top_doc.id) == []
    assert fakes.index_backend.live_points(nested_doc.id) == []
    for document in (top_doc, nested_doc, unpublished):
        assert (await knowledge.row(document)).payload_dirty_at is None


async def test_force_delete_with_foreign_boundary_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    boundary = await world.make_collection(
        ws, root, inherit_access=False, grants={owner: "roles/collectionEditor"}
    )
    doc = await world.make_document(boundary)
    api = await client.as_(owner)

    response = await api.delete(item_url(root), params={"force": True})

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "SUBTREE_HAS_FOREIGN_BOUNDARY"
    for item in (root, boundary, doc):
        assert (await knowledge.row(item)).deleted_at is None


async def test_force_delete_with_owned_nested_boundary_succeeds(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    boundary = await world.make_collection(
        ws, root, inherit_access=False, grants={owner: "roles/collectionOwner"}
    )
    doc = await world.make_document(boundary)
    api = await client.as_(owner)

    response = await api.delete(item_url(root), params={"force": True})

    assert response.status_code == 200, response.text
    stamps = {(await knowledge.row(item)).deleted_at for item in (root, boundary, doc)}
    assert len(stamps) == 1 and None not in stamps


async def test_delete_personal_collection_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await _member(world, ws)
    personal = await world.make_collection(ws, personal_for=member)
    api = await client.as_(member)

    response = await api.delete(item_url(personal), params={"force": True})

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "PERSONAL_COLLECTION"
    assert (await knowledge.row(personal)).deleted_at is None


async def test_delete_candidate_of_open_contribution_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    contributor = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    await world.make_contribution(doc, contributor=contributor, target=root, state="in_review")
    api = await client.as_(owner)

    response = await api.delete(item_url(doc))

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "CONTRIBUTION_OPEN"
    assert (await knowledge.row(doc)).deleted_at is None


async def test_delete_by_editor_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await _member(world, ws)
    root = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    doc = await world.make_document(root)
    api = await client.as_(editor)

    response = await api.delete(item_url(doc))

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).deleted_at is None


async def test_delete_missing_item_as_admin_is_not_found(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    api = await client.as_(admin)

    response = await api.delete(f"{ws_url(ws)}/items/00000000-0000-4000-8000-000000000001")

    assert response.status_code == 404, response.text


async def test_delete_with_stale_etag_is_aborted(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    api = await client.as_(owner)
    current = (await api.get(item_url(doc))).json()["etag"]

    stale = await api.delete(item_url(doc), params={"etag": current + "x"})
    assert stale.status_code == 409, stale.text
    assert _status(stale) == "ABORTED"
    assert (await knowledge.row(doc)).deleted_at is None

    fresh = await api.delete(item_url(doc), params={"etag": current})
    assert fresh.status_code == 200, fresh.text


async def test_delete_container_tombstones_its_links_in_the_cohort(
    client, world, knowledge, sessions
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    source = await world.make_collection(ws, grants={owner: "roles/collectionViewer"})
    target = await world.make_document(source)
    container = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    api = await client.as_(owner)
    created = await api.post(item_url(container, "/links"), json={"targetItem": item_name(target)})
    assert created.status_code == 200, created.text

    response = await api.delete(item_url(container), params={"force": True})

    assert response.status_code == 200, response.text
    (link,) = await _links(sessions, container)
    assert link.deleted_at == (await knowledge.row(container)).deleted_at
    # The target is never affected.
    assert (await knowledge.row(target)).deleted_at is None


# -- UndeleteItem ---------------------------------------------------------------


async def test_undelete_restores_exactly_the_cohort(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    nested = await world.make_collection(ws, root)
    earlier = await world.make_document(root)
    kept = await world.make_document(nested)
    api = await client.as_(owner)
    first = await api.delete(item_url(earlier))
    assert first.status_code == 200, first.text
    second = await api.delete(item_url(root), params={"force": True})
    assert second.status_code == 200, second.text
    assert (await knowledge.row(earlier)).deleted_at != (await knowledge.row(root)).deleted_at

    response = await api.post(item_url(root, ":undelete"), json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["state"] == "ACTIVE"
    assert body.get("deleteTime") is None
    assert body.get("purgeTime") is None
    for item in (root, nested, kept):
        assert (await knowledge.row(item)).deleted_at is None
    assert (await knowledge.row(earlier)).deleted_at is not None
    # The separately deleted document can now be restored on its own.
    again = await api.post(item_url(earlier, ":undelete"), json={})
    assert again.status_code == 200, again.text
    assert (await knowledge.row(earlier)).deleted_at is None


async def test_undelete_live_item_is_already_exists(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    api = await client.as_(owner)

    response = await api.post(item_url(doc, ":undelete"), json={})

    assert response.status_code == 409, response.text
    assert _status(response) == "ALREADY_EXISTS"


async def test_undelete_with_deleted_parent_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    api = await client.as_(owner)
    assert (await api.delete(item_url(doc))).status_code == 200
    assert (await api.delete(item_url(root))).status_code == 200

    response = await api.post(item_url(doc, ":undelete"), json={})

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "PARENT_DELETED"
    assert (await knowledge.row(doc)).deleted_at is not None


async def test_undelete_restores_index_points(client, world, knowledge, fakes):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    doc = await world.make_document(root)
    chunks = await knowledge.index(doc, ["onboarding checklist", "laptop setup"])
    api = await client.as_(owner)
    assert (await api.delete(item_url(root), params={"force": True})).status_code == 200
    assert fakes.index_backend.live_points(doc.id) == []

    response = await api.post(item_url(root, ":undelete"), json={})

    assert response.status_code == 200, response.text
    assert len(fakes.index_backend.live_points(doc.id)) == len(chunks)
    assert knowledge.payload(doc).get("is_deleted") is False
    row = await knowledge.row(doc)
    assert row.payload_dirty_at is None
    assert row.deleted_at is None


async def test_undelete_by_viewer_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    viewer = await _member(world, ws)
    root = await world.make_collection(
        ws, grants={owner: "roles/collectionOwner", viewer: "roles/collectionViewer"}
    )
    doc = await world.make_document(root)
    assert (await (await client.as_(owner)).delete(item_url(doc))).status_code == 200
    api = await client.as_(viewer)

    response = await api.post(item_url(doc, ":undelete"), json={})

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).deleted_at is not None


async def test_undelete_with_foreign_boundary_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    boundary = await world.make_collection(ws, root, inherit_access=False)
    assert (
        await (await client.as_(admin)).delete(item_url(root), params={"force": True})
    ).status_code == 200
    api = await client.as_(owner)

    response = await api.post(item_url(root, ":undelete"), json={})

    assert response.status_code == 400, response.text
    assert error_reason(response) == "SUBTREE_HAS_FOREIGN_BOUNDARY"
    assert (await knowledge.row(root)).deleted_at is not None
    assert (await knowledge.row(boundary)).deleted_at is not None


async def test_undelete_restores_container_links(client, world, knowledge, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    source = await world.make_collection(ws, grants={owner: "roles/collectionViewer"})
    target = await world.make_document(source)
    container = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    api = await client.as_(owner)
    created = await api.post(item_url(container, "/links"), json={"targetItem": item_name(target)})
    assert created.status_code == 200, created.text
    assert (await api.delete(item_url(container), params={"force": True})).status_code == 200

    response = await api.post(item_url(container, ":undelete"), json={})

    assert response.status_code == 200, response.text
    (link,) = await _links(sessions, container)
    assert link.deleted_at is None
    listed = await api.get(item_url(container, "/links"))
    assert listed.status_code == 200, listed.text
    assert [entry["targetItem"] for entry in listed.json()["links"]] == [item_name(target)]


# -- DELETED visibility ---------------------------------------------------------


async def test_deleted_items_listed_only_for_undelete_holders(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    editor = await _member(world, ws)
    root = await world.make_collection(
        ws, grants={owner: "roles/collectionOwner", editor: "roles/collectionEditor"}
    )
    live = await world.make_document(root)
    deleted = await world.make_document(root)
    owner_api = await client.as_(owner)
    editor_api = await client.as_(editor)
    assert (await owner_api.delete(item_url(deleted))).status_code == 200
    params = {"filter": f'parentItem="{item_name(root)}"'}

    default = await owner_api.get(f"{ws_url(ws)}/items", params=params)
    assert default.status_code == 200, default.text
    assert [item["name"] for item in default.json()["items"]] == [item_name(live)]

    shown = await owner_api.get(f"{ws_url(ws)}/items", params={**params, "showDeleted": True})
    assert shown.status_code == 200, shown.text
    states = {item["name"]: item["state"] for item in shown.json()["items"]}
    assert states == {item_name(live): "ACTIVE", item_name(deleted): "DELETED"}

    hidden = await editor_api.get(f"{ws_url(ws)}/items", params={**params, "showDeleted": True})
    assert hidden.status_code == 200, hidden.text
    assert [item["name"] for item in hidden.json()["items"]] == [item_name(live)]

    owner_get = await owner_api.get(item_url(deleted))
    assert owner_get.status_code == 200, owner_get.text
    assert owner_get.json()["state"] == "DELETED"
    editor_get = await editor_api.get(item_url(deleted))
    assert editor_get.status_code == 403, editor_get.text
