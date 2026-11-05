"""ListMessages, GetMessage and SubmitMessageFeedback."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import func, select, update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, Message
from conftest import Chat
from conversations_support import answer, conversation_url, error_reason, script_model, search

pytestmark = pytest.mark.asyncio


async def _two_turns(chat: Chat) -> str:
    """A conversation with two answered turns, the first citing ``chat.policy``."""
    await chat.index(chat.policy, "Remote work needs manager approval.")
    script_model(
        chat.runtime,
        chat.fakes,
        search("remote work"),
        answer("Ask your manager [[cite:ref_1]]."),
        answer("You're welcome."),
    )
    code = (await chat.conversation())["name"].rsplit("/", 1)[-1]
    api = await chat.api()
    for text in ("Can I work remotely?", "Thanks"):
        response = await api.post(conversation_url(chat.workspace, code, ":converse"), json={"message": text})
        assert response.status_code == 200, response.text
    return code


async def _list(chat: Chat, code: str, user: Any = None, **params: Any):
    return await (await chat.api(user)).get(conversation_url(chat.workspace, code, "/messages"), params=params)


async def test_list_filters_orders_and_pages(chat: Chat) -> None:
    code = await _two_turns(chat)

    everything = await _list(chat, code)
    answers = await _list(chat, code, filter='role = ASSISTANT AND state = "COMPLETED"')
    newest_first = await _list(chat, code, orderBy="createTime desc")
    first = await _list(chat, code, pageSize=3)
    rest = await _list(chat, code, pageSize=3, pageToken=first.json()["nextPageToken"])
    bad_filter = await _list(chat, code, filter="state = DONE")

    texts = [m["text"] for m in everything.json()["messages"]]
    assert texts == ["Can I work remotely?", "Ask your manager [1].", "Thanks", "You're welcome."]
    assert everything.json()["totalSize"] == 4
    assert [m["role"] for m in answers.json()["messages"]] == ["ASSISTANT", "ASSISTANT"]
    assert [m["text"] for m in newest_first.json()["messages"]] == texts[::-1]
    assert len(first.json()["messages"]) == 3
    assert [m["text"] for m in rest.json()["messages"]] == ["You're welcome."]
    assert bad_filter.status_code == 400


async def test_messages_are_owner_private(chat: Chat) -> None:
    code = await _two_turns(chat)
    other = await chat.world.add_member(chat.workspace)
    message = (await _list(chat, code)).json()["messages"][1]["name"]

    listed = await _list(chat, code, other)
    fetched = await (await chat.api(other)).get(f"/api/v1/{message}")
    rated = await (await chat.api(other)).post(f"/api/v1/{message}:submitFeedback", json={"rating": "HELPFUL"})
    missing = await _list(chat, "missing")

    assert listed.status_code == 403
    assert fetched.status_code == 403
    assert rated.status_code == 403
    assert missing.status_code == 404


async def test_citations_are_rechecked_on_every_read(chat: Chat) -> None:
    code = await _two_turns(chat)
    name = (await _list(chat, code)).json()["messages"][1]["name"]
    before = (await (await chat.api()).get(f"/api/v1/{name}")).json()
    async with transaction_scope(chat.sessions) as session:
        await session.execute(
            update(Item).where(Item.id == chat.policy.id).values(publication_state="unpublished")
        )

    after = (await (await chat.api()).get(f"/api/v1/{name}")).json()

    assert before["citations"][0]["available"] is True
    assert after["citations"] == [{"available": False}]


async def test_feedback_is_stored_and_cleared(chat: Chat) -> None:
    code = await _two_turns(chat)
    messages = (await _list(chat, code)).json()["messages"]
    question, reply = messages[0]["name"], messages[1]["name"]
    api = await chat.api()

    rated = await api.post(
        f"/api/v1/{reply}:submitFeedback",
        json={"rating": "UNHELPFUL", "reason": "OUTDATED", "comment": "Policy changed"},
    )
    on_question = await api.post(f"/api/v1/{question}:submitFeedback", json={"rating": "HELPFUL"})
    too_long = await api.post(f"/api/v1/{reply}:submitFeedback", json={"rating": "HELPFUL", "reason": "x" * 65})

    assert rated.status_code == 200, rated.text
    feedback = rated.json()["feedback"]
    assert (feedback["rating"], feedback["reason"], feedback["comment"]) == ("UNHELPFUL", "OUTDATED", "Policy changed")
    assert "createTime" in feedback
    assert on_question.status_code == 400
    assert on_question.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert too_long.status_code == 400
    async with transaction_scope(chat.sessions) as session:
        row = await session.scalar(select(Message).where(Message.role == "assistant").order_by(Message.sequence_number))
        assert row is not None and row.feedback_rating == "unhelpful" and row.feedback_at is not None

    cleared = await api.post(f"/api/v1/{reply}:submitFeedback", json={"rating": "RATING_UNSPECIFIED"})

    assert cleared.status_code == 200 and "feedback" not in cleared.json()
    async with transaction_scope(chat.sessions) as session:
        row = await session.scalar(select(Message).where(Message.id == row.id))
        assert row is not None
        assert (row.feedback_rating, row.feedback_reason, row.feedback_comment, row.feedback_at) == (None,) * 4


async def test_feedback_and_shares_on_a_deleted_conversation_are_refused(chat: Chat) -> None:
    code = await _two_turns(chat)
    reply = (await _list(chat, code)).json()["messages"][1]["name"]
    api = await chat.api()
    await api.delete(conversation_url(chat.workspace, code))

    rated = await api.post(f"/api/v1/{reply}:submitFeedback", json={"rating": "HELPFUL"})
    shared = await api.post(
        conversation_url(chat.workspace, code, "/shares"), json={"audience": "WORKSPACE"}
    )

    for response in (rated, shared):
        assert response.status_code == 400
        assert error_reason(response) == "CONVERSATION_DELETED"


async def _merge(chat: Chat, duplicate: Item, target: Item) -> None:
    """MergeItem's stored effect: the duplicate is deleted and names its target."""
    async with transaction_scope(chat.sessions) as session:
        await session.execute(
            update(Item)
            .where(Item.id == duplicate.id)
            .values(deleted_at=func.now(), metadata_={"merged_into": str(target.id)})
        )


async def test_citations_of_a_merged_duplicate_never_show_its_content(chat: Chat) -> None:
    code = await _two_turns(chat)
    target = await chat.world.make_document(chat.handbook, title="Remote work policy")
    reader = await chat.world.add_member(chat.workspace)
    await chat.world.grant(reader, "roles/collectionViewer", on=chat.handbook)
    share = await (await chat.api()).post(
        conversation_url(chat.workspace, code, "/shares"),
        json={"audience": "PEOPLE", "recipients": [f"workspaces/{chat.workspace.id}/members/{reader.id}"]},
    )
    assert share.status_code == 200, share.text
    await _merge(chat, chat.policy, target)

    message = (await _list(chat, code)).json()["messages"][1]
    shared = (await (await chat.api(reader)).get(f"/api/v1/{share.json()['name']}")).json()

    assert message["citations"] == [
        {
            "item": f"workspaces/{chat.workspace.id}/items/{target.id}",
            "displayName": "Remote work policy",
            "available": True,
        }
    ]
    assert shared["snapshot"]["messages"][1] == {"role": "ASSISTANT", "available": False}
