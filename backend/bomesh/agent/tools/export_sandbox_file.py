"""Promote a sandbox file into a durable conversation artifact."""

from __future__ import annotations

from bomesh.agent.models import ToolResult
from bomesh.agent.tools import Tool, ToolInvocation, ToolSpec
from bomesh.services import ArtifactValidationError


class ExportSandboxFile(Tool):
    """Export a sandbox output only when the agent deliberately requests it."""

    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="export_sandbox_file",
            description=(
                "Save one file from the sandbox as a durable conversation "
                "artifact the user can download. Use it only for a useful final or "
                "intermediate deliverable. file_name is the file's path relative "
                "to ~ (for example report.xlsx or out/chart.png)."
            ),
            input_schema={
                "type": "object",
                "properties": {"file_name": {"type": "string", "minLength": 1}},
                "required": ["file_name"],
                "additionalProperties": False,
            },
            activity_label="Save workspace file",
            requires_sandbox=True,
        )

    async def handle(self, invocation: ToolInvocation) -> ToolResult:
        sandbox = invocation.session.sandbox
        if sandbox is None:
            return ToolResult(
                content="",
                error="The sandbox is unavailable.",
                metadata={"outcome": "unavailable", "result_count": 0},
            )
        try:
            artifact = await sandbox.promote_file(
                str(invocation.payload.arguments["file_name"]),
                summary="Exported from the conversation sandbox.",
            )
        except ArtifactValidationError as exc:
            return ToolResult(
                content="",
                error=str(exc),
                metadata={"outcome": "invalid_input", "result_count": 0},
            )
        await invocation.report_progress("artifact", {"artifact": artifact.reference()})
        return ToolResult(
            content=(
                f"Saved {artifact.name} as a conversation artifact (revision "
                f"{artifact.revision}). The user already sees it as a download "
                "card in this chat; refer to it by name, without a link or path."
            ),
            metadata={"outcome": "success", "result_count": 1},
        )


__all__ = ["ExportSandboxFile"]
