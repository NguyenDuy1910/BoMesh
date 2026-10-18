"""Request shaping for provider prompt caching over a stateless Responses API."""

from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from openai import AsyncOpenAI

_TESTS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_TESTS_ROOT))
sys.path.insert(0, str(_TESTS_ROOT.parent / "backend"))

from native_responses import (
    ScriptedResponsesTransport,
    completed,
    created,
    function_call,
    message,
)

from bomesh.agent import (
    Agent,
    AgentExecutionError,
    ContextManager,
    ModelInput,
    ResolvedStepSettings,
    ResourceRef,
    Session,
    SessionConfiguration,
    SessionServices,
    TextInput,
    TurnContext,
    TurnEnvironmentSnapshot,
    UserTurn,
)
from bomesh.agent.models import AgentContext, ConversationMessage, ToolOutput
from bomesh.agent.protocol import InputText, MessageItem, Prompt, Reasoning
from bomesh.agent.tools import ToolExecutor, ToolInvocation, ToolRegistry, ToolSpec
from bomesh.agent.transports.openrouter import OpenRouterTransport
from bomesh.agent.transports.responses_adapter import ResponsesStream
from bomesh.agent.turn import run_turn

CONVERSATION_ID = "0f9c2d4e-8a51-4c7e-9a43-2b1f7d6e5c10"


class Lookup(ToolExecutor):
    def __init__(self) -> None:
        self.invocations: list[ToolInvocation] = []

    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="knowledge_search",
            description="Search knowledge.",
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": False,
            },
        )

    async def handle(self, invocation: ToolInvocation) -> ToolOutput:
        self.invocations.append(invocation)
        return ToolOutput(content=f"found {invocation.payload.arguments['query']}")


def _search_then_answer(index: int) -> list[list[Any]]:
    return [
        [
            *created(f"resp_{index}a"),
            *function_call(
                item_id=f"fc_{index}",
                output_index=0,
                call_id=f"call_{index}",
                name="knowledge_search",
                argument_deltas=['{"query":"leave"}'],
            ),
            *completed(f"resp_{index}a"),
        ],
        [
            *created(f"resp_{index}b"),
            *message(
                item_id=f"msg_{index}",
                output_index=0,
                deltas=["Leave is 20 days."],
                phase="final_answer",
            ),
            *completed(f"resp_{index}b"),
        ],
    ]


def _context(
    *,
    history: tuple[ConversationMessage, ...] = (),
    resources: tuple[ResourceRef, ...] = (),
) -> AgentContext:
    return AgentContext(
        user_id="user",
        tenant_id="tenant",
        roles=[],
        conversation_id=CONVERSATION_ID,
        history=history,
        resources=resources,
        allowed_tool_names=("knowledge_search",),
    )


def _prefix(request: dict[str, Any]) -> str:
    return json.dumps(
        {"instructions": request["instructions"], "tools": request["tools"]},
        sort_keys=True,
    )


