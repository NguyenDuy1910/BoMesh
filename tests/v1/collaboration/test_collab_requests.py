"""Request types, requests (create, list, transitions) and request messages."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from bomesh.db.models import Item, Request
from collab_support import (
    item_name,
    member_name,
    notifications_of,
    path_of,
    reason,
    set_settings,
    space_name,
    space_path,
    ws_path,
)
from harness import ApiClient, World

pytestmark = pytest.mark.asyncio

LEAVE = {
    "displayName": "Leave",
    "fields": [
        {"key": "days", "type": "NUMBER", "required": True},
        {"key": "kind", "type": "SELECT", "options": ["paid", "unpaid"]},
    ],
    "rules": [
        {"condition": "fields.days > 20", "severity": "BLOCK", "message": "Too long"},
        {"condition": "fields.days > 10", "severity": "WARN", "message": "Long"},
    ],
    "slaDuration": "86400s",
}


async def _setup(world: World):
    lead = await world.make_user()
    workspace = await world.make_workspace(lead)
    staff = await world.add_member(workspace)
    requester = await world.add_member(workspace)
    other = await world.add_member(workspace)
    space = await world.make_space(workspace, lead, code="hr")
    await world.grant(staff, "roles/spaceStaff", on=space)
    return workspace, space, lead, staff, requester, other


async def test_request_types(client: ApiClient, world: World) -> None:
    workspace, _, lead_user, staff_user, *_ = await _setup(world)
    lead = await client.as_(lead_user)
    path = f"{space_path(workspace, 'hr')}/requestTypes"

    created = await lead.post(path, params={"requestTypeId": "leave"}, json=LEAVE)
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["state"] == "ACTIVE" and body["slaDuration"] == "86400s"
    assert body["fields"][1]["options"] == ["paid", "unpaid"]
    assert (
        await lead.post(path, params={"requestTypeId": "leave"}, json=LEAVE)
    ).status_code == 409
    bad_cel = await lead.post(
        path,
        json={
            "displayName": "X",
            "rules": [{"condition": "fields.a >", "severity": "WARN"}],
        },
    )
    assert bad_cel.status_code == 400
    no_options = await lead.post(
        path, json={"displayName": "X", "fields": [{"key": "k", "type": "SELECT"}]}
    )
    assert no_options.status_code == 400

    staff = await client.as_(staff_user)
    assert (await staff.post(path, json={"displayName": "Mine"})).status_code == 403
    assert (await staff.get(f"{path}/leave")).json()["displayName"] == "Leave"

    renamed = await lead.patch(
        f"{path}/leave", json={"displayName": "Time off", "etag": body["etag"]}
    )
    assert renamed.json()["displayName"] == "Time off"
    deleted = await lead.delete(f"{path}/leave")
    assert deleted.json()["state"] == "DELETED" and deleted.json()["purgeTime"]
    assert (await lead.get(path)).json()["requestTypes"] == []
    shown = await lead.get(
        path, params={"showDeleted": "true", "filter": "state = DELETED"}
    )
    assert len(shown.json()["requestTypes"]) == 1
    restored = await lead.post(f"{path}/leave:undelete", json={})
    assert restored.json()["state"] == "ACTIVE"
    assert (await lead.post(f"{path}/leave:undelete", json={})).status_code == 409


async def test_service_request_eligibility(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, lead_user, _, requester_user, _ = await _setup(world)
    lead = await client.as_(lead_user)
    types = f"{space_path(workspace, 'hr')}/requestTypes"
    await lead.post(types, params={"requestTypeId": "leave"}, json=LEAVE)
    type_name = f"{space_name(workspace, space)}/requestTypes/leave"
    api = await client.as_(requester_user)
    requests = f"{ws_path(workspace)}/requests"

    def service(days: int) -> dict:
        return {"kind": "SERVICE", "requestType": type_name, "fields": {"days": days}}

    warn = await api.post(requests, params={"validateOnly": "true"}, json=service(12))
    assert warn.status_code == 200, warn.text
    assert warn.json()["eligibility"]["outcome"] == "WARN"
    assert [r["message"] for r in warn.json()["eligibility"]["results"]] == ["Long"]
    blocked_preview = await api.post(
        requests, params={"validateOnly": "true"}, json=service(30)
    )
    assert blocked_preview.json()["eligibility"]["outcome"] == "BLOCK"
    assert (await api.get(requests)).json()["requests"] == []

    blocked = await api.post(requests, json=service(30))
    assert reason(blocked) == "REQUEST_NOT_ELIGIBLE"
    missing = await api.post(
        requests, json={"kind": "SERVICE", "requestType": type_name}
    )
    assert missing.status_code == 400
    wrong_option = await api.post(
        requests, json={**service(1), "fields": {"days": 1, "kind": "sabbatical"}}
    )
    assert wrong_option.status_code == 400

    created = await api.post(
        requests,
        params={"requestId": "7d3c4c2e-1a8f-4b4e-9d1c-5a6b7c8d9e0f"},
        json=service(2),
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["state"] == "OPEN" and body["eligibility"]["outcome"] == "PASS"
    assert body["space"] == space_name(workspace, space)
    assert body["requester"] == member_name(workspace, requester_user)
    due = datetime.fromisoformat(body["dueTime"].replace("Z", "+00:00"))
    created_at = datetime.fromisoformat(body["createTime"].replace("Z", "+00:00"))
    assert due - created_at == timedelta(days=1)
    assert body["overdue"] is False
    replayed = await api.post(
        requests,
        params={"requestId": "7d3c4c2e-1a8f-4b4e-9d1c-5a6b7c8d9e0f"},
        json=service(2),
    )
    assert replayed.json()["name"] == body["name"]

    # The space lead was notified; the requester was not.
    assert [n.kind for n in await notifications_of(sessions, lead_user)] == [
        "request_updated"
    ]
    assert await notifications_of(sessions, requester_user) == []

    # Overdue once dueTime has passed while OPEN.
    async with sessions.begin() as session:
        await session.execute(
            update(Request).values(due_at=datetime.now(UTC) - timedelta(hours=1))
        )
    overdue = await api.get(requests, params={"filter": "overdue = true"})
    assert [r["overdue"] for r in overdue.json()["requests"]] == [True]

    await lead.delete(f"{types}/leave")
    gone = await api.post(requests, json=service(1))
    assert gone.status_code == 400


async def test_visibility_and_listing(client: ApiClient, world: World) -> None:
    workspace, space, _, staff_user, requester_user, other_user = await _setup(world)
    other_space = await world.make_space(workspace, other_user, code="it")
    api = await client.as_(requester_user)
    requests = f"{ws_path(workspace)}/requests"
    question = (
        await api.post(
            requests,
            json={
                "kind": "QUESTION",
                "space": space_name(workspace, space),
                "question": "Why?",
            },
        )
    ).json()
    it_question = (
        await api.post(
            requests,
            json={
                "kind": "QUESTION",
                "space": space_name(workspace, other_space),
                "question": "How?",
            },
        )
    ).json()
    no_question = await api.post(
        requests, json={"kind": "QUESTION", "space": space_name(workspace, space)}
    )
    assert no_question.status_code == 400
    extra = await api.post(
        requests,
        json={
            "kind": "QUESTION",
            "space": space_name(workspace, space),
            "question": "x",
            "target": "connectors/jira",
        },
    )
    assert extra.status_code == 400

    staff = await client.as_(staff_user)
    listed = await staff.get(requests)
    assert [r["name"] for r in listed.json()["requests"]] == [question["name"]]
    assert (await staff.get(path_of(it_question["name"]))).status_code == 404
    forbidden = await staff.get(
        requests, params={"filter": f'space = "{space_name(workspace, "ghost")}"'}
    )
    assert forbidden.status_code == 403

    mine = await api.get(requests, params={"orderBy": "createTime"})
    assert [r["name"] for r in mine.json()["requests"]] == [
        question["name"],
        it_question["name"],
    ]
    by_space = await api.get(
        requests, params={"filter": f'space = "{space_name(workspace, other_space)}"'}
    )
    assert [r["name"] for r in by_space.json()["requests"]] == [it_question["name"]]
    by_kind = await api.get(requests, params={"filter": "kind = SERVICE"})
    assert by_kind.json()["requests"] == []

    outsider = await client.as_(await world.make_user())
    assert (await outsider.get(path_of(question["name"]))).status_code == 403
    stranger = await client.as_(other_user)
    assert (await stranger.get(path_of(question["name"]))).status_code == 404


async def test_transitions_and_messages(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, _, staff_user, requester_user, _ = await _setup(world)
    api = await client.as_(requester_user)
    staff = await client.as_(staff_user)
    created = (
        await api.post(
            f"{ws_path(workspace)}/requests",
            json={
                "kind": "QUESTION",
                "space": space_name(workspace, space),
                "question": "Why?",
                "title": "Q",
            },
        )
    ).json()
    path = path_of(created["name"])

    assert (
        await api.post(f"{path}:sendBack", json={"message": "x"})
    ).status_code == 403
    sent = await staff.post(
        f"{path}:sendBack", json={"message": "Details?", "etag": created["etag"]}
    )
    assert sent.json()["state"] == "NEEDS_INFO", sent.text
    assert (
        await staff.post(f"{path}:sendBack", json={"message": "Again"})
    ).status_code == 400
    stale = await staff.post(f"{path}:deny", json={"etag": created["etag"]})
    assert stale.status_code == 409

    note = await staff.post(
        f"{path}/messages", json={"text": "internal", "internal": True}
    )
    assert note.status_code == 200
    assert (
        await api.post(f"{path}/messages", json={"text": "x", "internal": True})
    ).status_code == 403
    reply = await api.post(f"{path}/messages", json={"text": "Here you go"})
    assert reply.status_code == 200
    assert (await api.get(path)).json()["state"] == "OPEN"

    seen_by_requester = await api.get(f"{path}/messages")
    assert [m["text"] for m in seen_by_requester.json()["messages"]] == [
        "Details?",
        "Here you go",
    ]
    assert (await api.get(path_of(note.json()["name"]))).status_code == 404
    seen_by_staff = await staff.get(f"{path}/messages")
    assert len(seen_by_staff.json()["messages"]) == 3

    title = await api.patch(path, json={"title": "Better title"})
    assert title.json()["title"] == "Better title"
    assign = await api.patch(
        path, json={"assignee": member_name(workspace, staff_user)}
    )
    assert assign.status_code == 403
    assigned = await staff.patch(
        path, json={"assignee": member_name(workspace, staff_user)}
    )
    assert assigned.json()["assignee"] == member_name(workspace, staff_user)
    other_field = await staff.patch(
        path, params={"updateMask": "state"}, json={"kind": "QUESTION"}
    )
    assert other_field.status_code == 400

    answered = await staff.post(f"{path}:answer", json={"answer": "Because."})
    assert answered.json()["state"] == "ANSWERED" and answered.json()["closeTime"]
    assert (await staff.post(f"{path}:deny", json={})).status_code == 400
    assert (await api.patch(path, json={"title": "late"})).status_code == 400
    closed = await staff.post(f"{path}:close", json={})
    assert closed.json()["state"] == "CLOSED"
    assert closed.json()["closeTime"] == answered.json()["closeTime"]
    assert (await staff.post(f"{path}:close", json={})).status_code == 400
    assert (
        await api.post(f"{path}/messages", json={"text": "more"})
    ).status_code == 400

    kinds = [n.kind for n in await notifications_of(sessions, requester_user)]
    assert "request_updated" in kinds


async def test_withdraw(client: ApiClient, world: World) -> None:
    workspace, space, _, staff_user, requester_user, _ = await _setup(world)
    api = await client.as_(requester_user)
    created = (
        await api.post(
            f"{ws_path(workspace)}/requests",
            json={
                "kind": "QUESTION",
                "space": space_name(workspace, space),
                "question": "?",
            },
        )
    ).json()
    path = path_of(created["name"])
    staff = await client.as_(staff_user)
    assert (await staff.post(f"{path}:withdraw", json={})).status_code == 403
    withdrawn = await api.post(f"{path}:withdraw", json={})
    assert withdrawn.json()["state"] == "WITHDRAWN"
    assert (await api.post(f"{path}:withdraw", json={})).status_code == 400
    assert (await staff.post(f"{path}:close", json={})).status_code == 400


async def test_space_membership_request(client: ApiClient, world: World) -> None:
    workspace, _, lead_user, _, requester_user, _ = await _setup(world)
    await world.make_space(workspace, lead_user, code="club", join_policy="request")
    api = await client.as_(requester_user)
    requests = f"{ws_path(workspace)}/requests"
    body = {"kind": "SPACE_MEMBERSHIP", "space": space_name(workspace, "club")}
    created = await api.post(requests, json=body)
    assert created.json()["requestedRole"] == "roles/spaceMember"
    assert (await api.post(requests, json=body)).status_code == 409
    wrong = await api.post(requests, json={**body, "requestedRole": "roles/spaceLead"})
    assert wrong.status_code == 400

    lead = await client.as_(lead_user)
    path = path_of(created.json()["name"])
    assert (await api.post(f"{path}:approve", json={})).status_code == 403
    approved = await lead.post(f"{path}:approve", json={"message": "Welcome"})
    assert approved.json()["state"] == "APPROVED", approved.text
    member = await api.get(
        f"{space_path(workspace, 'club')}/members/{requester_user.id}"
    )
    assert member.json()["roles"] == ["roles/spaceMember"]
    assert (await api.post(requests, json=body)).status_code == 409  # already a member


async def test_collection_access_request(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    curator = await world.add_member(workspace)
    requester_user = await world.add_member(workspace)
    shared = await world.make_collection(
        workspace,
        grants={
            curator: "roles/collectionOwner",
            "workspaceMembers": "roles/collectionViewer",
        },
    )
    secret = await world.make_collection(workspace)
    document = await world.make_document(shared)
    api = await client.as_(requester_user)
    requests = f"{ws_path(workspace)}/requests"

    hidden = await api.post(
        requests,
        json={"kind": "COLLECTION_ACCESS", "collection": item_name(workspace, secret)},
    )
    assert hidden.status_code == 403
    not_collection = await api.post(
        requests,
        json={
            "kind": "COLLECTION_ACCESS",
            "collection": item_name(workspace, document),
        },
    )
    assert not_collection.status_code == 400
    created = await api.post(
        requests,
        json={
            "kind": "COLLECTION_ACCESS",
            "collection": item_name(workspace, shared),
            "requestedRole": "roles/collectionEditor",
        },
    )
    assert created.status_code == 200, created.text
    assert [n.kind for n in await notifications_of(sessions, curator)] == [
        "access_request"
    ]

    decider = await client.as_(curator)
    listed = await decider.get(requests)
    assert [r["name"] for r in listed.json()["requests"]] == [created.json()["name"]]
    path = path_of(created.json()["name"])
    too_high = await decider.post(
        f"{path}:approve", json={"role": "roles/collectionOwner"}
    )
    assert too_high.status_code == 400
    approved = await decider.post(
        f"{path}:approve", json={"role": "roles/collectionViewer"}
    )
    assert approved.json()["state"] == "APPROVED", approved.text
    policy = await decider.post(
        f"{path_of(item_name(workspace, shared))}:getIamPolicy", json={}
    )
    viewers = {b["role"]: b["members"] for b in policy.json()["bindings"]}
    assert f"user:{requester_user.id}" in viewers["roles/collectionViewer"]


async def test_answer_publishes_document(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, lead_user, staff_user, requester_user, _ = await _setup(world)
    faq = await world.make_collection(
        workspace, grants={staff_user: "roles/collectionEditor"}
    )
    locked = await world.make_collection(workspace)
    api = await client.as_(requester_user)
    question = (
        await api.post(
            f"{ws_path(workspace)}/requests",
            json={
                "kind": "QUESTION",
                "space": space_name(workspace, space),
                "question": "Holidays?",
            },
        )
    ).json()
    path = path_of(question["name"])
    staff = await client.as_(staff_user)

    denied = await staff.post(
        f"{path}:answer",
        json={"answer": "x", "publishToCollection": item_name(workspace, locked)},
    )
    assert denied.status_code == 403
    answered = await staff.post(
        f"{path}:answer",
        json={"answer": "Ten days.", "publishToCollection": item_name(workspace, faq)},
    )
    assert answered.status_code == 200, answered.text
    faq_item = answered.json()["faqItem"]
    async with sessions.begin() as session:
        item = await session.scalar(
            select(Item).where(Item.id == faq_item.rsplit("/", 1)[1])
        )
    assert item is not None and item.parent_item_id == faq.id

    membership = (
        await api.post(
            f"{ws_path(workspace)}/requests",
            json={"kind": "SPACE_MEMBERSHIP", "space": space_name(workspace, space)},
        )
    ).json()
    mismatch = await staff.post(
        f"{path_of(membership['name'])}:answer", json={"answer": "x"}
    )
    assert reason(mismatch) == "REQUEST_KIND_MISMATCH"


async def test_requests_module_disabled(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, _, _, requester_user, _ = await _setup(world)
    await set_settings(sessions, workspace, modules={"requests": False})
    api = await client.as_(requester_user)
    response = await api.post(
        f"{ws_path(workspace)}/requests",
        json={
            "kind": "QUESTION",
            "space": space_name(workspace, space),
            "question": "?",
        },
    )
    assert reason(response) == "MODULE_DISABLED"
    assert reason(await api.get(f"{ws_path(workspace)}/requests")) == "MODULE_DISABLED"
