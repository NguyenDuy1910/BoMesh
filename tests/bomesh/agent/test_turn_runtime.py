"""Focused contracts for the session / turn / step runtime."""

from __future__ import annotations

import asyncio
import sys
from dataclasses import fields
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

_TESTS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_TESTS_ROOT))
sys.path.insert(0, str(_TESTS_ROOT.parent / "backend"))

from native_responses import ScriptedResponsesTransport, completed, created, function_call, message

from bomesh.agent import (
    ContextManager,
    ConversationState,
    AttachmentInput,
    AttachmentRef,
    ImageInput,
    ResourceRef,
    ResolvedStepSettings,
    SandboxArtifact,
    Session,
    SessionConfiguration,
    SessionServices,
    TextInput,
    TurnContext,
    TurnEnvironmentSnapshot,
    UserTurn,
)
from bomesh.agent.models import AgentContext, ConversationMessage, ToolOutput
from bomesh.connector.protocol import CitationInfo
from bomesh.agent.protocol import (
    FunctionCallItem,
    FunctionCallOutputItem,
    InputImage,
    InputText,
    ReasoningItem,
)
from bomesh.agent.tools import (
    ToolExecutor,
    ToolInvocation,
    ToolOrchestrator,
    ToolRegistry,
    ToolSpec,
)
from bomesh.agent.tools.read_resource import ReadResource
from bomesh.agent.tools.run_shell import RunShell
from bomesh.agent.turn import run_turn
from bomesh.knowledge import DocumentFacts, Evidence


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


class RecordingSession(Session):
    def __init__(self, *args: Any) -> None:
        super().__init__(*args)
        self.steps = []
        self.model_inputs = []

    async def capture_step_context(self, turn: TurnContext):
        step = await super().capture_step_context(turn)
        self.steps.append(step)
        return step

    def build_model_input(self, step_context):  # type: ignore[no-untyped-def]
        model_input = super().build_model_input(step_context)
        self.model_inputs.append(model_input)
        return model_input


def _context(*, allowed: tuple[str, ...] | None = ("knowledge_search",)) -> AgentContext:
    return AgentContext(user_id="user", tenant_id="tenant", allowed_tool_names=allowed)


def _turn(context: AgentContext, user_turn: UserTurn | None = None) -> TurnContext:
    settings = ResolvedStepSettings(
        model=None,
        temperature=None,
        max_output_tokens=None,
        parallel_tool_calls=True,
    )
    captured_input = user_turn or UserTurn(
        inputs=(TextInput(text="What is the leave policy?"),)
    )
    resources = list(captured_input.resources)
    known_ids = {resource.id for resource in resources}
    for resource in context.resources:
        if resource.id not in known_ids:
            known_ids.add(resource.id)
            resources.append(resource)
    return TurnContext(
        user_turn=captured_input,
        environment=TurnEnvironmentSnapshot(agent_context=context),
        initial_settings=settings,
        current_settings=settings,
        resources=tuple(resources),
    )


def _session(
    transport: ScriptedResponsesTransport,
    registry: ToolRegistry,
    resource_resolver: RecordingResourceResolver | None = None,
) -> RecordingSession:
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=2)
    return RecordingSession(
        configuration,
        SessionServices(
            model=transport,
            tool_registry=registry,
            resource_resolver=resource_resolver,
        ),
        ContextManager(configuration=configuration),
    )


class RecordingResourceResolver:
    def __init__(self) -> None:
        self.materialized: list[ResourceRef] = []
        self.read_resources: list[ResourceRef] = []

    async def inspect(self, resource: ResourceRef) -> dict[str, object]:
        return {"id": resource.id}

    async def read(self, resource: ResourceRef, *, max_characters: int) -> str:
        self.read_resources.append(resource)
        return "resource text"

    async def materialize(self, resource: ResourceRef):  # type: ignore[no-untyped-def]
        self.materialized.append(resource)
        return (InputImage(image_url=f"https://resource.test/{resource.id}"),)