@pytest.mark.asyncio
async def test_instructions_and_tools_are_byte_identical_across_steps_and_turns() -> None:
    """The cacheable prefix never carries per-turn data."""

    transport = ScriptedResponsesTransport(
        [*_search_then_answer(1), *_search_then_answer(2)]
    )
    registry = ToolRegistry()
    registry.register(Lookup())
    agent = Agent(
        model=transport,
        tools=registry,
        configuration=SessionConfiguration(max_model_turns=3, max_tool_rounds=2),
    )
    leave = ResourceRef(id="leave-policy", name="Leave policy.pdf", mime_type="application/pdf")
    travel = ResourceRef(id="travel-policy", name="Travel policy.pdf", mime_type="application/pdf")

    _ = [
        event
        async for event in agent.run(
            "Summarize the leave policy", _context(resources=(leave, travel))
        )
    ]
    _ = [
        event
        async for event in agent.run(
            "And the travel policy?",
            _context(
                history=(
                    ConversationMessage(role="user", content="Summarize the leave policy"),
                    ConversationMessage(role="assistant", content="Leave is 20 days."),
                ),
                resources=(leave, travel),
            ),
        )
    ]

    assert len(transport.requests) == 4
    assert len({_prefix(request) for request in transport.requests}) == 1
    assert "<resource_id>" not in transport.requests[0]["instructions"]
    # Per-turn resources sit right before the user's message instead.
    first_turn, second_turn = transport.requests[0], transport.requests[2]
    assert first_turn["input"][-2]["role"] == "developer"
    assert "<resource_id>leave-policy</resource_id>" in first_turn["input"][-2]["content"]
    assert "<resource_id>travel-policy</resource_id>" in second_turn["input"][-2]["content"]
    # The second turn's input extends the replayed history; the first step of
    # each turn ends with the user's message.
    assert [item["role"] for item in second_turn["input"]] == [
        "user",
        "assistant",
        "developer",
        "user",
    ]
    for request in transport.requests:
        assert request["reasoning"] == {"effort": "none"}
        assert request["prompt_cache_key"] == CONVERSATION_ID
        assert "previous_response_id" not in request
        assert "store" not in request
        assert "include" not in request


@pytest.mark.asyncio
async def test_tool_limit_keeps_the_tool_array_and_refuses_further_calls() -> None:
    transport = ScriptedResponsesTransport(
        [
            _search_then_answer(1)[0],
            # The model ignores tool_choice "none" and calls again.
            _search_then_answer(2)[0],
        ]
    )
    lookup = Lookup()
    registry = ToolRegistry()
    registry.register(lookup)
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=1)
    session = Session(
        configuration,
        SessionServices(model=transport, tool_registry=registry),
        ContextManager(configuration=configuration),
    )
    settings = ResolvedStepSettings(
        model=None, temperature=None, max_output_tokens=None, parallel_tool_calls=True
    )
    turn = TurnContext(
        user_turn=UserTurn(inputs=(TextInput(text="What is the leave policy?"),)),
        environment=TurnEnvironmentSnapshot(agent_context=_context()),
        initial_settings=settings,
        current_settings=settings,
    )

    with pytest.raises(AgentExecutionError, match="after the safety limit"):
        _ = [event async for event in run_turn(session, turn)]

    first, second = transport.requests
    assert first["tool_choice"] == "auto"
    assert second["tool_choice"] == "none"
    assert second["tools"] == first["tools"]
    assert second["instructions"] == first["instructions"]
    assert len(lookup.invocations) == 1


@pytest.mark.asyncio
async def test_execution_router_exposes_nothing_once_limits_are_reached() -> None:
    registry = ToolRegistry()
    registry.register(Lookup())
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=1)
    session = Session(
        configuration,
        SessionServices(model=ScriptedResponsesTransport([]), tool_registry=registry),
        ContextManager(configuration=configuration),
    )
    settings = ResolvedStepSettings(
        model=None, temperature=None, max_output_tokens=None, parallel_tool_calls=True
    )
    turn = TurnContext(
        user_turn=UserTurn(inputs=(TextInput(text="What is the leave policy?"),)),
        environment=TurnEnvironmentSnapshot(agent_context=_context()),
        initial_settings=settings,
        current_settings=settings,
        tool_round=1,
    )

    step = await session.capture_step_context(turn)

    assert step.tools_enabled is False
    assert step.tool_names == ("knowledge_search",)
    assert [tool.name for tool in session.build_model_input(step).tools] == [
        "knowledge_search"
    ]
    assert session.tool_router(step).model_visible_specs == ()


