"""MoveItem, PublishItem/UnpublishItem, VerifyItem and MergeItem (item_model.md §4.6, §4.9, §7)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from bomesh.db.models import Item, ItemLink, Tenant
from knowledge_support import error_reason, item_name, item_url, ws_url

pytestmark = pytest.mark.asyncio


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _status(response) -> str:
    return response.json()["error"]["status"]


def _member_name(ws, user) -> str:
    return f"workspaces/{ws.id}/members/{user.id}"


async def _set_metadata(sessions, item: Item, extra: dict[str, Any]) -> None:
    async with sessions.begin() as session:
        row = await session.get(Item, item.id)
        assert row is not None
        await session.execute(
            update(Item).where(Item.id == item.id).values(metadata_={**row.metadata_, **extra})
        )


async def _move(api, item: Item, destination: str, **extra: Any):
    return await api.post(
        item_url(item, ":move"), json={"destinationParent": destination, **extra}
    )


# -- MoveItem -------------------------------------------------------------------


async def test_move_document_between_collections_rewrites_payload(
    client, world, knowledge
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    first = await world.make_collection(ws, root)
    second = await world.make_collection(ws, root)
    doc = await world.make_document(first)
    await knowledge.index(doc, ["vendor onboarding"])
    assert knowledge.payload(doc)["collection_item_id"] == str(first.id)
    api = await client.as_(editor)

    response = await _move(api, doc, item_name(second))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == item_name(doc)
    assert body["parentItem"] == item_name(second)
    assert (await knowledge.row(doc)).parent_item_id == second.id
    assert knowledge.payload(doc)["collection_item_id"] == str(second.id)
    assert (await knowledge.row(doc)).payload_dirty_at is None


async def test_move_across_boundary_needs_set_iam_policy_on_source(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    source = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    destination = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    doc = await world.make_document(source)
    api = await client.as_(editor)

    response = await _move(api, doc, item_name(destination))

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).parent_item_id == source.id


async def test_move_across_boundary_with_owner_on_source(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    source = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    destination = await world.make_collection(ws, grants={owner: "roles/collectionEditor"})
    doc = await world.make_document(source)
    await knowledge.index(doc, ["boundary crossing"])
    api = await client.as_(owner)

    response = await _move(api, doc, item_name(destination))

    assert response.status_code == 200, response.text
    assert response.json()["parentItem"] == item_name(destination)
    assert knowledge.payload(doc)["collection_item_id"] == str(destination.id)


async def test_move_into_itself_or_descendant_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    moved = await world.make_collection(ws, root)
    child = await world.make_collection(ws, moved)
    grandchild = await world.make_collection(ws, child)
    api = await client.as_(admin)

    for destination in (moved, child, grandchild):
        response = await _move(api, moved, item_name(destination))
        assert response.status_code == 400, response.text
        assert _status(response) == "INVALID_ARGUMENT"
        assert error_reason(response) == "MOVE_INTO_DESCENDANT"
    assert (await knowledge.row(moved)).parent_item_id == root.id


async def test_move_document_to_workspace_root_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    doc = await world.make_document(root)
    api = await client.as_(admin)

    response = await _move(api, doc, f"workspaces/{ws.id}")

    assert response.status_code == 400, response.text
    assert _status(response) == "INVALID_ARGUMENT"
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_document_into_document_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    doc = await world.make_document(root)
    other = await world.make_document(root)
    api = await client.as_(admin)

    response = await _move(api, doc, item_name(other))

    assert response.status_code == 400, response.text
    assert _status(response) == "INVALID_ARGUMENT"


async def test_move_collection_to_root_becomes_access_boundary(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    nested = await world.make_collection(ws, root)
    assert nested.inherit_access is True
    api = await client.as_(admin)

    response = await _move(api, nested, f"workspaces/{ws.id}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["parentItem"] == ""
    assert body["collection"]["inheritAccess"] is False
    row = await knowledge.row(nested)
    assert row.parent_item_id is None
    assert row.inherit_access is False


async def test_move_into_another_members_personal_collection_is_denied(
    client, world, knowledge
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    other = await world.add_member(ws)
    root = await world.make_collection(ws)
    personal = await world.make_collection(ws, personal_for=other)
    doc = await world.make_document(root)
    api = await client.as_(admin)

    response = await _move(api, doc, item_name(personal))

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_into_own_personal_collection_publishes(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    personal = await world.make_collection(ws, personal_for=owner)
    doc = await world.make_document(root, published=False)
    api = await client.as_(owner)

    response = await _move(api, doc, item_name(personal))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["parentItem"] == item_name(personal)
    assert body["document"]["publicationState"] == "PUBLISHED"
    assert (await knowledge.row(doc)).publication_state == "published"


async def test_move_conversation_attachment_fails(client, world, knowledge, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    personal = await world.make_collection(ws, personal_for=owner)
    attachment = await world.make_document(personal, creator=owner)
    await _set_metadata(sessions, attachment, {"purpose": "conversation_attachment"})
    api = await client.as_(owner)

    response = await _move(api, attachment, item_name(root))

    assert response.status_code == 400, response.text
    assert _status(response) == "INVALID_ARGUMENT"
    assert error_reason(response) == "CONVERSATION_ATTACHMENT"
    assert (await knowledge.row(attachment)).parent_item_id == personal.id


async def test_move_source_managed_document_fails(client, world, knowledge, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    nested = await world.make_collection(ws, root)
    doc = await world.make_document(root)
    await _set_metadata(
        sessions, doc, {"source": {"connector_key": "file", "external_id": "ext-1"}}
    )
    api = await client.as_(admin)

    response = await _move(api, doc, item_name(nested))

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "SOURCE_MANAGED"
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_candidate_of_open_contribution_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    contributor = await world.add_member(ws)
    root = await world.make_collection(ws)
    nested = await world.make_collection(ws, root)
    doc = await world.make_document(root)
    await world.make_contribution(doc, contributor=contributor, target=nested)
    api = await client.as_(admin)

    response = await _move(api, doc, item_name(nested))

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "CONTRIBUTION_OPEN"
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_personal_collection_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    personal = await world.make_collection(ws, personal_for=owner)
    api = await client.as_(owner)

    response = await _move(api, personal, item_name(root))

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "PERSONAL_COLLECTION"
    assert (await knowledge.row(personal)).parent_item_id is None


async def test_move_into_unreadable_destination_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    hidden = await world.make_collection(ws)
    doc = await world.make_document(root)
    api = await client.as_(owner)

    response = await _move(api, doc, item_name(hidden))

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_by_viewer_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: "roles/collectionViewer"})
    nested = await world.make_collection(ws, root)
    doc = await world.make_document(root)
    api = await client.as_(viewer)

    response = await _move(api, doc, item_name(nested))

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_with_stale_etag_is_aborted(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    nested = await world.make_collection(ws, root)
    doc = await world.make_document(root)
    api = await client.as_(admin)
    etag = (await api.get(item_url(doc))).json()["etag"]

    response = await _move(api, doc, item_name(nested), etag=etag + "x")

    assert response.status_code == 409, response.text
    assert _status(response) == "ABORTED"
    assert (await knowledge.row(doc)).parent_item_id == root.id


async def test_move_into_linking_container_deletes_the_link(client, world, knowledge, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    container = await world.make_collection(ws, root)
    other = await world.make_collection(ws, root)
    doc = await world.make_document(root)
    api = await client.as_(admin)
    linked = await api.post(item_url(container, "/links"), json={"targetItem": item_name(doc)})
    assert linked.status_code == 200, linked.text
    kept = await api.post(item_url(other, "/links"), json={"targetItem": item_name(doc)})
    assert kept.status_code == 200, kept.text

    response = await _move(api, doc, item_name(container))

    assert response.status_code == 200, response.text
    async with sessions() as session:
        links = {
            link.collection_item_id: link
            for link in await session.scalars(
                select(ItemLink).where(ItemLink.target_item_id == doc.id)
            )
        }
    assert links[container.id].deleted_at is not None
    assert links[other.id].deleted_at is None
    listed = await api.get(item_url(container, "/links"))
    assert listed.status_code == 200, listed.text
    assert listed.json()["links"] == []


# -- PublishItem / UnpublishItem -------------------------------------------------


async def test_unpublish_then_publish_round_trip(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    viewer = await world.add_member(ws)
    root = await world.make_collection(
        ws, grants={editor: "roles/collectionEditor", viewer: "roles/collectionViewer"}
    )
    doc = await world.make_document(root)
    await knowledge.index(doc, ["expense report rules"])
    assert knowledge.payload(doc)["published"] is True
    editor_api = await client.as_(editor)
    viewer_api = await client.as_(viewer)
    assert (await viewer_api.get(item_url(doc))).status_code == 200

    unpublished = await editor_api.post(item_url(doc, ":unpublish"), json={})

    assert unpublished.status_code == 200, unpublished.text
    assert unpublished.json()["document"]["publicationState"] == "UNPUBLISHED"
    assert (await knowledge.row(doc)).publication_state == "unpublished"
    assert knowledge.payload(doc)["published"] is False
    assert (await knowledge.row(doc)).payload_dirty_at is None
    assert (await viewer_api.get(item_url(doc))).status_code == 403
    assert (await editor_api.get(item_url(doc))).status_code == 200

    published = await editor_api.post(item_url(doc, ":publish"), json={})

    assert published.status_code == 200, published.text
    assert published.json()["document"]["publicationState"] == "PUBLISHED"
    assert knowledge.payload(doc)["published"] is True
    assert (await viewer_api.get(item_url(doc))).status_code == 200


async def test_publish_or_unpublish_in_current_state_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    published = await world.make_document(root)
    unpublished = await world.make_document(root, published=False)
    api = await client.as_(admin)

    again = await api.post(item_url(published, ":publish"), json={})
    assert again.status_code == 400, again.text
    assert _status(again) == "FAILED_PRECONDITION"

    twice = await api.post(item_url(unpublished, ":unpublish"), json={})
    assert twice.status_code == 400, twice.text
    assert _status(twice) == "FAILED_PRECONDITION"
    assert (await knowledge.row(published)).publication_state == "published"
    assert (await knowledge.row(unpublished)).publication_state == "unpublished"


async def test_publish_collection_fails(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)

    for verb in (":publish", ":unpublish"):
        response = await api.post(item_url(root, verb), json={})
        assert response.status_code == 400, response.text
        assert _status(response) == "FAILED_PRECONDITION"


async def test_unpublish_document_in_personal_collection_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    personal = await world.make_collection(ws, personal_for=owner)
    doc = await world.make_document(personal, creator=owner)
    api = await client.as_(owner)

    response = await api.post(item_url(doc, ":unpublish"), json={})

    assert response.status_code == 400, response.text
    assert _status(response) == "FAILED_PRECONDITION"
    assert (await knowledge.row(doc)).publication_state == "published"


async def test_publish_by_viewer_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: "roles/collectionViewer"})
    doc = await world.make_document(root)
    api = await client.as_(viewer)

    response = await api.post(item_url(doc, ":unpublish"), json={})

    assert response.status_code == 403, response.text
    assert (await knowledge.row(doc)).publication_state == "published"


async def test_publish_with_stale_etag_is_aborted(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    doc = await world.make_document(root, published=False)
    api = await client.as_(admin)
    etag = (await api.get(item_url(doc))).json()["etag"]

    stale = await api.post(item_url(doc, ":publish"), json={"etag": etag + "x"})
    assert stale.status_code == 409, stale.text
    assert _status(stale) == "ABORTED"
    assert (await knowledge.row(doc)).publication_state == "unpublished"

    fresh = await api.post(item_url(doc, ":publish"), json={"etag": etag})
    assert fresh.status_code == 200, fresh.text


# -- VerifyItem -----------------------------------------------------------------


async def test_verify_records_caller_as_verifier(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    doc = await world.make_document(root)
    api = await client.as_(editor)

    response = await api.post(item_url(doc, ":verify"), json={})

    assert response.status_code == 200, response.text
    verification = response.json()["document"]["verification"]
    assert verification["state"] == "VERIFIED"
    assert verification["verifier"] == _member_name(ws, editor)
    assert verification["verifyTime"]
    assert verification.get("nextReviewTime") is None
    fetched = await api.get(item_url(doc))
    assert fetched.json()["document"]["verification"]["state"] == "VERIFIED"


async def test_verify_sets_next_review_time_from_workspace_settings(
    client, world, sessions
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    async with sessions.begin() as session:
        await session.execute(
            update(Tenant).where(Tenant.id == ws.id).values(
                settings={"reverification_duration": 86400}
            )
        )
    root = await world.make_collection(ws)
    doc = await world.make_document(root)
    api = await client.as_(admin)

    response = await api.post(item_url(doc, ":verify"), json={})

    assert response.status_code == 200, response.text
    verification = response.json()["document"]["verification"]
    assert verification["verifier"] == _member_name(ws, admin)
    assert _time(verification["nextReviewTime"]) - _time(verification["verifyTime"]) == timedelta(
        seconds=86400
    )


async def test_verify_unpublished_document_or_collection_fails(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    doc = await world.make_document(root, published=False)
    api = await client.as_(admin)

    for item in (doc, root):
        response = await api.post(item_url(item, ":verify"), json={})
        assert response.status_code == 400, response.text
        assert _status(response) == "FAILED_PRECONDITION"


async def test_verify_by_viewer_is_denied(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: "roles/collectionViewer"})
    doc = await world.make_document(root)
    api = await client.as_(viewer)

    response = await api.post(item_url(doc, ":verify"), json={})

    assert response.status_code == 403, response.text


async def test_verify_with_stale_etag_is_aborted(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    doc = await world.make_document(root)
    api = await client.as_(admin)
    etag = (await api.get(item_url(doc))).json()["etag"]

    response = await api.post(item_url(doc, ":verify"), json={"etag": etag + "x"})

    assert response.status_code == 409, response.text
    assert _status(response) == "ABORTED"


# -- MergeItem ------------------------------------------------------------------


async def test_merge_deletes_duplicate_and_undelete_clears_merged_into(
    client, world, knowledge, fakes
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    duplicate = await world.make_document(root)
    target = await world.make_document(root)
    await knowledge.index(duplicate, ["duplicate copy"])
    api = await client.as_(owner)

    response = await api.post(
        item_url(duplicate, ":merge"), json={"targetItem": item_name(target)}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == item_name(duplicate)
    assert body["state"] == "DELETED"
    assert body["document"]["mergedInto"] == item_name(target)
    assert (await knowledge.row(duplicate)).deleted_at is not None
    assert (await knowledge.row(target)).deleted_at is None
    assert fakes.index_backend.live_points(duplicate.id) == []

    restored = await api.post(item_url(duplicate, ":undelete"), json={})

    assert restored.status_code == 200, restored.text
    assert restored.json()["state"] == "ACTIVE"
    assert restored.json()["document"].get("mergedInto") is None
    row = await knowledge.row(duplicate)
    assert row.deleted_at is None
    assert "merged_into" not in row.metadata_


async def test_merge_into_unreadable_target_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    hidden = await world.make_collection(ws)
    duplicate = await world.make_document(root)
    target = await world.make_document(hidden)
    api = await client.as_(owner)

    response = await api.post(
        item_url(duplicate, ":merge"), json={"targetItem": item_name(target)}
    )

    assert response.status_code == 403, response.text
    assert (await knowledge.row(duplicate)).deleted_at is None


async def test_merge_into_invalid_target_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: "roles/collectionOwner"})
    nested = await world.make_collection(ws, root)
    duplicate = await world.make_document(root)
    deleted = await world.make_document(root)
    api = await client.as_(owner)
    assert (await api.delete(item_url(deleted))).status_code == 200

    for target in (duplicate, nested, deleted):
        response = await api.post(
            item_url(duplicate, ":merge"), json={"targetItem": item_name(target)}
        )
        assert response.status_code == 400, (target, response.text)
        assert _status(response) == "FAILED_PRECONDITION"
    assert (await knowledge.row(duplicate)).deleted_at is None


async def test_merge_by_editor_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    duplicate = await world.make_document(root)
    target = await world.make_document(root)
    api = await client.as_(editor)

    response = await api.post(
        item_url(duplicate, ":merge"), json={"targetItem": item_name(target)}
    )

    assert response.status_code == 403, response.text
    assert (await knowledge.row(duplicate)).deleted_at is None


async def test_merge_candidate_of_open_contribution_fails(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    contributor = await world.add_member(ws)
    root = await world.make_collection(ws)
    duplicate = await world.make_document(root)
    target = await world.make_document(root)
    await world.make_contribution(duplicate, contributor=contributor, target=root)
    api = await client.as_(admin)

    response = await api.post(
        item_url(duplicate, ":merge"), json={"targetItem": item_name(target)}
    )

    assert response.status_code == 400, response.text
    assert error_reason(response) == "CONTRIBUTION_OPEN"
    assert (await knowledge.row(duplicate)).deleted_at is None


async def test_merge_with_stale_etag_is_aborted(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    duplicate = await world.make_document(root)
    target = await world.make_document(root)
    api = await client.as_(admin)
    etag = (await api.get(item_url(duplicate))).json()["etag"]

    response = await api.post(
        item_url(duplicate, ":merge"),
        json={"targetItem": item_name(target), "etag": etag + "x"},
    )

    assert response.status_code == 409, response.text
    assert (await knowledge.row(duplicate)).deleted_at is None


async def test_list_hides_merged_duplicate(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    duplicate = await world.make_document(root)
    target = await world.make_document(root)
    api = await client.as_(admin)
    merged = await api.post(item_url(duplicate, ":merge"), json={"targetItem": item_name(target)})
    assert merged.status_code == 200, merged.text

    listed = await api.get(
        f"{ws_url(ws)}/items", params={"filter": f'parentItem="{item_name(root)}"'}
    )

    assert listed.status_code == 200, listed.text
    assert [item["name"] for item in listed.json()["items"]] == [item_name(target)]
