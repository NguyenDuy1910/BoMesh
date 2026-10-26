"""Provider-neutral contracts for commands run in a conversation sandbox."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Commands one ``run_shell`` call may carry.
MAX_SHELL_COMMANDS = 5


@dataclass(frozen=True, slots=True)
class ShellCommandResult:
    """The bounded outcome of one command run in the sandbox shell."""

    command: str
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool = False

    def __post_init__(self) -> None:
        if self.timed_out and self.exit_code is not None:
            raise ValueError("a timed-out command cannot have an exit code")
        if not self.timed_out and self.exit_code is None:
            raise ValueError("a finished command needs an exit code")

    def payload(self) -> dict[str, Any]:
        # The command is already in the model's call; results align by index.
        return {
            "exit_code": self.exit_code,
            "timed_out": self.timed_out,
            "stdout": self.stdout,
            "stderr": self.stderr,
        }


@dataclass(frozen=True, slots=True)
class ShellRun:
    """One ``run_shell`` batch: every command result and the files it changed."""

    results: tuple[ShellCommandResult, ...]
    # Home-relative paths of regular files written during the batch.
    changed_files: tuple[str, ...] = ()

    @property
    def failed(self) -> bool:
        return any(result.timed_out or result.exit_code != 0 for result in self.results)

    def payload(self) -> dict[str, Any]:
        """The function-call output shared by the model and the clients."""

        return {
            "results": [result.payload() for result in self.results],
            "changed_files": list(self.changed_files),
        }


__all__ = ["MAX_SHELL_COMMANDS", "ShellCommandResult", "ShellRun"]
