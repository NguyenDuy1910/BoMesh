"""Conversation CRUD and undelete: ownership, IDs, scope validation, lists."""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select, update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import AuditLog, Conversation
from conftest import Chat
from conversations_support import conversation_url, conversations_url, error_reason, item_name

pytestmark = pytest.mark.asyncio


async def test_create_with_chosen_id_scope_and_owner(chat: Chat) -> None:
    api = await chat.api()

    response = await api.post(
        conversations_url(chat.workspace),
        params={"conversationId": "trip-planning"},
        json={
            "displayName": "  Trip   planning ",
            "pinned": True,
            "scope": {"collections": [item_name(chat.handbook)]},
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == f"workspaces/{chat.workspace.id}/conversations/trip-planning"
    assert body["displayName"] == "Trip planning"
    assert body["owner"] == f"workspaces/{chat.workspace.id}/members/{chat.member.id}"
    assert body["pinned"] is True
    assert body["scope"] == {"collections": [item_name(chat.handbook)], "spaces": []}
    assert "deleteTime" not in body and "lastMessageTime" not in body
    again = await api.post(
        conversations_url(chat.workspace), params={"conversationId": "trip-planning"}, json={}
    )
    assert again.status_code == 409
    async with transaction_scope(chat.sessions) as session:
        audited = await session.scalar(
            select(func.count()).where(AuditLog.action == "CreateConversation")
        )
    assert audited == 1


async def test_server_generated_id_validate_only_and_request_id(chat: Chat) -> None:
    api = await chat.api()
    url = conversations_url(chat.workspace)

    generated = (await api.post(url, json={})).json()
    dry = await api.post(url, params={"validateOnly": "true", "conversationId": "dry"}, json={})
    request_id = str(uuid4())
    first = await api.post(url, params={"requestId": request_id}, json={"displayName": "A"})
    replay = await api.post(url, params={"requestId": request_id}, json={"displayName": "A"})
    reused = await api.post(url, params={"requestId": request_id}, json={"displayName": "B"})
    bad_id = await api.post(url, params={"conversationId": "Not_Valid"}, json={})

    code = generated["name"].rsplit("/", 1)[-1]
    assert code.startswith("r") and len(code) == 33
    assert dry.status_code == 200 and dry.json()["name"].endswith("/dry")
    assert (await api.get(conversation_url(chat.workspace, "dry"))).status_code == 404
    assert replay.json()["name"] == first.json()["name"]
    assert reused.status_code == 400 and error_reason(reused) == "REQUEST_ID_REUSED"
    assert bad_id.status_code == 400


async def test_scope_entries_must_be_readable_collections(chat: Chat) -> None:
    api = await chat.api()
    secret = await chat.world.make_collection(chat.workspace, title="Secret")
    url = conversations_url(chat.workspace)

    unreadable = await api.post(url, json={"scope": {"collections": [item_name(secret)]}})
    document = await api.post(url, json={"scope": {"collections": [item_name(chat.policy)]}})
    malformed = await api.post(url, json={"scope": {"collections": ["items/nope"]}})
    missing_space = await api.post(
        url, json={"scope": {"spaces": [f"workspaces/{chat.workspace.id}/spaces/nowhere"]}}
    )

    assert unreadable.status_code == 403
    assert document.status_code == 400
    assert malformed.status_code == 400
    assert missing_space.status_code == 403


async def test_scope_spaces_round_trip(chat: Chat) -> None:
    space = await chat.world.make_space(chat.workspace, chat.member, code="sales-team")
    name = f"workspaces/{chat.workspace.id}/spaces/sales-team"

    body = await chat.conversation(scope={"spaces": [name]})

    assert body["scope"] == {"collections": [], "spaces": [name]}
    async with transaction_scope(chat.sessions) as session:
        row = await session.scalar(select(Conversation))
    assert row is not None and row.scope_space_ids == [space.id]


async def test_conversations_are_owner_private(chat: Chat) -> None:
    other = await chat.world.add_member(chat.workspace)
    outsider = await chat.world.make_user()
    code = (await chat.conversation())["name"].rsplit("/", 1)[-1]
    url = conversation_url(chat.workspace, code)

    as_other = await (await chat.api(other)).get(url)
    as_outsider = await (await chat.api(outsider)).get(url)
    missing = await (await chat.api()).get(conversation_url(chat.workspace, "missing"))
    others_list = await (await chat.api(other)).get(conversations_url(chat.workspace))
    patch = await (await chat.api(other)).patch(url, json={"pinned": True})

    assert as_other.status_code == 403
    assert as_outsider.status_code == 403
    assert missing.status_code == 404
    assert others_list.json()["conversations"] == []
    assert patch.status_code == 403


async def test_update_mask_paths_and_scope(chat: Chat) -> None:
    api = await chat.api()
    code = (await chat.conversation(displayName="Old"))["name"].rsplit("/", 1)[-1]
    url = conversation_url(chat.workspace, code)
    secret = await chat.world.make_collection(chat.workspace, title="Secret")

    renamed = await api.patch(url, params={"updateMask": "displayName"}, json={"displayName": "New", "pinned": True})
    scoped = await api.patch(url, params={"updateMask": "scope"}, json={"scope": {"collections": [item_name(chat.handbook)]}})
    forbidden = await api.patch(url, params={"updateMask": "scope.collections"}, json={"scope": {"collections": [item_name(secret)]}})
    bad_path = await api.patch(url, params={"updateMask": "owner"}, json={})
    cleared = await api.patch(url, params={"updateMask": "scope.collections"}, json={})

    assert renamed.status_code == 200
    assert renamed.json()["displayName"] == "New" and renamed.json()["pinned"] is False
    assert scoped.json()["scope"]["collections"] == [item_name(chat.handbook)]
    assert forbidden.status_code == 403
    assert bad_path.status_code == 400
    assert cleared.json()["scope"] == {"collections": [], "spaces": []}


async def test_delete_and_undelete(chat: Chat) -> None:
    api = await chat.api()
    code = (await chat.conversation())["name"].rsplit("/", 1)[-1]
    url = conversation_url(chat.workspace, code)

    not_deleted = await api.post(f"{url}:undelete", json={})
    deleted = await api.delete(url)
    listed = await api.get(conversations_url(chat.workspace))
    with_deleted = await api.get(conversations_url(chat.workspace), params={"showDeleted": "true"})
    fetched = await api.get(url)
    update = await api.patch(url, json={"pinned": True})
    twice = await api.delete(url)
    restored = await api.post(f"{url}:undelete", json={})

    assert not_deleted.status_code == 409
    assert deleted.status_code == 200
    assert "deleteTime" in deleted.json() and "purgeTime" in deleted.json()
    assert listed.json()["conversations"] == []
    assert [c["name"] for c in with_deleted.json()["conversations"]] == [deleted.json()["name"]]
    assert fetched.status_code == 200 and "deleteTime" in fetched.json()
    assert update.status_code == 400 and update.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert error_reason(update) == "CONVERSATION_DELETED"
    assert twice.status_code == 404
    assert restored.status_code == 200 and "deleteTime" not in restored.json()


async def test_list_filter_order_and_paging(chat: Chat) -> None:
    api = await chat.api()
    for code, pinned in (("alpha", True), ("beta", False), ("gamma", True)):
        response = await api.post(
            conversations_url(chat.workspace),
            params={"conversationId": code},
            json={"displayName": code.title(), "pinned": pinned},
        )
        assert response.status_code == 200
    url = conversations_url(chat.workspace)

    pinned = await api.get(url, params={"filter": "pinned = true", "orderBy": "createTime"})
    newest = await api.get(url)
    first = await api.get(url, params={"pageSize": 2, "orderBy": "createTime"})
    second = await api.get(
        url, params={"pageSize": 2, "orderBy": "createTime", "pageToken": first.json()["nextPageToken"]}
    )
    by_name = await api.get(url, params={"filter": 'displayName = "Beta"'})
    bad_order = await api.get(url, params={"orderBy": "displayName"})

    def codes(response) -> list[str]:
        return [c["name"].rsplit("/", 1)[-1] for c in response.json()["conversations"]]

    assert codes(pinned) == ["alpha", "gamma"]
    assert codes(newest) == ["gamma", "beta", "alpha"]
    assert codes(first) == ["alpha", "beta"] and first.json()["totalSize"] == 3
    assert codes(second) == ["gamma"] and "nextPageToken" not in second.json()
    assert codes(by_name) == ["beta"]
    assert bad_order.status_code == 400


async def test_members_without_permission_are_denied(chat: Chat) -> None:
    viewer_only = await chat.world.make_role(chat.workspace, "noChat", ["workspaces.get"])
    restricted = await chat.world.add_member(chat.workspace, role=viewer_only)

    response = await (await chat.api(restricted)).post(conversations_url(chat.workspace), json={})

    assert response.status_code == 403


async def test_undelete_after_purge_time_is_not_found(chat: Chat) -> None:
    api = await chat.api()
    code = (await chat.conversation())["name"].rsplit("/", 1)[-1]
    url = conversation_url(chat.workspace, code)
    deleted = (await api.delete(url)).json()
    async with transaction_scope(chat.sessions) as session:
        await session.execute(
            update(Conversation)
            .where(Conversation.code == code)
            .values(deleted_at=func.now() - timedelta(days=31))
        )

    restored = await api.post(f"{url}:undelete", json={})

    assert deleted["purgeTime"] > deleted["deleteTime"]
    assert restored.status_code == 404
