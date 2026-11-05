"""ConverseConversation: SSE shape, server-held history, replaceFromMessage, scope and attachments."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select, update

from bomesh.services.conversations.conversations import ConversationResourceService
from bomesh.services.kernel.context import RequestContext
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, Message, MessageItem
from bomesh.iam.authorizer import Authorizer, Principal
from conftest import Chat
from conversations_support import (
    answer,
    conversation_url,
    error_reason,
    failure,
    item_name,
    script_model,
    search,
    sse_events,
)

pytestmark = pytest.mark.asyncio


async def _converse(chat: Chat, code: str, user: Any = None, **body: Any):
    api = await chat.api(user)
    return await api.post(conversation_url(chat.workspace, code, ":converse"), json=body)


async def _messages(chat: Chat, code: str) -> list[dict[str, Any]]:
    response = await (await chat.api()).get(conversation_url(chat.workspace, code, "/messages"))
    assert response.status_code == 200, response.text
    return response.json()["messages"]


def _code(conversation: dict[str, Any]) -> str:
    return conversation["name"].rsplit("/", 1)[-1]


async def test_stream_is_one_openresponses_reply_with_passage_citations(chat: Chat) -> None:
    await chat.index(chat.policy, "Up to five days of annual leave carry over.", page=4)
    script_model(
        chat.runtime,
        chat.fakes,
        search("annual leave carry over"),
        answer("Five days carry over ", "[[cite:ref_1]]."),
    )
    code = _code(await chat.conversation())

    response = await _converse(chat, code, message="How much leave carries over?")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    events = sse_events(response.text)
    names = [name for name, _ in events]
    assert names[0] == "response.created" and names[-1] == "response.completed"
    assert names.count("response.created") == 1 and names.count("response.completed") == 1
    assert "response.in_progress" not in names
    assert [data["sequence_number"] for _, data in events] == list(range(1, len(events) + 1))
    created = events[0][1]["response"]
    message_name = created["metadata"]["message"]
    assert message_name.startswith(f"workspaces/{chat.workspace.id}/conversations/{code}/messages/")
    assert created["status"] == "in_progress"
    # Output indexes continue across the search step and the answer step.
    added = [data for name, data in events if name == "response.output_item.added"]
    assert [item["item"]["type"] for item in added] == ["function_call", "function_call_output", "message"]
    assert [item["output_index"] for item in added] == [0, 1, 2]
    deltas = "".join(data["delta"] for name, data in events if name == "response.output_text.delta")
    assert deltas == "Five days carry over [1]."
    annotation = next(
        data["annotation"] for name, data in events if name == "response.output_text.annotation.added"
    )
    passage = f"{item_name(chat.policy)}/passages/{chat.policy.id}:0"
    assert annotation["citation"]["passage"] == passage
    assert annotation["citation"]["item"] == item_name(chat.policy)
    completed = events[-1][1]["response"]
    assert completed["status"] == "completed" and completed["metadata"]["message"] == message_name

    stored = await _messages(chat, code)
    assert [(m["role"], m["state"]) for m in stored] == [("USER", "COMPLETED"), ("ASSISTANT", "COMPLETED")]
    assert stored[1]["name"] == message_name
    assert stored[1]["text"] == "Five days carry over [1]."
    assert stored[1]["citations"] == [
        {
            "passage": passage,
            "item": item_name(chat.policy),
            "displayName": "Leave policy",
            "pageNumber": 4,
            "excerpt": "Up to five days of annual leave carry over.",
            "available": True,
        }
    ]
    conversation = (await (await chat.api()).get(conversation_url(chat.workspace, code))).json()
    assert conversation["displayName"] == "How much leave carries over?"
    assert "lastMessageTime" in conversation


async def test_history_is_server_owned_and_replace_from_message_supersedes(chat: Chat) -> None:
    transport = script_model(
        chat.runtime,
        chat.fakes,
        answer("first answer"),
        answer("second answer"),
        answer("second answer again"),
    )
    code = _code(await chat.conversation())

    await _converse(chat, code, message="first question")
    await _converse(chat, code, message="second question")
    second = (await _messages(chat, code))[2]["name"]
    retried = await _converse(chat, code, message="second question edited", replaceFromMessage=second)

    assert retried.status_code == 200
    assert "first answer" in str(transport.requests[1]["input"])
    last_input = str(transport.requests[2]["input"])
    assert "first answer" in last_input and "second question edited" in last_input
    assert "second answer" not in last_input.replace("second question edited", "")
    texts = [(m["role"], m["text"]) for m in await _messages(chat, code)]
    assert texts == [
        ("USER", "first question"),
        ("ASSISTANT", "first answer"),
        ("USER", "second question edited"),
        ("ASSISTANT", "second answer again"),
    ]
    # Superseded messages are kept and still addressable.
    old = await (await chat.api()).get(f"/api/v1/{second}")
    assert old.status_code == 200 and old.json()["text"] == "second question"
    async with transaction_scope(chat.sessions) as session:
        statuses = list(
            await session.scalars(select(Message.status).order_by(Message.sequence_number))
        )
    assert statuses == ["active", "active", "superseded", "superseded", "active", "active"]


async def test_replace_from_message_must_name_an_active_user_message(chat: Chat) -> None:
    script_model(chat.runtime, chat.fakes, answer("an answer"))
    code = _code(await chat.conversation())
    await _converse(chat, code, message="a question")
    answer_name = (await _messages(chat, code))[1]["name"]
    unknown = f"workspaces/{chat.workspace.id}/conversations/{code}/messages/{UUID(int=7)}"

    assistant = await _converse(chat, code, message="retry", replaceFromMessage=answer_name)
    missing = await _converse(chat, code, message="retry", replaceFromMessage=unknown)
    malformed = await _converse(chat, code, message="retry", replaceFromMessage="messages/1")
    blank = await _converse(chat, code, message="   ")

    for response in (assistant, missing, malformed, blank):
        assert response.status_code == 400
        assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert len(await _messages(chat, code)) == 2


async def test_scope_limits_retrieval_and_is_rechecked_every_turn(chat: Chat) -> None:
    finance = await chat.world.make_collection(
        chat.workspace, title="Finance", grants={chat.member: "roles/collectionViewer"}
    )
    budget = await chat.world.make_document(finance, title="Budget")
    await chat.index(chat.policy, "travel allowance is 50 euros per day")
    await chat.index(budget, "travel allowance budget is frozen")
    script_model(
        chat.runtime, chat.fakes, search("travel allowance"), answer("Fifty euros [[cite:ref_1]].")
    )
    code = _code(await chat.conversation(scope={"collections": [item_name(chat.handbook)]}))

    response = await _converse(chat, code, message="What is the travel allowance?")

    observations = [
        data["item"]
        for name, data in sse_events(response.text)
        if name == "response.output_item.done" and data["item"]["type"] == "function_call_output"
    ]
    assert "50 euros per day" in str(observations)
    assert "frozen" not in str(observations)

    await chat.world.revoke(chat.member, on=chat.handbook)
    revoked = await _converse(chat, code, message="And now?")
    assert revoked.status_code == 403


async def test_attachments_must_be_readable_documents(chat: Chat) -> None:
    secret = await chat.world.make_collection(chat.workspace, title="Secret")
    hidden = await chat.world.make_document(secret, title="Hidden")
    script_model(chat.runtime, chat.fakes, answer("I see the attachment."))
    code = _code(await chat.conversation())

    unreadable = await _converse(chat, code, message="Read this", attachments=[item_name(hidden)])
    collection = await _converse(chat, code, message="Read this", attachments=[item_name(chat.handbook)])
    malformed = await _converse(chat, code, message="Read this", attachments=["not-an-item"])
    readable = await _converse(chat, code, message="Read this", attachments=[item_name(chat.policy)])

    assert unreadable.status_code == 403
    assert collection.status_code == 400
    assert malformed.status_code == 400
    assert readable.status_code == 200, readable.text
    async with transaction_scope(chat.sessions) as session:
        links = (await session.execute(select(MessageItem.item_id, MessageItem.relation_type))).all()
    assert links == [(chat.policy.id, "attachment")]


async def test_model_failure_is_streamed_and_stored_failed(chat: Chat) -> None:
    script_model(chat.runtime, chat.fakes, failure())
    code = _code(await chat.conversation())

    response = await _converse(chat, code, message="Anything?")

    events = sse_events(response.text)
    assert [name for name, _ in events][-1] == "response.failed"
    failed = events[-1][1]
    assert failed["response"]["status"] == "failed"
    assert failed["error"]["code"] == 13
    assert failed["error"]["details"][0]["reason"] == "SERVER_ERROR"
    assert [(m["role"], m["state"]) for m in await _messages(chat, code)] == [
        ("USER", "COMPLETED"),
        ("ASSISTANT", "FAILED"),
    ]


async def test_client_disconnect_stores_the_partial_answer_interrupted(chat: Chat) -> None:
    script_model(chat.runtime, chat.fakes, answer("Partial ", "answer ", "never finished"))
    code = _code(await chat.conversation())
    service = ConversationResourceService.from_runtime(chat.runtime)
    ctx = RequestContext(Principal(chat.member.id), Authorizer(chat.sessions))
    seen: list[str] = []

    async def is_disconnected() -> bool:
        return seen.count("response.output_text.delta") >= 2

    events = await service.converse(
        ctx,
        chat.workspace.id,
        code,
        message="Tell me",
        attachments=[],
        replace_from_message=None,
        is_disconnected=is_disconnected,
    )
    async for event in events:
        seen.append(event.type)

    assert seen[-1] == "response.incomplete"
    stored = await _messages(chat, code)
    assert stored[1]["state"] == "INTERRUPTED"
    assert stored[1]["text"] == "Partial answer"


async def test_deleted_or_foreign_conversations_cannot_converse(chat: Chat) -> None:
    other = await chat.world.add_member(chat.workspace)
    code = _code(await chat.conversation())
    foreign = await _converse(chat, code, other, message="hi")
    await (await chat.api()).delete(conversation_url(chat.workspace, code))

    deleted = await _converse(chat, code, message="hi")

    assert foreign.status_code == 403
    assert deleted.status_code == 400
    assert deleted.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert error_reason(deleted) == "CONVERSATION_DELETED"


async def test_workspace_instructions_and_file_work_shape_the_request(chat: Chat) -> None:
    transport = script_model(chat.runtime, chat.fakes, answer("Ok."))
    admin_api = await chat.api(chat.admin)
    updated = await admin_api.patch(
        f"/api/v1/workspaces/{chat.workspace.id}/assistant",
        params={"updateMask": "instructions,answerLength"},
        json={"instructions": "Always answer in French.", "answerLength": "CONCISE"},
    )
    assert updated.status_code == 200, updated.text
    code = _code(await chat.conversation())

    await _converse(chat, code, message="Hello")

    instructions = transport.requests[0]["instructions"]
    assert "<workspace_instructions>Always answer in French." in instructions
    assert "Keep answers short" in instructions


async def test_scope_spaces_search_the_space_collections(chat: Chat) -> None:
    space = await chat.world.make_space(chat.workspace, chat.member, code="ops")
    team = await chat.world.make_collection(
        chat.workspace, title="Ops", grants={chat.member: "roles/collectionViewer"}
    )
    async with transaction_scope(chat.sessions) as session:
        await session.execute(update(Item).where(Item.id == team.id).values(space_id=space.id))
    runbook = await chat.world.make_document(team, title="Runbook")
    await chat.index(runbook, "restart the ingest worker nightly")
    await chat.index(chat.policy, "restart requests need approval")
    script_model(chat.runtime, chat.fakes, search("restart"), answer("Nightly [[cite:ref_1]]."))
    code = _code(
        await chat.conversation(scope={"spaces": [f"workspaces/{chat.workspace.id}/spaces/ops"]})
    )

    response = await _converse(chat, code, message="When do we restart?")

    observations = str(
        [
            data["item"]
            for name, data in sse_events(response.text)
            if name == "response.output_item.done" and data["item"]["type"] == "function_call_output"
        ]
    )
    assert "ingest worker nightly" in observations
    assert "need approval" not in observations
