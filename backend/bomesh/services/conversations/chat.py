"""Run one grounded chat turn and stream it as one OpenResponses response.

The agent samples the model once per step (a tool round is a step), and every
step is its own provider response. A conversation turn is one reply, so the
stream the client sees is folded into a single response: one
``response.created`` naming the assistant message, the steps' output items,
text deltas, annotations and tool activity with output indexes continuing
across steps, and one terminal event sent after the message is stored:

- ``response.completed``: stored with state ``completed``;
- ``response.incomplete``: the model stopped early; stored ``interrupted``;
- ``response.failed``: stored ``failed``; ``error`` is a ``google.rpc.Status``.

A client that goes away stores the partial answer as ``interrupted``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

import anyio

from bomesh.agent import (
    Agent,
    AgentStreamEvent,
    AttachmentInput,
    AttachmentRef,
    ImageInput,
    ResourceRef,
    ResourceResolver,
    SandboxRuntime,
    TextInput,
    UserTurn,
)
from bomesh.agent.citation_stream import parse_passage_name
from bomesh.agent.models import AgentContext
from bomesh.agent.protocol import (
    DOCUMENT_CITATION_TYPE,
    ErrorEvent,
    IncompleteDetails,
    Item,
    Response,
    ResponseCompletedEvent,
    ResponseCreatedEvent,
    ResponseError,
    ResponseFailedEvent,
    ResponseIncompleteEvent,
    ResponseInProgressEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputTextDeltaEvent,
    ResponseQueuedEvent,
    ResponseStatus,
)
from bomesh.db.engine import SessionFactory
from bomesh.errors import (
    Internal,
    InvalidArgument,
    ServiceError,
    Unavailable,
    rpc_status,
)
from bomesh.iam import WorkspaceAccess
from bomesh.services.conversations.turn_store import (
    ConversationService,
    GenerationState,
)

_RESOURCE_TOOL_NAMES = frozenset(
    {
        "inspect_resource",
        "read_resource",
        "materialize_resource",
        "materialize_sandbox_resource",
    }
)
_SANDBOX_TOOL_NAMES = frozenset(
    {"run_shell", "materialize_sandbox_resource", "export_sandbox_file"}
)
_STEP_START_EVENTS = (ResponseCreatedEvent, ResponseQueuedEvent, ResponseInProgressEvent)

_log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TurnRequest:
    """One authorized turn: everything below was checked by the caller.

    ``collection_ids`` are the collection subtrees retrieval may search (the
    conversation scope, or every readable collection when it has none).
    ``message_id`` is the assistant message the turn will store; ``metadata``
    is reported on the response (conversation and message names).
    """

    conversation_id: UUID
    message_id: UUID
    text: str
    attachment_ids: tuple[UUID, ...]
    replace_from: UUID | None
    collection_ids: tuple[UUID, ...]
    workspace_instructions: str
    file_work: bool
    metadata: dict[str, str] = field(default_factory=dict)


class TurnFailedEvent(ResponseFailedEvent):
    """``response.failed`` of a turn; ``error`` is the failure's ``google.rpc.Status``."""

    error: dict[str, Any]


