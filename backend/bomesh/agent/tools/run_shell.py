"""Run shell commands in the conversation's private sandbox."""

from __future__ import annotations

import json

from bomesh.agent import ShellRun
from bomesh.agent.execution import MAX_SHELL_COMMANDS
from bomesh.agent.models import ToolResult
from bomesh.agent.tools import Tool, ToolInvocation, ToolSpec

_MAX_COMMAND_CHARACTERS = 20_000


class RunShell(Tool):
    """Execute a short command batch; results return as one JSON observation.

    The output is the canonical shell record for the model and the clients:
    ``{"results": [{"exit_code", "timed_out", "stdout", "stderr"}, ...],
    "changed_files": [...]}`` with ``results`` aligned to the call's
    ``commands``.
    """

    def __init__(self, *, max_timeout_seconds: int, max_result_characters: int) -> None:
        if max_timeout_seconds < 1 or max_result_characters < 500:
            raise ValueError("run_shell limits are invalid")
        self._max_timeout_seconds = max_timeout_seconds
        self._max_result_characters = max_result_characters

    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="run_shell",
            description=(
                "Run 1-5 bash commands, in order, in this conversation's private "
                "sandbox (working directory ~). Use it to compute, transform or "
                "chart data and to create files. Each result reports exit_code, "
                "timed_out, stdout and stderr; long output is truncated."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "commands": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": _MAX_COMMAND_CHARACTERS,
                        },
                        "minItems": 1,
                        "maxItems": MAX_SHELL_COMMANDS,
                    },
                    "timeout_seconds": {
                        "type": ["integer", "null"],
                        "description": (
                            "Per-command limit in seconds, at most "
                            f"{self._max_timeout_seconds}; null uses the default."
                        ),
                    },
                },
                "required": ["commands", "timeout_seconds"],
                "additionalProperties": False,
            },
            activity_label="Run code",
            requires_sandbox=True,
            # Commands run one after another; the batch may use every timeout.
            timeout_seconds=float(
                MAX_SHELL_COMMANDS * (self._max_timeout_seconds + 5) + 30
            ),
        )

    async def handle(self, invocation: ToolInvocation) -> ToolResult:
        sandbox = invocation.session.sandbox
        if sandbox is None:
            return ToolResult(
                content="",
                error="The sandbox is unavailable.",
                metadata={"outcome": "unavailable", "result_count": 0},
            )
        arguments = invocation.payload.arguments
        commands = tuple(str(command) for command in arguments["commands"])
        requested = arguments.get("timeout_seconds")
        timeout = (
            max(1, min(int(requested), self._max_timeout_seconds))
            if isinstance(requested, int) and not isinstance(requested, bool)
            else None
        )
        run = await sandbox.run_commands(commands, timeout_seconds=timeout)
        return ToolResult(
            content=_render(run, self._max_result_characters),
            metadata={
                "outcome": "failed" if run.failed else "success",
                "result_count": len(run.results),
            },
        )


def _render(run: ShellRun, max_characters: int) -> str:
    """Serialize the run, shrinking outputs until the JSON fits the budget."""

    payload = run.payload()
    rendered = json.dumps(payload, ensure_ascii=False)
    while len(rendered) > max_characters:
        streams = [
            (result, key)
            for result in payload["results"]
            for key in ("stdout", "stderr")
            if result[key]
        ]
        if not streams:
            break
        overflow = len(rendered) - max_characters
        cut = overflow // len(streams) + 64
        for result, key in streams:
            text = result[key]
            keep = max(0, len(text) - cut)
            result[key] = (
                f"{text[: keep // 2]}\n…[truncated]…\n{text[len(text) - keep // 2 :]}"
                if keep
                else "…[truncated]…"
            )
        shrunk = json.dumps(payload, ensure_ascii=False)
        if len(shrunk) >= len(rendered):
            break
        rendered = shrunk
    return rendered


__all__ = ["RunShell"]
