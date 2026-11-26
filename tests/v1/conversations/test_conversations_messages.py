"""ListMessages, GetMessage and SubmitMessageFeedback."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import func, select, update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, Message, MessageCitation
from bomesh.document_structure import CitationTarget, Highlight
from bomesh.services.conversations.citations import message_citations
from conftest import Chat
from conversations_support import (
    STRUCTURE_VERSION,
    answer,
    conversation_url,
    conversations_url,
    error_reason,
    item_name,
    revise,
    script_model,
    search,
)

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


async def test_conversation_carries_its_latest_completed_answer(chat: Chat) -> None:
    code = await _two_turns(chat)
    empty = (await chat.conversation())["name"]
    api = await chat.api()

    def snippets(response: Any) -> dict[str, str | None]:
        assert response.status_code == 200, response.text
        return {c["name"]: c.get("lastAnswerSnippet") for c in response.json()["conversations"]}

    listed = snippets(await api.get(conversations_url(chat.workspace)))
    async with transaction_scope(chat.sessions) as session:
        latest = await session.scalar(
            select(func.max(Message.sequence_number)).where(Message.role == "assistant")
        )
        await session.execute(
            update(Message).where(Message.sequence_number == latest).values(generation_state="failed")
        )
    after_failure = snippets(await api.get(conversations_url(chat.workspace)))
    fetched = await api.get(conversation_url(chat.workspace, code))

    name = f"workspaces/{chat.workspace.id}/conversations/{code}"
    assert listed == {name: "You're welcome.", empty: None}
    assert after_failure[name] == "Ask your manager [1]."
    assert fetched.json()["lastAnswerSnippet"] == "Ask your manager [1]."



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
            update(Item).where(Item.id == chat.policy.id).values(is_published=False)
        )

    after = (await (await chat.api()).get(f"/api/v1/{name}")).json()

    assert before["citations"][0]["available"] is True
    assert after["citations"] == [{"available": False}]


async def test_stored_citations_round_trip_their_targets(chat: Chat) -> None:
    code = await _two_turns(chat)
    name = (await _list(chat, code)).json()["messages"][1]["name"]
    answer_id = UUID(name.rsplit("/", 1)[-1])
    located = CitationTarget(
        item_id=chat.policy.id,
        revision_number=1,
        structure_version=STRUCTURE_VERSION,
        refs=("tables/2", "texts/40"),
        quote="Remote days | Approval",
        location="Remote work > Approval",
        highlights=(
            Highlight(page=3, boxes=((0.1, 0.2, 0.6, 0.3),)),
            Highlight(page=4),
        ),
    )
    async with transaction_scope(chat.sessions) as session:
        session.add(
            MessageCitation(
                message_id=answer_id,
                position=1,
                item_id=located.item_id,
                revision_number=located.revision_number,
                structure_version=located.structure_version,
                refs=list(located.refs),
                quote=located.quote,
                location=located.location,
                highlights=[highlight.to_json() for highlight in located.highlights],
            )
        )
    async with transaction_scope(chat.sessions) as session:
        stored = await message_citations(session, [answer_id])

    # The answer's own citation is the evidence's target, stored as is.
    assert stored == {
        answer_id: (
            CitationTarget(
                item_id=chat.policy.id,
                revision_number=1,
                structure_version=STRUCTURE_VERSION,
                refs=("texts/0",),
                quote="Remote work needs manager approval.",
            ),
            located,
        )
    }
    message = (await (await chat.api()).get(f"/api/v1/{name}")).json()
    assert message["citations"][1] == {
        "item": item_name(chat.policy),
        "revision": f"{item_name(chat.policy)}/revisions/1",
        "structureVersion": STRUCTURE_VERSION,
        "refs": ["tables/2", "texts/40"],
        "quote": "Remote days | Approval",
        "location": "Remote work > Approval",
        "highlights": [
            {
                "pageNumber": 3,
                "boxes": [{"left": 0.1, "top": 0.2, "right": 0.6, "bottom": 0.3}],
            },
            {"pageNumber": 4, "boxes": []},
        ],
        "displayName": "Leave policy",
        "available": True,
        "outdated": False,
        "updateTime": message["citations"][0]["updateTime"],
    }


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


async def test_feedback_on_a_deleted_conversation_is_refused(chat: Chat) -> None:
    code = await _two_turns(chat)
    reply = (await _list(chat, code)).json()["messages"][1]["name"]
    api = await chat.api()
    await api.delete(conversation_url(chat.workspace, code))

    rated = await api.post(f"/api/v1/{reply}:submitFeedback", json={"rating": "HELPFUL"})

    assert rated.status_code == 400
    assert error_reason(rated) == "CONVERSATION_DELETED"


async def test_citations_of_a_merged_duplicate_are_unavailable(chat: Chat) -> None:
    code = await _two_turns(chat)
    target = await chat.world.make_document(chat.handbook, item_name="Remote work policy")
    merged = await (await chat.api(chat.admin)).post(
        f"/api/v1/workspaces/{chat.workspace.id}/items/{chat.policy.id}:merge",
        json={"targetItem": f"workspaces/{chat.workspace.id}/items/{target.id}"},
    )
    assert merged.status_code == 200, merged.text

    message = (await _list(chat, code)).json()["messages"][1]

    assert message["citations"] == [{"available": False}]


async def test_answers_citing_a_revised_document_are_outdated_until_updated(chat: Chat) -> None:
    code = await _two_turns(chat)
    api = await chat.api()
    current = (await _list(chat, code)).json()["messages"]
    changed = await revise(chat.sessions, chat.policy)

    stale = (await _list(chat, code)).json()["messages"]
    listed = (await api.get(conversations_url(chat.workspace))).json()["conversations"]
    fetched = (await api.get(conversation_url(chat.workspace, code))).json()
    await chat.index(chat.policy, "Remote work needs manager approval.")
    script_model(
        chat.runtime, chat.fakes, search("remote work"), answer("Ask your manager [[cite:ref_1]].")
    )
    updated = await api.post(
        conversation_url(chat.workspace, code, ":converse"),
        json={"message": "Can I work remotely?", "replaceFromMessage": stale[0]["name"]},
    )
    assert updated.status_code == 200, updated.text
    fresh = (await _list(chat, code)).json()["messages"]
    refetched = (await api.get(conversation_url(chat.workspace, code))).json()

    source = {"item": item_name(chat.policy), "displayName": "Leave policy", "updateTime": changed}
    assert current[1]["citations"][0]["outdated"] is False
    assert stale[1]["citations"][0]["outdated"] is True
    assert stale[1]["citations"][0]["updateTime"] == changed
    assert [c["outdatedSources"] for c in listed] == [[source]]
    assert fetched["outdatedSources"] == [source]
    # The updated answer cites the current revision; the superseded one no longer counts.
    assert [m["text"] for m in fresh] == ["Can I work remotely?", "Ask your manager [1]."]
    assert fresh[1]["citations"][0]["outdated"] is False
    assert fresh[1]["citations"][0]["updateTime"] == changed
    assert refetched["outdatedSources"] == []


async def test_unreadable_or_deleted_sources_are_never_outdated(chat: Chat) -> None:
    code = await _two_turns(chat)
    await revise(chat.sessions, chat.policy)
    api = await chat.api()

    async def sources() -> list[str]:
        response = await api.get(conversations_url(chat.workspace))
        assert response.status_code == 200, response.text
        return [s["item"] for s in response.json()["conversations"][0]["outdatedSources"]]

    async def publish(value: bool) -> None:
        async with transaction_scope(chat.sessions) as session:
            await session.execute(
                update(Item).where(Item.id == chat.policy.id).values(is_published=value)
            )

    readable = await sources()
    await publish(False)
    unpublished = await sources()
    await publish(True)
    deleted = await (await chat.api(chat.admin)).delete(
        f"/api/v1/workspaces/{chat.workspace.id}/items/{chat.policy.id}"
    )
    assert deleted.status_code == 200, deleted.text
    after_delete = await sources()
    message = (await _list(chat, code)).json()["messages"][1]

    assert readable == [item_name(chat.policy)]
    assert unpublished == [] and after_delete == []
    assert message["citations"] == [{"available": False}]
