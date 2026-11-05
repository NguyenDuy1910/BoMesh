"""Collection IAM policies and item links (``item_model.md`` §4.2, §8)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemLink
from knowledge_support import error_reason, item_name, item_url

pytestmark = pytest.mark.asyncio

VIEWER = "roles/collectionViewer"
EDITOR = "roles/collectionEditor"
OWNER = "roles/collectionOwner"


# -- Helpers -------------------------------------------------------------------------


def _user(user: Any) -> str:
    return f"user:{user.id}"


def _bindings(policy: dict[str, Any]) -> dict[str, set[str]]:
    return {b["role"]: set(b["members"]) for b in policy.get("bindings") or []}


async def _member(world: Any, ws: Any, grants: dict[Item, str] | None = None) -> Any:
    user = await world.add_member(ws)
    for item, role in (grants or {}).items():
        await world.grant(user, role, on=item)
    return user


async def _set_metadata(sessions: Any, item: Item, **values: Any) -> None:
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, item.id)
        assert row is not None
        row.metadata_ = {**row.metadata_, **values}


async def _set_policy(api: Any, item: Item, bindings: dict[str, set[str]], etag: str | None) -> Any:
    policy: dict[str, Any] = {
        "bindings": [{"role": role, "members": sorted(members)} for role, members in bindings.items()]
    }
    if etag is not None:
        policy["etag"] = etag
    return await api.post(item_url(item, ":setIamPolicy"), json={"policy": policy})


def _link_url(container: Item, target: Item | None = None) -> str:
    return item_url(container, f"/links/{target.id}" if target is not None else "/links")


def _link_name(container: Item, target: Item) -> str:
    return f"{item_name(container)}/links/{target.id}"


async def _link(api: Any, container: Item, target: Item, **params: Any) -> Any:
    return await api.post(
        _link_url(container), json={"targetItem": item_name(target)}, params=params or None
    )


async def _live_links(sessions: Any, container: Item) -> int:
    async with transaction_scope(sessions) as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(ItemLink)
                .where(ItemLink.collection_item_id == container.id, ItemLink.deleted_at.is_(None))
            )
            or 0
        )


async def _world(world: Any, client: Any) -> tuple[Any, Any, Any, Item, Item]:
    """An admin, its workspace and client, a container collection and a home collection."""
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    container = await world.make_collection(ws, title="Container")
    home = await world.make_collection(ws, title="Home")
    return admin, ws, await client.as_(admin), container, home


# -- GetItemIamPolicy / SetItemIamPolicy ----------------------------------------------


async def test_owner_reads_the_direct_policy(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    owner = await _member(world, ws, {root: OWNER})
    child = await world.make_collection(ws, parent=root)
    api = await client.as_(owner)

    response = await api.post(item_url(root, ":getIamPolicy"), json={})
    assert response.status_code == 200, response.text
    assert _bindings(response.json()) == {OWNER: {_user(owner)}}
    assert response.json()["etag"]

    # Inherited bindings are not part of a child's policy.
    response = await api.post(item_url(child, ":getIamPolicy"), json={})
    assert response.status_code == 200, response.text
    assert _bindings(response.json()) == {}


async def test_set_policy_grants_read_access(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    owner = await _member(world, ws, {collection: OWNER})
    reader = await _member(world, ws)
    api = await client.as_(owner)
    reader_api = await client.as_(reader)
    assert (await reader_api.get(item_url(collection))).status_code == 403

    current = (await api.post(item_url(collection, ":getIamPolicy"), json={})).json()
    bindings = _bindings(current)
    bindings[VIEWER] = {_user(reader)}
    response = await _set_policy(api, collection, bindings, current["etag"])
    assert response.status_code == 200, response.text
    assert _bindings(response.json()) == {OWNER: {_user(owner)}, VIEWER: {_user(reader)}}
    assert response.json()["etag"] != current["etag"]

    read = await reader_api.get(item_url(collection))
    assert read.status_code == 200, read.text
    assert read.json()["name"] == item_name(collection)

    again = await api.post(item_url(collection, ":getIamPolicy"), json={})
    assert _bindings(again.json()) == _bindings(response.json())
    assert again.json()["etag"] == response.json()["etag"]


async def test_workspace_members_may_only_view(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    api = await client.as_(admin)

    response = await _set_policy(api, collection, {EDITOR: {"workspaceMembers"}}, None)
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"

    response = await _set_policy(api, collection, {VIEWER: {"workspaceMembers"}}, None)
    assert response.status_code == 200, response.text
    assert _bindings(response.json()) == {VIEWER: {"workspaceMembers"}}
    member = await client.as_(await _member(world, ws))
    assert (await member.get(item_url(collection))).status_code == 200


async def test_stale_policy_etag_is_aborted(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    first = await _member(world, ws)
    second = await _member(world, ws)
    api = await client.as_(admin)

    stale = (await api.post(item_url(collection, ":getIamPolicy"), json={})).json()["etag"]
    response = await _set_policy(api, collection, {VIEWER: {_user(first)}}, stale)
    assert response.status_code == 200, response.text

    response = await _set_policy(api, collection, {VIEWER: {_user(second)}}, stale)
    assert response.status_code == 409, response.text
    current = await api.post(item_url(collection, ":getIamPolicy"), json={})
    assert _bindings(current.json()) == {VIEWER: {_user(first)}}


async def test_document_has_no_policy(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    document = await world.make_document(collection)
    api = await client.as_(admin)

    response = await api.post(item_url(document, ":getIamPolicy"), json={})
    assert response.status_code == 400, response.text
    assert error_reason(response) == "POLICY_ON_DOCUMENT"

    response = await _set_policy(api, document, {VIEWER: {"workspaceMembers"}}, None)
    assert response.status_code == 400, response.text
    assert error_reason(response) == "POLICY_ON_DOCUMENT"


async def test_personal_collection_cannot_be_shared(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    owner = await _member(world, ws)
    friend = await _member(world, ws)
    personal = await world.make_collection(ws, personal_for=owner)
    api = await client.as_(owner)

    response = await _set_policy(
        api, personal, {OWNER: {_user(owner)}, VIEWER: {_user(friend)}}, None
    )
    assert response.status_code == 400, response.text
    assert error_reason(response) == "PERSONAL_COLLECTION"
    assert (await (await client.as_(friend)).get(item_url(personal))).status_code == 403


async def test_editor_cannot_read_or_set_policy(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    editor = await _member(world, ws, {collection: EDITOR})
    other = await _member(world, ws)
    api = await client.as_(editor)

    response = await _set_policy(api, collection, {VIEWER: {_user(other)}}, None)
    assert response.status_code == 403, response.text
    response = await api.post(item_url(collection, ":getIamPolicy"), json={})
    assert response.status_code == 403, response.text


async def test_granting_more_than_held_is_role_escalation(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    sharer_role = await world.make_role(
        ws,
        "sharer",
        [
            "items.get",
            "items.list",
            "items.search",
            "items.testIamPermissions",
            "itemLinks.get",
            "itemLinks.list",
            "tasks.get",
            "tasks.list",
            "items.getIamPolicy",
            "items.setIamPolicy",
        ],
    )
    sharer = await _member(world, ws, {collection: sharer_role})
    other = await _member(world, ws)
    api = await client.as_(sharer)
    etag = (await api.post(item_url(collection, ":getIamPolicy"), json={})).json()["etag"]
    sharer_role_name = f"workspaces/{ws.id}/roles/sharer"

    response = await _set_policy(
        api, collection, {sharer_role_name: {_user(sharer)}, EDITOR: {_user(other)}}, etag
    )
    assert response.status_code == 403, response.text
    assert error_reason(response) == "ROLE_ESCALATION"
    assert (await (await client.as_(other)).get(item_url(collection))).status_code == 403

    response = await _set_policy(
        api, collection, {sharer_role_name: {_user(sharer)}, VIEWER: {_user(other)}}, etag
    )
    assert response.status_code == 200, response.text
    assert _bindings(response.json())[VIEWER] == {_user(other)}


# -- TestItemIamPermissions -----------------------------------------------------------


async def test_permissions_returns_the_held_subset(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    document = await world.make_document(collection)
    viewer = await _member(world, ws, {collection: VIEWER})
    api = await client.as_(viewer)
    asked = ["items.get", "items.update", "items.delete", "itemLinks.get", "items.setIamPolicy"]

    for item in (collection, document):
        response = await api.post(item_url(item, ":testIamPermissions"), json={"permissions": asked})
        assert response.status_code == 200, response.text
        assert response.json()["permissions"] == ["items.get", "itemLinks.get"]

    owner = await client.as_(await _member(world, ws, {collection: OWNER}))
    response = await owner.post(
        item_url(document, ":testIamPermissions"), json={"permissions": asked}
    )
    assert response.status_code == 200, response.text
    assert response.json()["permissions"] == asked


async def test_permissions_never_denied_for_missing_ones(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    member = await client.as_(await _member(world, ws))

    response = await member.post(
        item_url(collection, ":testIamPermissions"),
        json={"permissions": ["items.get", "items.delete"]},
    )
    assert response.status_code == 200, response.text
    assert response.json().get("permissions", []) == []


# -- CreateItemLink -------------------------------------------------------------------


async def test_create_link(client, world, sessions):
    _, ws, _, container, home = await _world(world, client)
    target = await world.make_document(home, title="Leave policy")
    editor = await _member(world, ws, {container: EDITOR, home: VIEWER})
    api = await client.as_(editor)

    response = await _link(api, container, target)
    assert response.status_code == 200, response.text
    link = response.json()
    assert link["name"] == _link_name(container, target)
    assert link["targetItem"] == item_name(target)
    assert link["targetDisplayName"] == "Leave policy"
    assert link["creator"] == f"workspaces/{ws.id}/members/{editor.id}"
    assert link["createTime"]
    assert link.get("mergedFrom") is None
    assert link.get("deleteTime") is None
    assert await _live_links(sessions, container) == 1

    # Links are not hierarchy: the target keeps its parent.
    item = await api.get(item_url(target))
    assert item.json()["parentItem"] == item_name(home)


async def test_create_link_to_unreadable_target_is_denied(client, world, sessions):
    _, ws, _, container, home = await _world(world, client)
    target = await world.make_document(home)
    editor = await _member(world, ws, {container: EDITOR})

    response = await _link(await client.as_(editor), container, target)
    assert response.status_code == 403, response.text
    assert await _live_links(sessions, container) == 0


async def test_create_link_needs_create_permission_on_container(client, world):
    _, ws, _, container, home = await _world(world, client)
    target = await world.make_document(home)
    viewer = await _member(world, ws, {container: VIEWER, home: VIEWER})

    response = await _link(await client.as_(viewer), container, target)
    assert response.status_code == 403, response.text


async def test_create_link_to_collection(client, world):
    _, _, api, container, home = await _world(world, client)
    response = await _link(api, container, home)
    assert response.status_code == 400, response.text
    assert error_reason(response) == "LINK_TARGET_NOT_DOCUMENT"


async def test_create_link_in_document_container(client, world):
    _, _, api, _, home = await _world(world, client)
    container = await world.make_document(home)
    target = await world.make_document(home)
    response = await _link(api, container, target)
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_create_link_to_own_child(client, world):
    _, _, api, container, _ = await _world(world, client)
    target = await world.make_document(container)
    response = await _link(api, container, target)
    assert response.status_code == 400, response.text
    assert error_reason(response) == "LINK_TO_OWN_PARENT"


async def test_create_link_to_attachment_or_candidate(client, world, sessions):
    admin, _, api, container, home = await _world(world, client)
    attachment = await world.make_document(home)
    await _set_metadata(sessions, attachment, purpose="conversation_attachment")
    candidate = await world.make_document(home)
    await world.make_contribution(candidate, contributor=admin, target=home)

    for target in (attachment, candidate):
        response = await _link(api, container, target)
        assert response.status_code == 400, response.text
        assert error_reason(response) == "LINK_TARGET_NOT_ALLOWED"
    assert await _live_links(sessions, container) == 0


async def test_create_link_to_deleted_target(client, world):
    _, _, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    await world.delete(target)
    response = await _link(api, container, target)
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_create_duplicate_link(client, world, sessions):
    _, _, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    assert (await _link(api, container, target)).status_code == 200

    response = await _link(api, container, target)
    assert response.status_code == 409, response.text
    assert response.json()["error"]["status"] == "ALREADY_EXISTS"
    assert await _live_links(sessions, container) == 1


async def test_create_link_request_id_replay(client, world, sessions):
    _, _, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    request_id = str(uuid4())

    first = await _link(api, container, target, requestId=request_id)
    assert first.status_code == 200, first.text
    second = await _link(api, container, target, requestId=request_id)
    assert second.status_code == 200, second.text
    assert second.json()["name"] == first.json()["name"]
    assert second.json()["createTime"] == first.json()["createTime"]
    assert await _live_links(sessions, container) == 1


# -- ListItemLinks / GetItemLink ------------------------------------------------------


async def test_list_links_omits_unreadable_targets(client, world):
    _, ws, api, container, home = await _world(world, client)
    secret = await world.make_collection(ws, title="Secret")
    readable = await world.make_document(home, title="Readable")
    hidden = await world.make_document(secret, title="Hidden")
    for target in (readable, hidden):
        assert (await _link(api, container, target)).status_code == 200
    reader = await client.as_(await _member(world, ws, {container: VIEWER, home: VIEWER}))

    response = await reader.get(_link_url(container))
    assert response.status_code == 200, response.text
    assert [link["name"] for link in response.json()["links"]] == [
        _link_name(container, readable)
    ]

    item = await reader.get(item_url(container))
    assert item.json()["collection"]["linkCount"] == 1
    item = await api.get(item_url(container))
    assert item.json()["collection"]["linkCount"] == 2

    response = await reader.get(_link_url(container, hidden))
    assert response.status_code == 404, response.text
    response = await reader.get(_link_url(container, readable))
    assert response.status_code == 200, response.text
    assert response.json()["targetDisplayName"] == "Readable"


async def test_list_links_needs_container_access(client, world):
    _, ws, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    assert (await _link(api, container, target)).status_code == 200
    outsider = await client.as_(await _member(world, ws, {home: VIEWER}))

    assert (await outsider.get(_link_url(container))).status_code == 403
    assert (await outsider.get(_link_url(container, target))).status_code == 403


async def test_list_links_order_and_paging(client, world):
    _, _, api, container, home = await _world(world, client)
    titles = ["Zeta", "Alpha", "Mid"]
    for title in titles:
        target = await world.make_document(home, title=title)
        assert (await _link(api, container, target)).status_code == 200

    default = await api.get(_link_url(container))
    assert default.status_code == 200, default.text
    assert [link["targetDisplayName"] for link in default.json()["links"]] == titles

    by_name = await api.get(_link_url(container), params={"orderBy": "targetDisplayName"})
    assert by_name.status_code == 200, by_name.text
    assert [link["targetDisplayName"] for link in by_name.json()["links"]] == ["Alpha", "Mid", "Zeta"]

    newest = await api.get(_link_url(container), params={"orderBy": "createTime desc"})
    assert newest.status_code == 200, newest.text
    assert [link["targetDisplayName"] for link in newest.json()["links"]] == ["Mid", "Alpha", "Zeta"]

    first = await api.get(
        _link_url(container), params={"orderBy": "targetDisplayName", "pageSize": 2}
    )
    assert [link["targetDisplayName"] for link in first.json()["links"]] == ["Alpha", "Mid"]
    token = first.json()["nextPageToken"]
    second = await api.get(
        _link_url(container),
        params={"orderBy": "targetDisplayName", "pageSize": 2, "pageToken": token},
    )
    assert second.status_code == 200, second.text
    assert [link["targetDisplayName"] for link in second.json()["links"]] == ["Zeta"]
    assert not second.json().get("nextPageToken")


async def test_list_links_of_document_is_invalid(client, world):
    _, _, api, _, home = await _world(world, client)
    document = await world.make_document(home)
    response = await api.get(_link_url(document))
    assert response.status_code == 400, response.text


async def test_get_missing_link(client, world):
    _, _, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    response = await api.get(_link_url(container, target))
    assert response.status_code == 404, response.text


async def test_link_to_merged_duplicate_resolves_to_merge_target(client, world):
    _, _, api, container, home = await _world(world, client)
    duplicate = await world.make_document(home, title="Duplicate")
    survivor = await world.make_document(home, title="Survivor")
    assert (await _link(api, container, duplicate)).status_code == 200

    merged = await api.post(item_url(duplicate, ":merge"), json={"targetItem": item_name(survivor)})
    assert merged.status_code == 200, merged.text

    response = await api.get(_link_url(container, duplicate))
    assert response.status_code == 200, response.text
    link = response.json()
    assert link["name"] == _link_name(container, duplicate)
    assert link["targetItem"] == item_name(survivor)
    assert link["mergedFrom"] == item_name(duplicate)
    assert link["targetDisplayName"] == "Survivor"

    listed = await api.get(_link_url(container))
    assert [link["targetItem"] for link in listed.json()["links"]] == [item_name(survivor)]


async def test_deleted_target_hides_link(client, world):
    _, _, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    assert (await _link(api, container, target)).status_code == 200
    await world.delete(target)

    assert (await api.get(_link_url(container, target))).status_code == 404
    assert (await api.get(_link_url(container))).json().get("links", []) == []


# -- DeleteItemLink -------------------------------------------------------------------


async def test_delete_link(client, world, sessions):
    _, ws, _, container, home = await _world(world, client)
    target = await world.make_document(home)
    editor = await client.as_(await _member(world, ws, {container: EDITOR, home: VIEWER}))
    assert (await _link(editor, container, target)).status_code == 200

    response = await editor.delete(_link_url(container, target))
    assert response.status_code == 200, response.text
    assert response.json()["name"] == _link_name(container, target)
    assert response.json()["deleteTime"]
    assert await _live_links(sessions, container) == 0

    assert (await editor.get(_link_url(container, target))).status_code == 404
    assert (await editor.get(_link_url(container))).json().get("links", []) == []
    # The target is never affected.
    assert (await editor.get(item_url(target))).status_code == 200
    # No undelete: the link is created again.
    assert (await _link(editor, container, target)).status_code == 200


async def test_delete_link_needs_delete_permission(client, world, sessions):
    _, ws, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    assert (await _link(api, container, target)).status_code == 200
    viewer = await client.as_(await _member(world, ws, {container: VIEWER, home: VIEWER}))

    response = await viewer.delete(_link_url(container, target))
    assert response.status_code == 403, response.text
    assert await _live_links(sessions, container) == 1


async def test_delete_container_then_undelete_restores_links(client, world):
    _, _, api, container, home = await _world(world, client)
    target = await world.make_document(home)
    assert (await _link(api, container, target)).status_code == 200

    deleted = await api.delete(item_url(container), params={"force": True})
    assert deleted.status_code == 200, deleted.text
    assert (await api.get(_link_url(container, target))).status_code == 404

    restored = await api.post(item_url(container, ":undelete"), json={})
    assert restored.status_code == 200, restored.text
    response = await api.get(_link_url(container, target))
    assert response.status_code == 200, response.text
    assert response.json()["targetItem"] == item_name(target)
    assert (await api.get(item_url(container))).json()["collection"]["linkCount"] == 1
