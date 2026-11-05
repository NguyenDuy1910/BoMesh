"""The question queries Workspaces insights and knowledge gaps aggregate over (review #24)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from bomesh.services.conversations.queries import answered_question_rows, question_rows
from bomesh.db.engine import transaction_scope
from conftest import Chat
from conversations_support import answer, conversation_url, failure, script_model, search

pytestmark = pytest.mark.asyncio


async def test_question_rows_count_active_questions_of_live_conversations(chat: Chat) -> None:
    await chat.index(chat.policy, "Badges are renewed yearly.")
    script_model(
        chat.runtime,
        chat.fakes,
        search("badges are renewed yearly"),
        answer("Yearly [[cite:ref_1]]."),
        failure(),
        answer("Replaced answer."),
        answer("Gone with its conversation."),
    )
    api = await chat.api()
    code = (await chat.conversation())["name"].rsplit("/", 1)[-1]
    converse = conversation_url(chat.workspace, code, ":converse")
    await api.post(converse, json={"message": "When are badges renewed?"})
    await api.post(converse, json={"message": "Who signs them?"})
    messages = (await api.get(conversation_url(chat.workspace, code, "/messages"))).json()["messages"]
    await api.post(converse, json={"message": "Who signs badges?", "replaceFromMessage": messages[2]["name"]})
    deleted = (await chat.conversation())["name"].rsplit("/", 1)[-1]
    await api.post(conversation_url(chat.workspace, deleted, ":converse"), json={"message": "Lost"})
    await api.delete(conversation_url(chat.workspace, deleted))

    async with transaction_scope(chat.sessions) as session:
        asked = (await session.execute(question_rows())).all()
        answered = sorted(
            (await session.execute(answered_question_rows(chat.workspace.id))).all(),
            key=lambda row: row.asked_at,
        )
        other = (await session.execute(select(answered_question_rows(chat.admin.id).subquery()))).all()

    assert sorted((row.tenant_id, row.user_id) for row in asked) == [(chat.workspace.id, chat.member.id)] * 2
    assert [(row.content, row.feedback_rating) for row in answered] == [
        ("When are badges renewed?", None),
        ("Who signs badges?", None),
    ]
    assert answered[0].citations[0]["item_id"] == str(chat.policy.id)
    assert answered[1].citations == []
    assert other == []
