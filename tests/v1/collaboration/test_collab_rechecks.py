"""Review fixes: per-reader re-checks, retention, replays and reference rules."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select, update

from bomesh.services.collaboration.requests import request_readable
from bomesh.services.kernel.retention import RETENTION
from bomesh.db.models import Item, Request, RequestType, Space
from bomesh.iam.authorizer import Principal
from collab_support import (
    item_name,
    member_name,
    path_of,
    reason,
    space_name,
    space_path,
    ws_path,
)
from harness import ApiClient, World

pytestmark = pytest.mark.asyncio


async def _space_with_member(world: World):
    lead = await world.make_user()
    workspace = await world.make_workspace(lead)
    member = await world.add_member(workspace)
    space = await world.make_space(workspace, lead, code="team")
    await world.grant(member, "roles/spaceMember", on=space)
    return workspace, space, lead, member


async def _question(api: ApiClient, workspace, space) -> dict:
    response = await api.post(
        f"{ws_path(workspace)}/requests",
        json={
            "kind": "QUESTION",
            "space": space_name(workspace, space),
            "question": "Why?",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


# -- #3: access requests for LOCKED discoverable roots --------------------------


async def test_collection_access_to_discoverable_locked_root(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    requester = await world.add_member(workspace)
    discoverable = await world.make_collection(workspace)
    hidden = await world.make_collection(workspace)
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == discoverable.id)
            .values(metadata_=func.jsonb_build_object("discoverable", True))
        )
    api = await client.as_(requester)
    requests = f"{ws_path(workspace)}/requests"

    allowed = await api.post(
        requests,
        json={
            "kind": "COLLECTION_ACCESS",
            "collection": item_name(workspace, discoverable),
        },
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["requestedRole"] == "roles/collectionViewer"
    denied = await api.post(
        requests,
        json={"kind": "COLLECTION_ACCESS", "collection": item_name(workspace, hidden)},
    )
    assert denied.status_code == 403


# -- #11: assistantContext follows the share rule ------------------------------


async def test_assistant_answer_withheld_when_a_citation_is_unreadable(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, lead, member = await _space_with_member(world)
    staff = await world.add_member(workspace)
    await world.grant(staff, "roles/spaceStaff", on=space)
    shared = await world.make_collection(
        workspace,
        grants={member: "roles/collectionViewer", staff: "roles/collectionViewer"},
    )
    private = await world.make_collection(
        workspace, grants={member: "roles/collectionViewer"}
    )
    open_doc = await world.make_document(shared, title="Open")
    secret_doc = await world.make_document(private, title="Secret")
    created = await _question(await client.as_(member), workspace, space)
    citation = {"chunk_id": "c1", "page": 1, "title": "t", "excerpt": "text"}
    async with sessions.begin() as session:
        await session.execute(
            update(Request).values(
                assistant_context={
                    "answer": "Built from both documents.",
                    "citations": [
                        {**citation, "item_id": str(open_doc.id)},
                        {**citation, "item_id": str(secret_doc.id)},
                    ],
                }
            )
        )

    requester_view = (
        await (await client.as_(member)).get(path_of(created["name"]))
    ).json()
    assert requester_view["assistantContext"]["answer"] == "Built from both documents."
    staff_view = (await (await client.as_(staff)).get(path_of(created["name"]))).json()
    context = staff_view["assistantContext"]
    assert context.get("answer", "") == ""
    assert [c["available"] for c in context["citations"]] == [True, False]


# -- #13 / #14 / #15 / #30: materials --------------------------------------------


async def test_material_rechecked_after_revoke(client: ApiClient, world: World) -> None:
    workspace, space, lead_user, member = await _space_with_member(world)
    staff = await world.add_member(workspace)
    await world.grant(staff, "roles/spaceStaff", on=space)
    collection = await world.make_collection(
        workspace, grants={staff: "roles/collectionViewer"}
    )
    document = await world.make_document(collection)
    api = await client.as_(staff)
    path = f"{space_path(workspace, 'team')}/materials"
    created = await api.post(path, json={"item": item_name(workspace, document)})
    assert created.status_code == 200, created.text
    material = path_of(created.json()["name"])
    assert [m["name"] for m in (await api.get(path)).json()["materials"]] == [
        created.json()["name"]
    ]

    await world.revoke(staff, on=collection)
    assert (await api.get(path)).json()["materials"] == []
    assert (await api.get(material)).status_code == 404
    # Delete re-checks visibility too: the material reads as absent.
    assert (await api.delete(material)).status_code == 404
    lead = await client.as_(lead_user)
    assert (await lead.get(material)).status_code == 200


async def test_create_material_replays_before_duplicate_check(
    client: ApiClient, world: World
) -> None:
    workspace, _, lead_user, _ = await _space_with_member(world)
    document = await world.make_document(await world.make_collection(workspace))
    api = await client.as_(lead_user)
    path = f"{space_path(workspace, 'team')}/materials"
    request_id = str(uuid4())
    body = {"item": item_name(workspace, document)}
    first = await api.post(path, params={"requestId": request_id}, json=body)
    again = await api.post(path, params={"requestId": request_id}, json=body)
    assert first.status_code == again.status_code == 200
    assert again.json()["name"] == first.json()["name"]
    assert (await api.post(path, json=body)).status_code == 409


async def test_space_collections_are_filtered_per_reader(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, lead_user, member = await _space_with_member(world)
    visible = await world.make_collection(
        workspace, grants={member: "roles/collectionViewer"}
    )
    hidden = await world.make_collection(workspace)
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id.in_([visible.id, hidden.id]))
            .values(space_id=space.id)
        )
    member_view = (
        await (await client.as_(member)).get(space_path(workspace, "team"))
    ).json()
    assert member_view["collections"] == [item_name(workspace, visible)]
    lead_view = (
        await (await client.as_(lead_user)).get(space_path(workspace, "team"))
    ).json()
    assert lead_view["collections"] == [
        item_name(workspace, visible),
        item_name(workspace, hidden),
    ]


# -- #20: AnswerRequest never publishes when the transition fails ---------------


async def test_answer_with_stale_etag_publishes_nothing(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, lead_user, member = await _space_with_member(world)
    faq = await world.make_collection(workspace)
    created = await _question(await client.as_(member), workspace, space)
    lead = await client.as_(lead_user)
    path = path_of(created["name"])
    await lead.patch(path, json={"title": "Renamed"})

    stale = await lead.post(
        f"{path}:answer",
        json={
            "answer": "x",
            "publishToCollection": item_name(workspace, faq),
            "etag": created["etag"],
        },
    )
    assert stale.status_code == 409
    async with sessions.begin() as session:
        published = await session.scalar(
            select(func.count()).select_from(Item).where(Item.parent_item_id == faq.id)
        )
    assert published == 0
    answered = await lead.post(
        f"{path}:answer",
        json={"answer": "x", "publishToCollection": item_name(workspace, faq)},
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["faqItem"]


# -- #21: undelete respects purgeTime -------------------------------------------


async def test_purged_space_and_request_type_are_gone(
    client: ApiClient, world: World, sessions
) -> None:
    workspace, space, lead_user, _ = await _space_with_member(world)
    api = await client.as_(lead_user)
    types = f"{space_path(workspace, 'team')}/requestTypes"
    await api.post(
        types, params={"requestTypeId": "leave"}, json={"displayName": "Leave"}
    )
    await api.delete(f"{types}/leave")
    past = datetime.now(UTC) - RETENTION - timedelta(minutes=1)
    async with sessions.begin() as session:
        await session.execute(update(RequestType).values(deleted_at=past))
    assert (await api.post(f"{types}/leave:undelete", json={})).status_code == 404
    assert (await api.get(f"{types}/leave")).status_code == 404
    listed = await api.get(types, params={"showDeleted": "true"})
    assert listed.json()["requestTypes"] == []

    await api.delete(space_path(workspace, "team"))
    async with sessions.begin() as session:
        await session.execute(
            update(Space).where(Space.id == space.id).values(deleted_at=past)
        )
    assert (
        await api.post(f"{space_path(workspace, 'team')}:undelete", json={})
    ).status_code == 404
    assert (await api.get(space_path(workspace, "team"))).status_code == 404
    shown = await api.get(
        f"{ws_path(workspace)}/spaces", params={"showDeleted": "true"}
    )
    assert shown.json()["spaces"] == []


# -- #26: request filters name this workspace ----------------------------------


async def test_request_filters_reject_other_workspaces(
    client: ApiClient, world: World
) -> None:
    workspace, space, _, member = await _space_with_member(world)
    other = await world.make_workspace(await world.make_user())
    api = await client.as_(member)
    requests = f"{ws_path(workspace)}/requests"
    await _question(api, workspace, space)
    foreign_space = await api.get(
        requests, params={"filter": f'space = "workspaces/{other.id}/spaces/team"'}
    )
    assert foreign_space.status_code == 400
    foreign_member = await api.get(
        requests,
        params={"filter": f'requester = "workspaces/{other.id}/members/{member.id}"'},
    )
    assert foreign_member.status_code == 400
    mine = await api.get(
        requests, params={"filter": f'requester = "{member_name(workspace, member)}"'}
    )
    assert len(mine.json()["requests"]) == 1


# -- #28: policyCitation ---------------------------------------------------------


async def test_policy_citation_checked_on_write_and_filtered_on_read(
    client: ApiClient, world: World
) -> None:
    workspace, space, lead_user, member = await _space_with_member(world)
    policy = await world.make_collection(workspace)
    document = await world.make_document(policy, title="Policy")
    secret = await world.make_document(
        await world.make_collection(
            workspace, grants={member: "roles/collectionViewer"}
        )
    )
    lead = await client.as_(lead_user)
    types = f"{space_path(workspace, 'team')}/requestTypes"

    def rule(item) -> dict:
        return {
            "displayName": "Leave",
            "fields": [{"key": "days", "type": "NUMBER"}],
            "rules": [
                {
                    "condition": "fields.days > 1",
                    "severity": "WARN",
                    "policyCitation": item,
                }
            ],
        }

    collection_cited = await lead.post(types, json=rule(item_name(workspace, policy)))
    assert collection_cited.status_code == 400
    lead_outsider = await world.add_member(workspace)
    await world.grant(lead_outsider, "roles/spaceLead", on=space)
    unreadable = await (await client.as_(lead_outsider)).post(
        types, json=rule(item_name(workspace, secret))
    )
    assert unreadable.status_code == 403
    created = await lead.post(
        types,
        params={"requestTypeId": "leave"},
        json=rule(item_name(workspace, document)),
    )
    assert created.status_code == 200, created.text
    assert created.json()["rules"][0]["policyCitation"] == item_name(
        workspace, document
    )

    reader = await client.as_(member)
    seen = (await reader.get(f"{types}/leave")).json()
    assert "policyCitation" not in seen["rules"][0]
    preview = await reader.post(
        f"{ws_path(workspace)}/requests",
        params={"validateOnly": "true"},
        json={
            "kind": "SERVICE",
            "requestType": f"{space_name(workspace, space)}/requestTypes/leave",
            "fields": {"days": 3},
        },
    )
    result = preview.json()["eligibility"]["results"][0]
    assert "policyCitation" not in result


# -- request_readable (Library notifications) ---------------------------------


async def test_request_readable(client: ApiClient, world: World, sessions) -> None:
    workspace, space, lead_user, member = await _space_with_member(world)
    stranger = await world.add_member(workspace)
    created = await _question(await client.as_(member), workspace, space)
    request_id = created["uid"]
    async with sessions.begin() as session:
        authorizer = world.authorizer()
        for user, expected in ((member, True), (lead_user, True), (stranger, False)):
            assert (
                await request_readable(
                    session, authorizer, Principal(user.id), workspace.id, request_id
                )
                is expected
            )
        assert not await request_readable(
            session, authorizer, Principal(member.id), workspace.id, uuid4()
        )


# -- requestId replays (#30) -----------------------------------------------------


@pytest.mark.parametrize(
    ("collection", "body"),
    [
        ("announcements", {"title": "Hello"}),
        ("events", {"title": "Meet", "startTime": "2026-12-01T10:00:00Z"}),
        ("requestTypes", {"displayName": "Leave"}),
    ],
)
async def test_space_child_create_replays(
    client: ApiClient, world: World, collection: str, body: dict
) -> None:
    workspace, _, lead_user, _ = await _space_with_member(world)
    api = await client.as_(lead_user)
    path = f"{space_path(workspace, 'team')}/{collection}"
    request_id = str(uuid4())
    first = await api.post(path, params={"requestId": request_id}, json=body)
    again = await api.post(path, params={"requestId": request_id}, json=body)
    assert first.status_code == again.status_code == 200, first.text
    assert again.json()["name"] == first.json()["name"]
    listed = (await api.get(path)).json()
    assert len(next(iter(v for v in listed.values() if isinstance(v, list)))) == 1
    changed = {**body, next(iter(body)): "Other"}
    reused = await api.post(path, params={"requestId": request_id}, json=changed)
    assert reason(reused) == "REQUEST_ID_REUSED"


async def test_create_space_and_member_replay(client: ApiClient, world: World) -> None:
    workspace, _, lead_user, _ = await _space_with_member(world)
    newcomer = await world.add_member(workspace)
    api = await client.as_(lead_user)
    request_id = str(uuid4())
    first = await api.post(
        f"{ws_path(workspace)}/spaces",
        params={"requestId": request_id},
        json={"displayName": "Ops"},
    )
    again = await api.post(
        f"{ws_path(workspace)}/spaces",
        params={"requestId": request_id},
        json={"displayName": "Ops"},
    )
    assert again.json()["name"] == first.json()["name"]
    listed = (await api.get(f"{ws_path(workspace)}/spaces")).json()["spaces"]
    assert len(listed) == 2

    members = f"{space_path(workspace, 'team')}/members"
    member_request = str(uuid4())
    body = {"member": member_name(workspace, newcomer)}
    first_member = await api.post(
        members, params={"requestId": member_request}, json=body
    )
    again_member = await api.post(
        members, params={"requestId": member_request}, json=body
    )
    assert first_member.status_code == again_member.status_code == 200
    assert again_member.json()["name"] == first_member.json()["name"]


async def test_create_request_message_replays(client: ApiClient, world: World) -> None:
    workspace, space, _, member = await _space_with_member(world)
    api = await client.as_(member)
    created = await _question(api, workspace, space)
    path = f"{path_of(created['name'])}/messages"
    request_id = str(uuid4())
    first = await api.post(path, params={"requestId": request_id}, json={"text": "Hi"})
    again = await api.post(path, params={"requestId": request_id}, json={"text": "Hi"})
    assert again.json()["name"] == first.json()["name"]
    assert len((await api.get(path)).json()["messages"]) == 1
