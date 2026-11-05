"""Shares: one live share, audience check, per-reader re-filtering, revoke."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from conftest import Chat
from conversations_support import (
    answer,
    conversation_url,
    error_reason,
    item_name,
    script_model,
    search,
)
from harness import WORKSPACE_MEMBERS

pytestmark = pytest.mark.asyncio


def _member(chat: Chat, user: Any) -> str:
    return f"workspaces/{chat.workspace.id}/members/{user.id}"


async def _answered(chat: Chat) -> str:
    """A conversation whose answer cites ``chat.policy``."""
    await chat.index(chat.policy, "Parking is free on weekends.")
    script_model(chat.runtime, chat.fakes, search("parking"), answer("Free on weekends [[cite:ref_1]]."))
    code = (await chat.conversation(displayName="Parking"))["name"].rsplit("/", 1)[-1]
    response = await (await chat.api()).post(
        conversation_url(chat.workspace, code, ":converse"), json={"message": "Is parking free?"}
    )
    assert response.status_code == 200, response.text
    return code


async def _share(chat: Chat, code: str, user: Any = None, **body: Any):
    return await (await chat.api(user)).post(conversation_url(chat.workspace, code, "/shares"), json=body)


async def test_workspace_share_snapshot_and_single_live_share(chat: Chat) -> None:
    await chat.world.grant(WORKSPACE_MEMBERS, "roles/collectionViewer", on=chat.handbook)
    colleague = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)

    first = await _share(chat, code, audience="WORKSPACE")
    second = await _share(chat, code, audience="WORKSPACE")

    assert first.status_code == 200, first.text
    share = second.json()
    assert share["name"].startswith(f"workspaces/{chat.workspace.id}/conversations/{code}/shares/")
    assert share["uri"] == f"/{share['name']}"
    snapshot = share["snapshot"]
    assert snapshot["displayName"] == "Parking" and "snapshotTime" in snapshot
    assert [(m["role"], m["text"], m["available"]) for m in snapshot["messages"]] == [
        ("USER", "Is parking free?", True),
        ("ASSISTANT", "Free on weekends [1].", True),
    ]
    assert snapshot["messages"][1]["citations"][0]["item"] == item_name(chat.policy)
    listed = await (await chat.api()).get(conversation_url(chat.workspace, code, "/shares"))
    assert [s["name"] for s in listed.json()["shares"]] == [share["name"]]
    assert listed.json()["totalSize"] == 1
    assert (await (await chat.api()).get(f"/api/v1/{first.json()['name']}")).status_code == 404
    as_colleague = await (await chat.api(colleague)).get(f"/api/v1/{share['name']}")
    assert as_colleague.status_code == 200
    assert as_colleague.json()["snapshot"]["messages"][1]["available"] is True


async def test_share_is_refused_when_the_audience_cannot_read_the_sources(chat: Chat) -> None:
    outsider_member = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)

    workspace = await _share(chat, code, audience="WORKSPACE")
    people = await _share(chat, code, audience="PEOPLE", recipients=[_member(chat, outsider_member)])

    for response in (workspace, people):
        assert response.status_code == 400
        assert error_reason(response) == "AUDIENCE_CANNOT_READ_SOURCES"
    listed = await (await chat.api()).get(conversation_url(chat.workspace, code, "/shares"))
    assert listed.json()["shares"] == []


async def test_recipients_validation(chat: Chat) -> None:
    code = await _answered(chat)
    stranger = await chat.world.make_user()

    missing = await _share(chat, code, audience="PEOPLE")
    not_member = await _share(chat, code, audience="PEOPLE", recipients=[_member(chat, stranger)])
    extra = await _share(chat, code, audience="WORKSPACE", recipients=[_member(chat, chat.admin)])

    assert missing.status_code == 400 and missing.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert not_member.status_code == 400 and error_reason(not_member) == "NOT_WORKSPACE_MEMBER"
    assert extra.status_code == 400


async def test_people_share_is_refiltered_for_every_reader(chat: Chat) -> None:
    reader = await chat.world.add_member(chat.workspace)
    bystander = await chat.world.add_member(chat.workspace)
    await chat.world.grant(reader, "roles/collectionViewer", on=chat.handbook)
    code = await _answered(chat)
    share = (await _share(chat, code, audience="PEOPLE", recipients=[_member(chat, reader)])).json()
    url = f"/api/v1/{share['name']}"

    readable = await (await chat.api(reader)).get(url)
    not_recipient = await (await chat.api(bystander)).get(url)
    assert readable.json()["recipients"] == [_member(chat, reader)]
    assert readable.json()["snapshot"]["messages"][1]["available"] is True
    assert not_recipient.status_code == 403

    await chat.world.revoke(reader, on=chat.handbook)
    withheld = await (await chat.api(reader)).get(url)

    assert withheld.status_code == 200
    assert withheld.json()["snapshot"]["messages"] == [
        {"role": "USER", "text": "Is parking free?", "citations": [], "available": True},
        {"role": "ASSISTANT", "available": False},
    ]
    async with transaction_scope(chat.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == chat.policy.id).values(publication_state="unpublished")
        )
    owner_view = await (await chat.api()).get(url)
    assert owner_view.json()["snapshot"]["messages"][1] == {"role": "ASSISTANT", "available": False}


async def test_revoke_and_deleted_conversations(chat: Chat) -> None:
    await chat.world.grant(WORKSPACE_MEMBERS, "roles/collectionViewer", on=chat.handbook)
    other = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)
    share = (await _share(chat, code, audience="WORKSPACE")).json()
    url = f"/api/v1/{share['name']}"
    api = await chat.api()

    foreign_create = await _share(chat, code, other, audience="WORKSPACE")
    foreign_delete = await (await chat.api(other)).delete(url)
    await api.delete(conversation_url(chat.workspace, code))
    while_deleted = await (await chat.api(other)).get(url)
    await api.post(conversation_url(chat.workspace, code, ":undelete"), json={})
    restored = await (await chat.api(other)).get(url)
    revoked = await api.delete(url)
    after = await (await chat.api(other)).get(url)
    again = await api.delete(url)

    assert foreign_create.status_code == 403
    assert foreign_delete.status_code == 403
    assert while_deleted.status_code == 404
    assert restored.status_code == 200
    assert revoked.status_code == 200 and revoked.json() == {}
    assert after.status_code == 404
    assert again.status_code == 404


async def test_create_share_replays_its_request_id(chat: Chat) -> None:
    await chat.world.grant(WORKSPACE_MEMBERS, "roles/collectionViewer", on=chat.handbook)
    code = await _answered(chat)
    url = conversation_url(chat.workspace, code, "/shares")
    api = await chat.api()
    request_id = str(uuid4())

    first = await api.post(url, params={"requestId": request_id}, json={"audience": "WORKSPACE"})
    replay = await api.post(url, params={"requestId": request_id}, json={"audience": "WORKSPACE"})
    reused = await api.post(
        url,
        params={"requestId": request_id},
        json={"audience": "PEOPLE", "recipients": [_member(chat, chat.admin)]},
    )

    assert first.status_code == 200, first.text
    assert replay.json()["name"] == first.json()["name"]
    assert reused.status_code == 400 and error_reason(reused) == "REQUEST_ID_REUSED"
    listed = await api.get(url)
    assert [share["name"] for share in listed.json()["shares"]] == [first.json()["name"]]