class ChatService:
    """Load a turn's context, stream the agent, and persist the exchange."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        agent: Agent,
        conversations: ConversationService,
        resource_resolver: Callable[[WorkspaceAccess], ResourceResolver] | None = None,
        sandbox_runtime: Callable[[WorkspaceAccess, UUID], SandboxRuntime | None]
        | None = None,
    ) -> None:
        self._sessions = session_factory
        self._agent = agent
        self._conversations = conversations
        self._resource_resolver = resource_resolver
        self._sandbox_runtime = sandbox_runtime

    async def stream_turn(
        self,
        access: WorkspaceAccess,
        turn: TurnRequest,
        *,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[AgentStreamEvent]:
        """Store the user message, then return the turn's event stream.

        The server owns history: earlier answered turns come from storage.
        ``turn.replace_from`` names the user message a retry or edit
        replaces; history and referenced resources stop before it and
        ``start_turn`` supersedes it and everything after it.
        """

        # Independent reads, each in its own transaction: run them together.
        referenced, attachments, history = await _gather(
            self._conversations.referenced_resources(
                turn.conversation_id, access=access, before_message=turn.replace_from
            ),
            self._conversations.resources(turn.attachment_ids, access=access),
            self._conversations.history(
                turn.conversation_id,
                limit_messages=self._agent.configuration.max_history_messages,
                before_message=turn.replace_from,
            ),
        )
        request_id = uuid4().hex
        has_resources = bool(attachments or referenced)
        context = AgentContext(
            user_id=str(access.user_id),
            tenant_id=str(access.workspace_id),
            collection_item_ids=tuple(str(value) for value in turn.collection_ids),
            conversation_id=str(turn.conversation_id),
            request_id=request_id,
            history=history,
            allowed_tool_names=self._tool_names(
                resources_available=has_resources, file_work=turn.file_work
            ),
            resources=referenced,
            workspace_instructions=turn.workspace_instructions,
        )
        question = await self._conversations.start_turn(
            turn.conversation_id,
            access=access,
            content=turn.text,
            attachment_ids=turn.attachment_ids,
            request_id=request_id,
            replace_from=turn.replace_from,
        )
        sandbox = (
            self._sandbox_runtime(access, turn.conversation_id)
            if self._sandbox_runtime is not None and turn.file_work
            else None
        )
        resolver = (
            self._resource_resolver(access)
            if self._resource_resolver is not None and has_resources
            else None
        )
        events = self._agent.run(
            _user_turn(turn.text, attachments),
            context,
            resource_resolver=resolver,
            sandbox_runtime=sandbox,
        )
        return self._fold(
            events,
            _Turn(access=access, request=turn, question_id=question.id, request_id=request_id),
            sandbox=sandbox,
            is_disconnected=is_disconnected,
        )

    async def _fold(
        self,
        events: AsyncIterator[AgentStreamEvent],
        turn: _Turn,
        *,
        sandbox: SandboxRuntime | None,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[AgentStreamEvent]:
        reply = _Reply(turn.request)
        yield reply.created()
        try:
            async for event in events:
                if await is_disconnected():
                    break
                forwarded = reply.accept(event)
                if forwarded is not None:
                    yield forwarded
            else:
                reply.finish()
        except Exception:  # noqa: BLE001 - a broken turn is stored and reported as failed
            _log.exception("chat turn failed: conversation=%s", turn.request.conversation_id)
            reply.fail(Internal("The assistant failed.", reason="AGENT_EXECUTION_FAILED"))
        finally:
            await events.aclose()
            # Persist even when the client went away: the stored message is
            # the record of the turn, so cancellation must not skip it.
            with anyio.CancelScope(shield=True):
                await self._store(turn, reply, sandbox)
        yield reply.terminal()

    async def _store(self, turn: _Turn, reply: _Reply, sandbox: SandboxRuntime | None) -> None:
        await self._conversations.finish_turn(
            turn.request.conversation_id,
            access=turn.access,
            question_id=turn.question_id,
            message_id=turn.request.message_id,
            content=reply.text,
            state=reply.state,
            citations=reply.citations,
            artifact_ids=_artifact_ids(sandbox),
            request_id=turn.request_id,
        )

    def _tool_names(self, *, resources_available: bool, file_work: bool) -> tuple[str, ...]:
        """The registered chat tools this turn may use.

        Resource tools need a resource; the sandbox tools need the
        workspace's file-work capability.
        """

        return tuple(
            name
            for name, _ in self._agent.tools.executors()
            if (resources_available or name not in _RESOURCE_TOOL_NAMES)
            and (file_work or name not in _SANDBOX_TOOL_NAMES)
        )


@dataclass(frozen=True, slots=True)
class _Turn:
    access: WorkspaceAccess
    request: TurnRequest
    question_id: UUID
    request_id: str


class _Reply:
    """Fold the agent's per-step responses into the turn's single response."""

    def __init__(self, request: TurnRequest) -> None:
        self._response_id = f"resp_{request.message_id.hex}"
        self._metadata = dict(request.metadata)
        self._sequence = 0
        self._offset = 0
        self._step_items = 0
        self._output: list[Item] = []
        self._partial: list[str] = []
        self._answer = ""
        self._annotations: tuple[Any, ...] = ()
        self._finished = False
        self._failure: ServiceError | None = None
        self._incomplete: str | None = None

    @property
    def state(self) -> GenerationState:
        if self._failure is not None:
            return "failed"
        if self._finished and self._answer:
            return "completed"
        return "interrupted"

    @property
    def text(self) -> str:
        return self._answer if self.state == "completed" else "".join(self._partial)

    @property
    def citations(self) -> list[dict[str, Any]]:
        """The passages the stored answer cites, once each, in citation order."""

        if self.state != "completed":
            return []
        stored: dict[tuple[str, str], dict[str, Any]] = {}
        for annotation in self._annotations:
            citation = annotation.get("citation")
            if annotation.get("type") != DOCUMENT_CITATION_TYPE or not isinstance(citation, dict):
                continue
            item_id, chunk_id = parse_passage_name(str(citation["passage"]))
            page = citation.get("page_start")
            stored.setdefault(
                (item_id, chunk_id),
                {
                    "item_id": item_id,
                    "chunk_id": chunk_id,
                    "page": page if isinstance(page, int) else None,
                    "title": str(citation.get("title") or ""),
                    "excerpt": citation.get("excerpt"),
                },
            )
        return list(stored.values())

    def created(self) -> AgentStreamEvent:
        return self._stamp(ResponseCreatedEvent(response=self._response("in_progress")))

    def accept(self, event: AgentStreamEvent) -> AgentStreamEvent | None:
        """The event to forward for one agent event, or ``None`` when it is folded."""

        if isinstance(event, _STEP_START_EVENTS):
            # A new step: its indexes follow everything the earlier steps output,
            # tool results included (those arrive after the step completed).
            self._offset += self._step_items
            self._step_items = 0
            self._partial.clear()
            return None
        if isinstance(event, ResponseCompletedEvent):
            answer = event.response.final_answer_text.strip()
            if answer:
                self._answer = answer
                self._annotations = event.response.output_annotations
            return None
        if isinstance(event, ResponseIncompleteEvent):
            details = event.response.incomplete_details
            self._incomplete = details.reason if details is not None else "incomplete"
            return None
        if isinstance(event, ResponseFailedEvent):
            self._failure = _failure(event.response.error)
            return None
        if isinstance(event, ErrorEvent):
            self._failure = Unavailable(event.error.message, reason="MODEL_STREAM_ERROR")
            return None
        if isinstance(event, ResponseOutputTextDeltaEvent):
            self._partial.append(event.delta)
        output_index = getattr(event, "output_index", None)
        if isinstance(output_index, int):
            self._step_items = max(self._step_items, output_index + 1)
            event = event.model_copy(update={"output_index": self._offset + output_index})
            if isinstance(event, ResponseOutputItemDoneEvent):
                self._output.append(event.item)
        return self._stamp(event)

    def fail(self, error: ServiceError) -> None:
        self._failure = error

    def finish(self) -> None:
        """The agent stream ended on its own (not cut by the client)."""

        self._finished = self._incomplete is None and self._failure is None
        if self._finished and not self._answer:
            self._failure = Internal("The assistant returned no answer.", reason="EMPTY_ANSWER")

    def terminal(self) -> AgentStreamEvent:
        if self._failure is not None:
            error = ResponseError(
                code=self._failure.reason or "INTERNAL", message=self._failure.message
            )
            return self._stamp(
                TurnFailedEvent(
                    response=self._response("failed", error=error),
                    error=rpc_status(self._failure),
                )
            )
        if self.state == "completed":
            return self._stamp(ResponseCompletedEvent(response=self._response("completed")))
        details = IncompleteDetails(reason=self._incomplete or "interrupted")
        return self._stamp(
            ResponseIncompleteEvent(
                response=self._response("incomplete", incomplete_details=details)
            )
        )

    def _response(
        self,
        status: ResponseStatus,
        *,
        error: ResponseError | None = None,
        incomplete_details: IncompleteDetails | None = None,
    ) -> Response:
        return Response(
            id=self._response_id,
            status=status,
            output=tuple(self._output),
            error=error,
            incomplete_details=incomplete_details,
            metadata=self._metadata,
        )

    def _stamp(self, event: AgentStreamEvent) -> AgentStreamEvent:
        self._sequence += 1
        return event.model_copy(update={"sequence_number": self._sequence})


def _failure(error: ResponseError | None) -> ServiceError:
    if error is None:
        return Internal("The assistant failed.", reason="AGENT_EXECUTION_FAILED")
    reason = error.code.upper()
    if error.code == "invalid_request":
        return InvalidArgument(error.message, reason="INVALID_REQUEST")
    return Internal(error.message, reason=reason)


def _user_turn(text: str, attachments: Sequence[ResourceRef]) -> UserTurn:
    return UserTurn(
        inputs=(
            TextInput(text=text),
            *(
                ImageInput(resource=resource)
                if resource.is_image
                else AttachmentInput(attachment=AttachmentRef(resource=resource))
                for resource in attachments
            ),
        )
    )


def _artifact_ids(sandbox: SandboxRuntime | None) -> tuple[UUID, ...]:
    if sandbox is None:
        return ()
    result: list[UUID] = []
    for artifact in sandbox.artifacts:
        try:
            artifact_id = UUID(artifact.id)
        except ValueError:
            continue
        if artifact_id not in result:
            result.append(artifact_id)
    return tuple(result)


async def _gather(*operations: Awaitable[Any]) -> list[Any]:
    """Await operations concurrently; on the first failure cancel the rest.

    Unlike ``TaskGroup`` this re-raises the original exception, so service
    errors keep their HTTP mapping.
    """

    tasks = [asyncio.ensure_future(operation) for operation in operations]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


__all__ = ["ChatService", "TurnFailedEvent", "TurnRequest"]