@pytest.mark.asyncio
async def test_generic_attachment_stays_lazy_until_a_resource_tool_reads_it() -> None:
    configuration = SessionConfiguration()
    manager = ContextManager(configuration=configuration)
    resolver = RecordingResourceResolver()
    file = ResourceRef(
        id="file-1", name="plan.pdf", mime_type="application/pdf", size_bytes=12
    )

    turn = _turn(
        _context(),
        UserTurn(
            inputs=(
                TextInput(text="Review this plan"),
                AttachmentInput(attachment=AttachmentRef(resource=file)),
            )
        ),
    )
    conversation = ConversationState()
    await manager.start_turn(conversation, turn, resolver)

    assert resolver.materialized == []
    assert conversation.items[-1].content == (InputText(text="Review this plan"),)


@pytest.mark.asyncio
async def test_image_input_materializes_as_native_model_content() -> None:
    configuration = SessionConfiguration()
    manager = ContextManager(configuration=configuration)
    resolver = RecordingResourceResolver()
    image = ResourceRef(id="image-1", name="chart.png", mime_type="image/png")

    turn = _turn(
        _context(),
        UserTurn(inputs=(TextInput(text="What does this chart show?"), ImageInput(image))),
    )
    conversation = ConversationState()
    await manager.start_turn(conversation, turn, resolver)

    assert resolver.materialized == [image]
    assert conversation.items[-1].content == (
        InputText(text="What does this chart show?"),
        InputImage(image_url="https://resource.test/image-1"),
    )


@pytest.mark.asyncio
async def test_context_manager_replays_a_plain_recency_window_in_order() -> None:
    """No relevance filter: a follow-up keeps what "it" refers to."""

    configuration = SessionConfiguration(max_history_messages=5)
    manager = ContextManager(configuration=configuration)
    context = AgentContext(
        user_id="user",
        tenant_id="tenant",
        history=(
            ConversationMessage(role="user", content="Oldest question."),
            ConversationMessage(role="assistant", content="Oldest answer."),
            ConversationMessage(role="user", content="Chính sách nghỉ phép là gì?"),
            ConversationMessage(role="assistant", content="Nhân viên có 20 ngày phép."),
            ConversationMessage(role="user", content="Discuss the office party."),
            ConversationMessage(role="assistant", content="The party is on Friday."),
        ),
    )

    turn = _turn(context, UserTurn(inputs=(TextInput(text="Can it carry over?"),)))
    conversation = ConversationState()
    await manager.start_turn(conversation, turn, RecordingResourceResolver())

    assert [
        (item.role, item.content[0].text) for item in conversation.items
    ] == [
        # The window starts at a user message; the orphaned answer is dropped.
        ("user", "Chính sách nghỉ phép là gì?"),
        ("assistant", "Nhân viên có 20 ngày phép."),
        ("user", "Discuss the office party."),
        ("assistant", "The party is on Friday."),
        ("user", "Can it carry over?"),
    ]


@pytest.mark.asyncio
async def test_generic_resource_is_read_only_after_the_model_calls_a_tool() -> None:
    file = ResourceRef(id="file-1", name="plan.txt", mime_type="text/plain")
    resolver = RecordingResourceResolver()
    transport = ScriptedResponsesTransport(
        [
            [
                *created("resp_a"),
                *function_call(
                    item_id="fc_1",
                    output_index=0,
                    call_id="call_1",
                    name="read_resource",
                    argument_deltas=['{"resource_id":"file-1"}'],
                ),
                *completed("resp_a"),
            ],
            [
                *created("resp_b"),
                *message(item_id="msg_1", output_index=0, deltas=["Reviewed."], phase="final_answer"),
                *completed("resp_b"),
            ],
        ]
    )
    registry = ToolRegistry()
    registry.register(ReadResource())
    session = _session(transport, registry, resolver)
    turn = _turn(
        _context(allowed=("read_resource",)),
        UserTurn(
            inputs=(
                TextInput(text="Review the plan"),
                AttachmentInput(attachment=AttachmentRef(resource=file)),
            )
        ),
    )

    events = [event async for event in run_turn(session, turn)]

    assert resolver.read_resources == [file]
    # Resources are per-turn context: a developer message right before the
    # user's message, never part of the static instructions.
    assert "<resource_id>" not in transport.requests[0]["instructions"]
    assert transport.requests[0]["input"][-2]["role"] == "developer"
    assert "<resource_id>file-1</resource_id>" in transport.requests[0]["input"][-2]["content"]
    output = next(
        event.item
        for event in events
        if event.type == "response.output_item.done"
        and event.item.type == "function_call_output"
    )
    assert output.output == "resource text"


