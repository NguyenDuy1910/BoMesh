"""Shared, framework-free contracts for the enterprise agent loop."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from bomesh.agent.protocol import InputContent, ToolCall
from bomesh.knowledge import Evidence


if TYPE_CHECKING:
    from bomesh.agent import ResourceRef


@dataclass(frozen=True, slots=True)
class ConversationMessage:
    """A prior answered turn loaded from the server-owned conversation."""

    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True, slots=True)
class AgentContext:
    """The authenticated scope for a single agent request.

    ``tenant_id`` is the workspace ID: citations name their passages
    ``workspaces/{tenant_id}/items/{item}/passages/{passage}``.
    ``collection_item_ids`` are the collection subtrees retrieval may search.
    ``workspace_instructions`` is the workspace's assistant guidance; it is
    static per workspace, so it stays part of the cached instruction prefix.
    """

    user_id: str
    tenant_id: str
    collection_item_ids: tuple[str, ...] = ()
    conversation_id: str | None = None
    request_id: str | None = None
    history: tuple[ConversationMessage, ...] = ()
    allowed_tool_names: tuple[str, ...] | None = None
    resources: tuple["ResourceRef", ...] = ()
    workspace_instructions: str = ""
    model_extra_body: Mapping[str, Any] | None = None


@dataclass(slots=True)
class CitationReferences:
    """Run-scoped reference IDs and reader-facing numbers for one turn.

    Retrieval order assigns the compact ``ref_N`` the model is allowed to cite,
    one per chunk, so the model can point at the exact passage. First
    appearance in the answer assigns the ``[n]`` the reader sees, one per
    *document*: several passages of one file are one source to a reader, so
    they share its number instead of listing the file once per passage. Both
    are scoped to one run and keyed by the identity they stand for, so they
    hold across retrieval rounds and concurrent tool calls without any
    process-wide state.
    """

    _references: dict[tuple[str, str], str] = field(default_factory=dict)
    _documents: dict[str, str] = field(default_factory=dict)
    _numbers: dict[str, int] = field(default_factory=dict)

    def reference(self, item_id: str, chunk_id: str) -> str:
        """Return this chunk's model-facing reference, assigning one if new."""

        identity = (item_id, chunk_id)
        existing = self._references.get(identity)
        if existing is not None:
            return existing
        assigned = f"ref_{len(self._references) + 1}"
        self._references[identity] = assigned
        self._documents[assigned] = item_id
        return assigned

    def document_ids(self) -> tuple[str, ...]:
        """Every document retrieval returned this turn, in first-retrieval order."""

        return tuple(dict.fromkeys(self._documents.values()))

    def number(self, reference: str) -> int:
        """Return the reader-facing number of a reference's document, by first use."""

        document = self._documents.get(reference, reference)
        existing = self._numbers.get(document)
        if existing is not None:
            return existing
        assigned = len(self._numbers) + 1
        self._numbers[document] = assigned
        return assigned


@dataclass(frozen=True, slots=True)
class ToolResult:
    """A tool result before the runtime binds it to a provider call ID."""

    content: str
    evidence: list[Evidence] = field(default_factory=list)
    error: str | None = None
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)
    model_content: tuple[InputContent, ...] = ()


# Existing tool implementations and integrations import this name. New code
# uses ToolResult, whose extra model_content channel supports explicit native
# multimodal materialization without smuggling it through a text observation.
ToolOutput = ToolResult


@dataclass(frozen=True, slots=True)
class ToolObservation:
    """One model invocation paired with the outcome observed by the runtime."""

    call: ToolCall
    result: ToolResult
    duration_ms: int

    @property
    def result_count(self) -> int | None:
        value = self.result.metadata.get("result_count")
        return value if isinstance(value, int) else None

    @property
    def status(self) -> Literal["completed", "failed", "timeout", "skipped"]:
        if not self.result.error:
            return "completed"
        outcome = self.result.metadata.get("outcome")
        if outcome == "timeout":
            return "timeout"
        if outcome in {"duplicate_call", "tool_call_limit"}:
            return "skipped"
        return "failed"

    @property
    def output(self) -> ToolResult:
        """Compatibility name for callers that have not moved to result yet."""

        return self.result


__all__ = [
    "AgentContext",
    "CitationReferences",
    "ConversationMessage",
    "Evidence",
    "ToolObservation",
    "ToolResult",
    "ToolOutput",
]
