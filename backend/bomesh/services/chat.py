"""Run one grounded chat turn under the caller's Collection permissions."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from typing import Any
from uuid import UUID, uuid4

from bomesh.agent import (
    Agent,
    AttachmentInput,
    AttachmentRef,
    ImageInput,
    ResourceResolver,
    SandboxRuntime,
    TextInput,
    UserTurn,
)
from bomesh.agent.models import AgentContext
from bomesh.agent.protocol import (
    Response,
    ResponseCompletedEvent,
    ResponseSnapshotEventBase,
)
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.services import (
    KNOWLEDGE_READ_PERMISSION,
    AuthContext,
    require_tenant_permission,
    require_user_identity,
)
from bomesh.services.identity_access.authorization import AuthorizationService
from bomesh.services.conversation import ConversationService

_RESOURCE_TOOL_NAMES = frozenset(
    {
        "inspect_resource",
        "read_resource",
        "materialize_resource",
        "materialize_sandbox_resource",
    }
)


class ChatService:
    """Authorize a chat turn, stream the agent, and persist the exchange."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        agent: Agent,
        conversations: ConversationService,
        resource_resolver: Callable[[AuthContext], ResourceResolver] | None = None,
        sandbox_runtime: Callable[[AuthContext, UUID, str], SandboxRuntime | None]
        | None = None,
    ) -> None:
        self._sessions = session_factory
        self._agent = agent
        self._conversations = conversations
        self._resource_resolver = resource_resolver
        self._sandbox_runtime = sandbox_runtime

    async def stream_turn(
        self,
        access: AuthContext,
        *,
        message: str,
        conversation_id: UUID | None,
        collection_item_ids: Sequence[UUID],
        attachment_ids: Sequence[UUID] = (),
        replace_from_turn: int | None = None,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[str]:
        """Yield serialized agent events for one authorized chat turn.

        The server owns conversation history: earlier answered turns come from
        storage, never from the client. ``replace_from_turn`` names the active
        user turn a retry or edit replaces; history stops before it, and
        ``start_turn`` supersedes it and everything after it.
        """

        require_tenant_permission(access, KNOWLEDGE_READ_PERMISSION)
        if access.tenant_id is None:
            raise PermissionError("an active tenant membership is required for chat")
        resolved_conversation_id = conversation_id or uuid4()
        attachments = tuple(dict.fromkeys(attachment_ids))
        # Independent reads, each in its own transaction: run them together.
        selected_ids, referenced_resources, attachment_resources, history = await _gather(
            self._resolve_knowledge_scope(access, collection_item_ids),
            self._conversations.referenced_resources(
                resolved_conversation_id, access=access, before_turn=replace_from_turn
            )
            if conversation_id is not None
            else _nothing(),
            self._conversations.resources(attachments, access=access),
            self._conversations.history(
                resolved_conversation_id,
                access=access,
                limit_messages=self._agent.configuration.max_history_messages,
                before_turn=replace_from_turn,
            )
            if conversation_id is not None
            else _nothing(),
        )
        context = AgentContext(
            user_id=str(require_user_identity(access)),
            tenant_id=str(access.tenant_id),
            roles=list(access.role_codes),
            collection_item_ids=tuple(str(value) for value in selected_ids),
            conversation_id=str(resolved_conversation_id),
            request_id=uuid4().hex,
            history=history,
            allowed_tool_names=self._available_tool_names(
                resources_available=bool(attachment_resources or referenced_resources)
            ),
            resources=referenced_resources,
        )
        user_turn = UserTurn(
            inputs=(
                TextInput(text=message),
                *(
                    ImageInput(resource=resource)
                    if resource.is_image
                    else AttachmentInput(attachment=AttachmentRef(resource=resource))
                    for resource in attachment_resources
                ),
            )
        )
        question = await self._conversations.start_turn(
            resolved_conversation_id,
            access=access,
            content=message,
            attachment_ids=attachments,
            request_id=context.request_id or "",
            replace_from_turn=replace_from_turn,
        )
        return self._event_stream(
            user_turn,
            context,
            access=access,
            conversation_id=resolved_conversation_id,
            question_id=question.id,
            resource_resolver=(
                self._resource_resolver(access)
                if self._resource_resolver is not None
                and (attachment_resources or referenced_resources)
                else None
            ),
            sandbox_runtime=(
                self._sandbox_runtime(access, resolved_conversation_id, context.request_id or "")
                if self._sandbox_runtime is not None
                else None
            ),
            is_disconnected=is_disconnected,
        )

    async def _event_stream(
        self,
        user_turn: UserTurn,
        context: AgentContext,
        *,
        access: AuthContext,
        conversation_id: UUID,
        question_id: UUID,
        resource_resolver: ResourceResolver | None,
        sandbox_runtime: SandboxRuntime | None,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[str]:
        stream = self._agent.run(
            user_turn,
            context,
            resource_resolver=resource_resolver,
            sandbox_runtime=sandbox_runtime,
        )
        final_answer: str | None = None
        referenced_document_ids: tuple[UUID, ...] = ()
        try:
            async for event in stream:
                if await is_disconnected():
                    break
                if isinstance(event, ResponseCompletedEvent):
                    answer = event.response.final_answer_text.strip()
                    if answer:
                        final_answer = answer
                        referenced_document_ids = referenced_item_ids(event.response)
                yield _public_event(event, conversation_id).model_dump_json()
        finally:
            await stream.aclose()
        if final_answer:
            await self._conversations.finish_turn(
                conversation_id,
                access=access,
                question_id=question_id,
                content=final_answer,
                referenced_document_ids=referenced_document_ids,
                request_id=context.request_id or "",
                artifact_ids=_artifact_ids(sandbox_runtime),
            )

    async def _resolve_knowledge_scope(
        self,
        access: AuthContext,
        collection_item_ids: Sequence[UUID],
    ) -> tuple[UUID, ...]:
        """Bind the turn to Collections the caller may actually read."""

        async with transaction_scope(self._sessions) as session:
            allowed_ids = await AuthorizationService(session).allowed_collection_ids(
                access
            )
        if not collection_item_ids:
            return allowed_ids
        if not set(collection_item_ids).issubset(set(allowed_ids)):
            raise PermissionError("one or more selected Collections are unavailable")
        return tuple(dict.fromkeys(collection_item_ids))

    def _available_tool_names(self, *, resources_available: bool = True) -> tuple[str, ...]:
        """Expose the runtime's registered chat tools for this turn."""

        return tuple(
            name
            for name, _ in self._agent.tools.executors()
            if resources_available or name not in _RESOURCE_TOOL_NAMES
        )


def referenced_item_ids(response: Response) -> tuple[UUID, ...]:
    """Extract durable Item identities from the answer's citations only."""

    result: list[UUID] = []
    seen: set[UUID] = set()
    for annotation in response.output_annotations:
        citation = annotation.get("citation")
        if not isinstance(citation, Mapping):
            continue
        try:
            item_id = UUID(str(citation.get("item_id")))
        except (TypeError, ValueError, AttributeError):
            continue
        if item_id not in seen:
            result.append(item_id)
            seen.add(item_id)
    return tuple(result)


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


def _public_event(event, conversation_id: UUID):  # type: ignore[no-untyped-def]
    """Report the conversation on every event that carries the response.

    The first such event is ``response.created``, so a client that omitted
    ``conversation_id`` learns the one the server generated before any output.
    """

    if isinstance(event, ResponseSnapshotEventBase):
        return event.model_copy(
            update={
                "response": event.response.model_copy(
                    update={
                        "metadata": {
                            **event.response.metadata,
                            "conversation_id": str(conversation_id),
                        }
                    }
                )
            }
        )
    return event


async def _nothing() -> tuple[Any, ...]:
    return ()


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


__all__ = [
    "ChatService",
    "referenced_item_ids",
]
