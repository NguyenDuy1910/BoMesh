"""Request messages (``…/requests/{request}/messages/{message}``): append-only conversation.

The requester reads and posts non-internal messages on their own request.
Deciders need ``requestMessages.*`` on the decision resource; internal notes
are visible to, and posted by, holders of ``requests.get`` there only — to
the requester they are absent. A requester message on a NEEDS_INFO request
returns it to OPEN; terminal requests take no messages.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import select

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Request, RequestMessage
from bomesh.errors import FailedPrecondition, InvalidArgument
from bomesh.iam.authorizer import PlatformRef, permission_denied
from bomesh.services.collaboration.records import RequestMessageRecord, request_name
from bomesh.services.collaboration.requests import (
    TERMINAL,
    Access,
    RequestGate,
    load_request,
    notify_deciders,
    notify_requester,
)
from bomesh.services.collaboration.support import missing, now, replay
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime


class RequestMessageService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._requests = RequestGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> RequestMessageService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        text: str,
        internal: bool,
        request_id_key: UUID | None,
    ) -> RequestMessageRecord:
        request, access = await self._open(
            ctx, workspace_id, request_id, "requestMessages.create", write=True
        )
        if internal and not access.decider:
            raise permission_denied(
                "requests.get", PlatformRef(request_name(workspace_id, request_id))
            )
        if not text or not text.strip():
            raise InvalidArgument.for_field("text", "text is required.")
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key, replayed = await replay(
                idempotency,
                ctx,
                request_id_key,
                method="CreateRequestMessage",
                parent=request_name(workspace_id, request_id),
                request={"text": text, "internal": internal},
            )
            if replayed is not None:
                message = await session.get(
                    RequestMessage, UUID(replayed.rsplit("/", 1)[-1])
                )
                if message is None:
                    raise missing(replayed)
                return RequestMessageRecord(workspace_id, message)
            row = await load_request(session, workspace_id, request_id, for_update=True)
            if row is None:
                raise missing(request_name(workspace_id, request_id))
            if row.state in TERMINAL:
                raise FailedPrecondition(
                    f"The request is {row.state.upper()}; it takes no messages."
                )
            message = RequestMessage(
                request_id=row.id,
                author_user_id=ctx.user_id,
                text=text,
                internal=internal,
            )
            session.add(message)
            if access.requester and row.state == "needs_info":
                row.state = "open"
            row.updated_at = now()
            await session.flush()
            record = RequestMessageRecord(workspace_id, message)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="requests",
                action="CreateRequestMessage",
                target=record.name,
            )
            await self._notify(
                session, ctx, workspace_id, row, access, internal=internal
            )
            if key is not None:
                await idempotency.remember(key, record.name)
            return record

    async def get(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        message_id: UUID,
    ) -> RequestMessageRecord:
        _, access = await self._open(
            ctx, workspace_id, request_id, "requestMessages.get", write=False
        )
        name = f"{request_name(workspace_id, request_id)}/messages/{message_id}"
        async with transaction_scope(self._sessions) as session:
            message = await session.scalar(
                select(RequestMessage).where(
                    RequestMessage.id == message_id,
                    RequestMessage.request_id == request_id,
                )
            )
        if message is None or (message.internal and not access.decider):
            raise missing(name)
        return RequestMessageRecord(workspace_id, message)

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        query: ListQuery,
    ) -> list[RequestMessageRecord]:
        _, access = await self._open(
            ctx, workspace_id, request_id, "requestMessages.list", write=False
        )
        statement = select(RequestMessage).where(
            RequestMessage.request_id == request_id
        )
        if not access.decider:
            statement = statement.where(RequestMessage.internal.is_(False))
        async with transaction_scope(self._sessions) as session:
            rows = await session.scalars(query.apply(statement))
            return [RequestMessageRecord(workspace_id, row) for row in rows]

    async def _open(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        permission: str,
        *,
        write: bool,
    ) -> tuple[Request, Access]:
        request, access = await self._requests.open(
            ctx, workspace_id, request_id, permission, write=write
        )
        if not access.requester and permission not in access.held:
            raise permission_denied(
                permission, PlatformRef(request_name(workspace_id, request_id))
            )
        return request, access

    async def _notify(
        self,
        session,  # noqa: ANN001 - AsyncSession
        ctx: RequestContext,
        workspace_id: UUID,
        request: Request,
        access: Access,
        *,
        internal: bool,
    ) -> None:
        title, body = (
            "New message on a request",
            request.title or "A request has a new message.",
        )
        if access.requester or internal:
            await notify_deciders(
                session, ctx, workspace_id, request, title=title, body=body
            )
        else:
            await notify_requester(
                session, ctx, workspace_id, request, title=title, body=body
            )


__all__ = ["RequestMessageService"]
