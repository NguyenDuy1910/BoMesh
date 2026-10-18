"""Make one authorized resource available to the sandbox shell."""

from __future__ import annotations

from bomesh.agent.models import ToolResult
from bomesh.agent.tools import Tool, ToolInvocation, ToolSpec
from bomesh.services import ArtifactValidationError


class MaterializeSandboxResource(Tool):
    """Explicitly copy an accessible Item into the conversation's sandbox."""

    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="materialize_sandbox_resource",
            description=(
                "Copy an available file into the sandbox home directory (~) so "
                "run_shell commands can use it. Call it before shell work that "
                "needs the file, then use the exact path it returns. It does not "
                "read the file into the chat."
            ),
            input_schema={
                "type": "object",
                "properties": {"resource_id": {"type": "string", "minLength": 1}},
                "required": ["resource_id"],
                "additionalProperties": False,
            },
            activity_label="Prepare workspace file",
            requires_sandbox=True,
        )

    async def handle(self, invocation: ToolInvocation) -> ToolResult:
        resource_id = str(invocation.payload.arguments["resource_id"])
        resource = invocation.resource(resource_id)
        sandbox = invocation.session.sandbox
        if resource is None:
            return ToolResult(
                content="",
                error="Resource is not available in this turn.",
                metadata={"outcome": "not_found", "result_count": 0},
            )
        if sandbox is None:
            return ToolResult(
                content="",
                error="The sandbox is unavailable.",
                metadata={"outcome": "unavailable", "result_count": 0},
            )
        try:
            materialized = await sandbox.materialize_resource(resource)
        except ArtifactValidationError as exc:
            return ToolResult(
                content="",
                error=str(exc),
                metadata={"outcome": "invalid_input", "result_count": 0},
            )
        original, *copies = materialized.paths
        lines = [f"{materialized.resource.name} is in the sandbox at: {original}"]
        if copies:
            lines.append(
                "Each sheet is also available as CSV (all cells, header rows "
                "included): " + ", ".join(copies)
            )
        return ToolResult(
            content="\n".join(lines),
            metadata={"outcome": "success", "result_count": 1},
        )


__all__ = ["MaterializeSandboxResource"]