@pytest.mark.asyncio
async def test_turn_recaptures_step_and_returns_to_model_after_a_tool() -> None:
    transport = ScriptedResponsesTransport(
        [
            [
                *created("resp_a"),
                *function_call(
                    item_id="fc_1",
                    output_index=0,
                    call_id="call_1",
                    name="knowledge_search",
                    argument_deltas=['{"query":"leave"}'],
                ),
                *completed("resp_a"),
            ],
            [
                *created("resp_b"),
                *message(item_id="msg_1", output_index=0, deltas=["Leave is 20 days."], phase="final_answer"),
                *completed("resp_b"),
            ],
        ]
    )
    lookup = Lookup()
    registry = ToolRegistry()
    registry.register(lookup)
    session = _session(transport, registry)

    events = [event async for event in run_turn(session, _turn(_context()))]

    assert len(session.steps) == 2
    assert session.steps[0] is not session.steps[1]
    assert lookup.invocations[0].step_context is session.steps[0]
    assert transport.requests[1]["input"][-1]["type"] == "function_call_output"
    tool_output = next(
        event.item
        for event in events
        if event.type == "response.output_item.done"
        and event.item.type == "function_call_output"
    )
    assert tool_output.output == "found leave"
    activities = [
        event for event in events if event.type in {"tool_started", "tool_completed"}
    ]
    assert [event.type for event in activities] == ["tool_started", "tool_completed"]
    assert activities[0].call_id == "call_1"
    assert activities[0].tool_name == "knowledge_search"
    assert activities[1].status == "completed"
    assert events[-1].type == "response.completed"


class FindingLookup(Lookup):
    """A search whose evidence spans documents, one of them twice (its best passage first)."""

    async def handle(self, invocation: ToolInvocation) -> ToolOutput:
        facts = DocumentFacts(mime_type="application/pdf", file_name="leave.pdf", updated_at=datetime(2026, 11, 1, tzinfo=UTC), collection_title="HR")
        hits = [("doc-a", "c1", "Leave policy", 4, "Employees  get\n20 days " + "of leave " * 40), ("doc-b", "c2", "Handbook", None, "Welcome."), ("doc-a", "c3", "Leave policy", 9, "Carry-over.")]
        return ToolOutput(
            content="found",
            evidence=[
                Evidence(id=chunk, item_id=item, chunk_id=chunk, title=title, content=text, citation=CitationInfo(page_start=page), document=facts if item == "doc-a" else None)
                for item, chunk, title, page, text in hits
            ],
        )


