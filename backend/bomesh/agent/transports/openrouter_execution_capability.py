"""OpenRouter hosted-execution capability metadata."""

from __future__ import annotations

from bomesh.agent.execution import ExecutionCapability

#: What the OpenRouter sandbox image offers, observed on the live container
#: (Ubuntu 22.04, Python 3.11). Without these facts models reach for
#: ``python``, ``openpyxl`` or ``pip install`` and burn a step on each.
OPENROUTER_SHELL_GUIDANCE = (
    "Commands run in /workspace/home, which is also ~, on Ubuntu with no "
    "internet access, so nothing can be installed. Use python3; there is no "
    "`python` command. pandas, numpy, matplotlib, beautifulsoup4 and pillow "
    "are installed; openpyxl and other Excel readers are not, so read a "
    "spreadsheet through the CSV copies its preparation lists. A file is in "
    "the shell only after the workspace-file preparation action has returned "
    "its path; use exactly that path. Files under ~ persist between steps and "
    "can be exported; files elsewhere, such as /tmp, are discarded."
)


class OpenRouterExecutionCapabilityResolver:
    """Expose OpenRouter's hosted features through a provider-neutral contract."""

    def resolve(
        self, *, provider: str, model: str | None
    ) -> ExecutionCapability:
        available = provider == "openrouter" and bool(model)
        return ExecutionCapability(
            provider=provider,
            model=model,
            hosted_shell=available,
            provider_files=available,
            persistent_environments=available,
            guidance=OPENROUTER_SHELL_GUIDANCE if available else None,
        )


__all__ = ["OPENROUTER_SHELL_GUIDANCE", "OpenRouterExecutionCapabilityResolver"]
