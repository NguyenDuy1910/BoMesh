"""Request-scoped service adapters used exclusively by the agent runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from bomesh.agent.protocol import ProviderResourceRef
from bomesh.knowledge import Evidence

MAX_KNOWLEDGE_SEARCH_QUERY_CHARACTERS = 512


class SandboxProvider(Protocol):
    """The small provider boundary required by a hosted sandbox lifecycle."""

    provider: str

    async def upload_file(
        self, *, file_name: str, mime_type: str, data: bytes
    ) -> ProviderResourceRef: ...

    async def download_file(
        self, *, environment_id: str, file_id: str
    ) -> bytes: ...

    def workspace_path(self, *, file_id: str, file_name: str) -> str:
        """Where an uploaded file appears inside the shell's workspace."""
        ...

    async def find_file(
        self, *, environment_id: str, path: str
    ) -> ProviderResourceRef | None:
        """Look up a workspace file by its path relative to the home directory."""
        ...


@dataclass(frozen=True, slots=True)
class AgentKnowledgeSearchResult:
    """The bounded, citable outcome of one agent knowledge-search request."""

    content: str
    evidence: tuple[Evidence, ...] = ()
    error: str | None = None
    outcome: str = "success"
    success_criteria_met: bool | None = None
    duration_ms: int = 0