@pytest.mark.asyncio
async def test_a_finished_search_reports_the_documents_it_found_before_the_answer() -> None:
    transport = ScriptedResponsesTransport(
        [
            [*created("resp_a"), *function_call(item_id="fc_1", output_index=0, call_id="call_1", name="knowledge_search", argument_deltas=['{"query":"leave"}']), *completed("resp_a")],
            [*created("resp_b"), *message(item_id="msg_1", output_index=0, deltas=["Leave is 20 days."], phase="final_answer"), *completed("resp_b")],
        ]
    )
    registry = ToolRegistry()
    registry.register(FindingLookup())

    events = [event async for event in run_turn(_session(transport, registry), _turn(_context()))]

    done = next(event for event in events if event.type == "tool_completed")
    a, b = done.sources
    assert (a.item, a.title, a.mime_type, a.file_name, a.collection, a.update_time, a.page) == (
        "workspaces/tenant/items/doc-a", "Leave policy", "application/pdf", "leave.pdf", "HR", "2026-11-01T00:00:00+00:00", 4,
    )
    assert a.passages == ["workspaces/tenant/items/doc-a/passages/c1", "workspaces/tenant/items/doc-a/passages/c3"]
    # One line, cut on a word, short enough for a card.
    assert a.excerpt.startswith("Employees get 20 days of leave") and a.excerpt.endswith("…") and len(a.excerpt) <= 221
    assert (b.item, b.excerpt, b.page, b.collection) == ("workspaces/tenant/items/doc-b", "Welcome.", None, None)
    # Facts, not metrics.
    assert set(done.model_dump(exclude_none=True)) == {"type", "sequence_number", "call_id", "tool_name", "status", "sources"}
    first_text = next(i for i, event in enumerate(events) if event.type == "response.output_text.delta")
    assert events.index(done) < first_text


@pytest.mark.asyncio
async def test_step_context_is_immutable_and_model_input_is_materialized_per_step() -> None:
    file = ResourceRef(id="file-1", name="plan.txt", mime_type="text/plain")
    transport = ScriptedResponsesTransport(
        [
            [
                *created("resp_a"),
                *function_call(
                    item_id="fc_1",
                    output_index=0,
                    call_id="call_1",
                    name="read_resource",
                    argument_deltas=['{"resource_id":"file-1"}'],
                ),
                *completed("resp_a"),
            ],
            [
                *created("resp_b"),
                *message(item_id="msg_1", output_index=0, deltas=["Done."], phase="final_answer"),
                *completed("resp_b"),
            ],
        ]
    )
    registry = ToolRegistry()
    registry.register(ReadResource())
    session = _session(transport, registry, RecordingResourceResolver())
    turn = _turn(
        _context(allowed=("read_resource",)),
        UserTurn(
            inputs=(
                TextInput(text="Review this plan"),
                AttachmentInput(attachment=AttachmentRef(resource=file)),
            )
        ),
    )

    _ = [event async for event in run_turn(session, turn)]

    first, second = session.steps
    assert tuple(field.name for field in fields(first)) == (
        "turn_id",
        "step_index",
        "settings",
        "sandbox_guidance",
        "resources",
        "tool_names",
        "workspace_instructions",
        "tools_enabled",
    )
    assert first.turn_id == turn.id
    assert first.step_index == 1
    assert first.resources == (file,)
    assert first.tool_names == ("read_resource",)
    assert first.sandbox_guidance is None
    assert first.tools_enabled is True
    first_input, second_input = session.model_inputs
    assert first_input.input_items[-1].role == "user"
    assert first_input.input_items[-2].role == "developer"
    assert "<resource_id>file-1</resource_id>" in first_input.input_items[-2].content[0].text
    assert first_input.instructions == second_input.instructions
    assert "<resource_id>" not in first_input.instructions
    assert len(second_input.input_items) > len(first_input.input_items)
    assert second_input.input_items[-1].type == "function_call_output"


@pytest.mark.asyncio
async def test_step_router_is_captured_from_current_turn_visibility() -> None:
    transport = ScriptedResponsesTransport([])
    registry = ToolRegistry()
    registry.register(Lookup())
    session = _session(transport, registry)
    turn = _turn(_context())

    first = await session.capture_step_context(turn)
    turn.environment = TurnEnvironmentSnapshot(agent_context=_context(allowed=()))
    second = await session.capture_step_context(turn)

    assert first.tool_names == ("knowledge_search",)
    assert second.tool_names == ()