def test_reasoning_effort_can_be_omitted() -> None:
    settings = ResolvedStepSettings(
        model="m", temperature=None, max_output_tokens=None, parallel_tool_calls=True
    )
    configuration = SessionConfiguration(reasoning_effort=None)
    assert configuration.reasoning_effort is None

    prompt = ModelInput(
        turn_id="turn",
        step_index=1,
        settings=settings,
        sandbox_guidance=None,
        instructions="static",
        input_items=(MessageItem(role="user", content=(InputText(text="hi"),)),),
        tools=(),
    ).prompt(previous_response_id=None)

    assert prompt.reasoning is None
    assert prompt.prompt_cache_key is None


_STREAM_BODY = "\n".join(
    [
        'data: {"type":"response.completed","sequence_number":1,"response":'
        + json.dumps(
            {
                "id": "resp_1",
                "object": "response",
                "created_at": 1,
                "status": "completed",
                "model": "openai/gpt-test",
                "output": [],
                "parallel_tool_calls": True,
                "tool_choice": "auto",
                "tools": [],
                "usage": {
                    "input_tokens": 2595,
                    "input_tokens_details": {"cached_tokens": 2592},
                    "output_tokens": 5,
                    "output_tokens_details": {"reasoning_tokens": 0},
                    "total_tokens": 2600,
                },
            }
        )
        + "}",
        "",
        "data: [DONE]",
        "",
    ]
)


@pytest.mark.asyncio
async def test_openrouter_wire_body_carries_cache_routing_and_reasoning_only() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            text=_STREAM_BODY,
            headers={"content-type": "text/event-stream"},
            request=request,
        )

    transport = OpenRouterTransport(
        api_key="test-key",
        model="openai/gpt-test",
        responses_client=AsyncOpenAI(
            api_key="test-key",
            base_url=OpenRouterTransport.DEFAULT_BASE_URL,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        ),
    )
    prompt = Prompt(
        input=(MessageItem(role="user", content=(InputText(text="hi"),)),),
        instructions="static",
        reasoning=Reasoning(effort="none"),
        prompt_cache_key=CONVERSATION_ID,
        # Runtime lineage only: never forwarded to the stateless API.
        previous_response_id="resp_0",
    )

    events = [event async for event in ResponsesStream(transport).stream(prompt)]

    body = seen["body"]
    assert body["reasoning"] == {"effort": "none"}
    assert body["prompt_cache_key"] == CONVERSATION_ID
    assert body["session_id"] == CONVERSATION_ID
    assert "previous_response_id" not in body
    assert "store" not in body
    assert "include" not in body
    usage = events[-1].response.usage
    assert usage.input_tokens_details.cached_tokens == 2592


@pytest.mark.asyncio
async def test_each_sample_records_usage_with_cached_tokens() -> None:
    recorded: list[Any] = []

    class _Span:
        def set_output(self, value: object) -> None:
            del value

        def set_attribute(self, name: str, value: object) -> None:
            del name, value

        def mark_first_token(self) -> None:
            return None

        def set_usage(self, usage: Any) -> None:
            recorded.append(usage)

    class _Tracer:
        @contextmanager
        def span(self, name: str, **_: Any):  # type: ignore[no-untyped-def]
            yield _Span()

        @contextmanager
        def generation(self, name: str, **_: Any):  # type: ignore[no-untyped-def]
            yield _Span()

        def flush(self) -> None:
            return None

    usage = {
        "input_tokens": 3000,
        "input_tokens_details": {"cached_tokens": 2048, "cache_write_tokens": 0},
        "output_tokens": 7,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": 3007,
    }
    transport = ScriptedResponsesTransport(
        [
            [
                *created("resp_a"),
                *message(item_id="msg", output_index=0, deltas=["Hi."], phase="final_answer"),
                *completed("resp_a", usage=usage),
            ]
        ]
    )
    agent = Agent(
        model=transport,
        tools=ToolRegistry(),
        configuration=SessionConfiguration(max_model_turns=3, max_tool_rounds=2),
        tracer=_Tracer(),  # type: ignore[arg-type]
    )

    _ = [event async for event in agent.run("Hello", _context())]

    assert [entry.input_tokens_details.cached_tokens for entry in recorded] == [2048]
