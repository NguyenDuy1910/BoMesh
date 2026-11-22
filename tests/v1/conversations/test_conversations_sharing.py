"""Live conversation sharing: a Share lets its audience read the conversation, re-filtered per reader."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from conftest import Chat
from conversations_support import (
    answer,
    conversation_url,
    item_name,
    revise,
    script_model,
    search,
    share_conversation,
)
from harness import WORKSPACE_MEMBERS

pytestmark = pytest.mark.asyncio


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


async def _messages(chat: Chat, code: str, user: Any) -> Any:
    return await (await chat.api(user)).get(conversation_url(chat.workspace, code, "/messages"))


async def test_unshared_conversations_stay_owner_private(chat: Chat) -> None:
    colleague = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)

    get = await (await chat.api(colleague)).get(conversation_url(chat.workspace, code))
    listed = await _messages(chat, code, colleague)

    assert get.status_code == 403
    assert listed.status_code == 403


async def test_workspace_share_opens_the_live_conversation_read_only(chat: Chat) -> None:
    await chat.world.grant(WORKSPACE_MEMBERS, "roles/collectionViewer", on=chat.handbook)
    colleague = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)
    await share_conversation(await chat.api(), chat.workspace, code, "WORKSPACE")
    reader = await chat.api(colleague)

    conversation = await reader.get(conversation_url(chat.workspace, code))
    messages = await _messages(chat, code, colleague)
    one = await reader.get(f"/api/v1/{messages.json()['messages'][1]['name']}")
    converse = await reader.post(conversation_url(chat.workspace, code, ":converse"), json={"message": "Hi"})
    rename = await reader.patch(
        conversation_url(chat.workspace, code), params={"updateMask": "displayName"}, json={"displayName": "X"}
    )
    feedback = await reader.post(f"/api/v1/{one.json()['name']}:submitFeedback", json={"rating": "HELPFUL"})
    own_list = await reader.get(f"/api/v1/workspaces/{chat.workspace.id}/conversations")

    assert conversation.status_code == 200, conversation.text
    assert conversation.json()["displayName"] == "Parking"
    assert "lastAnswerSnippet" not in conversation.json()
    turns = messages.json()["messages"]
    assert [(t["role"], t["text"]) for t in turns] == [
        ("USER", "Is parking free?"),
        ("ASSISTANT", "Free on weekends [1]."),
    ]
    assert turns[1]["citations"][0]["item"] == item_name(chat.policy)
    assert one.status_code == 200 and one.json()["text"] == "Free on weekends [1]."
    for response in (converse, rename, feedback):
        assert response.status_code == 403
    assert own_list.json().get("conversations", []) == []


async def test_shared_readers_never_see_outdated_sources(chat: Chat) -> None:
    await chat.world.grant(WORKSPACE_MEMBERS, "roles/collectionViewer", on=chat.handbook)
    colleague = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)
    await share_conversation(await chat.api(), chat.workspace, code, "WORKSPACE")
    changed = await revise(chat.sessions, chat.policy)

    owner_view = (await (await chat.api()).get(conversation_url(chat.workspace, code))).json()
    reader_view = (await (await chat.api(colleague)).get(conversation_url(chat.workspace, code))).json()
    reader_turns = (await _messages(chat, code, colleague)).json()["messages"]

    assert [s["updateTime"] for s in owner_view["outdatedSources"]] == [changed]
    assert "outdatedSources" not in reader_view
    assert reader_turns[1]["citations"][0]["outdated"] is True



async def test_people_share_is_refiltered_for_every_reader(chat: Chat) -> None:
    reader = await chat.world.add_member(chat.workspace)
    bystander = await chat.world.add_member(chat.workspace)
    await chat.world.grant(reader, "roles/collectionViewer", on=chat.handbook)
    code = await _answered(chat)
    await share_conversation(await chat.api(), chat.workspace, code, "PEOPLE", [reader])

    readable = await _messages(chat, code, reader)
    not_recipient = await _messages(chat, code, bystander)
    assert readable.json()["messages"][1]["text"] == "Free on weekends [1]."
    assert not_recipient.status_code == 403

    await chat.world.revoke(reader, on=chat.handbook)
    withheld = await _messages(chat, code, reader)

    assert withheld.status_code == 200
    user_turn, answer_turn = withheld.json()["messages"]
    assert user_turn["text"] == "Is parking free?" and "available" not in user_turn
    assert answer_turn["available"] is False
    assert "text" not in answer_turn and "citations" not in answer_turn
    async with transaction_scope(chat.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == chat.policy.id).values(is_published=False)
        )
    owner_view = (await _messages(chat, code, chat.member)).json()["messages"][1]
    assert owner_view["text"] == "Free on weekends [1]."
    assert owner_view["citations"] == [{"available": False}]


async def test_deleted_conversations_and_revoked_shares_stop_resolving(chat: Chat) -> None:
    await chat.world.grant(WORKSPACE_MEMBERS, "roles/collectionViewer", on=chat.handbook)
    other = await chat.world.add_member(chat.workspace)
    code = await _answered(chat)
    owner = await chat.api()
    share = await share_conversation(owner, chat.workspace, code, "WORKSPACE")
    url = conversation_url(chat.workspace, code)

    await owner.delete(url)
    while_deleted = await (await chat.api(other)).get(url)
    await owner.post(conversation_url(chat.workspace, code, ":undelete"), json={})
    restored = await (await chat.api(other)).get(url)
    await owner.delete(f"/api/v1/{share['name']}")
    revoked = await (await chat.api(other)).get(url)

    assert while_deleted.status_code == 404
    assert restored.status_code == 200
    assert revoked.status_code == 403