@pytest.mark.asyncio
async def test_step_selects_only_explicit_or_user_relevant_resources() -> None:
    relevant = ResourceRef(
        id="leave-policy", name="Leave policy.pdf", mime_type="application/pdf"
    )
    unrelated = ResourceRef(
        id="travel-policy", name="Travel policy.pdf", mime_type="application/pdf"
    )
    context = AgentContext(
        user_id="user",
        tenant_id="tenant",
        resources=(relevant, unrelated),
    )
    session = _session(ScriptedResponsesTransport([]), ToolRegistry())
    turn = _turn(
        context, UserTurn(inputs=(TextInput(text="Review leave-policy"),))
    )

    step = await session.capture_step_context(turn)

    model_input = session.build_model_input(step)
    resource_context = model_input.input_items[-2].content[0].text
    assert "<resource_id>leave-policy</resource_id>" in resource_context
    assert "<resource_id>travel-policy</resource_id>" not in resource_context
    assert "<resource_id>" not in model_input.instructions
    assert step.resources == (relevant,)


@pytest.mark.asyncio
async def test_model_input_keeps_reasoning_required_by_a_retained_function_call() -> None:
    session = _session(ScriptedResponsesTransport([]), ToolRegistry())
    turn = _turn(_context())
    await session.capture_step_context(turn)
    reasoning = ReasoningItem(id="rs_1", encrypted_content="x" * 20_000)
    call = FunctionCallItem(
        id="fc_1",
        call_id="call_1",
        name="knowledge_search",
        arguments='{"query":"leave"}',
    )
    output = FunctionCallOutputItem(call_id="call_1", output="found leave")
    session.record((reasoning, call, output))

    step = await session.capture_step_context(turn)
    model_input = session.build_model_input(step)

    assert model_input.input_items[-3:] == (reasoning, call, output)


class _ExportedFiles:
    """A request workspace that already exported one file in this turn."""

    guidance = "Commands run in /home/sandbox."

    def __init__(self, *artifacts: SandboxArtifact) -> None:
        self.artifacts = artifacts


@pytest.mark.asyncio
async def test_sandbox_guidance_is_static_and_run_shell_needs_a_sandbox() -> None:
    registry = ToolRegistry()
    registry.register(Lookup())
    registry.register(RunShell(max_timeout_seconds=60, max_result_characters=12_000))
    context = _context(allowed=None)
    without = _session(ScriptedResponsesTransport([]), registry)
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=2)
    with_sandbox = RecordingSession(
        configuration,
        SessionServices(
            model=ScriptedResponsesTransport([]),
            tool_registry=registry,
            sandbox_runtime=_ExportedFiles(),
        ),
        ContextManager(configuration=configuration),
    )

    plain = await without.capture_step_context(_turn(context))
    turn = _turn(context)
    first = await with_sandbox.capture_step_context(turn)
    second = await with_sandbox.capture_step_context(turn)

    assert plain.tool_names == ("knowledge_search",)
    assert plain.sandbox_guidance is None
    assert "<sandbox>" not in without.build_model_input(plain).instructions
    assert set(first.tool_names) == {"knowledge_search", "run_shell"}
    instructions = with_sandbox.build_model_input(first).instructions
    assert "<sandbox>Commands run in /home/sandbox.</sandbox>" in instructions
    # A cache-stable prefix: the same instructions on every step.
    assert with_sandbox.build_model_input(second).instructions == instructions


