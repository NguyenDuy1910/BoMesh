"""CreateItem, GetItem, ListItems and UpdateItem of the Knowledge interface."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import update

from bomesh.db.models import Item
from knowledge_support import error_reason, item_name, item_url, upload, ws_url

pytestmark = pytest.mark.asyncio

VIEWER = "roles/collectionViewer"
EDITOR = "roles/collectionEditor"
OWNER = "roles/collectionOwner"


def item_id(body: dict[str, Any]) -> UUID:
    return UUID(body["name"].rsplit("/", 1)[1])


def listed(response: Any) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json().get("items", [])]


def status_of(response: Any) -> str:
    return response.json()["error"]["status"]


def document_spec(parent: Item, **document: Any) -> dict[str, Any]:
    facet = {"mimeType": "application/pdf", "sizeBytes": "10", "fileName": "policy.pdf"}
    facet.update(document)
    return {
        "itemType": "DOCUMENT",
        "displayName": "Policy",
        "parentItem": item_name(parent),
        "document": {key: value for key, value in facet.items() if value is not None},
    }


async def list_items(api: Any, workspace: Any, **params: Any) -> Any:
    return await api.get(f"{ws_url(workspace)}/items", params=params)


async def make_discoverable(api: Any, root: Item, description: str | None = None) -> None:
    body: dict[str, Any] = {"collection": {"discoverable": True}}
    mask = "collection.discoverable"
    if description is not None:
        body["collection"]["description"] = description
        mask += ",collection.description"
    response = await api.patch(item_url(root), params={"updateMask": mask}, json=body)
    assert response.status_code == 200, response.text


# -- CreateItem ------------------------------------------------------------------


async def test_create_root_collection_by_workspace_admin(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    api = await client.as_(admin)

    response = await api.post(
        f"{ws_url(ws)}/items",
        json={
            "itemType": "COLLECTION",
            "displayName": "Policies",
            "collection": {"description": "HR policies"},
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"].startswith(f"workspaces/{ws.id}/items/")
    assert body["itemType"] == "COLLECTION"
    assert body["displayName"] == "Policies"
    assert body.get("parentItem", "") == ""
    assert body["state"] == "ACTIVE"
    assert body["access"] == "OWNER"
    assert body["collection"]["kind"] == "STANDARD"
    assert body["collection"]["description"] == "HR policies"
    assert body["collection"]["inheritAccess"] is False
    assert "document" not in body
    row = await knowledge.row(item_id(body))
    assert row.parent_item_id is None
    assert row.inherit_access is False
    assert row.created_by_user_id == admin.id


async def test_create_root_collection_needs_items_create_on_workspace(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    api = await client.as_(member)

    response = await api.post(
        f"{ws_url(ws)}/items", json={"itemType": "COLLECTION", "displayName": "Mine"}
    )

    assert response.status_code == 403, response.text
    assert status_of(response) == "PERMISSION_DENIED"


async def test_create_nested_collection_under_edited_collection(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: EDITOR})
    api = await client.as_(editor)

    response = await api.post(
        f"{ws_url(ws)}/items",
        json={"itemType": "COLLECTION", "displayName": "Folder", "parentItem": item_name(root)},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["parentItem"] == item_name(root)
    assert body["parentRelation"] == "CONTAINS"
    assert body["collection"]["inheritAccess"] is True
    assert body["access"] == "EDITOR"
    row = await knowledge.row(item_id(body))
    assert row.parent_item_id == root.id
    assert row.inherit_access is True


async def test_create_under_unreadable_or_missing_parent_is_denied(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    hidden = await world.make_collection(ws)
    viewer_only = await world.make_collection(ws, grants={member: VIEWER})
    api = await client.as_(member)

    for parent in (item_name(hidden), f"workspaces/{ws.id}/items/{uuid4()}"):
        response = await api.post(
            f"{ws_url(ws)}/items",
            json={"itemType": "COLLECTION", "displayName": "Folder", "parentItem": parent},
        )
        assert response.status_code == 403, response.text
        assert status_of(response) == "PERMISSION_DENIED"

    response = await api.post(
        f"{ws_url(ws)}/items",
        json={"itemType": "COLLECTION", "displayName": "F", "parentItem": item_name(viewer_only)},
    )
    assert response.status_code == 403, response.text


async def test_create_under_a_document_is_invalid(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    document = await world.make_document(root)
    api = await client.as_(admin)

    collection = await api.post(
        f"{ws_url(ws)}/items",
        json={"itemType": "COLLECTION", "displayName": "F", "parentItem": item_name(document)},
    )
    nested_document = await api.post(f"{ws_url(ws)}/items", json=document_spec(document))

    for response in (collection, nested_document):
        assert response.status_code == 400, response.text
        assert status_of(response) == "INVALID_ARGUMENT"


async def test_create_document_requires_parent_mime_type_and_size(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)

    no_mime = await api.post(f"{ws_url(ws)}/items", json=document_spec(root, mimeType=None))
    no_size = await api.post(f"{ws_url(ws)}/items", json=document_spec(root, sizeBytes=None))
    spec = document_spec(root)
    del spec["parentItem"]
    no_parent = await api.post(f"{ws_url(ws)}/items", json=spec)

    for response in (no_mime, no_size, no_parent):
        assert response.status_code == 400, response.text
        assert status_of(response) == "INVALID_ARGUMENT"
    assert len(await listed_documents(api, ws)) == 0


async def listed_documents(api: Any, ws: Any) -> list[str]:
    return listed(await list_items(api, ws, filter='itemType="DOCUMENT"'))


async def test_create_document_too_large(client, world, runtime):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)
    too_large = runtime.config.upload.max_upload_bytes + 1

    response = await api.post(
        f"{ws_url(ws)}/items", json=document_spec(root, sizeBytes=str(too_large))
    )

    assert response.status_code == 400, response.text
    assert error_reason(response) == "FILE_TOO_LARGE"


async def test_create_document_is_pending_with_upload_uri_for_creator_only(
    client, world, knowledge, fakes
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    creator = await world.add_member(ws)
    colleague = await world.add_member(ws)
    root = await world.make_collection(ws, grants={creator: EDITOR, colleague: EDITOR})
    api = await client.as_(creator)

    response = await api.post(f"{ws_url(ws)}/items", json=document_spec(root))

    assert response.status_code == 200, response.text
    body = response.json()
    document = body["document"]
    assert body["itemType"] == "DOCUMENT"
    assert body["parentItem"] == item_name(root)
    assert document["contentState"] == "PENDING"
    assert document["publicationState"] == "PUBLISHED"
    assert document["indexingState"] == "PENDING"
    assert document["mimeType"] == "application/pdf"
    assert document["sizeBytes"] == "10"
    assert document["fileName"] == "policy.pdf"
    assert document["purpose"] == "KNOWLEDGE"
    assert document["documentType"] == "pdf"
    assert "revision" not in document
    row = await knowledge.row(item_id(body))
    assert document["uploadUri"].startswith("https://storage.test/")
    assert row.storage_key in document["uploadUri"]
    assert row.status == "pending"
    assert await knowledge.revisions(row) == []
    assert fakes.storage.objects == {}

    again = await api.get(item_url(row))
    assert again.json()["document"]["uploadUri"].startswith("https://storage.test/")
    other = await (await client.as_(colleague)).get(item_url(row))
    assert other.status_code == 200, other.text
    assert other.json()["document"]["contentState"] == "PENDING"
    assert "uploadUri" not in other.json()["document"]


async def test_create_with_same_request_id_and_body_replays(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)
    request_id = str(uuid4())
    spec = document_spec(root)

    first = await api.post(f"{ws_url(ws)}/items", json=spec, params={"requestId": request_id})
    second = await api.post(f"{ws_url(ws)}/items", json=spec, params={"requestId": request_id})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["name"] == first.json()["name"]
    children = listed(await list_items(api, ws, filter=f'parentItem="{item_name(root)}"'))
    assert children == [first.json()["name"]]


async def test_create_with_reused_request_id_and_other_body_is_rejected(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)
    request_id = str(uuid4())

    first = await api.post(
        f"{ws_url(ws)}/items", json=document_spec(root), params={"requestId": request_id}
    )
    changed = {**document_spec(root), "displayName": "Another"}
    second = await api.post(f"{ws_url(ws)}/items", json=changed, params={"requestId": request_id})

    assert first.status_code == 200, first.text
    assert second.status_code == 400, second.text
    assert status_of(second) == "INVALID_ARGUMENT"
    assert error_reason(second) == "REQUEST_ID_REUSED"
    children = listed(await list_items(api, ws, filter=f'parentItem="{item_name(root)}"'))
    assert children == [first.json()["name"]]


# -- GetItem ---------------------------------------------------------------------


async def test_viewer_gets_published_document_but_not_unpublished(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: VIEWER, editor: EDITOR})
    published = await world.make_document(root, title="Published")
    unpublished = await world.make_document(root, published=False, title="Draft")
    viewer_api = await client.as_(viewer)
    editor_api = await client.as_(editor)

    seen = await viewer_api.get(item_url(published))
    hidden = await viewer_api.get(item_url(unpublished))
    as_editor = await editor_api.get(item_url(unpublished))

    assert seen.status_code == 200, seen.text
    assert seen.json()["displayName"] == "Published"
    assert seen.json()["access"] == "READER"
    assert seen.json()["document"]["publicationState"] == "PUBLISHED"
    assert hidden.status_code == 403, hidden.text
    assert status_of(hidden) == "PERMISSION_DENIED"
    assert as_editor.status_code == 200, as_editor.text
    assert as_editor.json()["access"] == "EDITOR"
    assert as_editor.json()["document"]["publicationState"] == "UNPUBLISHED"


async def test_get_unreadable_is_denied_and_missing_is_not_found_for_admin(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    root = await world.make_collection(ws)
    document = await world.make_document(root)
    member_api = await client.as_(member)
    admin_api = await client.as_(admin)
    missing = f"{ws_url(ws)}/items/{uuid4()}"

    assert (await member_api.get(item_url(root))).status_code == 403
    assert (await member_api.get(item_url(document))).status_code == 403
    assert (await member_api.get(missing)).status_code == 403
    not_found = await admin_api.get(missing)
    assert not_found.status_code == 404, not_found.text
    assert status_of(not_found) == "NOT_FOUND"


async def test_get_full_view_lists_ancestors_root_first(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    root = await world.make_collection(ws, title="Root", grants={viewer: VIEWER})
    folder = await world.make_collection(ws, root, title="Folder")
    subfolder = await world.make_collection(ws, folder, title="Subfolder")
    document = await world.make_document(subfolder)
    api = await client.as_(viewer)

    full = await api.get(item_url(document), params={"view": "FULL"})
    basic = await api.get(item_url(document), params={"view": "BASIC"})

    assert full.status_code == 200, full.text
    assert full.json()["ancestors"] == [
        {"name": item_name(root), "displayName": "Root"},
        {"name": item_name(folder), "displayName": "Folder"},
        {"name": item_name(subfolder), "displayName": "Subfolder"},
    ]
    assert basic.status_code == 200, basic.text
    assert "ancestors" not in basic.json()


async def test_deleted_item_is_visible_only_to_undelete_holders(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: OWNER, editor: EDITOR})
    document = await world.make_document(root)
    await world.delete(document)

    as_owner = await (await client.as_(owner)).get(item_url(document))
    as_editor = await (await client.as_(editor)).get(item_url(document))

    assert as_owner.status_code == 200, as_owner.text
    body = as_owner.json()
    assert body["state"] == "DELETED"
    assert body["deleteTime"]
    assert body["purgeTime"]
    assert as_editor.status_code == 403, as_editor.text


async def test_locked_projection_of_discoverable_root(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    root = await world.make_collection(ws, title="Legal")
    document = await world.make_document(root)
    await make_discoverable(await client.as_(admin), root, description="Contracts and NDAs")
    api = await client.as_(member)

    response = await api.get(item_url(root), params={"view": "FULL"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == item_name(root)
    assert body["displayName"] == "Legal"
    assert body["access"] == "LOCKED"
    assert set(body) <= {"name", "itemType", "displayName", "access", "collection"}
    assert body["collection"] == {"description": "Contracts and NDAs"}
    denied = await api.get(item_url(document))
    assert denied.status_code == 403, denied.text


async def test_non_discoverable_unreadable_root_is_denied(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    root = await world.make_collection(ws)

    response = await (await client.as_(member)).get(item_url(root))

    assert response.status_code == 403, response.text
    assert status_of(response) == "PERMISSION_DENIED"


async def test_alt_media_redirects_to_signed_original(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    stranger = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: VIEWER})
    created = await upload(await client.as_(admin), root)
    assert created.status_code == 200, created.text
    row = await knowledge.row(item_id(created.json()))

    response = await (await client.as_(viewer)).get(item_url(row), params={"alt": "media"})
    denied = await (await client.as_(stranger)).get(item_url(row), params={"alt": "media"})
    on_collection = await (await client.as_(admin)).get(item_url(root), params={"alt": "media"})

    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith("https://storage.test/test-bucket/")
    assert row.storage_key in location
    assert denied.status_code == 403, denied.text
    assert on_collection.status_code == 400, on_collection.text
    assert status_of(on_collection) == "INVALID_ARGUMENT"


async def test_alt_media_on_deleted_document_is_not_found(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: OWNER})
    created = await upload(await client.as_(owner), root)
    row = await knowledge.row(item_id(created.json()))
    await world.delete(row)
    api = await client.as_(owner)

    assert (await api.get(item_url(row))).json()["state"] == "DELETED"
    response = await api.get(item_url(row), params={"alt": "media"})

    assert response.status_code == 404, response.text
    assert status_of(response) == "NOT_FOUND"


async def test_reviewer_of_open_contribution_gets_candidate(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    contributor = await world.add_member(ws)
    reviewer = await world.add_member(ws)
    personal = await world.make_collection(ws, personal_for=contributor)
    target = await world.make_collection(ws, grants={reviewer: OWNER})
    in_review = await world.make_document(personal, creator=contributor, title="In review")
    rejected = await world.make_document(personal, creator=contributor, title="Rejected")
    await world.make_contribution(in_review, contributor=contributor, target=target)
    await world.make_contribution(
        rejected, contributor=contributor, target=target, state="rejected"
    )
    api = await client.as_(reviewer)

    response = await api.get(item_url(in_review))
    closed = await api.get(item_url(rejected))
    everything = listed(await list_items(api, ws))

    assert response.status_code == 200, response.text
    assert response.json()["displayName"] == "In review"
    assert closed.status_code == 403, closed.text
    assert item_name(in_review) not in everything
    assert item_name(personal) not in everything


# -- ListItems -------------------------------------------------------------------


async def test_list_roots_children_and_subtree(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    alpha = await world.make_collection(ws, title="Alpha")
    beta = await world.make_collection(ws, title="Beta")
    folder = await world.make_collection(ws, alpha, title="Folder")
    top_doc = await world.make_document(alpha, title="Top")
    deep_doc = await world.make_document(folder, title="Deep")
    await world.make_document(beta, title="Elsewhere")
    api = await client.as_(admin)

    roots = listed(await list_items(api, ws, filter='parentItem=""'))
    children = listed(await list_items(api, ws, filter=f'parentItem="{item_name(alpha)}"'))
    subtree = listed(await list_items(api, ws, filter=f'ancestors:"{item_name(alpha)}"'))
    documents = listed(
        await list_items(
            api, ws, filter=f'ancestors:"{item_name(alpha)}" AND itemType="DOCUMENT"'
        )
    )

    assert roots == [item_name(alpha), item_name(beta)]
    assert set(children) == {item_name(folder), item_name(top_doc)}
    assert set(subtree) == {item_name(folder), item_name(top_doc), item_name(deep_doc)}
    assert set(documents) == {item_name(top_doc), item_name(deep_doc)}


async def test_list_returns_only_visible_items(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    readable = await world.make_collection(ws, title="Readable", grants={viewer: VIEWER})
    await world.make_collection(ws, title="Hidden")
    published = await world.make_document(readable)
    await world.make_document(readable, published=False)
    boundary = await world.make_collection(ws, readable, inherit_access=False)
    api = await client.as_(viewer)

    roots = listed(await list_items(api, ws, filter='parentItem=""'))
    children = listed(await list_items(api, ws, filter=f'parentItem="{item_name(readable)}"'))

    assert roots == [item_name(readable)]
    assert children == [item_name(published)]
    assert item_name(boundary) not in listed(await list_items(api, ws))


async def test_list_filter_on_publication_state(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    published = await world.make_document(root)
    unpublished = await world.make_document(root, published=False)
    api = await client.as_(admin)

    only_unpublished = listed(
        await list_items(api, ws, filter='document.publicationState="UNPUBLISHED"')
    )
    only_published = listed(
        await list_items(api, ws, filter='document.publicationState="PUBLISHED"')
    )

    assert only_unpublished == [item_name(unpublished)]
    assert only_published == [item_name(published)]


async def test_list_filter_naming_unreadable_item_is_denied(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    hidden = await world.make_collection(ws)
    api = await client.as_(member)

    for expression in (f'parentItem="{item_name(hidden)}"', f'ancestors:"{item_name(hidden)}"'):
        response = await list_items(api, ws, filter=expression)
        assert response.status_code == 403, response.text
        assert status_of(response) == "PERMISSION_DENIED"


async def test_list_order_by(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    second = await world.make_document(root, title="Bravo")
    first = await world.make_document(root, title="Alpha")
    third = await world.make_document(root, title="Charlie")
    api = await client.as_(admin)
    in_root = f'parentItem="{item_name(root)}"'
    # Touch "Alpha" last so updateTime order differs from displayName order.
    touched = await api.patch(
        item_url(first), params={"updateMask": "document.summary"},
        json={"document": {"summary": "touched"}},
    )
    assert touched.status_code == 200, touched.text

    by_name = listed(await list_items(api, ws, filter=in_root, orderBy="displayName"))
    by_name_desc = listed(await list_items(api, ws, filter=in_root, orderBy="displayName desc"))
    by_update_desc = listed(await list_items(api, ws, filter=in_root, orderBy="updateTime desc"))

    assert by_name == [item_name(first), item_name(second), item_name(third)]
    assert by_name_desc == [item_name(third), item_name(second), item_name(first)]
    assert by_update_desc[0] == item_name(first)
    bad = await list_items(api, ws, filter=in_root, orderBy="purgeTime")
    assert bad.status_code == 400, bad.text


async def test_list_paging_and_total_size(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    documents = [await world.make_document(root, title=f"Doc {n}") for n in range(3)]
    api = await client.as_(admin)
    in_root = f'parentItem="{item_name(root)}"'

    seen: list[str] = []
    token: str | None = None
    pages = 0
    while True:
        params: dict[str, Any] = {"filter": in_root, "pageSize": 1}
        if token:
            params["pageToken"] = token
        response = await list_items(api, ws, **params)
        page = listed(response)
        assert len(page) == 1
        assert response.json()["totalSize"] == 3
        seen += page
        pages += 1
        token = response.json().get("nextPageToken")
        if not token:
            break

    assert pages == 3
    assert seen == [item_name(document) for document in documents]
    stale = await list_items(
        api, ws, filter='itemType="COLLECTION"', pageSize=1, pageToken=(
            (await list_items(api, ws, filter=in_root, pageSize=1)).json()["nextPageToken"]
        )
    )
    assert stale.status_code == 400, stale.text


async def test_list_show_deleted_only_for_undelete_holders(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await world.add_member(ws)
    viewer = await world.add_member(ws)
    root = await world.make_collection(ws, grants={owner: OWNER, viewer: VIEWER})
    live = await world.make_document(root)
    deleted = await world.make_document(root)
    await world.delete(deleted)
    in_root = f'parentItem="{item_name(root)}"'
    owner_api = await client.as_(owner)
    viewer_api = await client.as_(viewer)

    default = listed(await list_items(owner_api, ws, filter=in_root))
    with_deleted = await list_items(owner_api, ws, filter=in_root, showDeleted=True)
    viewer_deleted = listed(await list_items(viewer_api, ws, filter=in_root, showDeleted=True))

    assert default == [item_name(live)]
    states = {item["name"]: item["state"] for item in with_deleted.json()["items"]}
    assert states == {item_name(live): "ACTIVE", item_name(deleted): "DELETED"}
    assert viewer_deleted == [item_name(live)]


async def test_list_show_locked_adds_discoverable_roots_last(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    readable = await world.make_collection(ws, title="Zulu", grants={member: VIEWER})
    locked = await world.make_collection(ws, title="Alpha")
    await world.make_collection(ws, title="Bravo")
    await world.make_document(locked)
    await make_discoverable(await client.as_(admin), locked)
    api = await client.as_(member)

    plain = listed(await list_items(api, ws, filter='parentItem=""'))
    response = await list_items(api, ws, filter='parentItem=""', showLocked=True)

    assert plain == [item_name(readable)]
    assert listed(response) == [item_name(readable), item_name(locked)]
    last = response.json()["items"][-1]
    assert last["access"] == "LOCKED"
    assert "childCount" not in last.get("collection", {})
    assert "documentCount" not in last.get("collection", {})
    assert response.json()["items"][0]["access"] == "READER"


async def test_hidden_artifacts_collection_is_never_listed_nor_gettable(
    client, world, sessions
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    user = await world.add_member(ws)
    artifacts = await world.make_collection(ws, title="My documents")
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == artifacts.id)
            .values(metadata_={"system_kind": "conversation_artifacts"})
        )
    await world.grant(user, OWNER, on=artifacts)
    artifact = await world.make_document(artifacts, creator=user)
    api = await client.as_(user)

    everything = listed(await list_items(api, ws))
    admin_everything = listed(await list_items(await client.as_(admin), ws))
    by_parent = await list_items(api, ws, filter=f'parentItem="{item_name(artifacts)}"')

    for names in (everything, admin_everything):
        assert item_name(artifacts) not in names
        assert item_name(artifact) not in names
    assert by_parent.status_code == 403, by_parent.text
    assert (await api.get(item_url(artifacts))).status_code == 403
    assert (await api.get(item_url(artifact))).status_code == 403
    assert (await (await client.as_(admin)).get(item_url(artifact))).status_code == 404


# -- UpdateItem ------------------------------------------------------------------


async def test_update_collection_display_name_and_description(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: EDITOR})
    api = await client.as_(editor)

    response = await api.patch(
        item_url(root),
        params={"updateMask": "displayName,collection.description"},
        json={"displayName": "Renamed", "collection": {"description": "About it"}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["displayName"] == "Renamed"
    assert response.json()["collection"]["description"] == "About it"
    row = await knowledge.row(root)
    assert row.title == "Renamed"
    assert row.metadata_["description"] == "About it"


async def test_update_document_metadata(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: EDITOR})
    document = await world.make_document(root)
    api = await client.as_(editor)

    response = await api.patch(
        item_url(document),
        params={"updateMask": "document.summary,document.languageCode,document.documentType"},
        json={
            "document": {"summary": "Short", "languageCode": "vi", "documentType": "contract"}
        },
    )

    assert response.status_code == 200, response.text
    facet = response.json()["document"]
    assert facet["summary"] == "Short"
    assert facet["languageCode"] == "vi"
    assert facet["documentType"] == "contract"
    row = await knowledge.row(document)
    assert row.document_type == "contract"
    assert row.metadata_["summary"] == "Short"
    assert row.metadata_["language"] == "vi"


async def test_update_rejects_unknown_and_immutable_paths(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws, title="Kept")
    other = await world.make_collection(ws)
    api = await client.as_(admin)

    for mask, body in (
        ("parentItem", {"parentItem": item_name(other)}),
        ("itemType", {"itemType": "DOCUMENT"}),
        ("collection.kind", {"collection": {"kind": "PERSONAL"}}),
        ("noSuchField", {}),
        ("document.summary", {"document": {"summary": "x"}}),
    ):
        response = await api.patch(item_url(root), params={"updateMask": mask}, json=body)
        assert response.status_code == 400, (mask, response.text)
        assert status_of(response) == "INVALID_ARGUMENT"
    row = await knowledge.row(root)
    assert row.title == "Kept"
    assert row.parent_item_id is None


async def test_update_with_stale_etag_is_aborted(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)
    etag = (await api.get(item_url(root))).json()["etag"]

    fresh = await api.patch(
        item_url(root), params={"updateMask": "displayName"},
        json={"displayName": "First", "etag": etag},
    )
    stale = await api.patch(
        item_url(root), params={"updateMask": "displayName"},
        json={"displayName": "Second", "etag": etag},
    )

    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["etag"] != etag
    assert stale.status_code == 409, stale.text
    assert status_of(stale) == "ABORTED"
    assert (await knowledge.row(root)).title == "First"


async def test_update_inherit_access_needs_set_iam_policy(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    owner = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: EDITOR, owner: OWNER})
    folder = await world.make_collection(ws, root)
    body = {"collection": {"inheritAccess": False}}
    mask = {"updateMask": "collection.inheritAccess"}

    denied = await (await client.as_(editor)).patch(item_url(folder), params=mask, json=body)
    assert denied.status_code == 403, denied.text
    assert (await knowledge.row(folder)).inherit_access is True

    allowed = await (await client.as_(owner)).patch(item_url(folder), params=mask, json=body)
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["collection"]["inheritAccess"] is False
    assert (await knowledge.row(folder)).inherit_access is False


async def test_update_root_inherit_access_true_is_invalid(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)

    response = await (await client.as_(admin)).patch(
        item_url(root),
        params={"updateMask": "collection.inheritAccess"},
        json={"collection": {"inheritAccess": True}},
    )

    assert response.status_code == 400, response.text
    assert status_of(response) == "INVALID_ARGUMENT"
    assert (await knowledge.row(root)).inherit_access is False


async def test_update_by_viewer_is_denied(client, world, knowledge):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    root = await world.make_collection(ws, title="Kept", grants={viewer: VIEWER})

    response = await (await client.as_(viewer)).patch(
        item_url(root), params={"updateMask": "displayName"}, json={"displayName": "Nope"}
    )

    assert response.status_code == 403, response.text
    assert status_of(response) == "PERMISSION_DENIED"
    assert (await knowledge.row(root)).title == "Kept"


# -- Counts ----------------------------------------------------------------------


async def test_counts_cover_only_visible_children_and_published_readable_documents(
    client, world
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: VIEWER, editor: EDITOR})
    await world.make_document(root)
    await world.make_document(root, published=False)
    folder = await world.make_collection(ws, root)
    await world.make_document(folder)
    await world.make_document(folder, published=False)
    boundary = await world.make_collection(ws, root, inherit_access=False)
    await world.make_document(boundary)
    deleted = await world.make_document(root)
    await world.delete(deleted)

    async def counts(user: Any) -> tuple[int, int]:
        response = await (await client.as_(user)).get(item_url(root))
        assert response.status_code == 200, response.text
        facet = response.json()["collection"]
        return facet.get("childCount", 0), facet.get("documentCount", 0)

    # viewer: published doc + folder; published docs in root and folder.
    assert await counts(viewer) == (2, 2)
    # editor: also the unpublished doc as a child; documentCount stays published-only.
    assert await counts(editor) == (3, 2)
    # admin reads every collection, the boundary and its document included.
    assert await counts(admin) == (4, 3)
