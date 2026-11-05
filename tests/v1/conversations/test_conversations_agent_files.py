"""Files the agent exports carry the documents the turn read as their sources (review #12)."""

from __future__ import annotations

from typing import Any

import pytest

from bomesh.agent import (
    AttachmentInput,
    AttachmentRef,
    ContextManager,
    ResolvedStepSettings,
    ResourceRef,
    SandboxArtifact,
    Session,
    SessionConfiguration,
    SessionServices,
    TextInput,
    TurnContext,
    TurnEnvironmentSnapshot,
    UserTurn,
)
from bomesh.agent.models import AgentContext
from bomesh.agent.tools import ToolRegistry
from bomesh.agent.tools.export_sandbox_file import ExportSandboxFile
from bomesh.agent.turn import run_turn
from native_responses import ScriptedResponsesTransport, completed, created, function_call, message

pytestmark = pytest.mark.asyncio


class RecordingSandbox:
    guidance = "Commands run in /home/sandbox."

    def __init__(self) -> None:
        self.exports: list[dict[str, Any]] = []
        self.artifacts: tuple[SandboxArtifact, ...] = ()

    async def promote_file(
        self, file_name: str, *, summary: str, source_ids: tuple[str, ...]
    ) -> SandboxArtifact:
        self.exports.append({"file_name": file_name, "source_ids": source_ids})
        artifact = SandboxArtifact(
            id="00000000-0000-0000-0000-000000000044",
            title=file_name,
            name=file_name,
            mime_type="text/csv",
            revision=1,
            size_bytes=3,
            updated_at=None,
        )
        self.artifacts = (artifact,)
        return artifact


async def test_export_passes_retrieved_documents_and_attachments_as_sources() -> None:
    transport = ScriptedResponsesTransport(
        [
            [
                *created("resp_a"),
                *function_call(
                    item_id="fc_1",
                    output_index=0,
                    call_id="call_1",
                    name="export_sandbox_file",
                    argument_deltas=['{"file_name":"report.csv"}'],
                ),
                *completed("resp_a"),
            ],
            [
                *created("resp_b"),
                *message(item_id="msg_1", output_index=0, deltas=["Saved."], phase="final_answer"),
                *completed("resp_b"),
            ],
        ]
    )
    registry = ToolRegistry()
    registry.register(ExportSandboxFile())
    sandbox = RecordingSandbox()
    configuration = SessionConfiguration(max_model_turns=3, max_tool_rounds=2)
    session = Session(
        configuration,
        SessionServices(model=transport, tool_registry=registry, sandbox_runtime=sandbox),
        ContextManager(configuration=configuration),
    )
    attachment = ResourceRef(id="attached-doc", name="input.xlsx", mime_type="text/csv")
    user_turn = UserTurn(
        inputs=(
            TextInput(text="Summarize into a file"),
            AttachmentInput(attachment=AttachmentRef(resource=attachment)),
        )
    )
    settings = ResolvedStepSettings(
        model=None, temperature=None, max_output_tokens=None, parallel_tool_calls=True
    )
    turn = TurnContext(
        user_turn=user_turn,
        environment=TurnEnvironmentSnapshot(
            agent_context=AgentContext(user_id="user", tenant_id="tenant")
        ),
        initial_settings=settings,
        current_settings=settings,
        resources=(attachment,),
    )
    # Two passages of one document and one of another were retrieved earlier in the turn.
    turn.references.reference("retrieved-doc", "chunk-1")
    turn.references.reference("retrieved-doc", "chunk-2")
    turn.references.reference("other-doc", "chunk-9")

    [_ async for _ in run_turn(session, turn)]

    assert sandbox.exports == [
        {
            "file_name": "report.csv",
            "source_ids": ("retrieved-doc", "other-doc", "attached-doc"),
        }
    ]