@pytest.mark.asyncio
async def test_a_saved_file_is_attached_once_to_the_answer_that_presents_it() -> None:
    """Restored conversations rebuild file cards from this annotation alone."""

    report = SandboxArtifact(
        id=str(UUID(int=44)), title="report.xlsx", name="report.xlsx",
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        revision=2, size_bytes=1900, updated_at="2026-10-04T00:00:00Z",
    )
    transport = ScriptedResponsesTransport(
        [
            [
                *created("resp_a"),
                *message(item_id="msg_1", output_index=0, deltas=["Saved the report."], phase="commentary"),
                *function_call(
                    item_id="fc_1", output_index=1, call_id="call_1",
                    name="knowledge_search", argument_deltas=['{"query":"leave"}'],
                ),
                *completed("resp_a"),
            ],
            [
                *created("resp_b"),
                *message(item_id="msg_2", output_index=0, deltas=["Here it is."], phase="final_answer"),
                *completed("resp_b"),
            ],
        ]
    )
    registry = ToolRegistry()
    registry.register(Lookup())
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=2)
    session = RecordingSession(
        configuration,
        SessionServices(model=transport, tool_registry=registry, sandbox_runtime=_ExportedFiles(report)),
        ContextManager(configuration=configuration),
    )

    events = [event async for event in run_turn(session, _turn(_context()))]

    messages = [
        event.item for event in events
        if event.type == "response.output_item.done" and event.item.type == "message"
    ]
    artifact_annotations = [
        [annotation for annotation in item.content[0].annotations if annotation["type"] == "bomesh:artifact"]
        for item in messages
    ]
    end = len("Saved the report.")
    assert artifact_annotations == [
        [{
            "type": "bomesh:artifact",
            "start_index": end,
            "end_index": end,
            "artifact": report.reference(),
        }],
        [],
    ]


class SlowTool(Lookup):
    """A tool that outruns the session budget but declares its own."""

    def __init__(self, *, declared: float | None) -> None:
        super().__init__()
        self._declared = declared

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
            timeout_seconds=self._declared,
        )

    async def handle(self, invocation: ToolInvocation) -> ToolOutput:
        await asyncio.sleep(0.15)
        return await super().handle(invocation)


async def _run_slow_tool(declared: float | None) -> str:
    transport = ScriptedResponsesTransport([])
    registry = ToolRegistry()
    registry.register(SlowTool(declared=declared))
    session = _session(transport, registry)
    turn = _turn(_context())
    step = await session.capture_step_context(turn)
    batch = await ToolOrchestrator(
        timeout_seconds=0.05,
        max_output_characters=1_000,
    ).execute(
        (FunctionCallItem(call_id="call_1", name="knowledge_search", arguments='{"query":"leave"}'),),
        session=session,
        turn=turn,
        step_context=step,
        tool_router=session.tool_router(step),
        resources=step.resources,
        remaining_calls=1,
    )
    return batch.output_items[0].output


@pytest.mark.asyncio
async def test_a_tool_declaring_its_own_budget_outlives_the_session_timeout() -> None:
    """A slow tool with its own budget must not be cancelled by the shared budget."""

    assert await _run_slow_tool(declared=5.0) == "found leave"


@pytest.mark.asyncio
async def test_a_tool_without_its_own_budget_still_uses_the_session_timeout() -> None:
    assert await _run_slow_tool(declared=None) == "Tool error: Tool execution timed out."


@pytest.mark.asyncio
async def test_hidden_tool_call_is_rejected_by_the_originating_step_router() -> None:
    transport = ScriptedResponsesTransport([])
    lookup = Lookup()
    registry = ToolRegistry()
    registry.register(lookup)
    session = _session(transport, registry)
    turn = _turn(_context(allowed=()))
    step = await session.capture_step_context(turn)

    batch = await ToolOrchestrator(
        timeout_seconds=1,
        max_output_characters=1_000,
    ).execute(
        (FunctionCallItem(call_id="call_1", name="knowledge_search", arguments='{"query":"leave"}'),),
        session=session,
        turn=turn,
        step_context=step,
        tool_router=session.tool_router(step),
        resources=step.resources,
        remaining_calls=1,
    )

    assert lookup.invocations == []
    assert batch.executed_call_count == 0
    assert batch.output_items[0].output == "Tool error: Tool is not exposed for this sampling step."
