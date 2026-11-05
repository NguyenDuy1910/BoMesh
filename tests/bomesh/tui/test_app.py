from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest
from textual.widgets import TextArea

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from bomesh.tui.app import BomeshTui
from bomesh.tui.client import BomeshChatClient, ChatClientConfig


def _frame(event: str) -> str:
    return f"event: {json.loads(event)['type']}\ndata: {event}\n\n"


@pytest.mark.asyncio
async def test_tui_signs_in_creates_the_conversation_and_streams_a_reply() -> None:
    events = [
        '{"type":"response.created","sequence_number":1,"response_id":"resp-1","response":{"id":"resp-1","status":"in_progress"}}',
        '{"type":"response.output_item.added","sequence_number":2,"response_id":"resp-1","output_index":0,"item":{"type":"message","id":"message-1","role":"assistant","content":[]}}',
        '{"type":"response.content_part.added","sequence_number":3,"response_id":"resp-1","item_id":"message-1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}',
        '{"type":"response.output_text.delta","sequence_number":4,"response_id":"resp-1","item_id":"message-1","output_index":0,"content_index":0,"delta":"Grounded **answer**"}',
        '{"type":"response.output_item.done","sequence_number":5,"response_id":"resp-1","output_index":0,"item":{"type":"message","id":"message-1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Grounded **answer**"}]}}',
        '{"type":"response.completed","sequence_number":6,"response":{"id":"resp-1","status":"completed"}}',
    ]
    stream = "".join(_frame(event) for event in events)
    requests: list[tuple[str, str, dict[str, object], str | None]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        query = request.url.params.get("conversationId")
        requests.append((request.method, request.url.path, body, request.headers.get("authorization")))
        if request.url.path == "/api/v1/sessions":
            return httpx.Response(200, json={"name": "sessions/s1", "accessToken": "tok"})
        if request.url.path == "/api/v1/workspaces/ws1/conversations":
            return httpx.Response(200, json={"name": f"workspaces/ws1/conversations/{query}"})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=stream)

    config = ChatClientConfig(
        api_url="http://test", workspace="ws1", email="a@example.com", password="pw"
    )
    app = BomeshTui(config)
    app._client = BomeshChatClient(config, transport=httpx.MockTransport(respond))

    async with app.run_test() as pilot:
        app.query_one("#composer", TextArea).load_text("What is the answer?")
        app.action_send()
        await pilot.pause(0.2)

    conversation = app._state.conversation_id
    # The server owns history: the converse body carries only the message.
    assert requests == [
        (
            "POST",
            "/api/v1/sessions",
            {"credential": {"password": {"email": "a@example.com", "password": "pw"}}},
            None,
        ),
        ("POST", "/api/v1/workspaces/ws1/conversations", {}, "Bearer tok"),
        (
            "POST",
            f"/api/v1/workspaces/ws1/conversations/{conversation}:converse",
            {"message": "What is the answer?"},
            "Bearer tok",
        ),
    ]
    assert app._state.turn is not None
    assert app._state.turn.final_text == "Grounded **answer**"
    assert app._state.raw_sse_lines[-1] == f"data: {events[-1]}"


@pytest.mark.asyncio
async def test_client_continues_an_existing_conversation_on_409() -> None:
    paths: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/conversations"):
            return httpx.Response(409, json={"error": {"code": 409, "message": "exists"}})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=_frame('{"type":"response.completed","sequence_number":1}'),
        )

    client = BomeshChatClient(
        ChatClientConfig(api_url="http://test", workspace="ws1", access_token="tok"),
        transport=httpx.MockTransport(respond),
    )
    for _ in range(2):
        received = [e async for e in client.stream_turn(message="hi", conversation_id="c1")]
        assert received[0].event["type"] == "response.completed"
    assert paths == [
        "/api/v1/workspaces/ws1/conversations",
        "/api/v1/workspaces/ws1/conversations/c1:converse",
        "/api/v1/workspaces/ws1/conversations/c1:converse",
    ]
